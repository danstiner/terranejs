import { test } from "node:test";
import assert from "node:assert/strict";
import { pointInPolygon } from "../js/polyclip.js";
import { buildPreviewSolid, buildTrailShell, buildSolid as buildSolidIdx } from "../js/mesh.js";
import { signedVolume as volIdx, checkWatertight as wtIdx } from "../js/validate.js";

// Soup-form closed-manifold check (quantize verts, count directed edges).
// buildPreviewSolid still emits an undeduped triangle soup, not an indexed
// mesh, so validate.js's index-based checkWatertight doesn't apply here.
function checkWatertight(tris, eps = 1e-4) {
  const q = (x) => Math.round(x / eps);
  const vid = (x, y, z) => `${q(x)},${q(y)},${q(z)}`;
  const edges = new Map();
  const bump = (a, b) => edges.set(`${a}|${b}`, (edges.get(`${a}|${b}`) || 0) + 1);
  for (let i = 0; i < tris.length; i += 9) {
    const A = vid(tris[i], tris[i + 1], tris[i + 2]);
    const B = vid(tris[i + 3], tris[i + 4], tris[i + 5]);
    const C = vid(tris[i + 6], tris[i + 7], tris[i + 8]);
    bump(A, B); bump(B, C); bump(C, A);
  }
  let unmatched = 0;
  for (const [k, cnt] of edges) {
    const [a, b] = k.split("|");
    const rev = edges.get(`${b}|${a}`) || 0;
    if (cnt !== rev) unmatched++;
  }
  return { closed: unmatched === 0, unmatched };
}

test("pointInPolygon: square", () => {
  const sq = [[0, 0], [0, 10], [10, 10], [10, 0]];
  assert.ok(pointInPolygon([5, 5], sq));
  assert.ok(!pointInPolygon([-1, 5], sq));
  assert.ok(!pointInPolygon([5, 20], sq));
});

const PGEOM = { dx: 10, dy: 10, offX: 0, offY: 0, mmPerM: 1, erange: 1, exag: 1 };

test("buildPreviewSolid: full rectangle is a watertight solid with matching colors", () => {
  const gw = 4, gh = 3;
  const grid = new Float32Array(gw * gh).fill(100);
  const mask = new Uint8Array((gw - 1) * (gh - 1)).fill(1);
  const t = buildPreviewSolid(grid, gw, gh, { r0: 0, r1: gh - 1, c0: 0, c1: gw - 1 }, mask,
    { ...PGEOM, emin: 100, base: 3 });
  // top + base (2 tris/cell each) + skirt (2 tris/boundary edge)
  const cells = (gw - 1) * (gh - 1), bedges = 2 * (gw - 1) + 2 * (gh - 1);
  assert.equal(t.triangles, 4 * cells + 2 * bedges);
  assert.equal(t.colors.length, t.positions.length);
  assert.ok(checkWatertight(t.positions).closed, "preview solid should be closed");
});

test("buildPreviewSolid: base sits at z=0, top at base+relief", () => {
  const gw = 3, gh = 3;
  const grid = new Float32Array(gw * gh).fill(5); // flat 5 m relief
  const mask = new Uint8Array((gw - 1) * (gh - 1)).fill(1);
  const t = buildPreviewSolid(grid, gw, gh, { r0: 0, r1: 2, c0: 0, c1: 2 }, mask,
    { ...PGEOM, emin: 0, base: 3 });
  let zmin = Infinity, zmax = -Infinity;
  for (let i = 2; i < t.positions.length; i += 3) { zmin = Math.min(zmin, t.positions[i]); zmax = Math.max(zmax, t.positions[i]); }
  assert.equal(zmin, 0);        // base plate back
  assert.equal(zmax, 3 + 5);    // base + relief*mmPerM*exag
});

test("buildPreviewSolid: masked-out cells are skipped", () => {
  const gw = 3, gh = 3;
  const grid = new Float32Array(gw * gh).fill(0);
  const full = new Uint8Array([1, 1, 1, 1]);
  const one = new Uint8Array([1, 0, 0, 0]);
  const a = buildPreviewSolid(grid, gw, gh, { r0: 0, r1: 2, c0: 0, c1: 2 }, full, { ...PGEOM, emin: 0, base: 0 });
  const b = buildPreviewSolid(grid, gw, gh, { r0: 0, r1: 2, c0: 0, c1: 2 }, one, { ...PGEOM, emin: 0, base: 0 });
  assert.ok(b.triangles < a.triangles, "fewer covered cells -> fewer triangles");
});

test("buildTrailShell: watertight constant-thickness shell hugging the terrain", () => {
  const gw = 5, gh = 4, dx = 2, dy = 2;
  const grid = new Float32Array(gw * gh);
  for (let r = 0; r < gh; r++)
    for (let c = 0; c < gw; c++) grid[r * gw + c] = 100 + 3 * c + 2 * (gh - 1 - r); // ramp
  const cw = gw - 1;
  const mask = new Uint8Array(cw * (gh - 1));
  for (let c = 0; c < cw; c++) mask[1 * cw + c] = 1; // one row of cells across the middle
  const span = { r0: 0, r1: gh - 1, c0: 0, c1: gw - 1 };
  const mmPerM = 0.01, exag = 2, emin = 100, h = 0.6, k = mmPerM * exag;

  const solid = buildTrailShell(grid, gw, gh, span, mask, { dx, dy, mmPerM, emin, exag }, h);

  const w = wtIdx(solid);
  assert.ok(w.closed, `unmatched edges: ${w.unmatched}`);
  assert.ok(volIdx(solid) > 0, "outward-wound (not inside-out)");

  // group z by printed (x,y): every point has a top (relief+h) and a bottom (relief)
  const P = solid.positions;
  const byXY = new Map();
  for (let i = 0; i < P.length; i += 3) {
    const key = `${P[i].toFixed(3)}_${P[i + 1].toFixed(3)}`;
    const e = byXY.get(key) || { lo: Infinity, hi: -Infinity };
    e.lo = Math.min(e.lo, P[i + 2]); e.hi = Math.max(e.hi, P[i + 2]);
    byXY.set(key, e);
  }
  let checked = 0;
  for (const { lo, hi } of byXY.values()) {
    assert.ok(Math.abs((hi - lo) - h) < 1e-4, `thickness ${hi - lo} vs ${h}`);
    checked++;
  }
  assert.equal(checked, 10, "footprint vertices covered");

  // underside at grid vertex (row 1, col 2) == terrain relief there
  const vid = 1 * gw + 2;
  const bx = (2 - span.c0) * dx, by = (span.r1 - 1) * dy;
  const rel = (grid[vid] - emin) * k;
  const e = byXY.get(`${bx.toFixed(3)}_${by.toFixed(3)}`);
  assert.ok(e && Math.abs(e.lo - rel) < 1e-4, `underside ${e && e.lo} vs relief ${rel}`);
});

function flatGrid(gw, gh, z = 2) {
  return { grid: new Float32Array(gw * gh).fill(z), gw, gh };
}
const GEOM = { dx: 1, dy: 1, mmPerM: 1, emin: 0, exag: 1, base: 1 };

test("flat base: full rectangle uses a fan, not a mirror", () => {
  const { grid, gw, gh } = flatGrid(9, 7);
  const mask = new Uint8Array((gw - 1) * (gh - 1)).fill(1);
  const m = buildSolidIdx(grid, gw, gh, { r0: 0, r1: gh - 1, c0: 0, c1: gw - 1 }, mask, GEOM);
  assert.ok(wtIdx(m).closed);
  // 8×6 cells → 96 top tris; mirrored base would double it. Fan base = rim
  // count (~28) + skirt (~56): well under 2× top.
  const nTop = 96;
  assert.ok(m.indices.length / 3 < 2 * nTop, `tris ${m.indices.length / 3}`);
  assert.ok(Math.abs(volIdx(m) - 8 * 6 * (1 + 2)) < 1e-3); // (base+z) × area
});

test("flat base: two-island mask closes with two loops", () => {
  const { grid, gw, gh } = flatGrid(11, 5);
  const mask = new Uint8Array((gw - 1) * (gh - 1));
  for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) mask[r * 10 + c] = 1; // island A
  for (let r = 0; r < 4; r++) for (let c = 6; c < 10; c++) mask[r * 10 + c] = 1; // island B
  const m = buildSolidIdx(grid, gw, gh, { r0: 0, r1: gh - 1, c0: 0, c1: gw - 1 }, mask, GEOM);
  assert.ok(wtIdx(m).closed, `unmatched ${wtIdx(m).unmatched}`);
  assert.ok(Math.abs(volIdx(m) - (12 + 16) * 3) < 1e-3);
});

test("flat base: U-shaped rim (centroid in the notch) ear-clips flat", () => {
  // 24×12 cells minus an 8×8 notch from the top middle. The rim's
  // vertex-average centroid lands at (12, ~5.64) — inside the notch, outside
  // the polygon — so the centroid fan must fail and earclip must cover the
  // base. Mirror fallback would emit ≥ 2× top tris; flat earclip stays under.
  const { grid, gw, gh } = flatGrid(25, 13);
  const cw = gw - 1;
  const mask = new Uint8Array(cw * (gh - 1)).fill(1);
  for (let r = 0; r < 8; r++) for (let c = 8; c < 16; c++) mask[r * cw + c] = 0;
  const m = buildSolidIdx(grid, gw, gh, { r0: 0, r1: gh - 1, c0: 0, c1: cw }, mask, GEOM);
  assert.ok(wtIdx(m).closed, `unmatched ${wtIdx(m).unmatched}`);
  const nTop = 2 * (24 * 12 - 64); // 448
  assert.ok(m.indices.length / 3 < 2 * nTop, `tris ${m.indices.length / 3} (mirror ≥ ${2 * nTop})`);
  assert.ok(Math.abs(volIdx(m) - (24 * 12 - 64) * 3) < 1e-3); // (base+z) × area
});

test("flat base: donut footprint falls back to mirror and stays closed", () => {
  const { grid, gw, gh } = flatGrid(9, 9);
  const mask = new Uint8Array(64).fill(1);
  mask[3 * 8 + 3] = mask[3 * 8 + 4] = mask[4 * 8 + 3] = mask[4 * 8 + 4] = 0; // hole
  const m = buildSolidIdx(grid, gw, gh, { r0: 0, r1: 8, c0: 0, c1: 8 }, mask, GEOM);
  assert.ok(wtIdx(m).closed, `unmatched ${wtIdx(m).unmatched}`);
  assert.ok(Math.abs(volIdx(m) - (64 - 4) * 3) < 1e-3);
});
