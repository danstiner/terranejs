import { test } from "node:test";
import assert from "node:assert/strict";
import { clipElevs, clipPolygon, clipRange } from "../src/core/clip.js";
import { cellWindows, footprintPx } from "../src/core/layout.js";

// A unit-square-ish convex ring placed in a 9x9 grid, in global px with a window origin, so
// every assertion below exercises the global→local path the real caller uses.
const GX0 = 1000, GY0 = 2000;
/** @param {Array<[number, number]>} pts */
const globalRing = (pts) => pts.map(([x, y]) => /** @type {[number, number]} */
  ([GX0 + x, GY0 + y]));

test("clipPolygon: rejects degenerate and non-convex rings", () => {
  assert.throws(() => clipPolygon(9, 9, GX0, GY0, globalRing([[2, 2], [6, 2]])),
    /3\+ distinct vertices/);
  assert.throws(() => clipPolygon(9, 9, GX0, GY0, globalRing([[2, 2], [4, 2], [6, 2]])),
    /zero-area/);
  // A chevron: strictly non-convex, and its reflex vertex is well away from the snap lattice.
  assert.throws(() => clipPolygon(9, 9, GX0, GY0,
    globalRing([[1, 1], [7, 1], [7, 7], [4, 3], [1, 7]])), /not convex/);
});

// Winding is normalised on entry, so a ring, its reversal, and every rotation resolve to
// the same directed edge cycle and must clip identically; rotations additionally exercise
// allocation-order independence. This can never see the canonical endpoint ordering —
// normalisation makes all variants evaluate each edge in the same direction — so that
// property is pinned by the shared-edge test below instead.
test("clipPolygon: output is invariant under ring rotation and reversal", () => {
  const pts = /** @type {Array<[number, number]>} */ ([[1.3, 1.7], [6.4, 1.2], [7.1, 6.6], [1.8, 7.3]]);
  const base = clipPolygon(9, 9, GX0, GY0, globalRing(pts));
  /** @param {Array<[number, number]>} p @param {string} label */
  const same = (p, label) => {
    const c = clipPolygon(9, 9, GX0, GY0, globalRing(p));
    assert.deepEqual([...c.inside], [...base.inside], `${label}: inside`);
    // Sorted, because rotation legitimately changes allocation order, not positions.
    assert.deepEqual([...c.col].sort((x, y) => x - y), [...base.col].sort((x, y) => x - y), `${label}: col`);
    assert.deepEqual([...c.row].sort((x, y) => x - y), [...base.row].sort((x, y) => x - y), `${label}: row`);
  };
  same([...pts].reverse(), "reversed");
  for (let k = 1; k < pts.length; k++) same([...pts.slice(k), ...pts.slice(0, k)], `rot${k}`);
});

// What the canonical (x, then y) endpoint ordering is FOR: two adjacent tiles list a shared
// border edge in opposite directions, and P + t(Q−P) is not bit-identical to Q + (1−t)(P−Q).
// Rotating or reversing ONE ring can never show this (see above), so clip two triangles
// sharing an edge traversed in opposite directions, apexes on opposite sides — exactly the
// neighbouring-tiles configuration. The edge is engineered so its y = 4 crossing is exactly
// 879/512, a Math.round half-way point: the two evaluation directions land on opposite
// sides of the tie, so without the canonical order the rings disagree by a full 1/256.
// Found by lattice search, the way clipCircle's tangent-row repro was.
test("clipPolygon: two rings sharing an edge agree on its crossings", () => {
  const A = /** @type {[number, number]} */ ([3.671875, 1.59375]);  // (940, 408)/256
  const B = /** @type {[number, number]} */ ([1.3359375, 4.46875]); // (342, 1144)/256
  const c1 = clipPolygon(9, 9, GX0, GY0, globalRing([A, B, [1, 1]])); // A→B, apex left
  const c2 = clipPolygon(9, 9, GX0, GY0, globalRing([B, A, [1, 6]])); // B→A, apex right
  /** @param {ReturnType<typeof clipPolygon>} c */
  const at = (c) => {
    for (let k = 0; k < c.col.length; k++) {
      if (c.row[k] === 4 && Math.abs(c.col[k] - 1.717) < 0.25) return c.col[k];
    }
    assert.fail("shared-edge crossing at row 4 not found");
  };
  assert.equal(at(c1), at(c2), "shared-edge crossing must be bit-identical across rings");
});

// A ring edge collinear with a grid line makes the intersection formula 0/0. This is not
// theoretical: a snapped hex flat edge landing on integral y is a positive-measure event.
test("clipPolygon: a ring edge lying on a grid line produces no NaN", () => {
  // Bottom edge exactly on y = 6, left edge exactly on x = 2.
  const clip = clipPolygon(9, 9, GX0, GY0, globalRing([[2, 2], [6.5, 1.4], [7.2, 6], [2, 6]]));
  for (let k = 0; k < clip.col.length; k++) {
    assert.ok(Number.isFinite(clip.col[k]) && Number.isFinite(clip.row[k]),
      `crossing ${k} is (${clip.col[k]}, ${clip.row[k]})`);
  }
  for (const list of clip.crossOf.values()) {
    for (const id of list) assert.ok(Number.isInteger(id) && id >= 0, `bad id ${id}`);
  }
});

// cellWindows pads by a pixel so this cannot happen in the pipeline, but a crossing minted
// outside the window would carry a col/row off the grid, and clipElevs' bilinear sample would
// then read past its end and write NaN — which loses every comparison in clipRange, silently
// dropping the crossing from the base-plane statistics it exists to constrain.
test("clipPolygon: a ring escaping the window mints no out-of-grid crossing", () => {
  const gw = 10, gh = 10;
  const clip = clipPolygon(gw, gh, GX0, GY0,
    globalRing([[2, 2], [8, 2], [8, 14.5], [2, 14.5]]));
  for (let k = 0; k < clip.col.length; k++) {
    assert.ok(clip.col[k] >= 0 && clip.col[k] <= gw - 1 && clip.row[k] >= 0 && clip.row[k] <= gh - 1,
      `crossing ${k} at (${clip.col[k]}, ${clip.row[k]}) is outside the grid`);
  }
  const grid = new Float32Array(gw * gh);
  for (let i = 0; i < grid.length; i++) grid[i] = Math.sin(i) * 100;
  clipElevs(clip, grid);
  for (let k = 0; k < clip.elev.length; k++) {
    assert.ok(Number.isFinite(clip.elev[k]), `elev ${k} is ${clip.elev[k]}`);
  }
  const { min, max } = clipRange(grid, clip);
  assert.ok(Number.isFinite(min) && Number.isFinite(max), `range ${min}..${max}`);
});

test("clipPolygon: every crossing lands on the 1/256 global lattice", () => {
  const clip = clipPolygon(9, 9, GX0, GY0,
    globalRing([[1.3, 1.7], [6.4, 1.2], [7.1, 6.6], [1.8, 7.3]]));
  assert.ok(clip.col.length > 0, "produced crossings");
  for (let k = 0; k < clip.col.length; k++) {
    for (const [v, o] of [[clip.col[k], GX0], [clip.row[k], GY0]]) {
      const g = v + o;
      assert.equal(g * 256, Math.round(g * 256), `global ${g} is not a multiple of 1/256`);
    }
  }
});

// The defining case: a corner poking through one cell side crosses that side twice, which a
// single-id table cannot express and corner parity cannot even see (both endpoints read the
// same insideness). Triangle apex just inside the top side of the cell row y=4; apex x is
// deliberately non-integral, so both y=4 crossings fall in the same column — an integral
// apex x splits them across a grid vertex onto two different unit edges.
test("clipPolygon: one grid edge can carry two crossings", () => {
  const clip = clipPolygon(9, 9, GX0, GY0, globalRing([[4.5, 3.6], [6.5, 6.5], [1.5, 6.5]]));
  const twice = [...clip.crossOf.values()].filter((l) => l.length === 2);
  assert.ok(twice.length >= 1, `expected a doubly-crossed edge, lists ${
    JSON.stringify([...clip.crossOf.values()].map((l) => l.length))}`);
});

// Snapping moves a crossing up to 1/512 cell off the exact ring, so one can land exactly on
// a grid vertex the row scan calls outside. Edge (2 − 1/256, 3)→(6, 5) crosses y = 4 at
// x = 4 − 1/512 exactly: Math.round's half-up tie snaps it onto vertex (4, 4), while the
// row scan's interval for row 4 ends at that same unsnapped 3.998… and floor() excludes
// column 4. Without forcing at placement, the rim touches a vertex the mask calls outside —
// the collinear zero-area fan case.
test("clipPolygon: a crossing snapped onto a grid vertex forces it inside", () => {
  const clip = clipPolygon(9, 9, GX0, GY0,
    globalRing([[2 - 1 / 256, 3], [6, 5], [3, 7], [1, 5]]));
  assert.equal(clip.inside[4 * 9 + 4], 1, "vertex (4,4) carries a snapped crossing");
});

// Bilinear must be an exact generalisation of the edge lerp, not merely a close one: an
// integral coordinate gives the opposite weight exactly 1, and 1*x and x+0 are exact.
test("clipElevs: an integral coordinate reproduces the edge lerp exactly", () => {
  const gw = 9, gh = 9;
  const grid = new Float32Array(gw * gh);
  for (let i = 0; i < grid.length; i++) grid[i] = Math.sin(i) * 100;
  const clip = clipPolygon(gw, gh, GX0, GY0,
    globalRing([[1.3, 1.7], [6.4, 1.2], [7.1, 6.6], [1.8, 7.3]]));
  clipElevs(clip, grid);
  let checked = 0;
  for (let k = 0; k < clip.col.length; k++) {
    const x = clip.col[k], y = clip.row[k];
    if (Number.isInteger(y)) {
      const c0 = Math.floor(x), t = x - c0;
      const want = grid[y * gw + c0] * (1 - t) + grid[y * gw + c0 + 1] * t;
      assert.equal(clip.elev[k], want, `horizontal crossing ${k}`);
      checked++;
    } else if (Number.isInteger(x)) {
      const r0 = Math.floor(y), t = y - r0;
      const want = grid[r0 * gw + x] * (1 - t) + grid[(r0 + 1) * gw + x] * t;
      assert.equal(clip.elev[k], want, `vertical crossing ${k}`);
      checked++;
    }
  }
  assert.ok(checked > 0, "exercised at least one edge crossing");
});

// The guarantee this whole design exists for, stated as the property itself rather than by
// naming points: across two tiles, PROXIMITY IMPLIES IDENTITY. Any two rim points closer than
// half the snap quantum (1/512) must be the exact same numbers. This needs no shared-segment
// selection and no key that could alias — nothing is bucketed or classified, every pair of
// nearby points is judged on its own, so it cannot be fooled the way two earlier naming
// schemes were: a coarse spatial bucket collided a ring corner with a nearby crossing
// (~0.009px apart), and an exact-but-not-unique grid-edge id collided two tiles' non-shared
// edges crossing the same grid edge near a triple vertex. 1/512 is
// sound and is not a tolerance on the guarantee itself: vertices are interned by snapped
// position (clip.js's `vid`), so two genuinely distinct rim points differ by at least 1/256 in
// some coordinate — the same fact `assertSane` in test/mesh.test.mjs relies on (rim separation
// > 3e-3). A threshold at half the quantum cannot pull in two distinct points; anything it does
// pull in is two tiles' versions of one seam point, compared here with exact equality.
//
// Both neighbour directions are covered because they fail differently: (1,0) shares a
// 60-degree edge, (0,1) shares a FLAT one, and a flat edge lies exactly on the window's y
// extreme — the case where rounding the window inward truncated the rim in one tile while the
// other clipped past it.
//
// Floor rationale: the smallest exact-coincidence count observed across all 24 k * 2 directions
// is 1942 (a "flat" pair), re-measured after rimPoints was switched to
// read crossOf/ringOf instead of col/row directly (same figure — a correctly sized window keeps
// everything col/row has, so the two only diverge when the window is wrong, which is exactly
// what this test must catch). 900, comfortably under half of that, still catches a near-empty
// intersection without being tuned to today's exact geometry.
test("clipPolygon: adjacent hex tiles agree exactly on their shared edge", () => {
  const scale = 250000, tileWidthMm = 200, z = 13;
  for (let k = 0; k < 24; k++) {
    const center = /** @type {[number, number]} */ ([47.6035, -122.3294 + k * 0.0009]);
    for (const [nbr, label] of /** @type {const} */ ([[[1, 0], "60deg"], [[0, 1], "flat"]])) {
      const a = rimPoints(center, scale, tileWidthMm, [0, 0], z);
      const b = rimPoints(center, scale, tileWidthMm, /** @type {[number, number]} */ (nbr), z);
      const coincidences = exactCoincidences(a, b, `k=${k} ${label}`);
      assert.ok(coincidences >= 900,
        `k=${k} ${label}: only ${coincidences} exact coincidences on the seam`);
    }
  }
});

// Guards the seam test's METHOD rather than the clipper. That test asserts a property of two
// correctly sized windows, so it stays green under any change that makes rimPoints blind to the
// window — which is exactly how its first green version behaved: it read col/row, populated
// before the bounds check, and so could not see the Task 1 truncation it existed to catch.
// Shrinking one tile's window must therefore destroy the agreement outright. If this ever
// reports a coincidence again, the seam test above has stopped proving anything.
test("clipPolygon: the seam test's rim points are window-sensitive", () => {
  const scale = 250000, tileWidthMm = 200, z = 13;
  const center = /** @type {[number, number]} */ ([47.6035, -122.3294]);
  const a = rimPoints(center, scale, tileWidthMm, [0, 0], z);
  assert.ok(exactCoincidences(a, rimPoints(center, scale, tileWidthMm, [0, 1], z), "intact") >= 900,
    "control: the intact pair must agree, or the shrink below proves nothing");
  assert.equal(exactCoincidences(a, rimPoints(center, scale, tileWidthMm, [0, 1], z, 2), "shrunk"), 0,
    "a 2px window shrink must leave no rim point in common");
});

// Crossings must snap in the GLOBAL frame. Snapping the window-local sum rounds at a
// frame-dependent ulp — adjacent tiles have different window origins — so a crossing whose
// exact position sits within a float ulp of a Math.round half-tie of the 1/256 lattice can
// resolve one full quantum apart in the two tiles. The seam test above is structurally blind
// to that: its proximity gate only compares pairs closer than HALF a quantum (soundness
// argument at exactCoincidences), so a diverged pair is never compared at all and the
// coincidence floor absorbs the missing point. Pin the divergence directly instead: at this
// config (found by sweep over real layouts, like the 879/512 direction tie) the shared-edge
// crossing at x = 605303 minted y = 758624.08984375 in tile (0,0)'s frame and
// y = 758624.0859375 in tile (1,0)'s — exactly 1/256 apart.
test("clipPolygon: crossing snap is window-frame independent", () => {
  const center = /** @type {[number, number]} */ ([44.492, -76.11719999999991]);
  const scale = 24000, tileWidthMm = 200, z = 13;
  /** @param {[number, number]} cell */
  const yAt = (cell) => {
    const ys = rimPoints(center, scale, tileWidthMm, cell, z)
      .filter(([x, y]) => x === 605303 && Math.abs(y - 758624.088) < 0.02)
      .map(([, y]) => y);
    assert.equal(ys.length, 1, `(${cell}): one shared-edge crossing at x=605303, got [${ys}]`);
    return ys[0];
  };
  assert.equal(yAt([0, 0]), yAt([1, 0]),
    "a shared crossing must be bit-identical whichever tile's window frame computes it");
});

/**
 * Rim points from two tiles that land within half the snap quantum of each other, asserting
 * every such pair is bit-identical and returning how many there were. Spatial hash of A on the
 * quantum grid, so each B point scans its 3x3 neighbourhood rather than all of A — O(n) instead
 * of O(n^2) for ~14000-point rims.
 * @param {Array<[number, number]>} a @param {Array<[number, number]>} b @param {string} label
 * @returns {number}
 */
function exactCoincidences(a, b, label) {
  const HALF = 1 / 512; // half the 1/256 snap quantum
  const bucket = (/** @type {number} */ v) => Math.floor(v * 256);
  /** @type {Map<string, Array<[number, number]>>} */
  const grid = new Map();
  for (const p of a) {
    const gk = `${bucket(p[0])},${bucket(p[1])}`;
    let l = grid.get(gk);
    if (!l) { l = []; grid.set(gk, l); }
    l.push(p);
  }
  let n = 0;
  for (const p of b) {
    const bx = bucket(p[0]), by = bucket(p[1]);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cands = grid.get(`${bx + dx},${by + dy}`);
        if (!cands) continue;
        for (const q of cands) {
          if (Math.hypot(p[0] - q[0], p[1] - q[1]) >= HALF) continue;
          n++;
          assert.equal(q[0], p[0], `${label}: x, A=(${q[0]},${q[1]}) B=(${p[0]},${p[1]})`);
          assert.equal(q[1], p[1], `${label}: y, A=(${q[0]},${q[1]}) B=(${p[0]},${p[1]})`);
        }
      }
    }
  }
  return n;
}

// A tile's rim points in GLOBAL px, sourced from clip.crossOf/clip.ringOf — the structures the
// mesh boundary actually walks — NOT from clip.col/clip.row directly. clip.js's `place()` calls
// `vid(x, y)`, which appends to col/row, BEFORE the window-bounds check that gates whether the
// id joins crossOf/ringOf (clip.js:130-139). So col/row MEMBERSHIP is ungated — it holds every
// point clipPolygon ever considered, whatever gw/gh are — while crossOf/ringOf hold only the
// ones the window actually kept. (The stored values are still window-relative, which is why
// gx0/gy0 are added back below; it is the membership, not the coordinate frame, that is
// insensitive to the window.) Walking col/row directly is therefore blind to a truncated
// window — exactly the Task 1 defect this test exists to catch — so it must not be the source.
/**
 * `shrink` insets the window by that many px on every side, leaving the ring untouched — the
 * deliberate truncation the window-sensitivity test needs, and nothing a caller would ever do.
 * @param {[number, number]} center @param {number} scale @param {number} tileWidthMm
 * @param {[number, number]} cell @param {number} z @param {number} [shrink]
 * @returns {Array<[number, number]>}
 */
function rimPoints(center, scale, tileWidthMm, cell, z, shrink = 0) {
  const { wins } = cellWindows(center, scale, tileWidthMm, [cell], z, "hex");
  const full = /** @type {import("../src/core/types.js").Window} */
    (wins.get(`${cell[0]},${cell[1]}`));
  const win = shrink === 0 ? full : { ...full, gx0: full.gx0 + shrink, gy0: full.gy0 + shrink,
    gw: full.gw - 2 * shrink, gh: full.gh - 2 * shrink };
  const ring = /** @type {Array<[number, number]>} */
    (footprintPx(center, scale, tileWidthMm, cell, z, "hex"));
  const clip = clipPolygon(win.gw, win.gh, win.gx0, win.gy0, ring);
  const first = clip.gw * clip.gh; // clip.js: ids below this are grid vertices, not boundary ids
  /** @type {Set<number>} */
  const ids = new Set();
  for (const list of clip.crossOf.values()) for (const id of list) ids.add(id);
  for (const list of clip.ringOf.values()) for (const id of list) ids.add(id);
  /** @type {Array<[number, number]>} */
  const out = [];
  for (const id of ids) {
    // clip.js:118-125 documents that every crossOf/ringOf id has exactly one (crossOf) or zero
    // (ringOf) integral coordinates, so it is always minted via col.push/row.push, never reused
    // from a grid vertex — id must be >= first. A violation means that invariant no longer
    // holds and this test should fail loudly rather than silently reading garbage.
    if (id < first) throw new Error(`rimPoints: boundary id ${id} below first crossing id ${first}`);
    out.push([clip.col[id - first] + win.gx0, clip.row[id - first] + win.gy0]);
  }
  return out;
}

// The seam's endpoints. A corner that snaps onto a grid vertex never reaches clip.col/row,
// so assert on the rings, where both tiles' corners are unconditionally comparable.
test("footprintPx: adjacent hex tiles mint identical shared corners", () => {
  const scale = 250000, tileWidthMm = 200, z = 13;
  for (let k = 0; k < 24; k++) {
    const center = /** @type {[number, number]} */ ([47.6035, -122.3294 + k * 0.0009]);
    for (const [nbr, label] of /** @type {const} */ ([[[1, 0], "60deg"], [[0, 1], "flat"]])) {
      const key = (/** @type {[number, number]} */ p) => `${p[0]},${p[1]}`;
      const a = /** @type {Array<[number, number]>} */
        (footprintPx(center, scale, tileWidthMm, [0, 0], z, "hex")).map(key);
      const b = new Set(/** @type {Array<[number, number]>} */
        (footprintPx(center, scale, tileWidthMm, /** @type {[number, number]} */ (nbr), z, "hex")).map(key));
      assert.equal(a.filter((p) => b.has(p)).length, 2,
        `k=${k} ${label}: adjacent hexes must share exactly 2 corners, bit-for-bit`);
    }
  }
});

// clipRange's whole reason to exist over resample.gridRange: emin sets the base plane, and a
// crossing interpolated toward a lower OUTSIDE sample can sit below every inside sample — take
// the range over inside samples alone and the surface cuts into its own base. The other half is
// the bug the footprint masks originally fixed: a whole outside sample, however extreme, must
// not reach the range, because it never prints. Both directions are asserted here, on a grid
// built so the two failures are unmissable (inside 100, near-outside 0, far-outside ±9999).
test("clipRange: crossings set the floor, whole-outside samples never do", () => {
  const gw = 9, gh = 9;
  // Offset from the integers so the ring's edges cut through cells rather than lying on grid
  // lines — the collinear case is pinned separately above and would produce no crossings here.
  const clip = clipPolygon(gw, gh, GX0, GY0,
    globalRing([[2.5, 2.5], [6.5, 2.5], [6.5, 6.5], [2.5, 6.5]]));
  const grid = new Float32Array(gw * gh);
  for (let i = 0; i < grid.length; i++) grid[i] = clip.inside[i] ? 100 : 0;
  // Two samples far enough from the ring that no crossing interpolates toward them: corners
  // (0,0) and (8,0). If either reaches the range, clipRange is scanning outside terrain.
  grid[0] = -9999;
  grid[gw - 1] = 9999;
  clipElevs(clip, grid);
  const { min, max } = clipRange(grid, clip);

  assert.ok(clip.elev.length > 0, "the ring must actually produce crossings");
  assert.equal(max, 100, `max must be the inside plateau, not the +9999 outside corner (${max})`);
  assert.ok(min < 100, `a rim crossing must pull min below every inside sample (${min})`);
  assert.ok(min > 0, `min must come from a crossing, not the -9999 outside corner (${min})`);
  assert.equal(min, Math.min(...clip.elev), "and that floor is the lowest crossing");
});
