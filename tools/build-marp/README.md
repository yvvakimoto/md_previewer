# build-marp

Bundles `@marp-team/marp-core` into a single IIFE for offline use by the previewer.

## Update workflow

```bash
cd tools/build-marp
npm install
npm run build
```

Output: `assets/libs/marp/marp.iife.js` (exposes `window.MarpCore.Marp`). Commit the artifact alongside dependency changes.
