# ASTROCATCH

A browser-based one-tap orbital mechanics game.

```
docs/
  index.html         # tiny shell — DOM + CSS + one <script type="module">
  gameplay.js        # browser-only ES module: state, input, orchestration
  renderer.js        # browser-only ES module: WebGL2 renderer + shaders
  audio.js           # browser-only ES module: procedural WebAudio SFX + music
  physics.js         # pure physics ES module — used by browser and node
scripts/
  physics-test.js    # node test runner — imports ../docs/physics.js
  check-distances.js # standalone diagnostic for addNextStar's distance curve
  serve.js           # dependency-free static server, serves docs/
agent_docs/          # detailed architecture docs (rendering, audio, physics, gameplay)
package.json         # `"type": "module"` + `start` and `test` scripts
README.md            # public-facing
CLAUDE.md            # this file
```

Everything the browser needs is under `docs/`. GitHub Pages-ready
via `/docs` folder. All non-browser tooling lives under `scripts/`.

## Conventions

- **No build step.** No bundlers, transpilers, or runtime deps.
  Browser loads `gameplay.js` via `<script type="module">`.
- **No shader loader.** All GLSL lives as template strings in
  `renderer.js`.
- **ES modules only.** `package.json` sets `"type": "module"`.
- **2-space indentation** in `.js`, `.html`, `<style>`.
- **No AI-isms in user-facing text.** Keep prose direct and
  concrete.
- **Mind GC pressure and wasted work on hot paths.** `renderTick`,
  `physicsTick`, `draw`, `computeLaunchWindow`, and the music
  scheduler all run at high rates — prefer pooled scratch objects
  over per-call allocations, pass out-parameters instead of
  returning fresh objects, skip work when there's nothing to do
  (invisible hint, unchanged state, culled region), and guard
  the biggest loops with tighter iteration bounds (e.g. start
  at `currentStarIdx` when past stars can't affect the result).
- **Shader-clock precision.** Any `u_time`-style uniform that
  grows with wall-clock time is uploaded as a 32-bit float. After
  hours of play the argument of `sin(u_time * k)` loses enough
  mantissa to produce visible banding ("precision rings") on
  stars. Both `gameplay.js` and `debug.js` wrap their clock at
  `TIME_WRAP = Math.PI * 2 * 10000` (~62832 s ≈ 17.4 h). The
  value is lossless **only while every shader `k` multiplier is
  a rational with ≤ 2 fractional decimals** — so `W * k` is an
  integer multiple of `2π` and `sin` is bit-identical across the
  wrap. Same rule applies to any derived seed fed into the
  shader (e.g. binary `tidalSeed`). When adding a new `u_time`-
  based animation, keep `k` to 2 decimals (0.25, 0.12, 2.5…) or
  bump `TIME_WRAP` accordingly.

## Run locally

```sh
npm start          # → http://localhost:8001/
```

`physics.js` is the only file the node test runner uses.
`gameplay.js`, `renderer.js`, and `audio.js` are browser-only.
Any change to `physics.js` MUST be re-verified with `npm test`.

## Architecture (summary)

- **Physics** (`physics.js`): nearest-star gravity, velocity-Verlet
  with adaptive sub-stepping at 120 Hz. Planets perturb weakly;
  comets follow analytical Kepler orbits with no physics coupling.
  Binary stars use COM gravity with per-sub-star crash detection.
  → [Details](agent_docs/physics.md)

- **Rendering** (`renderer.js`): WebGL2, 5 shader programs
  (fullscreen / lensing / circle / star / polyline). Stars, black
  holes, raymarched 3D monolith slabs, and tumbling ringworld habitats rendered procedurally
  per pixel. Black holes use a conditional full-screen FBO +
  lensing composite pass with procedural grid for visible
  distortion. Star shader supports crash wobble and tidal locking
  for binaries. Background includes procedural spiral galaxies.
  No Canvas2D, no libraries.
  → [Details](agent_docs/rendering.md)

- **Audio** (`audio.js`): procedural WebAudio. SFX through a soft
  compressor, generative music (5 layers, simplex-driven lead)
  direct to destination. 8-chord harmonic pool with 6
  intensity-tiered progressions (2 per tier, alternated).
  Streak-driven tempo ramp.
  → [Details](agent_docs/audio.md)

- **Gameplay** (`gameplay.js`): state machine, input, scoring
  (quick-launch bonus + streak multiplier + comet bonus).
  `SPAWN_TABLE` of interpolated variant weights (plain/binary/
  bh/bhBinary/monolith/ringworld) by star index; planets and comets are
  orthogonal rolls on top. Binary stars (two sub-stars orbiting
  COM, tidally locked). Monoliths play as normal stars but
  render as rotating 3D slabs. Ringworlds are normal-physics
  stars with a tumbling earth-textured band; each carries a
  `ringPlateCount` (0–7) that adds rotating shadow plates, sun
  shadows, and warm city lights on the night sides. Camera
  auto-zooms 1.5× while the ship is captured. Save/resume
  roundtrips preserve `ringPlateCount`. BH binaries get physics-driven ejecta from
  donor to accretor. Crash wobble. Pause, arrow-key velocity
  nudge, launch-window indicator. Help overlay. Replay with
  dynamic follow-cam. Focus-click suppression.
  → [Details](agent_docs/gameplay.md)

## User preferences

- Verify physics fixes by running `npm test`, not by trusting
  analytical arguments.
- No crashes from a clean capture, ever. Bad-direction taps can
  fail, but any tap that produces a valid capture prediction must
  land on a stable orbit.
