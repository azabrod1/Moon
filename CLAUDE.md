# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development

```bash
npm run dev        # Start Vite dev server (hot reload)
npm run build      # TypeScript check + Vite production build (output: dist/)
npm run preview    # Serve production build locally
npm run gen:stars  # Regenerate the bright-star catalog (gen-stars.mjs)
```

No test framework is configured. No linter is configured. **`npm run build` (which runs `tsc` then `vite build`) is the only automated safety net — run it locally after every change.** Note that CI (`.github/workflows/deploy.yml`) runs `vite build` directly and does **not** run `tsc`, so type errors only surface in a local `npm run build`. `tsconfig` is `strict` but does not set `noUnusedLocals`, so dead code is not flagged by the build.

## Architecture

A **Three.js** WebGL app with **three modes** that share a single scene, renderer, and animation loop. `src/main.ts` is the entry point: it owns the renderer, the post-processing composer, the three cameras, app-mode switching/transitions, and the animation loop. Each mode is (or is becoming) a self-contained controller that exposes `activate()/deactivate()/update(dt)`.

### Moon view (default mode) — `src/moonView/` + `src/main.ts`
Geocentric Earth-Moon-Sun model for visualizing lunar phases and eclipses, driven by sliders or date-based ephemeris.
- **`src/moonView/bodies/`** — `Earth`, `Moon`, `Sun` classes; each owns its Three.js group, materials, and shaders. Distances are in **scene units** (1 unit = Earth radius, artistically compressed — see `shared/constants/sceneUnits.ts`).
- **`src/moonView/`** — `moonOrbitLine`, `orbitPlane`, `OrbitDetailsOverlay` (the orbit-details overlay + focus labels).
- Most Moon-view scene/state/UI currently still lives in `main.ts` (phase computation, shadow cones, starfield, ecliptic grid, camera presets, slider/preset/date bindings). This is mid-extraction into a `moonView/MoonViewMode` controller.

### Planetarium — `src/planetarium/`
A fly-through of the full solar system (Mercury–Pluto) in **AU**. Uses a **floating-origin** pattern: the player stays at scene origin and all bodies are offset by the player's position, avoiding float precision loss at large distances.
- **`PlanetariumMode.ts`** — the mode controller (large; mid-decomposition into world/input/navigation/landing/labels/ui/state subsystems).
- **`SolarSystem.ts`**, **`PlanetFactory.ts`** — build planets, orbit lines, asteroid belt, rings; async texture loading with procedural canvas fallback.
- **`PlayerShip.ts`** — player state + kinematics plus procedural spacecraft geometry (default ship + Voyager/Cassini/New Horizons/Juno historic probes).
- **`PlanetLabels.ts`**, **`Constellations.ts`**, **`ui/SunLabel.ts`** — billboard sprites + HTML labels with foreground-disc occlusion culling.
- **`PlanetariumStore.ts`** — localStorage/sessionStorage/IndexedDB persistence with 30s auto-save; migrates the pre-rename `orbital-sim-explore-state` key and reads the legacy `explore-help-seen` flag (intentional back-compat).
- **`planets/`** (`planetData`, `moonData`, `rings`), **`missions/historicJourneys.ts`**, **`data/`** (`brightStars`, `constellations`), **`ui/`** (panel classes with `bind()`/`render()`).

### Moon flight — `src/moonFlight/`
Lunar-landing mini-game and the **cleanest decomposition to emulate**: `MoonFlightMode` (thin controller) composes `FlightController` (physics), `FlightInput` (keyboard/touch), `FlightHUD` (DOM), `SkyScene`, `lightingSnapshot`. Note: there is currently **no UI entry point** to this mode (the button was removed in git history); the code is intact and reachable only by restoring an entry call.

### Astronomy — `src/astronomy/`
Meeus-based ephemeris: `ephemeris` (Sun/Moon ecliptic position, phase, event search), `kepler`, `planetary`, `lunarOrbit`, and `constants` (`J2000`, `OBLIQUITY_DEG`, and `DEG`/`RAD` re-exported from `shared/math/angles`).

### Shared — `src/shared/`
Cross-cutting, framework-free helpers: `math/` (`angles` — the single source for `DEG2RAD`/`RAD2DEG`; `smoothstep`), `three/projectToScreen` (world→screen projection), `dom` (`setText`/`setDisplay`), `debug`, `format`, `assets/` (`textureLoader`, `textures`), `constants/` (`sceneUnits`, `physicalData`), `shaders/` (`atmosphere`, `sun`).

### Rendering Pipeline
- Post-processing bloom (`UnrealBloomPass`) on desktop when the GPU supports float framebuffers (tested at startup via a float FBO + `FRAMEBUFFER_COMPLETE`). Mobile/incapable GPUs get a no-bloom fallback with extra Sun glow shells. The composer is rebuilt when switching cameras between modes.
- PCF shadow maps for eclipse shadows. Custom GLSL: Sun corona (fbm noise), Earth atmosphere rim glow, Earth night lights, per-planet atmosphere glows.

### Key Patterns
- **Two unit systems**: Moon view uses "scene units" (1 = Earth radius, compressed); Planetarium uses AU directly.
- **All textures bundled locally** in `public/textures/` (not CDN), referenced via `import.meta.env.BASE_URL + 'textures/'`. Asset paths built from `BASE_URL` strings are invisible to both tsc and Vite — verify them by running the app.
- **UI is vanilla HTML** in `index.html` (no framework); each mode has its own overlay section toggled via `display`. The TS reads elements by `id` — keep the `index.html` id set and the `getElementById` calls in sync.
- Startup URL params: `?auto=planetarium` or `?auto=moonView` boot directly into a mode; `?debug=1` shows the error/debug overlay.
