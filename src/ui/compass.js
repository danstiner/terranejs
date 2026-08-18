// Screen projection for the preview's compass rose. Pure — no DOM, no three.js — so the
// geometry is reachable from `node --test` while preview.js keeps the camera.

/**
 * Where the four cardinal ground directions land, in SVG coordinates (y down) about the rose's
 * center, for a camera at azimuth `az` and elevation `phi` over the tile's ground plane.
 *
 * A ground bearing b projects to (sin(az-b), -sin(phi)*cos(az-b)) in screen axes, so the whole
 * circle is an AXIS-ALIGNED ellipse squashed by sin(phi). Hence points and not a rotate/scale
 * transform: that composition tilts the ellipse's axes, and squashes the glyphs with it —
 * flattening the "N" that is the one mark on the rose that has to be read. Placing computed
 * points also makes both degenerate ends behave unaided: at grazing pitch the disc collapses to
 * a line while N and S still separate along x, and a camera below the plane gives sin(phi) < 0,
 * which swaps the marks to the far side — what the plane's underside actually looks like.
 *
 * @param {number} az     camera bearing east of north, atan2(v.x, v.y)
 * @param {number} sinPhi sine of the camera's elevation above the plane, v.z/|v|
 * @param {number} r      rose radius, in the SVG's viewBox units
 * @returns {{ x: number, y: number }[]} N, E, S, W
 */
export function roseMarks(az, sinPhi, r) {
  return [0, 1, 2, 3].map((i) => {
    const t = az - (i * Math.PI) / 2; // bearings N, E, S, W
    return { x: r * Math.sin(t), y: r * sinPhi * Math.cos(t) };
  });
}
