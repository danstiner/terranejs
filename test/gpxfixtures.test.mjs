// Golden tests against real exports on disk. test/gpxparse.test.mjs builds documents from
// strings to probe the walk's rules; this file pins whole files byte-for-byte, so a change
// in how any real exporter's output is read shows up as a failing literal rather than as a
// judgement call about whether some constructed string was representative.
//
// The good fixtures were trimmed from actual exports — header and <trkpt> bytes copied
// verbatim, not retyped — so each carries its source's real quirks: AllTrails' CDATA names,
// Garmin's 29-significant-digit coordinates and ns3: extensions, Strava's 1-space indent.
// See test/reference/README.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { segmentsFromDocument, segmentsOrExplain } from "../src/ui/gpxparse.js";
import { fitTile, clippedFraction } from "../src/core/gpx.js";
import { MM_PER_KM_MAX } from "../src/core/urlstate.js";
import { planTile } from "../src/core/pipeline.js";
import { trailToPrintMm, resample, corridorMask, halfWFor, DS_FACTOR } from "../src/core/corridor.js";
import { buildDrape } from "../src/core/mesh.js";
import { checkWatertight, signedVolume } from "../src/core/validate.js";

const parser = new DOMParser({ onError: () => {} });
/** @param {string} name @returns {string} */
const read = (name) => fs.readFileSync(new URL(`./reference/gpx/${name}`, import.meta.url), "utf8");
/** @param {string} name */
const doc = (name) => /** @type {any} */ (parser.parseFromString(read(name), "application/xml"));

const TILE = { tileWidthMm: 200, shape: /** @type {const} */ ("square") };

// --- real exports, read exactly ---

test("golden: AllTrails export", () => {
  const segs = segmentsOrExplain(doc("alltrails.gpx"));
  assert.deepEqual(segs, [[
    [48.95125, -121.6353],
    [48.95157, -121.63533],
    [48.95183, -121.63538],
    [48.95199, -121.63547],
    [48.95207, -121.63552],
    [48.9521, -121.63554],
    [48.95212, -121.63556],
    [48.95212, -121.63556], // the source really does repeat its last fix
  ]]);
});

test("golden: Garmin Connect export", () => {
  // lat="48.71756390668451786041259765625" — 29 significant digits, which is Garmin
  // printing a double's exact binary value. Number() must land back on that same double.
  const segs = segmentsOrExplain(doc("garmin-connect.gpx"));
  assert.deepEqual(segs, [[
    [48.71756390668452, -121.14521093666553],
    [48.71761051006615, -121.14523708820343],
    [48.71765552088618, -121.14525309763849],
    [48.71775350533426, -121.14522451534867],
    [48.71779952198267, -121.14508998580277],
    [48.71782089583576, -121.14501111209393],
    [48.7178255058825, -121.14499476738274],
    [48.717850064858794, -121.14493458531797],
  ]]);
  // The <extensions>/<ns3:TrackPointExtension> children carry no lat/lon, so a walk that
  // matched too loosely would still find 8 points — what pins it is the count of <trkpt>
  // ancestors being ignored: 8 points, not 8 plus anything the extensions contribute.
  assert.equal(segs[0].length, 8);
});

test("golden: Strava export", () => {
  const segs = segmentsOrExplain(doc("strava.gpx"));
  assert.deepEqual(segs, [[
    [37.257942, -122.121018],
    [37.25794, -122.121007],
    [37.257938, -122.121],
    [37.257933, -122.120991],
    [37.257925, -122.120982],
    [37.257917, -122.120971],
    [37.257912, -122.120962],
    [37.257903, -122.120951],
  ]]);
});

// --- the geometry those coordinates produce ---

// Coordinates above are exact — Number() on a decimal string is deterministic. The framing
// is not asserted bit-for-bit: it runs through log/tan/atan, whose last ulp is not pinned by
// the spec. mm-per-km IS pinned exactly, because the step that produces it is worth
// regressing on.
//
// All three land on MM_PER_KM_MAX, and that is the fixtures' doing, not the fitter's: each is
// trimmed to 8 track points, spanning tens of meters rather than the kilometers the real
// export covered, so every one of them asks for a scale past the input's ceiling and gets
// clamped. Their unclamped asks were 1900, 5800 and 31000 mm/km. The 2-significant-figure
// flooring underneath is covered by gpx.test.mjs, whose trail fits well inside the range.
const FRAMINGS = [
  { file: "alltrails.gpx", center: [48.95168500189638, -121.63543], mmPerKm: MM_PER_KM_MAX },
  { file: "garmin-connect.gpx", center: [48.71770698597514, -121.14509384147823], mmPerKm: MM_PER_KM_MAX },
  { file: "strava.gpx", center: [37.257922500002536, -122.1209845], mmPerKm: MM_PER_KM_MAX },
];

for (const { file, center, mmPerKm } of FRAMINGS) {
  test(`golden: fitTile frames ${file}`, () => {
    const segs = segmentsOrExplain(doc(file));
    const fit = fitTile(segs, TILE);
    assert.ok(Math.abs(fit.center[0] - center[0]) < 1e-9, `lat ${fit.center[0]} vs ${center[0]}`);
    assert.ok(Math.abs(fit.center[1] - center[1]) < 1e-9, `lon ${fit.center[1]} vs ${center[1]}`);
    assert.ok(Math.abs(1e6 / fit.scale - mmPerKm) < 1e-6, `${1e6 / fit.scale} mm/km vs ${mmPerKm}`);
    // The postcondition, on real coordinates rather than a constructed trail.
    assert.equal(clippedFraction(segs, { ...fit, ...TILE }), 0);
  });
}

// --- files that must be refused, and the exact words the user reads ---

// The messages are the product here, not an implementation detail: each completes the
// caller's "Could not import <file>: " and takes the file as its subject. Pinned literally
// so a reword is a deliberate act.
const REFUSED = [
  { file: "bad-kml-renamed.gpx", message: "it looks like a <kml> document, not GPX" },
  { file: "bad-route-only.gpx", message: "it holds a route, not a recorded track" },
  { file: "bad-waypoints-only.gpx", message: "it has no track points" },
];

for (const { file, message } of REFUSED) {
  test(`golden: ${file} is refused, by name`, () => {
    assert.deepEqual(segmentsFromDocument(doc(file)), [], "the walk itself finds nothing");
    assert.throws(() => segmentsOrExplain(doc(file)), (/** @type {Error} */ err) => {
      assert.equal(err.message, message);
      return true;
    });
  });
}

test("golden: a truncated download is not well-formed XML", () => {
  // The fourth refusal — "it is not valid XML" — is raised in parseGpxText, which needs a
  // browser DOMParser, so it cannot run here. What IS checkable in Node is the property the
  // message rests on: this file does not parse. The two DOMs disagree only on how they say
  // so — xmldom throws, Chrome returns a document containing <parsererror>.
  assert.throws(() => new DOMParser().parseFromString(read("bad-truncated.gpx"), "application/xml"));
});

test("golden: every refused fixture is refused for its own reason", () => {
  // Guards against the messages collapsing back into one generic sentence, which is the
  // regression this whole group exists to catch.
  const messages = REFUSED.map((r) => r.message);
  assert.equal(new Set(messages).size, messages.length);
});

// --- the ribbon a real export bakes ---

test("strava.gpx stamps a corridor and bakes a watertight cord", () => {
  const segs = segmentsFromDocument(doc("strava.gpx"));
  // Explicit 1:25000 framing on the trail's first point, not fitTile: the fixture is trimmed
  // to 8 points, so a fitted tile spans under 2px at z15 and planTile rejects it before a plan
  // ever exists. 1:25000 also lands the stamp at dx = 0.152 mm, a representative export pitch —
  // the regime worth regressing on, rather than the sub-2px one fitTile can't even produce.
  const plan = planTile({ center: segs[0][0], scale: 25000, tileWidthMm: 200, base: 3, exag: 1 },
    { maxTiles: 300 });
  // Synthetic relief: this pins trail geometry, not terrain, and a real DEM needs the network.
  const grid = new Float32Array(plan.gw * plan.gh);
  for (let r = 0; r < plan.gh; r++)
    for (let c = 0; c < plan.gw; c++) grid[r * plan.gw + c] = 200 + 30 * Math.sin(c / 11) + 20 * Math.cos(r / 9);

  const halfW = halfWFor(1.6, plan.dx);
  const stations = trailToPrintMm(segs, plan).map((p) => resample(p, halfW * DS_FACTOR));
  const { cells, count } = corridorMask(stations, plan, halfW, undefined);
  // Pinned exact rather than `> 0`: stable across runs (grid, trail and pitch are all fixed),
  // and it moves if the stamping ever changes — verified by widening the requested cord from
  // 1.6 to 2.0 mm, which shifts this count from 87 to 137.
  assert.equal(count, 87);

  const rib = buildDrape(grid, plan.gw, plan.gh, plan.span, cells,
    { dx: plan.dx, dy: plan.dy, mmPerM: plan.mmPerM, emin: 150, exag: 1 }, 0.6);
  assert.ok(rib);
  assert.ok(checkWatertight(rib).closed);
  assert.ok(signedVolume(rib) > 0);
});
