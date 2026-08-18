// Off-main-thread bake service — the reason the main thread never freezes. Handed
// (settings, maxTiles, format) it runs the headless pipeline (fetch → bake →
// optional .3mf) and posts the result back, transferring the buffers zero-copy. It
// knows nothing about preview vs export vs fast vs crisp; that policy lives in
// app.js. `format` and `coverage` are output selectors, not render policy. One job at a time.
import { planTile, bakeTileSolid, tileTo3mf } from "../core/pipeline.js";
import { vertexNormals } from "../core/normals.js";
import { fetchMosaic, fetchWaterMask } from "../core/terrain.js";
import { fetchCoverage, fetchCatalog } from "../core/coverage.js";
import { cropGrid } from "../core/resample.js";
import { detailMap } from "../core/detail.js";
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

// Once per session, and a failure is cached too — including for the rest of the session, so one
// blip means raw ids until reload. The catalog only supplies resolutions for ranking, so that
// degrades the probe rather than failing provenance, and it beats refetching on every bake.
/** @type {Promise<import("../core/coverage.js").Catalog | null> | null} */
let catalogPromise = null;
const catalogOnce = () => (catalogPromise ??= fetchCatalog().catch(() => null));

/** @param {{ gen: number, settings: TileSettings, maxTiles: number, format: "mesh" | "3mf", name?: string, color?: boolean, coverage?: boolean, inlays?: boolean, trail?: {segments: import("../core/types.js").LatLon[][], widthMm: number, heightMm: number, trenchDepthMm: number} | null }} data */
async function handle({ gen, settings, maxTiles, format, name, color, coverage, inlays: wantInlays, trail }) {
  try {
    const plan = planTile(settings, { maxTiles });
    // Started with the raster fans but never awaited in this path: it rides its own message
    // (below), so a slow or hung coverage host delays neither the mesh nor the next queued job.
    // Errors are folded into the payload here so the promise can never reject unhandled.
    // `format` is also checked here, not left to app.js: coverage is a preview diagnostic, and an
    // export has no probe to read it.
    const coverageJob = coverage && format === "mesh"
      ? Promise.all([fetchCoverage(plan.bbox, plan.z, plan.window), catalogOnce()])
        // lat and z ride along because the probe cannot derive them: the maxzoom ranking key is
        // Mercator metres (stretched by 1/cos(lat)) and the feather width is 150 of them. One
        // latitude for the whole tile — a print tile spans a few km, far below a zoom bucket.
        .then(([features, catalog]) => ({ features, catalog, lat: (plan.bbox[0] + plan.bbox[2]) / 2, z: plan.z }))
        .catch((err) => ({ error: err instanceof Error ? err.message : String(err) }))
      : null;
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
    // The inlays cost a second full-grid snapshot plus their own mesh — measured at +60% on a
    // 583² Puget Sound tile — so they are baked only where something reads them: the export, and
    // the settled crisp pass that draws them. Never the quick tier, which fires on every keystroke
    // of a slider drag. Gated on the checkbox in both cases, so a user who is not exporting parts
    // pays nothing and their preview is the mesh it was before.
    //
    // Seated for the mesh, plated for the .3mf: the preview draws them in the hollows they fill,
    // the writer lays them out on the bed. See buildDrape — the two frames are not a translation
    // apart, because each piece is dropped to z 0 independently.
    const opts = {
      ...settings,
      waterInlay: !!settings.waterInlay && (format === "3mf" || !!wantInlays),
      inlaySeated: format === "mesh",
    };
    const job = trail ?? undefined;
    let cordDropped = false;
    let baked;
    try {
      baked = bakeTileSolid(mosaic, plan, opts, waterMask, job);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A cord the sub-lattice can't carry must not cost the preview its terrain: the tile is what
      // is on screen and the cord is one object resting on it. Rebake without the trail and flag
      // it. k counts sub-cells across the cord's width, so the preview's coarser grid asks for a
      // HIGHER k than the export's and reaches subK's triangle allowance first — the flag, not the
      // message, because core's wording names a remedy for a print that is not in trouble (the
      // export draws this cord fine). The export still throws: there the cord is part of the
      // deliverable, and dropping it silently would hand back a file missing what was asked for.
      //
      // Cord-owned throws carry `dropCord` (see cord.js / pipeline.js). Matching the message is
      // what this used to do, and it broke the moment `corridor: ` gained a second meaning: the
      // trail inset's base-cut refusal is the TILE's problem, and swallowing it told the user the
      // cord was too fine and offered a remedy that does nothing.
      if (format !== "mesh" || !(err instanceof Error &&
        /** @type {{ dropCord?: boolean }} */ (err).dropCord === true)) throw err;
      // Logged as well as flagged: three different throws land here — subK's refusal, and the
      // ribbon's two validation failures — and the banner renders all of them as "too fine to
      // draw". A real watertightness bug in the cord would otherwise present as that sentence and
      // nothing else.
      console.warn("bake worker: cord dropped from the preview —", msg);
      cordDropped = true;
      baked = bakeTileSolid(mosaic, plan, opts, waterMask);
    }
    const { solid, ribbon, inlays, emin, emax, lineElev, landBluePct, waterAsLandPct, printedWaterMask, waterDroppedPct, movedWaterMask, waterRecessedPct } = baked;
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
      const bytes = await tileTo3mf(name ?? "tile", solid, exportChanges, ribbon, inlays);
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
      // Detail overlay, off the PRE-recess grid for the same reason as the probe: flattened
      // water would read as zero detail. Cheap (O(cells)), so it rides every bake.
      const detail = detailMap(probeGrid, plan.gw, plan.gh);
      // 0 land, 1 water printed at the waterline, 2 water the size filter left at terrain level,
      // 3 water grooved for an insert. The raw mask alone would report every water cell as
      // recessed; the filtered mask alone would call a dropped body land, which is the raster's
      // answer to a question nobody asked. Four states is what lets the probe and the overlay say
      // which happened — and 3 has to be per cell now that one tile can hold both kinds of water.
      // `flat` is excluded on purpose: movedWaterMask is true for it too (it moves everything),
      // but flat grooves nothing — every masked cell lands on one plane, which is exactly what
      // state 1 already paints. Without the guard state 3's darkened hue would swallow state 1
      // whole under `flat`, when the plane is the only water this mode has.
      //
      // Annotated in place, so no third grid: the worker owns this array and the bake kept its own
      // filtered copy. ?? is for the type only — this path always passes a mask.
      const printed = printedWaterMask ?? waterMask;
      for (let i = 0; i < waterMask.length; i++) {
        if (!waterMask[i]) continue;
        if (!printed[i]) waterMask[i] = 2;
        else if (movedWaterMask?.[i] && settings.waterMode !== "flat") waterMask[i] = 3;
      }
      const probeFrame = {
        emin, base: settings.base, mmPerM: plan.mmPerM, exag: settings.exag,
        orig: probeGrid, mask: waterMask, detail, gw: plan.gw, gh: plan.gh, dx: plan.dx, dy: plan.dy,
      };
      // The cord rides the tile's own message rather than a later one like coverage: they are one
      // picture, and arriving apart would show a frame of terrain with the trail missing from it.
      const cord = ribbon
        ? { positions: ribbon.positions, indices: ribbon.indices, normals: vertexNormals(ribbon.positions, ribbon.indices) }
        : null;
      // Same message as the tile for the same reason as the cord: the parts and the grooves they
      // fill are one picture, and arriving apart would show a frame of hollows with the water
      // missing. No offset rides along — the bake already seated them.
      const parts = inlays
        ? { positions: inlays.positions, indices: inlays.indices,
            normals: vertexNormals(inlays.positions, inlays.indices) }
        : null;
      post({ gen, positions: solid.positions, indices: solid.indices, normals, bands, frame: probeFrame, lineElev, landBluePct, waterAsLandPct, waterDroppedPct, waterRecessedPct, cord, cordDropped, parts },
        [solid.positions.buffer, solid.indices.buffer, normals.buffer, probeGrid.buffer, waterMask.buffer, detail.buffer,
          ...(cord ? [cord.positions.buffer, cord.indices.buffer, cord.normals.buffer] : []),
          ...(parts ? [parts.positions.buffer, parts.indices.buffer, parts.normals.buffer] : [])]);
      // Deliberately not awaited — see above. Detached from the job's own catch, so it carries
      // the same guard: a post() that throws here has no other handler.
      coverageJob?.then((c) => post({ gen, coverage: c })).catch((e) => { console.error("bake worker coverage:", e); });
    }
  } catch (err) {
    post({ gen, error: err instanceof Error ? err.message : String(err) });
    // The mesh post never happened, so the coverage post above never fires — without this the
    // probe sits in its transient "source loading…" forever, claiming a fetch is still in flight. Report
    // the failure, never the features: they are projected against THIS plan's window, while the
    // mesh still on screen is the previous pass's grid, so applying them would index the wrong
    // cells with total confidence. Keyed off the request, not off coverageJob: planTile throws
    // before the job is built, and that must still answer the probe.
    if (coverage && format === "mesh") post({ gen, coverage: { error: "bake failed before coverage could be applied" } });
  }
}

// Serialize jobs: each message fully settles before the next starts, so the cache is
// never written by two overlapping jobs. handle() swallows its own errors, so the
// chain never rejects; the trailing catch guards a post() that itself throws (log,
// don't silently drop, so a lost job is at least visible in the console).
let queue = Promise.resolve();
self.onmessage = ({ data }) => { queue = queue.then(() => handle(data)).catch((e) => { console.error("bake worker:", e); }); };
