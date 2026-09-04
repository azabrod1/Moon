/**
 * App entry point. Builds the shared Three.js renderer / scene / camera rig,
 * probes GPU capability for bloom (app/gpuCapability), owns the animation
 * loop, and coordinates switching between the two modes — Planetarium (the
 * app's face) and the dormant Moon Flight mini-game (no UI entry
 * point). The legacy Moon view retired in favor of the Planetarium's
 * Observatory; `?auto=moonView` still boots the app (into the Planetarium).
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { PlanetariumMode, FIRST_PLANETARIUM_ACTIVATION_TOTAL_UNITS } from './planetarium/PlanetariumMode';
import type { ShipProfile } from './planetarium/PlayerShip';
import { LANDED_NEAR_AU } from './planetarium/landedView';
import type { MoonFlightMode } from './moonFlight/MoonFlightMode';
import type { VolumeCompareMode } from './volumeCompare/VolumeCompareMode';
import { canGPUDoBloom, halfFloatTargetSampleCounts } from './app/gpuCapability';
import { bloomPixelRatio, composerSamples, parseMsaaOverride, targetPixelRatio } from './app/renderResolution';
import { BootRenderGate } from './app/bootRenderGate';
import { BLOOM_RADIUS, PLANETARIUM_BLOOM } from './app/bloomConfig';
import { createLensPass, updateLensPass, type LensParams } from './app/LensPass';
import { applyDesignFov, LENS_DEFAULT_STRENGTH } from './shared/math/lensProjection';
import { stepExposure } from './planetarium/solarExposure';
import { loadBrightStarCatalog } from './planetarium/world/starCatalogLoader';
import { debugError, debugLog, debugWarn } from './shared/debug';
import {
  clearSurfacePerf,
  installSurfacePerfInputTracing,
  startSurfacePerf,
  stopSurfacePerf,
  surfacePerfBeginRender,
  surfacePerfEndRender,
  surfacePerfFrameStart,
  surfacePerfSnapshot,
} from './planetarium/surfacePerf';

// ================================================================
// Top-level mode
// ================================================================
type AppMode = 'planetarium' | 'moonFlight' | 'volumeCompare';
let appMode: AppMode = 'planetarium';
// switchAppMode early-returns on a same-mode call only after the first
// activation has actually run (init() enters the planetarium through it).
let appModeInitialized = false;
let planetariumMode: PlanetariumMode | null = null;
let moonFlightMode: MoonFlightMode | null = null;
let volumeCompareMode: VolumeCompareMode | null = null;
let modeSwitchInFlight = false;

// ================================================================
// Device detection (must be before renderer setup)
// ================================================================
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
// True mobile: small screen OR iOS. Touchscreen laptops keep bloom.
const isMobile = isIOS || (hasTouch && window.innerWidth <= 1024);
debugLog('Device detection', {
  isIOS,
  hasTouch,
  isMobile,
  platform: navigator.platform,
  touchPoints: navigator.maxTouchPoints,
  viewport: `${window.innerWidth}x${window.innerHeight}`,
  pixelRatio: window.devicePixelRatio,
});

// ================================================================
// Scene setup
// ================================================================
let renderer: THREE.WebGLRenderer;
try {
  renderer = new THREE.WebGLRenderer({
    // Multisamples the canvas backbuffer only, which the no-float direct path
    // and the System Map draw into. The composer path renders the scene into
    // its own target, and that target carries its own sample count
    // (buildComposer, app/renderResolution.ts).
    antialias: true,
    powerPreference: 'high-performance',
    // The orbit-line/décor stencil contract (world/orbitLineStencil.ts) needs
    // a stencil buffer on the default framebuffer for the no-float direct
    // path; the composer path carries its own (buildComposer).
    stencil: true,
  });
} catch (err) {
  debugError('Failed to create WebGL renderer', err);
  throw err;
}
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);
renderer.domElement.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  debugError('WebGL context lost');
});
renderer.domElement.addEventListener('webglcontextrestored', () => {
  debugLog('WebGL context restored');
});

// Enable bloom on any device whose GPU supports float framebuffers. `?nofloat=1`
// forces the no-float path on capable hardware so the lens correction's
// tone-map-first backbuffer resample (the path incapable GPUs take) can be
// reproduced and QA'd on a dev machine.
const useBloom = canGPUDoBloom(renderer) && !new URLSearchParams(location.search).has('nofloat');

// Multisampling for the composer's scene target (app/renderResolution.ts):
// `?msaa=0` is the kill switch on any build, the other counts are the dev
// server's A/B knob, and only counts the GPU completed and resolved for a
// half-float target are ever used (none = no samples).
const msaaOverride = parseMsaaOverride(location.search, import.meta.env.DEV);
const sceneSampleCounts = useBloom ? halfFloatTargetSampleCounts(renderer) : [];
// Where the scene target cannot multisample — a GPU that completed no
// half-float sample count (three's render-to-texture GPUs among them) or the
// `?msaa=0` kill switch — the old 1.5 supersample floor stays, so such a
// display renders as production did rather than native with no antialiasing
// at all. The no-float direct path has the backbuffer's own multisampling.
const supersampleFallback = useBloom && (sceneSampleCounts.length === 0 || msaaOverride === 0);

try {
  const gl = renderer.getContext();
  debugLog('Renderer ready', {
    shadowMap: renderer.shadowMap.enabled,
    useBloom,
    sceneSamples: getSceneTargetSamples(getTargetPixelRatio()),
    sceneSampleCounts,
    isMobile,
    glVersion: gl.getParameter(gl.VERSION),
    shadingLanguage: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
  });
} catch (err) {
  debugWarn('Unable to inspect WebGL context details', err);
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

// --- Planetarium camera ---
// Near starts at the landed value; cruise swaps in its dynamic near per frame.
const planetariumCamera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, LANDED_NEAR_AU, 200);
planetariumCamera.position.set(-0.0002, 0.0001, 0.0001);
// Lens correction (rectilinear→stereographic blend): rectilinear projection
// stretches off-axis spheres into ovals (~17% at 30° off-axis at this FOV);
// the lens pass warps that out, the camera renders at an overscan FOV so the
// warped frame's corners stay covered, and projectToScreen mirrors the warp
// for DOM overlays. designFovDeg is what the frame displays; camera.fov holds
// the overscan (applyDesignFov is the only legal fov writer). The strength
// here is a *request*: buildComposer runs the lens on the planetarium whenever
// it is asked for — inside the float/HDR composer ahead of bloom, or, on GPUs
// that can't float-render, as a final LDR resample of the tone-mapped
// backbuffer — and stores the effective value read by every consumer.
const planetariumLens: LensParams = { strength: LENS_DEFAULT_STRENGTH, designFovDeg: 60 };
planetariumCamera.userData.lens = planetariumLens;
// The requested strength survives bloom toggles; buildComposer writes the
// effective value into planetariumLens.
let lensRequestedStrength = LENS_DEFAULT_STRENGTH;

// --- Moon flight camera (own camera so near/far are independent of other modes) ---
const flightCamera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.01, 2000);

// --- Volume-compare camera (studio scale: container radius = 1 unit; near/far
// bracket the [1.7, 8] orbit distance with room for the dimmed starfield shell) ---
const vcCamera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.01, 300);

let camera: THREE.PerspectiveCamera = planetariumCamera;

// ================================================================
// Post-processing (bloom enabled based on actual GPU capability)
// ================================================================
debugLog('Post-processing config', { useBloom });

let composer: EffectComposer | null = null;
/** The composer target RenderPass draws the scene into (buildComposer). */
let sceneTarget: THREE.WebGLRenderTarget | null = null;
// Whether a frame draws the world at all: under the loading screen only on
// request, every frame once revealed, never after a boot failure
// (app/bootRenderGate.ts). The simulation runs every frame regardless.
const bootRender = new BootRenderGate();
let bloomPass: UnrealBloomPass | null = null;
let lensPass: ReturnType<typeof createLensPass> | null = null;
let directLensTexture: THREE.FramebufferTexture | null = null;
const directLensSize = new THREE.Vector2();

function ensureDirectLensTexture(): THREE.FramebufferTexture {
  renderer.getDrawingBufferSize(directLensSize);
  const width = Math.max(Math.round(directLensSize.x), 1);
  const height = Math.max(Math.round(directLensSize.y), 1);
  if (
    !directLensTexture ||
    directLensTexture.image.width !== width ||
    directLensTexture.image.height !== height
  ) {
    directLensTexture?.dispose();
    directLensTexture = new THREE.FramebufferTexture(width, height);
    directLensTexture.minFilter = THREE.LinearFilter;
    directLensTexture.magFilter = THREE.LinearFilter;
    // The default framebuffer has already been tone-mapped/encoded. Preserve
    // those display-referred bytes through the final resample; the raw lens
    // ShaderPass neither tone-maps nor adds an output-colour transform.
    directLensTexture.colorSpace = THREE.NoColorSpace;
  }
  return directLensTexture;
}

function getTargetPixelRatio(): number {
  return targetPixelRatio(window.devicePixelRatio, isMobile, supersampleFallback);
}

function getSceneTargetSamples(pixelRatio: number): number {
  // The scene target's size in device pixels, floored as GL sizes the
  // storage (a GLsizei truncates): the policy's 4K budget reads it.
  const devicePixels = Math.floor(window.innerWidth * pixelRatio) * Math.floor(window.innerHeight * pixelRatio);
  return composerSamples(pixelRatio, isMobile, devicePixels, msaaOverride, sceneSampleCounts);
}

function applyRenderResolution() {
  const pixelRatio = getTargetPixelRatio();
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (composer && sceneTarget) {
    // A page zoom, a move to another monitor or a resize across the 4K
    // budget can change the sample count: retarget it and drop the GL
    // objects so the next bind allocates the new layout (setSize alone only
    // disposes on a dimension change).
    const samples = getSceneTargetSamples(pixelRatio);
    if (sceneTarget.samples !== samples) {
      sceneTarget.samples = samples;
      sceneTarget.dispose();
    }
    composer.setPixelRatio(pixelRatio);
    composer.setSize(window.innerWidth, window.innerHeight);
    sizeBloomPass();
  }
}

// The composer sizes every pass at the scene's ratio; the bloom chain is
// re-sized afterwards at its own (app/renderResolution.ts bloomPixelRatio:
// the renderer's old floor, kept for the chain alone), so the glow keeps the
// width and the cost it had on every display.
function sizeBloomPass() {
  const ratio = bloomPixelRatio(window.devicePixelRatio, isMobile);
  bloomPass?.setSize(window.innerWidth * ratio, window.innerHeight * ratio);
}

// Bloom radius (shared across modes) and the planetarium threshold live in
// app/bloomConfig so the star-luminance invariant test shares the cutoff.
// Strength + threshold are authored per mode — the planetarium's pair as
// PLANETARIUM_BLOOM there, the other modes at their call sites: the planetarium
// diverges to BLOOM_THRESHOLD (1.0) so sub-1.0-luminance stars stay out of bloom
// near the Sun, while Moon Flight (0.85) and Volume Compare (0.92 — for its glass
// HDR glint) keep their own lower cutoffs.

// Runtime bloom enable, ANDed with the immutable hardware capability. Dev-only
// (setBloom), defaults on, session-sticky across mode switches.
let bloomRuntimeEnabled = true;
function planetariumBloomEnabled(): boolean {
  return useBloom && bloomRuntimeEnabled;
}

// Near-Sun auto-exposure. This loop is the sole renderer.toneMappingExposure
// writer (re-read by OutputPass every frame): the planetarium hands it a
// per-frame value it has already smoothed against its Sun optics (snap:true —
// re-gliding here would double-smooth the tuned response); every other mode
// renders at 1, and the dev auto lock (setAutoExposure) pins it to 1 too.
let exposureCurrent = 1;
let autoExposure = true;

function buildComposer(
  cam: THREE.Camera,
  bloom: { strength: number; threshold: number },
  enabled = useBloom,
) {
  if (composer) {
    // EffectComposer.dispose() frees only its own ping-pong targets and copy
    // pass — never the added passes. Dispose them here so the bloom pass's mip
    // targets and the output pass's material don't leak on every rebuild (each
    // camera switch). Pass.dispose() is a safe no-op for passes without state.
    for (const pass of composer.passes) pass.dispose();
    composer.dispose(); // frees both ping-pong targets, the scene target included
    composer = null;
    sceneTarget = null;
  } else {
    // The direct (no-float) path owns its lens pass outright: nothing else
    // releases the ShaderMaterial behind it when the composer is rebuilt.
    lensPass?.dispose();
  }
  lensPass = null;
  bloomPass = null; // disposed above with the composer's passes
  directLensTexture?.dispose();
  directLensTexture = null;

  // The lens correction is planetarium-only and must not be gated on bloom:
  // that would leave off-axis planets egg-shaped on GPUs without float FBOs.
  const wantsLens = cam === planetariumCamera && lensRequestedStrength > 0;

  if (!enabled && !wantsLens) {
    // Nothing to composite (a non-planetarium camera without bloom): straight
    // to canvas, the cheapest path.
    planetariumLens.strength = 0;
    applyDesignFov(planetariumCamera, planetariumLens.designFovDeg);
    return;
  }

  // No float FBO: render straight to the default framebuffer first, where
  // Three applies the normal HDR tone map, copy those display-referred bytes,
  // then lens-resample them back to screen in renderScene(). This avoids the
  // release-blocking HDR clamp caused by rendering linear light into RGBA8.
  if (wantsLens && !useBloom) {
    planetariumLens.strength = lensRequestedStrength;
    lensPass = createLensPass();
    lensPass.renderToScreen = true;
    ensureDirectLensTexture();
    applyDesignFov(planetariumCamera, planetariumLens.designFovDeg);
    return;
  }

  // Every remaining composer path is float-capable, so linear HDR survives to
  // OutputPass (with or without the runtime bloom pass enabled). The scene
  // target mirrors EffectComposer's default (half-float) plus a stencil
  // buffer for the orbit-line/décor contract (world/orbitLineStencil.ts) and,
  // on low-density displays, multisampling (app/renderResolution.ts). The
  // passes after it read only its resolved colour, so the depth and stencil
  // samples are never blitted across. setSize below sets the dimensions.
  const pixelRatio = getTargetPixelRatio();
  sceneTarget = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
    type: THREE.HalfFloatType,
    stencilBuffer: true,
    samples: getSceneTargetSamples(pixelRatio),
    resolveDepthBuffer: false,
  });
  composer = new EffectComposer(renderer, sceneTarget);
  // The composer clones the scene target for its ping-pong partner. Only
  // full-screen quads ever land there (the lens output, bloom's composite),
  // so it carries neither the samples nor the depth/stencil planes: a
  // single-sample colour buffer. renderScene keeps the scene target in the
  // read slot, the one RenderPass draws into. (Without the lens pass —
  // flight, compare — bloom's composite blends into the scene target
  // itself, so those modes resolve it twice a frame; accepted, both are
  // small scenes.)
  const partner = composer.renderTarget2;
  partner.samples = 0;
  partner.depthBuffer = false;
  partner.stencilBuffer = false;
  composer.setPixelRatio(pixelRatio);
  composer.setSize(window.innerWidth, window.innerHeight);
  composer.addPass(new RenderPass(scene, cam));

  if (wantsLens) {
    planetariumLens.strength = lensRequestedStrength;
    lensPass = createLensPass();
    composer.addPass(lensPass);
  } else {
    planetariumLens.strength = 0;
  }
  applyDesignFov(planetariumCamera, planetariumLens.designFovDeg);

  // Bloom is output-space: the lens first makes a round limb, then the blur
  // builds an isotropic PSF around those final pixels. Screen-authored scene
  // primitives pre-distort themselves into the source (lensShader.ts), so their
  // sizes also remain invariant through this ordering.
  if (enabled) {
    bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      bloom.strength,
      BLOOM_RADIUS,
      bloom.threshold,
    );
    composer.addPass(bloomPass);
    sizeBloomPass();
  }

  composer.addPass(new OutputPass());
  // The passes link their programs on their first render: have it happen
  // under the loading screen, not on the first visible frame.
  bootRender.requestCoveredRender();
}

// Dev bloom toggle: flip the runtime flag, rebuild the planetarium composer
// through the same enabled/null path, and swap the Sun halo tier so a toggled
// state matches the real hardware build. A no-op on GPUs that can't bloom.
function setPlanetariumBloom(on: boolean) {
  bloomRuntimeEnabled = on;
  const effective = planetariumBloomEnabled();
  // The shared composer is built for the live mode; rebuild it only while the
  // planetarium is showing. The flag is session-sticky, so the planetarium's
  // own rebuild picks it up on the next switch back; other modes ignore it.
  if (appMode === 'planetarium') {
    buildComposer(planetariumCamera, PLANETARIUM_BLOOM, effective);
  }
  planetariumMode?.devApplySunGlowTier(effective);
}

applyRenderResolution();
buildComposer(planetariumCamera, PLANETARIUM_BLOOM, planetariumBloomEnabled());

// Armed after first Planetarium activation: that render compiles the scene's
// shaders and uploads textures, so its duration is a startup phase of its own.
let measureNextSceneFrame = false;

// One frame of the world: the map's own scene while the map is open, else the
// composer frame plus the corner chart. The animation loop calls it through
// the boot render gate; the reveal calls it once directly.
function drawWorldFrame() {
  // The system map draws its own scene straight to the backbuffer (it owns a
  // renderer-state transaction), bypassing the world composer while open. It
  // rides the same render-timing bracket so the telemetry path stays intact.
  if (appMode === 'planetarium' && planetariumMode?.isMapOpen()) {
    const perfRender = import.meta.env.DEV
      ? surfacePerfBeginRender(renderer.info.programs?.length ?? 0, renderer.info.memory.textures)
      : null;
    // Close the telemetry span in finally so a throw inside the map render
    // can't strand it open and skew every later frame's timing.
    try {
      planetariumMode.renderMapFrame();
    } finally {
      if (import.meta.env.DEV) {
        surfacePerfEndRender(perfRender, renderer.info.programs?.length ?? 0, renderer.info.memory.textures);
      }
    }
  } else {
    renderScene(camera);
    // The corner chart draws over the finished world frame, inside its own
    // scissor rectangle and its own renderer-state transaction — so the
    // composer's targets and every pixel outside that rectangle are exactly
    // what renderScene left.
    if (appMode === 'planetarium') planetariumMode?.renderMiniChartFrame();
  }
  if (appMode === 'planetarium') planetariumMode?.noteWorldRendered();
}

// The loading screen goes: draw one frame first, so the frame under the fade
// is fresh and any program a pass still had to link is linked under the
// cover, then let every frame draw.
function revealLoadingScreen() {
  drawWorldFrame();
  bootRender.markLive();
  document.getElementById('loading-screen')?.classList.add('hidden');
}

function renderScene(cam: THREE.Camera) {
  const measuring = measureNextSceneFrame;
  if (measuring) {
    measureNextSceneFrame = false;
    performance.mark('plm:first-frame:start');
  }
  const perfRender = import.meta.env.DEV
    ? surfacePerfBeginRender(renderer.info.programs?.length ?? 0, renderer.info.memory.textures)
    : null;
  try {
    if (composer) {
      // Uniform sync every frame: dev poses change the design FOV and resizes
      // change the aspect, and a stale warp misplaces every pixel.
      if (lensPass && cam === planetariumCamera) {
        updateLensPass(lensPass, planetariumLens, planetariumCamera.fov, planetariumCamera.aspect);
      }
      // RenderPass draws the scene into the composer's read buffer. The
      // composer swaps after every swapping pass, OutputPass included, so a
      // chain with an odd number of them (flight and compare: no lens) ends
      // each frame with the pair swapped, and every fresh build starts with
      // the partner in front. Put the scene target back so the geometry gets
      // the samples, not a full-screen quad (see buildComposer).
      if (sceneTarget && composer.readBuffer !== sceneTarget) composer.swapBuffers();
      composer.render();
    } else if (lensPass && directLensTexture && cam === planetariumCamera) {
      // Tone map to the hardware backbuffer first, then copy and warp that LDR
      // image. `ShaderPass.render` only reads the fake target's texture when its
      // renderToScreen flag is set; the write target is intentionally unused.
      renderer.setRenderTarget(null);
      renderer.render(scene, cam);
      const texture = ensureDirectLensTexture();
      renderer.copyFramebufferToTexture(texture);
      updateLensPass(lensPass, planetariumLens, planetariumCamera.fov, planetariumCamera.aspect);
      lensPass.render(
        renderer,
        null as unknown as THREE.WebGLRenderTarget,
        { texture } as unknown as THREE.WebGLRenderTarget,
        0,
        false,
      );
    } else {
      renderer.render(scene, cam);
    }
  } finally {
    if (import.meta.env.DEV) {
      surfacePerfEndRender(
        perfRender,
        renderer.info.programs?.length ?? 0,
        renderer.info.memory.textures,
      );
    }
  }
  if (measuring) performance.measure('plm:first-frame', 'plm:first-frame:start');
}

/** One console line with every startup phase, once the first frame is in. */
function logStartupTimings() {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const phases = performance
      .getEntriesByType('measure')
      .filter((m) => m.name.startsWith('plm:'))
      .map((m) => `${m.name.slice(4)} ${Math.round(m.duration)}ms`);
    debugLog('Startup timings', `${phases.join(', ')} | total ${Math.round(performance.now())}ms`);
  }));
}

// ================================================================
// Top-level mode switching (Planetarium <-> Moon Flight)
// ================================================================
const planetariumUI = document.getElementById('planetarium-ui')!;
const modeTransition = document.getElementById('mode-transition')!;
const transitionMsg = document.getElementById('transition-msg')!;

function setLoadingPercentText(text: string) {
  // A failed boot's error message owns the screen: a still-running loader
  // branch (the solar system keeps fetching after the catalog gate throws)
  // must not overwrite the one instruction the user has with "…100%".
  const loadingScreen = document.getElementById('loading-screen');
  if (loadingScreen?.dataset.bootError) return;
  const loadEl = document.getElementById('loading-msg');
  if (loadEl) loadEl.textContent = text;
  transitionMsg.textContent = text;
}

function setPlanetsLoadingPercent(completedUnits: number, totalUnits: number) {
  const clampedTotalUnits = Math.max(totalUnits, 1);
  const clampedCompletedUnits = Math.min(Math.max(completedUnits, 0), clampedTotalUnits);
  const pct = Math.round((clampedCompletedUnits / clampedTotalUnits) * 100);
  setLoadingPercentText(`Loading Planets... ${pct}%`);
}

function setFlightLoadingPercent(completedUnits: number, totalUnits: number) {
  const clampedTotalUnits = Math.max(totalUnits, 1);
  const clampedCompletedUnits = Math.min(Math.max(completedUnits, 0), clampedTotalUnits);
  const pct = Math.round((clampedCompletedUnits / clampedTotalUnits) * 100);
  setLoadingPercentText(`Entering Flight... ${pct}%`);
}

async function switchAppMode(newMode: AppMode) {
  if (newMode === appMode && appModeInitialized) return;
  if (modeSwitchInFlight) return;
  modeSwitchInFlight = true;
  debugLog('Switching app mode', { from: appMode, to: newMode });

  try {
    modeTransition.classList.add('active');
    transitionMsg.textContent =
      newMode === 'planetarium' ? 'Entering Planets...'
        : newMode === 'moonFlight' ? 'Entering Flight...'
          : 'Gathering planets...';
    // The beat lets the fade-to-black actually show between two live modes.
    // On first boot the loading screen still covers everything, so the wait
    // would be 400 ms of nothing, serial, before any texture is even asked
    // for — a fifth of the whole fast-network startup.
    if (appModeInitialized) await sleep(400);

    if (newMode === 'planetarium') {
      // --- Switch to Planetarium ---
      appMode = 'planetarium';
      if (moonFlightMode) moonFlightMode.deactivate();
      if (volumeCompareMode) volumeCompareMode.deactivate();
      scene.background = new THREE.Color(0x000000);

      camera = planetariumCamera;
      applyRenderResolution();
      buildComposer(planetariumCamera, PLANETARIUM_BLOOM, planetariumBloomEnabled());

      if (!planetariumMode) {
        debugLog('Creating Planetarium mode');
        // The boot shader warm-up compiles the variant the frame actually
        // draws: into the composer's target when there is a composer, to the
        // canvas otherwise — the same branch renderScene takes.
        planetariumMode = new PlanetariumMode(scene, planetariumCamera, renderer, useBloom, () => composer !== null);
        // The ☰ "How many fit?" item arrives here: the
        // mode closes its own entry surfaces, then this callback owns the switch.
        planetariumMode.onVolumeCompareRequest(() => {
          void switchAppMode('volumeCompare');
        });
      }
      debugLog('Activating Planetarium mode');
      if (!planetariumMode.hasLoadedSolarSystem()) {
        const totalUnits = FIRST_PLANETARIUM_ACTIVATION_TOTAL_UNITS;
        setPlanetsLoadingPercent(0, totalUnits);
        await planetariumMode.activate((progress) => {
          setPlanetsLoadingPercent(progress.completedUnits, totalUnits);
        });
        measureNextSceneFrame = true;
      } else {
        await planetariumMode.activate();
      }
      debugLog('Planetarium mode active');

    } else if (newMode === 'moonFlight') {
      // --- Switch to Moon Flight ---
      appMode = 'moonFlight';
      if (planetariumMode) planetariumMode.deactivate();
      if (volumeCompareMode) volumeCompareMode.deactivate();
      planetariumUI.style.display = 'none';
      scene.background = new THREE.Color(0x000000);

      camera = flightCamera;
      applyRenderResolution();
      buildComposer(flightCamera, { strength: 1.2, threshold: 0.85 });

      // Dynamic import: flight code + future assets stay out of the initial bundle
      // until the user actually enters this mode.
      if (!moonFlightMode) {
        setFlightLoadingPercent(0, 1);
        debugLog('Loading moon flight module');
        const mod = await import('./moonFlight/MoonFlightMode');
        moonFlightMode = new mod.MoonFlightMode(scene, flightCamera, renderer);
        moonFlightMode.onExit(() => {
          void switchAppMode('planetarium');
        });
      }
      debugLog('Activating moon flight mode');
      // One clock: flight lighting reads the planetarium's simulation time.
      const entryDate = new Date(planetariumMode?.getCurrentUtcMs() ?? Date.now());
      if (!moonFlightMode.hasLoaded()) {
        await moonFlightMode.activate(entryDate, (progress) => {
          setFlightLoadingPercent(progress.completedUnits, progress.totalUnits);
        });
      } else {
        await moonFlightMode.activate(entryDate);
      }
      debugLog('Moon flight mode active');

    } else {
      // --- Switch to Volume Compare ("How many fit?") ---
      appMode = 'volumeCompare';
      if (planetariumMode) planetariumMode.deactivate();
      if (moonFlightMode) moonFlightMode.deactivate();
      // PlanetariumMode.deactivate already hides this; the explicit line keeps
      // parity with the flight branch and covers a switch from moon flight.
      planetariumUI.style.display = 'none';
      scene.background = new THREE.Color(0x000000);

      camera = vcCamera;
      applyRenderResolution();
      buildComposer(vcCamera, { strength: 0.8, threshold: 0.92 });

      // Dynamic import: the compare mode + its scene stay out of the initial
      // bundle until the user actually enters it (MoonFlight code-split parity).
      if (!volumeCompareMode) {
        debugLog('Loading volume compare module');
        const mod = await import('./volumeCompare/VolumeCompareMode');
        volumeCompareMode = new mod.VolumeCompareMode(scene, vcCamera, renderer, useBloom);
        volumeCompareMode.onExit(() => {
          void switchAppMode('planetarium');
        });
      }
      debugLog('Activating volume compare mode');
      // Session-only: every entry starts a fresh session at the default pair.
      // activate() resolves only once the default pair's textures are applied —
      // the #mode-transition veil covers the load, so nothing half-loaded shows.
      await volumeCompareMode.activate();
      debugLog('Volume compare mode active');
    }

    appModeInitialized = true;

    await sleep(100);
  } finally {
    // The veil must never strand: if a mode activation throws, the app is
    // degraded but the user can still see the scene and click their way out.
    modeTransition.classList.remove('active');
    modeSwitchInFlight = false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getAutoMode(): 'planetarium' | 'volumeCompare' {
  const params = new URLSearchParams(window.location.search);
  const auto = params.get('auto');
  // 'volumeCompare' routes into the compare mode after the Planetarium boots.
  // Everything else — 'planetarium', the retired-but-still-accepted 'moonView',
  // and absence — lands in the Planetarium.
  return auto === 'volumeCompare' ? 'volumeCompare' : 'planetarium';
}

// Dev-only bridge for the headless screenshot harness: pose the camera and set
// the clock from out of process. The call site is guarded by a DEV check, so a
// production build dead-code-eliminates this entirely.
function installDevHooks() {
  installSurfacePerfInputTracing();
  (window as any).__moon = {
    ready: () => !!planetariumMode?.hasLoadedSolarSystem(),
    bodies: () => planetariumMode?.devListBodies() ?? [],
    jumpTo: (name: string, distanceMultiplier?: number) =>
      planetariumMode?.devJumpToBody(name, distanceMultiplier) ?? false,
    frame: (
      name: string, fillFraction?: number, phaseAngleDeg?: number, distMul?: number,
      offNdcX?: number, offNdcY?: number,
    ) =>
      planetariumMode?.devFrameBody(name, fillFraction, phaseAngleDeg, distMul, offNdcX, offNdcY) ?? false,
    viewFrom: (fromName: string, toName: string, fovDeg?: number) =>
      planetariumMode?.devViewFrom(fromName, toName, fovDeg) ?? false,
    limbView: (name: string, kRadii?: number, fovDeg?: number) =>
      planetariumMode?.devLimbView(name, kRadii, fovDeg) ?? false,
    frameSun: (distanceAU?: number, fovDeg?: number, offNdcX?: number, offNdcY?: number) =>
      planetariumMode?.devFrameSun(distanceAU, fovDeg, offNdcX, offNdcY) ?? false,
    frameSunBehindShip: (
      distanceAU?: number,
      offNdcX?: number,
      offNdcY?: number,
      profile?: ShipProfile,
    ) => planetariumMode?.devFrameSunBehindShip(distanceAU, offNdcX, offNdcY, profile)
      ?? Promise.resolve(false),
    diagnosticSphere: (offNdcX?: number, offNdcY?: number, fovDeg?: number, angularRadiusDeg?: number) =>
      planetariumMode?.devFrameDiagnosticSphere(offNdcX, offNdcY, fovDeg, angularRadiusDeg) ?? false,
    // Marker-limb integration: a planet's live analytic occluder disc, ship
    // visibility, and a red marker sprite culled by the REAL analytic occlusion.
    planetOccluderDisc: (name: string) => planetariumMode?.devPlanetOccluderDisc(name) ?? null,
    setShipVisible: (visible: boolean) => planetariumMode?.devSetShipVisible(visible),
    probeLimbMarker: (screenX: number, screenY: number, depthAU: number) =>
      planetariumMode?.devProbeLimbMarker(screenX, screenY, depthAU) ?? null,
    sunAppearance: () => planetariumMode?.devSunAppearance() ?? null,
    setShipSunOcclusion: (enabled: boolean) =>
      planetariumMode?.devSetShipSunOcclusion(enabled) ?? false,
    sunGlareMask: () => planetariumMode?.devSunGlareMask() ?? null,
    eclipseDebug: () => planetariumMode?.devEclipseDebug() ?? null,
    setVeil: (opts: { warmth?: number; strength?: number }) =>
      planetariumMode?.devSetVeil(opts ?? {}) ?? false,
    setDiamondScale: (k: number) => planetariumMode?.devSetDiamondScale(k) ?? false,
    // Near-Sun auto-exposure inspection + locks (peek the mode's target/coverage,
    // never the consuming getter). setBloom rebuilds the composer + halo tier.
    exposure: () => {
      const peek = planetariumMode?.devExposurePeek();
      return {
        current: exposureCurrent,
        target: peek?.target ?? 1,
        coverage: peek?.coverage ?? 0,
        auto: autoExposure,
      };
    },
    setAutoExposure: (on: boolean) => { autoExposure = on; },
    setBloom: (on: boolean) => setPlanetariumBloom(on),
    bloomActive: () => planetariumBloomEnabled(),
    // Lens-correction A/B: pass a strength (0 = rectilinear), no args restores
    // the default. Returns the effective strength after the bloom gate.
    setLens: (strength?: number | null) => {
      lensRequestedStrength = typeof strength === 'number'
        ? Math.min(Math.max(strength, 0), 1)
        : LENS_DEFAULT_STRENGTH;
      if (appMode === 'planetarium') {
        buildComposer(planetariumCamera, PLANETARIUM_BLOOM, planetariumBloomEnabled());
      }
      return planetariumLens.strength;
    },
    probe: (name: string) => planetariumMode?.devProbe(name) ?? null,
    travelTo: (name: string) => planetariumMode?.devTravelTo(name) ?? false,
    land: (name: string) => planetariumMode?.devLand(name) ?? false,
    observe: (name: string) => planetariumMode?.devObserve(name) ?? false,
    sectors: () => planetariumMode?.devSectorStats() ?? null,
    lookUp: () => planetariumMode?.devLookUp() ?? false,
    lookAt: (name: string) => planetariumMode?.devLookAt(name) ?? false,
    exitSurface: () => planetariumMode?.devExitSurface(),
    openObservatory: () => planetariumMode?.devOpenObservatory() ?? false,
    swapVantage: () => planetariumMode?.devSwapVantage() ?? false,
    jumpEvent: (type: string, direction?: 1 | -1) =>
      planetariumMode?.devJumpEvent(type as never, direction ?? 1) ?? false,
    probeLanded: () => planetariumMode?.devProbeLanded() ?? null,
    traceStart: (name: string, maxFrames?: number) =>
      planetariumMode?.devTraceStart(name, maxFrames) ?? false,
    traceStop: () => planetariumMode?.devTraceStop() ?? null,
    setMoonSizeGamma: (gamma: number | null) => planetariumMode?.devSetMoonSizeGamma(gamma),
    setMoonDotParams: (partial: Record<string, unknown> | null) =>
      planetariumMode?.devSetMoonDotParams(partial as never),
    setMoonLabelPlacementParams: (partial: Record<string, unknown> | null) =>
      planetariumMode?.devSetMoonLabelPlacementParams(partial as never),
    tutorialStart: () => planetariumMode?.devTutorialStart() ?? false,
    tutorialNext: () => planetariumMode?.devTutorialNext(),
    tutorialBack: () => planetariumMode?.devTutorialBack(),
    tutorialSkip: () => planetariumMode?.devTutorialSkip(),
    tutorialState: () => planetariumMode?.devTutorialState() ?? null,
    openMap: () => planetariumMode?.devOpenMap() ?? false,
    closeMap: () => planetariumMode?.devCloseMap() ?? false,
    mapState: () => planetariumMode?.devMapState() ?? null,
    mapPick: (name: string) => planetariumMode?.devMapPick(name) ?? false,
    mapProbe: (name: string) => planetariumMode?.devMapProbe(name) ?? null,
    mapMoonStats: () => planetariumMode?.devMapMoonStats() ?? null,
    setMapMoonOffset: (partial: Record<string, number> | null) =>
      planetariumMode?.devSetMapMoonOffset(partial) ?? false,
    mapCommit: (verb: 'travel' | 'observe' | 'pilot') => planetariumMode?.devMapCommit(verb) ?? false,
    // Teleport anywhere: mapTeleportAt runs the gesture at a canvas pixel (a
    // right-click / a matured long press), mapTeleportState reads the offer,
    // and the pair below are the chip's own two answers.
    mapTeleportAt: (xPx: number, yPx: number) => planetariumMode?.devMapTeleportAt(xPx, yPx) ?? null,
    mapTeleportState: () => planetariumMode?.devMapTeleportState() ?? null,
    mapTeleportCommit: () => planetariumMode?.devMapTeleportCommit() ?? false,
    mapTeleportDismiss: () => planetariumMode?.devMapTeleportDismiss(),
    // The corner chart: the ☰ toggle, the opaque/over-the-world A/B, and what
    // it costs per frame.
    setMiniChart: (on: boolean) => planetariumMode?.devSetMiniChart(on),
    setMiniOpaque: (opaque: boolean) => planetariumMode?.devSetMiniOpaque(opaque),
    miniState: () => planetariumMode?.devMiniState() ?? null,
    // Fly to a body and follow it; null flies back out to the overview.
    mapFocus: (name: string | null) => planetariumMode?.devMapFocus(name) ?? false,
    // The panel's rows. mapOverview is the combined release-or-recentre, which
    // resolves to a 900 ms flight when there is a focus to give back — poll
    // mapState().camState for the landing. mapInfo drives the gesture guide;
    // mapPanel reads or drives the panel itself ({collapsed, helpOpen}, null
    // for the defaults) and reports sheetExpanded for the phone layout.
    mapOverview: () => planetariumMode?.devMapOverview() ?? false,
    mapInfo: (open: boolean) => planetariumMode?.devMapInfo(open) ?? false,
    mapPanel: (partial?: { collapsed?: boolean; helpOpen?: boolean } | null) =>
      planetariumMode?.devMapPanel(partial) ?? null,
    // Map curve A/B: setMapS picks the asinh curve with that softening scale
    // (AU), setMapGamma the power law with that exponent. Both leave the
    // Compressed/True blend alone and hold the framing across the swap.
    setMapS: (s: number) => planetariumMode?.devSetMapS(s),
    setMapGamma: (g: number) => planetariumMode?.devSetMapGamma(g),
    setMapBodySize: (partial: Record<string, number> | null) =>
      planetariumMode?.devSetMapBodySize(partial as never),
    setMapSunSize: (partial: Record<string, number> | null) =>
      planetariumMode?.devSetMapSunSize(partial as never),
    setMapMarkerZoom: (partial: Record<string, number> | null) =>
      planetariumMode?.devSetMapMarkerZoom(partial as never),
    // The chart's star backdrop: false/true toggles, {alphaMul, sizeMul}
    // retunes live, null restores defaults. Returns what is now in force.
    setMapStars: (arg: boolean | Record<string, number> | null) =>
      planetariumMode?.devSetMapStars(arg as never) ?? null,
    // The orbit lines: {opacity, brightness} retunes live, null restores.
    setMapOrbitStyle: (partial: Record<string, number> | null) =>
      planetariumMode?.devSetMapOrbitStyle(partial as never) ?? null,
    // The chart's layer switches — {orbitLines, bodyLabels, ambientMoons,
    // constellations, distanceRings}; null restores the defaults. Writes the
    // session state whether or not the map is open, and reaches the chart only
    // while it is (a closed chart is on the defaults, and the corner chart
    // draws the same objects). mapState().layers reads it back.
    setMapLayers: (partial: Record<string, boolean> | null) =>
      planetariumMode?.devSetMapLayers(partial as never) ?? null,
    setChrome: (visible: boolean) => planetariumMode?.devSetChrome(visible),
    setFov: (deg: number) => planetariumMode?.devSetFov(deg),
    setTimeMs: (utcMs: number) => planetariumMode?.setCurrentUtcMs(utcMs),
    getTimeMs: () => planetariumMode?.getCurrentUtcMs() ?? 0,
    setTimeRate: (rate: number) => planetariumMode?.setTimeRate(rate),
    setTimePaused: (paused: boolean) => planetariumMode?.setTimePaused(paused),
    // Volume-compare bridge. compareOpen routes through the Planetarium's real
    // entry gate (snapshot capture + tutorial/mission refusal), so a test sees the
    // same landed-state preservation a user does; the rest delegate to the live
    // instance (null before first entry).
    compareOpen: () => planetariumMode?.devEnterVolumeCompare(),
    compareExit: () => volumeCompareMode?.devExit(),
    comparePick: (container: string, filler: string) =>
      volumeCompareMode?.devPick(container, filler) ?? false,
    compareState: () => volumeCompareMode?.devState() ?? null,
    compareScatter: (n: number) => volumeCompareMode?.devScatter(n) ?? false,
    compareFreezeTime: (on: boolean) => volumeCompareMode?.devFreezeTime(on) ?? false,
    compareOrbit: (azimuthDeg: number, elevationDeg?: number) =>
      volumeCompareMode?.devOrbit(azimuthDeg, elevationDeg) ?? false,
    // The pour (P3): slider, presets, melt, auto-melt, reset, Esc cascade, end card.
    compareSlider: (f: number) => volumeCompareMode?.devSlider(f) ?? false,
    compareMelt: () => volumeCompareMode?.devMelt() ?? false,
    compareAutoMelt: (on: boolean) => volumeCompareMode?.devAutoMelt(on) ?? false,
    comparePreset: (key: string) => volumeCompareMode?.devPreset(key) ?? false,
    compareReset: () => volumeCompareMode?.devReset() ?? false,
    compareSkip: () => volumeCompareMode?.devSkip() ?? false,
    compareEsc: () => volumeCompareMode?.devEsc(),
    compareEndCard: () => volumeCompareMode?.devEndCard() ?? null,
    // Raw scene handle for render forensics (visibility bisects: hide one
    // element at a time to isolate what's flashing/leaking light). DEV-only
    // like the rest of the bridge.
    scene: () => scene,
    // Composer pass list for post-pass forensics (patch a pass's shader or
    // uniforms in-page and re-render, no rebuild). Null while a mode bypasses
    // the composer.
    composerPasses: () => composer?.passes ?? null,
    // Mode-agnostic leak probe for the enter/exit heap check.
    // Boot render gate state + frames drawn under the loading screen.
    bootRender: () => ({ state: bootRender.current, coveredRenders: bootRender.coveredRenders }),
    rendererInfo: () => ({
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      programs: renderer.info.programs?.length ?? 0,
      exposure: renderer.toneMappingExposure,
      pixelRatio: renderer.getPixelRatio(),
      sceneSamples: sceneTarget?.samples ?? 0,
    }),
    // Low-overhead Surface timing ring buffer. Usage:
    //   surfacePerf('start') → reproduce → surfacePerf() / surfacePerf('stop')
    surfacePerf: (command: 'start' | 'stop' | 'clear' | 'snapshot' = 'snapshot') => {
      if (command === 'clear') {
        clearSurfacePerf();
        return null;
      }
      if (command === 'stop') return stopSurfacePerf();
      if (command === 'start') {
        const drawingBuffer = renderer.getDrawingBufferSize(new THREE.Vector2());
        return startSurfacePerf({
          userAgent: navigator.userAgent,
          visibilityState: document.visibilityState,
          hasFocus: document.hasFocus(),
          bloom: planetariumBloomEnabled(),
          parallelShaderCompile: !!renderer.getContext().getExtension('KHR_parallel_shader_compile'),
          viewport: `${window.innerWidth}x${window.innerHeight}`,
          drawingBuffer: `${drawingBuffer.x}x${drawingBuffer.y}`,
          pixelRatio: renderer.getPixelRatio(),
          maxTextureSize: renderer.capabilities.maxTextureSize,
          programs: renderer.info.programs?.length ?? 0,
          textures: renderer.info.memory.textures,
        });
      }
      return surfacePerfSnapshot();
    },
  };
  if (new URLSearchParams(window.location.search).get('surfacePerf') === '1') {
    (window as any).__moon.surfacePerf('start');
  }
  debugLog('Dev hooks installed (window.__moon)');
}

// ================================================================
// Main init
// ================================================================
async function init() {
  (window as any).__initStarted = true;
  debugLog('Init started');
  // The service-worker kill switch runs before ANYTHING else: it exists for
  // the boots where something SW-served is broken, so it cannot wait for a
  // boot to succeed. True = a shedding reload is on its way; stop here.
  if (await shedServiceWorkerIfRequested()) return;
  // Start the star-catalog sidecar load now so its fetch+parse overlap the
  // solar-system build; PlanetariumMode.activate awaits the same shared
  // promise (and surfaces the real error — this kick must not double-report,
  // and an unguarded early rejection would leak as unhandled).
  loadBrightStarCatalog().catch(() => {});
  // Build identity in the menu footer: lets anyone confirm which deploy a
  // device is actually running (cached phone tabs have repeatedly shown
  // days-old bundles while looking current). It rides with the debug overlay
  // rather than the normal menu — a build sha is diagnostic gear, not
  // something to hand every visitor. Add ?debug=1 to bring it back.
  const buildEl = document.getElementById('menu-build');
  if (buildEl && window.__dbgEnabled) {
    buildEl.textContent = `build ${__BUILD_TAG__}`;
    buildEl.style.display = 'block';
  }

  let lastTime = performance.now();

  function animate(rafTimestamp = performance.now()) {
    requestAnimationFrame(animate);
    if (import.meta.env.DEV) surfacePerfFrameStart(rafTimestamp);
    // Drift poll on a countdown: innerWidth/innerHeight are cheap but not
    // free at once-per-frame, and the events below re-arm an immediate check
    // for every transition that announces itself (visualViewport covers the
    // iOS URL-bar and keyboard moves). The poll survives only for a
    // transition that emits nothing at all; every third frame caps that
    // worst case at two extra stale-aspect frames over the old per-frame
    // check — a stale aspect held for good is the failure that matters.
    if (viewportCheckDirty || --viewportCheckCountdown <= 0) {
      viewportCheckDirty = false;
      viewportCheckCountdown = 3;
      syncViewportIfDrifted();
    }
    const now = performance.now();
    const rawDt = (now - lastTime) / 1000;
    const dt = Math.min(rawDt, 0.1); // cap at 100ms to avoid huge jumps
    // Exposure adaptation glides on the raw wall delta, not the sim-capped dt:
    // the eye should adapt by a frame's real duration even through a hitch.
    const wallDt = rawDt;
    lastTime = now;

    if (appMode === 'planetarium' && planetariumMode) {
      planetariumMode.update(dt);
      if (autoExposure) {
        const { value, snap } = planetariumMode.takeExposureTarget();
        exposureCurrent = snap ? value : stepExposure(exposureCurrent, value, wallDt);
      } else {
        exposureCurrent = 1;
      }
    } else if (appMode === 'moonFlight' && moonFlightMode) {
      moonFlightMode.update(dt);
      exposureCurrent = 1; // other modes render neutral; the veil covers the reset
    } else if (appMode === 'volumeCompare' && volumeCompareMode) {
      volumeCompareMode.update(dt);
      exposureCurrent = 1;
    }

    renderer.toneMappingExposure = exposureCurrent;
    if (bootRender.shouldRender()) drawWorldFrame();
  }

  animate();
  debugLog('Animation loop started');

  // Install the diagnostic bridge before the async Planetarium load. This is
  // deliberately early: an entry stall can overlap the last texture-loading
  // unit, and the profiler must remain usable while `ready()` is still false.
  if (import.meta.env.DEV) installDevHooks();

  const autoMode = getAutoMode();
  debugLog('Boot mode', { autoMode });
  // The Planetarium always boots first — it owns the saves, the catalog, and
  // the veil semantics — then ?auto=volumeCompare routes on into the compare mode.
  await switchAppMode('planetarium');
  logStartupTimings();

  revealLoadingScreen();
  // Boot is settled — now the data service worker may install (its precache
  // revalidates against the HTTP cache the boot just filled, so this order
  // makes install nearly free instead of competing with boot fetches).
  registerServiceWorker();
  await planetariumMode?.showDeferredResumePromptIfNeeded();

  if (autoMode === 'volumeCompare') {
    // The fast path stays, but a boot that resumed into a tutorial must not switch
    // away — the tutorial owns the scene and holds a live pre-tutorial snapshot
    // that deactivating for the tool would strand. Ignore the param in that case.
    if (planetariumMode?.isTutorialActive()) {
      debugLog('?auto=volumeCompare ignored — a tutorial owns the scene');
    } else {
      await switchAppMode('volumeCompare');
    }
  }
}

// ================================================================
// Viewport sync
// ================================================================
// The dimensions the cameras/renderer were last synced to. The per-frame
// drift check below compares live viewport values against these, so viewport
// changes that never deliver a resize event still get applied.
let appliedViewportW = window.innerWidth;
let appliedViewportH = window.innerHeight;

function syncViewport() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (w === 0 || h === 0) return; // hidden/backgrounded states can report zeros
  appliedViewportW = w;
  appliedViewportH = h;
  planetariumCamera.aspect = w / h;
  // Re-derives the lens overscan for the new aspect (and calls
  // updateProjectionMatrix); the corner coverage is aspect-dependent.
  applyDesignFov(planetariumCamera, planetariumLens.designFovDeg);
  flightCamera.aspect = w / h;
  flightCamera.updateProjectionMatrix();
  vcCamera.aspect = w / h;
  vcCamera.updateProjectionMatrix();
  moonFlightMode?.onResize(w / h);
  applyRenderResolution();
  // After the renderer's pixel ratio is (re)applied: retune star point sizes,
  // which are scaled by the renderer's ratio — both the compare and planetarium
  // starfields read renderer.getPixelRatio() in onResize, so they must run after.
  volumeCompareMode?.onResize(w / h);
  planetariumMode?.onResize();
  debugLog('Resize', { width: w, height: h, pixelRatio: renderer.getPixelRatio(), sceneSamples: sceneTarget?.samples ?? 0 });
}

window.addEventListener('resize', syncViewport);

// Viewport transitions that DO announce themselves pull the drift poll
// forward to the next frame (the poll itself runs on a countdown in
// animate()). visualViewport fires for iOS URL-bar/keyboard moves that the
// window resize event misses; visibility return covers a rotation that
// happened while the tab slept.
let viewportCheckDirty = false;
let viewportCheckCountdown = 0;
const armViewportCheck = () => { viewportCheckDirty = true; };
window.addEventListener('orientationchange', armViewportCheck);
window.visualViewport?.addEventListener('resize', armViewportCheck);
document.addEventListener('visibilitychange', armViewportCheck);

// A mouse click leaves the pressed button focused, and the browser then turns
// the next Space press into a re-fire of that button — so "click Faster, hit
// Space to pause" sped time up again instead of pausing (the window Space
// handlers must ignore focused buttons or every Space would double-fire).
// Pointer users get nothing from the retained focus; drop it after the click.
// Keyboard activations report detail 0 and keep focus for tab navigation.
document.addEventListener('click', (e) => {
  if (e.detail === 0) return;
  const button = (e.target as HTMLElement | null)?.closest?.('button');
  if (button && button === document.activeElement) button.blur();
});

// iOS Safari changes the viewport without a resize event this app can count
// on (URL-bar collapse on a non-scrolling page, keyboard dismissal, the
// post-rotation settle), and a camera left on a stale aspect draws every
// disc as an ellipse. A page zoom or a move to another monitor changes the
// device pixel ratio the same way, and the render resolution and the scene
// target's sample count follow it. Called from the animation loop: plain
// property reads, no layout, and the aspect term re-arms the sync even if
// some other path ever clobbers a camera.
function syncViewportIfDrifted() {
  if (
    window.innerWidth !== appliedViewportW ||
    window.innerHeight !== appliedViewportH ||
    camera.aspect !== appliedViewportW / appliedViewportH ||
    renderer.getPixelRatio() !== getTargetPixelRatio()
  ) {
    syncViewport();
  }
}

// ================================================================
// Start
// ================================================================
/**
 * ?nosw=1 — the service-worker kill switch. Unregisters the app's data
 * worker, deletes its caches, and (once, guarded) reloads to shed a
 * controller that claimed this page. Runs at the very top of init because
 * its whole reason to exist is boots where SW-served data is broken. Every
 * step tolerates failure — a broken storage layer must not take the kill
 * switch down with it. Returns true when a reload was scheduled and init
 * must stop.
 */
async function shedServiceWorkerIfRequested(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false;
  const params = new URLSearchParams(location.search);
  if (!params.has('nosw')) return false;
  debugWarn('Service worker kill switch (?nosw=1): unregistering');
  // Unregister and cache-delete are independent recoveries — one failing
  // must not take the other down with it.
  try {
    const registration = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL);
    await registration?.unregister();
  } catch (err) {
    debugError('Service worker unregister failed', err);
  }
  try {
    for (const name of await caches.keys()) {
      if (name.startsWith('moon-data-')) await caches.delete(name);
    }
  } catch (err) {
    debugError('Service worker cache delete failed', err);
  }
  if (navigator.serviceWorker.controller && !params.has('noswr')) {
    // Unregistering doesn't release the current document; one reload does.
    // The loop guard rides the URL itself (`noswr`), not storage — the kill
    // switch must work in storage-restricted contexts too, and a marker the
    // navigation carries can't loop by construction.
    params.set('noswr', '1');
    location.replace(`${location.pathname}?${params.toString()}${location.hash}`);
    return true;
  }
  return false;
}

/**
 * Register the data-only service worker (generated into dist/sw.js at
 * build — see tools/swPlugin.mjs). Detached and fully caught: it is an
 * optimization, and no failure in it may ever re-cover a working app with
 * the boot error screen. Dev is exempt — dev serves no sw.js and caching
 * would fight hot reload anyway.
 */
function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;
  if (new URLSearchParams(location.search).has('nosw')) return;
  navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js').then((registration) => {
    // register() with an unchanged script URL short-circuits without an
    // update check, and deploy pickup otherwise rides the browser's
    // navigation soft update (measured: real Chrome and WebKit do it,
    // Playwright's bundled Chromium doesn't). One explicit check per boot
    // makes "at most one deploy behind" deterministic instead of
    // browser-dependent.
    registration.update().catch(() => {});
  }).catch((err) => {
    debugWarn('Service worker registration failed', { err: String(err) });
  });
}

// Safety: a finished boot must never leave the loading screen stranded past
// 15s. Strictly a finished one — while init is still unsettled there is
// nothing behind the screen worth showing (a suspended mobile tab can resume
// with every boot timer overdue at once, and hiding then would reveal a
// half-built black scene), and after a FAILURE the screen is the error
// display. In both of those cases keep it up and check back.
let initSettled = false;
setTimeout(function forceHideCheck() {
  const ls = document.getElementById('loading-screen');
  if (!ls || ls.classList.contains('hidden') || ls.dataset.bootError) return;
  if (!initSettled) {
    debugWarn('Loading is running long; keeping the screen until init settles');
    setTimeout(forceHideCheck, 5000);
    return;
  }
  debugWarn('Loading timeout reached after init finished');
  console.warn('Loading timeout — forcing hide');
  revealLoadingScreen();
}, 15000);

init().then(() => {
  initSettled = true;
}).catch((err) => {
  initSettled = true;
  debugError('Init failed', err);
  console.error('Init failed:', err);
  // The error screen is opaque and stays: nothing behind it needs drawing.
  bootRender.markFailed();
  // The message lives INSIDE the loading screen, so the screen must stay up
  // (or come back — a failure after the 15s force-hide re-covers the broken
  // scene) for the user to ever read it.
  const loadingMsg = document.getElementById('loading-msg');
  if (loadingMsg) loadingMsg.textContent = 'Something went wrong. Please refresh.';
  const loadingScreen = document.getElementById('loading-screen');
  if (loadingScreen) {
    loadingScreen.dataset.bootError = '1';
    loadingScreen.classList.remove('hidden');
  }
});
