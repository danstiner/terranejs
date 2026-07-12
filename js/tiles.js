// Tile-first cell model. A layout is (center latlon, scale 1:N, tileWmm,
// cells [[i,j],…]) with cell (0,0) centered on `center`, +i east, +j south.
// The layout is uniform in Mercator space — the same space as the terrarium
// pixel lattice — so cell edges quantize to shared lattice indices and
// adjacent tiles read identical seam data by construction.
import { lonToGlobalX, latToGlobalY, globalXToLon, globalYToLat, printPitchMm }
  from "./tilemath.js";
import { pointInPolygon } from "./polyclip.js";

export const CELL_CAP = 64;

// Mercator-pixel span of one tile edge at zoom z (float; Mercator is conformal
// so one span serves both axes — the print is tileWmm square at center lat)
export function tileSpanPx(centerLat, scale, tileWmm, z) {
  return tileWmm / printPitchMm(centerLat, z, scale);
}

const key = ([i, j]) => `${i},${j}`;

// Per-cell pixel windows at zoom z. Cell edges land on Math.round of the exact
// Mercator boundary, so adjacent cells SHARE the boundary pixel index — the
// splits() principle; physical tile size quantizes to pixel pitch (≤1 px).
// Windows are inclusive pixel-center ranges: {gx0, gy0, gw, gh}.
export function cellWindows([lat, lon], scale, tileWmm, cells, z) {
  const S = tileSpanPx(lat, scale, tileWmm, z);
  if (S < 2) throw new Error("tile smaller than one pixel at this zoom — raise the detail slider");
  const gxC = lonToGlobalX(lon, z), gyC = latToGlobalY(lat, z);
  const bx = (i) => Math.round(gxC + (i - 0.5) * S);
  const by = (j) => Math.round(gyC + (j - 0.5) * S);
  const wins = new Map();
  let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
  for (const cell of cells) {
    const [i, j] = cell;
    const x0 = bx(i), x1 = bx(i + 1), y0 = by(j), y1 = by(j + 1);
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

export function cellsBbox(center, scale, tileWmm, cells) {
  let bb = [Infinity, Infinity, -Infinity, -Infinity];
  for (const c of cells) {
    const [s, w, n, e] = cellBbox(center, scale, tileWmm, c);
    bb = [Math.min(bb[0], s), Math.min(bb[1], w), Math.max(bb[2], n), Math.max(bb[3], e)];
  }
  return bb;
}

// 4-neighborhood ghosts (square). Plan 2 adds the hex 6-neighborhood.
export function ghostCells(cells) {
  const sel = new Set(cells.map(key));
  const out = new Map();
  for (const [i, j] of cells) {
    for (const n of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]]) {
      const k = key(n);
      if (!sel.has(k)) out.set(k, n);
    }
  }
  return [...out.values()];
}

// Vertex-center inside mask over a window bbox (row 0 = north) — the boundary
// flatten reads this; cells stay meshed, only elevations change.
export function vertexMask(polygon, [s, w, n, e], gw, gh) {
  const mask = new Uint8Array(gw * gh);
  for (let r = 0; r < gh; r++) {
    const lat = n - ((n - s) * r) / (gh - 1);
    for (let c = 0; c < gw; c++) {
      const lon = w + ((e - w) * c) / (gw - 1);
      mask[r * gw + c] = pointInPolygon([lat, lon], polygon) ? 1 : 0;
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
