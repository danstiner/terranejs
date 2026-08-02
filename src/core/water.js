// Water handling for headless bakes. Pure, DOM-free. Colour is per-print-Z (one M600 change
// recolours the whole cross-section below a height), so water only reads blue at or below the
// water/land colour line; geometric separation is what lets same-height water and land differ.
// Two orthogonal controls: `flatten` pulls every masked cell down to one plane held two print
// layers below all land (a tile-anchored waterline); unchecked, the line sits AT 0 m — classic
// sea-level tint, geometry untouched. `recessMm` sinks all water further and never moves the
// line. The line is the TRUE waterline at any map scale; only the exported M600 pause is lifted
// one layer above it (colors.colorChanges pauseLiftMm) so the water's top layer prints blue.
// See docs/specs/data-pipeline.md §4a and
// docs/superpowers/specs/2026-08-01-water-plane-simplification-design.md.

/** Warning threshold: % of land printing blue before the UI nudges toward the flatten checkbox.
 * Strict (5) because the remedy is one click and blue land here means land genuinely at/below
 * the waterline (polders, deltas) — the line sits at the true waterline, so ordinary coasts
 * carry no inherent blue fringe. */
export const LAND_BLUE_WARN_PCT = 5;

/**
 * Anchor the water colour line and optionally flatten/sink the water for one bake, in place.
 * No mask (or no water cells) → no mutation, lineElev −Infinity — NOT 0, which would blue
 * genuinely below-sea-level land (Death Valley) on a tile with no water at all.
 * @param {Float32Array} grid  elevation grid cropped to the bake window; MUTATED in place
 * @param {Uint8Array | undefined} mask  1 = water, 0 = land, index-aligned with grid
 * @param {{ flatten: boolean, recessMm: number, layerMm: number, K: number }} opts
 *   flatten = pull all water to one plane below the land; recessMm = extra sink (mm, print
 *   space); layerMm = slicer layer height (the colour-lift unit); K = mmPerM·exag.
 * @returns {{ lineElev: number, landBluePct: number }}
 */
export function applyWaterRecess(grid, mask, { flatten, recessMm, layerMm, K }) {
  if (!mask) return { lineElev: -Infinity, landBluePct: 0 };
  let waterMin = Infinity, landMin = Infinity, landCount = 0;
  for (let i = 0; i < grid.length; i++) {
    if (mask[i]) { if (grid[i] < waterMin) waterMin = grid[i]; }
    else { if (grid[i] < landMin) landMin = grid[i]; landCount++; }
  }
  if (waterMin === Infinity) return { lineElev: -Infinity, landBluePct: 0 };
  const lift = layerMm / K; // one print layer, in metres
  // Anchor: flatten targets a plane 2 lifts below the lowest land — the exported pause sits one
  // layer above the line, so the first lift is consumed by that offset and the second is the
  // land's real clearance (see the flatten-margin pin in colors.test). Unchecked anchors at 0 m:
  // classic sea-level tint, land-blind by design (landBluePct warns instead).
  const anchor = flatten
    ? (landCount > 0 ? Math.min(waterMin, landMin - 2 * lift) : waterMin)
    : 0;
  const lineElev = anchor; // the true waterline; only the export pause is lifted a layer above it
  const sink = recessMm / K;
  let landBlue = 0;
  for (let i = 0; i < grid.length; i++) {
    if (mask[i]) grid[i] = (flatten ? anchor : grid[i]) - sink;
    else if (grid[i] <= lineElev) landBlue++; // export predicate: bandOf keeps the boundary blue
  }
  return { lineElev, landBluePct: landCount > 0 ? (100 * landBlue) / landCount : 0 };
}
