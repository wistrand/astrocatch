// =====================================================================
// Nebula — Shadertoy port of ASTROCATCH renderer.js (isNebula branch)
// =====================================================================
//
// Shadertoy:
//   Name:        Volumetric supernova-remnant nebula
//   Description: 5-shell ray-march with simplex/value-noise FBM,
//                palette categorical, per-shell edge masks, optional
//                Bezier-tube filamentary morphology, pulsar pinpoint
//                with halo + mid-glow. Drag mouse to rotate in 3D.
//                Ported from astrocatch.live.
//   Tags:        nebula, volumetric, raymarch, fbm
//   License:     MIT
//
//   ▶ Play the game:  https://astrocatch.live
//   ▶ Source code:    https://github.com/wistrand/astrocatch
//
// Self-contained re-implementation of the procedural nebula shader
// from docs/renderer.js. Algorithm preserved verbatim:
// 5-shell volumetric integration with front-to-back transmittance,
// simplex / value-noise FBM, palette categorical, per-shell edge
// masks (Design A), pulsar pinpoint with halo + mid-glow, optional
// quadratic-Bezier filamentary morphology.
//
// All tweakable knobs are exposed as `const` declarations at the top —
// change them and re-press Compile to roll a new look.
//
// Cost: heavy. 7-step volumetric ray-march × ~15 noise evaluations per
// step. ~3000 ALU/fragment ellipsoidal, ~4500 ALU/fragment filamentary.
// Disable the filamentary morph if perf matters.

const float PI  = 3.14159265;
const float TAU = 6.28318530;

// ─────────────────────────────────────────────────────────────────────
// Tweakable parameters
// ─────────────────────────────────────────────────────────────────────

// Master noise seed. Drives sample offsets, per-shell jitter patterns,
// and randomized per-nebula component directions (bipolar pole axis,
// filament bend direction, pulsar offset hash, etc.). Change to roll
// a new pattern.
const float NEBULA_SEED = 142.0;

// Palette class:
//   0 = Crab synchrotron  (cyan / yellow / orange / red / red)
//   1 = Helix OIII        (green / cyan / pale / soft red / dim red)
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
// S-curve.  Only used when IS_FILAMENT.  Bend DIRECTION is derived
// from NEBULA_SEED for chaos.
const float FILAMENT_BEND_AMP = 1.10;

// Nebula screen radius in pixels.  v_baseR equivalent — the unit of
// every distance in the algorithm. The nebula visibly extends to
// roughly 3.0 × this radius.
const float V_BASE_R = 120.0;

// Per-pulsar palette tint (the v_c1 equivalent in the renderer).
// Mostly modulates pulsar pinpoint and the 10 % shell-color tint.
const vec3 V_C1 = vec3(0.55, 0.85, 1.00);

// ─────────────────────────────────────────────────────────────────────
// Noise helpers (verbatim from renderer.js)
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
vec3 cPermute(vec3 x) { return cMod289(((x * 34.0) + 1.0) * x); }
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

// 3-octave simplex FBM (cheap, used heavily in the volumetric loop).
float fbm3octN(vec2 p) {
  return 0.65 * snoiseN(p)
       + 0.32 * snoiseN(p * 2.07)
       + 0.16 * snoiseN(p * 4.28);
}

// "Fake 3D" simplex FBM via three orthogonal 2D projections.  Cheap
// way to get distinct values at different z without a true 3D
// simplex implementation.
float fbm3DN(vec3 p) {
  return (fbm3octN(p.xy)
       +  fbm3octN(p.xz + vec2(11.0,  7.0))
       +  fbm3octN(p.yz + vec2(13.0, 17.0))) * (1.0 / 3.0);
}

// ─────────────────────────────────────────────────────────────────────
// Nebula renderer
// ─────────────────────────────────────────────────────────────────────

vec4 renderNebula(vec2 loc, float u_time, mat3 rotMat) {
  float v_baseR = V_BASE_R;
  float v_seed  = NEBULA_SEED;
  vec3  v_c1    = V_C1;

  float d = length(loc);
  float r = d / max(v_baseR, 1.0);
  vec2  puv = loc / max(v_baseR, 1.0);
  vec2  seedOff  = vec2(v_seed * 7.3, v_seed * 11.7);
  vec3  seedOff3 = vec3(seedOff, v_seed * 5.1);

  // Slow Lissajous flow through the FBM domain.  Boils over minutes.
  vec3 flow = vec3(sin(u_time * 0.01 + v_seed),
                   cos(u_time * 0.02 + v_seed * 1.3),
                   sin(u_time * 0.03 + v_seed * 2.1)) * 2.0;
  float fbmScale = 0.55;

  // ── Palette dispatch ──────────────────────────────────────────
  vec3  shell0Col, shell1Col, shell2Col, shell3Col, shell4Col;
  vec3  paletteGlow, paletteCore;
  float w0, w1, w2, w3, w4;
  float pulsarFalloff, pulsarPulseRate, pulsarBrightness;
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
  } else if (PALETTE_IDX == 1) {
    shell0Col = vec3(0.40, 0.90, 0.55);
    shell1Col = vec3(0.50, 0.95, 0.85);
    shell2Col = vec3(0.92, 0.98, 0.78);
    shell3Col = vec3(0.95, 0.55, 0.45);
    shell4Col = vec3(0.78, 0.30, 0.30);
    paletteGlow = vec3(0.55, 0.95, 0.85);
    paletteCore = vec3(0.75, 1.00, 0.85);
    w0 = 0.30; w1 = 0.25; w2 = 0.18; w3 = 0.12; w4 = 0.08;
    pulsarFalloff = 150.0;
    pulsarPulseRate = 4.50;
    pulsarBrightness = 1.30;
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
  }
  w0 *= DENSITY_MULT; w1 *= DENSITY_MULT; w2 *= DENSITY_MULT;
  w3 *= DENSITY_MULT; w4 *= DENSITY_MULT;

  float pulsarMul    = (CENTRAL_FLAVOUR == 1) ? 0.0 : 1.0;
  float innerHaloMul = FILL_MULT;
  float midGlowMul   = FILL_MULT;

  vec2 pulsarOffset = (CENTRAL_FLAVOUR == 2) ? PULSAR_OFFSET : vec2(0.0);

  // ── Ellipse setup ─────────────────────────────────────────────
  float ecc = ECC;
  float ang = ANG;
  float cosA = cos(ang), sinA = sin(ang);
  float majA = 1.0 + ecc;
  float minA = 1.0 - ecc;
  vec2 rotLocN = vec2(loc.x * cosA + loc.y * sinA,
                     -loc.x * sinA + loc.y * cosA)
               / max(v_baseR, 1.0);
  float xN = rotLocN.x / majA;
  float yN = rotLocN.y / minA;
  float xy_term = xN * xN + yN * yN;

  // ── Bipolar setup (3D pole axis + screen-anchored jitter) ────
  // poleDir is 3D so it rotates with the world-space sample point.
  // waistJitter / lobeFBM stay screen-anchored — applied per-step
  // as additive contributions to the rotated biPolarBase.
  float poleAng = v_seed * 1.7 + 0.3;
  vec3  poleDir = vec3(cos(poleAng), sin(poleAng), 0.0);
  float waistJitter = 0.18 * snoiseN(loc * (0.7 / max(v_baseR, 1.0))
                                      + seedOff + flow.xy);
  float lobeFBM = fbm3DN(vec3(rotLocN * 0.45 + seedOff
                                + vec2(57.0, 73.0), v_seed * 11.0));

  // High-freq warp — adds wisps-inside-wisps detail.
  vec2 hiWarp = vec2(
    snoiseN(rotLocN * 5.0 + seedOff),
    snoiseN(rotLocN * 5.0 + seedOff + vec2(11.0, 7.0))
  ) * 0.07;

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
  float ridgedSample = ridgedFBMN(loc * fibreFreq / v_baseR
                                   + seedOff * 0.7);
  float ridgedEdge = pow(clamp(ridgedSample, 0.0, 1.0), FIBRE_POW);
  float smoothSample = vnoiseN(loc * (fibreFreq * 0.55) / v_baseR
                                + seedOff * 0.7 + vec2(13.7, 7.3));
  float smoothEdge = smoothstep(0.25, 0.75, smoothSample);

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
    // 3D camera-space sample point, then rotated into world space
    // by the mouse-driven rotation matrix. Subsequent operations
    // (FBM sample, ellipsoid r3D, bipolar projection) all use the
    // rotated world position.
    vec3 pCam   = vec3(puv + hiWarp, zStep);
    vec3 pWorld = rotMat * pCam;
    vec3 p3 = pWorld * fbmScale + seedOff3 + flow;
    float fbm = fbm3DN(p3);

    // Per-step bipolar: project the rotated world position onto a
    // 3D pole axis, then apply the cigar-shape bias. The pole
    // direction stays in world frame, so as the user rotates with
    // the mouse, the bipolar pinch axis stays anchored to the
    // nebula's structure (rotates visibly).
    float pLen = length(pWorld);
    float dirAlongPole = pLen > 0.001
      ? dot(pWorld, poleDir) / pLen : 0.0;
    float biPolarBase = -BIPOLAR_AMP * (dirAlongPole * dirAlongPole - 0.40);
    float lobeAsymThis = LOBE_ASYM_AMP * lobeFBM * step(0.0, dirAlongPole);
    float biPolar = biPolarBase + waistJitter + lobeAsymThis;

    float r3D;
    float field;
    if (IS_FILAMENT) {
      // Closest point on quadratic Bezier — 12 samples + 2 Newton
      // iterations. Searches in WORLD space so the filament
      // rotates with the mouse.
      vec3 pos3 = pWorld;
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
      // Ellipsoidal r3D in WORLD frame. Apply the ellipse's local
      // 2D rotation (ANG) and per-axis scaling to pWorld.xy / .z.
      vec2 rotXY = vec2(pWorld.x * cosA + pWorld.y * sinA,
                       -pWorld.x * sinA + pWorld.y * cosA);
      float xN = rotXY.x / majA;
      float yN = rotXY.y / minA;
      float zScaled = pWorld.z / minA;
      r3D = sqrt(xN * xN + yN * yN + zScaled * zScaled);
      // Bipolar bias faded to zero inside the cavity.
      float bpFade = smoothstep(0.6, 1.3, r3D);
      field = r3D + 0.75 * fbm + biPolar * bpFade;
    }

    // Per-step shock mask + radial saturation curve.
    float shockMask = ridgedFBMN(rotLocN * 2.5
                                  + seedOff + flow.xy * 0.5);
    shockMask = pow(clamp(shockMask, 0.0, 1.0), 1.6);
    float shockBrighten = 1.0 + 0.55 * smoothstep(0.55, 0.85, shockMask);
    float satF = mix(1.25, 0.80, smoothstep(0.5, 2.5, r3D));

    float rhoStep = 0.0;
    vec3  colStep = vec3(0.0);

    // Shell 0 — innermost, intrinsic softness 0.0
    {
      float jit = 0.10 * snoiseN(rotLocN * 0.8 + seedOff
                                  + vec2(0.0, 0.0));
      float dF = field - (1.50 * CAVITY_SIZE + jit);
      float m = exp(-dF * dF / 0.0036);
      if (dF > 0.0) m *= mix(1.0, 0.18, smoothstep(0.0, 0.06, dF));
      float es = clamp(0.0 + STRAT_OFFSET, 0.0, 1.0);
      float edge = mix(ridgedEdge, smoothEdge, es);
      float fl = mix(FIBRE_FLOOR, FIBRE_FLOOR + 0.30, es);
      float gn = mix(FIBRE_GAIN * AESTHETIC_FIBRE_GAIN,
                     FIBRE_GAIN * AESTHETIC_FIBRE_GAIN * 0.5, es);
      m *= fl + gn * edge;
      vec3 shellC = shell0Col * shockBrighten;
      float satFShell0 = min(satF, 1.05);
      float luma = dot(shellC, vec3(0.299, 0.587, 0.114));
      shellC = mix(vec3(luma), shellC, satFShell0);
      rhoStep += m * w0;
      colStep += shellC * m * w0;
    }
    // Shell 1 — softness 0.25
    {
      float jit = 0.10 * snoiseN(rotLocN * 0.8 + seedOff
                                  + vec2(7.3, 11.0));
      float dF = field - (1.77 * CAVITY_SIZE + jit);
      float m = exp(-dF * dF / 0.0049);
      if (dF > 0.0) m *= mix(1.0, 0.22, smoothstep(0.0, 0.07, dF));
      float es = clamp(0.25 + STRAT_OFFSET, 0.0, 1.0);
      float edge = mix(ridgedEdge, smoothEdge, es);
      float fl = mix(FIBRE_FLOOR, FIBRE_FLOOR + 0.30, es);
      float gn = mix(FIBRE_GAIN * AESTHETIC_FIBRE_GAIN,
                     FIBRE_GAIN * AESTHETIC_FIBRE_GAIN * 0.5, es);
      m *= fl + gn * edge;
      vec3 shellC = shell1Col * shockBrighten;
      float luma = dot(shellC, vec3(0.299, 0.587, 0.114));
      shellC = mix(vec3(luma), shellC, satF);
      rhoStep += m * w1;
      colStep += shellC * m * w1;
    }
    // Shell 2 — softness 0.50
    {
      float jit = 0.10 * snoiseN(rotLocN * 0.8 + seedOff
                                  + vec2(13.0, 5.7));
      float dF = field - (1.97 * CAVITY_SIZE + jit);
      float m = exp(-dF * dF / 0.0064);
      if (dF > 0.0) m *= mix(1.0, 0.26, smoothstep(0.0, 0.08, dF));
      float es = clamp(0.50 + STRAT_OFFSET, 0.0, 1.0);
      float edge = mix(ridgedEdge, smoothEdge, es);
      float fl = mix(FIBRE_FLOOR, FIBRE_FLOOR + 0.30, es);
      float gn = mix(FIBRE_GAIN * AESTHETIC_FIBRE_GAIN,
                     FIBRE_GAIN * AESTHETIC_FIBRE_GAIN * 0.5, es);
      m *= fl + gn * edge;
      vec3 shellC = shell2Col * shockBrighten;
      float luma = dot(shellC, vec3(0.299, 0.587, 0.114));
      shellC = mix(vec3(luma), shellC, satF);
      rhoStep += m * w2;
      colStep += shellC * m * w2;
    }
    // Shell 3 — softness 0.75
    {
      float jit = 0.10 * snoiseN(rotLocN * 0.8 + seedOff
                                  + vec2(23.0, 17.0));
      float dF = field - (2.29 * CAVITY_SIZE + jit);
      float m = exp(-dF * dF / 0.0100);
      if (dF > 0.0) m *= mix(1.0, 0.32, smoothstep(0.0, 0.10, dF));
      float es = clamp(0.75 + STRAT_OFFSET, 0.0, 1.0);
      float edge = mix(ridgedEdge, smoothEdge, es);
      float fl = mix(FIBRE_FLOOR, FIBRE_FLOOR + 0.30, es);
      float gn = mix(FIBRE_GAIN * AESTHETIC_FIBRE_GAIN,
                     FIBRE_GAIN * AESTHETIC_FIBRE_GAIN * 0.5, es);
      m *= fl + gn * edge;
      vec3 shellC = shell3Col * shockBrighten;
      float luma = dot(shellC, vec3(0.299, 0.587, 0.114));
      shellC = mix(vec3(luma), shellC, satF);
      rhoStep += m * w3;
      colStep += shellC * m * w3;
    }
    // Shell 4 — softness 1.0 (fully soft)
    {
      float jit = 0.10 * snoiseN(rotLocN * 0.8 + seedOff
                                  + vec2(31.0, 41.0));
      float dF = field - (2.59 * CAVITY_SIZE + jit);
      float m = exp(-dF * dF / 0.0169);
      if (dF > 0.0) m *= mix(1.0, 0.40, smoothstep(0.0, 0.13, dF));
      float es = clamp(1.0 + STRAT_OFFSET, 0.0, 1.0);
      float edge = mix(ridgedEdge, smoothEdge, es);
      float fl = mix(FIBRE_FLOOR, FIBRE_FLOOR + 0.30, es);
      float gn = mix(FIBRE_GAIN * AESTHETIC_FIBRE_GAIN,
                     FIBRE_GAIN * AESTHETIC_FIBRE_GAIN * 0.5, es);
      m *= fl + gn * edge;
      vec3 shellC = shell4Col * shockBrighten;
      float luma = dot(shellC, vec3(0.299, 0.587, 0.114));
      shellC = mix(vec3(luma), shellC, satF);
      rhoStep += m * w4;
      colStep += shellC * m * w4;
    }

    // Beer-Lambert front-to-back composite.
    shellMask     += rhoStep * trans;
    shellColAccum += colStep * trans;
    trans *= exp(-rhoStep * 1.5);
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

  // 3D mouse rotation. Drag horizontally → yaw around Y axis;
  // drag vertically → pitch around X axis. iMouse defaults to
  // (0, 0) before the first click so the initial view is unrotated
  // (rotMat = identity).
  float yaw = 0.0;
  float pitch = 0.0;
  if (iMouse.x > 0.0 || iMouse.y > 0.0) {
    yaw   = (iMouse.x / res.x - 0.5) * TAU;
    pitch = (iMouse.y / res.y - 0.5) * PI;
  }
  float cy = cos(yaw),   sy = sin(yaw);
  float cp = cos(pitch), sp = sin(pitch);
  // R = Rx(pitch) * Ry(yaw). Columns of R for GLSL mat3 ctor:
  mat3 rotMat = mat3(
    vec3(cy,    sp * sy,   -cp * sy),  // col 0
    vec3(0.0,   cp,         sp),       // col 1
    vec3(sy,    -sp * cy,   cp * cy)   // col 2
  );

  vec4 nebula = renderNebula(loc, iTime, rotMat);
  // Composite the premultiplied output over black background.
  fragColor = vec4(nebula.rgb, 1.0);
}
