// GPX trail → the cell mask the ribbon solid is built over. Pure and headless: it takes a
// TilePlan and plain arrays, and knows nothing about meshes or the DOM.
//
// The trail is geometry in a different coordinate system from everything else here, so this
// file is mostly one careful conversion and one rasterization.

import { lonToGlobalX, latToGlobalY } from "./tilemath.js";
import { cellsFromVertexMask } from "./mesh.js";

/** @typedef {import("./types.js").LatLon} LatLon */
/** @typedef {import("./pipeline.js").TilePlan} TilePlan */

/**
 * Trail segments → tile-local print millimeters, one x,y-interleaved array per segment.
 *
 * The x/y expressions are copied from buildSolid's `xy(id)` deliberately: the cord has to land
 * on the terrain it was measured against, and the only way to guarantee that is to derive both
 * from the same formula. A test pins the two together — if buildSolid's mapping ever changes,
 * that test fails rather than the cord silently shifting half a cell.
 *
 * Segments stay separate. A pause/resume gap is not a leg of the trail, and welding them would
 * stamp a corridor across ground nobody walked.
 *
 * @param {LatLon[][]} segments
 * @param {TilePlan} plan
 * @returns {Float64Array[]}
 */
export function trailToPrintMm(segments, plan) {
  const { window: win, span, dx, dy, z } = plan;
  const { c0, r1 } = span;
  return segments.map((seg) => {
    const out = new Float64Array(seg.length * 2);
    for (let i = 0; i < seg.length; i++) {
      const col = lonToGlobalX(seg[i][1], z) - win.gx0;
      const row = latToGlobalY(seg[i][0], z) - win.gy0;
      out[2 * i] = (col - c0) * dx;
      out[2 * i + 1] = (r1 - row) * dy;
    }
    return out;
  });
}

/**
 * Uniform arc-length stations along one polyline.
 *
 * `carry` is what makes spacing uniform along the TRAIL rather than restarting at every
 * recorded point: GPS samples are meters apart and stations are tenths of a millimeter, so
 * without it every vertex would seed a fresh run and the stamp would clump.
 *
 * @param {Float64Array} poly x,y interleaved
 * @param {number} ds spacing in print mm
 * @returns {Float64Array}
 */
export function resample(poly, ds) {
  /** @type {number[]} */
  const out = [poly[0], poly[1]];
  let carry = 0;
  for (let i = 2; i < poly.length; i += 2) {
    const x0 = poly[i - 2], y0 = poly[i - 1], x1 = poly[i], y1 = poly[i + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (!(len > 0)) continue; // duplicate point: no direction to advance along
    let t = ds - carry;
    while (t <= len) {
      out.push(x0 + ((x1 - x0) * t) / len, y0 + ((y1 - y0) * t) / len);
      t += ds;
    }
    carry = len - (t - ds);
  }
  return Float64Array.from(out);
}

/**
 * Station spacing as a fraction of halfW.
 *
 * Consecutive disc stamps meet at a waist of sqrt(halfW² − (ds/2)²), so spacing IS a width
 * error: measured across 12 trail orientations, ds = halfW costs 4.4% of nominal width and
 * ds = halfW/2 costs 1.3%. Halving again buys 0.6% and is not worth the stations.
 */
export const DS_FACTOR = 0.5;

/**
 * Stamp radius for a requested cord width.
 *
 * The +pitch/√2 is not a fudge. A cell joins the mask only when all four of its corners are
 * inside, so the cell mask is an EROSION of the vertex mask by up to a cell half-diagonal —
 * uncompensated, a 1.6 mm cord measures 1.36–1.44 mm. Adding the half-diagonal back centers
 * the printed width on the requested one.
 *
 * @param {number} widthMm @param {number} pitchMm @returns {number}
 */
export const halfWFor = (widthMm, pitchMm) => widthMm / 2 + pitchMm / Math.SQRT2;

/**
 * Minimum cord width, in grid cells, pipeline.js refuses below. Below ~1.5 cells the corridor
 * beads into disconnected islands — each still a valid closed manifold on its own
 * (checkWatertight can't see the gap between them), so an unguarded export would silently print
 * a dotted line. Measured over 24 trail angles x 6 sub-cell offsets with halfWFor's own erosion
 * compensation in place: continuous at 1.5 cells (halfW 1.457), beaded at 1.0 (halfW 1.207). 2
 * keeps a margin over that threshold — this used to be 3, set before the compensation existed.
 *
 * The single source of the "how wide is wide enough" fact: pipeline.js's throw and the UI's
 * pre-click warning (controls.cordHint, fed by app.js) both trace back to this constant so they
 * cannot drift apart.
 */
export const MIN_CORD_CELLS = 2;

/**
 * Resampled stations → the cell mask gridTopTris consumes.
 *
 * Disc-stamped rather than swept. A stamp is idempotent, so an out-and-back trail — which
 * retraces its own path exactly, and is the commonest shape a hiker exports — yields one cord
 * instead of two interpenetrating ones. A swept solid would be non-manifold there and rejected
 * downstream, and unioning it needs a mesh boolean this repo does not have.
 *
 * `footprint` is clip.inside, a VERTEX mask, and the stamp produces one too, so they AND
 * before the cell reduction and a hex or circle rim trims the cord for free.
 *
 * @param {Float64Array[]} stations one resampled polyline per segment, print mm
 * @param {TilePlan} plan
 * @param {number} halfW
 * @param {Uint8Array} [footprint] gw×gh vertex mask; omit for square, which has none
 * @returns {{ cells: Uint8Array, count: number }}
 */
export function corridorMask(stations, plan, halfW, footprint) {
  const { gw, gh, dx, dy, span } = plan;
  // The inverse of trailToPrintMm's/buildSolid's forward map (x=(col-c0)*dx, y=(r1-row)*dy).
  // planTile always hands both this and trailToPrintMm the same full-coverage span (c0=0,
  // r1=gh-1), so hardcoding those constants here happened to agree — until a caller passes a
  // real sub-window span, which would then silently shift the corridor. Named sc0/sr1 so they
  // don't collide with the c0/r1 loop bounds below.
  const { c0: sc0, r1: sr1 } = span;
  const vert = new Uint8Array(gw * gh);
  const r2 = halfW * halfW;
  const radC = Math.ceil(halfW / dx), radR = Math.ceil(halfW / dy);
  for (const st of stations) {
    for (let j = 0; j < st.length; j += 2) {
      const px = st[j], py = st[j + 1];
      // print mm → grid indices; y is flipped, matching buildSolid's xy()
      const cc = px / dx + sc0, rr = sr1 - py / dy;
      const c0 = Math.max(0, Math.ceil(cc - radC)), c1 = Math.min(gw - 1, Math.floor(cc + radC));
      const r0 = Math.max(0, Math.ceil(rr - radR)), r1 = Math.min(gh - 1, Math.floor(rr + radR));
      for (let r = r0; r <= r1; r++) {
        const ddy = ((sr1 - r) * dy - py) ** 2;
        for (let c = c0; c <= c1; c++) {
          if (((c - sc0) * dx - px) ** 2 + ddy <= r2) vert[r * gw + c] = 1;
        }
      }
    }
  }
  // The all-four-corners rule, and the erosion it implies, live in mesh.js next to the
  // gridTopTris rule they encode — halfWFor above is the compensation for exactly that erosion,
  // so the two must not be able to drift apart.
  return cellsFromVertexMask(vert, gw, gh, footprint);
}
