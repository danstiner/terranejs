import { test } from "node:test";
import assert from "node:assert/strict";
import { roseMarks } from "../src/ui/compass.js";

const R = 18;
const SIN_HOME = 0.57; // the home view's elevation, sin(34.75 deg)
/** @param {number} a @param {number} b @param {string} what */
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-12, `${what}: ${a} != ${b}`);

// SVG y grows DOWNWARD, so "up-screen" is negative y. These four are the checks the design was
// derived against; they are the reason the sign of the y term is what it is.

test("camera due south puts north straight up-screen", () => {
  const [n] = roseMarks(Math.PI, SIN_HOME, R);
  near(n.x, 0, "x");
  near(n.y, -R * SIN_HOME, "y"); // negative = up
});

test("camera due east puts north at screen right, on the horizontal axis", () => {
  const [n] = roseMarks(Math.PI / 2, SIN_HOME, R);
  near(n.x, R, "x");
  near(n.y, 0, "y");
});

test("camera due north puts north down-screen, behind the terrain", () => {
  const [n] = roseMarks(0, SIN_HOME, R);
  near(n.x, 0, "x");
  near(n.y, R * SIN_HOME, "y"); // positive = down
});

test("marks are ordered N, E, S, W", () => {
  // From the south the tile reads like a map: N up, E right, S down, W left.
  const [n, e, s, w] = roseMarks(Math.PI, SIN_HOME, R);
  assert.ok(n.y < 0 && s.y > 0, "N above S");
  assert.ok(e.x > 0 && w.x < 0, "E right of W");
  near(e.y, 0, "E on the axis");
  near(w.y, 0, "W on the axis");
});

test("opposite bearings are antipodal at every azimuth", () => {
  for (const az of [0, 0.3, 1, Math.PI, 4.2, -2]) {
    const [n, e, s, w] = roseMarks(az, SIN_HOME, R);
    near(s.x, -n.x, "S.x"); near(s.y, -n.y, "S.y");
    near(w.x, -e.x, "W.x"); near(w.y, -e.y, "W.y");
  }
});

// The locus is an axis-aligned ellipse (semi-axes r and r*sin(phi)), which is precisely what a
// rotate()/scaleY() transform would NOT produce — it tilts the axes. Pinning the invariant here
// keeps a future "simplification" to a CSS transform from passing quietly.
test("every mark lies on the axis-aligned ellipse", () => {
  for (const sinPhi of [0.2, SIN_HOME, 0.99]) {
    for (const p of roseMarks(1.1, sinPhi, R)) {
      near((p.x / R) ** 2 + (p.y / (R * sinPhi)) ** 2, 1, "on the ellipse");
    }
  }
});

test("a camera below the plane mirrors the marks in y", () => {
  const above = roseMarks(2.4, SIN_HOME, R);
  const below = roseMarks(2.4, -SIN_HOME, R);
  above.forEach((p, i) => { near(below[i].x, p.x, "x held"); near(below[i].y, -p.y, "y mirrored"); });
});

// Straight overhead is unreachable through OrbitControls (it clamps the polar angle away from
// zero, since camera.up parallel to the view direction has no basis), so this is a finiteness
// guard for the atan2(0, 0) that preview.js would feed in, not a view anyone can see.
test("the degenerate overhead camera yields finite marks", () => {
  for (const p of roseMarks(0, 1, R)) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), "finite");
  }
});

test("grazing pitch keeps N and S distinct along x", () => {
  const [n, , s] = roseMarks(Math.PI / 3, 0, R); // disc is a line; letters must not collide
  near(n.y, 0, "N.y"); near(s.y, 0, "S.y");
  assert.ok(Math.abs(n.x - s.x) > 1, "N and S separated");
});
