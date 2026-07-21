// Thin entry: wire the store to the Leaflet map, three.js preview, settings
// controls, and a bake Worker. All fetch/bake/serialize runs off-thread in the
// worker; this file only issues jobs and renders what comes back, so the main
// thread never blocks. Preview bakes coarse-then-sharp; export bakes full-res.
import { createStore } from "./store.js";
import { initMap } from "./map.js";
import { initPreview } from "./preview.js";
import { wireControls } from "./controls.js";
import { defaultTileName } from "../core/pipeline.js";

/**
 * @typedef {{
 *   center: import("../core/types.js").LatLon | null,
 *   scale: number, tileWmm: number, base: number, exag: number,
 * }} AppState
 */
/** @typedef {import("../core/pipeline.js").TileSettings} TileSettings */

const DEFAULT_SCALE = 250000; // 1:250 000
/** @type {import("../core/types.js").LatLon} */
const RAINIER = [46.8523, -121.7603]; // default placement: Mount Rainier summit

// Preview detail is matched to the viewport, not the print: a ~1536px grid is
// already pixel-dense on screen, and a small tile budget keeps the bake fast.
// Export uses the full print resolution. See docs/specs/data-pipeline.md §2.
const FAST = 4;     // ~2×2 tiles → ~512px grid → sub-10ms bake (instant relief)
const CRISP = 64;   // ~8×8 tiles → ~2048px grid → viewport-sharp on zoom; fetch-bound, so kept modest
const EXPORT = 300; // full print resolution (core's default tile budget)

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
// Annotate explicitly: without it `worker.onmessage = ({data}) => …` fails TS7031
// (the inferred Worker type doesn't flow contextual typing into the handler param).
/** @type {Worker} */
const worker = new Worker(new URL("./bake.worker.js", import.meta.url), { type: "module" });

// Job identity. `gen` allocates a monotonic id per job; `previewGen`/`exportGen`
// track the live job on each channel so a reply is matched to it and stale replies
// dropped. Two channels, not one shared counter, so a preview placed during an
// export can't cancel the export — each is matched by its own saved id.
let gen = 0;
let previewGen = 0;
let exportGen = -1; // -1 = no export in flight
let previewPhase = /** @type {"idle" | "fast" | "crisp"} */ ("idle");
/** @type {TileSettings | null} */
let previewSettings = null;
let exportName = "";
let previewDeferred = false; // a preview requested during an export; run once the export finishes

worker.onmessage = ({ data }) => {
  if (data.gen === exportGen) { // export channel
    const btn = /** @type {HTMLButtonElement} */ ($("export"));
    if (data.progress) { setProgress(`Export — fetching terrain ${data.progress.done}/${data.progress.total}`); return; }
    if (data.baking) { setProgress("Export — baking…"); return; }
    if (data.error) { setProgress(`Export failed: ${data.error}`); btn.disabled = false; exportGen = -1; resyncAfterExport(); return; }
    download(new Blob([/** @type {BlobPart} */ (data.bytes)], { type: "model/3mf" }), `${exportName}.3mf`);
    setProgress(`Exported ${exportName}.3mf`);
    btn.disabled = false;
    exportGen = -1;
    resyncAfterExport();
    return;
  }
  if (data.gen !== previewGen) return; // superseded preview — drop
  const mode = previewPhase === "fast" ? "Quick preview" : "Detailed preview";
  if (data.progress) { setProgress(`${mode} — fetching terrain ${data.progress.done}/${data.progress.total}`); return; }
  if (data.baking) { setProgress(`${mode} — baking…`); return; }
  if (data.error) { setProgress(`Preview failed: ${data.error}`); previewPhase = "idle"; return; }
  preview.setTiles([{ positions: data.positions, indices: data.indices, normals: data.normals }]);
  if (previewPhase === "fast") {
    previewPhase = "crisp"; // fast relief is up; refine to viewport-sharp
    setProgress("Detailed preview…");
    worker.postMessage({ gen: previewGen, settings: previewSettings, maxTiles: CRISP, format: "mesh" });
  } else {
    previewPhase = "idle";
    setProgress("");
  }
};

// A worker-level failure (module load, uncaught throw) never yields a message, so
// recover state here or the UI wedges — export button stuck disabled, status stuck.
worker.onerror = (e) => {
  setProgress(`Bake worker error: ${e.message || "failed to load"}`);
  previewPhase = "idle";
  if (exportGen !== -1) { /** @type {HTMLButtonElement} */ ($("export")).disabled = false; exportGen = -1; }
};

// Debounced fetch+bake → preview whenever the tile or its geom changes. Coarse
// (FAST) first for instant relief, then CRISP swaps in. Superseded runs' replies
// are dropped by generation, so a slow bake for an old tile never clobbers a newer.
let timer = 0;
// A preview started mid-export would clobber the export's status line and just
// queue behind it; defer it and run once the export finishes instead.
function resyncAfterExport() {
  if (previewDeferred) { previewDeferred = false; loadPreview(); }
}
function loadPreview() {
  if (exportGen !== -1) { previewDeferred = true; return; }
  const s = store.get();
  if (!s.center) { preview.setTiles([]); setProgress("Click the map to place a tile."); return; }
  previewSettings = { ...s, center: s.center };
  previewGen = ++gen;
  previewPhase = "fast";
  setProgress("Quick preview…");
  worker.postMessage({ gen: previewGen, settings: previewSettings, maxTiles: FAST, format: "mesh" });
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

$("export").addEventListener("click", () => {
  const s = store.get();
  if (!s.center) return;
  const btn = /** @type {HTMLButtonElement} */ ($("export"));
  btn.disabled = true;
  window.clearTimeout(timer); // cancel a queued preview…
  previewGen = 0;             // …and void any in-flight one, so its trailing reply can't clobber the export status
  const settings = { ...s, center: s.center };
  exportGen = ++gen;
  exportName = defaultTileName(settings); // lat/lng/width/scale → describes the tile
  setProgress("Export…");
  worker.postMessage({ gen: exportGen, settings, maxTiles: EXPORT, format: "3mf", name: exportName });
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
