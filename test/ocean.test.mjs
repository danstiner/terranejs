import { test } from "node:test";
import assert from "node:assert/strict";
import { oceanMaskFlood, upsampleMask, recessMasked, seaLevelColorLineM, cropMask } from "../src/core/ocean.js";

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

test("cropMask: extracts the centre cell of a padded mask", () => {
  // 3×3 padded mask; centre cell (1,1)=1, everything else 0.
  const m = new Uint8Array(9);
  m[1 * 3 + 1] = 1;
  const c = cropMask(m, 3, 3, 1, 1, 1, 1);
  assert.equal(c.length, 1);
  assert.equal(c[0], 1);
});

test("padding flips a tile-edge basin from sea to land", () => {
  // A basin (−5) that reaches the LEFT edge of the tile crop but is enclosed by land
  // within the padded context. Bare-tile flood seeds from that edge → basin reads sea.
  // Padded flood seeds from the true (all-land) boundary → basin stays land.
  const tw = 3, th = 3;                                   // the tile crop
  const tile = new Float32Array(tw * th).fill(100);
  for (let r = 0; r < th; r++) tile[r * tw + 0] = -5;     // basin on the tile's W edge
  const bare = oceanMaskFlood(tile, tw, th, 0);
  assert.equal(bare[1 * tw + 0], 1, "bare tile: edge basin floods as sea");

  // Padded 5×5: the tile sits in the centre; a ring of land (100) surrounds it, so the
  // basin column is no longer on the padded frame edge.
  const pw = 5, ph = 5;
  const pad = new Float32Array(pw * ph).fill(100);
  for (let r = 1; r < 4; r++) pad[r * pw + 1] = -5;       // basin column, inset by 1 (the pad)
  const padMask = oceanMaskFlood(pad, pw, ph, 0);
  const tileMask = cropMask(padMask, pw, ph, 1, 1, tw, th);
  assert.equal(tileMask[1 * tw + 0], 0, "padded: same basin stays land");
});
