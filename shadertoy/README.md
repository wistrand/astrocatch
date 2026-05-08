# Shadertoy ports

Self-contained Shadertoy re-implementations of four of the
visually-loaded variants from [ASTROCATCH](https://astrocatch.live)'s
star renderer (`docs/renderer.js`).  Each file is a single-pass
fragment shader that compiles cleanly in Shadertoy's `Image` slot.

| File | Ports | Mouse |
|---|---|---|
| [`nebula.glsl`](nebula.glsl) | Volumetric supernova-remnant nebula — 5-shell ray-march, simplex / value-noise FBM, palette categorical, per-shell edge masks, optional Bezier-tube filamentary morphology, optional butterfly equatorial pinch, optional Tier-1 single-scatter dust halo. | None (static). |
| [`ringworld.glsl`](ringworld.glsl) | Ringworld habitat — ray-cylinder intersection, near (outside / structural) and far (inside / earth-textured) faces, optional inner shadow plates with sun shadow + city lights. | Drag → 3D camera orbit. |
| [`blackhole.glsl`](blackhole.glsl) | Black hole — event horizon, edge-on accretion disk with asymmetric lensed back-arcs, gravitational lensing distortion, procedural reference grid, photon ring.  Combines per-instance star branch + fullscreen lensing pass into a single shader. | Drag → move BH across the procedural starfield. |
| [`monolith.glsl`](monolith.glsl) | Monolith — analytic ray-vs-axis-aligned-slab intersection in box-local coordinates (1:4:9 proportion), Rodrigues-rotation tumble around a per-monolith random axis, dominant-axis face normal selection, directional diffuse + power-4 fresnel rim. | Drag → 3D camera orbit. |

Open Shadertoy → New → paste a file's contents into the `Image`
buffer → Compile.

Each file ships a Shadertoy metadata block at the top with a
suggested **Name**, **Description**, **Tags**, and **License**
(MIT) — copy these into the corresponding fields on Shadertoy
when publishing.

## Tweakable knobs

Every parameter the in-game variant samples per-instance is exposed
as a `const` declaration at the top of each file with a comment
explaining the range. Edit a constant and recompile to see the
result. Examples:

- `nebula.glsl`: `PALETTE_IDX 0..3` (Crab synchrotron / OIII Helix /
  hot blue / dust-reddened), `BIPOLAR_AMP`, `CAVITY_SIZE`,
  `IS_FILAMENT`, `IS_BUTTERFLY` (equatorial pinch),
  `BUTTERFLY_NECK_AMP / BUTTERFLY_SHARPNESS`, `STRAT_OFFSET`, ...
  Per-palette dust scatter (`scatterMul` / `phaseG`) is set in the
  palette dispatch block — Crab=0 (synchrotron is direct emission),
  Helix=0.4, NGC 7027=0.7, dust-reddened=1.0.
- `ringworld.glsl`: `RING_PLATE_COUNT 0..7`, `TUMBLE_RATE`,
  `SUN_R_MULT`, `OUTSIDE_AMBIENT / OUTSIDE_DIFFUSE / INSIDE_AMBIENT
  / INSIDE_DIFFUSE` (lighting balance per face — bumped from the
  in-game defaults for better visibility on Shadertoy).
- `blackhole.glsl`: `V_BASE_R`, `LENS_R_MULT`, disk geometry
  multipliers, photon-ring shape.
- `monolith.glsl`: `ASPECT_X / Y / Z` (default 0.189 : 0.747 : 1.692
  for the canonical 1:4:9 monolith), `TUMBLE_RATE`, `LIGHT_DIR`,
  `RIM_COLOR`, `RIM_INTENSITY`.

The `NEBULA_SEED` / `V_SEED` knob seeds noise offsets and any
seed-derived directions, so changing it rolls a different shape
without touching the explicit parameters.

## Algorithm fidelity

The ports preserve the algorithm verbatim from `renderer.js`. Only
the harness changes:

- **Coordinates**: the in-game shader receives a per-instance local
  `loc` from the vertex shader; here `loc = fragCoord - res * 0.5`
  centres the variant on the canvas.
- **Time**: `u_time` → `iTime`. All `u_time` multipliers are still
  the original 2-decimal rationals so the in-game `TIME_WRAP`
  invariant continues to hold.
- **Mouse**: replaces uniforms the in-game shader doesn't expose
  (per-BH disk tilt, manual rotation, BH position).
- **Background**: the BH port generates a procedural starfield
  + reference grid inline, since Shadertoy has no FBO equivalent
  of the in-game scene-FBO + lensing-composite pipeline.

## Performance notes

- `nebula.glsl` is the heaviest port: 7-step volumetric ray-march,
  3 native 3D simplex calls per FBM evaluation plus 5 shell
  evaluations (each shell skips when |dF| > 3σ; transmittance
  early-out for dense fragments). ~2500 ALU/fragment ellipsoidal
  Crab, ~3200 ALU filamentary dust-reddened. Resize the canvas
  down on integrated GPUs. The dust-scatter halo and butterfly
  pinch are optional knobs at the top.
- `ringworld.glsl` is moderate: ray-cylinder × 2 (ring + plates)
  + hex tiling on the outside face + multi-octave clouds /
  city-lights on the inside. ~200 ALU/fragment.
- `blackhole.glsl` is light per fragment but every pixel runs
  the full shader (no quad culling): ~150 ALU + the procedural
  starfield's 3×3 grid-cell sample.
- `monolith.glsl` is the cheapest: ~50 ALU/fragment for the
  Rodrigues matrix + slab intersection. Most pixels miss the
  slab and short-circuit before any lighting.

## Source

Game: <https://astrocatch.live>
Code: <https://github.com/wistrand/astrocatch>

The full per-instance star fragment shader (with all variants —
plain stars, binaries, monoliths, ringworlds, pulsars, black
holes, nebulae) lives in `docs/renderer.js` as the `STAR_FS`
template string. Open that file and search for `if (isNebula)`,
`if (isRingworld)`, `if (isBlackHole)`, `if (isMonolith)` to see
the original context each port was extracted from.

The nebula path is gated behind `#ifdef NEBULA_ONLY` and lives
in a second GL program compiled from the same source; live
nebulae render through that program instead of the common one
to avoid taxing the rest of the variants with nebula's register
footprint.

## License

MIT (matches the parent project's `package.json`).  Each `.glsl`
file declares this in its metadata block.
