// Clip a top-surface triangle to the region polygon, in world mm. Returns the
// inside part as a flat array of top-surface triangles (9 numbers each: three
// [x,y,z] verts). A clipped vertex lies on the source triangle's plane (the
// clipped facet), so its z is that plane at (x,y) — no re-sampling.
//
// The clip is Sutherland–Hodgman: subject = region polygon, clip window = the
// convex triangle. Edge crossings on a triangle edge are deterministic, so a
// shared edge is cut identically for both adjacent triangles → the assembled
// solid stays watertight. For the ~4% of triangles whose intersection is
// several pieces, S–H yields a "bridged" ring; ear-clipping it plus dropping the
// near-zero-area bridge slivers keeps it usable, and the caller's per-tile
// watertight check falls back to the uniform stair-clip if a tile ever doesn't
// close.
const EPS = 1e-9;

export function pointInPolygon(px, py, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function planeZ(a, b, c, x, y) {
  const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(d) < EPS) return a[2];
  const wa = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d;
  const wb = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
  return wa * a[2] + wb * b[2] + (1 - wa - wb) * c[2];
}

const cross3 = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

function segIntersect(p1, p2, q1, q2) {
  const d = (q2[1] - q1[1]) * (p2[0] - p1[0]) - (q2[0] - q1[0]) * (p2[1] - p1[1]);
  if (Math.abs(d) < EPS) return null;
  const a = ((q2[0] - q1[0]) * (p1[1] - q1[1]) - (q2[1] - q1[1]) * (p1[0] - q1[0])) / d;
  const b = ((p2[0] - p1[0]) * (p1[1] - q1[1]) - (p2[1] - p1[1]) * (p1[0] - q1[0])) / d;
  if (a <= EPS || a >= 1 - EPS || b <= EPS || b >= 1 - EPS) return null;
  return true;
}
function anyEdgeCrosses(tri, poly) {
  for (let e = 0; e < 3; e++) {
    const p1 = tri[e], p2 = tri[(e + 1) % 3];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      if (segIntersect(p1, p2, poly[j], poly[i])) return true;
    }
  }
  return false;
}

// keep the part of `ring` on the inside (left, for CCW clip edge a->b) half-plane
function clipHalf(ring, a, b) {
  const out = [];
  const inside = (p) => cross3(a[0], a[1], b[0], b[1], p[0], p[1]) >= -EPS;
  const isect = (p, q) => {
    const t = cross3(a[0], a[1], b[0], b[1], p[0], p[1]);
    const u = cross3(a[0], a[1], b[0], b[1], q[0], q[1]);
    const f = t / (t - u);
    return [p[0] + f * (q[0] - p[0]), p[1] + f * (q[1] - p[1])];
  };
  for (let i = 0; i < ring.length; i++) {
    const cur = ring[i], prev = ring[(i - 1 + ring.length) % ring.length];
    const ci = inside(cur), pi = inside(prev);
    if (ci) { if (!pi) out.push(isect(prev, cur)); out.push(cur); }
    else if (pi) out.push(isect(prev, cur));
  }
  return out;
}

// polygon ∩ convex triangle -> one (possibly bridged) ring of [x,y]
function clipPolyByTriangle(poly, triXY) {
  // triangle wound CCW so "inside" = left of each edge
  const ccw = cross3(triXY[0][0], triXY[0][1], triXY[1][0], triXY[1][1], triXY[2][0], triXY[2][1]) > 0
    ? triXY : [triXY[0], triXY[2], triXY[1]];
  let ring = poly;
  for (let e = 0; e < 3 && ring.length; e++) ring = clipHalf(ring, ccw[e], ccw[(e + 1) % 3]);
  return ring;
}

// simple-polygon ear clipping -> index triples
export function earclip(ring) {
  const n = ring.length;
  if (n < 3) return [];
  let idx = [...Array(n).keys()];
  let a2 = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a2 += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  if (a2 < 0) idx.reverse();
  const tris = [];
  let guard = 2 * n;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ip = idx[(i - 1 + idx.length) % idx.length], ii = idx[i], inx = idx[(i + 1) % idx.length];
      const a = ring[ip], b = ring[ii], c = ring[inx];
      if (cross3(a[0], a[1], b[0], b[1], c[0], c[1]) <= EPS) continue; // reflex/collinear
      let ear = true;
      for (const k of idx) {
        if (k === ip || k === ii || k === inx) continue;
        if (ptInTri(ring[k], a, b, c)) { ear = false; break; }
      }
      if (ear) { tris.push([ip, ii, inx]); idx.splice(i, 1); clipped = true; break; }
    }
    if (!clipped) break;
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}
function ptInTri(p, a, b, c) {
  const d1 = cross3(a[0], a[1], b[0], b[1], p[0], p[1]);
  const d2 = cross3(b[0], b[1], c[0], c[1], p[0], p[1]);
  const d3 = cross3(c[0], c[1], a[0], a[1], p[0], p[1]);
  const neg = d1 < -EPS || d2 < -EPS || d3 < -EPS, pos = d1 > EPS || d2 > EPS || d3 > EPS;
  return !(neg && pos);
}

// tri = [[x,y,z]×3], polygon = [[x,y]…] (region ring in the same mm frame).
// -> flat [ax,ay,az, bx,by,bz, cx,cy,cz, …] of the inside triangles.
export function clipTriangleToPolygon(tri, polygon) {
  const inside = tri.map((v) => pointInPolygon(v[0], v[1], polygon));
  const crosses = anyEdgeCrosses(tri, polygon);
  if (inside[0] && inside[1] && inside[2] && !crosses) {
    return [tri[0][0], tri[0][1], tri[0][2], tri[1][0], tri[1][1], tri[1][2], tri[2][0], tri[2][1], tri[2][2]];
  }
  if (!inside[0] && !inside[1] && !inside[2] && !crosses) return [];

  const triXY = [[tri[0][0], tri[0][1]], [tri[1][0], tri[1][1]], [tri[2][0], tri[2][1]]];
  const ring = clipPolyByTriangle(polygon, triXY);
  if (ring.length < 3) return [];
  const [a, b, c] = tri;
  const out = [];
  for (const [i, j, k] of earclip(ring)) {
    const p = ring[i], q = ring[j], r = ring[k];
    if (Math.abs(cross3(p[0], p[1], q[0], q[1], r[0], r[1])) < 1e-6) continue; // drop bridge slivers
    out.push(p[0], p[1], planeZ(a, b, c, p[0], p[1]));
    out.push(q[0], q[1], planeZ(a, b, c, q[0], q[1]));
    out.push(r[0], r[1], planeZ(a, b, c, r[0], r[1]));
  }
  return out;
}

// Fast footprint classification for TIN facets. Build once per cell mask, then
// classify a facet's grid-cell bbox as fully 'in', fully 'out', or 'band'
// (near the footprint boundary → needs the full polygon clip). Band = cells
// with a mixed 3×3 neighborhood, dilated by one more cell, so a polygon edge
// can nick a cell without flipping its center and still stay inside the band.
export function footprintClassifier(mask, cw, ch) {
  const at = (m, r, c) => (r < 0 || c < 0 || r >= ch || c >= cw ? 0 : m[r * cw + c]);
  const mixed = new Uint8Array(cw * ch);
  for (let r = 0; r < ch; r++) {
    for (let c = 0; c < cw; c++) {
      const v = at(mask, r, c);
      let m = 0;
      for (let dr = -1; dr <= 1 && !m; dr++)
        for (let dc = -1; dc <= 1; dc++)
          if (at(mask, r + dr, c + dc) !== v) { m = 1; break; }
      mixed[r * cw + c] = m;
    }
  }
  const band = new Uint8Array(cw * ch);
  for (let r = 0; r < ch; r++) {
    for (let c = 0; c < cw; c++) {
      let b = 0;
      for (let dr = -1; dr <= 1 && !b; dr++)
        for (let dc = -1; dc <= 1; dc++)
          if (at(mixed, r + dr, c + dc)) { b = 1; break; }
      band[r * cw + c] = b;
    }
  }
  const satOf = (m) => {
    const S = new Int32Array((cw + 1) * (ch + 1));
    for (let r = 0; r < ch; r++) {
      let row = 0;
      for (let c = 0; c < cw; c++) {
        row += m[r * cw + c];
        S[(r + 1) * (cw + 1) + (c + 1)] = S[r * (cw + 1) + (c + 1)] + row;
      }
    }
    return S;
  };
  const S = satOf(mask), B = satOf(band);
  const q = (T, r0, c0, r1, c1) =>
    T[(r1 + 1) * (cw + 1) + (c1 + 1)] - T[r0 * (cw + 1) + (c1 + 1)] -
    T[(r1 + 1) * (cw + 1) + c0] + T[r0 * (cw + 1) + c0];
  // args are CELL ranges (inclusive); facet bbox in grid verts maps to cells
  // [minX .. maxX−1] × [minY .. maxY−1]
  return (c0, r0, c1, r1) => {
    c0 = Math.max(0, c0); r0 = Math.max(0, r0);
    c1 = Math.min(cw - 1, c1); r1 = Math.min(ch - 1, r1);
    if (r1 < r0 || c1 < c0) return "out";
    if (q(B, r0, c0, r1, c1) > 0) return "band";
    const k = q(S, r0, c0, r1, c1);
    return k === (r1 - r0 + 1) * (c1 - c0 + 1) ? "in" : k === 0 ? "out" : "band";
  };
}
