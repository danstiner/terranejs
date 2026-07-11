import { createStore } from "./state.js";
import { PRESETS, DEFAULT_PRESET, bboxToPolygon } from "./presets.js";
import { initMap } from "./mapPicker.js";
import { fit, bboxOf, bboxExtentMeters, suggestScale, splits, PITCH_MM } from "./fit.js";
import { pickZoom, tileRangeForBBox, sourceZoom, pixelWindow, lonToGlobalX, latToGlobalY, globalXToLon, globalYToLat, printPitchMm } from "./tilemath.js";
import { fetchMosaic } from "./terrain.js";
import { resampleBilinear, gridRange, cropGrid } from "./resample.js";
import { cellMask } from "./polyclip.js";
import { buildPreviewSolid, buildSolid, buildSolidFromMesh, buildTrailShell } from "./mesh.js";
import { clipTriangleToPolygon, footprintClassifier } from "./clip.js";
import { oceanMask, oceanMaskSeeded, cellOcean, erodeMask, recessedGrid,
  offsetGrid } from "./water.js";
import { parseGPX, trackBbox } from "./gpx.js";
import { samplePath, rasterizePath, profileAlong, smoothProfile, stampOffset,
  stampInlay, ribbonGrid } from "./path.js";
import { checkWatertight } from "./validate.js";
import { ThreeMFWriter } from "./threeMF.js";

const store = createStore({
  polygon: null, // [[lat,lon],…] or null
  scale: null, // 1:N
  scaleAuto: true,
  exag: 1.0,
  base: 6.0,
  capW: 250,
  capH: 250,
  waterDrop: 3, // ocean recess depth (mm); 0 = off
  waterSeparate: false, // print water as a separate insert
  tracks: [], // imported GPX files: [{ name, segs: [[[lat,lon],…],…] }]
  pathMode: "overlay", // overlay | bump | inset | inlay
  pathWmm: 1.6, // trail width on the print
  pathHmm: 0.6, // bump height / inset depth
  exportDetail: 2, // zoom-ladder slider index 0..3 (3 = source zoom)
});

// inlay-ribbon geometry: mating groove depth, how far the seated ribbon stands
// above the terrain, and XY clearance eroded off the ribbon footprint
const GROOVE_MM = 0.8;
const PROUD_MM = 0.6;
const PATH_CLEAR_MM = 0.15;

// minimum printed base wall: ≥3 layers at any common layer height (0.1–0.3 mm).
// tilejs can't read the slicer's layer height, so this is a fixed floor.
const MIN_WALL_MM = 1.0;
const WATER_CLEAR_MM = 0.4; // shore-edge clearance: tile pad + insert erode radius

// terrarium carries real bathymetry only at low zooms (probed 2026-07: Puget
// Sound min −248 m at z10; +0.5–2 m land-DEM junk at z11). Water classification
// and insert depths must never read finer than this.
const WATER_ZOOM_MAX = 10;

const EXPORT_COARSE_DIM = 1200; // whole-region context grid (ocean seeds, trail, z-frame)
const EXPORT_MAX_TILES = 300; // z12 over a county-size region ≈ 270 terrarium tiles

const PLA_DENSITY = 1.24; // g/cm³
// fraction of the solid envelope actually deposited: walls + 3% infill.
// Calibrated to a real slice (Rainier tile: 849 cm³ solid -> 145 g at 3%/0.15mm).
const MASS_FACTOR = 0.138;

const $ = (id) => document.getElementById(id);
const extentOf = (poly) => {
  const { realW, realH } = bboxExtentMeters(bboxOf(poly));
  return [realW, realH];
};

// count set cells inside a tile span, cw = cells per row
const countIn = (cells, sp, cw) => {
  let m = 0;
  for (let r = sp.r0; r < sp.r1; r++)
    for (let c = sp.c0; c < sp.c1; c++) m += cells[r * cw + c];
  return m;
};

// Ocean bake on any grid, given its ocean vertex mask. Plain mode flattens
// open ocean to one sunken plane; insert mode keeps the ocean-floor relief,
// lowered by the drop (exag-corrected so the print-z drop is exactly waterDrop).
function bakeWater(s, rawGrid, oMask, k) {
  if (!oMask) return rawGrid;
  // insert mode keeps ocean-floor relief (lowered by the drop) and needs a real
  // ≥1 mm drop — the insert's shore-edge thickness. Every other case is a flat
  // recess, so no state combination yields a bathymetry recess with no insert.
  const insertMode = s.waterSeparate && s.waterDrop >= 1;
  return insertMode
    ? offsetGrid(rawGrid, oMask, s.waterDrop / k)
    : recessedGrid(rawGrid, oMask, -s.waterDrop / k);
}

// Global trail context: uniform samples along all tracks (print mm) and, for
// inlay mode, the terrain profile at those samples plus the smoothed mating
// curve. Computed ONCE per surface so the groove floor is identical wherever
// it is stamped — per-tile export stamping must not re-derive it or the floor
// would step at print-tile seams. `grid` supplies elevations; `ds` sets only the
// sample spacing. The rasterization width floors live at the call sites (preview
// visibility; ribbon chain in the clearance fix), so halfW is the true print
// width and the preview band matches the exported groove.
function trailContext(s, grid, gw, gh, f, ds) {
  const segs = s.tracks.flatMap((t) => t.segs);
  if (!segs.length) return null;
  const { pts, segStarts } = samplePath(segs, f.bbox, f.widthMm, f.heightMm, ds);
  if (pts.length < 4) return null;
  const k = (1000 / f.scale) * s.exag;
  const ctx = { pts, halfW: s.pathWmm / 2, k };
  if (s.pathMode === "inlay") {
    const dx = f.widthMm / (gw - 1), dy = f.heightMm / (gh - 1);
    ctx.emin0 = gridRange(grid).min;
    ctx.zrel = Float32Array.from(profileAlong(grid, gw, gh, dx, dy, pts),
      (v) => (v - ctx.emin0) * k);
    ctx.fRel = smoothProfile(ctx.zrel, segStarts, ds);
  }
  return ctx;
}

// Stamp the trail onto a grid from its rasterization; inlay also yields the
// ribbon top heightfield (mm) for the separately printed path piece.
function stampTrail(s, grid, ctx, mask, sIdx) {
  if (s.pathMode === "overlay") return { grid, ribbon: null }; // terrain untouched; the cord is a separate per-tile piece
  if (s.pathMode === "inlay") {
    return {
      grid: stampInlay(grid, mask, sIdx, ctx.fRel, GROOVE_MM, ctx.emin0, ctx.k),
      ribbon: ribbonGrid(mask, sIdx, ctx.zrel, ctx.fRel, GROOVE_MM, PROUD_MM),
    };
  }
  const dElev = (s.pathMode === "bump" ? 1 : -1) * (s.pathHmm / ctx.k);
  return { grid: stampOffset(grid, mask, dElev), ribbon: null };
}

// Surface elevation grid with the water and trail features baked in, plus the
// masks the preview colors by. Used by the preview and mass estimate; the
// export streams the same steps per print tile.
function bakedSurface(s, rawGrid, gw, gh, f, waterGrid = rawGrid) {
  const k = (1000 / f.scale) * s.exag; // print mm per grid unit
  const oMask = s.waterDrop > 0 ? oceanMask(waterGrid, gw, gh, 0) : null; // sea level = 0, bathymetry-valid data
  let grid = bakeWater(s, rawGrid, oMask, k);
  const dx = f.widthMm / (gw - 1), dy = f.heightMm / (gh - 1);
  const ctx = trailContext(s, grid, gw, gh, f, Math.max(dx, dy));
  let pathMask = null, ribbon = null;
  if (ctx) {
    // floor the preview groove only for line continuity at 1–2 vertices
    const { mask, sIdx } = rasterizePath(ctx.pts, gw, gh, dx, dy,
      Math.max(ctx.halfW, 0.6 * Math.max(dx, dy)));
    ({ grid, ribbon } = stampTrail(s, grid, ctx, mask, sIdx));
    pathMask = mask;
  }
  const { min, max } = gridRange(grid);
  return { grid, oMask, pathMask, ribbon, min, max };
}

const map = initMap({
  center: [46.85, -121.75],
  zoom: 11,
  onChange: (polygon, isCreate) => {
    const s = store.get();
    const suggest = polygon && (isCreate || s.scale == null) && s.scaleAuto;
    store.set({ polygon, scale: suggest ? suggestScale(...extentOf(polygon)) : s.scale });
  },
});

// --- presets ---------------------------------------------------------------
const preset = $("preset");
const groups = new Map();
for (const p of PRESETS) {
  // a preset with neither a resolved boundary nor a bbox can't build a polygon
  // (bboxToPolygon(undefined) throws) — skip it so a partial bake can't kill load
  if (!p.boundary && !p.bbox) {
    console.warn(`preset "${p.name}" has no boundary or bbox — skipping (unbaked region?)`);
    continue;
  }
  if (!groups.has(p.group)) {
    const g = document.createElement("optgroup");
    g.label = p.group;
    preset.appendChild(g);
    groups.set(p.group, g);
  }
  const o = document.createElement("option");
  o.value = o.textContent = p.name;
  groups.get(p.group).appendChild(o);
}
// a preset region is either a real boundary ring or a rectangle from its bbox
function presetPolygon(p) {
  return p.boundary || bboxToPolygon(p.bbox);
}
preset.addEventListener("change", () => {
  const p = PRESETS.find((x) => x.name === preset.value);
  if (!p) return;
  const poly = presetPolygon(p);
  map.setPolygon(poly);
  map.fitBbox(bboxOf(poly));
  store.set({ polygon: poly, scaleAuto: true, scale: suggestScale(...extentOf(poly)) });
});
$("clear").addEventListener("click", () => {
  map.clear();
  preset.value = "";
  store.set({ polygon: null, scale: null, scaleAuto: true, tracks: [] });
});

// --- GPX trail ---------------------------------------------------------------
$("gpxImport").addEventListener("click", () => $("gpxFile").click());
$("gpxFile").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = ""; // so re-picking the same file fires change again
  if (!files.length) return;
  // per-file: one unreadable/empty GPX must not abort the whole import
  const added = [], failed = [];
  for (const file of files) {
    try {
      const segs = parseGPX(await file.text());
      if (segs.length) added.push({ name: file.name, segs });
      else failed.push(`${file.name} (no track points)`);
    } catch (err) {
      failed.push(`${file.name} (${err.message})`);
    }
  }
  $("gpxMsg").textContent = failed.length ? `skipped: ${failed.join(", ")}` : "";
  if (!added.length) return;
  const st = store.get();
  // additive: imports accumulate; re-importing a filename replaces that file
  const names = new Set(added.map((t) => t.name));
  const tracks = [...st.tracks.filter((t) => !names.has(t.name)), ...added];
  if (st.polygon) {
    store.set({ tracks });
  } else {
    // no region yet — frame the imported tracks
    const poly = bboxToPolygon(trackBbox(tracks.flatMap((t) => t.segs)));
    map.setPolygon(poly);
    map.fitBbox(bboxOf(poly));
    store.set({ tracks, polygon: poly, scaleAuto: true, scale: suggestScale(...extentOf(poly)) });
  }
});

// file list with per-track remove buttons; map track layers follow the store
let renderedTracks = null; // store state is replaced, not mutated, so compare by reference
function renderTracks(s) {
  if (s.tracks === renderedTracks) return;
  renderedTracks = s.tracks;
  map.setTrack(s.tracks.flatMap((t) => t.segs));
  const list = $("gpxList");
  list.textContent = "";
  s.tracks.forEach((t, i) => {
    const row = document.createElement("div");
    const name = document.createElement("span");
    name.textContent = t.name;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.textContent = "✕";
    rm.title = "remove this trail";
    rm.addEventListener("click", () => {
      const cur = store.get();
      store.set({ tracks: cur.tracks.filter((_, j) => j !== i) });
    });
    row.append(name, rm);
    list.appendChild(row);
  });
}
$("pathMode").addEventListener("change", (e) => store.set({ pathMode: e.target.value }));
$("pathW").addEventListener("input", (e) => store.set({ pathWmm: Number(e.target.value) }));
$("pathH").addEventListener("input", (e) => store.set({ pathHmm: Number(e.target.value) }));

// --- print settings --------------------------------------------------------
$("scale").addEventListener("input", (e) => {
  const v = Number(e.target.value);
  if (v > 0) store.set({ scale: v, scaleAuto: false });
});
$("scaleAuto").addEventListener("click", () => {
  const s = store.get();
  if (s.polygon) store.set({ scaleAuto: true, scale: suggestScale(...extentOf(s.polygon)) });
});
$("exag").addEventListener("input", (e) => store.set({ exag: Number(e.target.value) }));
$("base").addEventListener("input", (e) => store.set({ base: Number(e.target.value) }));
$("detail").addEventListener("input", (e) => store.set({ exportDetail: Number(e.target.value) }));
$("capW").addEventListener("input", (e) => store.set({ capW: Number(e.target.value) || 250 }));
$("capH").addEventListener("input", (e) => store.set({ capH: Number(e.target.value) || 250 }));
// insert mode needs ≥1 mm of drop — that drop is the insert's shore-edge thickness
$("waterDrop").addEventListener("input", (e) => {
  const v = Number(e.target.value);
  store.set({ waterDrop: store.get().waterSeparate ? Math.max(1, v) : v });
});
$("waterSeparate").addEventListener("change", (e) => store.set({
  waterSeparate: e.target.checked,
  waterDrop: e.target.checked ? Math.max(1, store.get().waterDrop) : store.get().waterDrop,
}));
$("export").addEventListener("click", export3MF);

// --- preview state ---------------------------------------------------------
let preview = null; // three.js view, lazily created
let pv = null; // { grid, waterGrid, gw, gh, f, mask } cached mosaic+resample; survives exag/base
let pvKey = null; // fit-affecting inputs; changing them invalidates pv

const keyOf = (s) => JSON.stringify([s.polygon, s.scale, s.capW, s.capH]);

// terrain auto-reloads (debounced) when the fetched-grid inputs change;
// exag/base/water only rebuild the mesh from the cached grid.
let reloadTimer = null;
let loadToken = 0;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(loadPreview, 500);
}

// --- render ----------------------------------------------------------------
store.subscribe((s) => {
  renderRegion(s);
  renderTracks(s);
  // one bake per event, shared by the mass estimate and the tile rebuild
  const baked = pv && pvKey === keyOf(s) ? bakedSurface(s, pv.grid, pv.gw, pv.gh, pv.f, pv.waterGrid) : null;
  renderSettings(s, baked);
  if (pvKey === null || keyOf(s) !== pvKey) scheduleReload();
  else if (pv) rebuildTiles(baked);
});

function renderRegion(s) {
  const el = $("readout");
  const v = s.polygon;
  if (!v || v.length < 3) { el.textContent = "No region selected."; return; }
  const [bs, bw, bn, be] = bboxOf(v);
  el.textContent =
    `${v.length} vertices\n` +
    `bbox S,W,N,E:\n  ${[bs, bw, bn, be].map((x) => x.toFixed(4)).join(", ")}`;
}

// Slider readout: honest computed values for the chosen zoom-ladder step —
// pixel pitch on the print, triangle estimate, and projected .3mf size
// (~11 B/triangle deflated, measured on the King County export).
function detailLabel(f, di) {
  const cLat = (f.bbox[0] + f.bbox[2]) / 2;
  const zSrc = sourceZoom(f.bbox, cLat, f.scale, EXPORT_MAX_TILES);
  const z = Math.max(1, zSrc - (3 - di));
  const pitch = printPitchMm(cLat, z, f.scale);
  const tris = 2 * f.coverage * (f.widthMm / pitch) * (f.heightMm / pitch);
  const mb = (tris * 11) / 1e6;
  const t = tris >= 1e6 ? `${(tris / 1e6).toFixed(1)}M` : `${Math.round(tris / 1e3)}K`;
  return `${pitch.toFixed(2)} mm/px · ~${t} tris · ~${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

function renderSettings(s, baked) {
  const box = $("settings");
  if (!s.polygon || s.polygon.length < 3 || !s.scale) { box.hidden = true; return; }
  box.hidden = false;
  if ($("scale") !== document.activeElement) $("scale").value = Math.round(s.scale);
  $("exagVal").textContent = s.exag.toFixed(1);
  $("baseVal").textContent = s.base.toFixed(1);
  $("waterDropVal").textContent = s.waterDrop.toFixed(1);
  $("waterDrop").value = s.waterDrop; // range thumb must snap to a clamped value, even while dragging
  $("waterOpts").hidden = s.waterDrop <= 0;
  $("waterSeparate").checked = s.waterSeparate;

  $("trailOpts").hidden = !s.tracks.length;
  if (s.tracks.length) {
    $("pathMode").value = s.pathMode;
    $("pathWVal").textContent = s.pathWmm.toFixed(1);
    if ($("pathW") !== document.activeElement) $("pathW").value = s.pathWmm;
    $("pathHRow").hidden = s.pathMode === "inlay";
    $("inlayHint").hidden = s.pathMode !== "inlay";
    $("overlayHint").hidden = s.pathMode !== "overlay";
    $("pathHName").textContent =
      s.pathMode === "inset" ? "Inset depth" :
      s.pathMode === "overlay" ? "Trail height" : "Bump height";
    $("pathHVal").textContent = s.pathHmm.toFixed(1);
    if ($("pathH") !== document.activeElement) $("pathH").value = s.pathHmm;
  }

  const f = fit({ polygon: s.polygon, scale: s.scale, capW: s.capW, capH: s.capH });
  const di = Math.min(3, Math.max(0, Math.round(s.exportDetail)));
  $("detail").value = di;
  $("detailVal").textContent = detailLabel(f, di);
  const nT = f.nx * f.ny;
  const warn = nT > 16 ? ' <span class="warn">(a lot!)</span>' : "";
  const m = estimateMassG(s, baked);
  const massLine = m
    ? `~${m.total.toFixed(0)} g @3% infill (~${m.perTile.toFixed(0)} g/tile)`
    : "— loading…";
  const chip = (label, val) => `<span><b>${label}</b> ${val}</span>`;
  $("fit").innerHTML =
    chip("scale", `1:${Math.round(f.scale).toLocaleString()}`) +
    chip("print", `${f.widthMm.toFixed(0)}×${f.heightMm.toFixed(0)} mm`) +
    chip("tiles", `${f.nx}×${f.ny} = ${nT}${warn}`) +
    chip("/tile", `${f.tileWmm.toFixed(0)}×${f.tileHmm.toFixed(0)} mm`) +
    chip("sampling", `~${f.groundM.toFixed(1)} m${f.dataLimited ? " *data-limited*" : ""}`) +
    chip("material", massLine) +
    chip("coverage", `${(f.coverage * 100).toFixed(0)}%`);
}

// PLA mass from the loaded terrain: solid volume (base + relief per cell) times
// density times the shell+infill factor. Uses the cached preview grid, so it's
// only available once terrain is loaded and still matches the current settings.
function estimateMassG(s, baked) {
  if (!pv || !baked || pvKey !== keyOf(s)) return null;
  const { gw, gh, f, mask } = pv;
  const { grid, min } = baked;
  const mmPerM = 1000 / f.scale;
  const cellArea = (f.widthMm / (gw - 1)) * (f.heightMm / (gh - 1));
  const cw = gw - 1;
  let vol = 0; // mm³
  for (let r = 0; r < gh - 1; r++) {
    for (let c = 0; c < cw; c++) {
      if (!mask[r * cw + c]) continue;
      const avg = (grid[r * gw + c] + grid[r * gw + c + 1] +
        grid[(r + 1) * gw + c] + grid[(r + 1) * gw + c + 1]) / 4;
      vol += cellArea * (s.base + (avg - min) * mmPerM * s.exag);
    }
  }
  const total = (vol / 1000) * PLA_DENSITY * MASS_FACTOR;
  return { total, perTile: total / (f.nx * f.ny) };
}

// --- terrain fetch + preview (auto-triggered, debounced) ------------------
async function loadPreview() {
  clearTimeout(reloadTimer);
  const s = store.get();
  if (!s.polygon || !s.scale) return;
  const token = ++loadToken; // discard if a newer load starts before we commit
  const f = fit({ polygon: s.polygon, scale: s.scale, capW: s.capW, capH: s.capH });

  // preview grid: finer than a bare sketch so smooth terrain (e.g. Fuji's cone)
  // doesn't show coarse facets; raising it also raises the fetch zoom, cutting
  // the data terracing. Kept moderate since the preview now renders the full
  // solid (top + walls + base), which doubles the geometry.
  const MAX = 320;
  const aspect = f.realW / f.realH;
  const gw = aspect >= 1 ? MAX : Math.max(2, Math.round(MAX * aspect));
  const gh = aspect >= 1 ? Math.max(2, Math.round(MAX / aspect)) : MAX;

  const cLat = (f.bbox[0] + f.bbox[2]) / 2;
  const { z, upsampled } = pickZoom(f.realW / gw, cLat);
  const zW = Math.min(z, WATER_ZOOM_MAX);

  $("progress").textContent = "fetching elevation…";
  try {
    const mosaic = await fetchMosaic(f.bbox, z, {
      onProgress: (d, t) => { if (token === loadToken) $("progress").textContent = `fetching tiles ${d}/${t}…`; },
    });
    if (token !== loadToken) return; // a newer load supersedes this one
    const grid = resampleBilinear(mosaic, f.bbox, gw, gh);
    // small coastal regions preview at z>WATER_ZOOM_MAX, where bathymetry is
    // land-DEM junk; fetch the coarse mosaic unconditionally so raising
    // waterDrop later doesn't need a reload (it's 1-4 tiles for these regions)
    let waterGrid = grid;
    if (zW !== z) {
      const mosaicW = await fetchMosaic(f.bbox, zW, {});
      if (token !== loadToken) return; // a newer load supersedes this one
      waterGrid = resampleBilinear(mosaicW, f.bbox, gw, gh);
    }
    // use the fetch-start snapshot, not post-await store state: a Clear mid-fetch
    // makes store.polygon null (cellMask throws), and a polygon edit would stamp
    // this now-stale grid as fresh. The token guard above already dropped any
    // superseded load, so s/f are the inputs this grid was actually fetched for.
    const mask = cellMask(s.polygon, f.bbox, gw, gh);
    pv = { grid, waterGrid, gw, gh, f, mask };
    pvKey = keyOf(s);
    $("progress").textContent = upsampled
      ? `z${z} — note: sampling finer than the data supports (interpolated)`
      : `z${z} — ${(mosaic.width / 256) * (mosaic.height / 256)} tiles loaded`;
    if (!preview) {
      const mod = await import("./preview.js");
      preview = mod.initPreview($("preview"));
    }
    preview.resize();
    const baked = bakedSurface(store.get(), grid, gw, gh, f, waterGrid);
    rebuildTiles(baked);
    renderSettings(store.get(), baked); // refresh readout so the material estimate appears
  } catch (err) {
    if (token === loadToken) $("progress").innerHTML = `<span class="warn">load failed: ${err.message}</span>`;
  }
}

// rebuild exploded tile meshes from the cached grid (cheap; no network)
function rebuildTiles(baked) {
  if (!pv || !preview || !baked) return;
  const s = store.get();
  const { gw, gh, f, mask } = pv;
  const { grid, oMask, pathMask, min, max } = baked;
  const erange = Math.max(1e-6, max - min);
  const mmPerM = 1000 / f.scale;
  const dx = f.widthMm / (gw - 1);
  const dy = f.heightMm / (gh - 1);
  const rows = splits(f.ny, gh);
  const cols = splits(f.nx, gw);
  const gapX = 0.14 * f.tileWmm;
  const gapY = 0.14 * f.tileHmm;

  const tiles = [];
  rows.forEach(([r0, r1], ry) => {
    cols.forEach(([c0, c1], cx) => {
      tiles.push(buildPreviewSolid(grid, gw, gh, { r0, r1, c0, c1 }, mask, {
        dx, dy, offX: cx * gapX, offY: (f.ny - 1 - ry) * gapY, oceanMask: oMask, pathMask,
        mmPerM, emin: min, erange, exag: s.exag, base: s.base,
      }));
    });
  });
  preview.setTiles(tiles);
}

// --- 3MF export --------------------------------------------------------------
// Fetches terrain at the export zoom and meshes every tile at full grid
// density; polygon edge tiles clip cells to the region ring.

// Grid-cell + polygon-clipped solid for one edge tile: full-density cells with
// the region ring mapped into the tile-local mm frame. Interior cells emit
// their two grid triangles whole; boundary-band cells (SAT prefilter) are
// clipped to the ring. Returns null on any failure (degenerate clip /
// non-closing solid) so the caller falls back to the uniform stair-clip and
// export never breaks.
function clipTileSolid(grid, gw, gh, span, polygon, geom, subMask) {
  const { r0, r1, c0, c1 } = span;
  const { dx, dy, mmPerM, emin, exag, base, bbox: [s, w, n, e], widthMm, heightMm } = geom;
  try {
    const k = mmPerM * exag;
    const gwt = c1 - c0 + 1, ght = r1 - r0 + 1;
    const poly = polygon.map(([lat, lon]) => [
      ((lon - w) / (e - w)) * widthMm - c0 * dx,
      r1 * dy - ((n - lat) / (n - s)) * heightMm,
    ]);
    const X = (c) => (c - c0) * dx;
    const Y = (r) => (r1 - r) * dy;
    const Z = (r, c) => base + (grid[r * gw + c] - emin) * k;
    const classify = footprintClassifier(subMask, gwt - 1, ght - 1);
    const top = [];
    for (let r = r0; r < r1; r++) {
      for (let c = c0; c < c1; c++) {
        const cls = classify(c - c0, r - r0, c - c0, r - r0);
        if (cls === "out") continue;
        const A = [X(c), Y(r), Z(r, c)], B = [X(c + 1), Y(r), Z(r, c + 1)];
        const C = [X(c), Y(r + 1), Z(r + 1, c)], D = [X(c + 1), Y(r + 1), Z(r + 1, c + 1)];
        for (const tri of [[A, C, B], [B, C, D]]) {
          if (cls === "in") top.push(...tri[0], ...tri[1], ...tri[2]);
          else for (const q of clipTriangleToPolygon(tri, poly)) top.push(q);
        }
      }
    }
    if (!top.length) return null;
    const solid = buildSolidFromMesh(top);
    return checkWatertight(solid).closed ? solid : null;
  } catch {
    return null;
  }
}

async function export3MF() {
  const s = store.get();
  if (!s.polygon || !s.scale) { $("progress").textContent = "pick a region first"; return; }
  const f = fit({ polygon: s.polygon, scale: s.scale, capW: s.capW, capH: s.capH });
  const [latS, lonW, latN, lonE] = f.bbox;
  const cLat = (latS + latN) / 2;
  const btn = $("export");
  btn.disabled = true;
  try {
    // pixel-locked lattice: the export grid IS the terrarium pixel lattice at
    // the ladder zoom — one vertex per source sample, no terrain resampling.
    // Steps are zoom-relative (zSrc−3 … zSrc); zSrc from the 0.1 mm
    // print-pitch floor, the z15 pyramid max, and the region tile budget.
    const zSrc = sourceZoom(f.bbox, cLat, f.scale, EXPORT_MAX_TILES);
    const di = Math.min(3, Math.max(0, Math.round(s.exportDetail)));
    const z = Math.max(1, zSrc - (3 - di));
    const win = pixelWindow(f.bbox, z);
    const gwF = win.gw, ghF = win.gh;
    if (gwF < 2 || ghF < 2) throw new Error("region smaller than one pixel at this step — raise the detail slider");
    const rows = splits(f.ny, ghF), cols = splits(f.nx, gwF);
    // mm per pixel, anchored to the fitted print size so the piece matches the
    // UI-stated dimensions to within one pixel; rows are uniform in Mercator y — the print is a
    // true Mercator map at the nominal scale (<0.5% N–S ground-spacing drift
    // at county extents, the same distortion the map preview shows)
    const dx = f.widthMm / (lonToGlobalX(lonE, z) - lonToGlobalX(lonW, z));
    const dy = f.heightMm / (latToGlobalY(latS, z) - latToGlobalY(latN, z));
    const mmPerM = 1000 / f.scale;
    const k = mmPerM * s.exag;
    const lonAt = (ci) => globalXToLon(win.gx0 + ci + 0.5, z);
    const latAt = (ri) => globalYToLat(win.gy0 + ri + 0.5, z);
    // the interior lattice starts up to one pixel inside the bbox corner;
    // trail points are sampled in the bbox mm frame, so window offsets must
    // carry the lattice origin
    const x0off = (win.gx0 + 0.5 - lonToGlobalX(lonW, z)) * dx;
    const y0off = (latToGlobalY(latS, z) - (win.gy0 + ghF - 1 + 0.5)) * dy;

    // --- context pass: one small whole-region grid for everything the tiles
    // must agree on globally — ocean connectivity (seed source for the per-tile
    // floods), the trail profile / mating curve, and the shared z-frame min.
    let gwC = Math.round(f.widthMm / PITCH_MM) + 1;
    let ghC = Math.round(f.heightMm / PITCH_MM) + 1;
    const capC = Math.max(gwC, ghC);
    if (capC > EXPORT_COARSE_DIM) {
      gwC = Math.max(2, Math.round((gwC * EXPORT_COARSE_DIM) / capC));
      ghC = Math.max(2, Math.round((ghC * EXPORT_COARSE_DIM) / capC));
    }
    const { z: zC } = pickZoom(Math.max(f.groundM, f.realW / (gwC - 1)), cLat);
    const rangeC = tileRangeForBBox(f.bbox, zC);
    if (rangeC.count > EXPORT_MAX_TILES) {
      throw new Error(`${rangeC.count} tiles at z${zC} — coarsen the scale to export`);
    }
    $("progress").textContent = `context pass (z${zC}, ${rangeC.count} tiles)…`;
    const mosaicC = await fetchMosaic(f.bbox, zC, {
      onProgress: (d, t) => { $("progress").textContent = `context pass: fetching ${d}/${t}…`; },
    });
    const rawC = resampleBilinear(mosaicC, f.bbox, gwC, ghC);
    // water reads from a coarser mosaic when zC is finer than bathymetry-valid;
    // reuse mosaicC (no extra fetch) when it's already coarse enough
    const zW = Math.min(zC, WATER_ZOOM_MAX);
    let mosaicWater = mosaicC;
    if (s.waterDrop > 0 && zW !== zC) {
      $("progress").textContent = `water pass (z${zW})…`;
      mosaicWater = await fetchMosaic(f.bbox, zW, {});
    }
    const rawWC = mosaicWater === mosaicC ? rawC
      : resampleBilinear(mosaicWater, f.bbox, gwC, ghC);
    const oMaskC = s.waterDrop > 0 ? oceanMask(rawWC, gwC, ghC, 0) : null;
    const gridC = bakeWater(s, rawC, oMaskC, k);
    // trail sampled at the FINE pitch (elevations off the coarse grid): the
    // per-tile rasterization needs sample spacing ≤ halfW to stay gap-free
    const trail = trailContext(s, gridC, gwC, ghC, f, Math.max(dx, dy));
    // shared z-frame min: bake the trail onto the coarse context grid exactly as
    // the tiles will, then take its true minimum. This captures the inlay groove
    // floor / inset cut / bump in every mode — no per-mode analytic patches, and
    // no case (water-insert shoreline) left unbounded. Fine-tile vertices that
    // dip below this coarse min are floored per-tile (Step 4).
    let stampedC = gridC;
    if (trail) {
      const dxC = f.widthMm / (gwC - 1), dyC = f.heightMm / (ghC - 1);
      const { mask: pmC, sIdx: siC } = rasterizePath(trail.pts, gwC, ghC, dxC, dyC, trail.halfW);
      ({ grid: stampedC } = stampTrail(s, gridC, trail, pmC, siC));
    }
    const emin = gridRange(stampedC).min;
    // deepest vertex we allow before the printed wall would fall under MIN_WALL_MM
    const floorGrid = emin + (Math.min(s.base, MIN_WALL_MM) - s.base) / k;

    // padded tile window: erosion (water ~0.4 mm, trail clearance) must see real
    // neighbors past the seam, or inserts/ribbons get nibbled at tile edges
    const pad = Math.max(3, Math.ceil(WATER_CLEAR_MM / dx) + 1);
    const wantWater = s.waterDrop >= 1 && s.waterSeparate;
    const wantPath = trail && s.pathMode === "inlay";
    const wantOverlay = trail && s.pathMode === "overlay";

    const writer = new ThreeMFWriter();
    const gapX = 0.14 * f.tileWmm, gapY = 0.14 * f.tileHmm;
    const placeX = (cx) => cx * (f.tileWmm + gapX);
    const rowY = (ry) => (f.ny - 1 - ry) * (f.tileHmm + gapY);
    // separate pieces sit in mirrored blocks below the tile grid: water block
    // first, then path/trail (mutually exclusive), so nothing overlaps
    const belowY = (ry, block) => -(f.tileHmm + gapY) * (ry + 1 + block * f.ny);
    let tris = 0;
    const add = async (name, solid, x, y) => {
      tris += solid.indices.length / 3;
      await writer.addObject(name, solid, x, y);
      await new Promise((r) => setTimeout(r, 0)); // let progress paint
    };
    let n = 0, nw = 0, np = 0, nt = 0, ti = 0, nFloored = 0;
    const nTiles = f.nx * f.ny;
    for (const [ry, [r0, r1]] of rows.entries()) {
      for (const [cx, [c0, c1]] of cols.entries()) {
        const label = `tile ${++ti}/${nTiles}`;
        const pr0 = Math.max(0, r0 - pad), pr1 = Math.min(ghF - 1, r1 + pad);
        const pc0 = Math.max(0, c0 - pad), pc1 = Math.min(gwF - 1, c1 + pad);
        const gwT = pc1 - pc0 + 1, ghT = pr1 - pr0 + 1;
        const tb = [latAt(pr1), lonAt(pc0), latAt(pr0), lonAt(pc1)]; // window bbox [S,W,N,E]
        const span = { r0: r0 - pr0, r1: r1 - pr0, c0: c0 - pc0, c1: c1 - pc0 };
        const cw = gwT - 1;

        // region mask first — skip fetching tiles entirely outside the polygon
        const mask = cellMask(s.polygon, tb, gwT, ghT);
        const total = (span.r1 - span.r0) * (span.c1 - span.c0);
        const covered = countIn(mask, span, cw);
        if (covered === 0) continue;

        const range = tileRangeForBBox(tb, z);
        if (range.count > EXPORT_MAX_TILES) {
          throw new Error(`${label}: ${range.count} tiles at z${z} — coarsen the scale to export`);
        }
        $("progress").textContent = `${label}: fetching (z${z}, ${range.count} tiles)…`;
        const mosaic = await fetchMosaic(tb, z, {
          onProgress: (d, t) => { $("progress").textContent = `${label}: fetching ${d}/${t}…`; },
        });
        const rawT = cropGrid(mosaic, { gx0: win.gx0 + pc0, gy0: win.gy0 + pr0, gw: gwT, gh: ghT });
        $("progress").textContent = `${label}: meshing…`;
        await new Promise((r) => setTimeout(r, 0)); // let the message paint

        // ocean: flood the bathymetry view of this window from coarse-mask
        // seeds (edge-connectivity is global; the geometry grid has no valid
        // water signal at z>WATER_ZOOM_MAX)
        let oMaskT = null, waterT = null;
        if (s.waterDrop > 0) {
          waterT = resampleBilinear(mosaicWater, tb, gwT, ghT);
          const seeds = new Uint8Array(gwT * ghT);
          const ccMap = new Int32Array(gwT); // coarse column per tile column (row-invariant)
          for (let c = 0; c < gwT; c++) ccMap[c] = Math.round(((pc0 + c) / (gwF - 1)) * (gwC - 1));
          for (let r = 0; r < ghT; r++) {
            const rc = Math.round(((pr0 + r) / (ghF - 1)) * (ghC - 1));
            for (let c = 0; c < gwT; c++) seeds[r * gwT + c] = oMaskC[rc * gwC + ccMap[c]];
          }
          oMaskT = oceanMaskSeeded(waterT, gwT, ghT, seeds);
        }
        let grid = bakeWater(s, rawT, oMaskT, k);

        // trail: same global context, rasterized in this window's local frame so
        // the groove floor and ribbon heights are seam-continuous by construction
        let ribbon = null, pathCells = null, overlayCells = null;
        if (trail) {
          const offX = x0off + pc0 * dx, offY = y0off + (ghF - 1 - pr1) * dy;
          const ptsT = new Float32Array(trail.pts.length);
          for (let i = 0; i < ptsT.length; i += 2) {
            ptsT[i] = trail.pts[i] - offX;
            ptsT[i + 1] = trail.pts[i + 1] - offY;
          }
          // ribbon footprint = groove inset by exactly PATH_CLEAR_MM, never below
          // a ~2-cell chain; the groove widens so the ribbon always fits inside it
          const ds = Math.max(dx, dy);
          const ribbonHalfW = Math.max(trail.halfW - PATH_CLEAR_MM, 1.6 * ds);
          const grooveHalfW = Math.max(trail.halfW, ribbonHalfW + PATH_CLEAR_MM);
          // overlay bands at the true trail width (0.6·ds floor for line continuity,
          // matching the preview); inlay/bump/inset keep the groove-fit width
          const bandHalfW = wantOverlay ? Math.max(trail.halfW, 0.6 * ds) : grooveHalfW;
          const innerHalfW = wantPath ? ribbonHalfW : 0;
          const { mask: pm, sIdx, inner } = rasterizePath(ptsT, gwT, ghT, dx, dy, bandHalfW, innerHalfW);
          ({ grid, ribbon } = stampTrail(s, grid, trail, pm, sIdx));
          if (wantPath) {
            pathCells = cellOcean(inner, gwT, ghT); // clearance already applied
            for (let i = 0; i < pathCells.length; i++) pathCells[i] &= mask[i];
          }
          if (wantOverlay) {
            // cord footprint = the trail band (pathWmm-wide) ∩ region
            overlayCells = cellOcean(pm, gwT, ghT);
            for (let i = 0; i < overlayCells.length; i++) overlayCells[i] &= mask[i];
          }
        }

        // z-floor: the fine tile grid meshes at a finer pitch than the coarse grid
        // emin came from, so a narrow deep feature between coarse samples can read
        // below emin. Floor the covered span (all the mesh builders read) so the
        // printed wall stays ≥ min(base, MIN_WALL_MM); tally lifts for the note.
        for (let r = span.r0; r <= span.r1; r++) {
          for (let c = span.c0; c <= span.c1; c++) {
            const i = r * gwT + c;
            if (grid[i] < floorGrid) { grid[i] = floorGrid; nFloored++; }
          }
        }

        // terrain solid: full-density grid; edge tiles clip cells to the
        // region ring, falling back to the uniform stair-clip
        let solid;
        if (covered === total) {
          solid = buildSolid(grid, gwT, ghT, span, mask,
            { dx, dy, mmPerM, emin, exag: s.exag, base: s.base });
        } else {
          // geom is window-local: clipTileSolid's polygon mapping is
          // self-consistent in any frame whose bbox/dims match the grid
          const geom = { dx, dy, mmPerM, emin, exag: s.exag, base: s.base,
            bbox: tb, widthMm: (gwT - 1) * dx, heightMm: (ghT - 1) * dy };
          // span-local cell mask for the clip prefilter
          const gwt = span.c1 - span.c0 + 1, ght = span.r1 - span.r0 + 1;
          const subMask = new Uint8Array((gwt - 1) * (ght - 1));
          for (let r = 0; r < ght - 1; r++)
            for (let c = 0; c < gwt - 1; c++)
              subMask[r * (gwt - 1) + c] = mask[(span.r0 + r) * cw + (span.c0 + c)];
          solid = clipTileSolid(grid, gwT, ghT, span, s.polygon, geom, subMask)
            || buildSolid(grid, gwT, ghT, span, mask,
              { dx, dy, mmPerM, emin, exag: s.exag, base: s.base });
        }
        n++;
        await add(`tile_r${ry}_c${cx}`, solid, placeX(cx), rowY(ry));

        // water insert for this tile: printed top follows the ocean floor
        // (depth·scale above the drop), flat face at z=0 is the sea surface;
        // prints flat face down, flips north-south into the recess, so its
        // depth grid and cell mask are built row-mirrored within the window
        if (wantWater && oMaskT) {
          const rings = Math.max(1, Math.ceil(WATER_CLEAR_MM / dx)); // shore clearance
          const oceanCells = erodeMask(cellOcean(oMaskT, gwT, ghT), cw, ghT - 1, rings);
          const oc = countIn(oceanCells, span, cw);
          if (oc > 0) {
            const depthFlip = new Float32Array(gwT * ghT);
            for (let r = 0; r < ghT; r++) {
              for (let c = 0; c < gwT; c++) {
                depthFlip[(ghT - 1 - r) * gwT + c] = Math.max(0, -waterT[r * gwT + c]);
              }
            }
            const oceanCellsFlip = new Uint8Array(cw * (ghT - 1));
            for (let r = 0; r < ghT - 1; r++) {
              oceanCellsFlip.set(oceanCells.subarray(r * cw, (r + 1) * cw), (ghT - 2 - r) * cw);
            }
            const wsolid = buildSolid(depthFlip, gwT, ghT,
              { r0: ghT - 1 - span.r1, r1: ghT - 1 - span.r0, c0: span.c0, c1: span.c1 },
              oceanCellsFlip, { dx, dy, mmPerM, emin: 0, exag: s.exag, base: s.waterDrop });
            nw++;
            await add(`water_r${ry}_c${cx}`, wsolid, placeX(cx), belowY(ry, 0));
          }
        }

        // trail ribbon for this tile: prints flat (bottom = mating face at z=0),
        // top carries the residual relief; flexes into the groove as-printed
        if (wantPath && pathCells) {
          const pc = countIn(pathCells, span, cw);
          if (pc > 0) {
            const psolid = buildSolid(ribbon, gwT, ghT, span, pathCells,
              { dx, dy, mmPerM: 1, emin: 0, exag: 1, base: 0 });
            np++;
            await add(`path_r${ry}_c${cx}`, psolid, placeX(cx), belowY(ry, 1));
          }
        }

        // trail overlay for this tile: a conforming constant-thickness cord that
        // sits on the unmodified terrain — underside = terrain relief, top =
        // +pathHmm. Self-registers by its molded underside; prints with supports.
        if (wantOverlay && overlayCells) {
          const tc = countIn(overlayCells, span, cw);
          if (tc > 0) {
            const tsolid = buildTrailShell(grid, gwT, ghT, span, overlayCells,
              { dx, dy, mmPerM, emin, exag: s.exag }, s.pathHmm);
            nt++;
            await add(`trail_r${ry}_c${cx}`, tsolid, placeX(cx), belowY(ry, 1));
          }
        }
      }
    }

    if (writer.count === 0) { $("progress").textContent = "nothing to export (region empty?)"; return; }
    const water = (nw ? ` + ${nw} water insert${nw === 1 ? "" : "s"}` : "") +
      (np ? ` + ${np} trail ribbon${np === 1 ? "" : "s"}` : "") +
      (nt ? ` + ${nt} trail piece${nt === 1 ? "" : "s"}` : "");
    const trailNote =
      wantPath && np === 0 ? " — trail ribbon skipped: track is outside the region (or too narrow to print)" :
      wantOverlay && nt === 0 ? " — trail piece skipped: track is outside the region (or too narrow to print)" :
      "";
    const floorNote = nFloored
      ? ` — floored ${nFloored} deep sample${nFloored === 1 ? "" : "s"} to keep a ≥1 mm base`
      : "";
    $("progress").textContent = "packing 3MF…";
    await new Promise((r) => setTimeout(r, 0));
    const bytes = await writer.finish();
    download(new Blob([bytes], { type: "model/3mf" }), "tilejs_export.3mf");
    $("progress").textContent =
      `exported ${n} tile${n === 1 ? "" : "s"}${water} → tilejs_export.3mf ` +
      `(${(bytes.length / 1e6).toFixed(1)} MB, ${(tris / 1e6).toFixed(1)}M triangles, z${z}, ${printPitchMm(cLat, z, f.scale).toFixed(2)} mm/px)` +
      trailNote + floorNote;
  } catch (err) {
    $("progress").innerHTML = `<span class="warn">export failed: ${err.message}</span>`;
  } finally {
    btn.disabled = false;
  }
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// --- open on the default region with its terrain already previewed ----------
(function start() {
  const p = PRESETS.find((x) => x.name === DEFAULT_PRESET) || PRESETS[0];
  const poly = presetPolygon(p);
  map.setPolygon(poly);
  map.fitBbox(bboxOf(poly));
  preset.value = p.name;
  store.set({ polygon: poly, scaleAuto: true, scale: suggestScale(...extentOf(poly)) });
  loadPreview();
})();
