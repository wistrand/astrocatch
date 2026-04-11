// Verifies that addNextStar actually pushes target stars
// further away as the game progresses. Re-implements the
// generator inline (it lives in gameplay.js which is browser-only)
// and runs many simulated chains, reporting prev→next distance
// statistics by star index.

import { SAFE_SEP, starGM } from "../docs/physics.js";

const W = 480; // typical mobile viewport width
const RUNS = 200;
const STARS_PER_RUN = 80;

function makeStar(x, y, r, colorIdx) {
  return { x, y, r, gm: starGM(r), colorIdx, caught: false, pulse: 0 };
}

function minSeparation(ra, rb) {
  return SAFE_SEP * Math.max(ra, rb);
}

function separationOk(stars, x, y, r) {
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i];
    const dx = x - s.x, dy = y - s.y;
    const d2 = dx * dx + dy * dy;
    const need = minSeparation(r, s.r);
    if (d2 < need * need) return false;
  }
  return true;
}

// Verbatim copy of addNextStar from gameplay.js (with `stars`
// passed in instead of read from a closure).
function addNextStar(stars) {
  const prev = stars[stars.length - 1];
  const n = stars.length;
  const difficulty = Math.min(n / 60, 1);
  const r = Math.max(18, (34 + Math.random() * 24) - difficulty * 14);
  const hardMin = minSeparation(r, prev.r) + 8;
  const baseMin = 320 + difficulty * 240;
  const baseMax = 400 + difficulty * 280;
  const minD = Math.max(baseMin, hardMin);
  const maxD = Math.max(minD + 80, baseMax);
  for (let tries = 0; tries < 40; tries++) {
    const dist = minD + Math.random() * (maxD - minD);
    const halfSpread = Math.PI * 0.25 + difficulty * Math.PI * 0.22;
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 2 * halfSpread;
    let nx = prev.x + Math.cos(angle) * dist;
    let ny = prev.y + Math.sin(angle) * dist;
    if (ny > prev.y - 120) ny = prev.y - 120 - Math.random() * 60;
    nx = Math.max(80, Math.min(W - 80, nx));
    if (separationOk(stars, nx, ny, r)) {
      stars.push(makeStar(nx, ny, r, n));
      return;
    }
  }
  // Fallback
  const fx = Math.max(80, Math.min(W - 80, prev.x));
  const fy = prev.y - hardMin * 1.4;
  stars.push(makeStar(fx, fy, r, n));
}

// Bucket: for each star index n, gather all the prev→next
// distances seen across RUNS independent chains.
const distsByIdx = Array.from({ length: STARS_PER_RUN }, () => []);
const radiiByIdx = Array.from({ length: STARS_PER_RUN }, () => []);
const fallbacksByIdx = new Array(STARS_PER_RUN).fill(0);

for (let run = 0; run < RUNS; run++) {
  const stars = [];
  // Same seed as init(): one big star low on screen.
  stars.push(makeStar(W / 2, 600, 44, 0));
  for (let i = 0; i < STARS_PER_RUN - 1; i++) {
    const prev = stars[stars.length - 1];
    addNextStar(stars);
    const newStar = stars[stars.length - 1];
    const dx = newStar.x - prev.x;
    const dy = newStar.y - prev.y;
    const d = Math.hypot(dx, dy);
    distsByIdx[stars.length - 1].push(d);
    radiiByIdx[stars.length - 1].push(newStar.r);
  }
}

function pct(arr, p) {
  if (arr.length === 0) return NaN;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}
function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN;
}

console.log(`addNextStar distance check (${RUNS} runs, ${STARS_PER_RUN} stars each)`);
console.log("");
console.log("idx | difficulty |   d_mean   d_p10   d_p50   d_p90  | r_mean");
console.log("----+------------+----------------------------------+-------");
const sample = [1, 5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 79];
for (const idx of sample) {
  const d = distsByIdx[idx];
  const r = radiiByIdx[idx];
  const diff = Math.min(idx / 60, 1).toFixed(2);
  console.log(
    `${String(idx).padStart(3)} | ${diff.padStart(10)} | ` +
    `${mean(d).toFixed(1).padStart(7)} ${pct(d, 0.1).toFixed(0).padStart(6)} ` +
    `${pct(d, 0.5).toFixed(0).padStart(6)} ${pct(d, 0.9).toFixed(0).padStart(6)}  | ` +
    `${mean(r).toFixed(1).padStart(5)}`
  );
}

console.log("");
console.log("Expected from the formula:");
console.log("  difficulty = min(n/60, 1)");
console.log("  baseMin    = 320 + difficulty * 240   (320 → 560)");
console.log("  baseMax    = 400 + difficulty * 280   (400 → 680)");
console.log("  midpoint   = (baseMin + baseMax) / 2  (360 → 620)");
console.log("");
console.log("Verdict:");
const meanD1 = mean(distsByIdx[1]);
const meanD60 = mean(distsByIdx[60]);
const ratio = meanD60 / meanD1;
console.log(`  mean distance at idx 1:  ${meanD1.toFixed(1)} px`);
console.log(`  mean distance at idx 60: ${meanD60.toFixed(1)} px`);
console.log(`  ratio: ${ratio.toFixed(2)}× — ${ratio > 1.4 ? "GROWS as game progresses" : ratio < 0.9 ? "SHRINKS as game progresses" : "FLAT"}`);
