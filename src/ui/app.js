// Thin entry: wire the store to the Leaflet map, three.js preview, settings
// controls, and a bake Worker. All fetch/bake/serialize runs off-thread in the
// worker; this file only issues jobs and renders what comes back, so the main
// thread never blocks. Preview bakes coarse-then-sharp; export bakes full-res.
import { createStore } from "./store.js";
import { initMap } from "./map.js";
import { initPreview } from "./preview.js";
import { wireControls, syncControls } from "./controls.js";
import { defaultTileName, planTile } from "../core/pipeline.js";
import { encodeState, decodeState } from "../core/urlstate.js";
import { PRESETS, DEFAULT_PRESET } from "./presets.js";
import { BAND_NAMES } from "../core/colors.js";
import { LAND_BLUE_WARN_PCT } from "../core/water.js";
import { HEX_H } from "../core/layout.js";

// The app state IS the shareable state — one typedef, so a new field can't be added here and
// silently dropped from every link.
/** @typedef {import("../core/urlstate.js").ShareableState} AppState */
/** @typedef {import("../core/pipeline.js").TileSettings} TileSettings */

// Max source-tile budget per bake, one per quality tier (passed as `maxTiles`). Preview
// detail is scaled to the viewport, not the print — a small tile budget keeps the bake fast
// and the fetch light on a free tile host. See docs/specs/data-pipeline.md §2.
const FAST_MAX_TILES = 1;      // one tile → instant relief while the detailed bake runs
const CRISP_MAX_TILES = 16;    // ~4×4 tiles → one zoom deeper on wide tiles, still a light fetch
const EXPORT_MAX_TILES = 300;  // full print resolution (core's default tile budget)

// A shared link carries the full state, not a preset name: presets get retuned (a recentre, a
// scale nudge), and a name would silently repoint every old link at the new framing. An
// unreadable hash decodes to null, so a mangled link opens the default region instead of failing.
const restored = decodeState(location.hash);
const store = createStore(restored ?? /** @type {AppState} */ ({
  center: DEFAULT_PRESET.center, scale: DEFAULT_PRESET.scale, tileWmm: 200, base: 6, exag: 1,
  flatten: false, recessMm: 0, layerMm: 0.15, // sea-level tint by default; checkbox flattens
  shape: "square",
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
  start: {
    center: store.get().center ?? DEFAULT_PRESET.center,
    scale: store.get().scale,
    tileWmm: store.get().tileWmm,
    shape: store.get().shape,
  },
  onPlace: (c) => { presetSelect.value = ""; store.set({ center: c }); },
  onMove: (c) => { presetSelect.value = ""; store.set({ center: c }); },
});
const preview = initPreview($("preview"));
const workerUrl = new URL("./bake.worker.js", import.meta.url);
// python http.server sends Last-Modified but no Cache-Control/ETag, so Chrome heuristically
// caches the worker script — and the cached copy survived repeated hard reloads here, leaving
// an edited worker silently running old code (no error, just stale results). Bust it on
// loopback; deployed hosts send real cache headers, so production keeps caching it.
if (location.hostname === "localhost" || location.hostname === "127.0.0.1") workerUrl.search = `dev=${Date.now()}`;
// Annotate explicitly: without it `worker.onmessage = ({data}) => …` fails TS7031
// (the inferred Worker type doesn't flow contextual typing into the handler param).
/** @type {Worker} */
const worker = new Worker(workerUrl, { type: "module" });

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
let lastHash = ""; // last payload written, so a settled debounce doesn't replaceState redundantly

/** Put the state in the address bar. replaceState, not pushState: a map drag fires continuously
 * and each nudge as a history entry would bury the back button. (replaceState never fires
 * hashchange, so this can't re-enter the paste listener below.)
 * @param {AppState} s */
function writeHash(s) {
  const hash = encodeState(s);
  if (hash && hash !== lastHash) { lastHash = hash; history.replaceState(null, "", `#${hash}`); }
}

// gw*gh is the WINDOW's cell count, not the footprint's — a hex or circle discards part of
// that window (mask/clip), so the raw product overstates their triangle count. Scale by how
// much of its own window each footprint fills: square is exact; hex is 3/4 (a flat-top hexagon
// fills exactly 3/4 of its bounding rectangle — (3√3/8)/(√3/2), the full-square ratio divided by
// the window's own height fraction); circle is π/4 (the built 64-gon is 0.7841, within 0.2% —
// fine for an estimate line that already says "≈"). gsd below needs no such fix: it divides by
// gw alone (mesh spacing along the window's width), which every shape's window shares in full.
/** @type {Record<import("../core/types.js").Shape, number>} */
const WINDOW_FILL = { square: 1, hex: 3 / 4, circle: Math.PI / 4 };

// Resting status after the detailed preview lands: the resolution (real metres per
// grid sample) and rough triangle count of what's on screen vs what Export will
// bake at the full print budget — so the preview-vs-print gap is legible. Both are
// planned with the same pure planTile the worker uses; no fetch, no bake.
/** @param {TileSettings} settings @returns {string} */
function detailSummary(settings) {
  const fill = WINDOW_FILL[settings.shape ?? "square"];
  /** @param {number} maxTiles */
  const part = (maxTiles) => {
    const { gw, gh } = planTile(settings, { maxTiles });
    const gsd = (settings.tileWmm * settings.scale) / (1000 * gw); // real metres between mesh vertices
    const tris = (gw * gh * 2 * fill) / 1e6;                       // ≈ top-surface triangles, millions
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
  // Hide the warning too — it describes the previous mesh, which "Preview failed" just orphaned.
  if (data.error) { setProgress(`Preview failed: ${data.error}`); previewPhase = "idle"; $("waterWarn").hidden = true; return; }
  preview.setTiles([{ positions: data.positions, indices: data.indices, normals: data.normals, bands: data.bands }], data.frame);
  renderLegend(data.bands);
  // Low land below the colour line prints blue (possible only with the checkbox off — flatten
  // holds the line below all land); the warning's one remedy is the checkbox. Gate on the bake's
  // own data, not the current UI mode.
  const warn = $("waterWarn");
  if (data.landBluePct > LAND_BLUE_WARN_PCT) {
    warn.textContent = `${Math.round(data.landBluePct)}% of the land will print blue — enable "Recess all water to lowest waterline" to separate land from water.`;
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
  // tileWmm is the bounding-square side, so only the hex prints shorter than it is wide.
  const tile = s.shape === "hex"
    ? `hex tile · ${s.tileWmm} × ${Math.round(s.tileWmm * HEX_H)} mm`
    : s.shape === "circle"
      ? `circle tile · ${s.tileWmm} mm across`
      : `square tile · ${s.tileWmm} mm`;
  $("readout").textContent = s.center
    ? `1 ${tile} : ~${km >= 10 ? Math.round(km) : km.toFixed(1)} km`
    : "No tile placed.";
  $("settings").hidden = !s.center;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => { writeHash(s); loadPreview(); }, 500); // same settling point
});

// Populate the region picker from PRESETS (grouped), keeping the static Custom
// option first. Selecting a preset writes centre+scale, reflects the scale in the
// mm/km input, and flies the map; the store change drives the debounced preview.
// Display labels are explicit (not just `${group}s`) so "Park" reads "National Parks".
// National Parks first, terranes last — the everyday picks sit at the top.
const GROUP_LABELS = /** @type {const} */ ({ Terrane: "Terranes", Park: "National Parks", Water: "Coasts & Water" });
for (const key of /** @type {const} */ (["Park", "Water", "Terrane"])) {
  const group = document.createElement("optgroup");
  group.label = GROUP_LABELS[key];
  for (const p of PRESETS) if (p.group === key) group.appendChild(new Option(p.name, p.name));
  presetSelect.appendChild(group);
}
/** @param {import("./presets.js").Preset} preset */
function applyPreset(preset) {
  store.set({ center: preset.center, scale: preset.scale });
  syncScaleInput(preset.scale);
  map.focus({ center: preset.center, scale: preset.scale, tileWmm: store.get().tileWmm, shape: store.get().shape });
}
presetSelect.addEventListener("change", () => {
  const preset = PRESETS.find((p) => p.name === presetSelect.value);
  if (preset) applyPreset(preset);
});

// On-load picker + inputs. A restored link is "Custom" by name — its centre may be nowhere near
// a preset, and matching one by coordinates would mislabel a tile the user nudged off it. The
// map is already framed by initMap({ start }); the store carries its centre+scale so the
// subscribe() fire runs the first preview (no redundant store.set here).
presetSelect.value = restored ? "" : DEFAULT_PRESET.name;
syncScaleInput(store.get().scale);
syncControls(store.get()); // unconditional: app.js owns the defaults, index.html only seeds them

wireControls(store);

// Pasting a link into this tab's address bar changes only the fragment — no reload, no module
// re-run — so without this the app would ignore it and then overwrite it on the next debounce,
// destroying the link. Unlike first load, an unreadable hash here is left alone rather than
// reset to the default: the tile already on screen is the user's work, not a boot failure.
window.addEventListener("hashchange", () => {
  const h = location.hash.replace(/^#/, "");
  if (h === lastHash) return;
  const s = decodeState(h);
  if (!s) return;
  lastHash = h;
  presetSelect.value = "";
  syncControls(s);
  syncScaleInput(s.scale);
  store.set(s);
  if (s.center) map.focus({ center: s.center, scale: s.scale, tileWmm: s.tileWmm, shape: s.shape });
});

$("export").addEventListener("click", () => {
  const s = store.get();
  if (!s.center) return;
  const btn = /** @type {HTMLButtonElement} */ ($("export"));
  btn.disabled = true;
  // Settle the hash first: clearTimeout below drops the pending write, which would otherwise
  // leave the address bar describing different settings than the model being exported.
  writeHash(s);
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
