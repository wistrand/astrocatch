# Rendering

All pixel work lives in `renderer.js` (WebGL2, browser-only).
`gameplay.js draw()` is pure orchestration: it advances per-entity
state and hands the renderer typed batches of instances.

## Shader programs

Five programs cover the entire render surface:

- **`fullscreen`** — background radial gradient + procedural spiral
  galaxies. Each galaxy has a logarithmic-spiral disk with 2–4
  arms, a wide soft white bulge (always), and, on ~45% of
  galaxies, an additional tight bright bulge whose color is
  randomized per-galaxy between white and warm yellow. Elliptical
  tilt for a 3D look. Positions seeded per session by a
  random `u_seed` uniform so the sky differs every page load.
  One quad from `gl_VertexID`, no vertex buffer.
- **`lensing`** — gravitational lensing composite for black holes.
  Reads the scene FBO texture, applies UV distortion + event
  horizon mask + photon ring + procedural background grid per
  visible black hole. Grid fades based on distance, sampled at
  distorted UV so lines warp visibly. Only runs on frames where
  `beginFrame` was called with `useFbo = true`.
- **`circle`** — instanced quad. Parallax bgStars use a session-
  seeded mulberry32 PRNG over a fixed 2400×1600 canonical space
  so positions are stable across window resizes. `kind` picks
  solid disc,
  ring, glow, or dashed ring. Covers ball, particles, shockwaves,
  hint ring, parallax bgStars, planets, comet elements, ejecta
  particles, and orbiting accretion clumps around black holes.
- **`star`** — instanced quad per active star. Fragment shader
  evaluates corona, streamers, glow, photosphere with limb
  darkening, granulation, and core highlight procedurally per
  pixel. Supports crash wobble (elliptical deformation via
  per-instance `a_wobble` vec2: amount + impact angle). Black
  holes get a separate branch: dark event horizon +
  Interstellar-style edge-on accretion disk with asymmetric
  lensed arcs and per-BH tilt from `v_seed`. Batch entries
  can override `seed` for tidal locking (binary sub-stars).
  Past stars short-circuit to a dim ember.
- **`polyline`** — dynamic line strip extruded to a triangle strip.
  Used for trail, connector hints, velocity arrow, replay ghost
  path, and comet tails.

No libraries. Shaders live as template strings inside `renderer.js`.

## Star instance layout

16 floats per instance (64 bytes):
`vec2 center, vec4 c1(rgb+baseR), vec4 c2(rgb+seed), vec4 params(hasRays, nGran, pulse, flags), vec2 wobble(amount, angle)`.

Flags: bit 0 = isCurrent, bit 1 = isNext, bit 2 = isPast,
bit 3 = isBlackHole, bit 4 = isMonolith.

## Black holes

Black holes are stars with `isBlackHole: true` (flag bit 3 in
`v_flags`). Same gameplay as normal stars but visually different:

- **Star shader branch**: event horizon (black disk) + edge-on
  accretion disk (thin horizontal band with temperature gradient,
  wider side spikes) + asymmetric lensed arcs (bright bottom,
  dim top, per-BH tilt from `v_seed` + slow precession).
- **Lensing grid**: procedural grid drawn in the lensing shader
  at distorted UV coordinates, fading based on distance to the
  BH. Makes gravitational distortion visible. Fixed 40px spacing.
- **Conditional FBO**: `beginFrame(t, true)` binds a scene FBO;
  all draws go to the texture. `finalizeFrame(bhData)` unbinds
  and draws the fullscreen lensing composite. When `useFbo` is
  false, draws go directly to the default framebuffer — zero
  FBO overhead.
- **`BH_VISUAL_SCALE`** in gameplay.js decouples visual size from
  physics — the event horizon appears smaller than the gravity
  well.

## Monoliths

Separate branch in the star fragment shader — runs before the
wobble transform so monoliths stay rigid. Raymarches an
orthographic ray against an axis-aligned slab in box-local
coordinates; the box is oriented via a Rodrigues rotation
matrix built from a per-monolith random axis (derived from
`v_seed`) and a time-driven angle. Hit normal is transformed
back to world space for directional-diffuse lighting plus a
`pow(1 - |normal.z|, 4)` fresnel rim. Edge AA via `fwidth(tN)`
on the hit depth.

Half-extents: `(0.189, 0.747, 1.692) * v_baseR` — classic
1:4:9 proportion, scaled to keep corners clear of the capture
orbit.

## Crash wobble

When a ship crashes into a star, the star shader receives wobble
amount and impact angle via the `a_wobble` attribute. The
fragment shader decomposes `v_local` into parallel/perpendicular
components relative to the impact direction: the parallel axis
is squeezed and the perpendicular axis bulges, creating an
elliptical deformation that decays over time.

## Perf constraints (load-bearing)

- `antialias: false` — every edge is SDF-smoothed in the FS.
- Star FS early-out at `d > coronaR` before streamer/granule loops.
- Streamer + granulation share one fused precompute loop.
- `flat` qualifiers on `v_flags`, `v_kind`, `v_nGran`, `v_hasRays`.
- Persistent GL state set once in `createRenderer`, not per-frame.
- `cameraMat` returns a pooled `Float32Array(9)` — don't hoist
  across frames. `_bhScratch` is pooled for finalizeFrame.
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
