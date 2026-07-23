// Ocean handling for headless bakes. Pure, DOM-free. A coarse-grid flood-fill (see
// oceanMaskFlood) marks the sea; the pipeline clamps those masked vertices to one flat
// floor and the colour path reads the sea-level line. Two shipping shapes, both from the
// same mask:
//   recessed  — clamp the ocean floor to −recessMm/K, a flat shelf recessMm below the
//               coast. The recess separates ocean from land in print-Z, so the blue-ocean
//               colour split is layer-height-agnostic. Default.
//   flat      — clamp the ocean floor to 0 (flush at sea level). The ocean→land colour
//               line is offset colorLiftMm of print-Z above the ocean layer so the flush
//               ocean still colours blue (see seaLevelColorLineM).
// bathymetric keeps the raw sea floor (no mask, no clamp).

/** @typedef {"bathymetric" | "recessed" | "flat"} OceanMode */

// Source-zoom cap for ocean DETECTION. At/above z11 the terrarium mosaic overwrites
// coastal water with a near-sea-level land-DEM fill (~+1.2 m), so `elev ≤ 0` speckles
// the coast; z ≤ 10 is a clean, consistently-negative sea signal. See docs/specs/data-sources.md.
export const OCEAN_DETECT_ZOOM_MAX = 10;

/**
 * The ocean→land colour threshold in metres. Flat lifts it colorLiftMm of print-Z above the
 * flush ocean layer (threshold colorLiftMm/K m) so the flush ocean colours blue; Recessed /
 * bathymetric keep it at sea level (0), where Recessed supplies the gap in geometry.
 * @param {OceanMode | undefined} mode
 * @param {number} colorLiftMm  print-mm offset above the sea-level layer (Flat only, ≥ 0)
 * @param {number} K  print mm per metre of elevation (mmPerM · exag, > 0)
 * @returns {number}
 */
export function seaLevelColorLineM(mode, colorLiftMm, K) {
  return mode === "flat" ? colorLiftMm / K : 0;
}

// --- detection-mask helpers: coarse flood-fill, upsampled onto the fine grid -----------

/**
 * Per-vertex ocean mask: sea = vertices ≤ levelM that are 4-connected to the tile frame
 * edge, flood-filled inward. Open sea floods; an interior sub-sea-level basin (e.g. Death
 * Valley, −86 m) is not edge-connected, so it stays land. Run this on a COARSE grid
 * (source zoom ≤ OCEAN_DETECT_ZOOM_MAX) where the sea floor is a clean negative signal —
 * the fine grid is contaminated by the fill (see docs/specs/data-sources.md).
 * @param {Float32Array} grid @param {number} gw @param {number} gh
 * @param {number} [levelM]
 * @returns {Uint8Array}
 */
export function oceanMaskFlood(grid, gw, gh, levelM = 0) {
  const mask = new Uint8Array(gw * gh);
  /** @type {number[]} */
  const stack = [];
  /** @param {number} i */
  const push = (i) => { if (!mask[i] && grid[i] <= levelM) { mask[i] = 1; stack.push(i); } };
  for (let c = 0; c < gw; c++) { push(c); push((gh - 1) * gw + c); } // N & S edges
  for (let r = 0; r < gh; r++) { push(r * gw); push(r * gw + gw - 1); } // W & E edges
  while (stack.length) {
    const i = /** @type {number} */ (stack.pop());
    const r = (i / gw) | 0, c = i % gw;
    if (c > 0) push(i - 1);
    if (c < gw - 1) push(i + 1);
    if (r > 0) push(i - gw);
    if (r < gh - 1) push(i + gw);
  }
  return mask;
}

/**
 * Nearest-neighbour upsample of a coarse mask onto the fine grid (both cover the same
 * tile bbox, row 0 = north). The coastline lands at the coarse source-zoom resolution,
 * but free of the fine grid's fill speckle.
 * @param {Uint8Array} maskC @param {number} gwc @param {number} ghc
 * @param {number} gw @param {number} gh
 * @returns {Uint8Array}
 */
export function upsampleMask(maskC, gwc, ghc, gw, gh) {
  const out = new Uint8Array(gw * gh);
  for (let r = 0; r < gh; r++) {
    const rc = gh > 1 ? Math.round((r / (gh - 1)) * (ghc - 1)) : 0;
    for (let c = 0; c < gw; c++) {
      const cc = gw > 1 ? Math.round((c / (gw - 1)) * (gwc - 1)) : 0;
      out[r * gw + c] = maskC[rc * gwc + cc];
    }
  }
  return out;
}

/**
 * Recess every masked vertex to a single floor elevation, in place; land untouched.
 * floor = −recessMm/K sits the flat shelf recessMm of print below sea level.
 * @param {Float32Array} grid @param {Uint8Array} mask @param {number} floor
 */
export function recessMasked(grid, mask, floor) {
  for (let i = 0; i < grid.length; i++) if (mask[i]) grid[i] = floor;
}

/**
 * Extract a `cw×ch` sub-mask at offset `(cx0, cy0)` from a `gw×gh` mask — used to crop a
 * padded-detection mask down to the tile's centre cell. Pure.
 * @param {Uint8Array} mask @param {number} gw @param {number} gh
 * @param {number} cx0 @param {number} cy0 @param {number} cw @param {number} ch
 * @returns {Uint8Array}
 */
export function cropMask(mask, gw, gh, cx0, cy0, cw, ch) {
  if (cx0 < 0 || cy0 < 0 || cx0 + cw > gw || cy0 + ch > gh) throw new Error("cropMask: window outside mask");
  const out = new Uint8Array(cw * ch);
  for (let r = 0; r < ch; r++)
    for (let c = 0; c < cw; c++)
      out[r * cw + c] = mask[(cy0 + r) * gw + (cx0 + c)];
  return out;
}
