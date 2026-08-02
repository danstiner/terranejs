import { test } from "node:test";
import assert from "node:assert/strict";
import { clipCircle, clipElevs, clipRange } from "../src/core/clip.js";

// Every crossing is an exact circle-line intersection, so it must sit ON the circle.
// This is the invariant the area test downstream depends on: the clipped footprint is
// an inscribed polygon through these points, so any drift here shows up as area error.
test("clipCircle: every crossing lies on the circle", () => {
  const clip = clipCircle(41, 41, 20.3, 20.7, 15);
  assert.ok(clip.col.length > 0, "circle produced crossings");
  for (let k = 0; k < clip.col.length; k++) {
    const ex = clip.col[k] - 20.3, ey = clip.row[k] - 20.7;
    const d = Math.sqrt(ex * ex + ey * ey);
    assert.ok(Math.abs(d - 15) < 1e-9, `crossing ${k} at radius ${d}`);
  }
});

// Both cells sharing a grid edge must resolve the same vertex id, or mesh.assembleSolid
// sees an interior boundary and builds a skirt wall through the tile. One idOf entry per
// edge key is what enforces it.
test("clipCircle: one id per grid edge, shared by both cells", () => {
  const clip = clipCircle(41, 41, 20.0, 20.0, 15);
  const ids = [...clip.idOf.values()];
  // Every allocated (non-snapped) id is used by exactly one edge.
  const allocated = ids.filter((id) => id >= 41 * 41);
  assert.equal(new Set(allocated).size, allocated.length, "no allocated id reused across edges");
  assert.equal(allocated.length, clip.col.length, "allocated ids match the crossing arrays");
});

// A circle centred on a grid vertex crosses the axes exactly at grid vertices. Those
// crossings must snap rather than allocate a coincident vertex, which would be a
// zero-area sliver in the mesh.
test("clipCircle: a crossing landing on a grid vertex snaps to it", () => {
  const gw = 41, gh = 41;
  const clip = clipCircle(gw, gh, 20, 20, 10); // integer centre and radius
  const east = 20 * gw + 30; // the vertex at (row 20, col 30), exactly on the circle
  assert.equal(clip.inside[east], 1, "on-circle vertex counts as inside");
  for (let k = 0; k < clip.col.length; k++) {
    const onVertex = Number.isInteger(clip.col[k]) && Number.isInteger(clip.row[k]);
    assert.ok(!onVertex, `crossing ${k} at (${clip.col[k]}, ${clip.row[k]}) should have snapped`);
  }
});

// A crossing's elevation is the surface sampled at the boundary: linear between the
// edge's two endpoints, matching the piecewise-linear interior.
test("clipElevs: interpolates linearly along the crossed edge", () => {
  const gw = 41, gh = 41;
  const clip = clipCircle(gw, gh, 20.5, 20.5, 12);
  const grid = new Float32Array(gw * gh);
  // elevation = col + 2*row: varies along BOTH edge orientations. `col` alone would make a
  // vertical edge's two endpoints (same column, adjacent rows) equal, so its interpolation
  // is a constant regardless of t — degenerate, and blind to a t bug on that branch.
  for (let i = 0; i < grid.length; i++) grid[i] = (i % gw) + 2 * ((i / gw) | 0);
  clipElevs(clip, grid);
  for (let k = 0; k < clip.elev.length; k++) {
    const want = clip.col[k] + 2 * clip.row[k];
    assert.ok(Math.abs(clip.elev[k] - want) < 1e-6,
      `crossing ${k}: elev ${clip.elev[k]} vs expected ${want}`);
  }
});

// The reason the "inside samples + rim crossings" decision exists: emin sets the base
// plane, and a rim crossing interpolated toward a low outside sample can sit below every
// inside sample. Inside-only statistics would put the surface under its own base.
test("clipRange: a rim crossing below every inside sample sets the minimum", () => {
  const gw = 41, gh = 41;
  const clip = clipCircle(gw, gh, 20.5, 20.5, 12);
  const grid = new Float32Array(gw * gh).fill(10);
  for (let i = 0; i < grid.length; i++) if (!clip.inside[i]) grid[i] = 0; // outside is lower
  clipElevs(clip, grid);
  const { min, max } = clipRange(grid, clip);
  assert.equal(max, 10, "inside plateau sets the max");
  assert.ok(min < 10, `rim crossing must pull the min below the inside plateau, got ${min}`);
  assert.ok(min >= 0, `min cannot go below the outside sample, got ${min}`);
});

// The root fallback (choosing −dx or +dx) happens in ~half the crossings and is invisible
// to tests without this assertion. If the snap check were one-sided (t <= EPS instead of
// |t| <= EPS), out-of-range t could silently snap to wrong vertices. This test pins that
// the fallback works and t is always in [0, 1], by asserting the expected crossing count
// (120 with both H and V fallbacks firing ~half the time each) and that et always normalizes.
test("clipCircle: every allocated crossing has et in [0, 1], fallback fires ~half the time", () => {
  const clip = clipCircle(41, 41, 20.3, 20.7, 15);
  assert.equal(clip.col.length, 120, "expected crossing count with fallback firing");
  for (let k = 0; k < clip.et.length; k++) {
    const t = clip.et[k];
    assert.ok(t >= 0 && t <= 1, `crossing ${k} has et=${t} outside [0, 1]`);
  }
});

// Review repro for the root-selection fallback: near a circle's tangent extremum, dx
// (addH) or dy (addV) → 0, so BOTH analytic roots collapse to the SAME value. If that
// shared value falls outside the edge span, the `if` swap is a no-op — there is no second
// root to fall back to — and et lands outside [0, 1] with nothing to catch it. This
// (cx, cy, R) puts a grid row within thousandths of a cell of the circle's tangent point,
// found by sweeping small radii (where one grid row spans a larger share of the tangent
// arc, making the miss more likely) rather than by construction, so it also exercises the
// ordinary crossing-detection path. Fails before the clamp (et as low as -0.0114), passes
// after (the clamp routes the case through the existing snap branch instead).
test("clipCircle: et stays in [0, 1] near a tangent grid row", () => {
  const gw = 41, gh = 41;
  const clip = clipCircle(gw, gh, 22.26313118590042, 20.950106598902494, 5.263271871954203);
  assert.ok(clip.et.length > 0, "circle produced allocated crossings");
  for (let k = 0; k < clip.et.length; k++) {
    const t = clip.et[k];
    assert.ok(t >= 0 && t <= 1, `crossing ${k} has et=${t} outside [0, 1]`);
  }
});
