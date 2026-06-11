# Moon Landing Mode — Delivery Roadmap

Phases are PR-sized, each independently shippable behind the mode's entry point, each with
acceptance criteria (AC) that are checkable by running the app (no test framework exists —
see TECH §10 for the QA approach). Order optimizes for **killing risk early** and **having a
beautiful screenshot at every milestone**.

---

## P0 — Design package *(this PR)*
Experience design, mockups, tech plan, critique log. **AC:** docs + rendered mockups reviewable
in-repo; open questions (art direction default, hosting) surfaced to the owner.

## S1 + S2 — Spikes *(throwaway code, timeboxed, before any feature work)*
- **S1 Depth/composer spike:** gray sphere at real scale, camera-relative transforms, sky/world
  two-pass on the *shared* renderer+composer, fly 450 km → 2 m.
  **AC:** no z-fighting/jitter at either extreme; bloom pass still works in both scenes;
  measured frame cost of the extra pass < 0.5 ms.
- **S2 KTX2-on-Pages spike:** one KTX2 texture + transcoder wasm loaded from a Pages deploy.
  **AC:** loads on Chrome/Firefox/Safari + one Android phone; documented MIME/caching behavior.
  Fallback decision (WebP) made here, not later.

## P1 — "Orbit Postcard"
Mode skeleton (lazy chunk, activate/deactivate/update, entry button, `?auto=moonLanding`),
core-pack loader behind a minimal pre-flight screen, MoonGlobe L0–L6 with real color+height,
SkyDome (stars, Milky Way, Earth with correct phase/position, Sun glare), snapshot lighting,
analytic exposure v1, free-look orbit drift with Earthrise timing.
**AC:** entering from planetarium and back leaks nothing (`renderer.info.memory` returns to
baseline); other modes' load time unchanged (network tab shows zero moonLanding bytes until
entry); 60 fps desktop / 30 fps phone in orbit; Earthrise matches ephemeris for the chosen
date; first orbital frame ≤ 8 s on 50 Mbps.

## P2 — "The Fall"
DescentGuidance + FlightDynamics (fixed-step, deterministic), beat state machine through low
gate, descent-rate bias + cross-range nudge, HUD core (descent ribbon, alt tape, speed block,
compass, MET/phase, callout line) in Glass skin, quadtree streaming to L9 global.
**AC:** full ride orbit → 2 km at default bias lands in 7–8.5 min, bias endpoints hit ~5 and
~10 min; HUD numbers cross-check (next-event countdowns vs actual); tile pops acceptable at
fall speeds; budgets (TECH §9) hold over the whole fall.

## P3 — "Touch the Ground"
Procedural amplification L10–L16 + boulders, site pack loading (Tranquility first), collision +
touchdown grading, low-gate/final beats, landing reticle + redesignation, radar callouts,
stats card, post-landing free look.
**AC:** land at Tranquility with 1 m-scale detail at 60 fps desktop; same seed ⇒ same boulders
twice; touchdown classification matches DESIGN limits; no seam/crack visible in a slow 360°
pan at 50 m and at 2 m.

## P4 — "Make It Sing"
Dust system (ballistic streaks + veil + instant settle), audio (rumble/RCS/radio/Quindar/music
ducking), surface-temp instrument + thermal model, hazard tint + slope readout, attitude ring,
binocular zoom, long-exposure mode, comfort/accessibility items (captions, HUD scale, hatch
redundancy), Heritage skin tokens.
**AC:** the four "beauty moments" mockups are reproducible in-engine (side-by-side check);
temp readout swings correctly crossing a terminator descent; captions cover every radio line.

## P5 — "Open the Moon"
Remaining 4 site packs, free-descent (land anywhere on procedural floor), full pre-flight board
(site/light/seat with live lighting preview + "best light"), Left Seat (manual + fuel + crash/
retry), night-side and Shackleton lighting QA, mobile perf hardening, eclipse cameo if in
budget (it's a shader tint + ephemeris check — the app already classifies eclipses).
**AC:** all five sites within budgets on phone; Left Seat crash→retry loop < 5 s; free-descent
quality floor documented with screenshots; data caps respected on cellular (consent flow).

## P6 — Polish & ship
Loading-checklist UX final, stats history in store, REALISM NOTES card, docs (QA.md, asset
pipeline README in `tools/`), `npm run build` clean, deploy + on-device pass.
**AC:** owner walkthrough of DESIGN pillars vs the shipped ride; CLAUDE.md updated with the
new mode's architecture section.

---

### Sequencing notes
- Spikes S1/S2 are *gates* for P1; their failure modes change TECH §3/§5 cheaply at that stage.
- Heritage skin lands in P4 only because it depends on the full instrument set existing.
- Left Seat is deliberately last-but-one: the ride (Window/Right) is the product; the sim layer
  is a bonus and must not warp guidance tuning earlier.
- Every phase ends with the "screenshot of the milestone" attached to the PR — keeps the
  pillar-1 pressure on.
