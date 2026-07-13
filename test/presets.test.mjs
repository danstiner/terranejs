import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PRESETS } from "../js/presets.js";
import { lonToGlobalX, latToGlobalY } from "../js/tilemath.js";

const parkBboxes = JSON.parse(
  readFileSync(new URL("./reference/park_bboxes.json", import.meta.url)));

test("preset names are unique (dropdown lookup is by name)", () => {
  const names = PRESETS.map((p) => p.name);
  assert.equal(new Set(names).size, names.length);
});

test("every preset seeds a valid center and scale", () => {
  for (const p of PRESETS) {
    const [lat, lon] = p.center;
    // ±85: Web Mercator's own bound (the lattice is Mercator-uniform, tilemath.js)
    assert.ok(lat > -85 && lat < 85 && lon >= -180 && lon <= 180, `${p.name}: bad center`);
    assert.ok(Number.isFinite(p.scale) && p.scale > 0, `${p.name}: bad scale`);
  }
});

test("park/state presets cover their old outline bbox from the curated center", () => {
  const kmPerPx = (lat) => (Math.cos((lat * Math.PI) / 180) * 40075.016686) / 256;
  for (const [name, [s, w, n, e]] of Object.entries(parkBboxes)) {
    const p = PRESETS.find((x) => x.name === name);
    assert.ok(p, `${name} still exists`);
    const [lat, lon] = p.center;
    const spanPx = ((220 * p.scale) / 1e6) / kmPerPx(lat);
    const cx = lonToGlobalX(lon, 0), cy = latToGlobalY(lat, 0);
    assert.ok(cx - spanPx / 2 <= lonToGlobalX(w, 0) + 1e-9, `${name} west`);
    assert.ok(cx + spanPx / 2 >= lonToGlobalX(e, 0) - 1e-9, `${name} east`);
    assert.ok(cy - spanPx / 2 <= latToGlobalY(n, 0) + 1e-9, `${name} north`);
    assert.ok(cy + spanPx / 2 >= latToGlobalY(s, 0) - 1e-9, `${name} south`);
  }
});
