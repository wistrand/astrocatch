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
`bh`, `bhBinary`, `monolith`, `ringworld`). Weights interpolate linearly
between rows and plateau past the last row. Normalized at
sample time, so values don't need to sum to 100.

Planets and comets are **orthogonal** rolls applied on top:

- **Planets**: ramp from 0 to `PLANET_PROB_MAX` over
  `PLANET_RAMP_STARS` captures. Allowed on `plain` and `bh`
  variants; binaries, monoliths, and ringworlds skip (their
  visuals already occupy the orbit volume).
- **Comets**: flat `COMET_PROB` chance from `COMET_MIN_STAR`+.
  Allowed on any variant.

Decision order in `makeStar`: variant → planets → comets. Swap
`SPAWN_TABLE_GAME` for `SPAWN_TABLE_DEBUG` to force-spawn a type
for testing.

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
