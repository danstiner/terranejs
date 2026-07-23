import { test } from "node:test";
import assert from "node:assert/strict";
import { oceanMaskFlood, upsampleMask, recessMasked, seaLevelColorLineM } from "../src/core/ocean.js";

test("oceanMaskFlood: edge-connected sea floods, enclosed basin stays land", () => {
  // 5×5 grid: left column is open sea (≤0, touches the W edge); a lone −5 pocket at
  // centre (2,2) is ringed by land, so it must NOT be marked ocean.
  const gw = 5, gh = 5;
  const g = new Float32Array(gw * gh).fill(100);
  for (let r = 0; r < gh; r++) g[r * gw + 0] = -10; // W-edge sea column
  g[2 * gw + 2] = -5;                                // enclosed sub-sea pocket
  const mask = oceanMaskFlood(g, gw, gh, 0);
  assert.equal(mask[2 * gw + 0], 1, "W-edge sea is ocean");
  assert.equal(mask[2 * gw + 2], 0, "enclosed pocket stays land");
  assert.equal(mask[2 * gw + 4], 0, "far land is land");
});

test("upsampleMask: nearest-neighbour doubles a 2×2 into 4×4", () => {
  const c = Uint8Array.from([1, 0, 0, 1]); // 2×2 checker corners
  const f = upsampleMask(c, 2, 2, 4, 4);
  assert.equal(f.length, 16);
  assert.equal(f[0], 1);            // top-left maps to coarse (0,0)=1
  assert.equal(f[4 * 3 + 3], 1);    // bottom-right maps to coarse (1,1)=1
  assert.equal(f[3], 0);            // top-right maps to coarse (0,1)=0
});

test("recessMasked: masked cells clamp to floor, land untouched", () => {
  const g = Float32Array.from([-3, 50, -1, 200]);
  const mask = Uint8Array.from([1, 0, 1, 0]);
  recessMasked(g, mask, -80);
  assert.deepEqual([...g], [-80, 50, -80, 200]);
});

test("seaLevelColorLineM: flat lifts by colorLiftMm/K, others 0", () => {
  assert.equal(seaLevelColorLineM("flat", 0.1, 0.004), 25);   // 0.1 / 0.004
  assert.equal(seaLevelColorLineM("recessed", 0.1, 0.004), 0);
  assert.equal(seaLevelColorLineM("bathymetric", 0.1, 0.004), 0);
});
