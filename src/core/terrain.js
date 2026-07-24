// Fetch Re:Earth Terrain (Mapterhorn) tiles for a bbox and assemble decoded mosaics:
// elevation (terrarium-encoded) and the companion water watermask. Browser-only APIs
// (fetch, createImageBitmap, OffscreenCanvas, document) are referenced only inside
// function bodies, so this module still imports under node for the pure decode tests.
import { sourceTileRange } from "./tilemath.js";

/** @typedef {import("./types.js").BBox} BBox */
/** @typedef {import("./types.js").Mosaic} Mosaic */

// Re:Earth Terrain serves the open Mapterhorn DEM (Copernicus GLO-30 land + swissALTI3D in
// Switzerland, geoid-corrected to EGM2008) as terrarium elevation tiles, plus a Protomaps/OSM-
// derived watermask (sea + lakes). Both keyless + CORS. The elevation is served as 512-px "@2x"
// tiles (native pyramid to z14, so a z14 tile carries z15-equivalent 256-px detail); the
// watermask is plain 256-px. We extract the native 256-px quadrant from each elevation tile
// (see fetchTileRGBA). Masked water is clamped to ~0 (no bathymetry) — which is what we want:
// the watermask gives the exact coast, and Recessed/Flat flatten the water anyway. See
// docs/specs/data-sources.md. Attribution: Re:Earth Terrain, Mapterhorn, EGM2008 (NGA),
// upstream Copernicus/swisstopo/OpenStreetMap.
const ELEV_TILE_URL = "https://terrain.reearth.land/terrarium/elevation/{z}/{x}/{y}.png";
const WATERMASK_TILE_URL = "https://terrain.reearth.land/mapterhorn-egm08/watermask/{z}/{x}/{y}.png";

// Terrarium encoding: elevation_m = (R*256 + G + B/256) - 32768.
// https://github.com/tilezen/joerd/blob/master/docs/formats.md#terrarium
/**
 * @param {Uint8ClampedArray | Uint8Array} rgba
 * @param {number} [n]
 * @returns {Float32Array}
 */
export function decodeTerrarium(rgba, n = rgba.length / 4) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    out[i] = rgba[j] * 256 + rgba[j + 1] + rgba[j + 2] / 256 - 32768;
  }
  return out;
}

// Watermask decode: opaque (alpha > 127) over water, transparent over land. Return 1 for water,
// 0 for land — a Float32 grid so it rides the same mosaic/cropGrid path as elevation.
/**
 * @param {Uint8ClampedArray | Uint8Array} rgba
 * @param {number} [n]
 * @returns {Float32Array}
 */
export function decodeWatermask(rgba, n = rgba.length / 4) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rgba[i * 4 + 3] > 127 ? 1 : 0;
  return out;
}

// 256×256 2d context: OffscreenCanvas in a worker, else a DOM canvas. willReadFrequently keeps
// getImageData on the CPU path; srgb avoids colour management.
/**
 * @returns {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D}
 */
function ctx2d() {
  /** @type {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null} */
  let ctx;
  if (typeof OffscreenCanvas !== "undefined") {
    ctx = new OffscreenCanvas(256, 256).getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
  } else {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 256;
    ctx = cv.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
  }
  if (!ctx) throw new Error("2d canvas context unavailable");
  return ctx;
}

// Fetch one terranejs 256-px tile (x,y,z) → raw RGBA. force-cache because these datasets rarely
// change. The elevation source is served as 512-px "@2x" tiles: (x,y,z) is the same ground as a
// standard 256-px tile at double density, so the 256-px view we want is one native quadrant of
// the z-1 512-px tile. Extract it with a raw 1:1 pixel copy — never a downscale, since averaging
// terrarium-encoded RGB corrupts elevation across the G/B byte rollovers. The watermask is a
// plain 256-px tile, fetched at (x,y,z) untouched.
/**
 * @param {string} urlTemplate
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {boolean} retina  true = 512-px 2× elevation (quadrant-extract); false = 256-px watermask
 * @returns {Promise<Uint8ClampedArray>}
 */
async function fetchTileRGBA(urlTemplate, x, y, z, retina) {
  const [sx, sy, sz, ox, oy] = retina
    ? [x >> 1, y >> 1, z - 1, (x & 1) * 256, (y & 1) * 256]
    : [x, y, z, 0, 0];
  const url = urlTemplate.replace("{z}", String(sz)).replace("{x}", String(sx)).replace("{y}", String(sy));
  const res = await fetch(url, { mode: "cors", cache: "force-cache" });
  if (!res.ok) throw new Error(`tile ${sz}/${sx}/${sy}: HTTP ${res.status}`);
  // colorSpaceConversion/premultiplyAlpha "none": keep the raw bytes exact — any colour
  // management or alpha premultiply would corrupt the terrarium encoding or the mask alpha.
  const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const ctx = ctx2d();
  ctx.imageSmoothingEnabled = false; // 1:1 copy; guard against any interpolation on the offset draw
  ctx.drawImage(bmp, -ox, -oy); // shift the wanted 256-px quadrant onto the canvas origin
  bmp.close();
  return ctx.getImageData(0, 0, 256, 256).data;
}

// Bounded-concurrency async map; results are written into the caller's buffer.
/**
 * @template T
 * @param {T[]} items @param {number} limit
 * @param {(item: T, i: number) => Promise<void>} fn
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {Promise<void>}
 */
async function mapLimit(items, limit, fn, onProgress) {
  let next = 0, done = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
      onProgress?.(++done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Fetch/placement plan for a clamped tile range. Longitude is periodic (wraps modulo the
// world); latitude is not (callers pass a clamped y-range; y is never wrapped).
/**
 * @param {{ tx0: number, tx1: number, ty0: number, ty1: number }} range
 * @param {number} z
 * @returns {{ x: number, y: number, ox: number, oy: number }[]}
 */
export function mosaicTiles({ tx0, tx1, ty0, ty1 }, z) {
  const world = 2 ** z;
  /** @type {{ x: number, y: number, ox: number, oy: number }[]} */
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++)
    for (let tx = tx0; tx <= tx1; tx++)
      jobs.push({ x: ((tx % world) + world) % world, y: ty, ox: (tx - tx0) * 256, oy: (ty - ty0) * 256 });
  return jobs;
}

// Fetch every 256-px tile covering bbox at zoom z, decode each, and stitch into one mosaic in
// global-pixel space. Shared by the elevation and watermask fetches.
/**
 * @param {string} urlTemplate
 * @param {(rgba: Uint8ClampedArray) => Float32Array} decode
 * @param {boolean} retina  512-px 2× source (elevation) vs plain 256-px (watermask) — see fetchTileRGBA
 * @param {BBox} bbox @param {number} z
 * @param {{ concurrency?: number, onProgress?: (done: number, total: number) => void }} [opts]
 * @returns {Promise<Mosaic>}
 */
async function fetchTiles(urlTemplate, decode, retina, bbox, z, { concurrency = 4, onProgress } = {}) {
  const world = 2 ** z;
  const { tx0, tx1, ty0: ry0, ty1: ry1 } = sourceTileRange(bbox, z);
  const ty0 = Math.max(0, ry0), ty1 = Math.min(world - 1, ry1);
  const nx = tx1 - tx0 + 1, ny = ty1 - ty0 + 1;
  if (nx < 1 || ny < 1) {
    throw new Error(`fetchTiles: bbox has no tiles at z=${z} (latitude beyond the ±85.05° Web Mercator limit?)`);
  }
  const width = nx * 256, height = ny * 256;
  const data = new Float32Array(width * height);
  await mapLimit(mosaicTiles({ tx0, tx1, ty0, ty1 }, z), concurrency,
    async ({ x, y, ox, oy }) => {
      const g = decode(await fetchTileRGBA(urlTemplate, x, y, z, retina));
      for (let r = 0; r < 256; r++) data.set(g.subarray(r * 256, r * 256 + 256), (oy + r) * width + ox);
    }, onProgress);
  return { data, width, height, originGx: tx0 * 256, originGy: ty0 * 256, z };
}

// Decoded elevation mosaic for a bbox+zoom.
/**
 * @param {BBox} bbox @param {number} z
 * @param {{ concurrency?: number, onProgress?: (done: number, total: number) => void }} [opts]
 * @returns {Promise<Mosaic>}
 */
export function fetchMosaic(bbox, z, opts) { return fetchTiles(ELEV_TILE_URL, decodeTerrarium, true, bbox, z, opts); }

// Watermask mosaic for a bbox+zoom (data: 1 = water, 0 = land), pixel-aligned with the
// elevation mosaic at the same bbox+zoom so it drops straight into cropGrid.
/**
 * @param {BBox} bbox @param {number} z
 * @param {{ concurrency?: number, onProgress?: (done: number, total: number) => void }} [opts]
 * @returns {Promise<Mosaic>}
 */
export function fetchWaterMask(bbox, z, opts) { return fetchTiles(WATERMASK_TILE_URL, decodeWatermask, false, bbox, z, opts); }
