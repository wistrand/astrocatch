# Physics model

`physics.js` is a pure ES module, no DOM. Used by both browser
and the node test runner.

## Gravity

Nearest-star only, not multi-body. The dominant body switches at
the Voronoi midline. Velocity-Verlet integration with adaptive
sub-stepping (sub = 4/2/1 based on distance to nearest star).
Fixed timestep at `PHYSICS_HZ`, decoupled from RAF.

## Capture

By periapsis detection, not hitbox proximity. `burnStep` tracks
the running minimum of `d(t)`, rewinds to the periapsis snapshot,
and clamps `|v|` into `[v_circ, v_max]`. Direction preserved.
`predictCapture` forward-simulates with the same integrator so
prediction matches live physics bit-for-bit.

## Planets

Probability ramps from 0% to `SPAWN.PLANET_MAX_PROB` over
`SPAWN.PLANET_RAMP_STARS` captures (not assigned to binary
stars). Stars that pass get 1–2 planets. Planets orbit at
constant angular velocity, carry a small fraction of the
parent's GM, and perturb the ship via `accelFromStarWithPlanets`.
Plummer softening (`softR2`) prevents divergence on direct hits.
No collision. Planet positions are a pure function of
`ball.frame`, shared between live physics and prediction.
Past-star planets are stripped in `captureStar`.

## Comets

Controlled by `SPAWN.COMET_PROB` and `SPAWN.COMET_MIN_STAR`.
Analytical Kepler orbits (`solveKepler` + `cometPosition`), no
numerical integration. Highly eccentric; direction chosen by
scanning 8 directions for the biggest gap, apoapsis capped by
clearance fraction, minimum apo:peri ratio required. Comets do
NOT affect ship gravity. Close-pass within `COMET_SCORE_RADIUS`
awards `COMET_BONUS` points with sparkle burst and removal.
Multi-syndyne tail, distance-dependent coma glow, and solar-
wind-pushed wake particles near periapsis. Past-star comets
stripped alongside planets.

## Binary stars

Binary stars have `isBinary: true` and a `binary` object with
sub-star data. Physics treats the COM as a single point mass
(same GM, same gravity model). Crash detection in both
`predictCapture` and `checkCollisions` checks against both
sub-star positions (computed from `ball.frame` and the binary's
orbital parameters, same pattern as planets). No planets on
binaries; comets allowed.

## Black holes

Black holes are stars with `isBlackHole: true`. Physics is
identical to normal stars — same GM, same collision radius, same
capture mechanics. The only difference is visual (rendering +
lensing, handled in `renderer.js` and `gameplay.js draw()`).
`BH_VISUAL_SCALE` makes the event horizon appear smaller than
the physics radius. Black holes can be the accretor in a binary
pair — same physics, with ejecta particles (visual only, no
ship interaction) handled in `gameplay.js`.

## Key invariants

- `SAFE_SEP` guarantees minimum star separation.
- `PERI_VORONOI_FRAC` keeps captured orbits inside the star's
  Voronoi cell.
- `BOOST_DEFAULT` — bad-direction taps commit and usually fail,
  not silently no-op.
- No crashes from a clean capture, ever.
