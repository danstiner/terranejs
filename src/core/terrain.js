// Fetch Re:Earth Terrain (Mapterhorn) tiles for a bbox and assemble decoded mosaics:
// elevation (terrarium-encoded) and the companion ocean watermask. Browser-only APIs
// (fetch, createImageBitmap, OffscreenCanvas, document) are referenced only inside
// function bodies, so this module still imports under node for the pure decode tests.
import { sourceTileRange } from "./tilemath.js";

/** @typedef {import("./types.js").BBox} BBox */
/** @typedef {import("./types.js").Mosaic} Mosaic */

// Re:Earth Terrain serves the open Mapterhorn DEM (Copernicus GLO-30 land + swissALTI3D in
// Switzerland, geoid-corrected to EGM2008) as terrarium tiles, plus a Protomaps/OSM-derived
// ocean watermask. Both are keyless + CORS, z0–14. The ocean is clamped to ~0 (no bathymetry)
// — which is what we want: the watermask gives the exact coast, and Recessed/Flat flatten the
// ocean anyway. See docs/specs/data-sources.md. Attribution: Re:Earth Terrain, Mapterhorn,
// EGM2008 (NGA), upstream Copernicus/swisstopo/OpenStreetMap.
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

// Watermask decode: opaque (alpha > 127) over ocean, transparent over land. Return 1 for ocean,
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

// Fetch one tile → raw RGBA. force-cache because these datasets rarely change.
/**
 * @param {string} urlTemplate
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {Promise<Uint8ClampedArray>}
 */
async function fetchTileRGBA(urlTemplate, x, y, z) {
  const url = urlTemplate.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
  const res = await fetch(url, { mode: "cors", cache: "force-cache" });
  if (!res.ok) throw new Error(`tile ${z}/${x}/${y}: HTTP ${res.status}`);
  // colorSpaceConversion/premultiplyAlpha "none": keep the raw bytes exact — any colour
  // management or alpha premultiply would corrupt the terrarium encoding or the mask alpha.
  const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const ctx = ctx2d();
  ctx.drawImage(bmp, 0, 0);
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
 * @param {BBox} bbox @param {number} z
 * @param {{ concurrency?: number, onProgress?: (done: number, total: number) => void }} [opts]
 * @returns {Promise<Mosaic>}
 */
async function fetchTiles(urlTemplate, decode, bbox, z, { concurrency = 4, onProgress } = {}) {
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
      const g = decode(await fetchTileRGBA(urlTemplate, x, y, z));
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
export function fetchMosaic(bbox, z, opts) { return fetchTiles(ELEV_TILE_URL, decodeTerrarium, bbox, z, opts); }

// Ocean-watermask mosaic for a bbox+zoom (data: 1 = ocean, 0 = land), pixel-aligned with the
// elevation mosaic at the same bbox+zoom so it drops straight into cropGrid.
/**
 * @param {BBox} bbox @param {number} z
 * @param {{ concurrency?: number, onProgress?: (done: number, total: number) => void }} [opts]
 * @returns {Promise<Mosaic>}
 */
export function fetchWaterMask(bbox, z, opts) { return fetchTiles(WATERMASK_TILE_URL, decodeWatermask, bbox, z, opts); }
