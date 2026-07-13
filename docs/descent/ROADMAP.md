# Descent — Delivery Roadmap

Phases are PR-sized, each independently shippable behind the mode's entry point, each with
acceptance criteria (AC) that are checkable by running the app (no test framework exists —
see TECH §10 for the QA approach). Order optimizes for **killing risk early** and **having a
beautiful screenshot at every milestone**. **MVP = the exit of P3b**: a one-site (Tranquility),
Window+Right-Seat vertical slice — everything after it is expansion, not completion.

---

## P0 — Design package *(this PR)*
Experience design, mockups, tech plan, critique log. **AC:** docs + rendered mockups reviewable
in-repo; critique round run and dispositioned (REVIEWS.md); open questions (art direction
default, hosting) surfaced to the owner.

## P0.5 — Asset pipeline *(scheduled work, not a footnote — review finding)*
`tools/descent/`: cube-face reprojection (GDAL), pyramid build, KTX2 encode, terrain-RGB
height packing, pack-file + Range-index format, manifest. **AC:** one full cube face dry-run
with **measured** output bytes vs TECH §5.2 targets; one NAC site cone blended into procedural
border without visible seam in a viewer; pack format frozen before P1.

## S1 + S2 + S3 — Spikes *(throwaway code, timeboxed, before feature work)*
- **S1 Depth/composer spike** ✅ *(done — [S1-FINDINGS.md](spikes/S1-FINDINGS.md); R1 retired)* *(scope widened by review)*: gray sphere at real scale,
  camera-relative transforms, sky/world two-pass through a **refactored composer** (per-mode
  pass list) **and the no-bloom fallback path**, fly 450 km → 2 m.
  **AC:** no z-fighting/jitter at either extreme; **terrain never blooms at any exposure**
  (exposure applied pre-bloom); world scene background null verified; both render paths
  correct; `toneMappingExposure` restored on exit; extra pass cost < 0.5 ms.
  *Result: all met except pass-cost (deferred — no headless GPU on the CI box; mechanism proven,
  number owed by real-hardware QA). "Never blooms" holds through the operational exposure range;
  the +4 EV over-crank bounds the auto-exposure clamp for P1. Shell refactor (`src/app/renderPipeline.ts`)
  is the surviving artifact; AA resolved to MSAA 4×, pending the §9 VRAM re-check.*
- **S2 KTX2-on-Pages spike:** one KTX2 + transcoder wasm from a Pages deploy.
  **AC:** Chrome/Firefox/Safari + one Android; MIME/caching documented; WebP fallback decision
  made here.
- **S3 Bake-throughput spike** *(new, from review)*: one 256² tile bake in a worker — apron
  assembly, two-stage shadow march (far field vs coarse global, near field vs tile+apron),
  crater stamps — on a mid desktop and a low-end Android; render two adjacent tiles side by side.
  **AC:** ≤ ~100 ms/tile desktop, ≤ ~300 ms phone (else 128² becomes the default and budgets
  re-derive); **no normal/shadow seam** on the pair; terrain-RGB decode path proves 16-bit
  fidelity (no 78 m terraces).

## P1 — "Orbit Postcard"
Mode skeleton (lazy chunk, activate/deactivate/update, entry button, `?auto=descent`),
core-pack loader behind a minimal pre-flight screen, MoonGlobe L0–L6 with real color+height,
SkyDome (stars, Milky Way, Earth with correct phase/position, Sun glare), snapshot lighting,
analytic exposure v1, free-look orbit drift with Earthrise timing.
**AC:** entering from planetarium and back leaks nothing (`renderer.info.memory` returns to
baseline); other modes' load time unchanged (network tab shows zero descent-mode bytes until
entry); 60 fps desktop / 30 fps phone in orbit; Earthrise matches ephemeris for the chosen
date; **BEGIN unlocks at orbit-ready with the live orbit scene behind the board** (full
checklist completes under the overture, SKIP disabled until corridor pack lands); first
orbital frame ≤ 8 s on 50 Mbps; a **portrait key-frame** added to the mockup set before the
HUD grid freezes.

## P2 — "The Fall"
DescentGuidance + FlightDynamics (fixed-step, deterministic), beat machine through the wall
and high gate (incl. **commit windows + arming + skip-to-window**), descent-rate bias +
cross-range nudge, HUD core (journey tape, speed block + scale-swap blips, compass with
edge-pinned markers, MET/phase, callout engine v1) in Glass, corridor streaming L6–L9.
**AC:** commit → contact at default bias = 8:10 ± 20 s, bias endpoints ≈ 5:45 / 10:15; **the
headless flight oracle is green** (1,000 seeded rendererless runs across the bias range:
always lands, zero-input grades FIRM-in-ellipse, envelope held, fuel ledger non-negative); **every
HUD number cross-checks** (countdowns vs integrator, V-SPD vs altitude math); **a zero-input
Right Seat run grades FIRM · IN THE ELLIPSE** (never Feather, never on-pad — the felt-agency
keystone); **guidance drives throttle+attitude through the single engine model** (no direct
acceleration writes — verified by the g-meter/audio/fuel reading one source); corridor
prefetch keeps finest-needed tiles resident through the wall; budgets hold.

## P3a — "Ground Truth" *(review split P3 — terrain is its own PR)*
Procedural amplification L10–L16 + boulders, apron contract + two-stage shadows in production,
site pack loading (Tranquility), deep-LRU streaming, collision.
**AC:** 1 m-scale detail at 60 fps desktop / 30 fps phone at Tranquility; same seed ⇒ same
boulders; no seam/crack/normal-seam in a slow 360° pan at 50 m and 2 m; throttled-phone tile
latency within S3 gates.

## P3b — "The Landing"
Low-gate/final beats, reticle + hazard tint + redesignation (tap + confirm on touch; ΔV-margin
ellipse shrink visible), **scenic spots at Tranquility** (2 tagged spots + medal), big docked
digits (bracket-style), radar callouts, touchdown grading + composite grade with **visible
margins** ("0.6 m/s over Feather"), stats card (waits for first input), **the staged contact
sequence** (silence cut incl. hiss → 6–8 s → hull tick → camera drift to Earth → radio →
card), stillness free look + chips.
**AC:** full default ride lands; zero-input baseline AC re-verified end-to-end; grading
matches DESIGN limits incl. designated-point accuracy; approach furniture retires at low
gate; dust-blind final flyable on instruments alone (playtest); the contact sequence plays
uninterrupted unless the player interrupts it.

## P4 — "Make It Sing"
Dust system (ballistic streaks + veil + instant settle), audio + **callout engine** (priority/
dedup, ducking, Quindar), surface-temp instrument + thermal model, attitude ring, binoculars +
Earthrise nudge, long-exposure + **time-lapse** modes, **nameplate photo**, comfort/
accessibility set, Heritage skin (tokens + **FDAI instrument + CRT pass — the two real costs**),
medals on the pre-flight board, Heritage unlock.
**AC:** the mockup beats are reproducible in-engine side-by-side; temp swings correctly on a
morning-terminator descent; every radio line captioned; nameplate photo shares at device res.

## P5 — "Open the Moon"
Remaining 4 site packs (Shackleton last — hardest light), full pre-flight board (live lighting
preview, "best light", night-descent offer), Left Seat (manual + fuel + crash/retry),
night-side + Shackleton QA, mobile hardening pass, **eclipse cameo only with its real price
paid** (baked-shadow fade/rebake path). *Free descent moved out of v1 → v1.1 (review: QA
explodes from five cones to a sphere).*
**AC:** five sites in budget on phone; Left Seat crash→retry < 5 s; cellular consent flow;
Shackleton temp instrument shows pad ≈ −60…0 °C vs floor −185 °C per the corrected model.

## P6 — Polish & ship
Loading-checklist UX final, stats history in store, REALISM NOTES card, docs (QA.md, asset
pipeline README in `tools/`), `npm run build` clean, deploy + on-device pass.
**AC:** owner walkthrough of DESIGN pillars vs the shipped ride; CLAUDE.md updated with the
new mode's architecture section.

---

### Sequencing notes
- P0.5 + S1/S2/S3 are *gates* for P1/P2; their failure modes change TECH §3/§4/§5 cheaply on
  paper instead of expensively in code.
- Heritage lands in P4 because it depends on the full instrument set existing (and carries the
  FDAI/CRT real costs).
- Left Seat is deliberately late: the ride (Window/Right) is the product; the sim layer must
  not warp guidance tuning earlier.
- Every phase ends with the "screenshot of the milestone" attached to the PR — keeps the
  pillar-1 pressure on.
