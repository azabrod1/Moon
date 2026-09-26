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
import { DownsamplePass, OutputTargetPass, SharpenPass, UpscalePass, type DownsampleFilter } from './app/UpscalePass';
import { RCAS_DEFAULT_STOPS, rcasStopsForFactor } from './app/fsr1';

import { PlanetariumMode, FIRST_PLANETARIUM_ACTIVATION_TOTAL_UNITS } from './planetarium/PlanetariumMode';
import type { ShipProfile } from './planetarium/PlayerShip';
import { LANDED_NEAR_AU } from './planetarium/landedView';
import type { MoonFlightMode } from './moonFlight/MoonFlightMode';
import type { VolumeCompareMode } from './volumeCompare/VolumeCompareMode';
import type { InteriorMode } from './interior/InteriorMode';
import { setInteriorTransition } from './interior/interiorTransition';
import { parseCssDurationMs } from './shared/cssDuration';
import { applyRenderProfile, toneMappingWord, type AppMode } from './app/renderProfile';
import type { ToolRequest } from './planetarium/toolRequest';
import { canGPUDoBloom, halfFloatTargetSampleCounts } from './app/gpuCapability';
import { installShaderSalt } from './app/shaderSalt';
import {
  bloomPixelRatio, composerSamples, parseMsaaOverride, parsePixelRatioPin, parseUpscaleParam, renderPixelRatio,
  targetPixelRatio, type UpscaleFilter,
} from './app/renderResolution';
import {
  DEFAULT_QUALITY, dynamicLadder, parseQualityParam, qualityBounds, renderTargetBytes, sceneRatioForLevel,
  sceneTargetSize, type QualityBounds, type QualityBoundsInput, type QualityLadder, type QualityLevel,
} from './app/renderQuality';
import {
  ResolutionController, ZERO_COUNTED_WARN_MS,
  type Decision, type GpuObservation, type IntervalSample,
} from './app/resolutionController';
import { SYNC_REFUSED_REASON, createGpuFrameClock, parseGpuClockParam } from './app/gpuFrameClock';
import { StillViewNamer } from './app/stillViewName';
import { FrameCadence, parseRefreshParam } from './app/frameCadence';
import {
  isScreenRate, requestedMsFor, resolveBootFrameRate, writeFrameRate,
  type FrameRate,
} from './app/frameRateSetting';
import { markPending, clearPending, pendingAtBoot, readQualityLevel, writeQualityLevel } from './app/qualitySetting';
import {
  RungMemoryMirror, clearRungMemory, readRungMemory, rungMemoryApplies, rungMemoryUrlBlock,
  type RungMemoryConfig, type RungMemoryEntry, type RungMemoryFacts,
} from './app/rungMemory';
import {
  HIGH_PASS_UV_ANCHOR, allocationSceneRatio, applySubRect, parseAllocParam, patchUvScale, sceneRects,
  type SceneRects, type SubRectUniforms, type TargetSize,
} from './app/sceneSubRect';
import {
  classifyDevice, devEnvelopeOverride, deviceProfileFor, platformFamily, readDeviceSignals,
} from './planetarium/world/gpuEnvelope';
import { BootRenderGate } from './app/bootRenderGate';
import { installPerfSwitchBridge, onPerfSwitch, perfSwitchOn } from './app/perfSwitches';
import { bloomHighPassMaterial, holdBloomSize, setBloomInternalDepth } from './app/bloomTargets';
import {
  devGlintUniforms,
  setDevOceanRoughness,
  setDevSurfaceHaze,
  SURFACE_HAZE_CLEAR_VIEW,
} from './planetarium/world/surfaceShading';
import { DepthDiscardPass } from './app/DepthDiscardPass';
import { BloomChainPass, FusedOutputPass, parseFusedParam } from './app/FusedOutputPass';
import type { GpuProfiler, GpuProfileOptions } from './app/devGpuProfile';
import type { GpuClock, GpuClockOptions } from './app/devGpuClock';
import { ScreenCopy, canvasSampleCount, createScreenTarget, fitScreenTarget, screenTargetSamples } from './app/screenTarget';
import { bitmapDecodePath } from './planetarium/world/textureBitmapLoader';
import { BLOOM_RADIUS, PLANETARIUM_BLOOM } from './app/bloomConfig';
import {
  createLensPass, devSetLensPassOff, lensSubRectUniforms, makeLensUniforms, syncLensUniforms,
  updateLensPass, type LensParams, type LensUniforms,
} from './app/LensPass';
import { applyDesignFov, displayFovDeg, LENS_DEFAULT_STRENGTH } from './shared/math/lensProjection';
import { loadBrightStarCatalog } from './planetarium/world/starCatalogLoader';
import { debugError, debugLog, debugWarn } from './shared/debug';
import { safeAreaInsets } from './shared/dom';
import { resolveViewportSize, setViewportSize, viewportDrifted, viewportSize, type ViewportSize } from './app/viewportSize';
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
import { beginSlicedUpload, stepSlicedUpload } from './planetarium/world/slicedUpload';
import { invalidateTextureWarmCache, pumpTextureWarmQueue, queueTextureWarm } from './planetarium/world/textureWarmer';
import {
  smoothTraceFrameStart,
  smoothTraceEvent,
  smoothTraceSnapshot,
  smoothTraceStart,
  smoothTraceStop,
} from './planetarium/smoothnessTrace';

// ================================================================
// Top-level mode
// ================================================================
let appMode: AppMode = 'planetarium';
// switchAppMode early-returns on a same-mode call only after the first
// activation has actually run (init() enters the planetarium through it).
let appModeInitialized = false;
let planetariumMode: PlanetariumMode | null = null;
let moonFlightMode: MoonFlightMode | null = null;
let volumeCompareMode: VolumeCompareMode | null = null;
let interiorMode: InteriorMode | null = null;
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
    // No samples of its own. The composer path renders the scene into its own
    // target, which carries its own sample count (buildComposer,
    // app/renderResolution.ts), and hands the canvas one full-screen quad: the
    // canvas's samples smoothed nothing there and their resolve cost 2.9 ms of
    // an iPhone's frame (20 %). What used to draw straight onto the canvas —
    // the no-float direct path, the System Map, the corner chart — draws onto
    // a screen target with the samples it had (app/screenTarget.ts) and is
    // copied across. `?canvasaa=1` puts the canvas's samples back and every
    // one of those draws onto the canvas as before: the kill switch, and the
    // A/B's "before". A context attribute, so it takes a reload.
    antialias: new URLSearchParams(location.search).get('canvasaa') === '1',
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
// The tone curve is the mode's (app/renderProfile): the switch applies it
// when it brings a mode up, and no mode writes it for itself.
applyRenderProfile(renderer, appMode);
renderer.toneMappingExposure = 1.0;
// The class is the CSS rule that makes the canvas the fixed-position rect
// (index.html canvas.scene-canvas): its box is what the renderer is sized to
// (syncViewport below, app/viewportSize.ts).
renderer.domElement.classList.add('scene-canvas');
document.body.appendChild(renderer.domElement);
/** Set once the context is lost: the GPU frame clock's fences die with it. */
let contextLost = false;
renderer.domElement.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  contextLost = true;
  debugError('WebGL context lost');
  rungMemoryContextLost();
});
renderer.domElement.addEventListener('webglcontextrestored', () => {
  debugLog('WebGL context restored');
});

// A first visit links every program cold, and this machine's Metal library
// cache — which no browser flag clears — makes that unrepeatable. `?shaderSalt=`
// changes every shader's source so the driver has to link cold again, which is
// what makes a first-visit stall measurable. Installed before anything
// compiles. DEV only; see app/shaderSalt.ts.
if (import.meta.env.DEV) {
  const salt = new URLSearchParams(location.search).get('shaderSalt');
  if (salt) {
    try {
      installShaderSalt(renderer.getContext(), salt);
      debugLog('Shader salt active — every program links cold', salt);
    } catch (err) {
      debugWarn('Shader salt could not be installed', err);
    }
  }
}

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
// The capture pin on the pixel ratio (see pinCapture), declared before the
// renderer-details log below reads the target ratio at module init. The dev
// server's `?ratio=` starts the session pinned (app/renderResolution.ts
// parsePixelRatioPin): a phone shown its full panel beside its capped frame,
// as two links; the bloom chain keeps the display's own ratio either way.
let pixelRatioPin: number | null = parsePixelRatioPin(location.search, import.meta.env.DEV);

// What the canvas really got (a request is not always honoured) and the
// samples a screen target carries here. Read once: neither can change.
const canvasSamples = canvasSampleCount(renderer);
const canvasSampled = canvasSamples > 0;
const screenSamples = screenTargetSamples(renderer);
if (new URLSearchParams(location.search).get('canvasaa') === '1' && !canvasSampled) {
  debugWarn('canvasaa=1 asked for canvas samples and the context gave none');
}

// The resample (app/UpscalePass.ts; the policy in app/renderResolution.ts):
// the planetarium's scene drawn at a ratio of its own and carried across to
// the canvas. `?upscale=` names that ratio on any build and PINS it — while
// it stands it owns the scene ratio outright, the graphics-quality level is
// held out of the way and Dynamic is idle, which is what a measurement asks
// for (`?upscale=0` therefore pins the canvas's own ratio: the kill switch).
// Unasked, the quality level below decides. The filter and the sharpen stops
// are dev dials, live through `__moon.upscale`.
const upscaleParam = parseUpscaleParam(location.search, import.meta.env.DEV);
let upscalePinned = upscaleParam !== null;
let upscalePinRatio: number | null = upscaleParam?.renderRatio ?? null;
/** The one scene-ratio request every path reads: the pin's, or the quality
 *  level's (updateSceneRatioRequest). Null means the output ratio — today's
 *  frame, byte for byte. */
let upscaleRenderRatio: number | null = null;
let upscaleFilter: UpscaleFilter = upscaleParam?.filter ?? 'easu';
/** RCAS's stops, once something has named them: `?sharpen=` or the bridge.
 *  Unasked, the stops come from the factor the frame is upscaled by
 *  (app/fsr1.ts rcasStopsForFactor) — one stop was matched at 4/3 and
 *  over-sharpens at a shallower rung — so this stays null and nothing here
 *  owns them. */
let upscaleSharpenStops: number | null = upscaleParam?.sharpen === undefined ? RCAS_DEFAULT_STOPS : upscaleParam.sharpen;
let upscaleSharpenPinned = upscaleParam?.sharpen !== undefined;
// Which kernel carries a frame drawn LARGER than the canvas down onto it. The
// box is the compositor's own shrink, the look that was judged the sharper
// one; `?downsample=tent` is the A/B, dev server only.
let downsampleFilter: DownsampleFilter =
  import.meta.env.DEV && new URLSearchParams(location.search).get('downsample') === 'tent' ? 'tent' : 'box';
/** Whether Dynamic allocates its scene-sized targets once at the ladder's top
 *  rung and draws every rung into a sub-rectangle of them
 *  (app/sceneSubRect.ts). `?alloc=0`, on any build, goes back to a
 *  re-allocation on every rung change: the kill switch, and the A/B for a
 *  sub-rect bug on a device that is not here. */
const fixedSceneAllocation = parseAllocParam(location.search);

/**
 * Whether the frame ends in ONE finishing pass — the lens warp, the glow and
 * the tone map in a single draw (app/FusedOutputPass.ts) — or in the three
 * separate full-resolution passes that came before it. Read here, before the
 * quality bounds are first computed, because the byte budget counts the
 * composer's partner only on the chain that binds it.
 *
 * `?fused=0` on any build is the kill switch and is fixed for the session, so
 * `composerBuiltFor` needs no field for it. In DEV the switch registry says the
 * same thing through `?perfoff=fused-final` or `__moon.perfArm`, whose listener
 * rebuilds the chain live for a capture — and with `?fused=0` already in the
 * URL such an arm rebuilds the same chain twice and changes nothing, which is
 * harmless and is the param winning.
 */
const fusedFinalParam = parseFusedParam(location.search);
function fusedFinalOn(): boolean {
  return fusedFinalParam && (import.meta.env.DEV ? perfSwitchOn('fused-final') : true);
}

// ================================================================
// Graphics quality
// ================================================================
// What Low, Medium, High and Dynamic mean on the display in front of the user
// is app/renderQuality.ts; when Dynamic steps is app/resolutionController.ts;
// this is the wiring. Everything moves the SCENE ratio only — the canvas, the
// System Map, the corner chart and the direct path stay on the output ratio,
// and so do the sector tiles and the close-range detail except at the fixed
// High level (getTilePixelRatio).

// The device, classified once, here: the bounds are needed before the
// planetarium mode exists. The mode reads the same signals off the same
// context and lands on the same class and family, and its texture profile
// goes through the same devEnvelopeOverride, so the byte budget below is
// measured against the envelope the sector streamer really spends — the DEV
// `?envelope=` shrink included, which is how "does the budget bind" is asked
// on a desktop. The class reaches the quality bounds ONLY through that
// envelope: no rule there asks what kind of chassis this is.
const deviceSignals = readDeviceSignals(renderer.getContext());
const deviceClass = classifyDevice(deviceSignals);
const devicePlatform = platformFamily(deviceSignals);
const deviceEnvelopeBytes = devEnvelopeOverride(deviceProfileFor(deviceClass, devicePlatform)).envelopeBytes;

/** min(MAX_TEXTURE_SIZE, MAX_RENDERBUFFER_SIZE). A target above either yields
 *  an incomplete framebuffer — a black frame, with no fallback — so no level
 *  and no rung may cross it in either dimension. */
const maxGlTargetSize = (() => {
  const gl = renderer.getContext();
  const texture = renderer.capabilities.maxTextureSize;
  const buffer = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number;
  return Number.isFinite(buffer) && buffer > 0 ? Math.min(texture, buffer) : texture;
})();

let qualityLevel: QualityLevel = resolveBootQualityLevel();
let qualityBoundsLive: QualityBounds = qualityBounds(qualityBoundsInput());
let qualityLadderLive: QualityLadder = dynamicLadder(qualityBoundsLive);
const resolutionController = new ResolutionController(qualityLadderLive);
/** Whether a pin currently holds Dynamic out of the way (refreshQualityPin). */
let qualityIdle = false;
/** The `?perf=1` sweep holds it idle for its whole run: the sweep pins and
 *  un-pins the output ratio itself, and the un-pin at the end would otherwise
 *  wake the controller on a device the run has just heated. */
let qualitySweepHold = false;

/**
 * The level this boot runs at: the URL's word, else the saved setting, else
 * the default.
 *
 * `?quality=` is this boot's own instruction and wins outright. Every other
 * level goes through the boot-loop guard: a machine that cannot allocate what
 * the setting asks for would otherwise re-apply it on the reload after it
 * died, with no way out but clearing site data. So the level is written as a
 * pending marker before it is applied, and the marker is cleared the moment
 * the first frame is live; a marker still standing at boot means the last boot
 * never reached a frame under it, so this one takes medium and says which
 * level it refused.
 *
 * The guard covers the DEFAULT, not just a saved choice: the default is
 * Dynamic, and Dynamic now allocates its targets at the ladder's top rung
 * (app/sceneSubRect.ts) — the largest allocation the app ever makes by itself.
 * Medium is the one level left unmarked: it is what the guard falls back TO,
 * and what it allocates is the floor every other level is measured from.
 */
function resolveBootQualityLevel(): QualityLevel {
  const asked = parseQualityParam(location.search, import.meta.env.DEV);
  if (asked !== null) return asked;
  const stuck = pendingAtBoot();
  if (stuck !== null) {
    debugWarn(`The last boot never reached a frame at graphics quality "${stuck}" — this one draws at medium`);
    return 'medium';
  }
  const level = readQualityLevel() ?? DEFAULT_QUALITY;
  if (level !== 'medium') markPending(level);
  return level;
}

/** Everything the bounds depend on, read off the live display. */
function qualityBoundsInput(): QualityBoundsInput {
  const outputRatio = getTargetPixelRatio();
  return {
    outputRatio,
    platform: devicePlatform,
    envelopeBytes: deviceEnvelopeBytes,
    cssWidth: viewportSize().width,
    cssHeight: viewportSize().height,
    // From the output ratio and held there across every level and rung.
    samples: getSceneTargetSamples(outputRatio),
    // The composer's partner is bound, and so costs memory, only on the
    // `?fused=0` chain (app/FusedOutputPass.ts).
    partnerBound: !fusedFinalOn(),
    // The planetarium gets a composer wherever the GPU can render half-float
    // (buildComposer). Without one there is no target to re-size, no resample
    // pass to enable, and every level is medium.
    hasComposer: useBloom,
    supersampleFallback,
    maxGlSize: maxGlTargetSize,
  };
}

/** The scene ratio the live level asks for, or null for "the output ratio" —
 *  which is what Medium has to stay, byte for byte. */
function qualitySceneRatioRequest(): number | null {
  if (!useBloom) return null;
  const ratio = qualityLevel === 'dynamic'
    ? resolutionController.sceneRatio
    : sceneRatioForLevel(qualityLevel, qualityBoundsLive);
  return Math.abs(ratio - qualityBoundsLive.medium) < 1e-9 ? null : ratio;
}

/** The boot warm-up's rung while it draws one (warmSceneAllocation), so the
 *  covered frames really go through each resample path. Null at every other
 *  moment of the session. */
let sceneRatioWarm: number | null = null;

/** Write the one request every path reads: the warm-up's rung while it holds
 *  one, else the measurement pin's ratio while one stands, else the level's
 *  own. */
function updateSceneRatioRequest(): void {
  if (sceneRatioWarm !== null) {
    upscaleRenderRatio = sceneRatioWarm;
    return;
  }
  upscaleRenderRatio = upscalePinned ? upscalePinRatio : qualitySceneRatioRequest();
}

/**
 * The bounds depend on the output ratio, the CSS size and the sample count,
 * and a move to another monitor or a page zoom changes all three — which
 * changes what every level means and which rungs exist. Recompute them,
 * re-clamp Dynamic's rung to the nearest rung the new ladder offers, and
 * re-derive the request. The caller re-sizes.
 */
function recomputeQualityBounds(): void {
  qualityBoundsLive = qualityBounds(qualityBoundsInput());
  qualityLadderLive = dynamicLadder(qualityBoundsLive);
  if (qualityLevel === 'dynamic') resolutionController.setLadder(qualityLadderLive, performance.now());
  updateSceneRatioRequest();
}

/**
 * Every pin that holds Dynamic idle: a measurement that owns the ratio
 * (`?upscale=`, the DEV `?ratio=` / `__moon.pinRatio`), the perf sweep's run,
 * a fixed level, and a build with no composer to re-size. Idle means no
 * interval counts and no decision is made — not that the controller forgets
 * what it learned.
 */
function refreshQualityPin(): void {
  const pinned = upscalePinned
    || pixelRatioPin !== null
    || qualitySweepHold
    || qualityLevel !== 'dynamic'
    || !useBloom;
  if (pinned === qualityIdle) return;
  qualityIdle = pinned;
  resolutionController.notify(pinned ? 'pin' : 'unpin', performance.now());
}

/**
 * The graphics-quality level, changed. Saves the choice — on its own
 * localStorage key, never in the journey save, so New Journey cannot clear it
 * — and re-draws at the new ratio through the narrow path.
 *
 * This is the function the menu row writes through.
 */
function setQualityLevel(level: QualityLevel): void {
  if (level === qualityLevel) return;
  qualityLevel = level;
  writeQualityLevel(level);
  refreshQualityPin();
  // Dynamic picks up the ladder for this display and starts from whichever
  // rung it last held; the evidence behind that rung is dropped either way.
  if (level === 'dynamic') resolutionController.setLadder(qualityLadderLive, performance.now());
  applySceneResolution(`level ${level}`);
}

/**
 * The ratio the sector tiles and the close-range detail are chosen for.
 *
 * The canvas's, except at the FIXED High level. A ratio that CHANGES must not
 * reach the streamer — a slide would swap the tiles under the user, which is
 * the one thing a resolution mechanism is not allowed to do — but a fixed
 * level picks its tiles once, and High drawing the canvas's tiles into three
 * times the pixels was most of why `?ratio=3` looked better than a
 * supersample at Earth's shell.
 */
function getTilePixelRatio(): number {
  // High's own bound rather than the live scene ratio, so a measurement pin
  // moves the scene ratio and nothing else: `?upscale=1.5` at High would
  // otherwise ask the streamer for a COARSER tier than Medium draws, which is
  // a picture cut no measurement is allowed to make.
  if (upscalePinned || qualityLevel !== 'high') return getTargetPixelRatio();
  return qualityBoundsLive.high;
}

/** Where graphics quality stands: the level, the rung, what this display
 *  offers, and the decision rule's own window. */
function qualityReadout() {
  const state = resolutionController.state();
  const sceneRatio = getScenePixelRatio();
  return {
    level: qualityLevel,
    rung: state.rung,
    sceneRatio,
    outputRatio: getTargetPixelRatio(),
    tileRatio: getTilePixelRatio(),
    mode: sceneRatioMode(),
    bounds: qualityBoundsLive,
    ladder: qualityLadderLive.rungs,
    // The LIVE budget, which the Frame rate row moves: a harness that injects
    // a stream has to derive its own from this, or it would inject evidence
    // about another question.
    budgetMs: state.budgetMs,
    // What a rung above Medium is held to, and whether one may be taken on
    // its own at all (the display's own tick at the row's default).
    aboveBudgetMs: state.aboveBudgetMs,
    aboveAllowed: state.aboveAllowed,
    downCounted: state.downCounted,
    upCounted: state.upCounted,
    // The schedule: what was asked for, what the display delivers, and how
    // often the loop draws (app/frameCadence.ts).
    fps: {
      ...frameCadence.state(),
      drawSeq,
      tickSeq,
      held: frameCapHeldBy(),
    },
    window: {
      trimmedMeanMs: state.trimmedMeanMs,
      // The eligible time the down window covers, and which rule has
      // completed it — its count, or its span on a device far below the tick.
      downSpanMs: state.downSpanMs,
      downWindowBy: state.downWindowBy,
      countedRate: state.countedRate,
      counted: state.countedWindow,
      silentMs: state.silentMs,
    },
    probeWaitMs: state.probeWaitMs,
    ceiling: state.ceiling,
    probation: state.probation,
    latch: state.latch,
    lastStep: state.lastStep,
    idle: state.idle,
    // The GPU frame clock: the sensor (what it samples, discards and costs)
    // and the rule's side of it (whether it steers, its windows, why a rung
    // moved) — app/gpuFrameClock.ts, app/resolutionController.ts.
    gpu: gpuFrameClock.state(),
    clock: state.clock,
    // The rung remembered from the last boot and the one this session would
    // hand the next (app/rungMemory.ts).
    memory: rungMemoryReadout(),
    bytes: qualityRenderTargetBytes(),
    reason: qualityBoundsLive.reason,
    // What the scene-sized targets are allocated at against what this rung
    // draws into them, and whether the fixed allocation is on at all
    // (`?alloc=0` turns it off).
    alloc: {
      fixed: fixedAllocationFor(composerCamera()),
      switchOn: fixedSceneAllocation,
      ratio: sceneAllocationRatioFor(composerCamera()),
      w: sceneRectsLive.alloc.width,
      h: sceneRectsLive.alloc.height,
      drawW: sceneRectsLive.draw.width,
      drawH: sceneRectsLive.draw.height,
    },
  };
}

/** What the scene-sized render targets hold, in bytes: the figure the byte
 *  budget is checked against, so a device can be asked what it is really
 *  holding. From the ALLOCATION, not the rung — under Dynamic they are the
 *  ladder's top rung at every rung, which is the memory the fixed allocation
 *  trades for the step. Zero with no composer. */
function qualityRenderTargetBytes(): number {
  if (!sceneTarget) return 0;
  return renderTargetBytes(
    viewportSize().width, viewportSize().height, sceneAllocationRatioFor(composerCamera()), sceneTarget.samples,
    !fusedFinalOn(),
  );
}

updateSceneRatioRequest();
refreshQualityPin();

// ================================================================
// Frame rate
// ================================================================
// How often the loop DRAWS (app/frameCadence.ts) against what the user asked
// for (app/frameRateSetting.ts). "Screen", the default, paces nothing: every
// callback draws and the resolution controller keeps its own 60 fps budget at
// and below Medium. What the default does tell the controller is the display's
// own tick, which is what a rung ABOVE Medium is held to — and on a display
// with no finer tick than 60 fps it tells it there is none, so Dynamic there
// is Medium and below. A target is pacing PLUS a budget the app then defends
// with pixels in both directions — `setBudget` below is the only door.

/** The row's value this session: the URL's word, else the saved one, else
 *  Screen. */
let frameRate: FrameRate = resolveBootFrameRate(location.search);
/** True where this boot's URL named a frame rate. A capture pin then leaves
 *  the cap alone: a run under `?fps=` is a run ABOUT the pacing, and it waits
 *  on a draw (`__moon.waitForDraw`) instead of on two callbacks. */
const frameRateFromUrl = new URLSearchParams(location.search).has('fps');
const frameCadence = new FrameCadence({
  screen: isScreenRate(frameRate),
  requestedMs: requestedMsFor(frameRate),
  // DEV `?refresh=<hz>`: be a 120 Hz screen on a 60 Hz one.
  pinnedCadenceMs: parseRefreshParam(location.search, import.meta.env.DEV),
});
/** Frames the world was drawn in, and animation callbacks taken. */
let drawSeq = 0;
let tickSeq = 0;
/** A draw asked for out of band — the one painted frame a cover has to show
 *  before it lifts. Consumed by the next tick, whatever the cadence says. */
let forcedDrawRequest = false;
/** The `?perf=1` sweep's run, and a capture pin: both count callbacks against
 *  the wall clock, so for their duration every callback draws. Kept apart
 *  from `pixelRatioPin`, which `?ratio=` and a capture pin share — pixels and
 *  pacing are different questions. */
let frameCapSweepHold = false;
let frameCapCaptureHold = false;

function frameCapHeld(): boolean {
  if (frameCapSweepHold) return true;
  if (import.meta.env.DEV && gpuProfiler?.active) return true;
  return frameCapCaptureHold && !frameRateFromUrl;
}

/** What is holding the cap open, for the readout. */
function frameCapHeldBy(): string | null {
  if (frameCapSweepHold) return 'the perf sweep';
  if (import.meta.env.DEV && gpuProfiler?.active) return 'the GPU profile';
  if (frameCapCaptureHold && !frameRateFromUrl) return 'a capture pin';
  return null;
}

/**
 * Tell the resolution controller what a frame is now measured against, and say
 * so once through debugLog so `?debug=1` answers it on a phone.
 *
 * Only a real move of what the controller is held to disturbs it: under Screen
 * on a 60 Hz display that is the constant it has always held and nothing here
 * reaches it; on a faster display the calibrated tick reaches it once, as the
 * bar a sharper rung is measured against.
 */
function applyCadenceChange(cause: 'user' | 'auto'): void {
  const change = frameCadence.takeChange();
  if (change === null) return;
  const fps = change.readout;
  if (change.budgetChanged) {
    resolutionController.setBudget(fps.budgetMs, performance.now(), {
      cause: cause === 'user' ? 'user' : change.cause,
      quantised: frameCadence.quantised,
      above: { budgetMs: fps.sharperBudgetMs, allowed: fps.sharperAllowed },
    });
  }
  const hz = Math.round(1000 / fps.idleCadenceMs);
  const every = fps.ticksPerDraw === 1 ? 'every tick'
    : fps.ticksPerDraw === 2 ? 'every 2nd tick'
      : fps.ticksPerDraw === 3 ? 'every 3rd tick'
        : `every ${fps.ticksPerDraw}th tick`;
  debugLog('Frame rate', {
    requested: fps.requested,
    screen: `${hz} Hz${fps.assumed ? ' (assumed)' : ''}${fps.pinned ? ' (pinned)' : ''}`,
    draws: `${every}, ${Math.round(fps.periodMs * 10) / 10} ms`,
    delivering: fps.observedCadenceMs === null ? null : `${Math.round(1000 / fps.observedCadenceMs)}/s`,
    budgetMs: Math.round(fps.budgetMs * 100) / 100,
    // What a rung above Medium is held to, or that none is taken on its own.
    sharper: fps.sharperAllowed ? `${Math.round(fps.sharperBudgetMs * 100) / 100} ms` : 'Medium and below',
    capped: fps.capped,
  });
}

/**
 * The Frame rate row, changed. Saves the choice on its own key — never in the
 * journey save, so New Journey and a restore leave it alone — and re-derives
 * the schedule. A settings change never moves the rung by itself; what it
 * moves is the budget the next window is judged against.
 */
function setFrameRate(rate: FrameRate): void {
  if (rate === frameRate) return;
  frameRate = rate;
  writeFrameRate(rate);
  frameCadence.setRate(isScreenRate(rate), requestedMsFor(rate));
  applyCadenceChange('user');
}

// The draw log: the last draws as the pacing gate reads them — which frame,
// which animation callback it landed on, when the browser scheduled it, when
// the callback ran, and what that tick cost. The callback number is what makes
// the schedule checkable at all: a draw interval in milliseconds carries the
// browser's own scheduling noise, where "exactly N callbacks apart" is a
// property of the schedule and nothing else. Preallocated and written on the
// render path, so it allocates nothing; DEV only, like every other bridge
// reading.
const DRAW_LOG_SIZE = 1200;
const drawLogSeq = new Float64Array(DRAW_LOG_SIZE);
const drawLogTick = new Float64Array(DRAW_LOG_SIZE);
const drawLogT = new Float64Array(DRAW_LOG_SIZE);
const drawLogNow = new Float64Array(DRAW_LOG_SIZE);
const drawLogBusy = new Float64Array(DRAW_LOG_SIZE);
let drawLogHead = 0;
let drawLogCount = 0;

function recordDraw(t: number, nowMs: number, busyMs: number): void {
  drawLogSeq[drawLogHead] = drawSeq;
  drawLogTick[drawLogHead] = tickSeq;
  drawLogT[drawLogHead] = t;
  drawLogNow[drawLogHead] = nowMs;
  drawLogBusy[drawLogHead] = busyMs;
  drawLogHead = (drawLogHead + 1) % DRAW_LOG_SIZE;
  if (drawLogCount < DRAW_LOG_SIZE) drawLogCount++;
}

interface DrawLogEntry { drawSeq: number; tickSeq: number; t: number; nowMs: number; busyMs: number }

function readDrawLog(n: number): DrawLogEntry[] {
  const want = Math.max(0, Math.min(Math.floor(n), drawLogCount));
  const out: DrawLogEntry[] = [];
  for (let i = want; i > 0; i--) {
    const at = (drawLogHead - i + DRAW_LOG_SIZE) % DRAW_LOG_SIZE;
    out.push({
      drawSeq: drawLogSeq[at],
      tickSeq: drawLogTick[at],
      t: drawLogT[at],
      nowMs: drawLogNow[at],
      busyMs: drawLogBusy[at],
    });
  }
  return out;
}

try {
  const gl = renderer.getContext();
  debugLog('Renderer ready', {
    shadowMap: renderer.shadowMap.enabled,
    useBloom,
    canvasSamples,
    screenSamples,
    sceneSamples: getSceneTargetSamples(getTargetPixelRatio()),
    sceneSampleCounts,
    isMobile,
    quality: qualityLevel,
    deviceClass,
    devicePlatform,
    glVersion: gl.getParameter(gl.VERSION),
    shadingLanguage: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
  });
} catch (err) {
  debugWarn('Unable to inspect WebGL context details', err);
}

const scene = new THREE.Scene();
// Every mode starts from black; one colour object serves all of them.
const MODE_BACKGROUND = new THREE.Color(0x000000);
scene.background = MODE_BACKGROUND;

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
// --- Look-inside camera (studio scale: body radius = 1 unit; the orbit never
// comes inside 1.55, so the near plane can sit well out for depth precision
// where the section faces meet the skin) ---
const interiorCamera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.05, 300);

let camera: THREE.PerspectiveCamera = planetariumCamera;

// ================================================================
// Post-processing (bloom enabled based on actual GPU capability)
// ================================================================
debugLog('Post-processing config', { useBloom });

let composer: EffectComposer | null = null;
/** The composer target RenderPass draws the scene into (buildComposer). */
let sceneTarget: THREE.WebGLRenderTarget | null = null;
/** What the scene-sized targets are allocated at, in device pixels, and where
 *  the frame sits inside that (app/sceneSubRect.ts). Zeroed on every composer
 *  build, so the first size always reaches the targets. */
let sceneAllocSize: TargetSize = { width: 0, height: 0 };
let sceneRectsLive: SceneRects = sceneRects({ width: 1, height: 1 }, { width: 1, height: 1 });
/** The last clamp reported, so a tripwire that stays tripped says so once. */
let sceneRectClampSaid = '';
/** The sub-rect uniforms of the two passes that read a scene-sized target and
 *  are not ours to declare: the lens pass and the bloom bright pass. The
 *  finishing pass carries its own (app/UpscalePass.ts). */
let lensSubRect: SubRectUniforms | null = null;
let bloomSubRect: SubRectUniforms | null = null;
/** The lens warp's four uniforms on the fused chain, shared by the two
 *  materials that read the scene image (app/LensPass.ts). Null where the
 *  composer carries no warp, and on the `?fused=0` chain, where a lens pass of
 *  its own owns them. */
let composerLens: LensUniforms | null = null;
// Whether a frame draws the world at all: under the loading screen only on
// request, every frame once revealed, never after a boot failure
// (app/bootRenderGate.ts). The simulation runs every frame regardless.
const bootRender = new BootRenderGate();
let bloomPass: UnrealBloomPass | null = null;
/** The live bloom pass's real `setSize`, held away from the composer's resize
 *  cascade (app/bloomTargets.ts holdBloomSize); null while there is no bloom
 *  pass. sizeBloomPass is the only caller. */
let sizeBloomChain: ((width: number, height: number) => void) | null = null;
let depthDiscardPass: DepthDiscardPass | null = null;
let lensPass: ReturnType<typeof createLensPass> | null = null;
// The finishing pass and, on the planetarium's composer, the upscaler's two
// after it (app/UpscalePass.ts); all three disposed with the composer.
let outputTargetPass: OutputTargetPass | null = null;
let upscalePass: UpscalePass | null = null;
let sharpenPass: SharpenPass | null = null;
let downsamplePass: DownsamplePass | null = null;
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

// The direct paths' screen target (app/screenTarget.ts): where the canvas has
// no samples, the no-float lens path and the bare direct path draw into this
// and copy across, exactly the bytes they used to draw onto the sampled
// canvas. Sized to the drawing buffer on every use; built by buildComposer's
// direct branches and dropped with them.
let screenTarget: THREE.WebGLRenderTarget | null = null;
let screenCopy: ScreenCopy | null = null;

function ensureScreenTarget(): THREE.WebGLRenderTarget {
  renderer.getDrawingBufferSize(directLensSize);
  if (!screenTarget) screenTarget = createScreenTarget(directLensSize.x, directLensSize.y, screenSamples, { stencil: true, linear: true });
  else fitScreenTarget(screenTarget, directLensSize.x, directLensSize.y);
  return screenTarget;
}

function ensureScreenCopy(): ScreenCopy {
  return (screenCopy ??= new ScreenCopy());
}

/** Capture pins (pinCapture): a golden has to be reproducible, and three of
 *  the things that decide its pixels move on their own — the near plane is
 *  driven by the cruise governor, the exposure by the Sun's on-screen state,
 *  the pixel ratio by the display. DEV-only, null when nothing is pinned. */
let exposurePin: number | null = null;

function getTargetPixelRatio(): number {
  if (pixelRatioPin !== null) return pixelRatioPin;
  return targetPixelRatio(window.devicePixelRatio, isMobile, supersampleFallback);
}

/** The ratio a composer built for `cam` draws its scene at
 *  (app/renderResolution.ts renderPixelRatio): below the output ratio only
 *  with the upscaler on, and only for the planetarium's own composer — the
 *  other modes' composers, and the direct path, stay at the output ratio. */
function scenePixelRatioFor(cam: THREE.Camera, outputRatio: number): number {
  return cam === planetariumCamera ? renderPixelRatio(outputRatio, upscaleRenderRatio) : outputRatio;
}

/** The ratio the live frame's scene is drawn at. */
function getScenePixelRatio(): number {
  const outputRatio = getTargetPixelRatio();
  return composer ? scenePixelRatioFor(composerBuiltFor?.cam ?? camera, outputRatio) : outputRatio;
}

function getSceneTargetSamples(pixelRatio: number): number {
  // The scene target's size in device pixels, floored as GL sizes the
  // storage (a GLsizei truncates): the policy's 4K budget reads it.
  const viewport = viewportSize();
  const devicePixels = Math.floor(viewport.width * pixelRatio) * Math.floor(viewport.height * pixelRatio);
  return composerSamples(pixelRatio, isMobile, devicePixels, msaaOverride, sceneSampleCounts);
}

/** Whether the frame's scene draw is multisampled on the current path. The
 *  composer's scene target carries its own sample count, which can be zero;
 *  the direct path draws into the canvas backbuffer, created with antialias
 *  but granted samples only at the browser's discretion. The Look-inside tool
 *  reads this to choose how its cut edge is antialiased (plan §5). */
function sceneDrawMultisampled(): boolean {
  if (sceneTarget) return sceneTarget.samples > 0;
  const gl = renderer.getContext();
  return (gl.getParameter(gl.SAMPLES) as number) > 0;
}

function applyRenderResolution() {
  const pixelRatio = getTargetPixelRatio();
  renderer.setPixelRatio(pixelRatio);
  // The canvas's box, and the drawing buffer alone: the stylesheet owns the
  // box (canvas.scene-canvas is the fixed-position rect), so three must not
  // write a width and height in px over it — a box pinned in px would stop
  // following the rect, and the observer in syncViewport would never hear of
  // the next change.
  const viewport = viewportSize();
  renderer.setSize(viewport.width, viewport.height, false);
  if (composer && sceneTarget) {
    // A page zoom, a move to another monitor or a resize across the 4K
    // budget can change the sample count: retarget it and drop the GL
    // objects so the next bind allocates the new layout (setSize alone only
    // disposes on a dimension change). The count comes off the OUTPUT ratio,
    // so a quality level or a Dynamic rung never changes it.
    const samples = getSceneTargetSamples(pixelRatio);
    if (sceneTarget.samples !== samples) {
      sceneTarget.samples = samples;
      sceneTarget.dispose();
    }
    // The composer is sized at the scene ratio: the output ratio, or either
    // side of it at the quality level's own ratio (app/UpscalePass.ts), in
    // which case the last passes carry the frame across to the canvas the
    // renderer was just sized to.
    sizeComposerToScene(composerCamera());
    sizeBloomPass();
  }
}

/** The camera the live composer was built for — the planetarium's, except
 *  inside another mode. */
function composerCamera(): THREE.Camera {
  return composerBuiltFor?.cam ?? camera;
}

/**
 * Whether the scene-sized targets are allocated once at the ladder's top rung
 * and every rung drawn into a sub-rectangle of them (app/sceneSubRect.ts).
 *
 * Dynamic only: a fixed level never steps, so it would pay the memory for
 * nothing and Medium stays today's frame by construction rather than by
 * measurement. The planetarium's composer only: no other mode draws at a ratio
 * of its own, and entering the Look-inside tool would otherwise allocate the
 * ladder's top rung twice a visit. And not while a measurement pin owns the
 * scene ratio — a pin can ask for a ratio outside the ladder altogether, so it
 * allocates for itself and hands the allocation back on release.
 */
function fixedAllocationFor(cam: THREE.Camera): boolean {
  return fixedSceneAllocation
    && cam === planetariumCamera
    && qualityLevel === 'dynamic'
    && !upscalePinned;
}

/** The ratio those targets are ALLOCATED at, as against the one being drawn. */
function sceneAllocationRatioFor(cam: THREE.Camera): number {
  return allocationSceneRatio(
    scenePixelRatioFor(cam, getTargetPixelRatio()),
    qualityLadderLive,
    fixedAllocationFor(cam),
  );
}

/**
 * Size the composer's targets, and point the frame at its sub-rectangle of
 * them.
 *
 * In explicit DEVICE pixels with the composer's own pixel ratio held at 1:
 * three multiplies the size it is given by that ratio with no flooring, and
 * GL stores a target with a GLsizei, so a fractional ratio through the
 * composer's own multiply leaves the target's recorded width a fraction above
 * the storage the driver made — and the resample's uniforms are derived from
 * that width. Every writer of the composer's size goes through this one
 * function, or a resize would re-derive a different size from a rung change.
 *
 * The targets are re-sized only when the ALLOCATION moved, which under Dynamic
 * is a resize, a level change or a pin — never a rung. A rung change reaches GL
 * as a viewport and a few uniforms and moves no memory at all, which is the
 * whole of the fixed allocation.
 */
function sizeComposerToScene(cam: THREE.Camera): void {
  if (!composer) return;
  const viewport = viewportSize();
  const alloc = sceneTargetSize(viewport.width, viewport.height, sceneAllocationRatioFor(cam));
  if (alloc.width !== sceneAllocSize.width || alloc.height !== sceneAllocSize.height) {
    composer.setSize(alloc.width, alloc.height);
    sceneAllocSize = alloc;
  }
  const draw = sceneTargetSize(viewport.width, viewport.height, scenePixelRatioFor(cam, getTargetPixelRatio()));
  applySceneViewports(draw.width, draw.height);
}

/**
 * Point the scene-sized targets at the sub-rectangle the frame is drawn into:
 * the scene target, the composer's ping-pong partner and the finishing pass's
 * LDR target.
 *
 * The ONLY writer of those three targets' viewport, scissor box and scissor
 * test. `RenderTarget.setSize` resets both rectangles to the whole target every
 * time it is called — even when the size is unchanged — so this runs after
 * every size, and nothing else may write them: a frame drawn at the whole
 * allocation with the resample's uniforms still on the sub-rect is a garbage
 * frame rather than a crash.
 *
 * The origin is (0, 0) and that is load-bearing rather than a convention: the
 * point-sprite kernel every star and moon dot runs and the resample shaders
 * read `gl_FragCoord` as framebuffer-absolute and divide by a size derived
 * from the CSS box and the scene ratio, so a centred sub-rect would misplace
 * every sprite and every tap.
 *
 * A draw larger than its allocation is clamped and said out loud rather than
 * drawn: GL clips a viewport larger than its framebuffer in silence, and the
 * frame would come out short with every uniform believing otherwise.
 */
function applySceneViewports(width: number, height: number): void {
  if (!composer || !sceneTarget) return;
  const rects = sceneRects(sceneAllocSize, { width, height });
  if (rects.clamped) {
    const said = `${width}x${height} in ${sceneAllocSize.width}x${sceneAllocSize.height}`;
    if (said !== sceneRectClampSaid) {
      sceneRectClampSaid = said;
      debugWarn('The scene is drawn larger than the targets allocated for it', said);
    }
  }
  sceneRectsLive = rects;
  const { width: w, height: h } = rects.draw;
  // Made now under a fixed allocation, because a rung change must not be the
  // first thing that ever binds it; left lazy otherwise, so a build that never
  // resamples allocates nothing.
  const ldr = outputTargetPass?.ensureTarget(
    rects.alloc.width, rects.alloc.height, fixedAllocationFor(composerCamera()),
  ) ?? null;
  for (const target of [sceneTarget, composer.renderTarget2, ldr]) {
    if (!target) continue;
    target.viewport.set(0, 0, w, h);
    target.scissor.set(0, 0, w, h);
    // Off where the frame fills its target: that is the state three leaves a
    // target in, and the frame it draws there is the one that shipped.
    target.scissorTest = w < target.width || h < target.height;
  }
  // Every reader of a scene-sized target, told where inside it to look.
  applySubRect(lensSubRect, rects);
  applySubRect(bloomSubRect, rects);
  applySubRect(outputTargetPass?.subRect ?? null, rects);
}

// The composer sizes every pass at the scene's size; the bloom chain is sized
// separately at its own ratio (app/renderResolution.ts bloomPixelRatio: the
// renderer's old floor, kept for the chain alone), so the glow keeps the width
// and the cost it had on every display. This is the chain's ONLY writer — the
// composer's cascade is held off the instance (app/bloomTargets.ts
// holdBloomSize), because sizing eleven half-float targets to the scene and
// back is the whole cost of a resolution step.
function sizeBloomPass() {
  const ratio = bloomPixelRatio(window.devicePixelRatio, isMobile);
  const viewport = viewportSize();
  sizeBloomChain?.(viewport.width * ratio, viewport.height * ratio);
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

// What the live composer was built for: an identical request is a no-op.
// The boot builds one at module load and the first mode switch asked for the
// same one again, which threw away every pass program only to relink it on
// the next frame.
let composerBuiltFor: { cam: THREE.Camera; bloom: object; enabled: boolean; lens: number } | null = null;

function buildComposer(
  cam: THREE.Camera,
  bloom: { strength: number; threshold: number },
  enabled = useBloom,
) {
  const built = composerBuiltFor;
  if (
    composer && built && built.cam === cam && built.bloom === bloom &&
    built.enabled === enabled && built.lens === lensRequestedStrength
  ) {
    return;
  }
  composerBuiltFor = null;
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
  sizeBloomChain = null;
  lensSubRect = null;
  bloomSubRect = null;
  composerLens = null;
  // Nothing is allocated yet, so the first size below always reaches GL.
  sceneAllocSize = { width: 0, height: 0 };
  depthDiscardPass = null;
  outputTargetPass = null;
  upscalePass = null;
  sharpenPass = null;
  downsamplePass = null;
  directLensTexture?.dispose();
  directLensTexture = null;
  screenTarget?.dispose();
  screenTarget = null;

  // Whichever path is taken below, its passes (or, straight to canvas, the
  // scene's own materials) link their programs on the first render that uses
  // them: have that happen under the loading screen, not on the first visible
  // frame. Requested here rather than at the end because the early returns
  // are builds too — the gate only raises a flag, and the draw comes on a
  // later animation frame, once this build has finished.
  bootRender.requestCoveredRender();

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

  // No float FBO: render to a screen target first (or, with the canvas
  // sampled, straight to the canvas), where Three applies the normal HDR tone
  // map, then lens-resample those display-referred bytes to screen in
  // renderScene(). This avoids the release-blocking HDR clamp caused by
  // rendering linear light into RGBA8.
  if (wantsLens && !useBloom) {
    planetariumLens.strength = lensRequestedStrength;
    lensPass = createLensPass();
    lensPass.renderToScreen = true;
    if (canvasSampled) ensureDirectLensTexture();
    else ensureScreenTarget();
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
  // Sized at the scene ratio: the output ratio unless this is the
  // planetarium's composer with the upscaler on (scenePixelRatioFor).
  const outputRatio = getTargetPixelRatio();
  sceneTarget = new THREE.WebGLRenderTarget(viewportSize().width, viewportSize().height, {
    type: THREE.HalfFloatType,
    stencilBuffer: true,
    // From the OUTPUT ratio, and held there across every quality level and
    // every Dynamic rung: the policy's count has two step functions inside
    // the range a slide traverses, so a count that followed the scene ratio
    // would change the antialiasing character mid-slide and re-allocate the
    // whole target — and on a scaled Windows display it would hand the
    // cheaper rung MORE multisampled storage than the one above it.
    samples: getSceneTargetSamples(outputRatio),
    resolveDepthBuffer: false,
  });
  composer = new EffectComposer(renderer, sceneTarget);
  // The composer clones the scene target for its ping-pong partner. Only
  // full-screen quads ever land there (on the `?fused=0` chain: the lens
  // output, bloom's composite), so it carries neither the samples nor the
  // depth/stencil planes: a single-sample colour buffer. renderScene keeps the
  // scene target in the read slot, the one RenderPass draws into. On the fused
  // chain no pass swaps and nothing ever binds the partner, so three — which
  // allocates a target's GL objects on the first bind — gives it no storage at
  // all; `perfTargets().composerPartner.allocated` is the reading of that.
  // (On `?fused=0` without a lens pass — flight, compare, Look inside —
  // bloom's composite blends into the scene target itself, so those modes
  // resolve it twice a frame; accepted, all three are small scenes, and the
  // fused chain does not do it.)
  const partner = composer.renderTarget2;
  partner.samples = 0;
  partner.depthBuffer = false;
  partner.stencilBuffer = false;
  // The composer's own ratio stays at 1 for the life of the chain and every
  // size it is given is in device pixels (sizeComposerToScene).
  composer.setPixelRatio(1);
  // The allocation, decided here under the loading screen rather than on a
  // later climb: a lazy allocation would pay exactly the hitch the fixed one
  // exists to delete, in front of the user, on a device the rule has just
  // found fast. The passes are sized again at the end of the build, once they
  // all exist.
  sizeComposerToScene(cam);
  composer.addPass(new RenderPass(scene, cam));
  // The world's depth and stencil have no reader past this point
  // (app/DepthDiscardPass.ts). Enabled/disabled rather than added/removed, so
  // the A/B never rebuilds the chain it is being measured against.
  depthDiscardPass = new DepthDiscardPass();
  depthDiscardPass.enabled = import.meta.env.DEV ? perfSwitchOn('depth-discard') : true;
  composer.addPass(depthDiscardPass);

  // One finishing pass for the warp, the glow and the tone curve, or the three
  // full-resolution passes that came before it (app/FusedOutputPass.ts). Both
  // chains ship, because `?fused=0` is the kill switch for the one item that
  // cannot promise exactly the same pixels.
  const fused = fusedFinalOn();

  if (wantsLens) {
    planetariumLens.strength = lensRequestedStrength;
    if (fused) {
      // No pass of its own: the warp is four uniforms and one GLSL function
      // inside the two shaders that read the scene image, and one shared set of
      // uniform objects keeps them from warping differently.
      composerLens = makeLensUniforms();
    } else {
      lensPass = createLensPass();
      lensSubRect = lensSubRectUniforms(lensPass);
      composer.addPass(lensPass);
    }
  } else {
    planetariumLens.strength = 0;
  }
  applyDesignFov(planetariumCamera, planetariumLens.designFovDeg);

  // Bloom is output-space: the lens first makes a round limb, then the blur
  // builds an isotropic PSF around those final pixels. Screen-authored scene
  // primitives pre-distort themselves into the source (lensShader.ts), so their
  // sizes also remain invariant through this ordering. The fused chain keeps
  // that ordering by warping the bright pass's own read, so every mip is the
  // picture the blur chain had when a lens pass ran first.
  if (enabled) {
    const size = new THREE.Vector2(viewportSize().width, viewportSize().height);
    bloomPass = fused
      ? new BloomChainPass(size, bloom.strength, BLOOM_RADIUS, bloom.threshold)
      : new UnrealBloomPass(size, bloom.strength, BLOOM_RADIUS, bloom.threshold);
    // Its eleven internal targets come with a depth plane nothing in the pass
    // tests or writes (app/bloomTargets.ts). Applied here rather than at the
    // switch, because a rebuild makes a fresh pass with three's defaults back.
    setBloomInternalDepth(bloomPass, import.meta.env.DEV ? !perfSwitchOn('bloom-nodepth') : false);
    // The one material in the chain that reads the buffer the scene was drawn
    // into: patched before its first render, so the bright pass takes the
    // sub-rectangle's content and not the allocation's (app/sceneSubRect.ts) —
    // through the warp where the composer carries one.
    bloomSubRect = composerLens
      ? (bloomPass as BloomChainPass).installLensWarp(composerLens)
      : patchUvScale(bloomHighPassMaterial(bloomPass), HIGH_PASS_UV_ANCHOR);
    // Before the pass joins the chain: addPass sizes it too.
    sizeBloomChain = holdBloomSize(bloomPass);
    composer.addPass(bloomPass);
    sizeBloomPass();
  }

  // The finishing pass, and on the planetarium's composer — the one whose
  // scene ratio can sit either side of the canvas's — the three resample
  // passes after it (app/UpscalePass.ts). With all three disabled the
  // finishing pass is the last enabled pass and draws the canvas exactly as
  // OutputPass did; enabled (applyUpscalePasses, from the live state) they
  // take the frame from its own target across to the canvas. Never more than
  // one direction at a time, which is why the downsample can sit last: three
  // gives the canvas to the last ENABLED pass every render.
  outputTargetPass = fused
    ? new FusedOutputPass({
      bloom: bloomPass ? (bloomPass as BloomChainPass) : null,
      lens: composerLens,
    })
    : new OutputTargetPass();
  composer.addPass(outputTargetPass);
  if (cam === planetariumCamera) {
    upscalePass = new UpscalePass(outputTargetPass);
    sharpenPass = new SharpenPass(upscalePass);
    downsamplePass = new DownsamplePass(outputTargetPass);
    downsamplePass.setFilter(downsampleFilter);
    composer.addPass(upscalePass);
    composer.addPass(sharpenPass);
    composer.addPass(downsamplePass);
  }
  composerBuiltFor = { cam, bloom, enabled, lens: lensRequestedStrength };
  // Every pass exists now: the same rectangle again, this time reaching the
  // finishing pass's own target and the three sampling sites' uniforms.
  sizeComposerToScene(cam);
  applyUpscalePasses();
}

/** Which side of the canvas the live frame's scene is drawn on: smaller
 *  (resampled up), the same (nothing between the tone map and the canvas), or
 *  larger (averaged down). A pass costs a whole canvas of fill, so the
 *  comparison is exact — a ratio a hair off its own output ratio must read as
 *  native rather than buy two passes for nothing. */
type SceneRatioMode = 'upscale' | 'native' | 'supersample';

function sceneRatioMode(): SceneRatioMode {
  if (composer === null || composerBuiltFor?.cam !== planetariumCamera) return 'native';
  const outputRatio = getTargetPixelRatio();
  const sceneRatio = getScenePixelRatio();
  if (sceneRatio < outputRatio - 1e-6) return 'upscale';
  if (sceneRatio > outputRatio + 1e-6) return 'supersample';
  return 'native';
}

/** Whether the live frame's scene is drawn below the output ratio. */
function upscaleActive(): boolean {
  return sceneRatioMode() === 'upscale';
}

/**
 * RCAS's stops for the frame as it stands: whatever `?sharpen=` or the bridge
 * pinned, else the stops measured for the factor this frame is being upscaled
 * by. Null means RCAS off, which only a pin can ask for.
 *
 * The factor is the live one rather than the level's, so a Dynamic rung
 * carries the stops its own depth was calibrated at — one stop matched at 4/3
 * reads five per cent sharper than native at 1.15, and a step that comes out
 * sharper than the frame before it is the one thing a rung change must not do.
 */
function upscaleSharpenStopsLive(): number | null {
  if (upscaleSharpenPinned) return upscaleSharpenStops;
  const sceneRatio = getScenePixelRatio();
  if (!(sceneRatio > 0)) return RCAS_DEFAULT_STOPS;
  return rcasStopsForFactor(getTargetPixelRatio() / sceneRatio);
}

/**
 * Point the resample passes at the live state: EASU on when the scene is
 * below the output ratio and the filter is EASU — the bilinear control arm is
 * no pass at all, the finishing pass drawing the smaller buffer straight to
 * the canvas through the composer target's own linear filter — RCAS after it
 * unless the stops are null, and the downsample alone when the scene is above
 * the output ratio (never RCAS: a shrink does not need its edges put back).
 *
 * Enable and disable only. No pass is added or removed, no material is rebuilt
 * and the raw shaders ignore the destination's colour space, so nothing
 * relinks here — which is why a rung change is cheap, and why it needs no
 * covered render to hide a compile.
 */
function applyUpscalePasses(): void {
  const mode = sceneRatioMode();
  const easu = mode === 'upscale' && upscaleFilter === 'easu';
  if (upscalePass) upscalePass.enabled = easu;
  if (sharpenPass) {
    const stops = upscaleSharpenStopsLive();
    sharpenPass.enabled = easu && stops !== null;
    sharpenPass.setSharpness(stops ?? RCAS_DEFAULT_STOPS);
  }
  if (downsamplePass) {
    downsamplePass.enabled = mode === 'supersample';
    downsamplePass.setFilter(downsampleFilter);
  }
  // Said through debugLog, so a phone's ?debug=1 overlay answers which of the
  // three a frame is on: Safari's address bar hides the query that asked for
  // it, and a screenshot of the stats cannot tell them apart.
  if (upscalePass) debugLog('Upscale', upscaleState());
}

/**
 * Draw the scene at a new ratio, and change nothing else.
 *
 * The narrow path. The resize path (syncViewport) exists for a viewport that
 * really moved: it re-writes four cameras' aspects, re-derives the lens
 * overscan, re-sizes the renderer and its canvas, measures the map panel and
 * card — synchronous DOM layout — folds the phone's map sheet when the body
 * card is up, and logs a Resize line. None of that has anything to do with
 * the scene's ratio, and a Dynamic step going through it would fold the sheet
 * under the user's finger several times a minute.
 *
 * So a ratio change does exactly four things: point the scene-sized targets at
 * the sub-rectangle the new ratio draws into, point the resample passes at the
 * new direction, retune the three point sizes that are authored in the scene's
 * own framebuffer pixels, and say so once. Under Dynamic the targets are
 * already the size they need to be (app/sceneSubRect.ts), so nothing is
 * allocated or freed at all; at a fixed level the allocation follows the
 * level, which is a click rather than a step. The sample count is not touched
 * (it comes off the output ratio), the bloom chain is not touched (its size is
 * held away from the composer's cascade), the renderer and the canvas are not
 * touched (the output ratio has not moved), and nothing is added to or removed
 * from the chain, so no program relinks.
 */
function applySceneResolution(why: string): void {
  updateSceneRatioRequest();
  const sceneRatio = getScenePixelRatio();
  sizeComposerToScene(composerCamera());
  applyUpscalePasses();
  planetariumMode?.onScenePixelRatioChanged();
  debugLog('Quality', {
    why,
    level: qualityLevel,
    rung: resolutionController.rung,
    sceneRatio,
    outputRatio: getTargetPixelRatio(),
    mode: sceneRatioMode(),
    sceneDraw: `${sceneRectsLive.draw.width}x${sceneRectsLive.draw.height}`,
    sceneAlloc: sceneTarget ? `${sceneTarget.width}x${sceneTarget.height}` : null,
    mb: Math.round(qualityRenderTargetBytes() / 1e5) / 10,
    gpu: gpuClockLine(),
  });
}

// --- Dynamic's per-frame evidence -------------------------------------------
//
// The controller is pure and stepped once a frame with one interval; these are
// the figures main has to keep from one frame to the next to describe it.

/** The wall clock at the previous DRAW's callback: the interval's start. */
let lastFrameAtMs = performance.now();
/** The previous TICK's own main-thread time, loop start to end of its work. */
let loopBusyMs = 0;
/** The longest single tick since the last draw, and all of them added up. A
 *  draw may cover several ticks, and the two figures answer different
 *  questions: the longest is the one that slipped a callback (exclusion), the
 *  sum is the CPU's share of the whole interval (headroom). */
let busyMaxSinceDraw = 0;
let busySumSinceDraw = 0;
/** Sliced work charged on a tick main.ts owns rather than the mode: a program
 *  link. Accumulated across the skipped ticks and taken at the draw, because
 *  a link on a skipped tick is still work inside the interval. */
let linkWorkMs = 0;
/** Programs linked as of the previous tick: a tick whose count grew paid a
 *  link inside it. */
let lastProgramCount = 0;
/** Whether the previous frame's endpoint was eligible. An interval needs BOTH
 *  of its endpoints to be, or a resume's first interval — which spans the
 *  whole time the tab was away — would be counted as the scene's own. */
let lastFrameEligible = false;
/** Whether an arrival veil was up in the previous frame, so its coming down
 *  can be reported once. */
let arrivalVeilWasUp = false;
/** Seeded true and tracked by events rather than polled: a page reached from
 *  a link that was never clicked reports no focus while animating perfectly
 *  well, and polling document.hasFocus() would exclude every frame of the
 *  session with no symptom but a Dynamic that never moves. */
let pageFocused = true;
/** Whether this tick's frame could count, as the step at its top judged it:
 *  what the GPU frame clock arms on at the end of the draw. */
let lastEligibleNow = false;
/** Whether the previous draw was one the GPU clock could not sample for a
 *  reason that is not the frame's cost. */
let lastClockSuspended = false;

// --- The GPU frame clock ----------------------------------------------------
//
// Where the display's tick cannot tell an 11 ms frame from a 16 ms one, the
// controller steers a rung above Medium by a fence reading of the frame
// instead (app/gpuFrameClock.ts). It samples only where the controller will
// read it; a reading is handed to the NEXT step and admitted there only if the
// interval of the frame it measured counted; and its own CPU is kept out of the
// tick's busy figures, the part of it that ran once the next frame was due
// reported as the interval's `sensorMs`.

/** A reading that finished since the last step, for that step to pair. */
let gpuPending: GpuObservation | null = null;
/** The sensor's CPU since the last step, and inside the current tick. */
let sensorSinceStep = 0;
let sensorTickMs = 0;
const gpuFrameClock = createGpuFrameClock({
  gl: renderer.getContext(),
  killed: parseGpuClockParam(location.search),
  onSample: (sample) => {
    gpuPending = {
      drawSeq: sample.drawSeq,
      generation: sample.generation,
      sampledAtMs: sample.sampledAtMs,
      readingMs: sample.readingMs,
      busyMs: sample.busyMs,
      starved: sample.starved,
    };
  },
  onWork: (ms, startedAtMs) => { sensorSinceStep += sensorWorkPastDue(ms, startedAtMs); },
  onDuty: (duty) => {
    // Readings taken at the old duty are dropped, and a reading still out
    // with them; the duty is what silence is judged at from now on.
    gpuPending = null;
    resolutionController.clearClockEvidence(performance.now(), duty);
    debugLog('GPU clock', { duty });
  },
  onDisabled: (reason) => {
    gpuPending = null;
    // Before the controller hears of it, and only where the sensor turned
    // itself off: a lost context is its own listener's to judge, and a
    // controller that turned the clock off already knows why.
    if (!contextLost && resolutionController.clockOff === null) rungMemorySensorOff(reason);
    resolutionController.setClockOff(reason);
    debugWarn('The GPU clock is off for this session', { reason });
  },
});
// No clock at all — `?gpuclock=0`, or no WebGL2 — is the rule as it was.
if (!gpuFrameClock.usable) resolutionController.setClockOff(gpuFrameClock.state().reason ?? 'no clock');

/**
 * The part of a stretch of the sensor's own CPU that ran after the next frame
 * was due — the current interval's start plus the budget. Only that part can
 * have held the next callback back: the poll loop's tasks between frames run
 * in time the main thread had spare, each a few microseconds long, and the
 * browser runs its rendering update between any two of them, so a task that
 * ran before the deadline delayed nothing. Counting it would call an interval
 * the 1 ms clock merely read as 17 or 18 "made late by the sensor" and throw
 * away its reading, which a sampled frame with a millisecond or two of polls
 * behind it almost always could be.
 */
function sensorWorkPastDue(ms: number, startedAtMs: number): number {
  const dueMs = lastFrameAtMs + resolutionController.clockBarMs;
  const endMs = startedAtMs + ms;
  return endMs <= dueMs ? 0 : Math.min(ms, endMs - dueMs);
}

/**
 * The GPU clock cannot sample this frame for a reason that is not the frame's
 * cost: the System Map is drawn instead of the scene, or a DEV measurement
 * (the GPU profile, the DEV clock) holds the GPU. The controller pauses the
 * clock's rules for it as it does for a hidden page, and re-earns the rung
 * after it; the frame's interval counts or not exactly as before.
 */
function clockSuspendedNow(): boolean {
  if (import.meta.env.DEV && (gpuProfiler?.active === true || gpuClock?.active === true)) return true;
  return appMode === 'planetarium' && (planetariumMode?.isMapOpen() ?? false);
}

/**
 * At the end of a drawn frame: the sensor flushes while the controller would
 * read it and fences the sampled frame. `wanted` is every condition under which
 * a reading could steer, and is decided first: on a frame where it is false
 * (and nothing from the bridge forces the sensor) no clock code runs at all —
 * no peek at the frame's work, no program count, no timing of its own.
 * `eligible` is whether this frame could count; `clean` is whether its own
 * tick did no sliced work and linked no program.
 */
function gpuClockAfterDraw(nowMs: number): void {
  sensorTickMs = 0;
  if (!gpuFrameClock.usable) return;
  if (contextLost) {
    gpuFrameClock.disable('the WebGL context was lost');
    return;
  }
  // The controller's view of the tick is only as good as the schedule's: a
  // display whose 60 Hz is still an assumption may be a 120 Hz panel. Under
  // the map or a DEV measurement no fence could be armed, so nothing is
  // flushed either.
  const suspended = clockSuspendedNow();
  const wanted = appMode === 'planetarium'
    && qualityLevel === 'dynamic'
    && !qualityIdle
    && !suspended
    && frameCadence.tickMeasured
    && resolutionController.wantsClock();
  if (!gpuFrameClock.activeFor(wanted)) return;
  const t0 = performance.now();
  const eligible = lastEligibleNow && appMode === 'planetarium' && !suspended;
  const clean = (planetariumMode?.peekFrameWork() ?? 1) === 0
    && (renderer.info.programs?.length ?? 0) === lastProgramCount;
  gpuFrameClock.afterDraw({
    drawSeq,
    callbackStartMs: nowMs,
    wanted,
    verifying: resolutionController.clockVerifying,
    eligible,
    clean,
    barMs: resolutionController.clockBarMs,
    generation: resolutionController.generation,
  });
  sensorTickMs = performance.now() - t0;
}

/**
 * The view a frame showed, named for the GPU clock's comparisons across a rung
 * change (app/stillViewName.ts): the body the ship rides, the camera's aim and
 * the displayed field of view, and no name while the view cannot be still.
 * Nothing is named on a frame where the clock could not use it — no sensor,
 * or a controller the clock cannot steer — so no clock code runs there.
 */
const stillView = new StillViewNamer();
function sceneKeyNow(): number | null {
  if (!gpuFrameClock.usable || !resolutionController.clockCanSteer) {
    stillView.forget();
    return null;
  }
  const body = appMode === 'planetarium' ? planetariumMode?.stillViewBody() ?? null : null;
  return stillView.name(body, camera.quaternion, displayFovDeg(camera));
}

/** The clock in a few characters for the `?debug=1` Quality line: the p90
 *  against the bar, the trusted readings in reach and the duty, or why it is
 *  off. */
function gpuClockLine(): string {
  const gpu = gpuFrameClock.state();
  const clock = resolutionController.state().clock;
  if (!gpuFrameClock.usable) return `off: ${gpu.reason ?? clock.off ?? 'unavailable'}`;
  if (!clock.steering) return 'not steering';
  const p90 = clock.p90Ms === null ? '–' : Number.isFinite(clock.p90Ms) ? clock.p90Ms.toFixed(1) : 'capped';
  return `${p90}/${clock.barMs.toFixed(1)} n=${clock.counted} duty ${gpu.duty}`;
}

// --- The remembered rung ------------------------------------------------------
//
// Where only the GPU clock can take a rung above Medium, a boot is told the
// rung the clock verified and held for a minute last time, and climbs straight
// there once its own first readings at Medium say the room is there
// (app/resolutionController.ts decides; app/rungMemory.ts keeps it). The entry
// is read ONCE, at the first frame the sensor itself could be armed — the tick
// measured, a live boot, the planetarium, Dynamic not pinned — because the
// controller says the clock may steer from the moment it is built, before the
// display's tick has been measured at all. A URL that changes what a pixel
// costs, pins a ratio or fixes a level neither reads it nor writes it:
// `?rungmemory=0` is the kill switch.

/** Why this boot's URL keeps the memory out of it, or null. */
const rungMemoryBlockedBy = rungMemoryUrlBlock(location.search);
const rungMemory = new RungMemoryMirror();
/** The entry was looked for, once a boot. */
let rungMemoryLooked = false;
/** The entry this boot was told, while it may still be climbed to. */
let rungMemoryArmed: RungMemoryEntry | null = null;
/** The entry this boot was told, for as long as its rung may still be on
 *  trial: a resize is checked against it then too. */
let rungMemoryTold: RungMemoryEntry | null = null;
/** Why this boot was told nothing, or null. */
let rungMemoryRefused: string | null = null;
/** This boot climbed to the rung it was told. */
let rungMemoryClimbed = false;
let rungMemoryRendererName: string | null = null;

/** The GPU as the entry names it: the unmasked renderer where the browser
 *  gives it, else the context's own word. */
function rungMemoryRenderer(): string {
  if (rungMemoryRendererName !== null) return rungMemoryRendererName;
  let name = deviceSignals.renderer;
  if (name === null) {
    try {
      const gl = renderer.getContext();
      const value = gl.getParameter(gl.RENDERER);
      name = typeof value === 'string' ? value : '';
    } catch {
      name = '';
    }
  }
  rungMemoryRendererName = name;
  return name;
}

/** The device as an entry describes it: read only when one is checked or
 *  written. */
function rungMemoryConfig(): RungMemoryConfig {
  const outputRatio = getTargetPixelRatio();
  return {
    tick: frameCadence.state().idleCadenceMs,
    outputRatio,
    pixels: viewportSize().width * viewportSize().height * outputRatio * outputRatio,
    renderer: rungMemoryRenderer(),
  };
}

function rungMemoryFacts(): RungMemoryFacts {
  return {
    ...rungMemoryConfig(),
    nowMs: Date.now(),
    ladder: qualityLadderLive.rungs,
    mediumIndex: qualityLadderLive.mediumIndex,
  };
}

/** Once a drawn frame: the one read, then the mirror, which does nothing unless
 *  the controller's memory moved. */
function rungMemoryStep(): void {
  if (rungMemoryBlockedBy !== null) return;
  if (!rungMemoryLooked) rungMemoryLook();
  if (rungMemoryArmed !== null && resolutionController.seedOutcome === 'abandoned') {
    // Used up by another change of rung, or by a new budget or ladder.
    debugLog('Rung memory', { unused: rungMemoryArmed.ratio });
    rungMemoryArmed = null;
  }
  const done = rungMemory.sync(resolutionController, rungMemoryConfig, Date.now());
  if (done === null) return;
  if (done === 'dropped') {
    rungMemoryArmed = null;
    debugLog('Rung memory', { dropped: 'the remembered rung failed before it had held a minute' });
  } else if (done === 'passed') {
    debugLog('Rung memory', { passed: 'the remembered rung held a minute' });
  } else {
    debugLog('Rung memory', { written: done.wrote });
  }
}

/** The first frame the sensor could be armed: read the entry and tell the
 *  controller, or say why not — deleting an entry that is wrong for every
 *  boot and keeping one that is wrong only for this configuration. */
function rungMemoryLook(): void {
  if (!gpuFrameClock.usable || appMode !== 'planetarium' || qualityLevel !== 'dynamic' || qualityIdle) return;
  if (bootRender.current !== 'live' || !frameCadence.tickMeasured || !resolutionController.clockCanSteer) return;
  rungMemoryLooked = true;
  const read = readRungMemory();
  if (read.malformed) {
    clearRungMemory();
    rungMemoryRefused = 'unreadable';
    debugLog('Rung memory', { refused: 'unreadable', deleted: true });
    return;
  }
  const entry = read.entry;
  if (entry === null) {
    rungMemoryRefused = 'nothing saved';
    return;
  }
  const verdict = rungMemoryApplies(entry, rungMemoryFacts());
  if (!verdict.ok) {
    if (verdict.discard) clearRungMemory();
    rungMemoryRefused = verdict.why;
    debugLog('Rung memory', { refused: verdict.why, ratio: entry.ratio, deleted: verdict.discard });
    return;
  }
  const why = resolutionController.remember(entry.ratio);
  if (why !== null) {
    rungMemoryRefused = why;
    debugLog('Rung memory', { refused: why, ratio: entry.ratio, deleted: false });
    return;
  }
  rungMemoryArmed = entry;
  rungMemoryTold = entry;
  debugLog('Rung memory', { applied: entry.ratio, savedAgoH: Math.round((Date.now() - entry.at) / 36e5) });
}

/** The climb to the remembered rung is being applied: it goes on trial first,
 *  so a boot that dies at that rung leaves the next one a reason to refuse it. */
function rungMemorySeedApplied(): void {
  if (rungMemoryArmed === null) return;
  rungMemoryClimbed = true;
  const marked = rungMemory.markTrial(rungMemoryArmed);
  debugLog('Rung memory', { climbed: rungMemoryArmed.ratio, trial: marked ? 'marked' : 'could not be saved' });
  rungMemoryArmed = null;
}

/** A resize before the remembered rung was used or while it is on trial: a
 *  canvas that grew past what the entry was held at, or any other change of
 *  configuration, cancels it or ends its trial for this boot, and keeps the
 *  entry. */
function rungMemoryRecheck(): void {
  const told = rungMemoryTold;
  const outcome = resolutionController.seedOutcome;
  if (told === null || (outcome !== 'armed' && outcome !== 'applied')) return;
  const verdict = rungMemoryApplies(told, rungMemoryFacts());
  if (verdict.ok) return;
  // Before the climb, it is cancelled; on trial, the trial ends with no
  // verdict, so a failure at the larger canvas cannot delete an entry held at
  // the smaller one.
  resolutionController.forgetRemembered();
  rungMemoryRefused = `after a resize: ${verdict.why}`;
  debugLog('Rung memory', { [outcome === 'armed' ? 'refused' : 'trialEnded']: rungMemoryRefused, ratio: told.ratio, deleted: false });
  rungMemoryArmed = null;
  rungMemoryTold = null;
}

/** The WebGL context was lost (the listener where the renderer is made). */
function rungMemoryContextLost(): void {
  rungMemoryLostAtRung('the WebGL context was lost');
}

/** The GPU clock turned itself off for a reason of its own rather than the
 *  controller's verdict. A sync object refused is the context's loss reaching
 *  the sensor first, and is judged as one; its price, or its clock's grid, is
 *  judged only while the remembered climb is still on trial. */
function rungMemorySensorOff(reason: string): void {
  if (reason === SYNC_REFUSED_REASON) {
    rungMemoryLostAtRung('the context refused the GPU clock a sync object');
  } else {
    rungMemoryLostAtRung(`the GPU clock turned itself off (${reason})`, true);
  }
}

function rungMemoryLostAtRung(what: string, onlyOnTrial = false): void {
  if (rungMemoryBlockedBy !== null) return;
  const visible = document.visibilityState === 'visible';
  const done = onlyOnTrial ? rungMemory.sensorOff(resolutionController, visible) : rungMemory.lostAtRung(visible);
  if (done === 'deleted') {
    debugLog('Rung memory', { deleted: `${what} with the remembered rung on trial and the page visible` });
  } else if (done === 'kept') {
    debugLog('Rung memory', { kept: `${what} while the page was hidden` });
  }
}

/** The DEV bridge fed the controller synthetic intervals or readings: what it
 *  decides from them is about that stream's clock, not this device, so the
 *  store is left alone for the rest of the session. */
function rungMemoryStopForInjection(): void {
  if (rungMemory.isStopped) return;
  rungMemory.stop();
  debugLog('Rung memory', { stopped: 'synthetic samples were injected; nothing is saved this session' });
}

/** Forget the stored rung: `__moon.forgetRung()`. */
function rungMemoryForget(): void {
  resolutionController.forgetRemembered();
  rungMemory.forget(resolutionController);
  rungMemoryArmed = null;
  rungMemoryTold = null;
}

/** `__moon.quality().memory`. */
function rungMemoryReadout() {
  const state = resolutionController.state().memory;
  return {
    stored: readRungMemory().entry,
    // Told a rung and still waiting to climb to it, or climbed to it.
    applied: rungMemoryClimbed || state.seed === 'armed',
    refused: rungMemoryBlockedBy ?? rungMemoryRefused,
    // What the next boot will be told, as this session has it.
    remembering: resolutionController.memory,
    seed: state.seed,
    rememberedRatio: state.rememberedRatio,
    onTrial: rungMemory.onTrial,
    // Nothing is saved for the rest of the session: an injection, or a lost
    // context.
    stopped: rungMemory.isStopped,
  };
}

// A clean unload is not a crash: the trial flag goes, and nothing else. A
// hidden page counts as one, because iOS Safari evicts a background tab with
// no pagehide; shown again with the trial standing — a tab brought back, or a
// page restored from the back-forward cache — the flag is marked again. A hung
// page dispatches neither, so the flag it leaves is still there.
if (rungMemoryBlockedBy === null) {
  window.addEventListener('pagehide', () => rungMemory.hide(resolutionController, rungMemoryConfig, Date.now()));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      rungMemory.hide(resolutionController, rungMemoryConfig, Date.now());
    } else if (rungMemory.shown(resolutionController)) {
      debugLog('Rung memory', { trial: 'marked again: the page is shown with the remembered rung on trial' });
    }
  });
}

/** The silence check runs on a countdown of DRAWS rather than every frame: at
 *  a 30 fps target that is every ten seconds. */
let qualitySilenceCountdown = 0;
let qualitySilenceSaid = false;
const QUALITY_SILENCE_CHECK_FRAMES = 300;

/**
 * One tick's program-count check, on EVERY tick.
 *
 * A link cannot be timed apart from the tick it happened inside, so that
 * tick's whole busy time stands in for it — an upper bound, and all that is
 * asked is whether the interval did work at all. It has to run on every tick
 * rather than on draws: with a cap on, a link can land on a tick that draws
 * nothing, and charging it to the drawn tick beside it would describe the
 * wrong frame.
 */
function noteProgramLinks(): void {
  const programs = renderer.info.programs?.length ?? lastProgramCount;
  if (programs > lastProgramCount) linkWorkMs += loopBusyMs;
  lastProgramCount = programs;
}

/**
 * One drawn frame of evidence for Dynamic, and the rung it asks for.
 *
 * Every field describes the interval that ENDS at `nowMs` — the span since the
 * previous DRAW, and everything the app did inside it. An interval charged to
 * the frame that merely reported it would credit a tile upload's cost to the
 * clean frame after it, and near Earth, where sliced work lands on alternating
 * frames, the statistic would become the mean of exactly the long intervals
 * the exclusion exists to remove.
 */
function stepQuality(nowMs: number): void {
  const previousFrameAtMs = lastFrameAtMs;
  lastFrameAtMs = nowMs;
  // Everything the span spent: the mode's sliced work (uploads, bake slices)
  // wherever in the span it landed, and any program link.
  const workedMs = (planetariumMode?.takeFrameWork() ?? 0) + linkWorkMs;
  const mainThreadMs = busyMaxSinceDraw;
  const mainThreadSumMs = busySumSinceDraw;
  linkWorkMs = 0;
  busyMaxSinceDraw = 0;
  busySumSinceDraw = 0;
  const veilUp = planetariumMode?.isArrivalVeilUp() ?? false;
  if (arrivalVeilWasUp && !veilUp) resolutionController.notify('arrival', nowMs);
  arrivalVeilWasUp = veilUp;
  // A mode switch's own veil is a cover like the arrival's: the frames under
  // it are the switch's — the planetarium restoring itself, or a tool being
  // taken down — and would otherwise count on top of the evidence from before
  // the tool until the switch's reset below drops it.
  const eligibleNow = appMode === 'planetarium'
    && document.visibilityState === 'visible'
    && pageFocused
    && bootRender.current === 'live'
    && !veilUp
    && !modeSwitchInFlight;
  const eligible = eligibleNow && lastFrameEligible;
  lastFrameEligible = eligibleNow;
  lastEligibleNow = eligibleNow;
  // The interval belongs to the previous draw, whose number `drawSeq` still
  // is; a GPU reading that finished since the last step rides along to be
  // paired with its own draw's verdict.
  const gpu = gpuPending;
  gpuPending = null;
  const sensorMs = sensorSinceStep;
  sensorSinceStep = 0;
  // Either end of the interval under the map or a DEV measurement.
  const suspendedNow = clockSuspendedNow();
  const clockSuspended = suspendedNow || lastClockSuspended;
  lastClockSuspended = suspendedNow;
  const decision = resolutionController.step({
    nowMs,
    intervalMs: nowMs - previousFrameAtMs,
    mainThreadMs,
    mainThreadSumMs,
    workedMs,
    eligible,
    drawSeq,
    gpu,
    sensorMs,
    clockSuspended,
    sceneKey: sceneKeyNow(),
  });
  if (decision !== null) applyQualityDecision(decision, nowMs);
  rungMemoryStep();
  // The controller turned the clock off itself (a repeated reversal): the
  // sensor stops for the session with it.
  const off = resolutionController.clockOff;
  if (off !== null && gpuFrameClock.usable) gpuFrameClock.disable(off);
  if (--qualitySilenceCountdown <= 0) {
    qualitySilenceCountdown = QUALITY_SILENCE_CHECK_FRAMES;
    reportQualitySilence();
  }
}

/** Move the rung the controller asked for, then tell it the move landed: an
 *  up-step opens its verification window, a down-step starts its spacing. */
function applyQualityDecision(decision: Decision, nowMs: number): void {
  const kind = decision.reason === 'up' ? 'up' : decision.reason === 'down' ? 'down' : 'restore';
  resolutionController.onApplied(nowMs, kind);
  // On trial before the sharper rung is drawn.
  if (decision.seeded === true) rungMemorySeedApplied();
  applySceneResolution(decision.seeded === true ? 'dynamic up (remembered)' : `dynamic ${decision.reason}`);
}

/** A counted rate stuck at zero is a defect — a gate that never opened —
 *  rather than a quiet scene, and the only way to see it on a phone is to say
 *  so through the debug overlay. Said once per stretch of silence. */
function reportQualitySilence(): void {
  const state = resolutionController.state();
  if (state.idle || state.silentMs <= ZERO_COUNTED_WARN_MS) {
    qualitySilenceSaid = false;
    return;
  }
  if (qualitySilenceSaid) return;
  qualitySilenceSaid = true;
  debugWarn('No frame has counted toward the graphics-quality measurement', {
    silentMs: Math.round(state.silentMs),
    countedRate: state.countedRate,
    rung: state.rung,
  });
}

/** Where the resample stands, for the bridge and a capture's log. */
function upscaleState() {
  const outputRatio = getTargetPixelRatio();
  const sceneRatio = getScenePixelRatio();
  return {
    outputRatio,
    sceneRatio,
    mode: sceneRatioMode(),
    factor: outputRatio / sceneRatio,
    active: upscaleActive(),
    request: upscaleRenderRatio,
    filter: upscaleFilter,
    downsample: downsampleFilter,
    // What RCAS is really running at, and whether anything named it: unasked,
    // the stops follow the factor above.
    sharpen: upscaleSharpenStopsLive(),
    sharpenPinned: upscaleSharpenPinned,
    passes: {
      easu: upscalePass?.enabled ?? false,
      rcas: sharpenPass?.enabled ?? false,
      box: downsamplePass?.enabled ?? false,
    },
  };
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

// The bloom pass's own targets, switched back and forth against the picture
// they had. It reaches into the live pass rather than rebuilding the chain: a
// rebuild relinks every pass's program, which is not what this measures.
// DEV only — a production build folds the switch to the state it ships in.
if (import.meta.env.DEV) {
  onPerfSwitch('bloom-nodepth', (on) => setBloomInternalDepth(bloomPass, !on));
  onPerfSwitch('depth-discard', (on) => { if (depthDiscardPass) depthDiscardPass.enabled = on; });
  // The fused pass is a different chain, not a flag inside one, so this switch
  // is the one that has to rebuild — which is why the sweep may not hold it
  // inside a measured block, and why the pixel gate takes it across two boots.
  // This listener is here for the gate's in-session capture. Skipped on the
  // first call, which arrives with the composer already built for the state it
  // reports.
  let fusedKnown = perfSwitchOn('fused-final');
  onPerfSwitch('fused-final', (on) => {
    if (on === fusedKnown) return;
    fusedKnown = on;
    composerBuiltFor = null;
    if (appMode === 'planetarium') {
      buildComposer(planetariumCamera, PLANETARIUM_BLOOM, planetariumBloomEnabled());
    }
  });
}

// Armed after first Planetarium activation: that render compiles the scene's
// shaders and uploads textures, so its duration is a startup phase of its own.
let measureNextSceneFrame = false;

// Both ends of the app's own tick, for a diagnostic that has to tell a frame
// the app spent 30 ms inside from a frame it was handed 30 ms apart. Null
// unless the on-device perf overlay is running, and never installed in a
// production build.
let frameProbe: { start(): void; end(): void } | null = null;
// The GPU profile (app/devGpuProfile.ts) brackets the world draw with its
// spans while a run is on; loaded by the first `__moon.gpuProfile()` call.
let gpuProfiler: GpuProfiler | null = null;
// The GPU-clock measurement (app/devGpuClock.ts): can this engine time its
// own frame finely enough to steer by? It fences, reads back or times the
// same draws the profile brackets; loaded by the first `__moon.gpuClock()`
// call. Deliberately NOT a frame-cap hold — whether its poll loop costs the
// app frames is one of the things it measures.
let gpuClock: GpuClock | null = null;

/**
 * Pin the render resolution and re-run the app's own resize path, so the
 * composer targets, the star point sizes and the mode's layout all follow it
 * exactly as they do when a display changes. Null hands the ratio back.
 */
function devPinPixelRatio(ratio: number | null): void {
  pixelRatioPin = ratio;
  // A pinned output ratio is a measurement: Dynamic steps out of the way
  // before the resize path re-derives everything from it.
  refreshQualityPin();
  syncViewport();
}

/**
 * Every surface a frame is actually drawn into, in device pixels.
 *
 * A resolution switch that changes the renderer's ratio but leaves a target at
 * its old size costs nothing and reads as if the pixels were free, so the
 * sizes themselves are the evidence rather than the timing. The bloom chain is
 * deliberately not on the scene's ratio (app/renderResolution.ts sizes it at
 * the old floor so the glow keeps its width), which is why it is listed
 * separately instead of being assumed to follow.
 */
function devRenderTargets() {
  const buffer = renderer.getDrawingBufferSize(new THREE.Vector2());
  const canvas = renderer.domElement;
  const size = (t: { width: number; height: number } | null | undefined) =>
    (t ? { w: t.width, h: t.height, mpx: Math.round((t.width * t.height) / 1e4) / 100 } : null);
  const bloomMip = (bloomPass as unknown as { renderTargetsHorizontal?: THREE.WebGLRenderTarget[] } | null)
    ?.renderTargetsHorizontal?.[0] ?? null;
  // [x, y, width, height] and whether the scissor is on: a target still at its
  // whole size reads as its own dimensions with the test off.
  const viewportOf = (t: THREE.WebGLRenderTarget | null) => (t
    ? { rect: [t.viewport.x, t.viewport.y, t.viewport.z, t.viewport.w], scissorTest: t.scissorTest }
    : null);
  // Whether three holds GL objects for a target — it builds them on the first
  // BIND, not when the target is made or sized, so a target nothing ever binds
  // costs no memory however large it says it is. The condition three itself
  // tests before setting one up. On the fused chain no pass swaps, so nothing
  // writes the composer's writeBuffer and the partner is never allocated;
  // `renderTargetBytes` still counts its bytes, deliberately (renderQuality.ts).
  const allocatedOf = (t: THREE.WebGLRenderTarget | null | undefined): boolean => {
    if (!t) return false;
    const props = renderer.properties.get(t) as { __webglFramebuffer?: unknown } | undefined;
    return props?.__webglFramebuffer !== undefined;
  };
  return {
    pixelRatio: renderer.getPixelRatio(),
    targetPixelRatio: getTargetPixelRatio(),
    // The canvas's own samples (0 unless `?canvasaa=1`) and a screen target's.
    canvasSamples,
    screenSamples,
    screenTarget: size(screenTarget),
    bloomRatio: bloomPixelRatio(window.devicePixelRatio, isMobile),
    drawingBuffer: { w: buffer.x, h: buffer.y, mpx: Math.round((buffer.x * buffer.y) / 1e4) / 100 },
    canvas: { w: canvas.width, h: canvas.height, cssW: canvas.clientWidth, cssH: canvas.clientHeight },
    sceneTarget: sceneTarget
      ? { ...size(sceneTarget)!, samples: sceneTarget.samples }
      : null,
    composerPartner: composer
      ? { ...size(composer.renderTarget2)!, allocated: allocatedOf(composer.renderTarget2) }
      : null,
    // What the scene-sized targets are ALLOCATED at, the sub-rectangle this
    // rung DRAWS into, and each target's own rectangle (app/sceneSubRect.ts).
    // Under Dynamic the two differ at every rung but the ladder's top, and a
    // run that means to prove fewer pixels were drawn has to read the draw
    // size — the allocation does not move.
    sceneAlloc: { w: sceneRectsLive.alloc.width, h: sceneRectsLive.alloc.height },
    sceneDraw: { w: sceneRectsLive.draw.width, h: sceneRectsLive.draw.height },
    sceneAllocFixed: fixedAllocationFor(composerCamera()),
    uvScale: [sceneRectsLive.uvScale.x, sceneRectsLive.uvScale.y],
    sceneViewport: {
      scene: viewportOf(sceneTarget),
      partner: viewportOf(composer?.renderTarget2 ?? null),
      ldr: viewportOf(outputTargetPass?.target ?? null),
    },
    // The scene ratio (either side of the output ratio with a quality level
    // or a Dynamic rung) and the resample's own targets: the tone-mapped
    // frame at scene size and EASU's result at output size (null while RCAS
    // does not follow). `sceneBytes` is what the scene-sized targets hold
    // together — the figure the byte budget is checked against, and the one a
    // device can be asked for directly.
    sceneRatio: getScenePixelRatio(),
    sceneSamples: sceneTarget?.samples ?? 0,
    sceneBytes: qualityRenderTargetBytes(),
    quality: qualityLevel,
    rung: resolutionController.rung,
    tilePixelRatio: getTilePixelRatio(),
    ldrTarget: size(outputTargetPass?.target),
    upTarget: size(upscalePass?.target),
    // Half the bloom pass's requested resolution: the first mip it blurs.
    bloomMip0: size(bloomMip),
  };
}

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
  } else if (import.meta.env.DEV && gpuProfiler?.active) {
    // The same two draws as below, measured.
    gpuProfiler.frame(
      () => renderScene(camera),
      () => { if (appMode === 'planetarium') planetariumMode?.renderMiniChartFrame(); },
    );
  } else if (import.meta.env.DEV && gpuClock?.active) {
    // The same two draws again, with a fence, a readback or a GPU timer
    // closed around them — the frame's end is where a production clock would
    // have to take its reading.
    gpuClock.frame(
      () => renderScene(camera),
      () => { if (appMode === 'planetarium') planetariumMode?.renderMiniChartFrame(); },
    );
  } else {
    renderScene(camera);
    // The corner chart draws over the finished world frame, inside its own
    // scissor rectangle and its own renderer-state transaction — so the
    // composer's targets and every pixel outside that rectangle are exactly
    // what renderScene left.
    if (appMode === 'planetarium') planetariumMode?.renderMiniChartFrame();
  }
  if (appMode === 'planetarium') planetariumMode?.noteWorldRendered(bootRender.current === 'live');
}

// The loading screen goes: draw one frame first, so the frame under the fade
// is fresh and any program a pass still had to link is linked under the
// cover, then let every frame draw.
/**
 * Bind everything a Dynamic rung can reach, while the screen is still covered.
 *
 * three allocates a render target's GL storage on the first BIND, not when the
 * target is made or sized; the composer skips a disabled pass outright; and
 * the finishing pass's LDR target and EASU's target are both made on the first
 * render that needs them. So a session that boots at the medium rung has never
 * touched the far side of its own allocation, has never linked the two
 * resample programs, and would pay for all of it on the first rung change —
 * the very hitch a fixed allocation exists to delete, moved rather than
 * removed. So: one frame at the ladder's bottom rung (the LDR target, EASU,
 * RCAS), one at its top rung (the whole allocation touched, and the box where
 * the ladder has a rung above medium), and then back to the rung this session
 * starts on.
 *
 * Only where the allocation is fixed. Everywhere else a rung change re-sizes
 * the targets anyway, and these frames would be three boot draws bought for
 * nothing.
 */
function warmSceneAllocation(): void {
  const cam = composerCamera();
  if (!composer || !fixedAllocationFor(cam)) return;
  const rungs = qualityLadderLive.rungs;
  const warmed = [rungs[0], rungs[rungs.length - 1]].filter((r) => typeof r === 'number');
  if (warmed.length === 0) return;
  // The first visible frame's measurement belongs to the first visible frame.
  const measuring = measureNextSceneFrame;
  measureNextSceneFrame = false;
  const startedMs = performance.now();
  for (const ratio of warmed) {
    sceneRatioWarm = ratio;
    applySceneResolution('boot warm-up');
    renderScene(camera);
  }
  sceneRatioWarm = null;
  applySceneResolution('boot warm-up done');
  measureNextSceneFrame = measuring;
  debugLog('Scene allocation warmed', {
    rungs: warmed.map((r) => Math.round(r * 100) / 100),
    alloc: `${sceneRectsLive.alloc.width}x${sceneRectsLive.alloc.height}`,
    ms: Math.round(performance.now() - startedMs),
  });
}

function revealLoadingScreen() {
  // A failed boot keeps its error screen; there is nothing to reveal.
  if (bootRender.current === 'failed') return;
  // Before the reveal's own frame, so every target, program and page of the
  // allocation has been touched under the cover.
  warmSceneAllocation();
  if (bootRender.revealRender()) drawWorldFrame();
  // The draw only queues the GPU's work; on ANGLE-Metal the pipeline states
  // are built when the draws execute. Where finish blocks (WebKit, Firefox)
  // that wait lands under the cover instead of on the first visible frame.
  // Chromium implements WebGL's finish as a flush (a boot trace shows no
  // wait), so there this only guarantees the frame is submitted before the
  // fade begins.
  renderer.getContext().finish();
  bootRender.markLive();
  // A frame is on screen under whatever level this boot applied, so the
  // boot-loop marker has done its job.
  clearPending();
  // And from here the frames are the scene's own: the covered boot's were not.
  resolutionController.notify('boot', performance.now());
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
      // change the aspect, and a stale warp misplaces every pixel. The fused
      // chain writes the four shared uniforms; the `?fused=0` chain's own lens
      // pass takes its flag from the same numbers.
      if (cam === planetariumCamera) {
        if (composerLens) {
          syncLensUniforms(composerLens, planetariumLens, planetariumCamera.fov, planetariumCamera.aspect);
        } else if (lensPass) {
          updateLensPass(lensPass, planetariumLens, planetariumCamera.fov, planetariumCamera.aspect);
        }
      }
      // RenderPass draws the scene into the composer's READ buffer, and three's
      // EffectComposer constructor puts the partner in that slot, so every
      // fresh build starts with the partner in front. This line is the one
      // thing that puts the scene target back, so the geometry gets the
      // samples rather than a full-screen quad (see buildComposer). It also
      // covers a chain that ends a frame swapped: on the fused chain nothing
      // swaps at all, and on `?fused=0` the lens pass is the only swapper
      // (OutputTargetPass and the resample passes all set needsSwap false).
      if (sceneTarget && composer.readBuffer !== sceneTarget) composer.swapBuffers();
      composer.render();
    } else if (lensPass && cam === planetariumCamera) {
      // No composer and a lens pass: buildComposer's no-float branch.
      // Tone map to the hardware backbuffer first, then copy and warp that LDR
      // image. `ShaderPass.render` only reads the fake target's texture when its
      // renderToScreen flag is set; the write target is intentionally unused.
      // Onto the screen target where the canvas has no samples; onto the
      // canvas itself where it has (`?canvasaa=1`).
      const direct = canvasSampled ? null : ensureScreenTarget();
      renderer.setRenderTarget(direct);
      renderer.render(scene, cam);
      renderer.setRenderTarget(null);
      // Synced BEFORE the flag is read: updateLensPass is what sets the flag,
      // from the strength, every frame. Under the flag it would run only while
      // the pass was already on, and one frame at zero strength (an aspect the
      // overscan cannot cover) would switch the lens off for the session.
      updateLensPass(lensPass, planetariumLens, planetariumCamera.fov, planetariumCamera.aspect);
      // A disabled pass does not run, exactly as the composer skips one: this
      // path calls the pass by hand, so the flag has to be read by hand too.
      // Skipping it leaves the tone-mapped frame already on screen.
      if (lensPass.enabled) {
        // The lens resamples display-referred bytes: the screen target's own
        // texture, or a copy of the canvas where the frame went there.
        let texture: THREE.Texture;
        if (direct) {
          texture = direct.texture;
        } else {
          const copy = ensureDirectLensTexture();
          renderer.copyFramebufferToTexture(copy);
          texture = copy;
        }
        lensPass.render(
          renderer,
          null as unknown as THREE.WebGLRenderTarget,
          { texture } as unknown as THREE.WebGLRenderTarget,
          0,
          false,
        );
      } else if (direct) {
        ensureScreenCopy().copy(renderer, direct);
      }
    } else if (canvasSampled) {
      renderer.render(scene, cam);
    } else {
      // The bare direct path (a non-planetarium camera with bloom off): the
      // screen target, then the copy.
      const direct = ensureScreenTarget();
      renderer.setRenderTarget(direct);
      renderer.render(scene, cam);
      ensureScreenCopy().copy(renderer, direct);
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

/**
 * Resolves when the veil has finished lifting — `#mode-transition`'s own
 * transitionend for its opacity, not the instant the class came off (the fade
 * runs for 0.3 s after that). Until then the screen is black, so everything a
 * mode drew before this moment was drawn for nobody, which is exactly what a
 * timing has to be able to say.
 *
 * A tab hidden across the switch may never finish the transition, so the wait
 * is capped and resolves anyway rather than stranding whoever is waiting.
 */
function veilLifted(capMs = 2000): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      modeTransition.removeEventListener('transitionend', onTransitionEnd);
      resolve(performance.now());
    };
    const onTransitionEnd = (event: Event): void => {
      const transition = event as TransitionEvent;
      if (transition.target !== modeTransition || transition.propertyName !== 'opacity') return;
      if (modeTransition.classList.contains('active')) return; // the fade to black, not the lift
      finish();
    };
    modeTransition.addEventListener('transitionend', onTransitionEnd);
    const timer = setTimeout(finish, capMs);
  });
}

/** Resolves on the next frame the app DRAWS, with that frame's own timestamp.
 *  A callback is not a draw under a frame-rate target, and "the first frame
 *  after the veil lifted" is a question about drawn frames. */
const nextDrawWaiters: ((nowMs: number) => void)[] = [];
function afterNextDraw(): Promise<number> {
  return new Promise((resolve) => nextDrawWaiters.push(resolve));
}

/**
 * Resolves once the app has actually DRAWN a frame — what the veil comes off
 * over, instead of a fixed sleep that was a guess at the same thing. The draw
 * is requested outright (`forcedDrawRequest`, the hook the arrival veil uses),
 * so a frame-rate target cannot make the cover wait out a whole period for a
 * frame pacing was about to skip.
 *
 * The cap counts only the time the page was VISIBLE. A hidden tab draws
 * nothing at all, and a cap that ran while it was hidden would take the veil
 * off over the last frame of the mode the reader left — which is exactly the
 * picture the veil exists to hide.
 *
 * `minCoveredMs` is a FLOOR of covered time on top of that frame, for a
 * destination whose programs are not linked under the cover: one drawn frame
 * proves the picture exists, not that the driver has finished building
 * everything the next few frames will need, and a mode that compiles its
 * materials lazily pays those builds on its second and third frames — which
 * would now land on the lifting veil. The floor is the covered time the fixed
 * sleep used to give them.
 *
 * Under the boot cover the loop draws ONLY on request (app/bootRenderGate),
 * so the request goes to the gate as well as to the frame-rate cap — without
 * it the first switch of a boot would wait out its whole cap for a frame that
 * was never going to be drawn.
 */
function drawnFrame(capMs: number, options: { minCoveredMs?: number } = {}): Promise<number | null> {
  const floorMs = Math.max(0, options.minCoveredMs ?? 0);
  forcedDrawRequest = true;
  bootRender.requestCoveredRender();
  return new Promise((resolve) => {
    let settled = false;
    let drawnAt: number | null = null;
    let floorLeft = floorMs;
    let capLeft = capMs;
    let armedAt: number | null = null;
    let floorTimer: ReturnType<typeof setTimeout> | undefined;
    let capTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(floorTimer);
      clearTimeout(capTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      resolve(drawnAt);
    };
    // Both conditions, never one: a frame has been drawn AND the cover has had
    // its floor of visible time.
    const reached = (): void => { if (drawnAt !== null && floorLeft <= 0) finish(); };
    const arm = (): void => {
      armedAt = performance.now();
      if (floorLeft > 0) floorTimer = setTimeout(() => { floorLeft = 0; reached(); }, floorLeft);
      capTimer = setTimeout(finish, Math.max(0, capLeft));
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        // A page that started hidden never armed anything, so there is no
        // elapsed visible time to take off.
        if (armedAt !== null) {
          const spent = performance.now() - armedAt;
          floorLeft -= spent;
          capLeft -= spent;
          armedAt = null;
        }
        clearTimeout(floorTimer);
        clearTimeout(capTimer);
      } else {
        forcedDrawRequest = true; // a tab coming back owes the cover a frame
        bootRender.requestCoveredRender();
        arm();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    if (document.visibilityState !== 'hidden') arm();
    void afterNextDraw().then((at) => { drawnAt = at; reached(); });
  });
}

/** What to wait when the veil's own duration cannot be read at all (a style
 *  that did not apply, a browser that reports nothing). Deliberately NOT the
 *  number in the CSS — a copy of that would be the second writer this reader
 *  exists to avoid — but longer than any fade we ship, because every use of it
 *  is a wait for the screen to be covered, and waiting too long costs a beat
 *  while waiting too little shows the mode being taken down. */
const VEIL_FALLBACK_COVER_MS = 300;

/** How long the veil's current fade takes, read from the element itself.
 *  index.html holds the two lengths (`--veil-fade` while it covers,
 *  `--veil-lift` while it comes off) and this is their only reader. */
function veilDurationMs(): number {
  return parseCssDurationMs(getComputedStyle(modeTransition).transitionDuration) ?? VEIL_FALLBACK_COVER_MS;
}

/** A frame's worth of slack, so a beat can never end on a half-covered screen. */
const ONE_FRAME_MS = 17;
/** The longest veil fade the DEV knob will set, seconds: past this a switch is
 *  indistinguishable from a hang, and every value it takes is in seconds. */
const MAX_VEIL_FADE_S = 5;
/** How long past the lift's own length to wait for its `transitionend` before
 *  standing in for it. A cancelled transition, a re-added `.active` and a tab
 *  hidden mid-fade all lose the event, and the cut must open either way. */
const LIFT_EVENT_GRACE_MS = 250;
/** The last resort on the wait for the destination's first drawn frame. It is
 *  generous on purpose: the veil coming off early shows the mode the reader
 *  left, and only visible time counts toward it. */
const VEIL_DRAW_CAP_MS = 5000;
/** How long the cover stays up for a mode that links no programs under it.
 *  Only Look inside warms its whole reveal behind the veil; the planetarium,
 *  Compare and Flight build their materials on the first frames they draw, and
 *  a program built on the second or third would be built on the lift. This is
 *  the covered time they have always had (the fixed sleep it replaced), so no
 *  switch ends up with less cover than before. */
const VEIL_LAZY_COMPILE_FLOOR_MS = 100;

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

/** True once a planetarium activation has finished: the journey is restored
 *  and the scene is settled. `hasLoadedSolarSystem()` only says the scene
 *  graph exists, which is true several awaits earlier — a harness that poses
 *  the camera on that would be posing a pre-restore ship. */
let plmActivated = false;

/** True when the switch happened; false when refused (same mode, or one
 *  already in flight) or when it failed and the app fell back. */
async function switchAppMode(newMode: AppMode, request?: ToolRequest): Promise<boolean> {
  if (newMode === appMode && appModeInitialized) return false;
  if (modeSwitchInFlight) return false;
  modeSwitchInFlight = true;
  debugLog('Switching app mode', { from: appMode, to: newMode });
  const from = appMode;
  let switched = false;
  let failed = false;
  /** What the destination wants done the instant the veil starts coming off
   *  (the Look-inside tool: its marks, and the cut it held closed). */
  let afterVeilRemoved: (() => void) | null = null;

  try {
    modeTransition.classList.add('active');
    transitionMsg.textContent =
      newMode === 'planetarium' ? 'Entering Planets...'
        : newMode === 'moonFlight' ? 'Entering Flight...'
          : newMode === 'interior' ? 'Looking inside...'
            : 'Gathering planets...';
    // The beat lets the fade-to-black actually show between two live modes.
    // On first boot the loading screen still covers everything, so the wait
    // would be 400 ms of nothing, serial, before any texture is even asked
    // for — a fifth of the whole fast-network startup.
    //
    // #mode-transition takes no pointers (index.html) — it is a fade, not a
    // cover. Through this beat the mode being left is still fully clickable,
    // and so is the destination's UI while it activates. That is deliberate:
    // the arrival veil is the thing that catches pointers, and anything
    // committed here belongs to the mode that is still on screen.
    //
    // The Look-inside chunk goes out BEFORE the beat and is awaited inside its
    // branch, so the fetch and the fade overlap. On a phone the 232 KB module
    // is a fetch of the same order as the beat, and the two ran one after the
    // other for no reason: the beat is a fade nobody is reading, and the branch
    // still awaits the import before it takes the current mode down, so a
    // chunk that will not load leaves the user looking at the mode they came
    // from and the notice does the talking. The no-op catch only keeps a
    // failure from being reported as an unhandled rejection while nothing is
    // awaiting it yet — the await below is what handles it.
    const interiorModuleFetch = newMode === 'interior' && !interiorMode
      ? (debugLog('Loading interior module'), import('./interior/InteriorMode'))
      : null;
    void interiorModuleFetch?.catch(() => {});
    const beatStartedAt = performance.now();
    // The beat is the veil's own fade plus a frame — one number, held in the
    // CSS (see veilDurationMs), where a screen that is only half covered when
    // the teardown starts is the thing being prevented.
    if (appModeInitialized) await sleep(veilDurationMs() + ONE_FRAME_MS);
    const beatMs = performance.now() - beatStartedAt;

    if (newMode === 'planetarium') {
      // --- Switch to Planetarium ---
      appMode = 'planetarium';
      if (moonFlightMode) moonFlightMode.deactivate();
      if (volumeCompareMode) volumeCompareMode.deactivate();
      if (interiorMode) interiorMode.deactivate();
      scene.background = MODE_BACKGROUND;
      applyRenderProfile(renderer, 'planetarium');

      camera = planetariumCamera;
      applyRenderResolution();
      buildComposer(planetariumCamera, PLANETARIUM_BLOOM, planetariumBloomEnabled());

      if (!planetariumMode) {
        debugLog('Creating Planetarium mode');
        // The boot shader warm-up compiles the variant the frame actually
        // draws: into the composer's target when there is a composer, to the
        // canvas otherwise — the same branch renderScene takes.
        planetariumMode = new PlanetariumMode(
          scene, planetariumCamera, renderer, useBloom, () => composer !== null,
          () => getScenePixelRatio(), () => getTilePixelRatio(),
          // The ☰ panel's graphics-quality row: the level and what this
          // display offers are read here, and the row writes back through the
          // same narrow path every other level change takes.
          {
            level: () => qualityLevel,
            set: setQualityLevel,
            bounds: () => qualityBoundsLive,
            targetBytes: () => qualityRenderTargetBytes(),
          },
          // And the Frame rate row beside it, which also carries the one
          // out-of-band draw request: a cover that has to show a painted
          // frame before it lifts cannot depend on the row's value for it.
          {
            rate: () => frameRate,
            set: setFrameRate,
            requestDraw: () => { forcedDrawRequest = true; },
          },
        );
        // Every tool entry arrives here ("How many fit?", Look inside): the
        // mode closes its own entry surfaces and snapshots the journey, then
        // this callback owns the switch, carrying the request's context.
        planetariumMode.onToolRequest((toolRequest) => {
          if (modeSwitchInFlight || appMode === toolRequest.kind) return false;
          return switchAppMode(toolRequest.kind, toolRequest);
        });
        // A door to a tool has just become visible (the Tools popover, a map
        // card carrying Look inside): fetch the tool chunks now, so a tap finds
        // them in the browser's module map instead of waiting on the network
        // behind the fade. Idempotent — a second import() of the same module
        // resolves from that map — and silent: a failure here is the switch's
        // to report, and it retries the fetch itself.
        planetariumMode.onToolWarm(() => {
          void import('./interior/InteriorMode').catch(() => {});
          void import('./volumeCompare/VolumeCompareMode').catch(() => {});
        });
      }
      debugLog('Activating Planetarium mode');
      plmActivated = false;
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
      plmActivated = true;
      debugLog('Planetarium mode active');

    } else if (newMode === 'moonFlight') {
      // --- Switch to Moon Flight ---
      // Dynamic import: flight code + future assets stay out of the initial
      // bundle until the user actually enters this mode. Fetched BEFORE the
      // current mode is taken down: the data service worker never caches
      // app code, so a lost signal fails this fetch, and a failure here must
      // leave the user in the mode they can still see.
      const flightModule = moonFlightMode ? null : await (async () => {
        debugLog('Loading moon flight module');
        return import('./moonFlight/MoonFlightMode');
      })();
      appMode = 'moonFlight';
      if (planetariumMode) planetariumMode.deactivate();
      plmActivated = false;
      if (volumeCompareMode) volumeCompareMode.deactivate();
      if (interiorMode) interiorMode.deactivate();
      planetariumUI.style.display = 'none';
      scene.background = MODE_BACKGROUND;
      applyRenderProfile(renderer, 'moonFlight');

      camera = flightCamera;
      applyRenderResolution();
      buildComposer(flightCamera, { strength: 1.2, threshold: 0.85 });

      if (!moonFlightMode) {
        setFlightLoadingPercent(0, 1);
        moonFlightMode = new flightModule!.MoonFlightMode(scene, flightCamera, renderer);
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
      // Dynamic import first, for the same reason as the flight branch: a
      // failed chunk fetch must not strand the user in a mode with no UI.
      const compareModule = volumeCompareMode ? null : await (async () => {
        debugLog('Loading volume compare module');
        return import('./volumeCompare/VolumeCompareMode');
      })();
      appMode = 'volumeCompare';
      if (planetariumMode) planetariumMode.deactivate();
      plmActivated = false;
      if (moonFlightMode) moonFlightMode.deactivate();
      if (interiorMode) interiorMode.deactivate();
      // PlanetariumMode.deactivate already hides this; the explicit line keeps
      // parity with the flight branch and covers a switch from moon flight.
      planetariumUI.style.display = 'none';
      scene.background = MODE_BACKGROUND;
      applyRenderProfile(renderer, 'volumeCompare');

      camera = vcCamera;
      applyRenderResolution();
      buildComposer(vcCamera, { strength: 0.8, threshold: 0.92 });

      if (!volumeCompareMode) {
        volumeCompareMode = new compareModule!.VolumeCompareMode(scene, vcCamera, renderer, useBloom);
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

    } else if (newMode === 'interior') {
      // --- Switch to Look inside ---
      // Dynamic import first, as the other tools: a failed chunk fetch must
      // not strand the user in a mode with no UI. This one was started above the
      // fade beat (and prefetched from the Tools popover), so what is awaited
      // here — before any teardown, as ever — is usually nothing at all.
      const importStartedAt = performance.now();
      const interiorModule = interiorModuleFetch ? await interiorModuleFetch : null;
      const importMs = performance.now() - importStartedAt;
      const bodyId = request?.kind === 'interior' ? request.bodyId : 'Earth';
      // The tool poses the body at the planetarium's instant: read it before
      // the planetarium is taken down.
      const entryUtcMs = planetariumMode?.getCurrentUtcMs() ?? Date.now();
      appMode = 'interior';
      if (planetariumMode) planetariumMode.deactivate();
      plmActivated = false;
      if (moonFlightMode) moonFlightMode.deactivate();
      if (volumeCompareMode) volumeCompareMode.deactivate();
      planetariumUI.style.display = 'none';
      scene.background = MODE_BACKGROUND;
      // The studio's curve, before its warm-up links anything: a program keyed
      // on the planetarium's curve is one the reveal could not use.
      applyRenderProfile(renderer, 'interior');

      camera = interiorCamera;
      applyRenderResolution();
      buildComposer(interiorCamera, { strength: 0.6, threshold: 0.95 });

      if (!interiorMode) {
        // `?lustre=0` turns the faces' studio reflection off (no prefiltered
        // environment): the A/B for any question about what the environment
        // does to the picture, and the kill switch.
        const lustre = useBloom && new URLSearchParams(window.location.search).get('lustre') !== '0';
        // The last argument answers "does the frame go into a target": the
        // tool's reveal warm-up compiles with that kind of target bound, the
        // same question PlanetariumMode's boot warm-up is handed.
        interiorMode = new interiorModule!.InteriorMode(
          scene, interiorCamera, renderer, lustre, sceneDrawMultisampled, () => composer !== null,
        );
        interiorMode.onExit(() => {
          void switchAppMode('planetarium');
        });
      }
      debugLog('Activating interior mode', { bodyId });
      // Resolves once the body's map is applied; the veil covers the load.
      const activateStartedAt = performance.now();
      await interiorMode.activate(bodyId, entryUtcMs);
      const activateMs = performance.now() - activateStartedAt;
      // What the switch itself cost, beside the tool's own marks
      // (`interiorState().timings`): the fade beat, the wait left for the
      // chunk, and the activation. On a phone `?debug=1` is the only place
      // these can be read, and they are where the open's first second goes.
      //
      // The last two are the veil's, which is main's alone: when it finished
      // lifting and the first frame drawn after that — the first frame the
      // reader actually saw. They land a fade after this point, so the line
      // waits for them and the whole of what the reader waited through is one
      // line. The tool takes copies for its own timings, and refuses them if a
      // pick has taken the open over by then (they are an entry's marks).
      const openedMode = interiorMode;
      const openId = openedMode.openId();
      afterVeilRemoved = () => {
        void (async () => {
          // The lift is the tool's cue as well as its mark: it keeps the cut
          // closed under the veil so the whole opening is seen, and opens it
          // here (INTERIOR_TRANSITION.revealAfterVeil; with the old order this
          // call finds nothing pending and does nothing). Whichever comes
          // first — the transition's own end or the timer standing in for a
          // lost one — reveals; the other is a no-op.
          const veilLiftedMs = openedMode.markUncovered(openId, 'veilLifted', await veilLifted(veilDurationMs() + LIFT_EVENT_GRACE_MS));
          openedMode.revealAfterVeil(openId);
          const drawnAt = await drawnFrame(VEIL_DRAW_CAP_MS);
          const firstVisibleFrameMs = drawnAt === null ? null : openedMode.markUncovered(openId, 'firstVisibleFrame', drawnAt);
          // A refused mark means this open stopped being the one the veil was
          // covering — an exit during the lift, or a pick that took it over.
          // There is no line to write about a body the reader never saw.
          if (veilLiftedMs === null || firstVisibleFrameMs === null) return;
          debugLog('Look inside: switch timings', {
            beatMs: Math.round(beatMs),
            importMs: Math.round(importMs),
            activateMs: Math.round(activateMs),
            veilLiftedMs,
            firstVisibleFrameMs,
          });
        })();
      };
      debugLog('Interior mode active');
    } else {
      throw new Error(`Unknown app mode: ${String(newMode)}`);
    }

    appModeInitialized = true;
    switched = true;

    // The veil comes off over a PAINTED frame of the mode that was just
    // activated, never over a timer's guess at one — and, where that mode
    // compiles its materials on the frames it draws rather than under the
    // cover, no sooner than the covered time it has always had.
    const linksUnderTheVeil = newMode === 'interior';
    await drawnFrame(VEIL_DRAW_CAP_MS, { minCoveredMs: linksUnderTheVeil ? 0 : VEIL_LAZY_COMPILE_FLOOR_MS });
  } catch (err) {
    debugError('Mode switch failed', { from, to: newMode, err });
    console.error('Mode switch failed:', err);
    failed = true;
  } finally {
    // The veil must never strand: if a mode activation throws, the app is
    // degraded but the user can still see a scene and click their way out.
    modeTransition.classList.remove('active');
    // Only now does the lift begin, so whatever waits on it is started here
    // rather than a few awaits earlier, where its own fallback timer would be
    // counting down a fade that had not started.
    afterVeilRemoved?.();
    modeSwitchInFlight = false;
    // A tool owns the scene and its own composer, and the frames either side
    // of the switch are the switch's: the resolution measurement starts again
    // from whichever mode this left the app in. Every switch passes through
    // here once — each tool's exit is a switch to the planetarium, and a
    // failed one's fallback is a switch of its own — so this is the one
    // reset per switch, into a tool or back out of it.
    resolutionController.notify('mode', performance.now());
  }
  // A failure after the current mode was taken down would leave a mode with
  // no UI and no exit; the planetarium is the one mode that always comes back.
  // Either way the user hears about it: a chunk that would not load looks
  // like a dead button otherwise.
  // (A failure of the very first activation is the boot's to report — init()
  // takes it to the error screen — so no toast for that one.)
  if (failed && appModeInitialized) {
    const notice = () => planetariumMode?.notify('That could not be opened. Check the connection and try again.');
    if (appMode !== 'planetarium') void switchAppMode('planetarium').then(notice);
    else notice();
  }
  return switched;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getAutoMode(): 'planetarium' | 'volumeCompare' | 'interior' {
  const params = new URLSearchParams(window.location.search);
  const auto = params.get('auto');
  // 'volumeCompare' routes into the compare mode after the Planetarium boots,
  // 'interior' into the Look-inside tool (with `&body=` naming the body).
  // Everything else — 'planetarium', the retired-but-still-accepted 'moonView',
  // and absence — lands in the Planetarium.
  if (auto === 'volumeCompare') return 'volumeCompare';
  if (auto === 'interior') return 'interior';
  return 'planetarium';
}

// Dev-only bridge for the headless screenshot harness: pose the camera and set
// the clock from out of process. The call site is guarded by a DEV check, so a
// production build dead-code-eliminates this entirely.
/** Draw numbers for the DEV bridge's synthetic GPU readings: counting down
 *  from -1, so they can never be mistaken for a real draw's. */
let devInjectSeq = -1;

function installDevHooks() {
  installSurfacePerfInputTracing();
  (window as any).__moon = {
    ready: () => plmActivated,
    bodies: () => planetariumMode?.devListBodies() ?? [],
    jumpTo: (name: string, distanceMultiplier?: number) =>
      planetariumMode?.devJumpToBody(name, distanceMultiplier) ?? false,
    frame: (
      name: string, fillFraction?: number, phaseAngleDeg?: number, distMul?: number,
      offNdcX?: number, offNdcY?: number, rollDeg?: number,
    ) =>
      planetariumMode?.devFrameBody(
        name, fillFraction, phaseAngleDeg, distMul, offNdcX, offNdcY, rollDeg,
      ) ?? false,
    viewFrom: (fromName: string, toName: string, fovDeg?: number) =>
      planetariumMode?.devViewFrom(fromName, toName, fovDeg) ?? false,
    // aimFrac swings the aim from straight down (0) to the tangent point (1,
    // the default): the poses between them are the ones that look along the
    // ground toward the horizon.
    limbView: (name: string, kRadii?: number, fovDeg?: number, phaseDeg?: number, aimFrac?: number) =>
      planetariumMode?.devLimbView(name, kRadii, fovDeg, phaseDeg, aimFrac) ?? false,
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
    // Precomputed atmosphere tables: tier state, a measurement bake, and table
    // readback through the 8-bit blit.
    atmoState: () => planetariumMode?.devAtmosphereState() ?? null,
    // What lights a body's night side this frame: the Moon's direction, its
    // irradiance and its phase.
    atmoNight: (body?: string) => planetariumMode?.devAtmosphereNight(body) ?? null,
    // The eclipse casters a body's shading is tracing this frame, and the spin
    // its cloud deck is drawn under: what a golden pose of an umbra records
    // beside the radiances.
    surfaceCasters: (body?: string) => planetariumMode?.devSurfaceCasters(body) ?? null,
    // Hold the shells on the analytic tier (null: whatever the tables allow),
    // and report the material each one is wearing.
    atmoTier: (tier: 'analytic' | null, settle = true) => planetariumMode?.devSetAtmosphereTier(tier, settle) ?? null,
    atmoBake: (options?: { body?: string; orders?: number; half?: boolean; drawsPerSlice?: number }) =>
      planetariumMode?.devAtmosphereBake(options) ?? Promise.resolve(null),
    atmoSample: (
      samples: ReadonlyArray<{
        kind: 'transmittance' | 'scattering' | 'combined' | 'irradiance';
        r: number; mu: number; muS?: number; nu?: number; hitsGround?: boolean; scale?: number;
      }>,
      body?: string,
    ) => planetariumMode?.devAtmosphereSample(samples, body) ?? null,
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
    // Freeze what a screenshot depends on and nothing else. `near` is the one
    // the dev framing hooks never set (they leave whatever the last mode wrote,
    // which at 1.05 R clips the bottom of the air away); exposure and the pixel
    // ratio move a whole frame at once, which no per-pixel threshold can
    // absorb. Pass null to hand all three back.
    pinCapture: (opts: { near?: number; exposure?: number; pixelRatio?: number } | null) => {
      if (opts === null) {
        exposurePin = null;
        pixelRatioPin = null;
        frameCapCaptureHold = false;
        // The same pin `pinRatio` writes: Dynamic must step back in when it
        // is released, exactly as it stepped out when it was set. The bounds
        // are re-derived first, because the output ratio decides what every
        // level means, which rungs exist and how large the targets are.
        recomputeQualityBounds();
        refreshQualityPin();
        applyRenderResolution();
        return { near: planetariumCamera.near, exposure: exposureCurrent, pixelRatio: renderer.getPixelRatio() };
      }
      // A capture settles on callbacks, so under a frame-rate target it would
      // otherwise read a tick that drew nothing: for the pin's duration every
      // callback draws. Not derived from `pixelRatioPin`, which `?ratio=`
      // shares — and lifted where this boot's URL asked for a frame rate,
      // because such a run is a measurement OF the pacing.
      frameCapCaptureHold = true;
      if (typeof opts.near === 'number' && opts.near > 0) {
        planetariumCamera.near = opts.near;
        planetariumCamera.updateProjectionMatrix();
      }
      if (typeof opts.exposure === 'number') exposurePin = opts.exposure;
      if (typeof opts.pixelRatio === 'number' && opts.pixelRatio > 0) {
        pixelRatioPin = opts.pixelRatio;
        // A pinned output ratio is a measurement, and a capture harness that
        // pins one must not be measuring a live rule: Dynamic steps out of
        // the way here as it does for `pinRatio`. The bounds follow the pinned
        // ratio first, or the targets would be sized for the old one.
        recomputeQualityBounds();
        refreshQualityPin();
        applyRenderResolution();
      }
      return {
        near: planetariumCamera.near,
        exposure: exposurePin ?? exposureCurrent,
        pixelRatio: renderer.getPixelRatio(),
      };
    },
    setBloom: (on: boolean) => setPlanetariumBloom(on),
    bloomActive: () => planetariumBloomEnabled(),
    // Lens-correction A/B: pass a strength (0 = rectilinear), no args restores
    // the default. Returns the strength the pass is actually running at, which
    // is what every other consumer reads too — a request the pipeline could
    // not honour is not the answer to "what am I looking at?".
    setLens: (strength?: number | null) => {
      lensRequestedStrength = typeof strength === 'number'
        ? Math.min(Math.max(strength, 0), 1)
        : LENS_DEFAULT_STRENGTH;
      if (appMode === 'planetarium') {
        buildComposer(planetariumCamera, PLANETARIUM_BLOOM, planetariumBloomEnabled());
      }
      return planetariumLens.effectiveStrength ?? planetariumLens.strength;
    },
    probe: (name: string) => planetariumMode?.devProbe(name) ?? null,
    /** Fly to a body with the app's own autopilot (the deck's Pilot verb); arrival parks with the nose on the body. */
    pilotTo: (name: string) => planetariumMode?.devPilotTo(name) ?? false,
    /** What the ship rides right now (rideFrame.ts): weight, km/s, carriers. */
    rideState: () => planetariumMode?.devRideState() ?? null,
    travelTo: (name: string) => planetariumMode?.devTravelTo(name) ?? false,
    arrivalPose: () => planetariumMode?.devArrivalPose() ?? null,
    governorOwner: () => planetariumMode?.devGovernorOwner() ?? null,
    land: (name: string) => planetariumMode?.devLand(name) ?? false,
    observe: (name: string) => planetariumMode?.devObserve(name) ?? false,
    device: () => planetariumMode?.devDeviceProfile() ?? null,
    sectors: () => planetariumMode?.devSectorStats() ?? null,
    /** Pin the render ratio (null hands it back) — the perf sweep's load amplifier, for a harness that profiles rather than sweeps. */
    pinRatio: (ratio: number | null) => devPinPixelRatio(ratio),
    /** Every surface a frame is drawn into, in device pixels (the perf sweep installs the same under `?perf=1`; here for any harness). */
    perfTargets: () => devRenderTargets(),
    /** The viewport as the app sees it: the size the renderer is sized to (the canvas's box, app/viewportSize.ts), the window, the canvas's rect on the page and the safe-area insets the chrome keeps out of. */
    viewport: () => {
      const rect = renderer.domElement.getBoundingClientRect();
      return {
        applied: viewportSize(),
        window: { width: window.innerWidth, height: window.innerHeight },
        canvas: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        drawingBuffer: { width: renderer.domElement.width, height: renderer.domElement.height },
        pixelRatio: renderer.getPixelRatio(),
        safeArea: safeAreaInsets(),
      };
    },
    /** The resample, live (app/UpscalePass.ts): `ratio` = the scene ratio (null = the level's own), `sharpen` = RCAS stops (null = RCAS off, `'auto'` back to the factor's own measured stops), `filter` = 'easu' | 'bilinear' (the upscale control arm) or 'box' | 'tent' (the downsample A/B). No argument reads; null hands the ratio back to the quality level. Returns where it stands. */
    upscale: (opts?: { ratio?: number | null; sharpen?: number | null | 'auto'; filter?: UpscaleFilter | DownsampleFilter } | null) => {
      if (opts !== undefined) {
        if (opts === null || opts.ratio === null) {
          // The ratio goes back to the quality level.
          upscalePinned = false;
          upscalePinRatio = null;
        } else if (opts.ratio !== undefined) {
          upscalePinned = true;
          upscalePinRatio = opts.ratio;
        }
        if (opts !== null) {
          // Naming the stops pins them; 'auto' hands them back to the factor.
          if (opts.sharpen === 'auto') {
            upscaleSharpenPinned = false;
          } else if (opts.sharpen !== undefined) {
            upscaleSharpenStops = opts.sharpen;
            upscaleSharpenPinned = true;
          }
          if (opts.filter === 'box' || opts.filter === 'tent') downsampleFilter = opts.filter;
          else if (opts.filter !== undefined) upscaleFilter = opts.filter;
        }
        refreshQualityPin();
        applySceneResolution('upscale bridge');
      }
      return upscaleState();
    },
    /**
     * Graphics quality: the level, the rung Dynamic sits on, what this display
     * offers and the decision rule's own window. `{level}` is the same as
     * setQuality; `{inject}` feeds synthetic intervals straight to the rule
     * (app/resolutionController.ts IntervalSample) so a browser run can prove
     * the plumbing — a rung moving and the targets re-sizing — without faking
     * load, which no pin can do (a pin holds the rule idle by design).
     */
    quality: (opts?: {
      inject?: IntervalSample[];
      injectGpu?: { readingMs: number; busyMs?: number; starved?: boolean; intervalMs?: number }[];
    } | null) => {
      if ((opts?.inject?.length ?? 0) + (opts?.injectGpu?.length ?? 0) > 0) rungMemoryStopForInjection();
      for (const sample of opts?.inject ?? []) {
        const decision = resolutionController.step(sample);
        if (decision !== null) applyQualityDecision(decision, sample.nowMs);
      }
      // A GPU reading paired with a synthetic frame of its own, the way the
      // sensor's are: the frame counts, and its reading is admitted with it.
      // Call once a frame from a page's own rAF, with the sensor muted
      // (`gpuFrameClock({ mute: true })`) so its real readings stay out.
      for (const r of opts?.injectGpu ?? []) {
        const nowMs = performance.now();
        const intervalMs = r.intervalMs ?? resolutionController.clockBarMs;
        const seq = devInjectSeq--;
        const decision = resolutionController.step({
          nowMs,
          intervalMs,
          mainThreadMs: 1,
          workedMs: 0,
          eligible: true,
          drawSeq: seq,
          gpu: {
            drawSeq: seq,
            generation: resolutionController.generation,
            sampledAtMs: nowMs - intervalMs,
            readingMs: r.readingMs,
            busyMs: r.busyMs ?? 2,
            starved: r.starved ?? false,
          },
        });
        if (decision !== null) applyQualityDecision(decision, nowMs);
      }
      return qualityReadout();
    },
    /**
     * The GPU frame clock, live (app/gpuFrameClock.ts): `on` turns it off or
     * back on for the controller too; `force` samples regardless of what the
     * controller wants (the pixel gate's arm, under a capture pin); `mute`
     * stops the sampling without telling the controller (the inject arm);
     * `flushEvery` false flushes only the fenced frames (the flush A/B);
     * `duty` pins one (the on/off smoothness arm); `record` keeps up to that
     * many raw samples for `gpuFrameSamples()`. Returns the sensor's state.
     */
    gpuFrameClock: (opts?: { on?: boolean; force?: boolean; mute?: boolean; flushEvery?: boolean; duty?: number; record?: number }) => {
      if (opts) {
        gpuFrameClock.devSet(opts);
        if (opts.on === false) resolutionController.setClockOff('turned off from the bridge');
        if (opts.on === true && gpuFrameClock.usable) resolutionController.setClockOff(null);
      }
      return gpuFrameClock.state();
    },
    /** The samples the GPU frame clock kept since `gpuFrameClock({ record: n })`, taken. */
    gpuFrameSamples: () => gpuFrameClock.devTakeSamples(),
    /** Forget the rung Dynamic remembers from the last boot: the stored entry
     *  goes, a remembered rung not yet climbed to is cancelled, and nothing is
     *  written again until the clock holds a rung for a minute. */
    forgetRung: () => {
      rungMemoryForget();
      return rungMemoryReadout();
    },
    /** Pick a level, exactly as the menu row does: saved, applied, reported. */
    setQuality: (level: QualityLevel) => {
      setQualityLevel(level);
      return qualityReadout();
    },
    /** Pick a frame rate, exactly as the menu row does. */
    setFps: (rate: FrameRate) => {
      setFrameRate(rate);
      return qualityReadout().fps;
    },
    /** The last n draws: `{ drawSeq, tickSeq, t, nowMs, busyMs }`, oldest
     *  first. What the pacing gate reads — the intervals between draws, not
     *  between callbacks, and which callback each one landed on. */
    drawLog: (n = 600) => readDrawLog(n),
    /**
     * Settle on DRAWS rather than on callbacks: the wait a capture needs under
     * a frame-rate target, where a callback may draw nothing at all. Two draws
     * by default, which is what the two-rAF settles everywhere else mean.
     */
    waitForDraw: (n = 2) => new Promise<number>((resolve) => {
      const from = drawSeq;
      const poll = () => {
        if (drawSeq - from >= n) resolve(drawSeq);
        else requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    }),
    // The ocean glint's two authored numbers, live: the cap on the peak above
    // white that the bloom sees, and the flat keep on the mirror term. Returns
    // the current pair; a production build has neither knob.
    glint: (opts?: { cap?: number; keep?: number; roughness?: number }) => {
      if (opts?.cap !== undefined) devGlintUniforms.uGlintCap.value = opts.cap;
      if (opts?.keep !== undefined) devGlintUniforms.uGlintKeep.value = opts.keep;
      const roughness = setDevOceanRoughness(opts?.roughness);
      return { cap: devGlintUniforms.uGlintCap.value, keep: devGlintUniforms.uGlintKeep.value, roughness };
    },
    // The grade on a surface's haze, live: how much of the air's haze a direct
    // view shows (world/surfaceShading SURFACE_HAZE_CLEAR_VIEW; 1 is the
    // physics, and the horizon carries the whole column whatever the number),
    // on every body with tables from the next frame. Returns the override in
    // force beside the authored numbers; a production build has no knob.
    haze: (opts?: { clear?: number | null }) => ({
      clear: setDevSurfaceHaze(opts?.clear),
      authored: SURFACE_HAZE_CLEAR_VIEW,
    }),
    /** A GPU profile of the world frame measured on this device, per pass and per object (app/devGpuProfile.ts). */
    gpuProfile: async (opts?: GpuProfileOptions) => {
      if (!gpuProfiler) {
        const { createGpuProfiler } = await import('./app/devGpuProfile');
        gpuProfiler = createGpuProfiler({
          gl: renderer.getContext(),
          // The names the two chains' tables are lined up by: `Lens`, `Bloom`
          // and `OutputPass` on `?fused=0`, and `Bloom` (now including the
          // warp) plus `Finishing` on the fused chain. A removed pass takes a
          // span floor with it, so a per-pass comparison across the two arms
          // overstates the saving unless the floor is quoted beside it.
          passes: () => (composer?.passes ?? []).map((pass) => ({
            name: pass === lensPass ? 'Lens'
              : pass === bloomPass ? 'Bloom'
              : pass instanceof FusedOutputPass ? 'Finishing'
              : pass === outputTargetPass ? 'OutputPass'
              : pass.constructor.name,
            pass: pass as unknown as { render: (...args: unknown[]) => void },
          })),
          sceneRoot: () => scene,
          bindScreen: () => renderer.setRenderTarget(null),
        });
      }
      const result = await gpuProfiler.run(opts);
      (window as any).__moon.gpuProfileResult = result;
      return result;
    },
    /**
     * Can this engine time its own frame's GPU cost finely enough for the
     * resolution rule to steer by (app/devGpuClock.ts)? Cycles a fence poll,
     * the profiler's readback and a GPU timer over the same frames at each
     * output ratio it is given, and answers with the frames themselves.
     */
    gpuClock: async (opts?: GpuClockOptions) => {
      if (!gpuClock) {
        const { createGpuClock } = await import('./app/devGpuClock');
        gpuClock = createGpuClock({
          gl: renderer.getContext(),
          pinRatio: devPinPixelRatio,
          targets: () => devRenderTargets(),
        });
      }
      const result = await gpuClock.run(opts);
      (window as any).__moon.gpuClockResult = result;
      return result;
    },
    ladder: () => planetariumMode?.devLadderStats() ?? null,
    // Pixels per texel of the map each close body is really drawing. Reports
    // with the sector streamer off (?sectors=0), which is what a close-range
    // A/B is run under.
    surfaceDensity: () => planetariumMode?.devSurfaceDensity() ?? [],
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
    // The chart's size: the scale the ☰ row and the corner grip move (1 is
    // the layout's own width), applied without persisting; miniState reports
    // it with the range this canvas allows and any gesture in flight.
    setMiniSize: (scale: number) => planetariumMode?.devSetMiniSize(scale),
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
    setBeltVisible: (visible: boolean) => planetariumMode?.devSetBeltVisible(visible),
    /** The "Orbit lines" setting on its own — setChrome(false) turns it off with the rest. */
    setOrbitLines: (on: boolean) => planetariumMode?.devSetOrbitLines(on),
    /** Move the ship by (dx, dy, dz) AU and nothing else; for a frame() pose, whose camera stays put. */
    nudge: (dxAU: number, dyAU: number, dzAU: number) => planetariumMode?.devNudge(dxAU, dyAU, dzAU),
    setFov: (deg: number) => planetariumMode?.devSetFov(deg),
    setTimeMs: (utcMs: number) => planetariumMode?.devSetTimeMs(utcMs),
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
    // Look-inside bridge. interiorOpen routes through the
    // Planetarium's real entry gate like compareOpen; the rest delegate to the
    // live instance (null before first entry). interiorReady is true only once
    // the map is applied and the cut has settled, so a capture waits on it.
    toolsInsideOpen: () => planetariumMode?.devToolsInsideOpen() ?? false,
    interiorOpen: (bodyId = 'Earth') => planetariumMode?.devEnterInterior(bodyId) ?? false,
    interiorExit: () => interiorMode?.devExit(),
    interiorPick: (bodyId: string) => interiorMode?.devPick(bodyId) ?? false,
    interiorPickerOpen: () => interiorMode?.devPickerOpen() ?? false,
    interiorModel: (modelId: string | null) => interiorMode?.devModel(modelId) ?? false,
    interiorMode: (mode: 'composition' | 'temperature') => interiorMode?.devDisplayMode(mode) ?? false,
    interiorRings: (on: boolean) => interiorMode?.devRings(on) ?? false,
    interiorHover: (x: number, y: number) => interiorMode?.devHover(x, y) ?? null,
    interiorFaceProbe: (regionKey: string) => interiorMode?.devFaceProbe(regionKey) ?? null,
    interiorPin: (regionKey: string | null) => interiorMode?.devPin(regionKey) ?? false,
    interiorEvidence: (claimKind: 'existence' | 'extent' | 'state' | 'composition' | 'temperature' | null) =>
      interiorMode?.devEvidence(claimKind) ?? false,
    interiorEsc: () => interiorMode?.devEsc(),
    // The panel's pages: layers, or the selected region's summary / details / evidence, or the model page.
    interiorPage: (kind: 'layers' | 'summary' | 'details' | 'evidence' | 'model') => interiorMode?.devPage(kind) ?? false,
    interiorUnit: (unit: 'kelvin' | 'celsius') => interiorMode?.devUnit(unit) ?? false,
    interiorOptionsOpen: () => interiorMode?.devOptionsOpen() ?? false,
    interiorView: (view: 'closed' | 'cutaway' | 'section') => interiorMode?.devView(view) ?? false,
    interiorAngle: (deg: number, animate?: boolean) => interiorMode?.devAngle(deg, animate) ?? false,
    interiorScale: (mode: 'true' | 'readable', blend?: number) => interiorMode?.devScale(mode, blend) ?? false,
    interiorTime: (seconds: number) => interiorMode?.devTime(seconds) ?? false,
    interiorFreeze: (on: boolean) => interiorMode?.devFreeze(on) ?? false,
    interiorCutFollow: (on: boolean) => interiorMode?.devCutFollow(on) ?? false,
    interiorResetView: () => interiorMode?.devResetView() ?? false,
    interiorOrbit: (azimuthDeg: number, elevationDeg?: number, distance?: number) =>
      interiorMode?.devOrbit(azimuthDeg, elevationDeg, distance) ?? false,
    interiorReady: () => interiorMode?.devReady() ?? false,
    // The ceremony's lengths for this page load, ALL IN SECONDS, so a sheet of
    // candidates comes out of one build: `beat` and `lift` are the veil's two
    // fades (the CSS's own numbers, which the switch reads back off the
    // element), the rest the studio's moves, and `revealAfterVeil` the order.
    // Session-only. A fade is clamped to something a reader could sit through:
    // `{beat: 250}` is a typo for a quarter of a second, and a 250-second veil
    // is indistinguishable from a hang.
    interiorTransition: (patch: {
      beat?: number; lift?: number; open?: number; close?: number; dissolve?: number; reopen?: number; revealAfterVeil?: boolean;
    } = {}) => {
      const root = document.documentElement;
      const fadeSeconds = (value: unknown): number | null =>
        (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(value, MAX_VEIL_FADE_S) : null);
      const beat = fadeSeconds(patch.beat);
      const lift = fadeSeconds(patch.lift);
      if (beat !== null) root.style.setProperty('--veil-fade', `${beat}s`);
      if (lift !== null) root.style.setProperty('--veil-lift', `${lift}s`);
      const timings = setInteriorTransition({
        openS: patch.open, closeS: patch.close, dissolveS: patch.dissolve, reopenS: patch.reopen,
        revealAfterVeil: patch.revealAfterVeil,
      });
      const style = getComputedStyle(root);
      return {
        beat: style.getPropertyValue('--veil-fade').trim(),
        lift: style.getPropertyValue('--veil-lift').trim(),
        ...timings,
      };
    },
    interiorState: () => interiorMode?.devState() ?? null,
    // Which path the frame draws on: composer target samples (0 = single
    // sample), or the canvas backbuffer's on the direct path.
    renderPath: () => ({
      composer: composer !== null,
      // The tone curve the renderer holds right now: 'aces' in the planetarium,
      // 'neutral' in the Look-inside studio, and the planetarium's again after
      // a visit — the profile is the switch's (app/renderProfile).
      toneMapping: toneMappingWord(renderer.toneMapping),
      sceneTargetSamples: sceneTarget?.samples ?? null,
      // The scene's ratio against the canvas's: apart only with the upscaler on.
      sceneRatio: getScenePixelRatio(),
      outputRatio: getTargetPixelRatio(),
      backbufferSamples: renderer.getContext().getParameter(renderer.getContext().SAMPLES) as number,
      multisampled: sceneDrawMultisampled(),
    }),
    // Raw scene handle for render forensics (visibility bisects: hide one
    // element at a time to isolate what's flashing/leaking light). DEV-only
    // like the rest of the bridge.
    scene: () => scene,
    // Composer pass list for post-pass forensics (patch a pass's shader or
    // uniforms in-page and re-render, no rebuild). Null while a mode bypasses
    // the composer.
    composerPasses: () => composer?.passes ?? null,
    // Boot render gate state + frames drawn under the loading screen.
    bootRender: () => ({ state: bootRender.current, coveredRenders: bootRender.coveredRenders }),
    // Which decoder the streamed-texture flip probe settled on.
    textureDecodePath: () => bitmapDecodePath(),
    // Mode-agnostic leak probe for the enter/exit heap check.
    rendererInfo: () => ({
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      programs: renderer.info.programs?.length ?? 0,
      exposure: renderer.toneMappingExposure,
      pixelRatio: renderer.getPixelRatio(),
      sceneSamples: sceneTarget?.samples ?? 0,
    }),
    // Every linked program with its cache key, for catching a link that
    // happens after the boot warm-up: diff two snapshots and the new entry's
    // key says which material variant compiled mid-flight. The key's tail is
    // the augmentation source three appends, so it is cut at a readable length.
    programs: () => (renderer.info.programs ?? []).map((p: any) => ({
      id: p.id as number,
      type: String(p.type ?? ''),
      name: String(p.name ?? ''),
      usedTimes: p.usedTimes as number,
      keyLength: String(p.cacheKey ?? '').length,
      key: String(p.cacheKey ?? '').slice(0, 700),
    })),
    // Whole-run frame trace behind the smoothness gate: every frame's raf
    // gap, the veil windows, and a one-word cause per frame. smoothStart
    // arms it here; ?smooth=1 arms it before the first frame instead, which
    // is the only way to see a cold boot. smoothMark labels the scenario
    // phase a frame belongs to.
    smoothStart: (maxFrames?: number) => smoothTraceStart(
      { armedBy: 'bridge', userAgent: navigator.userAgent, viewport: `${window.innerWidth}x${window.innerHeight}`, pixelRatio: renderer.getPixelRatio() },
      maxFrames,
    ),
    smoothMark: (label: string) => smoothTraceEvent('mark', label),
    smoothSnapshot: () => smoothTraceSnapshot(),
    smoothStop: () => smoothTraceStop(),
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
  // Upload-parity harness hooks: the sliced uploader has to be driven directly
  // against a one-shot upload of the same source, which needs the renderer and
  // three itself. DEV-only, like the rest of the bridge.
  (window as any).__moonThree = THREE;
  (window as any).__moonRenderer = renderer;
  (window as any).__moonSlice = { begin: beginSlicedUpload, step: stepSlicedUpload };
  // The compressed half of that harness needs a container transcoded and
  // handed over exactly as a tier fetch does: the internal format three picks
  // for a KTX2 rung comes off the file's own colour space and the device's
  // transcode target, so a texture the harness builds itself cannot reproduce
  // it. One loader per page, imported on first use so the transcoder chunk
  // stays off every other DEV boot.
  let parityKtx2: Promise<import('three/examples/jsm/loaders/KTX2Loader.js').KTX2Loader> | null = null;
  (window as any).__moonKtx2 = (url: string) => {
    parityKtx2 ??= import('three/examples/jsm/loaders/KTX2Loader.js').then(({ KTX2Loader }) =>
      new KTX2Loader().setTranscoderPath(import.meta.env.BASE_URL + 'basis/').detectSupport(renderer),
    );
    return parityKtx2.then((loader) => new Promise((resolve, reject) => {
      loader.load(url, resolve, undefined, reject);
    }));
  };
  (window as any).__moonWarm = { queueTextureWarm, pumpTextureWarmQueue, invalidateTextureWarmCache };
  // The GPU-efficiency A/B switches (app/perfSwitches.ts). Installed after the
  // bridge object is built, because that assignment replaces it wholesale, and
  // as a property chain so the perf sweep's own `perfArm` can be added later
  // without either set of keys erasing the other.
  installPerfSwitchBridge();
  // `?glint=0.12` draws open water at that GGX roughness for the session, and
  // `?glint=0.12,0.4,3` sets the mirror term's keep and cap with it: the same
  // knobs as __moon.glint, reachable from a phone's address bar. DEV only.
  if (import.meta.env.DEV) {
    const glint = new URLSearchParams(location.search).get('glint');
    if (glint) {
      const [rough, keep, cap] = glint.split(',').map(Number);
      if (Number.isFinite(rough)) setDevOceanRoughness(rough);
      if (Number.isFinite(keep)) devGlintUniforms.uGlintKeep.value = keep;
      if (Number.isFinite(cap)) devGlintUniforms.uGlintCap.value = cap;
    }
    // `?haze=0.35` shows that much of the air's haze in every direct view of a
    // surface for the session: the __moon.haze knob, reachable from a phone's
    // address bar, so two strengths are two links to compare. DEV only.
    // An empty value is a mistyped link, not a request for zero.
    const haze = new URLSearchParams(location.search).get('haze');
    if (haze && Number.isFinite(Number(haze))) setDevSurfaceHaze(Number(haze));
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
  if (await shedServiceWorkerIfRequested()) {
    // A shedding reload is on its way and nothing has been built. Leave the
    // boot UNSETTLED: the force-hide below reveals only a settled boot, and
    // there is nothing behind the screen here but an empty scene. The reload
    // is bounded too — a navigation that never commits would otherwise keep
    // the loading screen up with nothing to say.
    killSwitchReloading = true;
    // Only a real navigation away counts; a page parked in the back-forward
    // cache comes back to this same unsettled boot and must still time out.
    window.addEventListener('pagehide', (e) => { if (!e.persisted) killSwitchReloading = false; }, { once: true });
    setTimeout(() => {
      if (!killSwitchReloading) return;
      killSwitchReloading = false;
      coverWithBootError(new Error('the ?nosw=1 reload did not happen'), 'The reload did not happen. Please refresh.');
    }, KILL_SWITCH_RELOAD_TIMEOUT_MS);
    return;
  }
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
    // Wall clock at the callback, not the rAF timestamp: after a busy main
    // thread the timestamp is the frame the browser meant to start, which is
    // already stale by the time this runs. Taken first, and once: it is both
    // the simulation's clock and the end of the interval the resolution
    // controller reads.
    const now = performance.now();
    tickSeq++;
    // The schedule, in two calls, each made exactly once and unconditionally:
    // `observe` feeds the calibration, `due` advances the draw counter. A
    // second read, or a reorder behind a short-circuit, would change the
    // cadence. Their answer is OR-ed with the holds, never short-circuited.
    const covered = bootRender.current !== 'live';
    frameCadence.observe(rafTimestamp, covered);
    applyCadenceChange('auto');
    const due = frameCadence.due(rafTimestamp);
    const forced = forcedDrawRequest;
    forcedDrawRequest = false;
    // Under the cover the gate itself decides (draw on request only), so the
    // cap must not skip the requested frame; a failed boot draws nothing
    // either way.
    const willDraw = covered || frameCapHeld() || forced || due;
    noteProgramLinks();
    if (import.meta.env.DEV && willDraw) surfacePerfFrameStart(rafTimestamp);
    if (import.meta.env.DEV) smoothTraceFrameStart(rafTimestamp, willDraw);
    if (import.meta.env.DEV && frameProbe) frameProbe.start();
    // At the top, before the scene updates: the sample describes the interval
    // that ENDS now, i.e. the span since the previous draw, and the figures it
    // needs are the ones that span left behind.
    if (willDraw) stepQuality(now);
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
    const rawDt = (now - lastTime) / 1000;
    const dt = Math.min(rawDt, 0.1); // cap at 100ms to avoid huge jumps
    lastTime = now;

    // The simulation runs on every tick; only what the frame PRESENTS —
    // camera-anchored DOM, the map's projection ledger, the chart — waits for
    // a tick that draws.
    if (appMode === 'planetarium' && planetariumMode) {
      planetariumMode.update(dt, willDraw);
      if (autoExposure) {
        // Already smoothed by the mode's own meter; applied as is.
        exposureCurrent = planetariumMode.takeExposureTarget();
      } else {
        exposureCurrent = 1;
      }
    } else if (appMode === 'moonFlight' && moonFlightMode) {
      moonFlightMode.update(dt);
      exposureCurrent = 1; // other modes render neutral; the veil covers the reset
    } else if (appMode === 'volumeCompare' && volumeCompareMode) {
      volumeCompareMode.update(dt, willDraw);
      exposureCurrent = 1;
    } else if (appMode === 'interior' && interiorMode) {
      interiorMode.update(dt, willDraw);
      exposureCurrent = 1;
    }

    // The capture pin wins over every mode's own exposure, including the
    // planetarium's per-frame solar adaptation.
    if (exposurePin !== null) exposureCurrent = exposurePin;
    renderer.toneMappingExposure = exposureCurrent;
    let drew = false;
    sensorTickMs = 0;
    if (willDraw && bootRender.shouldRender()) {
      drawWorldFrame();
      drawSeq++;
      drew = true;
      // After the corner chart: the fence has to close every draw of the frame.
      gpuClockAfterDraw(now);
      // Every draw resets the count, forced or due, so a cover, a veil or a
      // capture pin can never leave a schedule running ahead of the clock.
      frameCadence.drew(rafTimestamp);
      if (appMode === 'interior') interiorMode?.afterDraw(drawSeq, now);
      if (nextDrawWaiters.length > 0) {
        for (const resolve of nextDrawWaiters.splice(0, nextDrawWaiters.length)) resolve(now);
      }
    }
    if (import.meta.env.DEV && frameProbe) frameProbe.end();
    // Both ends of the app's own tick, in every build: what the next draw
    // hands the resolution controller as the span's main-thread time. A late
    // interval whose app ticks were small is a late frame the app cannot
    // explain by itself, which is the only case fewer pixels would fix.
    // The GPU clock's fence and flush are the sensor's, not the app's: they
    // reach the controller as the interval's sensorMs instead.
    loopBusyMs = performance.now() - now - sensorTickMs;
    if (loopBusyMs > busyMaxSinceDraw) busyMaxSinceDraw = loopBusyMs;
    busySumSinceDraw += loopBusyMs;
    if (import.meta.env.DEV && drew) recordDraw(rafTimestamp, now, loopBusyMs);
  }

  animate();
  debugLog('Animation loop started');

  // Install the diagnostic bridge before the async Planetarium load. This is
  // deliberately early: an entry stall can overlap the last texture-loading
  // unit, and the profiler must remain usable while `ready()` is still false.
  if (import.meta.env.DEV) installDevHooks();

  // `?perf=1` — the on-device perf sweep. A phone has no console and an
  // M-series Mac cannot rank a phone's costs, so the ranking is measured on
  // the screen that is slow. Imported on demand behind the DEV check, so a
  // production build carries none of it and no other DEV boot loads it.
  if (import.meta.env.DEV && new URLSearchParams(location.search).get('perf') === '1') {
    void import('./app/devPerfSweep')
      .then(({ installPerfSweep }) => installPerfSweep({
        ready: () => plmActivated,
        setSynthesis: (on) => planetariumMode?.devSetSynthesis(on),
        setRoleHidden: (role, hidden) => planetariumMode?.devSetRoleHidden(role, hidden),
        setSectorMeshes: (visible) => planetariumMode?.devSetSectorMeshesVisible(visible),
        setChrome: (visible) => planetariumMode?.devSetChrome(visible),
        setShip: (visible) => planetariumMode?.devSetShipVisible(visible),
        shipVisible: () => planetariumMode?.devShipVisible() ?? true,
        budget: () => planetariumMode?.devFrameBudget() ?? null,
        resetBudget: () => planetariumMode?.devResetFrameBudget(),
        // Whether the composer carries a warp at all — a lens pass of its own
        // on `?fused=0`, the shared uniforms on the fused chain — rather than
        // the pass, which the fused chain does not have.
        passes: () => ({ bloom: bloomPass, lensWarp: lensPass !== null || composerLens !== null }),
        setLens: (on) => devSetLensPassOff(!on),
        pinPixelRatio: devPinPixelRatio,
        pixelRatio: () => renderer.getPixelRatio(),
        renderTargets: devRenderTargets,
        setFrameProbe: (probe) => { frameProbe = probe; },
        // Dynamic is held idle for the whole run, not just while the
        // amplifier's pin stands: the sweep un-pins at the end, on a device
        // it has just heated, and a controller woken there would step on the
        // way out of a measurement.
        // And the frame-rate cap with it: the sweep's own fps row counts rAF
        // callbacks against the wall clock, which a cap would make a reading
        // of the display rather than of the layer under test.
        holdQuality: (held) => { qualitySweepHold = held; frameCapSweepHold = held; refreshQualityPin(); },
      }))
      .catch((err) => debugWarn('The perf overlay did not load', err));
  }

  const autoMode = getAutoMode();
  debugLog('Boot mode', { autoMode });
  // The Planetarium always boots first — it owns the saves, the catalog, and
  // the veil semantics — then ?auto=volumeCompare routes on into the compare mode.
  if (!(await switchAppMode('planetarium'))) throw new Error('The planetarium did not start');
  logStartupTimings();

  revealLoadingScreen();
  // Boot is settled — now the data service worker may install (its precache
  // revalidates against the HTTP cache the boot just filled, so this order
  // makes install nearly free instead of competing with boot fetches).
  registerServiceWorker();
  await planetariumMode?.showDeferredResumePromptIfNeeded();

  if (autoMode === 'volumeCompare') {
    // Through the tool's own door, like the ☰ item: it refuses while a
    // tutorial or mission owns the scene, and it snapshots the journey first,
    // so a landed save resumed on this boot is still landed on return.
    if (!planetariumMode?.enterVolumeCompare()) {
      debugLog('?auto=volumeCompare ignored — the scene is owned by a tutorial or mission');
    }
  } else if (autoMode === 'interior') {
    // The same door, carrying the body: `?auto=interior&body=Europa`.
    const bodyId = new URLSearchParams(window.location.search).get('body') || 'Earth';
    if (!planetariumMode?.enterTool({ kind: 'interior', bodyId })) {
      debugLog('?auto=interior ignored — the scene is owned by a tutorial or mission');
    }
  }
}

// ================================================================
// Viewport sync
// ================================================================
// The size the cameras and the renderer were last synced to is the canvas's
// own box (app/viewportSize.ts, where every screen-space consumer reads it):
// the fixed-position rect the interface is laid out on, which on an iPad in
// full screen is not where an in-flow block lands, and which a browser can
// move without a resize event. The window's reading at that sync is kept for
// the per-frame drift check, which compares the window against ITSELF; the
// box is compared against what the observer below last reported.
let windowAtSync: ViewportSize = { width: window.innerWidth, height: window.innerHeight };
/** The canvas's box as last reported — by the observer, or by a sync's own
 *  read. Zero until the canvas has been laid out. */
let observedBox: ViewportSize = { width: 0, height: 0 };

/** The canvas's CSS box now. A layout read: called from a resize, from the
 *  observer (after layout, so it forces none) and from a drift the poll saw —
 *  never on a quiet frame. */
function canvasBox(): ViewportSize {
  return { width: renderer.domElement.clientWidth, height: renderer.domElement.clientHeight };
}

function syncViewport() {
  const windowNow = { width: window.innerWidth, height: window.innerHeight };
  observedBox = canvasBox();
  // The box wherever it has one; the window before the first layout and in
  // hidden/backgrounded states, which can report zeros for both.
  const { width: w, height: h } = resolveViewportSize(observedBox, windowNow);
  if (w === 0 || h === 0) return;
  windowAtSync = windowNow;
  setViewportSize({ width: w, height: h });
  planetariumCamera.aspect = w / h;
  // Re-derives the lens overscan for the new aspect (and calls
  // updateProjectionMatrix); the corner coverage is aspect-dependent.
  applyDesignFov(planetariumCamera, planetariumLens.designFovDeg);
  flightCamera.aspect = w / h;
  flightCamera.updateProjectionMatrix();
  vcCamera.aspect = w / h;
  vcCamera.updateProjectionMatrix();
  interiorCamera.aspect = w / h;
  interiorCamera.updateProjectionMatrix();
  moonFlightMode?.onResize(w / h);
  // Before the resolution is re-applied: the output ratio or the CSS size may
  // have moved, and both change what every quality level means, which rungs
  // exist and how many bytes they hold. The rung is re-clamped into the new
  // ladder here, so the size below is already the settled one.
  recomputeQualityBounds();
  applyRenderResolution();
  applyUpscalePasses();
  // After the renderer's pixel ratio is (re)applied: retune star point sizes,
  // which are scaled by the renderer's ratio — both the compare and planetarium
  // starfields read renderer.getPixelRatio() in onResize, so they must run after.
  volumeCompareMode?.onResize(w / h);
  interiorMode?.onResize(w / h);
  planetariumMode?.onResize();
  // The frames around a resize are the browser's, not the scene's.
  resolutionController.notify('resize', performance.now());
  rungMemoryRecheck();
  debugLog('Resize', {
    width: w, height: h, pixelRatio: renderer.getPixelRatio(),
    // What the box was resolved from, and the bars the page is laid out
    // under: a phone with `?debug=1` answers "where did the canvas go" with
    // these two lines.
    window: `${windowNow.width}x${windowNow.height}`, safeArea: safeAreaInsets(),
    sceneSamples: sceneTarget?.samples ?? 0, sceneRatio: getScenePixelRatio(),
  });
}

window.addEventListener('resize', syncViewport);

// The canvas's box, observed. The box is the fixed-position rect the
// interface is laid out on, and a browser can move that rect with no resize
// event the page can act on — an iPad's full-screen transition did, and the
// renderer stayed sized to the old box under an interface that had moved.
// The observer fires after layout with the new box, so the sync's own read
// forces none; a report that matches the applied size (the initial one, and
// a sync's own resize) is dropped here rather than re-synced.
if (typeof ResizeObserver === 'function') {
  const canvasObserver = new ResizeObserver((entries) => {
    const rect = entries[entries.length - 1]?.contentRect;
    observedBox = rect ? { width: Math.round(rect.width), height: Math.round(rect.height) } : canvasBox();
    const applied = viewportSize();
    if (observedBox.width > 0 && observedBox.height > 0
      && (observedBox.width !== applied.width || observedBox.height !== applied.height)) {
      syncViewport();
    }
  });
  canvasObserver.observe(renderer.domElement);
}

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
document.addEventListener('visibilitychange', () => {
  armViewportCheck();
  // Coming back: the frames either side of the gap are the browser's throttle
  // and not the scene's cost, so the measurement starts again from here — and
  // a cadence window that straddles the time the tab was away says nothing
  // about the display either.
  if (document.visibilityState === 'visible') {
    resolutionController.notify('focus', performance.now());
    frameCadence.resume();
  }
});
window.addEventListener('focus', () => {
  pageFocused = true;
  resolutionController.notify('focus', performance.now());
});
window.addEventListener('blur', () => { pageFocused = false; });

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
  if (viewportDrifted({
    window: { width: window.innerWidth, height: window.innerHeight },
    windowAtSync,
    box: observedBox,
    applied: viewportSize(),
    cameraAspect: camera.aspect,
    rendererPixelRatio: renderer.getPixelRatio(),
    targetPixelRatio: getTargetPixelRatio(),
  })) {
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
/** How long a `?nosw=1` reload may take to leave this document before the
 *  boot gives up on it and says so. */
const KILL_SWITCH_RELOAD_TIMEOUT_MS = 10_000;
/** The ?nosw=1 reload is on its way: this document is being replaced, so it
 *  never becomes a settled boot. */
let killSwitchReloading = false;
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
  initSettled = !killSwitchReloading;
}).catch((err) => coverWithBootError(err, 'Something went wrong. Please refresh.'));

/** The boot has failed for good: settle it, stop drawing, and keep (or bring
 *  back) the loading screen with the message inside it. */
function coverWithBootError(err: unknown, message: string): void {
  initSettled = true;
  debugError('Init failed', err);
  console.error('Init failed:', err);
  // The error screen is opaque and stays: nothing behind it needs drawing.
  bootRender.markFailed();
  // The message lives INSIDE the loading screen, so the screen must stay up
  // (or come back — a failure after the 15s force-hide re-covers the broken
  // scene) for the user to ever read it.
  const loadingMsg = document.getElementById('loading-msg');
  if (loadingMsg) loadingMsg.textContent = message;
  const loadingScreen = document.getElementById('loading-screen');
  if (loadingScreen) {
    loadingScreen.dataset.bootError = '1';
    loadingScreen.classList.remove('hidden');
  }
}
