# ASTROCATCH

A browser-based one-tap orbital mechanics game.

```
docs/
  index.html         # tiny shell — DOM + CSS + one <script type="module">
  gameplay.js        # browser-only ES module: state, input, orchestration
  renderer.js        # browser-only ES module: WebGL2 renderer + shaders
  audio.js           # browser-only ES module: procedural WebAudio SFX
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
  via `<script type="module">`; `gameplay.js` imports `renderer.js`
  and `physics.js` by relative path. Node runs `physics-test.js`
  directly. The only "tooling" is the local static server
  (`serve.js`), which has zero dependencies. Don't add webpack,
  vite, esbuild, rollup, TypeScript, JSX, postcss, sass, etc.
  Every file in the repo is either runnable as-is or it's data.
- **No shader loader.** All GLSL lives as template strings inside
  `renderer.js`. Don't pull shaders from separate files or fetch
  them over the network.
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
`gameplay.js`, `renderer.js`, and `audio.js` are all browser-only:
renderer.js calls `canvas.getContext("webgl2")` at module load,
audio.js uses `window.AudioContext`, and gameplay.js drives DOM
overlays and input — none of which node provides. Edits to
rendering, input, audio, or UI do not need to be re-tested in
node. Any change to `physics.js` MUST be re-verified by running
`npm test`.

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

## Rendering

All pixel work lives in `renderer.js`. It owns the WebGL2 context,
all shader programs, dynamic vertex buffers, and the draw API
consumed by `gameplay.js`. `gameplay.js draw()` is pure
orchestration: it advances per-entity state and hands the
renderer typed batches of instances.

Four shader programs cover the entire render surface:

- **`fullscreen`** — background radial gradient + scrolling grid.
  One fullscreen quad synthesized in the vertex shader from
  `gl_VertexID`, no vertex buffer required.
- **`circle`** — instanced quad per entity. The `kind` per-instance
  attribute picks between solid disc, ring, glow, and dashed ring.
  Covers the ball glow and core, particles, shockwaves, the
  `isNext` dashed hint ring, and the parallax `bgStars` (which
  opt into per-instance `depth` and `twinkle`).
- **`star`** — instanced quad per active star. The fragment shader
  evaluates corona, streamers, outer glow, photosphere with limb
  darkening, granulation, and core highlight procedurally per
  pixel, all driven by `u_time` so the whole layered look stays
  animated. Past stars (dim embers) are a short-circuit inside
  the same shader. Per-instance flags encode `isCurrent`,
  `isNext`, `isPast`.
- **`polyline`** — dynamic line strip extruded to a triangle strip
  in the vertex shader. Used for the trail, the connector hints
  to upcoming stars, the velocity arrow shaft, and the replay
  ghost path. Alpha fades head-to-tail via two uniform color
  stops, no per-vertex color attribute needed.

Per-frame CPU work is ~10 draw calls. Alpha is always premultiplied,
the blend mode is `gl.ONE, gl.ONE_MINUS_SRC_ALPHA`, and `gameplay.js`
never touches `globalAlpha` or any Canvas2D state.

**No libraries.** Shaders live as template strings inside
`renderer.js`. If you need a new primitive, add another kind to
`circle`, extend the `star` fragment shader, or add a fifth program.
Don't reach for three.js / pixi / regl / twgl.

**Lost context.** `renderer.js` registers `webglcontextlost` /
`webglcontextrestored` handlers. On loss we `preventDefault` so
the browser will try to restore; on restore we reload the page
(rebuilding every program and buffer mid-frame isn't worth the
code).

**Unsupported devices.** If `canvas.getContext("webgl2")` returns
`null`, `gameplay.js` unhides `#unsupported` and aborts further
init. There's no Canvas2D fallback.

## Audio

`audio.js` owns all sound. Every effect is synthesized at play
time from `OscillatorNode` + `BiquadFilterNode` + `GainNode` —
no sample files, no network load, no libraries. The aesthetic
is "space melodic": consonant intervals, sine/triangle timbres,
filtered movement, short arpeggios rather than beeps.

Three sound events:

- `audio.boost()` — happy ascending launch. Two sine voices
  sweeping UP a perfect fifth (A5 → E6 upper, A4 → E5 lower),
  through an open lowpass closing from 3200 → 1400 Hz. The
  pitch reaches the destination note slightly before the
  envelope tails so the ear locks onto the fifth rather than
  the slide. ~230 ms total. Rising perfect fifth is the
  opening interval of "Twinkle Twinkle" / the Star Wars
  fanfare — universally upbeat. Plays from `boost()`.
- `audio.capture(bonus, streak)` — arpeggio chime through the
  A-major triad. Regular captures play root + fifth; Quick adds
  the third; Blazing plays the full root-third-fifth-octave
  arpeggio one octave higher. Per-note bell timbre is a sine
  fundamental + a slightly inharmonic 2.01× overtone. `streak ≥ 2`
  adds a rising high shimmer after the arpeggio whose pitch
  climbs with the streak count, so a long chain audibly sparkles
  more than a plain Quick→Quick. Plays from `captureStar()`.
- `audio.death()` — falling three-note A-minor descent (A3 →
  F3 → D3) through a closing lowpass, with each note drifting
  down a further fifth inside its envelope. ~650 ms total.
  Sad but not jarring. Plays from `die()`.

**Autoplay policy**: the AudioContext is created lazily on the
first `play*` call, which always happens inside a user gesture
(pointer tap, keyboard, START button click). Chrome allows
earlier creation but Safari refuses outside a gesture — the
lazy path works on both. The master gain starts at `MASTER_VOLUME`
(0.32) unless `localStorage.astrocatch_muted === "1"`, in which
case it starts at 0.

**Mute**: two controls, both driving the same state:
- **HUD button** (`#mute-btn` in `index.html`) — top-right
  corner, inline-SVG speaker icon with `.icon-on` / `.icon-off`
  children. `gameplay.js`'s `syncMuteBtn()` adds/removes the
  `.muted` class on the button element to swap which SVG path
  is visible. Clickable on every screen; lives outside any
  `.overlay` and re-enables `pointer-events: auto` explicitly
  because the HUD default is `none`.
- **M key** — keyboard shortcut that calls the same
  `audio.setMuted(!audio.isMuted())` + `syncMuteBtn()` pair.

Both persist to `localStorage.astrocatch_muted` inside
`audio.setMuted`. Master gain ramps via `setTargetAtTime` so
toggling mid-sound doesn't click.

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

- **`ZOOM = 0.65`** (desktop) / **`ZOOM = 0.58`** (touch) — world is
  drawn at this scale around the camera focus, so ~3 stars ahead of
  the ball fit on screen on desktop. Touch devices get a slightly
  wider view because physical phone screens are smaller; detection
  is via `matchMedia("(pointer: coarse)")` at module load, not a
  user-agent sniff. `ZOOM` is a `const` set once — plugging in a
  mouse mid-session won't recompute it.
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

## Quick-launch bonus + fast-launch streak

Tracked via `ball.framesInOrbit` (incremented in `physicsTick`, reset
on capture). At boost time `currentOrbitPeriod()` computes the live
orbit's period via Kepler's third law (`T = 2π·√(a³/GM)` with
`a = −GM/(2E)`, returning `Infinity` for unbound orbits) and the
player gets a per-capture **bonus** tier:

- `< 0.5` rotation → ×3 (BLAZING)
- `< 1.0` rotation → ×2 (QUICK)
- otherwise → ×1

The bonus is locked in on tap and applied in `captureStar()`. If the
trajectory dies before reaching capture, the bonus is discarded.

On top of the bonus, consecutive Quick/Blazing captures (bonus ≥ 2)
grow a **fast-launch streak**:

- `fastStreak` (module-level in `gameplay.js`) increments on each
  capture with bonus ≥ 2, capped at `FAST_STREAK_CAP = 7`.
- A capture with bonus == 1 (or death) resets `fastStreak` to 0.
- The applied multiplier comes from `streakMultiplier(fastStreak)`,
  which is a gentle half-step ramp: streak 1 → ×1, 2 → ×1.5,
  3 → ×2, 4 → ×2.5, 5 → ×3, 6 → ×3.5, 7 → ×4 (cap). The first
  fast capture of a run keeps the raw bonus (×1), so single
  Quick/Blazing captures earn exactly what they used to; the
  multiplier only kicks in on the second consecutive fast one.
- Score earned per capture is `Math.round(bonus * streakMultiplier)`
  so players always see integer ticks on the score display.

The bonus flash HUD shows ` · STREAK ×N` (where N is the applied
multiplier, e.g. `×2.5`) when `fastStreak ≥ 2`, and the persistent
sub-line under the score reads `· streak ×N` with the same
multiplier value while the streak is live. `fmtMult` in gameplay.js
formats half-step multipliers cleanly (`3` vs `2.5`).

## Replay

The game records `{x, y, currentStar}` once per render frame during
PLAY (capped at `REPLAY_MAX = 6000` samples, FIFO). When the death
wind-down ends, `computeReplayBounds()` finds the trajectory AABB
and the fit transform that maps it to screen space. `draw()`'s
`STATE.DEAD` branch calls `drawReplayGhost()`, which asks the
renderer for a `replayMat(scale, ox, oy)` world-to-clip matrix and
then issues:

- A `drawCircleBatch` of past-star markers — one glow halo + one
  solid core per visited star, each tinted with the star's palette
  color (`c1Of`). Not the star shader's `isPast` path — that's for
  live-play dead embers and is too dim for a trajectory landmark.
- A `drawPolyline` of the trajectory up to `replayIdx`, fading
  head-to-tail via the two color-stop uniforms.
- A second `drawCircleBatch` for the moving marker dot at the
  current replay position (white glow + white solid core).

`replayIdx += REPLAY_SPEED` advances per render frame and loops
with a brief hold at the end. The overlay opacity is dropped
specifically for `#gameover` so the replay shows through without
obscuring the AGAIN button.

## User preferences (project-specific)

- The user verifies physics fixes by running `npm test`, not by
  trusting analytical arguments. Always re-run the test after a
  physics change and report the actual numbers.
- The user wants no crashes from a clean capture, ever. Bad-direction
  taps can fail (that's the player's choice), but any tap that
  produces a valid capture prediction must land on a stable orbit.
