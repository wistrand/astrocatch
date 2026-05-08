// =====================================================================
// Nebula — Shadertoy port of ASTROCATCH renderer.js (isNebula branch)
// =====================================================================
//
// Shadertoy:
//   Name:        Volumetric supernova-remnant nebula
//   Description: 5-shell volumetric ray-march with simplex/value-noise
//                FBM, palette categorical, per-shell edge masks,
//                optional Bezier-tube filamentary morphology, butterfly
//                equatorial pinch, dust-scatter halo, pulsar pinpoint
//                with halo + mid-glow. Ported from astrocatch.live.
//   Tags:        nebula, volumetric, raymarch, fbm
//   License:     MIT
//
//   Play the game:  https://astrocatch.live
//   Source code:    https://github.com/wistrand/astrocatch
//
// Self-contained re-implementation of the procedural nebula shader
// from docs/renderer.js. Algorithm preserved verbatim:
// 5-shell volumetric integration with front-to-back transmittance,
// simplex / value-noise FBM, palette categorical, per-shell edge
// masks (Design A), optional quadratic-Bezier filamentary morphology,
// optional butterfly equatorial pinch, optional Tier-1 single-scatter
// dust halo (Henyey-Greenstein phase function), pulsar pinpoint with
// halo + mid-glow.
//
// All tweakable knobs are exposed as const declarations at the top —
// change them and re-press Compile to roll a new look.
//
// Cost: heavy but improved. 7-step volumetric ray-march. Native 3D
// simplex (vs the old 3-projection-averaged 2D simplex) cuts ~1000
// ALU off the per-fragment FBM cost. Roughly ~2500 ALU/fragment
// ellipsoidal, ~3200 ALU/fragment filamentary. Disable the
// filamentary morph if perf still matters.

const float PI  = 3.14159265;
const float TAU = 6.28318530;

// ─────────────────────────────────────────────────────────────────────
// Tweakable parameters
// ─────────────────────────────────────────────────────────────────────

// Master noise seed. Drives sample offsets, per-shell jitter patterns,
// bipolar pole axis direction, filament bend direction, etc.
const float NEBULA_SEED = 142.0;

// Palette class:
//   0 = Crab synchrotron  (cyan / yellow / orange / red / red)
//   1 = Helix OIII        (green / cyan / pale / soft red / dim red,
//                          bimodal radial — OIII core + Hα halo)
//   2 = NGC 7027 hot blue (blue / cyan / pale orange / pink / muted)
//   3 = Dust-reddened     (amber / orange / red / deep red / brown)
const int PALETTE_IDX = 0;

// Central source flavour (visibility of the pinpoint star):
//   0 = visible pinpoint at centre
//   1 = hidden source (no pinpoint, but cavity gas still glows)
//   2 = off-centre pinpoint (uses PULSAR_OFFSET below)
const int CENTRAL_FLAVOUR = 0;

// false = ellipsoidal closed-volume shells (default)
// true  = quadratic-Bezier tube morphology (filamentary nebula)
const bool IS_FILAMENT = false;

// Butterfly equatorial pinch — sharp cavity at the bipolar equator
// that the smooth cos²θ bipolar bias can't reach. Only relevant when
// BIPOLAR_AMP is high enough; smoothstep gate keeps spheroidal
// nebulae from picking up an awkward notched waist.
const bool  IS_BUTTERFLY        = false;
const float BUTTERFLY_NECK_AMP  = 0.85;  // peak field bump at equator
const float BUTTERFLY_SHARPNESS = 8.0;   // higher = thinner waist

// Bipolar pinch strength. 0.30 ≈ nearly spheroidal, 0.95 ≈ strong
// cigar/peanut. Pinches equator inward, bulges poles outward.
const float BIPOLAR_AMP = 0.65;

// Shell-threshold multiplier — overall density / compactness.
// 0.6 = compact dense, 1.6 = sparse diffuse.
const float CAVITY_SIZE = 1.0;

// Density multiplier on per-shell brightness weights.
// 0.7 = thin / faint, 1.4 = thick / bright.
const float DENSITY_MULT = 1.0;

// Fibre overlay frequency multiplier.  0.6 = coarse threads,
// 1.5 = fine threads.
const float FIBRE_FREQ_MULT = 1.0;

// Fibre overlay shape — pow exponent / floor / gain.
const float FIBRE_POW   = 1.50;
const float FIBRE_FLOOR = 0.30;
const float FIBRE_GAIN  = 1.40;

// Stratification offset — shifts the radial crisp-to-soft gradient
// in the per-shell edge masks. Negative = young (all shells crisp),
// positive = old (all shells diffuse).  Range typically [-0.4, +0.4].
const float STRAT_OFFSET = 0.0;

// Lobe asymmetry amplitude (applied to +pole hemisphere only).
// Most nebulae are mild (0.0–0.15); rare outliers reach ~0.45.
const float LOBE_ASYM_AMP = 0.10;

// Ellipsoid eccentricity and rotation angle (radians).
// ECC: 0.0 = sphere, 0.25 = mild prolate, 0.40 = strong cigar.
const float ECC = 0.15;
const float ANG = 0.70;

// Interior fill density (decoupled from CENTRAL_FLAVOUR):
//   1.20 = full body
//   0.80 = moderate
//   0.40 = sparse / etched aesthetic (raise AESTHETIC_FIBRE_GAIN to ~1.45)
const float FILL_MULT            = 1.20;
const float AESTHETIC_FIBRE_GAIN = 1.00;

// Pulsar offset, only used when CENTRAL_FLAVOUR == 2.
// Units of v_baseR (so 0.55 ≈ half a nebula radius from origin).
const vec2 PULSAR_OFFSET = vec2(0.30, -0.20);

// Filament Bezier mid-control bend amplitude.  Larger = stronger
// S-curve. Only used when IS_FILAMENT.
const float FILAMENT_BEND_AMP = 1.10;

// Nebula screen radius in pixels. v_baseR equivalent — the unit of
// every distance in the algorithm. The nebula visibly extends to
// roughly 3.0 × this radius.
const float V_BASE_R = 120.0;

// Per-pulsar palette tint (the v_c1 equivalent in the renderer).
// Mostly modulates pulsar pinpoint and the 10 % shell-color tint.
const vec3 V_C1 = vec3(0.55, 0.85, 1.00);

// ─────────────────────────────────────────────────────────────────────
// Noise helpers
// ─────────────────────────────────────────────────────────────────────

// Sin-free Hoskins hash — replaces the classic fract(sin) hash to
// avoid axis-aligned tiling at large input values.
float vhashN(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoiseN(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = vhashN(i);
  float b = vhashN(i + vec2(1.0, 0.0));
  float c = vhashN(i + vec2(0.0, 1.0));
  float d = vhashN(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// 5-octave ridged multifractal — produces line-like ridges along
// noise zero-crossings.
float ridgedFBMN(vec2 p) {
  float t = 0.0;
  float amp = 0.55;
  float freq = 1.0;
  for (int i = 0; i < 5; i++) {
    float n = 2.0 * vnoiseN(p * freq) - 1.0;
    t += (1.0 - abs(n)) * amp;
    amp *= 0.55;
    freq *= 2.05;
  }
  return t;
}

// 2D simplex noise (Ashima Arts / Stefan Gustavson). Returns ~[-1, 1].
vec3 cMod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 cMod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 cMod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 cPermute(vec3 x) { return cMod289(((x * 34.0) + 1.0) * x); }
vec4 cPermute(vec4 x) { return cMod289(((x * 34.0) + 1.0) * x); }
float snoiseN(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                      -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = cMod289(i);
  vec3 p = cPermute(cPermute(i.y + vec3(0.0, i1.y, 1.0))
                  + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0),
                          dot(x12.xy, x12.xy),
                          dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

// 3D simplex noise (Stefan Gustavson / Ashima Arts). Returns ~[-1, 1].
// Tetrahedral lattice — 4 corners per sample. Replaces the previous
// "fake 3D via three averaged 2D projections" trick: native 3D gives
// smoother z-evolution (no z-tunnel artifact from shared xy
// projection across z-steps) for ~30% less ALU per FBM evaluation.
float snoise3DN(vec3 v) {
  const vec2 C  = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D  = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = cMod289(i);
  vec4 p = cPermute(cPermute(cPermute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 1.0 / 7.0;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 g0 = vec3(a0.xy, h.x);
  vec3 g1 = vec3(a0.zw, h.y);
  vec3 g2 = vec3(a1.xy, h.z);
  vec3 g3 = vec3(a1.zw, h.w);
  vec4 norm = 1.79284291400159 - 0.85373472095314 *
              vec4(dot(g0, g0), dot(g1, g1),
                   dot(g2, g2), dot(g3, g3));
  g0 *= norm.x;
  g1 *= norm.y;
  g2 *= norm.z;
  g3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1),
                           dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(g0, x0), dot(g1, x1),
                                 dot(g2, x2), dot(g3, x3)));
}

// 3-octave 3D simplex FBM. Frequency ratio 2.07 (slightly off 2.0)
// avoids any chance of grid resonance across octaves.
float fbm3DN(vec3 p) {
  return 0.65 * snoise3DN(p)
       + 0.32 * snoise3DN(p * 2.07)
       + 0.16 * snoise3DN(p * 4.28);
}

// ─────────────────────────────────────────────────────────────────────
// Nebula renderer
// ─────────────────────────────────────────────────────────────────────

vec4 renderNebula(vec2 loc, float u_time) {
  float v_baseR = V_BASE_R;
  float v_seed  = NEBULA_SEED;
  vec3  v_c1    = V_C1;

  float d = length(loc);
  float r = d / max(v_baseR, 1.0);
  vec2  puv = loc / max(v_baseR, 1.0);
  vec2  seedOff  = vec2(v_seed * 7.3, v_seed * 11.7);
  vec3  seedOff3 = vec3(seedOff, v_seed * 5.1);

  // Slow Lissajous flow through the FBM domain. Boils over minutes.
  vec3 flow = vec3(sin(u_time * 0.01 + v_seed),
                   cos(u_time * 0.02 + v_seed * 1.3),
                   sin(u_time * 0.03 + v_seed * 2.1)) * 2.0;
  float fbmScale = 0.55;

  // ── Palette dispatch ──────────────────────────────────────────
  // Each palette is a different physical species — not just a hue
  // rotation — so shell brightness profile, central source character,
  // and dust-scatter properties all vary by palette.
  vec3  shell0Col, shell1Col, shell2Col, shell3Col, shell4Col;
  vec3  paletteGlow, paletteCore;
  float w0, w1, w2, w3, w4;
  float pulsarFalloff, pulsarPulseRate, pulsarBrightness;
  // Per-palette dust-scatter: 0 disables the halo entirely
  // (synchrotron is direct emission, not scattered light); phaseG
  // is the Henyey-Greenstein asymmetry parameter, larger = more
  // forward-peaked, typical of bigger grains.
  float scatterMul, phaseG;
  if (PALETTE_IDX == 0) {
    shell0Col = vec3(0.55, 0.83, 0.75);
    shell1Col = vec3(0.92, 0.95, 0.32);
    shell2Col = vec3(1.00, 0.68, 0.20);
    shell3Col = vec3(0.98, 0.36, 0.16);
    shell4Col = vec3(0.95, 0.20, 0.20);
    paletteGlow = vec3(0.55, 0.85, 1.00);
    paletteCore = vec3(1.00, 0.95, 0.85);
    w0 = 0.22; w1 = 0.20; w2 = 0.18; w3 = 0.16; w4 = 0.13;
    pulsarFalloff = 280.0;
    pulsarPulseRate = 8.00;
    pulsarBrightness = 1.70;
    scatterMul = 0.0;
    phaseG = 0.0;
  } else if (PALETTE_IDX == 1) {
    shell0Col = vec3(0.40, 0.90, 0.55);
    shell1Col = vec3(0.50, 0.95, 0.85);
    shell2Col = vec3(0.92, 0.98, 0.78);
    shell3Col = vec3(0.95, 0.55, 0.45);
    shell4Col = vec3(0.78, 0.30, 0.30);
    paletteGlow = vec3(0.55, 0.95, 0.85);
    paletteCore = vec3(0.75, 1.00, 0.85);
    // Bimodal radial structure — inner OIII peak (shells 0-1) and
    // outer Hα peak (shells 3-4) with a faint mid-shell trough.
    w0 = 0.30; w1 = 0.25; w2 = 0.10; w3 = 0.20; w4 = 0.15;
    pulsarFalloff = 150.0;
    pulsarPulseRate = 4.50;
    pulsarBrightness = 1.30;
    scatterMul = 0.4;
    phaseG = 0.3;
  } else if (PALETTE_IDX == 2) {
    shell0Col = vec3(0.45, 0.65, 1.00);
    shell1Col = vec3(0.55, 0.95, 1.00);
    shell2Col = vec3(0.95, 0.85, 0.55);
    shell3Col = vec3(0.95, 0.50, 0.65);
    shell4Col = vec3(0.80, 0.32, 0.50);
    paletteGlow = vec3(0.55, 0.75, 1.00);
    paletteCore = vec3(0.65, 0.80, 1.00);
    w0 = 0.28; w1 = 0.22; w2 = 0.16; w3 = 0.18; w4 = 0.14;
    pulsarFalloff = 200.0;
    pulsarPulseRate = 6.00;
    pulsarBrightness = 1.50;
    scatterMul = 0.7;
    phaseG = 0.4;
  } else {
    shell0Col = vec3(0.85, 0.65, 0.35);
    shell1Col = vec3(0.95, 0.50, 0.20);
    shell2Col = vec3(0.95, 0.32, 0.15);
    shell3Col = vec3(0.72, 0.22, 0.12);
    shell4Col = vec3(0.50, 0.18, 0.12);
    paletteGlow = vec3(0.95, 0.65, 0.40);
    paletteCore = vec3(1.00, 0.75, 0.40);
    w0 = 0.10; w1 = 0.14; w2 = 0.18; w3 = 0.22; w4 = 0.28;
    pulsarFalloff = 100.0;
    pulsarPulseRate = 0.00;
    pulsarBrightness = 0.80;
    scatterMul = 1.0;
    phaseG = 0.5;
  }
  w0 *= DENSITY_MULT; w1 *= DENSITY_MULT; w2 *= DENSITY_MULT;
  w3 *= DENSITY_MULT; w4 *= DENSITY_MULT;

  float pulsarMul    = (CENTRAL_FLAVOUR == 1) ? 0.0 : 1.0;
  float innerHaloMul = FILL_MULT;
  float midGlowMul   = FILL_MULT;
  vec2  pulsarOffset = (CENTRAL_FLAVOUR == 2) ? PULSAR_OFFSET : vec2(0.0);

  // ── Ellipse setup ─────────────────────────────────────────────
  float cosA = cos(ANG), sinA = sin(ANG);
  float majA = 1.0 + ECC;
  float minA = 1.0 - ECC;
  vec2 rotLocN = vec2(loc.x * cosA + loc.y * sinA,
                     -loc.x * sinA + loc.y * cosA)
               / max(v_baseR, 1.0);
  float xN = rotLocN.x / majA;
  float yN = rotLocN.y / minA;
  float xy_term = xN * xN + yN * yN;

  // ── Bipolar setup ─────────────────────────────────────────────
  // 2D pole axis, derived from seed. dot/inversesqrt instead of
  // length+divide; max() floor folds the > 0.001 guard.
  float poleAng = v_seed * 1.7 + 0.3;
  vec2 poleDir = vec2(cos(poleAng), sin(poleAng));
  float rotLen2 = dot(rotLocN, rotLocN);
  float invRotLen = inversesqrt(max(rotLen2, 1e-6));
  float dirAlongPole = dot(rotLocN, poleDir) * invRotLen;
  float cosSq = dirAlongPole * dirAlongPole;
  float biPolarBase = -BIPOLAR_AMP * (cosSq - 0.40);
  float waistJitter = 0.18 * snoiseN(puv * 0.7
                                      + seedOff + flow.xy);
  float lobeFBM = fbm3DN(vec3(rotLocN * 0.45 + seedOff
                                + vec2(57.0, 73.0), v_seed * 11.0));
  float lobeAsym = LOBE_ASYM_AMP * lobeFBM
                 * step(0.0, dirAlongPole);

  // Butterfly equatorial pinch — cot²θ peaks at the equator and
  // falls off Gaussian-sharply toward the poles, carving a thin
  // waist that the smooth cos²θ bipolar bias can't reach. Smooth
  // gate on BIPOLAR_AMP keeps spheroidal nebulae from picking up
  // an awkward notched waist.
  float butterflyNeck = IS_BUTTERFLY
    ? BUTTERFLY_NECK_AMP * smoothstep(0.50, 0.80, BIPOLAR_AMP)
    : 0.0;
  float cotSq = cosSq / max(1.0 - cosSq, 1e-3);
  float neck = butterflyNeck * exp(-cotSq * BUTTERFLY_SHARPNESS);

  float biPolar = biPolarBase + waistJitter + lobeAsym + neck;

  // High-freq warp — adds wisps-inside-wisps detail.
  vec2 hiBase = rotLocN * 5.0 + seedOff;
  vec2 hiWarp = vec2(snoiseN(hiBase),
                     snoiseN(hiBase + vec2(11.0, 7.0))) * 0.07;

  // ── Filament Bezier setup (only used when IS_FILAMENT) ───────
  vec3 filamentP0 = vec3(0.0);
  vec3 filamentP1 = vec3(0.0);
  vec3 filamentP2 = vec3(0.0);
  if (IS_FILAMENT) {
    float endAng = v_seed * 5.7;
    vec3 endDir = normalize(vec3(
      cos(endAng),
      0.6 * sin(endAng),
      0.3 * sin(endAng * 1.3)
    ));
    float endLen = 2.4;
    filamentP0 = -endDir * endLen;
    filamentP2 =  endDir * endLen;
    vec3 refV = abs(endDir.y) < 0.9
              ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 perp1 = normalize(cross(endDir, refV));
    vec3 perp2 = cross(endDir, perp1);
    float bendAng = v_seed * 13.7;
    vec3 bendDir = perp1 * cos(bendAng) + perp2 * sin(bendAng);
    filamentP1 = bendDir * FILAMENT_BEND_AMP;
  }

  // ── Pre-loop edge noise samples (Design A) ───────────────────
  // Each shell mixes between these based on its intrinsic radial
  // softness + STRAT_OFFSET, applied per-shell inside the loop.
  float fibreFreq = mix(2.5, 8.0, smoothstep(0.0, 2.0, r))
                  * FIBRE_FREQ_MULT;
  float ridgedSample = ridgedFBMN(puv * fibreFreq + seedOff * 0.7);
  float ridgedEdge = pow(clamp(ridgedSample, 0.0, 1.0), FIBRE_POW);
  float smoothSample = vnoiseN(puv * (fibreFreq * 0.55)
                                + seedOff * 0.7 + vec2(13.7, 7.3));
  float smoothEdge = smoothstep(0.25, 0.75, smoothSample);

  // ── Z-independent per-shell precomputes ──────────────────────
  // Hoisted from the integration loop — none of these depend on
  // zStep, so re-computing them per step was pure waste.

  // Shock mask gates ridged FBM to compressed regions; multiplies
  // shell brightness, not hue. Threshold 0.55 keeps the bulk at
  // base colour.
  float shockMask = ridgedFBMN(rotLocN * 2.5
                                + seedOff + flow.xy * 0.5);
  shockMask = pow(clamp(shockMask, 0.0, 1.0), 1.6);
  float shockBrighten = 1.0
                      + 0.55 * smoothstep(0.55, 0.85, shockMask);

  // Per-shell field-threshold jitter — angular FBM bumps that
  // break the radially-even shell spacing.
  vec2 jitBase = rotLocN * 0.8 + seedOff;
  float jit0 = 0.10 * snoiseN(jitBase);
  float jit1 = 0.10 * snoiseN(jitBase + vec2(7.3, 11.0));
  float jit2 = 0.10 * snoiseN(jitBase + vec2(13.0, 5.7));
  float jit3 = 0.10 * snoiseN(jitBase + vec2(23.0, 17.0));
  float jit4 = 0.10 * snoiseN(jitBase + vec2(31.0, 41.0));

  // Per-shell edge softness in [0,1] — intrinsic radial role
  // (0 = inner crisp, 1 = outer diffuse) plus per-nebula
  // STRAT_OFFSET shift.
  float es0 = clamp(0.00 + STRAT_OFFSET, 0.0, 1.0);
  float es1 = clamp(0.25 + STRAT_OFFSET, 0.0, 1.0);
  float es2 = clamp(0.50 + STRAT_OFFSET, 0.0, 1.0);
  float es3 = clamp(0.75 + STRAT_OFFSET, 0.0, 1.0);
  float es4 = clamp(1.00 + STRAT_OFFSET, 0.0, 1.0);
  float edge0 = mix(ridgedEdge, smoothEdge, es0);
  float edge1 = mix(ridgedEdge, smoothEdge, es1);
  float edge2 = mix(ridgedEdge, smoothEdge, es2);
  float edge3 = mix(ridgedEdge, smoothEdge, es3);
  float edge4 = mix(ridgedEdge, smoothEdge, es4);
  float fl0 = mix(FIBRE_FLOOR, FIBRE_FLOOR + 0.30, es0);
  float fl1 = mix(FIBRE_FLOOR, FIBRE_FLOOR + 0.30, es1);
  float fl2 = mix(FIBRE_FLOOR, FIBRE_FLOOR + 0.30, es2);
  float fl3 = mix(FIBRE_FLOOR, FIBRE_FLOOR + 0.30, es3);
  float fl4 = mix(FIBRE_FLOOR, FIBRE_FLOOR + 0.30, es4);
  float gnFull = FIBRE_GAIN * AESTHETIC_FIBRE_GAIN;
  float gnSoft = gnFull * 0.5;
  float gn0 = mix(gnFull, gnSoft, es0);
  float gn1 = mix(gnFull, gnSoft, es1);
  float gn2 = mix(gnFull, gnSoft, es2);
  float gn3 = mix(gnFull, gnSoft, es3);
  float gn4 = mix(gnFull, gnSoft, es4);

  // Per-shell base colours and lumas (pre satF desaturation).
  // satF still varies per z-step inside the loop; only the
  // shockBrighten-multiplied base + its luma are z-independent.
  vec3 baseShell0 = shell0Col * shockBrighten;
  vec3 baseShell1 = shell1Col * shockBrighten;
  vec3 baseShell2 = shell2Col * shockBrighten;
  vec3 baseShell3 = shell3Col * shockBrighten;
  vec3 baseShell4 = shell4Col * shockBrighten;
  float luma0 = dot(baseShell0, vec3(0.299, 0.587, 0.114));
  float luma1 = dot(baseShell1, vec3(0.299, 0.587, 0.114));
  float luma2 = dot(baseShell2, vec3(0.299, 0.587, 0.114));
  float luma3 = dot(baseShell3, vec3(0.299, 0.587, 0.114));
  float luma4 = dot(baseShell4, vec3(0.299, 0.587, 0.114));

  // Drop a per-step divide in the ellipsoidal r3D.
  float invMinASq = 1.0 / (minA * minA);

  // Henyey-Greenstein phase function precomputes for the per-step
  // scatter integral. (1-g²) and g² are palette-derived and
  // z-independent.
  float phaseG2 = phaseG * phaseG;
  float oneMinusG2 = 1.0 - phaseG2;
  float scatterCoeff = scatterMul * pulsarBrightness;

  // Factor the loop-invariant parts of the FBM sample-point
  // construction. The xy and z-constant components don't depend
  // on zStep, so the in-loop work collapses to a single fma in z.
  vec2  p3xyConst = (puv + hiWarp) * fbmScale + seedOff3.xy + flow.xy;
  float p3zConst  = seedOff3.z + flow.z;

  // ── Volumetric integration ───────────────────────────────────
  const int   N_STEPS = 7;
  const float ZMAX    = 2.7;
  float shellMask     = 0.0;
  vec3  shellColAccum = vec3(0.0);
  float trans         = 1.0;

  for (int i = 0; i < N_STEPS; i++) {
    float t = (float(i) + 0.5) / float(N_STEPS);
    // Front to back so trans attenuates back shells.
    float zStep = ZMAX - 2.0 * ZMAX * t;
    vec3 p3 = vec3(p3xyConst, zStep * fbmScale + p3zConst);
    float fbm = fbm3DN(p3);

    float r3D;
    float field;
    if (IS_FILAMENT) {
      vec3 pos3 = vec3(puv, zStep);
      // Closest point on quadratic Bezier — 12 samples + 2 Newton
      // iterations.
      float bestT  = 0.5;
      float bestD2 = 1e9;
      for (int j = 0; j < 12; j++) {
        float tt = (float(j) + 0.5) / 12.0;
        float u = 1.0 - tt;
        vec3 onC = u * u * filamentP0
                 + 2.0 * u * tt * filamentP1
                 + tt * tt * filamentP2;
        vec3 dv = pos3 - onC;
        float d2 = dot(dv, dv);
        if (d2 < bestD2) { bestD2 = d2; bestT = tt; }
      }
      for (int j = 0; j < 2; j++) {
        float u = 1.0 - bestT;
        vec3 onC = u * u * filamentP0
                 + 2.0 * u * bestT * filamentP1
                 + bestT * bestT * filamentP2;
        vec3 dC = -2.0 * u * filamentP0
                + 2.0 * (1.0 - 2.0 * bestT) * filamentP1
                + 2.0 * bestT * filamentP2;
        vec3 d2C = 2.0 * filamentP0 - 4.0 * filamentP1
                 + 2.0 * filamentP2;
        vec3 diff = pos3 - onC;
        float f  = dot(diff, dC);
        float fp = -dot(dC, dC) + dot(diff, d2C);
        if (abs(fp) > 1e-5) {
          bestT = clamp(bestT - f / fp, 0.0, 1.0);
        }
      }
      float u = 1.0 - bestT;
      vec3 onCurve = u * u * filamentP0
                   + 2.0 * u * bestT * filamentP1
                   + bestT * bestT * filamentP2;
      float distToCurve = distance(pos3, onCurve);
      float thickness = mix(0.18, 0.55, sin(bestT * PI));
      r3D = distToCurve / max(thickness, 0.05);
      field = r3D + 0.75 * fbm;
    } else {
      // invMinASq hoisted pre-loop drops a per-step divide.
      r3D = sqrt(xy_term + zStep * zStep * invMinASq);
      float bpFade = smoothstep(0.6, 1.3, r3D);
      field = r3D + 0.75 * fbm + biPolar * bpFade;
    }

    float rhoStep = 0.0;
    vec3  colStep = vec3(0.0);

    // Radial saturation curve — saturated near the source, muted
    // at the outer dust. Depends on r3D so stays in the loop.
    float satF = mix(1.25, 0.80, smoothstep(0.5, 2.5, r3D));

    // Shell 0 — innermost (sigma 0.06). Edge style: crisp ridged
    // filaments (intrinsic softness 0.0). 3σ skip: outside |dF| <
    // 3σ the Gaussian is < exp(-9) ≈ 1e-4 — well below the
    // perceptual floor after compositing.
    {
      float dF = field - (1.50 * CAVITY_SIZE + jit0);
      float dFsq = dF * dF;
      if (dFsq < 0.0324) {
        float m = exp(-dFsq / 0.0036);
        m *= mix(1.0, 0.18, smoothstep(0.0, 0.06, dF));
        m *= fl0 + gn0 * edge0;
        // Cap radial saturation boost on shell 0 (inner band) so
        // saturated palettes don't go neon.
        float satFShell0 = min(satF, 1.05);
        vec3 shellC = mix(vec3(luma0), baseShell0, satFShell0);
        rhoStep += m * w0;
        colStep += shellC * m * w0;
      }
    }
    // Shell 1 (sigma 0.07). Intrinsic softness 0.25.
    {
      float dF = field - (1.77 * CAVITY_SIZE + jit1);
      float dFsq = dF * dF;
      if (dFsq < 0.0441) {
        float m = exp(-dFsq / 0.0049);
        m *= mix(1.0, 0.22, smoothstep(0.0, 0.07, dF));
        m *= fl1 + gn1 * edge1;
        vec3 shellC = mix(vec3(luma1), baseShell1, satF);
        rhoStep += m * w1;
        colStep += shellC * m * w1;
      }
    }
    // Shell 2 (sigma 0.08). Intrinsic softness 0.50.
    {
      float dF = field - (1.97 * CAVITY_SIZE + jit2);
      float dFsq = dF * dF;
      if (dFsq < 0.0576) {
        float m = exp(-dFsq / 0.0064);
        m *= mix(1.0, 0.26, smoothstep(0.0, 0.08, dF));
        m *= fl2 + gn2 * edge2;
        vec3 shellC = mix(vec3(luma2), baseShell2, satF);
        rhoStep += m * w2;
        colStep += shellC * m * w2;
      }
    }
    // Shell 3 (sigma 0.10). Intrinsic softness 0.75.
    {
      float dF = field - (2.29 * CAVITY_SIZE + jit3);
      float dFsq = dF * dF;
      if (dFsq < 0.0900) {
        float m = exp(-dFsq / 0.0100);
        m *= mix(1.0, 0.32, smoothstep(0.0, 0.10, dF));
        m *= fl3 + gn3 * edge3;
        vec3 shellC = mix(vec3(luma3), baseShell3, satF);
        rhoStep += m * w3;
        colStep += shellC * m * w3;
      }
    }
    // Shell 4 (sigma 0.13). Intrinsic softness 1.0 (fully soft).
    // dustM exports shell 4's m as the dust-density proxy used by
    // the scatter integral below. Stays 0 outside the 3σ window
    // so scatter only kicks in where dust is present.
    float dustM = 0.0;
    {
      float dF = field - (2.59 * CAVITY_SIZE + jit4);
      float dFsq = dF * dF;
      if (dFsq < 0.1521) {
        float m = exp(-dFsq / 0.0169);
        m *= mix(1.0, 0.40, smoothstep(0.0, 0.13, dF));
        m *= fl4 + gn4 * edge4;
        vec3 shellC = mix(vec3(luma4), baseShell4, satF);
        rhoStep += m * w4;
        colStep += shellC * m * w4;
        dustM = m;
      }
    }

    // Tier-1 single-scatter halo — palette-aware dust glow around
    // the central source. Optically-thin: no source-to-sample or
    // sample-to-camera opacity integrals. The trans factor still
    // attenuates the back-side scatter via the existing composite.
    if (scatterMul > 0.0 && dustM > 0.0) {
      vec3 fromSource = vec3(puv, zStep) - vec3(pulsarOffset, 0.0);
      // Plummer-style soft core (0.5 v_baseR-unit radius) so 1/r²
      // doesn't spike at samples adjacent to the source.
      float rcs2 = dot(fromSource, fromSource) + 0.25;
      float invR = inversesqrt(rcs2);
      float cosScat = fromSource.z * invR;
      // Phase-function softening: ε=0.05 caps the HG forward
      // peak. pow(x, 1.5) spelled as x*sqrt(x).
      float dInner = 1.0 + phaseG2 - 2.0 * phaseG * cosScat + 0.05;
      float denom = dInner * sqrt(dInner);
      float phase = oneMinusG2 / denom;
      colStep += paletteCore * (dustM * phase * scatterCoeff / rcs2);
    }

    // Beer-Lambert front-to-back composite + early-out once the
    // back of the volume can no longer contribute meaningfully.
    shellMask     += rhoStep * trans;
    shellColAccum += colStep * trans;
    trans *= exp(-rhoStep * 1.5);
    if (trans < 0.005) break;
  }

  if (shellMask > 0.001) shellColAccum /= shellMask;

  // ── Cavity glow + pulsar pinpoint ────────────────────────────
  // Inner halo follows the (possibly offset) pulsar position;
  // mid glow stays centred on the nebula origin.
  vec2  pulsarP = puv - pulsarOffset;
  float pulsarR = length(pulsarP);

  float innerHalo = exp(-pulsarR * pulsarR * 5.5)
                  * smoothstep(0.55, 0.0, pulsarR)
                  * innerHaloMul;
  float midGlow   = exp(-r * r * 1.5)
                  * smoothstep(1.10, 0.0, r)
                  * midGlowMul;
  vec3  glowCol   = mix(paletteGlow, v_c1, 0.25);

  float pulseT  = 0.92 + 0.08 * sin(u_time * pulsarPulseRate + v_seed);
  float pulsar  = exp(-pulsarR * pulsarR * pulsarFalloff)
                * pulseT * pulsarMul;
  vec3  pulsarCol = mix(paletteCore, v_c1, 0.25);

  shellColAccum = mix(shellColAccum, v_c1, 0.10);

  // Premultiplied composite.
  vec3 col = glowCol * (innerHalo * 0.45 + midGlow * 0.16)
           + pulsarCol * pulsar * pulsarBrightness
           + shellColAccum * shellMask * 1.40;
  float a = clamp(innerHalo * 0.35 + midGlow * 0.12
                  + pulsar + shellMask * 0.85, 0.0, 1.0);

  return vec4(col, a);
}

// ─────────────────────────────────────────────────────────────────────
// Shadertoy entry point
// ─────────────────────────────────────────────────────────────────────

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 res = iResolution.xy;
  // Centre the nebula on screen.
  vec2 loc = fragCoord - res * 0.5;

  vec4 nebula = renderNebula(loc, iTime);
  // Composite the premultiplied output over black background.
  fragColor = vec4(nebula.rgb, 1.0);
}
