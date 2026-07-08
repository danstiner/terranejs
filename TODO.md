# TODO — tilejs

Backlog from the 2026-07-07 code review (xhigh, 10 angles). Check items off as
they land; P3 items are deferred until proven needed (simplicity first).

## P1 — correctness

- [x] **emin from the coarse grid can break solids** (app.js exportSTLs ~524).
  Analytic per-mode emin patches (inlay fmin, inset offset, nothing for
  water/bump) don't bound fine-grid terrain that dips below the coarse min
  (water-insert shorelines are the worst case). Fix: stamp the trail onto the
  coarse context grid and take gridRange().min, plus a per-tile clamp
  `elev ≥ emin + (0.2 − base)/k` so print z stays ≥ 0.2 mm in every mode.
- [ ] **GPX multi-route merge** (gpx.js ~16). Files without `<trkseg>` weld all
  points into one segment — two `<rte>` routes get a phantom connecting leg.
  Fix: trkseg blocks → else per-`<trk>` → else per-`<rte>` → else whole text.
- [ ] **GPX attribute regex too narrow** (gpx.js ~7). Rejects exponent
  notation, '+' signs, whitespace around '=', namespace-prefixed tags; also
  compiles 2 RegExps per point. Fix: precompiled widened patterns.
- [ ] **Ribbon clearance heuristic fails both ways** (app.js ~603). Cell
  erosion rounds to 0 at coarse pitch (interference fit) and erases the
  minimal chain at fine pitch (groove ships without ribbon). Fix: geometric
  inner footprint in rasterizePath: ribbon halfW = max(halfW − 0.15, 1.6·ds).
- [ ] **loadPreview commits hybrid state** (app.js ~369). cellMask/pvKey read
  store.get() after the await; Clear during fetch throws, polygon edits stamp
  stale grids as fresh. Fix: use the s/f snapshot captured at function start.
- [ ] **Preview trail band ≠ export width** (app.js trailContext ~77). The
  3.2·ds width floor scales with each grid's pitch → preview band up to ~3×
  wider than the exported groove on large prints. Fix: floor per call site
  (preview visibility 0.6·ds; ribbon chain floor in the clearance fix).
- [ ] **Water gate asymmetry** (app.js ~536). bakeWater branches on
  waterSeparate alone while insert emission needs waterDrop ≥ 1 → sub-1mm
  drop + separate = recess with no insert. Fix: one insertMode predicate
  (waterSeparate && waterDrop ≥ 1) drives both.
- [ ] **waterDrop slider desync** (app.js ~234). Clamped store value isn't
  written back while the slider has focus. Fix: drop the activeElement guard
  for the range input so the thumb snaps.
- [ ] **GPX import dies silently on one bad file** (app.js ~170). Per-file
  try/catch; report failures in gpxMsg, import the rest.
- [ ] **Partial boundary bake can kill the app** (presets.js ~12 +
  fetch_boundaries.py). b(name) → undefined → bboxToPolygon throws at load.
  Fix: skip undefined-boundary presets with console.warn; bake tool exits
  nonzero on any failure.
- [ ] **Seeded flood seam misclassification** (app.js ~584). Sub-coarse
  waterways whose connection to seeds lies outside a tile's window flood on
  one side of a seam only. Mitigate: dilate coarse-seed lookup by 1 cell +
  propagate fine edge flags to the next tile (W→E, N→S). Known residual:
  sub-coarse channels entering from east/south.

## P2 — efficiency / memory

- [ ] **Incremental zip** (app.js exportSTLs ~539). files[] holds ~700MB of
  raw STLs until the end; deflate each file as produced and drop raw bytes
  (keep raw only while a single file could be downloaded bare). ~3× lower
  peak heap; delete zipFiles.
- [ ] **Double bake per store change** (app.js ~325/~392). estimateMassG and
  rebuildTiles each run bakedSurface per input event. Compute once in the
  subscriber and share; also stops the preview's unused ribbon allocation.

## P3 — cleanup / deferred (add when proven needed)

- [ ] Quick wins batch: oceanMask as a wrapper over oceanMaskSeeded with
  frame-edge seeds (delete duplicate BFS; drop unused levelM); trackBbox via
  bboxOf(segments.flat()); shared WATER_CLEAR_MM = 0.4 (pad + insert erode);
  hoist per-tile seed column map (ccMap); one countIn() for the three span
  counting loops; delete pathCellTotal (≡ np === 0).
- [ ] Fetch retry with backoff in terrain.js — only if an export actually
  fails on a transient error (King@70500 ≈ 760 requests, no failures so far).
- [ ] Skip trail rasterize/stamp on tiles disjoint from the trail bbox — only
  if large-export GC churn (~55MB/tile) proves noticeable.
- [ ] Decoded-terrarium-tile memo across fetchMosaic calls (HTTP cache dedups
  bytes, not PNG decode; ~350 redundant decodes on a 35-tile export).
- [ ] smoothProfile ping-pong buffers (per-iteration typed-array allocs).
- [ ] Shared bakeWindow() so the preview is literally the one-window case of
  the export pipeline (prevents preview/export bake drift).
- [ ] mesh.js: dedupe the 4× boundary-edge extraction + skirt emission
  (pre-existing, ~50 lines).
- [ ] Zip naming by region+scale (king-county-wa_1-70500.zip) and tiles/,
  water/, path/ folders inside the archive (floated 2026-07-06, unconfirmed).
