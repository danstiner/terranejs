// The water inlays exist to drop back into the hollow the water controls left, so what is
// asserted here is the pair of surfaces that makes that true: an underside congruent with the
// printed water, and a top on the water's ORIGINAL elevation — not on the tile's waterline,
// which flatten invents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { buildSolid, buildDrape, cellsFromVertexMask } from "../src/core/mesh.js";
import { cordSolid, admissibleCells } from "../src/core/cord.js";
import { checkWatertight, signedVolume } from "../src/core/validate.js";
import { planTile, bakeTileSolid, tileTo3mf } from "../src/core/pipeline.js";

const GW = 40, GH = 40;
const SPAN = { r0: 0, r1: GH - 1, c0: 0, c1: GW - 1 };
const GEOM = { dx: 0.5, dy: 0.5, mmPerM: 0.04, emin: 0, exag: 1, base: 3 };

/** z extremes per (x,y) column — the only way to compare vertices across two meshes, whose
 *  internal ids are unrelated. Same helper as ribbon.test.mjs, kept local so neither test file
 *  can silently reshape the other's ground truth.
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

// --- buildDrape with an upper-surface grid --------------------------------

test("an upper-surface grid drives thickness per vertex, not one constant", () => {
  // Sloping bottom, and a top whose gap from it varies across the part — the case a scalar
  // thickness cannot express, and the one the water inlays actually need.
  const bot = new Float32Array(GW * GH);
  const top = new Float32Array(GW * GH);
  for (let r = 0; r < GH; r++) {
    for (let c = 0; c < GW; c++) {
      bot[r * GW + c] = 100 + 2 * c;
      top[r * GW + c] = bot[r * GW + c] + 10 + c; // gap grows 1 m per column
    }
  }
  const cw = GW - 1, mask = new Uint8Array(cw * (GH - 1));
  for (let r = 10; r <= 20; r++) for (let c = 5; c <= 25; c++) mask[r * cw + c] = 1;

  const part = buildDrape(bot, GW, GH, SPAN, mask, GEOM, top);
  assert.ok(part);
  assert.ok(checkWatertight(part).closed);
  assert.ok(signedVolume(part) > 0);

  // Thickness at column c must be (10 + c) metres of elevation, scaled — and it must actually
  // VARY, or a scalar-thickness implementation would pass this too.
  const seen = new Set();
  for (const [k, { lo, hi }] of columns(part.positions)) {
    const c = Math.round(Number(k.split(",")[0]) / GEOM.dx);
    const want = (10 + c) * GEOM.mmPerM * GEOM.exag;
    assert.ok(Math.abs(hi - lo - want) < 1e-6, `column ${k}: thickness ${hi - lo}, expected ${want}`);
    seen.add(Math.round((hi - lo) * 1e6));
  }
  assert.ok(seen.size > 10, `thickness took only ${seen.size} distinct values — not varying`);
});

// The bug this exists to prevent is silent: a shell floating in mid-air is still closed and
// still positive-volume, so checkWatertight, signedVolume and the 3MF writer all accept it.
// Only its z tells you it can never print.
test("each disconnected piece rests on the plate, not just the lowest one", () => {
  const bot = new Float32Array(GW * GH).fill(100);
  const top = new Float32Array(GW * GH);
  const cw = GW - 1, mask = new Uint8Array(cw * (GH - 1));
  // Two regions 400 m apart in elevation, far enough not to touch even diagonally.
  for (let r = 4; r <= 8; r++) for (let c = 4; c <= 10; c++) mask[r * cw + c] = 1;
  for (let r = 25; r <= 30; r++) for (let c = 20; c <= 30; c++) mask[r * cw + c] = 1;
  for (let r = 24; r <= 31; r++) for (let c = 19; c <= 31; c++) bot[r * GW + c] = 500;
  for (let i = 0; i < bot.length; i++) top[i] = bot[i] + 50;

  const part = buildDrape(bot, GW, GH, SPAN, mask, GEOM, top);
  assert.ok(part);
  // Group columns by which region they fall in, and check each one's own minimum.
  let loA = Infinity, loB = Infinity;
  for (const [k, { lo }] of columns(part.positions)) {
    const c = Math.round(Number(k.split(",")[0]) / GEOM.dx);
    if (c <= 11) loA = Math.min(loA, lo); else loB = Math.min(loB, lo);
  }
  assert.ok(Math.abs(loA) < 1e-9, `low region rests at ${loA}, expected 0`);
  // A single shared floor would leave this one (500-100)*mmPerM*exag = 16 mm in the air.
  assert.ok(Math.abs(loB) < 1e-9, `high region rests at ${loB}, expected 0 — shared floor?`);
});

test("pieces touching only at a corner share one floor, rather than splitting a vertex", () => {
  // 8-connectivity is what makes a per-vertex label well defined: these two cells share exactly
  // one vertex, and under 4-connectivity they would be separate pieces demanding two different
  // z values for it. Whichever won, the mesh would tear at that vertex.
  const bot = new Float32Array(GW * GH).fill(100);
  const top = new Float32Array(GW * GH);
  const cw = GW - 1, mask = new Uint8Array(cw * (GH - 1));
  mask[10 * cw + 10] = 1;
  mask[11 * cw + 11] = 1;
  for (let r = 11; r <= 13; r++) for (let c = 11; c <= 13; c++) bot[r * GW + c] = 300;
  for (let i = 0; i < bot.length; i++) top[i] = bot[i] + 50;

  const part = buildDrape(bot, GW, GH, SPAN, mask, GEOM, top);
  assert.ok(part);
  assert.ok(checkWatertight(part).closed, "a torn shared vertex would leave unmatched edges");
  assert.ok(signedVolume(part) > 0);
});

test("cellsFromVertexMask claims a cell only with all four corners, in both masks", () => {
  const vert = new Uint8Array(GW * GH);
  for (let r = 5; r <= 9; r++) for (let c = 5; c <= 9; c++) vert[r * GW + c] = 1;
  // 5x5 vertices -> 4x4 cells.
  assert.equal(cellsFromVertexMask(vert, GW, GH).count, 16);
  // A footprint clipping one vertex column removes the whole column of cells that touch it.
  const also = new Uint8Array(GW * GH).fill(1);
  for (let r = 0; r < GH; r++) also[r * GW + 9] = 0;
  assert.equal(cellsFromVertexMask(vert, GW, GH, also).count, 12);
});

// --- the water path, end to end -------------------------------------------

// Equator + prime meridian → integer global-pixel origin, so plan.dx is exact rather than
// lat-dependent. Matches ribbon.test.mjs / pipeline.test.mjs.
const BASE = { center: /** @type {[number, number]} */ ([0, 0]), scale: 61150, tileWidthMm: 100, base: 5, exag: 2 };
const SEA = 100, LAKE = 500, LAND = 900;

/**
 * A tile split into three: sea in the west, land, then a lake in the east. Two water bodies at
 * very different elevations is the case that separates a per-piece floor from a shared one, and
 * "top = original surface" from "top = the tile's waterline".
 * @param {ReturnType<typeof planTile>} plan
 */
function seaLakeTile(plan) {
  const { gx0, gy0, gw, gh } = plan.window;
  const data = new Float32Array(gw * gh);
  const mask = new Uint8Array(gw * gh);
  const w = Math.floor(gw / 4), e = gw - w;
  for (let r = 0; r < gh; r++) {
    for (let c = 0; c < gw; c++) {
      const i = r * gw + c;
      const water = c < w || c >= e;
      // One land column sunk well below SEA − 2 lifts: without it landMin − 2·lift stays above
      // SEA and flatten's plane collapses to exactly SEA (min(waterMin, landMin−2·lift) =
      // waterMin), so the sea half never moves under EITHER the correct code or the bug it
      // guards against, and only the lake half would catch a regression.
      data[i] = water ? (c < w ? SEA : LAKE) : (c === w ? SEA - 50 : LAND);
      mask[i] = water ? 1 : 0;
    }
  }
  return { mosaic: { data, width: gw, height: gh, originGx: gx0, originGy: gy0, z: plan.z }, mask };
}

/** @param {Partial<{waterMode: "none"|"flat"|"all", recessMm: number, waterInlay: boolean}>} [o] */
const opts = (o = {}) => ({ ...BASE, waterMode: /** @type {const} */ ("all"), recessMm: 0, layerMm: 0.15, waterInlay: true, ...o });

test("the inlay's top is the water's ORIGINAL elevation, not the tile's waterline", () => {
  const plan = planTile(BASE, { z: 10 });
  const { mosaic, mask } = seaLakeTile(plan);
  // Flatten pulls both bodies onto one plane anchored below the sunk land column; the recess
  // never applies here, flat and the sink being exclusive by construction (applyWaterRecess). If
  // the top followed that plane, every piece would be flush; the original surface makes each
  // piece carry exactly its own body's drop instead.
  const s = opts({ waterMode: "flat" });
  const { inlays } = bakeTileSolid(mosaic, plan, s, mask);
  assert.ok(inlays);
  const K = plan.mmPerM * s.exag;
  // Ground truth computed independently of applyWaterRecess, same style as the offset test
  // below: the sunk land column (SEA − 50) pulls the anchor below SEA, so the sea half now has
  // to move too and both halves discriminate top-follows-original from top-follows-plane.
  const lift = s.layerMm / K;
  const anchor = Math.min(SEA, SEA - 50 - 2 * lift);
  const seaThick = (SEA - anchor) * K;
  const lakeThick = (LAKE - anchor) * K;
  assert.ok(lakeThick > seaThick + 1, "fixture must separate the two thicknesses");
  assert.ok(seaThick > 1, "fixture must make the sea half discriminate too");

  let sawSea = 0, sawLake = 0;
  const midX = (plan.gw - 1) * plan.dx / 2;
  for (const [k, { lo, hi }] of columns(inlays.positions)) {
    const x = Number(k.split(",")[0]);
    const want = x < midX ? seaThick : lakeThick;
    assert.ok(Math.abs(hi - lo - want) < 1e-4, `column ${k}: thickness ${hi - lo}, expected ${want}`);
    if (x < midX) sawSea++; else sawLake++;
  }
  assert.ok(sawSea > 20 && sawLake > 20, `covered ${sawSea} sea and ${sawLake} lake columns`);
});

test("the inlay's underside is the printed water surface, offset by one constant per piece", () => {
  const plan = planTile(BASE, { z: 10 });
  const { mosaic, mask } = seaLakeTile(plan);
  const s = opts({ recessMm: 3 });
  const { solid, inlays } = bakeTileSolid(mosaic, plan, s, mask);
  assert.ok(inlays);
  const tile = columns(solid.positions);   // hi = printed surface, lo = the z=0 base plane
  const part = columns(inlays.positions);

  // Ground truth computed independently of buildDrape: with flatten off, each piece's own
  // minimum relief is its (raw water − recess), and emin is the tile's lowest printed point —
  // the recessed sea. Pinning the VALUE, not merely "some constant", is what catches a part
  // built against the tile's emin or against the pre-recess grid; both would still be
  // column-constant. See the same argument in ribbon.test.mjs.
  const K = plan.mmPerM * s.exag;
  const emin = SEA - s.recessMm / K;                            // the recessed sea floor, in metres
  const midX = (plan.gw - 1) * plan.dx / 2;
  const expect = (/** @type {number} */ x) =>
    s.base + ((x < midX ? SEA : LAKE) - s.recessMm / K - emin) * K;

  let checked = 0;
  for (const [k, p] of part) {
    const t = tile.get(k);
    if (!t) continue;
    const d = t.hi - p.lo;
    assert.ok(Math.abs(d - expect(Number(k.split(",")[0]))) < 1e-4,
      `column ${k}: offset ${d}, expected ${expect(Number(k.split(",")[0]))}`);
    checked++;
  }
  assert.ok(checked > 100, `only ${checked} columns compared`);
});

test("each water body's inlay rests on the plate, through the pipeline", () => {
  const plan = planTile(BASE, { z: 10 });
  const { mosaic, mask } = seaLakeTile(plan);
  // Flatten OFF, so the two pieces' undersides stay 400 m apart — a shared floor would leave
  // the lake's inlay (LAKE-SEA)*K = 13.1 mm above the bed.
  const { inlays } = bakeTileSolid(mosaic, plan, opts({ recessMm: 2 }), mask);
  assert.ok(inlays);
  const midX = (plan.gw - 1) * plan.dx / 2;
  let loSea = Infinity, loLake = Infinity;
  for (const [k, { lo }] of columns(inlays.positions)) {
    if (Number(k.split(",")[0]) < midX) loSea = Math.min(loSea, lo); else loLake = Math.min(loLake, lo);
  }
  assert.ok(Math.abs(loSea) < 1e-6, `sea inlay rests at ${loSea}`);
  assert.ok(Math.abs(loLake) < 1e-6, `lake inlay rests at ${loLake}`);
});

test("the shoreline keeps a printable wall: no column tapers to a knife edge", () => {
  const plan = planTile(BASE, { z: 10 });
  const { mosaic, mask } = seaLakeTile(plan);
  const s = opts({ recessMm: 2 });
  const { inlays } = bakeTileSolid(mosaic, plan, s, mask);
  assert.ok(inlays);
  // Every cell the inlay claims has four water corners, so its thickness is the full recess
  // everywhere including the edge. Claiming the shore's ramp cells instead would fill the
  // hollow exactly but taper to 0 at each land corner — unprintable, and no clearance to seat.
  let thinnest = Infinity;
  for (const { lo, hi } of columns(inlays.positions).values()) thinnest = Math.min(thinnest, hi - lo);
  assert.ok(Math.abs(thinnest - s.recessMm) < 1e-4, `thinnest column ${thinnest}, expected ${s.recessMm}`);
});

test("nothing displaced, nothing exported", () => {
  const plan = planTile(BASE, { z: 10 });
  const { mosaic, mask } = seaLakeTile(plan);
  // The mode at rest: the grid is untouched, so there is no hollow and no volume to fill.
  assert.equal(bakeTileSolid(mosaic, plan, opts({ waterMode: "none" }), mask).inlays, null);
  // A grooving mode at zero depth — legal below the UI's floor — also moves nothing.
  assert.equal(bakeTileSolid(mosaic, plan, opts(), mask).inlays, null);
  // Asked for but with no water mask at all — the headless path.
  assert.equal(bakeTileSolid(mosaic, plan, opts({ recessMm: 3 })).inlays, null);
  // Not asked for.
  assert.equal(bakeTileSolid(mosaic, plan, opts({ recessMm: 3, waterInlay: false }), mask).inlays, null);
});

test("a flatten that moves nothing yields no inlay, rather than a degenerate one", () => {
  const plan = planTile(BASE, { z: 10 });
  const { gx0, gy0, gw, gh } = plan.window;
  // One water body, already the lowest thing in the tile: flatten's plane is min(lowest water,
  // lowest land − 2 layers), so it lands ON the water and moves it 0. Top meets bottom at every
  // vertex — an empty part, not an inverted one, and the pipeline must drop it rather than
  // throw the way it does for a bad cord height.
  const data = new Float32Array(gw * gh);
  const mask = new Uint8Array(gw * gh);
  for (let r = 0; r < gh; r++) {
    for (let c = 0; c < gw; c++) {
      const water = c < gw / 3;
      data[r * gw + c] = water ? SEA : LAND;
      mask[r * gw + c] = water ? 1 : 0;
    }
  }
  const mosaic = { data, width: gw, height: gh, originGx: gx0, originGy: gy0, z: plan.z };
  const { inlays } = bakeTileSolid(mosaic, plan, opts({ waterMode: "flat", recessMm: 0 }), mask);
  assert.equal(inlays, null);
});

/** The model part out of the .3mf zip. Same extraction as ribbon.test.mjs, including its guard:
 *  "3D/3dmodel.model" also appears in the _rels part BEFORE the real local file header, so the
 *  first hit is rels XML, not a header. Require the PK\x03\x04 signature 30 bytes back.
 * @param {Uint8Array} bytes */
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

test("tileTo3mf seats the cord in the tile and plates the inlays clear of both", async () => {
  const grid = new Float32Array(GW * GH);
  for (let r = 0; r < GH; r++) for (let c = 0; c < GW; c++) grid[r * GW + c] = 100 + 3 * c;
  const cw = GW - 1;
  // A pond in the SOUTH — deliberately, not incidentally: its own y is then far below the tile's
  // top edge, which is the ordering that makes a missing −lo correction place it back inside the
  // tile rather than merely wasting plate. A pond at the north edge would let the 10 mm gap
  // absorb the error and the placement bug would be invisible.
  const pond = new Uint8Array(cw * (GH - 1));
  for (let r = 32; r <= 36; r++) for (let c = 2; c <= 8; c++) pond[r * cw + c] = 1;
  const top = new Float32Array(GW * GH);
  for (let i = 0; i < grid.length; i++) top[i] = grid[i] + 40;
  const plan = /** @type {any} */ ({ gw: GW, gh: GH, dx: GEOM.dx, dy: GEOM.dy, span: SPAN });

  const tile = buildSolid(grid, GW, GH, SPAN, new Uint8Array(cw * (GH - 1)).fill(1), GEOM);
  const cord = cordSolid(grid, plan, [Float64Array.from([1, 18, 18, 18])], 1.6, 0.6,
    GEOM, admissibleCells(GW, GH, null), GEOM.base);
  const inlays = buildDrape(grid, GW, GH, SPAN, pond, GEOM, top);
  assert.ok(cord && inlays);

  const xml = modelXml(await tileTo3mf("t", tile, undefined, cord, inlays));
  assert.equal((xml.match(/<object /g) ?? []).length, 3);
  const items = [...xml.matchAll(/<item objectid="(\d+)" transform="([^"]+)"/g)];
  assert.equal(items.length, 3);

  /** @param {import("../src/core/types.js").Solid} s @returns {[number, number]} */
  const yRange = (s) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 1; i < s.positions.length; i += 3) {
      lo = Math.min(lo, s.positions[i]); hi = Math.max(hi, s.positions[i]);
    }
    return [lo, hi];
  };
  // Each part's PLACED interval: its own y extent plus the translation the file actually
  // carries. Reading the transform back, rather than recomputing what the writer would do, is
  // the whole point — the arithmetic under test is exactly the arithmetic that would be copied.
  const placed = [tile, cord, inlays].map((s, i) => {
    const ty = Number(items[i][2].trim().split(/\s+/)[10]);
    const [lo, hi] = yRange(s);
    return [lo + ty, hi + ty];
  });
  assert.ok(yRange(tile)[1] - yRange(inlays)[0] > 10,
    "fixture must put the pond's low edge more than one gap below the tile's top, or a missing " +
    "−lo correction is absorbed by the gap instead of overlapping");
  // The cord is seated, not plated: identity transform, and its placed span inside the tile's.
  assert.equal(items[1][2].trim().split(/\s+/).slice(9, 11).map(Number).join(), "0,0");
  assert.ok(placed[1][0] >= placed[0][0] && placed[1][1] <= placed[0][1],
    `cord placed at ${placed[1]}, outside a tile spanning ${placed[0]}`);
  // The inlays are the only plated part left, and they clear the tile — the cord with it.
  assert.ok(placed[2][0] >= placed[0][1],
    `inlays placed at ${placed[2][0]}, under a tile reaching ${placed[0][1]}`);
});

// --- seated mode ----------------------------------------------------------
//
// The preview draws these parts where they belong; the export plates them on the bed. Those are
// different frames and no single translation connects them, because each PIECE is dropped to z 0
// independently — two bodies 400 m apart in elevation both bottom out at 0. Hence a mode here
// rather than an offset at the far end.

test("seated: the part's underside IS the printed surface, for every body on the tile", () => {
  const plan = planTile(BASE, { z: 10 });
  const { mosaic, mask } = seaLakeTile(plan);
  const s = opts({ recessMm: 3 });
  const { solid, inlays } = bakeTileSolid(mosaic, plan, { ...s, inlaySeated: true }, mask);
  assert.ok(inlays);
  const tile = columns(solid.positions), part = columns(inlays.positions);
  const midX = (plan.gw - 1) * plan.dx / 2;
  let checked = 0, sawSea = 0, sawLake = 0, worst = 0;
  for (const [k, p] of part) {
    const t = tile.get(k);
    if (!t) continue;
    worst = Math.max(worst, Math.abs(p.lo - t.hi));
    Number(k.split(",")[0]) < midX ? sawSea++ : sawLake++;
    checked++;
  }
  assert.ok(checked > 100, `only ${checked} columns compared`);
  assert.ok(sawSea > 20 && sawLake > 20, `must cover both bodies (${sawSea} sea, ${sawLake} lake)`);
  assert.ok(worst < 1e-4, `seated underside must mate with the printed surface, worst gap ${worst}`);
});

// The assertion that fails if anything reintroduces a shared floor: a single offset would put
// both pieces on the same plane, which is precisely the bug the mode exists to avoid.
test("seated: two bodies keep the elevation gap between them", () => {
  const plan = planTile(BASE, { z: 10 });
  const { mosaic, mask } = seaLakeTile(plan);
  const s = opts({ recessMm: 3 });
  const { inlays } = bakeTileSolid(mosaic, plan, { ...s, inlaySeated: true }, mask);
  assert.ok(inlays);
  const midX = (plan.gw - 1) * plan.dx / 2;
  const lo = [Infinity, Infinity];
  const P = inlays.positions;
  for (let i = 0; i < P.length; i += 3) {
    const side = P[i] < midX ? 0 : 1;
    if (P[i + 2] < lo[side]) lo[side] = P[i + 2];
  }
  const K = plan.mmPerM * s.exag;
  assert.ok(Math.abs((lo[1] - lo[0]) - (LAKE - SEA) * K) < 1e-3,
    `pieces must sit ${((LAKE - SEA) * K).toFixed(2)} mm apart, got ${(lo[1] - lo[0]).toFixed(2)}`);
});

// The export's contract, asserted here so the new branch cannot quietly take it away.
test("unseated: every piece still floors at exactly 0, which is what plates them", () => {
  const plan = planTile(BASE, { z: 10 });
  const { mosaic, mask } = seaLakeTile(plan);
  const { inlays } = bakeTileSolid(mosaic, plan, opts({ recessMm: 3 }), mask);
  assert.ok(inlays);
  const midX = (plan.gw - 1) * plan.dx / 2;
  const lo = [Infinity, Infinity];
  const P = inlays.positions;
  for (let i = 0; i < P.length; i += 3) {
    const side = P[i] < midX ? 0 : 1;
    if (P[i + 2] < lo[side]) lo[side] = P[i + 2];
  }
  assert.equal(lo[0], 0, "sea piece must rest on the bed");
  assert.equal(lo[1], 0, "lake piece must rest on the bed too — per piece, not per part");
});
