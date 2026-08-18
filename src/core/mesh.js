// Heightfield → watertight indexed export solids, in tile-local mm (origin at
// the tile's SW corner, +Y = north). The top surface is grid-cell triangles, +Z
// wound: stair-clipped to a cell mask (gridTopTris) without a `clip`, or cut to
// the true footprint boundary (clippedTopTris, boundary cells fanned from their
// clipped polygon) with one. Either way it's closed by a boundary skirt and a
// flat z=0 base. The base degrades fan → ear-clip → mirror so any footprint
// (full, multi-island, notched, holed) closes watertight.

/** @typedef {import("./types.js").Solid} Solid */
/** @typedef {import("./types.js").Span} Span */

const AREA2_EPS = 1e-9; // near-zero doubled-area cutoff, shared with baseTriangles

/**
 * 2D orientation of three points a=(ax,ay), b=(bx,by), c=(cx,cy): the z of
 * (b−a)×(c−a), i.e. twice the signed area of triangle abc. Sign = winding:
 * >0 turns counter-clockwise, <0 clockwise, ≈0 collinear. Shared primitive
 * behind ptInTri, earclip, and baseTriangles. (Not a 3D cross product.)
 * @param {number} ax @param {number} ay @param {number} bx
 * @param {number} by @param {number} cx @param {number} cy
 * @returns {number}
 */
function cross3(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

// point-in-triangle by same-side sign test (tolerant of collinear rim runs)
/**
 * @param {[number, number]} p @param {[number, number]} a
 * @param {[number, number]} b @param {[number, number]} c
 * @returns {boolean}
 */
function ptInTri(p, a, b, c) {
  const d1 = cross3(a[0], a[1], b[0], b[1], p[0], p[1]);
  const d2 = cross3(b[0], b[1], c[0], c[1], p[0], p[1]);
  const d3 = cross3(c[0], c[1], a[0], a[1], p[0], p[1]);
  const neg = d1 < -AREA2_EPS || d2 < -AREA2_EPS || d3 < -AREA2_EPS;
  const pos = d1 > AREA2_EPS || d2 > AREA2_EPS || d3 > AREA2_EPS;
  return !(neg && pos);
}

// simple-polygon ear clipping -> index triples into `ring`
/**
 * @param {[number, number][]} ring
 * @returns {number[][]}
 */
export function earclip(ring) {
  const n = ring.length;
  if (n < 3) return [];
  const idx = [...Array(n).keys()];
  let a2 = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a2 += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  if (a2 < 0) idx.reverse();
  /** @type {number[][]} */
  const tris = [];
  let guard = 2 * n;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ip = idx[(i - 1 + idx.length) % idx.length], ii = idx[i], inx = idx[(i + 1) % idx.length];
      const a = ring[ip], b = ring[ii], c = ring[inx];
      if (cross3(a[0], a[1], b[0], b[1], c[0], c[1]) <= AREA2_EPS) continue; // reflex/collinear
      let ear = true;
      for (const k of idx) {
        if (k === ip || k === ii || k === inx) continue;
        if (ptInTri(ring[k], a, b, c)) { ear = false; break; }
      }
      if (ear) { tris.push([ip, ii, inx]); idx.splice(i, 1); clipped = true; break; }
    }
    if (!clipped) break;
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}

// directed boundary edges (u→v) of a +Z-wound triangulation; interior is left
// of travel, so outer loops walk CCW and hole loops CW. Reverse-edge lookup
// binary-searches a sorted Float64Array of u*N+v keys (exact below 2^53).
/**
 * @param {Uint32Array} topTris
 * @param {number} N
 * @returns {number[]}
 */
function boundaryEdges(topTris, N) {
  const E = topTris.length; // one directed edge per index slot
  const sorted = new Float64Array(E);
  for (let i = 0; i < E; i += 3) {
    const a = topTris[i], b = topTris[i + 1], c = topTris[i + 2];
    sorted[i] = a * N + b; sorted[i + 1] = b * N + c; sorted[i + 2] = c * N + a;
  }
  sorted.sort();
  /** @type {(k: number) => boolean} */
  const has = (k) => {
    let lo = 0, hi = E - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < k) lo = mid + 1;
      else if (sorted[mid] > k) hi = mid - 1;
      else return true;
    }
    return false;
  };
  /** @type {number[]} */
  const boundary = [];
  for (let i = 0; i < E; i += 3) {
    const a = topTris[i], b = topTris[i + 1], c = topTris[i + 2];
    if (!has(b * N + a)) boundary.push(a, b);
    if (!has(c * N + b)) boundary.push(b, c);
    if (!has(a * N + c)) boundary.push(c, a);
  }
  return boundary;
}

// stitch directed edges into closed loops; null on any irregularity
/**
 * @param {number[]} boundary
 * @returns {number[][] | null}
 */
function stitchLoops(boundary) {
  /** @type {Map<number, number>} */
  const next = new Map();
  for (let i = 0; i < boundary.length; i += 2) {
    if (next.has(boundary[i])) return null; // vertex with 2 outgoing: non-manifold rim
    next.set(boundary[i], boundary[i + 1]);
  }
  /** @type {number[][]} */
  const loops = [];
  /** @type {Set<number>} */
  const visited = new Set();
  for (const start of next.keys()) {
    if (visited.has(start)) continue;
    /** @type {number[]} */
    const loop = [];
    let u = start;
    do {
      if (visited.has(u)) return null;
      visited.add(u);
      loop.push(u);
      const nu = next.get(u);
      if (nu === undefined) return null;
      u = nu;
    } while (u !== start);
    if (loop.length < 3) return null;
    loops.push(loop);
  }
  return loops;
}

// triangulate one CCW loop at z=0, wound −Z. Star-shaped loops take an O(n)
// centroid fan (the full-coverage rectangle rim lands here); anything else
// ear-clips. Returns { extra: [cx,cy]|null, tris } with indices into `loop`
// (−1 = the centroid vertex), or null when neither triangulation covers the ring.
/**
 * @param {number[]} loop
 * @param {(id: number) => [number, number]} xy
 * @returns {{ extra: [number, number] | null, tris: number[] } | null}
 */
function baseTriangles(loop, xy) {
  const ring = loop.map(xy);
  const n = ring.length;
  let cx = 0, cy = 0, area2 = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    cx += ring[i][0]; cy += ring[i][1];
    area2 += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  cx /= n; cy /= n;
  if (area2 <= 0) return null; // not a CCW outer loop
  /** @type {number[]} */
  const fan = [];
  let ok = true;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = ring[j][0], ay = ring[j][1];
    const t2 = (ring[i][0] - ax) * (cy - ay) - (ring[i][1] - ay) * (cx - ax);
    if (t2 <= AREA2_EPS) { ok = false; break; } // centroid not strictly left of edge
    fan.push(j, -1, i); // (a, centroid, b): −Z wound for a CCW ring
  }
  if (ok) return { extra: [cx, cy], tris: fan };
  // ear clip; verify coverage (earclip can bail on pathological rings)
  const ears = earclip(ring);
  let covered = 0;
  /** @type {number[]} */
  const tris = [];
  for (const [i, j, k] of ears) {
    const a2 = (ring[j][0] - ring[i][0]) * (ring[k][1] - ring[i][1]) -
      (ring[j][1] - ring[i][1]) * (ring[k][0] - ring[i][0]);
    // earclip's every-other ear is guarded by this same cross3>AREA2_EPS test, but its
    // final idx.length===3 remainder is pushed unconditionally — if that remainder is
    // exactly collinear (e.g. a crossing snapped onto a grid vertex, forced inside at
    // placement by clip.js's place() both-integral branch, flanked by two independent
    // crossings snapped onto that same grid line), it slips through as a zero-area
    // triangle. Reject the whole loop here instead of shipping it: the caller falls
    // back to mirroring, which needs nothing from this ring but a non-degenerate top.
    if (Math.abs(a2) <= AREA2_EPS) return null;
    covered += Math.abs(a2);
    tris.push(i, k, j); // earclip yields CCW (+Z); flip to −Z
  }
  if (Math.abs(covered - Math.abs(area2)) > 1e-6 * Math.max(1, Math.abs(area2))) return null;
  return { extra: null, tris };
}

// One assembler for all builders: top surface (+Z-wound id triples) + boundary
// skirt + a bottom. bottomMode 'flat' triangulates each boundary loop at z=0
// (fan/ear-clip), falling back to 'mirror' (bottom mirrors the top at zBot) when
// loops don't stitch (holes / non-manifold rims).
/**
 * @param {Uint32Array} topTris
 * @param {number} N
 * @param {(id: number) => [number, number]} xy
 * @param {(id: number) => number} zTop
 * @param {(id: number) => number} zBot
 * @param {"flat" | "mirror"} bottomMode
 * @returns {Solid}
 */
export function assembleSolid(topTris, N, xy, zTop, zBot, bottomMode) {
  const boundary = boundaryEdges(topTris, N);

  // decide the bottom before allocating so buffer sizes are exact
  let mirrored = bottomMode === "mirror";
  /** @type {{ loop: number[], bt: { extra: [number, number] | null, tris: number[] } }[] | null} */
  let bases = null;
  if (!mirrored) {
    const loops = stitchLoops(boundary);
    if (loops) {
      bases = [];
      for (const loop of loops) {
        const bt = baseTriangles(loop, xy);
        if (!bt) { bases = null; break; } // hole loop (CW) or uncoverable ring
        bases.push({ loop, bt });
      }
    }
    if (!bases) mirrored = true; // holes / degenerate rims: correct, just bigger
  }

  // exact sizes: unique top ids via bitmap; bottom verts are the boundary loop
  // vertices or every top id when mirrored; each fanned loop adds one centroid
  const used = new Uint8Array(N);
  let nTopV = 0;
  for (let i = 0; i < topTris.length; i++) {
    if (!used[topTris[i]]) { used[topTris[i]] = 1; nTopV++; }
  }
  let nBotV = mirrored ? nTopV : boundary.length / 2;
  let nBaseIdx = mirrored ? topTris.length : 0;
  if (!mirrored && bases) {
    for (const { bt } of bases) {
      if (bt.extra) nBotV++;
      nBaseIdx += bt.tris.length;
    }
  }
  const positions = new Float32Array((nTopV + nBotV) * 3);
  const indices = new Uint32Array(topTris.length + 3 * boundary.length + nBaseIdx);

  // Int32Array id→vertex maps: O(triangle-count) paths avoid Maps (V8's 2^24 cap)
  const topIdx = new Int32Array(N).fill(-1);
  const botIdx = new Int32Array(N).fill(-1);
  let nv = 0, ni = 0;
  /** @type {(idx: Int32Array, id: number, z: (id: number) => number) => number} */
  const vert = (idx, id, z) => {
    let i = idx[id];
    if (i < 0) {
      const [x, y] = xy(id);
      i = nv++;
      positions[3 * i] = x; positions[3 * i + 1] = y; positions[3 * i + 2] = z(id);
      idx[id] = i;
    }
    return i;
  };
  /** @type {(id: number) => number} */
  const vTop = (id) => vert(topIdx, id, zTop);
  /** @type {(id: number) => number} */
  const vBot = (id) => vert(botIdx, id, zBot);

  for (let i = 0; i < topTris.length; i += 3) {
    indices[ni++] = vTop(topTris[i]);
    indices[ni++] = vTop(topTris[i + 1]);
    indices[ni++] = vTop(topTris[i + 2]);
  }
  // skirt: each boundary edge u→v (interior on its left) → 2 outward-facing wall tris
  for (let i = 0; i < boundary.length; i += 2) {
    const u = boundary[i], v = boundary[i + 1];
    const tu = vTop(u), tv = vTop(v), bu = vBot(u), bv = vBot(v);
    indices[ni++] = tv; indices[ni++] = tu; indices[ni++] = bu;
    indices[ni++] = tv; indices[ni++] = bu; indices[ni++] = bv;
  }
  if (mirrored) {
    // mirror bottom: top ids at zBot, winding flipped (i, i+2, i+1) so normals face −Z
    for (let i = 0; i < topTris.length; i += 3) {
      indices[ni++] = vBot(topTris[i]);
      indices[ni++] = vBot(topTris[i + 2]);
      indices[ni++] = vBot(topTris[i + 1]);
    }
  } else if (bases) {
    for (const { loop, bt } of bases) {
      let extraIdx = -1;
      if (bt.extra) {
        extraIdx = nv++;
        positions[3 * extraIdx] = bt.extra[0];
        positions[3 * extraIdx + 1] = bt.extra[1];
        positions[3 * extraIdx + 2] = 0; // flat base plane
      }
      for (let i = 0; i < bt.tris.length; i++) {
        const t = bt.tris[i];
        indices[ni++] = t === -1 ? extraIdx : vBot(loop[t]);
      }
    }
  }
  // sizes are computed exactly; subarray only guards a miscount from shipping
  return {
    positions: nv * 3 === positions.length ? positions : positions.subarray(0, nv * 3),
    indices: ni === indices.length ? indices : indices.subarray(0, ni),
    mirrored,
    loops: bases ? bases.length : 0,
  };
}

/**
 * Vertex mask → the cell mask gridTopTris consumes: a cell is claimed only when all four of
 * its corners are in. That rule is gridTopTris' own — a cell is one quad of the surface, and a
 * quad with a corner outside would drag that corner's height into the part.
 *
 * The result is therefore an EROSION of `vert` by up to a half-diagonal. The water inlay — the
 * only caller that meshes with it — wants exactly that: it is what gives the part a printable
 * vertical wall and the clearance to seat, instead of a shoreline tapering to a knife edge (see
 * pipeline.js). The trail cord wanted the opposite and used to widen its stamp to cancel the
 * erosion out; it now clips a distance field against a sub-lattice instead (cord.js), which
 * is why nothing here compensates for anything any more.
 *
 * `also` is a second vertex mask ANDed per corner (the footprint, for a clipped shape), applied
 * here rather than by mutating the caller's array.
 * @param {Uint8Array} vert
 * @param {number} gw
 * @param {number} gh
 * @param {Uint8Array} [also]
 * @returns {{ cells: Uint8Array, count: number }}
 */
export function cellsFromVertexMask(vert, gw, gh, also) {
  const cw = gw - 1, ch = gh - 1;
  const cells = new Uint8Array(cw * ch);
  let count = 0;
  for (let r = 0; r < ch; r++) {
    for (let c = 0; c < cw; c++) {
      const A = r * gw + c, B = A + 1, C = A + gw, D = C + 1;
      if (!(vert[A] && vert[B] && vert[C] && vert[D])) continue;
      if (also && !(also[A] && also[B] && also[C] && also[D])) continue;
      cells[r * cw + c] = 1; count++;
    }
  }
  return { cells, count };
}

// grid-cell top triangulation over a cell mask (+Z wound); counted first so the
// id list is one exact typed array.
/**
 * @param {number} gw
 * @param {Span} span
 * @param {Uint8Array} mask
 * @param {Uint8Array} [skip] cells another builder has already meshed
 * @returns {Uint32Array}
 */
function gridTopTris(gw, span, mask, skip) {
  const { r0, r1, c0, c1 } = span;
  const cw = gw - 1;
  let n = 0;
  for (let r = r0; r < r1; r++)
    for (let c = c0; c < c1; c++) if (mask[r * cw + c] && !(skip && skip[r * cw + c])) n++;
  const topTris = new Uint32Array(6 * n);
  let p = 0;
  for (let r = r0; r < r1; r++) {
    for (let c = c0; c < c1; c++) {
      if (!mask[r * cw + c] || (skip && skip[r * cw + c])) continue;
      const A = r * gw + c, B = A + 1, C = A + gw, D = C + 1;
      // each cell = 2 tris across the B–C diagonal, both wound +Z (CCW from above)
      topTris[p++] = A; topTris[p++] = C; topTris[p++] = B;
      topTris[p++] = B; topTris[p++] = C; topTris[p++] = D;
    }
  }
  return topTris;
}

// One boundary cell's clipped polygon, as vertex ids in CCW order in the module scratch
// `poly`; returns its length. cell ∩ P is an intersection of two convex sets and therefore
// convex in EXACT arithmetic — but crossings and ring vertices are snapped onto the 1/256
// lattice INDEPENDENTLY of each other (clip.js), and that can leave one point a hair inside
// the true hull of its neighbors (observed: a crossing and a true ring vertex 1/256 apart
// left a third point non-extremal by ~1e-3 doubled-area — far above AREA2_EPS's 1e-9, so an
// exact-collinear test does not see it). Sorting by angle about the vertex-average centroid
// has no way to notice a point isn't extremal — the centroid of a lopsided point cluster can
// itself land close enough to the true hull's edge that the sort misorders it, which silently
// produces a self-intersecting "polygon" and a non-manifold pinch downstream. A convex hull
// (Andrew's monotone chain) is immune: it discovers the boundary from a global extremum and
// simply excludes any point that isn't one, which also subsumes dropping collinear runs — a
// hull never keeps a collinear middle point either. Marching squares on corner parity cannot
// be used in its place: with two crossings on one side both endpoints read the same
// insideness, so the crossings are invisible to it.
//
// Grown on demand rather than fixed: the buffer this replaces held 8, assumed at most one
// crossing per side, and dropped writes past the end silently when that failed.
let poly = new Int32Array(32);
let polyX = new Float64Array(32);
let polyY = new Float64Array(32);
/**
 * @param {import("./types.js").Clip} clip
 * @param {number} r
 * @param {number} c
 * @returns {number}
 */
function cellPoly(clip, r, c) {
  const { inside, crossOf, ringOf, col, row, gw, gh, HBASE } = clip;
  const gv = gw * gh;
  const A = r * gw + c, B = A + 1, C = A + gw, D = C + 1;
  let m = 0;
  /** @type {(id: number) => void} */
  const add = (id) => {
    for (let i = 0; i < m; i++) if (poly[i] === id) return;
    if (m === poly.length) {
      const g = new Int32Array(m * 2); g.set(poly); poly = g;
      const gx = new Float64Array(m * 2); gx.set(polyX); polyX = gx;
      const gy = new Float64Array(m * 2); gy.set(polyY); polyY = gy;
    }
    poly[m] = id;
    polyX[m] = id < gv ? id % gw : col[id - gv];
    polyY[m] = id < gv ? (id / gw) | 0 : row[id - gv];
    m++;
  };
  if (inside[A]) add(A);
  if (inside[B]) add(B);
  if (inside[C]) add(C);
  if (inside[D]) add(D);
  const sides = [r * (gw - 1) + c, (r + 1) * (gw - 1) + c,
    HBASE + r * gw + c, HBASE + r * gw + c + 1];
  for (const key of sides) { const l = crossOf.get(key); if (l) for (const id of l) add(id); }
  const rv = ringOf.get(r * (gw - 1) + c);
  if (rv) for (const id of rv) add(id);
  if (m < 3) return 0;

  // Sort by x then y so the sweep below visits both hull chains monotonically — the
  // precondition for a monotone-chain hull, unrelated to the polygon's final winding.
  const idx = Array.from({ length: m }, (_, i) => i);
  idx.sort((i, j) => polyX[i] - polyX[j] || polyY[i] - polyY[j]);
  // A "right turn" (o,a,b): the same handedness as the fixed A→C→D→B walk every interior
  // (unclipped) cell already uses (row grows south, so this is CCW after that flip — see
  // clippedTopTris). Near-zero turns are treated as non-extremal so a collinear point is
  // excluded rather than kept as a future zero-area fan apex, folding in what used to be a
  // separate drop pass.
  /** @type {(o: number, a: number, b: number) => number} */
  const turn = (o, a, b) =>
    (polyX[a] - polyX[o]) * (polyY[b] - polyY[o]) - (polyY[a] - polyY[o]) * (polyX[b] - polyX[o]);
  /** @type {number[]} */
  const hull = [];
  for (const i of idx) {
    while (hull.length >= 2 && turn(hull[hull.length - 2], hull[hull.length - 1], i) >= -AREA2_EPS) hull.pop();
    hull.push(i);
  }
  const lower = hull.length;
  for (let k = idx.length - 2; k >= 0; k--) {
    const i = idx[k];
    while (hull.length > lower && turn(hull[hull.length - 2], hull[hull.length - 1], i) >= -AREA2_EPS) hull.pop();
    hull.push(i);
  }
  hull.pop(); // last point duplicates idx[0], the lower chain's start
  const w = hull.length;
  if (w < 3) return 0;
  const ids = hull.map((i) => poly[i]), xs = hull.map((i) => polyX[i]), ys = hull.map((i) => polyY[i]);
  for (let i = 0; i < w; i++) { poly[i] = ids[i]; polyX[i] = xs[i]; polyY[i] = ys[i]; }
  return w;
}

// Clipped top triangulation (+Z wound): interior cells emit the same two triangles as
// gridTopTris, boundary cells emit their clipped polygon fanned from its first vertex.
// Counted first so the id list is one exact typed array, matching gridTopTris.
/**
 * @param {number} gw
 * @param {Span} span
 * @param {import("./types.js").Clip} clip
 * @param {Uint8Array} [skip] cells another builder has already meshed
 * @returns {Uint32Array}
 */
function clippedTopTris(gw, span, clip, skip) {
  const { r0, r1, c0, c1 } = span;
  const { inside, bcells } = clip; // buildSolid already asserts clip.gw === gw
  let n = 0;
  for (let r = r0; r < r1; r++) {
    for (let c = c0; c < c1; c++) {
      const A = r * gw + c;
      const k = inside[A] + inside[A + 1] + inside[A + gw] + inside[A + gw + 1];
      // A cell the boundary touches must be walked even when every corner reads outside: a
      // convex corner can poke through one side, which corner parity alone cannot see.
      const touched = bcells.has(r * (gw - 1) + c);
      // `skip` is honored only on the branch below, which is correct because the channel's cells
      // are eroded one ring in from the footprint and so are never boundary cells. If that ever
      // stopped holding, this cell would be emitted twice — once clipped here, once sub-meshed —
      // and a doubled face is the one corruption no runtime check sees (checkNoCoincidentFaces is
      // tests-only, and the pair is still watertight and positive-volume). Refuse instead.
      if (touched && skip && skip[r * (gw - 1) + c]) {
        throw new Error(`buildSolid: the channel claimed boundary cell ${r},${c}`);
      }
      if (!touched) { if (k === 4 && !(skip && skip[r * (gw - 1) + c])) n += 2; continue; }
      const m = cellPoly(clip, r, c);
      if (m >= 3) n += m - 2;
    }
  }
  const topTris = new Uint32Array(3 * n);
  let p = 0;
  for (let r = r0; r < r1; r++) {
    for (let c = c0; c < c1; c++) {
      const A = r * gw + c, B = A + 1, C = A + gw, D = C + 1;
      const k = inside[A] + inside[B] + inside[C] + inside[D];
      if (!bcells.has(r * (gw - 1) + c)) {
        if (k !== 4 || (skip && skip[r * (gw - 1) + c])) continue;
        topTris[p++] = A; topTris[p++] = C; topTris[p++] = B;
        topTris[p++] = B; topTris[p++] = C; topTris[p++] = D;
        continue;
      }
      const m = cellPoly(clip, r, c);
      for (let i = 1; i + 1 < m; i++) {
        topTris[p++] = poly[0]; topTris[p++] = poly[i]; topTris[p++] = poly[i + 1];
      }
    }
  }
  return topTris;
}

// Watertight export solid for one tile, in tile-local mm (origin at the tile's SW corner,
// +Y = north), flat z=0 base. Without `clip`, `mask` stair-clips the top to a cell
// footprint. With it, boundary cells are clipped to the true polygon instead and ids at or above
// gw*gh are rim crossings. `geom` maps grid samples to print-Z via base + relief·mmPerM·exag.
/**
 * @param {Float32Array} grid
 * @param {number} gw
 * @param {number} gh
 * @param {Span} span
 * @param {Uint8Array | null} mask
 * @param {{ dx: number, dy: number, mmPerM: number, emin: number, exag: number, base: number }} geom
 * @param {import("./types.js").Clip} [clip]
 * @param {{ tris: Uint32Array, x: Float64Array, y: Float64Array, z: Float64Array,
 *   drop: Float64Array, claimed: Uint8Array, idBase: number } | null} [trench]
 *   the trail channel, meshed on a sub-lattice by trench.js. Its ids continue the rim's, so its
 *   idBase has to be exactly gv + rim — asserted rather than assumed, because a mismatch would
 *   read another builder's vertex table at an offset and produce a plausible, wrong tile.
 * @returns {Solid}
 */
export function buildSolid(grid, gw, gh, span, mask, geom, clip, trench) {
  // clippedTopTris' cell-walk loops index by the `gw`/`gh` params, but cellPoly (called from
  // inside it) destructures both from `clip` — a disagreement would walk cell corners with a
  // different stride or row bound, reading `clip.inside`/`crossOf`/`ringOf` at the wrong offset.
  // No caller can trigger this today (pipeline.js threads one consistent pair), but silently
  // indexing garbage is worse than throwing.
  if (clip && clip.gw !== gw) throw new Error(`buildSolid: gw=${gw} disagrees with clip.gw=${clip.gw}`);
  if (clip && clip.gh !== gh) throw new Error(`buildSolid: gh=${gh} disagrees with clip.gh=${clip.gh}`);
  const { dx, dy, mmPerM, emin, exag, base } = geom;
  const { r1, c0 } = span;
  const gv = gw * gh;
  // Closures below only dereference `cl` on the id>=gv branch, reachable only when `clip`
  // was passed (N stays gv otherwise) — same non-null contract as the `mask` cast above.
  const cl = /** @type {import("./types.js").Clip} */ (clip);
  const rim = clip ? cl.col.length : 0;
  if (trench && trench.idBase !== gv + rim) {
    throw new Error(`buildSolid: trench idBase ${trench.idBase} != ${gv + rim}`);
  }
  const skip = trench ? trench.claimed : undefined;
  const plainTris = clip
    ? clippedTopTris(gw, span, clip, skip)
    : gridTopTris(gw, span, /** @type {Uint8Array} */ (mask), skip);
  let topTris = plainTris;
  if (trench) {
    topTris = new Uint32Array(plainTris.length + trench.tris.length);
    topTris.set(plainTris);
    topTris.set(trench.tris, plainTris.length);
  }
  // A displaced grid vertex is only ever referenced by cells the channel meshed — feather is 0 at
  // every corner shared with a cell it did not — so one flat per-vertex array needs no ownership
  // bookkeeping and cannot give one id two heights.
  const drop = trench ? trench.drop : null;
  return assembleSolid(topTris, gv + rim + (trench ? trench.x.length : 0),
    (id) => (id < gv
      ? [((id % gw) - c0) * dx, (r1 - ((id / gw) | 0)) * dy]
      : id < gv + rim
        ? [(cl.col[id - gv] - c0) * dx, (r1 - cl.row[id - gv]) * dy]
        : [/** @type {NonNullable<typeof trench>} */ (trench).x[id - gv - rim],
          /** @type {NonNullable<typeof trench>} */ (trench).y[id - gv - rim]]),
    (id) => (id < gv
      ? base + (grid[id] - emin) * mmPerM * exag - (drop ? drop[id] : 0)
      : id < gv + rim
        ? base + (cl.elev[id - gv] - emin) * mmPerM * exag
        : /** @type {NonNullable<typeof trench>} */ (trench).z[id - gv - rim]),
    () => 0, "flat");
}

/**
 * Label a cell mask's connected pieces, returning the label of each VERTEX (−1 off-mask).
 *
 * 8-connected, and that is load-bearing rather than a preference: buildDrape gives every piece
 * its own floor, so a vertex shared by two pieces would need two z values. A vertex has exactly
 * four incident cells, and any two of them are within Chebyshev distance 1 — so under
 * 8-connectivity every cell touching a vertex is in ONE piece and the conflict cannot arise.
 * 4-connectivity would split a diagonal pinch and reintroduce it.
 *
 * Cells carry only a visited bit (labels live on vertices, which is what the caller indexes by),
 * and the frontier is an explicit stack — a recursive fill would blow the JS stack on a
 * grid-scale region long before it ran out of memory.
 * @param {number} gw
 * @param {number} gh
 * @param {Span} span
 * @param {Uint8Array} mask
 * @returns {{ vertexLabel: Int32Array, count: number }}
 */
function labelPieces(gw, gh, span, mask) {
  const { r0, r1, c0, c1 } = span;
  const cw = gw - 1;
  const seen = new Uint8Array(cw * (gh - 1));
  const vertexLabel = new Int32Array(gw * gh).fill(-1);
  /** @type {number[]} */
  const stack = [];
  let count = 0;
  for (let sr = r0; sr < r1; sr++) {
    for (let sc = c0; sc < c1; sc++) {
      if (!mask[sr * cw + sc] || seen[sr * cw + sc]) continue;
      const label = count++;
      seen[sr * cw + sc] = 1;
      stack.push(sr, sc);
      while (stack.length) {
        const c = /** @type {number} */ (stack.pop()), r = /** @type {number} */ (stack.pop());
        const A = r * gw + c;
        vertexLabel[A] = label; vertexLabel[A + 1] = label;
        vertexLabel[A + gw] = label; vertexLabel[A + gw + 1] = label;
        for (let nr = r - 1; nr <= r + 1; nr++) {
          if (nr < r0 || nr >= r1) continue;
          for (let nc = c - 1; nc <= c + 1; nc++) {
            if (nc < c0 || nc >= c1) continue;
            const i = nr * cw + nc;
            if (mask[i] && !seen[i]) { seen[i] = 1; stack.push(nr, nc); }
          }
        }
      }
    }
  }
  return { vertexLabel, count };
}

// The water inlays: a part molded to the printed surface, underside = the printed relief, top =
// `top`, closed by a skirt. Self-registers on the printed tile by its molded underside.
//
// The underside is the terrain's OWN triangulation on the SAME vertex ids from the SAME relief
// expression, so the mate is congruent by construction rather than by tolerance — which is the
// whole reason the mask is stamped into cells rather than derived some other way. (The cord
// wants the same congruence but not the same cell quantization, so it meshes its own sub-lattice
// in cord.js instead of coming through here.)
//
// `top` is a second elevation grid, in `grid`'s own units, giving the upper surface directly:
// the inlay's ORIGINAL water elevations, before the mode moved them. Thickness is therefore
// per-vertex, and is exactly the displacement applyWaterRecess applied. It is never negative:
// `flat`'s plane sits at `min(lowest water, …)`, at or below every water vertex's original
// height, and the sinking modes only subtract a positive depth — either way a water vertex's
// stored height is always ≤ its original.
//
// `base` is deliberately absent: the base plate belongs to the terrain object, and subtracting
// each piece's own minimum relief lands its lowest point on z = 0 by construction rather than
// relying on a slicer's ensure-on-bed. It prints on supports; generating those is the slicer's
// job.
//
// PER PIECE, not per part: one mask can cover disconnected regions at different heights (two
// lakes 1500 m apart in elevation). A single shared floor would rest the lowest piece on the
// plate and leave every other one hanging in mid-air — a shell that is still closed and
// positive-volume, so nothing downstream would object.
/**
 * @param {Float32Array} grid
 * @param {number} gw
 * @param {number} gh
 * @param {Span} span
 * @param {Uint8Array} mask cell mask, from cellsFromVertexMask
 * @param {{ dx: number, dy: number, mmPerM: number, emin: number, exag: number,
 *   seatBase?: number }} geom
 * @param {Float32Array} top upper-surface elevation grid, in `grid`'s units
 * @returns {Solid | null} null when the mask covers no cell
 */
export function buildDrape(grid, gw, gh, span, mask, geom, top) {
  const { dx, dy, mmPerM, emin, exag, seatBase } = geom;
  const { r1, c0 } = span;
  const topTris = gridTopTris(gw, span, mask);
  if (topTris.length === 0) return null;
  const k = mmPerM * exag;
  // `emin` cancels exactly below (`rel(...) - floor[...]` subtracts the same `emin*k` from both
  // terms), so its VALUE never reaches an output vertex — kept only so `geom` has the same shape
  // as buildSolid's. What IS load-bearing is `grid` itself: it must be the tile's own, already
  // water-displaced array (bakeTileSolid's ordering), not a pre-recess snapshot — the underside
  // has to mate with the surface that PRINTS. (The snapshot's place is `top`, above.) Don't "fix"
  // the cancellation by dropping emin; there is nothing here for it to fix.
  /** @param {number} e */
  const rel = (e) => (e - emin) * k;
  const { vertexLabel, count } = labelPieces(gw, gh, span, mask);
  const floor = new Float64Array(count).fill(Infinity);
  for (let i = 0; i < topTris.length; i++) {
    const id = topTris[i], z = rel(grid[id]);
    if (z < floor[vertexLabel[id]]) floor[vertexLabel[id]] = z;
  }
  // `seatBase` = draw the part where it BELONGS rather than where it prints: the tile's own frame,
  // base plate included, so it mates with the surface it fills. Absent — every export path — each
  // piece drops to z 0 instead, which is what lets the writer plate them side by side. The two
  // cannot be one mesh: a tile's water bodies sit at different elevations, so seating them keeps a
  // spread the bed cannot.
  const drop = seatBase == null
    ? (/** @type {number} */ id) => floor[vertexLabel[id]]
    : () => -seatBase;
  return assembleSolid(topTris, gw * gh,
    (id) => [((id % gw) - c0) * dx, (r1 - ((id / gw) | 0)) * dy],
    (id) => rel(top[id]) - drop(id),
    (id) => rel(grid[id]) - drop(id), "mirror");
}
