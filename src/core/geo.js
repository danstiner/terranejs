// Pure sizing/scale math for the tile-first layout — no DOM, no network.
// Runs in the browser and under node.
//
// Bbox extents and map-scale suggestion/formatting. Distances are true ground
// metres from the WGS84 closed-form radii of curvature at the region's centre
// latitude (E-W = parallel arc, N-S = meridian arc). Agrees with true geodesics
// to better than 1e-6 over tile-scale extents — orders of magnitude below print
// resolution. This module only sizes the region and picks a starting scale.

/** @typedef {import("./types.js").BBox} BBox */

const D2R = Math.PI / 180;

// WGS84 defining constants; E2 is the first eccentricity squared.
const WGS84_A = 6378137; // semi-major axis (m)
const WGS84_F = 1 / 298.257223563; // flattening
const WGS84_E2 = WGS84_F * (2 - WGS84_F);

// WGS84 metres per degree of latitude / longitude at latitude phi (deg), from
// the exact radii of curvature: metres per radian of latitude is the meridian
// radius M(φ) = a(1−e²)/(1−e²sin²φ)^1.5; per radian of longitude is the parallel
// radius N(φ)cosφ, with N(φ) = a/√(1−e²sin²φ).
/**
 * @param {number} latDeg
 * @returns {{ mLat: number, mLon: number }}
 */
export function metersPerDegree(latDeg) {
  const p = latDeg * D2R;
  const w = Math.sqrt(1 - WGS84_E2 * Math.sin(p) ** 2);
  const mLat = ((WGS84_A * (1 - WGS84_E2)) / w ** 3) * D2R;
  const mLon = (WGS84_A / w) * Math.cos(p) * D2R;
  return { mLat, mLon };
}

/**
 * @param {BBox} bbox
 * @returns {{ realW: number, realH: number, centerLat: number }}
 */
export function bboxExtentMeters([s, w, n, e]) {
  const centerLat = (s + n) / 2;
  const { mLat, mLon } = metersPerDegree(centerLat);
  return { realW: (e - w) * mLon, realH: (n - s) * mLat, centerLat };
}

// Floor to 2 significant figures in the mm-per-km domain. Suggestions round
// DOWN so the fitted piece can only shrink below target — nearest-rounding
// could overshoot the tile size and split a fresh region into two tiles.
/**
 * @param {number} mm
 * @returns {number}
 */
export function floorMmPerKm(mm) {
  if (!Number.isFinite(mm) || mm <= 0) return 1;
  const mag = 10 ** (Math.floor(Math.log10(mm)) - 1);
  return Number((Math.floor(mm / mag + 1e-9) * mag).toPrecision(2));
}

// UI formatter for mm-per-km: <=3 significant figures, trailing zeros stripped.
/**
 * @param {number} v
 * @returns {string}
 */
export const fmtMmPerKm = (v) => String(parseFloat(v.toPrecision(3)));

// Scale that makes the piece's long side ~targetLongMm. The 240 default is the
// original one-bed target the presets were baked against; the GPX call site
// passes a tileWmm-derived target explicitly.
/**
 * @param {number} realW
 * @param {number} realH
 * @param {number} [targetLongMm]
 * @returns {number}
 */
export function suggestScale(realW, realH, targetLongMm = 240) {
  const longM = Math.max(realW, realH);
  return 1e6 / floorMmPerKm((1000 * targetLongMm) / longM);
}
