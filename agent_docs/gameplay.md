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
  (unclamped — extreme nudging can crash or escape).
- **M** — toggle mute.
- **W** or tap the score display — toggle the launch-window hint.
- **H** or click the **?** button — toggle the help overlay
  (pauses the game while open).
- **Esc** — close help.
- **Focus-click suppression**: clicks within 150 ms of a
  `window.focus` event are ignored, so bringing the window
  forward from behind doesn't fire a boost.

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
Each row lists weights for each variant (`plain`, `binary`, `bh`,
`bhBinary`). Weights interpolate linearly between rows and
plateau past the last row. Normalized at sample time, so values
don't need to sum to 100.

Planets and comets are **orthogonal** rolls applied on top:

- **Planets**: ramp from 0 to `PLANET_PROB_MAX` over
  `PLANET_RAMP_STARS` captures. Allowed on `plain` and `bh`
  variants; binaries skip (the sub-stars already occupy the
  orbit volume).
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

## Crash wobble

When the ship crashes, the star gets a decaying elliptical
deformation (`s.wobble`, `s.wobbleAngle`) — squeezed flat on
the impact side, relaxing over ~1.5 s. Driven through the star
shader via per-instance wobble attributes.

## Launch-window hint

Toggled by `W` or clicking the score display. When on, short
tangent ticks appear around the current orbit at angles from
which a tap would produce a clean capture. Computed once per
capture (`computeLaunchWindow`) by sampling 36 angles × ~6
boost factors with early-exit; cached and rotated with the
orbit.

## Death sounds

- `deathCrash()` — soft sine droplet, played on star collision.
- `death()` — harsh sawtooth descent, played on escape into space.

## Replay

Records `{x, y, currentStar}` per render frame (max `REPLAY_MAX`
FIFO). Dynamic follow-camera with simplex zoom on the DEAD
screen. Trailing window caps the polyline. Music keeps playing
across runs.

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
