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

// Watertight export solid for one tile, in tile-local mm (origin at the tile's
// SW corner, +Y = north). Top surface (stair-clipped to the mask) + skirt walls
// down to z=0 along the footprint boundary + a mirrored base. Boundary edges are
// found from the top triangle soup (a directed edge with no reverse twin), so
// the skirt closes ANY footprint — full rectangle or clipped polygon — and the
// result is a closed manifold. Returns a flat Float32Array (9 floats/triangle).
export function buildSolid(grid, gw, gh, span, mask, geom) {
  const { dx, dy, mmPerM, emin, exag, base } = geom;
  const { r0, r1, c0, c1 } = span;
  const cw = gw - 1;

  // top triangles as vertex ids (id = row*gw + col); winding matches _top_tris
  const topTris = [];
  for (let r = r0; r < r1; r++) {
    for (let c = c0; c < c1; c++) {
      if (!mask[r * cw + c]) continue;
      const A = r * gw + c, B = r * gw + c + 1, C = (r + 1) * gw + c, D = (r + 1) * gw + c + 1;
      // wind for +Z (outward top) normals — everything else derives from this,
      // so this orients the whole closed solid outward
      topTris.push(A, C, B, B, C, D);
    }
  }

  // directed-edge set -> boundary edges are those without a reverse.
  // key = u*N + v is collision-free since vertex ids are < N = gw*gh.
  const N = gw * gh;
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
  const nTris = nTop /*top*/ + nTop /*base*/ + boundary.length; // skirt = 2 per edge
  const out = new Float32Array(nTris * 9);
  let p = 0;
  const put = (id, z0) => {
    const row = (id / gw) | 0, col = id % gw;
    out[p++] = (col - c0) * dx;
    out[p++] = (r1 - row) * dy;
    out[p++] = z0 ? 0 : base + (grid[id] - emin) * mmPerM * exag;
  };
  const tri = (a, b, c, z0) => { put(a, z0); put(b, z0); put(c, z0); };

  for (let i = 0; i < topTris.length; i += 3) {
    tri(topTris[i], topTris[i + 1], topTris[i + 2], false); // top (+Z)
    tri(topTris[i], topTris[i + 2], topTris[i + 1], true);  // base mirror (−Z)
  }
  // skirt: top boundary edge u→v needs its reverse; wall = (v,u,u0),(v,u0,v0)
  for (let i = 0; i < boundary.length; i += 2) {
    const u = boundary[i], v = boundary[i + 1];
    put(v, false); put(u, false); put(u, true);
    put(v, false); put(u, true); put(v, true);
  }
  return out;
}

// Watertight solid from an arbitrary top-surface triangle soup in world mm
// (topTris: flat [ax,ay,az, bx,by,bz, cx,cy,cz, …]). Vertices are deduped by
// quantized XY (the top is single-valued in z), triangles re-wound +Z, then the
// same top + boundary-skirt + mirrored-base construction as buildSolidTIN. Used
// for polygon-clipped decimated tiles where clip vertices are off-grid. The
// input z already encodes base+relief (the base slab is the mirror down to z=0).
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
    if (area < 0) { const t = b; b = c; c = t; } // wind +Z
    tris.push(a, b, c);
  }
  const N = vx.length;
  const seen = new Set();
  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i], b = tris[i + 1], c = tris[i + 2];
    seen.add(a * N + b); seen.add(b * N + c); seen.add(c * N + a);
  }
  const boundary = [];
  for (let i = 0; i < tris.length; i += 3) {
    const t = [tris[i], tris[i + 1], tris[i + 2]];
    for (let e = 0; e < 3; e++) {
      const u = t[e], v = t[(e + 1) % 3];
      if (!seen.has(v * N + u)) boundary.push(u, v);
    }
  }
  const nTop = tris.length / 3;
  const out = new Float32Array((nTop + nTop + boundary.length) * 9);
  let p = 0;
  const put = (id, z0) => { out[p++] = vx[id]; out[p++] = vy[id]; out[p++] = z0 ? 0 : vz[id]; };
  for (let i = 0; i < tris.length; i += 3) {
    put(tris[i], false); put(tris[i + 1], false); put(tris[i + 2], false);
    put(tris[i], true); put(tris[i + 2], true); put(tris[i + 1], true);
  }
  for (let i = 0; i < boundary.length; i += 2) {
    const u = boundary[i], v = boundary[i + 1];
    put(v, false); put(u, false); put(u, true);
    put(v, false); put(u, true); put(v, true);
  }
  return out;
}

// Watertight solid from a decimated TIN of one tile (a standalone gw×gh grid).
// zt holds print-mm relief above the base at each grid point (id = gy*gw + gx);
// coords/triangles come from decimate(). Vertices sit on grid points, so the
// grid id doubles as a boundary-edge key. Returns a flat Float32Array.
export function buildSolidTIN(zt, gw, gh, coords, triangles, dx, dy, base) {
  const N = gw * gh;
  const gid = (vi) => coords[2 * vi + 1] * gw + coords[2 * vi]; // gy*gw + gx
  const wx = (id) => (id % gw) * dx;
  const wy = (id) => (gh - 1 - ((id / gw) | 0)) * dy;

  // top triangles as grid ids, each normalized to CCW / +Z winding
  const topTris = [];
  for (let i = 0; i < triangles.length; i += 3) {
    const A = gid(triangles[i]);
    let B = gid(triangles[i + 1]);
    let C = gid(triangles[i + 2]);
    const area = (wx(B) - wx(A)) * (wy(C) - wy(A)) - (wx(C) - wx(A)) * (wy(B) - wy(A));
    if (area < 0) { const t = B; B = C; C = t; }
    topTris.push(A, B, C);
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
  const out = new Float32Array((nTop + nTop + boundary.length) * 9);
  let p = 0;
  const put = (id, z0) => {
    out[p++] = wx(id);
    out[p++] = wy(id);
    out[p++] = z0 ? 0 : base + zt[id];
  };
  for (let i = 0; i < topTris.length; i += 3) {
    put(topTris[i], false); put(topTris[i + 1], false); put(topTris[i + 2], false);
    put(topTris[i], true); put(topTris[i + 2], true); put(topTris[i + 1], true);
  }
  for (let i = 0; i < boundary.length; i += 2) {
    const u = boundary[i], v = boundary[i + 1];
    put(v, false); put(u, false); put(u, true);
    put(v, false); put(u, true); put(v, true);
  }
  return out;
}
