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
- **Elevation encoding:** terrarium RGB, meters, 1/256 m steps:

  ```
  elevation_m = (R * 256 + G + B / 256) - 32768
  ```

  See the [Tilezen/Joerd format docs](https://github.com/tilezen/joerd/blob/master/docs/formats.md#terrarium).
- **Watermask encoding:** alpha channel only — `alpha > 127` marks water
  (ocean + lakes + rivers), transparent is land. Covers the same ground as the
  elevation at the same `z/x/y`; terranejs samples both into one 256-px grid,
  keeping them pixel-aligned.
- **Composition (Mapterhorn):** Copernicus GLO-30 as the global base, with
  **134 higher-resolution national and regional datasets laid over it** where
  they exist — 33 separate USGS 3DEP 1 m collections in the US, plus 3DEP
  1/3 arc-second, swissALTI3D, Australia's 5 m lidar grid, Japan's 基盤地図情報,
  and others; all geoid-corrected to EGM2008. The live list is
  [attribution.json](https://download.mapterhorn.com/attribution.json) (the
  `mapterhorn.com/attribution` page renders it). The watermask is derived from
  Protomaps/OpenStreetMap water polygons, not from the DEM itself.
- **Provenance:** queryable per location. Mapterhorn publishes a coverage
  vector tileset — a `coverage` layer whose polygons carry one field, `source`,
  joining to the catalog above:

  ```
  https://single-archive-tiles.mapterhorn.com/coverage.json        (TileJSON, maxzoom 14)
  https://single-archive-tiles.mapterhorn.com/coverage/{z}/{x}/{y}.mvt
  https://download.mapterhorn.com/attribution.json                 (source → name, resolution, producer, license)
  ```

  Both are `Access-Control-Allow-Origin: *`, and the tiles are tiny (100 B–2.5 KB
  over the test area, cached a week), so a tile's real provenance and best
  available posting can be read at bake time. Point-in-polygon against the
  decoded layer at Mount Larrabee returns `glo30 + usgs3dep13` on one side of the
  seam and `glo30 + usgs3dep13 + us1cc` (**1 m**) on the other; at the Matterhorn
  it returns `glo30 + itaosta + tinitaly + swissalti3d` (**0.5 m**).

  `src/core/coverage.js` implements this, and the hover probe reports the source
  the composite actually used at the cursor (`us1cc 1 m`), by reproducing the
  merge rule below. It is a **preview-only diagnostic**: the
  detailed pass fetches it, the export path never does, and the mesh never waits
  on it — the two Mapterhorn hosts are separate from the elevation host and fail
  independently, so the probe states `source unavailable` rather than guessing.
  It also distinguishes that from `no source data`, which means no polygon covers
  the point at all.

  **The merge rule: finest wins where it has data, ties break by source id.**
  Not inferred — Mapterhorn's pipeline is open source
  ([mapterhorn/mapterhorn](https://github.com/mapterhorn/mapterhorn), BSD-3):

  - `pipelines/utils.py`, `get_grouped_source_items` sorts candidates by
    `(-maxzoom, source, filename)` — finest first, source id ascending as the
    tiebreak.
  - `pipelines/aggregation_reproject.py` writes the groups out in that order.
  - `pipelines/aggregation_merge.py` starts from the first and copies from each
    later one **only into nodata**:
    `copy_mask = (merged_tile == -9999) & (current_tile != -9999)`.

  So a coarser source appears only in the finer one's holes, and among equal
  sources the alphabetically-first id wins. `src/core/coverage.js` reproduces
  that key rather than approximating it, so the probe names the source that was
  **used**, not the finest one on offer:

  - `maxzoomFor()` mirrors `get_smallest_overzoom()`, **including its floor**:
    `aggregation_covering.py` clamps every file with `max(maxzoom, macrotile_z)`
    where `macrotile_z = 12`, and writes the clamped value into the CSV the
    merge sorts by. The key is an integer zoom over **Mercator** metres, so it
    also scales by `1/cos(lat)` and collapses sources within a factor of 2.
    Consequences, both live:
    - Everything coarser than ~19 Mercator m/px lands on bucket 12 together and
      the id tiebreak decides. `glo30` vs `nosvalbard` at Svalbard resolves to
      `glo30` — ranking by catalog metres names `nosvalbard`, which is wrong.
      At Reykjavik the same rule puts `glo30` (bucket 12) ahead of Iceland's
      10 m `is` (also 12, at 64 N a 10 m cell is 22.9 Mercator m) because
      `glo30` sorts first alphabetically. Surprising, but verified against the
      live raster: over Landmannalaugar, Mapterhorn's elevation matches the
      exact GLO-30 COG it ingests to a 0.21 m median on flat ground (p90
      0.82 m, 1105 nodes) — at or below the same measurement's floor over Nuuk,
      where glo30 is the only candidate. That is same-source agreement; an
      independent 10 m DEM would not track TanDEM-X to two decimetres. So
      Mapterhorn ships GLO-30 across Iceland outside glo30's voids — likely an
      upstream bug (the floor, not the id tiebreak, is what buries `is`), but
      the probe's job is to report the composite as built, and it does.
    - Above the floor the stretch still decides: 2 m and 2.5 m separate at the
      equator and tie at 45.
    The floor also absorbs the geographic-CRS error — `glo30`'s own native
    maxzoom runs 9-12 by latitude band, all at or below 12, so it lands on 12
    however its resolution is scaled.
  - `rankSources()` sorts `(-maxzoom, id)`, and because the polygons are
    validity masks, "covers this cell" means "has data here" — so the first
    ranked source is the one the merge used.
  - `edgeDistance()` + `featherPx()` catch the blend zone:
    `aggregation_merge.py` Gaussian-blurs across every nodata edge over
    `macrotile_buffer_3857 = 150` Mercator metres, so a cell that close to where
    its source's data ends reads `us1cc 1 m ⇄ glo30 (blended)`. Both names,
    because there is genuinely no single answer there. Two details that matter:
    the reach is `4·sigma·res` at the winner's own bucket rather than a flat
    150 m (~143 m for 1 m lidar, ~76 m on the z12 floor), and segments lying on
    the tile's buffered clip rectangle are excluded — those mark where the
    TILESET cut the polygon, not where the source ends, and counting them would
    flag a blend along every internal seam. The merge's blend is also two-sided;
    the probe flags only the winner's side, since the filler side does not carry
    the winner in its covering set at all.

  Measured against the live rasters at the Larrabee seam, aligning 216 columns
  on the polygon edge per column (the edge slopes ~5%, and not aligning smears
  the transition over hundreds of metres — which is what an earlier measurement
  of mine did): the disturbance begins **at** the polygon edge and decays over
  **~120 m** into the finer source, against a predicted 99 m. Boundary placement
  and feather width both hold up. Note the join is not a smooth ramp — mean
  |∂²z/∂y²| **spikes to ~4× the lidar side's own roughness** in the first ~80 m
  and settles after ~120 m. The blend narrows the step between two DEMs that
  disagree on absolute elevation; it does not remove it, and at print scale that
  residual is a ridge along the seam.

  Three limits remain, and none is fixable from published data:

  - **Per-file, not per-source.** Grouping is `(maxzoom, source)`, so one source
    whose files differ in native resolution forms several groups. The catalog
    gives one number per source, so we model one.
  - **Geographic vs projected CRS, above the floor.** `maxzoomFor` applies the
    Mercator stretch to every source, which is right for projected ones. A
    geographic-CRS source does not stretch in x. The z12 floor absorbs this for
    coarse sources (`glo30` included); it remains a risk only for a
    geographic-CRS source finer than the floor.
  - **Holes below the tileset's resolution.** `pipelines/source_polygonize.py`
    polygonizes a validity mask (`gdal_calc.py --calc="A*0+1"` then
    `gdal_polygonize.py`), not a bounding box, so nodata gaps are real holes —
    the decoded fixture shows `cahrdem2` as one exterior plus two. But the layer
    is served at z14 and simplified, so gaps below that survive as coverage the
    raster does not have.

  An id missing from the catalog has no computable key, so it cannot be ranked
  and may in fact be the winner. It is appended as `?xy12 unranked` rather than
  dropped — a lagging catalog is exactly when a new source appears. A failed
  catalog fetch degrades the label to raw ids for the session rather than
  failing provenance.

  **Catalog resolution is grid spacing, not information content, and the two
  can differ by an order of magnitude.** The Larrabee smooth side advertises 10 m
  (3DEP 1/3 arc-second) but carries nothing below ~100 m, because 3DEP's 1/3″
  product there is 1983 contour-derived data interpolated onto a 10 m grid. The
  catalog says what was *available*; only measuring the samples says what is
  *in* them. `src/core/detail.js` measures the latter — they are complementary.

  **Resolution is therefore not uniform, and the seams are visible when a tile
  is small enough.** A national lidar dataset covers the footprint of the
  acquisition that produced it, and those footprints have arbitrary shapes and
  hard edges. A tile straddling one shows genuinely different detail on each
  side — not a terranejs artifact, and not fixable downstream. Worked example:
  a 2.7 km tile at Mount Larrabee, WA straddles the north edge of 3DEP's
  `WA_Western_WA_QL1_LiDAR_2016_B16`; south of the line the data resolves
  detail down to ~12 m, north of it there is no lidar at all and nothing
  below ~100 m survives.
- **Ocean values:** flat ~0 m — no bathymetry. terranejs doesn't need sea
  floor depth (§4 of `data-pipeline.md` tints water at the sea-level color
  line, or flattens it to one plane when recessing — either way the watermask,
  not elevation, supplies the coastline).
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
