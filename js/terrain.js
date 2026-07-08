// Fetch AWS terrarium tiles for a bbox and assemble a decoded elevation mosaic.
// Browser-only APIs (fetch, createImageBitmap, OffscreenCanvas) are used only
// inside functions so this module still imports under node for decode tests.
import { tileRangeForBBox } from "./tilemath.js";

const TILE = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

// (R*256 + G + B/256) - 32768, in metres. Pure — unit tested in node.
export function decodeTerrarium(rgba, n = rgba.length / 4) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    out[i] = rgba[j] * 256 + rgba[j + 1] + rgba[j + 2] / 256 - 32768;
  }
  return out;
}

function ctx2d() {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(256, 256)
      .getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
  }
  const cv = document.createElement("canvas");
  cv.width = cv.height = 256;
  return cv.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
}

async function fetchTilePixels(x, y, z) {
  const url = TILE.replace("{z}", z).replace("{x}", x).replace("{y}", y);
  const res = await fetch(url, { mode: "cors", cache: "force-cache" });
  if (!res.ok) throw new Error(`tile ${z}/${x}/${y}: HTTP ${res.status}`);
  const bmp = await createImageBitmap(await res.blob());
  const ctx = ctx2d();
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  return ctx.getImageData(0, 0, 256, 256).data; // Uint8ClampedArray
}

async function mapLimit(items, limit, fn, onProgress) {
  const results = new Array(items.length);
  let next = 0, done = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
      onProgress?.(++done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// -> { data: Float32Array, width, height, originGx, originGy, z }
export async function fetchMosaic(bbox, z, { concurrency = 12, onProgress } = {}) {
  const { tx0, tx1, ty0, ty1 } = tileRangeForBBox(bbox, z);
  const nx = tx1 - tx0 + 1, ny = ty1 - ty0 + 1;
  const width = nx * 256, height = ny * 256;
  const data = new Float32Array(width * height);

  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++)
    for (let tx = tx0; tx <= tx1; tx++) jobs.push([tx, ty]);

  await mapLimit(jobs, concurrency, async ([tx, ty]) => {
    const elev = decodeTerrarium(await fetchTilePixels(tx, ty, z)); // HTTP force-cache covers reloads

    const ox = (tx - tx0) * 256, oy = (ty - ty0) * 256;
    for (let r = 0; r < 256; r++) {
      const dst = (oy + r) * width + ox;
      data.set(elev.subarray(r * 256, r * 256 + 256), dst);
    }
  }, onProgress);

  return { data, width, height, originGx: tx0 * 256, originGy: ty0 * 256, z };
}
