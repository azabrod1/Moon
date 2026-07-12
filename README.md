# Moon

Moon is a browser-based, flyable solar-system planetarium: real ephemerides for the planets and 65 moons, real eclipses and shadow transits, and surface observatories to watch them from.

Built with `Three.js`, `TypeScript`, `Vite`, and WebGL.

## Features

- Start in a flyable solar-system view with planets, moons, and distances presented at scale.
- Travel with keyboard controls or use the built-in travel menu and autopilot.
- Land on nearby planets and moons, then orbit them from a local camera view.
- Open the Observatory while landed: live phase data, upcoming eclipses and shadow transits with one-tap time jumps, narrow-FOV surface views ("Look up" — watch a solar eclipse from inside the umbra), true-scale shadow guides, and per-moon orbit details (real sampled ellipse, foci, apsides, equal-area sweep).
- Adjust astronomical time, reverse it, pause it, or jump back to the present.
- Open live stats for distance, light time, speed, temperature, and flight progress.
- Toggle constellation overlays and gyro steering on supported mobile devices.
- Save progress in the browser and resume later.
- Replay historic journeys for Voyager 1, Voyager 2, Cassini-Huygens, New Horizons, and Juno.

## Quick Start

Use Node.js `20+`. The GitHub Pages workflow builds on Node 20, and running `npm run build` under the local Node `14.17.0` environment produced a modern-syntax failure from the Vite toolchain.

```bash
npm install
npm run dev
```

Production commands:

```bash
npm run build
npm run preview
```

## Controls

- `W` / `S`: thrust
- `A` / `D`: yaw
- `Arrow Up` / `Arrow Down`: pitch
- `P`: toggle autopilot
- `T`: open or close the travel menu
- UI controls handle time, landing, mission playback, travel targets, and settings.

## Project Notes

- The app runs entirely client-side in the browser using WebGL.
- Planets mode auto-saves progress to browser storage and can restore a saved journey on return.
- Astronomy datasets are generated locally from the HYG Database and Stellarium source data.
- GitHub Pages deployment is configured in [`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml) and builds with a `/Moon/` base path.
- Supported startup URL params:
  - `?auto=planetarium` — boot directly into the Planetarium (the default)
  - `?auto=moonView` — legacy value, still accepted; the retired Moon view's links land in the Planetarium

## Data and Scripts

Available scripts and generators:

- `npm run dev` starts the Vite development server.
- `npm run build` runs TypeScript compilation and creates a production build in `dist/`.
- `npm run preview` serves the production build locally.
- `npm run gen:stars` regenerates the bright-star catalog from HYG data.
- `npm run gen:constellations` regenerates constellation line data from Stellarium and HYG inputs.

## Developer Notes

- Tests are vitest, colocated `*.test.ts` next to their modules (`npm test`): Meeus worked examples, published event catalogs, and JPL Horizons vector goldens.
- There is no configured linter in this repo.
- The current app UI is plain HTML/CSS plus TypeScript-driven Three.js scene logic rather than a frontend framework.
- This README intentionally avoids unverified screenshots, GIFs, badges, and live-demo links.
