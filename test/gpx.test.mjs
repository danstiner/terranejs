import { test } from "node:test";
import assert from "node:assert/strict";
import { insideFootprint, fitTile, FIT_PAD, clippedFraction, TRAIL_CLIP_WARN } from "../src/core/gpx.js";
import { tileSpanPx } from "../src/core/layout.js";
import { lonToGlobalX, latToGlobalY } from "../src/core/tilemath.js";

const R3 = Math.sqrt(3);

test("insideFootprint: rim points are in, a hair past is out", () => {
  const S = 100;
  // square: corner is the extreme point
  assert.ok(insideFootprint("square", S, 50, 50));
  assert.ok(!insideFootprint("square", S, 50.001, 50));
  // square: top edge, x away from the corner — isolates the y bound from the x one
  assert.ok(insideFootprint("square", S, 0, 50));
  assert.ok(!insideFootprint("square", S, 0, 50.001));
  // circle: the rim is the radius in every direction
  assert.ok(insideFootprint("circle", S, 30, 40));           // hypot = 50
  assert.ok(!insideFootprint("circle", S, 30, 40.001));
  // flat-top hex: (S/2, 0) is a vertex; (S/4, √3S/4) is the other vertex
  assert.ok(insideFootprint("hex", S, 50, 0));
  assert.ok(!insideFootprint("hex", S, 50, 0.001));
  assert.ok(insideFootprint("hex", S, 25, (R3 / 4) * S));
  assert.ok(!insideFootprint("hex", S, 25.001, (R3 / 4) * S));
  // hex: flat top edge at y = √3S/4
  assert.ok(insideFootprint("hex", S, 0, (R3 / 4) * S));
  assert.ok(!insideFootprint("hex", S, 0, (R3 / 4) * S + 0.001));
});

test("insideFootprint: hex excludes the bounding square's corners", () => {
  // the constraint that makes a hex fit differ from a square fit at all
  assert.ok(insideFootprint("square", 100, 49, 49));
  assert.ok(!insideFootprint("hex", 100, 49, 49));
});

/**
 * every trail point, in Mercator px relative to the fitted center
 * @param {import("../src/core/types.js").LatLon[][]} segments
 * @param {{ center: import("../src/core/types.js").LatLon, scale: number, tileWidthMm: number, shape: import("../src/core/types.js").Shape }} opts
 * @returns {[number, number, number][]}
 */
const pointsPx = (
  segments,
  { center, scale, tileWidthMm, shape }
) => {
  const S = tileSpanPx(center[0], scale, tileWidthMm, 0);
  const gxC = lonToGlobalX(center[1], 0), gyC = latToGlobalY(center[0], 0);
  return segments.flat().map(([lat, lon]) =>
    [S, lonToGlobalX(lon, 0) - gxC, latToGlobalY(lat, 0) - gyC]);
};

const TRAIL = /** @type {import("../src/core/types.js").LatLon[][]} */ ([[[47.60, -122.34], [47.65, -122.30], [47.62, -122.20], [47.70, -122.25]]]);

test("fitTile: every trail point lands inside the fitted footprint", () => {
  const SHAPES = /** @type {import("../src/core/types.js").Shape[]} */ (["square", "hex", "circle"]);
  for (const shape of SHAPES) {
    const tile = { tileWidthMm: 200, shape };
    const fit = fitTile(TRAIL, tile);
    for (const [S, x, y] of pointsPx(TRAIL, { ...fit, ...tile })) {
      assert.ok(insideFootprint(shape, S, x, y), `${shape}: (${x}, ${y}) outside span ${S}`);
    }
  }
});

test("fitTile: a hex needs a smaller scale ratio than a square (it encloses less)", () => {
  const sq = fitTile(TRAIL, { tileWidthMm: 200, shape: "square" });
  const hex = fitTile(TRAIL, { tileWidthMm: 200, shape: "hex" });
  // a hex must cover MORE ground for the same print width, i.e. a larger 1:N
  assert.ok(hex.scale > sq.scale, `hex ${hex.scale} vs square ${sq.scale}`);
});

test("fitTile: centers on the Mercator center, not the latitude midpoint", () => {
  // a tall trail at high latitude: Mercator compresses northward, so the
  // Mercator center sits NORTH of the plain latitude average
  const tall = /** @type {import("../src/core/types.js").LatLon[][]} */ ([[[60, 10], [70, 10]]]);
  const { center } = fitTile(tall, { tileWidthMm: 200, shape: "square" });
  assert.ok(center[0] > 65, `expected north of the 65° midpoint, got ${center[0]}`);
  assert.ok(Math.abs(center[1] - 10) < 1e-9, "longitude is linear in Mercator x");
});

test("fitTile: the scale rounds to 2 significant figures of mm-per-km", () => {
  const { scale } = fitTile(TRAIL, { tileWidthMm: 200, shape: "square" });
  const mmPerKm = 1e6 / scale;
  assert.equal(Number(mmPerKm.toPrecision(2)), Number(mmPerKm.toPrecision(12)));
});

test("fitTile: a zero pad puts the extreme point on the rim, never outside", () => {
  const tile = /** @type {const} */ ({ tileWidthMm: 200, shape: "square", pad: 0 });
  const fit = fitTile(TRAIL, tile);
  const pts = pointsPx(TRAIL, { ...fit, ...tile });
  assert.ok(pts.every(([S, x, y]) => insideFootprint("square", S, x, y)));
});

test("fitTile: pad widens the framing", () => {
  const tight = fitTile(TRAIL, { tileWidthMm: 200, shape: "square", pad: 0 });
  const padded = fitTile(TRAIL, { tileWidthMm: 200, shape: "square", pad: FIT_PAD });
  assert.ok(padded.scale > tight.scale);
});

test("fitTile: the margin is uniform, not shrunk toward the trail's short axis", () => {
  // ~20x longer in longitude than latitude, near the equator so the two axes map to
  // Mercator pixels at nearly the same scale — isolates the margin's shape from
  // projection distortion. A margin proportional to each axis's own half-extent
  // (rather than uniform) would shrink toward zero on this trail's short axis.
  const elongated = /** @type {import("../src/core/types.js").LatLon[][]} */ ([[[0, -10], [1, 10]]]);
  const tileWidthMm = 200;
  const fit = fitTile(elongated, { tileWidthMm, shape: "square" });
  const S = tileSpanPx(fit.center[0], fit.scale, tileWidthMm, 0);
  // The trail's own extent along its long (longitude) axis, from the input coordinates
  // directly — independent of fitTile's internals or its 2-significant-figure rounding.
  const longExtent = Math.abs(lonToGlobalX(10, 0) - lonToGlobalX(-10, 0));
  assert.ok(Math.abs(S / longExtent - (1 + FIT_PAD)) < 0.02,
    `S/longExtent = ${S / longExtent}, expected close to 1 + pad = ${1 + FIT_PAD}`);
});

test("fitTile: rejects trails it cannot frame", () => {
  assert.throws(() => fitTile([], { tileWidthMm: 200 }), /fewer than 2/);
  assert.throws(() => fitTile([[[5, 5], [5, 5]]], { tileWidthMm: 200 }), /same place/);
  assert.throws(() => fitTile([[[0, -179], [0, 179]]], { tileWidthMm: 200 }), /antimeridian/);
  assert.throws(() => fitTile([[[86, 0], [87, 1]]], { tileWidthMm: 200 }), /Mercator/);
  assert.throws(() => fitTile([[[0, NaN], [1, 1]]], { tileWidthMm: 200 }), /non-finite longitude/);
});

// A 200 mm square tile at 1:200000 covers 40 km; ~0.36° of longitude at 47.6°N.
const TILE = { center: /** @type {[number, number]} */ ([47.6, -122.3]),
  scale: 200000, tileWidthMm: 200, shape: /** @type {const} */ ("square") };

test("clippedFraction: 0 when the whole trail is inside", () => {
  const inside = /** @type {import("../src/core/types.js").LatLon[][]} */ ([[[47.60, -122.30], [47.61, -122.29], [47.60, -122.28]]]);
  assert.equal(clippedFraction(inside, TILE), 0);
});

test("clippedFraction: 1 when the whole trail is outside", () => {
  const far = /** @type {import("../src/core/types.js").LatLon[][]} */ ([[[40.0, -100.0], [40.1, -100.1]]]);
  assert.equal(clippedFraction(far, TILE), 1);
});

test("clippedFraction: a straddling segment splits half and half", () => {
  // one endpoint at the tile center, one far outside → exactly one mixed segment
  const straddle = /** @type {import("../src/core/types.js").LatLon[][]} */ ([[[47.6, -122.3], [40.0, -100.0]]]);
  assert.equal(clippedFraction(straddle, TILE), 0.5);
});

test("clippedFraction: measures length, not point count", () => {
  // 100 points piled inside (a pause at a viewpoint) plus one long leg outside.
  // By point count this trail is ~99% inside; by length it is almost all outside.
  const pause = Array.from({ length: 100 }, (_, i) =>
    /** @type {[number, number]} */ ([47.6 + i * 1e-7, -122.3]));
  const trail = [[...pause, /** @type {[number, number]} */ ([40.0, -100.0])]];
  assert.ok(clippedFraction(trail, TILE) > 0.49,
    "the pause cluster must not outvote the leg that leaves the tile");
});

test("clippedFraction: fitTile leaves nothing clipped, for every shape", () => {
  const SHAPES = /** @type {import("../src/core/types.js").Shape[]} */ (["square", "hex", "circle"]);
  for (const shape of SHAPES) {
    const fit = fitTile(TRAIL, { tileWidthMm: 200, shape });
    assert.equal(clippedFraction(TRAIL, { ...fit, tileWidthMm: 200, shape }), 0, shape);
  }
});

test("clippedFraction: fitting as a square then switching shape does clip", () => {
  // the case the warning exists for — a hex encloses ~65% of its bounding square
  const fit = fitTile(TRAIL, /** @type {const} */ ({ tileWidthMm: 200, shape: "square" }));
  const clipped = clippedFraction(TRAIL, /** @type {const} */ ({ ...fit, tileWidthMm: 200, shape: "hex" }));
  assert.ok(clipped > TRAIL_CLIP_WARN, `expected the warning to fire, got ${clipped}`);
});

test("clippedFraction: a zero-length trail is 0, not NaN", () => {
  assert.equal(clippedFraction([[[47.6, -122.3], [47.6, -122.3]]], TILE), 0);
  assert.equal(clippedFraction([], TILE), 0);
});
