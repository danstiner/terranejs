import { test } from "node:test";
import assert from "node:assert/strict";
import { recessMasked, seaLevelColorLineM } from "../src/core/water.js";
import { decodeWatermask } from "../src/core/terrain.js";

test("decodeWatermask: alpha>127 = ocean(1), else land(0)", () => {
  const rgba = Uint8Array.from([0,0,0,255,  0,0,0,0,  0,0,0,128,  0,0,0,127]); // 4 px
  assert.deepEqual([...decodeWatermask(rgba)], [1, 0, 1, 0]);
});

test("recessMasked: masked cells clamp to floor, land untouched", () => {
  const g = Float32Array.from([-3, 50, -1, 200]);
  const mask = Uint8Array.from([1, 0, 1, 0]);
  recessMasked(g, mask, -80);
  assert.deepEqual([...g], [-80, 50, -80, 200]);
});

test("seaLevelColorLineM: flat lifts by colorLiftMm/K, recessed 0", () => {
  assert.equal(seaLevelColorLineM("flat", 0.1, 0.004), 25);   // 0.1 / 0.004
  assert.equal(seaLevelColorLineM("recessed", 0.1, 0.004), 0);
});
