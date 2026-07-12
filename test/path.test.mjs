import { test } from "node:test";
import assert from "node:assert/strict";
import { samplePath, rasterizePath, profileAlong, smoothProfile, stampOffset,
  stampInlay, ribbonGrid } from "../js/path.js";
import { latToGlobalY } from "../js/tilemath.js";
import { cellOcean } from "../js/water.js";
import { buildSolid } from "../js/mesh.js";
import { checkWatertight } from "../js/validate.js";

// 100×100 mm print over a unit bbox: lon/lat map linearly to x/y
const BBOX = [0, 0, 1, 1], W_MM = 100, H_MM = 100;

test("samplePath: uniform spacing along a straight track", () => {
  // diagonal from (10,10) to (70,90) mm -> ~99.996 mm under Mercator y
  const { pts, segStarts } = samplePath([[[0.1, 0.1], [0.9, 0.7]]], BBOX, W_MM, H_MM, 1);
  assert.deepEqual([...segStarts], [0]);
  assert.equal(pts.length / 2, 100, "1 mm steps over ~99.996 mm incl. start");
  for (let j = 1; j < pts.length / 2; j++) {
    const d = Math.hypot(pts[2 * j] - pts[2 * j - 2], pts[2 * j + 1] - pts[2 * j - 1]);
    assert.ok(Math.abs(d - 1) < 1e-4, `step ${j}: ${d}`);
  }
});

test("samplePath: spacing survives polyline vertices and multiple segments", () => {
  const segs = [
    [[0.1, 0.1], [0.1, 0.35], [0.35, 0.35]], // L-shape, 25+25 mm
    [[0.8, 0.8], [0.8, 0.9]], // 10 mm
  ];
  const { pts, segStarts } = samplePath(segs, BBOX, W_MM, H_MM, 2);
  assert.deepEqual([...segStarts], [0, 25]);
  // step across the corner is 2 mm of arc, not 2 mm of chord
  const n0 = 25;
  for (let j = 1; j < n0; j++) {
    const d = Math.hypot(pts[2 * j] - pts[2 * j - 2], pts[2 * j + 1] - pts[2 * j - 1]);
    assert.ok(d <= 2 + 1e-4, `arc step ${j} chord ${d} ≤ ds`);
  }
});

test("rasterizePath: straight band of the right width, sIdx along the track", () => {
  const gw = 51, gh = 51, dx = 2, dy = 2; // 100×100 mm grid
  // horizontal track at y=50 across the full width
  const { pts } = samplePath([[[0.5, 0], [0.5, 1]]], BBOX, W_MM, H_MM, 2);
  const { mask, sIdx } = rasterizePath(pts, gw, gh, dx, dy, 3);
  const rowAt = (ymm) => gh - 1 - ymm / dy;
  for (let c = 1; c < gw - 1; c++) {
    assert.equal(mask[rowAt(50) * gw + c], 1, "centerline row masked");
    assert.equal(mask[rowAt(52) * gw + c], 1, "within halfW");
    assert.equal(mask[rowAt(56) * gw + c], 0, "beyond halfW clear");
  }
  const r = rowAt(50);
  assert.ok(sIdx[r * gw + 10] < sIdx[r * gw + 40], "sample index increases along track");
});

test("rasterizePath: off-grid track marks nothing", () => {
  const { pts } = samplePath([[[2, 2], [2.1, 2.1]]], BBOX, W_MM, H_MM, 2);
  const { mask } = rasterizePath(pts, 11, 11, 10, 10, 3);
  assert.ok(mask.every((v) => v === 0));
});

test("rasterizePath: inner mask is inset from the groove and a strict subset", () => {
  const gw = 51, gh = 51, dx = 2, dy = 2;
  const { pts } = samplePath([[[0.5, 0], [0.5, 1]]], BBOX, W_MM, H_MM, 2);
  const { mask, inner } = rasterizePath(pts, gw, gh, dx, dy, 6, 4); // 6 mm groove, 4 mm ribbon
  let mCount = 0, iCount = 0;
  for (let i = 0; i < mask.length; i++) {
    mCount += mask[i]; iCount += inner[i];
    if (inner[i]) assert.equal(mask[i], 1, "inner vertex is also a groove vertex");
  }
  assert.ok(iCount > 0 && iCount < mCount, `inner (${iCount}) strictly inside groove (${mCount})`);
});

test("rasterizePath: sub-2-cell trail keeps a >=2-cell ribbon chain", () => {
  // pathW 0.8 mm at 0.3 mm pitch: post-hoc erosion used to erase the ribbon
  const dx = 0.3, dy = 0.3, gw = 41, gh = 41;
  const W = (gw - 1) * dx, H = (gh - 1) * dy;
  const { pts } = samplePath([[[0.5, 0.1], [0.5, 0.9]]], [0, 0, 1, 1], W, H, dx);
  const halfW = 0.4;
  const ribbonHalfW = Math.max(halfW - 0.15, 1.6 * dx);
  const grooveHalfW = Math.max(halfW, ribbonHalfW + 0.15);
  const { inner } = rasterizePath(pts, gw, gh, dx, dy, grooveHalfW, ribbonHalfW);
  const cells = cellOcean(inner, gw, gh);
  const cw = gw - 1;
  let widest = 0;
  for (let r = 0; r < gh - 1; r++) {
    let w = 0; for (let c = 0; c < cw; c++) w += cells[r * cw + c];
    widest = Math.max(widest, w);
  }
  assert.ok(widest >= 2, `ribbon chain is >=2 cells wide (got ${widest})`);
});

test("profileAlong: bilinear matches an analytic ramp", () => {
  const gw = 11, gh = 11, dx = 10, dy = 10;
  const grid = new Float32Array(gw * gh);
  for (let r = 0; r < gh; r++) {
    for (let c = 0; c < gw; c++) grid[r * gw + c] = 3 * c * dx + 2 * (gh - 1 - r) * dy;
  }
  const { pts } = samplePath([[[0.13, 0.05], [0.82, 0.91]]], BBOX, W_MM, H_MM, 5);
  const zt = profileAlong(grid, gw, gh, dx, dy, pts);
  for (let j = 0; j < zt.length; j++) {
    const want = 3 * pts[2 * j] + 2 * pts[2 * j + 1];
    assert.ok(Math.abs(zt[j] - want) < 1e-3, `sample ${j}: ${zt[j]} vs ${want}`);
  }
});

test("smoothProfile: slope and curvature bounds hold on spiky terrain", () => {
  const ds = 0.2, n = 1000; // 200 mm route
  const z = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // 20 mm rolling swell + sharp 4 mm-period spikes + a step
    z[i] = 4 * Math.sin((i * ds) / 20) + 2 * Math.sin((i * ds) / 0.6) + (i > n / 2 ? 3 : 0);
  }
  const f = smoothProfile(z, [0], ds, { slopeMax: 0.2, rMin: 100 });
  for (let i = 1; i < n; i++) {
    assert.ok(Math.abs(f[i] - f[i - 1]) / ds <= 0.2 + 1e-6, `slope at ${i}`);
    if (i + 1 < n) {
      assert.ok(Math.abs(f[i + 1] - 2 * f[i] + f[i - 1]) / (ds * ds) <= 0.01 + 1e-6, `curvature at ${i}`);
    }
  }
});

test("smoothProfile: gentle profile passes through nearly unchanged", () => {
  const ds = 0.2, n = 500;
  const z = new Float32Array(n);
  for (let i = 0; i < n; i++) z[i] = 5 + 0.05 * i * ds; // 5% grade
  const f = smoothProfile(z, [0], ds);
  // interior only: the edge-clamped filter flattens the very ends of a ramp
  // (harmless — the ribbon height h absorbs the difference)
  for (let i = 100; i < n - 100; i++) assert.ok(Math.abs(f[i] - z[i]) < 0.05, `sample ${i}`);
});

test("stampOffset raises only masked vertices", () => {
  const grid = Float32Array.from([1, 2, 3, 4]);
  const out = stampOffset(grid, Uint8Array.from([1, 0, 0, 1]), 0.5);
  assert.deepEqual([...out], [1.5, 2, 3, 4.5]);
});

// --- inlay: groove + ribbon seating contract -------------------------------

function inlayFixture() {
  const gw = 41, gh = 21, dx = 2.5, dy = 5; // 100×100 mm
  const K = 0.02, EMIN = 100, GROOVE = 0.8, PROUD = 0.6;
  const grid = new Float32Array(gw * gh);
  for (let r = 0; r < gh; r++) {
    for (let c = 0; c < gw; c++) {
      const x = c * dx;
      // rolling terrain with sharp knolls, in grid units above EMIN
      grid[r * gw + c] = EMIN + (10 + 8 * Math.sin(x / 15) + 5 * Math.max(0, Math.sin(x / 2))) / K;
    }
  }
  // halfW must exceed the coarse fixture grid's dy so the band is ≥2 rows wide
  const { pts, segStarts } = samplePath([[[0.5, 0.05], [0.5, 0.95]]], BBOX, W_MM, H_MM, 2.5);
  const { mask, sIdx } = rasterizePath(pts, gw, gh, dx, dy, 6);
  const ztElev = profileAlong(grid, gw, gh, dx, dy, pts);
  const zrel = Float32Array.from(ztElev, (v) => (v - EMIN) * K);
  const fRel = smoothProfile(zrel, segStarts, 2.5);
  const stamped = stampInlay(grid, mask, sIdx, fRel, GROOVE, EMIN, K);
  const ribbon = ribbonGrid(mask, sIdx, zrel, fRel, GROOVE, PROUD);
  return { gw, gh, dx, dy, K, EMIN, GROOVE, PROUD, grid, mask, sIdx, zrel, fRel, stamped, ribbon };
}

test("inlay: seated ribbon top = max(terrain, mating curve) + proud at every trail vertex", () => {
  const { gw, gh, K, EMIN, GROOVE, PROUD, mask, sIdx, zrel, fRel, stamped, ribbon } = inlayFixture();
  let checked = 0;
  for (let i = 0; i < gw * gh; i++) {
    if (!mask[i]) continue;
    const floorMm = (stamped[i] - EMIN) * K; // groove floor, print mm rel. emin
    const j = sIdx[i];
    assert.ok(Math.abs(floorMm - (fRel[j] - GROOVE)) < 1e-4, "floor = f − groove");
    const seatedTop = floorMm + ribbon[i];
    const want = Math.max(zrel[j], fRel[j]) + PROUD;
    assert.ok(Math.abs(seatedTop - want) < 1e-4, `vertex ${i}: ${seatedTop} vs ${want}`);
    assert.ok(ribbon[i] >= GROOVE + PROUD - 1e-6, "min ribbon thickness");
    checked++;
  }
  assert.ok(checked > 50, `trail covers vertices (${checked})`);
});

test("inlay: ribbon solid is watertight, flat-bottomed, prints as-is", () => {
  const { gw, gh, dx, dy, mask, ribbon, GROOVE, PROUD } = inlayFixture();
  const cells = cellOcean(mask, gw, gh); // cell mask from the trail vertex mask
  const solid = buildSolid(ribbon, gw, gh, { r0: 0, r1: gh - 1, c0: 0, c1: gw - 1 }, cells,
    { dx, dy, mmPerM: 1, emin: 0, exag: 1, base: 0 });
  const w = checkWatertight(solid);
  assert.ok(w.closed, `unmatched edges: ${w.unmatched}`);
  let zmin = Infinity, topMin = Infinity;
  const P = solid.positions;
  for (let i = 2; i < P.length; i += 3) {
    zmin = Math.min(zmin, P[i]);
    if (P[i] > 0) topMin = Math.min(topMin, P[i]);
  }
  assert.equal(zmin, 0, "bottom on the bed");
  assert.ok(topMin >= GROOVE + PROUD - 1e-6, "no thin spots");
});

test("samplePath: y follows Mercator, not linear latitude", () => {
  const bbox = [60, 0, 61, 1], W = 50, H = 100;
  const gyS = latToGlobalY(60, 0), gyN = latToGlobalY(61, 0);
  const yMid = ((gyS - latToGlobalY(60.5, 0)) / (gyS - gyN)) * H;
  assert.ok(Math.abs(yMid - 50) > 0.15, `Mercator midpoint ${yMid} should be measurably off 50`);
  // ds larger than the track: only the first point is emitted -> pure Y probe
  const { pts } = samplePath([[[60.5, 0.2], [60.5, 0.8]]], bbox, W, H, 1000);
  assert.ok(Math.abs(pts[1] - yMid) < 1e-4, `trail lat maps through Mercator (${pts[1]} vs ${yMid})`);
});
