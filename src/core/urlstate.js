// Shareable app state in the URL hash. Pure, DOM-free: encode/decode only, so the round-trip
// is testable under node. The hash — not a query string — because it never reaches a server and
// survives static hosting untouched. A shared link is a permanent compatibility contract, so the
// payload carries a version and anything unreadable decodes to null, letting the app fall back
// to its default region rather than boot into a broken state.
import { MAX_MERCATOR_LAT } from "./tilemath.js";

/** @typedef {import("./types.js").LatLon} LatLon */
/** @typedef {import("./types.js").Shape} Shape */
/**
 * @typedef {{ center: LatLon | null, scale: number, tileWidthMm: number, base: number,
 *   exag: number, flatten: boolean, recessMm: number, layerMm: number, shape: Shape }} ShareableState
 */

/** Payload version. Bump only for a breaking key/meaning change; old links then decode to null. */
export const STATE_VERSION = 1;

/**
 * Legal range for the scale input, read as "mm of print per km of ground". Every writer of
 * `scale` clamps to this, not just the input's own handler: fitTile writes it too, and a
 * framing outside the range leaves the manual control showing a number it will not accept
 * back.
 *
 * These are usability limits, chosen well inside what the hash can carry — 1000 mm/km is
 * already a 1:1000 tile. The encoder's own failures are far outside them: `Math.round`
 * collapses scale to 0 only above ~2.1e6 mm/km, and the exponent form whose "+" decodes as
 * a space appears only below ~1e-16.
 */
export const MM_PER_KM_MIN = 0.01;
export const MM_PER_KM_MAX = 1000;

// Absent means a link that predates shapes, when square was the only tile — so the default
// is exact rather than a guess, and STATE_VERSION stays 1. Present-but-unrecognised still
// rejects, matching the strict flatten T/F handling.
const SHAPES = /** @type {Shape[]} */ (["square", "hex", "circle"]);

// Print preferences are clamped, not rejected: their bounds are UI choices that may widen, and an
// old link should still open. Geography is different — a bad coordinate has no sane fallback, so
// it rejects the whole payload (see decodeState).
const LIMITS = {
  width: { min: 50, max: 1000 },   // tileWidthMm — printer bed
  base: { min: 1, max: 10 },       // mm
  exag: { min: 0.5, max: 4 },      // ×
  recess: { min: 0, max: 5 },      // mm
  layer: { min: 0.05, max: 0.6 },  // mm
};

/** @param {number} v @param {{min: number, max: number}} lim @returns {number} */
const clamp = (v, lim) => Math.min(lim.max, Math.max(lim.min, v));

/** Trim trailing zeros so the hash stays short and readable ("6" not "6.00").
 * @param {number} v @param {number} places @returns {string} */
const trim = (v, places) => String(Number(v.toFixed(places)));

/**
 * State → hash payload (no leading "#"). Returns "" when there's no tile to share yet.
 * Coordinates keep 5 decimals — ~1 m, far finer than any print — so the hash doesn't carry
 * float noise. lat and lon stay SEPARATE named fields rather than one "lat,lon": GeoJSON orders
 * coordinates [lon, lat] while geo: URIs and every map UI use lat,lon, and a combined field
 * would reinstate exactly the reversal ambiguity that naming them costs ~5 characters to remove.
 * @param {ShareableState} state
 * @returns {string}
 */
export function encodeState({ center, scale, tileWidthMm, base, exag, flatten, recessMm, layerMm, shape }) {
  if (!center) return "";
  return [
    `v=${STATE_VERSION}`,
    `lat=${trim(center[0], 5)}`,
    `lon=${trim(center[1], 5)}`,
    `scale=${Math.round(scale)}`,
    `width=${trim(tileWidthMm, 1)}`,
    `base=${trim(base, 2)}`,
    `exag=${trim(exag, 2)}`,
    `flatten=${flatten ? "T" : "F"}`,
    `recess=${trim(recessMm, 2)}`,
    `layer=${trim(layerMm, 3)}`,
    `shape=${shape}`,
  ].join("&");
}

/**
 * Hash payload → state, or null if it can't be trusted. Null is the app's cue to open its
 * default region: a garbage hash must never throw on the boot path.
 * @param {string} hash  with or without the leading "#"
 * @returns {ShareableState | null}
 */
export function decodeState(hash) {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  if (Number(p.get("v")) !== STATE_VERSION) return null;
  /** @param {string} k @returns {number | null} */
  const num = (k) => {
    const v = Number(p.get(k));
    return p.get(k) !== null && p.get(k) !== "" && Number.isFinite(v) ? v : null;
  };
  const lat = num("lat"), lon = num("lon"), scale = num("scale");
  const tileWidthMm = num("width"), base = num("base"), exag = num("exag");
  const recessMm = num("recess"), layerMm = num("layer");
  const flat = p.get("flatten"); // T/F, not 1/0 — reads as a flag in a hand-edited link
  if (lat === null || lon === null || scale === null || tileWidthMm === null || base === null ||
      exag === null || recessMm === null || layerMm === null) return null;
  if (flat !== "T" && flat !== "F") return null; // strict: a mangled flag is corruption, not false
  const shapeRaw = p.get("shape");
  const shape = shapeRaw === null ? "square" : shapeRaw;
  if (!SHAPES.includes(/** @type {Shape} */ (shape))) return null;
  // Geography must be exact: past the Mercator band or the antimeridian there is no tile to
  // plan, and a non-positive scale divides by zero downstream.
  if (Math.abs(lat) > MAX_MERCATOR_LAT || Math.abs(lon) > 180 || !(scale > 0)) return null;
  return {
    center: [lat, lon],
    scale,
    tileWidthMm: clamp(tileWidthMm, LIMITS.width),
    base: clamp(base, LIMITS.base),
    exag: clamp(exag, LIMITS.exag),
    flatten: flat === "T",
    recessMm: clamp(recessMm, LIMITS.recess),
    layerMm: clamp(layerMm, LIMITS.layer),
    shape: /** @type {Shape} */ (shape),
  };
}
