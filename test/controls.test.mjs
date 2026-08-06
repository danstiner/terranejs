import { test } from "node:test";
import assert from "node:assert/strict";
import { cordHint } from "../src/ui/controls.js";

test("cordHint: whole multiple of the layer height, no printed tail", () => {
  assert.equal(cordHint(0.6, 0.15), "0.60 mm — 4 layers at 0.15 mm");
});

test("cordHint: truncates to whole layers, names the printed height", () => {
  assert.equal(cordHint(0.6, 0.25), "0.60 mm — 2 layers at 0.25 mm (0.50 mm printed)");
});

// 0.3 / 0.1 === 2.9999999999999996 in floating point — an exact multiple that must
// still floor UP to 3 layers, not down to 2, and must not print a spurious tail from
// 3 * 0.1 landing a float epsilon off 0.3.
test("cordHint: exact multiple survives floating-point division error", () => {
  assert.equal(cordHint(0.3, 0.1), "0.30 mm — 3 layers at 0.1 mm");
});

test("cordHint: height below one layer still reports a layer, not zero", () => {
  assert.equal(cordHint(0.05, 0.6), "0.05 mm — 1 layer at 0.6 mm (0.60 mm printed)");
});

test("cordHint: singular vs plural layer count", () => {
  assert.equal(cordHint(0.15, 0.15), "0.15 mm — 1 layer at 0.15 mm");
  assert.equal(cordHint(0.3, 0.15), "0.30 mm — 2 layers at 0.15 mm");
});

test("cordHint: names the tile minimum when the current width falls below it", () => {
  assert.equal(cordHint(0.6, 0.15, 1.19, 3.58),
    "0.60 mm — 4 layers at 0.15 mm · width 1.19 mm is below this tile's 3.58 mm minimum");
});

test("cordHint: says nothing extra once width clears the minimum", () => {
  assert.equal(cordHint(0.6, 0.15, 2.0, 0.89), "0.60 mm — 4 layers at 0.15 mm");
});

test("cordHint: width exactly at the minimum is not flagged (the guard is >=)", () => {
  assert.equal(cordHint(0.6, 0.15, 3.58, 3.58), "0.60 mm — 4 layers at 0.15 mm");
});

test("cordHint: omits the width clause when the minimum is unknown", () => {
  assert.equal(cordHint(0.6, 0.15), "0.60 mm — 4 layers at 0.15 mm");
});
