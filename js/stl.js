// Binary STL encode + test helpers. Triangles are a flat Float32Array, 9 floats
// per triangle (3 vertices × xyz). Matches topotile.write_stl: 80-byte header,
// uint32 count, then per-triangle {normal[3], v0[3], v1[3], v2[3], uint16 attr},
// all little-endian; normal = normalize((v1−v0)×(v2−v0)) in f64, stored f32.
export function encodeBinarySTL(tris) {
  const n = tris.length / 9;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, n, true);
  let o = 84;
  for (let i = 0; i < n; i++) {
    const b = i * 9;
    const ax = tris[b], ay = tris[b + 1], az = tris[b + 2];
    const bx = tris[b + 3], by = tris[b + 4], bz = tris[b + 5];
    const cx = tris[b + 6], cy = tris[b + 7], cz = tris[b + 8];
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true);
    dv.setFloat32(o + 12, ax, true); dv.setFloat32(o + 16, ay, true); dv.setFloat32(o + 20, az, true);
    dv.setFloat32(o + 24, bx, true); dv.setFloat32(o + 28, by, true); dv.setFloat32(o + 32, bz, true);
    dv.setFloat32(o + 36, cx, true); dv.setFloat32(o + 40, cy, true); dv.setFloat32(o + 44, cz, true);
    o += 50; // + 2-byte attribute (left zero)
  }
  return buf;
}

export function parseSTL(buf) {
  const dv = new DataView(buf);
  const n = dv.getUint32(80, true);
  const tris = new Float32Array(n * 9);
  let o = 84;
  for (let i = 0; i < n; i++) {
    o += 12; // skip normal
    for (let k = 0; k < 9; k++) { tris[i * 9 + k] = dv.getFloat32(o, true); o += 4; }
    o += 2; // attr
  }
  return { count: n, tris };
}

// Signed volume via the divergence theorem: Σ v0·(v1×v2)/6. For a closed,
// outward-wound mesh this is the enclosed volume (mm³) — independent of how
// faces are triangulated, so it cross-checks meshes with different topology.
export function signedVolume(tris) {
  let vol = 0;
  for (let i = 0; i < tris.length; i += 9) {
    const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
    const bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5];
    const cx = tris[i + 6], cy = tris[i + 7], cz = tris[i + 8];
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return vol;
}

// Closed-manifold check: quantize vertices, count directed edges. A closed,
// consistently-wound surface has every directed edge u→v matched by exactly one
// v→u. Returns { closed, unmatched }.
export function checkWatertight(tris, eps = 1e-4) {
  const q = (x) => Math.round(x / eps);
  const vid = (x, y, z) => `${q(x)},${q(y)},${q(z)}`;
  const edges = new Map();
  const bump = (a, b) => edges.set(`${a}|${b}`, (edges.get(`${a}|${b}`) || 0) + 1);
  for (let i = 0; i < tris.length; i += 9) {
    const A = vid(tris[i], tris[i + 1], tris[i + 2]);
    const B = vid(tris[i + 3], tris[i + 4], tris[i + 5]);
    const C = vid(tris[i + 6], tris[i + 7], tris[i + 8]);
    bump(A, B); bump(B, C); bump(C, A);
  }
  let unmatched = 0;
  for (const [k, cnt] of edges) {
    const [a, b] = k.split("|");
    const rev = edges.get(`${b}|${a}`) || 0;
    if (cnt !== rev) unmatched++;
  }
  return { closed: unmatched === 0, unmatched };
}
