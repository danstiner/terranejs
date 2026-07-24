// Water handling for headless bakes. Pure, DOM-free. The Re:Earth watermask marks all water
// (sea + lakes + rivers); we anchor the water/land colour line to the tile's OWN lowest water
// and recess that water below the land, so the low water prints blue and the terrain bands up
// from there — a per-tile anchor, not absolute sea level. Colour is per-print-Z (one M600 change
// recolours the whole cross-section below a height), so this geometric separation is what lets
// same-height water and land differ in colour. See docs/specs/data-pipeline.md §4a and
// docs/superpowers/specs/2026-07-23-water-anchor-recess-design.md.

/** Print-Z gap from the water surface up to the water→land M600 swap: ≥ one 0.15 mm layer, so
 * the water's top layer prints blue and the swap fires just above it. */
export const COLOR_LIFT_MM = 0.15;
/** Minimum recess gate: always pull water within this of the tile's lowest water down to the base
 * so the lowest body reads blue. The Max-recess slider extends the gate above this to pull higher
 * water bodies (a reservoir, a lake) down too — see applyWaterRecess. */
export const WATER_GATE_M = 10;
/** Manual-mode warning threshold: warn when more than this % of land would print blue. */
export const LAND_BLUE_WARN_PCT = 15;
/** Auto floors its effective recess here (= 2·COLOR_LIFT_MM) so the colour line always clears the
 * land by ≥ COLOR_LIFT_MM/K — a bare relief cap could push it below the lift and re-blue the land. */
export const AUTO_MIN_RECESS_MM = 2 * COLOR_LIFT_MM;

/**
 * Anchor the water colour line and recess the low water for one bake, in place. Reads
 * waterMin/landMin from the grid BEFORE mutating, flattens masked cells within WATER_GATE_M of the
 * lowest water to one floor, and reports the colour line + how much land still prints blue. No mask
 * (or no water cells) → no mutation, lineElev 0.
 * @param {Float32Array} grid  elevation grid cropped to the bake window; MUTATED in place
 * @param {Uint8Array | undefined} mask  1 = water, 0 = land, index-aligned with grid
 * @param {{ mode: "auto" | "manual", recessMm: number, K: number }} opts
 *   mode = auto (land-aware anchor, relief-capped) | manual (from the water surface); recessMm =
 *   slider (max recess in auto, exact in manual); K = mmPerM·exag (print mm per metre).
 * @returns {{ lineElev: number, landBluePct: number }}
 */
export function applyWaterRecess(grid, mask, { mode, recessMm, K }) {
  if (!mask) return { lineElev: 0, landBluePct: 0 };
  // Pass 1 — tile stats, read before the recess mutates any cell.
  let waterMin = Infinity, landMin = Infinity, landCount = 0;
  for (let i = 0; i < grid.length; i++) {
    if (mask[i]) { if (grid[i] < waterMin) waterMin = grid[i]; }
    else { if (grid[i] < landMin) landMin = grid[i]; landCount++; }
  }
  if (waterMin === Infinity) return { lineElev: 0, landBluePct: 0 }; // no water on the tile
  const hasLand = landCount > 0;
  // Both modes recess from the water surface. Manual uses the slider directly. Auto recesses only
  // as far as needed to drop the colour line below the LOWEST land — COLOR_LIFT_MM plus however far
  // that land dips below the water — floored so the water always prints blue and capped by the
  // Max-recess slider. On a normal coast (land at or above the water) `neededMm ≤ COLOR_LIFT_MM`, so
  // this is just the floor and the slider does not change the recess; the slider only bites when
  // land sits far enough below the water that the needed recess exceeds it.
  const neededMm = hasLand ? COLOR_LIFT_MM + (waterMin - landMin) * K : AUTO_MIN_RECESS_MM;
  const effRecessMm = mode === "auto"
    ? Math.max(AUTO_MIN_RECESS_MM, Math.min(recessMm, neededMm))
    : recessMm;
  const floorElev = waterMin - effRecessMm / K;
  // Auto never blues the land: if the recess can't drop the colour line below the LOWEST land (Max
  // recess too low with land sitting below the water — e.g. a deep valley far under a small lake),
  // cap the line at that land. Then low land keeps its terrain colour and the water reads as land
  // (green) rather than bleeding blue onto it. Manual leaves it to the user (the landBluePct
  // warning flags leftover blue land instead of hiding it).
  let lineElev = floorElev + COLOR_LIFT_MM / K;
  if (mode === "auto" && hasLand) lineElev = Math.min(lineElev, landMin);
  // Pass 2 — recess water to the floor; count land that renders blue (elev < line, matching the
  // preview shader's ≥ boundary). The gate reaches recessMm/K above the lowest water (min
  // WATER_GATE_M); any water body within it is flattened to the floor. So raising Max recess pulls
  // higher lakes/reservoirs down to the blue base — the holes stay bounded (a caught body drops the
  // gate reach plus the floor depth, up to ~2× recessMm) — while water past the gate keeps its
  // elevation.
  const gate = waterMin + Math.max(WATER_GATE_M, recessMm / K);
  let landBlue = 0;
  for (let i = 0; i < grid.length; i++) {
    if (mask[i]) { if (grid[i] <= gate) grid[i] = floorElev; }
    else if (grid[i] < lineElev) landBlue++;
  }
  return { lineElev, landBluePct: hasLand ? (100 * landBlue) / landCount : 0 };
}
