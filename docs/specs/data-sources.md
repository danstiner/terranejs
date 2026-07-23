# Elevation data sources

terranejs reads elevation and water extent from **Re:Earth Terrain**, an
open, self-hostable tile service serving the **Mapterhorn** DEM:

```
https://terrain.reearth.land/terrarium/elevation/{z}/{x}/{y}.png
https://terrain.reearth.land/mapterhorn-egm08/watermask/{z}/{x}/{y}.png
```

- **Tiling:** Web Mercator `z/x/y`, 256×256 px per tile, z0–14.
- **Elevation encoding:** terrarium RGB, metres, 1/256 m steps:

  ```
  elevation_m = (R * 256 + G + B / 256) - 32768
  ```

  See the [Tilezen/Joerd format docs](https://github.com/tilezen/joerd/blob/master/docs/formats.md#terrarium).
- **Watermask encoding:** alpha channel only — `alpha > 127` marks water
  (ocean + lakes + rivers), transparent is land. Pixel-aligned with the
  elevation tile at the same `z/x/y`.
- **Composition (Mapterhorn):** Copernicus GLO-30 for global land,
  swissALTI3D at 0.5 m resolution inside Switzerland, all geoid-corrected to
  EGM2008. The watermask is derived from Protomaps/OpenStreetMap water
  polygons, not from the DEM itself.
- **Ocean values:** flat ~0 m — no bathymetry. terranejs doesn't need sea
  floor depth (§4a of `data-pipeline.md` clamps masked water to one flat
  floor), so this is a non-issue; the watermask, not elevation, supplies the
  coastline.
- **Access:** keyless, CORS-enabled, open-source (BSD-3, self-hostable) —
  see [terrain.reearth.land](https://terrain.reearth.land/) and
  [mapterhorn.com](https://mapterhorn.com/).
- **Attribution:** "Elevation & water © Re:Earth Terrain / Mapterhorn, geoid
  EGM2008 (NGA)" — shown in the app footer.

### Why not AWS Terrain Tiles

terranejs previously used the AWS `elevation-tiles-prod` terrarium tiles.
Above zoom 10 that dataset overwrites coastal ocean with a land DEM's flat
near-sea-level fill, so thresholding elevation could no longer find the
shoreline — a real bathymetric gradient at z10 became a flat fill at z11.
Re:Earth's watermask sidesteps the problem entirely: the coastline comes
from an independent vector mask, not from thresholding a DEM that may or may
not carry real bathymetry at the zoom in use.
