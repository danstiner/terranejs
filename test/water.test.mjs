import { test } from "node:test";
import assert from "node:assert/strict";
import { oceanMask, oceanMaskSeeded, cellOcean, erodeMask, recessedGrid,
  offsetGrid } from "../js/water.js";
import { buildSolid } from "../js/mesh.js";
import { checkWatertight } from "../js/stl.js";

// 5×5: left two columns below sea level (open sea, reaches the edge); one
// interior sub-sea pit at (2,3) that is NOT edge-connected (Badwater case).
function coastalGrid() {
  const gw = 5, gh = 5;
  const e = new Float32Array(gw * gh).fill(10);
  for (let r = 0; r < gh; r++) { e[r * gw + 0] = -1; e[r * gw + 1] = -1; }
  e[2 * gw + 3] = -1;
  return { e, gw, gh };
}

test("oceanMask floods open sea from the edge", () => {
  const { e, gw, gh } = coastalGrid();
  const m = oceanMask(e, gw, gh, 0);
  for (let r = 0; r < gh; r++) {
    assert.equal(m[r * gw + 0], 1, "col 0 is ocean");
    assert.equal(m[r * gw + 1], 1, "col 1 is ocean");
    assert.equal(m[r * gw + 2], 0, "col 2 is land");
  }
});

test("oceanMask leaves an interior sub-sea basin as land (Badwater)", () => {
  const { e, gw, gh } = coastalGrid();
  const m = oceanMask(e, gw, gh, 0);
  assert.equal(m[2 * gw + 3], 0, "interior -1 pit not connected to the sea");
});

test("oceanMask: fully-above-sea grid has no ocean", () => {
  const g = new Float32Array(16).fill(100);
  assert.ok(oceanMask(g, 4, 4, 0).every((v) => v === 0));
});

test("oceanMask: raising the level floods more", () => {
  const g = new Float32Array(9).fill(5);
  g[0] = 3; // one edge vertex at 3 m
  assert.equal(oceanMask(g, 3, 3, 0).reduce((a, b) => a + b), 0);
  assert.equal(oceanMask(g, 3, 3, 4).reduce((a, b) => a + b), 1); // now the 3 m vertex floods
});

test("cellOcean: a cell is ocean only if all 4 corners are", () => {
  const { e, gw, gh } = coastalGrid();
  const cm = cellOcean(oceanMask(e, gw, gh, 0), gw, gh);
  const cw = gw - 1;
  for (let r = 0; r < gh - 1; r++) {
    assert.equal(cm[r * cw + 0], 1, "col-0 cells fully ocean");
    assert.equal(cm[r * cw + 1], 0, "col-1 cells touch land");
  }
});

test("erodeMask shrinks a full mask by ring layers", () => {
  const cw = 5, ch = 5;
  const full = new Uint8Array(cw * ch).fill(1);
  const e1 = erodeMask(full, cw, ch, 1);
  assert.equal(e1[0], 0, "corner eroded");
  assert.equal(e1[2 * cw + 2], 1, "center survives 1 ring");
  const e2 = erodeMask(full, cw, ch, 2);
  assert.equal(e2[2 * cw + 2], 1, "center survives 2 rings");
  assert.equal(e2[1 * cw + 1], 0, "one-in cell gone after 2 rings");
});

test("recessedGrid flattens ocean vertices, keeps land", () => {
  const elev = Float32Array.from([1, 2, 3, 4]);
  const vmask = Uint8Array.from([1, 0, 1, 0]);
  const out = recessedGrid(elev, vmask, -5);
  assert.deepEqual([...out], [-5, 2, -5, 4]);
  assert.notEqual(out, elev, "returns a copy");
});

test("oceanMaskSeeded: floods from seeds through ≤0, ignores unseeded basins", () => {
  const { e, gw, gh } = coastalGrid(); // cols 0-1 open sea, pit at (2,3), land 10 m
  // one seed in the sea column -> whole connected sea floods
  const seeds = new Uint8Array(gw * gh);
  seeds[2 * gw + 0] = 1;
  const m = oceanMaskSeeded(e, gw, gh, seeds);
  for (let r = 0; r < gh; r++) {
    assert.equal(m[r * gw + 0], 1, "sea col 0 flooded from one seed");
    assert.equal(m[r * gw + 1], 1, "sea col 1 flooded from one seed");
  }
  assert.equal(m[2 * gw + 3], 0, "unseeded interior pit stays land (even at a tile edge)");
});

test("oceanMaskSeeded: a seed on land is ignored", () => {
  const { e, gw, gh } = coastalGrid();
  const seeds = new Uint8Array(gw * gh);
  seeds[2 * gw + 2] = 1; // land vertex (10 m)
  assert.ok(oceanMaskSeeded(e, gw, gh, seeds).every((v) => v === 0));
});

test("offsetGrid lowers only ocean vertices, keeps their relief", () => {
  const elev = Float32Array.from([-10, 2, -30, 4]);
  const vmask = Uint8Array.from([1, 0, 1, 0]);
  const out = offsetGrid(elev, vmask, 5);
  assert.deepEqual([...out], [-15, 2, -35, 4]);
  assert.notEqual(out, elev, "returns a copy");
});

// --- separate water insert (bathymetry-backed, printed flat face down) ------
// Replicates app.js's export construction on a small coastal grid and checks
// the geometry contract: watertight; printed top z = drop + depth·mmPerM·exag;
// and once flipped north-south the piece registers with the offset terrain
// (insert top thickness == sea-level z − recessed-floor z at every vertex).

const DROP = 3, MM_PER_M = 0.01, EXAG = 2; // 1:100000, 2× exaggeration
const K = MM_PER_M * EXAG;

function insertFixture() {
  const gw = 5, gh = 6, dx = 1, dy = 1;
  const e = new Float32Array(gw * gh).fill(10);
  // left two columns are open sea, depth growing southward (row-asymmetric)
  for (let r = 0; r < gh; r++) { e[r * gw + 0] = -100 * (r + 1); e[r * gw + 1] = -50; }
  const oMask = oceanMask(e, gw, gh, 0);
  const cells = cellOcean(oMask, gw, gh); // col-0 cells only (col-1 corners touch land)

  // row-mirrored depth grid + cell mask, exactly as exportSTLs builds them
  const depthFlip = new Float32Array(gw * gh);
  for (let r = 0; r < gh; r++) {
    for (let c = 0; c < gw; c++) depthFlip[(gh - 1 - r) * gw + c] = Math.max(0, -e[r * gw + c]);
  }
  const cw = gw - 1;
  const cellsFlip = new Uint8Array(cw * (gh - 1));
  for (let r = 0; r < gh - 1; r++) {
    cellsFlip.set(cells.subarray(r * cw, (r + 1) * cw), (gh - 2 - r) * cw);
  }
  const solid = buildSolid(depthFlip, gw, gh,
    { r0: 0, r1: gh - 1, c0: 0, c1: gw - 1 }, cellsFlip,
    { dx, dy, mmPerM: MM_PER_M, emin: 0, exag: EXAG, base: DROP });
  return { gw, gh, dx, dy, e, oMask, cells, solid };
}

// top-surface z by printed (x,y), extracted from the triangle soup
function topZ(solid) {
  const z = new Map();
  for (let i = 0; i < solid.length; i += 3) {
    if (solid[i + 2] > 0) z.set(`${solid[i]}_${solid[i + 1]}`, solid[i + 2]);
  }
  return z;
}

test("water insert: closed manifold", () => {
  const { solid } = insertFixture();
  const w = checkWatertight(solid);
  assert.ok(w.closed, `unmatched edges: ${w.unmatched}`);
});

test("water insert: printed top = drop + depth·mmPerM·exag, min thickness = drop", () => {
  const { gw, gh, dx, dy, e, solid } = insertFixture();
  const z = topZ(solid);
  // footprint = col-0 cells; printed y for source row r is (r − r0)·dy = r·dy
  for (let r = 0; r < gh; r++) {
    for (const c of [0, 1]) {
      const got = z.get(`${c * dx}_${r * dy}`);
      const want = DROP + Math.max(0, -e[r * gw + c]) * K;
      assert.ok(Math.abs(got - want) < 1e-5, `(r${r},c${c}): ${got} vs ${want}`);
    }
  }
  assert.ok(Math.min(...z.values()) >= DROP - 1e-5, "shore-edge thickness ≥ drop");
});

test("water insert: flipped piece registers with the offset terrain", () => {
  const { gw: W, gh, dx, dy, e, oMask, solid } = insertFixture();
  const z = topZ(solid);
  const baked = offsetGrid(e, oMask, DROP / K); // terrain grid in insert mode
  let emin = Infinity;
  for (const v of baked) emin = Math.min(emin, v);
  const seaZ = (0 - emin) * K; // sea-level height above the tile base
  for (let r = 0; r < gh; r++) {
    for (const c of [0, 1]) {
      // flipping north-south sends printed (x, r·dy) to terrain (x, (gh−1−r)·dy);
      // there the insert must fill from the recessed floor up to sea level
      const thickness = z.get(`${c * dx}_${r * dy}`);
      const gap = seaZ - (baked[r * W + c] - emin) * K;
      assert.ok(Math.abs(thickness - gap) < 1e-5, `(r${r},c${c}): ${thickness} vs ${gap}`);
    }
  }
});
