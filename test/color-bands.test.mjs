import { test } from "node:test";
import assert from "node:assert/strict";
import { BAND_COLORS, bandThresholds, bandOf, baseBand, colorChanges, prusaColorChangeXML }
  from "../js/color-bands.js";

test("bandThresholds: ascending + correctly ordered at every latitude", () => {
  for (const lat of [-80, -46, 0, 20, 46, 60, 70, 85]) {
    const [sea, tree, tundra, snow] = bandThresholds(lat);
    assert.equal(sea, 0);
    assert.ok(tree >= 0 && snow >= 0, `nonneg @${lat}`);
    assert.ok(tree <= tundra + 1e-9 && tundra <= snow + 1e-9,
      `order @${lat}: ${tree},${tundra},${snow}`);
  }
});

test("bandThresholds: plateau, poleward decline, high-latitude zeros", () => {
  assert.equal(bandThresholds(0)[1], 3800);   // treeline plateau
  assert.equal(bandThresholds(20)[1], 3800);  // still on the ≤30° plateau
  const t46 = bandThresholds(46)[1];
  assert.ok(t46 > 2000 && t46 < 2300, `mid-lat treeline ${t46}`); // ~2280
  assert.equal(bandThresholds(70)[1], 0);     // treeline meets the coast
  assert.equal(bandThresholds(75)[3], 0);     // snowline reaches the pole
  assert.deepEqual(bandThresholds(46), bandThresholds(-46)); // sign-symmetric
});

test("bandOf: strict-> boundaries, indices 0..4", () => {
  const thr = [0, 1000, 1400, 2000];
  assert.equal(bandOf(-5, thr), 0);
  assert.equal(bandOf(0, thr), 0);      // sea level = water
  assert.equal(bandOf(1, thr), 1);      // just above = forest
  assert.equal(bandOf(1000, thr), 1);   // exactly treeline stays forest
  assert.equal(bandOf(1200, thr), 2);   // tundra
  assert.equal(bandOf(1400, thr), 2);   // exactly tundra line stays tundra
  assert.equal(bandOf(1700, thr), 3);   // rock
  assert.equal(bandOf(2000, thr), 3);   // exactly snowline stays rock
  assert.equal(bandOf(2500, thr), 4);   // snow
});

test("baseBand: thresholds at/below emin fold into the base band", () => {
  const thr = [0, 1000, 1400, 2000];
  assert.equal(baseBand(-1.5, thr), 0); // sub-sea (ocean recess) → blue base
  assert.equal(baseBand(0, thr), 1);    // sea-level land → green base, NOT blue
  assert.equal(baseBand(1200, thr), 2); // starts in tundra
});

test("colorChanges: Zt mapping + range filter (emin below sea level)", () => {
  const thr = [0, 1000, 1400, 2000];
  // K = mmPerM*exag = 2; emin=-1 (ocean recess); base=6; zmax huge
  const ch = colorChanges(thr, { emin: -1, base: 6, mmPerM: 1, exag: 2, zmax: 1e9 });
  assert.deepEqual(ch.map((c) => [Math.round(c.z), c.band]),
    [[8, 1], [2008, 2], [2808, 3], [4008, 4]]);
  assert.deepEqual(ch[0].color, BAND_COLORS[1]);
});

test("colorChanges: threshold at/below base and above zmax are dropped", () => {
  const thr = [0, 1000, 1400, 2000];
  // emin=0 → sea-level change lands at z=base (dropped); zmax clips the snowline
  const ch = colorChanges(thr, { emin: 0, base: 6, mmPerM: 1, exag: 2, zmax: 3000 });
  assert.deepEqual(ch.map((c) => [Math.round(c.z), c.band]),
    [[2006, 2], [2806, 3]]); // treeline+tundra kept; snowline z=4006 ≥ zmax dropped
});

test("colorChanges: coincident thresholds keep the HIGHER band (treeline==0)", () => {
  // lat 70: thresholds ≈ [0, 0, 400, 555.6]; emin=-1 so the sea-level change fires
  const thr = bandThresholds(70);
  const ch = colorChanges(thr, { emin: -1, base: 6, mmPerM: 1, exag: 2, zmax: 1e9 });
  // the two coincident t=0 changes collapse to a single tundra (band 2), not green
  assert.equal(ch[0].band, 2);
  assert.deepEqual(ch[0].color, BAND_COLORS[2]);
});

test("bandThresholds: tundra sits +400 m above the treeline when unclamped", () => {
  const [, tree, tundra] = bandThresholds(0);
  assert.equal(tree, 3800);
  assert.equal(tundra, 4200); // 3800 + 400, still below snowline 5000
});

test("colorChanges: high-latitude quad-tie collapses to one top-band change", () => {
  const thr = bandThresholds(80);
  assert.deepEqual(thr, [0, 0, 0, 0]); // ≥75°: all thresholds coincide at 0
  const ch = colorChanges(thr, { emin: -1, base: 6, mmPerM: 1, exag: 2, zmax: 1e9 });
  assert.equal(ch.length, 1);
  assert.equal(ch[0].band, 4); // collapse keeps the highest band (white)
  assert.deepEqual(ch[0].color, BAND_COLORS[4]);
});

test("prusaColorChangeXML: one <code> per change, ColorChange type, hex color, M600", () => {
  const xml = prusaColorChangeXML([
    { z: 6.4, band: 2, color: [0.60, 0.62, 0.38] },
    { z: 9.1, band: 3, color: [0.55, 0.55, 0.55] },
  ]);
  const codes = xml.match(/<code /g) || [];
  assert.equal(codes.length, 2);
  assert.match(xml, /<custom_gcodes_per_print_z bed_idx="0">/); // PrusaSlicer root, no plate
  assert.match(xml, /print_z="6.400"/);
  assert.match(xml, /print_z="9.100"/);
  assert.match(xml, /type="0"/);   // ColorChange
  assert.match(xml, /extra=""/);
  assert.match(xml, /color="#999e61"/); // 0.60,0.62,0.38 → 99 9e 61
  assert.match(xml, /gcode="M600"/);
  assert.match(xml, /<mode value="SingleExtruder"\/>/);
});
