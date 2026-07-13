import { test } from "node:test";
import assert from "node:assert/strict";
import { BOUNDARIES } from "../js/boundaries.js";
import { pointInPolygon } from "../js/polyclip.js";
import { bboxOf } from "../js/fit.js";

test("every baked boundary is a valid [[lat,lon]] ring", () => {
  const names = Object.keys(BOUNDARIES);
  assert.ok(names.length >= 12, `expected the parks + WA, got ${names.length}`);
  for (const [name, ring] of Object.entries(BOUNDARIES)) {
    assert.ok(Array.isArray(ring) && ring.length >= 20, `${name}: too few points`);
    assert.ok(ring.length <= 220, `${name}: ${ring.length} pts — over the budget`);
    for (const p of ring) {
      assert.equal(p.length, 2, `${name}: point not [lat,lon]`);
      assert.ok(p[0] >= -90 && p[0] <= 90, `${name}: bad lat ${p[0]}`);
      assert.ok(p[1] >= -180 && p[1] <= 180, `${name}: bad lon ${p[1]}`);
    }
    // ring's centroid-ish point (bbox center) should fall inside the ring
    const [s, w, n, e] = bboxOf(ring);
    assert.ok(n > s && e > w, `${name}: degenerate bbox`);
  }
});

test("King County ring contains Seattle, excludes Tacoma and Everett", () => {
  const king = BOUNDARIES["King County, WA"];
  assert.ok(pointInPolygon([47.61, -122.33], king), "Seattle inside");
  assert.ok(pointInPolygon([47.475, -122.46], king), "Vashon Island inside");
  assert.ok(!pointInPolygon([47.25, -122.44], king), "Tacoma (Pierce Co) outside");
  assert.ok(!pointInPolygon([47.98, -122.20], king), "Everett (Snohomish Co) outside");
});

test("a point clearly inside a park's bbox-center tests against its ring", () => {
  // Yosemite Valley (37.745, -119.59) is inside the park boundary
  const yos = BOUNDARIES["Yosemite National Park"];
  assert.ok(pointInPolygon([37.745, -119.59], yos), "Yosemite Valley inside boundary");
  // a point far outside (San Francisco) is not
  assert.ok(!pointInPolygon([37.77, -122.42], yos), "SF outside Yosemite");
});
