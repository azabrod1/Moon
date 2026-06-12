# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Build & Development

```bash
npm run dev        # Start Vite dev server (hot reload)
npm run build      # TypeScript check + Vite production build (output: dist/)
npm run preview    # Serve production build locally
npm run gen:stars  # Regenerate the bright-star catalog (gen-stars.mjs)
npm run gen:moons  # Regenerate satellite elements + goldens from JPL (gen-moons.mjs; --offline uses .moon-data-cache/)
```

No linter is configured. **Run `npm run build` and `npm test` locally after every change.** Tests are vitest, colocated as `src/astronomy/*.test.ts` (Meeus worked examples, event catalogs, JPL Horizons vector goldens — update fixtures deliberately, never by copying new output). CI (`.github/workflows/deploy.yml`) runs `tsc`, the tests, then the Pages build. `tsconfig` is `strict` and sets `noUnusedLocals`/`noUnusedParameters`, so unused imports, locals, and parameters fail the build (this is what catches refactor leftovers).

## Architecture

A **Three.js** WebGL app: the **Planetarium** is the app, plus a dormant **Moon Flight** mini-game sharing the scene, renderer, and animation loop. `src/main.ts` is a thin entry point: it owns the renderer, the post-processing composer, the two cameras, mode switching/transitions, and the animation loop. Each mode is a self-contained controller that exposes `activate()/deactivate()/update(dt)`. (The legacy "Moon view" mode retired in favor of the Observatory — recoverable from git history; its orbit-details overlay was ported first.)

### Planetarium — `src/planetarium/`
A fly-through of the full solar system (Mercury–Pluto) in **AU**. Uses a **floating-origin** pattern: the player stays at scene origin and all bodies are offset by the player's position, avoiding float precision loss at large distances.
- **`PlanetariumMode.ts`** — the mode controller. Self-contained pieces are extracted to siblings (`world/starfield`, `input/GyroSteering`, `ui/*` panels, labels); the tightly-coupled per-frame core (update pipeline, navigation, landing, missions, camera) deliberately stays in the controller.
- **`SolarSystem.ts`**, **`PlanetFactory.ts`** — build planets, orbit lines, asteroid belt, rings; async texture loading with procedural canvas fallback.
- **`PlayerShip.ts`** — player state + kinematics; the procedural spacecraft geometry lives in **`ship/models/`** (`shipPrimitives`, `defaultShip`, `voyager`, `cassini`, `newHorizons`, `juno`).
- **`PlanetLabels.ts`**, **`Constellations.ts`**, **`ui/SunLabel.ts`** — billboard sprites + HTML labels with foreground-disc occlusion culling.
- **`PlanetariumStore.ts`** — localStorage/sessionStorage/IndexedDB persistence with 30s auto-save; migrates the pre-rename `orbital-sim-explore-state` key and reads the legacy `explore-help-seen` flag (intentional back-compat).
- **`planets/`** (`planetData`, `moonData`, `rings`), **`missions/historicJourneys.ts`**, **`data/`** (`brightStars`, `constellations`), **`world/`** (`starfield`; `ShadowVisuals` — true-scale shadow cones + transit shadow spots for the landed system; `deprecatedSkybox` — unwired, kept for reference), **`input/`** (`GyroSteering`; `SurfaceLook` — surface-view drag-look + wheel/pinch FOV), **`ship/models/`**, **`ui/`** (panel classes with `bind()`/`render()`).
- **Observatory** (`ui/ObservatoryPanel.ts` + `ui/ObservatoryHUD.ts` + `surfaceView.ts`): the landed-mode panel (Option D "Cinematic Instrument" — vantage header + companion swap, SVG phase glyph with a mono ∅/distance line, live now-bar, surface-view entry). Earth keeps its four prev/next rows with next-date metas (eclipse pairs run on the shadow engine and reuse the upcoming-search results; full/new moon stay on `findEvent`); every system gets an upcoming-events list searched chunked at ~4 ms/frame via `searchShadowEvent` resume cursors — restarted on open/jump/date-set, never steady-state. Magnitudes display for Earth only (generic systems badge-only). Eclipsed moons dim per frame via `computeMoonShading` in `updateMoonPositions` (Earth's Moon reddens in umbra). **Orbit details** (footer toggle): `orbitDetails.ts` (pure, unit-tested) derives ellipse annotation from the moon's real trajectory sampled through `computeMoonOffsetEquatorialAU`; `world/OrbitDetailsVisuals.ts` draws it; F1/F2 foci are fixed-px HTML glyphs; periods come from `getMoonDisplayOrbit` (mean-longitude rate); landed `maxDistance` stretches to the subject's apoapsis while the toggle is on. Session-only, hidden in surface view.
- **Surface view** ("Look up"): a narrow-FOV (1.5–45°) look-from-the-surface camera, session-only landed sub-state. `surfaceView.ts` is the pure observer-circumstances table — per-event targets incl. standing in the umbral spot for solar-eclipse views (`shadowAxisSurfacePoint` in shadows.ts, shared with `ShadowVisuals.poseSpot`) — plus vantage/entry-FOV math, unit-tested in `surfaceView.test.ts`. While active: OrbitControls hand over to `input/SurfaceLook`, the landed system's moons drop the 5%-of-parent mesh-scale floor (angular sizes are real — Io's silhouette is Io-sized), planet/moon/Sun labels and orbit lines hide, and the camera re-pins at the end of `updateLanded` (after the position refreshes). Event jumps re-point an active surface view instead of orbit-framing; the vantage swap re-lands on the companion via `applyLandedTarget` (no exit/enter ceremony, `preLand*` untouched).

### Moon flight — `src/moonFlight/`
Lunar-landing mini-game and the **cleanest decomposition to emulate**: `MoonFlightMode` (thin controller) composes `FlightController` (physics), `FlightInput` (keyboard/touch), `FlightHUD` (DOM), `SkyScene`, `lightingSnapshot`. Note: there is currently **no UI entry point** to this mode (the button was removed in git history); the code is intact and reachable only by restoring an entry call.

### Astronomy — `src/astronomy/`
Meeus ephemeris + JPL/Standish planet elements: `ephemeris` (Sun/Moon ecliptic-of-date position, phase, event search), `standish` (Standish/JPL propagated Kepler elements — the planets' element source; Table 1 inside 1800–2050, Table 2 beyond with clamped 3000 BC–3000 AD validity; values transcribed verbatim, never re-round), `satellites` + `satelliteElements` (all 64 non-Earth moons: JPL mean-element geometry with Horizons-anchored phase and calibrated/fitted rates; `satelliteElements.ts` is generated — edit only via `gen-moons.mjs`), `planetary` (element→scene-vector math, the Meeus Earth/Moon seams, body state), `shadows` (analytic umbra/penumbra geometry + eclipse/shadow-transit event search; season-prefiltered, resumable via `timeBudgetMs` cursors; positions resolve through the same seams the renderer uses; mirror-invariant), `precession` (of-date→J2000 longitude), `deltaT` (Espenak–Meeus ΔT; theories evaluate at TT), and `constants` (`J2000`, `OBLIQUITY_DEG`, and `DEG`/`RAD` re-exported from `shared/math/angles`).

**Frame contract: right-handed J2000 everywhere.** The scene is the J2000 equatorial frame as a **proper rotation** (det +1): +X vernal equinox, +Y celestial north, +Z = RA 270°; the intermediate ecliptic frame runs longitude toward **−Z**. `raDecToVector` (planetary.ts) is the single chirality definition site — the starfield and Constellations route through it; never re-inline the formula. Planets are native-J2000 Standish; Meeus Earth/Moon longitudes (ecliptic-of-date) are precessed to J2000 at the `planetary.ts` vector seams — never inside `ephemeris.ts` (its goldens quote of-date values). Earth's render position stays Meeus (−Sun vector, precessed) for exact Sun–Earth–Moon coherence; Earth's Standish EMB row draws only the decorative orbit line. Constellation figures have real-sky chirality, and **absolute rotation phase is real**: IAU pole + node (prime reference at RA = pole RA + 90°) + verbatim W means the right continents face the Sun at a UTC instant — pinned by the GMST test and the chirality pin (`raDecToVector(0,0) × raDecToVector(90,0) ≈ +Y`) in `planetary.test.ts`. All sign conventions are deliberate and test-pinned: don't flip any in isolation. JSON goldens are stored in raw Horizons frames; only the test-side `horizonsToScene` mappings encode the scene convention (ecliptic-J2000 `(x, y, z)` → `(x, z, −y)`).

### Shared — `src/shared/`
Cross-cutting, framework-free helpers: `math/` (`angles` — the single source for `DEG2RAD`/`RAD2DEG`; `smoothstepUnclamped`), `three/projectToScreen` (world→screen projection with an optional zero-alloc `out`), `dom` (`setText`), `debug`, `assets/` (`textures` — the Moon-flight texture URLs), `constants/` (`physicalData`), `shaders/` (`atmosphere`, `sun`). **`src/app/`** holds app-shell helpers (`gpuCapability` — the float-FBO bloom probe).

### Rendering Pipeline
- Post-processing bloom (`UnrealBloomPass`) on desktop when the GPU supports float framebuffers (tested at startup via a float FBO + `FRAMEBUFFER_COMPLETE`). Mobile/incapable GPUs get a no-bloom fallback with extra Sun glow shells. The composer is rebuilt when switching cameras between modes.
- PCF shadow maps for eclipse shadows. Custom GLSL: Sun corona (fbm noise), Earth atmosphere rim glow, Earth night lights, per-planet atmosphere glows.

### Key Patterns
- **All distances are real**: the Planetarium works in AU throughout (1 scene unit = 1 AU).
- **All textures bundled locally** in `public/textures/` (not CDN), referenced via `import.meta.env.BASE_URL + 'textures/'`. Asset paths built from `BASE_URL` strings are invisible to both tsc and Vite — verify them by running the app.
- **UI is vanilla HTML** in `index.html` (no framework); each mode has its own overlay section toggled via `display`. The TS reads elements by `id` — keep the `index.html` id set and the `getElementById` calls in sync.
- Startup URL params: `?auto=planetarium` (and the legacy `?auto=moonView`, kept so old links boot the app) land in the Planetarium; `?debug=1` shows the error/debug overlay.
