# Altitude Color Bands — Design

**Date:** 2026-07-14
**Status:** Approved (brainstorming) — ready for implementation plan

## Goal

Automatically assign filament color changes by altitude in the 3MF export. Five
bands: blue below sea level, green up to the treeline, alpine-tundra yellow-green
up to the tundra line, grey up to the snowline, white above. Treeline and snowline
are derived from the layout's center latitude. The changes are always computed and
displayed; a checkbox additionally embeds them into the exported 3MF as PrusaSlicer
color-change-by-height metadata.

## Enabling fact

In `buildSolid` (mesh.js) every top-surface vertex has
`z = base + (elev − emin)·mmPerM·exag`, with `emin`, `base`, `mmPerM`, `exag`
**shared across all tiles** of a layout (app.js:642 `emin`, :785 build call). So
**print-height ≡ altitude, linearly and identically across every tile** — a
horizontal plane at print-Z `Zt` is exactly an iso-altitude contour. That is what
makes altitude color-banding via height-based filament changes (M600) clean: one
change at `Zt` colors the whole layout above that altitude.

## Scope

**In:** single-extruder / M600 (height-based) color changes only. Compute + show
the change heights; optionally embed them in the 3MF for PrusaSlicer.

**Out (deferred):** multi-material / MMU export (per-triangle `<basematerials>` in
the 3MF). Dropped for now — revisit if a multi-filament workflow is wanted. No
mesh geometry changes of any kind; the exported solid is byte-identical whether
the feature is on or off.

## User decisions (made during brainstorming)

- Thresholds **auto-derived from center latitude** (not fixed, not user-edited).
- Encoding: **height-based changes only** (MMU/material export dropped).
- Delivery: **always compute + display** the change heights; **a checkbox**
  additionally embeds them via PrusaSlicer's color-change container.
- Base plate prints in the **lowest band color** (inherent to M600 — the
  first-loaded filament prints the base); acceptable, no neutral-base handling.
- Preview **shows the color bands** (WYSIWYG), not just the numeric readout.
- **Five bands** including an alpine-tundra band (treeline → +~400 m); beach,
  glacier-vs-snow, and desert bands rejected (sub-layer thin or need climate data).
- Latitude model: **plateau-then-linear** (better mid-latitude fit than pure linear).
- Module name: **`color-bands.js`** (kebab).

## Architecture

One new pure module, `js/color-bands.js`, is the single source of truth for the
band model. The export path, the UI readout, and the preview are all thin
consumers of it. No new geometry code; no changes to `buildSolid` or the
`threeMF.js` mesh path. The only writer change is an optional metadata entry in
the OPC zip when embedding is on.

### `js/color-bands.js` (new, pure, DOM-free)

```js
// 5-band hypsometric palette: [r,g,b] in 0..1.
export const BAND_COLORS = [
  [0.16, 0.36, 0.55], // 0 blue   — water  (≤ sea level)
  [0.28, 0.48, 0.28], // 1 green  — forest (≤ treeline)
  [0.60, 0.62, 0.38], // 2 tundra — alpine meadow/krummholz (≤ tundra line)
  [0.55, 0.55, 0.55], // 3 grey   — rock   (≤ snowline)
  [0.96, 0.96, 0.96], // 4 white  — snow   (> snowline)
];

const TUNDRA_M = 400; // alpine-tundra band width above the treeline (metres)

// φ = |center latitude|. Plateau-then-linear: plateaus near equator/subtropics,
// declines poleward. Approximate & tunable; ignores the subtropical treeline
// "hump" (~30°) — this is a print aesthetic, not science.
export function bandThresholds(centerLat) {
  const p = Math.abs(centerLat);
  const clamp = (v, hi) => Math.max(0, Math.min(hi, v));
  const treeline = clamp(3800 * (70 - p) / 40, 3800); // plateau ≤30°, 0 at ≥70°
  const snowline = clamp(5000 * (75 - p) / 45, 5000); // plateau ≤30°, 0 at ≥75°
  const tundra = Math.min(treeline + TUNDRA_M, snowline);
  return [0, treeline, tundra, snowline]; // ascending; ties collapse (see colorChanges)
}

// value → band index 0..4. Generic over metres OR print-Z (same comparison),
// so the preview reuses it on Z. Threshold is the TOP of the lower band:
// value == t stays low (strict >), so elevation 0 is water, 0+ε is green.
export function bandOf(value, thresholds) {
  let b = 0;
  for (const t of thresholds) if (value > t) b++;
  return b;
}

// Color-change list both the readout and the embed consume. Returns the changes
// you ENTER, ascending, in (base, zmax). frame: { emin, base, mmPerM, exag, zmax }.
export function colorChanges(thresholds, frame) {
  const { emin, base, mmPerM, exag, zmax } = frame;
  const K = mmPerM * exag;
  const EPS = 0.05; // mm; sub-layer changes at the same height are merged
  const out = [];
  thresholds.forEach((t, i) => {
    const band = i + 1;                 // crossing threshold i enters band i+1
    const z = base + (t - emin) * K;
    if (z <= base || z >= zmax) return; // threshold outside the printed span
    const prev = out[out.length - 1];
    if (prev && z - prev.z < EPS) {     // collapsed onto the previous change:
      prev.band = band;                 // keep the HIGHER band (thresholds ascend)
      prev.color = BAND_COLORS[band];   // e.g. treeline==0 ⇒ blue→tundra, not →green
      return;
    }
    out.push({ z, band, color: BAND_COLORS[band] });
  });
  return out;
}

// PrusaSlicer color-change container serialization. EXACT format pinned by the
// spike (see Risks); kept pure so it is unit-tested against the pinned string.
export function prusaColorChangeXML(changes) { /* pinned by spike */ }
```

Notes:
- `zmax` = the layout's max print-Z, `base + (emax − emin)·K`; `emax` from the
  shared range (`gridRange` of the context/stamped grid, `emin`'s sibling — add
  `emax` alongside). `emax` is the *coarse* shared max (like `emin`), so a change
  within ~one coarse cell of the tallest fine vertex may be dropped — negligible.
- Threshold ordering `0 ≤ treeline ≤ tundra ≤ snowline` is guaranteed by
  construction, so `bandThresholds` is always ascending. Coincident thresholds
  (high latitude, `treeline == 0`; or `tundra == snowline` when the snowline is
  low) collapse via the highest-band rule — the squeezed band simply vanishes.
- A tile spanning sea level → treeline emits one change; a tall alpine tile emits
  up to four. Out-of-span thresholds emit nothing (blue or white absent).

## Data flow

### Export (`app.js` `export3MF`)

The z-frame (`emin`, `base = s.base`, `mmPerM`, `exag = s.exag`) and `cLat` are
already computed there (cLat app.js:576, emin app.js:642). Add `emax` from the
same range. Then:

```js
const changes = s.colorBands
  ? colorChanges(bandThresholds(cLat), { emin, base: s.base, mmPerM, exag: s.exag, zmax })
  : [];
```

- `writer` receives the changes when `s.colorBands && s.embedColorChanges`;
  `finish()` writes the PrusaSlicer container as an extra OPC part. When embedding
  is off (or no changes), the zip is exactly today's bare-model output.

### `threeMF.js`

- `ThreeMFWriter` gains an optional constructor arg (or `setColorChanges(changes)`)
  carrying the changes.
- `finish()`: when changes are present, add one metadata part built from
  `prusaColorChangeXML(changes)` (plus any content-type/relationship the spike
  shows PrusaSlicer requires), alongside `[Content_Types].xml`, `_rels/.rels`, and
  `3D/3dmodel.model`. When absent, identical to today (regression: byte-identical
  geometry-only 3MF).
- The mesh XML path (`addObject`, vertices/triangles) is **unchanged**.

### UI / state

- `app.js` store defaults (app.js:19) gain:
  - `colorBands: false`
  - `embedColorChanges: false`
- `index.html`, in the export controls (near the Advanced block, ~line 105):
  - Checkbox **"Altitude color bands"** → `colorBands`.
  - Nested checkbox **"Embed color changes in 3MF (PrusaSlicer)"** →
    `embedColorChanges`, disabled/hidden unless `colorBands` is on.
  - A readout element showing, refreshed with the layout:
    `center 46.9° → treeline 2140 m, snowline 3110 m`, the **first-loaded
    filament** color (`BAND_COLORS[bandOf(emin, thresholds)]` — the band the base
    plate sits in, e.g. blue with ocean recess, green for an all-land alpine tile),
    and the change list, e.g. `Z 6.4 mm → tundra · Z 9.1 mm → grey · Z 12.1 mm → white`.
  - **When `embedColorChanges` is on and the layout has separate pieces**
    (`waterSeparate`, or a separate/inlay/overlay trail), show a one-line warning:
    color changes apply to *everything on the plate* by height, so slice the
    separate inserts/trails in their own job (see Caveats).
- Event wiring mirrors the existing `waterSeparate` checkbox (app.js ~:290 block)
  and the `waterOpts` hidden-toggle pattern (index.html:71).

### Preview (`app.js` `rebuildTiles` + `mesh.js` `buildPreviewSolid`)

- When `s.colorBands` is on, `buildPreviewSolid` colors each **top** triangle by
  `bandOf(centroidZ, thresholdsZ)` → `BAND_COLORS[...]` instead of the continuous
  hypsometric ramp; `thresholdsZ = thresholds.map(t => base + (t−emin)·K)` passed
  in via `geom`. **Skirt and base keep their existing neutral gray** (mesh.js
  `SIDE`) — banding only the top surface is simplest and still shows exactly where
  each band lands on the terrain. (The physical print bands the base too via M600;
  the preview intentionally does not, to keep the base plate reading as a plate.)
- Because banding keys on absolute Z, it is immune to the `waterDrop` color-shift
  bug recorded in TODO (that bug is in the ramp's `emin`/`erange` normalization,
  which band mode bypasses).
- ~1-cell jaggedness at boundaries vs the clean printed plane; acceptable for a
  preview.

## Caveats & known limitations

- **Changes are plate-global.** M600 color-by-height colors *every object on the
  bed* at a given Z, including the separate water slab (harmless — it is blue
  anyway) and any separate trail ribbon/overlay (which use a shifted print frame
  and would band wrongly). Print separate inserts/trails in their own slice. The
  UI surfaces this when embedding is on and separate pieces exist.
- **Open as a *project*, not "import geometry."** PrusaSlicer honors embedded
  `custom_gcode_per_print_z` only when the `.3mf` is opened as a project. Document
  in the UI hint.
- **Below-sea-level land basins print blue.** Inland depressions (Death Valley,
  Dead Sea) are not edge-connected, so `oceanMask` never recesses them; their true
  elevation < 0 falls below the sea-level plane → band 0 (blue). A horizontal M600
  plane has no XY selectivity, so height-based color *cannot* distinguish ocean
  from a same-Z land basin. Inherent; only MMU or geometry edits could fix it.
- **Coastal `emin == 0` exactly** (sea-level tile, no `waterDrop`): the base band
  is blue with no visible ocean, since `bandOf` keeps elevation 0 in band 0
  (strict `>`). Intentional — sea level reads as water.
- **Readout Z is approximate; embedded Z is exact.** The pre-export readout only
  has the preview's `baked.min` frame, but the embedded changes use the export's
  coarse-context `emin`. The two differ slightly. Label the readout "approximate;
  exact values written at export."

## Testing

Pure, no network, no browser (matches the suite). Run:
`cd tilejs && node --test 'test/*.test.mjs'`. New `test/color-bands.test.mjs`:

- `bandThresholds`: plateau below ~30°, monotonic decrease through the mid-
  latitudes; `treeline → 0` at ≥70°, `snowline → 0` at ≥75°; ordering
  `0 ≤ treeline ≤ tundra ≤ snowline` at every latitude; `tundra = treeline+400`
  except clamped to the snowline; sign-symmetric (N/S identical).
- `bandOf`: below / exactly-at / above each of the four thresholds → indices 0..4;
  exactly-at-threshold stays in the lower band (elevation 0 = water, 0+ε = green).
- `colorChanges`: correct `Zt = base + (t−emin)·K`; thresholds ≤ base or ≥ zmax
  dropped; **collapse keeps the highest band** — assert the `treeline == 0` (φ≥70)
  case yields a single change reporting tundra/grey, not green (the Fable-found
  bug). Non-tautological: concrete Z values from a chosen frame.
- `prusaColorChangeXML`: emitted container carries exactly the expected Z values in
  the pinned structure (asserts against the spike-pinned format).
- Preview banding: small grid, `colorBands` on; pin a vertex elevation → known Z →
  assert its triangle receives the expected `BAND_COLORS` entry. Drives a real mesh
  Z (like the water-insert test), not an analytic restatement.
- Regression: with `colorBands` off, the export path is unchanged and existing
  export/geometry tests pass; the geometry-only 3MF is byte-identical.

## Risks

- **PrusaSlicer color-change container format.** Pin by a **spike before** writing
  `prusaColorChangeXML` / the writer part: in PrusaSlicer, save a project with two
  manual color changes on the layer slider, unzip the `.3mf`, and replicate the
  exact part(s), namespace, content-type, and relationship. (Likely
  `Metadata/Prusa_Slicer_custom_gcode_per_print_z.xml` with `<code print_z … type …
  extruder … color … gcode …/>` entries and a `<mode value="SingleExtruder"/>`
  element — *unverified*; the spike confirms.) The readout covers the user
  regardless.
- **Slicer/version portability.** Embedded metadata targets PrusaSlicer (the user's
  Core One toolchain); it will not carry to Bambu/Cura. The always-on numeric
  readout is the slicer-agnostic fallback (manual entry of a few numbers).

## Out of scope

- Multi-material / MMU export (per-triangle `<basematerials>`).
- User-editable thresholds/colors, manual treeline/snowline override.
- Neutral base plate / forced wall color.
- The subtropical treeline hump (plateau-then-linear model only).
- Beach/shoreline, glacier-vs-snow, desert, and vegetation-zone bands (sub-layer
  thin or require climate/precip/imagery data not available).
- Fixing the pre-existing `waterDrop` ramp color-shift bug (separate TODO item;
  band mode sidesteps it but does not fix the ramp path).
