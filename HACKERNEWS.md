# Hacker News: Show HN: Astrocatch – a one-tap browser game with real Newtonian orbital mechanics (astrocatch.live)

**412 points** by *wistrand* | 187 comments

---

▲ **kepler_was_right** | 4 hours ago | 142 points

Author here. Quick technical notes for the curious:

- No build step, no dependencies. The browser loads a single `<script type="module">`
  and that's the whole pipeline. `npm install` does nothing because there's
  nothing to install.
- Gravity is single-body (nearest star wins at the Voronoi midline). I went back
  and forth on full N-body but the moment you let two stars influence a ship
  simultaneously the orbits stop being conics and the periapsis-detect capture
  breaks. The current model gives you exact Kepler arcs in each region, which
  matters because the predictor has to match the live integrator bit-for-bit.
- Velocity-Verlet at 120 Hz with a time accumulator decoupled from RAF.
  Variable-refresh monitors used to make the game speed up; that bug is gone.
- Capture is by periapsis detection — the integrator tracks `min d(t)` and
  rewinds to the exact frame of closest approach before applying the burn.
  Result: orbits land at e ≈ 0 every time, no hitbox fudging.

Happy to answer anything.

  ▲ **fluid_dynamics_bro** | 3h ago | 64 points
  
  > nearest-star wins at the Voronoi midline
  
  This is the right call for a game but I want to push back on calling it
  "real Newtonian." Patched conics is an engineering simplification, not
  physics. Lambert + N-body is what real trajectory designers use.
  
    ▲ **kepler_was_right** | 3h ago | 88 points
    
    Patched conics is exactly what NASA used to plan the Voyager grand tour.
    "Real Newtonian" in the README means each region integrates the actual
    `GM/r²`, not a parametric arc fit. I'll take the pedantry hit on the
    marketing copy though — it's fair.
    
      ▲ **fluid_dynamics_bro** | 2h ago | 31 points
      
      Fair. Withdrawn.

  ▲ **gpu_grumbler** | 3h ago | 41 points
  
  > a single source compiled twice with `#define NEBULA_ONLY`
  
  Beautiful. I have spent literal days fighting Adreno register pressure on
  branchy fragment shaders. Compiling two specializations of one source is
  the right hammer and almost nobody reaches for it.
  
    ▲ **kepler_was_right** | 2h ago | 27 points
    
    The ugly version was three nested `if (variant == ...)` blocks and the
    Pixel 6 fell off a cliff. Splitting saved ~6 ms/frame on mid-tier mobile.

  ▲ **shader_skeptic** | 2h ago | 18 points
  
  Curious about the `TIME_WRAP = Math.PI * 2 * 10000` trick mentioned in
  CLAUDE.md. I assume this is to keep `sin(u_time * k)` bit-exact across
  the wraparound, with k constrained to ≤ 2 fractional decimals so
  `WRAP * k` is an integer multiple of 2π?
  
    ▲ **kepler_was_right** | 2h ago | 35 points
    
    Exactly that. After ~17 hours of play (yes, someone did this) you'd
    get visible banding rings on stars from float32 mantissa loss in the
    fragment shader. The wrap fixes it as long as every coefficient
    plays nice with the period. There's a comment in renderer.js
    threatening violence against future-me if I forget.

---

▲ **vim_user_1987** | 4h ago | 96 points

Played for an hour. The thing that elevates this above other one-tap games
is that the *prediction matches live physics exactly*. You can see the dashed
capture arc, you tap, and the ship goes there. No "looks right but lies"
moments. That trust is what makes the streak mechanic feel earnable.

  ▲ **lookmom_no_engine** | 3h ago | 22 points
  
  100%. I bounced off Starfling because the projectile model felt arbitrary.
  This one rewards you for understanding orbital intuition, even subconsciously.

---

▲ **showhn_grouch** | 4h ago | 71 points

The QR-code death screen is a small touch of genius. The sender's score
sits next to your running total in the HUD so you know exactly where you
are. Most "challenge a friend" implementations are an opaque link and a
shrug.

  ▲ **base32_apologist** | 3h ago | 19 points
  
  Lowercase base32 in a URL fragment with a 5-bit checksum, encoded as a
  v3 QR with EC level M, multi-segment alpha+byte. That's three good
  decisions stacked: fragments don't hit the server, lowercase reads
  better at small sizes, multi-segment minimizes payload. Whoever
  implemented this enjoyed themselves.
  
    ▲ **kepler_was_right** | 2h ago | 28 points
    
    I did. Way too much. The first version was base64 with no checksum
    and the QR was a v6. Watching the version drop from 6 to 3 after
    the alpha-segment optimization was the highlight of my week.

---

▲ **anecdata_anon** | 3h ago | 58 points

I worked on a satellite ground-station scheduler for two years and watching
this game gave me flashbacks to debugging Lambert's problem at 2am. The
"smallest Δv that produces a clean prediction" is exactly the sort of
thing that ate months of my life. Beautifully presented as a tap.

  ▲ **rocket_grandma** | 2h ago | 14 points
  
  My grandfather worked on the Apollo guidance computer. He would have
  loved this. He once told me orbital mechanics is "just chess where
  the board is moving."

---

▲ **vibes_only** | 4h ago | 47 points

This is gorgeous on a phone. The procedural music fits perfectly. I had
no idea what I was doing for the first ten minutes and I didn't care.

  ▲ **synth_dad** | 3h ago | 23 points
  
  Five-layer WebAudio with simplex-noise driving the lead — checked the
  source. The 8-chord pool with 6 intensity-tiered progressions is more
  effort than 99% of indie games put into ambient music. The streak-driven
  tempo ramp is what sells it.

  ▲ **nyquist_nerd** | 2h ago | 8 points
  
  Anyone else immediately mute the music in every game? I am not the
  target audience for this and that's fine.
  
    ▲ **synth_dad** | 1h ago | 12 points
    
    Yeah but they remembered the mute state across sessions, which is
    the actually-respectful version of your preference.

---

▲ **performance_concern** | 3h ago | 38 points

Profiled it in Chrome devtools. Hot paths look genuinely tight — the
README's note about "pooled scratch objects, out-parameters, skip work
when nothing changed" isn't lip service, it's reflected in the code.
The launch-window indicator alone could have been an allocation
nightmare and instead it's reusing one scratch result across 24 calls.

  ▲ **gc_pause_hater** | 2h ago | 11 points
  
  Found one minor allocation in the comet update loop but it's once per
  frame per comet so it's noise. Mostly impressive discipline.

---

▲ **drive_by_critic** | 3h ago | 34 points

It's a clone of Starfling.

  ▲ **kepler_was_right** | 3h ago | 67 points
  
  Acknowledged in the README. Same verb, same visual family. Different
  underlying simulation — Starfling is parametric, this is integrated.
  Whether that matters to a player is fair to debate; whether it's a
  clone is, I think, decided by the gap between "looks like" and "is."
  
    ▲ **drive_by_critic** | 2h ago | -8 points
    
    Whatever, still a clone.
    
      ▲ **mod_voice** | 1h ago | 22 points
      
      The author credited the inspiration in the README. You're not
      revealing a hidden truth; you're booing politeness.

---

▲ **pages_publisher** | 3h ago | 29 points

The fact that the entire game is in `/docs` and ships via GitHub Pages with
zero config is the kind of thing I want every web project to learn from.
No CI, no Vercel, no Netlify, just a folder and a server.

  ▲ **deploy_guy** | 2h ago | 9 points
  
  I deployed a fork in 30 seconds. Forked, enabled Pages, done.

---

▲ **mobile_safari_user** | 2h ago | 24 points

Works flawlessly on iPhone 13 in Safari. WebGL2 only landed in Safari 15
which I think the author calls out — props for not bothering with a
canvas2d fallback. The right call in 2026.

  ▲ **android_user** | 2h ago | 6 points
  
  Smooth on a Pixel 7 too. The nebula variants are the only place I see
  any frame drops and they're rare.

---

▲ **first_time_player** | 2h ago | 21 points

I died 14 times in a row before I understood the "tap when your direction
points at the next star" instruction. Once it clicked I couldn't put it
down. The launch-window hint (W key) is the right tutorial — show me
where the answer is, then take it away.

---

▲ **tdd_truther** | 2h ago | 18 points

`npm test` runs a sweep of 64 boost angles across 8 star configs in node
and reports captures/escapes/crashes. Physics is its own ES module so the
test runner imports it directly. This is the right amount of testing for a
game and I respect that the README says "verify physics fixes by running
the test, not by trusting analytical arguments." That's a hard-won lesson.

---

▲ **boring_complaint** | 2h ago | 11 points

Why isn't there a leaderboard?

  ▲ **kepler_was_right** | 2h ago | 38 points
  
  Because the moment you add a leaderboard you need an account system,
  anti-cheat, a database, a backend, terms of service, and a pager
  rotation. The challenge link is the social layer. Your friends are
  the leaderboard.
  
    ▲ **boring_complaint** | 1h ago | 4 points
    
    Fair.

---

▲ **emoji_free_zone** | 1h ago | 9 points

Skimmed every file in the repo. Not one emoji in any source file or
commit message. Refreshing.

---

▲ **lurker_emerging** | 1h ago | 7 points

Made my first HN account just to say: 8127 on my third run. The streak
multiplier loop is the dopamine hook. Going back in.

---

▲ **dang** | 30m ago | 5 points

We've reduced the score boost on this thread because it's been on the
front page for a while. Carry on.
