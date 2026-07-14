import { test } from "node:test";
import assert from "node:assert/strict";
import { oceanMask, oceanMaskSeeded, cellOcean, erodeMask, recessedGrid } from "../js/water.js";
import { buildSolid } from "../js/mesh.js";
import { checkWatertight } from "../js/validate.js";

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

test("oceanMask: wrapper matches a reference frame-edge flood", () => {
  // reference: the pre-refactor standalone frame flood
  const ref = (elev, gw, gh, levelM = 0) => {
    const mask = new Uint8Array(gw * gh), stack = [];
    const push = (i) => { if (!mask[i] && elev[i] <= levelM) { mask[i] = 1; stack.push(i); } };
    for (let c = 0; c < gw; c++) { push(c); push((gh - 1) * gw + c); }
    for (let r = 0; r < gh; r++) { push(r * gw); push(r * gw + gw - 1); }
    while (stack.length) {
      const i = stack.pop(), r = (i / gw) | 0, c = i % gw;
      if (c > 0) push(i - 1); if (c < gw - 1) push(i + 1);
      if (r > 0) push(i - gw); if (r < gh - 1) push(i + gw);
    }
    return mask;
  };
  const { e, gw, gh } = coastalGrid();
  assert.deepEqual([...oceanMask(e, gw, gh, 0)], [...ref(e, gw, gh, 0)]);
  const g = new Float32Array(9).fill(5); g[0] = 3;
  assert.deepEqual([...oceanMask(g, 3, 3, 4)], [...ref(g, 3, 3, 4)], "level-raising path too");
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

// --- separate water insert (flat slab, printed flat face down) --------------
// The insert fills the flat ocean recess to sea level: a constant-thickness
// slab (thickness = waterDrop). Bathymetry is discarded, so there is no molded
// underside and no north-south flip — flat top and bottom share the terrain's
// XY frame, so the slab drops into the recess as printed.

const DROP = 3, MM_PER_M = 0.01, EXAG = 2; // 1:100000, 2× exaggeration
const K = MM_PER_M * EXAG;

function slabFixture() {
  const gw = 5, gh = 6, dx = 1, dy = 1;
  const e = new Float32Array(gw * gh).fill(10);
  // left two columns are open sea (edge-connected); their depth is irrelevant now
  for (let r = 0; r < gh; r++) { e[r * gw + 0] = -100; e[r * gw + 1] = -50; }
  const oMask = oceanMask(e, gw, gh, 0);
  const cells = cellOcean(oMask, gw, gh); // col-0 cells only
  const slab = new Float32Array(gw * gh); // flat top at sea level
  const solid = buildSolid(slab, gw, gh,
    { r0: 0, r1: gh - 1, c0: 0, c1: gw - 1 }, cells,
    { dx, dy, mmPerM: 1, emin: 0, exag: 1, base: DROP });
  return { gw, gh, dx, dy, e, oMask, cells, solid };
}

test("water insert: flat slab is a closed manifold", () => {
  const { solid } = slabFixture();
  const w = checkWatertight(solid);
  assert.ok(w.closed, `unmatched edges: ${w.unmatched}`);
});

test("water insert: every vertex is at z=0 (base) or z=DROP (top)", () => {
  const { solid } = slabFixture();
  const P = solid.positions;
  let zmin = Infinity, zmax = -Infinity;
  for (let i = 2; i < P.length; i += 3) {
    const z = P[i];
    assert.ok(Math.abs(z) < 1e-6 || Math.abs(z - DROP) < 1e-6, `z ${z} not 0 or ${DROP}`);
    zmin = Math.min(zmin, z); zmax = Math.max(zmax, z);
  }
  assert.equal(zmin, 0); assert.equal(zmax, DROP);
});

test("water insert: slab thickness + measured recess floor reaches sea level", () => {
  // slab thickness, measured from the slab mesh
  const sp = slabFixture().solid.positions;
  let sMin = Infinity, sMax = -Infinity;
  for (let i = 2; i < sp.length; i += 3) { sMin = Math.min(sMin, sp[i]); sMax = Math.max(sMax, sp[i]); }
  const slabThk = sMax - sMin;

  // terrain grid: west sea (recessed) + one land vertex pinned at sea level
  // (0 m). That vertex is interior and ringed by +10 m land, so the ≤0 ocean
  // flood can't reach it — it stays land, and its printed top z reads sea level.
  const gw = 5, gh = 6, dx = 1, dy = 1;
  const e = new Float32Array(gw * gh).fill(10);
  for (let r = 0; r < gh; r++) { e[r * gw + 0] = -100; e[r * gw + 1] = -50; }
  const seaR = 2, seaC = 3;
  e[seaR * gw + seaC] = 0; // sea-level marker
  const oMask = oceanMask(e, gw, gh, 0);
  assert.equal(oMask[seaR * gw + seaC], 0, "sea-level marker must stay land, not ocean");

  const baked = recessedGrid(e, oMask, -DROP / K);
  let emin = Infinity; for (const v of baked) emin = Math.min(emin, v);
  const TBASE = 5;
  const terrain = buildSolid(baked, gw, gh,
    { r0: 0, r1: gh - 1, c0: 0, c1: gw - 1 },
    new Uint8Array((gw - 1) * (gh - 1)).fill(1),
    { dx, dy, mmPerM: MM_PER_M, emin, exag: EXAG, base: TBASE });

  // both z's read from real mesh vertices, so the assertion exercises the
  // builder's base + (grid-emin)*mmPerM*exag scaling (not an identity):
  // recess floor = lowest top-surface z; sea level = top z at the 0 m marker.
  const tz = terrain.positions;
  const mx = (seaC - 0) * dx, my = ((gh - 1) - seaR) * dy; // marker world xy
  let recessFloorZ = Infinity, seaZ = -Infinity;
  for (let i = 0; i < tz.length; i += 3) {
    const x = tz[i], y = tz[i + 1], z = tz[i + 2];
    if (z > 1e-6) recessFloorZ = Math.min(recessFloorZ, z);
    if (z > 1e-6 && Math.abs(x - mx) < 1e-6 && Math.abs(y - my) < 1e-6) seaZ = z;
  }
  // a slab of the measured thickness, seated on the measured recess floor,
  // tops out exactly at the measured sea-level surface
  assert.ok(Math.abs((recessFloorZ + slabThk) - seaZ) < 1e-4,
    `recessFloor ${recessFloorZ} + slab ${slabThk} != seaZ ${seaZ}`);
});

// --- z10 detection-view regression (Puget Sound bug) ----------------------
// Justify the retained z10 mask fetch: the flood must run on the clean z10
// water view; on the fine geometry grid coastal water reads as junk/positive.

test("water view: flood must run on the z10 detection view, not the geometry grid", () => {
  const gw = 12, gh = 6;
  // geometry grid as z11 serves it over Puget Sound: land-DEM junk, +1 m water
  const junk = new Float32Array(gw * gh).fill(1);
  // water view as z10 serves it: a −50 m channel connected to the west edge
  const water = new Float32Array(gw * gh).fill(20);
  for (let c = 0; c < 9; c++) water[2 * gw + c] = -50;
  const seeds = new Uint8Array(gw * gh);
  seeds[2 * gw + 0] = 1; // coarse mask found ocean at the west edge
  const onJunk = oceanMaskSeeded(junk, gw, gh, seeds);
  const onWater = oceanMaskSeeded(water, gw, gh, seeds);
  assert.equal(onJunk.reduce((a, b) => a + b, 0), 0, "junk grid: flood finds nothing (the bug)");
  for (let c = 0; c < 9; c++) assert.equal(onWater[2 * gw + c], 1, "water view: channel continuous");
  assert.equal(onWater.reduce((a, b) => a + b, 0), 9, "only the channel floods");
});

test("water view: unseeded interior basin stays dry (Badwater)", () => {
  const gw = 8, gh = 8;
  const water = new Float32Array(gw * gh).fill(20);
  water[3 * gw + 3] = -86; // interior sub-sea basin, not seed-connected
  const seeds = new Uint8Array(gw * gh);
  seeds[0] = 1; // an edge seed on +20 m land: dies at the level check
  const m = oceanMaskSeeded(water, gw, gh, seeds);
  assert.equal(m.reduce((a, b) => a + b, 0), 0);
});
