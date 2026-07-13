# Flat-Ocean Recess (drop bathymetry, detect-only z10) — Design

**Date:** 2026-07-13
**Status:** approved design, ready for plan

## Problem

Separate-water ("insert") export mode molds the water insert underside from z≤10
bathymetry (`waterT`) but molds the terrain recess floor it seats into from the
geometry-zoom DEM (`rawT`/`rawC`), which over coastal water at z>10 carries no
seafloor. The insert therefore seats proud (≈2.5 mm for deep water at 1:100000).
`water.js` claimed "the recess floor is real bathymetry"; the code never
delivered it.

The obvious fix — splice the same z≤10 bathymetry into the recess — was designed
and reviewed (Fable: SOUND-WITH-CHANGES). It was **rejected in favour of a
simpler direction** after investigating the data source: the z≤10 bathymetry is
too coarse to print well, and mixing it (resampled) into the fine geometry grid
produces visible source/resolution seams. The user's call: **treat coastal water
as flat sea level (0 m). No seafloor.** That deletes the bug instead of fixing it.

## Data-source findings (why this is the right call)

Source: AWS Terrain Tiles, terrarium encoding
(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`,
`elev_m = R*256 + G + B/256 − 32768`). Probed 2026-07-13 over Puget Sound.

**Depth by zoom, one open-water point (47.60 N, 122.45 W):**

| zoom | value | reading |
|------|-------|---------|
| z8, z10 | −201 m | real ETOPO1 seafloor |
| z11–z15 | 0.0 m | land-DEM water-surface fill |

The joerd docs say ETOPO1 bathymetry is oversampled to all zooms, but only where
no higher-priority land DEM exists. Enclosed/coastal water sits *inside* SRTM/NED
coverage, so at z≥11 the land DEM overwrites it with a 0 (or small positive) sea-
surface fill. z≤10 is the deepest zoom whose ocean is a clean, consistently
negative signal.

**Can we detect water on the fine (z14) grid and skip the z10 fetch? No.** Edge-
flood on the fine grid across four Puget Sound tiles:

| location (z14) | how water reads | `≤0` flood | verdict |
|---|---|---|---|
| open basin | clean 0 | 100% | ok |
| Seattle waterfront | 0 to −3, noisy | 49→96% (thr-fragile) | fuzzy |
| Bainbridge shore | **positive 0–11 m** (+ a −1533 junk pixel) | **0%** | undetectable |
| Cascade foothills | 130–420 m | 0% | clean land |

Different tiles fill water differently (0, slightly negative, or positive)
depending on which source DEM covers them, so no single fine-grid threshold
separates water from low land. **Detection still requires the clean z10 signal.**
(The −1533 outlier is the kind of source seam that shows as a "defined line" in
output; flattening masked ocean to 0 m erases it.)

## Decision

- **Keep the z≤10 water fetch, for the ocean MASK only.** It is cheap
  (conditional on context zoom > 10; reused from the context pass otherwise;
  1–4 tiles for the small regions that trigger it) and detection depends on it.
- **Discard bathymetry depth.** All detected ocean recesses to one flat plane
  `waterDrop` mm below sea level (the existing `recessedGrid` path, applied
  unconditionally). The optional separate insert becomes a flat slab of
  thickness `waterDrop`.

This removes the seating bug (flat recess floor ≡ flat insert underside by
construction), the coarse/ugly seafloor, and the fine-grid water outliers
(flattened away under the mask). It is a net code deletion.

## Changes

### `js/water.js`
- **Delete `offsetGrid`** — its only consumer was the bathymetry bake. Keep
  `oceanMask`, `oceanMaskSeeded`, `cellOcean`, `erodeMask`, `recessedGrid`.

### `js/app.js`
- **Import (13-14):** drop `offsetGrid`.
- **`bakeWater` (75-84):** collapse to the single recess path:
  ```js
  function bakeWater(s, rawGrid, oMask, k) {
    if (!oMask) return rawGrid;
    return recessedGrid(rawGrid, oMask, -s.waterDrop / k);
  }
  ```
  Reword the comment: recess ocean to one sunken plane; bathymetry discarded
  (geometry grid has no reliable coastal seafloor; z10 seafloor is too coarse to
  print). Insert-mode no longer differs from plain mode in the terrain bake — the
  only difference is whether a separate flat slab is emitted.
- **`WATER_ZOOM_MAX` comment (49-52):** reword — z10 is the deepest zoom whose
  ocean is a clean negative signal; land DEMs overwrite coastal water with a
  0/positive sea-surface fill at z≥11. Used for **detection**, not depth.
- **Insert build (796-818):** replace the bathymetry molding with a flat slab.
  Keep erode + shape-mask intersect + in-span count guard; drop `depthFlip`,
  `oceanCellsFlip`, and the flipped span (a flat slab is orientation-symmetric):
  ```js
  if (wantWater && oMaskT) {
    const rings = Math.max(1, Math.ceil(WATER_CLEAR_MM / dx)); // shore clearance
    const oceanCells = erodeMask(cellOcean(oMaskT, gwT, ghT), cw, ghT - 1, rings);
    if (s.shape !== "square")
      for (let i = 0; i < oceanCells.length; i++) oceanCells[i] &= mask[i];
    if (countIn(oceanCells, span, cw) > 0) {
      // flat slab fills the flat recess (thickness = waterDrop); prints as a
      // separate (e.g. blue) piece — flat top/bottom, no molding or N-S flip
      const slab = new Float32Array(gwT * ghT);
      const wsolid = buildSolid(slab, gwT, ghT, span, oceanCells,
        { dx, dy, mmPerM: 1, emin: 0, exag: 1, base: s.waterDrop });
      nw++;
      await add(`water_i${ci}_j${cj}`, wsolid, ...belowAt(cell, 0));
    }
  }
  ```
- **`waterT` (727):** unchanged fetch/resample; now consumed only by the mask
  flood at 740 (`oMaskT = oceanMaskSeeded(waterT, …)`).

### `js/mesh.js`
- No change. A flat slab is `buildSolid` on a zero grid; no new module or helper.

## Data flow (export, insert mode)

z10 mosaic → `oMaskC`/`oMaskT` (mask only). Terrain tile: ocean vertices →
`-waterDrop/k` (flat, `waterDrop` mm below sea). Separate slab: flat, thickness
`waterDrop`, eroded footprint for fit clearance. Recess printed depth `=
(0 − (-waterDrop/k))·k = waterDrop` ≡ slab thickness. They mate by construction;
no bathymetry on either side.

## Consistency notes (no new failure modes)

- **`emin` / z-floor:** context grid and tiles both flat-recess ocean to
  `-waterDrop/k`, so `emin` and the per-tile z-floor stay mutually consistent —
  the clamp-vs-insert mismatch that the splice fix had to guard cannot arise.
- **Preview:** `bakedSurface` already flat-recesses in plain mode; now does so in
  all modes. Renders a clean flat sunken ocean instead of coarse bathymetry.
- **Mass estimate:** insert-mode exports get lighter (flat recess + flat slab vs
  bathymetric relief). Correct, not a regression.

## Testing

### `test/water.test.mjs`
- **Delete** the `offsetGrid` test.
- **Rewrite** the insert fixture + tests to the flat slab:
  - fixture builds `buildSolid(zeroGrid, …, {emin:0, exag:1, base:DROP})` over
    edge-connected ocean cells.
  - watertight (closed manifold).
  - thickness = DROP at every footprint column (top z = DROP, base z = 0).
  - registration: `recessedGrid(e, oMask, -DROP/K)` recess printed depth
    `(0 − baked[i])·K == DROP == slab thickness` at every ocean vertex.
- **Keep** the bathymetry-flood detection regressions (`oceanMaskSeeded` on
  bathymetry vs junk; unseeded interior basin stays dry). Add a comment: these
  justify the retained z10 mask fetch — detection on the junk/geometry grid fails.

### Full suite
`cd tilejs && node --test 'test/*.test.mjs'` stays green.

## Out of scope

- The z≤10 fetch itself (required for detection; already minimal).
- Coastline resolution (limited to ~z10; accepted as "not detailed enough").
- Unprojected lat/lng sampling (tracked separately in `TODO.md`).
- Vector coastline sources.

## Risks

- **Slightly blockier coastline** than a true fine-grid coast — inherent to z10
  detection, already the case, accepted.
- **Two-color usefulness preserved:** the separate slab still prints as its own
  object (blue water) filling the recess.
