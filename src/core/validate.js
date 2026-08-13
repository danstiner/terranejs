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
// Edge-parity only: a vertex-pinch (two shells meeting at one vertex) or a fully doubled
// surface still balances. Convex footprints cannot produce a pinch — every mask row is one
// contiguous run centred on the footprint's vertical axis, so adjacent rows always share a
// column (swept across span and sub-pixel phase in test/pipeline.test.mjs). The square, hex
// and circle footprints are all convex, so this stays sufficient. A non-convex or
// multi-island footprint would reopen the gap: add a per-vertex one-ring check then.
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

// Two triangles at the same three positions. TESTS ONLY — see the plan's deviation note: this
// keys a Set by quantised position, and V8 caps Map/Set at 2^24 entries, which an export-scale
// tile can pass. It is also strictly weaker than it looks: it catches a cell claimed by two
// builders (identical positions, identical winding), and nothing else. A T-junction leaves the
// two curtains overlapping but never identical — one side hangs k narrow quads over sub-vertices,
// the other one wide quad over corners — and even a pure weld miss escapes, because assembleSolid
// splits each skirt quad on the tv->bu diagonal and the opposite-facing curtain traverses that edge
// reversed, so it splits on the other one. The gates that see those are `mirrored` and `loops`.
/**
 * @param {Solid} solid
 * @param {number} [q] position quantum in mm
 * @returns {{ ok: boolean, duplicates: number }}
 */
export function checkNoCoincidentFaces({ positions: P, indices: I }, q = 1e-6) {
  /** @type {Set<string>} */
  const seen = new Set();
  let duplicates = 0;
  /** @type {string[]} */
  const t = ["", "", ""];
  for (let i = 0; i < I.length; i += 3) {
    for (let j = 0; j < 3; j++) {
      const v = 3 * I[i + j];
      t[j] = `${Math.round(P[v] / q)},${Math.round(P[v + 1] / q)},${Math.round(P[v + 2] / q)}`;
    }
    t.sort();
    const key = `${t[0]}|${t[1]}|${t[2]}`;
    if (seen.has(key)) duplicates++; else seen.add(key);
  }
  return { ok: duplicates === 0, duplicates };
}
