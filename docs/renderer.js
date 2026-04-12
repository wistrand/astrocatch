// WebGL2 renderer for ASTROCATCH. Owns the GL context, shader programs,
// dynamic vertex buffers, and the draw API consumed by gameplay.js.
// Browser-only — the node physics test runner never imports this file.
//
// Four shader programs cover the full render surface:
//
//   fullscreen  background radial gradient. One draw.
//   circle      ball, particles, shockwaves, isNext hint ring, bgStars.
//               Instanced quad. Kind flag in per-instance attributes
//               picks between solid, ring, glow, dashed ring. Parallax
//               and twinkle are opt-in per instance, so the same program
//               handles gameplay effects AND the parallax starfield.
//   star        active stars (gameplay and menu). Instanced quad.
//               Fragment shader evaluates corona, streamers, glow,
//               photosphere, granulation, core highlight per pixel,
//               driven by u_time so the whole star animates as before.
//   polyline    trail, connector lines, velocity shaft, replay ghost
//               path. Dynamic vertex buffer, triangle-strip extrusion
//               in the vertex shader from a line strip of points.
//
// No libraries, no build step, no shader loader. Shaders live below as
// template strings. Matrices are 3x3 row-major; uniformMatrix3fv with
// transpose=true lets WebGL2 consume them directly.

// ─────────────────────────────────────────────────────────────
// Palette — kept in sync with gameplay.js. Each row is the hot
// and cool color for a stellar type, as RGB floats in [0, 1].
// ─────────────────────────────────────────────────────────────
const PALETTE = [
  [0x58/255, 0xe0/255, 0xfb/255, 0x3a/255, 0x7c/255, 0xe4/255], // ice blue
  [0xb3/255, 0x9b/255, 0xf8/255, 0x74/255, 0x49/255, 0xe4/255], // lavender
  [0xfa/255, 0x6d/255, 0xb0/255, 0xea/255, 0x3f/255, 0x8c/255], // magenta
  [0x38/255, 0xd6/255, 0xa0/255, 0x12/255, 0xb0/255, 0x83/255], // mint
  [0xff/255, 0xaa/255, 0x3c/255, 0xf0/255, 0x8c/255, 0x0c/255], // amber
  [0xf5/255, 0x6b/255, 0x6b/255, 0xe6/255, 0x38/255, 0x38/255], // coral
  [0x6a/255, 0xe8/255, 0xf4/255, 0x08/255, 0xb8/255, 0xd2/255], // teal
];

export function c1Of(idx) {
  const p = PALETTE[idx % PALETTE.length];
  return [p[0], p[1], p[2]];
}
export function c2Of(idx) {
  const p = PALETTE[idx % PALETTE.length];
  return [p[3], p[4], p[5]];
}

// ─────────────────────────────────────────────────────────────
// 2D matrix helpers. Row-major 3x3 stored in a Float32Array(9).
// WebGL2's uniformMatrix3fv accepts transpose=true, so we pass
// row-major straight through — no manual transpose.
// ─────────────────────────────────────────────────────────────
function mat3Identity() {
  return new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
}
function mat3Translate(tx, ty) {
  return new Float32Array([1, 0, tx, 0, 1, ty, 0, 0, 1]);
}
function mat3Scale(sx, sy) {
  return new Float32Array([sx, 0, 0, 0, sy, 0, 0, 0, 1]);
}
function mat3Multiply(A, B) {
  const out = new Float32Array(9);
  mat3MulInto(A, B, out);
  return out;
}
// In-place variants used by the hot camera path so per-frame
// matrix math allocates zero. `out` must not alias A or B.
function mat3SetTranslate(out, tx, ty) {
  out[0] = 1; out[1] = 0; out[2] = tx;
  out[3] = 0; out[4] = 1; out[5] = ty;
  out[6] = 0; out[7] = 0; out[8] = 1;
  return out;
}
function mat3SetScale(out, sx, sy) {
  out[0] = sx; out[1] = 0;  out[2] = 0;
  out[3] = 0;  out[4] = sy; out[5] = 0;
  out[6] = 0;  out[7] = 0;  out[8] = 1;
  return out;
}
function mat3MulInto(A, B, out) {
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += A[i * 3 + k] * B[k * 3 + j];
      out[i * 3 + j] = sum;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Program compile helper. Throws on failure with the info log so
// a bad shader surfaces in the dev console instead of silently
// producing a broken program. Collects uniform + attribute
// locations once so draw paths don't call getUniformLocation.
// ─────────────────────────────────────────────────────────────
function compileShader(gl, type, src, name) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error("shader compile failed [" + name + "]: " + log);
  }
  return sh;
}
function compileProgram(gl, vsSrc, fsSrc, name) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc, name + ".vs");
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc, name + ".fs");
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    throw new Error("program link failed [" + name + "]: " + log);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  const uniforms = {};
  const nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < nu; i++) {
    const info = gl.getActiveUniform(p, i);
    uniforms[info.name] = gl.getUniformLocation(p, info.name);
  }
  const attribs = {};
  const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < na; i++) {
    const info = gl.getActiveAttrib(p, i);
    attribs[info.name] = gl.getAttribLocation(p, info.name);
  }
  return { program: p, uniforms, attribs };
}

// ─────────────────────────────────────────────────────────────
// Shader sources.
// ─────────────────────────────────────────────────────────────

// Fullscreen quad. Uses gl_VertexID to synthesize the 4 corners —
// no vertex buffer needed at all.
const FULLSCREEN_VS = `#version 300 es
void main() {
  // 0 → (-1,-1), 1 → (1,-1), 2 → (-1,1), 3 → (1,1)
  float x = (gl_VertexID == 1 || gl_VertexID == 3) ? 1.0 : -1.0;
  float y = (gl_VertexID == 2 || gl_VertexID == 3) ? 1.0 : -1.0;
  gl_Position = vec4(x, y, 0.0, 1.0);
}
`;

const FULLSCREEN_FS = `#version 300 es
precision highp float;
uniform vec2 u_resolution;  // logical CSS pixels
uniform float u_dpr;
out vec4 outColor;

void main() {
  // Convert physical fragment coords to logical, top-down.
  vec2 frag = gl_FragCoord.xy / u_dpr;
  frag.y = u_resolution.y - frag.y;

  // Background radial gradient. Center is always #12121f.
  // On landscape (desktop) the fade reaches #0a0a12 at the
  // longer screen dimension, preserving the original look.
  // On portrait (mobile) the gradient:
  //   • uses the *shorter* dimension × 1.1 for the falloff
  //     span, so the bright center doesn't dominate the
  //     narrow viewport
  //   • fades all the way to pure black at the edges, not
  //     the very-dark-blue landscape target, so the mobile
  //     frame reads as a small lit area in dark space rather
  //     than a full-screen bluish cast.
  vec2 c = u_resolution * 0.5;
  float dist = length(frag - c);
  bool portrait = u_resolution.y > u_resolution.x;
  float span = portrait
    ? u_resolution.x * 1.1
    : max(u_resolution.x, u_resolution.y);
  vec3 nearCol = vec3(0.071, 0.071, 0.121);
  vec3 farCol = portrait
    ? vec3(0.0, 0.0, 0.0)
    : vec3(0.039, 0.039, 0.071);
  vec3 col = mix(nearCol, farCol, clamp(dist / span, 0.0, 1.0));

  outColor = vec4(col, 1.0);
}
`;

// Lensing composite — fullscreen pass that reads the scene FBO
// texture and applies gravitational lensing distortion around
// each visible black hole. Only runs on frames where at least
// one active black hole is on screen (~5% of gameplay frames);
// all other frames render directly to the default framebuffer
// with zero FBO overhead.
const LENSING_FS = `#version 300 es
precision highp float;
uniform sampler2D u_sceneTex;
uniform vec2 u_resolution;  // framebuffer pixels
uniform float u_time;
uniform int u_bhCount;
uniform vec4 u_bh[4];       // (fbX, fbY, fbR, 0) per black hole

out vec4 outColor;

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec2 distUV = uv;
  float mask = 1.0;

  for (int i = 0; i < 4; i++) {
    if (i >= u_bhCount) break;
    vec2 center = u_bh[i].xy;
    float R = u_bh[i].z;
    float lensR = R * 8.0;

    vec2 delta = gl_FragCoord.xy - center;
    float d = length(delta);
    vec2 dir = delta / max(d, 0.001);

    // Event horizon
    float eh = 1.0 - smoothstep(R * 0.75, R * 1.05, d);
    mask *= (1.0 - eh);

    // Lensing distortion
    if (d > R * 0.9 && d < lensR) {
      float t = R / d;
      float strength = t * t * R * 3.0;
      distUV -= dir * strength / u_resolution;
    }
  }

  vec4 scene = texture(u_sceneTex, distUV);

  // Photon ring per black hole
  for (int i = 0; i < 4; i++) {
    if (i >= u_bhCount) break;
    vec2 center = u_bh[i].xy;
    float R = u_bh[i].z;
    float d = length(gl_FragCoord.xy - center);
    float ring = exp(-pow((d - R * 1.4) / max(R * 0.06, 0.5), 2.0));
    float theta = atan(gl_FragCoord.y - center.y, gl_FragCoord.x - center.x);
    float shimmer = 0.75 + 0.25 * sin(theta * 3.0 - u_time * 2.5);
    scene.rgb += vec3(0.95, 0.85, 0.6) * ring * shimmer * 0.9;
  }

  outColor = vec4(scene.rgb * mask, 1.0);
}
`;

// Circle program: instanced quad, per-instance params control size,
// kind (solid / ring / glow / dashed ring), optional parallax depth
// for bgStars, optional twinkle. Drawn in world or screen space
// depending on the u_view matrix the caller sets.
const CIRCLE_VS = `#version 300 es
in vec2 a_vertex;
in vec2 a_center;
in vec2 a_radius;   // (outerR, innerR)
in vec4 a_color;    // premultiplied rgba
in vec4 a_animate;  // (depth, twinkleSpeed, twinklePhase, kind)

uniform mat3 u_view;
uniform float u_time;
uniform float u_camY;
uniform vec2 u_resolution;

out vec2 v_local;
out vec2 v_radii;
out vec4 v_color;
// flat: kind is an integer enum; smooth interpolation could drift
// it across the quad and break the int() cast in the fragment.
flat out float v_kind;

void main() {
  float depth = a_animate.x;
  float twSp = a_animate.y;
  float twPh = a_animate.z;

  vec2 center = a_center;
  // Parallax + vertical wrap for bgStars. depth == 0 means no effect,
  // so gameplay entities pass through unchanged.
  if (depth > 0.0) {
    float y = center.y + u_camY * depth;
    float wrapH = u_resolution.y + 200.0;
    center.y = mod(y + 100.0, wrapH) - 100.0;
  }

  float outerR = a_radius.x;
  vec2 local = a_vertex * outerR;
  vec2 worldPos = center + local;
  vec3 clip = u_view * vec3(worldPos, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);

  // Twinkle modulates alpha. Premultiplied color → scale all 4
  // components. Non-twinkling entities pass twSp = 0 which leaves
  // the color unchanged. Varies between 10% and 100% of baseline
  // so the dip is clearly visible — dots don't vanish, they dim.
  float tw = (twSp > 0.0) ? (0.55 + 0.45 * sin(u_time * twSp + twPh)) : 1.0;
  v_color = a_color * tw;

  v_local = local;
  v_radii = a_radius;
  v_kind = a_animate.w;
}
`;

const CIRCLE_FS = `#version 300 es
precision highp float;
in vec2 v_local;
in vec2 v_radii;
in vec4 v_color;
flat in float v_kind;
out vec4 outColor;

const float PI = 3.14159265;

void main() {
  float d = length(v_local);
  float outerR = v_radii.x;
  float innerR = v_radii.y;
  int kind = int(v_kind);
  float aw = fwidth(d);
  float a = 0.0;

  if (kind == 0) {
    // Solid disc.
    a = 1.0 - smoothstep(outerR - aw, outerR, d);
  } else if (kind == 1) {
    // Ring of thickness (outerR - innerR), antialiased on both edges.
    float outerEdge = 1.0 - smoothstep(outerR - aw, outerR, d);
    float innerEdge = 1.0 - smoothstep(innerR - aw, innerR, d);
    a = outerEdge - innerEdge;
  } else if (kind == 2) {
    // Glow: linear falloff from innerR (full) to outerR (zero).
    a = 1.0 - clamp((d - innerR) / max(outerR - innerR, 0.0001), 0.0, 1.0);
    a = a * a; // quadratic falloff
  } else if (kind == 3) {
    // Dashed ring — modulate a ring by polar-angle dashes.
    float outerEdge = 1.0 - smoothstep(outerR - aw, outerR, d);
    float innerEdge = 1.0 - smoothstep(innerR - aw, innerR, d);
    float ring = outerEdge - innerEdge;
    float theta = atan(v_local.y, v_local.x);
    float dash = step(0.4, fract(theta * (12.0 / (2.0 * PI))));
    a = ring * dash;
  }

  outColor = v_color * a;
}
`;

// Star program: instanced quad per active star. Fragment shader
// procedurally reproduces the layered Canvas2D drawStar visuals —
// corona, streamers, outer glow, photosphere with limb darkening,
// animated granules, core highlight — driven by u_time so every
// layer animates. Past stars are a separate short-circuit path.
const STAR_VS = `#version 300 es
in vec2 a_vertex;
in vec2 a_center;
in vec4 a_c1;        // (r, g, b, baseR)
in vec4 a_c2;        // (r, g, b, seed)
in vec4 a_params;    // (hasRays, nGran, pulse, flags)

uniform mat3 u_view;

out vec2 v_local;
out vec3 v_c1;
out vec3 v_c2;
out float v_baseR;
out float v_seed;
// flat: these carry integer-packed data or boolean flags. Default
// (smooth) varying interpolation can introduce tiny floating-point
// drift even when all quad vertices share the same value, which
// breaks an int() cast in the fragment shader. flat disables
// interpolation so the value is exactly what was written.
flat out float v_hasRays;
flat out float v_nGran;
out float v_pulse;
flat out float v_flags;

void main() {
  float baseR = a_c1.w;
  // Quad extent matches the on-screen footprint of the corona
  // (bodyR * 4.0) plus a small margin for streamers that shoot
  // a little past it on high-energy blobs.
  float extent = baseR * 4.3 + 8.0;
  vec2 local = a_vertex * extent;
  vec2 worldPos = a_center + local;
  vec3 clip = u_view * vec3(worldPos, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);

  v_local = local;
  v_c1 = a_c1.rgb;
  v_c2 = a_c2.rgb;
  v_baseR = baseR;
  v_seed = a_c2.w;
  v_hasRays = a_params.x;
  v_nGran = a_params.y;
  v_pulse = a_params.z;
  v_flags = a_params.w;
}
`;

const STAR_FS = `#version 300 es
precision highp float;

in vec2 v_local;
in vec3 v_c1;
in vec3 v_c2;
in float v_baseR;
in float v_seed;
flat in float v_hasRays;
flat in float v_nGran;
in float v_pulse;
flat in float v_flags;

uniform float u_time;

out vec4 outColor;

const float PI = 3.14159265;
const float TAU = 6.28318530;

void main() {
  float d = length(v_local);
  float tp = u_time + v_seed;

  int flags = int(v_flags);
  bool isCurrent = (flags & 1) != 0;
  bool isNext    = (flags & 2) != 0;
  bool isPast    = (flags & 4) != 0;
  bool isBlackHole = (flags & 8) != 0;

  if (isPast) {
    // Dim ember: small inner glow + a white pinpoint at the core.
    float auraR = v_baseR * 0.9;
    float aura = (1.0 - smoothstep(0.0, auraR, d)) * 0.22;
    float ember = (1.0 - smoothstep(0.0, 2.5, d)) * 0.45;
    float a = clamp(aura + ember, 0.0, 1.0);
    outColor = vec4(vec3(a), a);
    return;
  }

  // Black hole — Interstellar-style rendering. Two visual layers
  // composited over the dark event horizon:
  //
  //   1. Edge-on accretion disk: a thin bright horizontal band
  //      crossing IN FRONT of the event horizon (the disk is
  //      seen nearly edge-on from our viewing angle). The band
  //      has a white-hot inner edge and orange outer edge.
  //
  //   2. Lensed back-side arcs: the far half of the disk, whose
  //      light bends OVER and UNDER the event horizon via
  //      gravitational lensing. Appears as bright arcs hugging
  //      the top and bottom poles, curving outward to meet the
  //      horizontal band at the sides. This is the feature that
  //      makes a black hole look unmistakably like Gargantua.
  //
  // The lensing composite pass adds UV distortion + the thin
  // photon ring on top of this.
  if (isBlackHole) {
    float aw = fwidth(d);
    vec4 color = vec4(0.0);

    // Per-black-hole disk tilt — each black hole gets a
    // slightly different accretion-disk angle derived from
    // its position-based seed (v_seed, range [0, 2π]).
    // Mapped to ±20° (±0.35 rad) so every black hole looks
    // distinct but no disk is vertical.
    float diskTilt = (v_seed / TAU - 0.5) * 0.7
                   + sin(u_time * 0.3 + v_seed) * 0.12;
    float ca = cos(diskTilt);
    float sa = sin(diskTilt);
    vec2 rl = vec2(
      v_local.x * ca - v_local.y * sa,
      v_local.x * sa + v_local.y * ca
    );

    // Event horizon — opaque black disk, antialiased edge.
    // Uses d (rotation-invariant), not the tilted coords.
    float ehMask = 1.0 - smoothstep(v_baseR - aw, v_baseR + aw, d);
    color = vec4(0.0, 0.0, 0.0, ehMask);

    // Main disk — thin band along the tilted axis, passing
    // in front of the event horizon. Uses rotated local (rl)
    // so the band direction matches the tilt angle.
    float diskHalfH = v_baseR * 0.18;
    float bandFade = smoothstep(diskHalfH, diskHalfH * 0.1, abs(rl.y));
    float rFade = 1.0 - clamp(d / (v_baseR * 3.5), 0.0, 1.0);
    rFade *= rFade;
    vec3 diskCol = mix(vec3(1.0, 0.95, 0.85), vec3(1.0, 0.4, 0.05),
                       clamp(d / (v_baseR * 3.0), 0.0, 1.0));
    float sideAngle = atan(rl.y, rl.x) - u_time * 0.8;
    float sideBoost = 0.65 + 0.35 * cos(sideAngle);
    float diskA = bandFade * rFade * sideBoost;

    // Lensed back-side arcs — asymmetric in the tilted frame.
    // "bottom" (negative rl.y) is brighter/wider, "top" is
    // dimmer/thinner. The tilt rotation makes each black
    // hole's bright arc point in a different direction.
    bool isBottom = rl.y < 0.0;
    float arcCenter = v_baseR * (isBottom ? 1.35 : 1.18);
    float arcWidth = v_baseR * v_baseR * (isBottom ? 0.08 : 0.035);
    float arcBright = isBottom ? 0.7 : 0.3;
    float wrapR = abs(d - arcCenter);
    float wrapGlow = exp(-wrapR * wrapR / arcWidth);
    float vertBias = abs(rl.y) / max(d, 0.001);
    float wrapA = wrapGlow * smoothstep(0.15, 0.6, vertBias) * arcBright;
    vec3 wrapCol = isBottom
      ? vec3(1.0, 0.75, 0.35)
      : vec3(0.85, 0.65, 0.35);

    // Composite both disk layers over the event horizon.
    // The disk band crosses in front of the black center;
    // the lensed arcs hug above and below it.
    float totalA = min(1.0, diskA + wrapA);
    if (totalA > 0.001) {
      vec3 combined = (diskCol * diskA + wrapCol * wrapA) / totalA;
      color.rgb = mix(color.rgb, combined, totalA);
      color.a = max(color.a, totalA);
    }

    outColor = color;
    return;
  }

  // Pulse / flare / catch-shockwave scaling matches drawStar exactly.
  float pulse = 1.0 + 0.04 * sin(tp * 1.6);
  float flare = 0.8 + 0.2 * sin(tp * 3.2);
  float catchBoost = 1.0 + v_pulse * 0.45;
  float bodyR = v_baseR * pulse * catchBoost;

  // Early-out: the quad that wraps a star is baseR*4.3 + 8 in
  // half-extent, but the corona only reaches bodyR*4.0. That
  // leaves ~37% of the quad as guaranteed-transparent corner
  // fragments, which would otherwise run the full streamer +
  // granule loops below for no visible result. Testing against
  // the live coronaR (not a constant) means this works correctly
  // during catch-shockwave pulses where bodyR temporarily grows.
  float coronaR = bodyR * 4.0;
  if (d > coronaR) {
    outColor = vec4(0.0);
    return;
  }

  // Premultiplied accumulator. We composite layers back-to-front.
  vec4 color = vec4(0.0);

  // ── Layer 1: Corona (3-stop falloff matching the Canvas2D gradient)
  {
    float t = clamp((d - bodyR * 0.9) / max(coronaR - bodyR * 0.9, 0.001), 0.0, 1.0);
    float ca;
    if (t < 0.35) {
      ca = mix(46.0 / 255.0, 18.0 / 255.0, t / 0.35);
    } else {
      ca = mix(18.0 / 255.0, 0.0, (t - 0.35) / 0.65);
    }
    ca = max(ca, 0.0);
    color = vec4(v_c1 * ca, ca);
  }

  // ── Fused granule-data loop. The streamer and granulation
  // passes both need ga / gr / gsize per granule, derived from
  // the same three sin() formulas. Computing once and consuming
  // twice halves the trig cost on body-interior fragments (where
  // both passes run). The loop also folds in cos(ga) / sin(ga),
  // which the streamer uses for its axis and the granulation
  // uses for its blob position. We accumulate a scalar streamer
  // contribution and a scalar granulation contribution, which
  // are composited over the accumulator by their owning layers
  // below in the usual back-to-front order.
  float streamerA = 0.0;
  float granA = 0.0;
  bool doStreamers = v_hasRays > 0.5;
  bool doGranules = d < bodyR * 0.985;
  if (doStreamers || doGranules) {
    int nGran = int(v_nGran);
    for (int i = 0; i < 8; i++) {
      if (i >= nGran) break;
      float fi = float(i);
      float ga = tp * 0.35 + fi * (TAU / v_nGran) + 0.7 * sin(tp + fi);
      float gr = bodyR * (0.2 + 0.45 * (0.5 + 0.5 * sin(tp * 0.9 + fi * 2.1)));
      float gsize = bodyR * (0.28 + 0.1 * sin(tp * 1.5 + fi));
      float cosA = cos(ga);
      float sinA = sin(ga);

      if (doStreamers) {
        float energy = min(1.0, gr / (bodyR * 0.65));
        float flick = 0.55 + 0.45 * sin(tp * 2.0 + fi * 1.13);
        float tipDist = bodyR * (0.5 + 1.0 * energy + 0.4 * flick);
        float baseAlong = bodyR * 0.92;
        float tipAlong = bodyR + tipDist;
        if (tipAlong > baseAlong) {
          float along = v_local.x * cosA + v_local.y * sinA;
          float perp = -v_local.x * sinA + v_local.y * cosA;
          if (along >= baseAlong && along <= tipAlong) {
            float segT = (along - baseAlong) / (tipAlong - baseAlong);
            float halfW = gsize * 0.55 * (1.0 - segT * 0.85);
            if (halfW > 0.001) {
              float lateral = 1.0 - smoothstep(halfW * 0.5, halfW, abs(perp));
              float baseAlpha = (95.0 / 255.0) * flick * (0.5 + 0.5 * energy);
              streamerA += baseAlpha * (1.0 - segT) * lateral;
            }
          }
        }
      }

      if (doGranules) {
        vec2 gpos = vec2(cosA, sinA) * gr;
        float gd = distance(v_local, gpos);
        float gAlpha = (1.0 - smoothstep(0.0, max(gsize, 0.001), gd)) * 0.32;
        granA += gAlpha;
      }
    }
  }

  // ── Layer 2: Coronal streamers over the corona.
  if (doStreamers) {
    streamerA = clamp(streamerA, 0.0, 1.0);
    vec3 sRgb = v_c1 * streamerA;
    color.rgb = sRgb + color.rgb * (1.0 - streamerA);
    color.a = streamerA + color.a * (1.0 - streamerA);
  }

  // ── Layer 3: Outer glow.
  float glowR = bodyR * 1.9;
  if (d < glowR) {
    float t = clamp((d - bodyR * 0.75) / max(glowR - bodyR * 0.75, 0.001), 0.0, 1.0);
    float glowBase = isCurrent ? (175.0 / 255.0) : (isNext ? (140.0 / 255.0) : (110.0 / 255.0));
    float glowA = glowBase * flare * (1.0 - t);
    if (d < bodyR * 0.75) glowA = glowBase * flare;
    glowA = clamp(glowA, 0.0, 1.0);
    vec3 gRgb = v_c1 * glowA;
    color.rgb = gRgb + color.rgb * (1.0 - glowA);
    color.a = glowA + color.a * (1.0 - glowA);
  }

  // ── Layer 4: Photosphere disk with a soft SDF-AA edge. Using
  // a smoothstep at the edge (width = 1 pixel of fwidth(d)) means
  // the disk composites cleanly over the corona/glow instead of
  // showing a 1-pixel hard ring, which is what lets us ship with
  // antialias: false on the GL context.
  float aw = fwidth(d);
  float diskMask = 1.0 - smoothstep(bodyR - aw, bodyR + aw, d);
  if (diskMask > 0.0) {
    vec2 offset = vec2(-bodyR * 0.12, -bodyR * 0.12);
    float od = length(v_local - offset);
    float t = clamp(od / bodyR, 0.0, 1.0);
    vec3 diskColor;
    if (t < 0.28) diskColor = mix(vec3(1.0), v_c1, t / 0.28);
    else if (t < 0.78) diskColor = v_c1;
    else diskColor = mix(v_c1, v_c2, (t - 0.78) / 0.22);

    // Mix the opaque disk over the current accumulator — not a
    // plain overwrite — so the AA edge smoothly hands over to
    // the corona/glow in the pixel immediately outside bodyR.
    color.rgb = mix(color.rgb, diskColor, diskMask);
    color.a = max(color.a, diskMask);
  }

  // ── Layer 5: Granulation (already accumulated in granA above).
  if (doGranules) {
    color.rgb = clamp(color.rgb + vec3(granA), 0.0, 1.0);
  }

  // ── Layer 6: Core highlight — hot white spot offset top-left.
  {
    vec2 offset = vec2(-bodyR * 0.1, -bodyR * 0.1);
    float od = length(v_local - offset);
    float coreR = bodyR * 0.22 * flare;
    float coreA = (1.0 - smoothstep(0.0, max(coreR * 2.0, 0.001), od));
    color.rgb = mix(color.rgb, vec3(1.0), coreA * color.a);
  }

  outColor = color;
}
`;

// Polyline program: takes a line-strip vertex buffer and extrudes
// each point into a pair of triangle-strip vertices offset along
// the local normal. Progress ∈ [0, 1] interpolates head→tail color.
// Per-pixel SDF smoothing on |side| gives the line a soft edge
// without relying on MSAA.
const POLYLINE_VS = `#version 300 es
in vec2 a_pos;
in vec2 a_normal;
in float a_side;
in float a_progress;

uniform mat3 u_view;
uniform float u_halfWidth;

out float v_side;
out float v_progress;

void main() {
  vec2 offs = a_normal * a_side * u_halfWidth;
  vec2 worldPos = a_pos + offs;
  vec3 clip = u_view * vec3(worldPos, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
  v_side = a_side;
  v_progress = a_progress;
}
`;

const POLYLINE_FS = `#version 300 es
precision highp float;
in float v_side;
in float v_progress;
uniform vec4 u_colorTail; // premultiplied
uniform vec4 u_colorHead; // premultiplied
out vec4 outColor;

void main() {
  // Soft edge: fade out near |side| == 1.
  float edge = 1.0 - smoothstep(0.75, 1.0, abs(v_side));
  vec4 col = mix(u_colorTail, u_colorHead, v_progress);
  outColor = col * edge;
}
`;

// ─────────────────────────────────────────────────────────────
// createRenderer — acquires the WebGL2 context, compiles every
// program, builds dynamic buffers, and returns the draw API.
// Returns null if WebGL2 is unavailable, so gameplay.js can show
// an unsupported-device message.
// ─────────────────────────────────────────────────────────────
export function createRenderer(canvas) {
  // antialias: false — every edge in this pipeline is SDF-smoothed
  // in the fragment shader (fwidth for circles, smoothstep on |side|
  // for polylines, smoothstep on disk edge for stars). MSAA would
  // buy us nothing here and costs color-write bandwidth on tiled
  // mobile GPUs, which is the platform where performance matters
  // most. colorSpace: "srgb" is the default today but being explicit
  // future-proofs us for when HDR canvas support lands.
  const gl = canvas.getContext("webgl2", {
    antialias: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    alpha: false,
    depth: false,
    stencil: false,
    colorSpace: "srgb",
  });
  if (!gl) return null;

  // Enable standard derivatives (fwidth) — core in WebGL2, but
  // fragment shader still needs the extension declaration in some
  // drivers. In WebGL2 this is implicit, so no extension call here.

  const fullscreenProg = compileProgram(gl, FULLSCREEN_VS, FULLSCREEN_FS, "fullscreen");
  const lensingProg    = compileProgram(gl, FULLSCREEN_VS, LENSING_FS, "lensing");
  const circleProg     = compileProgram(gl, CIRCLE_VS, CIRCLE_FS, "circle");
  const starProg       = compileProgram(gl, STAR_VS, STAR_FS, "star");
  const polylineProg   = compileProgram(gl, POLYLINE_VS, POLYLINE_FS, "polyline");

  // ── Conditional scene FBO for gravitational lensing ─────
  // Only created and bound on frames where at least one active
  // black hole is on screen. All other frames render directly
  // to the default framebuffer — zero FBO overhead. When active,
  // the scene goes to this texture and a fullscreen lensing
  // composite pass reads it with UV distortion.
  let sceneFbo = null;
  let sceneTex = null;
  let fboActive = false;
  function ensureSceneFbo() {
    const fbW = Math.round(viewW * viewDPR);
    const fbH = Math.round(viewH * viewDPR);
    if (!sceneFbo) {
      sceneTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, sceneTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, fbW, fbH,
                    0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      sceneFbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
                              gl.TEXTURE_2D, sceneTex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  }
  function resizeSceneFbo() {
    if (!sceneTex) return;
    const fbW = Math.round(viewW * viewDPR);
    const fbH = Math.round(viewH * viewDPR);
    gl.bindTexture(gl.TEXTURE_2D, sceneTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, fbW, fbH,
                  0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }

  // Unit quad in (-1, 1). Shared between the circle and star programs.
  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,
     1, -1,
    -1,  1,
     1,  1,
  ]), gl.STATIC_DRAW);

  // ── Circle VAO ─────────────────────────────────────────────
  // Vertex 0 = quad corner attribute (static).
  // Instance attributes come from a separate STREAM_DRAW buffer
  // rebuilt each frame. Instance stride is 12 floats (48 bytes):
  //   vec2 center, vec2 radius, vec4 color, vec4 animate
  const circleInstanceBuf = gl.createBuffer();
  const CIRCLE_FLOATS_PER_INSTANCE = 12;
  const circleVao = gl.createVertexArray();
  gl.bindVertexArray(circleVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.enableVertexAttribArray(circleProg.attribs.a_vertex);
  gl.vertexAttribPointer(circleProg.attribs.a_vertex, 2, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(circleProg.attribs.a_vertex, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, circleInstanceBuf);
  const cStride = CIRCLE_FLOATS_PER_INSTANCE * 4;
  gl.enableVertexAttribArray(circleProg.attribs.a_center);
  gl.vertexAttribPointer(circleProg.attribs.a_center, 2, gl.FLOAT, false, cStride, 0);
  gl.vertexAttribDivisor(circleProg.attribs.a_center, 1);
  gl.enableVertexAttribArray(circleProg.attribs.a_radius);
  gl.vertexAttribPointer(circleProg.attribs.a_radius, 2, gl.FLOAT, false, cStride, 8);
  gl.vertexAttribDivisor(circleProg.attribs.a_radius, 1);
  gl.enableVertexAttribArray(circleProg.attribs.a_color);
  gl.vertexAttribPointer(circleProg.attribs.a_color, 4, gl.FLOAT, false, cStride, 16);
  gl.vertexAttribDivisor(circleProg.attribs.a_color, 1);
  gl.enableVertexAttribArray(circleProg.attribs.a_animate);
  gl.vertexAttribPointer(circleProg.attribs.a_animate, 4, gl.FLOAT, false, cStride, 32);
  gl.vertexAttribDivisor(circleProg.attribs.a_animate, 1);
  gl.bindVertexArray(null);

  // ── Star VAO ──────────────────────────────────────────────
  // Instance stride is 14 floats (56 bytes):
  //   vec2 center, vec4 c1, vec4 c2, vec4 params
  const starInstanceBuf = gl.createBuffer();
  const STAR_FLOATS_PER_INSTANCE = 14;
  const starVao = gl.createVertexArray();
  gl.bindVertexArray(starVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.enableVertexAttribArray(starProg.attribs.a_vertex);
  gl.vertexAttribPointer(starProg.attribs.a_vertex, 2, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(starProg.attribs.a_vertex, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, starInstanceBuf);
  const sStride = STAR_FLOATS_PER_INSTANCE * 4;
  gl.enableVertexAttribArray(starProg.attribs.a_center);
  gl.vertexAttribPointer(starProg.attribs.a_center, 2, gl.FLOAT, false, sStride, 0);
  gl.vertexAttribDivisor(starProg.attribs.a_center, 1);
  gl.enableVertexAttribArray(starProg.attribs.a_c1);
  gl.vertexAttribPointer(starProg.attribs.a_c1, 4, gl.FLOAT, false, sStride, 8);
  gl.vertexAttribDivisor(starProg.attribs.a_c1, 1);
  gl.enableVertexAttribArray(starProg.attribs.a_c2);
  gl.vertexAttribPointer(starProg.attribs.a_c2, 4, gl.FLOAT, false, sStride, 24);
  gl.vertexAttribDivisor(starProg.attribs.a_c2, 1);
  gl.enableVertexAttribArray(starProg.attribs.a_params);
  gl.vertexAttribPointer(starProg.attribs.a_params, 4, gl.FLOAT, false, sStride, 40);
  gl.vertexAttribDivisor(starProg.attribs.a_params, 1);
  gl.bindVertexArray(null);

  // ── Polyline VAO ──────────────────────────────────────────
  // Vertex stride is 6 floats (24 bytes):
  //   vec2 pos, vec2 normal, float side, float progress
  const polylineBuf = gl.createBuffer();
  const POLYLINE_FLOATS_PER_VERTEX = 6;
  const polylineVao = gl.createVertexArray();
  gl.bindVertexArray(polylineVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, polylineBuf);
  const pStride = POLYLINE_FLOATS_PER_VERTEX * 4;
  gl.enableVertexAttribArray(polylineProg.attribs.a_pos);
  gl.vertexAttribPointer(polylineProg.attribs.a_pos, 2, gl.FLOAT, false, pStride, 0);
  gl.enableVertexAttribArray(polylineProg.attribs.a_normal);
  gl.vertexAttribPointer(polylineProg.attribs.a_normal, 2, gl.FLOAT, false, pStride, 8);
  gl.enableVertexAttribArray(polylineProg.attribs.a_side);
  gl.vertexAttribPointer(polylineProg.attribs.a_side, 1, gl.FLOAT, false, pStride, 16);
  gl.enableVertexAttribArray(polylineProg.attribs.a_progress);
  gl.vertexAttribPointer(polylineProg.attribs.a_progress, 1, gl.FLOAT, false, pStride, 20);
  gl.bindVertexArray(null);

  // ── Scratch typed-array pools. Grown on demand so the steady
  //    state doesn't allocate. ──────────────────────────────
  let circleScratch = new Float32Array(64 * CIRCLE_FLOATS_PER_INSTANCE);
  let starScratch = new Float32Array(32 * STAR_FLOATS_PER_INSTANCE);
  let polylineScratch = new Float32Array(512 * POLYLINE_FLOATS_PER_VERTEX);
  function ensureCircleScratch(n) {
    const needed = n * CIRCLE_FLOATS_PER_INSTANCE;
    if (circleScratch.length < needed) {
      let len = circleScratch.length;
      while (len < needed) len *= 2;
      circleScratch = new Float32Array(len);
    }
  }
  function ensureStarScratch(n) {
    const needed = n * STAR_FLOATS_PER_INSTANCE;
    if (starScratch.length < needed) {
      let len = starScratch.length;
      while (len < needed) len *= 2;
      starScratch = new Float32Array(len);
    }
  }
  function ensurePolylineScratch(n) {
    const needed = n * POLYLINE_FLOATS_PER_VERTEX;
    if (polylineScratch.length < needed) {
      let len = polylineScratch.length;
      while (len < needed) len *= 2;
      polylineScratch = new Float32Array(len);
    }
  }

  // ── Parallax background starfield ──────────────────────────
  // Generated once at setViewport and uploaded as a static-ish
  // instance buffer. The circle program handles parallax via
  // per-instance depth + u_camY in the vertex shader, and twinkle
  // via per-instance speed/phase + u_time.
  let bgStars = null;
  function initBgStars(W, H) {
    const n = 220;
    ensureCircleScratch(n);
    const tintWhite = [1, 1, 1];
    const tintBlue  = [0.74, 0.83, 1.0];
    const tintWarm  = [1.0, 0.9, 0.76];
    for (let i = 0; i < n; i++) {
      const base = i * CIRCLE_FLOATS_PER_INSTANCE;
      const x = Math.random() * W;
      const y = Math.random() * H;
      const depth = 0.05 + Math.random() * 0.35;
      const size = 0.8 + Math.random() * 1.8;
      const brightness = 0.4 + Math.random() * 0.4;
      let tint = tintWhite;
      const r = Math.random();
      if (r > 0.88) tint = tintBlue;
      else if (r > 0.75) tint = tintWarm;
      // Premultiplied rgba
      const a = brightness;
      circleScratch[base + 0] = x;
      circleScratch[base + 1] = y;
      circleScratch[base + 2] = size;      // outerR
      circleScratch[base + 3] = 0;         // innerR
      circleScratch[base + 4] = tint[0] * a;
      circleScratch[base + 5] = tint[1] * a;
      circleScratch[base + 6] = tint[2] * a;
      circleScratch[base + 7] = a;
      circleScratch[base + 8] = depth;
      circleScratch[base + 9] = 1.4 + Math.random() * 2.5;   // twinkle speed
      circleScratch[base + 10] = Math.random() * Math.PI * 2; // twinkle phase
      circleScratch[base + 11] = 0;         // kind = solid
    }
    // Snapshot to a dedicated buffer so the scratch can be reused.
    bgStars = { count: n, data: circleScratch.slice(0, n * CIRCLE_FLOATS_PER_INSTANCE) };
    gl.bindBuffer(gl.ARRAY_BUFFER, bgStarsBuf);
    gl.bufferData(gl.ARRAY_BUFFER, bgStars.data, gl.STATIC_DRAW);
  }
  const bgStarsBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, bgStarsBuf);
  gl.bufferData(gl.ARRAY_BUFFER, 1, gl.STATIC_DRAW);

  // bgStars draws through the same circle program. We build a
  // dedicated VAO bound to bgStarsBuf so we don't re-upload on
  // every frame.
  const bgStarsVao = gl.createVertexArray();
  gl.bindVertexArray(bgStarsVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.enableVertexAttribArray(circleProg.attribs.a_vertex);
  gl.vertexAttribPointer(circleProg.attribs.a_vertex, 2, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(circleProg.attribs.a_vertex, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, bgStarsBuf);
  gl.enableVertexAttribArray(circleProg.attribs.a_center);
  gl.vertexAttribPointer(circleProg.attribs.a_center, 2, gl.FLOAT, false, cStride, 0);
  gl.vertexAttribDivisor(circleProg.attribs.a_center, 1);
  gl.enableVertexAttribArray(circleProg.attribs.a_radius);
  gl.vertexAttribPointer(circleProg.attribs.a_radius, 2, gl.FLOAT, false, cStride, 8);
  gl.vertexAttribDivisor(circleProg.attribs.a_radius, 1);
  gl.enableVertexAttribArray(circleProg.attribs.a_color);
  gl.vertexAttribPointer(circleProg.attribs.a_color, 4, gl.FLOAT, false, cStride, 16);
  gl.vertexAttribDivisor(circleProg.attribs.a_color, 1);
  gl.enableVertexAttribArray(circleProg.attribs.a_animate);
  gl.vertexAttribPointer(circleProg.attribs.a_animate, 4, gl.FLOAT, false, cStride, 32);
  gl.vertexAttribDivisor(circleProg.attribs.a_animate, 1);
  gl.bindVertexArray(null);

  // ── Viewport / camera state ────────────────────────────────
  let viewW = 0, viewH = 0, viewDPR = 1;
  let screenMat = mat3Identity();
  let frameTime = 0;
  let frameCamY = 0;

  // Pooled scratch matrices for cameraMat's hot path. Pre-
  // allocated once so per-frame camera math does zero GC.
  // _camResult is the stable reference returned to callers;
  // each cameraMat() invocation overwrites it in place and the
  // caller consumes it within the same frame before the next
  // call. Don't hold on to the returned reference across frames.
  const _camT2 = new Float32Array(9);
  const _camT3 = new Float32Array(9);
  const _camS  = new Float32Array(9);
  const _camT4 = new Float32Array(9);
  const _camTmpA = new Float32Array(9);
  const _camTmpB = new Float32Array(9);
  const _camResult = new Float32Array(9);

  function rebuildScreenMat() {
    // Screen pixels → clip space, Y flipped so top-left = (-1, 1).
    screenMat = new Float32Array([
      2 / viewW, 0, -1,
      0, -2 / viewH, 1,
      0, 0, 1,
    ]);
  }

  function setViewport(W, H, DPR) {
    viewW = W;
    viewH = H;
    viewDPR = DPR;
    gl.viewport(0, 0, Math.round(W * DPR), Math.round(H * DPR));
    rebuildScreenMat();
    initBgStars(W, H);
    ensureSceneFbo();
    resizeSceneFbo();
  }

  function cameraMat(camY, zoom, focusY) {
    // Matches Canvas2D's transform chain:
    //   translate(W/2, H*focusY) * scale(zoom) * translate(-W/2, -H*focusY) * translate(0, camY)
    // applied to a world point — screen = T4 * S * T3 * T2 * world.
    // `focusY` is the fraction of screen height where the current
    // star sits. 0.55 is the default (slightly below center);
    // portrait/mobile passes a larger value (e.g. 0.62) so the
    // star sits lower, leaving more sky visible above.
    // Composed left-associatively into the pooled scratch so the
    // whole chain runs without a single heap allocation.
    if (focusY === undefined) focusY = 0.55;
    mat3SetTranslate(_camT2, 0, camY);
    mat3SetTranslate(_camT3, -viewW / 2, -viewH * focusY);
    mat3SetScale(_camS, zoom, zoom);
    mat3SetTranslate(_camT4, viewW / 2, viewH * focusY);
    mat3MulInto(_camT3, _camT2, _camTmpA);        // tmpA = T3 * T2
    mat3MulInto(_camS,  _camTmpA, _camTmpB);      // tmpB = S  * tmpA
    mat3MulInto(_camT4, _camTmpB, _camTmpA);      // tmpA = T4 * tmpB
    mat3MulInto(screenMat, _camTmpA, _camResult); // result = screen * tmpA
    return _camResult;
  }

  function replayMat(scale, ox, oy) {
    // Bounds-fit transform: world (x, y) → screen (x*scale + ox, y*scale + oy).
    // Then compose with screen-to-clip to get world-to-clip in one matrix.
    const bounds = new Float32Array([
      scale, 0, ox,
      0, scale, oy,
      0, 0, 1,
    ]);
    return mat3Multiply(screenMat, bounds);
  }

  // Empty VAO for buffer-less fullscreen draws (the fullscreen
  // vertex shader uses gl_VertexID to synthesize the quad). Bound
  // explicitly by drawBackground so the GL state is unambiguous —
  // "null VAO" works because WebGL2 has a default VAO, but it's
  // a silent trap the moment someone adds an `in` to FULLSCREEN_VS.
  const emptyVao = gl.createVertexArray();

  // Persistent GL state — set once here and never touched in the
  // hot path.
  gl.clearColor(0.039, 0.039, 0.071, 1);
  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  // ── Lost context handling ─────────────────────────────────
  // Mobile Safari tears down the GL context when the tab
  // backgrounds. preventDefault() tells the browser to try to
  // restore us; on restore we ask for a reload since rebuilding
  // every program and buffer mid-frame is not worth the code.
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
  }, false);
  canvas.addEventListener("webglcontextrestored", () => {
    // Simplest recovery path: force a page reload. The game is a
    // single-screen web app so there's nothing to lose.
    location.reload();
  }, false);

  // ── Draw API ──────────────────────────────────────────────

  function beginFrame(timeSec, useFbo) {
    // If a black hole is visible this frame, route all draws
    // through the scene FBO so the lensing composite can read
    // them. Otherwise render directly to the default
    // framebuffer — zero FBO overhead on ~95% of frames.
    frameTime = timeSec;
    fboActive = !!useFbo;
    if (fboActive) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFbo);
    }
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  // Fullscreen lensing composite — reads the scene FBO texture
  // with UV distortion around each visible black hole and
  // writes to the default framebuffer. Only called when the
  // FBO was active (i.e. at least one BH on screen). If
  // blackHoles is empty, this is a no-op.
  function finalizeFrame(blackHoles) {
    if (!fboActive) return;
    // Switch from FBO to the default framebuffer.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const n = Math.min(blackHoles ? blackHoles.length : 0, 4);
    gl.useProgram(lensingProg.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sceneTex);
    gl.uniform1i(lensingProg.uniforms.u_sceneTex, 0);
    const fbW = Math.round(viewW * viewDPR);
    const fbH = Math.round(viewH * viewDPR);
    gl.uniform2f(lensingProg.uniforms.u_resolution, fbW, fbH);
    gl.uniform1f(lensingProg.uniforms.u_time, frameTime);
    gl.uniform1i(lensingProg.uniforms.u_bhCount, n);
    if (n > 0) {
      const data = new Float32Array(16);
      for (let i = 0; i < n; i++) {
        data[i * 4 + 0] = blackHoles[i].fbX;
        data[i * 4 + 1] = blackHoles[i].fbY;
        data[i * 4 + 2] = blackHoles[i].fbR;
        data[i * 4 + 3] = 0;
      }
      gl.uniform4fv(lensingProg.uniforms["u_bh[0]"], data);
    }
    gl.bindVertexArray(emptyVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    fboActive = false;
  }

  function drawBackground(camY) {
    frameCamY = camY;
    gl.useProgram(fullscreenProg.program);
    gl.uniform2f(fullscreenProg.uniforms.u_resolution, viewW, viewH);
    gl.uniform1f(fullscreenProg.uniforms.u_dpr, viewDPR);
    gl.bindVertexArray(emptyVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function drawBgStars() {
    if (!bgStars) return;
    gl.useProgram(circleProg.program);
    gl.uniformMatrix3fv(circleProg.uniforms.u_view, true, screenMat);
    gl.uniform1f(circleProg.uniforms.u_time, frameTime);
    gl.uniform1f(circleProg.uniforms.u_camY, frameCamY);
    gl.uniform2f(circleProg.uniforms.u_resolution, viewW, viewH);
    gl.bindVertexArray(bgStarsVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, bgStars.count);
  }

  // Generic per-frame circle batch. `instances` is an array of
  // plain objects each with: x, y, outerR, innerR, r, g, b, a,
  // kind (0=solid, 1=ring, 2=glow, 3=dashed ring). color is
  // non-premultiplied — we premultiply here so the kind=2 glow
  // falls off cleanly to transparent.
  function drawCircleBatch(instances, viewMat) {
    const n = instances.length;
    if (n === 0) return;
    ensureCircleScratch(n);
    for (let i = 0; i < n; i++) {
      const it = instances[i];
      const base = i * CIRCLE_FLOATS_PER_INSTANCE;
      const a = it.a !== undefined ? it.a : 1;
      circleScratch[base + 0] = it.x;
      circleScratch[base + 1] = it.y;
      circleScratch[base + 2] = it.outerR;
      circleScratch[base + 3] = it.innerR || 0;
      circleScratch[base + 4] = it.r * a;
      circleScratch[base + 5] = it.g * a;
      circleScratch[base + 6] = it.b * a;
      circleScratch[base + 7] = a;
      circleScratch[base + 8] = 0; // depth — gameplay entities don't parallax
      circleScratch[base + 9] = 0; // no twinkle
      circleScratch[base + 10] = 0;
      circleScratch[base + 11] = it.kind || 0;
    }
    gl.useProgram(circleProg.program);
    gl.uniformMatrix3fv(circleProg.uniforms.u_view, true, viewMat);
    gl.uniform1f(circleProg.uniforms.u_time, frameTime);
    // u_camY and u_resolution are only read inside the shader's
    // `if (depth > 0.0)` branch, which is for bgStars parallax.
    // Gameplay circles always pass depth = 0, so both uniforms
    // are dead on this path. We leave whatever drawBgStars wrote
    // last frame — the values don't matter, they're never sampled.
    gl.bindVertexArray(circleVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, circleInstanceBuf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      circleScratch.subarray(0, n * CIRCLE_FLOATS_PER_INSTANCE),
      gl.STREAM_DRAW
    );
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
  }

  // Star batch. `stars` is an array of plain objects with fields:
  // x, y, r, colorIdx, pulse, hasRays, nGran, and optional
  // isCurrent / isNext / isPast boolean overrides. viewMat is the
  // world-to-clip transform. `seeds` is parallel if provided; if
  // not, seed is derived from position.
  function drawStarBatch(stars, viewMat) {
    const n = stars.length;
    if (n === 0) return;
    ensureStarScratch(n);
    for (let i = 0; i < n; i++) {
      const s = stars[i];
      const base = i * STAR_FLOATS_PER_INSTANCE;
      const c1 = c1Of(s.colorIdx);
      const c2 = c2Of(s.colorIdx);
      // Same position-derived phase as drawStar used in Canvas2D,
      // so every star stays out of sync with its neighbours.
      const seed = (Math.sin(s.x * 0.0137 + s.y * 0.0191) * 0.5 + 0.5) * Math.PI * 2;
      let flags = 0;
      if (s.isCurrent)  flags |= 1;
      if (s.isNext)     flags |= 2;
      if (s.isPast)     flags |= 4;
      if (s.isBlackHole) flags |= 8;
      starScratch[base + 0] = s.x;
      starScratch[base + 1] = s.y;
      starScratch[base + 2] = c1[0];
      starScratch[base + 3] = c1[1];
      starScratch[base + 4] = c1[2];
      starScratch[base + 5] = s.r;
      starScratch[base + 6] = c2[0];
      starScratch[base + 7] = c2[1];
      starScratch[base + 8] = c2[2];
      starScratch[base + 9] = seed;
      starScratch[base + 10] = s.hasRays ? 1 : 0;
      starScratch[base + 11] = s.nGran;
      starScratch[base + 12] = s.pulse || 0;
      starScratch[base + 13] = flags;
    }
    gl.useProgram(starProg.program);
    gl.uniformMatrix3fv(starProg.uniforms.u_view, true, viewMat);
    gl.uniform1f(starProg.uniforms.u_time, frameTime);
    gl.bindVertexArray(starVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, starInstanceBuf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      starScratch.subarray(0, n * STAR_FLOATS_PER_INSTANCE),
      gl.STREAM_DRAW
    );
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
  }

  // Polyline. `points` is an array of {x, y} in world space.
  // Colors are premultiplied rgba tuples.
  function drawPolyline(points, viewMat, halfWidth, colorTail, colorHead) {
    const n = points.length;
    if (n < 2) return;
    ensurePolylineScratch(n * 2);
    let w = 0;
    for (let i = 0; i < n; i++) {
      const prev = points[i === 0 ? 0 : i - 1];
      const next = points[i === n - 1 ? n - 1 : i + 1];
      let dx = next.x - prev.x;
      let dy = next.y - prev.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const nx = -dy;
      const ny = dx;
      const progress = n === 1 ? 0 : i / (n - 1);
      const curr = points[i];
      // -side
      polylineScratch[w++] = curr.x;
      polylineScratch[w++] = curr.y;
      polylineScratch[w++] = nx;
      polylineScratch[w++] = ny;
      polylineScratch[w++] = -1;
      polylineScratch[w++] = progress;
      // +side
      polylineScratch[w++] = curr.x;
      polylineScratch[w++] = curr.y;
      polylineScratch[w++] = nx;
      polylineScratch[w++] = ny;
      polylineScratch[w++] = 1;
      polylineScratch[w++] = progress;
    }
    gl.useProgram(polylineProg.program);
    gl.uniformMatrix3fv(polylineProg.uniforms.u_view, true, viewMat);
    gl.uniform1f(polylineProg.uniforms.u_halfWidth, halfWidth);
    gl.uniform4fv(polylineProg.uniforms.u_colorTail, colorTail);
    gl.uniform4fv(polylineProg.uniforms.u_colorHead, colorHead);
    gl.bindVertexArray(polylineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, polylineBuf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      polylineScratch.subarray(0, w),
      gl.STREAM_DRAW
    );
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, n * 2);
  }

  // Convenience: multiple disconnected 2-point segments (connector
  // hints, velocity arrow). Uses several small polyline draws.
  function drawSegments(segments, viewMat, halfWidth, colorTail, colorHead) {
    for (let i = 0; i < segments.length; i++) {
      drawPolyline(segments[i], viewMat, halfWidth, colorTail, colorHead);
    }
  }

  // ── Public API ────────────────────────────────────────────
  return {
    gl,
    setViewport,
    beginFrame,
    drawBackground,
    drawBgStars,
    drawStarBatch,
    drawCircleBatch,
    drawPolyline,
    drawSegments,
    finalizeFrame,
    cameraMat,
    replayMat,
    screenMat: () => screenMat,
    c1Of,
    c2Of,
  };
}
