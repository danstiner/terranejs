// Sub-cell footprint geometry for a clipped tile (hex, circle).
//
// The old per-cell bit mask decided one bit per cell, so a footprint boundary could only run
// along cell edges — a hex came out with two clean faces and four stepped ones. This module
// intersects the footprint polygon with the grid instead, yielding the extra boundary vertices
// a clipped top surface needs.
//
// Crossings are keyed by GRID EDGE, never by cell. Two cells share an edge, and both must
// resolve the same vertex ids; independent per-cell clipping would emit coincident-but-
// distinct vertices, and mesh.assembleSolid's edge parity would then read an interior
// boundary and build a skirt wall through the middle of the tile. The same discipline is what
// makes two adjacent hex tiles agree on their shared edge.

/** @typedef {import("./types.js").Clip} Clip */

// Snap lattice: 1/256 of a cell. Rounding, not a distance threshold, because a threshold is
// not transitive — a snaps to b, b to c, a and c stay distinct — which only holds while at
// most one crossing lands on an edge, and multi-crossing edges break that. Rounding to a
// fixed lattice is transitive and order-independent by construction: equal values are equal,
// and no comparison is made. 1/256 is dyadic, so a shared crossing's coordinates are
// bit-identical in two tiles rather than merely close.
const SNAP_DEN = 256;
/** @type {(v: number) => number} */
const snap = (v) => Math.round(v * SNAP_DEN) / SNAP_DEN;

/**
 * Intersect a convex polygon with the print grid. Geometry only — call clipElevs once the
 * grid's elevations are final (applyWaterRecess mutates them).
 * @param {number} gw
 * @param {number} gh
 * @param {number} gx0 window origin, global px
 * @param {number} gy0 window origin, global px
 * @param {Array<[number, number]>} ring closed convex polygon in global px
 * @returns {Clip}
 */
export function clipPolygon(gw, gh, gx0, gy0, ring) {
  // Snap in GLOBAL px, then shift to window-local. Both operands then sit on the 1/256
  // lattice below 2^24, so the subtraction is exact (not by Sterbenz — the operands are not
  // within a factor of two near the Mercator origin — but because the difference is
  // representable), and two tiles derive bit-identical local coordinates from one global value.
  /** @type {Array<[number, number]>} */
  const P = [];
  for (const [gx, gy] of ring) {
    const x = snap(gx) - gx0, y = snap(gy) - gy0;
    const last = P[P.length - 1];
    if (last && last[0] === x && last[1] === y) continue;
    P.push([x, y]);
  }
  while (P.length > 1 && P[0][0] === P[P.length - 1][0] && P[0][1] === P[P.length - 1][1]) P.pop();
  if (P.length < 3) throw new Error("clipPolygon: ring needs 3+ distinct vertices after snapping");

  const n = P.length;
  let A2 = 0;
  for (let i = 0; i < n; i++) {
    const a = P[i], b = P[(i + 1) % n];
    A2 += a[0] * b[1] - b[0] * a[1];
  }
  if (A2 === 0) throw new Error("clipPolygon: zero-area ring");
  if (A2 < 0) P.reverse(); // normalize winding so the half-plane test below is well defined
  for (let i = 0; i < n; i++) {
    const a = P[i], b = P[(i + 1) % n], c = P[(i + 2) % n];
    if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) < 0) {
      throw new Error("clipPolygon: ring is not convex");
    }
  }

  // Inside mask. Convex ⇒ each grid row meets the polygon in exactly one interval, so solve
  // per row in O(gh·n) rather than testing every vertex against every edge, which is
  // O(gw·gh·n) — about 4e9 at export size. ceil/floor include exact integers, so a vertex on
  // the boundary reads inside, matching the cross ≥ 0 predicate this stands in for.
  const inside = new Uint8Array(gw * gh);
  for (let r = 0; r < gh; r++) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const a = P[i], b = P[(i + 1) % n];
      if (a[1] === b[1]) {
        if (a[1] === r) { lo = Math.min(lo, a[0], b[0]); hi = Math.max(hi, a[0], b[0]); }
        continue;
      }
      if ((r < a[1] && r < b[1]) || (r > a[1] && r > b[1])) continue;
      const x = a[0] + ((r - a[1]) / (b[1] - a[1])) * (b[0] - a[0]);
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
    if (lo > hi) continue;
    const c0 = Math.max(0, Math.ceil(lo)), c1 = Math.min(gw - 1, Math.floor(hi));
    for (let c = c0; c <= c1; c++) inside[r * gw + c] = 1;
  }

  const HBASE = gh * (gw - 1); // vertical-edge keys start here, after the horizontal ones
  const first = gw * gh;       // first crossing vertex id
  /** @type {Map<number, number[]>} */ const crossOf = new Map();
  /** @type {Map<number, number[]>} */ const ringOf = new Map();
  /** @type {Set<number>} */ const bcells = new Set();
  /** @type {Map<string, number>} */ const idAt = new Map();
  /** @type {number[]} */ const col = [];
  /** @type {number[]} */ const row = [];

  // Intern every extra vertex by its SNAPPED POSITION, not by which ring edge produced it:
  // two crossings from different edges that snap together are one vertex. mesh.cellPoly dedups
  // by id, so without this they stay two ids at one point, and the hull's collinear drop does
  // not save it — a monotone chain takes its two sweep extremes unconditionally, so a duplicate
  // landing on one is kept and a zero-length rim edge reaches the mesh.
  /** @type {(x: number, y: number) => number} */
  const vid = (x, y) => {
    if (Number.isInteger(x) && Number.isInteger(y) &&
        x >= 0 && x < gw && y >= 0 && y < gh) return y * gw + x; // a grid vertex, reuse its id
    const k = `${x},${y}`;
    let id = idAt.get(k);
    if (id === undefined) { id = first + col.length; col.push(x); row.push(y); idAt.set(k, id); }
    return id;
  };
  /** @type {(key: number, id: number) => void} */
  const addCross = (key, id) => {
    let l = crossOf.get(key);
    if (l === undefined) { l = []; crossOf.set(key, l); }
    if (!l.includes(id)) l.push(id);
  };
  // A crossing at (x, y) with y integral lies ON horizontal grid line y, not on the vertical
  // edge spanning row floor(y) — floor() is ambiguous there, so attribution is by which line
  // the point is on. With both integral it is a grid vertex: it joins no edge list, and is
  // forced inside HERE, at placement. Snapping moves a crossing up to 1/512 cell off the
  // exact ring, so it can land on a vertex the row scan calls outside; a cell would then
  // collect a rim point at a corner it believes is outside — the collinear zero-area fan
  // the old dilation prevented. A later sweep over crossOf cannot do this: every id there
  // has exactly one integral coordinate, so a grid vertex never appears in any edge's list.
  // Every branch gates on the window BEFORE minting an id. Outside it there is no slot to
  // force and no cell that could ever reference the point, while an id minted anyway gets a
  // col/row pair off the grid — which clipElevs would then bilinear-sample out of bounds,
  // writing NaN into elev and poisoning clipRange's min/max.
  /** @type {(x: number, y: number) => void} */
  const place = (x, y) => {
    const ix = Number.isInteger(x), iy = Number.isInteger(y);
    if (ix && iy) {
      if (x >= 0 && x < gw && y >= 0 && y < gh) inside[y * gw + x] = 1;
    } else if (iy) {
      const c = Math.floor(x);
      if (y >= 0 && y < gh && c >= 0 && c < gw - 1) addCross(y * (gw - 1) + c, vid(x, y));
    } else if (ix) {
      const r = Math.floor(y);
      if (x >= 0 && x < gw && r >= 0 && r < gh - 1) addCross(HBASE + r * gw + x, vid(x, y));
    } else {
      const r = Math.floor(y), c = Math.floor(x);
      if (r >= 0 && r < gh - 1 && c >= 0 && c < gw - 1) {
        const ck = r * (gw - 1) + c;
        let l = ringOf.get(ck);
        if (l === undefined) { l = []; ringOf.set(ck, l); }
        const id = vid(x, y);
        if (!l.includes(id)) l.push(id);
        bcells.add(ck);
      }
    }
  };

  for (const [x, y] of P) place(x, y);

  for (let i = 0; i < n; i++) {
    // Canonical (x, then y) endpoint order: P + t(Q−P) and Q + (1−t)(P−Q) are not
    // bit-identical, so without this two tiles compute different values for a shared edge.
    const u = P[i], v = P[(i + 1) % n];
    const [p, q] = (u[0] < v[0] || (u[0] === v[0] && u[1] <= v[1])) ? [u, v] : [v, u];
    // Crossings snap in the GLOBAL frame, like the ring vertices above. p[1] + gy0 restores
    // the exact snapped global value (the entry shift was exact, so adding the origin back
    // is too), making the sum — and its rounding — identical in every window; the trailing
    // −gy0 is exact by the same representability argument. Snapping the window-local sum
    // instead rounds at a frame-dependent ulp, and a crossing near a lattice half-tie then
    // resolved one full quantum apart in two adjacent tiles (~1 in 2000 hex pairs), breaking
    // the bit-identical seam. t is frame-independent already: X − p[0] and the deltas are
    // differences of lattice values, exact in every frame.
    // Vertical grid lines strictly between the endpoints.
    if (q[0] !== p[0]) {
      for (let X = Math.floor(p[0]) + 1; X <= Math.ceil(q[0]) - 1; X++) {
        if (X <= p[0] || X >= q[0]) continue;
        const t = (X - p[0]) / (q[0] - p[0]);
        place(X, snap(p[1] + gy0 + t * (q[1] - p[1])) - gy0);
      }
    }
    // Horizontal grid lines. A ring edge collinear with one makes the formula 0/0 — reachable,
    // since a snapped hex flat edge landing on integral y is a positive-measure event. Skip it:
    // its endpoints are already interned as ring vertices.
    if (q[1] !== p[1]) {
      const ylo = Math.min(p[1], q[1]), yhi = Math.max(p[1], q[1]);
      for (let Y = Math.floor(ylo) + 1; Y <= Math.ceil(yhi) - 1; Y++) {
        if (Y <= ylo || Y >= yhi) continue;
        const t = (Y - p[1]) / (q[1] - p[1]);
        place(snap(p[0] + gx0 + t * (q[0] - p[0])) - gx0, Y);
      }
    }
  }

  // Boundary cells, derived from the table rather than by scanning: each crossing touches the
  // (at most) two cells sharing its edge. Corner insideness classifies everything else, which
  // is sound exactly because the boundary provably does not touch those cells.
  for (const [key, list] of crossOf) {
    if (!list.length) continue;
    if (key < HBASE) {
      const Y = Math.floor(key / (gw - 1)), c = key - Y * (gw - 1);
      if (Y > 0) bcells.add((Y - 1) * (gw - 1) + c);
      if (Y < gh - 1) bcells.add(Y * (gw - 1) + c);
    } else {
      const k = key - HBASE, r = Math.floor(k / gw), X = k - r * gw;
      if (X > 0) bcells.add(r * (gw - 1) + X - 1);
      if (X < gw - 1) bcells.add(r * (gw - 1) + X);
    }
  }

  // Order each edge's crossings along the edge so consumers get them monotonically.
  for (const [key, list] of crossOf) {
    if (list.length < 2) continue;
    const along = key < HBASE
      ? (/** @type {number} */ id) => (id < first ? id % gw : col[id - first])
      : (/** @type {number} */ id) => (id < first ? (id / gw) | 0 : row[id - first]);
    list.sort((a, b) => along(a) - along(b));
  }

  return { inside, crossOf, ringOf, bcells, col, row,
    elev: new Float64Array(col.length), gw, gh, HBASE };
}

/**
 * Fill each crossing's elevation by bilinear sample of the grid at (col, row) — the
 * piecewise-linear interior surface evaluated at the boundary. Ring corners sit in cell
 * interiors and have no incident grid edge, so an edge lerp cannot express them. With one
 * coordinate integral the opposite weight is exactly 1 and the sample reduces to the edge
 * lerp. That reduction is bit-exact for elevation data, but not unconditionally: b−a is exact
 * in float64 for float32 inputs and t is dyadic (the 1/256 snap lattice), so (b−a)·t is exact
 * too, leaving a + (b−a)·t to round only when a and b−a are far enough apart in exponent to
 * overflow the mantissa — which meters of terrain never are. Call after applyWaterRecess,
 * never before — it mutates the grid.
 * @param {Clip} clip
 * @param {Float32Array} grid
 * @returns {void}
 */
export function clipElevs(clip, grid) {
  const { col, row, elev, gw } = clip;
  for (let k = 0; k < elev.length; k++) {
    const x = col[k], y = row[k];
    const c0 = Math.floor(x), r0 = Math.floor(y);
    const fx = x - c0, fy = y - r0;
    // Clamp the far corner when a coordinate is integral: its weight is exactly 0, so the
    // sample is discarded, but reading it unclamped would run past the grid's last row/column.
    const c1 = fx === 0 ? c0 : c0 + 1, r1 = fy === 0 ? r0 : r0 + 1;
    const top = grid[r0 * gw + c0] + (grid[r0 * gw + c1] - grid[r0 * gw + c0]) * fx;
    const bot = grid[r1 * gw + c0] + (grid[r1 * gw + c1] - grid[r1 * gw + c0]) * fx;
    elev[k] = top + (bot - top) * fy;
  }
}

/**
 * Elevation range over exactly the printed surface: inside samples plus rim crossings.
 * Crossings matter because emin sets the base plane — one interpolated toward a lower
 * outside sample can sit below every inside sample, and the surface would then cut into
 * its own base. Including whole outside samples instead would let terrain that never
 * prints set the base plane, which is the bug the footprint masks fixed.
 * @param {Float32Array} grid
 * @param {Clip} clip
 * @returns {{ min: number, max: number }}
 */
export function clipRange(grid, clip) {
  const { inside, elev } = clip;
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < grid.length; i++) {
    if (!inside[i]) continue;
    const v = grid[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  for (let k = 0; k < elev.length; k++) {
    const v = elev[k];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}
