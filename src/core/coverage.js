// Mapterhorn composites 134 source datasets, and its `coverage` tileset publishes which one
// supplied each part of the world, and its merge pipeline is open source — so the ranking here
// reproduces that rule rather than approximating it (see docs/specs/data-sources.md). Pure decode,
// projection, lookup, ranking and edge geometry; the browser fetches sit at the bottom and touch
// `fetch` only inside function bodies, so this module still imports under node for the tests.

import { pointInPolygon } from "./layout.js";
import { sourceTileRange } from "./tilemath.js";

/** @typedef {{ source: string, rings: Array<Array<[number, number]>> }} CoverageFeature */
/** @typedef {CoverageFeature & { clip: [number, number, number, number] }} PlacedFeature
 *   projected into grid space, carrying the buffered rectangle its tile clipped it to */
/** @typedef {{ extent: number, features: CoverageFeature[] }} CoverageTile */
/** @typedef {import("./types.js").Window} Window */

// Measured on the real tileset: coordinates run -64..extent+64, so the clip rectangle is the tile
// grown by this. A tileset re-cut with a different buffer just stops matching, and edgeDistance
// falls back to treating clips as edges — the behavior before this was known, not a crash.
const MVT_BUFFER = 64;

// Multiplying rather than shifting: `<<` is 32-bit, and protobuf lengths are not bounded to it.
/** @param {Uint8Array} buf @param {number} i @returns {[number, number]} value, next index */
function varint(buf, i) {
  let r = 0, s = 1, c;
  do { c = buf[i++]; r += (c & 0x7f) * s; s *= 128; } while (c & 0x80);
  return [r, i];
}

// Walk one protobuf message, yielding [field, value] — Uint8Array for length-delimited, number
// for varint. Unread scalar/length-delimited fields are skipped, not rejected, so a future field
// addition doesn't lose provenance. Group wire types (3/4) still throw: they're deprecated and
// MVT never emits them.
/** @param {Uint8Array} buf @returns {Generator<[number, number | Uint8Array]>} */
function* fields(buf) {
  for (let i = 0; i < buf.length;) {
    let key; [key, i] = varint(buf, i);
    const f = key >>> 3, wire = key & 7;
    if (wire === 2) { let n; [n, i] = varint(buf, i); yield [f, buf.subarray(i, i + n)]; i += n; }
    else if (wire === 0) { let v; [v, i] = varint(buf, i); yield [f, v]; }
    else if (wire === 5) i += 4;
    else if (wire === 1) i += 8;
    else throw new Error(`coverage: protobuf wire type ${wire}`);
  }
}

// Command-stream geometry → rings, in tile-local units. Two rules that are easy to get wrong and
// silent when you do: ClosePath emits no vertex, and the cursor carries across rings, so a ring's
// first point is a delta from the PREVIOUS ring's last point.
/** @param {Uint8Array} buf @returns {Array<Array<[number, number]>>} */
function rings(buf) {
  /** @type {Array<Array<[number, number]>>} */
  const out = [];
  let cx = 0, cy = 0;
  for (let i = 0; i < buf.length;) {
    let cmd; [cmd, i] = varint(buf, i);
    const op = cmd & 7, count = cmd >>> 3;
    if (op === 7) continue; // ClosePath
    if (op === 1) out.push([]);
    for (let k = 0; k < count; k++) {
      let dx, dy;
      [dx, i] = varint(buf, i);
      [dy, i] = varint(buf, i);
      cx += (dx >>> 1) ^ -(dx & 1); // zigzag: params only, never the command word
      cy += (dy >>> 1) ^ -(dy & 1);
      out[out.length - 1].push([cx, cy]);
    }
  }
  return out;
}

// A coverage tile → its polygons. Tags resolve in a second pass because the value table may be
// written after the features (the real tiles do exactly this).
/** @param {Uint8Array} buf @returns {CoverageTile} */
export function decodeCoverage(buf) {
  let extent = 4096; // MVT's default when the layer omits it
  /** @type {CoverageFeature[]} */
  const features = [];
  for (const [tf, layerBuf] of fields(buf)) {
    if (tf !== 3 || !(layerBuf instanceof Uint8Array)) continue; // Tile.layers
    let name = "";
    let layerExtent = 4096;
    /** @type {string[]} */
    const keys = [];
    /** @type {string[]} */
    const values = [];
    /** @type {{ tags: number[], geom: Uint8Array }[]} */
    const raw = [];
    for (const [lf, lv] of fields(layerBuf)) {
      if (lf === 1 && lv instanceof Uint8Array) name = new TextDecoder().decode(lv);
      else if (lf === 5 && typeof lv === "number") layerExtent = lv;
      else if (lf === 3 && lv instanceof Uint8Array) keys.push(new TextDecoder().decode(lv));
      else if (lf === 4 && lv instanceof Uint8Array) {
        for (const [vf, vv] of fields(lv)) if (vf === 1 && vv instanceof Uint8Array) values.push(new TextDecoder().decode(vv));
      } else if (lf === 2 && lv instanceof Uint8Array) {
        /** @type {number[]} */
        const tags = [];
        /** @type {Uint8Array} */
        let geom = new Uint8Array(0);
        for (const [ff, fv] of fields(lv)) {
          if (ff === 2 && fv instanceof Uint8Array) { for (let i = 0; i < fv.length;) { let t; [t, i] = varint(fv, i); tags.push(t); } }
          else if (ff === 4 && fv instanceof Uint8Array) geom = fv;
        }
        raw.push({ tags, geom });
      }
    }
    if (name !== "coverage") continue; // other layers (e.g. basemap) share the tile; not ours
    extent = layerExtent;
    const ki = keys.indexOf("source");
    for (const { tags, geom } of raw) {
      let source = "";
      for (let t = 0; t + 1 < tags.length; t += 2) if (tags[t] === ki) source = values[tags[t + 1]] ?? "";
      if (source) features.push({ source, rings: rings(geom) });
    }
  }
  return { extent, features };
}

// Tile-local rings → the bake's grid coordinates, through tilemath's global-pixel model.
// Sample c sits at gx0+c, NOT gx0+c+0.5 — that is resample.js's raster-mosaic convention, and
// mixing the two shifts every polygon half a cell off the terrain it describes.
// `tx`/`ty` must be UNWRAPPED, as terrain.mosaicTiles keeps them: a window crossing the
// antimeridian has tx outside [0, 2^cz), and wrapping here moves the polygons a whole world.
/**
 * @param {CoverageTile} tile
 * @param {number} tx unwrapped tile x @param {number} ty tile y
 * @param {number} cz coverage zoom @param {number} pz plan zoom
 * @param {Window} window
 * @returns {PlacedFeature[]}
 */
export function projectFeatures({ extent, features }, tx, ty, cz, pz, { gx0, gy0 }) {
  const k = (256 * 2 ** (pz - cz)) / extent;
  // Where this tile cut its polygons, carried along so edgeDistance can tell a clip from a coast.
  /** @type {[number, number, number, number]} */
  const clip = [
    (tx * extent - MVT_BUFFER) * k - gx0, (ty * extent - MVT_BUFFER) * k - gy0,
    (tx * extent + extent + MVT_BUFFER) * k - gx0, (ty * extent + extent + MVT_BUFFER) * k - gy0,
  ];
  return features.map(({ source, rings: rs }) => ({
    source,
    clip,
    rings: rs.map((r) => r.map(([x, y]) => /** @type {[number, number]} */ (
      [(tx * extent + x) * k - gx0, (ty * extent + y) * k - gy0]))),
  }));
}

// Sources covering a grid cell, in tile order. A feature's rings XOR: even-odd handles holes and
// multi-polygons alike, which is why pointInPolygon is reused rather than reimplemented.
// MVT defines interiors by winding, not parity. The two agree unless one feature carries
// OVERLAPPING same-winding exteriors, which a union-built coverage layer should never emit — the
// real tile has only disjoint exteriors and true holes. If that ever changes, the overlap reads
// as uncovered rather than erroring, so it is worth knowing the assumption is here.
/**
 * @param {CoverageFeature[]} features
 * @param {number} col @param {number} row
 * @returns {string[]}
 */
export function sourcesAt(features, col, row) {
  /** @type {string[]} */
  const out = [];
  for (const { source, rings: rs } of features) {
    let inside = false;
    for (const r of rs) if (pointInPolygon([col, row], r)) inside = !inside;
    // Dedup by source, not by feature: tiles carry a 64-unit buffer, so a cell within the buffer
    // of a seam is inside the SAME source's polygon in two adjacent tiles. A repeat would inflate
    // the ranked list, and ranked.length > 1 is what arms the blend check — so every seam over
    // land would claim a blend against itself.
    if (inside && !out.includes(source)) out.push(source);
  }
  return out;
}

// aggregation_merge.py Gaussian-blends across every nodata edge before writing. This is the
// pipeline's BUDGET (macrotile_buffer_3857), not the blur's reach — featherPx derives that from
// it. A cell inside the reach is not its source's value but a mix with whatever filled beyond.
const FEATHER_3857_M = 150;
// Web Mercator's full x extent, the unit both the merge buffer and the maxzoom key are measured in.
const WORLD_M = 2 * 20037508.342789244;
// aggregation_covering.py's macrotile_z: the floor every file's maxzoom is clamped to.
const MACROTILE_Z = 12;

/** Both endpoints on one clip line. @param {number} a @param {number} b @param {number} v */
const onLine = (a, b, v) => Math.abs(a - v) < 1e-6 && Math.abs(b - v) < 1e-6;

// Grid px from a cell to the nearest edge of `source`'s DATA. Segments lying along the tile's
// buffered clip rectangle are skipped: those are where the tileset cut the polygon, not where the
// source runs out, and counting them flags a blend along every internal seam — glo30 is under all
// land, so ranked.length > 1 always holds and it would fire everywhere. Same buffered-duplicate
// trap as the seam double-count, wearing a different hat.
// A real edge that happens to run along the clip line for a whole segment is lost, which errs
// toward under-reporting blends — the safe direction for a claim this confident.
/**
 * @param {PlacedFeature[]} features @param {number} col @param {number} row
 * @param {string} source @returns {number} px, Infinity if the source has no rings here
 */
export function edgeDistance(features, col, row, source) {
  let best = Infinity;
  for (const f of features) {
    if (f.source !== source) continue;
    const [cx0, cy0, cx1, cy1] = f.clip;
    for (const r of f.rings) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [x1, y1] = r[j], [x2, y2] = r[i];
        if (onLine(x1, x2, cx0) || onLine(x1, x2, cx1)
          || onLine(y1, y2, cy0) || onLine(y1, y2, cy1)) continue;
        const dx = x2 - x1, dy = y2 - y1;
        const len = dx * dx + dy * dy;
        // t clamped to the segment, so a vertex is the nearest point when the projection falls off
        const t = len ? Math.max(0, Math.min(1, ((col - x1) * dx + (row - y1) * dy) / len)) : 0;
        const ex = col - (x1 + t * dx), ey = row - (y1 + t * dy);
        const d = ex * ex + ey * ey;
        if (d < best) best = d;
      }
    }
  }
  return Math.sqrt(best);
}

// The blur's actual reach, not the 150 m budget it is derived from. aggregation_reproject.py sets
// buffer_pixels = int(150 / res) at the FINEST group's resolution, then aggregation_merge.py blurs
// with sigma = max(int(buffer/4) - 1, 1) and truncate = 4, so the reach is 4·sigma·res — ~143 m
// for a 1 m lidar merge but only ~76 m when the finest group sits on the z12 floor. Flat 150 m
// over-flags the coarse case about twofold.
// Approximation, deliberate: the pipeline picks buffer_pixels from the finest group in the whole
// AGGREGATION tile (z6-z12), which can be finer than the winner at this particular cell. Passing
// the winner's bucket therefore understates the reach near a coarse winner's edge — under-
// reporting blends, the same direction the clip-edge skip errs in, and the one to prefer for a
// label this assertive. Closing it would mean knowing the finest source across a whole macrotile,
// which the fetched window does not bound.
/** @param {number} pz plan zoom @param {number} mz the winner's maxzoom @returns {number} px */
export function featherPx(pz, mz) {
  const res = WORLD_M / (512 * 2 ** mz);              // Mercator m per px in the merge's own grid
  const sigma = Math.max(Math.floor(Math.floor(FEATHER_3857_M / res) / 4) - 1, 1);
  return (4 * sigma * res) / (WORLD_M / (256 * 2 ** pz));
}

// Only `resolution` is kept: it is the ranking key, and it is all the probe reports.
/** @typedef {Map<string, number>} Catalog */

// Mapterhorn's precedence key. NOT the catalog's metres: get_smallest_overzoom() divides each
// file's EPSG:3857 bounds by its NATIVE pixel count, so the key is an integer zoom over Mercator
// metres, and Mercator stretches by 1/cos(lat). Two effects the raw metres miss — an integer
// bucket collapses sources within a factor of 2, and the stretch grows toward the poles. Both
// bite at Svalbard, where 20 m `nosvalbard` and 30 m `glo30` share bucket 10 and the merge takes
// glo30 on the id tiebreak; ranking by metres alone names nosvalbard, which is simply wrong.
// The floor is not ours: aggregation_covering.py clamps every file with
// `maxzoom = max(maxzoom, macrotile_z)`, macrotile_z = 12, and writes the CLAMPED value into the
// CSV the merge sorts by. So every source coarser than ~19 Mercator m/px collapses to bucket 12
// and the id tiebreak decides between them. It also absorbs the geographic-CRS error: glo30's own
// native maxzoom runs 9-12 by latitude band (the pipeline comments them), all at or below the
// floor, so glo30 lands on 12 whichever way its resolution is scaled.
/** @param {number} resolutionM catalog metres @param {number} lat degrees @returns {number} */
export function maxzoomFor(resolutionM, lat) {
  const merc = resolutionM / Math.cos((lat * Math.PI) / 180);
  for (let z = 0; z < 33; z++) if (WORLD_M / (512 * 2 ** z) < merc) return Math.max(z, MACROTILE_Z);
  return 32;
}

// Ranked the way the composite was built: finest maxzoom first, source id as the tiebreak, which
// is `sorted((-maxzoom, source, filename))` in pipelines/utils.py. Since the polygons are validity
// masks rather than bounding boxes, "covers this cell" means "has data here" — so the first of
// these IS the source the merge used, not merely the finest one on offer. Unlisted ids have no
// resolution and so no key; they are kept aside rather than ranked or dropped.
/**
 * @param {string[]} sources ids covering the cell, deduped by sourcesAt
 * @param {Catalog} catalog @param {number} lat degrees
 * @returns {{ ranked: string[], unlisted: string[] }}
 */
export function rankSources(sources, catalog, lat) {
  const unlisted = sources.filter((s) => !catalog.has(s)).sort();
  const ranked = sources.filter((s) => catalog.has(s)).sort((a, b) =>
    maxzoomFor(catalog.get(b) ?? 0, lat) - maxzoomFor(catalog.get(a) ?? 0, lat) || (a < b ? -1 : 1));
  return { ranked, unlisted };
}

// The probe's provenance clause. Resolution is grid SPACING, not information content — a source
// can advertise 10 m and carry contour-derived data an order of magnitude smoother — so this
// reports what is knowable and nothing more.
// `blend` names the source the merge feathered into over the last stretch before this source's
// data ends; there the pixel is genuinely a mix and no single answer is correct.
/**
 * @param {string[]} sources ids covering the cell, DEDUPED by sourcesAt — a repeat would read as
 *   a second source and arm the blend check against the winner itself
 * @param {Catalog | null} catalog null = the catalog fetch failed
 * @param {number} lat degrees, for the Mercator scale in the maxzoom key
 * @param {string | null} [blend] the source being blended into, if the cell is in a feather band
 * @returns {string}
 */
export function describeSources(sources, catalog, lat, blend = null) {
  if (!sources.length) return "no source data";
  if (!catalog) return `${[...sources].sort().join(", ")} (catalog unavailable)`;
  const { ranked, unlisted } = rankSources(sources, catalog, lat);
  if (!ranked.length) return `${unlisted.join(", ")} (unlisted)`;
  // An unlisted id has a maxzoom in the merge even though we cannot compute one, so it may be the
  // real winner. Say the ranking is incomplete rather than quietly presenting a runner-up as used.
  return `${ranked[0]} ${catalog.get(ranked[0])} m`
    + (blend ? ` ⇄ ${blend} (blended)` : "")
    + (unlisted.length ? ` ?${unlisted.join(", ")} unranked` : "");
}

/** @typedef {import("./types.js").BBox} BBox */

// Mapterhorn's coverage tileset and its source catalog. THREE hosts are now in play — the
// rasters come from terrain.reearth.land — and all three fail independently, which is why
// coverage is posted separately and its failures are shown rather than swallowed.
const COVERAGE_URL = "https://single-archive-tiles.mapterhorn.com/coverage/{z}/{x}/{y}.mvt";
const CATALOG_URL = "https://download.mapterhorn.com/attribution.json";
// The tileset stops at z14 while bakes run to z15, so polygon edges resolve to ~9.5 m at the
// equator. Source footprints are survey boundaries many km across; this is invisible at any
// tile size we print.
const COVERAGE_MAX_ZOOM = 14;

// Every coverage polygon over the plan's window, already in grid coordinates.
/**
 * @param {BBox} bbox @param {number} pz @param {Window} window
 * @returns {Promise<CoverageFeature[]>}
 */
export async function fetchCoverage(bbox, pz, window) {
  const cz = Math.min(pz, COVERAGE_MAX_ZOOM);
  const world = 2 ** cz;
  const { tx0, tx1, ty0: ry0, ty1: ry1 } = sourceTileRange(bbox, cz);
  // The 1-px halo drives ty0 to -1 on legal windows near the ±85° cap; x wraps instead.
  const ty0 = Math.max(0, ry0), ty1 = Math.min(world - 1, ry1);
  /** @type {CoverageFeature[]} */
  const out = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const x = ((tx % world) + world) % world; // wrapped for the URL only — projection needs tx raw
      const url = COVERAGE_URL.replace("{z}", String(cz)).replace("{x}", String(x)).replace("{y}", String(ty));
      // No force-cache: Mapterhorn re-cuts this tileset as sources are added, and force-cache
      // ignores freshness entirely. The 7-day max-age is enough.
      const res = await fetch(url, { mode: "cors" });
      if (!res.ok) throw new Error(`coverage ${cz}/${x}/${ty}: HTTP ${res.status}`);
      // Ocean tiles answer 204 with an empty body. `res.ok` is TRUE for 204, so the throw above
      // lets it through, and an empty buffer decodes to zero features — no special case needed.
      const buf = new Uint8Array(await res.arrayBuffer());
      out.push(...projectFeatures(decodeCoverage(buf), tx, ty, cz, pz, window));
    }
  }
  return out;
}

// The source catalog: 134 entries, of which only `resolution` is used here (ranking). Fetched
// rather than vendored so a newly added source is not silently unlisted.
/** @returns {Promise<Catalog>} */
export async function fetchCatalog() {
  // No force-cache, for the reason above: a pinned copy would keep reporting a new source as unlisted.
  const res = await fetch(CATALOG_URL, { mode: "cors" });
  if (!res.ok) throw new Error(`catalog: HTTP ${res.status}`);
  const list = /** @type {{ source: string, resolution: number }[]} */ (await res.json());
  return new Map(list.map((e) => [e.source, e.resolution]));
}
