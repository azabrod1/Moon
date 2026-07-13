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
import type { SpikeS1Mode } from './descent/spikes/s1/SpikeS1Mode';
import { assembleScenePasses, renderPassesDirect, type ScenePassSpec } from './app/renderPipeline';
import { canGPUDoBloom } from './app/gpuCapability';
import { debugError, debugLog, debugWarn } from './shared/debug';

// ================================================================
// Top-level mode
// ================================================================
type AppMode = 'planetarium' | 'moonFlight' | 'volumeCompare' | 'descentSpike';
let appMode: AppMode = 'planetarium';
// switchAppMode early-returns on a same-mode call only after the first
// activation has actually run (init() enters the planetarium through it).
let appModeInitialized = false;
let planetariumMode: PlanetariumMode | null = null;
let moonFlightMode: MoonFlightMode | null = null;
let volumeCompareMode: VolumeCompareMode | null = null;
let descentSpikeMode: SpikeS1Mode | null = null;
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

// Enable bloom on any device whose GPU supports float framebuffers. ?nobloom=1
// forces the no-bloom fallback path (testable on any hardware — S1 exercises it).
const noBloomParam = new URLSearchParams(window.location.search).get('nobloom') === '1';
const useBloom = canGPUDoBloom(renderer) && !noBloomParam;

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
  // Descent's own policy (TECH §9): cap ≤ 1.5 desktop / ≤ 1.25 mobile — the
  // two-scene composer's float targets are the VRAM cost this bounds.
  if (appMode === 'descentSpike') return Math.min(window.devicePixelRatio, isMobile ? 1.25 : 1.5);
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

// Spike S1 bloom: threshold 1.0 so ONLY the deliberately-HDR sky elements (sun
// glare, stars) bloom. The invariant the mode must hold: terrain's max
// pre-tonemap luminance across the exposure range stays below this threshold —
// that IS the "terrain never blooms" mechanism (exposure is applied pre-bloom by
// scaling the sun light, since tone mapping runs in OutputPass AFTER bloom; TECH §6).
const SPIKE_BLOOM = { strength: 0.6, threshold: 1.0 };

// The pass specs the composer / no-bloom fallback currently render, plus refs to
// the built passes for the spike dev hooks (sky-pass and bloom toggles).
let currentPasses: ScenePassSpec[] = [{ scene }];
let currentRenderPasses: RenderPass[] = [];
let currentBloomPass: UnrealBloomPass | null = null;

function buildComposer(
  cam: THREE.Camera,
  bloom: { strength: number; threshold: number },
  passes: ScenePassSpec[] = [{ scene }],
  opts?: { samples?: number },
) {
  currentPasses = passes; // drives the no-bloom fallback path too
  if (composer) {
    // EffectComposer.dispose() frees only its own ping-pong targets and copy
    // pass — never the added passes. Dispose them here so the bloom pass's mip
    // targets and the output pass's material don't leak on every rebuild (each
    // camera switch). Pass.dispose() is a safe no-op for passes without state.
    for (const pass of composer.passes) pass.dispose();
    composer.dispose();
    composer = null;
  }
  currentRenderPasses = [];
  currentBloomPass = null;
  if (!useBloom) return;

  composer = new EffectComposer(renderer);
  composer.setPixelRatio(getTargetPixelRatio());
  composer.setSize(window.innerWidth, window.innerHeight);
  currentRenderPasses = assembleScenePasses(passes, cam);
  for (const pass of currentRenderPasses) composer.addPass(pass);
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    bloom.strength,
    BLOOM_RADIUS,
    bloom.threshold,
  );
  composer.addPass(bloomPass);
  currentBloomPass = bloomPass;
  composer.addPass(new OutputPass());
  if (opts?.samples) {
    // EffectComposer's default targets are HalfFloatType with samples 0; set them
    // on the fresh targets before first render so the multisampled FBO is built
    // multisampled (the AA decision — S1). Both ping-pong targets must match.
    composer.renderTarget1.samples = opts.samples;
    composer.renderTarget2.samples = opts.samples;
  }
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
    renderPassesDirect(renderer, currentPasses, cam);
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
          : newMode === 'descentSpike' ? 'Entering Descent...'
            : 'Gathering planets...';
    await sleep(400);

    if (newMode === 'planetarium') {
      // --- Switch to Planetarium ---
      appMode = 'planetarium';
      if (moonFlightMode) moonFlightMode.deactivate();
      if (volumeCompareMode) volumeCompareMode.deactivate();
      if (descentSpikeMode) descentSpikeMode.deactivate();
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
      if (descentSpikeMode) descentSpikeMode.deactivate();
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

    } else if (newMode === 'volumeCompare') {
      // --- Switch to Volume Compare ("How many fit?") ---
      appMode = 'volumeCompare';
      if (planetariumMode) planetariumMode.deactivate();
      if (moonFlightMode) moonFlightMode.deactivate();
      if (descentSpikeMode) descentSpikeMode.deactivate();
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

    } else {
      // --- Switch to Descent Spike S1 (QA-only entry, ?spike=s1) ---
      appMode = 'descentSpike';
      if (planetariumMode) planetariumMode.deactivate();
      if (moonFlightMode) moonFlightMode.deactivate();
      if (volumeCompareMode) volumeCompareMode.deactivate();
      planetariumUI.style.display = 'none';
      scene.background = new THREE.Color(0x000000);

      // Dynamic import (MoonFlight/volumeCompare code-split parity): the spike +
      // its scenes stay out of the initial bundle until entered.
      if (!descentSpikeMode) {
        debugLog('Loading descent spike module');
        const mod = await import('./descent/spikes/s1/SpikeS1Mode');
        descentSpikeMode = new mod.SpikeS1Mode(renderer);
        descentSpikeMode.onExit(() => {
          void switchAppMode('planetarium');
        });
      }
      camera = descentSpikeMode.camera;
      applyRenderResolution();
      // The mode's per-mode pass list: sky pass, then world pass with clearDepth.
      buildComposer(descentSpikeMode.camera, SPIKE_BLOOM, descentSpikeMode.scenePasses());
      debugLog('Activating descent spike mode');
      await descentSpikeMode.activate();
      debugLog('Descent spike mode active');
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
    traceStart: (name: string, maxFrames?: number) =>
      planetariumMode?.devTraceStart(name, maxFrames) ?? false,
    traceStop: () => planetariumMode?.devTraceStop() ?? null,
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
    // Mode-agnostic leak probe for the enter/exit heap check.
    rendererInfo: () => ({
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      programs: renderer.info.programs?.length ?? 0,
    }),
    // Descent spike S1 bridge (QA-only). Enter/exit route through switchAppMode so
    // the shared-renderer restore (exposure/autoClear) runs exactly as on a real exit.
    spikeEnter: () => { void switchAppMode('descentSpike'); },
    spikeExit: () => { void switchAppMode('planetarium'); },
    spikeState: () => descentSpikeMode?.devState() ?? null,
    spikeSetAlt: (m: number) => descentSpikeMode?.setAlt(m),
    spikeSetLook: (yawDeg: number, pitchDeg: number) => descentSpikeMode?.setLook(yawDeg, pitchDeg),
    spikeSetExposureEV: (ev: number) => descentSpikeMode?.setExposureEV(ev),
    spikeSetPaused: (p: boolean) => descentSpikeMode?.setPaused(p),
    spikeSetNaive: (on: boolean) => descentSpikeMode?.setNaive(on),
    spikeSetBloomEnabled: (on: boolean) => { if (currentBloomPass) currentBloomPass.enabled = on; },
    spikeSetSkyPassEnabled: (on: boolean) => { if (currentRenderPasses[0]) currentRenderPasses[0].enabled = on; },
    spikeRebuildComposer: (samples?: number) => {
      if (!descentSpikeMode) return false;
      buildComposer(descentSpikeMode.camera, SPIKE_BLOOM, descentSpikeMode.scenePasses(), samples ? { samples } : undefined);
      return true;
    },
    // Shared-renderer state readback for the exposure-restore AC.
    rendererState: () => ({
      toneMappingExposure: renderer.toneMappingExposure,
      autoClear: renderer.autoClear,
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
    syncViewportIfDrifted();
    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.1); // cap at 100ms to avoid huge jumps
    lastTime = now;

    if (appMode === 'planetarium' && planetariumMode) {
      planetariumMode.update(dt);
    } else if (appMode === 'moonFlight' && moonFlightMode) {
      moonFlightMode.update(dt);
    } else if (appMode === 'volumeCompare' && volumeCompareMode) {
      volumeCompareMode.update(dt);
    } else if (appMode === 'descentSpike' && descentSpikeMode) {
      descentSpikeMode.update(dt);
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

  // QA-only Descent spike entry (no UI button). Same tutorial guard as above.
  if (new URLSearchParams(window.location.search).get('spike') === 's1') {
    if (planetariumMode?.isTutorialActive()) {
      debugLog('?spike=s1 ignored — a tutorial owns the scene');
    } else {
      await switchAppMode('descentSpike');
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
  planetariumCamera.updateProjectionMatrix();
  flightCamera.aspect = w / h;
  flightCamera.updateProjectionMatrix();
  vcCamera.aspect = w / h;
  vcCamera.updateProjectionMatrix();
  moonFlightMode?.onResize(w / h);
  descentSpikeMode?.onResize(w / h);
  applyRenderResolution();
  // After the renderer's pixel ratio is (re)applied: retune star point sizes,
  // which are scaled by the renderer's ratio — both the compare and planetarium
  // starfields read renderer.getPixelRatio() in onResize, so they must run after.
  volumeCompareMode?.onResize(w / h);
  planetariumMode?.onResize();
  debugLog('Resize', { width: w, height: h });
}

window.addEventListener('resize', syncViewport);

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
