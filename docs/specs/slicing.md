# Slicing

What a slicer does with a terranejs export, and what the export therefore has to
model. Everything here was read out of PrusaSlicer's source or measured by slicing a
probe; each claim names where it came from. Add to this file rather than rediscovering
— that is the whole point of it.

Unless a section says otherwise: FFF, no raft, the object sitting on the bed, constant
layer height. `fh` is the first layer height, `h` the layer height.

## The layer grid

    top(k)   = fh + (k − 1)·h          layer k's top ("print_z"), k ≥ 1
    slice(k) = top(k) − height(k)/2    where height(1) = fh, height(k>1) = h

`generate_object_layers` emits the first layer top at `first_object_layer_height` and
steps by `layer_height` from there, with `object_print_z_min = 0` (`Slicing.cpp`);
`new_layers` gives each layer `slice_z = 0.5·(lo + hi)` (`PrintObjectSlice.cpp`). Two
consequences:

- The grid is anchored at the **bed**, so it lands on multiples of `h` only when
  `fh == h`. PrusaSlicer's common 0.2 mm first layer over 0.15 mm layers puts every
  boundary 0.05 mm off a multiple of 0.15.
- **A column prints layer k only if its surface reaches `slice(k)`**, inclusive — a
  surface exactly on the plane still prints (measured). Detail finer than half a layer
  does not survive slicing at all.

Adaptive/variable layer height voids these formulas — `top(k)` becomes whatever the
height profile says. A raft shifts every layer up by its thickness (`SlicingParameters`).

## Color changes

**A change written at height P takes effect on the first layer whose *top* is at or
above P, and that layer prints in the new color.** `ToolOrdering::assign_custom_gcodes`
skips changes while `print_z > layer.print_z + EPSILON` and assigns when
`print_z > print_z_below + 0.5·EPSILON` (`EPSILON = 1e-4`, `libslic3r.h`); `GCode.cpp`
emits it at the start of that layer. The layer that *straddles* P — starts below, ends
above — is already new-colored. Any P inside a layer's `(bottom, top]` interval names
that layer, so `bottom + ε` and `top` are equivalent.

With `zLine = base + (line − emin)·mmPerM·exag`, the model height of the color line,
and `W = max{ k : slice(k) ≤ zLine }` the water's topmost printed layer:

    pause     P = top(W + 1)      the earliest change that leaves every water column blue
    boundary    slice(W + 1)      the model height where the print changes color

The preview must band at `slice(W + 1)`. Not at `zLine` — that shows land the print
buries in the water color — and not at P, which shows water color across a layer of
land the print gets right.

**Both need `fh`,** and the export cannot pin it (see the config trap). It has to be
an input, defaulting to PrusaSlicer's 0.2 mm. The size of that dependence, on Bora
Bora at 1:80000, 200 mm, exaggeration 1, base 6 mm, `zLine = 6.000`, `h = 0.15`:

| fh | exact P | boundary | land printing water-colored |
|---|---|---|---|
| 0.15 | 6.150 | +6.0 m | 27.4% |
| 0.20 | 6.200 | +10.0 m | 41.0% |
| 0.25 | 6.100 | +2.0 m | 6.3% |

A third of the tile's land changes color on `fh` alone, with the model, the line and
the layer height all identical. `zLine + h` — what the export emitted before this
document — is right only when the line falls in the upper half of its layer, and a
full layer late otherwise (the 0.25 row: it emits 6.250 where 6.100 was available).

### Why the defaults are 0.2 over 0.1

`boundary − zLine` is a **sawtooth**, not a constant. Slide the line up through a
layer and the offset shrinks toward 0, then snaps back to a full `h` the moment the
line crosses a slice plane. A line landing exactly on a layer **top** sits at `h/2` —
not the smallest offset available, but the one furthest from that snap in both
directions, so a nudge in base, exaggeration or line elevation moves the printed
boundary smoothly instead of a whole layer at once.

A whole-mm base lands on a layer top exactly when `h` divides `base − fh`. Over bases
1–10 mm with `fh = 0.2`, that holds for every base at `h` ∈ {0.05, 0.1, 0.2} and only
at 2, 5 and 8 mm for `h = 0.15`. Hence `DEFAULT_LAYER_MM = 0.1`: at the default 6 mm
base the offset is 0.050 mm, half a layer from the snap, against 0.125 mm and 0.17 of
a layer from it at 0.15. On Bora Bora that is a +4.0 m boundary rather than +10.0 m,
and 16.0% of the tile's land printing in the water color rather than 41.0%.

Relief finer than half a layer cannot be colored by a pause at all. For atolls,
deltas, anything low and flat, the answer is the inserts path (`lakes`, `all`), where
water is a separate part in its own filament and the boundary is planform-exact.

## The project-config trap

**The embedded config must stay empty.** PrusaSlicer treats the 3MF as a project
because `Metadata/Slic3r_PE.config` exists, and reads color changes only from a
project — but `Plater::priv::load_files` applies a *non-empty* project config by
starting from `FullPrintConfig::defaults()` and overlaying the file's keys. Writing
even one setting — `layer_height`, say, to pin the grid — replaces the user's print,
filament and printer presets with PrusaSlicer's defaults. Empty takes the
`config_loaded.empty()` branch and applies nothing.

## Other slicers

Ours is `Metadata/Prusa_Slicer_custom_gcode_per_print_z.xml`. OrcaSlicer and Bambu
Studio read `Metadata/custom_gcode_per_layer.xml` with a `top_z` attribute
(`bbs_3mf.cpp`), so a terranejs export opens there as geometry with no swaps at all.
Same semantics, different part name.

Also note `assign_custom_gcodes` drops single-extruder color changes outright when the
selected printer is multi-extruder and the file's mode is `SingleExtruder`
(`ignore_tool_and_color_changes`) — an MMU profile shows no swaps for reasons that
have nothing to do with the model.

## Verifying

`node scripts/pause-probe.mjs <out.3mf>` builds a probe — 13 pillars, the first at
exactly `zLine`, each next 0.025 mm taller — and prints what each grid should do with
it. Sliced in PrusaSlicer on four grids, predicted and observed agreed on the swap's
layer and height and on the pillar count every time:

| fh | h | swap | pillars in the second filament |
|---|---|---|---|
| 0.20 | 0.15 | layer 41, 6.200 mm | 8 |
| 0.15 | 0.15 | layer 41, 6.150 mm | 10 |
| 0.25 | 0.15 | layer 41, 6.250 mm | 6 |
| 0.20 | 0.20 | layer 31, 6.200 mm | 9 |

Rerun it against any new slicer or version before trusting the arithmetic there.
