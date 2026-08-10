// The corridor rests on two invariants. One is old: a lat/lon must land on the same print-mm
// coordinate buildSolid gives the grid vertex there, or the cord sits beside the terrain it was
// measured against. The other is new: every cord vertex must lie on the terrain's OWN triangle
// plane, or the underside stops mating with the surface that prints.
import { test } from "node:test";
import assert from "node:assert/strict";
import { trailToPrintMm, chop, subK, subElev, admissibleCells, cordTris, SUB_ACROSS }
  from "../src/core/cord.js";
import { planTile } from "../src/core/pipeline.js";
import { globalXToLon, globalYToLat } from "../src/core/tilemath.js";

const SETTINGS = { center: /** @type {[number, number]} */ ([47.6035, -122.3294]),
  scale: 25000, tileWidthMm: 200, base: 3, exag: 1 };

/** Relief passthrough: z comes out in the grid's own units, so tests read elevations directly. */
const GEOM = { mmPerM: 1, emin: 0, exag: 1 };

/** @param {number} gw @param {number} pitch */
function planOf(gw, pitch) {
  return /** @type {any} */ ({
    window: { gx0: 0, gy0: 0, gw, gh: gw }, span: { r0: 0, r1: gw - 1, c0: 0, c1: gw - 1 },
    gw, gh: gw, dx: pitch, dy: pitch, z: 15,
  });
}

/** @param {number} gw @param {(c: number, r: number) => number} f */
function gridOf(gw, f) {
  const g = new Float32Array(gw * gw);
  for (let r = 0; r < gw; r++) for (let c = 0; c < gw; c++) g[r * gw + c] = f(c, r);
  return g;
}

/** @param {number} n */
const allCells = (n) => new Uint8Array((n - 1) * (n - 1)).fill(1);

/** Total xy area of a triangle soup. @param {{tris: Uint32Array, x: Float64Array, y: Float64Array}} s */
function soupArea(s) {
  let a = 0;
  for (let i = 0; i < s.tris.length; i += 3) {
    const p = s.tris[i], q = s.tris[i + 1], r = s.tris[i + 2];
    a += Math.abs((s.x[q] - s.x[p]) * (s.y[r] - s.y[p]) - (s.x[r] - s.x[p]) * (s.y[q] - s.y[p])) / 2;
  }
  return a;
}

/** Connected components of a triangle soup, over shared vertices.
 * @param {{tris: Uint32Array, x: Float64Array}} s */
function components(s) {
  const parent = new Int32Array(s.x.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  /** @type {(i: number) => number} */
  const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  for (let i = 0; i < s.tris.length; i += 3) {
    parent[find(s.tris[i + 1])] = find(s.tris[i]);
    parent[find(s.tris[i + 2])] = find(s.tris[i]);
  }
  const roots = new Set();
  for (let i = 0; i < s.tris.length; i++) roots.add(find(s.tris[i]));
  return roots.size;
}

/** A straight cord of half-length L about the grid centre, at `deg`, offset `off` mm sideways.
 * @param {number} deg @param {number} widthMm @param {number} gw @param {number} pitch
 * @param {number} [off] @param {Float32Array} [grid] */
function straight(deg, widthMm, gw, pitch, off = 0, grid = gridOf(gw, () => 0)) {
  const plan = planOf(gw, pitch);
  const a = (deg * Math.PI) / 180, L = gw * pitch * 0.3;
  const cx = (gw * pitch) / 2 - Math.sin(a) * off, cy = cx + Math.cos(a) * off;
  const poly = Float64Array.from([cx - Math.cos(a) * L, cy - Math.sin(a) * L,
    cx + Math.cos(a) * L, cy + Math.sin(a) * L]);
  const soup = cordTris(grid, plan, [poly], widthMm, GEOM, allCells(gw));
  return { soup, L: 2 * L, plan, grid };
}

/** A sinusoidal cord across the grid, sampled like a real track. Every angle to the lattice
 * appears along it, so it beads where the axis-parallel and 23° straights in `straight` do not.
 * @param {number} widthMm @param {number} gw @param {number} pitch */
function curved(widthMm, gw, pitch) {
  const span = gw * pitch;
  const pts = Array.from({ length: 40 }, (_, i) => {
    const t = i / 39;
    return [span * (0.15 + 0.7 * t), span * (0.5 + 0.15 * Math.sin(2 * Math.PI * t))];
  }).flat();
  return cordTris(gridOf(gw, () => 0), planOf(gw, pitch), [Float64Array.from(pts)],
    widthMm, GEOM, allCells(gw));
}

/** Width implied by covered area: a capsule of length L and radius r has area 2rL + pi r^2.
 * Area over the whole cord, not a slice — a slice is phase-locked to how the boundary happens
 * to fall on lattice lines, which is exactly the error being measured.
 * @param {number} area @param {number} L */
const widthFromArea = (area, L) => (2 * (-L + Math.sqrt(L * L + Math.PI * area))) / Math.PI;

test("trailToPrintMm agrees with buildSolid's own vertex mapping", () => {
  const plan = planTile(SETTINGS, { maxTiles: 4 });
  const { window: win, span, gw, dx, dy, z } = plan;
  const { c0, r1 } = span;
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

// The reason chop exists rather than arc-length resampling: stations at multiples of ds drop
// the tail, ending the cord short of the trail.
test("chop keeps every original vertex and the exact final endpoint", () => {
  const poly = Float64Array.from([0, 0, 10, 0, 10, 7]);
  const out = chop(poly, 3);
  assert.deepEqual([...out.slice(0, 2)], [0, 0]);
  assert.deepEqual([...out.slice(-2)], [10, 7], "the trail's last point survives exactly");
  const pts = [];
  for (let i = 0; i < out.length; i += 2) pts.push(`${out[i]},${out[i + 1]}`);
  assert.ok(pts.includes("10,0"), "the corner vertex is not smoothed away");
});

test("chop respects maxLen", () => {
  const out = chop(Float64Array.from([0, 0, 10, 0, 10, 7]), 3);
  for (let i = 2; i < out.length; i += 2) {
    assert.ok(Math.hypot(out[i] - out[i - 2], out[i + 1] - out[i - 1]) <= 3 + 1e-9, `span at ${i / 2}`);
  }
});

test("chop survives a repeated point", () => {
  const out = chop(Float64Array.from([0, 0, 0, 0, 5, 0]), 1);
  assert.ok(out.every(Number.isFinite));
  assert.deepEqual([...out.slice(-2)], [5, 0]);
});

// The load-bearing property: the printed surface is piecewise-planar over gridTopTris' two
// triangles, so the cord's vertices must satisfy the plane through the three corners of
// whichever one they fall in. Checked by plane equation, not by re-running the interpolation.
test("subElev lands on the terrain's own triangle plane, both sides of the diagonal", () => {
  const gw = 4;
  const grid = gridOf(gw, (c, r) => 3 * c - 2 * r + 0.5 * c * r); // twisted: zA+zD != zB+zC
  for (const [col, row] of [[1.25, 1.25], [1.75, 1.75], [1.5, 1.5], [1.1, 1.8], [1.9, 1.05]]) {
    const c = Math.floor(col), r = Math.floor(row), u = col - c, v = row - r;
    const A = r * gw + c, B = A + 1, C = A + gw, D = C + 1;
    // corners of the parent triangle, as 3-D points in (col, row, z)
    const tri = u + v <= 1
      ? [[c, r, grid[A]], [c + 1, r, grid[B]], [c, r + 1, grid[C]]]
      : [[c + 1, r, grid[B]], [c, r + 1, grid[C]], [c + 1, r + 1, grid[D]]];
    const [p, q, s] = tri;
    const e1 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const e2 = [s[0] - p[0], s[1] - p[1], s[2] - p[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const z = subElev(grid, gw, gw, col, row);
    const off = n[0] * (col - p[0]) + n[1] * (row - p[1]) + n[2] * (z - p[2]);
    assert.ok(Math.abs(off) < 1e-9, `(${col},${row}) is ${off} off its triangle's plane`);
  }
});

// Bilinear is a saddle, the printed surface is two planes; they part company by
// (zB + zC - zA - zD)/4 at the cell centre. Sampling the wrong one is what makes a cord
// float or dig in, and nothing downstream would notice.
test("subElev is the triangle plane, not bilinear", () => {
  const gw = 3;
  const grid = gridOf(gw, (c, r) => (c === 1 && r === 1 ? 0 : 0) + (c + r === 1 ? 4 : 0));
  const [A, B, C, D] = [grid[0], grid[1], grid[gw], grid[gw + 1]];
  const bilinear = (A + B + C + D) / 4;
  const got = subElev(grid, gw, gw, 0.5, 0.5);
  assert.ok(Math.abs(got - bilinear) > 1e-9, "a twisted cell must NOT read as bilinear");
  assert.ok(Math.abs(got - (B + C - A - D) / 4 - bilinear) < 1e-9, "off by exactly the twist");
});

test("subK: a cord already wider than the lattice needs no refinement", () => {
  assert.equal(subK(1.6, 0.376, 0.376, 200).k, 1);
});

test("subK: a 0.4 mm cord on a 0.376 mm pitch refines to four sub-cells across", () => {
  const { k, hx } = subK(0.4, 0.376, 0.376, 200);
  assert.equal(k, 4);
  assert.ok(hx <= 0.4 / SUB_ACROSS + 1e-12, `sub-pitch ${hx} must fit ${SUB_ACROSS} across`);
});

/** Shortest printed-trail length at which subK refuses `widthMm`, found by doubling then
 *  bisecting. Derived, never hard-coded: the triangle allowance is a tunable, and a magic length
 *  here turns into a silently passing no-op the next time it moves.
 *  @param {number} widthMm @param {number} pitch @returns {number} */
function refusalLen(widthMm, pitch) {
  let hi = 1;
  for (; hi < 1e9; hi *= 2) { try { subK(widthMm, pitch, pitch, hi); } catch { break; } }
  let lo = hi / 2;
  while (hi - lo > 1) {
    const m = (lo + hi) / 2;
    try { subK(widthMm, pitch, pitch, m); lo = m; } catch { hi = m; }
  }
  return hi;
}

test("subK: the triangle budget clamps k on an absurdly long trail", () => {
  const pitch = 0.376, W = 0.4;
  const near = subK(W, pitch, pitch, 200).k;
  // Just inside the refusal, so the clamp is provably engaged without tripping the guard below.
  const far = subK(W, pitch, pitch, refusalLen(W, pitch) * 0.9).k;
  assert.ok(far < near, `budget must bite: ${far} vs ${near}`);
});

// Below half the width the region can slip between lattice rows and bead into islands, each a
// valid closed manifold on its own — so checkWatertight passes and the print is a dotted line.
test("subK throws rather than mesh a width the clamped lattice cannot carry", () => {
  assert.throws(() => subK(0.02, 0.376, 0.376, 5e6), /too long to carry/);
});

test("admissibleCells: no clip means every cell", () => {
  const cells = admissibleCells(5, 5, null);
  assert.equal(cells.length, 16);
  assert.ok(cells.every((v) => v === 1));
});

// A rim cell's printed top is clip.js's clipped polygon, not two plain triangles — and a ring
// can cut a corner-free sliver off a cell whose four corners all read inside, so the
// all-four-corners test alone does not exclude it.
test("admissibleCells excludes rim cells even when all four corners read inside", () => {
  const gw = 5;
  const inside = new Uint8Array(gw * gw).fill(1);
  const clip = /** @type {any} */ ({ inside, bcells: new Set([1 * (gw - 1) + 2]) });
  const cells = admissibleCells(gw, gw, clip);
  assert.equal(cells[1 * (gw - 1) + 2], 0, "the boundary cell is refused");
  assert.equal(cells[1 * (gw - 1) + 1], 1, "its neighbour is not");
});

// The point of the whole change. The old cell-snapped corridor could only be a whole number of
// cells wide; measured here at 0.4 mm on a 0.376 mm pitch, where it could not exist at all.
test("a 0.4 mm cord is 0.4 mm wide, across angles and sub-cell offsets", () => {
  const gw = 200, pitch = 0.376, W = 0.4;
  let worst = 0;
  for (let deg = 0; deg < 180; deg += 7.5) {
    for (const off of [0, 0.13, 0.19, 0.27]) {
      const { soup, L } = straight(deg, W, gw, pitch, off);
      assert.ok(soup, `no cord at ${deg} deg, offset ${off}`);
      const w = widthFromArea(soupArea(soup), L);
      worst = Math.max(worst, Math.abs(w - W));
    }
  }
  assert.ok(worst < 0.01, `worst width error ${worst.toFixed(5)} mm over 24 angles x 4 offsets`);
});

// Straight runs are exact at ANY k because distance to a line is affine and lands the crossing
// on the true isoline — so a wide cord at k = 1 is just as accurate as a thin one at k = 4.
test("a 1.6 mm cord is exact too, at k = 1", () => {
  const gw = 200, pitch = 0.376, W = 1.6;
  assert.equal(subK(W, pitch, pitch, gw * pitch * 0.6).k, 1);
  for (const deg of [0, 22.5, 45, 67.5]) {
    const { soup, L } = straight(deg, W, gw, pitch);
    assert.ok(soup);
    assert.ok(Math.abs(widthFromArea(soupArea(soup), L) - W) < 0.01, `${deg} deg`);
  }
});

test("a 0.4 mm cord stays one connected piece — no beading", () => {
  const gw = 200, pitch = 0.376;
  for (let deg = 0; deg < 180; deg += 7.5) {
    for (const off of [0, 0.13, 0.27]) {
      const { soup } = straight(deg, 0.4, gw, pitch, off);
      assert.ok(soup);
      assert.equal(components(soup), 1, `${deg} deg, offset ${off} beaded`);
    }
  }
});

// Congruence again, this time over real generated geometry rather than chosen sample points:
// every vertex the mesher emitted has to sit on its parent triangle's plane.
test("every cord vertex lies on the terrain's printed surface", () => {
  const gw = 60, pitch = 0.376;
  const grid = gridOf(gw, (c, r) => 40 * Math.sin(c / 7) + 25 * Math.cos(r / 5) + 0.3 * c * r);
  const { soup, plan } = straight(31, 0.4, gw, pitch, 0, grid);
  assert.ok(soup);
  const { r1, c0 } = plan.span;
  for (let i = 0; i < soup.x.length; i++) {
    const col = soup.x[i] / pitch + c0, row = r1 - soup.y[i] / pitch;
    const c = Math.min(Math.max(Math.floor(col), 0), gw - 2);
    const r = Math.min(Math.max(Math.floor(row), 0), gw - 2);
    const u = col - c, v = row - r;
    const A = r * gw + c, B = A + 1, C = A + gw, D = C + 1;
    const tri = u + v <= 1
      ? [[c, r, grid[A]], [c + 1, r, grid[B]], [c, r + 1, grid[C]]]
      : [[c + 1, r, grid[B]], [c, r + 1, grid[C]], [c + 1, r + 1, grid[D]]];
    const [p, q, s] = tri;
    const e1 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const e2 = [s[0] - p[0], s[1] - p[1], s[2] - p[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const off = n[0] * (col - p[0]) + n[1] * (row - p[1]) + n[2] * (soup.z[i] - p[2]);
    assert.ok(Math.abs(off) < 1e-6, `vertex ${i} is ${off} off the printed surface`);
  }
});

// Nesting is what makes the congruence above hold for the whole face and not just its corners:
// a triangle straddling a cell edge or the anti-diagonal would span two planes.
test("no cord triangle straddles a terrain triangle", () => {
  const gw = 60, pitch = 0.376;
  const { soup, plan } = straight(31, 0.4, gw, pitch);
  assert.ok(soup);
  const { r1, c0 } = plan.span;
  const cr = (/** @type {number} */ i) => [soup.x[i] / pitch + c0, r1 - soup.y[i] / pitch];
  for (let t = 0; t < soup.tris.length; t += 3) {
    const ids = [soup.tris[t], soup.tris[t + 1], soup.tris[t + 2]];
    // The centroid is strictly interior, so it names the parent triangle without a tie-break;
    // each vertex then has to fall inside that parent's closure.
    const g = ids.map(cr).reduce((s, p) => [s[0] + p[0] / 3, s[1] + p[1] / 3], [0, 0]);
    const c = Math.floor(g[0]), r = Math.floor(g[1]);
    const upper = g[0] - c + (g[1] - r) <= 1; // the A/C/B half, vs B/C/D
    for (const id of ids) {
      const [col, row] = cr(id);
      const u = col - c, v = row - r;
      // barycentric weights: (1-u-v, u, v) on the upper half, (1-v, 1-u, u+v-1) on the lower
      const w = upper ? [1 - u - v, u, v] : [1 - v, 1 - u, u + v - 1];
      assert.ok(w.every((b) => b >= -1e-9),
        `triangle ${t / 3} spans parents: vertex (${col},${row}) is outside cell ${c},${r}`);
    }
  }
});

// The reason the old corridor stamped discs instead of sweeping a ribbon: an out-and-back
// retraces its own path, and a swept solid interpenetrates itself there. A distance sublevel
// set has no such failure mode — the region is the same however many times it is traced.
test("out-and-back covers exactly one cord, not two", () => {
  const gw = 120, pitch = 0.376, grid = gridOf(gw, () => 0);
  const plan = planOf(gw, pitch);
  const oneWay = Float64Array.from([5, 19.3, 25, 19.3]);
  const back = Float64Array.from([5, 19.3, 25, 19.3, 5, 19.3]);
  const a = cordTris(grid, plan, [oneWay], 0.4, GEOM, allCells(gw));
  const b = cordTris(grid, plan, [back], 0.4, GEOM, allCells(gw));
  assert.ok(a && b);
  assert.ok(Math.abs(soupArea(b) - soupArea(a)) < 1e-9, `${soupArea(a)} vs ${soupArea(b)}`);
});

// A cap is the one place the boundary is genuinely curved, so it is the one place chordal error
// shows: the mesher inscribes a polygon whose corners are exactly on the circle. Both halves are
// asserted — every vertex on or inside the true disc (never proud of it), and the area short of
// pi*r^2 by no more than that inscription costs.
test("a single-point trail is a disc of the cord's width", () => {
  const gw = 120, pitch = 0.376, W = 1.6, r = W / 2;
  const soup = cordTris(gridOf(gw, () => 0), planOf(gw, pitch),
    [Float64Array.from([20, 20])], W, GEOM, allCells(gw));
  assert.ok(soup);
  let far = 0;
  for (let i = 0; i < soup.x.length; i++) far = Math.max(far, Math.hypot(soup.x[i] - 20, soup.y[i] - 20));
  assert.ok(far <= r + 1e-9, `a vertex sits ${(far - r).toExponential(2)} mm outside the disc`);
  assert.ok(Math.abs(far - r) < 1e-9, "the boundary reaches the exact radius, not short of it");
  const area = soupArea(soup), want = Math.PI * r * r;
  assert.ok(area <= want && area > 0.95 * want, `${area.toFixed(4)} vs ${want.toFixed(4)}`);
});

test("the cord never enters an inadmissible cell", () => {
  const gw = 120, pitch = 0.376, cw = gw - 1;
  const cellOk = allCells(gw);
  for (let r = 0; r < cw; r++) for (let c = cw >> 1; c < cw; c++) cellOk[r * cw + c] = 0;
  const soup = cordTris(gridOf(gw, () => 0), planOf(gw, pitch),
    [Float64Array.from([2, 20, 40, 20])], 0.4, GEOM, cellOk);
  assert.ok(soup);
  const xLimit = (cw >> 1) * pitch;
  for (let i = 0; i < soup.x.length; i++) {
    assert.ok(soup.x[i] <= xLimit + 1e-9, `vertex at x=${soup.x[i]} escaped past ${xLimit}`);
  }
});

// The extreme corner of the parameter space: the biggest tile the UI allows carrying the
// narrowest cord, meshed at the finest sub-lattice, with the trail in the corner of the grid
// where every index is at its largest. Nothing here is exotic on its own — it is the one
// combination where index arithmetic and float spacing are both at their limits at once.
//
// (This is where the crossing cache key was found to alias under `lo * totalVertices + hi`:
// 54 of 540 edges collided. It is NOT what this test detects — aliased crossings still land on
// the isoline, so the cord stayed closed and correctly wound and only its volume drifted 0.02%.
// The key is exact now by construction; this pins the configuration, not that one bug.)
test("the extreme tile/cord combination still meshes cleanly", () => {
  const gw = 2000, pitch = 0.5, W = 0.4;
  assert.equal(subK(W, pitch, pitch, 30).k, 5, "fixture must refine, or it proves nothing");
  const grid = new Float32Array(gw * gw);
  for (let i = 0; i < grid.length; i++) grid[i] = (i % 97) * 0.5;
  const soup = cordTris(grid, planOf(gw, pitch), [Float64Array.from([985.3, 1.7, 998.1, 9.4])],
    W, GEOM, allCells(gw));
  assert.ok(soup);
  let zero = 0;
  for (let i = 0; i < soup.tris.length; i += 3) {
    const [p, q, r] = [soup.tris[i], soup.tris[i + 1], soup.tris[i + 2]];
    const a = Math.abs((soup.x[q] - soup.x[p]) * (soup.y[r] - soup.y[p])
      - (soup.x[r] - soup.x[p]) * (soup.y[q] - soup.y[p])) / 2;
    if (a <= 1e-12) zero++;
  }
  assert.equal(zero, 0, "degenerate triangles");
  assert.equal(components(soup), 1, "the cord is torn");
  const L = Math.hypot(998.1 - 985.3, 9.4 - 1.7);
  const w = widthFromArea(soupArea(soup), L);
  assert.ok(Math.abs(w - W) < 2e-3, `width ${w.toFixed(6)} mm, want ${W}`);
});

// Framing a tile around one stretch of a long import is the normal case — framing.js warns about
// the clipped remainder rather than refusing it. The triangle budget must therefore be spent on
// what the tile actually carries: counting the whole import here would coarsen the lattice, and
// past the refusal threshold reject the width outright, over geometry that is never printed.
test("the triangle budget ignores trail that falls outside the tile", () => {
  const gw = 200, pitch = 0.376, W = 0.4;
  const inTile = Float64Array.from([30, 30, 45, 30]);
  // A second <trkseg>, well past the refusal threshold on its own and entirely off the tile.
  // Separate rather than appended, so it adds no cord inside the tile to compare against.
  const offLen = refusalLen(W, pitch) * 2;
  const offTile = Float64Array.from([20000, 30, 20000, 30 + offLen]);
  const grid = gridOf(gw, () => 0), plan = planOf(gw, pitch), cells = allCells(gw);
  assert.throws(() => subK(W, pitch, pitch, offLen), /too long to carry/,
    "fixture must exceed the budget when the off-tile leg is counted");

  const bare = cordTris(grid, plan, [inTile], W, GEOM, cells);
  const tailed = cordTris(grid, plan, [inTile, offTile], W, GEOM, cells);
  assert.ok(bare && tailed, "the off-tile tail must not refuse the cord");
  assert.ok(Math.abs(widthFromArea(soupArea(tailed), 15) - W) < 0.01, "width unaffected by the tail");
  assert.equal(tailed.tris.length, bare.tris.length, "and it meshes identically");
});

test("a trail entirely off the tile yields no cord", () => {
  const gw = 60, pitch = 0.376;
  const soup = cordTris(gridOf(gw, () => 0), planOf(gw, pitch),
    [Float64Array.from([-50, -50, -40, -50])], 0.4, GEOM, allCells(gw));
  assert.equal(soup, null);
});

// The preview draws the EXPORT's cord, so the tier that broke the old cell-snapped corridor is
// the one that matters. At the FAST budget a 200 mm tile at 1:30 000 has a 0.8365 mm pitch, where
// a 1.6 mm cord is 1.91 cells: the all-four-corners rule claimed ZERO cells there, so the preview
// showed an empty tile for a trail that exported perfectly, and that is the entire reason a
// second sweep-based construction was once specified. The sub-lattice is what retired it, so the
// property is pinned here rather than left to be rediscovered.
//
// Widths down to 0.4 mm — under HALF a cell at the coarse tier — because the floor a future
// pitch-aware "fix" would reintroduce lands exactly there.
//
// Connectivity is checked on a CURVED cord too, and only here: a beaded corridor is a set of
// islands, each a closed manifold on its own, so neither checkWatertight nor signedVolume can see
// the gaps (cord.js says so at the width guard). Width-from-area is straight-only — a capsule
// formula does not describe an arc — so the curve carries the connectivity assertion alone.
test("a cord narrower than a grid cell still meshes at preview pitch", () => {
  for (const pitch of [0.8365, 0.4183]) {          // FAST and CRISP on a 6 km tile
    for (const widthMm of [0.4, 0.8, 1.6, 3.0]) {
      const { soup, L } = straight(23, widthMm, 64, pitch);
      const where = `${widthMm} mm cord on a ${pitch} mm pitch (${(widthMm / pitch).toFixed(2)} cells)`;
      assert.ok(soup, `${where}: no corridor at all`);
      assert.equal(components(soup), 1, `${where}: beaded into pieces`);
      const w = widthFromArea(soupArea(soup), L);
      assert.ok(Math.abs(w - widthMm) < 0.01, `${where}: measured ${w.toFixed(5)} mm`);

      const arc = curved(widthMm, 64, pitch);
      assert.ok(arc, `${where}, curved: no corridor at all`);
      assert.equal(components(arc), 1, `${where}, curved: beaded into pieces`);
    }
  }
});
