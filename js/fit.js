// Pure sizing/scale math for the tile-first layout — no DOM, no network.
// Runs in the browser and under node.
//
// Bbox extents and map-scale suggestion/formatting. Distances are true
// ground metres via an ellipsoidal metres-per-degree series at the region's
// centre latitude — within ~0.1-0.3% of topotile's UTM over these extents,
// no projection lib needed. Per-tile layout constants (tile size, pixel
// pitch, grid dims) live in app.js layoutFit (consuming this module's
// PITCH_MM) — this module only sizes the region and picks a starting scale.

const D2R = Math.PI / 180;

// WGS84 metres per degree of latitude / longitude at latitude phi (deg).
export function metersPerDegree(latDeg) {
  const p = latDeg * D2R;
  const mLat = 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p)
    - 0.0023 * Math.cos(6 * p);
  const mLon = 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p)
    + 0.118 * Math.cos(5 * p);
  return { mLat, mLon };
}

export function bboxOf(polygon) {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const [lat, lon] of polygon) {
    if (lat < s) s = lat;
    if (lat > n) n = lat;
    if (lon < w) w = lon;
    if (lon > e) e = lon;
  }
  return [s, w, n, e];
}

export function bboxExtentMeters([s, w, n, e]) {
  const centerLat = (s + n) / 2;
  const { mLat, mLon } = metersPerDegree(centerLat);
  return { realW: (e - w) * mLon, realH: (n - s) * mLat, centerLat };
}

// Floor to 2 significant figures in the mm-per-km domain. Suggestions round
// DOWN so the fitted piece can only shrink below target — nearest-rounding
// could overshoot the tile size and split a fresh region into two tiles.
export function floorMmPerKm(mm) {
  if (!Number.isFinite(mm) || mm <= 0) return 1;
  const mag = 10 ** (Math.floor(Math.log10(mm)) - 1);
  return Number((Math.floor(mm / mag + 1e-9) * mag).toPrecision(2));
}

// UI formatter for mm-per-km: <=3 significant figures, trailing zeros stripped.
export const fmtMmPerKm = (v) => String(parseFloat(v.toPrecision(3)));

// Scale that makes the piece's long side ~targetLongMm. The 240 default is the
// original one-bed target the presets were baked against (see the TODO rebake
// item); the GPX call site passes a tileWmm-derived target explicitly.
export function suggestScale(realW, realH, targetLongMm = 240) {
  const longM = Math.max(realW, realH);
  return 1e6 / floorMmPerKm((1000 * targetLongMm) / longM);
}

// Isotropic mesh sample pitch on the print (mm). Both axes equal so the piece
// can be printed in either orientation; the export detail tolerance is the real
// detail knob (see the exportDetail zoom ladder in app.js).
export const PITCH_MM = 0.1;
