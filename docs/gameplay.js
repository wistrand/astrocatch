// All physics + capture logic lives in physics.js (also used by
// the node test runner). This file owns DOM, canvas, input,
// gameplay state, and visuals. ES modules are strict by default.
import * as AC from "./physics.js";

// ─────────────────────────────────────────────────────────────
// Canvas setup
// ─────────────────────────────────────────────────────────────
const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");
let W = 0, H = 0, DPR = 1;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener("resize", () => { resize(); if (bgStars.length) initBgStars(); });
resize();

// Physics constants are imported from physics.js via AC.
const CAPTURE_MULT = AC.CAPTURE_MULT;
const CRASH_MULT = AC.CRASH_MULT;
const INITIAL_ORBIT_MULT = AC.INITIAL_ORBIT_MULT;
const SAFE_SEP = AC.SAFE_SEP;

// View / pacing tunables.
// < 1 means zoom out (more stars visible).
const ZOOM = 0.65;
// Fixed-timestep physics rate. Decoupled from requestAnimationFrame so a
// 144 Hz monitor doesn't run the orbits at 240 Hz, and an RAF burst right
// after page load can't sneak in extra physics work.
const PHYSICS_HZ = 120;
const PHYSICS_DT_MS = 1000 / PHYSICS_HZ;
// Clamps the per-loop time delta so a long pause (tab switch, init,
// debugger break) can't queue a burst of physics ticks and warp the
// game forward on resume.
const MAX_FRAME_GAP_MS = 100;
// Hard cap on physics ticks per loop iteration as a belt-and-braces
// guard if the clamp ever fails.
const MAX_PHYSICS_PER_FRAME = 8;
// In willHitAnyStar(): perp distance ≤ R * this counts as "might still
// capture". Only used for unbound trajectories — closed orbits get an
// explicit bound-energy fast path, so this can be tight without false
// deaths.
const MISS_GRAVITY_MULT = 5;
// Max forward distance considered for the linear miss check.
const MISS_LOOKAHEAD = 1500;

// ─────────────────────────────────────────────────────────────
// Palette — pairs of (hot, cool) per stellar type. Shifted one
// step from any related palette so the values are our own.
// ─────────────────────────────────────────────────────────────
const PALETTE = [
  ["#58e0fb", "#3a7ce4"], // ice blue
  ["#b39bf8", "#7449e4"], // lavender
  ["#fa6db0", "#ea3f8c"], // magenta
  ["#38d6a0", "#12b083"], // mint
  ["#ffaa3c", "#f08c0c"], // amber
  ["#f56b6b", "#e63838"], // coral
  ["#6ae8f4", "#08b8d2"], // teal
];
const colorOf = (i) => PALETTE[i % PALETTE.length];

// ─────────────────────────────────────────────────────────────
// World state
// ─────────────────────────────────────────────────────────────
// DYING is an intermediate state where the death event has fired
// (score frozen, high-score recorded, particle burst started) but
// physics keeps running for a short wind-down before the game-over
// screen appears. Collisions and further deaths don't re-trigger
// during DYING, and the player can't boost.
const STATE = { MENU: 0, PLAY: 1, DYING: 2, DEAD: 3 };
const DYING_FRAMES_MS = 1000;  // wind-down duration (ms)
let state = STATE.MENU;

let stars = [];     // {x,y,r,gm,colorIdx,caught,pulse}
let ball = null;    // {x,y,vx,vy,currentStar,alive}
let trail = [];     // [{x,y,life,color}]
let particles = []; // [{x,y,vx,vy,life,decay,color,size}]
let shockwaves = [];// [{x,y,r,mr,life,color}]
let bgStars = [];   // parallax starfield (screen-space, non-interactive)

// Replay: a samples-per-render-frame log of ball positions during
// the live run, replayed faded behind the game-over overlay so the
// player can watch their last attempt while the AGAIN button sits
// in front of it.
const REPLAY_MAX = 6000;
let replay = [];          // [{x, y, currentStar}, ...]
let replayBounds = null;  // {scale, ox, oy} computed once on death
let replayIdx = 0;
// Replay frames advanced per render frame. Replay was recorded at
// 1 sample/render-frame, so 1 = real-time, 1.75 = ~1.75× fast,
// 2 = 2× fast.
const REPLAY_SPEED = 1.75;

let score = 0;
let starsVisited = 0;
let best = +(localStorage.getItem("astrocatch_best") || 0);
let camY = 0;           // world->screen vertical translation
let camTargetY = 0;
let hasBoosted = false; // for the hint

// ─────────────────────────────────────────────────────────────
// Star generation
// ─────────────────────────────────────────────────────────────
function makeStar(x, y, r, colorIdx) {
  return {
    x, y, r,
    gm: AC.starGM(r),
    colorIdx,
    caught: false,
    pulse: 0,
    // Visual variety: only ~half the stars get coronal streamers,
    // so the ones that do stand out instead of every star looking
    // identically spiky.
    hasRays: Math.random() < 0.5,
    // Per-star granule count in [5, 8]. The coronal streamers
    // (when hasRays is true) reuse this count since each streamer
    // is rooted to a granule.
    nGran: 5 + Math.floor(Math.random() * 4),
  };
}

// Minimum allowed distance between two stars of radii ra, rb.
function minSeparation(ra, rb) {
  return SAFE_SEP * Math.max(ra, rb);
}

// True iff a candidate position (x,y,r) respects the separation
// invariant against every existing star.
function separationOk(x, y, r) {
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i];
    const dx = x - s.x;
    const dy = y - s.y;
    const d2 = dx * dx + dy * dy;
    const need = minSeparation(r, s.r);
    if (d2 < need * need) return false;
  }
  return true;
}

function addNextStar() {
  const prev = stars[stars.length - 1];
  const n = stars.length;
  // Difficulty ramps over the first ~60 captures, then plateaus.
  const difficulty = Math.min(n / 60, 1);

  // Pick candidate radius first so we can compute the hard minimum.
  const r = Math.max(18, (34 + Math.random() * 24) - difficulty * 14);

  // Base distance range. As difficulty grows we push the next star
  // further away (harder to reach) AND widen the angle cone (harder
  // to aim). The hard minimum from the separation invariant still
  // applies as a safety floor so neighbouring orbits can't steal
  // each other, but the base values are now set high enough that
  // they consistently dominate hardMin even at idx 1 (where the
  // initial big star pushes hardMin to ~310). This makes distance
  // grow monotonically with `difficulty` instead of being clamped
  // by the radius-driven floor early game.
  const hardMin = minSeparation(r, prev.r) + 8;
  const baseMin = 320 + difficulty * 240;  // 320 → 560
  const baseMax = 400 + difficulty * 280;  // 400 → 680
  const minD = Math.max(baseMin, hardMin);
  const maxD = Math.max(minD + 80, baseMax);

  // Try several candidate positions in the upward cone; accept the
  // first that respects the separation invariant against every star.
  for (let tries = 0; tries < 40; tries++) {
    const dist = minD + Math.random() * (maxD - minD);
    // 45° half-cone early → ~85° at max difficulty.
    const halfSpread = Math.PI * 0.25 + difficulty * Math.PI * 0.22;
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 2 * halfSpread;
    let nx = prev.x + Math.cos(angle) * dist;
    let ny = prev.y + Math.sin(angle) * dist;
    if (ny > prev.y - 120) ny = prev.y - 120 - Math.random() * 60;
    nx = Math.max(80, Math.min(W - 80, nx));
    if (separationOk(nx, ny, r)) {
      stars.push(makeStar(nx, ny, r, n));
      return;
    }
  }

  // Fallback: straight up at a safely large distance.
  const fx = Math.max(80, Math.min(W - 80, prev.x));
  const fy = prev.y - hardMin * 1.4;
  stars.push(makeStar(fx, fy, r, n));
}

// ─────────────────────────────────────────────────────────────
// Init / reset
// ─────────────────────────────────────────────────────────────
// Parallax background starfield. These are purely decorative —
// tiny twinkling points in screen space, with a depth factor in
// [0.05, 0.4] that scales how much they move with camY. depth=0.05
// means "practically a fixed star field", depth=0.4 means "still
// much farther than the gameplay layer". White dominates the
// palette with a few warm/cool tints to suggest stellar type.
function initBgStars() {
  bgStars = [];
  const count = 220;
  const palette = [
    "#ffffff", "#ffffff", "#ffffff", "#ffffff",
    "#bcd4ff", "#a8c5ff", "#ffe6c2", "#ffd7a8", "#ffc9c9",
  ];
  for (let i = 0; i < count; i++) {
    bgStars.push({
      x: Math.random() * W,
      y: Math.random() * H,
      depth: 0.05 + Math.random() * 0.35,
      size: 0.4 + Math.random() * 1.3,
      brightness: 0.25 + Math.random() * 0.65,
      phase: Math.random() * Math.PI * 2,
      twinkleSpeed: 1.4 + Math.random() * 2.5,
      color: palette[Math.floor(Math.random() * palette.length)],
    });
  }
}

function init() {
  stars = [];
  trail = [];
  particles = [];
  shockwaves = [];
  replay = [];
  replayBounds = null;
  replayIdx = 0;
  score = 0;
  starsVisited = 0;
  camY = 0;
  camTargetY = 0;
  hasBoosted = false;
  initBgStars();

  // First star, centered-ish, low on screen
  stars.push(makeStar(W / 2, H * 0.7, 44, 0));
  for (let i = 0; i < 6; i++) addNextStar();

  // Place ball in a circular orbit around star 0, above the star
  const s = stars[0];
  const r0 = s.r * INITIAL_ORBIT_MULT;
  const v = AC.circularV(s.gm, r0);
  // Start at top of star (angle = -π/2), moving right (prograde)
  ball = {
    x: s.x,
    y: s.y - r0,
    vx: v,
    vy: 0,
    currentStar: 0,
    alive: true,
    pendingCapture: -1,
    transferFrames: 0,
    captureMinD: undefined, // tracks running min-d during transfer
    captureMinX: 0,
    captureMinY: 0,
    captureMinVx: 0,
    captureMinVy: 0,
    framesInOrbit: 0,       // physics frames spent in the current orbit (reset on capture)
    pendingBonus: 1,        // multiplier earned at boost time, applied at capture
  };

  document.getElementById("score").textContent = "0";
  updateSub();
  document.getElementById("score-display").style.display = "block";
  document.getElementById("hint").classList.add("on");
}

function updateSub() {
  document.getElementById("sub").textContent =
    "best " + best + " · " + starsVisited + " stars";
}

// All gravitational physics + capture logic is in physics.js.
// We keep the existing function names below as thin wrappers so
// the rest of the file (drawing, input, etc.) doesn't have to
// change. Both modules read/write the same `stars` and `ball`
// objects, so calling AC.* directly is fine.

// One physics frame: free flight (always) + capture-burn check.
// Both live in physics.js and operate on `stars` and `ball`.
function physicsStep() {
  AC.physicsStep(stars, ball);
  ball.framesInOrbit++;
  if (AC.burnStep(stars, ball)) {
    // Burn just landed the ball on a circular orbit at peri.
    captureStar(ball.pendingCapture);
  }
}

// Current orbit's natural period (frames). Computed from energy
// E = v²/2 − GM/r and Kepler's third law T = 2π√(a³/GM) where
// a = -GM/(2E). Returns Infinity for unbound orbits, so an
// energetic transfer trajectory is treated as "no period" and
// any boost during it is "more than one rotation" (no bonus).
function currentOrbitPeriod() {
  if (!ball || !stars[ball.currentStar]) return Infinity;
  const s = stars[ball.currentStar];
  const dx = ball.x - s.x;
  const dy = ball.y - s.y;
  const r = Math.hypot(dx, dy);
  if (r < 0.01) return Infinity;
  const v2 = ball.vx * ball.vx + ball.vy * ball.vy;
  const E = v2 / 2 - s.gm / r;
  if (E >= 0) return Infinity;       // unbound orbit
  const a = -s.gm / (2 * E);
  return 2 * Math.PI * Math.sqrt((a * a * a) / s.gm);
}

// ─────────────────────────────────────────────────────────────
// Collision / capture / death checks
// ─────────────────────────────────────────────────────────────
function checkCollisions() {
  // Crash into any star surface. Scoring no longer fires from
  // radius proximity — it fires from captureStar() at the end of
  // the retrograde burn, which prediction armed on the tap.
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i];
    const dx = ball.x - s.x;
    const dy = ball.y - s.y;
    const d = Math.hypot(dx, dy);
    if (d < s.r * CRASH_MULT) {
      die();
      return;
    }
  }
}

// Scoring the capture. Called from physicsStep when the burn
// completes: the ball is already on its new circular orbit, so
// we only handle scoring, visuals, and promoting the primary.
function captureStar(idx) {
  const s = stars[idx];
  ball.pendingCapture = -1;

  s.caught = true;
  s.pulse = 1;
  ball.currentStar = idx;
  // Apply the quick-launch bonus that was locked in at boost time.
  const bonus = ball.pendingBonus || 1;
  score += bonus;
  starsVisited += 1;
  // Reset orbit timer + bonus for the new orbit.
  ball.framesInOrbit = 0;
  ball.pendingBonus = 1;
  updateScoreUI(true, bonus);

  // Visuals
  shockwaves.push({ x: s.x, y: s.y, r: 0, mr: 90, life: 1, color: colorOf(s.colorIdx)[0] });
  const [c1, c2] = colorOf(s.colorIdx);
  for (let i = 0; i < 18; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 1.5 + Math.random() * 3.5;
    particles.push({
      x: s.x, y: s.y,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      life: 1, decay: 0.018 + Math.random() * 0.018,
      color: Math.random() > 0.5 ? c1 : c2,
      size: 2 + Math.random() * 3,
    });
  }

  // Camera follow
  camTargetY = -(s.y - H * 0.55);

  // Keep the star buffer populated
  while (stars.length < idx + 8) addNextStar();
}

function updateScoreUI(bump, bonus) {
  const el = document.getElementById("score");
  el.textContent = score;
  updateSub();
  if (bump) {
    const scale = bonus >= 3 ? 1.35 : bonus >= 2 ? 1.25 : 1.15;
    el.style.transform = "scale(" + scale + ")";
    setTimeout(() => (el.style.transform = "scale(1)"), 100);
  }
  if (bonus && bonus > 1) {
    showBonusFlash(bonus);
  }
}

function showBonusFlash(bonus) {
  let el = document.getElementById("bonus-flash");
  if (!el) {
    el = document.createElement("div");
    el.id = "bonus-flash";
    el.style.cssText =
      "position:absolute;top:140px;left:0;right:0;text-align:center;" +
      "font-size:22px;font-weight:700;letter-spacing:3px;text-transform:uppercase;" +
      "pointer-events:none;opacity:0;transition:opacity .25s,transform .6s;" +
      "text-shadow:0 0 26px rgba(255,170,60,.72)";
    document.getElementById("ui").appendChild(el);
  }
  el.textContent = (bonus >= 3 ? "★ BLAZING " : "QUICK ") + "×" + bonus;
  el.style.color = bonus >= 3 ? "#ffaa3c" : "#58e0fb";
  el.style.opacity = "1";
  el.style.transform = "translateY(0) scale(" + (bonus >= 3 ? 1.15 : 1) + ")";
  // Force reflow then animate out
  void el.offsetWidth;
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateY(-30px) scale(1)";
  }, 450);
}

// ─────────────────────────────────────────────────────────────
// Boost: prograde impulse + capture-prediction. AC.applyBoostAndArm
// applies the impulse, runs the prediction, and (on success) sets
// up pendingCapture so AC.burnStep can fire at the actual periapsis.
// ─────────────────────────────────────────────────────────────
function boost() {
  if (!ball || !ball.alive) return;
  if (ball.pendingCapture >= 0) return;

  // Exhaust particles (visual only — record direction BEFORE the impulse).
  const [c1] = colorOf(stars[ball.currentStar].colorIdx);
  for (let i = 0; i < 10; i++) {
    const a = Math.atan2(-ball.vy, -ball.vx) + (Math.random() - 0.5) * 0.7;
    const s2 = 1 + Math.random() * 2.5;
    particles.push({
      x: ball.x, y: ball.y,
      vx: Math.cos(a) * s2, vy: Math.sin(a) * s2,
      life: 1, decay: 0.03 + Math.random() * 0.02,
      color: c1, size: 2 + Math.random() * 2,
    });
  }

  // Capture quick-launch bonus BEFORE the boost: read the orbital
  // period of the current orbit and compare it to how long the ball
  // has been there. The bonus is locked in now (at the moment of
  // tap) and applied later in captureStar(). Tiers:
  //   < 0.5 rotation → 3× points (very quick)
  //   < 1.0 rotation → 2× points (quick)
  //   else           → 1× points
  const period = currentOrbitPeriod();
  const orbitFraction = period > 0 ? ball.framesInOrbit / period : Infinity;
  let bonus = 1;
  if (orbitFraction < 0.5) bonus = 3;
  else if (orbitFraction < 1.0) bonus = 2;

  AC.applyBoostAndArm(stars, ball);
  // Only commit the bonus if the boost actually armed a capture.
  if (ball.pendingCapture >= 0) ball.pendingBonus = bonus;

  if (!hasBoosted) {
    hasBoosted = true;
    document.getElementById("hint").classList.remove("on");
  }
}

// ─────────────────────────────────────────────────────────────
// Death. We mark the run as over immediately (score frozen,
// high-score recorded, particle burst) but physics keeps running
// for DYING_FRAMES_MS so the ball drifts a bit before the game
// over screen appears — much less abrupt than a hard freeze.
// ─────────────────────────────────────────────────────────────
function die() {
  if (state !== STATE.PLAY) return;
  state = STATE.DYING;
  for (let i = 0; i < 36; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = 1 + Math.random() * 5;
    particles.push({
      x: ball.x, y: ball.y,
      vx: Math.cos(a) * s, vy: Math.sin(a) * s,
      life: 1, decay: 0.012 + Math.random() * 0.015,
      color: "#fa6db0", size: 2 + Math.random() * 4,
    });
  }
  if (score > best) {
    best = score;
    localStorage.setItem("astrocatch_best", "" + best);
  }
  setTimeout(() => {
    ball.alive = false;
    state = STATE.DEAD;
    computeReplayBounds();
    replayIdx = 0;
    document.getElementById("final").textContent = score;
    document.getElementById("stars").textContent = starsVisited;
    document.getElementById("best").textContent = best;
    document.getElementById("gameover").classList.remove("hidden");
    document.getElementById("hint").classList.remove("on");
    // Hide the live HUD score so it doesn't duplicate the #final on
    // the game-over overlay. init() re-shows it on the next run.
    document.getElementById("score-display").style.display = "none";
  }, DYING_FRAMES_MS);
}

// ─────────────────────────────────────────────────────────────
// Fast miss detection. Returns true if the ball might still be
// captured (or is already in a closed orbit), false if it's on
// a trajectory clearly heading into the void.
//
// We do two checks:
//   1. Bound-orbit test against the nearest star. If the ball's
//      specific orbital energy w.r.t. its primary is negative,
//      it's in a closed Kepler orbit — by definition safe, no
//      matter how eccentric. This is the only correct way to
//      handle apoapsis of high-e orbits where a linear "is the
//      star ahead?" check fails.
//   2. Linear forward-ray miss check. Only used when the ball
//      is unbound — i.e. on an actual escape trajectory after a
//      bad-timing fallback boost.
// ─────────────────────────────────────────────────────────────
function willHitAnyStar() {
  if (!ball || ball.pendingCapture >= 0) return true;

  // 1 ── bound-orbit test against the ball's gravitational primary
  // (which under nearest-star physics is the nearest star).
  let nearestIdx = 0, nearestD2 = Infinity;
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i];
    const dx = ball.x - s.x, dy = ball.y - s.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < nearestD2) { nearestD2 = d2; nearestIdx = i; }
  }
  const primary = stars[nearestIdx];
  const r = Math.sqrt(nearestD2);
  const v2 = ball.vx * ball.vx + ball.vy * ball.vy;
  const E = v2 / 2 - primary.gm / r;
  if (E < 0) return true; // bound → closed orbit → safe

  // 2 ── unbound trajectory: linear forward-ray miss check.
  const v = Math.sqrt(v2);
  if (v < 0.5) return true;
  const ux = ball.vx / v;
  const uy = ball.vy / v;
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i];
    const dx = s.x - ball.x;
    const dy = s.y - ball.y;
    const proj = dx * ux + dy * uy;           // along velocity
    if (proj < -s.r) continue;                // star is behind us
    if (proj > MISS_LOOKAHEAD) continue;      // star is too far ahead
    const perpX = dx - proj * ux;
    const perpY = dy - proj * uy;
    const perp = Math.hypot(perpX, perpY);
    if (perp < s.r * MISS_GRAVITY_MULT) return true; // might still be pulled in
  }
  return false;
}

// ─────────────────────────────────────────────────────────────
// Physics tick — runs at fixed PHYSICS_HZ regardless of monitor
// refresh rate or browser RAF cadence. Driven by a time
// accumulator in loop() (see bottom of file). One call = one
// physicsStep() + collision and miss checks. Per-render-frame
// concerns (trail, camera, off-screen) live in renderTick().
// ─────────────────────────────────────────────────────────────
function physicsTick() {
  if (state !== STATE.PLAY && state !== STATE.DYING) return;

  // During DYING, freeze the ball if it has drifted into a star's
  // crash radius so it doesn't bounce around inside the photosphere.
  if (state === STATE.DYING) {
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      const dx = ball.x - s.x;
      const dy = ball.y - s.y;
      if (dx * dx + dy * dy < (s.r * CRASH_MULT) * (s.r * CRASH_MULT)) {
        ball.vx = 0;
        ball.vy = 0;
        return;
      }
    }
  }

  physicsStep();
  if (state === STATE.PLAY) {
    checkCollisions();
    if (state !== STATE.PLAY) return; // die() ran
    if (ball.pendingCapture < 0 && !willHitAnyStar()) die();
  }
}

// Per-render-frame work: trail/replay sampling, camera follow,
// and the off-screen death check. Runs once per RAF callback.
function renderTick() {
  if (state !== STATE.PLAY && state !== STATE.DYING) return;

  const cs = stars[ball.currentStar];
  trail.push({ x: ball.x, y: ball.y, life: 1, color: colorOf(cs.colorIdx)[0] });
  if (trail.length > 260) trail.shift();

  // Replay sample (only during PLAY, not the DYING wind-down).
  if (state === STATE.PLAY) {
    replay.push({ x: ball.x, y: ball.y, currentStar: ball.currentStar });
    if (replay.length > REPLAY_MAX) replay.shift();
  }

  // Camera: follow upward progress (even while DYING, so the wind-down
  // pan matches the ball's drift).
  const desired = -(stars[ball.currentStar].y - H * 0.55);
  if (desired > camTargetY) camTargetY = desired;
  camY += (camTargetY - camY) * 0.08;

  // Off-screen death check — only while still PLAYing.
  if (state === STATE.PLAY) {
    const sy = ball.y + camY;
    const m = 260 / ZOOM;
    if (sy > H + m || sy < -m * 2 || ball.x < -m || ball.x > W + m) die();
  }
}

// ─────────────────────────────────────────────────────────────
// Replay rendering. Once the player dies, computeReplayBounds
// figures out the world-coordinate AABB of the recorded path
// (plus the stars that were touched) and stores a fit transform.
// drawReplay then renders, every frame, a faded ghost of the
// run inside the canvas, animating a marker dot along the path
// at REPLAY_SPEED frames per render. The game-over overlay sits
// on top with reduced opacity so the replay shows through.
// ─────────────────────────────────────────────────────────────
function computeReplayBounds() {
  if (replay.length < 2) { replayBounds = null; return; }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < replay.length; i++) {
    const p = replay[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  // Include any star within range of the trajectory.
  const lastIdx = ball ? Math.min(stars.length, ball.currentStar + 2) : stars.length;
  for (let i = 0; i < lastIdx; i++) {
    const s = stars[i];
    if (s.x - s.r < minX) minX = s.x - s.r;
    if (s.x + s.r > maxX) maxX = s.x + s.r;
    if (s.y - s.r < minY) minY = s.y - s.r;
    if (s.y + s.r > maxY) maxY = s.y + s.r;
  }
  const padX = 60, padY = 60;
  const wRange = (maxX - minX) + padX * 2;
  const hRange = (maxY - minY) + padY * 2;
  if (wRange <= 0 || hRange <= 0) { replayBounds = null; return; }
  const scale = Math.min(W / wRange, H / hRange);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  replayBounds = {
    scale,
    ox: W / 2 - cx * scale,
    oy: H / 2 - cy * scale,
    lastStarIdx: lastIdx,
  };
}

function drawReplay() {
  if (!replayBounds || replay.length < 2) return;
  const b = replayBounds;
  ctx.save();
  ctx.translate(b.ox, b.oy);
  ctx.scale(b.scale, b.scale);

  // Faint star markers (just dots in their colour, no spikes/glow)
  for (let i = 0; i < b.lastStarIdx; i++) {
    const s = stars[i];
    const [c1] = colorOf(s.colorIdx);
    const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r * 1.6);
    g.addColorStop(0, c1 + "55");
    g.addColorStop(1, "transparent");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r * 1.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r * 0.6, 0, Math.PI * 2);
    ctx.fillStyle = c1 + "88";
    ctx.fill();
  }

  // Trajectory path up to the current replay frame, drawn as a
  // single fading polyline so older sections feel ghosted.
  const upTo = Math.min(Math.floor(replayIdx), replay.length - 1);
  if (upTo > 1) {
    ctx.lineWidth = 1.6 / b.scale;
    ctx.strokeStyle = "rgba(160, 220, 255, 0.55)";
    ctx.beginPath();
    ctx.moveTo(replay[0].x, replay[0].y);
    for (let i = 1; i <= upTo; i++) ctx.lineTo(replay[i].x, replay[i].y);
    ctx.stroke();
  }

  // Marker dot at the current replay position.
  if (upTo >= 0) {
    const p = replay[upTo];
    const dotR = 5 / b.scale;
    const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, dotR * 4);
    glow.addColorStop(0, "rgba(255,255,255,0.85)");
    glow.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(p.x, p.y, dotR * 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(p.x, p.y, dotR, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
  }

  ctx.restore();
}

// ─────────────────────────────────────────────────────────────
// Star rendering. Real stars have structure: a hot inner disk
// (photosphere) darker at the limb than the center, granulation
// cells from convection, a chromosphere / corona bleeding outward,
// and coronal streamers that look like faint radial rays. This
// function layers all of that as composed radial and linear
// gradients, with a deterministic per-position phase so neighbour
// stars don't animate in sync.
// ─────────────────────────────────────────────────────────────
function hex2(n) {
  const v = Math.max(0, Math.min(255, Math.round(n)));
  return (v < 16 ? "0" : "") + v.toString(16);
}

function drawStar(s, t, isCurrent, isNext, isPast) {
  const [c1, c2] = colorOf(s.colorIdx);
  // Stable pseudo-random phase from world position — same every
  // frame for the same star, different across neighbours.
  const phase = (Math.sin(s.x * 0.0137 + s.y * 0.0191) * 0.5 + 0.5) * Math.PI * 2;
  const tp = t + phase;

  // Dead stars: just a small dim ember + faint aura.
  if (isPast) {
    const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r * 0.9);
    g.addColorStop(0, "rgba(255,255,255,0.22)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r * 0.9, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(s.x, s.y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.fill();
    return;
  }

  // Capture radius hint ring for the next target.
  if (isNext) {
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r * CAPTURE_MULT, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.09)";
    ctx.setLineDash([4, 6]);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Pulse: slow breathing of the disk radius (~4%).
  const pulse = 1 + 0.04 * Math.sin(tp * 1.6);
  // Flare: faster brightness modulation used by glow + core.
  const flare = 0.8 + 0.2 * Math.sin(tp * 3.2);
  // Catch-pulse boost from s.pulse (the shockwave on capture).
  const catchBoost = 1 + s.pulse * 0.45;
  const bodyR = s.r * pulse * catchBoost;

  // 1 ── Corona: very large, very faint plasma halo.
  const coronaR = bodyR * 4.6;
  const cg = ctx.createRadialGradient(s.x, s.y, bodyR * 0.9, s.x, s.y, coronaR);
  cg.addColorStop(0, c1 + "2e");
  cg.addColorStop(0.35, c1 + "12");
  cg.addColorStop(1, "transparent");
  ctx.fillStyle = cg;
  ctx.beginPath();
  ctx.arc(s.x, s.y, coronaR, 0, Math.PI * 2);
  ctx.fill();

  // ── Pre-compute the granulation cells. Each blob has an angle
  // (`ga`) from the star centre and an orbital offset (`gr`); we
  // reuse these in two places below: the coronal streamer that
  // shoots outward from each blob, and the actual surface blob
  // rendered inside the photosphere disk. Computing once keeps
  // the streamer "rooted" to its blob instead of drifting at a
  // separate angular rate.
  const nGran = s.nGran;
  const granules = new Array(nGran);
  for (let i = 0; i < nGran; i++) {
    const ga = tp * 0.35 + i * ((Math.PI * 2) / nGran) + 0.7 * Math.sin(tp + i);
    const gr = bodyR * (0.2 + 0.45 * (0.5 + 0.5 * Math.sin(tp * 0.9 + i * 2.1)));
    const gsize = bodyR * (0.28 + 0.1 * Math.sin(tp * 1.5 + i));
    granules[i] = {
      ga, gr, gsize,
      gx: s.x + Math.cos(ga) * gr,
      gy: s.y + Math.sin(ga) * gr,
    };
  }

  // 2 ── Coronal streamers — one per granule. Each streamer roots
  // at the disk surface in the radial direction of its blob and
  // extends outward as a tapered triangle with a linear gradient.
  // Streamer length scales with the blob's offset from centre
  // (gr): blobs near the surface produce longer, brighter
  // streamers; blobs near the centre produce short stubs. Width
  // scales with the blob's own size, so a beefier blob spawns a
  // beefier streamer. Skipped on stars without `hasRays` so the
  // chain isn't uniformly spiky.
  if (s.hasRays) {
    for (let i = 0; i < nGran; i++) {
      const g = granules[i];
      const flick = 0.55 + 0.45 * Math.sin(tp * 2.0 + i * 1.13);
      // Energy of this blob: how far it has drifted from centre,
      // normalized so 0 = centre, 1 = at limb.
      const energy = Math.min(1, g.gr / (bodyR * 0.65));
      const tipDist = bodyR * (0.5 + 1.0 * energy + 0.4 * flick);
      const cosA = Math.cos(g.ga);
      const sinA = Math.sin(g.ga);
      // Streamer base: just inside the disk so the disk masks the
      // inner end cleanly when it's drawn over the top.
      const baseX = s.x + cosA * bodyR * 0.92;
      const baseY = s.y + sinA * bodyR * 0.92;
      const tipX  = s.x + cosA * (bodyR + tipDist);
      const tipY  = s.y + sinA * (bodyR + tipDist);
      // Half-width perpendicular to the streamer axis, scaled to
      // the blob size.
      const halfW = g.gsize * 0.55;
      const perpX = -sinA * halfW;
      const perpY =  cosA * halfW;
      const grad = ctx.createLinearGradient(baseX, baseY, tipX, tipY);
      grad.addColorStop(0, c1 + hex2(95 * flick * (0.5 + 0.5 * energy)));
      grad.addColorStop(1, "transparent");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(baseX + perpX, baseY + perpY);
      ctx.lineTo(tipX, tipY);
      ctx.lineTo(baseX - perpX, baseY - perpY);
      ctx.closePath();
      ctx.fill();
    }
  }

  // 3 ── Outer glow: tighter, brighter than the corona.
  const glowR = bodyR * 2.1;
  const g2 = ctx.createRadialGradient(s.x, s.y, bodyR * 0.75, s.x, s.y, glowR);
  const glowAlpha = (isCurrent ? 175 : isNext ? 140 : 110) * flare;
  g2.addColorStop(0, c1 + hex2(glowAlpha));
  g2.addColorStop(1, "transparent");
  ctx.fillStyle = g2;
  ctx.beginPath();
  ctx.arc(s.x, s.y, glowR, 0, Math.PI * 2);
  ctx.fill();

  // 4 ── Photosphere: the main disk with limb darkening (edge
  // reddened/darker than the hot center).
  const diskGrad = ctx.createRadialGradient(
    s.x - bodyR * 0.12, s.y - bodyR * 0.12, 0,
    s.x, s.y, bodyR
  );
  diskGrad.addColorStop(0, "#ffffff");
  diskGrad.addColorStop(0.28, c1);
  diskGrad.addColorStop(0.78, c1);
  diskGrad.addColorStop(1, c2);
  ctx.fillStyle = diskGrad;
  ctx.beginPath();
  ctx.arc(s.x, s.y, bodyR, 0, Math.PI * 2);
  ctx.fill();

  // 5 ── Granulation: paint the same blobs we computed above,
  // clipped to the disk so they don't bleed outside.
  ctx.save();
  ctx.beginPath();
  ctx.arc(s.x, s.y, bodyR * 0.985, 0, Math.PI * 2);
  ctx.clip();
  for (let i = 0; i < nGran; i++) {
    const g = granules[i];
    const gGrad = ctx.createRadialGradient(g.gx, g.gy, 0, g.gx, g.gy, g.gsize);
    gGrad.addColorStop(0, "rgba(255,255,255,0.32)");
    gGrad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gGrad;
    ctx.beginPath();
    ctx.arc(g.gx, g.gy, g.gsize, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // 6 ── Bright core highlight (hot spot, top-left offset to hint
  // at a light source and give the disk a 3D feel).
  const coreR = bodyR * 0.22 * flare;
  const coreGrad = ctx.createRadialGradient(
    s.x - bodyR * 0.1, s.y - bodyR * 0.1, 0,
    s.x - bodyR * 0.1, s.y - bodyR * 0.1, coreR * 2
  );
  coreGrad.addColorStop(0, "rgba(255,255,255,1)");
  coreGrad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = coreGrad;
  ctx.beginPath();
  ctx.arc(s.x - bodyR * 0.1, s.y - bodyR * 0.1, coreR * 2, 0, Math.PI * 2);
  ctx.fill();
}

// ─────────────────────────────────────────────────────────────
// Drawing
// ─────────────────────────────────────────────────────────────
function draw() {
  // Background gradient
  const bg = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H));
  bg.addColorStop(0, "#12121f");
  bg.addColorStop(1, "#0a0a12");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Grid
  ctx.save();
  ctx.translate(0, camY % 40);
  ctx.strokeStyle = "rgba(255,255,255,0.02)";
  ctx.lineWidth = 1;
  for (let y = -40; y < H + 40; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y); ctx.lineTo(W, y);
    ctx.stroke();
  }
  for (let x = 0; x < W; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0); ctx.lineTo(x, H);
    ctx.stroke();
  }
  ctx.restore();

  // Parallax background starfield — tiny twinkling dots in screen
  // space, each moving a fraction of camY determined by its depth.
  // Drawn outside the zoomed world transform so pixel size is
  // preserved regardless of ZOOM, and the dots wrap vertically so
  // the field appears infinite as the camera pans upward.
  const nowSecBg = performance.now() / 1000;
  const wrapH = H + 200;
  for (let i = 0; i < bgStars.length; i++) {
    const bgs = bgStars[i];
    let y = bgs.y + camY * bgs.depth;
    y = ((y % wrapH) + wrapH) % wrapH - 100;
    if (y < -6 || y > H + 6) continue;
    const twinkle = 0.45 + 0.55 * Math.sin(nowSecBg * bgs.twinkleSpeed + bgs.phase);
    ctx.globalAlpha = bgs.brightness * twinkle;
    ctx.fillStyle = bgs.color;
    if (bgs.size < 1.0) {
      // Sub-pixel dot — fillRect is cheaper than arc.
      ctx.fillRect(bgs.x - 0.5, y - 0.5, 1, 1);
    } else {
      ctx.beginPath();
      ctx.arc(bgs.x, y, bgs.size, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  // Game-over replay: when state is DEAD, replace the live world
  // drawing with a faded ghost playback of the run. The overlay
  // sits on top with reduced opacity so the AGAIN button remains
  // legible while the replay loops behind it.
  if (state === STATE.DEAD && replayBounds) {
    ctx.globalAlpha = 0.55;
    drawReplay();
    ctx.globalAlpha = 1;
    return;
  }

  // World transform — scale around the camera focus point so the
  // ball stays roughly mid-screen but more of the upcoming chain
  // of stars is visible above and below it.
  ctx.save();
  ctx.translate(W / 2, H * 0.55);
  ctx.scale(ZOOM, ZOOM);
  ctx.translate(-W / 2, -H * 0.55);
  ctx.translate(0, camY);

  // Faint connector hints to next stars
  if (state === STATE.PLAY && ball) {
    const cs = ball.currentStar;
    for (let i = cs; i < Math.min(stars.length - 1, cs + 5); i++) {
      const a = stars[i], b = stars[i + 1];
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = "rgba(255,255,255,0.035)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // Trail
  for (let i = 0; i < trail.length; i++) {
    const t = trail[i];
    t.life -= 0.006;
    if (t.life <= 0) continue;
    ctx.beginPath();
    ctx.arc(t.x, t.y, 2.4 * t.life, 0, Math.PI * 2);
    ctx.fillStyle = t.color;
    ctx.globalAlpha = t.life * 0.55;
    ctx.fill();
  }
  trail = trail.filter((t) => t.life > 0);
  ctx.globalAlpha = 1;

  // Stars — layered render inspired by real stellar structure:
  //   • corona     : huge faint halo (outermost plasma atmosphere)
  //   • light rays : rotating radial streamers (coronal streamers)
  //   • outer glow : tighter bright halo
  //   • photosphere: the star's disk with limb darkening
  //   • granules   : animated bright blobs on the surface
  //   • core       : tiny bright hot spot
  // Each star uses a position-derived phase so its pulse / ray
  // rotation / granules aren't synced with its neighbours.
  const nowSec = performance.now() / 1000;
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i];
    const sY = s.y + camY;
    if (sY < -240 || sY > H + 240) continue;
    if (s.pulse > 0) s.pulse -= 0.03;
    const isCurrent = ball && i === ball.currentStar;
    const isNext = ball && i === ball.currentStar + 1;
    const isPast = s.caught && !isCurrent;
    drawStar(s, nowSec, isCurrent, isNext, isPast);
  }

  // Shockwaves
  for (let i = shockwaves.length - 1; i >= 0; i--) {
    const w = shockwaves[i];
    w.r += 3;
    w.life -= 0.03;
    if (w.life <= 0) { shockwaves.splice(i, 1); continue; }
    ctx.beginPath();
    ctx.arc(w.x, w.y, w.r, 0, Math.PI * 2);
    ctx.strokeStyle = w.color;
    ctx.globalAlpha = w.life * 0.35;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Particles
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx; p.y += p.vy;
    p.vx *= 0.97; p.vy *= 0.97;
    p.life -= p.decay;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.globalAlpha = p.life;
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Ball
  if (ball && ball.alive) {
    const cs = stars[ball.currentStar];
    const [bc] = colorOf(cs.colorIdx);

    // Velocity arrow — shows direction the next boost will push
    const sp = Math.hypot(ball.vx, ball.vy);
    if (sp > 0.001) {
      const ux = ball.vx / sp;
      const uy = ball.vy / sp;
      const len = 28;
      const ax = ball.x + ux * len;
      const ay = ball.y + uy * len;
      ctx.beginPath();
      ctx.moveTo(ball.x + ux * 9, ball.y + uy * 9);
      ctx.lineTo(ax, ay);
      ctx.strokeStyle = "rgba(255,255,255,0.45)";
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.stroke();
      // arrowhead
      const px = -uy, py = ux;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - ux * 6 + px * 4, ay - uy * 6 + py * 4);
      ctx.lineTo(ax - ux * 6 - px * 4, ay - uy * 6 - py * 4);
      ctx.closePath();
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.fill();
    }

    const g2 = ctx.createRadialGradient(ball.x, ball.y, 0, ball.x, ball.y, 22);
    g2.addColorStop(0, bc + "88");
    g2.addColorStop(1, "transparent");
    ctx.fillStyle = g2;
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, 7, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
  }

  ctx.restore();
}

// ─────────────────────────────────────────────────────────────
// Main loop. Fixed-timestep physics + variable-rate rendering.
// We accumulate elapsed wall-clock time between RAF callbacks
// and run as many PHYSICS_DT_MS-sized physicsTick() calls as
// fit, so the game advances at exactly PHYSICS_HZ regardless of
// monitor refresh rate or RAF irregularity. The accumulator is
// clamped at MAX_FRAME_GAP_MS so a tab switch / debugger pause
// can't queue up a multi-second burst of physics on resume.
// ─────────────────────────────────────────────────────────────
let physicsAccumulator = 0;
let lastFrameTime = performance.now();

function loop() {
  const now = performance.now();
  let elapsed = now - lastFrameTime;
  if (elapsed > MAX_FRAME_GAP_MS) elapsed = MAX_FRAME_GAP_MS;
  lastFrameTime = now;
  physicsAccumulator += elapsed;

  let ticks = 0;
  while (physicsAccumulator >= PHYSICS_DT_MS && ticks < MAX_PHYSICS_PER_FRAME) {
    physicsTick();
    physicsAccumulator -= PHYSICS_DT_MS;
    ticks++;
  }
  // If the cap fired, shed any leftover accumulator so we don't
  // try to "catch up" forever after a long stall.
  if (ticks >= MAX_PHYSICS_PER_FRAME) physicsAccumulator = 0;

  renderTick();
  draw();

  // Advance the replay marker only while the game-over screen is up.
  if (state === STATE.DEAD && replay.length > 0) {
    replayIdx += REPLAY_SPEED;
    if (replayIdx >= replay.length + 30) replayIdx = 0; // brief hold then loop
  }
  requestAnimationFrame(loop);
}
loop();

// ─────────────────────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────────────────────
function handleTap() {
  if (state === STATE.PLAY) boost();
}

document.addEventListener("pointerdown", (e) => {
  const t = e.target;
  if (t.closest("button")) return;
  e.preventDefault();
  handleTap();
});
document.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });
document.addEventListener("gesturestart", (e) => e.preventDefault());

document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" && e.key !== " ") return;
  if (e.repeat) return;
  e.preventDefault();
  if (state === STATE.MENU) {
    document.getElementById("start-btn").click();
  } else if (state === STATE.DEAD) {
    document.getElementById("retry-btn").click();
  } else {
    handleTap();
  }
});

document.getElementById("start-btn").addEventListener("click", (e) => {
  e.preventDefault(); e.stopPropagation();
  document.getElementById("start").classList.add("hidden");
  state = STATE.PLAY;
  init();
});
document.getElementById("retry-btn").addEventListener("click", (e) => {
  e.preventDefault(); e.stopPropagation();
  document.getElementById("gameover").classList.add("hidden");
  state = STATE.PLAY;
  init();
});
