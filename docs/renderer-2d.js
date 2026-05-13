// renderer-2d.js — Tier-3 Vector-style Canvas2D rendition. Same interface as renderer.js
// so gameplay.js can load either via ?vector=1. Aesthetic: pure black field, thin bright
// vector lines, CRT phosphor glow via shadowBlur, animated variants. Everything is line
// art — fills only appear when opacity is structurally required (event horizons, monolith
// silhouette). Particles become tiny phosphor crosses, the trail becomes a glowing
// polyline, and each variant gets a recognisable vector signature plus a per-frame
// rotation or pulse.
//
// Coordinate convention matches gameplay.js: mat = [a, c, e, b, d, f] (X-row first), where
// screen = mat × world. applyMat folds in DPR to land on the canvas's physical-pixel grid.
//
// Composite mode is `lighter` for additive phosphor blending; variants that need an opaque
// dark shape (black-hole event horizon, monolith body, azazel rift) switch to source-over
// for that one shape and switch back before returning.

import { c1Of, c2Of } from "./renderer.js";

const BG_DENSITY = 5200;            // 1 background cross per N pixels of viewport area
// shadowBlur cost scales with the blur kernel (≈ linearly for GPU, quadratically for
// software fallback on older mobile). Cutting these radii roughly in half drops the cost
// per blurred stroke by ~40–60 % with negligible visual impact at this stroke width.
const GLOW_BLUR_STAR = 6;           // shadowBlur for star outlines
const GLOW_BLUR_TRAIL = 3;          // shadowBlur for trail / polylines
const GLOW_BLUR_PARTICLE = 3;       // shadowBlur for particles / shockwaves
const PHOSPHOR_WHITE = "240,248,255";
// Phosphor afterglow. Each frame paints a semi-transparent black rectangle over the
// previous frame instead of an opaque clear, so its contents attenuate exponentially
// across subsequent frames. After N frames the original brightness is (1 − PHOSPHOR_FADE)^N
// — at 0.22 that's ~13 % at 8 frames, ~3 % at 15 frames. Reads as soft trails behind the
// ship, fading capture bursts, score-digit ghosting on capture, etc., without any per-
// line render-mode complexity.
const PHOSPHOR_FADE = 0.22;

export function createRenderer2D(canvas) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  let viewW = 0, viewH = 0, viewDPR = 1;
  const screenMatVal = new Float32Array([1, 0, 0, 0, 1, 0]);
  // Time stored from beginFrame; drives all per-frame rotations / pulses.
  let nowSec = 0;

  // Background cross-stars (Vector parallax). Seeded so they're stable across reloads.
  let bgCrosses = null;
  function initBgCrosses() {
    let s = 0x9E3779B1 >>> 0;
    const rng = () => {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const count = Math.max(30, Math.floor((viewW * viewH) / BG_DENSITY));
    bgCrosses = new Array(count);
    for (let i = 0; i < count; i++) {
      bgCrosses[i] = {
        x: rng() * viewW,
        y: rng() * viewH,
        size: 1.2 + rng() * 2.4,
        a: 0.20 + rng() * 0.40,
        twinkle: rng() * Math.PI * 2,  // phase offset for subtle brightness sway
      };
    }
  }

  function setViewport(W, H, DPR) {
    const dprChanged = viewDPR !== DPR;
    viewW = W; viewH = H; viewDPR = DPR;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    initBgCrosses();
    // Text bake canvases are sized at DPR resolution; a DPR change makes them stale.
    // Clearing is cheap (just drops refs — GC reclaims) and re-bakes on next draw. The
    // canvas pool is also dropped because pooled canvases were sized at the old DPR
    // and would mismatch new bakes' dimensions; better to start fresh than carry
    // mis-sized buckets that will never be hit.
    if (dprChanged) {
      if (_textCache) _textCache.clear();
      if (_canvasPool) _canvasPool.clear();
    }
  }

  function beginFrame(nowSecArg, _hasVisibleBH) {
    nowSec = nowSecArg || 0;
    _frameBakeBudget = FRAME_BAKE_BUDGET;
    _flushDots(); // belt-and-braces: any dots left from a previous (interrupted) frame.
    ctx.setTransform(viewDPR, 0, 0, viewDPR, 0, 0);
    setCop("source-over");
    ctx.globalAlpha = 1;
    setSB(0);
    // Phosphor afterglow: semi-transparent black instead of opaque clear lets the
    // previous frame decay rather than vanish. PHOSPHOR_FADE controls the per-frame
    // attenuation; lower = longer trails, higher = sharper.
    setFS("rgba(0,0,0," + PHOSPHOR_FADE + ")");
    ctx.fillRect(0, 0, viewW, viewH);
  }

  function drawBackground(_camY) {
    // Vector screens were pure black — no gradient. Already filled by beginFrame.
  }

  function drawBgStars() {
    if (!bgCrosses) return;
    _flushDots();
    ctx.setTransform(viewDPR, 0, 0, viewDPR, 0, 0);
    setCop("lighter");
    // Bg-stars used to set shadowBlur = 3 → one GPU blur pass per parallax star per
    // frame (50+ passes) for a barely-visible halo. Drop the blur; the additive blend +
    // brightness sway already reads as subtle phosphor sparkle without the cost.
    setSB(0);
    // BG stars are perfectly fixed and redrawn every frame, so under additive composite
    // + afterglow their pixels would accumulate to saturation. Per-stroke effective alpha
    // (strokeStyle × c.a × tw) must stay well below PHOSPHOR_FADE so the steady-state
    // (paint / FADE) stays around 0.4–0.5 instead of clamping at 1.0. Strokestyle dropped
    // from 0.7 to 0.18; effective max becomes 0.18 × 0.6 × 1 ≈ 0.108, comfortably below
    // the 0.22 fade.
    setSS("rgba(160,200,230,0.18)");
    ctx.lineWidth = 0.8;
    ctx.lineCap = "round";
    for (let i = 0; i < bgCrosses.length; i++) {
      const c = bgCrosses[i];
      const tw = 0.7 + 0.3 * Math.sin(nowSec * 1.8 + c.twinkle);
      ctx.globalAlpha = c.a * tw;
      const h = c.size;
      ctx.beginPath();
      ctx.moveTo(c.x - h, c.y); ctx.lineTo(c.x + h, c.y);
      ctx.moveTo(c.x, c.y - h); ctx.lineTo(c.x, c.y + h);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    setCop("source-over");
  }

  function applyMat(mat) {
    // Pending dots are in the *previous* transform's coordinate space; flush before
    // moving the matrix, otherwise their arc() calls would render at the wrong place.
    _flushDots();
    ctx.setTransform(
      mat[0] * viewDPR, mat[3] * viewDPR,
      mat[1] * viewDPR, mat[4] * viewDPR,
      mat[2] * viewDPR, mat[5] * viewDPR,
    );
  }

  // Canvas2D color / shadow / composite writes parse a string and update an internal
  // colour object every time, even when the new value is the same as the old. With
  // hundreds of writes per frame (per-particle stroke, per-glyph corner dot, per-segment
  // tick), the duplicate cost adds up. This thin cache layer compares the previous JS-
  // side value and skips the actual ctx write when it matches.
  let _ssCache = "";
  let _fsCache = "";
  let _scCache = "";
  let _sbCache = -1;
  let _copCache = "";

  // Vertex-dot batching. _strokeScratchPoly collects per-vertex dots into this
  // bucket instead of emitting a fill call per polygon — adjacent same-color same-
  // alpha polygons share one fill, so a frame with N polygons in M colors costs M
  // fill calls instead of N. Flushed before any transform / composite change and at
  // frame end (any state the dots depend on can shift before they get rendered, so
  // we settle them before any such shift). Flat triplets to avoid per-dot object GC.
  const _pendingDots = [];
  let _pendingDotsFS = "";
  let _pendingDotsAlpha = -1;
  function _flushDots() {
    const n = _pendingDots.length;
    if (n === 0) return;
    const prevFS = _fsCache;
    const prevAlpha = ctx.globalAlpha;
    setFS(_pendingDotsFS);
    ctx.globalAlpha = _pendingDotsAlpha;
    ctx.beginPath();
    for (let i = 0; i < n; i += 3) {
      const x = _pendingDots[i];
      const y = _pendingDots[i + 1];
      const r = _pendingDots[i + 2];
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.fill();
    _pendingDots.length = 0;
    setFS(prevFS);
    ctx.globalAlpha = prevAlpha;
  }
  function setSS(s) {
    if (_ssCache !== s) { ctx.strokeStyle = s; _ssCache = s; }
  }
  function setFS(s) {
    if (_fsCache !== s) { ctx.fillStyle = s; _fsCache = s; }
  }
  function setSC(s) {
    if (_scCache !== s) { ctx.shadowColor = s; _scCache = s; }
  }
  function setSB(n) {
    if (_sbCache !== n) { ctx.shadowBlur = n; _sbCache = n; }
  }
  function setCop(s) {
    if (_copCache !== s) {
      // Pending dots must be drawn under the composite mode they were collected in
      // (always "lighter" in current callers) before we switch — otherwise corner
      // brightening would composite as plain source-over and disappear.
      _flushDots();
      ctx.globalCompositeOperation = s; _copCache = s;
    }
  }

  function rgbStr(c1, mul) {
    const r = Math.max(0, Math.min(255, Math.round(c1[0] * 255 * mul)));
    const g = Math.max(0, Math.min(255, Math.round(c1[1] * 255 * mul)));
    const b = Math.max(0, Math.min(255, Math.round(c1[2] * 255 * mul)));
    return r + "," + g + "," + b;
  }

  // ─── Polygon helpers + Vector corner-dots. The Vector CPU drove the beam through
  // straight segments only — arcs and circles were always polygon approximations on real
  // hardware (usually 6–16 vertices). And because the beam decelerated, stopped, and
  // re-accelerated at every joint, the phosphor got a measurably brighter dot at each
  // corner: the signature "double-strength corner" of Vector output.
  //
  // Each stroke helper builds vertex coords into a scratch buffer, strokes the polyline,
  // then drops a small bright square at every vertex inheriting the current strokeStyle +
  // shadowBlur. Fills don't get corner dots — they have no visible vertex joints.

  const _scratchVerts = new Float32Array(64); // up to 32 vertices per shape

  function buildCircleVerts(cx, cy, r, n) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      _scratchVerts[i * 2] = cx + Math.cos(a) * r;
      _scratchVerts[i * 2 + 1] = cy + Math.sin(a) * r;
    }
    return n;
  }

  function buildEllipseVerts(cx, cy, rx, ry, rotation, n) {
    const cr = Math.cos(rotation), sr = Math.sin(rotation);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const ex = Math.cos(a) * rx;
      const ey = Math.sin(a) * ry;
      _scratchVerts[i * 2] = cx + cr * ex - sr * ey;
      _scratchVerts[i * 2 + 1] = cy + sr * ex + cr * ey;
    }
    return n;
  }

  function buildArcVerts(cx, cy, r, startAng, endAng, n) {
    const span = endAng - startAng;
    for (let i = 0; i <= n; i++) {
      const a = startAng + (i / n) * span;
      _scratchVerts[i * 2] = cx + Math.cos(a) * r;
      _scratchVerts[i * 2 + 1] = cy + Math.sin(a) * r;
    }
    return n + 1;
  }

  function buildEllipseArcVerts(cx, cy, rx, ry, rotation, startAng, endAng, n) {
    const span = endAng - startAng;
    const cr = Math.cos(rotation), sr = Math.sin(rotation);
    for (let i = 0; i <= n; i++) {
      const a = startAng + (i / n) * span;
      const ex = Math.cos(a) * rx;
      const ey = Math.sin(a) * ry;
      _scratchVerts[i * 2] = cx + cr * ex - sr * ey;
      _scratchVerts[i * 2 + 1] = cy + sr * ex + cr * ey;
    }
    return n + 1;
  }

  // Polygon stroker. Two composite ops per polygon — one continuous stroke for the
  // outline plus one batched fill of small arcs at every vertex. The fill reproduces
  // the corner-brightening that the prior N-stroke per-segment routing produced via
  // antialiased endpoint-cap overlap, but at a fraction of the cost: a 12-gon goes
  // from 12 separate stroke calls to 1 stroke + 1 fill, an 18-gon from 18 to 2.
  // shadowBlur is dropped during the pass — the soft halo bleed would refill the
  // corner regions and erase the dot's contribution.
  //
  // LINE_ALPHA must stay BELOW PHOSPHOR_FADE so steady-state under afterglow
  // (paint / FADE) doesn't clamp to 1.0 for static shapes. With LINE_ALPHA = 0.16 and
  // FADE = 0.22:
  //   • caller_α = 1.0 → mid paint 0.16, mid steady ≈ 0.73; corners get a 2nd 0.16
  //     paint from the dot fill (composite="lighter" sums them) → corner steady ≈ 1.0
  //   • caller_α = 0.7 → mid paint 0.112, mid steady ≈ 0.51, corner steady ≈ 1.0
  // Mid-segment paint stays unsaturated under the afterglow accumulator, so corners
  // (with 2× paint) clamp to a visibly brighter value.
  //
  // Open polylines: dots fire on *interior* vertices only — endpoints already pick
  // up matching paint from the stroke's round line cap, so a dot there would brighten
  // them to 3× and break the look. (Original per-segment routing put the same single
  // round cap at endpoints.)
  const LINE_ALPHA = 0.16;
  function _strokeScratchPoly(count, closed) {
    if (count < 2) return;
    const prevAlpha = ctx.globalAlpha;
    const prevBlur = _sbCache;
    setSB(0);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.globalAlpha = prevAlpha * LINE_ALPHA;
    // Stroke 1: the polygon outline as a single continuous path.
    ctx.beginPath();
    ctx.moveTo(_scratchVerts[0], _scratchVerts[1]);
    for (let i = 1; i < count; i++) {
      ctx.lineTo(_scratchVerts[i * 2], _scratchVerts[i * 2 + 1]);
    }
    if (closed) ctx.closePath();
    ctx.stroke();
    // Stroke 2: push per-vertex dots into the frame-level bucket. They're flushed as
    // a single fill at the next transform/composite boundary (or end of frame), so
    // adjacent same-color polygons share one fill instead of paying one each. Open
    // polylines skip endpoint dots — the stroke's round line cap already paints them
    // at the same alpha, and a dot there would brighten the endpoint to 3×.
    const startIdx = closed ? 0 : 1;
    const endIdx = closed ? count : count - 1;
    if (endIdx > startIdx) {
      const dotR = Math.max(0.7, ctx.lineWidth * 0.6);
      const dotFS = _ssCache;
      const dotAlpha = ctx.globalAlpha; // = prevAlpha * LINE_ALPHA
      if (_pendingDots.length > 0
          && (_pendingDotsFS !== dotFS || _pendingDotsAlpha !== dotAlpha)) {
        _flushDots();
      }
      if (_pendingDots.length === 0) {
        _pendingDotsFS = dotFS;
        _pendingDotsAlpha = dotAlpha;
      }
      for (let i = startIdx; i < endIdx; i++) {
        _pendingDots.push(
          _scratchVerts[i * 2],
          _scratchVerts[i * 2 + 1],
          dotR,
        );
      }
    }
    ctx.globalAlpha = prevAlpha;
    setSB(prevBlur);
  }

  function _fillScratchPoly(count) {
    ctx.beginPath();
    ctx.moveTo(_scratchVerts[0], _scratchVerts[1]);
    for (let i = 2; i < count * 2; i += 2) {
      ctx.lineTo(_scratchVerts[i], _scratchVerts[i + 1]);
    }
    ctx.closePath();
    ctx.fill();
  }

  function strokePolyCircle(cx, cy, r, n) {
    const count = buildCircleVerts(cx, cy, r, n);
    _strokeScratchPoly(count, true);
  }

  function fillPolyCircle(cx, cy, r, n) {
    const count = buildCircleVerts(cx, cy, r, n);
    _fillScratchPoly(count);
  }

  function strokePolyEllipse(cx, cy, rx, ry, rotation, n) {
    const count = buildEllipseVerts(cx, cy, rx, ry, rotation, n);
    _strokeScratchPoly(count, true);
  }

  function strokePolyArc(cx, cy, r, startAng, endAng, n) {
    const count = buildArcVerts(cx, cy, r, startAng, endAng, n);
    _strokeScratchPoly(count, false);
  }

  function strokePolyEllipseArc(cx, cy, rx, ry, rotation, startAng, endAng, n) {
    const count = buildEllipseArcVerts(cx, cy, rx, ry, rotation, startAng, endAng, n);
    _strokeScratchPoly(count, false);
  }

  // ─── Inline vector font (uppercase A-Z, 0-9, basic punctuation). Each glyph is a flat
  // coord array in [0, 1] × [0, 1] unit space; the special sentinel pair [-1, -1] marks a
  // pen-up move (start of a new stroke). All glyphs are uppercase — period Vector titles
  // and HUDs were uppercase-only, and the rendering pipeline upper-cases on the way in.
  // Glyph aspect ratio is GLYPH_ASPECT (0.7 × size) so text reads as proportional.

  const GLYPH_ASPECT = 0.70;
  const GLYPH_LINE_HEIGHT = 1.40;
  const GLYPHS = {
    "A": [0,1, 0.5,0, 1,1, -1,-1, 0.2,0.6, 0.8,0.6],
    "B": [0,0, 0,1, 0.7,1, 1,0.85, 1,0.65, 0.7,0.5, 0,0.5, -1,-1, 0,0, 0.7,0, 1,0.15, 1,0.35, 0.7,0.5],
    "C": [1,0.15, 0.7,0, 0.3,0, 0,0.15, 0,0.85, 0.3,1, 0.7,1, 1,0.85],
    "D": [0,0, 0,1, 0.6,1, 1,0.7, 1,0.3, 0.6,0, 0,0],
    "E": [1,0, 0,0, 0,1, 1,1, -1,-1, 0,0.5, 0.7,0.5],
    "F": [0,1, 0,0, 1,0, -1,-1, 0,0.5, 0.7,0.5],
    "G": [1,0.15, 0.7,0, 0.3,0, 0,0.15, 0,0.85, 0.3,1, 0.7,1, 1,0.85, 1,0.55, 0.5,0.55],
    "H": [0,0, 0,1, -1,-1, 1,0, 1,1, -1,-1, 0,0.5, 1,0.5],
    "I": [0.2,0, 0.8,0, -1,-1, 0.5,0, 0.5,1, -1,-1, 0.2,1, 0.8,1],
    "J": [0.3,0, 1,0, 1,0.8, 0.7,1, 0.3,1, 0,0.8, 0,0.65],
    "K": [0,0, 0,1, -1,-1, 1,0, 0,0.5, 1,1],
    "L": [0,0, 0,1, 1,1],
    "M": [0,1, 0,0, 0.5,0.5, 1,0, 1,1],
    "N": [0,1, 0,0, 1,1, 1,0],
    "O": [0.3,0, 0.7,0, 1,0.2, 1,0.8, 0.7,1, 0.3,1, 0,0.8, 0,0.2, 0.3,0],
    "P": [0,1, 0,0, 0.7,0, 1,0.15, 1,0.4, 0.7,0.55, 0,0.55],
    "Q": [0.3,0, 0.7,0, 1,0.2, 1,0.8, 0.7,1, 0.3,1, 0,0.8, 0,0.2, 0.3,0, -1,-1, 0.55,0.7, 1.0,1.1],
    "R": [0,1, 0,0, 0.7,0, 1,0.15, 1,0.4, 0.7,0.55, 0,0.55, -1,-1, 0.5,0.55, 1,1],
    "S": [1,0.15, 0.7,0, 0.3,0, 0,0.15, 0,0.35, 0.3,0.5, 0.7,0.5, 1,0.65, 1,0.85, 0.7,1, 0.3,1, 0,0.85],
    "T": [0,0, 1,0, -1,-1, 0.5,0, 0.5,1],
    "U": [0,0, 0,0.8, 0.3,1, 0.7,1, 1,0.8, 1,0],
    "V": [0,0, 0.5,1, 1,0],
    "W": [0,0, 0.2,1, 0.5,0.5, 0.8,1, 1,0],
    "X": [0,0, 1,1, -1,-1, 1,0, 0,1],
    "Y": [0,0, 0.5,0.5, 1,0, -1,-1, 0.5,0.5, 0.5,1],
    "Z": [0,0, 1,0, 0,1, 1,1],
    "0": [0.3,0, 0.7,0, 1,0.2, 1,0.8, 0.7,1, 0.3,1, 0,0.8, 0,0.2, 0.3,0, -1,-1, 0,0.85, 1,0.15],
    "1": [0.2,0.2, 0.5,0, 0.5,1, -1,-1, 0.2,1, 0.8,1],
    "2": [0,0.2, 0.2,0, 0.8,0, 1,0.2, 1,0.4, 0,1, 1,1],
    "3": [0,0.15, 0.3,0, 0.7,0, 1,0.15, 1,0.4, 0.7,0.5, 0.4,0.5, -1,-1, 0.7,0.5, 1,0.65, 1,0.85, 0.7,1, 0.3,1, 0,0.85],
    "4": [0.7,0, 0,0.7, 1,0.7, -1,-1, 0.7,0, 0.7,1],
    "5": [1,0, 0,0, 0,0.5, 0.7,0.5, 1,0.65, 1,0.85, 0.7,1, 0.3,1, 0,0.85],
    "6": [1,0.1, 0.5,0, 0.2,0.1, 0,0.4, 0,0.85, 0.3,1, 0.7,1, 1,0.85, 1,0.65, 0.7,0.5, 0.2,0.5, 0,0.6],
    "7": [0,0, 1,0, 0.3,1],
    "8": [0.3,0, 0.7,0, 1,0.15, 1,0.35, 0.7,0.5, 0.3,0.5, 0,0.35, 0,0.15, 0.3,0, -1,-1, 0.3,0.5, 0,0.65, 0,0.85, 0.3,1, 0.7,1, 1,0.85, 1,0.65, 0.7,0.5],
    "9": [1,0.55, 0.7,0.5, 0.3,0.5, 0,0.4, 0,0.15, 0.3,0, 0.7,0, 1,0.15, 1,0.6, 0.5,1],
    " ": [],
    ".": [0.45,0.95, 0.55,0.95, 0.55,1, 0.45,1, 0.45,0.95],
    ",": [0.55,0.85, 0.5,1, 0.35,1.15],
    ":": [0.45,0.3, 0.55,0.3, 0.55,0.4, 0.45,0.4, 0.45,0.3, -1,-1, 0.45,0.7, 0.55,0.7, 0.55,0.8, 0.45,0.8, 0.45,0.7],
    ";": [0.45,0.3, 0.55,0.3, 0.55,0.4, 0.45,0.4, 0.45,0.3, -1,-1, 0.55,0.85, 0.5,1, 0.35,1.15],
    "!": [0.5,0, 0.5,0.7, -1,-1, 0.45,0.9, 0.55,0.9, 0.55,1, 0.45,1, 0.45,0.9],
    "?": [0,0.15, 0.3,0, 0.7,0, 1,0.15, 1,0.35, 0.5,0.55, 0.5,0.7, -1,-1, 0.45,0.9, 0.55,0.9, 0.55,1, 0.45,1, 0.45,0.9],
    "-": [0.1,0.5, 0.9,0.5],
    "+": [0.1,0.5, 0.9,0.5, -1,-1, 0.5,0.15, 0.5,0.85],
    "=": [0.1,0.4, 0.9,0.4, -1,-1, 0.1,0.65, 0.9,0.65],
    "*": [0.5,0.15, 0.5,0.85, -1,-1, 0.15,0.3, 0.85,0.7, -1,-1, 0.85,0.3, 0.15,0.7],
    "/": [1,0, 0,1],
    "\\": [0,0, 1,1],
    "(": [0.7,0, 0.3,0.2, 0.3,0.8, 0.7,1],
    ")": [0.3,0, 0.7,0.2, 0.7,0.8, 0.3,1],
    "[": [0.7,0, 0.3,0, 0.3,1, 0.7,1],
    "]": [0.3,0, 0.7,0, 0.7,1, 0.3,1],
    "'": [0.5,0, 0.5,0.25],
    "\"": [0.3,0, 0.3,0.25, -1,-1, 0.7,0, 0.7,0.25],
    "#": [0.3,0, 0.3,1, -1,-1, 0.7,0, 0.7,1, -1,-1, 0,0.35, 1,0.35, -1,-1, 0,0.65, 1,0.65],
    "$": [1,0.15, 0.7,0, 0.3,0, 0,0.15, 0,0.35, 0.3,0.5, 0.7,0.5, 1,0.65, 1,0.85, 0.7,1, 0.3,1, 0,0.85, -1,-1, 0.5,-0.1, 0.5,1.1],
    "%": [0,1, 1,0, -1,-1, 0.15,0.1, 0.3,0.2, 0.15,0.3, 0,0.2, 0.15,0.1, -1,-1, 0.85,0.7, 1,0.8, 0.85,0.9, 0.7,0.8, 0.85,0.7],
    "&": [1,1, 0.4,0.5, 0,0.25, 0.2,0, 0.6,0, 0.8,0.25, 0.4,0.5, 0,0.75, 0.2,1, 0.6,1, 0.9,0.75],
    "@": [0.7,1, 0.3,1, 0,0.7, 0,0.3, 0.3,0, 0.7,0, 1,0.3, 1,0.7, 0.55,0.7, 0.45,0.55, 0.45,0.4, 0.55,0.3, 0.7,0.45, 0.7,0.65],
    "<": [0.8,0.2, 0.2,0.5, 0.8,0.8],
    ">": [0.2,0.2, 0.8,0.5, 0.2,0.8],
    "_": [0,1, 1,1],
    "·": [0.45,0.45, 0.55,0.45, 0.55,0.55, 0.45,0.55, 0.45,0.45], // mid-dot for chained run titles
  };

  // Render a single glyph at (x, y) with width = size * GLYPH_ASPECT and height = size.
  // Strokes with the currently-set strokeStyle / lineWidth / shadowBlur, then drops Vector
  // corner dots at every emitted vertex. Glyph vertex coords go into a shared Float32Array
  // (max-32-vertex glyphs in the font), so this avoids the per-glyph `verts = []`
  // allocation that was generating GC pressure under heavy text rendering.
  // ─── Vector text + offscreen cache. Building each glyph from path primitives every
  // frame is wasteful: the same labels (score, sub-line, intro overlay) repaint
  // identically for many consecutive frames. Each unique (text, size, color, …) combo is
  // baked once into a dedicated offscreen canvas; subsequent draws are a single
  // drawImage blit. LRU eviction caps memory at MAX_CACHE entries. Score (changes per
  // capture) misses the cache on every score change but hits for every frame between
  // captures; the sub-line and tutorial overlay are stable for ~seconds at a time so
  // they hit on virtually every frame.

  const _textCache = new Map();
  const _textCacheMax = 32;
  const _glyphVerts = new Float32Array(64);

  // ── Offscreen-canvas pool for bakeTextLabel ──
  // Each bake used to do `document.createElement("canvas")` + per-bake buffer alloc.
  // Most score / sub / flash bakes recur with the same dimensions (10 digits at the
  // same size all bake to one canvas size; the sub-line stays close to one width
  // across captures). When a cache entry is LRU-evicted, its canvas returns to the
  // pool keyed by (widthPx × heightPx). Subsequent same-size bakes pop a recycled
  // canvas instead of creating a new DOM element. Cap of 4 per bucket prevents
  // unbounded growth on bake-size diversity. Pool entries match the request by key,
  // so dims are already correct; an explicit clearRect inside acquire wipes residue
  // from the previous bake (per HTML spec, assigning canvas.width to its current
  // value does NOT reset the bitmap — only a value change does, so we can't rely on
  // a width re-assignment to clear).
  const _canvasPool = new Map();
  const _POOL_PER_KEY_MAX = 4;
  function acquireOffscreenCanvas(widthPx, heightPx) {
    const k = widthPx + "x" + heightPx;
    const arr = _canvasPool.get(k);
    if (arr && arr.length > 0) {
      const c = arr.pop();
      // Reset bitmap + transform explicitly. Without this, the next bake's
      // composite="lighter" strokes would accumulate on top of the previous bake's
      // pixels, producing corrupted ghost-text. setTransform to identity first so
      // clearRect covers the full pixel surface regardless of the prior transform.
      const cc = c.getContext("2d");
      cc.setTransform(1, 0, 0, 1, 0, 0);
      cc.clearRect(0, 0, widthPx, heightPx);
      return c;
    }
    const c = document.createElement("canvas");
    c.width = widthPx;
    c.height = heightPx;
    return c;
  }
  function releaseOffscreenCanvas(c) {
    if (!c || !c.width || !c.height) return;
    const k = c.width + "x" + c.height;
    let arr = _canvasPool.get(k);
    if (!arr) { arr = []; _canvasPool.set(k, arr); }
    if (arr.length < _POOL_PER_KEY_MAX) arr.push(c);
  }

  // ── Per-frame bake budget ──
  // bakeTextLabel costs 2-8 ms on mobile (canvas alloc + per-glyph strokes). When
  // multiple texts change in the same frame (capture: score + sub + flash text all
  // re-bake), the spike can push frame time over the budget. Limit non-trivial bakes
  // to FRAME_BAKE_BUDGET per frame; texts whose bake is skipped this frame don't
  // render that frame but will hit cache or get bake budget next frame. Single-char
  // bakes (digit fast path below) bypass this limit — they're cheap and on the
  // critical render path. Reset in beginFrame.
  const FRAME_BAKE_BUDGET = 2;
  let _frameBakeBudget = FRAME_BAKE_BUDGET;

  // Render a single glyph into the given context. Per-segment strokes so each glyph's
  // interior vertices (direction changes within the letterform) accumulate via
  // composite="lighter" — same overlap-brightening mechanism as polygon stroking. The
  // bake's globalAlpha is multiplied by LINE_ALPHA so individual segments stay below
  // saturation; corners (e.g. the join in `K`, the `Y` fork, the spout-tip notch in `T`)
  // brighten via overlap. The offscreen ctx is left with shadowBlur=0 (default) by
  // bakeTextLabel — earlier the bake configured a non-zero shadowBlur and this function
  // had to suppress it per-stroke, but the halo path was deleted; nothing to suppress now.
  function drawGlyphInto(c, glyphData, x, y, size) {
    if (!glyphData || glyphData.length === 0) return;
    const w = size * GLYPH_ASPECT;
    const h = size;
    const prevAlpha = c.globalAlpha;
    c.globalAlpha = prevAlpha * LINE_ALPHA;
    let penDown = false;
    let lastX = 0, lastY = 0;
    for (let i = 0; i < glyphData.length; i += 2) {
      if (glyphData[i] === -1 && glyphData[i + 1] === -1) {
        penDown = false;
        continue;
      }
      const px = x + glyphData[i] * w;
      const py = y + glyphData[i + 1] * h;
      if (penDown) {
        c.beginPath();
        c.moveTo(lastX, lastY);
        c.lineTo(px, py);
        c.stroke();
      }
      lastX = px; lastY = py;
      penDown = true;
    }
    c.globalAlpha = prevAlpha;
  }

  // Bake a text label into a dedicated DPR-scaled offscreen canvas. Returns
  // { canvas, widthCSS, heightCSS, padCSS, textWidthCSS } for the blit step in drawText.
  function bakeTextLabel(text, size, opts) {
    const spacing = opts.spacing !== undefined ? opts.spacing : 0.22;
    const lineWidth = opts.width !== undefined ? opts.width : 1.2;
    const color = opts.color || "rgba(190,255,210,0.95)";
    const advance = size * (GLYPH_ASPECT + spacing);
    const lines = String(text).toUpperCase().split("\n");
    let maxLineW = 0;
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (line.length === 0) continue;
      const w = line.length * advance - size * spacing;
      if (w > maxLineW) maxLineW = w;
    }
    // Small fixed pad — just enough so antialiasing residue at the stroke edges doesn't
    // clip against the offscreen-canvas border. Earlier the pad scaled with shadowBlur
    // to fit a halo around the strokes, but the bake-time halo was removed (drawGlyphInto
    // zeroed shadowBlur for every stroke, so no halo ever painted); shrinking the pad
    // reduces the offscreen canvas size with no visual effect.
    const padCSS = 4;
    const textWidthCSS = maxLineW;
    const textHeightCSS = lines.length * size * GLYPH_LINE_HEIGHT;
    const widthCSS = textWidthCSS + padCSS * 2;
    const heightCSS = textHeightCSS + padCSS * 2;
    const dpr = viewDPR || 1;
    const offW = Math.max(1, Math.ceil(widthCSS * dpr));
    const offH = Math.max(1, Math.ceil(heightCSS * dpr));
    const off = acquireOffscreenCanvas(offW, offH);
    const oc = off.getContext("2d");
    oc.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Additive composite so per-segment strokes in drawGlyphInto accumulate at shared
    // glyph vertices (e.g. K, Y, B, T joints) — same overlap-brightening mechanism the
    // polygon stroker uses on the main canvas.
    oc.globalCompositeOperation = "lighter";
    oc.strokeStyle = color;
    oc.lineWidth = lineWidth;
    oc.lineCap = "round";
    oc.lineJoin = "round";
    // Center each line within the bake's max-line width so multi-line wrapped intro
    // text reads as a centered block rather than stacked flush-left under a centered
    // bounding box. Single-line bakes get lineW == maxLineW, so the offset is 0 and
    // behavior is unchanged for the score / sub / flash callers.
    let cy = padCSS;
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const lineW = Math.max(0, line.length * advance - size * spacing);
      let cx = padCSS + (maxLineW - lineW) * 0.5;
      for (let i = 0; i < line.length; i++) {
        const glyph = GLYPHS[line.charAt(i)];
        if (glyph !== undefined) drawGlyphInto(oc, glyph, cx, cy, size);
        cx += advance;
      }
      cy += size * GLYPH_LINE_HEIGHT;
    }
    return { canvas: off, widthCSS, heightCSS, padCSS, textWidthCSS };
  }

  // Cached text draw. Cache key includes every parameter that affects pixel output;
  // alignment is applied at blit time so left / center / right of the same label share
  // one bake. LRU eviction via Map insertion-order: on a hit we delete-and-reinsert to
  // move the key to the back; the next miss evicts the front (oldest) entry.
  // Look up a baked entry by cache key, baking on miss. Returns null when a bake would
  // be needed AND the per-frame bake budget is exhausted — caller should skip its draw
  // this frame (next frame will either find the cache populated by someone else or have
  // budget again). Single-char bakes (used by the digit fast path) bypass the budget
  // via `bypassBudget = true` since they're cheap, predictable, and on the critical
  // path of the score render.
  function _getOrBakeEntry(text, size, opts, key, bypassBudget) {
    let entry = _textCache.get(key);
    if (entry) {
      _textCache.delete(key);
      _textCache.set(key, entry);
      return entry;
    }
    if (!bypassBudget && _frameBakeBudget <= 0) return null;
    if (!bypassBudget) _frameBakeBudget--;
    entry = bakeTextLabel(text, size, opts);
    _textCache.set(key, entry);
    if (_textCache.size > _textCacheMax) {
      const oldestKey = _textCache.keys().next().value;
      const oldEntry = _textCache.get(oldestKey);
      _textCache.delete(oldestKey);
      // Return the evicted entry's canvas to the pool so a same-size bake later can
      // skip the DOM-element allocation.
      if (oldEntry && oldEntry.canvas) releaseOffscreenCanvas(oldEntry.canvas);
    }
    return entry;
  }

  // Fast path for digit-only strings (most commonly the score). Each digit '0'-'9' gets
  // its own cache entry under the same (size, color, width, spacing) tuple, so after the
  // first sighting of each digit no further bakes occur — score increments just emit a
  // few drawImage calls per frame. Single-char bakes bypass FRAME_BAKE_BUDGET (cheap +
  // critical-path; can't ration without leaving digits unrendered). Composited digits
  // are positioned via the same `advance` (size × (GLYPH_ASPECT + spacing)) the regular
  // bake uses, so the visual layout is bit-identical to a full-string bake.
  function drawDigitsFast(text, x, y, size, opts) {
    const align = opts.align || "left";
    const spacing = opts.spacing !== undefined ? opts.spacing : 0.22;
    const advance = size * (GLYPH_ASPECT + spacing);
    const totalW = text.length * advance - size * spacing;
    let startX;
    if (align === "center") startX = x - totalW * 0.5;
    else if (align === "right") startX = x - totalW;
    else startX = x;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charAt(i);
      const key = ch + "\x01" + size + "\x01" + (opts.color || "") + "\x01"
                + (opts.width === undefined ? "" : opts.width) + "\x01"
                + (opts.spacing === undefined ? "" : opts.spacing);
      const entry = _getOrBakeEntry(ch, size, opts, key, true);
      if (!entry) continue;
      const blitX = startX + i * advance - entry.padCSS;
      const blitY = y - entry.padCSS;
      ctx.drawImage(entry.canvas, blitX, blitY, entry.widthCSS, entry.heightCSS);
    }
  }

  function drawText(text, x, y, size, opts) {
    if (!text) return;
    opts = opts || {};
    const align = opts.align || "left";
    // Digit-only multi-char strings take the per-digit fast path so score updates (which
    // happen on every capture) don't re-bake the whole number each time.
    if (text.length > 1 && /^\d+$/.test(text)) {
      drawDigitsFast(text, x, y, size, opts);
      return;
    }
    // Cache key excludes shadowBlur / blurColor — they were keys when bakeTextLabel
    // rendered a shadow halo, but the bake-time halo was removed, so callers passing
    // different shadowBlur values produce bit-identical bakes that should share an entry.
    const key = text + "\x01" + size + "\x01" + (opts.color || "") + "\x01"
              + (opts.width === undefined ? "" : opts.width) + "\x01"
              + (opts.spacing === undefined ? "" : opts.spacing);
    // Single-char bakes are cheap; bypass the frame budget for them so the digit fast
    // path (and any one-off single-char drawText callers) always render.
    const bypassBudget = text.length <= 1;
    const entry = _getOrBakeEntry(text, size, opts, key, bypassBudget);
    if (!entry) return;
    let blitX = x - entry.padCSS;
    if (align === "center") blitX = x - entry.textWidthCSS * 0.5 - entry.padCSS;
    else if (align === "right") blitX = x - entry.textWidthCSS - entry.padCSS;
    const blitY = y - entry.padCSS;
    ctx.drawImage(entry.canvas, blitX, blitY, entry.widthCSS, entry.heightCSS);
  }

  // ─── Per-variant draws (Tier 3, Vector). Each function assumes the camera matrix is
  // applied and the composite mode is "lighter". Variants that need source-over for an
  // opaque dark shape switch the mode internally and restore "lighter" before returning.

  function intensityOf(s) {
    if (s.isPast) return 0.30;
    if (s.isCurrent) return 1.0 + 0.15 * Math.sin(nowSec * 3.2); // gentle current-star pulse
    return 0.85;
  }

  function setStroke(color, width, _blurColor) {
    setSS(color);
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // No shadowBlur set here. Every existing caller follows setStroke with a strokePoly*
    // call, which routes through _strokeScratchPoly — that function forces shadowBlur to 0
    // for the duration of its per-segment strokes (otherwise the soft halo bleed would
    // refill the corner regions and kill the overlap-brightening signal). The blur that
    // setStroke used to write was never seen by any actual stroke; remove the wasted
    // ctx.shadowBlur / ctx.shadowColor writes. _blurColor kept in signature so callers
    // don't need to change.
  }

  function drawPlainStar(s, c1, intensity) {
    const r = s.r;
    const baseRGB = rgbStr(c1, 1.2); // boost saturation for phosphor feel
    const color = "rgba(" + baseRGB + "," + Math.min(1, intensity) + ")";
    setStroke(color, 2.1);
    // Photosphere outline — 12-gon at this scale, plenty round enough for the eye. Keeps
    // the glow so the star reads as luminous.
    strokePolyCircle(s.x, s.y, r, 12);
    // Decorative inner ring + rays: drop shadowBlur to 0. The photosphere's glow already
    // covers this region, and inner/rays are sharp accent strokes that don't need their
    // own blur passes — biggest savings come from the rays loop, which used to be one
    // blurred stroke per star.
    if (!s.isPast) {
      setSB(0);
      ctx.lineWidth = 1.0;
      strokePolyCircle(s.x, s.y, r * 0.55, 8);
      const rays = 8;
      const angle0 = nowSec * 0.35;
      const inR = r * 1.15, outR = r * 1.55;
      ctx.lineWidth = 1.0;
      setSS("rgba(" + baseRGB + "," + (0.7 * intensity) + ")");
      ctx.beginPath();
      for (let k = 0; k < rays; k++) {
        const a = angle0 + (k / rays) * Math.PI * 2;
        const cx = Math.cos(a), cy = Math.sin(a);
        ctx.moveTo(s.x + cx * inR, s.y + cy * inR);
        ctx.lineTo(s.x + cx * outR, s.y + cy * outR);
      }
      ctx.stroke();
    }
  }

  function drawBlackHole(s, intensity) {
    const r = s.r;
    // No opaque event-horizon fill: it wiped the phosphor afterglow inside the disc each
    // frame, leaving the portions of each accretion ellipse that cross the disc visibly
    // dimmer than the portions outside it. Canvas is already black; the dark centre is
    // implicit from the absence of strokes inside the innermost ellipse's minor axis.
    setSB(0);
    setCop("lighter");
    // Wireframe accretion: three rotating polygon-approximated ellipses at varying tilts.
    // Caller alpha pushed to 1.0 (capped by LINE_ALPHA inside _strokeScratchPoly) and
    // lineWidth bumped so the BH reads as a dominant feature on screen.
    const accColor = "rgba(255,150,55," + Math.min(1, intensity) + ")";
    setStroke(accColor, 1.8);
    const rot = nowSec * 0.6;
    for (let k = 0; k < 3; k++) {
      const tilt = rot + k * (Math.PI / 3);
      const ringR = r * (1.6 + k * 0.35);
      const ratio = 0.22 + k * 0.06;
      strokePolyEllipse(s.x, s.y, ringR, ringR * ratio, tilt, 14);
    }
  }

  function drawMonolith(s, intensity) {
    // 3D wireframe box rotating around Y plus a gentle X tilt. 8 vertices, 12 edges, each
    // edge rendered with alpha and width modulated by the average depth of its endpoints
    // — back edges dim and thin, front edges bright and thick. Reads as a rotating solid
    // even without an explicit silhouette fill because the depth cue carries the form.
    const r = s.r;
    // True 2001 monolith proportions: 1:4:9 (width : height : depth). The depth axis
    // is dramatically longer than the visible front face — when the monolith rotates
    // around Y, the broad side swings into view to fill far more screen than the
    // narrow face suggests. With unit = 0.35r:
    //   w = 0.35r,  h = 1.40r,  d = 3.15r   (bounding sphere ≈ 1.74r)
    const unit = r * 0.35;
    const w = unit, h = unit * 4, d = unit * 9;
    const angleY = nowSec * 0.55;
    const angleX = 0.30 + Math.sin(nowSec * 0.27) * 0.18;
    const cyA = Math.cos(angleY), syA = Math.sin(angleY);
    const cxA = Math.cos(angleX), sxA = Math.sin(angleX);
    const verts = [
      [-w / 2, -h / 2, -d / 2], [+w / 2, -h / 2, -d / 2],
      [+w / 2, +h / 2, -d / 2], [-w / 2, +h / 2, -d / 2],
      [-w / 2, -h / 2, +d / 2], [+w / 2, -h / 2, +d / 2],
      [+w / 2, +h / 2, +d / 2], [-w / 2, +h / 2, +d / 2],
    ];
    const proj = new Array(8);
    for (let i = 0; i < 8; i++) {
      const v = verts[i];
      // Y rotation: (x, z) plane.
      const x1 = cyA * v[0] - syA * v[2];
      const z1 = syA * v[0] + cyA * v[2];
      const y1 = v[1];
      // X rotation: (y, z) plane.
      const y2 = cxA * y1 - sxA * z1;
      const z2 = sxA * y1 + cxA * z1;
      proj[i] = { x: s.x + x1, y: s.y + y2, z: z2 };
    }
    const edges = [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    // depthSpan normalises the avg-z to [0, 1] for alpha modulation. With our box,
    // |z| ≤ √(w² + h² + d²) / 2 after rotation; use the bounding sphere radius.
    const depthSpan = Math.sqrt(w * w + h * h + d * d) * 0.5;
    setCop("lighter");
    // Monolith edges have per-edge depth-modulated style (alpha, width, blur), so they
    // can't share a single _strokeScratchPoly call. Each edge becomes its own 2-vertex
    // call — the function applies the LINE_ALPHA cap so the front-edge full-alpha lines
    // no longer saturate. With three edges meeting at every box vertex, the per-segment
    // strokes naturally accumulate at those shared vertices.
    for (let i = 0; i < edges.length; i++) {
      const pa = proj[edges[i][0]], pb = proj[edges[i][1]];
      const avgZ = (pa.z + pb.z) * 0.5;
      const t = 0.5 + 0.5 * (avgZ / depthSpan);   // [0, 1]: back→front
      const alpha = (0.30 + t * 0.70) * intensity;
      const width = 0.7 + t * 1.1;
      const blur = 3 + t * 6;
      setSS("rgba(80,200,255," + Math.min(1, alpha) + ")");
      setSC("rgba(80,200,255,1)");
      setSB(blur);
      ctx.lineWidth = width;
      ctx.lineCap = "round";
      _scratchVerts[0] = pa.x; _scratchVerts[1] = pa.y;
      _scratchVerts[2] = pb.x; _scratchVerts[3] = pb.y;
      _strokeScratchPoly(2, false);
    }
  }

  function drawRingworld(s, c1, intensity) {
    drawPlainStar({ ...s, isNext: false }, c1, intensity * 0.9);
    const r = s.r;
    const bandR = r * 2.6;
    const ratio = 0.30;
    const spin = nowSec * 0.5;
    const col = "rgba(190,220,255," + Math.min(1, intensity) + ")";
    setStroke(col, 1.6);
    // Outer band — polygon-approximated rotated ellipse with corner dots.
    strokePolyEllipse(s.x, s.y, bandR, bandR * ratio, spin, 18);
    // Parallel inner stroke for band thickness. (No setSB here — strokePolyEllipse zeros
    // blur internally, so any setSB before it is wasted.)
    ctx.lineWidth = 0.8;
    setSS("rgba(140,170,210," + (0.7 * intensity) + ")");
    strokePolyEllipse(s.x, s.y, bandR * 0.94, bandR * ratio * 0.94, spin, 18);
    // Six radial spokes from band to core. Each spoke is its own 2-vertex
    // _strokeScratchPoly call so the LINE_ALPHA cap applies and the outer endpoints
    // (which sit on the band silhouette) get corner overlap from the band's segments
    // that share their position.
    ctx.lineWidth = 0.6;
    setSS("rgba(140,170,210," + (0.5 * intensity) + ")");
    const spokes = 6;
    const cs = Math.cos(spin), ss = Math.sin(spin);
    for (let k = 0; k < spokes; k++) {
      const a = (k / spokes) * Math.PI * 2;
      const inX = Math.cos(a) * r * 1.05;
      const inY = Math.sin(a) * r * 1.05 * ratio;
      const outX = Math.cos(a) * bandR * 0.94;
      const outY = Math.sin(a) * bandR * ratio * 0.94;
      _scratchVerts[0] = s.x + cs * inX - ss * inY;
      _scratchVerts[1] = s.y + ss * inX + cs * inY;
      _scratchVerts[2] = s.x + cs * outX - ss * outY;
      _scratchVerts[3] = s.y + ss * outX + cs * outY;
      _strokeScratchPoly(2, false);
    }
  }

  function drawPulsar(s, c1, intensity) {
    // Pseudo-3D: the beam tip traces an ellipse over time. The ellipse height-to-width
    // ratio < 1 reads as "viewing the pulsar from above" — the beam sweeps in 3D and
    // the projection foreshortens. When |sin(sweep)| approaches 1 (beam toward / away
    // from camera plane), brightness peaks → that's the visible lighthouse flash. With
    // two opposed beams, the flash fires twice per rotation.
    const r = s.r;
    const baseRGB = rgbStr(c1, 1.3);
    const sweep = nowSec * 1.8;
    const cosT = Math.cos(sweep);
    const sinT = Math.sin(sweep);
    const beamLenX = r * 5.5;
    const beamLenY = r * 2.4;
    // Sharp flash peaks twice per cycle, when either beam crosses the camera direction.
    const flashEnvelope = Math.pow(Math.abs(sinT), 8);
    // Per-beam brightness: each beam swells when *it* is pointing toward the viewer
    // (sign-matched: beam 0 flashes at sinT > 0, beam 1 at sinT < 0). Pre-compute both
    // and draw the brighter one last so it lands on top.
    const beams = [
      { sign:  1, depth:  sinT }, // beam pointing right/forward
      { sign: -1, depth: -sinT },
    ];
    beams.sort((a, b) => a.depth - b.depth); // draw far beam first, near beam last
    for (let i = 0; i < beams.length; i++) {
      const dir = beams[i].sign;
      const depth = beams[i].depth;          // [-1, 1]; +1 = toward camera
      const tipX = dir * cosT * beamLenX;
      const tipY = dir * sinT * beamLenY;
      // Brightness: dim when behind (depth < 0), bright when toward camera (depth → 1).
      const lit = 0.30 + Math.max(0, depth) * 0.55;
      const flash = Math.pow(Math.max(0, depth), 8) * 1.6;
      const a = Math.min(1, (lit + flash) * intensity);
      const beamCol = "rgba(255,230,180," + a + ")";
      setStroke(beamCol, 1.2 + Math.max(0, depth) * 0.8);
      // Tapered triangle outline; width foreshortens with horizontal projection.
      const baseHalf = r * 0.22;
      const flareEnd = r * 0.04 + Math.max(0, depth) * r * 0.25;
      _scratchVerts[0] = s.x - baseHalf * Math.sin(sweep) * dir;
      _scratchVerts[1] = s.y + baseHalf * Math.cos(sweep) * dir;
      _scratchVerts[2] = s.x + tipX - flareEnd * Math.sin(sweep) * dir;
      _scratchVerts[3] = s.y + tipY + flareEnd * Math.cos(sweep) * dir;
      _scratchVerts[4] = s.x + tipX + flareEnd * Math.sin(sweep) * dir;
      _scratchVerts[5] = s.y + tipY - flareEnd * Math.cos(sweep) * dir;
      _scratchVerts[6] = s.x + baseHalf * Math.sin(sweep) * dir;
      _scratchVerts[7] = s.y - baseHalf * Math.cos(sweep) * dir;
      _strokeScratchPoly(4, true);
    }
    // Faint guide ellipse — the trajectory of the beam tips. Reads as "this is what's
    // spinning in 3D".
    setStroke("rgba(255,200,140," + (0.18 * intensity) + ")", 0.6);
    strokePolyEllipse(s.x, s.y, beamLenX, beamLenY, 0, 18);
    // Core: pulses with the same flash envelope so the whole star throbs in sync.
    const corePulse = 1.0 + flashEnvelope * 1.2;
    const coreA = Math.min(1, intensity * 0.95 * corePulse);
    setStroke("rgba(" + baseRGB + "," + coreA + ")", 1.5 + flashEnvelope * 1.4);
    strokePolyCircle(s.x, s.y, r * 0.9, 10);
    // Concentric flash rings during the peak — they expand outward briefly.
    if (flashEnvelope > 0.18) {
      const flashStrength = (flashEnvelope - 0.18) / 0.82;
      setStroke("rgba(255,255,255," + (flashStrength * intensity) + ")", 1.0);
      for (let k = 1; k <= 3; k++) {
        const ringR = r * (1.0 + k * (0.55 + flashStrength * 0.35));
        strokePolyCircle(s.x, s.y, ringR, 14);
      }
    }
    // Crosshair — two disconnected segments routed individually so the LINE_ALPHA cap
    // applies and the centre (where both lines paint the same pixels) accumulates to a
    // brighter cross.
    ctx.lineWidth = 0.9;
    setSS("rgba(" + baseRGB + "," + Math.min(1, intensity * 0.85) + ")");
    _scratchVerts[0] = s.x - r * 1.2; _scratchVerts[1] = s.y;
    _scratchVerts[2] = s.x + r * 1.2; _scratchVerts[3] = s.y;
    _strokeScratchPoly(2, false);
    _scratchVerts[0] = s.x; _scratchVerts[1] = s.y - r * 1.2;
    _scratchVerts[2] = s.x; _scratchVerts[3] = s.y + r * 1.2;
    _strokeScratchPoly(2, false);
  }

  function drawNebula(s, c1, intensity) {
    // Per-nebula identity derived from stable star fields (colorIdx + position). Drives
    // vertex count, layer count, jitter pattern, rotation offset, and breath phase, so
    // two nebulae spawned in the same run have visibly distinct silhouettes.
    let h = (s.colorIdx | 0) * 0x9E3779B1;
    h = Math.imul(h ^ ((s.x * 1.7) | 0), 0x85EBCA6B);
    h = Math.imul(h ^ ((s.y * 1.3) | 0), 0xC2B2AE35);
    h = (h ^ (h >>> 16)) >>> 0;
    const seed = h / 4294967296;
    const r = s.r;
    const baseRGB = rgbStr(c1, 1.2);
    const verts = 8 + (h & 7);                          // 8..15 vertices
    const layerCount = 2 + ((h >>> 3) % 3);             // 2..4 layers
    const breathPhase = seed * Math.PI * 2;
    // Slightly stronger global breath. Each layer additionally breathes on its own offset
    // + rate so the inner / outer shells visibly contract and expand against each other
    // rather than scaling uniformly. Per-layer rotation gives the cloud a slow churn:
    // layers spin at different rates with mixed signs so the silhouette is constantly
    // reshaping without becoming a uniform whirl.
    const breathBase = 1 + (0.08 + seed * 0.10) * Math.sin(nowSec * (0.7 + seed * 0.6) + breathPhase);
    const jitterFreq = 2 + ((h >>> 6) % 5);             // 2..6 harmonic frequency
    const jitterAmp = 0.10 + seed * 0.22;               // 0.10..0.32
    const phaseShift = seed * Math.PI * 2;              // overall rotation offset (static)
    const jitterMix = (h >>> 11) & 3;                   // 0..3 mixing flavour
    const spinSign = (h >>> 14) & 1 ? 1 : -1;           // overall spin direction
    for (let L = 0; L < layerCount; L++) {
      const layerSeed = (seed + L * 0.317) % 1;
      const mul = 0.95 + L * (0.55 + seed * 0.35);
      const layerA = 0.50 - L * 0.10;
      const layerW = 1.05 - L * 0.10;
      // Per-layer breath: each layer phase-shifts the global breath cycle so inner /
      // outer shells contract against each other (counter-pulsing instead of uniform
      // scale).
      const layerBreathOffset = (0.04 + layerSeed * 0.05)
        * Math.sin(nowSec * (0.9 + L * 0.4 + seed * 0.5) + L * 1.7 + breathPhase);
      const layerBreath = breathBase + layerBreathOffset;
      const ringR = r * mul * layerBreath;
      // Per-layer rotation. Outer shells turn slower; sign alternates between layers so
      // they shear against each other for an organic, non-rigid churn.
      const layerSpeed = (0.18 + seed * 0.18) * (1 - L * 0.30);
      const layerSpin = spinSign * (L % 2 === 0 ? 1 : -1) * nowSec * layerSpeed;
      setStroke("rgba(" + baseRGB + "," + (layerA * intensity) + ")", layerW);
      for (let k = 0; k < verts; k++) {
        const a = phaseShift + layerSpin + (k / verts) * Math.PI * 2 + L * 0.18;
        // Combine two harmonics — primary at jitterFreq, secondary at slightly different
        // frequency. The harmonic argument uses (a - layerSpin) so the jitter pattern
        // rotates *with* the layer rather than scrolling past it like a fixed shape.
        const aJ = phaseShift + (k / verts) * Math.PI * 2 + L * 0.18;
        const j1 = Math.sin(aJ * jitterFreq + L * 1.7 + seed * 7);
        const j2 = Math.sin(aJ * (jitterFreq + 1) * 1.6 + L * 2.3 + seed * 13);
        const mix = jitterMix === 0 ? j1
                  : jitterMix === 1 ? (j1 * 0.7 + j2 * 0.3)
                  : jitterMix === 2 ? (j1 * 0.5 + j2 * 0.5)
                                    : (j1 + Math.abs(j2) * 0.5) * 0.7;
        const jitter = 1 + jitterAmp * mix + layerSeed * 0.05;
        _scratchVerts[k * 2] = s.x + Math.cos(a) * ringR * jitter;
        _scratchVerts[k * 2 + 1] = s.y + Math.sin(a) * ringR * jitter;
      }
      _strokeScratchPoly(verts, true);
    }
    // Central pinpoint with seed-driven brightness sway.
    const corePulse = 0.85 + 0.15 * Math.sin(nowSec * (1.0 + seed * 0.8) + phaseShift);
    setStroke("rgba(" + PHOSPHOR_WHITE + "," + Math.min(1, intensity * corePulse) + ")", 1.0);
    strokePolyCircle(s.x, s.y, r * (0.30 + seed * 0.12), 8);
  }

  function drawTeapot(s, intensity) {
    const r = s.r;
    const col = "rgba(255,240,210," + Math.min(1, intensity) + ")";
    const accent = "rgba(80,160,255," + (0.85 * intensity) + ")";
    // Slow upright tumble — body stays mostly vertical, small rocking.
    const rock = Math.sin(nowSec * 0.6) * 0.10;
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(rock);
    setStroke(col, 1.4);
    // Body — 14-gon squashed approximation in the rocked local frame.
    strokePolyEllipse(0, 0, r, r * 0.85, 0, 14);
    // Lid line — 2-vertex polyline.
    _scratchVerts[0] = -r * 0.55; _scratchVerts[1] = -r * 0.62;
    _scratchVerts[2] =  r * 0.55; _scratchVerts[3] = -r * 0.62;
    _strokeScratchPoly(2, false);
    // Knob — 6-gon.
    strokePolyCircle(0, -r * 0.82, r * 0.13, 6);
    // Spout — 4-vertex open polyline; the two interior vertices are direction-change
    // corners that the per-segment routing brightens via overlap.
    _scratchVerts[0] = -r * 0.85; _scratchVerts[1] = -r * 0.18;
    _scratchVerts[2] = -r * 1.35; _scratchVerts[3] = -r * 0.05;
    _scratchVerts[4] = -r * 1.40; _scratchVerts[5] =  r * 0.05;
    _scratchVerts[6] = -r * 0.80; _scratchVerts[7] =  r * 0.22;
    _strokeScratchPoly(4, false);
    // Handle (right) — 8-segment arc.
    strokePolyArc(r * 1.0, 0, r * 0.42, -Math.PI / 2, Math.PI / 2, 8);
    // Cobalt accent arc on the body — 8-segment ellipse arc.
    setStroke(accent, 0.9);
    strokePolyEllipseArc(0, 0, r * 0.7, r * 0.55, 0, Math.PI * 0.15, Math.PI * 0.85, 8);
    ctx.restore();
  }

  function drawAzazel(s, intensity) {
    const r = s.r;
    // No opaque rift fill: it wiped the phosphor afterglow inside the rift each frame.
    // Canvas is already black; the dark core reads naturally from the absence of strokes
    // inside the spike crown's inner radius.
    setSB(0);
    setCop("lighter");
    // Rotating spike crown — each triangle is its own _strokeScratchPoly call so the
    // tip vertex (where two of the three edges meet) accumulates via overlap to read as
    // a bright spike point, and the base corners accumulate with the inner ring.
    const spikeCount = 14;
    const innerR = r * 0.92;
    const outerR = r * 1.55;
    const baseAngle = nowSec * 0.7;
    const spikeHalf = (Math.PI / spikeCount) * 0.35;
    setStroke("rgba(255,60,40," + (0.95 * intensity) + ")", 1.3);
    for (let k = 0; k < spikeCount; k++) {
      const a = baseAngle + (k / spikeCount) * Math.PI * 2;
      _scratchVerts[0] = s.x + Math.cos(a - spikeHalf) * innerR;
      _scratchVerts[1] = s.y + Math.sin(a - spikeHalf) * innerR;
      _scratchVerts[2] = s.x + Math.cos(a) * outerR;
      _scratchVerts[3] = s.y + Math.sin(a) * outerR;
      _scratchVerts[4] = s.x + Math.cos(a + spikeHalf) * innerR;
      _scratchVerts[5] = s.y + Math.sin(a + spikeHalf) * innerR;
      _strokeScratchPoly(3, true);
    }
    // Inner rift ring (counter-rotating) — 14-gon ellipse with rotation baked in.
    setStroke("rgba(180,30,30," + (0.75 * intensity) + ")", 0.9);
    strokePolyEllipse(s.x, s.y, r * 0.7, r * 0.42, -baseAngle * 1.3, 14);
  }

  function drawStarBatch(batch, mat) {
    if (!batch || !batch.length) return;
    applyMat(mat);
    setCop("lighter");
    for (let i = 0; i < batch.length; i++) {
      const s = batch[i];
      const c1 = c1Of(s.colorIdx);
      const intensity = intensityOf(s);
      if (s.isBlackHole) {
        drawBlackHole(s, intensity);
      } else if (s.isMonolith) {
        drawMonolith(s, intensity);
      } else if (s.isRingworld) {
        drawRingworld(s, c1, intensity);
      } else if (s.isPulsar) {
        drawPulsar(s, c1, intensity);
      } else if (s.isNebula) {
        drawNebula(s, c1, intensity);
      } else if (s.isTeapot) {
        drawTeapot(s, intensity);
      } else if (s.isAzazel) {
        drawAzazel(s, intensity);
      } else {
        drawPlainStar(s, c1, intensity);
      }
    }
    setSB(0);
    setCop("source-over");
  }

  // Particle alpha is multiplied by this in the small / large branches below. Keeps
  // ejecta / wake / burst particles below PHOSPHOR_FADE per-frame paint so the slow-
  // moving ones (BH-binary ejecta spiralling near the accretor, comet wakes near
  // periapsis) don't saturate their local pixels via accumulation. Shockwaves and ball
  // halos keep full alpha — they're transient (shockwave) or rendered exactly once per
  // frame at a moving anchor (ball).
  const PARTICLE_ALPHA = 0.4;
  function drawCircleBatch(batch, mat) {
    if (!batch || !batch.length) return;
    applyMat(mat);
    setCop("lighter");
    ctx.lineCap = "round";
    // Sub-pixel cull: comet wakes and BH-binary ejecta can swarm with particles that
    // project to less than a CSS pixel on screen — they contribute nothing visible but
    // still pay the full stroke pipeline. mat[0] is world→CSS-px scale; skip particles
    // whose largest dim would fall below the threshold. Shockwaves and ball-glow are
    // exempted because they're always significant on-screen features.
    const screenScale = mat[0];
    const MIN_SCREEN_PX = 0.6;
    // Min screen-size for the 12-gon ball-glow halo to be worth it. Below this threshold
    // a 12-segment polygon stroke (12 beginPath/stroke calls each going through
    // _strokeScratchPoly) is wasted on a few-pixel dot — visually indistinguishable from
    // the much cheaper small-particle cross. BH-binary ejecta and comet trail particles
    // hit this branch most often: hundreds of kind:2 halos per frame at small screen
    // sizes collapse into single-stroke crosses with no perceivable visual change.
    const HALO_MIN_SCREEN_PX = 5;
    for (let i = 0; i < batch.length; i++) {
      const c = batch[i];
      const a = c.a !== undefined ? c.a : 1;
      const outerR = c.outerR;
      const innerR = c.innerR || 0;
      const screenR = outerR * screenScale;
      const isShockwave = innerR > 0 && outerR > innerR;
      const isBallGlow = c.kind === 2 && screenR >= HALO_MIN_SCREEN_PX;
      if (!isShockwave && !isBallGlow && screenR < MIN_SCREEN_PX) continue;
      const rgb = rgbStr([c.r, c.g, c.b], 1);
      if (isShockwave) {
        // Shockwave: bright phosphor ring as a 16-gon. strokePolyCircle routes through
        // _strokeScratchPoly which forces shadowBlur to 0 internally, so any setSB / setSC
        // here would be wasted ctx writes.
        setSS("rgba(" + rgb + "," + a + ")");
        ctx.lineWidth = Math.max(0.8, outerR - innerR);
        const midR = (outerR + innerR) * 0.5;
        strokePolyCircle(c.x, c.y, midR, 16);
      } else if (isBallGlow) {
        // Ball-glow halo: 12-gon outline (no blur for the same reason as the shockwave).
        setSS("rgba(" + rgb + "," + (a * 0.85) + ")");
        ctx.lineWidth = 1.1;
        strokePolyCircle(c.x, c.y, Math.max(1, outerR), 12);
      } else if (outerR <= 4) {
        // Small particle: phosphor cross with zero blur. Alpha scaled by PARTICLE_ALPHA
        // so slow-moving particles (BH-binary ejecta spiralling near the accretor) don't
        // accumulate to saturation under the afterglow.
        const len = Math.max(1.0, outerR);
        const pa = a * PARTICLE_ALPHA;
        setSB(0);
        setSS("rgba(" + rgb + "," + pa + ")");
        ctx.lineWidth = Math.max(0.6, outerR * 0.45);
        ctx.beginPath();
        ctx.moveTo(c.x - len, c.y); ctx.lineTo(c.x + len, c.y);
        ctx.moveTo(c.x, c.y - len); ctx.lineTo(c.x, c.y + len);
        ctx.stroke();
      } else {
        // Larger particles (comet wake, BH-binary ejecta, ball core). Same alpha cap as
        // the small-particle branch — these are the worst offenders for swarming near a
        // dense gravity source.
        const len = outerR;
        const lx = len * 0.5;
        const ly = len * 0.8660254; // sin(60°)
        const pa = a * PARTICLE_ALPHA;
        setSB(0);
        setSS("rgba(" + rgb + "," + pa + ")");
        ctx.lineWidth = Math.max(0.7, outerR * 0.22);
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(c.x - len, c.y);       ctx.lineTo(c.x + len, c.y);
        ctx.moveTo(c.x - lx,  c.y - ly);  ctx.lineTo(c.x + lx,  c.y + ly);
        ctx.moveTo(c.x + lx,  c.y - ly);  ctx.lineTo(c.x - lx,  c.y + ly);
        ctx.stroke();
      }
    }
    setSB(0);
    setCop("source-over");
  }

  // Trail decimation. The trail array gameplay.js hands us is in world space, but the
  // camera zoom differs per platform (mobile uses a tighter computeZoom() so the same
  // world distance covers more screen). So we cap the trail by *screen pixels* walked
  // back from the head, not by sample count — guarantees a perceptually constant tail
  // length on any viewport. The stride still subsamples adjacent frames to keep the
  // segments visually discrete; the segment-count cap is a safety bound for very low
  // zooms.
  // Touch devices get a sparser trail — fewer per-frame segment strokes, segment length
  // grows to compensate so screen-pixel coverage stays in the same ballpark. The phosphor
  // afterglow blends adjacent segments so the coarser stride still reads as a smooth tail.
  const _isTouch = typeof window !== "undefined" && window.matchMedia
    && window.matchMedia("(pointer: coarse)").matches;
  const TRAIL_STRIDE = _isTouch ? 6 : 4;
  const VISIBLE_TRAIL_SEGMENTS = _isTouch ? 7 : 10;
  const MAX_TRAIL_SCREEN_PX = 120;

  function drawPolyline(points, mat, halfWidth, tailColor, headColor) {
    if (!points || points.length < 2) return;
    applyMat(mat);
    setCop("lighter");
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(0.6, halfWidth * 1.6);
    const perPoint = points[0].r !== undefined;
    const n = points.length;
    if (perPoint) {
      // Trail — decimated phosphor polyline with corner dots at each kept sample. Butt
      // caps + tighter blur keep adjacent segments visually distinct rather than smearing
      // together into a continuous arc.
      ctx.lineCap = "butt";
      // mat[0] is the world→screen scale (CSS px per world unit). Accumulating
      // |Δworld| × scale gives screen distance from the head walked backwards through
      // samples; we stop once the trail has consumed MAX_TRAIL_SCREEN_PX of screen.
      // The sample-count cap is a safety bound for very-low-zoom scenarios.
      const lastIdx = n - 1;
      const scale = mat[0];
      const keep = [lastIdx];
      let prevX = points[lastIdx].x;
      let prevY = points[lastIdx].y;
      let accPx = 0;
      for (let i = lastIdx - TRAIL_STRIDE; i >= 0; i -= TRAIL_STRIDE) {
        const cur = points[i];
        const dx = (prevX - cur.x) * scale;
        const dy = (prevY - cur.y) * scale;
        accPx += Math.hypot(dx, dy);
        if (accPx > MAX_TRAIL_SCREEN_PX) break;
        keep.unshift(i);
        if (keep.length > VISIBLE_TRAIL_SEGMENTS) break;
        prevX = cur.x;
        prevY = cur.y;
      }
      // Per-segment blur on the trail was the biggest single per-frame blur cost
      // (10 passes — one per segment). Drop it: each segment is a thin line, and the
      // ship's freshly-painted core plus the afterglow envelope below provide the
      // "phosphor breadcrumb" feel without each segment dragging a halo.
      //
      // Trail alpha capped by LINE_ALPHA so head-segment paint (where consecutive
      // frames overlap heavily on a slow orbit) doesn't saturate under PHOSPHOR_FADE
      // accumulation. The afterglow handles tail-fade decay separately.
      setSB(0);
      const prevAlpha = ctx.globalAlpha;
      ctx.globalAlpha = prevAlpha * LINE_ALPHA;
      for (let k = 1; k < keep.length; k++) {
        const i0 = keep[k - 1], i1 = keep[k];
        const p0 = points[i0], p1 = points[i1];
        const t = i1 / n;
        const r = Math.round(((p0.r + p1.r) * 0.5) * 255);
        const g = Math.round(((p0.g + p1.g) * 0.5) * 255);
        const b = Math.round(((p0.b + p1.b) * 0.5) * 255);
        const col = "rgba(" + r + "," + g + "," + b + "," + (t * 0.85) + ")";
        setSS(col);
        ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
      }
      ctx.globalAlpha = prevAlpha;
    } else {
      // Short two-colour polylines: ship velocity arrow, launch-window tangent ticks.
      // Butt caps + minimal blur so adjacent ticks around the orbit read as discrete
      // vector dashes, not a continuous halo'd arc. Corner dots only fire at *interior*
      // vertices (direction-change joints) — endpoints of a single segment aren't
      // corners, and dotting them visibly bulges the tick into a non-straight blob. A
      // 2-point polyline gets no dots at all → the tick reads as a clean straight line.
      ctx.lineCap = "butt";
      const tR = tailColor[0] * 255, tG = tailColor[1] * 255, tB = tailColor[2] * 255;
      const tA = tailColor[3];
      const hR = headColor[0] * 255, hG = headColor[1] * 255, hB = headColor[2] * 255;
      const hA = headColor[3];
      // Short polylines (launch-window ticks, ship velocity arrow): zero blur. These are
      // already discrete bright vector strokes; the glow halo was a per-tick blur pass
      // for ~24 ticks/frame that the user-perceived effect didn't need.
      const shortBlur = n <= 3 ? 0 : 3;
      for (let i = 1; i < n; i++) {
        const p0 = points[i - 1];
        const p1 = points[i];
        const t = n > 1 ? (i - 0.5) / (n - 1) : 0.5;
        const r = Math.round(tR + (hR - tR) * t);
        const g = Math.round(tG + (hG - tG) * t);
        const b = Math.round(tB + (hB - tB) * t);
        const a = tA + (hA - tA) * t;
        const col = "rgba(" + r + "," + g + "," + b + "," + a + ")";
        setSS(col);
        setSC(col);
        setSB(shortBlur);
        ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
      }
    }
    setSB(0);
    ctx.lineCap = "round";
    setCop("source-over");
  }

  function finalizeFrame(_bhData) {
    // Flush any dots collected during the star/circle/polyline phase before we reset
    // the transform — they're still in world coords from the last applyMat.
    _flushDots();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    setCop("source-over");
    ctx.globalAlpha = 1;
    setSB(0);
  }

  function makeMat(scale, ox, oy) {
    return new Float32Array([scale, 0, ox, 0, scale, oy]);
  }

  function cameraMat(camY, zoom, focusY, camX) {
    if (focusY === undefined) focusY = 0.55;
    if (camX === undefined) camX = 0;
    const ox = camX * zoom + (viewW / 2) * (1 - zoom);
    const oy = camY * zoom + (viewH * focusY) * (1 - zoom);
    return makeMat(zoom, ox, oy);
  }

  function replayMat(scale, ox, oy) {
    return makeMat(scale, ox, oy);
  }

  return {
    gl: null,
    setViewport,
    beginFrame,
    drawBackground,
    drawBgStars,
    drawStarBatch,
    drawCircleBatch,
    drawPolyline,
    drawSegments: () => {},
    finalizeFrame,
    cameraMat,
    replayMat,
    screenMat: () => screenMatVal,
    drawText,
    c1Of,
    c2Of,
  };
}
