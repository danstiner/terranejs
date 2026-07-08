#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["requests>=2.31", "shapely>=2.0"]
# ///
"""Bake real park/state boundary outlines into js/boundaries.js (keyless runtime).

Fetches each region's boundary from OSM Overpass, stitches the unordered `outer`
way segments into rings (shapely), keeps the largest ring, simplifies it to a
~150-vertex budget, and writes a JS module of `[[lat, lon], …]` rings keyed by
the preset name. Run once at build time; the output is committed.

Incremental: keys already present in js/boundaries.js are skipped, so adding a
region fetches only that region. Delete an entry (or the file) to refetch it.

  uv run tools/fetch_boundaries.py
"""
import json
import pathlib
import re
import sys
import time

import requests
from shapely.geometry import LineString
from shapely.ops import polygonize, unary_union

OVERPASS = "https://overpass-api.de/api/interpreter"
UA = {"User-Agent": "tilejs-prebake/1.0 (terrain print tool; boundaries bake)"}
VERT_TARGET = 150

# (preset key, OSM selector). Parks matched by name across national_park /
# protected_area tags; if a name collides (e.g. Glacier NP US vs Canada) the
# largest ring wins. Washington by its stable relation id.
PARKS = [
    ("Great Smoky Mtns National Park", "Great Smoky Mountains National Park"),
    ("Zion National Park", "Zion National Park"),
    ("Grand Canyon National Park", "Grand Canyon National Park"),
    ("Yellowstone National Park", "Yellowstone National Park"),
    ("Rocky Mountain National Park", "Rocky Mountain National Park"),
    ("Yosemite National Park", "Yosemite National Park"),
    ("Acadia National Park", "Acadia National Park"),
    ("Olympic National Park", "Olympic National Park"),
    ("Grand Teton National Park", "Grand Teton National Park"),
    ("Glacier National Park", "Glacier National Park"),
    ("Mt Rainier National Park", "Mount Rainier National Park"),
    ("Crater Lake National Park", "Crater Lake National Park"),
    ("Death Valley National Park", "Death Valley National Park"),
]
STATES = [("Washington State", 165479)]
# (preset key, state area name, county name); admin_level 6 = US county,
# scoped to the state so same-named counties elsewhere don't collide
COUNTIES = [("King County, WA", "Washington", "King County")]


def overpass(selector: str) -> list:
    q = f"[out:json][timeout:120];{selector};out geom;"
    for attempt in range(4):
        r = requests.get(OVERPASS, params={"data": q}, headers=UA, timeout=180)
        if r.status_code == 200:
            return r.json()["elements"]
        time.sleep(8 * (attempt + 1))  # back off on rate limit / load
    raise RuntimeError(f"Overpass failed ({r.status_code}) for: {selector}")


def largest_ring(elements):
    """Stitch every relation's outer ways -> pick the single largest polygon."""
    lines = []
    for el in elements:
        if el.get("type") != "relation":
            continue
        for m in el.get("members", []):
            if m.get("role") == "outer" and "geometry" in m:
                lines.append(LineString([(p["lon"], p["lat"]) for p in m["geometry"]]))
    polys = list(polygonize(unary_union(lines)))
    if not polys:
        return None
    return max(polys, key=lambda p: p.area)


def simplify_to(poly, target=VERT_TARGET):
    """Binary-search the tolerance for ~target exterior vertices."""
    lo, hi = 0.0002, 0.05
    best = poly.simplify(hi, preserve_topology=True)
    for _ in range(30):
        mid = (lo + hi) / 2
        s = poly.simplify(mid, preserve_topology=True)
        if len(s.exterior.coords) > target:
            lo = mid
        else:
            hi, best = mid, s
    return best


def ring_latlon(poly):
    # drop the duplicate closing vertex (Leaflet closes the ring itself)
    coords = list(poly.exterior.coords)[:-1]
    return [[round(lat, 4), round(lon, 4)] for lon, lat in coords]


DST = pathlib.Path(__file__).resolve().parent.parent / "js" / "boundaries.js"


def existing() -> dict:
    """Rings already baked into boundaries.js (its object body is valid JSON)."""
    if not DST.exists():
        return {}
    m = re.search(r"BOUNDARIES = ({.*});", DST.read_text(), re.S)
    return json.loads(m.group(1)) if m else {}


def main():
    out = existing()
    jobs = [(k, f'relation["boundary"~"national_park|protected_area"]["name"="{n}"]')
            for k, n in PARKS]
    jobs += [(k, f"relation({rid})") for k, rid in STATES]
    jobs += [(k, f'area["admin_level"="4"]["boundary"="administrative"]["name"="{state}"]->.st;'
                 f'relation(area.st)["admin_level"="6"]["boundary"="administrative"]["name"="{name}"]')
             for k, state, name in COUNTIES]
    skipped = [k for k, _ in jobs if k in out]
    if skipped:
        print(f"  already baked, skipping: {len(skipped)}")
    jobs = [(k, s) for k, s in jobs if k not in out]

    for key, selector in jobs:
        try:
            els = overpass(selector)
            poly = largest_ring(els)
            if poly is None:
                print(f"  !! {key}: no polygon assembled", file=sys.stderr)
                continue
            s = simplify_to(poly)
            ring = ring_latlon(s)
            b = s.bounds
            out[key] = ring
            print(f"  {key}: {len(ring)} pts  bbox "
                  f"{b[1]:.2f},{b[0]:.2f},{b[3]:.2f},{b[2]:.2f}")
        except Exception as e:
            print(f"  !! {key}: {e}", file=sys.stderr)
        time.sleep(3)  # be polite to Overpass

    body = ",\n".join(
        f'  {json.dumps(k)}: {json.dumps(v, separators=(",", ":"))}'
        for k, v in out.items())
    DST.write_text(
        "// Generated by tools/fetch_boundaries.py — do not edit by hand.\n"
        "// Real region outlines (OSM, simplified) as [[lat, lon], …] rings.\n"
        f"export const BOUNDARIES = {{\n{body}\n}};\n")
    print(f"\nwrote {DST} ({len(out)} regions)")


if __name__ == "__main__":
    main()
