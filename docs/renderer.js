// WebGL2 renderer for ASTROCATCH. Owns the GL context, shader programs,
// dynamic vertex buffers, and the draw API consumed by gameplay.js.
// Browser-only — the node physics test runner never imports this file.
//
// Four shader programs cover the full render surface:
//
//   fullscreen  background radial gradient + scrolling grid. One draw.
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
uniform float u_camY;
out vec4 outColor;

void main() {
  // Convert physical fragment coords to logical, top-down.
  vec2 frag = gl_FragCoord.xy / u_dpr;
  frag.y = u_resolution.y - frag.y;

  // Background radial gradient: #12121f center → #0a0a12 corners.
  vec2 c = u_resolution * 0.5;
  float dist = length(frag - c);
  float maxD = max(u_resolution.x, u_resolution.y);
  vec3 col = mix(
    vec3(0.071, 0.071, 0.121),
    vec3(0.039, 0.039, 0.071),
    clamp(dist / maxD, 0.0, 1.0)
  );

  // Faint grid every 40 px, scrolling with camY at 1:1.
  vec2 gf = frag + vec2(0.0, mod(u_camY, 40.0));
  float gx = step(mod(gf.x, 40.0), 1.0);
  float gy = step(mod(gf.y, 40.0), 1.0);
  col += vec3(max(gx, gy) * 0.02);

  outColor = vec4(col, 1.0);
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
out float v_kind;

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
in float v_kind;
out vec4 outColor;

const float PI = 3.14159265;

void main() {
  float d = length(v_local);
  float outerR = v_radii.x;
  float innerR = v_radii.y;
  int kind = int(v_kind + 0.5);
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
out float v_hasRays;
out float v_nGran;
out float v_pulse;
out float v_flags;

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
in float v_hasRays;
in float v_nGran;
in float v_pulse;
in float v_flags;

uniform float u_time;

out vec4 outColor;

const float PI = 3.14159265;
const float TAU = 6.28318530;

void main() {
  float d = length(v_local);
  float theta = atan(v_local.y, v_local.x);
  float tp = u_time + v_seed;

  int flags = int(v_flags + 0.5);
  bool isCurrent = (flags & 1) != 0;
  bool isNext    = (flags & 2) != 0;
  bool isPast    = (flags & 4) != 0;

  if (isPast) {
    // Dim ember: small inner glow + a white pinpoint at the core.
    float auraR = v_baseR * 0.9;
    float aura = (1.0 - smoothstep(0.0, auraR, d)) * 0.22;
    float ember = (1.0 - smoothstep(0.0, 2.5, d)) * 0.45;
    float a = clamp(aura + ember, 0.0, 1.0);
    outColor = vec4(vec3(a), a);
    return;
  }

  // Pulse / flare / catch-shockwave scaling matches drawStar exactly.
  float pulse = 1.0 + 0.04 * sin(tp * 1.6);
  float flare = 0.8 + 0.2 * sin(tp * 3.2);
  float catchBoost = 1.0 + v_pulse * 0.45;
  float bodyR = v_baseR * pulse * catchBoost;

  // Premultiplied accumulator. We composite layers back-to-front.
  vec4 color = vec4(0.0);

  // ── Layer 1: Corona (3-stop falloff matching the Canvas2D gradient)
  float coronaR = bodyR * 4.0;
  if (d < coronaR) {
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

  // ── Layer 2: Coronal streamers (only if this star has rays).
  // One streamer per granule, rooted in the granule's radial
  // direction, tapering from base to tip. Reproduces the Canvas2D
  // per-granule linear gradient streamers procedurally.
  if (v_hasRays > 0.5) {
    float streamerAccum = 0.0;
    int nGran = int(v_nGran + 0.5);
    for (int i = 0; i < 8; i++) {
      if (i >= nGran) break;
      float fi = float(i);
      float ga = tp * 0.35 + fi * (TAU / v_nGran) + 0.7 * sin(tp + fi);
      float gr = bodyR * (0.2 + 0.45 * (0.5 + 0.5 * sin(tp * 0.9 + fi * 2.1)));
      float gsize = bodyR * (0.28 + 0.1 * sin(tp * 1.5 + fi));

      float energy = min(1.0, gr / (bodyR * 0.65));
      float flick = 0.55 + 0.45 * sin(tp * 2.0 + fi * 1.13);
      float tipDist = bodyR * (0.5 + 1.0 * energy + 0.4 * flick);
      float baseAlong = bodyR * 0.92;
      float tipAlong = bodyR + tipDist;
      if (tipAlong <= baseAlong) continue;

      float cosA = cos(ga);
      float sinA = sin(ga);
      float along = v_local.x * cosA + v_local.y * sinA;
      float perp = -v_local.x * sinA + v_local.y * cosA;

      if (along < baseAlong || along > tipAlong) continue;
      float segT = (along - baseAlong) / (tipAlong - baseAlong);
      float halfW = gsize * 0.55 * (1.0 - segT * 0.85);
      if (halfW < 0.001) continue;
      float lateral = 1.0 - smoothstep(halfW * 0.5, halfW, abs(perp));
      float baseAlpha = (95.0 / 255.0) * flick * (0.5 + 0.5 * energy);
      streamerAccum += baseAlpha * (1.0 - segT) * lateral;
    }
    streamerAccum = clamp(streamerAccum, 0.0, 1.0);
    vec4 streamer = vec4(v_c1 * streamerAccum, streamerAccum);
    // Composite streamers OVER the corona.
    color.rgb = streamer.rgb + color.rgb * (1.0 - streamer.a);
    color.a = streamer.a + color.a * (1.0 - streamer.a);
  }

  // ── Layer 3: Outer glow.
  float glowR = bodyR * 1.9;
  if (d < glowR) {
    float t = clamp((d - bodyR * 0.75) / max(glowR - bodyR * 0.75, 0.001), 0.0, 1.0);
    float glowBase = isCurrent ? (175.0 / 255.0) : (isNext ? (140.0 / 255.0) : (110.0 / 255.0));
    float glowA = glowBase * flare * (1.0 - t);
    if (d < bodyR * 0.75) glowA = glowBase * flare;
    glowA = clamp(glowA, 0.0, 1.0);
    vec4 glow = vec4(v_c1 * glowA, glowA);
    color.rgb = glow.rgb + color.rgb * (1.0 - glow.a);
    color.a = glow.a + color.a * (1.0 - glow.a);
  }

  // ── Layer 4: Photosphere disk with limb darkening.
  if (d < bodyR) {
    vec2 offset = vec2(-bodyR * 0.12, -bodyR * 0.12);
    float od = length(v_local - offset);
    float t = clamp(od / bodyR, 0.0, 1.0);
    vec3 diskColor;
    if (t < 0.28) diskColor = mix(vec3(1.0), v_c1, t / 0.28);
    else if (t < 0.78) diskColor = v_c1;
    else diskColor = mix(v_c1, v_c2, (t - 0.78) / 0.22);

    // Disk is opaque; overwrite the accumulator.
    color = vec4(diskColor, 1.0);
  }

  // ── Layer 5: Granulation. Animated blobs inside the disk.
  if (d < bodyR * 0.985) {
    vec3 granSum = vec3(0.0);
    int nGran = int(v_nGran + 0.5);
    for (int i = 0; i < 8; i++) {
      if (i >= nGran) break;
      float fi = float(i);
      float ga = tp * 0.35 + fi * (TAU / v_nGran) + 0.7 * sin(tp + fi);
      float gr = bodyR * (0.2 + 0.45 * (0.5 + 0.5 * sin(tp * 0.9 + fi * 2.1)));
      float gsize = bodyR * (0.28 + 0.1 * sin(tp * 1.5 + fi));
      vec2 gpos = vec2(cos(ga), sin(ga)) * gr;
      float gd = distance(v_local, gpos);
      float gAlpha = (1.0 - smoothstep(0.0, max(gsize, 0.001), gd)) * 0.32;
      granSum += vec3(gAlpha);
    }
    color.rgb = clamp(color.rgb + granSum, 0.0, 1.0);
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
  const gl = canvas.getContext("webgl2", {
    antialias: true,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    alpha: false,
    depth: false,
    stencil: false,
  });
  if (!gl) return null;

  // Enable standard derivatives (fwidth) — core in WebGL2, but
  // fragment shader still needs the extension declaration in some
  // drivers. In WebGL2 this is implicit, so no extension call here.

  const fullscreenProg = compileProgram(gl, FULLSCREEN_VS, FULLSCREEN_FS, "fullscreen");
  const circleProg     = compileProgram(gl, CIRCLE_VS, CIRCLE_FS, "circle");
  const starProg       = compileProgram(gl, STAR_VS, STAR_FS, "star");
  const polylineProg   = compileProgram(gl, POLYLINE_VS, POLYLINE_FS, "polyline");

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
      const brightness = 0.55 + Math.random() * 0.45;
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
  }

  function cameraMat(camY, zoom) {
    // Matches Canvas2D's transform chain:
    //   translate(W/2, H*0.55) * scale(zoom) * translate(-W/2, -H*0.55) * translate(0, camY)
    // applied to a world point — screen = T4 * S * T3 * T2 * world.
    const T2 = mat3Translate(0, camY);
    const T3 = mat3Translate(-viewW / 2, -viewH * 0.55);
    const S  = mat3Scale(zoom, zoom);
    const T4 = mat3Translate(viewW / 2, viewH * 0.55);
    const world2screen = mat3Multiply(T4, mat3Multiply(S, mat3Multiply(T3, T2)));
    return mat3Multiply(screenMat, world2screen);
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

  function beginFrame(timeSec) {
    frameTime = timeSec;
    gl.clearColor(0.039, 0.039, 0.071, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
  }

  function drawBackground(camY) {
    frameCamY = camY;
    gl.useProgram(fullscreenProg.program);
    gl.uniform2f(fullscreenProg.uniforms.u_resolution, viewW, viewH);
    gl.uniform1f(fullscreenProg.uniforms.u_dpr, viewDPR);
    gl.uniform1f(fullscreenProg.uniforms.u_camY, camY);
    gl.bindVertexArray(null);
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
    gl.uniform1f(circleProg.uniforms.u_camY, 0);
    gl.uniform2f(circleProg.uniforms.u_resolution, viewW, viewH);
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
      if (s.isCurrent) flags |= 1;
      if (s.isNext)    flags |= 2;
      if (s.isPast)    flags |= 4;
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
    cameraMat,
    replayMat,
    screenMat: () => screenMat,
    c1Of,
    c2Of,
  };
}
