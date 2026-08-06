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
 *
 * At the overview the zoom rides the cursor, and the pivot the controls measure
 * that zoom against is re-seated by this class onto the nearest drawn surface
 * ahead of the camera, immediately before and after every wheel notch and pinch
 * move. A cursor dolly spends a fraction of its pivot radius per event, so a
 * pivot left on the Sun would run out of budget at the opening frame's target
 * plane and leave every outer system unreachable; re-seating it keeps the
 * radius meaning "how far the stuff ahead of me is". Once it has moved, the
 * target no longer sits on the origin, which has three declared consequences:
 * the scale toggle preserves its framing ratio against that floating pivot and
 * so re-frames oddly from a deep zoom (zooming out, the Overview chip or a
 * focus all recover it); the resize refit and the dive's "was at the fit" test
 * read a pivot-relative radius, so they simply decline to re-frame a camera
 * that has zoomed away; and the closest approach the shell allows sits at the
 * near plane's own floor, so the last notch of a full zoom-in clips the near
 * limb of whatever it is closing on — the moon-reveal shells this zoom exists
 * to reach are an order of magnitude further out than that.
 */
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PLANETARIUM_BODIES, SUN_DATA, type PlanetData } from '../planets/planetData';
import { getMoonsByPlanet, type MoonData } from '../planets/moonData';
import { RING_CONFIGS } from '../planets/rings';
import {
  sampleTrajectoryLinePoints,
  computeBodyOrientationQuaternion,
  computeBodyPositionAU,
  trajectoryLineBodyFraction,
  ttJDFromUtcMs,
} from '../../astronomy/planetary';
import {
  computeMoonOffsetEquatorialAU,
  getMoonDisplayOrbit,
  getSatelliteOrbitMeta,
  EARTH_MOON_ORBIT_META,
} from '../../astronomy/satellites';
import { tidalLockQuaternion, tidalRollNorth } from '../world/tidalLock';
import { bodyDisplayName } from '../surfaceView';
import { ORBIT_LINE_RESAMPLE_MAX_AGE_MS } from '../SolarSystem';
import { ResampleSweep, ringRefillDue } from './mapResample';
import { applyTextureDefaults } from '../world/texturePolicy';
import { projectToScreen, type ScreenProjection } from '../../shared/three/projectToScreen';
import {
  defaultMapCurve,
  diveRestoreDistanceAU,
  fitDistanceAU,
  isAtOverviewFit,
  mapRadius,
  remapRadius,
  projectMapPoint,
  sanitizeMapCurve,
  MAP_BLEND_TRUE,
  type MapCurve,
  type MapVec3,
} from './mapProjection';
import {
  blendAdvance,
  blendIsTrueScale,
  blendParkCompressed,
  blendReconcile,
  blendRequestScale,
  blendSettle,
  blendUnpark,
  makeMapBlendState,
} from './mapBlend';
import { shipHeadingRotationRad } from './mapShipHeading';
import {
  chartShipPoint,
  shipAnchorWeight,
  shipEnvelopeWeight,
  shipHeadingProbeStepAU,
  shipViewWeight,
  type ShipAnchorFrame,
  type ShipAnchorSystem,
} from './mapShipAnchor';
import type { LandedTarget } from '../PlanetariumStore';
import {
  makeMiniBodyKey,
  miniBodiesStale,
  miniNeedsReseat,
  stampMiniBodyKey,
  MINI_BODY_SIZE_PARAMS,
  MINI_SHIP_PX,
  MINI_SUN_HALO_RADII,
  type MiniBodyKey,
  type MiniDrawRect,
} from './miniChart';
import {
  labelClearanceRadiusPx,
  mapBodyRadiusAU,
  mapMarkerRadiusPx,
  mapMoonMarkerRadiusAU,
  mapMoonRadiusAU,
  DOT_EXTENT_MUL,
  dotGradientAlpha,
  MAP_BODY_SIZE_DEFAULTS,
  type MapBodySizeParams,
} from './mapBodySize';
import {
  augmentMapGlobeMaterial,
  makeMapSunUniforms,
  mapTerminatorSoftness,
  type MapGlobeShading,
  type MapSunUniforms,
} from './mapGlobeShading';
import {
  mapMoonOffsetR,
  moonOffsetEntries,
  moonOffsetPolicyFor,
  setMapMoonOffsetParams,
  setMapRingOuterFactors,
  type MapMoonOffsetParams,
  type MoonOffsetPolicy,
} from './mapMoonOffset';
import { mapBodyDrawMode, shouldAdoptTexture } from './mapGlobes';
import {
  advanceMapShade,
  makeMapShadeState,
  resetMapShade,
  type MapShadeState,
} from './mapShade';
import { computeMoonShading, type MoonShadingState } from '../../astronomy/shadows';
import {
  clampFollowDistanceAU,
  followBounds,
  mapCameraInitialState,
  mapCameraReduce,
  mapDiveEndFraction,
  mapFlightFramingDistanceAU,
  mapFocusEase,
  mapFocusLandPulse,
  mapHemisphereFlipped,
  mapOverviewBounds,
  mapPolarBand,
  mapOverviewPivotDistanceAU,
  mapWorldPerPxAtUnitDepth,
  mapZoomAvailability,
  mapZoomNotchAvailable,
  mapZoomNotchDistanceAU,
  MAP_FOLLOW_MIN_SPREAD,
  revealDistanceAU,
  moonRevealThresholdAU,
  MAP_FOCUS_FLY_MS,
  MAP_FOCUS_PULSE_MS,
  MAP_FOV_DEG,
  type MapCameraBounds,
  type MapCameraState,
  type MapFollowBounds,
  type MapHemisphere,
  type MapPolarBand,
  type MapZoomAvailability,
} from './mapCamera';
import {
  makeMapFlipState,
  mapFlipAdvance,
  mapFlipBegin,
  mapFlipOffset,
  mapFlipReverse,
  mapFlipSettle,
} from './mapFlip';
import { flushOrbitDamping } from '../input/orbitDamping';
import {
  anchorOnScreen,
  pickRadiusFor,
  resolvePick,
  type PickAnchor,
  type PickResult,
} from './mapPicking';
import { HOVER_HIT_FLOOR_PX } from './mapHover';
import {
  markerBehindDisc,
  markerInFrontOfDisc,
  markerSeparationPx,
} from './mapOcclusion';
import {
  mapBody,
  mapBodyAcceptsCamera,
  MAP_BODIES,
  MAP_LABEL_CAPACITY,
  MAP_PICK_ANCHOR_CAPACITY,
  type MapBodyKind,
} from './mapBodies';
import {
  clampLabelCenterXPx,
  labelMaxBoxTopPx,
  labelWorthDrawing,
  mapLabelOffsetPx,
  MapLabelPlacer,
  ringClearedLabelShiftPx,
  LABEL_EDGE_PAD_PX,
  LABEL_LINE_HEIGHT_PX,
  LABEL_NOMINAL_HALF_WIDTH_PX,
} from './mapLabels';
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
// Screen size (px, full sprite extent) for the ship marker — the one marker on
// the chart with no body behind it, so no size policy to follow.
const SHIP_PX = 26;
// The ship's ember. It is the one marker with no catalog row behind it, so the
// tint lives here — once, for the marker.
const SHIP_MARKER_COLOR = 0xffb88a;
// Orbit line: full tint just ahead of the body fading to this floor behind it.
const ORBIT_BRIGHT_FLOOR = 0.1;
// What the followed body's own line fades to while the camera rides it. Faint
// enough to stop being the brightest thing in a focused frame, present enough
// that the body is still visibly ON its orbit rather than adrift.
const FOCUS_ORBIT_DIM = 0.3;
// Un-docked ship chevron breathes over this period (ms).
const SHIP_PULSE_MS = 2000;
// Hover feedback: the pointed-at dot swells and lifts toward white.
const HOVER_SCALE = 1.3;
const HOVER_LIFT = 0.4;
const WHITE = new THREE.Color(1, 1, 1);
const maxChannel = (c: THREE.Color): number => Math.max(c.r, c.g, c.b);
// A hovered globe lifts by its own tint instead of swelling: a growing sphere
// would move its footprint, and the footprint is the click target.
const GLOBE_HOVER_EMISSIVE = 0.22;
// The dive eases the camera in to this fraction of its start distance.
const DIVE_END_DIST_FRAC = 0.14;

// Draw order for the depth-free markers, and the layer one is lifted to for the
// frames it stands in front of the Sun. Every marker on the chart writes no
// depth, so among themselves the paint order is the whole of the answer: at
// rest a dot draws under the solar disc (6), which is right for the far side of
// the star and wrong for the near one. The lift is per frame and per body,
// decided by the same gate that culls the far side — a static reshuffle would
// paint every dot over a star they are mostly behind.
const MARKER_RENDER_ORDER = 5;
const MARKER_OVER_SUN_RENDER_ORDER = 7;
// The resting ladder under those markers: spheres, then orbit lines, then
// Saturn's annulus, then the Sun's halo (4) — every rung its own number, so
// no pair ever falls back to the transparent pass's depth tie-break. The
// spheres are transparent-at-full-opacity — same pixels, but drawn from the
// sprites' own pass, so that when the size policy floors one the marker
// orders above can compose it exactly like the dot it replaces (a floored
// sphere is the marker's footprint worn as a face: marker px × world-per-px
// runs ~0.4 AU for Mercury at the true-scale overview, so its depth is a lie
// the Sun's depth-tested disc must never read, and the opaque pass — which
// runs before every sprite — could never lift it over the disc). The flag is
// constant because the shader's identity must be: the two drawing passes may
// disagree about flooring every frame, and a per-pass transparent flip would
// be a program rebuild per pass per frame. A true-sized sphere keeps real
// depth at its resting order, which is why the lines and the annulus draw
// after it: both depth-test, so an orbit line still dies at the limb and
// crosses the face, and the annulus loses its far half behind the sphere —
// the same pixels the old opaque arrangement drew. Floored, the sphere takes
// the marker orders and the annulus rides half a step under its own sphere
// (4.5 under 5, 6.5 under 7): still above the halo, under the dots, and over
// the disc exactly when its sphere is. The half step is deliberate — a whole
// step down would land the ring back on the halo's rung.
const GLOBE_RENDER_ORDER = 1;
const ORBIT_LINE_RENDER_ORDER = 2;
const GLOBE_RING_RENDER_ORDER = 3;

// ---- moon systems ------------------------------------------------------
// Samples per drawn moon orbit. The ring is a closed loop of the moon's own
// trajectory, so this is the smoothness of an ellipse, not of a circle.
const MOON_RING_SEGMENTS = 96;
// How far a drawn orbit may rotate under the sky before it is resampled. The
// moon's motion ALONG the ring never stales it — the marker is computed exactly
// every frame regardless, and the ring is the orbit's SHAPE. What stales the
// shape is secular drift: the node and the apsides turning.
const MOON_RING_DRIFT_LIMIT_DEG = 1;
// Where a moon's elements carry no secular rates at all, a generous sim-time
// bound stands in, so a ring still refreshes eventually.
const MOON_RING_MAX_AGE_DAYS = 3650;
// Floor on the WALL time between refills of one ring. The drift limit above is
// a sim-time budget, and a warped clock spends it faster than a frame lasts:
// past about a day of sim time per frame every revealed ring is permanently
// overdue, the staleness saturates, and one ring's worth of ephemeris plus a
// buffer upload becomes a fixed per-frame cost that never ends — which is the
// stutter the whole one-ring-per-frame budget exists to avoid, arriving by the
// back door. A refill is amortization, not truth: the moons themselves are
// placed exactly every frame either way, and only the drawn SHAPE of an orbit
// waits. So a filled ring redraws at most once a second and wears whatever
// drift accrues in between. First fills are exempt — an unfilled ring is a
// missing orbit, not a stale one, and those still go one per frame.
const MOON_RING_MIN_REFILL_MS = 1000;
// A system's moons appear inside this multiple of the distance a focus on the
// parent lands at — derived from the same clamped landing the flight itself
// uses, so focusing a planet always reveals its moons.
const MOON_REVEAL_MARGIN = 1.3;
// At true scale a moon whose screen separation from the parent's drawn limb is
// under this is inside the limb pixel: drawing it there is noise, not honesty.
const MOON_TRUE_SCALE_MIN_SEP_PX = 2;
// Drawn orbits sit quieter than the planets' heliocentric lines: they are
// dense, and the bodies are the subject.
const MOON_RING_OPACITY = 0.5;

// The chart's ring annulus tint — see the material for what it is measured
// against.
const RING_TINT = 0xd8b98c;

/** One moon on the chart: a marker, a globe, and its drawn orbit. */
interface MoonEntry {
  data: MoonData;
  dot: THREE.Sprite;
  globe: THREE.Mesh;
  globeMat: THREE.MeshStandardMaterial;
  /** The softened-terminator handle on that material — one float, written from
   *  the drawn size every frame the moon is a globe. */
  globeShading: MapGlobeShading;
  baseColor: THREE.Color;
  /** Live map position (absolute, like every other body's). */
  pos: THREE.Vector3;
  /** Unit direction from the parent, and the instantaneous distance in parent
   *  TRUE radii — the policy's input. */
  dir: THREE.Vector3;
  x: number;
  trueDistAU: number;
  /** Where the policy charts it, in parent drawn radii. */
  offsetR: number;
  drawnRadiusAU: number;
  drawnRadiusPx: number;
  globeDrawn: boolean;
  visible: boolean;
  /** Whether the marker is hidden behind a drawn disc this frame — its own
   *  state, deliberately not folded into `visible`. `visible` says the chart is
   *  drawing this moon, which is what the camera clearance and the zoom pivot
   *  ask; this says a body stands in front of it, so none of its symbol, its
   *  name or its hit target may be painted. The two occluders are latched apart
   *  so each one's hysteresis band is its own. */
  occluded: boolean;
  occludedByParent: boolean;
  occludedBySun: boolean;
  /** Clock instant this moon's orientation was built for. NaN until the first
   *  pass — per entry, not per map, so a moon revealed while the clock is
   *  paused is still oriented rather than drawn at identity. */
  orientedUtcMs: number;
  /** Eclipse shading, in two phases: the position pass caches the target (it
   *  moves only with the geometry, so a settled chart may skip it), the size
   *  pass advances what is applied every rendered frame. */
  shade: MapShadeState;
  ring: Line2;
  ringGeometry: LineGeometry;
  ringMaterial: LineMaterial;
  /** The sampled orbit, kept as unit directions plus true x per sample, so the
   *  ring reprojects through the policy without touching the ephemeris again. */
  ringDirs: Float32Array;
  ringX: Float32Array;
  ringFilled: boolean;
  ringSampledUtcMs: number;
  /** Wall clock (ms) of the last fill — what the refill cadence is measured
   *  against. −Infinity until the first, so nothing gates a first fill. */
  ringFilledAtMs: number;
  /** Blend the ring's vertices were written at; a moved blend rewrites them. */
  ringBlend: number;
  /** How fast this orbit's shape turns (node + apsides), deg/day. */
  ringDriftDegPerDay: number;
  ringPeriodMs: number;
  label: HTMLDivElement | null;
}

/** A planet's moon system: the policy, the moons, and the group its drawn
 *  orbits live in. */
interface MoonSystem {
  parent: OrbitEntry;
  policy: MoonOffsetPolicy;
  moons: MoonEntry[];
  /** Rings live here in parent-radii units — position is the parent, and the
   *  scale is the one number per frame that carries the camera. */
  group: THREE.Group;
  built: boolean;
  revealed: boolean;
  /** AU per parent drawn radius: max(true radius, marker-anchored drawn
   *  radius). Computed once per frame in the position pass, from the PREVIOUS
   *  frame's camera, so nothing here can close a loop with the camera. */
  offsetScaleAU: number;
  /** That scalar blended toward the parent's TRUE radius, which is what makes
   *  true scale exact by construction rather than by arithmetic. */
  scaleBlended: number;
  /** The widest apoapsis in the system, in parent TRUE radii — the catalog
   *  figure the drawn orbits reach at true scale, where the policy's cap no
   *  longer governs them. Fixed at build time: it comes from the catalog. */
  maxApoX: number;
}

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
  /** Clock instant THIS orbit's samples were taken at. Per entry, because the
   *  drift refresh rebuilds one line per frame: a chart-wide epoch would be
   *  eight lines' worth of lie the moment the first one was refreshed. The
   *  direction fade is the consumer that shows it — a body's place along its
   *  own loop measured against another line's epoch wears a visibly wrong
   *  brightness phase. NaN until the first sampling pass. */
  epochUtcMs: number;
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
  /** The sphere and ring meshes inside the group, held for compositing: render
   *  order lives on the renderable object, not the group, so lifting a floored
   *  globe over the solar disc has to reach the meshes themselves. */
  globeMesh: THREE.Mesh;
  ringMesh: THREE.Mesh | null;
  /** The softened-terminator handle on that material — one float, written from
   *  the drawn size every frame the body is a globe. */
  globeShading: MapGlobeShading;
  ringMat: THREE.MeshStandardMaterial | null;
  /** Outer edge of the drawn ring in globe radii, 1 where there is no ring —
   *  the body's full drawn reach, which is what a camera has to clear. */
  ringOuterFactor: number;
  /** Drawn radius in screen px this frame, from the size policy — the globe's
   *  footprint, which is also its click target once it outgrows the pointer
   *  floor, AND the figure the dot is sized from when the dot is what draws.
   *  One number per body: the sprite, the framing reach and the label offset all
   *  read it, so none of them can hold a different opinion about how big the
   *  body is. What each of them does with it differs, and deliberately: the
   *  label buys air for the glyphs against whatever is PAINTED (the marker's
   *  gradient dies at the drawn limb, the globe's disc ends there), while the
   *  sun-lift gate is a conservative bound and takes the whole quad. Seeded at
   *  the marker size, since that is what a body would draw at before any frame
   *  has measured one. */
  drawnRadiusPx: number;
  /** Whether the globe, rather than the dot, is what drew this frame. */
  globeDrawn: boolean;
  /** Whether the body stands behind the solar disc this frame — the planets'
   *  only occluder, since nothing else on the chart draws in front of them.
   *  Suppresses the dot, the label and the hit target; a true-sized globe is
   *  depth-tested and the disc sorts against it on its own, while a floored
   *  globe is depth-free and hides behind this latch the way its dot does. */
  occluded: boolean;
}

/**
 * Everything a drawing pass needs to know about the frame it is drawing into.
 * The chart has two of them — the full-screen view and the corner chart — and
 * they share one scene, so nothing metered in screen px may reach for the
 * canvas: it comes from here.
 */
interface MapDrawView {
  camera: THREE.PerspectiveCamera;
  widthPx: number;
  heightPx: number;
  /** Whether the scale control's committed target is true scale. The corner
   *  chart is always compressed, whatever the full chart's control says. */
  trueScaleTarget: boolean;
  /** The scale blend this pass draws at, 0 compressed → 1 true. Together with
   *  the target it decides when a policy-floored globe composites as a
   *  depth-free impostor: through the WHOLE true side of the blend, not just
   *  while the target says true — the camera is still far mid-animation, and a
   *  floored sphere handed its depth back there would be an AU-scale body that
   *  can punch through the Sun's depth-tested disc for the rest of the ride. */
  trueScaleBlend: number;
  /** Whether this pass draws moons at all. */
  withMoons: boolean;
  /** Ship marker extent, screen px. */
  shipPx: number;
  /** The Sun's halo, in multiples of its drawn disc. */
  sunHaloRadii: number;
  sizeParams: MapBodySizeParams;
}

export class SystemMap {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  /** The corner chart's own camera: a fixed 3/4 overview seated to its own
   *  aspect, never touched by the controls or the camera state machine. */
  private miniCamera: THREE.PerspectiveCamera;

  private textures: MapTextureSource;

  private sun: THREE.Sprite;
  private sunHalo: THREE.Sprite;
  private sunRadiusPx = 0;
  /** The star as the occlusion gate sees it, refreshed once per drawing pass:
   *  its camera-space position and the radius its disc actually paints. Every
   *  marker on the chart is measured against these, and the pass that writes
   *  them runs before any of them. */
  private sunViewX = 0;
  private sunViewY = 0;
  private sunViewDepth = 1;
  private sunDiscPx = 0;
  private sunBaseColor = new THREE.Color(SUN_DATA.color);
  /** The star as the GLOBES' shader sees it: the same point light the standard
   *  material is lit by, handed over so the terminator softening can rebuild
   *  that light exactly instead of guessing at it. One holder for the whole
   *  chart, written once per drawing pass. */
  private sunUniforms: MapSunUniforms = makeMapSunUniforms(
    new THREE.Color(SUN_LIGHT_COLOR),
    SUN_LIGHT_INTENSITY,
  );
  private orbits: OrbitEntry[] = [];
  /** The one entry whose line is dimmed for a follow, remembered so the restore
   *  lands on the material that was actually written. */
  private dimmedOrbit: OrbitEntry | null = null;
  /** The same entries by planet name. `entryFor` sits under per-frame paths
   *  (the availability refresh scans every planet each frame), so the lookup
   *  has to be a read, not a search. */
  private orbitsByName = new Map<string, OrbitEntry>();
  private shipMarker: THREE.Sprite;
  private shipChevronTex: THREE.Texture;
  private shipRingTex: THREE.Texture;
  /** One unit sphere behind every globe — each body varies only by material and
   *  by the scale on its group. */
  private globeGeo = new THREE.SphereGeometry(1, 64, 32);
  /** Moons never fill the frame the way a focused planet does, so they share a
   *  cheaper sphere. */
  private moonGeo = new THREE.SphereGeometry(1, 32, 16);
  private moonSystems: MoonSystem[] = [];
  private moonsByName = new Map<string, MoonEntry>();
  private moonSystemsByParent = new Map<string, MoonSystem>();
  /** Dev forensics: how many ring buffers have been written, and how many moon
   *  position passes have run. A steady state that keeps writing rings, or that
   *  keeps recomputing positions on a paused clock under a still camera, shows
   *  up here as a climbing number and nowhere else. */
  private moonRingWrites = 0;
  private moonPasses = 0;
  /** How many times the pick anchors have actually been projected. Hover asks
   *  every frame while a mouse rests on the canvas, so this climbing once a
   *  frame is the design — bodies move under a still cursor, and a cached
   *  anchor set would answer with where they used to be. More than once a frame
   *  is the regression. */
  private anchorBuilds = 0;
  /** Everything a body's drawn position depends on that is NOT the clock, the
   *  blend or the camera pose: the radial curve, the size policy, the offset
   *  policy, the viewport, what the camera is following. Bumping this is how a
   *  change none of the three keys can see still invalidates them — without it
   *  a curve swap while paused leaves a followed moon detached from a parent
   *  that has moved out from under it. */
  private projectionRevision = 0;
  /** Bumped once per frame the map draws, plus by every camera move made
   *  outside the update pass. Anchors cache against it. */
  private frameRevision = 0;
  /** The projection dirty key: the clock, the blend and the camera pose the
   *  last moon pass ran against. */
  private moonKeyUtcMs = Number.NaN;
  private moonKeyRevision = -1;
  private moonKeyBlend = Number.NaN;
  private moonKeyCam = new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN);
  private tmpMoonNormal = new THREE.Vector3();
  private tmpMoonQuat = new THREE.Quaternion();
  /** Where the ephemeris seam writes a body's heliocentric AU, once per body
   *  per pass — read out into the entry's own numbers and never held. */
  private tmpHelio = new THREE.Vector3();

  private labelContainer: HTMLElement | null = null;
  /** Labels keyed by catalog name, never by catalog index: the chart's body set
   *  is the Sun, the planets and the moons, and only a name is shared by the
   *  pick, the card, the hover emphasis and the label. */
  private labels = new Map<string, HTMLDivElement>();
  /** Each label's measured half-width in screen px, taken once the first time
   *  it is revealed. Names do not change and the font does not either, so one
   *  read per label per session is the whole cost of the box test. */
  private labelHalfWidths = new Map<string, number>();
  /** Where the bottom chrome begins, measured from the DOM (the scale row and
   *  the world's bottom bar — whichever stands higher) rather than restated
   *  from CSS numbers. Null when nothing measured. Re-read when the viewport
   *  changes and on every open, because the bar's presence can change between
   *  sessions without a resize. */
  private labelStaticChromeTopPx: number | null = null;
  private labelChromeForW = 0;
  private labelChromeForH = 0;
  private labelMaxBoxTopCachedPx = Number.POSITIVE_INFINITY;
  /** The chart's own sheets, measured live every frame they stand open: the
   *  picked-body card, the Focus picker and the info popover. Each counts as a
   *  band only while it spans the width, which is the phone form. */
  private labelSheetEls: (HTMLElement | null)[] = [];
  /** The one drawn ring annulus's screen-space ellipse this frame, for the
   *  labels of the moons that live inside it. Refreshed in renderLabels;
   *  inactive whenever no revealed system draws a ring. */
  private labelRingCtx = {
    parent: null as OrbitEntry | null,
    centerXPx: 0,
    centerYPx: 0,
    outerPx: 0,
    ratio: 1,
    minorDirX: 0,
    minorDirY: 1,
  };
  private labelRingShift = { x: 0, y: 0 };
  /** The transform each label last drew at, so a settled chart writes no DOM.
   *  Values persist through display: none on purpose — a label re-shown where
   *  it already stands needs no write at all. */
  private labelLastPlacedX = new Map<string, number>();
  private labelLastPlacedY = new Map<string, number>();

  private open = false;
  /**
   * The corner chart's lifecycle, deliberately separate from `open`. That flag
   * conflates three things — owns the frame, owns the pointer, should tick —
   * and the corner chart is only the third. The two are mutually exclusive: a
   * full open stands the corner chart down, so exactly one pass a frame writes
   * the shared drawn sizes, extent and marker scales.
   */
  private miniOpen = false;
  /** The extent and aspect the corner chart's fixed pose was fitted for. The
   *  extent includes the ship, which moves every frame; re-fitting on every one
   *  of those would make the chart breathe. */
  private miniSeatedExtentAU = 0;
  private miniSeatedAspect = 0;
  /** What the corner chart's last planet pass was computed against. */
  private miniBodyKey: MiniBodyKey = makeMiniBodyKey();
  /** Dev forensics: how many planet passes the corner chart has actually run.
   *  A settled chart under a paused clock climbing this is the regression the
   *  key exists to prevent, and it shows up here and nowhere else. */
  private miniBodyPasses = 0;
  /** Whether the corner chart clears its rectangle to the chart's own field
   *  (the shipped look) or draws over the world frame. Dev A/B. */
  private miniOpaque = true;
  private miniBounds: MapCameraBounds = { minDist: 0, maxDist: 0, near: 0, far: 0 };
  /** Cost forensics for the corner chart (DEV only): the tick and the draw,
   *  wall ms, most recent first-in-first-out. The construction and first tick
   *  are kept apart — they are a one-off, and averaging them into the steady
   *  state would hide both. */
  private miniTickMs: number[] = [];
  private miniRenderMs: number[] = [];
  private miniFirstTickMs = -1;
  private miniFirstRenderMs = -1;
  // Radial curve + how far it is blended toward true scale (0 compressed,
  // 1 true). The curve is a dev-selectable A/B; the blend is the user's toggle.
  private curve: MapCurve = defaultMapCurve();
  private blendState = makeMapBlendState();
  private bodySizeParams: MapBodySizeParams = { ...MAP_BODY_SIZE_DEFAULTS };
  /** The sweep's memory — cursor and previous clock in one object (see
   *  mapResample.ResampleState). Deliberately untouched by close(), and the
   *  module exports no reset: the lap survives every open/close by shape. */
  // `readonly` on purpose: the sweep's memory survives every close and open by
  // construction — nothing can hand this field a fresh sweep mid-life.
  private readonly resampleSweep = new ResampleSweep();
  /** One reusable point buffer for the orbit sampler. The samples are copied
   *  straight into the entry's own Float32Array and nothing here outlives the
   *  call, so all nine orbits share it — 181 fresh vectors per line is what put
   *  this pass on the collector's account. */
  private orbitSampleScratch: THREE.Vector3[] = Array.from(
    { length: ORBIT_SEGMENTS + 1 },
    () => new THREE.Vector3(),
  );
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
  private tmpScissor = new THREE.Vector4();
  /** The renderer's own clear colour, saved across the corner chart's pass. */
  private tmpClearColor = new THREE.Color();
  private tmpView = new THREE.Vector3();
  /** The two drawing passes' views, filled in place each frame. */
  private fullView: MapDrawView = {
    camera: null as unknown as THREE.PerspectiveCamera,
    widthPx: 1,
    heightPx: 1,
    trueScaleTarget: false,
    trueScaleBlend: 0,
    withMoons: true,
    shipPx: SHIP_PX,
    sunHaloRadii: SUN_HALO_RADII,
    sizeParams: MAP_BODY_SIZE_DEFAULTS,
  };
  private miniView: MapDrawView = {
    camera: null as unknown as THREE.PerspectiveCamera,
    widthPx: 1,
    heightPx: 1,
    trueScaleTarget: false,
    trueScaleBlend: 0,
    withMoons: false,
    shipPx: MINI_SHIP_PX,
    sunHaloRadii: MINI_SUN_HALO_RADII,
    sizeParams: MINI_BODY_SIZE_PARAMS,
  };
  /** Planetocentric offset scratch — a moon's position is its parent's plus
   *  this, and the ephemeris seam fills a caller's vector. */
  private tmpMoonOffset = new THREE.Vector3();
  /** Shading scratch, both caller-owned the way the shading seam expects: the
   *  parent's heliocentric position as a vector (the chart keeps it as three
   *  scalars) and the state the geometry writes into. Read straight onto the
   *  moon's entry before the next call, so one of each serves every moon. */
  private tmpParentHelio = new THREE.Vector3();
  private tmpShading: MoonShadingState = { sunVisibleFraction: 1, inUmbra: false };

  /** What the geometry is projected at right now. The ledger owns every write;
   *  the whole class reads the blend through here. */
  private get blend(): number {
    return this.blendState.blend;
  }

  // Un-docked ship pulse phase (wall ms).
  private pulseMs = 0;

  // Last raw heliocentric ship pose the mode handed over, and whether one has
  // arrived yet — the marker re-projects and re-orients from these whenever the
  // curve or the camera changes between frames. The course is a unit VECTOR,
  // taken from the ship's own forward math: the chart must never re-derive a
  // heading from angles, or it holds a second opinion about which way the ship
  // is pointing and the two drift apart the first time the flight frame changes.
  private shipRawX = 0;
  private shipRawY = 0;
  private shipRawZ = 0;
  private shipFwdX = 1;
  private shipFwdY = 0;
  private shipFwdZ = 0;
  private shipSnapshot = false;
  /** The ship's PLAIN charted radius — the chart's own compression and nothing
   *  else. The marker itself may be drawn in a moon system's amplified space,
   *  and the fit must not be widened by an amplification: what the frame has to
   *  contain is where the ship really is on the chart. */
  private shipPlainR = 0;
  /** The ship's chart transform for this frame: the plain compression plus,
   *  where one applies, the moon system whose space the marker joins. The
   *  marker and the heading probe are both charted through this one object, so
   *  they cannot end up in different spaces. */
  private shipAnchorFrame: ShipAnchorFrame = {
    blend: 0,
    curve: defaultMapCurve(),
    system: null,
  };
  /** The system half of that frame, filled in place once a ship has actually
   *  been inside one — a per-frame object would allocate on every frame the
   *  chart draws a ship among moons. */
  private shipAnchorSystem: ShipAnchorSystem | null = null;
  /** Which system the marker is being charted inside, for the dev probe: the
   *  one thing about the ship's placement that pixels cannot report. */
  private shipAnchorName: string | null = null;

  // Pick anchors, rebuilt at most once per frame and only when something asks:
  // a tap, a probe, or the hover pass while a mouse rests here. A fixed pool
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
  /** What the anchors in the pool were projected against: the frame's
   *  projection revision and the camera pose. Hover fires on every pointer
   *  move and a probe re-asks inside the same frame — projecting 76 anchors
   *  each time is work nothing asked for. */
  private anchorKeyRevision = -1;
  private anchorKeyProjection = -1;
  private anchorKeyWidth = -1;
  private anchorKeyHeight = -1;
  private anchorKeyPos = new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN);
  private anchorKeyQuat = new THREE.Quaternion(0, 0, 0, Number.NaN);
  // The catalog name of the currently hovered dot (fine pointers), or null.
  private hoveredName: string | null = null;
  /** The body a focus flight has just landed on, and how long ago. The pulse
   *  that marks the landing rides these; null between pulses. */
  private pulseName: string | null = null;
  private pulseElapsedMs = 0;
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

  // Free overview zoom. `zoomFree` says the pivot has left the origin: while it
  // is clear the parked overview behaves exactly as it always did, and every
  // path that puts the target back on the origin clears it again. The dive
  // snapshot is what keeps a cancel coherent — a dive begun from a zoomed
  // overview restores a floating target, and restoring it under a clear latch
  // would be a target off the origin that nothing believes has moved.
  private zoomFree = false;
  private diveStartZoomFree = false;
  /** Pointer ids down on the canvas right now, and each one's type. The wheel
   *  stands down while any of them is live (the controls' own rule), and a
   *  pinch is exactly two touches.
   *
   *  Kept for the life of the map object, never cleared by open or close: the
   *  down/up/cancel listeners are unconditional, so the book is a true mirror
   *  of what is held. Emptying it while a finger is still down is what would
   *  make it lie — a map reopened mid-drag would stop suppressing the wheel
   *  under a rotate nobody had released. The controls keep their own book the
   *  same way: their pointer list survives being disabled and re-enabled
   *  mid-gesture, and the document-level pointerup that empties it has no
   *  enabled guard, so a gesture released while the map is shut still retires
   *  cleanly on both sides.
   *
   *  What the mirror needs in return is to hear EVERY way a gesture ends,
   *  including a drag over the world that a focus loss retires by hand rather
   *  than by a real pointerup. An id left standing from one of those would
   *  suppress the wheel over a map the user opens later, with nothing holding
   *  it down. */
  private zoomPointers = new Map<number, string>();
  /** Whether a wheel or a pinch has arrived over the chart since this map
   *  opened. The one thing that reads it is the hint that says the gestures
   *  exist, which has no business staying up once they have been used. Set
   *  before the state gates, because a gesture the camera state refuses is
   *  still a user who knows how to zoom. */
  private zoomGestureSeen = false;
  /** A wheel or pinch dollied since the scale ease last preserved its framing.
   *  The ease re-dollies to the ratio captured at the toggle every frame, so a
   *  gesture's new distance would snap back on the very next one — the button
   *  path rebases inline (zoomNotches), but the wheel's dolly lands inside the
   *  controls after our listeners run, so it flags here and the ease rebases
   *  before its next dolly. */
  private zoomEaseRebase = false;
  private overviewBounds: MapCameraBounds = { minDist: 0, maxDist: 0, near: 0, far: 0 };
  private zoomViewDir = new THREE.Vector3();
  /** The nearest drawn surface to the camera, refilled in place — the scan runs
   *  every frame of every flight and on every zoom event. */
  private nearestDrawn: { name: string | null; clearanceDist: number } = {
    name: null,
    clearanceDist: Infinity,
  };

  // Which side of the chart's plane the camera is held on, and the crossing
  // between them. The latch is map state rather than camera state because the
  // two legal polar bands share no overlap and OrbitControls hold only one
  // interval: every place that hands the controls their bounds has to write the
  // band this says, or the clamp drags a mirrored camera back over the plane
  // inside a frame.
  private hemisphere: MapHemisphere = 'above';
  private flipState = makeMapFlipState();
  private polarBand: MapPolarBand = { min: 0, max: 0 };
  private tmpFlipOffset = new THREE.Vector3();

  // Dive transition (camera pose only — the mode owns the clock, the fade, the
  // token, and the commit). beginDive snapshots the start pose so a cancel can
  // restore it exactly; setDivePose eases toward the focus.
  private diving = false;
  /** The side the camera was on when a dive took it, so a cancel puts back the
   *  bounds the restored pose belongs to. */
  private diveStartHemisphere: MapHemisphere = 'above';
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
  // The blend the snapshots were taken at: the scale animation keeps running
  // under a dive, so a cancel may have to carry them into a projection that
  // moved on while the dive owned the camera.
  private diveStartBlend = 0;
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

    // The corner chart's camera never orbits and never follows; its pose is
    // seated once per fit and left alone. Aspect and clip planes are written
    // when it is seated, so the placeholders here only have to be valid.
    this.miniCamera = new THREE.PerspectiveCamera(MAP_FOV_DEG, 1, 1e-4, 1000);
    this.fullView.camera = this.camera;
    this.miniView.camera = this.miniCamera;

    this.controls = new OrbitControls(this.camera, el);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.enabled = false;
    // Keep it a map: never fully edge-on, and only ever on the side the latch
    // names. "Underneath" is a whole hemisphere the flip reaches, not a place
    // the camera can wander into.
    this.applyPolarBand();

    // The free overview zoom brackets the controls' own wheel handling. The
    // pivot is refreshed once BEFORE the dolly reads its radius — a rotate
    // between two notches changes what is ahead of the camera while the pivot
    // still describes where it used to be looking, and a notch spent on that
    // stale radius can travel further than the fresh geometry leaves room for —
    // and once after, arming the next event.
    //
    // The pre-refresh listens on the WINDOW, in the capture phase: an ancestor's
    // capture listeners run before every listener on the event's target,
    // whichever phase those registered for, so this is ordered ahead of the
    // controls' own wheel handler by the plainest rule the DOM has. (A capture
    // listener on the canvas itself would also land first — the target runs a
    // capture pass before its bubble pass — but that ordering turns on a
    // subtlety, and this one does not.) The target check is what keeps a wheel
    // over the HUD, which the controls never see, from moving the pivot and
    // latching a gesture that never happened.
    //
    // The post-refresh is a plain canvas listener; the controls registered
    // theirs on the same element first, and same-phase listeners run in
    // registration order, so it runs after the dolly.
    window.addEventListener('wheel', this.onZoomWheelBeforeDolly, { capture: true, passive: true });
    el.addEventListener('wheel', this.onZoomWheel, { passive: true });
    el.addEventListener('pointerdown', this.onZoomPointerDown);
    // A gesture whose terminal event never arrives is retired by a synthetic
    // pointercancel aimed at the canvas, and a synthetic event carries only the
    // flags it was built with — one that does not bubble reaches the canvas and
    // stops there. So the canvas is where a cancel has to be heard: it is the
    // one element every terminal event is guaranteed to reach, bubbling or not.
    // Retiring an id twice (here and again from the window, for a real event
    // that does bubble) costs nothing — the entry is simply gone.
    el.addEventListener('pointercancel', this.onZoomPointerUp);
    // A pinch dollies inside the controls' captured-pointer move listener,
    // which they install on the document — so a listener on the canvas would
    // run BEFORE the dolly rather than after it. The window is the one place
    // guaranteed to run after a document listener, whatever order the two were
    // registered in. Releases are tracked there too: a finger lifted over the
    // HUD never reaches the canvas.
    window.addEventListener('pointermove', this.onZoomPointerMove);
    window.addEventListener('pointerup', this.onZoomPointerUp);
    window.addEventListener('pointercancel', this.onZoomPointerUp);

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
      const entry = this.makeOrbit(planet, el);
      this.orbits.push(entry);
      this.orbitsByName.set(planet.name, entry);
    }
    // Hand the offset policy the ring geometry this chart actually built,
    // before any policy is built from it — the first one is built in the loop
    // just below, and the factors have to be standing by then. Saturn is the
    // only planet the map draws an annulus for, so it is the only one whose
    // moons a ring-clearance knob can move.
    const ringFactors: Record<string, number> = {};
    for (const entry of this.orbits) ringFactors[entry.planet.name] = entry.ringOuterFactor;
    setMapRingOuterFactors(ringFactors);

    // One system per planet that has moons. The meshes are built on first
    // reveal — a chart that never leaves the overview never pays for them.
    for (const entry of this.orbits) {
      if (getMoonsByPlanet(entry.planet.name).length === 0) continue;
      const group = new THREE.Group();
      group.visible = false;
      this.scene.add(group);
      let maxApoX = 0;
      for (const moon of moonOffsetEntries(entry.planet.name)) {
        if (moon.apoX > maxApoX) maxApoX = moon.apoX;
      }
      const system: MoonSystem = {
        parent: entry,
        policy: moonOffsetPolicyFor(entry.planet.name),
        moons: [],
        group,
        built: false,
        revealed: false,
        offsetScaleAU: entry.planet.radiusAU,
        scaleBlended: entry.planet.radiusAU,
        maxApoX,
      };
      this.moonSystems.push(system);
      this.moonSystemsByParent.set(entry.planet.name, system);
    }

    this.shipChevronTex = this.makeChevronTexture();
    this.shipRingTex = this.makeRingTexture();
    const shipMat = new THREE.SpriteMaterial({
      map: this.shipChevronTex,
      color: SHIP_MARKER_COLOR,
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

  /** How far the camera sits from the point it orbits. That point is the origin
   *  while the overview is parked — so this reads as a distance from the Sun —
   *  but a focus rides its subject and a free zoom seats its pivot on whatever
   *  is ahead, and then it is neither. Everything that frames against the fit
   *  wants exactly this number; anything that wants a distance from the Sun has
   *  to ask the camera's own position for it. */
  getCameraDistance(): number {
    return this.camera.position.distanceTo(this.controls.target);
  }

  /** Dev forensics: the free overview zoom's whole state — where the camera and
   *  its pivot are, whether the cursor owns the zoom, whether the pivot has
   *  left the origin, the shell it is held in, and the surface the pivot is
   *  metered against. The pivot distance is the effective one: what a re-seat
   *  arriving right now would use. */
  zoomState(): {
    cameraPos: [number, number, number];
    targetPos: [number, number, number];
    zoomToCursor: boolean;
    zoomFree: boolean;
    minDistance: number;
    maxDistance: number;
    extentAU: number;
    nearestClearanceDistAU: number;
    pivotDistanceAU: number;
    /** Pointers this class believes are down on the canvas, and the same
     *  question asked of the controls' own bookkeeping (with their gesture
     *  state). A gesture that outlives a close/reopen shows up as a
     *  disagreement between the two, and nowhere else. -1 where a three
     *  upgrade has renamed the fields, rather than a confident wrong answer. */
    activePointers: number;
    controlsPointers: number;
    controlsState: number;
  } {
    const clearance = this.nearestDrawnSurface().clearanceDist;
    const bounds = this.overviewBoundsNow(clearance);
    const p = this.camera.position;
    const t = this.controls.target;
    const gesture = this.controls as unknown as { _pointers?: unknown[]; state?: number };
    return {
      cameraPos: [p.x, p.y, p.z],
      targetPos: [t.x, t.y, t.z],
      zoomToCursor: this.controls.zoomToCursor,
      zoomFree: this.zoomFree,
      minDistance: this.controls.minDistance,
      maxDistance: this.controls.maxDistance,
      extentAU: this.extentAU,
      nearestClearanceDistAU: clearance,
      pivotDistanceAU: mapOverviewPivotDistanceAU(clearance, bounds.minDist, bounds.maxDist),
      activePointers: this.zoomPointers.size,
      controlsPointers: Array.isArray(gesture._pointers) ? gesture._pointers.length : -1,
      controlsState: typeof gesture.state === 'number' ? gesture.state : -1,
    };
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
    // The two lifecycles are mutually exclusive, and the full chart wins: it
    // owns the whole frame. Standing the corner chart down here rather than
    // waiting for its own visibility rule keeps exactly one pass a frame
    // writing the drawn sizes both of them share.
    this.miniOpen = false;
    this.resetOcclusionLatches();
    this.projectionRevision++;
    this.clockUtcMs = utcMs;
    this.ensureLabelContainer();
    // Bottom-chrome remeasure: the bar the labels dodge can appear or leave
    // between sessions (landed vs. flying) without any resize to say so.
    this.labelChromeForW = 0;
    this.labelChromeForH = 0;
    // The chart draws at the scale its own control claims, whatever displaced
    // the blend while it was shut — a corner chart always draws compressed, and
    // one that failed to hand the blend back would otherwise leave this open
    // drawing compressed under a control reading True scale, with the control
    // refusing the press that would fix it. The resample below reprojects.
    blendReconcile(this.blendState);
    this.resample(utcMs);
    this.needsInitialFrame = true;
    // Every open starts on the whole system, whatever the last one ended on —
    // and the whole of that state is settled BEFORE the controls come back,
    // pivot included. The first frame is what re-frames the camera, so between
    // here and there a wheel would otherwise find the last session's target
    // still standing while everything else said this one had just begun.
    this.cam = mapCameraInitialState();
    // Every open looks down on the chart from the north, whatever the last
    // session's flip left standing.
    this.hemisphere = 'above';
    mapFlipSettle(this.flipState);
    this.applyPolarBand();
    this.controls.target.set(0, 0, 0);
    this.zoomFree = false;
    // A fresh session has been shown no gestures yet, whatever the last one saw.
    this.zoomGestureSeen = false;
    this.syncZoomToCursor();
    this.controls.enabled = true;
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
    // A crossing lands before the flight leaves: the flight keeps the direction
    // the camera is looking from, and mid-crossing that direction is one the
    // landing would have to clamp away.
    this.settleFlip();
    const next = mapCameraReduce(this.cam, { kind: 'focus', name });
    if (next === this.cam) return true;
    const fromFocus = this.cam.camState !== 'overview';
    this.cam = next;
    // A new destination retires the last arrival's mark.
    this.cancelFocusPulse();
    // What the camera follows decides which system is revealed, and nothing
    // else about the frame need change for that to be true.
    this.projectionRevision++;
    this.startFly(fromFocus);
    return true;
  }

  /** Release the focus: fly back out to the whole-system fit. False when there
   *  was nothing to release, or the release is already under way. */
  releaseFocus(): boolean {
    if (!this.open) return false;
    this.settleFlip();
    const next = mapCameraReduce(this.cam, { kind: 'release' });
    if (next === this.cam) return false;
    const fromFocus = this.cam.camState !== 'overview';
    this.cam = next;
    // Leaving is not an arrival: no pulse on the way out, and any still running
    // ends here.
    this.cancelFocusPulse();
    this.projectionRevision++;
    this.startFly(fromFocus);
    return true;
  }

  /**
   * Cross to the other side of the chart's plane: same pivot, same bearing,
   * same distance, opposite hemisphere. A press while one is already crossing
   * turns it around and puts the camera back where it started.
   *
   * Refused while anything else owns the camera — a flight, a dive — and while
   * the scale animation is running, which rewrites the pivot and the framing
   * every frame and would leave the crossing mirroring a pose that has moved
   * under it.
   */
  flipElevation(): boolean {
    if (!this.open) return false;
    // A second press: turn around. The latch goes back with it, so the bounds
    // describe the side the camera is actually returning to.
    if (this.cam.camState === 'flip') {
      mapFlipReverse(this.flipState);
      this.hemisphere = mapHemisphereFlipped(this.hemisphere);
      this.applyPolarBand();
      return true;
    }
    if (this.blendState.animating) return false;
    // Nothing to mirror before the first frame has framed anything: seat the
    // overview, exactly as a focus asked for that early does.
    if (this.needsInitialFrame) {
      this.needsInitialFrame = false;
      this.recomputeExtent();
      this.frameToExtent();
    }
    const next = mapCameraReduce(this.cam, { kind: 'flip' });
    if (next === this.cam) return false;
    this.tmpFlipOffset.copy(this.camera.position).sub(this.controls.target);
    // The chart's parked bearing is the fallback for a camera looking straight
    // down the pole, where the offset carries no bearing of its own.
    if (!mapFlipBegin(this.flipState, this.tmpFlipOffset, 0, 1)) return false;
    this.cam = next;
    // A released drag keeps coasting; start from a settled controls state or
    // the residual fights the crossing (the flight's own rule).
    flushOrbitDamping(this.controls);
    this.controls.enabled = false;
    // The destination band goes on now, not at the landing: every bounds pass
    // between here and there describes where the camera is going.
    this.hemisphere = mapHemisphereFlipped(this.hemisphere);
    this.applyPolarBand();
    this.cancelFocusPulse();
    return true;
  }

  /** Whether the camera would take a focus on this body. The Focus picker's own
   *  gate, so no row it offers is one `focusBody` would refuse. */
  acceptsFocus(name: string): boolean {
    return this.cameraMayVisit(name);
  }

  /** Which side of the plane the chart is being watched from. */
  getHemisphere(): MapHemisphere {
    return this.hemisphere;
  }

  /** Whether a crossing is running right now. */
  isFlipping(): boolean {
    return this.cam.camState === 'flip';
  }

  /** Whether the compressed↔true animation is still running. The crossing
   *  refuses while it is: that animation rewrites the pivot and the framing
   *  every frame, and the crossing would be mirroring a pose that has moved. */
  isScaleAnimating(): boolean {
    return this.blendState.animating;
  }

  /** Whether the overview's zoom has carried its pivot off the origin — the
   *  chart is no longer at the parked fit. Read every frame for the console's
   *  Overview row, so it allocates nothing and scans nothing (zoomState() does
   *  both). */
  isZoomFree(): boolean {
    return this.zoomFree;
  }

  /**
   * Re-fit an overview a free zoom has wandered off. False when there is
   * nothing to recover — a focus, a flight or a dive owns the camera, or the
   * chart is already parked.
   *
   * The re-fit alone is not enough. A scale animation still running holds the
   * framing ratio the user had when they toggled, and its next frame re-dollies
   * to that ratio against the fresh fit — throwing the recenter away a frame
   * after the tap. Rebasing the ratio against the pose just seated is what the
   * two peer "back at the overview" paths (a release landing, a dive
   * normalising) already do, and it lands the ratio at 1 by construction.
   */
  recenterOverview(): boolean {
    if (!this.open || this.cam.camState !== 'overview' || !this.zoomFree) return false;
    this.frameToExtent();
    this.rebaseScaleZoomRatio();
    return true;
  }

  /** Seat the camera at a 3/4 overhead framing the live extent (ship included). */
  private frameToExtent(): void {
    const dist = fitDistanceAU(this.extentAU, MAP_FOV_DEG, this.camera.aspect);
    // The fit is written in the northern hemisphere, so the latch comes back
    // with it: framing the whole system is also how a chart flipped underneath
    // is put the right way up.
    this.hemisphere = 'above';
    this.camera.position.set(0, dist * 0.82, dist * 0.57).setLength(dist);
    // The target is back on the origin, so the free zoom's pivot has not moved:
    // whatever a previous zoom did, this frame is the parked chart again.
    this.controls.target.set(0, 0, 0);
    this.zoomFree = false;
    this.applyBounds();
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
    blendSettle(this.blendState);
    this.scaleZoomRatio = 1;
    // A crossing has nothing to cross on a shut chart; the next open reseats
    // the hemisphere anyway.
    mapFlipSettle(this.flipState);
    this.setHover(null);
    this.cancelFocusPulse();
    this.controls.enabled = false;
    // The zoom's own state goes with the session — pivot and latch together, so
    // the closed map is never left claiming an unmoved pivot that sits off the
    // origin. Nothing renders after this, so moving the target is invisible.
    // The POINTER book deliberately survives: it mirrors what is physically
    // down on the canvas, and a finger still held while the map closes is still
    // held when it reopens.
    this.controls.target.set(0, 0, 0);
    this.zoomFree = false;
    this.syncZoomToCursor();
    this.clearFocusOrbitDim();
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
      entry.occluded = false;
      entry.dot.renderOrder = MARKER_RENDER_ORDER;
    }
    // The moons let their borrowed paint go the same way, and every system
    // stands down: the next open re-decides what is revealed from scratch.
    for (const system of this.moonSystems) {
      system.revealed = false;
      system.group.visible = false;
      for (const moon of system.moons) {
        this.adoptTexture(moon.globeMat, null);
        this.hideMoon(moon);
      }
    }
    this.projectionRevision++;
  }

  /** Segmented scale control: animate the blend toward compressed / true scale.
   *  Capture the user's current framing so the animation re-dollies to keep the
   *  system the same apparent size as its extent changes. */
  setScale(trueScale: boolean): void {
    // Only the overview re-dollies against this ratio, so only the overview may
    // capture it: a focus framing is a ten-thousandth of the fit, and carrying
    // that fraction back to the overview would slam the camera into the Sun.
    // A toggle mid-focus just re-projects, and the follow delta rides it. It is
    // captured against the framing the press found, so it is read before the
    // ledger moves the target.
    const wasOverview = this.cam.camState === 'overview';
    const fit = wasOverview
      ? fitDistanceAU(this.extentAU, MAP_FOV_DEG, this.camera.aspect)
      : 0;
    const ratio = wasOverview ? this.getCameraDistance() / Math.max(fit, 1e-4) : 0;
    if (!blendRequestScale(this.blendState, trueScale)) return;
    if (wasOverview) this.scaleZoomRatio = ratio;
  }

  isTrueScale(): boolean {
    return blendIsTrueScale(this.blendState);
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
    this.projectionRevision++;
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
    this.applyBounds();
    this.controls.update();
  }

  /** Dev bridge: live tuning of the drawn-size policy. A partial merges into
   *  the running copy; null restores the shipped defaults. */
  setBodySizeParams(partial: Partial<MapBodySizeParams> | null): void {
    this.bodySizeParams = partial === null
      ? { ...MAP_BODY_SIZE_DEFAULTS }
      : { ...this.bodySizeParams, ...partial };
    this.projectionRevision++;
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
    shipFwdX: number,
    shipFwdY: number,
    shipFwdZ: number,
    shipMoving: boolean,
    landed: LandedTarget,
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
    this.stepResample(utcMs);

    // Advance the scale animation; a live blend re-projects the cached samples.
    // The camera branch below keys off whether the blend moved THIS frame, not
    // off the flag: the terminal frame clears it while carrying the animation's
    // largest extent change, and that frame needs the same preserving dolly as
    // every other, or the settled view is left misframed. The pre-advance
    // blend is read first: the pivot remap below carries the camera's target
    // across exactly the step the blend just took.
    const blendBefore = this.blend;
    const blendMoved = blendAdvance(this.blendState, dtMs);
    if (blendMoved) this.recompressOrbits();

    // Re-read the world's textures before anything decides how to draw. This
    // runs after the world's own update in the same frame, so a tier swap made
    // this frame is adopted before the map renders it.
    this.syncTextures();
    this.updateBodies(utcMs);
    // Moons after their planets: every one of them is placed relative to a
    // parent that has just been placed.
    this.updateMoons(utcMs);
    this.syncMoonTextures();
    // The ship after the moons: the space its marker is charted in is the one
    // the moons were just placed in, scale and all.
    this.placeShip(shipX, shipY, shipZ, shipFwdX, shipFwdY, shipFwdZ, shipMoving, landed, dtMs);

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
          // The free pivot is a point in map space — a cursor-anchored zoom
          // parks it on the body it closed on — so it rides the re-projection
          // like every body does, or a pivot acquired at true scale (5–8 AU
          // out) is left outside the entire compressed chart and the camera
          // settles staring at empty space. Radial remap only: the layout
          // scales radii and holds directions.
          const pivot = this.controls.target;
          const pivotRadius = pivot.length();
          if (pivotRadius > 1e-9) {
            const scale =
              remapRadius(pivotRadius, blendBefore, this.blend, this.curve) / pivotRadius;
            // The camera rides the same delta: the dolly below re-derives its
            // ray from camera − target, so a pivot sliding under a standing
            // camera would swing the bearing a little toward the radial every
            // frame — a deep zoom ends the toggle staring down the system's
            // radius, and a round trip can land on the far side of the pivot.
            // Carrying the camera keeps the offset vector — the user's
            // bearing — and leaves the dolly nothing to change but length.
            this.camera.position.addScaledVector(pivot, scale - 1);
            pivot.multiplyScalar(scale);
          }
          // A wheel or pinch that dollied since the last preserved frame chose
          // a new framing; re-dollying to the toggle's captured ratio would
          // snap it back right here. Rebase to what the gesture left standing,
          // the way the button path already does inline.
          if (this.zoomEaseRebase) {
            this.zoomEaseRebase = false;
            this.rebaseScaleZoomRatio();
          }
          // Re-dolly to preserve the framing captured at the toggle, so the
          // system holds its apparent size while its extent slides with the
          // blend.
          const wantDist = this.scaleZoomRatio
            * fitDistanceAU(this.extentAU, MAP_FOV_DEG, this.camera.aspect);
          this.dollyTo(wantDist);
          this.applyBounds();
          this.controls.update();
        } else {
          // Steady state consumes the gesture flag with no rebase to make:
          // outside an ease nothing re-dollies, and the next toggle captures
          // its own fresh ratio at the press.
          this.zoomEaseRebase = false;
          this.applyBounds();
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
      case 'flip':
        this.advanceFlip(dtMs);
        break;
      case 'dive':
        // The mode drives setDivePose; the camera section stands down.
        break;
    }
    // After the camera phase, so a flight that landed this frame pulses from
    // zero rather than from one frame in.
    this.advanceFocusPulse(dtMs);
    // Flush the matrices BEFORE any projection. The renderer refreshes them
    // only at render time, which runs after this update, so a
    // projection-dependent pass must force it.
    this.camera.updateMatrixWorld();

    // ── (3) Projection-dependent work, on this frame's final camera pose.
    // Except mid-dive: this frame's FINAL pose is written by setDivePose,
    // which the mode drives after this update in the same pass and which ends
    // in this same projection — running it here too would project the whole
    // chart twice a frame, the first time against a pose about to be replaced.
    if (this.cam.camState !== 'dive') this.projectFullView();
  }

  /**
   * The full chart's whole projection-dependent phase, against the pose
   * standing right now. Kept as one call because the three places that need it
   * — the frame, a resize, a dive step — all need the WHOLE of it, in order: a
   * marker-floored body is sized from its camera depth, and a label is placed
   * from the same projection, so a pose refreshed without them draws last
   * pose's sizes at this pose's distances.
   */
  private projectFullView(): void {
    this.frameRevision++;
    const el = this.renderer.domElement;
    this.fullView.widthPx = Math.max(el.clientWidth, 1);
    this.fullView.heightPx = Math.max(el.clientHeight, 1);
    this.fullView.trueScaleTarget = this.isTrueScale();
    this.fullView.trueScaleBlend = this.blend;
    this.fullView.sizeParams = this.bodySizeParams;
    this.orientShip(this.fullView);
    this.updateDrawnSizes(this.fullView);
    this.applyFocusOrbitDim();
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

  // ── The corner chart ────────────────────────────────────────────────────
  //
  // A second lifecycle over the same scene, not a second flag on the first
  // one. It ticks and draws; it never owns the pointer, never runs the camera
  // state machine, never reveals a moon system, and never adopts a texture.
  // What it draws is the chart at its fixed 3/4 overview: the Sun, the nine
  // orbit lines, the planets as dots, and the ship.
  //
  // Its scale is always the compressed one, whatever the full chart's control
  // is set to — at true scale the inner system is a single pixel, which is not
  // a chart. That means it displaces the shared blend, and the ledger is what
  // makes the displacement safe (see mapBlend).

  isMiniOpen(): boolean {
    return this.miniOpen;
  }

  /** Start the corner chart. Refused while the full chart owns the frame. */
  openMini(utcMs: number): void {
    if (this.miniOpen || this.open) return;
    this.miniOpen = true;
    this.resetOcclusionLatches();
    this.clockUtcMs = utcMs;
    if (blendParkCompressed(this.blendState) && this.sampled) this.recompressOrbits();
    // Nothing is seated yet: the first tick fits the pose to a live extent, and
    // places every body — the park above may have just moved the blend, and the
    // dots follow the body pass, not the orbit reprojection.
    this.miniSeatedExtentAU = 0;
    this.miniSeatedAspect = 0;
    this.miniBodyKey = makeMiniBodyKey();
    this.miniFirstTickMs = -1;
    this.miniFirstRenderMs = -1;
  }

  /** Stand the corner chart down and hand the blend back to the full chart. */
  closeMini(): void {
    if (!this.miniOpen) return;
    this.miniOpen = false;
    if (blendUnpark(this.blendState) && this.sampled) {
      this.recompressOrbits();
      this.recomputeExtent();
    }
  }

  /**
   * Per-frame refresh of the corner chart, into a viewport of `widthPx ×
   * heightPx`. Same truth seam as the full chart — every body straight from
   * the clock — with the moon, label, pick, hover, ring and texture passes all
   * skipped: none of them can show at this size, and the moons in particular
   * must stay exactly as the last full-chart close left them (hidden, and
   * holding no borrowed paint).
   */
  updateMini(
    utcMs: number,
    shipX: number,
    shipY: number,
    shipZ: number,
    shipFwdX: number,
    shipFwdY: number,
    shipFwdZ: number,
    shipMoving: boolean,
    landed: LandedTarget,
    dtMs: number,
    widthPx: number,
    heightPx: number,
  ): void {
    if (!this.miniOpen || this.open) return;
    const t0 = import.meta.env.DEV ? performance.now() : 0;

    this.clockUtcMs = utcMs;
    // The orbit lines are the chart. A map never opened has none, and the fade
    // along each line reads time against the epoch its own samples were taken
    // at, so a stale epoch mis-fades even when the shapes still hold. The step
    // is the same one the full chart takes, against the same cursor: whichever
    // pass is drawing carries the sweep on from where the other left it.
    this.stepResample(utcMs);
    // The planet pass is the chart's only expensive step, and nothing in it
    // moves unless the clock, the blend or the projection does. The ship is
    // not part of that: it flies under a paused clock, so its
    // placement, its heading and every drawn size run every frame regardless.
    if (miniBodiesStale(this.miniBodyKey, utcMs, this.blend, this.projectionRevision)) {
      stampMiniBodyKey(this.miniBodyKey, utcMs, this.blend, this.projectionRevision);
      this.miniBodyPasses++;
      this.updateBodies(utcMs);
    }
    this.placeShip(shipX, shipY, shipZ, shipFwdX, shipFwdY, shipFwdZ, shipMoving, landed, dtMs);
    this.recomputeExtent();

    const aspect = Math.max(widthPx, 1) / Math.max(heightPx, 1);
    if (aspect !== this.miniSeatedAspect
      || miniNeedsReseat(this.extentAU, this.miniSeatedExtentAU)) {
      this.seatMiniCamera(aspect);
    }
    // Flush before anything projects: the renderer refreshes the matrices only
    // at render time, and the drawn sizes read matrixWorldInverse.
    this.miniCamera.updateMatrixWorld();

    this.miniView.widthPx = Math.max(widthPx, 1);
    this.miniView.heightPx = Math.max(heightPx, 1);
    this.orientShip(this.miniView);
    this.updateDrawnSizes(this.miniView);

    if (import.meta.env.DEV) {
      const ms = performance.now() - t0;
      if (this.miniFirstTickMs < 0) this.miniFirstTickMs = ms;
      else this.pushPerfSample(this.miniTickMs, ms);
    }
  }

  /** Seat the corner chart's fixed 3/4 overview pose on the live extent. */
  private seatMiniCamera(aspect: number): void {
    this.miniSeatedAspect = aspect;
    this.miniSeatedExtentAU = this.extentAU;
    const dist = fitDistanceAU(this.extentAU, MAP_FOV_DEG, aspect);
    this.miniCamera.aspect = aspect;
    this.miniCamera.position.set(0, dist * 0.82, dist * 0.57).setLength(dist);
    this.miniCamera.lookAt(0, 0, 0);
    // No moon system is ever revealed here, so the drawn reach is the chart's
    // own; the surface term has nothing to meter against and stands down.
    const bounds = mapOverviewBounds(
      this.extentAU,
      this.renderedExtentAU(),
      dist,
      dist,
      Infinity,
      this.miniBounds,
    );
    this.miniCamera.near = bounds.near;
    this.miniCamera.far = bounds.far;
    this.miniCamera.updateProjectionMatrix();
  }

  /**
   * Draw the corner chart into `draw` — the GL-origin rectangle already snapped
   * to whole device pixels (see miniDrawRect) — over the world frame the
   * composer has already put on the backbuffer.
   *
   * The transaction is the whole of the safety here. Every piece of renderer
   * state the pass touches is saved and given back in `finally`, the rects go
   * in CSS px (three multiplies by the pixel ratio itself, and the snap is what
   * keeps that multiplication exact), and the depth buffer is cleared INSIDE
   * the scissor — the orbit lines are depth-tested, and the world's depth
   * buffer would otherwise occlude the whole chart.
   */
  renderMini(draw: MiniDrawRect): void {
    if (!this.miniOpen || this.open) return;
    if (draw.widthDevicePx < 1 || draw.heightDevicePx < 1) return;
    // The corner chart draws the full chart's own line objects: anything the
    // full chart dimmed for a follow is given back before this pass, whatever
    // path that session ended by.
    this.clearFocusOrbitDim();
    const t0 = import.meta.env.DEV ? performance.now() : 0;
    const renderer = this.renderer;

    const prevTarget = renderer.getRenderTarget();
    const prevScissorTest = renderer.getScissorTest();
    renderer.getScissor(this.tmpScissor);
    renderer.getViewport(this.tmpViewport);
    const prevAutoClear = renderer.autoClear;
    const prevExposure = renderer.toneMappingExposure;
    const prevBackground = this.scene.background;
    // The opaque variant leans on three's colour-background force-clear, and
    // that path writes the GL clear state from the chart's field colour without
    // touching the renderer's own stored clear colour. Re-applying the stored
    // pair afterwards is what puts the two back in agreement — otherwise the
    // next caller to clear() gets the chart's field instead of its own.
    renderer.getClearColor(this.tmpClearColor);
    const prevClearAlpha = renderer.getClearAlpha();
    try {
      renderer.setRenderTarget(null);
      // The world frame outside the rectangle has to survive untouched, so the
      // pass clears nothing on its own account.
      renderer.autoClear = false;
      // The world's near-Sun auto-exposure is live; the chart draws at neutral
      // and hands the world's value straight back.
      renderer.toneMappingExposure = MAP_EXPOSURE;
      renderer.setViewport(draw.left, draw.bottom, draw.width, draw.height);
      renderer.setScissor(draw.left, draw.bottom, draw.width, draw.height);
      renderer.setScissorTest(true);
      if (!this.miniOpaque) this.scene.background = null;
      // A masked-off depth buffer would swallow the clear silently.
      renderer.state.buffers.depth.setMask(true);
      renderer.clearDepth();
      // Line2 converts its px linewidth through this resolution, so a chart
      // drawn at the canvas's would come out a fifth of a pixel wide.
      for (const o of this.orbits) o.material.resolution.set(draw.width, draw.height);
      renderer.render(this.scene, this.miniCamera);
    } finally {
      const el = renderer.domElement;
      for (const o of this.orbits) {
        o.material.resolution.set(Math.max(el.clientWidth, 1), Math.max(el.clientHeight, 1));
      }
      this.scene.background = prevBackground;
      // Rebind the prior target BEFORE handing the clear colour back: the
      // renderer encodes clear values for whatever target is bound when they
      // are set, and the saved colour belongs to the saved target.
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(this.tmpClearColor, prevClearAlpha);
      renderer.setViewport(this.tmpViewport);
      renderer.setScissor(this.tmpScissor);
      renderer.setScissorTest(prevScissorTest);
      renderer.autoClear = prevAutoClear;
      renderer.toneMappingExposure = prevExposure;
    }
    if (import.meta.env.DEV) {
      const ms = performance.now() - t0;
      if (this.miniFirstRenderMs < 0) this.miniFirstRenderMs = ms;
      else this.pushPerfSample(this.miniRenderMs, ms);
    }
  }

  /** Dev A/B: draw the corner chart over the world frame instead of clearing
   *  its rectangle to the chart's own field. */
  setMiniOpaque(opaque: boolean): void {
    this.miniOpaque = opaque;
  }

  /** Dev forensics: what the corner chart costs and what pose it is holding.
   *  Samples are wall ms; the first tick and first draw are reported apart from
   *  the steady state because they carry the sampling of nine trajectories. */
  miniStats(): {
    open: boolean;
    blend: number;
    parkedBlend: number | null;
    seatedExtentAU: number;
    seatedAspect: number;
    near: number;
    far: number;
    opaque: boolean;
    firstTickMs: number;
    firstRenderMs: number;
    bodyPasses: number;
    tickMs: number[];
    renderMs: number[];
  } {
    return {
      open: this.miniOpen,
      blend: this.blendState.blend,
      parkedBlend: this.blendState.parked,
      seatedExtentAU: this.miniSeatedExtentAU,
      seatedAspect: this.miniSeatedAspect,
      near: this.miniCamera.near,
      far: this.miniCamera.far,
      opaque: this.miniOpaque,
      firstTickMs: this.miniFirstTickMs,
      firstRenderMs: this.miniFirstRenderMs,
      bodyPasses: this.miniBodyPasses,
      tickMs: this.miniTickMs.slice(),
      renderMs: this.miniRenderMs.slice(),
    };
  }

  private pushPerfSample(buffer: number[], ms: number): void {
    buffer.push(ms);
    if (buffer.length > SystemMap.PERF_SAMPLE_CAPACITY) buffer.shift();
  }

  /** How many frames of corner-chart cost the forensics keep. */
  private static readonly PERF_SAMPLE_CAPACITY = 600;

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
      && !this.blendState.animating
      && !this.needsInitialFrame
      && isAtOverviewFit(
        this.getCameraDistance(),
        fitDistanceAU(this.extentAU, MAP_FOV_DEG, this.camera.aspect),
      );
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    for (const o of this.orbits) o.material.resolution.set(w, h);
    for (const system of this.moonSystems) {
      for (const moon of system.moons) moon.ringMaterial.resolution.set(w, h);
    }
    // The reveal shell and every drawn size are metered in screen px, so a
    // viewport change moves them: let the next frame re-decide rather than
    // carrying the old decision.
    this.projectionRevision++;
    // A viewport change (device rotation, window resize) refits the overview:
    // the vertical FOV is fixed, so portrait fits far less width and the old
    // dolly distance would clip the outer system. Only the parked overview
    // refits — a deliberate zoom keeps its distance, and the dive / scale
    // animation / first-frame fit each own the camera already.
    if (wasAtOverview) {
      const want = fitDistanceAU(this.extentAU, MAP_FOV_DEG, this.camera.aspect);
      this.dollyTo(want);
      this.applyBounds();
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
    this.projectFullView();
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
    else this.applyBounds();
    if (t < 1) return;

    this.cam = mapCameraReduce(this.cam, { kind: 'flyLanded' });
    if (this.cam.camState === 'following' && name) {
      // The camera has stopped flying and started riding. On the small bodies
      // nothing else says so — the flight ends on a marker that never changed
      // size — so the arrival announces itself.
      this.startFocusPulse(name);
      // Land on where the body IS, not where the ease was interpolating toward
      // a frame ago, so the follow starts with a zero delta.
      this.controls.target.copy(this.flyGoalTarget);
      this.camera.position.copy(this.flyGoalPos);
      this.camera.lookAt(this.controls.target);
      this.followPos.copy(this.flyGoalTarget);
      this.applyFollowBounds();
    } else {
      // A release lands with the target lerped back onto the origin, so the
      // free zoom's pivot is parked again along with it.
      this.zoomFree = false;
      this.applyBounds();
      this.rebaseScaleZoomRatio();
    }
    this.syncZoomToCursor();
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
    // The subject's DRAWN radius governs its own shell: the marker is what the
    // camera can see and what the near plane has to clear, and on a moon the
    // marker is many times the true size. (On a planet the two agree once the
    // camera is close enough to have resolved it, which is the only regime a
    // follow runs in.)
    const radius = this.drawnGlobeRadiusAU(name) ?? this.bodyTrueRadiusAU(name);
    if (radius === null || !this.bodyMapPosition(name, this.tmpBodyPos)) return null;
    // The zoom-out ceiling is metered on a radius the camera cannot move: a
    // planet's drawn radius pins to its px floor and grows with depth, so a
    // ceiling metered on it rides the camera out forever. A moon's drawn
    // radius is metered against its parent, not the camera — it stays the
    // honest yardstick (and its inflation is exactly why its shell must be
    // wider than its true size would allow).
    const body = mapBody(name);
    const ceilingRadius = body?.kind === 'moon'
      ? radius
      : this.bodyTrueRadiusAU(name) ?? radius;
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
    const bounds = followBounds(
      radius,
      surface,
      this.camera.position.length(),
      this.tmpBodyPos.length(),
      this.extentAU,
      Math.max(this.renderer.domElement.clientHeight, 1),
      MAP_FOV_DEG,
      this.bodySizeParams,
      ceilingRadius,
      fitDistanceAU(this.extentAU, MAP_FOV_DEG, this.camera.aspect),
      this.tmpBounds,
    );
    return this.clearParentInShell(name, bounds);
  }

  /**
   * Raise a moon's shell until it clears the planet the moon goes around.
   *
   * A shell is one scalar distance about its subject, and the subject is
   * carried around the parent by its own orbit — so a shell that only clears
   * the MOON puts the camera inside the planet at the azimuth where the moon
   * sits between them. The triangle inequality gives the fix in one term: at
   * `minDist ≥ (the moon's drawn offset) + (the parent's drawn reach)`,
   * `|camera − parent| ≥ minDist − offset ≥ reach` for every azimuth at once,
   * the anti-aligned pose included.
   *
   * The declared consequence: a chart follows its moons at chart distance. Io's
   * closest legal pose puts its disc at a handful of px, and the small ones stay
   * inflated markers. The close-up belongs to the world, and the truth to True
   * scale.
   */
  private clearParentInShell(name: string, bounds: MapFollowBounds): MapFollowBounds {
    const body = mapBody(name);
    if (body?.kind !== 'moon' || !body.parentPlanet) return bounds;
    const system = this.moonSystemsByParent.get(body.parentPlanet);
    if (!system) return bounds;
    const offset = this.tmpBodyPos.distanceTo(system.parent.dot.position);
    const parentReach = this.drawnClearanceRadiusAU(body.parentPlanet) ?? 0;
    const floor = offset + parentReach;
    if (floor <= bounds.minDist) return bounds;
    bounds.minDist = floor;
    // A shell has to have room to move in, whatever the floor did to it.
    if (bounds.maxDist < floor * MAP_FOLLOW_MIN_SPREAD) {
      bounds.maxDist = floor * MAP_FOLLOW_MIN_SPREAD;
    }
    return bounds;
  }

  /** Hand the whole bounds transaction to the controls and the camera. */
  private applyFollowBounds(): void {
    const name = this.cam.focusName;
    // Nothing to ride, or a subject the chart cannot place: fall back to the
    // whole-system bounds, which are safe from anywhere.
    const bounds = name ? this.followBoundsFor(name) : null;
    if (!bounds) {
      this.applyBounds();
      return;
    }
    this.applyPolarBand();
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
    return this.nearestDrawnSurface().name;
  }

  /**
   * That same scan, with the distance it measured: the nearest DRAWN surface to
   * the camera anywhere on the chart, and which body it belongs to.
   *
   * Drawn, not true: what the camera has to stay clear of is what is painted,
   * and at the overview a planet's marker is many times its real disc — as is a
   * moon's, and Saturn is drawn wearing an annulus twice its own radius that a
   * true-radius scan would let the camera sit inside. `drawnClearanceRadiusAU`
   * is the one place that figure is decided, so this asks it rather than
   * re-deriving a second, quieter answer.
   *
   * A moon's drawn size and visibility settle in the projection pass, after the
   * moves that read this, so the frame a system appears on is measured with the
   * previous frame's values — the same one-frame lag the drawn reach carries,
   * and at the range a system reveals at the parent dominates anyway. A moon's
   * own orbit ring is protected by its parent's clearance at every depth that
   * matters. The Sun's disc and halo are depth-tested-off billboards and are
   * metered by their centre, so threading past the star can flash its sprite
   * through the near plane.
   *
   * Refills a private scratch: the scan runs per frame on the flight and dive
   * paths, and on every wheel notch.
   */
  private nearestDrawnSurface(): { name: string | null; clearanceDist: number } {
    const out = this.nearestDrawn;
    out.name = null;
    out.clearanceDist = Infinity;
    const sunClearance = this.drawnClearanceRadiusAU(SUN_DATA.name);
    if (sunClearance !== null) {
      out.clearanceDist = this.camera.position.distanceTo(this.sun.position) - sunClearance;
      out.name = SUN_DATA.name;
    }
    for (const entry of this.orbits) {
      const clearance = this.drawnClearanceRadiusAU(entry.planet.name) ?? entry.planet.radiusAU;
      const surface = this.camera.position.distanceTo(entry.dot.position) - clearance;
      if (surface < out.clearanceDist) {
        out.clearanceDist = surface;
        out.name = entry.planet.name;
      }
    }
    // Drawn moons count: inside a revealed system they are the nearest surfaces
    // there are, and their drawn size is many times their true one.
    for (const system of this.moonSystems) {
      if (!system.revealed) continue;
      for (const moon of system.moons) {
        if (!moon.visible) continue;
        const surface = this.camera.position.distanceTo(moon.pos) - moon.drawnRadiusAU;
        if (surface < out.clearanceDist) {
          out.clearanceDist = surface;
          out.name = moon.data.name;
        }
      }
    }
    return out;
  }

  // ---- the crossing above/below -----------------------------------------

  /** Hand the latched hemisphere's polar band to the controls. Called from
   *  every bounds pass — the band is part of what the camera is allowed to do,
   *  and the passes that write the distance clamps are exactly the places that
   *  would otherwise leave a stale one standing. */
  private applyPolarBand(): void {
    mapPolarBand(this.hemisphere, this.polarBand);
    this.controls.minPolarAngle = this.polarBand.min;
    this.controls.maxPolarAngle = this.polarBand.max;
  }

  /**
   * Advance the crossing one frame.
   *
   * The pivot is followed live rather than frozen: a follow crossing rides a
   * body that keeps moving under it, and at a fast clock a pivot snapshotted at
   * the press drifts a visible distance before the 400 ms are up. The offset is
   * the mirror's, so the subject holds its place on screen while the viewer
   * swings under it.
   */
  private advanceFlip(dtMs: number): void {
    const name = this.cam.flipOrigin === 'following' ? this.cam.focusName : null;
    const landed = mapFlipAdvance(this.flipState, dtMs);
    if (name && this.bodyMapPosition(name, this.tmpBodyPos)) {
      this.controls.target.copy(this.tmpBodyPos);
      // The ride resumes with a zero delta whenever this ends.
      this.followPos.copy(this.tmpBodyPos);
    }
    mapFlipOffset(this.flipState, this.tmpFlipOffset);
    this.camera.position.copy(this.controls.target).add(this.tmpFlipOffset);
    this.camera.lookAt(this.controls.target);
    // The clip planes ride the crossing: the camera swings a long way around
    // its subject, and what is nearest changes as it goes.
    if (name) this.applyFocusClip(name, this.nearestBodyName());
    else this.applyBounds();
    if (!landed) return;

    this.cam = mapCameraReduce(this.cam, { kind: 'flipLanded' });
    if (this.cam.camState === 'following') this.applyFollowBounds();
    else this.applyBounds();
    this.syncZoomToCursor();
    this.controls.enabled = true;
    this.controls.update();
  }

  /**
   * End a crossing where it was going, right now.
   *
   * The moves that take the camera somewhere else — a focus, a release, a
   * commit — need a settled pose to leave from, and mid-crossing there is none:
   * the camera can be sitting at an elevation neither hemisphere's band
   * contains, so anything that hands the controls back there is clamped in a
   * visible snap. Landing the crossing first costs the same snap at worst and
   * leaves the state machine, the latch and the bounds all agreeing.
   */
  private settleFlip(): void {
    if (this.cam.camState !== 'flip') return;
    mapFlipSettle(this.flipState);
    this.advanceFlip(0);
  }

  // ---- the free overview zoom -------------------------------------------

  /**
   * Arm or disarm cursor-anchored zoom for the state the controls are being
   * handed back into. Called at every seam that enables them, and after the
   * state is final — a helper that reads the machine mid-change would arm the
   * flag for the view the user just left.
   *
   * The overview is the only state that may have it: a follow rides its subject
   * by translating camera and target together, and a target re-seated under the
   * cursor would detach the ride outright.
   */
  private syncZoomToCursor(): void {
    this.controls.zoomToCursor = this.cam.camState === 'overview';
  }

  /** Whether a zoom gesture arriving right now is the free overview's own. */
  private zoomOwnsPivot(): boolean {
    return this.open && this.controls.enabled && this.cam.camState === 'overview';
  }

  /** Exactly two touches down — the controls' pinch, and nothing else. */
  private isPinchGesture(): boolean {
    if (this.zoomPointers.size !== 2) return false;
    for (const type of this.zoomPointers.values()) if (type !== 'touch') return false;
    return true;
  }

  private onZoomWheel = (): void => {
    // Before the gates: the wheel arrived over the chart, and that is the whole
    // question the hint asks.
    this.zoomGestureSeen = true;
    if (!this.zoomOwnsPivot()) return;
    // The controls themselves ignore a wheel while a gesture is running, and so
    // does this: a pivot moved under a held drag is a re-seat nothing asked for.
    if (this.zoomPointers.size > 0) return;
    this.reseatZoomPivot();
    this.zoomEaseRebase = true;
  };

  /** The same refresh, from the window's capture phase — so it has to check
   *  that the wheel is one the controls will actually dolly. A wheel over the
   *  HUD reaches the window and nothing else, and moving the pivot for it would
   *  leave the latch set on a gesture that never happened. */
  private onZoomWheelBeforeDolly = (e: Event): void => {
    if (e.target !== this.renderer.domElement) return;
    this.onZoomWheel();
  };

  private onZoomPointerDown = (e: PointerEvent): void => {
    this.zoomPointers.set(e.pointerId, e.pointerType);
    // A second finger joining a one-finger rotate starts pinching on its very
    // next move, and that move dollies before anything else could refresh the
    // pivot the rotate left standing.
    if (this.zoomOwnsPivot() && this.isPinchGesture()) {
      this.reseatZoomPivot();
      // The reseat just moved the camera-to-target distance and the first
      // pinch move may be frames away — a live ease re-dollying the old
      // ratio against the new pivot in between is a snap the move's own
      // flag would then preserve. Flag the rebase from the reseat itself.
      this.zoomEaseRebase = true;
    }
  };

  private onZoomPointerUp = (e: PointerEvent): void => {
    this.zoomPointers.delete(e.pointerId);
  };

  private onZoomPointerMove = (): void => {
    if (!this.isPinchGesture()) return;
    this.zoomGestureSeen = true;
    if (!this.zoomOwnsPivot()) return;
    this.reseatZoomPivot();
    this.zoomEaseRebase = true;
  };

  /** Whether the user has zoomed the chart by wheel or pinch since it opened. */
  sawZoomGesture(): boolean {
    return this.zoomGestureSeen;
  }

  /**
   * Seat the zoom's pivot on the nearest drawn surface ahead of the camera.
   *
   * A cursor-anchored dolly moves the camera by a fraction of its pivot radius,
   * so that radius is the entire travel budget: parked on the chart's origin it
   * can only ever spend the distance to the Sun, and anything further off than
   * the opening frame's target plane stays unreachable however small the
   * minimum distance is. Re-seating each event replenishes the budget against
   * the real gap, which is what turns a finite approach into an asymptotic one
   * and stops the zoom passing through a body on the way.
   *
   * Along the VIEW AXIS, so nothing rotates: the target already sits dead ahead
   * and only its distance changes, leaving the controls' own lookAt a no-op.
   * The controls damp one step per update() call, so this never makes one — the
   * next frame's update is where the move is spent.
   *
   * Hands back the shell it measured, because the button path needs exactly
   * that and the scan behind it is not cheap enough to run twice. The figure is
   * the shared overview scratch, so a caller has to spend it before anything
   * else asks for the bounds again.
   */
  private reseatZoomPivot(): MapCameraBounds {
    const clearance = this.nearestDrawnSurface().clearanceDist;
    const bounds = this.overviewBoundsNow(clearance);
    const dist = mapOverviewPivotDistanceAU(clearance, bounds.minDist, bounds.maxDist);
    this.zoomViewDir.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.controls.target.copy(this.camera.position).addScaledVector(this.zoomViewDir, dist);
    this.zoomFree = true;
    return bounds;
  }

  /**
   * Zoom by button notches: positive moves CLOSER, negative further out; the
   * signed count is what lets a held button spend several at once. Returns
   * whether the camera actually moved, which is the hold-repeat's own stop
   * condition — a press that arrives at the clamp reports false and the repeat
   * ends there rather than hammering a shell it cannot leave.
   *
   * Explicitly NOT the wheel's path. The wheel is cursor-anchored, and a button
   * has no cursor to anchor to: routing a press through it would lurch the
   * chart toward wherever the pointer happened to have been left. This dollies
   * along the VIEW AXIS about the point the camera already orbits, so whatever
   * is in the middle of the frame stays in the middle of the frame.
   *
   * At the overview the pivot is re-seated first, exactly as a wheel notch
   * re-seats it: a cursor-anchored or view-axis dolly alike spends a fraction
   * of the pivot radius, so without the re-seat the whole travel budget is the
   * distance to wherever the pivot was last left and the approach stops short
   * of anything further off. While following, the pivot IS the subject and must
   * not move — re-seating it there would detach the ride.
   *
   * Refused outright while a flight or a dive owns the pose: those write the
   * camera every frame, and a press would be overwritten before it drew.
   */
  zoomNotches(notches: number): boolean {
    if (!this.open || !this.controls.enabled) return false;
    if (!Number.isFinite(notches) || notches === 0) return false;
    if (this.cam.camState === 'overview') {
      const bounds = this.reseatZoomPivot();
      const moved = this.dollyNotch(notches, bounds.minDist, bounds.maxDist, false);
      // A live scale animation re-dollies every frame to the ratio captured
      // at the toggle, so a distance this press just chose would be restored
      // on the very next frame — the press would visibly snap back. Rebase to
      // the pressed framing and the animation preserves it like any other.
      // After a refused notch too: the re-seat above moved the pivot the
      // distance is measured against, and the old ratio against the new pivot
      // would step the camera for a press that did nothing.
      this.rebaseScaleZoomRatio();
      return moved;
    }
    if (this.cam.camState === 'following') {
      const name = this.cam.focusName;
      const bounds = name ? this.followBoundsFor(name) : null;
      if (!bounds) return false;
      return this.dollyNotch(notches, bounds.minDist, bounds.maxDist, true);
    }
    return false;
  }

  /** One notch against a shell already measured. The bounds arrive as plain
   *  numbers because both callers hand over a shared scratch that the re-apply
   *  below is about to refill. */
  private dollyNotch(
    notches: number,
    minDist: number,
    maxDist: number,
    following: boolean,
  ): boolean {
    const dist = this.getCameraDistance();
    if (!mapZoomNotchAvailable(dist, notches, minDist, maxDist)) return false;
    this.dollyTo(mapZoomNotchDistanceAU(dist, notches, minDist, maxDist));
    if (following) this.applyFollowBounds();
    else this.applyBounds();
    this.controls.update();
    return true;
  }

  /**
   * Which way the zoom buttons may still go, filled into the caller's scratch.
   *
   * Answered from the bounds themselves, never from the controls' own
   * `minDistance`/`maxDistance`: those are rewritten from these every frame and
   * lag by one, so a button painted from them would flicker as the chart
   * breathes under a moving camera. Both false while a flight or a dive owns
   * the pose — nothing a press did would survive the next frame.
   */
  zoomAvailability(out: MapZoomAvailability): MapZoomAvailability {
    out.zoomIn = false;
    out.zoomOut = false;
    if (!this.open || !this.controls.enabled) return out;
    if (this.cam.camState === 'overview') {
      const bounds = this.overviewBoundsNow(this.nearestDrawnSurface().clearanceDist);
      return mapZoomAvailability(this.getCameraDistance(), bounds.minDist, bounds.maxDist, out);
    }
    if (this.cam.camState === 'following') {
      const name = this.cam.focusName;
      const bounds = name ? this.followBoundsFor(name) : null;
      if (!bounds) return out;
      return mapZoomAvailability(this.getCameraDistance(), bounds.minDist, bounds.maxDist, out);
    }
    return out;
  }

  /** The orbit entry that draws a planet, or null for anything that is not one
   *  (the Sun, a moon, a name the chart does not know). The one place a body
   *  name is resolved among the drawn planets — a map read, because the zoom
   *  buttons' availability refresh routes the whole roster through here every
   *  frame and a search would allocate its predicate each call. */
  private entryFor(name: string): OrbitEntry | null {
    return this.orbitsByName.get(name) ?? null;
  }

  /** Whether the camera may be flown to, follow, or dive at this body: the
   *  policy is mapBodyAcceptsCamera, and what this scene DRAWS is the Sun plus
   *  the planets it built orbit entries for. Resolution stays open to every
   *  body in the roster — position, radius, tint, the probe — and only the
   *  camera is held to the narrower set. */
  private cameraMayVisit(name: string): boolean {
    return mapBodyAcceptsCamera(name, (n) => {
      if (this.entryFor(n) !== null) return true;
      // A moon of a system this map builds: it has a shell that clears its
      // parent, and aiming at one reveals its system on the way, so it is drawn
      // by the time the camera arrives.
      const body = mapBody(n);
      return body?.kind === 'moon' && !!body.parentPlanet
        && this.moonSystemsByParent.has(body.parentPlanet);
    });
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
    const system = body.parentPlanet
      ? this.moonSystemsByParent.get(body.parentPlanet) ?? null
      : null;
    if (!system) return null;
    // A drawn moon is wherever the chart put it this frame.
    const drawn = this.moonEntryFor(name);
    if (drawn && system.revealed) return out.copy(drawn.pos);
    // Otherwise chart it on the spot, by the same arithmetic — a focus has to
    // be able to aim at a moon the frame before its system appears.
    return this.chartMoonPosition(system, name, out);
  }

  /** Where the chart puts a moon right now: its parent, plus its direction at
   *  the policy's charted distance, in the units the group carries. The one
   *  place that arithmetic is written down, so an unrevealed system and a drawn
   *  one can never disagree. */
  private chartMoonPosition(
    system: MoonSystem,
    moonName: string,
    out: THREE.Vector3,
  ): THREE.Vector3 | null {
    const trueR = system.parent.planet.radiusAU;
    if (!(trueR > 0)) return null;
    computeMoonOffsetEquatorialAU(
      moonName, system.parent.planet.name, this.clockUtcMs, this.tmpMoonOffset,
    );
    const distAU = Math.max(this.tmpMoonOffset.length(), 1e-30);
    const x = distAU / trueR;
    const scaleAU = Math.max(trueR, this.planetDrawnGlobeRadiusAU(system.parent));
    const scaleBlended = scaleAU + (trueR - scaleAU) * this.blend;
    const charted = this.blend >= MAP_BLEND_TRUE
      ? x
      : mapMoonOffsetR(system.policy, x) * (1 - this.blend) + x * this.blend;
    this.tmpMoonOffset.divideScalar(distAU);
    return out.copy(system.parent.dot.position)
      .addScaledVector(this.tmpMoonOffset, charted * scaleBlended);
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
   *  Both looks now measure the same body. A dot is drawn from the size policy's
   *  radius exactly as the globe is, so the figure is continuous across the swap
   *  by construction rather than by two rules that happen to agree: a hovered
   *  dot carries its swell, a globe carries its ring, and neither steps.
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
    // The stored drawn radius, in AU at the dot's own depth. Framing to the
    // policy radius rather than to the sprite's full half-extent is deliberate:
    // the quad's outer third is the gradient fading to nothing, and budgeting
    // frame for an invisible halo would push every flight further out than the
    // picture needs. The label offset reads the same stored radius and takes
    // the half-extent instead — not a disagreement about size, a different
    // question: legible glyphs need air from anything painted, a frame needs
    // room for what is visible. A hovered dot swells by the factor its material
    // does.
    const hoverBoost = name === this.hoveredName ? HOVER_SCALE : 1;
    return entry.drawnRadiusPx * hoverBoost * perPx * this.viewDepth(entry.dot.position);
  }

  /** The globe radius the size policy gives a body at the current pose: its
   *  true size once the camera can resolve it, its chart marker while it
   *  cannot. Null for a body the chart cannot place or size. */
  private drawnGlobeRadiusAU(name: string): number | null {
    const body = mapBody(name);
    if (body?.kind === 'moon') {
      // A moon is sized against its parent, not against the chart, so its
      // policy is its parent's drawn radius and its own true size.
      const system = body.parentPlanet
        ? this.moonSystemsByParent.get(body.parentPlanet) ?? null
        : null;
      if (!system) return null;
      return mapMoonRadiusAU(body.radiusAU, this.parentDrawnRadiusAU(system));
    }
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

  // ---- moon systems ------------------------------------------------------

  /** The moon entry for a name, or null. Built systems only — an unrevealed
   *  system has a policy but no meshes yet. */
  private moonEntryFor(name: string): MoonEntry | null {
    return this.moonsByName.get(name) ?? null;
  }

  /** The system a body belongs to: a moon's parent, or a planet's own name. */
  private systemOwnerOf(name: string | null): string | null {
    if (!name) return null;
    const body = mapBody(name);
    if (!body) return null;
    return body.kind === 'moon' ? body.parentPlanet : body.name;
  }

  /** The parent's drawn globe radius — what a moon is sized and charted
   *  against, and the one number the camera enters a moon system through. */
  private parentDrawnRadiusAU(system: MoonSystem): number {
    return this.planetDrawnGlobeRadiusAU(system.parent);
  }

  /** A planet's drawn globe radius from its built entry, without going through
   *  a name. The moon pipeline asks for this per system per frame. */
  private planetDrawnGlobeRadiusAU(entry: OrbitEntry): number {
    return mapBodyRadiusAU(
      entry.planet.radiusAU,
      this.viewDepth(entry.dot.position),
      mapWorldPerPxAtUnitDepth(Math.max(this.renderer.domElement.clientHeight, 1), MAP_FOV_DEG),
      this.bodySizeParams,
    );
  }

  /** How far the camera may be from a parent and still see its moons: the
   *  CLAMPED distance a focus on it lands at, with margin. Deriving it from the
   *  same clamp the flight uses makes "a focus always reveals the system" true
   *  by construction — a raw reveal distance would leave the near-floor-bound
   *  parents (Pluto, whose landing sits at more than twice its raw reveal) with
   *  a system that never appears. */
  /** That same shell for the system a body owns — the parent of a moon, or a
   *  planet's own — and 0 for a body with no system at all. What the probe
   *  reports, so a test can assert an approach against the real figure instead
   *  of rebuilding this policy alongside it. */
  private moonRevealDistanceForOwner(name: string): number {
    const owner = this.systemOwnerOf(name);
    const system = owner ? this.moonSystemsByParent.get(owner) : null;
    return system ? this.moonRevealDistanceAU(system) : 0;
  }

  private moonRevealDistanceAU(system: MoonSystem): number {
    const h = Math.max(this.renderer.domElement.clientHeight, 1);
    const raw = moonRevealThresholdAU(system.parent.planet.radiusAU, h, MAP_FOV_DEG);
    const bounds = this.followBoundsFor(system.parent.planet.name);
    return Math.max(raw, bounds ? bounds.minDist : 0) * MOON_REVEAL_MARGIN;
  }

  /**
   * Phase (1) for the moons: reveal, place, orient, and keep the drawn orbits
   * fresh. Runs on the PREVIOUS frame's camera like every other position, which
   * is what keeps the units scalar out of a feedback loop with the camera that
   * follows a moon.
   */
  private updateMoons(utcMs: number): void {
    if (this.moonSystems.length === 0) return;
    // Nothing moved: not the clock, not the blend, not the camera. A chart
    // being read is the normal state, and it should cost nothing.
    const still = utcMs === this.moonKeyUtcMs
      && this.blend === this.moonKeyBlend
      && this.projectionRevision === this.moonKeyRevision
      && this.camera.position.equals(this.moonKeyCam);
    if (still) {
      // Positions are settled; a ring that has never been filled is not. The
      // fill budget is one per frame, so a reveal on a slow device can land the
      // camera with orbits still missing — and they would then wait forever on
      // a pass that has nothing left to do.
      this.fillOneMoonRing(utcMs);
      return;
    }
    const blendMoved = this.blend !== this.moonKeyBlend;
    this.moonKeyUtcMs = utcMs;
    this.moonKeyBlend = this.blend;
    this.moonKeyRevision = this.projectionRevision;
    this.moonKeyCam.copy(this.camera.position);
    this.moonPasses++;

    const trueScale = this.blend >= MAP_BLEND_TRUE;
    const focusSystem = this.systemOwnerOf(this.cameraSubject());

    for (const system of this.moonSystems) {
      const parent = system.parent;
      const parentPos = parent.dot.position;
      const revealed = focusSystem === parent.planet.name
        || this.camera.position.distanceTo(parentPos) < this.moonRevealDistanceAU(system);
      if (revealed && !system.built) this.buildMoonSystem(system);
      system.revealed = revealed;
      system.group.visible = revealed;
      if (!revealed) {
        for (const moon of system.moons) {
          // Let the borrowed texture go with the system. The world is free to
          // dispose it while nobody is drawing it, and the map holds no
          // reference it does not re-read — the same rule close() follows.
          this.adoptTexture(moon.globeMat, null);
          this.hideMoon(moon);
        }
        continue;
      }

      // The one camera-dependent number in the whole moon pipeline, and it is a
      // scalar: AU per parent drawn radius. Everything the policy produces is
      // in those units, so the offsets never re-decide anything as the camera
      // moves — the group scale carries it.
      const trueR = parent.planet.radiusAU;
      system.offsetScaleAU = Math.max(trueR, this.parentDrawnRadiusAU(system));
      system.scaleBlended = system.offsetScaleAU
        + (trueR - system.offsetScaleAU) * this.blend;
      system.group.position.copy(parentPos);
      system.group.scale.setScalar(system.scaleBlended);

      for (const moon of system.moons) {
        computeMoonOffsetEquatorialAU(
          moon.data.name, parent.planet.name, utcMs, this.tmpMoonOffset, this.tmpMoonNormal,
        );
        const distAU = this.tmpMoonOffset.length();
        moon.trueDistAU = distAU;
        moon.x = distAU / trueR;
        moon.dir.copy(this.tmpMoonOffset).divideScalar(Math.max(distAU, 1e-30));
        // Eclipse shading TARGET, from the same two positions the offset above
        // is built from — the parent's real heliocentric place and the moon's
        // real offset from it, never the compressed ones a chart draws. Only
        // the sky moves it, which is why the still-frame skip above is safe:
        // what has to keep moving on a settled chart is the APPLIED value, and
        // that is advanced in the drawn-size pass. The world caches its own
        // shading for the moons it is drawing; those are the near system's
        // only, so the chart computes its own for every system it charts.
        computeMoonShading(
          this.tmpParentHelio.set(parent.helioX, parent.helioY, parent.helioZ),
          parent.planet.name,
          parent.planet.radiusKm,
          this.tmpMoonOffset,
          moon.data.radiusKm,
          this.tmpShading,
        );
        moon.shade.shadeTarget = this.tmpShading.sunVisibleFraction;
        moon.offsetR = mapMoonOffsetR(system.policy, moon.x);
        // True scale keys off the LIVE blend, not the committed target: the
        // offsets slide with the animation rather than snapping when it starts.
        // (The globe/dot look deliberately does the opposite — it settles on
        // the gesture that asked for it.) At blend 1 this is x exactly, and the
        // group's scale is the parent's TRUE radius exactly, so the product is
        // the raw AU offset by construction rather than by arithmetic.
        const rGroup = trueScale
          ? moon.x
          : moon.offsetR + (moon.x - moon.offsetR) * this.blend;
        moon.pos.copy(parentPos).addScaledVector(moon.dir, rGroup * system.scaleBlended);
        moon.dot.position.copy(moon.pos);
        moon.globe.position.copy(moon.pos);
        // Orientation per entry, so a moon revealed while the clock is paused
        // is oriented on the spot instead of waiting for time to move.
        if (moon.orientedUtcMs !== utcMs) {
          // Through the shared roll selection, not the raw orbit normal: Earth's
          // Moon is levelled on ecliptic north, and the chart has to agree with
          // the window about which way a face is turned.
          tidalRollNorth(
            moon.data.name, parent.planet.name, this.tmpMoonNormal, this.tmpMoonNormal,
          );
          if (tidalLockQuaternion(this.tmpMoonOffset, this.tmpMoonNormal, this.tmpMoonQuat)) {
            moon.globe.quaternion.copy(this.tmpMoonQuat);
          }
          moon.orientedUtcMs = utcMs;
        }
        // A blend frame rewrites the ring vertices in place — the one case that
        // touches the buffers without going near the ephemeris.
        if (moon.ringFilled && (blendMoved || moon.ringBlend !== this.blend)) {
          this.writeMoonRing(system, moon);
        }
      }
    }

    this.fillOneMoonRing(utcMs);
  }

  /**
   * At most one ring is filled or refilled per frame, first fills included: a
   * just-revealed Saturn is eighteen orbits' worth of ephemeris, and doing them
   * in one frame is the stall the budget exists to prevent. The moons
   * themselves are placed immediately — positions are cheap — so the system
   * appears at once and only its orbits stagger in.
   *
   * This runs every frame, not only on the frames the position pass does: an
   * unfilled ring is work outstanding whatever the camera and the clock are
   * doing, and the settled chart is exactly where a missing orbit would sit
   * unfinished forever. Overdue by the widest margin goes first, among the
   * rings the refill cadence lets through (MOON_RING_MIN_REFILL_MS).
   *
   * Two locals rather than a candidate object: this is a per-frame path, and
   * the object it used to build was one allocation a frame forever.
   */
  private fillOneMoonRing(utcMs: number): void {
    const nowMs = performance.now();
    let system: MoonSystem | null = null;
    let moon: MoonEntry | null = null;
    let candidateFilled = false;
    let worst = 1;
    for (const sys of this.moonSystems) {
      if (!sys.revealed) continue;
      for (const entry of sys.moons) {
        // One policy call for BOTH classes — the first-fill exemption and the
        // cadence floor live in ringRefillDue, not in this loop's shape.
        if (!ringRefillDue(entry.ringFilled, nowMs, entry.ringFilledAtMs, MOON_RING_MIN_REFILL_MS)) {
          continue;
        }
        if (!entry.ringFilled) {
          if (!system) {
            system = sys;
            moon = entry;
            candidateFilled = false;
          }
          continue;
        }
        const ageDays = Math.abs(utcMs - entry.ringSampledUtcMs) / 86_400_000;
        const urgency = (ageDays * entry.ringDriftDegPerDay) / MOON_RING_DRIFT_LIMIT_DEG;
        if (urgency > worst) {
          worst = urgency;
          if (!system || candidateFilled) {
            system = sys;
            moon = entry;
            candidateFilled = true;
          }
        }
      }
    }
    if (system && moon) this.fillMoonRing(system, moon, utcMs, nowMs);
  }

  /** Sample one moon's orbit through the shared ephemeris seam and hand the
   *  samples to the ring. Kept as unit directions plus true x, so every later
   *  reprojection — a scale blend, a retuned policy — is arithmetic. */
  private fillMoonRing(
    system: MoonSystem,
    moon: MoonEntry,
    utcMs: number,
    nowMs: number,
  ): void {
    const parentName = system.parent.planet.name;
    const trueR = system.parent.planet.radiusAU;
    for (let i = 0; i <= MOON_RING_SEGMENTS; i++) {
      const t = utcMs + (i / MOON_RING_SEGMENTS) * moon.ringPeriodMs;
      computeMoonOffsetEquatorialAU(moon.data.name, parentName, t, this.tmpMoonOffset);
      const d = Math.max(this.tmpMoonOffset.length(), 1e-30);
      moon.ringDirs[i * 3] = this.tmpMoonOffset.x / d;
      moon.ringDirs[i * 3 + 1] = this.tmpMoonOffset.y / d;
      moon.ringDirs[i * 3 + 2] = this.tmpMoonOffset.z / d;
      moon.ringX[i] = d / trueR;
    }
    moon.ringSampledUtcMs = utcMs;
    moon.ringFilledAtMs = nowMs;
    moon.ringFilled = true;
    this.writeMoonRing(system, moon);
  }

  /** Project the sampled orbit into the ring's buffer, in parent-radii units.
   *  The group's position and scale do the rest, so this is the only place the
   *  policy touches geometry. */
  private writeMoonRing(system: MoonSystem, moon: MoonEntry): void {
    const trueScale = this.blend >= MAP_BLEND_TRUE;
    const attr = moon.ringGeometry.attributes.instanceStart as THREE.InterleavedBufferAttribute;
    const arr = attr.data.array as Float32Array;
    let prevX = 0;
    let prevY = 0;
    let prevZ = 0;
    for (let i = 0; i <= MOON_RING_SEGMENTS; i++) {
      const x = moon.ringX[i];
      const charted = trueScale
        ? x
        : mapMoonOffsetR(system.policy, x) * (1 - this.blend) + x * this.blend;
      const px = moon.ringDirs[i * 3] * charted;
      const py = moon.ringDirs[i * 3 + 1] * charted;
      const pz = moon.ringDirs[i * 3 + 2] * charted;
      if (i > 0) {
        const o = (i - 1) * 6;
        arr[o] = prevX;
        arr[o + 1] = prevY;
        arr[o + 2] = prevZ;
        arr[o + 3] = px;
        arr[o + 4] = py;
        arr[o + 5] = pz;
      }
      prevX = px;
      prevY = py;
      prevZ = pz;
    }
    attr.data.needsUpdate = true;
    moon.ringBlend = this.blend;
    this.moonRingWrites++;
  }

  /** Forget every occlusion latch. The latches are a hysteresis band's memory
   *  under ONE camera; the full↔mini handover swaps cameras (and a reopen may
   *  be minutes of simulation later), so an answer held across either boundary
   *  is a band from somewhere else on screen — even when the draw mode happens
   *  to agree. Both open seams re-judge from scratch; false is the forgiving
   *  seed, resolving toward drawn the way the limb rule does. */
  private resetOcclusionLatches(): void {
    for (const entry of this.orbits) entry.occluded = false;
    for (const system of this.moonSystems) {
      for (const moon of system.moons) {
        moon.occluded = false;
        moon.occludedByParent = false;
        moon.occludedBySun = false;
      }
    }
  }

  private hideMoon(moon: MoonEntry): void {
    moon.visible = false;
    moon.globeDrawn = false;
    // The occlusion latches go with it: they are a hysteresis band's memory,
    // and a moon that stops being drawn has nothing to remember.
    moon.occluded = false;
    moon.occludedByParent = false;
    moon.occludedBySun = false;
    moon.dot.renderOrder = MARKER_RENDER_ORDER;
    // A moon that stops being drawn forgets what it was shaded at, so the next
    // time it appears it arrives at its true shading rather than ramping there
    // from whatever the sky looked like when it left.
    resetMapShade(moon.shade);
    if (moon.dot.visible) moon.dot.visible = false;
    if (moon.globe.visible) moon.globe.visible = false;
    if (moon.label && moon.label.style.display !== 'none') moon.label.style.display = 'none';
  }

  /** Build one system's meshes, the first time it is revealed. */
  private buildMoonSystem(system: MoonSystem): void {
    if (system.built) return;
    system.built = true;
    const el = this.renderer.domElement;
    const parentName = system.parent.planet.name;
    for (const data of getMoonsByPlanet(parentName)) {
      const tint = new THREE.Color(data.color);
      const dot = this.makeGlowSprite(data.color);
      dot.renderOrder = MARKER_RENDER_ORDER;
      dot.visible = false;
      this.scene.add(dot);
      // Transparent at full opacity for the same reason as the planets': a
      // floored moon globe composites by the marker orders, and the flag has
      // to be constant so the shader's identity is.
      const globeMat = new THREE.MeshStandardMaterial({
        roughness: 0.95,
        metalness: 0,
        transparent: true,
      });
      const globeShading = augmentMapGlobeMaterial(globeMat, this.sunUniforms);
      const globe = new THREE.Mesh(this.moonGeo, globeMat);
      globe.renderOrder = GLOBE_RENDER_ORDER;
      globe.visible = false;
      this.scene.add(globe);

      const ringGeometry = new LineGeometry();
      ringGeometry.setPositions(new Float32Array((MOON_RING_SEGMENTS + 1) * 3));
      const ringMaterial = new LineMaterial({
        color: data.color,
        linewidth: 1,
        transparent: true,
        opacity: MOON_RING_OPACITY,
        depthTest: true,
        depthWrite: false,
        toneMapped: false,
      });
      ringMaterial.resolution.set(Math.max(el.clientWidth, 1), Math.max(el.clientHeight, 1));
      const ring = new Line2(ringGeometry, ringMaterial);
      // After the spheres, whose written depth is what ends this orbit at the
      // limb of the body it wraps — see the render-order ladder note.
      ring.renderOrder = ORBIT_LINE_RENDER_ORDER;
      ring.frustumCulled = false;
      system.group.add(ring);

      const orbit = getMoonDisplayOrbit(data.name, parentName);
      const meta = data.name === 'Moon' && parentName === 'Earth'
        ? EARTH_MOON_ORBIT_META
        : getSatelliteOrbitMeta(data.name);
      const moon: MoonEntry = {
        data,
        dot,
        globe,
        globeMat,
        globeShading,
        baseColor: tint,
        pos: new THREE.Vector3(),
        dir: new THREE.Vector3(1, 0, 0),
        x: 0,
        trueDistAU: 0,
        offsetR: 0,
        drawnRadiusAU: 0,
        drawnRadiusPx: 0,
        globeDrawn: false,
        visible: false,
        occluded: false,
        occludedByParent: false,
        occludedBySun: false,
        orientedUtcMs: Number.NaN,
        shade: makeMapShadeState(),
        ring,
        ringGeometry,
        ringMaterial,
        ringDirs: new Float32Array((MOON_RING_SEGMENTS + 1) * 3),
        ringX: new Float32Array(MOON_RING_SEGMENTS + 1),
        ringFilled: false,
        ringSampledUtcMs: 0,
        ringFilledAtMs: Number.NEGATIVE_INFINITY,
        ringBlend: Number.NaN,
        // Node plus apsides: how fast the drawn shape itself turns. A moon whose
        // fit carries no secular rates falls back to a sim-time bound.
        ringDriftDegPerDay: Math.max(
          meta.nodeRateDegPerDay + meta.apsisRateDegPerDay,
          MOON_RING_DRIFT_LIMIT_DEG / MOON_RING_MAX_AGE_DAYS,
        ),
        ringPeriodMs: Math.max(orbit.periodDays, 1e-3) * 86_400_000,
        label: this.labelContainer ? this.makeLabel(data.name) : null,
      };
      if (moon.label) this.labels.set(data.name, moon.label);
      system.moons.push(moon);
      this.moonsByName.set(data.name, moon);
    }
  }

  /** Phase (3) for the moons: how big each one draws, whether it is a globe,
   *  a marker, or — at true scale, inside its parent's limb — nothing at all,
   *  and how deep in its parent's shadow it is drawn. `impostorScale` — whether
   *  this pass is anywhere on the true side of the scale blend, which is where
   *  a policy-floored globe composites as a depth-free marker; the planet pass
   *  derives it and hands it down. */
  private updateMoonDrawnSizes(
    worldPerPxAtUnit: number,
    trueScaleTarget: boolean,
    impostorScale: boolean,
  ): void {
    // One wall-clock reading for the whole pass: the shading limiter measures
    // real time, and every moon on the chart is being drawn in the same frame.
    const shadeNowMs = performance.now();
    for (const system of this.moonSystems) {
      if (!system.revealed) continue;
      const parentDrawnAU = this.parentDrawnRadiusAU(system);
      const parentPos = system.parent.dot.position;
      // The parent as the occlusion gate sees it — read out of the scratch
      // before the first moon claims it. Its DRAWN MODE is what matters, not
      // its size: a planet the chart is still drawing as a marker is a symbol,
      // and moons pass in front of and behind a symbol alike. Its drawn px
      // radius is the one the planet pass just sized its globe to.
      const parentView = this.viewSpace(parentPos);
      const parentViewX = parentView.x;
      const parentViewY = parentView.y;
      const parentDepth = Math.max(-parentView.z, 1e-6);
      const parentDraws = system.parent.globeDrawn;
      const parentDiscPx = system.parent.drawnRadiusPx;
      for (const moon of system.moons) {
        const moonView = this.viewSpace(moon.pos);
        const viewX = moonView.x;
        const viewY = moonView.y;
        const depth = Math.max(-moonView.z, 1e-6);
        const worldPerPx = Math.max(worldPerPxAtUnit * depth, 1e-30);
        const drawnAU = mapMoonRadiusAU(moon.data.radiusAU, parentDrawnAU);
        moon.drawnRadiusAU = drawnAU;
        moon.drawnRadiusPx = drawnAU / worldPerPx;
        // At true scale a system collapses toward its parent, and a moon closer
        // to the limb than a couple of px is inside the limb's own pixel. The
        // separation is metered in the moon's own depth, which is the same
        // small-angle projection the sizes use.
        let visible = true;
        if (trueScaleTarget) {
          const sepPx = (moon.pos.distanceTo(parentPos) - parentDrawnAU) / worldPerPx;
          visible = sepPx > MOON_TRUE_SCALE_MIN_SEP_PX;
        }
        const truePx = moon.data.radiusAU / worldPerPx;
        const markerPx = mapMoonMarkerRadiusAU(moon.data.radiusAU, parentDrawnAU) / worldPerPx;
        const globe = visible && mapBodyDrawMode(
          moon.globeMat.map !== null,
          trueScaleTarget,
          truePx,
          markerPx,
        ) === 'globe';
        // Same rule as the planets': a policy-floored globe composites as a
        // marker for as long as the pass is on the true side of the blend.
        const floored = impostorScale && truePx < markerPx;
        moon.visible = visible;
        moon.globeDrawn = globe;
        // Behind the parent's globe, or behind the star. A marker writes no
        // depth and would otherwise glide across a lit face it is nowhere near
        // — a transit that is not happening, while the moon's own depth-tested
        // orbit ring correctly dies at the limb. `visible` is untouched: the
        // moon is still a drawn surface for the camera to clear, and still what
        // a zoom pivots on. The latches run before the globe's visibility is
        // written, because a floored globe hides behind them like its dot.
        const parentSepPx = markerSeparationPx(
          viewX, viewY, depth, parentViewX, parentViewY, parentDepth, worldPerPxAtUnit,
        );
        const sunSepPx = markerSeparationPx(
          viewX, viewY, depth,
          this.sunViewX, this.sunViewY, this.sunViewDepth,
          worldPerPxAtUnit,
        );
        moon.occludedByParent = visible && markerBehindDisc(
          parentDraws, depth, moon.drawnRadiusPx,
          parentDepth, parentDiscPx, parentSepPx, moon.occludedByParent,
        );
        moon.occludedBySun = visible && markerBehindDisc(
          true, depth, moon.drawnRadiusPx,
          this.sunViewDepth, this.sunDiscPx, sunSepPx, moon.occludedBySun,
        );
        moon.occluded = moon.occludedByParent || moon.occludedBySun;
        moon.globe.visible = globe && !(floored && moon.occluded);
        moon.dot.visible = visible && !globe && !moon.occluded;
        // The lift is judged at the widest footprint the dot could paint this
        // frame: the sprite's own half-extent (DOT_EXTENT_MUL/2 of the policy
        // radius, which bounds the gradient whatever its profile) at the hover
        // swell — or a dot at the disc's edge could overlap the star under it.
        moon.dot.renderOrder = markerInFrontOfDisc(
          true, depth, moon.drawnRadiusPx * (DOT_EXTENT_MUL / 2) * HOVER_SCALE,
          this.sunViewDepth, this.sunDiscPx, sunSepPx,
        )
          ? MARKER_OVER_SUN_RENDER_ORDER
          : MARKER_RENDER_ORDER;
        if (globe) {
          moon.globe.scale.setScalar(drawnAU);
          moon.globeShading.softness.value = mapTerminatorSoftness(moon.drawnRadiusPx);
          this.setGlobeCompositing(
            moon.globeMat,
            moon.globe,
            floored,
            floored && markerInFrontOfDisc(
              true, depth, moon.drawnRadiusPx,
              this.sunViewDepth, this.sunDiscPx, sunSepPx,
            ),
          );
        } else {
          moon.dot.scale.setScalar(drawnAU * DOT_EXTENT_MUL);
        }
        // Eclipse dim, advanced here because this pass runs on every rendered
        // frame: the limiter is a wall-clock ramp, and one that only stepped
        // when the sky moved would stall half-dark under a paused clock.
        // Its own channel, written absolutely: the marker's opacity and the
        // globe's albedo scalar belong to the shadow, while emphasis keeps the
        // marker's tint and the globe's emissive. Nothing accumulates, so a
        // still chart re-writing the same value every frame is a no-op.
        const dim = advanceMapShade(moon.shade, shadeNowMs);
        (moon.dot.material as THREE.SpriteMaterial).opacity = dim;
        moon.globeMat.color.setScalar(dim);
      }
    }
  }

  /** Adopt whatever the world has painted for each revealed moon. Same contract
   *  as the planets': borrow by identity, dispose nothing. An unpainted moon
   *  keeps its tinted marker — the never-show-unpainted gate governs painted
   *  SURFACES, and a chart still owes you the body. */
  private syncMoonTextures(): void {
    for (const system of this.moonSystems) {
      if (!system.revealed) continue;
      for (const moon of system.moons) {
        this.adoptTexture(moon.globeMat, this.textures.colorMap(moon.data.name));
      }
    }
  }

  /**
   * The body the camera is aimed at: what a focus is riding, or what a dive is
   * flying toward. The dive is the case worth naming — the state machine clears
   * the focus when a dive starts, so a system asked for by nothing but a commit
   * would go unrevealed and the whole transition would ease toward a body that
   * is not drawn. It is the same rule either way: wherever the camera is going,
   * that system is up.
   */
  private cameraSubject(): string | null {
    return this.cam.focusName ?? (this.diving ? this.diveFocusName : null);
  }

  /** Which system the map most wants painted next: the one the camera is aimed
   *  at, else the nearest revealed one. The painter's own queue and budget
   *  decide the rest — this is a preference, not a demand. */
  preferredPaintSystem(): string | null {
    const focus = this.systemOwnerOf(this.cameraSubject());
    if (focus && this.moonSystemsByParent.has(focus)) return focus;
    let best: string | null = null;
    let bestDist = Infinity;
    for (const system of this.moonSystems) {
      if (!system.revealed) continue;
      const d = this.camera.position.distanceTo(system.parent.dot.position);
      if (d < bestDist) {
        bestDist = d;
        best = system.parent.planet.name;
      }
    }
    return best;
  }

  /** Dev bridge: retune the offset policy live. Every built ring is reprojected
   *  on the next frame, since all of them are derived from these numbers. */
  setMoonOffsetParams(partial: Partial<MapMoonOffsetParams> | null): boolean {
    if (!setMapMoonOffsetParams(partial)) return false;
    for (const system of this.moonSystems) {
      system.policy = moonOffsetPolicyFor(system.parent.planet.name);
      for (const moon of system.moons) moon.ringBlend = Number.NaN;
    }
    this.projectionRevision++;
    return true;
  }

  /** How far a marker's tint has been lifted off its catalog base, 0 when it
   *  is sitting at rest. */
  private markerLiftOf(sprite: THREE.Sprite, base: THREE.Color): number {
    const c = (sprite.material as THREE.SpriteMaterial).color;
    return Math.max(
      Math.abs(c.r - base.r), Math.abs(c.g - base.g), Math.abs(c.b - base.b),
    );
  }

  /** Dev forensics: the moon pipeline's counters, for the perf gates. */
  moonStats(): {
    ringWrites: number;
    passes: number;
    revealed: string[];
    drawn: number;
    anchorBuilds: number;
    anchors: number;
    /** Every drawn moon by name, so a check can cover the whole system rather
     *  than a chosen handful. */
    drawnMoons: string[];
    /** Per revealed system: how far its OUTERMOST drawn orbit reaches from its
     *  parent, in map AU. The rings are the deepest thing a revealed system
     *  puts on screen, and they are geometry no moon's centre stands in for. */
    ringReachAU: Record<string, number>;
  } {
    const revealed: string[] = [];
    const drawnMoons: string[] = [];
    const ringReachAU: Record<string, number> = {};
    let drawn = 0;
    for (const system of this.moonSystems) {
      if (!system.revealed) continue;
      revealed.push(system.parent.planet.name);
      ringReachAU[system.parent.planet.name] = this.systemRingReachAU(system);
      for (const moon of system.moons) {
        if (!moon.visible) continue;
        drawn++;
        drawnMoons.push(moon.data.name);
      }
    }
    return {
      ringWrites: this.moonRingWrites,
      passes: this.moonPasses,
      revealed,
      drawn,
      anchorBuilds: this.anchorBuilds,
      anchors: this.pickAnchors.length,
      drawnMoons,
      ringReachAU,
    };
  }

  // ---- picking / hover / dive ------------------------------------------

  /** Nearest actionable body (or the inert ship) under a screen tap. The
   *  anchors rebuild here, on the event, so steady-state stays allocation-free. */
  pick(x: number, y: number, pointerType: string): PickResult {
    this.rebuildPickAnchors();
    return resolvePick(x, y, this.pickAnchors, pickRadiusFor(pointerType));
  }

  /**
   * The pickable body under the cursor, for fine-pointer hover feedback,
   * against the anchors as they stand THIS frame — the whole reason the latch
   * asks every frame is that the bodies move under a cursor that is not
   * moving, and an anchor set cached across frames would answer with where they
   * used to be.
   *
   * Hover picks up on a tighter floor than a tap: emphasis on a body the cursor
   * is merely near would name one thing while a click committed another. A body
   * drawn wider than the floor still answers on its own limb.
   */
  /** Whether the limb gate currently hides this body. The hover HOLD asks
   *  before bridging a miss: a hold exists to ride out pointer jitter, and a
   *  body that slid behind its parent or the Sun mid-hold must release
   *  immediately — its anchor is gone, and bridging would let a tap open a
   *  body nothing on screen shows. */
  isBodyOccluded(name: string): boolean {
    for (const entry of this.orbits) {
      if (entry.planet.name === name) return entry.occluded;
    }
    for (const system of this.moonSystems) {
      if (!system.revealed) continue;
      for (const moon of system.moons) {
        if (moon.data.name === name) return moon.occluded;
      }
    }
    return false;
  }

  hoverAt(x: number, y: number): string | null {
    this.rebuildPickAnchors();
    const hit = resolvePick(x, y, this.pickAnchors, HOVER_HIT_FLOOR_PX);
    return hit.kind === 'body' ? hit.name : null;
  }

  /** Brighten the hovered dot and emphasize its label; restore the previous. */
  setHover(name: string | null): void {
    if (name === this.hoveredName) return;
    const previous = this.hoveredName;
    this.hoveredName = name;
    this.applyDotEmphasis(previous, false);
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
    // A crossing lands first: the dive snapshots a start pose for its cancel to
    // restore, and a mid-crossing pose is one no band contains.
    this.settleFlip();
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
    this.diveStartBlend = this.blend;
    // Whether that target was the origin or a pivot the free zoom had moved.
    // A cancel restores the pose exactly, so it has to restore what the pose
    // MEANT as well — a floating target under a latch that says nothing has
    // moved is a state no path can get out of.
    this.diveStartZoomFree = this.zoomFree;
    // And which side of the plane that pose belongs to, so the restore hands
    // the controls the band it can legally sit in.
    this.diveStartHemisphere = this.hemisphere;
    this.diveOffsetDir.copy(this.diveStartPos).sub(this.diveStartTarget);
    this.diveStartDist = Math.max(this.diveOffsetDir.length(), 1e-4);
    this.diveOffsetDir.normalize();
    this.controls.enabled = false;
    this.diving = true;
    // What the camera is aimed at just changed, and nothing else about the
    // frame need change for the destination's system to have to come up.
    this.projectionRevision++;
    this.setHover(null);
    this.cancelFocusPulse();
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
    // through the dive and snap back at the end.
    this.projectFullView();
  }

  /** End the dive. On cancel, restore the pre-dive pose and hand controls back;
   *  on commit, leave the pose (the map is about to close). */
  endDive(commit: boolean): void {
    if (!this.diving) return;
    this.diving = false;
    this.projectionRevision++;
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
    // The snapshots may be in an outgone projection — the scale ease runs to
    // its end under a dive, and the overview branch that carries the live
    // pivot across each blend step stood down the whole time. Carry them the
    // same way (radial remap + the camera rides the delta), or a cancel after
    // a mid-ease dive restores a pivot the compressed chart no longer reaches
    // and the camera settles aimed at empty space.
    const pivotRadius = this.diveStartTarget.length();
    if (this.blend !== this.diveStartBlend && pivotRadius > 1e-9) {
      const scale =
        remapRadius(pivotRadius, this.diveStartBlend, this.blend, this.curve) / pivotRadius;
      this.diveStartPos.addScaledVector(this.diveStartTarget, scale - 1);
      this.diveStartTarget.multiplyScalar(scale);
    }
    this.camera.position.copy(this.diveStartPos);
    this.controls.target.copy(this.diveStartTarget);
    // The target that comes back may be a pivot the free zoom had moved, so the
    // latch comes back with it — and so does the hemisphere the restored pose
    // sits in, before any bounds pass reads it.
    this.zoomFree = this.diveStartZoomFree;
    this.hemisphere = this.diveStartHemisphere;
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
    this.applyBounds();
    // The framing ratio the scale ease preserves per frame was captured at
    // the toggle, before the dive rewrote the pose — an ease still running
    // at cancel would re-dolly this freshly rebuilt frame back toward it on
    // the very next frame (a parked overview restored to the exact fit
    // snaps out by the captured drift). Rebase to the restored framing, the
    // way the focus restore's overview path already does.
    this.rebaseScaleZoomRatio();
    this.camera.updateMatrixWorld();
    this.syncZoomToCursor();
    this.controls.enabled = true;
    this.controls.update();
  }

  /** Put a cancelled dive back where its focus was. `leaving` means the dive
   *  interrupted a release — that flight completes to the overview rather than
   *  reversing itself back onto the body the user had just let go of. */
  private restoreFocusFromDive(focusName: string | null, leaving: boolean): void {
    // Both branches below rebuild the pose from a direction the dive froze, so
    // the side of the plane that direction belongs to comes back first.
    this.hemisphere = this.diveStartHemisphere;
    // A focus the chart can no longer place is restored the way a release is:
    // the overview is always somewhere the camera can legally sit.
    const focusPos = focusName ? this.bodyMapPosition(focusName, this.tmpBodyPos) : null;
    if (leaving || !focusPos) {
      const fit = fitDistanceAU(this.extentAU, MAP_FOV_DEG, this.camera.aspect);
      // This path normalizes onto the origin rather than restoring what the
      // dive interrupted, so the free zoom's pivot is parked here whatever the
      // camera was doing before.
      this.controls.target.set(0, 0, 0);
      this.zoomFree = false;
      this.camera.position.copy(this.flyDir).multiplyScalar(fit);
      this.camera.lookAt(this.controls.target);
      this.applyBounds();
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
    this.syncZoomToCursor();
    this.controls.enabled = true;
    this.controls.update();
  }

  private rebuildPickAnchors(): void {
    // The renderer only refreshes the camera matrices at render time; a pick
    // landing between a controls move and the next frame must project against
    // the live pose, so flush the matrix here before projecting the anchors.
    this.camera.updateMatrixWorld();
    // Rebuild at most once per frame, and again whenever the camera has moved
    // since — the two things every anchor's screen position depends on. The
    // bodies themselves only move inside the update pass, which bumps the
    // frame revision.
    // The viewport and the projection revision belong in the key as much as the
    // pose does: a resize that leaves a deliberately zoomed camera exactly
    // where it was still re-projects every anchor, and a pick taken before the
    // next frame would otherwise be answered in the old viewport's pixels.
    const w = this.renderer.domElement.clientWidth;
    const h = this.renderer.domElement.clientHeight;
    if (this.anchorKeyRevision === this.frameRevision
      && this.anchorKeyProjection === this.projectionRevision
      && this.anchorKeyWidth === w
      && this.anchorKeyHeight === h
      && this.anchorKeyPos.equals(this.camera.position)
      && this.anchorKeyQuat.equals(this.camera.quaternion)) {
      return;
    }
    this.anchorKeyRevision = this.frameRevision;
    this.anchorKeyProjection = this.projectionRevision;
    this.anchorKeyWidth = w;
    this.anchorKeyHeight = h;
    this.anchorKeyPos.copy(this.camera.position);
    this.anchorKeyQuat.copy(this.camera.quaternion);
    this.anchorBuilds++;
    this.pickAnchors.length = 0;
    this.pushAnchor(SUN_DATA.name, this.sun.position, true, w, h, this.sunRadiusPx);
    // Moons before their planets: a moon in front of a planet's disc is the
    // smaller, nearer target, and nearest-wins needs it in the running. A moon
    // BEHIND that disc is not a target at all — offering one would take the tap
    // away from the planet the viewer is actually looking at.
    for (const system of this.moonSystems) {
      if (!system.revealed) continue;
      for (const moon of system.moons) {
        if (!moon.visible || moon.occluded) continue;
        this.pushAnchor(
          moon.data.name,
          moon.pos,
          true,
          w,
          h,
          moon.globeDrawn ? moon.drawnRadiusPx : 0,
        );
      }
    }
    for (const entry of this.orbits) {
      // Nothing behind the solar disc is tappable: the star is what the pointer
      // is over.
      if (entry.occluded) continue;
      // A dot is a marker with no footprint of its own — the pointer floor
      // governs it. A globe hands over its drawn reach — the ring's outer edge
      // where there is one — so a click on the limb of a body that fills the
      // frame lands on the body, and Saturn's annulus is tappable to its rim.
      this.pushAnchor(
        entry.planet.name,
        entry.dot.position,
        true,
        w,
        h,
        entry.globeDrawn ? entry.drawnRadiusPx * entry.ringOuterFactor : 0,
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
    if (body.kind === 'moon') return this.moonEntryFor(name)?.dot ?? null;
    return this.entryFor(name)?.dot ?? null;
  }

  /** Hover feedback for one body: the emphasis channel below, plus the label's
   *  own class — which is a hard style step and so stays boolean-hover only. A
   *  body with nothing drawn simply has nothing to emphasize. */
  private applyDotEmphasis(name: string | null, on: boolean): void {
    if (!name) return;
    const label = this.labels.get(name);
    if (label) label.classList.toggle('hover', on);
    this.applyEmphasisLevel(name, this.emphasisLevelFor(name));
  }

  /**
   * How emphasized a body should be right now, 0 to 1: full while it is
   * hovered, the landing pulse's envelope while it is the body a focus just
   * arrived at, and the greater of the two when it is both.
   *
   * Reading both live is what lets either one end without disturbing the other:
   * restoring a finished pulse asks this question again and gets the hover
   * answer, and clearing a hover from the body a pulse is running on leaves the
   * pulse alone.
   */
  private emphasisLevelFor(name: string): number {
    const hover = name === this.hoveredName ? 1 : 0;
    const pulse = name === this.pulseName ? mapFocusLandPulse(this.pulseElapsedMs) : 0;
    return hover > pulse ? hover : pulse;
  }

  /** The emphasis channel itself: the marker's tint lifted toward white and, for
   *  a body drawing as a globe, its own tint as emissive. Scalar, so a pulse can
   *  drive it. The ×1.3 marker swell is NOT here — it is keyed on boolean hover
   *  in the size paths, and a pulse driving it would modulate the drawn reach and
   *  with it the camera's own framing. */
  private applyEmphasisLevel(name: string, level: number): void {
    const body = mapBody(name);
    if (!body) return;
    const moon = body.kind === 'moon' ? this.moonEntryFor(name) : null;
    const entry = this.entryFor(name);
    const sprite = this.markerSpriteFor(name);
    const base = body.kind === 'sun'
      ? this.sunBaseColor
      : moon?.baseColor ?? entry?.baseColor ?? null;
    if (sprite && base) {
      const mat = sprite.material as THREE.SpriteMaterial;
      if (level > 0) mat.color.copy(base).lerp(WHITE, HOVER_LIFT * level);
      else mat.color.copy(base);
    }
    const globeMat = moon?.globeMat ?? entry?.globeMat ?? null;
    if (globeMat && base) {
      if (level > 0) globeMat.emissive.copy(base).multiplyScalar(GLOBE_HOVER_EMISSIVE * level);
      else globeMat.emissive.setRGB(0, 0, 0);
    }
  }

  /** Begin the landing pulse on a body, replacing any pulse already running. */
  private startFocusPulse(name: string | null): void {
    if (!name) return;
    this.cancelFocusPulse();
    this.pulseName = name;
    this.pulseElapsedMs = 0;
  }

  /** End the pulse and hand its subject back to whatever the hover says — which
   *  is how a finished pulse can never wipe a different body's live emphasis,
   *  or its own body's. */
  private cancelFocusPulse(): void {
    const name = this.pulseName;
    if (!name) return;
    this.pulseName = null;
    this.pulseElapsedMs = 0;
    this.applyEmphasisLevel(name, this.emphasisLevelFor(name));
  }

  /**
   * Quiet the line the followed body rides.
   *
   * Followed close up, a body's own heliocentric orbit is not a trajectory any
   * more: it is a bright chord ruled straight through the middle of the frame,
   * across the very system the camera came to look at. Every other line on the
   * chart is still information at that distance — this one is the axis you are
   * standing on. So it steps back while the follow lasts and comes straight
   * back when it ends.
   *
   * Following a MOON, the line that crosses the frame is the parent's, since
   * that is the orbit the whole system rides; the moon's own drawn ring is the
   * subject and is left alone.
   *
   * It stands down for as long as the camera is ON a body — flying to one,
   * riding it, leaving it, diving into it — and comes back at the overview,
   * where the line is one thin ellipse among nine and is information again.
   * Handing it back the moment Overview is pressed would flash a bright chord
   * across a close view at exactly the moment the user asked to leave it.
   *
   * One entry is dimmed at a time, and the one that is dimmed is remembered
   * rather than re-derived, so whatever the camera does next the restore lands
   * on the material that was actually touched.
   */
  private applyFocusOrbitDim(): void {
    const name = this.cameraSubject();
    const body = name ? mapBody(name) : null;
    const entry = body
      ? this.entryFor(body.kind === 'moon' && body.parentPlanet ? body.parentPlanet : body.name)
      : null;
    if (entry === this.dimmedOrbit) return;
    this.clearFocusOrbitDim();
    if (!entry) return;
    this.dimmedOrbit = entry;
    entry.material.opacity = FOCUS_ORBIT_DIM;
  }

  /**
   * Give the dimmed line its brightness back.
   *
   * Called on close AND before every corner-chart draw. The corner chart draws
   * the SAME line objects the full chart does — the whole point of one scene —
   * so a dim left standing by a session that ended any way but through close()
   * would show up in the corner as one planet's orbit mysteriously fainter than
   * the other eight. The chart is the map's memory of itself; nothing may
   * inherit a state the view that set it has already left.
   */
  private clearFocusOrbitDim(): void {
    if (!this.dimmedOrbit) return;
    this.dimmedOrbit.material.opacity = 1;
    this.dimmedOrbit = null;
  }

  /** Advance the pulse. Its own entry point into the emphasis apply: setHover
   *  early-returns on an unchanged name, so a per-frame write routed through it
   *  would never land. */
  private advanceFocusPulse(dtMs: number): void {
    if (!this.pulseName) return;
    this.pulseElapsedMs += dtMs;
    if (this.pulseElapsedMs >= MAP_FOCUS_PULSE_MS) {
      this.cancelFocusPulse();
      return;
    }
    this.applyEmphasisLevel(this.pulseName, this.emphasisLevelFor(this.pulseName));
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
    /** Render truth for the other look: the dot sprite's FULL extent, measured
     *  in screen px against the current camera, 0 when no dot is drawn. The
     *  sprite is a gradient, so what it paints is about 0.7 of its half-extent —
     *  the only figure that compares like for like against a globe's radius, and
     *  the reason a size check must read this rather than the size policy, which
     *  would agree with itself whatever the sprite was actually given. */
    markerExtentPx: number;
    screenX: number;
    screenY: number;
    /** Map position (AU) the chart places the body at this frame. */
    mapPos: [number, number, number];
    /** Whether the chart is drawing this body at all this frame — false for a
     *  moon the chart has not revealed, and equally for any body that is off
     *  the frame or behind the camera (no pick anchor, no occluder): at the
     *  extremes the probe must not report a body nobody can see as drawn. A
     *  body gated behind a drawn disc still reads true — that suppression is
     *  `occluded`'s answer, not this one's. */
    drawn: boolean;
    /** Whether its MARKER is gated off behind a drawn disc — its parent's globe
     *  or the solar disc — this frame. Reported apart from `drawn` because they
     *  answer different questions: a moon behind its parent is still drawn (the
     *  camera clears it, the zoom pivots on it) while its dot, its label and its
     *  hit target are all suppressed. An occluded body has no pick anchor, so
     *  its screen coordinates read -1 the way an off-frame body's do — this is
     *  what tells the two apart. */
    occluded: boolean;
    /** Hover feedback, as the materials actually carry it: the marker's tint
     *  against its catalog base, and the globe's emissive lift. */
    hovered: boolean;
    markerLift: number;
    globeEmissive: number;
    /** Eclipse shading, as the materials actually carry it: the drawn
     *  multiplier (1 = full sunlight, the floor deep in a parent's shadow) and
     *  the raw sun-visible fraction the last geometry pass measured. 1 and 1
     *  for a body the chart never shades. */
    shadeDim: number;
    shadeSunFraction: number;
    /** Moons only: where the offset policy charts it (parent drawn radii), and
     *  the true distance that went in (parent true radii, and AU). */
    offsetR: number;
    parentRadiiX: number;
    trueDistAU: number;
    /** Body north pole as a unit vector in the map's (J2000 equatorial) frame. */
    pole: [number, number, number];
    textureId: number;
    worldTextureId: number;
    ringTextureId: number;
    worldRingTextureId: number;
    /** How close the camera has to be to this body's SYSTEM for its moons to
     *  appear — the parent's shell for a moon, a planet's own, 0 for a body
     *  with no moons at all. */
    moonRevealDistanceAU: number;
  } | null {
    const body = mapBody(name);
    if (!body) return null;
    // Measured before anything else claims the position scratch this walks.
    const moonRevealDistanceAU = this.moonRevealDistanceForOwner(name);
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
        // The Sun's disc IS its sprite, and it is a limb-darkened billboard
        // rather than the planets' gradient — its extent is twice its radius.
        markerExtentPx: 2 * this.sunRadiusPx,
        screenX,
        screenY,
        mapPos,
        // The star is always in the scene, but "drawn" answers for THIS frame:
        // no anchor means its disc is off the frame or behind the camera.
        drawn: !!anchor,
        // Nothing on the chart draws in front of the star: a planet resolved
        // between the camera and it takes the disc's own pixels through the
        // depth buffer, which is a partial cover, not a gate.
        occluded: false,
        hovered: this.hoveredName === name,
        markerLift: this.markerLiftOf(this.sun, this.sunBaseColor),
        globeEmissive: 0,
        shadeDim: 1,
        shadeSunFraction: 1,
        offsetR: 0,
        parentRadiiX: 0,
        trueDistAU: 0,
        pole: [0, 1, 0],
        textureId: 0,
        worldTextureId: 0,
        ringTextureId: 0,
        worldRingTextureId: 0,
        moonRevealDistanceAU,
      };
    }
    const entry = this.entryFor(name);
    if (!entry) {
      // A moon: everything about it comes from its own entry once its system is
      // built, and from the catalog before that.
      const moon = this.moonEntryFor(name);
      const h = Math.max(this.renderer.domElement.clientHeight, 1);
      const worldPerPx = mapWorldPerPxAtUnitDepth(h, MAP_FOV_DEG)
        * (moon ? this.viewDepth(moon.pos) : 1);
      // A moon whose system is not revealed has no entry to read, so the
      // figures come straight off the ephemeris and the policy — the probe
      // answers for every moon, drawn or not.
      const system = body.parentPlanet
        ? this.moonSystemsByParent.get(body.parentPlanet) ?? null
        : null;
      let trueDistAU = moon?.trueDistAU ?? 0;
      let parentRadiiX = moon?.x ?? 0;
      let offsetR = moon?.offsetR ?? 0;
      if (!moon && system) {
        computeMoonOffsetEquatorialAU(
          name, system.parent.planet.name, this.clockUtcMs, this.tmpMoonOffset,
        );
        trueDistAU = this.tmpMoonOffset.length();
        parentRadiiX = trueDistAU / system.parent.planet.radiusAU;
        offsetR = mapMoonOffsetR(system.policy, parentRadiiX);
      }
      this.tmpVec3.set(0, 1, 0);
      if (moon) this.tmpVec3.applyQuaternion(moon.globe.quaternion);
      return {
        mode: moon?.globeDrawn ? 'globe' : 'dot',
        kind: body.kind,
        parentPlanet: body.parentPlanet,
        trueRadiusAU: body.radiusAU,
        tint: body.color,
        radiusPx: moon?.visible
          ? moon.drawnRadiusPx
          : mapMarkerRadiusPx(body.radiusAU, this.bodySizeParams),
        apparentRadiusPx: moon?.globeDrawn
          ? moon.globe.scale.x / Math.max(worldPerPx, 1e-30)
          : 0,
        markerExtentPx: moon && moon.dot.visible
          ? moon.dot.scale.x / Math.max(worldPerPx, 1e-30)
          : 0,
        screenX,
        screenY,
        mapPos,
        pole: [this.tmpVec3.x, this.tmpVec3.y, this.tmpVec3.z],
        textureId: moon?.globeMat.map?.id ?? 0,
        worldTextureId: this.textures.colorMap(name)?.id ?? 0,
        ringTextureId: 0,
        worldRingTextureId: 0,
        moonRevealDistanceAU,
        // Revealed AND on the frame (an occluded moon holds no anchor but is
        // still drawn behind the disc that gates its marker).
        drawn: !!moon?.visible && (!!anchor || !!moon?.occluded),
        occluded: !!moon?.occluded,
        hovered: this.hoveredName === name,
        markerLift: moon ? this.markerLiftOf(moon.dot, moon.baseColor) : 0,
        globeEmissive: moon ? maxChannel(moon.globeMat.emissive) : 0,
        shadeDim: moon ? (moon.dot.material as THREE.SpriteMaterial).opacity : 1,
        shadeSunFraction: moon ? moon.shade.shadeTarget : 1,
        offsetR,
        parentRadiiX,
        trueDistAU,
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
      markerExtentPx: entry.dot.visible ? entry.dot.scale.x / Math.max(worldPerPx, 1e-30) : 0,
      screenX,
      screenY,
      mapPos,
      // Honest at the extremes: no anchor and no occluder means the planet is
      // off the frame or behind the camera — the chart is not drawing it this
      // frame, wherever the follow camera has wandered.
      drawn: !!anchor || entry.occluded,
      occluded: entry.occluded,
      hovered: this.hoveredName === name,
      markerLift: this.markerLiftOf(entry.dot, entry.baseColor),
      globeEmissive: maxChannel(entry.globeMat.emissive),
      shadeDim: 1,
      shadeSunFraction: 1,
      offsetR: 0,
      parentRadiiX: 0,
      trueDistAU: 0,
      pole: [this.tmpVec3.x, this.tmpVec3.y, this.tmpVec3.z],
      textureId: entry.globeMat.map?.id ?? 0,
      worldTextureId: this.textures.colorMap(name)?.id ?? 0,
      ringTextureId: entry.ringMat?.map?.id ?? 0,
      worldRingTextureId: this.textures.ringMap(name)?.id ?? 0,
      moonRevealDistanceAU,
    };
  }

  /** Dev forensics: the ship marker's screen rotation (radians, CCW, 0 while
   *  docked), which marker is drawn, where it drew, and which space it was
   *  charted in. The chevron is the one projection-fed thing on the map that
   *  pixels can't isolate — it sits inside the same sprite as the docked ring,
   *  so a photometric read of the marker measures the art, not the angle. The
   *  placement is the other: the marker may be drawn in a moon system's own
   *  amplified space, which nothing outside this class can reproduce, so the
   *  point it drew at and the weight that put it there are reported here. */
  shipMarkerState(): {
    rotationRad: number;
    docked: boolean;
    screenX: number;
    screenY: number;
    mapPos: [number, number, number];
    anchorSystem: string | null;
    anchorWeight: number;
  } {
    const el = this.renderer.domElement;
    const w = Math.max(el.clientWidth, 1);
    const h = Math.max(el.clientHeight, 1);
    projectToScreen(this.shipMarker.position, this.camera, w, h, this.tmpProj);
    const system = this.shipAnchorFrame.system;
    return {
      rotationRad: this.shipMarker.material.rotation,
      docked: this.shipDocked,
      // Where the marker actually draws. The chart puts the ship in a moon
      // system's own amplified space while it is flying among them, so
      // "where is it" cannot be answered by re-running the plain compression
      // outside — only by reading the point the frame was drawn from.
      screenX: this.tmpProj.ndcZ >= 1 ? -1 : this.tmpProj.x,
      screenY: this.tmpProj.ndcZ >= 1 ? -1 : this.tmpProj.y,
      mapPos: [
        this.shipMarker.position.x,
        this.shipMarker.position.y,
        this.shipMarker.position.z,
      ],
      anchorSystem: this.shipAnchorName,
      anchorWeight: system ? shipAnchorWeight(system, this.shipPlanetocentricX(system)) : 0,
    };
  }

  // ---- internals -------------------------------------------------------

  /**
   * The frame's orbit-line refresh, and the whole of the chart's cost policy
   * for it (the decisions themselves are mapResample). Either every line is
   * seeded at this instant, or at most ONE is rebuilt and the sweep moves on.
   * Called from both passes, against one cursor and one previous-clock reading:
   * a full chart closing to the corner chart hands the lap over rather than
   * starting a fresh one.
   */
  private stepResample(utcMs: number): void {
    const plan = this.resampleSweep.plan(
      this.sampled, this.orbits, utcMs, ORBIT_LINE_RESAMPLE_MAX_AGE_MS,
    );
    if (plan.kind === 'cold') this.resample(utcMs);
    else if (plan.kind === 'one') this.refreshOrbit(this.orbits[plan.index], utcMs);
  }

  /** Seed every line at one instant: the cold path, and the only one allowed
   *  to leave the chart part-refreshed for no frames at all. */
  private resample(utcMs: number): void {
    this.sampled = true;
    this.resampleSweep.seeded(utcMs);
    for (const entry of this.orbits) this.refreshOrbit(entry, utcMs);
  }

  /** Rebuild one line end to end: fresh samples at `utcMs`, compressed into
   *  its buffer, and the direction fade re-anchored on the epoch that just
   *  moved under the body. */
  private refreshOrbit(entry: OrbitEntry, utcMs: number): void {
    this.sampleOrbit(entry, utcMs);
    this.recompressOrbit(entry);
    this.refreshOrbitFade(entry, utcMs, true);
  }

  /** Sample one body's trajectory into its raw buffer. The sampler writes
   *  through the shared scratch, so the ephemeris chain allocates nothing. */
  private sampleOrbit(entry: OrbitEntry, utcMs: number): void {
    entry.epochUtcMs = utcMs;
    const pts = sampleTrajectoryLinePoints(
      entry.planet, utcMs, ORBIT_SEGMENTS, this.orbitSampleScratch,
    );
    for (let i = 0; i <= ORBIT_SEGMENTS; i++) {
      const p = pts[i];
      entry.raw[i * 3] = p.x;
      entry.raw[i * 3 + 1] = p.y;
      entry.raw[i * 3 + 2] = p.z;
    }
  }

  /** Every cached line back through the live blend — what a scale animation
   *  and a curve swap need, since both move all nine at once. */
  private recompressOrbits(): void {
    for (const entry of this.orbits) this.recompressOrbit(entry);
  }

  /** One line through the live blend, and the reach it contributes. The extent
   *  stays honest without a second pass: recomputeExtent takes the max over
   *  every entry's maxMapRadius, and it runs after this on the same frame. */
  private recompressOrbit(entry: OrbitEntry): void {
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
      // through the map compression. The position lands in the map's own
      // scratch through the seam's out parameter, so a pass that runs every
      // frame for every body allocates nothing.
      const helio = computeBodyPositionAU(entry.planet, utcMs, this.tmpHelio);
      entry.helioX = helio.x;
      entry.helioY = helio.y;
      entry.helioZ = helio.z;
      projectMapPoint(helio.x, helio.y, helio.z, this.blend, this.curve, this.tmpMap);
      entry.dot.position.set(this.tmpMap.x, this.tmpMap.y, this.tmpMap.z);
      entry.globe.position.copy(entry.dot.position);
      if (reorient) {
        entry.globe.quaternion.copy(computeBodyOrientationQuaternion(entry.planet, jd));
      }
      this.refreshOrbitFade(entry, utcMs, false);
    }
    if (reorient) this.orientedUtcMs = utcMs;
  }

  /**
   * Re-anchor one line's direction fade: where the body sits along ITS OWN
   * sampled loop, measured against the epoch THAT line was sampled at. Reading
   * a chart-wide epoch here is the visible failure of a staggered refresh —
   * eight lines wearing a brightness phase belonging to the one that was
   * rebuilt last.
   *
   * The colours are rebuilt only when they would change: on a vertex crossing,
   * or when `forced` says the loop itself has just moved under the body, which
   * no crossing test can see (and which the corner chart, whose body pass is
   * skipped on a settled frame, would otherwise never notice at all).
   */
  private refreshOrbitFade(entry: OrbitEntry, utcMs: number, forced: boolean): void {
    const frac = trajectoryLineBodyFraction(entry.planet, entry.epochUtcMs, utcMs);
    const i0 = Math.floor(frac * ORBIT_SEGMENTS);
    if (!forced && i0 === entry.lastVertex) return;
    entry.lastVertex = i0;
    this.rebuildOrbitColors(entry, frac);
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

  /** Chart the last ship snapshot through the live transform. Split out so a
   *  curve change can re-place the marker in the same call that re-fits — the
   *  ship is part of the extent, so a stale marker would fit the wrong frame.
   *
   *  The curve and blend are re-read here rather than carried: a curve swap
   *  re-places the marker outside the update pass, and the transform it is
   *  charted through has to be the one the rest of the chart just moved onto. */
  private positionShipMarker(): void {
    this.shipAnchorFrame.blend = this.blend;
    this.shipAnchorFrame.curve = this.curve;
    chartShipPoint(this.shipRawX, this.shipRawY, this.shipRawZ, this.shipAnchorFrame, this.tmpMap);
    this.shipMarker.position.set(this.tmpMap.x, this.tmpMap.y, this.tmpMap.z);
    // The plain radius, kept for the fit. Direction is held exactly by the
    // compression, so the drawn radius of a plain-charted point is the curve
    // evaluated at its true one — no second projection to get it.
    this.shipPlainR = mapRadius(
      Math.hypot(this.shipRawX, this.shipRawY, this.shipRawZ),
      this.blend,
      this.curve,
    );
  }

  /**
   * Which moon system's space the ship's marker is drawn in, or null for the
   * plain chart.
   *
   * The ground answers first and answers exactly: standing on a moon, the ship
   * belongs in that moon's system whatever the geometry says, and standing on a
   * PLANET it belongs at the planet's own charted point — the parent of a
   * system is not inside it. Flying, the question is geometric: whichever
   * revealed system's moon envelope the ship is actually inside, nearest
   * envelope first. Only a revealed system can ever be the answer, which is
   * also what keeps the scale this reads from being a frame stale — an
   * unrevealed system's is not refreshed.
   */
  private shipAnchorSystemFor(landed: LandedTarget): MoonSystem | null {
    // The corner chart draws no moons at all, so it has no second space to
    // join: it keeps the chart's own truth, which is what it measures correct.
    if (!this.open) return null;
    if (landed?.type === 'planet') return null;
    if (landed?.type === 'moon') {
      const system = this.moonSystemsByParent.get(landed.parentPlanet) ?? null;
      return system?.revealed ? system : null;
    }
    let best: MoonSystem | null = null;
    let bestRatio = Infinity;
    for (const system of this.moonSystems) {
      if (!system.revealed) continue;
      const parent = system.parent;
      const radius = parent.planet.radiusAU;
      if (!(radius > 0) || !(system.maxApoX > 0)) continue;
      const x = Math.hypot(
        this.shipRawX - parent.helioX,
        this.shipRawY - parent.helioY,
        this.shipRawZ - parent.helioZ,
      ) / radius;
      if (!(shipEnvelopeWeight(x, system.maxApoX) > 0)) continue;
      const ratio = x / system.maxApoX;
      if (ratio < bestRatio) {
        bestRatio = ratio;
        best = system;
      }
    }
    return best;
  }

  /** Refresh the ship's chart transform for this frame: the system it is drawn
   *  inside, that system's live units, and how far the view has carried the
   *  marker into them. */
  private updateShipAnchorFrame(landed: LandedTarget): void {
    const frame = this.shipAnchorFrame;
    const system = this.shipAnchorSystemFor(landed);
    if (!system) {
      frame.system = null;
      this.shipAnchorName = null;
      return;
    }
    const parent = system.parent;
    const anchor = this.shipAnchorSystem ??= {
      policy: system.policy,
      parentRadiusAU: 0,
      parentHelioX: 0,
      parentHelioY: 0,
      parentHelioZ: 0,
      parentMapX: 0,
      parentMapY: 0,
      parentMapZ: 0,
      scaleBlendedAU: 0,
      maxApoX: 0,
      viewWeight: 0,
    };
    anchor.policy = system.policy;
    anchor.parentRadiusAU = parent.planet.radiusAU;
    anchor.parentHelioX = parent.helioX;
    anchor.parentHelioY = parent.helioY;
    anchor.parentHelioZ = parent.helioZ;
    anchor.parentMapX = parent.dot.position.x;
    anchor.parentMapY = parent.dot.position.y;
    anchor.parentMapZ = parent.dot.position.z;
    anchor.scaleBlendedAU = system.scaleBlended;
    anchor.maxApoX = system.maxApoX;
    // The same camera the moons were placed against — this runs in the position
    // phase, before the camera moves — so the marker and the rings agree about
    // which frame they are in.
    anchor.viewWeight = shipViewWeight(
      this.camera.position.distanceTo(parent.dot.position),
      this.revealDistanceFor(parent.planet.name) ?? 0,
      this.moonRevealDistanceAU(system),
    );
    frame.system = anchor;
    this.shipAnchorName = parent.planet.name;
  }

  /** How far the ship stands from its anchor system's parent, in parent TRUE
   *  radii — the policy's own input, and what both weights are measured on. */
  private shipPlanetocentricX(system: ShipAnchorSystem): number {
    if (!(system.parentRadiusAU > 0)) return 0;
    return Math.hypot(
      this.shipRawX - system.parentHelioX,
      this.shipRawY - system.parentHelioY,
      this.shipRawZ - system.parentHelioZ,
    ) / system.parentRadiusAU;
  }

  /** Phase (1): place the ship marker in map space, pick docked/moving texture,
   *  and breathe the un-docked chevron. No projection — the camera hasn't been
   *  flushed for this frame yet; the heading rotation waits for orientShip. */
  private placeShip(
    x: number,
    y: number,
    z: number,
    fwdX: number,
    fwdY: number,
    fwdZ: number,
    moving: boolean,
    landed: LandedTarget,
    dtMs: number,
  ): void {
    this.shipRawX = x;
    this.shipRawY = y;
    this.shipRawZ = z;
    this.shipFwdX = fwdX;
    this.shipFwdY = fwdY;
    this.shipFwdZ = fwdZ;
    this.shipSnapshot = true;
    this.updateShipAnchorFrame(landed);
    this.positionShipMarker();
    const docked = landed !== null || !moving;
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
  private orientShip(view: MapDrawView): void {
    const mat = this.shipMarker.material;
    if (this.shipDocked) {
      mat.rotation = 0;
      return;
    }
    const x = this.shipRawX;
    const y = this.shipRawY;
    const z = this.shipRawZ;
    // A point one step along the ship's own course, charted through exactly the
    // transform the marker was charted through — never a second projection of
    // its own. The course comes in as a vector and is used as one: re-deriving
    // it from angles here would be a second opinion about which way the ship
    // points, and the chart would disagree with the window the moment the
    // flight frame's own convention moved.
    const step = shipHeadingProbeStepAU(
      Math.hypot(x, y, z),
      this.shipAnchorFrame.system?.parentRadiusAU ?? null,
    );
    chartShipPoint(
      x + this.shipFwdX * step,
      y + this.shipFwdY * step,
      z + this.shipFwdZ * step,
      this.shipAnchorFrame,
      this.tmpMap2,
    );
    const w = view.widthPx;
    const h = view.heightPx;
    projectToScreen(this.shipMarker.position, view.camera, w, h, this.tmpProj);
    projectToScreen(this.tmpMap2, view.camera, w, h, this.tmpProj2);
    // Clip space is square and the viewport is not, so the angle a viewer sees
    // is the NDC delta stretched by THIS viewport — the corner chart's aspect
    // is not the canvas's, and reading the canvas here would skew its chevron.
    mat.rotation = shipHeadingRotationRad(
      this.tmpProj2.ndcX - this.tmpProj.ndcX,
      this.tmpProj2.ndcY - this.tmpProj.ndcY,
      w,
      h,
    );
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
    // Its PLAIN radius, not the marker's: inside a revealed moon system the
    // marker is drawn in that system's amplified space, and letting an
    // amplification into the fit would re-frame the whole chart around it.
    const shipR = this.shipPlainR;
    if (shipR > max) max = shipR;
    this.extentAU = Math.max(max, 1e-3);
  }

  /** How far the drawn scene reaches from the Sun: the chart, plus the widest
   *  revealed moon system standing off its parent. The extent itself is built
   *  from the orbit centrelines and the ship, and those stop at the planets —
   *  but a revealed system's rings are drawn well past its parent, and on the
   *  frame a release flight lands the departing system is still up. */
  private renderedExtentAU(): number {
    let reach = 0;
    for (const system of this.moonSystems) {
      if (!system.revealed) continue;
      const r = this.systemRingReachAU(system);
      if (r > reach) reach = r;
    }
    return this.extentAU + reach;
  }

  /** How far a system's outermost drawn orbit stands off its parent, in map AU.
   *  The rings are written in parent-radii units, so the outermost vertex any of
   *  them can carry is the policy's cap while the chart is compressed and the
   *  system's own widest apoapsis once it is true — blended exactly the way the
   *  vertices themselves are. */
  private systemRingReachAU(system: MoonSystem): number {
    const capR = system.policy.params.capR;
    const outer = capR + (system.maxApoX - capR) * this.blend;
    return Math.max(outer, 0) * system.scaleBlended;
  }

  /** The overview's bounds at this pose, given a nearest-surface distance the
   *  caller has already measured (the scan is not cheap enough to run twice). */
  private overviewBoundsNow(nearestClearanceDistAU: number): MapCameraBounds {
    return mapOverviewBounds(
      this.extentAU,
      this.renderedExtentAU(),
      fitDistanceAU(this.extentAU, MAP_FOV_DEG, this.camera.aspect),
      this.camera.position.length(),
      nearestClearanceDistAU,
      this.overviewBounds,
    );
  }

  /** Hand the whole-system bounds to the controls and the camera. Also the
   *  fallback for a follow whose subject the chart cannot place: these are safe
   *  from anywhere by construction — the shell is the widest the chart offers
   *  and the far plane is measured from wherever the camera actually is. */
  private applyBounds(): void {
    const bounds = this.overviewBoundsNow(this.nearestDrawnSurface().clearanceDist);
    this.applyPolarBand();
    this.controls.minDistance = bounds.minDist;
    this.controls.maxDistance = bounds.maxDist;
    this.camera.near = bounds.near;
    this.camera.far = bounds.far;
    this.camera.updateProjectionMatrix();
  }

  /** Seat a drawn globe in the compositing ladder for this pass. True-sized,
   *  it keeps real depth at its resting order, where the disc, the lines and
   *  the annulus all sort against it honestly. Floored, its depth is the
   *  policy's, not the body's — so it neither writes nor reads depth and takes
   *  the marker orders instead, composing exactly like the dot it replaces:
   *  hidden behind the disc by the occlusion latch, painted over while they
   *  merely overlap (5 under 6), lifted above the star for the frames it
   *  stands in front (7 over 6). Depth flags and render order are plain
   *  pipeline state, safe to write per pass per frame. */
  private setGlobeCompositing(
    mat: THREE.MeshStandardMaterial,
    mesh: THREE.Object3D,
    floored: boolean,
    lifted: boolean,
  ): void {
    mat.depthTest = !floored;
    mat.depthWrite = !floored;
    mesh.renderOrder = !floored
      ? GLOBE_RENDER_ORDER
      : lifted
        ? MARKER_OVER_SUN_RENDER_ORDER
        : MARKER_RENDER_ORDER;
  }

  /**
   * How big everything draws, and — for a body — whether that drawing is a
   * globe or a dot. Markers get `px * (world-per-px at the sprite's camera
   * distance)`; a globe gets the size policy's radius, which is the legibility
   * floor at the overview and the body's true size once the camera is close
   * enough to resolve it. One shared camera factor drives both.
   */
  private updateDrawnSizes(view: MapDrawView): void {
    const camera = view.camera;
    const params = view.sizeParams;
    const h = Math.max(view.heightPx, 1);
    const worldPerPxAtUnit = (2 * Math.tan((MAP_FOV_DEG * Math.PI) / 180 / 2)) / h;

    // The Sun is always its billboard — a star has no terminator to draw. The
    // policy answers in map AU; the px it works out to is the hit target. Its
    // camera-space position is kept in scalars rather than the shared scratch:
    // every body below is measured against the star, and the scratch is claimed
    // again by the very next projection.
    const sunView = this.viewSpace(this.sun.position, camera);
    const sunViewX = sunView.x;
    const sunViewY = sunView.y;
    const sunViewZ = sunView.z;
    const sunDepth = Math.max(-sunViewZ, 1e-6);
    const sunAU = mapBodyRadiusAU(SUN_DATA.radiusAU, sunDepth, worldPerPxAtUnit, params);
    this.sunRadiusPx = sunAU / Math.max(worldPerPxAtUnit * sunDepth, 1e-30);
    const sunBoost = this.hoveredName === 'Sun' ? HOVER_SCALE : 1;
    this.sun.scale.setScalar(2 * sunAU * sunBoost);
    this.sunHalo.scale.setScalar(2 * sunAU * view.sunHaloRadii);
    // What the disc actually paints, hover swell included — the limb the gate
    // below measures against has to be the drawn one.
    const sunDiscPx = this.sunRadiusPx * sunBoost;
    this.sunViewX = sunViewX;
    this.sunViewY = sunViewY;
    this.sunViewDepth = sunDepth;
    this.sunDiscPx = sunDiscPx;
    // The globes' shader needs the star in the SAME camera's space, and the
    // star sits at the chart's origin where the point light lighting them does
    // — so the disc's own camera-space position is the light's.
    this.sunUniforms.viewPos.value.set(sunViewX, sunViewY, sunViewZ);

    const trueScaleTarget = view.trueScaleTarget;
    for (const entry of this.orbits) {
      const view3 = this.viewSpace(entry.dot.position, camera);
      const viewX = view3.x;
      const viewY = view3.y;
      const depth = Math.max(-view3.z, 1e-6);
      const drawnAU = mapBodyRadiusAU(
        entry.planet.radiusAU,
        depth,
        worldPerPxAtUnit,
        params,
      );
      const worldPerPx = Math.max(worldPerPxAtUnit * depth, 1e-30);
      entry.drawnRadiusPx = drawnAU / worldPerPx;
      const truePx = entry.planet.radiusAU / worldPerPx;
      const markerPx = mapMarkerRadiusPx(entry.planet.radiusAU, params);
      // At true scale the globe draws from the moment the body's REAL disc
      // overtakes the marker — the same crossover the size policy hands the
      // drawn radius over at, so the swap costs nothing in size and nothing
      // pops — and for any planet whose marker is already big enough to carry
      // a face. Both looks share the policy footprint, so which one draws
      // never changes what labels, picking, or occlusion measure against.
      const globe = mapBodyDrawMode(
        entry.globeMat.map !== null,
        trueScaleTarget,
        truePx,
        markerPx,
      ) === 'globe';
      // Floored: the policy, not the body, is what sizes the drawn sphere, so
      // in world units it is inflated far past the truth and has to composite
      // as a marker rather than as geometry. Held through the whole true side
      // of the blend, not just while the target says true, so a true→
      // compressed animation rides out on marker rules instead of handing an
      // AU-scale sphere its depth back while the camera is still far.
      const floored = (trueScaleTarget || view.trueScaleBlend > 0) && truePx < markerPx;
      // The occlusion latch below holds its answer through a hysteresis band
      // judged at the drawn footprint — and a draw-mode flip changes that
      // footprint (a ringed globe is judged at its ring tips, the dot at its
      // sphere), as does the full↔mini handover, which moves the whole band
      // to another camera. An answer held from the other regime means
      // nothing, so a flip re-judges from scratch; false is the forgiving
      // seed, resolving the band toward drawn the way the limb rule does.
      // (A footprint the disc cannot swallow was never at risk: the latch's
      // own disc-must-swallow guard un-hides it on the first judged frame.)
      const drawModeFlipped = entry.globeDrawn !== globe;
      entry.globeDrawn = globe;
      // Behind the star: the disc paints over whatever a depth-free marker
      // draws there, so the marker, its name and its hit target stand down
      // rather than showing through the photosphere. A true-sized globe is
      // left alone — it is depth-tested, and the disc sorts against it
      // correctly. A floored globe is depth-free like the dot, so it hides
      // behind the same latch — judged at the pair's whole drawn reach when a
      // globe is what draws, so a Saturn whose ring tips still protrude past
      // the disc is composited under it (tips visible) instead of vanishing.
      const sunSepPx = markerSeparationPx(
        viewX, viewY, depth, sunViewX, sunViewY, sunDepth, worldPerPxAtUnit,
      );
      entry.occluded = markerBehindDisc(
        true,
        depth,
        globe ? entry.drawnRadiusPx * entry.ringOuterFactor : entry.drawnRadiusPx,
        sunDepth,
        sunDiscPx,
        sunSepPx,
        drawModeFlipped ? false : entry.occluded,
      );
      entry.globe.visible = globe && !(floored && entry.occluded);
      entry.dot.visible = !globe && !entry.occluded;
      // In front of the star, a marker has to be lifted over the disc: both are
      // depth-free, and at rest the disc draws last. Judged at the widest
      // footprint the dot could paint this frame — the sprite's own half-extent
      // (DOT_EXTENT_MUL/2 of the policy radius, which bounds the gradient
      // whatever its profile) at the hover swell — or a dot at the disc's edge
      // could overlap the star under it.
      entry.dot.renderOrder = markerInFrontOfDisc(
        true, depth, entry.drawnRadiusPx * (DOT_EXTENT_MUL / 2) * HOVER_SCALE, sunDepth, sunDiscPx, sunSepPx,
      )
        ? MARKER_OVER_SUN_RENDER_ORDER
        : MARKER_RENDER_ORDER;
      if (globe) {
        // One scale on the group carries the sphere and, where there is one,
        // the ring — which is built in planet radii for exactly this reason.
        entry.globe.scale.setScalar(drawnAU);
        // How hard the terminator may be, from how big the body draws.
        entry.globeShading.softness.value = mapTerminatorSoftness(entry.drawnRadiusPx);
        // The lift is judged at the widest footprint the pair paints — the
        // ring's outer edge where there is one, or a floored Saturn would be
        // lifted while its annulus still lay across the star.
        const lifted = floored && markerInFrontOfDisc(
          true, depth, entry.drawnRadiusPx * entry.ringOuterFactor,
          sunDepth, sunDiscPx, sunSepPx,
        );
        this.setGlobeCompositing(entry.globeMat, entry.globeMesh, floored, lifted);
        if (entry.ringMesh) {
          // Half a step under its sphere, wherever the sphere sits — see the
          // ladder note. The sphere then covers the annulus's crossing strip
          // on the face (both halves — an accepted marker-scale trade: with no
          // depth there is no order that draws the crossing right, and the
          // half that matters is the annulus outside the disc).
          entry.ringMesh.renderOrder = !floored
            ? GLOBE_RING_RENDER_ORDER
            : (lifted ? MARKER_OVER_SUN_RENDER_ORDER : MARKER_RENDER_ORDER) - 0.5;
        }
      } else {
        // The dot stands in for the globe, so it is sized from the same policy
        // radius the globe would draw at — through the gradient's extent rule,
        // the way the moons' dots already are.
        const boost = entry.planet.name === this.hoveredName ? HOVER_SCALE : 1;
        this.applyMarkerScale(
          entry.dot,
          DOT_EXTENT_MUL * entry.drawnRadiusPx * boost,
          worldPerPxAtUnit,
          camera,
        );
      }
    }
    if (view.withMoons) {
      this.updateMoonDrawnSizes(
        worldPerPxAtUnit,
        trueScaleTarget,
        trueScaleTarget || view.trueScaleBlend > 0,
      );
    }
    this.applyMarkerScale(this.shipMarker, view.shipPx, worldPerPxAtUnit, camera);
  }

  /** Camera-space depth (distance along the view axis) of a map position.
   *  Perspective screen size follows this, not the Euclidean distance — the
   *  latter runs an off-axis marker ~10% oversized. */
  private viewDepth(
    position: THREE.Vector3,
    camera: THREE.PerspectiveCamera = this.camera,
  ): number {
    return Math.max(-this.viewSpace(position, camera).z, 1e-6);
  }

  /** The whole camera-space position, in the shared scratch: what the depth
   *  above throws away is exactly what a screen separation needs. Valid until
   *  the next call — read the three numbers out before projecting anything
   *  else. */
  private viewSpace(
    position: THREE.Vector3,
    camera: THREE.PerspectiveCamera = this.camera,
  ): THREE.Vector3 {
    return this.tmpView.copy(position).applyMatrix4(camera.matrixWorldInverse);
  }

  private applyMarkerScale(
    sprite: THREE.Sprite,
    px: number,
    worldPerPxAtUnit: number,
    camera: THREE.PerspectiveCamera = this.camera,
  ): void {
    // worldPerPxAtUnit is the world span of one px at unit depth.
    sprite.scale.setScalar(px * worldPerPxAtUnit * this.viewDepth(sprite.position, camera));
  }

  private renderLabels(): void {
    if (!this.labelContainer) return;
    const w = this.renderer.domElement.clientWidth;
    const h = this.renderer.domElement.clientHeight;
    this.refreshLabelChrome(w, h);
    this.refreshLabelRingCtx(w, h);
    // Priority order: the Sun first, then the planets inner→outer (catalog
    // order). A label too close to one already placed this frame yields, so the
    // Sun and the inner planets win over their crowded neighbours at true scale.
    this.labelPlacer.begin();
    this.placeLabel(SUN_DATA.name, this.sun.position, w, h, this.sunRadiusPx, false);
    for (const entry of this.orbits) {
      // A name over the solar disc names nothing the viewer can see, and it
      // would win the de-overlap against the bodies that ARE visible there.
      if (entry.occluded) {
        this.hideLabel(entry.planet.name);
        continue;
      }
      this.placeLabel(entry.planet.name, entry.dot.position, w, h, entry.drawnRadiusPx, false);
    }
    // Moons last: in a crowded system the planet's own name is the one that
    // must survive the de-overlap.
    for (const system of this.moonSystems) {
      if (!system.revealed) continue;
      const inRing = this.labelRingCtx.parent === system.parent;
      for (const moon of system.moons) {
        if (!moon.visible || moon.occluded) {
          if (moon.label && moon.label.style.display !== 'none') moon.label.style.display = 'none';
          continue;
        }
        this.placeLabel(moon.data.name, moon.pos, w, h, moon.drawnRadiusPx, inRing);
      }
    }
  }

  /**
   * The drawn ring annulus as a screen-space ellipse, once per frame — the
   * frame the moon labels inside it are placed against. Saturn's inner family
   * lives entirely inside the annulus, and a name printed across the ring
   * texture is unreadable; each such label instead slides radially out past
   * the drawn edge (`ringClearedLabelShiftPx`).
   *
   * Only a GLOBE paints an annulus, so a dot-mode ringed planet leaves the
   * context inactive — as does an annulus smaller than a glyph, which nothing
   * needs to dodge. The minor axis is the projected pole; its foreshortening
   * ratio comes from the pole-view angle, which is the ellipse the tilted ring
   * actually projects to. One system at most wears a ring per chart, so the
   * first hit wins.
   */
  private refreshLabelRingCtx(w: number, h: number): void {
    const ctx = this.labelRingCtx;
    ctx.parent = null;
    for (const system of this.moonSystems) {
      if (!system.revealed) continue;
      const parent = system.parent;
      if (parent.ringOuterFactor <= 1 || !parent.globeDrawn) continue;
      const outerPx = parent.drawnRadiusPx * parent.ringOuterFactor;
      if (!(outerPx > LABEL_LINE_HEIGHT_PX)) continue;
      // Pole in world space; its view-axis component is the ellipse ratio.
      this.tmpVec3.set(0, 1, 0).applyQuaternion(parent.globe.quaternion);
      this.tmpDelta.copy(parent.dot.position).sub(this.camera.position).normalize();
      ctx.ratio = Math.abs(this.tmpVec3.dot(this.tmpDelta));
      projectToScreen(parent.dot.position, this.camera, w, h, this.tmpProj);
      ctx.centerXPx = this.tmpProj.x;
      ctx.centerYPx = this.tmpProj.y;
      // The pole's screen direction: project a pole-length step off the centre
      // and take the delta. A face-on ring projects the step to nothing, which
      // the shift math reads as the circle it is.
      const stepAU = parent.drawnRadiusPx
        * mapWorldPerPxAtUnitDepth(Math.max(h, 1), MAP_FOV_DEG)
        * this.viewDepth(parent.dot.position);
      this.tmpBodyPos.copy(parent.dot.position).addScaledVector(this.tmpVec3, stepAU);
      projectToScreen(this.tmpBodyPos, this.camera, w, h, this.tmpProj2);
      ctx.minorDirX = this.tmpProj2.x - ctx.centerXPx;
      ctx.minorDirY = this.tmpProj2.y - ctx.centerYPx;
      ctx.outerPx = outerPx;
      ctx.parent = parent;
      return;
    }
  }

  /** Take one body's label off the frame without asking the placer for a slot —
   *  what a body hidden behind something else needs, and the reason it is not
   *  simply skipped: a label left standing is a name over a body nobody can
   *  see. */
  private hideLabel(name: string): void {
    const label = this.labels.get(name);
    if (label && label.style.display !== 'none') label.style.display = 'none';
  }

  /** Place one body's label, keyed by its catalog name — never by an index into
   *  a catalog, which is only ever right for as long as one catalog is the
   *  whole of what the chart draws. A body with no label built is skipped.
   *
   *  `drawnRadiusPx` is the radius the body's marker was sized from — the gate
   *  for naming a body at all rides the same number the marker rides, so the
   *  two can never disagree about whether there is anything to name. Null for
   *  a body whose size the caller cannot resolve, which passes: hiding on
   *  missing information would hide real names.
   *
   *  `inRingSystem` marks a moon of the system whose annulus is on the frame
   *  (the ring context); its label dodges the drawn ring instead of taking the
   *  straight-down offset. */
  private placeLabel(
    name: string,
    worldPos: THREE.Vector3,
    w: number,
    h: number,
    drawnRadiusPx: number | null,
    inRingSystem: boolean,
  ): void {
    const label = this.labels.get(name);
    if (!label) return;
    // A marker smaller than the eye can find is not worth a full-size name.
    if (!labelWorthDrawing(drawnRadiusPx)) {
      if (label.style.display !== 'none') label.style.display = 'none';
      return;
    }
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
    const halfWidth = this.labelHalfWidthFor(name, label);
    const offset = this.labelOffsetPxFor(name);
    let x = this.tmpProj.x;
    let boxTop = this.tmpProj.y + offset;
    let ringShifted = false;
    const ctx = this.labelRingCtx;
    if (inRingSystem && ctx.parent !== null && ringClearedLabelShiftPx(
      this.tmpProj.x - ctx.centerXPx,
      this.tmpProj.y - ctx.centerYPx,
      ctx.outerPx,
      ctx.ratio,
      ctx.minorDirX,
      ctx.minorDirY,
      offset,
      halfWidth,
      LABEL_LINE_HEIGHT_PX,
      this.labelRingShift,
    )) {
      ringShifted = true;
      x = this.tmpProj.x + this.labelRingShift.x;
      boxTop = this.tmpProj.y + this.labelRingShift.y;
    }
    // The box stays whole on the frame ("Titan" half off the right edge reads
    // as a bug), and out of the bottom chrome band entirely. A ring-dodged
    // label the side clamp would drag back over the annulus hides instead —
    // there is no x that is both on the frame and off the ring.
    const clampedX = clampLabelCenterXPx(x, halfWidth, w);
    if (ringShifted && Math.abs(clampedX - x) > LABEL_EDGE_PAD_PX) {
      if (label.style.display !== 'none') label.style.display = 'none';
      return;
    }
    x = clampedX;
    if (boxTop > this.labelMaxBoxTopCachedPx) {
      if (label.style.display !== 'none') label.style.display = 'none';
      return;
    }
    // Proximity cull: hide if the label lands too close to an already-placed
    // (higher-priority) label this frame. The anchor test reads the BODY's
    // position, the box test the rectangle actually drawn — a clamp or a ring
    // dodge moves the second without inventing a new position for the first.
    if (!this.labelPlacer.place(this.tmpProj.x, this.tmpProj.y, x, boxTop, halfWidth)) {
      if (label.style.display !== 'none') label.style.display = 'none';
      return;
    }
    if (label.style.display === 'none') label.style.display = '';
    // A settled chart re-derives the same position every frame; only a CHANGED
    // one is worth a style write. The cache survives display flips — a label
    // re-shown where it already stands keeps its old transform.
    if (this.labelLastPlacedX.get(name) !== x || this.labelLastPlacedY.get(name) !== boxTop) {
      this.labelLastPlacedX.set(name, x);
      this.labelLastPlacedY.set(name, boxTop);
      label.style.transform = `translate(-50%, 0) translate(${x}px, ${boxTop}px)`;
    }
  }

  /**
   * Measure the bottom chrome and settle this frame's label ceiling — ONCE per
   * frame, from renderLabels, never from placeLabel: a per-label re-measure
   * would repeat the geometry reads dozens of times interleaved with the
   * labels' own display writes, which is a forced-layout spike by
   * construction. Batched here, every read runs against a clean layout before
   * the first write.
   *
   * The static chrome (the console, the world bar) is cached against the
   * viewport; openMap drops that cache so a bar that came or went between
   * sessions is seen. The chart's SHEETS are read live every frame they stand
   * open — a class flip is a no-layout read, and a card's height changes in
   * place on a repick, so a cache would serve a stale top for exactly the
   * frames that matter. One getBoundingClientRect per frame per open sheet,
   * against the already-clean layout, is the whole cost.
   *
   * Everything here counts only when it spans the width, the console included:
   * on a phone it is a bottom strip standing hundreds of px over this band with
   * no resize to announce it, and on a desktop it is a corner instrument like
   * the card. The band is a full-width model — excluding for a corner would
   * hide every label beside it, not just the ones behind it. "Spans" is the
   * width minus its own side gutters (12 px each, plus slack) rather than a
   * percentage, which misses the sheet on very narrow viewports where fixed
   * gutters are a bigger share.
   */
  private refreshLabelChrome(w: number, h: number): void {
    const spanningTop = (el: HTMLElement | null | undefined): number | null => {
      const rect = el?.getBoundingClientRect();
      if (!rect || !(rect.height > 0) || !(rect.top > 0)) return null;
      return rect.width >= w - 32 ? rect.top : null;
    };
    if (this.labelChromeForW !== w || this.labelChromeForH !== h) {
      this.labelChromeForW = w;
      this.labelChromeForH = h;
      let top: number | null = null;
      const bar = document.getElementById('planetarium-bottom-bar')?.getBoundingClientRect();
      if (bar && bar.height > 0 && bar.top > 0) top = bar.top;
      // The console's shape is decided by the viewport alone, so its span is
      // as cacheable as the bar's.
      const consoleTop = spanningTop(document.getElementById('map-console'));
      if (consoleTop !== null) top = top === null ? consoleTop : Math.min(top, consoleTop);
      this.labelStaticChromeTopPx = top;
    }
    let top = this.labelStaticChromeTopPx;
    for (const el of this.labelSheetEls) {
      if (!el?.classList.contains('visible')) continue;
      const sheetTop = spanningTop(el);
      if (sheetTop !== null) top = top === null ? sheetTop : Math.min(top, sheetTop);
    }
    this.labelMaxBoxTopCachedPx = labelMaxBoxTopPx(top, h);
  }

  /**
   * The label's own half-width, taken once and kept.
   *
   * It cannot be read where the label sits: a label is built `display: none`
   * inside a container hidden until the map opens, and offsetWidth there answers
   * 0 — which the box test would take for "no width", degrading to the anchor
   * rule with every unit test still green. So an unmeasured label is revealed
   * off screen for the read and put straight back, BEFORE the placer judges it.
   *
   * Measuring before rather than after the placement is what makes the nominal a
   * guard instead of a working value. Reading it afterwards leaves two holes: a
   * label's first frame is judged at a width nobody measured, and — worse — a
   * label culled on that frame is never revealed, so it never gets measured and
   * keeps the assumed width for the rest of the session.
   *
   * One forced layout per label per session, on the frame it first comes into
   * view. Measured across a Saturn reveal, which builds eighteen of them at
   * once: frame-time medians identical to before at 8.30 ms, worst frame 14.8 →
   * 16.2 ms on a frame already building eighteen moons.
   */
  private labelHalfWidthFor(name: string, label: HTMLDivElement): number {
    const cached = this.labelHalfWidths.get(name);
    if (cached !== undefined) return cached;
    const prevDisplay = label.style.display;
    const prevTransform = label.style.transform;
    // Off screen for the read, so it cannot flash at a position nothing chose.
    label.style.transform = 'translate(-9999px, -9999px)';
    label.style.display = '';
    const w = label.offsetWidth;
    label.style.display = prevDisplay;
    label.style.transform = prevTransform;
    if (!(w > 0)) return LABEL_NOMINAL_HALF_WIDTH_PX;
    this.labelHalfWidths.set(name, w / 2);
    return w / 2;
  }

  /**
   * How far below a body's centre its label sits. The ONE definition — the cull
   * above and the transform that draws the label both read it, so a label can
   * never be judged at one place and painted at another.
   *
   * What it has to clear is what the body PAINTS, which is a question for the
   * size policy and not for this: a globe's disc and a marker's gradient both
   * end at the drawn radius, but they get there by different routes. Moons are
   * the case that bites hardest — they went through here with no entry of their
   * own and took the flat floor, which puts a name like Ganymede's inside its
   * own marker at every focused view of Jupiter.
   *
   * The clearance is always the UNHOVERED one. A hovered body swells, and a
   * label that moved with it would jitter as the cursor crossed; the residual
   * overlap under the cursor is deliberate and small.
   */
  private labelOffsetPxFor(name: string): number {
    // The Sun draws no orbit entry but does draw a disc — up to the size
    // policy's ceiling, which is twice the flat offset. Its billboard is a
    // limb-darkened disc rather than the planets' gradient, so the disc rule is
    // the right one for it, and it is the rule it already had.
    if (name === SUN_DATA.name) return mapLabelOffsetPx(this.sunRadiusPx);
    const entry = this.entryFor(name);
    if (entry) {
      // Which LOOK drew, not whether the sprite is on screen: the occlusion gate
      // hides a dot without changing the size it would have drawn at.
      return mapLabelOffsetPx(labelClearanceRadiusPx(entry.drawnRadiusPx, !entry.globeDrawn));
    }
    const moon = this.moonEntryFor(name);
    if (moon) {
      return mapLabelOffsetPx(labelClearanceRadiusPx(moon.drawnRadiusPx, !moon.globeDrawn));
    }
    return mapLabelOffsetPx(null);
  }

  private ensureLabelContainer(): void {
    if (this.labelSheetEls.length === 0) {
      this.labelSheetEls = ['map-card', 'map-focus-menu', 'map-info-popover']
        .map((id) => document.getElementById(id));
    }
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
    // depthTest ON: a true-sized globe writes depth (transparent at full
    // opacity, but drawn first — see the render-order ladder note), so a
    // depth-free line (the dot-era default) would paint straight across every
    // disc afterwards. Tested, the line dies at the limb and re-emerges past
    // it — a body occludes its own orbit. No depth write: the lines must
    // never occlude each other or the sprites.
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
    // After the spheres, whose written depth is what ends an orbit line at a
    // globe's limb — see the render-order ladder note.
    line.renderOrder = ORBIT_LINE_RENDER_ORDER;
    line.frustumCulled = false;
    this.scene.add(line);
    const dot = this.makeGlowSprite(planet.color);
    dot.renderOrder = MARKER_RENDER_ORDER;
    this.scene.add(dot);
    const { globe, globeMat, globeMesh, ringMesh, globeShading, ringMat, ringOuterFactor } =
      this.makeGlobe(planet);
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
      epochUtcMs: Number.NaN,
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
      globeMesh,
      ringMesh,
      globeShading,
      ringMat,
      ringOuterFactor,
      drawnRadiusPx: mapMarkerRadiusPx(planet.radiusAU, this.bodySizeParams),
      globeDrawn: false,
      occluded: false,
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
    globeMesh: THREE.Mesh;
    ringMesh: THREE.Mesh | null;
    globeShading: MapGlobeShading;
    ringMat: THREE.MeshStandardMaterial | null;
    ringOuterFactor: number;
  } {
    const globe = new THREE.Group();
    globe.visible = false;
    // Transparent at full opacity: same pixels, but drawn from the sprites'
    // pass so a floored sphere can composite by the marker orders — see the
    // GLOBE_RENDER_ORDER note. Constant, so the program's identity never moves.
    const globeMat = new THREE.MeshStandardMaterial({
      roughness: 0.9,
      metalness: 0.0,
      transparent: true,
    });
    const globeShading = augmentMapGlobeMaterial(globeMat, this.sunUniforms);
    const mesh = new THREE.Mesh(this.globeGeo, globeMat);
    mesh.renderOrder = GLOBE_RENDER_ORDER;
    globe.add(mesh);

    let ringMat: THREE.MeshStandardMaterial | null = null;
    let ringMesh: THREE.Mesh | null = null;
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
        // Warm, and held back, against the chart's cool night fill.
        //
        // The world's ring is lit by sunlight alone and reads as warm tan. The
        // chart lights everything with a second, deliberately blue fill so an
        // unlit hemisphere is not a hole — and an annulus has no unlit side to
        // spend that on, so it takes the whole fill as a flat lift over its
        // entire face. Measured on the ring's own pixels, that came out COOLER
        // than the ring texture is (red/blue 1.13, against 1.88 for the same
        // texture in the world) and washed the ring plane into a smoky disc
        // that the globe's night side disappeared into. The tint is a hue
        // correction first and a dim second: it takes the red/blue past the
        // world's and drops the wash about a seventh, which is what lets the
        // texture's own banding read again. It is the material's own, so
        // nothing else on the chart moves with it.
        color: new THREE.Color(RING_TINT),
        // A trace of self-glow, so the ring never disappears entirely in the
        // seasons where the Sun grazes its plane.
        emissive: new THREE.Color(0x1a1510),
        depthWrite: false,
      });
      const ring = new THREE.Mesh(geo, ringMat);
      // After its sphere, so the sphere's depth culls the annulus's far half
      // and passes the near one — and after the orbit lines (depth-tested but
      // never depth-writing), so the ring blends over any line in its
      // footprint.
      ring.renderOrder = GLOBE_RING_RENDER_ORDER;
      globe.add(ring);
      ringMesh = ring;
      ringOuterFactor = cfg.outerFactor;
    }
    return { globe, globeMat, globeMesh: mesh, ringMesh, globeShading, ringMat, ringOuterFactor };
  }

  private makeGlowSprite(color: number): THREE.Sprite {
    const mat = new THREE.SpriteMaterial({
      map: this.glowTexture(),
      color,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    return new THREE.Sprite(mat);
  }

  /** The marker every body on the chart is drawn with, straight off the size
   *  policy's alpha profile — the one place that says how much of the quad a dot
   *  covers, so the sprite and everything that has to clear it read the same
   *  shape. 128 texels across, because the profile's feather is a tenth of the
   *  radius and a coarser canvas would quantise it into the stair it exists to
   *  avoid.
   *
   *  ONE texture for the whole chart, built on the first marker and shared by
   *  every one after it: the mark is the same shape for every body (the tint
   *  rides on the material, not on the pixels), and seventy-odd copies of it
   *  would be seventy-odd uploads of the same megabyte-and-a-half. */
  private glowTex: THREE.Texture | null = null;

  private glowTexture(): THREE.Texture {
    if (this.glowTex) return this.glowTex;
    this.glowTex = this.makeGlowTexture();
    return this.glowTex;
  }

  /** Authored pixel by pixel, never painted with a gradient fill: WebKit
   *  corrupts RGB when a gradient-filled translucent canvas is uploaded to
   *  WebGL without premultiply (three's default) — a quarter of the texels
   *  come back with channel noise, worst in the near-opaque band where this
   *  profile's flat core sits, and every marker on the chart speckles on
   *  Safari. putImageData-authored pixels upload clean on every engine; the
   *  solar disc and halo below are built the same way for the same reason. */
  private makeGlowTexture(): THREE.Texture {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(size, size);
    const data = img.data;
    const c = size / 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const t = Math.hypot(x + 0.5 - c, y + 0.5 - c) / c;
        const i = (y * size + x) * 4;
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
        data[i + 3] = Math.round(255 * dotGradientAlpha(t));
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    applyTextureDefaults(tex, 'color');
    return tex;
  }

  /**
   * The solar disc: a limb-darkened billboard rather than a lit sphere, since a
   * star is its own light.
   *
   * depthTest ON, alone among the chart's sprites. A true-sized globe writes
   * depth from its early slot in the ladder, so this is what stops the star
   * painting straight over a planet the camera has resolved in front of it;
   * behind one, the disc's own depth is nearer and it paints as before. It
   * still writes no depth — the disc must never occlude the markers (or the
   * depth-free floored globes riding the marker orders), which is the other
   * half of the question and is answered analytically.
   */
  private makeSunDiscSprite(): THREE.Sprite {
    const mat = new THREE.SpriteMaterial({
      map: this.makeSunDiscTexture(),
      color: SUN_DATA.color,
      transparent: true,
      depthTest: true,
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
