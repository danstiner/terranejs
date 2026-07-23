// Off-main-thread bake service — the reason the main thread never freezes. Handed
// (settings, maxTiles, format) it runs the headless pipeline (fetch → bake →
// optional .3mf) and posts the result back, transferring the buffers zero-copy. It
// knows nothing about preview vs export vs fast vs crisp; that policy lives in
// app.js. `format` is an output selector, not render policy. One job at a time.
import { planSquareTile, planDetect, bakeSquareTileSolid, tileTo3mf } from "../core/pipeline.js";
import { vertexNormals } from "../core/normals.js";
import { fetchMosaic } from "../core/terrain.js";
import { cropGrid } from "../core/resample.js";
import { BAND_COLORS, BAND_NAMES, BOUNDARY_NAMES, bandThresholds, baseBand, colorChanges, baseColorHex } from "../core/colors.js";
import { seaLevelColorLineM, oceanMaskFlood, upsampleMask, cropMask, OCEAN_DETECT_ZOOM_MAX } from "../core/ocean.js";

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
const CACHE_MAX = 5; // fast/crisp/export zooms + a coarse ocean-detection zoom

/** Fetch (or reuse) the decoded mosaic for a bbox+zoom, keyed by the fetch-affecting params.
 * @param {import("../core/types.js").BBox} bbox @param {number} z @param {string} key
 * @param {(done: number, total: number) => void} [onProgress] @returns {Promise<Mosaic>} */
async function getMosaic(bbox, z, key, onProgress) {
  let hit = cache.find((c) => c.key === key);
  if (!hit) {
    hit = { key, mosaic: await fetchMosaic(bbox, z, { onProgress }) };
    cache.push(hit);
    if (cache.length > CACHE_MAX) cache.shift();
  }
  return hit.mosaic;
}

/** @param {{ gen: number, settings: TileSettings, maxTiles: number, format: "mesh" | "3mf", name?: string, color?: boolean }} data */
async function handle({ gen, settings, maxTiles, format, name, color }) {
  try {
    const plan = planSquareTile(settings, { maxTiles });
    const key = JSON.stringify([settings.center, settings.scale, settings.tileWmm, plan.z]);
    const mosaic = await getMosaic(plan.bbox, plan.z, key, (done, total) => post({ gen, progress: { done, total } }));

    // Recessed and Flat both find the sea on a coarse z≤10 grid — the fine grid is
    // fill-contaminated above z10 — via a padded flood-fill (planDetect: 1 tile-width each
    // side, so tile-edge basins stay land), then crop the centre tile and upsample.
    // docs/specs/data-sources.md.
    let oceanMask;
    if (settings.ocean === "recessed" || settings.ocean === "flat") {
      const zc = Math.min(plan.z, OCEAN_DETECT_ZOOM_MAX);
      try {
        const pd = planDetect(settings, zc);
        const keyC = JSON.stringify([settings.center, settings.scale, settings.tileWmm, pd.z, "pad3"]);
        const mosaicC = await getMosaic(pd.bbox, pd.z, keyC);
        const maskP = oceanMaskFlood(cropGrid(mosaicC, pd.union), pd.union.gw, pd.union.gh, 0);
        const maskC = cropMask(maskP, pd.union.gw, pd.union.gh, pd.cx0, pd.cy0, pd.gwTile, pd.ghTile);
        oceanMask = upsampleMask(maskC, pd.gwTile, pd.ghTile, plan.gw, plan.gh);
      } catch (e) {
        // Padded detection unavailable (e.g. the pad crosses the ±85° Mercator limit near the
        // poles) — fall back to unpadded single-tile detection. The enclosed-basin protection
        // padding buys is moot at those latitudes. Warn so a real padded-path bug stays visible.
        console.warn("ocean detection: padded path failed, using unpadded fallback:", e);
        const planC = planSquareTile(settings, { z: zc });
        const keyC = JSON.stringify([settings.center, settings.scale, settings.tileWmm, planC.z]);
        const mosaicC = await getMosaic(planC.bbox, planC.z, keyC);
        const maskC = oceanMaskFlood(cropGrid(mosaicC, planC.window), planC.gw, planC.gh, 0);
        oceanMask = upsampleMask(maskC, planC.gw, planC.gh, plan.gw, plan.gh);
      }
    }

    post({ gen, baking: true }); // all tiles in hand → meshing + validation (synchronous, blocks the worker)
    const { solid, emin, emax } = bakeSquareTileSolid(mosaic, plan, settings, oceanMask);
    // Latitude-adjusted color changes for THIS bake's frame. Shared by the preview
    // (returned as `bands`) and, later, the export embed. K>0 since exag ∈ [0.5,4].
    const K = plan.mmPerM * settings.exag;
    const thresholds = bandThresholds(settings.center[0]);
    // Flat places the ocean→land M600 at print-Z base + colorLiftMm (threshold colorLiftMm/K m)
    // so the flush ocean layer prints ocean and the next layer up prints land; Recessed /
    // bathymetric keep the line at sea level (recess supplies the gap in geometry).
    thresholds[0] = seaLevelColorLineM(settings.ocean, settings.colorLiftMm ?? 0, K);
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
      // emin + geom let the preview invert a surface point's print-Z back to metres
      // for the hover elevation probe: elev = emin + (z − base)/(mmPerM·exag).
      const probeFrame = { emin, base: settings.base, mmPerM: plan.mmPerM, exag: settings.exag };
      post({ gen, positions: solid.positions, indices: solid.indices, normals, bands, frame: probeFrame },
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
