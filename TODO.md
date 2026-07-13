# TODO — tilejs

Shipped 2026-07-12: mm-per-km scale input; tile-first selection Plan 1 (square
tiles end-to-end: cell store + picker, hard-coded preset seeds, per-cell
lattice export, boundary flatten, Mercator trail mapping); raw-heightmap
meshing (uniform-grid export, 2026-07-11); tile-first Plan 2 (hex + circle
shapes via global-px stair masks; clip.js/buildSolidFromMesh deleted);
default tile width 220 mm (Prusa Core One). Shipped 2026-07-13: park
boundaries + flatten-outside removed; presets curated to feature-anchored
single 220 mm tiles; evergreen docs consolidated at docs/specs/.

- [ ] P2 inlay-mode profile on tall layouts: trail POINTS map through Mercator
      (fixed), but profileAlong / ocean seeds / z-floor still read the
      lat-linear context grid — mm-scale groove-height error for layouts many
      tiles tall. Root fix: Mercator-uniform context sampling (pixel-locked
      context grid).
- [ ] P3 preview trail band can gap on wide layouts: preview grid caps at 320
      px so ds grows with layout width past halfW; export unaffected. Fix
      direction: decouple the trail rasterization ds from the 320 px preview
      cap (rasterize at halfW-bounded ds).
