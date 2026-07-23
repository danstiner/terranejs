// Ocean handling for headless bakes. Pure, DOM-free. An ocean mask (from the Re:Earth watermask
// tile) marks the sea; the pipeline clamps those masked vertices to one flat floor and the
// colour path reads the sea-level line. Two shapes, both from the same mask:
//   recessed — clamp the floor to −recessMm/K (a flat shelf below the coast; the recess makes
//              the blue-ocean colour split layer-height-agnostic). Default.
//   flat     — clamp the floor to 0 (flush); the ocean→land colour line is offset colorLiftMm
//              of print-Z above the ocean layer so the flush ocean still colours blue.

/** @typedef {"bathymetric" | "recessed" | "flat"} OceanMode */

/**
 * The ocean→land colour threshold in metres. Flat lifts it colorLiftMm of print-Z above the
 * flush ocean layer (threshold colorLiftMm/K m); Recessed / bathymetric keep it at sea level (0).
 * @param {OceanMode | undefined} mode
 * @param {number} colorLiftMm
 * @param {number} K
 * @returns {number}
 */
export function seaLevelColorLineM(mode, colorLiftMm, K) {
  return mode === "flat" ? colorLiftMm / K : 0;
}

/**
 * Recess every masked (ocean) vertex to a single floor elevation, in place; land untouched.
 * @param {Float32Array} grid @param {Uint8Array} mask @param {number} floor
 */
export function recessMasked(grid, mask, floor) {
  for (let i = 0; i < grid.length; i++) if (mask[i]) grid[i] = floor;
}
