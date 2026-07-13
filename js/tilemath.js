// Pure Web-Mercator / tile math. 256-px tiles (terrarium). No DOM.
const D2R = Math.PI / 180;
const C = 156543.03392; // ground metres per pixel at z0, equator

export function groundResolution(latDeg, z) {
  return (C * Math.cos(latDeg * D2R)) / 2 ** z;
}

// Continuous global pixel coordinate (0 at world edge; integer = tile boundary).
export function lonToGlobalX(lon, z) {
  return ((lon + 180) / 360) * 256 * 2 ** z;
}
export function latToGlobalY(lat, z) {
  const s = Math.sin(lat * D2R);
  const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  return y * 256 * 2 ** z;
}

// Zoom whose pixel ground-resolution ≈ the target sample step (match the
// print's detail to the data, like topotile matches posting to res_m).
export function pickZoom(resM, latDeg, maxZoom = 15) {
  const ideal = Math.log2((C * Math.cos(latDeg * D2R)) / resM);
  const z = Math.max(0, Math.min(maxZoom, Math.round(ideal)));
  const pxM = groundResolution(latDeg, z);
  return { z, pxM, upsampled: pxM > resM * 1.4 };
}

// Tile index range (inclusive) covering a bbox at zoom z, padded by haloPx so
// bilinear sampling never reads outside the mosaic.
export function tileRangeForBBox([s, w, n, e], z, haloPx = 1) {
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

export function globalXToLon(gx, z) {
  return (gx / (256 * 2 ** z)) * 360 - 180;
}
export function globalYToLat(gy, z) {
  const y = 0.5 - gy / (256 * 2 ** z);
  return (2 * Math.atan(Math.exp(2 * Math.PI * y)) - Math.PI / 2) / D2R;
}

// Print-mm span of one pixel at zoom z on a 1:scale map.
export function printPitchMm(latDeg, z, scale) {
  return (groundResolution(latDeg, z) / scale) * 1000;
}

// Finer than this buys nothing on a printer: G-code resolution (~0.0125 mm)
// and the 0.4 mm nozzle discard sub-0.1 mm surface detail.
export const PITCH_FLOOR_MM = 0.1;

// Deepest useful export zoom: shallowest z whose print pitch is at or below
// the floor, clamped to the pyramid max and the whole-region tile budget.
export function sourceZoom(bbox, latDeg, scale, maxTiles,
  floorMm = PITCH_FLOOR_MM, maxZoom = 15) {
  let z = 1;
  while (z < maxZoom && printPitchMm(latDeg, z, scale) > floorMm) z++;
  // z floors at 1: with a pathological budget the invariant can't be met
  while (z > 1 && tileRangeForBBox(bbox, z).count > maxTiles) z--;
  return z;
}
