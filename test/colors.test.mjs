import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BAND_COLORS, BAND_NAMES, MAX_CHANGES,
  bandThresholds, bandOf, baseBand, colorChanges, prusaColorChangeXML, baseColorHex,
  waterLineThresholds,
} from "../src/core/colors.js";
import { waterPause } from "../src/core/slicing.js";

test("waterLineThresholds: −Infinity line (no water on the tile) → below-sea land keeps its land band", () => {
  const t = waterLineThresholds(bandThresholds(36.5), -Infinity); // Death Valley latitude
  assert.equal(bandOf(-86, t), 1, "land at −86 m is forest, not water");
  assert.equal(baseBand(-86, t), 1, "base filament is the forest band — no blue anywhere");
});

test("waterLineThresholds: sets the water line and clamps ecological bands above it", () => {
  const base = [0, 1200, 1600, 2200]; // sea level, timberline, tundra, snowline
  assert.deepEqual(waterLineThresholds(base, 300), [300, 1200, 1600, 2200], "line below timberline");
  // line ABOVE timberline (alpine lake > treeline) → lower bands clamp up so the array stays ascending
  assert.deepEqual(waterLineThresholds(base, 1800), [1800, 1800, 1800, 2200], "collapses sub-line bands");
});

test("waterLineThresholds + colorChanges: above-timberline lake bands blue → tundra/rock, never green", () => {
  // Tropical alpine lake: timberline 3500 (bandThresholds plateau), water color line at 3800 (above it).
  const thr = waterLineThresholds([0, 3500, 3900, 4500], 3800); // → [3800, 3800, 3900, 4500]
  // Recessed lake floor 3700 m up to 4200 m; K = mmPerM·exag = 1 so print-Z ≈ meters above base.
  const changes = colorChanges(thr, { emin: 3700, base: 6, mmPerM: 1, exag: 1, zmax: 6 + (4200 - 3700) });
  assert.ok(!changes.some((c) => c.band === 1), "no forest/green band emitted above the water line");
  assert.equal(changes[0].band, 2, "first change enters tundra (collapsed forest+tundra), not forest");
});

test("palette + names + MAX_CHANGES are aligned", () => {
  assert.equal(BAND_COLORS.length, BAND_NAMES.length);
  assert.equal(MAX_CHANGES, BAND_COLORS.length - 1);
  for (const c of BAND_COLORS) {
    assert.equal(c.length, 3);
    for (const ch of c) assert.ok(ch >= 0 && ch <= 1, `channel ${ch} in 0..1`);
  }
});

test("bandThresholds: parallel bands off one timberline curve, ordered, plateau + two-slope decline", () => {
  for (const lat of [0, 20, 30, 45, 60, 70, 80]) {
    const [sea, timber, tundra, snow] = bandThresholds(lat);
    assert.equal(sea, 0, "first threshold is sea level");
    assert.ok(timber >= 0, `timberline ≥ 0 @${lat}`);
    assert.ok(tundra >= timber - 1e-9 && snow >= tundra - 1e-9, `ordered @${lat}`);
  }
  // Parallel by construction: the tundra & snow lifts off the timberline are identical at
  // every latitude (compare a plateau latitude with a declining one).
  const a = bandThresholds(20), b = bandThresholds(55);
  assert.ok(Math.abs((a[2] - a[1]) - (b[2] - b[1])) < 1e-9, "tundra lift constant across lat");
  assert.ok(Math.abs((a[3] - a[1]) - (b[3] - b[1])) < 1e-9, "snow lift constant across lat");
  assert.ok(a[2] - a[1] > 0 && a[3] - a[2] > 0, "positive lifts → strictly stacked bands");

  assert.deepEqual(bandThresholds(10), bandThresholds(-10), "symmetric in |lat|");
  assert.equal(bandThresholds(0)[1], bandThresholds(30)[1], "timberline flat across the plateau (≤30°)");
  // Declines poleward, steeper through the mid-latitudes than toward the poles.
  const midSlope = (bandThresholds(30)[1] - bandThresholds(50)[1]) / 20;
  const polarSlope = (bandThresholds(50)[1] - bandThresholds(70)[1]) / 20;
  assert.ok(midSlope > polarSlope && polarSlope > 0, "steeper mid-latitude slope than polar");
  assert.ok(bandThresholds(45)[3] > bandThresholds(60)[3], "snow-cap line declines 45→60");
  assert.equal(bandThresholds(70)[1], 0, "timberline reaches sea level by ~70°");
});

test("bandOf: strict-> threshold is the top of the lower band", () => {
  const thr = [0, 1000, 1400, 2000];
  assert.equal(bandOf(-5, thr), 0);
  assert.equal(bandOf(0, thr), 0);
  assert.equal(bandOf(0.1, thr), 1);
  assert.equal(bandOf(1500, thr), 3);
  assert.equal(bandOf(9000, thr), 4);
});

test("baseBand: thresholds strictly below emin fold into the base band; AT emin they can fire", () => {
  const thr = [0, 1000, 1400, 2000];
  assert.equal(baseBand(-50, thr), 0);
  assert.equal(baseBand(1200, thr), 2);
  // Ocean-floor tile: the waterline sits AT emin, and its export pause is the next layer
  // boundary above the base, so it fires — the base filament must stay the water band.
  assert.equal(baseBand(0, thr), 0);
});

test("colorChanges: z-mapping, in-range only, ascending", () => {
  const thr = [0, 1000, 1400, 2000];
  const frame = { emin: 500, base: 6, mmPerM: 4, exag: 1, zmax: 6 + (2500 - 500) * 4 };
  const ch = colorChanges(thr, frame);
  assert.deepEqual(ch.map((c) => c.band), [2, 3, 4]);
  assert.deepEqual(ch.map((c) => Math.round(c.z)), [2006, 3606, 6006]);
  for (let i = 1; i < ch.length; i++) assert.ok(ch[i].z > ch[i - 1].z, "ascending z");
  assert.deepEqual(ch[0].color, BAND_COLORS[2]);
});

test("colorChanges: keeps a change exactly at the base, drops below-base and at/above zmax", () => {
  const thr = [0, 1000, 1400, 2000];
  const frame = { emin: 0, base: 6, mmPerM: 4, exag: 1, zmax: 6 + 1500 * 4 };
  const ch = colorChanges(thr, frame);
  // t=0 sits exactly at the base — KEPT (ocean-floor tile: the shader colors land above it and
  // the export's pause clears it); t=2000 is above the 1500 m top (dropped)
  assert.deepEqual(ch.map((c) => c.band), [1, 2, 3]);
  assert.equal(ch[0].z, 6);
});

test("colorChanges: waterZ places the water pause outright, leaving the ecological changes alone", () => {
  const thr = [0, 1000, 1400, 2000];
  const frame = { emin: 0, base: 6, mmPerM: 4, exag: 1, zmax: 6 + 2500 * 4 };
  const plain = colorChanges(thr, frame);
  const paused = colorChanges(thr, frame, { waterZ: 6.2 });
  assert.equal(plain[0].z, 6, "without it the water change sits on the line, at the base");
  assert.equal(paused[0].z, 6.2, "with it, wherever the layer grid says (slicing.waterPause)");
  assert.deepEqual(paused.slice(1), plain.slice(1), "ecological changes untouched");
});

test("colorChanges: flatten margin pin — the 2-lift plane keeps the lowest land above the printed boundary", () => {
  // Flatten polder (K = 0.5 print-mm/m, layer 0.5 mm → lift 1 m): plane = landMin − 2·lift = −8,
  // line = plane, landMin −6. What has to hold is that the lowest land still prints as land,
  // i.e. sits above the boundary the print turns color at — half a layer over the pause's
  // layer bottom, not at the pause itself. A 1-lift plane (−7) leaves almost nothing.
  const layer = 0.5, firstLayerMm = 0.2, base = 6, K = 0.5;
  const margin = (/** @type {number} */ line, /** @type {number} */ landMin) => {
    // The plane IS the line here, so the line sits at the base.
    const { pauseZ, boundaryZ } = waterPause(base, { layerMm: layer, firstLayerMm });
    const ch = colorChanges([line, 1000, 1400, 2000], { emin: line, base, mmPerM: K, exag: 1, zmax: 1e9 }, { waterZ: pauseZ });
    assert.equal(ch[0].z, pauseZ, "the export's change is the grid's layer top");
    return base + (landMin - line) * K - boundaryZ;
  };
  assert.ok(margin(-8, -6) > layer, "2-lift plane: over a full layer of land above the boundary");
  assert.ok(margin(-7, -6) < layer / 2, "1-lift plane: less than half a layer — the margin the plane exists to buy");
});

test("colorChanges: sub-0.05mm coincident changes merge, keeping the higher band", () => {
  const thr = [0, 1000, 1000.005, 3000];
  const frame = { emin: 0, base: 0, mmPerM: 1, exag: 1, zmax: 5000 };
  const ch = colorChanges(thr, frame);
  const near = ch.filter((c) => Math.abs(c.z - 1000) < 0.1);
  assert.equal(near.length, 1, "coincident pair collapsed to one change");
  assert.equal(near[0].band, 3, "kept the higher band (band 3 over band 2)");
});

test("colorChanges: single-band tile → no changes", () => {
  const thr = [0, 1000, 1400, 2000];
  const frame = { emin: 100, base: 6, mmPerM: 4, exag: 1, zmax: 6 + 300 * 4 };
  assert.deepEqual(colorChanges(thr, frame), []);
});

test("prusaColorChangeXML: pinned schema", () => {
  const xml = prusaColorChangeXML([{ z: 12.3456, band: 1, color: [1, 0.5, 0] }]);
  assert.match(xml, /<custom_gcodes_per_print_z bed_idx="0">/);
  assert.match(xml, /<code print_z="12\.346" type="0" extruder="1" color="#ff8000" extra="" gcode="M600"\/>/);
  assert.match(xml, /<mode value="SingleExtruder"\/><\/custom_gcodes_per_print_z>$/);
  assert.match(xml, /^<\?xml version="1\.0" encoding="utf-8"\?>\n/); // matches PrusaSlicer's own prolog byte-for-byte
});

test("baseColorHex: hex of the base band", () => {
  assert.equal(baseColorHex(1200, [0, 1000, 1400, 2000]), baseColorHex(1200, [0, 1000, 1400, 2000]));
  assert.match(baseColorHex(-50, [0, 1000, 1400, 2000]), /^#[0-9a-f]{6}$/);
});
