import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSolid } from "../src/core/mesh.js";
import { signedVolume, checkWatertight } from "../src/core/validate.js";

// Flat tile: every grid sample at the same relief; geom maps relief mm 1:1, so
// the enclosed volume is exactly footprint_area × (base + relief) — analytic,
// no fixture needed.
/**
 * @param {number} gw @param {number} gh @param {number} [z]
 * @returns {{ grid: Float32Array, gw: number, gh: number }}
 */
function flatGrid(gw, gh, z = 2) {
  return { grid: new Float32Array(gw * gh).fill(z), gw, gh };
}
const GEOM = { dx: 1, dy: 1, mmPerM: 1, emin: 0, exag: 1, base: 1 };

test("flat base: full rectangle uses a fan, not a mirror", () => {
  const { grid, gw, gh } = flatGrid(9, 7);
  const mask = new Uint8Array((gw - 1) * (gh - 1)).fill(1);
  const m = buildSolid(grid, gw, gh, { r0: 0, r1: gh - 1, c0: 0, c1: gw - 1 }, mask, GEOM);
  assert.ok(checkWatertight(m).closed);
  const nTop = 96; // 8×6 cells × 2 tris; a mirrored base would double the total
  assert.ok(m.indices.length / 3 < 2 * nTop, `tris ${m.indices.length / 3}`);
  assert.ok(Math.abs(signedVolume(m) - 8 * 6 * (1 + 2)) < 1e-3); // (base+relief) × area
});

test("flat base: two-island mask closes with two loops", () => {
  const { grid, gw, gh } = flatGrid(11, 5);
  const mask = new Uint8Array((gw - 1) * (gh - 1));
  for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) mask[r * 10 + c] = 1; // island A: 12 cells
  for (let r = 0; r < 4; r++) for (let c = 6; c < 10; c++) mask[r * 10 + c] = 1; // island B: 16 cells
  const m = buildSolid(grid, gw, gh, { r0: 0, r1: gh - 1, c0: 0, c1: gw - 1 }, mask, GEOM);
  assert.ok(checkWatertight(m).closed, `unmatched ${checkWatertight(m).unmatched}`);
  assert.ok(Math.abs(signedVolume(m) - (12 + 16) * 3) < 1e-3);
});

test("flat base: U-shaped rim (centroid in the notch) ear-clips flat", () => {
  // 24×12 cells minus an 8×8 notch from the top middle. The rim's vertex-average
  // centroid lands inside the notch (outside the polygon), so the centroid fan
  // fails and ear-clip must cover the base — still under the mirror's 2×-top.
  const { grid, gw, gh } = flatGrid(25, 13);
  const cw = gw - 1;
  const mask = new Uint8Array(cw * (gh - 1)).fill(1);
  for (let r = 0; r < 8; r++) for (let c = 8; c < 16; c++) mask[r * cw + c] = 0;
  const m = buildSolid(grid, gw, gh, { r0: 0, r1: gh - 1, c0: 0, c1: cw }, mask, GEOM);
  assert.ok(checkWatertight(m).closed, `unmatched ${checkWatertight(m).unmatched}`);
  const nTop = 2 * (24 * 12 - 64); // 448
  assert.ok(m.indices.length / 3 < 2 * nTop, `tris ${m.indices.length / 3} (mirror ≥ ${2 * nTop})`);
  assert.ok(Math.abs(signedVolume(m) - (24 * 12 - 64) * 3) < 1e-3);
});

test("flat base: donut footprint falls back to mirror and stays closed", () => {
  const { grid, gw, gh } = flatGrid(9, 9);
  const mask = new Uint8Array(64).fill(1);
  mask[3 * 8 + 3] = mask[3 * 8 + 4] = mask[4 * 8 + 3] = mask[4 * 8 + 4] = 0; // interior hole
  const m = buildSolid(grid, gw, gh, { r0: 0, r1: 8, c0: 0, c1: 8 }, mask, GEOM);
  assert.ok(checkWatertight(m).closed, `unmatched ${checkWatertight(m).unmatched}`);
  assert.ok(Math.abs(signedVolume(m) - (64 - 4) * 3) < 1e-3);
});
