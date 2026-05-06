// =====================================================================
// Ringworld — Shadertoy port of ASTROCATCH renderer.js (isRingworld branch)
// =====================================================================
//
// Shadertoy:
//   Name:        Tumbling ringworld habitat
//   Description: Halo-style ring wrapping a central sun. Ray-cylinder
//                intersection picks the near (outside / structural) and
//                far (inside / earth-textured) faces; optional inner
//                shadow plates with sun shadow + city lights. Drag
//                mouse to orbit. Ported from astrocatch.live.
//   Tags:        ringworld, halo, raycast, raycylinder
//   License:     MIT
//
//   ▶ Play the game:  https://astrocatch.live
//   ▶ Source code:    https://github.com/wistrand/astrocatch
//
// Self-contained re-implementation of the procedural ringworld shader
// from docs/renderer.js. Algorithm preserved verbatim: ray-cylinder
// intersection picks between the near (outside, structural) and far
// (inside, earth-textured) faces of a tumbling cylindrical band
// wrapping a central sun. Optional inner cylinder of orbiting shadow
// plates with sun shadow + city lights on the inside.
//
// All tweakable parameters are `const` declarations at the top.
// Drag mouse → 3D camera rotation around the ringworld.

const float PI  = 3.14159265;
const float TAU = 6.28318530;

// ─────────────────────────────────────────────────────────────────────
// Tweakable parameters
// ─────────────────────────────────────────────────────────────────────

// Master seed — drives the ringworld's tumble axis (so different
// rings tumble around different 3D axes).
const float V_SEED = 1.7;

// Ringworld screen size in pixels. Visible footprint extends to
// roughly 3.6 × this radius (the ring's outer extent).
const float V_BASE_R = 60.0;

// Ring radius and band height as multiples of V_BASE_R.
//   RING_R_MULT 3.6 = classic Halo proportion.
//   BAND_H_MULT 1.0 = comfortable readability.
const float RING_R_MULT = 3.6;
const float BAND_H_MULT = 1.0;

// Number of orbiting shadow plates inside the ring. 0 disables the
// plate system entirely (plate cylinder, sun shadow, city lights all
// short-circuit). Range [0, 7]. About 1 in 8 game-spawned ringworlds
// is plate-free.
const int RING_PLATE_COUNT = 5;

// Whole-ring tumble rate (radians per second). 0.0 disables tumble.
// 2-decimal multiplier of u_time so the simulation wraps cleanly.
const float TUMBLE_RATE = 0.25;

// Inside-face axial spin rate (continents drift around the central
// sun). 2-decimal multiplier of u_time.
const float SPIN_RATE = 0.12;

// Shadow plate orbital rate. 2-decimal multiplier of u_time.
const float PLATE_SPIN_RATE = 0.04;

// Sun radius as a fraction of V_BASE_R. 0.55 fills the visible
// disc nicely without bleeding into the ring.
const float SUN_R_MULT = 0.55;

// Lighting — ambient + diffuse coefficients per face.  In-game
// values were 0.20 + 2.70·NdotV (outside) and 0.01 + 1.70·NdotV
// (inside).  The very low inside ambient made the night side of
// the band go almost black; bumped here so the un-lit half of
// the inside surface still reads as gas-illuminated geometry.
const float OUTSIDE_AMBIENT = 0.60;
const float OUTSIDE_DIFFUSE = 2.70;
const float INSIDE_AMBIENT  = 0.35;
const float INSIDE_DIFFUSE  = 1.70;

// ─────────────────────────────────────────────────────────────────────
// Ringworld renderer
// ─────────────────────────────────────────────────────────────────────

vec4 renderRingworld(vec2 v_local, float u_time, mat3 viewRot) {
  float v_baseR = V_BASE_R;
  float v_seed  = V_SEED;
  float R = v_baseR * RING_R_MULT;
  float H = v_baseR * BAND_H_MULT;
  int   plateCount = RING_PLATE_COUNT;

  // Per-ring tumble axis derived from seed (monolith-style single-
  // axis tumble, steady, no wobble).
  vec3 rotAxis = normalize(vec3(
    sin(v_seed * 1.3),
    cos(v_seed * 1.7 + 0.5) + 0.15,
    sin(v_seed * 2.1 + 1.0)
  ));
  float ang = u_time * TUMBLE_RATE + v_seed;
  float cA = cos(ang), sA = sin(ang), ic = 1.0 - cA;
  // Rodrigues rotation matrix for the tumble.
  mat3 Rrot = mat3(
    cA + rotAxis.x * rotAxis.x * ic,
      rotAxis.y * rotAxis.x * ic + rotAxis.z * sA,
      rotAxis.z * rotAxis.x * ic - rotAxis.y * sA,
    rotAxis.x * rotAxis.y * ic - rotAxis.z * sA,
      cA + rotAxis.y * rotAxis.y * ic,
      rotAxis.z * rotAxis.y * ic + rotAxis.x * sA,
    rotAxis.x * rotAxis.z * ic + rotAxis.y * sA,
      rotAxis.y * rotAxis.z * ic - rotAxis.x * sA,
      cA + rotAxis.z * rotAxis.z * ic
  );
  vec3 axis = Rrot * vec3(0.0, 1.0, 0.0);
  vec3 basU = Rrot * vec3(1.0, 0.0, 0.0);
  vec3 basV = Rrot * vec3(0.0, 0.0, 1.0);

  // Orthographic ray, rotated by the mouse-driven view matrix.
  // Without mouse input viewRot is identity → original ray.
  vec3 o = viewRot * vec3(v_local.x, v_local.y, 1000.0);
  vec3 d = viewRot * vec3(0.0, 0.0, -1.0);

  // Ray-cylinder quadratic in the (perpendicular-to-axis) plane.
  vec3 oPerp = o - dot(o, axis) * axis;
  vec3 dPerp = d - dot(d, axis) * axis;
  float A = dot(dPerp, dPerp);
  // Edge-on guard: when the ring's axis aligns with view dir,
  // dPerp → 0 and t1/t2 → ±∞/NaN. Skip the ring intersection
  // entirely in that window and fall through to the sun branch.
  bool ringSkip = A < 1e-6;
  float B = 2.0 * dot(oPerp, dPerp);
  float C = dot(oPerp, oPerp) - R * R;
  float disc = B * B - 4.0 * A * C;
  float centerD = length(v_local);
  float sunR = v_baseR * SUN_R_MULT;

  bool ringHit = false;
  bool isInside = false;
  vec3 hit;
  float axPos;
  if (!ringSkip && disc >= 0.0) {
    float sqDisc = sqrt(disc);
    float t1 = (-B - sqDisc) / (2.0 * A);
    float t2 = (-B + sqDisc) / (2.0 * A);
    vec3 h1 = o + t1 * d;
    vec3 h2 = o + t2 * d;
    float ax1 = dot(h1, axis);
    float ax2 = dot(h2, axis);
    bool v1 = abs(ax1) <= H * 0.5;
    bool v2 = abs(ax2) <= H * 0.5;
    if (v1) { hit = h1; axPos = ax1; isInside = false; ringHit = true; }
    else if (v2) { hit = h2; axPos = ax2; isInside = true; ringHit = true; }
  }

  // ── Shadow plates ────────────────────────────────────────────
  // Smaller inner cylinder of N orbiting structural panels. Always
  // behind the ring's outside face, so when the outside face is
  // the selected ring hit, plates are occluded.
  float Rp = R * 0.55;
  float Hp = H * 0.70;
  float plateSpin = u_time * PLATE_SPIN_RATE;
  float plateSpacing = (plateCount > 0) ? TAU / float(plateCount) : TAU;
  float plateHalfW = plateSpacing * 0.22;
  bool outsideVisible = ringHit && !isInside;
  // Render priority from camera forward:
  //   1. outside ring wall (handled after this block)
  //   2. plate near wall (k=0) — first pass, occludes sun
  //   3. SUN at axis — sun-priority check below
  //   4. plate far wall (k=1) — second pass, sun blends on top
  //   5. inside ring wall (handled after this block)
  float Cp = dot(oPerp, oPerp) - Rp * Rp;
  float discp = B * B - 4.0 * A * Cp;
  float sqp = (discp >= 0.0) ? sqrt(discp) : 0.0;
  bool platesOk = plateCount > 0 && !outsideVisible && !ringSkip
               && discp >= 0.0;

  // Plate near wall (k=0) — occludes the sun.
  if (platesOk) {
    float tp = (-B - sqp) / (2.0 * A);
    vec3 hp = o + tp * d;
    float axp = dot(hp, axis);
    if (abs(axp) <= Hp * 0.5) {
      vec2 rp = vec2(dot(hp, basU), dot(hp, basV));
      float thetaP = atan(rp.y, rp.x);
      float tw = mod(thetaP + plateSpin, plateSpacing);
      if (abs(tw - plateSpacing * 0.5) < plateHalfW) {
        vec3 pnrm = (hp - dot(hp, axis) * axis) / Rp;
        float pndv = max(pnrm.z, 0.0);
        float pWidthT = axp / Hp + 0.5;
        vec3 pCol = vec3(0.10, 0.11, 0.15) * (0.45 + 1.2 * pndv);
        pCol *= mix(1.10, 0.80, pWidthT);
        return vec4(pCol, 1.0);
      }
    }
  }

  // Sun overlay alpha/color — applied wherever the sun should be
  // visible (plate-far, inside, pure ring-miss). Outside occludes
  // it; plate-near already returned above.
  float sunAlpha = 0.0;
  vec3 sunCol = vec3(1.0, 0.92, 0.65);
  if (!outsideVisible && centerD < sunR) {
    float glowT = 1.0 - smoothstep(0.0, sunR, centerD);
    float coreT = 1.0 - smoothstep(0.0, v_baseR * 0.25, centerD);
    sunAlpha = clamp(glowT * 0.45 + coreT * 0.55, 0.0, 1.0);
  }

  // Plate far wall (k=1) — sun-facing side with specular.
  if (platesOk) {
    float tp = (-B + sqp) / (2.0 * A);
    vec3 hp = o + tp * d;
    float axp = dot(hp, axis);
    if (abs(axp) <= Hp * 0.5) {
      vec2 rp = vec2(dot(hp, basU), dot(hp, basV));
      float thetaP = atan(rp.y, rp.x);
      float tw = mod(thetaP + plateSpin, plateSpacing);
      if (abs(tw - plateSpacing * 0.5) < plateHalfW) {
        vec3 pnrm = -(hp - dot(hp, axis) * axis) / Rp;
        float pndv = max(pnrm.z, 0.0);
        float pWidthT = axp / Hp + 0.5;
        vec3 pCol = vec3(0.10, 0.11, 0.15) * (0.45 + 1.2 * pndv);
        float ps = pow(pndv, 24.0);
        pCol += vec3(1.0, 0.95, 0.82) * ps * 0.55;
        pCol *= mix(1.10, 0.80, pWidthT);
        // Sun sits geometrically in front of the far plate — blend
        // its glow on top so the sun's edge fades into the plate.
        pCol = mix(pCol, sunCol, sunAlpha);
        return vec4(pCol, 1.0);
      }
    }
  }

  // Ring miss → sun-over-empty or pure empty.
  if (!ringHit) {
    return vec4(sunCol * sunAlpha, sunAlpha);
  }

  // ── Ring band hit ───────────────────────────────────────────
  float widthT = axPos / H + 0.5;     // 0 bottom → 1 top
  vec2 ringPt = vec2(dot(hit, basU), dot(hit, basV));
  float theta = atan(ringPt.y, ringPt.x);
  float spin = u_time * SPIN_RATE;
  float u = theta + spin;
  // Camera-direction lighting.
  vec3 outward = (hit - dot(hit, axis) * axis) / R;
  float ndl = isInside ? -outward.z : outward.z;
  ndl = max(ndl, 0.0);
  float lit = OUTSIDE_AMBIENT + OUTSIDE_DIFFUSE * ndl;
  float litInside = INSIDE_AMBIENT + INSIDE_DIFFUSE * ndl;
  float vertShade = mix(1.10, 0.80, widthT);
  float topEdge = smoothstep(0.82, 1.0, (widthT - 0.5) * 2.0);
  float botEdge = smoothstep(0.82, 1.0, (0.5 - widthT) * 2.0);

  if (isInside) {
    // INSIDE surface — earth-textured, sun-lit. Every multiplier of
    // u must be an integer so the texture seams up at theta wrap.
    float n = 0.50 * sin(u * 9.0)  * cos(widthT * 5.95)
            + 0.30 * sin(u * 23.0 + 1.3) * cos(widthT * 10.85 + 0.7)
            + 0.18 * sin(u * 47.0 + 2.2) * cos(widthT * 20.65 + 1.1);
    vec3 ocean = vec3(0.10, 0.32, 0.62);
    vec3 coast = vec3(0.32, 0.54, 0.25);
    vec3 land  = vec3(0.46, 0.40, 0.22);
    float landT = smoothstep(-0.05, 0.22, n);
    float mountainT = smoothstep(0.32, 0.55, n);
    vec3 col = mix(ocean, coast, landT);
    col = mix(col, land, mountainT);
    col = mix(col, vec3(0.02, 0.02, 0.04), topEdge * 0.45);
    col = mix(col, vec3(0.95, 0.92, 0.85), botEdge * 0.12);
    // Cloud clumps — multi-octave domain-warped sin/cos.
    float wu = u + 0.35 * sin(widthT * 3.1 + u_time * 0.08);
    float ww = widthT + 0.25 * sin(u * 3.0 + u_time * 0.05);
    float c1 = sin(wu * 11.0 + u_time * 0.10)
             * cos(ww * 4.2 - u_time * 0.07);
    float c2 = sin(wu * 21.0 - u_time * 0.13)
             * cos(ww * 7.9 + u_time * 0.09);
    float cloud = 0.55 * c1 + 0.35 * c2;
    cloud = smoothstep(0.05, 0.45, cloud);
    col = mix(col, vec3(0.95), cloud * 0.40);
    col *= litInside;
    // Atmospheric limb glow — warm fresnel at the silhouette,
    // inside face only. Identifies "far arc."
    float fres = pow(1.0 - abs(outward.z), 4.0);
    col += vec3(1.0, 0.78, 0.55) * fres * 0.45;
    // Specular hotspot on water only — oceans glint, continents
    // stay matte. Normal flips sign since visible face is far wall.
    float specIn = pow(max(-outward.z, 0.0), 32.0);
    col += vec3(1.0, 0.95, 0.80) * specIn * 0.85 * (1.0 - landT);
    col *= vertShade;
    // Sun-shadow + city lights — skipped when plateCount == 0.
    if (plateCount > 0) {
      float thetaWrap = mod(theta + plateSpin, plateSpacing);
      float angDist = abs(thetaWrap - plateSpacing * 0.5);
      float angIn = 1.0 - smoothstep(
        plateHalfW * 0.7, plateHalfW * 0.95, angDist
      );
      float axAtPlate = abs(axPos) * Rp / R;
      float axIn = 1.0 - smoothstep(
        Hp * 0.45, Hp * 0.55, axAtPlate
      );
      float shadow = angIn * axIn;
      col *= 1.0 - shadow * 0.75;
      // City lights — warm dots on land in deep-night zones.
      // Domain-warped sum-of-sins so clumps don't grid-align.
      // u multipliers kept integer for seam continuity.
      float cwu = u + 0.35 * sin(widthT * 13.0 + u * 5.0);
      float cww = widthT + 0.28 * sin(u * 7.0 - widthT * 17.0);
      float cityN = sin(cwu * 61.0 + cww * 29.0 + 0.3)
                  + 0.75 * sin(cwu * 113.0 - cww * 47.0 + 1.7)
                  + 0.50 * sin(cwu * 181.0 + cww * 83.0 - 0.7);
      float cities = smoothstep(1.90, 2.20, cityN);
      vec3 cityCol = vec3(1.0, 0.78, 0.42);
      // pow(shadow, 3) concentrates lights toward deep-night centre.
      float cityShadow = pow(shadow, 3.0);
      col += cityCol * cities * cityShadow * landT * 1.20;
    }
    // Sun overlay — sun is closer to camera than the inside far
    // wall, so blend its glow on top.
    col = mix(col, sunCol, sunAlpha);
    return vec4(col, 1.0);
  } else {
    // OUTSIDE surface — honeycomb with per-hex grayscale.
    // Pointy-top hexes; NCOLS even so theta-seam parity wraps.
    const float NCOLS  = 58.0;
    const float WSCALE = 3.0;
    float uNorm = u - TAU * floor(u / TAU);
    vec2 hexUV = vec2(uNorm * NCOLS / TAU, widthT * WSCALE);
    vec2 hr = vec2(1.0, 1.73205);
    vec2 hh_ = hr * 0.5;
    vec2 hexA = mod(hexUV, hr) - hh_;
    vec2 hexB = mod(hexUV - hh_, hr) - hh_;
    vec2 gv  = (dot(hexA, hexA) < dot(hexB, hexB)) ? hexA : hexB;
    vec2 hexId = hexUV - gv;
    // Theta-seam wrap: a hex straddling theta = ±π must hash to
    // the same tone on both sides.
    hexId.x = mod(hexId.x, NCOLS);
    float h = fract(
      sin(dot(hexId, vec2(12.9898, 78.233))) * 43758.5453
    );
    float tone;
    if (h < 0.55)      tone = 0.13;
    else if (h < 0.80) tone = 0.15;
    else if (h < 0.93) tone = 0.17;
    else               tone = 0.19;
    vec3 col = vec3(tone);
    col = mix(col, vec3(0.0), topEdge * 0.45);
    col = mix(col, vec3(0.55, 0.58, 0.65), botEdge * 0.18);
    col *= lit;
    // Specular hotspot on the camera-facing side ("near arc").
    float spec = pow(max(outward.z, 0.0), 32.0);
    col += vec3(0.95, 0.92, 0.85) * spec * 0.55;
    col *= vertShade;
    return vec4(col, 1.0);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Shadertoy entry point
// ─────────────────────────────────────────────────────────────────────

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 res = iResolution.xy;
  // Centre the ringworld on screen.
  vec2 loc = fragCoord - res * 0.5;

  // 3D mouse rotation. Drag horizontally → yaw around Y axis; drag
  // vertically → pitch around X axis. iMouse defaults to (0, 0)
  // before the first click → identity rotation = renderer's
  // default view direction.
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
    vec3(cy,   sp * sy,  -cp * sy),
    vec3(0.0,  cp,        sp),
    vec3(sy,   -sp * cy,  cp * cy)
  );

  vec4 ring = renderRingworld(loc, iTime, viewRot);
  // Ring surfaces are opaque; sun-over-empty is premultiplied alpha.
  // Composite over black background.
  fragColor = vec4(ring.rgb, 1.0);
}
