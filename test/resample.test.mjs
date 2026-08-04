import { test } from "node:test";
import assert from "node:assert/strict";
import { resampleBilinear, gridRange, cropGrid } from "../src/core/resample.js";
import { lonToGlobalX, latToGlobalY } from "../src/core/tilemath.js";

/** @typedef {import("../src/core/types.js").BBox} BBox */
/** @typedef {import("../src/core/types.js").Mosaic} Mosaic */

// A mosaic whose elevation is an exact linear function of global-pixel coords:
// elev = A*gx + B*gy + C. Bilinear resampling is exact for linear fields, so the
// resampled output must equal the analytic value at each sample — this pins the
// pixel-center convention and the per-row/col index math. Origin/size are chosen
// with a 2-px margin so every sample has its 4 bilinear neighbours in-bounds.
/**
 * @param {number} z
 * @param {BBox} bbox
 * @param {number} A
 * @param {number} B
 * @param {number} C
 * @returns {Mosaic}
 */
function linearMosaic(z, bbox, A, B, C) {
  const gx = [lonToGlobalX(bbox[1], z), lonToGlobalX(bbox[3], z)];
  const gy = [latToGlobalY(bbox[2], z), latToGlobalY(bbox[0], z)];
  const originGx = Math.floor(Math.min(...gx)) - 2;
  const originGy = Math.floor(Math.min(...gy)) - 2;
  const width = Math.ceil(Math.max(...gx)) - originGx + 3;
  const height = Math.ceil(Math.max(...gy)) - originGy + 3;
  const data = new Float32Array(width * height);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      // pixel-center (c+0.5, r+0.5); small magnitudes keep Float32 exact enough
      data[r * width + c] = A * (c + 0.5) + B * (r + 0.5) + C;
    }
  }
  return { data, width, height, originGx, originGy, z };
}

test("bilinear reproduces a linear field exactly (pixel-center correct)", () => {
  /** @type {BBox} */
  const bbox = [46.75, -121.85, 46.92, -121.65];
  const z = 12, A = 0.5, B = -0.3, C = 1000;
  const m = linearMosaic(z, bbox, A, B, C);
  const gw = 40, gh = 33;
  const out = resampleBilinear(m, bbox, gw, gh);
  const [s, w, n, e] = bbox;
  let worst = 0;
  const gyN = latToGlobalY(n, z), gyS = latToGlobalY(s, z);
  for (let r = 0; r < gh; r++) {
    // rows uniform in global mercator y (row 0 = north), not latitude
    const cy = gyN + ((gyS - gyN) * r) / (gh - 1) - m.originGy - 0.5;
    for (let c = 0; c < gw; c++) {
      const lon = w + ((e - w) * c) / (gw - 1);
      const cx = lonToGlobalX(lon, z) - m.originGx - 0.5;
      const expected = A * (cx + 0.5) + B * (cy + 0.5) + C;
      worst = Math.max(worst, Math.abs(out[r * gw + c] - expected));
    }
  }
  assert.ok(worst < 1e-3, `worst error ${worst}`);
});

test("rows are uniform in mercator y: linear field -> constant per-row delta", () => {
  // elev = B*gy only. On mercator-uniform rows gy is linear in r, so a column
  // has a constant per-row delta. On lat-uniform rows gy(lat_r) is nonlinear in
  // r over a tall bbox and the delta would vary -> this test would fail.
  /** @type {BBox} */
  const bbox = [30.0, -100.0, 38.0, -92.0]; // ~8° tall
  const z = 8, B = 1;
  const m = linearMosaic(z, bbox, 0, B, 0);
  const gw = 3, gh = 20;
  const out = resampleBilinear(m, bbox, gw, gh);
  /** @type {(r: number) => number} */
  const col = (r) => out[r * gw]; // column 0
  const d0 = col(1) - col(0);
  let worst = 0;
  for (let r = 1; r < gh - 1; r++) worst = Math.max(worst, Math.abs(col(r + 1) - col(r) - d0));
  assert.ok(worst < 1e-3, `per-row delta not constant: worst ${worst}`);
});

test("row 0 is north, last row is south", () => {
  // constant-per-latitude field (B only) increases southward (global-y grows south)
  /** @type {BBox} */
  const bbox = [46.0, -121.0, 47.0, -120.0];
  const m = linearMosaic(12, bbox, 0, 1, 0);
  const out = resampleBilinear(m, bbox, 5, 5);
  assert.ok(out[0] < out[4 * 5], "north row should have smaller global-y than south row");
});

test("gridRange", () => {
  const r = gridRange(new Float32Array([3, -1, 7, 2]));
  assert.equal(r.min, -1);
  assert.equal(r.max, 7);
});

test("cropGrid: exact sample extraction by global pixel index", () => {
  const width = 8, height = 6;
  const data = Float32Array.from({ length: width * height }, (_, i) => i);
  /** @type {Mosaic} */
  const mosaic = { data, width, height, originGx: 100, originGy: 200, z: 7 };
  const out = cropGrid(mosaic, { gx0: 102, gy0: 201, gw: 3, gh: 2 });
  assert.deepEqual([...out], [10, 11, 12, 18, 19, 20]);
  assert.throws(() => cropGrid(mosaic, { gx0: 106, gy0: 201, gw: 3, gh: 2 })); // right edge out
  assert.throws(() => cropGrid(mosaic, { gx0: 99, gy0: 201, gw: 3, gh: 2 }));  // left edge out
  assert.throws(() => cropGrid(mosaic, { gx0: 102, gy0: 205, gw: 3, gh: 2 })); // bottom edge out
  assert.throws(() => cropGrid(mosaic, { gx0: 102, gy0: 199, gw: 3, gh: 2 })); // top edge out (gy0 < originGy)
});

test("resampleBilinear clamps to the edge (no halo) instead of blending inward", () => {
  // A mosaic that does NOT cover the bbox's NW corner (no halo): the west edge
  // samples at fractional x = -0.5. Edge-clamp must replicate the edge pixel, not
  // blend the neighbour in. data = column index, so the west-edge value is 0;
  // the pre-fix code blended columns 0 and 1 and returned 0.5.
  const width = 4, height = 4;
  const data = new Float32Array(width * height);
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) data[r * width + c] = c;
  // z=0: west lon -90 -> global x 64 exactly; north lat 45 -> global y ~92.09.
  // Origin on those pixels puts both fractional indices at ~-0.5 (outside).
  /** @type {Mosaic} */
  const mosaic = { data, width, height, originGx: 64, originGy: 92, z: 0 };
  /** @type {BBox} */
  const bbox = [45, -90, 45, -90]; // degenerate 1×1 sample at the NW corner
  const out = resampleBilinear(mosaic, bbox, 1, 1);
  assert.equal(out[0], 0);
});

test("resampleBilinear samples across the antimeridian (bbox with e > 180)", () => {
  // A print bbox straddling the dateline is expressed unwrapped: west 175°, east
  // 185° (e beyond +180). lonToGlobalX is linear with no wrap, so the mosaic's
  // global-x runs continuously past the world edge; bilinear must sample that
  // strip exactly. Same linear-field trick — exact for linear fields.
  /** @type {BBox} */
  const bbox = [40, 175, 41, 185];
  const z = 6, A = 0.25, B = -0.4, C = 500;
  const m = linearMosaic(z, bbox, A, B, C);
  const gw = 24, gh = 8;
  const out = resampleBilinear(m, bbox, gw, gh);
  const [s, w, n, e] = bbox;
  const gyN = latToGlobalY(n, z), gyS = latToGlobalY(s, z);
  const worldPx = 256 * 2 ** z;
  let worst = 0, crossed = false;
  for (let r = 0; r < gh; r++) {
    const cy = gyN + ((gyS - gyN) * r) / (gh - 1) - m.originGy - 0.5;
    for (let c = 0; c < gw; c++) {
      const lon = w + ((e - w) * c) / (gw - 1);
      if (lonToGlobalX(lon, z) > worldPx) crossed = true; // columns east of +180°
      const cx = lonToGlobalX(lon, z) - m.originGx - 0.5;
      const expected = A * (cx + 0.5) + B * (cy + 0.5) + C;
      worst = Math.max(worst, Math.abs(out[r * gw + c] - expected));
    }
  }
  assert.ok(crossed, "test must include columns past the dateline (lon > 180)");
  assert.ok(worst < 1e-2, `worst error ${worst}`);
});
