// Framing a tile against a trail: compute a framing that contains a set of track points, and
// measure how much of the trail any given framing cuts off. Pure and DOM-free.
//
// Both directions, deliberately — clippedFraction is not an autofit postscript. It runs against
// whatever framing is current, which is how the UI can warn about one the user set by hand after
// declining or overriding the fit.
//
// Reading the GPX file itself lives in src/ui/gpxparse.js — parsing needs the browser's
// XML parser, which this headless half of the project cannot reach.

/** @typedef {import("./types.js").LatLon} LatLon */

import { lonToGlobalX, latToGlobalY, globalXToLon, globalYToLat, groundResolution,
  MAX_MERCATOR_LAT } from "./tilemath.js";
import { tileSpanPx } from "./layout.js";
import { MM_PER_KM_MIN, MM_PER_KM_MAX } from "./urlstate.js";

/** @typedef {import("./types.js").Shape} Shape */

const R3 = Math.sqrt(3);

/** Margin around a fitted trail, as a fraction of its longer half-extent. */
export const FIT_PAD = 0.08;

/**
 * Is (x, y) — Mercator pixels relative to the tile center — inside a footprint
 * whose bounding square has side S?
 *
 * This is the statement of "inside the tile". clippedFraction evaluates it directly;
 * fitTile carries it solved for S, per shape, since a closed form beats searching for
 * the smallest S that satisfies it. Those solutions are derived from the inequalities
 * below but written separately, so editing one does NOT update the other — the
 * "fitTile leaves nothing clipped" test is the only thing holding them in sync.
 *
 * Mercator pixels rather than lat/lon because every footprint edge is straight
 * in that frame; a hex or circle ring's edges are not straight in lat/lon.
 *
 * True for square and hex; for circle the test is the true circle, but the printed
 * footprint is `pipeline.js`'s inscribed n-gon (16-256 sides, 1.9%-0.0075% short of
 * the radius) — the gap this fit's 8% pad absorbs. Anything that must agree with the
 * printed rim exactly, not just within the pad, needs the ring mask, not this test.
 *
 * @param {Shape} shape @param {number} S @param {number} x @param {number} y
 * @returns {boolean}
 */
export function insideFootprint(shape, S, x, y) {
  const ax = Math.abs(x), ay = Math.abs(y);
  if (shape === "square") return ax <= S / 2 && ay <= S / 2;
  if (shape === "circle") return Math.hypot(ax, ay) <= S / 2;
  // Flat-top hex, vertices (±S/2, 0) and (±S/4, ±√3S/4) — the same geometry
  // layout.footprintPx emits. The horizontal flats bound |y|; the four slanted
  // edges are the line √3|x| + |y| = √3S/2.
  return ay <= (R3 / 4) * S && R3 * ax + ay <= (R3 / 2) * S;
}

/**
 * Trail bounds in z0 global Mercator pixels: center and half-extents.
 *
 * Mercator, not degrees: the tile is a Mercator square, so a degree-space center
 * is not the center of the tile that gets built, and a degree y-extent is not
 * proportional to the Mercator y-extent it has to fit inside.
 *
 * @param {LatLon[][]} segments
 * @returns {{ gxC: number, gyC: number, a: number, b: number }}
 */
function boundsPx(segments) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, n = 0;
  for (const seg of segments) {
    for (const [lat, lon] of seg) {
      // Negated so a NaN latitude (fails any <= comparison) is caught here, with a
      // point to name, rather than surfacing as a NaN scale far downstream. Longitude
      // has no such band to violate, so its guard is a plain finiteness check.
      if (!(Math.abs(lat) <= MAX_MERCATOR_LAT)) {
        throw new Error(
          `a track point at ${lat}° is outside the ` +
          `±${MAX_MERCATOR_LAT.toFixed(4)}° Web Mercator band, where no elevation data exists`);
      }
      if (!Number.isFinite(lon)) {
        throw new Error(`a track point has a non-finite longitude: ${lon}`);
      }
      const x = lonToGlobalX(lon, 0), y = latToGlobalY(lat, 0);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      n++;
    }
  }
  if (n < 2) throw new Error("the trail has fewer than 2 track points");
  // Mercator x wraps, so an antimeridian-crossing trail reads as spanning nearly
  // the whole world and would silently fit a planet-sized tile.
  if (x1 - x0 > 128) throw new Error("the trail crosses the antimeridian, which is not supported");
  const a = (x1 - x0) / 2, b = (y1 - y0) / 2;
  if (a === 0 && b === 0) throw new Error("every track point is at the same place — nothing to frame");
  return { gxC: (x0 + x1) / 2, gyC: (y0 + y1) / 2, a, b };
}

/**
 * Floor to 2 significant figures, within the range the scale input accepts. Flooring in the
 * mm-per-km domain is the SAFE direction: fewer mm per km means one printed millimeter covers
 * more ground, so the tile can only grow and the trail can only gain clearance — never lose it
 * to a rounding step.
 *
 * Clamping to MM_PER_KM_MAX is safe the same way — it can only widen the tile, so a trail that
 * fit before still fits. MM_PER_KM_MIN is the one bound that can clip, since it caps how much
 * ground a tile may cover, but it bottoms out around 20000 km of ground: a trail that hits it
 * has left the printable domain, and the clip warning is then the honest answer.
 * @param {number} mm @returns {number}
 */
function floorMmPerKm(mm) {
  if (!Number.isFinite(mm) || mm <= 0) return MM_PER_KM_MIN;
  if (mm > MM_PER_KM_MAX) return MM_PER_KM_MAX;
  const mag = 10 ** (Math.floor(Math.log10(mm)) - 1);
  // The epsilon rescues a value that is already on a step and lands a few ulp below it
  // (…2.9999999999996), which would otherwise floor a whole step down.
  return Math.max(MM_PER_KM_MIN, Number((Math.floor(mm / mag + 1e-9) * mag).toPrecision(2)));
}

/**
 * Frame a tile around the trail: center on its Mercator bounds, then solve the
 * scale whose footprint contains it with a margin. Print width is held constant
 * — it is a printer-bed constraint — so scale is the free variable.
 *
 * @param {LatLon[][]} segments
 * @param {{ tileWidthMm: number, shape?: Shape, pad?: number }} opts
 * @returns {{ center: LatLon, scale: number }}
 */
export function fitTile(segments, { tileWidthMm, shape = "square", pad = FIT_PAD }) {
  const { gxC, gyC, a, b } = boundsPx(segments);
  // One uniform margin, evenly around the trail. A per-axis proportional pad
  // gives a trail ten times longer than it is wide ten times more clearance
  // along its length than across it, and shrinks the short axis's margin toward
  // zero exactly when the trail is most nearly a line.
  const m = pad * Math.max(a, b);
  const A = a + m, B = b + m;
  // Smallest bounding-square side whose footprint contains the corner (A, B) —
  // insideFootprint above, solved for S. For these convex origin-symmetric
  // shapes, containing that one corner contains the whole box.
  const S = shape === "square" ? 2 * Math.max(A, B)
    : shape === "circle" ? 2 * Math.hypot(A, B)
    : Math.max((4 * B) / R3, 2 * A + (2 * B) / R3);
  const center = /** @type {LatLon} */ ([globalYToLat(gyC, 0), globalXToLon(gxC, 0)]);
  // Algebraic inverse of layout.tileSpanPx. One pass, no iteration: the center —
  // and so the cos(lat) inside groundResolution — is fixed before scale is solved.
  const exact = (S * groundResolution(center[0], 0) * 1000) / tileWidthMm;
  return { center, scale: 1e6 / floorMmPerKm(1e6 / exact) };
}

/**
 * Fraction of trail length outside the tile above which the UI warns. Not any
 * nonzero value: the fit leaves an 8% margin, so anything smaller is a stray
 * float rather than a framing problem.
 */
export const TRAIL_CLIP_WARN = 0.005;

/**
 * Share of the trail's LENGTH falling outside the tile footprint, in [0, 1].
 *
 * Length, not point count: a GPS track paused at a viewpoint piles hundreds of
 * points in one spot, and a point-count measure would call that stretch most of
 * the trail.
 *
 * A segment with both endpoints inside counts wholly inside, both outside wholly
 * outside, and one of each splits half and half. The rim crossing is deliberately
 * not solved for — a real fix needs a segment-vs-convex-ring clipper. What bounds
 * the error is upstream: the parser reads <trkseg> track points and nothing else,
 * so the input is always a recorded track, and a chord spans at most one GPS
 * sample step — meters against a tile kilometers across. Sparse input would break
 * that bound, since a long chord can cross the footprint's interior with neither
 * endpoint inside it. The error is one-directional either way: by convexity a
 * both-outside segment is never truly more outside than it's counted, so this can
 * only over-warn, never mask real clipping.
 *
 * @param {LatLon[][]} segments
 * @param {{ center: LatLon, scale: number, tileWidthMm: number, shape?: Shape }} tile
 * @returns {number}
 */
export function clippedFraction(segments, { center, scale, tileWidthMm, shape = "square" }) {
  // tileSpanPx, not a local copy of the formula: the warning has to measure
  // against the same footprint the bake will build.
  const S = tileSpanPx(center[0], scale, tileWidthMm, 0);
  const gxC = lonToGlobalX(center[1], 0), gyC = latToGlobalY(center[0], 0);
  let total = 0, out = 0;
  for (const seg of segments) {
    if (seg.length < 2) continue;
    let px = lonToGlobalX(seg[0][1], 0) - gxC, py = latToGlobalY(seg[0][0], 0) - gyC;
    let pin = insideFootprint(shape, S, px, py);
    for (let i = 1; i < seg.length; i++) {
      const x = lonToGlobalX(seg[i][1], 0) - gxC, y = latToGlobalY(seg[i][0], 0) - gyC;
      const cin = insideFootprint(shape, S, x, y);
      const len = Math.hypot(x - px, y - py);
      total += len;
      out += pin === cin ? (pin ? 0 : len) : len / 2;
      px = x; py = y; pin = cin;
    }
  }
  return total > 0 ? out / total : 0;
}
