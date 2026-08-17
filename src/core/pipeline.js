// Headless bake + export orchestration: (tile settings) → source zoom +
// Mercator pixel window + print geom → elevation grid → watertight solid →
// validated .3mf. This is the "library" surface a thin UI drives. Single tile
// (square, hex or circle), monochrome — color/multi-tile arrive in later features.
import { cellsBbox, cellWindows, footprintPx } from "./layout.js";
import { sourceZoom, MAX_MERCATOR_LAT, globalXToLon, globalYToLat } from "./tilemath.js";
import { cropGrid, gridRange } from "./resample.js";
import { buildSolid, buildDrape, cellsFromVertexMask } from "./mesh.js";
import { trailToPrintMm, cordSolid, admissibleCells, cordLattice, distField,
  trenchWidthMm } from "./cord.js";
import { trenchAdmissibleCells, featherField, trenchTop } from "./trench.js";
import { clipPolygon, clipElevs, clipRange } from "./clip.js";
import { applyWaterRecess, filterUnprintableWater } from "./water.js";
import { checkWatertight, signedVolume } from "./validate.js";
import { ThreeMFWriter } from "./threemf.js";
import { fetchMosaic } from "./terrain.js";

/** @typedef {import("./types.js").BBox} BBox */
/** @typedef {import("./types.js").Cell} Cell */
/** @typedef {import("./types.js").LatLon} LatLon */
/** @typedef {import("./types.js").Shape} Shape */
/** @typedef {import("./types.js").WaterMode} WaterMode */
/** @typedef {import("./types.js").Window} Window */
/** @typedef {import("./types.js").Span} Span */
/** @typedef {import("./types.js").Mosaic} Mosaic */
/** @typedef {import("./types.js").Solid} Solid */
/**
 * @typedef {{ center: LatLon, scale: number, tileWidthMm: number, base: number, exag: number,
 *   waterMode?: WaterMode, recessMm?: number, layerMm?: number, shape?: Shape,
 *   waterInlay?: boolean, waterFilter?: boolean }} TileSettings
 *   center = [lat,lon] of the tile; scale = 1:N; tileWidthMm = print size of the tile
 *   edge; base = base-plate thickness (mm); exag = vertical exaggeration;
 *   waterMode = how water is treated: "none" leaves it at true elevation, "flat" pulls it all
 *   onto one waterline below the land, "all" sinks it all by recessMm (default "none");
 *   recessMm = water sink in print mm, ignored by "none" (default 0); layerMm = slicer
 *   layer height (default 0.15); shape = tile footprint (default "square"); tileWidthMm is
 *   the bounding-square side in every shape; waterInlay = also export the displaced water
 *   as drop-in parts (default false); waterFilter = skip water too narrow to print a part
 *   for (default true — see water.filterUnprintableWater).
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

/** Clearance between neighbouring objects on the plate. */
const PLATE_GAP_MM = 10;

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
 * @param {{ base: number, exag: number, waterMode?: WaterMode, recessMm?: number, layerMm?: number,
 *   waterInlay?: boolean, waterFilter?: boolean }} settings
 * @param {Uint8Array} [waterMask]
 * @param {{ segments: LatLon[][], widthMm: number, heightMm: number,
 *   trenchDepthMm?: number }} [trail]
 * @returns {{ solid: Solid, ribbon: Solid | null, inlays: Solid | null, emin: number, emax: number, lineElev: number, landBluePct: number, waterAsLandPct: number, printedWaterMask: Uint8Array | undefined, waterDroppedPct: number }}
 */
export function bakeTileSolid(mosaic, plan,
  { base, exag, waterMode = "none", recessMm = 0, layerMm = 0.15, waterInlay = false, waterFilter = true },
  waterMask, trail) {
  const { window, span, gw, gh, dx, dy, mmPerM, ring } = plan;
  const grid = cropGrid(mosaic, window);
  // The inlay's TOP is the original water surface, and flatten destroys it in place (a flattened
  // vertex keeps no record of where it started), so the snapshot has to be taken here — before
  // applyWaterRecess — or not at all. A second full grid, so it is taken only when asked for.
  const preWater = waterInlay && waterMask ? grid.slice() : null;
  // Clip geometry first — applyWaterRecess mutates the grid, so crossing ELEVATIONS have
  // to wait for it, but the inside mask and crossing positions are pure geometry.
  const clip = ring ? clipPolygon(gw, gh, window.gx0, window.gy0, ring) : null;
  // Square fills its window, so it needs no clip and no footprint — keeping `footprint`
  // undefined there is what makes the square path bit-identical to before shapes existed.
  const footprint = clip ? clip.inside : undefined;
  // ONE mask for the recess and the inlay. They disagreed before: the recess moved masked
  // VERTICES while the inlay meshed all-four-corners CELLS, so water narrower than a cell was
  // grooved with nothing built to fill it. Before applyWaterRecess, not inside the inlay branch —
  // filtering only the inlay would leave the pit, which is the complaint.
  // Off returns the caller's own array, so the two are the SAME object and the worker's
  // land/printed/dropped annotation finds nothing to mark — which is the honest answer.
  const { mask: printedWaterMask, droppedPct: waterDroppedPct } = waterFilter
    ? filterUnprintableWater(waterMask, gw, gh, dx)
    : { mask: waterMask, droppedPct: 0 };
  // The set whose elevation this bake actually changed, which is a narrower claim than "the water
  // this tile printed" — with the mode at rest the water is terrain that happens to be wet.
  // Two consumers, so they cannot disagree about which water moved: the inlay fills exactly what
  // moved, and the channel refuses exactly what the inlay claims.
  // NOT `waterMode !== "none"`, tempting as that is now the depth cannot be zero from the UI. The
  // 0.5 floor is a UI and hash bound; a headless caller may pass 0, and claiming that tile moved
  // water would refuse the trail channel over a river nothing touched. app.js may make exactly
  // that reduction — it owns the floor — and this is the half that cannot.
  const movedWaterMask = waterMode === "flat" || (waterMode !== "none" && recessMm > 0)
    ? printedWaterMask : undefined;
  const { lineElev, landBluePct, waterAsLandPct } = applyWaterRecess(grid, printedWaterMask, {
    waterMode, recessMm, layerMm, K: mmPerM * exag, footprint,
  });
  // Projected once, because the channel and the cord must be measured against the same polyline,
  // and meshed against the same lattice: two builders picking their own k would compute crossings
  // that agree to within a float rather than bit-for-bit, and the seam between them would not weld.
  const trailPolys = trail && trail.segments.length ? trailToPrintMm(trail.segments, plan) : null;
  /** @type {{ half: number, k: number, chopped: Float64Array[], dist: Map<number, number>,
   *   feather?: Float32Array, depthMm?: number } | null} */
  let shared = null;
  /** @type {ReturnType<typeof trenchTop>} */
  let trenchMesh = null;
  /** @type {Uint8Array | null} */
  let trenchOk = null;
  if (trail && trailPolys) {
    const { chopped, k } = cordLattice(trailPolys, plan, trail.widthMm);
    const half = trenchWidthMm(trail.widthMm) / 2;
    // Stamped at the CHANNEL's half-width, which covers the cord's narrower band a fortiori --
    // distField dilates past `half` by 2h either way.
    shared = { half, k, chopped, dist: distField(chopped, plan, half, k) };
    // Validated on PRESENCE, not on truthiness. NaN is falsy, so folding this into the `if` below
    // would wave a NaN depth through as "no inset" and silently bake a tile with no channel. The
    // depth is a raw mm figure straight from the caller — nothing scales or derives it, so nothing
    // upstream guarantees it is even a number, and a non-finite one must be refused rather than
    // read as "off". Absent and 0 both DO mean off, and are not errors: the control rests at 0.
    if (trail.trenchDepthMm != null && trail.trenchDepthMm !== 0 &&
        !(Number.isFinite(trail.trenchDepthMm) && trail.trenchDepthMm > 0)) {
      throw new Error(`corridor: trail inset depth must be a positive distance, got ${trail.trenchDepthMm}`);
    }
    // Checked here rather than left to the volume gate below: with the cord in the tile's own
    // frame its top and bottom faces cancel only to rounding, so a zero height now yields a
    // positive noise volume instead of the exact 0 a plate-dropped cord produced.
    if (!(trail.heightMm > 0)) {
      throw new Error(`corridor: trail height must be a positive distance, got ${trail.heightMm}`);
    }
    if (trail.trenchDepthMm) {
      trenchOk = trenchAdmissibleCells(gw, gh, clip);
      // The MOVED mask, not the printed one. The channel is refused over water because lowering a
      // vertex the recess put at a known depth would unseat the part moulded to it — a claim about
      // water this bake displaced, not about water in general. Left at true elevation it is terrain
      // the trail may cross, which is what a trail fording a river does. Water is normally the
      // tile's own emin, so a ford cuts the thinnest ground on the tile and can reach trench.js's
      // base-cut refusal on a thin base — loud and remediable, which is the wanted direction.
      // Undefined when nothing moved. Unconditional on waterInlay: that toggle is export-only, so keying tile geometry to
      // it would make the previewed tile a different object from the exported one. And the printed
      // mask feeds it, for the reason filterUnprintableWater exists: water too narrow to print is
      // ordinary land in the tile now, and refusing the channel over it would leave the trail
      // dotted across ground that has no water on it.
      shared.feather = featherField(gw, gh, trenchOk, movedWaterMask);
      shared.depthMm = trail.trenchDepthMm;
    }
  }
  if (clip) clipElevs(clip, grid);
  const { min: emin, max: emax } = clip ? clipRange(grid, clip) : gridRange(grid);
  if (shared && shared.feather) {
    // AFTER clipElevs and the range, because the channel is meshed rather than carved: it reads the
    // grid the tile is measured from and never writes to it, so emin no longer absorbs the inset
    // and the tile stops growing with depth.
    trenchMesh = trenchTop(grid, plan, shared.dist, shared.k, shared.half,
      /** @type {number} */ (shared.depthMm), shared.feather,
      /** @type {Uint8Array} */ (trenchOk), { mmPerM, emin, exag, base },
      gw * gh + (clip ? clip.col.length : 0));
  }
  const solid = buildSolid(grid, gw, gh, span,
    clip ? null : new Uint8Array((gw - 1) * (gh - 1)).fill(1),
    { dx, dy, mmPerM, emin, exag, base }, clip ?? undefined, trenchMesh);
  const wt = checkWatertight(solid);
  if (!wt.closed) throw new Error(`pipeline: non-watertight solid (${wt.unmatched} unmatched edges)`);
  if (signedVolume(solid) <= 0) throw new Error("pipeline: non-positive-volume (inside-out) solid");
  // checkWatertight is blind to the failure a sub-meshed seam produces: a non-conforming edge is
  // classified as rim on both sides, the skirt hangs two coincident opposite-facing curtains, the
  // fake edges stitch into a zero-area loop, baseTriangles returns null and the base silently
  // mirrors — with every directed edge still paired and zero enclosed volume. These two integers
  // are the cascade's fingerprints, and assembleSolid already computed them.
  // Conditioned on the channel, deliberately. assembleSolid's own comment calls the mirror
  // fallback "correct, just bigger" — it also covers holes and degenerate rims, and hardening it
  // into a refusal for every bake would turn tiles that export fine today into errors, which is
  // not this feature's business. Both gates fingerprint a sub-meshed seam (and the detached blocks
  // a mis-scoped trench predicate builds), so they belong to the bakes that have one.
  //
  // Neither gate can tell such a rim from a broken seam, so a tile that mirrored on its OWN would
  // start failing here the moment an inset was switched on. No legal footprint does: 38,880 hex
  // and circle tiles through footprintPx/clipPolygon — z6 to z14, spans 2 to 33 px, the coarsest
  // MIN_SPAN_PX allows — all stitched flat in one loop. The other route in is a partial mask, and
  // the pipeline only ever passes one unclipped.
  if (trenchMesh) {
    if (solid.mirrored) throw new Error("pipeline: tile base could not be stitched flat (non-conforming seam)");
    if (solid.loops !== 1) throw new Error(`pipeline: tile has ${solid.loops} boundary loops, want 1`);
  }

  // AFTER applyWaterRecess and with the tile's own emin: the cord mates with the surface that
  // prints, not with the raw DEM, so a trail over recessed water follows the recess.
  let ribbon = null;
  if (trail && trailPolys) {
    // The cord's width is independent of the grid: its footprint is a distance field clipped
    // against the terrain's own triangles on a sub-lattice, not a union of whole cells.
    // The tile's own z frame, for the preview and the export alike: the cord is written where
    // it mates, so the export drops it into its channel with nothing to align.
    ribbon = cordSolid(grid, plan, trailPolys, trail.widthMm,
      trail.heightMm, { mmPerM, emin, exag }, admissibleCells(gw, gh, clip),
      base, /** @type {NonNullable<typeof shared>} */ (shared));
    if (ribbon) {
      const rwt = checkWatertight(ribbon);
      if (!rwt.closed) {
        throw Object.assign(new Error(`pipeline: non-watertight ribbon (${rwt.unmatched} unmatched edges)`),
          { dropCord: true }); // the CORD's own mesh, not the tile's; a preview keeps the terrain (bake.worker.js)
      }
      // checkWatertight is topology-only (see validate.js) and cannot see a zero or negative
      // heightMm — the mirrored solid still closes. Mirrors the tile's own check above.
      if (signedVolume(ribbon) <= 0) {
        throw Object.assign(new Error("pipeline: non-positive-volume (inside-out) ribbon"), { dropCord: true });
      }
    }
  }

  // Drop-in parts filling the hollow the water controls left: underside on the printed water
  // surface, top on the water's ORIGINAL elevation. Exactly the volume applyWaterRecess removed,
  // which is why the mode decides — flatten's drop to the plane and a sinking mode's groove are
  // alternative ways to displace water, never combined, and with the mode at rest nothing is
  // displaced and there is nothing to fill.
  let inlays = null;
  if (preWater && movedWaterMask) {
    // All four corners water AND inside the footprint. The erosion that rule implies is wanted
    // here, unlike in the corridor, which compensates for it. The tile's surface crosses a shore
    // over ONE cell, as a ramp from the land vertex down to the water vertex, and since the top
    // and bottom surfaces MEET at an unmoved land vertex, a part covering that ramp would fill
    // it exactly — but taper to zero thickness along its whole shoreline. That is a knife edge
    // below any printable feature size, and it leaves zero clearance exactly where the part has
    // to drop in. Conceding the ramp cells buys a vertical wall the slicer can print and a
    // groove at most one cell wide (dx, a 0.083 mm median at export pitch) to seat the part through.
    const { cells, count } = cellsFromVertexMask(
      /** @type {Uint8Array} */ (movedWaterMask), gw, gh, footprint);
    if (count) {
      inlays = buildDrape(grid, gw, gh, span, cells, { dx, dy, mmPerM, emin, exag }, preWater);
      const iwt = checkWatertight(/** @type {Solid} */ (inlays));
      if (!iwt.closed) throw new Error(`pipeline: non-watertight water inlay (${iwt.unmatched} unmatched edges)`);
      // Zero volume is reachable without being a bug: `flat` on a tile whose water is already the
      // lowest thing in it moves every vertex onto the plane it is already on, so every top sits on
      // its own underside. That is an empty part, not an inverted one — drop it rather than throw.
      if (signedVolume(/** @type {Solid} */ (inlays)) <= 0) inlays = null;
    }
  }

  return { solid, ribbon, inlays, emin, emax, lineElev, landBluePct, waterAsLandPct,
    printedWaterMask, waterDroppedPct };
}

// One to three solids → a .3mf blob. The tile sits at the plate origin, the cord in the tile's
// own frame beside it — seated, not plated — and the water inlays, when present, clear of both
// in +Y.
//
// They share one plate, and color changes are written per print Z for the WHOLE plate
// (Metadata/Prusa_Slicer_custom_gcode_per_print_z.xml) — 3MF has no per-object gcode. So a cord
// exported alongside altitude bands inherits their pauses. Documented at the export control
// rather than worked around; the fix is a second bed, which needs a reference file first.
/**
 * @param {string} name
 * @param {Solid} solid
 * @param {import("./colors.js").ColorChange[]} [colorChanges]
 * @param {Solid | null} [ribbon]
 * @param {Solid | null} [inlays]
 * @returns {Promise<Uint8Array>}
 */
export async function tileTo3mf(name, solid, colorChanges, ribbon, inlays) {
  const writer = new ThreeMFWriter();
  if (colorChanges && colorChanges.length) writer.setColorChanges(colorChanges);
  await writer.addObject(name, solid, 0, 0);
  // Untranslated, deliberately: the cord already carries the tile's own frame, so at the origin
  // it sits in the channel it was measured against, mating face on mating face. Slicers scatter
  // a plate with one button; none of them can put a part back where it fits.
  if (ribbon) await writer.addObject(`${name}_trail`, ribbon, 0, 0);
  // The inlays cannot follow it in: their z is the water surface they displaced, with no base
  // term (bakeTileSolid), so in place they would sit inside the tile rather than on it. Cleared
  // against the tile's OWN bounds rather than tileWidthMm, so the placement holds for every shape
  // without the writer knowing which it was handed. The −lo term makes the part land at the gap
  // whatever its own coordinates were: it keeps the tile's frame, so it starts wherever its
  // water sits, and without that term it lands `lo` higher than the gap it was given.
  if (inlays) {
    let hi = -Infinity, lo = Infinity;
    for (let i = 1; i < solid.positions.length; i += 3) hi = Math.max(hi, solid.positions[i]);
    for (let i = 1; i < inlays.positions.length; i += 3) lo = Math.min(lo, inlays.positions[i]);
    await writer.addObject(`${name}_water`, inlays, 0, hi + PLATE_GAP_MM - lo);
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
 * @returns {Promise<ReturnType<typeof bakeTileSolid>>}
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
