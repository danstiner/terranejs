// The ribbon's reason for existing is that its underside mates with the printed terrain. That
// is a property of vertex positions, so it is asserted directly rather than through a proxy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { buildSolid } from "../src/core/mesh.js";
import { cordSolid, admissibleCells, trenchWidthMm, subK } from "../src/core/cord.js";
import { checkWatertight, signedVolume, checkNoCoincidentFaces } from "../src/core/validate.js";
import { planTile, bakeTileSolid, tileTo3mf } from "../src/core/pipeline.js";
import { globalXToLon, globalYToLat } from "../src/core/tilemath.js";

const GW = 60, GH = 60, H = 0.6, W = 1.6;
const SPAN = { r0: 0, r1: GH - 1, c0: 0, c1: GW - 1 };
const GEOM = { dx: 0.5, dy: 0.5, mmPerM: 0.04, emin: 0, exag: 1, base: 3 };
const PLAN = /** @type {any} */ ({ gw: GW, gh: GH, dx: GEOM.dx, dy: GEOM.dy, span: SPAN });
const ALL = admissibleCells(GW, GH, null);

/** Lumpy but smooth terrain, so relief varies under the cord. The PRODUCT term is load-bearing,
 *  not decoration: a separable f(c)+g(r) grid has zero twist in every cell, and there bilinear
 *  and the terrain's two triangle planes agree exactly — so a separable fixture cannot tell a
 *  correct underside from a bilinear one. Bounded rather than a plain c*r, which would push
 *  relief high enough for float32 spacing to swamp the 0.6 mm thickness check below. */
const grid = new Float32Array(GW * GH);
for (let r = 0; r < GH; r++)
  for (let c = 0; c < GW; c++)
    grid[r * GW + c] = 40 * Math.sin(c / 7) + 25 * Math.cos(r / 5)
      + 12 * Math.sin(c / 9) * Math.cos(r / 7) + 100;

/** @param {Float64Array[]} polys @param {number} [widthMm] */
const cord = (polys, widthMm = W) => cordSolid(grid, PLAN, polys, widthMm, H, GEOM, ALL, GEOM.base);

/** Triangles with no area. checkWatertight is topology-only — it counts edges and never looks
 *  at a coordinate — so a sliver between two coincident vertices is invisible to it, and to
 *  signedVolume. Slicers are the ones that trip over them.
 *  @param {import("../src/core/types.js").Solid} s */
function zeroAreaTris(s) {
  const { positions: P, indices: I } = s;
  let n = 0;
  for (let i = 0; i < I.length; i += 3) {
    const [a, b, c] = [3 * I[i], 3 * I[i + 1], 3 * I[i + 2]];
    const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
    const v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const n2 = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
    if (n2 <= 1e-12) n++;
  }
  return n;
}

// y = (r1 − row)·dy, so these sit around grid row 30 — mid-tile, clear of every edge.
const BAND = [Float64Array.from([2, 14.5, 27, 14.5])];
const CURVED = [Float64Array.from(
  Array.from({ length: 40 }, (_, i) => [2 + i * 0.64, 14.5 + 5 * Math.sin(i / 6)]).flat())];
const CROSS = [Float64Array.from([2, 14.5, 27, 14.5]), Float64Array.from([11, 2, 11, 27])];
const RETRACE = [Float64Array.from([2, 14.5, 27, 14.5, 2, 14.5])];
const TWO = [Float64Array.from([2, 24, 27, 24]), Float64Array.from([2, 5, 27, 5])];

test("ribbon is watertight and positive-volume for every trail shape", () => {
  /** @type {[string, Float64Array[]][]} */
  const shapes = [["straight", BAND], ["curved", CURVED], ["crossing", CROSS],
    ["out-and-back", RETRACE], ["two segments", TWO]];
  for (const [name, polys] of shapes) {
    const rib = cord(polys);
    assert.ok(rib, `${name}: built`);
    const wt = checkWatertight(rib);
    assert.ok(wt.closed, `${name}: ${wt.unmatched} unmatched edges`);
    assert.ok(signedVolume(rib) > 0, `${name}: inside-out`);
    assert.equal(zeroAreaTris(rib), 0, `${name}: degenerate triangles`);
  }
});

/** z extremes per (x,y) column — the only way to compare vertices across two meshes, whose
 *  internal ids are unrelated.
 *  @param {Float32Array} P */
function columns(P) {
  const m = new Map();
  for (let i = 0; i < P.length / 3; i++) {
    const k = `${P[3 * i].toFixed(6)},${P[3 * i + 1].toFixed(6)}`;
    const z = P[3 * i + 2], cur = m.get(k);
    if (!cur) m.set(k, { lo: z, hi: z });
    else { cur.lo = Math.min(cur.lo, z); cur.hi = Math.max(cur.hi, z); }
  }
  return m;
}

// Cross-mesh congruence: read the terrain height off the TILE SOLID's own emitted vertices,
// through the tile's own triangulation, and compare it to the cord's underside at the same x,y.
// The cord's vertices mostly do NOT coincide with grid vertices any more, so this interpolates —
// and interpolating on the wrong surface is exactly the bug being hunted. A bilinear sample, or
// a cord triangle straddling two terrain triangles, both break the constancy asserted here; the
// absolute plane values are pinned separately in cord.test.mjs.
/** Per-column gap from the cord's underside up to the tile's printed surface, plus the cord's
 *  own lowest vertex.
 *  @param {import("../src/core/types.js").Solid} rib */
function undersideGaps(rib) {
  const tile = buildSolid(grid, GW, GH, SPAN, new Uint8Array((GW - 1) * (GH - 1)).fill(1), GEOM);
  const top = columns(tile.positions); // hi = terrain surface, lo = the z-0 base plane
  /** Tile surface height at fractional grid coords, from the tile mesh's own vertices.
   * @param {number} col @param {number} row */
  const tileZ = (col, row) => {
    const c = Math.min(Math.floor(col), GW - 2), r = Math.min(Math.floor(row), GH - 2);
    const u = col - c, v = row - r;
    /** @param {number} cc @param {number} rr */
    const at = (cc, rr) => top.get(`${(cc * GEOM.dx).toFixed(6)},${((GH - 1 - rr) * GEOM.dy).toFixed(6)}`).hi;
    const [A, B, C, D] = [at(c, r), at(c + 1, r), at(c, r + 1), at(c + 1, r + 1)];
    return u + v <= 1 ? A + u * (B - A) + v * (C - A) : D + (1 - u) * (C - D) + (1 - v) * (B - D);
  };

  const P = rib.positions;
  const seen = new Map(); // (x,y) -> lowest z, i.e. the molded underside
  for (let i = 0; i < P.length / 3; i++) {
    const k = `${P[3 * i].toFixed(6)},${P[3 * i + 1].toFixed(6)}`;
    seen.set(k, Math.min(seen.get(k) ?? Infinity, P[3 * i + 2]));
  }
  /** @type {{ k: string, gap: number }[]} */
  const gaps = [];
  let lowest = Infinity;
  for (const [k, lo] of seen) {
    const [x, y] = k.split(",").map(Number);
    gaps.push({ k, gap: tileZ(x / GEOM.dx, GH - 1 - y / GEOM.dy) - lo });
    lowest = Math.min(lowest, lo);
  }
  return { gaps, lowest };
}

// The only placement there is, and the claim it rests on: the underside is the printed surface
// exactly, not merely parallel to it. It shipped broken once — the preview drew the export's
// plate-dropped cord, so every column's gap was base plus the cord's own floor, the whole cord
// buried inside an opaque tile. A non-zero constant here is that bug, whatever produced it.
test("the cord's underside IS the printed surface", () => {
  const rib = cordSolid(grid, PLAN, BAND, W, H, GEOM, ALL, GEOM.base);
  assert.ok(rib);
  const { gaps } = undersideGaps(rib);
  assert.ok(gaps.length > 200, `only ${gaps.length} columns compared`);
  for (const { k, gap } of gaps) assert.ok(Math.abs(gap) < 1e-5, `column ${k}: sits ${gap} mm below the surface`);
});

test("the cord has uniform thickness over every column", () => {
  const rib = cord(BAND);
  assert.ok(rib);
  for (const { lo, hi } of columns(rib.positions).values()) {
    // 1e-5: hi and lo are both float32, so their difference carries that spacing (see above).
    assert.ok(Math.abs(hi - lo - H) < 1e-5, `thickness ${hi - lo}, expected ${H}`);
  }
});

// The degenerate case the crossing-weld exists for. Everything here is an exact multiple of the
// 0.5 mm pitch — trail on a lattice row, half-width exactly two sub-cells — so the cord's edges
// land ON lattice vertices and their distance-to-trail is exactly the half-width. Those vertices
// read as outside (the test is strict), and every crossing into them lands at t = 1. Welded to
// the vertex, the clip degrades to the right closure. Unwelded, each incident edge mints its own
// vertex at that same point, and the clipped polygon closes through two coincident corners — a
// zero-area sliver. It stays topologically closed, so only zeroAreaTris sees it.
// Measure-zero in real terrain, ordinary in an axis-aligned fixture — and in a hand-drawn trail.
test("a cord whose edges land exactly on lattice vertices is still closed", () => {
  const rib = cordSolid(grid, PLAN, [Float64Array.from([5, 14.5, 20, 14.5])], 2.0, H, GEOM, ALL, GEOM.base);
  assert.ok(rib);
  const wt = checkWatertight(rib);
  assert.ok(wt.closed, `${wt.unmatched} unmatched edges`);
  assert.ok(signedVolume(rib) > 0);
  assert.equal(zeroAreaTris(rib), 0, "an unwelded crossing leaves a sliver between coincident points");
  let lo = Infinity, hi = -Infinity;
  for (let i = 1; i < rib.positions.length; i += 3) {
    lo = Math.min(lo, rib.positions[i]); hi = Math.max(hi, rib.positions[i]);
  }
  assert.ok(Math.abs(hi - lo - 2.0) < 1e-5, `spans ${(hi - lo).toFixed(6)} mm, want 2`);
});

test("an empty corridor yields no ribbon", () => {
  assert.equal(cord([Float64Array.from([-99, -99, -80, -99])]), null);
});

// Same coarse-pitch case as cord.test.mjs, one level up: the assembled solid, not the soup.
// A cord under two cells wide exercises the clip against far fewer parent triangles, so the
// boundary is nearly all sub-cell crossings — assemble it and check it still closes.
test("the ribbon is watertight at preview pitch", () => {
  const N = 64;
  const g = new Float32Array(N * N);
  for (let r = 0; r < N; r++)
    for (let c = 0; c < N; c++)
      g[r * N + c] = 40 * Math.sin(c / 7) + 25 * Math.cos(r / 5) + 12 * Math.sin(c / 9) * Math.cos(r / 7) + 100;
  const pitch = 0.8365;                             // FAST tier, where 1.6 mm is 1.91 cells
  const plan = /** @type {any} */ ({ gw: N, gh: N, dx: pitch, dy: pitch,
    span: { r0: 0, r1: N - 1, c0: 0, c1: N - 1 } });
  const mid = ((N - 1) * pitch) / 2, len = (N - 6) * pitch;
  /** @type {[string, Float64Array[]][]} */
  const shapes = [
    ["straight", [Float64Array.from([2 * pitch, mid, len, mid])]],
    ["curved", [Float64Array.from(Array.from({ length: 40 },
      (_, i) => [2 * pitch + (i * len) / 40, mid + 5 * Math.sin(i / 6)]).flat())]],
  ];
  for (const [name, polys] of shapes) {
    const s = cordSolid(g, plan, polys, W, H, { mmPerM: 0.04, emin: 0, exag: 1 },
      admissibleCells(N, N, null), 3);
    assert.ok(s, `${name}: no ribbon`);
    const wt = checkWatertight(s);
    assert.ok(wt.closed, `${name}: ${wt.unmatched} unmatched edges`);
    assert.ok(signedVolume(s) > 0, `${name}: non-positive volume`);
  }
});

// --- pipeline wiring: bakeTileSolid / tileTo3mf --------------------------

// Equator + prime meridian → integer global-pixel origin, matching pipeline.test.mjs's fixture
// so plan.dx (2.5 mm at z10) is exact rather than lat-dependent.
const PIPE_SETTINGS = { center: /** @type {[number, number]} */ ([0, 0]), scale: 61150, tileWidthMm: 100, base: 5, exag: 2 };

/** Flat elevation grid exactly covering a plan's window.
 * @param {ReturnType<typeof planTile>} plan @param {number} [elev] */
function flatMosaicFor(plan, elev = 100) {
  const { gx0, gy0, gw, gh } = plan.window;
  return { data: new Float32Array(gw * gh).fill(elev), width: gw, height: gh, originGx: gx0, originGy: gy0, z: plan.z };
}

/** A straight trail across the middle of a plan's window, in that plan's own coordinates.
 *  widthMm is deliberately large: these fixtures use tiny windows, and a 1 mm cord would be
 *  narrower than the test plan's own pitch. `inset` is how many columns short of the window edge
 *  the trail stops — the default runs it out over the rim, where the channel stops before the cord
 *  does; a caller measuring the cord against the FLOOR has to clear the feather ramp that leaves.
 *  @param {ReturnType<typeof planTile>} plan @param {number} [widthMm] @param {number} [inset] */
function trailAcross(plan, widthMm = 12, inset = 2) {
  const { window: win, z } = plan;
  const lat = globalYToLat(win.gy0 + Math.floor(win.gh / 2), z);
  return {
    segments: /** @type {import("../src/core/types.js").LatLon[][]} */ ([[
      [lat, globalXToLon(win.gx0 + inset, z)],
      [lat, globalXToLon(win.gx0 + win.gw - 1 - inset, z)],
    ]]),
    widthMm, heightMm: 1.5,
  };
}

/** Print mm back to lat/lon, the inverse of trailToPrintMm's own mapping.
 *  @param {any} plan @param {number} xMm @param {number} yMm
 *  @returns {import("../src/core/types.js").LatLon} */
const printToLL = (plan, xMm, yMm) => [
  globalYToLat(plan.span.r1 - yMm / plan.dy + plan.window.gy0, plan.z),
  globalXToLon(xMm / plan.dx + plan.span.c0 + plan.window.gx0, plan.z),
];

/** A hairpin whose legs sit inside the channel width, so the two grooves merge into one.
 *  @param {any} plan @param {number} [widthMm] */
function switchbackTrail(plan, widthMm = 12) {
  const gap = trenchWidthMm(widthMm) * 0.8; // inside the merge window
  const y = ((plan.gh - 1) * plan.dy) / 2;
  const w = (plan.gw - 1) * plan.dx;
  return { widthMm, heightMm: 0.6, segments: [[
    printToLL(plan, 0.15 * w, y - gap / 2), printToLL(plan, 0.85 * w, y - gap / 2),
    printToLL(plan, 0.85 * w, y + gap / 2), printToLL(plan, 0.15 * w, y + gap / 2),
  ]] };
}

/** @param {import("../src/core/types.js").Solid} s */
const zSpan = (s) => {
  let lo = Infinity, hi = -Infinity;
  for (let i = 2; i < s.positions.length; i += 3) {
    lo = Math.min(lo, s.positions[i]); hi = Math.max(hi, s.positions[i]);
  }
  return { lo, hi, span: hi - lo };
};

// The channel is meshed, not carved, so the grid the z-frame is measured from never moves. That is
// what stops the tile growing with the inset depth and the altitude bands shifting under it.
test("bakeTileSolid: the channel leaves emin and the tile's height alone", () => {
  const plan = planTile(PIPE_SETTINGS, { z: 10 });
  const trail = trailAcross(plan);
  const bare = bakeTileSolid(flatMosaicFor(plan), plan, PIPE_SETTINGS, undefined, trail);
  const cut = bakeTileSolid(flatMosaicFor(plan), plan, PIPE_SETTINGS, undefined,
    { ...trail, trenchDepthMm: 0.6 });
  assert.equal(cut.emin, bare.emin, "the channel must not move the z frame");
  assert.ok(Math.abs(zSpan(cut.solid).hi - zSpan(bare.solid).hi) < 1e-6,
    "the tile must not grow with the inset");
  assert.ok(zSpan(cut.solid).lo >= -1e-6, "the tile must never dip below the plate");
});

// The gate the whole design turns on. A non-conforming seam is invisible to checkWatertight and to
// signedVolume; it shows up here and nowhere else.
test("bakeTileSolid: the channel leaves a flat, single-loop base", () => {
  const plan = planTile(PIPE_SETTINGS, { z: 10 });
  const cut = bakeTileSolid(flatMosaicFor(plan), plan, PIPE_SETTINGS, undefined,
    { ...trailAcross(plan), trenchDepthMm: 0.6 });
  assert.equal(cut.solid.mirrored, false, "a mirrored base means a non-conforming seam");
  assert.equal(cut.solid.loops, 1);
  assert.equal(checkNoCoincidentFaces(cut.solid).duplicates, 0);
});

// The two fixtures the seam is most likely to break on. A trail over recessed water drives the
// feather ramp AND the inlay's mating surface at once; a switchback makes the channel self-merge,
// which is where the concave corner of the trench region puts two subdivided sides on one parent
// triangle.
test("bakeTileSolid: the seam holds over recessed water and through a switchback", () => {
  const plan = planTile(PIPE_SETTINGS, { z: 10 });
  const gw = plan.gw;
  const water = new Uint8Array(gw * plan.gh);
  for (let r = 0; r < plan.gh; r++)
    for (let c = (gw / 2) | 0; c < gw; c++) water[r * gw + c] = 1;
  const wet = bakeTileSolid(flatMosaicFor(plan), plan,
    { ...PIPE_SETTINGS, waterMode: "flat", recessMm: 0.4, waterInlay: true }, water,
    { ...trailAcross(plan), trenchDepthMm: 0.6 });
  assert.equal(wet.solid.mirrored, false, "water: non-conforming seam");
  assert.equal(wet.solid.loops, 1);
  assert.equal(checkNoCoincidentFaces(wet.solid).duplicates, 0);
  assert.ok(wet.inlays, "the inlay must still be produced");

  // A hairpin whose two legs sit closer than the channel is wide, so the two grooves merge.
  const zig = switchbackTrail(plan);
  const bent = bakeTileSolid(flatMosaicFor(plan), plan, PIPE_SETTINGS, undefined,
    { ...zig, trenchDepthMm: 0.6 });
  assert.equal(bent.solid.mirrored, false, "switchback: non-conforming seam");
  assert.equal(bent.solid.loops, 1);
  assert.equal(checkNoCoincidentFaces(bent.solid).duplicates, 0);
});

// The channel is refused over water so that lowering a vertex the recess placed cannot unseat the
// inlay moulded to it. That is a claim about water this bake MOVED — with the water controls at
// rest the mask marks terrain that happens to be wet, and a trail fording a river should still show
// a trail. Measured as removed volume rather than asserted on the mask, because the mask is the
// thing under test: the channel's own depth is the only evidence it reached the far bank.
test("bakeTileSolid: the channel crosses water the bake left where it was", () => {
  const plan = planTile(PIPE_SETTINGS, { z: 10 });
  const trail = trailAcross(plan);
  // A river straight across the trail, six columns wide so it survives filterUnprintableWater.
  const water = new Uint8Array(plan.gw * plan.gh);
  const c0 = ((plan.gw / 2) | 0) - 3;
  for (let r = 0; r < plan.gh; r++)
    for (let c = c0; c < c0 + 6; c++) water[r * plan.gw + c] = 1;
  /** How much volume the inset removed under one set of settings.
   * @param {any} s @param {Uint8Array} [mask] */
  const cut = (s, mask) =>
    signedVolume(bakeTileSolid(flatMosaicFor(plan), plan, s, mask, { ...trail, trenchDepthMm: 0 }).solid)
    - signedVolume(bakeTileSolid(flatMosaicFor(plan), plan, s, mask, { ...trail, trenchDepthMm: 0.6 }).solid);

  const dry = cut(PIPE_SETTINGS);
  assert.ok(dry > 0, "the fixture must cut something to compare against");
  assert.ok(Math.abs(cut(PIPE_SETTINGS, water) - dry) < 1e-6,
    "water the bake never moved must cost the channel nothing");
  // The same river once the recess owns it: now the refusal is real, and it has to bite.
  const sunk = cut({ ...PIPE_SETTINGS, waterMode: "all", recessMm: 2 }, water);
  assert.ok(sunk < dry * 0.95, `recessed water must stop the channel (cut ${sunk} vs ${dry})`);
});

// The UI floors the depth at 0.5, core does not — headless callers exist. So `movedWaterMask`
// stays spelled as the full predicate rather than reducing to `waterMode !== "none"`: a mode with
// a zero depth moves nothing, and claiming otherwise would refuse the trail channel over a river
// the bake never touched, which is exactly the bug #58 fixed.
test("bakeTileSolid: a grooving mode with a zero depth still moves nothing", () => {
  const plan = planTile(PIPE_SETTINGS, { z: 10 });
  const trail = trailAcross(plan);
  const water = new Uint8Array(plan.gw * plan.gh);
  const c0 = ((plan.gw / 2) | 0) - 3;
  for (let r = 0; r < plan.gh; r++)
    for (let c = c0; c < c0 + 6; c++) water[r * plan.gw + c] = 1;
  /** @param {any} s @param {Uint8Array} [mask] */
  const cut = (s, mask) =>
    signedVolume(bakeTileSolid(flatMosaicFor(plan), plan, s, mask, { ...trail, trenchDepthMm: 0 }).solid)
    - signedVolume(bakeTileSolid(flatMosaicFor(plan), plan, s, mask, { ...trail, trenchDepthMm: 0.6 }).solid);

  const dry = cut(PIPE_SETTINGS);
  const zeroDepth = { ...PIPE_SETTINGS, waterMode: /** @type {const} */ ("all"), recessMm: 0 };
  assert.ok(Math.abs(cut(zeroDepth, water) - dry) < 1e-6,
    "a zero depth displaces nothing, so the channel must cross the river unchanged");
});

// Crossing water the bake left alone means the channel now cuts at the tile's THINNEST ground:
// water is normally the tile's own emin, and the terrain there is exactly `base` thick. So the
// base-cut refusal becomes reachable on a fixture where recessing the same river hides it — the
// channel stops at the bank and never reaches the thin ground. Loud and remediable rather than a
// silent membrane, and a trail crossing the lowest LAND could always reach it, but it is a real
// consequence of fording rather than stopping, so it is pinned rather than left to be discovered.
test("bakeTileSolid: fording a river cuts at the tile's thinnest ground", () => {
  const settings = { ...PIPE_SETTINGS, base: 1.5 };
  const plan = planTile(settings, { z: 10 });
  const { gx0, gy0, gw, gh } = plan.window;
  // A 100 m river through a 200 m plateau, six columns wide so it survives filterUnprintableWater.
  const data = new Float32Array(gw * gh).fill(200);
  const water = new Uint8Array(gw * gh);
  const c0 = ((gw / 2) | 0) - 3;
  for (let r = 0; r < gh; r++)
    for (let c = c0; c < c0 + 6; c++) { data[r * gw + c] = 100; water[r * gw + c] = 1; }
  const mosaic = { data, width: gw, height: gh, originGx: gx0, originGy: gy0, z: plan.z };
  const trail = { ...trailAcross(plan), trenchDepthMm: settings.base + 0.5 };

  assert.throws(() => bakeTileSolid(mosaic, plan, settings, water, trail),
    /cuts through the base/, "an inset deeper than the base plate must be refused, not thinned");
  // The same river recessed: the channel stops at the bank, so the thin ground is never cut.
  const sunk = { ...settings, waterMode: /** @type {const} */ ("all"), recessMm: 2 };
  assert.ok(bakeTileSolid(mosaic, plan, sunk, water, trail).solid);
});

// What `lakes` buys the trail, and the reason the channel reads movedWaterMask rather than a
// tile-wide "is the recess on" flag: one tile holds an ocean the mode left alone and a lake it
// grooved, and the trail has to cross the first and stop at the second.
test("bakeTileSolid: under lakes the channel crosses the ocean and stops at the lake", () => {
  const plan = planTile(PIPE_SETTINGS, { z: 10 });
  const trail = trailAcross(plan);
  const { gw, gh } = plan;
  // Two bands straight across the trail, six columns each so both survive filterUnprintableWater
  // and both keep an interior for splitWaterByLine to classify from.
  const OCEAN = ((gw / 4) | 0), LAKE = (((3 * gw) / 4) | 0) - 3;
  const band = (/** @type {Uint8Array} */ m, /** @type {number} */ c0) => {
    for (let r = 0; r < gh; r++) for (let c = c0; c < c0 + 6; c++) m[r * gw + c] = 1;
    return m;
  };
  const both = band(band(new Uint8Array(gw * gh), OCEAN), LAKE);
  const lakeOnly = band(new Uint8Array(gw * gh), LAKE);
  // Land at 100 m, the ocean under the 0 m line, the lake well above it.
  const mosaic = () => {
    const m = flatMosaicFor(plan);
    for (let r = 0; r < plan.window.gh; r++) {
      for (let c = 0; c < plan.window.gw; c++) {
        const i = r * plan.window.gw + c;
        if (c >= OCEAN && c < OCEAN + 6) m.data[i] = -5;
        else if (c >= LAKE && c < LAKE + 6) m.data[i] = 50;
      }
    }
    return m;
  };
  /** @param {any} s @param {Uint8Array} mask */
  const cut = (s, mask) =>
    signedVolume(bakeTileSolid(mosaic(), plan, s, mask, { ...trail, trenchDepthMm: 0 }).solid)
    - signedVolume(bakeTileSolid(mosaic(), plan, s, mask, { ...trail, trenchDepthMm: 0.6 }).solid);

  const lakes = { ...PIPE_SETTINGS, waterMode: "lakes", recessMm: 2 };
  const all = { ...PIPE_SETTINGS, waterMode: "all", recessMm: 2 };
  // Grooving both bands costs the channel strictly more than grooving one.
  assert.ok(cut(lakes, both) > cut(all, both) + 1e-6,
    "the ocean lakes left alone must not stop the channel");
  // And the cost is exactly the lake's: the same tile with the ocean out of the mask entirely
  // recesses the same vertices, so the channel it carries has to be the same channel.
  assert.ok(Math.abs(cut(lakes, both) - cut(all, lakeOnly)) < 1e-6,
    "only the grooved body may cost the channel anything");
});

test("bakeTileSolid: an inset deeper than the base plate is refused, not clamped", () => {
  const plan = planTile(PIPE_SETTINGS, { z: 10 });
  assert.throws(() => bakeTileSolid(flatMosaicFor(plan), plan, PIPE_SETTINGS, undefined,
    { ...trailAcross(plan), trenchDepthMm: PIPE_SETTINGS.base + 1 }),
  /^Error: corridor: /, "a silently shallower channel is a fit failure found in the slicer");
});

// Migrated from the carve's own drop guard, which validated on PRESENCE rather than truthiness:
// a headless caller passing exag 0 gets NaN, and NaN is falsy, so a truthiness test would wave it
// through as "no inset" and silently bake a tile with no channel. Absent and 0 both mean off.
test("bakeTileSolid: a non-finite or non-positive inset depth is refused", () => {
  const plan = planTile(PIPE_SETTINGS, { z: 10 });
  const trail = trailAcross(plan);
  for (const bad of [Infinity, NaN, -1]) {
    assert.throws(() => bakeTileSolid(flatMosaicFor(plan), plan, PIPE_SETTINGS, undefined,
      { ...trail, trenchDepthMm: bad }), /^Error: corridor: /, `depth ${bad} must be refused`);
  }
  for (const off of /** @type {(number | undefined)[]} */ ([0, undefined])) {
    const baked = bakeTileSolid(flatMosaicFor(plan), plan, PIPE_SETTINGS, undefined,
      { ...trail, trenchDepthMm: off });
    assert.ok(baked.solid, `depth ${off} means no inset, not an error`);
  }
});

// Migrated from the carve's coarse-pitch refusal, which has no analogue: the channel's width no
// longer depends on the pitch, so the only thing left that can refuse a trail is subK's own width
// guard -- and it still reaches the caller through bakeTileSolid under the `corridor: ` prefix the
// worker's cord rescue matches on.
test("bakeTileSolid: a cord the lattice cannot carry is refused through the bake", () => {
  const plan = planTile(PIPE_SETTINGS, { z: 10 });
  // Long enough that the triangle budget clamps k below what a 0.4 mm cord needs at a 2.5 mm
  // pitch: a zigzag that stays entirely on the tile, so cordLattice counts all of it.
  const w = (plan.gw - 1) * plan.dx, h = (plan.gh - 1) * plan.dy;
  const legs = 600;
  /** @type {import("../src/core/types.js").LatLon[]} */
  const pts = [];
  for (let i = 0; i <= legs; i++) {
    pts.push(printToLL(plan, i % 2 ? 0.95 * w : 0.05 * w, (h * i) / legs));
  }
  assert.throws(() => bakeTileSolid(flatMosaicFor(plan), plan, PIPE_SETTINGS, undefined,
    { segments: [pts], widthMm: 0.4, heightMm: 0.6, trenchDepthMm: 0.6 }),
  /^Error: corridor: /);
});

test("bakeTileSolid: the cord bottoms out on the trench floor", () => {
  const plan = planTile(PIPE_SETTINGS, { z: 10 });
  // Held clear of the rim, by the cord's own half-width plus the ring trenchAdmissibleCells erodes:
  // out there feather is 0 and the cord correctly rides the terrain instead of a floor, which is a
  // real 0.6 mm of relief in the cord and would swamp the congruence this measures.
  const trail = trailAcross(plan, 12, 6);
  const bare = bakeTileSolid(flatMosaicFor(plan), plan, PIPE_SETTINGS, undefined, trail);
  const cut = bakeTileSolid(flatMosaicFor(plan), plan, PIPE_SETTINGS, undefined,
    { ...trail, trenchDepthMm: 0.6 });
  assert.ok(bare.ribbon && cut.ribbon);
  // Congruence shows as identical z EXTENT, not identical z: the inset lowers every underside
  // vertex of the cut cord by the same full depth, which a span cannot see. A cord riding the
  // channel's ramp instead of its floor would pick up that relief and read taller.
  assert.ok(Math.abs(zSpan(bare.ribbon).span - zSpan(cut.ribbon).span) < 1e-4,
    `cord span ${zSpan(cut.ribbon).span}, want ${zSpan(bare.ribbon).span}`);
});

// The claim the whole feature rests on, measured directly rather than through a proxy: both
// parts share the tile's z frame, so the cord's underside and the surrounding surface are
// directly comparable. Flat terrain, so any difference IS the channel.
// Boundary cells are meshed by clippedTopTris from their clipped polygon, not the two-triangle
// split the channel sub-divides -- so a rim is where the two constructions have to meet. A trail
// running off a hex or circle rim is the only thing that drives both at once.
for (const shape of /** @type {const} */ (["hex", "circle"])) {
  test(`bakeTileSolid: a trail crossing a ${shape} rim still closes watertight`, () => {
    const settings = { ...PIPE_SETTINGS, shape };
    const plan = planTile(settings, { z: 10 });
    const trail = trailAcross(plan); // spans the full window, so it exits the footprint
    const cut = bakeTileSolid(flatMosaicFor(plan), plan, settings, undefined,
      { ...trail, trenchDepthMm: 0.6 });
    const wt = checkWatertight(cut.solid);
    assert.ok(wt.closed, `${shape}: ${wt.unmatched} unmatched edges`);
    assert.ok(signedVolume(cut.solid) > 0, `${shape}: inside-out solid`);
    // The gates checkWatertight cannot see: a rim cell meshed against a sub-meshed neighbour
    // leaves every directed edge paired and still fails here.
    assert.equal(cut.solid.mirrored, false, `${shape}: non-conforming seam`);
    assert.equal(cut.solid.loops, 1, `${shape}: ${cut.solid.loops} boundary loops`);
    // The channel stops one cell further in than the cord (trenchAdmissibleCells erodes one ring
    // past admissibleCells), so the cord's last stretch sits ON the surface rather than in a
    // groove -- feather is 0 there, so the two surfaces still coincide. Intended, and pinned.
    assert.ok(cut.ribbon, `${shape}: expected a cord`);
    const rwt = checkWatertight(cut.ribbon);
    assert.ok(rwt.closed, `${shape}: cord has ${rwt.unmatched} unmatched edges`);
  });
}

test("bakeTileSolid: the seated cord sits one full depth below the surrounding surface", () => {
  const plan = planTile(PIPE_SETTINGS, { z: 10 });
  const trail = trailAcross(plan);
  const cut = bakeTileSolid(flatMosaicFor(plan), plan, PIPE_SETTINGS, undefined,
    { ...trail, trenchDepthMm: 0.6 });
  assert.ok(cut.ribbon);
  const sunk = zSpan(cut.solid).hi - zSpan(cut.ribbon).lo;
  assert.ok(Math.abs(sunk - 0.6) < 1e-4, `cord sits ${sunk} mm below the surface, want 0.6`);
});

// The old carve refused a tier whose pitch could not hold the export's channel width, so FAST
// showed no groove at all. Nothing is skipped now: the width no longer depends on pitch, so every
// tier meshes the same channel -- measured on the emitted floor, not on the width function, which
// is a constant expression and would pin nothing.
//
// Tiers as explicit zooms rather than maxTiles budgets: an explicit z overrides the budget, so
// three budgets at one z would bake the same plan three times, and this fixture's real budgets
// pick z13-z15, whose 321^2 to 1281^2 grids cost seconds a bake for no extra coverage.
test("bakeTileSolid: every preview tier meshes the same channel", () => {
  const tiers = [10, 11, 12];
  const pitches = tiers.map((z) => planTile(PIPE_SETTINGS, { z }).dx);
  assert.equal(new Set(pitches).size, tiers.length, `tiers must differ: ${pitches}`);
  const floors = tiers.map((z) => {
    const plan = planTile(PIPE_SETTINGS, { z });
    const cut = bakeTileSolid(flatMosaicFor(plan), plan, PIPE_SETTINGS, undefined,
      { ...trailAcross(plan), trenchDepthMm: 0.6 });
    assert.equal(cut.solid.mirrored, false, `z${z}: non-conforming seam`);
    assert.equal(cut.solid.loops, 1);
    // The channel's own floor: the deepest top-surface vertex under the flat terrain around it.
    // zSpan alone measures the TILE's height, which is the same with no channel meshed at all.
    let lo = Infinity, hi = -Infinity;
    for (let i = 2; i < cut.solid.positions.length; i += 3) {
      const zi = cut.solid.positions[i];
      if (zi <= 1e-6) continue; // the base plane
      lo = Math.min(lo, zi); hi = Math.max(hi, zi);
    }
    return hi - lo;
  });
  assert.ok(floors[0] > 1e-6, "no channel was meshed at all");
  for (const f of floors) assert.ok(Math.abs(f - floors[0]) < 1e-6, `tiers differ: ${floors}`);
});

test("bakeTileSolid: no trail -> ribbon is null", () => {
  const plan = planTile(PIPE_SETTINGS, { z: 10 });
  const { ribbon } = bakeTileSolid(flatMosaicFor(plan), plan, PIPE_SETTINGS);
  assert.equal(ribbon, null);
});

// The width the old cell-snapped corridor refused outright. plan.dx here is 2.5 mm, so 0.4 mm
// is a sixth of a grid cell — the case that motivated the sub-lattice.
test("bakeTileSolid: a cord far narrower than the grid pitch bakes, and is 0.4 mm wide", () => {
  const plan = planTile(PIPE_SETTINGS, { z: 10 });
  const { window: win, z } = plan;
  const lat = globalYToLat(win.gy0 + 20, z);
  /** @type {import("../src/core/types.js").LatLon[][]} */
  const segments = [[[lat, globalXToLon(win.gx0 + 8, z)], [lat, globalXToLon(win.gx0 + 32, z)]]];
  const { ribbon } = bakeTileSolid(flatMosaicFor(plan), plan, PIPE_SETTINGS, undefined,
    { segments, widthMm: 0.4, heightMm: 1 });
  assert.ok(ribbon, `0.4 mm must bake on a ${plan.dx} mm grid`);
  assert.ok(checkWatertight(ribbon).closed);
  assert.ok(signedVolume(ribbon) > 0);
  let lo = Infinity, hi = -Infinity;
  for (let i = 1; i < ribbon.positions.length; i += 3) {
    lo = Math.min(lo, ribbon.positions[i]); hi = Math.max(hi, ribbon.positions[i]);
  }
  // Exact but for float32: an axis-aligned cord's edges land on the isoline exactly, and what
  // is left is the precision of Solid.positions at these tile coordinates.
  assert.ok(Math.abs(hi - lo - 0.4) < 1e-4, `cord spans ${(hi - lo).toFixed(6)} mm across, want 0.4`);
});

// checkWatertight can't see this: it only reads `indices`, never z, so a mirrored ribbon with
// zero or negative height is still topologically closed. Nor can signedVolume any more — in the
// tile's frame a zero-height cord's faces cancel to 1e-13, not to 0 — so the guard is on the
// input, and this is the test that would have caught the volume gate going quiet.
test("bakeTileSolid: a non-positive cord height is rejected, not silently exported degenerate", () => {
  const plan = planTile(PIPE_SETTINGS, { z: 10 });
  const { window: win, z } = plan;
  const row = 20, lat = globalYToLat(win.gy0 + row, z);
  /** @type {import("../src/core/types.js").LatLon[][]} */
  const segments = [[[lat, globalXToLon(win.gx0 + 10, z)], [lat, globalXToLon(win.gx0 + 30, z)]]];
  for (const heightMm of [0, -1]) {
    assert.throws(
      () => bakeTileSolid(flatMosaicFor(plan), plan, PIPE_SETTINGS, undefined, { segments, widthMm: 12, heightMm }),
      /trail height must be a positive distance/,
      `heightMm=${heightMm} must throw`);
  }
});

test("bakeTileSolid: with a wide-enough trail, ribbon is a validated watertight solid", () => {
  const plan = planTile(PIPE_SETTINGS, { z: 10 });
  const { window: win, z } = plan;
  const row = 20, lat = globalYToLat(win.gy0 + row, z);
  /** @type {import("../src/core/types.js").LatLon[][]} */
  const segments = [[[lat, globalXToLon(win.gx0 + 10, z)], [lat, globalXToLon(win.gx0 + 30, z)]]];
  const { ribbon } = bakeTileSolid(flatMosaicFor(plan), plan, PIPE_SETTINGS, undefined,
    { segments, widthMm: 12, heightMm: 1.5 });
  assert.ok(ribbon);
  assert.ok(checkWatertight(ribbon).closed);
  assert.ok(signedVolume(ribbon) > 0);
});

// The wiring the preview rides on, at the level where it was missing — and the export rides the
// same one now. Flat terrain, so the underside is exactly the base plate and nothing else.
test("bakeTileSolid: the cord lands in the tile's own z frame", () => {
  const plan = planTile(PIPE_SETTINGS, { z: 10 });
  const { window: win, z } = plan;
  const lat = globalYToLat(win.gy0 + 20, z);
  /** @type {import("../src/core/types.js").LatLon[][]} */
  const segments = [[[lat, globalXToLon(win.gx0 + 10, z)], [lat, globalXToLon(win.gx0 + 30, z)]]];
  const trail = { segments, widthMm: 12, heightMm: 1.5 };
  /** @param {import("../src/core/types.js").Solid} s */
  const lowest = (s) => {
    let m = Infinity;
    for (let i = 2; i < s.positions.length; i += 3) m = Math.min(m, s.positions[i]);
    return m;
  };
  const rib = bakeTileSolid(flatMosaicFor(plan), plan, PIPE_SETTINGS, undefined, trail).ribbon;
  assert.ok(rib);
  assert.ok(Math.abs(lowest(rib) - PIPE_SETTINGS.base) < 1e-5,
    `cord at ${lowest(rib)}, want the ${PIPE_SETTINGS.base} mm base`);
});

// The load-bearing ordering test: applyWaterRecess mutates the grid, and bakeTileSolid must
// build the ribbon from that mutated grid — not a copy captured earlier, not the raw DEM.
//
// Flat 200 m terrain everywhere except a masked "water" band (cols 15..25), sunk by recessMm.
// Built correctly, the sunk band is the tile's own emin, so water columns rest at exactly `base`
// and land columns `recessMm` above them — the recess is visible in the cord. Built from the
// pre-recess grid (or a snapshot taken before the mutation), every column reads the same flat
// 200 m and lands at `base` alike: verified by swapping in a raw grid at this call site and
// rerunning — every column collapsed to base, land and water together.
test("ribbon is molded to the surface AFTER water recess, with the tile's own emin", () => {
  const settings = { ...PIPE_SETTINGS, waterMode: /** @type {const} */ ("all"), recessMm: 20 };
  const plan = planTile(settings, { z: 10 });
  const { window: win, gw, gh, dx, z } = plan;
  const mosaic = { data: new Float32Array(gw * gh).fill(200), width: gw, height: gh,
    originGx: win.gx0, originGy: win.gy0, z };
  const waterMask = new Uint8Array(gw * gh);
  for (let r = 0; r < gh; r++) for (let c = 15; c <= 25; c++) waterMask[r * gw + c] = 1;

  const row = 20, lat = globalYToLat(win.gy0 + row, z);
  /** @type {import("../src/core/types.js").LatLon[][]} */
  const segments = [[[lat, globalXToLon(win.gx0 + 5, z)], [lat, globalXToLon(win.gx0 + 35, z)]]];
  const { ribbon } = bakeTileSolid(mosaic, plan, settings, waterMask,
    { segments, widthMm: 12, heightMm: 1.5 });
  assert.ok(ribbon, "corridor covers cells");

  // column (grid c) -> molded underside z, the lowest vertex per (x,y) column
  const underside = new Map();
  for (let i = 0; i < ribbon.positions.length / 3; i++) {
    const x = ribbon.positions[3 * i], zz = ribbon.positions[3 * i + 2];
    const c = Math.round(x / dx);
    underside.set(c, Math.min(underside.get(c) ?? Infinity, zz));
  }
  let sawWater = 0, sawLand = 0;
  for (const [c, lo] of underside) {
    const want = c >= 16 && c <= 24 ? settings.base : settings.base + settings.recessMm;
    if (c >= 16 && c <= 24) { assert.ok(Math.abs(lo - want) < 1e-3, `water col ${c} underside ${lo}, want ${want}`); sawWater++; }
    if (c <= 12 || c >= 28) { assert.ok(Math.abs(lo - want) < 1e-3, `land col ${c} underside ${lo}, want ${want}`); sawLand++; }
  }
  assert.ok(sawWater > 3 && sawLand > 3, `corridor must reach both regions (water ${sawWater}, land ${sawLand})`);
});

/** Pull the model XML out of a 3MF blob without a zip library.
 *  inflateRawSync, not inflateSync: threemf.js writes CompressionStream("deflate-raw"), which
 *  has no zlib header for inflateSync to find. Falls back to raw bytes when CompressionStream
 *  is unavailable (threemf.js's method-0 store path).
 *
 *  buf.indexOf(name) alone is not reliable: _rels/.rels embeds this same name inside its own
 *  Target="/3D/3dmodel.model" text, and that occurrence sits BEFORE the real local file header
 *  in the byte stream, so a naive first-hit search finds rels XML, not the header, and reads 30
 *  bytes of unrelated text as a fixed-size zip header. Confirmed against actual writer output.
 *  Guard against it by requiring the PK\x03\x04 local-file-header signature 30 bytes back.
 * @param {Uint8Array} bytes
 */
function modelXml(bytes) {
  const buf = Buffer.from(bytes);
  const name = Buffer.from("3D/3dmodel.model");
  let at = -1;
  for (let i = buf.indexOf(name); i !== -1; i = buf.indexOf(name, i + 1)) {
    if (i >= 30 && buf.readUInt32LE(i - 30) === 0x04034b50) { at = i; break; }
  }
  assert.ok(at >= 0, "model part's local file header not found");
  const hdr = at - 30;
  const method = buf.readUInt16LE(hdr + 8);
  const comp = buf.readUInt32LE(hdr + 18), extra = buf.readUInt16LE(hdr + 28);
  const raw = buf.subarray(at + name.length + extra, at + name.length + extra + comp);
  const xml = (method === 8 ? inflateRawSync(raw) : raw).toString("utf8");
  assert.match(xml, /<model unit="millimeter"/, "extraction produced model XML");
  return xml;
}

// The preview drops the CORD when the cord is what cannot be drawn. It must not drop it -- and
// mislabel the cause -- when the refusal is about the tile. Both throws carry the `corridor: `
// prefix, so the flag is what separates them; matching the message cannot.
test("bakeTileSolid: only cord-owned refusals are flagged droppable", () => {
  const plan = planTile(PIPE_SETTINGS, { z: 10 });
  // A base-cut refusal: the tile's problem, so the preview must surface it, not swallow it.
  let deep = null;
  try {
    bakeTileSolid(flatMosaicFor(plan), plan, PIPE_SETTINGS, undefined,
      { ...trailAcross(plan), trenchDepthMm: PIPE_SETTINGS.base + 1 });
  } catch (err) { deep = err; }
  assert.ok(deep instanceof Error, "a too-deep inset must throw");
  assert.match(deep.message, /^corridor: /);
  assert.notEqual(/** @type {any} */ (deep).dropCord, true,
    "a base-cut refusal must reach the banner, not drop the trail");

  // subK's refusal: the cord's problem, so a coarse preview tier drops it and keeps the terrain.
  // trailLenMm bumped from the brief's 4000 to 60000: at 4000 the triangle budget's kMax (141 at
  // this pitch) still clears 2*pitch/widthMm, so the width guard never fires. 60000 pushes kMax
  // below that threshold -- the assertion is about the flag, not this particular length.
  let fine = null;
  try {
    subK(0.4, 8, 8, 60000);
  } catch (err) { fine = err; }
  assert.ok(fine instanceof Error, "subK must refuse a cord it cannot lattice");
  assert.equal(/** @type {any} */ (fine).dropCord, true,
    "subK's refusal is the cord's own and must stay droppable");
});

test("tileTo3mf writes the ribbon in the tile's own frame, untranslated", async () => {
  const tile = buildSolid(grid, GW, GH, SPAN, new Uint8Array((GW - 1) * (GH - 1)).fill(1), GEOM);
  const rib = cord(BAND);
  assert.ok(rib);
  const xml = modelXml(await tileTo3mf("t", tile, undefined, rib));
  assert.equal((xml.match(/<object /g) ?? []).length, 2);
  const items = [...xml.matchAll(/<item objectid="(\d+)" transform="([^"]+)"/g)];
  assert.equal(items.length, 2);
  const [tx, ty] = items[1][2].trim().split(/\s+/).slice(9, 11).map(Number);
  assert.equal(tx, 0); assert.equal(ty, 0);
  // Not just an identity transform — the mesh it identity-places has to be INSIDE the tile, which
  // is what a plated part would fail. The cord's trail runs rows 28..32, so its y sits well
  // within the tile's own extent and its underside within the tile's z.
  let hiY = -Infinity, hiZ = -Infinity;
  for (let i = 1; i < tile.positions.length; i += 3) hiY = Math.max(hiY, tile.positions[i]);
  for (let i = 2; i < tile.positions.length; i += 3) hiZ = Math.max(hiZ, tile.positions[i]);
  let ribHiY = -Infinity, ribLoZ = Infinity;
  for (let i = 1; i < rib.positions.length; i += 3) ribHiY = Math.max(ribHiY, rib.positions[i]);
  for (let i = 2; i < rib.positions.length; i += 3) ribLoZ = Math.min(ribLoZ, rib.positions[i]);
  assert.ok(ribHiY < hiY, `ribbon reaches y=${ribHiY}, outside a tile ending at ${hiY}`);
  assert.ok(ribLoZ > GEOM.base && ribLoZ < hiZ, `ribbon underside at ${ribLoZ}, outside the tile's relief`);
});
