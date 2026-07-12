// Tile-first cell model. A layout is (center latlon, scale 1:N, tileWmm,
// cells [[i,j],…]) with cell (0,0) centered on `center`, +i east, +j south.
// The layout is uniform in Mercator space — the same space as the terrarium
// pixel lattice — so cell edges quantize to shared lattice indices and
// adjacent tiles read identical seam data by construction.
import { lonToGlobalX, latToGlobalY, globalXToLon, globalYToLat, printPitchMm }
  from "./tilemath.js";

export const CELL_CAP = 64;

// Mercator-pixel span of one tile edge at zoom z (float; Mercator is conformal
// so one span serves both axes — the print is tileWmm square at center lat)
export function tileSpanPx(centerLat, scale, tileWmm, z) {
  return tileWmm / printPitchMm(centerLat, z, scale);
}

const key = ([i, j]) => `${i},${j}`;

// Flat-top hex, axial (q,r). Geometry lives on an integer half-unit lattice:
// x = gxC + m·(S/4), y = gyC + n·(√3/4)·S with integer m,n per vertex/center —
// a vertex shared by two adjacent hexes is the same expression on the same
// integers, so it is bit-identical across tiles (exact seam welds downstream).
// Center (q,r): m = 3q, n = 2r + q. Vertex k offsets (units of S/4 and √3S/4):
const HEX_XU = [2, 1, -1, -2, -1, 1];
const HEX_YU = [0, 1, 1, 0, -1, -1];
export const HEX_H = Math.sqrt(3) / 2; // height/width ratio (across flats / across corners)

const NEIGHBORS = {
  square: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  hex: [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]],
  circle: [],
};

// Footprint vertices in global px at zoom z (hex 6 / circle 64); null for
// square (meshed by the plain grid path, no clip).
export function footprintPx([lat, lon], scale, tileWmm, [q, r], z, shape) {
  if (shape === "square") return null;
  const S = tileSpanPx(lat, scale, tileWmm, z);
  const gxC = lonToGlobalX(lon, z), gyC = latToGlobalY(lat, z);
  if (shape === "hex") {
    const hx = S / 4, hy = (Math.sqrt(3) / 4) * S;
    return HEX_XU.map((xu, kk) => [gxC + (3 * q + xu) * hx, gyC + (2 * r + q + HEX_YU[kk]) * hy]);
  }
  // circle: single cell at the origin; 64-gon of diameter tileWmm
  const R = S / 2;
  return Array.from({ length: 64 }, (_, kk) => {
    const a = (2 * Math.PI * kk) / 64;
    return [gxC + R * Math.cos(a), gyC + R * Math.sin(a)];
  });
}

// Per-cell pixel windows at zoom z. Cell edges land on Math.round of the exact
// Mercator boundary, so adjacent cells SHARE the boundary pixel index and
// physical tile size quantizes to pixel pitch (≤1 px).
// Windows are inclusive pixel-center ranges: {gx0, gy0, gw, gh}.
export function cellWindows([lat, lon], scale, tileWmm, cells, z, shape = "square") {
  const S = tileSpanPx(lat, scale, tileWmm, z);
  if (S < 2) throw new Error("tile smaller than one pixel at this zoom — raise the detail slider");
  const gxC = lonToGlobalX(lon, z), gyC = latToGlobalY(lat, z);
  const bx = (i) => Math.round(gxC + (i - 0.5) * S);
  const by = (j) => Math.round(gyC + (j - 0.5) * S);
  const hx = S / 4, hy = (Math.sqrt(3) / 4) * S;
  const wins = new Map();
  let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
  for (const cell of cells) {
    const [i, j] = cell;
    let x0, x1, y0, y1;
    if (shape === "hex") {
      x0 = Math.round(gxC + (3 * i - 2) * hx); x1 = Math.round(gxC + (3 * i + 2) * hx);
      y0 = Math.round(gyC + (2 * j + i - 1) * hy); y1 = Math.round(gyC + (2 * j + i + 1) * hy);
    } else { // square and circle: full S×S bbox around the cell center
      x0 = bx(i); x1 = bx(i + 1); y0 = by(j); y1 = by(j + 1);
    }
    wins.set(key(cell), { gx0: x0, gy0: y0, gw: x1 - x0 + 1, gh: y1 - y0 + 1 });
    gx0 = Math.min(gx0, x0); gy0 = Math.min(gy0, y0);
    gx1 = Math.max(gx1, x1); gy1 = Math.max(gy1, y1);
  }
  return { spanPx: S, wins, union: { gx0, gy0, gw: gx1 - gx0 + 1, gh: gy1 - gy0 + 1 } };
}

// Exact (unquantized) latlon bbox of one cell — map footprints and fetch
// bounds. Computed at z=0; zoom cancels out of the Mercator round-trip.
export function cellBbox([lat, lon], scale, tileWmm, [i, j]) {
  const S = tileSpanPx(lat, scale, tileWmm, 0);
  const gxC = lonToGlobalX(lon, 0), gyC = latToGlobalY(lat, 0);
  const w = globalXToLon(gxC + (i - 0.5) * S, 0), e = globalXToLon(gxC + (i + 0.5) * S, 0);
  const n = globalYToLat(gyC + (j - 0.5) * S, 0), s = globalYToLat(gyC + (j + 0.5) * S, 0);
  return [s, w, n, e];
}

export function cellsBbox(center, scale, tileWmm, cells, shape = "square") {
  let bb = [Infinity, Infinity, -Infinity, -Infinity];
  if (shape === "square") {
    for (const c of cells) {
      const [s, w, n, e] = cellBbox(center, scale, tileWmm, c);
      bb = [Math.min(bb[0], s), Math.min(bb[1], w), Math.max(bb[2], n), Math.max(bb[3], e)];
    }
    return bb;
  }
  for (const c of cells) {
    for (const [lat, lon] of cellRingLatLon(center, scale, tileWmm, c, shape)) {
      bb = [Math.min(bb[0], lat), Math.min(bb[1], lon), Math.max(bb[2], lat), Math.max(bb[3], lon)];
    }
  }
  return bb;
}

// Latlon footprint ring for map rendering (z0; zoom cancels in the round-trip).
export function cellRingLatLon(center, scale, tileWmm, cell, shape) {
  if (shape === "hex" || shape === "circle") {
    return footprintPx(center, scale, tileWmm, cell, 0, shape)
      .map(([gx, gy]) => [globalYToLat(gy, 0), globalXToLon(gx, 0)]);
  }
  const [s, w, n, e] = cellBbox(center, scale, tileWmm, cell);
  return [[s, w], [s, e], [n, e], [n, w]];
}

// Neighborhood ghosts, shape-aware (4 square / 6 hex / none circle).
export function ghostCells(cells, shape = "square") {
  const sel = new Set(cells.map(key));
  const out = new Map();
  for (const [i, j] of cells) {
    for (const [di, dj] of NEIGHBORS[shape]) {
      const n = [i + di, j + dj];
      const k = key(n);
      if (!sel.has(k)) out.set(k, n);
    }
  }
  return [...out.values()];
}

export function connectedToOrigin(cells, shape = "square") {
  const sel = new Set(cells.map(key));
  if (!sel.has("0,0")) return false;
  const seen = new Set(["0,0"]), stack = [[0, 0]];
  while (stack.length) {
    const [i, j] = stack.pop();
    for (const [di, dj] of NEIGHBORS[shape]) {
      const k = `${i + di},${j + dj}`;
      if (sel.has(k) && !seen.has(k)) { seen.add(k); stack.push([i + di, j + dj]); }
    }
  }
  return seen.size === sel.size;
}

// Shape switches can orphan cells (hex links (±1,∓1) don't exist for squares);
// keep only what the new adjacency still reaches from the origin.
export function pruneToOrigin(cells, shape = "square") {
  const sel = new Set(cells.map(key));
  if (!sel.has("0,0")) return cells.length ? [cells[0]] : [];
  const seen = new Set(["0,0"]), stack = [[0, 0]];
  while (stack.length) {
    const [i, j] = stack.pop();
    for (const [di, dj] of NEIGHBORS[shape]) {
      const k = `${i + di},${j + dj}`;
      if (sel.has(k) && !seen.has(k)) { seen.add(k); stack.push([i + di, j + dj]); }
    }
  }
  return cells.filter((c) => seen.has(key(c)));
}

// Vertex-center inside mask over a window bbox (row 0 = north) — the boundary
// flatten reads this. Per-column scanline: crossings depend only on the
// column's longitude, so compute them once per column instead of per vertex
// (pointInPolygon per vertex is O(ringLen) each — seconds per export tile).
export function vertexMask(polygon, [s, w, n, e], gw, gh) {
  const mask = new Uint8Array(gw * gh);
  const m = polygon.length;
  for (let c = 0; c < gw; c++) {
    const lon = w + ((e - w) * c) / (gw - 1);
    const xs = [];
    for (let i = 0, j = m - 1; i < m; j = i++) {
      const [yi, xi] = polygon[i], [yj, xj] = polygon[j]; // [lat, lon]
      if ((xi > lon) !== (xj > lon)) xs.push(((yj - yi) * (lon - xi)) / (xj - xi) + yi);
    }
    xs.sort((a, b) => a - b);
    for (let r = 0; r < gh; r++) {
      const lat = n - ((n - s) * r) / (gh - 1);
      // inside = odd number of crossings strictly above lat (same strict < as pointInPolygon)
      let lo = 0, hi = xs.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid] <= lat) lo = mid + 1; else hi = mid; }
      mask[r * gw + c] = (xs.length - lo) & 1;
    }
  }
  return mask;
}

// Min elevation over inside-mask vertices; Infinity when the window holds none.
export function insideMin(grid, insideMask) {
  let min = Infinity;
  for (let i = 0; i < grid.length; i++) if (insideMask[i]) min = Math.min(min, grid[i]);
  return min;
}

// Flatten-outside: copy with every outside vertex at `min`, so the plinth sits
// at exactly base height. recessedGrid's sibling. `min` is REQUIRED and must be
// the whole-layout inside minimum — a per-window local min would step at seams.
export function bakeFlatten(grid, insideMask, min) {
  if (!Number.isFinite(min)) return Float32Array.from(grid); // no inside vertex anywhere
  const out = Float32Array.from(grid);
  for (let i = 0; i < out.length; i++) if (!insideMask[i]) out[i] = min;
  return out;
}
