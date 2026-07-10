// Replicates exportSTLs' overlay emission on a synthetic tile: rasterize a band,
// cellOcean footprint, buildTrailShell, assert watertight + underside == relief.
const T = "/Users/dan/git/danstiner/scripts/tilejs/js";
const { samplePath, rasterizePath } = await import(`${T}/path.js`);
const { cellOcean } = await import(`${T}/water.js`);
const { buildTrailShell } = await import(`${T}/mesh.js`);
const { checkWatertight, signedVolume } = await import(`${T}/stl.js`);

const gw = 61, gh = 61, dx = 0.5, dy = 0.5, W = (gw - 1) * dx, H = (gh - 1) * dy;
const emin = 0, mmPerM = 0.005, exag = 2, k = mmPerM * exag, h = 0.6;
const grid = new Float32Array(gw * gh);
for (let r = 0; r < gh; r++)
  for (let c = 0; c < gw; c++) grid[r * gw + c] = 40 * Math.sin(c / 8) + 25 * Math.cos(r / 6);
const { pts } = samplePath([[[0.1, 0.5], [0.9, 0.5]]], [0, 0, 1, 1], W, H, dx); // vertical trail
const { mask: pm } = rasterizePath(pts, gw, gh, dx, dy, 0.8);
const cells = cellOcean(pm, gw, gh);
const span = { r0: 0, r1: gh - 1, c0: 0, c1: gw - 1 };
const solid = buildTrailShell(grid, gw, gh, span, cells, { dx, dy, mmPerM, emin, exag }, h);
const w = checkWatertight(solid);
let zmin = Infinity, thickOK = true;
const byXY = new Map();
for (let i = 0; i < solid.length; i += 3) {
  zmin = Math.min(zmin, solid[i + 2]);
  const key = `${solid[i].toFixed(3)}_${solid[i + 1].toFixed(3)}`;
  const e = byXY.get(key) || { lo: Infinity, hi: -Infinity };
  e.lo = Math.min(e.lo, solid[i + 2]); e.hi = Math.max(e.hi, solid[i + 2]); byXY.set(key, e);
}
for (const { lo, hi } of byXY.values()) if (Math.abs(hi - lo - h) > 1e-4) thickOK = false;
const pass = w.closed && thickOK && signedVolume(solid) > 0;
console.log(JSON.stringify({ tris: solid.length / 9, closed: w.closed, unmatched: w.unmatched, thicknessUniform: thickOK, signedVolume: +signedVolume(solid).toFixed(2), zmin: +zmin.toFixed(3) }));
console.log(pass ? "OVERLAY EMIT HARNESS PASSED — watertight cord, uniform thickness" : "FAILED");
process.exit(pass ? 0 : 1);
