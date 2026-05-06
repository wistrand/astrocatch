// =====================================================================
// Black hole — Shadertoy port of ASTROCATCH renderer.js
// =====================================================================
//
// Shadertoy:
//   Name:        Gravitational black hole with accretion disk
//   Description: Edge-on accretion disk with asymmetric lensed back-
//                arcs over an event horizon. Newtonian weak-field UV
//                distortion warps a procedural reference grid +
//                starfield around it. Photon ring shimmer on top.
//                Drag mouse to move the BH across the background.
//                Ported from astrocatch.live.
//   Tags:        blackhole, lensing, space, gargantua
//   License:     MIT
//
//   ▶ Play the game:  https://astrocatch.live
//   ▶ Source code:    https://github.com/wistrand/astrocatch
//
// Combines the per-instance star-shader BH branch (event horizon +
// edge-on accretion disk + asymmetric lensed back-side arcs) with
// the fullscreen lensing composite pass (UV distortion + procedural
// background grid + photon ring) into a single fragment shader.
//
// In the original code the BH is rendered to a scene FBO and then a
// second fullscreen pass distorts the FBO around each visible BH.
// The disk and arcs LIVE INSIDE THE FBO, so they get distorted along
// with the background — they appear to warp around the event horizon.
//
// This port keeps that semantic by computing "what was in the FBO
// at sample position p" via a helper that combines procedural
// background + per-instance BH layer. The lensing pass then samples
// THAT helper at distorted UVs, exactly mirroring the texture sample
// in the game.

const float PI  = 3.14159265;
const float TAU = 6.28318530;

// ─────────────────────────────────────────────────────────────────────
// Tweakable parameters
// ─────────────────────────────────────────────────────────────────────

const float V_SEED  = 1.7;     // master seed for disk tilt offset
const float V_BASE_R = 70.0;   // event horizon radius (px)

// Lensing radius multiplier — distortion fades to zero by 8 × R.
const float LENS_R_MULT = 8.0;

// Photon ring (multiples of V_BASE_R, plus brightness).
const float PHOTON_R_MULT     = 1.4;
const float PHOTON_W_MULT     = 0.06;
const float PHOTON_BRIGHTNESS = 0.9;

// Accretion disk geometry (multiples of V_BASE_R).
const float DISK_HALF_H_MULT = 0.18;
const float DISK_RADIAL_MULT = 3.5;
const float DISK_COLOR_MULT  = 3.0;

// Animation rates — must be 2-decimal multiples of u_time so the
// game's TIME_WRAP keeps sin/cos bit-identical at wrap moments.
const float DISK_DOPPLER_RATE   = 0.8;
const float DISK_PRECESS_RATE   = 0.3;
const float PHOTON_SHIMMER_RATE = 2.5;

// Background grid spacing in framebuffer pixels.
const float GRID_SPACING = 40.0;

// Procedural starfield grid size (px).
const float STAR_GRID = 35.0;

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

// Sin-free hash (Hoskins).
float bhHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Procedural backdrop — radial gradient + sparse hashed Gaussian
// stars. Pure function of position, so distorted samples behave
// identically to distorted FBO reads in the game.
vec3 sampleBackdrop(vec2 p, vec2 res) {
  vec2 c = res * 0.5;
  float dist = length(p - c);
  float span = min(res.x, res.y) * 0.7;
  vec3 bg = mix(vec3(0.040, 0.045, 0.075),
                vec3(0.005, 0.005, 0.020),
                clamp(dist / span, 0.0, 1.0));

  vec2 gp = p / STAR_GRID;
  vec2 gi = floor(gp);
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 cell = gi + vec2(float(dx), float(dy));
      float prob = bhHash(cell + vec2(0.5, 0.5));
      if (prob > 0.65) {
        vec2 jit = vec2(bhHash(cell), bhHash(cell + vec2(1.7, 3.1)));
        vec2 cellPos = (cell + jit) * STAR_GRID;
        float starD = length(p - cellPos);
        float starSize = 0.5 + bhHash(cell + vec2(3.7, 0.0)) * 1.4;
        float colT = bhHash(cell + vec2(0.0, 5.3));
        float mag = pow(prob - 0.65, 2.0) * 30.0;
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

// Per-instance BH layer — what the star fragment shader writes into
// the scene FBO. Returns premultiplied RGBA (col already multiplied
// by alpha) at position loc relative to BH centre, with d =
// length(loc).
vec4 bhLayer(vec2 loc, float d, float v_seed, float u_time) {
  float R = V_BASE_R;
  float aw = max(fwidth(d), 0.5);

  // Disk tilt — per-BH static angle from V_SEED + slow precession.
  float diskTilt = (v_seed / TAU - 0.5) * 0.7
                 + sin(u_time * DISK_PRECESS_RATE + v_seed) * 0.12;
  float ca = cos(diskTilt);
  float sa = sin(diskTilt);
  vec2 rl = vec2(loc.x * ca - loc.y * sa,
                 loc.x * sa + loc.y * ca);

  // Per-instance event horizon — antialiased opaque black disk.
  float ehMask = 1.0 - smoothstep(R - aw, R + aw, d);
  vec4 col = vec4(0.0, 0.0, 0.0, ehMask);

  // Main disk band — thin horizontal strip in the tilted frame
  // crossing in front of the EH.
  float diskHalfH = R * DISK_HALF_H_MULT;
  float bandFade  = smoothstep(diskHalfH, diskHalfH * 0.1, abs(rl.y));
  float rFade     = 1.0 - clamp(d / (R * DISK_RADIAL_MULT), 0.0, 1.0);
  rFade *= rFade;
  vec3 diskCol = mix(vec3(1.0, 0.95, 0.85),
                     vec3(1.0, 0.40, 0.05),
                     clamp(d / (R * DISK_COLOR_MULT), 0.0, 1.0));
  float sideAngle = atan(rl.y, rl.x) - u_time * DISK_DOPPLER_RATE;
  float sideBoost = 0.65 + 0.35 * cos(sideAngle);
  float diskA = bandFade * rFade * sideBoost;

  // Lensed back-side arcs — asymmetric: bottom (tilted frame)
  // brighter / wider than top.
  bool isBottom = rl.y < 0.0;
  float arcCenter = R * (isBottom ? 1.35 : 1.18);
  float arcWidth  = R * R * (isBottom ? 0.08 : 0.035);
  float arcBright = isBottom ? 0.7 : 0.3;
  float wrapR     = abs(d - arcCenter);
  float wrapGlow  = exp(-wrapR * wrapR / arcWidth);
  float vertBias  = abs(rl.y) / max(d, 0.001);
  float wrapA     = wrapGlow * smoothstep(0.15, 0.6, vertBias) * arcBright;
  vec3  wrapCol   = isBottom
    ? vec3(1.00, 0.75, 0.35)
    : vec3(0.85, 0.65, 0.35);

  // Composite disk + arcs over the EH.
  float totalA = min(1.0, diskA + wrapA);
  if (totalA > 0.001) {
    vec3 combined = (diskCol * diskA + wrapCol * wrapA) / totalA;
    col.rgb = mix(col.rgb, combined, totalA);
    col.a = max(col.a, totalA);
  }
  return col;
}

// What the scene FBO contains at framebuffer position p.
// Background + per-instance BH layer composited.  Lensing then
// samples THIS function at distorted UVs. The BH centre is passed
// in so the BH can be moved across the background by the user.
vec3 sceneFBO(vec2 p, vec2 res, vec2 bhCenter,
              float v_seed, float u_time) {
  vec3 bg = sampleBackdrop(p, res);
  vec2 loc = p - bhCenter;
  float d  = length(loc);
  vec4 bh  = bhLayer(loc, d, v_seed, u_time);
  // Premultiplied "over" composite: result = bh.rgb + bg * (1 - bh.a)
  return bh.rgb + bg * (1.0 - bh.a);
}

// ─────────────────────────────────────────────────────────────────────
// Shadertoy entry point
// ─────────────────────────────────────────────────────────────────────

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 res = iResolution.xy;

  // BH centre defaults to screen middle. Drag mouse to move the
  // BH around the canvas — the BH carries its disk, arcs, and
  // lensing zone with it, dragging the procedural starfield grid
  // through the gravitational distortion as it moves.
  vec2 bhCenter = res * 0.5;
  if (iMouse.x > 0.0 || iMouse.y > 0.0) {
    bhCenter = iMouse.xy;
  }

  vec2 loc = fragCoord - bhCenter;
  float d  = length(loc);
  float R  = V_BASE_R;
  float v_seed = V_SEED;

  // ── Lensing distortion at fragment position. UV moves toward
  // the BH by 1/d² strength.
  float lensR = R * LENS_R_MULT;
  vec2 dir = (d > 0.001) ? loc / d : vec2(1.0, 0.0);
  vec2 distUV = fragCoord;
  if (d > R * 0.9 && d < lensR) {
    float t = R / d;
    float strength = t * t * R * LENS_R_MULT;
    strength *= 1.0 - smoothstep(lensR * 0.6, lensR, d);
    distUV -= dir * strength;
  }

  // Sample the FBO (= background + BH disk / arcs / per-instance
  // EH) at the lensing-distorted UV.  This makes the disk and arcs
  // visibly warp around the event horizon, and the background grid
  // bend around the BH wherever it moves.
  vec3 scene = sceneFBO(distUV, res, bhCenter, v_seed, iTime);

  // Procedural reference grid behind the BH at distorted UVs —
  // makes gravitational distortion immediately visible.
  float gridR = lensR * 1.3;
  if (d < gridR) {
    float fade = smoothstep(gridR, lensR * 0.6, d)
               * smoothstep(R * 0.8, R * 1.5, d);
    float gx = abs(fract(distUV.x / GRID_SPACING + 0.5) - 0.5) * GRID_SPACING;
    float gy = abs(fract(distUV.y / GRID_SPACING + 0.5) - 0.5) * GRID_SPACING;
    float line = min(gx, gy);
    float g = 1.0 - smoothstep(0.0, 1.5, line);
    float gridAlpha = 0.8 * g * fade;
    scene = mix(scene, vec3(0.4, 0.5, 0.7), gridAlpha * 0.48);
  }

  // Photon ring at FRAGMENT position (not distorted) — sits on top
  // of everything as a thin Gaussian band.
  float ring  = exp(-pow((d - R * PHOTON_R_MULT)
                       / max(R * PHOTON_W_MULT, 0.5), 2.0));
  float theta = atan(loc.y, loc.x);
  float shimmer = 0.75 + 0.25 * sin(theta * 3.0 - iTime * PHOTON_SHIMMER_RATE);
  scene += vec3(0.95, 0.85, 0.6) * ring * shimmer * PHOTON_BRIGHTNESS;

  // Lensing-pass EH mask at fragment position — slightly larger
  // than the per-instance EH so the silhouette matches the
  // distortion-warped ring boundary.  Scene multiplied by mask at
  // the very end, like the in-game lensing FS.
  float mask = 1.0 - smoothstep(R * 0.75, R * 1.05, d);
  scene *= (1.0 - mask);

  fragColor = vec4(scene, 1.0);
}
