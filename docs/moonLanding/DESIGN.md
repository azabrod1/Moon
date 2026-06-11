# Moon Landing Mode — Experience Design

> **Status:** P0 design package, revised after the three-persona design review (see
> [REVIEWS.md](REVIEWS.md) for findings → dispositions). Companion docs: [TECH.md](TECH.md)
> (architecture & feasibility), [ROADMAP.md](ROADMAP.md) (phased delivery),
> [mockups/](mockups/) (rendered key frames).

---

## 0. Vision

**You are coming down to the Moon, and you have ten minutes to fall in love with it.**

The mode opens in lunar orbit, 450 km up, with a tenth of the Moon spread beneath you and the
Earth rising over the limb. It ends with your boots-level camera sitting in gray dust, engine
off, in total silence, with the Earth hanging fixed in a black sky. Everything between — the
burn, the long fall, the wall, the dust — is built so a person who has never flown anything can
ride it like a window seat, while a person who wants to *fly* it can take the stick.

This is not a simulator and not a cutscene. It is a **guided descent with player expression**:
guidance manages the trajectory; where you look, how hard you ride, and *where exactly you
land* are yours.

### Design pillars

1. **The Moon is the star.** Every system (lighting, LOD, exposure, HUD restraint) serves the
   terrain and the sky. If a feature competes with the view, the feature loses.
2. **Accurate by default, licensed on purpose.** Real scale, real ephemeris, real data, real
   vacuum behavior. Every deviation is deliberate, listed in §8, and shown in-app.
3. **A window seat, not a cockpit exam.** Zero learning curve for the full experience; optional
   depth for stick-and-throttle people. Nobody bounces off the controls.
4. **Instruments as storytelling.** Each readout (surface temperature, vertical speed, the
   journey tape) exists to make the player *understand what is happening to them*.
5. **Self-contained and weightless to everyone else.** Lazy-loads on entry, fully disposes on
   exit; the rest of the app pays zero cost (TECH §2, §5).

### The fiction (one sentence, zero cutscenes)

You're the passenger-pilot of a small near-future tourist descent craft — which quietly
justifies the glass HUD, the guidance envelope that won't let a tourist die in the default
seat, the surface-temperature readout, and a ΔV budget twice Apollo's.

---

## 1. The player journey

### 1.1 Pre-flight (entry screen = loading screen)

Entering the mode lands on a **pre-flight board** that doubles as the asset loading screen, so
the one-time download is part of the fiction (mockup `00`):

- **SITE** — five curated sites (§7) on a small globe, each with a one-line hook, a difficulty
  hint, and your **best-landing medal** so far (the collect-the-set loop).
- **LIGHT** — date picker defaulting to *now*; if "now" is lunar night at the site it says so
  and offers one-tap **next good light** (or embrace the night — §7). Live preview: sun
  elevation, Earth phase (always the complement of the Moon's — sun at 10.3° over Tranquility
  ⇒ Earth is a 61% gibbous), a ★ on terminator-adjacent times. Apollo landed at sun elevations
  of 5–14° for exactly this reason: long shadows make the Moon legible and dramatic.
- **SEAT** — Window Seat / Right Seat (default) / Left Seat (§3.3).
- **Loading checklist** — packs stream while you choose, surfaced as launch-checklist lines
  (`TERRAIN ATLAS … GO`). Download size shown up front; cellular users get an explicit consent
  step. The BEGIN button visibly **arms** (fills) and unlocks only when the checklist is green.

### 1.2 The descent arc

Default Right Seat profile. **The trajectory closes** (full derivation in Appendix A): vector
deorbit burn, then a true engine-off ballistic fall, then a hard braking burn — ~4.0 km/s of
ΔV, descent (commit → contact) **8:50**, swung **6:00–10:30** by the player's descent-rate
bias. There is no time-warp; the only clock trick in the mode is the *skippable orbital coast*
below, declared on the REALISM card.

| MET | Beat | Alt | What happens |
|---|---|---|---|
| 0:00 | **AOS** | 450 km | Fade in over the far side's last dark kilometers; radio static resolves into a voice; the HUD boots line by line. |
| 0:10–1:00 | **Earthrise** | 450 km | Earth's blue limb breaks the gray horizon and climbs — full disc in ~50 s (the true rate at this orbit). Free look; a one-time "pinch/scroll to look closer" nudge. |
| 1:00–3:00 | **The overture** | 450 km | Coasting toward the descent point at 1.50 km/s. Tour-guide radio lines keyed to the geography sliding past (Smythii, Crisium…). The COMMIT button is visible and **filling** — "GUIDANCE ALIGNING — WINDOW IN 2:28". Impatient? **SKIP TO WINDOW** jump-cuts the coast (declared license). Miss the window? It stays open ~90 s, then the radio owns the apology and the HUD shows the next one (one orbit, 153 min — skippable the same way). |
| 3:00–4:30 | **The burn** | 450 → 437 km | Commit → 90 s retrograde-and-down vector burn, **ΔV ≈ 2.0 km/s, ~2.2 g sensed** — the seat finally pushes back. Orbit ribbon on the HUD bends to intersect the surface. |
| 4:30–8:35 | **The long fall** | 437 → 60 km | **Engine off. True silence.** Vertical speed builds −1,400 → −1,704 m/s under gravity alone; the Moon inflates from a globe into a *place*. Mid-fall the craft pitches windows-down (soft-recentered look, §3.4). Cross-range nudges; temp readout sliding as the morning terminator nears; one radio line: *"Coming up on the wall. Brace."* |
| 8:35–9:35 | **The wall** | 60 → 6 km | The braking burn. **~2.9 g**, one minute of thunder, plume glow on the terrain, the speed tape unwinding 1,704 → 140 m/s. The ride's loud counterweight to the silent fall. |
| 9:35–10:50 | **High gate** | 6 km → 500 m | Apollo-style pitch-over: the forward horizon rotates into view; landing footprint ellipse + hazard tint appear; **redesignation** unlocks (tap/click-drag). The most "pilot" moment. |
| 10:50–11:50 | **Low gate & final** | 500 → 0 m | Vertical descent, V-SPD capped −30 m/s then tapering. Approach furniture retires; **big docked AGL/V-SPD digits** appear by the reticle. At ~40 m the **dust** starts — ballistic radial sheets, not billows — washing out the surface exactly when you need instruments most. Radar callouts: *"30 meters — down at 2½ — dust visible — trust the tape."* |
| 11:50 | **Contact** | 0 m | Probe light, engine stop, dust falls out of the sky instantly (no air). **Three full seconds of designed silence.** Then the stats card. |
| after | **Stillness** | 0 m | Free look from the surface; Earth fixed at the site's true azimuth/elevation. **Hold L** — long-exposure: the Milky Way blooms. **T** — time-lapse: the stars wheel while Earth *holds perfectly still* (the app's signature fact, made watchable). **N** — nameplate photo (§1.4). Stay as long as you want. |

**Why this is honest:** the Moon has no atmosphere — you cannot glide or aerobrake; every
descent is propulsive. Free-fall from rest at 450 km takes 15.1 minutes and hits at 1.08 km/s
(App. A). Our craft buys the 6–10½-minute window with a hot ΔV budget (~3.3–5.0 km/s across
the bias range vs Apollo's ~2.0 from a 15 km start) — *physics, not time-warp*, and the
REALISM card says exactly that.

### 1.3 Failure & retry

- **Window/Right Seat:** un-failable. Guidance clamps the envelope; sloppy inputs produce a
  *firm* landing and a lower grade, never a crash.
- **Left Seat:** real failure. Exceed limits (vertical > 6 m/s, lateral > 4 m/s, tilt > 12°,
  boulder strike) → tasteful cut: freeze-frame telemetry in red, no explosion porn, instant
  "fly final again from 2 km" retry or full restart. (Limits ≈ 2× the real LM's design
  envelope of 3 m/s vertical / ~1.5 m/s lateral at ≤12° — our gear is rated for tourists;
  declared in §8.)
- **Stats card** for everyone: touchdown velocity, tilt, distance from pad, peak g, fuel
  margin (Left Seat), descent time, and a **composite grade**: touchdown quality × accuracy —
  "FEATHER · ON THE PAD" is the chase. Grades: Feather / Firm / Hard / Structural.

### 1.4 Session shape & replay

- Full ride ≈ 9–14 min including the overture; descent itself 6–10½ by bias.
- Replay loop: 5 sites × lighting × seats × the medal board on pre-flight (best grade + best
  distance per site). **Heritage skin unlocks at your first Feather.** Stats history surfaced
  on the board.
- **Nameplate photo (N):** a composed share card — your framing, site name + coordinates,
  date/lighting, grade, distance, Earth-in-frame — rendered clean at device resolution with a
  small mission-patch watermark. The 3 s of silence earns the screenshot; this makes the
  screenshot exist.
- Quit any time (Esc → confirm); the mode disposes fully; re-entry restarts at pre-flight with
  history intact.

---

## 2. The world: what you see and why it's right

### 2.1 The Moon

- **Real scale.** R = 1,737.4 km, rendered 1:1 (TECH §3). From 450 km you see 10.3% of the
  lunar surface; the horizon is 1,329 km away.
- **Real terrain.** Global LROC WAC color + LOLA/SLDEM2015 elevation (sourced native from
  LROC/PDS — see TECH §5 for honest resolutions), LROC NAC DTM patches (2–5 m/px) around the
  curated pads, and **deterministic procedural amplification** below data resolution:
  statistically faithful crater fields, regolith micro-relief, boulder clusters around young
  craters. Same seed every flight — the place is *persistent*, so it reads as real.
- **Recognizable geography.** Maria vs highlands albedo from real data; the named feature
  under your track on the HUD (`MARE TRANQUILLITATIS`) from an onboard IAU nomenclature list.

### 2.2 The sky

- **The Earth** is the emotional anchor. Correct angular size — 1.9°, which is ~3.7× the Moon
  seen from Earth (≈ 55 px at 1080p with a 60° *horizontal* FOV; ≈ 31 px if you quote the 60°
  *vertical* three.js convention — the mode's zoom range makes both states common). Correct
  **phase** from the real geometry (complement of the Moon's). Correct **fixed position** per
  site (tidal locking; from Tranquility she hangs at 66° elevation, azimuth 268°, forever —
  librations wobble that by up to ±8°/±7° over weeks). Clouds + night-lights on the dark
  fraction. **Hold-to-zoom binoculars** reward staring; an Earthrise-time nudge teaches it.
- **The Sun** is a 0.53° disc you cannot meaningfully look at: glare + corona via the bloom
  pipeline (no-bloom fallback per `gpuCapability`, like the other modes).
- **Stars: honest exposure, no fudge.** Sunlit regolith vs naked-eye stars is a ~15+ stop gap;
  like every Apollo surface photo, **stars do not render over a sunlit scene**. You get them
  when the scene key is dark: the farside-night opening, night-side descents, shadowed ground,
  and the post-landing **long-exposure mode** (+6 EV, grain, Milky Way) — that's the payoff
  structure, and it's true. Catalog: the repo's HYG-derived bright stars (CC BY-SA — attribution
  shipped in-app; TECH §5) + Milky Way panorama, correctly oriented.
- **Lighting geometry** comes from the app's own ephemeris via the `snapshotLighting(date)`
  pattern: Sun/Earth directions frozen at entry (they move 0.008°/min — invisible across a
  12-minute ride, and freezing the sun is what makes per-tile shadow baking possible, TECH §4).

### 2.3 Light, shadow, exposure

- **One light.** The Sun, white and harsh. **Zero ambient.**
- **Earthshine** — the second light: faint blue-gray fill from Earth's direction, scaled by
  Earth's phase (full Earth lights the lunar night ~40× brighter than full moonlight lights
  Earth; ~10–15 lux vs 130,000 lux of sunlight). Boosted ~3× over physical for shadow
  readability — declared.
- **Opposition surge.** Lunar regolith retro-reflects: the ground visibly brightens around the
  anti-sun point (the halo Apollo crews photographed around their own shadow). Cheap BRDF
  term; unmistakably Moon.
- **Auto-exposure as drama.** Exposure keys to scene content (sunlit-terrain fraction *and*
  shadow fraction — TECH §6). Pitch up at the black sky and stars bleed in; descend the night
  side by choice and the whole ride is starlight and earthshine. The camera behaves like an
  honest camera, and players learn to *compose* with it.
- **Terminator worship.** Low-sun terrain is the Moon's best look (shadow length 4–11× object
  height at Apollo's 5–14°). Default site times sit near the morning terminator. **Lighting
  doctrine is the player's choice of approach azimuth:** cross-sun (side-lit relief, the
  mockups' staging) or Apollo's own down-sun approach (sun behind, maximum terrain legibility)
  — the pre-flight LIGHT panel pitches both.

### 2.4 Vacuum honesty (the details that sell it)

No haze, no horizon glow, no distance fog — distant mountains knife-sharp; distance is told by
parallax, curvature, and scale. The horizon is *straight* at eye height (curvature is visible
from altitude, not from the ground). Engine dust flies in **ballistic radial sheets** and
collapses instantly at cutoff — no billowing (matches the Apollo 16 mm footage). Stars don't
twinkle. No sound outside (§6).

---

## 3. Controls: "between a camera and a very easy sim"

### 3.1 Always (all seats, zero tutorial)

| Desktop | Mobile | Action |
|---|---|---|
| Mouse drag | One-finger drag / gyro | **Free look** — never locked, never taken away |
| Scroll | Pinch | Zoom (FOV 30–75°) |
| Hold Z | Press-and-hold sky/terrain | **Binoculars** on Earth or ground |
| Space | Big on-screen button | **Commit / advance** — the one "do the next thing" button |
| Esc | Two-finger hold / pause glyph | Pause sheet (resume · restart · seat · exit) |
| H / R | — (menu) | Hide HUD / restart descent |

### 3.2 Right Seat (default) adds

| Desktop | Mobile | Action |
|---|---|---|
| W/S | On-screen slider | **Descent-rate bias** 0.75–1.5× — the 6-vs-10-minute lever, inside guidance |
| A/D | Tilt (gyro) or edge drag | Cross-range nudge (±15 km early, narrowing down) |
| Click-drag starting **on the reticle** (so it never collides with free look) | **Tap terrain** → confirm chip | **Redesignate** landing point inside the footprint ellipse (high gate → low gate only) |
| Arrow keys (final 150 m) | Small d-pad chip | Fine translation nudges |

### 3.3 Seats

- **Window Seat** — full autopilot incl. site; just look (redesignation still available if
  discovered). Cannot fail. Phones, kids, "I just want the view."
- **Right Seat** *(default)* — everything in 3.2; guidance won't let you die, will let you
  land firm and far. Skill = smoothness, accuracy, the dust-blind final.
- **Left Seat** — manual throttle (analog), attitude with SAS, real fuel (generous), hazard
  tint optional-off, real crashes (§1.3). The KSP-shaped hole — tuned *after* the ride
  (ROADMAP), never allowed to warp it.

### 3.4 Feel rules

- Inputs are rate-damped and clamped — a heavy, precise machine. No twitch.
- **Camera frame:** free look is **craft-frame**, with the player's look offset *softly
  recentered* during commanded rotations (pitch-to-windows-down, pitch-over) — that's what
  makes the gut-drop land. A comfort vignette accompanies any commanded rotation; mobile gyro
  is blended out during them and back in after.
- Guidance hand-off is soft: nudges yield and re-converge (fly-by-wire, not autopilot fights).
- Every transition telegraphs 30–45 s ahead (`THE WALL 1:14`) — nothing *happens to* you
  unannounced, and the callout line never duplicates a countdown already on screen.

---

## 4. The HUD: instruments as storytelling

Two art directions, same layout grid (mockups `02` vs `02b`); **Glass** default, **Heritage**
unlockable (§1.4).

### 4.1 Layout

```
┌────────────────────────────────────────────────────────────────────┐
│       compass strip · SUN☉ / SITE▽ / EARTH⊕ markers (edge-pinned   │
│        when off-strip)                          MET · PHASE        │
│ J                                               NEXT EVENT 0:43    │
│ O                                                      ┌─────────┐ │
│ U  ← phase ticks                                       │ SPEED   │ │
│ R  (ORBIT/BURN/                                        │ V / H   │ │
│ N   FALL/APPR/                ___                      ├─────────┤ │
│ E   FINAL) +                landing                    │ SURFACE │ │
│ Y   alt value             trajectory                   │ TEMP +  │ │
│     chip                    ribbon                     │ spark   │ │
│ T                                                      └─────────┘ │
│ A   ┌────────┐         ⌖ reticle (+ big AGL/V-SPD                  │
│ P   │attitude│            digits docked, final only)               │
│ E   └────────┘    feature name · MARE TRANQUILLITATIS              │
│              callout line (one at a time, captioned radio)         │
└────────────────────────────────────────────────────────────────────┘
```

### 4.2 Instrument spec

| Instrument | Behavior | Story job |
|---|---|---|
| **Journey tape** (far left — *one* instrument, not two) | Log-scale altitude 500 km → 1 m with the **phase ticks on its flank** (ORBIT/BURN/FALL/APPROACH/FINAL), a "you" dot, and the value chip riding it. Source flips ORBITAL → RADAR (AGL) below 3 km with a visible re-zero blip | The non-pilot's anchor: *how much ride is left* and *how high am I* are one glance. (Design review merged the old separate ribbon + tape: on a log scale they were near-duplicates.) |
| **Speed block** | Total speed (auto-units), split **V-SPD / H-SPD** bars. **Per-phase fixed bar scales with an audible/visible scale-swap blip** (fall: 0–1,800 m/s; final: 0–6 m/s with green safe band ≤ 3) — never silent renormalization | Splitting vertical/horizontal is *the* landing skill; the km/h secondary line ("5,810 km/h") is for the rest of us |
| **Compass strip** | Heading; **SUN ☉ / SITE ▽ / EARTH ⊕** markers, edge-pinned with elevation note when off-strip ("EARTH 79° UP") | Keeps the celestial anchors findable; teaches that Earth never moves |
| **Surface temp panel** | °C under the nadir track (±5 km), 60 s sparkline, trend glyph. Analytic Diviner-fit model (App. A): T_day ≈ 392·(sin elev)^¼ K floored to the night curve; slope-aspect modulated (sun-facing crater walls run hot) | Converts invisible geography — light angle, latitude, night — into one live dramatic number. Morning terminator crossings swing it ~170 °C in minutes |
| **Trajectory ribbon** | Predicted ground track to the landing chevron + downrange distance | Makes guidance legible: you see where physics is taking you |
| **Attitude ring** | Minimal horizon ring, prograde/retrograde, thrust vector (Heritage: full FDAI 8-ball — *a real 3D instrument, costed in ROADMAP P4, not a theme token*) | Burn and pitch-over made visible without flight-sim literacy |
| **Footprint + hazard tint + reticle** | High gate → low gate **only**: reachable ellipse, slope/roughness tint (green/amber/red, **hatched** for color-blind redundancy), reticle with live slope °. **Retires below low gate** | The mode's core choice: where to land. The computer "speaking" |
| **Big docked digits** (final only) | Large AGL + V-SPD pair docked by the reticle below ~50 m | The dust-blind "trust the tape" beat — the numbers you bet the landing on, where your eyes already are |
| **MET · phase · next event** | `T+07:21 · THE LONG FALL · ENGINE OFF · THE WALL 1:14` | Telegraphing (§3.4) |
| **Fuel/ΔV arc** (Left Seat) | Remaining ΔV with reserve tick | Stakes, opt-in only |
| **G-meter** (subtle) | ~2.2 g burn · ~2.9 g wall · 0.17 g hover | Sells the physics; feeds the stats card |

**Progressive disclosure:** orbit shows almost nothing; each phase swaps in *its* set and
retires the previous one (approach furniture dies at low gate — the final 500 m is reticle,
digits, dust). HUD pixel coverage < 12% always; **H** hides everything for photos.

### 4.3 Information honesty

HUD numbers are the simulation's real numbers — no fake jitter, and they cross-check (the
mockups' captions carry the arithmetic). If the temp model says −104 °C at sun elevation 2°,
that's what it shows. Players screenshot these; people will check. (They did — REVIEWS.md.)

---

## 5. Art direction

### 5.1 Direction A — **"Glass"** (recommended default)

Modern crew-vehicle glass cockpit floating on the void: ice-cyan `#BFE7FF` hairlines and text
on true black; one accent per semantic (amber = next event/warning, green = safe/GO, red =
hazard); monospace tabular numerals, 3 sizes; corner brackets instead of boxes; ≥ 60% of HUD
elements touch a screen edge — the center belongs to the Moon. 150–250 ms ease-out fades;
odometer digits. *Why it wins:* maximum view, minimum noise, mobile-legible, photographs
beautifully.

### 5.2 Direction B — **"Heritage"** (unlockable skin)

Apollo romance: phosphor amber/green on smoked panels, chunky digits, faint scanlines + CRT
bloom, DSKY corner (`VERB 06 NOUN 63` during the fall — the real descent display), Quindar
beeps. Same layout grid; mostly theme tokens **plus two real costs, named:** the FDAI 8-ball
instrument and the CRT overlay pass. Skin, not default: busier pixels, worse small-screen
legibility, and kitsch risk if it's the first thing people see.

### 5.3 The world's look

No stylization of the Moon itself — the gray *is* the brand; saturation lives only in the
Earth, the sun glare, and HUD accents, so the three colored things in frame are the three
things that matter. Craft presence is minimal and diegetic: leg silhouettes entering the lower
frame in final, RCS sparks at the frame edges, the lander's long shadow racing in at
touchdown. (Exterior ship model + chase cam: v2.)

---

## 6. Sound

| Layer | Content | Rule |
|---|---|---|
| **Vacuum** | Nothing. Exterior/long-exposure views are dead silent | Silence is the most expensive-feeling asset; spend it (Earthrise hold, the fall, post-contact 3 s) |
| **Structure** | Engine rumble through the airframe (the burn and the wall own the mix), RCS thuds, pump whine, cabin hiss floor | Everything low-passed; you *feel* the ship |
| **Radio** | CAPCOM-style callouts with Quindar beeps; AOS static; tour-guide geography lines in the overture and fall; altitude callouts in final. All subtitled via the callout line | **This is a system, not 30 lines:** a callout engine with priority/dedup against one display slot, dynamic-altitude triggers, and ducking — budgeted in ROADMAP P4 |
| **Music** | Sparse ambient at orbit and stillness only; ducks under radio; OFF toggle | The fall belongs to silence; the wall belongs to the engine |

---

## 7. Sites & light

| Site | Coords | Hook | Notes |
|---|---|---|---|
| **Tranquility Base** | 0.67° N, 23.47° E | "Land where it began." Flat, forgiving — the default | Earth fixed 66° up, az 268°. Beginner |
| **Hadley–Apennine** | 26.1° N, 3.6° E | 4 km mountain wall + Hadley Rille beside the pad | Apollo 15. Scenery king. Intermediate |
| **Aristarchus Plateau** | 23.7° N, 47.4° W | The brightest ground on the Moon, cut by Vallis Schröteri | Albedo showcase. Intermediate |
| **Tycho Central Peak** | 43.3° S, 11.4° W | Land *on the peak* of a 4.8 km-deep crater, 100 My-young boulders everywhere | Hazard-map showcase. Left Seat bait |
| **Shackleton Rim** | 89.9° S | The sun rolls along the horizon forever; Earth bobs at the horizon; a **−185 °C** permanently-shadowed floor a few km from a pad that never gets past ~**0 °C** even on a sun-facing tilt | The temp instrument's finest hour. Eerie. (Numbers per Diviner + our own model — the rim is *cold*, that's the point) |
| *Free descent* | anywhere | Pick any point from orbit; procedural floor | **v1.1 stretch** (QA explodes from 5 cones to a sphere — descoped from v1, ROADMAP) |

Night at the chosen date? Pre-flight offers (a) embrace it — earthshine-and-instruments
descent, the connoisseur ride — or (b) one-tap next good light. **Eclipse cameo** (stretch,
P5+): descending inside Earth's shadow under a copper sky is the app's signature theme — but
it invalidates the baked sun-shadow term (TECH §4.3), so it ships only with its real price
(shadow-term fade/rebake path), not as "a shader tint."

---

## 8. Accuracy ledger

**Real, and we commit to it:** 1:1 scale; ephemeris-driven Sun/Earth geometry, Earth phase and
fixed per-site position; LRO-derived terrain & albedo; 1.62 m/s² ballistics; no atmosphere in
any form (no glide, no haze, no billowing dust, no outside sound, no twinkle, straight horizon
at eye height); Diviner-fit temperatures; black shadows + earthshine + opposition surge;
honest star exposure (stars never over sunlit ground); real feature names; ballistic dust with
instant settling; Apollo's low-sun landing doctrine.

**Licensed, on purpose, disclosed on the in-app REALISM card:**

| License | Justification |
|---|---|
| Descent compressed to 6–10½ min via **ΔV ≈ 3.3–5.0 km/s** (default ≈ 4.0; Apollo flew ~2.0 from 15 km) | The honest price of starting at 450 km and landing inside ten minutes; physics-consistent throughout (App. A) |
| **Skippable orbital coast** (jump-cut to the descent window) | The one place we touch the clock; geometry stays true |
| Guidance envelope prevents death outside Left Seat | Pillar 3; the fiction covers it |
| Earthshine boosted ~3× over physical | Shadow readability on consumer displays |
| Touchdown limits ≈ 2× the real LM envelope | Tourist-rated gear; Apollo actually touched down at 0.5–1.0 m/s |
| "High gate / low gate" used at ~3×/3× Apollo's altitudes (P64 pitch-over was ~2.2 km; low gate ~150 m) | Borrowed vocabulary at our trajectory's scale, named honestly |
| Procedural terrain below real data resolution (statistical, deterministic) | No global data exists at that scale; we never invent *named* features |
| Idealized instruments (surface temp, hazard map) | 2070 tourist craft; Diviner and ALHAT are real systems we're "productizing" |

---

## 9. Explicitly out of scope (v1)

Walking EVA · ascent/return · exterior chase cam & ship model · free descent (→ v1.1) ·
failure sim beyond touchdown limits (the *1202 alarm* is a radio easter egg, not a mechanic) ·
multiplayer/ghosts · VR · whole-Moon meter-scale streaming · time-of-day progression during a
ride (sun frozen; it moves 0.008°/min).

---

## 10. Accessibility & comfort

Full experience with zero required inputs (Window Seat); slow predictable motion; comfort
vignette on every commanded rotation (§3.4); FOV adjustable; no strobes (dust wash-out is
gradual luminance). All radio subtitled (the callout line *is* the caption track); audio
sliders; HUD scale 100/125/150%; hazard tint hatched, not color-only. Mobile: gyro look
(existing `GyroSteering` pattern), two persistent on-screen controls (COMMIT, rate slider) +
contextual chips (confirm-redesignate, d-pad, pause glyph), HD-pack consent on cellular.

---

## Appendix A — The numbers (all cross-checked; see REVIEWS.md for the audit)

**Geometry & orbit.** Visible fraction f = h/2(R+h): 450 km → **10.29%** (200 km → 5.16%).
Horizon √(h(2R+h)): **1,329 km** from 450 km; **2.6 km** at 2 m eye height. v_circ(450 km) =
√(μ/r) = **1.497 km/s** (5,390 km/h); period **153 min**; orbital rate 0.0392°/s ⇒ Earth's
1.9° disc clears the limb in **~49 s**. Ground speed 1.19 km/s ⇒ the 300 km overture to the
descent window takes ~3 min (or one button press).

**The descent closes.** Free-fall from rest at 450 km (radial Kepler): **904 s = 15.1 min**,
impact 1.077 km/s — hence powered compression. Default profile: vector burn 90 s (kill 1,497 →
60 m/s horizontal, push −1,400 m/s vertical; ΔV ≈ 2.0 km/s; sensed ~2.2 g) → ballistic 437 →
60 km in 245 s (v_v → −1,704 m/s = −6,130 km/h) → wall burn 59 s, 60 → 6 km, −1,704 → −140
(≈ 2.9 g; ΔV ≈ 1.68) → approach 76 s to 500 m (−30 m/s) → final 60 s to contact (−2 m/s).
**Commit → contact 8:50; ΔV ≈ 4.0 km/s.** Bias envelope: ~6:00 at ≈ 5.0 km/s ↔ ~10:30 at
≈ 3.3 km/s (impulsive bounds + finite-burn losses). Mockup cross-checks: at 180.4 km coasting,
v_v = √(1,400² + 2·1.24·(437−180)·10³) ≈ **−1,612 m/s**, wall arrival in **74 s** ✓.

**Earth & Sun from the Moon.** Earth 1.90° (3.67× the Moon-from-Earth, ~13× area); ≈ 55 px at
1080p/60° *horizontal* FOV (31 px at 60° vertical — convention matters, both quoted). Sun
0.53°. Earth elevation at Tranquility = 90° − arccos(cos 0.674°·cos 23.473°) = **66.5°**, az
≈ 268°; librations ±7.9° lon / ±6.9° lat. **Phase coupling:** Earth lit fraction = 1 − Moon's;
morning sun at 10.3° over Tranquility ⇒ subsolar ≈ 103°E ⇒ Earth **61% gibbous**. Full Earth
≈ 40× full moonlight; earthshine ~10–15 lux vs ~130,000 lux sunlight.

**Thermal (Diviner-fit).** T_day ≈ 392·(sin elev)^¼ K floored to the night curve (~95 K
equatorial pre-dawn; measured terminator ground stays 120–200 K from thermal lag — the floor
models that). Spot checks: 25° → **+43 °C**; 18.5° → **+21 °C**; 10.3° → **−18 °C**; 2° →
**−104 °C**; noon → +119 °C. PSR floors: Shackleton ~88–90 K (**≈ −185 °C**); coldest PSRs
(Haworth class) 25–40 K. Shackleton *rim pad*: sun ≤ ~2° ⇒ flat ground ≈ −110 °C; best
sun-facing 12°-tilt pad ≈ **0 °C**; Diviner wall maxima 280–290 K (not landable).

**Apollo anchors.** Flown landing sun elevations 5.1–13°; LM gear envelope ~3 m/s vertical /
~1.5 m/s lateral / ≤12°; actual touchdowns 0.5–1.0 m/s; PDI from ~15 km, ΔV ≈ 2.0–2.1 km/s;
P64 pitch-over ("high gate") ~2.2 km; dust visible from ~30–40 m ("30 feet, picking up some
dust" scaled to metric); program alarms 1201/1202; Quindar beeps; V06N63 in P63.
