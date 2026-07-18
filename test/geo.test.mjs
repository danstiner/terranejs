import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  metersPerDegree, bboxExtentMeters, suggestScale, floorMmPerKm, fmtMmPerKm,
} from "../src/core/geo.js";

const golden = JSON.parse(
  readFileSync(new URL("./reference/expected.json", import.meta.url), "utf8"),
);

test("flat-rate bbox model matches WGS84 geodesics (<1e-6)", () => {
  for (const [name, { bbox, realW, realH }] of Object.entries(golden.extents)) {
    const got = bboxExtentMeters(bbox);
    const ew = Math.abs(got.realW - realW) / realW;
    const eh = Math.abs(got.realH - realH) / realH;
    // The residual is a MODEL gap, not a code bug: realW is the parallel arc vs
    // the golden's geodesic (~sin²φ·Δλ²/24), plus centre-latitude midpoint
    // integration for realH. Measured max ~4e-7 — a real bound on the model.
    assert.ok(ew < 1e-6, `${name} realW off by ${(ew * 100).toFixed(5)}%`);
    assert.ok(eh < 1e-6, `${name} realH off by ${(eh * 100).toFixed(5)}%`);
  }
});

test("metersPerDegree: matches published WGS84 values at 0° and 45°", () => {
  // Independent published metres-per-degree (hand-derivable from a and f; at 45°
  // sin²φ = 1/2 exactly). 45° is load-bearing: at the equator sinφ = 0, so a
  // meridian-vs-prime-vertical radius mixup is invisible — but not here.
  /** @type {(lat: number, mLat: number, mLon: number) => void} */
  const check = (lat, mLat, mLon) => {
    const got = metersPerDegree(lat);
    assert.ok(Math.abs(got.mLat - mLat) < 0.01, `mLat(${lat})=${got.mLat} vs ${mLat}`);
    assert.ok(Math.abs(got.mLon - mLon) < 0.01, `mLon(${lat})=${got.mLon} vs ${mLon}`);
  };
  check(0, 110574.2758, 111319.4908);
  check(45, 111131.7774, 78846.8351);
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
