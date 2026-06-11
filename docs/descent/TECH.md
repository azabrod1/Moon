# Descent — Technical Plan

> Companion to [DESIGN.md](DESIGN.md) and [ROADMAP.md](ROADMAP.md). Revised after engineering
> review (REVIEWS.md): asset arithmetic corrected, shadow bake split into two stages, composer
> integration stated honestly against the actual code. File/line references current at writing.

## 1. Hard requirements

1. **Zero impact on the rest of the app**: ~1 KB entry stub in the initial bundle, no assets
   fetched until entry, full disposal on exit (GPU memory, DOM, listeners, workers, **and
   shared-renderer state** — see §2.4).
2. **Real-scale Moon** (R = 1,737.4 km), 450 km → 2 m eye height, 60 fps mid-tier desktop,
   30 fps recent phone (with the mobile *mechanisms* of §9, not just budget hopes).
3. **Accurate lighting** from the app's own ephemeris (Sun/Earth direction, Earth phase),
   earthshine, honest exposure.
4. **New HD asset set**, streamed on entry behind the pre-flight board.

## 2. Integration with the app shell

Mode contract as established (`activate(date, onProgress)/deactivate()/update(dt)`, patterned
on `MoonFlightMode` — `src/moonFlight/MoonFlightMode.ts:86,156,191`), registered by extending
`AppMode` (`src/main.ts:48`) and dynamic-imported exactly like moonFlight (`src/main.ts:845`)
— Vite code-splits automatically.

**2.1 Rendering integration — requires a small, explicit shell refactor.** The current
`buildComposer(cam)` hardcodes the *shared* scene into its RenderPass (`src/main.ts:206`), and
the no-bloom fallback renders `renderer.render(scene, cam)` (`src/main.ts:224`). A mode that
owns a private scene therefore cannot just "pass its camera": the shell gets a per-mode render
delegate — `buildComposer(passes, cam)` taking a pass list (sky RenderPass, world RenderPass
with `clearDepth`, bloom, OutputPass), or the mode owns its composer and `renderScene()`
delegates to `mode.render()`. The **no-bloom path needs the same two-scene treatment**
(`autoClear = false`, render sky, `clearDepth()`, render world). Bloom strength/threshold are
currently a `cam === planetariumCamera` ternary (`src/main.ts:209–211`) — replace with
per-mode bloom params so this mode doesn't inherit moonView's 1.2/0.85 tuning. All of this is
**Spike S1's** scope, including its acceptance test "terrain never blooms at any exposure"
(see §6 ordering trap).

**2.2 Activation vs loading.** `switchAppMode` raises the fade overlay and *awaits*
`activate()` behind a `modeSwitchInFlight` guard (`src/main.ts:789–795`) — awaiting a 45 MB
fetch there would trap the user behind a black overlay with Esc dead. So: `activate()`
resolves as soon as the **pre-flight board is interactive** (DESIGN §1.1 — the board *is* the
loading screen); `assets.ts` streams packs afterward with progress events; cancel/exit works
mid-download (one `AbortController` for the mode; BEGIN arms only when the checklist is green).

**2.3 UI.** The mode builds its DOM **programmatically** (the `MoonFlightMode.ts:249–283`
precedent), not as permanent `index.html` sections — keeps ROADMAP P1's "zero descent-mode
bytes until entry" honest. **Descent ships its own design system** (owner decision, DESIGN §5):
its stylesheet/tokens live in the mode's chunk, scoped under a single root class (e.g.
`.descent-root`), with **zero dependence on the app's existing CSS classes** — no inherited
look, no style bleed in either direction. Entry button beside `#btn-mode-planetarium`
(`index.html:1704`) is the one shell touchpoint; `?auto=descent` in `getAutoMode()`
(`src/main.ts:911`), plus `&site=&seat=&t=` deep links for QA.

**2.4 Disposal.** Dispose terrain geometries/textures, KTX2 transcoder workers
(`setWorkerLimit` honors the mobile budget), synth workers, audio context, DOM, in-flight
fetches — **and restore shared renderer state**: `toneMappingExposure` (set once at startup,
`src/main.ts:116`, and slewed by our exposure system), autoClear, shadow-map flags. Verified
by `renderer.info.memory` returning to baseline and a moonView visual check after an exit from
long-exposure mode.

**2.5 Lighting source:** `snapshotLighting(date)` (moonFlight pattern) freezes Sun/Earth at
entry — also what legalizes baked tile shadows (§4.3). **One frame contract, tested:** the
repo's astronomy is J2000-pinned while moonFlight's snapshot works in a Moon-centered ecliptic
frame — Descent defines a single selenographic seam (site → Earth/Sun az-el, star orientation,
globe texture orientation all through it) with a unit check against DESIGN App. A's anchors
(Earth at Tranquility = 66.5° el / az ≈ 268°) before P1 ships. Frame mismatches are the
classic silent-wrongness bug farm.

**2.6 Persistence:** small `descentStore` (localStorage, PlanetariumStore's defensive
style): stats/medals history, Heritage unlock, HD consent, last site/seat. Write-on-event.

### Module layout (one responsibility each)

```
src/descent/
  DescentMode.ts          thin controller: lifecycle, beat machine, wiring, render delegate
  assets.ts               pack manifest, streaming, progress, AbortController, base-URL const
  guidance/DescentGuidance.ts   phase profiles, envelope clamps, bias/nudge blending, windows
  guidance/FlightDynamics.ts    f64 point-mass + attitude, fixed 50 Hz, deterministic
  input/LandingInput.ts   keyboard/touch/gyro → intents (GyroSteering pattern)
  globe/MoonGlobe.ts      cube-sphere quadtree, lifecycle, frustum+horizon cull, prefetch
  globe/TileSource.ts     real-tile fetch/decode; apron assembly; synth handoff
  globe/synthWorker.ts    amplification + normals/AO + two-stage shadow bake (Worker)
  globe/collision.ts      heightfield sample under craft (finest resident tile)
  sky/SkyDome.ts          stars (reuse data/brightStars), Milky Way, Earth, Sun glare
  sky/exposure.ts         analytic exposure (sunlit + shadow fractions) + long-exposure
  hud/LandingHUD.ts       programmatic DOM/SVG; Glass/Heritage tokens; callout engine
  hud/instruments/*.ts    journeyTape, speedBlock, compass, tempPanel, attitude, reticle…
  thermal.ts              Diviner-fit model (DESIGN App. A)
  audio/LandingAudio.ts   rumble/RCS synth, radio + Quindar, ducking
  sites.ts                curated sites, IAU nomenclature for feature names
```

## 3. Coordinates, precision, depth

- **Meters, selenocentric, f64 on CPU; camera-relative on GPU.** Tile vertices are tile-local;
  per-frame `tileOrigin − cameraPos` computed in f64 → small float offsets (float32 absolute
  coords would quantize ~0.25 m at lunar radius — visible jitter). Planetarium's
  floating-origin idea (`PlanetariumMode.ts` ~654) one level down.
- **Two-pass sky/world split, not log depth** (`logarithmicDepthBuffer` is a renderer
  *constructor* flag on the shared renderer — not togglable per mode). Sky scene (stars/Milky
  Way/Earth/Sun at fixed distances) renders first, depth cleared; world scene uses dynamic
  near/far. World scene `background = null` (else it repaints over the sky pass — S1
  checklist).
- **Near/far honestly computed.** `near ≈ max(0.4 m, alt/3000)`. **Far must include relief,
  not just the smooth-sphere limb**: terrain of height H is visible to ≈ √(2R·h_eye) + √(2R·H)
  — at a 2 m eye, a 4.5 km massif is visible from ~125 km (Mons Hadley stands ~25 km from the
  Apollo 15 pad; DESIGN sells that view). So far = relief-inflated horizon + margin → ~150–200
  km at touchdown. Precision still fine on 24-bit depth: δz ≈ z²/(near·2²⁴) → ~1.5 mm at
  100 m, ~60 m at 20 km (a distant silhouette), ~6 km at 200 km (sky-adjacent). Worst ratio
  ~5×10⁵ near 2 km altitude — still comfortable. Craft furniture (leg silhouettes) closer than
  the near plane renders in the overlay/sky pass or as 2D HUD art.
- Curvature is free: tiles are true sphere patches; horizon/limb geometry falls out.

## 4. Terrain: quadtree cube-sphere with baked-light tiles

### 4.1 Structure & LOD

- 6 root faces → quadtree; **65×65 vertex** tiles, shared-edge + skirts (cracks), optional
  CDLOD morph in reserve.
- Split on screen-space error with **per-tile max height deviation** as the geometric error
  (known at bake time) — *not* vertex pitch, which over-splits flat maria. Threshold ~1.5 px
  with hysteresis; altitude-banded caps.
- Culling: frustum + horizon (cap test rejects ~90% of the sphere from 450 km).
- Level table (face edge ≈ 2,728 km; vertex pitch = edge/(64·2ⁿ)):

  | Level | Pitch | Height source | Color source |
  |---|---|---|---|
  | 0–5 | 42.7 km → 1.33 km | real, global, **in core pack** | global 8k KTX2 |
  | 6–9 | 667 → 83 m | real, **descent-corridor + site cones only** | corridor/site tiles |
  | 10–13 | 42 → 5.2 m | curated sites: NAC DTM patches · elsewhere procedural | procedural albedo modulated by parent |
  | 14–16 | 2.6 → 0.65 m | procedural + boulder instancing (≤ 20k, fade-in < 500 m AGL) | procedural |

  The guidance trajectory is known at commit — **the corridor is prefetchable** (§4.4). "Real
  data globally to L9" died in review: L9 height alone is ~13 GB (≈ SLDEM2015's own 8.5 GB
  global raster — §5 budgets versus that reality).
- Budgets: ≤ ~220 resident tiles (self-consistent with the SSE threshold at 1080p), LRU ~350,
  ≤ 4 builds in flight.

### 4.2 Procedural amplification (synth worker, deterministic)

Per tile, seeded by world position (face/level/x/y hash — same Moon every flight):
parent-height bicubic upsample → band-limited regolith fBm (roughness-classed: maria smooth,
highlands rough) → **crater stamping** by power-law SFD, stamps hashed on *world* coordinates
so neighbors regenerate identical overlapping craters (seam-free by construction) → boulders
near fresh stamps (deep levels only) → bake normals + AO + shadow (below) into one RGBA
texture + displaced mesh, transferables to main thread.

**Apron contract:** TileSource hands the worker the tile **plus an N-texel apron** (neighbor
data) — normals, AO, and near-field shadows computed without aprons seam at every tile border.
This is an explicit interface, not an optimization.

### 4.3 Shadows: two-stage bake under a frozen sun

The sun is snapshot-frozen (moves 0.008°/min — invisible in a 12-minute ride), so shadows bake
at tile-build time. **One stage is not enough**: at 5–14° sun, a 4 km peak shadows ~45 km of
ground — occluders live tens of kilometers outside any tile. So:

- **Far field:** ray-march against the always-resident coarse global heightfield (L0–L5 core
  pack — shipped to the worker once). Catches mountain/crater-wall shadows at terminator
  scale, identical across neighboring tiles by construction.
- **Near field:** march the tile + apron for local relief; **below ~L12, inherit the parent's
  shadow term** and add only the tile's own stamped-crater shadows (long shadows are
  low-frequency; they don't need re-marching per level).
- Penumbra: soften by miss distance (sun is 0.53° wide). Output packs into the tile RGBA.
- Real-time shadow map: **one** small cascade (≤ 2048², ≤ 2 km radius) below 5 km AGL, casters
  = **craft only** (terrain casting would re-draw ~220 tiles into the depth pass and
  double-darken against the bake); terrain receives.
- Date change in pre-flight ⇒ tiles rebuild behind the checklist (not a runtime path). The
  eclipse cameo invalidates the baked term — its real price (fade/rebake) is on DESIGN §7.

### 4.4 Streaming throughput (the mobile truth)

Demand: 30 km → 150 m crosses ~7–8 LOD levels in ~130 s ⇒ sustained **3–7 tile builds/s,
peaking 10–15/s** at pitch-over. Supply: a 256² bake dominated by the shadow march runs
~100–400 ms in a JS worker ⇒ 2 desktop workers ≈ 5–20/s (OK if tuned); one mobile worker is
**2–5× short**. Mechanisms, not hope: **corridor prefetch** (guidance knows the future camera
path — queue the cone at commit), **128² bakes** on mobile and for L≥14 (0.33 m shadow texels
at L14 is overkill anyway), **parent shadow inheritance** (kills the march where it's
costliest), and build prioritization by screen-space error. **Spike S3 benchmarks exactly
this** (one tile + apron, two-stage march, mid desktop + low-end Android; gates: ≤ ~100 ms /
≤ ~300 ms, seam-free pair render).

### 4.5 Collision

Bilinear heightfield sample under the craft (finest resident tile) for AGL; 4 pad points +
normal at touchdown → tilt/slope grading. `FlightDynamics` is a 50 Hz fixed-step point mass —
deterministic given seed + input script (replayable for QA goldens).

## 5. Data & asset pipeline

### 5.1 Sources (honest resolutions; licensing noted)

| Asset | Source | Native res | Note |
|---|---|---|---|
| Global color | **LROC WAC mosaic** (LROC/PDS) | ~100 m/px (109k×55k) | The CGI Moon Kit's 27,360×13,680 color is ~**399 m/px** — kit is a convenience derivative, not the data ceiling. PD |
| Global elevation | **SLDEM2015 / LOLA** (PDS) | 512 ppd ≈ **59 m/px** (60°S–60°N), LOLA poleward | Kit displacement (64 ppd ≈ 474 m/px) is *not* enough for L7+; source native. PD |
| Site patches ×5 | **LROC NAC DTM + ortho** (PDS) | 2–5 m/px DTM, 0.5–2 m/px ortho | PD. Shackleton coverage is sparse — pipeline risk R7 |
| Sky | NASA SVS **Deep Star Maps 2020** | 8k/16k equirect | PD |
| Bright stars / constellations | repo data (HYG v3.7 derived) | — | **CC BY-SA, not PD** — ship attribution in-app (credits panel) |
| Earth | existing `public/textures/earth-*.jpg` (2k) for the naked-eye view; **4k day+clouds in the `hd`/binocular path** | 2k → 4k | 2k is ample at Earth's true ~55 px; the hold-to-zoom binoculars (DESIGN §2.2) can push the disc to ~600 px, where 4k earns its bytes |
| Temperatures | analytic Diviner-fit in `thermal.ts` | — | no texture |

Offline preprocessing in `tools/descent/` (Node + GDAL, not shipped): cube-face
reprojection, pyramid build, KTX2 (UASTC→BC/ASTC) color, height packing, `manifest.json`.
**This pipeline is scheduled work (ROADMAP P0.5), not a footnote** — polar reprojection,
NAC-into-procedural blending at cone borders, and grazing-sun Shackleton bakes are where the
calendar lives.

### 5.2 Packs & budgets (corrected arithmetic)

Height tile = 65×65×2 B ≈ 8.5 KB raw. Cumulative global tile counts: L0–5 ≈ 8,190 tiles
(~70 MB raw, **~20–25 MB packed**); L0–6 ≈ 32,766 (~280 MB raw) — *that's why the global real
floor is L5–6, not L7–9 (L9 alone ≈ 13 GB)*. Corridor/site cones are thousands of tiles, not
millions.

| Pack | Contents | Wire target | When |
|---|---|---|---|
| `core` | mode chunk (~150 KB) · global color 8k×4k KTX2 (~22 MB) · global height **L0–L5** (~20 MB) · 4k Milky Way KTX2 (~11 MB) · audio (≤ 2 MB) | **≤ 55 MB** | on entry, behind the board (orbit view needs only L0–L4 — first frame fast) |
| `site-<name>` ×5 | height+color **corridor cone L6–L9** + pad cone **L10–L13** (NAC where curated) | ≤ 15 MB each | on site select, parallel with choosing |
| `hd` (optional, desktop opt-in) | 16k global color, 8k sky | ≤ 60 MB | toggle |

- **Pack files, not tile files:** per-level/per-cone binary packs fetched with **HTTP Range**
  requests (Pages serves `Accept-Ranges`) + a small JSON index. 10⁵ loose files would bloat
  git and slow the Pages artifact tar (`.github/workflows/deploy.yml`); ranges also make the
  manifest format stable from day one.
- **Height encoding:** Mapbox-style **terrain-RGB in ordinary 8-bit PNG** (height split across
  R/G/B), decoded via `createImageBitmap` with `colorSpaceConversion:'none'`,
  `premultiplyAlpha:'none'` — a naive 16-bit-PNG-through-canvas path silently clamps to 8 bits
  = **78 m terraces** across ±10 km of lunar relief. (Fallback: worker-side PNG parse with
  `DecompressionStream` — zero-dep.)
- Mobile caps: 4k color, 4k sky, no `hd`, halved tile cache.
- Totals: core + 5 sites ≈ **130 MB** of `public/`. **Hosting decided (owner): in-repo on
  GitHub Pages** — zero ops/cost/CORS, assets version atomically with the code (manifest can
  never skew from the deployed app), well inside Pages limits with pack splitting (< 100 MB/
  file). Every fetch goes through one base-URL constant in `assets.ts`, so promotion to
  Cloudflare R2 (or similar) is a one-line change plus an upload script. **Promotion triggers,
  any of:** total assets > ~200 MB (HD pack + growth) · Pages bandwidth pressure · frequent
  tile regeneration bloating git history (the strongest one — packs are write-once today).
  (CLAUDE.md caveat stands: `BASE_URL` paths are invisible to tsc/Vite — verify in the running
  app.)
- **Experiment E1 (probe before P2):** NASA Trek WMTS streaming for deep-zoom tiles —
  CORS/latency/availability unproven; if it lands, site packs shrink to NAC pads only.

## 6. Lighting, exposure, sky

- **Sun:** one DirectionalLight from the snapshot; disc = glare sprite + corona via bloom when
  `canGPUDoBloom` (float-FBO probe, `src/app/gpuCapability.ts`), glow-shell fallback otherwise.
- **Earthshine:** second faint DirectionalLight from the Earth direction, blue-gray, ∝ Earth
  phase × ~3 boost (declared). Ambient: none.
- **Regolith BRDF (shader-architecture note, learned in review):** the baked **sun-shadow term
  gates the sun light only** — inside the lighting loop via a custom direct-light chunk
  (`onBeforeCompile`), keyed to the sun's light index. Multiplying the whole lighting sum
  would re-blacken the shadows earthshine exists to lift. AO multiplies both lights.
  Opposition surge: a dot-product/smoothstep boost peaking within ~2° of anti-sun.
- **Exposure:** analytic, no readback — scene key from (a) sunlit-terrain frame fraction
  (closed form from pitch/altitude/terminator geometry), (b) **mean baked-shadow factor of
  resident tiles** (free: each bake emits its mean — a terminator frame is mostly shadow and
  must expose *up*), (c) Sun/Earth-in-frustum flags. Slewed ~1.5 s. **Ordering trap:** in this
  composer chain, tone mapping (and `toneMappingExposure`) applies in OutputPass *after*
  bloom — driving the renderer exposure can never pull terrain below the bloom threshold. So
  exposure is applied **pre-bloom** (material/uniform scale), bloom threshold per-mode, and S1
  carries the AC "terrain never blooms". Star/Milky-Way opacity keys off the same exposure
  value (honest star policy, DESIGN §2.2). Long-exposure mode: +6 EV target, grain, MW out.
- **Sky pass:** stars as one Points buffer from `brightStars` (mag → size/intensity, B−V →
  color), MW pano sphere, Earth as small textured sphere (existing textures) with phase
  shader, fixed comfortable distances (§3 split).

## 7. Guidance & beats

State machine in the controller sequences DESIGN §1.2; `DescentGuidance` precomputes per-phase
altitude→velocity profiles at commit for the chosen bias and clamps:

- **One engine model, every seat (P2 architecture rule — game-design review):** guidance never
  commands acceleration directly. It outputs **throttle + attitude commands into the single
  engine model** in `FlightDynamics` (mass-flow so thrust/weight rises as fuel burns, ~200 ms
  throttle lag, rate-limited attitude), and the seats differ only in *who closes the loop*.
  This makes engine audio pitch, plume/dust intensity, the g-meter, and the fuel ledger all
  read from one truth source — and means Left Seat (P5) is a controller swap, not a parallel
  flight model retrofit.
- Window/Right Seat: guidance closes the loop (PD toward profile through the engine model) +
  bounded player nudge; authority ramps back as input decays (soft hand-back). V-SPD hard caps
  per phase. **Zero-input baseline is specced and tested**: hands-off lands FIRM inside the
  ellipse with seeded dispersion (DESIGN §1.3) — a P2 acceptance criterion. **Commit windows**
  are first-class: timing from site geometry; ~90 s grace via ΔV reserve, drained visibly off
  window-center (feeds the fuel stat); miss → next-window state, skippable by the declared
  jump-cut. Bias feedback: touching W/S re-runs the profile generator and re-animates the burn
  forecast + footprint ellipse (margin ↔ reach).
- Left Seat: the player closes the loop (throttle/attitude with SAS rate damping); guidance
  annunciates only; fuel = the same ΔV bookkeeping.
- Redesignation: terrain raycast → reachability vs remaining ΔV → new profile target.
- Beat boundaries emit events (HUD, audio, **callout engine** — a priority/dedup queue against
  one display slot, DESIGN §6). Deterministic: fixed-step sim + seeded synth ⇒ replayable
  goldens.

## 8. HUD implementation

Programmatic DOM/SVG (per §2.3), `setText` from `src/shared/dom`, numbers at 10–20 Hz, smooth
elements (journey tape, attitude, sparkline) as small inline `<svg>` transforms per frame.
Glass/Heritage = CSS custom-property token sets *plus* the two named Heritage extras (FDAI
instrument, CRT overlay) costed in P4. World-anchored elements (reticle, chevron, compass
markers with edge-pinning) use `projectToScreen` (`src/shared/three/projectToScreen.ts`,
zero-alloc `out` form).

## 9. Performance budgets

| Budget | Desktop (mid GPU) | Mobile (recent) |
|---|---|---|
| Frame | 16.6 ms: terrain ≤ 4, sky ≤ 1, fx ≤ 1.5, sim+JS ≤ 2 | 33 ms equivalents |
| Draw calls | ≤ 300 (terrain ≤ 220 + sky + fx + craft) | ≤ 180 |
| **Pixel ratio policy** | **≤ 1.5 for this mode** (needs its own branch in `getTargetPixelRatio`, `src/main.ts:186`) | 1.0–1.25 |
| VRAM — content | ~165 MB (8k color KTX2 43 · tile RGBA cache 350×256² ≈ 92 (+⅓ if mipped — decide at S3) · meshes ~30 (per-tile position buffers) · sky 11) | ~80 MB (4k + 128² halves) |
| VRAM — **composer** (forgotten in v1 of this doc) | 2× RGBA16F + depth + bloom chain ≈ **130 MB at 1080p×1.5** (was ~227 MB at dpr 2 — hence the PR policy) | ~60 MB |
| Headroom check | ~295 MB ≤ 350 budget ✓ | ~140 ≤ 160 ✓ |
| AA | composer bypasses canvas MSAA — either `target.samples = 4` (+VRAM) or FXAA pass; decide in S1 (1.5 px SSE terrain will crawl unaided) | FXAA |
| Workers | 2 synth + KTX2 pool (`setWorkerLimit`) | 1 + 1 |
| Tile builds | §4.4 mechanisms; ≤ 4 in flight | 128² bakes, corridor prefetch mandatory |
| Entry → first orbital frame | ≤ 8 s @ 50 Mbps (orbit needs L0–L4 + color) | ditto |

Dust: ≤ 4k instanced quads, ballistic motion in the vertex shader, + screen veil. Bloom only
when `canGPUDoBloom`.

## 10. QA & debug

`?auto=descent&site=tycho&seat=left&t=lowGate` deep links; `?debug=1` adds frame ms,
resident tiles/VRAM estimate, LOD histogram, guidance phase, exposure value. Determinism
harness: record seed + input script → replay → screenshot at each beat (procedure lands as
`QA.md` in P2). The 50 Hz sim runs **headless** (no renderer import), enabling the **flight
oracle**: a script sweeps ~1,000 seeded runs across bias/seats and asserts the invariants —
always lands; zero-input baseline = FIRM-in-ellipse; commit→contact inside the envelope; fuel
ledger non-negative (ROADMAP P2 AC). The same harness hosts astronomy checks (site Sun/Earth
az-el, phase complement, lunar-night detection, next-good-light) and a beat-state test that
live controls / HUD set / audio eligibility match DESIGN §3's matrix. `npm run build` (tsc strict) locally before every push — CI runs vite only
(CLAUDE.md), and `noUnusedLocals` is the refactor-leftover net.

## 11. Risks & spikes

| # | Risk | Mitigation |
|---|---|---|
| R1 | Two-scene split vs shared composer (render order, bloom placement, fallback path, exposure ordering) | **Spike S1**: gray sphere at real scale through the *refactored* composer & no-bloom path, 450 km→2 m; ACs: no z-art, terrain never blooms, sky pass correct in both paths, exposure restored on exit |
| R2 | KTX2 transcoder (wasm) on GitHub Pages; three `^0.183` KTX2Loader | **Spike S2** on a Pages deploy; fallback WebP + runtime mips (costs VRAM headroom only) |
| R3 | Tile-build throughput vs descent (esp. mobile) | **Spike S3**: bake benchmark + seam-pair proof + apron contract validation; corridor prefetch design |
| R4 | Asset pipeline is the schedule (polar reprojection, NAC blending, Shackleton grazing-sun bakes, pack format) | **P0.5 phase** with a one-face dry run measuring real bytes before P1 locks the manifest |
| R5 | Repo growth (~130 MB packs) | pack-file + Range design; one base-URL constant → CDN move is one line; E1 Trek probe |
| R6 | Mobile OOM / throttling | PR policy, 128² bakes, halved caches, no `hd`, iOS decode spikes watched in P1 |
| R7 | Procedural seams/pops | world-hashed stamps, apron contract, skirts, hysteresis; CDLOD in reserve |
| R8 | Scope creep in guidance & radio | DESIGN §9 descope is contractual; callout engine budgeted (P4); Left Seat last (P5) |
| ~~Q1~~ | Glass default vs Heritage | **Decided: Glass**, and Descent owns its design language (DESIGN §5, README D10) |
| ~~Q2~~ | Packs in-repo vs CDN day one | **Decided: in-repo on Pages**, R2 promotion pre-wired with triggers (§5.2, README D11) |

## Appendix — derivations

- f(h) = h/2(R+h) → 10.29% @ 450 km. Horizon √(h(2R+h)) → 1,329 km; relief-visible distance
  adds √(2R·H) → a 4.5 km peak shows from ~125 km at ground level (drives the far plane, §3).
- v_circ(450) = 1.497 km/s; T = 153 min; ground speed 1.19 km/s.
- Radial-Kepler free fall 450 km → surface: t = √(r₀³/2μ)·(arccos√(R/r₀) + √(R/r₀·(1−R/r₀)))
  = **904 s**; impact √(2μ(1/R−1/r₀)) = 1.077 km/s. Powered-profile family and the 3.3–5.0
  km/s bias envelope: DESIGN App. A (numbers shared).
- Tile arithmetic: counts 6·(4^(n+1)−1)/3 → L0–5 = 8,190; L0–6 = 32,766; L9 global ≈ 1.57 M
  tiles ≈ 13 GB raw — the §5.2 scope line. Height tile 8.5 KB raw; 65² mesh ≈ 50 KB; 256² RGBA
  ≈ 262 KB.
- VRAM: 8k×4k KTX2(BC7) ≈ 32 MB + mips ≈ 43; composer at 2880×1620: 2×RGBA16F (75) + depth
  (19) + bloom chain (~37) ≈ 130 MB.
- Depth: δz(z) ≈ z²/(near·2²⁴); near 0.4 / far 200 km → 1.5 mm @ 100 m, 60 m @ 20 km.
