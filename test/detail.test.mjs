import { test } from "node:test";
import assert from "node:assert/strict";
import { detailMap, DETAIL_RADIUS } from "../src/core/detail.js";

/** @param {number} gw @param {number} gh @param {(c: number, r: number) => number} f */
const build = (gw, gh, f) => {
  const g = new Float32Array(gw * gh);
  for (let r = 0; r < gh; r++) for (let c = 0; c < gw; c++) g[r * gw + c] = f(c, r);
  return g;
};
/** Interior mean, skipping the border ring the curvature pass can't reach.
 * @param {Float32Array} m @param {number} gw @param {number} gh @param {number} [pad] */
const core = (m, gw, gh, pad = DETAIL_RADIUS + 1) => {
  let s = 0, n = 0;
  for (let r = pad; r < gh - pad; r++) for (let c = pad; c < gw - pad; c++) { s += m[r * gw + c]; n++; }
  return s / n;
};

// The property the overlay rests on: interpolation between distant samples is locally straight
// whatever its slope, so a tilted plane (300 m of relief here) must read zero detail — else
// every steep hillside would be painted as data.
test("detailMap: a plane reads zero detail at any slope", () => {
  const gw = 40, gh = 40;
  for (const [a, b] of [[0, 0], [3, 0], [0, 7], [5, -2]]) {
    const m = detailMap(build(gw, gh, (c, r) => 100 + a * c + b * r), gw, gh);
    assert.ok(core(m, gw, gh) < 1e-4, `slope ${a},${b}: got ${core(m, gw, gh)}`);
  }
});

test("detailMap: fine structure reads high, and scales with its amplitude", () => {
  const gw = 40, gh = 40;
  const small = detailMap(build(gw, gh, (c, r) => ((c + r) % 2) * 1), gw, gh);
  const big = detailMap(build(gw, gh, (c, r) => ((c + r) % 2) * 10), gw, gh);
  assert.ok(core(small, gw, gh) > 0.5, `checkerboard should read high: ${core(small, gw, gh)}`);
  assert.ok(Math.abs(core(big, gw, gh) / core(small, gw, gh) - 10) < 1e-3, "linear in amplitude");
});

// The discrimination the overlay exists for, in miniature: identical relief on both halves,
// but the left is lerped from a lattice 8 cells apart — the lidar-boundary case as a fixture.
test("detailMap: separates interpolated ground from ground with real structure", () => {
  const gw = 80, gh = 40;
  const grid = build(gw, gh, (c, r) => {
    const base = 40 * Math.sin(c / 9) + 30 * Math.cos(r / 7); // shared long-wavelength relief
    if (c < gw / 2) {
      // interpolated: sample the SAME relief every 8 cells and lerp between those samples
      const c0 = Math.floor(c / 8) * 8, t = (c - c0) / 8;
      const at = (/** @type {number} */ x) => 40 * Math.sin(x / 9) + 30 * Math.cos(r / 7);
      return at(c0) * (1 - t) + at(c0 + 8) * t;
    }
    return base + 3 * Math.sin(c * 2.1) * Math.cos(r * 1.7); // plus genuine fine texture
  });
  const m = detailMap(grid, gw, gh);
  let lo = 0, nlo = 0, hi = 0, nhi = 0;
  for (let r = 8; r < gh - 8; r++) {
    for (let c = 8; c < gw / 2 - 8; c++) { lo += m[r * gw + c]; nlo++; }
    for (let c = gw / 2 + 8; c < gw - 8; c++) { hi += m[r * gw + c]; nhi++; }
  }
  const ratio = (hi / nhi) / (lo / nlo);
  assert.ok(ratio > 4, `real structure should read several times the interpolated half, got ${ratio.toFixed(1)}x`);
});

test("detailMap: shape, finiteness, and non-negativity", () => {
  const gw = 17, gh = 23;
  const m = detailMap(build(gw, gh, (c, r) => Math.sin(c) * Math.cos(r) * 50), gw, gh);
  assert.equal(m.length, gw * gh);
  assert.equal(m.constructor, Float32Array);
  for (const v of m) assert.ok(Number.isFinite(v) && v >= 0, `bad value ${v}`);
});

// The blur divides by the window actually inside the grid; a full-width divisor would darken
// every edge into what looks exactly like a data problem.
test("detailMap: edges are not darkened by the window running off the grid", () => {
  const gw = 40, gh = 40;
  const m = detailMap(build(gw, gh, (c, r) => ((c + r) % 2) * 10), gw, gh);
  const mid = m[20 * gw + 20];
  const edge = m[20 * gw + (DETAIL_RADIUS + 1)];
  assert.ok(edge > 0.8 * mid, `edge ${edge} should be comparable to interior ${mid}`);
});

// A tiny grid must not read past its own bounds; radius exceeds the grid on both axes here.
test("detailMap: a grid smaller than the window still returns finite values", () => {
  const gw = 3, gh = 3;
  const m = detailMap(build(gw, gh, (c, r) => c * 10 + r), gw, gh, 8);
  assert.equal(m.length, 9);
  for (const v of m) assert.ok(Number.isFinite(v), `bad value ${v}`);
});
