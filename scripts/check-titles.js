// Sweep composeRunTitle across canonical + randomised stat profiles and print each title with
// its inputs, so the lexicon can be eyeballed for absurdity / tonal misses / repetition before
// shipping. Run: `node scripts/check-titles.js`.

import { composeRunTitle } from "../docs/run-title.js";

// Fill missing fields so the script can write profiles compactly.
function profile(opts = {}) {
  const baseVariants = {
    azazel: 0, teapot: 0, blackHole: 0, ringworld: 0,
    nebula: 0, pulsar: 0, binary: 0, monolith: 0,
  };
  return {
    score: 0, starsVisited: 0, streakPeak: 0,
    blazingCount: 0, quickCount: 0, slowCount: 0,
    cometsCaught: 0, deathCause: 0,
    seed: 1,
    ...opts,
    variants: { ...baseVariants, ...(opts.variants || {}) },
  };
}

function summary(p) {
  const variantList = Object.entries(p.variants)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}:${n}`)
    .join(",") || "—";
  return `stars=${p.starsVisited} streak=${p.streakPeak} `
    + `b/q/s=${p.blazingCount}/${p.quickCount}/${p.slowCount} `
    + `comets=${p.cometsCaught} v={${variantList}} seed=${p.seed}`;
}

function row(title, label) {
  console.log(`  ${title.padEnd(34)} | ${label}`);
}

const canonicals = [
  // Edges — 0-star failures should route through the failure vocabulary, not the gentle
  // contemplative "spare" branch. Print several seeds so the FAILED_ADJ × FAILED_NOUN
  // distribution is visible.
  { label: "instant death (seed 1)",
    stats: profile({ deathCause: 1, seed: 1 }) },
  { label: "instant death (seed 7)",
    stats: profile({ deathCause: 1, seed: 7 }) },
  { label: "instant death (seed 42)",
    stats: profile({ deathCause: 1, seed: 42 }) },
  { label: "instant death (seed 1024)",
    stats: profile({ deathCause: 1, seed: 1024 }) },
  { label: "one slow capture",
    stats: profile({ score: 10, starsVisited: 1, slowCount: 1 }) },
  { label: "two captures, both slow",
    stats: profile({ score: 25, starsVisited: 2, slowCount: 2 }) },

  // Pure styles.
  { label: "all-blazing run",
    stats: profile({ score: 1500, starsVisited: 20, blazingCount: 20, streakPeak: 12 }) },
  { label: "all-quick run",
    stats: profile({ score: 600, starsVisited: 20, quickCount: 20 }) },
  { label: "all-patient run",
    stats: profile({ score: 100, starsVisited: 20, slowCount: 20 }) },
  { label: "balanced mix",
    stats: profile({
      score: 800, starsVisited: 24,
      blazingCount: 8, quickCount: 8, slowCount: 8,
      streakPeak: 5,
    }) },
  { label: "comet hunter",
    stats: profile({
      score: 600, starsVisited: 20, quickCount: 5, slowCount: 15,
      cometsCaught: 10,
    }) },
  { label: "tight streak",
    stats: profile({
      score: 1800, starsVisited: 25,
      blazingCount: 20, quickCount: 3, slowCount: 2,
      streakPeak: 12,
    }) },

  // Variant landscapes — single-variant dominance.
  { label: "binary-heavy",
    stats: profile({
      score: 1500, starsVisited: 30,
      blazingCount: 10, quickCount: 10, slowCount: 10,
      streakPeak: 5, variants: { binary: 5 },
    }) },
  { label: "BH-heavy",
    stats: profile({
      score: 1500, starsVisited: 30, slowCount: 20, blazingCount: 5, quickCount: 5,
      variants: { blackHole: 4 },
    }) },
  { label: "pulsar walk",
    stats: profile({
      score: 1800, starsVisited: 40, blazingCount: 15, quickCount: 15, slowCount: 10,
      streakPeak: 6, variants: { pulsar: 6 },
    }) },
  { label: "nebula run",
    stats: profile({
      score: 2200, starsVisited: 50, quickCount: 20, slowCount: 25, blazingCount: 5,
      streakPeak: 4, variants: { nebula: 5, binary: 3 },
    }) },
  { label: "ringworld + monolith",
    stats: profile({
      score: 1800, starsVisited: 35, slowCount: 25, quickCount: 8, blazingCount: 2,
      variants: { ringworld: 2, monolith: 2 },
    }) },

  // Rare-variant encounters — should override the dominant common variant.
  { label: "single azazel + many binaries",
    stats: profile({
      score: 3000, starsVisited: 50,
      blazingCount: 25, quickCount: 15, slowCount: 10, streakPeak: 8,
      variants: { azazel: 1, binary: 4, pulsar: 4 },
    }) },
  { label: "single teapot + nebulae",
    stats: profile({
      score: 2500, starsVisited: 45,
      blazingCount: 15, quickCount: 20, slowCount: 10, streakPeak: 6,
      variants: { teapot: 1, nebula: 3 },
    }) },

  // All-plain runs of varying length.
  { label: "short plain mostly slow",
    stats: profile({
      score: 250, starsVisited: 8, blazingCount: 1, quickCount: 2, slowCount: 5,
    }) },
  { label: "long plain steady",
    stats: profile({
      score: 1000, starsVisited: 35, blazingCount: 5, quickCount: 10, slowCount: 20,
    }) },
  { label: "epic plain run (80 stars — qualifies as long, not yet epic)",
    stats: profile({
      score: 4000, starsVisited: 80, blazingCount: 30, quickCount: 30, slowCount: 20,
      streakPeak: 10,
    }) },
  { label: "epic plain run (130 stars — past the spawn plateau)",
    stats: profile({
      score: 6500, starsVisited: 130, blazingCount: 50, quickCount: 45, slowCount: 35,
      streakPeak: 12, variants: { binary: 8, blackHole: 6, pulsar: 8 },
    }) },
  { label: "marathon binary chase (250 stars, high streak)",
    stats: profile({
      score: 13000, starsVisited: 250, blazingCount: 110, quickCount: 80, slowCount: 60,
      streakPeak: 12, variants: { binary: 18, pulsar: 12 },
    }) },
  // Epic surfaces ONLY when length is the standout — no dominant streak / capture style.
  { label: "epic balanced plain run (140 stars, no streak)",
    stats: profile({
      score: 5000, starsVisited: 140, blazingCount: 45, quickCount: 45, slowCount: 50,
      streakPeak: 2,
    }) },
  { label: "epic balanced void run (200 stars, low streak)",
    stats: profile({
      score: 9000, starsVisited: 200, blazingCount: 70, quickCount: 60, slowCount: 70,
      streakPeak: 3, variants: { blackHole: 6, binary: 4 },
    }) },
  // Launch-window suffix: lw=true on a meaningful run appends a "guided" tag. Below 5 stars
  // the suffix is suppressed since the hint barely had time to matter.
  { label: "binary-heavy WITH hint (lw=true)",
    stats: profile({
      score: 1500, starsVisited: 30,
      blazingCount: 10, quickCount: 10, slowCount: 10,
      streakPeak: 5, variants: { binary: 5 },
      launchWindow: true,
    }) },
  { label: "all-blazing WITH hint (lw=true)",
    stats: profile({
      score: 1500, starsVisited: 20, blazingCount: 20, streakPeak: 12,
      launchWindow: true,
    }) },
  { label: "comet hunter WITH hint (lw=true)",
    stats: profile({
      score: 600, starsVisited: 20, quickCount: 5, slowCount: 15, cometsCaught: 10,
      launchWindow: true,
    }) },
  { label: "2-star slow run WITH hint (lw=true, below threshold — no suffix)",
    stats: profile({ score: 25, starsVisited: 2, slowCount: 2, launchWindow: true }) },
  { label: "instant death WITH hint (lw=true — no suffix)",
    stats: profile({ deathCause: 1, launchWindow: true, seed: 1 }) },
];

console.log("Canonical cases:");
console.log("=".repeat(80));
for (const c of canonicals) {
  row(composeRunTitle(c.stats), c.label);
  console.log(`${" ".repeat(36)}  ${summary(c.stats)}`);
}

// Same stat profile with different seeds — confirms the within-pool selection varies even
// when the run is identical. (Find the "tight streak" canonical by label rather than index so
// reordering the array doesn't silently re-aim this test.)
console.log("\nSeed variation (same stats, different seeds — 'tight streak' profile):");
console.log("=".repeat(80));
const seedBase = canonicals.find((c) => c.label === "tight streak").stats;
for (let i = 1; i <= 12; i++) {
  const stats = { ...seedBase, seed: i * 1000003 };
  row(composeRunTitle(stats), `seed=${stats.seed}`);
}

// Aggregate variety check: a small random sweep with a stable RNG so the output is
// reproducible across CI / repeated runs of this script.
console.log("\nRandom profile sweep (40 runs, deterministic):");
console.log("=".repeat(80));
let _rng = 0xC0FFEE;
function rand() {
  _rng = (Math.imul(_rng, 0x9E3779B1) + 0x6D2B79F5) >>> 0;
  return _rng / 0x100000000;
}
function randInt(n) { return Math.floor(rand() * (n + 1)); }

const VARIANT_KEYS = [
  "binary", "blackHole", "monolith", "ringworld", "pulsar", "nebula",
];
const titleCounts = new Map();
for (let i = 0; i < 40; i++) {
  const stars = randInt(60);
  const blazing = randInt(stars);
  const quick = randInt(stars - blazing);
  const slow = stars - blazing - quick;
  const variants = {};
  for (const k of VARIANT_KEYS) variants[k] = randInt(Math.floor(stars / 12));
  if (rand() < 0.08) variants.azazel = 1;
  if (rand() < 0.08) variants.teapot = 1;
  const stats = profile({
    score: stars * 30 + randInt(stars * 30),
    starsVisited: stars,
    streakPeak: Math.min(12, randInt(stars + 1)),
    blazingCount: blazing,
    quickCount: quick,
    slowCount: slow,
    cometsCaught: randInt(Math.max(1, Math.floor(stars / 4))),
    variants,
    seed: randInt(0xFFFFFF) || 1,
  });
  const title = composeRunTitle(stats);
  titleCounts.set(title, (titleCounts.get(title) || 0) + 1);
  row(title, summary(stats));
}

console.log("\nUnique titles in random sweep:");
console.log("=".repeat(80));
const sorted = [...titleCounts.entries()].sort((a, b) => b[1] - a[1]);
for (const [title, count] of sorted) {
  console.log(`  ${count.toString().padStart(2)}× ${title}`);
}
console.log(`\n${sorted.length} unique titles across ${40} samples`);
