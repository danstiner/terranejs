// Hypsometric altitude color bands for filament changes. Pure, DOM-free: the
// export readout, the 3MF embed, and the preview shader all consume these.
// Latitude-adjusted ecological bands — treeline/snowline decline toward the poles.

/** @typedef {[number, number, number]} RGB   0..1 per channel */
/**
 * @typedef {{ z: number, band: number, color: RGB }} ColorChange
 *   z = tile-local print-Z (mm) where the change fires; band = band entered (1..4);
 *   color = that band's [r,g,b].
 */
/** @typedef {{ emin: number, base: number, mmPerM: number, exag: number, zmax: number }} Frame */

// [r,g,b] 0..1, one per band (ascending altitude). Tunable.
/** @type {RGB[]} */
export const BAND_COLORS = [
  [0.16, 0.36, 0.55], // 0 ocean  — ≤ sea level
  [0.28, 0.48, 0.28], // 1 forest — ≤ treeline
  [0.60, 0.62, 0.38], // 2 tundra — alpine meadow/krummholz ≤ tundra line
  [0.55, 0.55, 0.55], // 3 rock   — ≤ snowline
  [0.96, 0.96, 0.96], // 4 snow   — > snowline
];

/** Band names, index-aligned with BAND_COLORS — for the legend/readout. */
export const BAND_NAMES = ["ocean", "forest", "tundra", "rock", "snow"];

/** The line crossed to ENTER band i+1, index-aligned with the thresholds array
 * ([sea level, timberline, tundra line, snowline]) — for the legend. */
export const BOUNDARY_NAMES = ["sea level", "timberline", "tundra line", "snowline"];

/** Fixed size of the preview shader's change arrays: one slot per threshold. */
export const MAX_CHANGES = BAND_COLORS.length - 1; // 4

// --- Ecological band thresholds (metres vs |latitude|) --------------------
// One base curve carries the shape: the timberline (closed-canopy forest edge) vs
// |latitude|. It plateaus across the tropics/subtropics, then descends in two slopes —
// steeper through the mid-latitudes, gentler toward the poles (the tree line falls
// ~130 m/° over 30–50° and ~75 m/° over 50–70°, reaching sea level ~70°). The tundra and
// snow lines are CONSTANT lifts off the timberline, so all four bands stay parallel and
// correctly ordered (water < forest < tundra < rock < snow) at every latitude. Numbers are
// chosen for a nice looking print, e.g. mountains have something approximating the winter
// seasonal snow-cap, rather than sticking to the conservative permanent snowline. Local
// climate significantly affects these bands, they are not monotonic or able to be described
// in a simple equation, this is meant to be a good enough approximation that will look good
// on most mountain prints. If we find a data source for tree and snow cover this can be replaced.
//
// The ~111/~64 m/° slopes are the real tree line's 130/75 scaled to this lower plateau: the
// plateau is dropped for bigger caps, with sea level held at 70° so trees still reach the
// arctic tree limit instead of vanishing several degrees early.

// Base timberline curve as control points (°|lat| → m): plateau, mid-latitude break, then
// sea level. The plateau→break and break→sea segments give the two slopes.
const TIMBERLINE_PLATEAU_M = 3500;  // tropics/subtropics plateau (tree line ~3.5–4 km)
const TIMBERLINE_PLATEAU_LAT = 30;  // ° — plateau holds equatorward of this
const TIMBERLINE_BREAK_LAT = 50;    // ° — slope break
const TIMBERLINE_BREAK_M = 1280;    // m — timberline at the break (~111 m/° above it, ~64 m/° below)
const TIMBERLINE_SEA_LAT = 70;      // ° — timberline reaches sea level (arctic tree limit)

// Constant lifts above the timberline → parallel, ordered bands (0 < tundra < snow lift):
const TUNDRA_OFFSET_M = 400;     // top of the alpine-tundra / krummholz band
const SNOWLINE_OFFSET_M = 1000;  // seasonal snow-cap line, ~1 km above the timberline

/**
 * Base timberline elevation (m) vs |lat|: a plateau up to TIMBERLINE_PLATEAU_LAT, then two
 * linear segments through (TIMBERLINE_BREAK_LAT, TIMBERLINE_BREAK_M) down to sea level at
 * TIMBERLINE_SEA_LAT. Clamped to ≥ 0.
 * @param {number} absLat
 * @returns {number}
 */
function timberlineM(absLat) {
  if (absLat <= TIMBERLINE_PLATEAU_LAT) return TIMBERLINE_PLATEAU_M;
  if (absLat <= TIMBERLINE_BREAK_LAT) {
    const f = (absLat - TIMBERLINE_PLATEAU_LAT) / (TIMBERLINE_BREAK_LAT - TIMBERLINE_PLATEAU_LAT);
    return TIMBERLINE_PLATEAU_M + f * (TIMBERLINE_BREAK_M - TIMBERLINE_PLATEAU_M);
  }
  if (absLat <= TIMBERLINE_SEA_LAT) {
    const f = (absLat - TIMBERLINE_BREAK_LAT) / (TIMBERLINE_SEA_LAT - TIMBERLINE_BREAK_LAT);
    return TIMBERLINE_BREAK_M * (1 - f);
  }
  return 0;
}

/**
 * Latitude-adjusted thresholds (m, ascending): [0, timberline, tundra, snowline]. The
 * three vegetation lines are the one timberline curve lifted by constant offsets, so they
 * stay parallel and ordered at every latitude. Ties collapse downstream (colorChanges).
 * @param {number} centerLat
 * @returns {number[]}
 */
export function bandThresholds(centerLat) {
  const timber = timberlineM(Math.abs(centerLat));
  return [0, timber, timber + TUNDRA_OFFSET_M, timber + SNOWLINE_OFFSET_M];
}

/**
 * value → band index 0..4. Generic over metres OR print-Z (same comparison).
 * Threshold is the TOP of the lower band (strict >): value 0 is water, 0+ε forest.
 * @param {number} value
 * @param {number[]} thresholds
 * @returns {number}
 */
export function bandOf(value, thresholds) {
  let b = 0;
  for (const t of thresholds) if (value > t) b++;
  return b;
}

/**
 * Band of the base plate / first-loaded filament. A threshold at or below the lowest
 * printed elevation cannot fire a mid-print change (it would sit at the base), so it
 * folds into the base band — unlike bandOf's point rule at emin.
 * @param {number} emin
 * @param {number[]} thresholds
 * @returns {number}
 */
export function baseBand(emin, thresholds) {
  let b = 0;
  for (const t of thresholds) if (t <= emin) b++;
  return b;
}

const EPS = 0.05; // mm; merge sub-layer-coincident changes

/**
 * Color changes to fire, ascending — thresholds whose print-Z lands in (base, zmax).
 * z = base + (t − emin)·mmPerM·exag; crossing threshold i enters band i+1. exag ∈
 * [0.5,4] from the slider, so K > 0. Coincident changes (within EPS — e.g. near-polar
 * ties where treeline and snowline collapse together) merge into one, keeping the
 * HIGHER band. Coincidences here are near-exact ties, so anchoring the merge to prev.z
 * is exact.
 * @param {number[]} thresholds
 * @param {Frame} frame
 * @returns {ColorChange[]}
 */
export function colorChanges(thresholds, frame) {
  const { emin, base, mmPerM, exag, zmax } = frame;
  const K = mmPerM * exag;
  /** @type {ColorChange[]} */
  const out = [];
  thresholds.forEach((t, i) => {
    const band = i + 1; // crossing threshold i enters band i+1
    const z = base + (t - emin) * K;
    if (z <= base || z >= zmax) return; // at/below the base, or above the print
    const prev = out[out.length - 1];
    if (prev && z - prev.z < EPS) { // collapsed onto the previous change:
      prev.band = band;             // keep the higher band (e.g. tundra→snow)
      prev.color = BAND_COLORS[band];
      return;
    }
    out.push({ z, band, color: BAND_COLORS[band] });
  });
  return out;
}

/** @type {(v: number) => string} */
const hex2 = (v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0");
/** @type {(rgb: RGB) => string} */
const bandHex = (rgb) => `#${hex2(rgb[0])}${hex2(rgb[1])}${hex2(rgb[2])}`;

/**
 * PrusaSlicer color-change container (Metadata/Prusa_Slicer_custom_gcode_per_print_z.xml).
 * Schema pinned to a real PrusaSlicer-saved project: <custom_gcodes_per_print_z> root,
 * one <code> per change, type="0" = ColorChange. PrusaSlicer re-resolves the actual
 * change G-code from printer settings at slice time for type 0, so gcode="M600" is a
 * portable placeholder.
 * @param {ColorChange[]} changes
 * @returns {string}
 */
export function prusaColorChangeXML(changes) {
  const codes = changes.map((c) =>
    `<code print_z="${c.z.toFixed(3)}" type="0" extruder="1" color="${bandHex(c.color)}" extra="" gcode="M600"/>`
  ).join("");
  // Prolog matches PrusaSlicer's own output byte-for-byte (lowercase utf-8 + a newline)
  // so nothing about how it reads this part back can hinge on the header.
  return `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<custom_gcodes_per_print_z bed_idx="0">` +
    codes + `<mode value="SingleExtruder"/></custom_gcodes_per_print_z>`;
}

/**
 * The base band's color as #RRGGBB — the segment below the first change previews in
 * the loaded Filament 1, so the readout surfaces this shade to load first.
 * @param {number} emin
 * @param {number[]} thresholds
 * @returns {string}
 */
export function baseColorHex(emin, thresholds) {
  return bandHex(BAND_COLORS[baseBand(emin, thresholds)]);
}
