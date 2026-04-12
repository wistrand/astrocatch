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
  → [Details](agent_docs/physics.md)

- **Rendering** (`renderer.js`): WebGL2, 4 shader programs
  (fullscreen / circle / star / polyline). Stars rendered
  procedurally per pixel. No Canvas2D, no libraries.
  → [Details](agent_docs/rendering.md)

- **Audio** (`audio.js`): procedural WebAudio. SFX through a soft
  compressor, generative music (5 layers, simplex-driven lead)
  direct to destination. Intensity-tiered chord progressions
  driven by ship speed.
  → [Details](agent_docs/audio.md)

- **Gameplay** (`gameplay.js`): state machine, input, scoring
  (quick-launch bonus + streak multiplier + comet bonus), star
  generation with difficulty ramp, replay with dynamic follow-cam.
  → [Details](agent_docs/gameplay.md)

## User preferences

- Verify physics fixes by running `npm test`, not by trusting
  analytical arguments.
- No crashes from a clean capture, ever. Bad-direction taps can
  fail, but any tap that produces a valid capture prediction must
  land on a stable orbit.
