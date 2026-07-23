// Pure Web-Mercator / tile math. 256-px tiles (terrarium). No DOM.

/** @typedef {import("./types.js").BBox} BBox */

const D2R = Math.PI / 180;
const C = 156543.03392; // ground metres per pixel at z0, equator

/**
 * @param {number} latDeg
 * @param {number} z
 * @returns {number}
 */
export function groundResolution(latDeg, z) {
  return (C * Math.cos(latDeg * D2R)) / 2 ** z;
}

// Continuous global pixel coordinate (0 at world edge; integer = tile boundary).
/**
 * @param {number} lon
 * @param {number} z
 * @returns {number}
 */
export function lonToGlobalX(lon, z) {
  return ((lon + 180) / 360) * 256 * 2 ** z;
}
/**
 * @param {number} lat
 * @param {number} z
 * @returns {number}
 */
export function latToGlobalY(lat, z) {
  const s = Math.sin(lat * D2R);
  const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  return y * 256 * 2 ** z;
}

// Web Mercator's latitude limit (±85.0511°): the projection diverges toward the
// poles, so the world square truncates here and no source tiles exist beyond it.
// Callers must keep bboxes within ±MAX_MERCATOR_LAT.
/** @type {number} */
export const MAX_MERCATOR_LAT = Math.atan(Math.sinh(Math.PI)) / D2R;

// Zoom whose pixel ground-resolution ≈ the target sample step (match the
// print's detail to the data).
/**
 * @param {number} resM
 * @param {number} latDeg
 * @param {number} [maxZoom]
 * @returns {{ z: number, pxM: number, upsampled: boolean }}
 */
export function pickZoom(resM, latDeg, maxZoom = 14) {
  const ideal = Math.log2((C * Math.cos(latDeg * D2R)) / resM);
  const z = Math.max(0, Math.min(maxZoom, Math.round(ideal)));
  const pxM = groundResolution(latDeg, z);
  return { z, pxM, upsampled: pxM > resM * 1.4 };
}

// Tile index range (inclusive) covering a bbox at zoom z, padded by haloPx so
// bilinear sampling never reads outside the mosaic.
/**
 * @param {BBox} bbox
 * @param {number} z
 * @param {number} [haloPx]
 * @returns {{ tx0: number, tx1: number, ty0: number, ty1: number, z: number, count: number }}
 */
export function sourceTileRange([s, w, n, e], z, haloPx = 1) {
  const gx0 = lonToGlobalX(w, z), gx1 = lonToGlobalX(e, z);
  const gyN = latToGlobalY(n, z), gyS = latToGlobalY(s, z); // north = smaller y
  const px0 = Math.floor(Math.min(gx0, gx1) - haloPx);
  const px1 = Math.ceil(Math.max(gx0, gx1) + haloPx);
  const py0 = Math.floor(gyN - haloPx);
  const py1 = Math.ceil(gyS + haloPx);
  const tx0 = Math.floor(px0 / 256), tx1 = Math.floor((px1 - 1) / 256);
  const ty0 = Math.floor(py0 / 256), ty1 = Math.floor((py1 - 1) / 256);
  return { tx0, tx1, ty0, ty1, z, count: (tx1 - tx0 + 1) * (ty1 - ty0 + 1) };
}

/**
 * @param {number} gx
 * @param {number} z
 * @returns {number}
 */
export function globalXToLon(gx, z) {
  return (gx / (256 * 2 ** z)) * 360 - 180;
}
/**
 * @param {number} gy
 * @param {number} z
 * @returns {number}
 */
export function globalYToLat(gy, z) {
  const y = 0.5 - gy / (256 * 2 ** z);
  return (2 * Math.atan(Math.exp(2 * Math.PI * y)) - Math.PI / 2) / D2R;
}

// Print-mm span of one pixel at zoom z on a 1:scale map.
/**
 * @param {number} latDeg
 * @param {number} z
 * @param {number} scale
 * @returns {number}
 */
export function printPitchMm(latDeg, z, scale) {
  return (groundResolution(latDeg, z) / scale) * 1000;
}

// Consumer 3D printers use stepper motors with at best ~0.01mm steps. In
// practice repeatability is closer to ~0.05mm. Layer height/nozzle width
// are even less precise. This gives us a resolution floor, going smaller
// would only explode memory use and file size, without better quality.
/** @type {number} */
export const PITCH_FLOOR_MM = 0.05;

// Deepest useful export zoom: shallowest z whose print pitch is at or below
// the floor, clamped to the source pyramid max (Mapterhorn z14) and the whole-region tile budget.
/**
 * @param {BBox} bbox
 * @param {number} latDeg
 * @param {number} scale
 * @param {number} maxSourceTiles
 * @param {number} [floorMm]
 * @param {number} [maxZoom]
 * @returns {number}
 */
export function sourceZoom(bbox, latDeg, scale, maxSourceTiles,
  floorMm = PITCH_FLOOR_MM, maxZoom = 14) {
  let z = 1;
  while (z < maxZoom && printPitchMm(latDeg, z, scale) > floorMm) z++;
  // z floors at 1: with a pathological budget the invariant can't be met
  while (z > 1 && sourceTileRange(bbox, z).count > maxSourceTiles) z--;
  return z;
}
