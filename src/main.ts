import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { SCENE, DEG2RAD, RAD2DEG, REAL } from './utils/constants';
import { loadAllTextures } from './utils/textures';
import { computeOrbitalState } from './utils/ephemeris';
import { Earth } from './bodies/Earth';
import { Moon } from './bodies/Moon';
import { Sun } from './bodies/Sun';

// ================================================================
// State
// ================================================================
const state = {
  moonAngle: 180,      // degrees (ecliptic longitude)
  sunAngle: 0,         // degrees (ecliptic longitude)
  nodeAngle: 0,        // ascending node
  timeSpeed: 0,        // 0=paused, 1=normal, >1=fast, <0=reverse
  animating: false,
  mode: 'manual' as 'manual' | 'date',
  currentDate: new Date(),
  dateTimeSpeed: 0,    // days per second in date mode
};

// ================================================================
// Scene setup
// ================================================================
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x020208);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 500);
camera.position.set(15, 12, 25);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.minDistance = 1.5;
controls.maxDistance = 200;
controls.target.set(0, 0, 0);

// Ambient light (very dim — space)
scene.add(new THREE.AmbientLight(0x111122, 0.15));

// ================================================================
// Post-processing
// ================================================================
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  1.2,   // strength
  0.4,   // radius
  0.85,  // threshold
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

// ================================================================
// Starfield
// ================================================================
function createStarfield(): THREE.Points {
  const starCount = 8000;
  const positions = new Float32Array(starCount * 3);
  const colors = new Float32Array(starCount * 3);
  const sizes = new Float32Array(starCount);

  for (let i = 0; i < starCount; i++) {
    // Distribute on a large sphere
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = 200 + Math.random() * 50;

    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);

    // Slight color variation
    const temp = 0.8 + Math.random() * 0.4;
    colors[i * 3] = temp;
    colors[i * 3 + 1] = temp * (0.9 + Math.random() * 0.1);
    colors[i * 3 + 2] = temp * (0.8 + Math.random() * 0.2);

    sizes[i] = 0.3 + Math.random() * 1.2;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

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

scene.add(createStarfield());

// ================================================================
// Orbit visualization
// ================================================================
function createOrbitLine(radius: number, segments: number, color: number, inclination: number, nodeAngle: number): THREE.Line {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    points.push(new THREE.Vector3(
      radius * Math.cos(angle),
      0,
      radius * Math.sin(angle),
    ));
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

// Ecliptic plane grid (subtle)
const eclipticGrid = new THREE.GridHelper(80, 40, 0x111133, 0x0a0a22);
eclipticGrid.position.y = 0;
scene.add(eclipticGrid);

// ================================================================
// Eclipse / Phase detection
// ================================================================
interface PhaseInfo {
  name: string;
  illumination: number;
  phaseAngle: number;
  eclipseType: 'none' | 'lunar' | 'solar';
  eclipseQuality: number; // 0-1, how close to perfect alignment
}

function computePhaseInfo(moonAngleDeg: number, sunAngleDeg: number, nodeAngleDeg: number): PhaseInfo {
  // Phase angle = angle between Sun and Moon as seen from Earth
  let phaseAngle = moonAngleDeg - sunAngleDeg;
  // Normalize to -180..180
  while (phaseAngle > 180) phaseAngle -= 360;
  while (phaseAngle < -180) phaseAngle += 360;

  const absPhase = Math.abs(phaseAngle);
  const illumination = (1 - Math.cos(absPhase * DEG2RAD)) / 2;

  // Phase name
  let name: string;
  if (absPhase < 10) name = 'New Moon';
  else if (absPhase < 80) name = phaseAngle > 0 ? 'Waxing Crescent' : 'Waning Crescent';
  else if (absPhase < 100) name = phaseAngle > 0 ? 'First Quarter' : 'Last Quarter';
  else if (absPhase < 170) name = phaseAngle > 0 ? 'Waxing Gibbous' : 'Waning Gibbous';
  else name = 'Full Moon';

  // Eclipse check: need Moon near a node
  // The Moon's orbit crosses the ecliptic at the ascending node (nodeAngleDeg) and
  // descending node (nodeAngleDeg + 180). Moon is at ecliptic plane when its
  // orbital angle (relative to node) is near 0 or 180.
  let moonRelNode = moonAngleDeg - nodeAngleDeg;
  while (moonRelNode > 180) moonRelNode -= 360;
  while (moonRelNode < -180) moonRelNode += 360;

  const distFromNode = Math.min(Math.abs(moonRelNode), Math.abs(Math.abs(moonRelNode) - 180));
  const nodeProximity = Math.max(0, 1 - distFromNode / 18); // within ~18 deg of node

  let eclipseType: 'none' | 'lunar' | 'solar' = 'none';
  let eclipseQuality = 0;

  if (nodeProximity > 0) {
    if (absPhase > 170) {
      // Near full moon + near node = lunar eclipse
      eclipseType = 'lunar';
      eclipseQuality = nodeProximity * (absPhase - 170) / 10;
    } else if (absPhase < 10) {
      // Near new moon + near node = solar eclipse
      eclipseType = 'solar';
      eclipseQuality = nodeProximity * (10 - absPhase) / 10;
    }
  }

  return { name, illumination, phaseAngle: absPhase, eclipseType, eclipseQuality: Math.min(1, eclipseQuality) };
}

// ================================================================
// UI bindings
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

  // Node distance
  let moonRelNode = state.moonAngle - state.nodeAngle;
  while (moonRelNode > 180) moonRelNode -= 360;
  while (moonRelNode < -180) moonRelNode += 360;
  const distFromNode = Math.min(Math.abs(moonRelNode), Math.abs(Math.abs(moonRelNode) - 180));
  infoNodeDist.innerHTML = `${distFromNode.toFixed(1)}&deg; from node`;

  // Eclipse alert
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

moonSlider.addEventListener('input', () => {
  state.moonAngle = parseFloat(moonSlider.value);
  updateUIFromState();
});

sunSlider.addEventListener('input', () => {
  state.sunAngle = parseFloat(sunSlider.value);
  updateUIFromState();
});

nodeSlider.addEventListener('input', () => {
  state.nodeAngle = parseFloat(nodeSlider.value);
  updateUIFromState();
});

// Time controls
document.getElementById('btn-pause')!.addEventListener('click', () => {
  state.timeSpeed = 0;
  state.animating = false;
  speedDisplay.textContent = 'Paused';
});

document.getElementById('btn-play')!.addEventListener('click', () => {
  state.timeSpeed = 1;
  state.animating = true;
  speedDisplay.textContent = '1x';
});

document.getElementById('btn-fast')!.addEventListener('click', () => {
  state.timeSpeed = Math.min(state.timeSpeed * 2 || 2, 32);
  state.animating = true;
  speedDisplay.textContent = `${state.timeSpeed}x`;
});

document.getElementById('btn-reverse')!.addEventListener('click', () => {
  if (state.timeSpeed > 0) {
    state.timeSpeed = -1;
  } else {
    state.timeSpeed = Math.max(state.timeSpeed * 2 || -1, -32);
  }
  state.animating = true;
  speedDisplay.textContent = `${state.timeSpeed}x`;
});

// Presets
document.getElementById('preset-full-moon')!.addEventListener('click', () => {
  state.moonAngle = state.sunAngle + 180;
  if (state.moonAngle >= 360) state.moonAngle -= 360;
  state.timeSpeed = 0;
  state.animating = false;
  speedDisplay.textContent = 'Paused';
  updateUIFromState();
});

document.getElementById('preset-new-moon')!.addEventListener('click', () => {
  state.moonAngle = state.sunAngle;
  state.timeSpeed = 0;
  state.animating = false;
  speedDisplay.textContent = 'Paused';
  updateUIFromState();
});

document.getElementById('preset-lunar-eclipse')!.addEventListener('click', () => {
  // Full moon (opposite sun) + moon at node
  state.nodeAngle = state.sunAngle; // node aligned with sun direction
  state.moonAngle = state.sunAngle + 180;
  if (state.moonAngle >= 360) state.moonAngle -= 360;
  state.timeSpeed = 0;
  state.animating = false;
  speedDisplay.textContent = 'Paused';
  updateUIFromState();
});

document.getElementById('preset-solar-eclipse')!.addEventListener('click', () => {
  // New moon + moon at node
  state.nodeAngle = state.sunAngle;
  state.moonAngle = state.sunAngle;
  state.timeSpeed = 0;
  state.animating = false;
  speedDisplay.textContent = 'Paused';
  updateUIFromState();
});

// Camera views
document.getElementById('view-default')!.addEventListener('click', () => {
  animateCamera(new THREE.Vector3(15, 12, 25), new THREE.Vector3(0, 0, 0));
});

document.getElementById('view-top')!.addEventListener('click', () => {
  animateCamera(new THREE.Vector3(0, 40, 0), new THREE.Vector3(0, 0, 0));
});

document.getElementById('view-earth')!.addEventListener('click', () => {
  animateCamera(new THREE.Vector3(0, 0.5, 3), new THREE.Vector3(0, 0, 0));
});

document.getElementById('view-side')!.addEventListener('click', () => {
  animateCamera(new THREE.Vector3(35, 0, 0), new THREE.Vector3(0, 0, 0));
});

function animateCamera(targetPos: THREE.Vector3, targetLook: THREE.Vector3) {
  const startPos = camera.position.clone();
  const startTarget = controls.target.clone();
  const duration = 1000;
  const startTime = performance.now();

  function step() {
    const elapsed = performance.now() - startTime;
    const t = Math.min(elapsed / duration, 1);
    const ease = t * t * (3 - 2 * t); // smoothstep

    camera.position.lerpVectors(startPos, targetPos, ease);
    controls.target.lerpVectors(startTarget, targetLook, ease);
    controls.update();

    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ================================================================
// Mode toggle (Manual vs Real Date)
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

  // Update date picker display
  const localISO = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString().slice(0, 16);
  datePicker.value = localISO;

  const dateStr = date.toUTCString().replace('GMT', 'UTC');
  dateInfo.textContent = dateStr;

  updateUIFromState();
}

modeManualBtn.addEventListener('click', () => setMode('manual'));
modeDateBtn.addEventListener('click', () => {
  state.currentDate = new Date();
  setMode('date');
});

datePicker.addEventListener('input', () => {
  if (datePicker.value) {
    const date = new Date(datePicker.value + 'Z'); // treat as UTC
    applyDateToState(date);
  }
});

document.getElementById('btn-now')!.addEventListener('click', () => {
  applyDateToState(new Date());
});

// Date mode time controls
document.getElementById('btn-date-pause')!.addEventListener('click', () => {
  state.dateTimeSpeed = 0;
  dateSpeedDisplay.textContent = 'Paused';
});

document.getElementById('btn-date-play')!.addEventListener('click', () => {
  state.dateTimeSpeed = 1;
  dateSpeedDisplay.textContent = '1 day/s';
});

document.getElementById('btn-date-fast')!.addEventListener('click', () => {
  state.dateTimeSpeed = Math.min((state.dateTimeSpeed || 1) * 2, 365);
  dateSpeedDisplay.textContent = `${state.dateTimeSpeed} day/s`;
});

document.getElementById('btn-date-reverse')!.addEventListener('click', () => {
  if (state.dateTimeSpeed > 0) {
    state.dateTimeSpeed = -1;
  } else {
    state.dateTimeSpeed = Math.max((state.dateTimeSpeed || -1) * 2, -365);
  }
  dateSpeedDisplay.textContent = `${state.dateTimeSpeed} day/s`;
});

// ================================================================
// Main init
// ================================================================
async function init() {
  const textures = await loadAllTextures((loaded, total) => {
    const pct = Math.round((loaded / total) * 100);
    const loadEl = document.querySelector('#loading-screen p');
    if (loadEl) loadEl.textContent = `Loading textures... ${pct}%`;
  });

  const earth = new Earth(textures);
  scene.add(earth.group);

  const moon = new Moon(textures);
  scene.add(moon.orbitGroup);

  const sun = new Sun();
  scene.add(sun.group);

  // Shadow cones for eclipses
  const earthShadowCone = createShadowCone(SCENE.EARTH_RADIUS, 0x331111);
  scene.add(earthShadowCone);

  const moonShadowCone = createShadowCone(SCENE.MOON_RADIUS * 0.8, 0x111133);
  scene.add(moonShadowCone);

  // Initial state
  sun.setPosition(state.sunAngle);
  moon.setOrbitalPosition(state.moonAngle, state.nodeAngle);
  updateUIFromState();

  // Hide loading
  setTimeout(() => {
    document.getElementById('loading-screen')!.classList.add('hidden');
  }, 500);

  // Animation loop
  const clock = new THREE.Clock();

  function animate() {
    requestAnimationFrame(animate);
    const dt = clock.getDelta();

    // Time-based animation
    if (state.mode === 'manual' && state.animating && state.timeSpeed !== 0) {
      // Moon moves ~12.2 deg/day; at speed 1, simulate 1 day per second
      state.moonAngle += state.timeSpeed * 12.2 * dt;
      // Sun moves ~1 deg/day
      state.sunAngle += state.timeSpeed * 0.986 * dt;
      // Node precesses ~0.053 deg/day (retrograde)
      state.nodeAngle -= state.timeSpeed * 0.053 * dt;

      // Normalize
      state.moonAngle = ((state.moonAngle % 360) + 360) % 360;
      state.sunAngle = ((state.sunAngle % 360) + 360) % 360;
      state.nodeAngle = ((state.nodeAngle % 360) + 360) % 360;

      updateUIFromState();
    } else if (state.mode === 'date' && state.dateTimeSpeed !== 0) {
      // Advance date by dateTimeSpeed days per real second
      const msPerDay = 86_400_000;
      state.currentDate = new Date(state.currentDate.getTime() + state.dateTimeSpeed * msPerDay * dt);
      applyDateToState(state.currentDate);
    }

    // Update bodies
    sun.setPosition(state.sunAngle);
    sun.update(dt);

    moon.setOrbitalPosition(state.moonAngle, state.nodeAngle);

    const sunDir = sun.getDirection();
    earth.update(dt, sunDir);

    // Update orbit line rotation to match node
    moonOrbitLine.rotation.y = (state.nodeAngle * DEG2RAD);
    moonOrbitLine.rotation.x = SCENE.MOON_INCLINATION;

    // Shadow cones
    updateShadowCones(earthShadowCone, moonShadowCone, sun, moon);

    controls.update();
    composer.render();
  }

  animate();
}

// ================================================================
// Shadow cone visualization
// ================================================================
function createShadowCone(baseRadius: number, color: number): THREE.Mesh {
  const length = SCENE.EARTH_MOON_DIST * 1.5;
  // Cone tip at origin, extending along +Z
  const geo = new THREE.ConeGeometry(baseRadius, length, 32, 1, true);
  // Move so tip is at y=0, base extends along +Y
  geo.translate(0, length / 2, 0);
  // Rotate so cone extends along +Z instead of +Y
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.1,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  return new THREE.Mesh(geo, mat);
}

const _antiSun = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);

function orientConeAlongDir(cone: THREE.Mesh, origin: THREE.Vector3, direction: THREE.Vector3) {
  cone.position.copy(origin);
  // Align cone's local +Z with direction
  _quat.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction.clone().normalize());
  cone.quaternion.copy(_quat);
}

function updateShadowCones(earthCone: THREE.Mesh, moonCone: THREE.Mesh, sun: Sun, moon: Moon) {
  const sunDir = sun.getDirection();
  _antiSun.copy(sunDir).negate();

  // Earth's shadow: extends away from sun, starting at Earth (origin)
  orientConeAlongDir(earthCone, new THREE.Vector3(0, 0, 0), _antiSun);
  earthCone.visible = true;

  // Moon's shadow: only visible near new moon
  const phase = computePhaseInfo(state.moonAngle, state.sunAngle, state.nodeAngle);
  const moonPos = moon.getWorldPosition();
  if (phase.phaseAngle < 20) {
    orientConeAlongDir(moonCone, moonPos, _antiSun);
    moonCone.visible = true;
  } else {
    moonCone.visible = false;
  }
}

// ================================================================
// Resize handler
// ================================================================
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

// ================================================================
// Start
// ================================================================
init().catch(console.error);
