// Headless bake + export orchestration: (square-tile settings) → source zoom +
// Mercator pixel window + print geom → elevation grid → watertight solid →
// validated .3mf. This is the "library" surface a thin UI drives. Single square
// tile, monochrome — water/color/multi-tile arrive in later features.
import { cellsBbox, cellWindows } from "./layout.js";
import { sourceZoom, MAX_MERCATOR_LAT } from "./tilemath.js";
import { cropGrid, gridRange } from "./resample.js";
import { buildSolid } from "./mesh.js";
import { checkWatertight, signedVolume } from "./validate.js";
import { ThreeMFWriter } from "./threemf.js";
import { fetchMosaic } from "./terrain.js";

/** @typedef {import("./types.js").BBox} BBox */
/** @typedef {import("./types.js").Cell} Cell */
/** @typedef {import("./types.js").LatLon} LatLon */
/** @typedef {import("./types.js").Window} Window */
/** @typedef {import("./types.js").Span} Span */
/** @typedef {import("./types.js").Mosaic} Mosaic */
/** @typedef {import("./types.js").Solid} Solid */
/**
 * @typedef {{ center: LatLon, scale: number, tileWmm: number, base: number, exag: number }} TileSettings
 *   center = [lat,lon] of the tile; scale = 1:N; tileWmm = print size of the tile
 *   edge; base = base-plate thickness (mm); exag = vertical exaggeration.
 */
/**
 * @typedef {{ z: number, bbox: BBox, window: Window, span: Span, gw: number, gh: number, dx: number, dy: number, mmPerM: number }} TilePlan
 *   z = source zoom; bbox = fetch bounds; window = exact Mercator pixel window;
 *   span = full-coverage cell span; gw/gh = window dims; dx/dy = print mm per
 *   pixel; mmPerM = print mm per metre of elevation (pre-exaggeration).
 */

/** @type {Cell[]} */
const ORIGIN = [[0, 0]]; // single-tile layout: one cell at the origin

// Pure: settings (+ optional explicit zoom) → source zoom, fetch bbox, exact
// pixel window, and print geom. Omit `z` to auto-pick the deepest useful zoom.
/**
 * @param {TileSettings} settings
 * @param {{ z?: number, maxTiles?: number }} [opts]
 * @returns {TilePlan}
 */
export function planSquareTile(settings, { z, maxTiles = 300 } = {}) {
  const { center, scale, tileWmm } = settings;
  const [lat] = center;
  const bbox = cellsBbox(center, scale, tileWmm, ORIGIN, "square");
  const [s, , n] = bbox;
  // Web Mercator only covers ±85.0511°; a tile spilling past it (a very large or
  // near-polar tile) has no source tiles. Reject up front with a clear message
  // instead of burning fetches on a window that only fails deep inside cropGrid.
  // Written as a negated range test so a non-finite edge would be rejected too.
  if (!(s >= -MAX_MERCATOR_LAT && n <= MAX_MERCATOR_LAT)) {
    throw new Error(
      `planSquareTile: tile latitude span [${s.toFixed(4)}, ${n.toFixed(4)}]° ` +
      `exceeds the ±${MAX_MERCATOR_LAT.toFixed(4)}° Web Mercator limit`);
  }
  const zoom = z ?? sourceZoom(bbox, lat, scale, maxTiles);
  const { spanPx, union } = cellWindows(center, scale, tileWmm, ORIGIN, zoom, "square");
  const dx = tileWmm / spanPx; // Mercator is conformal: square cells → dx = dy
  return {
    z: zoom,
    bbox,
    window: union,
    span: { r0: 0, r1: union.gh - 1, c0: 0, c1: union.gw - 1 },
    gw: union.gw,
    gh: union.gh,
    dx,
    dy: dx,
    mmPerM: 1000 / scale,
  };
}

// Pure: decoded mosaic + plan + {base,exag} → validated watertight solid. emin is
// the tile's own grid minimum (single tile, so no cross-tile z-frame needed).
// Throws rather than emit a mesh that isn't a positive-volume closed manifold.
/**
 * @param {Mosaic} mosaic
 * @param {TilePlan} plan
 * @param {{ base: number, exag: number }} settings
 * @returns {Solid}
 */
export function bakeSquareTileSolid(mosaic, plan, { base, exag }) {
  const { window, span, gw, gh, dx, dy, mmPerM } = plan;
  const grid = cropGrid(mosaic, window);
  const { min: emin } = gridRange(grid);
  const mask = new Uint8Array((gw - 1) * (gh - 1)).fill(1); // full square footprint
  const solid = buildSolid(grid, gw, gh, span, mask, { dx, dy, mmPerM, emin, exag, base });
  const wt = checkWatertight(solid);
  if (!wt.closed) throw new Error(`pipeline: non-watertight solid (${wt.unmatched} unmatched edges)`);
  if (signedVolume(solid) <= 0) throw new Error("pipeline: non-positive-volume (inside-out) solid");
  return solid;
}

// One solid → a single-object .3mf blob (tile placed at the plate origin).
/**
 * @param {string} name
 * @param {Solid} solid
 * @returns {Promise<Uint8Array>}
 */
export async function tileTo3mf(name, solid) {
  const writer = new ThreeMFWriter();
  await writer.addObject(name, solid, 0, 0);
  return writer.finish();
}

// Default export name: hemisphere-tagged center coordinates, so separate exports
// get distinct, self-describing filenames (e.g. "terrane_tile_47.6035N_122.3294W").
/**
 * @param {LatLon} center
 * @returns {string}
 */
export function defaultTileName([lat, lon]) {
  const ns = `${Math.abs(lat).toFixed(4)}${lat >= 0 ? "N" : "S"}`;
  const ew = `${Math.abs(lon).toFixed(4)}${lon >= 0 ? "E" : "W"}`;
  return `terrane_tile_${ns}_${ew}`;
}

// Browser entry: fetch the tile's terrarium mosaic, bake, and serialize. The only
// networked step — untested under node (fetchMosaic guards its browser APIs).
/**
 * @param {TileSettings} settings
 * @param {{ z?: number, maxTiles?: number, name?: string }} [opts]
 * @returns {Promise<Uint8Array>}
 */
export async function exportSquareTile(settings, opts = {}) {
  const plan = planSquareTile(settings, opts);
  const mosaic = await fetchMosaic(plan.bbox, plan.z);
  const solid = bakeSquareTileSolid(mosaic, plan, settings);
  return tileTo3mf(opts.name ?? defaultTileName(settings.center), solid);
}
