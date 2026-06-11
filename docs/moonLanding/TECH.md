# Moon Landing Mode — Technical Plan

> Companion to [DESIGN.md](DESIGN.md) (the experience this must serve) and [ROADMAP.md](ROADMAP.md)
> (delivery order). File/line references are to the repo at the time of writing.

## 1. Hard requirements (from the brief + design)

1. **Zero impact on the rest of the app.** No code in the initial bundle beyond a ~1 KB entry
   stub; no assets fetched until the mode is entered; full disposal on exit (GPU memory, DOM,
   listeners, workers).
2. **Real-scale Moon** (R = 1,737.4 km) viewable from 450 km down to a 2 m eye height, 60 fps on
   a mid-tier desktop GPU, 30 fps on a recent phone.
3. **Accurate lighting**: Sun/Earth directions from the app's own ephemeris; Earth phase correct;
   earthshine; black-sky exposure behavior.
4. **New, HD asset set** for this mode (existing `public/textures/moon.jpg` is 448 KB — nowhere
   near enough), streamed on entry with progress UI.

## 2. Integration with the app shell

The mode follows the established contract exactly (`activate(date, onProgress)/deactivate()/
update(dt)`), patterned on `MoonFlightMode` (`src/moonFlight/MoonFlightMode.ts:86,156,191`) —
CLAUDE.md already names it the decomposition to emulate.

- **Mode registration:** extend `type AppMode` (`src/main.ts:48`) with `'moonLanding'`; add a
  branch in `switchAppMode` (`src/main.ts:775`) using the **existing dynamic-import precedent**
  (`src/main.ts:845` does `await import('./moonFlight/MoonFlightMode')`):

  ```ts
  const mod = await import('./moonLanding/MoonLandingMode');   // separate Vite chunk
  moonLandingMode = new mod.MoonLandingMode(renderer);
  ```

  Vite code-splits on dynamic import automatically — no config needed. Everything under
  `src/moonLanding/` plus its three/addons imports (KTX2Loader etc.) lands in that chunk.
- **Own scene + own camera.** Unlike moonFlight (which borrows the shared scene), this mode owns
  a private `THREE.Scene` and `PerspectiveCamera` — cleanest disposal story and no cross-mode
  state bleed. `buildComposer(cam)` (`src/main.ts:199–228`) is already rebuilt per mode switch;
  we pass our camera the same way. Bloom availability comes from `canGPUDoBloom(renderer)`
  (`src/app/gpuCapability.ts`) exactly like the other modes.
- **Lighting source:** reuse `snapshotLighting(date)` (moonFlight's pattern): freeze Sun/Earth
  direction vectors + distances + Earth phase at entry. Frozen sun is also what makes per-tile
  shadow baking legal (§6).
- **UI:** new `#moon-landing-ui` section in `index.html`, toggled via `display` like
  `#planetarium-ui` (`src/main.ts:756–781`); entry button next to `#btn-mode-planetarium`
  (`index.html:1704`); `?auto=moonLanding` added to `getAutoMode()` (`src/main.ts:911–915`),
  plus dev params `&site=&seat=&t=` for deep-linking any beat in QA.
- **Disposal:** `deactivate()` must dispose terrain tile geometries/textures, the KTX2 loader's
  transcoder workers, the synth Web Workers, audio context, DOM panel, and abort in-flight
  fetches (single `AbortController` for the whole mode). Verified by a debug counter of
  `renderer.info.memory` before/after (target: returns to pre-entry values ±0).
- **Persistence:** a small `moonLandingStore` (localStorage, same defensive style as
  `PlanetariumStore`) for: stats history, unlocked Heritage skin, HD-pack consent, last
  site/seat. No 30 s auto-save loop needed — write on event.

### Module layout (mirrors moonFlight's decomposition, one responsibility each)

```
src/moonLanding/
  MoonLandingMode.ts      thin controller: lifecycle, beat state machine, wiring
  assets.ts               manifest, pack fetching, progress events, AbortController
  guidance/DescentGuidance.ts   phase targets, envelope clamps, player-bias blending
  guidance/FlightDynamics.ts    f64 state integration (semi-implicit Euler, fixed 50 Hz)
  input/LandingInput.ts   keyboard/touch/gyro → intent struct (reuse GyroSteering pattern)
  globe/MoonGlobe.ts      cube-sphere quadtree, tile lifecycle, frustum+horizon culling
  globe/TileSource.ts     fetch/decode real tiles; hand off to synth worker below data res
  globe/synthWorker.ts    procedural amplification + normal/AO/shadow bake (Web Worker)
  globe/collision.ts      heightfield sampling under the craft (CPU, finest resident tile)
  sky/SkyDome.ts          stars (reuse data/brightStars), Milky Way pano, Earth, Sun glare
  sky/exposure.ts         analytic auto-exposure (§6) + long-exposure mode
  hud/LandingHUD.ts       DOM/SVG panels; theme tokens (Glass/Heritage); callout queue
  hud/instruments/*.ts    tape, ribbon, compass, tempPanel, attitude, reticle (one file each)
  thermal.ts              Diviner-fit surface temperature model (DESIGN App. A)
  audio/LandingAudio.ts   WebAudio: rumble synth, RCS, radio/Quindar, music ducking
  sites.ts                curated sites, nomenclature list for feature names
```

`brightStars`/`constellations` (`src/planetarium/data/`) are plain RA/Dec data — imported
directly into this mode's chunk; promote to `src/shared/data/` only if a tidiness pass wants it.

## 3. Coordinates, precision, depth — the three classic traps

- **Units: meters, selenocentric, f64 on CPU.** All sim state (craft position, tile origins) in
  JS numbers (f64 — exact enough at 2×10⁶ m scale). The GPU never sees absolute coordinates:
  **camera-relative rendering** — each frame, every visible tile gets
  `tileOriginRelCamera = tileOrigin − cameraPos` computed in f64 and written to its transform;
  vertex positions inside a tile are tile-local (small floats). This is the planetarium's
  floating-origin idea (`PlanetariumMode.applyFloatingOrigin`, line ~670) pushed down one level.
  Float32 absolute coords would quantize at ~0.25 m at lunar-radius magnitudes — visible jitter;
  camera-relative kills it.
- **Depth: two-pass sky/world split, NOT logarithmic depth.** `logarithmicDepthBuffer` is a
  `WebGLRenderer` **constructor** flag and the renderer is shared app-wide (`src/main.ts`) — we
  will not flip a global flag for one mode. Instead: render the sky scene first (stars/Milky
  Way/Earth/Sun at fixed modest distances, depth cleared after), then the world scene with a
  **dynamic near/far** fitted to content: `near ≈ max(0.4 m, alt/3000)`, `far ≈ slant distance
  to limb + margin`. Worst case (touchdown: near 0.4 m, far ~12 km) is a 3×10⁴ ratio — fine for
  a 24-bit depth buffer. The composer gets one extra RenderPass (`clearDepth`), same pattern as
  any two-scene three.js setup. **Spike S1 (ROADMAP) proves this against the existing composer
  before anything else is built.**
- **Curvature is free:** tiles are true cube-sphere patches (vertices on the sphere), so the
  horizon, limb and "10% of the Moon beneath you" come out of the geometry; no faking.

## 4. Terrain: quadtree cube-sphere with baked-light tiles

### 4.1 Structure & LOD

- 6 root faces → quadtree; tile = **65×65 vertex grid** (electron-microscope standard: shared
  edge vertices, skirts hide T-junction cracks; optional CDLOD geomorph later if pops annoy).
- Split metric: screen-space error `ρ = (tileGeometricError / distance) · (screenH / (2·tan(fov/2)))`,
  split while `ρ > 1.5 px`, with hysteresis band to stop flicker; hard cap by altitude band.
- Culling: frustum + **horizon cull** (tile's bounding sphere vs. cap visible from camera
  height — from 450 km that rejects ~90% of the sphere immediately).
- Level table (face edge ≈ 2,730 km): edge/level ≈ 2730/2ⁿ km; **vertex pitch ≈ edge/64**:

  | Level | Vertex pitch | Source |
  |---|---|---|
  | 0–6 | 42.7 km → 667 m | real data (downsampled LOLA/SLDEM + WAC color) |
  | 7–9 | 333 → 83 m | real data (SLDEM2015 ~59–118 m/px) — global floor |
  | 10–13 | 42 → 5.2 m | **curated sites:** LROC NAC DTM patches (2–5 m/px) · elsewhere: procedural |
  | 14–16 | 2.6 → 0.65 m | procedural everywhere (+ boulder instancing) |

- Budgets: ≤ ~220 resident tiles, LRU cache ~350; split/merge ≤ 4 tile builds in flight.

### 4.2 Procedural amplification (below data resolution)

In the synth worker, per tile, **deterministic** (seed = hash of face/level/x/y — every flight
sees the same Moon):

1. Upsample parent heightfield (bicubic).
2. Add band-limited regolith fBm (2–3 octaves, amplitude tied to local roughness class:
   maria smooth, highlands rough).
3. **Crater stamping** by Neukum-style power-law SFD (N ∝ D⁻²·⁸ per km²/Myr-equivalent, tuned
   per region class), stamp = parametric bowl+rim+ejecta falloff; depth/diameter ≈ 0.2 fresh →
   0.05 degraded; degradation randomized. Stamps respect tile borders by hashing on **world**
   position (neighbor tiles regenerate identical overlapping craters — seam-free by construction).
4. Boulder pass (final levels only): instanced rock meshes clustered around the freshest stamped
   craters; ≤ 20k instances resident, fade-in below 500 m AGL.
5. Bake per-texel **normals**, **AO**, and §6's **sun-shadow term**; emit one RGBA texture
   (normal.xy, AO, shadow) + height mesh displacement → transferable buffers to main thread.

### 4.3 Why baking works: the sun is frozen

`snapshotLighting` freezes the sun for the session (it moves 0.008°/min — invisible during a
10-minute descent, already the moonFlight precedent). So each tile can **ray-march its own
heightfield toward the sun once at build time** and store a soft shadow/penumbra factor per
texel. Result: terminator-grade long shadows at *every* LOD with zero per-frame cost, no
shadow-map swimming, no cascade tuning for terrain. Real-time shadow maps are reserved for one
small cascade (~2048², ≤ 2 km radius) below 5 km AGL — for the craft's own shadow and dust
light occlusion. (If the player changes the date in pre-flight, tiles rebuild; that's the
loading checklist again, not a runtime path.)

### 4.4 Collision

`collision.ts` samples the finest resident heightfield under the craft (bilinear) for AGL,
plus 4 pad points + local normal at touchdown for tilt/slope grading. No physics engine —
`FlightDynamics` is a point mass + attitude state with guidance-shaped accelerations (50 Hz
fixed-step, deterministic given seed+inputs; replayable for QA goldens).

## 5. Data & asset pipeline

### 5.1 Sources (all public domain / NASA)

| Asset | Source | Native res |
|---|---|---|
| Global color | LROC WAC mosaic via NASA SVS **CGI Moon Kit** | up to 27,360×13,680 (~100 m/px) |
| Global elevation | LOLA / **SLDEM2015** (CGI Moon Kit displacement) | 59–118 m/px |
| Site patches (5) | LROC **NAC DTM + orthophoto** (PDS) | 2–5 m/px DTM, 0.5–2 m/px ortho |
| Sky | NASA SVS **Deep Star Maps 2020** Milky Way pano | 8k/16k equirect |
| Bright stars/constellations | already in repo (HYG-derived TS data) | — |
| Earth (1.9° disc) | reuse existing `public/textures/earth-*.jpg` | 2k — ample at ~60 px |
| Temperatures | analytic Diviner-fit model in `thermal.ts` (no texture needed) | — |

Offline preprocessing in `tools/moonLanding/` (Node + GDAL, **not shipped**): reproject to cube
faces, build tile pyramids, encode **KTX2/Basis-UASTC→BC/ASTC** color + 16-bit PNG heights,
emit `manifest.json` (tile index, byte sizes, sha) consumed by `assets.ts`.

### 5.2 Packs & budgets (gzip'd over-the-wire targets)

| Pack | Contents | Size target | When |
|---|---|---|---|
| `core` | mode chunk (~150 KB), 8k×4k global color KTX2, global height L0–L7, 4k Milky Way KTX2, audio (≤ 2 MB) | **≤ 45 MB** | on entry, behind pre-flight checklist |
| `site-<name>` ×5 | color+height L8–L13 cone around pad | ≤ 15 MB each | when site selected (parallel with choosing) |
| `hd` (optional) | 16k global color, 8k sky | ≤ 60 MB | desktop + opt-in toggle only |

Mobile caps: 4k global color, 4k sky, no `hd`, tile cache halved (§9). All fetches go through
`assets.ts` with progress → checklist lines, `AbortController` on exit, and standard HTTP
caching (GitHub Pages serves long-lived `ETag`s; an explicit Cache API layer is a later nicety).

**Hosting reality check (GitHub Pages):** individual files must stay < 100 MB (hard git limit;
Pages doesn't serve LFS) and the whole site reasonably ≤ ~1 GB. core + 5 sites + hd ≈ **180 MB**
of `public/` — acceptable, but tiles are committed as many small files (they're a pyramid
anyway). If asset growth ever threatens the repo, the documented fallback is moving packs to a
release-asset/CDN URL — `assets.ts` already routes every fetch through one base-URL constant
(and note the CLAUDE.md caveat: `BASE_URL`-built paths are invisible to tsc/Vite — verify in
the running app). **Experiment E1 (non-blocking):** stream deep-zoom tiles at runtime from NASA
Trek's public WMTS endpoints instead of shipping site packs; needs a CORS/availability/latency
probe before we trust it for anything.

## 6. Lighting, exposure, sky

- **Sun:** one `DirectionalLight` (direction from snapshot), intensity normalized so sunlit
  albedo-0.12 regolith hits the tone-curve's key. Disc itself is glare: bloom-driven sprite +
  corona when `canGPUDoBloom`, the moonView fallback trick (extra glow shells) otherwise.
- **Earthshine:** second faint `DirectionalLight` from the Earth direction, blue-gray, intensity
  ∝ Earth phase illumination × ~3 artistic boost (DESIGN §8). Lights the night side and softens
  black shadows. **Ambient: none.**
- **Regolith BRDF:** custom `onBeforeCompile` chunk on the terrain material: Lambert ×
  (1 + opposition surge term peaking within ~2° of anti-sun direction — the retro-reflectance
  halo) × baked AO × baked sun-shadow. Cheap (a dot product and a smoothstep), unmistakably lunar.
- **Exposure:** analytic — no GPU luminance readback. Estimate scene key from (a) fraction of
  frame subtended by sunlit terrain (camera pitch + altitude + terminator geometry, closed
  form), (b) Earth/Sun in frustum flags. Drive `renderer.toneMappingExposure` through a slewed
  (~1.5 s time-constant, like an iris) curve; star/Milky-Way material opacity keys off the same
  value so stars fade *physically* rather than by script. **Long-exposure mode** (post-landing,
  hold key): +6 EV target, grain shader, Milky Way fully out.
- **Sky pass:** stars as one `Points` buffer from `brightStars` (magnitude → size/intensity,
  B-V → color), Milky Way pano on an inside-out sphere, Earth as a small textured sphere with
  day/night/cloud shader reusing existing earth textures, all at fixed comfortable distances in
  the sky scene (depth-independent, §3).

## 7. Guidance & beats (the "ride" machinery)

A small state machine in `MoonLandingMode` sequences DESIGN §1.2's beats; `DescentGuidance`
holds per-phase **target profiles** (altitude→velocity curves precomputed at activation for the
chosen descent-rate bias) and clamps:

- Window/Right Seat: craft acceleration = guidance PD toward profile + player nudge vector
  (bounded); guidance authority ramps up as the player's input decays (soft hand-back, DESIGN
  §3.4). Vertical speed hard-capped per phase (e.g. −30 m/s below low gate).
- Left Seat: player throttle/attitude integrate directly; guidance only annunciates (and SAS
  damps rates). Fuel = ΔV budget bookkeeping.
- Redesignation: clicked terrain point ray-cast → reachability check against remaining
  ΔV envelope → new target for the profile generator.
- All beat boundaries (`highGate`, `lowGate`, dust threshold, contact) emit events the HUD,
  audio, and callout queue subscribe to. Deterministic: fixed-step sim + seeded synth ⇒ a
  recorded input script replays identically (QA goldens, §10).

## 8. HUD implementation

Vanilla DOM/SVG inside `#moon-landing-ui` (repo convention — no framework, ids in `index.html`,
`setText` from `src/shared/dom`): panels are absolutely-positioned elements updated at 10–20 Hz
(numbers) while smooth elements (tapes, attitude ring, sparkline) are tiny inline `<svg>`s
updated per-frame via transform — cheap, crisp at any DPI, and the Glass/Heritage **skins are
CSS custom-property token sets** (`--hud-ink`, `--hud-accent`, fonts, scanline overlay class)
exactly as the mockup generator models them. World-anchored elements (site chevron, reticle,
Earth/Sun compass markers) use `projectToScreen` (`src/shared/three/projectToScreen.ts`) with
its zero-alloc `out` form. Callout/caption queue is one element with CSS transitions.

## 9. Performance budgets (acceptance numbers for ROADMAP)

| Budget | Desktop (mid GPU) | Mobile (recent) |
|---|---|---|
| Frame | 16.6 ms: terrain ≤ 4, sky ≤ 1, fx ≤ 1.5, sim+JS ≤ 2, headroom rest | 33 ms equivalents |
| Draw calls | ≤ 300 | ≤ 180 |
| Resident VRAM | ≤ 350 MB | ≤ 160 MB |
| Tile builds | ≤ 4 in flight, ≤ 3 ms/frame main-thread upload (sliced texSubImage) | ≤ 2 / ≤ 3 ms |
| Workers | 2 synth + KTX2 transcoder pool | 1 + 1 |
| Entry → first orbital frame | ≤ 8 s on 50 Mbps (core pack streams progressively; orbit needs only L0–L4) | ditto, smaller pack |

Bloom only when `canGPUDoBloom` (existing gate). Dust: GPU-instanced quads (≤ 4k particles,
ballistic analytic motion in the vertex shader — no per-particle CPU) + the screen-space veil.

## 10. QA & debug (no test framework exists — make verification cheap)

- `?auto=moonLanding&site=tycho&seat=left&t=lowGate` deep links; `?debug=1` reuses the existing
  debug overlay and adds: frame ms, resident tiles/VRAM estimate, current LOD histogram,
  guidance phase/targets, exposure value.
- Determinism harness: record input script + seed → replay → screenshot at each beat; goldens
  checked by eye (documented procedure in `docs/moonLanding/QA.md` when P2 lands).
- `npm run build` (tsc strict + vite) stays the gate — remember CI does **not** run tsc
  (CLAUDE.md), so local builds before push are mandatory, and `noUnusedLocals` will catch
  refactor leftovers.

## 11. Risks & open questions

| # | Risk | Mitigation |
|---|---|---|
| R1 | Two-scene depth split fights the shared composer (render order, bloom pass placement) | **Spike S1 first** — a gray-sphere prototype proving composer + sky/world split + camera-relative transforms at 450 km→2 m |
| R2 | KTX2 transcoder (wasm) hosting/MIME on GitHub Pages; three `^0.183` KTX2Loader API | **Spike S2**: load one KTX2 in a Pages-deployed branch; fallback = WebP/JPEG + runtime-generated mips (costs VRAM headroom, not correctness) |
| R3 | Repo bloat from tile packs (~180 MB) | Pack sizes enforced by the build script; CDN/release-asset fallback wired from day one (one base-URL constant); E1 Trek streaming probe |
| R4 | Mobile OOM (4k caps may still be tight with composer + tiles) | Mobile budget table is acceptance criteria in every phase; tile cache halves; `hd` never offered |
| R5 | Procedural terrain seams/pops at LOD boundaries | World-position-hashed stamps (seam-free by construction), skirts, hysteresis; CDLOD morph held in reserve |
| R6 | Scope creep in guidance (it's a ride, not KSP) | DESIGN §9 descope list is contractual; Left Seat ships *after* the ride feels right (ROADMAP) |
| Q1 | Art direction default | DESIGN recommends Glass; Heritage as unlock — **owner sign-off wanted** |
| Q2 | Site packs in-repo vs CDN from day one | Start in-repo (≤ 180 MB), revisit at P5 if the repo groans |

## Appendix — derivations behind the budget numbers

- Visible fraction f(h) = h / (2(R+h)) → 450 km ⇒ 10.3%. Horizon d = √(h(2R+h)) ⇒ 1,329 km.
- v_circ(450 km) = √(μ/r) = √(4902.8/2187.4) ≈ 1.497 km/s; T = 2π√(r³/μ) ≈ 153 min.
- Free-fall from rest at 450 km: v_impact = √(2μ(1/R − 1/r)) ≈ 1.077 km/s; t ≈ 13.9 min — the
  basis of the 5–10 min powered envelope and the ~3.0 km/s ΔV claim (1.497 kill + ~1.1 brake + margin).
- Tile level pitch: cube face edge ≈ (π/2)·R ≈ 2,728 km; pitch(n) = edge/(64·2ⁿ) → n=16 ⇒ 0.65 m.
- VRAM: 8k×4k color KTX2 (BC7, 1 B/px) ≈ 32 MB + mips ≈ 43 MB; per-tile 256² normal/AO/shadow
  RGBA ≈ 256 KB × 350 cached ≈ 90 MB; height meshes 65² × f32 ≈ 50 KB × 350 ≈ 18 MB; sky 4k
  KTX2 ≈ 11 MB; comfortably inside the 350 MB desktop budget with composer targets.
