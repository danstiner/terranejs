import { test } from "node:test";
import assert from "node:assert/strict";
import { cordHint, trenchHint } from "../src/ui/controls.js";

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

// The hint speaks only about height. Width used to earn a "below this tile's minimum" clause,
// which the sub-lattice cord removed along with the tile-derived minimum itself.
test("cordHint: says nothing about width", () => {
  assert.doesNotMatch(cordHint(0.6, 0.15), /width|minimum/);
});

// Protrusion crosses zero inside the slider's range against a 1 mm cord, so the copy has to
// change voice rather than print a negative "proud" figure.
test("trenchHint names the channel WIDTH and which way the trail sits", () => {
  assert.match(trenchHint(0.6, 1, 1), /1\.20 mm wide channel/);
  assert.match(trenchHint(0.6, 1, 1), /0\.40 mm proud/);
  assert.match(trenchHint(1.5, 1, 1), /0\.50 mm below/);
  assert.match(trenchHint(1, 1, 1), /flush/);
  assert.equal(trenchHint(0, 1, 1), "");
});
