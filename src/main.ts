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
import type { MoonFlightMode } from './moonFlight/MoonFlightMode';
import type { VolumeCompareMode } from './volumeCompare/VolumeCompareMode';
import { canGPUDoBloom } from './app/gpuCapability';
import { debugError, debugLog, debugWarn } from './shared/debug';

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

// Enable bloom on any device whose GPU supports float framebuffers
const useBloom = canGPUDoBloom(renderer);

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
const planetariumCamera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.000001, 200);
planetariumCamera.position.set(-0.0002, 0.0001, 0.0001);

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

// Bloom radius is shared across modes; strength + threshold are authored per
// mode at each call site. Volume-compare deliberately matches the Planetarium's
// 0.8 / 0.92 identity so its glass HDR glint blooms against the same threshold.
const BLOOM_RADIUS = 0.4;

function buildComposer(cam: THREE.Camera, bloom: { strength: number; threshold: number }) {
  if (composer) {
    // EffectComposer.dispose() frees only its own ping-pong targets and copy
    // pass — never the added passes. Dispose them here so the bloom pass's mip
    // targets and the output pass's material don't leak on every rebuild (each
    // camera switch). Pass.dispose() is a safe no-op for passes without state.
    for (const pass of composer.passes) pass.dispose();
    composer.dispose();
    composer = null;
  }
  if (!useBloom) return;

  composer = new EffectComposer(renderer);
  composer.setPixelRatio(getTargetPixelRatio());
  composer.setSize(window.innerWidth, window.innerHeight);
  composer.addPass(new RenderPass(scene, cam));
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    bloom.strength,
    BLOOM_RADIUS,
    bloom.threshold,
  );
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());
}

applyRenderResolution();
buildComposer(planetariumCamera, { strength: 0.8, threshold: 0.92 });

// Armed after first Planetarium activation: that render compiles the scene's
// shaders and uploads textures, so its duration is a startup phase of its own.
let measureNextSceneFrame = false;

function renderScene(cam: THREE.Camera) {
  const measuring = measureNextSceneFrame;
  if (measuring) {
    measureNextSceneFrame = false;
    performance.mark('plm:first-frame:start');
  }
  if (composer) {
    composer.render();
  } else {
    renderer.render(scene, cam);
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
      buildComposer(planetariumCamera, { strength: 0.8, threshold: 0.92 });

      if (!planetariumMode) {
        debugLog('Creating Planetarium mode');
        planetariumMode = new PlanetariumMode(scene, planetariumCamera, renderer, useBloom);
        // The ☰ "How many fit?" item and the help-modal row arrive here: the
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
  (window as any).__moon = {
    ready: () => !!planetariumMode?.hasLoadedSolarSystem(),
    bodies: () => planetariumMode?.devListBodies() ?? [],
    jumpTo: (name: string, distanceMultiplier?: number) =>
      planetariumMode?.devJumpToBody(name, distanceMultiplier) ?? false,
    frame: (name: string, fillFraction?: number, phaseAngleDeg?: number) =>
      planetariumMode?.devFrameBody(name, fillFraction, phaseAngleDeg) ?? false,
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
    tutorialStart: () => planetariumMode?.devTutorialStart() ?? false,
    tutorialNext: () => planetariumMode?.devTutorialNext(),
    tutorialBack: () => planetariumMode?.devTutorialBack(),
    tutorialSkip: () => planetariumMode?.devTutorialSkip(),
    tutorialState: () => planetariumMode?.devTutorialState() ?? null,
    setChrome: (visible: boolean) => planetariumMode?.devSetChrome(visible),
    setFov: (deg: number) => planetariumMode?.devSetFov(deg),
    setTimeMs: (utcMs: number) => planetariumMode?.setCurrentUtcMs(utcMs),
    getTimeMs: () => planetariumMode?.getCurrentUtcMs() ?? 0,
    setTimeRate: (rate: number) => planetariumMode?.setTimeRate(rate),
    setTimePaused: (paused: boolean) => planetariumMode?.setTimePaused(paused),
    // Volume-compare bridge. compareOpen switches directly (the mode instance is
    // null before first entry); the rest delegate to the live instance.
    compareOpen: () => { void switchAppMode('volumeCompare'); },
    compareExit: () => volumeCompareMode?.devExit(),
    comparePick: (container: string, filler: string) =>
      volumeCompareMode?.devPick(container, filler) ?? false,
    compareState: () => volumeCompareMode?.devState() ?? null,
    compareScatter: (n: number) => volumeCompareMode?.devScatter(n) ?? false,
    compareOrbit: (azimuthDeg: number, elevationDeg?: number) =>
      volumeCompareMode?.devOrbit(azimuthDeg, elevationDeg) ?? false,
    // Honest stubs — the pour/melt land in P3 (the methods return false today).
    compareSlider: (f: number) => volumeCompareMode?.devSlider(f) ?? false,
    compareMelt: () => volumeCompareMode?.devMelt() ?? false,
    // Mode-agnostic leak probe for the enter/exit heap check.
    rendererInfo: () => ({
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      programs: renderer.info.programs?.length ?? 0,
    }),
  };
  debugLog('Dev hooks installed (window.__moon)');
}

// ================================================================
// Main init
// ================================================================
async function init() {
  (window as any).__initStarted = true;
  debugLog('Init started');

  let lastTime = performance.now();

  function animate() {
    requestAnimationFrame(animate);
    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.1); // cap at 100ms to avoid huge jumps
    lastTime = now;

    if (appMode === 'planetarium' && planetariumMode) {
      planetariumMode.update(dt);
    } else if (appMode === 'moonFlight' && moonFlightMode) {
      moonFlightMode.update(dt);
    } else if (appMode === 'volumeCompare' && volumeCompareMode) {
      volumeCompareMode.update(dt);
    }

    renderScene(camera);
  }

  animate();
  debugLog('Animation loop started');

  const autoMode = getAutoMode();
  debugLog('Boot mode', { autoMode });
  // The Planetarium always boots first — it owns the saves, the catalog, and
  // the veil semantics — then ?auto=volumeCompare routes on into the compare mode.
  await switchAppMode('planetarium');
  if (import.meta.env.DEV) installDevHooks();
  logStartupTimings();

  document.getElementById('loading-screen')?.classList.add('hidden');
  await planetariumMode?.showDeferredResumePromptIfNeeded();

  if (autoMode === 'volumeCompare') await switchAppMode('volumeCompare');
}

// ================================================================
// Resize handler
// ================================================================
window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  planetariumCamera.aspect = w / h;
  planetariumCamera.updateProjectionMatrix();
  flightCamera.aspect = w / h;
  flightCamera.updateProjectionMatrix();
  vcCamera.aspect = w / h;
  vcCamera.updateProjectionMatrix();
  moonFlightMode?.onResize(w / h);
  volumeCompareMode?.onResize(w / h);
  applyRenderResolution();
  debugLog('Resize', { width: w, height: h });
});

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
