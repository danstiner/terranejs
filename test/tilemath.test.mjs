import { test } from "node:test";
import assert from "node:assert/strict";
import {
  groundResolution, lonToGlobalX, latToGlobalY, globalXToLon, globalYToLat,
  printPitchMm, sourceZoom, tileRangeForBBox, PITCH_FLOOR_MM,
} from "../src/core/tilemath.js";

test("globalXToLon/globalYToLat invert the forward maps", () => {
  for (const z of [3, 10, 15]) {
    assert.ok(Math.abs(globalXToLon(lonToGlobalX(-122.33, z), z) + 122.33) < 1e-9);
    assert.ok(Math.abs(globalYToLat(latToGlobalY(47.61, z), z) - 47.61) < 1e-9);
  }
});

test("printPitchMm matches groundResolution scaling", () => {
  const p = printPitchMm(47.6, 14, 70500);
  assert.ok(Math.abs(p - (groundResolution(47.6, 14) / 70500) * 1000) < 1e-12);
  assert.ok(p > 0.08 && p < 0.1); // ≈0.091 mm
});

test("sourceZoom: shallowest zoom at or under the given floor", () => {
  const bbox = /** @type {import("../src/core/types.js").BBox} */ ([47.1, -122.5, 47.8, -121.1]);
  // Assert behavior against an explicit floor so this stays valid whatever
  // PITCH_FLOOR_MM is set to. 0.1 mm is reachable within the z15 data pyramid
  // at this scale (z13 ≈ 0.18 mm > 0.1; z14 ≈ 0.09 mm ≤ 0.1).
  const floor = 0.1;
  const z = sourceZoom(bbox, 47.45, 70500, 1e9, floor);
  assert.ok(printPitchMm(47.45, z, 70500) <= floor);
  assert.ok(printPitchMm(47.45, z - 1, 70500) > floor);
  // Omitting the floor argument defaults to PITCH_FLOOR_MM (value-agnostic).
  assert.equal(
    sourceZoom(bbox, 47.45, 70500, 1e9),
    sourceZoom(bbox, 47.45, 70500, 1e9, PITCH_FLOOR_MM),
  );
});

test("sourceZoom: tile budget clamps the zoom down", () => {
  const bbox = /** @type {import("../src/core/types.js").BBox} */ ([47.1, -122.5, 47.8, -121.1]);
  const z = sourceZoom(bbox, 47.45, 70500, 12);
  assert.ok(z < 14);
  assert.ok(tileRangeForBBox(bbox, z).count <= 12);
  assert.ok(z === 1 || tileRangeForBBox(bbox, z + 1).count > 12);
});

test("sourceZoom: caps at the pyramid max", () => {
  // 1:20000 → z15 pitch ≈ 0.16 mm, still above the floor → capped at 15
  assert.equal(sourceZoom([47.5, -122.0, 47.51, -121.99], 47.5, 20000, 1e9), 15);
});
