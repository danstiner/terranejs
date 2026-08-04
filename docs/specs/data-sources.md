# Elevation data sources

terranejs reads elevation and water extent from **Re:Earth Terrain**, the
current source. It previously used AWS's `elevation-tiles-prod` terrarium
tiles, now deprecated for the reasons below.

## Current source: Re:Earth Terrain (Mapterhorn)

An open, self-hostable tile service serving the **Mapterhorn** DEM:

```
https://terrain.reearth.land/terrarium/elevation/{z}/{x}/{y}.png
https://terrain.reearth.land/mapterhorn-egm08/watermask/{z}/{x}/{y}.png
```

- **Tiling:** Web Mercator `z/x/y`. Elevation tiles are 512×512 px ("@2×",
  native to z14, so a z14 tile carries z15-equivalent detail); the watermask
  is 256×256 px. terranejs works in a 256-px grid, reading the native quadrant
  of each elevation tile, so its internal pyramid reaches z15.
- **Elevation encoding:** terrarium RGB, metres, 1/256 m steps:

  ```
  elevation_m = (R * 256 + G + B / 256) - 32768
  ```

  See the [Tilezen/Joerd format docs](https://github.com/tilezen/joerd/blob/master/docs/formats.md#terrarium).
- **Watermask encoding:** alpha channel only — `alpha > 127` marks water
  (ocean + lakes + rivers), transparent is land. Covers the same ground as the
  elevation at the same `z/x/y`; terranejs samples both into one 256-px grid,
  keeping them pixel-aligned.
- **Composition (Mapterhorn):** Copernicus GLO-30 for global land,
  swissALTI3D at 0.5 m resolution inside Switzerland, all geoid-corrected to
  EGM2008. The watermask is derived from Protomaps/OpenStreetMap water
  polygons, not from the DEM itself.
- **Ocean values:** flat ~0 m — no bathymetry. terranejs doesn't need sea
  floor depth (§4 of `data-pipeline.md` tints water at the sea-level color line, or flattens it to
  one plane when recessing — either way the watermask, not elevation, supplies
  the coastline).
- **Access:** keyless, CORS-enabled, open-source (BSD-3, self-hostable) —
  see [terrain.reearth.land](https://terrain.reearth.land/) and
  [mapterhorn.com](https://mapterhorn.com/).
- **Attribution:** "Elevation & water © Re:Earth Terrain / Mapterhorn" — shown
  in the app footer. EGM2008 is the vertical datum, not a credited source (NGA,
  public domain), so it stays documented above and out of the footer; the real
  upstream datasets (GLO-30, swissALTI3D, OSM) aren't named there either until
  per-tile `X-Imagery-Sources` attribution lands.

## Deprecated source: AWS Terrain Tiles (`elevation-tiles-prod`)

terranejs's former elevation source, no longer used. Kept here for context
on why the switch happened and as a record for anyone reading old code or
issues that reference it.

The AWS Open Data ["Terrain Tiles"](https://registry.opendata.aws/terrain-tiles/)
dataset (Tilezen/Mapzen lineage), served terrarium-encoded 256×256 px PNGs
from the `elevation-tiles-prod` S3 bucket:

```
https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
```

Same terrarium RGB encoding as above. Composited from open DEMs — SRTM,
GMTED2010, ETOPO1, plus assorted regional/national sources — with no
retiling or resolution boost beyond the source DEMs' native precision (no
512-px "@2×" tier). Keyless, CORS-enabled, no vector watermask companion.

**Why deprecated:** two compounding problems, both rooted in the dataset
carrying elevation only, no independent water mask:

1. **Coastline vanished at higher zoom.** Above roughly zoom 10 the dataset
   overwrites coastal ocean with a land DEM's flat near-sea-level fill, so
   thresholding elevation could no longer find the shoreline — a real
   bathymetric gradient visible at one zoom became a flat fill one zoom
   deeper. terranejs picks its working zoom per-region ("Resolution floor" in
   `data-pipeline.md`), so any elevation-based coastline detection was one
   zoom bump away from silently breaking.
2. **No independent watermask.** With only a DEM to work from, the coastline
   had to be inferred by thresholding elevation near 0 m — fragile even
   where bathymetry existed, and outright wrong once problem (1) flattened
   it away.

Re:Earth resolves both: a separate vector-derived watermask gives the exact
coast regardless of what the DEM does at the zoom in use, decoupling water
detection from elevation entirely (§4 of `data-pipeline.md`).
