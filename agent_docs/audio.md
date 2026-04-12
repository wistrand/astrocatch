# Audio

`audio.js` owns all sound. Everything synthesized at play time
from oscillators — no sample files, no libraries.

## Signal chain

```
SFX voices ─→ master gain ─→ DynamicsCompressor ─→ destination
                                                        ↑
music voices ─→ musicBus ───────────────────────────────┘
```

Music bypasses the compressor (it was clicking on bar downbeats).
Both buses muted in parallel via `setMuted`.

## Context setup

- `latencyHint: "playback"` — larger output buffers, fewer
  underruns on mobile Firefox.
- Silent pre-warm oscillator at gain 0 keeps the audio hardware
  from entering power-save between events.

## SFX events

- `boost()` — ascending perfect fifth, short.
- `capture(bonus, streak)` — A-major arpeggio chime. More notes
  for higher bonus tiers. Streak shimmer on chains.
- `death()` — falling A-minor sawtooth descent (escape into space).
- `deathCrash()` — soft sine droplet descent (star collision).
- `comet()` — ascending sparkle with bell overtones.

All SFX use per-call detune jitter (see constant in each function).

## Generative music

Loop at `MUSIC_BPM` in A minor. 8-chord harmonic pool (Am, F, C,
G, Dm, E, Em, Bb) with 6 progressions (2 per tier, alternated
each 4-bar section via `sectionCount`). Chord progression switches
at section boundaries based on `setIntensity(v)`:

- Tier 0 (calm): Am→F→C→G / Am→Em→F→G
- Tier 1 (medium): Dm→Am→F→C / Dm→F→Am→G
- Tier 2 (intense): Am→G→F→E / Dm→Bb→F→E

Thresholds in `MUSIC_INTENSITY_THRESHOLDS`. Five layers: stab
(triangle chord hit), pad (sustained sines), bass (saw + sub
with filter envelope), arp (8th-note triangle roll), lead
(detuned sine pair).

### Lead melody

Pitch from chord tones via 2D simplex noise. Three variation
sources: rhythm pattern bank (`MUSIC_LEAD_PATTERNS`, tier-
windowed via `MUSIC_LEAD_PATTERN_RANGES`), time-continuous pitch
contour, slow Y-drift for long-timescale evolution.

### Streak-driven tempo

Base tempo `MUSIC_BPM`, each streak level adds 4 BPM up to
`MUSIC_BPM_MAX`. Only changes at section boundaries.

### Scheduler

`setTimeout` loop at `MUSIC_SCHEDULE_INTERVAL` tick,
`MUSIC_SCHEDULE_AHEAD` lookahead. Resync with
`MUSIC_SAFETY_MARGIN` prevents past-time scheduling. All music
envelopes are all-linear with `g.gain.value = 0` at creation.
Music plays from first START through DEAD; never autostarts on
the welcome screen.

### Intensity input

`setIntensity(v)` fed from gameplay's decay-max speed tracker
(`SPEED_DECAY` constant). Peaks latch briefly. Tier re-read at
section boundaries only.

## Mute

HUD speaker button + M key, both calling `setMuted`. Persisted
to `localStorage` (key in `STORAGE_KEY`).
