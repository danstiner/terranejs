import { test } from "node:test";
import assert from "node:assert/strict";
import { clipTriangleToPolygon, pointInPolygon, footprintClassifier } from "../js/clip.js";
import { buildSolidFromMesh } from "../js/mesh.js";
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

test("clipped triangulated mesh assembles into a watertight solid", () => {
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

test("real export path: grid cells -> classify -> clip -> solid is watertight", () => {
  // mirrors clipTileSolid: full-density grid cells, interior cells kept whole,
  // band cells clipped to a wavy boundary, then assembled
  const W = 96, H = 96, base = 3;
  const zt = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const r2 = ((x - 48) / 33) ** 2 + ((y - 48) / 33) ** 2;
    zt[y * W + x] = base + 12 * Math.exp(-r2) + 0.5 * Math.sin(x / 9) * Math.cos(y / 11);
  }
  const poly = [];
  for (let a = 0; a < 40; a++) {
    const t = (a / 40) * Math.PI * 2;
    const r = 37 + 8 * Math.sin(3 * t);
    poly.push([48 + r * Math.cos(t), 48 + r * Math.sin(t)]);
  }
  const cw = W - 1, ch = H - 1;
  const mask = new Uint8Array(cw * ch);
  for (let r = 0; r < ch; r++)
    for (let c = 0; c < cw; c++) mask[r * cw + c] = pointInPolygon(c + 0.5, r + 0.5, poly) ? 1 : 0;
  const classify = footprintClassifier(mask, cw, ch);
  const top = [];
  const v = (x, y) => [x, y, zt[y * W + x]];
  let nIn = 0, nBand = 0;
  for (let r = 0; r < ch; r++) {
    for (let c = 0; c < cw; c++) {
      const cls = classify(c, r, c, r);
      if (cls === "out") continue;
      if (cls === "in") nIn++; else nBand++;
      const A = v(c, r), B = v(c + 1, r), C = v(c, r + 1), D = v(c + 1, r + 1);
      for (const tri of [[A, B, C], [B, D, C]]) {
        if (cls === "in") top.push(...tri[0], ...tri[1], ...tri[2]);
        else for (const q of clipTriangleToPolygon(tri, poly)) top.push(q);
      }
    }
  }
  assert.ok(nIn > 0 && nBand > 0, `degenerate split in=${nIn} band=${nBand}`);
  const solid = buildSolidFromMesh(top);
  const w = checkWatertight(solid);
  assert.ok(w.closed, `not watertight: ${w.unmatched} unmatched edges`);
  assert.ok(signedVolume(solid) > 0, "positive volume");
});

test("footprintClassifier: 'in'/'out' verdicts are exact vs real clipping", () => {
  const gw = 25, gh = 25;
  const poly = [[3, 3], [21, 5], [19, 20], [10, 22], [2, 15]]; // pentagon, grid units
  const cw = gw - 1, ch = gh - 1;
  const mask = new Uint8Array(cw * ch);
  for (let r = 0; r < ch; r++)
    for (let c = 0; c < cw; c++) mask[r * cw + c] = pointInPolygon(c + 0.5, r + 0.5, poly) ? 1 : 0;
  const classify = footprintClassifier(mask, cw, ch);
  let nIn = 0, nOut = 0, nBand = 0;
  for (let r = 0; r < ch; r++) {
    for (let c = 0; c < cw; c++) {
      const cls = classify(c, r, c, r);
      const A = [c, r, 0], B = [c + 1, r, 0], C = [c, r + 1, 0], D = [c + 1, r + 1, 0];
      for (const tri of [[A, B, C], [B, D, C]]) {
        const clipped = clipTriangleToPolygon(tri, poly);
        if (cls === "in") { nIn++; assert.equal(clipped.length, 9, "'in' facet must survive whole"); }
        else if (cls === "out") { nOut++; assert.equal(clipped.length, 0, "'out' facet must vanish"); }
        else nBand++;
      }
    }
  }
  assert.ok(nIn > 0 && nOut > 0 && nBand > 0, `degenerate split ${nIn}/${nOut}/${nBand}`);
});
