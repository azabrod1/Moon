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
 * mapGlobes for the two rules). A body with no texture yet, and the whole map
 * at true scale, fall back to the schematic dot.
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
import { mapBodyRadiusAU, MAP_BODY_SIZE_DEFAULTS, type MapBodySizeParams } from './mapBodySize';
import { mapBodyDrawMode, shouldAdoptTexture } from './mapGlobes';
import {
  anchorOnScreen,
  pickRadiusFor,
  resolvePick,
  type PickAnchor,
  type PickResult,
} from './mapPicking';

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
const MAP_FOV_DEG = 50;
const BG_COLOR = 0x05070d;
// Screen sizes (px, full sprite extent) for the constant-size markers.
const PLANET_PX = 20;
const SHIP_PX = 26;
// Orbit line: full tint just ahead of the body fading to this floor behind it.
const ORBIT_BRIGHT_FLOOR = 0.1;
// A label whose anchor lands within this many screen px of an already-placed
// one hides this frame — the true-scale inner four otherwise stack.
const LABEL_MIN_SEP_PX = 26;
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
  private labels: HTMLDivElement[] = [];

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
  // (Sun + every planet + the ship) is filled in place and `pickAnchors` holds
  // references to the in-use slots, so hover/tap picking allocates nothing after
  // warm-up.
  private pickAnchorPool: PickAnchor[] = Array.from(
    { length: PLANETARIUM_BODIES.length + 2 },
    () => ({ name: '', x: 0, y: 0, pickable: false, discRadiusPx: 0 }),
  );
  private pickAnchors: PickAnchor[] = [];
  // The catalog name of the currently hovered dot (fine pointers), or null.
  private hoveredName: string | null = null;
  // Whether the ship reads docked (landed or parked) this frame — set in
  // placeShip, read by the pick pass to drop the ship anchor that would
  // otherwise sit on top of its parent's dot.
  private shipDocked = false;

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

  // Label anti-collision: screen positions already placed this frame (Sun +
  // the planets), scanned in priority order so an inner planet yields to the
  // Sun and outer planets yield to inner. Preallocated for Sun + 10 bodies.
  private placedX = new Float32Array(PLANETARIUM_BODIES.length + 1);
  private placedY = new Float32Array(PLANETARIUM_BODIES.length + 1);
  private placedCount = 0;

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

  /** Enter the map: (re)sample the orbits at the current clock. The first
   *  update() frames the whole system (ship included, positioned there). The
   *  caller owns the world's controls.enabled restore. */
  openMap(utcMs: number): void {
    this.open = true;
    this.ensureLabelContainer();
    this.resample(utcMs);
    this.controls.enabled = true;
    this.needsInitialFrame = true;
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
    this.setHover(null);
    this.controls.enabled = false;
    for (const label of this.labels) label.style.display = 'none';
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
    const fit = fitDistanceAU(this.extentAU, MAP_FOV_DEG, this.camera.aspect);
    this.scaleZoomRatio = this.getCameraDistance() / Math.max(fit, 1e-4);
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

    // ── (2) Camera: fit or re-clamp to the live extent (compression animating,
    // ship drifting), then flush the controls and matrices BEFORE any
    // projection. The renderer refreshes matrices only at render time, which
    // runs after this update, so a projection-dependent pass must force it.
    // A dive owns the camera outright (the mode drives setDivePose), so the fit
    // and controls stand down for its duration.
    if (!this.diving) {
      this.recomputeExtent();
      if (this.needsInitialFrame) {
        // First frame after open: bodies and ship are positioned, so the fit
        // includes a ship past Pluto.
        this.needsInitialFrame = false;
        this.frameToExtent();
      } else if (blendMoved) {
        // Re-dolly to preserve the framing captured at the toggle, so the
        // system holds its apparent size while its extent slides with the blend.
        const wantDist = this.scaleZoomRatio
          * fitDistanceAU(this.extentAU, MAP_FOV_DEG, this.camera.aspect);
        this.dollyTo(wantDist);
        this.applyBounds(wantDist);
        this.controls.update();
      } else {
        this.applyBounds(this.getCameraDistance());
        this.controls.update();
      }
    }
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
    // the camera — that fit is the frame the user was actually looking at.
    const wasAtOverview = this.open && this.sampled && !this.diving && !this.blendAnimating
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
    }
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
   *  reports. Reads the cached heliocentric position (no extra ephemeris call);
   *  the Sun sits at the origin. */
  trueDistanceFromShip(name: string, shipX: number, shipY: number, shipZ: number): number {
    let bx = 0;
    let by = 0;
    let bz = 0;
    if (name !== 'Sun') {
      const entry = this.orbits.find((o) => o.planet.name === name);
      if (!entry) return 0;
      bx = entry.helioX;
      by = entry.helioY;
      bz = entry.helioZ;
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
    const dot = this.spriteForName(this.diveFocusName);
    if (!dot) return null;
    return this.controls.target.distanceTo(dot.position);
  }

  /** Snapshot the camera and the target body's map position; from here the mode
   *  drives setDivePose each frame. Returns false if the body isn't on the map. */
  beginDive(name: string): boolean {
    const focus = this.spriteForName(name);
    if (!focus) return false;
    this.diveFocusName = name;
    this.diveFocus.copy(focus.position);
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
    const focus = this.diveFocusName ? this.spriteForName(this.diveFocusName) : null;
    if (focus) this.diveFocus.copy(focus.position);
    const f = Math.max(0, Math.min(1, frac));
    this.tmpVec3.copy(this.diveStartTarget).lerp(this.diveFocus, f);
    this.controls.target.copy(this.tmpVec3);
    const dist = this.diveStartDist * (1 - f * (1 - DIVE_END_DIST_FRAC));
    this.camera.position.copy(this.tmpVec3).addScaledVector(this.diveOffsetDir, dist);
    this.camera.lookAt(this.tmpVec3);
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
    if (!commit) {
      // The extent goes stale during a dive — the camera section stands down,
      // but the geometry underneath never stops (the scale animation runs to
      // its end, bodies keep moving), so a toggle started just before the dive
      // can leave the system many times larger than the frozen figure. Refresh
      // it before anything frames against it.
      this.recomputeExtent();
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
    const a = this.pickAnchorPool[this.pickAnchors.length];
    a.name = name;
    a.x = this.tmpProj.x;
    a.y = this.tmpProj.y;
    a.pickable = pickable;
    a.discRadiusPx = discRadiusPx;
    this.pickAnchors.push(a);
  }

  private spriteForName(name: string): THREE.Sprite | null {
    if (name === 'Sun') return this.sun;
    return this.orbits.find((o) => o.planet.name === name)?.dot ?? null;
  }

  private applyDotEmphasis(name: string | null, on: boolean): void {
    if (!name) return;
    const entry = name === 'Sun' ? undefined : this.orbits.find((o) => o.planet.name === name);
    const sprite = this.spriteForName(name);
    const base = name === 'Sun' ? this.sunBaseColor : entry?.baseColor;
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
    const idx = name === 'Sun' ? 0 : this.orbits.findIndex((o) => o.planet.name === name) + 1;
    const label = this.labels[idx];
    if (label) label.classList.toggle('hover', on);
  }

  /** Dev forensics: how one body is drawing right now, where its hit target
   *  sits, which way its pole points, and whether the texture it adopted is
   *  still the one the world holds — the check that a 2K→4K hot-swap under an
   *  open map was picked up rather than left on a freed texture. Texture ids
   *  are 0 when there is none; screen coordinates are -1 when off frame. */
  probeBody(name: string): {
    mode: 'globe' | 'dot' | 'sun';
    radiusPx: number;
    /** Render truth: the globe's world radius re-measured against the CURRENT
     *  camera. Equal to radiusPx only while the pose that sized the body is the
     *  pose it is being drawn from; any drift is the body rendering at the
     *  wrong size. 0 when no globe is drawn. */
    apparentRadiusPx: number;
    screenX: number;
    screenY: number;
    /** Body north pole as a unit vector in the map's (J2000 equatorial) frame. */
    pole: [number, number, number];
    textureId: number;
    worldTextureId: number;
    ringTextureId: number;
    worldRingTextureId: number;
  } | null {
    // Through the same projection the pick uses, so a probe reports the target
    // a click would actually land on.
    this.rebuildPickAnchors();
    const anchor = this.pickAnchors.find((a) => a.name === name);
    const screenX = anchor?.x ?? -1;
    const screenY = anchor?.y ?? -1;
    if (name === 'Sun') {
      return {
        mode: 'sun',
        radiusPx: this.sunRadiusPx,
        apparentRadiusPx: 0,
        screenX,
        screenY,
        pole: [0, 1, 0],
        textureId: 0,
        worldTextureId: 0,
        ringTextureId: 0,
        worldRingTextureId: 0,
      };
    }
    const entry = this.orbits.find((o) => o.planet.name === name);
    if (!entry) return null;
    const h = Math.max(this.renderer.domElement.clientHeight, 1);
    const worldPerPx = ((2 * Math.tan((MAP_FOV_DEG * Math.PI) / 180 / 2)) / h)
      * this.viewDepth(entry.globe.position);
    this.tmpVec3.set(0, 1, 0).applyQuaternion(entry.globe.quaternion);
    return {
      mode: entry.globeDrawn ? 'globe' : 'dot',
      radiusPx: entry.drawnRadiusPx,
      apparentRadiusPx: entry.globeDrawn ? entry.globe.scale.x / Math.max(worldPerPx, 1e-30) : 0,
      screenX,
      screenY,
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
    // at a given UTC. Skipped where no globe can draw — and skipped again while
    // the clock is not moving, which is the normal state for reading a chart:
    // each group's own quaternion IS the cache, and it stays correct for as
    // long as the instant it was built for stands.
    const orienting = !this.isTrueScale();
    const reorient = orienting && utcMs !== this.orientedUtcMs;
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
      if (orienting) {
        entry.globe.position.copy(entry.dot.position);
        if (reorient) {
          entry.globe.quaternion.copy(computeBodyOrientationQuaternion(entry.planet, jd));
        }
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
    this.camera.near = Math.max(this.extentAU * 1e-3, 1e-4);
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
      entry.drawnRadiusPx = drawnAU / Math.max(worldPerPxAtUnit * depth, 1e-30);
      const globe =
        mapBodyDrawMode(entry.globeMat.map !== null, trueScaleTarget) === 'globe';
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
    // Priority order: Sun (index 0) first, then the planets inner→outer (catalog
    // order). A label too close to one already placed this frame yields, so the
    // Sun and the inner planets win over their crowded neighbours at true scale.
    this.placedCount = 0;
    this.placeLabel(0, this.sun.position, w, h);
    for (let i = 0; i < this.orbits.length; i++) {
      this.placeLabel(i + 1, this.orbits[i].dot.position, w, h);
    }
  }

  private placeLabel(index: number, worldPos: THREE.Vector3, w: number, h: number): void {
    const label = this.labels[index];
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
    // Proximity cull: hide if the anchor lands within LABEL_MIN_SEP_PX of an
    // already-placed (higher-priority) label this frame.
    const x = this.tmpProj.x;
    const y = this.tmpProj.y;
    for (let i = 0; i < this.placedCount; i++) {
      const dx = x - this.placedX[i];
      const dy = y - this.placedY[i];
      if (dx * dx + dy * dy < LABEL_MIN_SEP_PX * LABEL_MIN_SEP_PX) {
        if (label.style.display !== 'none') label.style.display = 'none';
        return;
      }
    }
    this.placedX[this.placedCount] = x;
    this.placedY[this.placedCount] = y;
    this.placedCount++;
    if (label.style.display === 'none') label.style.display = '';
    label.style.transform = `translate(-50%, 0) translate(${x}px, ${y + 9}px)`;
  }

  private ensureLabelContainer(): void {
    if (this.labelContainer) return;
    this.labelContainer = document.getElementById('map-labels');
    if (!this.labelContainer) return;
    const names = ['Sun', ...PLANETARIUM_BODIES.map((b) => b.name)];
    for (const name of names) {
      const div = document.createElement('div');
      div.className = 'map-label';
      div.textContent = name === 'Sun' ? 'Sun' : bodyDisplayName(name);
      div.style.display = 'none';
      this.labelContainer.appendChild(div);
      this.labels.push(div);
    }
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
    const { globe, globeMat, ringMat } = this.makeGlobe(planet);
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
  } {
    const globe = new THREE.Group();
    globe.visible = false;
    const globeMat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.0 });
    const mesh = new THREE.Mesh(this.globeGeo, globeMat);
    mesh.renderOrder = 3;
    globe.add(mesh);

    let ringMat: THREE.MeshStandardMaterial | null = null;
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
    }
    return { globe, globeMat, ringMat };
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
