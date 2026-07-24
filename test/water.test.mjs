import { test } from "node:test";
import assert from "node:assert/strict";
import { applyWaterRecess, COLOR_LIFT_MM, AUTO_MIN_RECESS_MM } from "../src/core/water.js";
import { decodeWatermask } from "../src/core/terrain.js";

/** @param {number[]} elev @param {number[]} water @returns {[Float32Array, Uint8Array]} */
const tile = (elev, water) => [Float32Array.from(elev), Uint8Array.from(water)];

// Kept from the old water.test.mjs — decodeWatermask lives in terrain.js but is tested nowhere
// else; the water-recess rewrite must not drop its coverage.
test("decodeWatermask: alpha>127 = ocean(1), else land(0)", () => {
  const rgba = Uint8Array.from([0,0,0,255,  0,0,0,0,  0,0,0,128,  0,0,0,127]); // 4 px
  assert.deepEqual([...decodeWatermask(rgba)], [1, 0, 1, 0]);
});

test("applyWaterRecess: no mask → no-op, colour line at sea level", () => {
  const grid = Float32Array.from([100, 200, 300]);
  const r = applyWaterRecess(grid, undefined, { mode: "auto", recessMm: 2, K: 0.02 });
  assert.deepEqual([...grid], [100, 200, 300], "grid untouched");
  assert.deepEqual(r, { lineElev: 0, landBluePct: 0 });
});

test("applyWaterRecess: no water cells → no-op", () => {
  const [grid, mask] = tile([100, 200, 300], [0, 0, 0]);
  const r = applyWaterRecess(grid, mask, { mode: "auto", recessMm: 2, K: 0.02 });
  assert.deepEqual([...grid], [100, 200, 300]);
  assert.deepEqual(r, { lineElev: 0, landBluePct: 0 });
});

test("applyWaterRecess: auto, water lowest → minimal recess, water below land, land all green", () => {
  const K = 0.02;
  const [grid, mask] = tile([0, 0, 50, 100], [1, 1, 0, 0]);
  const r = applyWaterRecess(grid, mask, { mode: "auto", recessMm: 2, K });
  // land above the water → needed recess ≤ COLOR_LIFT_MM → floored to AUTO_MIN_RECESS_MM (slider unused).
  const eff = Math.max(AUTO_MIN_RECESS_MM, Math.min(2, COLOR_LIFT_MM + (0 - 50) * K));
  const floor = 0 - eff / K;
  assert.equal(eff, AUTO_MIN_RECESS_MM, "recess is the floor, not the 2 mm slider");
  assert.ok(Math.abs(grid[0] - floor) < 1e-4 && Math.abs(grid[1] - floor) < 1e-4, "water at the floor");
  assert.equal(grid[2], 50); assert.equal(grid[3], 100); // land untouched
  assert.ok(Math.abs(r.lineElev - (floor + COLOR_LIFT_MM / K)) < 1e-4, "line = floor + lift/K");
  assert.ok(r.lineElev < 50, "line below the lowest land");
  assert.equal(r.landBluePct, 0);
});

test("applyWaterRecess: auto, below-sea land lower than the water → water recessed below the polder", () => {
  const K = 0.02;
  const [grid, mask] = tile([-2, -2, -6, 4], [1, 1, 0, 0]); // polder land −6 < water −2
  const r = applyWaterRecess(grid, mask, { mode: "auto", recessMm: 2, K });
  // needed = lift + (waterMin − landMin)·K = 0.15 + (−2−(−6))·0.02 = 0.23 mm → still floored to 0.30.
  const eff = Math.max(AUTO_MIN_RECESS_MM, Math.min(2, COLOR_LIFT_MM + (-2 - -6) * K));
  const floor = -2 - eff / K; // recess measured from the water surface (−2), not the land
  assert.ok(Math.abs(grid[0] - floor) < 1e-4, "water recessed below the polder");
  assert.ok(r.lineElev < -6, "line below the −6 m polder → polder prints green");
  assert.equal(r.landBluePct, 0);
});

test("applyWaterRecess: auto — Max-recess slider doesn't change the recess on a normal coast", () => {
  const K = 0.02; // the Seattle case: water lowest, land well above it
  const [g2, m2] = tile([0, 0, 30, 80], [1, 1, 0, 0]);
  const [g5, m5] = tile([0, 0, 30, 80], [1, 1, 0, 0]);
  const r2 = applyWaterRecess(g2, m2, { mode: "auto", recessMm: 2, K });
  const r5 = applyWaterRecess(g5, m5, { mode: "auto", recessMm: 5, K });
  assert.equal(g2[0], g5[0], "recess floor unchanged between Max recess 2 mm and 5 mm");
  assert.equal(r2.lineElev, r5.lineElev, "colour line unchanged");
});

test("applyWaterRecess: auto — Max-recess caps the recess only when land is far below the water", () => {
  const K = 0.02; // land −150 m: needed = 0.15 + 150·0.02 = 3.15 mm > 2 mm
  const [g2, m2] = tile([0, -150], [1, 0]);
  const [g5, m5] = tile([0, -150], [1, 0]);
  applyWaterRecess(g2, m2, { mode: "auto", recessMm: 2, K });
  applyWaterRecess(g5, m5, { mode: "auto", recessMm: 5, K });
  assert.ok(g2[0] > g5[0], "2 mm cap recesses less than 5 mm when the needed recess (3.15 mm) exceeds it");
});

test("applyWaterRecess: manual recess 0 → water flush, line a colour-lift above", () => {
  const K = 0.02;
  const [grid, mask] = tile([3, 3, 50], [1, 1, 0]);
  const r = applyWaterRecess(grid, mask, { mode: "manual", recessMm: 0, K });
  assert.equal(grid[0], 3); assert.equal(grid[1], 3);
  assert.ok(Math.abs(r.lineElev - (3 + COLOR_LIFT_MM / K)) < 1e-4, "line = waterMin + lift/K");
});

test("applyWaterRecess: manual, low land within a colour-lift of the water prints blue", () => {
  const K = 0.02; // lift/K = 7.5 m
  const [grid, mask] = tile([0, 4, 20], [1, 0, 0]); // land 4 m blue, 20 m green
  const r = applyWaterRecess(grid, mask, { mode: "manual", recessMm: 0, K });
  assert.equal(r.landBluePct, 50);
});

test("applyWaterRecess: auto — colour line capped at the lowest land so land never prints blue", () => {
  const K = 0.02; // land −100 sits 100 m below the lowest water (0); needed recess ≈ 2.15 mm
  const [grid, mask] = tile([0, 0, -100, -80], [1, 1, 0, 0]);
  const r = applyWaterRecess(grid, mask, { mode: "auto", recessMm: 1, K }); // 1 mm < needed → can't clear
  assert.equal(r.lineElev, -100, "line capped at the lowest land (−100 m), not left above it");
  assert.equal(r.landBluePct, 0, "no land renders blue — the low water reads as land instead");
});

test("applyWaterRecess: Max recess controls which higher water gets pulled down to blue", () => {
  const K = 0.02; // recessMm/K metres: 2 mm → 100 m gate, 10 mm → 500 m gate
  const [gLow, mLow] = tile([0, 200, 300], [1, 1, 0]); // low water 0, higher water body 200 m, land 300
  applyWaterRecess(gLow, mLow, { mode: "auto", recessMm: 2, K });
  assert.equal(gLow[1], 200, "Max recess 2 mm (100 m gate) → the 200 m water body stays at elevation");
  assert.ok(gLow[0] < 0, "the lowest water still recesses to the blue base");

  const [gHigh, mHigh] = tile([0, 200, 300], [1, 1, 0]);
  applyWaterRecess(gHigh, mHigh, { mode: "auto", recessMm: 10, K });
  assert.ok(gHigh[1] < 0, "Max recess 10 mm (500 m gate) → the 200 m body recesses to the blue base");
});
