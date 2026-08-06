// Headless bake + export orchestration: (tile settings) → source zoom +
// Mercator pixel window + print geom → elevation grid → watertight solid →
// validated .3mf. This is the "library" surface a thin UI drives. Single tile
// (square, hex or circle), monochrome — color/multi-tile arrive in later features.
import { cellsBbox, cellWindows, footprintPx } from "./layout.js";
import { sourceZoom, MAX_MERCATOR_LAT, globalXToLon, globalYToLat } from "./tilemath.js";
import { cropGrid, gridRange } from "./resample.js";
import { buildSolid, buildRibbon } from "./mesh.js";
import { trailToPrintMm, resample, corridorMask, halfWFor, DS_FACTOR, MIN_CORD_CELLS } from "./corridor.js";
import { clipPolygon, clipElevs, clipRange } from "./clip.js";
import { applyWaterRecess } from "./water.js";
import { checkWatertight, signedVolume } from "./validate.js";
import { ThreeMFWriter } from "./threemf.js";
import { fetchMosaic } from "./terrain.js";

/** @typedef {import("./types.js").BBox} BBox */
/** @typedef {import("./types.js").Cell} Cell */
/** @typedef {import("./types.js").LatLon} LatLon */
/** @typedef {import("./types.js").Shape} Shape */
/** @typedef {import("./types.js").Window} Window */
/** @typedef {import("./types.js").Span} Span */
/** @typedef {import("./types.js").Mosaic} Mosaic */
/** @typedef {import("./types.js").Solid} Solid */
/**
 * @typedef {{ center: LatLon, scale: number, tileWidthMm: number, base: number, exag: number,
 *   flatten?: boolean, recessMm?: number, layerMm?: number, shape?: Shape }} TileSettings
 *   center = [lat,lon] of the tile; scale = 1:N; tileWidthMm = print size of the tile
 *   edge; base = base-plate thickness (mm); exag = vertical exaggeration; flatten = pull
 *   all water to one waterline below the land (default false); recessMm = extra water
 *   sink in print mm (default 0); layerMm = slicer layer height (default 0.15);
 *   shape = tile footprint (default "square"); tileWidthMm is the bounding-square side
 *   in every shape.
 */
/**
 * @typedef {{ z: number, bbox: BBox, window: Window, span: Span, gw: number, gh: number, dx: number, dy: number, mmPerM: number, shape: Shape, ring: Array<[number,number]> | null }} TilePlan
 *   z = source zoom; bbox = fetch bounds; window = exact Mercator pixel window;
 *   span = full-coverage cell span; gw/gh = window dims; dx/dy = print mm per
 *   pixel; mmPerM = print mm per metre of elevation (pre-exaggeration); shape =
 *   footprint kind; ring = footprint vertices in global px (null for square,
 *   which needs no clip).
 */

/** @type {Cell[]} */
const ORIGIN = [[0, 0]]; // single-tile layout: one cell at the origin

/** Clearance between the tile and the cord on the plate. */
const RIBBON_GAP_MM = 10;

// Pure: settings (+ optional explicit zoom) → source zoom, fetch bbox, exact
// pixel window, and print geom. Omit `z` to auto-pick the deepest useful zoom.
/**
 * @param {TileSettings} settings
 * @param {{ z?: number, maxTiles?: number }} [opts]
 * @returns {TilePlan}
 */
export function planTile(settings, { z, maxTiles = 300 } = {}) {
  const { center, scale, tileWidthMm, shape = "square" } = settings;
  const [lat] = center;
  const bbox = cellsBbox(center, scale, tileWidthMm, ORIGIN, shape);
  const [s, , n] = bbox;
  // Web Mercator only covers ±85.0511°; a tile spilling past it (a very large or
  // near-polar tile) has no source tiles. Reject up front with a clear message
  // instead of burning fetches on a window that only fails deep inside cropGrid.
  // Written as a negated range test so a non-finite edge would be rejected too.
  if (!(s >= -MAX_MERCATOR_LAT && n <= MAX_MERCATOR_LAT)) {
    throw new Error(
      `planTile: tile latitude span [${s.toFixed(4)}, ${n.toFixed(4)}]° ` +
      `exceeds the ±${MAX_MERCATOR_LAT.toFixed(4)}° Web Mercator limit`);
  }
  // For a clipped shape maxTiles is a SOFT budget: sourceZoom counts source tiles over the ring's
  // bbox, but the window below is expanded outward past that ring, so the fetch can need one more
  // tile row and column — bounded by (nx+1)(ny+1)/(nx·ny), measured at 9.1% over across the
  // lat × size × scale sweep. Tightening it would mean picking z from a window that does not
  // exist until z is picked; the budget only exists to stop runaway fetches, so it stays soft.
  const zoom = z ?? sourceZoom(bbox, lat, scale, maxTiles);
  const { spanPx, union } = cellWindows(center, scale, tileWidthMm, ORIGIN, zoom, shape);
  // The bbox guard above validated the RING; a clipped shape's window is then expanded outward
  // past it (layout.cellWindows), so a tile whose north edge sits exactly at the cap still
  // yields gy0 = -2 — rows above the top of the Mercator world. Nothing downstream says so
  // legibly: globalYToLat returns a latitude past the cap, tilesForBbox asks for source row -1,
  // and cropGrid reads off the end of the mosaic. Integer world height rather than
  // latToGlobalY(±MAX_MERCATOR_LAT), which lands on ±0 and would make the comparison a coin
  // flip. Only y is checked — x wraps, so a window crossing the antimeridian is well-defined.
  const worldPx = 256 * 2 ** zoom; // 256-px source tiles, as in tilemath
  if (union.gy0 < 0 || union.gy0 + union.gh > worldPx) {
    throw new Error(
      `planTile: the ${shape} tile's pixel window [${union.gy0}, ${union.gy0 + union.gh}) ` +
      `escapes the Web Mercator world [0, ${worldPx}) at z${zoom}`);
  }
  const dx = tileWidthMm / spanPx; // Mercator is conformal: square cells → dx = dy
  // A clipped shape's window is expanded outward past its ring (layout.cellWindows), so the
  // ring's own bbox no longer bounds the pixels cropGrid will read. Derive the fetch bounds
  // from the window instead — exact, and it cannot drift from the window it has to cover.
  const fetchBbox = shape === "square" ? bbox : /** @type {BBox} */ ([
    globalYToLat(union.gy0 + union.gh - 1, zoom), globalXToLon(union.gx0, zoom),
    globalYToLat(union.gy0, zoom), globalXToLon(union.gx0 + union.gw - 1, zoom),
  ]);
  return {
    z: zoom,
    bbox: fetchBbox,
    window: union,
    span: { r0: 0, r1: union.gh - 1, c0: 0, c1: union.gw - 1 },
    gw: union.gw,
    gh: union.gh,
    dx,
    dy: dx,
    mmPerM: 1000 / scale,
    shape,
    // The ring, not the mask: 6 or n points travel with the plan, while a mask would be
    // megabytes at export scale. n is a min of two bounds — as fine as the grid can express
    // (pi*D/2 keeps ring edges near 2 cells), never finer than accuracy requires (a 256-gon's
    // sagitta is 7.5 um on a 200 mm tile, 50x below a 0.4 mm nozzle).
    ring: footprintPx(center, scale, tileWidthMm, ORIGIN[0], zoom, shape,
      Math.max(16, Math.min(256, Math.round((Math.PI * (union.gw - 1)) / 2)))),
  };
}

// Pure: decoded mosaic + plan + {base,exag} → validated watertight solid + the tile's
// grid range. emin/emax are the tile's own min/max (single tile, so no cross-tile
// z-frame needed); emax lets callers place altitude color-change heights. Throws
// rather than emit a mesh that isn't a positive-volume closed manifold.
/**
 * `waterMask` (from the Re:Earth watermask tile) flattens/sinks masked water and anchors the
 * colour line — see water.applyWaterRecess. No mask → grid untouched, lineElev −Infinity (the
 * headless bakeTile path).
 * @param {Mosaic} mosaic
 * @param {TilePlan} plan
 * @param {{ base: number, exag: number, flatten?: boolean, recessMm?: number, layerMm?: number }} settings
 * @param {Uint8Array} [waterMask]
 * @param {{ segments: LatLon[][], widthMm: number, heightMm: number }} [trail]
 * @returns {{ solid: Solid, ribbon: Solid | null, emin: number, emax: number, lineElev: number, landBluePct: number, waterAsLandPct: number }}
 */
export function bakeTileSolid(mosaic, plan, { base, exag, flatten = false, recessMm = 0, layerMm = 0.15 }, waterMask, trail) {
  const { window, span, gw, gh, dx, dy, mmPerM, ring } = plan;
  const grid = cropGrid(mosaic, window);
  // Clip geometry first — applyWaterRecess mutates the grid, so crossing ELEVATIONS have
  // to wait for it, but the inside mask and crossing positions are pure geometry.
  const clip = ring ? clipPolygon(gw, gh, window.gx0, window.gy0, ring) : null;
  // Square fills its window, so it needs no clip and no footprint — keeping `footprint`
  // undefined there is what makes the square path bit-identical to before shapes existed.
  const footprint = clip ? clip.inside : undefined;
  const { lineElev, landBluePct, waterAsLandPct } = applyWaterRecess(grid, waterMask, {
    flatten, recessMm, layerMm, K: mmPerM * exag, footprint,
  });
  if (clip) clipElevs(clip, grid);
  const { min: emin, max: emax } = clip ? clipRange(grid, clip) : gridRange(grid);
  const solid = buildSolid(grid, gw, gh, span,
    clip ? null : new Uint8Array((gw - 1) * (gh - 1)).fill(1),
    { dx, dy, mmPerM, emin, exag, base }, clip ?? undefined);
  const wt = checkWatertight(solid);
  if (!wt.closed) throw new Error(`pipeline: non-watertight solid (${wt.unmatched} unmatched edges)`);
  if (signedVolume(solid) <= 0) throw new Error("pipeline: non-positive-volume (inside-out) solid");

  // AFTER applyWaterRecess and with the tile's own emin: the cord mates with the surface that
  // prints, not with the raw DEM, so a trail over recessed water follows the recess.
  let ribbon = null;
  if (trail && trail.segments.length) {
    if (!(trail.widthMm >= MIN_CORD_CELLS * dx)) {
      throw new Error(`pipeline: trail cord width ${trail.widthMm} mm is below the ` +
        `${(MIN_CORD_CELLS * dx).toFixed(2)} mm this tile's ${dx.toFixed(3)} mm grid can carry`);
    }
    const halfW = halfWFor(trail.widthMm, dx);
    const stations = trailToPrintMm(trail.segments, plan).map((p) => resample(p, halfW * DS_FACTOR));
    const { cells, count } = corridorMask(stations, plan, halfW, footprint);
    if (count) {
      ribbon = buildRibbon(grid, gw, gh, span, cells, { dx, dy, mmPerM, emin, exag }, trail.heightMm);
      const rwt = checkWatertight(/** @type {Solid} */ (ribbon));
      if (!rwt.closed) throw new Error(`pipeline: non-watertight ribbon (${rwt.unmatched} unmatched edges)`);
      // checkWatertight is topology-only (see validate.js) and cannot see a zero or negative
      // heightMm — the mirrored solid still closes. Mirrors the tile's own check above.
      if (signedVolume(/** @type {Solid} */ (ribbon)) <= 0) {
        throw new Error("pipeline: non-positive-volume (inside-out) ribbon");
      }
    }
  }

  return { solid, ribbon, emin, emax, lineElev, landBluePct, waterAsLandPct };
}

// One or two solids → a .3mf blob. The tile sits at the plate origin; the cord, when present,
// is placed clear of it in +Y.
//
// Both share one plate, and color changes are written per print Z for the WHOLE plate
// (Metadata/Prusa_Slicer_custom_gcode_per_print_z.xml) — 3MF has no per-object gcode. So a cord
// exported alongside altitude bands inherits their pauses. Documented at the export control
// rather than worked around; the fix is a second bed, which needs a reference file first.
/**
 * @param {string} name
 * @param {Solid} solid
 * @param {import("./colors.js").ColorChange[]} [colorChanges]
 * @param {Solid | null} [ribbon]
 * @returns {Promise<Uint8Array>}
 */
export async function tileTo3mf(name, solid, colorChanges, ribbon) {
  const writer = new ThreeMFWriter();
  if (colorChanges && colorChanges.length) writer.setColorChanges(colorChanges);
  await writer.addObject(name, solid, 0, 0);
  if (ribbon) {
    // Derived from the tile's own bounds rather than from tileWidthMm, so it stays clear for
    // every shape without the writer having to know which shape it was handed.
    let maxY = -Infinity;
    for (let i = 1; i < solid.positions.length; i += 3) maxY = Math.max(maxY, solid.positions[i]);
    await writer.addObject(`${name}_trail`, ribbon, 0, maxY + RIBBON_GAP_MM);
  }
  return writer.finish();
}

// Ground extent, not the 1:N ratio. Metres under 1 km so a small tile can't round to "0km",
// and no decimals past 10 km where a tenth is noise. Mirrors the UI's "200 mm : ~50 km"
// readout — one rounding rule for the two places a tile's size is named.
/** @param {number} km @returns {string} */
const groundLabel = (km) =>
  km >= 10 ? `${Math.round(km)}km` : km >= 1 ? `${km.toFixed(1)}km` : `${Math.round(km * 1000)}m`;

// Default export name: the parameters that define the tile — hemisphere-tagged centre, print
// width, and the ground extent that width covers — so the filename fully describes the tile
// that produced it (e.g. "terrane_tile_47.6035N_122.3294W_200mm_50km"). Ground extent rather
// than the scale ratio: "50 km" is how a person recognizes a tile in a downloads folder, and
// the ratio is recoverable from it and the print width.
/**
 * @param {TileSettings} settings
 * @returns {string}
 */
export function defaultTileName({ center: [lat, lon], tileWidthMm, scale, shape = "square" }) {
  const ns = `${Math.abs(lat).toFixed(4)}${lat >= 0 ? "N" : "S"}`;
  const ew = `${Math.abs(lon).toFixed(4)}${lon >= 0 ? "E" : "W"}`;
  const sh = shape === "square" ? "" : `_${shape}`; // square is the default; don't label it
  return `terrane_tile_${ns}_${ew}_${tileWidthMm}mm${sh}_${groundLabel((tileWidthMm * scale) / 1e6)}`;
}

// Browser step: fetch the tile's terrarium mosaic and bake a validated solid.
// The networked half of the pipeline — untested under node (fetchMosaic guards
// its browser APIs). Shared by the live preview and the export. onProgress
// forwards source-tile fetch progress (done, total) for a UI status line.
/**
 * @param {TileSettings} settings
 * @param {{ z?: number, maxTiles?: number, onProgress?: (done: number, total: number) => void }} [opts]
 * @returns {Promise<{ solid: Solid, emin: number, emax: number, lineElev: number, landBluePct: number, waterAsLandPct: number }>}
 */
export async function bakeTile(settings, opts = {}) {
  const plan = planTile(settings, opts);
  const mosaic = await fetchMosaic(plan.bbox, plan.z, { onProgress: opts.onProgress });
  return bakeTileSolid(mosaic, plan, settings);
}

// Browser entry: bake, then serialize to a downloadable .3mf blob.
/**
 * @param {TileSettings} settings
 * @param {{ z?: number, maxTiles?: number, name?: string, onProgress?: (done: number, total: number) => void }} [opts]
 * @returns {Promise<Uint8Array>}
 */
export async function exportTile(settings, opts = {}) {
  const { solid } = await bakeTile(settings, opts);
  return tileTo3mf(opts.name ?? defaultTileName(settings), solid);
}
