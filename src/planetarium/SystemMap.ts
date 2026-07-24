/**
 * Whole-solar-system orrery view ("System map").
 *
 * The map reuses the live scene's real assets wherever it can: the same
 * textured planet meshes (repositioned + rescaled, then restored on exit), the
 * real player ship model, the same perspective camera + OrbitControls +
 * composer/lens/bloom, and the real orbit-line geometry as its source data.
 * Only the furniture that needs a different scale — compressed orbit lines and
 * the map Sun — is built here and parented to `root`.
 *
 * Planets sit at their TRUE positions from the live simulation: the map reads
 * the exact heliocentric coordinates regular mode uses and preserves each
 * body's orbital angle/phase exactly. The one thing it changes is radial
 * DISTANCE — a linear scale that fits Pluto's 39 AU orbit would crush the whole
 * inner system into an unreadable dot, so (following standard NASA/orrery
 * practice) distance is compressed LOGARITHMICALLY with an asinh curve
 * (logarithmic far out, gracefully linear near the Sun). Eccentricity and
 * inclination survive; only how far out a body is drawn changes. Body radii use
 * a separate perceptual (cube-root) scale so size ordering survives without
 * Jupiter swallowing its neighbours. Rotation is not faked here — the live
 * orientation update spins every planet naturally as the clock advances.
 */
import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { SolarSystemObjects } from './SolarSystem';
import { PLANETARIUM_BODIES, SUN_DATA } from './planets/planetData';
import { SHIP_REFERENCE_RADIUS_AU } from './cruiseView';
import { computeMoonOffsetEquatorialAU, getMoonDisplayOrbit } from '../astronomy/satellites';
import type { MoonMesh } from './PlanetFactory';
import type { MoonPainter } from './world/MoonPainter';
import { projectToScreen, type ScreenProjection } from '../shared/three/projectToScreen';

/** The live moon systems the map borrows and arranges around each planet. */
export interface SystemMapMoonSystems {
  groups: Map<string, THREE.Group>;
  moons: Map<string, MoonMesh[]>;
  painter: MoonPainter;
}

const EARTH_RADIUS_AU = PLANETARIUM_BODIES.find((b) => b.name === 'Earth')?.radiusAU ?? 4.2634e-5;

// --- Distance compression (asinh: logarithmic far out, linear near the Sun) ---
// s sets where the curve bends from linear to logarithmic; C is fixed so a
// reference 40 AU orbit (just past Pluto) lands at OUTER_SCENE_RADIUS scene
// units. Everything inside spreads out from there.
const COMPRESS_S = 0.6;
const OUTER_SCENE_RADIUS = 11;
const COMPRESS_C = OUTER_SCENE_RADIUS / Math.asinh(40 / COMPRESS_S);

// --- Perceptual body sizing (scene units) ---
// Bold, poster-style planets: big and dominant beside their orbits, with the
// gas giants clearly largest. The exponent (>1/3) keeps Jupiter/Saturn much
// bigger than Earth without letting the real ~11x radius ratio run away.
const BODY_BASE_RADIUS = 0.2;    // Earth's rendered radius
const BODY_SIZE_EXPONENT = 0.42; // size compression: 0 = uniform, 1 = true-scale
const MIN_BODY_RADIUS = 0.11;    // Pluto/Mercury floor
const MAX_BODY_RADIUS = 0.58;    // Jupiter cap
const SUN_MAP_RADIUS = 0.55;

// Ship model: measured at its true size on enter, then scaled to this length.
const SHIP_MAP_LENGTH = 0.32;

// Hover-label pickup radius in CSS pixels.
const LABEL_HIT_RADIUS_PX = 42;

// Eyes-style focus: click a body to fly to it, then the camera follows it.
const FOCUS_DISTANCE_RADII = 6;   // framing distance in the body's map-radii
const FOCUS_TRANSITION_S = 0.9;   // camera fly-to duration
const CLICK_MOVE_TOLERANCE_PX = 6; // beyond this a pointer gesture is a drag, not a click

// Cyan accent for the ship beacon + moon-label default. A UI-marker colour, not
// a catalog body tint, so the "tints come from catalog color" rule doesn't apply
// (as with the Sun); kept here as the single source instead of scattered hex.
const UI_MARKER_CSS = '#8fe3ff';
const UI_MARKER_HEX = 0x8fe3ff;

export type SystemMapPosition = { x: number; y: number; z: number };

/**
 * Compressed heliocentric radius, in scene units, for a real distance in AU.
 * Monotonic and smooth through 0, so the Sun's neighbourhood and a ship parked
 * inside Mercury's orbit both get real separation instead of collapsing.
 */
export function systemMapOrbitRadius(distanceAU: number): number {
  return COMPRESS_C * Math.asinh(Math.max(distanceAU, 0) / COMPRESS_S);
}

/**
 * Perceptual rendered radius (scene units) for a body of the given true radius.
 * A cube-root law keeps the real small-to-large ordering while bounding every
 * planet into a legible range beside its vastly larger orbit.
 */
export function systemMapBodyRadius(radiusAU: number): number {
  const perceptual = BODY_BASE_RADIUS * Math.pow(Math.max(radiusAU, 0) / EARTH_RADIUS_AU, BODY_SIZE_EXPONENT);
  return THREE.MathUtils.clamp(perceptual, MIN_BODY_RADIUS, MAX_BODY_RADIUS);
}

/** Scene extent the default frame must contain: the outer system plus the ship. */
export function systemMapFrameExtent(shipDistanceAU: number): number {
  return Math.max(OUTER_SCENE_RADIUS + 0.6, systemMapOrbitRadius(shipDistanceAU) + 0.6);
}

// --- Physical-data label formatting ---
const SUN_MASS_EARTHS = 332_946;

/** Consistent 3 significant figures across every field (thousands grouped). */
function sig3(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return '0';
  if (Math.abs(value) >= 1000) return Math.round(Number(value.toPrecision(3))).toLocaleString('en-US');
  return value.toPrecision(3);
}

const fmtAu = (au: number): string => `${sig3(au)} AU`;
const fmtEarthRadii = (radiusAU: number): string => `${sig3(radiusAU / EARTH_RADIUS_AU)} R⊕`;
const fmtEarthMass = (massEarths: number): string => `${sig3(massEarths)} M⊕`;
// ⊕ suffix marks these as EARTH years / days (consistent with R⊕ / M⊕).
const fmtYears = (years: number): string => `${sig3(years)} yr⊕`;
const fmtDays = (days: number): string => `${sig3(days)} d⊕`;

// Dominant atmospheric composition (terse) — every planet, plus only the moons
// with a genuine atmosphere (Titan/Triton/Io); moons absent here show no row, so
// the tiny airless satellites aren't padded with a repetitive "None". No such
// field exists in the body catalogs, so this small table is hand-curated.
const BODY_ATMOSPHERE: Record<string, string> = {
  Mercury: 'None',
  Venus: 'CO₂ (thick)',
  Earth: 'N₂ / O₂',
  Mars: 'CO₂ (thin)',
  Jupiter: 'H₂ / He',
  Saturn: 'H₂ / He',
  Uranus: 'H₂ / He / CH₄',
  Neptune: 'H₂ / He / CH₄',
  Pluto: 'N₂ (thin)',
  Titan: 'N₂ (thick)',
  Triton: 'N₂ (thin)',
  Io: 'SO₂ (thin)',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * A tiny glyph showing a planet's axial tilt visually instead of a number: a
 * dashed orbital-plane baseline, the planet disc, and its spin axis tilted by
 * `deg` from vertical (with a dot at the north pole so a near-upright axis reads
 * differently from a flipped/retrograde one — Earth 23° vs Venus 177°). The
 * exact angle rides along as a hover tooltip. Axis colour follows the body tint.
 */
function tiltGlyph(deg: number): SVGElement {
  const W = 32, H = 18, cx = 16, cy = 9, L = 6.5;
  const rad = (deg * Math.PI) / 180;
  const nx = cx + L * Math.sin(rad), ny = cy - L * Math.cos(rad); // north pole
  const sx = cx - L * Math.sin(rad), sy = cy + L * Math.cos(rad); // south pole
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(H));
  svg.setAttribute('class', 'sm-map-tilt');
  const line = (x1: number, y1: number, x2: number, y2: number, cls: string): SVGElement => {
    const el = document.createElementNS(SVG_NS, 'line');
    el.setAttribute('x1', x1.toFixed(1)); el.setAttribute('y1', y1.toFixed(1));
    el.setAttribute('x2', x2.toFixed(1)); el.setAttribute('y2', y2.toFixed(1));
    el.setAttribute('class', cls);
    return el;
  };
  const circle = (x: number, y: number, r: number, cls: string): SVGElement => {
    const el = document.createElementNS(SVG_NS, 'circle');
    el.setAttribute('cx', x.toFixed(1)); el.setAttribute('cy', y.toFixed(1));
    el.setAttribute('r', String(r)); el.setAttribute('class', cls);
    return el;
  };
  const title = document.createElementNS(SVG_NS, 'title');
  title.textContent = `${sig3(deg)}° axial tilt`;
  svg.append(
    title,
    line(3, cy, W - 3, cy, 'sm-map-tilt-base'),
    circle(cx, cy, 2.2, 'sm-map-tilt-body'),
    line(sx, sy, nx, ny, 'sm-map-tilt-axis'),
    circle(nx, ny, 1.5, 'sm-map-tilt-pole'),
  );
  return svg;
}

// --- Moons (level-of-detail: revealed when zoomed close to a planet) ---
// Show a planet's moons once the camera is within this many of the planet's map
// radii — i.e. once the planet is a big enough disc on screen to sit moons beside.
const MOON_LOD_RADII = 11;
// Rebuild moon orbit rings after this much sim-time drift so precession can't
// walk moons off their rings (~1.6° of the fastest node precession).
const MOON_ORBIT_REBUILD_MS = 30 * 86_400_000;

export function systemMapMoonsVisible(cameraDistance: number, parentMapRadius: number): boolean {
  return cameraDistance < parentMapRadius * MOON_LOD_RADII;
}

/**
 * A moon's scene distance from its parent. Real moon orbits span ~1.3 to ~70
 * parent-radii, which at map scale would fling the far ones off screen — so the
 * range is compressed logarithmically into a tidy ring just outside the planet.
 */
export function systemMapMoonOrbitRadius(distanceInParentRadii: number, parentMapRadius: number): number {
  const f = Math.log1p(Math.max(distanceInParentRadii, 0)) / Math.log1p(80);
  return parentMapRadius * (1.7 + 4.2 * THREE.MathUtils.clamp(f, 0, 1));
}

// Ganymede (~2634 km), the largest moon, sets the top of the size scale.
const LARGEST_MOON_RADIUS_AU = 1.761e-5;

/**
 * A moon's rendered radius (scene units), scaled by the SQRT of its true radius
 * against the largest moon — so Ganymede/Titan clearly dominate while Mimas or
 * Phobos stay small but visible dots. Scales with the parent's map size so a
 * planet's moons keep proportion to it.
 */
export function systemMapMoonBodyRadius(moonRadiusAU: number, parentMapRadius: number): number {
  const rel = Math.sqrt(Math.max(moonRadiusAU, 0) / LARGEST_MOON_RADIUS_AU);
  return THREE.MathUtils.clamp(parentMapRadius * 0.34 * rel, parentMapRadius * 0.03, parentMapRadius * 0.36);
}

/**
 * Scale a moon's planetocentric AU offset IN PLACE to its compressed map offset
 * (local to the parent). Single source for placing the moon mesh and for the
 * camera that follows it, so they can't diverge. Returns the real distance in
 * AU, or 0 if the offset is degenerate (leaving `off` untouched).
 */
function compressMoonOffset(off: THREE.Vector3, parentRadiusAU: number, parentMapRadius: number): number {
  const realDist = off.length();
  if (realDist < 1e-12) return 0;
  off.multiplyScalar(systemMapMoonOrbitRadius(realDist / parentRadiusAU, parentMapRadius) / realDist);
  return realDist;
}

/** Compress a real heliocentric AU vector: keep direction, compress radius. */
function compressPosition(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  const r = Math.hypot(x, y, z);
  if (r < 1e-9) return out.set(0, 0, 0);
  const k = systemMapOrbitRadius(r) / r;
  return out.set(x * k, y * k, z * k);
}

interface CameraSnapshot {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  up: THREE.Vector3;
  near: number;
  far: number;
}

interface ControlsSnapshot {
  target: THREE.Vector3;
  enabled: boolean;
  minDistance: number;
  maxDistance: number;
  enablePan: boolean;
}

interface TransformSnapshot {
  object: THREE.Object3D;
  visible: boolean;
  scale: THREE.Vector3;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

export class SystemMap {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;

  private readonly root = new THREE.Group();
  private readonly sunDisc: THREE.Sprite;
  private readonly sunGlow: THREE.Sprite;
  private readonly sunLight = new THREE.PointLight(0xfff1d2, 3.4, 0, 0);
  private readonly shipDot: THREE.Sprite;
  private readonly shipPing: THREE.Sprite;
  private readonly orbitLines = new THREE.Group();
  private readonly moonOrbits = new THREE.Group();
  private readonly moonOrbitCache = new Map<string, THREE.Group>();

  private readonly labels = new Map<string, HTMLElement>();
  private readonly labelWorld = new Map<string, THREE.Vector3>();
  private moonLabel: HTMLElement | null = null;
  private pickerBuilt = false;
  private hoveredMoonName: string | null = null; // caches the moon whose label text is set
  // Moons currently drawn (rebuilt each frame by updateMoons), used for hover.
  private readonly moonHoverTargets: Array<{ name: string; parent: string; color: number; radiusAU: number; orbitalRadiusKm: number; x: number; y: number; z: number }> = [];
  private moonSystems: SystemMapMoonSystems | null = null;
  private readonly projScratch: ScreenProjection = { x: 0, y: 0, ndcX: 0, ndcY: 0, ndcZ: 0 };
  private readonly vecScratch = new THREE.Vector3();

  private readonly cameraSnapshot: CameraSnapshot;
  private readonly controlsSnapshot: ControlsSnapshot;
  private planetSnapshots: TransformSnapshot[] = [];
  private shipSnapshot: TransformSnapshot | null = null;
  private hiddenObjects: THREE.Object3D[] = [];

  private objects: SolarSystemObjects | null = null;
  // Epoch the compressed orbit-line copies were sampled at; when the live source
  // lines resample (date jump / fast warp) this goes stale and they're rebuilt.
  private orbitLinesEpochMs = 0;
  private shipGroup: THREE.Object3D | null = null;
  private shipScale = 1;
  private active = false;
  private frameExtent = OUTER_SCENE_RADIUS + 0.6;
  private lastDateText = '';

  private pointerX = -1;
  private pointerY = -1;
  private pointerInside = false;
  private pointerIsDown = false;
  private pointerDragged = false;
  private pointerDownX = 0;
  private pointerDownY = 0;

  // Focus/follow state (Eyes-style): the body the camera is locked onto, an
  // in-flight camera transition, and the body's last position (follow delta).
  // When focusMoonParent is set, focusName is a moon (position is computed).
  private focusName: string | null = null;
  private focusMoonParent: string | null = null;
  private currentUtcMs = 0;
  private readonly followPos = new THREE.Vector3();
  private transition: {
    fromPos: THREE.Vector3; toPos: THREE.Vector3;
    fromTarget: THREE.Vector3; toTarget: THREE.Vector3;
    t: number;
  } | null = null;
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpMoon = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    renderer: THREE.WebGLRenderer,
    controls: OrbitControls,
  ) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.controls = controls;
    this.root.name = 'System map furniture';
    this.root.visible = false;

    // Map Sun: a self-lit sphere plus a soft additive glow (a star genuinely
    // glows). Deliberately NOT the live Sun mesh — its corona shader is tuned to
    // real scale and the driving exposure, and blowing it up here would
    // bloom-flood the frame.
    // Map Sun: a limb-darkened billboard disc (bright white core → warm limb,
    // so bloom lifts it into a glowing star) plus a soft additive corona. A
    // billboard reads as a star from any camera angle where a lit sphere would
    // look flat.
    this.sunDisc = makeSunDiscSprite();
    this.sunDisc.name = 'System map Sun';
    this.sunDisc.scale.setScalar(SUN_MAP_RADIUS * 2);
    this.sunDisc.renderOrder = 11;
    this.root.add(this.sunDisc);
    this.sunGlow = makeGlowSprite(0xffcf87);
    this.sunGlow.scale.setScalar(SUN_MAP_RADIUS * 3.4);
    this.root.add(this.sunGlow);

    // A low ambient floor keeps textured night sides legible at map scale; the
    // point light at the Sun still supplies the true day/night phase.
    this.root.add(new THREE.AmbientLight(0x9fb0cc, 0.5));
    this.sunLight.position.set(0, 0, 0);
    this.root.add(this.sunLight);

    this.orbitLines.name = 'System map orbits';
    this.moonOrbits.name = 'System map moon orbits';
    this.root.add(this.orbitLines, this.moonOrbits);

    // "You are here" indicator: a crisp dot at the exact ship position plus a
    // pulsing radar-ping ring that draws the eye. Both drawn on top (depthTest
    // off) so they stay readable over the Sun and findable at overview zoom. A
    // persistent HTML callout (renderLabels) names it.
    this.shipDot = makeDotSprite(UI_MARKER_CSS);
    this.shipDot.material.depthTest = false;
    this.shipDot.renderOrder = 32;
    this.root.add(this.shipDot);
    this.shipPing = makeRingSprite(UI_MARKER_CSS);
    this.shipPing.material.depthTest = false;
    this.shipPing.renderOrder = 31;
    this.root.add(this.shipPing);

    this.scene.add(this.root);

    this.cameraSnapshot = {
      position: new THREE.Vector3(), quaternion: new THREE.Quaternion(),
      up: new THREE.Vector3(), near: camera.near, far: camera.far,
    };
    this.controlsSnapshot = {
      target: new THREE.Vector3(), enabled: controls.enabled,
      minDistance: controls.minDistance, maxDistance: controls.maxDistance,
      enablePan: controls.enablePan,
    };

    document.getElementById('system-map-reset')?.addEventListener('click', () => this.resetView());
    document.getElementById('system-map-focus')?.addEventListener('click', () => this.resetView());
    document.getElementById('system-map-jump-ship')?.addEventListener('click', () => this.focusOn('Ship'));
    document.getElementById('system-map-bodies')?.addEventListener('click', () => this.togglePicker());
    this.buildLabels();
  }

  isActive(): boolean {
    return this.active;
  }

  /** DEV: snap-focus a body (no fly-to). Returns false if unknown/inactive. */
  focusBody(name: string): boolean {
    if (!this.active || !this.labelWorld.has(name)) return false;
    this.focusOn(name, false);
    return true;
  }

  /** World position (scene space) of the current focus target — a body from
   *  labelWorld, or a moon computed from its parent + compressed offset. */
  private focusWorldPos(out: THREE.Vector3): boolean {
    if (!this.focusName) return false;
    if (this.focusMoonParent) return this.moonMapPosition(this.focusName, this.focusMoonParent, out);
    const world = this.labelWorld.get(this.focusName);
    if (!world) return false;
    out.copy(world);
    return true;
  }

  /** A moon's current scene position (parent's compressed pos + compressed offset). */
  private moonMapPosition(moonName: string, parentName: string, out: THREE.Vector3): boolean {
    const planet = this.objects?.planets.find((p) => p.data.name === parentName);
    if (!planet) return false;
    const off = computeMoonOffsetEquatorialAU(moonName, parentName, this.currentUtcMs, this.tmpMoon);
    if (compressMoonOffset(off, planet.data.radiusAU, systemMapBodyRadius(planet.data.radiusAU)) === 0) return false;
    out.copy(planet.group.position).add(off);
    return true;
  }

  /** Focus a moon: fly to it (near its parent, so the system is in LOD range)
   *  and follow it. Falls back to the parent if the moon can't be located. */
  private focusMoonTarget(moonName: string, parentName: string, animate = true): void {
    this.focusName = moonName;
    this.focusMoonParent = parentName;
    if (!this.moonMapPosition(moonName, parentName, this.tmpA)) {
      this.focusMoonParent = null;
      this.focusOn(parentName, animate);
      return;
    }
    const planet = this.objects?.planets.find((p) => p.data.name === parentName);
    const parentMapRadius = planet ? systemMapBodyRadius(planet.data.radiusAU) : 0.2;
    const moon = this.moonSystems?.moons.get(parentName)?.find((m) => m.data.name === moonName);
    const moonRadius = moon ? systemMapMoonBodyRadius(moon.data.radiusAU, parentMapRadius) : parentMapRadius * 0.1;
    const dist = Math.max(moonRadius * 10, parentMapRadius * 2.2);
    const toPos = this.tmpB.copy(this.tmpA).add(this.vecScratch.set(dist * 0.15, dist * 0.55, dist * 0.82));
    this.controls.enablePan = false;
    this.controls.minDistance = Math.max(moonRadius * 1.3, 0.05);
    // Cap zoom-out so the moon can't be pulled past its own LOD range (which
    // hides the mesh) while the camera is still locked onto and following it.
    this.controls.maxDistance = parentMapRadius * MOON_LOD_RADII * 0.85;
    if (animate) {
      this.startTransition(this.tmpA, toPos);
    } else {
      this.camera.position.copy(toPos);
      this.controls.target.copy(this.tmpA);
      this.followPos.copy(this.tmpA);
      this.camera.lookAt(this.tmpA);
      this.controls.update();
    }
    this.updateFocusUI();
  }

  /** Focus a body: lock the camera onto it and (unless snapping) fly there. */
  private focusOn(name: string, animate = true): void {
    const target = this.labelWorld.get(name);
    if (!target) return;
    this.focusName = name;
    this.focusMoonParent = null;
    const radius = this.bodyMapRadius(name);
    const dist = Math.max(radius * FOCUS_DISTANCE_RADII, 0.5);
    const toPos = this.tmpA.copy(target).add(this.tmpB.set(dist * 0.15, dist * 0.55, dist * 0.82));
    this.controls.enablePan = false; // orbit/zoom the body, not the empty frame
    this.controls.minDistance = Math.max(radius * 1.25, 0.1);
    this.controls.maxDistance = this.frameExtent * 3.4;
    if (animate) {
      this.startTransition(target, toPos);
    } else {
      this.camera.position.copy(toPos);
      this.controls.target.copy(target);
      this.followPos.copy(target);
      this.camera.lookAt(target);
      this.controls.update();
    }
    this.updateFocusUI();
  }

  /** Deselect and fly back to the whole-system birds-eye view. */
  resetView(): void {
    if (!this.active) return;
    this.focusName = null;
    this.focusMoonParent = null;
    this.controls.enablePan = true;
    this.controls.minDistance = this.frameExtent * 0.06;
    this.controls.maxDistance = this.overviewPose(this.tmpA);
    const target = this.tmpB.set(0, 0, 0);
    this.startTransition(target, this.tmpA);
    this.updateFocusUI();
  }

  private startTransition(toTarget: THREE.Vector3, toPos: THREE.Vector3): void {
    // Flush residual OrbitControls damping (inertia from a just-released drag)
    // so the fly-to starts from a settled pose instead of curving off with the
    // leftover momentum. No-op when there's no residual.
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = true;
    this.transition = {
      fromPos: this.camera.position.clone(),
      toPos: toPos.clone(),
      fromTarget: this.controls.target.clone(),
      toTarget: toTarget.clone(),
      t: 0,
    };
    this.controls.enabled = false;
  }

  private bodyMapRadius(name: string): number {
    if (name === 'Sun') return SUN_MAP_RADIUS;
    if (name === 'Ship') return SHIP_MAP_LENGTH * 0.6;
    const planet = this.objects?.planets.find((p) => p.data.name === name);
    return planet ? systemMapBodyRadius(planet.data.radiusAU) : 0.2;
  }

  private updateFocusUI(): void {
    const back = document.getElementById('system-map-focus');
    if (back) back.style.display = this.focusName ? 'inline-flex' : 'none';
    const title = document.getElementById('system-map-title');
    if (title) title.textContent = this.focusName === 'Ship' ? 'Your ship' : (this.focusName ?? 'Solar System');
  }

  enter(
    objects: SolarSystemObjects,
    moonSystems: SystemMapMoonSystems,
    shipGroup: THREE.Object3D,
    playerPosition: SystemMapPosition,
  ): void {
    if (this.active) return;
    this.active = true;
    this.objects = objects;
    this.shipGroup = shipGroup;
    this.moonSystems = moonSystems;

    this.cameraSnapshot.position.copy(this.camera.position);
    this.cameraSnapshot.quaternion.copy(this.camera.quaternion);
    this.cameraSnapshot.up.copy(this.camera.up);
    this.cameraSnapshot.near = this.camera.near;
    this.cameraSnapshot.far = this.camera.far;
    this.controlsSnapshot.target.copy(this.controls.target);
    this.controlsSnapshot.enabled = this.controls.enabled;
    this.controlsSnapshot.minDistance = this.controls.minDistance;
    this.controlsSnapshot.maxDistance = this.controls.maxDistance;
    this.controlsSnapshot.enablePan = this.controls.enablePan;

    // Reuse the live planet meshes: snapshot their transform, then reposition
    // and rescale them onto the compressed map. Restored verbatim on exit.
    this.planetSnapshots = objects.planets.map((planet) => snapshot(planet.group));

    // Reuse the real ship model as the "you are here" marker. Measure it at its
    // true size, then scale it up to a readable length in the map.
    this.shipSnapshot = snapshot(shipGroup);
    this.shipScale = this.measureShipScale(shipGroup);
    shipGroup.visible = true;

    // Hide the live furniture the map replaces (moons reappear on zoom-in).
    this.hiddenObjects = [objects.sun, objects.asteroidBelt, ...objects.orbitLines, ...moonSystems.groups.values()];
    for (const obj of this.hiddenObjects) obj.visible = false;

    this.buildOrbitLines(objects.orbitLines);
    this.orbitLinesEpochMs = objects.orbitLinesEpochUtcMs;

    this.root.visible = true;
    document.body.classList.add('system-map-active');
    document.getElementById('system-map-ui')?.setAttribute('aria-hidden', 'false');

    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    window.addEventListener('resize', this.onResize);

    this.focusName = null;
    this.focusMoonParent = null;
    this.transition = null;
    this.buildPicker();
    this.positionShip(playerPosition);
    this.frameExtent = systemMapFrameExtent(Math.hypot(playerPosition.x, playerPosition.y, playerPosition.z));
    this.frameAll();
    this.updateFocusUI();
  }

  exit(): void {
    if (!this.active) return;
    this.active = false;
    this.root.visible = false;
    document.body.classList.remove('system-map-active');
    document.getElementById('system-map-ui')?.setAttribute('aria-hidden', 'true');

    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointerleave', this.onPointerLeave);
    window.removeEventListener('resize', this.onResize);
    this.pointerInside = false;
    this.pointerIsDown = false;
    this.focusName = null;
    this.focusMoonParent = null;
    this.transition = null;
    this.togglePicker(false);
    this.updateFocusUI();

    for (const snap of this.planetSnapshots) restore(snap);
    if (this.shipSnapshot) restore(this.shipSnapshot);
    for (const obj of this.hiddenObjects) obj.visible = true;
    this.planetSnapshots = [];
    this.shipSnapshot = null;
    this.hiddenObjects = [];
    this.clearOrbitLines();
    this.objects = null;
    this.shipGroup = null;

    // Flush any residual damping deltas BEFORE restoring, so the trailing
    // controls.update() can't nudge the restored pose after an exit mid-drag.
    this.controls.enableDamping = false;
    this.controls.update();
    this.camera.position.copy(this.cameraSnapshot.position);
    this.camera.quaternion.copy(this.cameraSnapshot.quaternion);
    this.camera.up.copy(this.cameraSnapshot.up);
    this.camera.near = this.cameraSnapshot.near;
    this.camera.far = this.cameraSnapshot.far;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(this.controlsSnapshot.target);
    this.controls.enabled = this.controlsSnapshot.enabled;
    this.controls.minDistance = this.controlsSnapshot.minDistance;
    this.controls.maxDistance = this.controlsSnapshot.maxDistance;
    this.controls.enablePan = this.controlsSnapshot.enablePan;
    this.controls.update();
    this.controls.enableDamping = true; // restore for the normal-mode camera
    for (const label of this.labels.values()) label.style.display = 'none';
    if (this.moonLabel) this.moonLabel.style.display = 'none';
    this.moonHoverTargets.length = 0;
    this.moonSystems = null;
    for (const rings of this.moonOrbitCache.values()) { disposeGroup(rings); this.moonOrbits.remove(rings); }
    this.moonOrbitCache.clear();
  }

  update(
    utcMs: number,
    planetPositions: ReadonlyMap<string, SystemMapPosition>,
    playerPosition: SystemMapPosition,
    dt: number,
  ): void {
    if (!this.active || !this.objects) return;
    this.currentUtcMs = utcMs;

    // The live orbit lines resample when the sim clock drifts far (date jump /
    // fast warp). Our compressed copies were taken at one epoch, so rebuild them
    // when the source epoch changes — otherwise planets drift off their rings.
    if (this.objects.orbitLinesEpochUtcMs !== this.orbitLinesEpochMs) {
      this.buildOrbitLines(this.objects.orbitLines);
      this.orbitLinesEpochMs = this.objects.orbitLinesEpochUtcMs;
    }

    for (const planet of this.objects.planets) {
      const helio = planetPositions.get(planet.data.name);
      if (!helio) continue;
      compressPosition(helio.x, helio.y, helio.z, this.vecScratch);
      planet.group.position.copy(this.vecScratch);
      // Real mesh geometry is in true AU radius; rescale it to the perceptual
      // map radius. Orientation (axial tilt + daily spin) is still driven by the
      // live update, so continents and rings turn naturally as the clock runs.
      const bodyRadius = systemMapBodyRadius(planet.data.radiusAU);
      planet.group.scale.setScalar(bodyRadius / planet.data.radiusAU);
      planet.group.visible = true;
      this.labelWorld.get(planet.data.name)?.copy(this.vecScratch);
    }

    this.positionShip(playerPosition);
    // Camera rig: fly-to transition, follow the focused body, or free orbit —
    // runs after the bodies move so a followed body stays centred. Owns the
    // per-frame controls.update().
    this.updateCameraRig(dt);
    this.updateMoons(utcMs);
    this.sizeShipMarker();

    this.camera.updateMatrixWorld();
    this.renderLabels();
    this.renderDate(utcMs);
  }

  private updateCameraRig(dt: number): void {
    if (this.transition) {
      // Re-aim the fly-to at the focus target's CURRENT position every frame,
      // preserving the framing offset. Under time warp a body moves far during
      // the 0.9 s transition (Mercury laps several times at 1 yr/s), so a fixed
      // click-time endpoint would land on empty space and snap at the end.
      if (this.focusWorldPos(this.tmpA)) {
        const off = this.tmpB.copy(this.transition.toPos).sub(this.transition.toTarget);
        this.transition.toTarget.copy(this.tmpA);
        this.transition.toPos.copy(this.tmpA).add(off);
      }
      this.transition.t = Math.min(1, this.transition.t + dt / FOCUS_TRANSITION_S);
      const k = THREE.MathUtils.smoothstep(this.transition.t, 0, 1);
      this.camera.position.lerpVectors(this.transition.fromPos, this.transition.toPos, k);
      this.controls.target.lerpVectors(this.transition.fromTarget, this.transition.toTarget, k);
      this.camera.lookAt(this.controls.target);
      if (this.transition.t >= 1) {
        // Snap onto the target's CURRENT position (it drifted during the fly-to)
        // so follow starts seamlessly.
        if (this.focusWorldPos(this.tmpA)) {
          const delta = this.tmpB.copy(this.tmpA).sub(this.controls.target);
          this.camera.position.add(delta);
          this.controls.target.copy(this.tmpA);
          this.followPos.copy(this.tmpA);
        }
        this.transition = null;
        this.controls.enabled = true;
      }
      this.controls.update();
      return;
    }

    if (this.focusName && this.focusWorldPos(this.tmpA)) {
      // Follow: translate camera + target by the target's frame-to-frame motion
      // so it stays centred while the user still orbits/zooms it.
      const delta = this.tmpB.copy(this.tmpA).sub(this.followPos);
      this.camera.position.add(delta);
      this.controls.target.add(delta);
      this.followPos.copy(this.tmpA);
    }
    this.controls.update();
  }

  /**
   * Level-of-detail moons: reveal a planet's moons once the camera is zoomed
   * close (systemMapMoonsVisible), arranged in a compressed ring around its map
   * position. Reuses the real painted meshes (honours the never-show-unpainted
   * gate), feeds the surface shader the sun direction (map Sun at the origin) so
   * they light instead of washing flat, and records each for hover pickup.
   */
  private updateMoons(utcMs: number): void {
    this.moonHoverTargets.length = 0;
    for (const rings of this.moonOrbitCache.values()) rings.visible = false;
    const sys = this.moonSystems;
    if (!sys || !this.objects) return;
    for (const planet of this.objects.planets) {
      const group = sys.groups.get(planet.data.name);
      const moons = sys.moons.get(planet.data.name);
      if (!group) continue;
      const parentMapRadius = systemMapBodyRadius(planet.data.radiusAU);
      // Always keep the focused moon's own system revealed. LOD is measured
      // from the PARENT, but a followed outer moon sits offset from it, so the
      // camera can clear the parent's LOD range while still framing the moon —
      // which would hide the very body being followed.
      const isFocusedSystem = this.focusMoonParent === planet.data.name;
      if (!moons || moons.length === 0
        || (!isFocusedSystem
          && !systemMapMoonsVisible(this.camera.position.distanceTo(planet.group.position), parentMapRadius))) {
        group.visible = false;
        continue;
      }
      if (sys.painter.hasPending(planet.data.name)) sys.painter.paintSystemNow(planet.data.name, moons);
      group.position.copy(planet.group.position);
      group.quaternion.identity();
      group.scale.setScalar(1);
      group.visible = true;

      // Moon orbit rings: cached and just repositioned each frame. Once the
      // clock has drifted enough that orbital-plane precession would walk moons
      // off their rings (fast time warp), refill the ring buffers IN PLACE — no
      // geometry alloc/dispose churn.
      let rings = this.moonOrbitCache.get(planet.data.name);
      if (!rings) {
        rings = buildMoonOrbits(planet.data.name, planet.data.radiusAU, moons, parentMapRadius, utcMs);
        rings.userData.epochMs = utcMs;
        this.moonOrbitCache.set(planet.data.name, rings);
        this.moonOrbits.add(rings);
      } else if (Math.abs(utcMs - (rings.userData.epochMs as number)) > MOON_ORBIT_REBUILD_MS) {
        refillMoonOrbits(rings, planet.data.name, planet.data.radiusAU, parentMapRadius, utcMs);
        rings.userData.epochMs = utcMs;
      }
      rings.position.copy(planet.group.position);
      rings.visible = true;
      for (const m of moons) {
        const off = computeMoonOffsetEquatorialAU(m.data.name, planet.data.name, utcMs, this.tmpMoon, moonNormalScratch);
        if (compressMoonOffset(off, planet.data.radiusAU, parentMapRadius) === 0) { m.mesh.visible = false; continue; }
        m.mesh.position.copy(off);
        m.mesh.scale.setScalar(systemMapMoonBodyRadius(m.data.radiusAU, parentMapRadius) / m.data.radiusAU);
        // Tidally lock the moon so it keeps the same face toward its parent, same
        // as the normal renderer. Compression preserves the offset direction, so
        // the shown face is correct; re-running each frame turns it as it orbits
        // (otherwise the mesh keeps its stale orientation and never rotates).
        orientMoonTidally(m.mesh, off, moonNormalScratch);
        m.mesh.visible = true;
        const wx = group.position.x + m.mesh.position.x;
        const wy = group.position.y + m.mesh.position.y;
        const wz = group.position.z + m.mesh.position.z;
        if (m.fx) {
          const wl = Math.hypot(wx, wy, wz) || 1;
          m.fx.uSunDirWorld.value.set(-wx / wl, -wy / wl, -wz / wl);
          m.fx.uPlanetshineIntensity.value = 0;
        }
        this.moonHoverTargets.push({ name: m.data.name, parent: planet.data.name, color: m.data.color, radiusAU: m.data.radiusAU, orbitalRadiusKm: m.data.orbitalRadiusKm, x: wx, y: wy, z: wz });
      }
    }
  }

  /** Keep the ship dot + ping a roughly constant on-screen size (crisp, never
   *  magnifying their texture) that also frames the ship when zoomed in close. */
  private sizeShipMarker(): void {
    // When the ship IS the focused body you're looking right at it — the beacon
    // would only sit on top of the model, so hide it.
    const onShip = this.focusName === 'Ship';
    this.shipDot.visible = !onShip;
    this.shipPing.visible = !onShip;
    const world = this.labelWorld.get('Ship');
    if (!world || onShip) return;
    const dist = Math.max(this.camera.position.distanceTo(world), 1e-5);
    const focal = this.renderer.domElement.clientHeight / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    const perPx = dist / Math.max(focal, 1);
    const t = (performance.now() % 1600) / 1600;
    this.shipDot.scale.setScalar(11 * perPx);
    this.shipPing.scale.setScalar(THREE.MathUtils.clamp((SHIP_MAP_LENGTH / dist) * focal * 1.45 + 22, 50, 360) * (1 + 0.28 * t) * perPx);
    this.shipPing.material.opacity = 0.7 * (1 - t);
  }

  /**
   * Aspect-aware whole-system overview pose. The vertical FOV is fixed, so a tall
   * portrait/mobile viewport fits far less HORIZONTAL extent — a fixed camera
   * distance then clips the outer planets off the sides. Pull the camera back by
   * 1/aspect on portrait (keeping the three-quarter view angle) so the full disc
   * always fits. Writes the camera position into `out`; returns the matching
   * controls.maxDistance (raised the same way so this pose isn't clamped).
   */
  private overviewPose(out: THREE.Vector3): number {
    const el = this.renderer.domElement;
    const aspect = el.clientWidth / Math.max(el.clientHeight, 1);
    const pull = aspect < 1 ? 1 / aspect : 1;
    const e = this.frameExtent;
    // A low three-quarter view (~22° above the orbital plane): strong perspective
    // so the orbits recede as a 3D disc and near planets read larger than far.
    out.set(e * 0.05 * pull, e * 0.62 * pull, e * 1.55 * pull);
    return e * 3.4 * pull;
  }

  private frameAll(): void {
    if (!this.active) return;
    const extent = this.frameExtent;
    this.camera.near = 0.02;
    this.camera.far = extent * 20;
    this.camera.updateProjectionMatrix();
    this.camera.up.set(0, 1, 0);
    this.controls.maxDistance = this.overviewPose(this.tmpA);
    this.camera.position.copy(this.tmpA);
    this.controls.target.set(0, 0, 0);
    this.controls.enabled = true;
    this.controls.minDistance = extent * 0.06;
    // Pan enabled so the user can move a planet to centre and zoom into it to
    // reveal its moons; min distance lowered so you can get right up to one.
    this.controls.enablePan = true;
    this.camera.lookAt(this.controls.target);
    this.controls.update();
  }

  /** Build compressed orbit rings from the live orbit-line vertices. */
  private buildOrbitLines(sourceLines: THREE.Line[]): void {
    this.clearOrbitLines();
    const v = new THREE.Vector3();
    for (let i = 0; i < sourceLines.length; i++) {
      const src = sourceLines[i].geometry.getAttribute('position');
      if (!src) continue;
      const pts = new Float32Array(src.count * 3);
      for (let j = 0; j < src.count; j++) {
        compressPosition(src.getX(j), src.getY(j), src.getZ(j), v);
        pts[j * 3] = v.x; pts[j * 3 + 1] = v.y; pts[j * 3 + 2] = v.z;
      }
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      const line = new THREE.Line(geom, new THREE.LineBasicMaterial({
        color: PLANETARIUM_BODIES[i]?.color ?? 0x8899bb,
        transparent: true,
        opacity: 0.6,
        depthWrite: false,
      }));
      this.orbitLines.add(line);
    }
  }

  private clearOrbitLines(): void {
    disposeGroup(this.orbitLines);
  }

  /** Scale factor that renders the ship model at SHIP_MAP_LENGTH scene units. */
  private measureShipScale(shipGroup: THREE.Object3D): number {
    const prev = shipGroup.scale.clone();
    shipGroup.scale.setScalar(1);
    shipGroup.updateMatrixWorld(true);
    const size = new THREE.Box3().setFromObject(shipGroup).getSize(new THREE.Vector3());
    shipGroup.scale.copy(prev);
    const maxDim = Math.max(size.x, size.y, size.z) || SHIP_REFERENCE_RADIUS_AU * 4;
    return SHIP_MAP_LENGTH / maxDim;
  }

  private positionShip(position: SystemMapPosition): void {
    compressPosition(position.x, position.y, position.z, this.vecScratch);
    if (this.shipGroup) {
      this.shipGroup.position.copy(this.vecScratch);
      this.shipGroup.scale.setScalar(this.shipScale);
    }
    this.shipDot.position.copy(this.vecScratch);
    this.shipPing.position.copy(this.vecScratch);
    this.labelWorld.get('Ship')?.copy(this.vecScratch);
  }

  private buildLabels(): void {
    const container = document.getElementById('system-map-labels');
    if (!container) return;
    const add = (name: string, color: number, desc: string, rows: Array<[string, string | Node]>): void => {
      const label = this.makeLabelEl(name, color);
      (label.querySelector('.sm-map-desc') as HTMLElement).textContent = desc;
      this.setLabelRows(label, rows);
      container.appendChild(label);
      this.labels.set(name, label);
      this.labelWorld.set(name, new THREE.Vector3());
    };
    add('Sun', SUN_DATA.color, 'Our star, a yellow dwarf', [
      ['Radius', fmtEarthRadii(SUN_DATA.radiusAU)],
      ['Mass', fmtEarthMass(SUN_MASS_EARTHS)],
    ]);
    for (const b of PLANETARIUM_BODIES) {
      add(b.name, b.color, b.description, [
        ['Distance to Sun', fmtAu(b.semiMajorAxisAU)],
        ['Radius', fmtEarthRadii(b.radiusAU)],
        ['Mass', fmtEarthMass(b.surfaceGravityG * (b.radiusAU / EARTH_RADIUS_AU) ** 2)],
        ['Gravity', `${sig3(b.surfaceGravityG)} g`],        // g = Earth surface gravity
        ['Tilt', tiltGlyph(b.axialTiltDeg)],            // spin axis drawn at the real tilt
        ['Atmosphere', BODY_ATMOSPHERE[b.name] ?? 'None'],
        ['Year', fmtYears(b.semiMajorAxisAU ** 1.5)],       // Kepler orbital period
        ['Day', fmtDays(Math.abs(b.rotationPeriodHours) / 24)], // rotation period
        ['Moons', String(b.moons)],
      ]);
    }
    this.labelWorld.get('Sun')?.set(0, 0, 0);
    // The ship has no label (its beacon marks it); it stays hoverable/clickable.
    this.labelWorld.set('Ship', new THREE.Vector3());

    // One reused label for whichever moon is hovered (only one shows at a time).
    this.moonLabel = this.makeLabelEl('', UI_MARKER_HEX);
    container.appendChild(this.moonLabel);
  }

  /** A label chip: body name, a one-line description, then a key/value list. */
  private makeLabelEl(name: string, color: number): HTMLElement {
    const label = document.createElement('div');
    label.className = 'sm-map-label';
    label.style.setProperty('--body-color', `#${color.toString(16).padStart(6, '0')}`);
    const title = document.createElement('strong');
    title.textContent = name;
    const desc = document.createElement('div');
    desc.className = 'sm-map-desc';
    const rows = document.createElement('div');
    rows.className = 'sm-map-rows';
    label.append(title, desc, rows);
    return label;
  }

  /** Replace a label's fact rows with `[key, value]` pairs. A value may be a Node
   *  (e.g. the tilt glyph) instead of text. */
  private setLabelRows(label: HTMLElement, rows: Array<[string, string | Node]>): void {
    const list = label.querySelector('.sm-map-rows') as HTMLElement;
    list.replaceChildren();
    for (const [k, v] of rows) {
      const row = document.createElement('div');
      row.className = 'sm-map-row';
      const key = document.createElement('span');
      key.className = 'sm-map-k';
      key.textContent = k;
      const val = document.createElement('span');
      val.className = 'sm-map-v';
      if (typeof v === 'string') val.textContent = v;
      else val.appendChild(v);
      row.append(key, val);
      list.appendChild(row);
    }
  }

  /** Populate the body picker: Sun, then each planet with its moons indented. */
  private buildPicker(): void {
    // The Sun/planet/moon set is catalog-static — build the rows once and reuse
    // them across map entries rather than recreating ~70 buttons + listeners.
    if (this.pickerBuilt) return;
    const panel = document.getElementById('system-map-picker');
    if (!panel) return;
    panel.replaceChildren();
    this.pickerBuilt = true;
    const row = (name: string, cls: string, onPick: () => void): void => {
      const b = document.createElement('button');
      b.className = `smp-row ${cls}`;
      b.textContent = name;
      b.addEventListener('click', () => { onPick(); this.togglePicker(false); });
      panel.appendChild(b);
    };
    row('Sun', 'smp-sun', () => this.focusOn('Sun'));
    for (const body of PLANETARIUM_BODIES) {
      row(body.name, 'smp-planet', () => this.focusOn(body.name));
      for (const m of this.moonSystems?.moons.get(body.name) ?? []) {
        row(m.data.name, 'smp-moon', () => this.focusMoonTarget(m.data.name, body.name));
      }
    }
  }

  private togglePicker(force?: boolean): void {
    const panel = document.getElementById('system-map-picker');
    if (!panel) return;
    const open = force ?? panel.style.display === 'none';
    panel.style.display = open ? 'flex' : 'none';
  }

  /**
   * All labels are hover-only — the frame stays clean, and the body (planet,
   * Sun, ship, or moon) nearest the pointer within a pickup radius names itself.
   * The ship's location is always marked by its pulsing beacon; only the text
   * callout waits for hover. On touch this reveals labels during a drag.
   */
  private renderLabels(): void {
    const width = this.renderer.domElement.clientWidth;
    const height = this.renderer.domElement.clientHeight;
    for (const label of this.labels.values()) label.style.display = 'none';
    if (this.moonLabel) this.moonLabel.style.display = 'none';
    if (!this.pointerInside) { this.hoveredMoonName = null; return; }

    let bestName: string | null = null;
    let bestX = 0;
    let bestY = 0;
    let bestMoon: { color: number; radiusAU: number; orbitalRadiusKm: number; name: string; parent: string } | null = null;
    let bestDist = LABEL_HIT_RADIUS_PX;
    for (const [name, world] of this.labelWorld) {
      if (name === 'Ship') continue; // beacon-marked, no text label
      projectToScreen(world, this.camera, width, height, this.projScratch);
      const p = this.projScratch;
      if (!(p.ndcZ > -1 && p.ndcZ < 1 && Math.abs(p.ndcX) < 1 && Math.abs(p.ndcY) < 1)) continue;
      const d = Math.hypot(p.x - this.pointerX, p.y - this.pointerY);
      if (d < bestDist) { bestDist = d; bestName = name; bestX = p.x; bestY = p.y; bestMoon = null; }
    }
    for (const t of this.moonHoverTargets) {
      projectToScreen(this.vecScratch.set(t.x, t.y, t.z), this.camera, width, height, this.projScratch);
      const p = this.projScratch;
      if (!(p.ndcZ > -1 && p.ndcZ < 1 && Math.abs(p.ndcX) < 1 && Math.abs(p.ndcY) < 1)) continue;
      const d = Math.hypot(p.x - this.pointerX, p.y - this.pointerY);
      if (d < bestDist) { bestDist = d; bestName = t.name; bestX = p.x; bestY = p.y; bestMoon = t; }
    }
    if (!bestName) { this.hoveredMoonName = null; return; }

    const label = bestMoon ? this.moonLabel : this.labels.get(bestName);
    if (!label) return;
    if (!bestMoon) {
      this.hoveredMoonName = null;
    } else if (bestName !== this.hoveredMoonName) {
      // Only rebuild the label text when the hovered moon changes (not every
      // frame the pointer rests on it); getMoonDisplayOrbit isn't cheap.
      this.hoveredMoonName = bestName;
      label.style.setProperty('--body-color', `#${bestMoon.color.toString(16).padStart(6, '0')}`);
      label.querySelector('strong')!.textContent = bestName;
      (label.querySelector('.sm-map-desc') as HTMLElement).textContent = `${bestMoon.parent}'s moon`;
      // Orbital period around the parent (moons are tidally locked, so day = orbit).
      const period = getMoonDisplayOrbit(bestMoon.name, bestMoon.parent).periodDays;
      const rows: Array<[string, string]> = [
        ['Distance to planet', `${sig3(bestMoon.orbitalRadiusKm)} km`],
        ['Radius', fmtEarthRadii(bestMoon.radiusAU)],
        ['Orbit', fmtDays(period)],
      ];
      // Only the handful of moons with a real atmosphere get the row.
      const atmo = BODY_ATMOSPHERE[bestMoon.name];
      if (atmo) rows.push(['Atmosphere', atmo]);
      this.setLabelRows(label, rows);
    }
    const x = THREE.MathUtils.clamp(bestX + 14, 6, Math.max(6, width - 120));
    const y = THREE.MathUtils.clamp(bestY - 10, 58, Math.max(58, height - 34));
    label.style.display = 'flex';
    label.style.left = `${Math.round(x)}px`;
    label.style.top = `${Math.round(y)}px`;
  }

  private renderDate(utcMs: number): void {
    const text = new Intl.DateTimeFormat('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
    }).format(new Date(utcMs));
    if (text === this.lastDateText) return;
    this.lastDateText = text;
    const dateEl = document.getElementById('system-map-date');
    if (dateEl) dateEl.textContent = `${text} UTC`;
  }

  // Re-fit the birds-eye view when the viewport changes (device rotation, window
  // resize). Aspect-aware framing is otherwise applied only on entry/reset, so a
  // resize would leave the old distance and clip outer bodies. Only the overview
  // re-fits; a focused body keeps its follow framing.
  private readonly onResize = (): void => {
    if (!this.active || this.focusName || this.transition) return;
    this.frameAll();
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerDownX = e.clientX - rect.left;
    this.pointerDownY = e.clientY - rect.top;
    this.pointerIsDown = true;
    this.pointerDragged = false;
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerX = e.clientX - rect.left;
    this.pointerY = e.clientY - rect.top;
    this.pointerInside = true;
    if (this.pointerIsDown && Math.hypot(this.pointerX - this.pointerDownX, this.pointerY - this.pointerDownY) > CLICK_MOVE_TOLERANCE_PX) {
      this.pointerDragged = true;
    }
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    const wasDown = this.pointerIsDown;
    this.pointerIsDown = false;
    if (!wasDown || this.pointerDragged) return; // a drag rotated/zoomed — not a click
    const rect = this.renderer.domElement.getBoundingClientRect();
    const hit = this.pickBodyAt(e.clientX - rect.left, e.clientY - rect.top);
    if (!hit) return; // click empty space: keep the current view
    if (hit.parent) this.focusMoonTarget(hit.name, hit.parent);
    else this.focusOn(hit.name);
  };

  private readonly onPointerLeave = (): void => {
    this.pointerInside = false;
  };

  /** Nearest focusable body to a screen point, within its apparent disc + slop.
   *  Considers the Sun/planets/ship AND any LOD-revealed moons, so clicking a
   *  visible moon focuses it (returning its parent) rather than the planet. */
  private pickBodyAt(px: number, py: number): { name: string; parent: string | null } | null {
    const width = this.renderer.domElement.clientWidth;
    const height = this.renderer.domElement.clientHeight;
    const focal = height / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    let best: { name: string; parent: string | null } | null = null;
    let bestDist = Infinity;
    for (const [name, world] of this.labelWorld) {
      projectToScreen(world, this.camera, width, height, this.projScratch);
      const p = this.projScratch;
      if (!(p.ndcZ > -1 && p.ndcZ < 1 && Math.abs(p.ndcX) < 1 && Math.abs(p.ndcY) < 1)) continue;
      const camDist = this.camera.position.distanceTo(world);
      const apparentR = camDist > 1e-6 ? (this.bodyMapRadius(name) / camDist) * focal : 0;
      const hit = Math.max(24, apparentR + 14);
      const d = Math.hypot(p.x - px, p.y - py);
      if (d < hit && d < bestDist) { bestDist = d; best = { name, parent: null }; }
    }
    for (const t of this.moonHoverTargets) {
      projectToScreen(this.vecScratch.set(t.x, t.y, t.z), this.camera, width, height, this.projScratch);
      const p = this.projScratch;
      if (!(p.ndcZ > -1 && p.ndcZ < 1 && Math.abs(p.ndcX) < 1 && Math.abs(p.ndcY) < 1)) continue;
      const parent = this.objects?.planets.find((pl) => pl.data.name === t.parent);
      const parentMapR = parent ? systemMapBodyRadius(parent.data.radiusAU) : 0.2;
      const camDist = this.camera.position.distanceTo(this.vecScratch);
      const apparentR = camDist > 1e-6 ? (systemMapMoonBodyRadius(t.radiusAU, parentMapR) / camDist) * focal : 0;
      const hit = Math.max(20, apparentR + 12);
      const d = Math.hypot(p.x - px, p.y - py);
      if (d < hit && d < bestDist) { bestDist = d; best = { name: t.name, parent: t.parent }; }
    }
    return best;
  }
}

const moonNormalScratch = new THREE.Vector3();
const tidalToParent = new THREE.Vector3();
const tidalBasisZ = new THREE.Vector3();
const tidalUp = new THREE.Vector3();
const tidalBasis = new THREE.Matrix4();

/**
 * Orient a tidally-locked moon mesh so its near face points at the parent (at the
 * origin of the moon's offset), rolled to `rollNorth` — the map-mode twin of
 * PlanetariumMode.orientTidallyLockedMoon. Only the offset's direction matters,
 * so the compressed offset works as-is.
 */
function orientMoonTidally(mesh: THREE.Object3D, offsetFromParent: THREE.Vector3, rollNorth: THREE.Vector3): void {
  const toParent = tidalToParent.copy(offsetFromParent).multiplyScalar(-1).normalize();
  const basisZ = tidalBasisZ.crossVectors(toParent, rollNorth);
  if (basisZ.lengthSq() < 1e-10) return; // degenerate only for a zero offset/normal
  basisZ.normalize();
  const up = tidalUp.crossVectors(basisZ, toParent);
  mesh.quaternion.setFromRotationMatrix(tidalBasis.makeBasis(toParent, up, basisZ));
}

/** Dispose every Line child's geometry + material and empty the group. */
function disposeGroup(group: THREE.Group): void {
  for (const child of group.children) {
    const line = child as THREE.Line;
    line.geometry.dispose();
    (line.material as THREE.Material).dispose();
  }
  group.clear();
}

const MOON_ORBIT_SEGMENTS = 96;
const moonOrbitScratch = new THREE.Vector3();

/**
 * Fill `out` (length (SEGMENTS+1)*3) with a moon's compressed orbit ring at the
 * given epoch: its real trajectory sampled over exactly one orbital period (the
 * authoritative `getMoonDisplayOrbit` period — an instantaneous angular-speed
 * estimate is wrong for eccentric orbits) and radially compressed exactly like
 * the moon's own placement, so the moon rides its ring. Returns false (leaving
 * `out` untouched) if the moon has no usable period.
 */
function sampleMoonOrbit(
  out: Float32Array,
  moonName: string,
  parentName: string,
  parentRadiusAU: number,
  parentMapRadius: number,
  utcMs: number,
): boolean {
  const periodMs = getMoonDisplayOrbit(moonName, parentName).periodDays * 86_400_000;
  if (!Number.isFinite(periodMs) || periodMs <= 0) return false;
  for (let i = 0; i <= MOON_ORBIT_SEGMENTS; i++) {
    computeMoonOffsetEquatorialAU(moonName, parentName, utcMs + (i / MOON_ORBIT_SEGMENTS) * periodMs, moonOrbitScratch);
    const r = moonOrbitScratch.length() || 1e-9;
    const k = systemMapMoonOrbitRadius(r / parentRadiusAU, parentMapRadius) / r;
    out[i * 3] = moonOrbitScratch.x * k;
    out[i * 3 + 1] = moonOrbitScratch.y * k;
    out[i * 3 + 2] = moonOrbitScratch.z * k;
  }
  return true;
}

/** Build one compressed orbit ring per moon (allocates the ring buffers once). */
function buildMoonOrbits(
  parentName: string,
  parentRadiusAU: number,
  moons: MoonMesh[],
  parentMapRadius: number,
  utcMs: number,
): THREE.Group {
  const group = new THREE.Group();
  for (const m of moons) {
    const positions = new Float32Array((MOON_ORBIT_SEGMENTS + 1) * 3);
    if (!sampleMoonOrbit(positions, m.data.name, parentName, parentRadiusAU, parentMapRadius, utcMs)) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({
      color: m.data.color, transparent: true, opacity: 0.22, depthWrite: false,
    }));
    line.userData.moonName = m.data.name;
    group.add(line);
  }
  return group;
}

/** Re-sample every ring's positions IN PLACE (reusing its buffer) at a new epoch. */
function refillMoonOrbits(
  group: THREE.Group,
  parentName: string,
  parentRadiusAU: number,
  parentMapRadius: number,
  utcMs: number,
): void {
  for (const child of group.children) {
    const line = child as THREE.Line;
    const attr = line.geometry.getAttribute('position') as THREE.BufferAttribute;
    if (sampleMoonOrbit(attr.array as Float32Array, line.userData.moonName as string, parentName, parentRadiusAU, parentMapRadius, utcMs)) {
      attr.needsUpdate = true;
      line.geometry.computeBoundingSphere();
    }
  }
}

function snapshot(object: THREE.Object3D): TransformSnapshot {
  return {
    object,
    visible: object.visible,
    scale: object.scale.clone(),
    position: object.position.clone(),
    quaternion: object.quaternion.clone(),
  };
}

function restore(snap: TransformSnapshot): void {
  snap.object.visible = snap.visible;
  snap.object.scale.copy(snap.scale);
  snap.object.position.copy(snap.position);
  snap.object.quaternion.copy(snap.quaternion);
}

/** Build a billboard sprite from a square canvas painted by `draw`. */
function canvasSprite(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void, additive = false): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) draw(ctx, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false });
  if (additive) material.blending = THREE.AdditiveBlending;
  return new THREE.Sprite(material);
}

const TAU = Math.PI * 2;
const circle = (ctx: CanvasRenderingContext2D, x: number, y: number, r: number) => {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
};

/** Limb-darkened star disc: bright white core fading to a warm edge. */
function makeSunDiscSprite(): THREE.Sprite {
  return canvasSprite(128, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 2, s / 2, s / 2, s / 2 - 1);
    g.addColorStop(0, '#fffefb');
    g.addColorStop(0.45, '#fff1c8');
    g.addColorStop(0.82, '#ffcb72');
    g.addColorStop(0.97, '#f6a740');
    g.addColorStop(1, 'rgba(246,167,64,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
}

/** Crisp filled dot with a dark rim for contrast against space and the Sun. */
function makeDotSprite(color: string): THREE.Sprite {
  return canvasSprite(128, (ctx, s) => {
    ctx.fillStyle = 'rgba(4,10,20,0.9)';
    circle(ctx, s / 2, s / 2, s * 0.31);
    ctx.fill();
    ctx.fillStyle = color;
    circle(ctx, s / 2, s / 2, s * 0.22);
    ctx.fill();
  });
}

/** Thin ring (radar ping) — hollow centre, so it reads as a marker not a glow. */
function makeRingSprite(color: string): THREE.Sprite {
  return canvasSprite(256, (ctx, s) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = s * 0.045;
    circle(ctx, s / 2, s / 2, s * 0.44);
    ctx.stroke();
  });
}

/** Soft radial-gradient billboard used for the Sun's glow. */
function makeGlowSprite(color: number): THREE.Sprite {
  const hex = `#${color.toString(16).padStart(6, '0')}`;
  const sprite = canvasSprite(64, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 1, s / 2, s / 2, s / 2);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.18, hex);
    g.addColorStop(0.5, hex);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  }, true);
  sprite.renderOrder = 12;
  return sprite;
}
