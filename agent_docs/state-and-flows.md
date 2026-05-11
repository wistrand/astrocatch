# State and flows

Mermaid diagrams covering ASTROCATCH's runtime state machine, per-tick flow, capture
lifecycle, intro overlay, spawn decisions, save / resume, and challenge-link round-trip.
Mostly a cross-reference layer over the other agent_docs — read those for the
physics/rendering/audio specifics, this one for "where does control flow go".

---

## 1. Top-level state machine

Four states, defined in `gameplay.js`:

```mermaid
stateDiagram-v2
  [*] --> MENU
  MENU --> PLAY: START / RESTART / RESUME button
  PLAY --> DYING: die()   (crash or escape)
  DYING --> DEAD: DYING_FRAMES_MS timeout
  DEAD --> PLAY: RESTART (init) / CONTINUE (continueRun)
  PLAY --> [*]: pagehide / reload
  DEAD --> [*]: pagehide / reload
```

| state | renderTick? | physicsTick? | input | UI |
|---|---|---|---|---|
| `MENU` | menu-stars only (drift loop) | no | START / RESUME buttons | `#start` overlay visible |
| `PLAY` | full draw | yes | boost / pause / nudge / cinematic / hint toggles | HUD score + sub + hint |
| `DYING` | full draw (wind-down) | yes (no scoring) | ignored | HUD frozen, score snapshot |
| `DEAD` | replay-cam loop | no | RESTART / CONTINUE / Enter | `#gameover` overlay, challenge card |

`paused` is a flag on top of `PLAY` — physics + audio scheduler halt, render keeps polling
so the pause-indicator can blink and unpause is instant.

---

## 2. Entry points into a run

`init()` (fresh run), `continueRun()` (post-death retry preserving terrain), and
`resumeFromSave()` (post-reload RESUME) are the three handoffs. Only `init()` rolls a fresh
seed and rebuilds the star field.

```mermaid
flowchart TD
  start([page load]) --> menu[STATE.MENU]
  menu --> startBtn{click}
  startBtn -- START --> initFresh[clearSave + init]
  startBtn -- RESUME --> resumeSave[resumeFromSave]
  initFresh --> play[STATE.PLAY]
  resumeSave --> play
  play --> dieEvt{die}
  dieEvt --> dying[STATE.DYING]
  dying --> dead[STATE.DEAD]
  dead --> rebtn{click}
  rebtn -- RESTART --> initFresh
  rebtn -- CONTINUE --> contRun[clearSave + continueRun]
  contRun --> play
```

`init()` order (fresh start):

```mermaid
flowchart LR
  A[init] --> B[endIntro]
  B --> C[gameplayCount++]
  C --> D[setRunSeed]
  D --> E[reset stars, trail, particles, score, etc.]
  E --> F[makeStar 0 + 6× addNextStar]
  F --> G[place ball in circular orbit at INITIAL_ORBIT_MULT * r]
  G --> H[computeLaunchWindow]
  H --> I{introDone or _incomingChallenge?}
  I -- false --> J[startIntro]
  I -- true --> K[show #hint]
  J --> L[audio.startMusic]
  K --> L
```

`?intro=1` forces intro regardless of done-flag, but only on `init()` paths — resume always
suppresses (existing player by definition).

---

## 3. Render / physics tick layout

Decoupled. Physics runs at `PHYSICS_HZ` (120) via an accumulator clocked by the same
`requestAnimationFrame` callback that does render work — but each RAF processes only the
backlog up to `MAX_FRAME_GAP_MS` so a tab-throttled frame can't fire a thousand physics
steps and freeze the next paint.

```mermaid
flowchart TD
  RAF[requestAnimationFrame] --> A[clamp dt to MAX_FRAME_GAP_MS]
  A --> B[physicsAccumulator += dt]
  B --> C{accumulator ≥ PHYSICS_DT_MS?}
  C -- yes --> D[physicsTick]
  D --> E[burnStep · checkCollisions · advance comets/planets via ball.frame]
  E --> F[accumulator -= PHYSICS_DT_MS]
  F --> C
  C -- no --> G[forward-extrapolate ballRenderX/Y from post-tick state]
  G --> H[renderTick]
  H --> I[updateEjecta · tickLaunchWindowBuild · sample trail/replay]
  I --> J[update camY/camX · zoomMult · cinematic integrator]
  J --> K[camRender* lerp]
  K --> L[updateTutorialPositions]
  L --> M[audio.setIntensity · audio.setStreak]
  M --> N[draw]
  N --> RAF
```

`draw()` is called from `renderTick`. It composes one `replayMat` from
`camRenderScale/Ox/Oy` and routes every world-space draw through it — same matrix in
cinematic mode and regular gameplay, so mode transitions are a lerp on the params, not a
branch in the renderer.

---

## 4. Capture lifecycle (one tap, one transfer)

The ship has three lifecycle phases under a single `STATE.PLAY`: orbiting, in transit, and
back-in-orbit. `ball.pendingCapture` is the discriminator.

```mermaid
sequenceDiagram
  participant Player
  participant Input as Input handler
  participant Boost as boost()
  participant Phys as physicsTick
  participant Cap as captureStar()
  participant UI

  Note over Phys: ball.pendingCapture = -1 (orbiting current star)
  Player->>Input: tap / space
  Input->>Boost: boost()
  alt pendingCapture < 0 (orbiting)
    Boost->>Boost: quick-launch bonus = f(framesInOrbit / period)
    Boost->>Phys: AC.applyBoostAndArm sets pendingCapture, ball.pendingBonus
    Boost->>UI: exhaust particles, audio.boost()
  else pendingCapture >= 0 (in transit)
    Boost->>Boost: ball.queuedBoost = true
    Boost->>UI: small radial particle ring (target's color)
  end

  loop physicsTick until peri
    Phys->>Phys: burnStep tracks min d(t)
  end

  Phys->>Cap: captureStar(idx) at periapsis
  Cap->>Cap: starsVisited++, score += bonus × streakMult
  Cap->>Cap: ball.currentStar = idx, pendingCapture = -1
  Cap->>UI: capture SFX, shockwave, particles, camera follow
  Cap->>Phys: computeLaunchWindow for new orbit
  alt ball.queuedBoost
    Cap->>Boost: replay boost from clean state (framesInOrbit=0 ⇒ Blazing)
  end
```

`pendingCapture` lifecycle states:

```mermaid
stateDiagram-v2
  [*] --> Orbiting
  Orbiting --> Transit: boost() arms capture
  Orbiting --> Orbiting: bad-direction boost (pendingCapture stays -1)
  Transit --> Captured: burnStep hits periapsis
  Transit --> Transit: tap queues ball.queuedBoost
  Transit --> Crashed: collision with star/sub-star/binary
  Transit --> Escaped: TRANSFER_TIMEOUT physics frames (peri not crossed)
  Captured --> Orbiting: framesInOrbit reset, new orbit established
  Captured --> Orbiting_replay: queuedBoost replays boost()
  Orbiting_replay --> Transit
  Crashed --> [*]: die(crash, target)
  Escaped --> [*]: die() — boosts free
```

---

## 5. Star generation pipeline

`addNextStar` is the single entry point for adding stars beyond the seeded six. Three
orthogonal rolls in fixed order:

```mermaid
flowchart TD
  A[addNextStar n] --> B[difficulty = min n/60, 1]
  B --> C[pickVariant via SPAWN_TABLE_GAME at index n]
  C --> D{variant}
  D -- plain/bh --> E[minR = 18]
  D -- pulsar/nebula --> F[minR = 30]
  D -- teapot --> G[minR = 40]
  D -- azazel --> H[minR = 56, 1.5× size mult]
  D -- monolith/ring/binary --> E
  E --> I[pick r from minR..30 + difficulty growth]
  F --> I
  G --> I
  H --> I
  I --> J[pick θ in cone + radial distance, SAFE_SEP guard]
  J --> K[makeStar applies variant flags + colorIdx]
  K --> L{variant in plain/bh AND n ≥ planet ramp?}
  L -- yes --> M[planet roll ramps from 0 to PLANET_PROB_MAX over PLANET_RAMP_STARS]
  L -- no --> N[no planets]
  M --> O{comet allowed AND n ≥ COMET_MIN_STAR?}
  N --> O
  O -- yes --> P[COMET_PROB roll → optional comet]
  O -- no --> Q[no comet]
  P --> R[push to stars array]
  Q --> R
```

Variant comet/planet exclusions (`makeStar` decision table):

| variant | planets | comets |
|---|---|---|
| plain | ✓ | ✓ |
| binary | ✗ (sub-stars occupy volume) | ✓ |
| bh | ✓ | ✓ |
| bhBinary | ✗ | ✓ |
| monolith | ✗ | ✗ (alien/alone vibe) |
| ringworld | ✗ | ✗ |
| pulsar | ✗ (body too small) | ✓ |
| nebula | ✗ (gas occupies volume) | ✓ |
| teapot | ✗ | ✗ (Russell gag solo) |
| azazel | ✗ | ✗ (demonic vibe solo) |

---

## 6. First-run intro overlay

Two persistent DOM slots (`tutorial-current`, `tutorial-next`) bound by `ball.currentStar`.
Each entry in `INTRO_TEXTS` rides on its corresponding star index. Capture promotes the
next-text into current naturally (same string, same screen position, different element).

```mermaid
flowchart TD
  startB[startIntro] --> sync0[syncIntroForCurStar cs=0]
  sync0 --> setCur0[current = 'you're orbiting a star']
  sync0 --> hideNext[next textContent = '' instantly]
  hideNext --> timer1[schedule next-text show in INTRO_NEXT_DELAY_MS=1000ms]
  timer1 --> wait1[wait 1s]
  wait1 --> next1[next = 'tap when your direction aims...']
  next1 --> nextVis[_introNextVisible = true]
  nextVis --> orbit[player orbits, possibly multiple taps]
  orbit --> cap1{capture? cs 0→1}
  cap1 -- yes --> sync1[syncIntroForCurStar cs=1]
  sync1 --> setCur1[current = 'tap when your direction aims...']
  sync1 --> hideNext1[next textContent = '' instantly]
  hideNext1 --> timer2[schedule next-text show in 1s]
  timer2 --> wait2[wait 1s] --> next2[next = 'release within one rotation for bonus']
  next2 --> orbit
  cap1 -- past INTRO_TEXTS.length --> endI[curText undefined → endIntro true]
  endI --> doneFlag[set INTRO_DONE_KEY in localStorage unless ?intro=1]
```

INTRO_TEXTS sequence as of current build:

| cs | text | role |
|---:|---|---|
| 0 | you're orbiting a star | teach: orientation |
| 1 | tap when your direction aims at the next one | teach: action |
| 2 | release within one rotation for bonus | teach: refinement |
| 3 | send runs as challenge links | teach: meta |
| 4 | stranger stars ahead | tease |
| 5 | enjoy | close |

`_introNextVisible` doubles as the gate for `lwForced` while `cs === 0` — so the
launch-window indicator visualises alongside the "tap when aimed" line and clears on the
first capture. The persisted `showLaunchWindow` flag isn't touched.

Dismissal paths:

```mermaid
stateDiagram-v2
  [*] --> Inactive
  Inactive --> Active: startIntro
  Active --> Active: ball.currentStar increments
  Active --> Inactive_success: cs past INTRO_TEXTS.length\n(endIntro true → done flag set)
  Active --> Inactive_failure: die() / 60s safety timer\n(endIntro false → done flag stays unset)
  Inactive_success --> [*]
  Inactive_failure --> [*]
```

Chapter-flash overlay (variant-first + star milestone titles) is suppressed for the first
10 captures so the intro doesn't compete with the chapter UI. `_chapterMilestones`
unmarked during that window — a binary first seen at star 7 still fires its chapter flash
at the next binary past star 10.

---

## 7. Launch-window indicator build pipeline

Time-sliced across render frames with ping-pong buffers so a single 36-slot build never
spikes the frame budget.

```mermaid
flowchart TD
  T[Trigger: capture / nudge / throttled fire] --> A[abort any in-progress build]
  A --> B[runLaunchWindowPhase1: forward-sim 1 orbit → 36 sample states ~1-2ms]
  B --> C[set _lwBuildSlot=0, write to back buffer]
  C --> D{render frame: tickLaunchWindowBuild}
  D --> E[advance LW_SLOTS_PER_FRAME=6 slots]
  E --> F[runLaunchWindowPhase2Slot: try BOOST_SEARCH_STEPS×LAUNCH_WINDOW_BOOST_STEPS=24 boost factors, break on first valid capture]
  F --> G{_lwBuildSlot < 36?}
  G -- yes --> D
  G -- no --> H[swap A/B: ball.launchWindow ← back buffer]
  H --> I[render uses front buffer until next swap]
```

Throttled re-fire conditions (`renderTick`):

- Hint visible (`showLaunchWindow || cs.isAzazel || intro-next-tag visible`)
- Perturbation present (cs has `planets || isBinary`)
- `frame - lastLaunchWindowFrame ≥ LAUNCH_WINDOW_RECOMPUTE_FRAMES` (12 physics frames)
- No build currently in flight (`_lwBuildSlot < 0`)
- Build also auto-aborts if `pendingCapture` rises or `currentStar` rotates mid-build, so
  results computed against stale state never land.

`lwForced` overrides:
```mermaid
flowchart LR
  R[lwForced eval] --> A{cs.isAzazel?}
  A -- yes --> Y[true: capture zoom hides next star]
  A -- no --> B{introActive AND ball.currentStar=0 AND _introNextVisible?}
  B -- yes --> Y2[true: intro 'tap when aimed' line visible]
  B -- no --> N[false: defer to user showLaunchWindow toggle]
```

---

## 8. Challenge link round trip

Encoding happens at gameover; decoding happens at page load and on `hashchange`.

```mermaid
sequenceDiagram
  participant DeathScreen
  participant Encoder as buildChallengeUrl
  participant Codec as challenge.js
  participant URL as location.hash
  participant Decoder as decodeChallengeCode
  participant Recipient as init()

  Note over DeathScreen: runStats + currentRunSeed + showLaunchWindow snapshot
  DeathScreen->>Encoder: assemble stats bag
  Encoder->>Codec: bit-pack 129 payload bits
  Codec->>Codec: CRC-16/CCITT-FALSE low 5 bits = checksum
  Codec->>Codec: byte-align to 17 bytes
  Codec->>URL: base32-encode → 28 lowercase chars after '#'
  Note over URL: https://astrocatch.live#<base32>

  Recipient->>URL: location.hash present at load
  URL->>Decoder: hashchange or initial load
  Decoder->>Decoder: toUpperCase, strict 17-byte length check
  Decoder->>Decoder: verify checksum
  alt valid
    Decoder->>Recipient: _incomingChallenge = decoded stats
    Recipient->>Recipient: showChallengeCard (welcome flip-card with QR)
    Recipient->>Recipient: init() reads seed → setRunSeed
    Recipient->>Recipient: init() reads launchWindow → showLaunchWindow override
  else invalid
    Decoder->>Recipient: render #challenge-invalid (textContent only, XSS-safe)
  end
```

Payload bit layout (v2, total 134 bits = 17 bytes = 28 base32 chars):

```mermaid
flowchart LR
  P[129 payload bits] --> A[4: format version]
  P --> B[1: launch_window]
  P --> C[20: score]
  P --> D[10: starsVisited]
  P --> E[4: streakPeak]
  P --> F[8: blazingCount]
  P --> G[8: quickCount]
  P --> H[8: slowCount]
  P --> I[6: cometsCaught]
  P --> J[4: deathCause]
  P --> K[24: variant census 8×3]
  P --> L[32: seed]
  M[5-bit checksum] --> N[17-byte aligned]
  P --> N
```

Resume-button suppression while an incoming challenge is active is critical: without it,
the player could click RESUME and `resumeFromSave()` would restore a previous run's
score, instantly clearing the sender's bar without play. Gate is
`!_incomingChallenge && !!loadGame()`.

---

## 9. Save / resume

`saveGame()` snapshots the run on death (`saveGame` is also written in `die()` so a
RESUME after a crash lands on a fresh anchor orbit, not the crash site). `clearSave()`
fires on START (fresh run) and CONTINUE (preserves the terrain, but the save is now
stale until the next death).

```mermaid
stateDiagram-v2
  [*] --> NoSave: fresh install
  NoSave --> Saved: die()
  Saved --> NoSave: clearSave (START / CONTINUE)
  Saved --> Restored: RESUME (resumeFromSave)
  Restored --> Saved: next die
  Restored --> NoSave: next die + START (clearSave)
  Saved --> Saved: pagehide / beforeunload / visibilitychange→hidden ⇒ saveBest only
```

Save record fields used at restore (`SAVE_KEY = "astrocatch_savegame_v1"`):

| field | restored to | notes |
|---|---|---|
| `stars[]` | rehydrated with variant flags, planets, comets, binary data | all variant booleans round-trip |
| `ball` | repositioned to anchor's INITIAL_ORBIT_MULT orbit | not the crash-site x/y |
| `seed` | setRunSeed | so challenge URL the player generates is reproducible by recipient |
| `score`, `starsVisited`, `fastStreak`, `trackedSpeed`, `hasBoosted` | restored verbatim | |
| `frame` | restored on ball | comets/planets/binary phases resolve correctly |

---

## 10. Audio intensity + demon mode

Music intensity scales with peak-held ball speed; demon mode swaps to a Phrygian
progression while orbiting an Azazel.

```mermaid
flowchart TD
  R[renderTick] --> S[trackedSpeed: decay-max from ball speed]
  S --> N[normalize against MAX_SPEED → 0..1]
  N --> M[audio.setIntensity]
  M --> P[scheduler picks chord at next bar boundary]
  C[captureStar / continueRun / resumeFromSave / init] --> D{cs.isAzazel?}
  D -- yes --> ON[audio.setDemonMode true]
  D -- no --> OFF[audio.setDemonMode false]
  ON --> P
  OFF --> P
  DIE[die] --> OFF
  RESET[fastStreak = 0 on slow capture or die] --> ST[audio.setStreak fastStreak]
  CAP[captureStar bonus ≥ 2] --> INC[fastStreak++, capped]
  INC --> ST
  ST --> P
```

`audio.startMusic` is idempotent (called from `init`, `continueRun`, `resumeFromSave`) so
the timeline stitches across runs without a phase jump. Pause halts the scheduler via
`audio.setMusicPaused(true)`, resume re-grids onto the next bar.

---

## 11. Input → state effects

Most inputs are state-gated:

```mermaid
flowchart TD
  click[click / space] --> g0{state}
  g0 -- PLAY --> b[boost]
  g0 -- DEAD --> r[RESTART / CONTINUE button hit-test]
  g0 -- MENU --> s[START / RESUME button hit-test]
  P[P key] --> tog[togglePaused if PLAY]
  W[W key / tap score] --> lwt[toggle showLaunchWindow + persist]
  Z[Z key / score long-press] --> cin[cycleCinematicLevel]
  arrow[arrow keys] --> nudge[nudge orbital v ±2%]
  nudge --> lwr[computeLaunchWindow]
  H[H key / ? button] --> help[toggle help overlay → paused]
  Esc[Esc] --> closehelp[close help overlay]
  M[M key] --> mute[audio.toggleMute]
```

Focus-click suppression: a click within 150 ms of `window.focus` is ignored — bringing
the tab forward from behind doesn't accidentally fire a boost.

---

## 12. Cross-reference

- Physics integrator + capture math → `agent_docs/physics.md`
- Shader compilation + variant rendering → `agent_docs/rendering.md`
- Music scheduler + SFX bus → `agent_docs/audio.md`
- Per-feature gameplay detail (variants, scoring, launch-window, challenge codec, run
  titles) → `agent_docs/gameplay.md`
