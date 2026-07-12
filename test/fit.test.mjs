import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  roundHalfEven, splits, metersPerDegree, bboxExtentMeters,
  fit, suggestScale, polygonAreaMeters, floorMmPerKm, fmtMmPerKm,
} from "../js/fit.js";

const golden = JSON.parse(
  readFileSync(new URL("./reference/expected.json", import.meta.url)),
);
const rect = ([s, w, n, e]) => [[s, w], [s, e], [n, e], [n, w]];

test("splits matches topotile exactly (incl. banker's-rounding ties)", () => {
  for (const [key, expected] of Object.entries(golden.splits)) {
    const [n, size] = key.split(",").map(Number);
    assert.deepEqual(splits(n, size), expected, `splits(${n},${size})`);
  }
});

test("roundHalfEven matches Python round()", () => {
  for (const [v, expected] of Object.entries(golden.round)) {
    assert.equal(roundHalfEven(Number(v)), expected, `round(${v})`);
  }
});

test("splits share edges and cover the range", () => {
  for (const [n, size] of [[2, 6], [3, 100], [4, 15], [1, 10]]) {
    const sp = splits(n, size);
    assert.equal(sp[0][0], 0);
    assert.equal(sp[sp.length - 1][1], size - 1);
    for (let k = 1; k < sp.length; k++) {
      assert.equal(sp[k][0], sp[k - 1][1], "adjacent spans must share a boundary index");
    }
  }
});

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

test("fit: scale sets size, size sets tiles ≤ cap, scale round-trips", () => {
  const poly = rect(golden.extents.rainier.bbox);
  const f = fit({ polygon: poly, scale: 40000, capW: 250, capH: 250 });
  // width_mm = realW*1000/scale ; invert to recover scale
  assert.ok(Math.abs(f.realW * 1000 / f.widthMm - 40000) < 1e-6);
  assert.ok(f.tileWmm <= 250 + 1e-9 && f.tileHmm <= 250 + 1e-9, "tiles within cap");
  assert.equal(f.nx, Math.ceil(f.widthMm / 250));
  assert.equal(f.ny, Math.ceil(f.heightMm / 250));
});

test("fit: every preset at its suggested scale is a single ≤cap tile", () => {
  for (const [name, { bbox }] of Object.entries(golden.extents)) {
    const poly = rect(bbox);
    const { realW, realH } = bboxExtentMeters(bbox);
    const scale = suggestScale(realW, realH);
    const f = fit({ polygon: poly, scale });
    assert.equal(f.nx * f.ny, 1, `${name} should start as one tile`);
    assert.ok(Math.max(f.tileWmm, f.tileHmm) <= 250, `${name} within bed`);
  }
});

test("fit: finer scale forces more tiles and flags data-limited detail", () => {
  const poly = rect(golden.extents.rainier.bbox);
  const coarse = fit({ polygon: poly, scale: 120000 });
  const fine = fit({ polygon: poly, scale: 15000 });
  assert.ok(fine.nx * fine.ny > coarse.nx * coarse.ny, "finer scale -> more tiles");
  // at 1:15000, 0.2mm print = 3m ground < 10m posting -> clamped
  assert.ok(fine.dataLimited, "fine scale should be data-limited");
  assert.ok(!coarse.dataLimited, "coarse scale not data-limited");
});

test("coverage: rectangle is ~100%, half-triangle is ~50%", () => {
  const [s, w, n, e] = golden.extents.rainier.bbox;
  const bbox = [s, w, n, e];
  const full = polygonAreaMeters(rect(bbox), bbox);
  const { realW, realH } = bboxExtentMeters(bbox);
  assert.ok(Math.abs(full / (realW * realH) - 1) < 1e-6, "rectangle covers bbox");
  const tri = polygonAreaMeters([[s, w], [s, e], [n, w]], bbox);
  assert.ok(Math.abs(tri / (realW * realH) - 0.5) < 1e-6, "triangle covers half");
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
});
