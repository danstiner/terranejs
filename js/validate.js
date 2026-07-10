// Indexed-mesh validation. A mesh is { positions: Float32Array (xyz per
// vertex), indices: Uint32Array (3 vertex ids per triangle, outward-wound) }.

// Enclosed volume via the divergence theorem (mm³); outward winding → positive.
export function signedVolume({ positions: P, indices: I }) {
  let vol = 0;
  for (let i = 0; i < I.length; i += 3) {
    const a = 3 * I[i], b = 3 * I[i + 1], c = 3 * I[i + 2];
    vol += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) -
      P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) +
      P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
  }
  return vol;
}

// Closed-manifold check: every directed edge u→v must be matched by exactly one
// v→u. Works on indices directly — no coordinate quantization. Key u*V+v stays
// exact below 2^53 for V up to ~12M vertices (4096-grid tiles ≈ 12M).
export function checkWatertight({ positions: P, indices: I }) {
  const V = P.length / 3;
  const count = new Map();
  const bump = (u, v) => { const k = u * V + v; count.set(k, (count.get(k) || 0) + 1); };
  for (let i = 0; i < I.length; i += 3) {
    bump(I[i], I[i + 1]); bump(I[i + 1], I[i + 2]); bump(I[i + 2], I[i]);
  }
  let unmatched = 0;
  for (const [k, n] of count) {
    const u = Math.floor(k / V), v = k % V;
    if (n !== (count.get(v * V + u) || 0)) unmatched++;
  }
  return { closed: unmatched === 0, unmatched };
}

// Explode to 9-floats/triangle soup (tests and debugging only).
export function toTriangleSoup({ positions: P, indices: I }) {
  const out = new Float32Array(I.length * 3);
  for (let i = 0; i < I.length; i++) {
    out[3 * i] = P[3 * I[i]];
    out[3 * i + 1] = P[3 * I[i] + 1];
    out[3 * i + 2] = P[3 * I[i] + 2];
  }
  return out;
}
