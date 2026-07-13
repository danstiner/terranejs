// HISTORICAL — ran against the pre-removal boundaries.js (deleted in the
// boundary-removal sweep); re-running would crash on the import. Kept with
// its outputs (presets_curated.txt, test/reference/park_bboxes.json) as the
// curation record.
// One-time: rebake all presets for the 220 mm default tile and the
// tile-first model. Parks get hand-curated feature centers anchored on a
// rule-of-thirds point (per-axis span minimization keeps non-park area out);
// states use their bbox center; cores/peaks retarget 240->220 by pure ratio.
// Emits the PRESETS body (stdout), a review table (stderr), and
// test/reference/park_bboxes.json so the coverage invariant outlives the
// boundaries.js deletion. Run BEFORE the deletion task.
import { writeFileSync } from "node:fs";
import { BOUNDARIES } from "../js/boundaries.js";
import { PRESETS } from "../js/presets.js";
import { bboxOf, floorMmPerKm } from "../js/fit.js";
import { lonToGlobalX, latToGlobalY, globalXToLon, globalYToLat } from "../js/tilemath.js";

const TILE_MM = 220;
// hand-curated iconic features (lat, lon)
const FEATURES = {
  "Great Smoky Mtns National Park": ["Clingmans Dome", 35.5629, -83.4985],
  "Zion National Park": ["Angels Landing", 37.2690, -112.9469],
  "Grand Canyon National Park": ["Mather Point", 36.0616, -112.1078],
  "Yellowstone National Park": ["Old Faithful", 44.4605, -110.8281],
  "Rocky Mountain National Park": ["Longs Peak", 40.2549, -105.6151],
  "Yosemite National Park": ["Half Dome", 37.7459, -119.5332],
  "Acadia National Park": ["Cadillac Mtn", 44.3528, -68.2247],
  "Olympic National Park": ["Mt Olympus", 47.8013, -123.7108],
  "Grand Teton National Park": ["Grand Teton", 43.7412, -110.8024],
  "Glacier National Park": ["Logan Pass", 48.6967, -113.7181],
  "Mt Rainier National Park": ["Columbia Crest", 46.8523, -121.7603],
  "Crater Lake National Park": ["Crater center", 42.9446, -122.1090],
  "Death Valley National Park": ["Badwater Basin", 36.2461, -116.8253],
};
const THIRDS = [1 / 3, 1 / 2, 2 / 3];
// ground km per z0 global px at a latitude (Mercator local scale)
const kmPerPx = (lat) => (Math.cos((lat * Math.PI) / 180) * 40075.016686) / 256;

const rows = [], out = [], bboxes = {};

function curatePark(name) {
  const [featName, fLat, fLon] = FEATURES[name];
  const bbox = bboxOf(BOUNDARIES[name]);
  bboxes[name] = bbox;
  const [s, w, n, e] = bbox;
  const gx = lonToGlobalX(fLon, 0), gy = latToGlobalY(fLat, 0);
  const dW = gx - lonToGlobalX(w, 0), dE = lonToGlobalX(e, 0) - gx;
  const dN = gy - latToGlobalY(n, 0), dS = latToGlobalY(s, 0) - gy;
  // per-axis: smallest span that covers both sides with the feature at f
  const best = (dLo, dHi) => {
    let f = 0.5, span = Infinity;
    for (const cand of THIRDS) {
      const sp = Math.max(dLo / cand, dHi / (1 - cand));
      if (sp < span) { span = sp; f = cand; }
    }
    return { f, span };
  };
  const bx = best(dW, dE), by = best(dN, dS);
  const needPx = Math.max(bx.span, by.span);
  const needKm = needPx * kmPerPx(fLat);
  const mm = floorMmPerKm(TILE_MM / needKm); // floor -> MORE coverage
  const scale = 1e6 / mm;
  const actualPx = (TILE_MM * scale) / 1e6 / kmPerPx(fLat);
  // feature stays exactly on its thirds point of the ACTUAL (post-floor) tile
  const cx = gx + (0.5 - bx.f) * actualPx;
  const cy = gy + (0.5 - by.f) * actualPx;
  const center = [globalYToLat(cy, 0), globalXToLon(cx, 0)];
  // self-check: tile edges cover the bbox
  const x0 = cx - actualPx / 2, x1 = cx + actualPx / 2;
  const y0 = cy - actualPx / 2, y1 = cy + actualPx / 2;
  const ok = x0 <= lonToGlobalX(w, 0) && x1 >= lonToGlobalX(e, 0) &&
    y0 <= latToGlobalY(n, 0) && y1 >= latToGlobalY(s, 0);
  const slackX = (((actualPx - bx.span) / actualPx) * 100).toFixed(0);
  const slackY = (((actualPx - by.span) / actualPx) * 100).toFixed(0);
  rows.push(`${name} | ${featName} @ (${bx.f.toFixed(2)},${by.f.toFixed(2)}) | ` +
    `tile ${((TILE_MM * scale) / 1e6).toFixed(0)} km | slack ${slackX}%/${slackY}% | ` +
    `${ok ? "COVER OK" : "COVER FAIL"}`);
  if (!ok) process.exitCode = 1;
  return { center: [center[0].toFixed(4), center[1].toFixed(4)], scale: Math.round(scale) };
}

function curateState(name) {
  const bbox = bboxOf(BOUNDARIES[name]);
  bboxes[name] = bbox;
  const [s, w, n, e] = bbox;
  const cLat = (s + n) / 2;
  const spanKm = Math.max(
    (lonToGlobalX(e, 0) - lonToGlobalX(w, 0)) * kmPerPx(cLat),
    (latToGlobalY(s, 0) - latToGlobalY(n, 0)) * kmPerPx(cLat));
  const scale = 1e6 / floorMmPerKm(TILE_MM / spanKm);
  rows.push(`${name} | bbox center | tile ${((TILE_MM * scale) / 1e6).toFixed(0)} km`);
  return { center: [(((s + n) / 2)).toFixed(4), (((w + e) / 2)).toFixed(4)], scale: Math.round(scale) };
}

for (const p of PRESETS) {
  if (p.group === "Square Tiles (single print)") continue; // deleted group
  let entry;
  if (FEATURES[p.name]) entry = curatePark(p.name);
  else if (p.boundary) entry = curateState(p.name);
  else {
    // cores/peaks: retarget 240 -> 220 by pure ratio, floored toward coverage
    const scale = Math.round(1e6 / floorMmPerKm((220 / 240) * (1e6 / p.scale)));
    rows.push(`${p.name} | ratio retarget | 1:${p.scale} -> 1:${scale}`);
    entry = { center: [p.center[0].toFixed(4), p.center[1].toFixed(4)], scale };
  }
  out.push(`  { group: ${JSON.stringify(p.group)}, name: ${JSON.stringify(p.name)}, ` +
    `center: [${entry.center}], scale: ${entry.scale} },`);
}
writeFileSync(new URL("../test/reference/park_bboxes.json", import.meta.url),
  JSON.stringify(bboxes, null, 1) + "\n");
console.error(rows.join("\n"));
console.log(out.join("\n"));
