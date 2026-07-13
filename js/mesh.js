// Top-surface mesh for the 3D preview: per-tile heightfield triangles in world
// mm, stair-clipped to the polygon via a cell mask. Phase 5 extends this file
// with skirt + base for watertight export solids.

// hypsometric ramp, t in [0,1] -> [r,g,b] 0..1
const STOPS = [
  [0.0, [0.23, 0.42, 0.28]],
  [0.4, [0.51, 0.60, 0.36]],
  [0.7, [0.55, 0.43, 0.31]],
  [0.9, [0.60, 0.56, 0.52]],
  [1.0, [0.96, 0.96, 0.96]],
];
function ramp(t) {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const [t0, c0] = STOPS[i - 1], [t1, c1] = STOPS[i];
      const f = (t - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f,
        c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  return STOPS[STOPS.length - 1][1];
}

const SIDE = [0.5, 0.47, 0.43]; // warm gray for the printed walls + base
const WATER = [0.16, 0.36, 0.55]; // deep-water blue for dropped ocean
const PATH = [0.85, 0.3, 0.12]; // trail orange for a stamped GPX path

// Full preview solid for one tile (top + skirt walls + base), colored: the top
// by elevation, the walls/base a neutral filament gray so the base plate reads
// as a real print. span: {r0,r1,c0,c1}. geom: {dx,dy,offX,offY,mmPerM,emin,
// erange,exag,base}. Returns typed arrays for a three.js BufferGeometry.
export function buildPreviewSolid(grid, gridW, gridH, span, mask, geom) {
  const { dx, dy, offX, offY, mmPerM, emin, erange, exag, base, oceanMask, pathMask } = geom;
  const { r0, r1, c0, c1 } = span;
  const cw = gridW - 1;
  const N = gridW * gridH;

  // top triangles as grid ids, wound +Z (as in buildSolid)
  const topTris = [];
  for (let r = r0; r < r1; r++) {
    for (let c = c0; c < c1; c++) {
      if (!mask[r * cw + c]) continue;
      const A = r * gridW + c, B = r * gridW + c + 1, C = (r + 1) * gridW + c, D = (r + 1) * gridW + c + 1;
      topTris.push(A, C, B, B, C, D);
    }
  }
  const seen = new Set();
  for (let i = 0; i < topTris.length; i += 3) {
    const a = topTris[i], b = topTris[i + 1], c = topTris[i + 2];
    seen.add(a * N + b); seen.add(b * N + c); seen.add(c * N + a);
  }
  const boundary = [];
  for (let i = 0; i < topTris.length; i += 3) {
    const t = [topTris[i], topTris[i + 1], topTris[i + 2]];
    for (let e = 0; e < 3; e++) {
      const u = t[e], v = t[(e + 1) % 3];
      if (!seen.has(v * N + u)) boundary.push(u, v);
    }
  }

  const nTop = topTris.length / 3;
  const nTris = nTop + nTop + boundary.length; // top + base + skirt
  const positions = new Float32Array(nTris * 9);
  const colors = new Float32Array(nTris * 9);
  let p = 0, q = 0;
  const wx = (id) => (id % gridW) * dx + offX;
  const wy = (id) => (gridH - 1 - ((id / gridW) | 0)) * dy + offY;
  const put = (id, z0, col) => {
    positions[p++] = wx(id);
    positions[p++] = wy(id);
    positions[p++] = z0 ? 0 : base + (grid[id] - emin) * mmPerM * exag;
    colors[q++] = col[0]; colors[q++] = col[1]; colors[q++] = col[2];
  };

  for (let i = 0; i < topTris.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const id = topTris[i + k];
      put(id, false, pathMask && pathMask[id] ? PATH
        : oceanMask && oceanMask[id] ? WATER : ramp((grid[id] - emin) / erange));
    }
  }
  for (let i = 0; i < topTris.length; i += 3) {
    put(topTris[i], true, SIDE); put(topTris[i + 2], true, SIDE); put(topTris[i + 1], true, SIDE);
  }
  for (let i = 0; i < boundary.length; i += 2) {
    const u = boundary[i], v = boundary[i + 1];
    put(v, false, SIDE); put(u, false, SIDE); put(u, true, SIDE);
    put(v, false, SIDE); put(u, true, SIDE); put(v, true, SIDE);
  }
  return { positions, colors, triangles: nTris };
}

// --- ear clipping (moved from the deleted clip.js; the flat-base
// triangulation below is its only remaining caller) ---
const AREA2_EPS = 1e-9; // near-zero doubled-area cutoff, shared with baseTriangles
const cross3 = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

// simple-polygon ear clipping -> index triples
function earclip(ring) {
  const n = ring.length;
  if (n < 3) return [];
  let idx = [...Array(n).keys()];
  let a2 = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a2 += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  if (a2 < 0) idx.reverse();
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
function ptInTri(p, a, b, c) {
  const d1 = cross3(a[0], a[1], b[0], b[1], p[0], p[1]);
  const d2 = cross3(b[0], b[1], c[0], c[1], p[0], p[1]);
  const d3 = cross3(c[0], c[1], a[0], a[1], p[0], p[1]);
  const neg = d1 < -AREA2_EPS || d2 < -AREA2_EPS || d3 < -AREA2_EPS,
    pos = d1 > AREA2_EPS || d2 > AREA2_EPS || d3 > AREA2_EPS;
  return !(neg && pos);
}

// ---------------------------------------------------------------------------
// Indexed watertight solids. A solid is { positions: Float32Array, indices:
// Uint32Array }, outward-wound. One assembler serves all builders: top surface
// (+Z wound id triples) + boundary skirt + a bottom. bottomMode:
//   'flat'   — bottom at z=0, triangulated per boundary loop (centroid fan for
//              star-shaped loops, else ear clip); falls back to 'mirror' when
//              loops don't stitch (holes, non-manifold rims).
//   'mirror' — bottom mirrors the top triangulation at zBot(id) (trail shell's
//              molded underside; also the flat-base fallback with zBot = 0).
// ---------------------------------------------------------------------------

// directed boundary edges (u→v) of a +Z-wound triangulation; interior is left
// of travel, so outer loops walk CCW and hole loops walk CW. Reverse-edge
// lookup binary-searches a sorted Float64Array of u*N+v keys (exact below
// 2^53) — V8 Sets cap at 2^24 entries, under a full 2048² tile's ~16.8M
// directed edges.
function boundaryEdges(topTris, N) {
  const E = topTris.length; // one directed edge per index slot
  const sorted = new Float64Array(E);
  for (let i = 0; i < E; i += 3) {
    const a = topTris[i], b = topTris[i + 1], c = topTris[i + 2];
    sorted[i] = a * N + b; sorted[i + 1] = b * N + c; sorted[i + 2] = c * N + a;
  }
  sorted.sort();
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
  const boundary = []; // rim-scale, plain array is fine
  for (let i = 0; i < E; i += 3) {
    const a = topTris[i], b = topTris[i + 1], c = topTris[i + 2];
    if (!has(b * N + a)) boundary.push(a, b);
    if (!has(c * N + b)) boundary.push(b, c);
    if (!has(a * N + c)) boundary.push(c, a);
  }
  return boundary;
}

// stitch directed edges into closed loops; null on any irregularity
function stitchLoops(boundary) {
  const next = new Map();
  for (let i = 0; i < boundary.length; i += 2) {
    if (next.has(boundary[i])) return null; // vertex with 2 outgoing: non-manifold rim
    next.set(boundary[i], boundary[i + 1]);
  }
  const loops = [], visited = new Set();
  for (const start of next.keys()) {
    if (visited.has(start)) continue;
    const loop = [];
    let u = start;
    do {
      if (visited.has(u)) return null;
      visited.add(u);
      loop.push(u);
      u = next.get(u);
      if (u === undefined) return null;
    } while (u !== start);
    if (loop.length < 3) return null;
    loops.push(loop);
  }
  return loops;
}

// triangulate one CCW loop at z=0, wound −Z. Star-shaped loops (every rim edge
// sees the centroid) take an O(n) centroid fan — the full-coverage rectangle
// rim with its collinear runs lands here; anything else ear-clips. Returns
// { extra: [cx,cy]|null, tris: [i,j,k,…] } with indices into `loop` and −1 for
// the centroid vertex, or null when neither triangulation covers the ring.
function baseTriangles(loop, xy) {
  const ring = loop.map(xy); // one xy() per rim vertex; doubles as earclip input
  const n = ring.length;
  let cx = 0, cy = 0, area2 = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    cx += ring[i][0]; cy += ring[i][1];
    area2 += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  cx /= n; cy /= n;
  if (area2 <= 0) return null; // not a CCW outer loop
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

function assembleSolid(topTris, N, xy, zTop, zBot, bottomMode) {
  const boundary = boundaryEdges(topTris, N);

  // decide the bottom before allocating so buffer sizes are exact
  let mirrored = bottomMode === "mirror";
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
  // vertices (one outgoing edge each once stitched) or every top id when
  // mirrored; each fanned loop adds one centroid vertex
  const used = new Uint8Array(N);
  let nTopV = 0;
  for (let i = 0; i < topTris.length; i++) {
    if (!used[topTris[i]]) { used[topTris[i]] = 1; nTopV++; }
  }
  let nBotV = mirrored ? nTopV : boundary.length / 2;
  let nBaseIdx = mirrored ? topTris.length : 0;
  if (!mirrored) {
    for (const { bt } of bases) {
      if (bt.extra) nBotV++;
      nBaseIdx += bt.tris.length;
    }
  }
  const positions = new Float32Array((nTopV + nBotV) * 3);
  const indices = new Uint32Array(topTris.length + 3 * boundary.length + nBaseIdx);

  // Int32Array id→vertex maps: O(triangle-count) paths must avoid Maps (V8's
  // 2^24 cap) and their ~40 B/entry overhead
  const topIdx = new Int32Array(N).fill(-1);
  const botIdx = new Int32Array(N).fill(-1);
  let nv = 0, ni = 0;
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
  const vTop = (id) => vert(topIdx, id, zTop);
  const vBot = (id) => vert(botIdx, id, zBot);

  for (let i = 0; i < topTris.length; i += 3) {
    indices[ni++] = vTop(topTris[i]);
    indices[ni++] = vTop(topTris[i + 1]);
    indices[ni++] = vTop(topTris[i + 2]);
  }
  for (let i = 0; i < boundary.length; i += 2) {
    const u = boundary[i], v = boundary[i + 1];
    const tu = vTop(u), tv = vTop(v), bu = vBot(u), bv = vBot(v);
    indices[ni++] = tv; indices[ni++] = tu; indices[ni++] = bu;
    indices[ni++] = tv; indices[ni++] = bu; indices[ni++] = bv;
  }
  if (mirrored) {
    for (let i = 0; i < topTris.length; i += 3) {
      indices[ni++] = vBot(topTris[i]);
      indices[ni++] = vBot(topTris[i + 2]);
      indices[ni++] = vBot(topTris[i + 1]);
    }
  } else {
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

// grid-cell top triangulation over a cell mask (+Z wound), shared by builders;
// counted first so the millions-of-entries id list is one exact typed array
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
      topTris[p++] = A; topTris[p++] = C; topTris[p++] = B;
      topTris[p++] = B; topTris[p++] = C; topTris[p++] = D;
    }
  }
  return topTris;
}

// Watertight export solid for one tile, in tile-local mm (origin at the tile's
// SW corner, +Y = north). Flat z=0 base.
export function buildSolid(grid, gw, gh, span, mask, geom) {
  const { dx, dy, mmPerM, emin, exag, base } = geom;
  const { r1, c0 } = span;
  return assembleSolid(gridTopTris(gw, span, mask), gw * gh,
    (id) => [((id % gw) - c0) * dx, (r1 - ((id / gw) | 0)) * dy],
    (id) => base + (grid[id] - emin) * mmPerM * exag,
    () => 0, "flat");
}

// Constant-thickness terrain-hugging shell: underside = relief (mirror mode),
// top = relief + hMm. Self-registers on the printed terrain.
export function buildTrailShell(grid, gw, gh, span, mask, geom, hMm) {
  const { dx, dy, mmPerM, emin, exag } = geom;
  const { r1, c0 } = span;
  const k = mmPerM * exag;
  const relief = (id) => (grid[id] - emin) * k;
  return assembleSolid(gridTopTris(gw, span, mask), gw * gh,
    (id) => [((id % gw) - c0) * dx, (r1 - ((id / gw) | 0)) * dy],
    (id) => relief(id) + hMm,
    relief, "mirror");
}
