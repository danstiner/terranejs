"""Fetch a terrarium mosaic for a bbox -> <outbase>.bin (float32 LE, row-major)
+ <outbase>.json (global-pixel convention matching terrain.js fetchMosaic).
Usage: python3 fetch_mosaic.py S W N E ZOOM OUTBASE"""
import concurrent.futures as cf
import io
import json
import math
import struct
import sys
import urllib.request

from PIL import Image

TILE = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"


def fetch(z, x, y):
    with urllib.request.urlopen(TILE.format(z=z, x=x, y=y), timeout=30) as r:
        img = Image.open(io.BytesIO(r.read())).convert("RGB")
    b = img.tobytes()
    return [b[3 * i] * 256 + b[3 * i + 1] + b[3 * i + 2] / 256 - 32768
            for i in range(256 * 256)]


def lon2gx(lon, z):
    return (lon + 180) / 360 * 256 * 2**z


def lat2gy(lat, z):
    s = math.sin(math.radians(lat))
    return (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * 256 * 2**z


S, W, N, E = map(float, sys.argv[1:5])
z, outbase = int(sys.argv[5]), sys.argv[6]
px0 = math.floor(min(lon2gx(W, z), lon2gx(E, z)) - 1)
px1 = math.ceil(max(lon2gx(W, z), lon2gx(E, z)) + 1)
py0 = math.floor(lat2gy(N, z) - 1)
py1 = math.ceil(lat2gy(S, z) + 1)
tx0, tx1 = px0 // 256, (px1 - 1) // 256
ty0, ty1 = py0 // 256, (py1 - 1) // 256
nx, ny = tx1 - tx0 + 1, ty1 - ty0 + 1
Wpx, Hpx = nx * 256, ny * 256
data = [0.0] * (Wpx * Hpx)
jobs = [(tx, ty) for ty in range(ty0, ty1 + 1) for tx in range(tx0, tx1 + 1)]
with cf.ThreadPoolExecutor(12) as ex:
    for (tx, ty), elev in zip(jobs, ex.map(lambda j: fetch(z, *j), jobs)):
        ox, oy = (tx - tx0) * 256, (ty - ty0) * 256
        for r in range(256):
            data[(oy + r) * Wpx + ox : (oy + r) * Wpx + ox + 256] = elev[r * 256 : (r + 1) * 256]
with open(outbase + ".bin", "wb") as f:
    f.write(struct.pack(f"<{len(data)}f", *data))
with open(outbase + ".json", "w") as f:
    json.dump({"width": Wpx, "height": Hpx, "originGx": tx0 * 256,
               "originGy": ty0 * 256, "z": z}, f)
print(f"z{z}: {nx}x{ny} tiles -> {outbase}.bin ({Wpx}x{Hpx})")
