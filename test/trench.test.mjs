// The two masks the channel is fenced by. Both are erosions, and both exist for reasons that
// have nothing to do with each other: admissibility is about which cells have a parent-plane
// structure to clip against, feather is about not putting a depth-tall step at a border.
import { test } from "node:test";
import assert from "node:assert/strict";
import { trenchAdmissibleCells, featherField, trenchTop } from "../src/core/trench.js";
import { admissibleCells, cordLattice, distField, trenchWidthMm } from "../src/core/cord.js";
import { clipPolygon } from "../src/core/clip.js";

// A convex hexagon in a 24x24 grid, in global px with a window origin -- the same global->local
// path the real caller uses (test/clip.test.mjs:7-11 does this too). footprintPx is deliberately
// NOT used: it takes a [q, r] pair and returns coordinates centred on a real tile's global
// position, nowhere near a bare 24x24 window.
const GX0 = 1000, GY0 = 2000;
const HEX = /** @type {Array<[number, number]>} */ (Array.from({ length: 6 }, (_, i) => {
  const a = (Math.PI / 3) * i;
  return [GX0 + 11.5 + 9 * Math.cos(a), GY0 + 11.5 + 9 * Math.sin(a)];
}));

/** @param {Uint8Array} m */
const count = (m) => m.reduce((a, v) => a + v, 0);

test("trench-admissible is admissible eroded by one edge-ring", () => {
  const gw = 8, gh = 8, cw = gw - 1;
  const ok = trenchAdmissibleCells(gw, gh, null);
  // 7x7 cells; the ring is dropped, leaving 5x5.
  assert.equal(count(ok), 25);
  for (let r = 0; r < gh - 1; r++) {
    for (let c = 0; c < cw; c++) {
      const want = r > 0 && c > 0 && r < gh - 2 && c < cw - 1;
      assert.equal(ok[r * cw + c], want ? 1 : 0, `cell ${r},${c}`);
    }
  }
});

// The hole the first review found: "not a bcell and not next to one" also admits cells wholly
// OUTSIDE the footprint, which the channel would then mesh as detached blocks of terrain beside
// the tile -- watertight, positive-volume and flat-based, so every other gate passes them.
test("no trench-admissible cell lies outside the footprint or beside its rim", () => {
  const gw = 24, gh = 24;
  const clip = clipPolygon(gw, gh, GX0, GY0, HEX);
  const ok = admissibleCells(gw, gh, clip);
  const trenchOk = trenchAdmissibleCells(gw, gh, clip);
  const cw = gw - 1;
  assert.ok(count(trenchOk) > 0, "hex footprint must leave an interior");
  for (let r = 0; r < gh - 1; r++) {
    for (let c = 0; c < cw; c++) {
      if (!trenchOk[r * cw + c]) continue;
      assert.equal(ok[r * cw + c], 1, `cell ${r},${c} is not even admissible`);
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        assert.equal(ok[(r + dr) * cw + (c + dc)], 1,
          `cell ${r},${c} is edge-adjacent to a non-admissible cell`);
      }
    }
  }
});

test("feather is 1 only where all four incident cells are trench-admissible", () => {
  const gw = 8, gh = 8;
  const trenchOk = trenchAdmissibleCells(gw, gh, null);
  const f = featherField(gw, gh, trenchOk);
  for (let r = 0; r < gh; r++) {
    for (let c = 0; c < gw; c++) {
      // vertices 2..5 in both axes are corners of trench-admissible cells only
      const want = r >= 2 && r <= 5 && c >= 2 && c <= 5;
      assert.equal(f[r * gw + c], want ? 1 : 0, `vertex ${r},${c}`);
    }
  }
});

// Per VERTEX, deliberately stricter than the all-four-corners cell rule cellsFromVertexMask uses:
// a creek narrower than a cell must still stop the channel from lowering the flattened surface
// the water inlay was moulded to.
test("a single masked water vertex is feather-dead even mid-interior", () => {
  const gw = 8, gh = 8;
  const trenchOk = trenchAdmissibleCells(gw, gh, null);
  const water = new Uint8Array(gw * gh);
  water[3 * gw + 3] = 1;
  const f = featherField(gw, gh, trenchOk, water);
  assert.equal(f[3 * gw + 3], 0, "the masked vertex must be feather-dead");
  assert.equal(f[3 * gw + 4], 1, "its neighbour must not be");
});

const GEOM = { mmPerM: 1, emin: 0, exag: 1, base: 3 };

/** @param {number} gw @param {number} pitch */
const planOf = (gw, pitch) => /** @type {any} */ ({
  window: { gx0: 0, gy0: 0, gw, gh: gw }, span: { r0: 0, r1: gw - 1, c0: 0, c1: gw - 1 },
  gw, gh: gw, dx: pitch, dy: pitch, z: 15,
});
const flat = (/** @type {number} */ n) => new Float32Array(n * n);

/** Build the channel for a trail on a flat tile. `polys` in print mm.
 *  @param {Float64Array[]} polys */
function channel(polys, { gw = 30, pitch = 1, W = 1, depth = 0.6 } = {}) {
  const plan = planOf(gw, pitch);
  const T = trenchWidthMm(W);
  const { chopped, k } = cordLattice(polys, plan, W);
  const dist = distField(chopped, plan, T / 2, k);
  const trenchOk = trenchAdmissibleCells(gw, gw, null);
  const feather = featherField(gw, gw, trenchOk);
  const out = trenchTop(flat(gw), plan, dist, k, T / 2, depth, feather, trenchOk, GEOM, gw * gw);
  return { plan, out, T, k, depth, gw, pitch, W };
}

/** A straight east-west trail down the middle. */
function straight(gw = 30, pitch = 1, W = 1, depth = 0.6) {
  const yMid = ((gw - 1) / 2) * pitch;
  return channel([Float64Array.from([2 * pitch, yMid, (gw - 3) * pitch, yMid])],
    { gw, pitch, W, depth });
}

// The coarse case is the one the carve could not hold: at dx = 0.773, an auto-fitted trail scale,
// the old cell-snapped channel spent 2.19 mm of a 3.59 mm width on ramps. Meshed on the isoline the
// floor is the full T at either pitch, which is the whole point of dropping the sqrt2*dx term.
for (const [gw, pitch] of /** @type {[number, number][]} */ ([[30, 1], [60, 0.773]])) {
  test(`the channel's flat floor is exactly T wide at dx = ${pitch}`, () => {
    const { out, T, depth } = straight(gw, pitch);
    assert.ok(out);
    // Sample the emitted surface across the channel at mid-tile; the floor is every point at full
    // depth, and its width is what the width rule promises. Measured, not derived.
    const yMid = ((gw - 1) / 2) * pitch;
    const atDepth = [];
    for (let i = 0; i < out.z.length; i++) {
      if (Math.abs(out.z[i] - (GEOM.base - depth)) < 1e-9) atDepth.push(out.y[i]);
    }
    const lo = Math.min(...atDepth), hi = Math.max(...atDepth);
    // The extremes are the crossings, which land exactly on the isoline because distance to a line
    // is affine. They are minted vertices rather than grid corners here (T/2 is not a whole number
    // of sub-cells at either pitch), so out.z carries them; if a fixture ever puts the isoline
    // through a grid corner, its displacement lands in out.drop instead and this scan would miss it.
    assert.ok(Math.abs((hi - lo) - T) < 1e-9, `flat floor spans ${hi - lo} mm, want ${T}`);
    assert.ok(Math.abs((hi + lo) / 2 - yMid) < 1e-9, "floor must be centred on the trail");
    // And the clearance the width exists to buy, which the measurement above cannot state on its
    // own: the floor has to clear the cord by FIT_MM a side at any pitch.
    assert.ok(hi - lo >= 1 + 0.2 - 1e-9, `floor ${hi - lo} mm leaves no clearance over a 1 mm cord`);
  });
}

// The open reading of chi puts the ramp INSIDE the isoline and retreats the floor by one sub-cell
// per side. This is the assertion that tells an implementer which reading they built.
test("crossings sit at full depth, not at terrain", () => {
  const { out, T, depth } = straight();
  assert.ok(out);
  const half = T / 2, yMid = 14.5;
  let checked = 0;
  for (let i = 0; i < out.z.length; i++) {
    if (Math.abs(Math.abs(out.y[i] - yMid) - half) > 1e-9) continue; // on the isoline
    assert.ok(Math.abs(out.z[i] - (GEOM.base - depth)) < 1e-9,
      `isoline vertex at z ${out.z[i]}, want ${GEOM.base - depth}`);
    checked++;
  }
  assert.ok(checked > 0, "expected vertices on the isoline");
});

test("every emitted triangle is non-degenerate and correctly wound", () => {
  const { out, gw } = straight();
  assert.ok(out);
  const xy = (/** @type {number} */ id) => id < gw * gw
    ? [(id % gw), (gw - 1 - ((id / gw) | 0))]
    : [out.x[id - gw * gw], out.y[id - gw * gw]];
  for (let i = 0; i < out.tris.length; i += 3) {
    const [ax, ay] = xy(out.tris[i]), [bx, by] = xy(out.tris[i + 1]), [cx, cy] = xy(out.tris[i + 2]);
    const a2 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    assert.ok(a2 > 1e-12, `triangle ${i / 3} has doubled area ${a2}`);
  }
});

// The bias linear interpolation puts on a curved isoline: the arc has radius T/2 and a sub-edge
// chord cuts inside it by at most h^2/(8r). Computed from the test's own pitch and k, never
// hardcoded -- and from the SUB-edge, since the parent diagonal overstates it by k^2.
test("a convex corner is biased inward by no more than h^2/(8r)", () => {
  const gw = 40, pitch = 1, W = 1;
  // A right-angle bend, so the outside of the corner is a quarter arc of radius T/2.
  const bend = [Float64Array.from([5, 20, 20, 20, 20, 5])];
  const { out, T, k } = channel(bend, { gw, pitch, W });
  assert.ok(out);
  const h = Math.SQRT2 * pitch / k, r = T / 2;
  const bias = (h * h) / (8 * r);
  const distTo = (/** @type {number} */ x, /** @type {number} */ y) => {
    const seg = (/** @type {number[]} */ a, /** @type {number[]} */ b) => {
      const ax = b[0] - a[0], ay = b[1] - a[1];
      const L2 = ax * ax + ay * ay;
      let t = L2 > 0 ? ((x - a[0]) * ax + (y - a[1]) * ay) / L2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      return Math.hypot(x - a[0] - t * ax, y - a[1] - t * ay);
    };
    return Math.min(seg([5, 20], [20, 20]), seg([20, 20], [20, 5]));
  };
  let worst = 0;
  for (let i = 0; i < out.z.length; i++) {
    if (Math.abs(out.z[i] - (GEOM.base - 0.6)) > 1e-9) continue; // full depth only
    const d = distTo(out.x[i], out.y[i]);
    assert.ok(d <= r + 1e-9, `full-depth vertex ${d} mm out, past the isoline at ${r}`);
    worst = Math.max(worst, d);
  }
  assert.ok(worst >= r - bias - 1e-9,
    `channel pinches to ${worst} mm at the corner, want at least ${r - bias}`);
  assert.ok(bias < 0.03, `bias ${bias} mm is larger than the design claims at this pitch`);
});

// The case that disqualified the cell-edge construction, and the branch's stated purpose
// (c919945, "0.4 mm means 0.4 mm"): the user's own export pitch at the z15 source cap.
test("a 0.4 mm cord seats at dx = 0.483", () => {
  const W = 0.4, pitch = 0.483, gw = 40;
  const { out, T, depth } = straight(gw, pitch, W);
  assert.ok(out, "subK must admit this cord at this pitch");
  const atDepth = [];
  for (let i = 0; i < out.z.length; i++) {
    if (Math.abs(out.z[i] - (GEOM.base - depth)) < 1e-9) atDepth.push(out.y[i]);
  }
  const floor = Math.max(...atDepth) - Math.min(...atDepth);
  assert.ok(floor >= W + 0.2 - 1e-9, `flat floor is ${floor} mm, want at least ${W + 0.2}`);
  assert.ok(Math.abs(floor - T) < 1e-9, `flat floor ${floor} must be exactly T = ${T}`);
});

test("the guard refuses a channel that would cut through the base plate", () => {
  assert.throws(() => straight(30, 1, 1, /* depth */ 4),
    /^Error: corridor: /, "a 4 mm channel in a 3 mm base must be refused");
});

// The seam is the one property this task exists to establish, and nothing above pins it: the
// "non-degenerate and correctly wound" test inspects each triangle in isolation and would pass
// on a mesh riddled with T-junctions between out.tris and its untouched neighbours. Assemble the
// FULL top -- out.tris plus the two plain triangles gridTopTris would cut for every cell
// trenchTop left unclaimed -- and check it the way a manifold is checked: exact area coverage
// (no gaps, no overlaps) and every directed edge matched by its reverse (no T-junctions), except
// the tile's own rim, which by construction has no neighbour on the other side.
//
// Built from `out.claimed`, not re-derived from `dist`: a stub `trenchTop` that returned an
// all-zero `claimed` would double-emit every trench cell here (both trenchTop's own triangles AND
// this harness's plain quad for the same cell), which the coverage assertion below catches.

/** World-mm xy for a top-surface vertex id, the same affine map trenchTop uses internally: grid
 *  ids from the plan, minted ids from `out`. An oracle, not a shortcut into the code under test. */
const xyOf = (/** @type {number} */ id, /** @type {any} */ plan, /** @type {any} */ out) => {
  const { gw, dx, dy, span } = plan;
  const { c0, r1 } = span;
  return id < out.idBase
    ? [((id % gw) - c0) * dx, (r1 - ((id / gw) | 0)) * dy]
    : [out.x[id - out.idBase], out.y[id - out.idBase]];
};

/** The full tile top: trenchTop's own triangles, plus a plain B-C-diagonal quad -- the same
 *  anti-diagonal gridTopTris and trenchTop's Pass B both use -- for every cell trenchTop left
 *  unclaimed. @returns {number[]} */
const fullTop = (/** @type {any} */ out, /** @type {any} */ plan) => {
  const { gw, gh } = plan;
  const cw = gw - 1, ch = gh - 1;
  const tris = Array.from(out.tris);
  for (let r = 0; r < ch; r++) {
    for (let c = 0; c < cw; c++) {
      if (out.claimed[r * cw + c]) continue;
      const A = r * gw + c, B = A + 1, C = A + gw, D = C + 1;
      tris.push(A, C, B, B, C, D);
    }
  }
  return tris;
};

/** A vertex on the tile's own outer boundary: minted vertices never qualify, since trenchOk is
 *  eroded one ring in from the footprint (see trenchAdmissibleCells).
 *
 *  Per-vertex, so the caller's "both ends on the rim, no partner needed" rule would also exempt an
 *  edge joining two DIFFERENT rim sides -- a diagonal across the tile. It cannot arise because
 *  every emitted edge lies within one grid cell, which is the invariant this test leans on. */
const onRim = (/** @type {number} */ id, /** @type {any} */ plan, /** @type {any} */ out) => {
  if (id >= out.idBase) return false;
  const { gw, gh } = plan;
  const col = id % gw, row = (id / gw) | 0;
  return row === 0 || row === gh - 1 || col === 0 || col === gw - 1;
};

/** Assert the full top exactly tiles the footprint (a), and is a manifold apart from its rim (b). */
const assertSeam = (/** @type {number[]} */ tris, /** @type {any} */ plan, /** @type {any} */ out) => {
  const { gw, gh, dx, dy } = plan;
  let area2 = 0;
  /** @type {Map<string, number>} */ const dir = new Map();
  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i], b = tris[i + 1], c = tris[i + 2];
    const [ax, ay] = xyOf(a, plan, out), [bx, by] = xyOf(b, plan, out), [cx, cy] = xyOf(c, plan, out);
    area2 += (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const key = `${p},${q}`;
      dir.set(key, (dir.get(key) ?? 0) + 1);
    }
  }
  const wantArea2 = 2 * (gw - 1) * (gh - 1) * dx * dy;
  assert.ok(Math.abs(area2 - wantArea2) < 1e-6,
    `doubled area ${area2}, want ${wantArea2} -- gap or overlap in the seam`);
  for (const [key, n] of dir) {
    assert.equal(n, 1, `directed edge ${key} emitted ${n} times`);
    const [p, q] = key.split(",").map(Number);
    if (onRim(p, plan, out) && onRim(q, plan, out)) continue; // the tile's own boundary, no partner
    assert.ok(dir.has(`${q},${p}`), `edge ${key} has no reverse -- a T-junction`);
  }
};

test("the full top exactly tiles the footprint with no T-junctions", () => {
  const { out, plan } = straight();
  assert.ok(out);
  assertSeam(fullTop(out, plan), plan, out);
});

// Pass C's crossing branch (trench.js:203) fires only where a trench cell abuts a cell that is
// NOT trench-admissible -- normally the eroded ring just inside the rim. A trail through the
// tile's middle never reaches it; one row in from the rim does. Confirmed by instrumentation
// (not committed) that this fixture pushes exactly 2 crossings before this test was written.
test("a near-rim trench threads crossings into the fan ring and stays manifold", () => {
  const gw = 30, pitch = 1, W = 1;
  const { plan, out } = channel([Float64Array.from([2 * pitch, 28, (gw - 3) * pitch, 28])],
    { gw, pitch, W });
  assert.ok(out, "the near-rim trail must still be meshed");
  assertSeam(fullTop(out, plan), plan, out);
});

test("a channel over feather-dead ground is emitted flat, not skipped", () => {
  // Water down the middle of the trail: the cells stay trench cells (distance alone), sub-mesh at
  // delta = 0, and stay coplanar with the parent planes -- which is what makes the seam conform.
  const gw = 30, pitch = 1, W = 1, T = trenchWidthMm(W);
  const plan = planOf(gw, pitch);
  const polys = [Float64Array.from([2, 14.5, 27, 14.5])];
  const { chopped, k } = cordLattice(polys, plan, W);
  const dist = distField(chopped, plan, T / 2, k);
  const trenchOk = trenchAdmissibleCells(gw, gw, null);
  const water = new Uint8Array(gw * gw).fill(1);
  const feather = featherField(gw, gw, trenchOk, water);
  const out = trenchTop(flat(gw), plan, dist, k, T / 2, 0.6, feather, trenchOk, GEOM, gw * gw);
  assert.ok(out, "the builder must still mesh the cells, at zero displacement");
  for (let i = 0; i < out.z.length; i++) {
    assert.ok(Math.abs(out.z[i] - GEOM.base) < 1e-9, `vertex ${i} displaced over water`);
  }
  assert.ok(out.drop.every((d) => d === 0), "no grid vertex may be displaced over water");
});

// The previous version of this test re-implemented emitRing's coverage arithmetic inline against
// earclip directly, and never called emitRing or trenchTop at all -- which is exactly how a broken
// tolerance shipped invisibly: deleting the guard in trench.js left that test green. This replaces
// it with the guard's actual regression, exercised through trenchTop.
//
// It cannot instead be a fixture that makes the guard THROW: Pass C's ring (side(), above emitRing)
// is built by two independently 1-D-parameterised walks (row-only, column-only) plus one fixed
// diagonal point, so any crossing's possible snap targets are its own immediate neighbours in the
// SAME walk -- never a point placed by the other walk, and never a non-adjacent point in its own.
// A duplicate can only land adjacent to its twin (harmless; emitRing already dedups that) or at the
// ring's own start/end (the intended closing point, also handled). No dist field, however
// adversarial, makes this ring non-simple. That is what "nothing reachable through trenchTop
// produces such a ring" (the guard's own commit) is stating as a property of the construction, not
// an untested assumption -- so there is no throwing fixture to replace the deleted one with.
//
// What the deleted tolerance actually got wrong is reachable, though: it computed area2 as an
// uncentred shoelace over tile-scale coordinates for a sub-cell-scale ring, and the resulting
// cancellation threw a FALSE refusal on real geometry, purely as a function of distance from the
// tile's own origin (see trench.js). That is what this test pins.
test("a channel far from the tile origin on a large-span plan meshes, not throws", () => {
  // The reviewer's repro: a 500 mm z13 plan at gw = gh = 3874 (dx = 0.1291), a 1 mm cord, a 0.6 mm
  // inset, trail run near the tile's far corner rather than near (0, 0).
  const gw = 3874, pitch = 0.1291, W = 1, depth = 0.6;
  const { out, plan } = channel([Float64Array.from([440, 440, 495, 495])], { gw, pitch, W, depth });
  assert.ok(out, "a far-from-origin trail on a large-span plan must mesh, not throw");
  // Not the fullTop/assertSeam manifold check the other seam tests use: that walks every one of
  // this plan's (gw-1)x(gh-1) cells to hash its edges, which is fine at trenchTop's own O(trail
  // length) cost but not at O(gw*gh) on a 3874-wide plan. Check what the guard this test pins
  // actually protects instead: every triangle IT emitted is non-degenerate and correctly wound, the
  // same property "every emitted triangle is non-degenerate and correctly wound" checks at a small
  // scale -- an under-covered ring is exactly a ring that failed this.
  for (let i = 0; i < out.tris.length; i += 3) {
    const [ax, ay] = xyOf(out.tris[i], plan, out);
    const [bx, by] = xyOf(out.tris[i + 1], plan, out);
    const [cx, cy] = xyOf(out.tris[i + 2], plan, out);
    const a2 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    assert.ok(a2 > 1e-12, `triangle ${i / 3} has doubled area ${a2}`);
  }
});

// app.js strips the `corridor: ` routing token and puts the remainder on the trail banner
// verbatim -- on the PREVIEW path as well as the export's, since a refused inset is fully
// reachable from the sliders (base min 1 mm, inset max 2 mm). So the remainder is a user-facing
// sentence, and it has to name every control that can resolve it: the tile is refusing, and which
// of the three to move is the user's call.
test("the base-cut refusal names the remedies a user can act on", () => {
  assert.throws(() => channel([Float64Array.from([2, 14.5, 27, 14.5])], { depth: GEOM.base + 1 }),
    (/** @type {Error} */ e) => {
      assert.match(e.message, /^corridor: /);
      assert.notEqual(/** @type {any} */ (e).dropCord, true,
        "the base is the TILE's problem: dropping the cord neither explains nor fixes it");
      const shown = e.message.replace(/^corridor: /, "");
      assert.match(shown, /base/);
      assert.match(shown, /exaggeration/);
      assert.match(shown, /shallower/);
      assert.ok(!/feather|sub-lattice|vertex|crossing|minFloor/.test(shown), `leaks mechanism: ${shown}`);
      return true;
    });
});
