# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development

```bash
npm run dev        # Start Vite dev server (hot reload)
npm run build      # TypeScript check + Vite production build (output: dist/)
npm run preview    # Serve production build locally
```

No test framework is configured. No linter is configured.

## Architecture

This is a **Three.js orbital simulation** with two distinct modes sharing a single scene and renderer:

### Simulator Mode (default)
Geocentric Earth-Moon-Sun model for visualizing lunar phases and eclipses. The user controls orbital angles via sliders or date-based ephemeris. Key pieces:
- **`src/main.ts`** — App entry point, owns the renderer/scene/camera, UI wiring, animation loop, and mode switching between simulator and explore. All simulator logic (sliders, presets, camera views, date mode) lives here as top-level state.
- **`src/bodies/`** — `Earth`, `Moon`, `Sun` classes for the simulator's geocentric view. Each manages its own Three.js group, materials, and shaders. Distances are in "scene units" where 1 unit = Earth radius (see `SCENE` constants).
- **`src/utils/ephemeris.ts`** — Astronomical calculations (Meeus algorithms) for Sun/Moon ecliptic positions, phase computation, and event search (next full moon, eclipse, etc.). Used by date mode in the simulator.
- **`src/utils/constants.ts`** — `REAL` (km-based astronomical values), `SCENE` (artistically compressed scene-unit values), and texture paths. Scene distances are heavily compressed for visual clarity (Moon at 20 units, Sun at 120 units vs. real 60.3 and 23,455).

### Explore Mode
A fly-through of the full solar system (Mercury to Pluto) using AU as the unit system. Activated via a button in the UI:
- **`src/explore/ExploreMode.ts`** — Mode controller. Uses a **floating-origin** pattern: the player is always at scene origin, and all objects are offset by the player's position. This avoids floating-point precision issues at large AU distances.
- **`src/explore/PlayerShip.ts`** — Player state (position in AU, heading, speed as multiple of light speed). Movement is 2D on the ecliptic plane.
- **`src/explore/SolarSystem.ts`** — Creates all planets, orbit lines, asteroid belt, and the explore-mode Sun. Planets are placed at fixed circular orbit positions.
- **`src/explore/PlanetFactory.ts`** — Async planet mesh creation with texture loading, atmosphere glows (per-planet shader configs), Earth-specific night lights/clouds, and Saturn rings. Falls back to procedurally-generated canvas textures on load failure.
- **`src/explore/PlanetMarker.ts`** — Billboard sprites + HTML labels for distant planets. Markers auto-hide when the planet mesh is large enough to see directly.
- **`src/explore/SaveManager.ts`** — localStorage persistence for explore state with 30s auto-save.
- **`src/explore/planets/planetData.ts`** — All planet physical data (radii, orbital elements, colors, texture keys). `ALL_BODIES` includes Pluto.

### Rendering Pipeline
- Post-processing bloom (`UnrealBloomPass`) is enabled on desktop when the GPU supports float framebuffers. Mobile and incapable GPUs get a no-bloom fallback with extra Sun glow shells.
- GPU capability is tested at startup by creating a float FBO and checking `FRAMEBUFFER_COMPLETE`.
- Shadow maps (PCFShadowMap) are enabled for eclipse shadow visualization.
- Custom GLSL shaders: Sun corona (fbm noise), Earth atmosphere (rim glow), Earth night lights (sun-direction-based), per-planet atmosphere glows in explore mode.

### Key Patterns
- **Two unit systems**: Simulator uses "scene units" (1 = Earth radius, compressed distances). Explore uses AU directly.
- **All textures bundled locally** in `public/textures/` (not CDN). Referenced via `import.meta.env.BASE_URL + 'textures/'`.
- **UI is vanilla HTML** in `index.html` — no framework. Simulator and explore each have their own UI overlay sections toggled via `display: none/block`.
- The composer (bloom pipeline) is rebuilt when switching cameras between modes.
