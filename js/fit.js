// Pure sizing math — no DOM, no network. Runs in the browser and under node.
//
// Model: the printed piece is a rectangular grid over the region's bounding
// box, at a user-chosen map scale (picked as mm-per-km in the UI, stored as
// the 1:N denominator). Everything else (print size, tile grid, mesh pitch)
// derives from N. Distances are true ground metres via an
// ellipsoidal metres-per-degree series at the region's centre latitude — within
// ~0.1-0.3% of topotile's UTM over these extents, no projection lib needed.

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

// Polygon area in m² (shoelace in local metres), for the coverage readout.
export function polygonAreaMeters(polygon, bbox) {
  const [s, w] = bbox;
  const { mLat, mLon } = metersPerDegree((bbox[0] + bbox[2]) / 2);
  const pts = polygon.map(([lat, lon]) => [(lon - w) * mLon, (lat - s) * mLat]);
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  }
  return Math.abs(a) / 2;
}

// Python's round(): half-to-even. Math.round() is half-up and would shift
// tile seams by one sample on exact-.5 ties (e.g. splits(2,6)).
export function roundHalfEven(x) {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff < 0.5) return f;
  if (diff > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1; // exactly .5 -> nearest even
}

// n contiguous spans over [0, size-1]; adjacent spans SHARE a boundary index
// (seams line up by construction). Port of topotile.splits.
export function splits(n, size) {
  const edges = [];
  for (let k = 0; k <= n; k++) edges.push(roundHalfEven((k * (size - 1)) / n));
  const spans = [];
  for (let k = 0; k < n; k++) spans.push([edges[k], edges[k + 1]]);
  return spans;
}

// Floor to 2 significant figures in the mm-per-km domain. Suggestions round
// DOWN so the fitted piece can only shrink below target — nearest-rounding
// could overshoot the 250 mm bed and split a fresh region into two tiles.
export function floorMmPerKm(mm) {
  if (!Number.isFinite(mm) || mm <= 0) return 1;
  const mag = 10 ** (Math.floor(Math.log10(mm)) - 1);
  return Number((Math.floor(mm / mag + 1e-9) * mag).toPrecision(2));
}

// UI formatter for mm-per-km: <=3 significant figures, trailing zeros stripped.
export const fmtMmPerKm = (v) => String(parseFloat(v.toPrecision(3)));

// Scale that makes the piece's long side ~targetLongMm (default 240 -> just
// under a 250 bed, one tile) — the sensible starting scale for a fresh region.
export function suggestScale(realW, realH, targetLongMm = 240) {
  const longM = Math.max(realW, realH);
  return 1e6 / floorMmPerKm((1000 * targetLongMm) / longM);
}

// The whole derived state for the readout. dataPostingM is the source DEM
// posting used only to clamp mesh detail (terrarium ~10 m US / ~30 m global);
// pre-fetch it's an estimate (default optimistic 10 m).
// Isotropic mesh sample pitch on the print (mm). Both axes equal so the piece
// can be printed in either orientation; the export detail tolerance is the real
// detail knob (see the exportDetail zoom ladder in app.js).
export const PITCH_MM = 0.1;

export function fit({ polygon, scale, capW = 250, capH = 250,
  pitchMm = PITCH_MM, dataPostingM = 10 }) {
  const bbox = bboxOf(polygon);
  const { realW, realH } = bboxExtentMeters(bbox);

  const widthMm = (realW * 1000) / scale;
  const heightMm = (realH * 1000) / scale;

  // − epsilon: a piece exactly at the cap (e.g. 25 km @ 1:100000 on a 250 bed)
  // must not gain a tile from float noise in the mm computation
  const nx = Math.max(1, Math.ceil(widthMm / capW - 1e-9));
  const ny = Math.max(1, Math.ceil(heightMm / capH - 1e-9));
  const tileWmm = widthMm / nx;
  const tileHmm = heightMm / ny;

  // clamp detail so we never sample finer than the data supports (ground
  // sampling >= data posting). pitch_min(mm) = posting_m * 1000 / scale.
  const pitchFloor = (dataPostingM * 1000) / scale;
  const pitch = Math.max(pitchMm, pitchFloor);
  const dataLimited = pitchFloor > pitchMm;

  // ground sampling in metres = pitch_mm * (real / print) = pitch_mm * scale/1000
  const groundM = (pitch * scale) / 1000;

  const bboxArea = realW * realH;
  const coverage = bboxArea > 0 ? polygonAreaMeters(polygon, bbox) / bboxArea : 0;

  return {
    bbox, realW, realH, scale, widthMm, heightMm, nx, ny, tileWmm, tileHmm,
    pitchMm: pitch, groundM, dataLimited, coverage,
  };
}
