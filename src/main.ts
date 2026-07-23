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
import { LANDED_NEAR_AU } from './planetarium/landedView';
import type { MoonFlightMode } from './moonFlight/MoonFlightMode';
import type { VolumeCompareMode } from './volumeCompare/VolumeCompareMode';
import { canGPUDoBloom } from './app/gpuCapability';
import { BLOOM_RADIUS, BLOOM_THRESHOLD } from './app/bloomConfig';
import { createLensPass, updateLensPass, type LensParams } from './app/LensPass';
import { applyDesignFov, LENS_DEFAULT_STRENGTH } from './shared/math/lensProjection';
import { stepExposure } from './planetarium/solarExposure';
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
    antialias: true,
    powerPreference: 'high-performance',
  });
} catch (err) {
  debugError('Failed to create WebGL renderer', err);
  throw err;
}
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
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

try {
  const gl = renderer.getContext();
  debugLog('Renderer ready', {
    shadowMap: renderer.shadowMap.enabled,
    useBloom,
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
  if (isMobile) return Math.min(window.devicePixelRatio, 2);
  return Math.min(Math.max(window.devicePixelRatio, 1.5), 2.5);
}

function applyRenderResolution() {
  const pixelRatio = getTargetPixelRatio();
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (composer) {
    composer.setPixelRatio(pixelRatio);
    composer.setSize(window.innerWidth, window.innerHeight);
  }
}

// Bloom radius (shared across modes) and the planetarium threshold live in
// app/bloomConfig so the star-luminance invariant test shares the cutoff.
// Strength + threshold are authored per mode at each call site: the planetarium
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
    composer.dispose();
    composer = null;
  }
  lensPass = null;
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
  // OutputPass (with or without the runtime bloom pass enabled).
  composer = new EffectComposer(renderer);
  composer.setPixelRatio(getTargetPixelRatio());
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
    composer.addPass(new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      bloom.strength,
      BLOOM_RADIUS,
      bloom.threshold,
    ));
  }

  composer.addPass(new OutputPass());
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
    buildComposer(planetariumCamera, { strength: 0.8, threshold: BLOOM_THRESHOLD }, effective);
  }
  planetariumMode?.devApplySunGlowTier(effective);
}

applyRenderResolution();
buildComposer(planetariumCamera, { strength: 0.8, threshold: BLOOM_THRESHOLD }, planetariumBloomEnabled());

// Armed after first Planetarium activation: that render compiles the scene's
// shaders and uploads textures, so its duration is a startup phase of its own.
let measureNextSceneFrame = false;

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

function setPlanetsLoadingPercent(completedUnits: number, totalUnits: number) {
  const clampedTotalUnits = Math.max(totalUnits, 1);
  const clampedCompletedUnits = Math.min(Math.max(completedUnits, 0), clampedTotalUnits);
  const pct = Math.round((clampedCompletedUnits / clampedTotalUnits) * 100);
  const text = `Loading Planets... ${pct}%`;
  const loadEl = document.getElementById('loading-msg');
  if (loadEl) loadEl.textContent = text;
  transitionMsg.textContent = text;
}

function setFlightLoadingPercent(completedUnits: number, totalUnits: number) {
  const clampedTotalUnits = Math.max(totalUnits, 1);
  const clampedCompletedUnits = Math.min(Math.max(completedUnits, 0), clampedTotalUnits);
  const pct = Math.round((clampedCompletedUnits / clampedTotalUnits) * 100);
  const text = `Entering Flight... ${pct}%`;
  const loadEl = document.getElementById('loading-msg');
  if (loadEl) loadEl.textContent = text;
  transitionMsg.textContent = text;
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
    await sleep(400);

    if (newMode === 'planetarium') {
      // --- Switch to Planetarium ---
      appMode = 'planetarium';
      if (moonFlightMode) moonFlightMode.deactivate();
      if (volumeCompareMode) volumeCompareMode.deactivate();
      scene.background = new THREE.Color(0x000000);

      camera = planetariumCamera;
      applyRenderResolution();
      buildComposer(planetariumCamera, { strength: 0.8, threshold: BLOOM_THRESHOLD }, planetariumBloomEnabled());

      if (!planetariumMode) {
        debugLog('Creating Planetarium mode');
        planetariumMode = new PlanetariumMode(scene, planetariumCamera, renderer, useBloom);
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
    diagnosticSphere: (offNdcX?: number, offNdcY?: number, fovDeg?: number, angularRadiusDeg?: number) =>
      planetariumMode?.devFrameDiagnosticSphere(offNdcX, offNdcY, fovDeg, angularRadiusDeg) ?? false,
    // Marker-limb integration: a planet's live analytic occluder disc, ship
    // visibility, and a red marker sprite culled by the REAL analytic occlusion.
    planetOccluderDisc: (name: string) => planetariumMode?.devPlanetOccluderDisc(name) ?? null,
    setShipVisible: (visible: boolean) => planetariumMode?.devSetShipVisible(visible),
    probeLimbMarker: (screenX: number, screenY: number, depthAU: number) =>
      planetariumMode?.devProbeLimbMarker(screenX, screenY, depthAU) ?? null,
    sunAppearance: () => planetariumMode?.devSunAppearance() ?? null,
    sunGlareMask: () => planetariumMode?.devSunGlareMask() ?? null,
    eclipseDebug: () => planetariumMode?.devEclipseDebug() ?? null,
    setVeil: (opts: { warmth?: number; strength?: number }) =>
      planetariumMode?.devSetVeil(opts ?? {}) ?? false,
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
        buildComposer(planetariumCamera, { strength: 0.8, threshold: BLOOM_THRESHOLD }, planetariumBloomEnabled());
      }
      return planetariumLens.strength;
    },
    probe: (name: string) => planetariumMode?.devProbe(name) ?? null,
    land: (name: string) => planetariumMode?.devLand(name) ?? false,
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
    tutorialStart: () => planetariumMode?.devTutorialStart() ?? false,
    tutorialNext: () => planetariumMode?.devTutorialNext(),
    tutorialBack: () => planetariumMode?.devTutorialBack(),
    tutorialSkip: () => planetariumMode?.devTutorialSkip(),
    tutorialState: () => planetariumMode?.devTutorialState() ?? null,
    setChrome: (visible: boolean) => planetariumMode?.devSetChrome(visible),
    setFov: (deg: number) => planetariumMode?.devSetFov(deg),
    systemMapFocus: (name: string) => planetariumMode?.devSystemMapFocus(name) ?? false,
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
    // Mode-agnostic leak probe for the enter/exit heap check.
    rendererInfo: () => ({
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      programs: renderer.info.programs?.length ?? 0,
      exposure: renderer.toneMappingExposure,
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
    syncViewportIfDrifted();
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
    renderScene(camera);
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

  document.getElementById('loading-screen')?.classList.add('hidden');
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
  debugLog('Resize', { width: w, height: h });
}

window.addEventListener('resize', syncViewport);

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
// disc as an ellipse. Called from the animation loop: plain property reads,
// no layout, and the aspect term re-arms the sync even if some other path
// ever clobbers a camera.
function syncViewportIfDrifted() {
  if (
    window.innerWidth !== appliedViewportW ||
    window.innerHeight !== appliedViewportH ||
    camera.aspect !== appliedViewportW / appliedViewportH
  ) {
    syncViewport();
  }
}

// ================================================================
// Start
// ================================================================
// Safety: never leave loading screen stuck for more than 15s
setTimeout(() => {
  const ls = document.getElementById('loading-screen');
  const shouldForceHide = !!ls && !ls.classList.contains('hidden');
  if (shouldForceHide) {
    debugWarn('Loading timeout reached before init finished');
    console.warn('Loading timeout — forcing hide');
    ls.classList.add('hidden');
  }
}, 15000);

init().catch((err) => {
  debugError('Init failed', err);
  console.error('Init failed:', err);
  // Never leave user stuck on loading screen
  const loadingScreen = document.getElementById('loading-screen');
  if (loadingScreen) loadingScreen.classList.add('hidden');
  const loadingMsg = document.getElementById('loading-msg');
  if (loadingMsg) loadingMsg.textContent = 'Something went wrong. Please refresh.';
});
