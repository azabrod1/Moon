# Running the app

`npm run dev` starts the dev server. It also serves the map tiles that are cut but not yet published, from the main checkout's `.moon-data-cache/tiles-staging` (`MOON_TILES_ROOT` points it elsewhere).

## URL switches

Add these to the address bar. Most turn one feature off, so you can compare the picture with and without it. The module named in brackets explains the feature. Switches marked DEV work only on the dev server.

Starting points and diagnosis
- `?auto=volumeCompare` opens "How many fit?". `?auto=interior&body=Mars` opens Look inside on Mars.
- `?debug=1` shows the error and debug overlay. It works on a phone too.
- `?nosw=1` removes the service worker and its cached files.
- `?nofloat=1` uses the simpler render path, with no glow.

Picture quality and frame rate
- `?quality=low|medium|dynamic` starts at that graphics level (`app/renderQuality.ts`). DEV also takes `high`.
- `?fps=screen|30|60|120` starts at that frame rate (`app/frameCadence.ts`). DEV `?refresh=<hz>` pretends the screen runs at that rate.
- `?upscale=<ratio>` draws the scene smaller and scales it up (`app/UpscalePass.ts`). `?upscale=0` turns that off.
- `?msaa=0` goes back to the older way of smoothing edges, by drawing more pixels (`app/renderResolution.ts`). DEV `?msaa=2|4|8` forces an amount. DEV `?ratio=<n>` forces the pixel ratio.
- `?canvasaa=1` puts the old edge smoothing back on the page's canvas. It needs a reload.
- `?fused=0` finishes each frame in three steps instead of one (`app/FusedOutputPass.ts`). This one changes pixels slightly.
- `?fuseddown=0` shrinks a picture drawn larger than the screen (High, and Dynamic above Medium) in a step of its own again, instead of inside the finishing step (`app/FusedOutputPass.ts`). This one also changes pixels slightly. DEV `?perfoff=fused-downsample` does the same.
- `?glass=0` leaves the frosted glass behind the panels and buttons to the browser, as before, instead of the renderer blurring it into the frame (`app/glassBackdrop.ts`). DEV `?perfoff=engine-glass` does the same, and `__moon.perfArm('engine-glass', …)` flips it live.
- `?dither=0` turns off the fine fixed grain added wherever the picture is stored in 8 bits (`app/outputDither.ts`); without it, dark gradients show steps.
- `?alloc=0`, `?gpuclock=0` and `?rungmemory=0` turn off three parts of the Dynamic quality level: its fixed memory, its GPU timer and its memory of the last good level (`app/sceneSubRect.ts`, `app/gpuFrameClock.ts`, `app/rungMemory.ts`).
- DEV `?envelope=<MiB>` gives the app a phone's memory limit. DEV `?perfoff=<names>` starts with speed-ups off (`app/perfSwitches.ts`). DEV `?perf=1` opens the speed-measuring overlay (see `docs/testing.md`).

Ground and map tiles
- `?sectors=0` turns off the detailed map tiles. `?groundcull=0` draws the ground hidden under them again (`world/groundCull.ts`); Earth's night lights stay cut, or they would draw twice.
- `?tilebytes=0` uploads tiles the old way. `?sphereworker=0` builds a body's finer sphere on the main thread, a piece a frame, instead of in a worker (`world/fineSpheres.ts`). `?synth=0` turns off the extra close-up surface detail. DEV `?synthdepth=<1..8>` builds that detail from that many rungs of craters instead of 7 (`world/surfaceShading.ts`), for comparing the picture and the cost.
- DEV `?tiles=<url>` loads tiles from another address.

Earth's sea, air and clouds (in `world/surfaceShading.ts` unless named)
- `?seawind=0` gives the whole sea one roughness instead of the wind map (`world/seaWind.ts`). It also takes away the whitecaps, which read their wind from the same map.
- `?sunpath=0` stops sunlight dimming and reddening on its way through the air.
- `?hazecache=0` works out Earth's haze (how much the air dims the ground and the clouds, and the sunlight and moonlight it adds) for every pixel again, instead of for one point in every 4 × 4 pixels and filled in between (`app/hazeCache.ts`); the edge of the disc, the low Sun's and Moon's bands and anything near grazing are always worked out per pixel, and so is the whole of a disc too small for the points to pay (about half a million scene pixels). DEV `?hazecachediv=<n>` uses one point per n × n pixels, `?hazeexact=<grazing>,<scale>` moves where the per-pixel band starts (0.7) and scales the margin around the low-Sun band (1), `?hazecache32f=1` stores the points at full float precision, `?hazeprobe=1` adds the checks the tests use (the readout and the per-pixel probes; leave it off when timing), and `__moon.perfArm('haze-cache', …)` turns it off and on live.
- `?mieexact=0` works out the green and blue of the haze around the Sun from the rest of the sky's colour again, instead of reading them from their own table (`world/atmosphereLut.ts`). It shows most in the low orange band of a twilight limb.
- `?seabeam=0`, `?seacolour=0`, `?seasky=0`, `?seaaxis=0` and `?whitecaps=0` return the sun's reflection on the sea, the sea's colour, the sky's reflection in it and the reflection's round shape (instead of stretched along the wind) to how they were, and take the whitecaps off a windy sea. DEV `?foam=0.30` draws the whitecaps' foam at that reflectance instead of 0.22.
- `?glintmeter=0` stops the camera darkening for the sun's reflection on the sea (`planetarium/highlightMeter.ts`).
- `?bloomknee=0` returns the glow around bright spots to how it was (`app/bloomConfig.ts`).
- `?cloudshadows=0`, `?cloudlight=0` and `?cloudtiles=0` turn off cloud shadows, cloud lighting and the sharp cloud tiles (`world/cloudField.ts` for the tiles). DEV `?cloudpoolfail=1` pretends the cloud tiles ran out of memory.
- DEV tuning: `?glint=<roughness>[,<scale>[,<cap>]]` for one sea roughness, `?seawindmap=<url>` for another wind map (a picture with the speed in red and the axis in green and blue, as `gen:seawind --png` writes it; a grey picture or raw bytes is the speed alone), `?seawindmips=0` to read the wind map at full detail at every distance, `?haze=<0..1>[,<0..1>]` for how much haze shows straight down and, after the comma, toward the rim, `?aerosol=<amount>` for the air's dust and salt (`world/atmosphereModel.ts`), `?airfade=<seconds>` for how long the air takes to come in once its tables are ready (8 by default, 0 for all at once).

Night, lens and flight
- `?nightexposure=0` turns off the dimming of night sides while daylight is in view (`world/nightExposure.ts`). `?nightsides=real|brightened` starts with that Night sides setting.
- `?ride=0` stops the ship riding along with a nearby planet (`planetarium/rideFrame.ts`).
- `?orbitanchor=0` draws orbit lines the old way (`planetarium/orbitLineAnchor.ts`).
- `?lookdrag=eyepiece` makes dragging in the Observatory move the view like an eyepiece (`planetarium/surfaceView.ts`).

## Console helpers

On the dev server, `window.__moon` drives the app from the console or a test script, so nobody clicks by hand. Each helper is commented where it is defined, in `src/main.ts`.

- Camera and clock: `jumpTo`, `travelTo` (a real trip, with the loading veil), `frame` (camera only), `setTimeMs`, `setTimeRate`, `horizonView`, `pinCapture`, `readScene`.
- Landing and flight: `land`, `openObservatory`, `setSheetPark` (the phone sheet: `'peek'`, `'full'` or a height in px), `lookUp`, `lookAt`, `jumpEvent`, `exitSurface`, `probeLanded`, `pilotTo`, `rideState`, `traceStart`, `traceStop`.
- Hiding things: `setChrome`, `setShipVisible`, `setBeltVisible`, `setRoleHidden`, `atmoTier`.
- The tools: `compare…` and `interior…`. A screenshot of Look inside waits for `interiorReady()`.
- Look tuning: `setDither`, `glint`, `glintMeter`, `glintTwin` (the meter's prediction of the beam at given ground points), `haze`, `aerosol`, `sunLight`, `albedoGrade`, `cloudShadow`, `cloudLight`, `cloudField`, `nightSides`, `nightExposure`.
- Speed: `quality`, `setQuality`, `setFps`, `upscale`, `pinRatio`, `perfTargets`, `gpuProfile`, `drawLog`, `waitForDraw`. `hazeCache` reports the haze cache's size and settings (with the part of the screen it drew and why it skipped), takes `{ minRegionPx }` to move the smallest disc it draws for (0 draws it at every size) and `{ poison: true }` to fill what it did not draw with magenta, so a pixel that read it would show, and, on a page opened with `?hazeprobe=1`, with `{ coverage: true }` how much of Earth it covered and why the rest was worked out per pixel; `{ diag: 'all' }` paints those reasons instead of the picture. `glass` says who blurs the panels, where they are and what the scans cost; `glassScanBench` times the scans. `perfSwitches` and `perfArm` come from `app/perfSwitches.ts`, `perfRun` from `app/devPerfSweep.ts`.
- State: `viewport`, `sectors`, `renderPath`, `miniState`, `samplerCensus`, `atmoState`.
- Atmosphere tables: `atmoBake` bakes a set to measure, and `atmoSample` reads table values back. Its kinds are `transmittance`, `scattering`, `mieColour` (the haze's green and blue, beside the red the `scattering` texel keeps), `combined` and `irradiance`.
