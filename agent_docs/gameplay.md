# Gameplay mechanics

## Camera

- `ZOOM` — world scale. Touch devices get a wider view.
- `CAM_FOCUS_Y` — vertical fraction where the current star sits.
  Higher = lower on screen. Touch uses a lower position.
- Camera follows upward star progression via `camY`.

## Input

- **Tap / Space**: boost (left-click or touch only; right-click
  and middle-click ignored).
- **P**: pause / resume during gameplay.
- **Arrow keys**: nudge orbital velocity ±2% while in orbit
  (unclamped — extreme nudging can crash or escape).
- **M**: toggle mute.
- **Focus-click suppression**: clicks within 150 ms of a
  `window.focus` event are ignored, preventing accidental boosts
  when clicking to bring the browser window forward.

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

All spawn probabilities live in the centralized `SPAWN` object.
Decision order in `makeStar`: black hole → binary → planets →
comets.

| Type              | Prob       | From star | Notes                         |
|-------------------|------------|-----------|-------------------------------|
| Black hole (solo) | 7%         | 4+        | lensing + grid                |
| Binary (normal)   | 0→12%      | 15→40     | two stars, no ejecta          |
| BH + binary       | 0→8%       | 15→40     | BH accretor + donor ejecta    |
| Planets           | 0→75%      | ramp/50   | 1–2 per star (not on binaries)|
| Comets            | 25%        | 2+        | on any star incl. binaries    |

## Star generation

`addNextStar` ramps difficulty over the first ~60 captures:
inter-star distance, cone spread, and radius all scale with
`difficulty = min(n / 60, 1)`. On landscape screens, the cone
spread widens proportionally to the aspect ratio (`aspectBoost`)
so stars use the available horizontal space. `SAFE_SEP` floor
prevents Voronoi overlap.

## Binary stars

Two sub-stars orbiting their common center of mass. The star
entry in `stars[]` sits at the COM with combined GM; physics
sees a single point mass. Sub-stars have independent visual
radii, colors, and crash zones that move with the orbit.

- **Mass ratio** `q` in `[0.2, 0.65]` — the companion is
  visibly smaller than the primary.
- **Tidal locking**: sub-star seeds track the orbital angle so
  visual features rotate exactly once per orbit.
- **No planets** on binaries; comets still allowed.
- **Crash detection**: both sub-stars checked in live physics,
  prediction, and DYING freeze.
- **Stripped on capture**: binary data cleared alongside planets
  and comets when leaving a star.

## Black holes

Some stars are flagged `isBlackHole: true` (see `SPAWN` table).
Same gameplay mechanics as normal stars but rendered with event
horizon, accretion disk, and gravitational lensing with a
procedural background grid for visible distortion. The dashed
hint ring is hidden for BH targets since the grid serves the
same purpose. `BH_VISUAL_SCALE` makes the event horizon visually
smaller than the physics radius.

Black holes can be the accretor in a binary pair. The donor star
has physics-driven ejecta particles that arc from its surface and
spiral into the BH under inflated gravity + distance-dependent
drag.

## Crash wobble

When the ship crashes into a star, the star gets a decaying
elliptical deformation (`s.wobble`, `s.wobbleAngle`) — squeezed
flat on the impact side, relaxing over ~1.5 s. Driven through
the star shader via per-instance wobble attributes.

## Death sounds

Two distinct death sounds: `deathCrash()` (soft sine droplet for
star collision) and `death()` (harsh sawtooth descent for
escaping into space).

## Replay

Records `{x, y, currentStar}` per render frame (max
`REPLAY_MAX` FIFO). Dynamic follow-camera with simplex zoom on
the DEAD screen. Trailing window caps the polyline. Music keeps
playing across runs.

## Start screen

Shows stored high score if available (visibility-based, no
layout shift). Best score loaded from `localStorage`.

## Tunables

Centralized in `SPAWN` for spawn probabilities. Other tunables
near the top of `gameplay.js`: `ZOOM`, `CAM_FOCUS_Y`,
`PHYSICS_HZ`, `MAX_FRAME_GAP_MS`, `MISS_GRAVITY_MULT`,
`DYING_FRAMES_MS`, `COMET_SCORE_RADIUS`, `COMET_BONUS`,
`FAST_STREAK_CAP`, `BH_VISUAL_SCALE`, `EJECTA_MAX`,
`EJECTA_GM_MULT`.
