import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { SCENE, DEG2RAD, RAD2DEG } from './utils/constants';
import { loadAllTextures } from './utils/textures';
import { computeOrbitalState, findEvent, type EventType } from './utils/ephemeris';
import {
  LUNAR_ORBIT,
  createOrbitPoints,
  longitudeDegFromMeanAnomaly,
  meanAnomalyDegFromTrueAnomaly,
  meanMotionDegPerDay,
  orbitDistanceKmFromLongitude,
  trueAnomalyDegFromLongitude,
} from './utils/lunarOrbit';
import { orientOrbitPlane } from './utils/orbitPlane';
import { Earth } from './bodies/Earth';
import { Moon } from './bodies/Moon';
import { Sun } from './bodies/Sun';
import { ExploreMode, FIRST_EXPLORE_ACTIVATION_TOTAL_UNITS } from './explore/ExploreMode';
import { OrbitDetailsOverlay } from './simulator/OrbitDetailsOverlay';
import { debugError, debugLog, debugWarn } from './utils/debug';
import { formatScaleMultiplier } from './utils/formatting';

// ================================================================
// Top-level mode
// ================================================================
type AppMode = 'simulator' | 'explore';
let appMode: AppMode = 'simulator';
let exploreMode: ExploreMode | null = null;
let simMoonRef: Moon | null = null;
let simSunRef: Sun | null = null;
let modeSwitchInFlight = false;
const BASE_PLANETS_BOOT_TEXTURE_UNITS = 5;
const INITIAL_PLANETS_BOOT_TOTAL_UNITS =
  BASE_PLANETS_BOOT_TEXTURE_UNITS + FIRST_EXPLORE_ACTIVATION_TOTAL_UNITS;

// ================================================================
// Simulator State
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

// --- Simulator camera + controls ---
const simCamera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 500);
const moonOrbitApoapsis = SCENE.EARTH_MOON_DIST * (1 + LUNAR_ORBIT.eccentricity);
const PROPORTIONAL_BODY_SCALE = 1;
const MAX_MOON_BODY_SCALE = 8;
simCamera.position.set(moonOrbitApoapsis * 1.1, moonOrbitApoapsis * 0.42, moonOrbitApoapsis * 1.45);

const simControls = new OrbitControls(simCamera, renderer.domElement);
simControls.enableDamping = true;
simControls.dampingFactor = 0.05;
simControls.minDistance = 1.5;
simControls.maxDistance = Math.max(240, moonOrbitApoapsis * 5);
simControls.target.set(0, 0, 0);

// --- Explore camera ---
const exploreCamera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.000001, 200);
exploreCamera.position.set(-0.0002, 0.0001, 0.0001);

// Active camera reference
let camera = simCamera;

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
  if (mode === 'explore') return Math.min(Math.max(window.devicePixelRatio, 1.5), 2.5);
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
    cam === exploreCamera ? 0.8 : 1.2,
    0.4,
    cam === exploreCamera ? 0.92 : 0.85,
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
}

applyRenderResolution(appMode);
buildComposer(simCamera);

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
// Starfield (simulator mode)
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

const simStarfield = createStarfield();
scene.add(simStarfield);

// ================================================================
// Orbit visualization (simulator mode)
// ================================================================
function createOrbitLine(segments: number, color: number, inclination: number, nodeAngle: number): THREE.Line {
  const points = createOrbitPoints(segments);
  const geo = new THREE.BufferGeometry().setFromPoints(points);
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.25 });
  const line = new THREE.Line(geo, mat);
  orientOrbitPlane(line, inclination, nodeAngle);
  return line;
}

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

const moonOrbitLine = createOrbitLine(192, 0x4466aa, SCENE.MOON_INCLINATION, 0);
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
// UI bindings (simulator mode)
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
  if (!orbitDetailsToggle.checked || appMode !== 'simulator') {
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
function animateCamera(targetPos: THREE.Vector3, targetLook: THREE.Vector3) {
  const startPos = simCamera.position.clone();
  const startTarget = simControls.target.clone();
  const duration = 1000;
  const startTime = performance.now();
  function step() {
    const elapsed = performance.now() - startTime;
    const t = Math.min(elapsed / duration, 1);
    const ease = t * t * (3 - 2 * t);
    simCamera.position.lerpVectors(startPos, targetPos, ease);
    simControls.target.lerpVectors(startTarget, targetLook, ease);
    simControls.update();
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function getSunDirForCamera(): THREE.Vector3 {
  if (simSunRef) {
    return simSunRef.group.position.clone().normalize();
  }
  return new THREE.Vector3(1, 0, 0);
}

function getMoonDirForCamera(): THREE.Vector3 {
  if (simMoonRef) {
    return simMoonRef.getWorldPosition().normalize();
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
  const phase = computePhaseInfo(state.moonAngle, state.sunAngle, state.nodeAngle);
  const targetDir = phase.phaseAngle < 90 ? getSunDirForCamera() : getMoonDirForCamera();
  // Use a near-geocentric viewpoint so eclipse alignments are judged by orbital geometry,
  // not by an arbitrary surface location's parallax.
  const camPos = targetDir.clone().multiplyScalar(SCENE.EARTH_RADIUS * 0.02);
  const lookAt = targetDir.clone().multiplyScalar(SCENE.EARTH_SUN_DIST);
  animateCamera(camPos, lookAt);
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
// Top-level mode switching (Simulator <-> Explore)
// ================================================================
const simulatorUI = document.getElementById('simulator-ui')!;
const exploreUI = document.getElementById('explore-ui')!;
const modeTransition = document.getElementById('mode-transition')!;
const transitionMsg = document.getElementById('transition-msg')!;
const btnModeSimulator = document.getElementById('btn-mode-simulator')!;
const btnModeExplore = document.getElementById('btn-mode-explore')!;

// Simulator scene objects (hidden during explore)
const simObjects: THREE.Object3D[] = [];

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

async function switchAppMode(newMode: AppMode) {
  btnModeSimulator.classList.toggle('active', newMode === 'simulator');
  btnModeExplore.classList.toggle('active', newMode === 'explore');

  if (newMode === appMode) {
    if (newMode === 'simulator') {
      simulatorUI.style.display = 'block';
      exploreUI.style.display = 'none';
      simControls.enabled = true;
      ambientLight.visible = true;
      for (const obj of simObjects) obj.visible = true;
      orbitDetailsOverlay.group.visible = orbitDetailsToggle.checked;
      simStarfield.visible = true;
      const toggle = document.getElementById('btn-toggle-panel');
      if (toggle) toggle.style.display = '';
      camera = simCamera;
      applyRenderResolution('simulator');
      rebuildComposer(simCamera);
    }
    return;
  }
  if (modeSwitchInFlight) return;
  modeSwitchInFlight = true;
  debugLog('Switching app mode', { from: appMode, to: newMode });

  try {
    // Fade to black
    modeTransition.classList.add('active');
    transitionMsg.textContent = newMode === 'explore' ? 'Entering Planets...' : 'Returning to Moon...';
    await sleep(400);

    if (newMode === 'explore') {
      // --- Switch to Explore ---
      appMode = 'explore';

      // Hide simulator objects
      for (const obj of simObjects) obj.visible = false;
      simStarfield.visible = false;
      simulatorUI.style.display = 'none';
      simControls.enabled = false;
      ambientLight.visible = false;
      // Hide mobile panel toggle
      const toggle = document.getElementById('btn-toggle-panel');
      if (toggle) toggle.style.display = 'none';

      // Ensure black background for space
      scene.background = new THREE.Color(0x000000);

      // Switch camera
      camera = exploreCamera;
      applyRenderResolution('explore');
      rebuildComposer(exploreCamera);

      // Initialize explore mode
      if (!exploreMode) {
        debugLog('Creating explore mode');
        exploreMode = new ExploreMode(scene, exploreCamera, renderer, useBloom);
      }
      debugLog('Activating explore mode');
      if (!exploreMode.hasLoadedSolarSystem()) {
        const totalUnits = isLoadingScreenVisible()
          ? INITIAL_PLANETS_BOOT_TOTAL_UNITS
          : FIRST_EXPLORE_ACTIVATION_TOTAL_UNITS;
        const baseOffset = totalUnits === INITIAL_PLANETS_BOOT_TOTAL_UNITS
          ? BASE_PLANETS_BOOT_TEXTURE_UNITS
          : 0;
        setPlanetsLoadingPercent(baseOffset, totalUnits);
        await exploreMode.activate((progress) => {
          setPlanetsLoadingPercent(baseOffset + progress.completedUnits, totalUnits);
        });
      } else {
        await exploreMode.activate();
      }
      debugLog('Explore mode active');

    } else {
      // --- Switch to Simulator ---
      appMode = 'simulator';

      scene.background = new THREE.Color(0x000000);

      // Deactivate explore
      if (exploreMode) {
        exploreMode.deactivate();
      }

      // Show simulator objects
      for (const obj of simObjects) obj.visible = true;
      orbitDetailsOverlay.group.visible = orbitDetailsToggle.checked;
      simStarfield.visible = true;
      simulatorUI.style.display = 'block';
      simControls.enabled = true;
      ambientLight.visible = true;
      // Restore mobile panel toggle
      const toggle = document.getElementById('btn-toggle-panel');
      if (toggle) toggle.style.display = '';

      // Switch camera
      camera = simCamera;
      applyRenderResolution('simulator');
      rebuildComposer(simCamera);
      debugLog('Simulator mode active');
    }

    // Fade back in
    await sleep(100);
    modeTransition.classList.remove('active');
  } finally {
    modeSwitchInFlight = false;
  }
}

btnModeSimulator.addEventListener('click', () => switchAppMode('simulator'));
btnModeExplore.addEventListener('click', () => switchAppMode('explore'));

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
  return auto === 'explore' || auto === 'simulator' ? auto : null;
}

// ================================================================
// Main init
// ================================================================
async function init() {
  (window as any).__initStarted = true;
  debugLog('Init started');
  const autoMode = getAutoMode();
  const initialMode = autoMode ?? 'explore';
  const showInitialPlanetsBootProgress = initialMode === 'explore';

  const textures = await loadAllTextures((loaded, total) => {
    if (showInitialPlanetsBootProgress) {
      setPlanetsLoadingPercent(Math.min(loaded, BASE_PLANETS_BOOT_TEXTURE_UNITS), INITIAL_PLANETS_BOOT_TOTAL_UNITS);
      return;
    }
    const pct = Math.round((loaded / total) * 100);
    const loadEl = document.getElementById('loading-msg');
    if (loadEl) loadEl.textContent = `Loading textures... ${pct}%`;
  });
  if (showInitialPlanetsBootProgress) {
    setPlanetsLoadingPercent(BASE_PLANETS_BOOT_TEXTURE_UNITS, INITIAL_PLANETS_BOOT_TOTAL_UNITS);
  }
  debugLog('Base textures loaded', Object.keys(textures));

  const earth = new Earth(textures);
  scene.add(earth.group);
  simObjects.push(earth.group);

  const moon = new Moon(textures);
  simMoonRef = moon;
  scene.add(moon.orbitGroup);
  simObjects.push(moon.orbitGroup);

  scene.add(orbitDetailsOverlay.group);
  simObjects.push(orbitDetailsOverlay.group);

  const sun = new Sun(useBloom);
  simSunRef = sun;
  scene.add(sun.group);
  simObjects.push(sun.group);

  // Track orbit line and grid as sim objects
  simObjects.push(moonOrbitLine, eclipticGrid);

  // Shadow cones
  const earthShadowCone = createShadowCone(SCENE.EARTH_RADIUS, 0x331111);
  scene.add(earthShadowCone);
  simObjects.push(earthShadowCone);

  const moonShadowCone = createShadowCone(SCENE.MOON_RADIUS * 0.8, 0x111133);
  scene.add(moonShadowCone);
  simObjects.push(moonShadowCone);

  moonBodyScaleSlider.min = String(PROPORTIONAL_BODY_SCALE);
  moonBodyScaleSlider.max = String(MAX_MOON_BODY_SCALE);
  moonBodyScaleSlider.step = '0.1';
  moonBodyScaleSlider.value = String(PROPORTIONAL_BODY_SCALE);
  updateMoonBodyScaleLabel(PROPORTIONAL_BODY_SCALE);
  applyMoonBodyScale(earth, moon, sun, earthShadowCone, moonShadowCone, PROPORTIONAL_BODY_SCALE);
  moonBodyScaleSlider.addEventListener('input', () => {
    const scale = parseFloat(moonBodyScaleSlider.value);
    updateMoonBodyScaleLabel(scale);
    applyMoonBodyScale(earth, moon, sun, earthShadowCone, moonShadowCone, scale);
  });

  // Initial state
  applyDateToState(new Date());
  sun.setPosition(state.sunAngle);
  moon.setOrbitalPosition(state.moonAngle, state.nodeAngle);
  debugLog('Simulator scene ready');

  // Animation loop
  let lastTime = performance.now();

  function animate() {
    requestAnimationFrame(animate);
    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.1); // cap at 100ms to avoid huge jumps
    lastTime = now;

    if (appMode === 'simulator') {
      // --- Simulator update ---
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

      sun.setPosition(state.sunAngle);
      sun.update(dt);
      moon.setOrbitalPosition(state.moonAngle, state.nodeAngle);
      const phase = computePhaseInfo(state.moonAngle, state.sunAngle, state.nodeAngle);
      moon.setEclipseAppearance(phase.eclipseType, phase.eclipseQuality);
      const sunDir = sun.getDirection();
      earth.update(dt, sunDir);
      orientOrbitPlane(moonOrbitLine, SCENE.MOON_INCLINATION, state.nodeAngle * DEG2RAD);
      orbitDetailsOverlay.update(state.nodeAngle, state.moonMeanAnomaly);
      updateShadowCones(earthShadowCone, moonShadowCone, sun, moon);
      simControls.update();

    } else if (appMode === 'explore' && exploreMode) {
      // --- Explore update ---
      exploreMode.update(dt);
    }

    updateOrbitFocusLabels(camera);
    renderScene(camera);
  }

  animate();
  debugLog('Animation loop started');

  debugLog('Initial mode selected', { initialMode });
  if (autoMode) {
    debugLog('Auto mode requested', { autoMode });
    if (autoMode === 'explore') {
      await switchAppMode('explore');
    } else {
      await switchAppMode('simulator');
    }
  } else {
    // Default to Planets mode
    await switchAppMode('explore');
  }

  document.getElementById('loading-screen')?.classList.add('hidden');
}

// ================================================================
// Shadow cone visualization
// ================================================================
function createShadowCone(baseRadius: number, color: number): THREE.Mesh {
  const length = SCENE.EARTH_MOON_DIST * 1.5;
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
  simCamera.aspect = w / h;
  simCamera.updateProjectionMatrix();
  exploreCamera.aspect = w / h;
  exploreCamera.updateProjectionMatrix();
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
