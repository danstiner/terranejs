// Indexed-mesh validation. A Solid is { positions: Float32Array (xyz per
// vertex), indices: Uint32Array (3 vertex ids per triangle, outward-wound) }.

/** @typedef {import("./types.js").Solid} Solid */

// Enclosed volume via the divergence theorem (mm³); outward winding → positive.
/**
 * @param {Solid} solid
 * @returns {number}
 */
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

// Closed-manifold check: the multiset of directed edges u→v must equal the
// multiset of their reverses v→u. Works on indices directly — no coordinate
// quantization, so it catches T-junctions. Keys u*V+v stay exact below 2^53;
// matching walks two sorted Float64Arrays (V8's Map/Set 2^24 cap is under a
// large tile's directed-edge count).
// Edge-parity only: a vertex-pinch (two shells meeting at one vertex) or a fully
// doubled surface still balances. buildSolid's square footprint yields neither,
// so this stays sufficient until arbitrary footprints (masked shapes) land.
/**
 * @param {Solid} solid
 * @returns {{ closed: boolean, unmatched: number }}
 */
export function checkWatertight({ positions: P, indices: I }) {
  const V = P.length / 3;
  const E = I.length; // one directed edge per index slot
  const fwd = new Float64Array(E), rev = new Float64Array(E);
  for (let i = 0; i < E; i += 3) {
    const a = I[i], b = I[i + 1], c = I[i + 2];
    fwd[i] = a * V + b; fwd[i + 1] = b * V + c; fwd[i + 2] = c * V + a;
    rev[i] = b * V + a; rev[i + 1] = c * V + b; rev[i + 2] = a * V + c;
  }
  fwd.sort(); rev.sort();
  let unmatched = 0;
  for (let i = 0; i < E; i++) if (fwd[i] !== rev[i]) unmatched++;
  return { closed: unmatched === 0, unmatched };
}

// Explode to 9-floats/triangle soup (tests and debugging only).
/**
 * @param {Solid} solid
 * @returns {Float32Array}
 */
export function toTriangleSoup({ positions: P, indices: I }) {
  const out = new Float32Array(I.length * 3);
  for (let i = 0; i < I.length; i++) {
    out[3 * i] = P[3 * I[i]];
    out[3 * i + 1] = P[3 * I[i] + 1];
    out[3 * i + 2] = P[3 * I[i] + 2];
  }
  return out;
}
