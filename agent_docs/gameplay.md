# Gameplay mechanics

## Camera

- `ZOOM` — world scale. Touch devices get a wider view.
- `CAM_FOCUS_Y` — vertical fraction where the current star sits.
  Higher = lower on screen. Touch uses a lower position.
- Camera follows upward star progression via `camY`.

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
`difficulty = min(n / 60, 1)`. `SAFE_SEP` floor prevents
Voronoi overlap.

## Replay

Records `{x, y, currentStar}` per render frame (max
`REPLAY_MAX` FIFO). Dynamic follow-camera with simplex zoom on
the DEAD screen. Trailing window caps the polyline. Music keeps
playing across runs.

## Tunables

All in `gameplay.js` near the top: `ZOOM`, `CAM_FOCUS_Y`,
`PHYSICS_HZ`, `MAX_FRAME_GAP_MS`, `MISS_GRAVITY_MULT`,
`DYING_FRAMES_MS`, `PLANET_MAX_PROB`, `PLANET_RAMP_STARS`,
`COMET_SCORE_RADIUS`, `COMET_BONUS`, `FAST_STREAK_CAP`.
