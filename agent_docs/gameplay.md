# Gameplay mechanics

## Camera

- `ZOOM` — world scale. Touch devices get a wider view.
- `CAM_FOCUS_Y` — vertical fraction where the current star sits.
- Camera follows upward star progression via `camY`.

## Input

- **Click / Space** — boost (left-click / touch; right-click and
  middle-click ignored).
- **P** — pause / resume.
- **Arrow keys** — nudge orbital velocity ±2% while in orbit
  (unclamped — extreme nudging can crash or escape). Emits an
  exhaust puff as visual feedback.
- **M** — toggle mute.
- **W** or tap the score display — toggle the launch-window hint.
- **H** or click the **?** button — toggle the help overlay
  (pauses the game while open).
- **Esc** — close help.
- **Focus-click suppression**: clicks within 150 ms of a
  `window.focus` event are ignored, so bringing the window
  forward from behind doesn't fire a boost.

## Pause

Game is paused by pressing **P**, tapping the **paused**
indicator that appears in the HUD, or opening the help overlay. All of these go through
`syncPausedIndicator()` which also calls
`audio.setMusicPaused(paused)` to halt the music scheduler —
timeline stays aligned across long pauses. The **paused**
text is only visible during `STATE.PLAY`; dying or dead runs
clear it automatically.

Paused state is cleared on `init()` (new game) and stored
high score is persisted via `saveBest()` on `pagehide`,
`beforeunload`, and `visibilitychange → hidden` so a high
score from an interrupted run isn't lost.

## Scoring

### Quick-launch bonus

Tracked via `ball.framesInOrbit`. At boost time, orbit fraction
determines bonus tier (Blazing / Quick / regular). Locked in on
tap, applied in `captureStar`.

### Fast-launch streak

Consecutive Quick/Blazing captures grow `fastStreak` (capped at
`FAST_STREAK_CAP`). Multiplier ramps via `streakMultiplier()`.
Breaks on a slow capture or death. Score earned =
`Math.round(bonus * streakMultiplier)`.

### Comet bonus

Close pass within `COMET_SCORE_RADIUS` awards `COMET_BONUS`
points, sparkle burst, twinkly sound, comet removed.

## Spawn table

`SPAWN_TABLE` is a list of rows at star-index control points.
Each row lists weights for each variant (`plain`, `binary`,
`bh`, `bhBinary`, `monolith`, `ringworld`, `pulsar`, `nebula`,
`teapot`). Weights interpolate linearly between rows and plateau
past the last row. Normalized at sample time, so values don't
need to sum to 100.

Planets and comets are **orthogonal** rolls applied on top:

- **Planets**: ramp from 0 to `PLANET_PROB_MAX` over
  `PLANET_RAMP_STARS` captures. Allowed on `plain` and `bh`
  variants only; binaries, monoliths, ringworlds, pulsars,
  Nebulae, and teapots skip (their visuals already occupy the
  orbit volume).
- **Comets**: flat `COMET_PROB` chance from `COMET_MIN_STAR`+.
  Allowed on any variant except monoliths (alien/alone vibe) and
  teapots (the Russell gag reads cleanest with the teapot solo
  on screen). Pulsars and Nebulae are fine — debris disks around
  real pulsars and comets weaving through nebula filaments both
  read naturally.

Decision order in `makeStar`: variant → planets → comets. Swap
`SPAWN_TABLE_GAME` for `SPAWN_TABLE_DEBUG` to force-spawn a type
for testing.

`addNextStar` pre-rolls the variant via `pickVariant(n)` so
pulsars / Nebulae / teapots can claim a higher minimum spawn
radius — pulsars and Nebulae get `r ≥ 30` (tiny core / fine
shell detail), teapots get `r ≥ 25` (spout tip thickness is
0.05 × v_baseR — sub-pixel below ~r=18). Default is `r ≥ 18`.
The pre-rolled variant is then passed to `makeStar(..., variant)`
to avoid a second roll producing a different result.

## Star generation

`addNextStar` ramps difficulty over the first ~60 captures:
inter-star distance, cone spread, and radius all scale with
`difficulty = min(n / 60, 1)`. On landscape screens, the cone
spread widens proportionally to the aspect ratio so stars use
the available horizontal space. `SAFE_SEP` floor prevents
Voronoi overlap.

## Binary stars

Two sub-stars orbiting their common center of mass. The star
entry in `stars[]` sits at the COM with combined GM; physics
sees a single point mass. Sub-stars have independent visual
radii, colors, and crash zones that move with the orbit.

- **Mass ratio** `q` in `[0.2, 0.65]` — the companion is visibly
  smaller than the primary.
- **Tidal locking**: sub-star shader seeds track the orbital
  angle so visual features rotate exactly once per orbit.
- **Wider peri floor**: `predictCapture` uses `minPeriMult = 2.2`
  for binary targets (vs 1.5 for normal stars) so captured
  orbits clear the sub-stars' reach.
- **Crash detection**: both sub-stars checked in live physics,
  prediction, and DYING freeze.
- **Stripped on capture**: binary data cleared alongside planets
  and comets when leaving a star.

## Black holes

Flagged `isBlackHole: true`. Same physics as normal stars
(gravity, collision, capture). Rendered with event horizon,
Interstellar-style accretion disk, and gravitational lensing
via FBO composite pass with a procedural background grid. The
dashed hint ring is suppressed for BH targets since the grid
and disk already mark the zone. `BH_VISUAL_SCALE` makes the
event horizon visibly smaller than the physics radius.

**BH binaries** (`bhBinary` variant): the accretor sub-star is
the black hole. The donor emits physics-driven ejecta particles
that arc from its surface and spiral into the BH under inflated
gravity + distance-dependent drag. Particles use the donor's
color.

## Monoliths

Flagged `isMonolith: true`. Physics identical to normal stars
(gravity, collision, capture). Rendered as a raymarched 3D slab
in 1:4:9 proportion (classic 2001), tumbling around a random
per-monolith axis derived from the star's seed. Near-black body
with a cyan-blue fresnel rim at silhouette edges.

Monoliths don't wobble on crash, don't get planets or comets,
and can't be binary components (the raymarched occlusion against
moving sub-stars doesn't work cleanly in 2D). Hint ring and
launch window behave normally.

## Ringworlds

Flagged `isRingworld: true`. Physics identical to normal stars
— the band is purely visual. Rendered as a ray-cylinder-
intersected habitat of radius `2.6 * s.r` and height `1.0 *
s.r` wrapping a small central sun, tumbling around a per-star
axis (monolith-style Rodrigues rotation). Inside face is
earth-textured with clouds; outside face is dark structural.
Camera-direction lighting + specular hotspots + warm fresnel
rim glow on the inside sell 3D curvature.

Ringworlds skip planets and comets and can't be binary
components. While the ship's `currentStar.isRingworld` is true,
the gameplay camera smoothly eases to a 1.5× zoom (`zoomMult`
lerped at 0.05/frame) so the tumbling band stays legible; it
eases back to 1.0× on the next capture.

Each ringworld also carries a random `ringPlateCount` in
`[0, 7]`, set at spawn (`Math.floor(Math.random() * 8)`). This
value is packed into the star instance's flag bits and drives
the shader's shadow-plates / day-night / city-lights path:
- `0`: no plates, no shadows, no city lights (~1 in 8 rings).
- `1–7`: N orbiting shadow plates projecting rotating dark
  sectors onto the inside face; warm city lights appear on
  land in the deep-night zones.

The ringworld resume/continue orbit radius is `3.2 × r` so the
ship clears the band (at `2.6 × r`).

## Pulsars

Flagged `isPulsar: true`. Physics identical to a normal star
(gravity, collision, capture). Rendered as a tiny dense neutron-
star body with two opposed lighthouse beams sweeping a slowly-
drifting magnetic axis; alignment with the camera produces a
brief lens-flare burst (diffraction spikes, anamorphic streak,
iris ring with crescent cut, halo bloom). Body colour and pulse
character take from the per-star `colorIdx` palette so different
pulsars read visually distinct.

Pulsars skip planets (the body is too small to support a
visible planetary system) but allow comets — debris disks
around real pulsars are documented (PSR B1257+12 was the first
exoplanet host). They can't be binary components (the lens-
flare composite assumes a single source).

Pulsars use a higher minimum spawn radius (`r ≥ 30`) so the
small body and large lens-flare quad both render at usable
detail — at default `r = 18` the visible core is only ~6 px and
gets lost. Beam cones reach `3.5 × v_baseR` at peak edge-on
alignment; the renderer uses an enlarged 5.0× quad for pulsars
specifically (vs 4.3× for all other variants).

## Nebulae

Flagged `isNebula: true`. Physics identical to a normal star.
Rendered as a volumetrically integrated 5-shell nebula sampling
multiple per-nebula categorical and continuous parameter axes
from the star's seed:

- **Palette class** (4 buckets): Crab synchrotron, OIII Helix,
  hot blue NGC 7027, dust-reddened. Each ships its own shell
  colours, weights, glow tint, and pulsar character.
- **Morphology class** (8 buckets, 25 % filamentary): default
  ellipsoidal shells, or quadratic-Bezier tube filament
  (cigar / bent / S-curve dust lane) for ~1 in 4 nebulae.
- **Central-source flavour** (3 buckets): visible pinpoint /
  hidden source / off-centre pinpoint. Decoupled from interior
  fill so a hidden-source nebula can still have bright cavity
  gas (Helix-like) and a visible-pulsar nebula can have a
  sparse cavity (etched aesthetic).
- **Interior fill density** (3 weighted buckets): 50 % full
  body / 35 % moderate / 15 % etched. Etched mode boosts the
  edge fibre gain so the linework character is intentional.
- Plus continuous: bipolar amplitude, cavity size, density,
  fibre frequency / pow / floor / gain, stratification offset
  (radial crisp-to-soft gradient), lobe asymmetry (skewed
  squared distribution → most nebulae mild, ~10 % wildly
  lopsided outliers).

Nebulae skip planets (the gas envelope occupies the orbit
volume), allow comets, and can't be binary components. They use
the same higher minimum spawn radius (`r ≥ 30`) as pulsars —
the volumetric integration's 5-shell network needs room to
develop visible structure across `r3D ≈ 0.5` to `2.5 × v_baseR`.

While the ship's `currentStar.isNebula` is true, the gameplay
camera eases to a 1.6× zoom (vs 1.7× for ringworlds, 1.0×
otherwise) so the nebula's internal structure stays legible.
The `visualR` extent for the screen-edge horizontal-camera-
nudge logic is `r * 2.7` for nebulae (vs `r * 3.6` for ringworlds,
`r * 2.5` for everything else).

The `nebula.html` inspector page (`?seed=N&grid=NxM`) renders a
deterministic grid of Nebulae for population review.
URL-driven seed and grid size make populations reproducible
across reloads.

## Russell's teapots

Flagged `isTeapot: true`. Physics identical to a normal star
(gravity, capture, scoring). Rendered as a sphere-traced SDF
porcelain teapot — body / lid / knob / Bezier-tube spout /
elliptical-torus handle, smin-blended into a single ceramic
surface. Procedural cobalt-on-porcelain pattern (3D value-noise
FBM, no UV seam) with a clean foot and a half-cobalt collar
band at the body-lid junction. Glossy ceramic shading: three-
light setup with a slowly-precessing key light, Phong specular
tinted by the per-instance star colour `v_c1` (so each teapot
has a recognisable glaze cast), power-3 fresnel rim.

Tumble axis is strongly +Y biased (`tAxis.y ≥ 0.96` after
normalize) so the body stays roughly vertical with at most ~16°
tilt as the teapot rotates; lid stays clearly upward. Initial
angle is bimodally distributed near `0` or `π` so teapots spawn
near profile (spout to either side), not face-on.

The SDF coordinate frame puts the lid at +y. World coordinates
in this codebase use +Y-down (`screenMat` flips to clip space),
so the rendering branch negates `loc.y` when entering the SDF
frame to keep "lid up" on screen.

**Russell reference.** Bertrand Russell's 1952 thought experiment
posits a tiny porcelain teapot orbiting the Sun between Earth
and Mars, too small to be detected by any telescope. Used
philosophically to argue against unfalsifiable claims. The
in-game teapot is, as the shadertoy port's description puts it,
*not that teapot* — but it's a deliberate Russellian wink.

**Spawn rate.** 0 % until star 50, then 1/89 ≈ 1.1 % at endgame.
A typical run from star 0 won't see one; deep runs reliably
do. The Easter-egg payoff lands when the player's already
invested.

**Higher minR (`r ≥ 25`).** The spout's tip thickness is
0.05 × v_baseR. Below `r ≈ 18` it goes sub-pixel and disappears
into AA. 25 keeps spout and handle tube readable.

**Camera zoom.** While the ship's `currentStar.isTeapot` is
true, the camera eases to a 1.6× zoom (matching the nebula
multiplier). `visualR` for the screen-edge horizontal-camera-
nudge logic is `r * 1.7` (the SDF bounding sphere).

**Save/resume.** Round-trips `isTeapot` alongside the other
variant flags. Captured teapots persist through saves.

## Crash wobble

When the ship crashes, the star gets a decaying elliptical
deformation (`s.wobble`, `s.wobbleAngle`) — squeezed flat on
the impact side, relaxing over ~1.5 s. Driven through the star
shader via per-instance wobble attributes. Monoliths are
excluded (rigid 3D body).

## Launch-window hint

Toggled by `W` or clicking the score display. When on, short
white tangent ticks appear on a 10 %-inset ring of the ship's
actual orbit at angles from which a tap would produce a clean
capture. Sampled at fixed star-frame angles (0°, 10°, … 350°)
via a forward-simulation of the ship's current trajectory, so
ticks stay anchored in space as the ship orbits through them.

Recomputed on capture, on arrow-key nudge (orbit reshape), and
every `LAUNCH_WINDOW_RECOMPUTE_FRAMES` (12 physics frames ≈
0.1 s) while the current star has planets or is a binary — so
slow perturbations keep the hint in sync without burning CPU.
Static orbits don't trigger re-recompute.

All per-recompute state is pooled: sample + result arrays are
module-level scratch objects, and `predictCapture` takes an
optional `outResult` buffer so its success return doesn't
allocate. `predictCapture`'s crash-check loop starts at
`currentStarIdx` (skips past stars), cutting late-game cost
roughly in half.

**Tutorial default**: the hint is auto-enabled at the start of
the first `TUTORIAL_GAMES` (3) gameplays, and auto-hides once
the player captures `TUTORIAL_STARS` (15) stars in those runs.
The player can still toggle it off manually at any time.
Gameplay count is persisted in `localStorage`
(`astrocatch_gameplays`).

## Death sounds

- `deathCrash()` — soft sine droplet, played on star collision.
- `death()` — harsh sawtooth descent, played on escape into space.

## Replay

Records `{x, y, currentStar}` per render frame (max `REPLAY_MAX`
FIFO). Dynamic follow-camera with simplex zoom on the DEAD
screen. Trailing window caps the polyline. Music keeps playing
across runs.

## Window resize

`resize()` re-centers the camera on the current star (`camY`
and `camTargetY` both snapped) so a window resize or mobile
orientation flip doesn't leave the ship off-screen. The
seeded PRNG that places background stars sees the same
sequence per session, so they stay anchored across resizes.

## Perf notes

Several late-game hot paths have been specifically tuned:

- `predictCapture` crash loop starts at `currentStarIdx`
  instead of 0 — past stars can't collide with a forward-going
  trajectory.
- Star batch skips past stars older than
  `ball.currentStar - PAST_STAR_KEEP` (6): scrolled-off embers
  carry no gameplay info and their quad fragments aren't free.
- Launch-window recompute uses pooled sample + result objects
  and a reused `predictCapture` out-parameter.
- Music voices call `osc.onended = () => disconnect()` so
  stopped audio nodes are GC-eligible immediately (otherwise
  mobile accumulates zombie graph nodes under high note rate).

## Bluetooth audio compensation

`audio.getOutputLatency()` reads `ctx.outputLatency`. When it
exceeds 60 ms (indicative of BT headphones), the capture SFX
is pre-scheduled `outputLatency` seconds ahead of the actual
capture event so the chime arrives at the user's ears at the
visual moment. Reactive SFX (boost on tap) can't be compensated;
the boost exhaust burst is beefier than strictly necessary to
make the tap land visually.

## Start screen

Shows stored high score if available (visibility-based, no
layout shift). Best score loaded from `localStorage`.

## HUD buttons

`reload` (bottom-left), `?` help (next to reload), `fullscreen`
(bottom-right, hidden on iOS Safari), `mute` (bottom-right).

## Tunables

Spawn rates live in `SPAWN_TABLE`, `PLANET_PROB_MAX`,
`PLANET_RAMP_STARS`, `COMET_PROB`, `COMET_MIN_STAR`. Other
tunables near the top of `gameplay.js`: `ZOOM`, `CAM_FOCUS_Y`,
`PHYSICS_HZ`, `MAX_FRAME_GAP_MS`, `MISS_GRAVITY_MULT`,
`DYING_FRAMES_MS`, `COMET_SCORE_RADIUS`, `COMET_BONUS`,
`FAST_STREAK_CAP`, `BH_VISUAL_SCALE`, `EJECTA_MAX`,
`EJECTA_GM_MULT`.
