// Off-main-thread bake service — the reason the main thread never freezes. Handed
// (settings, maxTiles, format) it runs the headless pipeline (fetch → bake →
// optional .3mf) and posts the result back, transferring the buffers zero-copy. It
// knows nothing about preview vs export vs fast vs crisp; that policy lives in
// app.js. `format` is an output selector, not render policy. One job at a time.
import { planSquareTile, bakeSquareTileSolid, tileTo3mf } from "../core/pipeline.js";
import { vertexNormals } from "../core/normals.js";
import { fetchMosaic } from "../core/terrain.js";
import { BAND_COLORS, BAND_NAMES, BOUNDARY_NAMES, bandThresholds, baseBand, colorChanges, baseColorHex } from "../core/colors.js";

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

/** @param {{ gen: number, settings: TileSettings, maxTiles: number, format: "mesh" | "3mf", name?: string, color?: boolean }} data */
async function handle({ gen, settings, maxTiles, format, name, color }) {
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
    const { solid, emin, emax } = bakeSquareTileSolid(hit.mosaic, plan, settings);
    // Latitude-adjusted color changes for THIS bake's frame. Shared by the preview
    // (returned as `bands`) and, later, the export embed. K>0 since exag ∈ [0.5,4].
    const thresholds = bandThresholds(settings.center[0]);
    const K = plan.mmPerM * settings.exag;
    const frame = { emin, base: settings.base, mmPerM: plan.mmPerM, exag: settings.exag, zmax: settings.base + (emax - emin) * K };
    // Enrich each change with its boundary line + elevation for the preview legend
    // (the shader and export use only z + color, so the extra fields are harmless there).
    const changes = colorChanges(thresholds, frame).map((c) => ({
      ...c, elev: Math.round(thresholds[c.band - 1]), boundary: BOUNDARY_NAMES[c.band - 1],
    }));
    if (format === "3mf") {
      const bytes = await tileTo3mf(name ?? "tile", solid, color ? changes : undefined);
      post({ gen, bytes }, [bytes.buffer]);
    } else {
      // Normals for the lit preview, computed here so the main thread never meshes
      // them. Only the mesh path needs them — a slicer derives its own from 3mf.
      const normals = vertexNormals(solid.positions, solid.indices);
      const bb = baseBand(emin, thresholds);
      const bands = {
        changes,
        baseColor: BAND_COLORS[bb],
        baseHex: baseColorHex(emin, thresholds),
        baseName: BAND_NAMES[bb],
      };
      post({ gen, positions: solid.positions, indices: solid.indices, normals, bands },
        [solid.positions.buffer, solid.indices.buffer, normals.buffer]);
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
