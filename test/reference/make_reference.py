#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["pyproj>=3.6"]
# ///
"""Regenerate test/reference/expected.json.

The golden `extents` are WGS84 *geodesic* ground-truth distances, computed by
pyproj (Karney's algorithm) — an independent tool and method from the code
under test. geo.test.mjs bounds bboxExtentMeters (a centre-latitude flat-rate
model) against them, confirming the model agrees with true geodesics to <1e-6.

Run:  uv run test/reference/make_reference.py
  or: pip install pyproj && python test/reference/make_reference.py
"""
import json
import pathlib

from pyproj import Geod

GEOD = Geod(ellps="WGS84")

# name -> [south, west, north, east]
BBOXES = {
    "rainier": [46.75, -121.85, 46.92, -121.65],
    "grand_canyon": [36.03, -112.20, 36.24, -111.90],
    "fuji": [35.30, 138.68, 35.42, 138.80],
    "equator": [-0.10, 10.00, 0.10, 10.20],
}


def geodesic_extent(s, w, n, e):
    clat, clon = (s + n) / 2, (w + e) / 2
    _, _, real_w = GEOD.inv(w, clat, e, clat)  # E-W across the centre parallel
    _, _, real_h = GEOD.inv(clon, s, clon, n)  # N-S across the centre meridian
    return real_w, real_h


extents = {}
for name, bbox in BBOXES.items():
    rw, rh = geodesic_extent(*bbox)
    extents[name] = {"bbox": bbox, "realW": rw, "realH": rh}

here = pathlib.Path(__file__).resolve().parent
(here / "expected.json").write_text(json.dumps({"extents": extents}, indent=2) + "\n")
print(f"wrote {here / 'expected.json'}")
