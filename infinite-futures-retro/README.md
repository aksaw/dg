# Infinite Futures (retro)

The liquid-metal ocean as a late-90s console game. The camera drifts forward forever; move the cursor to look around (drag on touch screens).

- A fixed 240-line framebuffer scaled up with hard pixels.
- True low-poly waves: the swell field is sampled on a triangle grid and each facet is flat.
- A 16-level palette with 4×4 ordered (Bayer) dithering, and heavy distance fog.
- The realistic sky's 1-minute sunset → night → sunrise loop, seen through all of the above. Add `?t=30` to the URL to jump to midnight.

Derived from [`../infinite-futures-realistic/`](../infinite-futures-realistic/). WebGL2, no dependencies, no build step.

Serve the repo root and open `/infinite-futures-retro/`:

```bash
python -m http.server 8000
```
