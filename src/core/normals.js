// Per-vertex normals for an indexed mesh — a headless port of three's
// computeVertexNormals so the bake worker can produce them off the main thread.
// Face normal = (C−B)×(A−B) accumulated (unnormalized, so larger faces weigh
// more) into each of its three vertices, then each vertex normalized. Same
// winding as three, so preview shading is identical to computing it on the GPU
// side. Rendering-only math (no DOM), kept in core to stay node-testable.

/**
 * @param {Float32Array} positions xyz per vertex
 * @param {Uint32Array} indices three vertex ids per triangle
 * @returns {Float32Array} unit normal xyz per vertex (length === positions.length)
 */
export function vertexNormals(positions, indices) {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const cbx = positions[c] - positions[b];
    const cby = positions[c + 1] - positions[b + 1];
    const cbz = positions[c + 2] - positions[b + 2];
    const abx = positions[a] - positions[b];
    const aby = positions[a + 1] - positions[b + 1];
    const abz = positions[a + 2] - positions[b + 2];
    const nx = cby * abz - cbz * aby;
    const ny = cbz * abx - cbx * abz;
    const nz = cbx * aby - cby * abx;
    normals[a] += nx; normals[a + 1] += ny; normals[a + 2] += nz;
    normals[b] += nx; normals[b + 1] += ny; normals[b + 2] += nz;
    normals[c] += nx; normals[c + 1] += ny; normals[c + 2] += nz;
  }
  for (let i = 0; i < normals.length; i += 3) {
    const x = normals[i], y = normals[i + 1], z = normals[i + 2];
    const len = Math.hypot(x, y, z) || 1; // orphan/degenerate → (0,0,0), never NaN
    normals[i] = x / len; normals[i + 1] = y / len; normals[i + 2] = z / len;
  }
  return normals;
}
