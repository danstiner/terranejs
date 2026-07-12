import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CELL_CAP, tileSpanPx, cellWindows, cellBbox, cellsBbox, ghostCells, vertexMask,
  insideMin, bakeFlatten,
} from "../js/tiles.js";
import { lonToGlobalX, latToGlobalY } from "../js/tilemath.js";
import { pointInPolygon } from "../js/polyclip.js";

const CENTER = [47.6, -122.3], SCALE = 476190.4762, W = 250; // ~2.1 mm = 1 km

test("cellWindows: adjacent cells share boundary indices; width = span ±1", () => {
  for (const z of [8, 11, 14]) {
    const S = tileSpanPx(CENTER[0], SCALE, W, z);
    const { wins } = cellWindows(CENTER, SCALE, W, [[0, 0], [1, 0], [0, 1]], z);
    const a = wins.get("0,0"), b = wins.get("1,0"), c = wins.get("0,1");
    assert.equal(a.gx0 + a.gw - 1, b.gx0, `z${z}: shared column`);
    assert.equal(a.gy0 + a.gh - 1, c.gy0, `z${z}: shared row`);
    for (const w2 of [a, b, c]) {
      assert.ok(Math.abs(w2.gw - 1 - S) <= 1, `z${z}: width ${w2.gw - 1} vs span ${S}`);
      assert.ok(Math.abs(w2.gh - 1 - S) <= 1, `z${z}: height`);
    }
  }
});

test("cellWindows: union covers exactly the per-cell windows", () => {
  const { wins, union } = cellWindows(CENTER, SCALE, W, [[0, 0], [1, 0], [1, 1]], 11);
  let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
  for (const w2 of wins.values()) {
    gx0 = Math.min(gx0, w2.gx0); gy0 = Math.min(gy0, w2.gy0);
    gx1 = Math.max(gx1, w2.gx0 + w2.gw - 1); gy1 = Math.max(gy1, w2.gy0 + w2.gh - 1);
  }
  assert.deepEqual(union, { gx0, gy0, gw: gx1 - gx0 + 1, gh: gy1 - gy0 + 1 });
});

test("cellWindows: sub-pixel tile throws", () => {
  // z0: span = 1.13 px < 2 for this fixture (z1 is already 2.26 px, meshable)
  assert.throws(() => cellWindows(CENTER, SCALE, W, [[0, 0]], 0), /tile smaller/);
});

test("cellBbox: origin centered on center; +x neighbor abuts in lon", () => {
  const [s0, w0, n0, e0] = cellBbox(CENTER, SCALE, W, [0, 0]);
  assert.ok(Math.abs((w0 + e0) / 2 - CENTER[1]) < 1e-9, "lon centered");
  assert.ok(s0 < CENTER[0] && n0 > CENTER[0], "lat straddles center");
  const [, w1] = cellBbox(CENTER, SCALE, W, [1, 0]);
  assert.ok(Math.abs(w1 - e0) < 1e-9, "abuts exactly");
});

test("ghostCells: 4-neighborhood minus selection", () => {
  assert.deepEqual(new Set(ghostCells([[0, 0]]).map(String)),
    new Set([[1, 0], [-1, 0], [0, 1], [0, -1]].map(String)));
  const g = ghostCells([[0, 0], [1, 0]]);
  assert.equal(g.length, 6);
  for (const [i, j] of g) assert.ok(!(j === 0 && (i === 0 || i === 1)), "no selected cell is a ghost");
});

test("cellsBbox: envelope of per-cell bboxes", () => {
  const cells = [[0, 0], [2, -1]];
  const bbs = cells.map((c) => cellBbox(CENTER, SCALE, W, c));
  const want = [Math.min(bbs[0][0], bbs[1][0]), Math.min(bbs[0][1], bbs[1][1]),
    Math.max(bbs[0][2], bbs[1][2]), Math.max(bbs[0][3], bbs[1][3])];
  assert.deepEqual(cellsBbox(CENTER, SCALE, W, cells), want);
});

test("vertexMask: half-plane ≈ half, full cover = all", () => {
  const tb = [47.0, -122.0, 47.2, -121.8];
  const gw = 21, gh = 21;
  const full = vertexMask([[46.9, -122.1], [46.9, -121.7], [47.3, -121.7], [47.3, -122.1]], tb, gw, gh);
  assert.equal(full.reduce((a, b) => a + b, 0), gw * gh);
  const half = vertexMask([[46.9, -121.9], [46.9, -121.7], [47.3, -121.7], [47.3, -121.9]], tb, gw, gh);
  const frac = half.reduce((a, b) => a + b, 0) / (gw * gh);
  assert.ok(frac > 0.4 && frac < 0.6, `half-plane frac ${frac}`);
});

test("CELL_CAP is 64", () => assert.equal(CELL_CAP, 64));

test("cellBbox and cellWindows agree within quantization (0.5 px)", () => {
  for (const z of [8, 14]) {
    const { wins } = cellWindows(CENTER, SCALE, W, [[0, 0]], z);
    const w2 = wins.get("0,0");
    const [s, w, n, e] = cellBbox(CENTER, SCALE, W, [0, 0]);
    assert.ok(Math.abs(w2.gx0 - lonToGlobalX(w, z)) <= 0.5 + 1e-6, `z${z} west`);
    assert.ok(Math.abs(w2.gx0 + w2.gw - 1 - lonToGlobalX(e, z)) <= 0.5 + 1e-6, `z${z} east`);
    assert.ok(Math.abs(w2.gy0 - latToGlobalY(n, z)) <= 0.5 + 1e-6, `z${z} north`);
    assert.ok(Math.abs(w2.gy0 + w2.gh - 1 - latToGlobalY(s, z)) <= 0.5 + 1e-6, `z${z} south`);
  }
});

test("bakeFlatten: outside -> inside min, inside untouched", () => {
  const gw = 21, gh = 21, tb = [47.0, -122.0, 47.2, -121.8];
  const poly = [[46.9, -121.9], [46.9, -121.7], [47.3, -121.7], [47.3, -121.9]]; // east half
  const grid = Float32Array.from({ length: gw * gh }, (_, i) => 100 + (i % gw));
  const m = vertexMask(poly, tb, gw, gh);
  const min = insideMin(grid, m);
  assert.ok(Number.isFinite(min) && min >= 100, `inside min ${min}`);
  const out = bakeFlatten(grid, m, min);
  for (let i = 0; i < m.length; i++) {
    if (m[i]) assert.equal(out[i], grid[i], `inside ${i}`);
    else assert.equal(out[i], min, `outside ${i}`);
  }
  assert.notEqual(out, grid, "copy, not in-place");
});

test("vertexMask scanline matches pointInPolygon exactly", () => {
  const tb = [46.0, -122.0, 47.0, -121.0];
  for (let trial = 0; trial < 30; trial++) {
    const nV = 5 + (trial % 7);
    const ring = Array.from({ length: nV }, (_, i2) => {
      const a = (2 * Math.PI * i2) / nV;
      const rad = 0.2 + 0.35 * Math.abs(Math.sin(trial * 12.9898 + i2 * 78.233));
      return [46.5 + rad * Math.sin(a), -121.5 + rad * Math.cos(a)];
    });
    const gw = 24, gh = 19;
    const mk = vertexMask(ring, tb, gw, gh);
    for (let r = 0; r < gh; r++) {
      const lat = tb[2] - ((tb[2] - tb[0]) * r) / (gh - 1);
      for (let c = 0; c < gw; c++) {
        const lon = tb[1] + ((tb[3] - tb[1]) * c) / (gw - 1);
        assert.equal(mk[r * gw + c], pointInPolygon([lat, lon], ring) ? 1 : 0,
          `trial ${trial} r${r} c${c}`);
      }
    }
  }
});

test("bakeFlatten: Infinity min (no inside land) is a no-op copy", () => {
  const grid = Float32Array.from([1, 2, 3, 4]);
  const out = bakeFlatten(grid, new Uint8Array(4), Infinity);
  assert.deepEqual([...out], [1, 2, 3, 4]);
  assert.notEqual(out, grid);
});

test("seam sharing holds across an 8x8 layout spanning negative indices", () => {
  const cells = [];
  for (let i = -4; i < 4; i++) for (let j = -4; j < 4; j++) cells.push([i, j]);
  const { wins } = cellWindows(CENTER, SCALE, W, cells, 13);
  for (let i = -4; i < 3; i++) for (let j = -4; j < 4; j++) {
    const a = wins.get(`${i},${j}`), b = wins.get(`${i + 1},${j}`);
    assert.equal(a.gx0 + a.gw - 1, b.gx0, `x seam ${i},${j}`);
  }
  for (let i = -4; i < 4; i++) for (let j = -4; j < 3; j++) {
    const a = wins.get(`${i},${j}`), b = wins.get(`${i},${j + 1}`);
    assert.equal(a.gy0 + a.gh - 1, b.gy0, `y seam ${i},${j}`);
  }
});
