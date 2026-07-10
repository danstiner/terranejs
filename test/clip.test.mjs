import { test } from "node:test";
import assert from "node:assert/strict";
import { clipTriangleToPolygon, pointInPolygon } from "../js/clip.js";
import { buildSolidFromMesh } from "../js/mesh.js";
import { decimate } from "../js/decimate.js";
import { checkWatertight, signedVolume } from "../js/validate.js";

const SQUARE = [[0, 0], [10, 0], [10, 10], [0, 10]];
const triArea = (f, o) =>
  Math.abs((f[o + 3] - f[o]) * (f[o + 7] - f[o + 1]) - (f[o + 4] - f[o + 1]) * (f[o + 6] - f[o])) / 2;
const sumArea = (f) => { let a = 0; for (let o = 0; o < f.length; o += 9) a += triArea(f, o); return a; };
const shoelace = (r) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return Math.abs(a) / 2; };

test("pointInPolygon: square", () => {
  assert.ok(pointInPolygon(5, 5, SQUARE));
  assert.ok(!pointInPolygon(15, 5, SQUARE));
});

test("triangle fully inside is kept whole, z preserved", () => {
  const tri = [[2, 2, 5], [8, 2, 6], [5, 8, 7]];
  const f = clipTriangleToPolygon(tri, SQUARE);
  assert.equal(f.length, 9);
  assert.deepEqual([...f], [2, 2, 5, 8, 2, 6, 5, 8, 7]);
});

test("triangle fully outside is dropped", () => {
  assert.equal(clipTriangleToPolygon([[20, 20, 0], [25, 20, 0], [22, 25, 0]], SQUARE).length, 0);
});

test("straddling triangle: clipped area = triangle ∩ square", () => {
  // [8,2],[14,2],[8,8] cut at x=10 -> quad (8,2),(10,2),(10,6),(8,8), area 10
  const got = sumArea(clipTriangleToPolygon([[8, 2, 0], [14, 2, 0], [8, 8, 0]], SQUARE));
  assert.ok(Math.abs(got - 10) < 1e-6, `clipped area ${got} != 10`);
});

test("area is conserved clipping a triangulation to a NON-convex polygon (multi-piece)", () => {
  // a C/U shape with a deep notch -> forces multi-piece triangles. Grid offset
  // off the axis-aligned edges (real boundaries never coincide exactly with the
  // grid); the small residual is dropped bridge-slivers on multi-piece tiles.
  const U = [[0, 0], [10, 0], [10, 10], [7, 10], [7, 3], [3, 3], [3, 10], [0, 10]];
  let total = 0;
  const N = 20;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const g = (a) => (a * 10) / N + 0.0137;
    const A = [g(i), g(j), 0], B = [g(i + 1), g(j), 0], C = [g(i), g(j + 1), 0], D = [g(i + 1), g(j + 1), 0];
    total += sumArea(clipTriangleToPolygon([A, B, C], U));
    total += sumArea(clipTriangleToPolygon([B, D, C], U));
  }
  const rel = Math.abs(total - shoelace(U)) / shoelace(U);
  assert.ok(rel < 0.01, `area off ${(rel * 100).toFixed(2)}% (multi-piece mishandled?)`);
});

test("clip vertex z lies on the source triangle's sloped plane", () => {
  // a triangle sloping in x, clipped by x<=10; the cut edge vertices at x=10
  // must have z = plane(10) = interpolated, not an original vertex z
  const tri = [[8, 2, 0], [14, 2, 60], [8, 8, 0]]; // z rises with x from 8->14 (0->60)
  const f = clipTriangleToPolygon(tri, SQUARE);
  let sawCut = false;
  for (let o = 0; o < f.length; o += 3) {
    if (Math.abs(f[o] - 10) < 1e-6) { // vertex at x=10 -> z should be (10-8)/6*60 = 20
      assert.ok(Math.abs(f[o + 2] - 20) < 1e-3, `cut z ${f[o + 2]} != 20`);
      sawCut = true;
    }
  }
  assert.ok(sawCut, "expected a cut vertex at x=10");
});

test("clipped decimated mesh assembles into a watertight solid", () => {
  // wavy non-convex polygon + a triangulated terrain -> clip -> solid
  const poly = [];
  for (let a = 0; a < 32; a++) {
    const t = (a / 32) * Math.PI * 2;
    const r = 70 + 18 * Math.sin(3 * t);
    poly.push([100 + r * Math.cos(t), 100 + r * Math.sin(t)]);
  }
  const zf = (x, y) => 3 + 15 * Math.exp(-(((x - 100) / 40) ** 2 + ((y - 100) / 40) ** 2));
  const top = [];
  const N = 50;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const g = (a) => (a * 200) / N;
    const v = (x, y) => [x, y, zf(x, y)];
    const A = v(g(i), g(j)), B = v(g(i + 1), g(j)), C = v(g(i), g(j + 1)), D = v(g(i + 1), g(j + 1));
    for (const n of clipTriangleToPolygon([A, B, C], poly)) top.push(n);
    for (const n of clipTriangleToPolygon([B, D, C], poly)) top.push(n);
  }
  const solid = buildSolidFromMesh(top);
  const w = checkWatertight(solid);
  assert.ok(w.closed, `not watertight: ${w.unmatched} unmatched edges`);
  assert.ok(signedVolume(solid) > 0, "positive (outward) volume");
});

test("real export path: decimate -> clip -> solid is watertight and stays sparse", () => {
  // mirrors clipTileSolid: an adaptive TIN (non-uniform triangles) clipped to a
  // wavy boundary, then assembled. Locks watertightness on real delatin output
  // and that the decimation win survives clipping (few triangles vs the grid).
  const W = 160, H = 160, base = 3;
  const zt = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const r2 = ((x - 80) / 55) ** 2 + ((y - 80) / 55) ** 2;
    zt[y * W + x] = base + 12 * Math.exp(-r2) + 0.5 * Math.sin(x / 9) * Math.cos(y / 11);
  }
  const { coords, triangles } = decimate(zt, W, H, 0.05);
  const gridTris = 2 * (W - 1) * (H - 1);
  assert.ok(triangles.length / 3 < gridTris / 20, "TIN should be far sparser than the grid");

  const poly = [];
  for (let a = 0; a < 40; a++) {
    const t = (a / 40) * Math.PI * 2;
    const r = 62 + 14 * Math.sin(3 * t);
    poly.push([80 + r * Math.cos(t), 80 + r * Math.sin(t)]);
  }
  const vx = (vi) => coords[2 * vi], vy = (vi) => coords[2 * vi + 1];
  const vz = (vi) => zt[coords[2 * vi + 1] * W + coords[2 * vi]];
  const top = [];
  for (let i = 0; i < triangles.length; i += 3) {
    const a = triangles[i], b = triangles[i + 1], c = triangles[i + 2];
    const tri = [[vx(a), vy(a), vz(a)], [vx(b), vy(b), vz(b)], [vx(c), vy(c), vz(c)]];
    for (const v of clipTriangleToPolygon(tri, poly)) top.push(v);
  }
  const solid = buildSolidFromMesh(top);
  const w = checkWatertight(solid);
  assert.ok(w.closed, `not watertight: ${w.unmatched} unmatched edges`);
  assert.ok(signedVolume(solid) > 0, "positive volume");
  assert.ok(solid.indices.length / 3 < gridTris, "clipped solid far smaller than a full-grid solid");
});
