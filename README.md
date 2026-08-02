# terranejs

Generate wall-mountable, 3D-printable topography tiles from a map selection —
<https://terrane.danielstiner.me>

## Develop

No build step. Plain ES modules; browser dependencies load from a CDN importmap.

```bash
npm install        # dev dependencies (TypeScript for typecheck, type stubs)
npm run dev        # serve the repo at http://localhost:8000 (pass a port to override)
npm test           # node --test over test/**/*.test.mjs
npm run typecheck  # tsc --checkJs (JSDoc types; never emits)
```

`npm run dev` needs an HTTP origin — ES module imports won't load from `file://` —
and sends `Cache-Control: no-store`, which `python3 -m http.server` does not: without
it Chrome caches modules heuristically and an edit can silently keep running its old
bytes. Use it rather than a generic static server.

## Deploy

Deployed to GitHub Pages from `main` (root), served at
<https://terrane.danielstiner.me> over HTTPS.
