import { test } from "node:test";
import assert from "node:assert/strict";
import { applyWaterRecess } from "../src/core/water.js";
import { decodeWatermask } from "../src/core/terrain.js";
import { bandOf, baseBand, colorChanges, bandThresholds, waterLineThresholds } from "../src/core/colors.js";

/** @param {number[]} elev @param {number[]} water @returns {[Float32Array, Uint8Array]} */
const tile = (elev, water) => [Float32Array.from(elev), Uint8Array.from(water)];
const K = 0.02, LAYER = 0.15;
/** @param {Partial<{flatten: boolean, recessMm: number, layerMm: number, K: number}>} [o] */
const opts = (o = {}) => ({ flatten: false, recessMm: 0, layerMm: LAYER, K, ...o });

// Kept from the old water.test.mjs — decodeWatermask lives in terrain.js but is tested nowhere
// else; the plane-model rewrite must not drop its coverage.
test("decodeWatermask: alpha>127 = ocean(1), else land(0)", () => {
  const rgba = Uint8Array.from([0,0,0,255,  0,0,0,0,  0,0,0,128,  0,0,0,127]); // 4 px
  assert.deepEqual([...decodeWatermask(rgba)], [1, 0, 1, 0]);
});

test("applyWaterRecess: no mask → no-op, colour line below all terrain", () => {
  const grid = Float32Array.from([100, 200, 300]);
  const r = applyWaterRecess(grid, undefined, opts());
  assert.deepEqual([...grid], [100, 200, 300], "grid untouched");
  assert.deepEqual(r, { lineElev: -Infinity, landBluePct: 0, waterAsLandPct: 0 });
});

test("applyWaterRecess: no water cells → no-op (waterless Death Valley stays green)", () => {
  const [grid, mask] = tile([100, -86, 300], [0, 0, 0]);
  const r = applyWaterRecess(grid, mask, opts());
  assert.deepEqual([...grid], [100, -86, 300]);
  assert.deepEqual(r, { lineElev: -Infinity, landBluePct: 0, waterAsLandPct: 0 });
});

test("applyWaterRecess: default — line at true 0 m, ocean blue, land above 0 green, no mutation", () => {
  const [grid, mask] = tile([0, 5, 20], [1, 0, 0]); // ocean 0, shore 5 m, land 20 m
  const r = applyWaterRecess(grid, mask, opts());
  assert.deepEqual([...grid], [0, 5, 20], "geometry untouched");
  assert.equal(r.lineElev, 0, "line at sea level exactly — the export pause carries the layer offset");
  assert.equal(bandOf(0, [r.lineElev]), 0, "ocean surface blue (≤ boundary)");
  assert.ok(bandOf(5, [r.lineElev]) > 0, "5 m shore green at ANY map scale");
  assert.equal(r.landBluePct, 0, "no land at/below the waterline");
});

test("applyWaterRecess: default — inland water above the anchor prints as terrain", () => {
  const [grid, mask] = tile([1890, 1900, 2100], [1, 0, 0]); // Tahoe-style tile
  const r = applyWaterRecess(grid, mask, opts());
  assert.deepEqual([...grid], [1890, 1900, 2100], "geometry untouched");
  assert.ok(bandOf(1890, [r.lineElev]) > 0, "lake reads as land — no blue on the tile");
  assert.equal(r.landBluePct, 0);
});

test("applyWaterRecess: default — polder land below 0 m counts blue (warning path, accepted)", () => {
  const [grid, mask] = tile([-2, -6, 20], [1, 0, 0]); // sea −2 m, polder −6 m
  const r = applyWaterRecess(grid, mask, opts());
  assert.equal(r.lineElev, 0);
  assert.equal(bandOf(-6, [r.lineElev]), 0, "polder prints blue below the sea-level anchor");
  assert.equal(r.landBluePct, 50, "counted so the warning can fire");
});

test("applyWaterRecess: slider only — all water sinks X/K, line unmoved, relative elevations kept", () => {
  const [grid, mask] = tile([0, 200, 300], [1, 1, 0]); // ocean + high lake
  const r = applyWaterRecess(grid, mask, opts({ recessMm: 2 })); // 2 mm = 100 m at K
  assert.equal(grid[0], -100); assert.equal(grid[1], 100); // both sank 100 m, 200 m apart still
  assert.equal(r.lineElev, 0, "line stays at the sea-level anchor");
  assert.ok(bandOf(100, [r.lineElev]) > 0, "sunk high lake still reads as terrain");
});

test("applyWaterRecess: flatten — polder plane 2 lifts below the land, land green, water blue", () => {
  // lift EXACT (0.5/0.5 = 1 m) so the boundary is float-exact. The line sits AT the plane
  // (the export pause carries the +1-layer offset — see colors.test's flatten-margin pin,
  // which demonstrates why the plane needs 2 lifts, not 1).
  const o = opts({ flatten: true, layerMm: 0.5, K: 0.5 }); // lift = 1 m exactly
  const [grid, mask] = tile([-2, -2, -6, 20], [1, 1, 0, 0]);
  const r = applyWaterRecess(grid, mask, o);
  assert.ok(bandOf(-6, [r.lineElev]) > 0, "lowest land clears the line");
  assert.equal(bandOf(-8, [r.lineElev]), 0, "water blue");
  assert.equal(grid[0], -8, "plane = landMin − 2·lift = −8");
  assert.equal(grid[1], -8, "all water on the one plane");
  assert.equal(r.lineElev, -8, "line AT the plane");
  assert.equal(r.landBluePct, 0);
});

test("applyWaterRecess: flatten — water lowest → plane at waterMin, unbounded pull-down", () => {
  const [grid, mask] = tile([0, 200, 300], [1, 1, 0]); // 200 m reservoir over an ocean
  const r = applyWaterRecess(grid, mask, opts({ flatten: true }));
  assert.equal(grid[0], 0, "plane = waterMin (land far above)");
  assert.equal(grid[1], 0, "reservoir dropped 200 m to the plane — no gate");
  assert.equal(r.lineElev, 0, "line at the plane");
  assert.equal(r.landBluePct, 0);
});

test("applyWaterRecess: flatten + slider — water sinks below the plane, line unmoved", () => {
  const o = opts({ flatten: true, recessMm: 1, layerMm: 0.5, K: 0.5 }); // sink = 2 m, lift = 1 m
  const [grid, mask] = tile([-2, -2, -6, 20], [1, 1, 0, 0]);
  const r = applyWaterRecess(grid, mask, o);
  assert.equal(grid[0], -10, "plane −8, sunk a further 2 m");
  assert.equal(r.lineElev, -8, "line still AT the PLANE, not the sunk water");
});

test("applyWaterRecess: flatten, all-water tile → plane at waterMin, still blue", () => {
  const [grid, mask] = tile([3, 4], [1, 1]);
  const r = applyWaterRecess(grid, mask, opts({ flatten: true }));
  assert.equal(grid[0], 3); assert.equal(grid[1], 3);
  assert.equal(bandOf(3, [r.lineElev]), 0, "water blue");
  assert.equal(r.landBluePct, 0, "zero-land denominator guarded");
});

test("applyWaterRecess: layerMm sets the flatten plane's land clearance (2 layers)", () => {
  const K = 0.5;
  const [g1, m1] = tile([-2, -6, 20], [1, 0, 0]);
  const [g2, m2] = tile([-2, -6, 20], [1, 0, 0]);
  const r1 = applyWaterRecess(g1, m1, { flatten: true, recessMm: 0, layerMm: 0.5, K }); // lift 1 m
  const r2 = applyWaterRecess(g2, m2, { flatten: true, recessMm: 0, layerMm: 1, K });   // lift 2 m
  assert.equal(r1.lineElev, -8, "plane = landMin − 2·1");
  assert.equal(r2.lineElev, -10, "doubled layer → doubled clearance");
});

// A hex discards 25% of its own window and a circle 21.6%. Water in that discarded area is
// not in the print, so it must not anchor the colour line — otherwise a corner clipping
// a fjord would blue a tile whose printed surface holds no water at all.
test("applyWaterRecess: water outside the footprint never sets the line", () => {
  const grid = Float32Array.from([-10, 100, 100, 100]);
  const water = Uint8Array.from([1, 0, 0, 0]);       // the only water cell...
  const footprint = Uint8Array.from([0, 1, 1, 1]);   // ...is outside the footprint
  const r = applyWaterRecess(grid, water, {
    flatten: false, recessMm: 0, layerMm: 0.15, K: 0.01, footprint,
  });
  assert.equal(r.lineElev, -Infinity, "no water inside the footprint → no line at all");
  assert.equal(r.landBluePct, 0);
  assert.equal(grid[0], -10, "out-of-footprint water is left untouched");
});

test("applyWaterRecess: land outside the footprint is not counted as blue", () => {
  const grid = Float32Array.from([-5, 100, 100, 0]); // the -5 m land is outside
  const water = Uint8Array.from([0, 0, 0, 1]);       // one in-footprint water cell at 0 m
  const footprint = Uint8Array.from([0, 1, 1, 1]);
  const r = applyWaterRecess(grid, water, {
    flatten: false, recessMm: 0, layerMm: 0.15, K: 0.01, footprint,
  });
  assert.equal(r.lineElev, 0, "in-footprint water anchors the default 0 m line");
  assert.equal(r.landBluePct, 0, "land outside the print cannot print blue");
});

// flatten's plane clearance comes from landMin in the STATISTICS loop. If that loop forgot
// the footprint guard, a hex's discarded low corner would set landMin and drag the whole
// plane — and every in-print land pixel's clearance — down with it.
test("applyWaterRecess: flatten plane anchors to in-footprint land only", () => {
  const [grid, water] = tile([-1000, 0, 10, 20], [0, 1, 0, 0]); // -1000 sits outside the footprint
  const footprint = Uint8Array.from([0, 1, 1, 1]);
  const r = applyWaterRecess(grid, water, { flatten: true, recessMm: 0, layerMm: LAYER, K, footprint });
  assert.equal(r.lineElev, -5, "plane = min(waterMin=0, inFootprintLandMin=10 − 2·lift=15) = −5");

  const [gridNoFootprint, water2] = tile([-1000, 0, 10, 20], [0, 1, 0, 0]);
  const rNoFootprint = applyWaterRecess(gridNoFootprint, water2, { flatten: true, recessMm: 0, layerMm: LAYER, K });
  assert.equal(rNoFootprint.lineElev, -1015, "without the guard the discarded −1000 corner sets landMin");
  assert.ok(rNoFootprint.lineElev < r.lineElev, "the footprint guard measurably raises the plane");
});

test("applyWaterRecess: no footprint argument keeps today's whole-window behaviour", () => {
  const grid = Float32Array.from([-10, 100, 100, 100]);
  const water = Uint8Array.from([1, 0, 0, 0]);
  const r = applyWaterRecess(grid, water, { flatten: false, recessMm: 0, layerMm: 0.15, K: 0.01 });
  assert.equal(r.lineElev, 0, "square path unchanged: the water anchors the 0 m line");
});

// --- waterAsLandPct: masked water showing above the colour line (the counterpart to landBluePct) ---

test("waterAsLandPct: default — water above the 0 m line counts, as a share of the TILE", () => {
  const [grid, mask] = tile([1890, -5, 100, 200], [1, 1, 0, 0]); // high lake + ocean, 2 land
  const r = applyWaterRecess(grid, mask, opts());
  assert.equal(r.lineElev, 0);
  assert.equal(r.waterAsLandPct, 25, "1 of 4 CELLS, not 1 of 2 water cells (50%)");
});

test("waterAsLandPct: default — ordinary coast, all water below the line, reads 0", () => {
  const [grid, mask] = tile([0, -30, 5, 20], [1, 1, 0, 0]);
  const r = applyWaterRecess(grid, mask, opts());
  assert.equal(r.waterAsLandPct, 0, "water AT the line is blue (strict >), matching bandOf");
});

test("waterAsLandPct: flatten on → structurally 0, even for water starting far above the line", () => {
  const [grid, mask] = tile([3812, 3812, 4000, 4200], [1, 1, 0, 0]); // Titicaca-style
  const r = applyWaterRecess(grid, mask, opts({ flatten: true }));
  assert.equal(r.waterAsLandPct, 0, "the plane IS the line, so no masked cell can sit above it");
});

// Regression for the float32 narrowing defect. landMin − 2·lift is float64 and rarely
// representable; these values are deliberately NOT float-exact (unlike the flatten tests above,
// which pick lift = 1 m and would pass either way) and the raw plane here rounds UP when stored.
test("flatten on with a float32-inexact plane: the line IS the stored plane", () => {
  const o = opts({ flatten: true, layerMm: 0.05, K: 0.15 }); // lift = 1/3 m, not representable
  const raw = -7.31640625 - 2 * (0.05 / 0.15); // landMin − 2·lift, before any narrowing
  assert.ok(Math.fround(raw) > raw, "precondition: this plane is one the store rounds UP");
  const [grid, mask] = tile([-2, -2, -7.31640625, 20], [1, 1, 0, 0]);
  const r = applyWaterRecess(grid, mask, o);
  assert.equal(r.lineElev, Math.fround(raw), "line snapped to what the grid can hold");
  assert.equal(grid[0], r.lineElev, "and the water sits exactly ON it, not a rounding above");
  assert.equal(r.waterAsLandPct, 0, "so the rounding cannot fire the warning");
});

// The bug this snapping exists for, end to end: a float64 line the store rounds UP leaves emin
// ABOVE the tile's own waterline, and the colour model reads that as "no water on this tile" —
// baseBand folds the water band into the base plate and colorChanges drops the water→land change
// for landing under the base. Reported live on a 150 km Puget Sound tile that rendered with no
// blue at all. Swept, because whether a given plane rounds up is a coin flip on its low bit.
test("the flattened plane never lands above emin, so water keeps its own band", () => {
  let inexact = 0;
  for (const layerMm of [0.05, 0.15, 0.2, 0.3]) {
    for (const K of [0.00133, 0.0132998, 0.02, 0.15, 0.5]) {
      for (const landMin of [0, -1.5, -7.31640625, 123.4, 1998.75]) {
        const raw = landMin - 2 * (layerMm / K);
        if (Math.fround(raw) !== raw) inexact++;
        const [grid, mask] = tile([landMin - 0.5, landMin - 0.5, landMin, landMin + 100], [1, 1, 0, 0]);
        const r = applyWaterRecess(grid, mask, opts({ flatten: true, layerMm, K }));
        const emin = Math.min(...grid); // what gridRange hands the colour model
        // Built exactly as the worker builds it, clamp and all — an unclamped array would put an
        // ecological threshold below a high-altitude waterline and fail for the wrong reason.
        const th = waterLineThresholds(bandThresholds(47), r.lineElev);
        const label = `layer ${layerMm} K ${K} landMin ${landMin}`;
        assert.equal(emin, r.lineElev, `${label}: emin IS the line`);
        assert.equal(baseBand(emin, th), 0, `${label}: base stays water`);
        // A change AT the base is what bounds the water band; the bug dropped it for landing
        // under the base. Its band is ≥ 1, not always 1: a waterline above the timberline
        // collapses the two boundaries and colorChanges keeps the higher one, by design.
        const changes = colorChanges(th, { emin, base: 6, mmPerM: K, exag: 1, zmax: 6 + (landMin + 100 - emin) * K });
        assert.ok(changes.some((c) => c.z === 6 && c.band >= 1), `${label}: water band still bounded at the base`);
      }
    }
  }
  assert.ok(inexact > 40, `${inexact} of 100 planes are float32-inexact — the sweep must exercise them`);
});

test("waterAsLandPct: a large recess sinks water below the line and clears the warning", () => {
  const [grid, mask] = tile([200, 200, 300, 400], [1, 1, 0, 0]); // high lake, flatten OFF
  const before = applyWaterRecess(Float32Array.from([200, 200, 300, 400]), mask, opts());
  assert.equal(before.waterAsLandPct, 50, "without a recess the lake shows as land");
  const r = applyWaterRecess(grid, mask, opts({ recessMm: 5 })); // 5 mm = 250 m at K
  assert.equal(r.waterAsLandPct, 0, "sunk below the 0 m line — §4's documented blue-pits escape hatch");
});

test("waterAsLandPct: water outside the footprint is in neither numerator nor denominator", () => {
  const [grid, mask] = tile([1890, -5, 100, 200], [1, 1, 0, 0]);
  const footprint = Uint8Array.from([0, 1, 1, 1]); // discard the high lake
  const r = applyWaterRecess(grid, mask, { flatten: false, recessMm: 0, layerMm: LAYER, K, footprint });
  assert.equal(r.waterAsLandPct, 0, "the only above-line water is a discarded corner");
});
