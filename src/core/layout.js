// layout.js — Tile-first cell model. A layout is (center latlon, scale 1:N, tileWidthMm,
// cells [[i,j],…]) with cell (0,0) centered on `center`, +i east, +j south.
// The layout is uniform in Mercator space — the same space as the terrarium
// pixel lattice — so cell edges quantize to shared lattice indices and
// adjacent tiles read identical seam data by construction.
import { lonToGlobalX, latToGlobalY, globalXToLon, globalYToLat, printPitchMm }
  from "./tilemath.js";

/**
 * @typedef {import("./types.js").BBox} BBox
 * @typedef {import("./types.js").Cell} Cell
 * @typedef {import("./types.js").LatLon} LatLon
 * @typedef {import("./types.js").Shape} Shape
 * @typedef {import("./types.js").Window} Window
 */

/** @type {number} */
export const CELL_CAP = 64;

/** Fewest Mercator pixels a tile edge may span: below 2 the tile has no interior cell and
 * cellWindows can't build a window at all. Reachable only by pinning a zoom explicitly —
 * the tile budgets in app.js all land orders of magnitude above it (see FAST_MAX_TILES). */
export const MIN_SPAN_PX = 2;

// Mercator-pixel span of one tile edge at zoom z (float; Mercator is conformal
// so one span serves both axes — the print is tileWidthMm square at center lat)
/**
 * @param {number} centerLat
 * @param {number} scale
 * @param {number} tileWidthMm
 * @param {number} z
 * @returns {number}
 */
export function tileSpanPx(centerLat, scale, tileWidthMm, z) {
  return tileWidthMm / printPitchMm(centerLat, z, scale);
}

/** @type {(cell: Cell) => string} */
const key = ([i, j]) => `${i},${j}`;

// Flat-top hex, axial (q,r). Geometry lives on an integer half-unit lattice:
// x = gxC + m·(S/4), y = gyC + n·(√3/4)·S with integer m,n per vertex/center —
// a vertex shared by two adjacent hexes is the same expression on the same
// integers, so it is bit-identical across tiles (exact seam welds downstream).
// Center (q,r): m = 3q, n = 2r + q. Vertex k offsets (units of S/4 and √3S/4):
const HEX_XU = [2, 1, -1, -2, -1, 1];
const HEX_YU = [0, 1, 1, 0, -1, -1];
/** @type {number} */
export const HEX_H = Math.sqrt(3) / 2; // height/width ratio (across flats / across corners)

const NEIGHBORS = {
  square: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  hex: [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]],
  circle: [],
};

// Footprint vertices in global px at zoom z (hex 6 / circle n, default 64); null for
// square (meshed by the plain grid path, no clip).
/**
 * @param {LatLon} center
 * @param {number} scale
 * @param {number} tileWidthMm
 * @param {Cell} cell
 * @param {number} z
 * @param {Shape} shape
 * @param {number} [n] circle ring resolution; ignored for hex
 * @returns {Array<[number,number]> | null}
 */
export function footprintPx([lat, lon], scale, tileWidthMm, [q, r], z, shape, n = 64) {
  if (shape === "square") return null;
  const S = tileSpanPx(lat, scale, tileWidthMm, z);
  const gxC = lonToGlobalX(lon, z), gyC = latToGlobalY(lat, z);
  if (shape === "hex") {
    const hx = S / 4, hy = (Math.sqrt(3) / 4) * S;
    return HEX_XU.map((xu, kk) => [gxC + (3 * q + xu) * hx, gyC + (2 * r + q + HEX_YU[kk]) * hy]);
  }
  // circle: single cell at the origin; n-gon of diameter tileWidthMm
  const R = S / 2;
  return Array.from({ length: n }, (_, kk) => {
    const a = (2 * Math.PI * kk) / n;
    return [gxC + R * Math.cos(a), gyC + R * Math.sin(a)];
  });
}

// Per-cell pixel windows at zoom z. A square's edges land on Math.round of the exact
// Mercator crossing, so adjacent cells SHARE the edge pixel index. Clipped shapes (hex,
// circle) instead expand outward past their ring, because their ring extremes coincide
// with the window bounds and rounding would put geometry outside the grid — see the loop.
// Windows are inclusive pixel-center ranges: {gx0, gy0, gw, gh}.
/**
 * @param {LatLon} center
 * @param {number} scale
 * @param {number} tileWidthMm
 * @param {Cell[]} cells
 * @param {number} z
 * @param {Shape} [shape]
 * @returns {{ spanPx: number, wins: Map<string, Window>, union: Window }}
 */
export function cellWindows([lat, lon], scale, tileWidthMm, cells, z, shape = "square") {
  const S = tileSpanPx(lat, scale, tileWidthMm, z);
  if (S < MIN_SPAN_PX) {
    throw new Error(`tile spans ${S.toFixed(2)} px at z${z}, under the ${MIN_SPAN_PX}px minimum — use a deeper zoom`);
  }
  const gxC = lonToGlobalX(lon, z), gyC = latToGlobalY(lat, z);
  const bx = (/** @type {number} */ i) => Math.round(gxC + (i - 0.5) * S);
  const by = (/** @type {number} */ j) => Math.round(gyC + (j - 0.5) * S);
  const hx = S / 4, hy = (Math.sqrt(3) / 4) * S;
  const wins = new Map();
  let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
  for (const cell of cells) {
    const [i, j] = cell;
    let x0, x1, y0, y1;
    if (shape === "square") {
      // The square's rim IS the window border, so rounding is the definition of its extent.
      x0 = bx(i); x1 = bx(i + 1); y0 = by(j); y1 = by(j + 1);
    } else {
      // Clipped shapes: the ring's extremes are exactly these expressions, so rounding
      // would leave a corner — or a whole flat hex edge — outside the grid, and two tiles
      // sharing that edge would truncate it asymmetrically. Expand outward instead. The
      // extra 1 px guarantees a full ring of outside vertices, so every boundary cell has
      // all four corners in-grid and every crossing's floor() lands on a real edge key.
      const [ex0, ex1, ey0, ey1] = shape === "hex"
        ? [gxC + (3 * i - 2) * hx, gxC + (3 * i + 2) * hx,
           gyC + (2 * j + i - 1) * hy, gyC + (2 * j + i + 1) * hy]
        : [gxC + (i - 0.5) * S, gxC + (i + 0.5) * S,
           gyC + (j - 0.5) * S, gyC + (j + 0.5) * S];
      x0 = Math.floor(ex0) - 1; x1 = Math.ceil(ex1) + 1;
      y0 = Math.floor(ey0) - 1; y1 = Math.ceil(ey1) + 1;
    }
    wins.set(key(cell), { gx0: x0, gy0: y0, gw: x1 - x0 + 1, gh: y1 - y0 + 1 });
    gx0 = Math.min(gx0, x0); gy0 = Math.min(gy0, y0);
    gx1 = Math.max(gx1, x1); gy1 = Math.max(gy1, y1);
  }
  return { spanPx: S, wins, union: { gx0, gy0, gw: gx1 - gx0 + 1, gh: gy1 - gy0 + 1 } };
}

// Exact (unquantized) latlon bbox of one cell — map footprints and fetch
// bounds. Computed at z=0; zoom cancels out of the Mercator round-trip.
/**
 * @param {LatLon} center
 * @param {number} scale
 * @param {number} tileWidthMm
 * @param {Cell} cell
 * @returns {BBox}
 */
export function cellBbox([lat, lon], scale, tileWidthMm, [i, j]) {
  const S = tileSpanPx(lat, scale, tileWidthMm, 0);
  const gxC = lonToGlobalX(lon, 0), gyC = latToGlobalY(lat, 0);
  const w = globalXToLon(gxC + (i - 0.5) * S, 0), e = globalXToLon(gxC + (i + 0.5) * S, 0);
  const n = globalYToLat(gyC + (j - 0.5) * S, 0), s = globalYToLat(gyC + (j + 0.5) * S, 0);
  return [s, w, n, e];
}

/**
 * @param {LatLon} center
 * @param {number} scale
 * @param {number} tileWidthMm
 * @param {Cell[]} cells
 * @param {Shape} [shape]
 * @returns {BBox}
 */
export function cellsBbox(center, scale, tileWidthMm, cells, shape = "square") {
  let bb = /** @type {BBox} */ ([Infinity, Infinity, -Infinity, -Infinity]);
  if (shape === "square") {
    for (const c of cells) {
      const [s, w, n, e] = cellBbox(center, scale, tileWidthMm, c);
      bb = [Math.min(bb[0], s), Math.min(bb[1], w), Math.max(bb[2], n), Math.max(bb[3], e)];
    }
    return bb;
  }
  for (const c of cells) {
    for (const [lat, lon] of cellRingLatLon(center, scale, tileWidthMm, c, shape)) {
      bb = [Math.min(bb[0], lat), Math.min(bb[1], lon), Math.max(bb[2], lat), Math.max(bb[3], lon)];
    }
  }
  return bb;
}

// Latlon footprint ring for map rendering (z0; zoom cancels in the round-trip).
/**
 * @param {LatLon} center
 * @param {number} scale
 * @param {number} tileWidthMm
 * @param {Cell} cell
 * @param {Shape} shape
 * @returns {LatLon[]}
 */
export function cellRingLatLon(center, scale, tileWidthMm, cell, shape) {
  if (shape === "hex" || shape === "circle") {
    // Fixed 64 for display: the map outline is a few hundred screen pixels, so the bake's
    // adaptive resolution would be wasted here.
    return /** @type {[number,number][]} */ (footprintPx(center, scale, tileWidthMm, cell, 0, shape))
      .map(([gx, gy]) => [globalYToLat(gy, 0), globalXToLon(gx, 0)]);
  }
  const [s, w, n, e] = cellBbox(center, scale, tileWidthMm, cell);
  return [[s, w], [s, e], [n, e], [n, w]];
}

// Neighborhood ghosts, shape-aware (4 square / 6 hex / none circle).
/**
 * @param {Cell[]} cells
 * @param {Shape} [shape]
 * @returns {Cell[]}
 */
export function ghostCells(cells, shape = "square") {
  const sel = new Set(cells.map(key));
  const out = new Map();
  for (const [i, j] of cells) {
    for (const [di, dj] of NEIGHBORS[shape]) {
      const n = /** @type {Cell} */ ([i + di, j + dj]);
      const k = key(n);
      if (!sel.has(k)) out.set(k, n);
    }
  }
  return [...out.values()];
}

/**
 * @param {Cell[]} cells
 * @param {Shape} [shape]
 * @returns {boolean}
 */
export function connectedToOrigin(cells, shape = "square") {
  const sel = new Set(cells.map(key));
  if (!sel.has("0,0")) return false;
  const seen = new Set(["0,0"]), stack = [[0, 0]];
  while (stack.length) {
    const [i, j] = /** @type {Cell} */ (stack.pop());
    for (const [di, dj] of NEIGHBORS[shape]) {
      const k = `${i + di},${j + dj}`;
      if (sel.has(k) && !seen.has(k)) { seen.add(k); stack.push([i + di, j + dj]); }
    }
  }
  return seen.size === sel.size;
}

// Shape switches can orphan cells (hex links (±1,∓1) don't exist for squares);
// keep only what the new adjacency still reaches from the origin.
/**
 * @param {Cell[]} cells
 * @param {Shape} [shape]
 * @returns {Cell[]}
 */
export function pruneToOrigin(cells, shape = "square") {
  const sel = new Set(cells.map(key));
  if (!sel.has("0,0")) return cells.length ? [cells[0]] : [];
  const seen = new Set(["0,0"]), stack = [[0, 0]];
  while (stack.length) {
    const [i, j] = /** @type {Cell} */ (stack.pop());
    for (const [di, dj] of NEIGHBORS[shape]) {
      const k = `${i + di},${j + dj}`;
      if (sel.has(k) && !seen.has(k)) { seen.add(k); stack.push([i + di, j + dj]); }
    }
  }
  return cells.filter((c) => seen.has(key(c)));
}

// Pure point-in-polygon (ray casting). polygon is [[a,b],…]; point is [a,b] in
// the SAME coordinate pair order (we test lat/lon against a lat/lon polygon).
/**
 * @param {[number,number]} point
 * @param {Array<[number,number]>} polygon
 * @returns {boolean}
 */
export function pointInPolygon([px, py], polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const hit = yi > py !== yj > py &&
      px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}
