import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FIRST_LAYER_MM, waterPause } from "../src/core/slicing.js";

// The four grids measured in PrusaSlicer (docs/specs/slicing.md): a Bora Bora-style
// ocean tile whose color line sits at the top of a 6 mm base.
const GRIDS = [
  { firstLayerMm: 0.20, layerMm: 0.15, pauseZ: 6.200, boundaryZ: 6.125 },
  { firstLayerMm: 0.15, layerMm: 0.15, pauseZ: 6.150, boundaryZ: 6.075 },
  { firstLayerMm: 0.25, layerMm: 0.15, pauseZ: 6.100, boundaryZ: 6.025 },
  { firstLayerMm: 0.20, layerMm: 0.20, pauseZ: 6.200, boundaryZ: 6.100 },
];

test("waterPause: measured grids — the pause is the top of the first land layer", () => {
  for (const { firstLayerMm, layerMm, pauseZ, boundaryZ } of GRIDS) {
    const p = waterPause(6, { layerMm, firstLayerMm });
    assert.ok(Math.abs(p.pauseZ - pauseZ) < 1e-9, `fh ${firstLayerMm} h ${layerMm}: pause ${p.pauseZ} ≠ ${pauseZ}`);
    assert.ok(Math.abs(p.boundaryZ - boundaryZ) < 1e-9, `fh ${firstLayerMm} h ${layerMm}: boundary ${p.boundaryZ} ≠ ${boundaryZ}`);
  }
});

test("waterPause: the first layer height moves the pause a whole layer, the layer height alone does not", () => {
  // 0.25 vs 0.20 over the same 0.15 layers: a different grid offset, a different layer.
  const a = waterPause(6, { layerMm: 0.15, firstLayerMm: 0.2 });
  const b = waterPause(6, { layerMm: 0.15, firstLayerMm: 0.25 });
  assert.ok(Math.abs((a.pauseZ - b.pauseZ) - 0.1) < 1e-9, "the grids disagree by 0.1 mm at this line");
  // ... which is why the old rule (line + one layer) was a full layer late on the second.
  assert.ok(b.pauseZ < 6 + 0.15, "the exact pause beats line + one layer");
});

test("waterPause: the pause clears the line, the boundary lands within one layer above it", () => {
  for (const firstLayerMm of [0.1, 0.15, 0.2, 0.25, 0.3]) {
    for (const layerMm of [0.05, 0.1, 0.15, 0.2, 0.3]) {
      for (let zLine = 3; zLine < 9; zLine += 0.017) {
        const { pauseZ, boundaryZ } = waterPause(zLine, { layerMm, firstLayerMm });
        assert.ok(pauseZ > zLine, `pause ${pauseZ} must sit above the line ${zLine}`);
        assert.ok(boundaryZ > zLine - 1e-9, "the boundary never falls below the line");
        assert.ok(boundaryZ - zLine < layerMm + 1e-9, "nor more than a layer above it");
        assert.ok(pauseZ - boundaryZ > 0, "the pause is the layer's top, the boundary its middle");
        // The pause must name a real layer top, or the slicer assigns it a layer later.
        const k = (pauseZ - firstLayerMm) / layerMm;
        assert.ok(Math.abs(k - Math.round(k)) < 1e-9, `pause ${pauseZ} is not a layer top on fh ${firstLayerMm} h ${layerMm}`);
      }
    }
  }
});

test("waterPause: a line exactly on a slice plane still belongs to that layer", () => {
  // Measured: a surface sitting exactly on the plane prints that layer, so the water
  // reaches it and the pause must clear it. fh 0.15, h 0.15 → slice(41) = 6.075.
  const grid = { layerMm: 0.15, firstLayerMm: 0.15 };
  const on = waterPause(6.075, grid);
  assert.ok(Math.abs(on.pauseZ - 6.3) < 1e-9, "the pause skips past the layer the line touches");
  const under = waterPause(6.075 - 1e-6, grid);
  assert.ok(Math.abs(under.pauseZ - 6.15) < 1e-9, "a hair below it, the layer is land's and the pause is lower");
});

test("waterPause: a line under the first slice plane leaves the whole print land-colored", () => {
  const { pauseZ, boundaryZ } = waterPause(0.05, { layerMm: 0.15, firstLayerMm: 0.2 });
  assert.equal(pauseZ, 0.2, "the swap is the first layer's top — nothing below it to keep blue");
  assert.equal(boundaryZ, 0.1, "and the boundary is that layer's middle");
});

test("waterPause: the default first layer is PrusaSlicer's", () => {
  assert.equal(DEFAULT_FIRST_LAYER_MM, 0.2);
  const d = waterPause(6, { layerMm: 0.15, firstLayerMm: DEFAULT_FIRST_LAYER_MM });
  assert.ok(Math.abs(d.pauseZ - 6.2) < 1e-9);
});
