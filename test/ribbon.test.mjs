// The ribbon's reason for existing is that its underside mates with the printed terrain. That
// is a property of vertex positions, so it is asserted directly rather than through a proxy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { buildSolid, buildDrape } from "../src/core/mesh.js";
import { checkWatertight, signedVolume } from "../src/core/validate.js";
import { planTile, bakeTileSolid, tileTo3mf } from "../src/core/pipeline.js";
import { MIN_CORD_CELLS } from "../src/core/corridor.js";
import { globalXToLon, globalYToLat } from "../src/core/tilemath.js";

const GW = 60, GH = 60, H = 0.6;
const SPAN = { r0: 0, r1: GH - 1, c0: 0, c1: GW - 1 };
const GEOM = { dx: 0.5, dy: 0.5, mmPerM: 0.04, emin: 0, exag: 1, base: 3 };

/** Lumpy but smooth terrain, so relief varies under the cord. */
const grid = new Float32Array(GW * GH);
for (let r = 0; r < GH; r++)
  for (let c = 0; c < GW; c++)
    grid[r * GW + c] = 40 * Math.sin(c / 7) + 25 * Math.cos(r / 5) + 100;

/** @param {(r:number,c:number)=>boolean} pred */
function mask(pred) {
  const cw = GW - 1, ch = GH - 1, m = new Uint8Array(cw * ch);
  for (let r = 0; r < ch; r++) for (let c = 0; c < cw; c++) if (pred(r, c)) m[r * cw + c] = 1;
  return m;
}
const BAND = mask((r) => r >= 28 && r <= 31);                       // straight
const CURVED = mask((r, c) => Math.abs(r - (30 + 15 * Math.sin(c / 10))) <= 2); // curved
const CROSS = mask((r, c) => (r >= 28 && r <= 31) || (c >= 20 && c <= 23)); // self-crossing
const TWO = mask((r) => (r >= 10 && r <= 12) || (r >= 40 && r <= 42));      // two segments

test("ribbon is watertight and positive-volume for every trail shape", () => {
  /** @type {[string, Uint8Array][]} */
  const shapes = [["straight", BAND], ["curved", CURVED], ["self-crossing", CROSS], ["two segments", TWO]];
  for (const [name, m] of shapes) {
    const rib = buildDrape(grid, GW, GH, SPAN, m, GEOM, H);
    assert.ok(rib, `${name}: built`);
    const wt = checkWatertight(rib);
    assert.ok(wt.closed, `${name}: ${wt.unmatched} unmatched edges`);
    assert.ok(signedVolume(rib) > 0, `${name}: inside-out`);
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

test("the underside is the terrain surface, offset by one constant", () => {
  const rib = buildDrape(grid, GW, GH, SPAN, BAND, GEOM, H);
  assert.ok(rib);
  const tile = buildSolid(grid, GW, GH, SPAN, new Uint8Array((GW - 1) * (GH - 1)).fill(1), GEOM);
  const top = columns(tile.positions);   // tile: hi = terrain surface, lo = z-0 base plane
  const bot = columns(rib.positions);    // cord: lo = molded underside, hi = underside + H

  // Ground truth for the offset, computed independently of buildDrape: the corridor's own
  // minimum relief over the vertex rows/cols BAND's cells touch (cell rows 28..31 span vertex
  // rows 28..32; every column). A buildDrape that subtracted the tile's emin (0 here) or
  // nothing at all would STILL produce a column-constant offset — top.hi - rib.lo always
  // reduces to base + (whatever constant got subtracted), since relief(id) cancels regardless
  // of what that constant is. Checking only that the offset is constant across columns cannot
  // tell the right constant from a wrong one; pinning the VALUE against an independent
  // computation is what actually exercises the congruence invariant.
  let minRelief = Infinity;
  for (let r = 28; r <= 32; r++)
    for (let c = 0; c < GW; c++) minRelief = Math.min(minRelief, grid[r * GW + c] * GEOM.mmPerM);
  const expected = GEOM.base + minRelief;

  let checked = 0;
  for (const [k, r] of bot) {
    const t = top.get(k);
    if (!t) continue;
    const d = t.hi - r.lo;
    assert.ok(Math.abs(d - expected) < 1e-6, `column ${k}: offset ${d}, expected ${expected}`);
    checked++;
  }
  assert.ok(checked > 100, `only ${checked} columns compared`);
});

test("the cord sits on the plate and has uniform thickness", () => {
  const rib = buildDrape(grid, GW, GH, SPAN, BAND, GEOM, H);
  assert.ok(rib);
  const cols = columns(rib.positions);
  let lowest = Infinity;
  for (const { lo, hi } of cols.values()) {
    lowest = Math.min(lowest, lo);
    assert.ok(Math.abs(hi - lo - H) < 1e-6, `thickness ${hi - lo}, expected ${H}`);
  }
  assert.ok(Math.abs(lowest) < 1e-9, `lowest vertex at ${lowest}, expected 0`);
});

test("an empty corridor yields no ribbon", () => {
  assert.equal(buildDrape(grid, GW, GH, SPAN, new Uint8Array((GW - 1) * (GH - 1)), GEOM, H), null);
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

test("bakeTileSolid: no trail -> ribbon is null", () => {
  const plan = planTile(PIPE_SETTINGS, { z: 10 });
  const { ribbon } = bakeTileSolid(flatMosaicFor(plan), plan, PIPE_SETTINGS);
  assert.equal(ribbon, null);
});

test("bakeTileSolid: a ribbon narrower than MIN_CORD_CELLS*plan.dx throws naming the minimum", () => {
  const plan = planTile(PIPE_SETTINGS, { z: 10 });
  const trail = { segments: [[/** @type {[number, number]} */ ([0, 0])]], widthMm: plan.dx, heightMm: 1 };
  const minMm = (MIN_CORD_CELLS * plan.dx).toFixed(2);
  assert.throws(() => bakeTileSolid(flatMosaicFor(plan), plan, PIPE_SETTINGS, undefined, trail),
    (/** @type {Error} */ err) => err.message.includes(`${minMm} mm`),
    `error must name the ${minMm} mm minimum`);
});

// checkWatertight can't see this: it only reads `indices`, never z, so a mirrored ribbon with
// zero or negative height is still topologically closed. signedVolume is what has to catch it.
test("bakeTileSolid: a non-positive cord height is rejected, not silently exported degenerate", () => {
  const plan = planTile(PIPE_SETTINGS, { z: 10 });
  const { window: win, z } = plan;
  const row = 20, lat = globalYToLat(win.gy0 + row, z);
  /** @type {import("../src/core/types.js").LatLon[][]} */
  const segments = [[[lat, globalXToLon(win.gx0 + 10, z)], [lat, globalXToLon(win.gx0 + 30, z)]]];
  for (const heightMm of [0, -1]) {
    assert.throws(
      () => bakeTileSolid(flatMosaicFor(plan), plan, PIPE_SETTINGS, undefined, { segments, widthMm: 12, heightMm }),
      /non-positive-volume/,
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

// The load-bearing ordering test: applyWaterRecess mutates the grid, and bakeTileSolid must
// build the ribbon from that mutated grid — not a copy captured earlier, not the raw DEM.
//
// Flat 200 m terrain everywhere except a masked "water" band (cols 15..25), sunk by recessMm.
// Built correctly, the corridor's OWN minimum relief (0, at the sunk band) becomes its z=0
// baseline, so land columns land `recessMm` ABOVE the water columns — the recess is visible in
// the cord. Built from the pre-recess grid (or a snapshot taken before the mutation), every
// column reads the same flat 200 m and normalizes to an indistinguishable z=0: verified by
// swapping in a raw grid at this call site and rerunning — every column collapsed to 0, land and
// water alike.
test("ribbon is molded to the surface AFTER water recess, with the tile's own emin", () => {
  const settings = { ...PIPE_SETTINGS, recessMm: 20 };
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
    if (c >= 16 && c <= 24) { assert.ok(Math.abs(lo) < 1e-3, `water col ${c} underside ${lo}, want 0`); sawWater++; }
    if (c <= 12 || c >= 28) { assert.ok(Math.abs(lo - settings.recessMm) < 1e-3, `land col ${c} underside ${lo}, want ${settings.recessMm}`); sawLand++; }
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

test("tileTo3mf writes the ribbon as a second object, clear of the tile", async () => {
  const tile = buildSolid(grid, GW, GH, SPAN, new Uint8Array((GW - 1) * (GH - 1)).fill(1), GEOM);
  const rib = buildDrape(grid, GW, GH, SPAN, BAND, GEOM, H);
  assert.ok(rib);
  const xml = modelXml(await tileTo3mf("t", tile, undefined, rib));
  assert.equal((xml.match(/<object /g) ?? []).length, 2);
  const items = [...xml.matchAll(/<item objectid="(\d+)" transform="([^"]+)"/g)];
  assert.equal(items.length, 2);
  let maxY = -Infinity;
  for (let i = 1; i < tile.positions.length; i += 3) maxY = Math.max(maxY, tile.positions[i]);
  const ty = Number(items[1][2].trim().split(/\s+/)[10]);
  // The PLACED bottom edge, not the translation. A part keeps the tile's own coordinates, so
  // the cord already sits wherever its trail sits — here rows 28..32, ~28 mm up. Asserting the
  // translation alone passed only while the writer translated by the tile's full height, and
  // would keep passing for a part placed anywhere at all.
  let ribLo = Infinity;
  for (let i = 1; i < rib.positions.length; i += 3) ribLo = Math.min(ribLo, rib.positions[i]);
  assert.ok(ribLo + ty > maxY, `ribbon placed at y=${ribLo + ty} overlaps a tile reaching ${maxY}`);
});
