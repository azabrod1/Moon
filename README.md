# Moon

Moon is a browser-based space experience that combines a lunar phase and eclipse simulator with a flyable solar-system explorer in one WebGL app.

Built with `Three.js`, `TypeScript`, `Vite`, and WebGL.

## Features

### Moon mode

- Explore the Earth-Moon-Sun system with manual orbital controls.
- Switch to UTC date mode to inspect real positions over time.
- Jump directly to full moons, new moons, solar eclipses, and lunar eclipses.
- Toggle orbit details to inspect the ellipse, foci, and daily swept-area visualization.
- Swap between overview, top-down, Earth, and side camera presets.

### Planets mode

- Start in a flyable solar-system view with planets, moons, and distances presented at scale.
- Travel with keyboard controls or use the built-in travel menu and autopilot.
- Land on nearby planets and moons, then orbit them from a local camera view.
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

### Planets mode

- `W` / `S`: thrust
- `A` / `D`: yaw
- `Arrow Up` / `Arrow Down`: pitch
- `P`: toggle autopilot
- `T`: open or close the travel menu
- UI controls handle time, landing, mission playback, travel targets, and settings.

### Moon mode

- Use the on-screen sliders for Moon position, Sun direction, and lunar node.
- Use the time controls to play, pause, reverse, or accelerate the simulation.
- Use event jump buttons to move to major lunar phases and eclipse events.
- Use the camera buttons to switch viewpoints.

## Project Notes

- The app runs entirely client-side in the browser using WebGL.
- Planets mode auto-saves progress to browser storage and can restore a saved journey on return.
- Astronomy datasets are generated locally from the HYG Database and Stellarium source data.
- GitHub Pages deployment is configured in [`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml) and builds with a `/Moon/` base path.
- Supported startup URL params:
  - `?auto=explore`
  - `?auto=simulator`

## Data and Scripts

Available scripts and generators:

- `npm run dev` starts the Vite development server.
- `npm run build` runs TypeScript compilation and creates a production build in `dist/`.
- `npm run preview` serves the production build locally.
- `npm run gen:stars` regenerates the bright-star catalog from HYG data.
- `node gen-constellations.mjs` regenerates constellation line data from Stellarium and HYG inputs.

## Developer Notes

- There is no configured test framework in this repo.
- There is no configured linter in this repo.
- The current app UI is plain HTML/CSS plus TypeScript-driven Three.js scene logic rather than a frontend framework.
- This README intentionally avoids unverified screenshots, GIFs, badges, and live-demo links.
