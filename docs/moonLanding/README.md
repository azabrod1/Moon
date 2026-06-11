# Moon Landing Mode — Design Package (P0)

A new lazily-loaded app mode: begin in lunar orbit ~450 km up (a tenth of the Moon beneath
you, Earth rising over the limb), ride a guided 5–10 minute powered descent, and land — on
real LRO terrain, under real ephemeris lighting, with instruments that tell the story.

| Doc | What's in it |
|---|---|
| [DESIGN.md](DESIGN.md) | The experience: vision & pillars, the descent's beat-by-beat arc, controls & difficulty seats, full HUD/instrument spec, art direction (Glass vs Heritage), audio, sites, accuracy ledger, accessibility, descope list |
| [TECH.md](TECH.md) | Architecture & feasibility: app-shell integration, precision/depth strategy, quadtree terrain + procedural amplification + baked-sun shadows, asset pipeline & budgets, lighting/exposure, guidance, risks & spikes |
| [ROADMAP.md](ROADMAP.md) | P0–P6 phases with acceptance criteria; risk-killing spikes first |
| [REVIEWS.md](REVIEWS.md) | Design-critique round (3 reviewer personas) and what changed because of it |
| [mockups/](mockups/) | Rendered key frames (below) + the generator that produces them |

## Mockups

| Frame | Beat |
|---|---|
| `00-preflight` | Pre-flight board = loading screen (site / light / seat / checklist) |
| `01-arrival` | Orbit & Earthrise over the terminator, HUD booting, commit prompt |
| `02-long-fall` | Mid-descent, full **Glass** HUD (recommended direction) |
| `02b-long-fall-heritage` | Same frame in the **Heritage** skin (unlockable) |
| `03-final-approach` | 31 m AGL: reticle + big docked digits, radar callouts, ballistic dust (approach furniture retired) |
| `04-stillness` | Post-landing, looking up: Earth alone in a black daylight sky at her true 66°, stats card |

Mockups are **generated, not drawn** — and the terrain is a real render:
`mockups/terrainPlate.mjs` builds an actual heightfield (power-law crater bowls + fBm
regolith + rocks), hillshades it with **marched cast shadows under the frozen sun**, and
projects it through a ray-sphere camera (true horizon curvature at every altitude) — i.e.,
**a working miniature of the exact terrain recipe in TECH §4**. The orbital frame samples the
repo's real `public/textures/moon.jpg` for albedo. `generate.mjs` lays the vector HUD/sky
over those plates (and falls back to pure vector if plates are absent):

```bash
cd docs/moonLanding/mockups
npm i --no-save pngjs jpeg-js @resvg/resvg-js   # ad hoc, not project deps
node terrainPlate.mjs                  # renders plate-01..04.png (~20 s)
node generate.mjs                      # writes the SVGs (reference the plates)
node render.mjs                        # SVG → PNG (inlines plates, system DejaVu fonts)
```

They are mockups, not engine output: consistent staging and lighting, and every HUD number is
physically cross-checked (DESIGN Appendix A, REVIEWS.md).

## Decision log

| # | Decision | Why (details in docs) |
|---|---|---|
| D1 | Descent is **powered**: burn → engine-off ballistic fall → braking "wall". Default 8:50, envelope 6–10½ min, **ΔV ≈ 3.3–5.0 km/s (default ≈ 4.0; Apollo flew ~2.0)** — no time-warp; the only clock trick is a *declared* skippable orbital coast | Vacuum honesty: you can't glide on the Moon; free-fall from 450 km is 15.1 min. The trajectory now closes end-to-end (DESIGN §1.2, App. A; REVIEWS B1) |
| D2 | Start at **450 km** | h/2(R+h) = 10.3% of the Moon in view — the brief's 5–10% target. Kept over a "cheaper-ΔV" 200 km start; the ledger pays the price honestly (REVIEWS) |
| D3 | **Guided descent with player expression**, 3 seats (Window/Right/Left), commit windows, camera = craft-frame with soft recentering | "Between a camera and a very easy sim" (DESIGN §3) |
| D4 | **Glass** HUD default, **Heritage** unlockable (first Feather) on the same grid | Max view, min noise (DESIGN §5) — owner sign-off wanted |
| D5 | Real scale, meters, **camera-relative rendering + sky/world depth split** (no log-depth); relief-aware far plane | Shared renderer forbids constructor flags (TECH §3) |
| D6 | Terrain = cube-sphere quadtree; real data **global to L5, corridor/site cones to L9/L13**, deterministic procedural below; **two-stage baked sun shadows** (far-field vs coarse global + tile/apron near field; sun frozen by snapshot) | Terminator-grade shadows at zero per-frame cost; asset math that actually closes (TECH §4–5; REVIEWS B2/B3) |
| D7 | Lazy mode chunk + asset packs (pack files + HTTP Range) behind the pre-flight checklist; `activate()` resolves at board-interactive; full disposal incl. shared-renderer state restore | Zero cost to the rest of the app (TECH §2, §5) |
| D8 | Surface-temp instrument driven by an analytic Diviner-fit model | The requested "cool graphics" made meaningful (DESIGN §4.2) |
| D9 | **Honest star exposure**: stars never render over sunlit ground; the night side and post-landing long-exposure/time-lapse modes are the payoff | Matches every Apollo surface photo; turns a constraint into a feature (DESIGN §2.2; REVIEWS M4) |

## Open questions for the owner

1. **Art direction default** — Glass (recommended) vs Heritage: see `02` vs `02b`.
2. **Asset hosting** — start in-repo (~180 MB across packs) vs CDN/release assets from day one (TECH R3/Q2).
3. Appetite for the **eclipse cameo** (descend inside Earth's shadow) — it's the app's signature theme, but it invalidates the baked sun-shadows, so it ships only with its real price (fade/rebake path) paid (DESIGN §7, TECH §4.3).
4. **The mode's name.** "Moon Landing" is generic and makes a third Moon-prefixed mode (Moon view, Moon flight). Round-2 review pitched: **"Descent"** (calm-ominous, matches the tone — reviewer's pick), **"Earthrise"** (names the emotional anchor; subtitle "a descent to the surface"), **"Window Seat"** (names the promise, friendliest). Code/branch names stay `moonLanding` until you pick.
