import { test } from "node:test";
import assert from "node:assert/strict";
import { pointInPolygon, cellMask } from "../js/polyclip.js";
import { buildPreviewSolid, buildTrailShell } from "../js/mesh.js";
import { checkWatertight, signedVolume } from "../js/stl.js";

test("pointInPolygon: square", () => {
  const sq = [[0, 0], [0, 10], [10, 10], [10, 0]];
  assert.ok(pointInPolygon([5, 5], sq));
  assert.ok(!pointInPolygon([-1, 5], sq));
  assert.ok(!pointInPolygon([5, 20], sq));
});

test("cellMask: rectangle covering the whole bbox = all cells in", () => {
  const bbox = [46, -122, 47, -121];
  const rect = [[46, -122], [46, -121], [47, -121], [47, -122]];
  const gw = 6, gh = 5;
  const mask = cellMask(rect, bbox, gw, gh);
  assert.equal(mask.length, (gw - 1) * (gh - 1));
  assert.ok(mask.every((v) => v === 1));
});

test("cellMask: half-plane polygon masks ~half the cells", () => {
  const bbox = [46, -122, 47, -121];
  // western half only
  const half = [[46, -122], [46, -121.5], [47, -121.5], [47, -122]];
  const gw = 21, gh = 21;
  const mask = cellMask(half, bbox, gw, gh);
  const frac = mask.reduce((a, b) => a + b, 0) / mask.length;
  assert.ok(frac > 0.4 && frac < 0.6, `covered ${(frac * 100).toFixed(0)}%`);
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

  const w = checkWatertight(solid);
  assert.ok(w.closed, `unmatched edges: ${w.unmatched}`);
  assert.ok(signedVolume(solid) > 0, "outward-wound (not inside-out)");

  // group z by printed (x,y): every point has a top (relief+h) and a bottom (relief)
  const byXY = new Map();
  for (let i = 0; i < solid.length; i += 3) {
    const key = `${solid[i].toFixed(3)}_${solid[i + 1].toFixed(3)}`;
    const e = byXY.get(key) || { lo: Infinity, hi: -Infinity };
    e.lo = Math.min(e.lo, solid[i + 2]); e.hi = Math.max(e.hi, solid[i + 2]);
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
