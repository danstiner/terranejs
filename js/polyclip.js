// Pure point-in-polygon (ray casting). polygon is [[a,b],…]; point is [a,b] in
// the SAME coordinate pair order (we test lat/lon against a lat/lon polygon).
export function pointInPolygon([px, py], polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const hit = yi > py !== yj > py &&
      px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

// Cell-center mask over a lat/lon grid: mask[(gridW-1)*r + c] = 1 if the centre
// of cell (r,c) lies inside the polygon. Row 0 = north, col 0 = west.
// Stair-stepped clip (Phase 4 preview); Phase 5 upgrades to edge clipping.
export function cellMask(polygon, [s, w, n, e], gridW, gridH) {
  const mask = new Uint8Array((gridW - 1) * (gridH - 1));
  for (let r = 0; r < gridH - 1; r++) {
    const lat = n - ((n - s) * (r + 0.5)) / (gridH - 1);
    for (let c = 0; c < gridW - 1; c++) {
      const lon = w + ((e - w) * (c + 0.5)) / (gridW - 1);
      mask[r * (gridW - 1) + c] = pointInPolygon([lat, lon], polygon) ? 1 : 0;
    }
  }
  return mask;
}
