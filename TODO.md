# TODO — tilejs

## Bugs

- **Preview land colors shift when ocean drop changes.** Adjusting `waterDrop`
  recolors the land hypsometric ramp (ocean stays constant `WATER` blue). The
  ramp should be independent of recess depth. Confirmed cause: `bakeWater`
  (`app.js:80`) recesses ocean by `waterDrop/k`, so `gridRange(grid).min` in
  `bakedSurface` (`app.js:139`) drops and `erange` grows; `buildPreviewSolid`
  then normalizes land as `ramp((grid[id]-emin)/erange)` (`mesh.js:81`) against
  that moving window. Fix: key the ramp off a `waterDrop`-independent reference —
  e.g. compute color min/range over land cells only (exclude the ocean mask), or
  use the pre-recess raw grid for the ramp normalization.

## Considering

- Load color bands by default, explain what the current preview does and if we can just replace it with bands
- Tweak color bands to look better, but maybe be a bit unrealistic. Mountains ideally would be gray just to be visible, even if most of them is below the treeline. Think a bit how to fudge this nicely
- **Unprojected lat/lng sampling.** Everything currently works in web-mercator
  (uniform Mercator lattice). Mercator inflates N-S scale with latitude — the
  chosen 1:scale is exact only at the center lat, and tall layouts stretch.
  Sampling + meshing in native geographic (lat/lng) coordinates would remove
  that distortion for maximum accuracy. Cost: the map is no longer a uniform
  flat Mercator rectangle (aspect + ground-scale vary across the tile) — a
  non-flat map, which is acceptable.

- **High-res bathymetry (real seafloor depth).** The flat-ocean recess
  (2026-07-13) discards depth because terrarium seafloor exists only at z≤10 and
  is too coarse/seamy to print. A later feature could restore real, print-worthy
  depth from NOAA. Best data: CUDEM 1/9 arc-sec topobathy (~3 m, US coasts —
  CONUS/AK/HI/PR). Access candidate: keyless NOAA ArcGIS ImageServer
  `DEM_mosaics/DEM_global_mosaic` (F32, ~3 m nominal, global, EPSG:4326, mean
  −1891 m) via `exportImage`. Downsides to design around: (a) not XYZ-PNG —
  needs in-browser LERC/GeoTIFF decode, a new dependency vs the current
  fetch-terrarium-PNG-no-build model; (b) "3 m" is nominal — true detail only
  where lidar/CUDEM exists (US coasts); oversampled-coarse elsewhere, like
  terrarium; (c) datum patchwork (MSL/EGM2008/NAVD88/MLLW/MLW by volume) vs
  terrarium 0 = MSL → coastline offsets unless land+sea come from one topobathy
  source; (d) CORS/keyless + gov-service reliability unverified (spike first).
  Layers cleanly on flat-ocean: reuse the z10 detection mask, replace the flat
  recess plane with sampled depth where covered, keep flat as the global
  fallback.

- **Cleaner water detection (sharper coast, drop the z10 fetch).** Detection
  currently floods ≤0 on the z≤10 grid because coastal water is undetectable on
  the fine grid (land DEMs overwrite it with a 0/positive sea-surface fill at
  z≥11; probed 2026-07-13). A vector coastline / water-polygon source (OSM) or a
  landcover raster (ESA WorldCover 10 m, JRC Global Surface Water) would give a
  crisp, zoom-independent mask and remove the z10 fetch entirely. Blocker: a
  keyless + CORS + tiled endpoint — OSM water polygons are un-tiled shapefiles,
  vector-tile hosts usually need a key, and the rasters are COG/GeoTIFF, not XYZ
  PNG. Independent of the flat-ocean bake (swaps only the mask source).

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
