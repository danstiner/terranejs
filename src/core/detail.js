// How much fine structure the elevation grid actually carries, per cell. Headless, pure.
//
// The source DEM is a composite (data-sources.md): a tile can straddle the edge of a lidar
// survey and be genuinely detailed on one side, interpolated on the other. This makes that
// boundary visible in the preview.
//
// DESCRIPTIVE, not a verdict: it separates lidar from non-lidar ground clearly as a map, but
// far too weakly per cell to classify or fire a warning (scale-free variants measured worse —
// evidence in the PR). So the UI calls it "detail", never "accuracy".

/** Half-width of the averaging window, in cells. Single-cell curvature is far too noisy to
 * read; ~9 cells is wide enough to read as regions, narrow enough to keep a survey boundary
 * sharp. */
export const DETAIL_RADIUS = 4;

/**
 * Per-cell mean deviation from the local linear fit, box-averaged over a (2r+1)² window.
 * A surface interpolated between distant samples is locally straight, so its deviation is ~0;
 * ground with real structure at the sampling scale deviates. Units are metres.
 *
 * O(cells) regardless of radius — a curvature pass, then two separable running-sum blurs;
 * the naive O(cells·r²) form would noticeably block the bake at preview scale.
 *
 * @param {Float32Array} grid  elevation, row-major, gw×gh. NOT the post-recess grid: flattened
 *   water would read as zero detail and paint every lake as missing data.
 * @param {number} gw
 * @param {number} gh
 * @param {number} [radius]
 * @returns {Float32Array} metres, gw×gh, aligned with the grid
 */
export function detailMap(grid, gw, gh, radius = DETAIL_RADIUS) {
  const n = gw * gh;
  const curv = new Float32Array(n);
  // Second difference on both axes. The border ring has no opposite neighbor on one side, so
  // it keeps 0 and the blur pulls interior values over it — reflecting would invent structure
  // exactly where a clipped rim already needs care.
  for (let r = 1; r < gh - 1; r++) {
    for (let c = 1; c < gw - 1; c++) {
      const i = r * gw + c;
      const h = grid[i] - (grid[i - 1] + grid[i + 1]) / 2;
      const v = grid[i] - (grid[i - gw] + grid[i + gw]) / 2;
      curv[i] = (Math.abs(h) + Math.abs(v)) / 2;
    }
  }
  return boxBlur(curv, gw, gh, radius);
}

/**
 * Separable box blur with running sums: O(cells), independent of radius. Edge windows divide
 * by the cells actually inside the grid, so corners aren't darkened.
 * @param {Float32Array} src @param {number} gw @param {number} gh @param {number} radius
 * @returns {Float32Array}
 */
function boxBlur(src, gw, gh, radius) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let r = 0; r < gh; r++) {
    const row = r * gw;
    let sum = 0;
    for (let c = 0; c <= Math.min(radius, gw - 1); c++) sum += src[row + c];
    for (let c = 0; c < gw; c++) {
      const lo = c - radius, hi = c + radius;
      tmp[row + c] = sum / (Math.min(hi, gw - 1) - Math.max(lo, 0) + 1);
      if (hi + 1 < gw) sum += src[row + hi + 1];
      if (lo >= 0) sum -= src[row + lo];
    }
  }
  for (let c = 0; c < gw; c++) {
    let sum = 0;
    for (let r = 0; r <= Math.min(radius, gh - 1); r++) sum += tmp[r * gw + c];
    for (let r = 0; r < gh; r++) {
      const lo = r - radius, hi = r + radius;
      out[r * gw + c] = sum / (Math.min(hi, gh - 1) - Math.max(lo, 0) + 1);
      if (hi + 1 < gh) sum += tmp[(hi + 1) * gw + c];
      if (lo >= 0) sum -= tmp[lo * gw + c];
    }
  }
  return out;
}
