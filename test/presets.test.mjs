import { test } from "node:test";
import assert from "node:assert/strict";
import { PRESETS, DEFAULT_PRESET } from "../src/ui/presets.js";
import { planTile } from "../src/core/pipeline.js";
import { MAX_MERCATOR_LAT } from "../src/core/tilemath.js";

// Every seed preset must yield an in-bounds, valid plan at the default print
// width — catches a fat-fingered coordinate or scale at test time, not in the
// browser. (Centre-on-feature accuracy is a visual check, not a unit test.)
test("every preset yields a valid in-bounds plan", () => {
  for (const p of PRESETS) {
    assert.ok(p.name.length > 0, "name non-empty");
    assert.ok(["Terrane", "Park", "Water"].includes(p.group), `${p.name}: bad group ${p.group}`);
    const [lat, lon] = p.center;
    assert.ok(Math.abs(lat) <= MAX_MERCATOR_LAT, `${p.name}: lat ${lat} out of Mercator band`);
    assert.ok(Math.abs(lon) <= 180, `${p.name}: lon ${lon} out of range`);
    assert.ok(Number.isFinite(p.scale) && p.scale > 0, `${p.name}: bad scale ${p.scale}`);
    // The core planner throws on an out-of-bounds tile; a preset must never do that.
    assert.doesNotThrow(
      () => planTile({ ...p, tileWmm: 200, base: 6, exag: 1 }),
      `${p.name}: planTile threw`);
  }
});

// The Water group is curated to exercise the water model (data-pipeline.md §4a), so it must
// keep at least one tile whose water sits BELOW sea level and one whose water sits well above
// it — the two cases where the default 0 m colour line and the flatten checkbox disagree.
test("Water presets span below-sea and high-altitude water", () => {
  const water = PRESETS.filter((p) => p.group === "Water");
  assert.ok(water.length > 0, "Water group is populated");
  assert.ok(water.some((p) => p.name === "Dead Sea"), "a below-sea-level water body");
  assert.ok(water.some((p) => p.name === "Lake Titicaca"), "a water body above the treeline");
});

// Names are the <option> values and the picker's identity — must be unique.
test("preset names are unique", () => {
  const names = PRESETS.map((p) => p.name);
  assert.equal(new Set(names).size, names.length, "duplicate preset name");
});

// Default-on-load must be a real member of PRESETS. (Currently Mount Rainier, chosen
// for legibility on first paint — see the DEFAULT_PRESET docblock.)
test("DEFAULT_PRESET is a member of PRESETS", () => {
  assert.ok(PRESETS.includes(DEFAULT_PRESET), "DEFAULT_PRESET not in PRESETS");
});

// The northern terranes are the reason this preset set was reshuffled once already: they
// were dropped when the elevation source stitched fallback data above 60°N, and restored
// when it changed. Pin them so a future source swap has to confront the decision.
test("the high-latitude Alaska terranes are present", () => {
  const terranes = PRESETS.filter((p) => p.group === "Terrane");
  for (const name of ["Wrangellia", "Yakutat", "Chugach"]) {
    assert.ok(terranes.some((p) => p.name === name), `missing terrane: ${name}`);
  }
  assert.ok(terranes.some((p) => p.center[0] > 60), "a terrane above 60°N");
});
