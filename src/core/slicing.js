// The slicer's layer grid, and where a filament swap has to sit in it. Read out of
// PrusaSlicer and measured against it on four grids — see docs/specs/slicing.md, which
// carries the source citations and the probe that re-checks them.
//
// Two facts drive everything here. A color change written at height P takes effect on
// the first layer whose TOP is at or above P, so the layer straddling P is already the
// new color. And a column only prints a layer whose MIDDLE its surface reaches, so the
// height where the print visibly changes color is that middle, not P.

/** PrusaSlicer's default first layer height (mm) — what a tile is exported for absent a setting. */
export const DEFAULT_FIRST_LAYER_MM = 0.2;

/** Default layer height (mm). Paired with the first layer above so a whole-mm base lands on a
 * layer TOP: the printed boundary then sits half a layer over the line, the position furthest
 * from the slice-plane jump where a hair of drift moves it a whole layer. 0.15 does not divide
 * a whole-mm base minus 0.2 and lands 0.83 of a layer up, one nudge from that jump. */
export const DEFAULT_LAYER_MM = 0.1;

const EPS = 1e-9;

/**
 * Where the water→land filament swap goes, for a color line at `zLine` print-mm.
 *
 * `pauseZ` is the export's `print_z`: the top of the first layer that may print land,
 * which is the earliest swap leaving every water column its own color. `boundaryZ` is
 * what the print then looks like — the slice plane of that layer, the model height
 * where the color actually turns over. They differ by half a layer, and both move with
 * the FIRST layer height, which offsets the whole grid off multiples of `layerMm`.
 *
 * @param {number} zLine model height of the water/land color line (print mm)
 * @param {{ layerMm: number, firstLayerMm?: number }} grid slicer settings the tile is exported for
 * @returns {{ pauseZ: number, boundaryZ: number }}
 */
export function waterPause(zLine, { layerMm, firstLayerMm = DEFAULT_FIRST_LAYER_MM }) {
  /** @param {number} k */
  const top = (k) => firstLayerMm + (k - 1) * layerMm;
  /** @param {number} k */
  const slice = (k) => top(k) - (k === 1 ? firstLayerMm : layerMm) / 2;
  // The last layer the water reaches, counting the plane itself as reached (measured:
  // a surface exactly on it still prints). The closed form inverts slice() for k ≥ 2;
  // the two walks cover the first layer, an empty w, and float dust either way.
  let w = Math.max(0, Math.floor((zLine - firstLayerMm) / layerMm + 1.5));
  while (w > 0 && slice(w) > zLine + EPS) w--;
  while (slice(w + 1) <= zLine + EPS) w++;
  return { pauseZ: top(w + 1), boundaryZ: slice(w + 1) };
}
