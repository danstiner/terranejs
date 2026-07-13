// Pure resampling: terrarium mosaic -> print grid (row 0 = north), bilinear.
// The mosaic is web-mercator (uniform in global pixels); the output grid is
// uniform in those SAME global pixels (Mercator), matching the print lattice the
// tiles are meshed on. lon->x and mercator-y->row are both linear, so the per-col
// x and per-row y indices are plain linear ramps. Pixel-center convention:
// mosaic[i] is the sample at global pixel (origin+i+0.5).
import { lonToGlobalX, latToGlobalY } from "./tilemath.js";

export function resampleBilinear(mosaic, [s, w, n, e], gridW, gridH) {
  const { data, width, height, originGx, originGy, z } = mosaic;
  const out = new Float32Array(gridW * gridH);

  const sx = new Float64Array(gridW); // fractional mosaic x index per col
  for (let c = 0; c < gridW; c++) {
    const lon = gridW === 1 ? w : w + ((e - w) * c) / (gridW - 1);
    sx[c] = lonToGlobalX(lon, z) - originGx - 0.5;
  }
  const gyN = latToGlobalY(n, z) - originGy - 0.5; // row 0 = north (smaller global y)
  const gyS = latToGlobalY(s, z) - originGy - 0.5;
  const sy = new Float64Array(gridH);
  for (let r = 0; r < gridH; r++) {
    sy[r] = gridH === 1 ? gyN : gyN + ((gyS - gyN) * r) / (gridH - 1);
  }

  const clamp = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v);
  for (let r = 0; r < gridH; r++) {
    const fy = sy[r];
    const y0 = clamp(Math.floor(fy), height - 1);
    const y1 = clamp(y0 + 1, height - 1);
    const wy = fy - Math.floor(fy);
    for (let c = 0; c < gridW; c++) {
      const fx = sx[c];
      const x0 = clamp(Math.floor(fx), width - 1);
      const x1 = clamp(x0 + 1, width - 1);
      const wx = fx - Math.floor(fx);
      const a = data[y0 * width + x0], b = data[y0 * width + x1];
      const cc = data[y1 * width + x0], d = data[y1 * width + x1];
      const top = a + (b - a) * wx;
      const bot = cc + (d - cc) * wx;
      out[r * gridW + c] = top + (bot - top) * wy;
    }
  }
  return out;
}

export function gridRange(grid) {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < grid.length; i++) {
    const v = grid[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

// Exact pixel-window crop (no interpolation): out[r*gw+c] = the mosaic sample
// at integer global pixel (win.gx0+c, win.gy0+r). The fetch's 1-px halo
// guarantees coverage; throw rather than clamp if that invariant breaks.
export function cropGrid(mosaic, win) {
  const { data, width, height, originGx, originGy } = mosaic;
  const x0 = win.gx0 - originGx, y0 = win.gy0 - originGy;
  if (x0 < 0 || y0 < 0 || x0 + win.gw > width || y0 + win.gh > height) {
    throw new Error("cropGrid: window outside mosaic");
  }
  const out = new Float32Array(win.gw * win.gh);
  for (let r = 0; r < win.gh; r++) {
    const s = (y0 + r) * width + x0;
    out.set(data.subarray(s, s + win.gw), r * win.gw);
  }
  return out;
}
