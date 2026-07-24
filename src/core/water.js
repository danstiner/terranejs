// Water handling for headless bakes. Pure, DOM-free. A water mask (from the Re:Earth
// watermask tile — sea + lakes) marks the water; the pipeline clamps those masked
// vertices to one flat floor and the colour path reads the sea-level line. Two shapes,
// both from the same mask:
//   recessed — clamp the floor to −recessMm/K (a flat shelf below the coast; the recess makes
//              the blue-water colour split layer-height-agnostic). Default.
//   flat     — clamp the floor to 0 (flush); the water→land colour line is offset colorLiftMm
//              of print-Z above the water layer so the flush water still colours blue.

/** @typedef {"recessed" | "flat"} WaterMode */

/**
 * The water→land colour threshold in metres. Flat lifts it colorLiftMm of print-Z above the
 * flush water layer (threshold colorLiftMm/K m); Recessed keeps it at sea level (0).
 * @param {WaterMode | undefined} mode
 * @param {number} colorLiftMm
 * @param {number} K
 * @returns {number}
 */
export function seaLevelColorLineM(mode, colorLiftMm, K) {
  return mode === "flat" ? colorLiftMm / K : 0;
}

/**
 * Recess every masked (water) vertex to a single floor elevation, in place; land untouched.
 * @param {Float32Array} grid @param {Uint8Array} mask @param {number} floor
 */
export function recessMasked(grid, mask, floor) {
  for (let i = 0; i < grid.length; i++) if (mask[i]) grid[i] = floor;
}
