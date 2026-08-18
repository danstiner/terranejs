# Golden reference data

## `gpx/` — real exports, trimmed

Used by `test/gpxfixtures.test.mjs`. The three good files are **actual exports**, cut
down to their first 8 track points by copying the header and `<trkpt>` bytes verbatim —
no reserialization — so each keeps what its exporter really emits:

| fixture | source | what it carries that the others do not |
|---|---|---|
| `alltrails.gpx` | AllTrails.com | `<![CDATA[…]]>` names, `<bounds>`, 5-decimal coordinates |
| `garmin-connect.gpx` | Garmin Connect | `lat="48.71756390668451786041259765625"` — 29 significant digits, a double printed exactly — plus `ns3:TrackPointExtension` children inside each `<trkpt>` |
| `strava.gpx` | StravaGPX | 1-space indent, 7-decimal coordinates, **no `<metadata>` and no extensions** |

The `<bounds>` in `alltrails.gpx` still describes the *full* trail, not the trimmed 8
points. Left as-is: it is what the exporter wrote, and nothing reads it.

Strava emits two shapes — a **route** export (no timestamps, what this fixture is) and an
**activity** export (adds `<time>` and `gpxtpx:` heart-rate/cadence extensions, which look
like Garmin's under a different prefix). Only the route shape is covered.

Every timestamp is rebased onto `2020-01-01T00:00:00Z`, keeping the gaps between points
so the sampling interval still reads like a real recording. The rebase lives in the
regeneration script, so re-running it cannot restore the original dates. Heart rate and
cadence in `garmin-connect.gpx` are left as recorded.

The `bad-*.gpx` files pin the refusals, one per distinct message.

### Regenerate

```bash
node scripts/trim-gpx-fixtures.mjs <dir-of-full-exports>
```

Byte-for-byte reproducible from the same sources. It also emits `bad-truncated.gpx`, cut
from the *fixture* rather than the raw export so it inherits the anonymized timestamps.
The other `bad-*.gpx` files are checked in directly — small, and hand-written.

## `expected.json` — geodesic ground truth

`expected.json` holds WGS84 **geodesic** ground-truth used by
`test/geo.test.mjs` to bound `bboxExtentMeters` — a center-latitude flat-rate
model (parallel-arc E-W, meridian-arc N-S) — against true geodesics.

- `extents[name] = { bbox: [s, w, n, e], realW, realH }` — the true E-W and N-S
  ground distances (meters) across each bbox's center lines.

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
