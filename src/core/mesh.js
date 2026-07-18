// Heightfield → watertight indexed export solids, in tile-local mm (origin at
// the tile's SW corner, +Y = north). The top surface is grid-cell triangles
// (stair-clipped to a cell mask, +Z wound), closed by a boundary skirt and a
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
function earclip(ring) {
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
function assembleSolid(topTris, N, xy, zTop, zBot, bottomMode) {
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
  };
}

// grid-cell top triangulation over a cell mask (+Z wound); counted first so the
// id list is one exact typed array.
/**
 * @param {number} gw
 * @param {Span} span
 * @param {Uint8Array} mask
 * @returns {Uint32Array}
 */
function gridTopTris(gw, span, mask) {
  const { r0, r1, c0, c1 } = span;
  const cw = gw - 1;
  let n = 0;
  for (let r = r0; r < r1; r++)
    for (let c = c0; c < c1; c++) if (mask[r * cw + c]) n++;
  const topTris = new Uint32Array(6 * n);
  let p = 0;
  for (let r = r0; r < r1; r++) {
    for (let c = c0; c < c1; c++) {
      if (!mask[r * cw + c]) continue;
      const A = r * gw + c, B = A + 1, C = A + gw, D = C + 1;
      // each cell = 2 tris across the B–C diagonal, both wound +Z (CCW from above)
      topTris[p++] = A; topTris[p++] = C; topTris[p++] = B;
      topTris[p++] = B; topTris[p++] = C; topTris[p++] = D;
    }
  }
  return topTris;
}

// Watertight export solid for one tile, in tile-local mm (origin at the tile's
// SW corner, +Y = north), flat z=0 base. `mask` stair-clips the top to a cell
// footprint; `geom` maps grid samples to print-Z via base + relief·mmPerM·exag.
/**
 * @param {Float32Array} grid
 * @param {number} gw
 * @param {number} gh
 * @param {Span} span
 * @param {Uint8Array} mask
 * @param {{ dx: number, dy: number, mmPerM: number, emin: number, exag: number, base: number }} geom
 * @returns {Solid}
 */
export function buildSolid(grid, gw, gh, span, mask, geom) {
  const { dx, dy, mmPerM, emin, exag, base } = geom;
  const { r1, c0 } = span;
  return assembleSolid(gridTopTris(gw, span, mask), gw * gh,
    (id) => [((id % gw) - c0) * dx, (r1 - ((id / gw) | 0)) * dy],
    (id) => base + (grid[id] - emin) * mmPerM * exag,
    () => 0, "flat");
}
