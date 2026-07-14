// Ocean detection on an elevation grid (metres, row-major, gw×gh, row 0 = north).
// Ocean = cells at/below sea level that are 4-connected to the frame edge, so
// open sea is flooded but interior sub-sea-level basins (e.g. Death Valley's dry
// Badwater, −86 m) stay land. Pure — node-testable.

// Per-vertex ocean mask: open sea is everything ≤ levelM 4-connected to the frame
// edge. Thin wrapper over oceanMaskSeeded with every frame vertex seeded (the
// seed's own level check keeps above-level edges out), so there is one BFS body.
export function oceanMask(elev, gw, gh, levelM = 0) {
  const seeds = new Uint8Array(gw * gh);
  for (let c = 0; c < gw; c++) { seeds[c] = 1; seeds[(gh - 1) * gw + c] = 1; } // N & S
  for (let r = 0; r < gh; r++) { seeds[r * gw] = 1; seeds[r * gw + gw - 1] = 1; } // W & E
  return oceanMaskSeeded(elev, gw, gh, seeds, levelM);
}

// Cell ocean mask (size (gw-1)*(gh-1)): a cell is ocean iff all 4 corners are.
export function cellOcean(vmask, gw, gh) {
  const cw = gw - 1, ch = gh - 1;
  const out = new Uint8Array(cw * ch);
  for (let r = 0; r < ch; r++) {
    for (let c = 0; c < cw; c++) {
      out[r * cw + c] = vmask[r * gw + c] && vmask[r * gw + c + 1] &&
        vmask[(r + 1) * gw + c] && vmask[(r + 1) * gw + c + 1] ? 1 : 0;
    }
  }
  return out;
}

// Copy of the elevation grid with ocean vertices set to a single recessed
// sea-surface value; land untouched. Feeding this to the existing mesh
// builders yields a flat sunken ocean with no new mesh code. The caller picks
// oceanSurfElev = level − dropMm/(mmPerM·exag) so the print-z drop is exactly dropMm.
export function recessedGrid(elev, vmask, oceanSurfElev) {
  const out = Float32Array.from(elev);
  for (let i = 0; i < out.length; i++) if (vmask[i]) out[i] = oceanSurfElev;
  return out;
}

// Per-vertex ocean mask via BFS from seed vertices through `≤ levelM` vertices.
// For per-tile grids, where frame-edge flooding is wrong (edge-connectivity to
// the open sea is a global property): seeds come from a coarse whole-region
// mask, and the fine flood recovers shoreline detail the coarse pass missed.
export function oceanMaskSeeded(elev, gw, gh, seeds, levelM = 0) {
  const mask = new Uint8Array(gw * gh);
  const stack = [];
  const push = (i) => {
    if (!mask[i] && elev[i] <= levelM) { mask[i] = 1; stack.push(i); }
  };
  for (let i = 0; i < seeds.length; i++) if (seeds[i]) push(i);
  while (stack.length) {
    const i = stack.pop();
    const r = (i / gw) | 0, c = i % gw;
    if (c > 0) push(i - 1);
    if (c < gw - 1) push(i + 1);
    if (r > 0) push(i - gw);
    if (r < gh - 1) push(i + gw);
  }
  return mask;
}

// Shrink a cell mask by `rings` cell-layers (for the water insert's fit
// clearance): a cell survives only if it and all neighbours within `rings` are set.
export function erodeMask(cellMask, cw, ch, rings = 1) {
  let cur = cellMask;
  for (let k = 0; k < rings; k++) {
    const next = new Uint8Array(cw * ch);
    for (let r = 0; r < ch; r++) {
      for (let c = 0; c < cw; c++) {
        if (!cur[r * cw + c]) continue;
        const edge = r === 0 || c === 0 || r === ch - 1 || c === cw - 1;
        next[r * cw + c] = !edge &&
          cur[(r - 1) * cw + c] && cur[(r + 1) * cw + c] &&
          cur[r * cw + c - 1] && cur[r * cw + c + 1] ? 1 : 0;
      }
    }
    cur = next;
  }
  return cur;
}
