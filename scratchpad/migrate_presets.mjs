// One-time: convert bbox/boundary presets to hard-coded {center, scale}
// literals for the tile-first UI. Prints a review table (stderr) and the new
// PRESETS body (stdout). Boundary presets keep their outline reference.
import { PRESETS } from "../js/presets.js";
import { bboxExtentMeters, bboxOf, suggestScale } from "../js/fit.js";

const rows = [];
const out = [];
for (const p of PRESETS) {
  const bbox = p.bbox ?? bboxOf(p.boundary);
  const [s, w, n, e] = bbox;
  const { realW, realH } = bboxExtentMeters(bbox);
  const center = [((s + n) / 2).toFixed(4), ((w + e) / 2).toFixed(4)];
  const scale = suggestScale(realW, realH);
  const mmKm = 1e6 / scale;
  rows.push(`${p.name} | ${(realW / 1000).toFixed(0)}×${(realH / 1000).toFixed(0)} km | ` +
    `[${center}] | 1:${Math.round(scale)} | ${mmKm.toPrecision(2)} mm/km | ` +
    `tile≈${(250 * scale / 1e6).toFixed(0)} km`);
  const bnd = p.boundary ? `, boundary: b(${JSON.stringify(p.name)})` : "";
  out.push(`  { group: ${JSON.stringify(p.group)}, name: ${JSON.stringify(p.name)}, ` +
    `center: [${center}], scale: ${Math.round(scale)}${bnd} },`);
}
console.error(rows.join("\n"));
console.log(out.join("\n"));
