// Off-main-thread bake service — the reason the main thread never freezes. Handed
// (settings, maxTiles, format) it runs the headless pipeline (fetch → bake →
// optional .3mf) and posts the result back, transferring the buffers zero-copy. It
// knows nothing about preview vs export vs fast vs crisp; that policy lives in
// app.js. `format` is an output selector, not render policy. One job at a time.
import { planSquareTile, bakeSquareTileSolid, tileTo3mf } from "../core/pipeline.js";
import { fetchMosaic } from "../core/terrain.js";

/** @typedef {import("../core/types.js").Mosaic} Mosaic */
/** @typedef {import("../core/pipeline.js").TileSettings} TileSettings */

// self.postMessage is typed as Window.postMessage (message, targetOrigin) under the
// DOM lib — wrong for a worker. Bind + cast to the real dedicated-worker signature
// (message, transfer[]) so zero-copy transfers typecheck.
const post = /** @type {(msg: unknown, transfer?: Transferable[]) => void} */ (
  /** @type {unknown} */ (self.postMessage.bind(self))
);

// Small FIFO cache of decoded mosaics keyed by the fetch-affecting params + zoom,
// so a base/exag tweak (same z) re-bakes without re-fetching+decoding. Holds the
// current tile's fast/crisp/export zooms with room to spare.
/** @type {{ key: string, mosaic: Mosaic }[]} */
const cache = [];
const CACHE_MAX = 4;

/** @param {{ gen: number, settings: TileSettings, maxTiles: number, format: "mesh" | "3mf", name?: string }} data */
async function handle({ gen, settings, maxTiles, format, name }) {
  try {
    const plan = planSquareTile(settings, { maxTiles });
    const key = JSON.stringify([settings.center, settings.scale, settings.tileWmm, plan.z]);
    let hit = cache.find((c) => c.key === key);
    if (!hit) {
      const mosaic = await fetchMosaic(plan.bbox, plan.z, {
        onProgress: (done, total) => post({ gen, progress: { done, total } }),
      });
      hit = { key, mosaic };
      cache.push(hit);
      if (cache.length > CACHE_MAX) cache.shift();
    }
    post({ gen, baking: true }); // all tiles in hand → meshing + validation (synchronous, blocks the worker)
    const solid = bakeSquareTileSolid(hit.mosaic, plan, settings);
    if (format === "3mf") {
      const bytes = await tileTo3mf(name ?? "tile", solid);
      post({ gen, bytes }, [bytes.buffer]);
    } else {
      post({ gen, positions: solid.positions, indices: solid.indices },
        [solid.positions.buffer, solid.indices.buffer]);
    }
  } catch (err) {
    post({ gen, error: err instanceof Error ? err.message : String(err) });
  }
}

// Serialize jobs: each message fully settles before the next starts, so the cache is
// never written by two overlapping jobs. handle() swallows its own errors, so the
// chain never rejects; the trailing catch guards a post() that itself throws (log,
// don't silently drop, so a lost job is at least visible in the console).
let queue = Promise.resolve();
self.onmessage = ({ data }) => { queue = queue.then(() => handle(data)).catch((e) => { console.error("bake worker:", e); }); };
