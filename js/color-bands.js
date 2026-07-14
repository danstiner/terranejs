// Hypsometric altitude color bands for filament changes. Pure, DOM-free: the
// export readout, the 3MF embed, and the preview all consume these.

// [r,g,b] 0..1, one per band (ascending altitude).
export const BAND_COLORS = [
  [0.16, 0.36, 0.55], // 0 blue   — water  (≤ sea level)
  [0.28, 0.48, 0.28], // 1 green  — forest (≤ treeline)
  [0.60, 0.62, 0.38], // 2 tundra — alpine meadow/krummholz (≤ tundra line)
  [0.55, 0.55, 0.55], // 3 grey   — rock   (≤ snowline)
  [0.96, 0.96, 0.96], // 4 white  — snow   (> snowline)
];

const TUNDRA_M = 400; // alpine-tundra band width above the treeline (metres)

// φ = |center latitude|. Plateau-then-linear: plateaus near the equator/subtropics,
// declines poleward. Approximate & tunable; ignores the subtropical treeline hump.
export function bandThresholds(centerLat) {
  const p = Math.abs(centerLat);
  const clamp = (v, hi) => Math.max(0, Math.min(hi, v));
  const treeline = clamp((3800 * (70 - p)) / 40, 3800); // plateau ≤30°, 0 at ≥70°
  const snowline = clamp((5000 * (75 - p)) / 45, 5000); // plateau ≤30°, 0 at ≥75°
  const tundra = Math.min(treeline + TUNDRA_M, snowline);
  return [0, treeline, tundra, snowline]; // ascending; ties collapse (colorChanges)
}

// value → band index 0..4. Generic over metres OR print-Z (same comparison).
// Threshold is the TOP of the lower band (strict >): value 0 is water, 0+ε green.
export function bandOf(value, thresholds) {
  let b = 0;
  for (const t of thresholds) if (value > t) b++;
  return b;
}

// Band of the base plate / first-loaded filament. A threshold at or below the
// lowest printed elevation cannot fire a mid-print change (it would sit at the
// base), so it folds into the base band — unlike bandOf's point rule at emin.
export function baseBand(emin, thresholds) {
  let b = 0;
  for (const t of thresholds) if (t <= emin) b++;
  return b;
}

// Color changes to fire, ascending — for thresholds whose print-Z lands in
// (base, zmax). z = base + (t - emin)·mmPerM·exag; band = i+1. Assumes K>0
// (exag>0; it comes from a 0.5–4 slider). Coincident changes keep the HIGHER
// band; in this module coincidences are exact ties (identical t), so anchoring
// the merge to prev.z is exact.
export function colorChanges(thresholds, frame) {
  const { emin, base, mmPerM, exag, zmax } = frame;
  const K = mmPerM * exag;
  const EPS = 0.05; // mm; merge sub-layer-coincident changes
  const out = [];
  thresholds.forEach((t, i) => {
    const band = i + 1; // crossing threshold i enters band i+1
    const z = base + (t - emin) * K;
    if (z <= base || z >= zmax) return; // at/below base, or above the print
    const prev = out[out.length - 1];
    if (prev && z - prev.z < EPS) { // collapsed onto the previous change:
      prev.band = band;             // keep the higher band (e.g. blue→tundra)
      prev.color = BAND_COLORS[band];
      return;
    }
    out.push({ z, band, color: BAND_COLORS[band] });
  });
  return out;
}

const hex2 = (v) => Math.max(0, Math.min(255, Math.round(v * 255)))
  .toString(16).padStart(2, "0");
const bandHex = (rgb) => `#${hex2(rgb[0])}${hex2(rgb[1])}${hex2(rgb[2])}`;

// PrusaSlicer color-change container (custom gcode per print z). Structure pinned
// by the spike in the plan; type="2" = ColorChange. One <layer> per change.
export function prusaColorChangeXML(changes) {
  const layers = changes.map((c) =>
    `<layer top_z="${c.z.toFixed(3)}" type="2" extruder="1" color="${bandHex(c.color)}" gcode="M600"/>`
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<custom_gcodes_per_layer><plate><plate_idx value="0"/>` +
    layers + `<mode value="SingleExtruder"/></plate></custom_gcodes_per_layer>`;
}
