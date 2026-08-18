// GPX trail → the printable cord solid. Pure and headless: it takes a TilePlan and plain
// arrays, and knows nothing about the DOM.
//
// The corridor is the region within halfW of the trail. It is NOT rasterized onto grid cells:
// it is the sublevel set of a distance field, clipped against the terrain's own triangulation
// on a refined sub-lattice. That is what lets a cord be thinner than a grid cell while its
// underside stays congruent with the printed tile by construction rather than by tolerance.
//
// Distance-to-polyline also removes the reason the old cell version stamped discs instead of
// sweeping: a sublevel set of a scalar field is one well-defined region however many times an
// out-and-back trail retraces itself, so there is no self-intersection to union away.

import { lonToGlobalX, latToGlobalY } from "./tilemath.js";
import { cellsFromVertexMask, assembleSolid } from "./mesh.js";

/** @typedef {import("./types.js").LatLon} LatLon */
/** @typedef {import("./types.js").Clip} Clip */
/** @typedef {import("./types.js").Solid} Solid */
/** @typedef {import("./pipeline.js").TilePlan} TilePlan */

/**
 * Sub-cells across the cord's width.
 *
 * Not a precision knob. Distance to a line is affine, so linear interpolation along a sub-edge
 * puts a crossing on the exact isoline and a straight cord comes out exactly the requested width
 * at any k. This is about REPRESENTABILITY: the region has to contain interior lattice vertices,
 * or a sub-triangle could span the whole cord with all three corners outside and emit nothing.
 */
export const SUB_ACROSS = 4;

/** Maximum number of triangles in the top surface of trail cords. A guessed sanity limit to gate
 * the longest trail that will mesh; it does not control accuracy of the trail cord. While it is
 * ample the sub-lattice is as fine as the cord width requires, and past that subK refuses rather
 * than let the cord bead. */
const TRI_BUDGET = 1_000_000;

/** How close along a sub-edge a crossing has to be before it counts as landing ON the endpoint.
 * A fraction of one sub-cell, so it moves a boundary by ~1e-10 mm — twelve orders below a
 * nozzle, and far below the float noise it exists to absorb. */
const T_EPS = 1e-9;

/**
 * Trail segments → tile-local print millimeters, one x,y-interleaved array per segment.
 *
 * The x/y expressions are copied from buildSolid's `xy(id)` deliberately: the cord has to land
 * on the terrain it was measured against, and the only way to guarantee that is to derive both
 * from the same formula. A test pins the two together — if buildSolid's mapping ever changes,
 * that test fails rather than the cord silently shifting half a cell.
 *
 * Segments stay separate. A pause/resume gap is not a leg of the trail, and welding them would
 * stamp a corridor across ground nobody walked.
 *
 * @param {LatLon[][]} segments
 * @param {TilePlan} plan
 * @returns {Float64Array[]}
 */
export function trailToPrintMm(segments, plan) {
  const { window: win, span, dx, dy, z } = plan;
  const { c0, r1 } = span;
  return segments.map((seg) => {
    const out = new Float64Array(seg.length * 2);
    for (let i = 0; i < seg.length; i++) {
      const col = lonToGlobalX(seg[i][1], z) - win.gx0;
      const row = latToGlobalY(seg[i][0], z) - win.gy0;
      out[2 * i] = (col - c0) * dx;
      out[2 * i + 1] = (r1 - row) * dy;
    }
    return out;
  });
}

/**
 * Split every segment of a polyline to at most `maxLen`, keeping all original vertices.
 *
 * Purely to bound the work of band-stamping: a diagonal segment of length L has a bounding box
 * L/(2·width) times the area of the capsule inside it, so long segments would sweep the box for
 * vertices that are nowhere near the trail. Real GPX points land far closer than maxLen at print
 * scale, so this is usually inert — it exists so the bound holds for a decimated track.
 *
 * Unlike arc-length resampling, the last point is always emitted: stations at multiples of ds
 * drop the tail, which would end the cord up to one spacing short of the trail.
 *
 * @param {Float64Array} poly x,y interleaved
 * @param {number} maxLen print mm
 * @returns {Float64Array}
 */
export function chop(poly, maxLen) {
  /** @type {number[]} */
  const out = [poly[0], poly[1]];
  for (let i = 2; i < poly.length; i += 2) {
    const x0 = poly[i - 2], y0 = poly[i - 1], x1 = poly[i], y1 = poly[i + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (!(len > 0)) continue; // duplicate point: adds no capsule, and would divide by zero below
    const n = Math.ceil(len / maxLen);
    for (let j = 1; j < n; j++) out.push(x0 + ((x1 - x0) * j) / n, y0 + ((y1 - y0) * j) / n);
    out.push(x1, y1); // exactly, not x0 + (x1-x0)*n/n
  }
  return Float64Array.from(out);
}

/**
 * Sub-lattice refinement for a requested cord width.
 *
 * Cost scales with the CORD, not the tile — a cord already wider than SUB_ACROSS cells gets
 * k = 1 and costs what the cell-snapped version did. That is now a statement about the CORD only:
 * the tile's top sub-meshes the same lattice over roughly T + dx, so in the clamped regime it can
 * pass TRI_BUDGET by ~2× at a 1 mm cord and ~3× at 0.4 mm. Accepted rather than fixed — the clamp
 * is a ceiling on a soft budget, not a correctness bound, and re-deriving kMax against the channel
 * width would couple the cord's lattice to the channel's, which is the coupling this design
 * removed.
 *
 * k counts sub-cells ACROSS THE WIDTH, so a coarser tile needs a higher k to carry the same cord,
 * and halving the pitch halves the k that width asks for. That is the whole reason a preview-tier
 * bake reaches TRI_BUDGET before an export-tier one does on the same trail — the coarse grid
 * is asking for more subdivision, not for finer geometry. What the clamp below costs is therefore
 * representability, never accuracy.
 *
 * @param {number} widthMm @param {number} dx @param {number} dy @param {number} trailLenMm
 * @returns {{ k: number, hx: number, hy: number }}
 */
export function subK(widthMm, dx, dy, trailLenMm) {
  const pitch = Math.max(dx, dy);
  // ~2 triangles per sub-cell over a band of trailLen × width; a k-refined cell holds k² of them.
  const area = Math.max(trailLenMm * widthMm, dx * dy);
  const kMax = Math.max(1, Math.floor(Math.sqrt((TRI_BUDGET * dx * dy) / (2 * area))));
  const k = Math.min(Math.max(1, Math.ceil((SUB_ACROSS * pitch) / widthMm)), kMax);
  // Under half the width the region can slip between lattice rows and bead into islands — each
  // a closed manifold on its own, so checkWatertight cannot see the gap and the export would
  // silently print a dotted line. Refuse instead, as the cell version's own width guard did.
  if (pitch / k > widthMm / 2) {
    // Reads as a sentence in the UI's trail banner (app.js), so it names the remedy rather than
    // the mechanism — nobody can act on "sub-lattice".
    throw Object.assign(new Error(`corridor: this trail is too long to draw ${widthMm} mm wide — ` +
      `widen it to at least ${(2 * pitch / kMax).toFixed(2)} mm, or import a shorter trail`),
    { dropCord: true }); // the CORD cannot be drawn; a preview keeps its terrain (bake.worker.js)
  }
  return { k, hx: dx / k, hy: dy / k };
}

/** Clearance per side between the cord and the channel it seats in. NOT for support scarring —
 *  that is closed by printing the cord upside down, so its mating face is a top surface. It pays
 *  for the effect orientation cannot fix: FDM slots print undersize and bosses oversize as
 *  material flows into concave corners, so a nominal fit binds. Nothing here pays for the grid —
 *  the channel's boundary is meshed on the isoline, so its floor is exactly T wide along the whole
 *  trail rather than wobbling by a cell as vertices fall against it. */
const FIT_MM = 0.1;

/**
 * Channel width for a cord of `cordWidthMm`: the cord plus one clearance per side.
 *
 * No pitch term. The channel's boundary is meshed on the isoline rather than snapped to grid
 * vertices, so the grid's own erosion — a cell only reaches full depth when all four corners are
 * inside — never eats into the flat floor. Carving the channel into the elevation grid would have
 * forced a 2·√2·dx term, which at the z15 source cap is by far the larger half of a 2.57 mm channel
 * for a 1 mm cord.
 *
 * FIT_MM is not folded in with a max: independent requirements sum, or the one that happens to be
 * larger silently absorbs the other.
 *
 * @param {number} cordWidthMm @returns {number}
 */
export function trenchWidthMm(cordWidthMm) {
  return cordWidthMm + 2 * FIT_MM;
}


/**
 * Elevation at fractional grid coordinates, on the terrain's OWN triangulation.
 *
 * gridTopTris splits each cell across the B–C anti-diagonal, so the printed surface is
 * piecewise-planar over those two triangles. Bilinear sampling is a different surface — a
 * saddle — and differs by (zB + zC − zA − zD)/4 at the cell center, which is exactly the gap
 * that would make the cord float or dig in.
 *
 * @param {Float32Array} grid @param {number} gw @param {number} gh
 * @param {number} col @param {number} row
 * @returns {number}
 */
export function subElev(grid, gw, gh, col, row) {
  const c = Math.min(Math.max(Math.floor(col), 0), gw - 2);
  const r = Math.min(Math.max(Math.floor(row), 0), gh - 2);
  const u = col - c, v = row - r;
  const A = r * gw + c, B = A + 1, C = A + gw, D = C + 1;
  // The two branches agree on u+v = 1, so which side a diagonal point takes does not matter.
  return u + v <= 1
    ? grid[A] + u * (grid[B] - grid[A]) + v * (grid[C] - grid[A])
    : grid[D] + (1 - u) * (grid[C] - grid[D]) + (1 - v) * (grid[B] - grid[D]);
}

/**
 * Cells the cord may occupy: the ones whose printed top really is two plain triangles.
 *
 * Rim cells are excluded even when all four corners read inside. Over one the tile's top is
 * clip.js's clipped polygon, so a cord there would mate with a surface that is not what prints —
 * and a ring can cut a corner-free sliver off a cell whose four corners are all inside, which
 * the all-four-corners test alone does not catch.
 *
 * @param {number} gw @param {number} gh @param {Clip | null} [clip]
 * @returns {Uint8Array}
 */
export function admissibleCells(gw, gh, clip) {
  if (!clip) return new Uint8Array((gw - 1) * (gh - 1)).fill(1);
  const { cells } = cellsFromVertexMask(clip.inside, gw, gh);
  for (const key of clip.bcells) cells[key] = 0;
  return cells;
}

/** @param {number} px @param {number} py
 *  @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 */
function distToSeg(px, py, x0, y0, x1, y1) {
  const ax = x1 - x0, ay = y1 - y0, wx = px - x0, wy = py - y0;
  const L2 = ax * ax + ay * ay;
  let t = L2 > 0 ? (wx * ax + wy * ay) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(wx - t * ax, wy - t * ay);
}

/**
 * Distance to the trail at every sub-lattice vertex within the band, keyed by `R·strideC + C`.
 *
 * Takes ALREADY-CHOPPED polylines: cordTris needs `chopped` to measure trailLen for subK, which
 * produces the `k` this function needs, so chopping inside would be circular.
 *
 * Dilating by 2·h past `half` is what makes cordTris' interpolation safe: a vertex inside the
 * region is within √2·h of every corner of every sub-cell touching it, so those corners all carry
 * a true distance, never a sentinel. Every consumer must still filter on its own half-width: the
 * extra entries are vertices OUTSIDE the region, not padding.
 *
 * @param {Float64Array[]} chopped @param {TilePlan} plan
 * @param {number} half @param {number} k
 * @returns {Map<number, number>}
 */
export function distField(chopped, plan, half, k) {
  const { gw, gh, dx, dy, span } = plan;
  const { c0, r1 } = span;
  const maxC = (gw - 1) * k, maxR = (gh - 1) * k, strideC = maxC + 1;
  const xOf = (/** @type {number} */ C) => (C / k - c0) * dx;
  const yOf = (/** @type {number} */ R) => (r1 - R / k) * dy;
  /** @type {Map<number, number>} */
  const dist = new Map();
  const band = half + 2 * Math.max(dx / k, dy / k);
  for (const st of chopped) {
    // A one-point trail is a disc, not nothing, so it still gets one (degenerate) segment —
    // distToSeg falls back to point distance when the segment has no length.
    const nSeg = Math.max(1, st.length / 2 - 1);
    for (let s = 0; s < nSeg; s++) {
      const i = 2 * s;
      const x0 = st[i], y0 = st[i + 1];
      const x1 = st.length > 2 ? st[i + 2] : x0, y1 = st.length > 2 ? st[i + 3] : y0;
      const cLo = Math.max(0, Math.ceil((Math.min(x0, x1) - band) / dx * k + c0 * k));
      const cHi = Math.min(maxC, Math.floor((Math.max(x0, x1) + band) / dx * k + c0 * k));
      const rLo = Math.max(0, Math.ceil((r1 - (Math.max(y0, y1) + band) / dy) * k));
      const rHi = Math.min(maxR, Math.floor((r1 - (Math.min(y0, y1) - band) / dy) * k));
      for (let R = rLo; R <= rHi; R++) {
        const py = yOf(R), base = R * strideC;
        for (let C = cLo; C <= cHi; C++) {
          const d = distToSeg(xOf(C), py, x0, y0, x1, y1);
          const key = base + C;
          const prev = dist.get(key);
          if (prev === undefined || d < prev) dist.set(key, d);
        }
      }
    }
  }
  return dist;
}

/**
 * The lattice the cord and the channel share: chopped polylines, and the k that carries them.
 *
 * Hoisted out of cordTris because two builders now mesh against the same isoline, and a shared
 * seam only welds if both compute crossings on the same lattice. Choosing k twice from the same
 * inputs would work today and break the first time either caller's inputs drift.
 *
 * Chopped first, because the budget below measures only the part of the trail that can land ON the
 * tile. Framing a tile around one stretch of a long import is normal — framing.js warns about the
 * clipped remainder rather than refusing it — and counting kilometers that are never printed would
 * coarsen the lattice, or refuse a width, over geometry the tile never carries.
 *
 * @param {Float64Array[]} polys @param {TilePlan} plan @param {number} widthMm
 * @returns {{ chopped: Float64Array[], k: number }}
 */
export function cordLattice(polys, plan, widthMm) {
  const { gw, gh, dx, dy, span } = plan;
  const { c0, r1 } = span;
  const halfW = widthMm / 2;
  const chopped = polys.map((p) => chop(p, 4 * widthMm));
  const xLo = -c0 * dx - halfW, xHi = (gw - 1 - c0) * dx + halfW;
  const yLo = (r1 - (gh - 1)) * dy - halfW, yHi = r1 * dy + halfW;
  let trailLen = 0;
  for (const st of chopped) {
    for (let i = 2; i < st.length; i += 2) {
      // Midpoint test: a chopped piece is at most 4 widths long, so the error at each tile
      // crossing is far under what a triangle budget cares about.
      const mx = (st[i] + st[i - 2]) / 2, my = (st[i + 1] + st[i - 1]) / 2;
      if (mx < xLo || mx > xHi || my < yLo || my > yHi) continue;
      trailLen += Math.hypot(st[i] - st[i - 2], st[i + 1] - st[i - 1]);
    }
  }
  return { chopped, k: subK(widthMm, dx, dy, trailLen).k };
}

/**
 * Sutherland-Hodgman clipping of the terrain's own sub-triangles against a distance isoline,
 * with the crossing weld that makes two builders' shared edges conform.
 *
 * Shared by the cord and the channel. They clip the same field at different half-widths and keep
 * different halves of the result, but a crossing computed on one side of a shared edge must be the
 * SAME VERTEX as the one computed on the other — not merely the same position to within a float.
 * The ordered-key cache is what guarantees it, and it only guarantees it while there is one cache.
 *
 * `pushLattice` and `pushCross` mint vertices; the caller owns the vertex table and decides what z
 * a vertex carries, which is how the channel applies a displacement the cord does not.
 *
 * @param {Map<number, number>} dist @param {number} half @param {number} k @param {number} strideC
 * @param {(key: number, col: number, row: number) => number} pushLattice
 * @param {(col: number, row: number) => number} pushCross
 */
export function subClip(dist, half, k, strideC, pushLattice, pushCross) {
  /** @type {Map<number, number>} */ const latId = new Map();
  /** @type {Map<number, number>} */ const cutId = new Map();
  const lattice = (/** @type {number} */ key) => {
    let id = latId.get(key);
    if (id === undefined) {
      const R = (key / strideC) | 0;
      id = pushLattice(key, (key - R * strideC) / k, R / k);
      latId.set(key, id);
    }
    return id;
  };
  /** Crossing on the edge between two lattice vertices of opposite insideness. Keys are ordered
   *  so both incident triangles compute a bit-identical t and land on the same shared vertex.
   *
   *  The cache key is (lower vertex, direction), not (lower, upper): a sub-cell's edges only ever
   *  run right, down, or along the anti-diagonal, so three directions name every edge, and the
   *  three possible partners of one vertex always differ. Packing both endpoints instead would
   *  need `lo * totalVertices + hi`, which passes 2^53 — and starts silently aliasing distinct
   *  edges onto one vertex — on a 1000 mm tile carrying a 0.4 mm cord. */
  const crossing = (/** @type {number} */ ka, /** @type {number} */ kb) => {
    const lo = ka < kb ? ka : kb, hi = ka < kb ? kb : ka;
    const d = hi - lo;
    const pair = lo * 3 + (d === strideC ? 1 : d === 1 ? 0 : 2);
    let id = cutId.get(pair);
    if (id !== undefined) return id;
    const fa = /** @type {number} */ (dist.get(lo)) - half;
    const fb = /** @type {number} */ (dist.get(hi)) - half;
    const t = fa / (fa - fb);
    // A crossing landing on a lattice vertex IS that vertex; welding it there is what keeps the
    // clip degrading to the correct closure instead of leaving a sliver between two coincident
    // points. NEAR it counts as on it: the isoline runs exactly through lattice vertices whenever
    // the trail is axis-aligned and the half-width is a whole number of sub-cells, and rounding
    // then puts t at 4e-14 rather than 0 — a sliver of ~1e-28 mm², which is worse than the
    // 1e-10 mm the snap moves the boundary by.
    if (!(t > T_EPS)) return lattice(lo);
    if (!(t < 1 - T_EPS)) return lattice(hi);
    const Ra = (lo / strideC) | 0, Ca = lo - Ra * strideC;
    const Rb = (hi / strideC) | 0, Cb = hi - Rb * strideC;
    id = pushCross((Ca + (Cb - Ca) * t) / k, (Ra + (Rb - Ra) * t) / k);
    cutId.set(pair, id);
    return id;
  };
  /** @type {number[]} */ const poly = [];
  const key = [0, 0, 0], ins = [false, false, false];
  // One path for every case. Triangles have no ambiguous saddle, so this needs no disambiguation
  // — which marching squares would. Pass the flags NEGATED to keep the other half instead.
  const clipTri = (/** @type {number[]} */ out,
    /** @type {number} */ k0, /** @type {number} */ k1, /** @type {number} */ k2,
    /** @type {boolean} */ i0, /** @type {boolean} */ i1, /** @type {boolean} */ i2) => {
    poly.length = 0;
    key[0] = k0; key[1] = k1; key[2] = k2;
    ins[0] = i0; ins[1] = i1; ins[2] = i2;
    for (let i = 0; i < 3; i++) {
      const j = i === 2 ? 0 : i + 1;
      if (ins[i]) poly.push(lattice(key[i]));
      if (ins[i] !== ins[j]) poly.push(crossing(key[i], key[j]));
    }
    let n = 0;
    for (let i = 0; i < poly.length; i++) {
      const v = poly[i];
      if (n > 0 && poly[n - 1] === v) continue; // welded crossing, already emitted
      poly[n++] = v;
    }
    if (n > 1 && poly[0] === poly[n - 1]) n--;
    for (let i = 1; i + 1 < n; i++) out.push(poly[0], poly[i], poly[i + 1]);
  };
  return { lattice, crossing, clipTri };
}

/**
 * A lattice and the distance field stamped on it, shared between the two builders that mesh
 * against the same isoline.
 *
 * The union is the contract: `k`, `chopped` and `dist` travel together or not at all. A key in
 * `dist` is packed with the stride `k` implies, so a field decoded with a `k` the callee derived
 * for itself names a different (R, C) — the cord meshes somewhere else entirely, and being closed
 * and positive-volume it passes every gate downstream. Half a share is the "two builders, one
 * lattice" failure this whole arrangement exists to prevent, so it is made unrepresentable.
 *
 * `half` is the width the field was stamped at, WIDER than the cord's: the extra entries are
 * vertices outside the cord, not padding, and the cord still filters on its own halfW. `feather`
 * and `depthMm`, when both given, sink the underside by the SAME per-triangle interpolation of the
 * SAME field the channel floor used, so the two surfaces agree by construction.
 *
 * @typedef {{ half: number, k?: undefined, chopped?: undefined, dist?: undefined,
 *   feather?: undefined, depthMm?: undefined }
 *   | { half: number, k: number, chopped: Float64Array[], dist: Map<number, number>,
 *   feather?: Float32Array, depthMm?: number }} CordShared
 */

/**
 * The cord's top surface as a triangle soup over its own vertex list.
 *
 * Vertices carry relief millimeters (`(e − emin)·mmPerM·exag`) rather than meters, so the caller
 * only has to subtract each piece's floor. `emin` cancels there, exactly as in buildDrape; it is
 * taken so `geom` has one shape across the builders.
 *
 * @param {Float32Array} grid @param {TilePlan} plan
 * @param {Float64Array[]} polys trail in print mm, one per segment
 * @param {number} widthMm
 * @param {{ mmPerM: number, emin: number, exag: number }} geom
 * @param {Uint8Array} cellOk admissible parent cells, (gw-1)×(gh-1)
 * @param {CordShared} [shared]
 * @returns {{ tris: Uint32Array, x: Float64Array, y: Float64Array, z: Float64Array } | null}
 */
export function cordTris(grid, plan, polys, widthMm, geom, cellOk, shared) {
  const { gw, gh, dx, dy, span } = plan;
  const { c0, r1 } = span;
  const { mmPerM, emin, exag } = geom;
  const halfW = widthMm / 2;

  // The type forbids a half-share; this catches a caller the type checker never saw, because the
  // failure it prevents is silent (see CordShared) rather than a crash.
  const share = shared ? [shared.k, shared.chopped, shared.dist].filter((v) => v !== undefined).length : 0;
  if (share !== 0 && share !== 3) {
    throw new Error("cord: a shared lattice must supply k, chopped and dist together");
  }
  const { chopped, k } = shared?.k !== undefined
    ? { chopped: shared.chopped, k: shared.k }
    : cordLattice(polys, plan, widthMm);

  // Sub-lattice indices: C along +x, R along +row (so −y, matching buildSolid's flip).
  const maxC = (gw - 1) * k, maxR = (gh - 1) * k, strideC = maxC + 1;

  const dist = shared?.dist ?? distField(chopped, plan, shared?.half ?? halfW, k);
  if (dist.size === 0) return null;

  /** @type {number[]} */ const X = [];
  /** @type {number[]} */ const Y = [];
  /** @type {number[]} */ const Z = [];
  const relK = mmPerM * exag;
  // Derived from the sink, not the other way round: with no inset there is nothing to subtract,
  // and a feather held here would still cost a subElev per cord vertex to multiply by zero.
  const sink = shared?.feather && shared.depthMm ? shared.depthMm : 0;
  const feather = sink ? shared?.feather : undefined;
  /** Local vertex at fractional grid coords. */
  const push = (/** @type {number} */ col, /** @type {number} */ row) => {
    X.push((col - c0) * dx);
    Y.push((r1 - row) * dy);
    // The channel floor, term for term: the SAME subElev interpolation of the SAME feather field
    // the tile's top used. Two interpolants of a varying field at different lattice resolutions
    // disagree between samples; one rule cannot, which is why this reads feather rather than a
    // constant depth.
    Z.push((subElev(grid, gw, gh, col, row) - emin) * relK
      - (feather ? sink * subElev(feather, gw, gh, col, row) : 0));
    return X.length - 1;
  };
  const { clipTri } = subClip(dist, halfW, k, strideC, (_key, col, row) => push(col, row), push);

  /** @type {number[]} */ const tris = [];

  // Every stamped vertex names the ONE sub-cell it is the north-west corner of, so each cell is
  // reached exactly once with no dedupe pass. A cell with any interior corner is always reached:
  // that corner's own cell is stamped, and so are all four of its corners (the band argument
  // above), which is also why a missing neighbor here can only mean "outside".
  const cw = gw - 1;
  for (const [A, dA] of dist) {
    const R = (A / strideC) | 0, C = A - R * strideC;
    if (R >= maxR || C >= maxC) continue; // last row/column bound no cell
    const B = A + 1, Cc = A + strideC, D = Cc + 1;
    const iA = dA < halfW, iB = (dist.get(B) ?? Infinity) < halfW;
    const iC = (dist.get(Cc) ?? Infinity) < halfW, iD = (dist.get(D) ?? Infinity) < halfW;
    if (!(iA || iB || iC || iD)) continue;
    if (!cellOk[((R / k) | 0) * cw + ((C / k) | 0)]) continue;
    clipTri(tris, A, Cc, B, iA, iC, iB); // same winding and the same anti-diagonal as gridTopTris, so
    clipTri(tris, B, Cc, D, iB, iC, iD); // the sub-triangles nest exactly inside the parent's two
  }
  if (tris.length === 0) return null;
  return {
    tris: Uint32Array.from(tris), x: Float64Array.from(X),
    y: Float64Array.from(Y), z: Float64Array.from(Z),
  };
}

/**
 * The printable cord: underside molded to the printed relief, top a constant `heightMm` above it.
 *
 * One placement, shared by the preview and the export: the underside is `z + baseMm`, which is
 * the printed tile's top surface term for term (mesh.js: `base + (e − emin)·mmPerM·exag`), so the
 * cord rests on the relief it was measured against and needs no alignment in either. The export
 * used to drop each connected piece to the plate instead; that placement is gone, because a cord
 * written into the tile's own frame lands in its channel, and no slicer button can put a moved
 * part back where it was measured.
 *
 * @param {Float32Array} grid @param {TilePlan} plan
 * @param {Float64Array[]} polys @param {number} widthMm @param {number} heightMm
 * @param {{ mmPerM: number, emin: number, exag: number }} geom
 * @param {Uint8Array} cellOk
 * @param {number} baseMm base-plate thickness, the tile's own z frame
 * @param {CordShared} [shared] forwarded verbatim to `cordTris`
 * @returns {Solid | null}
 */
export function cordSolid(grid, plan, polys, widthMm, heightMm, geom, cellOk, baseMm, shared) {
  const soup = cordTris(grid, plan, polys, widthMm, geom, cellOk, shared);
  if (!soup) return null;
  const { tris, x, y, z } = soup;
  const rest = (/** @type {number} */ i) => z[i] + baseMm;
  return assembleSolid(tris, x.length, (i) => [x[i], y[i]], (i) => rest(i) + heightMm, rest, "mirror");
}
