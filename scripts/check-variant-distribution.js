// Verifies that switching the spawn-time RNG from Math.random() to the seeded mulberry32 didn't
// change the variant-frequency distribution. Runs many simulated pickVariant() calls per star
// index, with both RNG sources, and compares the empirical frequencies side by side against the
// SPAWN_TABLE-weight expectations.
//
// pickVariant() is the gameplay-side function whose RNG dependency was the main one to change.
// addNextStar / makeStar / planet rolls all use the same runRand() — if pickVariant is uniform,
// the rest are too.

// ── SPAWN_TABLE (verbatim from gameplay.js) ────────────────────────────────────────────────────
const SPAWN_TABLE = [
  { at:  0,   plain: 100, binary:  0, bh:  0, bhBinary: 0, monolith: 0, ringworld: 0, pulsar: 0, nebula: 0, teapot: 0, azazel: 0 },
  { at:  5,   plain:  85, binary:  2, bh:  2, bhBinary: 1, monolith: 0, ringworld: 0, pulsar: 0, nebula: 0, teapot: 0, azazel: 0 },
  { at: 10,   plain:  83, binary:  3, bh:  2, bhBinary: 1, monolith: 0, ringworld: 0, pulsar: 2, nebula: 0, teapot: 0, azazel: 0 },
  { at: 20,   plain:  67, binary:  8, bh:  5, bhBinary: 3, monolith: 1, ringworld: 0, pulsar: 4, nebula: 2, teapot: 0, azazel: 0 },
  { at: 50,   plain:  52, binary: 10, bh:  8, bhBinary: 4, monolith: 2, ringworld: 2, pulsar: 6, nebula: 3, teapot: 1, azazel: 1 },
  { at: 80,   plain:  39, binary: 10, bh: 10, bhBinary: 5, monolith: 3, ringworld: 4, pulsar: 8, nebula: 4, teapot: 1, azazel: 2 },
];

function spawnWeightsAt(starIdx) {
  const last = SPAWN_TABLE[SPAWN_TABLE.length - 1];
  let lo = SPAWN_TABLE[0], hi = SPAWN_TABLE[0], t = 0;
  if (starIdx <= SPAWN_TABLE[0].at) {
    hi = lo;
  } else if (starIdx >= last.at) {
    lo = hi = last;
  } else {
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

function pickVariant(starIdx, rand) {
  const w = spawnWeightsAt(starIdx);
  let total = 0;
  for (const k of Object.keys(w)) total += w[k];
  if (total <= 0) return "plain";
  let r = rand() * total;
  for (const k of Object.keys(w)) {
    r -= w[k];
    if (r < 0) return k;
  }
  return Object.keys(w).pop();
}

// ── Seeded RNG (verbatim from gameplay.js) ─────────────────────────────────────────────────────
function makeSeededRng(seed) {
  let state = ((seed >>> 0) * 0x9E3779B1 + 1) >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Simulation ─────────────────────────────────────────────────────────────────────────────────
const VARIANTS = ["plain", "binary", "bh", "bhBinary", "monolith", "ringworld", "pulsar", "nebula", "teapot", "azazel"];

// At each test star index, draw N samples using each RNG and tally per-variant frequencies.
function tallyAt(starIdx, samples, rand) {
  const counts = Object.fromEntries(VARIANTS.map((v) => [v, 0]));
  for (let i = 0; i < samples; i++) counts[pickVariant(starIdx, rand)]++;
  return counts;
}

function expectedFrequencies(starIdx) {
  const w = spawnWeightsAt(starIdx);
  let total = 0;
  for (const k of Object.keys(w)) total += w[k];
  const out = {};
  for (const k of Object.keys(w)) out[k] = w[k] / total;
  return out;
}

function chiSquare(observed, expected, samples) {
  let chi = 0;
  let nonZeroBuckets = 0;
  for (const k of Object.keys(expected)) {
    const e = expected[k] * samples;
    if (e < 5) continue; // chi-square unreliable for very small expected counts
    const o = observed[k];
    chi += ((o - e) * (o - e)) / e;
    nonZeroBuckets++;
  }
  return { chi, df: nonZeroBuckets - 1 };
}

function pad(s, n) { return String(s).padStart(n); }

const INDICES = [0, 5, 10, 20, 35, 50, 80, 120];
const SAMPLES = 200_000;
const SEED_BASE = 0;

console.log(`pickVariant distribution check`);
console.log(`Samples per star idx: ${SAMPLES.toLocaleString()}`);
console.log(`Seeded RNG: mulberry32 from setRunSeed(idx + ${SEED_BASE})`);
console.log("");

const header = "idx | RNG       | " + VARIANTS.map((v) => pad(v, 9)).join(" ") + " | χ²(df)";
console.log(header);
console.log("-".repeat(header.length));

for (const idx of INDICES) {
  const expected = expectedFrequencies(idx);
  const expectedRow = VARIANTS.map((v) => pad(((expected[v] || 0) * 100).toFixed(2) + "%", 9)).join(" ");
  console.log(pad(idx, 3) + " | expected  | " + expectedRow);

  const seededRng = makeSeededRng(idx + SEED_BASE);
  const seededCounts = tallyAt(idx, SAMPLES, seededRng);
  const seededRow = VARIANTS.map((v) => pad(((seededCounts[v] / SAMPLES) * 100).toFixed(2) + "%", 9)).join(" ");
  const seededChi = chiSquare(seededCounts, expected, SAMPLES);
  console.log(pad(idx, 3) + " | seeded    | " + seededRow + " | " + seededChi.chi.toFixed(2) + "(" + seededChi.df + ")");

  const mathCounts = tallyAt(idx, SAMPLES, Math.random);
  const mathRow = VARIANTS.map((v) => pad(((mathCounts[v] / SAMPLES) * 100).toFixed(2) + "%", 9)).join(" ");
  const mathChi = chiSquare(mathCounts, expected, SAMPLES);
  console.log(pad(idx, 3) + " | Math.rand | " + mathRow + " | " + mathChi.chi.toFixed(2) + "(" + mathChi.df + ")");

  console.log("");
}

// 5% critical χ² values (one-tail): df=1 → 3.84, df=2 → 5.99, df=3 → 7.81, df=4 → 9.49, df=5 →
// 11.07, df=6 → 12.59, df=7 → 14.07, df=8 → 15.51, df=9 → 16.92. Values BELOW these mean we can't
// reject "the empirical distribution matches the expected weights at p=0.05".
console.log("χ² 5% critical values by df: 1=3.84, 2=5.99, 3=7.81, 4=9.49, 5=11.07, 6=12.59, 7=14.07, 8=15.51, 9=16.92");
console.log("(seeded and Math.random both pass when their χ² is below the critical value for the same df)");

// Cross-RNG sanity: run many distinct seeds and check that the AGGREGATE seeded distribution
// matches what Math.random produces.
console.log("");
console.log("Cross-RNG aggregate check: sweep 64 seeds × 5000 samples each at idx=20");
console.log("");
const SWEEP_SEEDS = 64;
const SWEEP_SAMPLES = 5000;
const aggSeeded = Object.fromEntries(VARIANTS.map((v) => [v, 0]));
const aggMath = Object.fromEntries(VARIANTS.map((v) => [v, 0]));
for (let s = 0; s < SWEEP_SEEDS; s++) {
  const r = makeSeededRng(s * 17 + 1);
  const c = tallyAt(20, SWEEP_SAMPLES, r);
  for (const v of VARIANTS) aggSeeded[v] += c[v];
  const c2 = tallyAt(20, SWEEP_SAMPLES, Math.random);
  for (const v of VARIANTS) aggMath[v] += c2[v];
}
const totalAgg = SWEEP_SEEDS * SWEEP_SAMPLES;
const expAt20 = expectedFrequencies(20);
console.log("variant    | seeded%   | Math.rand% | expected%");
console.log("-----------+-----------+------------+----------");
for (const v of VARIANTS) {
  console.log(
    pad(v, 10) + " | "
    + pad((aggSeeded[v] / totalAgg * 100).toFixed(3) + "%", 8) + " | "
    + pad((aggMath[v] / totalAgg * 100).toFixed(3) + "%", 9) + " | "
    + pad(((expAt20[v] || 0) * 100).toFixed(3) + "%", 8),
  );
}
