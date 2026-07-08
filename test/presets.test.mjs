import { test } from "node:test";
import assert from "node:assert/strict";
import { PRESETS, bboxToPolygon } from "../js/presets.js";
import { bboxExtentMeters, fit, suggestScale } from "../js/fit.js";

const squares = PRESETS.filter((p) => p.group.startsWith("Square Tiles"));

test("preset names are unique (dropdown lookup is by name)", () => {
  const names = PRESETS.map((p) => p.name);
  assert.equal(new Set(names).size, names.length);
});

test("square presets are ground-square within 1%", () => {
  assert.ok(squares.length >= 20, "square group populated");
  for (const p of squares) {
    const { realW, realH } = bboxExtentMeters(p.bbox);
    assert.ok(Math.abs(realW / realH - 1) < 0.01,
      `${p.name}: ${realW.toFixed(0)}×${realH.toFixed(0)} m`);
  }
});

test("square presets fit one square tile at the suggested scale", () => {
  for (const p of squares) {
    const polygon = bboxToPolygon(p.bbox);
    const { realW, realH } = bboxExtentMeters(p.bbox);
    const f = fit({ polygon, scale: suggestScale(realW, realH) });
    assert.equal(f.nx * f.ny, 1, `${p.name}: ${f.nx}×${f.ny} tiles`);
    assert.ok(Math.abs(f.tileWmm / f.tileHmm - 1) < 0.02,
      `${p.name}: tile ${f.tileWmm.toFixed(0)}×${f.tileHmm.toFixed(0)} mm`);
  }
});
