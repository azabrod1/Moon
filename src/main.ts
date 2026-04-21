/**
 * App entry point. Builds the shared Three.js renderer / scene / camera rig,
 * detects GPU capability (for bloom), owns the animation loop, and coordinates
 * switching between the three modes — Moon view, Planetarium, Moon Flight.
 * All Moon-view-specific UI state (sliders, presets, date mode, camera
 * animations) lives here and will be split out in Phase 3 of the refactor
 * plan (app/ + moonView/ trees).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { SCENE_UNITS } from './shared/constants/sceneUnits';
import { DEG2RAD } from './shared/math/angles';
import { loadAllTextures } from './shared/assets/textureLoader';
import { computeOrbitalState, findEvent, type EventType } from './astronomy/ephemeris';
import {
  LUNAR_ORBIT,
  longitudeDegFromMeanAnomaly,
  meanAnomalyDegFromTrueAnomaly,
  meanMotionDegPerDay,
  orbitDistanceKmFromLongitude,
  trueAnomalyDegFromLongitude,
} from './astronomy/lunarOrbit';
import { orientOrbitPlane } from './moonView/orbitPlane';
import { Earth } from './moonView/bodies/Earth';
import { Moon } from './moonView/bodies/Moon';
import { Sun } from './moonView/bodies/Sun';
import { PlanetariumMode, FIRST_PLANETARIUM_ACTIVATION_TOTAL_UNITS } from './planetarium/PlanetariumMode';
import type { MoonFlightMode } from './moonFlight/MoonFlightMode';
import { OrbitDetailsOverlay } from './moonView/OrbitDetailsOverlay';
import { createMoonOrbitLine, updateMoonOrbitLine } from './moonView/moonOrbitLine';
import { debugError, debugLog, debugWarn } from './shared/debug';
import { formatScaleMultiplier } from './shared/format';

// ================================================================
// Top-level mode
// ================================================================
type AppMode = 'moonView' | 'planetarium' | 'moonFlight';
let appMode: AppMode = 'moonView';
let planetariumMode: PlanetariumMode | null = null;
let moonFlightMode: MoonFlightMode | null = null;
let moonViewMoon: Moon | null = null;
let moonViewSun: Sun | null = null;
let modeSwitchInFlight = false;

interface MoonViewSceneState {
  earth: Earth;
  moon: Moon;
  sun: Sun;
  earthShadowCone: THREE.Mesh;
  moonShadowCone: THREE.Mesh;
}

let moonViewScene: MoonViewSceneState | null = null;
let moonViewSceneInitPromise: Promise<MoonViewSceneState> | null = null;
let moonViewScaleSliderBound = false;
const SHOW_MOON_VIEW_GUIDES = false;

// ================================================================
// Moon-view state
// ================================================================
const state = {
  moonAngle: 180,
  moonMeanAnomaly: 180,
  sunAngle: 0,
  nodeAngle: 0,
  timeSpeed: 0,
  animating: false,
  mode: 'date' as 'manual' | 'date',
  currentDate: new Date(),
  dateTimeSpeed: 0,
};

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

// Test if GPU can actually handle float render targets (needed for bloom)
function canGPUDoBloom(): boolean {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float');
    if (!ext) { debugLog('Bloom test: no float buffer extension'); return false; }
    // Actually create a small float framebuffer and check completeness
    const fb = gl.createFramebuffer();
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, (gl as WebGL2RenderingContext).RGBA16F ?? gl.RGBA,
      4, 4, 0, gl.RGBA, (gl as WebGL2RenderingContext).HALF_FLOAT ?? gl.FLOAT, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteTexture(tex);
    gl.deleteFramebuffer(fb);
    const ok = status === gl.FRAMEBUFFER_COMPLETE;
    debugLog('Bloom test: float FBO', { ok, status });
    return ok;
  } catch (err) {
    debugWarn('Bloom test failed', err);
    return false;
  }
}

// Enable bloom on any device whose GPU supports float framebuffers
const useBloom = canGPUDoBloom();

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

// --- Moon-view camera + controls ---
const moonViewCamera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 500);
const moonOrbitApoapsis = SCENE_UNITS.EARTH_MOON_DIST * (1 + LUNAR_ORBIT.eccentricity);
const PROPORTIONAL_BODY_SCALE = 1;
const MAX_MOON_BODY_SCALE = 8;
moonViewCamera.position.set(moonOrbitApoapsis * 1.1, moonOrbitApoapsis * 0.42, moonOrbitApoapsis * 1.45);

const moonViewControls = new OrbitControls(moonViewCamera, renderer.domElement);
moonViewControls.enableDamping = true;
moonViewControls.dampingFactor = 0.05;
moonViewControls.minDistance = 1.5;
moonViewControls.maxDistance = Math.max(240, moonOrbitApoapsis * 5);
moonViewControls.target.set(0, 0, 0);

// --- Planetarium camera ---
const planetariumCamera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.000001, 200);
planetariumCamera.position.set(-0.0002, 0.0001, 0.0001);

// --- Moon flight camera (own camera so near/far are independent of other modes) ---
const flightCamera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.01, 2000);

// Active camera reference
let camera = moonViewCamera;

// Ambient light
const ambientLight = new THREE.AmbientLight(0x111122, 0.15);
scene.add(ambientLight);

// ================================================================
// Post-processing (bloom enabled based on actual GPU capability)
// ================================================================
debugLog('Post-processing config', { useBloom });

let composer: EffectComposer | null = null;

function getTargetPixelRatio(mode: AppMode): number {
  if (isMobile) return Math.min(window.devicePixelRatio, 2);
  if (mode === 'planetarium') return Math.min(Math.max(window.devicePixelRatio, 1.5), 2.5);
  if (mode === 'moonFlight') return Math.min(Math.max(window.devicePixelRatio, 1.5), 2.5);
  return Math.min(window.devicePixelRatio, 2);
}

function applyRenderResolution(mode: AppMode) {
  const pixelRatio = getTargetPixelRatio(mode);
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (composer) {
    composer.setPixelRatio(pixelRatio);
    composer.setSize(window.innerWidth, window.innerHeight);
  }
}

function buildComposer(cam: THREE.Camera) {
  if (composer) composer.dispose();
  if (!useBloom) { composer = null; return; }

  composer = new EffectComposer(renderer);
  composer.setPixelRatio(getTargetPixelRatio(appMode));
  composer.setSize(window.innerWidth, window.innerHeight);
  composer.addPass(new RenderPass(scene, cam));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    cam === planetariumCamera ? 0.8 : 1.2,
    0.4,
    cam === planetariumCamera ? 0.92 : 0.85,
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
}

applyRenderResolution(appMode);
buildComposer(moonViewCamera);

function renderScene(cam: THREE.Camera) {
  if (composer) {
    composer.render();
  } else {
    renderer.render(scene, cam);
  }
}

function rebuildComposer(cam: THREE.Camera) {
  buildComposer(cam);
}

// ================================================================
// Starfield (Moon-view mode)
// ================================================================
function createStarfield(): THREE.Points {
  const starCount = 8000;
  const positions = new Float32Array(starCount * 3);
  const colors = new Float32Array(starCount * 3);

  for (let i = 0; i < starCount; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = 200 + Math.random() * 50;

    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);

    const temp = 0.8 + Math.random() * 0.4;
    colors[i * 3] = temp;
    colors[i * 3 + 1] = temp * (0.9 + Math.random() * 0.1);
    colors[i * 3 + 2] = temp * (0.8 + Math.random() * 0.2);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.PointsMaterial({
    size: 0.3,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    sizeAttenuation: true,
    depthWrite: false,
  });

  return new THREE.Points(geo, mat);
}

const moonViewStarfield = createStarfield();
scene.add(moonViewStarfield);

// ================================================================
function createEclipticGrid(
  size: number,
  divisions: number,
  centerColor: number,
  gridColor: number,
  exclusionRadius: number,
): THREE.LineSegments {
  const positions: number[] = [];
  const colors: number[] = [];
  const half = size / 2;
  const step = size / divisions;
  const center = divisions / 2;
  const centerColor3 = new THREE.Color(centerColor);
  const gridColor3 = new THREE.Color(gridColor);

  const pushSegment = (x1: number, z1: number, x2: number, z2: number, color: THREE.Color) => {
    positions.push(x1, 0, z1, x2, 0, z2);
    colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
  };

  for (let i = 0; i <= divisions; i++) {
    const offset = -half + i * step;
    const color = i === center ? centerColor3 : gridColor3;

    if (Math.abs(offset) >= exclusionRadius) {
      pushSegment(-half, offset, half, offset, color);
      pushSegment(offset, -half, offset, half, color);
      continue;
    }

    const clippedHalfSpan = Math.sqrt(Math.max(exclusionRadius * exclusionRadius - offset * offset, 0));
    pushSegment(-half, offset, -clippedHalfSpan, offset, color);
    pushSegment(clippedHalfSpan, offset, half, offset, color);
    pushSegment(offset, -half, offset, -clippedHalfSpan, color);
    pushSegment(offset, clippedHalfSpan, offset, half, color);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

  return new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
    }),
  );
}

const moonOrbitLine = createMoonOrbitLine(0x4466aa, SCENE_UNITS.MOON_INCLINATION, 0);
scene.add(moonOrbitLine);

const eclipticGrid = createEclipticGrid(
  moonOrbitApoapsis * 4,
  48,
  0x111133,
  0x0a0a22,
  MAX_MOON_BODY_SCALE * 1.15,
);
scene.add(eclipticGrid);

// ================================================================
// Eclipse / Phase detection
// ================================================================
interface PhaseInfo {
  name: string;
  illumination: number;
  phaseAngle: number;
  eclipseType: 'none' | 'lunar' | 'solar';
  eclipseQuality: number;
}

function computePhaseInfo(moonAngleDeg: number, sunAngleDeg: number, nodeAngleDeg: number): PhaseInfo {
  let phaseAngle = moonAngleDeg - sunAngleDeg;
  while (phaseAngle > 180) phaseAngle -= 360;
  while (phaseAngle < -180) phaseAngle += 360;

  const absPhase = Math.abs(phaseAngle);
  const illumination = (1 - Math.cos(absPhase * DEG2RAD)) / 2;

  let name: string;
  if (absPhase < 10) name = 'New Moon';
  else if (absPhase < 80) name = phaseAngle > 0 ? 'Waxing Crescent' : 'Waning Crescent';
  else if (absPhase < 100) name = phaseAngle > 0 ? 'First Quarter' : 'Last Quarter';
  else if (absPhase < 170) name = phaseAngle > 0 ? 'Waxing Gibbous' : 'Waning Gibbous';
  else name = 'Full Moon';

  let moonRelNode = moonAngleDeg - nodeAngleDeg;
  while (moonRelNode > 180) moonRelNode -= 360;
  while (moonRelNode < -180) moonRelNode += 360;
  const distFromNode = Math.min(Math.abs(moonRelNode), Math.abs(Math.abs(moonRelNode) - 180));
  const nodeProximity = Math.max(0, 1 - distFromNode / 18);

  let eclipseType: 'none' | 'lunar' | 'solar' = 'none';
  let eclipseQuality = 0;

  if (nodeProximity > 0) {
    if (absPhase > 170) {
      eclipseType = 'lunar';
      eclipseQuality = nodeProximity * (absPhase - 170) / 10;
    } else if (absPhase < 10) {
      eclipseType = 'solar';
      eclipseQuality = nodeProximity * (10 - absPhase) / 10;
    }
  }

  return { name, illumination, phaseAngle: absPhase, eclipseType, eclipseQuality: Math.min(1, eclipseQuality) };
}

// ================================================================
// UI bindings (Moon-view mode)
// ================================================================
const moonSlider = document.getElementById('moon-slider') as HTMLInputElement;
const sunSlider = document.getElementById('sun-slider') as HTMLInputElement;
const nodeSlider = document.getElementById('node-slider') as HTMLInputElement;
const moonAngleDisplay = document.getElementById('moon-angle-display')!;
const sunAngleDisplay = document.getElementById('sun-angle-display')!;
const nodeAngleDisplay = document.getElementById('node-angle-display')!;
const phaseNameEl = document.getElementById('phase-name')!;
const phaseDetailEl = document.getElementById('phase-detail')!;
const eclipseAlert = document.getElementById('eclipse-alert')!;
const infoDistance = document.getElementById('info-distance')!;
const infoPhaseAngle = document.getElementById('info-phase-angle')!;
const infoNodeDist = document.getElementById('info-node-dist')!;
const speedDisplay = document.getElementById('speed-display')!;
const moonBodyScaleSlider = document.getElementById('moon-body-scale-slider') as HTMLInputElement;
const moonBodyScaleLabel = document.getElementById('moon-body-scale-label')!;
const orbitDetailsToggle = document.getElementById('orbit-details-toggle') as HTMLInputElement;
const orbitDetailsPanel = document.getElementById('orbit-details-panel')!;
const orbitMajorAxisReadout = document.getElementById('orbit-major-axis-readout')!;
const orbitMinorAxisReadout = document.getElementById('orbit-minor-axis-readout')!;
const orbitFocusOffsetReadout = document.getElementById('orbit-focus-offset-readout')!;
const orbitApsidesReadout = document.getElementById('orbit-apsides-readout')!;
const orbitFocusLabelF1 = document.getElementById('orbit-focus-label-f1')!;
const orbitFocusLabelF2 = document.getElementById('orbit-focus-label-f2')!;
const focusWorld1 = new THREE.Vector3();
const focusWorld2 = new THREE.Vector3();

function syncMoonMeanAnomalyFromDisplayedAngle() {
  const trueAnomalyDeg = trueAnomalyDegFromLongitude(state.moonAngle, state.nodeAngle);
  state.moonMeanAnomaly = meanAnomalyDegFromTrueAnomaly(trueAnomalyDeg);
}

function syncDisplayedMoonAngleFromMeanAnomaly() {
  state.moonAngle = longitudeDegFromMeanAnomaly(state.moonMeanAnomaly, state.nodeAngle);
}

function applyOrbitDetailsVisibility(visible: boolean) {
  orbitDetailsPanel.classList.toggle('visible', visible);
  orbitDetailsOverlay.setVisible(visible);
  orbitFocusLabelF1.classList.toggle('visible', visible);
  orbitFocusLabelF2.classList.toggle('visible', visible);
}

function applyMoonBodyScale(
  earth: Earth,
  moon: Moon,
  sun: Sun,
  earthShadowCone: THREE.Mesh,
  moonShadowCone: THREE.Mesh,
  scale: number,
) {
  earth.setVisualScale(scale);
  moon.setVisualScale(scale);
  sun.setVisualScale(scale);
  earthShadowCone.scale.set(scale, scale, 1);
  moonShadowCone.scale.set(scale, scale, 1);
}

function updateMoonBodyScaleLabel(scale: number) {
  moonBodyScaleLabel.textContent = formatScaleMultiplier(scale);
}

function formatKm(valueKm: number) {
  return `${Math.round(valueKm).toLocaleString()} km`;
}

function placeFocusLabel(label: HTMLElement, worldPosition: THREE.Vector3, cam: THREE.Camera, yOffsetPx: number) {
  const projected = worldPosition.clone().project(cam);
  const isVisible = projected.z >= -1 && projected.z <= 1 &&
    projected.x >= -1 && projected.x <= 1 &&
    projected.y >= -1 && projected.y <= 1;

  if (!isVisible) {
    label.style.display = 'none';
    return;
  }

  const x = ((projected.x + 1) / 2) * window.innerWidth;
  const y = ((-projected.y + 1) / 2) * window.innerHeight + yOffsetPx;
  label.style.display = 'block';
  label.style.left = `${x}px`;
  label.style.top = `${y}px`;
}

function updateOrbitFocusLabels(cam: THREE.Camera) {
  if (!orbitDetailsToggle.checked || appMode !== 'moonView' || !orbitDetailsOverlay.group.visible) {
    orbitFocusLabelF1.style.display = 'none';
    orbitFocusLabelF2.style.display = 'none';
    return;
  }

  orbitDetailsOverlay.getFocusWorldPositions(focusWorld1, focusWorld2);
  placeFocusLabel(orbitFocusLabelF1, focusWorld1, cam, -14);
  placeFocusLabel(orbitFocusLabelF2, focusWorld2, cam, -12);
}

const orbitDetailsOverlay = new OrbitDetailsOverlay();
const orbitDetailsReadout = orbitDetailsOverlay.getReadout();
orbitMajorAxisReadout.textContent = formatKm(orbitDetailsReadout.majorAxisKm);
orbitMinorAxisReadout.textContent = formatKm(orbitDetailsReadout.minorAxisKm);
orbitFocusOffsetReadout.textContent = formatKm(orbitDetailsReadout.focalOffsetKm);
orbitApsidesReadout.textContent =
  `${formatKm(orbitDetailsReadout.periapsisKm)} / ${formatKm(orbitDetailsReadout.apoapsisKm)}`;
orbitDetailsToggle.checked = false;
applyOrbitDetailsVisibility(false);

function updateUIFromState() {
  moonSlider.value = String(state.moonAngle);
  sunSlider.value = String(state.sunAngle);
  nodeSlider.value = String(state.nodeAngle);
  moonAngleDisplay.innerHTML = `${state.moonAngle.toFixed(1)}&deg;`;
  sunAngleDisplay.innerHTML = `${state.sunAngle.toFixed(1)}&deg;`;
  nodeAngleDisplay.innerHTML = `${state.nodeAngle.toFixed(1)}&deg;`;

  const phase = computePhaseInfo(state.moonAngle, state.sunAngle, state.nodeAngle);
  phaseNameEl.textContent = phase.name;
  phaseDetailEl.textContent = `Illumination: ${(phase.illumination * 100).toFixed(1)}%`;

  const shownDistanceKm = orbitDistanceKmFromLongitude(state.moonAngle, state.nodeAngle);
  infoDistance.textContent = `${Math.round(shownDistanceKm).toLocaleString()} km`;
  infoPhaseAngle.innerHTML = `${phase.phaseAngle.toFixed(1)}&deg;`;

  let moonRelNode = state.moonAngle - state.nodeAngle;
  while (moonRelNode > 180) moonRelNode -= 360;
  while (moonRelNode < -180) moonRelNode += 360;
  const distFromNode = Math.min(Math.abs(moonRelNode), Math.abs(Math.abs(moonRelNode) - 180));
  infoNodeDist.innerHTML = `${distFromNode.toFixed(1)}&deg; from node`;

  if (phase.eclipseType === 'lunar') {
    eclipseAlert.className = 'lunar';
    eclipseAlert.style.display = 'block';
    eclipseAlert.textContent = phase.eclipseQuality > 0.7 ? 'TOTAL LUNAR ECLIPSE' :
                                phase.eclipseQuality > 0.3 ? 'Partial Lunar Eclipse' : 'Penumbral Lunar Eclipse';
  } else if (phase.eclipseType === 'solar') {
    eclipseAlert.className = 'solar';
    eclipseAlert.style.display = 'block';
    eclipseAlert.textContent = phase.eclipseQuality > 0.7 ? 'TOTAL SOLAR ECLIPSE' :
                                phase.eclipseQuality > 0.3 ? 'Partial Solar Eclipse' : 'Near Solar Eclipse';
  } else {
    eclipseAlert.style.display = 'none';
  }
}

// Slider listeners
moonSlider.addEventListener('input', () => {
  state.moonAngle = parseFloat(moonSlider.value);
  syncMoonMeanAnomalyFromDisplayedAngle();
  updateUIFromState();
});
sunSlider.addEventListener('input', () => { state.sunAngle = parseFloat(sunSlider.value); updateUIFromState(); });
nodeSlider.addEventListener('input', () => {
  state.nodeAngle = parseFloat(nodeSlider.value);
  syncMoonMeanAnomalyFromDisplayedAngle();
  updateUIFromState();
});
orbitDetailsToggle.addEventListener('change', () => {
  applyOrbitDetailsVisibility(orbitDetailsToggle.checked);
});

// Time controls
document.getElementById('btn-pause')!.addEventListener('click', () => { state.timeSpeed = 0; state.animating = false; speedDisplay.textContent = 'Paused'; });
document.getElementById('btn-play')!.addEventListener('click', () => { state.timeSpeed = 1; state.animating = true; speedDisplay.textContent = '1x'; });
document.getElementById('btn-fast')!.addEventListener('click', () => { state.timeSpeed = Math.min(state.timeSpeed * 2 || 2, 32); state.animating = true; speedDisplay.textContent = `${state.timeSpeed}x`; });
document.getElementById('btn-reverse')!.addEventListener('click', () => {
  if (state.timeSpeed > 0) state.timeSpeed = -1;
  else state.timeSpeed = Math.max(state.timeSpeed * 2 || -1, -32);
  state.animating = true;
  speedDisplay.textContent = `${state.timeSpeed}x`;
});

// Presets
document.getElementById('preset-full-moon')!.addEventListener('click', () => {
  state.moonAngle = state.sunAngle + 180;
  if (state.moonAngle >= 360) state.moonAngle -= 360;
  syncMoonMeanAnomalyFromDisplayedAngle();
  state.timeSpeed = 0; state.animating = false; speedDisplay.textContent = 'Paused';
  updateUIFromState();
});
document.getElementById('preset-new-moon')!.addEventListener('click', () => {
  state.moonAngle = state.sunAngle;
  syncMoonMeanAnomalyFromDisplayedAngle();
  state.timeSpeed = 0; state.animating = false; speedDisplay.textContent = 'Paused';
  updateUIFromState();
});
document.getElementById('preset-lunar-eclipse')!.addEventListener('click', () => {
  state.nodeAngle = state.sunAngle;
  state.moonAngle = state.sunAngle + 180;
  if (state.moonAngle >= 360) state.moonAngle -= 360;
  syncMoonMeanAnomalyFromDisplayedAngle();
  state.timeSpeed = 0; state.animating = false; speedDisplay.textContent = 'Paused';
  updateUIFromState();
});
document.getElementById('preset-solar-eclipse')!.addEventListener('click', () => {
  state.nodeAngle = state.sunAngle;
  state.moonAngle = state.sunAngle;
  syncMoonMeanAnomalyFromDisplayedAngle();
  state.timeSpeed = 0; state.animating = false; speedDisplay.textContent = 'Paused';
  updateUIFromState();
});

// Camera views
const MOON_VIEW_DEFAULT_FOV = 50;

function animateCamera(targetPos: THREE.Vector3, targetLook: THREE.Vector3, targetFov: number = MOON_VIEW_DEFAULT_FOV) {
  const startPos = moonViewCamera.position.clone();
  const startTarget = moonViewControls.target.clone();
  const startFov = moonViewCamera.fov;
  const duration = 1000;
  const startTime = performance.now();
  function step() {
    const elapsed = performance.now() - startTime;
    const t = Math.min(elapsed / duration, 1);
    const ease = t * t * (3 - 2 * t);
    moonViewCamera.position.lerpVectors(startPos, targetPos, ease);
    moonViewControls.target.lerpVectors(startTarget, targetLook, ease);
    const fov = startFov + (targetFov - startFov) * ease;
    if (fov !== moonViewCamera.fov) {
      moonViewCamera.fov = fov;
      moonViewCamera.updateProjectionMatrix();
    }
    moonViewControls.update();
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function getSunDirForCamera(): THREE.Vector3 {
  if (moonViewSun) {
    return moonViewSun.group.position.clone().normalize();
  }
  return new THREE.Vector3(1, 0, 0);
}

function getMoonDirForCamera(): THREE.Vector3 {
  if (moonViewMoon) {
    return moonViewMoon.getWorldPosition().normalize();
  }
  return new THREE.Vector3(1, 0, 0);
}

function animateOverviewCamera() {
  const sunDir = getSunDirForCamera();
  const pos = sunDir.clone().multiplyScalar(-moonOrbitApoapsis * 2.25).add(
    new THREE.Vector3(0, moonOrbitApoapsis * 0.8, 0),
  );
  animateCamera(pos, new THREE.Vector3(0, 0, 0));
}

function animateTopDownCamera() {
  animateCamera(new THREE.Vector3(0, moonOrbitApoapsis * 3.2, 0.001), new THREE.Vector3(0, 0, 0));
}

function animateEarthObserverCamera() {
  // Always face the Moon. Sit just above Earth's atmosphere shell (1.06 radii)
  // so we don't render the backside of the atmosphere glow, but close enough to
  // geocentric that eclipse geometry still reads correctly.
  const moonDir = getMoonDirForCamera();
  const camPos = moonDir.clone().multiplyScalar(SCENE_UNITS.EARTH_RADIUS * 1.08);
  const lookAt = moonDir.clone().multiplyScalar(SCENE_UNITS.EARTH_SUN_DIST);
  // Narrow FOV so the Moon's 0.5° disc is actually visible — wide enough to
  // keep the Sun in frame during crescent/eclipse phases.
  animateCamera(camPos, lookAt, 12);
}

function animateMoonObserverCamera() {
  // Mirror of "From Earth": sit just above the Moon on the Earth-facing side,
  // look back at Earth. Earth from the Moon is ~1.9° across, so the same 12° FOV
  // frames it larger than the Moon appears from Earth — which is realistic.
  if (!moonViewMoon) return;
  const moonPos = moonViewMoon.getWorldPosition();
  const earthDir = moonPos.clone().negate().normalize();
  const camPos = moonPos.clone().add(earthDir.clone().multiplyScalar(SCENE_UNITS.MOON_RADIUS * 1.05));
  animateCamera(camPos, new THREE.Vector3(0, 0, 0), 12);
}

function animateSideCamera() {
  const sunDir = getSunDirForCamera();
  const sideDir = new THREE.Vector3(-sunDir.z, 0, sunDir.x).normalize();
  const pos = sideDir.multiplyScalar(moonOrbitApoapsis * 2.6).add(new THREE.Vector3(0, moonOrbitApoapsis * 0.28, 0));
  animateCamera(pos, new THREE.Vector3(0, 0, 0));
}

document.getElementById('view-default')!.addEventListener('click', animateOverviewCamera);
document.getElementById('view-top')!.addEventListener('click', animateTopDownCamera);
document.getElementById('view-earth')!.addEventListener('click', animateEarthObserverCamera);
document.getElementById('view-moon')!.addEventListener('click', animateMoonObserverCamera);
document.getElementById('view-side')!.addEventListener('click', animateSideCamera);

// ================================================================
// Mode toggle (Custom vs Date)
// ================================================================
const manualControls = document.getElementById('manual-controls')!;
const dateControls = document.getElementById('date-controls')!;
const modeManualBtn = document.getElementById('mode-manual')!;
const modeDateBtn = document.getElementById('mode-date')!;
const datePicker = document.getElementById('date-picker') as HTMLInputElement;
const dateInfo = document.getElementById('date-info')!;
const dateSpeedDisplay = document.getElementById('date-speed-display')!;

function setMode(mode: 'manual' | 'date') {
  state.mode = mode;
  if (mode === 'manual') {
    manualControls.style.display = 'block';
    dateControls.style.display = 'none';
    modeManualBtn.classList.add('active');
    modeDateBtn.classList.remove('active');
  } else {
    manualControls.style.display = 'none';
    dateControls.style.display = 'block';
    modeManualBtn.classList.remove('active');
    modeDateBtn.classList.add('active');
    state.dateTimeSpeed = 0;
    dateSpeedDisplay.textContent = 'Paused';
    applyDateToState(state.currentDate);
  }
}

function applyDateToState(date: Date) {
  state.currentDate = date;
  const orbital = computeOrbitalState(date);
  state.sunAngle = orbital.sunLongitude;
  state.moonAngle = orbital.moonLongitude;
  state.nodeAngle = orbital.moonNodeLongitude;
  syncMoonMeanAnomalyFromDisplayedAngle();

  const localISO = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  datePicker.value = localISO;
  dateInfo.textContent = date.toUTCString().replace('GMT', 'UTC');
  updateUIFromState();
}

modeManualBtn.addEventListener('click', () => setMode('manual'));
modeDateBtn.addEventListener('click', () => { state.currentDate = new Date(); setMode('date'); });
datePicker.addEventListener('input', () => {
  if (datePicker.value) applyDateToState(new Date(datePicker.value + 'Z'));
});
document.getElementById('btn-now')!.addEventListener('click', () => applyDateToState(new Date()));

// Date time controls
document.getElementById('btn-date-pause')!.addEventListener('click', () => { state.dateTimeSpeed = 0; dateSpeedDisplay.textContent = 'Paused'; });
document.getElementById('btn-date-play')!.addEventListener('click', () => { state.dateTimeSpeed = 1; dateSpeedDisplay.textContent = '1 day/s'; });
document.getElementById('btn-date-fast')!.addEventListener('click', () => {
  state.dateTimeSpeed = Math.min((state.dateTimeSpeed || 1) * 2, 365);
  dateSpeedDisplay.textContent = `${state.dateTimeSpeed} day/s`;
});
document.getElementById('btn-date-reverse')!.addEventListener('click', () => {
  if (state.dateTimeSpeed > 0) state.dateTimeSpeed = -1;
  else state.dateTimeSpeed = Math.max((state.dateTimeSpeed || -1) * 2, -365);
  dateSpeedDisplay.textContent = `${state.dateTimeSpeed} day/s`;
});

// Jump-to-event
function jumpToEvent(eventType: EventType, direction: 1 | -1) {
  const btn = document.activeElement as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  setTimeout(() => {
    const result = findEvent(eventType, state.currentDate, direction);
    if (result) { state.dateTimeSpeed = 0; dateSpeedDisplay.textContent = 'Paused'; applyDateToState(result); }
    if (btn) btn.disabled = false;
  }, 10);
}

document.getElementById('nav-prev-full')!.addEventListener('click', () => jumpToEvent('full-moon', -1));
document.getElementById('nav-next-full')!.addEventListener('click', () => jumpToEvent('full-moon', 1));
document.getElementById('nav-prev-new')!.addEventListener('click', () => jumpToEvent('new-moon', -1));
document.getElementById('nav-next-new')!.addEventListener('click', () => jumpToEvent('new-moon', 1));
document.getElementById('nav-prev-lunar')!.addEventListener('click', () => jumpToEvent('lunar-eclipse', -1));
document.getElementById('nav-next-lunar')!.addEventListener('click', () => jumpToEvent('lunar-eclipse', 1));
document.getElementById('nav-prev-solar')!.addEventListener('click', () => jumpToEvent('solar-eclipse', -1));
document.getElementById('nav-next-solar')!.addEventListener('click', () => jumpToEvent('solar-eclipse', 1));

// ================================================================
// Top-level mode switching (Moon view <-> Planetarium)
// ================================================================
const moonViewUI = document.getElementById('moon-view-ui')!;
const planetariumUI = document.getElementById('planetarium-ui')!;
const modeTransition = document.getElementById('mode-transition')!;
const transitionMsg = document.getElementById('transition-msg')!;
const btnModeMoonView = document.getElementById('btn-mode-moon-view')!;
const btnModePlanetarium = document.getElementById('btn-mode-planetarium')!;

// Moon-view scene objects (hidden while Planetarium is active)
const moonViewObjects: THREE.Object3D[] = [];

function isLoadingScreenVisible(): boolean {
  const loadingScreen = document.getElementById('loading-screen');
  return !!loadingScreen && !loadingScreen.classList.contains('hidden');
}

function setPlanetsLoadingPercent(completedUnits: number, totalUnits: number) {
  const clampedTotalUnits = Math.max(totalUnits, 1);
  const clampedCompletedUnits = Math.min(Math.max(completedUnits, 0), clampedTotalUnits);
  const pct = Math.round((clampedCompletedUnits / clampedTotalUnits) * 100);
  const text = `Loading Planets... ${pct}%`;
  const loadEl = document.getElementById('loading-msg');
  if (loadEl) loadEl.textContent = text;
  transitionMsg.textContent = text;
}

function setMoonViewLoadingPercent(loaded: number, total: number) {
  const pct = Math.round((Math.min(Math.max(loaded, 0), Math.max(total, 1)) / Math.max(total, 1)) * 100);
  const text = `Loading Moon... ${pct}%`;
  const loadEl = document.getElementById('loading-msg');
  if (loadEl) loadEl.textContent = text;
  transitionMsg.textContent = text;
}

function setFlightLoadingPercent(completedUnits: number, totalUnits: number) {
  const clampedTotal = Math.max(totalUnits, 1);
  const clampedDone = Math.min(Math.max(completedUnits, 0), clampedTotal);
  const pct = Math.round((clampedDone / clampedTotal) * 100);
  const text = `Entering Flight... ${pct}%`;
  const loadEl = document.getElementById('loading-msg');
  if (loadEl) loadEl.textContent = text;
  transitionMsg.textContent = text;
}

async function ensureMoonViewScene(
  onProgress?: (loaded: number, total: number) => void,
): Promise<MoonViewSceneState> {
  if (moonViewScene) {
    onProgress?.(1, 1);
    return moonViewScene;
  }

  if (!moonViewSceneInitPromise) {
    moonViewSceneInitPromise = (async () => {
      const textures = await loadAllTextures((loaded, total) => {
        onProgress?.(loaded, total);
      });
      debugLog('Base textures loaded', Object.keys(textures));

      const earth = new Earth(textures);
      scene.add(earth.group);
      moonViewObjects.push(earth.group);

      const moon = new Moon(textures);
      moonViewMoon = moon;
      scene.add(moon.orbitGroup);
      moonViewObjects.push(moon.orbitGroup);

      scene.add(orbitDetailsOverlay.group);
      moonViewObjects.push(orbitDetailsOverlay.group);

      const sun = new Sun(useBloom);
      moonViewSun = sun;
      scene.add(sun.group);
      moonViewObjects.push(sun.group);

      moonViewObjects.push(moonOrbitLine, eclipticGrid);

      const earthShadowCone = createShadowCone(SCENE_UNITS.EARTH_RADIUS, 0x331111);
      scene.add(earthShadowCone);
      moonViewObjects.push(earthShadowCone);

      const moonShadowCone = createShadowCone(SCENE_UNITS.MOON_RADIUS * 0.8, 0x111133);
      scene.add(moonShadowCone);
      moonViewObjects.push(moonShadowCone);

      moonBodyScaleSlider.min = String(PROPORTIONAL_BODY_SCALE);
      moonBodyScaleSlider.max = String(MAX_MOON_BODY_SCALE);
      moonBodyScaleSlider.step = '0.1';
      moonBodyScaleSlider.value = String(PROPORTIONAL_BODY_SCALE);
      updateMoonBodyScaleLabel(PROPORTIONAL_BODY_SCALE);

      moonViewScene = {
        earth,
        moon,
        sun,
        earthShadowCone,
        moonShadowCone,
      };

      applyMoonBodyScale(earth, moon, sun, earthShadowCone, moonShadowCone, PROPORTIONAL_BODY_SCALE);
      if (!moonViewScaleSliderBound) {
        moonBodyScaleSlider.addEventListener('input', () => {
          const scale = parseFloat(moonBodyScaleSlider.value);
          updateMoonBodyScaleLabel(scale);
          if (!moonViewScene) return;
          applyMoonBodyScale(
            moonViewScene.earth,
            moonViewScene.moon,
            moonViewScene.sun,
            moonViewScene.earthShadowCone,
            moonViewScene.moonShadowCone,
            scale,
          );
        });
        moonViewScaleSliderBound = true;
      }

      applyDateToState(state.currentDate);
      sun.setPosition(state.sunAngle);
      moon.setOrbitalPosition(state.moonAngle, state.nodeAngle);
      debugLog('Moon-view scene ready');

      return moonViewScene;
    })();
    moonViewSceneInitPromise.catch(() => {
      moonViewSceneInitPromise = null;
    });
  }

  return moonViewSceneInitPromise;
}

function showMoonViewVisuals() {
  for (const obj of moonViewObjects) obj.visible = true;
  orbitDetailsOverlay.group.visible = orbitDetailsToggle.checked;
  moonViewStarfield.visible = true;
  moonOrbitLine.visible = true;
  eclipticGrid.visible = SHOW_MOON_VIEW_GUIDES;
  moonViewUI.style.display = 'block';
  moonViewControls.enabled = true;
  ambientLight.visible = true;
  const toggle = document.getElementById('btn-toggle-panel');
  if (toggle) toggle.style.display = '';
}

function hideMoonViewVisuals() {
  for (const obj of moonViewObjects) obj.visible = false;
  moonViewStarfield.visible = false;
  moonOrbitLine.visible = false;
  eclipticGrid.visible = false;
  moonViewUI.style.display = 'none';
  moonViewControls.enabled = false;
  ambientLight.visible = false;
  const toggle = document.getElementById('btn-toggle-panel');
  if (toggle) toggle.style.display = 'none';
}

async function switchAppMode(newMode: AppMode) {
  btnModeMoonView.classList.toggle('active', newMode === 'moonView');
  btnModePlanetarium.classList.toggle('active', newMode === 'planetarium');

  if (newMode === appMode) {
    if (newMode === 'moonView') {
      planetariumUI.style.display = 'none';
      showMoonViewVisuals();
      camera = moonViewCamera;
      applyRenderResolution('moonView');
      rebuildComposer(moonViewCamera);
    }
    return;
  }
  if (modeSwitchInFlight) return;
  modeSwitchInFlight = true;
  debugLog('Switching app mode', { from: appMode, to: newMode });

  try {
    // Fade to black
    modeTransition.classList.add('active');
    if (newMode === 'planetarium') transitionMsg.textContent = 'Entering Planets...';
    else if (newMode === 'moonFlight') transitionMsg.textContent = 'Entering Flight...';
    else transitionMsg.textContent = 'Returning to Moon...';
    await sleep(400);

    if (newMode === 'planetarium') {
      // --- Switch to Planetarium ---
      appMode = 'planetarium';
      hideMoonViewVisuals();
      if (moonFlightMode) moonFlightMode.deactivate();
      scene.background = new THREE.Color(0x000000);

      camera = planetariumCamera;
      applyRenderResolution('planetarium');
      rebuildComposer(planetariumCamera);

      if (!planetariumMode) {
        debugLog('Creating Planetarium mode');
        planetariumMode = new PlanetariumMode(scene, planetariumCamera, renderer, useBloom);
      }
      debugLog('Activating Planetarium mode');
      if (!planetariumMode.hasLoadedSolarSystem()) {
        const totalUnits = FIRST_PLANETARIUM_ACTIVATION_TOTAL_UNITS;
        setPlanetsLoadingPercent(0, totalUnits);
        await planetariumMode.activate((progress) => {
          setPlanetsLoadingPercent(progress.completedUnits, totalUnits);
        });
      } else {
        await planetariumMode.activate();
      }
      debugLog('Planetarium mode active');

    } else if (newMode === 'moonFlight') {
      // --- Switch to Moon Flight ---
      appMode = 'moonFlight';
      hideMoonViewVisuals();
      if (planetariumMode) planetariumMode.deactivate();
      planetariumUI.style.display = 'none';
      scene.background = new THREE.Color(0x000000);

      camera = flightCamera;
      applyRenderResolution('moonFlight');
      rebuildComposer(flightCamera);

      // Dynamic import: flight code + future assets stay out of the initial bundle
      // until the user actually enters this mode.
      if (!moonFlightMode) {
        setFlightLoadingPercent(0, 1);
        debugLog('Loading moon flight module');
        const mod = await import('./moonFlight/MoonFlightMode');
        moonFlightMode = new mod.MoonFlightMode(scene, flightCamera, renderer);
        moonFlightMode.onExit(() => {
          void switchAppMode('moonView');
        });
      }
      debugLog('Activating moon flight mode');
      const entryDate = new Date(state.currentDate.getTime());
      if (!moonFlightMode.hasLoaded()) {
        await moonFlightMode.activate(entryDate, (progress) => {
          setFlightLoadingPercent(progress.completedUnits, progress.totalUnits);
        });
      } else {
        await moonFlightMode.activate(entryDate);
      }
      debugLog('Moon flight mode active');

    } else {
      // --- Switch to Moon view ---
      if (!moonViewScene) {
        setMoonViewLoadingPercent(0, 1);
        await ensureMoonViewScene((loaded, total) => {
          setMoonViewLoadingPercent(loaded, total);
        });
      }

      appMode = 'moonView';

      scene.background = new THREE.Color(0x000000);

      if (planetariumMode) planetariumMode.deactivate();
      if (moonFlightMode) moonFlightMode.deactivate();

      showMoonViewVisuals();

      camera = moonViewCamera;
      applyRenderResolution('moonView');
      rebuildComposer(moonViewCamera);
      debugLog('Moon-view mode active');
    }

    // Fade back in
    await sleep(100);
    modeTransition.classList.remove('active');
  } finally {
    modeSwitchInFlight = false;
  }
}

btnModeMoonView.addEventListener('click', () => switchAppMode('moonView'));
btnModePlanetarium.addEventListener('click', () => switchAppMode('planetarium'));

// Mobile panel toggle
const panelToggleBtn = document.getElementById('btn-toggle-panel');
const controlsPanel = document.getElementById('controls-panel');
if (panelToggleBtn && controlsPanel) {
  panelToggleBtn.addEventListener('click', () => {
    controlsPanel.classList.toggle('panel-open');
    panelToggleBtn.textContent = controlsPanel.classList.contains('panel-open') ? '\u2715' : '\u2630';
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function getAutoMode(): AppMode | null {
  const params = new URLSearchParams(window.location.search);
  const auto = params.get('auto');
  return auto === 'planetarium' || auto === 'moonView' ? auto : null;
}

// ================================================================
// Main init
// ================================================================
async function init() {
  (window as any).__initStarted = true;
  debugLog('Init started');
  const autoMode = getAutoMode();
  const initialMode = autoMode ?? 'planetarium';
  if (initialMode === 'moonView') {
    await ensureMoonViewScene((loaded, total) => {
      const pct = Math.round((loaded / total) * 100);
      const loadEl = document.getElementById('loading-msg');
      if (loadEl) loadEl.textContent = `Loading textures... ${pct}%`;
    });
  }

  // Animation loop
  let lastTime = performance.now();

  function animate() {
    requestAnimationFrame(animate);
    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.1); // cap at 100ms to avoid huge jumps
    lastTime = now;

    const mv = moonViewScene;
    if (appMode === 'moonView' && mv) {
      // --- Moon view update ---
      if (state.mode === 'manual' && state.animating && state.timeSpeed !== 0) {
        state.moonMeanAnomaly += state.timeSpeed * meanMotionDegPerDay() * dt;
        state.sunAngle += state.timeSpeed * 0.986 * dt;
        state.nodeAngle -= state.timeSpeed * 0.053 * dt;
        state.moonMeanAnomaly = ((state.moonMeanAnomaly % 360) + 360) % 360;
        state.sunAngle = ((state.sunAngle % 360) + 360) % 360;
        state.nodeAngle = ((state.nodeAngle % 360) + 360) % 360;
        syncDisplayedMoonAngleFromMeanAnomaly();
        updateUIFromState();
      } else if (state.mode === 'date' && state.dateTimeSpeed !== 0) {
        const msPerDay = 86_400_000;
        state.currentDate = new Date(state.currentDate.getTime() + state.dateTimeSpeed * msPerDay * dt);
        applyDateToState(state.currentDate);
      }

      mv.sun.setPosition(state.sunAngle);
      mv.sun.update(dt);
      mv.moon.setOrbitalPosition(state.moonAngle, state.nodeAngle);
      updateMoonOrbitLine(
        moonOrbitLine,
        mv.moon.group.position,
        mv.moon.mesh.scale.x,
        SCENE_UNITS.MOON_INCLINATION,
        state.nodeAngle * DEG2RAD,
      );
      const phase = computePhaseInfo(state.moonAngle, state.sunAngle, state.nodeAngle);
      mv.moon.setEclipseAppearance(phase.eclipseType, phase.eclipseQuality);
      const sunDir = mv.sun.getDirection();
      mv.earth.update(dt, sunDir);
      orbitDetailsOverlay.update(state.nodeAngle, state.moonMeanAnomaly);
      updateShadowCones(mv.earthShadowCone, mv.moonShadowCone, mv.sun, mv.moon);
      moonViewControls.update();

    } else if (appMode === 'planetarium' && planetariumMode) {
      // --- Planetarium update ---
      planetariumMode.update(dt);
    } else if (appMode === 'moonFlight' && moonFlightMode) {
      // --- Moon flight update ---
      moonFlightMode.update(dt);
    }

    updateOrbitFocusLabels(camera);
    renderScene(camera);
  }

  animate();
  debugLog('Animation loop started');

  debugLog('Initial mode selected', { initialMode });
  if (autoMode) {
    debugLog('Auto mode requested', { autoMode });
    if (autoMode === 'planetarium') {
      await switchAppMode('planetarium');
    } else {
      await switchAppMode('moonView');
    }
  } else {
    // Default to Planets mode
    await switchAppMode('planetarium');
  }

  document.getElementById('loading-screen')?.classList.add('hidden');
  await planetariumMode?.showDeferredResumePromptIfNeeded();
}

// ================================================================
// Shadow cone visualization
// ================================================================
function createShadowCone(baseRadius: number, color: number): THREE.Mesh {
  const length = SCENE_UNITS.EARTH_MOON_DIST * 1.5;
  const geo = new THREE.ConeGeometry(baseRadius, length, 32, 1, true);
  geo.translate(0, length / 2, 0);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false,
  });
  return new THREE.Mesh(geo, mat);
}

const _quat = new THREE.Quaternion();

function orientConeAlongDir(cone: THREE.Mesh, origin: THREE.Vector3, direction: THREE.Vector3) {
  cone.position.copy(origin);
  _quat.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction.clone().normalize());
  cone.quaternion.copy(_quat);
}

function updateShadowCones(earthCone: THREE.Mesh, moonCone: THREE.Mesh, sun: Sun, moon: Moon) {
  const sunDir = sun.getDirection();
  const antiSun = sunDir.clone().negate();

  orientConeAlongDir(earthCone, new THREE.Vector3(0, 0, 0), antiSun);
  earthCone.visible = true;

  const phase = computePhaseInfo(state.moonAngle, state.sunAngle, state.nodeAngle);
  const moonPos = moon.getWorldPosition();
  if (phase.phaseAngle < 20) {
    orientConeAlongDir(moonCone, moonPos, antiSun);
    moonCone.visible = true;
  } else {
    moonCone.visible = false;
  }
}

// ================================================================
// Resize handler
// ================================================================
window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  moonViewCamera.aspect = w / h;
  moonViewCamera.updateProjectionMatrix();
  planetariumCamera.aspect = w / h;
  planetariumCamera.updateProjectionMatrix();
  flightCamera.aspect = w / h;
  flightCamera.updateProjectionMatrix();
  moonFlightMode?.onResize(w / h);
  applyRenderResolution(appMode);
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
