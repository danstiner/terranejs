import { test } from "node:test";
import assert from "node:assert/strict";
import { applyWaterRecess } from "../src/core/water.js";
import { decodeWatermask } from "../src/core/terrain.js";
import { bandOf } from "../src/core/colors.js";

/** @param {number[]} elev @param {number[]} water @returns {[Float32Array, Uint8Array]} */
const tile = (elev, water) => [Float32Array.from(elev), Uint8Array.from(water)];
const K = 0.02, LAYER = 0.15;
/** @param {Partial<{flatten: boolean, recessMm: number, layerMm: number, K: number}>} [o] */
const opts = (o = {}) => ({ flatten: false, recessMm: 0, layerMm: LAYER, K, ...o });

// Kept from the old water.test.mjs — decodeWatermask lives in terrain.js but is tested nowhere
// else; the plane-model rewrite must not drop its coverage.
test("decodeWatermask: alpha>127 = ocean(1), else land(0)", () => {
  const rgba = Uint8Array.from([0,0,0,255,  0,0,0,0,  0,0,0,128,  0,0,0,127]); // 4 px
  assert.deepEqual([...decodeWatermask(rgba)], [1, 0, 1, 0]);
});

test("applyWaterRecess: no mask → no-op, colour line below all terrain", () => {
  const grid = Float32Array.from([100, 200, 300]);
  const r = applyWaterRecess(grid, undefined, opts());
  assert.deepEqual([...grid], [100, 200, 300], "grid untouched");
  assert.deepEqual(r, { lineElev: -Infinity, landBluePct: 0 });
});

test("applyWaterRecess: no water cells → no-op (waterless Death Valley stays green)", () => {
  const [grid, mask] = tile([100, -86, 300], [0, 0, 0]);
  const r = applyWaterRecess(grid, mask, opts());
  assert.deepEqual([...grid], [100, -86, 300]);
  assert.deepEqual(r, { lineElev: -Infinity, landBluePct: 0 });
});

test("applyWaterRecess: default — line at true 0 m, ocean blue, land above 0 green, no mutation", () => {
  const [grid, mask] = tile([0, 5, 20], [1, 0, 0]); // ocean 0, shore 5 m, land 20 m
  const r = applyWaterRecess(grid, mask, opts());
  assert.deepEqual([...grid], [0, 5, 20], "geometry untouched");
  assert.equal(r.lineElev, 0, "line at sea level exactly — the export pause carries the layer offset");
  assert.equal(bandOf(0, [r.lineElev]), 0, "ocean surface blue (≤ boundary)");
  assert.ok(bandOf(5, [r.lineElev]) > 0, "5 m shore green at ANY map scale");
  assert.equal(r.landBluePct, 0, "no land at/below the waterline");
});

test("applyWaterRecess: default — inland water above the anchor prints as terrain", () => {
  const [grid, mask] = tile([1890, 1900, 2100], [1, 0, 0]); // Tahoe-style tile
  const r = applyWaterRecess(grid, mask, opts());
  assert.deepEqual([...grid], [1890, 1900, 2100], "geometry untouched");
  assert.ok(bandOf(1890, [r.lineElev]) > 0, "lake reads as land — no blue on the tile");
  assert.equal(r.landBluePct, 0);
});

test("applyWaterRecess: default — polder land below 0 m counts blue (warning path, accepted)", () => {
  const [grid, mask] = tile([-2, -6, 20], [1, 0, 0]); // sea −2 m, polder −6 m
  const r = applyWaterRecess(grid, mask, opts());
  assert.equal(r.lineElev, 0);
  assert.equal(bandOf(-6, [r.lineElev]), 0, "polder prints blue below the sea-level anchor");
  assert.equal(r.landBluePct, 50, "counted so the warning can fire");
});

test("applyWaterRecess: slider only — all water sinks X/K, line unmoved, relative elevations kept", () => {
  const [grid, mask] = tile([0, 200, 300], [1, 1, 0]); // ocean + high lake
  const r = applyWaterRecess(grid, mask, opts({ recessMm: 2 })); // 2 mm = 100 m at K
  assert.equal(grid[0], -100); assert.equal(grid[1], 100); // both sank 100 m, 200 m apart still
  assert.equal(r.lineElev, 0, "line stays at the sea-level anchor");
  assert.ok(bandOf(100, [r.lineElev]) > 0, "sunk high lake still reads as terrain");
});

test("applyWaterRecess: flatten — polder plane 2 lifts below the land, land green, water blue", () => {
  // lift EXACT (0.5/0.5 = 1 m) so the boundary is float-exact. The line sits AT the plane
  // (the export pause carries the +1-layer offset — see colors.test's flatten-margin pin,
  // which demonstrates why the plane needs 2 lifts, not 1).
  const o = opts({ flatten: true, layerMm: 0.5, K: 0.5 }); // lift = 1 m exactly
  const [grid, mask] = tile([-2, -2, -6, 20], [1, 1, 0, 0]);
  const r = applyWaterRecess(grid, mask, o);
  assert.ok(bandOf(-6, [r.lineElev]) > 0, "lowest land clears the line");
  assert.equal(bandOf(-8, [r.lineElev]), 0, "water blue");
  assert.equal(grid[0], -8, "plane = landMin − 2·lift = −8");
  assert.equal(grid[1], -8, "all water on the one plane");
  assert.equal(r.lineElev, -8, "line AT the plane");
  assert.equal(r.landBluePct, 0);
});

test("applyWaterRecess: flatten — water lowest → plane at waterMin, unbounded pull-down", () => {
  const [grid, mask] = tile([0, 200, 300], [1, 1, 0]); // 200 m reservoir over an ocean
  const r = applyWaterRecess(grid, mask, opts({ flatten: true }));
  assert.equal(grid[0], 0, "plane = waterMin (land far above)");
  assert.equal(grid[1], 0, "reservoir dropped 200 m to the plane — no gate");
  assert.equal(r.lineElev, 0, "line at the plane");
  assert.equal(r.landBluePct, 0);
});

test("applyWaterRecess: flatten + slider — water sinks below the plane, line unmoved", () => {
  const o = opts({ flatten: true, recessMm: 1, layerMm: 0.5, K: 0.5 }); // sink = 2 m, lift = 1 m
  const [grid, mask] = tile([-2, -2, -6, 20], [1, 1, 0, 0]);
  const r = applyWaterRecess(grid, mask, o);
  assert.equal(grid[0], -10, "plane −8, sunk a further 2 m");
  assert.equal(r.lineElev, -8, "line still AT the PLANE, not the sunk water");
});

test("applyWaterRecess: flatten, all-water tile → plane at waterMin, still blue", () => {
  const [grid, mask] = tile([3, 4], [1, 1]);
  const r = applyWaterRecess(grid, mask, opts({ flatten: true }));
  assert.equal(grid[0], 3); assert.equal(grid[1], 3);
  assert.equal(bandOf(3, [r.lineElev]), 0, "water blue");
  assert.equal(r.landBluePct, 0, "zero-land denominator guarded");
});

test("applyWaterRecess: layerMm sets the flatten plane's land clearance (2 layers)", () => {
  const K = 0.5;
  const [g1, m1] = tile([-2, -6, 20], [1, 0, 0]);
  const [g2, m2] = tile([-2, -6, 20], [1, 0, 0]);
  const r1 = applyWaterRecess(g1, m1, { flatten: true, recessMm: 0, layerMm: 0.5, K }); // lift 1 m
  const r2 = applyWaterRecess(g2, m2, { flatten: true, recessMm: 0, layerMm: 1, K });   // lift 2 m
  assert.equal(r1.lineElev, -8, "plane = landMin − 2·1");
  assert.equal(r2.lineElev, -10, "doubled layer → doubled clearance");
});
