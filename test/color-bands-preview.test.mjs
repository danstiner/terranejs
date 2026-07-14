import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPreviewSolid } from "../js/mesh.js";
import { BAND_COLORS } from "../js/color-bands.js";

// 2x2 grid, one cell → two top triangles. Flat elevation so every top vertex
// has the same z = base + (elev-emin)*mmPerM*exag; pick values landing in "rock".
test("buildPreviewSolid: band mode colors the top by centroid Z", () => {
  const gw = 2, gh = 2;
  const grid = new Float32Array([1500, 1500, 1500, 1500]); // metres
  const mask = new Uint8Array([1]);
  const geom = {
    dx: 1, dy: 1, offX: 0, offY: 0, mmPerM: 1, emin: 0, erange: 3000,
    exag: 1, base: 6,
    // thresholds in PRINT Z: base + (t-emin)*mmPerM*exag for t=[0,1000,1400,2000]
    bandsZ: [6, 1006, 1406, 2006],
  };
  const { positions, colors } = buildPreviewSolid(grid, gw, gh,
    { r0: 0, r1: 1, c0: 0, c1: 1 }, mask, geom);
  // top z = 6 + 1500 = 1506 → band 3 (rock: 1406 < 1506 ≤ 2006)
  // first top triangle occupies colors[0..8]; all three vertices == BAND_COLORS[3]
  // (colors is a Float32Array, so compare with tolerance, not exact equality)
  const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
  assert.ok(close([colors[0], colors[1], colors[2]], BAND_COLORS[3]));
  assert.ok(close([colors[3], colors[4], colors[5]], BAND_COLORS[3]));
});
