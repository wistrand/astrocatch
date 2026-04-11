# WebGL2 rewrite plan

Rewrite the ASTROCATCH canvas renderer from Canvas2D to native WebGL2, no
libraries, preserving the full current visual look including animated stars
and twinkling background. Lock out devices without WebGL2 with a clear
"unsupported" message. `physics.js` is untouched; `npm test` keeps passing.

## Decisions locked in

- **WebGL2**, not WebGL1. Drop devices without it (iOS < 15, Android Chrome
  < 56, very old Firefox). Covers ~95% of live traffic.
- **No libraries.** No pixi, no regl, no twgl, no three.js. Raw GL calls.
- **New module**: `docs/renderer.js`, peer of `physics.js` and `gameplay.js`.
  No build step — pure ES module, shaders as template strings inside it.
  Browser-only, same as `gameplay.js`.
- **Reproduce the full current look.** Animated coronas, granules, streamers,
  pulse, flare, twinkling background dots, stroked trail, glow on ball, the
  lot. Nothing simplified.
- **Keep `physics.js` pure.** Renderer has zero physics dependencies. Node
  test runner does not import `renderer.js` and does not need a WebGL shim.

## Scope

### Replaced
- `draw()` function body in `gameplay.js`
- `drawStar`
- `buildStarSprite` + per-star `sprite` field
- `drawReplay`
- All Canvas2D state management (`fillStyle`, `strokeStyle`, `globalAlpha`,
  `setLineDash`, `save`/`restore`, transform chain)
- Manual alpha-baking into hex strings, manual polyline rewriting, sprite
  caching — all removed, the GPU does this natively now.

### Stays
- `physics.js` — every line.
- `gameplay.js`: physics tick, input handling, state machine, scoring,
  `camY` / `camTargetY`, replay sample recording, accumulator loop,
  interpolation (`ballRenderX/Y`), pull-to-refresh, tap handlers,
  orbit-period calculation, high score, `init()` / `die()` / `captureStar()`
  flow.
- `docs/index.html`: DOM, HUD overlays, CSS, start / gameover screens,
  `touch-action` rules.
- Project layout (`docs/`, `scripts/`).
- `package.json` scripts. No new dependencies.

### Canvas element
The existing `<canvas id="c">` is reused. We change the context acquisition
from `canvas.getContext("2d")` to `canvas.getContext("webgl2", { antialias:
true, premultipliedAlpha: true, preserveDrawingBuffer: false })`. Context
creation failure triggers an unsupported-device error overlay and aborts
`gameplay.js` initialization.

## Shader inventory — 4 programs

### 1. `fullscreen`
One fullscreen quad. Fragment shader computes:
- Background radial gradient (from #12121f center to #0a0a12 edges).
- Faint grid (mod-based, scroll-aware via `uniform vec2 uCamOffset`).
- Optionally the 220 bgStars dots with twinkle. If not done here, the
  `circle` program draws them instead. **Decision pass 1**: include bgStars
  in `fullscreen` as a procedural hash-grid noise field, animated via
  `uniform float uTime`. This removes 220 per-dot vertex attributes entirely
  and gives free twinkle.

Uniforms: `uViewport (vec2)`, `uCamOffset (vec2)`, `uTime (float)`.

### 2. `circle`
Instanced unit quad. Per-instance attributes:
- `aCenter (vec2)`
- `aRadius (vec2)` — `(outerR, innerR)`; `innerR = 0` means solid disc,
  `innerR > 0` means ring
- `aColor (vec4)` — premultiplied rgba
- `aKind (float)` — enum: 0 = solid, 1 = ring, 2 = radial glow, 3 = dashed
  ring (for `isNext` hint)

Covers: **ball core, ball glow, particles, shockwave rings, `isNext` dashed
hint ring**. One draw call per entity class (or one mega-draw if kinds are
encoded).

### 3. `star` — the big one
Instanced quad per active or menu star. Per-instance attributes:
- `aCenter (vec2)`
- `aRadius (float)` — base `s.r`
- `aC1 (vec3)`, `aC2 (vec3)` — hot / cool palette colors
- `aSeed (float)` — per-star hash-phase, precomputed from `(x, y)`
- `aHasRays (float)` — 0 or 1
- `aNGran (float)` — granule count 5..8
- `aIsCurrent (float)`, `aIsNext (float)`, `aIsPast (float)` — role flags

Fragment shader per-pixel, evaluated in the star's local space:
1. Compute `uv = (fragCoord - aCenter)`, `d = length(uv)`, `theta =
   atan(uv.y, uv.x)`.
2. **Corona**: `a = exp(-pow(d / (aRadius * 4.6), 2)) * 0.18`, tinted with
   `aC1`.
3. **Streamers** (if `aHasRays`): polar pattern
   `pow(cos((theta + seed) * aNGran) * 0.5 + 0.5, 8.0)`, modulated by
   `exp(-(d - aRadius) / aRadius * 0.6)` and a `uTime`-driven flicker.
4. **Glow**: second exponential, tighter radius `aRadius * 2.1`, brighter,
   alpha boosted when `aIsCurrent = 1`.
5. **Photosphere disk**: `smoothstep(aRadius, aRadius - 1.0, d)` with limb
   darkening — `mix(white, aC1, d/aRadius)` in the inner 78%, `aC2` at the
   edge.
6. **Granulation**: sample a 2D hash (`fract(sin(dot(uv * 13.7 + seed,
   vec2(127.1, 311.7))) * 43758.5453)`) clipped to `d < aRadius`, animated
   by `uTime` to recreate the current moving blobs.
7. **Core highlight**: offset hot spot `0.1 * aRadius` top-left,
   `smoothstep`-ed, brightness modulated by `flare = 0.8 + 0.2 * sin(uTime
   * 3.2 + seed)`.
8. **Past stars**: `aIsPast = 1` replaces the full output with a dim ember
   (small inner glow + tiny white dot).

Per-vertex phase derivation reproduces the current `position-derived phase`
behavior — every star looks out-of-sync with its neighbours.

Uniforms: `uTime (float)`, `uView (mat3)` — 2D world-to-clip transform.

This is ~150 lines of GLSL. Most of the project's new complexity lives here.

### 4. `polyline`
Vertex buffer = line strip. Extruded to triangle strip in the vertex shader
by reading neighbor vertices via `gl_VertexID` and a dedicated neighbor
attribute, then offsetting along the perpendicular.

Per-stroke uniform: `uWidth`, `uColor`, `uAlphaHead`, `uAlphaTail` — the
shader linearly interpolates alpha along the strip so the trail fades at
the tail procedurally instead of via per-vertex color.

Covers: **trail, connector hint lines, velocity arrow shaft, replay ghost
path, `isNext` dashed ring (if not handled in `circle`)**.

Antialiasing: use `smoothstep` on `abs(perpCoord)` near the edge in the
fragment shader to get a soft line edge without relying on MSAA (which
varies in quality on mobile).

## Per-frame CPU work

```
render(state)
  beginFrame(W, H, DPR)
    gl.viewport(0, 0, W*DPR, H*DPR)
    gl.clear(COLOR_BIT)

  uploadDynamicBuffers()
    trail vertices → STREAM_DRAW (~100 vec2)
    particle instances → STREAM_DRAW (~50 entries)
    shockwave instances → STREAM_DRAW (few)
    star instances → STREAM_DRAW (5..8, or dynamic UBO)

  drawFullscreen()          # bg gradient + grid + bgStars, 1 call
  drawPolylines()           # trail + connectors + velocity arrow, 2-3 calls
  drawStars()               # instanced, 1 call for all active stars
  drawCircles()             # particles + shockwaves + isNext ring + ball, 2-4 calls
```

~8 draw calls per frame. Draw-call count is not the perf dimension that
matters here; fragment budget is, and we have plenty of it.

## Risks

1. **Star shader iteration.** Reproducing the current sprite look
   procedurally is taste-driven. First pass will look close but not
   pixel-identical. Budget two or three tuning rounds after the shader
   compiles and runs.
2. **Lost context.** WebGL contexts get torn down when the tab backgrounds
   on iOS. Must handle `webglcontextlost` (preventDefault, stop RAF,
   release dynamic buffer references) and `webglcontextrestored`
   (recompile programs, reupload static buffers, resume RAF). ~40 lines
   including a forced-test path via `WEBGL_lose_context` for dev.
3. **Silent shader failures.** A bad uniform name or type mismatch in
   WebGL is a no-op. Mitigation: a `compileProgram(vsSrc, fsSrc, name)`
   helper that calls `getShaderInfoLog` / `getProgramInfoLog` and throws
   with the name on failure, plus a dev-only `gl.getError()` assertion
   after each draw.
4. **Shader compile stall on first load.** Compiling 4 programs takes
   30-100ms on low-end mobile. One blank frame at startup. Acceptable.
5. **Line antialiasing.** Canvas2D gave free smooth strokes; WebGL does
   not. Fragment-shader SDF smoothing in the `polyline` program handles it
   but needs careful width computation in screen space, not world space,
   so thin lines don't alias under world zoom.
6. **DPR interaction.** The world transform now lives in a `uView` matrix
   uniform. Must be recomputed in `resize()` along with `gl.viewport`.
7. **Replay fit transform.** Current `drawReplay` computes a bounds-fit
   transform on death. Port that math into a uniform block on the DEAD
   state path — no new logic, just moving from `ctx.translate`/`ctx.scale`
   to a matrix.

## Phases

Each phase leaves the game playable and testable. No phase deletes
functionality until the replacement is verified working.

### Phase 0 — Scaffolding
**Goal**: establish `renderer.js`, acquire a WebGL2 context, verify hello
triangle.

Steps:
1. Add `docs/renderer.js`. Export `createRenderer(canvas)` that:
   - Acquires a WebGL2 context. On failure returns `null` (gameplay.js
     shows a "WebGL2 required" overlay and aborts `init`).
   - Registers `webglcontextlost` / `webglcontextrestored` handlers.
   - Exports a `beginFrame(W, H, DPR)` and `endFrame()` stub.
2. Write a small `compileProgram(vsSrc, fsSrc, name)` helper with info-log
   checking.
3. Write a small 2D matrix helper: `mat3identity`, `mat3translate`,
   `mat3scale`, `mat3multiply`, `mat3toUniform` (column-major layout).
4. Import `createRenderer` from `gameplay.js`. Call it at module load.
   Canvas2D rendering still runs — renderer is unused.
5. Add a trivial hello-triangle draw test behind a `?gltest` query param to
   verify the plumbing.

**Done when**: `?gltest` draws a single colored triangle on top of the
Canvas2D game, no lost-context errors on backgrounding.

### Phase 1 — Background, grid, bgStars
**Goal**: `fullscreen` program owns the background layer.

Steps:
1. Write the `fullscreen` vertex shader (trivial: two-triangle fullscreen
   quad using `gl_VertexID`, no attributes needed in WebGL2).
2. Write the `fullscreen` fragment shader: radial gradient, grid,
   procedural bgStars hash-field with twinkle driven by `uTime`.
3. Add `renderer.drawBackground(camY, time)`.
4. In `gameplay.js draw()`, delete the Canvas2D bg gradient + grid +
   bgStars loops. Call `renderer.beginFrame` → `renderer.drawBackground` →
   fall through to the remaining Canvas2D drawing for this phase. Layer
   ordering is preserved because WebGL and Canvas2D share the same canvas
   element — we can't currently mix, so for this phase the bg block is
   drawn via renderer and then **the Canvas2D layer is drawn over it**,
   which does not work (you can't use both contexts on one canvas).

   **Correction**: WebGL and Canvas2D cannot coexist on the same canvas.
   Two options:
   - **A**: stack two canvases (WebGL behind, Canvas2D in front) during
     the migration. Ugly but makes the phased approach genuinely
     incremental.
   - **B**: do the migration in one big commit — stand up the full
     renderer in a branch, flip `gameplay.js draw()` wholesale.
   
   **Pick A.** Add a `<canvas id="c2">` sibling during migration, mark
   `#c` as the WebGL canvas and `#c2` as the Canvas2D overlay, drop `#c2`
   at the end of Phase 5. This keeps each phase testable.

5. Drop `bgStars[]` state from `gameplay.js`. The shader owns the
   starfield; no JS-side representation is needed. `initBgStars` is
   deleted.

**Done when**: starting the game shows the WebGL-rendered background under
the Canvas2D gameplay layer, with twinkling bgStars visible on menu and
during play. Resize keeps working. Pull-to-refresh keeps working.

### Phase 2 — Polylines
**Goal**: `polyline` program owns the trail, connector hints, velocity
arrow shaft, and DEAD-state replay path.

Steps:
1. Write the `polyline` vertex + fragment shaders. Vertex shader extrudes
   via neighbor reads; fragment applies per-pixel SDF smoothing for the
   edge.
2. Add `renderer.drawPolyline(points, color, widthPx, alphaHead,
   alphaTail)`.
3. In `gameplay.js draw()`, swap:
   - trail drawing → renderer call
   - connector hint lines → renderer call
   - velocity arrow shaft → renderer call
4. Delete the Canvas2D trail / connector / velocity-shaft code from
   `draw()`. Trail data representation stays in `gameplay.js` unchanged.
5. Replay path (`drawReplay` body) also moves to a `drawPolyline` call
   with the fit transform fed in as a uniform. `computeReplayBounds` stays
   as-is.

**Done when**: trail, connectors, velocity shaft, and replay ghost all
render through WebGL. Tail fade works (uniform-driven, not per-vertex).
Lines look clean at all zoom levels.

### Phase 3 — Circles
**Goal**: `circle` program owns the ball, particles, shockwaves, and
`isNext` hint ring.

Steps:
1. Write `circle` shaders (unit quad instanced, fragment tests
   `length(uv)`).
2. Add `renderer.drawCircles(instances)` accepting a typed array of
   `(cx, cy, rOuter, rInner, r, g, b, a, kind)` per instance.
3. Migrate ball (core + glow), particles, shockwaves, `isNext` hint ring.
4. Delete the Canvas2D ball rendering block, particles loop, shockwaves
   loop, and the `isNext` dashed arc from the star loop.
5. The velocity arrowhead (the 3-vertex triangle) can either fold into
   `polyline` or stay as a tiny dedicated draw — pick `polyline` with a
   "closed" flag if convenient, otherwise a tiny `drawTriangle` helper.

**Done when**: ball, particles, shockwaves, and hint ring all render
through WebGL. Catch-capture visual burst is intact. Particles shrink and
disappear as before. Shockwaves expand and fade.

### Phase 4 — Stars (the big one)
**Goal**: `star` program owns all active stars (gameplay and menu),
fully animated, reproducing the current sprite look.

Steps:
1. Write the `star` fragment shader layer by layer, in this order:
   (a) photosphere disk, (b) outer glow, (c) corona, (d) core highlight,
   (e) granulation, (f) streamers, (g) past-star ember override. Test
   each layer in isolation by compiling with the later layers commented
   out. Visual-parity check against the current Canvas2D rendering after
   every layer — screenshot side-by-side on desktop.
2. Add `renderer.drawStars(instances, time, camTransform)` where
   instances is a typed array of per-star attributes.
3. Build instance data from `stars[]` in `gameplay.js draw()` — filter to
   the same on-screen range (`sY < -240 || sY > H + 240` cull) and set
   `aIsCurrent` / `aIsNext` / `aIsPast` flags per star.
4. Menu stars use the same `drawStars` call with a zero camera transform.
5. Delete `drawStar`, `buildStarSprite`, `s.sprite`, and the star loop in
   `draw()`. Delete `makeStar`'s sprite build and the cached sprite field.
6. Delete the shockwave `s.pulse` scale-transform blit path — it's no
   longer needed because the star shader can read `s.pulse` as a per-
   instance attribute and scale procedurally.

**Done when**: all stars render through WebGL, animated, matching the
current look within tuning tolerance. Catch pulse, flare, granulation,
streamers, corona all visible. Past stars correctly reduced to embers.

This is the longest phase. Budget the most time here; expect two or three
tuning rounds.

### Phase 5 — Cleanup
**Goal**: delete the Canvas2D overlay, all Canvas2D render code, and all
the compatibility shims we added in earlier phases.

Steps:
1. Remove the `#c2` overlay canvas from `index.html`. WebGL canvas `#c` is
   the only one.
2. Remove `const ctx = canvas.getContext("2d")` from `gameplay.js`.
3. Verify `gameplay.js` has **zero references** to `ctx.*`. Any
   leftovers are dead helpers — delete them.
4. Delete the old alpha-baking-into-hex compatibility code in particle /
   shockwave push sites — they can go back to clean `#rrggbb` colors
   because the renderer handles alpha as an attribute.
5. Delete the manual polyline-in-one-stroke logic, the per-star sprite
   cache, and every comment block referring to canvas2D state hazards.
6. Run `npm test` — `physics.js` is untouched, should pass as before.
7. Manual playtest on: desktop Chrome, desktop Firefox, iOS Safari,
   Android Chrome. Verify menu / play / death / replay / restart all work.
   (User is the one running these, not Claude.)

**Done when**: `gameplay.js` imports `renderer.js`, owns zero Canvas2D
code, and the game runs smoothly on a modern phone.

### Phase 6 — Polish (optional)
Only if wanted after Phase 5 ships.

- Bloom post-process on the active star / ball.
- Chromatic aberration on high-speed ball.
- Starfield depth parallax with multiple layers.
- Capture-flash full-screen ripple.

None of this is required for the rewrite to be called "done".

## CLAUDE.md updates (at end of Phase 5)

The project CLAUDE.md currently describes Canvas2D rendering. After the
rewrite, it needs:
- New `renderer.js` file listed in the directory tree.
- "No build step" rule extended to mention "no shader loader, shaders live
  as template strings in `renderer.js`".
- The "Physics model (non-obvious bits)" section is unchanged.
- The "Gameplay tunables" section is unchanged (all physics/gameplay
  tunables stay in `gameplay.js`; renderer tunables live in `renderer.js`).
- Add a short "Rendering" section describing the four shader programs
  and their role.
- Remove the CLAUDE.md references to `drawStar` / sprite cache / alpha
  baking — those are gone.

## Files touched

Created:
- `docs/renderer.js` (~600–1000 lines including GLSL)

Modified:
- `docs/gameplay.js` (render layer replaced; physics/state/input untouched)
- `docs/index.html` (temporary `#c2` overlay canvas during Phases 1–4, then
  removed in Phase 5)
- `CLAUDE.md` (updated in Phase 5)

Untouched:
- `docs/physics.js`
- `scripts/physics-test.js`
- `scripts/check-distances.js`
- `scripts/serve.js`
- `package.json`
- `README.md`

## Exit criteria

- Game playable on a current-generation iPhone and Android phone at
  stable frame rate, no jank in orbit, no stutter on capture.
- Visual parity with the current look: animated stars, twinkling bg,
  smooth trail, ball glow, catch shockwave, gameover replay ghost.
- `npm test` passes (unchanged — tests physics only).
- No libraries added. No build step added. `package.json` has the same
  scripts.
- "WebGL2 required" error message shown gracefully on unsupported
  devices instead of a broken game.
- `gameplay.js` contains no Canvas2D API calls.
