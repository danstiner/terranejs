# Altitude Color Bands — Design

**Date:** 2026-07-14
**Status:** Approved (brainstorming) — ready for implementation plan

## Goal

Automatically assign filament color changes by altitude in the 3MF export: blue
below sea level, green up to the treeline, grey up to the snowline, white above.
Treeline and snowline are derived from the layout's center latitude. The changes
are always computed and displayed; a checkbox additionally embeds them into the
exported 3MF as PrusaSlicer color-change-by-height metadata.

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
- Module name: **`color-bands.js`** (kebab).

## Architecture

One new pure module, `js/color-bands.js`, is the single source of truth for the
band model. The export path, the UI readout, and the preview are all thin
consumers of it. No new geometry code; no changes to `buildSolid` or the
`threeMF.js` mesh path. The only writer change is an optional metadata entry in
the OPC zip when embedding is on.

### `js/color-bands.js` (new, pure, DOM-free)

```js
// 4-band hypsometric palette: [r,g,b] in 0..1.
export const BAND_COLORS = [
  [0.16, 0.36, 0.55], // 0 blue  — water  (≤ sea level)
  [0.34, 0.52, 0.30], // 1 green — vegetated (≤ treeline)
  [0.55, 0.55, 0.55], // 2 grey  — rock   (≤ snowline)
  [0.96, 0.96, 0.96], // 3 white — snow   (> snowline)
];

// φ = |center latitude|. Approximate, tunable; ignores the subtropical treeline
// "hump" (~30°) for simplicity — this is a print aesthetic, not science.
export function bandThresholds(centerLat) {
  const p = Math.abs(centerLat);
  const treeline = Math.max(0, 3800 * (1 - p / 70)); // 0 at ≥70° (arctic coast)
  const snowline = Math.max(0, 5000 * (1 - p / 85)); // 0 near the pole
  return [0, treeline, snowline]; // metres, ascending; snowline ≥ treeline always
}

// value → band index. Generic over metres OR print-Z (same comparison logic),
// so the preview reuses it on Z. Threshold is the TOP of the lower band:
// value == t stays low (strict >), so elevation 0 is water, 0+ε is green.
export function bandOf(value, thresholds) {
  let b = 0;
  for (const t of thresholds) if (value > t) b++;
  return b;
}

// Color-change list both the readout and the embed consume. frame carries the
// shared z-frame. Returns the changes you ENTER, ascending, in (base, zmax),
// collapsed duplicates removed.
// frame: { emin, base, mmPerM, exag, zmax }
export function colorChanges(thresholds, frame) {
  const { emin, base, mmPerM, exag, zmax } = frame;
  const K = mmPerM * exag;
  const out = [];
  let lastZ = -Infinity;
  thresholds.forEach((t, i) => {
    const band = i + 1;                 // crossing threshold i enters band i+1
    const z = base + (t - emin) * K;
    if (z <= base || z >= zmax) return; // threshold outside the printed span
    if (z - lastZ < 1e-3) return;       // collapsed onto the previous change
    lastZ = z;
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
  shared range (`gridRange` of the context/stamped grid, already computed in the
  export as `emin`'s sibling — add `emax` alongside). `emax` is the *coarse*
  shared max (like `emin`), so a change falling within ~one coarse cell of the
  true tallest fine-grid vertex may be dropped — negligible (a color change at the
  very peak is cosmetic).
- A tile spanning sea level → treeline emits one change (the treeline Z); a tall
  alpine tile emits up to three. An all-above-sea-level tile emits no sea-level
  change (blue absent). A high-latitude tile with `treeline == 0` collapses the
  green band away.

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

- The readout always reflects `changes` (when `colorBands` on).
- `writer` is constructed with the changes when `s.colorBands && s.embedColorChanges`;
  `finish()` writes the PrusaSlicer container as an extra OPC part. When embedding
  is off (or no changes), the zip is exactly today's bare-model output.

### `threeMF.js`

- `ThreeMFWriter` gains an optional constructor arg (or a `setColorChanges(changes)`
  method) carrying the changes.
- `finish()`: when changes are present, add one metadata part built from
  `prusaColorChangeXML(changes)` plus its relationship / content-type, alongside
  `[Content_Types].xml`, `_rels/.rels`, and `3D/3dmodel.model`. When absent,
  identical to today (regression: byte-identical geometry-only 3MF).
- The mesh XML path (`addObject`, vertices/triangles) is **unchanged**.

### UI / state

- `app.js` store defaults (app.js:19) gain:
  - `colorBands: false`
  - `embedColorChanges: false`
- `index.html`, in the export controls (near the Advanced block, ~line 105):
  - Checkbox **"Altitude color bands"** → `colorBands`.
  - Nested checkbox **"Embed color changes in 3MF (PrusaSlicer)"** → `embedColorChanges`,
    disabled/hidden unless `colorBands` is on.
  - A readout element showing, refreshed with the layout:
    `center 46.9° → treeline 1520 m, snowline 2240 m`, the **first-loaded
    filament** color (`BAND_COLORS[bandOf(emin, thresholds)]` — the band the base
    plate sits in, e.g. blue with ocean recess, green for an all-land alpine
    tile), and the change list, e.g.
    `Z 6.4 mm → green · Z 12.1 mm → grey · Z 15.0 mm → white`.
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

## Testing

Pure, no network, no browser (matches the suite). Run:
`cd tilejs && node --test 'test/*.test.mjs'`. New `test/color-bands.test.mjs`:

- `bandThresholds`: monotonic decrease with `|lat|`; `treeline → 0` at ≥70°;
  `snowline → 0` near the pole; `snowline ≥ treeline` across a latitude sweep;
  sign-symmetric (N/S identical).
- `bandOf`: below / exactly-at / above each threshold → indices 0..3;
  exactly-at-threshold stays in the lower band (elevation 0 = water, 0+ε = green).
- `colorChanges`: correct `Zt = base + (t−emin)·K`; thresholds ≤ base or ≥ zmax
  dropped; collapsed duplicates removed; `band`/`color` are the entered band.
  Non-tautological — assert concrete Z values from a chosen frame.
- `prusaColorChangeXML`: emitted container carries exactly the expected Z values
  in the pinned structure (asserts against the spike-pinned format).
- Preview banding: small grid, `colorBands` on; pin a vertex elevation → known Z →
  assert its triangle receives the expected `BAND_COLORS` entry. Drives a real
  mesh Z (like the water-insert test), not an analytic restatement.
- Regression: with `colorBands` off, the export path is unchanged and existing
  export/geometry tests pass; the geometry-only 3MF is byte-identical.

## Risks

- **PrusaSlicer color-change container format.** The exact 3MF structure for
  `custom_gcode_per_print_z` color changes must be pinned by a **spike before**
  writing `prusaColorChangeXML` / the writer part: in PrusaSlicer, save a project
  with two manual color changes on the layer slider, unzip the `.3mf`, and
  replicate the exact part(s), namespace, content-type, and relationship. The
  writer reproduces that structure. This is the only real unknown; the readout
  covers the user regardless.
- **Slicer/version portability.** Embedded metadata targets PrusaSlicer (the
  user's Core One toolchain); it will not carry to Bambu/Cura. The always-on
  numeric readout is the slicer-agnostic fallback (manual entry of 2–3 numbers).

## Out of scope

- Multi-material / MMU export (per-triangle `<basematerials>`).
- User-editable thresholds/colors, manual treeline/snowline override.
- Neutral base plate / forced wall color.
- The subtropical treeline hump (linear latitude model only).
- Fixing the pre-existing `waterDrop` ramp color-shift bug (separate TODO item;
  band mode sidesteps it but does not fix the ramp path).
