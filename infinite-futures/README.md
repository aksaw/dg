# Infinite Futures

An endless, undulating ocean of liquid metal. The camera drifts forward forever; move the cursor to look around (drag on touch screens).

The sun sets into a starry, moonlit night and rises again on a 1-minute loop, never climbing far above the horizon. Add `?t=30` to the URL to skip ahead in the cycle (30 = midnight).

It's a single full-screen WebGL2 fragment shader (raymarched heightfield + metallic reflections), with no dependencies and no build step.

## Run locally

Open `index.html` directly, or serve the folder:

```bash
python -m http.server 8000
```

## Deploy to GitHub Pages

This folder lives inside a repo whose root `index.html` links to it.

1. Push the repo to GitHub.
2. In the repo, go to **Settings → Pages**, set **Source** to *Deploy from a branch*, pick `main` and `/ (root)`.
3. This page will be at `https://<user>.github.io/<repo>/infinite-futures/`.

The `.nojekyll` file at the repo root tells Pages to serve the files as-is.
