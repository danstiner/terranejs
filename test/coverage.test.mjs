import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeCoverage } from "../src/core/coverage.js";

// Minimal MVT encoder, for fixtures only. Mirrors the decoder's format but written from the
// spec, not from the decoder — the point is to disagree with it if either is wrong.
/** @type {(n: number) => number[]} */
const varint = (n) => { const b = []; while (n > 0x7f) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n); return b; };
/** @type {(n: number) => number} */
const zig = (n) => (n << 1) ^ (n >> 31);
/** @type {(f: number, w: number) => number[]} */
const tag = (f, w) => varint((f << 3) | w);
/** @type {(f: number, n: number) => number[]} */
const uint = (f, n) => [...tag(f, 0), ...varint(n)];
/** @type {(f: number, a: number[]) => number[]} */
const bytes = (f, a) => [...tag(f, 2), ...varint(a.length), ...a];
/** @type {(s: string) => number[]} */
const utf8 = (s) => [...new TextEncoder().encode(s)];

// The cursor carries ACROSS rings within one feature — resetting it per ring is the classic
// MVT bug, so the encoder must get this right for the test to be worth anything.
/** @param {Array<Array<[number, number]>>} rings */
function geometry(rings) {
  const g = []; let cx = 0, cy = 0;
  for (const r of rings) {
    g.push(...varint((1 << 3) | 1), ...varint(zig(r[0][0] - cx)), ...varint(zig(r[0][1] - cy)));
    cx = r[0][0]; cy = r[0][1];
    g.push(...varint(((r.length - 1) << 3) | 2));
    for (let i = 1; i < r.length; i++) {
      g.push(...varint(zig(r[i][0] - cx)), ...varint(zig(r[i][1] - cy)));
      cx = r[i][0]; cy = r[i][1];
    }
    g.push(...varint((1 << 3) | 7)); // ClosePath: no vertex
  }
  return g;
}

// Values are emitted AFTER the features on purpose: a decoder that resolves tags inline
// instead of in a second pass reads an empty value table and fails here.
/** @param {Array<{ source: string, rings: Array<Array<[number, number]>> }>} features @param {number} [extent] */
function tile(features, extent = 4096) {
  const values = [...new Set(features.map((f) => f.source))];
  const layer = [
    ...uint(15, 2),
    ...bytes(1, utf8("coverage")),
    ...features.flatMap((f) => bytes(2, [
      ...bytes(2, [...varint(0), ...varint(values.indexOf(f.source))]),
      ...uint(3, 3), // POLYGON
      ...bytes(4, geometry(f.rings)),
    ])),
    ...bytes(3, utf8("source")),
    ...values.flatMap((v) => bytes(4, bytes(1, utf8(v)))),
    ...uint(5, extent),
  ];
  return Uint8Array.from(bytes(3, layer));
}

test("decodeCoverage: round-trips a hand-built tile", () => {
  /** @type {Array<Array<[number, number]>>} */
  const rings = [[[10, 20], [3000, 20], [3000, 900], [10, 900]]];
  const { extent, features } = decodeCoverage(tile([{ source: "abc", rings }]));
  assert.equal(extent, 4096);
  assert.equal(features.length, 1);
  assert.equal(features[0].source, "abc");
  assert.deepEqual(features[0].rings, rings); // ClosePath added no fifth vertex
});

test("decodeCoverage: the cursor carries across rings of one feature", () => {
  // Second ring's first vertex is encoded as a delta from the FIRST ring's last vertex.
  /** @type {Array<Array<[number, number]>>} */
  const rings = [[[0, 0], [100, 0], [100, 100]], [[500, 500], [600, 500], [600, 600]]];
  const { features } = decodeCoverage(tile([{ source: "s", rings }]));
  assert.deepEqual(features[0].rings, rings);
});

test("decodeCoverage: honors a non-4096 extent", () => {
  const { extent } = decodeCoverage(tile([{ source: "s", rings: [[[0, 0], [1, 0], [1, 1]]] }], 8192));
  assert.equal(extent, 8192);
});

test("decodeCoverage: unknown wire-5/wire-1 fields are skipped without desyncing the parse", () => {
  // Every other fixture here uses only wire types 0/2, so the fixed32/fixed64 skip widths never
  // run. A wrong width would eat into (or leave behind) the neighboring bytes, so the check that
  // matters is not "did it throw" but "did source/extent AFTER the unknown fields still parse".
  /** @type {Array<Array<[number, number]>>} */
  const rings = [[[0, 0], [10, 0], [10, 10]]];
  const layer = [
    ...uint(15, 2),
    ...bytes(1, utf8("coverage")),
    ...tag(90, 5), 0xde, 0xad, 0xbe, 0xef, // unknown fixed32 field
    ...tag(91, 1), 1, 2, 3, 4, 5, 6, 7, 8, // unknown fixed64 field
    ...bytes(2, [
      ...bytes(2, [...varint(0), ...varint(0)]),
      ...uint(3, 3), // POLYGON
      ...bytes(4, geometry(rings)),
    ]),
    ...bytes(3, utf8("source")),
    ...bytes(4, bytes(1, utf8("abc"))),
    ...uint(5, 8192),
  ];
  const { extent, features } = decodeCoverage(Uint8Array.from(bytes(3, layer)));
  assert.equal(extent, 8192);
  assert.equal(features.length, 1);
  assert.equal(features[0].source, "abc");
  assert.deepEqual(features[0].rings, rings);
});

test("decodeCoverage: ignores layers other than 'coverage' in a multi-layer tile", () => {
  // The decoy sits AFTER coverage and carries its own feature/extent: a decoder that just
  // accumulates across Tile.layers (rather than filtering by name) would let the decoy's
  // last-written extent win and pick up its feature too — both assertions below would fail.
  /** @type {Array<Array<[number, number]>>} */
  const decoyRings = [[[0, 0], [1, 0], [1, 1]]];
  const decoyLayer = [
    ...uint(15, 2),
    ...bytes(1, utf8("buildings")),
    ...bytes(2, [
      ...bytes(2, [...varint(0), ...varint(0)]),
      ...uint(3, 3), // POLYGON
      ...bytes(4, geometry(decoyRings)),
    ]),
    ...bytes(3, utf8("source")),
    ...bytes(4, bytes(1, utf8("zzz"))),
    ...uint(5, 111),
  ];
  const coverage = tile([{ source: "abc", rings: [[[0, 0], [1, 0], [1, 1]]] }], 8192);
  const decoy = Uint8Array.from(bytes(3, decoyLayer));
  const { extent, features } = decodeCoverage(new Uint8Array([...coverage, ...decoy]));
  assert.equal(extent, 8192);
  assert.deepEqual(features.map((f) => f.source), ["abc"]);
});

test("decodeCoverage: an empty body is zero features, not an error", () => {
  // Ocean tiles are HTTP 204 with a zero-byte body — `res.ok` is TRUE for those.
  assert.deepEqual(decodeCoverage(new Uint8Array(0)), { extent: 4096, features: [] });
});

test("decodeCoverage: the real Mapterhorn tile", () => {
  // A committed 316-byte capture. The hand-built fixtures above share an author with the
  // decoder and would agree with it even if both were wrong; this one cannot.
  const buf = new Uint8Array(readFileSync(new URL("./reference/coverage-10-166-351.mvt", import.meta.url)));
  const { extent, features } = decodeCoverage(buf);
  assert.equal(extent, 4096);
  assert.deepEqual(features.map((f) => f.source), ["glo30", "us1cc", "cahrdem2", "usgs3dep13"]);
  assert.deepEqual(features.map((f) => f.rings.map((r) => r.length)), [[4], [28, 4], [20, 5, 4], [7]]);
  // buffer 64: coordinates run past the tile edges on both sides
  const xs = features[0].rings[0].map(([x]) => x);
  assert.deepEqual([Math.min(...xs), Math.max(...xs)], [-64, 4160]);
});

import { projectFeatures, sourcesAt } from "../src/core/coverage.js";

/** @typedef {import("../src/core/coverage.js").CoverageTile} CoverageTile */
/** @typedef {import("../src/core/coverage.js").CoverageFeature} CoverageFeature */
/** @typedef {import("../src/core/coverage.js").PlacedFeature} PlacedFeature */

const win = { gx0: 1000, gy0: 2000, gw: 64, gh: 64 };

test("projectFeatures: cz === pz puts tile-local units straight into global pixels", () => {
  // extent 4096 over a 256-px tile → 16 units per pixel. Tile 5 starts at global px 5*256=1280.
  /** @type {CoverageTile} */
  const t = { extent: 4096, features: [{ source: "s", rings: [[[0, 0], [4096, 0], [4096, 4096], [0, 4096]]] }] };
  const [f] = projectFeatures(t, 5, 9, 10, 10, win);
  assert.deepEqual(f.rings[0], [[280, 304], [536, 304], [536, 560], [280, 560]]);
  // 5*256 - 1000 = 280 ; 6*256 - 1000 = 536 ; 9*256 - 2000 = 304 ; 10*256 - 2000 = 560
});

test("projectFeatures: a shallower coverage zoom scales up by 2^(pz-cz)", () => {
  // The coverage tileset stops at z14 but bakes run to z15, so this is the normal case.
  /** @type {CoverageTile} */
  const t = { extent: 4096, features: [{ source: "s", rings: [[[0, 0], [2048, 0], [2048, 2048]]] }] };
  const [f] = projectFeatures(t, 0, 0, 14, 15, { gx0: 0, gy0: 0, gw: 8, gh: 8 });
  assert.deepEqual(f.rings[0], [[0, 0], [256, 0], [256, 256]]); // half a z14 tile = 256 px at z15
});

test("projectFeatures: an unwrapped tx past the antimeridian stays contiguous", () => {
  // sourceTileRange returns tx >= 2^z for a window crossing +180°, and the raster path keeps that
  // unwrapped value for placement (terrain.mosaicTiles). Using the wrapped x here would drop the
  // polygon a whole world away in grid space.
  /** @type {Array<Array<[number, number]>>} */
  const ring = [[[0, 0], [4096, 0], [4096, 4096]]];
  /** @type {CoverageTile} */
  const world = { extent: 4096, features: [{ source: "s", rings: ring }] };
  const [a] = projectFeatures(world, 3, 1, 2, 2, { gx0: 800, gy0: 256, gw: 8, gh: 8 });
  const [b] = projectFeatures(world, 4, 1, 2, 2, { gx0: 800, gy0: 256, gw: 8, gh: 8 });
  assert.equal(a.rings[0][1][0], b.rings[0][0][0]); // tile 3's east edge == tile 4's west edge
  assert.equal(b.rings[0][0][0], 4 * 256 - 800);
});

test("sourcesAt: rings XOR, so holes subtract and disjoint rings add", () => {
  /** @type {CoverageFeature[]} */
  const feats = [
    { source: "donut", rings: [[[0, 0], [100, 0], [100, 100], [0, 100]], [[40, 40], [60, 40], [60, 60], [40, 60]]] },
    { source: "pair", rings: [[[0, 0], [30, 0], [30, 30], [0, 30]], [[200, 200], [210, 200], [210, 210], [200, 210]]] },
  ];
  assert.deepEqual(sourcesAt(feats, 20, 20), ["donut", "pair"]); // inside both first rings
  assert.deepEqual(sourcesAt(feats, 50, 50), []);                // in the donut's hole
  assert.deepEqual(sourcesAt(feats, 205, 205), ["pair"]);        // the disjoint second ring
  assert.deepEqual(sourcesAt(feats, 500, 500), []);              // nothing here
});

test("sourcesAt: the real tile's answers", () => {
  const buf = new Uint8Array(readFileSync(new URL("./reference/coverage-10-166-351.mvt", import.meta.url)));
  // Identity projection (cz === pz === 10, window at the tile origin) keeps the tile-local
  // coordinates, so these assert the same points verified against the live tile.
  const t = decodeCoverage(buf);
  const f = projectFeatures(t, 166, 351, 10, 10, { gx0: 166 * 256, gy0: 351 * 256, gw: 256, gh: 256 });
  /** @type {(x: number, y: number) => string[]} */
  const at = (x, y) => sourcesAt(f, (x / 4096) * 256, (y / 4096) * 256);
  assert.deepEqual(at(2048, 2048), ["glo30", "cahrdem2"]);
  assert.deepEqual(at(2048, 3000), ["glo30", "usgs3dep13"]);
  assert.deepEqual(at(880, 4156), ["glo30", "us1cc", "usgs3dep13"]); // us1cc's second ring
});

test("sourcesAt: a cell on a tile seam counts each source once", () => {
  // Tiles carry a 64-unit buffer (±4 px at 256), so ground beside a seam lies inside the SAME
  // source's polygon in both neighbors. Undeduped, describeSources reads the repeat as a tie
  // and reports a source as tied with itself — over glo30, that is every seam over land.
  const buf = new Uint8Array(readFileSync(new URL("./reference/coverage-10-166-351.mvt", import.meta.url)));
  const t = decodeCoverage(buf);
  const win = { gx0: 166 * 256, gy0: 351 * 256, gw: 512, gh: 256 };
  const seam = sourcesAt([
    ...projectFeatures(t, 166, 351, 10, 10, win),
    ...projectFeatures(t, 167, 351, 10, 10, win), // same bytes as the east neighbor: only the overlap matters
  ], 256, 128);
  assert.deepEqual(seam, [...new Set(seam)]);
  assert.ok(seam.includes("glo30"));
  assert.equal(describeSources(seam, cat, LAT), "cahrdem2 2 m"); // not "cahrdem2 ⇄ cahrdem2"
});

import { describeSources, maxzoomFor, edgeDistance, featherPx } from "../src/core/coverage.js";

/** @type {[number, number, number, number]} */
const FAR = [-1e9, -1e9, 1e9, 1e9]; // a clip rectangle nothing touches, so every edge counts

test("edgeDistance: distance to the nearest data edge, not to a vertex", () => {
  /** @type {PlacedFeature[]} */
  const f = [{ source: "a", clip: FAR, rings: [[[0, 0], [100, 0], [100, 100], [0, 100]]] }];
  assert.equal(edgeDistance(f, 50, 5, "a"), 5);      // nearest point is mid-segment, not a corner
  assert.equal(edgeDistance(f, 50, 50, "a"), 50);    // dead center
  assert.equal(edgeDistance(f, 3, 4, "a"), 3);       // near a corner: the closer EDGE wins, not 5
  assert.equal(edgeDistance(f, 50, 50, "b"), Infinity); // a source with no rings here
  // A hole is an edge too: data ends at its rim, so the merge feathers there as well.
  /** @type {Array<[number, number]>} */
  const hole = [[40, 40], [60, 40], [60, 60], [40, 60]];
  /** @type {PlacedFeature[]} */
  const holed = [{ source: "a", clip: FAR, rings: [f[0].rings[0], hole] }];
  assert.equal(edgeDistance(holed, 50, 35, "a"), 5);
});

test("edgeDistance: a clip edge is not a data edge", () => {
  // A tile cuts its polygons at the buffered rectangle. Those segments are where the TILE ends,
  // not the source, and counting them flags a blend along every internal seam.
  /** @type {PlacedFeature[]} */
  const clipped = [{ source: "a", clip: [0, 0, 100, 100], rings: [[[0, 0], [100, 0], [100, 100], [0, 100]]] }];
  assert.equal(edgeDistance(clipped, 50, 5, "a"), Infinity);   // every side is the clip rectangle
  // One real edge cutting across the tile still registers, and the clip sides still do not.
  /** @type {PlacedFeature[]} */
  const half = [{ source: "a", clip: [0, 0, 100, 100], rings: [[[0, 0], [100, 0], [100, 40], [0, 40]]] }];
  assert.equal(edgeDistance(half, 50, 30, "a"), 10);
});

test("featherPx: the blur's real reach, which depends on the merge's own zoom", () => {
  // sigma = max(int(int(150/res)/4) - 1, 1), reach = 4·sigma·res. A 1 m lidar merge reaches
  // ~143 Mercator m; one sitting on the z12 floor reaches only ~76, so a flat 150 doubles it.
  /** @type {(pz: number, mz: number) => number} */
  const m = (pz, mz) => featherPx(pz, mz) * (2 * 20037508.342789244 / (256 * 2 ** pz));
  assert.equal(Math.round(m(15, 16)), 143);
  assert.equal(Math.round(m(15, 12)), 76);
  assert.equal(Math.round(m(12, 16)), Math.round(m(15, 16))); // a ground distance, not a pixel count
  assert.ok(featherPx(15, 16) > featherPx(12, 16));           // ...so more px the deeper the bake
});

const LAT = 45; // buckets separate the fixture resolutions here; see the Svalbard test for where they do not
const cat = new Map([
  ["glo30", 30],
  ["us1cc", 1],
  ["cahrdem2", 2],
  ["usgs3dep13", 10],
  ["at1", 1],
  ["atsalzburg", 1],
]);

test("describeSources: nothing covers the point", () => {
  assert.equal(describeSources([], cat, LAT), "no source data");
});

test("describeSources: the finest posting wins", () => {
  assert.equal(describeSources(["glo30", "usgs3dep13"], cat, LAT), "usgs3dep13 10 m");
  assert.equal(describeSources(["glo30", "us1cc", "usgs3dep13"], cat, LAT), "us1cc 1 m");
});

test("describeSources: equal maxzoom resolves by id, the way the merge does", () => {
  // 75 of the 134 sources are 1.0 m and they nest by construction (at1 covers all of Austria,
  // atsalzburg covers part of it). This is not an unknowable tie: pipelines/utils.py sorts
  // (-maxzoom, source, filename), so the alphabetically-first id is the one that was used.
  assert.equal(describeSources(["glo30", "at1", "atsalzburg"], cat, LAT), "at1 1 m");
  assert.equal(describeSources(["at1", "atsalzburg", "us1cc"], cat, LAT), "at1 1 m");
  assert.equal(describeSources(["us1cc", "atsalzburg", "at1"], cat, LAT), "at1 1 m");
});

test("maxzoomFor: the z12 floor ties every coarse source together", () => {
  // aggregation_covering.py clamps with max(maxzoom, macrotile_z=12) and writes the CLAMPED
  // value, so anything coarser than ~19 Mercator m/px lands on 12 and the id tiebreak decides.
  // glo30 vs nosvalbard is the case: ranking by raw meters names nosvalbard, at any latitude.
  const arctic = new Map([["glo30", 30], ["nosvalbard", 20]]);
  for (const lat of [78.22, 60, 45, 0]) {
    assert.equal(maxzoomFor(30, lat), 12, `glo30 at ${lat}`);
    assert.equal(maxzoomFor(20, lat), 12, `nosvalbard at ${lat}`);
    assert.equal(describeSources(["glo30", "nosvalbard"], arctic, lat), "glo30 30 m");
  }
});

test("maxzoomFor: above the floor, latitude still merges buckets", () => {
  // The Mercator stretch is not redundant with the clamp — it decides pairs finer than the floor.
  // 2 m and 2.5 m separate at the equator and collide at 45, where the merge falls back to id.
  const it = new Map([["itsicily", 2], ["itbozen", 2.5]]);
  assert.ok(maxzoomFor(2, 0) > maxzoomFor(2.5, 0));
  assert.equal(describeSources(["itbozen", "itsicily"], it, 0), "itsicily 2 m");
  assert.equal(maxzoomFor(2, 45), maxzoomFor(2.5, 45));
  assert.equal(describeSources(["itbozen", "itsicily"], it, 45), "itbozen 2.5 m"); // id wins
});

test("describeSources: a feathered cell names both sides", () => {
  // Within ~150 Mercator meters of where a source's data ends, the merge Gaussian-blended it
  // with whatever filled beyond — no single-source answer is correct there.
  assert.equal(describeSources(["glo30", "us1cc"], cat, LAT, "glo30"), "us1cc 1 m ⇄ glo30 (blended)");
});

test("describeSources: ranking is stable regardless of input order", () => {
  assert.equal(describeSources(["atsalzburg", "at1"], cat, LAT), describeSources(["at1", "atsalzburg"], cat, LAT));
});

test("describeSources: an unlisted id is surfaced, never dropped", () => {
  // glo30 is a whole-tile rectangle under every land pixel, so ranking an unknown id as
  // "coarsest" would hide it at every point — and a lagging catalog is exactly when a new
  // high-resolution source appears.
  assert.equal(describeSources(["glo30", "us1cc", "xy12"], cat, LAT), "us1cc 1 m ?xy12 unranked");
  assert.equal(describeSources(["xy12", "ab3"], cat, LAT), "ab3, xy12 (unlisted)");
});

test("describeSources: no catalog means raw ids, flagged and order-independent", () => {
  assert.equal(describeSources(["glo30", "us1cc"], null, LAT), "glo30, us1cc (catalog unavailable)");
  assert.equal(describeSources(["us1cc", "glo30"], null, LAT), "glo30, us1cc (catalog unavailable)");
});

test("describeSources: id-resolved winner and an unranked id together", () => {
  assert.equal(describeSources(["us1cc", "at1", "xy12"], cat, LAT), "at1 1 m ?xy12 unranked");
});

import { fetchCoverage, fetchCatalog } from "../src/core/coverage.js";
import { MAX_MERCATOR_LAT } from "../src/core/tilemath.js";

// fetchCoverage/fetchCatalog own the fetch(); decode/project/rank are covered above. Every
// test here stubs globalThis.fetch and restores it in `finally`, since node has no fetch mock
// convention elsewhere in this suite.

test("fetchCoverage: a 204 zero-byte tile contributes zero features, not an error", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (
    async () => ({ ok: true, status: 204, arrayBuffer: async () => new ArrayBuffer(0) })
  ));
  try {
    // sourceTileRange([46,-122,46.02,-121.98],10) is 2 tiles wide, both 204 — see tilemath.js.
    const features = await fetchCoverage([46, -122, 46.02, -121.98], 10, { gx0: 0, gy0: 0, gw: 256, gh: 256 });
    assert.deepEqual(features, []);
  } finally { globalThis.fetch = real; }
});

test("fetchCoverage: a non-204 error status throws, unlike an empty-body 204", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (
    async () => ({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) })
  ));
  try {
    await assert.rejects(
      () => fetchCoverage([46, -122, 46.02, -121.98], 10, { gx0: 0, gy0: 0, gw: 256, gh: 256 }),
      /HTTP 500/,
    );
  } finally { globalThis.fetch = real; }
});

test("fetchCoverage: never sends cache: force-cache", async () => {
  /** @type {RequestInit[]} */
  const inits = [];
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {typeof fetch} */ (async (_url, init) => {
    inits.push(/** @type {RequestInit} */ (init));
    return { ok: true, status: 204, arrayBuffer: async () => new ArrayBuffer(0) };
  });
  try {
    await fetchCoverage([46, -122, 46.02, -121.98], 10, { gx0: 0, gy0: 0, gw: 256, gh: 256 });
    assert.ok(inits.length > 0);
    for (const init of inits) assert.notEqual(init.cache, "force-cache");
  } finally { globalThis.fetch = real; }
});

test("fetchCoverage: ty is clamped to [0, 2^cz-1], never fetching the halo's negative row", async () => {
  // sourceTileRange([MAX_MERCATOR_LAT-0.001,-1,MAX_MERCATOR_LAT,1], 0) is tx0=tx1=0, ty ∈ [-1,0]
  // (the 1-px halo pushes ty0 negative right at the cap) — computed via tilemath, not by hand.
  /** @type {string[]} */
  const urls = [];
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {typeof fetch} */ (async (url) => {
    urls.push(String(url));
    return { ok: true, status: 204, arrayBuffer: async () => new ArrayBuffer(0) };
  });
  try {
    await fetchCoverage([MAX_MERCATOR_LAT - 0.001, -1, MAX_MERCATOR_LAT, 1], 0, { gx0: 0, gy0: 0, gw: 256, gh: 256 });
    assert.deepEqual(urls, ["https://single-archive-tiles.mapterhorn.com/coverage/0/0/0.mvt"]);
  } finally { globalThis.fetch = real; }
});

test("fetchCoverage: the URL wraps tile x, but projection places it at the raw unwrapped tx", async () => {
  // sourceTileRange([10,170,10.001,190], 2) is tx0=3,tx1=4,ty0=ty1=1 — tx=4 wraps to x=0 for the
  // URL (world=4), and a bug that also used the wrapped x for placement would land tile "4" at
  // tile 0's position (a whole world away) instead of directly east of tile 3.
  const buf = (/** @type {string} */ source) =>
    tile([{ source, rings: [[[0, 0], [4096, 0], [4096, 4096], [0, 4096]]] }]);
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {typeof fetch} */ (async (url) => {
    const u = String(url);
    const body = u.endsWith("/2/3/1.mvt") ? buf("west") : u.endsWith("/2/0/1.mvt") ? buf("east") : null;
    if (!body) throw new Error(`unexpected coverage URL ${u}`);
    return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
  });
  try {
    const features = await fetchCoverage([10, 170, 10.001, 190], 2, { gx0: 3 * 256, gy0: 1 * 256, gw: 512, gh: 256 });
    const west = features.find((f) => f.source === "west");
    const east = features.find((f) => f.source === "east");
    assert.ok(west && east, "expected one feature per fetched tile");
    const xw = west.rings[0].map(([x]) => x);
    const xe = east.rings[0].map(([x]) => x);
    assert.deepEqual([Math.min(...xw), Math.max(...xw)], [0, 256]);   // tile 3, unwrapped == wrapped here
    assert.deepEqual([Math.min(...xe), Math.max(...xe)], [256, 512]); // tile 4, unwrapped — contiguous with tile 3
  } finally { globalThis.fetch = real; }
});

test("fetchCatalog: builds a Map keyed by source id", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (async () => ({
    ok: true, status: 200,
    json: async () => [
      { source: "glo30", name: "COPERNICUS GLO-30", resolution: 30 },
      { source: "us1cc", name: "1 meter DEMs", resolution: 1 },
    ],
  })));
  try {
    const cat = await fetchCatalog();
    assert.equal(cat.get("glo30"), 30);
    assert.equal(cat.get("us1cc"), 1);
  } finally { globalThis.fetch = real; }
});

test("fetchCatalog: a non-ok response throws (the worker's catalogOnce catches this to null)", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (
    async () => ({ ok: false, status: 503, json: async () => [] })
  ));
  try {
    await assert.rejects(() => fetchCatalog(), /HTTP 503/);
  } finally { globalThis.fetch = real; }
});

test("fetchCatalog: never sends cache: force-cache", async () => {
  /** @type {RequestInit | undefined} */
  let init;
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {typeof fetch} */ (async (_url, i) => {
    init = /** @type {RequestInit} */ (i);
    return { ok: true, status: 200, json: async () => [] };
  });
  try {
    await fetchCatalog();
    assert.notEqual(init?.cache, "force-cache");
  } finally { globalThis.fetch = real; }
});
