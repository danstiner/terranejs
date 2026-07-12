import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  metersPerDegree, bboxExtentMeters, suggestScale, floorMmPerKm, fmtMmPerKm,
} from "../js/fit.js";

const golden = JSON.parse(
  readFileSync(new URL("./reference/expected.json", import.meta.url)),
);

test("ellipsoidal geodesy matches WGS84 geodesic ground distance (<0.1%)", () => {
  for (const [name, { bbox, realW, realH }] of Object.entries(golden.extents)) {
    const got = bboxExtentMeters(bbox);
    const ew = Math.abs(got.realW - realW) / realW;
    const eh = Math.abs(got.realH - realH) / realH;
    assert.ok(ew < 0.001, `${name} realW off by ${(ew * 100).toFixed(3)}%`);
    assert.ok(eh < 0.001, `${name} realH off by ${(eh * 100).toFixed(3)}%`);
  }
});

test("metersPerDegree: sane at equator", () => {
  const { mLat, mLon } = metersPerDegree(0);
  assert.ok(Math.abs(mLat - 110574) < 200, "lat degree ~110.57 km at equator");
  assert.ok(Math.abs(mLon - 111320) < 200, "lon degree ~111.32 km at equator");
});

test("floorMmPerKm floors to 2 significant figures", () => {
  assert.equal(floorMmPerKm(2.1533), 2.1);
  assert.equal(floorMmPerKm(0.5432), 0.54);
  assert.equal(floorMmPerKm(25), 25);
  assert.equal(floorMmPerKm(99.99), 99);
  assert.equal(floorMmPerKm(2.2), 2.2); // already nice -> unchanged
  assert.equal(floorMmPerKm(100), 100);
});

test("fmtMmPerKm renders <=3 sig figs, no trailing zeros", () => {
  assert.equal(fmtMmPerKm(2.2), "2.2");
  assert.equal(fmtMmPerKm(25), "25");
  assert.equal(fmtMmPerKm(0.55), "0.55");
  assert.equal(fmtMmPerKm(1e6 / 460000), "2.17");
});

test("suggestScale: mm-per-km is 2-sf nice and never overshoots the target", () => {
  for (const [name, { bbox }] of Object.entries(golden.extents)) {
    const { realW, realH } = bboxExtentMeters(bbox);
    const s = suggestScale(realW, realH);
    const mm = 1e6 / s;
    assert.ok(Math.abs(mm - floorMmPerKm(mm)) <= 1e-9 * mm, `${name}: ${mm} not 2-sf nice`);
    const longMm = (Math.max(realW, realH) * 1000) / s;
    assert.ok(longMm <= 240 + 1e-9, `${name}: long side ${longMm} > 240`);
  }
});

test("floorMmPerKm guards degenerate input", () => {
  assert.equal(floorMmPerKm(0), 1);
  assert.equal(floorMmPerKm(-5), 1);
  assert.equal(floorMmPerKm(NaN), 1);
  assert.equal(floorMmPerKm(Infinity), 1);
  assert.equal(suggestScale(0, 0), 1e6); // zero-extent region -> 1 mm = 1 km
});
