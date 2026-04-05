import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { SCENE, DEG2RAD, RAD2DEG, REAL } from './utils/constants';
import { loadAllTextures } from './utils/textures';
import { computeOrbitalState, findEvent, type EventType } from './utils/ephemeris';
import { Earth } from './bodies/Earth';
import { Moon } from './bodies/Moon';
import { Sun } from './bodies/Sun';
import { ExploreMode } from './explore/ExploreMode';

// ================================================================
// Top-level mode
// ================================================================
type AppMode = 'simulator' | 'explore';
let appMode: AppMode = 'simulator';
let exploreMode: ExploreMode | null = null;

// ================================================================
// Simulator State
// ================================================================
const state = {
  moonAngle: 180,
  sunAngle: 0,
  nodeAngle: 0,
  timeSpeed: 0,
  animating: false,
  mode: 'date' as 'manual' | 'date',
  currentDate: new Date(),
  dateTimeSpeed: 0,
};

// ================================================================
// Scene setup
// ================================================================
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x020208);

// --- Simulator camera + controls ---
const simCamera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 500);
simCamera.position.set(15, 12, 25);

const simControls = new OrbitControls(simCamera, renderer.domElement);
simControls.enableDamping = true;
simControls.dampingFactor = 0.05;
simControls.minDistance = 1.5;
simControls.maxDistance = 200;
simControls.target.set(0, 0, 0);

// --- Explore camera ---
const exploreCamera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.000001, 200);
exploreCamera.position.set(-0.005, 0.003, 0.003);

// Active camera reference
let camera = simCamera;

// Ambient light
const ambientLight = new THREE.AmbientLight(0x111122, 0.15);
scene.add(ambientLight);

// ================================================================
// Post-processing
// ================================================================
let composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, simCamera));

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  1.2, 0.4, 0.85,
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

function rebuildComposer(cam: THREE.Camera) {
  composer.dispose();
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, cam));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    cam === exploreCamera ? 0.8 : 1.2,
    0.4,
    cam === exploreCamera ? 0.92 : 0.85, // higher threshold in explore = only bright objects bloom
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
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
function createOrbitLine(radius: number, segments: number, color: number, inclination: number, nodeAngle: number): THREE.Line {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    points.push(new THREE.Vector3(radius * Math.cos(angle), 0, radius * Math.sin(angle)));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(points);
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.25 });
  const line = new THREE.Line(geo, mat);
  line.rotation.order = 'YXZ';
  line.rotation.x = inclination;
  line.rotation.y = nodeAngle;
  return line;
}

const moonOrbitLine = createOrbitLine(SCENE.EARTH_MOON_DIST, 128, 0x4466aa, SCENE.MOON_INCLINATION, 0);
scene.add(moonOrbitLine);

const eclipticGrid = new THREE.GridHelper(80, 40, 0x111133, 0x0a0a22);
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

  if (state.mode === 'date') {
    const orbital = computeOrbitalState(state.currentDate);
    infoDistance.textContent = `${Math.round(orbital.moonDistance).toLocaleString()} km`;
  } else {
    infoDistance.textContent = `${REAL.EARTH_MOON_DIST.toLocaleString()} km`;
  }
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
moonSlider.addEventListener('input', () => { state.moonAngle = parseFloat(moonSlider.value); updateUIFromState(); });
sunSlider.addEventListener('input', () => { state.sunAngle = parseFloat(sunSlider.value); updateUIFromState(); });
nodeSlider.addEventListener('input', () => { state.nodeAngle = parseFloat(nodeSlider.value); updateUIFromState(); });

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
  state.timeSpeed = 0; state.animating = false; speedDisplay.textContent = 'Paused';
  updateUIFromState();
});
document.getElementById('preset-new-moon')!.addEventListener('click', () => {
  state.moonAngle = state.sunAngle;
  state.timeSpeed = 0; state.animating = false; speedDisplay.textContent = 'Paused';
  updateUIFromState();
});
document.getElementById('preset-lunar-eclipse')!.addEventListener('click', () => {
  state.nodeAngle = state.sunAngle;
  state.moonAngle = state.sunAngle + 180;
  if (state.moonAngle >= 360) state.moonAngle -= 360;
  state.timeSpeed = 0; state.animating = false; speedDisplay.textContent = 'Paused';
  updateUIFromState();
});
document.getElementById('preset-solar-eclipse')!.addEventListener('click', () => {
  state.nodeAngle = state.sunAngle;
  state.moonAngle = state.sunAngle;
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

document.getElementById('view-default')!.addEventListener('click', () => animateCamera(new THREE.Vector3(15, 12, 25), new THREE.Vector3(0, 0, 0)));
document.getElementById('view-top')!.addEventListener('click', () => animateCamera(new THREE.Vector3(0, 40, 0), new THREE.Vector3(0, 0, 0)));
document.getElementById('view-earth')!.addEventListener('click', () => animateCamera(new THREE.Vector3(0, 0.5, 3), new THREE.Vector3(0, 0, 0)));
document.getElementById('view-side')!.addEventListener('click', () => animateCamera(new THREE.Vector3(35, 0, 0), new THREE.Vector3(0, 0, 0)));

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

async function switchAppMode(newMode: AppMode) {
  if (newMode === appMode) return;

  // Fade to black
  modeTransition.classList.add('active');
  transitionMsg.textContent = newMode === 'explore' ? 'Entering Solar System...' : 'Returning to Simulator...';
  await sleep(400);

  if (newMode === 'explore') {
    // --- Switch to Explore ---
    appMode = 'explore';
    btnModeSimulator.classList.remove('active');
    btnModeExplore.classList.add('active');

    // Pure black background for space
    scene.background = new THREE.Color(0x000000);

    // Hide simulator objects
    for (const obj of simObjects) obj.visible = false;
    simStarfield.visible = false;
    simulatorUI.style.display = 'none';
    simControls.enabled = false;
    ambientLight.visible = false;

    // Switch camera
    camera = exploreCamera;
    rebuildComposer(exploreCamera);

    // Initialize explore mode
    if (!exploreMode) {
      exploreMode = new ExploreMode(scene, exploreCamera, renderer);
    }
    await exploreMode.activate();

  } else {
    // --- Switch to Simulator ---
    appMode = 'simulator';
    btnModeSimulator.classList.add('active');
    btnModeExplore.classList.remove('active');

    // Restore simulator background
    scene.background = new THREE.Color(0x020208);

    // Deactivate explore
    if (exploreMode) {
      exploreMode.deactivate();
    }

    // Show simulator objects
    for (const obj of simObjects) obj.visible = true;
    simStarfield.visible = true;
    simulatorUI.style.display = 'block';
    simControls.enabled = true;
    ambientLight.visible = true;

    // Switch camera
    camera = simCamera;
    rebuildComposer(simCamera);
  }

  // Fade back in
  await sleep(100);
  modeTransition.classList.remove('active');
}

btnModeSimulator.addEventListener('click', () => switchAppMode('simulator'));
btnModeExplore.addEventListener('click', () => switchAppMode('explore'));

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ================================================================
// Main init
// ================================================================
async function init() {
  const dbg = (window as any).__dbgLog as ((msg: string) => void) | undefined;
  dbg?.('init() started');

  dbg?.('Loading textures...');
  const textures = await loadAllTextures((loaded, total) => {
    const pct = Math.round((loaded / total) * 100);
    const loadEl = document.getElementById('loading-msg');
    if (loadEl) loadEl.textContent = `Loading textures... ${pct}%`;
    dbg?.(`Texture ${loaded}/${total}`);
  });
  dbg?.('Textures loaded');

  dbg?.('Creating Earth...');
  const earth = new Earth(textures);
  scene.add(earth.group);
  simObjects.push(earth.group);

  dbg?.('Creating Moon...');
  const moon = new Moon(textures);
  scene.add(moon.orbitGroup);
  simObjects.push(moon.orbitGroup);

  dbg?.('Creating Sun...');
  const sun = new Sun();
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

  // Initial state
  applyDateToState(new Date());
  sun.setPosition(state.sunAngle);
  moon.setOrbitalPosition(state.moonAngle, state.nodeAngle);
  dbg?.('Scene ready, hiding loading screen');

  // Hide loading
  setTimeout(() => {
    document.getElementById('loading-screen')!.classList.add('hidden');
    dbg?.('Loading screen hidden');
  }, 500);

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
        state.moonAngle += state.timeSpeed * 12.2 * dt;
        state.sunAngle += state.timeSpeed * 0.986 * dt;
        state.nodeAngle -= state.timeSpeed * 0.053 * dt;
        state.moonAngle = ((state.moonAngle % 360) + 360) % 360;
        state.sunAngle = ((state.sunAngle % 360) + 360) % 360;
        state.nodeAngle = ((state.nodeAngle % 360) + 360) % 360;
        updateUIFromState();
      } else if (state.mode === 'date' && state.dateTimeSpeed !== 0) {
        const msPerDay = 86_400_000;
        state.currentDate = new Date(state.currentDate.getTime() + state.dateTimeSpeed * msPerDay * dt);
        applyDateToState(state.currentDate);
      }

      sun.setPosition(state.sunAngle);
      sun.update(dt);
      moon.setOrbitalPosition(state.moonAngle, state.nodeAngle);
      const sunDir = sun.getDirection();
      earth.update(dt, sunDir);
      moonOrbitLine.rotation.y = state.nodeAngle * DEG2RAD;
      moonOrbitLine.rotation.x = SCENE.MOON_INCLINATION;
      updateShadowCones(earthShadowCone, moonShadowCone, sun, moon);
      simControls.update();

    } else if (appMode === 'explore' && exploreMode) {
      // --- Explore update ---
      exploreMode.update(dt);
    }

    composer.render();
  }

  animate();
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
  renderer.setSize(w, h);
  composer.setSize(w, h);
});

// ================================================================
// Start
// ================================================================
// Safety: never leave loading screen stuck for more than 15s
setTimeout(() => {
  const ls = document.getElementById('loading-screen');
  if (ls && !ls.classList.contains('hidden')) {
    console.warn('Loading timeout — forcing hide');
    ls.classList.add('hidden');
  }
}, 15000);

init().catch((err) => {
  console.error('Init failed:', err);
  // Never leave user stuck on loading screen
  const loadingScreen = document.getElementById('loading-screen');
  if (loadingScreen) loadingScreen.classList.add('hidden');
  const loadingMsg = document.getElementById('loading-msg');
  if (loadingMsg) loadingMsg.textContent = 'Something went wrong. Please refresh.';
});
