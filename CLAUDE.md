# ASTROCATCH

A browser-based one-tap orbital mechanics game.

```
docs/
  index.html         # tiny shell — DOM + CSS + one <script type="module">
  gameplay.js        # browser-only ES module: canvas, drawing, input, gameplay
  physics.js         # pure physics ES module — used by browser and node
scripts/
  physics-test.js    # node test runner — imports ../docs/physics.js
  check-distances.js # standalone diagnostic for addNextStar's distance curve
  serve.js           # dependency-free static server, serves docs/
package.json         # `"type": "module"` + `start` and `test` scripts
README.md            # public-facing
CLAUDE.md            # this file
```

Everything the browser needs is under `docs/`. That layout is also
GitHub Pages-ready: pointing Pages at the `/docs` folder of the
default branch publishes the game with no extra config. All
non-browser tooling (test runner, diagnostics, dev server) lives
under `scripts/` and imports physics from `../docs/physics.js`.
`scripts/serve.js` anchors its root via `import.meta.url`, so it
works whether you run it from the repo root, from `scripts/`, or
from any other working directory.

## Conventions

- **No build step.** No bundlers, no transpilers, no `npm install`
  for runtime dependencies. The browser loads `gameplay.js` directly
  via `<script type="module">`. Node runs `physics-test.js` directly.
  The only "tooling" is the local static server (`serve.js`), which
  has zero dependencies. Don't add webpack, vite, esbuild, rollup,
  TypeScript, JSX, postcss, sass, etc. Every file in the repo is
  either runnable as-is or it's data.
- **ES modules only.** All `.js` files use `import` / `export`. No
  CommonJS (`require` / `module.exports`). `package.json` sets
  `"type": "module"` so node treats `.js` as ESM. New files follow
  the same pattern.
- **2-space indentation** in `.js`, `.html`, and the `<style>` block.
  No tabs. No 4-space.
- **No AI-isms in user-facing text** (README, CLAUDE.md, intro
  screen, button labels, comments visible to a human reader).
  Avoid: *delve*, *leverage*, *harness*, *seamless*, *robust*,
  *comprehensive*, *in essence*, *at the heart of*, *tapestry*,
  *vibrant*, *intricate*, *showcase*, *underpin*, *facilitate*,
  *moreover*, *furthermore*, *in summary*, *let me explain*,
  *worth noting*, *in conclusion*, *the realm of*, marketing
  hand-waves like *"does the rest"* / *"under the hood"* /
  *"behind the scenes"*. Keep prose direct, concrete, unhedged.

## Run locally

ES modules cannot be loaded from `file://` in most browsers, so
local development needs an HTTP server:

```sh
npm start          # → http://localhost:8001/
```

`serve.js` is a ~50-line static file server using only Node's
built-in modules. It serves the project root, sets the right
`application/javascript` MIME type for `<script type="module">`,
and disables caching so a refresh always picks up the latest
gameplay/physics changes.

`physics.js` is the only file the node test runner uses.
`gameplay.js` is browser-only. Edits to gameplay rendering or
input do not need to be re-tested in node. Any change to
`physics.js` MUST be re-verified by running `npm test`.

## Running tests

```sh
npm test           # runs node physics-test.js
```

Sweeps 64 boost angles across 8 star configurations and reports
captures, escapes, and crashes. Use this to verify any physics
change before claiming correctness — visual playtesting in the
browser misses statistical regressions. The runner also dumps a
verbose trace of one known scenario, useful for debugging eccentric
orbit edge cases.

## Architecture

`physics.js` is an ES module. `gameplay.js` and `physics-test.js`
import it as `AC` (ASTROCATCH); the rest of the file refers to the
namespace as `AC.X`:

- **`physicsStep(stars, ball)`** — one velocity-Verlet frame under
  nearest-star gravity, with adaptive sub-stepping
  (`sub = 4 / 2 / 1` based on closest star).
- **`burnStep(stars, ball)`** — detects the actual periapsis (running
  minimum of `d(t)`), rewinds to the snapshot at that minimum, and
  clamps `|v|` into `[v_circ, v_max]` where `v_max` is the velocity
  that produces an orbit with apoapsis exactly at
  `PERI_VORONOI_FRAC × distance-to-nearest-neighbor`. Direction is
  never rotated.
- **`predictCapture(stars, currentStarIdx, x, y, vx, vy)`** —
  forward-simulates the same integrator (sub-stepping included),
  tracks the trajectory's periapsis around `next = stars[currentStarIdx + 1]`,
  returns `{periFrame, periDist, vMagAtPeri}` or `null`.
- **`applyBoostAndArm(stars, ball)`** — searches `BOOST_SEARCH_STEPS`
  boost factors and commits the smallest one that produces a valid
  prediction (Hohmann-style minimum-energy transfer). On failure
  applies a default fallback boost so the player still pays for a
  bad-direction tap.

`gameplay.js` keeps wrappers `physicsStep()` and `boost()` that call
`AC.physicsStep` / `AC.applyBoostAndArm` and handle scoring and
visuals.

Both modules share `stars` and `ball` by reference. The live game and
the test runner manipulate the same object shapes.

## Physics model (non-obvious bits)

- **Nearest-star gravity, not multi-body.** The dominant body switches
  automatically when the ball crosses the Voronoi midline between two
  stars. This is what the user explicitly asked for ("I know this is
  not true gravity, but let it be so"). Don't switch to true
  superposition without checking.
- **`SAFE_SEP = 6`** in star generation guarantees neighbours are at
  least `6 × max(R_a, R_b)` apart, so no orbit captured under the
  rules can be stolen by a neighbour. The matching
  `PERI_VORONOI_FRAC = 0.45` constraint in `predictCapture` keeps
  `apo ≤ 0.45 × neighbour_distance`, well inside the star's Voronoi
  cell.
- **Capture is by periapsis detection**, not by capture-radius
  proximity. The burn rewinds to the exact periapsis snapshot before
  scaling `|v|`, so the resulting `e` is essentially zero (just
  integration noise). Don't reintroduce a capture-radius scoring
  trigger.
- **`BOOST_DEFAULT = 0.85`** is the fallback Δv applied when
  prediction rejects every boost factor in the search range. The user
  wants bad-direction taps to commit and usually fail
  (off-screen / crash), not silently no-op.

## Gameplay tunables

All in `gameplay.js` near the top, after the SF constant imports.

- **`ZOOM = 0.65`** — world is drawn at 65% scale around the camera
  focus, so ~3 stars ahead of the ball fit on screen.
- **`PHYSICS_HZ = 120`** — fixed-timestep physics rate. Decoupled
  from `requestAnimationFrame` so a 144 Hz monitor doesn't run the
  game at 240 ticks/sec, and an RAF burst right after page load
  can't sneak in extra physics work. Driven by the time accumulator
  in `loop()`. **Do not** add per-render-frame physics multipliers
  (the old `GAME_SPEED` constant); use the accumulator.
- **`MAX_FRAME_GAP_MS = 100`** — clamps the per-loop time delta so a
  long pause (tab switch, init, debugger break) cannot queue up a
  burst of physics ticks and warp the game forward on resume.
- **`MISS_GRAVITY_MULT = 5`** — perpendicular distance from a star to
  the ball's velocity ray, used by `willHitAnyStar()`'s linear miss
  check. Only applies to **unbound** (escape) trajectories: closed
  orbits are caught by the bound-energy fast path
  (`E = v²/2 − GM/r < 0` against nearest star). So this can be tight
  without producing false deaths in eccentric orbits.
- **`DYING_FRAMES_MS = 1000`** — wind-down between the death event
  and the game-over screen. During DYING, physics keeps running but
  collisions are gated (the ball freezes if it touches a star surface
  so it doesn't bounce through the photosphere).

`addNextStar` uses `difficulty = min(n / 60, 1)` to ramp the
inter-star distance from `[320, 400]` early to `[560, 680]` late,
plus widening the cone half-spread from 45° to ~85° and shrinking
`r_max` from 58 to 38. The base values are deliberately set high
enough that the radius-driven `hardMin` floor never overrides them.
There's a standalone diagnostic for this:

```sh
node check-distances.js
```

## Quick-launch bonus

Tracked via `ball.framesInOrbit` (incremented in `physicsTick`, reset
on capture). At boost time `currentOrbitPeriod()` computes the live
orbit's period via Kepler's third law (`T = 2π·√(a³/GM)` with
`a = −GM/(2E)`, returning `Infinity` for unbound orbits) and the
player gets:

- `< 0.5` rotation → ×3 points (BLAZING)
- `< 1.0` rotation → ×2 points (QUICK)
- otherwise → ×1

The bonus is locked in on tap and applied in `captureStar()`. If the
trajectory dies before reaching capture, the bonus is discarded.

## Replay

The game records `{x, y, currentStar}` once per render frame during
PLAY (capped at `REPLAY_MAX = 6000` samples, FIFO). When the death
wind-down ends, `computeReplayBounds()` finds the trajectory AABB and
the camera transform that fits it on screen. `drawReplay()` paints a
faded ghost playback behind the game-over overlay, advancing
`replayIdx += REPLAY_SPEED` per render frame and looping. The overlay
opacity is dropped specifically for `#gameover` so the replay shows
through without obscuring the AGAIN button.

## User preferences (project-specific)

- The user verifies physics fixes by running `npm test`, not by
  trusting analytical arguments. Always re-run the test after a
  physics change and report the actual numbers.
- The user wants no crashes from a clean capture, ever. Bad-direction
  taps can fail (that's the player's choice), but any tap that
  produces a valid capture prediction must land on a stable orbit.
