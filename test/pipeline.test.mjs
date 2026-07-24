import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import cp from "node:child_process";
import { planSquareTile, bakeSquareTileSolid, tileTo3mf, defaultTileName } from "../src/core/pipeline.js";
import { checkWatertight, signedVolume } from "../src/core/validate.js";
import { printPitchMm, PITCH_FLOOR_MM } from "../src/core/tilemath.js";

/** @typedef {import("../src/core/pipeline.js").TileSettings} TileSettings */

// Equator + prime meridian → integer global-pixel origin, so the window math is
// exact and the assertions are clean. Elevations are synthetic; z is pinned so
// the grid stays small (a full-detail tile is thousands of px per side).
/** @type {TileSettings} */
const SETTINGS = { center: [0, 0], scale: 61150, tileWmm: 100, base: 5, exag: 2 };

test("planSquareTile: deterministic window + geom at a fixed zoom", () => {
  const plan = planSquareTile(SETTINGS, { z: 10 });
  assert.equal(plan.z, 10);
  assert.equal(plan.gw, 41);
  assert.equal(plan.gh, 41);
  assert.deepEqual(plan.span, { r0: 0, r1: 40, c0: 0, c1: 40 });
  // dx = tileWmm/spanPx reduces exactly to the print pitch at this lat/z/scale
  assert.ok(Math.abs(plan.dx - printPitchMm(0, 10, 61150)) < 1e-9, `dx ${plan.dx}`);
  assert.equal(plan.dx, plan.dy); // Mercator conformal
  assert.ok(Math.abs(plan.mmPerM - 1000 / 61150) < 1e-9);
});

test("planSquareTile: auto-zoom picks the deepest useful source zoom", () => {
  const plan = planSquareTile(SETTINGS); // omit z → sourceZoom auto-picks
  assert.ok(Number.isInteger(plan.z) && plan.z >= 1 && plan.z <= 15, `z ${plan.z}`);
  // "deepest useful" = print pitch at or under the floor, else clamped to the z15 cap.
  const atFloor = printPitchMm(0, plan.z, SETTINGS.scale) <= PITCH_FLOOR_MM;
  assert.ok(atFloor || plan.z === 15, "reaches the pitch floor or the pyramid cap");
  assert.ok(plan.z === 15 || printPitchMm(0, plan.z - 1, SETTINGS.scale) > PITCH_FLOOR_MM,
    "one zoom shallower would exceed the floor");
  assert.ok(plan.dx > 0 && Number.isFinite(plan.gw) && plan.gw > 1, "coherent plan");
});

test("planSquareTile: rejects a tile spilling past the ±85° Mercator cap", () => {
  // Large high-latitude tile: its north edge lands near 86.8°, outside the square.
  /** @type {TileSettings} */
  const beyond = { center: [80, 0], scale: 500000, tileWmm: 5000, base: 5, exag: 2 };
  assert.throws(() => planSquareTile(beyond), /Web Mercator/);
});

test("planSquareTile: rejects a pole-centred tile (bbox reaches ±90°, past the cap)", () => {
  /** @type {TileSettings} */
  const pole = { center: [90, 0], scale: 61150, tileWmm: 100, base: 5, exag: 2 };
  assert.throws(() => planSquareTile(pole), /Web Mercator/);
});

// Build a mosaic that exactly covers a plan's window, elevation = smooth ramp.
/**
 * @param {ReturnType<typeof planSquareTile>} plan
 * @returns {import("../src/core/types.js").Mosaic}
 */
function mosaicFor(plan) {
  const { gx0, gy0, gw, gh } = plan.window;
  const data = new Float32Array(gw * gh);
  for (let r = 0; r < gh; r++) for (let c = 0; c < gw; c++) data[r * gw + c] = 500 + 3 * c + 2 * r;
  return { data, width: gw, height: gh, originGx: gx0, originGy: gy0, z: plan.z };
}

test("bakeSquareTileSolid: validated closed-manifold, positive-volume solid", () => {
  const plan = planSquareTile(SETTINGS, { z: 10 });
  const { solid } = bakeSquareTileSolid(mosaicFor(plan), plan, SETTINGS);
  assert.ok(checkWatertight(solid).closed, "baked solid is watertight");
  assert.ok(signedVolume(solid) > 0, "baked solid is positive-volume (outward)");
  // top surface has one vertex per grid sample; more vertices come from the base.
  assert.ok(solid.positions.length / 3 >= plan.gw * plan.gh, "at least the top-surface vertices");
});

test("bakeSquareTileSolid: throws on a degenerate (empty) solid rather than emit it", () => {
  const plan = planSquareTile(SETTINGS, { z: 10 });
  const mosaic = mosaicFor(plan); // covers the full window; the 1-row crop below fits inside
  // A single-row window has zero cells → empty mesh → zero volume; the guard must fire.
  const degenerate = { ...plan, gh: 1, span: { ...plan.span, r1: 0 }, window: { ...plan.window, gh: 1 } };
  assert.throws(() => bakeSquareTileSolid(mosaic, degenerate, SETTINGS),
    /non-positive-volume|non-watertight/);
});

test("pipeline: fixed region → validated watertight printable .3mf (milestone)", async () => {
  const plan = planSquareTile(SETTINGS, { z: 10 });
  assert.ok(plan.gw > 10 && plan.gw < 200, `window ${plan.gw}×${plan.gh} sane for a test`);
  const { solid } = bakeSquareTileSolid(mosaicFor(plan), plan, SETTINGS);
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

test("bakeSquareTileSolid: water recess anchors below the land, stays watertight", () => {
  const plan = planSquareTile(SETTINGS, { z: 10 }); // 41×41, ramp elevations 500..700 m
  const mosaic = mosaicFor(plan);
  const mask = new Uint8Array(plan.gw * plan.gh); // left half = water
  for (let r = 0; r < plan.gh; r++)
    for (let c = 0; c < plan.gw >> 1; c++) mask[r * plan.gw + c] = 1;
  const K = plan.mmPerM * SETTINGS.exag;

  const auto = bakeSquareTileSolid(mosaic, plan, { ...SETTINGS, mode: "auto", recessMm: 2 }, mask);
  assert.ok(checkWatertight(auto.solid).closed, "auto solid watertight");
  assert.ok(signedVolume(auto.solid) > 0, "auto solid positive volume");
  // waterMin = 500, land is well above it → Auto uses the minimum recess (AUTO_MIN_RECESS_MM =
  // 0.30 mm), independent of the 2 mm slider; the low water floors at waterMin − 0.30/K.
  assert.ok(Math.abs(auto.emin - (500 - 0.30 / K)) < 1e-2, `auto emin = waterMin − 0.30/K (got ${auto.emin})`);
  assert.ok(auto.lineElev < 560, "colour line below the lowest land (560 m) → land keeps its colours");
  assert.equal(auto.landBluePct, 0, "no land prints blue");

  const man = bakeSquareTileSolid(mosaic, plan, { ...SETTINGS, mode: "manual", recessMm: 0 }, mask);
  assert.ok(checkWatertight(man.solid).closed, "manual solid watertight");
  assert.ok(Math.abs(man.emin - 500) < 1e-2, "manual recess 0 → water flush at waterMin (500 m)");
  assert.equal(man.landBluePct, 0, "ramp land (≥560 m) clears the flush colour line");
});

test("defaultTileName: encodes center, width, and scale", () => {
  const g = { base: 6, exag: 1 }; // geom fields the name ignores
  assert.equal(
    defaultTileName({ center: [47.6035, -122.3294], tileWmm: 200, scale: 250000, ...g }),
    "terrane_tile_47.6035N_122.3294W_200mm_1to250000");
  assert.equal(
    defaultTileName({ center: [-33.8688, 151.2093], tileWmm: 150, scale: 100000, ...g }),
    "terrane_tile_33.8688S_151.2093E_150mm_1to100000");
  // rounds coords to 4 decimals, pads a whole-number degree, rounds scale to an int
  assert.equal(
    defaultTileName({ center: [47, 5.123456], tileWmm: 100, scale: 250000.7, ...g }),
    "terrane_tile_47.0000N_5.1235E_100mm_1to250001");
});
