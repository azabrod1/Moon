# Testing

- `npx vitest run --dir src` runs the colocated `*.test.ts` files (explicit imports, no config file). The astronomy suite pins Meeus worked examples, published event catalogs, the frame convention and JPL Horizons vector goldens.
- The surface shaders are pinned by a hash of their text, in both the dev and the production build. The normal test run checks the dev text. `NODE_ENV=production npx vitest run --mode production --dir src src/planetarium/world/aerialPerspective.test.ts` checks the production text, and one test there proves the two match.
- Headless screenshots: `node tools/shoot.mjs`. The method and the real-GPU flags are in `.claude/skills/headless-webgl-screenshots/SKILL.md`.
- Run one browser test at a time. Most tools take `/tmp/moon-browser.lock` (`tools/browserLock.mjs`) so two runs never share the GPU; `oval-probe`, `flyby-probe` and `shoot.mjs` do not yet, so never start them beside another browser run. Put Playwright scripts in `tools/` or `planning/`: a script in `/tmp` cannot find the project's packages.
- Before calling a tree ready for a look, run `tools/visual-sweep.mjs`. To prove a switch moved no pixel, run `tools/pixel-gate.mjs` (`--reload=<key>` across two boots, `--report` for numbers).
- Pixel A/B captures: pin Earth's atmosphere tier first (`__moon.atmoTier(null|'analytic', true)` once Earth reaches 'lut'; the bake lands ~9 s after ready), and wait for the texture ladder's rung as well as the sector streamer, or a faster arm reaches the pose at a different rung. Before blaming a shader term for an artefact, capture the same pose with the term switched off. Judge relief under grazing light; nadir light hides a height field.
- Playwright cannot show real full screen or what Escape does there. A real browser is the only proof.
- After a change to glow, glare or post-processing, also look with the glow off (`__moon.setBloom(false)`) and with `?nofloat=1`. The glow hides glare bugs that those paths show.

## Batteries in tools/

Each tool's header gives its scenarios, its bars and its control arm. Most take `--assert`, which exits 1 on a failure.

- `oval-probe`: the lens. `approach-probe`, `lens-ab-capture`: the lens proximity ramp.
- `flyby-probe`: arrivals. `station-probe`: a parked ship holds its ground. `orbit-line-probe`: orbit lines hold still as the ship moves.
- `smoothness-gate`: frame delivery.
- `sector-probe`: sector tiles and the texture ladder against the memory envelope. `ground-cull-probe`: the hidden-ground cut is pixel-identical.
- `cloud-field-probe`: the cloud field's pages. `cloud-hd-probe`: cloud shadows against the drawn deck. `cloud-detail-probe`: the deck's detail rides its cloud. `cloud-magnify-probe`: magnified clouds stay white.
- `glint-probe`: the sea's glint as linear radiance; `--meter` is the highlight meter's battery.
- `interior-sweep`, `interior-open-probe`: Look inside, its races and its opening cost.
- `mini-size-probe`: the corner chart's size and gestures. `fullscreen-probe`: full screen, the safe-area box, and the tools framed on the canvas's box.
- `save-probe`: a save writes the journey the user left, never a historic mission's staged scene, and the clock and ship as the user left them, not as ☰ or the help sheet holds them.
- `pixel-gate`: did a switch move a pixel. `visual-sweep`: what the surfaces look like. `atmo-shell-qa`: the atmosphere goldens. `sampler-census`: texture units per switch combination.

## Performance

- `__moon.gpuProfile({frames})` (`src/app/devGpuProfile.ts`) measures how many GPU milliseconds each step of a frame takes, on the device itself. Every step carries a small fixed overhead; its header says how to subtract it before comparing.
- Compare GPU cost only above the GPU's fixed floor (about 1.7 ms on M-series up to 1440p): measure at 5K, or at 1440p CSS at 1×, or every variant reads as the floor.
- `?perf=1` opens the on-device speed overlay (`src/app/devPerfSweep.ts`). It alternates each feature on and off in blocks so a phone warming up does not skew the result. Read its header before trusting a row.
- An iPhone is driven over USB from the Mac (safaridriver). Profile it cool and again after minutes parked, because it throttles within two minutes.
- Profile boot against a built dev-mode bundle, not the dev server, whose module traffic skews the timings: `VITE_TILE_ORIGIN=https://cdn.jsdelivr.net/gh/azabrod1/moon-tiles@main NODE_ENV=development npx vite build --mode development --minify false --outDir planning/dist-profile`, then serve that folder. A production build strips `__moon`; the tile origin is needed because `--mode development` does not read `.env.production`.
