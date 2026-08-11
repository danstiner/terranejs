// Water handling for headless bakes. Pure, DOM-free. Colour is per-print-Z (one M600 change
// recolours the whole cross-section below a height), so water only reads blue at or below the
// water/land colour line; geometric separation is what lets same-height water and land differ.
// Two orthogonal controls: `flatten` pulls every masked cell down to one plane held two print
// layers below all land (a tile-anchored waterline); unchecked, the line sits AT 0 m — classic
// sea-level tint, geometry untouched. `recessMm` sinks all water further and never moves the
// line. The line is the TRUE waterline at any map scale; only the exported M600 pause is lifted
// one layer above it (colors.colorChanges pauseLiftMm) so the water's top layer prints blue.
// See docs/specs/data-pipeline.md §4 (Water) and
// docs/superpowers/specs/2026-08-01-water-plane-simplification-design.md.

import { cellsFromVertexMask } from "./mesh.js";

/** Warning threshold: % of land printing blue before the UI nudges toward the flatten checkbox.
 * Strict (5) because the remedy is one click and blue land here means land genuinely at/below
 * the waterline (polders, deltas) — the line sits at the true waterline, so ordinary coasts
 * carry no inherent blue fringe. */
export const LAND_BLUE_WARN_PCT = 5;

/** Warning threshold: % of the TILE that is masked water showing above the color line before the
 * UI nudges toward the same checkbox. Share of tile, not of water, and low because of it: the
 * bug that motivated this (noisy near-0 bathymetry speckling a bay) is only 3.1% of that tile's
 * water but 1.5% of the tile, while a Rainier-style tile whose 0.3% water is alpine tarns is
 * 100% of its water — share-of-water would shout at the default view and stay silent on the
 * defect. See docs/superpowers/specs/2026-08-04-water-as-land-warning-design.md. */
export const WATER_AS_LAND_WARN_PCT = 1;

/** Narrowest water body worth keeping, in PRINT mm. Two 0.4 mm extrusions: #cordW's floor is
 * already one, and an insert is a free-standing part pressed into a groove rather than a bead
 * fused to the tile. Print mm and not ground metres because "too small to print" is a property of
 * the part — which is why a wide tile keeps no rivers: 0.8 mm is 120 m of ground at 1:150000. */
export const MIN_WATER_BODY_WIDTH_MM = 0.8;

/** Warning threshold: % of the tile's WATER left at terrain level before the UI says so. Share of
 * water, not of tile (unlike WATER_AS_LAND_WARN_PCT), because the case that matters is a tile
 * whose water is ALL tarns — 100% dropped and ~0% of the tile. Looser than the other two: their
 * remedy is one click, this one's is a scale change, so a false alarm costs more. */
export const WATER_DROPPED_WARN_PCT = 20;

/**
 * Anchor the water colour line and optionally flatten/sink the water for one bake, in place.
 * No mask (or no water cells) → no mutation, lineElev −Infinity — NOT 0, which would blue
 * genuinely below-sea-level land (Death Valley) on a tile with no water at all.
 * @param {Float32Array} grid  elevation grid cropped to the bake window; MUTATED in place
 * @param {Uint8Array | undefined} mask  1 = water, 0 = land, index-aligned with grid
 * @param {{ flatten: boolean, recessMm: number, layerMm: number, K: number, footprint?: Uint8Array }} opts
 *   flatten = pull all water to one plane below the land; recessMm = extra sink (mm, print
 *   space); layerMm = slicer layer height (the colour-lift unit); K = mmPerM·exag;
 *   footprint = optional vertex mask; samples outside it are not MEASURED (hex/circle discard
 *   their window's corners, and water there must not anchor the line) but masked water outside
 *   it is still moved with the rest — the rim interpolates across that edge, see the loop.
 * @returns {{ lineElev: number, landBluePct: number, waterAsLandPct: number }}
 */
export function applyWaterRecess(grid, mask, { flatten, recessMm, layerMm, K, footprint }) {
  if (!mask) return { lineElev: -Infinity, landBluePct: 0, waterAsLandPct: 0 };
  let waterMin = Infinity, landMin = Infinity, landCount = 0;
  for (let i = 0; i < grid.length; i++) {
    if (footprint && !footprint[i]) continue; // discarded corner: not in the print
    if (mask[i]) { if (grid[i] < waterMin) waterMin = grid[i]; }
    else { if (grid[i] < landMin) landMin = grid[i]; landCount++; }
  }
  if (waterMin === Infinity) return { lineElev: -Infinity, landBluePct: 0, waterAsLandPct: 0 };
  const lift = layerMm / K; // one print layer, in metres
  // Anchor: flatten targets a plane 2 lifts below the lowest land — the exported pause sits one
  // layer above the line, so the first lift is consumed by that offset and the second is the
  // land's real clearance (see the flatten-margin pin in colors.test). Unchecked anchors at 0 m:
  // classic sea-level tint, land-blind by design (landBluePct warns instead).
  // fround, and not as a nicety: the line has to be a value the GRID can hold. `grid` is a
  // Float32Array and every consumer compares its samples against this line — baseBand and
  // colorChanges against emin, landBluePct and the preview shader against each sample. A raw
  // float64 anchor is generally not float32-representable, and when the store rounds it UP,
  // emin lands ABOVE the tile's own waterline: baseBand then folds the water band into the base
  // (it folds a threshold strictly below emin), colorChanges puts the water→land change at
  // z < base and drops it, and the tile prints with no water at all. Measured on a 150 km
  // Puget Sound tile: line −227.41165625, stored −227.41165161, a 4.6e-6 m gap and every drop
  // of water gone. Snapping here makes emin === lineElev exactly, which is the equality both
  // functions are already written around (see their comments on the ocean-floor tile).
  const anchor = Math.fround(flatten
    ? (landCount > 0 ? Math.min(waterMin, landMin - 2 * lift) : waterMin)
    : 0);
  const lineElev = anchor; // the true waterline; only the export pause is lifted a layer above it
  const sink = recessMm / K;
  let landBlue = 0, waterAsLand = 0, cells = 0;
  for (let i = 0; i < grid.length; i++) {
    const inPrint = !footprint || footprint[i] !== 0;
    if (mask[i]) {
      // MOVE every masked cell, in the footprint or not — the footprint gates what is MEASURED
      // (the loop above), not what is moved. A clipped rim vertex is a bilinear sample of this
      // grid straddling the footprint edge (clip.clipElevs), so skipping the outside half leaves
      // a cliff exactly where the rim interpolates and the rim climbs it, back toward raw water.
      // Only crossings read these cells (clipRange and buildSolid take the inside mask plus
      // crossings), so nothing else moves.
      // Compare the STORED sample, now that lineElev is itself float32: fround is monotonic and
      // recessMm clamps to [0,5], so fround(anchor − sink) ≤ fround(anchor) = lineElev holds
      // exactly and a flattened tile can't fire the warning against its own plane. (Comparing
      // the float64 value instead was the fix while the line was float64; with a snapped line it
      // is the bug, in mirror image — the raw anchor sits above a line the store rounded down.)
      grid[i] = (flatten ? anchor : grid[i]) - sink;
      if (inPrint && grid[i] > lineElev) waterAsLand++;
    } else if (inPrint && grid[i] <= lineElev) landBlue++; // export predicate: bandOf keeps the boundary blue
    if (inPrint) cells++;
  }
  return {
    lineElev,
    landBluePct: landCount > 0 ? (100 * landBlue) / landCount : 0,
    // Share of the TILE, unlike landBluePct's share of the land — see WATER_AS_LAND_WARN_PCT.
    waterAsLandPct: cells > 0 ? (100 * waterAsLand) / cells : 0,
  };
}

/**
 * Drop water no printable part could fill, BEFORE anything moves it. A body survives if it holds
 * a square MIN_WATER_BODY_WIDTH_MM across that is entirely water; the whole body then survives,
 * shoreline included.
 *
 * Everything runs on CELLS — cellsFromVertexMask's all-four-corners rule, the same cells the inlay
 * meshes — and only the last step returns to vertices. Reconstructing over the VERTEX mask looks
 * equivalent and is not: vertex-8-connectivity is coarser than cell-8-connectivity, so the fill
 * leaks along every sub-cell tail attached to a surviving body, which is the recessed-with-no-inlay
 * case this exists to remove. Measured: a 1-vertex tail on a printable lake, 11/11 vertices kept
 * under a vertex fill, 0/11 under this one.
 *
 * One bit per cell, so "the whole (2k+1)² neighbourhood is water" is a window SUM against 2k+1 —
 * two sliding passes carrying O(1) state, not a min-filter, which would cost O(N·k). Out-of-range
 * reads as land, so a body must fit its square inside the grid.
 *
 * Surviving bodies keep their shoreline ramp but are NOT bit-identical to the unfiltered mask:
 * vertices belonging to no all-water cell — the 1-vertex spurs of a jagged raster shoreline — go
 * too. They are exactly the vertices no part could cover.
 * @param {Uint8Array | undefined} mask 1 = water, gw·gh vertices; never mutated
 * @param {number} gw
 * @param {number} gh
 * @param {number} dx print mm per grid cell
 * @returns {{ mask: Uint8Array | undefined, droppedPct: number }} a NEW mask, always
 */
export function filterUnprintableWater(mask, gw, gh, dx) {
  if (!mask) return { mask: undefined, droppedPct: 0 };
  let water = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) water++;
  const out = new Uint8Array(gw * gh);
  if (!water) return { mask: out, droppedPct: 0 };

  const cw = gw - 1, ch = gh - 1;
  const { cells } = cellsFromVertexMask(mask, gw, gh);
  const k = Math.round(MIN_WATER_BODY_WIDTH_MM / 2 / dx);
  const win = 2 * k + 1;

  // Seeds go straight onto the fill stack; a separate seed array would cost another cw·ch bytes
  // for a value read once. k = 0 needs no special case — a 1-wide window is the identity.
  const kept = new Uint8Array(cw * ch);
  // Every cell is marked kept before it is pushed, so it enters once and cw·ch bounds the
  // frontier exactly. A boxed number[] would peak at one entry per seed — the column pass emits
  // them all before the first pop — which is +282 MB on an ocean-heavy export grid.
  const stack = new Int32Array(cw * ch);
  let sp = 0;
  const row = new Uint8Array(cw * ch);
  for (let r = 0; r < ch; r++) {
    const o = r * cw;
    let sum = 0;
    for (let c = 0; c < cw; c++) {
      sum += cells[o + c];
      if (c >= win) sum -= cells[o + c - win];
      if (c >= win - 1 && sum === win) row[o + c - k] = 1;
    }
  }
  for (let c = 0; c < cw; c++) {
    let sum = 0;
    for (let r = 0; r < ch; r++) {
      sum += row[r * cw + c];
      if (r >= win) sum -= row[(r - win) * cw + c];
      if (r >= win - 1 && sum === win) { const i = (r - k) * cw + c; kept[i] = 1; stack[sp++] = i; }
    }
  }

  // Explicit stack: a recursive fill would blow the JS stack on a grid-scale body.
  while (sp) {
    const i = stack[--sp];
    const r = (i / cw) | 0, c = i - r * cw;
    for (let nr = Math.max(0, r - 1); nr <= Math.min(ch - 1, r + 1); nr++) {
      for (let nc = Math.max(0, c - 1); nc <= Math.min(cw - 1, c + 1); nc++) {
        const j = nr * cw + nc;
        if (cells[j] && !kept[j]) { kept[j] = 1; stack[sp++] = j; }
      }
    }
  }

  for (let r = 0; r < ch; r++) {
    for (let c = 0; c < cw; c++) {
      if (!kept[r * cw + c]) continue;
      const A = r * gw + c;
      out[A] = 1; out[A + 1] = 1; out[A + gw] = 1; out[A + gw + 1] = 1;
    }
  }
  let survived = 0;
  for (let i = 0; i < out.length; i++) if (out[i]) survived++;
  return { mask: out, droppedPct: (100 * (water - survived)) / water };
}
