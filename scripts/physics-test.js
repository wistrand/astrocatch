// Node test runner for the ASTROCATCH physics. Sweeps boost
// angles, runs the full transfer + post-capture orbit, and
// reports any crashes / overshoots / drifts.

import * as P from "../docs/physics.js";

const SIM_LIMIT = 2000;             // hard cap on frames per scenario
const POST_CAPTURE_FRAMES = 400;    // frames to verify orbit stability after capture

function classify(stars, ball, label) {
  // Possible outcomes:
  //   captured                       — auto-tuned boost, clean capture, stable post-orbit
  //   no-prediction-died             — fallback boost, ball flies free and dies
  //   no-prediction-escaped          — fallback boost, ball drifts off-screen-ish
  //   no-prediction-orbit            — fallback boost, ball lucks into a closed orbit
  //   crashed-during-transfer        — predicted capture, but live trajectory crashed
  //   crashed-post-capture           — predicted capture, but resulting orbit decays
  const pred = P.applyBoostAndArm(stars, ball);
  if (!pred) {
    // Fallback boost was applied. Run free physics, see what happens.
    let died = false;
    for (let i = 0; i < 800; i++) {
      P.physicsStep(stars, ball);
      // Crash check
      for (let j = 0; j < stars.length; j++) {
        const s = stars[j];
        const d = Math.hypot(ball.x - s.x, ball.y - s.y);
        if (d < s.r * P.CRASH_MULT) { died = true; break; }
      }
      if (died) break;
      // Off-screen check (the live game uses similar bounds)
      if (ball.x < -300 || ball.x > 1200 || ball.y < -2000 || ball.y > 1500) {
        return { label, result: "no-prediction-escaped", at: i };
      }
    }
    if (died) return { label, result: "no-prediction-died" };
    // Survived 800 frames without dying or escaping → lucky orbit
    return { label, result: "no-prediction-orbit" };
  }

  let captured = false;
  let frames = 0;
  while (frames < SIM_LIMIT) {
    P.physicsStep(stars, ball);
    // Crash check
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      const d = Math.hypot(ball.x - s.x, ball.y - s.y);
      if (d < s.r * P.CRASH_MULT) {
        return { label, result: "crashed-during-transfer", crashStar: i, frames, pred };
      }
    }
    if (P.burnStep(stars, ball)) { captured = true; break; }
    frames++;
  }
  if (!captured) return { label, result: "ran-out-of-frames", frames, pred };

  // Post-capture: confirm we're in a stable, non-crashing orbit
  // around the new primary.
  const target = stars[ball.pendingCapture < 0 ? ball.currentStar + 1 : ball.pendingCapture];
  // After burnStep returned true the live game calls captureStar()
  // which advances ball.currentStar and clears pendingCapture. We
  // mimic that here so post-capture nearest-star physics is correct.
  ball.currentStar = ball.currentStar + 1;
  ball.pendingCapture = -1;

  const newPrimary = stars[ball.currentStar];
  let minD = Infinity, maxD = 0;
  for (let i = 0; i < POST_CAPTURE_FRAMES; i++) {
    P.physicsStep(stars, ball);
    const d = Math.hypot(ball.x - newPrimary.x, ball.y - newPrimary.y);
    if (d < minD) minD = d;
    if (d > maxD) maxD = d;
    if (d < newPrimary.r * P.CRASH_MULT) {
      return { label, result: "crashed-post-capture", at: i, minD, maxD, frames, pred };
    }
  }
  const ecc = (maxD - minD) / (maxD + minD);
  return {
    label, result: "captured",
    frames, pred,
    postCapture: { minD: +minD.toFixed(2), maxD: +maxD.toFixed(2), ecc: +ecc.toFixed(3) },
  };
}

function makeTwoStarSystem(spacing, r1) {
  return [
    P.makeStar(400, 600, 44, 0),
    P.makeStar(400, 600 - spacing, r1, 1),
    P.makeStar(400, 600 - spacing - 200, 32, 2),
  ];
}

function sweep(stars, label) {
  const counts = {};
  const failures = [];
  const captures = [];
  const N = 64;
  for (let i = 0; i < N; i++) {
    const angle = (i / N) * Math.PI * 2 - Math.PI / 2;
    // Make a fresh ball + star copies (mutation safety)
    const sCopy = stars.map((s) => ({ ...s }));
    const ball = P.makeBallInCircularOrbit(sCopy[0], angle);
    const r = classify(sCopy, ball, `${label} a=${(angle * 180 / Math.PI).toFixed(1)}°`);
    counts[r.result] = (counts[r.result] || 0) + 1;
    if (r.result.includes("CRASH") || r.result.includes("crashed") || r.result.includes("BUG")) {
      failures.push(r);
    }
    if (r.result === "captured" && r.pred && typeof r.pred.boostFactor === "number") {
      captures.push({ angle: +(angle * 180 / Math.PI).toFixed(0), bf: +r.pred.boostFactor.toFixed(2), peri: +r.pred.periDist.toFixed(1) });
    }
  }
  console.log(`\n[${label}] ${N} samples:`);
  for (const k of Object.keys(counts)) console.log(`  ${k.padEnd(36)} ${counts[k]}`);
  if (captures.length > 0) {
    const factors = captures.map((c) => c.bf);
    const minBf = Math.min(...factors), maxBf = Math.max(...factors);
    const meanBf = factors.reduce((a, b) => a + b, 0) / factors.length;
    console.log(`  boost factor range  [${minBf.toFixed(2)}, ${maxBf.toFixed(2)}]  mean ${meanBf.toFixed(2)}`);
  }
  if (failures.length > 0) {
    console.log(`  ⚠ failures (${failures.length}):`);
    for (const f of failures.slice(0, 5)) {
      console.log("    " + JSON.stringify(f));
    }
  }
  return counts;
}

console.log("ASTROCATCH physics test");
console.log("Constants:",
  "CAPTURE_MULT=", P.CAPTURE_MULT,
  "CRASH_MULT=", P.CRASH_MULT,
  "MIN_PERI_MULT=", P.MIN_PERI_MULT,
  "MAX_PERI_MULT=", P.MAX_PERI_MULT,
  "BURN_FRAMES=", P.BURN_FRAMES,
);

sweep(makeTwoStarSystem(280, 30), "near small target");
sweep(makeTwoStarSystem(320, 30), "mid small target");
sweep(makeTwoStarSystem(380, 30), "far small target");
sweep(makeTwoStarSystem(280, 44), "near big target");
sweep(makeTwoStarSystem(280, 22), "near tiny target");
// Late-game difficulty: distances 380–520, smaller targets
sweep(makeTwoStarSystem(440, 22), "late far tiny");
sweep(makeTwoStarSystem(500, 20), "late very-far tiny");
sweep(makeTwoStarSystem(520, 24), "late extreme");

// Detailed analysis of a failing scenario.
console.log("\nDetailed trace of a known FAILING scenario:");
{
  const stars = makeTwoStarSystem(280, 30).map((s) => ({ ...s }));
  const angle = 151.9 * Math.PI / 180;
  const ball = P.makeBallInCircularOrbit(stars[0], angle);
  console.log(`Initial: pos=(${ball.x.toFixed(2)},${ball.y.toFixed(2)}) v=(${ball.vx.toFixed(2)},${ball.vy.toFixed(2)})`);
  const pred = P.applyBoostAndArm(stars, ball);
  console.log(`Pred:`, pred);
  let captured = false, frames = 0, burnFrame = -1, burnState = null;
  while (frames < SIM_LIMIT) {
    P.physicsStep(stars, ball);
    const target = stars[ball.pendingCapture];
    if (target) {
      const dx = ball.x - target.x;
      const dy = ball.y - target.y;
      const d = Math.hypot(dx, dy);
      const v = Math.hypot(ball.vx, ball.vy);
      // Decompose into radial + tangential
      const rdot = (ball.vx * dx + ball.vy * dy) / d; // radial component (signed)
      const tdot = Math.sqrt(Math.max(0, v * v - rdot * rdot));
      // Run burnStep but capture state right before
      if (ball.captureMinD !== undefined && d > ball.captureMinD + P.PERI_HYSTERESIS && burnState === null) {
        burnState = { tf: ball.transferFrames + 1, d: +d.toFixed(3), v: +v.toFixed(3), rdot: +rdot.toFixed(3), tdot: +tdot.toFixed(3), minD: +ball.captureMinD.toFixed(3) };
      }
    }
    if (P.burnStep(stars, ball)) { captured = true; burnFrame = frames; break; }
    frames++;
  }
  console.log("burnState (just before burn fires):", burnState);
  console.log("captured =", captured, "frames =", frames);
  // Post-capture velocity decomposition
  if (captured) {
    const t = stars[ball.currentStar + 1] || stars[ball.pendingCapture < 0 ? ball.currentStar + 1 : ball.pendingCapture];
    ball.currentStar = ball.currentStar + 1;
    ball.pendingCapture = -1;
    const target = stars[ball.currentStar];
    const dx = ball.x - target.x;
    const dy = ball.y - target.y;
    const d = Math.hypot(dx, dy);
    const v = Math.hypot(ball.vx, ball.vy);
    const rdot = (ball.vx * dx + ball.vy * dy) / d;
    const tdot = Math.sqrt(Math.max(0, v * v - rdot * rdot));
    const vc = Math.sqrt(target.gm / d);
    console.log(`Post-burn: d=${d.toFixed(3)} v=${v.toFixed(3)} radial=${rdot.toFixed(3)} tangential=${tdot.toFixed(3)} vc=${vc.toFixed(3)}`);
    // Compute the orbital elements (specific energy, ang mom) of resulting orbit
    const E = v * v / 2 - target.gm / d;
    const Lz = dx * ball.vy - dy * ball.vx;
    const a = -target.gm / (2 * E);
    const eSq = 1 + 2 * E * Lz * Lz / (target.gm * target.gm);
    const e = Math.sqrt(Math.max(0, eSq));
    console.log(`Resulting orbit: a=${a.toFixed(2)} e=${e.toFixed(4)} peri=${(a*(1-e)).toFixed(2)} apo=${(a*(1+e)).toFixed(2)}`);
    // Run forward and capture min/max
    let minD = Infinity, maxD = 0;
    for (let i = 0; i < 400; i++) {
      P.physicsStep(stars, ball);
      const dd = Math.hypot(ball.x - target.x, ball.y - target.y);
      if (dd < minD) minD = dd;
      if (dd > maxD) maxD = dd;
    }
    console.log(`Live post-burn 400-frame: minD=${minD.toFixed(2)} maxD=${maxD.toFixed(2)}`);
  }
}

// Also: sample one captured run and trace it frame-by-frame around periapsis
console.log("\nDetailed trace of one captured run:");
{
  const stars = makeTwoStarSystem(320, 30).map((s) => ({ ...s }));
  // Find an angle that captures
  let trace = null;
  for (let i = 0; i < 64 && !trace; i++) {
    const angle = (i / 64) * Math.PI * 2 - Math.PI / 2;
    const sc = stars.map((s) => ({ ...s }));
    const ball = P.makeBallInCircularOrbit(sc[0], angle);
    const pred = P.applyBoostAndArm(sc, ball);
    if (!pred) continue;
    // Simulate with a sparse log near the periapsis moment
    const log = [];
    let captured = false;
    let frames = 0;
    while (frames < SIM_LIMIT) {
      P.physicsStep(sc, ball);
      const target = sc[ball.pendingCapture];
      const d = target ? Math.hypot(ball.x - target.x, ball.y - target.y) : -1;
      const v = Math.hypot(ball.vx, ball.vy);
      const vc = target ? Math.sqrt(target.gm / d) : 0;
      // Log when within 1.5x the predicted periDist of target
      if (target && d < pred.periDist * 1.5) {
        log.push({
          tf: ball.transferFrames + 1, d: +d.toFixed(2),
          v: +v.toFixed(3), vc: +vc.toFixed(3),
          mind: ball.captureMinD === undefined ? -1 : +ball.captureMinD.toFixed(2),
        });
      }
      if (P.burnStep(sc, ball)) { captured = true; break; }
      frames++;
    }
    if (captured) {
      trace = { angle: +(angle * 180 / Math.PI).toFixed(1), pred, log };
    }
  }
  if (trace) {
    console.log(`angle=${trace.angle}° pred=${JSON.stringify(trace.pred)}`);
    for (const row of trace.log) console.log("  " + JSON.stringify(row));
  } else {
    console.log("  (no captured run found in sweep)");
  }
}
