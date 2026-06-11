# Moon Landing Mode — Experience Design

> **Status:** P0 design package (no code). Companion docs: [TECH.md](TECH.md) (architecture & feasibility),
> [ROADMAP.md](ROADMAP.md) (phased delivery), [REVIEWS.md](REVIEWS.md) (design-critique log),
> [mockups/](mockups/) (rendered HUD/scene mockups).

---

## 0. Vision

**You are coming down to the Moon, and you have ten minutes to fall in love with it.**

The mode opens in lunar orbit, ~450 km up, with a tenth of the Moon spread beneath you and the
Earth rising over the limb. It ends 5–10 minutes later with your boots-level camera sitting in
gray dust, engine off, in total silence, with the Earth hanging fixed in a black sky. Everything
between those two images — the burn, the long fall, the pitch-over, the dust — is built so that a
person who has never flown anything can ride it like a window seat, while a person who wants to
*fly* it can take the stick.

This is not a simulator and not a cutscene. It is a **guided descent with player expression**: the
trajectory is managed by guidance, but where you look, how fast you fall, and *where exactly you
land* are yours.

### Design pillars

1. **The Moon is the star.** Every system (lighting, LOD, exposure, HUD restraint) serves the
   terrain and the sky. If a feature competes with the view, the feature loses.
2. **Accurate by default, licensed on purpose.** Real scale, real ephemeris, real data, real
   vacuum behavior. Every deviation from reality is deliberate, listed in §8, and justified.
3. **A window seat, not a cockpit exam.** Zero learning curve to have the full experience;
   optional depth for people who want stick-and-throttle. Nobody bounces off the controls.
4. **Instruments as storytelling.** The HUD is not chrome — each readout (surface temperature,
   vertical speed, the descent ribbon) exists to make the player *understand what is happening
   to them* and feel competent.
5. **Self-contained and lightweight to everyone else.** The mode lazy-loads code and assets on
   entry and fully disposes on exit. The rest of the app pays zero cost (see TECH §2, §6).

### The fiction (one sentence of lore, zero cutscenes)

You're the passenger-pilot of a small near-future tourist descent craft. That single framing
quietly justifies everything non-Apollo about the experience: the glass HUD, the guidance
envelope that won't let a tourist die (in the default seat), the surface-temperature readout,
the generous ΔV budget that makes a 7-minute descent from 450 km physically honest.

---

## 1. The player journey

### 1.1 Pre-flight (entry screen = loading screen)

Entering the mode lands you on a **pre-flight board** that doubles as the asset loading screen,
so the (one-time) download is *part of the fiction* rather than a spinner:

- **SITE** — five curated landing sites (§7) on a small rotating Moon globe, plus
  "free descent" (pick any point in orbit later). Each site shows a one-line hook and a
  difficulty hint.
- **LIGHT** — date/time picker (defaults to *now*, like the rest of the app) with a live
  preview strip: sun elevation at the site, Earth phase, and a "★ best light" marker on
  terminator-adjacent times (low sun = long shadows = the Moon at its most dramatic — exactly
  why Apollo landed at sun elevations of 5–14°).
- **SEAT** — difficulty (§3.3): Window Seat / Right Seat (default) / Left Seat.
- **Loading checklist** — assets stream while you choose, surfaced as launch-checklist lines
  (`TERRAIN ATLAS ... GO`, `STAR CATALOG ... GO`). First entry shows the download size up front;
  data-saver/mobile users get an explicit "HD pack" consent step (TECH §6).

One press — **BEGIN DESCENT** — and the screen cuts to black, a breath of radio static, then…

### 1.2 The descent arc (default "Right Seat" profile, ~7½ min)

Times below are the default; the player's **descent-rate bias** (§3.2) stretches the whole arc
between ~5 and ~10 minutes. Altitudes/speeds are physically consistent (Appendix A).

| MET | Beat | Alt | What the player sees / does |
|---|---|---|---|
| 0:00 | **Acquisition of signal** | 450 km | Fade in already in motion over the far side's last dark kilometers. Radio static resolves into a voice. The HUD boots line by line. |
| 0:10–1:10 | **Earthrise** | 450 km | Earth's blue limb breaks the gray horizon and climbs — a full disc in ~50 s (real rate at this orbit). The one mandatory "do nothing" beat. Free look. The timeline politely waits: drift here as long as you like. |
| on commit | **The burn** | 450 km | Player presses COMMIT. Retro burn (~75 s): structure-borne rumble, the orbit ribbon on the HUD bends down to intersect the surface. First time the numbers *move*. |
| ~2:00–5:00 | **The long fall** | 400 → 30 km | Engine quiet. The Moon slowly *becomes a place*: craters resolve inside craters, the horizon flattens, surface temp readout swings as terrain changes beneath. Player can look anywhere, nudge cross-range, ride faster/slower. Mid-fall the craft pitches from "Earth window" to "surface window" — a designed gut-drop moment. |
| ~5:00 | **High gate / pitch-over** | 30 km | Apollo-style pitch-over: the forward horizon rotates into view, the landing footprint ellipse appears (~25 × 15 km), site **redesignation** unlocks. The most "pilot" moment of the ride. |
| ~6:30 | **Low gate** | 2 km | Near-vertical descent. Hazard tint on the terrain (slope/roughness), landing reticle live with slope readout, vertical speed capped at −30 m/s by guidance. |
| ~7:10 | **Final** | 150 m | Manual fine-nudge active. Radar altimeter callouts. At ~40 m the **dust** starts — ballistic radial streaks, not billows (vacuum!), washing out the surface exactly when you need instruments most. |
| ~7:35 | **Contact** | 0 m | Probe-touch indicator, engine stop, dust falls out of the sky instantly (no air to suspend it). **Three full seconds of designed silence.** Then the stats card fades in. |
| after | **Stillness** | 0 m | Free look from the surface. Earth fixed in the sky at the site's true azimuth/elevation. Optional **long-exposure mode** (hold a key) ramps exposure +6 EV: the Milky Way blooms over the dim ground. Stay as long as you want. |

**Why a 5–10 minute fall is honest:** the Moon has no atmosphere — you cannot glide or aerobrake;
every descent is propulsive. Pure free-fall from rest at 450 km takes ~13–14 minutes and hits the
ground at ~1.08 km/s (Appendix A). Our craft kills its 1.50 km/s orbital velocity early, adds a
modest downward push, then brakes — a "sporty" ΔV budget of ~3.0 km/s (vs Apollo's 2.0 from a
much lower start). The timeline is achieved with *physics*, not time-warp.

### 1.3 Failure & retry

- **Window Seat / Right Seat:** un-failable. Guidance clamps the envelope; sloppy inputs produce a
  *firm* landing and a lower grade, never a crash. (Pillar 3 — and the fiction supports it.)
- **Left Seat:** real failure. Exceed structural limits (> ~6 m/s vertical, > ~4 m/s lateral,
  > 12° tilt or a boulder strike) and you get a tasteful cut — freeze-frame telemetry in red,
  no explosion porn — and an instant "fly final again from 2 km" retry, or full restart.
- Post-landing stats card for everyone: touchdown velocity, tilt, distance from designated pad,
  peak g, fuel margin (Left Seat), time, and a grade: **Feather / Firm / Hard / Structural**.
  Designed to be screenshot-shareable.

### 1.4 Session shape

- Full ride: 6–11 min including pre-flight. Replay hooks: 5 sites × lighting choices × seats ×
  chasing a *Feather* at 0 m from target.
- Quitting mid-descent is always allowed (Esc → confirm) and returns to the app's previous mode;
  the mode disposes itself (TECH §2.4). Re-entry restarts at pre-flight with stats history kept.

---

## 2. The world: what you see and why it's right

### 2.1 The Moon

- **Real scale.** 1,737.4 km radius, rendered 1:1 (TECH §3 for how). At 450 km up you see
  ~10.3% of the lunar surface in a single glance; the horizon is ~1,330 km away.
- **Real terrain.** Global LRO LOLA/SLDEM elevation (~60–120 m/px) + LROC WAC color, with
  per-site high-resolution patches (LROC NAC DTMs, 2–5 m/px) around the curated pads, and
  **deterministic procedural amplification** below data resolution: statistically faithful
  crater fields (power-law size-frequency), regolith micro-relief, and boulder clusters around
  young craters. Same seed every flight → the place feels *real* because it's *persistent*.
- **Recognizable geography.** Maria vs highlands albedo from real color data; the named feature
  under your track is shown on the HUD (`MARE TRANQUILLITATIS`) from an onboard IAU nomenclature
  list — flying over Copernicus should feel like flying over Copernicus.

### 2.2 The sky

- **The Earth** is the emotional anchor. Correct angular size (1.9° — about 3.7× the Moon as seen
  from Earth, and it's *plenty*: ~60 px at 1080p/60° FOV), correct **phase** from the real
  Sun–Earth–Moon geometry at the chosen date (Earth's phase is the complement of the Moon's),
  correct **fixed position** in the sky for the landing site (tidal locking; from Tranquility it
  hangs ~66° up toward the west and never moves — librations wobble it a few degrees per month).
  Clouds + night-lights on the dark fraction. A **hold-to-zoom "binocular" view** rewards staring.
- **The Sun** is a 0.53° disc you cannot meaningfully look at: rendered as glare + corona streaks
  driven by the existing bloom pipeline (with the no-bloom fallback from `gpuCapability`).
- **Stars** use the repo's existing HYG bright-star catalog + Milky Way panorama, correctly
  oriented. Visibility is governed by **physically anchored auto-exposure** (§2.3): full starfield
  on the night side or post-landing long-exposure; washed out when sunlit regolith fills the view —
  which is the truth, and it makes the moments when stars *do* appear land hard.
- **Lighting geometry comes from the app's own ephemeris** (`snapshotLighting(date)` pattern,
  already proven in moonFlight): Sun and Earth directions are frozen at entry — they drift less
  than a fraction of a degree over a 10-minute descent, and a frozen sun makes per-tile shadow
  baking possible (TECH §4.3).

### 2.3 Light, shadow, exposure

- **One light source.** The Sun, white and harsh. **Zero ambient.** Shadows go to black except for:
- **Earthshine** — the second light. A faint blue-gray fill from the Earth's direction, scaled by
  Earth's phase (full Earth lights the lunar night ~40× brighter than full moonlight on Earth —
  it's a real, visible effect and we want it: boosted ~3× above physical for shadow readability,
  declared in §8).
- **Opposition surge.** Lunar regolith retro-reflects: the surface visibly brightens around the
  exact anti-sun point (the "halo" Apollo crews photographed around their own shadow). A cheap
  BRDF term that makes the ground read unmistakably as *Moon*, not gray plaster.
- **Auto-exposure as drama.** Exposure keys to the fraction of sunlit surface in view: nadir over
  daylit maria → stars gone, terrain rich; pitch up to the black sky → stars bleed in; land on the
  night side by choice → the whole flight is starlight + earthshine. The camera behaves like an
  honest camera, and the player learns they can *compose shots* with it.
- **Terminator worship.** Low-sun terrain is the Moon's best look (4–11× shadow lengths at Apollo's
  5–14° sun). The pre-flight "best light" marker, the default site times, and the shadow-baking
  system all exist to put players over the terminator.

### 2.4 Vacuum honesty (the details that sell it)

- No atmospheric haze, no horizon glow, no distance fog — distant mountains are knife-sharp.
  (Distance is communicated by parallax, curvature, and scale-recognition instead.)
- Dust kicked by the engine flies in **ballistic radial sheets** and collapses instantly at
  cutoff. No billowing clouds. (Matches Apollo 16 mm footage.)
- Stars don't twinkle.
- No sound *outside* (see §6) — sound exists only as structure-borne cabin noise and radio.

---

## 3. Controls: "between a camera and a very easy sim"

### 3.1 Always (all seats, zero tutorial)

| Input | Action |
|---|---|
| Mouse drag / touch drag / gyro (mobile) | **Free look** — never locked, never taken away |
| Scroll / pinch | Zoom (FOV 30–75°); **hold Z**: binocular zoom on Earth or terrain |
| Space / big on-screen button | **Commit / advance** — the single "do the next thing" button |
| Esc | Pause sheet (resume / restart / change seat / exit) |
| R | Restart descent |

### 3.2 Right Seat (default) adds

| Input | Action |
|---|---|
| W / S or slider | **Descent-rate bias** (0.75×–1.5×) — the 5-vs-10-minute lever, within guidance |
| A / D | Cross-range nudge (±15 km early, narrowing as you descend) |
| Click-drag reticle (after high gate) | **Redesignate landing point** inside the reachable ellipse |
| Arrow keys (final 150 m) | Fine translation nudges |

### 3.3 Seats (difficulty)

- **Window Seat** — full autopilot incl. site choice; player just looks (and can still redesignate
  if they discover they want to). Cannot fail. For phones, kids, and the "I just want the view" crowd.
- **Right Seat** *(default)* — everything in 3.2. Guidance won't let you die; it *will* let you
  land firm and far from target. Skill expression: smoothness, accuracy, dust-blind final.
- **Left Seat** — manual throttle (Shift/Ctrl analog), attitude with SAS assist, real fuel budget
  (generous but finite), hazard tint optional-off, real crashes (§1.3). The KSP-shaped hole.

### 3.4 Feel rules

- Inputs are **rate-damped and clamped** — the craft always moves like a heavy, precise machine.
  No twitch. Camera shake only from engine thrust (subtle, < 0.3°) and touchdown thump.
- Guidance hand-off is **soft**: when the player nudges, guidance yields and re-converges, so
  control feels shared rather than fought over. (Think modern fly-by-wire, not autopilot toggle.)
- Every beat transition telegraphs itself 30–45 s ahead on the HUD (`HIGH GATE 0:42`), so nothing
  ever *happens to* the player without warning.

---

## 4. The HUD: instruments as storytelling

Two complete art directions were mocked up (see `mockups/`); **Glass** is the recommended default,
**Heritage** ships as an unlockable skin on the same layout grid (cheap: theme tokens only).

### 4.1 Layout (identical in both skins)

```
┌────────────────────────────────────────────────────────────────────┐
│  compass strip: heading · EARTH⊕ · SUN☉ · SITE▽ markers            │
│                                              MET T+02:47           │
│ D                                            PHASE: THE LONG FALL  │
│ E ALT                                        HIGH GATE IN 0:42     │
│ S tape                                                  ┌────────┐ │
│ C (log)                                                 │ SPEED  │ │
│ E                                                       │ V-SPD  │ │
│ N                          ___                          │ H-SPD  │ │
│ T                       landing                         ├────────┤ │
│   ┌─────┐              trajectory                      │ SURFACE │ │
│ ribbon   │               ribbon                         │ TEMP +  │ │
│   │ attitude                                            │ spark-  │ │
│   │ ring │            ⌖ site chevron                    │ line    │ │
│   └─────┘    feature name: MARE TRANQUILLITATIS         └────────┘ │
│         callout line: "HIGH GATE — PITCHING OVER"                  │
└────────────────────────────────────────────────────────────────────┘
```

### 4.2 Instrument spec

| Instrument | Behavior | Why it exists (story job) |
|---|---|---|
| **Descent ribbon** (far left) | Vertical journey bar, 450 km → 0, log scale, with phase ticks (ORBIT / BURN / FALL / APPROACH / FINAL) and a "you are here" dot | The non-pilot's anchor: *how much ride is left* at a glance. The single most important orientation device. |
| **Altitude tape** | Log-scale tape; switches source ORBITAL → RADAR (AGL) below 3 km with a visible re-zero blip | The log scale makes both 450 km and 45 m feel precise; the radar handoff is a real spacecraft moment. |
| **Speed block** | Total speed (auto-units: km/s → m/s), then split **V-SPD** / **H-SPD** bars; V-SPD grows a green "safe" band in final (≤ 3 m/s) | Splitting vertical/horizontal is *the* landing skill. Secondary km/h line for laypeople ("5,390 km/h" lands viscerally). |
| **Compass strip** | Heading with **EARTH ⊕, SUN ☉, SITE ▽** markers | Keeps the two celestial anchors findable; teaches that Earth never moves. |
| **Surface temp panel** | °C under the nadir track (±5 km footprint), 60 s sparkline, trend arrow. Driven by sun elevation + slope aspect + day/night thermal model (Appendix A): noon +120 °C → pre-dawn −180 °C; crossing the terminator mid-fall swings it >200° in a minute; sun-facing crater walls run hot | The user-requested star instrument. It converts *invisible* geography (light angle, latitude, night) into a live, dramatic number. Crossing into shadow *means something* now. |
| **Trajectory ribbon** | Predicted ground-track arc to the landing chevron, with downrange distance | Makes guidance legible: you always see where physics is taking you. |
| **Attitude ring** | Minimal horizon ring + prograde/retrograde + thrust vector (Heritage skin: full FDAI 8-ball) | Pitch-over and burn orientation made visible without flight-sim literacy. |
| **Landing reticle + hazard tint** (high gate onward) | Reachable-footprint ellipse → reticle with local slope °; terrain tints green/amber/red by slope & roughness (ALHAT-style) | The mode's core *choice*: where to land. Hazard tint is the guidance computer "speaking." |
| **Radar callouts** (final) | Big AGL digits + spoken/subtitled callouts (`30 METERS — DOWN AT 2½ — DUST VISIBLE`) | Apollo's soundtrack. Also the dust-blind trust-your-instruments beat. |
| **MET + phase + next-event** | `T+02:47 · THE LONG FALL · HIGH GATE 0:42` | Telegraphing (feel rule 3.4). |
| **Fuel / ΔV arc** (Left Seat only) | Remaining ΔV with reserve tick | Stakes, only for those who opted into stakes. |
| **G-meter** (subtle) | Peaks ~0.4 g in the burn, 0.17 g hover | Flavor; sells the physics. |

**Progressive disclosure:** instruments fade in/out by phase (orbit shows almost nothing; final
shows everything). HUD pixel coverage budget: **< 12%** of the frame, ever. Master toggle **H**
hides it all for screenshots.

### 4.3 Information honesty

Numbers on the HUD are the simulation's real numbers — no fake jitter. If the temp model says
−102 °C at sun elevation 2°, that's what physics-of-the-model produces (and it's within Diviner's
measured envelope). Players screenshot these; people will check.

---

## 5. Art direction

### 5.1 Direction A — **"Glass"** (recommended default)

Modern crew-vehicle glass cockpit (Dragon-adjacent) floating on the void:

- **Palette:** ice-cyan `#BFE7FF` strokes/text at 85–90% opacity on true black; single accent
  per semantic state: amber `#FFB75C` (warnings/next-event), green `#7CE0A2` (safe band/GO),
  red `#FF6B5C` (hazard/Left-Seat alarms). Nothing else, ever.
- **Type:** the mode's monospace (tabular numerals essential; DejaVu Sans Mono in mockups),
  3 sizes only. Small-caps labels, generous tracking.
- **Line work:** 1.5 px hairlines, corner-bracket framing instead of boxes, soft 1–2 px outer
  glow. Tapes/ticks over panels. ≥ 60% of HUD elements touch a screen edge — center stays clear.
- **Motion:** 150–250 ms ease-out fades; numbers tick through digits (odometer), never teleport.

*Why it wins:* maximum view, minimum noise, reads instantly on mobile, and photographs beautifully
(pillar 1). It's also the cheaper one to keep legible.

### 5.2 Direction B — **"Heritage"** (unlockable skin)

Apollo-era romance: phosphor amber/green on smoked glass panels, chunky digits, faint scanlines
+ CRT bloom, an FDAI 8-ball, a DSKY corner plate (`VERB 06 NOUN 63` during the fall — the real
descent display program), Quindar beeps on the radio. Pure fan service, same layout grid, theme
tokens + one texture. Risk if default: kitsch, busier pixels, worse small-screen legibility —
hence skin, not default.

### 5.3 The world's look

- **No stylization of the Moon itself.** Color grading stays near-neutral; the gray *is* the
  brand. Saturation lives in the Earth, the sun glare, and the HUD accents — by contrast design,
  the three colored things in frame are precisely the three things that matter.
- Craft presence is minimal and diegetic: landing-leg silhouettes entering the lower frame in
  final, RCS sparks at the frame edges, a long lander shadow racing in at touchdown. (Full
  exterior ship model + chase cam: explicitly v2 — see §9.)

---

## 6. Sound

| Layer | Content | Rule |
|---|---|---|
| **Vacuum** | Nothing. Exterior/long-exposure views are dead silent | Silence is the mode's most expensive-feeling asset; spend it (Earthrise hold, post-contact 3 s) |
| **Structure** | Low engine rumble through the airframe, RCS thuds, pump whine, cabin air hiss as the noise floor | Everything low-passed; you *feel* the ship rather than hear it |
| **Radio** | CAPCOM-style callouts with Quindar beeps; AOS static at the opening; altitude callouts in final. Subtitled (HUD callout line) | Voice budget small (≈ 30 lines), synthesized or single VO session; full captions for accessibility |
| **Music** | Sparse ambient (Eno *Apollo* energy) at orbit and stillness only; ducks under radio; OFF toggle | Music never plays during the fall — the fall belongs to the rumble and the numbers |

---

## 7. Sites & light (curated content)

| Site | Coords | Hook | Notes |
|---|---|---|---|
| **Tranquility Base** | 0.67° N, 23.47° E | "Land where it began." Flat, forgiving — the default | Earth fixed ~66° up, west. Beginner |
| **Hadley–Apennine** | 26.1° N, 3.6° E | 4 km mountain wall + Hadley Rille snaking past the pad | Apollo 15. Scenery king. Intermediate |
| **Aristarchus Plateau** | 23.7° N, 47.4° W | The brightest ground on the Moon, cut by Vallis Schröteri | Albedo/contrast showcase. Intermediate |
| **Tycho Central Peak** | 43.3° S, 11.4° W | Land *on the peak* inside a 4.2 km-deep crater, 100 My-young boulders everywhere | Hazard-map showcase. Left Seat bait |
| **Shackleton Rim** | 89.9° S | The sun rolls along the horizon forever; Earth bobs *at* the horizon; −240 °C permanent shadow a few km below your +40 °C pad | The temp instrument's finest hour. Eerie |
| *Free descent* | anywhere | Pick any point from orbit; procedural amplification handles the surface | Quality floor lower than curated sites (declared in §8) |

If the chosen date puts the site in **lunar night**, pre-flight says so and offers (a) embrace it —
earthshine-and-instruments descent, the connoisseur option — or (b) one-tap "next good light."
**Eclipse cameo** (stretch, the app's signature theme): if a lunar eclipse is in progress, you
descend inside Earth's shadow under a copper sky — Earth as a black disc ringed in sunset fire.

---

## 8. Accuracy ledger

**Real, and we commit to it:** 1:1 scale; ephemeris-driven Sun/Earth geometry, Earth phase, and
fixed Earth position per site; LRO-derived terrain & albedo; 1.62 m/s² ballistics; no atmosphere
in any form (no glide, no haze, no billowing dust, no sound outside, no twinkle); Diviner-fit
surface temperatures; black shadows + earthshine + opposition surge; correctly oriented stars;
real feature names; Apollo-accurate dust behavior and low-sun landing doctrine.

**Licensed, on purpose, and disclosed (an in-app "REALISM NOTES" card states all of these):**

| License | Justification |
|---|---|
| Descent compressed to 5–10 min via ~3.0 km/s ΔV budget ("sporty" craft) | Physics-consistent; the alternative (real Apollo timeline from 450 km) is over an hour |
| Guidance envelope prevents death outside Left Seat | Pillar 3; fiction covers it |
| Earthshine boosted ~3× over physical | Shadow readability on consumer displays |
| Auto-exposure tuned ~1 stop toward "stars visible" vs a real camera | The sky is half the show |
| Procedural terrain below ~60 m/px data (statistical, deterministic) | No real data exists at that scale globally; we never invent *named* features |
| Idealized instruments (surface temp, hazard map) | 2070 tourist craft fiction; ALHAT/Diviner are real systems we're "productizing" |

---

## 9. Explicitly out of scope (v1)

Walking EVA · ascent/return to orbit · exterior chase camera & detailed ship model · failure
simulation beyond touchdown limits (no random aborts — *1202 alarm* lives as a radio easter egg,
not a mechanic) · multiplayer/ghosts · VR · whole-Moon meter-scale streaming (curated sites get
the meter-scale love) · time-of-day progression during a single descent (sun is snapshot-frozen;
it moves 0.008°/min — nobody can tell).

---

## 10. Accessibility & comfort

- Full experience with **zero required inputs** (Window Seat) — motion is slow, predictable,
  forward-vector dominant; no artificial camera shake beyond <0.3°; FOV user-adjustable; an
  optional comfort vignette during the pitch-over.
- All radio/callouts subtitled (the HUD callout line *is* the caption track). Music/SFX/voice
  sliders. HUD scale 100/125/150%. Color-blind-safe hazard tint (red/amber/green chosen with
  shape redundancy: hazard cells also hatch). Photosensitivity: no strobes; dust wash-out is
  gradual luminance, not flicker.
- Mobile: gyro look (existing `GyroSteering` pattern), two on-screen controls only (COMMIT,
  descent-rate slider), HD-pack download consent on cellular.

---

## Appendix A — Numbers the design stands on

*(for the full derivations and the rendering consequences, see TECH Appendix)*

| Quantity | Value |
|---|---|
| Moon radius / GM / surface g | 1,737.4 km / 4,902.8 km³s⁻² / 1.62 m s⁻² |
| Start altitude → visible surface fraction | 450 km → 10.3% (h / 2(R+h)); 200 km would give 5.2% |
| Horizon distance at 450 km / at eye height 2 m | ~1,330 km / ~2.6 km |
| Circular orbital speed / period at 450 km | 1.50 km/s (5,390 km/h) / 153 min |
| Earthrise duration (full disc clears limb) | ~50 s at this orbit (limb rate ≈ 0.039°/s vs Earth's 1.9°) |
| Free-fall from rest at 450 km | ~13–14 min, impact ~1.08 km/s → motivates powered profile |
| Total ΔV, default profile | ≈ 3.0 km/s (1.50 horizontal kill + ~1.1 vertical brake + margin) |
| Earth from Moon: angular size / brightness | 1.9° (3.7× Moon-from-Earth) / full Earth ≈ 40× full moonlight; earthshine ~10–15 lux vs 130 klux sunlight |
| Sun angular size | 0.53° |
| Libration wobble of Earth's sky position | ±≈8° lon, ±≈7° lat over weeks |
| Surface temp model | T_day ≈ 392·(sin elev)^¼ K; night → ~95 K equatorial; PSR floors ~25–40 K. Spot checks: elev 25° → +46 °C; 10° → −18 °C; 2° → −102 °C; noon → +119 °C |
| Apollo landing sun elevation | 5–14° (shadow length 4–11× object height) — adopted as "best light" |
| Touchdown limits (Left Seat) | ≤ 3 m/s feather · ≤ 6 m/s firm · beyond: structural; lateral ≤ 4 m/s; tilt ≤ 12° |
