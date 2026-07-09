import { createStore } from "./state.js";
import { PRESETS, DEFAULT_PRESET, bboxToPolygon } from "./presets.js";
import { initMap } from "./mapPicker.js";
import { fit, bboxOf, bboxExtentMeters, suggestScale, splits, PITCH_MM } from "./fit.js";
import { pickZoom, tileRangeForBBox } from "./tilemath.js";
import { fetchMosaic } from "./terrain.js";
import { resampleBilinear, gridRange } from "./resample.js";
import { cellMask } from "./polyclip.js";
import { buildPreviewSolid, buildSolid, buildSolidTIN, buildSolidFromMesh } from "./mesh.js";
import { decimate } from "./decimate.js";
import { clipTriangleToPolygon } from "./clip.js";
import { oceanMask, oceanMaskSeeded, cellOcean, erodeMask, recessedGrid,
  offsetGrid } from "./water.js";
import { parseGPX, trackBbox } from "./gpx.js";
import { samplePath, rasterizePath, profileAlong, smoothProfile, stampOffset,
  stampInlay, ribbonGrid } from "./path.js";
import { encodeBinarySTL, checkWatertight } from "./stl.js";
import { crc32, buildZip } from "./zip.js";

const store = createStore({
  polygon: null, // [[lat,lon],…] or null
  scale: null, // 1:N
  scaleAuto: true,
  exag: 1.0,
  base: 3.0,
  capW: 250,
  capH: 250,
  waterDrop: 3, // ocean recess depth (mm); 0 = off
  waterSeparate: false, // print water as a separate insert
  tracks: [], // imported GPX files: [{ name, segs: [[[lat,lon],…],…] }]
  pathMode: "bump", // bump | inset | inlay
  pathWmm: 1.6, // trail width on the print
  pathHmm: 0.6, // bump height / inset depth
});

// inlay-ribbon geometry: mating groove depth, how far the seated ribbon stands
// above the terrain, and XY clearance eroded off the ribbon footprint
const GROOVE_MM = 0.8;
const PROUD_MM = 0.6;
const PATH_CLEAR_MM = 0.15;

// minimum printed base wall: ≥3 layers at any common layer height (0.1–0.3 mm).
// tilejs can't read the slicer's layer height, so this is a fixed floor.
const MIN_WALL_MM = 1.0;

const PLA_DENSITY = 1.24; // g/cm³
// fraction of the solid envelope actually deposited: walls + 3% infill.
// Calibrated to a real slice (Rainier tile: 849 cm³ solid -> 145 g at 3%/0.15mm).
const MASS_FACTOR = 0.138;

const $ = (id) => document.getElementById(id);
const extentOf = (poly) => {
  const { realW, realH } = bboxExtentMeters(bboxOf(poly));
  return [realW, realH];
};

// Ocean bake on any grid, given its ocean vertex mask. Plain mode flattens
// open ocean to one sunken plane; insert mode keeps the ocean-floor relief,
// lowered by the drop (exag-corrected so the print-z drop is exactly waterDrop).
function bakeWater(s, rawGrid, oMask, k) {
  if (!oMask) return rawGrid;
  return s.waterSeparate
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
function bakedSurface(s, rawGrid, gw, gh, f) {
  const k = (1000 / f.scale) * s.exag; // print mm per grid unit
  const oMask = s.waterDrop > 0 ? oceanMask(rawGrid, gw, gh, 0) : null; // sea level = 0
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
$("export").addEventListener("click", exportSTLs);

// --- preview state ---------------------------------------------------------
let preview = null; // three.js view, lazily created
let pv = null; // { grid, gw, gh, f } cached mosaic+resample; survives exag/base
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
  const baked = pv && pvKey === keyOf(s) ? bakedSurface(s, pv.grid, pv.gw, pv.gh, pv.f) : null;
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

function renderSettings(s, baked) {
  const box = $("settings");
  if (!s.polygon || s.polygon.length < 3 || !s.scale) { box.hidden = true; return; }
  box.hidden = false;
  if ($("scale") !== document.activeElement) $("scale").value = Math.round(s.scale);
  $("exagVal").textContent = s.exag.toFixed(1);
  $("baseVal").textContent = s.base.toFixed(1);
  $("waterDropVal").textContent = s.waterDrop.toFixed(1);
  if ($("waterDrop") !== document.activeElement) $("waterDrop").value = s.waterDrop;
  $("waterOpts").hidden = s.waterDrop <= 0;
  $("waterSeparate").checked = s.waterSeparate;

  $("trailOpts").hidden = !s.tracks.length;
  if (s.tracks.length) {
    $("pathMode").value = s.pathMode;
    $("pathWVal").textContent = s.pathWmm.toFixed(1);
    if ($("pathW") !== document.activeElement) $("pathW").value = s.pathWmm;
    $("pathHRow").hidden = s.pathMode === "inlay";
    $("inlayHint").hidden = s.pathMode !== "inlay";
    $("pathHName").textContent = s.pathMode === "inset" ? "Inset depth" : "Bump height";
    $("pathHVal").textContent = s.pathHmm.toFixed(1);
    if ($("pathH") !== document.activeElement) $("pathH").value = s.pathHmm;
  }

  const f = fit({ polygon: s.polygon, scale: s.scale, capW: s.capW, capH: s.capH });
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

  $("progress").textContent = "fetching elevation…";
  try {
    const mosaic = await fetchMosaic(f.bbox, z, {
      onProgress: (d, t) => { if (token === loadToken) $("progress").textContent = `fetching tiles ${d}/${t}…`; },
    });
    if (token !== loadToken) return; // a newer load supersedes this one
    const grid = resampleBilinear(mosaic, f.bbox, gw, gh);
    // use the fetch-start snapshot, not post-await store state: a Clear mid-fetch
    // makes store.polygon null (cellMask throws), and a polygon edit would stamp
    // this now-stale grid as fresh. The token guard above already dropped any
    // superseded load, so s/f are the inputs this grid was actually fetched for.
    const mask = cellMask(s.polygon, f.bbox, gw, gh);
    pv = { grid, gw, gh, f, mask };
    pvKey = keyOf(s);
    $("progress").textContent = upsampled
      ? `z${z} — note: sampling finer than the data supports (interpolated)`
      : `z${z} — ${(mosaic.width / 256) * (mosaic.height / 256)} tiles loaded`;
    if (!preview) {
      const mod = await import("./preview.js");
      preview = mod.initPreview($("preview"));
    }
    preview.resize();
    const baked = bakedSurface(store.get(), grid, gw, gh, f);
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

// --- STL export ------------------------------------------------------------
// Fetches high-detail terrain, resamples to an anisotropic grid, and per tile
// either decimates (fully-covered tiles -> adaptive TIN, tiny files) or falls
// back to the uniform stair-clip solid (polygon-clipped edge tiles).
const EXPORT_TILE_DIM = 2048; // per-tile grid cap (decimation time / memory bound)
const EXPORT_COARSE_DIM = 1200; // whole-region context grid (ocean seeds, trail, z-frame)
const EXPORT_MAX_TILES = 120; // terrarium-fetch guard (context pass and each tile)
const EXPORT_ERR_MM = 0.05; // TIN vertical error tolerance (fine)

// Adaptive-decimated + polygon-clipped solid for one edge tile. Decimates the
// tile's rectangular grid, maps the region ring into the tile-local mm frame
// (same as buildSolidTIN), clips each TIN facet to it, and assembles a
// watertight solid with a smooth polygon-following boundary. Returns null on any
// failure (degenerate clip / non-closing solid) so the caller falls back to the
// uniform stair-clip and export never breaks.
function clipTileSolid(grid, gw, gh, span, polygon, geom) {
  const { r0, r1, c0, c1 } = span;
  const { dx, dy, mmPerM, emin, exag, base, bbox: [s, w, n, e], widthMm, heightMm, maxErr } = geom;
  try {
    const gwt = c1 - c0 + 1, ght = r1 - r0 + 1;
    const zt = new Float32Array(gwt * ght);
    for (let r = 0; r < ght; r++)
      for (let c = 0; c < gwt; c++)
        zt[r * gwt + c] = (grid[(r0 + r) * gw + (c0 + c)] - emin) * mmPerM * exag;
    const { coords, triangles } = decimate(zt, gwt, ght, maxErr);

    const vx = (vi) => coords[2 * vi] * dx;
    const vy = (vi) => (ght - 1 - coords[2 * vi + 1]) * dy;
    const vz = (vi) => base + zt[coords[2 * vi + 1] * gwt + coords[2 * vi]];
    const poly = polygon.map(([lat, lon]) => [
      ((lon - w) / (e - w)) * widthMm - c0 * dx,
      r1 * dy - ((n - lat) / (n - s)) * heightMm,
    ]);

    const top = [];
    for (let i = 0; i < triangles.length; i += 3) {
      const a = triangles[i], b = triangles[i + 1], c = triangles[i + 2];
      const tri = [[vx(a), vy(a), vz(a)], [vx(b), vy(b), vz(b)], [vx(c), vy(c), vz(c)]];
      for (const v of clipTriangleToPolygon(tri, poly)) top.push(v);
    }
    if (!top.length) return null;
    const solid = buildSolidFromMesh(top);
    return checkWatertight(solid).closed ? solid : null;
  } catch {
    return null;
  }
}

async function exportSTLs() {
  const s = store.get();
  if (!s.polygon || !s.scale) { $("progress").textContent = "pick a region first"; return; }
  const f = fit({ polygon: s.polygon, scale: s.scale, capW: s.capW, capH: s.capH });
  const [latS, lonW, latN, lonE] = f.bbox;
  const cLat = (latS + latN) / 2;
  const maxErr = EXPORT_ERR_MM;
  const btn = $("export");
  btn.disabled = true;
  try {
    // fine virtual lattice at the fit pitch (data-posting floor included). It is
    // never materialized whole: each print tile fetches and meshes only its own
    // padded window, so memory stays flat however large the print is. If a tile
    // span would exceed EXPORT_TILE_DIM, the whole lattice scales down together
    // (per-tile decimation time is the binding cost, not total print size).
    let gwF = Math.round(f.widthMm / f.pitchMm) + 1;
    let ghF = Math.round(f.heightMm / f.pitchMm) + 1;
    let rows = splits(f.ny, ghF), cols = splits(f.nx, gwF);
    const spanMax = (sp) => Math.max(...sp.map(([a, b]) => b - a + 1));
    const maxSpan = Math.max(spanMax(rows), spanMax(cols));
    if (maxSpan > EXPORT_TILE_DIM) {
      gwF = Math.max(2, Math.round((gwF * EXPORT_TILE_DIM) / maxSpan));
      ghF = Math.max(2, Math.round((ghF * EXPORT_TILE_DIM) / maxSpan));
      rows = splits(f.ny, ghF);
      cols = splits(f.nx, gwF);
    }
    const dx = f.widthMm / (gwF - 1), dy = f.heightMm / (ghF - 1);
    const mmPerM = 1000 / f.scale;
    const k = mmPerM * s.exag;
    // one zoom for every tile so neighbors read identical data at their seam
    const { z } = pickZoom(Math.max(f.groundM, f.realW / (gwF - 1)), cLat);
    const lonAt = (ci) => lonW + (ci / (gwF - 1)) * (lonE - lonW);
    const latAt = (ri) => latN - (ri / (ghF - 1)) * (latN - latS); // row 0 = north

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
    const oMaskC = s.waterDrop > 0 ? oceanMask(rawC, gwC, ghC, 0) : null;
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
    const pad = Math.max(3, Math.ceil(0.4 / dx) + 1);
    const wantWater = s.waterDrop >= 1 && s.waterSeparate;
    const wantPath = trail && s.pathMode === "inlay";

    // deflate-as-we-go: each STL is compressed into a zip entry the moment it is
    // built and its raw bytes released, so peak heap is ~sum(deflated) + one raw
    // buffer — not the full raw total. `firstRaw` is kept only until a 2nd file
    // arrives, so a single-file export can still download the bare STL.
    const entries = [];
    let firstRaw = null;
    const addFile = async (name, buf) => {
      firstRaw = entries.length === 0 ? { name, bytes: buf } : null;
      let data = buf, method = 0;
      if (typeof CompressionStream !== "undefined") {
        try { data = await deflateRaw(buf); method = 8; } catch { data = buf; method = 0; }
      }
      entries.push({ name, data, crc: crc32(buf), size: buf.length, method });
    };
    let bytes = 0, n = 0, nw = 0, np = 0, pathCellTotal = 0, ti = 0, nFloored = 0;
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
        let covered = 0, total = 0;
        for (let r = span.r0; r < span.r1; r++) {
          for (let c = span.c0; c < span.c1; c++) { total++; covered += mask[r * cw + c]; }
        }
        if (covered === 0) continue;

        const range = tileRangeForBBox(tb, z);
        if (range.count > EXPORT_MAX_TILES) {
          throw new Error(`${label}: ${range.count} tiles at z${z} — coarsen the scale to export`);
        }
        $("progress").textContent = `${label}: fetching (z${z}, ${range.count} tiles)…`;
        const mosaic = await fetchMosaic(tb, z, {
          onProgress: (d, t) => { $("progress").textContent = `${label}: fetching ${d}/${t}…`; },
        });
        const rawT = resampleBilinear(mosaic, tb, gwT, ghT);
        $("progress").textContent = `${label}: meshing…`;
        await new Promise((r) => setTimeout(r, 0)); // let the message paint

        // ocean: flood this window from coarse-mask seeds (edge-connectivity is
        // global; flooding from the window frame would misclassify basins)
        let oMaskT = null;
        if (s.waterDrop > 0) {
          const seeds = new Uint8Array(gwT * ghT);
          for (let r = 0; r < ghT; r++) {
            const rc = Math.round(((pr0 + r) / (ghF - 1)) * (ghC - 1));
            for (let c = 0; c < gwT; c++) {
              const cc = Math.round(((pc0 + c) / (gwF - 1)) * (gwC - 1));
              seeds[r * gwT + c] = oMaskC[rc * gwC + cc];
            }
          }
          oMaskT = oceanMaskSeeded(rawT, gwT, ghT, seeds);
        }
        let grid = bakeWater(s, rawT, oMaskT, k);

        // trail: same global context, rasterized in this window's local frame so
        // the groove floor and ribbon heights are seam-continuous by construction
        let ribbon = null, pathCells = null;
        if (trail) {
          const offX = pc0 * dx, offY = (ghF - 1 - pr1) * dy;
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
          const { mask: pm, sIdx, inner } = rasterizePath(ptsT, gwT, ghT, dx, dy, grooveHalfW, ribbonHalfW);
          ({ grid, ribbon } = stampTrail(s, grid, trail, pm, sIdx));
          if (wantPath) {
            pathCells = cellOcean(inner, gwT, ghT); // clearance already applied
            for (let i = 0; i < pathCells.length; i++) pathCells[i] &= mask[i];
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

        // terrain solid
        let solid;
        if (covered === total) {
          // fully covered -> adaptive decimation
          const gwt = span.c1 - span.c0 + 1, ght = span.r1 - span.r0 + 1;
          const zt = new Float32Array(gwt * ght);
          for (let r = 0; r < ght; r++) {
            for (let c = 0; c < gwt; c++) {
              zt[r * gwt + c] = (grid[(span.r0 + r) * gwT + (span.c0 + c)] - emin) * k;
            }
          }
          const { coords, triangles } = decimate(zt, gwt, ght, maxErr);
          solid = buildSolidTIN(zt, gwt, ght, coords, triangles, dx, dy, s.base);
        } else {
          // clipped edge tile -> adaptive decimation + smooth polygon clip,
          // falling back to the uniform stair-clip if the clip can't close.
          // geom is window-local: clipTileSolid's polygon mapping is
          // self-consistent in any frame whose bbox/dims match the grid.
          const geom = { dx, dy, mmPerM, emin, exag: s.exag, base: s.base,
            bbox: tb, widthMm: (gwT - 1) * dx, heightMm: (ghT - 1) * dy, maxErr };
          solid = clipTileSolid(grid, gwT, ghT, span, s.polygon, geom)
            || buildSolid(grid, gwT, ghT, span, mask,
              { dx, dy, mmPerM, emin, exag: s.exag, base: s.base });
        }
        const buf = new Uint8Array(encodeBinarySTL(solid));
        bytes += buf.length;
        n++;
        await addFile(`tile_r${ry}_c${cx}.stl`, buf);
        await new Promise((r) => setTimeout(r, 0));

        // water insert for this tile: printed top follows the ocean floor
        // (depth·scale above the drop), flat face at z=0 is the sea surface;
        // prints flat face down, flips north-south into the recess, so its
        // depth grid and cell mask are built row-mirrored within the window
        if (wantWater && oMaskT) {
          const rings = Math.max(1, Math.ceil(0.4 / dx)); // ~0.4 mm side clearance
          const oceanCells = erodeMask(cellOcean(oMaskT, gwT, ghT), cw, ghT - 1, rings);
          let oc = 0;
          for (let r = span.r0; r < span.r1; r++) {
            for (let c = span.c0; c < span.c1; c++) oc += oceanCells[r * cw + c];
          }
          if (oc > 0) {
            const depthFlip = new Float32Array(gwT * ghT);
            for (let r = 0; r < ghT; r++) {
              for (let c = 0; c < gwT; c++) {
                depthFlip[(ghT - 1 - r) * gwT + c] = Math.max(0, -rawT[r * gwT + c]);
              }
            }
            const oceanCellsFlip = new Uint8Array(cw * (ghT - 1));
            for (let r = 0; r < ghT - 1; r++) {
              oceanCellsFlip.set(oceanCells.subarray(r * cw, (r + 1) * cw), (ghT - 2 - r) * cw);
            }
            const wsolid = buildSolid(depthFlip, gwT, ghT,
              { r0: ghT - 1 - span.r1, r1: ghT - 1 - span.r0, c0: span.c0, c1: span.c1 },
              oceanCellsFlip, { dx, dy, mmPerM, emin: 0, exag: s.exag, base: s.waterDrop });
            const wbuf = new Uint8Array(encodeBinarySTL(wsolid));
            bytes += wbuf.length;
            nw++;
            await addFile(`water_r${ry}_c${cx}.stl`, wbuf);
          }
        }

        // trail ribbon for this tile: prints flat (bottom = mating face at z=0),
        // top carries the residual relief; flexes into the groove as-printed
        if (wantPath && pathCells) {
          let pc = 0;
          for (let r = span.r0; r < span.r1; r++) {
            for (let c = span.c0; c < span.c1; c++) pc += pathCells[r * cw + c];
          }
          pathCellTotal += pc;
          if (pc > 0) {
            const psolid = buildSolid(ribbon, gwT, ghT, span, pathCells,
              { dx, dy, mmPerM: 1, emin: 0, exag: 1, base: 0 });
            const pbuf = new Uint8Array(encodeBinarySTL(psolid));
            bytes += pbuf.length;
            np++;
            await addFile(`path_r${ry}_c${cx}.stl`, pbuf);
          }
        }
      }
    }

    if (!entries.length) { $("progress").textContent = "nothing to export (region empty?)"; return; }
    const water = (nw ? ` + ${nw} water insert${nw === 1 ? "" : "s"}` : "") +
      (np ? ` + ${np} trail ribbon${np === 1 ? "" : "s"}` : "");
    const trailNote = wantPath && pathCellTotal === 0
      ? " — trail ribbon skipped: track is outside the region (or too narrow to print)"
      : "";
    const floorNote = nFloored
      ? ` — floored ${nFloored} deep sample${nFloored === 1 ? "" : "s"} to keep a ≥1 mm base`
      : "";
    if (entries.length === 1) {
      download(new Blob([firstRaw.bytes], { type: "model/stl" }), firstRaw.name);
      $("progress").textContent =
        `exported ${firstRaw.name} — ${(bytes / 1e6).toFixed(1)} MB (z${z}, ≤${maxErr} mm)` + trailNote + floorNote;
    } else {
      $("progress").textContent = "zipping…";
      await new Promise((r) => setTimeout(r, 0));
      const zip = buildZip(entries); // entries are already deflated
      download(new Blob([zip], { type: "application/zip" }), "tilejs_export.zip");
      $("progress").textContent =
        `exported ${n} tile${n === 1 ? "" : "s"}${water} → tilejs_export.zip ` +
        `(${(zip.length / 1e6).toFixed(1)} MB zip, ${(bytes / 1e6).toFixed(0)} MB raw)` + trailNote + floorNote;
    }
  } catch (err) {
    $("progress").innerHTML = `<span class="warn">export failed: ${err.message}</span>`;
  } finally {
    btn.disabled = false;
  }
}

// deflate one buffer with the browser's native raw-deflate (ZIP method 8)
async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
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
