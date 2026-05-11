// In-game variant distribution check. Unlike scripts/check-variant-distribution.js (which calls
// pickVariant in isolation), this script mimics the FULL per-star RNG-consumption pattern of the
// real game — addNextStar's distance/angle rolls + makeStar's hasRays/nGran + variant-specific
// rolls (binary, ringworld plate count) + the orthogonal planet and comet rolls — and tallies
// what variants actually emerge at each star index across many simulated runs.
//
// If the seeded mulberry32 is uniform AND independent across calls, the per-index frequencies
// should match the SPAWN_TABLE-derived expected proportions to within sampling noise. Any
// systematic skew here points at a correlation issue.

// ── SPAWN_TABLE + spawnWeightsAt + pickVariant (verbatim from gameplay.js) ─────────────────────
const SPAWN_TABLE = [
  { at:  0,   plain: 100, binary:  0, bh:  0, bhBinary: 0, monolith: 0, ringworld: 0, pulsar: 0, nebula: 0, teapot: 0, azazel: 0 },
  { at:  5,   plain:  85, binary:  2, bh:  2, bhBinary: 1, monolith: 0, ringworld: 0, pulsar: 0, nebula: 0, teapot: 0, azazel: 0 },
  { at: 10,   plain:  83, binary:  3, bh:  2, bhBinary: 1, monolith: 0, ringworld: 0, pulsar: 2, nebula: 0, teapot: 0, azazel: 0 },
  { at: 20,   plain:  67, binary:  8, bh:  5, bhBinary: 3, monolith: 1, ringworld: 0, pulsar: 4, nebula: 2, teapot: 0, azazel: 0 },
  { at: 50,   plain:  52, binary: 10, bh:  8, bhBinary: 4, monolith: 2, ringworld: 2, pulsar: 6, nebula: 3, teapot: 1, azazel: 1 },
  { at: 80,   plain:  39, binary: 10, bh: 10, bhBinary: 5, monolith: 3, ringworld: 4, pulsar: 8, nebula: 4, teapot: 1, azazel: 2 },
];
const PLANET_PROB_MAX = 0.75;
const PLANET_RAMP_STARS = 50;
const COMET_PROB = 0.25;
const COMET_MIN_STAR = 2;
const VARIANTS = ["plain", "binary", "bh", "bhBinary", "monolith", "ringworld", "pulsar", "nebula", "teapot", "azazel"];

function spawnWeightsAt(starIdx) {
  const last = SPAWN_TABLE[SPAWN_TABLE.length - 1];
  let lo = SPAWN_TABLE[0], hi = SPAWN_TABLE[0], t = 0;
  if (starIdx <= SPAWN_TABLE[0].at) { hi = lo; }
  else if (starIdx >= last.at) { lo = hi = last; }
  else {
    for (let i = 0; i < SPAWN_TABLE.length - 1; i++) {
      const a = SPAWN_TABLE[i], b = SPAWN_TABLE[i + 1];
      if (starIdx >= a.at && starIdx < b.at) {
        lo = a; hi = b;
        t = (starIdx - a.at) / (b.at - a.at);
        break;
      }
    }
  }
  const out = {};
  for (const k of Object.keys(lo)) {
    if (k === "at") continue;
    out[k] = lo[k] + (hi[k] - lo[k]) * t;
  }
  return out;
}

// ── Seeded RNG ─────────────────────────────────────────────────────────────────────────────────
let _state = 0;
function setRunSeed(s) { _state = ((s >>> 0) * 0x9E3779B1 + 1) >>> 0; }
function runRand() {
  _state = (_state + 0x6D2B79F5) >>> 0;
  let t = _state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function pickVariant(starIdx) {
  const w = spawnWeightsAt(starIdx);
  let total = 0;
  for (const k of Object.keys(w)) total += w[k];
  if (total <= 0) return "plain";
  let r = runRand() * total;
  for (const k of Object.keys(w)) {
    r -= w[k];
    if (r < 0) return k;
  }
  return Object.keys(w).pop();
}

// ── Faithful per-star RNG consumption ──────────────────────────────────────────────────────────
// Mirrors the exact runRand() call sequence inside addNextStar() + makeStar() + assignBinary +
// assignPlanets + assignComets, so the state shift between consecutive pickVariant calls matches
// the real game. The actual distance/angle/separation loop varies in try count; we approximate
// with 1 successful try (the common case — `separationOk` passes on the first attempt in
// late-game far-apart spawns).
function consumeAddNextStarRng() {
  runRand(); // r-radius roll
  runRand(); // dist within minD..maxD
  runRand(); // angle within cone
  // Conditional `ny = prev.y - 120 - runRand() * 60` — depends on geometry. Skip; treating as
  // not-fired makes the script's RNG cadence a fixed 3 calls/star instead of 3-or-4. Per-call
  // distribution unaffected because mulberry32 is independent across calls.
}

function consumeMakeStarRng(variant, starIdx) {
  runRand(); // hasRays
  runRand(); // nGran
  if (variant === "binary" || variant === "bhBinary") {
    // assignBinary: q, sep, periodFrames, spin, phase, colorIdx2 — 6 calls.
    runRand(); runRand(); runRand(); runRand(); runRand(); runRand();
  } else if (variant === "ringworld") {
    runRand(); // ringPlateCount
  }
  // Planet roll — only for variants that don't already occupy the orbit volume.
  if (variant === "plain" || variant === "bh") {
    const planetRamp = Math.min(1, starIdx / PLANET_RAMP_STARS);
    if (runRand() < planetRamp * PLANET_PROB_MAX) {
      const nPlanets = 1 + (runRand() < 0.25 ? 1 : 0);
      // Per planet: orbitR, periodFrames, spin, planetR, phase, colorIdx — 6 calls.
      for (let i = 0; i < nPlanets; i++) {
        runRand(); runRand(); runRand(); runRand(); runRand(); runRand();
      }
    }
  }
  // Comet roll — allowed on all variants except monolith / teapot / azazel.
  if (variant !== "monolith" && variant !== "teapot" && variant !== "azazel"
      && starIdx >= COMET_MIN_STAR) {
    if (runRand() < COMET_PROB) {
      // assignComets: 1 RNG call for peri then possibly early-returns. Approximate with the FULL
      // path (peri + omega + phase + radius + tailLength + numSyndynes = 6 calls) since the
      // early-return depends on neighbouring-star geometry. The RNG cadence differs slightly
      // from the real game on rare early-return frames but the per-call distribution is
      // unaffected.
      runRand(); runRand(); runRand(); runRand(); runRand(); runRand();
    }
  }
}

// ── Simulation ─────────────────────────────────────────────────────────────────────────────────
const SEEDS = 50000;
const STARS_PER_RUN = 121; // covers all sampled indices below
const SAMPLED_IDX = [0, 5, 10, 20, 35, 50, 80, 120];

// counts[idx][variant] across all seeds.
const counts = {};
for (const i of SAMPLED_IDX) {
  counts[i] = Object.fromEntries(VARIANTS.map((v) => [v, 0]));
}

for (let s = 0; s < SEEDS; s++) {
  setRunSeed(s + 1); // seed=0 is excluded since setRunSeed(0) hits the "non-zero state" floor
  for (let i = 0; i < STARS_PER_RUN; i++) {
    const v = pickVariant(i);
    if (counts[i]) counts[i][v]++;
    consumeAddNextStarRng();
    consumeMakeStarRng(v, i);
  }
}

function pad(s, n) { return String(s).padStart(n); }

console.log("In-game variant distribution");
console.log(`Seeds: ${SEEDS.toLocaleString()}   Stars per run: ${STARS_PER_RUN}   `
  + `(RNG state advances per the real addNextStar + makeStar call sequence)`);
console.log("");

const HEADER = "idx | source   | " + VARIANTS.map((v) => pad(v, 9)).join(" ") + " | χ²(df)";
console.log(HEADER);
console.log("-".repeat(HEADER.length));

function expectedFrequencies(starIdx) {
  const w = spawnWeightsAt(starIdx);
  let total = 0;
  for (const k of Object.keys(w)) total += w[k];
  const out = {};
  for (const k of Object.keys(w)) out[k] = w[k] / total;
  return out;
}

function chiSquare(observed, expected, samples) {
  let chi = 0, df = -1;
  for (const k of Object.keys(expected)) {
    const e = expected[k] * samples;
    if (e < 5) continue;
    chi += ((observed[k] - e) * (observed[k] - e)) / e;
    df++;
  }
  return { chi, df: Math.max(df, 0) };
}

for (const idx of SAMPLED_IDX) {
  const exp = expectedFrequencies(idx);
  const expRow = VARIANTS.map((v) => pad(((exp[v] || 0) * 100).toFixed(3) + "%", 9)).join(" ");
  console.log(pad(idx, 3) + " | expected | " + expRow);

  const obs = counts[idx];
  const obsRow = VARIANTS.map((v) => pad(((obs[v] / SEEDS) * 100).toFixed(3) + "%", 9)).join(" ");
  const chi = chiSquare(obs, exp, SEEDS);
  console.log(pad(idx, 3) + " | sim      | " + obsRow + " | " + chi.chi.toFixed(2) + "(" + chi.df + ")");
  console.log("");
}

console.log("χ² 5% critical values: df=3→7.81, df=4→9.49, df=6→12.59, df=9→16.92");
console.log("(simulated passes if χ² < critical — meaning we can't reject the null 'distribution matches expected')");
