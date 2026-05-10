// =====================================================================
// Azazel — Shadertoy port of ASTROCATCH renderer.js (isAzazel branch)
// =====================================================================
//
// Shadertoy:
//   Name:        Azazel
//   Description: A demon manifesting through a rip in space.
//                Jagged silhouette with radial spikes, three
//                drifting faces (paired triangular eyes above a
//                rhombus grin), red inner glow. Pure SDF.
//   Tags:        demon, rip, sdf
//   License:     MIT
//
//   Play the game:  https://astrocatch.live
//   Source code:    https://github.com/wistrand/astrocatch

const float PI  = 3.14159265;
const float TAU = 6.28318530;

// ── Tweakable parameters ──────────────────────────────────

// Per-instance seed. Drives noise warp, blobs, faces.
const float V_SEED = 7.31;
// Bounding radius (matches in-game v_baseR).
const float V_BASE_R = 64.0;

// Body silhouette — tilted elongated ellipse + plane-wave noise.
const float ASPECT_X        = 0.55;
const float ASPECT_Y        = 1.45;
const float TILT_ANGLE      = 0.30;   // ± radians per instance
const float BOUNDARY_AMP    = 0.16;
// Spikes: discrete tapered triangles around the body.
const int   N_SPIKES        = 14;
const float SPIKE_LEN_MIN   = 0.20;
const float SPIKE_LEN_MAX   = 0.85;
const float SPIKE_BASE_W    = 0.06;
const float SPIKE_PULSE_RATE = 0.40;
// Higher = spikes cluster perpendicular to the long axis.
const float SPIKE_ANGLE_STRETCH = 2.6;
// Sawtooth side profile.
const float SPIKE_TEETH     = 8.0;
const float SPIKE_TEETH_AMP = 0.45;
// Whole-rip breathing.
const float BREATHE_RATE    = 0.40;
const float BREATHE_AMP     = 0.32;
// Boundary-noise phase drift rates.
const float WRITHE_RATE_1   = 0.30;
const float WRITHE_RATE_2   = 0.50;
const float WRITHE_RATE_3   = 0.80;
const float WRITHE_RATE_4   = 1.25;
const float SMIN_K          = 0.18;
const float BLOB1_R         = 0.30;
const float BLOB2_R         = 0.26;

const vec3  INK_BLACK   = vec3(0.01, 0.01, 0.02);
const vec3  SPACE_BG    = vec3(0.04, 0.04, 0.07);
const vec3  STAR_COLOR  = vec3(0.92, 0.94, 1.00);
const vec3  INNER_GLOW       = vec3(0.20, 0.05, 0.05);
const float INNER_GLOW_FALLOFF = 5.0;
const float INNER_GLOW_AMP   = 1.10;
// Stand-in for in-game per-instance v_c1 (star palette colour).
const vec3  V_C1             = vec3(1.00, 0.85, 0.20);
const vec3  EYE_GLOW_TINT    = V_C1 * 0.78;
const vec3  EYE_IRIS_RED     = vec3(0.95, 0.10, 0.05);
const float EYE_IRIS_PROB    = 0.30;
const float EYE_IRIS_R       = 0.028;
const vec3  TOOTH_WHITE      = vec3(0.93, 0.88, 0.74);

// Interior starfield (now drawn outside the silhouette only).
const float STAR_DENSITY    = 14.0;
const float STAR_THRESHOLD  = 0.86;
const float STAR_RADIUS     = 0.020;

// Faces — N stacked tiers, each a paired-eye + grin.
// Note: uv.y is flipped at the top of mainImage so +y = down
// on screen. "Above" = negative offset, "below" = positive.
const int   N_FACES         = 3;
const float FACE_SPREAD_X   = 0.78;
const float FACE_SPREAD_Y   = 1.75;
const float FACE_TILT_RANGE = 0.55;   // ± rad whole-face tilt
const float FACE_MOTION_AMP = 0.10;   // xy drift world units
const float FACE_MOTION_RATE = 0.20;
const float FACE_SCALE_AMP  = 0.15;   // ± size pulse
const float FACE_SCALE_RATE = 0.20;
const float TIER_SPACING    = FACE_SPREAD_Y / float(N_FACES);
// Eye geometry (V_BASE_R units, face-local):
const float EYE_INNER_X     = 0.026;
const float EYE_OUTER_X     = 0.135;
const float EYE_HEIGHT      = 0.030;
const float EYE_Y_OFFSET    = -0.140;
const float EYE_BLINK_RATE  = 0.30;
const float EYE_GLOW_FALLOFF = 35.0;
const float EYE_TILT_RANGE  = 0.30;
const float EYE_INNER_TILT  = 0.42;   // per-eye inward sneer
const float EYE_BOW         = 0.88;   // edge inward arc
// Mouth — two rows with gap between, lower jaw narrower.
const float MOUTH_HALFW     = 0.13;
const float MOUTH_HALFH     = 0.110;
const float MOUTH_Y_OFFSET  = +0.085;
const float MOUTH_GAP_MIN   = -0.14;
const float MOUTH_GAP_MAX   = 0.04;
const float LOWER_W_RATIO   = 0.78;
const float TEETH_PER_MOUTH = 6.0;
const float MOUTH_OPEN_RATE = 0.40;
// Per-row parabolic jaw arc (positive bend curves toward gap).
const float JAW_BEND_RANGE  = 0.020;

// Camera.
const float CAM_SCALE = 1.0; // 1.0 = silhouette fits viewport tightly

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

float hash11(float x) {
  return fract(sin(x * 12.9898) * 43758.5453);
}
vec2 hash21(float x) {
  return vec2(
    fract(sin(x * 12.9898) * 43758.5453),
    fract(sin(x * 78.233 + 1.7) * 43758.5453)
  );
}
float hash12(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// Triangle wave, period 2π, range [-1, 1]. Sharper than sin.
float triWave(float x) {
  return abs(fract(x / TAU + 0.25) * 4.0 - 2.0) - 1.0;
}

// Boundary noise: 4 plane waves at irregular orientations,
// independent phase drifts. Triangle waves on the dominant
// terms give torn-paper zigzag; |sin|-cusp + fine smooth sin
// add detail.
float dirNoise(vec2 p, float seed, float t) {
  vec2 d1 = vec2( 0.71,  0.71);
  vec2 d2 = vec2( 0.83, -0.56);
  vec2 d3 = vec2( 0.50,  0.87);
  vec2 d4 = vec2(-0.95,  0.31);
  float p1 = hash11(seed * 1.0) * TAU + t * WRITHE_RATE_1;
  float p2 = hash11(seed * 2.0) * TAU + t * WRITHE_RATE_2;
  float p3 = hash11(seed * 3.0) * TAU + t * WRITHE_RATE_3;
  float p4 = hash11(seed * 4.0) * TAU + t * WRITHE_RATE_4;
  return 0.40 * triWave(dot(p, d1) * 18.0 + p1)
       + 0.30 * triWave(dot(p, d2) * 28.0 + p2)
       + 0.20 * (abs(sin(dot(p, d3) * 45.0 + p3)) * 2.0 - 1.0)
       + 0.15 * sin(dot(p, d4) * 70.0 + p4);
}

float sdBlob(vec2 p, vec2 c, float r) { return length(p - c) - r; }

// Tapered spike with sawtooth side modulation.
float sdTaperedSpike(vec2 p, vec2 base, vec2 tip, float wBase, float sawPhase) {
  vec2 ba = tip - base;
  vec2 pa = p - base;
  float L = max(dot(ba, ba), 1e-6);
  float h = clamp(dot(pa, ba) / L, 0.0, 1.0);
  vec2 q = pa - ba * h;
  float baseTaper = wBase * (1.0 - h);
  float saw = abs(fract(h * SPIKE_TEETH + sawPhase) * 2.0 - 1.0);
  float w = baseTaper * (1.0 - SPIKE_TEETH_AMP * (1.0 - saw));
  return length(q) - w;
}

// N radial spikes around the elliptical body, p in rotated frame.
// atan2(sin u, cos u * stretch) clusters angles toward ±x
// (perpendicular to the tilted long axis).
float sdSpikes(vec2 p, float seed, float t) {
  float d = 1e6;
  for (int i = 0; i < N_SPIKES; i++) {
    float fi = float(i);
    float u = (fi / float(N_SPIKES)) * TAU
            + (hash11(seed * 13.7 + fi) - 0.5) * 0.7;
    float ang = atan(sin(u), cos(u) * SPIKE_ANGLE_STRETCH);
    vec2 dir = vec2(cos(ang), sin(ang));
    vec2 basePt = dir * vec2(ASPECT_X, ASPECT_Y);
    float lenR = hash11(seed * 23.1 + fi);
    float len = mix(SPIKE_LEN_MIN, SPIKE_LEN_MAX, lenR);
    len *= 0.78 + 0.22 * sin(t * SPIKE_PULSE_RATE + fi * 2.71);
    float tipJitter = (hash11(seed * 31.7 + fi) - 0.5) * 0.50;
    vec2 tipDir = vec2(cos(ang + tipJitter), sin(ang + tipJitter));
    vec2 tipPt = basePt + tipDir * len;
    float baseW = SPIKE_BASE_W * (0.6 + 0.8 * hash11(seed * 41.3 + fi));
    float sawPhase = hash11(seed * 51.7 + fi);
    d = min(d, sdTaperedSpike(p, basePt, tipPt, baseW, sawPhase));
  }
  return d;
}

// Body silhouette: tilted ellipse + edge noise + spikes + blobs,
// all inside a uniform breath scale. Negative = inside the rip.
float sdRip(vec2 p, float seed, float t) {
  float breath = 1.0 + sin(t * BREATHE_RATE) * BREATHE_AMP;
  p /= breath;
  float tilt = (hash11(seed * 5.31) - 0.5) * 2.0 * TILT_ANGLE;
  float c = cos(tilt), s = sin(tilt);
  vec2 pr = mat2(c, -s, s, c) * p;
  vec2 q = pr / vec2(ASPECT_X, ASPECT_Y);
  float base = (length(q) - 1.0) * min(ASPECT_X, ASPECT_Y);
  // Bell-shape falloff: high-freq noise only roughens the edge
  // zone; keeps the body interior solid (no sign-change holes).
  // smoothstep zeroes edgeMask past |base|>=0.20, so the noise
  // contribution is provably zero outside the band — skip the
  // 4-wave dirNoise call entirely for deep-interior fragments.
  if (abs(base) < 0.20) {
    float edgeMask = 1.0 - smoothstep(0.0, 0.20, abs(base));
    base += BOUNDARY_AMP * dirNoise(p, seed, t) * edgeMask;
  }
  // Spike loop is the dominant cost at high zoom; gate it on
  // both sides: deep-interior (base < -0.20, can't improve
  // min) and far-outside (dot(pr,pr) > 5.76, past max spike
  // reach ≈ 2.36 = ellipse_axis + SPIKE_LEN_MAX + SPIKE_BASE_W).
  // Sign of base is preserved either way, and the outside
  // path only needs a correct sign before writing alpha=0.
  if (base >= -0.20 && dot(pr, pr) < 5.76) {
    base = min(base, sdSpikes(pr, seed, t));
  }
  vec2 b1Off = (hash21(seed * 11.7) - 0.5) * vec2(0.5, 1.4);
  vec2 b2Off = (hash21(seed * 23.1) - 0.5) * vec2(0.5, 1.4);
  base = smin(base, sdBlob(p, b1Off, BLOB1_R), SMIN_K);
  base = smin(base, sdBlob(p, b2Off, BLOB2_R), SMIN_K);
  return base * breath;
}

// Sparse cell-hash starfield (currently rendered outside the rip).
float starfield(vec2 p, float seed) {
  vec2 cell = floor(p * STAR_DENSITY);
  vec2 fp   = fract(p * STAR_DENSITY);
  float h = hash12(cell + seed);
  if (h < STAR_THRESHOLD) return 0.0;
  vec2 starOff = vec2(hash12(cell + 11.7), hash12(cell + 23.1))
               * 0.6 + 0.2;
  float dist = length(fp - starOff) / STAR_DENSITY;
  float bright = (h - STAR_THRESHOLD) / (1.0 - STAR_THRESHOLD);
  return smoothstep(STAR_RADIUS, 0.0, dist) * bright;
}

// IQ triangle SDF — proper signed distance.
float sdTriangleIq(vec2 p, vec2 a, vec2 b, vec2 c) {
  vec2 e0 = b - a, e1 = c - b, e2 = a - c;
  vec2 v0 = p - a, v1 = p - b, v2 = p - c;
  vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
  vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
  vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
  float s = sign(e0.x * e2.y - e0.y * e2.x);
  vec2 d = min(min(
    vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
    vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
    vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
  return -sqrt(d.x) * sign(d.y);
}

// Eye wedge: triangle with apex at apexX rotated by `tilt`
// around its centre, lp.y bowed by sin(π·axisFrac) so the
// slanted edges curve inward.
float sdEyeWedge(vec2 p, float apexX, float baseX, float h, float tilt) {
  vec2 eyeC = vec2((apexX + baseX) * 0.5, 0.0);
  float c = cos(tilt), s = sin(tilt);
  vec2 lp = mat2(c, -s, s, c) * (p - eyeC) + eyeC;
  float w = baseX - apexX;
  float axisFrac = clamp((lp.x - apexX) / w, 0.0, 1.0);
  lp.y *= 1.0 + EYE_BOW * sin(axisFrac * PI);
  return sdTriangleIq(
    lp, vec2(apexX, 0.0), vec2(baseX, h), vec2(baseX, -h)
  );
}

// Vertical rhombus tooth. Width: topFlat at y=0, wHalf at
// y=lenMid, 0 at y=lenTotal. Negative inside.
float sdRhombusTooth(vec2 p, float topFlat, float wHalf,
                     float lenMid, float lenTotal) {
  if (p.y < 0.0) return -p.y;
  if (p.y > lenTotal) return p.y - lenTotal;
  float w;
  if (p.y < lenMid) {
    w = mix(topFlat, wHalf, p.y / lenMid);
  } else {
    w = mix(wHalf, 0.0,
            (p.y - lenMid) / max(lenTotal - lenMid, 1e-4));
  }
  return abs(p.x) - w;
}

// Row-local coords: y=0 outer jaw boundary, y=effHalfH centre,
// y=effHalfH-halfGap tooth tip. `shape` selects the outer-curve
// form: +1 convex (regular ellipse, corners shrink), 0 flat,
// −1 concave (corners poke outward past the rest height).
float sdToothRowRhombus(vec2 p, float halfW, float effHalfH, float halfGap,
                       float shape, float nTeeth, float seed, float bend) {
  float d = 1e6;
  float cellW = 2.0 * halfW / nTeeth;
  float wHalfBase = cellW * 0.60;       // ~20 % overlap
  for (int i = 0; i < 12; i++) {
    float fi = float(i);
    if (fi >= nTeeth) break;
    float xc = -halfW + (fi + 0.5) * cellW;
    float xRel = xc / halfW;
    float jawOffset = bend * (1.0 - xRel * xRel);
    float symIdx = min(fi, nTeeth - 1.0 - fi);
    float sizeScale = 0.55 + 0.45 * hash11(seed + symIdx * 7.31);
    // 4th-order polynomial fit to arc(xRel)=sqrt(1-xRel²).
    // 1-arc ≈ 0.475·x² + 0.244·x⁴, factored as
    // x²·(0.475 + 0.244·x²). Matches the ellipse to <0.001
    // at every tooth column for nTeeth=6 — visually
    // indistinguishable, no sqrt needed.
    float x2 = xRel * xRel;
    float colHeight = effHalfH * (1.0 - shape * x2 * (0.475 + 0.244 * x2));
    float availLen = colHeight - halfGap;
    if (availLen <= 0.0) continue;
    float toothLen = availLen * sizeScale;
    float toothMid = toothLen * 0.50;
    float wHalf = wHalfBase * sqrt(sizeScale);
    float topFlat = wHalf * 0.40;
    float rootY = effHalfH - colHeight + jawOffset;
    vec2 lp = p - vec2(xc, rootY);
    d = min(d, sdRhombusTooth(lp, topFlat, wHalf, toothMid, toothLen));
  }
  return d;
}

// Two-row mouth: upper jaw at y < 0, lower jaw at y > 0, gap
// in between. Each jaw rolls its own outer-curve shape ∈
// [−1,+1] from the seed, so a face can pair a convex top with
// a concave bottom (or any mix). Vertical extent grows with
// positive halfGap so the lips stretch around the gap rather
// than teeth shrinking inside a rigid box.
float sdMouthRows(vec2 p, float halfW, float halfH,
                  float halfGap, float nTeeth, float seed) {
  // Shape range capped at ±0.6 — full ±1.0 lets corner teeth
  // collapse (convex) or stretch to 2× rest height (concave
  // fangs). Both extremes read as very fat curves, so dial
  // the amplitude back to keep variation subtle.
  float upperShape = (hash11(seed * 31.5) - 0.5) * 1.2;
  float lowerShape = (hash11(seed * 41.7) - 0.5) * 1.2;
  float effHalfH = halfH + max(halfGap, 0.0);
  // Cheap rect bbox early-reject. Concave-shape rolls extend
  // corner teeth outward, so cap is sized to the larger jaw.
  // The visible mouth silhouette is drawn downstream by the
  // per-tooth scan — the cap only saves work for far fragments,
  // no visual impact from keeping it rectangular.
  float capH = effHalfH * max(1.0, max(1.0 - upperShape, 1.0 - lowerShape));
  vec2 bbox = abs(p) - vec2(halfW, capH);
  float bboxOut = max(bbox.x, bbox.y);
  if (bboxOut > 0.0) return bboxOut;
  float yAbs = abs(p.y);
  if (yAbs < halfGap) return halfGap - yAbs;          // gap
  // Independent per-row arc curvatures.
  float upperBend = (hash11(seed * 17.7) - 0.5) * 2.0 * JAW_BEND_RANGE;
  float lowerBend = (hash11(seed * 23.1) - 0.5) * 2.0 * JAW_BEND_RANGE;
  if (p.y < 0.0) {
    return sdToothRowRhombus(vec2(p.x, p.y + effHalfH),
                             halfW, effHalfH, halfGap, upperShape,
                             nTeeth, seed, upperBend);
  }
  // Lower row: y-flip + narrower halfW (horseshoe jaw). Same
  // seed → mirror-symmetric tooth lengths across the gap.
  return sdToothRowRhombus(vec2(p.x, effHalfH - p.y),
                           halfW * LOWER_W_RATIO, effHalfH, halfGap, lowerShape,
                           nTeeth, seed, lowerBend);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  // World coords centred on screen, y-flipped so +y is down
  // (matches the in-game +Y-down convention).
  vec2 res = iResolution.xy;
  vec2 uv = (fragCoord - 0.5 * res) / min(res.x, res.y) * 2.0 / CAM_SCALE;
  uv.y = -uv.y;

  float d = sdRip(uv, V_SEED, iTime);
  vec3 col;
  if (d < 0.0) {
    // Inside: black void + soft red inner glow + face tiers.
    col = INK_BLACK;
    float innerDepth = -d;
    col += INNER_GLOW * exp(-innerDepth * INNER_GLOW_FALLOFF) * INNER_GLOW_AMP;
    // Face features fade in over the same falloff as the inner
    // glow but inverted — eyes and teeth dissolve into the glow
    // band near the rip border instead of clipping against it.
    float faceMask = 1.0 - exp(-innerDepth * INNER_GLOW_FALLOFF);
    // N face tiers stacked vertically — deterministic Y so they
    // can't overlap, hash-jittered X. Tier height = SPREAD_Y/N.
    for (int i = 0; i < N_FACES; i++) {
      float fi = float(i);
      float tierY = (fi - float(N_FACES - 1) * 0.5) * TIER_SPACING;
      vec2 facePos = vec2(
        (hash11(V_SEED * 53.0 + fi * 23.7) - 0.5) * FACE_SPREAD_X,
        tierY + (hash11(V_SEED * 91.3 + fi * 47.1) - 0.5) * 0.04
      );
      float blinkPhase = sin(iTime * EYE_BLINK_RATE + fi * 1.7);
      float openPhase  = sin(iTime * MOUTH_OPEN_RATE + fi * 2.3);
      float faceAng = (hash11(V_SEED * 87.3 + fi) - 0.5) * FACE_TILT_RANGE;
      float fc = cos(faceAng), fs = sin(faceAng);
      mat2 faceRot = mat2(fc, -fs, fs, fc);
      // Independent xy drift + size pulse phases.
      float mxPhase = hash11(V_SEED * 71.3 + fi) * TAU;
      float myPhase = hash11(V_SEED * 79.7 + fi) * TAU;
      float sPhase  = hash11(V_SEED * 83.1 + fi) * TAU;
      vec2 motion = vec2(
        sin(iTime * FACE_MOTION_RATE       + mxPhase),
        sin(iTime * FACE_MOTION_RATE * 0.8 + myPhase)
      ) * FACE_MOTION_AMP;
      float faceScale = 1.0 + FACE_SCALE_AMP
                            * sin(iTime * FACE_SCALE_RATE + sPhase);
      // Rotation, then scale: feature offsets ride on the
      // face's tilted vertical axis at face-scaled radii.
      vec2 fp = faceRot * (uv - facePos - motion) / faceScale;

      // Eye pair — gated on blink > 0.02 so the triangle never
      // collapses to a line (sdTriangleIq divides by zero there).
      float blink = 1.0 - pow(max(0.0, blinkPhase), 12.0);
      if (blink > 0.02) {
        float h = EYE_HEIGHT * blink;
        vec2 eyeP = fp - vec2(0.0, EYE_Y_OFFSET);
        float lEyeD = sdEyeWedge(eyeP, -EYE_INNER_X, -EYE_OUTER_X, h, +EYE_INNER_TILT);
        float rEyeD = sdEyeWedge(eyeP, +EYE_INNER_X, +EYE_OUTER_X, h, -EYE_INNER_TILT);
        float eD = min(lEyeD, rEyeD);
        float glow = exp(-max(eD, 0.0) * EYE_GLOW_FALLOFF) * 0.35;
        col += EYE_GLOW_TINT * glow * faceMask;
        if (eD < 0.0) col = mix(col, V_C1, faceMask);
        if (hash11(V_SEED * 211.7 + fi) < EYE_IRIS_PROB) {
          vec2 lEyeC = vec2((-EYE_INNER_X + -EYE_OUTER_X) * 0.5, 0.0);
          vec2 rEyeC = vec2((+EYE_INNER_X + +EYE_OUTER_X) * 0.5, 0.0);
          float lIrisD = length(eyeP - lEyeC) - EYE_IRIS_R;
          float rIrisD = length(eyeP - rEyeC) - EYE_IRIS_R;
          if ((lIrisD < 0.0 && lEyeD < 0.0)
           || (rIrisD < 0.0 && rEyeD < 0.0)) col = mix(col, EYE_IRIS_RED, faceMask);
        }
      }

      // Mouth — two rows with animated gap.
      vec2 mp = fp - vec2(0.0, MOUTH_Y_OFFSET);
      float gapBase = mix(MOUTH_GAP_MIN, MOUTH_GAP_MAX,
                          hash11(V_SEED * 167.0 + fi));
      // Full close-to-open chomp: 0 at one phase extreme,
      // gapBase at the other. Negative-gapBase faces stay
      // visually closed; positive-gapBase ones swing through
      // the entire visible range.
      float halfGap = gapBase * (0.5 + 0.5 * openPhase);
      float mSeed = V_SEED * 200.0 + fi * 13.0;
      float mD = sdMouthRows(mp, MOUTH_HALFW, MOUTH_HALFH,
                             halfGap, TEETH_PER_MOUTH, mSeed);
      if (mD < 0.0) col = mix(col, TOOTH_WHITE, faceMask);
    }
  } else {
    // In-game: this is the transparency area, real starfield
    // shows through. Prototype renders dark space + stars.
    col = SPACE_BG;
    col += STAR_COLOR * starfield(uv, V_SEED * 1.7);
  }

  fragColor = vec4(col, 1.0);
}
