# terranejs

Generate wall-mountable, 3D-printable topography tiles from a map selection —
<https://terrane.danielstiner.me>

## Develop

No build step. Plain ES modules; browser dependencies load from a CDN importmap.

```bash
npm install        # dev dependencies (TypeScript for typecheck, type stubs)
npm test           # node --test over test/**/*.test.mjs
npm run typecheck  # tsc --checkJs (JSDoc types; never emits)
```

Run the site locally by serving the repo root over HTTP, e.g.
`npx http-server .` or `python3 -m http.server`, then open the served
`index.html`. (Opening the file directly won't work — ES module imports need
an HTTP origin.)

## Deploy

Deployed to GitHub Pages from `main` (root), served at
<https://terrane.danielstiner.me> over HTTPS.
