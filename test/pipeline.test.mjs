import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import cp from "node:child_process";
import { planTile, bakeTileSolid, tileTo3mf, defaultTileName } from "../src/core/pipeline.js";
import { footprintCellMaskPx } from "../src/core/layout.js";
import { checkWatertight, signedVolume } from "../src/core/validate.js";
import { printPitchMm, PITCH_FLOOR_MM } from "../src/core/tilemath.js";

/** @typedef {import("../src/core/pipeline.js").TileSettings} TileSettings */

// Equator + prime meridian → integer global-pixel origin, so the window math is
// exact and the assertions are clean. Elevations are synthetic; z is pinned so
// the grid stays small (a full-detail tile is thousands of px per side).
/** @type {TileSettings} */
const SETTINGS = { center: [0, 0], scale: 61150, tileWmm: 100, base: 5, exag: 2 };

test("planTile: deterministic window + geom at a fixed zoom", () => {
  const plan = planTile(SETTINGS, { z: 10 });
  assert.equal(plan.z, 10);
  assert.equal(plan.gw, 41);
  assert.equal(plan.gh, 41);
  assert.deepEqual(plan.span, { r0: 0, r1: 40, c0: 0, c1: 40 });
  // dx = tileWmm/spanPx reduces exactly to the print pitch at this lat/z/scale
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
  const beyond = { center: [80, 0], scale: 500000, tileWmm: 5000, base: 5, exag: 2 };
  assert.throws(() => planTile(beyond), /Web Mercator/);
});

test("planTile: rejects a pole-centred tile (bbox reaches ±90°, past the cap)", () => {
  /** @type {TileSettings} */
  const pole = { center: [90, 0], scale: 61150, tileWmm: 100, base: 5, exag: 2 };
  assert.throws(() => planTile(pole), /Web Mercator/);
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

// tileWmm is the bounding-square side in every shape, so hex and circle enclose less
// area for the same number. On a flat grid the volume ratio IS the area ratio.
test("bakeTileSolid: footprint areas match their analytic fractions", () => {
  /** @type {Record<string, number>} */
  const vol = {};
  for (const shape of /** @type {const} */ (["square", "hex", "circle"])) {
    const plan = planTile({ ...SETTINGS, shape }, { z: 13 });
    vol[shape] = signedVolume(bakeTileSolid(flatMosaic(plan), plan, SETTINGS).solid);
  }
  const hex = vol.hex / vol.square, circle = vol.circle / vol.square;
  assert.ok(Math.abs(hex - (3 * Math.sqrt(3)) / 8) < 0.02, `hex ratio ${hex}`);
  assert.ok(Math.abs(circle - Math.PI / 4) < 0.02, `circle ratio ${circle}`);
});

// checkWatertight is edge-parity only, so a bowtie (two cells meeting at one corner) would pass
// it while being unslicable. True when a 2x2 neighbourhood (a b / d e) has ONLY its diagonal set
// — exactly that bowtie. Shared by the sweep below and the fixture that proves it can fire.
/** @param {number} a @param {number} b @param {number} d @param {number} e @returns {boolean} */
function isPinch(a, b, d, e) {
  return !!((a && e && !b && !d) || (b && d && !a && !e));
}

test("pinch detector: flags a hand-built diagonal-only mask", () => {
  // Proves isPinch (hence the sweep below) is not vacuously green: it must fire on a real
  // bowtie and stay quiet on the patterns that aren't one.
  assert.ok(isPinch(1, 0, 0, 1), "NE+SW diagonal only");
  assert.ok(isPinch(0, 1, 1, 0), "NW+SE diagonal only");
  assert.ok(!isPinch(1, 1, 0, 0), "adjacent pair, not a pinch");
  assert.ok(!isPinch(1, 1, 1, 1), "full block, not a pinch");
  assert.ok(!isPinch(0, 0, 0, 0), "empty block, not a pinch");
});

// Hex/circle ring for a single cell at the origin (q=r=0, where footprintPx's hex terms
// 3q and 2r+q collapse to 0) — mirrors layout.js's math exactly, but parameterized by the
// center directly in px so the sweep can place it at an arbitrary sub-pixel phase. A real
// lat/lon center can't do that independent of span: Mercator ties latitude (hence S, via
// cos(lat)) to the center's projected pixel position.
/** @param {number} gxC @param {number} gyC @param {number} S @param {"hex" | "circle"} shape
 *  @returns {[number, number][]} */
function ringAt(gxC, gyC, S, shape) {
  if (shape === "hex") {
    const XU = [2, 1, -1, -2, -1, 1], YU = [0, 1, 1, 0, -1, -1];
    const hx = S / 4, hy = (Math.sqrt(3) / 4) * S;
    return XU.map((xu, k) => [gxC + xu * hx, gyC + YU[k] * hy]);
  }
  const R = S / 2;
  return Array.from({ length: 64 }, (_, k) => {
    const a = (2 * Math.PI * k) / 64;
    return [gxC + R * Math.cos(a), gyC + R * Math.sin(a)];
  });
}

// Window for a ring: Math.round of each extreme, independently — the same rule cellWindows
// applies per cell, so this reproduces exactly the window planTile hands footprintCellMaskPx.
/** @param {[number, number][]} ring */
function windowFor(ring) {
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  const gx0 = Math.round(Math.min(...xs)), gx1 = Math.round(Math.max(...xs));
  const gy0 = Math.round(Math.min(...ys)), gy1 = Math.round(Math.max(...ys));
  return { gx0, gy0, gw: gx1 - gx0 + 1, gh: gy1 - gy0 + 1 };
}

// Coarse-weighted spans (2.0 px is cellWindows' minimum, where rasterization is coarsest and a
// pinch is most plausible) plus a few large-span spot checks — far more valuable per config than
// a smooth run out to 300px. 8 phases x 40 spans x 2 shapes = 640 configurations: narrower than
// the design doc's one-time 9552-configuration proof sweep (span 2.0-300.0 in half-pixel steps x
// 8 phases; see "Non-goal: the vertex-pinch check" in
// docs/superpowers/specs/2026-08-01-tile-shapes-design.md) but the same two swept dimensions, so
// this is a live regression guard for that claim rather than a one-off.
const PINCH_SWEEP_SPANS = [
  ...Array.from({ length: 37 }, (_, k) => 2.0 + k * 0.5), // 2.0 .. 20.0 by 0.5
  50, 150, 300,
];
// 8 sub-pixel phases; x steps by 1/8 and y by 3/8 (coprime with 8) so the pair sweeps the unit
// square instead of walking its diagonal — the footprint centre lands on an arbitrary float in
// both axes, not just one.
const PINCH_SWEEP_PHASES = Array.from({ length: 8 }, (_, k) => [k / 8, ((k * 3) % 8) / 8]);

test("footprint masks contain no diagonal-only adjacency", () => {
  let checked = 0;
  for (const shape of /** @type {const} */ (["hex", "circle"])) {
    for (const S of PINCH_SWEEP_SPANS) {
      for (const [fx, fy] of PINCH_SWEEP_PHASES) {
        // The integer part of the center is arbitrary (translation-invariant); only the
        // fractional part (fx, fy) — the sub-pixel phase — matters.
        const ring = ringAt(1000 + fx, 1000 + fy, S, shape);
        const { gx0, gy0, gw, gh } = windowFor(ring);
        const m = footprintCellMaskPx(ring, gw, gh, gx0, gy0);
        const cw = gw - 1, ch = gh - 1;
        for (let r = 0; r + 1 < ch; r++) {
          for (let c = 0; c + 1 < cw; c++) {
            const a = m[r * cw + c], b = m[r * cw + c + 1];
            const d = m[(r + 1) * cw + c], e = m[(r + 1) * cw + c + 1];
            assert.ok(!isPinch(a, b, d, e),
              `${shape} S=${S} phase=(${fx},${fy}): pinch at r=${r} c=${c}`);
          }
        }
        checked++;
      }
    }
  }
  assert.equal(checked, 640, "sweep ran the configuration count this test documents");
});

test("defaultTileName: names the shape only when it is not a square", () => {
  assert.ok(!defaultTileName(SETTINGS).includes("square"));
  assert.ok(defaultTileName({ ...SETTINGS, shape: "hex" }).includes("hex"));
});
