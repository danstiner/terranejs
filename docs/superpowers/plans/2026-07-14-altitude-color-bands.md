# Altitude Color Bands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-assign filament color changes by altitude in the 3MF export — five hypsometric bands (blue/green/tundra/grey/white) with treeline & snowline derived from the layout's center latitude; changes always computed and shown, optionally embedded as PrusaSlicer color-change metadata.

**Architecture:** One new pure module `js/color-bands.js` is the single source of truth (palette, latitude→thresholds, band lookup, change list). The preview, the UI readout, and the 3MF embed are thin consumers. No mesh geometry changes: `buildSolid` and the `threeMF.js` mesh path are untouched; the only writer change is an extra OPC part when embedding.

**Tech Stack:** Vanilla ES modules, no build step. Tests: `node --test` (`node:test` + `node:assert`). 3MF = OPC zip written by `js/threeMF.js` + `js/zip.js`. Preview = three.js `BufferGeometry` vertex colors.

**User decisions (already made):**
- "automatically set filament color changes based on altitude" — blue ≤0m, green→treeline, grey→snowline, white above.
- Thresholds auto-derived from center latitude (plateau-then-linear model).
- Five bands: added an alpine-tundra band between treeline and rock.
- Height-based (M600) changes only; MMU/material 3MF export deferred.
- Always compute + display the change heights; a checkbox additionally embeds them via PrusaSlicer's color-change container.
- Base plate prints in the lowest band color (inherent to M600).
- Preview shows the color bands (top surface); skirt/base stay neutral gray.
- Module name `color-bands.js`.

**Spec:** `docs/superpowers/specs/2026-07-14-altitude-color-bands-design.md`

---

## File Structure

- **Create `js/color-bands.js`** — pure band model: `BAND_COLORS`, `bandThresholds(lat)`, `bandOf(value, thresholds)`, `baseBand(emin, thresholds)`, `colorChanges(thresholds, frame)`. Task 4 appends `prusaColorChangeXML(changes)`.
- **Create `test/color-bands.test.mjs`** — unit tests for the pure module.
- **Modify `js/app.js`** — store defaults (`colorBands`, `embedColorChanges`); checkbox event wiring; `renderSettings` readout; `rebuildTiles` passes band thresholds to the preview; `export3MF` computes `emax`/`zmax` + changes and hands them to the writer.
- **Modify `index.html`** — two checkboxes + a readout element in the export controls.
- **Modify `js/mesh.js`** — `buildPreviewSolid` optional band coloring of the top surface.
- **Modify `js/threeMF.js`** — optional PrusaSlicer color-change OPC part in `finish()`.

Dependency order is linear (all UI/export tasks share `js/app.js`): T1 → T2 → T3 → T4 → T5.

---

### Task 1: Pure band model `color-bands.js` + tests

**Goal:** A DOM-free module computing the palette, latitude-derived thresholds, band lookup, base band, and the color-change list, with full unit tests.

**Files:**
- Create: `js/color-bands.js`
- Test: `test/color-bands.test.mjs`

**Acceptance Criteria:**
- [ ] `bandThresholds(lat)` returns ascending `[0, treeline, tundra, snowline]`, plateauing ≤30°, `treeline→0` at ≥70°, `snowline→0` at ≥75°, sign-symmetric.
- [ ] `bandOf(value, thresholds)` returns 0..4; exactly-at-threshold stays in the lower band.
- [ ] `baseBand(emin, thresholds)` folds thresholds `≤ emin` into the base band (so a sea-level `emin=0` tile reports green, not blue).
- [ ] `colorChanges` maps `Zt = base + (t−emin)·mmPerM·exag`, drops thresholds at/below base or ≥ zmax, and collapses coincident changes keeping the **higher** band.
- [ ] All tests pass; tests are non-tautological (assert concrete numbers).

**Verify:** `cd tilejs && node --test 'test/color-bands.test.mjs'` → all pass.

**Steps:**

- [ ] **Step 1: Write the failing tests**

Create `tilejs/test/color-bands.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { BAND_COLORS, bandThresholds, bandOf, baseBand, colorChanges }
  from "../js/color-bands.js";

test("bandThresholds: ascending + correctly ordered at every latitude", () => {
  for (const lat of [-80, -46, 0, 20, 46, 60, 70, 85]) {
    const [sea, tree, tundra, snow] = bandThresholds(lat);
    assert.equal(sea, 0);
    assert.ok(tree >= 0 && snow >= 0, `nonneg @${lat}`);
    assert.ok(tree <= tundra + 1e-9 && tundra <= snow + 1e-9,
      `order @${lat}: ${tree},${tundra},${snow}`);
  }
});

test("bandThresholds: plateau, poleward decline, high-latitude zeros", () => {
  assert.equal(bandThresholds(0)[1], 3800);   // treeline plateau
  assert.equal(bandThresholds(20)[1], 3800);  // still on the ≤30° plateau
  const t46 = bandThresholds(46)[1];
  assert.ok(t46 > 2000 && t46 < 2300, `mid-lat treeline ${t46}`); // ~2280
  assert.equal(bandThresholds(70)[1], 0);     // treeline meets the coast
  assert.equal(bandThresholds(75)[3], 0);     // snowline reaches the pole
  assert.deepEqual(bandThresholds(46), bandThresholds(-46)); // sign-symmetric
});

test("bandOf: strict-> boundaries, indices 0..4", () => {
  const thr = [0, 1000, 1400, 2000];
  assert.equal(bandOf(-5, thr), 0);
  assert.equal(bandOf(0, thr), 0);      // sea level = water
  assert.equal(bandOf(1, thr), 1);      // just above = forest
  assert.equal(bandOf(1000, thr), 1);   // exactly treeline stays forest
  assert.equal(bandOf(1200, thr), 2);   // tundra
  assert.equal(bandOf(1400, thr), 2);   // exactly tundra line stays tundra
  assert.equal(bandOf(1700, thr), 3);   // rock
  assert.equal(bandOf(2000, thr), 3);   // exactly snowline stays rock
  assert.equal(bandOf(2500, thr), 4);   // snow
});

test("baseBand: thresholds at/below emin fold into the base band", () => {
  const thr = [0, 1000, 1400, 2000];
  assert.equal(baseBand(-1.5, thr), 0); // sub-sea (ocean recess) → blue base
  assert.equal(baseBand(0, thr), 1);    // sea-level land → green base, NOT blue
  assert.equal(baseBand(1200, thr), 2); // starts in tundra
});

test("colorChanges: Zt mapping + range filter (emin below sea level)", () => {
  const thr = [0, 1000, 1400, 2000];
  // K = mmPerM*exag = 2; emin=-1 (ocean recess); base=6; zmax huge
  const ch = colorChanges(thr, { emin: -1, base: 6, mmPerM: 1, exag: 2, zmax: 1e9 });
  assert.deepEqual(ch.map((c) => [Math.round(c.z), c.band]),
    [[8, 1], [2008, 2], [2808, 3], [4008, 4]]);
  assert.deepEqual(ch[0].color, BAND_COLORS[1]);
});

test("colorChanges: threshold at/below base and above zmax are dropped", () => {
  const thr = [0, 1000, 1400, 2000];
  // emin=0 → sea-level change lands at z=base (dropped); zmax clips the snowline
  const ch = colorChanges(thr, { emin: 0, base: 6, mmPerM: 1, exag: 2, zmax: 3000 });
  assert.deepEqual(ch.map((c) => [Math.round(c.z), c.band]),
    [[2006, 2], [2806, 3]]); // treeline+tundra kept; snowline z=4006 ≥ zmax dropped
});

test("colorChanges: coincident thresholds keep the HIGHER band (treeline==0)", () => {
  // lat 70: thresholds ≈ [0, 0, 400, 555.6]; emin=-1 so the sea-level change fires
  const thr = bandThresholds(70);
  const ch = colorChanges(thr, { emin: -1, base: 6, mmPerM: 1, exag: 2, zmax: 1e9 });
  // the two coincident t=0 changes collapse to a single tundra (band 2), not green
  assert.equal(ch[0].band, 2);
  assert.deepEqual(ch[0].color, BAND_COLORS[2]);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd tilejs && node --test 'test/color-bands.test.mjs'`
Expected: FAIL — `Cannot find module '../js/color-bands.js'`.

- [ ] **Step 3: Write `js/color-bands.js`**

Create `tilejs/js/color-bands.js`:

```js
// Hypsometric altitude color bands for filament changes. Pure, DOM-free: the
// export readout, the 3MF embed, and the preview all consume these.

// [r,g,b] 0..1, one per band (ascending altitude).
export const BAND_COLORS = [
  [0.16, 0.36, 0.55], // 0 blue   — water  (≤ sea level)
  [0.28, 0.48, 0.28], // 1 green  — forest (≤ treeline)
  [0.60, 0.62, 0.38], // 2 tundra — alpine meadow/krummholz (≤ tundra line)
  [0.55, 0.55, 0.55], // 3 grey   — rock   (≤ snowline)
  [0.96, 0.96, 0.96], // 4 white  — snow   (> snowline)
];

const TUNDRA_M = 400; // alpine-tundra band width above the treeline (metres)

// φ = |center latitude|. Plateau-then-linear: plateaus near the equator/subtropics,
// declines poleward. Approximate & tunable; ignores the subtropical treeline hump.
export function bandThresholds(centerLat) {
  const p = Math.abs(centerLat);
  const clamp = (v, hi) => Math.max(0, Math.min(hi, v));
  const treeline = clamp((3800 * (70 - p)) / 40, 3800); // plateau ≤30°, 0 at ≥70°
  const snowline = clamp((5000 * (75 - p)) / 45, 5000); // plateau ≤30°, 0 at ≥75°
  const tundra = Math.min(treeline + TUNDRA_M, snowline);
  return [0, treeline, tundra, snowline]; // ascending; ties collapse (colorChanges)
}

// value → band index 0..4. Generic over metres OR print-Z (same comparison).
// Threshold is the TOP of the lower band (strict >): value 0 is water, 0+ε green.
export function bandOf(value, thresholds) {
  let b = 0;
  for (const t of thresholds) if (value > t) b++;
  return b;
}

// Band of the base plate / first-loaded filament. A threshold at or below the
// lowest printed elevation cannot fire a mid-print change (it would sit at the
// base), so it folds into the base band — unlike bandOf's point rule at emin.
export function baseBand(emin, thresholds) {
  let b = 0;
  for (const t of thresholds) if (t <= emin) b++;
  return b;
}

// Color changes to fire, ascending, for thresholds strictly inside (emin, emax).
// frame: { emin, base, mmPerM, exag, zmax }. Coincident changes keep the HIGHER
// band (thresholds ascend) so a squeezed band collapses cleanly.
export function colorChanges(thresholds, frame) {
  const { emin, base, mmPerM, exag, zmax } = frame;
  const K = mmPerM * exag;
  const EPS = 0.05; // mm; merge sub-layer-coincident changes
  const out = [];
  thresholds.forEach((t, i) => {
    const band = i + 1; // crossing threshold i enters band i+1
    const z = base + (t - emin) * K;
    if (z <= base || z >= zmax) return; // at/below base, or above the print
    const prev = out[out.length - 1];
    if (prev && z - prev.z < EPS) { // collapsed onto the previous change:
      prev.band = band;             // keep the higher band (e.g. blue→tundra)
      prev.color = BAND_COLORS[band];
      return;
    }
    out.push({ z, band, color: BAND_COLORS[band] });
  });
  return out;
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd tilejs && node --test 'test/color-bands.test.mjs'`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add tilejs/js/color-bands.js tilejs/test/color-bands.test.mjs
git commit -m "feat(color-bands): pure altitude band model + tests"
```

---

### Task 2: State, UI controls & readout

**Goal:** Add the `colorBands`/`embedColorChanges` store fields, the two checkboxes, and the always-on readout of derived treeline/snowline, first-filament color, and change heights.

**Files:**
- Modify: `js/app.js` (store defaults ~line 19; event wiring ~line 302; `renderSettings` ~line 365)
- Modify: `index.html` (export controls, after the `waterOpts` block ~line 78)

**Acceptance Criteria:**
- [ ] Store has `colorBands: false` and `embedColorChanges: false`.
- [ ] "Altitude color bands" checkbox toggles `colorBands`; the nested "Embed color changes in 3MF (PrusaSlicer)" checkbox toggles `embedColorChanges` and is disabled while `colorBands` is off.
- [ ] When `colorBands` is on and a layout exists, a readout shows `center <lat>° → treeline <m> m, snowline <m> m`, the first-loaded filament band name, and the change list `Z <mm> → <band> · …` (or "no changes (single band)" when empty).
- [ ] When `embedColorChanges` is on and the layout has separate pieces (`waterSeparate`, or a trail), a one-line warning is shown.
- [ ] Existing tests still pass; no behavior change when `colorBands` is off.

**Verify:** `cd tilejs && node --test 'test/*.test.mjs'` → all pass (no regressions); manual: toggling the checkbox shows/updates the readout.

**Steps:**

- [ ] **Step 1: Add store defaults**

In `tilejs/js/app.js`, in the `createStore({…})` object (after line 33 `exportDetail: 2,`), add:

```js
  colorBands: false, // altitude filament color bands (M600 by height)
  embedColorChanges: false, // also embed the changes in the exported 3MF (PrusaSlicer)
```

- [ ] **Step 2: Add the UI controls**

In `tilejs/index.html`, immediately after the `</div>` that closes `#waterOpts` (line 78), insert:

```html
        <label class="row"><span>Altitude color bands</span>
          <input id="colorBands" type="checkbox"></label>
        <div id="bandOpts" hidden>
          <label class="row"><span>Embed color changes in 3MF (PrusaSlicer)</span>
            <input id="embedColorChanges" type="checkbox"></label>
          <p class="hint" id="bandReadout"></p>
          <p class="hint warn" id="bandWarn" hidden></p>
          <p class="hint">Bands recolor the terrain top by altitude. Embedded
            changes load only when the .3mf is opened as a <b>project</b> in
            PrusaSlicer (not "import geometry").</p>
        </div>
```

- [ ] **Step 3: Wire the checkbox events**

In `tilejs/js/app.js`, after the `waterSeparate` listener (line 305), add:

```js
$("colorBands").addEventListener("change", (e) => store.set({ colorBands: e.target.checked }));
$("embedColorChanges").addEventListener("change", (e) => store.set({ embedColorChanges: e.target.checked }));
```

- [ ] **Step 4: Add the readout import + render**

At the top of `tilejs/js/app.js`, add `color-bands.js` to the imports (next to the other `js/` imports):

```js
import { BAND_COLORS, bandThresholds, bandOf, baseBand, colorChanges } from "./color-bands.js";
```

Then in `renderSettings(s, baked)`, after the `waterSeparate` line (line 378 `$("waterSeparate").checked = s.waterSeparate;`), add:

```js
  $("colorBands").checked = s.colorBands;
  $("bandOpts").hidden = !s.colorBands;
  $("embedColorChanges").checked = s.embedColorChanges;
  if (s.colorBands) renderBandReadout(s, baked);
```

Note: `renderBandReadout` is defined in Step 5 and uses the same `f = layoutFit(s)` frame computed later in `renderSettings` (line 395). Move the `const f = layoutFit(s);` assignment up to just before this block (delete the later duplicate at line 395) so both the band readout and the existing fit readout share it.

- [ ] **Step 5: Add the pure-ish readout helper**

Add this function to `tilejs/js/app.js` (near `renderSettings`). It reads the **preview** frame (`baked.min/max`) — the approximate frame; the exact values are recomputed at export:

```js
const BAND_NAMES = ["water", "forest", "tundra", "rock", "snow"];

// Readout for the altitude bands (approximate: preview frame, not the export frame).
function renderBandReadout(s, baked) {
  const el = $("bandReadout");
  if (!baked) { el.textContent = "— loading…"; return; }
  const f = layoutFit(s);
  const cLat = (f.bbox[0] + f.bbox[2]) / 2;
  const thr = bandThresholds(cLat);
  const K = (1000 / f.scale) * s.exag;
  const frame = { emin: baked.min, base: s.base, mmPerM: 1000 / f.scale, exag: s.exag,
    zmax: s.base + (baked.max - baked.min) * K };
  const changes = colorChanges(thr, frame);
  const first = BAND_NAMES[baseBand(baked.min, thr)];
  const list = changes.length
    ? changes.map((c) => `Z ${c.z.toFixed(1)} mm → ${BAND_NAMES[c.band]}`).join(" · ")
    : "no changes (single band)";
  el.textContent =
    `center ${cLat.toFixed(1)}° → treeline ${Math.round(thr[1])} m, ` +
    `snowline ${Math.round(thr[3])} m · load ${first} first · ${list}`;

  const sep = s.waterSeparate || s.tracks.length > 0;
  const warn = $("bandWarn");
  warn.hidden = !(s.embedColorChanges && sep);
  warn.textContent = "Color changes apply to every object on the plate by height — "
    + "slice separate inserts/trails in their own job.";
}
```

- [ ] **Step 6: Run tests + manual check**

Run: `cd tilejs && node --test 'test/*.test.mjs'`
Expected: PASS (no regressions). Manually: enable "Altitude color bands" on a placed layout → the readout appears and updates with scale/exag/latitude.

- [ ] **Step 7: Commit**

```bash
git add tilejs/js/app.js tilejs/index.html
git commit -m "feat(color-bands): state, checkboxes, and altitude readout"
```

---

### Task 3: Preview band coloring

**Goal:** When `colorBands` is on, color the preview top surface by altitude band (per-triangle by centroid Z) instead of the continuous ramp; skirt/base stay neutral gray.

**Files:**
- Modify: `js/mesh.js` (`buildPreviewSolid`, lines 34–92)
- Modify: `js/app.js` (`rebuildTiles`, lines 538–561)
- Test: `test/color-bands-preview.test.mjs` (new)

**Acceptance Criteria:**
- [ ] `buildPreviewSolid` accepts `geom.bandsZ` (an array of print-Z thresholds); when present, each top triangle is colored `BAND_COLORS[bandOf(centroidZ, bandsZ)]`, all three vertices identical.
- [ ] When `geom.bandsZ` is absent, coloring is byte-for-byte the current ramp/water/path behavior.
- [ ] `rebuildTiles` passes `bandsZ` when `s.colorBands`, computed in the preview print frame.
- [ ] A test asserts a top triangle at a known centroid Z receives the expected band color.

**Verify:** `cd tilejs && node --test 'test/color-bands-preview.test.mjs'` → pass; full suite green.

**Steps:**

- [ ] **Step 1: Write the failing test**

Create `tilejs/test/color-bands-preview.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPreviewSolid } from "../js/mesh.js";
import { BAND_COLORS } from "../js/color-bands.js";

// 2x2 grid, one cell → two top triangles. Flat elevation so every top vertex
// has the same z = base + (elev-emin)*mmPerM*exag; pick values landing in "rock".
test("buildPreviewSolid: band mode colors the top by centroid Z", () => {
  const gw = 2, gh = 2;
  const grid = new Float32Array([1500, 1500, 1500, 1500]); // metres
  const mask = new Uint8Array([1]);
  const geom = {
    dx: 1, dy: 1, offX: 0, offY: 0, mmPerM: 1, emin: 0, erange: 3000,
    exag: 1, base: 6,
    // thresholds in PRINT Z: base + (t-emin)*mmPerM*exag for t=[0,1000,1400,2000]
    bandsZ: [6, 1006, 1406, 2006],
  };
  const { positions, colors } = buildPreviewSolid(grid, gw, gh,
    { r0: 0, r1: 1, c0: 0, c1: 1 }, mask, geom);
  // top z = 6 + 1500 = 1506 → band 3 (rock: 1406 < 1506 ≤ 2006)
  // first top triangle occupies colors[0..8]; all three vertices == BAND_COLORS[3]
  assert.deepEqual([colors[0], colors[1], colors[2]], BAND_COLORS[3]);
  assert.deepEqual([colors[3], colors[4], colors[5]], BAND_COLORS[3]);
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd tilejs && node --test 'test/color-bands-preview.test.mjs'`
Expected: FAIL — top triangles use `ramp(...)`, not `BAND_COLORS[3]`.

- [ ] **Step 3: Add band coloring to `buildPreviewSolid`**

In `tilejs/js/mesh.js`, add `import { bandOf, BAND_COLORS } from "./color-bands.js";` at the top (with the other imports).

Change the geom destructure (line 35) to also pull `bandsZ`:

```js
  const { dx, dy, offX, offY, mmPerM, emin, erange, exag, base, oceanMask, pathMask, bandsZ } = geom;
```

Replace the top-triangle color loop (lines 77–83) with:

```js
  const zOf = (id) => base + (grid[id] - emin) * mmPerM * exag;
  for (let i = 0; i < topTris.length; i += 3) {
    let col;
    if (bandsZ) {
      // per-triangle flat band by centroid print-Z (mimics the horizontal M600 plane)
      const cz = (zOf(topTris[i]) + zOf(topTris[i + 1]) + zOf(topTris[i + 2])) / 3;
      col = BAND_COLORS[bandOf(cz, bandsZ)];
    }
    for (let k = 0; k < 3; k++) {
      const id = topTris[i + k];
      put(id, false, bandsZ ? col
        : pathMask && pathMask[id] ? PATH
        : oceanMask && oceanMask[id] ? WATER
        : ramp((grid[id] - emin) / erange));
    }
  }
```

(The skirt/base loops below — lines 84–91 — are unchanged, keeping `SIDE` gray.)

- [ ] **Step 4: Pass `bandsZ` from `rebuildTiles`**

In `tilejs/js/app.js` `rebuildTiles` (line 538), after `const dy = f.heightMm / (gh - 1);` (line 546), add:

```js
  let bandsZ = null;
  if (s.colorBands) {
    const cLat = (f.bbox[0] + f.bbox[2]) / 2;
    const K = mmPerM * s.exag;
    bandsZ = bandThresholds(cLat).map((t) => s.base + (t - min) * K);
  }
```

Then add `bandsZ` to the `buildPreviewSolid` geom object (line 556–559):

```js
    tiles.push(buildPreviewSolid(grid, gw, gh, sp, pv.masks ? pv.masks[idx] : mask, {
      dx, dy, offX: ux * gapX, offY: uy * gapY, oceanMask: oMask, pathMask,
      mmPerM, emin: min, erange, exag: s.exag, base: s.base, bandsZ,
    }));
```

(`bandThresholds` is already imported in Task 2. `min` is `baked.min`, already destructured at line 542.)

- [ ] **Step 5: Run tests**

Run: `cd tilejs && node --test 'test/color-bands-preview.test.mjs'` → PASS.
Run: `cd tilejs && node --test 'test/*.test.mjs'` → full suite green.

- [ ] **Step 6: Commit**

```bash
git add tilejs/js/mesh.js tilejs/js/app.js tilejs/test/color-bands-preview.test.mjs
git commit -m "feat(color-bands): preview top-surface banding"
```

---

### Task 4: PrusaSlicer color-change embed in the 3MF

**Goal:** Compute the export-frame change list and, when `embedColorChanges` is on, write it into the exported 3MF as a PrusaSlicer color-change part; geometry-only export stays byte-identical when off.

**Files:**
- Modify: `js/color-bands.js` (add `prusaColorChangeXML`)
- Modify: `js/threeMF.js` (optional color-change OPC part in `finish()`)
- Modify: `js/app.js` (`export3MF`: `emax`/`zmax`, `changes`, pass to writer)
- Test: `test/color-bands.test.mjs` (extend: XML serialization)
- Test: `test/threemf-colorchange.test.mjs` (new: writer emits/omits the part)

**Acceptance Criteria:**
- [ ] `prusaColorChangeXML(changes)` returns a well-formed `<custom_gcodes_per_layer>` document with one `<layer>` per change (`top_z`, `type="2"`, `extruder`, `color`, `gcode="M600"`) and a `<mode value="SingleExtruder"/>`.
- [ ] `ThreeMFWriter` accepts color changes; `finish()` adds the `Metadata/Prusa_Slicer_custom_gcode_per_print_z.xml` part **and** a `[Content_Types].xml` override for it when changes are present; nothing added when empty.
- [ ] Geometry-only 3MF (no changes) is byte-identical to before (regression).
- [ ] `export3MF` computes `emax`/`zmax`, builds `changes` when `s.colorBands`, and passes them to the writer only when `s.embedColorChanges`.

**Verify:** `cd tilejs && node --test 'test/*.test.mjs'` → pass. **Note:** whether PrusaSlicer actually loads the part is verified by hand in Task 5; if the reference format differs, correct the template here.

**Steps:**

- [ ] **Step 1: Obtain the PrusaSlicer reference (spike)**

The exact container is the one design unknown. Before/while implementing, the coordinator obtains a reference: in PrusaSlicer, add two color changes on the layer slider, **File → Save Project**, unzip the `.3mf`, and read the color-change part (part name, root element, attribute names, and the `type` integer for ColorChange). Replace the template in Step 2 if it differs from the assumed structure below. The assumed structure (best-known; correct if the reference differs):

```
Part: Metadata/Prusa_Slicer_custom_gcode_per_print_z.xml
<?xml version="1.0" encoding="UTF-8"?>
<custom_gcodes_per_layer>
 <plate>
  <plate_idx value="0"/>
  <layer top_z="6.4" type="2" extruder="1" color="#47967A" gcode="M600"/>
  <mode value="SingleExtruder"/>
 </plate>
</custom_gcodes_per_layer>
```

- [ ] **Step 2: Add `prusaColorChangeXML` + a test**

Append to `tilejs/js/color-bands.js`:

```js
const hex2 = (v) => Math.max(0, Math.min(255, Math.round(v * 255)))
  .toString(16).padStart(2, "0");
const bandHex = (rgb) => `#${hex2(rgb[0])}${hex2(rgb[1])}${hex2(rgb[2])}`;

// PrusaSlicer color-change container (custom gcode per print z). Structure pinned
// by the spike in the plan; `type="2"` = ColorChange. One <layer> per change.
export function prusaColorChangeXML(changes) {
  const layers = changes.map((c) =>
    `<layer top_z="${c.z.toFixed(3)}" type="2" extruder="1" color="${bandHex(c.color)}" gcode="M600"/>`
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<custom_gcodes_per_layer><plate><plate_idx value="0"/>` +
    layers + `<mode value="SingleExtruder"/></plate></custom_gcodes_per_layer>`;
}
```

Add to `tilejs/test/color-bands.test.mjs`:

```js
import { prusaColorChangeXML } from "../js/color-bands.js";

test("prusaColorChangeXML: one layer per change, hex color, M600", () => {
  const xml = prusaColorChangeXML([
    { z: 6.4, band: 2, color: [0.60, 0.62, 0.38] },
    { z: 9.1, band: 3, color: [0.55, 0.55, 0.55] },
  ]);
  const layers = xml.match(/<layer /g) || [];
  assert.equal(layers.length, 2);
  assert.match(xml, /top_z="6.400"/);
  assert.match(xml, /top_z="9.100"/);
  assert.match(xml, /color="#999e61"/); // 0.60,0.62,0.38 → 99 9e 61
  assert.match(xml, /gcode="M600"/);
  assert.match(xml, /<mode value="SingleExtruder"\/>/);
});
```

- [ ] **Step 3: Run the serialization test**

Run: `cd tilejs && node --test 'test/color-bands.test.mjs'` → PASS (includes the new XML test).

- [ ] **Step 4: Write the writer test (failing)**

Create `tilejs/test/threemf-colorchange.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { ThreeMFWriter } from "../js/threeMF.js";

const mesh = { // one degenerate triangle is enough to exercise the writer
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
};

// The color-change part name must appear in the zip bytes only when changes given.
const asText = (bytes) => new TextDecoder("latin1").decode(bytes);

test("ThreeMFWriter: no color-change part by default", async () => {
  const w = new ThreeMFWriter();
  await w.addObject("t", mesh, 0, 0);
  const bytes = await w.finish();
  assert.ok(!asText(bytes).includes("custom_gcode_per_print_z"));
});

test("ThreeMFWriter: embeds the color-change part when changes are set", async () => {
  const w = new ThreeMFWriter();
  w.setColorChanges([{ z: 6.4, band: 2, color: [0.6, 0.62, 0.38] }]);
  await w.addObject("t", mesh, 0, 0);
  const bytes = await w.finish();
  const text = asText(bytes);
  assert.ok(text.includes("Prusa_Slicer_custom_gcode_per_print_z.xml"));
  assert.ok(text.includes("custom_gcodes_per_layer"));
  assert.ok(text.includes('top_z="6.400"'));
});
```

Run: `cd tilejs && node --test 'test/threemf-colorchange.test.mjs'`
Expected: FAIL — `w.setColorChanges is not a function`.

- [ ] **Step 5: Add the writer support**

In `tilejs/js/threeMF.js`:

Add the import at the top (after the `zip.js` import):

```js
import { prusaColorChangeXml as _unused } from "./color-bands.js"; // (see below)
```

Actually import the real name:

```js
import { prusaColorChangeXML } from "./color-bands.js";
```

Add a `CONTENT_TYPES` variant with the extra override. Replace the single `CONTENT_TYPES` const (lines 7–8) with a base + a helper:

```js
const CT_HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>`;
const CT_TAIL = `</Types>`;
const CGCODE_PART = "Metadata/Prusa_Slicer_custom_gcode_per_print_z.xml";
const CGCODE_OVERRIDE =
  `<Override PartName="/${CGCODE_PART}" ContentType="application/xml"/>`;
```

In the constructor, initialize the field (after `this.finished = false;`, line 28):

```js
    this.colorChanges = null;
```

Add the setter method (anywhere in the class, e.g. after the constructor):

```js
  // Optional PrusaSlicer color-change-by-height metadata; embedded at finish().
  setColorChanges(changes) { this.colorChanges = changes && changes.length ? changes : null; }
```

In `finish()`, replace the `return buildZip([...])` block (lines 96–100) with:

```js
    const entries = [
      entry("[Content_Types].xml", CT_HEAD + (this.colorChanges ? CGCODE_OVERRIDE : "") + CT_TAIL),
      entry("_rels/.rels", RELS),
      { name: "3D/3dmodel.model", data: model, crc: this.crc, size: this.rawSize, method: this.method },
    ];
    if (this.colorChanges) entries.push(entry(CGCODE_PART, prusaColorChangeXML(this.colorChanges)));
    return buildZip(entries);
```

Remove the stray `_unused` import line if it was added; keep only `import { prusaColorChangeXML } from "./color-bands.js";`.

Run: `cd tilejs && node --test 'test/threemf-colorchange.test.mjs'` → PASS.

- [ ] **Step 6: Wire `export3MF`**

In `tilejs/js/app.js` `export3MF`, right after `const emin = gridRange(stampedC).min;` (line 642), add:

```js
    const emax = gridRange(stampedC).max;
```

Then replace the writer construction (line 653 `const writer = new ThreeMFWriter();`) with:

```js
    const writer = new ThreeMFWriter();
    if (s.colorBands && s.embedColorChanges) {
      const cbLat = (f.bbox[0] + f.bbox[2]) / 2;
      const zmax = s.base + (emax - emin) * k; // k = mmPerM*exag, defined at line 585
      writer.setColorChanges(colorChanges(bandThresholds(cbLat), {
        emin, base: s.base, mmPerM, exag: s.exag, zmax,
      }));
    }
```

(`gridRange`, `colorChanges`, `bandThresholds`, `k`, `mmPerM`, `f` are all already in scope in `export3MF`.)

- [ ] **Step 7: Run the full suite**

Run: `cd tilejs && node --test 'test/*.test.mjs'`
Expected: PASS — including the new writer + XML tests, and the byte-identical regression (no changes → no extra part).

- [ ] **Step 8: Commit**

```bash
git add tilejs/js/color-bands.js tilejs/js/threeMF.js tilejs/js/app.js tilejs/test/color-bands.test.mjs tilejs/test/threemf-colorchange.test.mjs
git commit -m "feat(color-bands): embed PrusaSlicer color changes in 3MF"
```

---

### Task 5: Verify embedded color changes load in PrusaSlicer

**Goal:** Confirm that a real exported `.3mf` with embedding on loads its color changes in PrusaSlicer at the expected heights and colors; correct the container format (Task 4) if the reference differs.

**USER-ORDERED GATE — NON-SKIPPABLE.** This task was requested by the user in the current conversation. It MUST NOT be closed by walking around it, by declaring it "verified inline", or by substituting a cheaper check. Close only after every item in `acceptanceCriteria` has been re-validated independently, with output captured.

**Files:**
- Modify (only if the format is wrong): `js/color-bands.js` (`prusaColorChangeXML`), `js/threeMF.js` (part name / content type)

**Acceptance Criteria:**
- [ ] Export a layout with "Altitude color bands" + "Embed color changes" on; note the readout's change heights/colors.
- [ ] Open the exported `.3mf` **as a project** in PrusaSlicer; color-change markers appear on the vertical layer slider at Z ≈ the readout heights (within a layer height), each swatch matching the band color.
- [ ] Slicing shows the color bands at those heights in the preview (M600 inserted).
- [ ] If markers are absent or misplaced, the real container format from the saved-project reference is applied to Task 4 and re-verified.

**Verify:** Manual — open `tilejs_export.3mf` as a project in PrusaSlicer; confirm color-change markers on the layer slider at the readout heights with matching swatches. (No automated command; this is a desktop-app check.)

**Steps:**

- [ ] **Step 1: Produce a test export**

In the app: place a layout spanning a range of altitudes (e.g. a mountainous area), enable "Altitude color bands" and "Embed color changes in 3MF", read off the change heights/colors from the readout, and Export 3MF.

- [ ] **Step 2: Open as a project in PrusaSlicer**

File → Open Project (not "Import"). Inspect the vertical layer slider for color-change markers.

- [ ] **Step 3: Compare against the readout**

Confirm each marker's Z matches a readout height (±one layer) and its color matches the band. Slice and check the preview shows the bands.

- [ ] **Step 4: If wrong — capture the real format and fix**

Save this same project from PrusaSlicer, unzip, and diff the color-change part against `prusaColorChangeXML`'s output (part name, root/element/attribute names, `type` integer, content-types/rels). Apply the corrections to Task 4's `prusaColorChangeXML` / `threeMF.js`, re-run `node --test 'test/*.test.mjs'`, re-export, and repeat from Step 2.

- [ ] **Step 5: Commit any format corrections**

```bash
git add tilejs/js/color-bands.js tilejs/js/threeMF.js
git commit -m "fix(color-bands): match PrusaSlicer color-change container format"
```

---

## Self-Review notes

- **Spec coverage:** core module (T1), state+UI+readout+plate-global warning (T2), preview banding (T3), embed + emax/zmax + byte-identical regression (T4), PrusaSlicer verification / spike (T5). Caveats (open-as-project, below-sea basins, readout-vs-export drift) surface in the UI hints (T2) and readout (approximate frame). All spec sections mapped.
- **First-filament fix:** spec said `bandOf(emin)`; corrected to `baseBand(emin)` (T1) so a sea-level `emin==0` tile reports green, not blue. Spec line updated to match.
- **Type consistency:** `bandsZ` (print-Z thresholds) used in T3 matches its producer in `rebuildTiles`; `setColorChanges`/`colorChanges`/`prusaColorChangeXML` names consistent across T4 and tests.
