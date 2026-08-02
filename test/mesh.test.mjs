import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSolid } from "../src/core/mesh.js";
import { signedVolume, checkWatertight } from "../src/core/validate.js";
import { clipCircle, clipElevs } from "../src/core/clip.js";

// Flat tile: every grid sample at the same relief; geom maps relief mm 1:1, so
// the enclosed volume is exactly footprint_area × (base + relief) — analytic,
// no fixture needed.
/**
 * @param {number} gw @param {number} gh @param {number} [z]
 * @returns {{ grid: Float32Array, gw: number, gh: number }}
 */
function flatGrid(gw, gh, z = 2) {
  return { grid: new Float32Array(gw * gh).fill(z), gw, gh };
}
const GEOM = { dx: 1, dy: 1, mmPerM: 1, emin: 0, exag: 1, base: 1 };

test("flat base: full rectangle uses a fan, not a mirror", () => {
  const { grid, gw, gh } = flatGrid(9, 7);
  const mask = new Uint8Array((gw - 1) * (gh - 1)).fill(1);
  const m = buildSolid(grid, gw, gh, { r0: 0, r1: gh - 1, c0: 0, c1: gw - 1 }, mask, GEOM);
  assert.ok(checkWatertight(m).closed);
  const nTop = 96; // 8×6 cells × 2 tris; a mirrored base would double the total
  assert.ok(m.indices.length / 3 < 2 * nTop, `tris ${m.indices.length / 3}`);
  assert.ok(Math.abs(signedVolume(m) - 8 * 6 * (1 + 2)) < 1e-3); // (base+relief) × area
});

test("flat base: two-island mask closes with two loops", () => {
  const { grid, gw, gh } = flatGrid(11, 5);
  const mask = new Uint8Array((gw - 1) * (gh - 1));
  for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) mask[r * 10 + c] = 1; // island A: 12 cells
  for (let r = 0; r < 4; r++) for (let c = 6; c < 10; c++) mask[r * 10 + c] = 1; // island B: 16 cells
  const m = buildSolid(grid, gw, gh, { r0: 0, r1: gh - 1, c0: 0, c1: gw - 1 }, mask, GEOM);
  assert.ok(checkWatertight(m).closed, `unmatched ${checkWatertight(m).unmatched}`);
  assert.ok(Math.abs(signedVolume(m) - (12 + 16) * 3) < 1e-3);
});

test("flat base: U-shaped rim (centroid in the notch) ear-clips flat", () => {
  // 24×12 cells minus an 8×8 notch from the top middle. The rim's vertex-average
  // centroid lands inside the notch (outside the polygon), so the centroid fan
  // fails and ear-clip must cover the base — still under the mirror's 2×-top.
  const { grid, gw, gh } = flatGrid(25, 13);
  const cw = gw - 1;
  const mask = new Uint8Array(cw * (gh - 1)).fill(1);
  for (let r = 0; r < 8; r++) for (let c = 8; c < 16; c++) mask[r * cw + c] = 0;
  const m = buildSolid(grid, gw, gh, { r0: 0, r1: gh - 1, c0: 0, c1: cw }, mask, GEOM);
  assert.ok(checkWatertight(m).closed, `unmatched ${checkWatertight(m).unmatched}`);
  const nTop = 2 * (24 * 12 - 64); // 448
  assert.ok(m.indices.length / 3 < 2 * nTop, `tris ${m.indices.length / 3} (mirror ≥ ${2 * nTop})`);
  assert.ok(Math.abs(signedVolume(m) - (24 * 12 - 64) * 3) < 1e-3);
});

test("flat base: donut footprint falls back to mirror and stays closed", () => {
  const { grid, gw, gh } = flatGrid(9, 9);
  const mask = new Uint8Array(64).fill(1);
  mask[3 * 8 + 3] = mask[3 * 8 + 4] = mask[4 * 8 + 3] = mask[4 * 8 + 4] = 0; // interior hole
  const m = buildSolid(grid, gw, gh, { r0: 0, r1: 8, c0: 0, c1: 8 }, mask, GEOM);
  assert.ok(checkWatertight(m).closed, `unmatched ${checkWatertight(m).unmatched}`);
  assert.ok(Math.abs(signedVolume(m) - (64 - 4) * 3) < 1e-3);
});

// GEOM maps relief 1:1 with base 1 and z 2, so every solid below has height 3 and
// signedVolume is exactly footprint_area × 3 — the area is read straight off the volume.
const H = 3;

// The clipped footprint's boundary is the chord polyline through the crossings, and every
// crossing lies exactly on the circle — so the printed area is an INSCRIBED polygon whose
// analytic deficit is 1 − (n/2π)·sin(2π/n) ≈ 1.3e-5 here. Asserting 1e-4 leaves headroom
// while still being ~200× tighter than the cell-centre mask's 0.78387-vs-π/4.
test("clip: circle footprint area matches pi*R^2", () => {
  const gw = 201, gh = 201, R = 90;
  const { grid } = flatGrid(gw, gh);
  const clip = clipCircle(gw, gh, 100.3, 100.7, R);
  clipElevs(clip, grid);
  const m = buildSolid(grid, gw, gh, { r0: 0, r1: gh - 1, c0: 0, c1: gw - 1 }, null, GEOM, clip);
  const area = signedVolume(m) / H;
  const rel = Math.abs(area / (Math.PI * R * R) - 1);
  assert.ok(rel < 1e-4, `area ${area} vs ${Math.PI * R * R} (rel ${rel})`);
});

// The circle centre lands on an arbitrary float in practice, so sweep sub-pixel phase as
// well as radius.
test("clip: watertight and positive-volume across radii and phases", () => {
  const gw = 121, gh = 121;
  const { grid } = flatGrid(gw, gh);
  for (const R of [10, 23.5, 47, 58.25]) {
    for (const [px, py] of [[0, 0], [0.25, 0.5], [0.5, 0.25], [0.75, 0.75]]) {
      const clip = clipCircle(gw, gh, 60 + px, 60 + py, R);
      clipElevs(clip, grid);
      const m = buildSolid(grid, gw, gh, { r0: 0, r1: gh - 1, c0: 0, c1: gw - 1 }, null, GEOM, clip);
      const wt = checkWatertight(m);
      assert.ok(wt.closed, `R=${R} phase=(${px},${py}): ${wt.unmatched} unmatched edges`);
      assert.ok(signedVolume(m) > 0, `R=${R} phase=(${px},${py}): non-positive volume`);
    }
  }
});

// A duplicate-vertex bug (two cells allocating separate ids for one shared edge crossing)
// leaves an interior boundary, so stitchLoops finds extra loops, baseTriangles rejects the
// CW one, and assembleSolid falls back to the mirror bottom — which doubles the triangle
// count. Counting triangles is therefore the direct detector for that failure.
test("clip: single boundary loop, so the base fans instead of mirroring", () => {
  const gw = 121, gh = 121, R = 50;
  const { grid } = flatGrid(gw, gh);
  const clip = clipCircle(gw, gh, 60.5, 60.5, R);
  clipElevs(clip, grid);
  const m = buildSolid(grid, gw, gh, { r0: 0, r1: gh - 1, c0: 0, c1: gw - 1 }, null, GEOM, clip);
  let nTop = 0;
  for (let r = 0; r < gh - 1; r++) {
    for (let c = 0; c < gw - 1; c++) {
      const A = r * gw + c;
      if (clip.inside[A] && clip.inside[A + 1] && clip.inside[A + gw] && clip.inside[A + gw + 1]) nTop += 2;
    }
  }
  assert.ok(m.indices.length / 3 < 2 * nTop, `tris ${m.indices.length / 3} (mirror ≈ ${2 * nTop})`);
});

// SNAP_EPS exists to stop a crossing landing next to a grid vertex from producing a
// degenerate triangle; this asserts the guarantee it buys.
/**
 * @param {{ positions: Float32Array, indices: Uint32Array }} m
 * @returns {number}
 */
function worstTriArea(m) {
  const p = m.positions, ix = m.indices;
  let worst = Infinity;
  for (let i = 0; i < ix.length; i += 3) {
    const a = 3 * ix[i], b = 3 * ix[i + 1], c = 3 * ix[i + 2];
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const area = Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
    if (area < worst) worst = area;
  }
  return worst;
}
test("clip: no zero-area triangles", () => {
  const gw = 121, gh = 121;
  const { grid } = flatGrid(gw, gh);
  const clip = clipCircle(gw, gh, 60, 60, 40); // integer centre and radius: crossings hit vertices
  clipElevs(clip, grid);
  const m = buildSolid(grid, gw, gh, { r0: 0, r1: gh - 1, c0: 0, c1: gw - 1 }, null, GEOM, clip);
  assert.ok(worstTriArea(m) > 1e-7, `smallest triangle area ${worstTriArea(m)}`);
});

// Regression fixture from code review: gw=gh=151, R=36.468277, cx=60.232467, cy=60.858895.
// addH/addV in clip.js each apply SNAP_EPS to their own edge only, so a crossing can land
// within SNAP_EPS of a grid corner on one edge while the *other* edge meeting that corner
// misses the cutoff by a hair — cellPoly's old consecutive-*id* dedup let both into the same
// fan, and cell r=91,c=83 emitted a triangle of exactly zero area (ids 11215/14891/11216, all
// y=92, x∈{83, 83.99987, 84}). Fixed by collapsing near-coincident positions on the id, not
// the walk order — this is the direct regression check for that fix.
test("clip: no near-zero triangle at a near-miss corner (review repro)", () => {
  const gw = 151, gh = 151;
  const { grid } = flatGrid(gw, gh);
  const clip = clipCircle(gw, gh, 60.232467, 60.858895, 36.468277);
  clipElevs(clip, grid);
  const m = buildSolid(grid, gw, gh, { r0: 0, r1: gh - 1, c0: 0, c1: gw - 1 }, null, GEOM, clip);
  assert.ok(worstTriArea(m) > 1e-7, `smallest triangle area ${worstTriArea(m)}`);
  const wt = checkWatertight(m);
  assert.ok(wt.closed, `${wt.unmatched} unmatched edges`);
  assert.ok(signedVolume(m) > 0, "non-positive volume");
});

// Deterministic PRNG (mulberry32) so the sweep below is reproducible without Math.random().
/** @param {number} seed @returns {() => number} */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The single-corner repro above dodges almost every (R, cx, cy) — the disagreeing-edges bug
// needs a specific sub-pixel alignment to surface. A broad, seeded sweep is what actually
// guards against a future regression hiding in a lucky configuration the way this one did.
// Watertightness is asserted alongside the area check because the walk-order trap this fix
// avoids (see cellPoly's comment) fails *that* property, not the area one.
test("clip: no near-zero triangles or boundary leaks across a seeded sweep", () => {
  const gw = 121, gh = 121;
  const { grid } = flatGrid(gw, gh);
  const rand = mulberry32(0xc1fc1e);
  for (let i = 0; i < 200; i++) {
    const R = 8 + rand() * 50;
    const cx = 55 + rand() * 10, cy = 55 + rand() * 10;
    const clip = clipCircle(gw, gh, cx, cy, R);
    clipElevs(clip, grid);
    const m = buildSolid(grid, gw, gh, { r0: 0, r1: gh - 1, c0: 0, c1: gw - 1 }, null, GEOM, clip);
    const wt = checkWatertight(m);
    assert.ok(wt.closed, `R=${R} c=(${cx},${cy}): ${wt.unmatched} unmatched edges`);
    assert.ok(signedVolume(m) > 0, `R=${R} c=(${cx},${cy}): non-positive volume`);
    assert.ok(worstTriArea(m) > 1e-7, `R=${R} c=(${cx},${cy}): smallest tri area ${worstTriArea(m)}`);
  }
});

// Round-2 review repro: gw=gh=121, R=25.135360596468672, cx=56.02314373012632,
// cy=66.62650303449482 -> cell r=68,c=31 fanned a triangle of exactly zero area at
// (31,69),(31,68),(31,68.99897646447243) — all x=31, i.e. COLLINEAR on the cell's A-C edge.
// Cause: a crossing on the *adjacent* C-D edge had t within SNAP_EPS of C and snapped to
// C's grid id, but C read as outside (the exact d<=R test disagreed with the snap's own
// SNAP_EPS tolerance), so the walk emitted outside-corner C as well as the on-A-C-edge
// crossing — two points on the same line as A, hence zero area at any spacing. Round 1's
// position dedupe cannot catch this: collinear points are zero-area regardless of gap size,
// so no epsilon on distance-between-consecutive-vertices closes it. Fixed at the source in
// clip.js by dilating the inside test to d<=R+SNAP_EPS, so any vertex a crossing can snap to
// is guaranteed inside and the walk never emits it as a corner.
test("clip: no collinear zero-area triangle from a snap/inside disagreement (round-2 repro)", () => {
  const gw = 121, gh = 121;
  const { grid } = flatGrid(gw, gh);
  const clip = clipCircle(gw, gh, 56.02314373012632, 66.62650303449482, 25.135360596468672);
  clipElevs(clip, grid);
  const m = buildSolid(grid, gw, gh, { r0: 0, r1: gh - 1, c0: 0, c1: gw - 1 }, null, GEOM, clip);
  assert.ok(worstTriArea(m) > 1e-7, `smallest triangle area ${worstTriArea(m)}`);
  const wt = checkWatertight(m);
  assert.ok(wt.closed, `${wt.unmatched} unmatched edges`);
  assert.ok(signedVolume(m) > 0, "non-positive volume");
});

// Second-order defect found while stress-testing the round-2 fix above: dilating `inside`
// can flip an isolated grid vertex to "inside" whose same-line neighbours stay outside (the
// true circle is nearly tangent to a grid line over exactly one cell). Both of that vertex's
// collinear neighbour edges then get independent, well-separated (non-snapped) crossings, and
// the *global* rim loop ends up with 3 exactly-collinear consecutive vertices — not a
// near-coincidence round 1's dedupe can catch (the gaps here are 0.017 and 0.34 grid units,
// nowhere near DEDUPE_EPS), and not a snap/inside disagreement round 2's dilation targets
// (no crossing snapped to this vertex at all; dilation alone made it inside). The triple
// survives because `earclip`'s final idx.length===3 remainder (mesh.js) is pushed without the
// cross3>AREA2_EPS guard every other candidate ear gets. Fixed by adding that guard: an
// earclip result containing a degenerate triangle now rejects the whole loop, so
// assembleSolid falls back to mirroring (proven watertight; the top surface is unaffected —
// a single cell's cellPoly walk cannot itself emit a 3-collinear fan, since a corner and its
// own edge's crossing are mutually exclusive by construction, so this is strictly a
// *multi-cell rim loop* failure, orthogonal to cellPoly's per-cell dedupe).
test("clip: no collinear zero-area triangle from an isolated dilated vertex (earclip terminal-triple gap)", () => {
  const gw = 121, gh = 121;
  const { grid } = flatGrid(gw, gh);
  const clip = clipCircle(gw, gh, 56.48870502598584, 54.811413595452905, 31.489169746351216);
  clipElevs(clip, grid);
  const m = buildSolid(grid, gw, gh, { r0: 0, r1: gh - 1, c0: 0, c1: gw - 1 }, null, GEOM, clip);
  assert.ok(worstTriArea(m) > 1e-7, `smallest triangle area ${worstTriArea(m)}`);
  const wt = checkWatertight(m);
  assert.ok(wt.closed, `${wt.unmatched} unmatched edges`);
  assert.ok(signedVolume(m) > 0, "non-positive volume");
});

// The snap/inside disagreement needs a grid vertex within SNAP_EPS (1e-4) of the true
// circle — vanishingly rare under uniform (R, cx, cy) sampling (the reviewer measured a
// ~0.03% rate; a 200-iteration uniform sweep has ~93% odds of missing it entirely). Bias the
// sampler at the failure mode instead: pick a centre and a nearby integer grid vertex, then
// set R to the exact centre-to-vertex distance plus a jitter of a few SNAP_EPS, so the
// circle passes within a hair of that lattice point by construction.
test("clip: no near-zero triangles across a jitter-biased sweep (near-lattice radii)", () => {
  const gw = 121, gh = 121;
  const { grid } = flatGrid(gw, gh);
  const rand = mulberry32(0xb1a5ed);
  const SNAP_EPS = 1e-4; // mirrors clip.js's private constant; the failure window this targets
  for (let i = 0; i < 400; i++) {
    const cx = 40 + rand() * 40, cy = 40 + rand() * 40;
    const ang = rand() * 2 * Math.PI, rr = 5 + rand() * 45;
    const vx = Math.round(cx + rr * Math.cos(ang)), vy = Math.round(cy + rr * Math.sin(ang));
    const R0 = Math.hypot(vx - cx, vy - cy); // exact centre-to-lattice-point distance
    const jitter = (Math.floor(rand() * 7) - 3) * SNAP_EPS; // -3..+3 SNAP_EPS
    const R = Math.max(1, R0 + jitter);
    const clip = clipCircle(gw, gh, cx, cy, R);
    clipElevs(clip, grid);
    const m = buildSolid(grid, gw, gh, { r0: 0, r1: gh - 1, c0: 0, c1: gw - 1 }, null, GEOM, clip);
    const wt = checkWatertight(m);
    assert.ok(wt.closed, `R=${R} c=(${cx},${cy}): ${wt.unmatched} unmatched edges`);
    assert.ok(signedVolume(m) > 0, `R=${R} c=(${cx},${cy}): non-positive volume`);
    assert.ok(worstTriArea(m) > 1e-7, `R=${R} c=(${cx},${cy}): smallest tri area ${worstTriArea(m)}`);
  }
});

// worstTriArea only catches degenerate (near-zero) area; it misses a triangle that's
// merely wound the wrong way but not small, which is exactly what the tangent-fallback bug
// (clip.js addH/addV) produces. Every top-surface triangle is documented (mesh.js) as +Z
// wound, i.e. CCW in xy — so with a flat grid (constant z separates top from skirt/base,
// which sit at other z's), the minimum SIGNED 2D area across top triangles must stay
// positive; a negative one is a fan triangle turning the opposite way from the rest of its
// cell.
/**
 * @param {{ positions: Float32Array, indices: Uint32Array }} m
 * @param {number} zTop
 * @returns {number}
 */
function minTopWinding(m, zTop) {
  const p = m.positions, ix = m.indices;
  let worst = Infinity;
  for (let i = 0; i < ix.length; i += 3) {
    const a = 3 * ix[i], b = 3 * ix[i + 1], c = 3 * ix[i + 2];
    if (Math.abs(p[a + 2] - zTop) > 1e-6 || Math.abs(p[b + 2] - zTop) > 1e-6 ||
      Math.abs(p[c + 2] - zTop) > 1e-6) continue; // skirt/base vertex: not a top triangle
    const signed = (p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a]);
    if (signed < worst) worst = signed;
  }
  return worst;
}

// Same repro as clip.test.mjs's tangent-row test, carried through to the mesh: the
// misattributed vertex (et outside [0, 1]) doesn't just mislabel a crossing, it puts a
// vertex where cellPoly's fan turns concave, flipping that triangle's winding relative to
// the rest of its cell. checkWatertight can't see it — the fan's diagonals still self-cancel
// in pairs regardless of local winding — so this needs its own assertion. Fails before the
// clamp (a fan triangle winds negative), passes after.
test("clip: near-tangent row does not invert a fan triangle's winding (review repro)", () => {
  const gw = 41, gh = 41;
  const { grid } = flatGrid(gw, gh);
  const clip = clipCircle(gw, gh, 22.26313118590042, 20.950106598902494, 5.263271871954203);
  clipElevs(clip, grid);
  const m = buildSolid(grid, gw, gh, { r0: 0, r1: gh - 1, c0: 0, c1: gw - 1 }, null, GEOM, clip);
  assert.ok(minTopWinding(m, H) > 0, `worst top-triangle signed area ${minTopWinding(m, H)}`);
});

// A corner grid vertex sitting a hair OUTSIDE the circle leaves a tiny chord between the two
// crossings on the edges meeting there. Neither snaps if both miss SNAP_EPS, and a per-cell
// geometric dedupe only sees the pair when the walk happens to make them adjacent — true in
// the corner cell, false in the neighbours sharing just one of those edges. The cells then
// disagree about the shared boundary, and assembleSolid closes the slit with a full-height
// skirt wall INSIDE the tile. Edge parity balances (the flap is closed), so checkWatertight,
// volume and area all pass while the preview shows a dark vertical band.
// Config is the preview bake that first exposed it: Mount Rainier, circle, z=10.
test("clip: a hair-clipped corner leaves no interior wall", () => {
  const gw = 288, gh = 288;
  const { grid } = flatGrid(gw, gh);
  const clip = clipCircle(gw, gh, 143.85532444444107, 143.40274986205623, 143.47514384332862);
  clipElevs(clip, grid);
  const m = buildSolid(grid, gw, gh, { r0: 0, r1: gh - 1, c0: 0, c1: gw - 1 }, null, GEOM, clip);
  assert.ok(checkWatertight(m).closed, "still closed");

  const P = m.positions, I = m.indices, nv = P.length / 3;
  // The symptom, asserted directly: an interior wall is a skirt triangle whose normal points
  // back at the tile axis. A slit's two flaps face opposite ways, so one of them always does.
  let cx = 0, cy = 0;
  for (let i = 0; i < nv; i++) { cx += P[3 * i]; cy += P[3 * i + 1]; }
  cx /= nv; cy /= nv;
  let worst = 1;
  for (let i = 0; i < I.length; i += 3) {
    const z = [P[3 * I[i] + 2], P[3 * I[i + 1] + 2], P[3 * I[i + 2] + 2]];
    if (!(z.some((v) => v < 1e-3) && z.some((v) => v > 1))) continue; // wall = spans base to top
    const a = 3 * I[i], b = 3 * I[i + 1], c = 3 * I[i + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz;
    const mx = (P[a] + P[b] + P[c]) / 3, my = (P[a + 1] + P[b + 1] + P[c + 1]) / 3;
    const rad = Math.hypot(mx - cx, my - cy) || 1, len = Math.hypot(nx, ny, ux * vy - uy * vx) || 1;
    const out = (nx * (mx - cx) + ny * (my - cy)) / (rad * len);
    if (out < worst) worst = out;
  }
  assert.ok(worst > 0, `a skirt triangle faces inward (dot ${worst}) — interior wall`);
});

// ---- shared solid invariants ------------------------------------------------------------
// checkWatertight is directed-edge parity, so it balances on any defect that is locally
// closed — a vertex pinch, or a slit whose two flaps face each other. signedVolume and the
// area assertions are aggregates, and a slit or sliver is area-neutral. Every clip defect
// found so far has been local AND area-neutral, which is why all three passed on meshes that
// were visibly wrong. These three checks exist to cover exactly that gap.

/** Closest distance between two distinct vertices, bucketed to stay O(n).
 * @param {{positions: Float32Array}} m @param {Iterable<number>} ids @returns {number} */
function closestPair(m, ids) {
  const P = m.positions, b = new Map();
  for (const i of ids) {
    const k = `${Math.round(P[3 * i] / 0.05)},${Math.round(P[3 * i + 1] / 0.05)},${Math.round(P[3 * i + 2] / 0.05)}`;
    if (!b.has(k)) b.set(k, []);
    b.get(k).push(i);
  }
  let best = Infinity;
  for (const arr of b.values()) {
    for (let x = 0; x < arr.length; x++) {
      for (let y = x + 1; y < arr.length; y++) {
        const i = arr[x], j = arr[y];
        const d = Math.hypot(P[3 * i] - P[3 * j], P[3 * i + 1] - P[3 * j + 1], P[3 * i + 2] - P[3 * j + 2]);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

/** Skirt triangles (spanning base to top) whose normal points back at the tile axis — the
 *  signature of an interior wall. Convex footprint only; square, hex and circle all are.
 * @param {{positions: Float32Array, indices: Uint32Array}} m
 * @returns {{ inward: number, worst: number, rim: Set<number> }} */
function skirtOrientation(m) {
  const P = m.positions, I = m.indices, nv = P.length / 3;
  let cx = 0, cy = 0;
  for (let i = 0; i < nv; i++) { cx += P[3 * i]; cy += P[3 * i + 1]; }
  cx /= nv; cy /= nv;
  let inward = 0, worst = 1;
  const rim = new Set();
  for (let i = 0; i < I.length; i += 3) {
    const z = [P[3 * I[i] + 2], P[3 * I[i + 1] + 2], P[3 * I[i + 2] + 2]];
    if (!(z.some((v) => v < 1e-3) && z.some((v) => v > 1))) continue;
    rim.add(I[i]); rim.add(I[i + 1]); rim.add(I[i + 2]);
    const a = 3 * I[i], b = 3 * I[i + 1], c = 3 * I[i + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const mx = (P[a] + P[b] + P[c]) / 3, my = (P[a + 1] + P[b + 1] + P[c + 1]) / 3;
    const rad = Math.hypot(mx - cx, my - cy) || 1, L = Math.hypot(nx, ny, nz) || 1;
    const o = (nx * (mx - cx) + ny * (my - cy)) / (rad * L);
    if (o < 0) inward++;
    if (o < worst) worst = o;
  }
  return { inward, worst, rim };
}

/** Vertices whose incident triangles form more than one fan — a bowtie. validate.js names
 *  this as the gap edge parity cannot see, deferred while every footprint was a convex stair
 *  mask; clipping emits non-lattice boundary vertices, so the deferral no longer covers us.
 * @param {{indices: Uint32Array}} m @returns {number} */
function pinchedVertices(m) {
  const I = m.indices;
  /** @type {Map<number, Map<number, number>>} */
  const ring = new Map();
  /** @type {(v: number, s: number, e: number) => void} */
  const link = (v, s, e) => {
    let r = ring.get(v);
    if (!r) ring.set(v, r = new Map());
    r.set(s, e);
  };
  for (let i = 0; i < I.length; i += 3) {
    const a = I[i], b = I[i + 1], c = I[i + 2];
    link(a, b, c); link(b, c, a); link(c, a, b);
  }
  let pinched = 0;
  for (const r of ring.values()) {
    const seen = new Set();
    let cycles = 0;
    for (const s of r.keys()) {
      if (seen.has(s)) continue;
      cycles++;
      let cur = /** @type {number | undefined} */ (s), guard = r.size + 2;
      while (guard-- > 0 && cur !== undefined && !seen.has(cur)) { seen.add(cur); cur = r.get(cur); }
    }
    if (cycles > 1) pinched++;
  }
  return pinched;
}

/** @param {{positions: Float32Array, indices: Uint32Array}} m @param {string} label */
function assertSane(m, label) {
  assert.ok(checkWatertight(m).closed, `${label}: not closed`);
  assert.ok(signedVolume(m) > 0, `${label}: non-positive volume`);
  assert.ok(worstTriArea(m) > 1e-7, `${label}: degenerate triangle ${worstTriArea(m)}`);
  const { inward, worst, rim } = skirtOrientation(m);
  assert.equal(inward, 0, `${label}: ${inward} skirt triangles face inward (worst ${worst}) — interior wall`);
  assert.equal(pinchedVertices(m), 0, `${label}: bowtie vertex`);
  // clip.js's SNAP_EPS is 1e-3 cells (dx=1 here); anything closer should have merged at the
  // edge. 9e-4 leaves float slack while still catching the 5.4e-4 slit that shipped.
  const sep = closestPair(m, rim);
  assert.ok(sep > 9e-4, `${label}: rim vertices ${sep} apart — cells disagreed on a shared crossing`);
}

// Every clip defect so far lived in one regime: a lattice point sitting within a few
// SNAP_EPS of the rim, where a corner and its edges' crossings compete to represent the same
// point. Uniform sampling needs ~1e4 configs to hit a 0.03%-rate defect; aiming the radius at
// a lattice point hits it in tens. This sweep asserts the whole invariant bundle per config,
// so a new defect of ANY of those shapes surfaces here rather than in a preview.
test("clip: invariant bundle holds across a rim-lattice-biased sweep", () => {
  const gw = 121, gh = 121;
  const { grid } = flatGrid(gw, gh);
  const rand = mulberry32(0x5eec1a);
  const deltas = [-3e-3, -1e-3, -5e-4, -1e-4, 0, 1e-4, 5e-4, 1e-3, 3e-3];
  let n = 0;
  for (let trial = 0; trial < 12; trial++) {
    const cx = 60 + rand(), cy = 60 + rand();
    // aim the radius exactly at a lattice point, then jitter across the snap threshold
    const li = 60 + Math.floor(rand() * 40), lj = 60 + Math.floor(rand() * 40);
    const base = Math.hypot(li - cx, lj - cy);
    if (base < 8) continue;
    for (const d of deltas) {
      const clip = clipCircle(gw, gh, cx, cy, base + d);
      clipElevs(clip, grid);
      const m = buildSolid(grid, gw, gh, { r0: 0, r1: gh - 1, c0: 0, c1: gw - 1 }, null, GEOM, clip);
      assertSane(m, `R=${(base + d).toFixed(6)} c=(${cx.toFixed(4)},${cy.toFixed(4)})`);
      n++;
    }
  }
  assert.ok(n >= 90, `sweep ran ${n} configs`);
});
