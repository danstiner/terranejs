import { test } from "node:test";
import assert from "node:assert/strict";
import { PRESETS, DEFAULT_PRESET } from "../src/ui/presets.js";
import { planSquareTile } from "../src/core/pipeline.js";
import { MAX_MERCATOR_LAT } from "../src/core/tilemath.js";

// Every seed preset must yield an in-bounds, valid plan at the default print
// width — catches a fat-fingered coordinate or scale at test time, not in the
// browser. (Centre-on-feature accuracy is a visual check, not a unit test.)
test("every preset yields a valid in-bounds plan", () => {
  for (const p of PRESETS) {
    assert.ok(p.name.length > 0, "name non-empty");
    assert.ok(p.group === "Terrane" || p.group === "Park", `${p.name}: bad group ${p.group}`);
    const [lat, lon] = p.center;
    assert.ok(Math.abs(lat) <= MAX_MERCATOR_LAT, `${p.name}: lat ${lat} out of Mercator band`);
    assert.ok(Math.abs(lon) <= 180, `${p.name}: lon ${lon} out of range`);
    assert.ok(Number.isFinite(p.scale) && p.scale > 0, `${p.name}: bad scale ${p.scale}`);
    // The core planner throws on an out-of-bounds tile; a preset must never do that.
    assert.doesNotThrow(
      () => planSquareTile({ ...p, tileWmm: 200, base: 6, exag: 1 }),
      `${p.name}: planSquareTile threw`);
  }
});

// Names are the <option> values and the picker's identity — must be unique.
test("preset names are unique", () => {
  const names = PRESETS.map((p) => p.name);
  assert.equal(new Set(names).size, names.length, "duplicate preset name");
});

// Default-on-load must be a real member of PRESETS. (Currently Mount Rainier — the
// "open on a terrane namesake" default is parked while the high-latitude terranes
// carry source-DEM stitching artifacts.)
test("DEFAULT_PRESET is a member of PRESETS", () => {
  assert.ok(PRESETS.includes(DEFAULT_PRESET), "DEFAULT_PRESET not in PRESETS");
});
