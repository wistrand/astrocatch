// =====================================================================
// Russell's china teapot — Shadertoy port of ASTROCATCH renderer.js (isTeapot branch)
// =====================================================================
//
// Shadertoy:
//   Name:        Russell's china teapot
//   Description: Tumbling blue-and-white china teapot in space. SDF
//                raymarch (body / lid / spout / handle), procedural
//                cobalt-on-porcelain pattern, glossy ceramic
//                specular, dim rim. Per Russell (1952), the orbit
//                between Earth and Mars contains a tiny teapot too
//                small to be seen by our most powerful telescopes.
//                This is not that teapot.
//   Tags:        teapot, sdf, raymarch, china
//   License:     MIT
//
//   Play the game:  https://astrocatch.live
//   Source code:    https://github.com/wistrand/astrocatch

const float PI  = 3.14159265;
const float TAU = 6.28318530;

// ─────────────────────────────────────────────────────────────────────
// Tweakable parameters
// ─────────────────────────────────────────────────────────────────────

// Tumble rate (radians/sec). 0.20 ≈ one revolution every 31 seconds.
const float TUMBLE_RATE = 0.20;
// Per-teapot tumble axis seed (drives the random axis direction).
const float TEAPOT_SEED = 1.7;

// Lighting. KEY_DIR is recomputed in mainImage so the highlight
// slowly precesses around the y-axis at KEY_PRECESS_RATE rad/s
// — gives the glaze a "sun moving across the sky" feel
// independent of the teapot's tumble. FILL_DIR stays fixed
// (represents diffuse environment bounce, no rotation).
const float KEY_PRECESS_RATE = 0.10;
const float KEY_TILT         = 0.8;   // y-component of the unit
                                        // vector — height of the
                                        // sun above the horizon.
const vec3  FILL_DIR         = normalize(vec3(-0.4, 0.2, 0.8));
const vec3  AMBIENT      = vec3(0.50, 0.5, 0.5);
const float SPECULAR_POW = 64.0;
const float SPECULAR_AMP = 0.35;
const vec3  RIM_TINT     = vec3(0.55, 0.65, 0.85);
const float RIM_POW      = 3.0;
const float RIM_AMP      = 0.35;

// China pattern colours and threshold.
const vec3  PORCELAIN          = vec3(0.97, 0.95, 0.90);
const vec3  COBALT             = vec3(0.05, 0.10, 0.55);
const float PATTERN_THRESHOLD  = 0.60;
const float PATTERN_SHARPNESS  = 0.3;

// Camera.
const float CAM_DIST = 3.5;

// Raymarch.
const int   MAX_STEPS = 48;
const float MAX_DIST  = 8.0;
const float HIT_EPS   = 0.001;

// Background star grid size.
const float STAR_GRID = 35.0;

// ─────────────────────────────────────────────────────────────────────
// Hash + value-noise helpers (used for the china pattern + backdrop)
// ─────────────────────────────────────────────────────────────────────

float vhash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = vhash(i);
  float b = vhash(i + vec2(1.0, 0.0));
  float c = vhash(i + vec2(0.0, 1.0));
  float d = vhash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm2D(vec2 p) {
  float t = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    t += vnoise(p) * amp;
    p *= 2.07;
    amp *= 0.55;
  }
  return t;
}

// 3D versions — used for the china pattern so it varies smoothly
// across the teapot surface in 3D, with no cylindrical-UV seam at
// the back where atan(z, x) wraps. Trilinear interp over 8 hashed
// corners; 4-octave FBM stack.
float vhash3(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float vnoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float c000 = vhash3(i);
  float c100 = vhash3(i + vec3(1.0, 0.0, 0.0));
  float c010 = vhash3(i + vec3(0.0, 1.0, 0.0));
  float c110 = vhash3(i + vec3(1.0, 1.0, 0.0));
  float c001 = vhash3(i + vec3(0.0, 0.0, 1.0));
  float c101 = vhash3(i + vec3(1.0, 0.0, 1.0));
  float c011 = vhash3(i + vec3(0.0, 1.0, 1.0));
  float c111 = vhash3(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(c000, c100, f.x), mix(c010, c110, f.x), f.y),
    mix(mix(c001, c101, f.x), mix(c011, c111, f.x), f.y),
    f.z);
}

float fbm3D(vec3 p) {
  float t = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    t += vnoise3(p) * amp;
    p *= 2.07;
    amp *= 0.55;
  }
  return t;
}

// ─────────────────────────────────────────────────────────────────────
// SDF helpers
// ─────────────────────────────────────────────────────────────────────

// Smooth minimum (iq's polynomial form).
float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

float sdSphere(vec3 p, float r) { return length(p) - r; }

// Imperfect ellipsoid SDF (iq). Not a true distance but close
// enough for raymarching with conservative steps.
float sdEllipsoid(vec3 p, vec3 r) {
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / k1;
}

float sdTorus(vec3 p, vec2 t) {
  vec2 q = vec2(length(p.xz) - t.x, p.y);
  return length(q) - t.y;
}

// Quadratic Bezier tube SDF — 6-sample coarse search + 2-Newton
// refines. The teapot spout is a single moderate arc with no
// multiple local minima against any view ray, so 6 samples suffice
// to land Newton in the right basin. Saves ~70 ALU per SDF call
// vs the 12-sample version the nebula filament path uses (which
// needs the extra samples because high bend amplitudes there can
// produce up to 3 local minima against a viewing ray).
float sdBezierTube(vec3 p, vec3 P0, vec3 P1, vec3 P2,
                   float thickBase, float thickTip) {
  float bestT = 0.5, bestD2 = 1e9;
  for (int i = 0; i < 6; i++) {
    float t = (float(i) + 0.5) / 6.0;
    float u = 1.0 - t;
    vec3 onC = u * u * P0 + 2.0 * u * t * P1 + t * t * P2;
    float d2 = dot(p - onC, p - onC);
    if (d2 < bestD2) { bestD2 = d2; bestT = t; }
  }
  // d2C is constant per Bezier curve — independent of bestT.
  // Hoisting frees 3 registers inside the Newton loop body and
  // saves the recompute (6 muls + 2 subs) on each iteration.
  vec3 d2C = 2.0 * P0 - 4.0 * P1 + 2.0 * P2;
  for (int i = 0; i < 2; i++) {
    float u = 1.0 - bestT;
    vec3 onC = u * u * P0
             + 2.0 * u * bestT * P1
             + bestT * bestT * P2;
    vec3 dC = -2.0 * u * P0
            + 2.0 * (1.0 - 2.0 * bestT) * P1
            + 2.0 * bestT * P2;
    vec3 diff = p - onC;
    float f  = dot(diff, dC);
    float fp = -dot(dC, dC) + dot(diff, d2C);
    if (abs(fp) > 1e-5) bestT = clamp(bestT - f / fp, 0.0, 1.0);
  }
  float u = 1.0 - bestT;
  vec3 onCurve = u * u * P0
               + 2.0 * u * bestT * P1
               + bestT * bestT * P2;
  float thickness = mix(thickBase, thickTip, bestT);
  return distance(p, onCurve) - thickness;
}

// ─────────────────────────────────────────────────────────────────────
// Teapot SDF — union of body / shoulder / lid / knob / spout / handle
// ─────────────────────────────────────────────────────────────────────

float sdTeapot(vec3 p) {
  // Bounding-sphere early-out. The teapot fits inside a sphere
  // of radius ~1.7 around the origin (body radius 1.0 + spout
  // reach 1.45 + handle/lid extents ≈ 1.7). When the ray is
  // comfortably outside that sphere, return the bound directly
  // and skip the full primitive union — the marcher takes long
  // strides through empty space at ~5 ALU/step instead of ~250.
  // 0.30 margin so the bound stays an honest under-estimate of
  // true distance to the smin-blended surface.
  float bound = length(p) - 1.7;
  if (bound > 0.30) return bound;
  // Body: oblate spheroid widest at the equator. Newell's teapot
  // is wider in the lower half than the lid, so we squash y by 0.6.
  float bodyLower = sdEllipsoid(p, vec3(1.00, 0.60, 1.00));
  // Shoulder: smaller spheroid above the equator giving the
  // characteristic "tapers toward the lid" silhouette.
  float bodyUpper = sdEllipsoid(p - vec3(0.0, 0.50, 0.0),
                                 vec3(0.65, 0.20, 0.65));
  float body = smin(bodyLower, bodyUpper, 0.10);
  // Flat bottom: clip the body at y = -0.55 so the teapot has a
  // foot to sit on (radius ~0.40 at the cut). Smooth-max via the
  // -smin(-a, -b, k) identity gives a soft fillet at the side-to-
  // base transition rather than a hard corner — porcelain has a
  // small radius there, not a knife edge.
  body = -smin(-body, p.y + 0.55, 0.04);
  // Lid: flatter cap. Sits on top of the shoulder; smin blends
  // the seam so it looks like a single ceramic surface.
  float lid = sdEllipsoid(p - vec3(0.0, 0.66, 0.0),
                           vec3(0.50, 0.10, 0.50));
  // Knob: small sphere on top of the lid.
  float knob = sdSphere(p - vec3(0.0, 0.80, 0.0), 0.10);
  // Spout: curved tapering tube extending from the body's +x side
  // up and out. Bezier control points define an arc; thickness
  // tapers along t (fat at the body, narrow at the tip).
  float spout = sdBezierTube(p,
    vec3(0.85, 0.05, 0.0),  // P0 — body attachment
    vec3(1.25, 0.30, 0.0),  // P1 — bend
    vec3(1.45, 0.60, 0.0),  // P2 — tip
    0.18, 0.05);
  // Handle: smaller, vertically elongated half-torus on the
  // body's -x side. Custom elliptical-torus SDF: ring in the
  // xy plane (axis along world Z so the camera sees it face-on)
  // with semi-axes (rX, rY) — taller than wide for the classic
  // teapot D-loop silhouette. Inline rather than scaling a
  // standard torus so the SDF stays an honest distance.
  vec3 hp = p - vec3(-0.92, 0.32, 0.0);
  const float HANDLE_RX   = 0.18;
  const float HANDLE_RY   = 0.30;
  const float HANDLE_TUBE = 0.06;
  vec2 hq = vec2(hp.x / HANDLE_RX, hp.y / HANDLE_RY);
  float distToRing = (length(hq) - 1.0) * min(HANDLE_RX, HANDLE_RY);
  float handle = length(vec2(distToRing, hp.z)) - HANDLE_TUBE;
  // Smooth-union everything. Small k (0.04-0.05) for tight joins.
  float d = body;
  d = smin(d, lid,    0.05);
  d = smin(d, knob,   0.04);
  d = smin(d, spout,  0.05);
  d = smin(d, handle, 0.05);
  return d;
}

// Normal via 3-tap forward differences. Cheaper than the 4-tap
// "tetrahedron" central-difference normal (one fewer SDF eval +
// no vec3 mask multiplies), with O(h) error instead of O(h²) —
// negligible on a smin-blended surface whose SDF is already an
// approximation. Visible normal accuracy is identical.
vec3 sdNormal(vec3 p) {
  const float h = 0.001;
  float d0 = sdTeapot(p);
  return normalize(vec3(
    sdTeapot(p + vec3(h, 0.0, 0.0)) - d0,
    sdTeapot(p + vec3(0.0, h, 0.0)) - d0,
    sdTeapot(p + vec3(0.0, 0.0, h)) - d0
  ));
}

// ─────────────────────────────────────────────────────────────────────
// China pattern (cobalt motifs on porcelain)
// ─────────────────────────────────────────────────────────────────────

vec3 chinaPattern(vec3 p) {
  // 3D noise on local position. The previous cylindrical UV had a
  // seam at atan(z, x) wrap (back of the teapot, x < 0, z = 0)
  // which ran through the handle's tube circumference and showed
  // as a visible cobalt/white jump on the handle's back side. 3D
  // noise has no parameterisation seam.
  float macro = fbm3D(p * 4.5);
  float meso  = fbm3D(p * 13.0 + vec3(2.0, 5.0, 7.0));
  float micro = vnoise3(p * 32.0);
  float field = macro * 0.65 + meso * 0.30 + micro * 0.05;
  float pattern = smoothstep(
    PATTERN_THRESHOLD - PATTERN_SHARPNESS,
    PATTERN_THRESHOLD + PATTERN_SHARPNESS,
    field);
  // Bottom: clean porcelain foot fading up into the body's
  // pattern.
  pattern *= smoothstep(-0.53, -0.45, p.y);
  // Shoulder band: solid cobalt RING at the body-lid junction —
  // a classic decorative band on real Chinese export porcelain.
  // Finite in y (so the lid above and body below keep the
  // procedural cobalt-on-porcelain pattern) and limited radially
  // via length(p.xz) so the spout (radial ≥ 1.13 through this y
  // range) and handle (outer arc at radial ~1.09) keep their
  // painted decoration rather than turning into solid blue.
  float bandY  = smoothstep(0.48, 0.50, p.y)
               - smoothstep(0.60, 0.65, p.y);
  float onAxis = 1.0 - smoothstep(0.70, 0.82, length(p.xz));
  pattern = mix(pattern, 0.55, bandY * onAxis);
  return mix(PORCELAIN, COBALT, pattern);
}

// ─────────────────────────────────────────────────────────────────────
// Raymarcher
// ─────────────────────────────────────────────────────────────────────

float raymarch(vec3 ro, vec3 rd, out float minDistRel) {
  float t = 0.0;
  minDistRel = 1.0;
  for (int i = 0; i < MAX_STEPS; i++) {
    vec3 p = ro + rd * t;
    float d = sdTeapot(p);
    // Track the closest the ray got to the surface (normalised by
    // t so far-ray near-grazes don't trigger AA). Used by the
    // silhouette soft-edge blend below.
    minDistRel = min(minDistRel, d / max(t * 0.02, 0.001));
    if (d < HIT_EPS) return t;
    if (t > MAX_DIST) break;
    t += d * 0.95;  // slight under-step to avoid overshooting
  }
  return -1.0;
}

// ─────────────────────────────────────────────────────────────────────
// Tumble
// ─────────────────────────────────────────────────────────────────────

mat3 tumbleMatrix(float time) {
  // Strong +Y bias on the tumble axis so the body stays roughly
  // vertical (lid up). After normalize, axis.y ≥ 0.96 — a max
  // body-tilt of ~16° during the tumble. Weaker bias produced
  // some TEAPOT_SEED values where the X- or Z-aligned axis tipped
  // the body through "bottom toward camera" orientations.
  vec3 axis = normalize(vec3(
    sin(TEAPOT_SEED * 1.3) * 0.20,
    cos(TEAPOT_SEED * 1.7) + 2.0,
    sin(TEAPOT_SEED * 2.1) * 0.20));
  // Initial angle biased to one of the two profile views (spout
  // at +x or -x) so the demo opens at iTime=0 in profile rather
  // than face-on. After spawn the tumble continues through all
  // azimuths.
  float seedFlip = step(0.5, fract(TEAPOT_SEED * 13.7));
  float tInitOff = seedFlip * PI
                 + (fract(TEAPOT_SEED * 7.31) - 0.5) * (PI * 0.5);
  float ang = time * TUMBLE_RATE + tInitOff;
  float c = cos(ang), s = sin(ang), ic = 1.0 - c;
  return mat3(
    c + axis.x * axis.x * ic,
      axis.y * axis.x * ic + axis.z * s,
      axis.z * axis.x * ic - axis.y * s,
    axis.x * axis.y * ic - axis.z * s,
      c + axis.y * axis.y * ic,
      axis.z * axis.y * ic + axis.x * s,
    axis.x * axis.z * ic + axis.y * s,
      axis.y * axis.z * ic - axis.x * s,
      c + axis.z * axis.z * ic);
}

// ─────────────────────────────────────────────────────────────────────
// Backdrop (procedural starfield, same style as the other ports)
// ─────────────────────────────────────────────────────────────────────

vec3 sampleBackdrop(vec2 p, vec2 res) {
  vec2 c = res * 0.5;
  float dist = length(p - c);
  float span = min(res.x, res.y) * 0.7;
  vec3 bg = mix(vec3(0.020, 0.025, 0.045),
                vec3(0.000, 0.000, 0.010),
                clamp(dist / span, 0.0, 1.0));
  vec2 gp = p / STAR_GRID;
  vec2 gi = floor(gp);
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 cell = gi + vec2(float(dx), float(dy));
      float prob = vhash(cell + vec2(0.5, 0.5));
      if (prob > 0.65) {
        vec2 jit = vec2(vhash(cell), vhash(cell + vec2(1.7, 3.1)));
        vec2 cellPos = (cell + jit) * STAR_GRID;
        float starD = length(p - cellPos);
        float starSize = 0.4 + vhash(cell + vec2(3.7, 0.0)) * 1.2;
        float colT = vhash(cell + vec2(0.0, 5.3));
        float mag = pow(prob - 0.65, 2.0) * 22.0;
        vec3 starCol = mix(vec3(0.95, 0.95, 1.05),
                           vec3(1.05, 0.92, 0.78),
                           colT);
        bg += starCol
            * exp(-starD * starD / max(starSize * starSize, 0.001))
            * mag;
      }
    }
  }
  return bg;
}

// ─────────────────────────────────────────────────────────────────────
// Shadertoy entry
// ─────────────────────────────────────────────────────────────────────

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 res = iResolution.xy;
  // World-space ray from camera at +z looking toward origin.
  // Frame the teapot in ~75 % of the smaller viewport dimension.
  float scale = 4.0 / min(res.x, res.y);
  vec2 uv = (fragCoord - res * 0.5) * scale;
  vec3 ro = vec3(uv, -CAM_DIST);
  vec3 rd = vec3(0.0, 0.0, 1.0);
  // Tumble: rotate the ray INTO the teapot's local frame so the
  // SDF stays axis-aligned and the silhouette spins.
  mat3 R = tumbleMatrix(iTime);
  mat3 Rinv = transpose(R);
  vec3 roL = Rinv * ro;
  vec3 rdL = Rinv * rd;
  // Raymarch first; sample the backdrop only AFTER the march so
  // its 3 vec3 floats don't sit in registers across the whole
  // raymarch loop. The backdrop is needed for the silhouette AA
  // blend and the miss path, both of which run after the march.
  float minDistRel;
  float t = raymarch(roL, rdL, minDistRel);
  vec3 col = vec3(0.0);
  if (t > 0.0) {
    vec3 p = roL + rdL * t;
    vec3 normalLocal = sdNormal(p);
    // Rotate normal back to world frame for shading against
    // world-space lights.
    vec3 normal = R * normalLocal;
    vec3 viewDir = -rd;  // world-frame view direction
    // Surface colour comes from the LOCAL position so the pattern
    // tumbles with the teapot.
    vec3 base = chinaPattern(p);
    // Slowly precessing key light around the y-axis. xz radius is
    // sqrt(1 - KEY_TILT²) so the resulting vec3 is unit-length —
    // no normalize needed.
    float keyAng = iTime * KEY_PRECESS_RATE;
    float keyR   = sqrt(1.0 - KEY_TILT * KEY_TILT);
    vec3  keyDir = vec3(keyR * cos(keyAng), KEY_TILT,
                        keyR * sin(keyAng));
    float key  = max(dot(normal, keyDir),  0.0);
    float fill = max(dot(normal, FILL_DIR), 0.0) * 0.3;
    col = base * (AMBIENT + key + fill);
    // Specular highlight (Phong off the key light).
    vec3 reflectDir = reflect(-keyDir, normal);
    float spec = pow(max(dot(reflectDir, viewDir), 0.0),
                     SPECULAR_POW);
    col += spec * vec3(1.0) * SPECULAR_AMP;
    // Rim light at the silhouette — sells the porcelain glaze.
    float rim = pow(1.0 - max(dot(normal, viewDir), 0.0), RIM_POW);
    col += rim * RIM_TINT * RIM_AMP;
  }
  // Backdrop sampled here (after the march) so it's not held alive
  // through the raymarch loop. Used for both the miss path and the
  // silhouette AA blend.
  vec3 backdrop = sampleBackdrop(fragCoord, res);
  if (t < 0.0) col = backdrop;
  // Soft silhouette via near-miss blending. minDistRel is small
  // when a near-miss ray grazes the surface; smoothstep gives a
  // narrow AA band around the silhouette.
  float silAA = 1.0 - smoothstep(0.0, 0.6, minDistRel);
  col = mix(backdrop, col, max(t > 0.0 ? 1.0 : silAA, 0.0));
  fragColor = vec4(col, 1.0);
}
