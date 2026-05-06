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

Flags layout (bit values):
- `1` — isCurrent
- `2` — isNext
- `4` — isPast
- `8` — isBlackHole
- `16` — isMonolith
- `32` — isPulsar
- `64` — isRingworld
- `128` — (unused)
- `256` / `512` / `1024` — `ringPlateCount` (3 bits, 0–7), only
  meaningful when `isRingworld` is set
- `2048` — isNebula

The vertex shader also reads bit `32` (isPulsar) to enlarge the
star quad to `5.0 × baseR + 8` (vs `4.3 × baseR + 8` for all
other variants). Pulsar lens-flare halos and streaks otherwise
hit the rectangular quad boundary at peak alignment.

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
  sinusoidal pattern.
- **Camera-direction light**: `lit = 0.20 + 2.70 * NdotV` on
  outside, `litInside = 0.01 + 1.70 * NdotV` on inside (N flips
  sign between faces). Darkens silhouette edges, reads as 3D.
- **Specular** hotspot on both faces via `pow(NdotV, 32)` —
  stronger on outside (near arc), softer on inside (far arc).
  Inside specular masked to water only (`1 − landT`), so oceans
  glint but continents stay matte.
- **Rim glow** on the inside: warm fresnel `pow(1 - |N.z|, 4)`
  along the inside silhouette, reads as atmospheric limb.
- **Axial spin** `u_time * 0.12` offsets the theta coordinate
  so surface features rotate around the central sun.
- **Axial vertical gradient**: mild darkening at widthT = 1
  (top rim of band), brightening at widthT = 0 (bottom rim).

### Shadow plates (optional day/night sectors)

Per-ringworld integer `ringPlateCount` in `[0, 7]`, packed into
flag bits 8–10. Zero = no plates (plate render, sun shadow, and
city-lights blocks all short-circuited).

When `plateCount > 0`:
- **Geometry**: a second concentric cylinder at `Rp = 0.55 R`,
  axial extent `Hp = 0.70 H`. N angular arcs of width
  `plateSpacing * 0.22 ≈ 16°` each, rotating at `u_time * 0.04`.
  The plate cylinder is ray-intersected alongside the ring. A
  plate hit short-circuits to render a dark structural panel
  with camera-direction lighting; the sun-facing inner face (far
  plate wall) also gets a tight `pow(NdotV, 24)` specular
  highlight, so plates catch the sun visibly.
- **Occlusion**: plates sit between outside ring wall and sun.
  When outside is the selected ring hit, plates are occluded
  and skipped. Otherwise plates are rendered even against a
  ring-miss background.
- **Sun-shadow on inside face**: inside pixels whose theta
  falls within a plate arc are darkened (multiplied by
  `1 − shadow * 0.75`). The axial check `abs(axPos) * Rp/R`
  against `Hp/2` is currently always satisfied with these
  constants, so the shadow is effectively angular-only.
- **City lights**: in deep-night regions (`shadow³`), a
  domain-warped 3-octave fBm thresholded at `1.90` paints warm
  amber dots on land (`landT`). Makes night sides look
  populated.

### Camera zoom

Gameplay triggers a smooth 1.5× camera zoom-in while the ship's
`currentStar.isRingworld` is true (eased at 0.05/frame), eased
back to 1.0× on the next capture.

### Edge-case guard

When the ring tumbles through an orientation where its axis
aligns with the view direction, `A = dot(dPerp, dPerp) → 0`
and the ray-cylinder quadratic's `1/(2A)` denominator blows up.
The shader sets `ringSkip = A < 1e-6` and skips both the ring
and plate intersections in that window, falling through to the
sun/empty branch. Prevents NaN flashes.

*Cost:* moderate-high. Plate-free ringworld is ~2× a monolith.
With plates enabled, per fragment adds: plate-cylinder quadratic
+ 2-iteration intersection loop with two `atan` calls (~80 ALU +
2 atan), plus on inside-face pixels an angular shadow
smoothstep + 5-sin domain-warped city fBm + `pow` (~70 ALU + 5
sins + 1 pow). Weighted aggregate: ~70% more fragment work than
plate-free. Still well under a visible black hole.

## Pulsars

Flag bit 32. Tiny dense neutron-star body (`coreR = 0.32 ×
v_baseR`) with two opposed lighthouse beams sweeping a magnetic
axis offset ~30° from a slowly drifting spin axis. Self-contained
shader branch — no FBO.

The spin axis itself drifts smoothly across the sphere via three
independent 2-decimal `u_time` rates (`0.03 / 0.02 / 0.04`); when
the drift carries it close to +Z, the magnetic axis sweeps
through camera direction and `flash = pow(|mag.z|, 8)` ramps to
near 1.0 for a brief alignment burst.

Visual layers:
- **Core** — small bright pinpoint, palette-tinted via `v_c1`,
  with `flash`-driven brightness boost.
- **Side beams** — two opposed cones along ±`bDir` (the magnetic
  axis projected to 2D). Cone vertex at the projected pole
  (`b2L * coreR` from origin), cone tapers from `0.06 · v_baseR`
  to `0.30 · v_baseR`. Beam is masked by Gaussian width and a
  smooth length envelope. Outflowing-plasma modulation: a low-
  frequency phase ripple plus a helical-knot intensity field
  that corkscrews along the beam, giving 3D depth.
- **Halo** — Gaussian glow that blooms with `flash`.
- **Lens flare composite** — 6-point diffraction spikes
  (`pow(|cos(3θ)|, 80)`), anamorphic streak (Gaussian along a
  per-pulsar axis), iris ring (`smoothstep` on `|d − 2.4 · v_baseR|`)
  with a slowly drifting crescent cut, plus chromatic core fringe.
  All gated by `flash` so they appear only during alignment.
- **Edge fade** — a circular alpha smoothstep at the edge of the
  enlarged 5.0× quad keeps the lens flare from showing the
  rectangular cutoff at peak flash.

*Cost:* moderate-high. Spin/perp/Rodrigues setup (~30 ALU + 5
trig per fragment), then the beam, halo, and 5 flare layers —
roughly 80–150 ALU + ~10 trig per fragment. Quad is 5.0× v_baseR
extent (vs 4.3× for plain stars), so per-instance pixel count is
~1.4× a plain star. Aggregate per pulsar ≈ 1.5–2× a plain star.

## Nebulae

Flag bit 2048. The most expensive shader path in the renderer.
Modelled as level sets of an r-biased simplex-FBM scalar field,
with five nested ellipsoidal shells (or one Bezier-tube
filamentary morphology, ~25% of seeds), volumetrically ray-
marched along the line of sight z.

### Shape

- **Ellipsoidal (default)**: `r3D = sqrt((x'/majA)² + (y'/minA)² + (z/minA)²)`
  with per-nebula eccentricity `[0.08, 0.25]` and rotation angle
  `v_seed · 1.7 + 0.3`. Plus a bipolar bias `−bipolarAmp · (dirAlongPole² − 0.40)`
  with FBM-jittered waist (turbulent equator) and lobe-asymmetry
  term applied to one hemisphere only. Bipolar bias faded out
  inside the cavity (`smoothstep(0.6, 1.3, r3D)`) so the centre
  stays spherical and shells don't read as rays from the source.
- **Filamentary (~25%)**: replaces `r3D` with a quadratic-Bezier
  tube SDF. Closest-point on `(P0, P1, P2)` curve via 12 sample
  points + 2 Newton-iteration refinements, then `r3D = distToCurve / thickness`
  with `thickness = mix(0.18, 0.55, sin(πt))` (narrow at ends,
  fat in middle). Per-nebula seed drives endpoint axis, bend
  direction, and bend amplitude.

### Field and shells

```
field = r3D + 0.75 * fbm3DN(p · 0.55) + biPolar
```

`fbm3DN` averages 2D simplex FBM on three orthogonal
projections (xy / xz / yz) — cheap "fake 3D" simplex without a
true 3D simplex implementation.

Five shells at field thresholds `1.50 · cavitySize`, `1.77 ·
cavitySize`, `1.97 · cavitySize`, `2.29 · cavitySize`, `2.59 ·
cavitySize`. Per-shell jitter offsets the threshold along each
direction by `0.10 · snoiseN(rotLocN · 0.8 + perShellOffset)`,
breaking the even-spacing heartbeat at any fixed angle. Each
shell renders a Gaussian on `|field − threshold|` with sigma
`0.06–0.13` (inner crisp, outer soft) and an asymmetric outer-
side darkening (`m *= mix(1.0, 0.18-0.40, smoothstep(0, σ, dF))`)
so shells read as "lit from within" — inner-facing surfaces
bright, space-facing dim.

### Volumetric integration

Front-to-back ray-march: 7 z-steps from `+ZMAX` to `−ZMAX` (=
`±2.7 v_baseR`). At each step:
1. Sample 3D field at `(loc, zStep)`.
2. Evaluate all 5 shell Gaussians, with per-shell asymmetric
   darkening and per-shell edge mask (Design A — see below).
3. Accumulate `rhoStep` and `colStep`.
4. Composite with running transmittance via Beer-Lambert:
   `shellMask += rhoStep * trans; trans *= exp(-rhoStep * 1.5)`.

Self-shadowing emerges naturally — front-side density attenuates
back-side contributions. Limb-brightening also emerges because
multiple z-steps land near the shell threshold at silhouettes.

### Per-shell edge masks (Design A)

Each shell has its OWN edge character — inner shells use ridged
FBM (crisp shock filaments), outer shells use smooth value FBM
(diffuse dust haze). Per-shell intrinsic softness `s ∈ {0.0,
0.25, 0.5, 0.75, 1.0}` for shells 0–4. Per-nebula `stratOffset
∈ [-0.4, +0.4]` shifts the gradient — negative biases all shells
crisp ("young"), positive biases all soft ("old"). Inside each
shell block:

```glsl
float es = clamp(intrinsic_s + stratOffset, 0, 1);
float edge = mix(ridgedEdge, smoothEdge, es);
m *= mix(fibreFloor, fibreFloor + 0.30, es)
   + mix(fibreGain, fibreGain * 0.5, es) * edge;
```

`ridgedEdge` and `smoothEdge` are computed once per fragment
before the integration loop; the per-shell `mix` blends between
them. Both come from the value-noise path (`ridgedFBMN` /
`vnoiseN`); `vhashN` uses Hoskins' sin-free hash so there
are no axis-aligned tiling artifacts.

### Per-nebula categorical axes

All driven by `v_seed`:

- **paletteIdx ∈ {0, 1, 2, 3}**: Crab synchrotron / OIII Helix /
  Hot blue NGC 7027 / dust-reddened. Each palette ships its own
  5 shell colors, glow tint, core tint, per-shell weights
  (front-loaded for Helix, back-loaded for dust, etc.), pulsar
  falloff, pulse rate, brightness — palettes are different
  physical species, not hue rotations.
- **morphCat (8 buckets, 25% filamentary)**: ellipsoid vs
  Bezier-tube filament.
- **centralFlavour ∈ {0, 1, 2}**: visible pinpoint / hidden
  source / off-centre pinpoint. Decoupled from interior fill —
  hidden source still glows the cavity gas.
- **interiorFillCat (3 weighted buckets)**: 50% full body / 35%
  moderate / 15% etched. Etched mode boosts fibre gain so the
  linework character is intentional.

Continuous axes: `bipolarAmp [0.30, 0.95]`, `cavitySize [0.60, 1.60]`,
`densityMult [0.70, 1.40]`, `fibreFreqMult [0.60, 1.50]`,
`fibrePow [1.0, 2.5]`, `fibreFloor [0.20, 0.45]`, `fibreGain [1.0, 1.8]`,
`stratOffset [-0.4, +0.4]`, `lobeAsymAmp [0, 0.45²]` (squared,
skewed toward mild).

### Cavity glow + pulsar pinpoint

Two-stop interior glow: tight `innerHalo = exp(-r²·5.5)·smoothstep(0.55, 0, r)`
follows the (possibly-offset) pulsar position; softer
`midGlow = exp(-r²·1.5)·smoothstep(1.10, 0, r)` stays centred on
nebula origin. Both scaled by `fillMult` so etched nebulae have
dim cavities and full nebulae have bright ones, independent of
pulsar visibility.

Pulsar pinpoint: `exp(-pulsarR²·pulsarFalloff) * pulseT * pulsarMul`,
where `pulsarFalloff` and `pulsarPulseRate` come from the
palette (Crab: 280 / 8.00 Hz; Helix: 150 / 4.50; blue: 200 / 6.00;
dust: 100 / 0.00 — no pulse).

*Cost:* the most expensive shader path. Per-fragment ALU is
~3000 (ellipsoidal) to ~4500 (filamentary). 7 z-steps × ~9
simplex calls (fbm3DN) + 5 ridged-FBM hashes per shell
(ridged + smooth edge masks) + per-step shock-mask + 5 shell
Gaussian evaluations + per-shell asymmetry + edge-mix +
per-step composite. Roughly **9–14× a plain star** per
fragment. Quad is the standard 4.3× v_baseR + 8, so per-
instance pixel count is the same as plain. Aggregate per
visible nebula ≈ 10× plain star. Nebulae spawn at 5–10% rates
(per `SPAWN_TABLE`) so typical scenes have 0–1 visible at a
time; the inspector grid (`nebula.html`) is the worst case
where many simultaneous nebulae stack.

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
| `fullscreen` bg  | ~30%  | Runs over every pixel every frame.  |
| `star` batch     | ~25%  | Grows with star count and variant mix. See per-variant cost ranking below. |
| `circle` batch   | ~10%  | bgStars, ball, planets, particles, hints. Cheap per pixel but many instances. |
| `polyline`       | ~2%   | Trail + replay + comet tails.       |
| `lensing` pass   | +60%  | Added **on top** only while a BH is on screen — roughly doubles total fragment work. |
| JS / state       | ~5%   | `draw()` batch build + renderer uniform uploads. Minor; physics/gameplay ticks are counted separately. |

### Per-variant fragment cost ranking

Approximate ALU per fragment, on the same per-quad pixel count
basis. Nebula is dramatically heavier than every other variant.

| Variant | Per-fragment ALU | Relative to plain star |
|---|---|---|
| Monolith | ~50 | 0.15× |
| Plain star | ~340 | 1× |
| Pulsar | ~150 | 0.4× (smaller body, big quad) |
| Ringworld | ~200 | 0.6× |
| Black hole | ~100 + ~80 fullscreen pass | varies |
| **Nebula (ellipsoidal)** | **~3000** | **~9×** |
| **Nebula (filamentary)** | **~4500** | **~13×** |

Nebula cost is dominated by the 7-step volumetric integration:
each step does a 3-projection 3-octave simplex FBM (~9 simplex
calls), evaluates 5 shell Gaussians with per-shell asymmetric
darkening and edge-mask mixing, and composites with running
transmittance. Filamentary Nebulae add a Bezier closest-point
search (12 samples + 2 Newton iterations) per z-step.

Back-of-envelope totals:
- **Plain scene** (no BH, no nebula): ~1× the fullscreen pass.
  Runs comfortably at 60 fps on any modern GPU, ~5–8 ms on
  integrated mobile.
- **Scene with one visible nebula**: adds ~10× one plain star's
  fragment work. With 6–8 visible stars, this is +20–30% total
  star-batch cost — still 60 fps on desktop, possibly noticeable
  on integrated mobile.
- **Scene with one visible BH**: ~1.6× the plain scene because
  of the lensing composite. Still 60 fps on desktop; mobile
  integrated GPUs may dip to 45–55 fps depending on FBO size.
- **Inspector grid (`nebula.html?grid=8`)**: 64 simultaneous
  nebulae. Total nebula cost ≈ 13 GFLOP/frame ALU. Desktop fine;
  mobile expects frame drops at large grid sizes.

If Nebula becomes a bottleneck, the cheap levers in priority:
- Reduce `N_STEPS` from 7 to 5 (~30% cheaper).
- Drop `fbm3octN` to 2 octaves instead of 3 (~25% cheaper).
- Skip filamentary Newton refinement — use only 12-sample
  estimate.

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
