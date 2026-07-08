import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeTerrarium } from "../js/terrain.js";
import { groundResolution, pickZoom, lonToGlobalX, latToGlobalY, tileRangeForBBox }
  from "../js/tilemath.js";

test("decodeTerrarium: (R*256+G+B/256)-32768", () => {
  // 32768 -> 0 m ; encode 0 m: R=128,G=0,B=0 -> 128*256-32768 = 0
  const rgba = new Uint8ClampedArray([128, 0, 0, 255, 128, 100, 128, 255]);
  const el = decodeTerrarium(rgba);
  assert.equal(el[0], 0);
  assert.ok(Math.abs(el[1] - (100 + 128 / 256)) < 1e-6); // 100.5 m
});

test("decodeTerrarium: below sea level (bathymetry) is negative", () => {
  const rgba = new Uint8ClampedArray([127, 0, 0, 255]); // 127*256-32768 = -256
  assert.equal(decodeTerrarium(rgba)[0], -256);
});

test("groundResolution: ~156.543 km/px at z0 equator, halves per zoom", () => {
  assert.ok(Math.abs(groundResolution(0, 0) - 156543.03392) < 1e-3);
  assert.ok(Math.abs(groundResolution(0, 1) - 156543.03392 / 2) < 1e-3);
});

test("pickZoom: matches target resolution, flags upsampling", () => {
  // at 47°N want ~6.5 m/px -> z14 (6.53 m); asking for 1 m/px is beyond z15 -> upsampled
  const a = pickZoom(6.5, 47);
  assert.equal(a.z, 14);
  assert.ok(!a.upsampled);
  const b = pickZoom(1, 47);
  assert.equal(b.z, 15);
  assert.ok(b.upsampled);
});

test("global pixel coords: corners of the world map", () => {
  assert.equal(lonToGlobalX(-180, 0), 0);
  assert.equal(lonToGlobalX(180, 0), 256);
  assert.ok(Math.abs(latToGlobalY(0, 0) - 128) < 1e-6); // equator = middle
});

test("tileRangeForBBox: covers the bbox with a halo, sane count", () => {
  const r = tileRangeForBBox([46.75, -121.85, 46.92, -121.65], 12);
  assert.ok(r.tx1 >= r.tx0 && r.ty1 >= r.ty0);
  assert.equal(r.count, (r.tx1 - r.tx0 + 1) * (r.ty1 - r.ty0 + 1));
  // a ~15 km bbox at z12 (~19 m/px) spans a handful of 256-px tiles, not hundreds
  assert.ok(r.count < 20);
});
