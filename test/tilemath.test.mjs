import { test } from "node:test";
import assert from "node:assert/strict";
import {
  groundResolution, lonToGlobalX, latToGlobalY, globalXToLon, globalYToLat,
  printPitchMm, sourceZoom, pixelWindow, tileRangeForBBox, PITCH_FLOOR_MM,
} from "../js/tilemath.js";

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

test("sourceZoom: shallowest zoom at or under the pitch floor", () => {
  const bbox = [47.1, -122.5, 47.8, -121.1];
  const z = sourceZoom(bbox, 47.45, 70500, 1e9);
  assert.equal(z, 14); // z13 = 0.18 mm > 0.1; z14 = 0.09 mm ≤ 0.1
  assert.ok(printPitchMm(47.45, z, 70500) <= PITCH_FLOOR_MM);
  assert.ok(printPitchMm(47.45, z - 1, 70500) > PITCH_FLOOR_MM);
});

test("sourceZoom: tile budget clamps the zoom down", () => {
  const bbox = [47.1, -122.5, 47.8, -121.1];
  const z = sourceZoom(bbox, 47.45, 70500, 12);
  assert.ok(z < 14);
  assert.ok(tileRangeForBBox(bbox, z).count <= 12);
  assert.ok(z === 1 || tileRangeForBBox(bbox, z + 1).count > 12);
});

test("sourceZoom: caps at the pyramid max", () => {
  // 1:20000 → z15 pitch ≈ 0.16 mm, still above the floor → capped at 15
  assert.equal(sourceZoom([47.5, -122.0, 47.51, -121.99], 47.5, 20000, 1e9), 15);
});

test("pixelWindow: interior pixel-center lattice, row 0 = north", () => {
  const z = 10;
  // bbox edges strictly between pixel centers: x centers 100.5..110.5 within
  // [100.4, 110.6], y centers 200.5..205.5 within [200.4, 205.6] — avoids
  // knife-edge ceil/floor on inverse-Mercator round-trip error
  const bbox = [globalYToLat(205.6, z), globalXToLon(100.4, z),
    globalYToLat(200.4, z), globalXToLon(110.6, z)];
  const win = pixelWindow(bbox, z);
  assert.deepEqual(
    { gx0: win.gx0, gy0: win.gy0, gw: win.gw, gh: win.gh },
    { gx0: 100, gy0: 200, gw: 11, gh: 6 });
  assert.ok(globalXToLon(win.gx0 + 0.5, z) >= bbox[1] - 1e-9);
  assert.ok(globalXToLon(win.gx0 + win.gw - 1 + 0.5, z) <= bbox[3] + 1e-9);
  assert.ok(globalYToLat(win.gy0 + 0.5, z) <= bbox[2] + 1e-9);
  assert.ok(globalYToLat(win.gy0 + win.gh - 1 + 0.5, z) >= bbox[0] - 1e-9);
});

test("pixelWindow: sub-pixel bbox yields an empty window (caller must guard)", () => {
  const z = 5;
  const win = pixelWindow([10, globalXToLon(50.6, z), 10.001, globalXToLon(50.9, z)], z);
  assert.ok(win.gw <= 0 || win.gh <= 0);
});
