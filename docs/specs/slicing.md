# Slicing

What a slicer does with a terranejs export. Every claim was read from PrusaSlicer's
source or measured by slicing a probe; each names its source. Add to this file rather
than rediscovering.

Assumes FFF, no raft, object on the bed, constant layer height unless stated otherwise.
`fh` = first layer height, `h` = layer height.

## The layer grid

    top(k)   = fh + (k − 1)·h          layer k's top ("print_z"), k ≥ 1
    slice(k) = top(k) − height(k)/2    where height(1) = fh, height(k>1) = h

Source: `generate_object_layers` in `Slicing.cpp`, `new_layers` in
`PrintObjectSlice.cpp`.

- The grid is anchored at the **bed**, so it lands on multiples of `h` only when
  `fh == h`. A 0.2 mm first layer over 0.15 mm layers puts every boundary 0.05 mm off
  a multiple of 0.15.
- **A column prints layer k iff its surface reaches `slice(k)`**, inclusive — a surface
  exactly on the plane still prints (measured). Detail finer than half a layer does not
  survive slicing.

Adaptive layer height replaces these formulas with the height profile. A raft shifts
every layer up by its thickness (`SlicingParameters`).

## Color changes

**A change written at height P takes effect on the first layer whose *top* ≥ P, and
that layer prints in the new color.** The layer straddling P is already new-colored;
any P in a layer's `(bottom, top]` interval names that layer.

Source: `ToolOrdering::assign_custom_gcodes` (`EPSILON = 1e-4` from `libslic3r.h`),
emitted at layer start by `GCode.cpp`.

Let `zLine = base + (line − emin)·mmPerM·exag` (the model height of the color line)
and `W = max{ k : slice(k) ≤ zLine }` (water's topmost printed layer):

    pause     P = top(W + 1)      earliest change that keeps every water column blue
    boundary    slice(W + 1)      model height where the print changes color

The preview must band at `slice(W + 1)`:
- Not at `zLine` — that would show land buried in the water color.
- Not at P — that would show water color on a layer of land the print gets right.

**Both need `fh`,** which the export cannot pin (see config trap below). It must be
an input, defaulting to PrusaSlicer's 0.2 mm. Impact on Bora Bora at 1:80 000,
200 mm, exaggeration 1, base 6 mm, `zLine = 6.000`, `h = 0.15`:

| fh | exact P | boundary | land printing water-colored |
|---|---|---|---|
| 0.15 | 6.150 | +6.0 m | 27.4% |
| 0.20 | 6.200 | +10.0 m | 41.0% |
| 0.25 | 6.100 | +2.0 m | 6.3% |

A third of the tile's land changes color on `fh` alone. The old heuristic `zLine + h`
is correct only when the line falls in the upper half of its layer, and a full layer
late otherwise (0.25 row: emits 6.250 where 6.100 was available).

### Why the defaults are 0.2 over 0.1

`boundary − zLine` is a **sawtooth**: the offset shrinks toward 0 as the line rises
through a layer, then snaps back to a full `h` when it crosses a slice plane. Landing
exactly on a layer **top** puts you at `h/2` — maximally far from the snap in both
directions, so small changes to base or exaggeration move the boundary smoothly
instead of jumping a whole layer.

A whole-mm base hits a layer top when `h` divides `base − fh`. With `fh = 0.2` over
bases 1–10 mm, this holds for every base at `h` ∈ {0.05, 0.1, 0.2} but only at 2, 5,
and 8 mm for `h = 0.15`. Hence `DEFAULT_LAYER_MM = 0.1`: at the default 6 mm base the
offset is 0.050 mm (half a layer from the snap) vs 0.125 mm at 0.15. On Bora Bora:
+4.0 m boundary and 16.0% land in water color, vs +10.0 m and 41.0% at 0.15.

Relief finer than half a layer cannot be colored by a pause. For low-lying terrain
(atolls, deltas), use the inserts path (`lakes`, `all`) where water is a separate part
in its own filament and the boundary is planform-exact.

## The project-config trap

**The embedded config must stay empty.** PrusaSlicer reads color changes only from a
project 3MF (one with `Metadata/Slic3r_PE.config`), but a *non-empty* config replaces
the user's print/filament/printer presets with PrusaSlicer defaults
(`Plater::priv::load_files` starts from `FullPrintConfig::defaults()` and overlays).
An empty config takes the `config_loaded.empty()` branch and applies nothing.

## Other slicers

We write `Metadata/Prusa_Slicer_custom_gcode_per_print_z.xml`. OrcaSlicer and Bambu
Studio read `Metadata/custom_gcode_per_layer.xml` instead (`bbs_3mf.cpp`), so our
exports open there as geometry with no color swaps. Same semantics, different filename.

Also: `assign_custom_gcodes` silently drops single-extruder color changes when the
printer is multi-extruder and the file's mode is `SingleExtruder` — an MMU profile
shows no swaps for reasons unrelated to the model.

## Verifying

`node scripts/pause-probe.mjs <out.3mf>` builds a probe: 13 pillars starting at
`zLine`, each 0.025 mm taller, plus predicted behavior per grid. Sliced in PrusaSlicer
on four grids — predicted and observed agreed on every row:

| fh | h | swap | pillars in the second filament |
|---|---|---|---|
| 0.20 | 0.15 | layer 41, 6.200 mm | 8 |
| 0.15 | 0.15 | layer 41, 6.150 mm | 10 |
| 0.25 | 0.15 | layer 41, 6.250 mm | 6 |
| 0.20 | 0.20 | layer 31, 6.200 mm | 9 |

Rerun it against any new slicer or version before trusting the arithmetic there.
