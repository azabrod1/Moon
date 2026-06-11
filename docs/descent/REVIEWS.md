# Design Review — Findings & Dispositions

The P0 package was put through a three-persona critique round (game/UX designer, planetary
scientist/trajectory engineer, real-time 3D/WebGL engineer). Each reviewed the docs *and* the
rendered mockups (the accuracy reviewer re-derived every number independently; the graphics
reviewer verified every code citation against `src/`). This file records what they found and
what we did about it. **Net effect: the trajectory was re-derived and now closes; the mockups
were re-staged onto one physically consistent scenario; the asset plan lost an
order-of-magnitude arithmetic error; and the ride gained its missing beat ("the wall").**

Verdicts, verbatim spirit: the designer **withheld sign-off on one blocker** (trajectory
inconsistency) and called the rest "ahead of most P0s"; the accuracy reviewer: "static physics
excellent; dynamics not yet self-consistent"; the graphics reviewer: "would not greenlight P1
on S1+S2 alone" pending three load-bearing fixes. All three blockers are resolved below.

## Blockers (all fixed)

| # | Finding (reviewer) | Disposition |
|---|---|---|
| B1 | **Descent profile didn't close** (designer + accuracy, independently): beat table implied a 2 km/s average fall, "~3.0 km/s ΔV" only matched the slow end, "engine quiet" contradicted mockup speeds, burn g was wrong ~5× (0.4 g vs real 2.2 g), free-fall time misquoted (true radial-Kepler: 15.1 min) | **Re-derived end to end** (DESIGN §1.2 + App. A): vector burn (90 s, ~2.2 g, ΔV ≈ 2.0) → true engine-off ballistic fall (437→60 km, −1,400→−1,704 m/s) → braking wall (59 s, ~2.9 g) → approach/final. Default 8:50, envelope 6:00–10:30, **ΔV ≈ 3.3–5.0 (default ≈ 4.0)** stated honestly in the ledger. Every mockup HUD number recomputed (02 now shows the ballistic −1,612 m/s at 180.4 km with "THE WALL 1:14" — and the arithmetic is in the caption) |
| B2 | **Asset volumes off 10–50×** (graphics): "global height L0–L7 in ≤45 MB" was ~1.1 GB raw; "global real floor L7–L9" was ~13 GB | TECH §4.1/§5.2 rewritten: global real heights **L0–L5** in core; L6–L9 only in **descent-corridor + site cones** (guidance knows the trajectory — prefetchable); pack files + HTTP Range instead of 10⁵ loose tiles; tile-count math shown in the appendix; P0.5 dry-run measures real bytes before the manifest freezes |
| B3 | **Per-tile shadow march can't make terminator shadows** (graphics): at 5–14° sun the occluders are tens of km outside the tile; per-tile-only baking degrades the mode's signature look and seams at borders | TECH §4.3: **two-stage bake** (far field vs always-resident coarse global; near field vs tile + explicit **apron contract**; parent inheritance below ~L12) + new **Spike S3** benchmarking exactly this on desktop + low-end Android |

## Majors (fixed unless noted)

**Experience (designer):** the 3-minute fall sagged → the re-derived profile *adds the wall*
(quiet-then-thunder structure) + tour-guide radio lines in the overture/fall. Earthrise was
skippable by the people who need it → COMMIT now **arms** with the descent window (diegetic
fill bar; mockup 01). Redesignation collided with free look / had no touch story → §3 controls
tables now have desktop/mobile columns (reticle-anchored drag; tap + confirm chip; press-hold
binoculars; two persistent mobile controls + contextual chips). Camera frame unspecified →
§3.4 feel rule (craft-frame look, soft recentering, vignette on commanded rotations, gyro
blend-out). "Timeline politely waits" vs orbital mechanics → **commit windows** with ~90 s
grace, next-window state, and a *declared* skip-to-window jump cut. Left-edge ribbon + alt
tape were near-duplicates → merged into the **journey tape**. Replay loop thin → composite
grade ("FEATHER · NEAR PAD"), per-site medals on pre-flight, Heritage unlock = first Feather,
**nameplate photo** promoted into the spec, stillness **time-lapse** (stars wheel, Earth holds
still). Final-phase HUD carried approach furniture → progressive disclosure now *retires* the
footprint/hazard/redesignation at low gate; **big docked AGL/V-SPD digits** own the dust beat
(mockup 03 re-staged accordingly).

**Accuracy:** Earth phase was **inverted** in all mockups (78% gibbous impossible with sun
10.3° at the site) → one consistent staging adopted everywhere: morning sun, **Earth = 61%
gibbous** (the complement rule, now also spelled out in App. A); pre-flight date jumped to the
next sunrise with the jump labeled (the original "now" was lunar night). Star/Milky-Way
visibility exceeded the declared license by ~15 stops → **license rewritten to the honest
rule** (stars never over sunlit ground; payoffs = farside night, night descents,
long-exposure) and the mockups de-starred (02/03 sky black + sun glare; 04 = Earth alone in a
black daylight sky, which is also the Apollo-photo look). Mockup sky geometry → 04 recomposed
looking *up* with Earth at her true 66°; 02/03 drop the (truly overhead) Earth and edge-pin
her on the compass instead; FOV convention (horizontal vs vertical) now stated everywhere both
numbers appear. Shackleton "+40 °C pad / −240 °C below" failed its own model → corrected to
pad ≈ −110…0 °C and **floor ≈ −185 °C** (Diviner), DESIGN §7 + App. A. Horizon curvature at
eye height (a myth re-import) → 03/04 drawn straight; only the 180 km frame curves. CGI Moon
Kit misquoted (~100 m/px → it's ~399 m/px; kit displacement 474 m/px) → TECH §5.1 sources
native WAC/SLDEM2015 from LROC/PDS and says so. HYG star catalog is **CC BY-SA, not PD** →
attribution shipped in-app, noted in TECH §5.1. Thermal spot-checks corrected (25°→+43 °C,
10°→−20 °C, 2°→−104 °C; mockup 02's +21 °C now honestly labeled SUN 19°). Gate names used at
~3× Apollo altitudes and touchdown limits ≈ 2× LM → both disclosed in the ledger. Tycho depth
4.2→4.8 km. Libration wording fixed (±8°). Terminator temp-swing claim softened to ~170 °C.

**Graphics/integration:** `buildComposer` hardcodes the shared scene (`main.ts:206`) and the
no-bloom fallback too (`main.ts:224`) → TECH §2.1 now specifies the shell refactor + widened
S1. Tone mapping applies *after* bloom in this chain → exposure moved **pre-bloom**, per-mode
bloom params (the `cam === planetariumCamera` ternary noted), S1 AC "terrain never blooms".
Far plane must include relief (Mons Hadley visible from ~125 km at ground level — would have
been culled at touchdown) → relief-inflated far in §3. BRDF as written would have killed
earthshine in shadows → sun-shadow gates only the sun light (shader-architecture note in §6).
Composer render targets were missing from the VRAM budget (~227 MB at dpr 2!) → **pixel-ratio
policy ≤ 1.5**, composer line added, AA decision (no MSAA through composer) scheduled in S1.
16-bit PNG heights through canvas = 78 m terraces → **terrain-RGB** encoding named in §5.2.
Tile-build throughput vs a 900 m/s descent under-supplied on mobile 2–5× → corridor prefetch
(guidance knows the future), 128² mobile bakes, parent shadow inheritance, S3 gates.
Activation awaited behind the mode-switch overlay would trap users mid-download →
`activate()` resolves at board-interactive (§2.2). Exposure slewing mutates shared renderer
state → snapshot/restore in disposal (§2.4). HUD DOM moved to programmatic build (moonFlight
precedent) keeping "zero bytes until entry" honest. Minor adopted as specced: world-scene
background null, CSM casters craft-only, SSE error = per-tile height deviation, exposure uses
baked mean-shadow, `getTargetPixelRatio` branch, `setWorkerLimit`.

**Roadmap:** P3 split (terrain vs landing gameplay); **P0.5 asset-pipeline phase** added (it
was the hidden schedule); S3 added; free descent → v1.1; eclipse cameo carries its real price
(bake invalidation); Shackleton sequenced last among sites.

## Rejected / consciously kept

- **Start at 200 km to make "~3 km/s" literally true** (accuracy reviewer's alternative):
  rejected — the brief asks for 5–10% of the Moon in view and the 450 km opening postcard is
  the product; we paid the honest price in the ledger instead (ΔV ≈ 4).
- **Removing the orbital overture** to shorten the ride: kept at ~3 min (it carries Earthrise,
  the tour lines, and the window fiction) but made skippable via the declared jump cut.
- **Stars faintly visible over sunlit terrain "because pretty":** rejected outright; the
  honest exposure rule is now load-bearing design (it *creates* the long-exposure payoff).
- **Mockup staging compromises that remain, declared in captions:** mockup 01 compresses the
  night fraction of the orbital view for composition; mockup terrain is painterly (SVG), not
  data-derived. Both are P0-mockup licenses, not product licenses.

## Round 2 — game design (three personas, post-revision)

A second round ran on the revised package at the owner's request: **game feel/systems** (flight-game
veteran lens), **onboarding/retention** (casual/mobile lens), **emotional pacing/sensory** (narrative
lens). Verdicts: "one revision away from the player *feeling* the agency it architecturally
contains" / "finish yes, come back no — as specified for phones" / "the descent is designed;
the landing, emotionally speaking, is not yet." All three were right. Accepted and actioned:

**Agency got costs and a baseline (game feel).** The zero-input Right Seat ride now lands
FIRM-in-the-ellipse with seeded dispersion — every better grade is provably player-made (P2
AC). Redesignation gained its missing tradeoff: accuracy judged against *your* point, visible
ΔV-margin cost, and **scenic spots** (named, view-rich, medal-bearing, amber-adjacent —
safe-flat vs spectacular-tight, the tourist fiction become mechanic). Bias now animates its
consequences (burn forecast + ellipse shrink) and locks at the wall; commit timing is a
visible margin micro-skill; the fall got *hands* (binocular feature-tagging, marker-aimed
nudges, in-flight camera) instead of more radio; a beat × control matrix pins what's live
when; compass markers are look-snap buttons; "smoothness" is now a kept promise (commendation
line). Architecture: guidance drives throttle+attitude **through the single engine model** —
seats differ only in who closes the loop (kills the Left Seat retrofit trap; P2 AC).

**The phone path got fixed (onboarding).** BEGIN unlocks at orbit-ready with the live orbit
scene behind a translucent board (the wow happens *during* the download); first entry is one
summary card, the three-panel board unlocks after the first landing; portrait-first declared
with the HUD collapse specced and a portrait key-frame due in P1; stillness payoffs and SHARE
are chips, not keyboard keys; "a phase owns one control" rule; instruments say BRAKING BURN
while the radio says "the wall"; seat subtitles load-bearing; "FINAL APPROACH · ~3 MIN" short
ride after first completion; ephemeris-driven return hooks ("Hadley hits sunrise June 18");
visible grade margins ("0.6 m/s over Feather") as the failure-free tension; type floor (12/14 pt).

**The ending got staged (emotional).** Contact now cuts *everything including the cabin hiss*
(the silence ladder: unscored Earthrise → mechanically-quiet fall → total-cut contact), holds
6–8 s, then one cooling-hull tick → interruptible camera drift up to Earth → the radio line →
stats card only on first input. The Earth-withhold (given at Earthrise, taken for the descent,
returned at stillness) is declared load-bearing with one protecting radio line. One radio
voice defined (off-duty test pilot register; text-only + Quindar as the *stronger* choice).
High gate staged as the arrival beat ("There's your pad"). Transients row added (cutoff thunk,
ignition bang, g-creaks, dust crackle that cuts at engine stop, haptics) with the kitsch line
drawn (no heartbeat, no breathing). "IT NEVER MOVES" is no longer printed — it's discovered.

**Round 2 refined a Round 1 disposition:** Round 1 added tour-guide radio "in the overture and
fall"; Round 2's emotional reviewer correctly pushed back — the fall is now hard-capped (one
geography line + the brace call), and the chatter lives in the overture. The fall's engagement
is manual (tagging, aiming), not narrated.

**Deferred / owner decisions:** portrait mockup frame → P1 deliverable (policy + collapse
specced now); mode name → owner question in README (reviewer pitches: Descent / Earthrise / Window
Seat) — **owner chose "Descent"**; code identifiers `descent`, design branch stays `moonLanding`; scenic-spot content beyond Tranquility → lands with each site pack (P5).

## Process note

Mockups are generated (`mockups/generate.mjs`), so every numeric fix above was applied to the
*generator* and re-rendered — the PNGs in this folder are the post-review state. The
pre-review renders exist in git history (first commit of this branch) for comparison.
