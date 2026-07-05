---
name: headless-webgl-screenshots
description: >-
  Render and screenshot a WebGL / Three.js / <canvas> web app from a headless browser (Playwright or
  Puppeteer driving Chromium) using the machine's real GPU instead of slow software rasterization. Reach
  for this whenever you need to capture frames of a 3D / graphics-heavy web app programmatically — for
  visual self-review, before/after comparisons, regression snapshots, or automated QA — and ESPECIALLY
  when headless captures come out black, render painfully slowly, or peg every CPU core and overheat the
  machine (the tell-tale sign of software rendering). Also use it when someone asks how to make headless
  Chromium use the GPU, why their browser/screenshot tests cook the laptop, or how to drive a live WebGL
  app into a known state before capturing a frame. Don't hand-roll this from scratch — start here.
---

# Headless WebGL screenshots with real GPU rendering

Capturing frames of a WebGL / Three.js / `<canvas>` app from a headless browser is the reliable way to
give an agent (or a CI job) *eyes* on a graphics app — for visual review, before/after comparisons, or
regression snapshots. The trap that wastes the most time: headless browsers default to **software**
rendering for WebGL, which is slow, can come out black, and pins every CPU core. The fix is to point the
browser at the real GPU. This skill is the distilled how, and the why behind it.

A note on trust: the concrete flags and tool names below are **what worked on one setup**, not gospel.
Treat them as a starting hypothesis to verify on the machine in front of you. The *principles* travel;
the exact incantations shift with OS, GPU, browser build, and driver version. Lean on the verification
loop, not on memorizing a magic flag string.

## Why headless WebGL is slow or black by default

A headless browser usually has no window-server / display context, so it falls back to a software GL
implementation (Chromium ships **SwiftShader**). Software rendering:

- runs the whole GPU pipeline — shaders, post-processing, every frame — on the CPU, so an ordinary 60fps
  WebGL loop saturates several cores and heats the machine;
- is much slower per frame;
- occasionally produces black frames when the context fails to come up.

It is, however, usually *correct*: SwiftShader and the GPU tend to render near-identically. So software
rendering is a fine **fallback** — just an expensive default. One throwaway frame where you don't care
about speed or heat? It may be all you need. Capturing many frames, iterating, or hearing the fans spin?
Switch to the GPU.

## Getting the GPU: ANGLE backends

Modern Chromium reaches GPUs through **ANGLE**, which has a backend per platform — Metal on macOS,
Vulkan/GL on Linux, D3D on Windows. The move is to *stop forcing SwiftShader*, select the platform's GPU
backend instead, and then confirm it actually engaged.

A launch-args set that produced real GPU rendering in headless Chromium on macOS:

```
--use-gl=angle
--use-angle=metal
--enable-gpu
--ignore-gpu-blocklist
```

The software fallback that essentially always works:

```
--use-gl=angle
--use-angle=swiftshader
--enable-unsafe-swiftshader
```

On Linux, try `--use-angle=vulkan` (or `gl`); on Windows, `--use-angle=d3d11`. Recent Chromium's "new
headless" mode (`--headless=new`, often already the default in current Playwright/Puppeteer) supports the
GPU far better than legacy headless — if the GPU refuses to engage, check which headless mode you're on
before fiddling with more flags.

Don't over-trust any single list. Launch, capture, check — then keep what survives.

## Verify it actually rendered on the GPU

Low CPU usage is necessary but not sufficient: black frames are *also* cheap. Confirm two separate things.

1. **It rendered at all.** Capture a frame and look at the pixels — is the scene there, or a black
   rectangle? An agent can read the PNG back and judge it; CI can assert the image isn't a single flat
   color.
2. **The GPU did the work.** Compare CPU time / load against the software path on the same capture. A
   sharp drop (say, several cores pegged → comfortably under one) means rasterization moved to the GPU.
   The browser's `chrome://gpu` data or GPU-process logs can name the backend, but the CPU delta plus a
   correct image is the pragmatic signal.

If the GPU path returns black or errors out, fall back to software and move on. A correct slow capture
beats a fast black one every time.

## Capturing the frame reliably

- **Continuous render loops don't need `preserveDrawingBuffer`.** If the app re-renders every animation
  frame (most do), the compositor always has a fresh frame to grab, so a normal page/element screenshot
  captures it. You only need `preserveDrawingBuffer: true` for apps that draw once and stop.
- **Settle before you shoot.** Wait for textures/assets to finish loading and let a couple of animation
  frames run (e.g., await two `requestAnimationFrame`s) so you capture the settled frame, not a
  half-loaded flash.
- **Pin the viewport** to the aspect you want and fix `deviceScaleFactor` for predictable output size.

## Drive the app to a known state — don't script the UI

A deterministic capture usually needs the app in a specific state: a particular view, camera angle, date,
or selection. Clicking through the real UI from outside is brittle — it breaks the moment a layout shifts.
The robust pattern is to have the app **expose a small control surface** the harness can call directly —
a handful of functions hung on `window` behind a dev/build flag — to set state without touching the DOM:
move the camera, set the clock, hide HUD/labels/chrome so only the subject is framed. The harness sets
state, then captures.

Keep that surface dev-only (gate it on a build or env flag) so it never ships to production.

## A pragmatic loop

1. Start the app — dev server or built bundle.
2. Launch headless Chromium via Playwright **or** Puppeteer; either is fine, the GPU question is identical.
3. Try the GPU args, navigate, and wait for the app's own "ready" signal.
4. Drive to the target state through the app's dev hook; settle a couple of frames.
5. Capture, then **read the image back** to confirm it's real.
6. If it's black or errored, relaunch with the software fallback.

## This repo's harness (the Planetarium)

Two pieces work together — reach for them before hand-rolling anything.

**`tools/shoot.mjs`** — the Playwright harness. Launches headless Chromium on the GPU by default with the
ANGLE/Metal flags above (`--software` drops to SwiftShader if the GPU path returns black), drives the app
through `window.__moon` (no UI clicking), hides chrome, settles two `requestAnimationFrame`s, and writes
one PNG per body to `/tmp/moon-shots/<label>/`. Run it:

```
node tools/shoot.mjs --label=mycheck --bodies=Earth,Jupiter --fill=0.6
node tools/shoot.mjs --label=crescent --phase=145          # back-lit crescent
node tools/shoot.mjs --time=2026-07-14T00:00:00Z --fill=0.85
```

Flags: `--label`, `--bodies`, `--time` (ISO), `--fill` (disc fraction), `--phase` (0 lit … ~145 back-lit),
`--w`/`--h`, `--settle`, `--url`, `--software`. Switching SwiftShader→ANGLE/Metal here cut CPU ~15×
(≈49s → ≈3s per run) with pixel-identical output.

**`window.__moon`** — the dev-only control bridge it drives (installed in `src/main.ts`, dead-code-eliminated
from prod). Also callable straight from the browser console under `npm run dev`:

| method | does |
|---|---|
| `ready()` | solar system loaded? |
| `bodies()` | list top-level planet names |
| `jumpTo(name, distMult)` | cruise-jump near a planet (top-level planets only — returns false for moons) |
| `frame(name, fill, phaseDeg)` | pose camera on a planet or moon to a fill fraction (phase 0 = lit, ~145 = crescent) |
| `probe(name)` | camera/body diagnostics — planets from the world map, moons resolved live from the ephemeris (includes distance-to-body and distance-to-parent, for arrival QA) |
| `land(name)` | land on a body — the real landed pipeline, not a camera pose |
| `openObservatory()` | open the Observatory panel on the landed body |
| `lookUp()` / `lookAt(name)` | enter surface view (default target / named target; re-points if already in view) |
| `swapVantage()` | swap to the companion vantage |
| `jumpEvent(kind, dir)` | jump the clock to the next (`1`) / previous (`-1`) Observatory event; kinds `'full-moon' \| 'new-moon' \| 'lunar-eclipse' \| 'solar-eclipse'` |
| `exitSurface()` | leave surface view |
| `probeLanded()` | landed/surface-state diagnostics |
| `setChrome(bool)` | hide ship / HUD / labels / orbit lines |
| `setFov(deg)` · `setTimeMs(ms)` · `getTimeMs()` | FOV / clock |

## Before/after is the core loop for this app

Most visual work here is *tuning* — textures, shaders, lighting, atmosphere, relief. The reliable way to
judge it is **two screenshots of the identical view, one before the change and one after**, composited
side by side so you see exactly what got better or worse. Hold everything else fixed (same body, `--time`,
`--fill`, `--phase`, viewport) so your change is the only variable.

- Texture/shader tweak, same code: re-run the same `--label` before and after; compare the PNGs.
- Comparing two *code* states: run a second dev server from a clean `git worktree` on another port
  (`npm run dev -- --port 5175 --strictPort`), capture both, composite. A 2× zoom crop of the region of
  interest makes subtle differences legible.
- Lighting / relief / normal-map effects are **phase-dependent** — capture at a `--phase` angle or near the
  terminator, not just phase 0 (sun behind camera), or you'll under-see them.

## Gotchas (learned the hard way)

- **Copy `shoot.mjs`'s launch line for ANY ad-hoc capture.** A bare `chromium.launch()` with no args is
  software-rendered — slow, fan-pegging, sometimes black. The GPU flags are the ~15× saving regardless of
  how you drive the app.
- **`__moon.frame()` is `devFrameBody` (a camera-posing path), not the landed/Observatory framing
  (`applyLandedTarget`).** To exercise landed-mode changes drive the real pipeline —
  `land(name)` → `openObservatory()` → `lookUp()`/`lookAt(name)` — and assert state with
  `probeLanded()`; `frame()` alone won't route through that code.
- **Put ad-hoc Playwright scripts in `tools/` (or another in-repo dir), not `/tmp`.** ESM resolves
  `node_modules` relative to the script file, so a `/tmp` script fails `ERR_MODULE_NOT_FOUND`. Write it
  under `tools/` (or `planning/`, which is gitignored scratch), run, then delete — or promote it
  into the `tools/` kit if it earns its keep.
- **Pick the time for rotation.** `frame()` lights the sub-solar face, which depends on the clock — to see
  a specific hemisphere (e.g. Pluto's far side) set `--time` so it faces the camera, or sweep several times
  and pick the best.
- **Clear storage in the init script** so the "Welcome back" resume prompt never blocks the scene. It fires
  whenever `PlanetariumStore` finds a saved journey, and `setChrome` doesn't hide it (the scene sits unentered
  behind it). `localStorage.clear()` + `sessionStorage.clear()` + `indexedDB.deleteDatabase('orbital-sim-storage')`
  in `addInitScript` → `?auto=planetarium` lands straight in the flythrough. Don't click the modal.
