// =====================================================================
// Monolith — Shadertoy port of ASTROCATCH renderer.js (isMonolith branch)
// =====================================================================
//
// Shadertoy:
//   Name:        Tumbling 1:4:9 monolith
//   Description: Classic 2001 monolith: analytic ray-vs-axis-aligned-
//                slab intersection in box-local coordinates, Rodrigues-
//                rotation tumble around a per-monolith random axis,
//                directional diffuse + power-4 fresnel rim. Drag mouse
//                to orbit. Ported from astrocatch.live.
//   Tags:        monolith, 2001, slab, raycast
//   License:     MIT
//
//   ▶ Play the game:  https://astrocatch.live
//   ▶ Source code:    https://github.com/wistrand/astrocatch
//
// Self-contained re-implementation of the procedural monolith shader
// from docs/renderer.js. Algorithm preserved verbatim: orthographic
// ray-vs-axis-aligned-slab intersection in box-local coordinates,
// classic 2001 1:4:9 proportion, Rodrigues-rotation tumble around a
// per-monolith random axis, dominant-axis face normal selection,
// directional diffuse + power-4 fresnel rim light. Edge AA via
// fwidth(tN).
//
// All tweakable parameters are `const` declarations at the top.
// Drag mouse → 3D camera rotation around the tumbling slab.

const float PI  = 3.14159265;
const float TAU = 6.28318530;

// ─────────────────────────────────────────────────────────────────────
// Tweakable parameters
// ─────────────────────────────────────────────────────────────────────

// Master seed — drives the per-monolith tumble axis.
const float V_SEED = 1.7;

// Monolith screen size (px). v_baseR equivalent. The visible slab
// fits inside ~ 1.7 × this radius.
const float V_BASE_R = 130.0;

// Slab half-extents as multiples of V_BASE_R. Default values give
// the canonical 2001 monolith proportion 1:4:9.
//   short × tall × deep = 0.189 : 0.747 : 1.692.
const float ASPECT_X = 0.189;
const float ASPECT_Y = 0.747;
const float ASPECT_Z = 1.692;

// Whole-monolith tumble rate (radians per second). 2-decimal so
// the simulation wraps cleanly under the in-game TIME_WRAP rule.
const float TUMBLE_RATE = 0.25;

// Diffuse light direction (in world frame). Normalised inside.
const vec3 LIGHT_DIR = vec3(-0.3, 0.6, 0.8);

// Body brightness — ambient + max diffuse contribution.
const float BODY_AMBIENT = 0.03;
const float BODY_DIFFUSE = 0.08;

// Fresnel rim light. Power 4 produces a tight glowing edge at the
// silhouette where the surface normal faces away from the camera.
const vec3  RIM_COLOR     = vec3(0.45, 0.60, 0.90);
const float RIM_INTENSITY = 0.55;
const float RIM_POWER     = 4.0;

// Background star grid size (px) — larger = fewer brighter stars.
const float STAR_GRID = 35.0;

// ─────────────────────────────────────────────────────────────────────
// Backdrop
// ─────────────────────────────────────────────────────────────────────

float monoHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 sampleBackdrop(vec2 p, vec2 res) {
  // Faint radial gradient + sparse hashed Gaussian stars. Same
  // pattern as the BH port but a touch dimmer so the monolith's
  // dark body silhouettes cleanly.
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
      float prob = monoHash(cell + vec2(0.5, 0.5));
      if (prob > 0.65) {
        vec2 jit = vec2(monoHash(cell), monoHash(cell + vec2(1.7, 3.1)));
        vec2 cellPos = (cell + jit) * STAR_GRID;
        float starD = length(p - cellPos);
        float starSize = 0.4 + monoHash(cell + vec2(3.7, 0.0)) * 1.2;
        float colT = monoHash(cell + vec2(0.0, 5.3));
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
// Monolith renderer
// ─────────────────────────────────────────────────────────────────────

vec4 renderMonolith(vec2 v_local, float u_time, mat3 viewRot) {
  float v_baseR = V_BASE_R;
  float v_seed  = V_SEED;
  vec3 b = vec3(v_baseR * ASPECT_X,
                v_baseR * ASPECT_Y,
                v_baseR * ASPECT_Z);

  // Per-monolith tumble axis derived from seed.
  vec3 axis = normalize(vec3(
    sin(v_seed * 1.3),
    cos(v_seed * 1.7 + 0.5) + 0.15, // bias slightly up
    sin(v_seed * 2.1 + 1.0)
  ));
  float ang = u_time * TUMBLE_RATE + v_seed;
  float cA = cos(ang), sA = sin(ang), ic = 1.0 - cA;
  // Rodrigues rotation matrix (box-local → world).
  mat3 R = mat3(
    cA + axis.x * axis.x * ic,
      axis.y * axis.x * ic + axis.z * sA,
      axis.z * axis.x * ic - axis.y * sA,
    axis.x * axis.y * ic - axis.z * sA,
      cA + axis.y * axis.y * ic,
      axis.z * axis.y * ic + axis.x * sA,
    axis.x * axis.z * ic + axis.y * sA,
      axis.y * axis.z * ic - axis.x * sA,
      cA + axis.z * axis.z * ic
  );
  mat3 Rinv = transpose(R);

  // Orthographic ray (in world frame), rotated by the mouse view
  // matrix so the camera can orbit. Without mouse input viewRot is
  // identity → original ray.
  vec3 oWorld = viewRot * vec3(v_local, 1000.0);
  vec3 dWorld = viewRot * vec3(0.0, 0.0, -1.0);
  // Transform into box-local frame for the slab intersection.
  vec3 ro = Rinv * oWorld;
  vec3 rd = Rinv * dWorld;

  // Guard rd away from zero — when one component goes to zero the
  // 1/rd overflow produces NaN via Inf-Inf in later max/min. Clamp
  // each component to ±1e-4 in the correct sign direction.
  vec3 rdSafe = mix(min(rd, vec3(-1e-4)),
                    max(rd, vec3(1e-4)),
                    step(0.0, rd));
  vec3 m = 1.0 / rdSafe;
  vec3 n = m * ro;
  vec3 k = abs(m) * b;
  vec3 t1 = -n - k;
  vec3 t2 = -n + k;
  float tN = max(max(t1.x, t1.y), t1.z);
  float tF = min(min(t2.x, t2.y), t2.z);

  // Hard miss cutoff. fwidth(tN) blows up at grazing angles, so AA
  // is only applied inside the slab where tN varies smoothly.
  if (tN > tF || tF < 0.0) {
    return vec4(0.0);
  }
  float edgeAW = min(fwidth(tN), v_baseR * 0.08);
  float aa = 1.0 - smoothstep(tF - edgeAW, tF, tN);

  // Face normal — argmax over t1 components to pick the dominant
  // hit axis. Avoids grazing-corner ambiguity where step() would
  // flag multiple axes simultaneously and yield a non-unit normal.
  vec3 normalLocal;
  if (t1.x >= t1.y && t1.x >= t1.z) {
    normalLocal = vec3(-sign(rdSafe.x), 0.0, 0.0);
  } else if (t1.y >= t1.z) {
    normalLocal = vec3(0.0, -sign(rdSafe.y), 0.0);
  } else {
    normalLocal = vec3(0.0, 0.0, -sign(rdSafe.z));
  }
  vec3 normal = R * normalLocal;

  // Body shading: ambient + diffuse against LIGHT_DIR.
  float NdotL = max(dot(normal, normalize(LIGHT_DIR)), 0.0);
  float body = BODY_AMBIENT + BODY_DIFFUSE * NdotL;

  // Fresnel rim — view dir is (0, 0, -1) world; silhouette edges
  // have |normal.z| near 0. Power 4 gives a tight bright edge.
  float fresnel = pow(1.0 - abs(normal.z), RIM_POWER);
  vec3 rim = RIM_COLOR * fresnel * RIM_INTENSITY;

  return vec4(vec3(body) + rim, aa);
}

// ─────────────────────────────────────────────────────────────────────
// Shadertoy entry point
// ─────────────────────────────────────────────────────────────────────

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 res = iResolution.xy;
  vec2 loc = fragCoord - res * 0.5;

  // 3D mouse rotation. Drag horizontally → yaw around Y axis;
  // drag vertically → pitch around X axis. iMouse defaults to
  // (0, 0) before the first click → identity rotation = renderer
  // default view.
  float yaw = 0.0;
  float pitch = 0.0;
  if (iMouse.x > 0.0 || iMouse.y > 0.0) {
    yaw   = (iMouse.x / res.x - 0.5) * TAU;
    pitch = (iMouse.y / res.y - 0.5) * PI;
  }
  float cy = cos(yaw),   sy = sin(yaw);
  float cp = cos(pitch), sp = sin(pitch);
  // R = Rx(pitch) * Ry(yaw), columns-first for GLSL mat3 ctor.
  mat3 viewRot = mat3(
    vec3(cy,    sp * sy,  -cp * sy),
    vec3(0.0,   cp,        sp),
    vec3(sy,   -sp * cy,   cp * cy)
  );

  vec3 backdrop = sampleBackdrop(fragCoord, res);
  vec4 mono = renderMonolith(loc, iTime, viewRot);
  // Composite premultiplied monolith over backdrop.
  vec3 col = backdrop * (1.0 - mono.a) + mono.rgb;
  fragColor = vec4(col, 1.0);
}
