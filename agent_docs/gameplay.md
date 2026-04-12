# Gameplay mechanics

## Camera

- `ZOOM` — world scale. Touch devices get a wider view.
- `CAM_FOCUS_Y` — vertical fraction where the current star sits.
  Higher = lower on screen. Touch uses a lower position.
- Camera follows upward star progression via `camY`.

## Input

- **Focus-click suppression**: clicks within 150 ms of a
  `window.focus` event are ignored, preventing accidental boosts
  when clicking to bring the browser window forward from behind
  another window. Tracked via `lastWindowFocusTime`.

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

## Star generation

`addNextStar` ramps difficulty over the first ~60 captures:
inter-star distance, cone spread, and radius all scale with
`difficulty = min(n / 60, 1)`. On landscape screens, the cone
spread widens proportionally to the aspect ratio (`aspectBoost`)
so stars use the available horizontal space. `SAFE_SEP` floor
prevents Voronoi overlap.

## Black holes

Some stars are flagged `isBlackHole: true` (probability and
minimum star index controlled by constants in `makeStar`). Same
gameplay mechanics as normal stars (orbit, capture, boost) but
rendered differently (event horizon + accretion disk + lensing).
`BH_VISUAL_SCALE` makes the event horizon visually smaller than
the physics radius. Past black holes show as dim embers and lose
their lensing effect.

## Replay

Records `{x, y, currentStar}` per render frame (max
`REPLAY_MAX` FIFO). Dynamic follow-camera with simplex zoom on
the DEAD screen. Trailing window caps the polyline. Music keeps
playing across runs.

## Tunables

All in `gameplay.js` near the top: `ZOOM`, `CAM_FOCUS_Y`,
`PHYSICS_HZ`, `MAX_FRAME_GAP_MS`, `MISS_GRAVITY_MULT`,
`DYING_FRAMES_MS`, `PLANET_MAX_PROB`, `PLANET_RAMP_STARS`,
`COMET_SCORE_RADIUS`, `COMET_BONUS`, `FAST_STREAK_CAP`,
`BH_VISUAL_SCALE`.
