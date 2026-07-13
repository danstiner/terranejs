# TODO — tilejs

## Considering

- **Unprojected lat/lng sampling.** Everything currently works in web-mercator
  (uniform Mercator lattice). Mercator inflates N-S scale with latitude — the
  chosen 1:scale is exact only at the center lat, and tall layouts stretch.
  Sampling + meshing in native geographic (lat/lng) coordinates would remove
  that distortion for maximum accuracy. Cost: the map is no longer a uniform
  flat Mercator rectangle (aspect + ground-scale vary across the tile) — a
  non-flat map, which is acceptable.

Shipped 2026-07-12: mm-per-km scale input; tile-first selection Plan 1 (square
tiles end-to-end: cell store + picker, hard-coded preset seeds, per-cell
lattice export, boundary flatten, Mercator trail mapping); raw-heightmap
meshing (uniform-grid export, 2026-07-11); tile-first Plan 2 (hex + circle
shapes via global-px stair masks; clip.js/buildSolidFromMesh deleted);
default tile width 220 mm (Prusa Core One).

Shipped 2026-07-13: park boundaries + flatten-outside removed; presets
curated to feature-anchored single 220 mm tiles; evergreen docs consolidated
at docs/specs/. Mercator-uniform context sampling (inlay profile / ocean
seeds / z-frame no longer drift on tall layouts); trail sample ds bounded by
halfW (no preview/export band gaps).
