// Measure the uniform-grid export ladder on real mosaics: per zoom step the
// lattice dims, pixel pitch, solid triangle count, and deflated 3MF size.
// Usage: node measure_export.mjs <base_z9> <base_z10> <base_z11> <base_z12>
import { readFileSync } from "node:fs";
import { cropGrid } from "../js/resample.js";
import { pixelWindow, printPitchMm } from "../js/tilemath.js";
import { buildSolid } from "../js/mesh.js";
import { checkWatertight, signedVolume } from "../js/validate.js";
import { ThreeMFWriter } from "../js/threeMF.js";

const BBOX = [47.084, -122.543, 47.780, -121.066];
const SCALE = 460000, CLAT = (BBOX[0] + BBOX[2]) / 2;
const widthMm = 242.3, heightMm = 168.1;

const load = (base) => {
  const meta = JSON.parse(readFileSync(base + ".json", "utf8"));
  const raw = readFileSync(base + ".bin");
  return { ...meta, data: new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4) };
};

for (const base of process.argv.slice(2)) {
  const mosaic = load(base);
  const z = mosaic.z;
  const win = pixelWindow(BBOX, z);
  const grid = cropGrid(mosaic, win);
  const dx = widthMm / (win.gw - 1), dy = heightMm / (win.gh - 1);
  const mask = new Uint8Array((win.gw - 1) * (win.gh - 1)).fill(1);
  const span = { r0: 0, r1: win.gh - 1, c0: 0, c1: win.gw - 1 };
  let emin = Infinity;
  for (const v of grid) if (v < emin) emin = v;
  const solid = buildSolid(grid, win.gw, win.gh, span, mask,
    { dx, dy, mmPerM: 1000 / SCALE, emin, exag: 1, base: 3 });
  const wt = checkWatertight(solid);
  const writer = new ThreeMFWriter();
  await writer.addObject("tile", solid, 0, 0);
  const bytes = await writer.finish();
  const nt = solid.indices.length / 3;
  console.log([`z${z}`, `${win.gw}x${win.gh}`,
    `${printPitchMm(CLAT, z, SCALE).toFixed(3)} mm/px`,
    `${(nt / 1e6).toFixed(2)}M tris`, `${(bytes.length / 1e6).toFixed(1)} MB`,
    `${(bytes.length / nt).toFixed(1)} B/tri`,
    wt.closed && signedVolume(solid) > 0 ? "closed" : "NOT CLOSED"].join("  "));
}
