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
  *Cost:* moderate per pixel (~20–40 ALU + ~8 trig per galaxy),
  runs over the entire framebuffer every frame. Galaxy count
  is a small constant (~3) so the inner loop is short.
- **`lensing`** — gravitational lensing composite for black holes.
  Reads the scene FBO texture, applies UV distortion + event
  horizon mask + photon ring + procedural background grid per
  visible black hole. Grid fades based on distance, sampled at
  distorted UV so lines warp visibly. Only runs on frames where
  `beginFrame` was called with `useFbo = true`.
  *Cost:* expensive — full-screen pass with one scene-texture
  sample and per-BH distortion math per fragment. Adds an FBO
  bind + an extra fullscreen draw only when a BH is on screen.
  Roughly doubles the per-frame fragment work while a BH is
  visible.
- **`circle`** — instanced quad. Parallax bgStars use a session-
  seeded mulberry32 PRNG over a fixed 2400×1600 canonical space
  so positions are stable across window resizes. `kind` picks
  solid disc,
  ring, glow, or dashed ring. Covers ball, particles, shockwaves,
  hint ring, parallax bgStars, planets, comet elements, ejecta
  particles, and orbiting accretion clumps around black holes.
  *Cost:* cheapest per-pixel shader (~5–15 ALU, one distance
  compute and one smoothstep). Instance counts dominate rather
  than per-pixel work.
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
  *Cost:* variable by branch (see per-variant sections below).
  Plain-star path is ~30–80 ALU + ~10 trig per fragment with
  5–8-iteration streamer/granule loops; past-star branch is
  near-zero; monolith/ringworld branches are heavier. Quad
  covers corona radius (~2–3× `baseR`), so pixel count per
  instance dwarfs per-pixel ALU for late-game star counts.
- **`polyline`** — dynamic line strip extruded to a triangle strip.
  Used for trail, connector hints, velocity arrow, replay ghost
  path, and comet tails.
  *Cost:* cheap — a segment-distance smoothstep per fragment.
  Vertex count is linear in path length (~100 trail points,
  ~REPLAY_MAX replay points) but fragment count is small since
  strokes are thin.

No libraries. Shaders live as template strings inside `renderer.js`.

## Star instance layout

16 floats per instance (64 bytes):
`vec2 center, vec4 c1(rgb+baseR), vec4 c2(rgb+seed), vec4 params(hasRays, nGran, pulse, flags), vec2 wobble(amount, angle)`.

Flags: bit 0 = isCurrent, bit 1 = isNext, bit 2 = isPast,
bit 3 = isBlackHole, bit 4 = isMonolith, bit 6 = isRingworld.

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

*Cost:* most expensive variant on screen. Star-branch fragment
cost is comparable to a plain star, but the full-screen lensing
pass adds an FBO round-trip and a per-pixel distortion/grid
sample that dominates. Rough scale: ~5–10× the cost of a plain
star when one BH is visible; grows sublinearly with BH count
since the composite pass is shared.

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

*Cost:* moderate. Per fragment: Rodrigues matrix (~6 trig,
27 muls), slab intersection (~30 muls), argmax-based normal
pick, fresnel rim. Quad ~1.7× `baseR`, so pixel count per
instance is about 3× a plain star's photosphere. Aggregate
cost per monolith roughly 2× a plain star.

## Ringworld

Separate branch in the star fragment shader (flag bit 6).
A cylindrical band of radius `2.6 * v_baseR` and height
`1.0 * v_baseR` wraps a central sun. The band tumbles as a
rigid body via a Rodrigues rotation on a per-star seeded axis
(same pattern as monolith, angular rate `0.25`).

Ray-cylinder intersection in the rotated frame picks between
two hits: the near hit shows the OUTSIDE face (dark structural
back of the habitat); the far hit shows the INSIDE face
(earth-textured surface facing the sun). Fragments that miss
both band segments reveal the central sun through the ring
opening.

Surface features:
- **Inside**: multi-octave sin/cos earth noise (ocean/coast/
  land palette) with domain-warped cloud octaves on top.
  All `u = theta + spin` multipliers are integers so the
  texture seams across the band wrap.
- **Outside**: dark-grey structural panels with a low-frequency
  sinusoidal pattern and a lighter band-edge rim.
- **Camera-direction light**: `lit = 0.20 + 1.70 * NdotV` on
  outside, `litInside = 0.05 + 1.50 * NdotV` on inside (N flips
  sign between faces). Darkens silhouette edges, reads as 3D.
- **Specular** hotspot on both faces via `pow(NdotV, 32)` —
  stronger on outside (near arc), softer on inside (far arc).
- **Rim glow** on the inside: warm fresnel `pow(1 - |N.z|, 4)`
  along the inside silhouette, reads as atmospheric limb.
- **Axial spin** `u_time * 0.12` offsets the theta coordinate
  so surface features rotate around the central sun.

The ship orbits the ringworld as a normal star; gameplay
triggers a smooth 1.5× camera zoom-in while the ship's
`currentStar.isRingworld` is true.

*Cost:* moderate-high, ~2× a monolith. Per fragment: Rodrigues
build, ray-cylinder quadratic (~25 muls + sqrt), two terrain
octaves + two domain-warped cloud octaves (~14 trig total),
per-face specular and rim-glow fresnel. Quad ~3× `baseR` so
pixel count per instance is ~9× a plain star — the quad area
dominates the per-fragment ALU cost. Still negligible next to
a visible black hole.

## Crash wobble

When a ship crashes into a star, the star shader receives wobble
amount and impact angle via the `a_wobble` attribute. The
fragment shader decomposes `v_local` into parallel/perpendicular
components relative to the impact direction: the parallel axis
is squeezed and the perpendicular axis bulges, creating an
elliptical deformation that decays over time.

*Cost:* negligible — a dot product and two muls per fragment
on the existing star path. Runs only while `amount > 0` and
is skipped entirely on monoliths/ringworlds (rigid bodies).

## Total frame cost

Rough per-frame budget at 1080p on a mid-range integrated GPU,
with ~10 active stars on screen. Numbers are order-of-magnitude
fragment-ALU share, not wall time:

| Pass             | Share | Notes                               |
|------------------|-------|-------------------------------------|
| `fullscreen` bg  | ~35%  | Runs over every pixel every frame.  |
| `star` batch     | ~25%  | Grows with star count and variant mix. A single visible ringworld adds ~5%; a monolith ~2%. |
| `circle` batch   | ~10%  | bgStars, ball, planets, particles, hints. Cheap per pixel but many instances. |
| `polyline`       | ~2%   | Trail + replay + comet tails.       |
| `lensing` pass   | +60%  | Added **on top** only while a BH is on screen — roughly doubles total fragment work. |
| JS / state       | ~5%   | `draw()` batch build + renderer uniform uploads. Minor; physics/gameplay ticks are counted separately. |

Back-of-envelope totals:
- **Plain scene** (no BH): ~1× the fullscreen pass, i.e. one
  pass worth of fragment work. Runs comfortably at 60 fps on
  any modern GPU, ~5–8 ms on integrated mobile.
- **Scene with one visible BH**: ~1.6× the plain scene because
  of the lensing composite. Still 60 fps on desktop; mobile
  integrated GPUs may dip to 45–55 fps depending on FBO size.
- **Scene with ringworld + BH**: ringworld adds ~5% on top of
  the BH cost — not the bottleneck; the lensing pass is.

Scaling inputs to watch:
- **Viewport pixel count** (`W * H * DPR²`) — linear multiplier
  on the fullscreen + lensing passes. DPR is clamped to 2.
- **Active star count** — frustum-culled to the camera band,
  past stars >6 captures back are skipped entirely.
- **Black hole count** — grows sublinearly (shared lensing
  pass), but each extra BH adds an inner-loop iteration in
  the composite shader.

The dominant costs are *always* the two full-screen passes
(background + optional lensing). Per-star shader cost only
becomes meaningful when many variants (BH/monolith/ringworld)
are simultaneously visible.

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
