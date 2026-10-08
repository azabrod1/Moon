# Assets

Each generator's header has its steps and prerequisites. Several need `npm i --no-save sharp@0.35.4` first.

- `npm run gen:moons` and `npm run gen:maps`: see CLAUDE.md.
- `npm run gen:stars`: the bright-star catalog `public/stardata/bright-stars.v1.bin` and its golden. `npm run gen:constellations`: `src/planetarium/data/constellations.ts`.
- `npm run gen:moonmaps`: photo maps for the procedural moons (`tools/gen-moonmaps.mjs`).
- `npm run gen:moon-relief -- [--width=8128 --tier=8k --exaggeration=1.39]`: the Moon's relief map in physical units from NASA's 64 px/deg LOLA grid (`.moon-data-cache/ldem_64_uint.tif`, fetched by hand from svs.gsfc.nasa.gov/4720), for gen-tiles' `moon-normal/8k` crop.
- `npm run gen:relief`: Mars's relief (the boot map, the 4K rung and the 8K and 16K crop sources) from the USGS HRSC–MOLA blended DEM in `.moon-data-cache/` (`tools/gen-relief.mjs`, needs sharp like gen:tiles); then `npm run gen:tiles -- mars --crops --level=0` re-cuts the level-0 relief crops into public/ and `npm run gen:tiles -- mars --crops --level=1 --root=.moon-data-cache/tiles-staging` the level-1 crops for the tile host.
- `npm run gen:seawind`: the sea's wind map, `public/textures/earth-seawind.v2.webp` (the speed in red, the wind's axis in green and blue), from NOAA's sea-wind climatology in `.moon-data-cache/` (`tools/gen-seawind.sources.json`); it needs `npm i --no-save sharp@0.35.4 h5wasm@0.10.3` and commits its statistics under `tools/goldens/seawind/`. `--synthetic` and `--synthetic-speed` bake the authored field as candidates. Move the hash pin in `seaWind.test.ts` deliberately.
- `npm run gen:ktx2 -- <job…>`: the GPU-compressed colour rungs for the jobs named. Name the jobs: a run with `--all` rewrites every file. With no job it lists them.
- `npm run gen:tiles -- <job|--all> [--verify | --grey]`: re-cut sector tile sets and rewrite `sectorSets.generated.ts`. `clouds` cuts the cloud field into a staging root; `clouds --base` cuts the deck's base sheet, and the tool's usage lines say what to regenerate after it.
- `npm run gen:cloudmaster`: NASA's cloud hemispheres assembled into the cloud master.

## Publishing tiles

- `node tools/publish-tiles.mjs --root=<tiles root> --repo=<tiles repo checkout>` re-hashes every set, copies new folders in, commits in the tiles repo and prints the `VITE_TILE_ORIGIN` to build against. It never pushes and never deletes; `--dry-run` and `--verify-only` touch nothing.
- A folder's name is its set's content hash, so a re-cut set arrives as a new folder and old sets stay for clients still asking for them. Pruning is by hand.
- A build with an origin set leaves `textures/tiles` out of `dist/` and the worker's manifest. `public/textures/tiles` stays, for builds without one.
