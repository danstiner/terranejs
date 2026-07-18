import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeTerrarium, mosaicTiles, fetchMosaic } from "../src/core/terrain.js";

test("decodeTerrarium: (R*256+G+B/256)-32768 metres", () => {
  // 32768 -> 0 m ; encode 0 m as R=128,G=0,B=0 -> 128*256-32768 = 0
  const rgba = new Uint8ClampedArray([128, 0, 0, 255, 128, 100, 128, 255]);
  const el = decodeTerrarium(rgba);
  assert.equal(el[0], 0);
  assert.ok(Math.abs(el[1] - (100 + 128 / 256)) < 1e-6); // 100.5 m
});

test("decodeTerrarium: below sea level (bathymetry) is negative", () => {
  const rgba = new Uint8ClampedArray([127, 0, 0, 255]); // 127*256-32768 = -256
  assert.equal(decodeTerrarium(rgba)[0], -256);
});

test("mosaicTiles: a bbox crossing the antimeridian eastward fetches real wrapped tiles", () => {
  // z=2 → 4 data tiles per axis (0..3); the antimeridian is the 3|0 boundary. A
  // strip from tile 3 (just west of +180°) to tile 4 (one past the edge) must
  // fetch tile 4 mod 4 = 0 — a real tile (verified HTTP 200) rather than the
  // nonexistent x=4 (HTTP 404) — placed in the east column so the mosaic is
  // contiguous. y is passed through untouched.
  const jobs = mosaicTiles({ tx0: 3, tx1: 4, ty0: 1, ty1: 1 }, 2);
  assert.deepEqual(jobs, [
    { x: 3, y: 1, ox: 0, oy: 0 },
    { x: 0, y: 1, ox: 256, oy: 0 },
  ]);
});

test("mosaicTiles: a bbox crossing westward wraps -1 to the east-most tile", () => {
  // tile -1 (one west of -180°) is really tile 3 at z=2.
  const jobs = mosaicTiles({ tx0: -1, tx1: 0, ty0: 0, ty1: 0 }, 2);
  assert.deepEqual(jobs, [
    { x: 3, y: 0, ox: 0, oy: 0 },
    { x: 0, y: 0, ox: 256, oy: 0 },
  ]);
});

test("mosaicTiles: every fetched x stays in [0, 2^z) for any tile range", () => {
  const z = 3, world = 2 ** z;
  const jobs = mosaicTiles({ tx0: -2, tx1: world + 1, ty0: 0, ty1: 0 }, z);
  for (const j of jobs) assert.ok(j.x >= 0 && j.x < world, `x=${j.x} out of range`);
  // columns stay unwrapped/monotonic so the strip is contiguous
  assert.deepEqual(jobs.map((j) => j.ox), jobs.map((_, i) => i * 256));
});

test("fetchMosaic: a bbox beyond the ±85.05° cap throws instead of corrupting", async () => {
  // Entirely north of the Mercator limit → empty clamped y-range. Must fail loud
  // BEFORE any network/canvas work, not allocate a negative-length buffer. (The
  // guard runs before fetch, so this stays a pure, offline test.)
  await assert.rejects(() => fetchMosaic([88, 0, 89.5, 10], 2), /no tiles|Web Mercator/);
});
