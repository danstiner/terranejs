// The trail channel, meshed on the cord's own sub-lattice rather than carved into the elevation
// grid. The grid IS the resolution of a heightfield, so a carve can only put the channel's edge on
// a grid vertex; this puts it on the isoline instead, which is what lets the channel be
// W + 2·FIT_MM wide instead of W + 2·(√2·dx + FIT_MM).
//
// See docs/superpowers/specs/2026-08-12-sub-lattice-trench-design.md.

import { admissibleCells, subElev, subClip } from "./cord.js";
import { earclip } from "./mesh.js";

/** @typedef {import("./types.js").Clip} Clip */
/** @typedef {import("./pipeline.js").TilePlan} TilePlan */

/**
 * Cells the channel may be meshed into: the cord's own admissible mask, eroded by one edge-ring.
 *
 * The extra ring is what buys the transition somewhere to live. A cell carrying the channel has
 * subdivided edges, so its edge-neighbors have to be retriangulated to match — and a boundary
 * cell cannot be: its top is cellPoly's convex hull, which deliberately drops non-extremal points
 * and so cannot be made to pass through k+1 vertices on one of its sides. Eroding here means the
 * neighbor is always an ordinary two-triangle cell.
 *
 * Stated as a delta from admissibleCells rather than re-derived, and that is load-bearing: the
 * obvious rewrite ("not a bcell, and not edge-adjacent to one") also admits cells wholly OUTSIDE
 * the footprint, which is the normal case wherever the trail leaves the tile. Those would mesh as
 * detached blocks of terrain beside the tile — closed, positive-volume and flat-based, so every
 * validation gate would pass them.
 *
 * @param {number} gw @param {number} gh @param {Clip | null} [clip]
 * @returns {Uint8Array}
 */
export function trenchAdmissibleCells(gw, gh, clip) {
  const ok = admissibleCells(gw, gh, clip);
  const cw = gw - 1, ch = gh - 1;
  const out = new Uint8Array(cw * ch);
  for (let r = 1; r < ch - 1; r++) {
    for (let c = 1; c < cw - 1; c++) {
      const i = r * cw + c;
      if (ok[i] && ok[i - cw] && ok[i + cw] && ok[i - 1] && ok[i + 1]) out[i] = 1;
    }
  }
  return out;
}

/**
 * The displacement's lateral envelope: 1 where the channel may reach full depth, 0 where it may
 * not, on PARENT grid vertices.
 *
 * Binary at vertices, and continuous in between — the ramp is the interpolation, not the field.
 * Two zeroed corners put delta = 0 along their whole shared edge, so the channel fades out before
 * a border it cannot cross instead of ending in a depth-tall step.
 *
 * Both builders sample this through subElev, the terrain's own per-triangle interpolation. That
 * one shared rule is the entire congruence argument: two piecewise-linear interpolants of the same
 * field at different lattice resolutions disagree between samples, and one rule cannot.
 *
 * Water is refused per VERTEX, not per cell. An all-four-corners rule would let the channel lower
 * a flattened shore vertex, and the drop-in inlay moulded to that surface would no longer seat.
 *
 * @param {number} gw @param {number} gh
 * @param {Uint8Array} trenchOk @param {Uint8Array} [waterMask]
 * @returns {Float32Array}
 */
export function featherField(gw, gh, trenchOk, waterMask) {
  const f = new Float32Array(gw * gh).fill(1);
  const cw = gw - 1, ch = gh - 1;
  for (let r = 0; r < ch; r++) {
    for (let c = 0; c < cw; c++) {
      if (trenchOk[r * cw + c]) continue;
      const A = r * gw + c;
      f[A] = 0; f[A + 1] = 0; f[A + gw] = 0; f[A + gw + 1] = 0;
    }
  }
  if (waterMask) for (let i = 0; i < f.length; i++) if (waterMask[i]) f[i] = 0;
  return f;
}

/**
 * The tile's top over the channel: trench cells sub-clipped against the isoline, and their
 * edge-neighbors retriangulated so the two meet vertex-for-vertex.
 *
 * Returns the extra vertices it minted (addressed from `idBase`), the displacement it applied to
 * PARENT grid vertices, and the cells it claimed — buildSolid skips those and emits the rest as
 * before. Grid corners keep their grid ids rather than being re-minted, because the plain cells
 * around the channel reference them and two ids at one position is a weld failure, not a seam.
 *
 * @param {Float32Array} grid @param {TilePlan} plan
 * @param {Map<number, number>} dist distance field, stamped at `half`, shared with the cord
 * @param {number} k @param {number} half channel half-width, T/2
 * @param {number} depthMm @param {Float32Array} feather @param {Uint8Array} trenchOk
 * @param {{ mmPerM: number, emin: number, exag: number, base: number }} geom
 * @param {number} idBase first id this builder may mint (gw*gh + rim crossings)
 * @returns {{ tris: Uint32Array, x: Float64Array, y: Float64Array, z: Float64Array,
 *   drop: Float64Array, claimed: Uint8Array, idBase: number } | null}
 */
export function trenchTop(grid, plan, dist, k, half, depthMm, feather, trenchOk, geom, idBase) {
  const { gw, gh, dx, dy, span } = plan;
  const { c0, r1 } = span;
  const { mmPerM, emin, exag, base } = geom;
  const relK = mmPerM * exag;
  const cw = gw - 1, ch = gh - 1;
  const maxC = cw * k, strideC = maxC + 1;
  if (dist.size === 0) return null;

  /** @type {number[]} */ const X = [];
  /** @type {number[]} */ const Y = [];
  /** @type {number[]} */ const Z = [];
  const drop = new Float64Array(gw * gh);
  const claimed = new Uint8Array(cw * ch);
  let minFloor = Infinity;

  const inside = (/** @type {number} */ key) => (dist.get(key) ?? Infinity) <= half;
  const terrainAt = (/** @type {number} */ col, /** @type {number} */ row) =>
    base + (subElev(grid, gw, gh, col, row) - emin) * relK;
  // The one interpolation rule, shared with the cord: feather rides the terrain's OWN triangles.
  const featherAt = (/** @type {number} */ col, /** @type {number} */ row) =>
    subElev(feather, gw, gh, col, row);
  const mint = (/** @type {number} */ col, /** @type {number} */ row, /** @type {boolean} */ chi) => {
    const z = terrainAt(col, row) - (chi ? depthMm * featherAt(col, row) : 0);
    if (chi && z < minFloor) minFloor = z;
    X.push((col - c0) * dx); Y.push((r1 - row) * dy); Z.push(z);
    return idBase + X.length - 1;
  };
  const { lattice, crossing, clipTri } = subClip(dist, half, k, strideC,
    (key, col, row) => {
      const chi = (dist.get(key) ?? Infinity) <= half;
      const R = (key / strideC) | 0, C = key - R * strideC;
      // A grid corner keeps its grid id and records its displacement instead of minting a vertex.
      // Safe because feather is 0 wherever a displaced corner would be shared with a cell this
      // builder does not mesh — see the plan's invariant 3.
      if (C % k === 0 && R % k === 0) {
        const gid = (R / k) * gw + (C / k);
        const d = chi ? depthMm * feather[gid] : 0;
        drop[gid] = d;
        if (d > 0) minFloor = Math.min(minFloor, base + (grid[gid] - emin) * relK - d);
        return gid;
      }
      return mint(col, row, chi);
    },
    (col, row) => mint(col, row, true));

  // Pass A: classify. The CLOSED sub-index range — a sub-vertex on a shared edge or corner makes
  // every incident cell a trench cell. cordTris uses the opposite convention (each vertex names the
  // one sub-cell it is the north-west corner of), so reusing that walk verbatim would leave a cell
  // fan-ring while the channel pokes through one of its edges.
  const isTrench = new Uint8Array(cw * ch);
  for (const [key, d] of dist) {
    if (!(d <= half)) continue;
    const R = (key / strideC) | 0, C = key - R * strideC;
    const rHi = (R / k) | 0, cHi = (C / k) | 0;
    const rLo = R % k === 0 ? rHi - 1 : rHi, cLo = C % k === 0 ? cHi - 1 : cHi;
    for (let r = rLo; r <= rHi; r++) {
      if (r < 0 || r >= ch) continue;
      for (let c = cLo; c <= cHi; c++) {
        if (c < 0 || c >= cw) continue;
        if (trenchOk[r * cw + c]) isTrench[r * cw + c] = 1;
      }
    }
  }
  if (!isTrench.some((v) => v)) return null;

  /** @type {number[]} */ const tris = [];

  // Pass B: trench cells. Both halves of every sub-triangle — the inside at terrain - delta, the
  // outside at terrain — so the ramp is the outside ring and the isoline itself is at full depth.
  // Per PARENT TRIANGLE, never per cell quad: the field on a triangle is affine, so its isoline is
  // one straight segment and both pieces are convex, and the outside remainder stays exactly on the
  // parent plane. A whole-cell polygon would flatten the anti-diagonal saddle by
  // (zB + zC - zA - zD)/4 in every trench cell.
  for (let r = 0; r < ch; r++) {
    for (let c = 0; c < cw; c++) {
      if (!isTrench[r * cw + c]) continue;
      claimed[r * cw + c] = 1;
      for (let j = 0; j < k; j++) {
        for (let i = 0; i < k; i++) {
          const A = (r * k + j) * strideC + (c * k + i), B = A + 1, C = A + strideC, D = C + 1;
          const iA = inside(A), iB = inside(B), iC = inside(C), iD = inside(D);
          // Same winding and the same anti-diagonal as gridTopTris, so the sub-triangles nest
          // exactly inside the parent's two.
          clipTri(tris, A, C, B, iA, iC, iB);
          clipTri(tris, A, C, B, !iA, !iC, !iB);
          clipTri(tris, B, C, D, iB, iC, iD);
          clipTri(tris, B, C, D, !iB, !iC, !iD);
        }
      }
    }
  }

  // Pass C: the fan ring. A cell edge-adjacent to a trench cell has k+1 vertices on that side --
  // plus any crossings, where the shared edge straddles the admissibility border and the neighbor
  // clips on distance while this cell is not admissible. Those crossings are feather-dead, so they
  // add no geometry, only topology; omitting them is a T-junction.
  const idOf = (/** @type {number} */ R, /** @type {number} */ C) => lattice(R * strideC + C);
  /** Push one side's vertices, start inclusive, end exclusive. */
  const side = (/** @type {number[]} */ out, /** @type {number} */ R0, /** @type {number} */ C0,
    /** @type {number} */ R1, /** @type {number} */ C1, /** @type {boolean} */ split) => {
    if (!split) { out.push(idOf(R0, C0)); return; }
    for (let s = 0; s < k; s++) {
      const Ra = R0 + ((R1 - R0) * s) / k, Ca = C0 + ((C1 - C0) * s) / k;
      const Rb = R0 + ((R1 - R0) * (s + 1)) / k, Cb = C0 + ((C1 - C0) * (s + 1)) / k;
      const ka = Ra * strideC + Ca, kb = Rb * strideC + Cb;
      out.push(lattice(ka));
      if (inside(ka) !== inside(kb)) out.push(crossing(ka, kb));
    }
  };
  const xyOf = (/** @type {number} */ id) => /** @type {[number, number]} */ (id < idBase
    ? [((id % gw) - c0) * dx, (r1 - ((id / gw) | 0)) * dy]
    : [X[id - idBase], Y[id - idBase]]);
  /** @type {number[]} */ const ring = [];
  const emitRing = () => {
    let n = 0;
    for (let i = 0; i < ring.length; i++) { // welded crossings can repeat a neighbor
      if (n > 0 && ring[n - 1] === ring[i]) continue;
      ring[n++] = ring[i];
    }
    if (n > 1 && ring[0] === ring[n - 1]) n--;
    if (n < 3) return;
    const pts = ring.slice(0, n).map(xyOf);
    // Centerd on the ring's own first point, not the tile's origin: this ring's true area is one
    // sub-cell (~dx^2), but pts carries tile-scale coordinates (up to tileWidthMm) on a fine
    // sub-lattice (dx << tileWidthMm), so an uncentered shoelace sums tileWidthMm^2-scale terms down
    // to a dx^2-scale result — cancellation of order (tileWidthMm/dx)^2, swamping this check long
    // before `covered` (summed from small per-triangle differences, already well conditioned) had
    // moved at all. A trail near the tile's own origin never hit this; one far from it did.
    const [ox, oy] = pts[0];
    let area2 = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      area2 += (pts[j][0] - ox) * (pts[i][1] - oy) - (pts[i][0] - ox) * (pts[j][1] - oy);
    }
    let covered = 0;
    for (const [a, b, cc] of earclip(pts)) {
      covered += (pts[b][0] - pts[a][0]) * (pts[cc][1] - pts[a][1])
        - (pts[b][1] - pts[a][1]) * (pts[cc][0] - pts[a][0]);
      tris.push(ring[a], ring[b], ring[cc]);
    }
    // Coverage verified, as baseTriangles does (mesh.js): earclip stops when it can find no ear and
    // pushes its remainder unguarded, so a bail leaves this claimed cell part-covered. The hole
    // reaches the mirrored gate, which reports a non-conforming seam — true, and it sends the next
    // debugger to the sub-lattice instead of to this ring.
    //
    // One-sided, unlike baseTriangles' two-sided form: a proper triangulation partitions the ring,
    // so covered cannot legitimately exceed area2, only fall short of it. The 1e-6 relative margin
    // matches baseTriangles' precedent and exists for ordinary floating error now that centring has
    // removed the cancellation it used to be silently absorbing — not a substitute for centring.
    // No `corridor: ` prefix, deliberately, unlike the base-cut throw below: that one names three
    // controls the user can move (base, exaggeration, inset) because the base IS the limiting fact.
    // A fan ring failing to triangulate is Pass C's own construction producing a non-simple ring,
    // which the walk that builds it (side(), above) cannot do for any reachable input — see its
    // comment. There is no slider that causes or fixes it, so routing it to the trail banner would
    // hand the user a remedy that does not exist; the status line's raw message is the honest one.
    if (Math.abs(covered) < Math.abs(area2) - 1e-6 * Math.max(1, Math.abs(area2))) {
      throw new Error("trench: a fan ring around the channel could not be triangulated");
    }
  };
  const trench = (/** @type {number} */ r, /** @type {number} */ c) =>
    r >= 0 && c >= 0 && r < ch && c < cw && isTrench[r * cw + c] === 1;
  for (let r = 0; r < ch; r++) {
    for (let c = 0; c < cw; c++) {
      if (isTrench[r * cw + c]) continue;
      const N = trench(r - 1, c), S = trench(r + 1, c);
      const W = trench(r, c - 1), E = trench(r, c + 1);
      if (!(N || S || W || E)) continue;
      claimed[r * cw + c] = 1;
      const R = r * k, C = c * k;
      // Parent triangle 1 = (A, C, B): the west and north cell sides, plus the anti-diagonal.
      ring.length = 0;
      side(ring, R, C, R + k, C, W);            // A -> C, west
      side(ring, R + k, C, R, C + k, false);    // C -> B, the diagonal: never subdivided,
      side(ring, R, C + k, R, C, N);            // B -> A, north     it is shared with no cell
      emitRing();
      // Parent triangle 2 = (B, C, D): the south and east cell sides, plus the anti-diagonal.
      ring.length = 0;
      side(ring, R, C + k, R + k, C, false);    // B -> C, the diagonal
      side(ring, R + k, C, R + k, C + k, S);    // C -> D, south
      side(ring, R + k, C + k, R, C + k, E);    // D -> B, east
      emitRing();
    }
  }

  // Reads as a sentence in the UI's trail banner (app.js), so it names the remedy rather than the
  // mechanism. Strict: a floor exactly on the base plane is a zero-thickness membrane. The minimum
  // is over the displaced points the walk above already visited — inside sub-vertices AND
  // crossings, which carry full depth while their terrain interpolates toward an OUTSIDE vertex, so
  // on ground falling away from the trail a crossing sits below every inside vertex.
  //
  // The `corridor: ` prefix is a ROUTING token, not a claim about the cord: it is what puts the
  // message on the trail banner rather than the status line. Ownership rides `dropCord`, which
  // this throw deliberately does not carry — the base is cut by the TILE's inset, and dropping the
  // cord would neither explain it nor fix it.
  if (minFloor <= 0) {
    throw new Error(`corridor: a ${depthMm.toFixed(2)} mm trail inset cuts through the base — ` +
      `thicken the base, reduce the exaggeration, or make the inset shallower`);
  }
  if (tris.length === 0) return null;
  return {
    tris: Uint32Array.from(tris), x: Float64Array.from(X),
    y: Float64Array.from(Y), z: Float64Array.from(Z), drop, claimed, idBase,
  };
}
