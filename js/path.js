// GPX-trail geometry on the print grid — pure, node-testable.
//
// Frames: print mm, x east in [0, widthMm], y north in [0, heightMm]; grid
// vertex (row, col) sits at (col·dx, (gh−1−row)·dy) (row 0 = north). The trail
// is resampled to uniform arc-length samples; every derived quantity (vertex
// mask, terrain profile, smoothed mating curve, ribbon heights) is indexed by
// sample, so a grid vertex's nearest sample links it to the profile math.

// segments [[[lat,lon],…],…] -> uniform samples along each polyline.
// Returns { pts: Float32Array [x0,y0,…], segStarts: Int32Array } — segStarts
// marks each segment's first sample so smoothing never crosses segment breaks.
export function samplePath(segments, [s, w, n, e], widthMm, heightMm, ds) {
  const X = (lon) => ((lon - w) / (e - w)) * widthMm;
  const Y = (lat) => ((lat - s) / (n - s)) * heightMm;
  const pts = [], segStarts = [];
  for (const seg of segments) {
    if (seg.length < 2) continue;
    segStarts.push(pts.length / 2);
    let [px, py] = [X(seg[0][1]), Y(seg[0][0])];
    pts.push(px, py);
    let carry = 0; // distance already covered toward the next sample
    for (let i = 1; i < seg.length; i++) {
      const qx = X(seg[i][1]), qy = Y(seg[i][0]);
      const len = Math.hypot(qx - px, qy - py);
      let t = ds - carry;
      while (t <= len) {
        pts.push(px + ((qx - px) * t) / len, py + ((qy - py) * t) / len);
        t += ds;
      }
      carry = len - (t - ds);
      px = qx; py = qy;
    }
  }
  return { pts: Float32Array.from(pts), segStarts: Int32Array.from(segStarts) };
}

// Vertex mask + nearest-sample index within halfW of any sample point, plus an
// optional `inner` mask within halfWInner (the ribbon footprint, inset from the
// groove). Disc-stamp per sample (ds ≤ halfW keeps coverage continuous); each
// vertex keeps its closest sample so profile lookups are consistent along the
// trail. The scan window uses halfW ≥ halfWInner, so `inner` is fully covered.
export function rasterizePath(pts, gw, gh, dx, dy, halfW, halfWInner = 0) {
  const mask = new Uint8Array(gw * gh);
  const inner = new Uint8Array(gw * gh);
  const sIdx = new Int32Array(gw * gh).fill(-1);
  const best = new Float32Array(gw * gh).fill(Infinity);
  const r2 = halfW * halfW, ri2 = halfWInner * halfWInner;
  for (let j = 0; j < pts.length / 2; j++) {
    const px = pts[2 * j], py = pts[2 * j + 1];
    const c0 = Math.max(0, Math.ceil((px - halfW) / dx));
    const c1 = Math.min(gw - 1, Math.floor((px + halfW) / dx));
    const r0 = Math.max(0, gh - 1 - Math.floor((py + halfW) / dy));
    const r1 = Math.min(gh - 1, gh - 1 - Math.ceil((py - halfW) / dy));
    for (let r = r0; r <= r1; r++) {
      const vy = (gh - 1 - r) * dy;
      for (let c = c0; c <= c1; c++) {
        const d2 = (c * dx - px) ** 2 + (vy - py) ** 2;
        const i = r * gw + c;
        if (d2 <= r2) {
          if (d2 < best[i]) { best[i] = d2; mask[i] = 1; sIdx[i] = j; }
          if (d2 <= ri2) inner[i] = 1;
        }
      }
    }
  }
  return { mask, sIdx, inner };
}

// Terrain value (grid units) at each sample, bilinear, edge-clamped.
export function profileAlong(grid, gw, gh, dx, dy, pts) {
  const out = new Float32Array(pts.length / 2);
  for (let j = 0; j < out.length; j++) {
    const gx = Math.min(Math.max(pts[2 * j] / dx, 0), gw - 1 - 1e-6);
    const gy = Math.min(Math.max(gh - 1 - pts[2 * j + 1] / dy, 0), gh - 1 - 1e-6);
    const c = gx | 0, r = gy | 0, fx = gx - c, fy = gy - r;
    out[j] =
      grid[r * gw + c] * (1 - fx) * (1 - fy) +
      grid[r * gw + c + 1] * fx * (1 - fy) +
      grid[(r + 1) * gw + c] * (1 - fx) * fy +
      grid[(r + 1) * gw + c + 1] * fx * fy;
  }
  return out;
}

// edge-clamped box filter over [lo, hi)
function boxAvg(z, lo, hi, W) {
  const n = hi - lo, half = W >> 1;
  const P = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) P[i + 1] = P[i] + z[lo + i];
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = i - half, b = i + half + 1; // window [a, b) in local indices
    const ca = Math.max(0, a), cb = Math.min(n, b);
    let sum = P[cb] - P[ca];
    if (a < 0) sum += -a * z[lo];
    if (b > n) sum += (b - n) * z[lo + n - 1];
    out[i] = sum / (b - a);
  }
  return out;
}

// Mating curve the ribbon is flexed into: per-segment double box filter of the
// print-mm profile, window grown until the ribbon can elastically follow it —
// max slope ≤ slopeMax (bounds flex-induced length mismatch) and bend radius
// ≥ rMin (bounds strain). Window capped at segment length (→ ~constant, which
// trivially satisfies both), so this always terminates.
export function smoothProfile(zrel, segStarts, ds, { slopeMax = 0.2, rMin = 100 } = {}) {
  const out = new Float32Array(zrel.length);
  const starts = [...segStarts, zrel.length];
  for (let k = 0; k + 1 < starts.length; k++) {
    const lo = starts[k], hi = starts[k + 1], n = hi - lo;
    let W = Math.max(3, Math.round(8 / ds)) | 1;
    let f;
    for (;;) {
      f = boxAvg(boxAvg(zrel, lo, hi, W), 0, n, W);
      let ok = true;
      for (let i = 0; ok && i + 1 < n; i++) {
        if (Math.abs(f[i + 1] - f[i]) / ds > slopeMax) ok = false;
        if (i > 0 && Math.abs(f[i + 1] - 2 * f[i] + f[i - 1]) / (ds * ds) > 1 / rMin) ok = false;
      }
      if (ok || W >= 2 * n) break;
      W = (Math.ceil(W * 1.5) | 1);
    }
    out.set(f, lo);
  }
  return out;
}

// bump / inset: raise or lower trail vertices by dElev, following the terrain
export function stampOffset(grid, mask, dElev) {
  const out = Float32Array.from(grid);
  for (let i = 0; i < out.length; i++) if (mask[i]) out[i] += dElev;
  return out;
}

// Inlay groove: trail vertices set to the mating floor f − groove (level across
// the width; raises a solid bench where the floor is above local terrain).
// fRel is in print mm relative to emin0; k converts back to grid units.
export function stampInlay(grid, mask, sIdx, fRel, grooveMm, emin0, k) {
  const out = Float32Array.from(grid);
  for (let i = 0; i < out.length; i++) {
    if (mask[i]) out[i] = emin0 + (fRel[sIdx[i]] - grooveMm) / k;
  }
  return out;
}

// Ribbon top heightfield (print mm; bottom prints flat at z=0). Seated on the
// groove floor, top = max(terrain, mating curve) + proud: sharp relief the flex
// can't follow is embossed on the ribbon's top instead.
export function ribbonGrid(mask, sIdx, zrel, fRel, grooveMm, proudMm) {
  const out = new Float32Array(mask.length);
  for (let i = 0; i < out.length; i++) {
    if (mask[i]) {
      const j = sIdx[i];
      out[i] = Math.max(zrel[j] - fRel[j], 0) + grooveMm + proudMm;
    }
  }
  return out;
}
