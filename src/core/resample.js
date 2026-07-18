// Pure resampling: elevation mosaic -> print grid (row 0 = north), bilinear.
// The mosaic is web-mercator (uniform in global pixels); the output grid is
// uniform in those SAME global pixels, matching the print lattice the tiles are
// meshed on. lon->x and mercator-y->row are both linear, so per-col x and
// per-row y indices are plain linear ramps. Pixel-center convention: mosaic[i]
// is the sample at global pixel (origin + i + 0.5).
import { lonToGlobalX, latToGlobalY } from "./tilemath.js";

/** @typedef {import("./types.js").BBox} BBox */
/** @typedef {import("./types.js").Mosaic} Mosaic */
/** @typedef {import("./types.js").Window} Window */

/**
 * Resample an elevation mosaic onto the print sample grid by bilinear interpolation.
 * @param {Mosaic} mosaic
 * @param {BBox} bbox
 * @param {number} gridW
 * @param {number} gridH
 * @returns {Float32Array}
 */
export function resampleBilinear(mosaic, [s, w, n, e], gridW, gridH) {
  const { data, width, height, originGx, originGy, z } = mosaic;
  const out = new Float32Array(gridW * gridH);

  // Horizontal sample position per column, computed once and reused by every row below.
  const sx = new Float64Array(gridW); // fractional mosaic x index per column
  for (let c = 0; c < gridW; c++) {
    const lon = gridW === 1 ? w : w + ((e - w) * c) / (gridW - 1);
    sx[c] = lonToGlobalX(lon, z) - originGx - 0.5;
  }
  // Vertical sample position per row, mirroring sx above but reused across every column instead.
  const gyN = latToGlobalY(n, z) - originGy - 0.5; // row 0 = north (smaller global y)
  const gyS = latToGlobalY(s, z) - originGy - 0.5;
  const sy = new Float64Array(gridH);
  for (let r = 0; r < gridH; r++) {
    sy[r] = gridH === 1 ? gyN : gyN + ((gyS - gyN) * r) / (gridH - 1);
  }

  /** @type {(v: number, hi: number) => number} */
  const clamp = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v);

  // Column terms depend only on c; resolve them once instead of per cell.
  const cx0 = new Int32Array(gridW), cx1 = new Int32Array(gridW);
  const cwx = new Float64Array(gridW);
  for (let c = 0; c < gridW; c++) {
    const fx = sx[c];
    const ix = Math.floor(fx);
    cx0[c] = clamp(ix, width - 1);
    cx1[c] = clamp(ix + 1, width - 1); // clamp the raw neighbour, not cx0, so edges replicate
    cwx[c] = fx - ix;
  }

  // Blend elevations bilinearly: interpolate x on each of the two source rows, then interpolate those results along y.
  for (let r = 0; r < gridH; r++) {
    const fy = sy[r];
    const iy = Math.floor(fy);
    const y0 = clamp(iy, height - 1);
    const y1 = clamp(iy + 1, height - 1); // clamp the raw neighbour, not y0, so edges replicate
    const wy = fy - iy;
    const row0 = y0 * width, row1 = y1 * width;
    for (let c = 0; c < gridW; c++) {
      const x0 = cx0[c], x1 = cx1[c], wx = cwx[c];
      const a = data[row0 + x0], b = data[row0 + x1];
      const cc = data[row1 + x0], d = data[row1 + x1];
      const top = a + (b - a) * wx;
      const bot = cc + (d - cc) * wx;
      out[r * gridW + c] = top + (bot - top) * wy;
    }
  }
  return out;
}

/**
 * Elevation min/max across the grid, for picking the height range used in meshing/scaling.
 * @param {Float32Array} grid
 * @returns {{ min: number, max: number }}
 */
export function gridRange(grid) {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < grid.length; i++) {
    const v = grid[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

// Exact pixel-window crop (no interpolation): out[r*gw+c] = the mosaic sample at
// integer global pixel (win.gx0+c, win.gy0+r). Callers guarantee coverage via a
// halo; throw rather than clamp if that invariant breaks.
/**
 * @param {Mosaic} mosaic
 * @param {Window} win
 * @returns {Float32Array}
 */
export function cropGrid(mosaic, win) {
  const { data, width, height, originGx, originGy } = mosaic;
  const x0 = win.gx0 - originGx, y0 = win.gy0 - originGy;
  if (x0 < 0 || y0 < 0 || x0 + win.gw > width || y0 + win.gh > height) {
    throw new Error("cropGrid: window outside mosaic");
  }
  const out = new Float32Array(win.gw * win.gh);
  for (let r = 0; r < win.gh; r++) {
    const src = (y0 + r) * width + x0;
    out.set(data.subarray(src, src + win.gw), r * win.gw);
  }
  return out;
}
