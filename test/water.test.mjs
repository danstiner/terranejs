import { test } from "node:test";
import assert from "node:assert/strict";
import { applyWaterRecess, filterUnprintableWater, splitWaterByLine } from "../src/core/water.js";
import { decodeWatermask } from "../src/core/terrain.js";
import { clipPolygon, clipElevs, clipRange } from "../src/core/clip.js";
import { bandOf, baseBand, colorChanges, bandThresholds, waterLineThresholds } from "../src/core/colors.js";

/** @param {number[]} elev @param {number[]} water @returns {[Float32Array, Uint8Array]} */
const tile = (elev, water) => [Float32Array.from(elev), Uint8Array.from(water)];
const K = 0.02, LAYER = 0.15;
/** @param {Partial<{waterMode: "none" | "flat" | "lakes" | "all", recessMm: number, layerMm: number, K: number, filled: boolean}>} [o] */
const opts = (o = {}) => ({ waterMode: /** @type {const} */ ("none"), recessMm: 0, layerMm: LAYER, K, ...o });

// Kept from the old water.test.mjs — decodeWatermask lives in terrain.js but is tested nowhere
// else; the plane-model rewrite must not drop its coverage.
test("decodeWatermask: alpha>127 = ocean(1), else land(0)", () => {
  const rgba = Uint8Array.from([0,0,0,255,  0,0,0,0,  0,0,0,128,  0,0,0,127]); // 4 px
  assert.deepEqual([...decodeWatermask(rgba)], [1, 0, 1, 0]);
});

test("applyWaterRecess: no mask → no-op, color line below all terrain", () => {
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

test("applyWaterRecess: default — the line rises to a perched lake all land clears", () => {
  const [grid, mask] = tile([1890, 1910, 2100], [1, 0, 0]); // Tahoe-style tile; lift = 7.5 m at K
  const r = applyWaterRecess(grid, mask, opts());
  assert.deepEqual([...grid], [1890, 1910, 2100], "geometry untouched");
  assert.equal(r.lineElev, 1890, "line at the lake surface — the tile's lowest water anchors it");
  assert.equal(bandOf(1890, [r.lineElev]), 0, "lake prints blue");
  assert.ok(bandOf(1910, [r.lineElev]) > 0, "shore stays land");
  assert.equal(r.landBluePct, 0, "the rise is only ever taken when nothing floods");
});

test("applyWaterRecess: default — land below the lake refuses the rise (Crater Lake valleys)", () => {
  const [grid, mask] = tile([1883, 1830, 2100, 2200], [1, 0, 0, 0]); // lake, LOWER outer valley, rim
  const r = applyWaterRecess(grid, mask, opts());
  assert.equal(r.lineElev, 0, "a line at the lake would flood the valley — it stays at sea level");
  assert.ok(bandOf(1830, [r.lineElev]) > 0, "valley stays land");
  assert.ok(bandOf(1883, [r.lineElev]) > 0, "so the lake shows as land — the inserts warning's case");
  assert.ok(r.waterAsLandPct > 0, "and is counted for it");
  assert.equal(r.landBluePct, 0, "the whole point: no land floods");
});

test("applyWaterRecess: default — the rise demands flatten's own 2-lift land clearance", () => {
  // lift = 7.5 m at this K. The pause prints one layer above the line, so land must clear TWO
  // lifts, exactly like the flatten plane (colors.test's flatten-margin pin) — solved once, kept.
  const [atMargin, m1] = tile([1890, 1905, 2100], [1, 0, 0]); // land at lake + 2·lift exactly
  assert.equal(applyWaterRecess(atMargin, m1, opts()).lineElev, 1890, "2 lifts clear → rises");
  const [inside, m2] = tile([1890, 1904, 2100], [1, 0, 0]); // 1 m inside the margin
  assert.equal(applyWaterRecess(inside, m2, opts()).lineElev, 0, "inside the margin → refused");
});

test("applyWaterRecess: default — the sea wins the anchor; higher water still shows as land", () => {
  const [grid, mask] = tile([0, 500, 600], [1, 1, 0]); // sea + perched reservoir
  const r = applyWaterRecess(grid, mask, opts());
  assert.equal(r.lineElev, 0, "the LOWEST water sets the line, not the highest");
  assert.ok(bandOf(500, [r.lineElev]) > 0, "reservoir reads as land");
  assert.ok(r.waterAsLandPct > 0, "and is counted for the Lake-inserts warning");
});

test("applyWaterRecess: grooving modes keep the 0 m anchor — the no-flood escape from a raised line", () => {
  const [grid, mask] = tile([1883, 1830, 2100], [1, 0, 0]); // same shape as the flooded-valley tile
  const r = applyWaterRecess(grid, mask, opts({ waterMode: "lakes", recessMm: 2, filled: true }));
  assert.equal(r.lineElev, 0, "an inserts card promises exact water — its line never floods land");
  assert.ok(bandOf(1830, [r.lineElev]) > 0, "the valley the raised line would flood stays land");
});

test("applyWaterRecess: default — polder land pushes the line below itself; sea prints as land", () => {
  const [grid, mask] = tile([-2, -6, 20], [1, 0, 0]); // sea −2 m, polder −6 m
  const r = applyWaterRecess(grid, mask, opts());
  assert.equal(r.lineElev, Math.fround(-6 - 2 * (LAYER / K)), "line = landMin − 2·lift — flatten's own clearance");
  assert.ok(bandOf(-6, [r.lineElev]) > 0, "polder prints as land: rather sea-as-land than land-as-sea");
  assert.equal(r.landBluePct, 0, "no land prints blue — the invariant the lowering buys");
  assert.ok(Math.abs(r.waterAsLandPct - 100 / 3) < 1e-9, "the sea above the lowered line is named for the warning");
});

test("applyWaterRecess: default — below-0 water alone never drags the line under the sea", () => {
  const [grid, mask] = tile([-30, 5, 20], [1, 0, 0]); // noisy sounding, healthy shore
  const r = applyWaterRecess(grid, mask, opts());
  assert.equal(r.lineElev, 0, "bathymetry noise is not a polder — land above 0 keeps the line at 0");
  assert.equal(bandOf(-30, [r.lineElev]), 0, "the sea prints blue");
});

test("applyWaterRecess: lakes on a polder tile — the lowered line reaches the grooving mode too", () => {
  const [grid, mask] = tile([-2, -6, 20], [1, 0, 0]);
  const r = applyWaterRecess(grid, mask, opts({ waterMode: "lakes", recessMm: 2, filled: true }));
  assert.equal(r.lineElev, Math.fround(-6 - 2 * (LAYER / K)), "same line as Natural — never above land");
  assert.equal(r.waterAsLandPct, 0, "the sea moved and a part is coming: nothing shows as land");
  assert.equal(r.landBluePct, 0);
});

test("applyWaterRecess: all — all water sinks X/K, line unmoved, relative elevations kept", () => {
  const [grid, mask] = tile([0, 200, 300], [1, 1, 0]); // ocean + high lake
  const r = applyWaterRecess(grid, mask, opts({ waterMode: "all", recessMm: 2 })); // 2 mm = 100 m at K
  assert.equal(grid[0], -100); assert.equal(grid[1], 100); // both sank 100 m, 200 m apart still
  assert.equal(r.lineElev, -Infinity, "`all` has no color line — every body is a part");
  assert.ok(bandOf(100, [r.lineElev]) > 0, "sunk high lake still reads as terrain");
});

test("applyWaterRecess: flat — polder plane 2 lifts below the land, land green, water blue", () => {
  // lift EXACT (0.5/0.5 = 1 m) so the boundary is float-exact. The line sits AT the plane
  // (the export pause carries the +1-layer offset — see colors.test's flatten-margin pin,
  // which demonstrates why the plane needs 2 lifts, not 1).
  const o = opts({ waterMode: "flat", layerMm: 0.5, K: 0.5 }); // lift = 1 m exactly
  const [grid, mask] = tile([-2, -2, -6, 20], [1, 1, 0, 0]);
  const r = applyWaterRecess(grid, mask, o);
  assert.ok(bandOf(-6, [r.lineElev]) > 0, "lowest land clears the line");
  assert.equal(bandOf(-8, [r.lineElev]), 0, "water blue");
  assert.equal(grid[0], -8, "plane = landMin − 2·lift = −8");
  assert.equal(grid[1], -8, "all water on the one plane");
  assert.equal(r.lineElev, -8, "line AT the plane");
  assert.equal(r.landBluePct, 0);
});

test("applyWaterRecess: flat — water lowest → plane at waterMin, unbounded pull-down", () => {
  const [grid, mask] = tile([0, 200, 300], [1, 1, 0]); // 200 m reservoir over an ocean
  const r = applyWaterRecess(grid, mask, opts({ waterMode: "flat" }));
  assert.equal(grid[0], 0, "plane = waterMin (land far above)");
  assert.equal(grid[1], 0, "reservoir dropped 200 m to the plane — no gate");
  assert.equal(r.lineElev, 0, "line at the plane");
  assert.equal(r.landBluePct, 0);
});

// `flat` and the sink are exclusive now. The mode's job is "all water blue by color band"; a
// step at every shoreline was a different intent wearing the same slider, and it is gone. Same
// fixture as the composition test this replaces, so the two read against each other.
test("applyWaterRecess: flat ignores the depth — water lands ON the plane, not below it", () => {
  const o = opts({ waterMode: "flat", recessMm: 1, layerMm: 0.5, K: 0.5 }); // 1 mm would be 2 m at K
  const [grid, mask] = tile([-2, -2, -6, 20], [1, 1, 0, 0]);
  const r = applyWaterRecess(grid, mask, o);
  assert.equal(grid[0], -8, "plane = landMin − 2·lift, with no further sink");
  assert.equal(grid[1], -8, "all water on the one plane");
  assert.equal(r.lineElev, -8, "line AT the plane");
});

// The mirror guard: collapsing `flat` must not collapse the grooving modes. Same depth, same K
// as the flat case above, so the 2 m the plane refused is exactly the 2 m `all` applies.
test("applyWaterRecess: all still sinks by recessMm/K once flat no longer composes", () => {
  const o = opts({ waterMode: "all", recessMm: 1, layerMm: 0.5, K: 0.5 }); // sink = 2 m
  const [grid, mask] = tile([-2, -2, -6, 20], [1, 1, 0, 0]);
  const r = applyWaterRecess(grid, mask, o);
  assert.equal(grid[0], -4, "true elevation −2, sunk 2 m");
  assert.equal(r.lineElev, -Infinity, "`all` has no color line for the sink to move");
});

test("applyWaterRecess: flat, all-water tile → plane at waterMin, still blue", () => {
  const [grid, mask] = tile([3, 4], [1, 1]);
  const r = applyWaterRecess(grid, mask, opts({ waterMode: "flat" }));
  assert.equal(grid[0], 3); assert.equal(grid[1], 3);
  assert.equal(bandOf(3, [r.lineElev]), 0, "water blue");
  assert.equal(r.landBluePct, 0, "zero-land denominator guarded");
});

test("applyWaterRecess: layerMm sets the flatten plane's land clearance (2 layers)", () => {
  const K = 0.5;
  const [g1, m1] = tile([-2, -6, 20], [1, 0, 0]);
  const [g2, m2] = tile([-2, -6, 20], [1, 0, 0]);
  const r1 = applyWaterRecess(g1, m1, { waterMode: "flat", recessMm: 0, layerMm: 0.5, K }); // lift 1 m
  const r2 = applyWaterRecess(g2, m2, { waterMode: "flat", recessMm: 0, layerMm: 1, K });   // lift 2 m
  assert.equal(r1.lineElev, -8, "plane = landMin − 2·1");
  assert.equal(r2.lineElev, -10, "doubled layer → doubled clearance");
});

// A hex discards 25% of its own window and a circle 21.6%. Water in that discarded area is
// not in the print, so it must not anchor the color line — otherwise a corner clipping
// a fjord would blue a tile whose printed surface holds no water at all.
test("applyWaterRecess: water outside the footprint never sets the line", () => {
  const grid = Float32Array.from([-10, 100, 100, 100]);
  const water = Uint8Array.from([1, 0, 0, 0]);       // the only water cell...
  const footprint = Uint8Array.from([0, 1, 1, 1]);   // ...is outside the footprint
  const r = applyWaterRecess(grid, water, {
    waterMode: "none", recessMm: 0, layerMm: 0.15, K: 0.01, footprint,
  });
  assert.equal(r.lineElev, -Infinity, "no water inside the footprint → no line at all");
  assert.equal(r.landBluePct, 0);
  assert.equal(grid[0], -10, "and with no line to move it to, that water stays put");
});

// The footprint gates MEASUREMENT, not mutation. Water outside it still moves, because a clipped
// rim vertex is a bilinear sample straddling the footprint edge: leave the outside half raw and
// the rim climbs back toward it. See the end-to-end crossing test below for the consequence.
test("applyWaterRecess: water outside the footprint still moves onto the plane", () => {
  const grid = Float32Array.from([0, -2, -6, 20]); // [0] is out-of-footprint water at 0 m
  const water = Uint8Array.from([1, 1, 0, 0]);
  const footprint = Uint8Array.from([0, 1, 1, 1]);
  const r = applyWaterRecess(grid, water, { waterMode: "flat", recessMm: 0, layerMm: 0.5, K: 0.5, footprint });
  assert.equal(r.lineElev, -8, "line still anchored by IN-footprint water and land only");
  assert.equal(grid[1], -8, "in-footprint water on the plane");
  assert.equal(grid[0], -8, "and the outside cell too, so a rim crossing between them lands on it");
});

test("applyWaterRecess: `all` sinks outside water as well, for the same reason", () => {
  const grid = Float32Array.from([0, 0, 100, 200]);
  const water = Uint8Array.from([1, 1, 0, 0]);
  const footprint = Uint8Array.from([0, 1, 1, 1]);
  applyWaterRecess(grid, water, { waterMode: "all", recessMm: 2, layerMm: 0.15, K: 0.02, footprint });
  assert.equal(grid[1], -100, "in-footprint water sank 2 mm / K");
  assert.equal(grid[0], -100, "outside water sank with it");
});

test("applyWaterRecess: moving outside water does not let it into the measurements", () => {
  //                          out            in
  const grid = Float32Array.from([500, 0, 6, 20]); // a 500 m out-of-footprint lake
  const water = Uint8Array.from([1, 1, 0, 0]);
  const footprint = Uint8Array.from([0, 1, 1, 1]);
  const r = applyWaterRecess(grid, water, { waterMode: "none", recessMm: 0, layerMm: 0.5, K: 0.5, footprint });
  assert.equal(r.lineElev, 0, "the 500 m lake neither raised nor anchored the line");
  assert.equal(r.waterAsLandPct, 0, "nor counted as water showing as land — it is not in the print");
});

test("applyWaterRecess: land outside the footprint is not counted as blue", () => {
  const grid = Float32Array.from([-5, 100, 100, 0]); // the -5 m land is outside
  const water = Uint8Array.from([0, 0, 0, 1]);       // one in-footprint water cell at 0 m
  const footprint = Uint8Array.from([0, 1, 1, 1]);
  const r = applyWaterRecess(grid, water, {
    waterMode: "none", recessMm: 0, layerMm: 0.15, K: 0.01, footprint,
  });
  assert.equal(r.lineElev, 0, "in-footprint water anchors the default 0 m line");
  assert.equal(r.landBluePct, 0, "land outside the print cannot print blue");
});

// flatten's plane clearance comes from landMin in the STATISTICS loop. If that loop forgot
// the footprint guard, a hex's discarded low corner would set landMin and drag the whole
// plane — and every in-print land pixel's clearance — down with it.
test("applyWaterRecess: flat plane anchors to in-footprint land only", () => {
  const [grid, water] = tile([-1000, 0, 10, 20], [0, 1, 0, 0]); // -1000 sits outside the footprint
  const footprint = Uint8Array.from([0, 1, 1, 1]);
  const r = applyWaterRecess(grid, water, { waterMode: "flat", recessMm: 0, layerMm: LAYER, K, footprint });
  assert.equal(r.lineElev, -5, "plane = min(waterMin=0, inFootprintLandMin=10 − 2·lift=15) = −5");

  const [gridNoFootprint, water2] = tile([-1000, 0, 10, 20], [0, 1, 0, 0]);
  const rNoFootprint = applyWaterRecess(gridNoFootprint, water2, { waterMode: "flat", recessMm: 0, layerMm: LAYER, K });
  assert.equal(rNoFootprint.lineElev, -1015, "without the guard the discarded −1000 corner sets landMin");
  assert.ok(rNoFootprint.lineElev < r.lineElev, "the footprint guard measurably raises the plane");
});

test("applyWaterRecess: no footprint argument keeps today's whole-window behavior", () => {
  const grid = Float32Array.from([-10, 100, 100, 100]);
  const water = Uint8Array.from([1, 0, 0, 0]);
  const r = applyWaterRecess(grid, water, { waterMode: "none", recessMm: 0, layerMm: 0.15, K: 0.01 });
  assert.equal(r.lineElev, 0, "square path unchanged: the water anchors the 0 m line");
});

// --- waterAsLandPct: masked water showing above the color line (the counterpart to landBluePct) ---

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

/** waterAsLandPct at rest — no flat, no recess, so only the color ceiling decides.
 * @param {Float32Array} grid @param {Uint8Array} mask */
const r0 = (grid, mask) => applyWaterRecess(grid, mask, opts()).waterAsLandPct;

test("waterAsLandPct: water under the printed color change is blue, so it is not named", () => {
  // The export puts the water→land change one print layer ABOVE the line (colorChanges
  // pauseLiftMm) so the water's top layer prints blue, and one layer is 7.5 m of ground at this
  // K. Water inside that layer cannot print as anything but blue however far above 0 m the raw
  // sample sits — which is most of the near-0 bathymetry noise on a real coastal tile.
  // A 0 m sea sample holds the auto anchor at 0, so the noisy samples sit above the LINE either way.
  const [grid, mask] = tile([0, 3, 3, 10], [1, 1, 1, 0]);
  assert.equal(r0(grid, mask), 0, "3 m is a fifth of a layer above the line: it prints blue");
  const [high, hmask] = tile([0, 8, 8, 10], [1, 1, 1, 0]);
  assert.equal(r0(high, hmask), 50, "8 m clears the layer and does show as land");
});

test("waterAsLandPct: flat → structurally 0, even for water starting far above the line", () => {
  const [grid, mask] = tile([3812, 3812, 4000, 4200], [1, 1, 0, 0]); // Titicaca-style
  const r = applyWaterRecess(grid, mask, opts({ waterMode: "flat" }));
  assert.equal(r.waterAsLandPct, 0, "the plane IS the line, so no masked cell can sit above it");
});

// Regression for the float32 narrowing defect. landMin − 2·lift is float64 and rarely
// representable; these values are deliberately NOT float-exact (unlike the flatten tests above,
// which pick lift = 1 m and would pass either way) and the raw plane here rounds UP when stored.
test("flatten on with a float32-inexact plane: the line IS the stored plane", () => {
  const o = opts({ waterMode: "flat", layerMm: 0.05, K: 0.15 }); // lift = 1/3 m, not representable
  const raw = -7.31640625 - 2 * (0.05 / 0.15); // landMin − 2·lift, before any narrowing
  assert.ok(Math.fround(raw) > raw, "precondition: this plane is one the store rounds UP");
  const [grid, mask] = tile([-2, -2, -7.31640625, 20], [1, 1, 0, 0]);
  const r = applyWaterRecess(grid, mask, o);
  assert.equal(r.lineElev, Math.fround(raw), "line snapped to what the grid can hold");
  assert.equal(grid[0], r.lineElev, "and the water sits exactly ON it, not a rounding above");
  assert.equal(r.waterAsLandPct, 0, "so the rounding cannot fire the warning");
});

// The bug this snapping exists for, end to end: a float64 line the store rounds UP leaves emin
// ABOVE the tile's own waterline, and the color model reads that as "no water on this tile" —
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
        const r = applyWaterRecess(grid, mask, opts({ waterMode: "flat", layerMm, K }));
        const emin = Math.min(...grid); // what gridRange hands the color model
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

test("waterAsLandPct: in `all` only the parts make water blue — depth clears nothing", () => {
  const [grid, mask] = tile([0, 200, 300, 400], [1, 1, 0, 0]); // sea + high lake
  const before = applyWaterRecess(Float32Array.from([0, 200, 300, 400]), mask, opts());
  assert.equal(before.waterAsLandPct, 25, "Natural: the perched lake shows as land");
  const open = applyWaterRecess(Float32Array.from([0, 200, 300, 400]), mask, opts({ waterMode: "all", recessMm: 5 }));
  assert.equal(open.waterAsLandPct, 50, "no line and no parts: open grooves ALL show as land");
  const r = applyWaterRecess(grid, mask, opts({ waterMode: "all", recessMm: 5, filled: true }));
  assert.equal(r.waterAsLandPct, 0, "the seated parts are what make it blue");
});

test("waterAsLandPct: any recess excludes the water it moved, reached the line or not — when a part is coming", () => {
  // 800 m water, 0 m line, and a recess far too shallow to reach it. Before the split existed
  // this reported the water as showing as land; now the recess is a mold and the part is what
  // makes it blue, so the number a user reads must not name it — but only once `filled` says a
  // part is actually coming (pipeline.js passes waterInlay).
  const [grid, mask] = tile([800, 800, 10], [1, 1, 0]);
  const r = applyWaterRecess(grid, mask, opts({ waterMode: "all", recessMm: 0.5, filled: true }));
  assert.ok(grid[0] < 800, "the water did sink");
  assert.ok(grid[0] > r.lineElev, "and is still far above the line");
  assert.equal(r.waterAsLandPct, 0, "recessed water is blue by part, not showing as land");
});

test("waterAsLandPct: with no recess the count is unchanged — water above the line shows as land", () => {
  const [grid, mask] = tile([800, 800, 10], [1, 1, 0]);
  const r = applyWaterRecess(grid, mask, opts({ waterMode: "all", recessMm: 0 }));
  assert.ok(Math.abs(r.waterAsLandPct - 200 / 3) < 1e-9, `2 of 3 cells, got ${r.waterAsLandPct}`);
});

test("waterAsLandPct: a recessMask splits the count — only the water left behind is named", () => {
  const [grid, mask] = tile([800, 800, 10], [1, 1, 0]);
  const recessMask = Uint8Array.from([1, 0, 0]); // only the first body is a mold
  const r = applyWaterRecess(grid, mask, { ...opts({ waterMode: "all", recessMm: 0.5, filled: true }), recessMask });
  assert.ok(grid[0] < 800, "the recessed cell sank");
  assert.equal(grid[1], 800, "the untouched cell did not");
  assert.ok(Math.abs(r.waterAsLandPct - 100 / 3) < 1e-9, `1 of 3 cells, got ${r.waterAsLandPct}`);
});

// The regression this commit fixes: applyWaterRecess used to excuse ANY moved water, so "Recess
// all water" with inlays unticked reported 0% showing as land over a tile of open grooves. The
// depth alone does not make water blue — the parts do, and a headless caller below the UI has to
// say so explicitly via `filled`.
test("waterAsLandPct: moved water excuses itself only when a part is coming (`filled`)", () => {
  const [gridUnfilled, maskUnfilled] = tile([800, 800, 10], [1, 1, 0]); // stays above the line after sinking
  const unfilled = applyWaterRecess(gridUnfilled, maskUnfilled, opts({ waterMode: "all", recessMm: 0.5, filled: false }));
  assert.ok(gridUnfilled[0] > unfilled.lineElev, "still above the line after sinking");
  assert.ok(unfilled.waterAsLandPct > 0, "no part filling it — an open groove still shows as land");

  const [gridFilled, maskFilled] = tile([800, 800, 10], [1, 1, 0]);
  const filled = applyWaterRecess(gridFilled, maskFilled, opts({ waterMode: "all", recessMm: 0.5, filled: true }));
  assert.equal(filled.waterAsLandPct, 0, "same depth, but the insert makes it blue");
});

test("waterAsLandPct: water outside the footprint is in neither numerator nor denominator", () => {
  const [grid, mask] = tile([1890, -5, 100, 200], [1, 1, 0, 0]);
  const footprint = Uint8Array.from([0, 1, 1, 1]); // discard the high lake
  const r = applyWaterRecess(grid, mask, { waterMode: "none", recessMm: 0, layerMm: LAYER, K, footprint });
  assert.equal(r.waterAsLandPct, 0, "the only above-line water is a discarded corner");
});

// End-to-end regressions for the rim lip, through the real clipper. A rim crossing is a bilinear
// sample of the grid at a fractional (col, row) that straddles the footprint edge, so when only
// the inside half was moved the crossing landed between the moved water and the raw water —
// ALWAYS on the raw side, never with the water. Squares never showed it: no clip, no crossings.
// Both `flat` and `all` move water, so both need pinning here, not just `flat`.
/** A 9×9 all-water grid with one land cell, and a square ring inset so its boundary cuts water
 * on all four sides. @returns {[Float32Array, Uint8Array, import("../src/core/types.js").Clip]} */
function waterTileWithRim() {
  const GW = 9, GH = 9, GX0 = 1000, GY0 = 2000;
  const grid = new Float32Array(GW * GH).fill(0); // sea level everywhere...
  grid[4 * GW + 4] = -6;                          // ...but one land cell in the middle
  const mask = new Uint8Array(GW * GH).fill(1);
  mask[4 * GW + 4] = 0;
  const ring = /** @type {Array<[number, number]>} */ (
    [[2.5, 2.5], [6.5, 2.5], [6.5, 6.5], [2.5, 6.5]].map(([x, y]) => [GX0 + x, GY0 + y]));
  return [grid, mask, clipPolygon(GW, GH, GX0, GY0, ring)];
}

test("clipped rim: flatten — an all-water crossing lands ON the waterline, not above it", () => {
  const [grid, mask, clip] = waterTileWithRim();
  const r = applyWaterRecess(grid, mask, {
    waterMode: "flat", recessMm: 0, layerMm: 0.5, K: 0.5, footprint: clip.inside,
  });
  assert.equal(r.lineElev, -8, "plane = landMin − 2·lift");
  clipElevs(clip, grid);
  assert.ok(clip.elev.length > 0, "the ring must actually produce crossings");
  let above = 0;
  for (const e of clip.elev) if (e > r.lineElev) above++;
  assert.equal(above, 0, `${above}/${clip.elev.length} crossings sit above the waterline`);
  assert.equal(clipRange(grid, clip).min, r.lineElev, "and the rim never dips below it either");
});

test("clipped rim: `all` sinks the rim with the water, not just the interior", () => {
  const [grid, mask, clip] = waterTileWithRim();
  const K = 0.5, recessMm = 2, sink = recessMm / K; // 4 m
  const r = applyWaterRecess(grid, mask, { waterMode: "all", recessMm, layerMm: 0.5, K, footprint: clip.inside });
  assert.equal(r.lineElev, -Infinity, "`all` has no line at all; only the water sinks");
  clipElevs(clip, grid);
  assert.ok(clip.elev.length > 0, "the ring must actually produce crossings");
  for (const e of clip.elev) {
    assert.equal(e, -sink, `crossing at ${e} m, expected the sunk water plane at ${-sink} m`);
  }
});

// filterUnprintableWater — dx 0.4 gives k = round(0.4/0.4) = 1, a 3x3 cell window; dx 1.0 gives
// k = 0, where the width test is inert and only sub-cell water drops.
/** @param {number} gw @param {number} gh @param {(r: number, c: number) => boolean} f */
const vmask = (gw, gh, f) => {
  const m = new Uint8Array(gw * gh);
  for (let r = 0; r < gh; r++) for (let c = 0; c < gw; c++) if (f(r, c)) m[r * gw + c] = 1;
  return m;
};

test("filterUnprintableWater: a sub-cell tail attached to a printable lake goes with it", () => {
  const GW = 30, GH = 20;
  const mask = vmask(GW, GH, (r, c) =>
    (r >= 3 && r < 11 && c >= 3 && c < 11) || (r === 7 && c >= 11 && c < 22));
  const { mask: out } = filterUnprintableWater(mask, GW, GH, 0.4);
  const o = /** @type {Uint8Array} */ (out);
  for (let r = 3; r < 11; r++) {
    for (let c = 3; c < 11; c++) assert.equal(o[r * GW + c], 1, `lake vertex (${r},${c}) dropped`);
  }
  for (let c = 11; c < 22; c++) {
    assert.equal(o[7 * GW + c], 0, `tail vertex (7,${c}) kept — the fill ran over vertices, not cells`);
  }
});

test("filterUnprintableWater: sub-cell water drops even at k = 0", () => {
  const GW = 12, GH = 6;
  const mask = vmask(GW, GH, (r, c) => r === 3 && c >= 1 && c < 11);
  const { mask: out, droppedPct } = filterUnprintableWater(mask, GW, GH, 1.0);
  assert.deepEqual([...(/** @type {Uint8Array} */ (out))], new Array(GW * GH).fill(0));
  assert.equal(droppedPct, 100);
});

test("filterUnprintableWater: a one-cell-wide river drops", () => {
  const GW = 16, GH = 8;
  const mask = vmask(GW, GH, (r, c) => (r === 3 || r === 4) && c >= 1 && c < 15);
  assert.equal(filterUnprintableWater(mask, GW, GH, 0.4).droppedPct, 100);
});

test("filterUnprintableWater: the width test bites at (2k+1) cells", () => {
  const GW = 12, GH = 12;
  const four = vmask(GW, GH, (r, c) => r >= 4 && r <= 7 && c >= 4 && c <= 7);  // 3x3 cells: fits
  assert.equal(filterUnprintableWater(four, GW, GH, 0.4).droppedPct, 0);
  const three = vmask(GW, GH, (r, c) => r >= 4 && r <= 6 && c >= 4 && c <= 6); // 2x2 cells: does not
  assert.equal(filterUnprintableWater(three, GW, GH, 0.4).droppedPct, 100);
});

test("filterUnprintableWater: out-of-grid reads as land, so an edge body still needs its square", () => {
  const GW = 10, GH = 10;
  const narrow = vmask(GW, GH, (r, c) => c < 3); // 2 cells wide, flush with the edge
  assert.equal(filterUnprintableWater(narrow, GW, GH, 0.4).droppedPct, 100);
  const wide = vmask(GW, GH, (r, c) => c < 4);   // 3 cells wide: the edge does not stop it
  assert.equal(filterUnprintableWater(wide, GW, GH, 0.4).droppedPct, 0);
});

test("filterUnprintableWater: 8-connectivity — a seed in one lobe of a diagonal pinch saves both", () => {
  const GW = 8, GH = 8;
  // cells (0..3,0..3) and (4..5,4..5), touching only at their diagonal corner; only the big lobe seeds
  const mask = vmask(GW, GH, (r, c) =>
    (r <= 4 && c <= 4) || (r >= 4 && r <= 6 && c >= 4 && c <= 6));
  assert.equal(filterUnprintableWater(mask, GW, GH, 0.4).droppedPct, 0,
    "the small lobe was dropped — the fill is 4-connected, not 8");
});

test("filterUnprintableWater: droppedPct is an area share of water, not a body count", () => {
  const GW = 20, GH = 10;
  const mask = vmask(GW, GH, (r, c) =>
    (r >= 1 && r <= 8 && c >= 1 && c <= 8) || (r === 3 && c >= 12 && c <= 17));
  const { droppedPct } = filterUnprintableWater(mask, GW, GH, 0.4);
  assert.ok(Math.abs(droppedPct - (100 * 6) / 70) < 1e-9, `6 of 70 water vertices, got ${droppedPct}`);
});

test("filterUnprintableWater: a surviving body keeps its stepped shore, losing only 1-vertex spurs", () => {
  const GW = 12, GH = 12;
  const mask = vmask(GW, GH, (r, c) => c <= r); // 45° staircase shore, 78 water vertices
  const { mask: out, droppedPct } = filterUnprintableWater(mask, GW, GH, 0.4);
  const o = /** @type {Uint8Array} */ (out);
  // Exactly the two vertices belonging to no 2×2 all-water block: the tip, and the far corner
  // whose only candidate cell falls off the cell grid. Everything else — interior AND the
  // stepped edge — survives, which is what keeps a real lake's shoreline ramp.
  const dropped = [];
  for (let r = 0; r < GH; r++) {
    for (let c = 0; c < GW; c++) if (mask[r * GW + c] && !o[r * GW + c]) dropped.push(`${r},${c}`);
  }
  assert.deepEqual(dropped, ["0,0", "11,11"]);
  assert.ok(Math.abs(droppedPct - (100 * 2) / 78) < 1e-9, `2 of 78, got ${droppedPct}`);
});

test("filterUnprintableWater: no mask, empty mask and all-water are no-ops", () => {
  assert.deepEqual(filterUnprintableWater(undefined, 8, 8, 0.4), { mask: undefined, droppedPct: 0 });
  const empty = new Uint8Array(64);
  const e = filterUnprintableWater(empty, 8, 8, 0.4);
  assert.equal(e.droppedPct, 0);
  assert.notEqual(e.mask, empty, "a new array, always — the caller's is never handed back");
  assert.deepEqual([...(/** @type {Uint8Array} */ (e.mask))], [...empty]);
  const all = new Uint8Array(64).fill(1);
  const a = filterUnprintableWater(all, 8, 8, 0.4);
  assert.equal(a.droppedPct, 0);
  assert.deepEqual([...(/** @type {Uint8Array} */ (a.mask))], [...all]);
});

// The entry guard: a negative depth would RAISE water above the line it anchors, inverting the
// ≤-original invariant the drape and the waterAsLand count both lean on. Zero stays legal for
// headless callers below the UI's floor; negative (and NaN, which the >= catches) throw rather
// than silently inverting parts downstream.
test("applyWaterRecess: a negative depth throws instead of raising water", () => {
  const [grid, mask] = tile([-2, -2, -6, 20], [1, 1, 0, 0]);
  assert.throws(() => applyWaterRecess(grid, mask, opts({ waterMode: "all", recessMm: -2 })), /recessMm/);
  assert.throws(() => applyWaterRecess(grid, mask, opts({ waterMode: "all", recessMm: NaN })), /recessMm/);
});

/** A gw×gh grid at `land` meters with a rectangle of `water` meters, plus the matching mask.
 * @param {number} gw @param {number} gh @param {number} land
 * @param {Array<{r0:number,r1:number,c0:number,c1:number,elev:number}>} bodies
 * @returns {[Float32Array, Uint8Array]} */
const pond = (gw, gh, land, bodies) => {
  const grid = new Float32Array(gw * gh).fill(land);
  const mask = new Uint8Array(gw * gh);
  for (const b of bodies) {
    for (let r = b.r0; r <= b.r1; r++) for (let c = b.c0; c <= b.c1; c++) {
      grid[r * gw + c] = b.elev; mask[r * gw + c] = 1;
    }
  }
  return [grid, mask];
};

test("splitWaterByLine: an ocean at the line is left alone, a lake above it is not", () => {
  // 10x10. Ocean rows 0-3 at 0 m (the line), lake rows 6-9 at 1500 m. Land at 800 m between.
  const [grid, mask] = pond(10, 10, 800, [
    { r0: 0, r1: 3, c0: 0, c1: 9, elev: 0 },
    { r0: 6, r1: 9, c0: 0, c1: 9, elev: 1500 },
  ]);
  const { mask: out, recessedPct } = splitWaterByLine(mask, grid, 10, 10, 0);
  for (let r = 0; r <= 3; r++) assert.equal(out[r * 10], 0, `ocean row ${r} must not be recessed`);
  for (let r = 6; r <= 9; r++) assert.equal(out[r * 10], 1, `lake row ${r} must be recessed`);
  assert.equal(recessedPct, 50, "40 of 80 water vertices");
  assert.notEqual(out, mask, "a NEW mask, always");
});

test("splitWaterByLine: one vertex above the line recesses the WHOLE body", () => {
  // Body is vertices (2,2)-(7,7); its interior cells' corners span (3,3)-(6,6) — (4,4) sits
  // inside that, so this still pins the no-partial-body guarantee under the eroded rule.
  const [grid, mask] = pond(10, 10, 800, [{ r0: 2, r1: 7, c0: 2, c1: 7, elev: 0 }]);
  grid[4 * 10 + 4] = 0.5; // a single INTERIOR sample the DEM put above the line
  const { mask: out, recessedPct } = splitWaterByLine(mask, grid, 10, 10, 0);
  for (let r = 2; r <= 7; r++) for (let c = 2; c <= 7; c++) {
    assert.equal(out[r * 10 + c], 1, `(${r},${c}) left behind — a half-recessed body cannot seat an insert`);
  }
  assert.equal(recessedPct, 100);
});

test("splitWaterByLine: a shoreline ring above the line does not groove the body", () => {
  // The real-data case: DEM and watermask disagree by a pixel at the shore, so a body's outer
  // ring sits a hair above the line even where the water is genuinely at it. Interior at 0 m (the
  // line), ring at 0.5 m. Under the old any-vertex rule this grooved the whole block.
  const [grid, mask] = pond(12, 12, 800, [{ r0: 2, r1: 6, c0: 2, c1: 6, elev: 0 }]);
  for (let r = 2; r <= 6; r++) for (let c = 2; c <= 6; c++) {
    if (r === 2 || r === 6 || c === 2 || c === 6) grid[r * 12 + c] = 0.5;
  }
  const { mask: out, recessedPct } = splitWaterByLine(mask, grid, 12, 12, 0);
  assert.equal(recessedPct, 0, "interior sits at the line; the shore ring alone must not groove it");
  assert.deepEqual([...out], [...new Uint8Array(144)]);
});

test("splitWaterByLine: a body with no interior cells falls back to maxAll", () => {
  // One cell row thick — every cell is missing a vertical member neighbor, so interiorCount is
  // always 0 and the decision has to come from the fallback, not maxInterior.
  const [grid, mask] = pond(10, 10, 800, [{ r0: 4, r1: 5, c0: 2, c1: 7, elev: 0 }]);
  grid[4 * 10 + 5] = 0.5; // a single sample the DEM put above the line
  const { mask: out, recessedPct } = splitWaterByLine(mask, grid, 10, 10, 0);
  assert.equal(recessedPct, 100, "the fallback still grooves — conservative, not silently left alone");
  for (let c = 2; c <= 7; c++) {
    assert.equal(out[4 * 10 + c], 1);
    assert.equal(out[5 * 10 + c], 1);
  }
});

test("splitWaterByLine: a body exactly AT the line is left alone (boundary inclusive)", () => {
  const [grid, mask] = pond(8, 8, 500, [{ r0: 1, r1: 6, c0: 1, c1: 6, elev: 250 }]);
  assert.equal(splitWaterByLine(mask, grid, 8, 8, 250).recessedPct, 0, "max === line prints blue");
  assert.equal(splitWaterByLine(mask, grid, 8, 8, 249.9).recessedPct, 100, "max > line does not");
});

test("splitWaterByLine: 8-connectivity — a diagonal pinch makes two lobes one body", () => {
  // Two 3x3 lobes meeting at a single cell corner. One lobe is above the line; both must move.
  const grid = new Float32Array(10 * 10).fill(900);
  const mask = new Uint8Array(10 * 10);
  for (let r = 1; r <= 3; r++) for (let c = 1; c <= 3; c++) { mask[r * 10 + c] = 1; grid[r * 10 + c] = -5; }
  for (let r = 3; r <= 5; r++) for (let c = 3; c <= 5; c++) { mask[r * 10 + c] = 1; grid[r * 10 + c] = 700; }
  const { mask: out } = splitWaterByLine(mask, grid, 10, 10, 0);
  assert.equal(out[1 * 10 + 1], 1, "the below-line lobe rides with the body it is joined to");
  assert.equal(out[5 * 10 + 5], 1);
});

test("splitWaterByLine: separate bodies are judged separately", () => {
  const [grid, mask] = pond(20, 20, 900, [
    { r0: 1, r1: 5, c0: 1, c1: 5, elev: -3 },     // below the line, untouched
    { r0: 12, r1: 16, c0: 12, c1: 16, elev: 700 }, // above it, recessed
  ]);
  const { mask: out } = splitWaterByLine(mask, grid, 20, 20, 0);
  assert.equal(out[3 * 20 + 3], 0, "an isolated below-line body is not dragged along");
  assert.equal(out[14 * 20 + 14], 1);
});

test("splitWaterByLine: an empty mask is a no-op, and the input is never mutated", () => {
  const grid = new Float32Array(16).fill(100);
  const empty = new Uint8Array(16);
  assert.deepEqual([...splitWaterByLine(empty, grid, 4, 4, 0).mask], [...empty]);
  assert.equal(splitWaterByLine(empty, grid, 4, 4, 0).recessedPct, 0);
  const [g2, m2] = pond(6, 6, 900, [{ r0: 1, r1: 4, c0: 1, c1: 4, elev: 700 }]);
  const before = Uint8Array.from(m2);
  splitWaterByLine(m2, g2, 6, 6, 0);
  assert.deepEqual([...m2], [...before], "the caller's mask survives untouched");
});

test("splitWaterByLine: sub-cell water contributes no cell, so it is never recessed", () => {
  // A one-vertex-tall strip has no all-four-corners cell. filterUnprintableWater drops it before
  // this runs; if it ever reaches here it must not become a groove with no part to fill it.
  const grid = new Float32Array(10 * 10).fill(900);
  const mask = new Uint8Array(10 * 10);
  for (let c = 2; c < 8; c++) mask[5 * 10 + c] = 1;
  const { mask: out, recessedPct } = splitWaterByLine(mask, grid, 10, 10, 0);
  assert.equal(recessedPct, 0);
  assert.deepEqual([...out], [...new Uint8Array(100)]);
});

// --- the vertex closure: a body's spur vertices carry no cell of their own, so they need the
// closure BFS (not the cell stamp) to move with the body they are attached to ---

test("splitWaterByLine: a diagonal spur chain is claimed by the body it hangs off", () => {
  const GW = 8, GH = 8;
  const grid = new Float32Array(GW * GH).fill(900);
  const mask = new Uint8Array(GW * GH);
  // A 4x4 water block, all above the line.
  for (let r = 3; r <= 6; r++) for (let c = 3; c <= 6; c++) { mask[r * GW + c] = 1; grid[r * GW + c] = 500; }
  // A 1-vertex-wide diagonal spur off the block's own corner (3,3): no 2x2 patch along it is
  // all-water, so cellsFromVertexMask gives it no cell — only the closure can claim it.
  mask[2 * GW + 2] = 1; grid[2 * GW + 2] = 500;
  mask[1 * GW + 1] = 1; grid[1 * GW + 1] = 500;
  mask[0 * GW + 0] = 1; grid[0 * GW + 0] = 500;
  const { mask: out, recessedPct } = splitWaterByLine(mask, grid, GW, GH, 0);
  assert.equal(recessedPct, 100, "every mask VERTEX counts, chain included — the coastal-tile-can't-reach-100 bug");
  for (let i = 0; i < mask.length; i++) if (mask[i]) assert.equal(out[i], 1, `spur/body vertex ${i} left unclaimed`);
});

test("splitWaterByLine: a bridge between a grooved and an ungrooved body attaches only to the grooved one", () => {
  const GW = 20, GH = 20;
  const grid = new Float32Array(GW * GH).fill(900);
  const mask = new Uint8Array(GW * GH);
  const A = { r0: 3, r1: 6, c0: 3, c1: 6, elev: 500 };   // above the line: grooved
  const B = { r0: 3, r1: 6, c0: 11, c1: 14, elev: -500 }; // below the line: left alone
  for (const b of [A, B]) for (let r = b.r0; r <= b.r1; r++) for (let c = b.c0; c <= b.c1; c++) {
    mask[r * GW + c] = 1; grid[r * GW + c] = b.elev;
  }
  // A 1-vertex-wide bridge two cells clear of both bodies, forming no cell of its own.
  for (let c = 7; c <= 10; c++) { mask[4 * GW + c] = 1; grid[4 * GW + c] = 500; }
  const { mask: out } = splitWaterByLine(mask, grid, GW, GH, 0);
  for (let r = A.r0; r <= A.r1; r++) for (let c = A.c0; c <= A.c1; c++) {
    assert.equal(out[r * GW + c], 1, "grooved body A claimed in full");
  }
  for (let r = B.r0; r <= B.r1; r++) for (let c = B.c0; c <= B.c1; c++) {
    assert.equal(out[r * GW + c], 0, "ungrooved body B's own vertices must stay unclaimed — the attribution pin");
  }
  assert.equal(out[4 * GW + 7], 1, "the bridge attaches to the grooved body, whose closure reaches it first");
  // The hard constraint bites right where B's own cell starts: cornerOfOtherBody refuses the
  // corner of B's cell(4,10), so the closure gets no further than the bridge itself.
  assert.equal(out[4 * GW + 11], 0, "the closure never crosses INTO B's own cell corners");
});

test("splitWaterByLine: a below-line body's own spur stays unstamped", () => {
  const GW = 10, GH = 10;
  const grid = new Float32Array(GW * GH).fill(900);
  const mask = new Uint8Array(GW * GH);
  for (let r = 3; r <= 6; r++) for (let c = 3; c <= 6; c++) { mask[r * GW + c] = 1; grid[r * GW + c] = -500; }
  mask[2 * GW + 2] = 1; grid[2 * GW + 2] = -500; // diagonal spur off its own corner
  mask[1 * GW + 1] = 1; grid[1 * GW + 1] = -500;
  const { mask: out, recessedPct } = splitWaterByLine(mask, grid, GW, GH, 0);
  assert.equal(recessedPct, 0, "an already-blue body contributes nothing, spur included");
  for (let i = 0; i < mask.length; i++) if (mask[i]) assert.equal(out[i], 0, `vertex ${i} stamped despite the body being left alone`);
});

test("splitWaterByLine → applyWaterRecess: a spur sinks with its body under `lakes` — no spike at the groove lip", () => {
  const GW = 8, GH = 8;
  const grid = new Float32Array(GW * GH).fill(900);
  const mask = new Uint8Array(GW * GH);
  for (let r = 3; r <= 6; r++) for (let c = 3; c <= 6; c++) { mask[r * GW + c] = 1; grid[r * GW + c] = 500; }
  mask[2 * GW + 2] = 1; grid[2 * GW + 2] = 500;
  mask[1 * GW + 1] = 1; grid[1 * GW + 1] = 500;
  const { mask: recessMask, recessedPct } = splitWaterByLine(mask, grid, GW, GH, 0);
  assert.equal(recessedPct, 100, "precondition: the whole body, spur included, is above the line");
  const recessMm = 3, K = 0.02, sink = recessMm / K; // 150 m
  applyWaterRecess(grid, mask, { waterMode: "lakes", recessMm, layerMm: LAYER, K, recessMask });
  assert.equal(grid[2 * GW + 2], 500 - sink, "the spur sank with the body it belongs to — no spike left standing");
  assert.equal(grid[1 * GW + 1], 500 - sink);
});
