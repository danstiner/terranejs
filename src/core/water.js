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

/**
 * Anchor the water colour line and optionally flatten/sink the water for one bake, in place.
 * No mask (or no water cells) → no mutation, lineElev −Infinity — NOT 0, which would blue
 * genuinely below-sea-level land (Death Valley) on a tile with no water at all.
 * @param {Float32Array} grid  elevation grid cropped to the bake window; MUTATED in place
 * @param {Uint8Array | undefined} mask  1 = water, 0 = land, index-aligned with grid
 * @param {{ flatten: boolean, recessMm: number, layerMm: number, K: number, footprint?: Uint8Array }} opts
 *   flatten = pull all water to one plane below the land; recessMm = extra sink (mm, print
 *   space); layerMm = slicer layer height (the colour-lift unit); K = mmPerM·exag;
 *   footprint = optional vertex mask; samples outside it are neither measured nor moved
 *   (hex/circle discard their window's corners).
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
    if (footprint && !footprint[i]) continue;
    cells++;
    if (mask[i]) {
      // Compare the STORED sample, now that lineElev is itself float32: fround is monotonic and
      // recessMm clamps to [0,5], so fround(anchor − sink) ≤ fround(anchor) = lineElev holds
      // exactly and a flattened tile can't fire the warning against its own plane. (Comparing
      // the float64 value instead was the fix while the line was float64; with a snapped line it
      // is the bug, in mirror image — the raw anchor sits above a line the store rounded down.)
      grid[i] = (flatten ? anchor : grid[i]) - sink;
      if (grid[i] > lineElev) waterAsLand++;
    } else if (grid[i] <= lineElev) landBlue++; // export predicate: bandOf keeps the boundary blue
  }
  return {
    lineElev,
    landBluePct: landCount > 0 ? (100 * landBlue) / landCount : 0,
    // Share of the TILE, unlike landBluePct's share of the land — see WATER_AS_LAND_WARN_PCT.
    waterAsLandPct: cells > 0 ? (100 * waterAsLand) / cells : 0,
  };
}
