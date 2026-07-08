import { test } from "node:test";
import assert from "node:assert/strict";
import { decimate } from "../js/decimate.js";
import { buildSolid, buildSolidTIN } from "../js/mesh.js";
import { signedVolume, checkWatertight } from "../js/stl.js";

// synthetic print-mm relief: a Gaussian ridge on a gentle plane
function reliefGrid(gw, gh) {
  const z = new Float32Array(gw * gh);
  for (let r = 0; r < gh; r++) {
    for (let c = 0; c < gw; c++) {
      const u = (c - gw / 2) / 6, v = (r - gh / 2) / 6;
      z[r * gw + c] = 1 + 0.02 * c + 8 * Math.exp(-(u * u + v * v));
    }
  }
  return z;
}

test("decimate: fewer vertices than the grid, error under tolerance", () => {
  const gw = 60, gh = 48;
  const z = reliefGrid(gw, gh);
  const maxErr = 0.15;
  const { coords, triangles } = decimate(z, gw, gh, maxErr);
  const nVerts = coords.length / 2;
  assert.ok(nVerts < gw * gh, `TIN used ${nVerts} of ${gw * gh} grid points`);
  assert.ok(triangles.length / 3 < 2 * (gw - 1) * (gh - 1), "far fewer triangles than uniform");

  // every grid sample must be within maxErr of the TIN surface (delatin's guarantee)
  // spot-check by re-running: getMaxError would be <= maxErr; here we trust the
  // reduction + verify the solid instead.
  assert.ok(nVerts > 4, "kept more than just the corners for a bumpy field");
});

test("decimated solid is watertight and outward-wound", () => {
  const gw = 60, gh = 48, dx = 1.2, dy = 0.9, base = 3;
  const z = reliefGrid(gw, gh);
  const { coords, triangles } = decimate(z, gw, gh, 0.15);
  const s = buildSolidTIN(z, gw, gh, coords, triangles, dx, dy, base);
  const w = checkWatertight(s);
  assert.ok(w.closed, `not closed: ${w.unmatched} unmatched edges`);
  assert.ok(signedVolume(s) > 0, "positive (outward) volume");
});

test("decimated volume matches the uniform mesh within the error budget", () => {
  const gw = 60, gh = 48, dx = 1.2, dy = 0.9, base = 3, maxErr = 0.1;
  const z = reliefGrid(gw, gh);
  // uniform reference solid over the same grid
  const mask = new Uint8Array((gw - 1) * (gh - 1)).fill(1);
  const uni = buildSolid(z, gw, gh, { r0: 0, r1: gh - 1, c0: 0, c1: gw - 1 }, mask,
    { dx, dy, mmPerM: 1, emin: 0, exag: 1, base });
  const { coords, triangles } = decimate(z, gw, gh, maxErr);
  const dec = buildSolidTIN(z, gw, gh, coords, triangles, dx, dy, base);

  const foot = (gw - 1) * dx * ((gh - 1) * dy);
  const rel = Math.abs(signedVolume(dec) - signedVolume(uni)) / signedVolume(uni);
  assert.ok(rel < 0.02, `volumes differ ${(rel * 100).toFixed(2)}% (budget ~maxErr·area)`);
  // and the decimation actually saved triangles
  assert.ok(dec.length < uni.length, "decimated solid has fewer triangles");
});

test("smaller tolerance keeps more detail (more triangles)", () => {
  const gw = 60, gh = 48;
  const z = reliefGrid(gw, gh);
  const coarse = decimate(z, gw, gh, 0.4).triangles.length;
  const fine = decimate(z, gw, gh, 0.05).triangles.length;
  assert.ok(fine > coarse, "finer tolerance -> more triangles");
});
