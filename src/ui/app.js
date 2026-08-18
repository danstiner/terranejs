// Thin entry: wire the store to the Leaflet map, three.js preview, settings
// controls, and a bake Worker. All fetch/bake/serialize runs off-thread in the
// worker; this file only issues jobs and renders what comes back, so the main
// thread never blocks. Preview bakes coarse-then-sharp; export bakes full-res.
import { createStore } from "./store.js";
import { initMap } from "./map.js";
import { initPreview } from "./preview.js";
import { wireControls, syncControls, wireHelp, cordHint, trenchHint } from "./controls.js";
import { defaultTileName, planTile } from "../core/pipeline.js";
import { encodeState, decodeState } from "../core/urlstate.js";
import { PRESETS, DEFAULT_PRESET } from "./presets.js";
import { BAND_NAMES } from "../core/colors.js";
import { WATER_AS_LAND_WARN_PCT, WATER_DROPPED_WARN_PCT } from "../core/water.js";
import { HEX_H } from "../core/layout.js";
import { fitTile, clippedFraction, TRAIL_CLIP_WARN } from "../core/framing.js";
import { parseGpxText } from "./gpxparse.js";

/** @typedef {{ name: string, segments: import("../core/types.js").LatLon[][] }} Trail
 *   An imported GPX: the source filename, and one polyline per track segment. */
/** @typedef {{ widthMm: number, heightMm: number, trenchDepthMm: number }} Cord */
// The app state is the shareable state PLUS the trail (and its cord) — one typedef, so a new
// field can't be added here and silently dropped from every link. Both are the deliberate
// exception: a hash is a URL fragment and cannot carry GPX bytes, so a trail — and the cord
// dimensions that only mean something alongside one — are session-only. encodeState
// destructures named fields, so neither can leak into a link by accident.
/** @typedef {import("../core/urlstate.js").ShareableState & { trail: Trail | null, cord: Cord }} AppState */
/** @typedef {import("../core/pipeline.js").TileSettings} TileSettings */

// Max source-tile budget per bake, one per quality tier (passed as `maxTiles`). Preview detail
// is scaled to the viewport, not the print — a small budget keeps the bake fast and the fetch
// light on a free tile host. 4 is a 2×2: a region narrower than the tile spacing touches at most
// two tiles per axis, so the budget is met wherever it sits; 1 demands missing every border, a
// property of position rather than of need. See data-pipeline.md "Resolution floor".
const FAST_MAX_TILES = 4;      // 2×2 → instant relief while the detailed bake runs
const CRISP_MAX_TILES = 16;    // ~4×4 tiles → one zoom deeper on wide tiles, still a light fetch
const EXPORT_MAX_TILES = 300;  // full print resolution (core's default tile budget)

// Each tier gets its own timer, both restarted by every change.
const QUICK_MS = 100;   // relief while the user is still moving
const SETTLE_MS = 2000; // they stopped — the only moment worth spending a sharp bake on

// A shared link carries the full state, not a preset name: presets get retuned (a recenter, a
// scale nudge), and a name would silently repoint every old link at the new framing. An
// unreadable hash decodes to null, so a mangled link opens the default region instead of failing.
const restored = decodeState(location.hash);
const store = createStore(/** @type {AppState} */ ({
  ...(restored ?? {
    center: DEFAULT_PRESET.center, scale: DEFAULT_PRESET.scale, tileWidthMm: 200, base: 6, exag: 1,
    waterMode: /** @type {const} */ ("none"), recessMm: 1, layerMm: 0.15, // sea-level tint by default
    shape: "square",
  }),
  trail: null, // a restored link never carries one — see the AppState note above
  cord: { widthMm: 1, heightMm: 1, trenchDepthMm: 0 }, // session-only: a hash carries no trail, so no cord either
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
// "pending" = quick mesh on screen, sharp pass owed but not posted. Nothing that describes the
// crisp bake (water banner, detailSummary) may show while there.
let previewPhase = /** @type {"idle" | "fast" | "pending" | "crisp"} */ ("idle");
/** @type {TileSettings | null} */
let previewSettings = null;
/** The trail the live preview is being baked for, snapshotted with its settings: the crisp pass is
 * posted from the reply handler, long after the store may have moved on.
 * @type {{ segments: import("../core/types.js").LatLon[][], widthMm: number, heightMm: number,
 *   trenchDepthMm: number } | null} */
let previewTrail = null;
let exportName = "";
let previewDeferred = false; // a preview requested during an export; run once the export finishes
// The address bar as this tab last saw it — our write, or the user's. Seeded from the bar so
// writeHash's guard doesn't read a restored link as somebody else's edit.
let lastHash = location.hash.replace(/^#/, "");

/** Put the state in the address bar. replaceState, not pushState: a map drag fires continuously
 * and each nudge as a history entry would bury the back button. (replaceState never fires
 * hashchange, so this can't re-enter the paste listener below.)
 * @param {AppState} s */
function writeHash(s) {
  const hash = encodeState(s);
  if (!hash || hash === lastHash) return;
  // Anything else in the bar is the user's — a paste, whose hashchange is queued behind this.
  // Overwriting loses it silently: that handler would then see `h === lastHash` and bail.
  if (location.hash.replace(/^#/, "") !== lastHash) return;
  lastHash = hash;
  history.replaceState(null, "", `#${hash}`);
}

// Both numbers below come off the FOOTPRINT, never the window: a clipped shape discards its
// window's corners and its window is then expanded outward past the ring (layout.cellWindows),
// so gw/gh overstate on both counts. spanPx — the tile's own width in cells — is the honest
// denominator, and the footprint covers this fraction of the spanPx square it inscribes.
// Circle is the limit its inscribed n-gon approaches: 2.5% under at the coarsest n = 16,
// inside the "≈" this line already carries.
/** @type {Record<import("../core/types.js").Shape, number>} */
const AREA_FRAC = { square: 1, hex: (3 * Math.sqrt(3)) / 8, circle: Math.PI / 4 };

// Resting status after the detailed preview lands: the resolution (real meters per
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
    const gsd = (dx * settings.scale) / 1000;              // real meters between mesh vertices
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

// One banner, independent sentences. Masked water above the color line shows as terrain (a high
// lake, noisy near-0 bathymetry fragmenting a bay, or the whole sea on a polder tile whose line
// dropped below its land), and the sentence names the Lake inserts card — the remedy that fixes
// every one of those. The count is against the height the print changes color at rather than the
// line — the M600 pause sits a layer above it, tens of meters of elevation at map scale — so
// water that reads above the line but still prints blue is not named here. Land printing blue has
// no sentence because it cannot happen: waterColorLine never lets the line sit above land.
// The quoted label must match index.html: the sentence is only actionable if it names the control.
/** @param {{ landBluePct: number, waterAsLandPct: number, waterDroppedPct: number,
 *   lineElev: number, waterRecessedPct: number, waterMode: string, recessMm: number }} data */
function updateWaterWarning(data) {
  const sentences = [];
  // No land-blue clause any more: the line never sits above land (waterColorLine lowers it
  // below polders instead), so land printing blue cannot happen — the polder tile's fact is now
  // "the sea shows as land", which is the water clause below, and its named remedy genuinely
  // works there: the lowered ceiling makes "Lake inserts" groove and insert the sea itself.
  // One decimal: rounding a firing 1.4% to "1%" would quote the threshold at which it stays silent.
  if (data.waterAsLandPct > WATER_AS_LAND_WARN_PCT)
    sentences.push(`Water covering ${data.waterAsLandPct.toFixed(1)}% of the tile will show as land — choose "Lake inserts" to print it blue.`);
  // Its own sentence, like the two above: flattening never reached it and neither do the inserts.
  // A dropped body is out of the mask, so flattening does nothing to it; only a tighter scale prints it wide enough.
  if (data.waterDroppedPct > WATER_DROPPED_WARN_PCT) {
    sentences.push(`${data.waterDroppedPct.toFixed(1)}% of this tile's water is too narrow to print and stays at terrain level — raise "Scale" to print it wider.`);
  }
  // Its own sentence for the same reason as the dropped-water one: the remedy above cannot reach
  // it. Every body already prints blue, so there is nothing for a groove to improve — the mode is
  // simply not the one this tile needs. Gated on the tile HAVING water: lineElev is −Infinity on a
  // dry tile, where "no water sits above the waterline" would be true and useless.
  if (data.waterMode === "lakes" && data.recessMm > 0 && data.lineElev !== -Infinity &&
      data.waterRecessedPct === 0) {
    sentences.push('No water on this tile sits above the waterline, so "Lake inserts" grooves nothing — every body already prints blue.');
  }
  // Mirror case, and the one users actually hit on a real coastal tile: every body grooved, an
  // inlay covering most of the tile. waterAsLandPct is silent here by design (the recess moved
  // everything and the parts fill it; with inlays off the warning itself now speaks), so this is
  // the only place that says so.
  if (data.waterMode === "lakes" && data.recessMm > 0 && data.lineElev !== -Infinity &&
      data.waterRecessedPct === 100) {
    sentences.push('Every body of water on this tile sits above the waterline, so "Lake inserts" grooves all of it — the same as "Lake & sea inserts".');
  }
  const warn = $("waterWarn");
  warn.hidden = sentences.length === 0;
  if (sentences.length) warn.textContent = sentences.join(" ");
}

// The tile only prints what its footprint encloses, so a trail running past the
// rim is silently cut. Follows the water banner's pattern: say what happens to
// the print, as a percentage, and NAME the control that fixes it. The quoted
// label must match index.html — the sentence is only actionable if it names the
// button. Reports "<1%" rather than rounding to "0%": a warning quoting zero
// reads as a bug.
//
// Why the cord could not be drawn — or, when an export refused it, could not be printed either.
// Held here rather than written straight to the banner because updateTrailWarning rewrites it on
// every store change, and a message posted once would vanish on the next slider tick.
let cordWarning = "";

// The export's own refusal, kept apart from cordWarning because the two have different lifetimes.
// A preview reply must not clear this: the two bake at different pitches and subK's refusal is
// pitch-dependent in BOTH directions, so a preview that meshes the cord proves nothing about the
// export that just refused it — and letting it through replaces a true report of a failed export
// with "it will still export at full size", which that export disproved.
//
// It carries the whole state it was refused for instead of a clear-here list, so it
// self-invalidates the moment the user acts on ANY remedy it names. Not `cord` alone: the base-cut
// refusal names the base and the exaggeration, and subK's is pitch-dependent, so the scale and the
// tile width unstick it too — all of them bake inputs, none of them `cord`.
/** @type {{ msg: string, at: AppState } | null} */
let exportRefusal = null;
/** @param {AppState} s */
function updateTrailWarning(s) {
  const warn = $("trailWarn");
  if (!s.trail || !s.center) { warn.hidden = true; return; }
  // Export refusal first: it is the only one of the three that reports something already tried
  // and failed, and it contradicts what the preview would otherwise claim.
  if (exportRefusal && sameBakeInputs(s, exportRefusal.at)) {
    warn.hidden = false; warn.textContent = exportRefusal.msg; return;
  }
  // Then ahead of the clip fraction: a trail that cannot be drawn at all outranks one running past
  // the rim, and the sentence already names its own remedy.
  if (cordWarning) { warn.hidden = false; warn.textContent = cordWarning; return; }
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
        // Held in exportRefusal, not written straight to the banner: the next store change re-runs
        // updateTrailWarning, which would restore the preview's "it will still export at full
        // size" — the very claim this refusal just disproved — and the store change most likely to
        // follow is the user acting on the remedy.
        exportRefusal = { msg: `Could not export the trail: ${data.error.replace(/^corridor: /, "")}`,
          at: store.get() };
        warnTrail(exportRefusal.msg);
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
  // pump() so a change made during the failed bake isn't left waiting for the next one.
  if (data.error) {
    previewPhase = "idle"; $("waterWarn").hidden = true;
    // Same reason waterWarn is hidden: it describes the mesh this failure just orphaned. Left set,
    // the next store change reinstates "it will still export at full size" over a refusal that
    // disproved it.
    cordWarning = "";
    // Split exactly as the export branch above, and for the same reasons: `corridor: ` is a routing
    // token (trench.js), not part of the sentence, and the remainder is a trail fact that belongs
    // on the banner every other trail problem uses — not on a status line the next preview
    // overwrites. It also has to say what is on screen, because the tile still standing there is
    // the last one that baked: without that clause a REFUSED inset reads as one that did nothing.
    if (/^corridor:/.test(data.error)) {
      warnTrail(`Could not draw the trail: ${data.error.replace(/^corridor: /, "")}. `
        + "The tile on screen is the last one that baked.");
      setProgress("Preview failed — see the trail warning above.");
    } else {
      setProgress(`Preview failed: ${data.error}`);
    }
    pump();
    return;
  }
  // Both tiers report it: they bake at different pitches, so a cord the coarse pass refuses can
  // still be drawn by the sharp one, and the banner follows whichever mesh is on screen rather
  // than latching. The width is the snapshot the refused bake was issued for, not the live store,
  // which a later spinner click may already have moved past.
  // The rescue rebakes with no trail AT ALL, so with an inset set the channel is missing from the
  // preview too — and a sentence naming only the cord would have the user hunting for a groove
  // that was never meshed.
  cordWarning = data.cordDropped && previewTrail
    ? `The ${previewTrail.widthMm.toFixed(2)} mm trail is too fine to draw at preview resolution — `
      + (previewTrail.trenchDepthMm > 0
        ? "neither it nor its channel is shown, but both still export at full size."
        : "it will still export at full size.")
    : "";
  updateTrailWarning(store.get());
  preview.setTiles([{ positions: data.positions, indices: data.indices, normals: data.normals, bands: data.bands }], data.frame, data.cord, data.parts);
  renderLegend(data.bands);
  if (previewPhase === "fast") {
    previewPhase = "pending"; // relief is up; the sharp pass waits for the settle timer
    // Not detailSummary: those numbers are the crisp mesh's, and the coarse one is on screen.
    setProgress("Quick preview…");
  } else {
    // Crisp pass only. The one-tile fast bake resolves the shoreline too coarsely to judge a
    // 1%-of-tile threshold, and letting it drive the banner makes it flash and vanish a second
    // later; the previous banner stays up until the sharp numbers land.
    // previewSettings, not the live store: this reply is matched by gen to the bake it snapshots,
    // and the store may already have moved on to a mode this data was never baked for.
    if (previewSettings) {
      updateWaterWarning({ ...data, waterMode: previewSettings.waterMode, recessMm: previewSettings.recessMm });
    }
    previewPhase = "idle";
    setProgress(previewSettings ? detailSummary(previewSettings) : "");
  }
  pump(); // the worker is free — hand it whatever came due while it was busy
};

// A worker-level failure (module load, uncaught throw) never yields a message, so
// recover state here or the UI wedges — export button stuck disabled, status stuck.
worker.onerror = (e) => {
  setProgress(`Bake worker error: ${e.message || "failed to load"}`);
  previewPhase = "idle";
  if (exportGen !== -1) { /** @type {HTMLButtonElement} */ ($("export")).disabled = false; exportGen = -1; }
};

// Debounced fetch+bake → preview whenever the tile or its geom changes: coarse (FAST_MAX_TILES)
// on the quick timer, CRISP_MAX_TILES on the settle timer. Superseded runs' replies are dropped
// by generation, so a slow bake for an old tile never clobbers a newer.
let quickTimer = 0;
let settleTimer = 0;
// What the worker owes once it is free. It runs one job at a time and never skips superseded
// messages, so posting into a busy worker delays every job after it for a result nobody will
// look at. A tier that comes due mid-bake waits here and is posted from that bake's reply.
let quickDue = false;
let crispDue = false;
const bakeInFlight = () => previewPhase === "fast" || previewPhase === "crisp";

// Read at bake time, never stored: a printability judgement about the machine rather than a
// description of the tile, so it stays out of the store and the hash. Same treatment as
// #colorExport — but unlike that one it reshapes the terrain, so it also has to rebake.
const waterFilterOn = () => /** @type {HTMLInputElement} */ ($("waterFilter")).checked;

/** Restart both timers, so a burst reads quick → quick → quick → (settle) → detailed. */
function schedule() {
  window.clearTimeout(quickTimer);
  window.clearTimeout(settleTimer);
  quickTimer = window.setTimeout(loadPreview, QUICK_MS);
  settleTimer = window.setTimeout(settle, SETTLE_MS);
}

// The hash rides this timer, not the quick one: it describes state the user has stopped editing,
// and at 100 ms a slider drag would replaceState several times a second (Safari has historically
// throttled the History API to ~100 calls / 30 s). Cost: a URL copied within ~2 s of a change
// loses it.
function settle() {
  writeHash(store.get());
  crispDue = true;
  pump();
}

// Post whatever the worker owes, now that it is free. Called from every reply. Quick first: it
// is owed only because the state moved on, which is what makes a crisp for the older state moot.
function pump() {
  if (bakeInFlight()) return;
  if (quickDue) { quickDue = false; loadPreview(); return; }
  // Only from "pending": the crisp pass refines the quick mesh on screen, reusing its gen and
  // settings snapshot.
  if (crispDue && previewPhase === "pending") {
    crispDue = false;
    previewPhase = "crisp";
    setProgress("Detailed preview…");
    // Inlays ride the crisp pass only, like coverage: they cost a second full-grid snapshot and
    // their own mesh, worth paying once the user has stopped moving and not on every frame of a
    // slider drag. An ask, not a tell — the worker still gates on the mode, so render policy
    // here needs to know nothing about export intent.
    worker.postMessage({ gen: previewGen, settings: previewSettings, maxTiles: CRISP_MAX_TILES, format: "mesh", coverage: true, inlays: true, trail: previewTrail });
  }
}

// A preview started mid-export would clobber the export's status line and just
// queue behind it; defer it and run once the export finishes instead.
function resyncAfterExport() {
  if (previewDeferred) { previewDeferred = false; schedule(); }
}
function loadPreview() {
  if (exportGen !== -1) { previewDeferred = true; return; }
  crispDue = false; // this bake replaces the state that crisp was owed to
  if (bakeInFlight()) { quickDue = true; return; } // pump() posts it when that bake replies
  // Reads the live state, so a quick timer armed for an earlier change would only bake it twice.
  window.clearTimeout(quickTimer);
  const s = store.get();
  if (!s.center) { preview.setTiles([]); previewPhase = "idle"; setProgress("Click the map to place a tile."); return; }
  // `trail` rides its own field (the worker reads only that one), so it is destructured out
  // rather than posted twice — a structured clone of 15.7k points per pass, for a field nothing
  // downstream of `settings` reads. Same split as the export click below.
  const { trail, ...settings } = { ...s, center: s.center, waterFilter: waterFilterOn(),
    // Composed here, not stored: the parts are the grooving modes' point, so core's build switch
    // is a fact about the mode rather than a setting of its own. (`flat` builds none either way —
    // core excludes it — so this stays a plain mode check, not a policy.)
    waterInlay: s.waterMode === "lakes" || s.waterMode === "all" };
  previewSettings = settings;
  previewTrail = trail ? { segments: trail.segments, ...s.cord } : null;
  previewGen = ++gen;
  previewPhase = "fast";
  // Every posted quick bake owes a crisp, so the settle clock restarts with the POST, not only
  // with the change: pump() reaches here without passing through schedule().
  window.clearTimeout(settleTimer);
  settleTimer = window.setTimeout(settle, SETTLE_MS);
  setProgress("Quick preview…");
  worker.postMessage({ gen: previewGen, settings, maxTiles: FAST_MAX_TILES, format: "mesh", trail: previewTrail });
}

// Last trail rendered on the map. `trail` only ever changes reference on import or
// clear (store.set spreads state), so diffing by reference — not by content — skips
// the Leaflet teardown/rebuild on every other store change, including the 30-60/s
// stream an `input` slider drag fires.
/** @type {Trail | null} */
let shownTrail = null;

// Snapshot of the last state a bake was scheduled for. Every field counts, `cord` included: the
// preview now meshes the cord at the requested width, so a spinner click changes what is on
// screen and has to be rebaked for. Shallow by reference throughout — store.set spreads, so an
// untouched field keeps its identity, and controls.js rebuilds `cord` on each edit.
//
// The cost is one rebake per cord edit, at both tiers. A cord-only job reusing the grid would
// avoid the refetch, but the worker holds no mosaic between jobs (see bake.worker.js) — so it
// would mean a cache whose only client is a number input clicked a few times before an export.
/** @type {AppState | null} */
let lastBakeState = null;
/** @param {AppState} a @param {AppState | null} b @returns {boolean} */
function sameBakeInputs(a, b) {
  if (!b) return false;
  for (const k of /** @type {(keyof AppState)[]} */ (Object.keys(a))) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}
/** @param {AppState} s @returns {boolean} */
function bakeInputsChanged(s) { return !sameBakeInputs(s, lastBakeState); }

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
  // changing. Width has no clause — it doesn't depend on the tile's grid, so there is no
  // tile-derived minimum to warn about before the click.
  $("cordHint").textContent = cordHint(s.cord.heightMm, s.layerMm);
  // No plan needed any more: the channel's width is the cord's plus a fixed clearance, so it is
  // the same number at every tier and cannot disagree with the one that cuts.
  $("trenchHint").textContent = s.center
    ? trenchHint(s.cord.trenchDepthMm, s.cord.widthMm, s.cord.heightMm) : "";
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
  // A change that cannot reach the bake — re-selecting the preset already showing, whose `center`
  // array keeps its identity — leaves any pending timer running rather than pushing it back.
  // See bakeInputsChanged.
  if (bakeInputsChanged(s)) {
    lastBakeState = s;
    schedule();
  }
});

// Populate the region picker from PRESETS (grouped), keeping the static Custom
// option first. Selecting a preset writes center+scale, reflects the scale in the
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
  // Always written, so a preset frames its place the same way every time. Left to the user's
  // last choice, an ordinary preset would inherit `lakes` from whichever lake was picked before
  // it. syncControls because nothing else tells the cards the mode moved.
  store.set({ center: preset.center, scale: preset.scale, waterMode: preset.waterMode ?? "none" });
  syncControls(store.get());
  syncScaleInput(preset.scale);
  map.focus({ center: preset.center, scale: preset.scale, tileWidthMm: store.get().tileWidthMm, shape: store.get().shape });
}
presetSelect.addEventListener("change", () => {
  const preset = PRESETS.find((p) => p.name === presetSelect.value);
  if (preset) applyPreset(preset);
});

// On-load picker + inputs. A restored link is "Custom" by name — its center may be nowhere near
// a preset, and matching one by coordinates would mislabel a tile the user nudged off it. The
// map is already framed by initMap({ start }); the store carries its center+scale so the
// subscribe() fire runs the first preview (no redundant store.set here).
presetSelect.value = restored ? "" : DEFAULT_PRESET.name;
syncScaleInput(store.get().scale);
syncControls(store.get()); // unconditional: app.js owns the defaults, index.html only seeds them
// cord isn't ShareableState (see the AppState note above), so syncControls can't carry it — same
// reconciliation as every other control, just done here instead of there.
/** @type {HTMLInputElement} */ ($("cordW")).value = String(store.get().cord.widthMm);
/** @type {HTMLInputElement} */ ($("cordH")).value = String(store.get().cord.heightMm);
/** @type {HTMLInputElement} */ ($("trenchD")).value = String(store.get().cord.trenchDepthMm);

wireControls(store);
// Not wired in controls.js with the rest: that file's job is to move store state, and this
// checkbox holds none — it drives a rebake directly instead.
$("waterFilter").addEventListener("change", schedule);
wireHelp();

// Pasting a link into this tab's address bar changes only the fragment — no reload, no module
// re-run — so without this the app would ignore it and then overwrite it on the next debounce,
// destroying the link. Unlike first load, an unreadable hash here is left alone rather than
// reset to the default: the tile already on screen is the user's work, not a boot failure.
window.addEventListener("hashchange", () => {
  const h = location.hash.replace(/^#/, "");
  if (h === lastHash) return;
  const s = decodeState(h);
  // Recorded even when it doesn't decode: writeHash compares against it to tell our writes from
  // the user's, so an unrecorded paste would block every later write and strand the bar on it.
  lastHash = h;
  if (!s) return;
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

// Parse and fit BEFORE touching the store: a rejected import must leave the app untouched, and
// fitTile is where most rejections come from. One catch covers both, because parseGpxText and
// fitTile each reject by throwing and each phrase the message to complete the prefix below.
/** @param {File} file */
async function importTrail(file) {
  $("trailWarn").hidden = true; // clear a stale error before a new attempt can raise its own
  try {
    const segments = parseGpxText(await file.text());
    // #autoFit is a quick DOM-only preference, not AppState/ShareableState — it never reaches
    // the hash, so a shared link can't carry "don't fit" and surprise whoever opens it.
    const autoFit = /** @type {HTMLInputElement} */ ($("autoFit")).checked;
    const { center, scale } = autoFit ? fitToTrail(segments) : store.get();
    // cordWarning describes the bake currently on screen, so it's invalidated here, where that
    // bake is about to be replaced — not on a failed attempt, which leaves the old trail (and its
    // still-true warning) on screen. store.set below fires updateTrailWarning synchronously.
    cordWarning = "";
    exportRefusal = null; // a new trail is not the one that was refused
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
  // Settle the hash first: the clearTimeouts below drop the pending write, which would otherwise
  // leave the address bar describing different settings than the model being exported.
  writeHash(s);
  exportRefusal = null;            // this attempt's verdict supersedes the last one's
  window.clearTimeout(quickTimer); // cancel a queued preview…
  window.clearTimeout(settleTimer);
  previewGen = 0;                  // …and void any in-flight one, so its trailing reply can't clobber the export status
  // Voiding the gen makes that reply return before it reaches pump(), so clear the phase here or
  // bakeInFlight() parks every later preview in quickDue with nothing left to post it.
  previewPhase = "idle";
  quickDue = crispDue = false;     // both describe work this export supersedes
  // `trail` rides its own field below (the worker reads only that one), so it's destructured
  // out here rather than posted twice inside `settings` too.
  const { trail, ...settings } = { ...s, center: s.center, waterFilter: waterFilterOn(),
    waterInlay: s.waterMode === "lakes" || s.waterMode === "all" }; // composed, not stored — see loadPreview
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
