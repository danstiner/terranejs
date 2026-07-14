import { test } from "node:test";
import assert from "node:assert/strict";
import { ThreeMFWriter } from "../js/threeMF.js";

const mesh = { // one degenerate triangle is enough to exercise the writer
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
};

// The color-change part name must appear in the zip bytes only when changes given.
const asText = (bytes) => new TextDecoder("latin1").decode(bytes);

test("ThreeMFWriter: no color-change part by default", async () => {
  const w = new ThreeMFWriter();
  await w.addObject("t", mesh, 0, 0);
  const bytes = await w.finish();
  assert.ok(!asText(bytes).includes("custom_gcode_per_print_z"));
});

test("ThreeMFWriter: embeds the color-change part when changes are set", async () => {
  const w = new ThreeMFWriter();
  w.setColorChanges([{ z: 6.4, band: 2, color: [0.6, 0.62, 0.38] }]);
  await w.addObject("t", mesh, 0, 0);
  const bytes = await w.finish();
  const text = asText(bytes);
  assert.ok(text.includes("Prusa_Slicer_custom_gcode_per_print_z.xml"));
  assert.ok(text.includes("custom_gcodes_per_layer"));
  assert.ok(text.includes('top_z="6.400"'));
});

test("ThreeMFWriter: setColorChanges([]) embeds no part", async () => {
  const w = new ThreeMFWriter();
  w.setColorChanges([]);
  await w.addObject("t", mesh, 0, 0);
  const bytes = await w.finish();
  const text = asText(bytes);
  assert.ok(!text.includes("Prusa_Slicer_custom_gcode_per_print_z.xml"));
  assert.ok(!text.includes("custom_gcodes_per_layer"));
});
