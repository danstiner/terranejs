# TODO — tilejs

Shipped 2026-07-12: mm-per-km scale input; tile-first selection Plan 1 (square
tiles end-to-end: cell store + picker, hard-coded preset seeds, per-cell
lattice export, boundary flatten, Mercator trail mapping); raw-heightmap
meshing (uniform-grid export, 2026-07-11).

- [ ] Tile-first Plan 2: hex + circle tile shapes (footprint-clipped meshing,
      hex ghost geometry, cross-tile hex seam fuzz) — spec:
      docs/superpowers/specs/2026-07-11-tile-first-selection-design.md
- [ ] P2 inlay-mode profile on tall layouts: trail POINTS map through Mercator
      (fixed), but profileAlong / ocean seeds / z-floor still read the
      lat-linear context grid — mm-scale groove-height error for layouts many
      tiles tall. Root fix: Mercator-uniform context sampling (pixel-locked
      context grid).
- [ ] P3 preview trail band can gap on wide layouts: preview grid caps at 320
      px so ds grows with layout width past halfW; export unaffected. Fix
      direction: decouple the trail rasterization ds from the 320 px preview
      cap (rasterize at halfW-bounded ds).
- [ ] P3 flatten plinth height differs preview vs export by up to ~0.6 mm
      (boundary-mask aliasing between the 320 px preview and 1200 px context
      grids); export is self-consistent. Fix direction: compute the preview
      plinth from the export-resolution context mask, or accept and document.
- [ ] P3 flatMin has no DEM-outlier defense: a bad land sample inside the
      boundary (e.g. Olympic's −1709 m Lake Crescent artifact) sets the plinth
      datum. Consider percentile floor or outlier rejection.
- [ ] P3 edge-tile weld memory (2^24 Map cap in buildSolidFromMesh) now only
      concerns Plan 2 footprint clips — bounded by one tile's cells. Fix
      direction (from the superseded item): pre-sized typed accumulator +
      sort-based weld, or a UI warning at the top slider steps.
