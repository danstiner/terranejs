// The corridor's whole correctness rests on one invariant: a lat/lon must land on the same
// print-mm coordinate that buildSolid gives the grid vertex there. Everything else is
// rasterization detail; if this drifts, the cord sits beside the terrain it was measured against.
import { test } from "node:test";
import assert from "node:assert/strict";
import { trailToPrintMm, resample, corridorMask, halfWFor, DS_FACTOR, MIN_CORD_CELLS } from "../src/core/corridor.js";
import { planTile } from "../src/core/pipeline.js";
import { globalXToLon, globalYToLat } from "../src/core/tilemath.js";

const SETTINGS = { center: /** @type {[number, number]} */ ([47.6035, -122.3294]),
  scale: 25000, tileWidthMm: 200, base: 3, exag: 1 };

test("trailToPrintMm agrees with buildSolid's own vertex mapping", () => {
  const plan = planTile(SETTINGS, { maxTiles: 4 });
  const { window: win, span, gw, dx, dy, z } = plan;
  const { c0, r1 } = span;
  // Three interior vertices, well away from the edges.
  for (const [row, col] of [[10, 10], [50, 37], [plan.gh - 12, gw - 9]]) {
    const lat = globalYToLat(win.gy0 + row, z);
    const lon = globalXToLon(win.gx0 + col, z);
    const [poly] = trailToPrintMm([[[lat, lon]]], plan);
    // buildSolid: xy(id) = [((id % gw) - c0) * dx, (r1 - ((id / gw) | 0)) * dy]
    assert.ok(Math.abs(poly[0] - (col - c0) * dx) < 1e-9, `x at ${row},${col}`);
    assert.ok(Math.abs(poly[1] - (r1 - row) * dy) < 1e-9, `y at ${row},${col}`);
  }
});

test("trailToPrintMm keeps segments separate", () => {
  const plan = planTile(SETTINGS, { maxTiles: 4 });
  const out = trailToPrintMm([[[47.60, -122.33], [47.61, -122.33]],
    [[47.62, -122.33], [47.63, -122.33]]], plan);
  assert.equal(out.length, 2);
  assert.equal(out[0].length, 4);
});

test("resample walks uniform arc length across vertices", () => {
  // An L: 10 mm east, then 10 mm north. Spacing must carry across the corner.
  const poly = Float64Array.from([0, 0, 10, 0, 10, 10]);
  const st = resample(poly, 2.5);
  assert.equal(st.length / 2, 9); // 0, 2.5 … 20
  for (let i = 2; i < st.length; i += 2) {
    const d = Math.hypot(st[i] - st[i - 2], st[i + 1] - st[i - 1]);
    // the station straddling the corner is a chord, so it is shorter than ds
    assert.ok(d <= 2.5 + 1e-9, `span ${i / 2} = ${d}`);
  }
  assert.deepEqual([...st.slice(0, 2)], [0, 0]);
});

test("resample survives a repeated point", () => {
  const st = resample(Float64Array.from([0, 0, 0, 0, 5, 0]), 1);
  assert.ok(st.every(Number.isFinite));
  assert.equal(st.length / 2, 6); // 0..5
});

/**
 * Straight trail through the middle of a synthetic grid, at `deg` to the x axis.
 * @param {number} deg @param {number} [gw] @param {number} [pitch] @param {number} [widthMm]
 * @param {Uint8Array} [footprint] @param {number} [halfW] override, default derived from widthMm
 */
function straightMask(deg, gw = 300, pitch = 0.1288, widthMm = 1.6, footprint = undefined,
  halfW = halfWFor(widthMm, pitch)) {
  const plan = { window: { gx0: 0, gy0: 0, gw, gh: gw }, span: { r0: 0, r1: gw - 1, c0: 0, c1: gw - 1 },
    gw, gh: gw, dx: pitch, dy: pitch, z: 15 };
  const a = (deg * Math.PI) / 180, L = gw * pitch * 0.4;
  const cx = (gw * pitch) / 2, cy = cx;
  const poly = Float64Array.from([cx - Math.cos(a) * L, cy - Math.sin(a) * L,
    cx + Math.cos(a) * L, cy + Math.sin(a) * L]);
  return { ...corridorMask([resample(poly, halfW * DS_FACTOR)], /** @type {any} */ (plan), halfW, footprint),
    plan, pitch, cx, cy, a };
}

/**
 * Corridor width at `deg`, as covered AREA over a known length rather than a single slice.
 *
 * A slice is phase-locked to wherever the nearest disc stamp fell, and a lone angle is
 * phase-locked to how the corridor edge happens to land on grid lines — at 0.1288 mm the
 * per-angle spread is 1.544..1.605 mm. Area over a long window, meaned across orientations,
 * is the quantity the design measured and the one the compensation actually controls.
 * @param {number} deg @param {number} gw @param {number} pitch @param {number} halfW @param {number} halfLen
 */
function meanWidth(deg, gw, pitch, halfW, halfLen) {
  const { cells } = straightMask(deg, gw, pitch, undefined, undefined, halfW);
  const a = (deg * Math.PI) / 180, cx = (gw * pitch) / 2, cy = cx;
  const cw = gw - 1, tx = Math.cos(a), ty = Math.sin(a);
  let area = 0;
  for (let r = 0; r < gw - 1; r++) {
    for (let c = 0; c < cw; c++) {
      if (!cells[r * cw + c]) continue;
      // cell center in print mm; row is flipped, as corridorMask and buildSolid both do
      const px = (c + 0.5) * pitch, py = (gw - 1 - (r + 0.5)) * pitch;
      if (Math.abs((px - cx) * tx + (py - cy) * ty) <= halfLen) area += pitch * pitch;
    }
  }
  return area / (2 * halfLen);
}

test("corridor width is within 2% of nominal after erosion compensation", () => {
  // Production pitch, not a finer synthetic one: at 0.02 mm the compensation is 1.8% of the
  // cord and the test barely discriminates. Here it is 11%, and dropping it moves the mean
  // from -1.2% to -10.6%.
  const PITCH = 0.1288, GW = 900, HALF = 10;
  const angles = Array.from({ length: 12 }, (_, i) => i * 15);
  const widths = angles.map((d) => meanWidth(d, GW, PITCH, halfWFor(1.6, PITCH), HALF));
  const mean = widths.reduce((a, b) => a + b, 0) / widths.length;
  assert.ok(Math.abs(mean - 1.6) / 1.6 < 0.02,
    `mean ${mean.toFixed(4)} mm over ${angles.length} orientations`);
});

test("dropping the erosion compensation is caught", () => {
  // The previous test only pins the constant if the constant matters. Without +pitch/sqrt2 the
  // same measurement lands near -10.6%, an order of magnitude outside the bound.
  const PITCH = 0.1288, GW = 900, HALF = 10;
  const angles = Array.from({ length: 12 }, (_, i) => i * 15);
  const widths = angles.map((d) => meanWidth(d, GW, PITCH, 1.6 / 2, HALF));
  const mean = widths.reduce((a, b) => a + b, 0) / widths.length;
  assert.ok(Math.abs(mean - 1.6) / 1.6 > 0.05, `uncompensated mean ${mean.toFixed(4)} mm`);
});

test("no gap along a curved trail at ds = halfW/2", () => {
  const pitch = 0.1288, gw = 400, gh = 400;
  const plan = { window: { gx0: 0, gy0: 0, gw, gh }, span: { r0: 0, r1: gw - 1, c0: 0, c1: gw - 1 },
    gw, gh, dx: pitch, dy: pitch, z: 15 };
  const pts = [];
  for (let t = 0; t <= 1; t += 0.005) pts.push(5 + t * 30, 20 + 6 * Math.sin(t * Math.PI * 2));
  const halfW = halfWFor(1.6, pitch);
  const stations = resample(Float64Array.from(pts), halfW * DS_FACTOR);
  const { cells } = corridorMask([stations], /** @type {any} */ (plan), halfW, undefined);
  const cw = gw - 1;
  for (let i = 2; i < stations.length - 2; i += 2) {
    // mm -> row is flipped on the ROW axis (gh), matching corridorMask's own convention
    const c = Math.floor(stations[i] / pitch), r = Math.floor(gh - 1 - stations[i + 1] / pitch);
    assert.ok(cells[r * cw + c], `gap at station ${i / 2}`);
  }
});

test("out-and-back is idempotent — one cord, not two", () => {
  const pitch = 0.1288, gw = 300;
  const plan = { window: { gx0: 0, gy0: 0, gw, gh: gw }, span: { r0: 0, r1: gw - 1, c0: 0, c1: gw - 1 },
    gw, gh: gw, dx: pitch, dy: pitch, z: 15 };
  const halfW = halfWFor(1.6, pitch);
  const oneWay = Float64Array.from([5, 19.3, 25, 19.3]);
  const back = Float64Array.from([5, 19.3, 25, 19.3, 5, 19.3]);
  const a = corridorMask([resample(oneWay, halfW * DS_FACTOR)], /** @type {any} */ (plan), halfW, undefined);
  const b = corridorMask([resample(back, halfW * DS_FACTOR)], /** @type {any} */ (plan), halfW, undefined);
  // Not bit-exact: resample's arc-length carry runs through the turnaround vertex, so the
  // inbound stations land at a different sub-ds phase than the outbound ones and pick up a
  // few extra boundary cells. A real double-stamp (two interpenetrating cords) would show up
  // as ~2x, not a few percent.
  assert.ok(Math.abs(b.count - a.count) / a.count < 0.1, `${a.count} vs ${b.count}`);
});

test("a footprint mask trims the corridor", () => {
  const gw = 300, pitch = 0.1288;
  const footprint = new Uint8Array(gw * gw).fill(1);
  // blank the eastern half at vertex level
  for (let r = 0; r < gw; r++) for (let c = gw >> 1; c < gw; c++) footprint[r * gw + c] = 0;
  const { cells } = straightMask(0, gw, pitch, 1.6, footprint);
  const cw = gw - 1;
  for (let r = 0; r < gw - 1; r++)
    for (let c = gw >> 1; c < cw; c++) assert.equal(cells[r * cw + c], 0, `cell ${r},${c} escaped`);
});

// Every other test in this file uses planTile's own span (c0=0, r1=gh-1), so a hardcoded
// inverse would agree with the real one by coincidence. This pins the inverse itself against a
// span that disagrees on both axes — the case a future sub-window span would actually exercise.
test("corridorMask inverts a non-trivial span the same way trailToPrintMm's forward map uses it", () => {
  const gw = 60, gh = 60, dx = 1, dy = 1;
  const span = { r0: 0, r1: 44, c0: 10, c1: 54 }; // c0 != 0, r1 != gh - 1
  const plan = { window: { gx0: 0, gy0: 0, gw, gh }, span, gw, gh, dx, dy, z: 15 };
  const row = 20, col = 30;
  // Forward map trailToPrintMm/buildSolid use: x = (col-c0)*dx, y = (r1-row)*dy.
  const station = Float64Array.from([(col - span.c0) * dx, (span.r1 - row) * dy]);
  const { cells } = corridorMask([station], /** @type {any} */ (plan), 1.5, undefined);
  const cw = gw - 1;
  assert.equal(cells[row * cw + col], 1, "cell at the true (row,col) must be lit");
  // A hardcoded c0=0/r1=gh-1 inverse lands the stamp 15 rows south and 10 cols west of here —
  // confirm that spot stayed clean, so the fix isn't just lighting up everything.
  assert.equal(cells[(row + 15) * cw + (col - 10)] ?? 0, 0, "the pre-fix (wrong) location must stay unstamped");
});

test("halfWFor compensates for cell-mask erosion", () => {
  assert.ok(Math.abs(halfWFor(1.6, 0.1288) - (0.8 + 0.1288 / Math.SQRT2)) < 1e-12);
});

/** 4-connected component count over a cw x ch cell mask. 4-, not 8-, connectivity: two cells
 * touching only at a corner share zero printable width, so a corner touch is exactly the
 * "beaded" failure this exists to catch, not a connection.
 * @param {Uint8Array} cells @param {number} cw @param {number} ch */
function countComponents(cells, cw, ch) {
  const seen = new Uint8Array(cells.length);
  let n = 0;
  for (let i = 0; i < cells.length; i++) {
    if (!cells[i] || seen[i]) continue;
    n++;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const k = /** @type {number} */ (stack.pop());
      const r = (k / cw) | 0, c = k % cw;
      if (r > 0 && cells[k - cw] && !seen[k - cw]) { seen[k - cw] = 1; stack.push(k - cw); }
      if (r < ch - 1 && cells[k + cw] && !seen[k + cw]) { seen[k + cw] = 1; stack.push(k + cw); }
      if (c > 0 && cells[k - 1] && !seen[k - 1]) { seen[k - 1] = 1; stack.push(k - 1); }
      if (c < cw - 1 && cells[k + 1] && !seen[k + 1]) { seen[k + 1] = 1; stack.push(k + 1); }
    }
  }
  return n;
}

// MIN_CORD_CELLS exists because a beaded corridor is invisible to every check downstream: each
// island is its own valid closed manifold, so checkWatertight and signedVolume both pass and the
// print comes out as a dotted line. 45 degrees is the angle a sweep over 24 orientations found
// worst (170 disconnected islands at 1 cell, measured directly against this corridorMask), so
// it's used here rather than an angle that happens not to bead.
test("below MIN_CORD_CELLS the corridor beads into islands; at the guard it stays one cord", () => {
  const gw = 300, pitch = 0.1288;
  const cw = gw - 1;
  const beaded = straightMask(45, gw, pitch, 1 * pitch).cells;         // 1 cell: below the guard
  const guarded = straightMask(45, gw, pitch, MIN_CORD_CELLS * pitch).cells;
  assert.ok(countComponents(beaded, cw, cw) > 1,
    "a 1-cell-wide cord must bead — the failure MIN_CORD_CELLS exists to prevent");
  assert.equal(countComponents(guarded, cw, cw), 1,
    `MIN_CORD_CELLS=${MIN_CORD_CELLS} must produce one connected cord, not islands`);
});
