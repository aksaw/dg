# Infinite Futures (realistic)

The realistic version of [Infinite Futures](../infinite-futures/): the same endless liquid-metal ocean, under a physically based sky. The camera drifts forward forever; move the cursor to look around (drag on touch screens).

The sun sets into a starry, moonlit night and rises again on a 1-minute loop, never climbing far above the horizon. The sky uses an analytic atmospheric-scattering model (Preetham-style) with automatic exposure, high streaky clouds, a limb-darkened sun and moon, and stars that only appear once the sky is dark. Add `?t=30` to the URL to skip ahead in the cycle (30 = midnight).

It's WebGL2 with no dependencies and no build step: a raymarched scene shader (with the metal reflecting itself) plus a small bloom pass.

## Run locally

Serve the repo root and open `/infinite-futures-realistic/`:

```bash
python -m http.server 8000
```

## Deploy

Published with the rest of the repo on GitHub Pages at `https://<user>.github.io/<repo>/infinite-futures-realistic/`.
