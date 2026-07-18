import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CELL_CAP, tileSpanPx, cellWindows, cellBbox, cellsBbox, ghostCells,
  footprintPx, cellRingLatLon, pruneToOrigin, connectedToOrigin,
  footprintCellMaskPx, pointInPolygon,
} from "../src/core/layout.js";
import { lonToGlobalX, latToGlobalY } from "../src/core/tilemath.js";

/**
 * @typedef {import("../src/core/types.js").LatLon} LatLon
 * @typedef {import("../src/core/types.js").Cell} Cell
 * @typedef {import("../src/core/types.js").Window} Window
 * @typedef {import("../src/core/types.js").Shape} Shape
 */

const CENTER = /** @type {LatLon} */ ([47.6, -122.3]), SCALE = 476190.4762, W = 250; // ~2.1 mm = 1 km

test("cellWindows: adjacent cells share boundary indices; width = span ±1", () => {
  for (const z of [8, 11, 14]) {
    const S = tileSpanPx(CENTER[0], SCALE, W, z);
    const { wins } = cellWindows(CENTER, SCALE, W, /** @type {Cell[]} */ ([[0, 0], [1, 0], [0, 1]]), z);
    const a = /** @type {Window} */ (wins.get("0,0")), b = /** @type {Window} */ (wins.get("1,0")), c = /** @type {Window} */ (wins.get("0,1"));
    assert.equal(a.gx0 + a.gw - 1, b.gx0, `z${z}: shared column`);
    assert.equal(a.gy0 + a.gh - 1, c.gy0, `z${z}: shared row`);
    for (const w2 of [a, b, c]) {
      assert.ok(Math.abs(w2.gw - 1 - S) <= 1, `z${z}: width ${w2.gw - 1} vs span ${S}`);
      assert.ok(Math.abs(w2.gh - 1 - S) <= 1, `z${z}: height`);
    }
  }
});

test("cellWindows: union covers exactly the per-cell windows", () => {
  const { wins, union } = cellWindows(CENTER, SCALE, W, /** @type {Cell[]} */ ([[0, 0], [1, 0], [1, 1]]), 11);
  let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
  for (const w2 of wins.values()) {
    gx0 = Math.min(gx0, w2.gx0); gy0 = Math.min(gy0, w2.gy0);
    gx1 = Math.max(gx1, w2.gx0 + w2.gw - 1); gy1 = Math.max(gy1, w2.gy0 + w2.gh - 1);
  }
  assert.deepEqual(union, { gx0, gy0, gw: gx1 - gx0 + 1, gh: gy1 - gy0 + 1 });
});

test("cellWindows: sub-pixel tile throws", () => {
  // z0: span = 1.13 px < 2 for this fixture (z1 is already 2.26 px, meshable)
  assert.throws(() => cellWindows(CENTER, SCALE, W, /** @type {Cell[]} */ ([[0, 0]]), 0), /tile smaller/);
});

test("cellBbox: origin centered on center; +x neighbor abuts in lon", () => {
  const [s0, w0, n0, e0] = cellBbox(CENTER, SCALE, W, [0, 0]);
  assert.ok(Math.abs((w0 + e0) / 2 - CENTER[1]) < 1e-9, "lon centered");
  assert.ok(s0 < CENTER[0] && n0 > CENTER[0], "lat straddles center");
  const [, w1] = cellBbox(CENTER, SCALE, W, [1, 0]);
  assert.ok(Math.abs(w1 - e0) < 1e-9, "abuts exactly");
});

test("ghostCells: 4-neighborhood minus selection", () => {
  assert.deepEqual(new Set(ghostCells(/** @type {Cell[]} */ ([[0, 0]])).map(String)),
    new Set([[1, 0], [-1, 0], [0, 1], [0, -1]].map(String)));
  const g = ghostCells(/** @type {Cell[]} */ ([[0, 0], [1, 0]]));
  assert.equal(g.length, 6);
  for (const [i, j] of g) assert.ok(!(j === 0 && (i === 0 || i === 1)), "no selected cell is a ghost");
});

test("cellsBbox: envelope of per-cell bboxes", () => {
  const cells = /** @type {Cell[]} */ ([[0, 0], [2, -1]]);
  const bbs = cells.map((c) => cellBbox(CENTER, SCALE, W, c));
  const want = [Math.min(bbs[0][0], bbs[1][0]), Math.min(bbs[0][1], bbs[1][1]),
    Math.max(bbs[0][2], bbs[1][2]), Math.max(bbs[0][3], bbs[1][3])];
  assert.deepEqual(cellsBbox(CENTER, SCALE, W, cells), want);
});

test("CELL_CAP is 64", () => assert.equal(CELL_CAP, 64));

test("cellBbox and cellWindows agree within quantization (0.5 px)", () => {
  for (const z of [8, 14]) {
    const { wins } = cellWindows(CENTER, SCALE, W, /** @type {Cell[]} */ ([[0, 0]]), z);
    const w2 = /** @type {Window} */ (wins.get("0,0"));
    const [s, w, n, e] = cellBbox(CENTER, SCALE, W, [0, 0]);
    assert.ok(Math.abs(w2.gx0 - lonToGlobalX(w, z)) <= 0.5 + 1e-6, `z${z} west`);
    assert.ok(Math.abs(w2.gx0 + w2.gw - 1 - lonToGlobalX(e, z)) <= 0.5 + 1e-6, `z${z} east`);
    assert.ok(Math.abs(w2.gy0 - latToGlobalY(n, z)) <= 0.5 + 1e-6, `z${z} north`);
    assert.ok(Math.abs(w2.gy0 + w2.gh - 1 - latToGlobalY(s, z)) <= 0.5 + 1e-6, `z${z} south`);
  }
});

test("seam sharing holds across an 8x8 layout spanning negative indices", () => {
  const cells = /** @type {Cell[]} */ ([]);
  for (let i = -4; i < 4; i++) for (let j = -4; j < 4; j++) cells.push([i, j]);
  const { wins } = cellWindows(CENTER, SCALE, W, cells, 13);
  for (let i = -4; i < 3; i++) for (let j = -4; j < 4; j++) {
    const a = /** @type {Window} */ (wins.get(`${i},${j}`)), b = /** @type {Window} */ (wins.get(`${i + 1},${j}`));
    assert.equal(a.gx0 + a.gw - 1, b.gx0, `x seam ${i},${j}`);
  }
  for (let i = -4; i < 4; i++) for (let j = -4; j < 3; j++) {
    const a = /** @type {Window} */ (wins.get(`${i},${j}`)), b = /** @type {Window} */ (wins.get(`${i},${j + 1}`));
    assert.equal(a.gy0 + a.gh - 1, b.gy0, `y seam ${i},${j}`);
  }
});

test("hex: shared footprint vertices are bit-identical across all 6 neighbors", () => {
  for (const z of [8, 13]) {
    for (const [dq, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]]) {
      const a = /** @type {[number,number][]} */ (footprintPx(CENTER, SCALE, W, [0, 0], z, "hex"));
      const b = /** @type {[number,number][]} */ (footprintPx(CENTER, SCALE, W, [dq, dr], z, "hex"));
      let shared = 0;
      for (const [ax, ay] of a) {
        for (const [bx, by] of b) {
          if (Object.is(ax, bx) && Object.is(ay, by)) shared++;
        }
      }
      assert.equal(shared, 2, `z${z} dir ${dq},${dr}: exactly the 2 edge endpoints, bit-identical`);
    }
  }
});

test("hex windows: bbox of the footprint, union covers, sane extents", () => {
  const S = tileSpanPx(CENTER[0], SCALE, W, 11);
  const cells = /** @type {Cell[]} */ ([[0, 0], [1, 0], [0, 1], [1, -1]]);
  const { wins, union } = cellWindows(CENTER, SCALE, W, cells, 11, "hex");
  for (const cell of cells) {
    const w2 = /** @type {Window} */ (wins.get(`${cell[0]},${cell[1]}`));
    assert.ok(Math.abs(w2.gw - 1 - S) <= 1, `width ${w2.gw - 1} vs ${S}`);
    assert.ok(Math.abs(w2.gh - 1 - S * Math.sqrt(3) / 2) <= 1, `height ${w2.gh - 1}`);
    assert.ok(w2.gx0 >= union.gx0 && w2.gy0 >= union.gy0, "inside union");
    assert.ok(w2.gx0 + w2.gw <= union.gx0 + union.gw && w2.gy0 + w2.gh <= union.gy0 + union.gh, "inside union hi");
  }
});

test("ghostCells by shape", () => {
  assert.equal(ghostCells(/** @type {Cell[]} */ ([[0, 0]]), "hex").length, 6);
  const two = ghostCells(/** @type {Cell[]} */ ([[0, 0], [1, 0]]), "hex");
  assert.equal(two.length, 8, "2 adjacent hexes -> 8 distinct ghosts");
  assert.deepEqual(ghostCells(/** @type {Cell[]} */ ([[0, 0]]), "circle"), []);
  assert.equal(ghostCells(/** @type {Cell[]} */ ([[0, 0]])).length, 4, "square default unchanged");
});

test("cellRingLatLon: vert counts and containment of the cell center", () => {
  const hex = cellRingLatLon(CENTER, SCALE, W, [0, 0], "hex");
  const cir = cellRingLatLon(CENTER, SCALE, W, [0, 0], "circle");
  const sq = cellRingLatLon(CENTER, SCALE, W, [0, 0], "square");
  assert.equal(hex.length, 6);
  assert.equal(cir.length, 64);
  assert.equal(sq.length, 4);
  for (const ring of [hex, cir, sq]) {
    const lat = ring.reduce((a, p) => a + p[0], 0) / ring.length;
    const lon = ring.reduce((a, p) => a + p[1], 0) / ring.length;
    assert.ok(Math.abs(lat - CENTER[0]) < 0.02 && Math.abs(lon - CENTER[1]) < 0.02, "centroid near center");
  }
});

test("pruneToOrigin drops cells the new adjacency disconnects", () => {
  assert.deepEqual(pruneToOrigin(/** @type {Cell[]} */ ([[0, 0], [1, -1]]), "square"), [[0, 0]]);
  assert.deepEqual(pruneToOrigin(/** @type {Cell[]} */ ([[0, 0], [1, -1]]), "hex"), [[0, 0], [1, -1]]);
  assert.equal(connectedToOrigin(/** @type {Cell[]} */ ([[0, 0], [1, -1]]), "hex"), true);
  assert.equal(connectedToOrigin(/** @type {Cell[]} */ ([[0, 0], [1, -1]]), "square"), false);
});

test("hex footprint: absolute vertex positions, order, and edge length", () => {
  const z = 11;
  const S = tileSpanPx(CENTER[0], SCALE, W, z);
  const gxC = lonToGlobalX(CENTER[1], z), gyC = latToGlobalY(CENTER[0], z);
  const v = /** @type {[number,number][]} */ (footprintPx(CENTER, SCALE, W, [0, 0], z, "hex"));
  const want = [[2, 0], [1, 1], [-1, 1], [-2, 0], [-1, -1], [1, -1]]
    .map(([m, n2]) => [gxC + (m * S) / 4, gyC + (n2 * Math.sqrt(3) * S) / 4]);
  for (let k2 = 0; k2 < 6; k2++) {
    assert.ok(Math.hypot(v[k2][0] - want[k2][0], v[k2][1] - want[k2][1]) < 1e-9, `k${k2} position`);
    const nx = v[(k2 + 1) % 6];
    assert.ok(Math.abs(Math.hypot(nx[0] - v[k2][0], nx[1] - v[k2][1]) - S / 2) < 1e-9, `edge ${k2} length S/2`);
  }
});

test("footprintCellMaskPx: mask area matches the analytic footprint", () => {
  for (const z of [10, 12]) {
    for (const [shape, areaF] of /** @type {Array<[Shape, number]>} */ ([["hex", (3 * Math.sqrt(3)) / 8], ["circle", Math.PI / 4]])) {
      const S = tileSpanPx(CENTER[0], SCALE, W, z);
      const { wins } = cellWindows(CENTER, SCALE, W, /** @type {Cell[]} */ ([[0, 0]]), z, shape);
      const win = /** @type {Window} */ (wins.get("0,0"));
      const ring = /** @type {[number,number][]} */ (footprintPx(CENTER, SCALE, W, [0, 0], z, shape));
      const mask = footprintCellMaskPx(ring, win.gw, win.gh, win.gx0, win.gy0);
      const area = mask.reduce((a, b) => a + b, 0);
      const want = areaF * S * S;
      assert.ok(Math.abs(area - want) / want < 0.02, `${shape} z${z}: ${area} vs ${want}`);
    }
  }
});

test("hex stair masks: adjacent tiles never double-claim a global cell", () => {
  let checked = 0;
  for (const [dq, dr] of [[1, 0], [0, 1], [1, -1]]) {
    for (const z of [10, 12]) {
      const cells = /** @type {Cell[]} */ ([[0, 0], [dq, dr]]);
      let wins;
      try { ({ wins } = cellWindows(CENTER, SCALE, W, cells, z, "hex")); } catch { continue; }
      const [wa, wb] = cells.map((c2) => /** @type {Window} */ (wins.get(`${c2[0]},${c2[1]}`)));
      const [ra, rb] = cells.map((c2) => /** @type {[number,number][]} */ (footprintPx(CENTER, SCALE, W, c2, z, "hex")));
      const [ma, mb] = /** @type {Array<[Window, [number,number][]]>} */ ([[wa, ra], [wb, rb]]).map(([w2, r2]) =>
        footprintCellMaskPx(r2, w2.gw, w2.gh, w2.gx0, w2.gy0));
      const ox0 = Math.max(wa.gx0, wb.gx0), ox1 = Math.min(wa.gx0 + wa.gw - 1, wb.gx0 + wb.gw - 1);
      const oy0 = Math.max(wa.gy0, wb.gy0), oy1 = Math.min(wa.gy0 + wa.gh - 1, wb.gy0 + wb.gh - 1);
      let both = 0, gaps = 0, cellsSeen = 0;
      for (let gy = oy0; gy < oy1; gy++) {
        for (let gx = ox0; gx < ox1; gx++) {
          const inA = ma[(gy - wa.gy0) * (wa.gw - 1) + (gx - wa.gx0)];
          const inB = mb[(gy - wb.gy0) * (wb.gw - 1) + (gx - wb.gx0)];
          if (inA && inB) both++;
          // gap = cell inside a footprint per the reference test but unclaimed
          if (!inA && !inB) {
            const ctr = /** @type {[number, number]} */ ([gx + 0.5, gy + 0.5]);
            if (pointInPolygon(ctr, ra) || pointInPolygon(ctr, rb)) gaps++;
          }
          cellsSeen++;
        }
      }
      if (dq === 0) {
        // horizontal shared edge: tight-bbox windows abut at a single vertex
        // row, so the cell overlap is empty — double-claim impossible
        assert.equal(cellsSeen, 0, `direction ${dq},${dr} z${z}: windows abut`);
        assert.equal(wa.gy0 + wa.gh - 1, wb.gy0, `direction ${dq},${dr} z${z}: shared vertex row`);
      } else {
        assert.ok(cellsSeen > 100, `direction ${dq},${dr} z${z}: overlap region non-trivial`);
      }
      assert.equal(both, 0, `direction ${dq},${dr} z${z}: ${both} double-claimed cells`);
      assert.equal(gaps, 0, `direction ${dq},${dr} z${z}: ${gaps} unclaimed footprint cells`);
      checked++;
    }
  }
  assert.ok(checked >= 5, `enough combos ran (${checked})`);
});

// hex/circle "watertight solid" tests deferred to PR4 (need mesh.js + validate.js).

test("pointInPolygon: square", () => {
  const sq = /** @type {Array<[number, number]>} */ ([[0, 0], [0, 10], [10, 10], [10, 0]]);
  assert.ok(pointInPolygon([5, 5], sq));
  assert.ok(!pointInPolygon([-1, 5], sq));
  assert.ok(!pointInPolygon([5, 20], sq));
});

test("hex windows sit consistently around their footprint centers (placement invariant)", () => {
  for (const z of [8, 11, 14]) {
    const S = tileSpanPx(CENTER[0], SCALE, W, z);
    const cells = /** @type {Cell[]} */ ([[0, 0], [1, 0], [1, -1], [-2, 3], [10, -4]]);
    const { wins } = cellWindows(CENTER, SCALE, W, cells, z, "hex");
    for (const [q, r] of cells) {
      const ring = /** @type {[number,number][]} */ (footprintPx(CENTER, SCALE, W, [q, r], z, "hex"));
      const cx = (ring[0][0] + ring[3][0]) / 2, cy = (ring[0][1] + ring[3][1]) / 2;
      const w2 = /** @type {Window} */ (wins.get(`${q},${r}`));
      assert.ok(Math.abs(w2.gx0 - (cx - S / 2)) <= 0.5 + 1e-9, `x origin vs center - S/2 (${q},${r} z${z})`);
      assert.ok(Math.abs(w2.gy0 - (cy - (Math.sqrt(3) / 4) * S)) <= 0.5 + 1e-9, `y origin (${q},${r} z${z})`);
    }
  }
});
