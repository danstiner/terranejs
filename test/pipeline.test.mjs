import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import cp from "node:child_process";
import { planTile, bakeTileSolid, tileTo3mf, defaultTileName } from "../src/core/pipeline.js";
import { checkWatertight, signedVolume } from "../src/core/validate.js";
import { printPitchMm, PITCH_FLOOR_MM, lonToGlobalX, latToGlobalY, MAX_MERCATOR_LAT } from "../src/core/tilemath.js";
import { cellsBbox } from "../src/core/layout.js";

/** @typedef {import("../src/core/pipeline.js").TileSettings} TileSettings */

// Equator + prime meridian → integer global-pixel origin, so the window math is
// exact and the assertions are clean. Elevations are synthetic; z is pinned so
// the grid stays small (a full-detail tile is thousands of px per side).
/** @type {TileSettings} */
const SETTINGS = { center: [0, 0], scale: 61150, tileWidthMm: 100, base: 5, exag: 2 };

test("planTile: deterministic window + geom at a fixed zoom", () => {
  const plan = planTile(SETTINGS, { z: 10 });
  assert.equal(plan.z, 10);
  assert.equal(plan.gw, 41);
  assert.equal(plan.gh, 41);
  assert.deepEqual(plan.span, { r0: 0, r1: 40, c0: 0, c1: 40 });
  // dx = tileWidthMm/spanPx reduces exactly to the print pitch at this lat/z/scale
  assert.ok(Math.abs(plan.dx - printPitchMm(0, 10, 61150)) < 1e-9, `dx ${plan.dx}`);
  assert.equal(plan.dx, plan.dy); // Mercator conformal
  assert.ok(Math.abs(plan.mmPerM - 1000 / 61150) < 1e-9);
});

test("planTile: auto-zoom picks the deepest useful source zoom", () => {
  const plan = planTile(SETTINGS); // omit z → sourceZoom auto-picks
  assert.ok(Number.isInteger(plan.z) && plan.z >= 1 && plan.z <= 15, `z ${plan.z}`);
  // "deepest useful" = print pitch at or under the floor, else clamped to the z15 cap.
  const atFloor = printPitchMm(0, plan.z, SETTINGS.scale) <= PITCH_FLOOR_MM;
  assert.ok(atFloor || plan.z === 15, "reaches the pitch floor or the pyramid cap");
  assert.ok(plan.z === 15 || printPitchMm(0, plan.z - 1, SETTINGS.scale) > PITCH_FLOOR_MM,
    "one zoom shallower would exceed the floor");
  assert.ok(plan.dx > 0 && Number.isFinite(plan.gw) && plan.gw > 1, "coherent plan");
});

test("planTile: rejects a tile spilling past the ±85° Mercator cap", () => {
  // Large high-latitude tile: its north edge lands near 86.8°, outside the square.
  /** @type {TileSettings} */
  const beyond = { center: [80, 0], scale: 500000, tileWidthMm: 5000, base: 5, exag: 2 };
  assert.throws(() => planTile(beyond), /Web Mercator/);
});

test("planTile: rejects a pole-centred tile (bbox reaches ±90°, past the cap)", () => {
  /** @type {TileSettings} */
  const pole = { center: [90, 0], scale: 61150, tileWidthMm: 100, base: 5, exag: 2 };
  assert.throws(() => planTile(pole), /Web Mercator/);
});

// The bbox guard admits a tile whose north edge lands exactly ON the cap, but a clipped shape's
// window is expanded outward past its ring, so the WINDOW still escapes the top of the world
// (gy0 = -1 here) while the ring does not. Latitudes are per-shape because each footprint puts
// its north extreme at a different offset from the centre; both were found by bisecting for the
// centre whose ring bbox lands on the cap. The northOK assertion is what keeps this a test of
// the window guard — without it, a future change could make the ring itself illegal and this
// would silently pass by re-testing the guard above.
test("planTile: rejects a clipped tile whose expanded window escapes the world", () => {
  for (const [shape, lat] of /** @type {const} */ ([["circle", 84.0271913], ["hex", 84.1550508]])) {
    const center = /** @type {[number, number]} */ ([lat, 0]);
    const [, , n] = cellsBbox(center, 5000000, 50, [[0, 0]], shape);
    assert.ok(n <= MAX_MERCATOR_LAT, `${shape}: ring bbox must still be legal (north ${n})`);
    assert.throws(
      () => planTile({ center, scale: 5000000, tileWidthMm: 50, base: 5, exag: 2, shape }, { z: 6 }),
      /pixel window \[-?\d+, \d+\) escapes/, `${shape}`);
  }
});

// The clipped-shape window is expanded past the ring, so the fetch bbox has to be derived
// from the window rather than the ring — otherwise cropGrid reads pixels the mosaic never
// fetched. Assert coverage in pixel space at the plan's own zoom, which is what cropGrid uses.
test("planTile: the fetch bbox covers the whole expanded window", () => {
  for (const shape of /** @type {const} */ (["square", "hex", "circle"])) {
    for (let k = 0; k < 16; k++) {
      const settings = { ...SETTINGS, shape, center: /** @type {[number, number]} */
        ([47.6035, -122.3294 + k * 0.0011]) };
      const plan = planTile(settings, { z: 13 });
      const [s, w, n, e] = plan.bbox;
      const px0 = lonToGlobalX(w, plan.z), px1 = lonToGlobalX(e, plan.z);
      const py0 = latToGlobalY(n, plan.z), py1 = latToGlobalY(s, plan.z);
      // Square's bbox is the exact (unrounded) cell bbox, while its window is Math.round of the
      // same expression (layout.cellWindows) — an inherent <=0.5px gap already covered by
      // "cellBbox and cellWindows agree within quantization" in layout.test.mjs, unrelated to
      // this fix and harmless since sourceTileRange pads every fetch by a further >=1px halo.
      // Hex/circle derive their bbox FROM the window (pipeline.planTile), so they must match
      // to float noise — any gap there is exactly the bug this test guards against.
      const eps = shape === "square" ? 0.5 + 1e-6 : 1e-6;
      assert.ok(px0 <= plan.window.gx0 + eps && px1 >= plan.window.gx0 + plan.gw - 1 - eps,
        `${shape} k=${k}: x coverage [${px0}, ${px1}] vs window`);
      assert.ok(py0 <= plan.window.gy0 + eps && py1 >= plan.window.gy0 + plan.gh - 1 - eps,
        `${shape} k=${k}: y coverage [${py0}, ${py1}] vs window`);
    }
  }
});

// n is a min of two separately motivated bounds: pi*D/2 keeps ring edges near 2 cells and
// binds on coarse preview grids; 256 is where accuracy saturates and binds at crisp/export.
test("planTile: circle ring resolution adapts to the grid", () => {
  for (const [D, want] of [[2, 16], [58, 91], [104, 163], [970, 256]]) {
    const n = Math.max(16, Math.min(256, Math.round((Math.PI * D) / 2)));
    assert.equal(n, want, `D=${D}`);
  }
  const plan = planTile({ ...SETTINGS, shape: "circle" }, { z: 13 });
  const expected = Math.max(16, Math.min(256, Math.round((Math.PI * (plan.gw - 1)) / 2)));
  assert.equal(/** @type {Array<[number, number]>} */ (plan.ring).length, expected);
});

// Build a mosaic that exactly covers a plan's window, elevation = smooth ramp.
/**
 * @param {ReturnType<typeof planTile>} plan
 * @returns {import("../src/core/types.js").Mosaic}
 */
function mosaicFor(plan) {
  const { gx0, gy0, gw, gh } = plan.window;
  const data = new Float32Array(gw * gh);
  for (let r = 0; r < gh; r++) for (let c = 0; c < gw; c++) data[r * gw + c] = 500 + 3 * c + 2 * r;
  return { data, width: gw, height: gh, originGx: gx0, originGy: gy0, z: plan.z };
}

test("bakeTileSolid: validated closed-manifold, positive-volume solid", () => {
  const plan = planTile(SETTINGS, { z: 10 });
  const { solid } = bakeTileSolid(mosaicFor(plan), plan, SETTINGS);
  assert.ok(checkWatertight(solid).closed, "baked solid is watertight");
  assert.ok(signedVolume(solid) > 0, "baked solid is positive-volume (outward)");
  // top surface has one vertex per grid sample; more vertices come from the base.
  assert.ok(solid.positions.length / 3 >= plan.gw * plan.gh, "at least the top-surface vertices");
});

test("bakeTileSolid: throws on a degenerate (empty) solid rather than emit it", () => {
  const plan = planTile(SETTINGS, { z: 10 });
  const mosaic = mosaicFor(plan); // covers the full window; the 1-row crop below fits inside
  // A single-row window has zero cells → empty mesh → zero volume; the guard must fire.
  const degenerate = { ...plan, gh: 1, span: { ...plan.span, r1: 0 }, window: { ...plan.window, gh: 1 } };
  assert.throws(() => bakeTileSolid(mosaic, degenerate, SETTINGS),
    /non-positive-volume|non-watertight/);
});

test("pipeline: fixed region → validated watertight printable .3mf (milestone)", async () => {
  const plan = planTile(SETTINGS, { z: 10 });
  assert.ok(plan.gw > 10 && plan.gw < 200, `window ${plan.gw}×${plan.gh} sane for a test`);
  const { solid } = bakeTileSolid(mosaicFor(plan), plan, SETTINGS);
  const bytes = await tileTo3mf("tile_r0_c0", solid);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terranejs-pipe-"));
  try {
    fs.writeFileSync(path.join(dir, "out.3mf"), bytes);
    cp.execSync(`unzip -qq -o ${path.join(dir, "out.3mf")} -d ${dir}`);
    for (const part of ["[Content_Types].xml", "_rels/.rels", "3D/3dmodel.model"]) {
      assert.ok(fs.existsSync(path.join(dir, part)), `${part} present in the package`);
    }
    const model = fs.readFileSync(path.join(dir, "3D/3dmodel.model"), "utf8");
    assert.match(model, /<object id="1" name="tile_r0_c0" type="model">/);
    const verts = [...model.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)];
    const tris = [...model.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"\/>/g)];
    const positions = Float32Array.from(verts.flatMap((m) => [+m[1], +m[2], +m[3]]));
    const indices = Uint32Array.from(tris.flatMap((m) => [+m[1], +m[2], +m[3]]));
    assert.equal(positions.length, solid.positions.length, "every vertex serialized");
    assert.equal(indices.length, solid.indices.length, "every triangle serialized");
    assert.ok(checkWatertight({ positions, indices }).closed, "round-tripped mesh is watertight");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bakeTileSolid: water recess anchors below the land, stays watertight", () => {
  const plan = planTile(SETTINGS, { z: 10 }); // 41×41, ramp elevations 500..700 m
  const mosaic = mosaicFor(plan);
  const mask = new Uint8Array(plan.gw * plan.gh); // left half = water
  for (let r = 0; r < plan.gh; r++)
    for (let c = 0; c < plan.gw >> 1; c++) mask[r * plan.gw + c] = 1;
  const K = plan.mmPerM * SETTINGS.exag;

  const lift = 0.15 / K;
  const flat = bakeTileSolid(mosaic, plan, { ...SETTINGS, flatten: true }, mask);
  assert.ok(checkWatertight(flat.solid).closed, "flatten solid watertight");
  assert.ok(signedVolume(flat.solid) > 0, "flatten solid positive volume");
  // water 500 m, land ≥ 560 m → plane = min(500, 560 − 2·lift)
  const planeExp = Math.min(500, 560 - 2 * lift);
  assert.ok(Math.abs(flat.emin - planeExp) < 1e-2, `flatten emin = plane (got ${flat.emin})`);
  assert.ok(flat.lineElev < 560, "colour line below the lowest land → land keeps its colours");
  assert.equal(flat.landBluePct, 0, "no land prints blue");

  const dflt = bakeTileSolid(mosaic, plan, { ...SETTINGS }, mask);
  assert.ok(checkWatertight(dflt.solid).closed, "default solid watertight");
  assert.ok(Math.abs(dflt.emin - 500) < 1e-2, "default: geometry untouched, emin = waterMin");
  assert.equal(dflt.lineElev, 0, "default: line at true sea level");
  assert.equal(dflt.landBluePct, 0, "land far above sea level stays green");
});

// Regression for the clip/recess ordering constraint: bakeTileSolid must run applyWaterRecess
// (mutates the grid) BEFORE clipElevs (samples it) — see the comments at the two call sites.
// Nothing else exercises circle + water together through bakeTileSolid: the water test above
// bakes a square (no clip at all), and clip.test.mjs/mesh.test.mjs call clipElevs directly on
// synthetic grids, never through the pipeline. Pinning a volume here is what would have caught
// the ordering bug pipeline.js shipped with once and fixed before the first commit landed.
test("bakeTileSolid: circle + flatten reads post-recess elevations at the rim (ordering)", () => {
  const plan = planTile({ ...SETTINGS, shape: "circle" }, { z: 10 }); // 45×45: a clipped shape's
  // window is expanded outward past its ring, so R≈20 centred at (22,22) sweeps x∈[2.0, 42.0] —
  // the rim crosses interior rows and columns across the full width, not one corner.
  const mosaic = mosaicFor(plan); // ramp elevations, so every water cell's pre-flatten value differs
  // West half water, east half land. Column 20 (the mask split) passes through the circle's centre
  // (cx≈20), so the split crosses the rim near the top and bottom of the window: several of
  // clip.js's rim-crossing edges have one water endpoint and one land endpoint. Flatten collapses
  // every water sample to one shared plane; a crossing that samples the water endpoint BEFORE that
  // runs still sees its original ramp value instead — wrong geometry, not a rounding-level slip.
  const mask = new Uint8Array(plan.gw * plan.gh);
  for (let r = 0; r < plan.gh; r++)
    for (let c = 0; c < plan.gw >> 1; c++) mask[r * plan.gw + c] = 1;
  const { solid } = bakeTileSolid(mosaic, plan, { ...SETTINGS, flatten: true }, mask);
  assert.ok(checkWatertight(solid).closed, "watertight");
  // Golden value from the correct order (clipElevs after applyWaterRecess). Re-derived when the
  // flatten started moving out-of-footprint water too: the rim no longer climbs back toward raw
  // water, which takes 447 mm³ of spurious material off this fixture (52321.00 → 51873.70) —
  // that drop IS the rim-lip fix, measured. Swapping the two call-site lines in bakeTileSolid
  // now moves this to ~52262, a ~389 mm³ divergence on a ~51874 mm³ solid (0.75%, up from 0.1%
  // before — flattening both sides of the footprint edge makes the wrong order diverge further).
  // 1e-3 clears float noise by ~5 orders while catching that swap by ~5.
  assert.ok(Math.abs(signedVolume(solid) - 51873.701948798065) < 1e-3,
    `circle+flatten volume drifted from the pinned order-correct value — got ${signedVolume(solid)}`);
});

test("defaultTileName: encodes center, print width, and ground extent", () => {
  const g = { base: 6, exag: 1 }; // geom fields the name ignores
  assert.equal(
    defaultTileName({ center: [47.6035, -122.3294], tileWidthMm: 200, scale: 250000, ...g }),
    "terrane_tile_47.6035N_122.3294W_200mm_50km");
  assert.equal(
    defaultTileName({ center: [-33.8688, 151.2093], tileWidthMm: 150, scale: 100000, ...g }),
    "terrane_tile_33.8688S_151.2093E_150mm_15km");
  // rounds coords to 4 decimals and pads a whole-number degree; a tenth of a km past 10 is noise
  assert.equal(
    defaultTileName({ center: [47, 5.123456], tileWidthMm: 100, scale: 250000.7, ...g }),
    "terrane_tile_47.0000N_5.1235E_100mm_25km");
});

test("defaultTileName: ground extent stays legible below 10 km", () => {
  const g = { center: /** @type {[number, number]} */ ([0, 0]), base: 6, exag: 1 };
  //                       tileWidthMm, scale  → km
  assert.match(defaultTileName({ ...g, tileWidthMm: 100, scale: 25000 }), /_2\.5km$/);
  assert.match(defaultTileName({ ...g, tileWidthMm: 200, scale: 5000 }), /_1\.0km$/);
  // Metres under 1 km — the smallest tile the UI allows (50 mm at 1 mm = 1 km) would
  // otherwise round to "0km" and name every such tile identically.
  assert.match(defaultTileName({ ...g, tileWidthMm: 50, scale: 1000 }), /_50m$/);
});

/** Flat synthetic mosaic covering a plan's window, with a 2 px halo. Constant elevation
 *  makes the solid a prism of height `base`, so signedVolume is exactly footprint area ×
 *  base — which turns the analytic area fractions into a volume assertion.
 * @param {ReturnType<typeof planTile>} plan
 * @param {number} [elev]
 * @returns {import("../src/core/types.js").Mosaic} */
function flatMosaic(plan, elev = 100) {
  const w = plan.window, pad = 2;
  const width = w.gw + 2 * pad, height = w.gh + 2 * pad;
  return {
    data: new Float32Array(width * height).fill(elev),
    width, height, originGx: w.gx0 - pad, originGy: w.gy0 - pad, z: plan.z,
  };
}

test("bakeTileSolid: every shape is watertight with positive volume", () => {
  for (const shape of /** @type {const} */ (["square", "hex", "circle"])) {
    const plan = planTile({ ...SETTINGS, shape }, { z: 13 });
    const { solid } = bakeTileSolid(flatMosaic(plan), plan, SETTINGS);
    const wt = checkWatertight(solid);
    assert.ok(wt.closed, `${shape}: ${wt.unmatched} unmatched edges`);
    assert.ok(signedVolume(solid) > 0, `${shape}: non-positive volume`);
  }
});

// tileWidthMm is the bounding-square side in every shape, so hex and circle enclose less
// area for the same number. On a flat grid the volume ratio IS the area ratio.
test("bakeTileSolid: footprint areas match their analytic fractions", () => {
  /** @type {Record<string, number>} */
  const vol = {};
  /** @type {Record<string, ReturnType<typeof planTile>>} */
  const plans = {};
  for (const shape of /** @type {const} */ (["square", "hex", "circle"])) {
    plans[shape] = planTile({ ...SETTINGS, shape }, { z: 13 });
    vol[shape] = signedVolume(bakeTileSolid(flatMosaic(plans[shape]), plans[shape], SETTINGS).solid);
  }
  const hex = vol.hex / vol.square, circle = vol.circle / vol.square;
  // Hex is clipped to its true 6 edges now (footprintPx's hexagon is exact, not an
  // approximation of some other curve), so the residual against 3√3/8 is window whole-pixel
  // rounding only — measured 1.06e-5. 1e-3 clears that noise floor by two orders while still
  // catching a real regression (e.g. falling back to the old cell-centre mask, whose stairstep
  // error is two more orders up again).
  assert.ok(Math.abs(hex - (3 * Math.sqrt(3)) / 8) < 1e-3, `hex ratio ${hex}`);
  // Circle is clipped to the adaptive n-gon `ring` (clipPolygon consumes it directly), not the
  // exact circle the deleted clipCircle intersected analytically — so the printed footprint's
  // true target is the n-gon's own exact area (n/8)·sin(2π/n), not πR²/4. The adaptive n at
  // z=13 is 256 (capped at the accuracy limit), so the target is a 256-gon. Residual against
  // the 256-gon target is measured at ~1.03e-5, matching hex's noise floor almost exactly —
  // both are now window whole-pixel rounding on an exactly-clipped polygon). 1e-3 clears that
  // by two orders.
  const n = /** @type {Array<[number, number]>} */ (plans.circle.ring).length;
  const circleWant = (n / 8) * Math.sin((2 * Math.PI) / n); // exact n-gon / bounding-square area ratio
  assert.ok(Math.abs(circle - circleWant) < 1e-3, `circle ratio ${circle} vs ${n}-gon exact ${circleWant}`);
});

// Bowtie detection now covered by test/mesh.test.mjs's pinchedVertices test.

test("defaultTileName: names the shape only when it is not a square", () => {
  assert.ok(!defaultTileName(SETTINGS).includes("square"));
  assert.ok(defaultTileName({ ...SETTINGS, shape: "hex" }).includes("hex"));
});
