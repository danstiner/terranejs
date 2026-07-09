import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGPX, trackBbox } from "../js/gpx.js";

const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="StravaGPX">
 <trk><name>Morning Hike</name>
  <trkseg>
   <trkpt lat="46.7860" lon="-121.7350"><ele>1650.2</ele><time>2026-07-01T15:00:00Z</time></trkpt>
   <trkpt lat="46.7870" lon="-121.7340"><ele>1662.0</ele></trkpt>
   <trkpt lon="-121.7330" lat="46.7881"/>
  </trkseg>
  <trkseg>
   <trkpt lat='46.7900' lon='-121.7300'/>
   <trkpt lat='46.7910' lon='-121.7290'/>
  </trkseg>
 </trk>
</gpx>`;

test("parseGPX: segments, attribute order, quote styles", () => {
  const segs = parseGPX(GPX);
  assert.equal(segs.length, 2);
  assert.deepEqual(segs[0][0], [46.786, -121.735]);
  assert.deepEqual(segs[0][2], [46.7881, -121.733], "lon-before-lat attr order");
  assert.deepEqual(segs[1][1], [46.791, -121.729], "single-quoted attrs");
});

test("parseGPX: route fallback and empty input", () => {
  const rte = `<gpx><rte><rtept lat="10" lon="20"/><rtept lat="11" lon="21"/></rte></gpx>`;
  assert.deepEqual(parseGPX(rte), [[[10, 20], [11, 21]]]);
  assert.deepEqual(parseGPX("<gpx></gpx>"), []);
  assert.deepEqual(parseGPX(`<gpx><trkseg><trkpt lat="1" lon="2"/></trkseg></gpx>`), [],
    "single-point segment dropped");
});

test("parseGPX: two routes become two segments (no phantom bridge)", () => {
  const gpx = `<gpx>` +
    `<rte><rtept lat="10" lon="20"/><rtept lat="11" lon="21"/></rte>` +
    `<rte><rtept lat="30" lon="40"/><rtept lat="31" lon="41"/></rte>` +
    `</gpx>`;
  const segs = parseGPX(gpx);
  assert.equal(segs.length, 2, "one segment per route");
  assert.deepEqual(segs[0], [[10, 20], [11, 21]]);
  assert.deepEqual(segs[1], [[30, 40], [31, 41]]);
});

test("parseGPX: trackless multi-trk yields one segment per trk", () => {
  const gpx = `<gpx>` +
    `<trk><trkpt lat="1" lon="2"/><trkpt lat="3" lon="4"/></trk>` +
    `<trk><trkpt lat="5" lon="6"/><trkpt lat="7" lon="8"/></trk>` +
    `</gpx>`;
  assert.equal(parseGPX(gpx).length, 2);
});

test("trackBbox pads the extent", () => {
  const [s, w, n, e] = trackBbox([[[10, 20], [11, 22]]], 0.1);
  assert.ok(s < 10 && n > 11 && w < 20 && e > 22);
  assert.ok(Math.abs(s - (10 - 0.1)) < 1e-9 && Math.abs(e - (22 + 0.2)) < 1e-9);
});
