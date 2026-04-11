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

export function createAudio() {
  let ctx = null;
  let master = null;
  let muted = false;
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
        ctx = new Ctor();
        master = ctx.createGain();
        master.gain.value = muted ? 0 : MASTER_VOLUME;
        master.connect(ctx.destination);
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
    if (master && ctx) {
      // Smooth volume change so toggling mid-sound doesn't click.
      const now = ctx.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setTargetAtTime(muted ? 0 : MASTER_VOLUME, now, 0.05);
    }
  }

  function isMuted() {
    return muted;
  }

  // ── boost: soft melodic "shwiiip". Two triangle waves an
  // octave apart, both sweeping from a high start note down a
  // perfect fifth, through a gentle lowpass. Triangle keeps the
  // timbre warm (no saw rasp) and the octave stacking gives it
  // body without harshness. Reads as a little melodic sigh
  // rather than a blaster shot.
  function boost() {
    const c = ensure();
    if (!c || muted) return;
    const t = c.currentTime;
    const dur = 0.28;

    // Soft lowpass — opens briefly on the attack then settles,
    // so the attack has a bit of air without ever being bright.
    const filter = c.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 0.9;
    filter.frequency.setValueAtTime(2000, t);
    filter.frequency.exponentialRampToValueAtTime(700, t + dur);

    const outGain = c.createGain();
    outGain.gain.setValueAtTime(0.0001, t);
    outGain.gain.exponentialRampToValueAtTime(0.38, t + 0.018);
    outGain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    // Melodic sweep: E5 → A4 (a falling perfect fourth) plus an
    // octave below for warmth. Both voices share the filter so
    // the envelope shape stays simple.
    const highStart = 659.25; // E5
    const highEnd = 440;      // A4

    // Upper voice — sine for a softer top end than triangle.
    const hi = c.createOscillator();
    hi.type = "sine";
    hi.frequency.setValueAtTime(highStart, t);
    hi.frequency.exponentialRampToValueAtTime(highEnd, t + dur);
    hi.connect(filter);
    hi.start(t);
    hi.stop(t + dur + 0.05);

    // Lower voice — triangle an octave down for body.
    const lo = c.createOscillator();
    lo.type = "triangle";
    lo.frequency.setValueAtTime(highStart * 0.5, t);
    lo.frequency.exponentialRampToValueAtTime(highEnd * 0.5, t + dur);
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

    // A-major triad pitches (Hz). Octave bumps with bonus tier
    // so a Blazing chain feels noticeably brighter.
    const octave = bonus >= 3 ? 2 : bonus >= 2 ? 1 : 1;
    const root   = 220 * Math.pow(2, octave);        // A4 or A5
    const third  = 277.18 * Math.pow(2, octave - 1); // C#4 or C#5
    const fifth  = 329.63 * Math.pow(2, octave - 1); // E4 or E5
    const high   = 440 * Math.pow(2, octave);        // A5 or A6

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

  // ── death: falling three-note minor descent through a
  // closing lowpass. Notes are A3, F3, D3 — a descending A minor
  // partial — so the fall has a clear melodic shape rather than
  // a generic sawtooth slide.
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
      // Downward drift within each note for a "wilting" feel.
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

  return { boost, capture, death, setMuted, isMuted };
}
