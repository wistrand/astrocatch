# Rendering

All pixel work lives in `renderer.js` (WebGL2, browser-only).
`gameplay.js draw()` is pure orchestration: it advances per-entity
state and hands the renderer typed batches of instances.

## Shader programs

Six programs cover the entire render surface:

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
  Past stars short-circuit to a dim ember. Receives every star
  *except* live nebulas — those route to the `nebula` program.
  *Cost:* variable by branch (see per-variant sections below).
  Plain-star path is ~30–80 ALU + ~10 trig per fragment with
  5–8-iteration streamer/granule loops; past-star branch is
  near-zero; monolith/ringworld branches are heavier. Quad
  covers corona radius (~2–3× `baseR`), so pixel count per
  instance dwarfs per-pixel ALU for late-game star counts.
  Worst-case branch is ringworld+plates (~32 reg).
- **`nebula`** — same source as `star`, compiled with
  `#define NEBULA_ONLY` prepended. The preprocessor strips out
  the noise helpers and the `if (isNebula) { ... }` block from
  the `star` build, and strips out everything else from the
  `nebula` build. Two GL programs, one source of truth. CPU
  partitions stars: `isNebula && !isPast` → `nebula` program,
  everything else (including past nebulae, which render as the
  dim ember) → `star` program. Two `drawArraysInstanced` calls
  per frame when nebulae are visible; the second is gated by
  count > 0. Both share the same VAO + instance buffer; the
  partitioning runs in a single pass through the star list.
  *Cost:* nebula path itself is ~2500-3200 ALU per fragment
  (see per-variant section). Splitting it out lets the `star`
  program drop into a smaller register tier on mobile-class
  GPUs (was nebula-set, now ringworld+plates-set), improving
  SIMT occupancy on every plain-star fragment in scenes with
  no nebulae visible — i.e. the 90 %+ case in normal play.
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
- `4096` — isTeapot
- `8192` — isAzazel

The vertex shader picks the quad extent multiplier per-variant:
- isPulsar → `5.0 × baseR + 8` (lens-flare reaches 3.5× baseR).
- isAzazel → `2.4 × baseR + 8` (silhouette tops out at
  `ASPECT_Y + SPIKE_LEN_MAX = 2.05` baseR units).
- everything else → `4.3 × baseR + 8`.

Pulsar lens-flare halos and streaks otherwise hit the rectangular
quad boundary at peak alignment; Azazel's tighter quad is purely a
perf optimisation (≈77% fewer fragments running the demon shader).

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

Flag bit 2048. The most expensive shader path in the renderer —
runs in its own GL program (`nebula`) compiled from STAR_FS with
`#define NEBULA_ONLY`. Live nebulae are partitioned out of the
star batch and drawn in a second `drawArraysInstanced` call;
past nebulae render through the common `star` program as the
dim ember (no flag dispatch needed).
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

`fbm3DN` is 3 octaves of native 3D simplex (Stefan Gustavson's
tetrahedral implementation). Earlier versions averaged 2D
simplex on three orthogonal projections (xy / xz / yz); native
3D is ~30% cheaper per FBM evaluation and gives smoother z-
evolution because consecutive z-steps decorrelate via the
gradient instead of sharing the xy-projection sample.

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
~2500 (ellipsoidal Crab) to ~3200 (filamentary dust). Was
~3000-4500 before the optimization pass: pre-loop hoists for
shockMask / per-shell jit / edge masks / baseShell / luma,
3σ shell skip, transmittance early-out, Plummer-softened
single-scatter halo, native 3D simplex (replacing the old
3-projection-averaged 2D simplex). 7 z-steps × 3 native 3D
simplex calls (fbm3DN) + ridged + smooth edge masks (pre-
loop) + 5 shell Gaussian evaluations (each 3σ-skipped) +
per-step composite. Roughly **7–10× a plain star** per
fragment. Quad is the standard 4.3× v_baseR + 8, so per-
instance pixel count is the same as plain. Nebulae spawn at
5–10% rates (per `SPAWN_TABLE`) so typical scenes have 0–1
visible at a time; the inspector grid (`variants.html?type=nebula`)
is the worst case where many simultaneous nebulae stack.

## Russell's teapots

Flag bit 4096. Rare Easter-egg variant — the Russell teapot
thought experiment realised as a physical object: tumbling
porcelain teapot in space. Sphere-traced SDF rendered inside
the common `star` program (no separate program; register peak
~10 reg, well under the ringworld+plates ceiling).

### SDF

Five smin-blended primitives:

- **Body** — two ellipsoids smin'd at k=0.10. Lower (1.0, 0.6,
  1.0) is the wide bulge, upper (0.65, 0.20, 0.65) at y=0.50 is
  the shoulder taper. Smooth-max with a horizontal plane at
  y=-0.55 (k=0.04 fillet) gives a flat foot — the teapot has a
  base to sit on.
- **Lid** — flatter spheroid (0.50, 0.10, 0.50) at y=0.66, smin'd
  to body at k=0.05.
- **Knob** — sphere r=0.10 at y=0.80.
- **Spout** — quadratic-Bezier tube, control points
  `(0.85, 0.05) → (1.25, 0.30) → (1.45, 0.60)`, thickness tapers
  0.18 → 0.05. 6-sample coarse search + 2 Newton refines (the
  arc has a single bend, so 6 samples suffice — vs the 12 the
  nebula filament path needs for high-bend cases).
- **Handle** — vertically-elongated elliptical torus on the -x
  side. Custom inline SDF (semi-axes 0.18 × 0.30, tube 0.06)
  rather than scaling a standard `sdTorus`, which would distort
  the SDF and risk overshoots.

Bounding-sphere early-out at the top: if `length(p) - 1.7 > 0.30`
return the bound directly without evaluating any primitives. Far-
march fragments take ~5 ALU/step instead of ~245.

### Pattern

Cobalt-on-porcelain via 3-octave 3D value-noise FBM (no UV seam
that 2D-cylindrical mapping would produce on the handle's tube).
Two structural framings on top of the procedural noise:

- **Foot fade** — `pattern *= smoothstep(-0.53, -0.45, p.y)` so
  the flat base is clean porcelain.
- **Collar band** — half-cobalt ring at the body-lid junction,
  bandY in `[0.50, 0.60]`, gated radially via
  `length(p.xz) < 0.85` so the spout (passes through this y at
  radial 1.13+) and handle (outer arc at radial 1.09) keep their
  procedural decoration rather than turning into a solid blue
  belt around the whole teapot.

### Shading

Three-light ceramic — key (slowly precessing around y at 0.10
rad/s) + fixed fill + neutral ambient. Phong specular (power 64)
tinted by the per-instance star colour `v_c1` so each teapot has
a recognisable glaze cast. Power-3 fresnel rim with a fixed
cool-blue tint.

### Tumble

Rodrigues rotation around a per-teapot axis at 0.20 rad/s
(≈31 s revolution). The axis has a strong +y bias
(`cos(seed * 1.7) + 2.0`, with x/z components scaled by 0.20) so
after normalize `tAxis.y ≥ 0.96` — the body's vertical axis
traces a tiny cone of ≤16° as the teapot rotates. Lid stays
clearly upward at every moment.

Initial angle bimodally distributed near `0` or `π` (the two
profile views, spout at +x or -x) so teapots spawn closer to
profile rather than face-on. After spawn, the tumble carries
through all azimuths.

### Coordinate frame

Note: world Y is *down* in this codebase (screen-pixel
convention; `screenMat` flips to clip-space). The teapot SDF puts
the lid at +y and the foot at -y, so the rendering branch
negates `loc.y` when building the ray origin to keep "lid up,
foot down" on screen. This is the only variant that depends on
world-up direction; monolith/ringworld/etc. are rotationally
ambiguous in the relevant axes.

*Cost:* sphere-trace at 48 steps. Per-fragment varies wildly:
~150 ALU on far misses (bound returns immediately), ~5000 on
hits, ~5500 on near-miss silhouette band. Frame average for a
viewport showing one teapot at standard size: ~1700-2400 ALU.
Comparable to nebula. Spawns at ~1 % from star ≥ 50 so typical
scenes have zero teapots; impact on aggregate frame cost is
negligible most of the time.

## Azazel

Flag bit 8192. Demon manifesting through a rip in space — pure
2D SDF, no ray-marching. Drawn inside the common `star` program;
working set comparable to teapot (~20-25 reg). Endgame variant
(1-2% from star ≥ 50), high zoom (4.5× desktop / 2.5× touch
on top of the base ZOOM 0.58) when captured.

### Body silhouette

Tilted elongated ellipse (semi-axes `(ASPECT_X, ASPECT_Y) =
(0.55, 1.45)` in `v_baseR` units, per-instance tilt ±0.3 rad)
with three additive perturbations:

- **Edge noise** — 4-wave plane-direction noise (triangle waves
  on the dominant terms, |sin| cusp + smooth sin on the detail
  terms) with independent phase drifts. Bell-shape `edgeMask` so
  noise only fires inside `|base| < 0.20` — gated branch skips
  the 4-hash + 4-trig evaluation entirely on deep-interior or
  far-outside fragments.
- **Spikes** — 14 angularly-spaced tapered cones radiating from
  the ellipse boundary. Replaces a per-spike SDF loop with a
  *nearest-spike* finder: parametric (q-space) angle `atan(q.y, q.x)`
  → `floor((angParam - phase) / period + 0.5)` gives the spike
  index, then evaluates the analytic tapered-cone SDF for that
  one spike. ~50 ALU vs ~400 for the original 14-iter loop, and
  the resulting SDF is approximately normalized so `-d` gives
  correct inner-glow distance everywhere (body interior, spike
  base, spike interior, spike tip — no detached-spike artifacts).
  Per-slot presence (`step(0.25, hash)`) drops ~25% of slots
  to break up the periodic regularity. Far-corner early-out
  (`dot(pr, pr) < 4.7`) skips the spike-finder entirely past
  max spike reach.
- **Blobs** — two `smin`'d circular protrusions at random per-
  instance offsets, soften the ellipse silhouette.

Whole-rip breathing scale (`breath = 1 + 0.32·sin(t·0.40)`)
applied as `p /= breath` at entry and `return base * breath` at
exit, so the rip rhythmically inflates/deflates.

### Inner glow

`exp(-innerDepth · 5.0) · 1.10` red glow, where `innerDepth = -d`.
Because the spike SDF is normalised, glow correctly fades from
the actual silhouette boundary inward — bright at the body
boundary, bright at the spike base where it meets the body,
dimming toward each spike tip.

### Faces

Three stacked face tiers inside the body. Each face is a paired-
eye + grin combo:

- **Eyes** — paired triangular wedges with per-eye inward sneer
  tilt and a `sin(π · axisFrac)` bow on `lp.y` so the eye edges
  curve inward (almond shape). Iris dot inside, fixed red.
  Animates with a blink phase (`sin(t · 0.30 + fi · 1.7)`) shaped
  by `1 - pow(max(blinkPhase, 0), 12)` for sharp closes with long
  open holds. Gated on `blink > 0.02` so the IQ triangle SDF
  never sees a degenerate (collinear) input.
- **Mouth** — two rows of rhombus-tooth SDFs. Each jaw rolls its
  own outer-curve shape ∈ [-0.6, +0.6] from the seed (convex,
  flat, or concave fangs); upper and lower are independent. The
  mouth's vertical envelope grows with positive `halfGap` so
  the lips visibly stretch open as the gap widens, instead of
  the teeth shrinking inside a fixed box. Per-fragment outer
  reject is a cheap rect bbox (the cap-ellipse SDF was a misuse
  — the visible shape is decided downstream by the per-tooth
  scan, the cap only saves work on far fragments).

Per-face seed rolls (8 hash11 calls in the original) packed
into two `vec4` hashes per iteration, collapsing 8 scalar
sin/fract pairs into 2 vec4 ops on vec-SIMD GPUs.

Face features blend into the inner glow via `faceMask = 1 -
exp(-innerDepth · 5.0)` — zero at the rip border so eyes and
teeth dissolve smoothly into the glow band instead of hard-
clipping against the silhouette edge.

### Camera + audio

While captured, `zoomTargetFor` returns a `zoomMult` of
**4.5× desktop / 2.5× touch** (vs ringworld's 1.7/1.5,
nebula/teapot's 1.6/1.4). Effective on-screen zoom is
`ZOOM · zoomMult` — biggest of any variant.
Music switches to a Phrygian demon-mode chord progression
(`[Am, Bb, Dm, E]` / `[Em, Bb, Dm, E]`) at the next section
boundary. Reverts on leaving the orbit.

*Cost:* outside silhouette ~80-150 ALU (sdRip body, edge-noise
gated out, spike SDF gated by far-corner check on most pixels,
return alpha=0). Inside silhouette ~600-900 ALU (sdRip + 3-face
loop with eye/iris/mouth SDFs). Quad is 2.4× v_baseR (~77%
fewer fragments than the original 5× sized for halftone +
0.85-length spikes — both gone), so frame cost is dominated by
the inside-silhouette region. At Azazel zoom this is most
of the screen, so the demon comfortably costs more than any
other variant *while captured* — but spawn rate is endgame, so
the aggregate impact across a typical run is small.

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
| `star` batch     | ~20%  | Most stars in late game. Lighter shader since nebula split out. |
| `nebula` batch   | +10–25% | Added **on top** only when nebulae are visible. Same VAO/buffer as `star`; one extra `useProgram` + `bufferData` + draw. |
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
| Azazel (outside silhouette) | ~80-150 | 0.3× (gated edge noise + far-corner spike skip) |
| Azazel (inside silhouette) | ~600-900 | ~2× (3-face loop with eye/iris/mouth SDFs) |
| Teapot (frame avg) | ~1700-2400 | ~5-7× (heavy on hits ~5000, cheap on far misses ~150 due to bounding sphere) |
| **Nebula (ellipsoidal)** | **~2500** | **~7×** |
| **Nebula (filamentary)** | **~3200** | **~10×** |

Nebula cost is dominated by the 7-step volumetric integration:
each step does a 3-octave native 3D simplex FBM (3 simplex
calls — replaced the old 9-call projection-averaged version),
evaluates 5 shell Gaussians with per-shell asymmetric darkening
and edge-mask mixing (each shell skips when |dF| > 3σ), composites
with running transmittance, and breaks once `trans < 0.005`.
Optional palette-aware single-scatter halo adds ~25 ALU/step on
non-Crab palettes when shell 4 contributes. Filamentary nebulae
add a Bezier closest-point search (12 samples + 2 Newton
iterations) per z-step.

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
- **Inspector grid (`variants.html?type=nebula&grid=8`)**: 64
  simultaneous nebulae. Total nebula cost ≈ 9 GFLOP/frame ALU.
  Desktop fine; mobile expects frame drops at large grid sizes.

If Nebula becomes a bottleneck, the cheap levers in priority:
- Reduce `N_STEPS` from 7 to 5 (~30% cheaper).
- Drop `fbm3DN` to 2 octaves instead of 3 (~25% cheaper).
- Skip filamentary Newton refinement — use only 12-sample
  estimate.
- Disable the dust-scatter halo (set per-palette `scatterMul`
  to 0) — saves ~5-10% on Helix / NGC / dust palettes.

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
