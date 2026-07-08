#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy>=2.0", "rasterio>=1.4", "pyproj>=3.6"]
# ///
"""Dump golden values from topotile.py for the tilejs node tests.

- splits(): exact integer parity (tilejs must match byte-for-byte).
- round(): Python's half-to-even, the tie cases tilejs.roundHalfEven must hit.
- extents: GEODESIC (WGS84) centre-line ground distances per bbox — the true
  physical size tilejs's ellipsoidal metres-per-degree must reproduce. (Note:
  topotile's UTM extent is ~1-2% larger here, an axis-aligned-bbox + meridian-
  convergence artifact, not the real ground distance; we test against geodesic.)
Writes test/reference/expected.json.
"""
import json
import pathlib
import sys

from pyproj import Geod

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent / "topotile"))
import topotile as tt

GEOD = Geod(ellps="WGS84")

SPLIT_CASES = [(1, 10), (2, 6), (2, 7), (3, 100), (4, 14), (4, 15), (5, 999), (2, 2)]
ROUND_VALUES = [0.5, 1.5, 2.5, 3.5, 4.5, -0.5, -1.5, -2.5, 2.4, 2.6, 0.0, 7.5, 8.5]
BBOXES = {  # name -> [south, west, north, east]
    "rainier": [46.75, -121.85, 46.92, -121.65],
    "grand_canyon": [36.03, -112.20, 36.24, -111.90],
    "fuji": [35.30, 138.68, 35.42, 138.80],
    "equator": [-0.10, 10.00, 0.10, 10.20],
}


def geodesic_extent(s, w, n, e):
    clat, clon = (s + n) / 2, (w + e) / 2
    _, _, realW = GEOD.inv(w, clat, e, clat)  # E-W along centre parallel
    _, _, realH = GEOD.inv(clon, s, clon, n)  # N-S along centre meridian
    return realW, realH


def signed_volume(tris):
    v = 0.0
    for a, b, c in tris:
        v += (a[0] * (b[1] * c[2] - b[2] * c[1])
              - a[1] * (b[0] * c[2] - b[2] * c[0])
              + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0
    return v


# A deterministic, strictly-positive-on-the-boundary synthetic relief (mm),
# meshed by topotile.build_solid; tilejs.buildSolid must enclose the same volume
# (topology differs — base triangulation — but volume is invariant).
def synthetic_relief(H, W):
    import numpy as np
    r = np.zeros((H, W), dtype="float64")
    for i in range(H):
        for j in range(W):
            r[i, j] = 2 + 0.05 * i + 0.03 * j + 6 * np.exp(
                -(((i - H / 2) ** 2 + (j - W / 2) ** 2) / 40.0))
    return r


SOLID = {"H": 9, "W": 11, "dx": 1.7, "dy": 1.3, "base": 3.0}
relief = synthetic_relief(SOLID["H"], SOLID["W"])
solid_tris = tt.build_solid(relief, SOLID["dx"], SOLID["dy"], SOLID["base"])

out = {
    "splits": {f"{n},{size}": [list(sp) for sp in tt.splits(n, size)]
               for (n, size) in SPLIT_CASES},
    "round": {str(v): round(v) for v in ROUND_VALUES},
    "extents": {},
    "solid": {**SOLID, "relief": relief.tolist(),
              "tris": int(len(solid_tris)),
              "volume": signed_volume(solid_tris)},
}
for name, bbox in BBOXES.items():
    rw, rh = geodesic_extent(*bbox)
    out["extents"][name] = {"bbox": bbox, "realW": rw, "realH": rh}

ref = HERE / "reference"
ref.mkdir(exist_ok=True)
(ref / "expected.json").write_text(json.dumps(out, indent=2))
print(f"wrote {ref / 'expected.json'}")
