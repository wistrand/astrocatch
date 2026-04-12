# Rendering

All pixel work lives in `renderer.js` (WebGL2, browser-only).
`gameplay.js draw()` is pure orchestration: it advances per-entity
state and hands the renderer typed batches of instances.

## Shader programs

Five programs cover the entire render surface:

- **`fullscreen`** — background radial gradient + procedural spiral
  galaxies (logarithmic spiral arms, elliptical tilt, radial
  falloff, all from hash-seeded positions with slow parallax).
  One quad from `gl_VertexID`, no vertex buffer.
- **`lensing`** — gravitational lensing composite for black holes.
  Reads the scene FBO texture, applies UV distortion + event
  horizon mask + photon ring per visible black hole. Only runs
  on frames where `beginFrame` was called with `useFbo = true`
  (~5% of gameplay frames). See Black Holes below.
- **`circle`** — instanced quad. `kind` attribute picks solid disc,
  ring, glow, or dashed ring. Covers ball, particles, shockwaves,
  hint ring, parallax bgStars, planets, comet elements, and
  orbiting accretion clumps around black holes.
- **`star`** — instanced quad per active star. Fragment shader
  evaluates corona, streamers, glow, photosphere with limb
  darkening, granulation, and core highlight procedurally per
  pixel, all driven by `u_time`. Black holes get a separate
  branch: dark event horizon + Interstellar-style edge-on
  accretion disk with asymmetric lensed arcs and per-BH tilt
  from `v_seed`. Past stars short-circuit to a dim ember.
- **`polyline`** — dynamic line strip extruded to a triangle strip.
  Used for trail, connector hints, velocity arrow, replay ghost
  path, and comet tails.

No libraries. Shaders live as template strings inside `renderer.js`.

## Black holes

Black holes are stars with `isBlackHole: true` (flag bit 3 in
`v_flags`). Same gameplay as normal stars but visually different:

- **Star shader branch**: event horizon (black disk) + edge-on
  accretion disk (thin horizontal band with temperature gradient)
  + asymmetric lensed arcs (bright bottom, dim top, per-BH tilt
  from `v_seed` + slow `sin(u_time)` precession).
- **Conditional FBO**: `beginFrame(t, true)` binds a scene FBO;
  all draws go to the texture. `finalizeFrame(bhData)` unbinds
  and draws the fullscreen lensing composite. When `useFbo` is
  false (~95% of frames), draws go directly to the default
  framebuffer — zero FBO overhead.
- **Accretion clumps + field stars**: gameplay.js draws orbiting
  hot-gas dots and scattered white dots around each active BH,
  rendered to the FBO before the lensing pass distorts them into
  visible arcs.
- **`BH_VISUAL_SCALE`** in gameplay.js decouples visual size from
  physics — the event horizon appears smaller than the gravity
  well.

## Perf constraints (load-bearing)

- `antialias: false` — every edge is SDF-smoothed in the FS.
- Star FS early-out at `d > coronaR` before streamer/granule loops.
- Streamer + granulation share one fused precompute loop.
- `flat` qualifiers on `v_flags`, `v_kind`, `v_nGran`, `v_hasRays`.
- Persistent GL state set once in `createRenderer`, not per-frame.
- `cameraMat` returns a pooled `Float32Array(9)` — don't hoist
  across frames. `_bhScratch` is pooled for finalizeFrame.
- `drawCircleBatch` skips dead uniform writes for gameplay circles.
- Scratch pools grow by doubling and never shrink.
- Array uniform names aliased both with and without `[0]` suffix
  for cross-driver compatibility.

## Replay camera

Dynamic following camera with simplex-noise-driven zoom:

- `replayCamX/Y` ease toward marker at a low weight per frame.
- Zoom breathes via `simplex2` at a slow sampling rate.
- Trailing window caps the trajectory polyline.
- Camera matrix built per frame via `renderer.replayMat(...)`.
- When `replayIdx` wraps, camera eases back to start.
