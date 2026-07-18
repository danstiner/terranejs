# Golden reference data

`expected.json` holds WGS84 **geodesic** ground-truth used by
`test/geo.test.mjs` to bound `bboxExtentMeters` — a centre-latitude flat-rate
model (parallel-arc E-W, meridian-arc N-S) — against true geodesics.

- `extents[name] = { bbox: [s, w, n, e], realW, realH }` — the true E-W and N-S
  ground distances (metres) across each bbox's centre lines.

The values come from a **different tool and algorithm** (`pyproj`, Karney's
geodesic) than the code under test, so they check the *model* end-to-end: does
our flat-rate size agree with the real geodesic distance? The residual (~4e-7)
is the parallel-arc-vs-geodesic gap, not a code bug — that's what the `< 1e-6`
bound guards. Per-coefficient correctness is covered separately by the
self-contained 0°/45° known-value checks in `geo.test.mjs`.

## Regenerate

```bash
uv run test/reference/make_reference.py
# or: pip install pyproj && python test/reference/make_reference.py
```

The geodesic is deterministic, so regeneration reproduces the same values;
JSON formatting may differ, but `geo.test.mjs` compares numerically (< 1e-5).
