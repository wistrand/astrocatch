# Rendering

All pixel work lives in `renderer.js` (WebGL2, browser-only).
`gameplay.js draw()` is pure orchestration: it advances per-entity
state and hands the renderer typed batches of instances.

## Shader programs

Four programs cover the entire render surface:

- **`fullscreen`** — background radial gradient. One quad from
  `gl_VertexID`, no vertex buffer. Portrait screens get a tighter
  gradient that fades to full black.
- **`circle`** — instanced quad. `kind` attribute picks solid disc,
  ring, glow, or dashed ring. Covers ball, particles, shockwaves,
  hint ring, parallax bgStars, planets, and comet elements.
- **`star`** — instanced quad per active star. Fragment shader
  evaluates corona, streamers, glow, photosphere with limb
  darkening, granulation, and core highlight procedurally per pixel,
  all driven by `u_time`. Past stars short-circuit to a dim ember.
- **`polyline`** — dynamic line strip extruded to a triangle strip.
  Used for trail, connector hints, velocity arrow, replay ghost
  path, and comet tails.

No libraries. Shaders live as template strings inside `renderer.js`.

## Perf constraints (load-bearing)

- `antialias: false` — every edge is SDF-smoothed in the FS.
- Star FS early-out at `d > coronaR` before streamer/granule loops.
- Streamer + granulation share one fused precompute loop.
- `flat` qualifiers on `v_flags`, `v_kind`, `v_nGran`, `v_hasRays`.
- Persistent GL state set once in `createRenderer`, not per-frame.
- `cameraMat` returns a pooled `Float32Array(9)` — don't hoist
  across frames.
- `drawCircleBatch` skips dead uniform writes for gameplay circles.
- Scratch pools grow by doubling and never shrink.

## Replay camera

Dynamic following camera with simplex-noise-driven zoom:

- `replayCamX/Y` ease toward marker at a low weight per frame for
  a lazy, cinematic drift.
- Zoom breathes via `simplex2` at a slow sampling rate.
- Trailing window caps the trajectory polyline (see constant in
  `drawReplayGhost`).
- Camera matrix built per frame via `renderer.replayMat(...)`.
- When `replayIdx` wraps, camera eases back to start.
