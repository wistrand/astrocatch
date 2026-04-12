// Pure physics for ASTROCATCH. No DOM, no canvas — runnable in
// node for tests and imported by the browser as an ES module.
// ES modules are strict by default, so no "use strict" needed.

// ── Constants ────────────────────────────────────────────────
const G = 1;
const STAR_GM_PER_PX = 14;         // GM = 14 * visualRadius
const INITIAL_ORBIT_MULT = 2.0;    // ball starts at 2R from star
const CAPTURE_MULT = 2.8;          // capture radius = 2.8R
const CRASH_MULT = 1.05;           // crash if within 1.05R
const MAX_SPEED = 16;
const MIN_PERI_MULT = 1.5;         // refuse predictions whose peri is below 1.5 R
const MAX_PERI_MULT = 5.0;         // absolute cap on peri/R (sanity)
const PERI_VORONOI_FRAC = 0.45;    // peri must be ≤ this × distance-to-nearest-other-star
const PERI_HYSTERESIS = 0.4;       // px past minD before we declare periapsis passed
const TRANSFER_TIMEOUT = 800;      // abandon a pending capture after this many frames
const SAFE_SEP = 2 * CAPTURE_MULT + 0.4;
const PREDICT_MAX_FRAMES = 600;

// ── Helpers ──────────────────────────────────────────────────
function starGM(visR) { return G * STAR_GM_PER_PX * visR; }
function circularV(GM, r) { return Math.sqrt(GM / r); }

function nearestStarIdx(stars, px, py) {
  let best = 0, bestD2 = Infinity;
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i];
    const dx = s.x - px, dy = s.y - py;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = i; }
  }
  return best;
}

function accelAt(stars, px, py) {
  const s = stars[nearestStarIdx(stars, px, py)];
  const dx = s.x - px, dy = s.y - py;
  const r2 = dx * dx + dy * dy;
  if (r2 < 1) return [0, 0];
  const r = Math.sqrt(r2);
  const a = s.gm / (r2 * r);
  return [a * dx, a * dy];
}

// Acceleration from a KNOWN star — skips the nearest-star scan,
// letting the integrator hot-loop reuse a single primary cached
// at the start of the frame.
function accelFromStar(s, px, py) {
  const dx = s.x - px, dy = s.y - py;
  const r2 = dx * dx + dy * dy;
  if (r2 < 1) return [0, 0];
  const r = Math.sqrt(r2);
  const a = s.gm / (r2 * r);
  return [a * dx, a * dy];
}

// Compute a primary star's planet positions for a single
// physics frame. Planets orbit at a constant angular velocity
// around their parent, so their position is a pure function of
// (star, planet, frame) — no stored state, and the same call
// at the same frame produces the same answer. Returns null if
// the star has no planets, so the hot loop can short-circuit.
// Reused across all sub-steps within one physicsStep because
// frame doesn't advance between sub-steps.
function computePlanetPositions(star, frame) {
  const planets = star.planets;
  if (!planets || planets.length === 0) return null;
  const out = new Array(planets.length);
  for (let i = 0; i < planets.length; i++) {
    const p = planets[i];
    const angle = frame * p.omega + p.phase;
    out[i] = {
      x: star.x + Math.cos(angle) * p.orbitR,
      y: star.y + Math.sin(angle) * p.orbitR,
      gm: p.gm,
      softR2: p.softR2,
    };
  }
  return out;
}

// Acceleration from a known primary star PLUS the small
// perturbation from each of its orbiting planets. Planet
// gravity uses Plummer softening (ε² added to r² before the
// 1/r³ term) so the ship can fly through a planet without the
// force diverging — planets have no collision, they're pure
// gravity sources. If there are no planets the loop is
// skipped entirely and the result matches accelFromStar.
function accelFromStarWithPlanets(primary, planets, px, py) {
  // Star — same as accelFromStar.
  const sdx = primary.x - px, sdy = primary.y - py;
  const sr2 = sdx * sdx + sdy * sdy;
  let ax = 0, ay = 0;
  if (sr2 >= 1) {
    const sr = Math.sqrt(sr2);
    const sa = primary.gm / (sr2 * sr);
    ax = sa * sdx;
    ay = sa * sdy;
  }
  if (planets) {
    for (let i = 0; i < planets.length; i++) {
      const p = planets[i];
      const pdx = p.x - px, pdy = p.y - py;
      const effR2 = pdx * pdx + pdy * pdy + p.softR2;
      const effR = Math.sqrt(effR2);
      const pa = p.gm / (effR2 * effR);
      ax += pa * pdx;
      ay += pa * pdy;
    }
  }
  return [ax, ay];
}

// Combined nearest-star scan: returns the star's index AND the
// minimum distance (sqrt) in a single pass over `stars`. Replaces
// both `nearestStarIdx` + `subStepCount` for the integrator hot
// loop, so each frame does ONE O(stars.length) scan instead of
// many. Sub-steps within the same frame reuse the same primary
// and the same `sub` count — safe because per-frame displacement
// (≤ MAX_SPEED = 16 px) is far less than the > 100 px Voronoi
// cell width guaranteed by SAFE_SEP, so a sub-step can't cross a
// boundary.
function nearestStarInfo(stars, px, py) {
  let bestIdx = 0, bestD2 = Infinity;
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i];
    const dx = s.x - px, dy = s.y - py;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
  }
  return { idx: bestIdx, minR: Math.sqrt(bestD2) };
}

// Kept for the public export (`AC.subStepCount`) — internal hot
// path uses `nearestStarInfo` directly.
function subStepCount(stars, px, py) {
  const minR = nearestStarInfo(stars, px, py).minR;
  return minR < 60 ? 4 : minR < 120 ? 2 : 1;
}

// One physics frame (mutates ball.x/y/vx/vy). Pure free flight,
// no burn handling — that's a separate step. The nearest star is
// looked up ONCE per frame; all sub-steps reuse it via
// accelFromStarWithPlanets. `ball.frame` is a monotonic tick
// counter shared with predictCapture via its startFrame
// parameter, so planet positions in the live and predicted
// trajectories are computed from the same time basis and
// therefore match exactly.
function physicsStep(stars, ball) {
  const info = nearestStarInfo(stars, ball.x, ball.y);
  const sub = info.minR < 60 ? 4 : info.minR < 120 ? 2 : 1;
  const dt = 1 / sub;
  const primary = stars[info.idx];
  const frame = ball.frame || 0;
  const planetPositions = computePlanetPositions(primary, frame);
  for (let i = 0; i < sub; i++) {
    const [ax, ay] = accelFromStarWithPlanets(primary, planetPositions, ball.x, ball.y);
    const nx = ball.x + ball.vx * dt + 0.5 * ax * dt * dt;
    const ny = ball.y + ball.vy * dt + 0.5 * ay * dt * dt;
    const [ax2, ay2] = accelFromStarWithPlanets(primary, planetPositions, nx, ny);
    ball.vx += 0.5 * (ax + ax2) * dt;
    ball.vy += 0.5 * (ay + ay2) * dt;
    ball.x = nx;
    ball.y = ny;

    const sp = Math.hypot(ball.vx, ball.vy);
    if (sp > MAX_SPEED) {
      ball.vx *= MAX_SPEED / sp;
      ball.vy *= MAX_SPEED / sp;
    }
  }
  ball.frame = frame + 1;
}

// Capture step: detect actual periapsis in the live trajectory
// (d started increasing) and burn just enough to make the orbit
// bound and Voronoi-safe — no more. We rewind to the exact
// periapsis snapshot, compute the maximum |v| at periapsis that
// still keeps apoapsis inside the target's Voronoi cell, and
// clamp the natural |v| into [v_circ, v_max]. The natural
// direction is preserved so eccentricity comes from the actual
// approach speed, not from any rotation. Result:
//   • peri stays exactly where prediction put it (≥ 1.5 R)
//   • apo ≤ PERI_VORONOI_FRAC × distance-to-nearest-neighbor
//   • the orbit is as eccentric as the player's tap timing
//     deserves — fully circular only when the natural |v| at
//     periapsis is already at v_circ.
function burnStep(stars, ball) {
  if (ball.pendingCapture < 0) return false;
  ball.transferFrames++;
  if (ball.transferFrames > TRANSFER_TIMEOUT) {
    ball.pendingCapture = -1;
    return false;
  }
  const target = stars[ball.pendingCapture];
  const dx = ball.x - target.x;
  const dy = ball.y - target.y;
  const d = Math.hypot(dx, dy);
  if (ball.captureMinD === undefined || d < ball.captureMinD) {
    ball.captureMinD = d;
    ball.captureMinX = ball.x;
    ball.captureMinY = ball.y;
    ball.captureMinVx = ball.vx;
    ball.captureMinVy = ball.vy;
    return false;
  }
  if (d > ball.captureMinD + PERI_HYSTERESIS) {
    // Rewind to the exact-periapsis snapshot.
    ball.x = ball.captureMinX;
    ball.y = ball.captureMinY;
    ball.vx = ball.captureMinVx;
    ball.vy = ball.captureMinVy;
    const pdx = ball.x - target.x;
    const pdy = ball.y - target.y;
    const pd = Math.hypot(pdx, pdy);
    const vMag = Math.hypot(ball.vx, ball.vy);

    // Find target's nearest neighbor → max safe apoapsis.
    let nearestNeighbor = Infinity;
    for (let i = 0; i < stars.length; i++) {
      if (i === ball.pendingCapture) continue;
      const ddx = stars[i].x - target.x;
      const ddy = stars[i].y - target.y;
      const dd = Math.hypot(ddx, ddy);
      if (dd < nearestNeighbor) nearestNeighbor = dd;
    }
    const apoMax = nearestNeighbor * PERI_VORONOI_FRAC;
    // v at periapsis for an orbit whose apoapsis is exactly apoMax
    const aMax = (pd + apoMax) / 2;
    const vMaxAtPeri = Math.sqrt(target.gm * (2 / pd - 1 / aMax));
    // v at periapsis for a circular orbit (= lower bound; below
    // this, peri becomes apo and the orbit dips inward → crash).
    const vCircAtPeri = Math.sqrt(target.gm / pd);
    // Clamp natural |v| into the safe band.
    let newMag = vMag;
    if (newMag < vCircAtPeri) newMag = vCircAtPeri;
    if (newMag > vMaxAtPeri) newMag = vMaxAtPeri;

    if (vMag > 0.001 && newMag > 0) {
      ball.vx *= newMag / vMag;
      ball.vy *= newMag / vMag;
    }
    return true;
  }
  return false;
}

// Forward-simulate free flight under the same physics and find
// periapsis (closest approach) of the next star. Returns
// {periFrame, periDist, vMagAtPeri} on success or null otherwise.
// `startFrame` (optional, default 0) is the live-physics frame
// index at which this prediction starts. Each predicted frame
// advances it by 1 and passes the sum to computePlanetPositions
// so the simulated planet positions exactly match whatever the
// live physicsStep would see at the same simulated moment.
function predictCapture(stars, currentStarIdx, x0, y0, vx0, vy0, startFrame) {
  if (startFrame === undefined) startFrame = 0;
  const nextIdx = currentStarIdx + 1;
  if (nextIdx >= stars.length) return null;
  const next = stars[nextIdx];

  let x = x0, y = y0, vx = vx0, vy = vy0;
  let prevD = Infinity;
  let minD = Infinity;
  let minDFrame = -1;
  let minDVx = 0, minDVy = 0;

  for (let f = 1; f <= PREDICT_MAX_FRAMES; f++) {
    // Cache the nearest star ONCE per frame and reuse it for
    // all sub-step accel calls. Same approximation as the live
    // physicsStep, so the two integrators agree exactly — as
    // long as we also feed it the same planet positions, which
    // is why we pass startFrame + f here.
    const info = nearestStarInfo(stars, x, y);
    const sub = info.minR < 60 ? 4 : info.minR < 120 ? 2 : 1;
    const dt = 1 / sub;
    const primary = stars[info.idx];
    const planetPositions = computePlanetPositions(primary, startFrame + f);
    for (let k = 0; k < sub; k++) {
      const [ax, ay] = accelFromStarWithPlanets(primary, planetPositions, x, y);
      const nx = x + vx * dt + 0.5 * ax * dt * dt;
      const ny = y + vy * dt + 0.5 * ay * dt * dt;
      const [ax2, ay2] = accelFromStarWithPlanets(primary, planetPositions, nx, ny);
      vx += 0.5 * (ax + ax2) * dt;
      vy += 0.5 * (ay + ay2) * dt;
      x = nx; y = ny;

      const sp = Math.hypot(vx, vy);
      if (sp > MAX_SPEED) {
        vx *= MAX_SPEED / sp;
        vy *= MAX_SPEED / sp;
      }
    }

    // Crash into any star → abandon prediction.
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      if (s.isBinary && s.binary) {
        const b = s.binary;
        const ba = (startFrame + f) * b.omega + b.phase;
        const bc = Math.cos(ba), bs = Math.sin(ba);
        const sx1 = s.x + bc * b.d1, sy1 = s.y + bs * b.d1;
        const sx2 = s.x - bc * b.d2, sy2 = s.y - bs * b.d2;
        let d1x = x - sx1, d1y = y - sy1;
        if (d1x * d1x + d1y * d1y < (b.r1 * CRASH_MULT) * (b.r1 * CRASH_MULT)) return null;
        let d2x = x - sx2, d2y = y - sy2;
        if (d2x * d2x + d2y * d2y < (b.r2 * CRASH_MULT) * (b.r2 * CRASH_MULT)) return null;
        continue;
      }
      const ddx = x - s.x, ddy = y - s.y;
      const crashR = s.r * CRASH_MULT;
      if (ddx * ddx + ddy * ddy < crashR * crashR) return null;
    }

    const dx = x - next.x, dy = y - next.y;
    const d = Math.hypot(dx, dy);
    if (d < minD) {
      minD = d;
      minDFrame = f;
      minDVx = vx;
      minDVy = vy;
    }

    if (f > minDFrame && d > prevD * 1.001 && minDFrame > 0) {
      const vMagAtPeri = Math.hypot(minDVx, minDVy);
      if (minD < next.r * MIN_PERI_MULT) return null;
      if (minD > next.r * MAX_PERI_MULT) return null;
      // Reject if the resulting circular orbit at periDist would
      // extend beyond the target star's Voronoi cell — i.e. peri
      // exceeds PERI_VORONOI_FRAC of the distance from the target
      // to its nearest other star. Otherwise the "circular" orbit
      // gets stolen by a neighbor and decays into chaos.
      let nearestNeighbor = Infinity;
      for (let i = 0; i < stars.length; i++) {
        if (i === nextIdx) continue;
        const ddx = stars[i].x - next.x;
        const ddy = stars[i].y - next.y;
        const dd = Math.hypot(ddx, ddy);
        if (dd < nearestNeighbor) nearestNeighbor = dd;
      }
      if (minD > nearestNeighbor * PERI_VORONOI_FRAC) return null;
      return { periFrame: minDFrame, periDist: minD, vMagAtPeri };
    }
    prevD = d;
  }
  return null;
}

// Player picks the moment (velocity direction); the system picks
// the boost magnitude IF a clean capture is reachable. Otherwise
// the tap still commits a default-magnitude prograde boost — the
// ball flies free and usually dies (off-screen / crash), unless
// it lucks into a closed orbit on its own. This way good timing
// is rewarded (auto-tuned safe transfer) but bad timing isn't a
// silent no-op — the player feels their tap and pays for it.
const BOOST_SEARCH_MIN = 0.30;   // smallest Δv tried, as fraction of current |v|
const BOOST_SEARCH_MAX = 2.80;   // largest Δv tried
const BOOST_SEARCH_STEPS = 48;
const BOOST_DEFAULT = 0.85;      // fallback Δv when search finds nothing

function applyBoostAndArm(stars, ball) {
  const sp = Math.hypot(ball.vx, ball.vy);
  if (sp < 0.001) return null;
  const startFrame = ball.frame || 0;
  // Search for the smallest Δv that produces a clean capture.
  let bestFactor = 0;
  let bestPred = null;
  for (let i = 0; i < BOOST_SEARCH_STEPS; i++) {
    const t = i / (BOOST_SEARCH_STEPS - 1);
    const factor = BOOST_SEARCH_MIN + (BOOST_SEARCH_MAX - BOOST_SEARCH_MIN) * t;
    const trialVx = ball.vx * (1 + factor);
    const trialVy = ball.vy * (1 + factor);
    const pred = predictCapture(stars, ball.currentStar, ball.x, ball.y, trialVx, trialVy, startFrame);
    if (pred) { bestFactor = factor; bestPred = pred; break; }
  }
  if (bestPred) {
    // Good timing: commit the auto-tuned safe transfer.
    ball.vx *= 1 + bestFactor;
    ball.vy *= 1 + bestFactor;
    ball.pendingCapture = ball.currentStar + 1;
    ball.transferFrames = 0;
    ball.captureMinD = undefined;
    return { ...bestPred, boostFactor: bestFactor };
  }
  // No clean capture reachable — commit a default boost and let
  // physics decide. No pendingCapture / no burn — the ball flies
  // free and the player either dies or lucks into a closed orbit.
  ball.vx *= 1 + BOOST_DEFAULT;
  ball.vy *= 1 + BOOST_DEFAULT;
  return null;
}

function makeStar(x, y, r, colorIdx) {
  return { x, y, r, gm: starGM(r), colorIdx, caught: false, pulse: 0 };
}

function makeBallInCircularOrbit(star, angle) {
  // Position at given math angle, prograde tangent velocity. The
  // live init() places the ball at the top of star 0 moving right,
  // which corresponds to angle = -π/2 with this convention.
  const r = star.r * INITIAL_ORBIT_MULT;
  const v = circularV(star.gm, r);
  return {
    x: star.x + Math.cos(angle) * r,
    y: star.y + Math.sin(angle) * r,
    vx: -Math.sin(angle) * v,
    vy:  Math.cos(angle) * v,
    currentStar: 0,
    alive: true,
    pendingCapture: -1,
    transferFrames: 0,
    captureMinD: undefined,
  };
}

export {
// constants
G, STAR_GM_PER_PX, INITIAL_ORBIT_MULT, CAPTURE_MULT, CRASH_MULT,
MAX_SPEED, MIN_PERI_MULT, MAX_PERI_MULT,
PERI_VORONOI_FRAC, PERI_HYSTERESIS, TRANSFER_TIMEOUT,
SAFE_SEP, PREDICT_MAX_FRAMES,
// helpers
starGM, circularV, nearestStarIdx, accelAt, subStepCount,
physicsStep, burnStep, predictCapture, applyBoostAndArm,
makeStar, makeBallInCircularOrbit,
};
