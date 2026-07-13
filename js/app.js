import { createStore } from "./state.js";
import { PRESETS, DEFAULT_PRESET } from "./presets.js";
import { initMap } from "./mapPicker.js";
import { bboxExtentMeters, suggestScale, PITCH_MM, fmtMmPerKm } from "./fit.js";
import { pickZoom, tileRangeForBBox, sourceZoom, globalXToLon, globalYToLat, printPitchMm } from "./tilemath.js";
import { fetchMosaic } from "./terrain.js";
import { resampleBilinear, gridRange, cropGrid } from "./resample.js";
import { cellsBbox, cellWindows, CELL_CAP,
  cellRingLatLon, footprintPx, footprintCellMaskPx, connectedToOrigin, pruneToOrigin,
  HEX_H } from "./tiles.js";
import { pointInPolygon } from "./polyclip.js";
import { buildPreviewSolid, buildSolid, buildTrailShell } from "./mesh.js";
import { oceanMask, oceanMaskSeeded, cellOcean, erodeMask, recessedGrid,
  offsetGrid } from "./water.js";
import { parseGPX, trackBbox } from "./gpx.js";
import { samplePath, rasterizePath, profileAlong, smoothProfile, stampOffset,
  stampInlay, ribbonGrid } from "./path.js";
import { ThreeMFWriter } from "./threeMF.js";

const store = createStore({
  shape: "square", // "square" | "hex" | "circle"
  center: null, // [lat, lon] of the origin cell, null until placed
  cells: [], // [[i,j],…]; [0,0] present whenever a layout exists
  scale: null, // 1:N
  tileWmm: 220, // print size of one tile (largest dimension); fits a Prusa Core One bed
  exag: 1.0,
  base: 6.0,
  waterDrop: 3, // ocean recess depth (mm); 0 = off
  waterSeparate: false, // print water as a separate insert
  tracks: [], // imported GPX files: [{ name, segs: [[[lat,lon],…],…] }]
  pathMode: "overlay", // overlay | bump | inset | inlay
  pathWmm: 1.6, // trail width on the print
  pathHmm: 0.6, // bump height / inset depth
  exportDetail: 2, // zoom-ladder slider index 0..3 (3 = source zoom)
});
const DEFAULT_SCALE = 500000; // 2 mm = 1 km — first freeform click before any preset

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

// count set cells inside a tile span, cw = cells per row
const countIn = (cells, sp, cw) => {
  let m = 0;
  for (let r = sp.r0; r < sp.r1; r++)
    for (let c = sp.c0; c < sp.c1; c++) m += cells[r * cw + c];
  return m;
};

// Ocean bake on any grid, given its ocean vertex mask. Plain mode recesses
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
  onPlace: ([lat, lon]) => {
    const s = store.get();
    if (s.cells.length) return; // layout exists; move via the marker
    store.set({ center: [lat, lon], cells: [[0, 0]], scale: s.scale ?? DEFAULT_SCALE });
  },
  onToggle: (cell, adding) => {
    const s = store.get();
    if (adding) {
      if (s.cells.length >= CELL_CAP) {
        $("progress").textContent = `cell cap: at most ${CELL_CAP} tiles per layout`;
        return;
      }
      store.set({ cells: [...s.cells, cell] });
    } else {
      if (cell[0] === 0 && cell[1] === 0) return; // origin holds the center
      const rest = s.cells.filter(([i, j]) => !(i === cell[0] && j === cell[1]));
      if (!connectedToOrigin(rest, s.shape)) {
        $("progress").textContent = "that tile bridges the layout — remove outer tiles first";
        return;
      }
      store.set({ cells: rest });
    }
  },
  onMove: (center) => store.set({ center }),
});

// --- presets ---------------------------------------------------------------
const preset = $("preset");
const groups = new Map();
for (const p of PRESETS) {
  // a center-less preset can't seed a layout — skip it so a partial bake can't kill load
  if (!p.center) {
    console.warn(`preset "${p.name}" has no center — skipping (unbaked entry?)`);
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
preset.addEventListener("change", () => {
  const p = PRESETS.find((x) => x.name === preset.value);
  if (!p) return;
  store.set({ center: p.center, scale: p.scale, cells: [[0, 0]] });
  map.fitBbox(cellsBbox(p.center, p.scale, store.get().tileWmm, [[0, 0]]));
});
$("clear").addEventListener("click", () => {
  preset.value = "";
  store.set({ center: null, cells: [], scale: null, tracks: [] });
  // drop the cached grid and orphan any in-flight fetch so a stale preview
  // can't outlive the layout it was fetched for
  pv = null; pvKey = null; loadToken++;
  preview?.setTiles([]);
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
  if (st.cells.length) {
    store.set({ tracks });
  } else {
    // no layout yet — seed one tile framing the tracks (~90% of the tile width)
    const bb = trackBbox(tracks.flatMap((t) => t.segs));
    const { realW, realH } = bboxExtentMeters(bb);
    const scale = suggestScale(realW, realH, 0.9 * st.tileWmm);
    const center = [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];
    store.set({ tracks, center, scale, cells: [[0, 0]] });
    map.fitBbox(bb);
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
$("shape").addEventListener("change", (e) => {
  const shape = e.target.value;
  const s = store.get();
  // circle is single-tile; other switches keep only cells the new adjacency
  // still connects to the origin
  const cells = !s.cells.length ? s.cells
    : shape === "circle" ? [[0, 0]]
    : pruneToOrigin(s.cells, shape);
  const dropped = s.cells.length - cells.length;
  if (dropped > 0) $("progress").textContent =
    `switched to ${shape} — removed ${dropped} tile${dropped === 1 ? "" : "s"} the new adjacency doesn't connect`;
  store.set({ shape, cells });
});
$("scale").addEventListener("input", (e) => {
  // guard the converted value: v<=0/NaN and exponent typos (2e400 -> scale 0,
  // 1e-320 -> scale Infinity) must not reach the store
  const scale = 1e6 / Number(e.target.value);
  if (Number.isFinite(scale) && scale > 0) store.set({ scale });
});
$("exag").addEventListener("input", (e) => store.set({ exag: Number(e.target.value) }));
$("base").addEventListener("input", (e) => store.set({ base: Number(e.target.value) }));
$("detail").addEventListener("input", (e) => store.set({ exportDetail: Number(e.target.value) }));
$("tileW").addEventListener("input", (e) => {
  const v = Number(e.target.value);
  if (Number.isFinite(v) && v >= 50) store.set({ tileWmm: v });
});
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
let pv = null; // { grid, waterGrid, gw, gh, f, mask, spans, masks } cached mosaic+resample; survives exag/base
let pvKey = null; // fit-affecting inputs; changing them invalidates pv

const keyOf = (s) => JSON.stringify([s.shape, s.center, s.cells, s.scale, s.tileWmm]);

// terrain auto-reloads (debounced) when the fetched-grid inputs change;
// exag/base/water only rebuild the mesh from the cached grid.
let reloadTimer = null;
let loadToken = 0;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(loadPreview, 500);
}

// --- render ----------------------------------------------------------------
let layoutKey = null;
store.subscribe((s) => {
  const lk = keyOf(s);
  // layout redraw only when its inputs change: a full layer teardown
  // mid-drag also silently kills the marker's drag in Leaflet
  if (lk !== layoutKey) { layoutKey = lk; map.setLayout(s); }
  renderTracks(s);
  // one bake per event, shared by the mass estimate and the tile rebuild
  const baked = pv && pvKey === lk ? bakedSurface(s, pv.grid, pv.gw, pv.gh, pv.f, pv.waterGrid) : null;
  renderSettings(s, baked);
  if (pvKey === null || lk !== pvKey) scheduleReload();
  else if (pv) rebuildTiles(baked);
});

// Slider readout: honest computed values for the chosen zoom-ladder step —
// pixel pitch on the print, triangle estimate, and projected .3mf size
// (~11 B/triangle deflated, measured on the King County export).
function detailLabel(s, f, di) {
  const cLat = (f.bbox[0] + f.bbox[2]) / 2;
  const zSrc = sourceZoom(f.bbox, cLat, f.scale, EXPORT_MAX_TILES);
  const z = Math.max(1, zSrc - (3 - di));
  const pitch = printPitchMm(cLat, z, f.scale);
  const tris = 2 * f.nCells * f.areaF * (s.tileWmm / pitch) ** 2;
  const mb = (tris * 11) / 1e6;
  const t = tris >= 1e6 ? `${(tris / 1e6).toFixed(1)}M` : `${Math.round(tris / 1e3)}K`;
  return `${pitch.toFixed(2)} mm/px · ~${t} tris · ~${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

// Derived layout constants — the old fit() collapses to this: per-tile print
// size is tileWmm by decree, count is |cells|, only ground size derives.
function layoutFit(s) {
  const bbox = cellsBbox(s.center, s.scale, s.tileWmm, s.cells, s.shape);
  const { realW, realH } = bboxExtentMeters(bbox);
  const widthMm = (realW * 1000) / s.scale, heightMm = (realH * 1000) / s.scale;
  return { bbox, realW, realH, scale: s.scale, widthMm, heightMm,
    tileWmm: s.tileWmm, nCells: s.cells.length,
    areaF: s.shape === "hex" ? (3 * Math.sqrt(3)) / 8 : s.shape === "circle" ? Math.PI / 4 : 1,
    groundM: Math.max(10, (PITCH_MM * s.scale) / 1000) };
}

function renderSettings(s, baked) {
  $("readout").textContent = !s.center ? "No tiles placed." :
    `${s.cells.length} tile${s.cells.length === 1 ? "" : "s"} · center ${s.center[0].toFixed(4)}, ${s.center[1].toFixed(4)}`;
  const box = $("settings");
  if (!s.center || !s.cells.length || !s.scale) { box.hidden = true; return; }
  box.hidden = false;
  $("shape").value = s.shape;
  if ($("scale") !== document.activeElement) $("scale").value = fmtMmPerKm(1e6 / s.scale);
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

  const f = layoutFit(s);
  const di = Math.min(3, Math.max(0, Math.round(s.exportDetail)));
  $("detail").value = di;
  $("detailVal").textContent = detailLabel(s, f, di);
  const tileKm = ((s.tileWmm * s.scale) / 1e6).toPrecision(2);
  $("tileKm").textContent = `Each tile ≈ ${tileKm} km wide.`;
  const m = estimateMassG(s, baked);
  const massLine = m
    ? `~${m.total.toFixed(0)} g @3% infill (~${m.perTile.toFixed(0)} g/tile)`
    : "— loading…";
  const chip = (label, val) => `<span><b>${label}</b> ${val}</span>`;
  $("fit").innerHTML =
    chip("scale", `${fmtMmPerKm(1e6 / f.scale)} mm = 1 km`) +
    chip("tile", `≈ ${tileKm} km`) +
    chip("tiles", `${f.nCells}${f.nCells > 16 ? ' <span class="warn">(a lot!)</span>' : ""}`) +
    chip("/tile", s.shape === "hex" ? `${s.tileWmm}×${Math.round(s.tileWmm * HEX_H)} mm hex`
      : s.shape === "circle" ? `⌀${s.tileWmm} mm` : `${s.tileWmm}×${s.tileWmm} mm`) +
    chip("sampling", `~${f.groundM.toFixed(1)} m`) +
    chip("material", massLine);
}

// PLA mass from the loaded terrain: solid volume (base + relief per cell) times
// density times the shell+infill factor. Uses the cached preview grid, so it's
// only available once terrain is loaded and still matches the current settings.
function estimateMassG(s, baked) {
  if (!pv || !baked || pvKey !== keyOf(s)) return null;
  const { gw, f } = pv;
  const { grid, min } = baked;
  const mmPerM = 1000 / f.scale;
  const cellArea = (f.widthMm / (gw - 1)) * (f.heightMm / (pv.gh - 1));
  let vol = 0; // mm³
  // per-cell spans; hex/circle print only their footprint stair mask
  pv.spans.forEach(({ r0, r1, c0, c1 }, idx) => {
    const fm = pv.masks ? pv.masks[idx] : null;
    for (let r = r0; r < r1; r++) {
      for (let c = c0; c < c1; c++) {
        if (fm && !fm[r * (gw - 1) + c]) continue;
        const avg = (grid[r * gw + c] + grid[r * gw + c + 1] +
          grid[(r + 1) * gw + c] + grid[(r + 1) * gw + c + 1]) / 4;
        vol += cellArea * (s.base + (avg - min) * mmPerM * s.exag);
      }
    }
  });
  const total = (vol / 1000) * PLA_DENSITY * MASS_FACTOR;
  return { total, perTile: total / pv.f.nCells };
}

// --- terrain fetch + preview (auto-triggered, debounced) ------------------
async function loadPreview() {
  clearTimeout(reloadTimer);
  const s = store.get();
  if (!s.center || !s.cells.length || !s.scale) return;
  const token = ++loadToken; // discard if a newer load starts before we commit
  const f = layoutFit(s);

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
    // per-cell spans on the preview grid: proportional index of each cell's
    // exact bbox inside the union bbox (preview has no lattice to quantize to).
    // Built from the fetch-start snapshot `s` — the token guard above already
    // dropped any superseded load, so s/f are what this grid was fetched for.
    const [uS, uW, uN, uE] = f.bbox;
    const spans = s.cells.map((cell) => {
      // shape-aware footprint bbox: hex cells sit on the axial lattice, not the
      // square grid (single-cell cellsBbox === cellBbox for squares)
      const [cs, cw2, cn, ce] = cellsBbox(s.center, s.scale, s.tileWmm, [cell], s.shape);
      return { cell,
        c0: Math.round(((cw2 - uW) / (uE - uW)) * (gw - 1)),
        c1: Math.round(((ce - uW) / (uE - uW)) * (gw - 1)),
        r0: Math.round(((uN - cn) / (uN - uS)) * (gh - 1)),
        r1: Math.round(((uN - cs) / (uN - uS)) * (gh - 1)) };
    });
    const mask = new Uint8Array((gw - 1) * (gh - 1)).fill(1);
    // per-cell footprint stair masks at preview resolution (square: all-ones).
    // Scoped to each cell's own span — cellMask over the whole grid was
    // O(cells × grid) and stalled large hex layouts.
    const masks = s.shape === "square" ? null : s.cells.map((cell, idx) => {
      const ring = cellRingLatLon(s.center, s.scale, s.tileWmm, cell, s.shape);
      const m = new Uint8Array((gw - 1) * (gh - 1));
      const sp = spans[idx];
      const r0 = Math.max(0, sp.r0 - 1), r1 = Math.min(gh - 2, sp.r1);
      const c0 = Math.max(0, sp.c0 - 1), c1 = Math.min(gw - 2, sp.c1);
      for (let r = r0; r <= r1; r++) {
        const lat = uN - ((uN - uS) * (r + 0.5)) / (gh - 1);
        for (let c = c0; c <= c1; c++) {
          const lon = uW + ((uE - uW) * (c + 0.5)) / (gw - 1);
          m[r * (gw - 1) + c] = pointInPolygon([lat, lon], ring) ? 1 : 0;
        }
      }
      return m;
    });
    pv = { grid, waterGrid, gw, gh, f, mask, spans, masks };
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
  const gapX = 0.14 * f.tileWmm, gapY = 0.14 * f.tileWmm;

  const tiles = [];
  pv.spans.forEach((sp, idx) => {
    // explode offsets scale with the shape's unit center position
    const [ci, cj] = sp.cell;
    const [ux, uy] = s.shape === "hex"
      ? [ci * 0.75, -(2 * cj + ci) * (Math.sqrt(3) / 4)]
      : [ci, -cj]; // square & circle
    tiles.push(buildPreviewSolid(grid, gw, gh, sp, pv.masks ? pv.masks[idx] : mask, {
      dx, dy, offX: ux * gapX, offY: uy * gapY, oceanMask: oMask, pathMask,
      mmPerM, emin: min, erange, exag: s.exag, base: s.base,
    }));
  });
  preview.setTiles(tiles);
}

// --- 3MF export --------------------------------------------------------------
// Fetches terrain at the export zoom and meshes every selected cell at full
// grid density over the shared lattice; no region clip.

async function export3MF() {
  const s = store.get();
  if (!s.cells.length || !s.scale) { $("progress").textContent = "place a tile first"; return; }
  const btn = $("export");
  btn.disabled = true;
  try {
    const f = layoutFit(s);
    const [latS, lonW, latN, lonE] = f.bbox;
    const cLat = (latS + latN) / 2;
    const zSrc = sourceZoom(f.bbox, cLat, s.scale, EXPORT_MAX_TILES);
    const di = Math.min(3, Math.max(0, Math.round(s.exportDetail)));
    const z = Math.max(1, zSrc - (3 - di));
    // shared lattice: every cell's window quantizes to the same global pixel
    // grid, adjacent cells share their edge pixel index — seams read identical data
    const { spanPx, wins, union } = cellWindows(s.center, s.scale, s.tileWmm, s.cells, z, s.shape);
    const dx = s.tileWmm / spanPx, dy = dx; // Mercator is conformal: square cells
    const mmPerM = 1000 / s.scale;
    const k = mmPerM * s.exag;
    const lonAt = (gx) => globalXToLon(gx + 0.5, z);
    const latAt = (gy) => globalYToLat(gy + 0.5, z);
    // union-window mm frame anchors the trail/context passes; window origins
    // are integer pixels of the same lattice, so offsets are exact multiples of dx
    const uniW = (union.gw - 1) * dx, uniH = (union.gh - 1) * dy;
    const uniBbox = [latAt(union.gy0 + union.gh - 1), lonAt(union.gx0),
      latAt(union.gy0), lonAt(union.gx0 + union.gw - 1)];

    // --- context pass: one small whole-region grid for everything the tiles
    // must agree on globally — ocean connectivity (seed source for the per-tile
    // floods), the trail profile / mating curve, and the shared z-frame min.
    let gwC = Math.round(uniW / PITCH_MM) + 1;
    let ghC = Math.round(uniH / PITCH_MM) + 1;
    const capC = Math.max(gwC, ghC);
    if (capC > EXPORT_COARSE_DIM) {
      gwC = Math.max(2, Math.round((gwC * EXPORT_COARSE_DIM) / capC));
      ghC = Math.max(2, Math.round((ghC * EXPORT_COARSE_DIM) / capC));
    }
    const { z: zC } = pickZoom(Math.max(f.groundM, f.realW / (gwC - 1)), cLat);
    const rangeC = tileRangeForBBox(uniBbox, zC);
    if (rangeC.count > EXPORT_MAX_TILES) {
      throw new Error(`${rangeC.count} tiles at z${zC} — coarsen the scale to export`);
    }
    $("progress").textContent = `context pass (z${zC}, ${rangeC.count} tiles)…`;
    const mosaicC = await fetchMosaic(uniBbox, zC, {
      onProgress: (d, t) => { $("progress").textContent = `context pass: fetching ${d}/${t}…`; },
    });
    const rawC = resampleBilinear(mosaicC, uniBbox, gwC, ghC);
    // water reads from a coarser mosaic when zC is finer than bathymetry-valid;
    // reuse mosaicC (no extra fetch) when it's already coarse enough
    const zW = Math.min(zC, WATER_ZOOM_MAX);
    let mosaicWater = mosaicC;
    if (s.waterDrop > 0 && zW !== zC) {
      $("progress").textContent = `water pass (z${zW})…`;
      mosaicWater = await fetchMosaic(uniBbox, zW, {});
    }
    const rawWC = mosaicWater === mosaicC ? rawC
      : resampleBilinear(mosaicWater, uniBbox, gwC, ghC);
    const oMaskC = s.waterDrop > 0 ? oceanMask(rawWC, gwC, ghC, 0) : null;
    const gridC = bakeWater(s, rawC, oMaskC, k);
    // trail sampled at the FINE pitch (elevations off the coarse grid): the
    // per-tile rasterization needs sample spacing ≤ halfW to stay gap-free
    const trail = trailContext(s, gridC, gwC, ghC,
      { bbox: uniBbox, widthMm: uniW, heightMm: uniH, scale: s.scale }, Math.max(dx, dy));
    // shared z-frame min: bake the trail onto the coarse context grid exactly as
    // the tiles will, then take its true minimum. This captures the inlay groove
    // floor / inset cut / bump in every mode — no per-mode analytic patches, and
    // no case (water-insert shoreline) left unbounded. Fine-tile vertices that
    // dip below this coarse min are floored per-tile (Step 4).
    let stampedC = gridC;
    if (trail) {
      const dxC = uniW / (gwC - 1), dyC = uniH / (ghC - 1);
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
    const gapX = 0.14 * s.tileWmm, gapY = 0.14 * s.tileWmm;
    // unit center positions in print mm (before normalization): hex axial
    // packs at (0.75q, (2r+q)·√3/4) tile-pitches; square/circle on the unit grid
    const pitchX = s.tileWmm + gapX, pitchY = s.tileWmm + gapY;
    const posOf = ([i2, j2]) => s.shape === "hex"
      ? [i2 * 0.75 * pitchX, -(2 * j2 + i2) * (Math.sqrt(3) / 4) * pitchY]
      : [i2 * pitchX, -j2 * pitchY];
    const posAll = s.cells.map(posOf);
    const minPX = Math.min(...posAll.map((p) => p[0]));
    const maxPY = Math.max(...posAll.map((p) => p[1]));
    const minPY = Math.min(...posAll.map((p) => p[1]));
    // normalize to the layout's NW cell: negative build-plate coordinates are
    // 3MF-legal but trip "outside bed" warnings in slicers
    const placeAt = (cell2) => { const [x, y] = posOf(cell2); return [x - minPX, y - maxPY]; };
    // separate pieces sit in mirrored blocks below the whole layout
    const layoutSpanY = maxPY - minPY + pitchY;
    const belowAt = (cell2, block) => {
      const [x, y] = placeAt(cell2);
      return [x, y - layoutSpanY * (block + 1)];
    };
    let tris = 0;
    const add = async (name, solid, x, y) => {
      tris += solid.indices.length / 3;
      await writer.addObject(name, solid, x, y);
      await new Promise((r) => setTimeout(r, 0)); // let progress paint
    };
    let n = 0, nw = 0, np = 0, nt = 0, ti = 0, nFloored = 0;
    const nTiles = f.nCells;
    for (const cell of s.cells) {
      const [ci, cj] = cell;
      const win = wins.get(`${ci},${cj}`);
      const label = `tile ${++ti}/${nTiles}`;
      // padded window: erosion (water/trail clearance) must see past the seam
      const pr0 = win.gy0 - pad, pr1 = win.gy0 + win.gh - 1 + pad;
      const pc0 = win.gx0 - pad, pc1 = win.gx0 + win.gw - 1 + pad;
      const gwT = pc1 - pc0 + 1, ghT = pr1 - pr0 + 1;
      const tb = [latAt(pr1), lonAt(pc0), latAt(pr0), lonAt(pc1)]; // window bbox [S,W,N,E]
      const span = { r0: win.gy0 - pr0, r1: win.gy0 + win.gh - 1 - pr0,
        c0: win.gx0 - pc0, c1: win.gx0 + win.gw - 1 - pc0 };
      const cw = gwT - 1;
      let mask;
      if (s.shape === "square") {
        mask = new Uint8Array(cw * (ghT - 1)).fill(1); // full footprint
      } else {
        // stair mask decided in global px: deterministic across tiles
        mask = footprintCellMaskPx(
          footprintPx(s.center, s.scale, s.tileWmm, cell, z, s.shape),
          gwT, ghT, pc0, pr0);
      }

      // defense-in-depth: zSrc's sourceZoom() call already clamps the whole
      // union bbox to EXPORT_MAX_TILES at z <= zSrc, so this one cell's window
      // can only exceed it if erosion padding pushes it into one extra row/col
      const range = tileRangeForBBox(tb, z);
      if (range.count > EXPORT_MAX_TILES) {
        throw new Error(`${label}: ${range.count} tiles at z${z} — coarsen the scale to export`);
      }
      $("progress").textContent = `${label}: fetching (z${z}, ${range.count} tiles)…`;
      const mosaic = await fetchMosaic(tb, z, {
        onProgress: (d, t) => { $("progress").textContent = `${label}: fetching ${d}/${t}…`; },
      });
      const rawT = cropGrid(mosaic, { gx0: pc0, gy0: pr0, gw: gwT, gh: ghT });
      $("progress").textContent = `${label}: meshing…`;
      await new Promise((r) => setTimeout(r, 0)); // let the message paint

      // ocean: flood the bathymetry view of this window from coarse-mask
      // seeds (edge-connectivity is global; the geometry grid has no valid
      // water signal at z>WATER_ZOOM_MAX)
      let oMaskT = null, waterT = null;
      if (s.waterDrop > 0) {
        waterT = resampleBilinear(mosaicWater, tb, gwT, ghT);
        const seeds = new Uint8Array(gwT * ghT);
        // padded windows poke past the union edge — clamp the coarse lookup
        const ccMap = new Int32Array(gwT);
        for (let c = 0; c < gwT; c++)
          ccMap[c] = Math.round(((pc0 + c - union.gx0) / (union.gw - 1)) * (gwC - 1));
        for (let r = 0; r < ghT; r++) {
          const rc = Math.max(0, Math.min(ghC - 1,
            Math.round(((pr0 + r - union.gy0) / (union.gh - 1)) * (ghC - 1))));
          for (let c = 0; c < gwT; c++) {
            seeds[r * gwT + c] = oMaskC[rc * gwC + Math.max(0, Math.min(gwC - 1, ccMap[c]))];
          }
        }
        oMaskT = oceanMaskSeeded(waterT, gwT, ghT, seeds);
      }
      let grid = bakeWater(s, rawT, oMaskT, k);

      // trail: same global context, rasterized in this window's local frame so
      // the groove floor and ribbon heights are seam-continuous by construction
      let ribbon = null, pathCells = null, overlayCells = null;
      if (trail) {
        const offX = (pc0 - union.gx0) * dx, offY = (union.gy0 + union.gh - 1 - pr1) * dy;
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

      const solid = buildSolid(grid, gwT, ghT, span, mask,
        { dx, dy, mmPerM, emin, exag: s.exag, base: s.base });
      n++;
      await add(`tile_i${ci}_j${cj}`, solid, ...placeAt(cell));

      // water insert for this tile: printed top follows the ocean floor
      // (depth·scale above the drop), flat face at z=0 is the sea surface;
      // prints flat face down, flips north-south into the recess, so its
      // depth grid and cell mask are built row-mirrored within the window
      if (wantWater && oMaskT) {
        const rings = Math.max(1, Math.ceil(WATER_CLEAR_MM / dx)); // shore clearance
        const oceanCells = erodeMask(cellOcean(oMaskT, gwT, ghT), cw, ghT - 1, rings);
        if (s.shape !== "square") for (let i2 = 0; i2 < oceanCells.length; i2++) oceanCells[i2] &= mask[i2];
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
          await add(`water_i${ci}_j${cj}`, wsolid, ...belowAt(cell, 0));
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
          await add(`path_i${ci}_j${cj}`, psolid, ...belowAt(cell, 1));
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
          await add(`trail_i${ci}_j${cj}`, tsolid, ...belowAt(cell, 1));
        }
      }
    }

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

// --- open on the default preset with its terrain already previewed ----------
(function start() {
  const p = PRESETS.find((x) => x.name === DEFAULT_PRESET) || PRESETS[0];
  preset.value = p.name;
  store.set({ center: p.center, scale: p.scale, cells: [[0, 0]] });
  map.fitBbox(cellsBbox(p.center, p.scale, store.get().tileWmm, [[0, 0]]));
  loadPreview();
})();
