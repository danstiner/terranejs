import { test } from "node:test";
import assert from "node:assert/strict";
import { signedVolume, checkWatertight, toTriangleSoup } from "../js/validate.js";

// 2×2×2 axis-aligned cube, outward-wound
function cube() {
  const positions = Float32Array.from([
    0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0, // bottom ring (z=0)
    0, 0, 2, 2, 0, 2, 2, 2, 2, 0, 2, 2, // top ring (z=2)
  ]);
  const indices = Uint32Array.from([
    0, 2, 1, 0, 3, 2, // bottom (−Z)
    4, 5, 6, 4, 6, 7, // top (+Z)
    0, 1, 5, 0, 5, 4, // south
    1, 2, 6, 1, 6, 5, // east
    2, 3, 7, 2, 7, 6, // north
    3, 0, 4, 3, 4, 7, // west
  ]);
  return { positions, indices };
}

test("signedVolume: outward cube is +8, mirrored is −8", () => {
  const m = cube();
  assert.ok(Math.abs(signedVolume(m) - 8) < 1e-6);
  const flipped = { positions: m.positions, indices: Uint32Array.from(m.indices) };
  for (let i = 0; i < flipped.indices.length; i += 3) {
    const t = flipped.indices[i + 1];
    flipped.indices[i + 1] = flipped.indices[i + 2];
    flipped.indices[i + 2] = t;
  }
  assert.ok(Math.abs(signedVolume(flipped) + 8) < 1e-6);
});

test("checkWatertight: cube closed; open after dropping a face", () => {
  const m = cube();
  assert.deepEqual(checkWatertight(m), { closed: true, unmatched: 0 });
  const open = { positions: m.positions, indices: m.indices.slice(0, m.indices.length - 3) };
  assert.ok(!checkWatertight(open).closed);
  assert.ok(checkWatertight(open).unmatched > 0);
});

test("toTriangleSoup: explodes indices, preserves volume", () => {
  const m = cube();
  const soup = toTriangleSoup(m);
  assert.equal(soup.length, m.indices.length * 3);
  let vol = 0;
  for (let i = 0; i < soup.length; i += 9) {
    vol += (soup[i] * (soup[i + 4] * soup[i + 8] - soup[i + 5] * soup[i + 7]) -
      soup[i + 1] * (soup[i + 3] * soup[i + 8] - soup[i + 5] * soup[i + 6]) +
      soup[i + 2] * (soup[i + 3] * soup[i + 7] - soup[i + 4] * soup[i + 6])) / 6;
  }
  assert.ok(Math.abs(vol - 8) < 1e-6);
});
