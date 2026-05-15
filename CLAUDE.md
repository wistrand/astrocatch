# ASTROCATCH

A browser-based one-tap orbital mechanics game.

```
docs/
  index.html         # tiny shell — DOM + CSS + one <script type="module">
  gameplay.js        # browser-only ES module: state, input, orchestration
  renderer.js        # browser-only ES module: WebGL2 renderer + shaders
  renderer-2d.js     # browser-only ES module: Canvas2D "vector" fallback renderer
  audio.js           # browser-only ES module: procedural WebAudio SFX + music
  physics.js         # pure physics ES module — used by browser and node
  star-rendering.js  # browser-only — binary positions, ejecta, comets
  challenge.js       # browser-only — QR encoder + challenge-link payload + APNG encoder
  run-title.js       # pure ES module — procedural run-title composer (lexicon + statHash)
  debug.html / .js   # variant inspector — one of every star type in a grid
  variants.html / .js  # variant inspector grid (?type=&seed=&grid=NxM)
scripts/
  physics-test.js    # node test runner — imports ../docs/physics.js
  check-distances.js # standalone diagnostic for addNextStar's distance curve
  check-variant-distribution.js  # verifies seeded RNG matches Math.random per spawn-table
  check-titles.js    # sweeps run-title composer across canonical + random stat profiles
  serve.js           # dependency-free static server, serves docs/
agent_docs/          # detailed architecture docs (rendering, audio, physics, gameplay)
package.json         # `"type": "module"` + `start` and `test` scripts
README.md            # public-facing
CLAUDE.md            # this file
```

Everything the browser needs is under `docs/`. GitHub Pages-ready via `/docs` folder.
All non-browser tooling lives under `scripts/`.

## Conventions

- **No build step.** No bundlers, transpilers, or runtime deps. Browser loads `gameplay.js` via
  `<script type="module">`.
- **No shader loader.** All GLSL lives as template strings in `renderer.js`. **Never use backticks
  inside GLSL comments** — the surrounding `const FOO = \`...\`` template literal is delimited by
  backticks, so any backtick inside (even in a `// comment`) terminates the string and breaks JS
  parsing. This recurs constantly when writing inline-quoted identifiers in shader comments. Use
  single-quotes, double-quotes, or no quotes at all (`// the foo variable` rather than
  `` // the `foo` variable ``).
- **ES modules only.** `package.json` sets `"type": "module"`.
- **2-space indentation** in `.js`, `.html`, `<style>`.
- **100-char line width** in `.js`, `.html`, `.md`. Soft limit — break naturally at clause
  boundaries, don't fight readability for the cap.
- **No AI-isms in user-facing text.** Keep prose direct and concrete.
- **Mind GC pressure and wasted work on hot paths.** `renderTick`, `physicsTick`, `draw`,
  `computeLaunchWindow`, and the music scheduler all run at high rates — prefer pooled scratch
  objects over per-call allocations, pass out-parameters instead of returning fresh objects, skip
  work when there's nothing to do (invisible hint, unchanged state, culled region), and guard the
  biggest loops with tighter iteration bounds (e.g. start at `currentStarIdx` when past stars
  can't affect the result).
- **Shader-clock precision.** Any `u_time`-style uniform that grows with wall-clock time is
  uploaded as a 32-bit float. After hours of play the argument of `sin(u_time * k)` loses enough
  mantissa to produce visible banding ("precision rings") on stars. Both `gameplay.js` and
  `debug.js` wrap their clock at `TIME_WRAP = Math.PI * 2 * 10000` (~62832 s ≈ 17.4 h). The value
  is lossless **only while every shader `k` multiplier is a rational with ≤ 2 fractional
  decimals** — so `W * k` is an integer multiple of `2π` and `sin` is bit-identical across the
  wrap. Same rule applies to any derived seed fed into the shader (e.g. binary `tidalSeed`). When
  adding a new `u_time`-based animation, keep `k` to 2 decimals (0.25, 0.12, 2.5…) or bump
  `TIME_WRAP` accordingly.

## Run locally

```sh
npm start          # → http://localhost:8001/
```

`physics.js` is the only file the node test runner uses. `gameplay.js`, `renderer.js`, and
`audio.js` are browser-only. Any change to `physics.js` MUST be re-verified with `npm test`.

## Architecture (summary)

- **Physics** (`physics.js`): nearest-star gravity, velocity-Verlet with adaptive sub-stepping at
  120 Hz. Planets perturb weakly; comets follow analytical Kepler orbits with no physics coupling.
  Binary stars use COM gravity with per-sub-star crash detection.
  → [Details](agent_docs/physics.md)

- **Rendering** (`renderer.js`): WebGL2, 6 shader programs rendering stars, black holes
  (FBO + lensing composite), raymarched 3D monoliths, tumbling ringworld habitats, pulsars
  (lighthouse beams + lens flare), and volumetric nebulae plus procedural background spiral
  galaxies. Star + nebula share one shader source compiled twice with `#define NEBULA_ONLY` to
  keep mobile GPUs out of the heavy register tier when no nebulas are visible. Star shader
  supports crash wobble and binary tidal locking. A couple of rare endgame surprise variants are
  kept under their own names in agent_docs. No libraries.
  → [Details](agent_docs/rendering.md)

- **Vector renderer** (`renderer-2d.js`): Canvas2D fall-back renderer with the same interface as
  `renderer.js`. Phosphor-CRT aesthetic — thin bright outlines, `composite="lighter"` accumulation,
  per-frame semi-transparent black overpaint for soft afterglow. Polygons use a 2-stroke approach
  (continuous outline + batched per-vertex dot fill) so a 12-gon costs 2 composite ops instead of
  12, with corner brightening preserved via dot overlap. Selected by `?vector=1`, the in-game V
  key, the help-overlay pill, or automatic fall-back when `createRenderer()` returns null (no
  WebGL2). On touch, DPR is clamped to 1.5 in vector mode — the fuzz hides the resolution drop.
  → [Details](agent_docs/rendering.md#vector-renderer)

- **Audio** (`audio.js`): procedural WebAudio. SFX through a soft compressor, generative music
  (5 layers, simplex-driven lead) direct to destination. 8-chord harmonic pool with 6
  intensity-tiered progressions (2 per tier, alternated). Special-case progression overrides
  exist for one rare variant; see `agent_docs/audio.md`. Streak-driven tempo ramp.
  → [Details](agent_docs/audio.md)

- **Gameplay** (`gameplay.js`): state machine, input, scoring (quick-launch bonus + streak
  multiplier + comet bonus). `SPAWN_TABLE` interpolates variant weights (plain / binary / bh /
  bhBinary / monolith / ringworld / pulsar / nebula plus two rare endgame surprises) by star
  index; planets and comets are orthogonal rolls on top. Save/resume roundtrips preserve every
  variant flag. Render-position uses forward extrapolation from post-tick state — interpolation
  between consecutive states freezes on K=0 frames at high refresh rates. In-transit taps queue
  an immediate-on-capture Blazing boost. Cinematic camera mode (`Z`) cycles near/far
  ship-following zooms via a 1st-order follow integrator that shrugs off RAF jitter. Pause,
  arrow-key velocity nudge, launch-window indicator (24-step grid, time-sliced rebuild), help
  overlay, replay with dynamic follow-cam, optional FPS counter via `?fps=1`.
  → [Details](agent_docs/gameplay.md)

- **Challenge links** (`challenge.js`): on death, encodes per-run stats + run seed + 1-bit
  launch-window flag + 5-bit checksum into a lowercase base32 URL fragment (28 chars, format
  v2). Rendered as an APNG-animated QR (v3, EC M, 32-frame ray-traced sun logo with rotating
  light) on the death-screen flip card. Decoder uppercases, takes the leading `[A-Z2-7]+` run
  (so a copy-paste with trailing descriptive text still resolves), strict 17-byte length,
  checksum-verified — random edits don't fake a higher score. After a polluted decode succeeds,
  `recomputeIncomingChallenge` `replaceState`s the address bar back to a clean `#code`. The
  copy-link button emits a multi-line share blob (URL line + `ASTROCATCH challenge · <title> ·
  beat <score>`) via a JS property on the button (`_shareText`, not `dataset`, so the embedded
  `\n` isn't whitespace-normalised). The `launch_window` bit forces hint-
  indicator parity between sender and recipient; init() reads it and overrides
  `showLaunchWindow` for the challenge run. Incoming `#code` URLs surface a welcome card with
  sender stats; `hashchange` listener re-runs decode for same-tab navigations; invalid hashes
  show a small amber "invalid challenge link" indicator (textContent only, XSS-safe). While a
  challenge is active, RESUME is hidden, the HUD sub-line gains `· target N`, the inline
  death-stats line gets `· target N ✓/✗ ×` (dismiss button strips hash + reloads), and a
  one-shot "challenge beaten" flash fires the first frame score crosses target. Save schema
  carries `seed` so resumed runs generate valid (recipient-reproducible) challenge URLs.
  → [Details](agent_docs/gameplay.md#challenge-links)

- **Run titles** (`run-title.js`): pure ES module — composes a short noun phrase ("the burning
  twins", "the patient void, charted") from a run's stats. 8 style families (burning / swift /
  patient / rhythmic / greedy / long / epic / spare) × 6 adjectives each, 6 common-variant
  noun pools × 4 nouns each, rare-variant override (azazel / teapot map to opaque nouns —
  omen / apparition / rumor / specter — to avoid spoiling them in shareable titles), failed-
  run vocabulary for 0-star runs, optional "guided" suffix when the player used the launch-
  window hint. Word selection within each pool uses a non-crypto stat-hash that folds in every
  encoded field (score, stars, streak, b/q/s, comets, deathCause, variants, launchWindow,
  seed) — same `(stats, seed)` always maps to the same title, so sender and recipient see
  identical labels on the challenge card. Surfaces in `#run-title` (gameover) and
  `#challenge-title` (welcome card). Verified by `scripts/check-titles.js`.
  → [Details](agent_docs/gameplay.md#run-titles)

## User preferences

- Verify physics fixes by running `npm test`, not by trusting analytical arguments.
- No crashes from a clean capture, ever. Bad-direction taps can fail, but any tap that produces
  a valid capture prediction must land on a stable orbit.
