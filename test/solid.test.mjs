import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSolid } from "../js/mesh.js";
import { signedVolume, checkWatertight } from "../js/validate.js";

const golden = JSON.parse(readFileSync(new URL("./reference/expected.json", import.meta.url)));

function fullTileSolid(extra = {}) {
  const { H, W, dx, dy, base, relief } = golden.solid;
  const grid = Float32Array.from(relief.flat());
  const mask = new Uint8Array((W - 1) * (H - 1)).fill(1);
  // grid holds relief mm directly -> z = base + relief (emin 0, mmPerM 1, exag 1)
  return buildSolid(grid, W, H, { r0: 0, r1: H - 1, c0: 0, c1: W - 1 }, mask,
    { dx, dy, mmPerM: 1, emin: 0, exag: 1, base, ...extra });
}

test("buildSolid: full tile is a closed manifold", () => {
  const s = fullTileSolid();
  assert.ok(checkWatertight(s).closed, `unmatched edges: ${checkWatertight(s).unmatched}`);
});

test("buildSolid: encloses the same volume as topotile.build_solid", () => {
  const s = fullTileSolid();
  const v = signedVolume(s);
  const err = Math.abs(v - golden.solid.volume);
  assert.ok(err < 0.5, `volume ${v.toFixed(3)} vs golden ${golden.solid.volume.toFixed(3)}`);
});

test("buildSolid: clipped footprint stays watertight and smaller", () => {
  const { H, W, dx, dy, base, relief } = golden.solid;
  const grid = Float32Array.from(relief.flat());
  // knock out an L-shaped corner block of cells -> non-rectangular footprint
  const mask = new Uint8Array((W - 1) * (H - 1)).fill(1);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) mask[r * (W - 1) + c] = 0;
  const s = buildSolid(grid, W, H, { r0: 0, r1: H - 1, c0: 0, c1: W - 1 }, mask,
    { dx, dy, mmPerM: 1, emin: 0, exag: 1, base });
  const w = checkWatertight(s);
  assert.ok(w.closed, `clipped solid not closed: ${w.unmatched} unmatched`);
  assert.ok(signedVolume(s) < golden.solid.volume, "clipped volume < full");
  assert.ok(signedVolume(s) > 0, "clipped volume positive (outward-wound)");
});

test("buildSolid: exaggeration scales relief volume, not base", () => {
  const { H, W, dx, dy, base } = golden.solid;
  const foot = (W - 1) * dx * ((H - 1) * dy);
  const s1 = fullTileSolid();
  const s2 = fullTileSolid({ exag: 2 });
  const relief1 = signedVolume(s1) - foot * base; // volume above the base plate
  const relief2 = signedVolume(s2) - foot * base;
  assert.ok(Math.abs(relief2 - 2 * relief1) < 1e-2, "relief volume should double at 2×");
});
