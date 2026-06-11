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
| `03-final-approach` | 31 m AGL: hazard map, reticle, radar callouts, ballistic dust |
| `04-stillness` | Post-landing: stats card, Earth fixed in a black sky |

Mockups are **generated, not drawn** — `mockups/generate.mjs` (zero-dep Node) paints them
deterministically so they can be tweaked like code:

```bash
cd docs/moonLanding/mockups
node generate.mjs                      # writes the SVGs
npm i --no-save @resvg/resvg-js        # renderer (not a project dependency)
node render.mjs                        # SVG → PNG (uses system DejaVu fonts)
```

They are mockups, not renders: theatrical but consistent lighting, and every HUD number is
physically consistent (cross-checked in DESIGN Appendix A).

## Decision log

| # | Decision | Why (details in docs) |
|---|---|---|
| D1 | Descent is **powered**, 5–10 min via ~3.0 km/s ΔV — no time-warp, no "gliding" | Vacuum honesty: free-fall from 450 km is ~14 min; atmosphereless descent must be propulsive (DESIGN §1.2) |
| D2 | Start at **450 km** | h/2(R+h) = 10.3% of the Moon in view — the brief's 5–10% target (App. A) |
| D3 | **Guided descent with player expression**, 3 seats (Window/Right/Left) | "Between a camera and a very easy sim" (DESIGN §3) |
| D4 | **Glass** HUD default, **Heritage** as unlockable skin on the same grid | Max view, min noise; nostalgia preserved (DESIGN §5) — owner sign-off wanted |
| D5 | Real scale, meters, **camera-relative rendering + sky/world depth split** (no log-depth) | Shared renderer forbids constructor flags; split keeps 24-bit depth happy (TECH §3) |
| D6 | Terrain = cube-sphere quadtree; real data to ~L9, **deterministic procedural below**, NAC patches at 5 curated sites; **per-tile baked sun shadows** (sun frozen by snapshot) | Terminator-grade shadows at zero per-frame cost (TECH §4) |
| D7 | Lazy mode chunk (existing `import()` precedent) + asset packs behind the pre-flight checklist; full disposal on exit | Zero cost to the rest of the app (TECH §2, §5) |
| D8 | Surface-temp instrument driven by an analytic Diviner-fit model | The requested "cool graphics" made meaningful (DESIGN §4.2) |

## Open questions for the owner

1. **Art direction default** — Glass (recommended) vs Heritage: see `02` vs `02b`.
2. **Asset hosting** — start in-repo (~180 MB across packs) vs CDN/release assets from day one (TECH R3/Q2).
3. Appetite for the **eclipse cameo** (descend inside Earth's shadow) in P5 — it's the app's signature theme.
