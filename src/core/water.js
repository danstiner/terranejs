// Water handling for headless bakes. Pure, DOM-free. Color is per-print-Z (one M600 change
// recolors the whole cross-section below a height), so water only reads blue at or below the
// water/land color line; geometric separation is what lets same-height water and land differ.
// ONE control decides what happens to the water. "flat" pulls every masked cell down to one plane
// held two print layers below all land (a tile-anchored waterline); "none" leaves the line at 0 m,
// rising to a perched lake's surface only when all land clears it by that same two-layer margin —
// geometry untouched; the sinking modes groove the water by `recessMm`
// without moving the line. They are exclusive by construction: a plane is never sunk further, which
// is what stops the depth meaning two different things. The line is the TRUE waterline at any map
// scale; only the exported M600 pause is lifted one layer above it (colors.colorChanges
// pauseLiftMm) so the water's top layer prints blue.
// See docs/specs/data-pipeline.md §4 (Water) and
// docs/superpowers/specs/2026-08-01-water-plane-simplification-design.md.

import { cellsFromVertexMask } from "./mesh.js";

/** @typedef {import("./types.js").WaterMode} WaterMode */

/** Warning threshold: % of the TILE that is masked water showing above the height the print
 * changes color at before the UI names the Lake inserts card. Share of tile, not of water, and
 * low because of it: the
 * bug that motivated this (noisy near-0 bathymetry speckling a bay) is only 3.1% of that tile's
 * water but 1.5% of the tile, while a Rainier-style tile whose 0.3% water is alpine tarns is
 * 100% of its water — share-of-water would shout at the default view and stay silent on the
 * defect. See docs/superpowers/specs/2026-08-04-water-as-land-warning-design.md. */
export const WATER_AS_LAND_WARN_PCT = 1;

/** Narrowest water body worth keeping, in PRINT mm. Two 0.4 mm extrusions: #cordW's floor is
 * already one, and an insert is a free-standing part pressed into a groove rather than a bead
 * fused to the tile. Print mm and not ground meters because "too small to print" is a property of
 * the part — which is why a wide tile keeps no rivers: 0.8 mm is 120 m of ground at 1:150000. */
export const MIN_WATER_BODY_WIDTH_MM = 0.8;

/** Warning threshold: % of the tile's WATER left at terrain level before the UI says so. Share of
 * water, not of tile (unlike WATER_AS_LAND_WARN_PCT), because the case that matters is a tile
 * whose water is ALL tarns — 100% dropped and ~0% of the tile. Looser than the other two: their
 * remedy is one click, this one's is a scale change, so a false alarm costs more. */
export const WATER_DROPPED_WARN_PCT = 20;

/**
 * The water/land color line for one bake — pure, no mutation. Split out of applyWaterRecess
 * because the pipeline needs the line BEFORE the recess runs (splitWaterByLine classifies
 * against it, and the recess needs the mask the split produces — a cycle otherwise), and
 * applyWaterRecess calls this same function, so the two can never disagree.
 *
 * Anchor rules, by mode: flatten targets a plane 2 lifts below the lowest land — the exported
 * pause sits one layer above the line, so the first lift is consumed by that offset and the
 * second is the land's real clearance (see the flatten-margin pin in colors.test).
 * "none" rises to the lowest in-footprint water — but ONLY when all land clears it by that same
 * 2-lift margin, and never from below 0 m. The DEM hydro-flattens LAKES (each a constant), so on
 * a tile whose water is all perched above all land (Tahoe) waterMin IS the lake's surface and
 * the line rises to it rather than printing the lake as land. Natural cannot move the water the
 * way flatten could, so where flatten pulled the plane DOWN, Natural refuses the rise: a line
 * land does not clear floods it blue (Crater Lake's line at its own lake drowned the outer
 * valleys — tried, reverted), and a line below 0 greens the sea, because ocean samples are only
 * clamped NEAR 0 and real masks carry below-0 bathymetry noise (a Puget Sound sample reads
 * −227 m).
 * The line never sits above land, in ANY mode: land at or below the candidate line (polders,
 * deltas) lowers it to landMin − 2·lift instead — rather sea-as-land than land-as-sea. The sea
 * above the lowered line prints as land and the waterAsLand warning names an inserts card, which
 * genuinely fixes it: the lowered line also lowers the lakes-mode ceiling, so the sea itself
 * becomes a groove and a part. landBluePct is ≈0 because of this — only land sitting exactly AT
 * the line still counts (boundary-blue, matching bandOf) — so it survives as a returned
 * invariant (a real percentage means the anchor broke), not as a warning.
 * "all" carries no line at all (−Infinity, the waterless sentinel): every printable body becomes
 * a part, so the pause that would paint sub-line layers blue is never worth its filament swap —
 * grooves, walls and polders print as land, and every drop of blue on the tile is an insert.
 * colorChanges folds the water band into the base and the legend row disappears with it.
 *
 * No mask (or no water cells) → lineElev −Infinity — NOT 0, which would blue genuinely
 * below-sea-level land (Death Valley) on a tile with no water at all.
 *
 * fround, and not as a nicety: the line has to be a value the GRID can hold. `grid` is a
 * Float32Array and every consumer compares its samples against this line — baseBand and
 * colorChanges against emin, landBluePct and the preview shader against each sample. A raw
 * float64 anchor is generally not float32-representable, and when the store rounds it UP,
 * emin lands ABOVE the tile's own waterline: baseBand then folds the water band into the base
 * (it folds a threshold strictly below emin), colorChanges puts the water→land change at
 * z < base and drops it, and the tile prints with no water at all. Measured on a 150 km
 * Puget Sound tile: line −227.41165625, stored −227.41165161, a 4.6e-6 m gap and every drop
 * of water gone. Snapping here makes emin === lineElev exactly, which is the equality both
 * functions are already written around (see their comments on the ocean-floor tile).
 *
 * @param {Float32Array} grid  elevation grid cropped to the bake window
 * @param {Uint8Array | undefined} mask  1 = water, 0 = land, index-aligned with grid
 * @param {{ waterMode: WaterMode, layerMm: number, K: number, footprint?: Uint8Array }} opts
 * @returns {{ lineElev: number, waterMin: number, landCount: number }}
 */
export function waterColorLine(grid, mask, { waterMode, layerMm, K, footprint }) {
  if (!mask) return { lineElev: -Infinity, waterMin: Infinity, landCount: 0 };
  let waterMin = Infinity, landMin = Infinity, landCount = 0;
  for (let i = 0; i < grid.length; i++) {
    if (footprint && !footprint[i]) continue; // discarded corner: not in the print
    if (mask[i]) { if (grid[i] < waterMin) waterMin = grid[i]; }
    else { if (grid[i] < landMin) landMin = grid[i]; landCount++; }
  }
  if (waterMin === Infinity) return { lineElev: -Infinity, waterMin, landCount };
  const lift = layerMm / K; // one print layer, in meters
  let anchor;
  if (waterMode === "flat") anchor = landCount > 0 ? Math.min(waterMin, landMin - 2 * lift) : waterMin;
  else {
    anchor = waterMode === "none" && waterMin > 0 && waterMin <= landMin - 2 * lift ? waterMin : 0;
    if (landMin < anchor) anchor = landMin - 2 * lift; // never above land — see the doc block
  }
  const lineElev = waterMode === "all" ? -Infinity : Math.fround(anchor);
  return { lineElev, waterMin, landCount };
}

/**
 * Anchor the water color line (waterColorLine above) and, per the mode, flatten OR sink the
 * water for one bake, in place. No mask (or no water cells) → no mutation, lineElev −Infinity.
 * @param {Float32Array} grid  elevation grid cropped to the bake window; MUTATED in place
 * @param {Uint8Array | undefined} mask  1 = water, 0 = land, index-aligned with grid
 * @param {{ waterMode: WaterMode, recessMm: number, layerMm: number, K: number, footprint?: Uint8Array, recessMask?: Uint8Array, filled?: boolean }} opts
 *   waterMode = what to do with the masked water: "none" leaves it at true elevation, "flat" pulls
 *   it all onto one plane below the land, "all"/"lakes" sink it by recessMm. The mode is the axis —
 *   flat and the sink are exclusive, so a flattened plane is never sunk further; recessMm = groove
 *   depth (mm, print space), read only by the sinking modes, and 0 is legal here even though the UI
 *   floors it at 0.5; layerMm = slicer layer height (the color-lift unit); K = mmPerM·exag;
 *   footprint = optional vertex mask; samples outside it are not MEASURED (hex/circle discard
 *   their window's corners, and water there must not anchor the line) but masked water outside
 *   it is still moved with the rest — the rim interpolates across that edge, see the loop.
 *   recessMask = which masked cells the sink applies to, index-aligned with grid; omitted, it
 *   applies to all of them. A subset is how one tile keeps an ocean at the waterline while its
 *   lakes get a groove and a part (see splitWaterByLine). filled = whether the bake will fill the
 *   moved water with drop-in parts; default false, so headless callers must declare their parts —
 *   a moved but unfilled groove is an open cut with nothing blue in it and still SHOWS as land.
 * @returns {{ lineElev: number, landBluePct: number, waterAsLandPct: number }}
 */
export function applyWaterRecess(grid, mask, { waterMode, recessMm, layerMm, K, footprint, recessMask, filled = false }) {
  // The one caller error the geometry cannot absorb: a negative depth RAISES water above the line
  // it anchors, inverting the ≤-original invariant the drape and the waterAsLand count both lean
  // on. Zero stays legal — the UI floors at 0.5, core does not — but negative (or NaN) is refused
  // loudly here rather than silently inverting parts downstream.
  if (!(recessMm >= 0)) throw new Error(`applyWaterRecess: recessMm must be ≥ 0, got ${recessMm}`);
  const { lineElev, waterMin, landCount } = waterColorLine(grid, mask, { waterMode, layerMm, K, footprint });
  if (!mask || waterMin === Infinity) return { lineElev: -Infinity, landBluePct: 0, waterAsLandPct: 0 };
  const lift = layerMm / K; // one print layer, in meters
  const flat = waterMode === "flat";
  // Exclusive, structurally: one mode either moves water onto a plane or sinks it, never both.
  // `none` is a zero sink rather than a branch, so the loop below keeps one shape.
  const sink = flat || waterMode === "none" ? 0 : recessMm / K;
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
      // sink is never negative (the entry guard refuses a negative depth; the UI and hash floor
      // it besides), so fround(line − sink) ≤ fround(line) = lineElev
      // holds exactly and a flattened tile can't fire the warning against its own plane. (Comparing
      // the float64 value instead was the fix while the line was float64; with a snapped line it
      // is the bug, in mirror image — the raw anchor sits above a line the store rounded down.)
      // Water the recess moved is excused from "showing as land" only when a part is coming to
      // fill it — the insert is what makes it blue, not the color band, and `filled` is the
      // caller's word on whether one is. Moved-but-unfilled is an open groove: still bare rock at
      // the bottom, so it still counts. The sink > 0 term matters independently of `filled`: a
      // full recessMask with a zero depth moves nothing and must still count, which is what keeps
      // the default tile's warning exactly as strict as it was.
      // What counts as "above" is the line plus one LIFT — the height the print actually changes
      // color at, since the export raises the water pause that far so the water's top layer
      // prints blue. Water inside that layer prints blue whatever its sample reads, so naming it
      // would be a false alarm; at map scale a layer is tens of meters of ground, which is most
      // of a coastal tile's near-0 bathymetry noise. Measured share of tile: 5.06% → 0.13% on
      // Puget Sound, 4.50% → 0.50% on San Francisco Bay, both from over the 1% threshold to under
      // it, while Titicaca (58%) and Crater Lake (13%) are untouched — that water really does
      // print as rock. Same ceiling splitWaterByLine classifies against, so the two agree.
      const moved = sink > 0 && (!recessMask || recessMask[i] !== 0);
      grid[i] = flat ? lineElev : grid[i] - (moved ? sink : 0); // flat: the line IS the plane
      if (inPrint && !(moved && filled) && grid[i] > lineElev + lift) waterAsLand++;
      // The TRUE line below, deliberately not the ceiling this counter uses. The two ask different
      // questions: this one is "will this water print as land", a print question, while landBlue is
      // "is there land under the waterline", which is what the flatten it nudges toward actually
      // fixes. Land inside the lifted layer prints blue too, but flattening cannot help it — the
      // lift is inherent to the print — so counting it would nudge at every coast with no remedy.
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
 * One bit per cell, so "the whole (2k+1)² neighborhood is water" is a window SUM against 2k+1 —
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

// A vertex is a corner of up to 4 cells: (r-1,c-1) (r-1,c) (r,c-1) (r,c) in cell space. splitWaterByLine
// marks a body's own member cells 3 ("this body, visited") while it runs that body's vertex
// closure, distinct from the global 1 (unvisited)/2 (some other body, visited) — so this is the
// hard constraint the closure BFS refuses to cross: a vertex touching ANY other body's cell,
// whichever state that body is in. 0 (no member cell at all) is the one case it MAY cross — that
// is a spur or a bridge, which belongs to no body's cell footprint and so belongs to whichever
// body's closure reaches it first.
/** @param {Uint8Array} cells @param {number} cw @param {number} ch @param {number} r @param {number} c */
function cornerOfOtherBody(cells, cw, ch, r, c) {
  if (r > 0 && c > 0) { const v = cells[(r - 1) * cw + (c - 1)]; if (v !== 0 && v !== 3) return true; }
  if (r > 0 && c < cw) { const v = cells[(r - 1) * cw + c]; if (v !== 0 && v !== 3) return true; }
  if (r < ch && c > 0) { const v = cells[r * cw + (c - 1)]; if (v !== 0 && v !== 3) return true; }
  if (r < ch && c < cw) { const v = cells[r * cw + c]; if (v !== 0 && v !== 3) return true; }
  return false;
}

/**
 * Split printed water into the bodies a recess has to move and the bodies already printing blue.
 * "Already blue" is a claim about the PRINT, so the caller passes the height the color actually
 * changes at, not the waterline — see the ceiling at the pipeline call site.
 *
 * Classification reads a body's INTERIOR — itself eroded one cell in from its outer ring — because
 * the elevation grid and the watermask are different products whose coastlines disagree by a pixel
 * or two at every shore, and the outer ring is exactly where they disagree: it samples the DEM's
 * shore bluff. The ceiling absorbs most of that (a print layer is tens of meters of ground at map
 * scale), but not on a steep coast, where one wall pixel clears it and grooves the whole body.
 * Measured against the ceiling at exag 1: Sognefjord's fjord tops out at 47.4 m over its full
 * extent and 10.1 m eroded, Bora Bora's lagoon at 12.6 and 10.5, against ceilings of 45 and 12 —
 * both groove whole without erosion and neither with it. Erosion is not sufficient on its own
 * either: after it, every ocean body still carries ~10-12 m of excursion (low real land inside
 * the water polygon — motu, marsh islands, dikes), which clears a bare 0 m line every time.
 *
 * A body with no interior cells (one cell thick, or run edge to edge against the tile) falls back
 * to its full extent — the conservative direction, since the fallback still grooves rather than
 * silently leaving the body alone. Either way ANY decisive vertex grooves the WHOLE body,
 * shoreline included: half a body would leave a cliff inside the water and an insert tapering to
 * nothing along the split, so the decision is per body and never per cell — erosion changes only
 * which vertices it reads, not the shape of the answer. That one vertex decides a body of a
 * million cells is the rule's real limit: at exag 4 the ceiling shrinks under the residue above
 * and coastal tiles groove whole again. The fix there would be a robust statistic over the body,
 * not more erosion.
 *
 * Runs on CELLS via cellsFromVertexMask — the same basis as filterUnprintableWater and the inlay,
 * for the reason recorded there: vertex-8-connectivity is coarser than cell-8-connectivity, so a
 * vertex fill would join a lake to the ocean through a one-vertex touch and hand the pair a single
 * classification. Water contributing no whole cell therefore never moves, which is the same answer
 * the size filter already gave it. A cell is INTERIOR iff all 8 of its neighbor cells are members
 * of the same body and in-grid; two bodies are never 8-adjacent (if they were, they'd be one body),
 * so any non-zero neighbor cell is necessarily this body's.
 *
 * Classification reads every cell of the body regardless of footprint — the opposite of the
 * measurement loop in applyWaterRecess, and for a different question. Water outside the print must
 * not anchor the plane, but a body LEFT ALONE whose out-of-footprint cells sat above the ceiling
 * leaves the rim climbing a cliff, because clip.clipElevs interpolates across that edge. Erosion
 * needs no footprint argument for the same reason: the rim-cliff hazard comes from a body moving
 * PARTLY, and interior-vs-fallback still answers for the body as a whole.
 *
 * The write-out claims more than the member cells' stamped corners: with the width filter off, a
 * 1-vertex-wide shoreline spur (or a whole spur chain) belongs to no all-water CELL, so it would
 * stay out of `out[]` and — under `lakes` — stay at true elevation while the body around it sinks,
 * a spike standing at the groove lip. It also undercounts recessedPct, which is a share of mask
 * VERTICES: a coastal tile whose every body grooves can still fall short of 100. A decisive body
 * therefore claims its vertex CLOSURE — every mask vertex 8-adjacency-reachable from its stamped
 * corners — with one hard constraint: never a vertex that is a corner of another body's cell (see
 * cornerOfOtherBody). Two bodies are never 8-adjacent by CELL, but a 1-vertex-wide bridge between
 * them has no cell of its own, so it belongs to whichever body's closure reaches it first — the
 * cliff a mixed decision leaves on such a bridge is inherent to judging water by the cell rather
 * than the vertex, and this only relocates it by however many spur vertices the bridge is long.
 * @param {Uint8Array} mask 1 = printed water, gw·gh vertices; never mutated
 * @param {Float32Array} grid elevations at true elevation — call before applyWaterRecess moves them
 * @param {number} gw
 * @param {number} gh
 * @param {number} blueCeiling meters; the height the print changes color at — the water/land
 *   line plus the layer the export lifts the pause by. At or below it, a body already prints blue.
 * @returns {{ mask: Uint8Array, recessedPct: number }} a NEW mask, always
 */
export function splitWaterByLine(mask, grid, gw, gh, blueCeiling) {
  const out = new Uint8Array(gw * gh);
  let water = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) water++;
  if (!water) return { mask: out, recessedPct: 0 };

  const cw = gw - 1, ch = gh - 1;
  const { cells } = cellsFromVertexMask(mask, gw, gh);
  // The queue doubles as the body's member list: walk forward instead of popping, so after the
  // walk [0, tail) still holds every cell of the body and the restore-to-2 pass below needs no
  // second array. `cells` is ours — cellsFromVertexMask allocates a fresh one — so a third value
  // keeps membership legible after a cell is visited: 1 = member, unvisited; 2 = member, visited
  // by a body no longer being processed; 3 = member of the body CURRENTLY being processed. A cell
  // is a MEMBER iff cells[j] !== 0, whichever state it's in — that is what lets the interior test
  // below read a neighbor's membership regardless of walk order, and cornerOfOtherBody tell
  // "mine" (3) apart from "anyone else's" (1 or 2).
  const queue = new Int32Array(cw * ch);
  // The vertex closure's own frontier, sized for the worst case (every vertex claimed) and reused
  // across bodies — always fully drained (the `while (vtail)` below) before the next body seeds it.
  const vstack = new Int32Array(gw * gh);
  let vtail = 0;
  for (let seed = 0; seed < cells.length; seed++) {
    if (cells[seed] !== 1) continue;
    cells[seed] = 3;
    let tail = 0;
    queue[tail++] = seed;
    let maxAll = -Infinity, maxInterior = -Infinity, interiorCount = 0;
    for (let head = 0; head < tail; head++) {
      const i = queue[head];
      const r = (i / cw) | 0, c = i - r * cw;
      const A = r * gw + c;
      // Four reads rather than a Math.max over a literal array: this runs once per water cell on
      // grids reaching 2300² and an array per iteration is the whole cost.
      let m = grid[A];
      if (grid[A + 1] > m) m = grid[A + 1];
      if (grid[A + gw] > m) m = grid[A + gw];
      if (grid[A + gw + 1] > m) m = grid[A + gw + 1];
      if (m > maxAll) maxAll = m;
      // In-grid check first (cheap, and required before the neighbor reads below are safe), then
      // the 8 neighbor cells — an out-of-grid neighbor, or a land one, disqualifies the cell.
      if (r > 0 && r < ch - 1 && c > 0 && c < cw - 1 &&
          cells[i - cw - 1] && cells[i - cw] && cells[i - cw + 1] &&
          cells[i - 1] && cells[i + 1] &&
          cells[i + cw - 1] && cells[i + cw] && cells[i + cw + 1]) {
        interiorCount++;
        if (m > maxInterior) maxInterior = m;
      }
      for (let nr = Math.max(0, r - 1); nr <= Math.min(ch - 1, r + 1); nr++) {
        for (let nc = Math.max(0, c - 1); nc <= Math.min(cw - 1, c + 1); nc++) {
          const j = nr * cw + nc;
          if (cells[j] === 1) { cells[j] = 3; queue[tail++] = j; }
        }
      }
    }
    // The fallback matters: at coarse preview pitch the size filter admits bodies only one cell
    // thick, which have no interior at all. Falling back to maxAll is the conservative direction.
    const decisive = interiorCount ? maxInterior : maxAll;
    if (decisive > blueCeiling) { // will move: claim the full vertex closure, not just the cell corners
      // Stamp every member cell's corners as before, but seed the closure's frontier with only the
      // NEWLY claimed ones — a corner shared by up to 4 member cells must not enter the queue 4 times.
      for (let head = 0; head < tail; head++) {
        const i = queue[head];
        const r = (i / cw) | 0, c = i - r * cw;
        const A = r * gw + c;
        if (!out[A]) { out[A] = 1; vstack[vtail++] = A; }
        if (!out[A + 1]) { out[A + 1] = 1; vstack[vtail++] = A + 1; }
        if (!out[A + gw]) { out[A + gw] = 1; vstack[vtail++] = A + gw; }
        if (!out[A + gw + 1]) { out[A + gw + 1] = 1; vstack[vtail++] = A + gw + 1; }
      }
      // Walk out from the stamped corners over 8-adjacent MASK vertices (not cells — a spur is
      // exactly the water this body's cells don't cover), refusing only a vertex that is a corner
      // of some OTHER body's cell. See cornerOfOtherBody and the function doc for the bridge case.
      while (vtail) {
        const i = vstack[--vtail];
        const R = (i / gw) | 0, C = i - R * gw;
        for (let nr = Math.max(0, R - 1); nr <= Math.min(gh - 1, R + 1); nr++) {
          for (let nc = Math.max(0, C - 1); nc <= Math.min(gw - 1, C + 1); nc++) {
            const j = nr * gw + nc;
            if (mask[j] && !out[j] && !cornerOfOtherBody(cells, cw, ch, nr, nc)) {
              out[j] = 1; vstack[vtail++] = j;
            }
          }
        }
      }
    } // else already prints blue: no groove, and no part to fill one
    // Demote this body's cells from 3 (mine) to 2 (some other body's, visited) — the next body's
    // closure must see them as foreign, not as its own.
    for (let head = 0; head < tail; head++) cells[queue[head]] = 2;
  }
  let recessed = 0;
  for (let i = 0; i < out.length; i++) if (out[i]) recessed++;
  return { mask: out, recessedPct: (100 * recessed) / water };
}
