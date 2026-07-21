import { test } from "node:test";
import assert from "node:assert/strict";
import { vertexNormals } from "../src/core/normals.js";
import { buildSolid } from "../src/core/mesh.js";

// A flat quad in the XY plane, both triangles wound CCW seen from +Z, so every
// vertex normal must be exactly +Z. Anchors the winding convention against three.
test("flat quad: all normals are +Z", () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  const n = vertexNormals(positions, indices);
  assert.equal(n.length, positions.length);
  for (let v = 0; v < 4; v++) {
    assert.ok(Math.abs(n[v * 3] - 0) < 1e-6, `nx[${v}]=${n[v * 3]}`);
    assert.ok(Math.abs(n[v * 3 + 1] - 0) < 1e-6, `ny[${v}]=${n[v * 3 + 1]}`);
    assert.ok(Math.abs(n[v * 3 + 2] - 1) < 1e-6, `nz[${v}]=${n[v * 3 + 2]}`);
  }
});

// Degenerate triangle (all three verts coincident) → zero accumulation → the
// normalize step must yield (0,0,0), never NaN.
test("degenerate triangle normalizes to zero, not NaN", () => {
  const positions = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const indices = new Uint32Array([0, 1, 2]);
  const n = vertexNormals(positions, indices);
  for (const c of n) assert.ok(c === 0, `expected 0, got ${c}`);
});

// Real watertight geometry: a flat tile from buildSolid. Every vertex is used by
// a non-degenerate triangle, so all normals are unit length. A strictly-interior
// top vertex touches only the flat top surface — boundary vertices are shared
// with the vertical skirt walls, whose taller normals pull them sideways — so its
// normal is exactly +Z. (Don't tie-break the max-Z vertex by creation order: the
// first-emitted vertex is always a wall-dominated corner.) Guards the
// accumulate/normalize loop on production data without importing three under node.
test("buildSolid flat tile: unit normals, interior top points up", () => {
  const gw = 9, gh = 7, dx = 1, dy = 1;
  const grid = new Float32Array(gw * gh).fill(2);
  const mask = new Uint8Array((gw - 1) * (gh - 1)).fill(1);
  const solid = buildSolid(grid, gw, gh, { r0: 0, r1: gh - 1, c0: 0, c1: gw - 1 }, mask,
    { dx, dy, mmPerM: 1, emin: 0, exag: 1, base: 1 });
  const n = vertexNormals(solid.positions, solid.indices);
  assert.equal(n.length, solid.positions.length);
  const nv = solid.positions.length / 3;
  let maxZ = -Infinity;
  for (let v = 0; v < nv; v++) maxZ = Math.max(maxZ, solid.positions[v * 3 + 2]);
  const w = (gw - 1) * dx, h = (gh - 1) * dy;
  let interiorTop = 0;
  for (let v = 0; v < nv; v++) {
    const px = solid.positions[v * 3], py = solid.positions[v * 3 + 1], pz = solid.positions[v * 3 + 2];
    const nx = n[v * 3], ny = n[v * 3 + 1], nz = n[v * 3 + 2];
    assert.ok(Math.abs(Math.hypot(nx, ny, nz) - 1) < 1e-5, `|n[${v}]|=${Math.hypot(nx, ny, nz)}`);
    // strictly inside the footprint AND on the top plane → only top faces → +Z
    if (Math.abs(pz - maxZ) < 1e-6 && px > 1e-6 && px < w - 1e-6 && py > 1e-6 && py < h - 1e-6) {
      interiorTop++;
      assert.ok(nz > 0.999, `interior top normal z=${nz}`);
    }
  }
  assert.ok(interiorTop > 0, "expected at least one interior top vertex");
});
