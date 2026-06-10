# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development

```bash
npm run dev        # Start Vite dev server (hot reload)
npm run build      # TypeScript check + Vite production build (output: dist/)
npm test           # vitest run — astronomy golden/consistency tests (src/astronomy/*.test.ts)
npm run preview    # Serve production build locally
npm run gen:stars  # Regenerate the bright-star catalog (gen-stars.mjs)
npm run gen:moons  # Regenerate satellite elements + goldens from JPL (gen-moons.mjs; --offline uses .moon-data-cache/)
```

No linter is configured. **Run `npm run build` and `npm test` locally after every change.** CI (`.github/workflows/deploy.yml`) runs `tsc`, the tests, then the Pages build. `tsconfig` is `strict` and sets `noUnusedLocals`/`noUnusedParameters`, so unused imports, locals, and parameters fail the build (this is what catches refactor leftovers).

Tests are colocated `*.test.ts` next to their modules (vitest, explicit imports, no config file) — `src/astronomy/*` plus `src/planetarium/SolarSystem.test.ts`. They pin the ephemeris to Meeus worked examples, published event catalogs (full moons, eclipses), the scene's frame convention, and JPL Horizons vector goldens: 45 heliocentric (`standish.test.ts` — provenance in its header) pinning the Standish propagation and the J2000 frame absolutely, ~800 planetocentric moon vectors (`satellites.goldens.json`, bounds derived from each record's measured residuals), and shadow-event goldens (`shadows.goldens.json` — Horizons vectors at eclipse/transit peaks + EclipseWise Earth-eclipse circumstances; regeneration recipe in the `shadows.test.ts` header). When astronomy math changes, update fixtures deliberately, never by copying the new output; the moon fixtures regenerate only via `npm run gen:moons`.

## Architecture

A **Three.js** WebGL app with **three modes** that share a single scene, renderer, and animation loop. `src/main.ts` is the entry point: it owns the renderer, the post-processing composer, the three cameras, app-mode switching/transitions, and the animation loop. Each mode is (or is becoming) a self-contained controller that exposes `activate()/deactivate()/update(dt)`.

### Moon view (default mode) — `src/moonView/` + `src/main.ts`
Geocentric Earth-Moon-Sun model for visualizing lunar phases and eclipses, driven by sliders or date-based ephemeris.
- **`src/moonView/bodies/`** — `Earth`, `Moon`, `Sun` classes; each owns its Three.js group, materials, and shaders. Distances are in **scene units** (1 unit = Earth radius, artistically compressed — see `shared/constants/sceneUnits.ts`).
- **`src/moonView/`** — `phase` (phase/eclipse classification), `starfield`, `eclipticGrid`, `shadowCones`, `moonOrbitLine`, `orbitPlane`, `OrbitDetailsOverlay`. The remaining Moon-view UI state (sliders, presets, date mode, camera animations) is still hosted in `main.ts`.

### Planetarium — `src/planetarium/`
A fly-through of the full solar system (Mercury–Pluto) in **AU**. Uses a **floating-origin** pattern: the player stays at scene origin and all bodies are offset by the player's position, avoiding float precision loss at large distances.
- **`PlanetariumMode.ts`** — the mode controller. Self-contained pieces are extracted to siblings (`world/starfield`, `input/GyroSteering`, `ui/*` panels, labels); the tightly-coupled per-frame core (update pipeline, navigation, landing, missions, camera) deliberately stays in the controller.
- **`SolarSystem.ts`**, **`PlanetFactory.ts`** — build planets, orbit lines, asteroid belt, rings; async texture loading with procedural canvas fallback.
- **`PlayerShip.ts`** — player state + kinematics; the procedural spacecraft geometry lives in **`ship/models/`** (`shipPrimitives`, `defaultShip`, `voyager`, `cassini`, `newHorizons`, `juno`).
- **`PlanetLabels.ts`**, **`Constellations.ts`**, **`ui/SunLabel.ts`** — billboard sprites + HTML labels with foreground-disc occlusion culling.
- **`PlanetariumStore.ts`** — localStorage/sessionStorage/IndexedDB persistence with 30s auto-save; migrates the pre-rename `orbital-sim-explore-state` key and reads the legacy `explore-help-seen` flag (intentional back-compat).
- **`planets/`** (`planetData`, `moonData`, `rings`), **`missions/historicJourneys.ts`**, **`data/`** (`brightStars`, `constellations`), **`world/`** (`starfield`; `ShadowVisuals` — true-scale shadow cones + transit shadow spots for the landed system; `deprecatedSkybox` — unwired, kept for reference), **`input/GyroSteering`**, **`ship/models/`**, **`ui/`** (panel classes with `bind()`/`render()`).
- **Sky panel** (`ui/SkyPanel.ts`): landed-mode phase readout + event jumps for any moon system. Earth keeps its four prev/next rows (the eclipse pairs run on the shadow engine; full/new moon stay on `findEvent`); every system gets an upcoming-events list searched chunked at ~4 ms/frame via `searchShadowEvent` resume cursors — restarted on open/jump/date-set, never steady-state. Eclipsed moons dim per frame via `computeMoonShading` in `updateMoonPositions` (Earth's Moon reddens in umbra).

### Moon flight — `src/moonFlight/`
Lunar-landing mini-game and the **cleanest decomposition to emulate**: `MoonFlightMode` (thin controller) composes `FlightController` (physics), `FlightInput` (keyboard/touch), `FlightHUD` (DOM), `SkyScene`, `lightingSnapshot`. Note: there is currently **no UI entry point** to this mode (the button was removed in git history); the code is intact and reachable only by restoring an entry call.

### Astronomy — `src/astronomy/`
Meeus ephemeris + JPL/Standish planet elements: `ephemeris` (Sun/Moon ecliptic-of-date position, phase, event search), `standish` (Standish/JPL propagated Kepler elements — the planets' element source; Table 1 inside 1800–2050, Table 2 beyond with clamped 3000 BC–3000 AD validity; values transcribed verbatim, never re-round), `satellites` + `satelliteElements` (all 64 non-Earth moons: JPL mean-element geometry with Horizons-anchored phase and per-moon calibrated/fitted rates — `satelliteElements.ts` is **generated**, edit only via `gen-moons.mjs`; its provenance header lists per-moon measured residuals and tiers, incl. honest librator/irregular limits), `planetary` (element→scene-vector math, the Meeus Earth/Moon seams, body state), `shadows` (analytic umbra/penumbra geometry + eclipse/shadow-transit event search: kind-split classification — immersion magnitudes for moons in a parent's shadow, near-surface cone contact for a moon's shadow on the parent; eclipse-season β-prefilter with drift-bounded strides; resumable via `timeBudgetMs` cursors; positions resolve through `computeBodyPositionAU` and the `computeMoonOffsetEquatorialAU` seam in `satellites.ts`, so the engine sees exactly what the renderer draws; mirror-invariant — dots and norms only), `precession` (of-date→J2000 longitude), `deltaT` (Espenak–Meeus ΔT; theories evaluate at TT), `lunarOrbit`, and `constants` (`J2000`, `OBLIQUITY_DEG`, and `DEG`/`RAD` re-exported from `shared/math/angles`).

**Frame contract: J2000 everywhere.** The star sphere is built from J2000 RA/Dec; planets are native-J2000 Standish; Meeus Earth/Moon longitudes (ecliptic-of-date) are precessed to J2000 at the `planetary.ts` vector seams — never inside `ephemeris.ts` (its goldens quote of-date values). Earth's render position stays Meeus (−Sun vector, precessed) for exact Sun–Earth–Moon coherence; Earth's Standish EMB row draws only the decorative orbit line. **Known limitation:** the scene embeds the sky through a det(−1) (mirror-image) map — internally consistent and golden-tested, but constellation figures render E–W flipped vs reality and absolute planet rotation phase (which continents face the Sun at a UTC instant) is approximate; the chirality flip is a roadmapped milestone, documented at `getBasePrimeDirection` in `planetary.ts`. Don't "fix" individual signs piecemeal.

### Shared — `src/shared/`
Cross-cutting, framework-free helpers: `math/` (`angles` — the single source for `DEG2RAD`/`RAD2DEG`; `smoothstepUnclamped`), `three/projectToScreen` (world→screen projection with an optional zero-alloc `out`), `dom` (`setText`), `debug`, `format`, `assets/` (`textureLoader`, `textures`), `constants/` (`sceneUnits`, `physicalData`), `shaders/` (`atmosphere`, `sun`). **`src/app/`** holds app-shell helpers (`gpuCapability` — the float-FBO bloom probe).

### Rendering Pipeline
- Post-processing bloom (`UnrealBloomPass`) on desktop when the GPU supports float framebuffers (tested at startup via a float FBO + `FRAMEBUFFER_COMPLETE`). Mobile/incapable GPUs get a no-bloom fallback with extra Sun glow shells. The composer is rebuilt when switching cameras between modes.
- PCF shadow maps for eclipse shadows. Custom GLSL: Sun corona (fbm noise), Earth atmosphere rim glow, Earth night lights, per-planet atmosphere glows.

### Key Patterns
- **Two unit systems**: Moon view uses "scene units" (1 = Earth radius, compressed); Planetarium uses AU directly.
- **All textures bundled locally** in `public/textures/` (not CDN), referenced via `import.meta.env.BASE_URL + 'textures/'`. Asset paths built from `BASE_URL` strings are invisible to both tsc and Vite — verify them by running the app.
- **UI is vanilla HTML** in `index.html` (no framework); each mode has its own overlay section toggled via `display`. The TS reads elements by `id` — keep the `index.html` id set and the `getElementById` calls in sync.
- Startup URL params: `?auto=planetarium` or `?auto=moonView` boot directly into a mode; `?debug=1` shows the error/debug overlay.
