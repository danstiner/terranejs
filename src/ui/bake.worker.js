// Off-main-thread bake service — the reason the main thread never freezes. Handed
// (settings, maxTiles, format) it runs the headless pipeline (fetch → bake →
// optional .3mf) and posts the result back, transferring the buffers zero-copy. It
// knows nothing about preview vs export vs fast vs crisp; that policy lives in
// app.js. `format` is an output selector, not render policy. One job at a time.
import { planTile, bakeTileSolid, tileTo3mf } from "../core/pipeline.js";
import { vertexNormals } from "../core/normals.js";
import { fetchMosaic, fetchWaterMask } from "../core/terrain.js";
import { cropGrid } from "../core/resample.js";
import { BAND_COLORS, BAND_NAMES, BOUNDARY_NAMES, bandThresholds, baseBand, colorChanges, baseColorHex, waterLineThresholds } from "../core/colors.js";

/** @typedef {import("../core/pipeline.js").TileSettings} TileSettings */

// self.postMessage is typed as Window.postMessage (message, targetOrigin) under the
// DOM lib — wrong for a worker. Bind + cast to the real dedicated-worker signature
// (message, transfer[]) so zero-copy transfers typecheck.
const post = /** @type {(msg: unknown, transfer?: Transferable[]) => void} */ (
  /** @type {unknown} */ (self.postMessage.bind(self))
);

// No mosaic cache: `fetchTileRGBA` already fetches force-cache, so a re-bake at the same
// zoom re-reads the tiles from the HTTP cache and only pays the decode — ~100 ms at preview
// scale, behind a 500 ms debounce. Retaining decoded mosaics to skip that meant holding tens
// of MB (an export mosaic is ~25 MB, and its watermask another ~25 MB) for an imperceptible
// win, so the bake decodes fresh every time.
/** @param {{ gen: number, settings: TileSettings, maxTiles: number, format: "mesh" | "3mf", name?: string, color?: boolean }} data */
async function handle({ gen, settings, maxTiles, format, name, color }) {
  try {
    const plan = planTile(settings, { maxTiles });
    // Water mask from the Re:Earth watermask tile — pixel-aligned with the elevation at the
    // same bbox+zoom, so no detection/flood-fill: fetch, crop to the window, threshold alpha.
    // Water is always considered: applyWaterRecess (in the bake) no-ops when the tile has no
    // water, so a landlocked tile just falls through. The two fans are independent sources, so
    // overlap them — the bake pays the slower round-trip, not the sum of both.
    const [mosaic, wmMosaic] = await Promise.all([
      fetchMosaic(plan.bbox, plan.z, { onProgress: (done, total) => post({ gen, progress: { done, total } }) }),
      fetchWaterMask(plan.bbox, plan.z),
    ]);
    const wmGrid = cropGrid(wmMosaic, plan.window);
    const waterMask = new Uint8Array(wmGrid.length);
    for (let i = 0; i < wmGrid.length; i++) waterMask[i] = wmGrid[i] > 0.5 ? 1 : 0;

    post({ gen, baking: true }); // all tiles in hand → meshing + validation (synchronous, blocks the worker)
    const { solid, emin, emax, lineElev, landBluePct } = bakeTileSolid(mosaic, plan, settings, waterMask);
    // Latitude-adjusted color changes for THIS bake's frame. Shared by the preview
    // (returned as `bands`) and, later, the export embed. K>0 since exag ∈ [0.5,4].
    const K = plan.mmPerM * settings.exag;
    // threshold[0] = the tile's anchored water/land colour line; clamp the ecological bands up to
    // it so the threshold array stays ascending (see colors.waterLineThresholds).
    const thresholds = waterLineThresholds(bandThresholds(settings.center[0]), lineElev);
    const frame = { emin, base: settings.base, mmPerM: plan.mmPerM, exag: settings.exag, zmax: settings.base + (emax - emin) * K };
    // Enrich each change with its boundary line + elevation for the preview legend
    // (the shader and export use only z + color, so the extra fields are harmless there).
    const changes = colorChanges(thresholds, frame).map((c) => ({
      ...c, elev: Math.round(thresholds[c.band - 1]), boundary: BOUNDARY_NAMES[c.band - 1],
    }));
    if (format === "3mf") {
      // Export lifts the water pause one print layer above the line so the water's top layer
      // prints blue before the swap; preview/warning keep the true line (a sub-layer print
      // quantization, not a model difference). Base divisible by layer height → the pause lands
      // exactly on the first land layer of an ocean-floor tile.
      const exportChanges = color
        ? colorChanges(thresholds, frame, { pauseLiftMm: settings.layerMm ?? 0.15 })
        : undefined;
      const bytes = await tileTo3mf(name ?? "tile", solid, exportChanges);
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
      // emin + geom let the preview invert a surface point's print-Z back to metres for the
      // hover probe. The pre-recess elevations + water mask ride along too (a fresh crop —
      // bakeTileSolid mutated its own copy in place), so the probe can report a water
      // cell's ORIGINAL elevation, which the printed surface no longer encodes once water moves.
      const probeGrid = cropGrid(mosaic, plan.window);
      const probeFrame = {
        emin, base: settings.base, mmPerM: plan.mmPerM, exag: settings.exag,
        orig: probeGrid, mask: waterMask, gw: plan.gw, gh: plan.gh, dx: plan.dx, dy: plan.dy,
        recessed: (settings.flatten ?? false) || (settings.recessMm ?? 0) > 0,
      };
      post({ gen, positions: solid.positions, indices: solid.indices, normals, bands, frame: probeFrame, landBluePct },
        [solid.positions.buffer, solid.indices.buffer, normals.buffer, probeGrid.buffer, waterMask.buffer]);
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
