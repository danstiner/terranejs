// Thin entry: wire the store to the Leaflet map, three.js preview, settings
// controls, and a bake Worker. All fetch/bake/serialize runs off-thread in the
// worker; this file only issues jobs and renders what comes back, so the main
// thread never blocks. Preview bakes coarse-then-sharp; export bakes full-res.
import { createStore } from "./store.js";
import { initMap } from "./map.js";
import { initPreview } from "./preview.js";
import { wireControls } from "./controls.js";
import { defaultTileName, planSquareTile } from "../core/pipeline.js";
import { PRESETS, DEFAULT_PRESET } from "./presets.js";
import { BAND_NAMES } from "../core/colors.js";
import { LAND_BLUE_WARN_PCT } from "../core/water.js";

/**
 * @typedef {{
 *   center: import("../core/types.js").LatLon | null,
 *   scale: number, tileWmm: number, base: number, exag: number,
 *   mode: "auto" | "manual", recessMm: number,
 * }} AppState
 */
/** @typedef {import("../core/pipeline.js").TileSettings} TileSettings */

// Max source-tile budget per bake, one per quality tier (passed as `maxTiles`). Preview
// detail is scaled to the viewport, not the print — a small tile budget keeps the bake
// fast; export uses the full print resolution. See docs/specs/data-pipeline.md §2.
const FAST_MAX_TILES = 4;      // ~2×2 tiles → fast sub-10ms bake for user feedback
const CRISP_MAX_TILES = 36;    // ~6×6 tiles → enough detail for an unzoomed ~1500px viewport
const EXPORT_MAX_TILES = 300;  // full print resolution (core's default tile budget)

const store = createStore(/** @type {AppState} */ ({
  center: DEFAULT_PRESET.center, scale: DEFAULT_PRESET.scale, tileWmm: 200, base: 6, exag: 1,
  mode: "auto", recessMm: 2, // Auto anchors + recesses water to the tile's lowest water
}));

/** @param {string} id @returns {HTMLElement} */
const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
};
/** @param {string} msg */
const setProgress = (msg) => { $("progress").textContent = msg; };

const presetSelect = /** @type {HTMLSelectElement} */ ($("preset"));
// The store scale is exact (1:N); the mm/km input is a display, so reflect the
// preset's scale rounded. Editing the box afterwards still overrides the store.
/** @param {number} scale */
const syncScaleInput = (scale) => {
  /** @type {HTMLInputElement} */ ($("scale")).value = String(Number((1e6 / scale).toFixed(2)));
};

const map = initMap({
  start: { center: DEFAULT_PRESET.center, scale: DEFAULT_PRESET.scale, tileWmm: store.get().tileWmm },
  onPlace: (c) => { presetSelect.value = ""; store.set({ center: c }); },
  onMove: (c) => { presetSelect.value = ""; store.set({ center: c }); },
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

// Resting status after the detailed preview lands: the resolution (real metres per
// grid sample) and rough triangle count of what's on screen vs what Export will
// bake at the full print budget — so the preview-vs-print gap is legible. Both are
// planned with the same pure planSquareTile the worker uses; no fetch, no bake.
/** @param {TileSettings} settings @returns {string} */
function detailSummary(settings) {
  /** @param {number} maxTiles */
  const part = (maxTiles) => {
    const { gw, gh } = planSquareTile(settings, { maxTiles });
    const gsd = (settings.tileWmm * settings.scale) / (1000 * gw); // real metres between mesh vertices
    const tris = (gw * gh * 2) / 1e6;                              // ≈ top-surface triangles, millions
    return `${gsd >= 10 ? Math.round(gsd) : gsd.toFixed(1)} m/vertex, ~${tris.toFixed(1)}M triangles`;
  };
  try {
    return `Preview: ${part(CRISP_MAX_TILES)}  ·  Export: ${part(EXPORT_MAX_TILES)}`;
  } catch {
    return ""; // e.g. a tile past the Mercator limit — leave the line blank
  }
}

/**
 * @param {{ changes: { z: number, band: number, color: [number, number, number], elev: number, boundary: string }[],
 *           baseName: string, baseHex: string }} bands
 */
function renderLegend(bands) {
  /** @param {[number, number, number]} rgb */
  const hex = (rgb) => "#" + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0")).join("");
  /** @param {string} c @param {string} label */
  const row = (c, label) => `<li><span class="sw" style="background:${c}"></span><span>${label}</span></li>`;
  // Base filament first, then each M600 change in print order (ascending Z). Heights are
  // approximate — the legend uses the preview bake's frame, not the export's (data-pipeline.md §8).
  const rows = [row(bands.baseHex, `${bands.baseName} — base, no pause`)];
  for (const c of bands.changes)
    rows.push(row(hex(c.color), `${BAND_NAMES[c.band]} — Z ${c.z.toFixed(1)} mm (${c.boundary} · ${c.elev} m)`));
  $("bandLegend").innerHTML = `<ul class="bands">${rows.join("")}</ul>`;
}

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
  preview.setTiles([{ positions: data.positions, indices: data.indices, normals: data.normals, bands: data.bands }], data.frame);
  renderLegend(data.bands);
  // Manual can leave low land printing blue; nudge the user to Auto / more recess. Auto separates
  // by construction (landBluePct ~0), so the guard never fires there.
  const warn = $("waterWarn");
  if (store.get().mode === "manual" && data.landBluePct > LAND_BLUE_WARN_PCT) {
    warn.textContent = `${Math.round(data.landBluePct)}% of the land will print blue — switch to Auto or raise the recess to separate land from water.`;
    warn.hidden = false;
  } else {
    warn.hidden = true;
  }
  if (previewPhase === "fast") {
    previewPhase = "crisp"; // fast relief is up; refine to viewport-sharp
    setProgress("Detailed preview…");
    worker.postMessage({ gen: previewGen, settings: previewSettings, maxTiles: CRISP_MAX_TILES, format: "mesh" });
  } else {
    previewPhase = "idle";
    setProgress(previewSettings ? detailSummary(previewSettings) : "");
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
// (FAST_MAX_TILES) first for instant relief, then CRISP_MAX_TILES swaps in. Superseded runs' replies
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
  worker.postMessage({ gen: previewGen, settings: previewSettings, maxTiles: FAST_MAX_TILES, format: "mesh" });
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

// Populate the region picker from PRESETS (grouped), keeping the static Custom
// option first. Selecting a preset writes centre+scale, reflects the scale in the
// mm/km input, and flies the map; the store change drives the debounced preview.
// Display labels are explicit (not just `${group}s`) so "Park" reads "National Parks".
// National Parks first, terranes last — the everyday picks sit at the top.
const GROUP_LABELS = /** @type {const} */ ({ Terrane: "Terranes", Park: "National Parks" });
for (const key of /** @type {const} */ (["Park", "Terrane"])) {
  const group = document.createElement("optgroup");
  group.label = GROUP_LABELS[key];
  for (const p of PRESETS) if (p.group === key) group.appendChild(new Option(p.name, p.name));
  presetSelect.appendChild(group);
}
/** @param {import("./presets.js").Preset} preset */
function applyPreset(preset) {
  store.set({ center: preset.center, scale: preset.scale });
  syncScaleInput(preset.scale);
  map.focus({ center: preset.center, scale: preset.scale, tileWmm: store.get().tileWmm });
}
presetSelect.addEventListener("change", () => {
  const preset = PRESETS.find((p) => p.name === presetSelect.value);
  if (preset) applyPreset(preset);
});

// Default-on-load: reflect the default preset in the picker + scale input. The
// map is already framed by initMap({ start }); the store carries its centre+scale
// so the subscribe() fire runs the first preview (no redundant store.set here).
presetSelect.value = DEFAULT_PRESET.name;
syncScaleInput(DEFAULT_PRESET.scale);

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
  worker.postMessage({
    gen: exportGen, settings, maxTiles: EXPORT_MAX_TILES, format: "3mf", name: exportName,
    color: /** @type {HTMLInputElement} */ ($("colorExport")).checked,
  });
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
