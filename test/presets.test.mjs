import { test } from "node:test";
import assert from "node:assert/strict";
import { PRESETS } from "../js/presets.js";
import { suggestScale } from "../js/fit.js";

const squares = PRESETS.filter((p) => p.group.startsWith("Square Tiles"));

test("preset names are unique (dropdown lookup is by name)", () => {
  const names = PRESETS.map((p) => p.name);
  assert.equal(new Set(names).size, names.length);
});

test("every preset seeds a valid center and scale", () => {
  for (const p of PRESETS) {
    const [lat, lon] = p.center;
    // ±85: Web Mercator's own bound (the lattice is Mercator-uniform, tilemath.js)
    assert.ok(lat > -85 && lat < 85 && lon >= -180 && lon <= 180, `${p.name}: bad center`);
    assert.ok(Number.isFinite(p.scale) && p.scale > 0, `${p.name}: bad scale`);
  }
});

test("boundary presets resolve to a real ring", () => {
  for (const p of PRESETS) {
    if (p.boundary) assert.ok(p.boundary.length >= 3, `${p.name}: boundary too small`);
  }
});

test("square preset scales are the 240 mm suggestScale snap of the named extent", () => {
  assert.ok(squares.length >= 20, "square group populated");
  for (const p of squares) {
    const km = Number(p.name.match(/(\d+)\s*km/)[1]);
    assert.equal(p.scale, Math.round(suggestScale(1000 * km, 1000 * km)),
      `${p.name}: scale ${p.scale}`);
  }
});
