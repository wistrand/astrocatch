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
    // Some drivers return array uniforms as "u_foo" instead of
    // "u_foo[0]". Store both names so lookups work either way.
    if (info.name.endsWith("[0]")) {
      uniforms[info.name.slice(0, -3)] = uniforms[info.name];
    } else if (info.size > 1 && !info.name.endsWith("[0]")) {
      uniforms[info.name + "[0]"] = uniforms[info.name];
    }
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
uniform float u_camY;
uniform float u_seed;       // per-session random seed
out vec4 outColor;

// Hash with session-seed so galaxy positions differ per page load
// but stay stable across frames within a session.
float ghash(float x) { return fract(sin(x + u_seed) * 43758.5453); }

void main() {
  // Convert physical fragment coords to logical, top-down.
  vec2 frag = gl_FragCoord.xy / u_dpr;
  frag.y = u_resolution.y - frag.y;

  // Background radial gradient.
  vec2 c = u_resolution * 0.5;
  float dist = length(frag - c);
  float span = min(u_resolution.x, u_resolution.y) * 1.1;
  vec3 nearCol = vec3(0.071, 0.071, 0.121);
  vec3 farCol = vec3(0.0, 0.0, 0.0);
  vec3 col = mix(nearCol, farCol, clamp(dist / span, 0.0, 1.0));

  // Procedural galaxies — distant spiral galaxies scattered
  // across the background. Each is a logarithmic spiral with
  // 2-4 arms, an elliptical tilt, and a bright central bulge.
  // Positions are seeded from a hash so they're deterministic
  // across frames. Very low parallax and subtle brightness so
  // they read as distant cosmic structures, not foreground
  // objects. The early-out at r > 1.5 means only ~5% of
  // fragments do the expensive spiral math.
  float wrapH = u_resolution.y + 200.0;
  for (int g = 0; g < 3; g++) {
    float fg = float(g);
    // Deterministic position + properties from hash chain.
    float gx = ghash(fg * 127.1 + 31.7) * u_resolution.x;
    float gy = ghash(fg * 269.5 + 83.3) * u_resolution.y;
    float depth = 0.08 + ghash(fg * 73.1 + 17.3) * 0.15;
    gy = mod(gy + u_camY * depth + 100.0, wrapH) - 100.0;

    vec2 d = frag - vec2(gx, gy);
    float gSize = 80.0 + ghash(fg * 419.2 + 61.1) * 140.0;

    // Elliptical tilt — squashes one axis to simulate viewing
    // the disk at an angle.
    float tilt = ghash(fg * 631.1 + 41.3) * 3.14159;
    float ct = cos(tilt), st = sin(tilt);
    float squeeze = 1.6 + ghash(fg * 337.3 + 19.7) * 1.0;
    vec2 td = vec2(d.x * ct - d.y * st,
                   (d.x * st + d.y * ct) * squeeze);
    float r = length(td) / gSize;

    if (r > 1.5) continue; // skip distant fragments

    float theta = atan(td.y, td.x);
    float arms = 2.0 + floor(ghash(fg * 911.3 + 53.7) * 3.0);
    float rotation = ghash(fg * 173.7 + 97.1) * 6.28;

    // Spiral arm pattern — logarithmic spiral.
    float armP = 0.5 + 0.5 * sin(
      arms * (theta + rotation) - log(max(r, 0.01)) * 5.0
    );
    // Arms: exponential disk profile, always white.
    float disk = exp(-r * 3.5) * armP * 0.5;

    // Wide white bulge — always present. Gives every galaxy a
    // soft central glow so the arms read against a brighter core.
    float wideBulge = exp(-r * r * 25.0);

    // Small tight bulge — only on some galaxies. Concentrated
    // hot core on top of the wide bulge. Color randomized per
    // galaxy between bright white and bright yellow.
    float bigBulge = step(0.55, ghash(fg * 811.9 + 29.3));
    float smallBulge = exp(-r * r * 180.0) * 2.5 * bigBulge;
    float warmT = ghash(fg * 503.1 + 71.7);
    vec3 smallBulgeCol = mix(vec3(1.0, 1.0, 1.0),
                             vec3(1.0, 0.7, 0.3), warmT);

    float fade = 1.0 - smoothstep(1.0, 1.5, r);
    vec3 armCol = vec3(1.0, 0.98, 0.95);
    col += (armCol * (disk + wideBulge) + smallBulgeCol * smallBulge)
         * fade * 0.14;
  }

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

    // Lensing distortion. Strength falls off as 1/d² (Newtonian
    // light-bending approximation), with a smoothstep fade in
    // the outer 40 % of the lens range so the distortion
    // doesn't produce a hard ring at lensR.
    if (d > R * 0.9 && d < lensR) {
      float t = R / d;
      float strength = t * t * R * 8.0;
      strength *= 1.0 - smoothstep(lensR * 0.6, lensR, d);
      distUV -= dir * strength / u_resolution;
    }
  }

  // Procedural grid behind each BH — sampled at distorted UV so
  // the grid lines warp visibly under gravitational lensing.
  // Fades in near the BH and out beyond the lensing radius.
  float gridAlpha = 0.0;
  for (int i = 0; i < 4; i++) {
    if (i >= u_bhCount) break;
    vec2 center = u_bh[i].xy;
    float R = u_bh[i].z;
    float lensR = R * 8.0;
    float gridR = lensR * 1.3;
    float d = length(gl_FragCoord.xy - center);
    if (d < gridR) {
      // Fade: strongest near lensing zone, transparent at edges
      float fade = smoothstep(gridR, lensR * 0.6, d)
                 * smoothstep(R * 0.8, R * 1.5, d);
      // Grid in distorted UV space — fixed spacing for all BHs
      float spacing = 40.0;
      vec2 gp = distUV * u_resolution;
      float gx = abs(fract(gp.x / spacing + 0.5) - 0.5) * spacing;
      float gy = abs(fract(gp.y / spacing + 0.5) - 0.5) * spacing;
      float line = min(gx, gy);
      float g = 1.0 - smoothstep(0.0, 1.5, line);
      gridAlpha = max(gridAlpha, .8 * g * fade);
    }
  }

  vec4 scene = texture(u_sceneTex, distUV);
  // Mix grid into scene (subtle blue-white tint)
  scene.rgb = mix(scene.rgb, vec3(0.4, 0.5, 0.7), gridAlpha * 0.48);

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
  } else if (kind == 4) {
    // Hero bg star: solid disc at innerR + Gaussian bloom halo +
    // four-pointed diffraction cross. The quad is sized to outerR
    // so both bloom and spike have room to extend past the disc;
    // innerR carries the disc radius. Bloom is the visible mass
    // (you see the halo before you see the spike); spike is the
    // sharp cinematic accent.
    float discR = innerR;
    float discA = 1.0 - smoothstep(discR - aw, discR, d);
    // Gaussian bloom: peaks at the disc edge, fades over ~2.5×
    // the disc radius. Sells the "this star is bright" cue at a
    // glance.
    float bloomR = discR * 2.5;
    float bloom = exp(-d * d / max(bloomR * bloomR, 0.01));
    // Diffraction cross: Gaussian band along each axis × a radial
    // fade. Brighter and longer-lived than the bloom edge so the
    // cross silhouette pokes through the halo cleanly.
    float armW = max(discR * 0.45, 0.6);
    float armX = exp(-(v_local.y * v_local.y) / (armW * armW));
    float armY = exp(-(v_local.x * v_local.x) / (armW * armW));
    float armFade = exp(-d * (0.9 / max(outerR, 1.0)));
    float spike = max(armX, armY) * armFade;
    a = max(discA, max(bloom * 0.45, spike * 0.85));
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
in vec2 a_wobble;    // (amount, angle) — crash wobble

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
out vec2 v_wobble;

void main() {
  float baseR = a_c1.w;
  // Quad extent matches the on-screen footprint of the corona
  // (bodyR * 4.0) plus a small margin for streamers that shoot
  // a little past it on high-energy blobs. Pulsars need a much
  // wider quad — the lens-flare halo/streak/spikes extend far
  // beyond the corona radius, and a tight quad shows a visible
  // rectangular cutoff against the background during a flash.
  // 8.0 gives the flare room; the FS does a circular alpha fade
  // inside this so the rectangle edge never appears.
  int flagsV = int(a_params.w);
  // Pulsar (32) and Azazel (8192) need a wider quad than other
  // variants — pulsar's lens-flare reaches 3.5× v_baseR; Azazel's
  // silhouette tops out at ASPECT_Y + SPIKE_LEN_MAX ≈ 2.05 v_baseR
  // (halftone fringe is gone, spikes shrunk from 0.85 → 0.6), so
  // its quad is much tighter than pulsar's now.
  float extentMul = (flagsV & 32)   != 0 ? 5.0
                  : (flagsV & 8192) != 0 ? 2.4
                  :                        4.3;
  float extent = baseR * extentMul + 8.0;
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
  v_wobble = a_wobble;
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
in vec2 v_wobble;   // (amount, angle)

uniform float u_time;

out vec4 outColor;

const float PI = 3.14159265;
const float TAU = 6.28318530;

// ─── Teapot SDF helpers (used by isTeapot path below) ────────────
// All ungated — the teapot lives in the common star program rather
// than a separate one. Its peak register footprint (~10 reg) sits
// well under the program ceiling already set by ringworld+plates,
// so no tier impact.

// Smooth minimum (iq's polynomial form). Used to blend the teapot
// primitives into a single smooth ceramic surface.
float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

// Imperfect ellipsoid (iq) — conservative under-estimate, fine
// for raymarching with under-stepped advance.
float sdEllipsoid(vec3 p, vec3 r) {
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / k1;
}

float sdSphere(vec3 p, float r) { return length(p) - r; }

// Quadratic Bezier tube — 6-sample coarse search + 2-Newton
// refines. Used for the curved spout. Same routine the nebula
// filament path uses inline; here as a reusable function.
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
  vec3 d2C = 2.0 * P0 - 4.0 * P1 + 2.0 * P2;
  for (int i = 0; i < 2; i++) {
    float u = 1.0 - bestT;
    vec3 onC = u * u * P0
             + 2.0 * u * bestT * P1
             + bestT * bestT * P2;
    vec3 dC  = -2.0 * u * P0
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
  return distance(p, onCurve) - mix(thickBase, thickTip, bestT);
}

// 3D value noise for the china pattern — wraps continuously around
// the teapot surface with no UV seam.
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

// Teapot SDF — body + lid + knob + Bezier spout + custom
// elliptical-torus handle, all smin'd. Bounding-sphere early-out
// at the top. Coordinates normalised so 1 unit = v_baseR for
// in-game use.
float sdTeapot(vec3 p) {
  float bound = length(p) - 1.7;
  if (bound > 0.30) return bound;
  float bodyLower = sdEllipsoid(p, vec3(1.00, 0.60, 1.00));
  float bodyUpper = sdEllipsoid(p - vec3(0.0, 0.50, 0.0),
                                 vec3(0.65, 0.20, 0.65));
  float body = smin(bodyLower, bodyUpper, 0.10);
  body = -smin(-body, p.y + 0.55, 0.04);  // flat foot
  float lid = sdEllipsoid(p - vec3(0.0, 0.66, 0.0),
                           vec3(0.50, 0.10, 0.50));
  float knob = sdSphere(p - vec3(0.0, 0.80, 0.0), 0.10);
  float spout = sdBezierTube(p,
    vec3(0.85, 0.05, 0.0),
    vec3(1.25, 0.30, 0.0),
    vec3(1.45, 0.60, 0.0),
    0.18, 0.05);
  // Handle: vertically-elongated elliptical torus.
  vec3 hp = p - vec3(-0.92, 0.32, 0.0);
  vec2 hq = vec2(hp.x / 0.18, hp.y / 0.30);
  float distToRing = (length(hq) - 1.0) * min(0.18, 0.30);
  float handle = length(vec2(distToRing, hp.z)) - 0.06;
  float d = body;
  d = smin(d, lid,    0.05);
  d = smin(d, knob,   0.04);
  d = smin(d, spout,  0.05);
  d = smin(d, handle, 0.05);
  return d;
}

// 3-tap forward-difference normal.
vec3 sdTeapotNormal(vec3 p) {
  const float h = 0.001;
  float d0 = sdTeapot(p);
  return normalize(vec3(
    sdTeapot(p + vec3(h, 0.0, 0.0)) - d0,
    sdTeapot(p + vec3(0.0, h, 0.0)) - d0,
    sdTeapot(p + vec3(0.0, 0.0, h)) - d0));
}

// China pattern (cobalt-on-porcelain) with porcelain foot fade
// and a half-cobalt collar at the body-lid junction.
vec3 chinaPattern(vec3 p) {
  float macro = fbm3D(p * 4.5);
  float meso  = fbm3D(p * 13.0 + vec3(2.0, 5.0, 7.0));
  float micro = vnoise3(p * 32.0);
  float field = macro * 0.65 + meso * 0.30 + micro * 0.05;
  float pattern = smoothstep(0.30, 0.90, field);
  pattern *= smoothstep(-0.53, -0.45, p.y);
  float bandY  = smoothstep(0.48, 0.50, p.y)
               - smoothstep(0.60, 0.65, p.y);
  float onAxis = 1.0 - smoothstep(0.70, 0.82, length(p.xz));
  pattern = mix(pattern, 0.55, bandY * onAxis);
  vec3 PORCELAIN = vec3(0.97, 0.95, 0.90);
  vec3 COBALT    = vec3(0.05, 0.10, 0.55);
  return mix(PORCELAIN, COBALT, pattern);
}

#ifdef NEBULA_ONLY
// Value-noise + ridged multifractal — used to break Voronoi cell
// walls out of their smooth-contour "jelly" appearance. ridgedFBM
// produces fibrous line-like ridges at multiple scales; multiplied
// against the Voronoi wall mask it gives the membranes a textured,
// fragmented quality consistent with real supernova-remnant
// filaments.
float vhashN(vec2 p) {
  // Hoskins "Hash without sine" — eliminates the tiling /
  // periodic-banding artefacts the classic sin-fract hash
  // produces at large input values, while preserving the
  // value-noise character downstream (vnoiseN and
  // ridgedFBMN look identical in topology, just without
  // the visible sin-precision banding).
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
// 2D simplex noise (Ashima Arts / Stefan Gustavson) — smoother
// gradients than value noise and no axis-aligned grid artifacts,
// which is what we need for the nebula "force field" that deforms
// the shells. Returns ~[-1, 1].
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
  vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy),
                          dot(x12.zw,x12.zw)), 0.0);
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
// 3D simplex noise (Stefan Gustavson / Ahima Arts). Returns ~[-1, 1].
// Tetrahedral lattice in 3D — 4 corners per sample vs the 2D version's
// 3 corners per sample, but each octave replaces 3 separate 2D-
// projection samples in the old fake-3D fbm3DN. Net per-fbm-octave
// cost: ~150 ALU vs ~210 ALU for the projection-averaged version.
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
// 5-octave simplex FBM. Returns ~[-1.05, +1.05]. Frequency ratio
// 2.07 (slightly off 2.0) avoids any chance of grid resonance
// across octaves.
float fbmSimplexN(vec2 p) {
  float t = 0.0;
  float amp = 0.55;
  for (int i = 0; i < 5; i++) {
    t += snoiseN(p) * amp;
    p *= 2.07;
    amp *= 0.55;
  }
  return t;
}
// 3-octave 3D simplex FBM — used inside the nebula body. Native 3D
// simplex (vs the previous "fake 3D via 3 axis-aligned 2D projections
// averaged" hack) gives smoother z-evolution: consecutive z-steps
// decorrelate naturally instead of sharing the xy-projection sample.
// Frequency ratio 2.07 (slightly off 2.0) avoids any chance of grid
// resonance across octaves.
float fbm3DN(vec3 p) {
  return 0.65 * snoise3DN(p)
       + 0.32 * snoise3DN(p * 2.07)
       + 0.16 * snoise3DN(p * 4.28);
}
#endif

// ─── Azazel SDF helpers ─────────────────────────────────────────
// Demon manifesting through a rip in space. Body silhouette
// (rotated elongated ellipse + dirNoise edge perturbation +
// ~14 radial spikes + sub-blobs, all under a slow breath
// scale), 3 stacked face tiers (paired triangular eyes above a
// two-row rhombus grin), halftone fringe, inner orange glow.
// Constants are fixed in-game; their tuning lives in
// shadertoy/azazel.glsl.
const float AZ_ASPECT_X = 0.55;
const float AZ_ASPECT_Y = 1.45;
const float AZ_TILT_ANGLE = 0.30;
const float AZ_BOUNDARY_AMP = 0.16;
const int   AZ_N_SPIKES = 14;
const float AZ_SPIKE_LEN_MAX = 0.6;
const float AZ_SPIKE_BASE_W = 0.06;
const float AZ_SPIKE_PULSE_RATE = 0.40;
const float AZ_BREATHE_RATE = 0.40;
const float AZ_BREATHE_AMP = 0.32;
const float AZ_WRITHE_RATE_1 = 0.30;
const float AZ_WRITHE_RATE_2 = 0.50;
const float AZ_WRITHE_RATE_3 = 0.80;
const float AZ_WRITHE_RATE_4 = 1.25;
const float AZ_SMIN_K = 0.18;
const float AZ_BLOB1_R = 0.30;
const float AZ_BLOB2_R = 0.26;
const vec3  AZ_INK_BLACK = vec3(0.01, 0.01, 0.02);
const vec3  AZ_INNER_GLOW = vec3(0.20, 0.05, 0.05);
const float AZ_INNER_GLOW_FALLOFF = 5.0;
const float AZ_INNER_GLOW_AMP = 1.10;
const vec3  AZ_EYE_IRIS_RED = vec3(0.95, 0.10, 0.05);
const float AZ_EYE_IRIS_PROB = 0.30;
const float AZ_EYE_IRIS_R = 0.028;
const vec3  AZ_TOOTH_WHITE = vec3(0.93, 0.88, 0.74);
const int   AZ_N_FACES = 3;
const float AZ_FACE_SPREAD_X = 0.78;
const float AZ_FACE_SPREAD_Y = 1.75;
const float AZ_TIER_SPACING = AZ_FACE_SPREAD_Y / float(AZ_N_FACES);
const float AZ_FACE_TILT_RANGE = 0.55;
const float AZ_FACE_MOTION_AMP = 0.10;
const float AZ_FACE_MOTION_RATE = 0.20;
const float AZ_FACE_SCALE_AMP = 0.15;
const float AZ_FACE_SCALE_RATE = 0.20;
const float AZ_EYE_INNER_X = 0.026;
const float AZ_EYE_OUTER_X = 0.135;
const float AZ_EYE_HEIGHT = 0.030;
const float AZ_EYE_Y_OFFSET = -0.140;
const float AZ_EYE_BLINK_RATE = 0.30;
const float AZ_EYE_GLOW_FALLOFF = 35.0;
const float AZ_EYE_INNER_TILT = 0.42;
const float AZ_EYE_BOW = 0.88;
const float AZ_MOUTH_HALFW = 0.13;
const float AZ_MOUTH_HALFH = 0.110;
const float AZ_MOUTH_Y_OFFSET = 0.085;
const float AZ_MOUTH_GAP_MIN = -0.14;
const float AZ_MOUTH_GAP_MAX = 0.04;
const float AZ_LOWER_W_RATIO = 0.78;
const float AZ_TEETH_PER_MOUTH = 6.0;
const float AZ_MOUTH_OPEN_RATE = 0.40;
const float AZ_JAW_BEND_RANGE = 0.020;

float az_hash11(float x) {
  return fract(sin(x * 12.9898) * 43758.5453);
}
vec2 az_hash21(float x) {
  return vec2(
    fract(sin(x * 12.9898) * 43758.5453),
    fract(sin(x * 78.233 + 1.7) * 43758.5453)
  );
}
// Packed scalar hash on a vec4 — same formula as az_hash11
// applied component-wise. On vec-SIMD GPUs (Adreno) this
// collapses 4 scalar hashes into 1 vec4 sin/fract; on
// scalar GPUs (Mali) the cost is the same as 4 hash11s.
vec4 az_hash41(vec4 x) {
  return fract(sin(x * 12.9898) * 43758.5453);
}

float az_triWave(float x) {
  return abs(fract(x / TAU + 0.25) * 4.0 - 2.0) - 1.0;
}

float az_dirNoise(vec2 p, float seed, float t) {
  vec2 d1 = vec2( 0.71,  0.71);
  vec2 d2 = vec2( 0.83, -0.56);
  vec2 d3 = vec2( 0.50,  0.87);
  vec2 d4 = vec2(-0.95,  0.31);
  float p1 = az_hash11(seed * 1.0) * TAU + t * AZ_WRITHE_RATE_1;
  float p2 = az_hash11(seed * 2.0) * TAU + t * AZ_WRITHE_RATE_2;
  float p3 = az_hash11(seed * 3.0) * TAU + t * AZ_WRITHE_RATE_3;
  float p4 = az_hash11(seed * 4.0) * TAU + t * AZ_WRITHE_RATE_4;
  return 0.40 * az_triWave(dot(p, d1) * 18.0 + p1)
       + 0.30 * az_triWave(dot(p, d2) * 28.0 + p2)
       + 0.20 * (abs(sin(dot(p, d3) * 45.0 + p3)) * 2.0 - 1.0)
       + 0.15 * sin(dot(p, d4) * 70.0 + p4);
}

float az_sdBlob(vec2 p, vec2 c, float r) {
  return length(p - c) - r;
}

float az_sdRip(vec2 p, float seed, float t) {
  float breath = 1.0 + sin(t * AZ_BREATHE_RATE) * AZ_BREATHE_AMP;
  p /= breath;
  // Per-instance tilt — random angle in [-TILT_ANGLE, +TILT_ANGLE]
  // so different rips lean different ways.
  float tilt = (az_hash11(seed * 5.31) - 0.5) * 2.0 * AZ_TILT_ANGLE;
  float c = cos(tilt), s = sin(tilt);
  vec2 pr = mat2(c, -s, s, c) * p;
  vec2 q = pr / vec2(AZ_ASPECT_X, AZ_ASPECT_Y);
  float base = length(q) - 1.0;
  base *= min(AZ_ASPECT_X, AZ_ASPECT_Y);
  // Edge noise is masked to |base| < 0.20 (smoothstep zeroes
  // it past that), so for deep-interior fragments dirNoise is
  // multiplied by 0 — skip outright.
  if (abs(base) < 0.20) {
    float edgeMask = 1.0 - smoothstep(0.0, 0.20, abs(base));
    base += AZ_BOUNDARY_AMP * az_dirNoise(p, seed, t) * edgeMask;
  }
  // Spikes via nearest-spike SDF. Find the spike whose centre
  // angle is closest to the fragment's parametric (q-space)
  // angle, then compute the analytic SDF of that one spike's
  // tapered body. Costs ~50 ALU vs ~400 for the 14-iter loop,
  // and the resulting SDF is approximately normalized so -d
  // gives correct inner-glow distance everywhere.
  // Two-sided gate:
  //   - Far-corner: |pr| > ~2.17 (dot > 4.7) is past max spike
  //     extent (ASPECT_Y + AZ_SPIKE_LEN_MAX = 2.05), so spike
  //     SDF can't go negative — skip the finder for those ~30%
  //     corner fragments.
  //   - Deep interior: base < -0.20 means the fragment is well
  //     inside the body, deeper than any spike body can reach
  //     (spikes attach to the boundary and only extend inward
  //     by AZ_SPIKE_BASE_W ≈ 0.06), so min(base, spikeSDF) is
  //     provably base — skip on body-interior fragments too,
  //     which is most of the silhouette at Azazel zoom.
  if (base >= -0.20 && dot(pr, pr) < 4.7) {
    float angParam = atan(q.y, q.x);
    float spPhase = az_hash11(seed * 13.7) * TAU;
    float period = TAU / float(AZ_N_SPIKES);
    float spikeIdx = floor((angParam - spPhase) / period + 0.5);
    float angCenter = spikeIdx * period + spPhase;
    vec2 spDir = vec2(cos(angCenter), sin(angCenter));
    vec2 basePt = spDir * vec2(AZ_ASPECT_X, AZ_ASPECT_Y);
    float spLenHash = az_hash11(spikeIdx * 7.31 + seed * 23.1);
    float pulse = 0.85 + 0.15 * sin(t * AZ_SPIKE_PULSE_RATE);
    float spikeLen = AZ_SPIKE_LEN_MAX * mix(0.45, 1.0, spLenHash) * pulse;
    // Per-slot presence — drop ~25% of the angular spike slots
    // (zero baseW kills the body without breaking the nearest-
    // spike geometry, so the periodic finder still works).
    float spPresent = step(0.25, az_hash11(spikeIdx * 19.7 + seed * 67.3));
    float baseW = AZ_SPIKE_BASE_W
                * (0.6 + 0.8 * az_hash11(spikeIdx * 41.3 + seed * 51.7))
                * spPresent;
    vec2 ba = spDir * spikeLen;
    vec2 pa = pr - basePt;
    // L = dot(ba, ba) = spikeLen² > 0 always (spikeLen ≥ 0.19),
    // so the max(·, 1e-6) safety clamp is dead.
    float L = dot(ba, ba);
    float h = clamp(dot(pa, ba) / L, 0.0, 1.0);
    vec2 qp = pa - ba * h;
    float spikeSDF = length(qp) - baseW * (1.0 - h);
    base = min(base, spikeSDF);
  }
  vec2 b1Off = (az_hash21(seed * 11.7) - 0.5) * vec2(0.5, 1.4);
  vec2 b2Off = (az_hash21(seed * 23.1) - 0.5) * vec2(0.5, 1.4);
  float blob1 = az_sdBlob(p, b1Off, AZ_BLOB1_R);
  float blob2 = az_sdBlob(p, b2Off, AZ_BLOB2_R);
  base = smin(base, blob1, AZ_SMIN_K);
  base = smin(base, blob2, AZ_SMIN_K);
  return base * breath;
}

float az_sdTriangleIq(vec2 p, vec2 a, vec2 b, vec2 c) {
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

float az_sdEyeWedge(vec2 p, float apexX, float baseX, float h, float tilt) {
  vec2 eyeC = vec2((apexX + baseX) * 0.5, 0.0);
  float c = cos(tilt), s = sin(tilt);
  vec2 lp = mat2(c, -s, s, c) * (p - eyeC) + eyeC;
  float w = baseX - apexX;
  float axisFrac = clamp((lp.x - apexX) / w, 0.0, 1.0);
  lp.y *= 1.0 + AZ_EYE_BOW * sin(axisFrac * PI);
  return az_sdTriangleIq(
    lp, vec2(apexX, 0.0), vec2(baseX, h), vec2(baseX, -h)
  );
}

float az_sdRhombusTooth(vec2 p, float topFlat, float wHalf,
                        float lenMid, float lenTotal) {
  if (p.y < 0.0) return -p.y;
  if (p.y > lenTotal) return p.y - lenTotal;
  float w;
  if (p.y < lenMid) {
    float t = p.y / lenMid;
    w = mix(topFlat, wHalf, t);
  } else {
    float t = (p.y - lenMid) / max(lenTotal - lenMid, 1e-4);
    w = mix(wHalf, 0.0, t);
  }
  return abs(p.x) - w;
}

// Tooth-row coordinate convention (row-local frame):
//   y = 0           → outer jaw boundary (this row's tooth root)
//   y = effHalfH    → row centre line
//   y = effHalfH - halfGap → tooth tip / gap edge
// shape selects the outer-curve form:
//   +1: convex (regular ellipse — corners shrink to the gap)
//    0: flat (rectangular row)
//   −1: concave (corners poke outward past the rest height)
// Each tooth roots on the curve at column xc.
float az_sdToothRow(vec2 p, float halfW, float effHalfH, float halfGap,
                    float shape, float nTeeth, float seed, float bend) {
  float d = 1e6;
  float cellW = 2.0 * halfW / nTeeth;
  float wHalfBase = cellW * 0.60;
  for (int i = 0; i < 12; i++) {
    float fi = float(i);
    if (fi >= nTeeth) break;
    float xc = -halfW + (fi + 0.5) * cellW;
    float xRel = xc / halfW;
    float jawOffset = bend * (1.0 - xRel * xRel);
    float symIdx = min(fi, nTeeth - 1.0 - fi);
    float sizeScale = 0.55 + 0.45 * az_hash11(seed + symIdx * 7.31);
    // 4th-order polynomial fit to arc(xRel)=sqrt(1-xRel²).
    // 1-arc ≈ 0.475·x² + 0.244·x⁴, factored as
    // x²·(0.475 + 0.244·x²) for one fewer mul. Matches the
    // ellipse to <0.001 at every tooth column for nTeeth=6
    // (xRel ∈ {±0.167, ±0.5, ±0.833}) — visually identical
    // to the true sqrt, no sqrt needed.
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
    d = min(d, az_sdRhombusTooth(lp, topFlat, wHalf, toothMid, toothLen));
  }
  return d;
}

float az_sdMouthRows(vec2 p, float halfW, float halfH,
                     float halfGap, float nTeeth, float seed) {
  // Each jaw rolls its own outer-curve shape in [-1,+1] from
  // the seed — upper and lower are independent, so a face can
  // pair a convex top with a concave bottom or any mix. Both
  // jaws still expand vertically when the mouth opens (halfH
  // grows with positive halfGap).
  // Shape range capped at ±0.6 — full ±1.0 lets corner teeth
  // collapse to nothing (convex) or stretch to 2× rest height
  // (concave fangs). Both extremes read as "very fat curves",
  // so dial the amplitude back to keep the variation subtle.
  float upperShape = (az_hash11(seed * 31.5) - 0.5) * 1.2;
  float lowerShape = (az_hash11(seed * 41.7) - 0.5) * 1.2;
  float effHalfH = halfH + max(halfGap, 0.0);
  // Cheap rect bbox early-reject. Concave-shape rolls extend
  // corner teeth outward, so the cap is sized to the larger
  // jaw. The visible mouth silhouette is drawn downstream by
  // the per-tooth scan — the cap only saves work for far
  // fragments, no visual impact from making it rectangular.
  float capH = effHalfH * max(1.0, max(1.0 - upperShape, 1.0 - lowerShape));
  vec2 bbox = abs(p) - vec2(halfW, capH);
  float bboxOut = max(bbox.x, bbox.y);
  if (bboxOut > 0.0) return bboxOut;
  float yAbs = abs(p.y);
  if (yAbs < halfGap) return halfGap - yAbs;
  float upperBend = (az_hash11(seed * 17.7) - 0.5) * 2.0 * AZ_JAW_BEND_RANGE;
  float lowerBend = (az_hash11(seed * 23.1) - 0.5) * 2.0 * AZ_JAW_BEND_RANGE;
  if (p.y < 0.0) {
    return az_sdToothRow(vec2(p.x, p.y + effHalfH),
                         halfW, effHalfH, halfGap, upperShape,
                         nTeeth, seed, upperBend);
  }
  return az_sdToothRow(vec2(p.x, effHalfH - p.y),
                       halfW * AZ_LOWER_W_RATIO, effHalfH, halfGap, lowerShape,
                       nTeeth, seed, lowerBend);
}

void main() {
  // Wobble deformation — squeeze the star into an ellipse along
  // the impact axis. The component of v_local parallel to the
  // impact direction is stretched, making the star bulge outward
  // at the sides and flatten where the ship hit.
  vec2 loc = v_local;
  float wobAmt = v_wobble.x;
  if (wobAmt > 0.001) {
    float wa = v_wobble.y;
    vec2 impactDir = vec2(cos(wa), sin(wa));
    float para = dot(loc, impactDir);
    float perp = dot(loc, vec2(-impactDir.y, impactDir.x));
    // Squeeze along impact axis, bulge perpendicular
    float squeeze = 1.0 - wobAmt * 0.25;
    float bulge   = 1.0 + wobAmt * 0.18;
    loc = impactDir * para * squeeze
        + vec2(-impactDir.y, impactDir.x) * perp * bulge;
  }
  float d = length(loc);
  float tp = u_time + v_seed;

  int flags = int(v_flags);
  bool isCurrent = (flags & 1) != 0;
  bool isNext    = (flags & 2) != 0;
  bool isPast    = (flags & 4) != 0;
  bool isBlackHole = (flags & 8) != 0;
  bool isMonolith = (flags & 16) != 0;
  bool isPulsar  = (flags & 32) != 0;
  bool isRingworld = (flags & 64) != 0;
  // Bits 256/512/1024 reserved for ringPlateCount (decoded below
  // in the ringworld branch). Nebula uses bit 2048 to stay clear.
  bool isNebula = (flags & 2048) != 0;
  // Teapot — the Russell variant. Tumbling porcelain SDF. Rare
  // Easter-egg spawn; renders inside the common star program
  // because its raymarch peak (~10 reg) doesn't push the program
  // worse than ringworld+plates already does.
  bool isTeapot = (flags & 4096) != 0;
  // Azazel — demon manifesting through a rip in space. Body
  // silhouette with radial spikes, plus 3 faces (paired
  // triangular eyes above a two-row rhombus grin). Heavy ALU
  // budget, lives in the common star program.
  bool isAzazel = (flags & 8192) != 0;

  if (isPast) {
    // Dim ember: small inner glow + a white pinpoint at the core.
    float auraR = v_baseR * 0.9;
    float aura = (1.0 - smoothstep(0.0, auraR, d)) * 0.22;
    float ember = (1.0 - smoothstep(0.0, 2.5, d)) * 0.45;
    float a = clamp(aura + ember, 0.0, 1.0);
    outColor = vec4(vec3(a), a);
    return;
  }

  // Monolith — raymarched 3D slab in the classic 2001 1:4:9
  // proportion, tumbling around a per-monolith random axis.
  // Solid near-black body with a subtle rim light at the
  // silhouette. Doesn't wobble.
  if (isMonolith) {
    vec3 b = vec3(v_baseR * 0.189, v_baseR * 0.747, v_baseR * 1.692);
    // Per-monolith rotation axis derived from seed.
    vec3 axis = normalize(vec3(
      sin(v_seed * 1.3),
      cos(v_seed * 1.7 + 0.5) + 0.15, // bias slightly up
      sin(v_seed * 2.1 + 1.0)
    ));
    float ang = u_time * 0.25 + v_seed;
    float cA = cos(ang), sA = sin(ang), ic = 1.0 - cA;
    // Rodrigues rotation matrix (box-local → world).
    mat3 R = mat3(
      cA + axis.x*axis.x*ic,
        axis.y*axis.x*ic + axis.z*sA,
        axis.z*axis.x*ic - axis.y*sA,
      axis.x*axis.y*ic - axis.z*sA,
        cA + axis.y*axis.y*ic,
        axis.z*axis.y*ic + axis.x*sA,
      axis.x*axis.z*ic + axis.y*sA,
        axis.y*axis.z*ic - axis.x*sA,
        cA + axis.z*axis.z*ic
    );
    mat3 Rinv = transpose(R);
    // Orthographic ray in world: origin (v_local, +big), dir
    // (0,0,-1). Transform into box-local frame.
    vec3 ro = Rinv * vec3(v_local, 1000.0);
    vec3 rd = Rinv * vec3(0.0, 0.0, -1.0);
    // Slab intersection. Guard rd away from zero — at certain
    // box orientations an axis-aligned ray component becomes
    // near zero, and 1/rd overflows in a way that produces NaN
    // via Inf-Inf in the later max/min. Clamp each component
    // to ±1e-4 in the correct sign direction so intersection
    // stays numerically stable across the full rotation.
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
    // Hard miss cutoff. At grazing angles fwidth(tN) blows up
    // (tN varies wildly per-pixel when rd is nearly parallel to
    // a slab face), so we don't extrapolate AA across the miss
    // region. Inside the slab, alpha fades from 1 to 0 as we
    // approach the silhouette, with the AA width capped so
    // edge-on views stay sharp.
    if (tN > tF || tF < 0.0) {
      outColor = vec4(0.0);
      return;
    }
    float edgeAW = min(fwidth(tN), v_baseR * 0.08);
    float aa = 1.0 - smoothstep(tF - edgeAW, tF, tN);
    // Face normal: pick the dominant axis by argmax to avoid
    // grazing-corner ambiguity where step() would flag multiple
    // axes simultaneously and produce a non-unit normal.
    vec3 normalLocal;
    if (t1.x >= t1.y && t1.x >= t1.z) {
      normalLocal = vec3(-sign(rdSafe.x), 0.0, 0.0);
    } else if (t1.y >= t1.z) {
      normalLocal = vec3(0.0, -sign(rdSafe.y), 0.0);
    } else {
      normalLocal = vec3(0.0, 0.0, -sign(rdSafe.z));
    }
    vec3 normal = R * normalLocal;
    float NdotL = max(dot(normal, normalize(vec3(-0.3, 0.6, 0.8))), 0.0);
    float body = 0.03 + 0.08 * NdotL;
    // Fresnel rim — view dir is (0,0,-1) world; silhouette
    // edges have |normal.z| near 0.
    float fresnel = pow(1.0 - abs(normal.z), 4.0);
    vec3 rim = vec3(0.45, 0.6, 0.9) * fresnel * 0.55;
    outColor = vec4(vec3(body) + rim, aa);
    return;
  }

  // Russell's china teapot — sphere-traced SDF (body + lid + knob
  // + Bezier spout + elliptical-torus handle), procedural cobalt-
  // on-porcelain pattern, glossy ceramic shading. Tumbles around a
  // per-instance random axis. Coordinates inside the SDF are
  // normalised so 1 unit = v_baseR; bounding sphere is ~1.7
  // v_baseR-units. Quad is the standard 4.3 v_baseR + 8 — way
  // bigger than the teapot needs, but the bounding-sphere early-
  // out keeps the corner fragments at ~5 ALU/step.
  if (isTeapot) {
    // Sample point in unit-normalised local frame; camera at z=-3.5
    // (in normalised units) looking toward origin. World coords use
    // +Y-down (screenMat flips to clip), so we negate loc.y on the
    // way into the SDF frame — the SDF puts the lid at +Y, the foot
    // at -Y, and we need that to map to "up on screen, down on
    // screen" respectively.
    float locScale = 1.0 / max(v_baseR, 1.0);
    vec3 ro = vec3(loc.x * locScale, -loc.y * locScale, -3.5);
    vec3 rd = vec3(0.0, 0.0, 1.0);
    // Tumble: Rodrigues rotation around a per-teapot seed axis.
    // Strong +Y bias so the body stays roughly vertical (lid up):
    // after normalize, tAxis.y ≥ 0.96, giving a max body-tilt of
    // ~16° during the tumble. Weaker bias produced many seeds
    // with X- or Z-aligned axes that rotated the body through
    // "bottom toward camera" orientations.
    vec3 tAxis = normalize(vec3(
      sin(v_seed * 1.3) * 0.20,
      cos(v_seed * 1.7) + 2.0,
      sin(v_seed * 2.1) * 0.20));
    // Initial angle biased to one of the two profile views (spout
    // at +X or -X). seedFlip picks left/right, jitter spreads the
    // start within ±π/4 of profile so teapots aren't all at the
    // exact same angle. Avoids spawning face-on (spout pointing
    // at or away from camera) which reads as the worst angle.
    float seedFlip = step(0.5, fract(v_seed * 13.7));
    float tInitOff = seedFlip * PI
                   + (fract(v_seed * 7.31) - 0.5) * (PI * 0.5);
    float tAng = u_time * 0.20 + tInitOff;
    float tC = cos(tAng), tS = sin(tAng), tIc = 1.0 - tC;
    mat3 tR = mat3(
      tC + tAxis.x * tAxis.x * tIc,
        tAxis.y * tAxis.x * tIc + tAxis.z * tS,
        tAxis.z * tAxis.x * tIc - tAxis.y * tS,
      tAxis.x * tAxis.y * tIc - tAxis.z * tS,
        tC + tAxis.y * tAxis.y * tIc,
        tAxis.z * tAxis.y * tIc + tAxis.x * tS,
      tAxis.x * tAxis.z * tIc + tAxis.y * tS,
        tAxis.y * tAxis.z * tIc - tAxis.x * tS,
        tC + tAxis.z * tAxis.z * tIc);
    mat3 tRinv = transpose(tR);
    vec3 roL = tRinv * ro;
    vec3 rdL = tRinv * rd;
    // Sphere-trace.
    float tMarch = 0.0;
    bool hit = false;
    vec3 hitP = vec3(0.0);
    for (int i = 0; i < 48; i++) {
      vec3 p = roL + rdL * tMarch;
      float dT = sdTeapot(p);
      if (dT < 0.001) { hit = true; hitP = p; break; }
      if (tMarch > 8.0) break;
      tMarch += dT * 0.95;
    }
    if (!hit) { outColor = vec4(0.0); return; }
    // Shade the hit point.
    vec3 normalLocal = sdTeapotNormal(hitP);
    vec3 normal = tR * normalLocal;
    vec3 viewDir = -rd;
    vec3 base = chinaPattern(hitP);
    // Three-light ceramic — key + fill + ambient + Phong specular
    // + power-3 fresnel rim. Same parameters as the shadertoy
    // proof-of-concept.
    // Slowly rotating key light — gives the highlight a "sun
    // moving across the sky" feel independent of the teapot's
    // tumble. Vertical tilt (y=0.8) is preserved; azimuth
    // precesses at 0.10 rad/s ≈ one revolution per minute. Per-
    // teapot phase via v_seed so multiple teapots don't all
    // flash their highlights in sync. Pre-scaled so length is
    // exactly 1 — no normalize needed (sqrt(0.6² + 0.8²) = 1).
    float keyAng = u_time * 0.10 + v_seed * 0.5;
    vec3 keyDir = vec3(0.6 * cos(keyAng), 0.8, 0.6 * sin(keyAng));
    vec3 fillDir = normalize(vec3(-0.4, 0.2, 0.8));
    float keyL  = max(dot(normal, keyDir),  0.0);
    float fillL = max(dot(normal, fillDir), 0.0) * 0.3;
    vec3 ambient = vec3(0.50, 0.50, 0.50);
    vec3 col = base * (ambient + keyL + fillL);
    vec3 reflectDir = reflect(-keyDir, normal);
    float spec = pow(max(dot(reflectDir, viewDir), 0.0), 64.0);
    // Specular tinted by the per-instance star colour (v_c1) — gives
    // each teapot a recognisable "glaze tint" without touching the
    // cobalt-on-porcelain body palette. White at the highlight peak
    // would be physically purer; the tint sells per-instance identity.
    col += spec * v_c1 * 0.35;
    float rim = pow(1.0 - max(dot(normal, viewDir), 0.0), 3.0);
    col += rim * vec3(0.55, 0.65, 0.85) * 0.35;
    outColor = vec4(col, 1.0);
    return;
  }

  // Azazel — a demon manifesting through a rip in space. Body
  // silhouette + radial spikes + 3 face tiers (paired triangular
  // eyes above a two-row rhombus grin). Outside the silhouette
  // and outside the halftone fringe the quad writes alpha 0 so
  // the real procedural background shows through. All scratch
  // computations live in the az_ helper namespace defined above.
  if (isAzazel) {
    // Pixel position relative to star centre, in v_baseR units.
    // World coords use +Y down (screenMat flips to clip), and
    // the Azazel SDF was authored with +y down — no negation.
    vec2 azP = loc / max(v_baseR, 1.0);
    float d = az_sdRip(azP, v_seed, u_time);
    if (d < 0.0) {
      // Silhouette interior — solid black with an inner orange
      // glow hugging the actual boundary (body + spikes), then
      // eyes / iris / teeth on top. The nearest-spike SDF used
      // by sdRip is approximately normalized, so -d here is a
      // correct distance to the silhouette and the glow fades
      // naturally inside both the body and the spike bodies.
      vec3 col = AZ_INK_BLACK;
      float innerDepth = -d;
      float innerGlow = exp(-innerDepth * AZ_INNER_GLOW_FALLOFF)
                      * AZ_INNER_GLOW_AMP;
      col += AZ_INNER_GLOW * innerGlow;
      // Face features are masked by the *inverse* of the
      // inner-glow falloff: zero at the rip border so eyes and
      // teeth fade into the glow band instead of cutting hard
      // against the silhouette edge, ramping to one a short
      // way inside.
      float faceMask = 1.0 - exp(-innerDepth * AZ_INNER_GLOW_FALLOFF);
      for (int i = 0; i < AZ_N_FACES; i++) {
        float fi = float(i);
        float tierY = (fi - float(AZ_N_FACES - 1) * 0.5) * AZ_TIER_SPACING;
        // Pack the eight per-face hash11 calls into two vec4
        // hashes — collapses 8 scalar sin/fract pairs into 2
        // vec4 ops on vec-SIMD GPUs (Adreno). Multipliers and
        // fi-coefficients identical to the original scalar form:
        //   A.x: facePos.x  (v_seed*53.0  + fi*23.7)
        //   A.y: facePos.y  (v_seed*91.3  + fi*47.1)
        //   A.z: faceAng    (v_seed*87.3  + fi)
        //   A.w: mxPhase    (v_seed*71.3  + fi)
        //   B.x: myPhase    (v_seed*79.7  + fi)
        //   B.y: sPhase     (v_seed*83.1  + fi)
        //   B.z: irisProb   (v_seed*211.7 + fi)
        //   B.w: gapBase    (v_seed*167.0 + fi)
        vec4 hashA = az_hash41(
          v_seed * vec4(53.0, 91.3, 87.3, 71.3)
          + fi   * vec4(23.7, 47.1, 1.0,  1.0)
        );
        vec4 hashB = az_hash41(
          v_seed * vec4(79.7, 83.1, 211.7, 167.0) + fi
        );
        vec2 facePos = vec2(
          (hashA.x - 0.5) * AZ_FACE_SPREAD_X,
          tierY + (hashA.y - 0.5) * 0.04
        );
        float blinkPhase = sin(u_time * AZ_EYE_BLINK_RATE + fi * 1.7);
        float openPhase  = sin(u_time * AZ_MOUTH_OPEN_RATE + fi * 2.3);
        float faceAng = (hashA.z - 0.5) * AZ_FACE_TILT_RANGE;
        float fc = cos(faceAng), fs = sin(faceAng);
        mat2 faceRot = mat2(fc, -fs, fs, fc);
        float mxPhase = hashA.w * TAU;
        float myPhase = hashB.x * TAU;
        float sPhase  = hashB.y * TAU;
        vec2 motion = vec2(
          sin(u_time * AZ_FACE_MOTION_RATE       + mxPhase),
          sin(u_time * AZ_FACE_MOTION_RATE * 0.8 + myPhase)
        ) * AZ_FACE_MOTION_AMP;
        float faceScale = 1.0 + AZ_FACE_SCALE_AMP
                              * sin(u_time * AZ_FACE_SCALE_RATE + sPhase);
        vec2 effectivePos = facePos + motion;
        vec2 fp = faceRot * (azP - effectivePos) / faceScale;
        // Eyes — gated on blink > 0.02 so the triangle never
        // collapses to a degenerate line (the IQ triangle SDF
        // divides by dot(e1,e1)=0 there → NaN flicker).
        float blink = 1.0 - pow(max(0.0, blinkPhase), 12.0);
        if (blink > 0.02) {
          float h = AZ_EYE_HEIGHT * blink;
          vec2 eyeP = fp - vec2(0.0, AZ_EYE_Y_OFFSET);
          float lEyeD = az_sdEyeWedge(eyeP, -AZ_EYE_INNER_X, -AZ_EYE_OUTER_X, h, +AZ_EYE_INNER_TILT);
          float rEyeD = az_sdEyeWedge(eyeP, +AZ_EYE_INNER_X, +AZ_EYE_OUTER_X, h, -AZ_EYE_INNER_TILT);
          float eD = min(lEyeD, rEyeD);
          float glow = exp(-max(eD, 0.0) * AZ_EYE_GLOW_FALLOFF) * 0.35;
          col += v_c1 * 0.78 * glow * faceMask;
          if (eD < 0.0) col = mix(col, v_c1, faceMask);
          if (hashB.z < AZ_EYE_IRIS_PROB) {
            vec2 lEyeC = vec2((-AZ_EYE_INNER_X + -AZ_EYE_OUTER_X) * 0.5, 0.0);
            vec2 rEyeC = vec2((+AZ_EYE_INNER_X + +AZ_EYE_OUTER_X) * 0.5, 0.0);
            float lIrisD = length(eyeP - lEyeC) - AZ_EYE_IRIS_R;
            float rIrisD = length(eyeP - rEyeC) - AZ_EYE_IRIS_R;
            if ((lIrisD < 0.0 && lEyeD < 0.0)
             || (rIrisD < 0.0 && rEyeD < 0.0)) col = mix(col, AZ_EYE_IRIS_RED, faceMask);
          }
        }
        // Mouth
        vec2 mp = fp - vec2(0.0, AZ_MOUTH_Y_OFFSET);
        float gapBase = mix(AZ_MOUTH_GAP_MIN, AZ_MOUTH_GAP_MAX, hashB.w);
        // Full close-to-open chomp: 0 at one phase extreme,
        // gapBase at the other. Negative-gapBase faces stay
        // visually closed; positive-gapBase ones swing through
        // the entire visible range.
        float halfGap = gapBase * (0.5 + 0.5 * openPhase);
        float mSeed = v_seed * 200.0 + fi * 13.0;
        float mD = az_sdMouthRows(mp, AZ_MOUTH_HALFW, AZ_MOUTH_HALFH,
                                  halfGap, AZ_TEETH_PER_MOUTH, mSeed);
        if (mD < 0.0) col = mix(col, AZ_TOOTH_WHITE, faceMask);
      }
      outColor = vec4(col, 1.0);
      return;
    }
    // Outside the silhouette — fully transparent. (Halftone
    // fringe removed; the inner orange glow on the negative-SDF
    // side already provides the edge softening.)
    outColor = vec4(0.0);
    return;
  }

  // Ringworld — a Halo-style band wrapping a central sun. The
  // ring is a cylindrical strip of radius R, height H, tumbling
  // slowly in 3D. Ray-cylinder intersection picks between the
  // near hit (viewer sees the OUTSIDE, dark back of the habitat)
  // and the far hit (viewer sees the INSIDE, lit earth-like
  // surface facing the sun). Showing both as we sweep the ring
  // gives the classic ringworld S-curve.
  if (isRingworld) {
    float R = v_baseR * 3.6;           // ring radius
    float H = v_baseR * 1.0;           // band height (along axis)
    // Per-ring rotation axis derived from seed — monolith-style
    // single-axis tumble (steady, no wobble).
    vec3 rotAxis = normalize(vec3(
      sin(v_seed * 1.3),
      cos(v_seed * 1.7 + 0.5) + 0.15,
      sin(v_seed * 2.1 + 1.0)
    ));
    float ang = u_time * 0.25 + v_seed;
    float cA = cos(ang), sA = sin(ang), ic = 1.0 - cA;
    mat3 Rrot = mat3(
      cA + rotAxis.x*rotAxis.x*ic,
        rotAxis.y*rotAxis.x*ic + rotAxis.z*sA,
        rotAxis.z*rotAxis.x*ic - rotAxis.y*sA,
      rotAxis.x*rotAxis.y*ic - rotAxis.z*sA,
        cA + rotAxis.y*rotAxis.y*ic,
        rotAxis.z*rotAxis.y*ic + rotAxis.x*sA,
      rotAxis.x*rotAxis.z*ic + rotAxis.y*sA,
        rotAxis.y*rotAxis.z*ic - rotAxis.x*sA,
        cA + rotAxis.z*rotAxis.z*ic
    );
    vec3 axis = Rrot * vec3(0.0, 1.0, 0.0);
    vec3 basU = Rrot * vec3(1.0, 0.0, 0.0);
    vec3 basV = Rrot * vec3(0.0, 0.0, 1.0);
    // Orthographic ray: origin far in +z, direction -z.
    vec3 o = vec3(v_local.x, v_local.y, 1000.0);
    vec3 d = vec3(0.0, 0.0, -1.0);
    vec3 oPerp = o - dot(o, axis) * axis;
    vec3 dPerp = d - dot(d, axis) * axis;
    float A = dot(dPerp, dPerp);
    // Guard: when the ring is tumbled so its axis aligns with
    // the view direction, dPerp → 0 and A → 0, blowing up t1/t2
    // to ±∞/NaN. Skip the ring/plate intersection entirely in
    // that edge-on window and fall through to the sun branch.
    bool ringSkip = A < 1e-6;
    float B = 2.0 * dot(oPerp, dPerp);
    float C = dot(oPerp, oPerp) - R * R;
    float disc = B * B - 4.0 * A * C;
    float centerD = length(v_local);
    float sunR = v_baseR * 0.55;
    // Sun shows when the ray doesn't land on any band segment.
    // Inlined — called twice below so just compute once and use
    // a flag.
    bool ringHit = false;
    bool isInside = false;
    vec3 hit; float axPos;
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
    // ── Shadow plates ──────────────────────────────────────
    // A smaller inner cylinder of N orbiting plates sits between
    // the outside ring wall and the sun. They render as their
    // own geometry (dark structural panels, near-face shaded,
    // far-face sun-lit with a tight specular), and also cast
    // sun-shadow onto the inside ring surface.
    //
    // Camera visibility: plates are ALWAYS behind the ring's
    // outside face, so when the outside face is the selected
    // ring hit, plates are occluded. In every other case (inside
    // face visible, OR ray misses ring entirely but still passes
    // through plate radius), plates may be drawn.
    int plateCount = (int(v_flags) >> 8) & 7;
    float Rp = R * 0.55;
    float Hp = H * 0.70;
    float plateSpin = u_time * 0.04;
    float plateSpacing = (plateCount > 0) ? TAU / float(plateCount) : TAU;
    float plateHalfW = plateSpacing * 0.22;
    bool outsideVisible = ringHit && !isInside;
    // Render priority from camera forward:
    //   1. outside ring wall  (handled after this block)
    //   2. plate near wall (k=0)  ← this block, first pass
    //   3. SUN at axis  ← sun-priority check below
    //   4. plate far wall (k=1)  ← this block, second pass
    //   5. inside ring wall  (handled after this block)
    // Running both plate walls in one pass caused the far wall
    // (k=1) to render on top of the sun even when the sun was
    // geometrically in front of it. The fix is to split the
    // plate test in two and do the sun priority check in between.
    float Cp = dot(oPerp, oPerp) - Rp * Rp;
    float discp = B * B - 4.0 * A * Cp;
    float sqp = (discp >= 0.0) ? sqrt(discp) : 0.0;
    bool platesOk = plateCount > 0 && !outsideVisible && !ringSkip
                 && discp >= 0.0;

    // ── Plate NEAR wall (k=0) — closest, occludes sun ──
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
          outColor = vec4(pCol, 1.0);
          return;
        }
      }
    }

    // ── Sun overlay alpha/color ─────────────────────────────
    // Computed once here, applied as an alpha-blended overlay
    // wherever the sun should be visible (plate-far, inside, or
    // pure ring-miss empty). Outside occludes the sun, so the
    // outside-face render doesn't blend it in. Plate-near
    // occludes the sun (returned above), so this only runs
    // past that point.
    float sunAlpha = 0.0;
    vec3 sunCol = vec3(1.0, 0.92, 0.65);
    if (!outsideVisible && centerD < sunR) {
      float glowT = 1.0 - smoothstep(0.0, sunR, centerD);
      float coreT = 1.0 - smoothstep(0.0, v_baseR * 0.25, centerD);
      sunAlpha = clamp(glowT * 0.45 + coreT * 0.55, 0.0, 1.0);
    }

    // ── Plate FAR wall (k=1) — sun-facing side with specular.
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
          // Sun sits geometrically in front of the far plate —
          // blend its glow on top so the sun's edge fades into
          // the plate instead of hitting it with a hard line.
          pCol = mix(pCol, sunCol, sunAlpha);
          outColor = vec4(pCol, 1.0);
          return;
        }
      }
    }

    // ── Ring miss → sun-over-empty or pure empty.
    if (!ringHit) {
      // Match the game's original premultiplied output so
      // the sun can blend against the galaxy/bgstars background.
      outColor = vec4(sunCol * sunAlpha, sunAlpha);
      return;
    }
    float widthT = axPos / H + 0.5;   // 0 bottom → 1 top
    vec2 ringPt = vec2(dot(hit, basU), dot(hit, basV));
    float theta = atan(ringPt.y, ringPt.x);
    float spin = u_time * 0.12;
    float u = theta + spin;
    // Camera-direction light source for 3D shading. Outward
    // normal is radial from the axis; the visible face's normal
    // flips sign depending on inside vs outside.
    vec3 outward = (hit - dot(hit, axis) * axis) / R;
    float ndl = isInside ? -outward.z : outward.z;
    ndl = max(ndl, 0.0);
    float lit = 0.20 + 2.70 * ndl;
    float litInside = 0.01 + 1.7 * ndl;
    // Axial gradient along the ring's own axis — "top" is the
    // positive axis end (widthT → 1), "bottom" is the negative
    // axis end (widthT → 0). Darker at top, brighter at bottom.
    float vertShade = mix(1.10, 0.80, widthT);
    // Band-edge rims: darken the top rim, brighten the bottom rim.
    float topEdge = smoothstep(0.82, 1.0, (widthT - 0.5) * 2.0);
    float botEdge = smoothstep(0.82, 1.0, (0.5 - widthT) * 2.0);
    if (isInside) {
      // INSIDE surface — faces the sun, fully lit.
      // Every multiplier of u must be an integer so the texture
      // seams up at theta wrap (u is theta + spin).
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
      // Cloud clumps — multi-octave, domain-warped so we get
      // irregular patches instead of parallel stripes. u terms
      // stay integer; widthT terms are free.
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
      // Atmospheric limb glow — warm fresnel at the silhouette
      // only on the inside face. Identifies "far arc" at a glance.
      float fres = pow(1.0 - abs(outward.z), 4.0);
      col += vec3(1.0, 0.78, 0.55) * fres * 0.45;
      // Specular hotspot on the inside — normal flips sign since
      // the visible face is the far wall. Masked to water only
      // (landT=0) so oceans glint but continents stay matte.
      float specIn = pow(max(-outward.z, 0.0), 32.0);
      col += vec3(1.0, 0.95, 0.80) * specIn * 0.85 * (1.0 - landT);
      col *= vertShade;
      // Sun-shadow + city lights — skipped entirely when the
      // ringworld has no plates (plateCount == 0), so a plate-
      // free ring spends no shader cycles on either.
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
        // pow(shadow, 3) concentrates lights toward the deep
        // night center, so twilight contributes negligibly.
        float cityShadow = pow(shadow, 3.0);
        col += cityCol * cities * cityShadow * landT * 1.20;
      }
      // Sun overlay — for inside-face pixels within the sun's
      // screen disc, blend the sun glow on top (sun is closer
      // to camera than the inside far wall).
      col = mix(col, sunCol, sunAlpha);
      outColor = vec4(col, 1.0);
      return;
    } else {
      // OUTSIDE surface — honeycomb with per-hex grayscale.
      // Pointy-top hexes are 1 unit wide × 2·sqrt(3)/3 ≈ 1.155
      // units tall in this parameterization, so for roughly
      // equilateral cells:
      //   NCOLS ≈ 2π · (R/H) · WSCALE / 1.155 ≈ 19.58 · WSCALE.
      // With R = 3.6·H and WSCALE = 3, NCOLS ≈ 58.
      // NCOLS must be even so the hex row parity wraps at the
      // theta seam.
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
      // Seam wrap: a hex straddling the theta seam reads as
      // hexId.x = 0 on the positive side and hexId.x = NCOLS on
      // the wrap side. Without this mod, the hash would pick a
      // different tone for each side, producing a visible line.
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
      // Specular hotspot on the near-facing outside — a tight
      // highlight where the structural panels face the camera
      // directly. Reads as "near arc."
      float spec = pow(max(outward.z, 0.0), 32.0);
      col += vec3(0.95, 0.92, 0.85) * spec * 0.55;
      col *= vertShade;
      outColor = vec4(col, 1.0);
      return;
    }
  }

#ifdef NEBULA_ONLY
  // nebula-style supernova remnant — modelled as level sets of an
  // r-biased simplex FBM scalar field. Concretely:
  //
  //   field(x, y) = r + amp · fbmSimplex(loc / v_baseR)
  //
  // Shells are the contours of this field at four fixed values
  // (0.55, 1.05, 1.55, 2.10). Because the FBM contribution is
  // strong (0.75 amplitude) relative to the radial r term, the
  // contours are NOT closed circles — they fold back, fork, and
  // form disconnected fragments wherever the FBM gradient
  // reverses sharply. This is what kills the circular topology
  // the previous "deformed sphere" approaches couldn't escape:
  // the SAME shell value can be hit by multiple disconnected
  // 2D regions, producing the actual fragmented-shell look of
  // a real supernova remnant. Simplex (vs value-noise) gives
  // smoother gradients with no axis-aligned grid artefacts.
  if (isNebula) {
    float r = d / max(v_baseR, 1.0);
    vec2 puv = loc / max(v_baseR, 1.0);
    vec2 seedOff = vec2(v_seed * 7.3, v_seed * 11.7);
    vec3 seedOff3 = vec3(seedOff, v_seed * 5.1);

    // ── Per-nebula categorical sweeps ──────────────────────
    // Categorical parameters drive class differences between
    // nebulae — palette (Crab vs Helix vs blue vs dust-reddened),
    // structural amplitudes, and central-source flavour. These
    // are all driven by v_seed so the same nebula always picks
    // the same class but adjacent nebulae vary widely.

    // Palette index ∈ {0, 1, 2, 3}
    int paletteIdx = int(fract(v_seed * 13.7) * 4.0);
    // Shell-threshold multiplier — extended range gives compact
    // dense → sparse diffuse variety (was 0.85-1.20 → 1.4×; now
    // 0.60-1.60 → 2.7×).
    float cavitySize = mix(0.60, 1.60, fract(v_seed * 5.71));
    // Bipolar strength — fixed at 0.65 originally; now ranges so
    // some nebulae are nearly spheroidal, others aggressively
    // cigar-shaped. Coupled to cavitySize: the worst-case shell-4
    // reach is 2.59*cavitySize + 0.75 (fbm) + bipolarAmp*0.6
    // (cigar elongation) + 0.49 (3σ + jit), and the star quad is
    // 4.3 v_baseR-units along its side. Capping the upper end of
    // bipolarAmp by cavitySize keeps the body inside the quad —
    // sparse nebulas (high cavitySize) end up more spheroidal,
    // dense nebulas (low cavitySize) keep the full cigar range.
    float bipolarAmpMax = clamp(
      (3.06 - 2.59 * cavitySize) / 0.6, 0.0, 0.95);
    float bipolarAmpMin = min(0.30, bipolarAmpMax);
    float bipolarAmp = mix(bipolarAmpMin, bipolarAmpMax,
                            fract(v_seed * 3.13));
    // Density multiplier — scales per-shell rho weights, so some
    // nebulae have more "gas budget" than others independent of
    // their compactness.
    float densityMult = mix(0.70, 1.40, fract(v_seed * 19.7));
    // Fibre / shock texture frequency multiplier — varies the
    // crinkled boundary character.
    float fibreFreqMult = mix(0.60, 1.50, fract(v_seed * 11.13));
    // Edge-texture variation: per-nebula pow exponent, bias floor,
    // and gain on the fibre overlay. Varying these breaks the
    // shared "fingerprint" crinkle that recurred across nebulae.
    float fibrePow   = mix(1.00, 2.50, fract(v_seed * 23.7));
    float fibreFloor = mix(0.20, 0.45, fract(v_seed * 29.3));
    float fibreGain  = mix(1.00, 1.80, fract(v_seed * 31.1));

    // Per-nebula stratification offset — shifts the radial
    // crisp-to-soft gradient that's wired into the per-shell
    // edge masks below. Negative → "young" (all shells biased
    // crisp); positive → "old" (all shells biased diffuse);
    // zero → balanced. Continuous axis so neighbouring nebulae
    // transition smoothly between regimes.
    float stratOffset = (fract(v_seed * 73.1) - 0.5) * 0.8;
    // Central-source flavour — VISIBILITY of the central
    // pinpoint, NOTHING else. Does not affect interior fill;
    // that's a separate axis below.
    //   0 = visible pinpoint at centre
    //   1 = hidden source (no pinpoint; cavity gas still glows)
    //   2 = off-centre pinpoint
    int centralFlavour = int(fract(v_seed * 17.31) * 3.0);
    vec2 pulsarOffset = vec2(0.0);
    if (centralFlavour == 2) {
      pulsarOffset = vec2(
        snoiseN(vec2(v_seed * 13.0, 0.0)),
        snoiseN(vec2(0.0, v_seed * 17.0))
      ) * 0.55;
    }

    // Interior-fill density — INDEPENDENT axis. Was previously
    // tangled with centralFlavour (hide the pulsar → kill the
    // cavity). Now: 50 % full body / 35 % moderate / 15 % etched.
    // Etched mode also boosts the fibre gain so the linework
    // character becomes a deliberate aesthetic instead of an
    // accidental drift.
    float fillRoll = fract(v_seed * 47.3);
    float fillMult;
    float aestheticFibreGain;
    if (fillRoll < 0.50) {
      fillMult = 1.20;            // full body
      aestheticFibreGain = 1.00;
    } else if (fillRoll < 0.85) {
      fillMult = 0.80;            // moderate
      aestheticFibreGain = 1.05;
    } else {
      fillMult = 0.40;            // sparse / etched aesthetic
      aestheticFibreGain = 1.45;
    }

    // Per-palette shell colours, per-shell weights, and pulsar
    // character. Each palette is a different physical species —
    // not just a hue rotation — so the brightness profile across
    // shells AND the central source character vary by palette.
    //
    //   0 — Crab synchrotron: cyan/yellow/orange/red/red,
    //       roughly even shell weights, sharp hot pinpoint.
    //   1 — Helix OIII: green/cyan/pale/soft red/dim, bimodal
    //       weights — OIII core (shells 0-1) + Hα halo (shells
    //       3-4), faint mid-shell trough. Softer cooler pulse.
    //   2 — NGC 7027 hot blue: blue/cyan/pale orange/pink/muted,
    //       moderate weights, blue-cored hot star.
    //   3 — Dust-reddened: amber/orange/red/deep/brown,
    //       back-loaded weights (outer dust dominant), dim amber
    //       central source with no pulse.
    vec3 shell0Col, shell1Col, shell2Col, shell3Col, shell4Col;
    vec3 paletteGlow, paletteCore;
    float w0, w1, w2, w3, w4;
    float pulsarFalloff, pulsarPulseRate, pulsarBrightness;
    // Per-palette dust-scatter coefficients for the Tier-1
    // single-scatter halo. scatterMul=0 disables scatter entirely
    // (synchrotron palettes are direct emission, not scattered).
    // phaseG is the Henyey-Greenstein asymmetry parameter; larger
    // = more forward-peaked scatter, typical of bigger grains.
    float scatterMul, phaseG;
    if (paletteIdx == 0) {
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
      // Synchrotron is direct emission from relativistic
      // electrons — no dust-scatter halo.
      scatterMul = 0.0;
      phaseG = 0.0;
    } else if (paletteIdx == 1) {
      shell0Col = vec3(0.40, 0.90, 0.55);
      shell1Col = vec3(0.50, 0.95, 0.85);
      shell2Col = vec3(0.92, 0.98, 0.78);
      shell3Col = vec3(0.95, 0.55, 0.45);
      shell4Col = vec3(0.78, 0.30, 0.30);
      paletteGlow = vec3(0.55, 0.95, 0.85);
      paletteCore = vec3(0.75, 1.00, 0.85);
      // Bimodal radial structure — inner OIII peak (shells 0-1)
      // and outer Hα peak (shells 3-4) with a faint mid-shell
      // trough. The shell colours already split cyan/red across
      // 0-1 vs 3-4, so reweighting alone produces the two-zone
      // appearance characteristic of bipolar planetary nebulae.
      w0 = 0.30; w1 = 0.25; w2 = 0.10; w3 = 0.20; w4 = 0.15;
      pulsarFalloff = 150.0;
      pulsarPulseRate = 4.50;
      pulsarBrightness = 1.30;
      // Hot CSPN with small dust grains — mild forward scatter.
      scatterMul = 0.4;
      phaseG = 0.3;
    } else if (paletteIdx == 2) {
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
      // Moderate scatter, stronger forward peak.
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
      // Reflection-nebula regime — heavy dust, large grains,
      // strongly forward-scattering. Halo is the dominant
      // illumination signal here even when the source is dim.
      scatterMul = 1.0;
      phaseG = 0.5;
    }
    // Apply density multiplier to all per-shell weights.
    w0 *= densityMult; w1 *= densityMult; w2 *= densityMult;
    w3 *= densityMult; w4 *= densityMult;
    // Pulsar visible only when centralFlavour says so; halo /
    // mid-glow brightness comes from the INDEPENDENT fillMult
    // axis. The two are now decoupled — hidden-source nebulae
    // can still have bright cavities, etched-aesthetic nebulae
    // can still have visible pulsars.
    float pulsarMul    = (centralFlavour == 1) ? 0.0 : 1.0;
    float innerHaloMul = fillMult;
    float midGlowMul   = fillMult;

    // ── Morphology category ───────────────────────────────
    // 0–5: ellipsoidal (default closed-volume shells).
    // 6–7: filamentary — replaces r3D with a quadratic-Bezier
    // tube SDF, producing bent dust lanes / S-curves / variable-
    // thickness jets that the ellipsoid primitive can't reach.
    // ~25 % of seeds route to filamentary.
    int morphCat = int(fract(v_seed * 53.7) * 8.0);
    bool isFilament = morphCat >= 6;

    // Quadratic Bezier control points (used only when isFilament).
    // P0 / P2 are endpoints along a per-nebula axis; P1 is the mid
    // control offset from the segment midpoint by a per-nebula bend
    // direction × bend amplitude. Curve total reach kept inside
    // the integration volume (~ ±2.4 v_baseR-units).
    vec3 filamentP0 = vec3(0.0);
    vec3 filamentP1 = vec3(0.0);
    vec3 filamentP2 = vec3(0.0);
    if (isFilament) {
      float endAng = v_seed * 5.7;
      vec3 endDir = normalize(vec3(
        cos(endAng),
        0.6 * sin(endAng),
        0.3 * sin(endAng * 1.3)
      ));
      float endLen = 2.4;
      filamentP0 = -endDir * endLen;
      filamentP2 =  endDir * endLen;
      // Bend direction orthonormal to endDir, rotated per-nebula.
      vec3 refV = abs(endDir.y) < 0.9
                ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
      vec3 perp1 = normalize(cross(endDir, refV));
      vec3 perp2 = cross(endDir, perp1);
      float bendAng = v_seed * 13.7;
      vec3 bendDir = perp1 * cos(bendAng) + perp2 * sin(bendAng);
      // Bend amplitude in [0.6, 2.0] — most filaments moderately
      // bent, some seeds produce strongly S-curved outliers.
      float bendAmp = 0.6 + 1.4 * fract(v_seed * 71.3);
      filamentP1 = bendDir * bendAmp;
    }

    // Very slow Lissajous flow through the 3D FBM domain.
    // Multipliers 0.01 / 0.02 / 0.03 are 2-decimal → sin/cos at
    // TIME_WRAP match values at t=0 (no wrap pop). Periods:
    // ~628s (≈10.5 min), ~314s, ~209s. The z-component drifts
    // too, so the simplex isn't just translating in the (x, y)
    // plane — it's "boiling" through 3D, giving the shells slow
    // continuous topology change over many minutes. Amplitude
    // bumped (1.5 → 2.0) so over a full slow cycle the sample
    // point traverses a noticeable patch of FBM space.
    vec3 flow = vec3(sin(u_time * 0.01 + v_seed),
                     cos(u_time * 0.02 + v_seed * 1.3),
                     sin(u_time * 0.03 + v_seed * 2.1)) * 2.0;

    float fbmScale = 0.55;

    // Per-nebula ellipsoidal shape: random eccentricity in
    // [0.08, 0.25] and random rotation angle. All shells share
    // ecc and angle so the body stays coherent.
    float ecc = 0.08 + 0.17 * fract(v_seed * 7.31);
    float ang = v_seed * 1.7;
    float cosA = cos(ang), sinA = sin(ang);
    float majA = 1.0 + ecc;
    float minA = 1.0 - ecc;
    vec2 rotLocN = vec2(loc.x * cosA + loc.y * sinA,
                       -loc.x * sinA + loc.y * cosA)
                 / max(v_baseR, 1.0);
    float xN = rotLocN.x / majA;
    float yN = rotLocN.y / minA;
    float xy_term = xN * xN + yN * yN;

    // BIPOLAR ASYMMETRY with FBM-jittered waist + wild lobe
    // asymmetry. Base term gives the cigar shape; waist jitter
    // breaks the geometrically-clean pinch; lobeAsym samples a
    // very-low-frequency FBM and applies it to ONE hemisphere
    // only (the +pole side), so one lobe routinely ends up
    // bigger / brighter / further out than the other. Per-nebula
    // amplitude lobeAsymAmp ranges so most nebulae are nearly
    // symmetric but some seeds produce wildly asymmetric outliers.
    // poleAng = ang + 0.3; derive cos/sin via angle-sum identity
    // from cosA/sinA so the trig is computed once for both the
    // ellipsoidal rotation and the pole axis.
    const float COS_03 = 0.95533648;
    const float SIN_03 = 0.29552020;
    vec2 poleDir = vec2(cosA * COS_03 - sinA * SIN_03,
                        sinA * COS_03 + cosA * SIN_03);
    // dot/inversesqrt instead of length+divide; max() floor folds
    // the original > 0.001 guard into a single op.
    float rotLen2 = dot(rotLocN, rotLocN);
    float invRotLen = inversesqrt(max(rotLen2, 1e-6));
    float dirAlongPole = dot(rotLocN, poleDir) * invRotLen;
    float cosSq = dirAlongPole * dirAlongPole;
    float biPolarBase = -bipolarAmp * (cosSq - 0.40);
    float waistJitter = 0.18 * snoiseN(puv * 0.7
                                        + seedOff + flow.xy);
    // Per-nebula lobe-asymmetry amplitude. Skewed distribution
    // (squared) so most nebulae have low asymmetry but a few
    // get wildly lopsided outliers.
    float lobeAsymRoll = fract(v_seed * 41.7);
    float lobeAsymAmp = 0.45 * lobeAsymRoll * lobeAsymRoll;
    // Very-low-frequency FBM. Sampled at a different scale per
    // nebula via seedOff. step(0.0, dirAlongPole) selects the
    // +pole hemisphere only — −pole side is unaffected.
    float lobeFBM = fbm3DN(vec3(rotLocN * 0.45 + seedOff
                                  + vec2(57.0, 73.0), v_seed * 11.0));
    float lobeAsym = lobeAsymAmp * lobeFBM
                   * step(0.0, dirAlongPole);

    // Butterfly equatorial pinch — sharp cavity at dirAlongPole
    // ≈ 0. cot²θ peaks at the equator and falls off Gaussian-
    // sharply toward the poles, carving a thin waist that the
    // smooth cos²θ bipolar bias can't reach. ~20 % of non-
    // filament seeds get the categorical roll. Smoothstep gate
    // on bipolarAmp keeps spheroidal nebulae from picking up an
    // awkward notched waist.
    //   BUTTERFLY_NECK_AMP  — peak field bump at equator.
    //   BUTTERFLY_SHARPNESS — exponent in exp(-cotSq * S); higher
    //                          = thinner waist, lower = wider.
    const float BUTTERFLY_NECK_AMP  = 0.85;
    const float BUTTERFLY_SHARPNESS = 16.0;
    bool isButterfly = !isFilament
                    && fract(v_seed * 67.7) < 0.20;
    float butterflyNeck = isButterfly
      ? BUTTERFLY_NECK_AMP * smoothstep(0.50, 0.80, bipolarAmp)
      : 0.0;
    // cosSq already computed pre-bipolarBase; reuse here.
    float cotSq = cosSq / max(1.0 - cosSq, 1e-3);
    float neck = butterflyNeck * exp(-cotSq * BUTTERFLY_SHARPNESS);

    float biPolar = biPolarBase + waistJitter + lobeAsym + neck;

    // HIGH-FREQUENCY DOMAIN WARP — adds wisps-inside-wisps
    // detail at a finer scale than the slow flow-driven
    // base FBM (which lives at ~0.55 cycles / v_baseR). At
    // 5x base frequency this is ~2.75 cycles / v_baseR.
    // Amplitude small (0.07 puv-units) so it perturbs sample
    // positions modestly without smearing structure.
    vec2 hiBase = rotLocN * 5.0 + seedOff;
    vec2 hiWarp = vec2(snoiseN(hiBase),
                       snoiseN(hiBase + vec2(11.0, 7.0))) * 0.07;

    // Volumetric integration along the line of sight z. The 3D
    // scalar field is
    //
    //     field(p) = |p|/v_baseR + 0.75 · fbm3D(p · fbmScale)
    //
    // Shells are level sets of this field at fixed values
    // (0.55, 1.05, 1.55, 2.10). For each fragment we step along z
    // from -ZMAX to +ZMAX, evaluate the field, and accumulate
    // every shell's Gaussian contribution at every step.
    //
    // This is what produces the 3D look:
    //   • At the limb of a shell (line of sight tangent), several
    //     consecutive z steps land near the shell threshold —
    //     contributions stack → bright limb.
    //   • Lines of sight crossing the shell front-and-back at a
    //     given 2D position pick up contributions at TWO distinct
    //     z values along the integral — produces visible depth.
    //   • No per-shell sqrt(Rn² - r²) boundary — that's what
    //     created the previous circular artefacts.
    //   • Fragments outside any shell silhouette still get the
    //     full integration (with field values too far from any
    //     threshold to contribute), so there's no carved-out
    //     circle anywhere.
    const int N_STEPS = 7;
    const float ZMAX = 2.7;
    float shellMask = 0.0;
    vec3 shellColAccum = vec3(0.0);

    // ── Per-shell edge masks (Design A) ───────────────────
    // Compute TWO 2D noise signals once per fragment — one
    // ridged (crisp shock filaments) and one smooth value FBM
    // (diffuse haze). Each shell block inside the integration
    // loop mixes between them based on its intrinsic softness
    // (radial role: inner crisp → outer diffuse) plus the
    // per-nebula stratOffset. Different shells in the SAME
    // nebula now have different edge regimes — natural shock
    // stratification, not a single uniform contour.
    float fibreFreq = mix(2.5, 8.0, smoothstep(0.0, 2.0, r))
                    * fibreFreqMult;
    float ridgedSample = ridgedFBMN(puv * fibreFreq
                                     + seedOff * 0.7);
    float ridgedEdge = pow(clamp(ridgedSample, 0.0, 1.0), fibrePow);
    // Smooth value FBM at lower frequency — diffuse haze with its
    // own character, distinct from the ridged crisp filaments.
    float smoothSample = vnoiseN(puv * (fibreFreq * 0.55)
                                  + seedOff * 0.7 + vec2(13.7, 7.3));
    float smoothEdge = smoothstep(0.25, 0.75, smoothSample);

    // ── Z-independent per-shell precomputes ───────────────
    // The integration loop body re-evaluates these at every
    // z-step even though none of them depend on zStep. Hoisting
    // is bit-identical and saves ~30 snoise calls / fragment.

    // Shock mask — ridged FBM gated to genuinely compressed
    // regions; multiplies shell brightness, not hue. Threshold
    // 0.55 keeps the bulk of every shell at its base colour.
    float shockMask = ridgedFBMN(rotLocN * 2.5
                                  + seedOff + flow.xy * 0.5);
    shockMask = pow(clamp(shockMask, 0.0, 1.0), 1.6);
    float shockBrighten = 1.0
                        + 0.55 * smoothstep(0.55, 0.85, shockMask);

    // Per-shell field-threshold jitter — angular FBM bumps that
    // break the radially-even shell spacing. Each shell uses a
    // different fixed offset so they jitter independently.
    vec2 jitBase = rotLocN * 0.8 + seedOff;
    float jit0 = 0.10 * snoiseN(jitBase);
    float jit1 = 0.10 * snoiseN(jitBase + vec2(7.3, 11.0));
    float jit2 = 0.10 * snoiseN(jitBase + vec2(13.0, 5.7));
    float jit3 = 0.10 * snoiseN(jitBase + vec2(23.0, 17.0));
    float jit4 = 0.10 * snoiseN(jitBase + vec2(31.0, 41.0));

    // Per-shell edge softness in [0,1] — intrinsic radial role
    // (0 = inner crisp, 1 = outer diffuse) plus per-nebula
    // stratOffset shift. Drives the ridged-vs-smooth edge blend.
    float es0 = clamp(0.00 + stratOffset, 0.0, 1.0);
    float es1 = clamp(0.25 + stratOffset, 0.0, 1.0);
    float es2 = clamp(0.50 + stratOffset, 0.0, 1.0);
    float es3 = clamp(0.75 + stratOffset, 0.0, 1.0);
    float es4 = clamp(1.00 + stratOffset, 0.0, 1.0);
    float edge0 = mix(ridgedEdge, smoothEdge, es0);
    float edge1 = mix(ridgedEdge, smoothEdge, es1);
    float edge2 = mix(ridgedEdge, smoothEdge, es2);
    float edge3 = mix(ridgedEdge, smoothEdge, es3);
    float edge4 = mix(ridgedEdge, smoothEdge, es4);
    float fl0 = mix(fibreFloor, fibreFloor + 0.30, es0);
    float fl1 = mix(fibreFloor, fibreFloor + 0.30, es1);
    float fl2 = mix(fibreFloor, fibreFloor + 0.30, es2);
    float fl3 = mix(fibreFloor, fibreFloor + 0.30, es3);
    float fl4 = mix(fibreFloor, fibreFloor + 0.30, es4);
    float gnFull = fibreGain * aestheticFibreGain;
    float gnSoft = gnFull * 0.5;
    float gn0 = mix(gnFull, gnSoft, es0);
    float gn1 = mix(gnFull, gnSoft, es1);
    float gn2 = mix(gnFull, gnSoft, es2);
    float gn3 = mix(gnFull, gnSoft, es3);
    float gn4 = mix(gnFull, gnSoft, es4);

    // Per-shell base colours and lumas (pre satF desaturation).
    // satF varies per z-step inside the loop; only the
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

    // Factor the loop-invariant parts of the FBM sample point
    // construction. Originally:
    //   p3 = vec3(puv + hiWarp, zStep) * fbmScale + seedOff3 + flow;
    // The xy and z-constant components don't depend on zStep,
    // so the in-loop work collapses to a single fma in z.
    vec2  p3xyConst = (puv + hiWarp) * fbmScale + seedOff3.xy + flow.xy;
    float p3zConst  = seedOff3.z + flow.z;

    // Henyey-Greenstein phase function precomputes for the per-
    // step scatter integral. (1-g²) and g² are palette-derived
    // and z-independent.
    float phaseG2 = phaseG * phaseG;
    float oneMinusG2 = 1.0 - phaseG2;
    float scatterCoeff = scatterMul * pulsarBrightness;

    // FRONT-TO-BACK volumetric integration with transmittance.
    // trans = 1.0 in front of the volume; decays as we accumulate
    // density through each step. Per-step contributions are pre-
    // multiplied by trans so back shells are dimmed by the front
    // shells' density — gives real volumetric self-shadowing.
    float trans = 1.0;

    for (int i = 0; i < N_STEPS; i++) {
      float t = (float(i) + 0.5) / float(N_STEPS);
      // Reversed direction — i=0 is the FRONT face, i=N_STEPS-1
      // is the BACK face.
      float zStep = ZMAX - 2.0 * ZMAX * t;
      // Apply hi-freq warp to puv input AND bipolar bias to the
      // resulting field (computed once before the loop). xy and
      // z-constant parts hoisted as p3xyConst / p3zConst.
      vec3 p3 = vec3(p3xyConst, zStep * fbmScale + p3zConst);
      float fbm = fbm3DN(p3);

      // 3D distance field. Ellipsoidal vs filamentary path
      // depends on per-nebula morphology category. Filamentary
      // computes distance to a quadratic Bezier tube and
      // normalises by per-position thickness — closed shells
      // become tube layers wrapping a bent curve.
      float r3D;
      float field;
      if (isFilament) {
        vec3 pos3 = vec3(puv, zStep);
        // Closest point on quadratic Bezier — coarse subdivided
        // sampling (12 evenly-spaced t values) followed by 2
        // Newton-iteration refinements from the best sample.
        // Returns bestT ∈ [0, 1] approximating the parameter
        // of the closest point.
        float bestT = 0.5;
        float bestD2 = 1e9;
        for (int i = 0; i < 12; i++) {
          float t = (float(i) + 0.5) / 12.0;
          float u = 1.0 - t;
          vec3 onC = u * u * filamentP0
                   + 2.0 * u * t * filamentP1
                   + t * t * filamentP2;
          vec3 dv = pos3 - onC;
          float d2 = dot(dv, dv);
          if (d2 < bestD2) { bestD2 = d2; bestT = t; }
        }
        // Newton refine: f(t) = (B(t) - P) · B'(t) = 0
        for (int i = 0; i < 2; i++) {
          float u = 1.0 - bestT;
          vec3 onC = u * u * filamentP0
                   + 2.0 * u * bestT * filamentP1
                   + bestT * bestT * filamentP2;
          vec3 dC = -2.0 * u * filamentP0
                  + 2.0 * (1.0 - 2.0 * bestT) * filamentP1
                  + 2.0 * bestT * filamentP2;
          vec3 d2C = 2.0 * filamentP0 - 4.0 * filamentP1 + 2.0 * filamentP2;
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
        // Variable thickness along t — narrow at ends, fat in
        // middle (sin(πt) profile). cavitySize is NOT applied
        // here because the per-shell threshold already gets
        // multiplied by cavitySize, which adjusts layer spacing
        // around the tube without double-counting.
        float thickness = mix(0.18, 0.55, sin(bestT * PI));
        r3D = distToCurve / max(thickness, 0.05);
        // No bipolar / waist jitter for filaments — they're
        // already a directed structure; the bend is the
        // morphology axis.
        field = r3D + 0.75 * fbm;
      } else {
        // Ellipsoidal 3D radius — z scaled by minA so the
        // ellipsoid is prolate along the rotated x' axis.
        // invMinASq hoisted pre-loop drops a per-step divide.
        r3D = sqrt(xy_term + zStep * zStep * invMinASq);
        // Bipolar bias faded to zero inside the cavity so the
        // inner-most region stays spherical and shells don't
        // read as rays radiating from the central source.
        float bpFade = smoothstep(0.6, 1.3, r3D);
        field = r3D + 0.75 * fbm + biPolar * bpFade;
      }

      // Per-step rho/colour accumulators. Each shell adds to
      // these; after all shells we composite this step front-to-
      // back using the running trans value.
      float rhoStep = 0.0;
      vec3 colStep = vec3(0.0);

      // Radial saturation curve — saturated near the ionizing
      // pulsar, muted at the outer dust. 1.25 boost in cavity,
      // 0.80 mute at outer ejecta. Depends on r3D so stays in
      // the loop; shockBrighten is hoisted pre-loop.
      float satF = mix(1.25, 0.80, smoothstep(0.5, 2.5, r3D));

      // Per-shell base thresholds (irregular spacing — 0.27,
      // 0.20, 0.32, 0.20, 0.30 gaps) plus a per-shell angular
      // FBM jitter that destroys the even-spacing heartbeat at
      // any fixed direction.

      // Shell 0 — innermost (sigma 0.06). Edge style: crisp
      // ridged filaments (intrinsic softness 0.0).
      // 3σ skip: outside |dF| < 3σ the Gaussian is < exp(-9) ≈
      // 1e-4 — well below the perceptual floor after compositing.
      {
        float dF = field - (1.50 * cavitySize + jit0);
        float dFsq = dF * dF;
        if (dFsq < 0.0324) {
          float m = exp(-dFsq / 0.0036);
          m *= mix(1.0, 0.18, smoothstep(0.0, 0.06, dF));
          m *= fl0 + gn0 * edge0;
          // Cap radial saturation boost on shell 0 (inner band)
          // so saturated palettes don't go neon.
          float satFShell0 = min(satF, 1.05);
          vec3 shellC = mix(vec3(luma0), baseShell0, satFShell0);
          rhoStep += m * w0;
          colStep += shellC * m * w0;
        }
      }
      // Shell 1 (sigma 0.07). Intrinsic softness 0.25.
      {
        float dF = field - (1.77 * cavitySize + jit1);
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
        float dF = field - (1.97 * cavitySize + jit2);
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
        float dF = field - (2.29 * cavitySize + jit3);
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
      // dustM exports shell 4's m as the dust-density proxy used
      // by the scatter integral below. Stays 0 outside the 3σ
      // window so scatter only kicks in where dust is present.
      float dustM = 0.0;
      {
        float dF = field - (2.59 * cavitySize + jit4);
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

      // Tier-1 single-scatter halo — palette-aware dust glow
      // around the central source. Only fires for palettes with
      // scatterMul > 0 (Crab synchrotron is excluded), and only
      // where shell 4 (the dust proxy) is contributing.
      // Optically-thin: no source-to-sample or sample-to-camera
      // opacity integrals. The trans factor still attenuates the
      // back-side scatter via the existing composite.
      if (scatterMul > 0.0 && dustM > 0.0) {
        vec3 fromSource = vec3(puv, zStep) - vec3(pulsarOffset, 0.0);
        // Plummer-style soft core (0.5 v_baseR-unit radius) so
        // 1/r² doesn't spike at samples adjacent to the source.
        // Real sources have finite size; the dust cavity has
        // already cleared the inner region anyway.
        float rcs2 = dot(fromSource, fromSource) + 0.25;
        float invR = inversesqrt(rcs2);
        // Scattering angle: light from source at S travels to
        // sample P, then forward-scatters toward the camera at
        // +z. cosScat is the cos of that turn angle.
        float cosScat = fromSource.z * invR;
        // Phase-function softening: ε=0.05 caps the HG forward
        // peak (was unbounded → 6.0× for g=0.5; now ≤ 4.6×).
        // Keeps the angular asymmetry but kills the near-axis
        // spike that combines with low rcs2 to saturate.
        // pow(x, 1.5) spelled out as x * sqrt(x); some compilers
        // miss the fold and emit log/exp.
        float dInner = 1.0 + phaseG2 - 2.0 * phaseG * cosScat + 0.05;
        float denom = dInner * sqrt(dInner);
        float phase = oneMinusG2 / denom;
        colStep += paletteCore * (dustM * phase * scatterCoeff / rcs2);
      }

      // Composite this step with running transmittance, then
      // attenuate trans by Beer-Lambert. Coefficient 1.5 chosen
      // so a thick front shell (rho≈0.4) attenuates following
      // steps by ~exp(-0.6) ≈ 0.55 — visible self-shadowing
      // without making the back hemisphere disappear.
      shellMask    += rhoStep * trans;
      shellColAccum += colStep * trans;
      trans *= exp(-rhoStep * 1.5);
      // Early-out once the back of the volume can no longer
      // contribute meaningfully — saves the trailing z-steps
      // for fragments inside dense bright cores.
      if (trans < 0.005) break;
    }

    if (shellMask > 0.001) shellColAccum /= shellMask;
    // Edge masking now lives PER-SHELL inside the integration
    // loop (Design A). Each shell mixes between ridged crisp
    // filaments and smooth diffuse haze based on its intrinsic
    // radial softness + per-nebula stratOffset. No global
    // post-loop overlay needed — natural shock stratification
    // emerges within each nebula instead of one regime imposed
    // on all five shells.

    // Pulsar position (offset for centralFlavour 3, origin
    // otherwise). pulsarR is distance from the source — used by
    // both the pinpoint and the inner halo so they track together.
    vec2  pulsarP = puv - pulsarOffset;
    float pulsarR = length(pulsarP);

    // Two-stop diffuse cavity glow. Inner halo follows the
    // pulsar's position (so off-centre sources have an off-centre
    // halo); mid glow stays centred on the nebula's geometric
    // origin. Per-flavour multipliers scale each independently —
    // obscured (1) kills the halo entirely, soft-glow (2) boosts it.
    float innerHalo = exp(-pulsarR * pulsarR * 5.5)
                    * smoothstep(0.55, 0.0, pulsarR)
                    * innerHaloMul;
    float midGlow   = exp(-r * r * 1.5)
                    * smoothstep(1.10, 0.0, r)
                    * midGlowMul;
    // Glow colour comes from the palette + 25% v_c1 tint.
    vec3 glowCol = mix(paletteGlow, v_c1, 0.25);

    // Pulsar pinpoint — palette-character driven. Falloff, pulse
    // rate, brightness, and core colour all vary per palette so
    // the central source matches the nebula type instead of being
    // a uniform white sticker. paletteCore is no longer pre-mixed
    // toward white, so cool palettes get genuinely cool stars.
    float pulseT = 0.92 + 0.08 * sin(u_time * pulsarPulseRate + v_seed);
    float pulsar = exp(-pulsarR * pulsarR * pulsarFalloff)
                 * pulseT * pulsarMul;
    vec3  pulsarCol = mix(paletteCore, v_c1, 0.25);

    // Faint palette tint — colorIdx still nudges the per-nebula
    // colour without overpowering the per-shell spectrum.
    shellColAccum = mix(shellColAccum, v_c1, 0.10);

    vec3 col = glowCol * (innerHalo * 0.45 + midGlow * 0.16)
             + pulsarCol * pulsar * pulsarBrightness
             + shellColAccum * shellMask * 1.40;
    float a = clamp(innerHalo * 0.35 + midGlow * 0.12
                    + pulsar + shellMask * 0.85, 0.0, 1.0);

    outColor = vec4(col, a);
    return;
  }
#endif

  // Pulsar — rapidly rotating neutron star. A tiny dense core
  // with two opposed lighthouse beams along a magnetic axis that
  // is offset from the spin axis (~30°). The magnetic axis sweeps
  // around the spin axis; when its 3D direction aligns with the
  // view (camera at +Z), the cone points at us and the pulsar
  // flashes brilliantly. When edge-on, the beams extend as visible
  // rays in the screen plane. The whole thing is drawn entirely
  // analytically — no FBO, no extra geometry.
  if (isPulsar) {
    // Spin axis drifts smoothly over the sphere — three independent
    // 2-decimal rates make each pulsar's axis trace a non-periodic
    // path across the TIME_WRAP window. When the drift carries the
    // axis close to +Z (camera direction) the magnetic axis (30°
    // off spin) sweeps through +Z and the pulsar flashes briefly.
    // Per-pulsar seed phases keep every pulsar's tumble distinct.
    // 1e-4 epsilon prevents a degenerate normalize on the rare
    // frames all three sinusoids cross zero together.
    vec3 spin = normalize(vec3(
      sin(u_time * 0.03 + v_seed * 1.7),
      cos(u_time * 0.02 + v_seed * 2.3),
      sin(u_time * 0.04 + v_seed * 3.1)
    ) + vec3(1e-4));

    // Stable perpendicular to spin via Frisvad's continuous
    // orthonormal frame (2012). The previous abs(spin.y) < 0.9
    // ternary hard-switch produced a visible jet snap every time
    // the spin drift crossed that great-circle band (~once per
    // minute or two). Frisvad's formula has a single singular
    // point at spin = (0,0,-1) instead of a band — and the drift
    // visits that exact point with measure-zero probability.
    vec3 perp;
    if (spin.z < -0.9999) {
      perp = vec3(-1.0, 0.0, 0.0);
    } else {
      float frisA = 1.0 / (1.0 + spin.z);
      perp = vec3(1.0 - spin.x * spin.x * frisA,
                  -spin.x * spin.y * frisA,
                  -spin.x);
    }
    // Rotate perp around spin by a per-pulsar seed angle so the
    // magnetic offset doesn't always point in the same direction.
    float seedAng = v_seed * 2.7;
    float csa = cos(seedAng), ssa = sin(seedAng);
    // perp ⟂ spin so the dot-product term of Rodrigues vanishes.
    vec3 perpRot = perp * csa + cross(spin, perp) * ssa;
    // Magnetic axis at ~30° off spin: cos30 ≈ 0.866, sin30 = 0.5.
    vec3 mag0 = normalize(spin * 0.866 + perpRot * 0.5);

    // Slower fast-rotation rate (0.60) so each flash is visible
    // for longer and the cadence reads as cinematic rather than
    // strobing. 0.60 → 2-decimal, lossless at wrap.
    float ang = u_time * 0.60 + v_seed;
    float cA = cos(ang), sA = sin(ang);
    vec3 mag = mag0 * cA
             + cross(spin, mag0) * sA
             + spin * dot(spin, mag0) * (1.0 - cA);
    mag = normalize(mag);

    vec2 b2D = mag.xy;
    float b2L = length(b2D);
    vec2 bDir = (b2L > 1e-3) ? b2D / b2L : vec2(1.0, 0.0);
    float bZ = abs(mag.z);

    // Tiny dense core — pulsar body is ~0.32× v_baseR, blue-white.
    float coreR = v_baseR * 0.32;
    float coreI = 1.0 - smoothstep(coreR * 0.6, coreR * 1.05, d);

    // Face-on flash: bZ^8 ramps sharply only near alignment, so
    // most of the time the pulsar is dim and the flash is brief.
    float flash = pow(bZ, 8.0);

    // Side beams: two opposed cones along ±bDir. The 3D magnetic
    // poles sit at ±mag*coreR on the neutron-star surface; their
    // 2D projection lies at ±(b2L*coreR)*bDir, so the visible
    // root of each jet foreshortens correctly with the 3D tilt
    // of the magnetic axis. Beam length is also scaled by b2L
    // (zero when face-on, max ~3.5 v_baseR when edge-on).
    float along  = dot(loc, bDir);
    float across = dot(loc, vec2(-bDir.y, bDir.x));
    float beamHalf = v_baseR * (3.5 * b2L);
    float ax = abs(along);
    float poleStart = b2L * coreR;

    // Parametric position along the beam: t = 0 at the pole,
    // t = 1 at the tip. Used by both the width and length envelopes.
    float beamLen = max(beamHalf - poleStart, 0.001);
    float t = (ax - poleStart) / beamLen;

    // Cone width tapers from a small finite vertex at the pole
    // (0.06 v_baseR — represents the hot footpoint on the neutron
    // star surface) to the tip (0.30 v_baseR). Previous version
    // started at 0.16 — a flat cylinder cap, which produced the
    // visible "dark border" stripe at the pole because the cone
    // never narrowed to a vertex.
    float tClamped = clamp(t, 0.0, 1.0);
    float halfW = v_baseR * mix(0.06, 0.30, tClamped);
    float widthT = (halfW > 0.0) ? clamp(abs(across) / halfW, 0.0, 1.0) : 1.0;
    float widthFalloff = exp(-widthT * widthT * 6.0);

    // Length envelope: smooth ramp up over the first 8 % of the
    // beam (so the pole reads as a soft 3D vertex, not a hard
    // edge), then Hermite taper to the tip. Replaces the previous
    // strict-inequality cutoff which produced a hard step at the
    // pole that aliased into a visible thin line.
    float lengthFalloff = (t > 0.0 && t < 1.0)
      ? smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(0.0, 1.0, t))
      : 0.0;
    // Outflowing plasma — two layers, both keyed to ax and -u_time
    // so motion is OUTWARD in both ±bDir directions.
    //
    // 1. Bulk flow: subtle ripple (±8 %) with a phase that varies
    //    across the beam, so the bright bands tilt slightly as they
    //    travel — reads as flow texture, not stripes.
    //
    // 2. Helical hot strip: a bright plasma band whose side-of-axis
    //    position oscillates with ax (rotation around the beam
    //    axis) AND advances outward with time. At any fixed ax the
    //    strip drifts side-to-side; in screen projection that gives
    //    the 3D corkscrew feel of plasma spiraling along a magnetic
    //    flux tube. knotPulse gates the strip into discrete packets
    //    so we see hot blobs racing outward, not a continuous line.
    //
    // Multipliers on u_time (3.00, 2.50, 4.50) are 2-decimal →
    // TIME_WRAP-safe.
    // axN measures distance OUTWARD FROM THE POLE (not from the
    // body center) so the bulk flow and helical knots originate
    // at the projected pole position. Without the poleStart shift,
    // the wave phases were anchored at origin and the outflow
    // appeared to start inside the body instead of at the pole.
    float axN = max(0.0, (ax - poleStart) / max(v_baseR, 0.001));
    float acrossN = (halfW > 0.0) ? across / halfW : 0.0;

    float flowPhase = axN * 4.5 - u_time * 3.00 + acrossN * 1.6 + v_seed;
    float beamFlow = 0.92 + 0.08 * sin(flowPhase);

    float helixAng  = axN * 2.5 - u_time * 2.50 + v_seed * 1.7;
    float helixSide = cos(helixAng);
    float helixDist = acrossN - helixSide * 0.55;
    float knotEnv = exp(-helixDist * helixDist * 5.0);
    float knotPulse = pow(max(0.0, sin(
      axN * 6.0 - u_time * 4.50 + v_seed
    )), 3.0);
    float beamKnot = knotEnv * knotPulse;

    float beamBase = widthFalloff * lengthFalloff * b2L;
    float beamI = beamBase * beamFlow;
    // Knots get a warmer cast than the cooler bulk flow so hot
    // plasma packets read as discrete from the cooler stream.
    float knotI = beamBase * beamKnot * 0.30;

    // Halo glow — small permanent halo, blooms with flash. Halo
    // radius capped tightly so the bloom doesn't extend over
    // neighbouring stars during a peak flash.
    float haloR = v_baseR * (1.0 + 1.2 * flash);
    float hr = d / max(haloR, 0.001);
    float haloI = exp(-hr * hr) * (0.18 + 0.85 * flash);

    // ── Lens-flare composite. Each element below is gated by
    // the flash term, so they erupt only during beam-camera
    // alignment and stay invisible the rest of the time.

    // 6-pointed diffraction spikes — abs(cos(3·θ))^P gives 6 razor-
    // thin peaks per revolution; the pattern rotates slowly with
    // the spin so the spikes don't feel painted onto a flat star.
    float spikeAng = atan(loc.y, loc.x);
    float spikeRot = u_time * 0.10 + v_seed;
    float spikePat = pow(abs(cos(3.0 * (spikeAng - spikeRot))), 80.0);
    float ld = d / max(v_baseR, 0.001);
    // Tighter decay (0.95 vs old 0.45) keeps spikes from radiating
    // out far enough to overlap adjacent stars in the scene.
    float spikeLen = exp(-ld * 0.95)
                   * smoothstep(coreR * 0.5, coreR * 1.5, d);
    float spikeI = spikePat * spikeLen * flash * 1.6;

    // Anamorphic streak — tight Gaussian across, very extended
    // along, oriented per-pulsar so different pulsars streak in
    // different directions. The classic cinema-lens artifact.
    float streakAngP = v_seed * 0.5;
    vec2 sd = vec2(cos(streakAngP), sin(streakAngP));
    vec2 sn = vec2(-sd.y, sd.x);
    float salong = dot(loc, sd);
    float sacross = dot(loc, sn);
    float r2 = v_baseR * v_baseR;
    float streakAcross = exp(-sacross * sacross / max(r2 * 0.015, 1e-4));
    // Half-length divisor lowered from 18 to 3 so the streak fades
    // well within the pulsar's quad and doesn't streak across
    // neighbouring stars during a flash.
    float streakAlong  = exp(-salong  * salong  / max(r2 *  3.0,  1e-4));
    float streakI = streakAcross * streakAlong * flash * 0.95;

    // Iris ring — concentric thin ring at moderate radius, fading
    // with flash. Reads as a lens element catching the bright
    // source — gives the flare optical depth without filling the
    // frame with halo bloom.
    float irisR = v_baseR * 2.4;
    float irisGap = v_baseR * 0.18;
    float irisI = (1.0 - smoothstep(0.0, irisGap, abs(d - irisR)))
                * flash * 0.40;

    // Soft crescent on the iris ring — a slowly drifting circular
    // occluder grazes the iris radius, fading the ring gently
    // along an arc instead of completing it. Position rotates
    // around the source and the occluder geometry oscillates so
    // the crescent shape changes over time. Soft transition (no
    // hard edge) and attenuation to 25 % (not zero) so the dim
    // side stays subtly visible rather than being fully cut out.
    // Multipliers 0.07 and 0.04 are 2-decimal → TIME_WRAP-safe.
    float cutAng  = u_time * 0.07 + v_seed * 1.3;
    float cutSize = u_time * 0.04 + v_seed * 2.7;
    float cutDist = v_baseR * (2.55 + 0.65 * sin(cutSize));
    vec2  cutCenter = vec2(cos(cutAng), sin(cutAng)) * cutDist;
    float cutR    = v_baseR * (2.40 + 0.35 * cos(cutSize));
    float cutD    = length(loc - cutCenter);
    float softBand = v_baseR * 0.6;
    float crescentT = smoothstep(cutR - softBand, cutR + softBand, cutD);
    irisI *= 0.25 + 0.75 * crescentT;

    // Per-pulsar palette tint. v_c1 is the star's "hot" palette
    // color and is used directly as the dominant pulsar hue —
    // mixing toward white was too dilute to read. Beam/halo/streak
    // become saturated tint colors (these define the pulsar's
    // identity); core gets a heavy tint with a white-hot center
    // emerging only at peak flash. Knots and spikes stay near
    // neutral hot-white so they read as distinct hot plasma /
    // achromatic diffraction layers regardless of base color.
    vec3 tint = v_c1;
    // Core base: strong tint at rest, brightens to near-white at
    // peak flash so saturated alignment still pops. The flash mix
    // toward white preserves the chromatic fringe term below.
    vec3 coreColorBase = mix(tint, vec3(1.00, 1.00, 1.00),
                             0.25 + 0.55 * flash);
    vec3 fringe = vec3(0.10, 0.0, -0.08) * flash;
    vec3 coreColor = coreColorBase + fringe;

    // Beam, streak, iris: pure tint (no white floor). Halo uses
    // beamColor so it inherits the saturation automatically.
    vec3 beamColor   = tint;
    vec3 streakColor = tint;
    vec3 irisColor   = tint;
    // Knots and spikes — keep warm hot-white, only a faint tint so
    // they still read as a distinct optical layer over the colored
    // beam.
    vec3 knotColor   = mix(vec3(1.00, 0.92, 0.78), tint, 0.20);
    vec3 spikeColor  = mix(vec3(1.00, 0.96, 0.86), tint, 0.15);

    // Core boost ramps higher (8× at peak) so the alignment really
    // pops; previous 6× looked muted next to the new flare layers.
    // The knot layer overpaints the bulk-flow beam with a warmer
    // tint where plasma packets crest, giving the outflow a hot/
    // cool layered look instead of a single uniform color.
    vec3 col = coreColor * coreI * (1.0 + 8.0 * flash)
             + beamColor   * beamI
             + knotColor   * knotI
             + beamColor   * haloI
             + spikeColor  * spikeI
             + streakColor * streakI
             + irisColor   * irisI;
    float a = clamp(
      coreI + beamI + haloI + spikeI + streakI + irisI, 0.0, 1.0
    );

    // Circular edge fade — keeps the lens flare from showing the
    // rectangular quad boundary at peak flash. The visible flare
    // lives inside the disc inscribed in the pulsar quad; anything
    // beyond fades smoothly to fully transparent. Must mirror the
    // vertex shader's pulsar extentMul (5.0).
    float pulsarExtent = v_baseR * 5.0 + 8.0;
    float edgeFade = 1.0 - smoothstep(
      pulsarExtent * 0.80, pulsarExtent * 1.00, d
    );
    col *= edgeFade;
    a   *= edgeFade;

    outColor = vec4(col, a);
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
      loc.x * ca - loc.y * sa,
      loc.x * sa + loc.y * ca
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
  // Per-session seed for procedural background (galaxy positions,
  // star tilts, etc). Random per page load so the background
  // isn't identical every refresh.
  const sessionSeed = Math.random() * 1000;
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
  // Nebula uses the same source compiled with `NEBULA_ONLY` defined.
  // The preprocessor strips the noise helpers and the `if (isNebula)`
  // branch out of the common build, dropping its register footprint
  // to ~ringworld-with-plates level (was set by nebula). The nebula
  // build keeps everything; its register count was already nebula-
  // dominated so the dead other-variant branches don't add cost.
  const nebulaFs = STAR_FS.replace(
    "#version 300 es",
    "#version 300 es\n#define NEBULA_ONLY 1"
  );
  const nebulaProg     = compileProgram(gl, STAR_VS, nebulaFs, "nebula");
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
  // Instance stride is 16 floats (64 bytes):
  //   vec2 center, vec4 c1, vec4 c2, vec4 params, vec2 wobble
  const starInstanceBuf = gl.createBuffer();
  const STAR_FLOATS_PER_INSTANCE = 16;
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
  gl.enableVertexAttribArray(starProg.attribs.a_wobble);
  gl.vertexAttribPointer(starProg.attribs.a_wobble, 2, gl.FLOAT, false, sStride, 56);
  gl.vertexAttribDivisor(starProg.attribs.a_wobble, 1);
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
  // Separate scratch for the nebula sub-batch — same layout as
  // starScratch, populated alongside it during partitioning.
  let nebulaScratch = new Float32Array(8 * STAR_FLOATS_PER_INSTANCE);
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
  function ensureNebulaScratch(n) {
    const needed = n * STAR_FLOATS_PER_INSTANCE;
    if (nebulaScratch.length < needed) {
      let len = nebulaScratch.length;
      while (len < needed) len *= 2;
      nebulaScratch = new Float32Array(len);
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
    // Populated across a fixed 2400×1600 canonical space (~2× a
    // typical laptop viewport). The power-law magnitude
    // distribution puts ~65 % in the faint dust band, so the
    // count drives perceived dust density without changing the
    // hero/mid-mag balance.
    const n = 700;
    ensureCircleScratch(n);
    // Seeded PRNG (mulberry32). Produces the same sequence per
    // session so bg stars stay in the same spots across resizes.
    // Different sessions get different layouts via sessionSeed.
    let rngState = (sessionSeed * 1e6 + 1) >>> 0;
    function rand() {
      rngState = (rngState + 0x6D2B79F5) >>> 0;
      let t = rngState;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    // Continuous-temperature endpoints. Cool ≈ Vega (B/A/F class);
    // warm ≈ G/K class. Neutral white sits at the midpoint.
    const COOL_R = 0.74, COOL_G = 0.83, COOL_B = 1.00;
    const WARM_R = 1.00, WARM_G = 0.88, WARM_B = 0.72;
    // Distribute positions in a canonical fixed space so they
    // stay anchored across resizes. 2400×1600 is larger than any
    // common viewport; out-of-frame stars are just off-screen.
    const CW = 2400, CH = 1600;
    for (let i = 0; i < n; i++) {
      const base = i * CIRCLE_FLOATS_PER_INSTANCE;
      const x = rand() * CW;
      const y = rand() * CH;
      const depth = 0.05 + rand() * 0.35;
      // Magnitude axis: 0 = brightest, 1 = faintest. The
      // distribution flows from this single sample so brightness,
      // size, colour saturation and twinkle stay coherent.
      const mag = rand();
      const oneMinusMag = 1.0 - mag;
      // Power-law brightness — many faint stars, few bright ones.
      // Replaces the flat U[0.4, 0.8] that gave every star equal
      // weight; now the eye gets a real apparent-magnitude
      // hierarchy with hero stars that pop and dust that recedes.
      const brightness = 0.06 + 0.55 * Math.pow(oneMinusMag, 3.0);
      // Disc size correlates with magnitude — bright stars look
      // larger because of their bloom envelope. Faint stars are
      // sub-pixel points.
      const discR = 0.5 + Math.pow(oneMinusMag, 2.0) * 2.5;
      // Continuous temperature axis. Faint stars (mag near 1)
      // squash to neutral white because the bias term is scaled
      // by sqrt(1 - mag); bright stars (mag near 0) span the full
      // cool-to-warm range. tempRoll controls direction.
      const tempRoll = rand();
      const t = 0.5 + (tempRoll - 0.5) * 0.6 * Math.sqrt(oneMinusMag);
      const r1 = COOL_R + (WARM_R - COOL_R) * t;
      const g1 = COOL_G + (WARM_G - COOL_G) * t;
      const b1 = COOL_B + (WARM_B - COOL_B) * t;
      // Twinkle: faint stars dance more in the eye's noise floor,
      // bright stars hold steadier. Phase still random so they
      // don't all dim together.
      const twinkleSpeed = (1.4 + rand() * 2.5) * (0.3 + mag * 1.2);
      const twinklePhase = rand() * Math.PI * 2;
      // Top ~12 % of stars (brightest) become "hero" stars rendered
      // with kind == 4 — solid disc plus a faint diffraction cross.
      // outerR carries the spike-bound (quad size); innerR carries
      // the disc radius itself. Other kinds keep innerR = 0.
      const isHero = mag < 0.02;
      const outerR = isHero ? discR * 3.5 : discR;
      const innerR = isHero ? discR : 0;
      const kind   = isHero ? 4 : 0;
      // Premultiplied rgba.
      const a = brightness;
      circleScratch[base + 0] = x;
      circleScratch[base + 1] = y;
      circleScratch[base + 2] = outerR;
      circleScratch[base + 3] = innerR;
      circleScratch[base + 4] = r1 * a;
      circleScratch[base + 5] = g1 * a;
      circleScratch[base + 6] = b1 * a;
      circleScratch[base + 7] = a;
      circleScratch[base + 8] = depth;
      circleScratch[base + 9] = twinkleSpeed;
      circleScratch[base + 10] = twinklePhase;
      circleScratch[base + 11] = kind;
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
  // Pooled scratch for finalizeFrame's BH uniform data.
  const _bhScratch = new Float32Array(16);

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

  function cameraMat(camY, zoom, focusY, camX) {
    // Matches Canvas2D's transform chain:
    //   translate(W/2, H*focusY) * scale(zoom) * translate(-W/2, -H*focusY) * translate(camX, camY)
    // applied to a world point — screen = T4 * S * T3 * T2 * world.
    // `focusY` is the fraction of screen height where the current
    // star sits. 0.55 is the default (slightly below center);
    // portrait/mobile passes a larger value (e.g. 0.62) so the
    // star sits lower, leaving more sky visible above.
    // `camX` is an optional world-space horizontal pan (defaults
    // to 0), used to keep oversized stars (ringworlds at 1.7×
    // zoom) from extending beyond the viewport horizontally.
    // Composed left-associatively into the pooled scratch so the
    // whole chain runs without a single heap allocation.
    if (focusY === undefined) focusY = 0.55;
    if (camX === undefined) camX = 0;
    mat3SetTranslate(_camT2, camX, camY);
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
      for (let i = 0; i < n; i++) {
        _bhScratch[i * 4 + 0] = blackHoles[i].fbX;
        _bhScratch[i * 4 + 1] = blackHoles[i].fbY;
        _bhScratch[i * 4 + 2] = blackHoles[i].fbR;
        _bhScratch[i * 4 + 3] = 0;
      }
      gl.uniform4fv(lensingProg.uniforms["u_bh[0]"], _bhScratch);
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
    gl.uniform1f(fullscreenProg.uniforms.u_camY, camY);
    gl.uniform1f(fullscreenProg.uniforms.u_seed, sessionSeed);
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
    ensureNebulaScratch(n);
    // Partition: nebula instances go to the dedicated nebula
    // program (which keeps the heavy noise helpers + nebula path);
    // everything else goes to the common program (which drops them
    // for lower register pressure → better SIMT occupancy on
    // mobile). Past nebulas route through the common program — the
    // isPast early-out renders all variants as the same dim ember.
    let nCommon = 0;
    let nNebula = 0;
    for (let i = 0; i < n; i++) {
      const s = stars[i];
      const useNebula = s.isNebula && !s.isPast;
      const dst = useNebula ? nebulaScratch : starScratch;
      const base = (useNebula ? nNebula : nCommon) * STAR_FLOATS_PER_INSTANCE;
      const c1 = c1Of(s.colorIdx);
      const c2 = c2Of(s.colorIdx);
      // Same position-derived phase as drawStar used in Canvas2D,
      // so every star stays out of sync with its neighbours.
      const seed = s.seed != null ? s.seed
        : (Math.sin(s.x * 0.0137 + s.y * 0.0191) * 0.5 + 0.5) * Math.PI * 2;
      let flags = 0;
      if (s.isCurrent)  flags |= 1;
      if (s.isNext)     flags |= 2;
      if (s.isPast)     flags |= 4;
      if (s.isBlackHole) flags |= 8;
      if (s.isMonolith) flags |= 16;
      if (s.isPulsar) flags |= 32;
      if (s.isRingworld) flags |= 64;
      if (s.isNebula) flags |= 2048;
      if (s.isTeapot) flags |= 4096;
      if (s.isAzazel) flags |= 8192;
      // Ring plate count packed in flag bits 8-10 (0-7). 0 means
      // the ringworld has no shadow plates — shader skips all
      // plate/shadow/city-light work in that case.
      if (s.isRingworld) {
        const pc = Math.max(0, Math.min(7, s.ringPlateCount | 0));
        flags |= pc << 8;
      }
      dst[base + 0] = s.x;
      dst[base + 1] = s.y;
      dst[base + 2] = c1[0];
      dst[base + 3] = c1[1];
      dst[base + 4] = c1[2];
      dst[base + 5] = s.r;
      dst[base + 6] = c2[0];
      dst[base + 7] = c2[1];
      dst[base + 8] = c2[2];
      dst[base + 9] = seed;
      dst[base + 10] = s.hasRays ? 1 : 0;
      dst[base + 11] = s.nGran;
      dst[base + 12] = s.pulse || 0;
      dst[base + 13] = flags;
      dst[base + 14] = s.wobble || 0;
      dst[base + 15] = s.wobbleAngle || 0;
      if (useNebula) nNebula++;
      else nCommon++;
    }
    // Both draws share the same VAO + instance buffer. bufferData
    // overwrites between draws; the second draw's upload doesn't
    // affect the already-issued first draw.
    gl.bindVertexArray(starVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, starInstanceBuf);
    if (nCommon > 0) {
      gl.useProgram(starProg.program);
      gl.uniformMatrix3fv(starProg.uniforms.u_view, true, viewMat);
      gl.uniform1f(starProg.uniforms.u_time, frameTime);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        starScratch.subarray(0, nCommon * STAR_FLOATS_PER_INSTANCE),
        gl.STREAM_DRAW
      );
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nCommon);
    }
    if (nNebula > 0) {
      gl.useProgram(nebulaProg.program);
      gl.uniformMatrix3fv(nebulaProg.uniforms.u_view, true, viewMat);
      gl.uniform1f(nebulaProg.uniforms.u_time, frameTime);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        nebulaScratch.subarray(0, nNebula * STAR_FLOATS_PER_INSTANCE),
        gl.STREAM_DRAW
      );
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nNebula);
    }
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
