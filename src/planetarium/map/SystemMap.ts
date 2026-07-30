/**
 * SystemMap — the full-screen schematic view of the solar system, a
 * session-only sub-state of PlanetariumMode. Own THREE.Scene + a plain
 * PerspectiveCamera (no userData.lens, so projectToScreen degrades to
 * rectilinear) and own OrbitControls, rendered to the backbuffer instead of
 * the composer while open.
 *
 * The map never simulates: PlanetariumMode feeds it a snapshot each frame
 * (the sim clock + the ship's heliocentric AU pose) and it recomputes every
 * body straight from the ephemeris seam (sampleTrajectoryLinePoints ->
 * computeBodyPositionAU), so the schematic cannot disagree with the world.
 * Radii compress toward the Sun (mapProjection) along a blend the scale toggle
 * animates between compressed and true; every distance the map draws is
 * derived, never stored on the save.
 *
 * Bodies draw as map-local textured globes — own meshes, own materials, own
 * light — that BORROW the world's texture objects and own none of them (see
 * mapGlobes for the two rules). A body with no texture yet falls back to the
 * schematic dot, and so does every body at true scale until the camera closes
 * on it far enough that its real disc overtakes its chart marker.
 *
 * The camera is a state machine — overview, focusFly, following, dive — and
 * exactly one of those owns the pose at a time. mapCamera holds the machine and
 * the bounds policy as plain numbers; everything here is the THREE half of it.
 */
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PLANETARIUM_BODIES, SUN_DATA, type PlanetData } from '../planets/planetData';
import { RING_CONFIGS } from '../planets/rings';
import {
  sampleTrajectoryLinePoints,
  computeBodyOrientationQuaternion,
  computeBodyPositionAU,
  trajectoryLineBodyFraction,
  ttJDFromUtcMs,
} from '../../astronomy/planetary';
import { computeMoonOffsetEquatorialAU } from '../../astronomy/satellites';
import { bodyDisplayName } from '../surfaceView';
import { ORBIT_LINE_RESAMPLE_MAX_AGE_MS } from '../SolarSystem';
import { applyTextureDefaults } from '../world/texturePolicy';
import { projectToScreen, type ScreenProjection } from '../../shared/three/projectToScreen';
import { smoothstepUnclamped } from '../../shared/math/smoothstep';
import {
  defaultMapCurve,
  diveRestoreDistanceAU,
  fitDistanceAU,
  isAtOverviewFit,
  projectMapPoint,
  sanitizeMapCurve,
  MAP_BLEND_ANIM_MS,
  MAP_BLEND_COMPRESSED,
  MAP_BLEND_TRUE,
  type MapCurve,
  type MapVec3,
} from './mapProjection';
import {
  mapBodyRadiusAU,
  mapMarkerRadiusPx,
  MAP_BODY_SIZE_DEFAULTS,
  type MapBodySizeParams,
} from './mapBodySize';
import { mapBodyDrawMode, shouldAdoptTexture } from './mapGlobes';
import {
  clampFollowDistanceAU,
  followBounds,
  mapCameraInitialState,
  mapCameraReduce,
  mapDiveEndFraction,
  mapFlightFramingDistanceAU,
  mapFocusEase,
  mapWorldPerPxAtUnitDepth,
  revealDistanceAU,
  MAP_FOCUS_FLY_MS,
  MAP_FOV_DEG,
  MAP_OVERVIEW_NEAR_FRAC,
  type MapCameraState,
  type MapFollowBounds,
} from './mapCamera';
import { flushOrbitDamping } from '../input/orbitDamping';
import {
  anchorOnScreen,
  pickRadiusFor,
  resolvePick,
  type PickAnchor,
  type PickResult,
} from './mapPicking';
import {
  mapBody,
  mapBodyAcceptsCamera,
  MAP_BODIES,
  MAP_LABEL_CAPACITY,
  MAP_PICK_ANCHOR_CAPACITY,
  type MapBodyKind,
} from './mapBodies';
import { MapLabelPlacer } from './mapLabels';
import { debugWarn } from '../../shared/debug';

/**
 * Read-only access to the world's live surface textures. The map re-reads these
 * every update and adopts by identity: the world DISPOSES the texture it
 * replaces when it hot-swaps a sharper tier in, so a reference held across that
 * swap would draw black. Never a long-lived handle, never a dispose.
 */
export interface MapTextureSource {
  /** The colour map the world's material for `bodyName` carries right now, or
   *  null while it is still loading. */
  colorMap(bodyName: string): THREE.Texture | null;
  /** Likewise for that body's ring texture, null when it has no rings. */
  ringMap(bodyName: string): THREE.Texture | null;
}

const ORBIT_SEGMENTS = 180;
const BG_COLOR = 0x05070d;
// Screen sizes (px, full sprite extent) for the constant-size markers.
const PLANET_PX = 20;
const SHIP_PX = 26;
// Orbit line: full tint just ahead of the body fading to this floor behind it.
const ORBIT_BRIGHT_FLOOR = 0.1;
// Un-docked ship chevron breathes over this period (ms).
const SHIP_PULSE_MS = 2000;
// Hover feedback: the pointed-at dot swells and lifts toward white.
const HOVER_SCALE = 1.3;
const HOVER_LIFT = 0.4;
const WHITE = new THREE.Color(1, 1, 1);
// A hovered globe lifts by its own tint instead of swelling: a growing sphere
// would move its footprint, and the footprint is the click target.
const GLOBE_HOVER_EMISSIVE = 0.22;
// The dive eases the camera in to this fraction of its start distance.
const DIVE_END_DIST_FRAC = 0.14;

// Sunlight for the globes, with physical falloff switched OFF (decay 0). The
// map's radii are compressed, so a distance-metered light would meter by a
// drawn distance rather than a real one — and would change every body's
// brightness when the scale toggle animates. One constant irradiance keeps the
// terminator the only thing the light says. Intensity is PI because the Lambert
// BRDF divides by it, so a face-on surface reflects its albedo exactly.
const SUN_LIGHT_INTENSITY = Math.PI;
const SUN_LIGHT_COLOR = 0xfff4e2;
// Night floor, in the spirit of the world's directional starlight fill: a few
// percent of the day side, cool, so the unlit hemisphere reads as unlit rather
// than as a hole — and never the flat ambient wash that would erase the
// terminator and turn every globe into a poster.
const NIGHT_FILL_COLOR = 0x2a3a54;
const NIGHT_FILL_INTENSITY = 2.2;
// Halo radius as a multiple of the Sun's drawn disc. The map renders without
// the composer, so nothing downstream will bloom the star: the falloff is baked
// into the billboard.
const SUN_HALO_RADII = 3.2;
// Limb darkening of the solar disc, the u in I/I0 = 1 - u(1 - mu).
const SUN_LIMB_DARKENING = 0.62;
// Exposure the map draws at. The world's near-Sun auto-exposure keeps adapting
// to a scene nobody is looking at while the map is open; tone-mapped globes
// would ride that adaptation and flicker. The map renders at neutral and hands
// the world's value straight back.
const MAP_EXPOSURE = 1;

interface OrbitEntry {
  planet: PlanetData;
  /** Raw heliocentric samples (scene AU), flattened xyz, length (N+1)*3. */
  raw: Float32Array;
  /** Compressed map-space positions, packed into the Line2 buffer each rebuild. */
  map: Float32Array;
  colors: Float32Array;
  geometry: LineGeometry;
  material: LineMaterial;
  line: Line2;
  dot: THREE.Sprite;
  /** Vertex index the body last sat at — colors rebuild only on a crossing. */
  lastVertex: number;
  /** Largest projected |r| over the samples at the live blend — the
   *  eccentricity-correct extent this orbit contributes (aphelion, not the
   *  semi-major axis, sets the drawn reach). Refreshed with recompressOrbits. */
  maxMapRadius: number;
  /** Catalog tint in the renderer's working (linear) colour space, so the fat
   *  line matches the sprite material.color instead of rendering hot. */
  colorR: number;
  colorG: number;
  colorB: number;
  /** Raw heliocentric AU of the body this frame (pre-compression) — the truth
   *  the card reports as a real distance from the ship, without a second
   *  ephemeris call. */
  helioX: number;
  helioY: number;
  helioZ: number;
  /** The catalog tint as a Color, so hover can brighten toward white and
   *  restore without re-parsing the hex. */
  baseColor: THREE.Color;
  /** Map-local globe. The group carries the body's IAU orientation and its
   *  drawn radius as a scale, so the mesh (a shared unit sphere) and the ring
   *  (built in planet radii) both follow one number. None of it is the world's
   *  — only the texture on the material is borrowed. */
  globe: THREE.Group;
  globeMat: THREE.MeshStandardMaterial;
  ringMat: THREE.MeshStandardMaterial | null;
  /** Outer edge of the drawn ring in globe radii, 1 where there is no ring —
   *  the body's full drawn reach, which is what a camera has to clear. */
  ringOuterFactor: number;
  /** Drawn radius in screen px this frame — the globe's footprint, which is
   *  also its click target once it outgrows the pointer floor. */
  drawnRadiusPx: number;
  /** Whether the globe, rather than the dot, is what drew this frame. */
  globeDrawn: boolean;
}

export class SystemMap {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;

  private textures: MapTextureSource;

  private sun: THREE.Sprite;
  private sunHalo: THREE.Sprite;
  private sunRadiusPx = 0;
  private sunBaseColor = new THREE.Color(SUN_DATA.color);
  private orbits: OrbitEntry[] = [];
  private shipMarker: THREE.Sprite;
  private shipChevronTex: THREE.Texture;
  private shipRingTex: THREE.Texture;
  /** One unit sphere behind every globe — each body varies only by material and
   *  by the scale on its group. */
  private globeGeo = new THREE.SphereGeometry(1, 64, 32);

  private labelContainer: HTMLElement | null = null;
  /** Labels keyed by catalog name, never by catalog index: the chart's body set
   *  is the Sun, the planets and the moons, and only a name is shared by the
   *  pick, the card, the hover emphasis and the label. */
  private labels = new Map<string, HTMLDivElement>();

  private open = false;
  // Radial curve + how far it is blended toward true scale (0 compressed,
  // 1 true). The curve is a dev-selectable A/B; the blend is the user's toggle.
  private curve: MapCurve = defaultMapCurve();
  private blend = MAP_BLEND_COMPRESSED;
  private blendFrom = MAP_BLEND_COMPRESSED;
  private blendTo = MAP_BLEND_COMPRESSED;
  private blendElapsedMs = 0;
  private blendAnimating = false;
  private bodySizeParams: MapBodySizeParams = { ...MAP_BODY_SIZE_DEFAULTS };
  private epochUtcMs = 0;
  /** The clock the current frame is drawn at. A planet's position comes from
   *  its dot, which the position pass has already placed; a moon's has to be
   *  computed from its parent, and this is the instant it is computed for. */
  private clockUtcMs = 0;
  // Clock instant the globe orientations were last built for. NaN until the
  // first pass, so the comparison that skips the rebuild can never skip it.
  private orientedUtcMs = Number.NaN;
  private sampled = false;
  private extentAU = 1;
  private needsInitialFrame = false;
  // The user's framing (camera distance / fit distance) captured when a scale
  // toggle starts, so the whole animation re-fits to the new extent and the
  // system keeps its apparent size instead of zooming as the blend slides.
  private scaleZoomRatio = 1;

  // Scratch — no per-frame allocation in steady state.
  private tmpMap: MapVec3 = { x: 0, y: 0, z: 0 };
  private tmpMap2: MapVec3 = { x: 0, y: 0, z: 0 };
  private tmpProj: ScreenProjection = { x: 0, y: 0, ndcX: 0, ndcY: 0, ndcZ: 0 };
  private tmpProj2: ScreenProjection = { x: 0, y: 0, ndcX: 0, ndcY: 0, ndcZ: 0 };
  private tmpSize = new THREE.Vector2();
  private tmpViewport = new THREE.Vector4();
  private tmpView = new THREE.Vector3();
  /** Planetocentric offset scratch — a moon's position is its parent's plus
   *  this, and the ephemeris seam fills a caller's vector. */
  private tmpMoonOffset = new THREE.Vector3();

  // Un-docked ship pulse phase (wall ms).
  private pulseMs = 0;

  // Last raw heliocentric ship pose the mode handed over, and whether one has
  // arrived yet — the marker re-projects and re-orients from these whenever the
  // curve or the camera changes between frames.
  private shipRawX = 0;
  private shipRawY = 0;
  private shipRawZ = 0;
  private shipHeading = 0;
  private shipPitch = 0;
  private shipSnapshot = false;

  // Pick anchors, rebuilt on demand (event-driven, not per frame). A fixed pool
  // sized for the whole roster (every body the chart can name, plus the ship) is
  // filled in place and `pickAnchors` holds references to the in-use slots, so
  // hover/tap picking allocates nothing after warm-up. Sized from the catalogs,
  // never from a literal: a pool short of the bodies offered would be written
  // off its own end.
  private pickAnchorPool: PickAnchor[] = Array.from(
    { length: MAP_PICK_ANCHOR_CAPACITY },
    () => ({ name: '', x: 0, y: 0, pickable: false, discRadiusPx: 0 }),
  );
  private pickAnchors: PickAnchor[] = [];
  // The catalog name of the currently hovered dot (fine pointers), or null.
  private hoveredName: string | null = null;
  // Whether the ship reads docked (landed or parked) this frame — set in
  // placeShip, read by the pick pass to drop the ship anchor that would
  // otherwise sit on top of its parent's dot.
  private shipDocked = false;

  // Which of the four states owns the camera. mapCamera holds the machine; the
  // members below are the poses and offsets it needs THREE for.
  private cam: MapCameraState = mapCameraInitialState();
  // The focused body's map position last frame — the follow delta is measured
  // against it, so the camera rides the body instead of chasing it.
  private followPos = new THREE.Vector3();
  // The flight in progress: where it started, the framing offset it is aiming
  // to arrive with, and the view direction it keeps (a focus preserves the
  // direction the user was already looking from).
  private flyFromPos = new THREE.Vector3();
  private flyFromTarget = new THREE.Vector3();
  private flyOffset = new THREE.Vector3();
  private flyDir = new THREE.Vector3();
  private flyGoalTarget = new THREE.Vector3();
  private flyGoalPos = new THREE.Vector3();
  private flyElapsedMs = 0;
  /** Whether this move climbs out to frame the ground it covers. Only moves
   *  that BEGIN at a body do: one starting from the overview is already out
   *  there, and one heading back out is on its way there anyway. */
  private flyArcs = false;
  private diveArcs = false;
  // How the camera sat around the focused body when a dive interrupted it —
  // re-snapped onto the body's LIVE position by a cancel, since the body moved
  // while the dive owned the camera and a follow delta cannot absorb a stale
  // snapshot.
  private diveOriginOffset = new THREE.Vector3();
  private tmpBounds: MapFollowBounds = { minDist: 0, maxDist: 0, near: 0, far: 0 };
  private tmpBodyPos = new THREE.Vector3();
  private tmpBodyPos2 = new THREE.Vector3();
  private tmpDelta = new THREE.Vector3();

  // Dive transition (camera pose only — the mode owns the clock, the fade, the
  // token, and the commit). beginDive snapshots the start pose so a cancel can
  // restore it exactly; setDivePose eases toward the focus.
  private diving = false;
  private diveWasAtOverview = false;
  /** Camera distance as a fraction of the overview fit at dive start. */
  private divePreFitRatio = 1;
  private diveFocus = new THREE.Vector3();
  // The body the dive is aimed at — the ease re-reads its live map position each
  // frame (the clock keeps moving it), so a high time rate can't dive to where
  // the dot merely was when the commit fired.
  private diveFocusName: string | null = null;
  private diveStartPos = new THREE.Vector3();
  private diveStartTarget = new THREE.Vector3();
  private diveOffsetDir = new THREE.Vector3();
  private diveStartDist = 1;
  private tmpVec3 = new THREE.Vector3();

  // Label anti-collision: labels are offered in priority order (the Sun, then
  // the planets inner→outer) and one landing on an already-placed anchor
  // yields. Sized for the whole roster, so the pool cannot bind.
  private labelPlacer = new MapLabelPlacer(MAP_LABEL_CAPACITY);

  constructor(renderer: THREE.WebGLRenderer, textures: MapTextureSource) {
    this.renderer = renderer;
    this.textures = textures;
    this.scene.background = new THREE.Color(BG_COLOR);

    const el = renderer.domElement;
    this.camera = new THREE.PerspectiveCamera(
      MAP_FOV_DEG,
      Math.max(el.clientWidth, 1) / Math.max(el.clientHeight, 1),
      1e-4,
      1000,
    );

    this.controls = new OrbitControls(this.camera, el);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.enabled = false;
    // Keep it a map: never fully edge-on, never underneath.
    this.controls.minPolarAngle = 0.08;
    this.controls.maxPolarAngle = (78 * Math.PI) / 180;

    // One star, lighting everything from the map's origin, plus the night floor.
    const sunLight = new THREE.PointLight(SUN_LIGHT_COLOR, SUN_LIGHT_INTENSITY, 0, 0);
    this.scene.add(sunLight);
    this.scene.add(new THREE.AmbientLight(NIGHT_FILL_COLOR, NIGHT_FILL_INTENSITY));

    // Halo first so the disc draws over it.
    this.sunHalo = this.makeSunHaloSprite();
    this.scene.add(this.sunHalo);
    this.sun = this.makeSunDiscSprite();
    this.scene.add(this.sun);

    for (const planet of PLANETARIUM_BODIES) {
      this.orbits.push(this.makeOrbit(planet, el));
    }

    this.shipChevronTex = this.makeChevronTexture();
    this.shipRingTex = this.makeRingTexture();
    const shipMat = new THREE.SpriteMaterial({
      map: this.shipChevronTex,
      color: 0xffb88a, // ember
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.shipMarker = new THREE.Sprite(shipMat);
    this.shipMarker.renderOrder = 10;
    this.scene.add(this.shipMarker);
  }

  isOpen(): boolean {
    return this.open;
  }

  /** How far the map is blended toward true scale: 0 compressed, 1 true. */
  getBlend(): number {
    return this.blend;
  }

  getCurve(): MapCurve {
    return this.curve;
  }

  getBodySizeParams(): MapBodySizeParams {
    return this.bodySizeParams;
  }

  getCameraDistance(): number {
    return this.camera.position.distanceTo(this.controls.target);
  }

  /** Dev forensics: the clip planes the current frame was drawn with. A body
   *  reported on screen at a healthy radius but rendering nothing is a near
   *  plane sitting in front of it, and these are the only numbers that say so. */
  getClipPlanes(): { near: number; far: number } {
    return { near: this.camera.near, far: this.camera.far };
  }

  /** Enter the map: (re)sample the orbits at the current clock. The first
   *  update() frames the whole system (ship included, positioned there). The
   *  caller owns the world's controls.enabled restore. */
  openMap(utcMs: number): void {
    this.open = true;
    this.clockUtcMs = utcMs;
    this.ensureLabelContainer();
    this.resample(utcMs);
    this.controls.enabled = true;
    this.needsInitialFrame = true;
    // Every open starts on the whole system, whatever the last one ended on.
    this.cam = mapCameraInitialState();
  }

  /** Which state owns the camera, what a flight is aiming at, and the body a
   *  focus is riding. Read by the mode each frame for the ◂ Overview chip and
   *  the pointer gates. */
  getCameraState(): Readonly<MapCameraState> {
    return this.cam;
  }

  /**
   * Focus a body: fly to it and follow it. Asking for the body already
   * followed (or already being flown to) is a no-op that still reports success
   * — the camera is where the caller wanted it. Returns false only for a body
   * the map cannot draw, a closed map, or a running dive.
   */
  focusBody(name: string): boolean {
    if (!this.open || this.cam.camState === 'dive') return false;
    if (!this.cameraMayVisit(name)) return false;
    const next = mapCameraReduce(this.cam, { kind: 'focus', name });
    if (next === this.cam) return true;
    const fromFocus = this.cam.camState !== 'overview';
    this.cam = next;
    this.startFly(fromFocus);
    return true;
  }

  /** Release the focus: fly back out to the whole-system fit. False when there
   *  was nothing to release, or the release is already under way. */
  releaseFocus(): boolean {
    if (!this.open) return false;
    const next = mapCameraReduce(this.cam, { kind: 'release' });
    if (next === this.cam) return false;
    const fromFocus = this.cam.camState !== 'overview';
    this.cam = next;
    this.startFly(fromFocus);
    return true;
  }

  /** Seat the camera at a 3/4 overhead framing the live extent (ship included). */
  private frameToExtent(): void {
    const dist = fitDistanceAU(this.extentAU, MAP_FOV_DEG, this.camera.aspect);
    this.camera.position.set(0, dist * 0.82, dist * 0.57).setLength(dist);
    this.controls.target.set(0, 0, 0);
    this.applyBounds(dist);
    this.controls.update();
  }

  /** Slide the camera along its current view ray to `dist` from the target. */
  private dollyTo(dist: number): void {
    this.tmpVec3.copy(this.camera.position).sub(this.controls.target);
    const len = this.tmpVec3.length();
    if (len < 1e-6) return;
    this.tmpVec3.multiplyScalar(dist / len);
    this.camera.position.copy(this.controls.target).add(this.tmpVec3);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.diving = false;
    this.cam = mapCameraReduce(this.cam, { kind: 'close' });
    this.flyElapsedMs = 0;
    // Settle the scale animation and the framing it was preserving. A shut map
    // has nothing to animate, and leaving either standing lets the next open
    // frame the system correctly and then spring: the animation would resume on
    // a fresh view and re-dolly it to a zoom ratio captured before whatever the
    // last session did. The committed target is what the map reopens at.
    this.blend = this.blendTo;
    this.blendAnimating = false;
    this.blendElapsedMs = 0;
    this.blendFrom = this.blendTo;
    this.scaleZoomRatio = 1;
    this.setHover(null);
    this.controls.enabled = false;
    for (const label of this.labels.values()) label.style.display = 'none';
    // Let every borrowed texture go. The world is free to dispose any of them
    // while the map is shut, so the material stops naming one here. The drop is
    // only as deep as the material: the renderer's per-material uniform cache
    // still holds the old reference until that material draws again, and a
    // closed map never draws. What that leaves is a bounded, temporary
    // retention of at most one texture per body — never a sample of a freed
    // one, because the update that re-adopts whatever the world holds runs
    // before the reopened map's first frame.
    for (const entry of this.orbits) {
      this.adoptTexture(entry.globeMat, null);
      if (entry.ringMat) this.adoptTexture(entry.ringMat, null);
      entry.globe.visible = false;
      entry.globeDrawn = false;
      entry.dot.visible = true;
    }
  }

  /** Segmented scale control: animate the blend toward compressed / true scale.
   *  Capture the user's current framing so the animation re-dollies to keep the
   *  system the same apparent size as its extent changes. */
  setScale(trueScale: boolean): void {
    const target = trueScale ? MAP_BLEND_TRUE : MAP_BLEND_COMPRESSED;
    if (Math.abs(target - this.blendTo) < 1e-9 && !this.blendAnimating) return;
    // Only the overview re-dollies against this ratio, so only the overview may
    // capture it: a focus framing is a ten-thousandth of the fit, and carrying
    // that fraction back to the overview would slam the camera into the Sun.
    // A toggle mid-focus just re-projects, and the follow delta rides it.
    if (this.cam.camState === 'overview') {
      const fit = fitDistanceAU(this.extentAU, MAP_FOV_DEG, this.camera.aspect);
      this.scaleZoomRatio = this.getCameraDistance() / Math.max(fit, 1e-4);
    }
    this.blendFrom = this.blend;
    this.blendTo = target;
    this.blendElapsedMs = 0;
    this.blendAnimating = true;
  }

  isTrueScale(): boolean {
    return this.blendTo >= MAP_BLEND_TRUE - 1e-6;
  }

  /** Dev bridge: swap the radial curve, leaving the compressed/true blend
   *  alone. A parameter the curve can't be evaluated with is ignored, leaving
   *  the current curve standing. The framing (camera distance as a fraction of
   *  the overview fit) is preserved across the swap, so the two curves are
   *  compared at one apparent size instead of one jumping in the viewer's face. */
  setCurve(curve: MapCurve): void {
    const next = sanitizeMapCurve(curve);
    if (!next) return;
    const wasFit = fitDistanceAU(this.extentAU, MAP_FOV_DEG, this.camera.aspect);
    const zoomRatio = this.getCameraDistance() / Math.max(wasFit, 1e-4);
    this.curve = next;
    this.recompressOrbits();
    if (!this.open) return;
    // The ship is part of the extent, so its marker moves onto the new curve
    // here — before the fit reads it — or the swap would frame the wrong disc.
    if (this.shipSnapshot) this.positionShipMarker();
    this.recomputeExtent();
    // Only the overview re-frames: a focused camera stays on its body, whose
    // map position jumped with the curve — the follow delta absorbs that jump
    // on the next frame, which is exactly what it is for.
    if (this.cam.camState !== 'overview') return;
    const want = zoomRatio * fitDistanceAU(this.extentAU, MAP_FOV_DEG, this.camera.aspect);
    this.dollyTo(want);
    this.applyBounds(want);
    this.controls.update();
  }

  /** Dev bridge: live tuning of the drawn-size policy. A partial merges into
   *  the running copy; null restores the shipped defaults. */
  setBodySizeParams(partial: Partial<MapBodySizeParams> | null): void {
    this.bodySizeParams = partial === null
      ? { ...MAP_BODY_SIZE_DEFAULTS }
      : { ...this.bodySizeParams, ...partial };
  }

  /**
   * Per-frame refresh, called from PlanetariumMode after positions are final.
   * Recomputes body positions from the clock (never from mode scene state) and
   * the ship from its snapshot pose.
   */
  update(
    utcMs: number,
    shipX: number,
    shipY: number,
    shipZ: number,
    shipHeading: number,
    shipPitch: number,
    shipMoving: boolean,
    landed: boolean,
    dtMs: number,
  ): void {
    if (!this.open) return;

    // ── (1) Positions from the clock — place every body and the ship marker.
    // No projection here: the camera matrices are still last frame's, so
    // anything screen-space would drag a frame behind the controls move below.
    // The instant is stored first: a body the chart derives rather than draws
    // (a moon, from its parent) is computed on demand, and this is the clock it
    // is computed at.
    this.clockUtcMs = utcMs;
    if (!this.sampled || Math.abs(utcMs - this.epochUtcMs) > ORBIT_LINE_RESAMPLE_MAX_AGE_MS) {
      this.resample(utcMs);
    }

    // Advance the scale animation; a live blend re-projects the cached samples.
    // The camera branch below keys off whether the blend moved THIS frame, not
    // off the flag: the terminal frame clears it while carrying the animation's
    // largest extent change, and that frame needs the same preserving dolly as
    // every other, or the settled view is left misframed.
    let blendMoved = false;
    if (this.blendAnimating) {
      blendMoved = true;
      this.blendElapsedMs = Math.min(this.blendElapsedMs + dtMs, MAP_BLEND_ANIM_MS);
      const t = this.blendElapsedMs / MAP_BLEND_ANIM_MS;
      this.blend = this.blendFrom + (this.blendTo - this.blendFrom) * smoothstepUnclamped(t);
      this.recompressOrbits();
      if (t >= 1) {
        this.blend = this.blendTo;
        this.blendAnimating = false;
      }
    }

    // Re-read the world's textures before anything decides how to draw. This
    // runs after the world's own update in the same frame, so a tier swap made
    // this frame is adopted before the map renders it.
    this.syncTextures();
    this.updateBodies(utcMs);
    this.placeShip(shipX, shipY, shipZ, shipHeading, shipPitch, shipMoving, landed, dtMs);

    // ── (2) Camera. The extent is refreshed unconditionally: the geometry
    // underneath never stops (the scale animation runs to its end, bodies keep
    // moving), so freezing it under a dive or a flight would leave whatever
    // frames next against a stale figure. Only the CAMERA stands down.
    this.recomputeExtent();
    switch (this.cam.camState) {
      case 'overview':
        if (this.needsInitialFrame) {
          // First frame after open: bodies and ship are positioned, so the fit
          // includes a ship past Pluto.
          this.needsInitialFrame = false;
          this.frameToExtent();
        } else if (blendMoved) {
          // Re-dolly to preserve the framing captured at the toggle, so the
          // system holds its apparent size while its extent slides with the
          // blend.
          const wantDist = this.scaleZoomRatio
            * fitDistanceAU(this.extentAU, MAP_FOV_DEG, this.camera.aspect);
          this.dollyTo(wantDist);
          this.applyBounds(wantDist);
          this.controls.update();
        } else {
          this.applyBounds(this.getCameraDistance());
          this.controls.update();
        }
        break;
      case 'focusFly':
        // The ease advances here, inside the update pass, so the projection
        // phase below replays against the pose it just wrote.
        this.advanceFly(dtMs);
        break;
      case 'following':
        this.updateFollow();
        break;
      case 'dive':
        // The mode drives setDivePose; the camera section stands down.
        break;
    }
    // Flush the matrices BEFORE any projection. The renderer refreshes them
    // only at render time, which runs after this update, so a
    // projection-dependent pass must force it.
    this.camera.updateMatrixWorld();

    // ── (3) Projection-dependent work, on this frame's final camera pose.
    this.orientShip();
    this.updateDrawnSizes();
    this.renderLabels();
  }

  /** Render the map to the backbuffer, restoring the renderer state it touches. */
  render(): void {
    const renderer = this.renderer;
    const prevTarget = renderer.getRenderTarget();
    const prevScissor = renderer.getScissorTest();
    const prevAutoClear = renderer.autoClear;
    const prevExposure = renderer.toneMappingExposure;
    renderer.getViewport(this.tmpViewport);
    renderer.getSize(this.tmpSize);
    renderer.setRenderTarget(null);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, this.tmpSize.x, this.tmpSize.y);
    renderer.autoClear = true;
    // The world's auto-exposure is still metering the scene behind the map and
    // still writing this every frame; the map draws at neutral and gives the
    // world's value back untouched, so neither view can drag the other.
    renderer.toneMappingExposure = MAP_EXPOSURE;
    // Restore in finally so a throw inside render() never strands the world
    // renderer on the map's target/viewport/autoClear/exposure state.
    try {
      renderer.render(this.scene, this.camera);
    } finally {
      renderer.setRenderTarget(prevTarget);
      renderer.setScissorTest(prevScissor);
      renderer.setViewport(this.tmpViewport);
      renderer.autoClear = prevAutoClear;
      renderer.toneMappingExposure = prevExposure;
    }
  }

  /** Resize: match the camera aspect and every fat-line resolution to the canvas. */
  onResize(): void {
    const el = this.renderer.domElement;
    const w = Math.max(el.clientWidth, 1);
    const h = Math.max(el.clientHeight, 1);
    // Judge "still at the overview fit" against the OLD aspect before touching
    // the camera — that fit is the frame the user was actually looking at. The
    // test is only ever asked of the overview: an early flight frame still sits
    // at the fit distance it started from, and dollying it would fight the ease.
    const wasAtOverview = this.open && this.sampled && this.cam.camState === 'overview'
      && !this.blendAnimating
      && !this.needsInitialFrame
      && isAtOverviewFit(
        this.getCameraDistance(),
        fitDistanceAU(this.extentAU, MAP_FOV_DEG, this.camera.aspect),
      );
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    for (const o of this.orbits) o.material.resolution.set(w, h);
    // A viewport change (device rotation, window resize) refits the overview:
    // the vertical FOV is fixed, so portrait fits far less width and the old
    // dolly distance would clip the outer system. Only the parked overview
    // refits — a deliberate zoom keeps its distance, and the dive / scale
    // animation / first-frame fit each own the camera already.
    if (wasAtOverview) {
      const want = fitDistanceAU(this.extentAU, MAP_FOV_DEG, this.camera.aspect);
      this.dollyTo(want);
      this.applyBounds(want);
      this.controls.update();
      return;
    }
    // A focus meters its shell and its clip planes in screen px, so both move
    // with the viewport. Rebuild them here rather than waiting for the next
    // update, and replay the projection phase with them — the sizes and labels
    // on screen right now were metered against the viewport that just went away.
    if (this.cam.camState === 'following') {
      this.applyFollowBounds();
      this.controls.update();
    } else if (this.cam.camState === 'focusFly' && this.cam.focusName) {
      this.applyFocusClip(this.cam.focusName);
    } else {
      return;
    }
    this.camera.updateMatrixWorld();
    this.orientShip();
    this.updateDrawnSizes();
    this.renderLabels();
  }

  // ---- focus & follow ---------------------------------------------------

  /** Begin the flight the machine has just entered: freeze where it starts from
   *  and what framing it is aiming to arrive with. */
  private startFly(fromFocus: boolean): void {
    // A focus asked for before the map's first frame has nothing to fly FROM,
    // and would strand the pending fit to spring on a later return. Seat the
    // overview first, so the flight starts from the frame the user would have
    // been looking at.
    if (this.needsInitialFrame) {
      this.needsInitialFrame = false;
      this.recomputeExtent();
      this.frameToExtent();
    }
    // A released drag keeps coasting for a while; start from a settled controls
    // state or the residual curves the flight away from where it is aimed.
    flushOrbitDamping(this.controls);
    this.controls.enabled = false;
    this.flyElapsedMs = 0;
    this.flyArcs = fromFocus && this.cam.flyGoal === 'follow';
    this.flyFromPos.copy(this.camera.position);
    this.flyFromTarget.copy(this.controls.target);
    // Keep the direction the user is already looking from, so a focus changes
    // what is centred and how close it is, never which way is up.
    this.flyDir.copy(this.camera.position).sub(this.controls.target);
    if (this.flyDir.lengthSq() < 1e-24) this.flyDir.set(0, 0.82, 0.57);
    this.flyDir.normalize();
    const landingDist = this.cam.flyGoal === 'follow' && this.cam.focusName
      ? this.revealDistanceFor(this.cam.focusName)
      : null;
    if (landingDist !== null) {
      this.flyOffset.copy(this.flyDir).multiplyScalar(landingDist);
    } else {
      // The way out re-derives its distance from the live extent each frame,
      // and so does a flight whose subject the chart could not place — every
      // frame of the ease asks again.
      this.flyOffset.copy(this.flyDir);
    }
  }

  /** Advance the flight one frame and land it when the ease runs out. */
  private advanceFly(dtMs: number): void {
    const name = this.cam.focusName;
    const toFollow = this.cam.flyGoal === 'follow';
    this.flyElapsedMs += dtMs;
    const t = Math.min(1, this.flyElapsedMs / MAP_FOCUS_FLY_MS);
    const k = mapFocusEase(t);
    // Re-aim at the LIVE goal every frame. At a high time rate a body crosses a
    // long way in 0.9 s, so a click-time endpoint would land on empty space; the
    // way out re-reads the fit for the same reason (the extent is never frozen).
    if (toFollow && name) {
      // A subject that stops resolving mid-flight keeps the goal and the
      // framing offset the last resolving frame left, and the ease finishes on
      // those: re-aiming at the origin would drive the camera into the Sun.
      if (this.bodyMapPosition(name, this.flyGoalTarget)) {
        // The shell moves under the flight: a scale toggle changes the extent,
        // and with it how close the near plane lets the camera come. Re-derive
        // the landing distance every frame — a frozen one drives the flight to
        // a distance the landing would have to clamp away, in a visible jump.
        const landingDist = this.revealDistanceFor(name);
        if (landingDist !== null) {
          this.flyOffset.copy(this.flyDir).multiplyScalar(landingDist);
        }
      }
    } else {
      this.flyGoalTarget.set(0, 0, 0);
      this.flyOffset.copy(this.flyDir)
        .multiplyScalar(fitDistanceAU(this.extentAU, MAP_FOV_DEG, this.camera.aspect));
    }
    this.flyGoalPos.copy(this.flyGoalTarget).add(this.flyOffset);
    this.controls.target.lerpVectors(this.flyFromTarget, this.flyGoalTarget, k);
    this.camera.position.lerpVectors(this.flyFromPos, this.flyGoalPos, k);
    // Body to body, the straight path spends its whole middle inside empty
    // space between two things it is far too close to see. Lift it out to where
    // the pair fits and let it fall back in: the trip reads as a trip.
    // Re-derived every frame, not chosen at the start: the extent, the two
    // bodies' positions and the viewport all move under a flight, and a frozen
    // framing distance stops framing what it was picked for.
    if (this.flyArcs) this.arcCameraOut(this.flyFromTarget, this.flyGoalTarget, name);
    this.camera.lookAt(this.controls.target);
    // The clip planes ride the flight: it starts under overview clipping and
    // ends hugging a body, so they are derived at THIS pose, not at either end.
    // The body being LEFT is passed too: the camera is still inside its shell
    // for the first stretch, and metering only against the destination an AU
    // away would put the near plane straight through it. Nothing clamps the
    // distance here — controls.update() is not called during a flight, and the
    // overview distance it starts from is outside the shell it is heading for.
    if (name) this.applyFocusClip(name, this.nearestBodyName());
    else this.applyBounds(this.getCameraDistance());
    if (t < 1) return;

    this.cam = mapCameraReduce(this.cam, { kind: 'flyLanded' });
    if (this.cam.camState === 'following' && name) {
      // Land on where the body IS, not where the ease was interpolating toward
      // a frame ago, so the follow starts with a zero delta.
      this.controls.target.copy(this.flyGoalTarget);
      this.camera.position.copy(this.flyGoalPos);
      this.camera.lookAt(this.controls.target);
      this.followPos.copy(this.flyGoalTarget);
      this.applyFollowBounds();
    } else {
      this.applyBounds(this.getCameraDistance());
      this.rebaseScaleZoomRatio();
    }
    this.controls.enabled = true;
    this.controls.update();
  }

  /** Re-read the framing the overview holds through a scale animation.
   *  The ratio is captured only while the overview owns the camera, so one
   *  captured before a focus would still be standing when the flight back
   *  lands — and a scale animation outliving that flight would then re-dolly
   *  the fresh fit to a zoom from before the trip. */
  private rebaseScaleZoomRatio(): void {
    const fit = fitDistanceAU(this.extentAU, MAP_FOV_DEG, this.camera.aspect);
    this.scaleZoomRatio = this.getCameraDistance() / Math.max(fit, 1e-4);
  }

  /** Push the camera out along its own view ray far enough that the move has
   *  something to show: the nearer end of the trip between `from` and `to`, and
   *  whatever body is nearest the aim. Callers that pass no arc leave the pose
   *  untouched, bit for bit — which is how a move beginning at the overview
   *  keeps its straight path. */
  private arcCameraOut(from: THREE.Vector3, to: THREE.Vector3, toName: string | null): void {
    this.tmpDelta.copy(this.camera.position).sub(this.controls.target);
    const baseDist = this.tmpDelta.length();
    if (baseDist < 1e-12) return;
    // Two things have to stay framed, so the move is held to whichever asks for
    // more room: the nearer END of the trip, so you can always see where you
    // came from or where you are going; and the cheapest whole BODY, because a
    // move redirected mid-way starts from a point in empty space, and framing
    // that would frame nothing at all. The far end is carried by the second
    // term whenever it is the body nearest the aim, which is exactly when its
    // own reach is large.
    // A destination the chart cannot size contributes no reach — the trip is
    // still framed by its endpoints and by the cheapest whole body.
    const toReach = (toName ? this.drawnReachAU(toName) : null) ?? 0;
    const gap = Math.max(
      Math.min(
        this.controls.target.distanceTo(from),
        this.controls.target.distanceTo(to) + toReach,
      ),
      this.aimFramingGapAU(),
    );
    const framed = mapFlightFramingDistanceAU(
      baseDist,
      gap,
      this.extentAU,
      MAP_FOV_DEG,
      this.camera.aspect,
    );
    if (framed === baseDist) return;
    this.camera.position.copy(this.controls.target)
      .addScaledVector(this.tmpDelta, framed / baseDist);
  }

  /** The smallest disc about the aim that holds a whole body — centre offset
   *  plus that body's own drawn reach, so the framing contains the ring or the
   *  halo rather than cutting through it. Whichever body is cheapest to hold
   *  wins, which is not always the nearest one: a close Saturn wearing rings
   *  can cost more room than a bare planet slightly further off. Read live
   *  every frame — the destination moves, the chart can change scale under the
   *  move, and a redirect can hand the aim a wholly new path. */
  private aimFramingGapAU(): number {
    // Over the bodies the chart DRAWS — the Sun and the planets. A body with no
    // drawn reach adds none; the distance to it still counts.
    let best = this.controls.target.distanceTo(this.sun.position)
      + (this.drawnReachAU(SUN_DATA.name) ?? 0);
    for (const entry of this.orbits) {
      const gap = this.controls.target.distanceTo(entry.dot.position)
        + (this.drawnReachAU(entry.planet.name) ?? 0);
      if (gap < best) best = gap;
    }
    return best;
  }

  /** Ride the focused body: translate camera and target by its motion this
   *  frame, so it stays centred while the user still orbits and zooms it. */
  private updateFollow(): void {
    const name = this.cam.focusName;
    // A subject that stops resolving parks the ride where it is: the delta is
    // the body's motion, and there is no motion to apply for a body that isn't
    // anywhere. The user keeps the frame they had instead of being thrown at
    // the origin.
    if (name && this.bodyMapPosition(name, this.tmpBodyPos)) {
      this.tmpDelta.copy(this.tmpBodyPos).sub(this.followPos);
      this.camera.position.add(this.tmpDelta);
      this.controls.target.add(this.tmpDelta);
      this.followPos.copy(this.tmpBodyPos);
    }
    this.applyFollowBounds();
    this.controls.update();
  }

  /** Where a flight to `name` lands: the reveal framing, held inside the shell
   *  the body can actually be orbited in. Null for a body the chart cannot
   *  place — there is no landing distance to a body that isn't anywhere. */
  private revealDistanceFor(name: string): number | null {
    const radius = this.bodyTrueRadiusAU(name);
    const bounds = this.followBoundsFor(name);
    if (radius === null || !bounds) return null;
    const h = Math.max(this.renderer.domElement.clientHeight, 1);
    return clampFollowDistanceAU(revealDistanceAU(radius, h, MAP_FOV_DEG), bounds);
  }

  /** The follow shell and clip planes for a body, at this frame's camera pose.
   *  `alsoClear` names a second body the camera is still close to — the one a
   *  transition is leaving. The distance shell belongs to `name`, but the near
   *  plane belongs to whichever surface is NEAREST: a camera an AU from where
   *  it is headed and a thousandth of one from where it started would otherwise
   *  meter its near plane against the far body and cut the near one away. */
  private followBoundsFor(name: string, alsoClear: string | null = null): MapFollowBounds | null {
    const radius = this.bodyTrueRadiusAU(name);
    if (radius === null || !this.bodyMapPosition(name, this.tmpBodyPos)) return null;
    const camDist = this.camera.position.distanceTo(this.tmpBodyPos);
    let surface = Math.max(camDist - radius, 1e-9);
    if (alsoClear && alsoClear !== name) {
      // A second body the near plane also has to clear. One the chart cannot
      // place simply doesn't take part — the destination's own surface stands.
      const otherRadius = this.bodyTrueRadiusAU(alsoClear);
      if (otherRadius !== null && this.bodyMapPosition(alsoClear, this.tmpBodyPos2)) {
        const otherSurface = this.camera.position.distanceTo(this.tmpBodyPos2) - otherRadius;
        // As the body being left recedes its surface distance grows past the
        // destination's, and responsibility passes over on its own.
        if (otherSurface < surface) surface = Math.max(otherSurface, 1e-9);
      }
    }
    return followBounds(
      radius,
      surface,
      this.camera.position.length(),
      this.tmpBodyPos.length(),
      this.extentAU,
      Math.max(this.renderer.domElement.clientHeight, 1),
      MAP_FOV_DEG,
      this.bodySizeParams,
      this.tmpBounds,
    );
  }

  /** Hand the whole bounds transaction to the controls and the camera. */
  private applyFollowBounds(): void {
    const name = this.cam.focusName;
    // Nothing to ride, or a subject the chart cannot place: fall back to the
    // whole-system bounds, which are safe from anywhere.
    const bounds = name ? this.followBoundsFor(name) : null;
    if (!bounds) {
      this.applyBounds(this.getCameraDistance());
      return;
    }
    this.controls.minDistance = bounds.minDist;
    this.controls.maxDistance = bounds.maxDist;
    this.camera.near = bounds.near;
    this.camera.far = bounds.far;
    this.camera.updateProjectionMatrix();
  }

  /** Clip planes only — for the moves that write the pose themselves and must
   *  not touch the distance clamps (a flight, and a dive out of a focus).
   *  `alsoClear` is the body the move is leaving, which the near plane has to
   *  keep clear of for as long as the camera is still inside its shell. */
  private applyFocusClip(name: string, alsoClear: string | null = null): void {
    const bounds = this.followBoundsFor(name, alsoClear);
    // A subject the chart cannot place leaves the planes exactly as they are:
    // this is the path that must not touch the distance clamps, so there is
    // nothing safe to fall back to, and the standing planes are the ones the
    // frame before this drew with.
    if (!bounds) return;
    this.camera.near = bounds.near;
    this.camera.far = bounds.far;
    this.camera.updateProjectionMatrix();
  }

  /** The body whose SURFACE the camera is nearest right now, over the whole
   *  chart. A transition writes its own pose across the system, and the near
   *  plane belongs to whatever is closest at that moment — which after a
   *  chained retarget is neither the body being aimed at nor the one the last
   *  flight was aimed at, but the one the camera is still sitting inside. */
  private nearestBodyName(): string | null {
    // Over what the chart DRAWS: the Sun and the planets. Nothing else is on
    // screen for a near plane to cut through.
    let best: string | null = null;
    let bestSurface = Infinity;
    if (this.bodyMapPosition(SUN_DATA.name, this.tmpBodyPos2)) {
      bestSurface = this.camera.position.distanceTo(this.tmpBodyPos2) - SUN_DATA.radiusAU;
      best = SUN_DATA.name;
    }
    for (const entry of this.orbits) {
      const surface = this.camera.position.distanceTo(entry.dot.position) - entry.planet.radiusAU;
      if (surface < bestSurface) {
        bestSurface = surface;
        best = entry.planet.name;
      }
    }
    return best;
  }

  /** The orbit entry that draws a planet, or null for anything that is not one
   *  (the Sun, a moon, a name the chart does not know). The one place a body
   *  name is searched for among the drawn planets. */
  private entryFor(name: string): OrbitEntry | null {
    return this.orbits.find((o) => o.planet.name === name) ?? null;
  }

  /** Whether the camera may be flown to, follow, or dive at this body: the
   *  policy is mapBodyAcceptsCamera, and what this scene DRAWS is the Sun plus
   *  the planets it built orbit entries for. Resolution stays open to every
   *  body in the roster — position, radius, tint, the probe — and only the
   *  camera is held to the narrower set. */
  private cameraMayVisit(name: string): boolean {
    return mapBodyAcceptsCamera(name, (n) => this.entryFor(n) !== null);
  }

  /**
   * A body's live map position, or null when the chart has no such body — and
   * `out` is left untouched in that case, so a caller riding a body can simply
   * keep the last position it had.
   *
   * Null rather than the origin, on purpose: the origin is where the Sun is, so
   * a camera handed it for a body that stopped resolving would fly into the
   * star. Every caller decides for itself what to do with no position.
   *
   * A moon rides its parent. The chart compresses HELIOCENTRIC radii; a
   * planetocentric offset is not on that curve, so the moon's true offset in AU
   * is added to the parent's map position as it is.
   */
  private bodyMapPosition(name: string, out: THREE.Vector3): THREE.Vector3 | null {
    const body = mapBody(name);
    if (!body) return null;
    if (body.kind === 'sun') return out.copy(this.sun.position);
    if (body.kind === 'planet') {
      const entry = this.entryFor(name);
      return entry ? out.copy(entry.dot.position) : null;
    }
    const parent = body.parentPlanet ? this.entryFor(body.parentPlanet) : null;
    if (!parent) return null;
    computeMoonOffsetEquatorialAU(name, parent.planet.name, this.clockUtcMs, this.tmpMoonOffset);
    return out.copy(parent.dot.position).add(this.tmpMoonOffset);
  }

  /** A body's TRUE radius in AU — what the framing and the clip planes meter
   *  against, never the drawn radius the chart marker may have floored. Null
   *  for a body the chart does not know: a zero radius would read as a real
   *  answer and put the near plane on the camera's own eye. */
  private bodyTrueRadiusAU(name: string): number | null {
    return mapBody(name)?.radiusAU ?? null;
  }

  /** How much room a body takes up right now, in map AU: its true size once the
   *  camera can resolve it and its chart marker while it cannot (the size policy
   *  answers both from one call, so nothing here re-decides which branch
   *  applies), widened past any ring it wears. The ring is drawn geometry — a
   *  camera stopped clear of the globe but inside the annulus is still inside
   *  the body as far as the frame is concerned. Null for an unknown body. */
  private drawnClearanceRadiusAU(name: string): number | null {
    const globe = this.drawnGlobeRadiusAU(name);
    return globe === null ? null : globe * this.ringOuterFactorOf(name);
  }

  /** Everything a body PAINTS, in map AU — its ring, or in the Sun's case the
   *  halo baked around the disc. This is the framing figure, and it is a wider
   *  one than the clearance above: a camera has to stay outside a ring, but a
   *  frame has to contain the glow as well.
   *
   *  It follows the look the body is actually WEARING. A dot is a fixed-size
   *  sprite and owes the size policy nothing: the policy would budget Mercury
   *  six pixels while its marker paints ten, and Jupiter sixteen while its
   *  marker paints ten. Reading the drawn look instead keeps the figure honest
   *  on both sides of the swap, so the framing follows the handoff rather than
   *  stepping across it.
   *
   *  The look is last frame's — drawn sizes are settled in the projection pass,
   *  after the moves that read this — which costs a frame at the swap and
   *  corrects itself on the next.
   *
   *  Null for a body the chart does not know. */
  private drawnReachAU(name: string): number | null {
    const globe = this.drawnGlobeRadiusAU(name);
    if (globe === null) return null;
    const body = mapBody(name);
    if (body?.kind === 'sun') {
      // The Sun is always its billboard, and the halo is baked around the disc.
      return globe * SUN_HALO_RADII;
    }
    const entry = this.entryFor(name);
    // A body with no drawn geometry of its own — the size policy is the whole
    // of the room it asks for.
    if (!entry) return globe;
    if (entry.globeDrawn) return globe * entry.ringOuterFactor;
    const perPx = mapWorldPerPxAtUnitDepth(
      Math.max(this.renderer.domElement.clientHeight, 1),
      MAP_FOV_DEG,
    );
    // PLANET_PX is the sprite's full extent, so half of it is the reach; a
    // hovered dot swells by the same factor its material does.
    const hoverBoost = name === this.hoveredName ? HOVER_SCALE : 1;
    return (PLANET_PX / 2) * hoverBoost * perPx * this.viewDepth(entry.dot.position);
  }

  /** The globe radius the size policy gives a body at the current pose: its
   *  true size once the camera can resolve it, its chart marker while it
   *  cannot. Null for a body the chart cannot place or size. */
  private drawnGlobeRadiusAU(name: string): number | null {
    const radius = this.bodyTrueRadiusAU(name);
    if (radius === null) return null;
    if (!this.bodyMapPosition(name, this.tmpBodyPos)) return null;
    const perPx = mapWorldPerPxAtUnitDepth(
      Math.max(this.renderer.domElement.clientHeight, 1),
      MAP_FOV_DEG,
    );
    return mapBodyRadiusAU(
      radius,
      this.viewDepth(this.tmpBodyPos),
      perPx,
      this.bodySizeParams,
    );
  }

  /** The outer edge of a body's ring in globe radii, 1 where the map draws no
   *  ring for it. Read from the built entry rather than the catalog, so this
   *  tracks the geometry that actually exists in the scene. */
  private ringOuterFactorOf(name: string): number {
    return this.entryFor(name)?.ringOuterFactor ?? 1;
  }

  // ---- picking / hover / dive ------------------------------------------

  /** Nearest actionable body (or the inert ship) under a screen tap. The
   *  anchors rebuild here, on the event, so steady-state stays allocation-free. */
  pick(x: number, y: number, pointerType: string): PickResult {
    this.rebuildPickAnchors();
    return resolvePick(x, y, this.pickAnchors, pickRadiusFor(pointerType));
  }

  /** The pickable body under the cursor, for fine-pointer hover feedback. */
  hoverAt(x: number, y: number): string | null {
    this.rebuildPickAnchors();
    const hit = resolvePick(x, y, this.pickAnchors, pickRadiusFor('mouse'));
    return hit.kind === 'body' ? hit.name : null;
  }

  /** Brighten the hovered dot and emphasize its label; restore the previous. */
  setHover(name: string | null): void {
    if (name === this.hoveredName) return;
    this.applyDotEmphasis(this.hoveredName, false);
    this.hoveredName = name;
    this.applyDotEmphasis(name, true);
  }

  /** True (uncompressed) distance in AU from the ship to a body — what the card
   *  reports. Reads each planet's cached heliocentric position (no extra
   *  ephemeris call); the Sun sits at the origin, and a moon is its parent plus
   *  its live planetocentric offset. Null for a body the chart does not know:
   *  zero would read as the ship standing on it. */
  trueDistanceFromShip(
    name: string,
    shipX: number,
    shipY: number,
    shipZ: number,
  ): number | null {
    const body = mapBody(name);
    if (!body) return null;
    let bx = 0;
    let by = 0;
    let bz = 0;
    if (body.kind === 'planet') {
      const entry = this.entryFor(name);
      if (!entry) return null;
      bx = entry.helioX;
      by = entry.helioY;
      bz = entry.helioZ;
    } else if (body.kind === 'moon') {
      const parent = body.parentPlanet ? this.entryFor(body.parentPlanet) : null;
      if (!parent) return null;
      computeMoonOffsetEquatorialAU(name, parent.planet.name, this.clockUtcMs, this.tmpMoonOffset);
      bx = parent.helioX + this.tmpMoonOffset.x;
      by = parent.helioY + this.tmpMoonOffset.y;
      bz = parent.helioZ + this.tmpMoonOffset.z;
    }
    return Math.hypot(bx - shipX, by - shipY, bz - shipZ);
  }

  isDiving(): boolean {
    return this.diving;
  }

  /** Dev forensics: distance (scene AU) between the dive camera's look target
   *  and the live target dot. Once the ease lands (target == focus) this reads
   *  ~0 only if the focus tracked the moving dot; a stale snapshot leaves a gap
   *  the size of the dot's travel. null when no dive is running. */
  diveTargetGapAU(): number | null {
    if (!this.diving || !this.diveFocusName) return null;
    if (!this.bodyMapPosition(this.diveFocusName, this.tmpBodyPos)) return null;
    return this.controls.target.distanceTo(this.tmpBodyPos);
  }

  /** Snapshot the camera and the target body's map position; from here the mode
   *  drives setDivePose each frame. Returns false if the body isn't on the map. */
  beginDive(name: string): boolean {
    // Only a body the camera may visit — the dive ends a few drawn radii off
    // the destination, on the same shell a follow uses.
    if (!this.cameraMayVisit(name)) return false;
    // And refuse a body it cannot place: the ease runs toward a position, and
    // the position it would otherwise be handed is the Sun's.
    if (!this.bodyMapPosition(name, this.tmpBodyPos)) return false;
    // Memo how the camera sat around a focused body BEFORE the machine forgets
    // it. A follow is restored from where it actually was; an interrupted
    // approach is restored from the framing it was heading for, so a cancel
    // completes the flight instead of stranding the camera halfway.
    if (this.cam.camState === 'following') {
      this.diveOriginOffset.copy(this.camera.position).sub(this.controls.target);
    } else if (this.cam.camState === 'focusFly') {
      this.diveOriginOffset.copy(this.flyOffset);
    }
    // A dive out of a focus aimed at a DIFFERENT body is the journey a retarget
    // is, and gets the same arc; one aimed at the body already followed is a
    // plain approach and keeps its straight line, as an overview dive does.
    this.diveArcs = this.cam.camState !== 'overview';
    this.cam = mapCameraReduce(this.cam, { kind: 'diveStart', camera: true });
    this.diveFocusName = name;
    this.diveFocus.copy(this.tmpBodyPos);
    // How the camera was framed at dive start, kept as a FRACTION of the fit
    // rather than an absolute distance: a cancel has to rebuild the framing
    // against whatever the extent has become by then, and only the fraction
    // survives that. Whether it left from the parked overview is tracked
    // separately, so a cancel can snap that case back to the exact fit — which
    // is also what corrects the distance if the viewport rotated during the
    // dive (onResize stands down while diving).
    const startFit = fitDistanceAU(this.extentAU, MAP_FOV_DEG, this.camera.aspect);
    this.divePreFitRatio = this.getCameraDistance() / Math.max(startFit, 1e-4);
    this.diveWasAtOverview = isAtOverviewFit(this.getCameraDistance(), startFit);
    this.diveStartPos.copy(this.camera.position);
    this.diveStartTarget.copy(this.controls.target);
    this.diveOffsetDir.copy(this.diveStartPos).sub(this.diveStartTarget);
    this.diveStartDist = Math.max(this.diveOffsetDir.length(), 1e-4);
    this.diveOffsetDir.normalize();
    this.controls.enabled = false;
    this.diving = true;
    this.setHover(null);
    return true;
  }

  /** Ease the camera toward the focus. frac 0 = start pose, 1 = fully dived in.
   *  The focus tracks the target's current map position (the dot drifts under
   *  the clock while the ease runs), so the camera always lands on the live dot;
   *  only the start pose stays snapshotted, for cancel-restore. */
  setDivePose(frac: number): void {
    if (!this.diving) return;
    // The target's live position, or the last one it had — bodyMapPosition
    // leaves its output alone when it cannot answer, so a body that stops
    // resolving mid-dive keeps the ease running to where it last was.
    if (this.diveFocusName) this.bodyMapPosition(this.diveFocusName, this.diveFocus);
    const f = Math.max(0, Math.min(1, frac));
    this.tmpVec3.copy(this.diveStartTarget).lerp(this.diveFocus, f);
    this.controls.target.copy(this.tmpVec3);
    // From the overview the ease ends a whole system away from the destination;
    // from a focus it starts a few radii out, where the same fraction lands
    // under the surface. The floor is the destination's own drawn size, so a
    // dive out of a focus stops just clear of it.
    // A destination the chart cannot size gives the floor nothing to stand on,
    // and the plain fraction is what remains.
    const endFrac = mapDiveEndFraction(
      this.diveStartDist,
      (this.diveFocusName ? this.drawnClearanceRadiusAU(this.diveFocusName) : null) ?? 0,
      DIVE_END_DIST_FRAC,
    );
    const dist = this.diveStartDist * (1 - f * (1 - endFrac));
    // The same lift a retarget gets: a commit aimed across the system from a
    // close follow is a journey, not a cut.
    const arced = this.diveArcs
      ? mapFlightFramingDistanceAU(
        dist,
        Math.max(
          Math.min(
            this.controls.target.distanceTo(this.diveStartTarget),
            this.controls.target.distanceTo(this.diveFocus)
              + ((this.diveFocusName ? this.drawnReachAU(this.diveFocusName) : null) ?? 0),
          ),
          this.aimFramingGapAU(),
        ),
        this.extentAU,
        MAP_FOV_DEG,
        this.camera.aspect,
      )
      : dist;
    this.camera.position.copy(this.tmpVec3).addScaledVector(this.diveOffsetDir, arced);
    this.camera.lookAt(this.tmpVec3);
    // A dive out of a focus inherits clip planes metered for a camera already
    // hugging a body, and then closes the distance to a seventh of that — so
    // the planes are re-derived here too, or the target passes through the near
    // plane mid-dive. A dive from the overview keeps the overview's clipping.
    if (this.cam.diveOrigin && this.cam.diveOrigin.camState !== 'overview' && this.diveFocusName) {
      // The body the dive left is passed too: the camera starts inside its
      // shell, and metering only against a destination an AU away would put the
      // near plane through the body still filling the frame.
      this.applyFocusClip(this.diveFocusName, this.nearestBodyName());
    }
    this.camera.updateMatrixWorld();
    // The dive is the only camera move that does not happen inside update(), so
    // everything metered off the camera has to be rebuilt here, against the pose
    // just set. Drawn sizes are the sharp case: a marker-floored body is sized
    // in world units from its camera depth, so a size left on the previous
    // frame's depth renders in the ratio of the two — and this ease collapses
    // the distance to a seventh in a few hundred ms, so the body would swell
    // through the dive and snap back at the end. Labels and the ship chevron
    // are placed and rotated by projection and are on screen for the whole
    // camera ease (the fade only starts after it), so they are rebuilt for the
    // same reason — the whole projection-dependent phase runs here, not part
    // of it, and in the order update() runs it.
    this.orientShip();
    this.updateDrawnSizes();
    this.renderLabels();
  }

  /** End the dive. On cancel, restore the pre-dive pose and hand controls back;
   *  on commit, leave the pose (the map is about to close). */
  endDive(commit: boolean): void {
    if (!this.diving) return;
    this.diving = false;
    const origin = this.cam.diveOrigin;
    this.cam = mapCameraReduce(this.cam, { kind: 'diveCancel' });
    // A committed dive restores nothing: the map is about to close, and close()
    // resets the machine.
    if (commit) return;
    // The extent is refreshed every frame, but the restore is framed against it
    // and a cancel arrives between frames — re-derive so the pose can never be
    // built on last frame's figure. The scale animation runs to its end under a
    // dive, so that figure can be many times out.
    this.recomputeExtent();
    // Where the dive left from decides where a cancel puts you back.
    if (origin && origin.camState !== 'overview') {
      this.restoreFocusFromDive(origin.focusName, origin.flyGoal === 'overview');
      return;
    }
    this.camera.position.copy(this.diveStartPos);
    this.controls.target.copy(this.diveStartTarget);
    this.camera.lookAt(this.diveStartTarget);
    // View direction restored exactly; the distance is rebuilt against the
    // current extent and aspect, so a scale change or a viewport rotation
    // during the dive can't leave the restored frame clipped. A no-op when
    // neither moved.
    const want = diveRestoreDistanceAU(
      this.diveWasAtOverview,
      this.divePreFitRatio,
      fitDistanceAU(this.extentAU, MAP_FOV_DEG, this.camera.aspect),
    );
    this.dollyTo(want);
    this.applyBounds(want);
    this.camera.updateMatrixWorld();
    this.controls.enabled = true;
    this.controls.update();
  }

  /** Put a cancelled dive back where its focus was. `leaving` means the dive
   *  interrupted a release — that flight completes to the overview rather than
   *  reversing itself back onto the body the user had just let go of. */
  private restoreFocusFromDive(focusName: string | null, leaving: boolean): void {
    // A focus the chart can no longer place is restored the way a release is:
    // the overview is always somewhere the camera can legally sit.
    const focusPos = focusName ? this.bodyMapPosition(focusName, this.tmpBodyPos) : null;
    if (leaving || !focusPos) {
      const fit = fitDistanceAU(this.extentAU, MAP_FOV_DEG, this.camera.aspect);
      this.controls.target.set(0, 0, 0);
      this.camera.position.copy(this.flyDir).multiplyScalar(fit);
      this.camera.lookAt(this.controls.target);
      this.applyBounds(fit);
      this.rebaseScaleZoomRatio();
    } else {
      // Onto the body's LIVE position: it moved while the dive owned the
      // camera, and a follow delta measured from a stale snapshot would carry
      // that error forever.
      this.controls.target.copy(focusPos);
      this.camera.position.copy(focusPos).add(this.diveOriginOffset);
      this.camera.lookAt(this.controls.target);
      this.followPos.copy(focusPos);
      this.applyFollowBounds();
    }
    this.camera.updateMatrixWorld();
    this.controls.enabled = true;
    this.controls.update();
  }

  private rebuildPickAnchors(): void {
    // The renderer only refreshes the camera matrices at render time; a pick
    // landing between a controls move and the next frame must project against
    // the live pose, so flush the matrix here before projecting the anchors.
    this.camera.updateMatrixWorld();
    const w = this.renderer.domElement.clientWidth;
    const h = this.renderer.domElement.clientHeight;
    this.pickAnchors.length = 0;
    this.pushAnchor('Sun', this.sun.position, true, w, h, this.sunRadiusPx);
    for (const entry of this.orbits) {
      // A dot is a marker with no footprint of its own — the pointer floor
      // governs it. A globe hands over its drawn radius, so a click on the limb
      // of a body that fills the frame lands on the body.
      this.pushAnchor(
        entry.planet.name,
        entry.dot.position,
        true,
        w,
        h,
        entry.globeDrawn ? entry.drawnRadiusPx : 0,
      );
    }
    // Docked, the ship ring sits on top of its parent's dot — omit it so the tap
    // lands on the body (its Leave / Observatory card). Undocked, the ship stays
    // an inert anchor that swallows a tap without picking.
    if (!this.shipDocked) {
      this.pushAnchor('__ship', this.shipMarker.position, false, w, h);
    }
  }

  /** Project one body's MAP POSITION (never a mesh) into a pick anchor, so the
   *  hit target stays put whatever the body draws as. `discRadiusPx` is that
   *  drawing's own footprint — 0 for a marker, which leaves the pointer floor
   *  governing. */
  private pushAnchor(
    name: string,
    worldPos: THREE.Vector3,
    pickable: boolean,
    w: number,
    h: number,
    discRadiusPx = 0,
  ): void {
    projectToScreen(worldPos, this.camera, w, h, this.tmpProj);
    if (this.tmpProj.ndcZ >= 1) return; // behind the camera — not on screen
    // A dot past the frame edge isn't pickable even if the tap radius reaches
    // it; a body with a drawn footprint stays pickable while any of it shows.
    if (!anchorOnScreen(this.tmpProj.x, this.tmpProj.y, w, h, discRadiusPx)) return;
    let a = this.pickAnchorPool[this.pickAnchors.length];
    if (!a) {
      // The pool is sized for the whole roster plus the ship, so this cannot
      // bind. If it ever does, the bodies offered have outgrown it: grow it
      // once rather than write past the end of the array, and say so where a
      // developer will see it — an overflow that quietly allocated would hide
      // the regression behind a steady state that is no longer allocation-free.
      if (import.meta.env.DEV) {
        debugWarn(
          `SystemMap pick-anchor pool exhausted at ${this.pickAnchorPool.length} slots`,
        );
      }
      a = { name: '', x: 0, y: 0, pickable: false, discRadiusPx: 0 };
      this.pickAnchorPool.push(a);
    }
    a.name = name;
    a.x = this.tmpProj.x;
    a.y = this.tmpProj.y;
    a.pickable = pickable;
    a.discRadiusPx = discRadiusPx;
    this.pickAnchors.push(a);
  }

  /** The marker sprite a body draws while it is not a globe: the Sun's disc, or
   *  a planet's dot. Null for a body the chart draws no marker for. */
  private markerSpriteFor(name: string): THREE.Sprite | null {
    const body = mapBody(name);
    if (!body) return null;
    if (body.kind === 'sun') return this.sun;
    return this.entryFor(name)?.dot ?? null;
  }

  /** Hover feedback for one body: its marker lifts toward white, its globe (if
   *  that is what it draws) answers with its own tint instead, and its label
   *  emphasizes. A body with none of those — one the chart knows but does not
   *  draw yet — simply has nothing to emphasize. */
  private applyDotEmphasis(name: string | null, on: boolean): void {
    if (!name) return;
    const body = mapBody(name);
    if (!body) return;
    const entry = this.entryFor(name);
    const sprite = this.markerSpriteFor(name);
    const base = body.kind === 'sun' ? this.sunBaseColor : entry?.baseColor ?? null;
    if (sprite && base) {
      const mat = sprite.material as THREE.SpriteMaterial;
      if (on) mat.color.copy(base).lerp(WHITE, HOVER_LIFT);
      else mat.color.copy(base);
    }
    if (entry) {
      // The globe answers with its own tint rather than the dot's swell.
      if (on) entry.globeMat.emissive.copy(entry.baseColor).multiplyScalar(GLOBE_HOVER_EMISSIVE);
      else entry.globeMat.emissive.setRGB(0, 0, 0);
    }
    const label = this.labels.get(name);
    if (label) label.classList.toggle('hover', on);
  }

  /** Dev forensics: how one body is drawing right now, where its hit target
   *  sits, which way its pole points, and whether the texture it adopted is
   *  still the one the world holds — the check that a 2K→4K hot-swap under an
   *  open map was picked up rather than left on a freed texture. Texture ids
   *  are 0 when there is none; screen coordinates are -1 when off frame. Null
   *  for a name the chart does not know. */
  probeBody(name: string): {
    mode: 'globe' | 'dot' | 'sun';
    /** Which catalog the body came from, and for a moon which planet it rides. */
    kind: MapBodyKind;
    parentPlanet: string | null;
    /** Catalog figures, independent of how the body happens to be drawing. */
    trueRadiusAU: number;
    tint: number;
    radiusPx: number;
    /** Render truth: the globe's world radius re-measured against the CURRENT
     *  camera. Equal to radiusPx only while the pose that sized the body is the
     *  pose it is being drawn from; any drift is the body rendering at the
     *  wrong size. 0 when no globe is drawn. */
    apparentRadiusPx: number;
    screenX: number;
    screenY: number;
    /** Map position (AU) the chart places the body at this frame. */
    mapPos: [number, number, number];
    /** Body north pole as a unit vector in the map's (J2000 equatorial) frame. */
    pole: [number, number, number];
    textureId: number;
    worldTextureId: number;
    ringTextureId: number;
    worldRingTextureId: number;
  } | null {
    const body = mapBody(name);
    if (!body) return null;
    // Through the same projection the pick uses, so a probe reports the target
    // a click would actually land on.
    this.rebuildPickAnchors();
    const anchor = this.pickAnchors.find((a) => a.name === name);
    const screenX = anchor?.x ?? -1;
    const screenY = anchor?.y ?? -1;
    const pos = this.bodyMapPosition(name, this.tmpBodyPos);
    const mapPos: [number, number, number] = pos ? [pos.x, pos.y, pos.z] : [0, 0, 0];
    if (body.kind === 'sun') {
      return {
        mode: 'sun',
        kind: body.kind,
        parentPlanet: null,
        trueRadiusAU: body.radiusAU,
        tint: body.color,
        radiusPx: this.sunRadiusPx,
        apparentRadiusPx: 0,
        screenX,
        screenY,
        mapPos,
        pole: [0, 1, 0],
        textureId: 0,
        worldTextureId: 0,
        ringTextureId: 0,
        worldRingTextureId: 0,
      };
    }
    const entry = this.entryFor(name);
    if (!entry) {
      // A body the chart knows but draws nothing for yet: the catalog figures
      // and the position are real, and the marker the size policy would give it
      // is the footprint it would claim.
      return {
        mode: 'dot',
        kind: body.kind,
        parentPlanet: body.parentPlanet,
        trueRadiusAU: body.radiusAU,
        tint: body.color,
        radiusPx: mapMarkerRadiusPx(body.radiusAU, this.bodySizeParams),
        apparentRadiusPx: 0,
        screenX,
        screenY,
        mapPos,
        pole: [0, 1, 0],
        textureId: 0,
        worldTextureId: this.textures.colorMap(name)?.id ?? 0,
        ringTextureId: 0,
        worldRingTextureId: 0,
      };
    }
    const h = Math.max(this.renderer.domElement.clientHeight, 1);
    const worldPerPx = ((2 * Math.tan((MAP_FOV_DEG * Math.PI) / 180 / 2)) / h)
      * this.viewDepth(entry.globe.position);
    this.tmpVec3.set(0, 1, 0).applyQuaternion(entry.globe.quaternion);
    return {
      mode: entry.globeDrawn ? 'globe' : 'dot',
      kind: body.kind,
      parentPlanet: body.parentPlanet,
      trueRadiusAU: body.radiusAU,
      tint: body.color,
      radiusPx: entry.drawnRadiusPx,
      apparentRadiusPx: entry.globeDrawn ? entry.globe.scale.x / Math.max(worldPerPx, 1e-30) : 0,
      screenX,
      screenY,
      mapPos,
      pole: [this.tmpVec3.x, this.tmpVec3.y, this.tmpVec3.z],
      textureId: entry.globeMat.map?.id ?? 0,
      worldTextureId: this.textures.colorMap(name)?.id ?? 0,
      ringTextureId: entry.ringMat?.map?.id ?? 0,
      worldRingTextureId: this.textures.ringMap(name)?.id ?? 0,
    };
  }

  /** Dev forensics: the ship marker's screen rotation (radians, CCW, 0 while
   *  docked) and which marker is drawn. The chevron is the one projection-fed
   *  thing on the map that pixels can't isolate — it sits inside the same
   *  sprite as the docked ring, so a photometric read of the marker measures
   *  the art, not the angle. Reading it here is the only way to check the
   *  rotation belongs to the camera pose the frame was drawn from. */
  shipMarkerState(): { rotationRad: number; docked: boolean } {
    return { rotationRad: this.shipMarker.material.rotation, docked: this.shipDocked };
  }

  // ---- internals -------------------------------------------------------

  private resample(utcMs: number): void {
    this.epochUtcMs = utcMs;
    this.sampled = true;
    for (const entry of this.orbits) {
      const pts = sampleTrajectoryLinePoints(entry.planet, utcMs, ORBIT_SEGMENTS);
      for (let i = 0; i <= ORBIT_SEGMENTS; i++) {
        const p = pts[i];
        entry.raw[i * 3] = p.x;
        entry.raw[i * 3 + 1] = p.y;
        entry.raw[i * 3 + 2] = p.z;
      }
      entry.lastVertex = -1;
    }
    this.recompressOrbits();
  }

  private recompressOrbits(): void {
    for (const entry of this.orbits) {
      let maxR = 0;
      for (let i = 0; i <= ORBIT_SEGMENTS; i++) {
        projectMapPoint(
          entry.raw[i * 3],
          entry.raw[i * 3 + 1],
          entry.raw[i * 3 + 2],
          this.blend,
          this.curve,
          this.tmpMap,
        );
        entry.map[i * 3] = this.tmpMap.x;
        entry.map[i * 3 + 1] = this.tmpMap.y;
        entry.map[i * 3 + 2] = this.tmpMap.z;
        // Projected radius = |compressed point|; the aphelion sample
        // sets this orbit's reach, so an eccentric orbit (Pluto) isn't clipped
        // by a semi-major-axis extent.
        const r = Math.hypot(this.tmpMap.x, this.tmpMap.y, this.tmpMap.z);
        if (r > maxR) maxR = r;
      }
      entry.maxMapRadius = maxR;
      this.writePositions(entry);
    }
  }

  // Line2 layout: LineGeometry packs the (N+1)-point polyline into an
  // interleaved instance buffer of N segments, each holding the pair
  // [start.xyz, end.xyz] at stride 6 (see LineSegmentsGeometry.setPositions).
  // setPositions/setColors reallocate that buffer and its attributes every
  // call; on the scale animation and per-frame colour rebuilds that churns, so
  // after the one-time build we mutate the existing arrays in place.

  /** Pack entry.map (contiguous xyz per point) into the interleaved segment
   *  buffer: point k is the start of segment k and the end of segment k-1. */
  private writePositions(entry: OrbitEntry): void {
    const attr = entry.geometry.attributes.instanceStart as THREE.InterleavedBufferAttribute;
    const arr = attr.data.array as Float32Array;
    const map = entry.map;
    for (let seg = 0; seg < ORBIT_SEGMENTS; seg++) {
      const a = seg * 3;
      const b = a + 3;
      const o = seg * 6;
      arr[o] = map[a];
      arr[o + 1] = map[a + 1];
      arr[o + 2] = map[a + 2];
      arr[o + 3] = map[b];
      arr[o + 4] = map[b + 1];
      arr[o + 5] = map[b + 2];
    }
    // instanceStart and instanceEnd share this one interleaved buffer.
    attr.data.needsUpdate = true;
  }

  /** Pack entry.colors (contiguous rgb per point) into the interleaved segment
   *  colour buffer with the same start/end pairing as writePositions. */
  private writeColors(entry: OrbitEntry): void {
    const attr = entry.geometry.attributes.instanceColorStart as THREE.InterleavedBufferAttribute;
    const arr = attr.data.array as Float32Array;
    const colors = entry.colors;
    for (let seg = 0; seg < ORBIT_SEGMENTS; seg++) {
      const a = seg * 3;
      const b = a + 3;
      const o = seg * 6;
      arr[o] = colors[a];
      arr[o + 1] = colors[a + 1];
      arr[o + 2] = colors[a + 2];
      arr[o + 3] = colors[b];
      arr[o + 4] = colors[b + 1];
      arr[o + 5] = colors[b + 2];
    }
    attr.data.needsUpdate = true;
  }

  /** Adopt whatever colour map the world carries for each body right now. The
   *  map borrows; it never disposes and never holds a reference across a swap. */
  private syncTextures(): void {
    for (const entry of this.orbits) {
      this.adoptTexture(entry.globeMat, this.textures.colorMap(entry.planet.name));
      if (entry.ringMat) {
        this.adoptTexture(entry.ringMat, this.textures.ringMap(entry.planet.name));
      }
    }
  }

  private adoptTexture(mat: THREE.MeshStandardMaterial, world: THREE.Texture | null): void {
    if (!shouldAdoptTexture(mat.map, world)) return;
    mat.map = world;
    // Gaining or losing a map changes the program, not just a uniform.
    mat.needsUpdate = true;
  }

  /** Position each planet dot (and its globe) on the exact ephemeris — never
   *  the sampled chord — compressed through the live blend, and refresh the
   *  direction fade only when the body crosses a sampled vertex. */
  private updateBodies(utcMs: number): void {
    // Spin the globes on the map's own clock through the seam the world turns
    // on, so Uranus lies on its side and the right face of Earth is in daylight
    // at a given UTC. Every body is kept posed at both scales — a focused
    // camera resolves a true-scale globe too — and skipped only while the clock
    // is not moving, which is the normal state for reading a chart: each
    // group's own quaternion IS the cache, and it stays correct for as long as
    // the instant it was built for stands.
    const reorient = utcMs !== this.orientedUtcMs;
    const jd = reorient ? ttJDFromUtcMs(utcMs) : 0;
    for (const entry of this.orbits) {
      // The truth seam: the same heliocentric AU the world draws, projected
      // through the map compression. computeBodyPositionAU returns a fresh
      // vector (the astronomy layer's own allocation, as the world uses it);
      // its components are copied straight into the map scratch, so the map
      // adds no per-frame allocation of its own.
      const helio = computeBodyPositionAU(entry.planet, utcMs);
      entry.helioX = helio.x;
      entry.helioY = helio.y;
      entry.helioZ = helio.z;
      projectMapPoint(helio.x, helio.y, helio.z, this.blend, this.curve, this.tmpMap);
      entry.dot.position.set(this.tmpMap.x, this.tmpMap.y, this.tmpMap.z);
      entry.globe.position.copy(entry.dot.position);
      if (reorient) {
        entry.globe.quaternion.copy(computeBodyOrientationQuaternion(entry.planet, jd));
      }
      // The fade still keys off the sampled loop — cheap and only rebuilt on a
      // vertex crossing.
      const frac = this.bodyFraction(entry, utcMs);
      const i0 = Math.floor(frac * ORBIT_SEGMENTS);
      if (i0 !== entry.lastVertex) {
        entry.lastVertex = i0;
        this.rebuildOrbitColors(entry, frac);
      }
    }
    if (reorient) this.orientedUtcMs = utcMs;
  }

  /** Fractional position [0,1) of the body along its sampled loop at `utcMs`. */
  private bodyFraction(entry: OrbitEntry, utcMs: number): number {
    return trajectoryLineBodyFraction(entry.planet, this.epochUtcMs, utcMs);
  }

  private rebuildOrbitColors(entry: OrbitEntry, bodyFrac: number): void {
    // Working (linear) channels, cached at build — matches the sprite material.
    const r = entry.colorR;
    const g = entry.colorG;
    const b = entry.colorB;
    for (let i = 0; i <= ORBIT_SEGMENTS; i++) {
      // Forward arc distance from the body to this vertex, [0,1): 0 = right
      // ahead of the body (full tint), ~1 = just behind (darkest).
      let d = i / ORBIT_SEGMENTS - bodyFrac;
      d -= Math.floor(d);
      const bright = ORBIT_BRIGHT_FLOOR + (1 - ORBIT_BRIGHT_FLOOR) * (1 - d);
      entry.colors[i * 3] = r * bright;
      entry.colors[i * 3 + 1] = g * bright;
      entry.colors[i * 3 + 2] = b * bright;
    }
    this.writeColors(entry);
  }

  /** Project the last ship snapshot through the live curve and blend. Split out
   *  so a curve change can re-place the marker in the same call that re-fits —
   *  the ship is part of the extent, so a stale marker would fit the wrong
   *  frame. */
  private positionShipMarker(): void {
    projectMapPoint(this.shipRawX, this.shipRawY, this.shipRawZ, this.blend, this.curve, this.tmpMap);
    this.shipMarker.position.set(this.tmpMap.x, this.tmpMap.y, this.tmpMap.z);
  }

  /** Phase (1): place the ship marker in map space, pick docked/moving texture,
   *  and breathe the un-docked chevron. No projection — the camera hasn't been
   *  flushed for this frame yet; the heading rotation waits for orientShip. */
  private placeShip(
    x: number,
    y: number,
    z: number,
    heading: number,
    pitch: number,
    moving: boolean,
    landed: boolean,
    dtMs: number,
  ): void {
    this.shipRawX = x;
    this.shipRawY = y;
    this.shipRawZ = z;
    this.shipHeading = heading;
    this.shipPitch = pitch;
    this.shipSnapshot = true;
    this.positionShipMarker();
    const docked = landed || !moving;
    this.shipDocked = docked;
    const mat = this.shipMarker.material;
    const wantTex = docked ? this.shipRingTex : this.shipChevronTex;
    if (mat.map !== wantTex) {
      mat.map = wantTex;
      mat.needsUpdate = true;
    }
    // A subtle 2 s pulse marks the live ship while it coasts; the docked ring
    // holds steady so a parked ship reads settled.
    this.pulseMs += dtMs;
    if (docked) {
      mat.opacity = 1;
    } else {
      const s = Math.sin((this.pulseMs / SHIP_PULSE_MS) * Math.PI * 2);
      mat.opacity = 0.875 + 0.125 * s;
    }
  }

  /** Phase (3): rotate the chevron to the ship's on-screen velocity. Reads the
   *  camera, so it must run after the controls/matrix flush — and reads only the
   *  snapshot placeShip stored, so a camera moved outside the update pass can
   *  replay it. Docked marker keeps the neutral rotation placeShip left it
   *  with. */
  private orientShip(): void {
    const mat = this.shipMarker.material;
    if (this.shipDocked) {
      mat.rotation = 0;
      return;
    }
    const x = this.shipRawX;
    const y = this.shipRawY;
    const z = this.shipRawZ;
    // Project the ship and a point one step along its heading, both through the
    // map compression, and take the screen-space delta.
    const cp = Math.cos(this.shipPitch);
    const step = Math.max(0.002, Math.hypot(x, y, z) * 0.04);
    projectMapPoint(
      x + Math.cos(this.shipHeading) * cp * step,
      y + Math.sin(this.shipPitch) * step,
      z + Math.sin(this.shipHeading) * cp * step,
      this.blend,
      this.curve,
      this.tmpMap2,
    );
    const w = this.renderer.domElement.clientWidth;
    const h = this.renderer.domElement.clientHeight;
    projectToScreen(this.shipMarker.position, this.camera, w, h, this.tmpProj);
    projectToScreen(this.tmpMap2, this.camera, w, h, this.tmpProj2);
    const dx = this.tmpProj2.x - this.tmpProj.x;
    const dy = this.tmpProj2.y - this.tmpProj.y;
    // Chevron texture points up; screen y is down. Angle from screen-up,
    // negated for the sprite's CCW rotation.
    mat.rotation = -Math.atan2(dx, -dy);
  }

  private recomputeExtent(): void {
    let max = 0;
    // Each orbit's drawn reach is its aphelion sample, not its semi-major axis
    // (maxMapRadius, refreshed with recompressOrbits), so an eccentric orbit
    // drawn at true scale never overflows the fit.
    for (const entry of this.orbits) {
      if (entry.maxMapRadius > max) max = entry.maxMapRadius;
    }
    // The ship is just another radius — a probe past Pluto widens the frame.
    const shipR = this.shipMarker.position.length();
    if (shipR > max) max = shipR;
    this.extentAU = Math.max(max, 1e-3);
  }

  private applyBounds(cameraDist: number): void {
    this.controls.minDistance = this.extentAU * 0.12;
    this.controls.maxDistance = fitDistanceAU(this.extentAU, MAP_FOV_DEG, this.camera.aspect) * 1.8;
    this.camera.near = Math.max(this.extentAU * MAP_OVERVIEW_NEAR_FRAC, 1e-4);
    this.camera.far = cameraDist + this.extentAU * 2 + 10;
    this.camera.updateProjectionMatrix();
  }

  /**
   * How big everything draws, and — for a body — whether that drawing is a
   * globe or a dot. Markers get `px * (world-per-px at the sprite's camera
   * distance)`; a globe gets the size policy's radius, which is the legibility
   * floor at the overview and the body's true size once the camera is close
   * enough to resolve it. One shared camera factor drives both.
   */
  private updateDrawnSizes(): void {
    const h = Math.max(this.renderer.domElement.clientHeight, 1);
    const worldPerPxAtUnit = (2 * Math.tan((MAP_FOV_DEG * Math.PI) / 180 / 2)) / h;

    // The Sun is always its billboard — a star has no terminator to draw. The
    // policy answers in map AU; the px it works out to is the hit target.
    const sunDepth = this.viewDepth(this.sun.position);
    const sunAU = mapBodyRadiusAU(SUN_DATA.radiusAU, sunDepth, worldPerPxAtUnit, this.bodySizeParams);
    this.sunRadiusPx = sunAU / Math.max(worldPerPxAtUnit * sunDepth, 1e-30);
    const sunBoost = this.hoveredName === 'Sun' ? HOVER_SCALE : 1;
    this.sun.scale.setScalar(2 * sunAU * sunBoost);
    this.sunHalo.scale.setScalar(2 * sunAU * SUN_HALO_RADII);

    const trueScaleTarget = this.isTrueScale();
    for (const entry of this.orbits) {
      const depth = this.viewDepth(entry.dot.position);
      const drawnAU = mapBodyRadiusAU(
        entry.planet.radiusAU,
        depth,
        worldPerPxAtUnit,
        this.bodySizeParams,
      );
      const worldPerPx = Math.max(worldPerPxAtUnit * depth, 1e-30);
      entry.drawnRadiusPx = drawnAU / worldPerPx;
      // At true scale the globe is what draws from the moment the body's REAL
      // disc overtakes the marker the chart would have drawn instead — the same
      // crossover the size policy already hands the drawn radius over at, so
      // the swap costs nothing in size and nothing pops.
      const globe = mapBodyDrawMode(
        entry.globeMat.map !== null,
        trueScaleTarget,
        entry.planet.radiusAU / worldPerPx,
        mapMarkerRadiusPx(entry.planet.radiusAU, this.bodySizeParams),
      ) === 'globe';
      entry.globeDrawn = globe;
      entry.globe.visible = globe;
      entry.dot.visible = !globe;
      if (globe) {
        // One scale on the group carries the sphere and, where there is one,
        // the ring — which is built in planet radii for exactly this reason.
        entry.globe.scale.setScalar(drawnAU);
      } else {
        const boost = entry.planet.name === this.hoveredName ? HOVER_SCALE : 1;
        this.applyMarkerScale(entry.dot, PLANET_PX * boost, worldPerPxAtUnit);
      }
    }
    this.applyMarkerScale(this.shipMarker, SHIP_PX, worldPerPxAtUnit);
  }

  /** Camera-space depth (distance along the view axis) of a map position.
   *  Perspective screen size follows this, not the Euclidean distance — the
   *  latter runs an off-axis marker ~10% oversized. */
  private viewDepth(position: THREE.Vector3): number {
    this.tmpView.copy(position).applyMatrix4(this.camera.matrixWorldInverse);
    return Math.max(-this.tmpView.z, 1e-6);
  }

  private applyMarkerScale(sprite: THREE.Sprite, px: number, worldPerPxAtUnit: number): void {
    // worldPerPxAtUnit is the world span of one px at unit depth.
    sprite.scale.setScalar(px * worldPerPxAtUnit * this.viewDepth(sprite.position));
  }

  private renderLabels(): void {
    if (!this.labelContainer) return;
    const w = this.renderer.domElement.clientWidth;
    const h = this.renderer.domElement.clientHeight;
    // Priority order: the Sun first, then the planets inner→outer (catalog
    // order). A label too close to one already placed this frame yields, so the
    // Sun and the inner planets win over their crowded neighbours at true scale.
    this.labelPlacer.begin();
    this.placeLabel(SUN_DATA.name, this.sun.position, w, h);
    for (const entry of this.orbits) {
      this.placeLabel(entry.planet.name, entry.dot.position, w, h);
    }
  }

  /** Place one body's label, keyed by its catalog name — never by an index into
   *  a catalog, which is only ever right for as long as one catalog is the
   *  whole of what the chart draws. A body with no label built is skipped. */
  private placeLabel(name: string, worldPos: THREE.Vector3, w: number, h: number): void {
    const label = this.labels.get(name);
    if (!label) return;
    projectToScreen(worldPos, this.camera, w, h, this.tmpProj);
    const onScreen =
      this.tmpProj.ndcZ < 1 &&
      this.tmpProj.x > -40 &&
      this.tmpProj.x < w + 40 &&
      this.tmpProj.y > -20 &&
      this.tmpProj.y < h + 20;
    if (!onScreen) {
      if (label.style.display !== 'none') label.style.display = 'none';
      return;
    }
    // Proximity cull: hide if the anchor lands too close to an already-placed
    // (higher-priority) label this frame.
    const x = this.tmpProj.x;
    const y = this.tmpProj.y;
    if (!this.labelPlacer.place(x, y)) {
      if (label.style.display !== 'none') label.style.display = 'none';
      return;
    }
    if (label.style.display === 'none') label.style.display = '';
    label.style.transform = `translate(-50%, 0) translate(${x}px, ${y + 9}px)`;
  }

  private ensureLabelContainer(): void {
    if (this.labelContainer) return;
    this.labelContainer = document.getElementById('map-labels');
    if (!this.labelContainer) return;
    // One label per body the chart DRAWS — the Sun and the planets. A label is
    // a DOM node whether or not anything ever places it, so the set follows
    // what is drawn rather than the whole roster the pools are sized for.
    for (const body of MAP_BODIES) {
      if (body.kind === 'moon') continue;
      this.labels.set(body.name, this.makeLabel(body.name));
    }
  }

  private makeLabel(name: string): HTMLDivElement {
    const div = document.createElement('div');
    div.className = 'map-label';
    div.textContent = name === SUN_DATA.name ? SUN_DATA.name : bodyDisplayName(name);
    div.style.display = 'none';
    this.labelContainer?.appendChild(div);
    return div;
  }

  // ---- geometry / texture builders -------------------------------------

  private makeOrbit(planet: PlanetData, el: HTMLElement): OrbitEntry {
    const raw = new Float32Array((ORBIT_SEGMENTS + 1) * 3);
    const map = new Float32Array((ORBIT_SEGMENTS + 1) * 3);
    const colors = new Float32Array((ORBIT_SEGMENTS + 1) * 3);
    const geometry = new LineGeometry();
    geometry.setPositions(map);
    geometry.setColors(colors);
    // depthTest ON: the lit globes are opaque depth-writing meshes drawn in
    // the opaque pass, so a depth-free line (the dot-era default) would paint
    // straight across every disc afterwards. Tested, the line dies at the limb
    // and re-emerges past it — a body occludes its own orbit. No depth write:
    // the lines must never occlude each other or the sprites.
    const material = new LineMaterial({
      linewidth: 1.5,
      vertexColors: true,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
    });
    material.resolution.set(Math.max(el.clientWidth, 1), Math.max(el.clientHeight, 1));
    const line = new Line2(geometry, material);
    line.renderOrder = 1;
    line.frustumCulled = false;
    this.scene.add(line);
    const dot = this.makeGlowSprite(planet.color, 1);
    dot.renderOrder = 5;
    this.scene.add(dot);
    const { globe, globeMat, ringMat, ringOuterFactor } = this.makeGlobe(planet);
    this.scene.add(globe);
    // Catalog hex is sRGB; THREE.Color(hex) converts it into the renderer's
    // working (linear) space, so the vertex-coloured line matches the sprite's
    // managed material.color instead of rendering hot.
    const tint = new THREE.Color(planet.color);
    return {
      planet,
      raw,
      map,
      colors,
      geometry,
      material,
      line,
      dot,
      lastVertex: -1,
      maxMapRadius: 0,
      colorR: tint.r,
      colorG: tint.g,
      colorB: tint.b,
      helioX: 0,
      helioY: 0,
      helioZ: 0,
      baseColor: tint.clone(),
      globe,
      globeMat,
      ringMat,
      ringOuterFactor,
      drawnRadiusPx: 0,
      globeDrawn: false,
    };
  }

  /**
   * One body's map-local globe: a group holding the shared unit sphere, and for
   * Saturn the ring annulus in planet radii. The group carries the IAU
   * orientation, so the ring inherits the pole tilt the way the world's does —
   * and one scale on the group sizes both. Materials start with no map; the
   * pull-sync adopts the world's textures on the first update, and until then
   * the body draws as its dot.
   *
   * Only Saturn gets rings here. The other three ring systems are faint and
   * dark enough that at chart size they would be noise around the globe.
   */
  private makeGlobe(planet: PlanetData): {
    globe: THREE.Group;
    globeMat: THREE.MeshStandardMaterial;
    ringMat: THREE.MeshStandardMaterial | null;
    ringOuterFactor: number;
  } {
    const globe = new THREE.Group();
    globe.visible = false;
    const globeMat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.0 });
    const mesh = new THREE.Mesh(this.globeGeo, globeMat);
    mesh.renderOrder = 3;
    globe.add(mesh);

    let ringMat: THREE.MeshStandardMaterial | null = null;
    let ringOuterFactor = 1;
    const cfg = planet.name === 'Saturn' ? RING_CONFIGS[planet.name] : undefined;
    if (cfg) {
      const geo = new THREE.RingGeometry(cfg.innerFactor, cfg.outerFactor, 96, 1);
      // RingGeometry's UVs are cartesian; the strip texture is radial, so remap
      // u to run 0 at the inner edge and 1 at the outer.
      const pos = geo.attributes.position;
      const uv = geo.attributes.uv;
      for (let i = 0; i < pos.count; i++) {
        const r = Math.hypot(pos.getX(i), pos.getY(i));
        uv.setXY(i, (r - cfg.innerFactor) / (cfg.outerFactor - cfg.innerFactor), uv.getY(i));
      }
      // Lay the annulus in the body's equatorial plane (local XZ, pole = +Y).
      geo.rotateX(-Math.PI / 2);
      ringMat = new THREE.MeshStandardMaterial({
        transparent: true,
        side: THREE.DoubleSide,
        roughness: 0.8,
        metalness: 0,
        // A trace of self-glow, so the ring never disappears entirely in the
        // seasons where the Sun grazes its plane.
        emissive: new THREE.Color(0x1a1510),
        depthWrite: false,
      });
      const ring = new THREE.Mesh(geo, ringMat);
      // After the orbit lines (renderOrder 1, depth-tested but never
      // depth-writing), so the ring blends over any line in its footprint.
      ring.renderOrder = 2;
      globe.add(ring);
      ringOuterFactor = cfg.outerFactor;
    }
    return { globe, globeMat, ringMat, ringOuterFactor };
  }

  private makeGlowSprite(color: number, coreBoost: number): THREE.Sprite {
    const tex = this.makeGlowTexture(coreBoost);
    const mat = new THREE.SpriteMaterial({
      map: tex,
      color,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    return new THREE.Sprite(mat);
  }

  private makeGlowTexture(coreBoost: number): THREE.Texture {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    const core = Math.min(1, 0.55 * coreBoost);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(core, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.7, 'rgba(255,255,255,0.18)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    applyTextureDefaults(tex, 'color');
    return tex;
  }

  /** The solar disc: a limb-darkened billboard rather than a lit sphere, since
   *  a star is its own light. */
  private makeSunDiscSprite(): THREE.Sprite {
    const mat = new THREE.SpriteMaterial({
      map: this.makeSunDiscTexture(),
      color: SUN_DATA.color,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.renderOrder = 6;
    return sprite;
  }

  /** The halo around it. Baked, not bloomed: the map draws straight to the
   *  backbuffer with no composer, so nothing downstream would spread a bright
   *  core into a glow. */
  private makeSunHaloSprite(): THREE.Sprite {
    const mat = new THREE.SpriteMaterial({
      map: this.makeSunHaloTexture(),
      color: SUN_DATA.color,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.renderOrder = 4;
    return sprite;
  }

  private makeSunDiscTexture(): THREE.Texture {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(size, size);
    const data = img.data;
    const c = (size - 1) / 2;
    // Edge feather in texels — enough to antialias the limb at marker sizes
    // without softening it into a blob.
    const feather = 1.5 / c;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const t = Math.hypot(x - c, y - c) / c;
        const i = (y * size + x) * 4;
        if (t >= 1) {
          data[i + 3] = 0;
          continue;
        }
        // I/I0 = 1 - u(1 - mu), mu = cos of the emergent angle — the disc dims
        // toward the limb the way the real photosphere does.
        const mu = Math.sqrt(Math.max(0, 1 - t * t));
        const k = 1 - SUN_LIMB_DARKENING * (1 - mu);
        // Warmer toward the limb: the cooler light comes from higher up.
        data[i] = Math.round(255 * k);
        data[i + 1] = Math.round(255 * k * (0.99 - 0.17 * t));
        data[i + 2] = Math.round(255 * k * (0.95 - 0.42 * t));
        data[i + 3] = Math.round(255 * Math.min(1, (1 - t) / feather));
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    applyTextureDefaults(tex, 'color');
    return tex;
  }

  private makeSunHaloTexture(): THREE.Texture {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(size, size);
    const data = img.data;
    const c = (size - 1) / 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const t = Math.hypot(x - c, y - c) / c;
        const i = (y * size + x) * 4;
        // A tight bright skirt over a wide faint one, driven to nothing at the
        // sprite's edge so the billboard has no visible square.
        const a = t >= 1
          ? 0
          : (0.85 * Math.exp(-7 * t) + 0.3 * Math.exp(-2.2 * t)) * (1 - t * t);
        data[i] = 255;
        data[i + 1] = 240;
        data[i + 2] = 214;
        data[i + 3] = Math.round(255 * Math.min(1, a));
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    applyTextureDefaults(tex, 'color');
    return tex;
  }

  private makeChevronTexture(): THREE.Texture {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = 'rgba(255,255,255,0.98)';
    ctx.beginPath();
    // Chevron pointing up.
    ctx.moveTo(size / 2, size * 0.16);
    ctx.lineTo(size * 0.82, size * 0.84);
    ctx.lineTo(size / 2, size * 0.66);
    ctx.lineTo(size * 0.18, size * 0.84);
    ctx.closePath();
    ctx.fill();
    const tex = new THREE.CanvasTexture(canvas);
    applyTextureDefaults(tex, 'color');
    return tex;
  }

  private makeRingTexture(): THREE.Texture {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, size, size);
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.32, 0, Math.PI * 2);
    ctx.stroke();
    const tex = new THREE.CanvasTexture(canvas);
    applyTextureDefaults(tex, 'color');
    return tex;
  }
}
