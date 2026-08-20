#!/usr/bin/env node
// Builds the color-change probe described in docs/specs/slicing.md, and
// prints what each slicer grid should do with it. Thirteen pillars stand on the bed:
// pillar 0 tops out at exactly the color line, each next one a sixth of a layer higher,
// so one slice shows which layer the pause lands on AND which pillar is the first to
// clear the slice plane and print in the second filament.
//
//   node scripts/pause-probe.mjs /tmp/probe.3mf [lineZ] [pauseZ]
import { ThreeMFWriter } from "../src/core/threemf.js";
import { writeFileSync } from "node:fs";

const [, , out, lineArg, pauseArg] = process.argv;
if (!out) {
  console.error("usage: node scripts/pause-probe.mjs <out.3mf> [lineZ=6.0] [pauseZ=lineZ+0.15]");
  process.exit(2);
}
const LINE_Z = Number(lineArg ?? 6.0);
const PAUSE_Z = Number(pauseArg ?? LINE_Z + 0.15);
const STEP = 0.025, N = 13, W = 4, D = 30, GAP = 0.6;

/** One closed box (outward winding) appended to shared arrays.
 * @param {number[]} P @param {number[]} I
 * @param {number} x0 @param {number} x1 @param {number} y0 @param {number} y1 @param {number} z1 */
function box(P, I, x0, x1, y0, y1, z1) {
  const b = P.length / 3;
  for (const [x, y, z] of [[x0,y0,0],[x1,y0,0],[x1,y1,0],[x0,y1,0],[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]]) P.push(x, y, z);
  for (const [a, c, d] of [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]) I.push(b+a, b+c, b+d);
}

const P = /** @type {number[]} */ ([]), I = /** @type {number[]} */ ([]);
for (let i = 0; i < N; i++) box(P, I, i * (W + GAP), i * (W + GAP) + W, 0, D, LINE_Z + i * STEP);

const w = new ThreeMFWriter();
w.setColorChanges([{ z: PAUSE_Z, band: 1, color: [0.36, 0.53, 0.30] }]);
await w.addObject("pause probe", { positions: Float32Array.from(P), indices: Uint32Array.from(I) }, 60, 60);
writeFileSync(out, await w.finish());

// Predicted behavior per grid — see the spec for the three rules these come from.
/** @param {number} fh @param {number} h */
const predict = (fh, h) => {
  const top = (/** @type {number} */ k) => fh + (k - 1) * h;
  const slice = (/** @type {number} */ k) => top(k) - (k === 1 ? fh : h) / 2;
  const ks = Array.from({ length: Math.ceil((LINE_Z + 1) / Math.min(fh, h)) }, (_, i) => i + 1);
  const kChange = ks.find((k) => top(k - 1) < PAUSE_Z - 1e-9 && PAUSE_Z <= top(k) + 1e-4) ?? NaN;
  // Inclusive at the slice plane: a surface exactly on it still prints that layer (measured).
  const seaTop = ks.filter((k) => slice(k) <= LINE_Z + 1e-9).pop() ?? NaN;
  const green = slice(kChange);
  const pillar = Array.from({ length: N }, (_, i) => LINE_Z + i * STEP).findIndex((z) => z >= green - 1e-9);
  return { changeTop: top(kChange), seaTop: top(seaTop), seaKeepsFirst: seaTop < kChange, green, pillar };
};

console.log(`${out}\n  line z ${LINE_Z.toFixed(3)}  pillars ${LINE_Z.toFixed(3)}..${(LINE_Z + (N - 1) * STEP).toFixed(3)} by ${STEP}  pause print_z ${PAUSE_Z.toFixed(3)}\n`);
console.log("  first  layer   swap on layer top   sea's top layer   sea keeps filament 1   2nd filament from z   first such pillar");
for (const [fh, h] of [[0.2, 0.15], [0.15, 0.15], [0.25, 0.15], [0.2, 0.2]]) {
  const r = predict(fh, h);
  console.log(`  ${fh.toFixed(2)}   ${h.toFixed(2)}        ${r.changeTop.toFixed(3)} mm            ${r.seaTop.toFixed(3)} mm             ${r.seaKeepsFirst ? "yes" : "NO "}              >= ${r.green.toFixed(3)} mm        #${r.pillar} (${(LINE_Z + r.pillar * STEP).toFixed(3)} mm)`);
}
