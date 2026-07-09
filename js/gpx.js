// Minimal GPX track parser: <trkpt lat lon> grouped by <trkseg>, falling back
// to route points (<rtept>) for files without a track. Regex-based rather than
// DOMParser — tracker-written GPX is regular, and this runs identically in the
// browser and under node tests.

// value grammar: optional sign, optional exponent; lat/lon compiled once
const NUM = String.raw`[+-]?[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?`;
const LAT = new RegExp(String.raw`\blat\s*=\s*["'](` + NUM + `)["']`);
const LON = new RegExp(String.raw`\blon\s*=\s*["'](` + NUM + `)["']`);
const attr = (attrs, re) => { const m = re.exec(attrs); return m ? Number(m[1]) : NaN; };

// text -> [[[lat,lon],…], …], one array per segment; segments under 2 points dropped
export function parseGPX(text) {
  // one segment per block; try the most specific container first so distinct
  // tracks/routes never weld into one segment with a phantom connecting leg
  let blocks = text.match(/<trkseg[\s\S]*?<\/trkseg>/g);
  let tag = "trkpt";
  if (!blocks) {
    const trks = text.match(/<trk\b[\s\S]*?<\/trk>/g);
    const rtes = text.match(/<rte\b[\s\S]*?<\/rte>/g);
    if (trks) { blocks = trks; tag = "trkpt"; }
    else if (rtes) { blocks = rtes; tag = "rtept"; }
    else {
      blocks = /<(trkpt|rtept)\b/.test(text) ? [text] : [];
      tag = /<trkpt\b/.test(text) ? "trkpt" : "rtept";
    }
  }
  const segs = [];
  for (const block of blocks) {
    const pts = [];
    const re = new RegExp(String.raw`<(?:\w+:)?` + tag + String.raw`\b([^>]*)`, "g");
    let m;
    while ((m = re.exec(block))) {
      const lat = attr(m[1], LAT), lon = attr(m[1], LON);
      if (Number.isFinite(lat) && Number.isFinite(lon)) pts.push([lat, lon]);
    }
    if (pts.length >= 2) segs.push(pts);
  }
  return segs;
}

// bbox [S,W,N,E] of all segments, padded by `pad` (fraction of each span)
export function trackBbox(segments, pad = 0.1) {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const seg of segments) {
    for (const [lat, lon] of seg) {
      if (lat < s) s = lat;
      if (lat > n) n = lat;
      if (lon < w) w = lon;
      if (lon > e) e = lon;
    }
  }
  const dLat = Math.max(1e-4, (n - s) * pad), dLon = Math.max(1e-4, (e - w) * pad);
  return [s - dLat, w - dLon, n + dLat, e + dLon];
}
