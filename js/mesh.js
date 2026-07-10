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

import { earclip } from "./clip.js";

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
// of travel, so outer loops walk CCW and hole loops walk CW
function boundaryEdges(topTris, N) {
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
function baseTriangles(loop, px, py) {
  const n = loop.length;
  let cx = 0, cy = 0, area2 = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    cx += px(loop[i]); cy += py(loop[i]);
    area2 += px(loop[j]) * py(loop[i]) - px(loop[i]) * py(loop[j]);
  }
  cx /= n; cy /= n;
  if (area2 <= 0) return null; // not a CCW outer loop
  const fan = [];
  let ok = true;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = px(loop[j]), ay = py(loop[j]);
    const t2 = (px(loop[i]) - ax) * (cy - ay) - (py(loop[i]) - ay) * (cx - ax);
    if (t2 <= 1e-9) { ok = false; break; } // centroid not strictly left of edge
    fan.push(j, -1, i); // (a, centroid, b): −Z wound for a CCW ring
  }
  if (ok) return { extra: [cx, cy], tris: fan };
  // ear clip; verify coverage (earclip can bail on pathological rings)
  const ring = loop.map((id) => [px(id), py(id)]);
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
  const positions = [];
  const topIdx = new Map(), botIdx = new Map();
  const vTop = (id) => {
    let i = topIdx.get(id);
    if (i === undefined) {
      const [x, y] = xy(id);
      i = positions.length / 3;
      positions.push(x, y, zTop(id));
      topIdx.set(id, i);
    }
    return i;
  };
  const vBot = (id) => {
    let i = botIdx.get(id);
    if (i === undefined) {
      const [x, y] = xy(id);
      i = positions.length / 3;
      positions.push(x, y, zBot(id));
      botIdx.set(id, i);
    }
    return i;
  };
  const indices = [];
  for (let i = 0; i < topTris.length; i += 3) {
    indices.push(vTop(topTris[i]), vTop(topTris[i + 1]), vTop(topTris[i + 2]));
  }
  const boundary = boundaryEdges(topTris, N);
  for (let i = 0; i < boundary.length; i += 2) {
    const u = boundary[i], v = boundary[i + 1];
    indices.push(vTop(v), vTop(u), vBot(u), vTop(v), vBot(u), vBot(v));
  }
  let mirrored = bottomMode === "mirror";
  if (!mirrored) {
    const loops = stitchLoops(boundary);
    const bases = [];
    let ok = loops !== null;
    if (ok) {
      for (const loop of loops) {
        const bt = baseTriangles(loop, (id) => xy(id)[0], (id) => xy(id)[1]);
        if (!bt) { ok = false; break; } // hole loop (CW) or uncoverable ring
        bases.push({ loop, bt });
      }
    }
    if (ok) {
      for (const { loop, bt } of bases) {
        let extraIdx = -1;
        if (bt.extra) {
          extraIdx = positions.length / 3;
          positions.push(bt.extra[0], bt.extra[1], 0);
        }
        for (let i = 0; i < bt.tris.length; i++) {
          const t = bt.tris[i];
          indices.push(t === -1 ? extraIdx : vBot(loop[t]));
        }
      }
    } else {
      mirrored = true; // holes / degenerate rims: correct, just bigger
    }
  }
  if (mirrored) {
    for (let i = 0; i < topTris.length; i += 3) {
      indices.push(vBot(topTris[i]), vBot(topTris[i + 2]), vBot(topTris[i + 1]));
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

// grid-cell top triangulation over a cell mask (+Z wound), shared by builders
function gridTopTris(gw, span, mask) {
  const { r0, r1, c0, c1 } = span;
  const cw = gw - 1;
  const topTris = [];
  for (let r = r0; r < r1; r++) {
    for (let c = c0; c < c1; c++) {
      if (!mask[r * cw + c]) continue;
      const A = r * gw + c, B = A + 1, C = A + gw, D = C + 1;
      topTris.push(A, C, B, B, C, D);
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

// Watertight solid from a decimated TIN of one tile (standalone gw×gh grid; zt
// holds print-mm relief; coords/triangles from decimate()). Flat z=0 base.
export function buildSolidTIN(zt, gw, gh, coords, triangles, dx, dy, base) {
  const gid = (vi) => coords[2 * vi + 1] * gw + coords[2 * vi];
  const wx = (id) => (id % gw) * dx;
  const wy = (id) => (gh - 1 - ((id / gw) | 0)) * dy;
  const topTris = [];
  for (let i = 0; i < triangles.length; i += 3) {
    const A = gid(triangles[i]);
    let B = gid(triangles[i + 1]);
    let C = gid(triangles[i + 2]);
    const area = (wx(B) - wx(A)) * (wy(C) - wy(A)) - (wx(C) - wx(A)) * (wy(B) - wy(A));
    if (area < 0) { const t = B; B = C; C = t; }
    topTris.push(A, B, C);
  }
  return assembleSolid(topTris, gw * gh,
    (id) => [wx(id), wy(id)],
    (id) => base + zt[id],
    () => 0, "flat");
}

// Watertight solid from an arbitrary top-surface triangle soup in world mm
// (polygon-clipped decimated tiles; clip vertices are off-grid). Vertices are
// welded by quantized XY (top is single-valued in z), re-wound +Z. Flat base.
export function buildSolidFromMesh(topTris, eps = 1e-3) {
  const q = (v) => Math.round(v / eps);
  const idOf = new Map();
  const vx = [], vy = [], vz = [];
  const vid = (x, y, z) => {
    const k = q(x) + "_" + q(y);
    let id = idOf.get(k);
    if (id === undefined) { id = vx.length; idOf.set(k, id); vx.push(x); vy.push(y); vz.push(z); }
    return id;
  };
  const tris = [];
  for (let i = 0; i < topTris.length; i += 9) {
    let a = vid(topTris[i], topTris[i + 1], topTris[i + 2]);
    let b = vid(topTris[i + 3], topTris[i + 4], topTris[i + 5]);
    let c = vid(topTris[i + 6], topTris[i + 7], topTris[i + 8]);
    if (a === b || b === c || a === c) continue;
    const area = (vx[b] - vx[a]) * (vy[c] - vy[a]) - (vy[b] - vy[a]) * (vx[c] - vx[a]);
    if (Math.abs(area) < eps * eps) continue;
    if (area < 0) { const t = b; b = c; c = t; }
    tris.push(a, b, c);
  }
  return assembleSolid(tris, vx.length,
    (id) => [vx[id], vy[id]],
    (id) => vz[id],
    () => 0, "flat");
}
