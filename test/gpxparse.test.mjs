import { test } from "node:test";
import assert from "node:assert/strict";
import { DOMParser } from "@xmldom/xmldom";
import { segmentsFromDocument } from "../src/ui/gpxparse.js";

// Production parses with the browser's DOMParser; this one only has to build a document
// for the walk to read. That is the whole point of the walk being DOM Core only — Node
// ships no XML parser, so without a stand-in this logic could not be tested at all.
// onError silences its console output for the deliberately-broken inputs below.
const parser = new DOMParser({ onError: () => {} });
/** @param {string} xml */
const doc = (xml) => /** @type {any} */ (parser.parseFromString(xml, "application/xml"));

const NS11 = "http://www.topografix.com/GPX/1/1";
const NS10 = "http://www.topografix.com/GPX/1/0";
/** @param {string} body @returns {string} */
const gpx = (body) => `<?xml version="1.0"?><gpx version="1.1" xmlns="${NS11}">${body}</gpx>`;
/** The conforming container for track points: everything else is a rejection test. @param {string} pts */
const track = (pts) => `<trk><trkseg>${pts}</trkseg></trk>`;
/** @param {number} lat @param {number} lon @returns {string} */
const pt = (lat, lon) => `<trkpt lat="${lat}" lon="${lon}"><ele>100</ele></trkpt>`;
/** @param {string} xml */
const segs = (xml) => segmentsFromDocument(doc(xml));

// --- segmentation ---

test("segmentsFromDocument: one segment per <trkseg>, never welded", () => {
  const s = segs(gpx(
    `<trk><name>Hike</name>
       <trkseg>${pt(47.6, -122.3)}${pt(47.61, -122.31)}</trkseg>
       <trkseg>${pt(47.7, -122.4)}${pt(47.71, -122.41)}</trkseg>
     </trk>`));
  assert.equal(s.length, 2);
  assert.deepEqual(s[0], [[47.6, -122.3], [47.61, -122.31]]);
  assert.deepEqual(s[1], [[47.7, -122.4], [47.71, -122.41]]);
});

test("segmentsFromDocument: every <trk> in the document contributes", () => {
  const s = segs(gpx(track(pt(1, 2) + pt(3, 4)) + track(pt(5, 6) + pt(7, 8))));
  assert.equal(s.length, 2);
  assert.deepEqual(s[1], [[5, 6], [7, 8]]);
});

test("segmentsFromDocument: drops segments with fewer than 2 points", () => {
  const s = segs(gpx(`<trk><trkseg>${pt(1, 2)}</trkseg><trkseg>${pt(3, 4)}${pt(5, 6)}</trkseg></trk>`));
  assert.deepEqual(s, [[[3, 4], [5, 6]]]);
});

test("segmentsFromDocument: no track points yields no segments", () => {
  assert.deepEqual(segs(gpx("<metadata><name>empty</name></metadata>")), []);
});

// --- structures GPX does not define, and this deliberately does not read ---

test("segmentsFromDocument: reads only <trk>/<trkseg>/<trkpt>", () => {
  // trkpt is a child of trkseg and nothing else; trkseg is a child of trk and nothing
  // else. Reading these anyway is a guess about files nobody has produced, and it costs
  // more than it looks: a document-wide sweep is what lets the two one-point tracks
  // below merge into a segment spanning a leg nobody walked.
  assert.deepEqual(segs(gpx(`<trkseg>${pt(1, 2)}${pt(3, 4)}</trkseg>`)), [],
    "<trkseg> outside any <trk>");
  assert.deepEqual(segs(gpx(`<trk>${pt(1, 2)}${pt(3, 4)}</trk>`)), [],
    "<trkpt> loose in a <trk>");
  assert.deepEqual(segs(gpx(pt(1, 2) + pt(3, 4))), [],
    "<trkpt> loose in the document");
  assert.deepEqual(segs(gpx(`<trk>${pt(1, 2)}</trk><trk>${pt(50, 60)}</trk>`)), [],
    "two one-point tracks stay two one-point tracks");
});

test("segmentsFromDocument: a planned route is not a recorded track", () => {
  // Valid GPX, but <rtept>s are turn points that can sit kilometers apart. parseGpxText
  // names it in the error rather than reading it as a trail.
  assert.deepEqual(segs(gpx(`<rte><rtept lat="10" lon="20"/><rtept lat="11" lon="21"/></rte>`)), []);
});

// --- reading the XML itself ---

test("segmentsFromDocument: tolerates namespace prefixes on tags", () => {
  const s = segs(`<gpx:gpx xmlns:gpx="${NS11}"><gpx:trk><gpx:trkseg>` +
    `<gpx:trkpt lat="1" lon="2"/><gpx:trkpt lat="3" lon="4"/>` +
    `</gpx:trkseg></gpx:trk></gpx:gpx>`);
  assert.deepEqual(s, [[[1, 2], [3, 4]]]);
});

test("segmentsFromDocument: reads signed and exponent-notation coordinates", () => {
  const s = segs(gpx(track(`<trkpt lat="-33.8688" lon="+151.2093"/><trkpt lat="1e-3" lon="-1.5E2"/>`)));
  assert.deepEqual(s, [[[-33.8688, 151.2093], [0.001, -150]]]);
});

test("segmentsFromDocument: markup quoted inside comments and CDATA is not markup", () => {
  const commented = segs(gpx(track(`${pt(1, 2)}<!-- ${pt(99, 99)} -->${pt(3, 4)}`)));
  assert.deepEqual(commented, [[[1, 2], [3, 4]]], "a commented-out point must not be read back");

  const cdata = segs(gpx(track(`${pt(1, 2)}<desc><![CDATA[${pt(88, 88)}]]></desc>${pt(3, 4)}`)));
  assert.deepEqual(cdata, [[[1, 2], [3, 4]]], "trkpt text inside CDATA must not be read back");
});

test("segmentsFromDocument: attribute-level XML a pattern match cannot read", () => {
  // xsd:decimal permits surrounding whitespace, and a DOM returns the value verbatim
  assert.deepEqual(segs(gpx(track(`<trkpt lat=" 1 " lon=" 2 "/><trkpt lat="3" lon="4"/>`))),
    [[[1, 2], [3, 4]]], "whitespace around a decimal");
  // '>' is legal and unescaped inside a quoted attribute value
  assert.deepEqual(segs(gpx(track(`<trkpt desc="a > b" lat="1" lon="2"/><trkpt lat="3" lon="4"/>`))),
    [[[1, 2], [3, 4]]], "'>' inside an earlier attribute");
  // numeric character reference
  assert.deepEqual(segs(gpx(track(`<trkpt lat="&#49;" lon="2"/><trkpt lat="3" lon="4"/>`))),
    [[[1, 2], [3, 4]]], "numeric character reference");
});

test("segmentsFromDocument: matches on local name, whatever the namespace says", () => {
  const body = track(`<trkpt lat="1" lon="2"/><trkpt lat="3" lon="4"/>`);
  const expected = [[[1, 2], [3, 4]]];
  assert.deepEqual(segs(`<gpx xmlns="${NS11}">${body}</gpx>`), expected, "GPX 1.1");
  assert.deepEqual(segs(`<gpx xmlns="${NS10}">${body}</gpx>`), expected, "GPX 1.0");
  assert.deepEqual(segs(`<gpx>${body}</gpx>`), expected, "no xmlns at all");
  assert.deepEqual(segs(`<gpx xmlns="http://topografix.com/GPX/1/1">${body}</gpx>`), expected,
    "typo'd namespace URI — still unmistakably a track");
});

test("segmentsFromDocument: a point missing lat or lon is skipped, not read as zero", () => {
  // Number(null) is 0, a perfectly finite latitude — absence has to be checked first
  assert.deepEqual(
    segs(gpx(track(`<trkpt lon="2"/><trkpt lat="3" lon="4"/><trkpt lat="5" lon="6"/>`))),
    [[[3, 4], [5, 6]]]);
});
