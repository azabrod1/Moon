# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development

```bash
npm run dev        # Vite dev server (hot reload)
npm run build      # TypeScript check + production build (dist/)
npm test           # vitest — astronomy + planetarium unit/golden tests
npm run gen:moons  # Regenerate satellite elements + goldens from JPL (--offline uses .moon-data-cache/)
npm run gen:maps   # Regenerate derived texture maps (runs in headless Chromium)
npm run gen:ktx2   # Regenerate the Moon's GPU-compressed 8K tier from its webp (headless Chromium + bundled basisu)
```

**Run `npm run build` and `npm test` after every change.** There is no linter; the strict tsconfig (`noUnusedLocals`/`noUnusedParameters`) is what catches refactor leftovers. CI runs the same then deploys Pages on push to `main`. `planning/` is gitignored local scratch — never commit it; stage by explicit path, never `git add -A`.

Manual testing: the DEV-only `window.__moon` console bridge (defined in `src/main.ts`) drives the app so you never click by hand — camera/clock (`jumpTo`, `travelTo` — the real travel pipeline with veil + arrival warm-up, `frame`, `setTimeMs`, `setTimeRate`), landed/Observatory hooks (`land`, `openObservatory`, `lookUp`, `lookAt`, `jumpEvent`, `exitSurface`), tutorial (`tutorialStart`/`tutorialNext`/`tutorialState`), motion forensics (`traceStart`/`traceStop`). `frame()` only poses the camera and never routes through the landed code — exercise landed-mode changes through the landed hooks.

Headless screenshots: `node tools/shoot.mjs` drives the same bridge; the method, the real-GPU flags, and the before/after recipe are in the `headless-webgl-screenshots` skill. `tools/` holds the wider capture/forensics kit — look there before writing a new one. Ad-hoc Playwright scripts live inside the repo (`tools/` or `planning/`), never `/tmp` (ESM resolves `node_modules` from the script's location).

Tests are colocated `*.test.ts` (vitest, explicit imports, no config file). The astronomy suite pins Meeus worked examples, published event catalogs, the scene's frame convention, and JPL Horizons vector goldens. When astronomy math changes, update fixtures deliberately, never by copying the new output; the moon fixtures regenerate only via `npm run gen:moons`.

## Architecture

A Three.js WebGL app. The **Planetarium** (`src/planetarium/`) is the app: the full solar system in real units (1 scene unit = 1 AU) on a floating-origin pattern (player stays at scene origin, bodies are offset by the player's position). `src/main.ts` is a thin entry point owning the renderer, composer, cameras, mode switching, and animation loop; each mode is a controller exposing `activate()/deactivate()/update(dt)`. `src/moonFlight/` is a dormant lunar-landing mini-game — intact but with no UI entry point. `src/astronomy/` is the ephemeris (Meeus + Standish elements, every planet's moons, analytic shadow/eclipse engine). `src/shared/` holds framework-free helpers (`math/angles` is the single source for `DEG2RAD`/`RAD2DEG`).

**Module headers are the subsystem documentation** — read the header comment before changing a module. Pure logic lives in DOM-free modules with colocated tests; the tightly-coupled per-frame core deliberately stays in `PlanetariumMode.ts`.

Generated / transcribed sources: `src/astronomy/satelliteElements.ts` is generated — edit only via `npm run gen:moons`; `standish.ts` element values are transcribed verbatim — never re-round them. The bright-star catalog ships as `public/stardata/bright-stars.v1.bin` + its golden `brightStarsGolden.json`, both written only by `npm run gen:stars` (parser and store: `src/planetarium/data/brightStars.ts`; consumers read `brightStarCatalog()` only after the boot loader installs it).

**Frame contract: right-handed J2000 everywhere.** The scene is the J2000 equatorial frame as a proper rotation: +X vernal equinox, +Y celestial north, +Z = RA 270°. `raDecToVector` (`planetary.ts`) is the single chirality definition site — never re-inline the formula. Meeus Earth/Moon longitudes (ecliptic-of-date) precess to J2000 at the `planetary.ts` vector seams — never inside `ephemeris.ts` (its goldens quote of-date values). Earth's render position stays Meeus (−Sun vector, precessed) for exact Sun–Earth–Moon coherence. Absolute rotation phase is real (IAU pole + node + verbatim W). All sign conventions are deliberate and test-pinned: don't flip any in isolation. JSON goldens are stored in raw Horizons frames; only the test-side `horizonsToScene` mappings encode the scene convention.

**Lens correction**: the planetarium renders through a stereographic lens pass (`shared/math/lensProjection` + `app/LensPass`), so:

- `applyDesignFov` is the only legal `camera.fov` writer; `camera.fov` holds the overscan — never compare against it, use `displayFovDeg()`.
- On-screen sizes/footprints come from `projectSphereToScreen`; screen-authored GPU primitives pre-distort via `shared/three/lensShader` — never size them from `camera.fov`.
- Every consumer reads `lens.effectiveStrength ?? lens.strength`, never the raw request.
- `tools/oval-probe.mjs` is the asserting regression battery.

### Key patterns

- **All textures bundled locally** in `public/textures/`, referenced via `import.meta.env.BASE_URL + 'textures/'` — such paths are invisible to both tsc and Vite; verify them by running the app.
- **UI is vanilla HTML** in `index.html` (no framework); the TS reads elements by `id` — keep the `index.html` id set and the `getElementById` calls in sync.
- **Nothing half-loaded is ever shown**: a moon never renders before `MoonPainter` finishes it, and teleports hold the arrival veil until the destination is ready. Perf work must preserve this gate.
- **Transient overlays are one-modal-at-a-time** (the ☰ menu, the deck, and the Look-at menu close each other; landing, takeoff, and mode deactivation close them too) — wire new overlays into the same close calls. The tutorial card is the one deliberate exception: the tutorial stages scenes through the other overlays, so only its own buttons and lifecycle close it.
- **UI idioms**: body tints come from catalog `color` (`planetData`/`moonData`), never hardcoded; names render through `bodyDisplayName` (deck rows deliberately show raw catalog names); list rows reuse the deck's `pk-row` family; view sub-states (surface view, orbit details) are session-only. UI copy is plain and human — read the neighbouring strings and match them.
- **The mobile breakpoint is 640px**: test UI changes at desktop and at 390×844 — the narrow band is where overlays collide.
- Startup URL params: `?auto=volumeCompare` boots the "How many fit?" compare mode; `?debug=1` shows the error/debug overlay; `?nosw=1` unregisters the service worker and deletes its caches (the kill switch); `?sectors=0` turns off surface sector streaming (Earth/Moon/Mars draw their equirect maps only — the A/B for tile questions).
- **A data-only service worker runs in prod** (generated into `dist/sw.js` by `tools/swPlugin.mjs` from `tools/sw.template.js`; behavior pinned by `swContract.test.ts`): it caches `textures/`, `stardata/`, `fonts/`, `models/`, `historic/` under content-hash keys and NEVER touches HTML or JS, so app code can't go stale through it — but when diagnosing a device, still check the menu build stamp first (`?debug=1`), and reach for `?nosw=1` if cached data is suspect. Dev is exempt. Those data directories must hold only format-stable opaque assets or pathname-versioned files (`bright-stars.v1.bin` → a format break ships as `.v2`): new app code must never reinterpret an unchanged data pathname.
