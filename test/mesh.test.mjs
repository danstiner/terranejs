import { test } from "node:test";
import assert from "node:assert/strict";
import { pointInPolygon, cellMask } from "../js/polyclip.js";
import { buildPreviewSolid } from "../js/mesh.js";
import { checkWatertight } from "../js/stl.js";

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
