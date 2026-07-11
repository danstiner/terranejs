// Measure the export ladder on a real mosaic: per DETAIL_STEPS tolerance, the
// triangle count, file estimate, facet edge lengths, and normal breaks across
// interior edges. Optional second mosaic (bathymetry zoom) runs the water
// continuity check. Usage: node measure_export.mjs <geoBase> [waterBase]
import { readFileSync } from "node:fs";
import { resampleBilinear, gridRange } from "../js/resample.js";
import { decimate } from "../js/decimate.js";
import { oceanMask, oceanMaskSeeded } from "../js/water.js";

const load = (base) => {
  const meta = JSON.parse(readFileSync(base + ".json", "utf8"));
  const raw = readFileSync(base + ".bin");
  return { ...meta, data: new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4) };
};

// King County defaults (spec scenario): 1:460000, single 242.3×168.1 mm tile
const BBOX = [47.084, -122.543, 47.780, -121.066];
const widthMm = 242.3, heightMm = 168.1;
const gw = 2048, gh = 1421;
const dx = widthMm / (gw - 1), dy = heightMm / (gh - 1);
const K = 1000 / 460000;
const STEPS = [0.1, 0.03, 0.01, 0.003, 0.001]; // DETAIL_STEPS errs (4096 steps: rerun with gw=4096, gh=2842 and a z12 mosaic)

const geo = load(process.argv[2]);
const grid = resampleBilinear(geo, BBOX, gw, gh);
const { min: emin } = gridRange(grid);
const zt = new Float32Array(gw * gh);
for (let i = 0; i < zt.length; i++) zt[i] = (grid[i] - emin) * K;

function stats(coords, triangles) {
  const nt = triangles.length / 3;
  const nx = new Float32Array(nt), ny = new Float32Array(nt), nz = new Float32Array(nt);
  const lens = new Float32Array(nt);
  const zAt = (vi) => zt[coords[2 * vi + 1] * gw + coords[2 * vi]];
  for (let t = 0; t < nt; t++) {
    const a = triangles[3 * t], b = triangles[3 * t + 1], c = triangles[3 * t + 2];
    const ax = coords[2 * a] * dx, ay = coords[2 * a + 1] * dy, az = zAt(a);
    const bx = coords[2 * b] * dx, by = coords[2 * b + 1] * dy, bz = zAt(b);
    const cx = coords[2 * c] * dx, cy = coords[2 * c + 1] * dy, cz = zAt(c);
    let X = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let Y = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let Z = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const L = Math.hypot(X, Y, Z) || 1;
    nx[t] = X / L; ny[t] = Y / L; nz[t] = Z / L;
    lens[t] = Math.max(Math.hypot(bx - ax, by - ay), Math.hypot(cx - bx, cy - by),
      Math.hypot(ax - cx, ay - cy));
  }
  const edgeMap = new Map(), angles = [];
  for (let t = 0; t < nt; t++) {
    for (let e = 0; e < 3; e++) {
      const p = triangles[3 * t + e], q = triangles[3 * t + ((e + 1) % 3)];
      const k = p < q ? p * 16777216 + q : q * 16777216 + p;
      const o = edgeMap.get(k);
      if (o === undefined) edgeMap.set(k, t);
      else {
        const d = Math.min(1, Math.max(-1, nx[t] * nx[o] + ny[t] * ny[o] + nz[t] * nz[o]));
        angles.push(Math.acos(d) * 180 / Math.PI);
      }
    }
  }
  angles.sort((a, b) => a - b);
  const L = Float32Array.from(lens).sort();
  return { edgeP50: L[nt >> 1], edgeP95: L[Math.floor(0.95 * nt)],
    angP50: angles[angles.length >> 1] };
}

console.log("err_mm  tris      3MF_MB~  time_s  edge_p50/p95_mm  normal_p50_deg");
for (const err of STEPS) {
  const t0 = performance.now();
  const { coords, triangles } = decimate(zt, gw, gh, err);
  const dt = ((performance.now() - t0) / 1000).toFixed(1);
  const nt = triangles.length / 3;
  const s = stats(coords, triangles);
  console.log(`${err}  ${String(nt).padStart(9)}  ${(nt * 11 / 1e6).toFixed(1).padStart(6)}  ${dt.padStart(5)}  ${s.edgeP50.toFixed(2)}/${s.edgeP95.toFixed(2)}  ${s.angP50.toFixed(1)}`);
}

if (process.argv[3]) {
  // water continuity: flood the fine grid resampled from BATHYMETRY data,
  // seeded by its own coarse mask — vs the raw geometry grid's ≤0 fraction
  const wtr = load(process.argv[3]);
  const gwC = 1200, ghC = 833;
  const coarse = resampleBilinear(wtr, BBOX, gwC, ghC);
  const oC = oceanMask(coarse, gwC, ghC, 0);
  const fineW = resampleBilinear(wtr, BBOX, gw, gh);
  const seeds = new Uint8Array(gw * gh);
  for (let r = 0; r < gh; r++) {
    const rc = Math.round((r / (gh - 1)) * (ghC - 1));
    for (let c = 0; c < gw; c++) {
      seeds[r * gw + c] = oC[rc * gwC + Math.round((c / (gw - 1)) * (gwC - 1))];
    }
  }
  const oF = oceanMaskSeeded(fineW, gw, gh, seeds);
  const frac = (m) => m.reduce((a, b) => a + b, 0) / m.length;
  let rawNeg = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i] <= 0) rawNeg++;
  console.log(`coarse ocean ${(100 * frac(oC)).toFixed(1)}%  fine flood ${(100 * frac(oF)).toFixed(1)}%  coverage ${(100 * frac(oF) / frac(oC)).toFixed(0)}%`);
  console.log(`geometry grid ≤0 (the old, broken signal): ${(100 * rawNeg / grid.length).toFixed(1)}%`);
}
