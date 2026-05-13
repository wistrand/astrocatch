# Gameplay mechanics

## Camera

- `ZOOM` — world scale. Touch devices get a wider view.
- `CAM_FOCUS_Y` — vertical fraction where the current star sits.
- Camera follows upward star progression via `camY`.

## Input

- **Click / Space** — boost (left-click / touch; right-click and middle-click ignored). A tap fired
  *during transit* (after a previous boost, before capture) queues the boost instead of applying it
  — see [Queued in-transit boost](#queued-in-transit-boost).
- **P** — pause / resume.
- **Arrow keys** — nudge orbital velocity ±2% while in orbit (unclamped — extreme nudging can crash
  or escape). Emits an exhaust puff as visual feedback.
- **M** — toggle mute.
- **W** or tap the score display — toggle the launch-window hint.
- **Z** or long-press (≥ 500 ms) the score display — cycle the cinematic camera mode. See [Cinematic
  mode](#cinematic-mode).
- **H** or click the **?** button — toggle the help overlay (pauses the game while open).
- **V** or click a renderer pill inside the help overlay — toggle between the WebGL2 and
  Canvas2D ("vector") renderer. Replaces the canvas DOM element (context type is sticky) and
  re-resizes. Refused if the device fell back at boot (no WebGL2 available); the WebGL pill
  renders disabled in that case.
- **Esc** — close help.
- **Focus-click suppression**: clicks within 150 ms of a `window.focus` event are ignored, so
  bringing the window forward from behind doesn't fire a boost.

## Pause

Game is paused by pressing **P**, tapping the **paused** indicator that appears in the HUD, or
opening the help overlay. All of these go through `syncPausedIndicator()` which also calls
`audio.setMusicPaused(paused)` to halt the music scheduler — timeline stays aligned across long
pauses. The **paused** text is only visible during `STATE.PLAY`; dying or dead runs clear it
automatically.

Paused state is cleared on `init()` (new game) and stored high score is persisted via `saveBest()`
on `pagehide`, `beforeunload`, and `visibilitychange → hidden` so a high score from an interrupted
run isn't lost.

## Scoring

### Quick-launch bonus

Tracked via `ball.framesInOrbit`. At boost time, orbit fraction determines bonus tier (Blazing /
Quick / regular). Locked in on tap, applied in `captureStar`.

### Fast-launch streak

Consecutive Quick/Blazing captures grow `fastStreak` (capped at `FAST_STREAK_CAP`). Multiplier ramps
via `streakMultiplier()`. Breaks on a slow capture or death. Score earned = `Math.round(bonus *
streakMultiplier)`.

### Comet bonus

Close pass within `COMET_SCORE_RADIUS` awards `COMET_BONUS` points, sparkle burst, twinkly sound,
comet removed.

## Queued in-transit boost

A tap during transit (`ball.pendingCapture >= 0`) sets `ball.queuedBoost = true` and emits a small
radial particle ring at the ship in the *target* star's primary colour as a confirmation cue — no
audio, no scoring, no exhaust. At the end of `captureStar()`, after the new orbit is established and
the launch window is recomputed, the flag is replayed by calling `boost()` from a clean state.
Because `framesInOrbit` is 0 at that moment, the quick-launch bonus auto-tiers to Blazing (×3).

The mechanic lets the player gamble: pre-tap during transit hoping the orbital position the ship
enters at capture will be a valid launch position toward the *next* star. If it is, the chain
proceeds with maximum bonus; if not, the boost commits a bad-direction burn and the ship usually
flies free.

Multiple in-transit taps each emit a fresh particle cue (so the player gets re-confirmation), but
the queue itself is idempotent — only one boost fires at capture.

## Spawn table

`SPAWN_TABLE` is a list of rows at star-index control points. Each row lists weights for each
variant (`plain`, `binary`, `bh`, `bhBinary`, `monolith`, `ringworld`, `pulsar`, `nebula`, `teapot`,
`azazel`). Weights interpolate linearly between rows and plateau past the last row. Normalized at
sample time, so values don't need to sum to 100.

Planets and comets are **orthogonal** rolls applied on top:

- **Planets**: ramp from 0 to `PLANET_PROB_MAX` over `PLANET_RAMP_STARS` captures. Allowed on
  `plain` and `bh` variants only; binaries, monoliths, ringworlds, pulsars, Nebulae, teapots, and
  Azazel skip (their visuals already occupy the orbit volume).
- **Comets**: flat `COMET_PROB` chance from `COMET_MIN_STAR`+. Allowed on any variant except
  monoliths (alien/alone vibe), teapots (the Russell gag reads cleanest with the teapot solo on
  screen), and Azazel (the demonic vibe reads cleanest solo). Pulsars and Nebulae are fine — debris
  disks around real pulsars and comets weaving through nebula filaments both read naturally.

Decision order in `makeStar`: variant → planets → comets. Swap `SPAWN_TABLE_GAME` for
`SPAWN_TABLE_DEBUG` to force-spawn a type for testing.

`addNextStar` pre-rolls the variant via `pickVariant(n)` so pulsars / Nebulae / teapots / Azazel can
claim a higher minimum spawn radius — pulsars and Nebulae get `r ≥ 30` (tiny core / fine shell
detail), teapots get `r ≥ 40` (rare Easter-egg variant that should read clearly when it appears —
bounding sphere is ~70 px and spout-tip thickness is ~2 px at the floor), Azazel gets `r ≥ 56` with
a 1.5× size multiplier (the demon's three face tiers and ~14 spikes need surface area to read).
Default is `r ≥ 18`. The pre-rolled variant is then passed to `makeStar(..., variant)` to avoid a
second roll producing a different result.

## Star generation

`addNextStar` ramps difficulty over the first ~60 captures: inter-star distance, cone spread, and
radius all scale with `difficulty = min(n / 60, 1)`. On landscape screens, the cone spread widens
proportionally to the aspect ratio so stars use the available horizontal space. `SAFE_SEP` floor
prevents Voronoi overlap.

## Binary stars

Two sub-stars orbiting their common center of mass. The star entry in `stars[]` sits at the COM with
combined GM; physics sees a single point mass. Sub-stars have independent visual radii, colors, and
crash zones that move with the orbit.

- **Mass ratio** `q` in `[0.2, 0.65]` — the companion is visibly smaller than the primary.
- **Tidal locking**: sub-star shader seeds track the orbital angle so visual features rotate exactly
  once per orbit.
- **Wider peri floor**: `predictCapture` uses `minPeriMult = 2.2` for binary targets (vs 1.5 for
  normal stars) so captured orbits clear the sub-stars' reach.
- **Crash detection**: both sub-stars checked in live physics, prediction, and DYING freeze.
- **Stripped on capture**: binary data cleared alongside planets and comets when leaving a star.

## Black holes

Flagged `isBlackHole: true`. Same physics as normal stars (gravity, collision, capture). Rendered
with event horizon, Interstellar-style accretion disk, and gravitational lensing via FBO composite
pass with a procedural background grid. The dashed hint ring is suppressed for BH targets since the
grid and disk already mark the zone. `BH_VISUAL_SCALE` makes the event horizon visibly smaller than
the physics radius.

**BH binaries** (`bhBinary` variant): the accretor sub-star is the black hole. The donor emits
physics-driven ejecta particles that arc from its surface and spiral into the BH under inflated
gravity + distance-dependent drag. Particles use the donor's color.

## Monoliths

Flagged `isMonolith: true`. Physics identical to normal stars (gravity, collision, capture).
Rendered as a raymarched 3D slab in 1:4:9 proportion (classic 2001), tumbling around a random
per-monolith axis derived from the star's seed. Near-black body with a cyan-blue fresnel rim at
silhouette edges.

Monoliths don't wobble on crash, don't get planets or comets, and can't be binary components (the
raymarched occlusion against moving sub-stars doesn't work cleanly in 2D). Hint ring and launch
window behave normally.

## Ringworlds

Flagged `isRingworld: true`. Physics identical to normal stars — the band is purely visual. Rendered
as a ray-cylinder- intersected habitat of radius `2.6 * s.r` and height `1.0 * s.r` wrapping a small
central sun, tumbling around a per-star axis (monolith-style Rodrigues rotation). Inside face is
earth-textured with clouds; outside face is dark structural. Camera-direction lighting + specular
hotspots + warm fresnel rim glow on the inside sell 3D curvature.

Ringworlds skip planets and comets and can't be binary components. While the ship's
`currentStar.isRingworld` is true, the gameplay camera smoothly eases to a 1.5× zoom (`zoomMult`
lerped at 0.05/frame) so the tumbling band stays legible; it eases back to 1.0× on the next capture.

Each ringworld also carries a random `ringPlateCount` in `[0, 7]`, set at spawn
(`Math.floor(Math.random() * 8)`). This value is packed into the star instance's flag bits and
drives the shader's shadow-plates / day-night / city-lights path:
- `0`: no plates, no shadows, no city lights (~1 in 8 rings).
- `1–7`: N orbiting shadow plates projecting rotating dark sectors onto the inside face; warm city
  lights appear on land in the deep-night zones.

The ringworld resume/continue orbit radius is `3.2 × r` so the ship clears the band (at `2.6 × r`).

## Pulsars

Flagged `isPulsar: true`. Physics identical to a normal star (gravity, collision, capture). Rendered
as a tiny dense neutron- star body with two opposed lighthouse beams sweeping a slowly- drifting
magnetic axis; alignment with the camera produces a brief lens-flare burst (diffraction spikes,
anamorphic streak, iris ring with crescent cut, halo bloom). Body colour and pulse character take
from the per-star `colorIdx` palette so different pulsars read visually distinct.

Pulsars skip planets (the body is too small to support a visible planetary system) but allow comets
— debris disks around real pulsars are documented (PSR B1257+12 was the first exoplanet host). They
can't be binary components (the lens- flare composite assumes a single source).

Pulsars use a higher minimum spawn radius (`r ≥ 30`) so the small body and large lens-flare quad
both render at usable detail — at default `r = 18` the visible core is only ~6 px and gets lost.
Beam cones reach `3.5 × v_baseR` at peak edge-on alignment; the renderer uses an enlarged 5.0× quad
for pulsars specifically (vs 4.3× for all other variants).

## Nebulae

Flagged `isNebula: true`. Physics identical to a normal star. Rendered as a volumetrically
integrated 5-shell nebula sampling multiple per-nebula categorical and continuous parameter axes
from the star's seed:

- **Palette class** (4 buckets): Crab synchrotron, OIII Helix, hot blue NGC 7027, dust-reddened.
  Each ships its own shell colours, weights, glow tint, and pulsar character.
- **Morphology class** (8 buckets, 25 % filamentary): default ellipsoidal shells, or
  quadratic-Bezier tube filament (cigar / bent / S-curve dust lane) for ~1 in 4 nebulae.
- **Central-source flavour** (3 buckets): visible pinpoint / hidden source / off-centre pinpoint.
  Decoupled from interior fill so a hidden-source nebula can still have bright cavity gas
  (Helix-like) and a visible-pulsar nebula can have a sparse cavity (etched aesthetic).
- **Interior fill density** (3 weighted buckets): 50 % full body / 35 % moderate / 15 % etched.
  Etched mode boosts the edge fibre gain so the linework character is intentional.
- Plus continuous: bipolar amplitude, cavity size, density, fibre frequency / pow / floor / gain,
  stratification offset (radial crisp-to-soft gradient), lobe asymmetry (skewed squared distribution
  → most nebulae mild, ~10 % wildly lopsided outliers).

Nebulae skip planets (the gas envelope occupies the orbit volume), allow comets, and can't be binary
components. They use the same higher minimum spawn radius (`r ≥ 30`) as pulsars — the volumetric
integration's 5-shell network needs room to develop visible structure across `r3D ≈ 0.5` to `2.5 ×
v_baseR`.

While the ship's `currentStar.isNebula` is true, the gameplay camera eases to a 1.6× zoom (vs 1.7×
for ringworlds, 1.0× otherwise) so the nebula's internal structure stays legible. The `visualR`
extent for the screen-edge horizontal-camera- nudge logic is `r * 2.7` for nebulae (vs `r * 3.6` for
ringworlds, `r * 2.5` for everything else).

The `variants.html` inspector page (`?type=nebula&seed=N&grid=NxM`) renders a deterministic grid of
Nebulae for population review. URL-driven seed and grid size make populations reproducible across
reloads.

## Russell's teapots

Flagged `isTeapot: true`. Physics identical to a normal star (gravity, capture, scoring). Rendered
as a sphere-traced SDF porcelain teapot — body / lid / knob / Bezier-tube spout / elliptical-torus
handle, smin-blended into a single ceramic surface. Procedural cobalt-on-porcelain pattern (3D
value-noise FBM, no UV seam) with a clean foot and a half-cobalt collar band at the body-lid
junction. Glossy ceramic shading: three- light setup with a slowly-precessing key light, Phong
specular tinted by the per-instance star colour `v_c1` (so each teapot has a recognisable glaze
cast), power-3 fresnel rim.

Tumble axis is strongly +Y biased (`tAxis.y ≥ 0.96` after normalize) so the body stays roughly
vertical with at most ~16° tilt as the teapot rotates; lid stays clearly upward. Initial angle is
bimodally distributed near `0` or `π` so teapots spawn near profile (spout to either side), not
face-on.

The SDF coordinate frame puts the lid at +y. World coordinates in this codebase use +Y-down
(`screenMat` flips to clip space), so the rendering branch negates `loc.y` when entering the SDF
frame to keep "lid up" on screen.

**Russell reference.** Bertrand Russell's 1952 thought experiment posits a tiny porcelain teapot
orbiting the Sun between Earth and Mars, too small to be detected by any telescope. Used
philosophically to argue against unfalsifiable claims. The in-game teapot is, as the shadertoy
port's description puts it, *not that teapot* — but it's a deliberate Russellian wink.

**Spawn rate.** 0 % until star 50, then 1/89 ≈ 1.1 % at endgame. A typical run from star 0 won't see
one; deep runs reliably do. The Easter-egg payoff lands when the player's already invested.

**Higher minR (`r ≥ 40`).** Bigger than pulsar (30) and nebula (30) — teapots are a rare Easter-egg
moment, so when one shows up it should read clearly as a teapot, not as a "small object with
handles". At r=40 the bounding sphere is ~70 px and every detail (lid, spout tip, handle tube, china
pattern) is legible. The spout's 0.05 × r tip thickness is ~2 px at the floor.

**Camera zoom.** While the ship's `currentStar.isTeapot` is true, the camera eases to a 1.6× zoom
(matching the nebula multiplier). `visualR` for the screen-edge horizontal-camera- nudge logic is `r
* 1.7` (the SDF bounding sphere).

**Save/resume.** Round-trips `isTeapot` alongside the other variant flags. Captured teapots persist
through saves.

## Azazel

Flagged `isAzazel: true`. Physics identical to a normal star (gravity, capture, scoring). Rendered
as a 2D-SDF demon manifesting through a "rip in space" — tilted ellipse with edge noise + 14
angularly-spaced tapered spikes + 3 stacked face tiers (paired triangular eyes above a two-row
rhombus grin) inside a slowly breathing silhouette, all in pure procedural SDF (no raymarching). See
`agent_docs/rendering.md → Azazel` for shader detail.

**Spawn rate.** 0% until star 50, then ramps to ~2% by star 80 — rarer than pulsars and Nebulae,
comparable to teapots. Endgame variant; typical short runs won't see one.

**Higher minR (`r ≥ 56`) and 1.5× size multiplier.** Bigger than every other variant. Three face
tiers + 14 spikes need surface area; the demonic moment loses its weight if the rip is small.
Combined with the steep captured-zoom (see `zoomTargetFor`), the demon fills most of the central
viewport area — biggest of any variant.

**Camera zoom.** While the ship's `currentStar.isAzazel` is true, `zoomTargetFor` returns the
steepest `zoomMult` of any variant (touch is reduced from desktop because mobile screens make
extreme zoom feel excessive). Effective on-screen scale is `ZOOM · zoomMult`. `visualR` for the
horizontal-camera- nudge logic is `cs0.r * 2.4` (matches the quad's `extentMul`).

**Music override.** Capture flips `audio.setDemonMode(true)`, which swaps the active chord
progression to a Phrygian-mode bank (`[Am, Bb, Dm, E]` / `[Em, Bb, Dm, E]`) at the next 4-bar
section boundary. Reverts on leaving the orbit (or on death, init, continueRun, or resumeFromSave).
The progression switch is bar-aligned so the swap doesn't crunch mid-phrase. See
`agent_docs/audio.md → Demon-mode override`.

**Launch-window override.** While captured around an Azazel, the launch-window indicator is forced
visible regardless of the user toggle (W key / score-tap). The Azazel capture zoom is steep enough
that the next star typically sits off-screen, so without the indicator the player has no visual cue
for when to tap. Other orbits keep the toggle behaviour.

**Save/resume.** Round-trips `isAzazel` alongside the other variant flags. Captured demons persist
through saves; on restore, `setDemonMode(true)` is re-issued so the music resumes correctly.

## Cinematic mode

Toggled by `Z` (or long-press the score display on touch). Cycles through four levels: `0` (regular
gameplay camera), `1` (cinematic near), `2` (cinematic far), `3` (cinematic near again). Cycle is
palindromic — four consecutive presses return to normal:

```
0 → 1 → 2 → 1 → 0 → 1 → 2 → ...
```

Levels 1–3 use a `replayMat`-style ship-following camera applied to the live game. (Optional simplex
zoom breath is in the code but disabled — `CINEMATIC_ZOOM_AMP = 0` — because the oscillation read as
visible jaggedness on objects away from screen-center at high zoom.)

Implementation details:

- **Follow target.** Camera follows `ballRenderX/Y` (the per-render-frame interpolated ship
  position) — *not* `ball.x/y` (the raw physics state, which is stair-stepped at 120 Hz). Mismatch
  between those two creates visible motion jaggedness at high cinematic zooms.
- **Time-aware integrator.** Both the follow lerp and the cam- param lerp use the exact 1st-order
  solver `y_{n+1} = y_n · e + v · tau · (1 − e)` (where `y = target − cam` is the lag, `e = exp(−dt
  / tau)`, and `v` is the target velocity estimated from `(target − prevTarget) / dt`). Both `y_n`
  and `v` use the *previous-frame* target value so we don't mix start-of-interval cam state with
  end-of-interval target state (mixing the indices roughly doubles the steady-state lag). The exact
  form gives lag = `v · tau` independent of `dt`, so RAF jitter doesn't translate into ship/star
  screen-position jitter. `dt` is read from a module-level `renderFrameDt` updated each frame by the
  main loop.
- **Time constants.**
  - `CINEMATIC_FOLLOW_TAU_MS = 660` for the camera-follows-ship lerp (≈ the old fixed weight
    0.025/frame at 60 fps).
  - `CINEMATIC_LERP_TAU_MS = 270` for the cam-param transition lerp (≈ the old 0.06/frame at 60
    fps).
- **Both cams expressed in replayMat form.** Regular and cinematic camera targets are computed each
  frame as `(scale, ox, oy)` using the algebraic equivalence `ox = camX·z + W/2·(1−z)` (and same for
  `oy`). The rendered triple lerps toward whichever target the current level demands, so mode entry,
  level switching, and exit all glide through the same code path. `draw()` builds a single
  `replayMat` from the lerped params — no branch.
- **BH lensing.** The FBO disk radius reads the lerped scale (`drawZoom`) rather than base `ZOOM`,
  so the lens size matches the on-screen size in either mode and during transitions.
- **Off-screen death check** still uses world-frame `ZOOM` and `camY` — cinematic is purely a
  render-time visual.
- **Touch zooms** are lower than desktop (`1.0` / `1.4` vs `1.7` / `2.6`) because mobile screens
  make even moderate zoom feel excessive.

Long-press on the score display fires on the threshold (not on release) so the camera transition
starts immediately. The same pointer stroke can't double-fire as both tap-toggle-W and hold-cycle-Z
because the tap path checks `_scoreHoldFired` on `pointerup`.

## Crash wobble

When the ship crashes, the star gets a decaying elliptical deformation (`s.wobble`, `s.wobbleAngle`)
— squeezed flat on the impact side, relaxing over ~1.5 s. Driven through the star shader via
per-instance wobble attributes. Monoliths are excluded (rigid 3D body).

## Launch-window hint

Toggled by `W` or clicking the score display. When on, short white tangent ticks appear on a 10
%-inset ring of the ship's actual orbit at angles from which a tap would produce a clean capture.
Sampled at fixed star-frame angles (0°, 10°, … 350°) via a forward-simulation of the ship's current
trajectory, so ticks stay anchored in space as the ship orbits through them.

Three correctness / performance details:

- **Boost-factor grid covers narrow valid windows.** The indicator probes a 24-step linear grid
  (`LAUNCH_WINDOW_BOOST_STEPS`) from `BOOST_SEARCH_MIN` to `BOOST_SEARCH_MAX` — half the live
  `applyBoostAndArm` resolution. Coarser grids (the original 6 hand-picked factors) miss narrow
  valid windows and produce visible gaps where the game would actually succeed; finer is unnecessary
  because the indicator only needs to know *whether* a clean capture exists, not the smallest viable
  Δv. Break-on-first-success keeps the typical-case cost cheap.
- **Adaptive sub-stepping prevents slot skipping.** ω = L / r² spikes near perihelion on eccentric
  orbits; a fixed-dt forward step could sweep more than one slot's angular width and leave the
  skipped slots unfilled (each slot only records on first visit). Each outer step estimates ω from
  current state and splits into N substeps so each substep crosses at most ~half a slot. Capped at
  32 substeps to defend against r → 0 pathology.
- **Time-sliced builds with ping-pong buffers.** A full 36-slot build takes ~5–20 ms — well over a
  frame budget — and on perturbed orbits the throttled recompute fires every ~6 render frames, so
  each fire was visibly stuttering. The build is now split into:
  - `runLaunchWindowPhase1` (forward sim → samples, ~1–2 ms, runs synchronously when the build
    starts), and
  - `runLaunchWindowPhase2Slot` (one slot's predict-sweep — the dominant cost on failing slots).
`tickLaunchWindowBuild()` advances `LW_SLOTS_PER_FRAME` (6) slots per render frame. A full build
completes in ~6 frames with no single-frame spike. Two buffer pairs (`A`/`B`) ping-pong:
`ball.launchWindow` keeps pointing at the previously-completed front buffer while the back fills, so
there's no flicker. New triggers (capture, nudge, throttled fire) abort any in-progress build and
start fresh; builds also abort if `pendingCapture` rises or `currentStar` rotates so we don't commit
results computed against stale state. The projected window uses the same pattern with its own pair.

Recomputed on capture, on arrow-key nudge (orbit reshape), and every
`LAUNCH_WINDOW_RECOMPUTE_FRAMES` (12 physics frames ≈ 0.1 s) while the current star has planets or
is a binary — so slow perturbations keep the hint in sync without burning CPU. Static orbits don't
trigger re-recompute. The throttle gate also requires `_lwBuildSlot < 0` so builds don't pile up on
top of each other.

All per-recompute state is pooled: sample + result arrays are module-level scratch objects, and
`predictCapture` takes an optional `outResult` buffer so its success return doesn't allocate.
`predictCapture`'s crash-check loop starts at `currentStarIdx` (skips past stars), cutting late-game
cost roughly in half.

**Tutorial default**: the hint is auto-enabled at the start of the first `TUTORIAL_GAMES` (3)
gameplays, and auto-hides once the player captures `TUTORIAL_STARS` (15) stars in those runs. The
player can still toggle it off manually at any time. Gameplay count is persisted in `localStorage`
(`astrocatch_gameplays`).

**Azazel orbit override**: while the ship is captured around an Azazel star, the launch-window draws
regardless of the user toggle. The Azazel capture zoom is steep enough that the next star is
typically off-screen, so the indicator is the only available cue for when to tap. Toggle still works
on every other orbit. Gate is `currentStar.isAzazel`.

## Death sounds

- `deathCrash()` — soft sine droplet, played on star collision.
- `death()` — harsh sawtooth descent, played on escape into space.

## Replay

Records `{x, y, currentStar}` per render frame (max `REPLAY_MAX` FIFO). Dynamic follow-camera with
simplex zoom on the DEAD screen. Trailing window caps the polyline. Music keeps playing across runs.

## Challenge links

`challenge.js` is a self-contained module with three responsibilities: a minimal QR encoder, the
per-run challenge-link payload codec, and an inline APNG assembler for the death-screen
animated QR. Procedural run titles are composed by the separate `run-title.js` module — see
[Run titles](#run-titles) below.

### Payload format

Bit-packed into a single base32-encoded URL fragment. Format v2 (`CHALLENGE_FORMAT_VERSION = 2`):

```
4  bits   format version
1  bit    launch_window     (was has_seed in v1; seed is now always encoded)
20 bits   score              (0..1,048,575)
10 bits   starsVisited
4  bits   streakPeak
8  bits   blazingCount
8  bits   quickCount
8  bits   slowCount
6  bits   cometsCaught
4  bits   deathCause         (enum DEATH_CAUSES)
24 bits   variant census     (8 variants × 3 bits, fixed slot order)
32 bits   seed               (always present in v2)
5  bits   checksum (low 5 bits of CRC-16/CCITT-FALSE over the
                    byte-aligned payload pre-checksum)
```

129 payload bits + 5-bit checksum = 134 bits → byte-padded to **17 bytes** = base32 = **28 chars**
always. The checksum lives inside the byte-pad bits the original layout wasted, so it costs no
extra length. Adding a new variant means bumping format version because the slot indices shift.

**v1 → v2.** In v1 the `has_seed` bit guarded a conditional 32-bit seed encoding, but in practice
the encoder always passed a seed (the one place that wouldn't have was a "share without seed"
UI affordance that never shipped). The bit was dead. v2 locks the seed in unconditionally and
repurposes the freed bit for `launch_window` — true if the sender had the launch-window
indicator on. The recipient's `init()` reads this bit and forces `showLaunchWindow` to match
the sender's setting, so both players experience the same hint visibility. (Setting the
variable directly bypasses the toggle's localStorage write, so the player's personal default
survives the challenge run.) Azazel's forced-on indicator state is tracked separately via
`lwForced = csCur.isAzazel` in the renderer, so azazel orbits don't falsely flip the bit.

### Forgery deterrence

The checksum exists to defeat the trivial "edit the URL fragment to fake a higher score" attack. Two
layers:

1. **Strict byte-length equality.** Insertions/deletions always shift the base32 byte count →
   rejected before the checksum even runs. (An earlier `>=` check left a 1% leak via end-of-fragment
   insertions; `!==` closed it — see commit history.)
2. **5-bit checksum.** Random bit-flip survives at ~1/32. Not cryptographically authenticated —
   anyone reading `challenge.js` can compute valid checksums — but raises the pass-rate from ~100%
   to ~3%, enough to discourage casual hand-edits. Stronger authentication would need a server
   secret, which a static-page game can't keep.

### URL shape

- Fragment-routed: `https://astrocatch.live#<base32>`. Visible fragment is **lowercase** for
  tidiness; QR-render path uppercases the entire URL on the way into the encoder so the alphanumeric
  segments still pack at 5.5 bits/char. Decoder always `toUpperCase()`s on entry.
- Trailing-slash optimisation: `buildChallengeUrl()` strips the `/` when the page sits at the site
  root (production AND local dev, since browsers normalise empty path back to `/` on load). Saves
  one alphanumeric char in the QR. Sub-path deployments keep `/` so SPAs that distinguish `/foo`
  from `/foo/` aren't broken.
- Each rejected decode logs `[challenge] rejected: <reason>` at log level so a stale or tampered
  hash is visible in DevTools without firing as an error.

### QR + sun logo

`makeQrMatrix()` is a multi-segment QR encoder (alphanumeric + byte modes, EC L or M, version 1..10,
standard mask penalty selection). The death-screen card (`#challenge-out`, flip-card 3D reveal)
renders at v3 (29×29) with EC level M (~15% damage budget) so a centred logo overlay is
RS-recoverable.

`drawSunLogo(canvas, modulesPerSide, scale, quiet, phase, elevation)` paints a snap-to-grid
pixel-art sun with **ray-traced Blinn-Phong shading**:

- **Mask** (unchanged): every module whose centre lies inside `rMod = 4.5` from the QR centre.
  Radius isn't 5 because at 5 the cardinal-axis modules (centre±0.5, ±4.5) sit at distance 4.528
  (just inside) while the next column is at 5.025 (just outside), producing 2-module tabs
  detached from the diagonal silhouette. Pulling below 4.528 collapses them into a clean
  6-8-8-8-8-8-8-6 outline.
- **Per-module shading**: each filled module's centre is treated as a sample on a unit-radius
  sphere centred at the QR centre. The closed-form sphere normal `N = (nx, ny, sqrt(1-nx²-ny²))`
  drives Lambert diffuse (`max(0, N·L)`) and Blinn-Phong specular (`(N·H)^k`). The diffuse term
  indexes the white→amber gradient table — lit hemisphere approaches the core stop, shadow side
  parks at the warm amber rim. Specular lerps toward a saturated yellow target color (not pure
  white) so the highlight stays sun-coloured at peak rather than blowing out to plastic.
- **Light direction `L`** is parametric: `phase` = azimuth, `elevation` = angle out of screen
  plane (0 = equator, π/2 = pointing straight at viewer). Animated by `gameplay.js` —
  azimuth sweeps a full rotation while elevation drifts on a narrow sinusoid (`π/4 ± π/8`) so
  the highlight traces a smooth oval on the sphere without ever fully fronting the camera.

### Animated PNG bake (delta-encoded)

After rendering the canvas + live RAF (covers the ~700 ms encoding latency), `gameplay.js`
asynchronously builds an APNG via `encodeAnimatedQrPng(canvas, drawFrame, frameCount, fps,
deltaRect)`:

- 32 frames at 16 fps = 2 s seamless loop. Frame count chosen so per-frame highlight jump
  (~11.25° azimuth) reads as continuous motion rather than stop-motion.
- **Delta encoding**: the QR cells outside the sun's bounding box don't change between frames,
  so encoding the full 198×198 image every frame wastes ~80% of the file size on
  invariant pixels. The bake passes a `deltaRect` covering only the sun's pixel footprint
  (~60×60 px at v3 / scale 6); the encoder renders frame 0 onto the full canvas (used as the
  baseline) and frames 1+ onto a 60×60 offscreen canvas containing the sun + the bare QR cells
  in that bounding box. Per-frame `fcTL` carries the rect's `x/y/w/h` and `dispose=PREVIOUS`,
  so each delta lands at the sun position in the playback buffer and reverts before the next
  delta replaces it. File size drops ~5× (≈220 KB → ≈40 KB at 32 frames) with no quality
  change — the rest of the QR was never animating anyway.
- Caller's `drawFrame(i, total, target)` receives the appropriate canvas (`target = canvas`
  for frame 0, `target = deltaCanvas` for frames 1+). The encoder snapshots `target` via
  `canvas.toBlob("image/png")`, parses out IDAT chunks, and stitches them into a valid
  APNG by inserting `acTL` + per-frame `fcTL` + (for frames ≥ 1) converting `IDAT` → `fdAT`
  with sequence-number prefix. CRC32 over each PNG chunk; no external library.
- Once the bake completes, the live canvas is replaced in-DOM with `<img id="challenge-out-qr"
  src=blob:image/png>`. RAF stops; playback is native browser APNG decoding, zero JS cost. The
  blob is wrapped in `File(..., "astrocatch-challenge.png", { type: "image/png" })` so most
  browsers (not Firefox) suggest the filename on right-click "Save image as…".

### Incoming challenges

`gameplay.js` decodes `location.hash` once at module load AND on every `hashchange` event — so
editing the URL in the address bar of an already-loaded page (a same-tab soft navigation, not a full
reload) still surfaces the welcome card. The `#challenge` welcome card on the start screen shows the
sender's title, score, run summary, and variant census; closing it strips both the fragment and any
`?seed=` query so a fresh-random run can roll.

Invalid hashes (decode rejected — corrupted / tampered / stale) show a small amber `#challenge-
invalid` indicator: `invalid challenge link · #<12-char prefix>`. The hash snippet is rendered
via `textContent` only (never `innerHTML`) so a hostile `#<script>` or `#<img onerror=…>` stays
inert literal text. Length-truncated to keep the indicator one line tall.

`init()` reads `_incomingChallenge` at the moment the player clicks START, so any hash change before
that point picks up. Seed-source priority:

1. `#…` challenge code with embedded seed
2. `?seed=XYZ` legacy/explicit param
3. fresh-random per run

`init()` also reads `_incomingChallenge.launchWindow` and overrides `showLaunchWindow` for the
run — the recipient experiences the sender's hint setting regardless of either player's
localStorage default. Variable assignment bypasses the toggle's persist-to-localStorage path so
the recipient's preference is preserved for non-challenge runs. The recipient can still toggle
with W to deviate; doing so writes back to their own setting.

The RESUME button is hidden whenever an incoming challenge is active
(`updateResumeButtonVisibility()` checks `loadGame() && !_incomingChallenge`). Without this guard, a
player on a fresh challenge URL could click RESUME and `resumeFromSave()` would restore their prior
session's score — instantly clearing the sender's bar with no actual play. CONTINUE on the game-over
screen is unaffected because `continueRun()` already resets `score = 0`.

`updateSub()` appends `· target N` to the sub-line under the HUD score whenever `_incomingChallenge`
is set, so the sender's bar is visible alongside the player's running total throughout the run.

### Death-stats inline annotation

On gameover, the existing "X stars · best Y" line gets `· target N ✓/✗ ×` appended via a hidden
`#death-target` span — visible only when `_incomingChallenge` is set. The ✓/✗ mark colour-codes
the verdict (green / amber) and is set by `updateDeathTargetMark()` from `renderChallengeCard`
(at gameover time `score` is the player's final score, since no captures fire after the DYING
freeze). The trailing `×` is the same `dismissChallenge()` handler as the start-screen
`#challenge-close` — strips `#hash` + `?seed=` and reloads. Inline annotation chosen over a
duplicated card because the standalone mirror added ~150 px to the gameover overlay and
overflowed shorter mobile viewports.

### Once-per-run "challenge beaten" flash

`updateScoreUI()` checks `score > _incomingChallenge.score` on every score change; the first cross
flips a `challengeBeaten` flag and fires `showChallengeBeatFlash()` (gold lazy-created overlay
element at top:90px, ~1.5s hold so it reads as a once-per-run event rather than a per-capture beat).
The flag is reset by `resetRunStats()` based on the *current* score — fresh start / continueRun
(score=0) → false; resume from save where the saved score already cleared the challenge → true (so
the flash doesn't re-fire on the resumed frame).

## Run titles

`run-title.js` is a pure ES module that turns a run summary (or a decoded challenge code) into a
short noun phrase like `the burning twins` or `the patient void, charted`. Deterministic: given
the same stats and seed, returns the same title — so a challenge sender and recipient see the
same label baked into the shareable identity of the code. Pure data + no DOM, exportable, no
gameplay dependencies.

### Composition

The composed title is `the {adjective} {noun}` plus optional comma-suffix. Three axes drive the
choice:

1. **Style adjective** picked from the run's dominant style metric. 8 families × 6 words each:
   - `burning` (high blazing fraction) — burning, blazing, scorching, sun-struck, feverish,
     wildfire
   - `swift` (high quick fraction) — swift, darting, fleet, quick-handed, lithe, dashing
   - `patient` (high slow fraction) — patient, deliberate, steady, watchful, measured, biding
   - `rhythmic` (high streak peak) — rhythmic, drum-tight, locked-in, even, metered,
     sure-footed
   - `greedy` (high comet-per-star) — greedy, magpie, comet-eyed, gilded, hoarding,
     shimmer-eyed
   - `long` (≥30 stars) — long, deep, far-running, unbroken, enduring, sustained
   - `epic` (≥100 stars) — endless, deep-time, year-long, marathon, ageless, fathomless
   - `spare` (<5 stars) — quiet, still, spare, brief, bare, hushed

   The metrics are normalized to [0, 1] and the highest scoring family wins. Tiebreaker is
   insertion order via the stable sort — `burning`/`swift`/`patient` push first so they win
   ties against `rhythmic` when a run mixes both qualities. `epic` pushes before `long` so
   100+-star runs win the length-tier tie against `long` (both saturate at 1.0 for those
   runs). `STYLE_THRESHOLD = 0.3` — below that, the composer falls back to `long` or `spare`.

2. **Noun** picked by rare-encounter override → dominant-variant pool → generic fallback:
   - **Rare-variant override**: any run with `variants.azazel > 0` or `variants.teapot > 0`
     routes through `RARE_NOUN = ["omen", "apparition", "rumor", "specter"]` regardless of
     what else the player encountered. Two reasons: (a) signals "something special happened",
     (b) keeps the rare variant's *name* out of the title so a shareable URL doesn't spoil the
     surprise for anyone who hasn't seen them yet.
   - **Common-variant pool**: 6 pools × 4 words each. Dominance is weighted (`blackHole` ×1.1,
     `monolith` ×1.3, etc.) so visually-distinct variants outrank common ones at low counts.
     Pools: binary {twins, pair, duet, tandem}, blackHole {void, maw, well, horizon},
     monolith {slab, obelisk, pillar, stone}, ringworld {ring, band, halo, hoop}, pulsar
     {beacon, pulse, lantern, signal}, nebula {cloud, veil, shroud, mist}. Key names match
     `runStats.variants` (note: `blackHole`, not `bh`; BH binaries increment BOTH `blackHole`
     and `binary` rather than getting their own bucket, so they can't be named distinctly).
   - **Generic fallback** when every star was plain: `["drift", "passage", "crossing",
     "watch", "hunt", "voyage", "trek", "transit"]`.

3. **Optional suffix** appended for two reasons:
   - **Launch-window suffix** (`lw=true && stars >= 5`): tag from `GUIDED_SUFFIX = ["charted",
     "well-aimed", "sighted", "well-marked"]`. Frames using the hint as a craft choice — `the
     burning twins, charted` reads as a nautical / aerospace acknowledgement rather than a
     callout.

**0-star runs short-circuit** to a separate failure vocabulary: `FAILED_ADJ = ["abrupt",
"early", "luckless", "fleeting"]` × `FAILED_NOUN = ["fumble", "misfire", "stumble", "slip",
"miss", "blunder"]`. Avoids the gentle "spare" branch reading as "you chose to leave" when the
run actually flubbed before catching anything.

### Determinism: `statHash`

Word selection within each pool runs on a 32-bit hash of *every* encoded stat field — not just
seed. `statHash(stats)` folds in score, starsVisited, streakPeak, b/q/s, cometsCaught,
deathCause, launchWindow, variants, and seed via Knuth-multiplier + xor-shift rounds (Murmur-
style mixing, non-crypto). Different bit-slices of the same hash feed each pool's index
(`hash % adjList.length`, `hash >>> 11 % nounList.length`, `hash >>> 23 % GUIDED_SUFFIX.length`)
so the slices stay uncorrelated.

Without this, two runs sharing a seed but different outcomes (different score, streak, comet
count, …) would pick identical words inside their style/variant families — only the *family*
would vary by what the run was. Folding all the bits in makes the title also reflect the
gameplay detail. Sender / recipient agreement is preserved because all hash inputs are in the
challenge payload.

### Verification

`scripts/check-titles.js` sweeps `composeRunTitle` across canonical + randomised stat profiles
and prints each generated title with its inputs. Canonicals exercise:

- Edge cases: 0-star failure (across 4 seeds, to spread the FAILED pool), 1-2 star runs.
- Pure styles: all-blazing / all-quick / all-patient / balanced / comet-hunter / tight-streak.
- Variant landscapes: binary / BH / pulsar / nebula / ringworld+monolith dominance.
- Rare-variant cases: single azazel + commons, single teapot + commons (titles should use
  oblique RARE_NOUN, never name the rare variant).
- All-plain runs at varying lengths to confirm the long → epic transition fires past 100
  stars when length is the standout (high streak / dominant capture style still beats epic
  on ties).
- `lw=true` runs at and below the 5-star threshold to confirm the suffix gates properly.

Plus a deterministic random sweep of 40 profiles and a per-title aggregate count, to catch
repetition over a wider sample.

### UI integration

- `#run-title` (gameover overlay, between "game over" and the final score) — populated by
  `renderChallengeCard()` from the player's live runStats + `currentRunSeed` +
  `showLaunchWindow`. Same stats bag also feeds `buildChallengeUrl()` so the title shown on
  the player's gameover matches what the recipient sees when they open the link.
- `#challenge-title` (start-screen welcome card, above the "challenge" label) — populated by
  `showChallengeCard()` from the decoded `_incomingChallenge` object.
- CSS: 13 px uppercase, 4 px letter-spacing, warm-amber colour (rgba 255,220,160,.65). The
  slots have `:empty { display: none }` so a non-challenge run / no-incoming-challenge
  start-screen renders cleanly without an empty 1-em gap.

## Window resize

`resize()` re-centers the camera on the current star (`camY` and `camTargetY` both snapped) so a
window resize or mobile orientation flip doesn't leave the ship off-screen. The seeded PRNG that
places background stars sees the same sequence per session, so they stay anchored across resizes.

## Perf notes

Several late-game hot paths have been specifically tuned:

- `predictCapture` crash loop starts at `currentStarIdx` instead of 0 — past stars can't collide
  with a forward-going trajectory.
- Star batch skips past stars older than `ball.currentStar - PAST_STAR_KEEP` (6): scrolled-off
  embers carry no gameplay info and their quad fragments aren't free.
- Launch-window recompute uses pooled sample + result objects and a reused `predictCapture`
  out-parameter.
- Music voices call `osc.onended = () => disconnect()` so stopped audio nodes are GC-eligible
  immediately (otherwise mobile accumulates zombie graph nodes under high note rate).
- **Render-position is forward-extrapolated** from the post-tick ball state by `(physicsAccumulator
  / PHYSICS_DT_MS)` of one tick's velocity, instead of interpolating between the two most recent
  physics states. The interpolation form collapsed when a frame ran *zero* physics ticks (common on
  120/144 Hz monitors where elapsed ≈ tick dt and RAF jitter occasionally drops below the threshold)
  — `ballPrev` and `ball` were equal, rendering froze for that frame and then jumped two ticks the
  next. Forward-extrapolation advances continuously regardless of the per-frame tick count.

### FPS counter (`?fps=1`)

Append `?fps=1` to the URL to enable a debug FPS overlay (top-left, dim panel). Shows a rolling mean
over the last `FPS_WINDOW_MS` (3 s); samples push onto a queue each frame and drain past the window.
DOM update is throttled to 4 Hz so text-content churn stays off the hot path. Counter resets on each
`init()` so welcome-screen idle frames don't poison the average. Only ticks during `STATE.PLAY` /
`STATE.DYING`; pauses naturally with the game.

## Bluetooth audio compensation

`audio.getOutputLatency()` reads `ctx.outputLatency`. When it exceeds 60 ms (indicative of BT
headphones), the capture SFX is pre-scheduled `outputLatency` seconds ahead of the actual capture
event so the chime arrives at the user's ears at the visual moment. Reactive SFX (boost on tap)
can't be compensated; the boost exhaust burst is beefier than strictly necessary to make the tap
land visually.

## Start screen

Shows stored high score if available (visibility-based, no layout shift). Best score loaded from
`localStorage`.

## Renderer fall-back & vector mode

`gameplay.js` picks a renderer at module load and tracks it in `_useVector` plus the boot-time
flag `_vectorModeActive` (read by `resize()` to pick a DPR cap of 1.5 on touch+vector vs 2
otherwise).

- `?vector=1` → vector renderer from the start.
- `?nowebgl=1` → dev/test override: skips `createRenderer()` so the fall-back path runs even on
  a WebGL2-capable browser.
- No params + `createRenderer()` returns null → silent fall-back, `_webglAvailable = false`,
  `body.webgl-unavailable` class added. A dedicated `#webgl-unavailable-banner` (body-level,
  immune to `body.vector` CSS) appears 800 ms after boot announcing the fall-back; the WebGL
  pill in the help overlay renders disabled for the rest of the session.

`toggleVectorMode()` (bound to V and the help-overlay renderer pills) replaces the canvas DOM
element so the new context type can be acquired, updates `_vectorModeActive`, re-`resize()`s
(so the DPR cap matches the new mode), creates the new renderer, and fires a `vector on` /
`vector off` flash. Toggling back to WebGL is refused when `_webglAvailable` is false.

## Boost hint

`#hint` ("tap to boost") shows on `newGame()` only when the first-run intro has already been
seen — the intro covers the same guidance for first-time players, and `continueRun` /
`resumeFromSave` skip the hint entirely (the player has clearly played before). The hint clears
on the first boost (`hasBoosted = true`), and as a safety net `showBoostHint()` schedules an
8-second auto-hide via `_boostHintTimer` so it can't linger past the early-game window even if
the player never taps. The timer is also cleared from the `die()` post-DYING callback so an
orphan timeout can't fire mid-game-over.

## HUD buttons

`reload` (bottom-left), `?` help (next to reload), `fullscreen` (bottom-right, hidden on iOS
Safari), `mute` (bottom-right).

## Tunables

Spawn rates live in `SPAWN_TABLE`, `PLANET_PROB_MAX`, `PLANET_RAMP_STARS`, `COMET_PROB`,
`COMET_MIN_STAR`. Other tunables near the top of `gameplay.js`: `ZOOM`, `CAM_FOCUS_Y`, `PHYSICS_HZ`,
`MAX_FRAME_GAP_MS`, `MISS_GRAVITY_MULT`, `DYING_FRAMES_MS`, `COMET_SCORE_RADIUS`, `COMET_BONUS`,
`FAST_STREAK_CAP`, `BH_VISUAL_SCALE`, `EJECTA_MAX`, `EJECTA_GM_MULT`.

Cinematic camera knobs: `CINEMATIC_ZOOM_NEAR`, `CINEMATIC_ZOOM_FAR` (per-platform via `IS_TOUCH`),
`CINEMATIC_LEVELS`, `CINEMATIC_FOLLOW_TAU_MS` (660 ms), `CINEMATIC_LERP_TAU_MS` (270 ms),
`CINEMATIC_ZOOM_AMP` (0; re-enable simplex breath by setting > 0). Launch-window knobs:
`LAUNCH_WINDOW_SAMPLES` (36), `LAUNCH_WINDOW_BOOST_STEPS` (24 — half the live `applyBoostAndArm`
grid), `LAUNCH_WINDOW_RECOMPUTE_FRAMES` (12), `LW_SLOTS_PER_FRAME` (6, slots advanced per frame in
the time-sliced build).
