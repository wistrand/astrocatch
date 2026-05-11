// Run-title composer. Turns a run summary (or a decoded challenge code) into a short noun
// phrase like "the burning twins" or "the patient void". Deterministic: given the same stats
// + seed, returns the same title — so a challenge sender and recipient see the same label for
// the run, baked into the shareable identity of the code.
//
// Two-axis composition: an ADJECTIVE picked from the run's dominant style metric (how the
// player captured), and a NOUN picked from the dominant variant the player encountered (what
// they encountered). Words deliberately chosen specific (drum-tight, magpie, comet-eyed) over
// generic (great, mighty) so the lexicon doesn't drift into procgen-username territory.

// Style adjectives. The composer scores each style metric and picks the highest; the seed
// then picks within the family. 6 words per family so the 1/N appearance rate of any single
// word doesn't catch the eye over a session — at 4 words each, "darting" / "even" / etc.
// surfaced often enough to feel repetitive.
const STYLE_ADJ = {
  burning:  ["burning",  "blazing",    "scorching",   "sun-struck",  "feverish",  "wildfire"],
  swift:    ["swift",    "darting",    "fleet",       "quick-handed","lithe",     "dashing"],
  patient:  ["patient",  "deliberate", "steady",      "watchful",    "measured",  "biding"],
  rhythmic: ["rhythmic", "drum-tight", "locked-in",   "even",        "metered",   "sure-footed"],
  greedy:   ["greedy",   "magpie",     "comet-eyed",  "gilded",      "hoarding",  "shimmer-eyed"],
  long:     ["long",     "deep",       "far-running", "unbroken",    "enduring",  "sustained"],
  // `epic` sits above `long` for runs that pushed past the spawn-table's last row. Saturates
  // at EPIC_SATURATION stars (~100), so a 30-star and a 200-star run no longer share the
  // same style adjective. Pushed BEFORE `long` in the composer so it wins ties cleanly.
  epic:     ["endless",  "deep-time",  "year-long",   "marathon",    "ageless",   "fathomless"],
  spare:    ["quiet",    "still",      "spare",       "brief",       "bare",      "hushed"],
};

// Per-variant noun pools. Each variant gets 7 candidate words so two runs with the same
// dominant variant don't always share the same title. The seed picks within the pool. Reads as
// "the {adj} {noun}" without grammar surgery in every combination. Deliberately omits `teapot`
// and `azazel` — those are surprise-discovery variants and naming them in a shareable title
// would spoil the moment for anyone who opens the challenge link. Their encounters route
// through RARE_NOUN below instead. Key names match runStats.variants / the challenge-code
// census: 6 common variants. (BH binaries increment BOTH blackHole and binary in runStats —
// no separate bucket — so they can't be named distinctly here.)
const VARIANT_NOUN = {
  binary:    ["twins",  "pair",    "duet",    "tandem",   "waltz",      "kindred",    "mirror"],
  blackHole: ["void",   "maw",     "well",    "horizon",  "abyss",      "gulf",       "throat"],
  monolith:  ["slab",   "obelisk", "pillar",  "stone",    "spire",      "monument",   "sentinel"],
  ringworld: ["ring",   "band",    "halo",    "hoop",     "wheel",      "coronet",    "circuit"],
  pulsar:    ["beacon", "pulse",   "lantern", "signal",   "metronome",  "watchfire",  "flicker"],
  nebula:    ["cloud",  "veil",    "shroud",  "mist",     "haze",       "gauze",      "plume"],
};

// Weights for the "dominant variant" computation. Visually-distinct variants get a small
// bump so a single void encounter beats a handful of routine binaries.
const VARIANT_WEIGHT = {
  binary: 1.0, blackHole: 1.1,
  monolith: 1.3, ringworld: 1.2, pulsar: 1.0, nebula: 1.0,
};

// Rare / surprise variants that DO mark a run as special but stay unnamed in the title. Any
// run that touched one of these gets the oblique RARE_NOUN slot regardless of how many
// common variants the player also saw — the rare encounter IS the story, but the name stays
// behind.
const RARE_VARIANTS = ["teapot", "azazel"];
const RARE_NOUN = ["omen", "apparition", "rumor", "specter"];

// Fallback when every star was plain. Expanded to 8 words to dilute repetition — at 6 words
// each generic noun showed up ~17% of the time across all-plain runs.
const GENERIC_NOUN = [
  "drift", "passage", "crossing", "watch", "hunt", "voyage", "trek", "transit",
];

// 0-star runs (player died before capturing anything) get their own blunt vocabulary —
// "the still passage" read too contemplative for what's really a flubbed opening. These
// words name the failure without being mean.
const FAILED_ADJ = ["abrupt", "early", "luckless", "fleeting"];
const FAILED_NOUN = ["fumble", "misfire", "stumble", "slip", "miss", "blunder"];

// Suffix appended when the run was played with the launch-window indicator visible. The hint
// is a navigational aid; the suffix words frame "used the hint" as a craft choice rather than
// a crutch — `charted`, `sighted`, etc. read as nautical / aerospace tags. Only fires on runs
// of 5+ stars; below that the hint barely had time to do anything.
const GUIDED_SUFFIX = ["charted", "well-aimed", "sighted", "well-marked"];
const GUIDED_MIN_STARS = 5;

// Streak peak at or above this counts as fully "rhythmic". Captures at FAST_STREAK_CAP (12)
// happily exceed this — the metric saturates rather than overflowing.
const RHYTHMIC_SATURATION = 8;

// Stars-visited at or above this counts as fully "long".
const LONG_SATURATION = 30;

// Stars-visited at or above this counts as fully "epic" — separates the merely-long runs
// from the runs that pushed past the spawn-table's plateau.
const EPIC_SATURATION = 100;

// Below this stat-fraction the style metric is too weak to anchor a title; we fall back to
// "long" (5+ stars) or "spare" (<5 stars).
const STYLE_THRESHOLD = 0.3;

// Comets-per-star ratio at or above 1/4 counts as fully "greedy".
const GREEDY_PER_STAR = 4;

// Mix every stat field into a single 32-bit hash that drives word selection within each pool.
// Without this, two runs with the same seed but different outcomes (different score, streak,
// comet count, etc.) would pick identical words inside their style/variant families — only the
// FAMILY would vary by what the run actually was. Folding all the bits in means the title also
// reflects the gameplay detail. Mix uses Knuth's multiplier + xor-shift round, run-of-the-mill
// non-crypto mixing; output is determined by the same data both sender and recipient have, so
// the title stays in lockstep across the challenge link.
function statHash(stats) {
  let h = (stats.seed >>> 0) || 1;
  function mix(v) {
    // Two Knuth-multiplier rounds per stat field. Earlier this had `* 1` as the second
    // multiplier — a leftover that effectively skipped the round. The final fmix32-style
    // avalanche tail at the bottom of statHash still produced uniform output, but per-round
    // mixing is sharper with a real multiplier here.
    h = Math.imul(h ^ ((v | 0) + 0x9E3779B1), 0x85EBCA6B) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35) >>> 0;
  }
  mix(stats.score);
  mix(stats.starsVisited);
  mix(stats.streakPeak);
  mix(stats.blazingCount);
  mix(stats.quickCount);
  mix(stats.slowCount);
  mix(stats.cometsCaught);
  mix(stats.deathCause);
  mix(stats.launchWindow ? 1 : 0);
  const variants = stats.variants || {};
  // Sorted keys → stable hashing regardless of property insertion order.
  for (const k of Object.keys(variants).sort()) {
    mix(variants[k]);
  }
  // Final avalanche so high-bit slices aren't dominated by the last mixed value.
  h = Math.imul(h ^ (h >>> 16), 0x85EBCA6B) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export function composeRunTitle(stats) {
  const blazing = stats.blazingCount || 0;
  const quick   = stats.quickCount   || 0;
  const slow    = stats.slowCount    || 0;
  const total   = blazing + quick + slow;
  const stars   = stats.starsVisited || 0;
  const streak  = stats.streakPeak   || 0;
  const comets  = stats.cometsCaught || 0;
  // `hash` mixes seed + every stat field, so word picks within each pool vary with the run's
  // actual outcome — not just the seed. Different bit-slices of the same hash feed each pool
  // (adj, noun, suffix, …) so the slices stay uncorrelated.
  const hash = statHash(stats);

  // 0-star runs short-circuit through the failure vocabulary. The composer's "spare" branch
  // doesn't differentiate "I caught two and called it a day" from "I died on the first tap"
  // — those two cases want very different titles.
  if (stars === 0) {
    const adj = FAILED_ADJ[hash % FAILED_ADJ.length];
    const noun = FAILED_NOUN[(hash >>> 5) % FAILED_NOUN.length];
    return `the ${adj} ${noun}`;
  }

  // Score each style. The order pushed below is also the tiebreaker order — when two styles
  // score equally, the one pushed first wins (ES2019+ stable sort). burning/swift/patient
  // are pushed first so they win over rhythmic when a run mixes both qualities.
  const styles = [];
  if (total > 0) {
    styles.push(["burning", blazing / total]);
    styles.push(["swift",   quick   / total]);
    styles.push(["patient", slow    / total]);
  }
  styles.push(["rhythmic", Math.min(1, streak / RHYTHMIC_SATURATION)]);
  if (stars > 0) {
    styles.push(["greedy", Math.min(1, (comets / stars) * GREEDY_PER_STAR)]);
  }
  // `epic` pushed before `long` so it wins ties at very high star counts (both saturate at 1
  // for runs past 100 stars; insertion order then decides via the stable sort).
  styles.push(["epic", Math.min(1, stars / EPIC_SATURATION)]);
  styles.push(["long", Math.min(1, stars / LONG_SATURATION)]);
  styles.push(["spare", stars < 5 ? 1 : 0]);

  styles.sort((a, b) => b[1] - a[1]);
  const styleName = (styles[0]?.[1] ?? 0) >= STYLE_THRESHOLD
    ? styles[0][0]
    : (stars >= 5 ? "long" : "spare");

  // Rare-variant override: if the player encountered one of the surprise variants, the noun
  // routes through RARE_NOUN regardless of how many common variants they also saw. This both
  // (a) signals "something special happened" in the title and (b) keeps the rare variant's
  // name out of any shareable label.
  const variants = stats.variants || {};
  const sawRare = RARE_VARIANTS.some((k) => (variants[k] || 0) > 0);

  // Dominant common variant (only consulted when no rare encounter happened).
  let topKey = null;
  let topW = 0;
  for (const k of Object.keys(VARIANT_NOUN)) {
    const w = (variants[k] || 0) * (VARIANT_WEIGHT[k] || 1);
    if (w > topW) { topW = w; topKey = k; }
  }

  // Deterministic word choice. Each pool reads its own hash slice; shifts are far enough apart
  // (0, 5, 11, 17, 23) that the post-avalanche bits feed each slot independently.
  const adjList = STYLE_ADJ[styleName];
  const adj = adjList[hash % adjList.length];
  let noun;
  if (sawRare) {
    noun = RARE_NOUN[(hash >>> 11) % RARE_NOUN.length];
  } else if (topKey) {
    const nounList = VARIANT_NOUN[topKey];
    noun = nounList[(hash >>> 11) % nounList.length];
  } else {
    noun = GENERIC_NOUN[(hash >>> 11) % GENERIC_NOUN.length];
  }

  // Launch-window suffix: appended when the player had the hint indicator on for a run of
  // meaningful length. Reads as a craft note ("the burning twins, charted") rather than a
  // call-out — using the hint is a legitimate way to play, not a crutch. Suffix word picked
  // from its own hash slice so it doesn't move in lockstep with adj/noun.
  if (stats.launchWindow && stars >= GUIDED_MIN_STARS) {
    const suffix = GUIDED_SUFFIX[(hash >>> 23) % GUIDED_SUFFIX.length];
    return `the ${adj} ${noun}, ${suffix}`;
  }
  return `the ${adj} ${noun}`;
}
