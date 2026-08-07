// Thin entry: wire the store to the Leaflet map, three.js preview, settings
// controls, and a bake Worker. All fetch/bake/serialize runs off-thread in the
// worker; this file only issues jobs and renders what comes back, so the main
// thread never blocks. Preview bakes coarse-then-sharp; export bakes full-res.
import { createStore } from "./store.js";
import { initMap } from "./map.js";
import { initPreview } from "./preview.js";
import { wireControls, syncControls, wireHelp, cordHint } from "./controls.js";
import { defaultTileName, planTile } from "../core/pipeline.js";
import { encodeState, decodeState } from "../core/urlstate.js";
import { PRESETS, DEFAULT_PRESET } from "./presets.js";
import { BAND_NAMES } from "../core/colors.js";
import { LAND_BLUE_WARN_PCT, WATER_AS_LAND_WARN_PCT } from "../core/water.js";
import { HEX_H } from "../core/layout.js";
import { fitTile, clippedFraction, TRAIL_CLIP_WARN } from "../core/gpx.js";
import { parseGpxText } from "./gpxparse.js";

/** @typedef {{ name: string, segments: import("../core/types.js").LatLon[][] }} Trail
 *   An imported GPX: the source filename, and one polyline per track segment. */
/** @typedef {{ widthMm: number, heightMm: number }} Cord */
// The app state is the shareable state PLUS the trail (and its cord) — one typedef, so a new
// field can't be added here and silently dropped from every link. Both are the deliberate
// exception: a hash is a URL fragment and cannot carry GPX bytes, so a trail — and the cord
// dimensions that only mean something alongside one — are session-only. encodeState
// destructures named fields, so neither can leak into a link by accident.
/** @typedef {import("../core/urlstate.js").ShareableState & { trail: Trail | null, cord: Cord }} AppState */
/** @typedef {import("../core/pipeline.js").TileSettings} TileSettings */

// Max source-tile budget per bake, one per quality tier (passed as `maxTiles`). Preview
// detail is scaled to the viewport, not the print — a small tile budget keeps the bake fast
// and the fetch light on a free tile host. See data-pipeline.md "Resolution floor".
// 4 is a 2×2: a region narrower than the tile spacing touches at most two tiles per axis, so
// the budget is met wherever it sits. 1 demands missing every border — a property of position,
// not of need, with no floor under it. See data-pipeline.md "Resolution floor".
const FAST_MAX_TILES = 4;      // 2×2 → instant relief while the detailed bake runs
const CRISP_MAX_TILES = 16;    // ~4×4 tiles → one zoom deeper on wide tiles, still a light fetch
const EXPORT_MAX_TILES = 300;  // full print resolution (core's default tile budget)

// A shared link carries the full state, not a preset name: presets get retuned (a recentre, a
// scale nudge), and a name would silently repoint every old link at the new framing. An
// unreadable hash decodes to null, so a mangled link opens the default region instead of failing.
const restored = decodeState(location.hash);
const store = createStore(/** @type {AppState} */ ({
  ...(restored ?? {
    center: DEFAULT_PRESET.center, scale: DEFAULT_PRESET.scale, tileWidthMm: 200, base: 6, exag: 1,
    flatten: false, recessMm: 0, layerMm: 0.15, // sea-level tint by default; checkbox flattens
    shape: "square",
    waterInlay: false,
  }),
  trail: null, // a restored link never carries one — see the AppState note above
  cord: { widthMm: 1.6, heightMm: 0.6 }, // export-only: a hash carries no trail, so no cord either
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
    tileWidthMm: store.get().tileWidthMm,
    shape: store.get().shape,
  },
  onPlace: (c) => { presetSelect.value = ""; store.set({ center: c }); },
  onMove: (c) => { presetSelect.value = ""; store.set({ center: c }); },
  onFile: (f) => importTrail(f),
});
const preview = initPreview($("preview"));
const workerUrl = new URL("./bake.worker.js", import.meta.url);
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

// Both numbers below come off the FOOTPRINT, never the window: a clipped shape discards its
// window's corners and its window is then expanded outward past the ring (layout.cellWindows),
// so gw/gh overstate on both counts. spanPx — the tile's own width in cells — is the honest
// denominator, and the footprint covers this fraction of the spanPx square it inscribes.
// Circle is the limit its inscribed n-gon approaches: 2.5% under at the coarsest n = 16,
// inside the "≈" this line already carries.
/** @type {Record<import("../core/types.js").Shape, number>} */
const AREA_FRAC = { square: 1, hex: (3 * Math.sqrt(3)) / 8, circle: Math.PI / 4 };

// Resting status after the detailed preview lands: the resolution (real metres per
// grid sample) and rough triangle count of what's on screen vs what Export will
// bake at the full print budget — so the preview-vs-print gap is legible. Both are
// planned with the same pure planTile the worker uses; no fetch, no bake.
/** @param {TileSettings} settings @returns {string} */
function detailSummary(settings) {
  const frac = AREA_FRAC[settings.shape ?? "square"];
  /** @param {number} maxTiles */
  const part = (maxTiles) => {
    const { dx } = planTile(settings, { maxTiles });
    const spanPx = settings.tileWidthMm / dx;              // the tile's own width in cells
    const gsd = (dx * settings.scale) / 1000;              // real metres between mesh vertices
    const tris = (2 * frac * spanPx * spanPx) / 1e6;       // ≈ top-surface triangles, millions
    return { dx, text: `${gsd >= 10 ? Math.round(gsd) : gsd.toFixed(1)} m/vertex, ~${tris.toFixed(1)}M triangles` };
  };
  try {
    const crisp = part(CRISP_MAX_TILES), exportPart = part(EXPORT_MAX_TILES);
    return `Preview: ${crisp.text}  ·  Export: ${exportPart.text}`;
  } catch {
    return ""; // e.g. a tile past the Mercator limit — no plan, so leave the line blank
  }
}

// The mask and the color line can disagree in both directions, and both disagreements have the
// same one-click remedy — so they compose into one sentence rather than two banners. Land below
// the line prints blue (polders); masked water above it shows as terrain (a high lake, or noisy
// near-0 bathymetry fragmenting a bay). Says "show", not "print": the exported M600 pause sits a
// layer above the line, so water within one layer of it still prints blue — tens of metres of
// elevation at map scale. Percentages are differently based on purpose — see WATER_AS_LAND_WARN_PCT.
// The quoted label must match index.html: the sentence is only actionable if it names the control.
/** @param {{ landBluePct: number, waterAsLandPct: number }} data */
function updateWaterWarning(data) {
  const clauses = [];
  if (data.landBluePct > LAND_BLUE_WARN_PCT) clauses.push(`${Math.round(data.landBluePct)}% of the land will print blue`);
  // One decimal: rounding a firing 1.4% to "1%" would quote the threshold at which it stays silent.
  if (data.waterAsLandPct > WATER_AS_LAND_WARN_PCT) clauses.push(`water covering ${data.waterAsLandPct.toFixed(1)}% of the tile will show as land`);
  const warn = $("waterWarn");
  warn.hidden = clauses.length === 0;
  if (clauses.length) {
    warn.textContent = `${clauses.join(" and ")} — tick "Flatten all water to one level" to separate land from water.`;
  }
}

// The tile only prints what its footprint encloses, so a trail running past the
// rim is silently cut. Follows the water banner's pattern: say what happens to
// the print, as a percentage, and NAME the control that fixes it. The quoted
// label must match index.html — the sentence is only actionable if it names the
// button. Reports "<1%" rather than rounding to "0%": a warning quoting zero
// reads as a bug.
/** @param {AppState} s */
function updateTrailWarning(s) {
  const warn = $("trailWarn");
  if (!s.trail || !s.center) { warn.hidden = true; return; }
  const f = clippedFraction(s.trail.segments,
    { center: s.center, scale: s.scale, tileWidthMm: s.tileWidthMm, shape: s.shape });
  warn.hidden = f <= TRAIL_CLIP_WARN;
  if (!warn.hidden) {
    warn.textContent =
      `${f < 0.01 ? "<1%" : `${Math.round(f * 100)}%`} of the trail falls outside ` +
      `the tile — press "Fit to trail" to frame it.`;
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
  // approximate — the legend uses the preview bake's frame, not the export's (data-pipeline.md "Color bands").
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
    if (data.error) {
      // A cord the grid can't carry is a trail fact, not a bake fact — the DETAIL belongs on the
      // banner PR1 built for trail messages, not the status line a pending preview overwrites
      // within 500 ms. But the status line still has to leave "Export — baking…", or the UI
      // reads as still running while the banner says it failed — so it gets a short pointer
      // instead of the raw pipeline error, which would only duplicate the banner's sentence.
      if (/^corridor:/.test(data.error)) {
        warnTrail(`Could not export the trail: ${data.error.replace(/^corridor: /, "")}`);
        setProgress("Export failed — see the trail warning above.");
      } else {
        setProgress(`Export failed: ${data.error}`);
      }
      btn.disabled = false; exportGen = -1; resyncAfterExport(); return;
    }
    download(new Blob([/** @type {BlobPart} */ (data.bytes)], { type: "model/3mf" }), `${exportName}.3mf`);
    setProgress(`Exported ${exportName}.3mf`);
    btn.disabled = false;
    exportGen = -1;
    resyncAfterExport();
    return;
  }
  if (data.gen !== previewGen) return; // superseded preview — drop
  // Provenance rides its own message, arriving after the mesh it belongs to. The gen check above
  // already keeps a stale bake's coverage from landing against a newer one's mesh.
  if (data.coverage) { preview.setCoverage(data.coverage); return; }
  const mode = previewPhase === "fast" ? "Quick preview" : "Detailed preview";
  if (data.progress) { setProgress(`${mode} — fetching terrain ${data.progress.done}/${data.progress.total}`); return; }
  if (data.baking) { setProgress(`${mode} — baking…`); return; }
  // Hide the warning too — it describes the previous mesh, which "Preview failed" just orphaned.
  if (data.error) { setProgress(`Preview failed: ${data.error}`); previewPhase = "idle"; $("waterWarn").hidden = true; return; }
  preview.setTiles([{ positions: data.positions, indices: data.indices, normals: data.normals, bands: data.bands }], data.frame);
  renderLegend(data.bands);
  if (previewPhase === "fast") {
    previewPhase = "crisp"; // fast relief is up; refine to viewport-sharp
    setProgress("Detailed preview…");
    worker.postMessage({ gen: previewGen, settings: previewSettings, maxTiles: CRISP_MAX_TILES, format: "mesh", coverage: true });
  } else {
    // Crisp pass only. The one-tile fast bake resolves the shoreline too coarsely to judge a
    // 1%-of-tile threshold, and letting it drive the banner makes it flash and vanish a second
    // later; the previous banner stays up until the sharp numbers land.
    updateWaterWarning(data);
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

// Last trail rendered on the map. `trail` only ever changes reference on import or
// clear (store.set spreads state), so diffing by reference — not by content — skips
// the Leaflet teardown/rebuild on every other store change, including the 30-60/s
// stream an `input` slider drag fires.
/** @type {Trail | null} */
let shownTrail = null;

// Snapshot of the last state a bake was scheduled for, so an edit touching ONLY `cord` can skip
// scheduling one. `cord` cannot change what bakeTile bakes — the worker's preview job never
// reads it — so rescheduling for it costs a debounced fetch + decode + mesh at two tiers and a
// "Quick preview…" flash for a spinner click that changes nothing on screen (PR2b's ribbon
// sweep is what would consume it, and isn't wired up yet). A denylist, not an allowlist: any
// OTHER field added to AppState later defaults to bake-relevant, which is the safe direction to
// be wrong in.
//
// `waterInlay` stays on that safe side deliberately, even though the preview ignores it too
// (bake.worker.js forces it off for a mesh job). Unlike `cord` it IS shareable state, and the
// hash write rides this same timer — exempting it would stop the address bar tracking the
// checkbox. The cost is one preview rebake per toggle: a checkbox clicked once before an
// export, not a slider dragged, and Export cancels a pending preview anyway.
/** @type {AppState | null} */
let lastBakeState = null;
/** @param {AppState} s @returns {boolean} */
function bakeInputsChanged(s) {
  if (!lastBakeState) return true;
  for (const k of /** @type {(keyof AppState)[]} */ (Object.keys(s))) {
    if (k !== "cord" && s[k] !== lastBakeState[k]) return true;
  }
  return false;
}

store.subscribe((s) => {
  map.setLayout(s);
  if (s.trail !== shownTrail) {
    shownTrail = s.trail;
    map.setTrail(s.trail ? s.trail.segments : []);
    $("trailRow").hidden = !s.trail;
    $("trailCord").hidden = !s.trail;
    $("trailName").textContent = s.trail ? s.trail.name : "";
  }
  // Outside the guard above: this depends on center, scale, shape and width too, all
  // of which change without the trail changing. subscribe runs synchronously on every
  // set, so the budget is a frame, not the bake debounce: 0.8 ms for the largest real
  // trail measured (15.7k points), 4.4 ms at 100k.
  updateTrailWarning(s);
  // Unconditional, unlike the guard above: both height and layerMm change without the trail
  // changing. No width clause any more — the cord's width no longer depends on the tile's grid,
  // so there is no tile-derived minimum to warn about before the click.
  $("cordHint").textContent = cordHint(s.cord.heightMm, s.layerMm);
  // The inlays are the volume the two water controls displaced, so with neither on there is no
  // volume and the export silently gains nothing. Say so at the checkbox rather than let the
  // user find a .3mf with one object in it.
  //
  // This covers the settings only. A tile with no water at all also exports nothing and says
  // nothing here — whether the tile HAS water is a bake result, and the preview never bakes
  // inlays. The recess slider visibly doing nothing is the feedback there.
  const idle = s.waterInlay && !s.flatten && s.recessMm === 0;
  $("inlayHint").hidden = !idle;
  if (idle) $("inlayHint").textContent = "No water is displaced yet — set a recess depth or flatten, or the export adds nothing.";
  const km = (s.tileWidthMm * s.scale) / 1e6; // print mm × 1:N scale → real km the tile spans
  // tileWidthMm is the bounding-square side, so only the hex prints shorter than it is wide.
  const tile = s.shape === "hex"
    ? `hex tile · ${s.tileWidthMm} × ${Math.round(s.tileWidthMm * HEX_H)} mm`
    : s.shape === "circle"
      ? `circle tile · ${s.tileWidthMm} mm across`
      : `square tile · ${s.tileWidthMm} mm`;
  $("readout").textContent = s.center
    ? `1 ${tile} : ~${km >= 10 ? Math.round(km) : km.toFixed(1)} km`
    : "No tile placed.";
  $("settings").hidden = !s.center;
  // A cord-only edit leaves any already-pending bake's timer running untouched, rather than
  // pushing it back — see bakeInputsChanged above.
  if (bakeInputsChanged(s)) {
    lastBakeState = s;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => { writeHash(s); loadPreview(); }, 500); // same settling point
  }
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
  map.focus({ center: preset.center, scale: preset.scale, tileWidthMm: store.get().tileWidthMm, shape: store.get().shape });
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
// cord isn't ShareableState (see the AppState note above), so syncControls can't carry it — same
// reconciliation as every other control, just done here instead of there.
/** @type {HTMLInputElement} */ ($("cordW")).value = String(store.get().cord.widthMm);
/** @type {HTMLInputElement} */ ($("cordH")).value = String(store.get().cord.heightMm);

wireControls(store);
wireHelp();

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
  // The hash can't carry a trail, so a pasted link describes a framing that any trail
  // already loaded has no relationship to — drop it rather than leave it draped over
  // whatever region the link just opened.
  store.set({ ...s, trail: null });
  if (s.center) map.focus({ center: s.center, scale: s.scale, tileWidthMm: s.tileWidthMm, shape: s.shape });
});

// View mode is a way of LOOKING at the bake, not a property of the tile, so it stays out of
// the store: a viewing preference in the shareable state would make every link mean "this
// tile, seen this way".
for (const b of $("viewmodes").querySelectorAll("button")) {
  b.addEventListener("click", () => {
    for (const o of $("viewmodes").querySelectorAll("button")) o.classList.toggle("on", o === b);
    preview.setViewMode(Number(b.dataset.mode));
  });
}

// --- GPX trail ---------------------------------------------------------------

// Frame the tile on a trail and reflect it everywhere the user can see the scale.
// Shared by import and the Fit button so the two can't drift.
/** @param {import("../core/types.js").LatLon[][]} segments */
function fitToTrail(segments) {
  const s = store.get();
  const { center, scale } = fitTile(segments, { tileWidthMm: s.tileWidthMm, shape: s.shape });
  presetSelect.value = ""; // a fitted framing is nobody's preset
  syncScaleInput(scale);
  map.focus({ center, scale, tileWidthMm: s.tileWidthMm, shape: s.shape });
  return { center, scale };
}

// Import errors go to #trailWarn, not the status line: a pending bake debounce or an
// in-flight preview overwrites setProgress within 500 ms, so it cannot hold a message
// the user has to read.
//
// Two writers share this banner — updateTrailWarning asserts the standing "N% clipped"
// fact off the store. Precedence is by recency: the catch below does not re-run
// updateTrailWarning, so a failed import holds the banner until the next store change
// restores whichever fact is then true. Losing a clip warning for one interaction beats
// losing the reason an import just failed.
/** @param {string} msg */
const warnTrail = (msg) => {
  const w = $("trailWarn");
  w.textContent = msg;
  w.hidden = false;
};

// Parse and fit BEFORE touching the store: a rejected import must leave the app
// exactly as it was, and fitTile is where most rejections come from.
//
// One catch, because parseGpxText and fitTile both reject by throwing and both phrase
// the message to complete the prefix below. A second shape — an empty return meaning
// "no track points" — used to bypass it and print a differently-worded sentence.
/** @param {File} file */
async function importTrail(file) {
  $("trailWarn").hidden = true; // clear a stale error before a new attempt can raise its own
  try {
    const segments = parseGpxText(await file.text());
    // #autoFit is a quick DOM-only preference, not AppState/ShareableState — it never reaches
    // the hash, so a shared link can't carry "don't fit" and surprise whoever opens it.
    const autoFit = /** @type {HTMLInputElement} */ ($("autoFit")).checked;
    const { center, scale } = autoFit ? fitToTrail(segments) : store.get();
    store.set({ trail: { name: file.name, segments }, center, scale });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    warnTrail(`Could not import ${file.name}: ${why}`);
  }
}

const gpxFile = /** @type {HTMLInputElement} */ ($("gpxFile"));
$("gpxImport").addEventListener("click", () => gpxFile.click());
gpxFile.addEventListener("change", () => {
  const file = gpxFile.files?.[0];
  gpxFile.value = ""; // else re-picking the same filename fires no change event at all
  if (file) importTrail(file);
});

// Fit runs automatically on import only. Changing shape or width afterwards does NOT
// silently re-fit — that would fight framing the user set by hand — so this button is
// the way back. Unguarded: fitTile rejects on the trail's coordinates alone, and those
// already passed at import; shape and width cannot make it throw.
$("trailFit").addEventListener("click", () => {
  const { trail } = store.get();
  if (trail) store.set(fitToTrail(trail.segments));
});

// Clearing leaves center and scale alone: the framing is the user's tile now, and
// resetting it would discard work the trail merely seeded.
$("trailClear").addEventListener("click", () => store.set({ trail: null }));

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
  // `trail` rides its own field below (the worker reads only that one), so it's destructured
  // out here rather than posted twice inside `settings` too.
  const { trail, ...settings } = { ...s, center: s.center };
  exportGen = ++gen;
  exportName = defaultTileName(settings); // lat/lng/width/scale → describes the tile
  setProgress("Export…");
  worker.postMessage({
    gen: exportGen, settings, maxTiles: EXPORT_MAX_TILES, format: "3mf", name: exportName,
    color: /** @type {HTMLInputElement} */ ($("colorExport")).checked,
    trail: trail ? { segments: trail.segments, ...s.cord } : null,
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
