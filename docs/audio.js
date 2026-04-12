// Procedural WebAudio sound effects for ASTROCATCH. All sounds
// are synthesized at playback time from OscillatorNode +
// BiquadFilterNode + GainNode — no audio files, no loading,
// no network. Browser-only, never imported by the node test
// runner.
//
// Autoplay-policy gotcha: AudioContext creation is deferred to
// the first play call, which always happens inside a user
// gesture (pointer tap, key press, or START click). Chrome lets
// you create a suspended context earlier, but Safari refuses
// unless you're inside a gesture handler — the lazy path works
// on both.

const STORAGE_KEY = "astrocatch_muted";
const MASTER_VOLUME = 0.32;
const MUSIC_VOLUME = 0.10;

// ─────────────────────────────────────────────────────────────
// 2D simplex noise. Used by the music layer to walk a melody
// smoothly through the scale — simplex gives coherent variation
// across both inputs, so the lead line drifts like a contour
// instead of random-walking like white noise. Minimal adaptation
// of Stefan Gustavson's reference implementation.
// Returns values in roughly [-1, 1].
// ─────────────────────────────────────────────────────────────
const NOISE_GRAD = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
];
const NOISE_PERM = new Uint8Array(512);
(function initNoisePerm() {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  // Fixed Lehmer-RNG seed so the melody contour is deterministic
  // across sessions. Re-seed here if you ever want a different
  // different harmonic landscape. The seed controls the noise
  // FIELD, not the path through it — sampling coordinates are
  // wall-clock-derived (audio time), so the exact played notes
  // vary between sessions even with the same seed.
  let seed = 20260412;
  for (let i = 255; i > 0; i--) {
    seed = (seed * 16807) % 2147483647;
    const j = seed % (i + 1);
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }
  for (let i = 0; i < 512; i++) NOISE_PERM[i] = p[i & 255];
})();
const NOISE_F2 = 0.5 * (Math.sqrt(3) - 1);
const NOISE_G2 = (3 - Math.sqrt(3)) / 6;
export function simplex2(x, y) {
  const s = (x + y) * NOISE_F2;
  const i = Math.floor(x + s);
  const j = Math.floor(y + s);
  const T = (i + j) * NOISE_G2;
  const X0 = i - T;
  const Y0 = j - T;
  const x0 = x - X0;
  const y0 = y - Y0;
  let i1, j1;
  if (x0 > y0) { i1 = 1; j1 = 0; }
  else { i1 = 0; j1 = 1; }
  const x1 = x0 - i1 + NOISE_G2;
  const y1 = y0 - j1 + NOISE_G2;
  const x2 = x0 - 1 + 2 * NOISE_G2;
  const y2 = y0 - 1 + 2 * NOISE_G2;
  const ii = i & 255;
  const jj = j & 255;
  const gi0 = NOISE_PERM[ii + NOISE_PERM[jj]] & 7;
  const gi1 = NOISE_PERM[ii + i1 + NOISE_PERM[jj + j1]] & 7;
  const gi2 = NOISE_PERM[ii + 1 + NOISE_PERM[jj + 1]] & 7;
  let t0 = 0.5 - x0 * x0 - y0 * y0;
  let n0 = 0;
  if (t0 >= 0) {
    t0 *= t0;
    n0 = t0 * t0 * (NOISE_GRAD[gi0][0] * x0 + NOISE_GRAD[gi0][1] * y0);
  }
  let t1 = 0.5 - x1 * x1 - y1 * y1;
  let n1 = 0;
  if (t1 >= 0) {
    t1 *= t1;
    n1 = t1 * t1 * (NOISE_GRAD[gi1][0] * x1 + NOISE_GRAD[gi1][1] * y1);
  }
  let t2 = 0.5 - x2 * x2 - y2 * y2;
  let n2 = 0;
  if (t2 >= 0) {
    t2 *= t2;
    n2 = t2 * t2 * (NOISE_GRAD[gi2][0] * x2 + NOISE_GRAD[gi2][1] * y2);
  }
  return 70 * (n0 + n1 + n2);
}

// ─────────────────────────────────────────────────────────────
// Music constants — a four-bar loop in A minor, Am → F → C → G,
// 100 BPM, 16 sixteenth-note steps per bar. The bass plays the
// chord root on every quarter note, the arpeggio rolls through
// the chord tones on 8th notes, and a simplex-walked lead line
// fires every half note picking from an A-minor pentatonic
// scale. One complete loop = 4 bars × 16 steps = 64 steps.
// ─────────────────────────────────────────────────────────────
const MUSIC_BPM = 114;
const MUSIC_STEPS_PER_BAR = 16;
// One "section" is a 4-bar progression. At section boundaries
// the scheduler re-reads the caller-supplied intensity and
// picks a new progression from MUSIC_PROGRESSIONS, so the loop
// seam is also the moment the song can change its mood.
const MUSIC_BARS = 4;
const MUSIC_TOTAL_STEPS = MUSIC_STEPS_PER_BAR * MUSIC_BARS;
const MUSIC_STEP_SEC = 60 / MUSIC_BPM / 4; // 16th note
// Lookahead and tick rate for the music scheduler. The
// scheduler is a setTimeout loop running on the main thread,
// so anything that blocks the main thread (touch handlers,
// boost() running up-to-48 prediction integrations, physics
// ticks, render frames, GC pauses) can delay the next tick.
// If the block exceeds the lookahead, the audio engine runs
// out of pre-queued events and underruns → click.
//
// 500 ms lookahead gives ~5× the worst-case main-thread stall
// we've actually measured, so an active touch interaction on
// Chrome Android no longer empties the queue. The 100 ms tick
// interval halves the scheduler's own main-thread CPU share
// compared to the previous 50 ms, reducing contention. The
// 5× tick-to-lookahead ratio stays within Chris Wilson's
// WebAudio scheduling guidelines. Mute is unaffected because
// master/musicBus gain changes apply immediately regardless
// of what's already queued to the audio engine.
const MUSIC_SCHEDULE_AHEAD = 1.0;          // seconds
const MUSIC_SCHEDULE_INTERVAL = 108;       // ms
// Minimum time in the future for any scheduled note. After a
// resync (or on the very first tick), we guarantee scheduled
// events are at least this far ahead of the audio clock so
// brief main-thread delays between scheduleStep() calls can't
// push them into the past. 30 ms covers typical render-frame
// jank on mobile Chrome / Firefox Android.
const MUSIC_SAFETY_MARGIN = 0.03;          // seconds
const MUSIC_MAX_STEPS_PER_TICK = 32;       // clamp if tab stalled

// Chord-root frequencies for the bass (low octave). Index is
// looked up through `MUSIC_PROGRESSIONS[tier][bar]` at runtime,
// so adding a new chord means extending all three parallel
// tables below (bass / arp / lead) at the same index.
const MUSIC_BASS = [
  110.00, // 0: A2  — Am
   87.31, // 1: F2  — F
  130.81, // 2: C3  — C
   98.00, // 3: G2  — G
   73.42, // 4: D2  — Dm
   82.41, // 5: E2  — E major (V of A minor, dominant pull)
   82.41, // 6: E2  — E minor (v of A minor, natural minor)
  116.54, // 7: Bb2 — Bb major (bII Neapolitan, dramatic color)
];
// Arpeggio chord tones, one octave up. Three notes per chord,
// cycled at 8th-note rate. Each entry must have at least 1
// tone — musicArp, musicPad, and musicStab all iterate
// chord.length, and arpIdx uses % chord.length which would
// divide by zero on an empty array.
const MUSIC_ARP = [
  [220.00, 261.63, 329.63], // 0: Am — A3, C4, E4
  [174.61, 220.00, 261.63], // 1: F  — F3, A3, C4
  [261.63, 329.63, 392.00], // 2: C  — C4, E4, G4
  [196.00, 246.94, 293.66], // 3: G  — G3, B3, D4
  [146.83, 174.61, 220.00], // 4: Dm — D3, F3, A3
  [164.81, 207.65, 246.94], // 5: E  — E3, G#3, B3
  [164.81, 196.00, 246.94], // 6: Em — E3, G3, B3
  [233.08, 293.66, 349.23], // 7: Bb — Bb3, D4, F4
];
// Per-chord lead scale — chord tones over two octaves, so every
// lead note the simplex picks is guaranteed to sit on the
// current chord instead of drifting off into scale territory
// that doesn't belong. Keeps the melody sounding composed
// rather than "random walk through the pentatonic".
const MUSIC_LEAD = [
  // 0: Am — A, C, E
  [220.00, 261.63, 329.63, 440.00, 523.25, 659.26, 880.00],
  // 1: F  — F, A, C
  [174.61, 220.00, 261.63, 349.23, 440.00, 523.25, 698.46],
  // 2: C  — C, E, G
  [261.63, 329.63, 392.00, 523.25, 659.26, 783.99, 1046.50],
  // 3: G  — G, B, D
  [196.00, 246.94, 293.66, 392.00, 493.88, 587.33, 783.99],
  // 4: Dm — D, F, A
  [146.83, 174.61, 220.00, 293.66, 349.23, 440.00, 587.33],
  // 5: E  — E, G#, B
  [164.81, 207.65, 246.94, 329.63, 415.30, 493.88, 659.26],
  // 6: Em — E, G, B
  [164.81, 196.00, 246.94, 329.63, 392.00, 493.88, 659.26],
  // 7: Bb — Bb, D, F
  [233.08, 293.66, 349.23, 466.16, 587.33, 698.46, 932.33],
];

// Intensity-tiered chord progressions. Each tier is a 4-bar
// progression selected at section boundaries (every 4 bars)
// based on the caller-supplied intensity in [0, 1]. Tier 0 is
// the default/starting state; tiers escalate from there.
//
//   tier 0 (calm):    Am F C G   — familiar minor descent
//   tier 1 (medium):  Dm Am F C  — minor-tinted, pulls through Dm
//   tier 2 (intense): Am G F E   — descending-bass to the V
//                                  chord, which creates strong
//                                  harmonic tension wanting to
//                                  resolve back to Am on the
//                                  next section's downbeat.
// Two progressions per tier, alternated each 4-bar section.
// The wider harmonic pool (8 chords, 6 progressions) means the
// music doesn't repeat the same 4-bar sequence back-to-back.
const MUSIC_PROGRESSIONS = [
  // Tier 0 (calm) — gentle minor descents
  [0, 1, 2, 3],    // 0A: Am F C G
  [0, 6, 1, 3],    // 0B: Am Em F G
  // Tier 1 (medium) — minor-tinted with more movement
  [4, 0, 1, 2],    // 1A: Dm Am F C
  [4, 1, 0, 3],    // 1B: Dm F Am G
  // Tier 2 (intense) — dominant pull + Neapolitan tension
  [0, 3, 1, 5],    // 2A: Am G F E
  [4, 7, 1, 5],    // 2B: Dm Bb F E (Neapolitan Bb via smoother Dm→Bb)
];
// Thresholds at which the tier index bumps up. Read as:
// intensity < 0.20 → tier 0, < 0.45 → tier 1, else tier 2.
// These are deliberately lower than the obvious "equal thirds"
// split because ball speed in actual gameplay rarely exceeds
// ~10/16 of MAX_SPEED for sustained stretches, and we want
// tier 2 to be reachable when the player is actively boosting.
const MUSIC_INTENSITY_THRESHOLDS = [0.20, 0.45];

// Lead rhythm pattern bank — each entry is a list of step
// positions within a bar where a lead note fires. Spans from
// sparsest (1 note on the downbeat) to busiest (4 notes with
// syncopation). Per-bar pattern selection pulls from a tier-
// restricted window of this bank, so tier 0 gets gentle
// rhythms, tier 2 gets driving ones, and there's always room
// for pattern-to-pattern variation within a tier.
const MUSIC_LEAD_PATTERNS = [
  [0],              // 0: sparsest — one note, long tail
  [0, 8],           // 1: two half notes
  [0, 6],           // 2: syncopated two-note
  [0, 6, 12],       // 3: dotted-quarter feel
  [0, 4, 10],       // 4: offset triple
  [4, 10, 14],      // 5: delayed entrance, pickup to next bar
  [0, 4, 8, 12],    // 6: steady quarter notes
  [0, 6, 10, 14],   // 7: busy syncopated four
];
// Inclusive start, exclusive end windows into MUSIC_LEAD_PATTERNS.
// Tier 0 uses the sparsest half, tier 2 the busiest half, and
// tier 1 overlaps the middle. Each window is 4 patterns wide so
// the simplex-driven picker always has meaningful choice.
const MUSIC_LEAD_PATTERN_RANGES = [
  [0, 4], // tier 0: patterns 0-3
  [1, 5], // tier 1: patterns 1-4
  [4, 8], // tier 2: patterns 4-7
];

// Bass rhythm pattern bank — same idea as the lead bank. Each
// entry is a list of step positions in a bar where the bass
// fires. Calm tiers use sparser patterns, intense tiers use
// busier ones. On non-downbeat hits, the bass occasionally
// plays the fifth of the chord instead of the root (see
// scheduleStep) for melodic movement.
const MUSIC_BASS_PATTERNS = [
  [0],              // 0: just the downbeat
  [0, 8],           // 1: half notes
  [0, 4, 12],       // 2: skip beat 3
  [0, 4, 8, 12],    // 3: quarter notes (the old default)
  [0, 6, 12],       // 4: dotted-quarter syncopation
  [0, 4, 10, 14],   // 5: busy syncopated
  [0, 4, 6, 12],    // 6: with a ghost-note
];
const MUSIC_BASS_PATTERN_RANGES = [
  [0, 3], // tier 0: patterns 0-2 (sparse)
  [1, 5], // tier 1: patterns 1-4
  [3, 7], // tier 2: patterns 3-6 (busy)
];

export function createAudio() {
  // Sanity check: every chord index referenced by the
  // progressions must exist in all three parallel tables.
  // Catches table-length drift at init instead of at a random
  // runtime moment minutes into gameplay.
  const maxChordIdx = MUSIC_PROGRESSIONS.reduce(
    (mx, p) => p.reduce((a, b) => Math.max(a, b), mx), 0
  );
  if (
    maxChordIdx >= MUSIC_BASS.length ||
    maxChordIdx >= MUSIC_ARP.length ||
    maxChordIdx >= MUSIC_LEAD.length
  ) {
    throw new Error(
      "MUSIC_PROGRESSIONS references chord index " + maxChordIdx +
      " but MUSIC_BASS/ARP/LEAD only have " +
      Math.min(MUSIC_BASS.length, MUSIC_ARP.length, MUSIC_LEAD.length) + " entries"
    );
  }

  let ctx = null;
  let master = null;
  let musicBus = null;
  let muted = false;
  // Music scheduler state. `musicIntended` tracks whether the
  // caller wants music playing; the actual scheduler can be
  // paused independently (e.g. on tab hide) and resumed without
  // losing the intent.
  let musicIntended = false;
  let schedulerRunning = false;
  let schedulerTimerId = null;
  let nextStepTime = 0;
  let currentStep = 0;
  // Dynamic intensity — caller-supplied scalar in [0, 1]. The
  // scheduler samples it at each section boundary to pick a
  // progression from MUSIC_PROGRESSIONS. `currentTier` is the
  // active quantized tier (0, 1, or 2); `activeProgression`
  // is the chord-index array for the current 4-bar section.
  let currentIntensity = 0;
  let currentTier = 0;
  let activeProgression = MUSIC_PROGRESSIONS[0];
  let sectionCount = 0;
  // Streak-driven tempo. Base is MUSIC_BPM; each streak level
  // adds a small BPM bump, capped so the music doesn't become
  // frantic. Updated at section boundaries so tempo never
  // shifts mid-bar.
  const MUSIC_BPM_MAX = 132;
  let currentStreak = 0;
  let currentStepSec = MUSIC_STEP_SEC;
  // Which lead-rhythm pattern is active for the current bar.
  // Re-picked from MUSIC_LEAD_PATTERNS at each bar downbeat via
  // a simplex sample, so the rhythmic shape of the melody
  // varies across bars even within a single tier.
  let currentLeadPattern = MUSIC_LEAD_PATTERNS[1];
  let currentBassPattern = MUSIC_BASS_PATTERNS[3];
  try {
    muted = localStorage.getItem(STORAGE_KEY) === "1";
  } catch (_) {
    // localStorage can throw in some private-browsing modes.
    // Default to not muted and ignore persistence.
  }

  // Lazy context creation. Returns the AudioContext on success
  // or null if WebAudio is unavailable / creation fails. Also
  // resumes a suspended context, which is the state Chrome uses
  // until the first user gesture.
  function ensure() {
    if (!ctx) {
      try {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return null;
        // latencyHint: "playback" — tells the browser to
        // prioritise smooth playback over low-latency
        // response, which means bigger audio output buffers.
        // Firefox on Android's cubeb backend is particularly
        // sensitive to main-thread jitter under the default
        // "interactive" hint; with "playback" it uses larger
        // buffers and is much less click-prone. The trade-off
        // is ~100 ms of latency on the boost/capture/death
        // SFX, which is below the perceptual threshold for an
        // orbital game where audio-visual sync isn't tight.
        try {
          ctx = new Ctor({ latencyHint: "playback" });
        } catch (_) {
          // Very old Safari rejects the options bag; fall
          // back to a no-args construction.
          ctx = new Ctor();
        }
        master = ctx.createGain();
        master.gain.value = muted ? 0 : MASTER_VOLUME;
        // Soft safety limiter before the destination, only on
        // the SFX path. With Blazing captures playing 4
        // overlapping notes each with a bell overtone,
        // worst-case in-phase peaks can approach unity; the
        // compressor keeps those peaks under control. It is
        // NOT on the music path — the compressor's 3 ms attack
        // was clicking on every downbeat where bass + stab
        // hit simultaneously, and the continuous nature of
        // music kept the compressor in a constant engage/
        // release cycle. Music gets a direct path to the
        // destination via musicBus below; it has plenty of
        // headroom already.
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -10;
        comp.knee.value = 8;
        comp.ratio.value = 2.5;
        comp.attack.value = 0.02;
        comp.release.value = 0.25;
        master.connect(comp).connect(ctx.destination);
        // Music bus — direct to destination, bypassing the
        // SFX compressor. Muted by its own gain node, kept in
        // sync with master via setMuted so M toggles both.
        musicBus = ctx.createGain();
        musicBus.gain.value = muted ? 0 : MUSIC_VOLUME;
        musicBus.connect(ctx.destination);
        // Silent pre-warm oscillator — a single sine running
        // forever at zero gain, kept in the graph so the
        // output hardware stays in "active" state. Some mobile
        // audio backends (notably Firefox Android) click or
        // drop samples when the output wakes from an idle
        // state between events. Keeping a constant (inaudible)
        // signal in the pipeline prevents the hardware from
        // ever entering that idle state. Cost: one sine's
        // worth of DSP, below any metering threshold.
        const warmOsc = ctx.createOscillator();
        const warmGain = ctx.createGain();
        warmGain.gain.value = 0;
        warmOsc.frequency.setValueAtTime(40, ctx.currentTime);
        warmOsc.connect(warmGain).connect(ctx.destination);
        warmOsc.start();
        // warmOsc is intentionally never stopped — it runs
        // for the lifetime of the AudioContext.
      } catch (_) {
        ctx = null;
        return null;
      }
    }
    if (ctx.state === "suspended") {
      // Fire and forget — resume() returns a promise but we
      // don't need to await it to schedule nodes correctly.
      ctx.resume();
    }
    return ctx;
  }

  function setMuted(m) {
    muted = !!m;
    try {
      localStorage.setItem(STORAGE_KEY, muted ? "1" : "0");
    } catch (_) {}
    if (ctx) {
      // Smooth volume change so toggling mid-sound doesn't
      // click. Now that music bypasses the SFX compressor
      // path, mute has to drive both buses independently.
      const now = ctx.currentTime;
      if (master) {
        master.gain.cancelScheduledValues(now);
        master.gain.setTargetAtTime(muted ? 0 : MASTER_VOLUME, now, 0.05);
      }
      if (musicBus) {
        musicBus.gain.cancelScheduledValues(now);
        musicBus.gain.setTargetAtTime(muted ? 0 : MUSIC_VOLUME, now, 0.05);
      }
    }
  }

  function isMuted() {
    return muted;
  }

  // ── boost: happy ascending launch. Two sine waves an octave
  // apart, both sweeping UP a perfect fifth (A5 → E6, A4 → E5)
  // through an open lowpass, for a bright optimistic blip. A
  // rising perfect fifth is the opening interval of "Twinkle
  // Twinkle" and the Star Wars fanfare — universally upbeat.
  // Sines on both voices keep it sweet; the octave stacking
  // gives body without making it heavy. ~230 ms total.
  function boost() {
    const c = ensure();
    if (!c || muted) return;
    const t = c.currentTime;
    const dur = 0.23;

    // Open lowpass — bright through the attack, gently darkens
    // on the tail so the last bit isn't shrill.
    const filter = c.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 0.8;
    filter.frequency.setValueAtTime(3200, t);
    filter.frequency.exponentialRampToValueAtTime(1400, t + dur);

    const outGain = c.createGain();
    outGain.gain.setValueAtTime(0.0001, t);
    outGain.gain.exponentialRampToValueAtTime(0.42, t + 0.012);
    outGain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    // Rising perfect fifth: A5 → E6. Pitch reaches the top
    // slightly before the envelope tails so the ear locks onto
    // the destination note rather than the slide. A small
    // random detune per call (±4 cents) breaks up back-to-back
    // identicalness on tap chains.
    const sweepEnd = t + dur * 0.75;
    const loStart = 440;     // A4
    const loEnd   = 659.25;  // E5
    const hiStart = 880;     // A5
    const hiEnd   = 1318.51; // E6
    const detuneCents = (Math.random() - 0.5) * 8;

    // Upper voice
    const hi = c.createOscillator();
    hi.type = "sine";
    hi.detune.value = detuneCents;
    hi.frequency.setValueAtTime(hiStart, t);
    hi.frequency.exponentialRampToValueAtTime(hiEnd, sweepEnd);
    hi.connect(filter);
    hi.start(t);
    hi.stop(t + dur + 0.05);

    // Lower voice — octave down for body.
    const lo = c.createOscillator();
    lo.type = "sine";
    lo.detune.value = detuneCents;
    lo.frequency.setValueAtTime(loStart, t);
    lo.frequency.exponentialRampToValueAtTime(loEnd, sweepEnd);
    lo.connect(filter);
    lo.start(t);
    lo.stop(t + dur + 0.05);

    filter.connect(outGain).connect(master);
  }

  // ── capture: arpeggio chime through an A-major triad.
  // Each tier voices more of the chord — regular plays root+5th,
  // Quick plays root+3rd+5th, Blazing plays root+3rd+5th+octave.
  // Per-note bell timbre: sine fundamental + soft 2× overtone.
  // Streak adds a high shimmer after the last arpeggio note.
  function capture(bonus, streak) {
    const c = ensure();
    if (!c || muted) return;
    const t = c.currentTime;

    // A-major triad pitches (Hz). Third and fifth live a major
    // third and perfect fifth ABOVE the root — not below — so
    // the pattern [root, third, fifth, high] is a true ascending
    // arpeggio. A small per-call random detune (±4 cents) keeps
    // consecutive captures from sounding mechanically identical
    // while preserving the chord's internal intonation.
    const octave = bonus >= 3 ? 2 : 1;
    const root   = 220 * Math.pow(2, octave);     // A4 or A5
    const third  = 277.18 * Math.pow(2, octave);  // C#5 or C#6
    const fifth  = 329.63 * Math.pow(2, octave);  // E5 or E6
    const high   = 440 * Math.pow(2, octave);     // A5 or A6
    const detuneCents = (Math.random() - 0.5) * 8;

    const pattern =
      bonus >= 3 ? [root, third, fifth, high]
      : bonus >= 2 ? [root, third, fifth]
      : [root, fifth];

    const stepDur = 0.055;
    const noteDur = 0.55;

    pattern.forEach((freq, i) => {
      const start = t + i * stepDur;
      // Fundamental — sine for a clean bell attack.
      const osc = c.createOscillator();
      osc.type = "sine";
      osc.detune.value = detuneCents;
      osc.frequency.setValueAtTime(freq, start);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.32, start + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, start + noteDur);
      osc.connect(g).connect(master);
      osc.start(start);
      osc.stop(start + noteDur + 0.05);

      // Slightly inharmonic overtone for bell character.
      const osc2 = c.createOscillator();
      osc2.type = "sine";
      osc2.detune.value = detuneCents;
      osc2.frequency.setValueAtTime(freq * 2.01, start);
      const g2 = c.createGain();
      g2.gain.setValueAtTime(0.0001, start);
      g2.gain.exponentialRampToValueAtTime(0.09, start + 0.006);
      g2.gain.exponentialRampToValueAtTime(0.0001, start + noteDur * 0.7);
      osc2.connect(g2).connect(master);
      osc2.start(start);
      osc2.stop(start + noteDur);
    });

    if (streak && streak >= 2) {
      // Streak shimmer — high sine sweeping upward a fifth,
      // pitched higher with longer streaks so the player can
      // hear the chain grow even with eyes on the trajectory.
      const start = t + pattern.length * stepDur + 0.02;
      const climb = Math.min(1 + (streak - 2) * 0.14, 1.8);
      const base = 880 * climb;
      const osc = c.createOscillator();
      osc.type = "sine";
      osc.detune.value = detuneCents;
      osc.frequency.setValueAtTime(base, start);
      osc.frequency.exponentialRampToValueAtTime(base * 1.5, start + 0.22);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.18, start + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
      osc.connect(g).connect(master);
      osc.start(start);
      osc.stop(start + 0.4);
    }
  }

  // ── comet: quick ascending sparkle. Three high sine notes
  // in rapid succession — a bright "ting-ting-ting" that reads
  // as "collected something shiny". E6 → G#6 → C7 traces a
  // major triad upward for a resolved, positive feel.
  function comet() {
    const c = ensure();
    if (!c || muted) return;
    const t = c.currentTime;
    const notes = [1318.51, 1661.22, 2093.00]; // E6, G#6, C7
    for (let i = 0; i < notes.length; i++) {
      const start = t + i * 0.055;
      const osc = c.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(notes[i], start);
      // Slight inharmonic overtone for bell shimmer.
      const osc2 = c.createOscillator();
      osc2.type = "sine";
      osc2.frequency.setValueAtTime(notes[i] * 2.01, start);
      const g = c.createGain();
      g.gain.value = 0;
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(0.28, start + 0.005);
      g.gain.linearRampToValueAtTime(0, start + 0.25);
      g.gain.setValueAtTime(0, start + 0.26);
      const g2 = c.createGain();
      g2.gain.value = 0;
      g2.gain.setValueAtTime(0, start);
      g2.gain.linearRampToValueAtTime(0.08, start + 0.005);
      g2.gain.linearRampToValueAtTime(0, start + 0.18);
      g2.gain.setValueAtTime(0, start + 0.19);
      osc.connect(g).connect(master);
      osc2.connect(g2).connect(master);
      osc.start(start);
      osc.stop(start + 0.3);
      osc2.start(start);
      osc2.stop(start + 0.22);
    }
  }

  // ── death (escape): falling three-note minor descent through a
  // closing lowpass. Notes are A3, F3, D3 — wilting away into space.
  function death() {
    const c = ensure();
    if (!c || muted) return;
    const t = c.currentTime;

    const filter = c.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 1.8;
    filter.frequency.setValueAtTime(1400, t);
    filter.frequency.exponentialRampToValueAtTime(180, t + 0.8);

    const mix = c.createGain();
    mix.gain.value = 1.0;
    filter.connect(mix).connect(master);

    const notes = [220, 174.61, 146.83]; // A3, F3, D3
    const step = 0.16;
    notes.forEach((freq, i) => {
      const start = t + i * step;
      const osc = c.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(freq, start);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.6, start + 0.45);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.32, start + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.55);
      osc.connect(g).connect(filter);
      osc.start(start);
      osc.stop(start + 0.6);
    });
  }

  // ── deathCrash (star collision): soft descending droplet —
  // sine tones with a gentle pitch slide, like a bubble being
  // absorbed. Notes are A4, E4, C4 through a warm lowpass.
  function deathCrash() {
    const c = ensure();
    if (!c || muted) return;
    const t = c.currentTime;

    const filter = c.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 3.0;
    filter.frequency.setValueAtTime(2400, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + 0.9);

    const mix = c.createGain();
    mix.gain.value = 1.0;
    filter.connect(mix).connect(master);

    const notes = [440, 329.63, 261.63]; // A4, E4, C4
    const step = 0.14;
    notes.forEach((freq, i) => {
      const start = t + i * step;
      const osc = c.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, start);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.82, start + 0.35);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, start);
      g.gain.linearRampToValueAtTime(0.25, start + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.45);
      osc.connect(g).connect(filter);
      osc.start(start);
      osc.stop(start + 0.5);
    });
  }

  // ─────────────────────────────────────────────────────────
  // Music layer — sustained chord pad + saw-plus-sub bass +
  // rolling 8th-note triangle arpeggio + a sine lead walked
  // through chord tones by simplex noise. Scheduled ahead of
  // the audio clock via setTimeout so the scheduler can stay
  // alive during frame drops without losing timing.
  // ─────────────────────────────────────────────────────────
  function musicBass(freq, time) {
    const c = ctx;
    // Sawtooth + sub-sine through a filter envelope. The sweep
    // from 180 Hz up to 1100 Hz at the attack and back down to
    // 260 Hz over the note length is the "bwamp" character of
    // an analog synth bass — the filter movement is doing most
    // of the perceived shape, not the amplitude envelope. Low
    // Q avoids the resonant honk that wrecked the first pass.
    const dur = 0.38;

    // Main saw — warm, rich harmonics.
    const osc = c.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(freq, time);
    osc.detune.value = (Math.random() - 0.5) * 4;

    // Sub sine an octave below — gives the low end actual
    // weight without muddying the harmonic content. Skip the
    // octave-down for low roots whose sub would land below
    // ~55 Hz, where small speakers (mobile, laptop) resonate
    // / distort instead of reproducing cleanly.
    const subFreq = freq * 0.5 >= 55 ? freq * 0.5 : freq;
    const sub = c.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(subFreq, time);
    const subGain = c.createGain();
    subGain.gain.value = 0.55;
    sub.connect(subGain);

    // Filter envelope: muffled → bright → warm close. This is
    // the main shaper of the bass tone.
    const filter = c.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 0.8;
    filter.frequency.setValueAtTime(180, time);
    filter.frequency.exponentialRampToValueAtTime(1100, time + 0.015);
    filter.frequency.exponentialRampToValueAtTime(260, time + dur);

    // Amplitude envelope — all-linear. Previously had a mix of
    // exponential decay + linear tail, which iOS Safari could
    // click at the handoff between ramp types. All-linear
    // avoids that entirely, at a perceptually-negligible cost
    // for 380 ms envelopes. Ends with setValueAtTime(0) to
    // explicitly nail the gain to zero past the ramp's end in
    // case float precision leaves it at 1e-n instead of exact
    // zero — the oscillator stops 30 ms after that anchor.
    const g = c.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(0.45, time + 0.018);
    g.gain.linearRampToValueAtTime(0, time + dur);
    g.gain.setValueAtTime(0, time + dur + 0.002);

    osc.connect(filter);
    subGain.connect(filter);
    filter.connect(g);
    g.connect(musicBus);

    osc.start(time);
    osc.stop(time + dur + 0.03);
    sub.start(time);
    sub.stop(time + dur + 0.03);
    osc.onended = () => { osc.disconnect(); sub.disconnect(); subGain.disconnect(); filter.disconnect(); g.disconnect(); };
  }

  // Sustained chord pad for the full bar. Three detuned-sine
  // pairs (one per chord tone) with a slow attack and release
  // so the bar feels harmonically "held" underneath the
  // arpeggio and bass instead of just rhythmically pulsed.
  // Envelope is click-safe: linear attack from zero, linear
  // release all the way to zero before the oscillator stops.
  function musicPad(chord, time, dur) {
    const c = ctx;
    const attack = 0.35;
    const release = 0.45;
    const holdEnd = time + dur - release;
    for (let i = 0; i < chord.length; i++) {
      const freq = chord[i];
      const g = c.createGain();
      // All-linear envelope. The "hold" is a linear ramp from
      // 0.16 to 0.16 — a defined no-op in the linear
      // automation path, but avoids the iOS Safari bug where
      // setValueAtTime during an active automation produces a
      // micro-step. Final setValueAtTime(0) anchors the gain
      // to zero past the ramp's end for float-safety.
      g.gain.value = 0;
      g.gain.setValueAtTime(0, time);
      g.gain.linearRampToValueAtTime(0.16, time + attack);
      g.gain.linearRampToValueAtTime(0.16, holdEnd);
      g.gain.linearRampToValueAtTime(0, time + dur);
      g.gain.setValueAtTime(0, time + dur + 0.002);
      g.connect(musicBus);
      // Two slightly detuned sines per chord tone — gentle
      // chorus thickens the pad without changing its pitch.
      const detunes = [-7, 7];
      for (let d = 0; d < detunes.length; d++) {
        const osc = c.createOscillator();
        osc.type = "sine";
        osc.detune.value = detunes[d];
        osc.frequency.setValueAtTime(freq, time);
        osc.connect(g);
        osc.start(time);
        osc.stop(time + dur + 0.03);
        osc.onended = () => { osc.disconnect(); g.disconnect(); };
      }
    }
  }

  // Chord stab — a warm full-chord hit on each bar's downbeat.
  // This is the layer that makes chord changes actually
  // audible: the pad's slow attack fades in too gradually to
  // announce a new harmony, and the bass and arp only play
  // individual notes. The stab fires all three chord tones at
  // once so the ear immediately registers "new chord" at every
  // bar. Triangle wave (not sawtooth) keeps the harmonic
  // content soft — sawtooth gave the stab a metallic zing —
  // and the filter opens only to 2200 Hz at the attack, not
  // 3200, so no harsh high-frequency transient.
  function musicStab(chord, time) {
    const c = ctx;
    const dur = 0.32;
    const filter = c.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 0.6;
    filter.frequency.setValueAtTime(2200, time);
    filter.frequency.exponentialRampToValueAtTime(540, time + dur);
    const g = c.createGain();
    // All-linear envelope. setValueAtTime(0) past the final
    // ramp is a belt-and-braces anchor against float drift.
    g.gain.value = 0;
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(0.24, time + 0.022);
    g.gain.linearRampToValueAtTime(0, time + dur);
    g.gain.setValueAtTime(0, time + dur + 0.002);
    filter.connect(g).connect(musicBus);
    for (let i = 0; i < chord.length; i++) {
      const osc = c.createOscillator();
      osc.type = "triangle";
      osc.detune.value = (i - 1) * 4; // subtle spread across chord tones
      osc.frequency.setValueAtTime(chord[i], time);
      osc.connect(filter);
      osc.start(time);
      osc.stop(time + dur + 0.03);
      osc.onended = () => { osc.disconnect(); };
    }
    // Last osc cleans up shared filter+gain chain.
    setTimeout(() => { filter.disconnect(); g.disconnect(); },
      (time + dur + 0.05 - ctx.currentTime) * 1000);
  }

  function musicArp(freq, time) {
    const c = ctx;
    // Triangle through a gentle lowpass — 8th-note rolling
    // sequencer shape, slightly brighter than the bass so it
    // cuts through.
    const dur = 0.28;
    const osc = c.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(freq, time);
    osc.detune.value = (Math.random() - 0.5) * 4;
    const filter = c.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(1700, time);
    filter.Q.value = 1;
    const g = c.createGain();
    // All-linear envelope. Arp fires every 8th note so any
    // click here compounds 8× per bar — this is the layer
    // most likely to surface a mobile click, so it's also the
    // one most worth keeping simple and ramp-type-homogeneous.
    g.gain.value = 0;
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(0.15, time + 0.018);
    g.gain.linearRampToValueAtTime(0, time + dur);
    g.gain.setValueAtTime(0, time + dur + 0.002);
    osc.connect(filter);
    filter.connect(g);
    g.connect(musicBus);
    osc.start(time);
    osc.stop(time + dur + 0.03);
    osc.onended = () => { osc.disconnect(); filter.disconnect(); g.disconnect(); };
  }

  function musicLead(freq, time) {
    const c = ctx;
    // Two detuned sines sustaining together for a soft analog
    // lead feel. Longer envelope so the melody floats over the
    // bass/arp layers instead of stabbing.
    const dur = 0.85;
    const g = c.createGain();
    // All-linear envelope. The 850 ms decay means linear and
    // exponential sound essentially identical to the ear; the
    // linear version is safer on iOS Safari because it uses
    // a single automation code path end-to-end.
    g.gain.value = 0;
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(0.2, time + 0.04);
    g.gain.linearRampToValueAtTime(0, time + dur);
    g.gain.setValueAtTime(0, time + dur + 0.002);
    g.connect(musicBus);
    [-6, 6].forEach((detune, i) => {
      const osc = c.createOscillator();
      osc.type = "sine";
      osc.detune.value = detune;
      osc.frequency.setValueAtTime(freq, time);
      osc.connect(g);
      osc.start(time);
      osc.stop(time + dur + 0.03);
      if (i === 1) osc.onended = () => { osc.disconnect(); g.disconnect(); };
      else osc.onended = () => { osc.disconnect(); };
    });
  }

  function scheduleStep(step, time) {
    if (muted) return;
    const bar = Math.floor(step / MUSIC_STEPS_PER_BAR);
    const stepInBar = step % MUSIC_STEPS_PER_BAR;

    // Section boundary: re-read intensity and pick a progression
    // for this 4-bar block. We only switch at the downbeat of
    // bar 0 so mid-section chord jumps can't happen — the
    // current section always plays out before the new one
    // starts. Tier 2 gets the intense progression; tier 1 the
    // medium one; tier 0 the calm default.
    if (step === 0) {
      let tier = 0;
      if (currentIntensity >= MUSIC_INTENSITY_THRESHOLDS[1]) tier = 2;
      else if (currentIntensity >= MUSIC_INTENSITY_THRESHOLDS[0]) tier = 1;
      currentTier = tier;
      activeProgression = MUSIC_PROGRESSIONS[tier * 2 + (sectionCount & 1)];
      sectionCount++;
      // Streak-driven tempo ramp. Each streak level adds 4 BPM
      // up to the cap. Resets to base when streak is 0 (broken
      // or fresh run). Only changes at section boundaries so
      // the tempo transition is musically clean.
      const streakBPM = Math.min(MUSIC_BPM + currentStreak * 4, MUSIC_BPM_MAX);
      currentStepSec = 60 / streakBPM / 4;
    }

    const chordIdx = activeProgression[bar];

    // Bar downbeat: fire the stab + pad + pick the lead
    // rhythm pattern for this bar.
    if (stepInBar === 0) {
      // Stab first — punchy chord hit that announces the new
      // harmony on every bar. Without this, chord changes rely
      // on the pad fading in, which is too gradual to read as
      // "a new chord just started".
      musicStab(MUSIC_ARP[chordIdx], time);
      // Pad — sustained chord held for the full bar underneath.
      musicPad(MUSIC_ARP[chordIdx], time, MUSIC_STEPS_PER_BAR * currentStepSec);
      // Pick lead + bass rhythm patterns for this bar.
      // Sampled at different simplex Y coordinates so lead and
      // bass don't pick patterns in lockstep.
      function pickPattern(bank, ranges, noiseY) {
        const range = ranges[currentTier];
        const lo = range[0];
        const hi = range[1];
        const rNoise = simplex2(time * 0.9, noiseY);
        const rT = (rNoise + 1) * 0.5;
        let rIdx = lo + Math.floor(rT * (hi - lo));
        if (rIdx >= hi) rIdx = hi - 1;
        if (rIdx < lo) rIdx = lo;
        return bank[rIdx];
      }
      currentLeadPattern = pickPattern(MUSIC_LEAD_PATTERNS, MUSIC_LEAD_PATTERN_RANGES, 7.3);
      currentBassPattern = pickPattern(MUSIC_BASS_PATTERNS, MUSIC_BASS_PATTERN_RANGES, 13.1);
    }

    // Bass — rhythm from the per-bar pattern, with occasional
    // fifths on non-downbeat hits for melodic movement.
    {
      let bassFires = false;
      for (let bp = 0; bp < currentBassPattern.length; bp++) {
        if (currentBassPattern[bp] === stepInBar) { bassFires = true; break; }
      }
      if (bassFires) {
        let freq = MUSIC_BASS[chordIdx];
        // On non-downbeat notes, ~30% chance of playing the
        // fifth above the root for a walking-bass feel.
        if (stepInBar !== 0 && simplex2(time * 1.7, 22.0) > 0.4) {
          freq *= 1.5; // perfect fifth up
        }
        musicBass(freq, time);
      }
    }

    // Arpeggio — 8th notes cycling through the chord tones.
    if (stepInBar % 2 === 0) {
      const chord = MUSIC_ARP[chordIdx];
      const arpIdx = Math.floor(stepInBar / 2) % chord.length;
      musicArp(chord[arpIdx], time);
    }

    // Lead — rhythm from the currently active pattern, pitch
    // from a simplex-walked chord-tone scale. Simplex X is
    // driven by the raw audio clock (not a step counter), so
    // the melodic contour flows continuously across song
    // loops instead of repeating identically every 64 steps.
    // A second, much slower simplex sample provides ±0.8
    // drift on the Y coordinate so the lead's character
    // evolves across many bars within the same tier.
    let leadFires = false;
    for (let i = 0; i < currentLeadPattern.length; i++) {
      if (currentLeadPattern[i] === stepInBar) { leadFires = true; break; }
    }
    if (leadFires) {
      // Pitch contour X driven at time * 0.35 — fast enough
      // that consecutive lead notes land in meaningfully
      // different parts of the noise field, slow enough that
      // the contour still feels like a melody instead of a
      // random walk.
      const yBase = 0.3 + currentTier * 2.2;
      const yDrift = simplex2(time * 0.025, 100.0) * 1.0;
      const noiseY = yBase + yDrift;
      const n = simplex2(time * 0.35, noiseY);
      const t01 = (n + 1) * 0.5; // map [-1, 1] → [0, 1]
      const scale = MUSIC_LEAD[chordIdx];
      let idx = Math.floor(t01 * scale.length);
      if (idx < 0) idx = 0;
      if (idx >= scale.length) idx = scale.length - 1;
      musicLead(scale[idx], time);
    }
  }

  function setIntensity(v) {
    if (typeof v !== "number" || !isFinite(v)) return;
    currentIntensity = v < 0 ? 0 : (v > 1 ? 1 : v);
  }

  function setStreak(n) {
    currentStreak = typeof n === "number" ? Math.max(0, n) : 0;
  }

  function scheduler() {
    schedulerTimerId = null;
    if (!schedulerRunning) return;
    const c = ctx;
    if (!c) { schedulerRunning = false; return; }

    // Resync if we fell behind wall-clock. Mobile browsers
    // throttle setTimeout under moderate load — an active
    // touch interaction on Chrome Android plus a heavy render
    // frame can block the main thread for 100–300 ms — so a
    // scheduler tick that should fire every 100 ms can actually
    // fire much later. We advance through lost step slots
    // until `nextStepTime` is at least `MUSIC_SAFETY_MARGIN`
    // into the future. That guarantees every scheduled event
    // is comfortably ahead of the audio clock even if another
    // small delay sneaks in between here and the actual
    // `scheduleStep` call below. Past-time automation events
    // are the click source; this keeps us out of that state.
    const safeFloor = c.currentTime + MUSIC_SAFETY_MARGIN;
    while (nextStepTime < safeFloor) {
      nextStepTime += currentStepSec;
      currentStep = (currentStep + 1) % MUSIC_TOTAL_STEPS;
    }

    const horizon = c.currentTime + MUSIC_SCHEDULE_AHEAD;
    let count = 0;
    while (nextStepTime < horizon && count < MUSIC_MAX_STEPS_PER_TICK) {
      // Per-call clamp: if the last few ms of main-thread work
      // have eroded our safety margin between the resync check
      // above and now, nudge this specific step's events
      // forward by a tiny amount so they still land in the
      // future. `nextStepTime` itself still advances on the
      // rhythm grid — only the audio-clock time committed to
      // the automation events is clamped. Rhythm stays on-beat
      // except when we're actively recovering from a stall.
      const commitTime = nextStepTime > c.currentTime + 0.01
        ? nextStepTime
        : c.currentTime + 0.01;
      scheduleStep(currentStep, commitTime);
      currentStep = (currentStep + 1) % MUSIC_TOTAL_STEPS;
      nextStepTime += currentStepSec;
      count++;
    }
    if (count >= MUSIC_MAX_STEPS_PER_TICK) {
      // Belt-and-braces: if the resync loop above didn't catch
      // every drop (e.g. extreme throttling), shed any leftover
      // accumulation rather than emit a note avalanche.
      nextStepTime = c.currentTime + currentStepSec;
    }
    schedulerTimerId = setTimeout(scheduler, MUSIC_SCHEDULE_INTERVAL);
  }

  function actualStartMusic() {
    const c = ensure();
    if (!c) return;
    if (schedulerRunning) return;
    schedulerRunning = true;
    currentStep = 0;
    nextStepTime = c.currentTime + 0.08;
    scheduler();
  }

  function actualStopMusic() {
    schedulerRunning = false;
    if (schedulerTimerId != null) {
      clearTimeout(schedulerTimerId);
      schedulerTimerId = null;
    }
  }

  function startMusic() {
    musicIntended = true;
    actualStartMusic();
  }

  function stopMusic() {
    musicIntended = false;
    actualStopMusic();
  }

  // Pause the scheduler when the tab is hidden so we don't
  // burn CPU creating silent nodes (or drift the timeline).
  // Resume only if the caller still wanted music playing.
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        actualStopMusic();
      } else if (musicIntended) {
        actualStartMusic();
      }
    }, false);
  }

  return {
    boost, capture, death, deathCrash, comet,
    startMusic, stopMusic, setIntensity, setStreak,
    setMuted, isMuted,
  };
}
