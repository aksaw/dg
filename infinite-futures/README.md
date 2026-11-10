# Infinite Futures

An endless, undulating ocean of liquid metal under an eclipse. The camera drifts forward forever; move the cursor to look around (drag on touch screens).

The sky is a near-black void: a fixed total eclipse (a black disc with a white-hot rim and drifting corona) hangs ahead, above a single razor-thin horizon line and fine grain stars. The chrome reflects mostly darkness and a few sharp highlights. A realistic-sky version lives in [`../infinite-futures-realistic/`](../infinite-futures-realistic/).

It's WebGL2 with no dependencies and no build step: a raymarched scene shader (with the metal reflecting itself) plus a small bloom pass.

## Run locally

Serve the repo root and open `/infinite-futures/`:

```bash
python -m http.server 8000
```

## Deploy to GitHub Pages

This folder lives inside a repo whose root `index.html` links to it.

1. Push the repo to GitHub.
2. In the repo, go to **Settings → Pages**, set **Source** to *Deploy from a branch*, pick `main` and `/ (root)`.
3. This page will be at `https://<user>.github.io/<repo>/infinite-futures/`.

The `.nojekyll` file at the repo root tells Pages to serve the files as-is.
