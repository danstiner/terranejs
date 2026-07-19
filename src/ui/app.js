// Thin entry: wire the store to the Leaflet map, three.js preview, settings
// controls, and the headless pipeline. The UI holds no bake logic — it calls
// core/pipeline and renders the result.
import { createStore } from "./store.js";
import { initMap } from "./map.js";
import { initPreview } from "./preview.js";
import { wireControls } from "./controls.js";
import { planSquareTile, bakeSquareTileSolid, defaultTileName, exportSquareTile } from "../core/pipeline.js";
import { fetchMosaic } from "../core/terrain.js";

/**
 * @typedef {{
 *   center: import("../core/types.js").LatLon | null,
 *   scale: number, tileWmm: number, base: number, exag: number,
 * }} AppState
 */
/** @typedef {import("../core/types.js").Mosaic} Mosaic */
/** @typedef {import("../core/types.js").Solid} Solid */
/** @typedef {import("../core/pipeline.js").TileSettings} TileSettings */

const DEFAULT_SCALE = 250000; // 1:250 000
/** @type {import("../core/types.js").LatLon} */
const RAINIER = [46.8523, -121.7603]; // default placement: Mount Rainier summit

const store = createStore(/** @type {AppState} */ ({
  center: RAINIER, scale: DEFAULT_SCALE, tileWmm: 200, base: 6, exag: 1,
}));

/** @param {string} id @returns {HTMLElement} */
const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
};
/** @param {string} msg */
const setProgress = (msg) => { $("progress").textContent = msg; };

const map = initMap({
  center: RAINIER, zoom: 9,
  onPlace: (c) => store.set({ center: c }),
  onMove: (c) => store.set({ center: c }),
});
const preview = initPreview($("preview"));

// Cache the fetched mosaic so base/exag tweaks re-mesh only — those don't affect
// the fetch (center/scale/tileWmm do). Only the current tile's mosaic is kept.
/** @type {{ key: string, mosaic: Mosaic } | null} */
let mosaicCache = null;
let bakeGen = 0; // generation token — a superseded bake must neither display nor cache its result
/**
 * @param {TileSettings} s
 * @param {(done: number, total: number) => void} onProgress
 * @param {number} gen
 * @returns {Promise<Solid>}
 */
async function bakePreview(s, onProgress, gen) {
  const plan = planSquareTile(s);
  const key = JSON.stringify([s.center, s.scale, s.tileWmm]);
  let mosaic = mosaicCache && mosaicCache.key === key ? mosaicCache.mosaic : null;
  if (!mosaic) {
    mosaic = await fetchMosaic(plan.bbox, plan.z, { onProgress });
    if (gen === bakeGen) mosaicCache = { key, mosaic }; // don't let a superseded fetch evict a fresher entry
  }
  return bakeSquareTileSolid(mosaic, plan, s);
}

// Debounced fetch+bake → preview whenever the tile or its geom changes. A slow
// bake for an old tile must not clobber a newer one, so each run takes a
// generation token and drops its result if a newer run has since started.
let timer = 0;
async function loadPreview() {
  const s = store.get();
  if (!s.center) { preview.setTiles([]); setProgress("Click the map to place a tile."); return; }
  const gen = ++bakeGen;
  setProgress("baking preview…");
  try {
    const solid = await bakePreview({ ...s, center: s.center },
      (done, total) => { if (gen === bakeGen) setProgress(`fetching terrain… ${done}/${total} tiles`); }, gen);
    if (gen !== bakeGen) return; // superseded by a newer placement/geom change
    preview.setTiles([solid]);
    setProgress("");
  } catch (err) {
    if (gen !== bakeGen) return;
    setProgress(`preview failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

store.subscribe((s) => {
  map.setLayout(s);
  const km = (s.tileWmm * s.scale) / 1e6; // print mm × 1:N scale → real km the tile spans
  $("readout").textContent = s.center
    ? `1 square tile · ${s.tileWmm} mm : ~${km >= 10 ? Math.round(km) : km.toFixed(1)} km`
    : "No tile placed.";
  $("settings").hidden = !s.center;
  window.clearTimeout(timer);
  timer = window.setTimeout(loadPreview, 500);
});

wireControls(store);

$("export").addEventListener("click", async () => {
  const s = store.get();
  if (!s.center) return;
  const btn = /** @type {HTMLButtonElement} */ ($("export"));
  btn.disabled = true;
  window.clearTimeout(timer); // cancel a queued preview…
  bakeGen++;                  // …and void any in-flight one, so neither overwrites the export status
  const settings = { ...s, center: s.center };
  const name = defaultTileName(settings); // lat/lng/width/scale → describes the tile
  setProgress("exporting .3mf…");
  try {
    const bytes = await exportSquareTile(settings, {
      name, onProgress: (done, total) => setProgress(`exporting… ${done}/${total} tiles`),
    });
    download(new Blob([/** @type {BlobPart} */ (bytes)], { type: "model/3mf" }), `${name}.3mf`);
    setProgress(`exported ${name}.3mf`);
  } catch (err) {
    setProgress(`export failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    btn.disabled = false;
  }
});

/**
 * @param {Blob} blob
 * @param {string} name
 */
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}
