# Flat-Ocean Recess Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Treat coastal ocean as a flat plane at sea level: keep the z≤10 fetch for detection only, discard bathymetry depth, recess all ocean to one flat plane, and make the separate water insert a flat slab.

**Architecture:** Terrarium tiles carry no reliable coastal seafloor above z10 (land DEMs overwrite water with a 0 sea-surface fill), and z10 seafloor is too coarse to print. So the terrain bake recesses every detected ocean vertex to `-waterDrop/k` (existing `recessedGrid`, now the only path), and the optional separate insert becomes a constant-thickness slab. This deletes the prior "insert seats proud" bug — flat recess floor ≡ flat slab underside by construction. It is a net code deletion.

**Tech Stack:** Vanilla ES modules (no build). Tests: `node --test`. Meshing via `js/mesh.js buildSolid`; ocean detection via `js/water.js`.

**User decisions (already made):**
- "let's do flat ocean for now" — flat 0 m ocean, no bathymetry depth.
- Keep the z≤10 fetch for detection only (fine-grid water is undetectable — probed 2026-07-13).
- "document these other thoughts for a later feature" — high-res bathymetry (NOAA CUDEM) and vector/landcover detection are logged in `TODO.md`, out of scope here.
- Separate-insert mode stays (two-colour water), just as a flat slab.

**Spec:** `docs/superpowers/specs/2026-07-13-flat-ocean-recess-design.md`

---

### Task 1: Flatten the ocean bake and insert

**Goal:** Delete `offsetGrid`, collapse `bakeWater` to always flat-recess, replace the export water-insert bathymetry molding with a flat slab, and rewrite the insert tests (with a non-tautological registration test).

**Files:**
- Modify: `tilejs/js/water.js` (delete `offsetGrid`, lines 61-69)
- Modify: `tilejs/js/app.js` (import 13-14; `bakeWater` 72-84; insert build 792-818)
- Modify: `tilejs/test/water.test.mjs` (import 3-4; `offsetGrid` test + insert section 115-202)

**Acceptance Criteria:**
- [ ] `offsetGrid` no longer exists in `js/water.js` and is not imported anywhere (`grep -rn offsetGrid tilejs/js tilejs/test` → no matches).
- [ ] `bakeWater` returns `recessedGrid(rawGrid, oMask, -s.waterDrop / k)` for any ocean mask (no `insertMode` branch).
- [ ] The export water insert is built from a zero grid via `buildSolid(slab, …, {emin:0, base:s.waterDrop})` — no `depthFlip`, `oceanCellsFlip`, or flipped span; `waterT` is no longer referenced in the insert block.
- [ ] `test/water.test.mjs` insert tests assert: flat slab is watertight; every vertex is at z=0 or z=waterDrop; and slab thickness + measured terrain recess floor reaches sea level (built from real meshes).
- [ ] The bathymetry-flood detection regressions remain and pass.

**Verify:** `cd tilejs && node --test 'test/*.test.mjs'` → all pass, 0 failures.

**Steps:**

- [ ] **Step 1: Rewrite the insert tests (red).** In `tilejs/test/water.test.mjs`, remove `offsetGrid` from the import and replace the `offsetGrid` test + the entire "separate water insert" section (fixture, `topZ`, and its three tests) with the flat-slab section.

  Change the import (lines 3-4) from:
```js
import { oceanMask, oceanMaskSeeded, cellOcean, erodeMask, recessedGrid,
  offsetGrid } from "../js/water.js";
```
  to:
```js
import { oceanMask, oceanMaskSeeded, cellOcean, erodeMask, recessedGrid } from "../js/water.js";
```

  Replace everything from `test("offsetGrid lowers only ocean vertices, keeps their relief", …` (line 115) through the end of the `"water insert: flipped piece registers with the offset terrain"` test (line 202, its closing `});`) with:
```js
// --- separate water insert (flat slab, printed flat face down) --------------
// The insert fills the flat ocean recess to sea level: a constant-thickness
// slab (thickness = waterDrop). Bathymetry is discarded, so there is no molded
// underside and no north-south flip — flat top and bottom share the terrain's
// XY frame, so the slab drops into the recess as printed.

const DROP = 3, MM_PER_M = 0.01, EXAG = 2; // 1:100000, 2× exaggeration
const K = MM_PER_M * EXAG;

function slabFixture() {
  const gw = 5, gh = 6, dx = 1, dy = 1;
  const e = new Float32Array(gw * gh).fill(10);
  // left two columns are open sea (edge-connected); their depth is irrelevant now
  for (let r = 0; r < gh; r++) { e[r * gw + 0] = -100; e[r * gw + 1] = -50; }
  const oMask = oceanMask(e, gw, gh, 0);
  const cells = cellOcean(oMask, gw, gh); // col-0 cells only
  const slab = new Float32Array(gw * gh); // flat top at sea level
  const solid = buildSolid(slab, gw, gh,
    { r0: 0, r1: gh - 1, c0: 0, c1: gw - 1 }, cells,
    { dx, dy, mmPerM: 1, emin: 0, exag: 1, base: DROP });
  return { gw, gh, dx, dy, e, oMask, cells, solid };
}

test("water insert: flat slab is a closed manifold", () => {
  const { solid } = slabFixture();
  const w = checkWatertight(solid);
  assert.ok(w.closed, `unmatched edges: ${w.unmatched}`);
});

test("water insert: every vertex is at z=0 (base) or z=DROP (top)", () => {
  const { solid } = slabFixture();
  const P = solid.positions;
  let zmin = Infinity, zmax = -Infinity;
  for (let i = 2; i < P.length; i += 3) {
    const z = P[i];
    assert.ok(Math.abs(z) < 1e-6 || Math.abs(z - DROP) < 1e-6, `z ${z} not 0 or ${DROP}`);
    zmin = Math.min(zmin, z); zmax = Math.max(zmax, z);
  }
  assert.equal(zmin, 0); assert.equal(zmax, DROP);
});

test("water insert: slab thickness + measured recess floor reaches sea level", () => {
  const { gw, gh, dx, dy, e, oMask, solid } = slabFixture();
  // slab thickness, measured from the slab mesh
  const sp = solid.positions;
  let sMin = Infinity, sMax = -Infinity;
  for (let i = 2; i < sp.length; i += 3) { sMin = Math.min(sMin, sp[i]); sMax = Math.max(sMax, sp[i]); }
  const slabThk = sMax - sMin;

  // build the TERRAIN solid the export builds: flat recess via recessedGrid
  const baked = recessedGrid(e, oMask, -DROP / K);
  let emin = Infinity; for (const v of baked) emin = Math.min(emin, v);
  const TBASE = 5;
  const terrain = buildSolid(baked, gw, gh,
    { r0: 0, r1: gh - 1, c0: 0, c1: gw - 1 },
    new Uint8Array((gw - 1) * (gh - 1)).fill(1),
    { dx, dy, mmPerM: MM_PER_M, emin, exag: EXAG, base: TBASE });
  // recess-floor z = the lowest top-surface z, measured from the terrain mesh
  // (top-surface z's are all > 0; the base plate sits at exactly 0)
  const tz = terrain.positions;
  let recessFloorZ = Infinity;
  for (let i = 2; i < tz.length; i += 3) if (tz[i] > 1e-6) recessFloorZ = Math.min(recessFloorZ, tz[i]);
  // sea level in the terrain's print frame (elevation 0)
  const seaLevelZ = TBASE + (0 - emin) * K;
  // a slab seated on the measured recess floor must top out at sea level
  assert.ok(Math.abs((recessFloorZ + slabThk) - seaLevelZ) < 1e-4,
    `recessFloor ${recessFloorZ} + slab ${slabThk} != seaLevel ${seaLevelZ}`);
});
```

- [ ] **Step 2: Run the tests to verify they fail.**

  Run: `cd tilejs && node --test test/water.test.mjs`
  Expected: FAIL — the suite still imports `offsetGrid` from `water.js` (still present), and the new registration test builds against the still-bathymetric bake indirectly; the immediate failure is that the deleted `topZ`/old-fixture references are gone while `offsetGrid` is now unused-imported-then-removed. (The point of this step is a red bar before the code change.)

- [ ] **Step 3: Delete `offsetGrid` from `js/water.js`.** Remove lines 61-69 (the comment block and the function):
```js
// Copy of the elevation grid with ocean vertices lowered by dropElev (elevation
// units); land untouched. Keeps the ocean-floor relief — used by the separate-
// insert mode, where the recess floor is real bathymetry and the insert fills
// the drop back up to sea level.
export function offsetGrid(elev, vmask, dropElev) {
  const out = Float32Array.from(elev);
  for (let i = 0; i < out.length; i++) if (vmask[i]) out[i] -= dropElev;
  return out;
}
```
  Leave `recessedGrid`, `oceanMask`, `oceanMaskSeeded`, `cellOcean`, `erodeMask` untouched.

- [ ] **Step 4: Collapse `bakeWater` and drop the import in `js/app.js`.** Change the import (lines 13-14) from:
```js
import { oceanMask, oceanMaskSeeded, cellOcean, erodeMask, recessedGrid,
  offsetGrid } from "./water.js";
```
  to:
```js
import { oceanMask, oceanMaskSeeded, cellOcean, erodeMask, recessedGrid } from "./water.js";
```
  Replace `bakeWater` (lines 72-84):
```js
// Ocean bake on any grid, given its ocean vertex mask. Plain mode recesses
// open ocean to one sunken plane; insert mode keeps the ocean-floor relief,
// lowered by the drop (exag-corrected so the print-z drop is exactly waterDrop).
function bakeWater(s, rawGrid, oMask, k) {
  if (!oMask) return rawGrid;
  // insert mode keeps ocean-floor relief (lowered by the drop) and needs a real
  // ≥1 mm drop — the insert's shore-edge thickness. Every other case is a flat
  // recess, so no state combination yields a bathymetry recess with no insert.
  const insertMode = s.waterSeparate && s.waterDrop >= 1;
  return insertMode
    ? offsetGrid(rawGrid, oMask, s.waterDrop / k)
    : recessedGrid(rawGrid, oMask, -s.waterDrop / k);
}
```
  with:
```js
// Ocean bake: recess every ocean vertex to one flat plane, waterDrop mm below
// sea level (exag-corrected so the print-z drop is exactly waterDrop). Bathymetry
// is discarded — the geometry grid has no reliable coastal seafloor (land DEMs
// overwrite it with a 0 sea-surface fill above z10) and z10 seafloor is too
// coarse to print. Separate-insert mode fills this recess with a flat slab; the
// terrain bake is identical in both modes.
function bakeWater(s, rawGrid, oMask, k) {
  if (!oMask) return rawGrid;
  return recessedGrid(rawGrid, oMask, -s.waterDrop / k);
}
```

- [ ] **Step 5: Replace the export insert build with a flat slab in `js/app.js`.** Replace lines 792-818:
```js
      // water insert for this tile: printed top follows the ocean floor
      // (depth·scale above the drop), flat face at z=0 is the sea surface;
      // prints flat face down, flips north-south into the recess, so its
      // depth grid and cell mask are built row-mirrored within the window
      if (wantWater && oMaskT) {
        const rings = Math.max(1, Math.ceil(WATER_CLEAR_MM / dx)); // shore clearance
        const oceanCells = erodeMask(cellOcean(oMaskT, gwT, ghT), cw, ghT - 1, rings);
        if (s.shape !== "square") for (let i2 = 0; i2 < oceanCells.length; i2++) oceanCells[i2] &= mask[i2];
        const oc = countIn(oceanCells, span, cw);
        if (oc > 0) {
          const depthFlip = new Float32Array(gwT * ghT);
          for (let r = 0; r < ghT; r++) {
            for (let c = 0; c < gwT; c++) {
              depthFlip[(ghT - 1 - r) * gwT + c] = Math.max(0, -waterT[r * gwT + c]);
            }
          }
          const oceanCellsFlip = new Uint8Array(cw * (ghT - 1));
          for (let r = 0; r < ghT - 1; r++) {
            oceanCellsFlip.set(oceanCells.subarray(r * cw, (r + 1) * cw), (ghT - 2 - r) * cw);
          }
          const wsolid = buildSolid(depthFlip, gwT, ghT,
            { r0: ghT - 1 - span.r1, r1: ghT - 1 - span.r0, c0: span.c0, c1: span.c1 },
            oceanCellsFlip, { dx, dy, mmPerM, emin: 0, exag: s.exag, base: s.waterDrop });
          nw++;
          await add(`water_i${ci}_j${cj}`, wsolid, ...belowAt(cell, 0));
        }
      }
```
  with:
```js
      // water insert for this tile: a flat slab that fills the flat recess to
      // sea level (thickness = waterDrop). Prints as a separate (e.g. blue)
      // piece; flat top and bottom share the terrain's XY frame, so it drops
      // into the recess as printed — no molded underside, no north-south flip.
      if (wantWater && oMaskT) {
        const rings = Math.max(1, Math.ceil(WATER_CLEAR_MM / dx)); // shore clearance
        const oceanCells = erodeMask(cellOcean(oMaskT, gwT, ghT), cw, ghT - 1, rings);
        if (s.shape !== "square") for (let i2 = 0; i2 < oceanCells.length; i2++) oceanCells[i2] &= mask[i2];
        if (countIn(oceanCells, span, cw) > 0) {
          const slab = new Float32Array(gwT * ghT); // flat top at sea level
          const wsolid = buildSolid(slab, gwT, ghT, span, oceanCells,
            { dx, dy, mmPerM: 1, emin: 0, exag: 1, base: s.waterDrop });
          nw++;
          await add(`water_i${ci}_j${cj}`, wsolid, ...belowAt(cell, 0));
        }
      }
```

- [ ] **Step 6: Run the full suite to verify green.**

  Run: `cd tilejs && node --test 'test/*.test.mjs'`
  Expected: PASS — all tests, 0 failures. Confirm `grep -rn offsetGrid tilejs/js tilejs/test` returns nothing.

- [ ] **Step 7: Commit.**
```bash
git add tilejs/js/water.js tilejs/js/app.js tilejs/test/water.test.mjs
git commit -m "feat(water): flat-ocean recess + flat insert slab; drop bathymetry"
```

---

### Task 2: Reword stale water comments and the UI hint

**Goal:** Update comments and the user-facing water hint that still describe bathymetry depth / the flip, which the flat-ocean change made false.

**Files:**
- Modify: `tilejs/js/app.js` (`WATER_ZOOM_MAX` comment ~49-52, and detection comments at the `bathymetry` sites)
- Modify: `tilejs/index.html` (water hint ~74-77)

**Acceptance Criteria:**
- [ ] The `WATER_ZOOM_MAX` comment describes z≤10 as the detection floor (clean negative water signal; land DEMs 0-fill above z10), not "insert depths."
- [ ] No code comment claims the insert follows the ocean floor or "flips into the recess"; no comment implies bathymetry depth is used.
- [ ] The `index.html` water hint describes a flat blue slab that drops into the recess as printed (no flip).
- [ ] `cd tilejs && node --test 'test/*.test.mjs'` still passes (comment/text-only change).

**Verify:** `cd tilejs && node --test 'test/*.test.mjs'` → all pass, 0 failures; and `grep -n "ocean floor\|flips into\|flips north-south\|real bathymetry" tilejs/js/app.js tilejs/index.html` → no matches.

**Steps:**

> Note: after Task 1, absolute line numbers in `app.js` have shifted. Match by content (the Edit tool matches strings), not line number.

- [ ] **Step 1: Reword the `WATER_ZOOM_MAX` comment in `js/app.js`.** Replace:
```js
// terrarium carries real bathymetry only at low zooms (probed 2026-07: Puget
// Sound min −248 m at z10; +0.5–2 m land-DEM junk at z11). Water classification
// and insert depths must never read finer than this.
const WATER_ZOOM_MAX = 10;
```
  with:
```js
// z≤10 is the deepest zoom whose ocean is a clean, consistently-negative signal.
// Above it, land DEMs (SRTM/NED) overwrite coastal water with a 0/positive sea-
// surface fill (probed 2026-07: Puget Sound −248 m at z10, ~0 at z11+), so ocean
// DETECTION must never read finer than this. Depth is discarded (flat recess).
const WATER_ZOOM_MAX = 10;
```

- [ ] **Step 2: Reword the preview ocean-mask comment in `js/app.js`.** Replace:
```js
  const oMask = s.waterDrop > 0 ? oceanMask(waterGrid, gw, gh, 0) : null; // sea level = 0, bathymetry-valid data
```
  with:
```js
  const oMask = s.waterDrop > 0 ? oceanMask(waterGrid, gw, gh, 0) : null; // sea level = 0, on the z≤10 detection view
```

- [ ] **Step 3: Reword the preview water-fetch comment in `js/app.js`.** Replace:
```js
    // small coastal regions preview at z>WATER_ZOOM_MAX, where bathymetry is
    // land-DEM junk; fetch the coarse mosaic unconditionally so raising
    // waterDrop later doesn't need a reload (it's 1-4 tiles for these regions)
```
  with:
```js
    // small coastal regions preview at z>WATER_ZOOM_MAX, where the geometry grid's
    // water is a land-DEM 0-fill; fetch the coarse detection mosaic unconditionally
    // so raising waterDrop later doesn't need a reload (1-4 tiles for these regions)
```

- [ ] **Step 4: Reword the export water-fetch comment in `js/app.js`.** Replace:
```js
    // water reads from a coarser mosaic when zC is finer than bathymetry-valid;
    // reuse mosaicC (no extra fetch) when it's already coarse enough
```
  with:
```js
    // ocean detection reads from a coarser mosaic when zC is finer than z≤10;
    // reuse mosaicC (no extra fetch) when it's already coarse enough
```

- [ ] **Step 5: Reword the per-tile ocean-flood comment in `js/app.js`.** Replace:
```js
      // ocean: flood the bathymetry view of this window from coarse-mask
      // seeds (edge-connectivity is global; the geometry grid has no valid
      // water signal at z>WATER_ZOOM_MAX)
```
  with:
```js
      // ocean: flood the z≤10 detection view of this window from coarse-mask
      // seeds (edge-connectivity is global; the geometry grid has no valid
      // water signal at z>WATER_ZOOM_MAX)
```

- [ ] **Step 6: Reword the water hint in `index.html`.** Replace:
```html
          <p class="hint">Recesses open ocean (sea-level, edge-connected) so it
            reads as water; inland basins stay land. Insert = a blue piece over
            the real ocean floor, topping out at sea level (needs ≥1&nbsp;mm
            drop); it prints flat face down, then flips into the recess.</p>
```
  with:
```html
          <p class="hint">Recesses open ocean (sea-level, edge-connected) so it
            reads as water; inland basins stay land. Insert = a flat blue slab
            filling the recess to sea level (needs ≥1&nbsp;mm drop); it prints
            flat and drops into the recess as-is.</p>
```

- [ ] **Step 7: Verify and commit.**

  Run: `cd tilejs && node --test 'test/*.test.mjs'` → all pass; `grep -n "ocean floor\|flips into\|flips north-south\|real bathymetry" tilejs/js/app.js tilejs/index.html` → no matches.
```bash
git add tilejs/js/app.js tilejs/index.html
git commit -m "docs(water): reword comments + UI hint for flat-ocean recess"
```

---

## Self-Review

**Spec coverage:** delete `offsetGrid` (T1 S3) ✓; collapse `bakeWater` (T1 S4) ✓; flat insert slab (T1 S5) ✓; rewrite insert tests non-tautologically (T1 S1) ✓; keep detection regressions (untouched in T1) ✓; comment sweep + hint (T2) ✓; `index.html` (T2 S6) ✓. No spec requirement is unmapped.

**Placeholder scan:** every code/text step shows the exact before/after. No TBD/vague steps.

**Type consistency:** `bakeWater(s, rawGrid, oMask, k)` signature and its three call sites are unchanged (only the body). `buildSolid(grid, gw, gh, span, mask, geom)` argument order matches `js/mesh.js` and the existing calls. `slabFixture`/`DROP`/`K` are self-consistent within the test file.
