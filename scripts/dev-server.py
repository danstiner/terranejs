#!/usr/bin/env python3
"""Serve the repo root over HTTP with the browser cache switched off.

`python3 -m http.server` sends Last-Modified but no Cache-Control or ETag, so Chrome
falls back to heuristic freshness and caches ES modules on its own initiative. An
edited module then keeps serving its old bytes with no error and no failed request —
it presents as a code defect, not a cache hit, and survives a hard reload. `no-store`
opts out of that entirely.

Note that localhost and 127.0.0.1 are separate cache origins, so switching between
them can look like a fix while the stale entry is still there.
"""

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class NoStoreHandler(SimpleHTTPRequestHandler):
    # The page pulls ~20 modules; HTTP/1.0 would tear down the connection after each.
    protocol_version = "HTTP/1.1"

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    root = Path(__file__).resolve().parent.parent
    handler = partial(NoStoreHandler, directory=str(root))
    with ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"serving {root} at http://localhost:{port}/ — Cache-Control: no-store")
        httpd.serve_forever()
