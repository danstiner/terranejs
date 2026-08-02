// Sub-cell footprint geometry for a circular tile.
//
// layout.footprintCellMaskPx decides one bit per cell, so a footprint boundary can only
// run along cell edges — a circle comes out as a staircase. This module intersects the
// circle with the grid instead, yielding the extra boundary vertices a clipped top
// surface needs.
//
// Crossings are keyed by GRID EDGE, never by cell. Two cells share an edge, and both must
// resolve the same vertex id; independent per-cell clipping would emit coincident-but-
// distinct vertices, and mesh.assembleSolid's edge parity would then read an interior
// boundary and build a skirt wall through the middle of the tile.
//
// Circles never tile (layout.NEIGHBORS.circle is empty), so none of this needs to agree
// with a neighbouring tile — the reason this ships before the hexagon equivalent.

/** @typedef {import("./types.js").Clip} Clip */

// Snap a crossing onto a grid vertex when it lands this close, as a fraction of a cell:
// otherwise a near-coincident pair becomes a zero-area sliver. ~0.9 µm at export scale —
// far below a nozzle, and far above mesh.js's AREA2_EPS of 1e-9.
//
// This is the ONLY place a near-coincidence is collapsed, and that is the point. The decision
// is a function of one edge and its own endpoints, so both cells sharing that edge reach it
// identically. Collapsing per cell instead — after the walk, by comparing adjacent polygon
// vertices — looks equivalent but is not: whether a pair lands *adjacent* depends on the
// walk, so the corner cell sees it while a neighbour sharing only one of the two edges does
// not. One cell then drops a vertex the other keeps, the shared boundary disagrees, and
// assembleSolid closes the slit with a full-height skirt wall inside the tile. That stays
// watertight (the flap is closed), so nothing downstream can catch it.
const SNAP_EPS = 1e-3;

/**
 * Intersect a circle with the print grid. Geometry only — call clipElevs once the grid's
 * elevations are final (applyWaterRecess mutates them).
 * @param {number} gw
 * @param {number} gh
 * @param {number} cx centre column, in grid coordinates (global px − window.gx0)
 * @param {number} cy centre row, in grid coordinates (global py − window.gy0)
 * @param {number} R radius in grid cells (= global px)
 * @returns {Clip}
 */
export function clipCircle(gw, gh, cx, cy, R) {
  const R2 = R * R;
  // Dilate the inside test by SNAP_EPS so it agrees with addH/addV's snap: those snap a
  // crossing onto a grid vertex within SNAP_EPS of the *true* circle, so a vertex that
  // close must also read as inside, or the walk below can emit an outside corner collinear
  // with a same-edge crossing (a zero-area triangle downstream, regardless of that
  // crossing's distance from *other* vertices — the mesh.js dedupe alone can't catch this,
  // since collinear points have zero area at any spacing).
  const Rd = R + SNAP_EPS, Rd2 = Rd * Rd;
  const inside = new Uint8Array(gw * gh);
  for (let r = 0; r < gh; r++) {
    for (let c = 0; c < gw; c++) {
      const ex = c - cx, ey = r - cy;
      inside[r * gw + c] = ex * ex + ey * ey <= Rd2 ? 1 : 0;
    }
  }

  const HBASE = gh * (gw - 1); // vertical-edge keys start here, after the horizontal ones
  const first = gw * gh;       // first crossing vertex id
  /** @type {Map<number, number>} */
  const idOf = new Map();
  /** @type {number[]} */ const col = [];
  /** @type {number[]} */ const row = [];
  /** @type {number[]} */ const ea = [];
  /** @type {number[]} */ const eb = [];
  /** @type {number[]} */ const et = [];

  // Horizontal edge (r,c)→(r,c+1): y is fixed at r, so x solves the circle directly.
  /** @type {(r: number, c: number) => number} */
  const addH = (r, c) => {
    const key = r * (gw - 1) + c;
    const hit = idOf.get(key);
    if (hit !== undefined) return hit;
    const dy = r - cy;
    const dx = Math.sqrt(Math.max(0, R2 - dy * dy));
    let x = cx - dx;
    if (x < c || x > c + 1) x = cx + dx;
    // Near tangency dx→0 and both roots collapse to the same x=cx: if that shared value
    // lies outside [c, c+1] the swap above is a no-op, since there is no second candidate
    // to fall back to. Clamping lands t exactly on 0 or 1, which routes through the snap
    // branch below instead of allocating a vertex off the edge it's attributed to.
    x = Math.min(c + 1, Math.max(c, x));
    const t = x - c;
    const a = r * gw + c, b = a + 1;
    let id;
    if (Math.abs(t) <= SNAP_EPS) id = a;
    else if (t >= 1 - SNAP_EPS) id = b;
    else { id = first + col.length; col.push(x); row.push(r); ea.push(a); eb.push(b); et.push(t); }
    idOf.set(key, id);
    return id;
  };

  // Vertical edge (r,c)→(r+1,c): x is fixed at c, so y solves the circle directly.
  /** @type {(r: number, c: number) => number} */
  const addV = (r, c) => {
    const key = HBASE + r * gw + c;
    const hit = idOf.get(key);
    if (hit !== undefined) return hit;
    const dx = c - cx;
    const dy = Math.sqrt(Math.max(0, R2 - dx * dx));
    let y = cy - dy;
    if (y < r || y > r + 1) y = cy + dy;
    // See addH: near tangency both roots collapse to y=cy, and if that's outside [r, r+1]
    // the swap above is a no-op. Clamp so t lands on 0 or 1 and takes the snap branch.
    y = Math.min(r + 1, Math.max(r, y));
    const t = y - r;
    const a = r * gw + c, b = a + gw;
    let id;
    if (Math.abs(t) <= SNAP_EPS) id = a;
    else if (t >= 1 - SNAP_EPS) id = b;
    else { id = first + col.length; col.push(c); row.push(y); ea.push(a); eb.push(b); et.push(t); }
    idOf.set(key, id);
    return id;
  };

  // Allocate every crossing up front: the mesh pass only looks ids up, and the elevation
  // pass needs the full table before statistics run.
  for (let r = 0; r < gh - 1; r++) {
    for (let c = 0; c < gw - 1; c++) {
      const A = r * gw + c, B = A + 1, C = A + gw, D = C + 1;
      const n = inside[A] + inside[B] + inside[C] + inside[D];
      if (n === 0 || n === 4) continue;
      if (inside[C] !== inside[D]) addH(r + 1, c);
      if (inside[D] !== inside[B]) addV(r, c + 1);
      if (inside[B] !== inside[A]) addH(r, c);
      if (inside[A] !== inside[C]) addV(r, c);
    }
  }

  return { inside, idOf, col, row, ea, eb, et, elev: new Float64Array(col.length), gw, HBASE };
}

/**
 * Fill each crossing's elevation: linear along its edge, which is the piecewise-linear
 * interior surface sampled at the boundary. Call after applyWaterRecess, never before —
 * it mutates the grid.
 * @param {Clip} clip
 * @param {Float32Array} grid
 * @returns {void}
 */
export function clipElevs(clip, grid) {
  const { ea, eb, et, elev } = clip;
  for (let k = 0; k < elev.length; k++) {
    const t = et[k];
    elev[k] = grid[ea[k]] * (1 - t) + grid[eb[k]] * t;
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
