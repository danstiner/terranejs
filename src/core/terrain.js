// Fetch AWS terrarium elevation tiles for a bbox and assemble a decoded mosaic.
// Browser-only APIs (fetch, createImageBitmap, OffscreenCanvas, document) are
// referenced only inside function bodies, so this module still imports under
// node for the pure decode tests.
import { tileRangeForBBox } from "./tilemath.js";

/** @typedef {import("./types.js").BBox} BBox */
/** @typedef {import("./types.js").Mosaic} Mosaic */

const TILE = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

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

// 256×256 2d context: OffscreenCanvas in a worker, else a DOM canvas. willRead-
// Frequently keeps getImageData on the CPU path; srgb avoids colour management.
/**
 * @returns {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D}
 */
function ctx2d() {
  /** @type {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null} */
  let ctx;
  if (typeof OffscreenCanvas !== "undefined") {
    ctx = new OffscreenCanvas(256, 256)
      .getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
  } else {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 256;
    ctx = cv.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
  }
  if (!ctx) throw new Error("2d canvas context unavailable");
  return ctx;
}

/**
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {Promise<Uint8ClampedArray>}
 */
async function fetchTilePixels(x, y, z) {
  const url = TILE.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
  const res = await fetch(url, { mode: "cors", cache: "force-cache" });
  if (!res.ok) throw new Error(`tile ${z}/${x}/${y}: HTTP ${res.status}`);
  // colorSpaceConversion/premultiplyAlpha "none": keep the raw PNG bytes exact —
  // any colour management or alpha premultiply would corrupt the elevation encoding.
  const bmp = await createImageBitmap(await res.blob(), {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });
  const ctx = ctx2d();
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return ctx.getImageData(0, 0, 256, 256).data; // Uint8ClampedArray
}

// Bounded-concurrency async map; results are written into the caller's buffer,
// so nothing is collected here.
/**
 * @template T
 * @param {T[]} items
 * @param {number} limit
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

// Fetch/placement plan for a clamped tile range. Longitude is periodic, so the
// fetch index wraps modulo the world — an index of 2^z or -1 maps to a real tile
// (the one just across the antimeridian) rather than a 404 — while the
// destination column stays unwrapped so a strip spanning the seam stitches
// contiguously. Latitude is not periodic: callers pass a y-range already clamped
// to valid rows, and y is never wrapped.
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

// Fetch every 256-px tile covering bbox at zoom z and stitch them into one
// mosaic in global-pixel space. force-cache because elevation datasets rarely change.
/**
 * @param {BBox} bbox
 * @param {number} z
 * @param {{ concurrency?: number, onProgress?: (done: number, total: number) => void }} [opts]
 * @returns {Promise<Mosaic>}
 */
export async function fetchMosaic(bbox, z, { concurrency = 4, onProgress } = {}) {
  const world = 2 ** z;
  const { tx0, tx1, ty0: ry0, ty1: ry1 } = tileRangeForBBox(bbox, z);
  // Longitude wraps (handled in mosaicTiles); latitude does not, so clamp y to valid
  // rows — the resampler's edge-clamp covers the sub-pixel shortfall at the cap.
  const ty0 = Math.max(0, ry0), ty1 = Math.min(world - 1, ry1);
  const nx = tx1 - tx0 + 1, ny = ty1 - ty0 + 1;
  // A bbox entirely beyond the ±85.05° Mercator limit clamps to an empty y-range;
  // fail loud rather than allocate a negative-length buffer and corrupt the mosaic.
  if (nx < 1 || ny < 1) {
    throw new Error(`fetchMosaic: bbox has no tiles at z=${z} (latitude beyond the ±85.05° Web Mercator limit?)`);
  }
  const width = nx * 256, height = ny * 256;
  const data = new Float32Array(width * height);

  await mapLimit(mosaicTiles({ tx0, tx1, ty0, ty1 }, z), concurrency,
    async ({ x, y, ox, oy }) => {
      const elev = decodeTerrarium(await fetchTilePixels(x, y, z));
      for (let r = 0; r < 256; r++) {
        const dst = (oy + r) * width + ox;
        data.set(elev.subarray(r * 256, r * 256 + 256), dst);
      }
    }, onProgress);

  return { data, width, height, originGx: tx0 * 256, originGy: ty0 * 256, z };
}
