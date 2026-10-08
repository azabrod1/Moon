# CLAUDE.md

**Keep this file under 1,000 words, each entry at most two lines.** Every future session reads all of it, so before adding a line, ask whether it is worth that or belongs in a comment beside its code. Every session thinks its own point is important; most belong in the code. What earns a place: commands, rules that break things quietly, where to look, and conventions that really matter.

## Commands

```bash
npm run build              # type-check and build; unused variables fail the build
npx vitest run --dir src   # run the tests (plain `npm test` also runs the copies in planning/ worktrees)
npm run gen:moons          # refresh moon orbits and test data from JPL
npm run gen:maps           # rebuild the derived texture maps
```

The other generators and tile publishing are in `docs/assets.md`.

## After every change

- Run the build and the tests. There is no linter.
- Never commit `planning/`; it is scratch space. Add files by name, never `git add -A`.
- If you edit shader code, also run `NODE_ENV=production npx vitest run --mode production --dir src src/planetarium/world/aerialPerspective.test.ts`. The shaders are pinned by hash in tests; update a hash only when you meant the change.
- Never update an astronomy test value by pasting in new output. Some files are generated, so edit them only through their script: `satelliteElements.ts` (`gen:moons`), the star catalog (`gen:stars`), `constellations.ts` (`gen:constellations`). `standish.ts` is copied from a published table; never round its numbers.

## Running and testing

- `docs/running.md` lists the URL switches and the `window.__moon` console helpers used to drive the app.
- `docs/testing.md` covers screenshots, the test tools in `tools/` (check there before writing a new one) and performance measurement.
- Run one browser test at a time; most tools take `/tmp/moon-browser.lock`. Put test scripts in `tools/` or `planning/`, never `/tmp`.
- `__moon.frame()` only moves the camera. It skips landing, travel and collisions, so test those through their own helpers.
- Check UI changes on a desktop window and at phone size, 390×844.

## How the app is built

A Three.js app. `src/planetarium/` is the whole solar system at real scale, where 1 unit is 1 AU. The ship always stays at (0, 0, 0) and the world moves around it, which keeps the numbers small enough for the GPU. `src/main.ts` owns the renderer and switches between modes; each mode has `activate()`, `deactivate()` and `update(dt)`. `src/interior/` is the Look-inside tool, `src/astronomy/` computes where everything is, `src/shared/` holds small helpers.

- Each module's opening comment is its documentation. Read it before changing the module, and update it when the behaviour changes.
- Only the mode switch sets the renderer's tone curve (`src/app/renderProfile.ts`). Modes stay alive for the whole session, so a mode that set it would leave it set for every other mode.

## Rules that break things quietly

- **Coordinates.** The scene uses one fixed sky frame (J2000: +X toward the March equinox, +Y toward celestial north). Convert sky positions only through `raDecToVector` in `planetary.ts`. The sign conventions are pinned by tests: never flip one on its own, or the sky comes out mirrored.
- **The lens.** The picture passes through a curved-lens effect, so the camera renders a wider view than the screen shows. Set the field of view only with `applyDesignFov`, read the visible one with `displayFovDeg()`, never `camera.fov`, and size things on screen with `projectSphereToScreen`. `tools/oval-probe.mjs` tests this.
- **Never show anything half-loaded.** A moon appears only after its texture is painted, and a jump waits behind the loading veil until the destination is ready.
- **Earth's ground uses the alpha channel** to mark the sea for the glow pass. Anything drawn over Earth must not write alpha, or the sun's reflection on the sea grows a halo.
- **The Sun's brightness is set in one place**, `src/planetarium/sunLight.ts`. Any brightness threshold you add is multiplied by `SUN_LIGHT_BASELINE`.
- **User settings** (graphics quality, frame rate, night sides) each have their own `localStorage` key. Never put them in the saved journey.
- **A shell that beats Earth's ground by a polygon offset** (the night tiles) computes `gl_Position` exactly as three's `project_vertex` does, the view transform first. A different order rounds differently, and the offset loses in patches.
- **The renderer sizes itself from the canvas element**, never from the window size; on an iPad in full screen the two differ. Anything pinned to a screen edge uses `env(safe-area-inset-…)`, never a fixed pixel offset.

## Interface

- The interface is plain HTML in `index.html`. If you rename an element's id, rename it in the code too.
- Only one menu or panel is open at a time. A new one must close the others, and be closed by them.
- Planet colours come from the catalog, and names go through `bodyDisplayName`. Write interface text plainly, like the text around it.
- Texture paths are built at run time, so the build cannot check them. Open the app to confirm a new one loads.

## Data and caching

- In production a service worker caches textures and data files, never code. Never change what is inside a data file under the same name: ship `name.v2` instead. `?nosw=1` clears the cache.
- Map tiles are named by a hash of their contents and served from a separate repo. A published tile path never changes.
