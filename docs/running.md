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
- `?dither=0` turns off the fine fixed grain added wherever the picture is stored in 8 bits (`app/outputDither.ts`); without it, dark gradients show steps.
- `?alloc=0`, `?gpuclock=0` and `?rungmemory=0` turn off three parts of the Dynamic quality level: its fixed memory, its GPU timer and its memory of the last good level (`app/sceneSubRect.ts`, `app/gpuFrameClock.ts`, `app/rungMemory.ts`).
- DEV `?envelope=<MiB>` gives the app a phone's memory limit. DEV `?perfoff=<names>` starts with speed-ups off (`app/perfSwitches.ts`). DEV `?perf=1` opens the speed-measuring overlay (see `docs/testing.md`).

Ground and map tiles
- `?sectors=0` turns off the detailed map tiles. `?groundcull=0` draws the ground hidden under them again (`world/groundCull.ts`).
- `?tilebytes=0` uploads tiles the old way. `?synth=0` turns off the extra close-up surface detail.
- DEV `?tiles=<url>` loads tiles from another address.

Earth's sea, air and clouds (in `world/surfaceShading.ts` unless named)
- `?seawind=0` gives the whole sea one roughness instead of the wind maps (`world/seaWind.ts`).
- `?sunpath=0` stops sunlight dimming and reddening on its way through the air.
- `?seabeam=0`, `?seacolour=0` and `?seasky=0` return the sun's reflection on the sea, the sea's colour and the sky's reflection in it to how they were.
- `?glintmeter=0` stops the camera darkening for the sun's reflection on the sea (`planetarium/highlightMeter.ts`).
- `?bloomknee=0` returns the glow around bright spots to how it was (`app/bloomConfig.ts`).
- `?cloudshadows=0`, `?cloudlight=0` and `?cloudtiles=0` turn off cloud shadows, cloud lighting and the sharp cloud tiles (`world/cloudField.ts` for the tiles). DEV `?cloudpoolfail=1` pretends the cloud tiles ran out of memory.
- DEV tuning: `?glint=` for sea roughness, `?seawindmap=<url>` for another wind map, `?seawindmips=0` to read the wind maps at full detail at every distance, `?haze=<0..1>` for how much haze shows, `?aerosol=<amount>` for the air's dust and salt (`world/atmosphereModel.ts`).

Night, lens and flight
- `?nightexposure=0` turns off the dimming of night sides while daylight is in view (`world/nightExposure.ts`). `?nightsides=real|brightened` starts with that Night sides setting.
- `?ride=0` stops the ship riding along with a nearby planet (`planetarium/rideFrame.ts`).
- `?orbitanchor=0` draws orbit lines the old way (`planetarium/orbitLineAnchor.ts`).
- `?lookdrag=eyepiece` makes dragging in the Observatory move the view like an eyepiece (`planetarium/surfaceView.ts`).

## Console helpers

On the dev server, `window.__moon` drives the app from the console or a test script, so nobody clicks by hand. Each helper is commented where it is defined, in `src/main.ts`.

- Camera and clock: `jumpTo`, `travelTo` (a real trip, with the loading veil), `frame` (camera only), `setTimeMs`, `setTimeRate`, `horizonView`, `pinCapture`, `readScene`.
- Landing and flight: `land`, `openObservatory`, `lookUp`, `lookAt`, `jumpEvent`, `exitSurface`, `probeLanded`, `pilotTo`, `rideState`, `traceStart`, `traceStop`.
- Hiding things: `setChrome`, `setShipVisible`, `setBeltVisible`, `setRoleHidden`, `atmoTier`.
- The tools: `compare…` and `interior…`. A screenshot of Look inside waits for `interiorReady()`.
- Look tuning: `setDither`, `glint`, `glintMeter`, `haze`, `aerosol`, `sunLight`, `albedoGrade`, `cloudShadow`, `cloudLight`, `cloudField`, `nightSides`, `nightExposure`.
- Speed: `quality`, `setQuality`, `setFps`, `upscale`, `pinRatio`, `perfTargets`, `gpuProfile`, `drawLog`, `waitForDraw`. `perfSwitches` and `perfArm` come from `app/perfSwitches.ts`, `perfRun` from `app/devPerfSweep.ts`.
- State: `viewport`, `sectors`, `renderPath`, `miniState`, `samplerCensus`, `atmoState`.
