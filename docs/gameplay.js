// All physics + capture logic lives in physics.js (also used by
// the node test runner). All rendering lives in renderer.js
// (WebGL2, browser-only). This file owns DOM, canvas acquisition,
// input, gameplay state, and orchestration. ES modules are strict
// by default.
import * as AC from "./physics.js";
import { createRenderer, c1Of, c2Of } from "./renderer.js";
import { createAudio, simplex2 } from "./audio.js";

// ─────────────────────────────────────────────────────────────
// Canvas + renderer setup
// ─────────────────────────────────────────────────────────────
const canvas = document.getElementById("c");
let renderer = null;
let W = 0, H = 0, DPR = 1;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  if (renderer) renderer.setViewport(W, H, DPR);
}
window.addEventListener("resize", () => {
  resize();
  if (state === STATE.MENU) initMenuStars();
});
resize();
renderer = createRenderer(canvas);
if (!renderer) {
  // No WebGL2 → show the unsupported overlay and abort. The rest
  // of this module still loads (nothing crashes) but the main loop
  // will never actually render anything, and input is a no-op.
  const el = document.getElementById("unsupported");
  if (el) el.classList.remove("hidden");
} else {
  // Viewport wasn't set on the very first resize() because the
  // renderer didn't exist yet — seed it now.
  renderer.setViewport(W, H, DPR);
}

// Procedural sound effects (WebAudio). Lazy-initializes its
// AudioContext on the first play call so we satisfy the browser
// autoplay policy without a visible "enable audio" prompt.
const audio = createAudio();

// Hook up the HUD mute button. Button state reflects the audio
// module's muted flag, which persists to localStorage on toggle.
const muteBtn = document.getElementById("mute-btn");
function syncMuteBtn() {
  if (!muteBtn) return;
  if (audio.isMuted()) muteBtn.classList.add("muted");
  else muteBtn.classList.remove("muted");
}
syncMuteBtn();
if (muteBtn) {
  muteBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    audio.setMuted(!audio.isMuted());
    syncMuteBtn();
  });
}

// HUD reload button — just forces a page reload. Useful when
// stuck, when a visual gets weird, or when the player wants a
// totally fresh state without hunting for the browser refresh.
const reloadBtn = document.getElementById("reload-btn");
if (reloadBtn) {
  reloadBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    location.reload();
  });
}

// Physics constants are imported from physics.js via AC.
const CAPTURE_MULT = AC.CAPTURE_MULT;
const CRASH_MULT = AC.CRASH_MULT;
const INITIAL_ORBIT_MULT = AC.INITIAL_ORBIT_MULT;
const SAFE_SEP = AC.SAFE_SEP;

// View / pacing tunables.
// < 1 means zoom out (more stars visible). Touch devices get a
// slightly wider view so the smaller physical screen doesn't
// feel cramped — matchMedia("(pointer: coarse)") is the correct
// check for "finger, not mouse", not the user-agent string.
const IS_TOUCH = typeof window !== "undefined"
  && window.matchMedia
  && window.matchMedia("(pointer: coarse)").matches;
const ZOOM = IS_TOUCH ? 0.58 : 0.65;
// Vertical focus point — fraction of screen height where the
// current star sits. On portrait (mobile) the star is pushed
// lower so the player sees more upcoming stars above.
const CAM_FOCUS_Y = IS_TOUCH ? 0.62 : 0.55;
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
// Palette — the full RGB data lives in renderer.js as c1Of/c2Of.
// Gameplay only needs the count so it can pick a random colorIdx.
// ─────────────────────────────────────────────────────────────
const PALETTE_LEN = 7;

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

let stars = [];     // {x,y,r,gm,colorIdx,caught,pulse,hasRays,nGran}
let ball = null;    // {x,y,vx,vy,currentStar,alive}
let trail = [];     // [{x,y,r,g,b}]
let particles = []; // [{x,y,vx,vy,life,decay,r,g,b,size}]
let shockwaves = [];// [{x,y,r,mr,life,cr,cg,cb}]
let menuStars = []; // 1–3 decorative animated stars on the welcome screen

// Replay: a samples-per-render-frame log of ball positions during
// the live run, replayed faded behind the game-over overlay so the
// player can watch their last attempt while the AGAIN button sits
// in front of it.
const REPLAY_MAX = 6000;
let replay = [];          // [{x, y, currentStar}, ...]
let replayBounds = null;  // {lastStarIdx} computed once on death
let replayIdx = 0;
// Dynamic replay camera — smooth-follows the marker dot with
// simplex-driven zoom variation for a cinematic replay feel.
let replayCamX = 0;
let replayCamY = 0;
// Replay frames advanced per render frame. Replay was recorded at
// 1 sample/render-frame, so 1 = real-time, 1.75 = ~1.75× fast,
// 2 = 2× fast.
const REPLAY_SPEED = 1.75;

let score = 0;
let starsVisited = 0;
let best = +(localStorage.getItem("astrocatch_best") || 0);
// Tracked ball speed, normalized to [0, 1] against MAX_SPEED,
// fed to audio.setIntensity() each render frame so the music's
// chord progression escalates as the player boosts faster.
// Uses a decay-max tracker: each frame, either bump up to the
// current instantaneous normalized speed (if higher) or decay
// the previous value by SPEED_DECAY. This latches onto peaks
// instead of averaging them away — the EMA approach we tried
// first smoothed away the very boosts that should have been
// driving the intensity upward.
let trackedSpeed = 0;
const SPEED_DECAY = 0.992; // ~1.4 s half-life on a 60 Hz loop
// Fast-launch streak: consecutive captures with a Quick or Blazing
// bonus (i.e. bonus >= 2). Earns a multiplier on the per-capture
// bonus — gentle ramp (half a step per streak increment) so the
// high end stays rewarding without inflating scores to absurd
// levels. Resets on a regular (non-fast) capture and on death.
let fastStreak = 0;
const FAST_STREAK_CAP = 7;
// Streak multiplier applied to the per-capture bonus:
//   streak 0 → ×1  (no active streak)
//   streak 1 → ×1  (first fast capture, unchanged from no-streak)
//   streak 2 → ×1.5
//   streak 3 → ×2
//   streak 4 → ×2.5
//   streak 5 → ×3
//   streak 6 → ×3.5
//   streak 7 → ×4  (cap)
// Shared between captureStar scoring and the HUD so both always
// agree on what "streak" means in user-facing numbers.
function streakMultiplier(streak) {
  return streak >= 1 ? 1 + (streak - 1) * 0.5 : 1;
}
function fmtMult(m) {
  return m === Math.floor(m) ? String(m) : m.toFixed(1);
}
let camY = 0;           // world->screen vertical translation
let camTargetY = 0;
let hasBoosted = false; // for the hint

// ─────────────────────────────────────────────────────────────
// Star generation
// ─────────────────────────────────────────────────────────────
function makeStar(x, y, r, colorIdx, starIdx) {
  const s = {
    x, y, r,
    gm: AC.starGM(r),
    colorIdx,
    caught: false,
    pulse: 0,
    // Visual variety: only ~half the stars get coronal streamers,
    // so the ones that do stand out instead of every star looking
    // identically spiky. The renderer reads these per instance.
    hasRays: Math.random() < 0.5,
    // Per-star granule count in [5, 8]. The coronal streamers
    // (when hasRays is true) reuse this count since each streamer
    // is rooted to a granule in the star fragment shader.
    nGran: 5 + Math.floor(Math.random() * 4),
    // Optional planets — see assignPlanets below. Most stars get
    // none; the ones that do get 1–2. Planets perturb the ship
    // orbit slightly via AC.physicsStep, but have no collision.
    // starIdx < 0 signals "decorative star, never has planets"
    // (used for the welcome-screen menu stars).
    planets: null,
    // Optional comet — see assignComets. A highly eccentric
    // Kepler orbit that's purely visual + a scoring opportunity.
    comets: null,
  };
  if (starIdx !== undefined && starIdx >= 0) {
    assignPlanets(s, starIdx);
    assignComets(s, starIdx);
  }
  return s;
}

// Planet probability ramps linearly from 0% at star 0 to
// PLANET_MAX_PROB at PLANET_RAMP_STARS and beyond. The first
// star never has a planet (probability is exactly 0), the
// ramp is gentle so early captures stay clean, and by the
// time a player has threaded their way through ~30 stars the
// chance levels off at the steady-state rate. Each star that
// passes the probability check gets 1–2 planets. Planets
// orbit the parent at a constant angular velocity (positions
// are a pure function of physics frame) and exert weak
// gravity — ~1.5% of the parent's GM — so the ship wobbles
// noticeably on close passes but the star is always the
// dominant body. Planets have no collision; Plummer softening
// in the physics integrator keeps the 1/r² accel from
// diverging inside the planet, so prediction stays stable
// even on a near-hit.
const PLANET_MAX_PROB = 0.75;
const PLANET_RAMP_STARS = 50;
function assignPlanets(s, starIdx) {
  const ramp = Math.min(1, starIdx / PLANET_RAMP_STARS);
  const probability = ramp * PLANET_MAX_PROB;
  if (Math.random() >= probability) return;
  const nPlanets = 1 + (Math.random() < 0.25 ? 1 : 0);
  const planets = [];
  for (let i = 0; i < nPlanets; i++) {
    // Orbit radius: 1.9–2.8 R of the parent plus a small
    // per-planet stagger, so two planets on the same star
    // don't overlap. That keeps planets inside the ship's
    // likely orbit band so they're visible AND dynamically
    // relevant on most captures.
    const orbitR = s.r * (1.9 + Math.random() * 0.9 + i * 0.4);
    // Period in physics frames. At PHYSICS_HZ = 120 this is
    // roughly 5–12 seconds per revolution — slow enough to
    // feel graceful, fast enough to see movement across one
    // capture's worth of orbit time.
    const periodFrames = 600 + Math.random() * 840;
    const spin = Math.random() < 0.5 ? 1 : -1;
    const planetR = 3 + Math.random() * 3;
    planets.push({
      orbitR,
      omega: spin * (Math.PI * 2) / periodFrames,
      phase: Math.random() * Math.PI * 2,
      radius: planetR,
      colorIdx: Math.floor(Math.random() * PALETTE_LEN),
      // 1.5% of the parent's GM — a perturbation, not a body.
      gm: s.gm * 0.015,
      // Plummer softening length squared. At ~2× planet radius
      // the force is already significantly softened; inside
      // the planet it's effectively capped. No divergence on
      // a direct hit.
      softR2: (planetR * 2) * (planetR * 2),
    });
  }
  s.planets = planets;
}

// ─── Comets ──────────────────────────────────────────────
// ~25% of stars (from index 5+) get a comet — a small body
// on a highly eccentric Kepler orbit around its parent star.
// Comets do NOT affect ship physics at all; they're purely
// visual + a scoring opportunity. The orbit direction is
// chosen by scanning 8 directions to find the biggest gap
// between neighboring stars, so the comet's apoapsis always
// extends into free space rather than toward another star.

// Kepler equation solver: given mean anomaly M and eccentricity
// e, returns eccentric anomaly E via Newton's method. 8
// iterations handles e up to ~0.93 reliably; a convergence
// guard breaks early if |ΔE| < 1e-8 so low-e orbits don't
// waste cycles. Called once per visible comet per render frame
// — negligible cost.
function solveKepler(M, e) {
  let E = M;
  for (let i = 0; i < 8; i++) {
    const dE = (M - E + e * Math.sin(E)) / (1 - e * Math.cos(E));
    E += dE;
    if (Math.abs(dE) < 1e-8) break;
  }
  return E;
}

// Compute a comet's world position from its orbital elements
// and the current physics frame. Pure function — no stored
// state, same answer at the same frame.
function cometPosition(star, comet, frame) {
  const M = (frame * comet.meanMotion + comet.phase) % (Math.PI * 2);
  const E = solveKepler(M, comet.e);
  const cosE = Math.cos(E);
  const r = comet.a * (1 - comet.e * cosE);
  const sqrtFac = Math.sqrt((1 + comet.e) / (1 - comet.e));
  const theta = 2 * Math.atan2(
    sqrtFac * Math.sin(E / 2),
    Math.cos(E / 2)
  );
  const xOrb = r * Math.cos(theta);
  const yOrb = r * Math.sin(theta);
  const cw = Math.cos(comet.omega);
  const sw = Math.sin(comet.omega);
  return {
    x: star.x + xOrb * cw - yOrb * sw,
    y: star.y + xOrb * sw + yOrb * cw,
    r, // orbital radius — used for coma activity calculation
  };
}

const COMET_SCORE_RADIUS = 22; // px — close-pass threshold
const COMET_BONUS = 2;

function assignComets(s, starIdx) {
  if (starIdx < 2) return; // no comets on the first two stars
  if (Math.random() > 0.25) return;

  // Scan 8 directions to find the one with the most room — the
  // deepest gap between neighboring stars. That's where the
  // comet's apoapsis will extend. A 60° half-cone per sample
  // gives overlapping coverage of the full circle.
  const NUM_DIRS = 8;
  const CONE_HALF = Math.PI / 3;
  let bestAngle = 0;
  let bestClearance = 0;
  for (let d = 0; d < NUM_DIRS; d++) {
    const angle = d * Math.PI * 2 / NUM_DIRS;
    const ax = Math.cos(angle);
    const ay = Math.sin(angle);
    let minInCone = 9999;
    for (let k = 0; k < stars.length; k++) {
      const dx = stars[k].x - s.x;
      const dy = stars[k].y - s.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 1) continue;
      const dot = (dx * ax + dy * ay) / dist;
      if (dot > Math.cos(CONE_HALF) && dist < minInCone) {
        minInCone = dist;
      }
    }
    if (minInCone > bestClearance) {
      bestClearance = minInCone;
      bestAngle = angle;
    }
  }

  // Apoapsis extends into the best direction, capped at 45% of
  // the clearance (or 600 px hard cap). Periapsis just outside
  // the star's visual disk. Require apo:peri > 2.5 for a
  // properly eccentric orbit — if no direction has enough room,
  // skip the comet rather than drawing a near-circular one.
  const maxApo = Math.min(bestClearance * 0.45, 600);
  const peri = s.r * (1.05 + Math.random() * 0.2);
  if (maxApo < peri * 2.5) return; // not eccentric enough

  const a = (maxApo + peri) / 2;
  const e = (maxApo - peri) / (maxApo + peri);

  // omega: apoapsis at bestAngle → omega = bestAngle - π,
  // plus a small random spread.
  const omega = bestAngle - Math.PI + (Math.random() - 0.5) * 0.3;
  // Period via Kepler's third law in physics-frame units.
  const T = Math.PI * 2 * Math.sqrt(a * a * a / s.gm);
  s.comets = [{
    a,
    e,
    omega,
    meanMotion: (Math.PI * 2) / T,
    phase: Math.random() * Math.PI * 2,
    radius: 2 + Math.random() * 2,
    tailLength: 25 + Math.random() * 25,
    // 1–3 syndynes (dust-size populations) per comet. More
    // syndynes = wider, richer fan-shaped tail. Fewer = a
    // thinner, simpler streak.
    numSyndynes: 1 + Math.floor(Math.random() * 3),
    scored: false,
  }];
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
      stars.push(makeStar(nx, ny, r, n, n));
      return;
    }
  }

  // Fallback: straight up at a safely large distance.
  const fx = Math.max(80, Math.min(W - 80, prev.x));
  const fy = prev.y - hardMin * 1.4;
  stars.push(makeStar(fx, fy, r, n, n));
}

// ─────────────────────────────────────────────────────────────
// Init / reset
// ─────────────────────────────────────────────────────────────
// The parallax background starfield lives entirely inside
// renderer.js — it's generated once per setViewport and drawn
// via the circle program with per-instance depth + twinkle.
// Nothing gameplay-side to maintain.

// 1–3 decorative stars scattered around the welcome overlay.
// They use the same makeStar() shape as gameplay stars, so they
// animate identically through the same WebGL `star` shader —
// corona, streamers, granules, pulse, all live. Positions avoid
// a rectangle centered on the overlay text so the glow doesn't
// fight the title/button.
function initMenuStars() {
  menuStars = [];
  const n = 1 + Math.floor(Math.random() * 3); // 1..3
  const margin = 100;
  // Rough text-block exclusion zone (matches overlay content).
  const cx = W / 2;
  const cy = H / 2;
  const exclHalfW = 230;
  const exclHalfH = 210;
  for (let i = 0; i < n; i++) {
    const r = 24 + Math.random() * 26;
    let x = 0, y = 0;
    let placed = false;
    for (let tries = 0; tries < 40; tries++) {
      x = margin + Math.random() * (W - 2 * margin);
      y = margin + Math.random() * (H - 2 * margin);
      if (Math.abs(x - cx) < exclHalfW && Math.abs(y - cy) < exclHalfH) continue;
      // Keep menu stars from clumping into each other's halos.
      let ok = true;
      for (const m of menuStars) {
        const dx = m.x - x, dy = m.y - y;
        if (Math.hypot(dx, dy) < (m.r + r) * 4) { ok = false; break; }
      }
      if (!ok) continue;
      placed = true;
      break;
    }
    if (!placed) continue;
    menuStars.push(makeStar(x, y, r, Math.floor(Math.random() * PALETTE_LEN)));
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
  fastStreak = 0;
  trackedSpeed = 0;
  camY = 0;
  camTargetY = 0;
  hasBoosted = false;

  // First star, centered-ish, low on screen
  stars.push(makeStar(W / 2, H * 0.7, 44, 0, 0));
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
    // Monotonic physics frame counter, incremented inside
    // AC.physicsStep. Shared between live physics and the
    // prediction integrator so planet positions at the same
    // simulated moment agree exactly, which is what keeps the
    // "clean capture never crashes" invariant intact under
    // planet gravity perturbation.
    frame: 0,
  };

  document.getElementById("score").textContent = "0";
  updateSub();
  document.getElementById("score-display").style.display = "block";
  document.getElementById("hint").classList.add("on");
  // Fire up the generative music layer. Scheduler runs until
  // die() turns it back off. Idempotent — calling startMusic
  // again mid-run is a no-op.
  audio.startMusic();
}

function updateSub() {
  let text = "best " + best + " · " + starsVisited + " stars";
  if (fastStreak >= 2) {
    text += " · streak ×" + fmtMult(streakMultiplier(fastStreak));
  }
  document.getElementById("sub").textContent = text;
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

  // Strip planets from the star we're leaving. Past stars no
  // longer contribute to gravity or render — the ship never
  // orbits back to them, so their planetary systems can be
  // discarded. computePlanetPositions and the draw loop both
  // short-circuit on a null `planets` field.
  const leavingIdx = ball.currentStar;
  if (leavingIdx !== idx && stars[leavingIdx]) {
    stars[leavingIdx].planets = null;
    stars[leavingIdx].comets = null;
  }

  s.caught = true;
  s.pulse = 1;
  ball.currentStar = idx;
  // Apply the quick-launch bonus that was locked in at boost time.
  const bonus = ball.pendingBonus || 1;
  // Fast-launch streak — consecutive Quick/Blazing captures stack
  // a multiplier on top of the per-capture bonus (see
  // streakMultiplier comment block for the ramp). A regular
  // (non-fast) capture breaks the streak. Earned score is always
  // rounded to an integer so players see whole numbers tick up.
  if (bonus >= 2) {
    fastStreak = Math.min(fastStreak + 1, FAST_STREAK_CAP);
  } else {
    fastStreak = 0;
  }
  const streakMult = streakMultiplier(fastStreak);
  score += Math.round(bonus * streakMult);
  starsVisited += 1;
  // Reset orbit timer + bonus for the new orbit.
  ball.framesInOrbit = 0;
  ball.pendingBonus = 1;
  audio.capture(bonus, fastStreak);
  updateScoreUI(true, bonus, fastStreak);

  // Visuals. Colors go into particle / shockwave storage as RGB
  // floats in [0, 1]; the WebGL renderer reads them straight into
  // instance attributes.
  const c1 = c1Of(s.colorIdx);
  const c2 = c2Of(s.colorIdx);
  shockwaves.push({
    x: s.x, y: s.y, r: 0, mr: 90, life: 1,
    cr: c1[0], cg: c1[1], cb: c1[2],
  });
  for (let i = 0; i < 18; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 1.5 + Math.random() * 3.5;
    const c = Math.random() > 0.5 ? c1 : c2;
    particles.push({
      x: s.x, y: s.y,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      life: 1, decay: 0.018 + Math.random() * 0.018,
      r: c[0], g: c[1], b: c[2],
      size: 2 + Math.random() * 3,
    });
  }

  // Camera follow
  camTargetY = -(s.y - H * CAM_FOCUS_Y);

  // Keep the star buffer populated
  while (stars.length < idx + 8) addNextStar();
}

function updateScoreUI(bump, bonus, streak) {
  const el = document.getElementById("score");
  el.textContent = score;
  updateSub();
  if (bump) {
    const scale = bonus >= 3 ? 1.35 : bonus >= 2 ? 1.25 : 1.15;
    el.style.transform = "scale(" + scale + ")";
    setTimeout(() => (el.style.transform = "scale(1)"), 100);
  }
  if (bonus && bonus > 1) {
    showBonusFlash(bonus, streak);
  }
}

function showBonusFlash(bonus, streak) {
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
  let text = (bonus >= 3 ? "★ BLAZING " : "QUICK ") + "×" + bonus;
  if (streak >= 2) text += " · STREAK ×" + fmtMult(streakMultiplier(streak));
  el.textContent = text;
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

function showCometFlash() {
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
  el.textContent = "COMET +" + COMET_BONUS;
  el.style.color = "#58e0fb";
  el.style.opacity = "1";
  el.style.transform = "translateY(0) scale(1.1)";
  void el.offsetWidth;
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateY(-30px) scale(1)";
  }, 350);
}

// ─────────────────────────────────────────────────────────────
// Boost: prograde impulse + capture-prediction. AC.applyBoostAndArm
// applies the impulse, runs the prediction, and (on success) sets
// up pendingCapture so AC.burnStep can fire at the actual periapsis.
// ─────────────────────────────────────────────────────────────
function boost() {
  if (!ball || !ball.alive) return;
  if (ball.pendingCapture >= 0) return;

  audio.boost();

  // Exhaust particles (visual only — record direction BEFORE the impulse).
  const c1 = c1Of(stars[ball.currentStar].colorIdx);
  for (let i = 0; i < 10; i++) {
    const a = Math.atan2(-ball.vy, -ball.vx) + (Math.random() - 0.5) * 0.7;
    const s2 = 1 + Math.random() * 2.5;
    particles.push({
      x: ball.x, y: ball.y,
      vx: Math.cos(a) * s2, vy: Math.sin(a) * s2,
      life: 1, decay: 0.03 + Math.random() * 0.02,
      r: c1[0], g: c1[1], b: c1[2],
      size: 2 + Math.random() * 2,
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
  audio.death();
  // Music keeps playing through DYING → DEAD → next PLAY.
  // The retry's startMusic() is idempotent, so the loop
  // stitches across runs without a chord jump or seam.
  // Any live fast-launch streak ends with the run.
  fastStreak = 0;
  updateSub();
  // Death burst — magenta (#fa6db0).
  const dR = 0xfa / 255, dG = 0x6d / 255, dB = 0xb0 / 255;
  for (let i = 0; i < 36; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = 1 + Math.random() * 5;
    particles.push({
      x: ball.x, y: ball.y,
      vx: Math.cos(a) * s, vy: Math.sin(a) * s,
      life: 1, decay: 0.012 + Math.random() * 0.015,
      r: dR, g: dG, b: dB,
      size: 2 + Math.random() * 4,
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
  // Sample the trail at the interpolated render position so the
  // trail tip stays glued to the ball visual. Trail is drawn as
  // a single stroked polyline in draw() via the renderer —
  // colors are stored as RGB floats that get passed straight
  // into the shader uniforms.
  const tc = c1Of(cs.colorIdx);
  trail.push({ x: ballRenderX, y: ballRenderY, r: tc[0], g: tc[1], b: tc[2] });
  if (trail.length > 100) trail.shift();

  // Replay sample (only during PLAY, not the DYING wind-down).
  // Same rationale as trail — replay is a render-rate visual.
  if (state === STATE.PLAY) {
    replay.push({ x: ballRenderX, y: ballRenderY, currentStar: ball.currentStar });
    if (replay.length > REPLAY_MAX) replay.shift();
  }

  // Camera: follow upward progress (even while DYING, so the wind-down
  // pan matches the ball's drift).
  const desired = -(stars[ball.currentStar].y - H * CAM_FOCUS_Y);
  if (desired > camTargetY) camTargetY = desired;
  camY += (camTargetY - camY) * 0.08;

  // Off-screen death check — only while still PLAYing.
  if (state === STATE.PLAY) {
    const sy = ball.y + camY;
    const m = 260 / ZOOM;
    if (sy > H + m || sy < -m * 2 || ball.x < -m || ball.x > W + m) die();
  }

  // Feed peak-held ball speed to the music layer so it can
  // escalate the chord progression at high velocity. Decay-
  // max: each frame the tracker either jumps to the current
  // instantaneous speed (if higher) or decays the previous
  // value. Peaks latch, valleys are ignored, so a boost
  // pushes the intensity up immediately and holds it for
  // about a second and a half.
  const rawSpeed = Math.hypot(ball.vx, ball.vy);
  const normalized = Math.min(1, rawSpeed / AC.MAX_SPEED);
  const decayed = trackedSpeed * SPEED_DECAY;
  trackedSpeed = normalized > decayed ? normalized : decayed;
  audio.setIntensity(trackedSpeed);

  // Comet close-pass scoring. Check distance from ball to
  // each active comet on the current + next star. If within
  // COMET_SCORE_RADIUS, award COMET_BONUS points and mark the
  // comet so it doesn't re-award. The comet position uses the
  // same ball.frame as the draw loop so visual and scoring
  // agree on where the comet is.
  if (state === STATE.PLAY) {
    const fr = ball.frame || 0;
    const checkRange = Math.min(stars.length, ball.currentStar + 3);
    for (let i = ball.currentStar; i < checkRange; i++) {
      const s = stars[i];
      if (!s.comets) continue;
      for (let j = 0; j < s.comets.length; j++) {
        const comet = s.comets[j];
        if (comet.scored) continue;
        const cp = cometPosition(s, comet, fr);
        const cdx = ball.x - cp.x;
        const cdy = ball.y - cp.y;
        if (cdx * cdx + cdy * cdy < COMET_SCORE_RADIUS * COMET_SCORE_RADIUS) {
          // Score + HUD flash.
          score += COMET_BONUS;
          updateScoreUI(true, 0, 0);
          showCometFlash();
          audio.comet();
          // Sparkle burst at the comet's position — small
          // bright particles in the star's color, radiating
          // outward. Lighter and smaller than capture particles
          // to feel "celestial" rather than "explosive".
          const cc = c1Of(s.colorIdx);
          for (let p = 0; p < 14; p++) {
            const pa = Math.random() * Math.PI * 2;
            const psp = 1 + Math.random() * 3;
            particles.push({
              x: cp.x, y: cp.y,
              vx: Math.cos(pa) * psp, vy: Math.sin(pa) * psp,
              life: 1, decay: 0.03 + Math.random() * 0.03,
              r: cc[0], g: cc[1], b: cc[2],
              size: 1.5 + Math.random() * 2,
            });
          }
          // Remove the comet from the star entirely — it's
          // been "collected". Break the inner loop since
          // s.comets is now null.
          s.comets = null;
          break;
        }
      }
    }
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
  // We only need lastStarIdx from the bounds now — the dynamic
  // camera in drawReplayGhost does its own zoom/offset per frame.
  const lastIdx = ball ? Math.min(stars.length, ball.currentStar + 2) : stars.length;
  replayBounds = {
    lastStarIdx: lastIdx,
  };
  // Seed the replay camera at the start of the trajectory so
  // the smooth-follow doesn't have to pan from (0, 0).
  replayCamX = replay[0].x;
  replayCamY = replay[0].y;
}

function drawReplayGhost() {
  if (!replayBounds || replay.length < 2) return;
  const b = replayBounds;
  const upTo = Math.min(Math.floor(replayIdx), replay.length - 1);
  if (upTo < 0) return;

  // Current marker position (the "ship").
  const p = replay[upTo];

  // Smooth-follow camera: ease toward the marker. At 60 fps
  // with 0.06 weight, the camera responds in ~300 ms — fast
  // enough to track sharp turns, slow enough to give the
  // replay a cinematic glide instead of a locked follow.
  replayCamX += (p.x - replayCamX) * 0.005;
  replayCamY += (p.y - replayCamY) * 0.005;

  // Simplex-driven zoom variation. The noise makes the camera
  // slowly breathe in and out, giving the replay depth and
  // preventing the "locked zoom" look. Base zoom is slightly
  // wider on mobile so the smaller screen doesn't feel cramped.
  const zoomBase = IS_TOUCH ? 0.42 : 0.52;
  const zoomAmplitude = 0.16;
  const zoomNoise = simplex2(replayIdx * 0.0004, 50.0);
  const currentZoom = zoomBase + zoomNoise * zoomAmplitude;

  // Build a dynamic camera matrix: center at (camX, camY),
  // scale = currentZoom. Reuses renderer.replayMat which
  // wants (scale, ox, oy) where screen = world*scale + offset.
  const scale = currentZoom;
  const ox = -replayCamX * scale + W / 2;
  const oy = -replayCamY * scale + H / 2;
  const mat = renderer.replayMat(scale, ox, oy);

  // Star markers: halo + center for each star the trajectory
  // passed. Most will be off-screen with the close follow
  // camera, but the GPU culls them at rasterization so no
  // performance hit from submitting the full list.
  if (b.lastStarIdx > 0) {
    const markers = [];
    for (let i = 0; i < b.lastStarIdx; i++) {
      const s = stars[i];
      const c = c1Of(s.colorIdx);
      markers.push({
        x: s.x, y: s.y,
        outerR: s.r * 1.8, innerR: 0,
        r: c[0], g: c[1], b: c[2],
        a: 0.55, kind: 2,
      });
      markers.push({
        x: s.x, y: s.y,
        outerR: s.r * 0.7, innerR: 0,
        r: c[0], g: c[1], b: c[2],
        a: 0.9, kind: 0,
      });
    }
    renderer.drawCircleBatch(markers, mat);
  }

  // Trajectory polyline — capped to a trailing window of 2000
  // points instead of the full replay. The close-follow camera
  // only shows a portion of the trajectory at any zoom, so
  // rendering all 6000 points would waste vertex work and
  // allocate a large slice array every frame for no visible
  // gain.
  if (upTo > 1) {
    const headA = 0.85;
    const head = [0.63 * headA, 0.86 * headA, 1.0 * headA, headA];
    const tail = [0, 0, 0, 0];
    const trailStart = Math.max(0, upTo - 2000);
    const points = replay.slice(trailStart, upTo + 1);
    renderer.drawPolyline(points, mat, 0.8 / scale, tail, head);
  }

  // Marker dot — white glow + core, sized relative to current
  // zoom so the dot stays a constant screen size.
  const dotR = 5 / scale;
  renderer.drawCircleBatch([
    { x: p.x, y: p.y, outerR: dotR * 4, innerR: 0, r: 1, g: 1, b: 1, a: 0.9, kind: 2 },
    { x: p.x, y: p.y, outerR: dotR, innerR: 0, r: 1, g: 1, b: 1, a: 1.0, kind: 0 },
  ], mat);
}

// Star rendering lives in the `star` shader program in renderer.js.
// This file no longer touches the canvas pixel-by-pixel — it just
// orchestrates the game state and hands arrays off to the renderer.

// ─────────────────────────────────────────────────────────────
// Drawing — this is entirely orchestration now. All actual pixel
// work happens in renderer.js (WebGL2). draw() advances per-entity
// state (particle positions, shockwave radii, star pulse decay)
// while building the instance batches the renderer consumes.
// ─────────────────────────────────────────────────────────────
function draw() {
  if (!renderer) return;
  const nowSec = performance.now() / 1000;
  renderer.beginFrame(nowSec);
  renderer.drawBackground(camY);
  renderer.drawBgStars();

  // MENU: only the decorative welcome-screen stars, in screen space.
  if (state === STATE.MENU) {
    if (menuStars.length) {
      const menuBatch = menuStars.map((s) => ({
        x: s.x, y: s.y, r: s.r,
        colorIdx: s.colorIdx, pulse: 0,
        hasRays: s.hasRays, nGran: s.nGran,
        isCurrent: false, isNext: false, isPast: false,
      }));
      renderer.drawStarBatch(menuBatch, renderer.screenMat());
    }
    return;
  }

  // DEAD: faded ghost replay of the run.
  if (state === STATE.DEAD && replayBounds) {
    drawReplayGhost();
    return;
  }

  // PLAY / DYING: gameplay world. Build the world-to-clip matrix.
  const cam = renderer.cameraMat(camY, ZOOM, CAM_FOCUS_Y);

  // Connector hints — faint lines from the current star through
  // the next few upcoming stars. Sent as disconnected 2-point
  // polyline segments.
  if (state === STATE.PLAY && ball) {
    const cs = ball.currentStar;
    const lastIdx = Math.min(stars.length - 1, cs + 5);
    if (lastIdx > cs) {
      const segs = [];
      for (let i = cs; i < lastIdx; i++) {
        segs.push([
          { x: stars[i].x, y: stars[i].y },
          { x: stars[i + 1].x, y: stars[i + 1].y },
        ]);
      }
      const col = [0.035, 0.035, 0.035, 0.035];
      renderer.drawSegments(segs, cam, 1 / ZOOM, col, col);
    }
  }

  // Trail — single stroked polyline. Half-width 1.2 world units;
  // at ZOOM 0.65 that's ≈ 1.6 px per side, 3.2 px total on screen.
  // Alpha baked into colors so the renderer passes it straight
  // through as uniforms.
  if (trail.length > 1) {
    const last = trail[trail.length - 1];
    const headA = 0.55;
    const head = [last.r * headA, last.g * headA, last.b * headA, headA];
    const tail = [0, 0, 0, 0];
    renderer.drawPolyline(trail, cam, 1.3, tail, head);
  }

  // Active stars — frustum-cull against the camera vertical band,
  // decay catch pulses, tag role flags, build the instance batch.
  const starBatch = [];
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i];
    const sY = s.y + camY;
    if (sY < -240 || sY > H + 240) continue;
    if (s.pulse > 0) s.pulse -= 0.03;
    const isCurrent = ball && i === ball.currentStar;
    const isNext = ball && i === ball.currentStar + 1;
    const isPast = s.caught && !isCurrent;
    starBatch.push({
      x: s.x, y: s.y, r: s.r,
      colorIdx: s.colorIdx, pulse: s.pulse,
      hasRays: s.hasRays, nGran: s.nGran,
      isCurrent, isNext, isPast,
    });
  }
  if (starBatch.length) renderer.drawStarBatch(starBatch, cam);

  // Planets — rendered at their current physics frame so their
  // visual position exactly matches what the physics integrator
  // sees. Each planet is a glow halo + a solid core, pushed
  // through the circle program. A faint orbital ring is also
  // drawn to suggest the path. Planets are cosmetic-plus-gravity:
  // the ship flies through them and does NOT crash.
  const frame = ball ? (ball.frame || 0) : 0;
  const planetBatch = [];
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i];
    if (!s.planets) continue;
    const sY = s.y + camY;
    if (sY < -260 || sY > H + 260) continue;
    for (let j = 0; j < s.planets.length; j++) {
      const p = s.planets[j];
      const angle = frame * p.omega + p.phase;
      const px = s.x + Math.cos(angle) * p.orbitR;
      const py = s.y + Math.sin(angle) * p.orbitR;
      const c = c1Of(p.colorIdx);
      // Faint glow halo.
      planetBatch.push({
        x: px, y: py,
        outerR: p.radius * 2.4,
        innerR: 0,
        r: c[0], g: c[1], b: c[2],
        a: 0.28,
        kind: 2,
      });
      // Solid core.
      planetBatch.push({
        x: px, y: py,
        outerR: p.radius,
        innerR: 0,
        r: c[0], g: c[1], b: c[2],
        a: 0.95,
        kind: 0,
      });
    }
  }
  if (planetBatch.length) renderer.drawCircleBatch(planetBatch, cam);

  // Comets — eccentric Kepler orbits with a fading particle
  // trail. Each trail particle is a past orbital position
  // computed by solving the Kepler equation at (frame - t*step),
  // so the trail naturally follows the comet's curved path and
  // stretches at periapsis (fast) / compresses at apoapsis
  // (slow), matching real dust-tail behavior. 20 samples at 6
  // physics-frame intervals ≈ 1 second of trail. Rendered as
  // glow circles that shrink and fade, batched into a single
  // drawCircleBatch call per comet.
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i];
    if (!s.comets) continue;
    const sY = s.y + camY;
    if (sY < -400 || sY > H + 400) continue;
    const sc = c1Of(s.colorIdx);
    for (let j = 0; j < s.comets.length; j++) {
      const comet = s.comets[j];
      const pos = cometPosition(s, comet, frame);
      const cometBatch = [];

      // Coma activity — 0 at apoapsis (inactive), 1 at
      // periapsis (maximum outgassing). Drives the glow size
      // and the particle spawn rate below.
      const periDist = comet.a * (1 - comet.e);
      const apoDist = comet.a * (1 + comet.e);
      const activity = Math.max(0, 1 - (pos.r - periDist) / (apoDist - periDist));

      // Multi-syndyne dust tail — three layers at different
      // radiation-pressure strengths (β values), creating a
      // fan-shaped tail. Real dust tails are a continuous fan
      // of syndynes (one per particle size); three discrete
      // layers approximate the visual width:
      //   narrow (low β, large dust)  → close to orbital path
      //   medium (mid β)              → the main visible tail
      //   wide   (high β, fine dust)  → faint outer fan
      // Past orbital positions are computed once and reused
      // across all three layers.
      const TRAIL_N = 20;
      const TRAIL_STEP = 6;
      const BASE_WIND = 3.0;
      const ALL_SYNDYNES = [
        { wm: 0.4, al: 0.3 },   // narrow — large particles
        { wm: 1.0, al: 0.5 },   // middle — main tail
        { wm: 1.8, al: 0.22 },  // wide — fine dust
      ];
      // Each comet has 1–3 syndynes (set at creation). 1 = thin
      // streak, 2 = main + one wing, 3 = full fan.
      const nSyn = Math.min(comet.numSyndynes || 1, ALL_SYNDYNES.length);
      const SYNDYNES = nSyn === 1
        ? [ALL_SYNDYNES[1]]                           // just the main
        : nSyn === 2
          ? [ALL_SYNDYNES[0], ALL_SYNDYNES[1]]        // narrow + main
          : ALL_SYNDYNES;                              // full fan
      const pastPos = [];
      for (let t = TRAIL_N - 1; t >= 1; t--) {
        const pp = cometPosition(s, comet, frame - t * TRAIL_STEP);
        const wdx = pp.x - s.x;
        const wdy = pp.y - s.y;
        const wd = Math.hypot(wdx, wdy) || 1;
        pastPos.push({ t, px: pp.x, py: pp.y, nx: wdx / wd, ny: wdy / wd });
      }
      for (let syn = 0; syn < SYNDYNES.length; syn++) {
        const wind = BASE_WIND * SYNDYNES[syn].wm;
        const synAlpha = SYNDYNES[syn].al;
        for (let k = 0; k < pastPos.length; k++) {
          const { t, px, py, nx, ny } = pastPos[k];
          const fade = 1 - t / TRAIL_N;
          const pr = comet.radius * (0.4 + 0.6 * fade);
          cometBatch.push({
            x: px + nx * t * wind,
            y: py + ny * t * wind,
            outerR: pr * 2.8, innerR: 0,
            r: sc[0] * fade, g: sc[1] * fade, b: sc[2] * fade,
            a: fade * synAlpha,
            kind: 2,
          });
        }
      }

      // Coma glow — grows near periapsis as the comet
      // outgasses, absent at apoapsis. Modulates the
      // existing core glow's radius and alpha.
      const comaR = comet.radius * (3 + activity * 8);
      const comaA = 0.2 + activity * 0.5;
      cometBatch.push({
        x: pos.x, y: pos.y,
        outerR: comaR, innerR: 0,
        r: sc[0], g: sc[1], b: sc[2], a: comaA, kind: 2,
      });
      // Bright white core.
      cometBatch.push({
        x: pos.x, y: pos.y,
        outerR: comet.radius, innerR: 0,
        r: 1, g: 1, b: 1, a: 1, kind: 0,
      });

      // Sparse outgassing particles near periapsis — spawned
      // in world space so they linger where the comet WAS,
      // creating a natural gas wake behind the fast-moving
      // nucleus. Each particle gets a radial-outward velocity
      // push (solar wind / radiation pressure) plus small
      // random scatter, so the wake drifts anti-sunward over
      // its lifetime — matching how real outgassed material
      // behaves. Uses the existing particles array + render.
      if (activity > 0.4 && state === STATE.PLAY) {
        const spawnChance = activity * 1.5;
        if (Math.random() < spawnChance) {
          const rdx = pos.x - s.x;
          const rdy = pos.y - s.y;
          const rd = Math.hypot(rdx, rdy) || 1;
          const windVx = (rdx / rd) * 0.5;
          const windVy = (rdy / rd) * 0.5;
          particles.push({
            x: pos.x + (Math.random() - 0.5) * comet.radius * 3,
            y: pos.y + (Math.random() - 0.5) * comet.radius * 3,
            vx: (Math.random() - 0.5) * 0.3 + windVx,
            vy: (Math.random() - 0.5) * 0.3 + windVy,
            life: 1, decay: 0.008 + Math.random() * 0.007,
            r: sc[0] * 0.7, g: sc[1] * 0.7, b: sc[2] * 0.7,
            size: 1 + Math.random() * 1.5,
          });
        }
      }
      renderer.drawCircleBatch(cometBatch, cam);
    }
  }

  // Dashed hint ring around the next star — drawn via the circle
  // program with kind=3.
  if (ball && ball.currentStar + 1 < stars.length) {
    const nx = stars[ball.currentStar + 1];
    const ringR = nx.r * CAPTURE_MULT;
    // Slight alpha pulse so the hint ring draws the eye without
    // being distracting — roughly 0.14..0.26 over a ~2.6 s period.
    const pulse = 0.85 + 0.30 * Math.sin(nowSec * 2.4);
    renderer.drawCircleBatch([{
      x: nx.x, y: nx.y,
      outerR: ringR + 1.1,
      innerR: ringR - 1.1,
      r: 1, g: 1, b: 1, a: 0.20 * pulse,
      kind: 3,
    }], cam);
  }

  // Shockwaves — advance state and collect into a circle batch
  // (kind=1 ring). lineWidth becomes an inner/outer radius gap.
  const shockBatch = [];
  for (let i = shockwaves.length - 1; i >= 0; i--) {
    const w = shockwaves[i];
    w.r += 3;
    w.life -= 0.03;
    if (w.life <= 0) { shockwaves.splice(i, 1); continue; }
    const wA = w.life * 0.35;
    shockBatch.push({
      x: w.x, y: w.y,
      outerR: w.r + 1.4,
      innerR: Math.max(0, w.r - 1.4),
      r: w.cr, g: w.cg, b: w.cb, a: wA,
      kind: 1,
    });
  }
  if (shockBatch.length) renderer.drawCircleBatch(shockBatch, cam);

  // Particles — advance state and collect into a circle batch.
  const partBatch = [];
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx; p.y += p.vy;
    p.vx *= 0.97; p.vy *= 0.97;
    p.life -= p.decay;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    partBatch.push({
      x: p.x, y: p.y,
      outerR: Math.max(0.5, p.size * p.life),
      innerR: 0,
      r: p.r, g: p.g, b: p.b, a: p.life,
      kind: 0,
    });
  }
  if (partBatch.length) renderer.drawCircleBatch(partBatch, cam);

  // Ball: velocity arrow + glow halo + bright core. Velocity uses
  // the raw physics velocity so direction reacts instantly to a
  // boost; position uses the interpolated render coords.
  if (ball && ball.alive) {
    const cs = stars[ball.currentStar];
    const bc = c1Of(cs.colorIdx);
    const bx = ballRenderX;
    const by = ballRenderY;

    const sp = Math.hypot(ball.vx, ball.vy);
    if (sp > 0.001) {
      const ux = ball.vx / sp;
      const uy = ball.vy / sp;
      const p0 = { x: bx + ux * 9,  y: by + uy * 9 };
      const p1 = { x: bx + ux * 28, y: by + uy * 28 };
      const tail = [0, 0, 0, 0];
      const head = [0.45, 0.45, 0.45, 0.45];
      renderer.drawPolyline([p0, p1], cam, 1.3, tail, head);
    }

    // Ball rendering: glow halo + solid white core + velocity tip dot
    // (when direction is valid). All in one circle batch.
    const ballBatch = [
      // Glow halo
      { x: bx, y: by, outerR: 22, innerR: 0, r: bc[0], g: bc[1], b: bc[2], a: 0.53, kind: 2 },
      // Solid core
      { x: bx, y: by, outerR: 7, innerR: 0, r: 1, g: 1, b: 1, a: 1, kind: 0 },
    ];
    if (sp > 0.001) {
      const ux = ball.vx / sp;
      const uy = ball.vy / sp;
      ballBatch.push({
        x: bx + ux * 28, y: by + uy * 28,
        outerR: 3.5, innerR: 0,
        r: 1, g: 1, b: 1, a: 0.6, kind: 0,
      });
    }
    renderer.drawCircleBatch(ballBatch, cam);
  }
}

// ─────────────────────────────────────────────────────────────
// Main loop. Fixed-timestep physics + variable-rate rendering.
// We accumulate elapsed wall-clock time between RAF callbacks
// and run as many PHYSICS_DT_MS-sized physicsTick() calls as
// fit, so the game advances at exactly PHYSICS_HZ regardless of
// monitor refresh rate or RAF irregularity. The accumulator is
// clamped at MAX_FRAME_GAP_MS so a tab switch / debugger pause
// can't queue up a multi-second burst of physics on resume.
//
// Two things about this loop matter for mobile smoothness:
//
//   1. Use the RAF-provided timestamp, NOT performance.now().
//      The RAF timestamp is aligned to the frame the browser is
//      preparing; performance.now() gives the moment the JS
//      callback actually ran, which jitters relative to vsync
//      (especially on mobile after compositor handoff). That
//      jitter poisons `elapsed` and makes a steady 60 Hz display
//      fire 1 / 2 / 3 physics ticks per frame in an uneven
//      pattern. At 120 Hz physics / 60 Hz rendering that reads
//      as visible stutter even though the display is solid.
//
//   2. Render interpolation between the two most recent physics
//      states. A fixed-step sim committed in discrete chunks
//      only happens to produce the same number of ticks per
//      frame when the accumulator grid aligns with the refresh
//      grid, which it rarely does for long. Lerping the rendered
//      ball position by `alpha = accumulator / PHYSICS_DT_MS`
//      makes the visual advance at display rate regardless, and
//      is the standard Glenn-Fiedler "Fix Your Timestep" fix.
// ─────────────────────────────────────────────────────────────
let physicsAccumulator = 0;
// Sentinel: set on the first RAF callback so we don't compute
// a bogus elapsed from module-load time to first vsync.
let lastFrameTime = -1;
// Interpolated render position for the ball. Equal to ball.x/y
// only at alpha = 1 (end of a physics tick); otherwise lerped
// between the state before the most recent tick and the current
// state. draw() and renderTick() use these for anything visual.
let ballRenderX = 0, ballRenderY = 0;

function loop(rafTime) {
  if (lastFrameTime < 0) lastFrameTime = rafTime;
  let elapsed = rafTime - lastFrameTime;
  if (elapsed > MAX_FRAME_GAP_MS) elapsed = MAX_FRAME_GAP_MS;
  if (elapsed < 0) elapsed = 0;
  lastFrameTime = rafTime;
  physicsAccumulator += elapsed;

  // Track the ball's pre-tick position so we can interpolate
  // between the two most recent physics states after the tick
  // loop finishes. Only the LAST saved prev matters — with 2
  // ticks per frame, that's one tick's worth of sim time.
  let ballPrevX = ball ? ball.x : 0;
  let ballPrevY = ball ? ball.y : 0;
  let ticks = 0;
  while (physicsAccumulator >= PHYSICS_DT_MS && ticks < MAX_PHYSICS_PER_FRAME) {
    if (ball) { ballPrevX = ball.x; ballPrevY = ball.y; }
    physicsTick();
    physicsAccumulator -= PHYSICS_DT_MS;
    ticks++;
  }
  // If the cap fired, shed any leftover accumulator so we don't
  // try to "catch up" forever after a long stall.
  if (ticks >= MAX_PHYSICS_PER_FRAME) physicsAccumulator = 0;

  // Render-position lerp. alpha ∈ [0, 1). At alpha=0 we're right
  // after a tick (draw the pre-tick state); at alpha→1 we're
  // about to commit the next tick (draw the current state). The
  // visual glides smoothly across the sim grid instead of
  // snapping once per tick.
  if (ball) {
    const alpha = physicsAccumulator / PHYSICS_DT_MS;
    ballRenderX = ballPrevX + (ball.x - ballPrevX) * alpha;
    ballRenderY = ballPrevY + (ball.y - ballPrevY) * alpha;
  }

  renderTick();
  draw();

  // Advance the replay marker only while the game-over screen is up.
  if (state === STATE.DEAD && replay.length > 0) {
    replayIdx += REPLAY_SPEED;
    if (replayIdx >= replay.length + 30) replayIdx = 0; // brief hold then loop
  }
  requestAnimationFrame(loop);
}
// Populate the welcome-screen menu stars before the first draw.
// All top-level `let` declarations have run by this point, so
// initMenuStars can touch menuStars without TDZ issues. The
// renderer seeds its own parallax bgStars inside setViewport().
initMenuStars();
// Kick off via RAF. Do NOT call loop() synchronously — the first
// elapsed needs to be measured against a real vsync timestamp
// (see the sentinel in loop()), and any catchup ticks fired
// from module-load time would run before init() has a ball.
requestAnimationFrame(loop);

// ─────────────────────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────────────────────
function handleTap() {
  if (state === STATE.PLAY) boost();
}

// All three of these preventDefaults are scoped to gameplay.
// On the start / game-over screens we let the browser handle
// touches normally so pull-to-refresh (and any other native
// gesture) still works. touch-action on body + canvas already
// permits the pan gesture at the CSS layer; these handlers
// just need to stop swallowing it at the JS layer.
document.addEventListener("pointerdown", (e) => {
  const t = e.target;
  if (t.closest("button")) return;
  if (state !== STATE.PLAY) return;
  e.preventDefault();
  handleTap();
});
document.addEventListener("touchmove", (e) => {
  if (state !== STATE.PLAY && state !== STATE.DYING) return;
  e.preventDefault();
}, { passive: false });
document.addEventListener("gesturestart", (e) => {
  if (state !== STATE.PLAY && state !== STATE.DYING) return;
  e.preventDefault();
});

document.addEventListener("keydown", (e) => {
  // M toggles the mute state across all states. It never
  // interacts with gameplay, so it's safe to handle anywhere.
  if (e.key === "m" || e.key === "M") {
    if (e.repeat) return;
    e.preventDefault();
    audio.setMuted(!audio.isMuted());
    syncMuteBtn();
    return;
  }
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
