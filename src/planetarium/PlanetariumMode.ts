/**
 * PlanetariumMode — controller for the "Planets" fly-through mode. Owns the
 * player ship, scene population (Sun, planets, moons, starfield, constellations),
 * DOM HUD wiring, autopilot/landing state, historic-journey playback, and
 * persistence. Uses a floating-origin pattern: the player sits at scene origin
 * and all world objects are offset by the player's AU position each frame.
 * Self-contained pieces are extracted to siblings — world/starfield,
 * input/GyroSteering, ui/* panels, labels (PlanetLabels / SunLabel /
 * Constellations), persistence (PlanetariumStore). The tightly-coupled
 * per-frame core (update pipeline, camera, navigation, landing, missions) stays
 * here on purpose: splitting it would scatter shared state behind indirection.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  CREATE_SOLAR_SYSTEM_TOTAL_UNITS,
  createSolarSystem,
  resampleOrbitLines,
  type SolarSystemObjects,
  type PlanetariumLayout,
} from './SolarSystem';
import { PlayerShip } from './PlayerShip';
import { PlanetLabels } from './PlanetLabels';
import { PlanetariumStore, createDefaultPlanetariumState, type PlanetariumState, type LandedTarget } from './PlanetariumStore';
import { computeStats } from './stats';
import { PLANETARIUM_BODIES, type PlanetData } from './planets/planetData';
import { createMoonMeshes, createShaderWarmupProbes, setWarmEligibleMoonParents, upgradeTextureOnApproach, type MoonMesh, type TextureUpgrade } from './PlanetFactory';
import { bindTextureWarmer, pumpTextureWarmQueue, queueTextureWarm, resetTextureWarmer } from './world/textureWarmer';
import {
  advancePlanetariumTime,
  computeBodyPositionAU,
  computeBodyState,
  eclipticToEquatorial,
  formatDateCompact,
  formatTimeRateLabel,
  formatUtcLabel,
  parseUtcInputValue,
  raDecToVector,
  stepSimulationRate,
  type SimulationTime,
} from '../astronomy/planetary';
import {
  computeMoonOffsetEquatorialAU,
  getMoonApoapsisAU,
  getMoonDisplayOrbit,
  getSatelliteApoapsisAU,
  type MoonDisplayOrbit,
} from '../astronomy/satellites';
import {
  areFociMerged,
  deriveOrbitGeometry,
  formatOrbitReadout,
  isCircularDegenerate,
  needsResample,
  orbitSampleSegments,
  sampleSpanTimesMs,
  sectorWindows,
  shouldCloseLoop,
} from './orbitDetails';
import { OrbitDetailsVisuals } from './world/OrbitDetailsVisuals';
import { TIME_RATE_PRESETS } from './timeRates';
import {
  computeMoonShading,
  findShadowEvent,
  listShadowEventSpecs,
  searchShadowEvent,
  type MoonShadingState,
  type ShadowEvent,
  type ShadowEventSpec,
} from '../astronomy/shadows';
import { ShadowVisuals, type GuideSlotInput } from './world/ShadowVisuals';
import { OBSERVATORY_JUMP_LEAD_MS, stepperSearchFromUtcMs } from './observatoryTime';
import { findEvent, type EventType } from '../astronomy/ephemeris';
import { KM_PER_AU } from '../astronomy/constants';
import { createPlanetariumStarfield } from './world/starfield';
import { MoonPainter } from './world/MoonPainter';
import { ProceduralMoonTexturer } from './world/ProceduralMoonTexturer';
import { captureDeviceTextureCaps } from './world/texturePolicy';
import { planetshineIntensity } from './world/planetshine';
import { debugError } from '../shared/debug';
import { GyroSteering } from './input/GyroSteering';
import { SurfaceLook } from './input/SurfaceLook';
import {
  angularDiameterDeg,
  bodyDisplayName,
  clampSurfaceFovDeg,
  computeShadowSpotVantage,
  computeSubTargetVantage,
  entryFovDeg,
  formatDiscDeg,
  isBelowResolutionAtMaxZoom,
  makeSurfaceTargetChoice,
  MARKER_BRACKETS_MIN_PX,
  orderSurfaceTargetChoices,
  projectedDiscPx,
  resolveMarkerKind,
  selectSurfaceTarget,
  SURFACE_FOV_DEFAULT_DEG,
  SURFACE_FOV_MIN_DEG,
  SURFACE_TARGET_ELEVATION_DEG,
  surfaceAltitudeAU,
  surfaceEventExpectation,
  surfaceEventNarrative,
  surfaceTargetKey,
  transportTrackingUp,
  type SurfaceEntryContext,
  type SurfaceMarkerKind,
  type SurfaceTarget,
  type SurfaceTargetChoice,
} from './surfaceView';
import { DEG2RAD } from '../shared/math/angles';
import { landedFrameCamDistAU, landedMinDistanceAU } from './landedView';
import { KM_CONSTANTS } from '../shared/constants/physicalData';
import { smoothstepUnclamped } from '../shared/math/smoothstep';
import { projectToScreen, type ScreenProjection } from '../shared/three/projectToScreen';
import { setText } from '../shared/dom';
import { Constellations } from './Constellations';
import { getMoonsByPlanet, MOONS, type MoonData } from './planets/moonData';
import { RING_CONFIGS } from './planets/rings';
import { filterDeckRows, groupDeckBodies, observeArrivalAction, type DeckRow } from './deckLogic';
import {
  governedSpeedCap,
  moonArrivalPose,
  rampedSpeedCap,
  MOON_APPROACH_K_PER_S,
  MOON_APPROACH_V_MIN_AU_S,
  MOON_CAP_RELEASE_EFOLD_S,
} from './arrivalLogic';
import {
  canStartTutorial,
  isStepSettled,
  restorePlan,
  totalitySettleUtcMs,
  TUTORIAL_ECLIPSE,
  TUTORIAL_ECLIPSE_APPROACH_RATE,
  TUTORIAL_STEPS,
  TUTORIAL_TIMELAPSE_RATE,
  tutorialTransition,
  type TutorialPhase,
} from './tutorialLogic';
import {
  HISTORIC_JOURNEYS,
  INTERSTELLAR_SCENE_POSITION,
  type HistoricJourney,
  type HistoricMissionId,
  type HistoricMilestone,
} from './missions/historicJourneys';
import { PlanetariumBottomBar } from './ui/PlanetariumBottomBar';
import { PlanetariumHelpModal } from './ui/PlanetariumHelpModal';
import { PlanetariumMenuPanel } from './ui/PlanetariumMenuPanel';
import { PlanetariumNotification } from './ui/PlanetariumNotification';
import { PlanetariumResumePrompt } from './ui/PlanetariumResumePrompt';
import { PlanetariumStatsPanel } from './ui/PlanetariumStatsPanel';
import { PlanetariumTimePanel } from './ui/PlanetariumTimePanel';
import {
  formatObservatoryClock,
  ObservatoryPanel,
  observatoryPhaseText,
  type ObservatoryEventRow,
  type ObservatoryRenderExtras,
  type ObservatorySubjectInfo,
} from './ui/ObservatoryPanel';
import { ObservatoryHUD, type SurfaceHudState } from './ui/ObservatoryHUD';
import { SurfaceTargetMenu } from './ui/SurfaceTargetMenu';
import { SunLabel } from './ui/SunLabel';
import { TutorialCard, tutorialCardModel } from './ui/TutorialCard';

type ScriptedTransfer = {
  elapsed: number;
  duration: number;
  startPos: THREE.Vector3;
  endPos: THREE.Vector3;
  startHeading: number;
  endHeading: number;
  startPitch: number;
  endPitch: number;
  endMoving: boolean;
};

export const FIRST_PLANETARIUM_ACTIVATION_TOTAL_UNITS = CREATE_SOLAR_SYSTEM_TOTAL_UNITS + 1;

/** Cruise pose stashed when the deck grabs the ship out of flight — see the
 *  observatoryExcursion field. */
type ObservatoryExcursion = {
  posX: number; posY: number; posZ: number;
  heading: number; pitch: number;
  speedMultiplier: number; systemSpeedMultiplier: number;
  inSystemMode: boolean; moving: boolean;
};

/** Everything stopTutorial needs to hand the pre-tutorial session back. `state` is
 *  also what getState() serves while a tutorial runs, so every persistence path
 *  (autosave, Save, pagehide, deactivate) keeps writing the pre-tutorial journey. */
interface TutorialSnapshot {
  state: PlanetariumState;
  excursion: ObservatoryExcursion | null;
  panelWasOpen: boolean;
  lastObservatoryEvent: ShadowEvent | null;
}

/** Which end toast a tutorial stop owes the user (none for lifecycle aborts and New Journey). */
type TutorialEndToast = 'skip' | 'return' | null;

/** The deck's tabs — one per cluster button. */
type DeckVerb = 'observe' | 'travel' | 'pilot';

/** Mix a catalog color toward a target — the deck's planet-dot sphere shading. */
function mixHex(hex: number, target: number, t: number): string {
  const ch = (shift: number) => {
    const a = (hex >> shift) & 255;
    const b = (target >> shift) & 255;
    return Math.round(a + (b - a) * t);
  };
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}

const OBSERVATORY_EVENT_LABELS: Record<EventType, string> = {
  'full-moon': 'Full Moon',
  'new-moon': 'New Moon',
  'lunar-eclipse': 'Lunar Eclipse',
  'solar-eclipse': 'Solar Eclipse',
};

export interface PlanetariumActivationProgress {
  completedUnits: number;
  totalUnits: number;
}

export class PlanetariumMode {
  private static readonly SHIP_CLEARANCE_AU = (1_737.4 / KM_PER_AU) * 1.5;
  /** Chase-camera trail distance behind the ship (also the moon-arrival
   *  standoff's camera correction — the apparent size the user sees is
   *  measured from back here, not from the ship). */
  private static readonly CRUISE_CAM_DIST_AU = 0.000094;
  // Conservative disc radius for ship occlusion. Default hull is ~3 moon-radii
  // long with 0.5x group scale applied → half-length ≈ 0.75 moon-radii.
  private static readonly SHIP_OCCLUDER_RADIUS_AU = (1_737.4 / KM_PER_AU) * 0.75;
  private static readonly UI_REFRESH_INTERVAL_S = 1 / 8;
  private static readonly SCENE_NORTH = new THREE.Vector3(0, 1, 0);
  /** A moon's mesh never renders below this fraction of its parent's radius, so
   *  tiny moons stay visible; the landed camera frames off the same inflated size.
   *  This is the flythrough/default floor — see moonRenderFloorRatio for how it
   *  lowers while observing a planet. */
  private static readonly MOON_MIN_RENDER_RATIO = 0.05;
  /** Lower floor used only while observing a planet: the moons shrink toward
   *  their true relative sizes so the system reads honestly instead of every
   *  moon pinning to one size. At ~2.5% the big moons (Galileans, Titan, the
   *  Uranian majors) separate by true size while genuine specks stay visible. */
  private static readonly OBSERVE_PLANET_MOON_FLOOR = 0.025;
  /** Ecliptic north in the scene's equatorial frame (tidal-lock roll reference for Earth's Moon). */
  private static readonly ECLIPTIC_NORTH = eclipticToEquatorial(new THREE.Vector3(0, 1, 0));
  private static readonly EARTH_DETAIL_MIN_DISTANCE_AU = 0.03;
  private static readonly EARTH_DETAIL_MIN_ANGULAR_DIAMETER_RAD = 0.003;
  /** Per-frame wall-clock slice for the Observatory panel's upcoming-events search. */
  private static readonly OBSERVATORY_SEARCH_FRAME_BUDGET_MS = 4;
  private static readonly OBSERVATORY_EVENTS_MAX_ROWS = 6;
  private static readonly MISSION_CONTROL_IDS = [
    'planetarium-btn-travel',
    'planetarium-btn-observatory',
    'planetarium-btn-autopilot',
    'planetarium-btn-tutorial',
    'planetarium-speed-up',
    'planetarium-speed-down',
  ] as const;

  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
  private isTouchDevice = 'ontouchstart' in window;

  private solarSystem: SolarSystemObjects | null = null;
  private player: PlayerShip;
  private planetLabels: PlanetLabels | null = null;
  private store: PlanetariumStore;
  private starfield: THREE.Points | null = null;
  private constellations: Constellations | null = null;
  private showConstellations = false;
  private showBodyLabels = true;
  private showOrbitLines = false;

  // Planet world positions in AU (true positions, not offset)
  private planetWorldPositions = new Map<string, { x: number; y: number; z: number }>();

  // Planet moons: map from planet name to array of moon meshes
  private planetMoons = new Map<string, MoonMesh[]>();

  // One scene-level group per planet-with-moons, translated to the planet each
  // frame. Moons parent here rather than in planet.group, whose quaternion
  // includes the daily spin — moon offsets are world-frame and must not rotate
  // with the surface.
  private moonSystemGroups = new Map<string, THREE.Group>();
  // Lazy moon-texture painter (see MoonPainter). The injected paint fn keeps it
  // testable; the controller drives the background drain from updateMoonPositions
  // and the synchronous gate paint when a system is about to become visible. The
  // injected fn is the GPU texturer's paint (synchronous CPU fallback inside);
  // both are assigned in the ctor once the renderer exists.
  private moonTexturer!: ProceduralMoonTexturer;
  private moonPainter!: MoonPainter;
  private static readonly MOON_PAINT_FRAME_BUDGET_MS = 8;
  // Cap on background (pump) paints per frame. GPU paint submits in sub-ms, so
  // the time budget alone wouldn't bound it — one call would burst every pending
  // system's render targets/mipmaps in a frame. The gate path is uncapped (it
  // must fully paint the system about to show).
  private static readonly MOON_PAINT_MAX_PER_FRAME = 4;
  // Resolution a procedural moon is re-rendered to when observed (landed): the
  // Observatory frames any body to a fixed screen fraction regardless of size,
  // so the flythrough baseline (256/512) looks low-res up close. GPU paint makes
  // this nearly free; the result stays for the session.
  private static readonly OBSERVE_MOON_TEXTURE_WIDTH = 1024;

  // Per-frame time budget for warm texture uploads: small maps batch within
  // it, a 4K map takes its frame alone (the pump always uploads at least one).
  private static readonly TEXTURE_WARM_BUDGET_MS = 6;
  // Arrival veil re-entrancy guard (rapid picks, or a pick while one is running).
  private arrivalInFlight = false;
  /** Monotonic veil-cover token: each veiled arrival claims the veil, so a
   *  previous arrival's lift timer can't uncover a newer arrival mid-flight.
   *  Reachable whenever a new veiled arrival starts inside the last one's
   *  reveal dwell — e.g. a parked tutorial stop restoring the moment the
   *  in-flight flag clears, or two quick deck picks. */
  private arrivalCoverGen = 0;
  private static readonly ARRIVAL_MIN_DWELL_MS = 150;
  // Longest the arrival cover waits (from cover start) for the landed pair's
  // in-flight 4K fetch+decode before revealing anyway — a stalled fetch must
  // never pin the veil.
  private static readonly ARRIVAL_UPGRADE_HOLD_MAX_MS = 900;
  private tmpMoonOffset = new THREE.Vector3();
  private tmpMoonOrbitNormal = new THREE.Vector3();
  private tmpMoonShadowLocal = new THREE.Vector3();
  private tmpMoonShadowQuat = new THREE.Quaternion();
  private tmpPlanetshine = new THREE.Vector3();
  private tmpLocalSunDir = new THREE.Vector3();
  private tmpInvGroupQuat = new THREE.Quaternion();
  private tmpShadingParentPos = new THREE.Vector3();
  private moonShading: MoonShadingState = { sunVisibleFraction: 1, inUmbra: false };
  // Landed-system shadow visuals: transit spots always on, guides behind the
  // Observatory panel toggle (session-only, deliberately not persisted).
  private shadowVisuals = new ShadowVisuals();
  private showShadowGuides = false;
  // Orbit-details overlay (Observatory footer toggle; session-only, like the
  // shadow guides). orbitPairMoon remembers the moon of the vantage pair
  // across a moon→parent swap so the subject survives standing on the parent
  // (a generic parent has no swap chip back to the moon).
  private orbitDetailsVisuals = new OrbitDetailsVisuals();
  private showOrbitDetails = false;
  private orbitPairMoon: { moonName: string; parentName: string } | null = null;
  private orbitSampleRefUtcMs = 0;
  private orbitSampledSubject: string | null = null;
  private orbitFocusF1El: HTMLElement | null = null;
  private orbitFocusF2El: HTMLElement | null = null;
  private orbitFocusF1SpanEl: HTMLElement | null = null;
  private orbitFocusF2SpanEl: HTMLElement | null = null;
  private tmpOrbitFocus1 = new THREE.Vector3();
  private tmpOrbitFocus2 = new THREE.Vector3();
  private orbitFocusProjection: ScreenProjection = { x: 0, y: 0, ndcX: 0, ndcY: 0, ndcZ: 0 };
  // Moons the guides follow: [0] the landed/companion subject, [1] the live
  // event's moon when it differs. Names + orbit normals refreshed per frame.
  private guideSlotInputs: GuideSlotInput[] = [
    { name: null, orbitNormal: new THREE.Vector3(0, 1, 0) },
    { name: null, orbitNormal: new THREE.Vector3(0, 1, 0) },
  ];
  private tmpGuideOffset = new THREE.Vector3();
  private tmpGuideCamLocal = new THREE.Vector3();
  private tmpGuideReticle = new THREE.Vector3();
  private guideReticleProjection: ScreenProjection = { x: 0, y: 0, ndcX: 0, ndcY: 0, ndcZ: 0 };
  private footprintReticleEl: HTMLElement | null = null;
  private tmpLockToParent = new THREE.Vector3();
  private tmpLockBasisZ = new THREE.Vector3();
  private tmpLockUp = new THREE.Vector3();
  private tmpLockBasis = new THREE.Matrix4();

  private keys = new Set<string>();

  // Orbit crossing notifications
  private lastCrossedOrbit: string | null = null;
  private notification = new PlanetariumNotification();
  private uiWired = false;

  // Autopilot: auto-steer toward target. Off until the user engages it.
  private autopilot = false;
  private autopilotTarget: NonNullable<LandedTarget> | null = null;
  // Provenance: did the user pick the target, or is it a legacy-save leftover?
  // Only user-engaged targets render the "→ name" chip or survive a landing.
  private autopilotUserEngaged = false;

  // Moon world positions in AU (true positions, not offset)
  private moonWorldPositions = new Map<string, { x: number; y: number; z: number }>();
  /** The latest moon-jump target, governed and collision-checked by name
   *  while its mesh may still be unpainted behind the arrival veil (the
   *  visibility-keyed set can't see it there). Drops once the mesh shows;
   *  a stale seed is neutralized by distance on its own. */
  private governedMoonSeed: { name: string; parentPlanet: string } | null = null;
  /** Last applied moon speed cap — the ramp's memory across frames. */
  private moonCapEased = Infinity;
  /** Whether a moon would cap the ship this frame (closing on a governed moon),
   *  independent of whether an override is currently bypassing it. Lets the
   *  override auto-clear tell that a moon is still being escaped — outer moons
   *  sit well beyond the parent's system-throttle radius. */
  private moonCapEngaged = false;
  /** Player position at the top of the frame — the collision sweep needs the
   *  whole segment, not the endpoint (one 100 ms frame at the in-system
   *  default steps ~2,500 km, clean through a small moon's bubble). */
  private prevPlayerPos = new THREE.Vector3();

  private layoutMode: PlanetariumLayout = 'realistic';

  private timeState: SimulationTime = {
    currentUtcMs: Date.now(),
    rate: 1,
    paused: false,
  };

  // Planet visual scale multiplier (real scale = 1)
  private planetScale = 1;

  // Dual-speed system: throttle near planets
  private systemSpeedFactor = 1.0; // 1 = open space, 0 = deep in system
  private nearestSystemPlanet: string | null = null;
  private inSystemMode = false;
  private throttleOverride = false; // true = user temporarily disabled system throttle (tap)
  private systemSlowdown = true;   // false = user permanently disabled via settings

  // Show player ship mesh for size comparison
  private showShip = true;
  // Headless screenshot framing: when set, the per-frame collision resolver is
  // skipped so the camera can sit a few radii from a body without being pushed
  // back out past its moon system.
  private devFreeCamera = false;

  // Touch and gyro flight state
  private touchYaw = 0;
  private touchPitch = 0;
  private touchThrottle = 0;
  private activeFlightTouchId: number | null = null;
  private gyro: GyroSteering;

  // Chase camera state
  private userOrbiting = false;
  private userOrbitTimeout: number | null = null;
  private orbitDragging = false;
  private orbitPointerStartX = 0;
  private orbitPointerStartY = 0;

  // Landed mode: camera orbits a planet/moon while ship is hidden
  private landedOn: LandedTarget = null;
  private preLandSpeed = 0;
  private preLandAutopilot = false;
  /** Cruise pose stashed when the Observatory menu grabs the ship out of
   * flight (an "excursion"): Leave then returns it exactly there instead of
   * the takeoff vector. Survives vantage swaps and event jumps (re-lands via
   * applyLandedTarget); session-only by design — never persisted, and cleared
   * by New Journey, mission start, and deactivate. */
  private observatoryExcursion: ObservatoryExcursion | null = null;
  private nearbyLandTarget: NonNullable<LandedTarget> | null = null;

  // The deck: one centered picker (Observatory · Travel · Autopilot tabs)
  // replacing the separate travel and observatory menus. Session UI only.
  private deckVerb: DeckVerb | null = null;
  /** Deck opened via the panel's "From ⟨body⟩ ▾": the observe pick keeps the
   * panel open on arrival despite a quiet preference. Survives in-deck tab
   * switches; resets on open, close, and cluster-button switches. */
  private deckOpenedFromPanel = false;
  /** Keyboard highlight index into the deck's visible rows (−1 = none). */
  private deckHl = -1;
  /** Stored sky-panel-on-arrival preference — null until the user flips the
   * toggle. The effective value resolves the device default at read time
   * (fine pointers → on) so an untouched preference is never persisted. */
  private skyPrefStored: boolean | null = null;

  // Surface view (Observatory): narrow-FOV look-from-the-surface sub-state of
  // landed mode. Session-only — never persisted; restore always lands in orbit
  // view. While active, OrbitControls hand over to SurfaceLook and the camera
  // is re-pinned every frame at the end of updateLanded.
  private landedView: 'orbit' | 'surface' = 'orbit';
  private surfaceTarget: SurfaceTarget = { kind: 'sun' };
  // The Look-at menu pick "Look up" returns to for the rest of this landing —
  // cleared on every ground change (applyLandedTarget) and on takeoff.
  private surfacePickedTarget: SurfaceTarget | null = null;
  private surfaceFovDeg = SURFACE_FOV_DEFAULT_DEG;
  private surfaceTracking = true;
  private surfaceLook: SurfaceLook;
  private preSurfaceCameraPos = new THREE.Vector3();
  private preSurfaceAutoRotate = false;
  // Entry/exit/re-point FOV ease. fromPos is set on entry only (the camera
  // glides from its orbit position down to the vantage); finalizeExit runs
  // the orbit-view restore when the ease completes.
  private surfaceFovAnim: {
    fromFov: number;
    toFov: number;
    fromPos: THREE.Vector3 | null;
    elapsed: number;
    duration: number;
    finalizeExit: boolean;
  } | null = null;
  private tmpSurfaceTargetPos = new THREE.Vector3();
  private tmpSurfaceVantage = new THREE.Vector3();
  private tmpSurfaceAxis = new THREE.Vector3();
  private tmpSurfaceZenith = new THREE.Vector3();
  private tmpSurfaceRight = new THREE.Vector3();
  private tmpSurfaceQuat = new THREE.Quaternion();
  // Tracking-camera up, parallel-transported frame to frame (see
  // updateSurfaceCamera). Persistent state, not a scratch vector.
  private surfaceUpTangent = new THREE.Vector3(0, 1, 0);
  // Vantage azimuth reference: the landed body's north. Planets cache their
  // IAU pole at landing; moons refresh their orbit normal per frame (the
  // same reference the tidal lock rolls on).
  private surfacePoleAxis = new THREE.Vector3(0, 1, 0);
  private tmpSurfacePoleOffset = new THREE.Vector3();
  // Marker over the tracked target — sticky across the hysteresis band.
  private surfaceMarkerKind: SurfaceMarkerKind = 'brackets';
  // Observatory-panel rect, cached per viewport size for the chevron clamp
  // (the panel is CSS-fixed; it only moves on resize — desktop side panel
  // vs ≤640px bottom sheet).
  private panelRectCache: { w: number; h: number; left: number; top: number } | null = null;

  // Moon labels
  private moonLabels = new Map<string, HTMLDivElement>();
  private moonLabelContainer: HTMLDivElement | null = null;
  // Pooled per-frame scratch for renderMoonLabels' de-overlap pass.
  private moonLabelCandidates: Array<{
    label: HTMLDivElement;
    sx: number;
    sy: number;
    onScreen: boolean;
    priorityPx: number;
    halfW: number;
  }> = [];
  private resumePrompt = new PlanetariumResumePrompt();
  private helpModal = new PlanetariumHelpModal();
  private menuPanel = new PlanetariumMenuPanel();
  private bottomBar = new PlanetariumBottomBar();
  private statsPanel = new PlanetariumStatsPanel();
  private timePanel = new PlanetariumTimePanel(TIME_RATE_PRESETS, {
    onRateIndex: (index) => this.setRailRateIndex(index),
    onStep: (direction) => this.stepTimeRate(direction),
    onPauseToggle: () => this.timeTogglePause(),
    onNow: () => this.timeJumpToNow(),
  });
  private observatoryPanel = new ObservatoryPanel(
    (type, direction) => this.handleObservatoryJump(type, direction),
    (event) => this.jumpToShadowEvent(event),
    (on) => {
      this.showShadowGuides = on;
      this.shadowVisuals.setGuidesVisible(on);
    },
    () => this.cancelObservatoryEventSearch(),
    () => this.toggleSurfaceView(),
    () => this.swapLandedVantage(),
    (on) => this.handleOrbitDetailsToggle(on),
    () => {
      // Sheet detents move the panel's top edge at constant viewport — the
      // chevron clamp's per-viewport rect cache must re-measure.
      this.panelRectCache = null;
    },
    // "From ⟨body⟩ ▾": the vantage picker, with the panel kept open behind —
    // the observe commit then opens the new sky's panel even on a quiet
    // preference (companionless arrivals stay quiet).
    () => this.openDeck('observe', { fromPanel: true }),
  );
  private observatoryHud = new ObservatoryHUD(
    () => this.exitSurfaceView(),
    () => this.swapLandedVantage(),
    () => {
      // Mid-exit the affordance is dead: re-tracking would fight the ease
      // and the exit completes anyway.
      if (this.landedView !== 'surface' || this.surfaceFovAnim?.finalizeExit) return;
      this.surfaceTracking = true;
      // Resume from the free-look orientation without a roll snap.
      this.surfaceUpTangent.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
      this.renderSurfaceHud();
    },
    () => this.toggleObservatoryPanel(),
    () => {
      if (this.surfaceTargetMenu.isOpen()) this.closeSurfaceTargetMenu();
      else this.openSurfaceTargetMenu();
    },
    (action) => {
      // The strip and the bottom bar drive the same clock through the same
      // handlers — one idiom, no duplicate state.
      if (action === 'toggle-pause') this.timeTogglePause();
      else if (action === 'slower') this.stepTimeRate(-1);
      else if (action === 'faster') this.stepTimeRate(1);
      else this.timeJumpToNow();
      this.renderSurfaceHud();
    },
  );
  private surfaceTargetMenu = new SurfaceTargetMenu(
    (target) => this.pickSurfaceTarget(target),
    // Fires on every close, whatever triggered it — the helper self-gates on
    // surface view and the labels setting, so this can't reveal stale labels.
    () => this.setWorldLabelsVisible(true),
  );
  private tutorialCard = new TutorialCard(
    () => this.advanceTutorial(),
    () => this.backTutorial(),
    () => this.stopTutorial({ restore: true, toast: 'skip' }),
    () => this.stopTutorial({ restore: true, toast: 'return' }),
  );
  // The most recent event jump — gives "Look up" and the surface HUD their
  // narrative while the clock still sits inside the event's window.
  private lastObservatoryEvent: ShadowEvent | null = null;
  // The most recent phase jump (full/new moon) — steppers dedupe against it
  // the same way the eclipse steppers dedupe against lastObservatoryEvent.
  private lastPhaseJump: { type: EventType; utcMs: number } | null = null;
  private observatoryNextDatesCache: {
    computedAtUtcMs: number;
    fullMs: number | null;
    newMs: number | null;
  } | null = null;

  // Chunked upcoming-events search for the Observatory panel: one spec at a time under
  // a per-frame time budget, restarted on open/jump/date-set, dropped on close.
  private observatoryEventSearch: {
    parentPlanet: string;
    specs: ShadowEventSpec[];
    index: number;
    resumeCursorUtcMs: number | null;
    fromUtcMs: number;
  } | null = null;
  private observatoryEventResults = new Map<string, ShadowEvent>();
  // Earliest end among the *displayed* event rows — with the clock running,
  // crossing it means a row has completed and the search must refresh.
  private observatoryRowsMinEndUtcMs: number | null = null;

  // Sun label
  private sunLabel = new SunLabel();

  // FPS tracking (uses wall-clock time, not dt, for accuracy)
  private fpsFrames = 0;
  private fpsLastTime = performance.now();
  private fpsDisplay = 0;

  // UI elements
  private speedValueEl: HTMLElement | null = null;
  private speedLabelEl: HTMLElement | null = null;
  private speedCenterEl: HTMLElement | null = null;
  private uiRefreshAccumulator = PlanetariumMode.UI_REFRESH_INTERVAL_S;
  private activeHistoricJourney: HistoricJourney | null = null;
  private historicMilestoneIndex = 0;
  private historicPanelDismissed = false;
  private scriptedTransfer: ScriptedTransfer | null = null;
  private preMissionState: PlanetariumState | null = null;
  private preMissionMenuVisible = false;
  private deferredResumePromptState: PlanetariumState | null = null;
  private resumeShipAfterMenu = false;
  private resumeTimeAfterMenu = false;
  private resumeShipAfterHelp = false;
  private resumeTimeAfterHelp = false;
  /** Live guided-tutorial state; null when idle. The generation token is the
   *  defense against late callbacks: every tutorial timer and arrival closure
   *  captures it and no-ops on mismatch after a skip/advance/stop. endRequest
   *  parks a stop that arrived while an arrival was mid-flight (arriveThen
   *  silently drops rival calls); updateTutorial executes it on the first idle
   *  frame. */
  private tutorial: {
    stepIndex: number;
    phase: TutorialPhase;
    snapshot: TutorialSnapshot;
    eclipse: ShadowEvent | null;
    totalityReached: boolean;
    /** A scene step actually staged. False while only card-only steps ran —
     *  ending then has nothing to put back (see executeTutorialStop). */
    everStaged: boolean;
    stagedAtMs: number;
    timer: number | null;
    generation: number;
    endRequest: { restore: boolean; toast: TutorialEndToast } | null;
  } | null = null;

  private closeMenuPanel() {
    if (!this.menuPanel.isOpen()) return;
    this.menuPanel.hide();
    if (this.resumeShipAfterMenu) this.player.moving = true;
    if (this.resumeTimeAfterMenu) this.timeState.paused = false;
    this.resumeShipAfterMenu = false;
    this.resumeTimeAfterMenu = false;
  }

  private isHelpOpen(): boolean {
    return this.helpModal.isOpen();
  }

  private showHelp() {
    if (this.helpModal.isOpen()) return;
    // The action bar recommends the tutorial only on the first-run showing
    // (hasSeenHelp flips when this modal first closes). A Help revisit gets a
    // plain button, and no "Explore on my own" choice — the visitor already is.
    const firstRun = !this.store.hasSeenHelp();
    const takeTutorial = document.getElementById('help-take-tutorial');
    takeTutorial?.classList.toggle('tutorial-btn-primary', firstRun);
    takeTutorial?.classList.toggle('tutorial-btn-ghost', !firstRun);
    const explore = document.getElementById('help-explore');
    if (explore) explore.style.display = firstRun ? '' : 'none';
    this.resumeShipAfterHelp = this.player.moving;
    this.resumeTimeAfterHelp = !this.timeState.paused;
    this.player.moving = false;
    this.timeState.paused = true;
    this.helpModal.show();
  }

  private hideHelp() {
    if (!this.helpModal.isOpen()) return;
    this.helpModal.hide();
    if (this.resumeShipAfterHelp) this.player.moving = true;
    if (this.resumeTimeAfterHelp) this.timeState.paused = false;
    this.resumeShipAfterHelp = false;
    this.resumeTimeAfterHelp = false;
    this.store.markHelpSeen();
  }

  active = false;
  private useBloom: boolean;

  constructor(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    renderer: THREE.WebGLRenderer,
    useBloom = true,
  ) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.useBloom = useBloom;
    // Capture device texture caps from the live renderer before any body loads,
    // so anisotropy and tier limits apply to the very first textures created.
    captureDeviceTextureCaps(renderer);
    // Warm uploads go through the renderer so freshly loaded maps reach the
    // GPU on quiet frames instead of inside a gesture's first draw.
    bindTextureWarmer((tex) => renderer.initTexture(tex));
    // GPU moon-texture painter (synchronous CPU fallback inside). Inject its
    // paint into the lazy painter; MoonPainter's queue + the visibility gate +
    // the arrival veil are unchanged — only the per-moon paint moves to the GPU.
    this.moonTexturer = new ProceduralMoonTexturer(renderer);
    this.moonPainter = new MoonPainter(this.moonTexturer.paint);
    // WebGL context loss invalidates render-target textures (no CPU backing), so
    // GPU-painted moons would render black after a restore. Reset them to repaint
    // and re-validate the GPU path on restore (else it stays on the CPU path).
    const glCanvas = renderer.domElement;
    glCanvas.addEventListener('webglcontextlost', () => {
      this.invalidateRtPaintedMoons(this.moonTexturer.onContextLost());
    });
    glCanvas.addEventListener('webglcontextrestored', () => {
      this.moonTexturer.onContextRestored();
    });
    this.player = new PlayerShip();
    this.store = new PlanetariumStore();

    this.controls = new OrbitControls(camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.enabled = false;
    this.controls.minDistance = 0.00001;
    this.controls.maxDistance = 5;

    // Yield the chase cam only on an actual orbit drag, never on a plain
    // click. We track raw pointer pixels because the chase cam moves the
    // camera every frame, so an angle-based OrbitControls test would
    // false-trigger.
    const orbitDom = renderer.domElement;
    orbitDom.addEventListener('pointerdown', (e) => {
      // Surface view owns the pointer (SurfaceLook): don't let its drags
      // pollute the orbit chase-cam bookkeeping.
      if (!this.active || this.landedView === 'surface') return;
      this.orbitDragging = true;
      this.orbitPointerStartX = e.clientX;
      this.orbitPointerStartY = e.clientY;
      if (this.userOrbitTimeout !== null) {
        clearTimeout(this.userOrbitTimeout);
        this.userOrbitTimeout = null;
      }
    });
    orbitDom.addEventListener('pointermove', (e) => {
      if (!this.orbitDragging || this.userOrbiting) return;
      const dx = e.clientX - this.orbitPointerStartX;
      const dy = e.clientY - this.orbitPointerStartY;
      if (dx * dx + dy * dy > 16) this.userOrbiting = true; // moved > 4px = a drag
    });
    const endOrbitDrag = () => {
      if (!this.orbitDragging) return;
      this.orbitDragging = false;
      // Resume the chase cam shortly after an actual orbit; a click never yielded it.
      if (!this.userOrbiting) return;
      if (this.userOrbitTimeout !== null) clearTimeout(this.userOrbitTimeout);
      this.userOrbitTimeout = window.setTimeout(() => { this.userOrbiting = false; }, 600);
    };
    orbitDom.addEventListener('pointerup', endOrbitDrag);
    orbitDom.addEventListener('pointercancel', endOrbitDrag);
    window.addEventListener('blur', endOrbitDrag); // failsafe if focus is lost mid-drag

    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleKeyUp = this.handleKeyUp.bind(this);
    this.gyro = new GyroSteering((message) => this.notification.show(message), () => this.updateTimeUI());
    this.surfaceLook = new SurfaceLook(
      renderer.domElement,
      (dxPx, dyPx) => this.applySurfaceLook(dxPx, dyPx),
      (factor) => this.applySurfaceZoom(factor),
    );
  }

  hasLoadedSolarSystem(): boolean {
    return this.solarSystem !== null;
  }

  /** The planetarium's simulation clock (UTC ms) — the app's authoritative time. */
  getCurrentUtcMs(): number {
    return this.timeState.currentUtcMs;
  }

  /** Set the simulation clock and refresh world positions + time UI immediately. */
  setCurrentUtcMs(utcMs: number) {
    this.timeState = { ...this.timeState, currentUtcMs: utcMs };
    this.rebuildPlanetPositions();
    this.updateTimeUI();
  }

  // Shared clock handlers — the time rail, its panel, the keyboard, and the
  // surface transport strip drive the same state through these (one clock,
  // one idiom).
  private timeTogglePause() {
    this.timeState.paused = !this.timeState.paused;
    this.updateTimeUI({ flash: true });
  }

  private timeJumpToNow() {
    this.timeState.currentUtcMs = Date.now();
    this.rebuildPlanetPositions();
    this.updateTimeUI();
    // Clock jump invalidates the Observatory panel's upcoming-events list.
    this.startObservatoryEventSearch();
  }

  /** Rail/panel-trail/detent-label commits: snap to the preset magnitude,
   *  keep the clock's direction (reverse scrubs stay reverse), unpause. */
  private setRailRateIndex(index: number) {
    const clamped = Math.max(0, Math.min(TIME_RATE_PRESETS.length - 1, index));
    const sign = this.timeState.rate < 0 ? -1 : 1;
    this.timeState = { ...this.timeState, rate: sign * TIME_RATE_PRESETS[clamped], paused: false };
    this.updateTimeUI({ flash: true });
  }

  /** Dev bridge: stage a clock rate (headless QA of the rail states). */
  setTimeRate(rate: number) {
    this.timeState = { ...this.timeState, rate };
    this.updateTimeUI();
  }

  /** Dev bridge: stage the paused state. */
  setTimePaused(paused: boolean) {
    this.timeState = { ...this.timeState, paused };
    this.updateTimeUI();
  }

  async activate(onProgress?: (progress: PlanetariumActivationProgress) => void): Promise<void> {
    this.active = true;
    // Compile + validate the GPU texturer once, before the visibility gate can
    // run (the gate paints during update(), which only runs while active). The
    // validation makes the GPU path fail closed to CPU; idempotent across calls.
    this.moonTexturer.prewarm();
    // Startup-phase marks — summarized in one console line after the first
    // frame (logStartupTimings in main.ts).
    performance.mark('plm:activate:start');
    const reportActivationProgress = (completedUnits: number) => {
      onProgress?.({
        completedUnits,
        totalUnits: FIRST_PLANETARIUM_ACTIVATION_TOTAL_UNITS,
      });
    };

    const planetariumUI = document.getElementById('planetarium-ui');
    if (planetariumUI) planetariumUI.style.display = 'block';

    // Cache UI element references
    this.statsPanel.bind();
    this.timePanel.bind();
    this.observatoryPanel.bind();
    this.observatoryHud.bind();
    this.surfaceTargetMenu.bind();
    this.tutorialCard.bind();
    this.speedValueEl = document.getElementById('planetarium-speed-value');
    this.speedLabelEl = document.getElementById('planetarium-speed-label');
    this.speedCenterEl = document.querySelector('.speed-center') as HTMLElement | null;

    const savedState = await this.store.loadState();
    // Precompile below runs only on the activation that builds the scene —
    // on later re-activations every program is already cached on the renderer.
    const buildingSolarSystem = !this.solarSystem;
    const initialDefaultState = savedState ? null : createDefaultPlanetariumState();
    if (initialDefaultState) {
      // Persist a starter journey immediately so slow mobile loads can still resume.
      this.store.saveState(initialDefaultState);
    }
    const shouldPromptForResume = !this.solarSystem && !!savedState;
    reportActivationProgress(this.solarSystem ? CREATE_SOLAR_SYSTEM_TOTAL_UNITS : 0);

    if (!this.solarSystem) {
      const initialWorldUtcMs = savedState?.astroTimeUtcMs ?? this.timeState.currentUtcMs;
      performance.mark('plm:solar-system:start');
      try {
        this.solarSystem = await createSolarSystem((progress) => {
          reportActivationProgress(progress.completedUnits);
        }, this.useBloom, this.layoutMode, new Date(initialWorldUtcMs));
      } catch (error) {
        this.resumePrompt.cancel();
        throw error;
      }

      performance.measure('plm:solar-system', 'plm:solar-system:start');

      // Add everything to scene
      this.scene.add(this.solarSystem.sun);
      this.scene.add(this.solarSystem.asteroidBelt);

      performance.mark('plm:moon-meshes:start');
      for (const planet of this.solarSystem.planets) {
        this.scene.add(planet.group);
        const pos = planet.group.position;
        planet.group.userData.worldPosAU = { x: pos.x, y: pos.y, z: pos.z };
        this.planetWorldPositions.set(planet.data.name, { x: pos.x, y: pos.y, z: pos.z });

        const moons = createMoonMeshes(planet.data.name);
        if (moons.length > 0) {
          this.planetMoons.set(planet.data.name, moons);
          const systemGroup = new THREE.Group();
          for (const m of moons) {
            systemGroup.add(m.mesh);
          }
          this.moonSystemGroups.set(planet.data.name, systemGroup);
          this.scene.add(systemGroup);
          // Queue this system's textures for the background drain. The gate
          // paints any system synchronously before it's shown regardless.
          this.moonPainter.enqueue(planet.data.name, moons);
        }

        if (!this.moonLabelContainer) {
          this.moonLabelContainer = document.createElement('div');
          this.moonLabelContainer.id = 'moon-labels';
          this.moonLabelContainer.style.cssText =
            'position:fixed;top:0;left:0;right:0;bottom:0;pointer-events:none;z-index:9;overflow:visible;';
          document.body.appendChild(this.moonLabelContainer);
        }
        for (const m of moons) {
          const label = document.createElement('div');
          label.className = 'moon-label';
          label.textContent = m.data.name;
          label.style.display = 'none';
          this.moonLabelContainer.appendChild(label);
          this.moonLabels.set(m.data.name, label);
        }
      }
      performance.measure('plm:moon-meshes', 'plm:moon-meshes:start');

      for (const orbit of this.solarSystem.orbitLines) {
        this.scene.add(orbit);
      }

      this.scene.add(this.player.group);
      reportActivationProgress(CREATE_SOLAR_SYSTEM_TOTAL_UNITS);
    }

    // Create planet labels.
    if (!this.planetLabels) {
      this.planetLabels = new PlanetLabels(this.scene, this.camera);
    }

    // Create the Planetarium starfield.
    if (!this.starfield) {
      performance.mark('plm:starfield:start');
      this.starfield = createPlanetariumStarfield();
      this.scene.add(this.starfield);
      performance.measure('plm:starfield', 'plm:starfield:start');
    }

    if (savedState && shouldPromptForResume) {
      this.restoreState(savedState);
      this.deferredResumePromptState = savedState;
    } else if (savedState) {
      this.restoreState(savedState);
    } else {
      this.restoreState(initialDefaultState ?? createDefaultPlanetariumState());
      // New users start already gliding, nose on Mercury — motion without a
      // silent autopilot claiming the Pilot control they never touched.
      this.pointTowardMercury();
      this.showIntroText();
    }

    if (this.showConstellations) {
      this.ensureConstellationsReady();
    }

    // Configure camera — disable OrbitControls on touch devices during flight
    // to prevent accidental camera rotation from touches near the bottom bar
    this.controls.enabled = !!this.landedOn || !this.isTouchDevice;
    if (!this.landedOn) {
      this.updateCameraFollow();
    }

    this.store.startAutoSave(() => this.getState());

    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    this.gyro.attach();

    // Wire up UI controls (once only)
    if (!this.uiWired) {
      this.wireUpUI();
      this.uiWired = true;
    }

    this.setObjectsVisible(true);
    // If landed, the ship should stay hidden
    if (this.landedOn) {
      this.player.group.visible = false;
    }

    // Restore moon labels visibility — unless the labels setting owns the hide
    if (this.moonLabelContainer) {
      this.moonLabelContainer.style.display = this.showBodyLabels ? '' : 'none';
    }
    this.uiRefreshAccumulator = PlanetariumMode.UI_REFRESH_INTERVAL_S;
    this.updateMissionControlState();

    if (buildingSolarSystem) {
      // Compile the scene's shader programs while the load screen still covers
      // the canvas — with probe materials for the map/bump/normal combinations
      // moon materials only reach after their async paints and photos arrive —
      // so a first landing or surface view doesn't pay ANGLE program links
      // mid-gesture. Runs after restoreState/starfield/constellations so the
      // compiled set matches what a restored session actually renders.
      // compileAsync submits synchronously and then polls; the race below only
      // guards a hung poll (it cancels no work), and on any failure lazy
      // first-draw compilation remains the fallback.
      performance.mark('plm:precompile:start');
      const probes = createShaderWarmupProbes();
      this.scene.add(probes.group);
      const compiled = this.renderer
        .compileAsync(this.scene, this.camera)
        .catch(() => undefined)
        .then(() => {
          // Probe materials are disposed only once the poll has fully settled —
          // disposing a material mid-poll throws inside a timer callback that
          // no try/catch around the await could reach.
          this.scene.remove(probes.group);
          probes.dispose();
        });
      await Promise.race([compiled, new Promise((resolve) => window.setTimeout(resolve, 3000))]);
      performance.measure('plm:precompile', 'plm:precompile:start');
    }

    reportActivationProgress(FIRST_PLANETARIUM_ACTIVATION_TOTAL_UNITS);
    performance.measure('plm:activate', 'plm:activate:start');
  }

  private ensureConstellationsReady() {
    if (!this.constellations) {
      this.constellations = new Constellations();
      this.scene.add(this.constellations.lines);
    }
    this.constellations.setVisible(this.showConstellations);
  }

  async showDeferredResumePromptIfNeeded(): Promise<void> {
    const savedState = this.deferredResumePromptState;
    if (!savedState || !this.active) return;

    this.deferredResumePromptState = null;
    const shouldResume = await this.resumePrompt.ask(savedState);
    if (!this.active || shouldResume) return;

    this.observatoryExcursion = null;
    if (this.landedOn) {
      this.exitLandedMode();
    }
    this.store.clearState();
    this.restoreState(createDefaultPlanetariumState());
    this.pointTowardMercury();
    this.showIntroText();
  }

  deactivate(): void {
    // A live tutorial hands the pre-tutorial state back first, synchronously — the
    // teardown below (excursion drop, landed exit, save) then applies to the
    // restored journey exactly as it would for a non-tutorialing player.
    if (this.tutorial) this.stopTutorial({ restore: true, sync: true });
    this.resumePrompt.cancel();
    this.bottomBar.closeStats();
    this.bottomBar.closeTime();

    // Exit landed mode cleanly before deactivation. The excursion pose is
    // session-only — drop it first so the exit (and the save below) keep
    // today's takeoff state instead of teleporting the ship back to cruise.
    this.observatoryExcursion = null;
    if (this.landedOn) {
      this.exitLandedMode();
    }

    this.active = false;

    this.store.saveState(this.getState());
    this.store.stopAutoSave();

    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    this.gyro.detach();
    this.touchYaw = 0;
    this.touchPitch = 0;
    this.touchThrottle = 0;
    this.uiRefreshAccumulator = PlanetariumMode.UI_REFRESH_INTERVAL_S;

    this.controls.enabled = false;

    const planetariumUI = document.getElementById('planetarium-ui');
    if (planetariumUI) planetariumUI.style.display = 'none';
    this.closeObservatoryPanel();
    this.closeDeck();
    this.closeSurfaceTargetMenu();

    this.setObjectsVisible(false);

    // The footprint reticle is driven by the per-frame guide pass, which
    // stops with the mode — hide it explicitly so it can't linger. Same for
    // the orbit-details focus glyphs (their pass also stops with the mode).
    this.hideFootprintReticle();
    this.hideOrbitFocusLabels();

    // Dispose planet labels.
    if (this.planetLabels) {
      this.planetLabels.dispose();
      this.planetLabels = null;
    }

    if (this.moonLabelContainer) {
      this.moonLabelContainer.style.display = 'none';
    }
  }

  private setObjectsVisible(visible: boolean) {
    if (this.solarSystem) {
      this.solarSystem.sun.visible = visible;
      this.solarSystem.asteroidBelt.visible = visible;
      for (const p of this.solarSystem.planets) p.group.visible = visible;
      for (const o of this.solarSystem.orbitLines) o.visible = visible && this.showOrbitLines;
      for (const g of this.moonSystemGroups.values()) g.visible = visible;
    }
    this.player.group.visible = visible && this.showShip;
    if (this.starfield) this.starfield.visible = visible;
    if (this.constellations) this.constellations.setVisible(visible && this.showConstellations);
  }

  update(dt: number): void {
    if (!this.active || !this.solarSystem) return;

    // Upload one budget's worth of freshly loaded textures while nothing is
    // being asked of the frame — otherwise the whole decode+upload bill lands
    // inside whatever gesture first draws the map. Runs in every mode so
    // landed sessions warm up too.
    pumpTextureWarmQueue(PlanetariumMode.TEXTURE_WARM_BUDGET_MS);

    // Runs in both branches below — a tutorial narrates landed and cruise scenes.
    this.updateTutorial();

    // Landed mode: camera orbits body, skip flight controls
    if (this.landedOn) {
      this.updateLanded(dt);
      return;
    }

    const isScriptedTransfer = this.updateScriptedTransfer(dt);
    if (!isScriptedTransfer) {
      // Process keyboard input
      this.processInput();

      // Autopilot: steer toward target if no manual input
      if (this.autopilot && this.autopilotTarget && this.player.yawInput === 0 && this.player.pitchInput === 0) {
        this.applyAutopilot();
      }

      // Compute system speed throttle before player update
      const throttleResult = this.computeSystemSpeedFactor();
      this.systemSpeedFactor = throttleResult.factor;
      this.nearestSystemPlanet = throttleResult.planet;
      this.player.systemSpeedFactor = (this.throttleOverride || !this.systemSlowdown) ? 1.0 : this.systemSpeedFactor;

      // Moon-proximity governor: the planet throttle knows nothing smaller
      // than a system, so near a moon it still allows the in-system setting —
      // several moon standoffs per second. Cap the closing speed at
      // K × surface distance instead (same escape hatch as the throttle).
      // Tightening applies instantly; release ramps so a flyby ends with a
      // pull-away, not a one-frame snap back to thousands of km/s. The throttle
      // override (and systemSlowdown off) is a deliberate escape hatch, so it
      // bypasses the ramp — the cap releases the same frame, no lingering crawl.
      // geomCap is computed even while bypassing: moonCapEngaged tells the
      // override auto-clear a moon is still being escaped (a moon can govern
      // well outside the parent's system-throttle radius).
      const geomCap = this.computeMoonSpeedCap();
      this.moonCapEngaged = Number.isFinite(geomCap);
      const capBypass = this.throttleOverride || !this.systemSlowdown;
      this.moonCapEased = capBypass
        ? Infinity
        : rampedSpeedCap(geomCap, this.moonCapEased, dt, MOON_CAP_RELEASE_EFOLD_S);
      this.player.speedCapAUPerS = this.moonCapEased;

      this.prevPlayerPos.set(this.player.posX, this.player.posY, this.player.posZ);
      this.player.update(dt);
    }
    this.timeState = advancePlanetariumTime(this.timeState, dt);
    this.rebuildPlanetPositions(dt);

    // Apply floating origin: offset everything by player position
    this.applyFloatingOrigin();

    this.updateCameraFollow();
    if (!this.devFreeCamera) this.controls.update();

    // FPS tracking (wall-clock, independent of dt capping)
    this.fpsFrames++;
    const fpsNow = performance.now();
    const fpsElapsed = (fpsNow - this.fpsLastTime) / 1000;
    if (fpsElapsed >= 0.5) {
      this.fpsDisplay = Math.round(this.fpsFrames / fpsElapsed);
      this.fpsFrames = 0;
      this.fpsLastTime = fpsNow;
    }

    this.uiRefreshAccumulator += dt;
    const shouldRefreshUi = this.uiRefreshAccumulator >= PlanetariumMode.UI_REFRESH_INTERVAL_S;
    if (shouldRefreshUi) {
      this.uiRefreshAccumulator %= PlanetariumMode.UI_REFRESH_INTERVAL_S;
    }

    this.updatePlanetScaling();
    this.player.group.scale.setScalar(0.5);
    if (!this.devFreeCamera) {
      this.resolvePlanetCollisions();
      this.resolveMoonCollisions();
    }

    // Check orbit crossings and visits after scale/collision are applied so the
    // reachable interaction shell matches the visual shell.
    this.checkOrbitCrossings();
    this.checkPlanetVisits();
    this.checkProximityLand();

    // Position moon meshes first so `collectDynamicOccluders` can read their
    // scene-space positions and record discs for label culling.
    this.updateMoonPositions();

    // Stream a higher-res surface map for any body that grows large on screen.
    // Sits after the floating-origin and moon passes: the screen-fraction
    // trigger may only measure same-frame geometry — frame-one and teleport
    // frames otherwise read stale offsets, and one mis-read fires a 4K fetch.
    this.updateTextureLOD();

    // Occlusion pipeline: planet discs → moon + ship discs → render labels.
    // The labels setting gates the whole pipeline — it only feeds labels.
    if (this.planetLabels && this.showBodyLabels) {
      const scenePositions = new Map<string, { x: number; y: number; z: number }>();
      for (const planet of this.solarSystem.planets) {
        scenePositions.set(planet.data.name, {
          x: planet.group.position.x,
          y: planet.group.position.y,
          z: planet.group.position.z,
        });
      }
      this.planetLabels.collectForegroundDiscs(scenePositions, this.renderer);
      this.collectDynamicOccluders();
      // Main (flight) path: landedOn is null here — narrowed by early return above.
      this.planetLabels.renderLabels(scenePositions, { x: 0, y: 0, z: 0 }, this.renderer);
    }

    // Update constellation labels
    if (this.constellations && this.showConstellations) {
      this.constellations.updateLabels(
        this.camera,
        this.renderer.domElement.clientWidth,
        this.renderer.domElement.clientHeight,
      );
    }

    if (this.showBodyLabels) {
      this.renderMoonLabels();
      this.updateSunLabel();
    }

    if (this.autopilotTarget) {
      this.checkAutopilotArrival();
    }
    this.updateSunShader(dt);
    this.updateOrbitLineVisibility();

    // Update stats/time overlays on a lower cadence than the render loop to avoid
    // forcing layout/style work every frame.
    if (shouldRefreshUi) {
      this.updateStatsUI();
      this.updateTimeUI();
      this.updateSpeedSlider();
    }
  }

  private applyFloatingOrigin() {
    if (!this.solarSystem) return;

    const px = this.player.posX;
    const py = this.player.posY;
    const pz = this.player.posZ;

    this.solarSystem.sun.position.set(-px, -py, -pz);

    // Offset planets (and their moon-system groups, which track the planet)
    for (const planet of this.solarSystem.planets) {
      const wp = planet.group.userData.worldPosAU as { x: number; y: number; z: number };
      planet.group.position.set(wp.x - px, wp.y - py, wp.z - pz);
      const systemGroup = this.moonSystemGroups.get(planet.data.name);
      if (systemGroup) systemGroup.position.copy(planet.group.position);
    }

    for (const orbit of this.solarSystem.orbitLines) {
      orbit.position.set(-px, -py, -pz);
    }

    this.solarSystem.asteroidBelt.position.set(-px, -py, -pz);

    // Player is at origin (or very close)
    this.player.group.position.set(0, 0, 0);

    // Starfield + constellations follow camera (always centered on player)
    if (this.starfield) {
      this.starfield.position.set(0, 0, 0);
    }
    if (this.constellations) {
      this.constellations.lines.position.set(0, 0, 0);
    }
  }

  private readonly texLODTmp = new THREE.Vector3();
  /**
   * Stream a higher-resolution colour map for any body that grows large on
   * screen. The trigger is screen-fraction (apparent diameter ÷ vertical FOV),
   * not raw distance, so a body magnified by the Observatory's narrow-FOV
   * telescope upgrades the same as a close fly-by would. Only bodies with a 4K
   * variant on disk carry an upgrade; for every other body this is a no-op.
   * Cheap to call each frame — the upgrade's own state short-circuits once it
   * has fired.
   */
  private updateTextureLOD(): void {
    if (!this.solarSystem) return;
    const fovRad = this.camera.fov * DEG2RAD;
    if (fovRad <= 0) return;
    // Upgrade once a body spans ~15% of the viewport height: enough that 2K
    // texels start to soften, with lead time to fetch 4K before it grows.
    const UPGRADE_AT = 0.15;
    const cam = this.camera.position;
    for (const planet of this.solarSystem.planets) {
      const up = planet.textureUpgrade;
      if (!up) continue;
      planet.group.getWorldPosition(this.texLODTmp);
      const dist = Math.max(this.texLODTmp.distanceTo(cam), 1e-6);
      if ((planet.data.radiusAU * 2) / dist / fovRad > UPGRADE_AT) upgradeTextureOnApproach(up);
    }
    for (const moons of this.planetMoons.values()) {
      for (const m of moons) {
        const up = m.textureUpgrade;
        if (!up) continue;
        // Hidden moons sit at their parent's center (updateMoonPositions skips
        // them) — a fake position the trigger must never measure. An invisible
        // moon can't legitimately span 15% of the viewport anyway.
        if (!m.mesh.visible) continue;
        m.mesh.getWorldPosition(this.texLODTmp);
        const dist = Math.max(this.texLODTmp.distanceTo(cam), 1e-6);
        if ((m.data.radiusAU * 2) / dist / fovRad > UPGRADE_AT) upgradeTextureOnApproach(up);
      }
    }
  }

  private updateCameraFollow() {
    if (this.devFreeCamera) return; // headless framing drives the camera directly
    // Player is always at scene origin due to floating origin
    this.controls.target.set(0, 0, 0);

    // Chase camera: smoothly lerp behind the ship unless user is orbiting
    if (this.userOrbiting) return;

    const camDist = 0.000094;
    const forward = this.player.getForwardDirection();
    const idealPos = new THREE.Vector3(
      -forward.x * camDist,
      -forward.y * camDist + camDist * 0.35,
      -forward.z * camDist,
    );

    // Smooth follow — faster when actively turning
    const turning = Math.abs(this.player.yawInput) + Math.abs(this.player.pitchInput);
    const lerpSpeed = turning > 0 ? 0.06 : 0.025;
    this.camera.position.lerp(idealPos, lerpSpeed);
  }

  /**
   * Major moons are tidally locked: keep the near side (texture longitude 0,
   * which SphereGeometry puts on the mesh's +X axis) facing the parent. The
   * roll reference is the moon's own orbit normal (from the element frame),
   * so inclined and retrograde moons (Iapetus 7.6°, Phoebe 175°) don't tumble
   * as toParent sweeps past a fixed axis. Earth's Moon uses ecliptic north
   * (the real lunar axis sits within ~1.5° of the ecliptic pole).
   */
  private orientTidallyLockedMoon(
    mesh: THREE.Mesh,
    offsetFromParent: THREE.Vector3,
    rollNorth: THREE.Vector3,
  ) {
    const toParent = this.tmpLockToParent.copy(offsetFromParent).multiplyScalar(-1).normalize();
    // The basis Z column = toParent×up holds *texture* longitude 90°W, not
    // geographic east (east is its negation, pole×prime — same naming note as
    // buildPoleBasisQuaternion in planetary.ts). Only the RH-ness of the
    // basis matters: X×Y=Z keeps det(+1), so textures are never mirrored.
    const basisZ = this.tmpLockBasisZ.crossVectors(toParent, rollNorth);
    if (basisZ.lengthSq() < 1e-10) return; // unreachable for valid orbit geometry; cheap safety
    basisZ.normalize();
    const up = this.tmpLockUp.crossVectors(basisZ, toParent);
    mesh.quaternion.setFromRotationMatrix(this.tmpLockBasis.makeBasis(toParent, up, basisZ));
  }

  /**
   * Single source of truth for a moon's offset from its parent planet (AU,
   * world frame). Rendering, landing, proximity, and autopilot all read this,
   * so the moon you see is the moon you fly to. Earth's Moon gets the real
   * Meeus ephemeris (phases/nodes/eclipses); every other moon propagates its
   * JPL mean elements (satellites.ts). `outOrbitNormal`, when given, receives
   * the unit orbit normal — the tidal-lock roll reference.
   */
  private getMoonWorldOffsetAU(
    moon: MoonData,
    parentPlanet: PlanetData,
    out: THREE.Vector3,
    outOrbitNormal?: THREE.Vector3,
  ): THREE.Vector3 {
    const isEarthMoon = moon.name === 'Moon' && parentPlanet.name === 'Earth';
    computeMoonOffsetEquatorialAU(
      moon.name,
      parentPlanet.name,
      this.timeState.currentUtcMs,
      out,
      // Skip the seam's finite-difference normal for Earth's Moon (it costs a
      // second Meeus evaluation) — the roll reference below replaces it anyway.
      isEarthMoon ? undefined : outOrbitNormal,
    );
    if (outOrbitNormal && isEarthMoon) {
      // Roll reference, not orbit normal: the Moon's spin axis sits ~1.5° from
      // ecliptic north (Cassini state) vs 5.1° for the orbit normal, so the
      // tidal-lock roll stays on ecliptic north. The shadow engine and the
      // guide slots read the true normal straight from the seam.
      outOrbitNormal.copy(PlanetariumMode.ECLIPTIC_NORTH);
    }
    return out;
  }

  // Apoapsis, not the catalog semi-major axis: eccentric outer moons (Neso
  // e≈0.46 reaches ~0.49 AU) would otherwise leave the visibility/landing
  // threshold near apoapsis and become unreachable.
  private getFarthestMoonReachAU(moons: MoonMesh[]): number {
    let farthestOrbitAU = 0;
    for (const moon of moons) {
      const reachAU =
        moon.data.parentPlanet === 'Earth'
          ? moon.data.orbitalRadiusAU
          : getSatelliteApoapsisAU(moon.data.name);
      farthestOrbitAU = Math.max(farthestOrbitAU, reachAU);
    }
    return farthestOrbitAU;
  }

  private getMoonSystemThresholdAU(planetRadiusAU: number, moons: MoonMesh[]): number {
    return Math.max(planetRadiusAU * 120, this.getFarthestMoonReachAU(moons) * 1.15, 0.3);
  }

  private getLandedBodyWorldPosition(): { x: number; y: number; z: number } | null {
    if (!this.landedOn) return null;
    if (this.landedOn.type === 'planet') {
      return this.planetWorldPositions.get(this.landedOn.name) ?? null;
    }
    // Moon: parent position + orbital offset from the shared seam — the same
    // position the mesh renders at, so the floating origin centers exactly on it.
    const parentPlanet = this.landedOn.parentPlanet;
    const parentPos = this.planetWorldPositions.get(parentPlanet);
    if (!parentPos) return null;
    const parentBody = PLANETARIUM_BODIES.find(b => b.name === parentPlanet);
    const moons = this.planetMoons.get(parentPlanet);
    if (!parentBody || !moons) return null;
    const moonMesh = moons.find(m => m.data.name === this.landedOn!.name);
    if (!moonMesh) return null;
    const offset = this.getMoonWorldOffsetAU(moonMesh.data, parentBody, this.tmpMoonOffset);
    return {
      x: parentPos.x + offset.x,
      y: parentPos.y + offset.y,
      z: parentPos.z + offset.z,
    };
  }

  private getLandedBodyRadiusAU(): number {
    if (!this.landedOn) return 0;
    if (this.landedOn.type === 'planet') {
      const body = PLANETARIUM_BODIES.find(b => b.name === this.landedOn!.name);
      return body ? body.radiusAU : 0;
    }
    const moons = this.planetMoons.get(this.landedOn.parentPlanet);
    if (!moons) return 0;
    const moonMesh = moons.find(m => m.data.name === this.landedOn!.name);
    return moonMesh ? moonMesh.data.radiusAU : 0;
  }

  /**
   * Rendered radius (AU) of the landed body as drawn in orbit view: planets at
   * true size, small moons inflated to a floor fraction of their parent (the
   * same scaling updateMoonPositions applies so they stay visible). The landed
   * camera frames off this, so a tiny moon's inflated mesh fills the view like
   * any other body and the camera never seats itself inside the mesh.
   */
  private getLandedBodyRenderedRadiusAU(): number {
    const trueRadiusAU = this.getLandedBodyRadiusAU();
    if (!this.landedOn || this.landedOn.type === 'planet') return trueRadiusAU;
    const parentName = this.landedOn.parentPlanet;
    const parent = PLANETARIUM_BODIES.find(b => b.name === parentName);
    if (!parent) return trueRadiusAU;
    return Math.max(trueRadiusAU, PlanetariumMode.MOON_MIN_RENDER_RATIO * parent.radiusAU);
  }

  /**
   * Rendered-size floor (fraction of the parent's radius) for a moon in
   * `parentName`'s system, given the current landed/view state. The floor
   * inflates moons too small to see — most are a sliver of their giant parent,
   * so without it they'd be sub-pixel — but the level depends on what you're
   * looking at:
   *  - Flying, or any system you're not landed in: the full flythrough floor, so
   *    every moon stays a findable speck as you pass.
   *  - Observing the parent PLANET: a smaller floor, so the moons shrink toward
   *    their true relative sizes (the big ones separate instead of all pinning
   *    to one size) — you're focused on the planet and the system should read
   *    honestly.
   *  - Observing a MOON: the flythrough floor (unchanged), so the siblings stay
   *    findable around the one being inspected.
   *  - Surface view: no floor — true angular sizes, a moon crossing the Sun must
   *    be its real size.
   * The floor only ever changes across a landing/leave/swap/surface transition,
   * each of which reframes the camera, so the resize is never seen in-place.
   * Centralised so the drawn mesh and the label-occlusion discs stay in sync.
   */
  private moonRenderFloorRatio(parentName: string): number {
    if (parentName !== this.observatoryParentPlanetName()) {
      return PlanetariumMode.MOON_MIN_RENDER_RATIO; // flythrough / other systems
    }
    if (this.landedView === 'surface') return 0; // true angular sizes
    if (this.landedOn?.type === 'planet') return PlanetariumMode.OBSERVE_PLANET_MOON_FLOOR;
    return PlanetariumMode.MOON_MIN_RENDER_RATIO; // observing a moon: unchanged
  }

  /**
   * Initial landing view direction (unit vector): bias the camera onto the
   * body's lit hemisphere so a landing never opens on a dark disc. The Sun sits
   * at the heliocentric world origin, so body→Sun is the negated world position —
   * read from the world position rather than the rendered sun.position, which is
   * a frame stale here (the floating-origin pass that places it hasn't run yet).
   * Tilted up and offset to the side so the lit face reads as a gibbous with the
   * terminator near the limb for depth.
   */
  private computeLandedCameraDir(bodyWorldPos: { x: number; y: number; z: number } | null): THREE.Vector3 {
    const sunDir = new THREE.Vector3();
    if (bodyWorldPos) sunDir.set(-bodyWorldPos.x, -bodyWorldPos.y, -bodyWorldPos.z);
    if (sunDir.lengthSq() < 1e-20) return sunDir.set(1, 0.5, 1).normalize(); // degenerate: legacy fixed view
    sunDir.normalize();
    const side = new THREE.Vector3().crossVectors(sunDir, PlanetariumMode.SCENE_NORTH);
    if (side.lengthSq() < 1e-10) side.set(1, 0, 0);
    else side.normalize();
    const up = new THREE.Vector3().crossVectors(side, sunDir).normalize();
    return sunDir.addScaledVector(up, 0.5).addScaledVector(side, 0.4).normalize();
  }

  private computeSystemSpeedFactor(): { factor: number; planet: string | null } {
    let minFactor = 1.0;
    let nearestPlanet: string | null = null;

    // Check all planets
    for (const body of PLANETARIUM_BODIES) {
      const wp = this.planetWorldPositions.get(body.name);
      if (!wp) continue;
      const dx = this.player.posX - wp.x;
      const dy = this.player.posY - wp.y;
      const dz = this.player.posZ - wp.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      const systemRadius = body.systemRadiusAU;
      if (dist >= systemRadius) continue;

      const inner = systemRadius * 0.05;
      const t = Math.min(1, Math.max(0, (dist - inner) / (systemRadius - inner)));
      const factor = smoothstepUnclamped(t);
      if (factor < minFactor) {
        minFactor = factor;
        nearestPlanet = body.name;
      }
    }

    // Check Sun (always at origin in world coordinates)
    {
      const dist = Math.sqrt(
        this.player.posX * this.player.posX +
        this.player.posY * this.player.posY +
        this.player.posZ * this.player.posZ,
      );
      const sunSystemRadius = 0.01;
      if (dist < sunSystemRadius) {
        const inner = sunSystemRadius * 0.05;
        const t = Math.min(1, Math.max(0, (dist - inner) / (sunSystemRadius - inner)));
        const factor = smoothstepUnclamped(t);
        if (factor < minFactor) {
          minFactor = factor;
          nearestPlanet = 'Sun';
        }
      }
    }

    return { factor: minFactor, planet: nearestPlanet };
  }

  private updatePlanetScaling() {
    if (!this.solarSystem) return;
    for (const planet of this.solarSystem.planets) {
      planet.group.scale.setScalar(1);

      // Atmosphere alpha: fade in as player approaches the planet's system radius
      if (planet.atmosphere) {
        const wp = planet.group.userData.worldPosAU as { x: number; y: number; z: number };
        const dx = this.player.posX - wp.x;
        const dy = this.player.posY - wp.y;
        const dz = this.player.posZ - wp.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const systemR = planet.data.systemRadiusAU;
        const innerR = systemR * 0.1;
        const linear = 1 - Math.min(1, Math.max(0, (dist - innerR) / (systemR - innerR)));
        const t = smoothstepUnclamped(linear);
        const glowMat = planet.atmosphere.material as THREE.ShaderMaterial;
        if (glowMat.uniforms?.alphaScale) {
          // Fade fully out at system-edge distance; full strength on close approach.
          glowMat.uniforms.alphaScale.value = t;
        }
      }

      if (planet.data.name === 'Earth') {
        const wp = planet.group.userData.worldPosAU as { x: number; y: number; z: number };
        const dx = this.player.posX - wp.x;
        const dy = this.player.posY - wp.y;
        const dz = this.player.posZ - wp.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const renderedAngularDiameter = dist > 1e-8
          ? (planet.data.radiusAU * 2) / dist
          : Infinity;
        const keepEarthDetail =
          dist <= PlanetariumMode.EARTH_DETAIL_MIN_DISTANCE_AU ||
          renderedAngularDiameter >= PlanetariumMode.EARTH_DETAIL_MIN_ANGULAR_DIAMETER_RAD;
        if (planet.nightMesh) planet.nightMesh.visible = keepEarthDetail;
        if (planet.cloudsMesh) planet.cloudsMesh.visible = keepEarthDetail;
      }
    }

    // Idempotent re-assert of the ship model that matches the active mission
    // (or the default ship when none). Mission start/end already call
    // setProfile explicitly; this per-frame reapply is a deliberate, cheap
    // safety net guaranteeing the displayed model tracks mission state through
    // every code path (incl. state restore) — do not "optimize" it away.
    this.player.setProfile(this.activeHistoricJourney?.shipProfile ?? 'default');
  }

  /**
   * Reset GPU-painted moons after a WebGL context loss: their render-target
   * textures have no CPU backing and would render black. Clearing `painted`
   * drops them below the visibility gate (hidden, never shown black) and
   * re-enqueuing makes the gate repaint them — on the CPU until the GPU path
   * re-validates on context restore.
   */
  private invalidateRtPaintedMoons(moons: MoonMesh[]): void {
    const parents = new Set<string>();
    for (const m of moons) {
      m.painted = false;
      m.mesh.visible = false;
      // Drop stale procedural metadata — the RTs are dead (context lost), and a
      // repaint must start clean so a later observe re-upgrades from the real
      // baseline instead of skipping on a stale width.
      const mat = m.mesh.material as THREE.MeshStandardMaterial;
      delete mat.userData.proceduralWidth;
      delete mat.userData.proceduralColorRT;
      delete mat.userData.proceduralBumpRT;
      parents.add(m.data.parentPlanet);
    }
    // Re-enqueue the FULL authoritative moon list per parent, not just the
    // invalidated subset: enqueue() replaces the parent's pending list, so
    // enqueuing the subset would drop any moons still pending from the initial
    // background drain and the gate would never repaint them.
    for (const parent of parents) {
      const all = this.planetMoons.get(parent);
      if (all) this.moonPainter.enqueue(parent, all);
      // The context loss also freed the photo uploads — the next arrival must
      // get its covered drain again.
      this.warmedSystems.delete(parent);
    }
  }

  /**
   * First pass: position moon meshes, update visibility, and record world AU
   * positions. Label placement is split into `renderMoonLabels()` so that
   * moon labels can consult the full set of foreground occluders (planets,
   * other moons, ship) gathered mid-frame.
   */
  private updateMoonPositions() {
    if (!this.solarSystem) return;
    const PLANETSHINE_GAIN = 500; // lift faint physical planetshine to a visible night-side glow
    const PLANETSHINE_MAX = 0.12; // cap well below daylight; large/near parents (Jupiter) sit at the cap
    // Nearest system with textures still queued — the background drain paints it
    // first (you're likeliest to reach it next). Tracked across the planet loop.
    let nearestPending: string | null = null;
    let nearestPendingDist = Infinity;
    for (const planet of this.solarSystem.planets) {
      const moons = this.planetMoons.get(planet.data.name);
      if (!moons || moons.length === 0) continue;

      const wp = planet.group.userData.worldPosAU as { x: number; y: number; z: number };
      const dx = this.player.posX - wp.x;
      const dy = this.player.posY - wp.y;
      const dz = this.player.posZ - wp.z;
      const distToPlayer = Math.sqrt(dx * dx + dy * dy + dz * dz);

      const threshold = this.getMoonSystemThresholdAU(planet.data.radiusAU, moons);
      const visible = distToPlayer < threshold;
      const parentR = planet.data.radiusAU;

      // Moon-shadow casters fed to the parent surface shader (Io on Jupiter,
      // etc.): reset per frame, accumulate in the loop below. Pick the largest
      // moons by radius (catalog order isn't size order — Titan must outrank
      // Mimas) and skip any whose umbra never reaches the surface (annular, e.g.
      // Phobos), so a tiny moon can't paint a full black spot.
      const surfFx = planet.fx;
      let moonShadowCount = 0;
      let casterNames: Set<string> | null = null;
      let sunTanAtParent = 0;
      if (surfFx) {
        this.tmpMoonShadowQuat.copy(planet.group.quaternion).invert();
        const SUN_RADIUS_AU = 695_700 / 149_597_870.7;
        sunTanAtParent = SUN_RADIUS_AU / Math.max(Math.hypot(wp.x, wp.y, wp.z), 1e-9);
        casterNames = new Set(
          [...moons]
            // Filter to moons whose umbra actually reaches the surface FIRST,
            // then take the largest few — else a big, far moon whose umbra falls
            // short (Iapetus, Nereid) steals a slot from a real caster (Tethys,
            // Galatea). orbitalRadiusAU is the mean distance; the loop re-checks
            // the live distance per frame.
            .filter((mm) => mm.data.radiusAU / parentR > 0.003
              && mm.data.radiusAU > mm.data.orbitalRadiusAU * sunTanAtParent)
            .sort((a, b) => b.data.radiusAU - a.data.radiusAU)
            .slice(0, surfFx.uMoonShadow.value.length)
            .map((mm) => mm.data.name),
        );
      }

      // Hard rule: paint a system before it's shown. The gate runs every frame
      // before the scene renders, so a moon can never reach the screen unpainted.
      if (visible && this.moonPainter.hasPending(planet.data.name)) {
        this.moonPainter.paintSystemNow(planet.data.name, moons);
      } else if (this.moonPainter.hasPending(planet.data.name) && distToPlayer < nearestPendingDist) {
        nearestPendingDist = distToPlayer;
        nearestPending = planet.data.name;
      }

      for (const m of moons) {
        // Never flip visible while unpainted: the worst case is a moon that pops
        // in a frame late, never a flat-coloured one.
        const show = visible && m.painted;
        m.mesh.visible = show;
        if (!show) {
          const hiddenLabel = this.moonLabels.get(m.data.name);
          if (hiddenLabel && hiddenLabel.style.display !== 'none') {
            hiddenLabel.style.display = 'none';
          }
          continue;
        }

        const offset = this.getMoonWorldOffsetAU(m.data, planet.data, this.tmpMoonOffset, this.tmpMoonOrbitNormal);
        m.mesh.position.copy(offset);
        this.orientTidallyLockedMoon(m.mesh, offset, this.tmpMoonOrbitNormal);

        // Eclipse dimming: darken the moon while it sits in its parent's
        // shadow (pure geometry from positions already in hand).
        computeMoonShading(
          this.tmpShadingParentPos.set(wp.x, wp.y, wp.z),
          planet.data.name,
          planet.data.radiusKm,
          offset,
          m.data.radiusKm,
          this.moonShading,
        );
        this.applyMoonShading(m, this.moonShading);

        if (m.fx) {
          m.fx.uSunDirWorld.value
            .set(-(wp.x + offset.x), -(wp.y + offset.y), -(wp.z + offset.z))
            .normalize();
          // Planetshine: night-side glow reflected off the parent. Direction is
          // moon -> parent; intensity peaks when the parent is full from the moon.
          const distAU = Math.max(offset.length(), 1e-9);
          this.tmpPlanetshine.copy(offset).multiplyScalar(-1 / distAU); // unit moon -> parent (world)
          const sx = -(wp.x + offset.x), sy = -(wp.y + offset.y), sz = -(wp.z + offset.z);
          const sl = Math.hypot(sx, sy, sz) || 1;
          const cosPhase = (sx / sl) * this.tmpPlanetshine.x
            + (sy / sl) * this.tmpPlanetshine.y + (sz / sl) * this.tmpPlanetshine.z;
          // 0.4 ~ a representative parent bond albedo (Earth ~0.3, gas giants ~0.5)
          const shine = planetshineIntensity(0.4, parentR, distAU, cosPhase) * PLANETSHINE_GAIN;
          m.fx.uPlanetshineDir.value.copy(this.tmpPlanetshine);
          m.fx.uPlanetshineColor.value.set(planet.data.color);
          m.fx.uPlanetshineIntensity.value = Math.min(shine, PLANETSHINE_MAX);
        }

        this.moonWorldPositions.set(m.data.name, {
          x: wp.x + offset.x,
          y: wp.y + offset.y,
          z: wp.z + offset.z,
        });

        const realRatio = m.data.radiusAU / parentR;
        // Inflate moons below the floor up to it; draw the rest true-size. The
        // floor varies with what you're observing (see moonRenderFloorRatio):
        // smaller when focused on the parent planet so the system reads honestly,
        // none in surface view where angular sizes must be real (an Io silhouette
        // on the Sun must be Io-sized).
        const floor = this.moonRenderFloorRatio(planet.data.name);
        if (realRatio < floor) {
          m.mesh.scale.setScalar(floor / realRatio);
        } else {
          m.mesh.scale.setScalar(1);
        }

        // Feed this moon as a shadow caster on the parent: one of the largest
        // few, and only if its umbra actually reaches the surface (mr > along*tan).
        if (surfFx && casterNames && casterNames.has(m.data.name)
            && m.data.radiusAU > offset.length() * sunTanAtParent
            && moonShadowCount < surfFx.uMoonShadow.value.length) {
          this.tmpMoonShadowLocal.copy(offset).applyQuaternion(this.tmpMoonShadowQuat);
          surfFx.uMoonShadow.value[moonShadowCount].set(
            this.tmpMoonShadowLocal.x,
            this.tmpMoonShadowLocal.y,
            this.tmpMoonShadowLocal.z,
            m.data.radiusAU,
          );
          moonShadowCount++;
        }
      }

      if (surfFx) surfFx.uMoonShadowCount.value = moonShadowCount;
    }

    // Background drain: paint a slice of any still-queued systems, the one the
    // player is in/heading toward first. Costs nothing once everything's painted.
    if (!this.moonPainter.isEmpty()) {
      const target = this.autopilotTarget ?? this.landedOn;
      const targetSystem = target ? this.parentSystemOf(target) : null;
      const preferred =
        targetSystem && this.moonPainter.hasPending(targetSystem) ? targetSystem : nearestPending;
      this.moonPainter.pump(
        PlanetariumMode.MOON_PAINT_FRAME_BUDGET_MS,
        preferred,
        PlanetariumMode.MOON_PAINT_MAX_PER_FRAME,
      );
    }
  }

  /**
   * Darken an eclipsed moon's per-mesh material (base color is white; the
   * surface detail lives in the map, so a scalar tint is the light level).
   * Earth's Moon shades toward the refracted-red "blood moon" floor instead
   * of gray once its disc touches the umbra — Earth is the one occluder whose
   * atmosphere we model. The branches meet continuously: at first umbral
   * contact the sun-visible fraction is still above every red-floor channel.
   */
  private applyMoonShading(m: MoonMesh, shading: MoonShadingState) {
    const material = m.mesh.material as THREE.MeshStandardMaterial;
    const fraction = shading.sunVisibleFraction;
    const isEarthMoon = m.data.name === 'Moon' && m.data.parentPlanet === 'Earth';
    if (isEarthMoon && shading.inUmbra) {
      material.color.setRGB(Math.max(fraction, 0.3), Math.max(fraction, 0.07), Math.max(fraction, 0.05));
    } else {
      material.color.setScalar(Math.max(fraction, 0.03));
    }
    material.emissiveIntensity = 0.03 * Math.max(fraction, 0.03);
  }

  /** Re-pose the landed system's shadow guides + transit spots for this frame. */
  private updateShadowVisuals() {
    const parentName = this.observatoryParentPlanetName();
    if (!parentName) return;
    const wp = this.planetWorldPositions.get(parentName);
    const parentBody = PLANETARIUM_BODIES.find(b => b.name === parentName);
    const moons = this.planetMoons.get(parentName);
    if (!wp || !parentBody || !moons) return;
    this.refreshGuideSlotInputs(parentBody, moons);
    this.shadowVisuals.update(
      wp,
      parentBody.name,
      parentBody.radiusKm,
      moons,
      this.landedOn?.type === 'moon' ? this.landedOn.name : null,
      this.getFarthestMoonReachAU(moons),
      this.guideSlotInputs,
    );
  }

  /**
   * Which moons the shadow guides follow this frame: the landed moon (or
   * Earth's companion Moon when standing on the parent), plus the jumped/live
   * event's moon when it names a different one. Orbit normals come from the
   * same seam that drives the rendered positions.
   */
  private refreshGuideSlotInputs(parentBody: PlanetData, moons: MoonMesh[]) {
    const slots = this.guideSlotInputs;
    slots[0].name = null;
    slots[1].name = null;
    if (!this.showShadowGuides) return;
    const landedMoon = this.landedOn?.type === 'moon' ? this.landedOn.name : null;
    // Companion moon without swapCompanionTarget()'s per-frame allocation:
    // standing on a planet, only Earth has a companion vantage (the Moon) —
    // keep in step with swapCompanionTarget if that policy ever grows.
    const primary =
      landedMoon ??
      (this.landedOn?.type === 'planet' && this.landedOn.name === 'Earth' ? 'Moon' : null);
    const liveEvent = this.relevantObservatoryEvent();
    const eventMoon =
      liveEvent && liveEvent.spec.moonName !== primary ? liveEvent.spec.moonName : null;
    let next = 0;
    if (primary && this.fillGuideSlot(slots[next], primary, parentBody, moons)) next++;
    if (eventMoon) this.fillGuideSlot(slots[next], eventMoon, parentBody, moons);
  }

  private fillGuideSlot(
    slot: GuideSlotInput,
    moonName: string,
    parentBody: PlanetData,
    moons: MoonMesh[],
  ): boolean {
    for (const m of moons) {
      if (m.data.name !== moonName) continue;
      slot.name = moonName;
      // Straight to the seam, not getMoonWorldOffsetAU: the wrapper's normal
      // is the tidal-lock roll reference (ecliptic north for Earth's Moon),
      // and the crossing tick's season miss r·sinβ needs the true 5.1° orbit
      // normal — on the roll reference it would read "in season" forever.
      computeMoonOffsetEquatorialAU(
        moonName,
        parentBody.name,
        this.timeState.currentUtcMs,
        this.tmpGuideOffset,
        slot.orbitNormal,
      );
      return true;
    }
    return false;
  }

  /**
   * Camera-dependent guide pass + the footprint reticle. Runs at the end of
   * the frame, after the surface camera re-pins, so silhouette edges and
   * resolvability gates read the camera pose that will actually render. The
   * reticle is the HUD's sub-resolution glyph reused as an HTML marker over
   * a collapsed (sub-resolution) true-scale footprint.
   */
  private updateShadowGuideCamera() {
    const parentName = this.observatoryParentPlanetName();
    const systemGroup = parentName ? this.moonSystemGroups.get(parentName) : null;
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    let reticleVisible = false;
    if (systemGroup) {
      this.tmpGuideCamLocal.copy(this.camera.position).sub(systemGroup.position);
      this.shadowVisuals.updateCameraGuides(this.tmpGuideCamLocal, this.camera.fov, w, h);
      if (this.shadowVisuals.getFootprintReticleLocal(this.tmpGuideReticle)) {
        this.tmpGuideReticle.add(systemGroup.position);
        const proj = projectToScreen(this.tmpGuideReticle, this.camera, w, h, this.guideReticleProjection);
        if (proj.ndcZ < 1 && proj.x >= 0 && proj.x <= w && proj.y >= 0 && proj.y <= h) {
          const el = this.ensureFootprintReticleEl();
          if (el) {
            // Transform, not left/top: layout offsets pixel-snap at paint and
            // the spot's slow crawl would twitch.
            el.style.transform = `translate(${proj.x - 6}px, ${proj.y - 6}px)`;
            el.style.display = '';
            reticleVisible = true;
          }
        }
      }
    }
    if (!reticleVisible && this.footprintReticleEl) {
      this.footprintReticleEl.style.display = 'none';
    }
  }

  private ensureFootprintReticleEl(): HTMLElement | null {
    if (!this.footprintReticleEl) {
      this.footprintReticleEl = document.getElementById('shadow-footprint-reticle');
    }
    return this.footprintReticleEl;
  }

  private hideFootprintReticle(): void {
    if (this.footprintReticleEl) this.footprintReticleEl.style.display = 'none';
  }

  /**
   * Second pass: contribute foreground discs for visible moons and the
   * player ship to `planetLabels`, so any label rendered afterwards (planet,
   * moon, sun) is occluded when it would sit on top of one of them. Must
   * run AFTER `planetLabels.collectForegroundDiscs()` and BEFORE any label
   * rendering (`renderLabels`, `renderMoonLabels`, `updateSunLabel`).
   */
  private collectDynamicOccluders() {
    if (!this.planetLabels || !this.solarSystem) return;
    const canvasH = this.renderer.domElement.clientHeight;
    const halfFovTan = Math.tan((this.camera.fov * Math.PI) / 360);
    const camX = this.camera.position.x;
    const camY = this.camera.position.y;
    const camZ = this.camera.position.z;
    const tempV = new THREE.Vector3();

    // Visible moons
    for (const planet of this.solarSystem.planets) {
      const moons = this.planetMoons.get(planet.data.name);
      if (!moons) continue;
      const parentR = planet.data.radiusAU;
      for (const m of moons) {
        if (!m.mesh.visible) continue;
        m.mesh.getWorldPosition(tempV);
        const dx = tempV.x - camX;
        const dy = tempV.y - camY;
        const dz = tempV.z - camZ;
        const distFromCamera = Math.sqrt(dx * dx + dy * dy + dz * dz);
        // Effective rendered radius: small moons are scaled up to the same floor
        // the mesh uses, so the occlusion disc matches what's actually drawn.
        const effectiveRadiusAU = Math.max(m.data.radiusAU, this.moonRenderFloorRatio(planet.data.name) * parentR);
        const angularSize = (effectiveRadiusAU * 2) / Math.max(distFromCamera, 0.0001);
        if (angularSize <= 0.01) continue;

        const canvasW = this.renderer.domElement.clientWidth;
        const proj = projectToScreen(tempV, this.camera, canvasW, canvasH);
        if (proj.ndcZ >= 1) continue;
        const screenX = proj.x;
        const screenY = proj.y;
        const radiusPx = (effectiveRadiusAU * 1.1 / (Math.max(distFromCamera, effectiveRadiusAU) * halfFovTan)) * (canvasH / 2);
        this.planetLabels.addForegroundDisc({ screenX, screenY, radiusPx, distFromCamera, name: `moon:${m.data.name}` });
      }
    }

    // Player ship (visible + not landed): sits at scene origin (floating
    // origin), so its camera distance is just the camera's magnitude.
    if (this.player.group.visible && !this.landedOn) {
      const distFromCamera = this.camera.position.length();
      if (distFromCamera > 0) {
        const shipSceneRadiusAU = PlanetariumMode.SHIP_OCCLUDER_RADIUS_AU;
        const angularSize = (shipSceneRadiusAU * 2) / distFromCamera;
        if (angularSize > 0.005) {
          const canvasW = this.renderer.domElement.clientWidth;
          const proj = projectToScreen(tempV.set(0, 0, 0), this.camera, canvasW, canvasH);
          if (proj.ndcZ < 1) {
            const screenX = proj.x;
            const screenY = proj.y;
            const radiusPx = (shipSceneRadiusAU / (Math.max(distFromCamera, shipSceneRadiusAU) * halfFovTan)) * (canvasH / 2);
            this.planetLabels.addForegroundDisc({ screenX, screenY, radiusPx, distFromCamera, name: 'ship' });
          }
        }
      }
    }
  }

  /**
   * Third pass: place HTML labels for visible moons. Uses the occluder set
   * populated by `planetLabels.collectForegroundDiscs` + `collectDynamicOccluders`.
   */
  private renderMoonLabels() {
    if (!this.solarSystem || this.moonLabelContainer === null) return;
    const canvasW = this.renderer.domElement.clientWidth;
    const canvasH = this.renderer.domElement.clientHeight;
    const tempV = new THREE.Vector3();

    // Two passes: gather placeable labels, then place big-to-small with
    // greedy screen-rect suppression — on approach a system's labels pile
    // onto near-identical pixels ("PhoDeimos"); the smaller apparent moon
    // yields. Rects are estimated (reading offsetWidth would force reflow).
    // Candidate objects are pooled — steady-state frames allocate nothing.
    const candidates = this.moonLabelCandidates;
    let candidateCount = 0;

    for (const planet of this.solarSystem.planets) {
      const moons = this.planetMoons.get(planet.data.name);
      if (!moons) continue;
      for (const m of moons) {
        const label = this.moonLabels.get(m.data.name);
        if (!label) continue;
        // Suppress the landed moon's own label — no need to label what you're standing on.
        if (this.landedOn?.type === 'moon' && this.landedOn.name === m.data.name) {
          if (label.style.display !== 'none') label.style.display = 'none';
          continue;
        }
        if (!m.mesh.visible) continue;

        m.mesh.getWorldPosition(tempV);
        const moonCamDist = tempV.distanceTo(this.camera.position);
        const proj = projectToScreen(tempV, this.camera, canvasW, canvasH);
        if (proj.ndcZ >= 1) {
          if (label.style.display !== 'none') label.style.display = 'none';
          continue;
        }

        let sx = proj.x;
        let sy = proj.y;
        const margin = 30;
        const onScreen = sx >= margin && sx <= canvasW - margin &&
                         sy >= margin && sy <= canvasH - margin;
        sx = Math.max(margin, Math.min(canvasW - margin, sx));
        sy = Math.max(margin, Math.min(canvasH - margin, sy));
        // Label sits above the moon (translate(-50%, -100%) + -6px margin).
        // Exclude this moon's own disc so it doesn't cull itself.
        const labelOccluded = this.planetLabels?.isScreenPointOccluded(sx, sy - 10, moonCamDist, `moon:${m.data.name}`) ?? false;
        if (labelOccluded) {
          label.style.display = 'none';
          continue;
        }
        let c = candidates[candidateCount];
        if (!c) {
          c = { label, sx: 0, sy: 0, onScreen: false, priorityPx: 0, halfW: 0 };
          candidates.push(c);
        }
        c.label = label;
        c.sx = sx;
        c.sy = sy;
        c.onScreen = onScreen;
        c.priorityPx = m.data.radiusAU / Math.max(moonCamDist, 1e-12);
        c.halfW = (m.data.name.length * 6.5 + 12) / 2;
        candidateCount++;
      }
    }

    candidates.length = candidateCount;
    // Visible labels outrank edge-clamped ones (an off-screen moon pinned to
    // the margin must not suppress a genuinely visible neighbor), then
    // bigger apparent discs win.
    candidates.sort(
      (a, b) => Number(b.onScreen) - Number(a.onScreen) || b.priorityPx - a.priorityPx,
    );
    const LABEL_H = 18;
    let placedCount = 0;
    // In-place partition: indices [0, placedCount) hold the placed labels.
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      let collides = false;
      for (let j = 0; j < placedCount; j++) {
        const p = candidates[j];
        if (
          Math.abs(c.sx - p.sx) < c.halfW + p.halfW &&
          Math.abs(c.sy - p.sy) < LABEL_H
        ) {
          collides = true;
          break;
        }
      }
      if (collides) {
        c.label.style.display = 'none';
        continue;
      }
      const swap = candidates[placedCount];
      candidates[placedCount] = c;
      candidates[i] = swap;
      placedCount++;
      c.label.style.display = 'block';
      c.label.style.left = `${c.sx}px`;
      c.label.style.top = `${c.sy}px`;
      c.label.classList.toggle('edge', !c.onScreen);
    }
  }

  private updateSunShader(dt: number) {
    if (!this.solarSystem) return;
    const sunMat = this.solarSystem.sun.userData.sunMaterial as THREE.ShaderMaterial | undefined;
    if (sunMat) {
      sunMat.uniforms.time.value += dt;
    }
  }

  private updateOrbitLineVisibility() {
    if (!this.solarSystem) return;
    // Surface view shows the sky, not the scene furniture — a planet's orbit
    // line crossing the ecliptic would streak straight through the eclipse.
    // The "Orbit lines" setting hides the same furniture everywhere else.
    const hideAll = this.landedView === 'surface' || !this.showOrbitLines;
    for (let i = 0; i < this.solarSystem.orbitLines.length; i++) {
      const orbit = this.solarSystem.orbitLines[i];
      orbit.visible = !hideAll;
      if (hideAll) continue;
      const body = PLANETARIUM_BODIES[i];
      const distToOrbit = Math.abs(this.player.getDistanceFromSun() - body.semiMajorAxisAU);
      const fadeRange = Math.max(body.semiMajorAxisAU * 0.3, 1.0);
      const opacity = Math.max(0.05, Math.min(0.4, 1 - distToOrbit / fadeRange));
      (orbit.material as THREE.LineBasicMaterial).opacity = opacity;
    }
  }

  private processInput() {
    if (this.landedOn) return;
    // Flight controls
    const yawFromKeys =
      (this.keys.has('arrowright') || this.keys.has('d') ? 1 : 0) -
      (this.keys.has('arrowleft') || this.keys.has('a') ? 1 : 0);
    let yaw = yawFromKeys;
    yaw = THREE.MathUtils.clamp(yaw + this.touchYaw + this.gyro.yaw, -1, 1);
    this.player.yawInput = yaw;

    const pitchFromKeys =
      (this.keys.has('arrowup') ? 1 : 0) -
      (this.keys.has('arrowdown') ? 1 : 0);
    let pitch = pitchFromKeys;
    pitch = THREE.MathUtils.clamp(pitch + this.touchPitch + this.gyro.pitch, -1, 1);
    this.player.pitchInput = pitch;

    // Throttle (keyboard + touch)
    let throttle =
      (this.keys.has('w') ? 1 : 0) -
      (this.keys.has('s') ? 1 : 0);
    if (this.touchThrottle !== 0) throttle = this.touchThrottle;

    const hasManualInput = yaw !== 0 || pitch !== 0 || throttle !== 0;

    // Flying immediately resumes the chase camera — don't make the user wait out
    // the post-drag look-around grace period when they start steering/throttling.
    if (this.userOrbiting && hasManualInput) {
      this.userOrbiting = false;
      if (this.userOrbitTimeout !== null) {
        clearTimeout(this.userOrbitTimeout);
        this.userOrbitTimeout = null;
      }
    }

    // Any manual steering input disengages autopilot
    if (this.autopilot && hasManualInput) {
      this.disableAutopilot();
    }

    if (throttle > 0) {
      this.reviveParkedShip(); // accelerating a parked ship means "go"
      // Accelerate — route to whichever speed mode is active
      if (this.inSystemMode) {
        if (this.player.systemSpeedMultiplier < 0.001) {
          this.player.systemSpeedMultiplier = Math.min(this.player.systemSpeedMultiplier + 0.0001, PlayerShip.SYSTEM_SPEED_MAX);
        } else {
          this.player.systemSpeedMultiplier = Math.min(this.player.systemSpeedMultiplier * 1.01, PlayerShip.SYSTEM_SPEED_MAX);
        }
      } else {
        if (this.player.speedMultiplier < 0.05) {
          this.player.speedMultiplier = Math.min(this.player.speedMultiplier + 0.002, PlayerShip.SPEED_MAX);
        } else {
          this.player.speedMultiplier = Math.min(this.player.speedMultiplier * 1.01, PlayerShip.SPEED_MAX);
        }
      }
      this.updateSpeedSlider();
    }
    if (throttle < 0) {
      // Decelerate — route to whichever speed mode is active
      if (this.inSystemMode) {
        this.player.systemSpeedMultiplier = Math.max(this.player.systemSpeedMultiplier * 0.99 - 0.0001, 0);
      } else {
        this.player.speedMultiplier = Math.max(this.player.speedMultiplier * 0.99 - 0.001, 0);
      }
      this.updateSpeedSlider();
    }
  }

  private handleKeyDown(e: KeyboardEvent) {
    if (!this.active) return;
    // The rail/clock widgets preventDefault the keys they handle — a handled
    // key must not also steer the ship or toggle thrust here.
    if (e.defaultPrevented) return;

    // Escape always works — even while typing in the deck search
    if (e.key === 'Escape') {
      if (this.isHelpOpen()) { this.hideHelp(); return; }
      // One Esc, one meaning while tutorialing: end the tutorial. Above the deck rung
      // on purpose — during the deck theater the open deck is tutorial-owned, and
      // closing just it would leave the pending commit to teleport anyway.
      if (this.tutorial) { this.stopTutorial({ restore: true, toast: 'skip' }); return; }
      if (this.isDeckOpen()) { this.closeDeck(); return; }
      if (this.bottomBar.isTimeOpen()) { this.bottomBar.closeTime(); return; }
      if (this.bottomBar.isStatsOpen()) { this.bottomBar.closeStats(); return; }
      if (this.surfaceTargetMenu.isOpen()) { this.closeSurfaceTargetMenu(); return; }
      if (this.landedView === 'surface') { this.exitSurfaceView(); return; }
      if (this.observatoryPanel.isOpen()) { this.closeObservatoryPanel(); return; }
      if (this.landedOn) { this.exitLandedMode(); return; }
    }

    // Don't capture other keys if typing in an input
    if ((e.target as HTMLElement).tagName === 'INPUT') return;

    // Deck open: list keys work without focusing the search box first, and
    // printable characters focus it — so keys can open the deck but not
    // close or switch it (T while open just types "t" into the query).
    if (this.isDeckOpen() && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.key === 'ArrowDown') { e.preventDefault(); this.moveDeckHighlight(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); this.moveDeckHighlight(-1); return; }
      if (e.key === 'Enter' && !(e.target as HTMLElement).closest('button')) {
        e.preventDefault();
        this.commitDeckHighlight();
        return;
      }
      if (e.key.length === 1 && /[\w ]/.test(e.key)) {
        (document.getElementById('deck-search') as HTMLInputElement | null)?.focus();
        return;
      }
      return;
    }

    // The deck verbs (and the panel toggle) work everywhere outside missions
    // and the help modal — landed and in surface view included.
    const key = e.key.toLowerCase();
    if ((key === 't' || key === 'o' || key === 'p') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (this.isMissionActive() || this.isHelpOpen()) return;
      if (key === 't') this.toggleDeck('travel');
      else if (key === 'o') this.observatoryAction();
      else this.toggleAutopilot();
      // Opening the deck focuses its search; without this the same keystroke
      // then types into it and the list opens pre-filtered.
      e.preventDefault();
      return;
    }

    // Time throttle keys ride beside the deck verbs: , . step the rate, N
    // jumps the clock to now — landed and surface view included. The ☰ menu
    // joins the guard set: it auto-pauses the clock while open, and stepping
    // deliberately unpauses, which would clobber the state it must restore.
    if ((key === ',' || key === '.' || key === 'n') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (this.isMissionActive() || this.isHelpOpen() || this.menuPanel.isOpen()) return;
      if (key === ',') this.stepTimeRate(-1);
      else if (key === '.') this.stepTimeRate(1);
      else this.timeJumpToNow();
      // The surface strip's Pause/Resume label re-renders on its own 8 Hz
      // pass — refresh now so a keyboard action never shows a stale label.
      if (this.landedView === 'surface') this.renderSurfaceHud();
      e.preventDefault();
      return;
    }

    // Space activates a focused button natively — pressing it on the panel's
    // transport (or any bar chip) must not also drive the global Space verbs.
    const spaceOnControl =
      e.key === ' ' && !!(e.target as HTMLElement).closest?.('button, [role="button"]');

    // Suppress flight keys while landed — except Space, which pauses the
    // clock there (the time rail is the one live throttle on the ground;
    // in cruise Space keeps its ship-thrust meaning below).
    if (this.landedOn) {
      if (e.key === ' ' && !spaceOnControl && !this.isMissionActive() && !this.isHelpOpen()
        && !this.menuPanel.isOpen()) {
        e.preventDefault();
        this.timeTogglePause();
        if (this.landedView === 'surface') this.renderSurfaceHud();
      }
      return;
    }
    if (this.isMissionActive()) return;

    this.keys.add(e.key.toLowerCase());

    // Space toggles pause
    if (e.key === ' ' && !spaceOnControl) {
      e.preventDefault();
      this.player.moving = !this.player.moving;
    }
  }

  private handleKeyUp(e: KeyboardEvent) {
    this.keys.delete(e.key.toLowerCase());
  }

  private checkOrbitCrossings() {
    const playerDist = this.player.getDistanceFromSun();

    for (const body of PLANETARIUM_BODIES) {
      const orbitDist = body.semiMajorAxisAU;
      const crossThreshold = Math.max(orbitDist * 0.005, 0.01);

      if (Math.abs(playerDist - orbitDist) < crossThreshold) {
        if (this.lastCrossedOrbit !== body.name) {
          this.lastCrossedOrbit = body.name;
          this.notification.show(`Crossing ${body.name}'s orbit \u2014 ${body.semiMajorAxisAU.toFixed(2)} AU`);
        }
        return;
      }
    }

    // Clear when not near any orbit
    if (this.lastCrossedOrbit) {
      const lastBody = PLANETARIUM_BODIES.find(b => b.name === this.lastCrossedOrbit);
      if (lastBody) {
        const dist = Math.abs(this.player.getDistanceFromSun() - lastBody.semiMajorAxisAU);
        if (dist > Math.max(lastBody.semiMajorAxisAU * 0.02, 0.05)) {
          this.lastCrossedOrbit = null;
        }
      }
    }
  }

  private checkPlanetVisits() {
    if (!this.solarSystem) return;

    for (const planet of this.solarSystem.planets) {
      const pos = planet.group.userData.worldPosAU as { x: number; y: number; z: number } | undefined;
      if (!pos) continue;
      const dx = this.player.posX - pos.x;
      const dy = this.player.posY - pos.y;
      const dz = this.player.posZ - pos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      const visitDist = Math.max(
        planet.data.radiusAU * 10,
        this.getPlanetCollisionRadius(planet.data.radiusAU, planet.group.scale.x) * 1.02,
      );

      // Mark a visit once inside the 10x-radius or collision interaction shell.
      if (dist < visitDist && !this.player.visitedPlanets.has(planet.data.name)) {
        this.player.visitedPlanets.add(planet.data.name);
        this.notification.show(`Arrived at ${planet.data.name}! ${planet.data.description}`);
      }
    }
  }

  private checkProximityLand() {
    if (!this.solarSystem || this.landedOn) {
      this.setNearbyLandTarget(null);
      return;
    }

    let closest: NonNullable<LandedTarget> | null = null;
    let closestDist = Infinity;

    // Check planets
    for (const planet of this.solarSystem.planets) {
      const wp = planet.group.userData.worldPosAU as { x: number; y: number; z: number } | undefined;
      if (!wp) continue;
      const dx = this.player.posX - wp.x;
      const dy = this.player.posY - wp.y;
      const dz = this.player.posZ - wp.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const threshold = this.getPlanetCollisionRadius(planet.data.radiusAU, planet.group.scale.x) * 2;
      if (dist < threshold && dist < closestDist) {
        closestDist = dist;
        closest = { type: 'planet', name: planet.data.name };
      }

      // Check moons of nearby planets using real AU positions
      const moons = this.planetMoons.get(planet.data.name);
      if (!moons) continue;
      const moonThreshold = this.getMoonSystemThresholdAU(planet.data.radiusAU, moons);
      if (dist > moonThreshold) continue;
      for (const m of moons) {
        // Compute moon's real AU position (parent + orbital offset)
        const offset = this.getMoonWorldOffsetAU(m.data, planet.data, this.tmpMoonOffset);
        const mdx = this.player.posX - (wp.x + offset.x);
        const mdy = this.player.posY - (wp.y + offset.y);
        const mdz = this.player.posZ - (wp.z + offset.z);
        const md = Math.sqrt(mdx * mdx + mdy * mdy + mdz * mdz);
        const moonLandThreshold = Math.max(m.data.radiusAU * this.planetScale * 3, 0.0003);
        if (md < moonLandThreshold && md < closestDist) {
          closestDist = md;
          closest = { type: 'moon', name: m.data.name, parentPlanet: planet.data.name };
        }
      }
    }

    this.setNearbyLandTarget(closest);
  }

  private setNearbyLandTarget(target: NonNullable<LandedTarget> | null) {
    if (this.isMissionActive()) {
      this.nearbyLandTarget = null;
      const btn = document.getElementById('planetarium-btn-land');
      if (btn) btn.style.display = 'none';
      return;
    }

    const prevName = this.nearbyLandTarget?.name ?? null;
    const newName = target?.name ?? null;
    if (prevName === newName) return;

    this.nearbyLandTarget = target;
    const btn = document.getElementById('planetarium-btn-land');
    const nameEl = document.getElementById('land-body-name');
    if (btn) btn.style.display = target ? '' : 'none';
    if (nameEl) nameEl.textContent = target?.name ?? '';
  }

  private showIntroText() {
    if (this.store.hasSeenHelp()) return;
    if (this.resumePrompt.isVisible()) return;
    this.showHelp();
  }

  private updateStatsUI() {
    const stats = computeStats(
      this.player.posX, this.player.posY, this.player.posZ,
      this.player.speedAUPerS,
      this.player.distanceTraveled,
      this.player.timeElapsed,
      this.planetWorldPositions,
    );
    this.statsPanel.render(stats, this.fpsDisplay);
  }

  private updateSunLabel() {
    if (!this.solarSystem) return;
    this.sunLabel.update(
      this.solarSystem.sun.position,
      this.camera,
      this.renderer.domElement,
      this.player.getDistanceFromSun(),
      (x, y, depth) => this.planetLabels?.isScreenPointOccluded(x, y, depth) ?? false,
    );
  }

  /** Throttle-up un-parks the ship. Guarded: the ☰ menu/help parks run their
   *  own capture-and-resume (and `keys` keeps accumulating while modals are
   *  up), the tutorial's stagings are deliberate freeze-frames, and missions
   *  script `moving` themselves — reviving under any of those fights them. */
  private reviveParkedShip() {
    if (this.player.moving) return;
    if (this.menuPanel.isOpen() || this.isHelpOpen()) return;
    if (this.tutorial || this.isMissionActive()) return;
    this.player.moving = true;
  }

  private formatSystemSpeed(speedMultiplier: number): string {
    const kmPerS = speedMultiplier * 299792.458;
    if (kmPerS < 1000) return Math.round(kmPerS) + ' km/s';
    return Math.round(kmPerS / 1000) + 'k km/s';
  }

  private updateSpeedSlider() {
    // Update mode detection with hysteresis (but override forces space mode)
    if (this.throttleOverride || !this.systemSlowdown) {
      this.inSystemMode = false;
    } else if (this.systemSpeedFactor < 0.5) {
      this.inSystemMode = true;
    } else if (this.systemSpeedFactor > 0.6) {
      this.inSystemMode = false;
    }

    // Auto-disable override once clear of both the planet throttle and any moon
    // limiter. systemSpeedFactor alone reflects only the parent-system throttle,
    // so without the moon check the override would clear itself the instant you
    // stepped outside a planet's radius — even while an outer moon still caps.
    if (this.throttleOverride && this.systemSpeedFactor >= 1.0 && !this.moonCapEngaged) {
      this.throttleOverride = false;
    }

    if (this.speedLabelEl) {
      this.speedLabelEl.textContent = this.inSystemMode
        ? (this.nearestSystemPlanet ?? 'System')
        : 'Space';
    }

    // Visual feedback for override state
    if (this.speedCenterEl) {
      this.speedCenterEl.classList.toggle('throttle-override', this.throttleOverride);
    }
    if (this.speedValueEl) {
      // The pill reads the speed the ship is actually doing (parked → 0,
      // proximity-capped → the cap), not the throttle setting — the setting
      // kept "25k km/s" on screen over a parked ship. Slow deep-space speeds
      // drop to km/s so a governed crawl never reads "0.0c".
      const actualC = this.player.speedC;
      this.speedValueEl.textContent =
        this.inSystemMode || actualC < 0.05
          ? (actualC < 0.0005 ? '0 km/s' : this.formatSystemSpeed(actualC))
          : `${actualC.toFixed(1)}c`;
    }
  }

  isMissionActive(): boolean {
    return this.activeHistoricJourney !== null;
  }

  private setHistoricPanelVisible(visible: boolean) {
    document.getElementById('historic-panel')?.classList.toggle('visible', visible);
    const reopenBtn = document.getElementById('historic-reopen');
    const journey = this.activeHistoricJourney;
    if (!reopenBtn) return;

    if (!journey || visible || !this.historicPanelDismissed) {
      reopenBtn.classList.remove('visible');
      return;
    }

    reopenBtn.textContent = `${journey.label} · ${this.historicMilestoneIndex + 1}/${journey.milestones.length}`;
    reopenBtn.classList.add('visible');
  }

  private dismissHistoricPanel() {
    if (!this.isMissionActive()) return;
    this.historicPanelDismissed = true;
    this.setHistoricPanelVisible(false);
  }

  private collapseHistoricJourneyMenu() {
    document.getElementById('planetarium-historic-submenu')?.classList.remove('visible');
    document.getElementById('planetarium-btn-historic')?.classList.remove('expanded');
  }

  private rememberPreMissionState() {
    if (this.activeHistoricJourney) return;
    this.preMissionState = this.getState();
    this.preMissionMenuVisible = this.menuPanel.isOpen();
  }

  private restorePreMissionState() {
    const previousState = this.preMissionState;
    const previousMenuVisible = this.preMissionMenuVisible;
    this.preMissionState = null;
    this.preMissionMenuVisible = false;

    if (!previousState) return;

    this.restoreState(previousState);
    this.menuPanel.setVisible(previousMenuVisible);
  }

  // ── Guided tutorial ──────────────────────────────────────────────────────────
  // The Next-driven click-through of the app's showcase scenes. Pure logic
  // (step table, phase machine, settle/restore rules) lives in tutorialLogic.ts,
  // the card widget in ui/TutorialCard.ts; this block owns the scene work. Every
  // step staging is absolute and idempotent: inputs stay live while a tutorial
  // runs, so Next must put the scene where the step needs it no matter what
  // the user did meanwhile — and if the user starts a rival arrival, the
  // tutorial re-stages after it resolves (the tutorial wins, a beat later).

  /** Entry: the help-modal footer and the ☰ menu item. */
  startTutorial(): void {
    // Close the entry surfaces before the guard — a refused click must not
    // leave a dead modal up. Both auto-pause ship and clock, and the snapshot
    // below must capture the resumed truth, not the modal freeze.
    this.hideHelp();
    this.closeMenuPanel();
    if (
      !canStartTutorial({
        missionActive: this.isMissionActive(),
        resumePromptVisible: this.resumePrompt.isVisible(),
        alreadyActive: this.tutorial !== null,
      })
    ) {
      return;
    }
    // A pre-tutorial surface view can't be snapshotted (view sub-states are
    // session-only; getState() carries none of them) — settle to orbit view
    // now so the tutorial starts from a state the restore can reproduce.
    if (this.landedView === 'surface') this.exitSurfaceView(true);
    const snapshot: TutorialSnapshot = {
      state: this.getState(), // before this.tutorial is set — the override must not see itself
      excursion: this.observatoryExcursion,
      panelWasOpen: this.observatoryPanel.isOpen(),
      lastObservatoryEvent: this.lastObservatoryEvent,
    };
    this.tutorial = {
      stepIndex: 0,
      phase: 'staging',
      snapshot,
      eclipse: null,
      totalityReached: false,
      everStaged: false,
      stagedAtMs: performance.now(),
      timer: null,
      generation: 0,
      endRequest: null,
    };
    // The card narrates from here; stray banners would talk over it (on
    // phones they share the same top strip).
    this.notification.setMuted(true);
    this.updateTutorialMenuItem();
    this.tutorialCard.show();
    this.stageTutorialStep(0);
  }

  private advanceTutorial(): void {
    const tutorial = this.tutorial;
    if (!tutorial || tutorial.phase !== 'ready') return;
    if (tutorial.stepIndex + 1 >= TUTORIAL_STEPS.length) return; // the wrap card's primary ends instead
    this.stageTutorialStep(tutorial.stepIndex + 1);
  }

  /** Back re-stages the previous stop (stagings are absolute, so this is just
   *  the index math). The card hides Back below index 2 — see tutorialCardModel
   *  — but guard here too: a stale click must not stage the welcome card's
   *  nothing over a live scene. */
  private backTutorial(): void {
    const tutorial = this.tutorial;
    if (!tutorial || tutorial.phase !== 'ready' || tutorial.stepIndex < 2) return;
    this.stageTutorialStep(tutorial.stepIndex - 1);
  }

  /**
   * End the tutorial. restore=true puts the pre-tutorial snapshot back; restore=false
   * keeps the staged scene as the journey (New Journey). sync
   * marks a lifecycle abort (deactivate, mission start): the caller's own
   * teardown continues immediately after, so the restore must apply
   * synchronously — never through the veil-gated arrival, which is silently
   * dropped while another arrival is mid-flight.
   */
  private stopTutorial(opts: { restore: boolean; sync?: boolean; toast?: 'skip' | 'return' }): void {
    const tutorial = this.tutorial;
    if (!tutorial) return;
    tutorial.generation++; // strand every pending theater timer and arrival closure
    if (tutorial.timer !== null) {
      clearTimeout(tutorial.timer);
      tutorial.timer = null;
    }
    tutorial.phase = tutorialTransition(tutorial.phase, opts.sync ? 'abort' : 'skip');
    const toast = opts.toast ?? null;
    if (!opts.sync && this.arrivalInFlight) {
      // Mid-arrival: park the request; updateTutorial executes it on the first
      // idle frame (the veil is up — nothing useful could happen sooner).
      tutorial.endRequest = { restore: opts.restore, toast };
      this.renderTutorialCard(); // 'ending' disables both buttons
      return;
    }
    this.executeTutorialStop(opts.restore, opts.sync === true, toast);
  }

  private executeTutorialStop(restore: boolean, sync: boolean, toast: TutorialEndToast): void {
    const tutorial = this.tutorial;
    if (!tutorial) return;
    const snap = tutorial.snapshot;
    // The tutorial owns these while it runs — take them down with it. The card
    // hides now; the scene may still restore behind the veil a beat later.
    // The ☰ menu closes too: Esc can end the tutorial with it open (the Esc
    // cascade has no menu rung), and it must not float over the restore.
    this.closeDeck();
    this.closeSurfaceTargetMenu();
    this.closeMenuPanel();
    this.tutorialCard.hide();
    const finish = () => {
      // Tail runs only once the restore has actually applied: until here the
      // getState() override keeps serving the snapshot, so a save racing the
      // restore can never persist a half-torn-down showcase scene.
      this.tutorial = null;
      this.notification.setMuted(false);
      this.updateTutorialMenuItem();
      this.store.saveState(this.getState());
      if (toast === 'skip') {
        this.notification.show('Tutorial ended. It’s in the ☰ menu if you want it again.', { force: true });
      } else if (toast === 'return') {
        this.notification.show('Back where you started.', { force: true });
      }
    };
    if (!restore) {
      // New Journey: the staged scene becomes the journey.
      finish();
      return;
    }
    if (!tutorial.everStaged) {
      // "Not now" / Esc on the welcome card: no scene ever staged, so there is
      // nothing to put back — a restore here would only jump-cut a landed
      // user's own camera framing to the default. Whatever they did under the
      // card is theirs to keep.
      finish();
      return;
    }
    const plan = restorePlan({
      snapshotLandedOn: snap.state.landedOn?.name ?? null,
      panelWasOpen: snap.panelWasOpen,
      inSurfaceView: this.landedView === 'surface',
      landedOn: this.landedOn?.name ?? null,
      lifecycleAbort: sync,
    });
    const applyRestore = () => {
      // A competing stop may have finished while a veiled restore waited out
      // its cover frames — the loser must not restore twice.
      if (this.tutorial !== tutorial) return;
      if (plan.exitSurfaceView && this.landedView === 'surface') this.exitSurfaceView(true);
      // The Moon staging opens the panel, and a landed→landed restore re-lands
      // through the ceremony-free path that deliberately preserves an open
      // panel — close it unconditionally and let reopenPanel put back exactly
      // what the snapshot had.
      this.closeObservatoryPanel();
      // Stagings exit/re-land, which consumes the session excursion pose —
      // drop the live one and put the snapshot's copy back after restore.
      this.observatoryExcursion = null;
      if (plan.exitLandedFirst && this.landedOn) this.exitLandedMode();
      this.restoreState(snap.state); // re-lands when the snapshot was landed
      this.observatoryExcursion = snap.excursion;
      this.lastObservatoryEvent = snap.lastObservatoryEvent;
      if (plan.reopenPanel && this.landedOn) this.openObservatoryPanel();
      finish();
    };
    if (plan.veilGate && snap.state.landedOn) {
      this.arriveThen(snap.state.landedOn, applyRestore);
    } else {
      applyRestore();
    }
  }

  /**
   * Absolute staging for one step: close the transient overlays the tutorial is
   * about to play through, then run the step's scene work. The scene stagings
   * normalize the clock themselves (a paused clock would freeze the time-lapse
   * and the eclipse approach); card-only steps leave the user's clock alone.
   */
  private stageTutorialStep(index: number): void {
    const tutorial = this.tutorial;
    if (!tutorial) return;
    tutorial.stepIndex = index;
    tutorial.phase = 'staging';
    tutorial.totalityReached = false;
    tutorial.generation++;
    if (tutorial.timer !== null) {
      clearTimeout(tutorial.timer);
      tutorial.timer = null;
    }
    const generation = tutorial.generation;
    // A user-opened deck may hold a search filter that would hide the
    // theater's target row — closing resets it (openDeck clears the query on
    // fresh opens only).
    this.closeDeck();
    this.closeSurfaceTargetMenu();
    this.bottomBar.closeStats();
    this.bottomBar.closeTime();
    this.renderTutorialCard();
    const step = TUTORIAL_STEPS[index];
    if (step.stage !== 'none') tutorial.everStaged = true;
    switch (step.stage) {
      case 'none':
        // Card-only: welcome narrates over the user's own scene (clock
        // included), wrap over the eclipse the previous step set up.
        this.markTutorialStaged(generation);
        break;
      case 'saturn':
        this.stageTutorialSaturn(generation);
        break;
      case 'moon':
        this.stageTutorialMoon(generation);
        break;
      case 'timelapse':
        this.stageTutorialTimelapse(generation);
        break;
      case 'eclipse':
        this.stageTutorialEclipse(generation);
        break;
    }
  }

  /**
   * Veil-gated arrival for the tutorial. arriveThen silently ignores a call while
   * another arrival is mid-flight — a user teleport during the deck theater
   * would otherwise strand the step in 'staging' forever — so retry on a
   * short timer until the rival resolves, then commit: the user's arrival
   * lands, and the tutorial re-stages a beat later. Generation-checked
   * throughout, so it dies quietly after any skip/advance/stop.
   */
  private tutorialArriveWhenIdle(
    generation: number,
    target: NonNullable<LandedTarget>,
    action: () => void,
  ): void {
    const tutorial = this.tutorial;
    if (!tutorial || tutorial.generation !== generation) return;
    if (this.arrivalInFlight) {
      tutorial.timer = window.setTimeout(() => {
        const live = this.tutorial;
        if (!live || live.generation !== generation) return;
        live.timer = null;
        this.tutorialArriveWhenIdle(generation, target, action);
      }, 120);
      return;
    }
    this.arriveThen(target, () => {
      const live = this.tutorial;
      if (!live || live.generation !== generation) return;
      action();
    });
  }

  /** Accent pulse on the deck row the theater is about to press. Stale pulses
   *  die with the rows — every deck open rebuilds the list. */
  private pulseTutorialDeckRow(name: string): void {
    const list = document.getElementById('deck-list');
    if (!list) return;
    for (const row of list.querySelectorAll('.pk-row.tutorial-pulse')) row.classList.remove('tutorial-pulse');
    this.findDeckRow(name)?.classList.add('tutorial-pulse');
  }

  /** Ensure the tutorial stands on `target` (fresh landing or ceremony-free
   *  re-land), then continue — the shared trunk of the landed stagings. */
  private tutorialLandThen(
    generation: number,
    target: NonNullable<LandedTarget>,
    then: () => void,
  ): void {
    this.tutorialArriveWhenIdle(generation, target, () => {
      if (this.landedOn) {
        // A live surface view would keep a stale cross-system target.
        if (this.landedView === 'surface') this.exitSurfaceView(true);
        this.applyLandedTarget(target);
      } else {
        this.enterLandedMode(target);
      }
      then();
    });
  }

  /** Deck theater, Teleport tab: open on Saturn's row, pulse it, commit the
   *  same jump the row's click would — the tutorial demonstrates the deck by
   *  visibly using it. */
  private stageTutorialSaturn(generation: number): void {
    this.setTutorialClockRate(1);
    this.closeObservatoryPanel();
    const saturn = PLANETARIUM_BODIES.find((b) => b.name === 'Saturn');
    if (!saturn) {
      this.markTutorialStaged(generation);
      return;
    }
    this.openDeck('travel');
    this.revealDeckRow('Saturn');
    this.pulseTutorialDeckRow('Saturn');
    const tutorial = this.tutorial;
    if (!tutorial) return;
    tutorial.timer = window.setTimeout(() => {
      const live = this.tutorial;
      if (!live || live.generation !== generation) return;
      live.timer = null;
      this.closeDeck();
      this.tutorialArriveWhenIdle(generation, { type: 'planet', name: 'Saturn' }, () => {
        if (this.landedOn) this.exitLandedMode();
        this.jumpToPlanet(saturn, { notify: false });
        // Freeze-frame: the card narrates over a parked ship. Left under way
        // (the arrival default), it would glide from the standoff to Saturn's
        // collision shell in ~20 s, right under the copy.
        this.player.moving = false;
        this.markTutorialStaged(generation);
      });
    }, 900);
  }

  /** Deck theater, Observatory tab: the one-tap-lands-you-there flow, ending
   *  on the Moon with the sky panel open regardless of the arrival
   *  preference — the card talks about what the panel shows. */
  private stageTutorialMoon(generation: number): void {
    this.setTutorialClockRate(1);
    this.openDeck('observe');
    this.revealDeckRow('Moon');
    this.pulseTutorialDeckRow('Moon');
    const tutorial = this.tutorial;
    if (!tutorial) return;
    tutorial.timer = window.setTimeout(() => {
      const live = this.tutorial;
      if (!live || live.generation !== generation) return;
      live.timer = null;
      this.closeDeck();
      this.tutorialLandThen(generation, { type: 'moon', name: 'Moon', parentPlanet: 'Earth' }, () => {
        this.openObservatoryPanel();
        this.markTutorialStaged(generation);
      });
    }, 600);
  }

  /**
   * The Jupiter system at "2 hr/s", watched from the regular landed orbit
   * camera — the motion showcase: the planet spins through a full day every
   * ~5 s of wall clock while the Galilean moons wheel around it, crossing
   * its face and slipping behind it (shadow-transit spots included, they're
   * always on in the landed system). The camera pulls back past the default
   * lit-side close-up so Io's whole orbit fits in frame — the point of this
   * stop is the system moving, not the portrait.
   */
  private stageTutorialTimelapse(generation: number): void {
    this.tutorialLandThen(generation, { type: 'planet', name: 'Jupiter' }, () => {
      // The panel stays up on purpose: at 2 hr/s its now-bar, phase glyph and
      // distances visibly run, which is half of what this card teaches. The
      // open is explicit (not inherited from the Moon stop) so the staging
      // holds even if the user closed the panel there.
      this.openObservatoryPanel();
      const pullbackAU = this.getLandedBodyRenderedRadiusAU() * 8;
      this.camera.position.setLength(
        Math.min(Math.max(pullbackAU, this.controls.minDistance), this.controls.maxDistance),
      );
      this.camera.lookAt(0, 0, 0);
      this.setTutorialClockRate(TUTORIAL_TIMELAPSE_RATE);
      this.markTutorialStaged(generation);
    });
  }

  /**
   * Land on Earth standing in the 2027-08-02 umbral path: the clock jumps to
   * the eclipse's first contact and runs at "20 min/s", so the Moon bites
   * into the Sun over a few seconds; updateTutorial drops to realtime just
   * inside totality. The surface vantage rides the umbral spot per frame
   * (updateSurfaceCamera), so totality then holds while the user lingers.
   */
  private stageTutorialEclipse(generation: number): void {
    this.tutorialLandThen(generation, { type: 'planet', name: 'Earth' }, () => {
      const tutorial = this.tutorial;
      if (!tutorial) return;
      tutorial.eclipse ??= findShadowEvent(TUTORIAL_ECLIPSE.spec, TUTORIAL_ECLIPSE.searchFromUtcMs, 1);
      const event = tutorial.eclipse;
      if (event) {
        // Stepper/narrative parity with a panel-driven jump to this event.
        this.lastObservatoryEvent = event;
        this.timeState = { ...this.timeState, rate: TUTORIAL_ECLIPSE_APPROACH_RATE, paused: false };
        this.setCurrentUtcMs(event.startUtcMs);
        // The clock just moved a year ahead: realign the landed scene before
        // the surface entry fits its FOV off the target geometry.
        this.refreshLandedScene();
        const landedInfo = this.surfaceLandedInfo();
        if (landedInfo) this.enterSurfaceView(selectSurfaceTarget(landedInfo, event.spec), 'event');
      } else {
        // A null event (engine drift would be caught by the pin tests) still
        // advances — the card then narrates a plain Earth landing, and there
        // is no totality to hold Next for.
        tutorial.totalityReached = true;
      }
      // The card teaches the panel as the way to find an eclipse, so it must be
      // on screen. Surface entry closed it; reopen it over the sky exactly as
      // the HUD's Observatory chip does. On phones show() starts the sheet at
      // peek, clear of the centered Sun, and the HUD chevron clamps to it.
      this.openObservatoryPanel();
      this.markTutorialStaged(generation);
    });
  }

  /** A staging's scene work has been applied — begin settling. Generation-
   *  checked: a stale theater timer or arrival action must not mark a newer
   *  step (or a stopped tutorial) as staged. */
  private markTutorialStaged(generation: number): void {
    const tutorial = this.tutorial;
    if (!tutorial || tutorial.generation !== generation) return;
    tutorial.phase = tutorialTransition(tutorial.phase, 'staged');
    tutorial.stagedAtMs = performance.now();
    this.renderTutorialCard();
  }

  /** Per-frame tutorial work (top of update()): promote 'settling' → 'ready' when
   *  the step's busy signals clear, and run a stop that was parked while an
   *  arrival was mid-flight. */
  private updateTutorial(): void {
    const tutorial = this.tutorial;
    if (!tutorial) return;
    if (tutorial.phase === 'ending') {
      if (tutorial.endRequest && !this.arrivalInFlight) {
        const request = tutorial.endRequest;
        tutorial.endRequest = null;
        this.executeTutorialStop(request.restore, false, request.toast);
      }
      return;
    }
    const step = TUTORIAL_STEPS[tutorial.stepIndex];
    if (tutorial.phase === 'settling') {
      const settled = isStepSettled(
        {
          arrivalInFlight: this.arrivalInFlight,
          veilCovering:
            document.getElementById('arrival-veil')?.classList.contains('covering') ?? false,
          fovAnimating: this.surfaceFovAnim !== null,
          totalityReached: tutorial.totalityReached,
          sinceStagedMs: performance.now() - tutorial.stagedAtMs,
        },
        step.settle,
      );
      if (settled) {
        tutorial.phase = tutorialTransition(tutorial.phase, 'settled');
        this.renderTutorialCard();
      }
    }
    // Eclipse card: once the compressed approach carries the clock just
    // inside totality, drop to realtime and release the held Next (the
    // settling→ready transition next frame reads totalityReached and re-renders
    // the card). One-shot — a user who scrubs the rate afterwards is left
    // alone. Gated past 'staging' so a pre-stage clock already sitting in 2027+
    // can't trip it before the staging has even set the time.
    if (
      !tutorial.totalityReached &&
      step.stage === 'eclipse' &&
      tutorial.eclipse !== null &&
      (tutorial.phase === 'settling' || tutorial.phase === 'ready') &&
      this.timeState.currentUtcMs >= totalitySettleUtcMs(tutorial.eclipse.peakUtcMs)
    ) {
      tutorial.totalityReached = true;
      this.setTutorialClockRate(1);
    }
  }

  private renderTutorialCard(): void {
    const tutorial = this.tutorial;
    if (!tutorial) return;
    const step = TUTORIAL_STEPS[tutorial.stepIndex];
    this.tutorialCard.render(
      tutorialCardModel(step, tutorial.stepIndex, TUTORIAL_STEPS.length, tutorial.phase),
    );
  }

  /** The tutorial drives the same clock the transport strip does. The unpause is
   *  deliberate: a clock paused before the tutorial would freeze every staged sky. */
  private setTutorialClockRate(rate: number): void {
    this.timeState = { ...this.timeState, rate, paused: false };
    // Flash the unit over the clock — the staged rate change is exactly the
    // feedback the time-lapse stops narrate.
    this.updateTimeUI({ flash: true });
  }

  private updateTutorialMenuItem(): void {
    const btn = document.getElementById('planetarium-btn-tutorial') as HTMLButtonElement | null;
    if (btn) btn.disabled = this.tutorial !== null;
  }

  private updateMissionControlState() {
    const missionActive = this.isMissionActive();

    for (const id of PlanetariumMode.MISSION_CONTROL_IDS) {
      const button = document.getElementById(id) as HTMLButtonElement | null;
      if (button) button.disabled = missionActive;
    }

    const bottomBar = document.getElementById('planetarium-bottom-bar');
    if (bottomBar) {
      bottomBar.style.opacity = missionActive ? '0.45' : '';
      bottomBar.style.display = missionActive ? 'none' : '';
    }
    // The bar instruments live outside the bar's display toggle — close both
    // when a mission takes over.
    if (missionActive) {
      this.bottomBar.closeStats();
      this.bottomBar.closeTime();
    }

    const speedStatRow = document.getElementById('stat-speed-row');
    if (speedStatRow) speedStatRow.style.display = missionActive ? 'none' : '';

    const landBtn = document.getElementById('planetarium-btn-land');
    if (landBtn) {
      landBtn.style.display = missionActive ? 'none' : (this.nearbyLandTarget ? '' : 'none');
      (landBtn as HTMLButtonElement).disabled = missionActive;
    }

    const leaveBtn = document.getElementById('planetarium-btn-leave') as HTMLButtonElement | null;
    if (leaveBtn) leaveBtn.disabled = missionActive;

    const touchZone = document.getElementById('touch-flight-zone');
    if (touchZone) {
      touchZone.style.pointerEvents = missionActive ? 'none' : '';
      if (missionActive) {
        touchZone.classList.remove('active');
        this.activeFlightTouchId = null;
        this.touchYaw = 0;
        this.touchPitch = 0;
        this.touchThrottle = 0;
      }
    }

    if (missionActive) {
      this.keys.clear();
      this.closeDeck();
    }

    this.updateObservatoryButtonVisibility();
  }

  private wireUpUI() {
    // Tap speed center to toggle system throttle override (temporary)
    document.querySelector('.speed-center')?.addEventListener('click', () => {
      if (this.isMissionActive()) return;
      if (!this.systemSlowdown) return; // already disabled globally
      this.throttleOverride = !this.throttleOverride;
      this.updateSpeedSlider();
    });

    document.getElementById('planetarium-speed-up')?.addEventListener('click', () => {
      if (this.isMissionActive()) return;
      this.reviveParkedShip(); // stepping the throttle up means "go"
      if (this.inSystemMode) {
        if (this.player.systemSpeedMultiplier < 0.001) {
          this.player.systemSpeedMultiplier = 0.001;
        } else {
          this.player.systemSpeedMultiplier = Math.min(this.player.systemSpeedMultiplier * 1.35, PlayerShip.SYSTEM_SPEED_MAX);
        }
      } else {
        if (this.player.speedMultiplier < 0.05) {
          this.player.speedMultiplier = 0.05;
        } else {
          this.player.speedMultiplier = Math.min(this.player.speedMultiplier * 1.35, PlayerShip.SPEED_MAX);
        }
      }
      this.updateSpeedSlider();
    });
    document.getElementById('planetarium-speed-down')?.addEventListener('click', () => {
      if (this.isMissionActive()) return;
      if (this.inSystemMode) {
        if (this.player.systemSpeedMultiplier < 0.002) {
          this.player.systemSpeedMultiplier = 0;
        } else {
          this.player.systemSpeedMultiplier = Math.max(this.player.systemSpeedMultiplier * 0.72, 0);
        }
      } else {
        if (this.player.speedMultiplier < 0.06) {
          this.player.speedMultiplier = 0;
        } else {
          this.player.speedMultiplier = Math.max(this.player.speedMultiplier * 0.72, 0);
        }
      }
      this.updateSpeedSlider();
    });

    document.getElementById('planetarium-btn-save')?.addEventListener('click', () => {
      this.store.saveState(this.getState());
      // Forced: mid-tutorial the banner is muted (and the save then writes the
      // pre-tutorial snapshot on purpose), but a pressed Save must answer.
      this.notification.show('Game saved!', { force: true });
    });

    // New Journey button
    document.getElementById('planetarium-btn-new')?.addEventListener('click', () => {
      // The reset throws the journey away — a live tutorial with it (no restore:
      // the world resets underneath), and the excursion return pose too.
      this.stopTutorial({ restore: false, sync: true });
      this.observatoryExcursion = null;
      if (this.landedOn) this.exitLandedMode();
      // Discard the pre-mission stash: restoring it would re-land a
      // mission-started-landed player AFTER the landedOn check above, and
      // restoreState's not-landed branch never exits landed mode — the
      // landedOn leak. The stash is being thrown away with everything else.
      this.stopHistoricJourney(false);
      this.store.clearState();
      this.restoreState(createDefaultPlanetariumState());
      this.pointTowardMercury();
      this.notification.show('New journey started!');
    });

    document.getElementById('planetarium-btn-historic-1')?.addEventListener('click', () => {
      void this.startHistoricJourney('voyager1');
    });
    document.getElementById('planetarium-btn-historic-2')?.addEventListener('click', () => {
      void this.startHistoricJourney('voyager2');
    });
    document.getElementById('planetarium-btn-cassini')?.addEventListener('click', () => {
      void this.startHistoricJourney('cassini');
    });
    document.getElementById('planetarium-btn-new-horizons')?.addEventListener('click', () => {
      void this.startHistoricJourney('newHorizons');
    });
    document.getElementById('planetarium-btn-juno')?.addEventListener('click', () => {
      void this.startHistoricJourney('juno');
    });
    document.getElementById('historic-close')?.addEventListener('click', () => {
      this.dismissHistoricPanel();
    });
    document.getElementById('historic-reopen')?.addEventListener('click', () => {
      this.showHistoricMilestone(this.historicMilestoneIndex);
    });
    document.getElementById('historic-exit')?.addEventListener('click', () => {
      this.stopHistoricJourney();
    });
    document.getElementById('historic-prev')?.addEventListener('click', () => {
      this.showHistoricMilestone(this.historicMilestoneIndex - 1);
    });
    document.getElementById('historic-next')?.addEventListener('click', () => {
      this.showHistoricMilestone(this.historicMilestoneIndex + 1);
    });

    // Autopilot toggle
    document.getElementById('planetarium-btn-autopilot')?.addEventListener('click', () => {
      if (this.isMissionActive()) return;
      this.toggleAutopilot();
    });

    // Menu panel toggle — auto-pause while open
    document.getElementById('planetarium-btn-menu')?.addEventListener('click', () => {
      if (this.menuPanel.isOpen()) {
        this.closeMenuPanel();
      } else {
        // One modal at a time (the deck closes ☰ on open, symmetric).
        this.closeDeck();
        this.closeSurfaceTargetMenu();
        this.resumeShipAfterMenu = this.player.moving;
        this.resumeTimeAfterMenu = !this.timeState.paused;
        this.player.moving = false;
        this.timeState.paused = true;
        this.menuPanel.show();
      }
    });
    document.getElementById('planetarium-btn-help')?.addEventListener('click', () => {
      this.closeMenuPanel();
      this.showHelp();
    });
    // Tutorial entries: the help-modal footer pair and the ☰ item. startTutorial
    // closes both entry surfaces itself (their auto-pause must resolve
    // before the snapshot is taken).
    document.getElementById('planetarium-btn-tutorial')?.addEventListener('click', () => this.startTutorial());
    document.getElementById('help-take-tutorial')?.addEventListener('click', () => this.startTutorial());
    document.getElementById('help-explore')?.addEventListener('click', () => this.hideHelp());
    document.getElementById('planetarium-help-close')?.addEventListener('click', () => this.hideHelp());
    document.querySelector('#planetarium-help .planetarium-help-backdrop')?.addEventListener('click', () => this.hideHelp());

    document.getElementById('planetarium-btn-historic')?.addEventListener('click', () => {
      const submenu = document.getElementById('planetarium-historic-submenu');
      const trigger = document.getElementById('planetarium-btn-historic');
      const expanded = submenu?.classList.toggle('visible') ?? false;
      trigger?.classList.toggle('expanded', expanded);
    });

    this.bottomBar.bind();
    // One instrument at a time: opening the Stats card tucks the Observatory
    // panel back into its chip, with a brief pulse so the hop reads.
    this.bottomBar.onStatsToggle = (open) => {
      if (open && this.observatoryPanel.isOpen()) {
        this.closeObservatoryPanel();
        this.pulseObservatoryChip();
      }
    };

    this.sunLabel.attach();

    // Astronomy time controls. The transport, Now, and date input keep their
    // id-based handlers here — the rail widget's callbacks only cover the
    // gestures these buttons don't (drag/tap/keys on the rails).
    document.getElementById('planetarium-time-pause')?.addEventListener('click', () => {
      this.timeTogglePause();
    });
    document.getElementById('planetarium-time-play')?.addEventListener('click', () => {
      this.timeState.paused = false;
      if (this.timeState.rate < 0) this.timeState.rate *= -1;
      this.updateTimeUI({ flash: true });
    });
    document.getElementById('planetarium-time-reverse')?.addEventListener('click', () => {
      this.timeState.paused = false;
      this.timeState.rate = -Math.abs(this.timeState.rate);
      this.updateTimeUI({ flash: true });
    });
    document.getElementById('planetarium-time-now')?.addEventListener('click', () => {
      this.timeJumpToNow();
    });
    const timeInputEl = this.timePanel.getInputEl();
    if (timeInputEl) {
      this.timePanel.syncInputValue(this.timeState.currentUtcMs);
      timeInputEl.addEventListener('change', () => {
        const utcMs = parseUtcInputValue(timeInputEl.value);
        if (utcMs !== null) {
          this.timeState.currentUtcMs = utcMs;
          this.rebuildPlanetPositions();
          this.updateTimeUI();
          this.startObservatoryEventSearch();
        }
      });
    }

    // Show ship toggle
    document.getElementById('settings-ship-toggle')?.addEventListener('click', () => {
      this.showShip = !this.showShip;
      this.player.group.visible = this.showShip && !this.landedOn;
      const label = document.getElementById('settings-ship-label');
      if (label) label.textContent = this.showShip ? 'On' : 'Off';
    });

    document.getElementById('settings-gyro-toggle')?.addEventListener('click', () => {
      void this.gyro.toggle();
    });

    document.getElementById('settings-constellations-toggle')?.addEventListener('click', () => {
      this.showConstellations = !this.showConstellations;
      if (this.showConstellations) {
        this.ensureConstellationsReady();
      } else if (this.constellations) {
        this.constellations.setVisible(false);
      }
      const label = document.getElementById('settings-constellations-label');
      if (label) label.textContent = this.showConstellations ? 'On' : 'Off';
    });

    document.getElementById('settings-labels-toggle')?.addEventListener('click', () => {
      this.showBodyLabels = !this.showBodyLabels;
      this.applyBodyLabelVisibility();
      const label = document.getElementById('settings-labels-label');
      if (label) label.textContent = this.showBodyLabels ? 'On' : 'Off';
    });

    document.getElementById('settings-orbits-toggle')?.addEventListener('click', () => {
      // Per-frame updateOrbitLineVisibility applies the flag.
      this.showOrbitLines = !this.showOrbitLines;
      const label = document.getElementById('settings-orbits-label');
      if (label) label.textContent = this.showOrbitLines ? 'On' : 'Off';
    });

    document.getElementById('settings-throttle-toggle')?.addEventListener('click', () => {
      this.systemSlowdown = !this.systemSlowdown;
      const label = document.getElementById('settings-throttle-label');
      if (label) label.textContent = this.systemSlowdown ? 'On' : 'Off';
      this.updateSpeedSlider();
    });

    // Full-screen mobile flight zone
    const flightZone = document.getElementById('touch-flight-zone');
    if (flightZone) {
      flightZone.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        (flightZone as HTMLElement).setPointerCapture?.(event.pointerId);
        this.activeFlightTouchId = event.pointerId;
        this.setFlightTouchFromPoint(event.clientX, event.clientY);
        flightZone.classList.add('active');
      });
      flightZone.addEventListener('pointermove', (event) => {
        if (this.activeFlightTouchId === event.pointerId) {
          this.setFlightTouchFromPoint(event.clientX, event.clientY);
        }
      });
      const clearFlightTouch = (event?: PointerEvent) => {
        if (!event || this.activeFlightTouchId === event.pointerId) {
          this.activeFlightTouchId = null;
          this.touchYaw = 0;
          this.touchPitch = 0;
          flightZone.classList.remove('active');
        }
      };
      flightZone.addEventListener('pointerup', clearFlightTouch);
      flightZone.addEventListener('pointercancel', clearFlightTouch);
      flightZone.addEventListener('pointerleave', clearFlightTouch);
    }

    // The deck — cluster buttons open their tab; commits happen on the rows.
    document.getElementById('planetarium-btn-travel')?.addEventListener('click', () => {
      if (this.isMissionActive()) return;
      // No takeoff here: the tap that commits a destination handles it.
      this.toggleDeck('travel');
    });
    document.getElementById('planetarium-btn-observatory')?.addEventListener('click', () => {
      if (this.isMissionActive()) return;
      this.observatoryAction();
    });
    document.getElementById('planetarium-btn-leave')?.addEventListener('click', () => {
      this.exitLandedMode();
    });
    document.getElementById('planetarium-btn-land')?.addEventListener('click', () => {
      if (this.nearbyLandTarget) {
        this.enterLandedMode(this.nearbyLandTarget);
      }
    });
    document.getElementById('deck-close')?.addEventListener('click', () => this.closeDeck());
    document.getElementById('deck-backdrop')?.addEventListener('click', () => this.closeDeck());
    // In-deck tabs preserve the query AND the from-panel flag; the cluster
    // buttons reset the flag (a fresh errand, not a vantage change).
    document.getElementById('deck-tab-observe')?.addEventListener('click', () => this.switchDeckTab('observe'));
    document.getElementById('deck-tab-travel')?.addEventListener('click', () => this.switchDeckTab('travel'));
    document.getElementById('deck-tab-pilot')?.addEventListener('click', () => this.switchDeckTab('pilot'));
    document.getElementById('deck-pref-toggle')?.addEventListener('click', () => {
      this.skyPrefStored = !this.effectiveSkyPref();
      document.getElementById('deck-pref-toggle')?.classList.toggle('on', this.effectiveSkyPref());
    });
    const deckSearch = document.getElementById('deck-search') as HTMLInputElement | null;
    deckSearch?.addEventListener('input', () => this.filterDeckList());
    // The input owns list keys while focused; the document handler bails on
    // INPUT targets, so each Enter commits exactly once.
    deckSearch?.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); this.moveDeckHighlight(1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); this.moveDeckHighlight(-1); }
      if (e.key === 'Enter') { e.preventDefault(); this.commitDeckHighlight(); }
    });

    this.updateTimeUI();
    this.updateMissionControlState();
  }

  // ── The deck ─────────────────────────────────────────────

  private isDeckOpen(): boolean {
    return this.deckVerb !== null;
  }

  /** The sky-panel-on-arrival preference: stored flip, else the device default. */
  private effectiveSkyPref(): boolean {
    return this.skyPrefStored ?? window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  }

  private openDeck(verb: DeckVerb, opts: { fromPanel?: boolean } = {}) {
    if (this.isMissionActive()) return;
    const wasOpen = this.isDeckOpen();
    this.deckVerb = verb;
    this.deckOpenedFromPanel = opts.fromPanel ?? false;
    const search = document.getElementById('deck-search') as HTMLInputElement | null;
    if (!wasOpen) {
      // One modal at a time; labels restore on close (deferring to surface
      // view / the labels setting).
      this.closeMenuPanel();
      this.closeSurfaceTargetMenu();
      this.setWorldLabelsVisible(false);
      if (search) search.value = '';
    }
    this.refreshDeck();
    if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) search?.focus();
  }

  private closeDeck() {
    if (!this.isDeckOpen()) return;
    this.deckVerb = null;
    this.deckOpenedFromPanel = false;
    // Blur before hiding: a focused-but-hidden search would keep swallowing
    // flight keys (the key handler bails on INPUT targets).
    (document.getElementById('deck-search') as HTMLInputElement | null)?.blur();
    document.getElementById('deck')?.classList.remove('visible');
    document.getElementById('deck-backdrop')?.classList.remove('visible');
    this.setWorldLabelsVisible(true);
    this.updateClusterOnStates();
  }

  /** Cluster button / key: close on the same verb, else open or switch to it. */
  private toggleDeck(verb: DeckVerb) {
    if (this.deckVerb === verb) {
      this.closeDeck();
    } else if (this.isDeckOpen()) {
      // A different errand, not a vantage change — drop the from-panel flag.
      this.deckOpenedFromPanel = false;
      this.switchDeckTab(verb);
    } else {
      this.openDeck(verb);
    }
  }

  /** In-deck tab switch: keeps the query and the from-panel flag. */
  private switchDeckTab(verb: DeckVerb) {
    if (!this.isDeckOpen() || this.deckVerb === verb) return;
    this.deckVerb = verb;
    this.refreshDeck();
  }

  /** Telescope chip / O: landed with the deck closed it toggles this sky's
   * panel; otherwise it's the deck's Observatory tab. */
  private observatoryAction() {
    if (!this.isDeckOpen() && this.landedOn) {
      this.toggleObservatoryPanel();
      return;
    }
    this.toggleDeck('observe');
  }

  /** Deck chrome + rows + filter, for the current verb. */
  private refreshDeck() {
    const open = this.isDeckOpen();
    document.getElementById('deck')?.classList.toggle('visible', open);
    document.getElementById('deck-backdrop')?.classList.toggle('visible', open);
    if (!open) return;
    const tabs: Array<[string, DeckVerb]> = [
      ['deck-tab-observe', 'observe'],
      ['deck-tab-travel', 'travel'],
      ['deck-tab-pilot', 'pilot'],
    ];
    for (const [id, verb] of tabs) {
      document.getElementById(id)?.classList.toggle('on', this.deckVerb === verb);
    }
    const pref = document.getElementById('deck-pref');
    if (pref) pref.style.display = this.deckVerb === 'observe' ? '' : 'none';
    document.getElementById('deck-pref-toggle')?.classList.toggle('on', this.effectiveSkyPref());
    this.updateClusterOnStates();
    this.buildDeckList();
    this.filterDeckList();
    // Landed on the Observatory tab with no query: bring your own row into
    // view (Carme sits below thirty Jupiter rows; an off-screen HERE pill is
    // no affordance at all).
    const query = (document.getElementById('deck-search') as HTMLInputElement | null)?.value ?? '';
    if (this.deckVerb === 'observe' && this.landedOn && !query.trim()) {
      this.revealDeckRow(this.landedOn.name);
    }
  }

  /** Accent states for the three cluster chips (`.on` = their tab is open;
   * the telescope also lights while the panel is open — same instrument). */
  private updateClusterOnStates() {
    document.getElementById('planetarium-btn-observatory')?.classList.toggle(
      'on',
      this.deckVerb === 'observe' || this.observatoryPanel.isOpen(),
    );
    document.getElementById('planetarium-btn-travel')?.classList.toggle('on', this.deckVerb === 'travel');
    document.getElementById('planetarium-btn-autopilot')?.classList.toggle('on', this.deckVerb === 'pilot');
  }

  private buildDeckList() {
    const list = document.getElementById('deck-list');
    const verb = this.deckVerb;
    if (!list || !verb) return;
    list.innerHTML = '';
    this.deckHl = -1;
    for (const group of groupDeckBodies(PLANETARIUM_BODIES, MOONS)) {
      list.appendChild(this.makeDeckRow(
        { type: 'planet', name: group.planet.name },
        group.planet.color,
        group.planet.description.split('.')[0],
      ));
      for (const moon of group.moons) {
        list.appendChild(this.makeDeckRow(
          { type: 'moon', name: moon.name, parentPlanet: moon.parentPlanet },
          moon.color,
          null,
        ));
      }
    }
    const empty = document.createElement('div');
    empty.className = 'pk-empty';
    empty.textContent = 'No bodies match.';
    list.appendChild(empty);
  }

  private makeDeckRow(target: NonNullable<LandedTarget>, color: number, detail: string | null): HTMLElement {
    const isMoon = target.type === 'moon';
    const here = this.landedOn?.type === target.type && this.landedOn.name === target.name;
    const row = document.createElement('div');
    row.className = `pk-row ${isMoon ? 'pk-moon' : 'pk-planet'}${here ? ' here' : ''}`;
    row.dataset.name = target.name;
    if (target.type === 'moon') row.dataset.parent = target.parentPlanet;
    const css = `#${color.toString(16).padStart(6, '0')}`;
    const dot = document.createElement('span');
    dot.className = 'pk-dot';
    dot.style.background = isMoon
      ? css
      : `radial-gradient(circle at 35% 30%, ${mixHex(color, 0xf4f7ff, 0.35)}, ${css} 60%, ${mixHex(color, 0x04060b, 0.45)})`;
    row.appendChild(dot);
    const info = document.createElement('span');
    info.className = 'pk-info';
    info.innerHTML = `<b>${target.name}</b>` + (detail ? `<small>${detail}</small>` : '');
    row.appendChild(info);
    if (here) {
      const tag = document.createElement('span');
      tag.className = 'pk-tag-here';
      tag.textContent = 'here';
      row.appendChild(tag);
    }
    row.addEventListener('click', () => this.commitDeckPick(target));
    return row;
  }

  private filterDeckList() {
    const list = document.getElementById('deck-list');
    if (!list) return;
    const query = (document.getElementById('deck-search') as HTMLInputElement | null)?.value ?? '';
    const rows = Array.from(list.querySelectorAll<HTMLElement>('.pk-row'));
    const keep = filterDeckRows(query, rows.map((row): DeckRow => ({
      name: row.dataset.name ?? '',
      parent: row.dataset.parent,
    })));
    let anyVisible = false;
    rows.forEach((row, i) => {
      row.style.display = keep[i] ? '' : 'none';
      if (keep[i]) anyVisible = true;
    });
    const empty = list.querySelector<HTMLElement>('.pk-empty');
    if (empty) empty.style.display = anyVisible ? 'none' : 'block';
    for (const row of list.querySelectorAll('.pk-row.hl')) row.classList.remove('hl');
    this.deckHl = -1;
  }

  private deckVisibleRows(list: HTMLElement): HTMLElement[] {
    return Array.from(list.querySelectorAll<HTMLElement>('.pk-row')).filter(
      (row) => row.style.display !== 'none',
    );
  }

  private moveDeckHighlight(dir: 1 | -1) {
    const list = document.getElementById('deck-list');
    if (!list) return;
    const rows = this.deckVisibleRows(list);
    if (!rows.length) return;
    const i = Math.max(0, Math.min(rows.length - 1, this.deckHl + dir));
    for (const row of list.querySelectorAll('.pk-row.hl')) row.classList.remove('hl');
    rows[i].classList.add('hl');
    this.deckHl = i;
    const row = rows[i];
    const overshoot = row.offsetTop + row.offsetHeight - (list.scrollTop + list.clientHeight);
    if (overshoot > 0) list.scrollTop += overshoot + 6;
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop - 6;
  }

  /** Enter commits the highlighted row, or the first visible one. */
  private commitDeckHighlight() {
    const list = document.getElementById('deck-list');
    if (!list) return;
    const rows = this.deckVisibleRows(list);
    const row = (this.deckHl >= 0 ? rows[this.deckHl] : rows[0]) ?? null;
    if (!row?.dataset.name) return;
    const parent = row.dataset.parent;
    this.commitDeckPick(
      parent
        ? { type: 'moon', name: row.dataset.name, parentPlanet: parent }
        : { type: 'planet', name: row.dataset.name },
    );
  }

  private findDeckRow(name: string): HTMLElement | null {
    const list = document.getElementById('deck-list');
    if (!list) return null;
    return (
      Array.from(list.querySelectorAll<HTMLElement>('.pk-row')).find(
        (r) => r.dataset.name === name,
      ) ?? null
    );
  }

  private revealDeckRow(name: string) {
    const list = document.getElementById('deck-list');
    const row = this.findDeckRow(name);
    // 64px clears the sticky system header pinned above the row.
    if (list && row) list.scrollTop = Math.max(0, row.offsetTop - 64);
  }

  /** Every deck commit closes the deck; the tab decides the ride. */
  private commitDeckPick(target: NonNullable<LandedTarget>) {
    if (this.isMissionActive()) return;
    const verb = this.deckVerb;
    if (!verb) return;
    const fromPanel = this.deckOpenedFromPanel;
    this.closeDeck();
    const sameBody = this.landedOn?.type === target.type && this.landedOn.name === target.name;
    if (verb === 'observe') {
      this.commitObservePick(target, sameBody, fromPanel);
      return;
    }
    if (sameBody) {
      // Your own row on Travel/Autopilot: lift off and park nearby.
      this.exitLandedMode();
      return;
    }
    if (verb === 'travel') {
      this.arriveThen(target, () => {
        if (this.landedOn) this.exitLandedMode();
        if (target.type === 'moon') {
          const moon = MOONS.find((m) => m.name === target.name);
          if (moon) this.jumpToMoon(moon);
        } else {
          const body = PLANETARIUM_BODIES.find((b) => b.name === target.name);
          if (body) this.jumpToPlanet(body);
        }
      });
      return;
    }
    if (this.landedOn) this.exitLandedMode();
    this.engageAutopilot(target);
  }

  /**
   * Hide/restore the planet+moon label layers around a modal. Restoring
   * defers to the surface view and to the labels setting when one of them
   * owns the hidden state (their skipped label pipeline would never re-hide
   * stale labels a modal-close revealed).
   */
  private setWorldLabelsVisible(visible: boolean) {
    if (visible && (this.landedView === 'surface' || !this.showBodyLabels)) return;
    const planetLabelsEl = document.getElementById('planet-labels');
    const moonLabelsEl = this.moonLabelContainer;
    if (planetLabelsEl) planetLabelsEl.style.display = visible ? '' : 'none';
    if (moonLabelsEl) moonLabelsEl.style.display = visible ? '' : 'none';
  }

  /** Apply the "Planet labels" setting: drop the HTML label layers and the
   *  in-scene marker sprites (the per-frame pipeline is gated off, so nothing
   *  re-shows them); re-showing defers to surface view, which owns its own
   *  label hiding. */
  private applyBodyLabelVisibility() {
    if (this.showBodyLabels) {
      this.setWorldLabelsVisible(true);
    } else {
      this.setWorldLabelsVisible(false);
      this.planetLabels?.hideAll();
    }
  }

  /**
   * Observe-tab commit: land on (or re-land to) the body; the arrival
   * preference and its overrides decide whether the panel opens. The panel
   * opens here, at the pick site only — enterLandedMode itself never
   * auto-opens it (restore/proximity/Land & Orbit stay as-is).
   */
  private commitObservePick(target: NonNullable<LandedTarget>, sameBody: boolean, fromPanel: boolean) {
    const action = observeArrivalAction({
      sameBody,
      skyPref: this.effectiveSkyPref(),
      companionless: target.type === 'planet' && getMoonsByPlanet(target.name).length === 0,
      fromPanel,
    });
    if (action === 'reopen') {
      if (!this.observatoryPanel.isOpen()) this.openObservatoryPanel();
      return;
    }
    // Excursion entry: the deck grabs the ship out of cruise — remember the
    // pose so Leave puts it back exactly. Capture it NOW, synchronously: the
    // ship keeps moving while a cold system paints behind the veil, so a stash
    // taken inside the deferred closure would be a couple frames downrange.
    // Manual/proximity landings and Land & Orbit keep the classic takeoff.
    const excursionStash = this.landedOn
      ? null
      : {
          posX: this.player.posX, posY: this.player.posY, posZ: this.player.posZ,
          heading: this.player.heading, pitch: this.player.pitch,
          speedMultiplier: this.player.speedMultiplier,
          systemSpeedMultiplier: this.player.systemSpeedMultiplier,
          inSystemMode: this.inSystemMode,
          moving: this.player.moving,
        };
    // Teleport behind the arrival veil if the destination isn't painted yet;
    // the panel decision applies after the landing so it reads the new subject.
    this.arriveThen(target, () => {
      if (this.landedOn) {
        // Re-land without the exit/enter ceremony. A live surface view would
        // keep a stale cross-system target — tear it down first.
        if (this.landedView === 'surface') this.exitSurfaceView(true);
        this.applyLandedTarget(target);
        this.notification.show(`Standing on ${target.name}`);
      } else {
        this.observatoryExcursion = excursionStash;
        this.enterLandedMode(target);
      }
      if (action === 'land-open') {
        this.openObservatoryPanel();
      } else {
        // Quiet arrival: the sky panel stays tucked into the telescope chip —
        // pulse the chip so the hand-off reads.
        this.closeObservatoryPanel();
        this.pulseObservatoryChip();
      }
    });
  }

  private async startHistoricJourney(missionId: HistoricMissionId) {
    // A mission takes the session over: a live tutorial restores first,
    // synchronously, so rememberPreMissionState below stashes the real
    // pre-tutorial journey instead of a staged showcase scene.
    if (this.tutorial) this.stopTutorial({ restore: true, sync: true });
    const journey = HISTORIC_JOURNEYS[missionId];
    await this.player.ensureProfileLoaded(journey.shipProfile);
    // The await yields, and the stop above re-enabled the ☰ Tutorial item —
    // a tutorial can have started during the profile fetch. Stop that one too
    // before the mission stashes state.
    if (this.tutorial) this.stopTutorial({ restore: true, sync: true });
    // Missions own the ship from here: drop the excursion return pose BEFORE
    // exiting landed mode, so the pre-mission stash captures the classic
    // takeoff state rather than a mid-air teleport back to cruise.
    this.observatoryExcursion = null;
    this.rememberPreMissionState();
    if (this.landedOn) this.exitLandedMode();
    this.activeHistoricJourney = journey;
    this.historicPanelDismissed = false;
    this.showShip = true;
    this.player.group.visible = true;
    this.player.setProfile(journey.shipProfile);
    const shipLabel = document.getElementById('settings-ship-label');
    if (shipLabel) shipLabel.textContent = 'On';
    this.closeMenuPanel();
    this.collapseHistoricJourneyMenu();
    this.updateMissionControlState();
    this.showHistoricMilestone(0);
    this.notification.show(journey.readyNotification);
  }

  private stopHistoricJourney(restorePreviousState = true) {
    this.activeHistoricJourney = null;
    this.historicMilestoneIndex = 0;
    this.historicPanelDismissed = false;
    this.scriptedTransfer = null;
    this.player.setProfile('default');
    this.setHistoricPanelVisible(false);
    if (restorePreviousState) this.restorePreMissionState();
    else {
      this.preMissionState = null;
      this.preMissionMenuVisible = false;
    }
    this.updateMissionControlState();
  }

  private updateHistoricPanel(
    journey: HistoricJourney,
    milestone: HistoricMilestone,
    stepIndex: number,
  ) {
    setText('historic-kicker', journey.label);
    setText('historic-step', `${stepIndex + 1} / ${journey.milestones.length}`);
    setText('historic-title', milestone.title);
    setText('historic-date', milestone.dateLabel);
    setText('historic-description', milestone.description);
    setText('historic-note', milestone.note);

    this.updateHistoricImage(
      milestone,
      document.getElementById('historic-image') as HTMLImageElement | null,
      document.getElementById('historic-image-link') as HTMLAnchorElement | null,
      document.getElementById('historic-image-caption'),
      document.getElementById('historic-image-credit'),
    );

    const prevBtn = document.getElementById('historic-prev') as HTMLButtonElement | null;
    const nextBtn = document.getElementById('historic-next') as HTMLButtonElement | null;
    if (prevBtn) prevBtn.disabled = stepIndex === 0;
    if (nextBtn) nextBtn.disabled = stepIndex === journey.milestones.length - 1;
  }

  private showHistoricMilestone(index: number) {
    const journey = this.activeHistoricJourney;
    if (!journey) return;
    const nextIndex = THREE.MathUtils.clamp(index, 0, journey.milestones.length - 1);
    this.historicMilestoneIndex = nextIndex;
    this.historicPanelDismissed = false;
    const milestone = journey.milestones[nextIndex];
    this.applyHistoricMilestone(milestone);
    this.setHistoricPanelVisible(true);
    this.updateHistoricPanel(journey, milestone, nextIndex);
  }

  private updateHistoricImage(
    milestone: HistoricMilestone,
    imageEl: HTMLImageElement | null,
    imageLinkEl: HTMLAnchorElement | null,
    imageCaptionEl: HTMLElement | null,
    imageCreditEl: HTMLElement | null,
  ) {
    if (!imageEl) return;

    const applyMeta = (
      alt: string,
      credit: string,
      sourceLabel: string,
      sourceUrl?: string,
    ) => {
      imageEl.alt = alt;
      if (imageCaptionEl) imageCaptionEl.textContent = alt;
      if (imageCreditEl) imageCreditEl.textContent = credit;
      if (imageLinkEl) {
        imageLinkEl.textContent = sourceLabel;
        if (sourceUrl) {
          imageLinkEl.href = sourceUrl;
          imageLinkEl.style.display = '';
        } else {
          imageLinkEl.removeAttribute('href');
          imageLinkEl.style.display = 'none';
        }
      }
    };

    imageEl.onerror = null;
    applyMeta(
      milestone.imageAlt,
      milestone.imageCredit,
      milestone.imageSourceLabel,
      milestone.imageSourceUrl,
    );
    imageEl.onerror = () => {
      imageEl.onerror = null;
      imageEl.src = milestone.fallbackImageUrl;
      applyMeta(
        milestone.fallbackImageAlt,
        milestone.fallbackImageCredit,
        milestone.fallbackImageSourceLabel,
        milestone.fallbackImageSourceUrl,
      );
    };
    imageEl.src = milestone.imageUrl;
  }

  private applyHistoricMilestone(milestone: HistoricMilestone) {
    this.timeState.currentUtcMs = milestone.dateUtcMs;
    this.timeState.paused = true;
    this.rebuildPlanetPositions();
    this.updateTimeUI();

    const destination = this.getHistoricDestination(milestone);
    if (!destination) return;

    this.player.speedMultiplier = 0.15;
    this.updateSpeedSlider();
    this.startScriptedTransfer({ ...destination, movingAfter: false });
  }

  private vectorFromCoords(
    coords: { x: number; y: number; z: number } | undefined,
    fallback: THREE.Vector3,
  ): THREE.Vector3 {
    if (!coords) return fallback.clone();
    return new THREE.Vector3(coords.x, coords.y, coords.z);
  }

  private getHistoricDestination(milestone: HistoricMilestone) {
    if (milestone.customScenePosition || milestone.target === 'Interstellar' || milestone.target === 'Custom') {
      if (this.landedOn) this.exitLandedMode();
      const coords = milestone.customScenePosition ?? INTERSTELLAR_SCENE_POSITION;
      return {
        targetPosition: new THREE.Vector3(coords.x, coords.y, coords.z),
        lookTarget: this.vectorFromCoords(milestone.customLookTarget, new THREE.Vector3(0, 0, 0)),
      };
    }

    const body = PLANETARIUM_BODIES.find((planet) => planet.name === milestone.target);
    if (!body) return null;

    const destination = this.getJumpDestination(body, milestone.viewDistanceMultiplier ?? 1);
    if (!destination) return null;

    return {
      targetPosition: destination.position,
      lookTarget: destination.lookTarget,
    };
  }

  private startScriptedTransfer(options: {
    targetPosition: THREE.Vector3;
    lookTarget: THREE.Vector3;
    movingAfter: boolean;
  }) {
    const dx = options.lookTarget.x - options.targetPosition.x;
    const dy = options.lookTarget.y - options.targetPosition.y;
    const dz = options.lookTarget.z - options.targetPosition.z;
    const horizontal = Math.sqrt(dx * dx + dz * dz);
    const startHeading = this.player.heading;
    let endHeading = Math.atan2(dz, dx);
    // Shortest-path heading lerp: pick the equivalent endHeading within ±π of start
    // so we never sweep the long way around when crossing the ±π branch cut.
    const dh = endHeading - startHeading;
    if (dh > Math.PI) endHeading -= 2 * Math.PI;
    else if (dh < -Math.PI) endHeading += 2 * Math.PI;
    this.scriptedTransfer = {
      elapsed: 0,
      duration: 1.15,
      startPos: new THREE.Vector3(this.player.posX, this.player.posY, this.player.posZ),
      endPos: options.targetPosition.clone(),
      startHeading,
      endHeading,
      startPitch: this.player.pitch,
      endPitch: Math.atan2(dy, Math.max(horizontal, 1e-8)),
      endMoving: options.movingAfter,
    };
    this.player.moving = true;
    this.userOrbiting = false;
  }

  private updateScriptedTransfer(dt: number): boolean {
    if (!this.scriptedTransfer) return false;

    const transfer = this.scriptedTransfer;
    transfer.elapsed = Math.min(transfer.elapsed + dt, transfer.duration);
    const t = transfer.elapsed / transfer.duration;
    const ease = smoothstepUnclamped(t);

    this.player.posX = THREE.MathUtils.lerp(transfer.startPos.x, transfer.endPos.x, ease);
    this.player.posY = THREE.MathUtils.lerp(transfer.startPos.y, transfer.endPos.y, ease);
    this.player.posZ = THREE.MathUtils.lerp(transfer.startPos.z, transfer.endPos.z, ease);
    this.player.heading = THREE.MathUtils.lerp(transfer.startHeading, transfer.endHeading, ease);
    this.player.pitch = THREE.MathUtils.lerp(transfer.startPitch, transfer.endPitch, ease);

    if (t >= 1) {
      this.player.moving = transfer.endMoving;
      this.scriptedTransfer = null;
    }

    return true;
  }

  private pointTowardMercury() {
    const mercuryPos = this.planetWorldPositions.get('Mercury');
    if (mercuryPos) {
      this.player.headToward(mercuryPos.x, mercuryPos.z, mercuryPos.y);
      this.resetCruiseCamera();
    }
  }

  private resetCruiseCamera() {
    const camDist = PlanetariumMode.CRUISE_CAM_DIST_AU;
    const forward = this.player.getForwardDirection();
    this.camera.position.set(
      -forward.x * camDist,
      -forward.y * camDist + camDist * 0.45,
      -forward.z * camDist,
    );
    this.controls.target.set(0, 0, 0);
  }

  private getPlanetCollisionRadius(radiusAU: number, renderedScale: number): number {
    return radiusAU * Math.max(renderedScale, 1) + PlanetariumMode.SHIP_CLEARANCE_AU;
  }

  private getJumpDestination(planet: PlanetData, distanceMultiplier = 1) {
    const pos = this.planetWorldPositions.get(planet.name);
    if (!pos) return null;

    const viewDist = Math.max(
      planet.radiusAU * 8,
      this.getPlanetCollisionRadius(planet.radiusAU, this.planetScale) + planet.radiusAU * 2,
      0.001,
    ) * distanceMultiplier;
    const offsetDir = new THREE.Vector3(-pos.x, -pos.y, -pos.z);
    if (offsetDir.lengthSq() < 1e-8) {
      offsetDir.set(-1, 0.25, 0);
    }
    offsetDir.normalize();

    return {
      position: new THREE.Vector3(
        pos.x + offsetDir.x * viewDist,
        pos.y + offsetDir.y * viewDist,
        pos.z + offsetDir.z * viewDist,
      ),
      lookTarget: new THREE.Vector3(pos.x, pos.y, pos.z),
    };
  }

  /** The governor/collision body set: every visible painted moon (world
   *  positions refresh each frame in updateMoonPositions; entries read here
   *  are ≤1 frame stale — irrelevant at km scale) plus the jump seed, whose
   *  position resolves live from the parent + ephemeris offset while its
   *  mesh is still veiled. Rendered radii come from the live mesh scale
   *  (the 5%-of-parent floor), i.e. the sphere you actually see. */
  private forEachGovernedMoon(cb: (x: number, y: number, z: number, renderedRAU: number) => void) {
    for (const moons of this.planetMoons.values()) {
      for (const m of moons) {
        if (!m.painted || !m.mesh.visible) continue;
        if (this.governedMoonSeed && m.data.name === this.governedMoonSeed.name) {
          this.governedMoonSeed = null; // the visible mesh covers it from here
        }
        const wp = this.moonWorldPositions.get(m.data.name);
        if (!wp) continue;
        cb(wp.x, wp.y, wp.z, m.data.radiusAU * m.mesh.scale.x);
      }
    }
    const seed = this.governedMoonSeed;
    if (!seed) return;
    const moon = MOONS.find((mn) => mn.name === seed.name);
    const parent = PLANETARIUM_BODIES.find((b) => b.name === seed.parentPlanet);
    const parentPos = this.planetWorldPositions.get(seed.parentPlanet);
    if (!moon || !parent || !parentPos) return;
    const offset = this.getMoonWorldOffsetAU(moon, parent, this.tmpMoonOffset);
    cb(
      parentPos.x + offset.x,
      parentPos.y + offset.y,
      parentPos.z + offset.z,
      Math.max(moon.radiusAU, parent.radiusAU * PlanetariumMode.MOON_MIN_RENDER_RATIO),
    );
  }

  private computeMoonSpeedCap(): number {
    const f = this.player.getForwardDirection();
    let cap = Infinity;
    this.forEachGovernedMoon((x, y, z, renderedR) => {
      const dx = x - this.player.posX;
      const dy = y - this.player.posY;
      const dz = z - this.player.posZ;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < 1e-12) return;
      const cos = (dx * f.x + dy * f.y + dz * f.z) / dist;
      const c = governedSpeedCap(
        Math.max(dist - renderedR, 0),
        cos,
        MOON_APPROACH_K_PER_S,
        MOON_APPROACH_V_MIN_AU_S,
      );
      if (c < cap) cap = c;
    });
    return cap;
  }

  /** Moon counterpart of resolvePlanetCollisions, with one difference: it
   *  sweeps the whole frame segment (prevPlayerPos → current) instead of
   *  checking the endpoint — endpoint checks tunnel exactly at moon scale. */
  private resolveMoonCollisions() {
    const p0 = this.prevPlayerPos;
    const forward = this.player.getForwardDirection();
    this.forEachGovernedMoon((x, y, z, renderedR) => {
      // Full lunar-scale clearance would exceed a tiny moon's own standoff,
      // so it saturates at one rendered radius.
      const collisionR = renderedR + Math.min(PlanetariumMode.SHIP_CLEARANCE_AU, renderedR);
      const dx = this.player.posX - p0.x;
      const dy = this.player.posY - p0.y;
      const dz = this.player.posZ - p0.z;
      const cx = x - p0.x;
      const cy = y - p0.y;
      const cz = z - p0.z;
      const segLenSq = dx * dx + dy * dy + dz * dz;
      const t = segLenSq > 0 ? Math.min(1, Math.max(0, (cx * dx + cy * dy + cz * dz) / segLenSq)) : 0;
      let ox = p0.x + dx * t - x;
      let oy = p0.y + dy * t - y;
      let oz = p0.z + dz * t - z;
      let d = Math.sqrt(ox * ox + oy * oy + oz * oz);
      if (d >= collisionR) return;
      if (d < 1e-9) {
        // Dead-center pass: push back along the incoming segment.
        ox = -dx;
        oy = -dy;
        oz = -dz;
        d = Math.sqrt(ox * ox + oy * oy + oz * oz);
        if (d < 1e-9) {
          ox = 1;
          oy = 0;
          oz = 0;
          d = 1;
        }
      }
      ox /= d;
      oy /= d;
      oz /= d;
      this.player.posX = x + ox * collisionR;
      this.player.posY = y + oy * collisionR;
      this.player.posZ = z + oz * collisionR;
      if (forward.x * ox + forward.y * oy + forward.z * oz < 0.15) {
        this.player.headToward(
          this.player.posX + ox * collisionR * 2,
          this.player.posZ + oz * collisionR * 2,
          this.player.posY + oy * collisionR * 2,
        );
      }
    });
  }

  private resolvePlanetCollisions() {
    if (!this.solarSystem) return;

    const offset = new THREE.Vector3();
    const outwardHeading = new THREE.Vector3();
    const forward = this.player.getForwardDirection();

    for (const planet of this.solarSystem.planets) {
      const worldPos = planet.group.userData.worldPosAU as { x: number; y: number; z: number } | undefined;
      if (!worldPos) continue;

      offset.set(
        this.player.posX - worldPos.x,
        this.player.posY - worldPos.y,
        this.player.posZ - worldPos.z,
      );

      let distance = offset.length();
      const collisionRadius = this.getPlanetCollisionRadius(planet.data.radiusAU, planet.group.scale.x);
      if (distance >= collisionRadius) continue;

      if (distance < 1e-8) {
        offset.copy(forward).multiplyScalar(-1);
        distance = offset.length();
      }
      if (distance < 1e-8) {
        offset.set(1, 0, 0);
        distance = 1;
      }

      offset.divideScalar(distance);
      this.player.posX = worldPos.x + offset.x * collisionRadius;
      this.player.posY = worldPos.y + offset.y * collisionRadius;
      this.player.posZ = worldPos.z + offset.z * collisionRadius;

      if (forward.dot(offset) < 0.15) {
        outwardHeading.copy(offset).multiplyScalar(collisionRadius * 2);
        this.player.headToward(
          this.player.posX + outwardHeading.x,
          this.player.posZ + outwardHeading.z,
          this.player.posY + outwardHeading.y,
        );
      }

    }
  }

  jumpToPlanet(planet: PlanetData, options: { notify?: boolean; distanceMultiplier?: number } = {}) {
    if (this.isMissionActive()) return;
    const destination = this.getJumpDestination(planet, options.distanceMultiplier ?? 1);
    if (!destination) return;
    this.applyJumpDestination(destination, planet.name, options.notify !== false);
  }

  jumpToMoon(moon: MoonData, options: { notify?: boolean } = {}) {
    if (this.isMissionActive()) return;
    const destination = this.getMoonJumpDestination(moon);
    if (!destination) return;
    this.applyJumpDestination(destination, moon.name, options.notify !== false);
    // Seed the governor before the first frame: in a cold system the mesh is
    // still unpainted behind the arrival veil, invisible to the
    // visibility-keyed governed set, and one ungoverned 100 ms frame at the
    // in-system default would cross the whole standoff.
    this.governedMoonSeed = { name: moon.name, parentPlanet: moon.parentPlanet };
  }

  private applyJumpDestination(
    destination: { position: THREE.Vector3; lookTarget: THREE.Vector3 },
    bodyName: string,
    notify: boolean,
  ) {
    this.player.posX = destination.position.x;
    this.player.posY = destination.position.y;
    this.player.posZ = destination.position.z;
    this.player.headToward(destination.lookTarget.x, destination.lookTarget.z, destination.lookTarget.y);

    // A teleport always arrives under way. Parking is a caller decision (dev
    // framing, tutorial freeze-frames), never the arrival default — a park
    // left set here outlives the jump and freezes every later arrival too.
    this.player.moving = true;

    // A teleport is a discontinuity: a tight cap eased down at the previous
    // moon must not ramp-limit the arrival scene's first seconds.
    this.moonCapEased = Infinity;

    // Don't touch cruise speedMultiplier — the system throttle automatically
    // slows the player near the planet. Just ensure cruise is at least 1c
    // so they can leave the system.
    if (this.player.speedMultiplier < PlayerShip.SPEED_DEFAULT) {
      this.player.speedMultiplier = PlayerShip.SPEED_DEFAULT;
    }
    // Cap system speed for safe approach
    if (this.player.systemSpeedMultiplier > PlayerShip.SYSTEM_SPEED_DEFAULT) {
      this.player.systemSpeedMultiplier = PlayerShip.SYSTEM_SPEED_DEFAULT;
    }
    this.updateSpeedSlider();

    if (notify) {
      this.notification.show(`Jumped to ${bodyName}`);
    }
    this.resetCruiseCamera();
  }

  /**
   * Arrival pose for a moon-precise jump. The position derives live from the
   * parent's world position plus the ephemeris offset — never from
   * `moonWorldPositions`, which is only written for visible painted moons and
   * silently falls back to the parent across the rest of the catalog. The
   * rendered size comes from the catalog plus the 5%-of-parent mesh floor,
   * not the live mesh (scale is still 1 in never-visited systems). The pose
   * math itself — apparent-size standoff, sun-side/outward placement, flyby
   * aim — lives in arrivalLogic.moonArrivalPose (pure, catalog-swept in its
   * tests); the lookTarget is the flyby aim point, not the moon's center.
   */
  private getMoonJumpDestination(moon: MoonData) {
    const parentBody = PLANETARIUM_BODIES.find((b) => b.name === moon.parentPlanet);
    const parentPosRaw = this.planetWorldPositions.get(moon.parentPlanet);
    if (!parentBody || !parentPosRaw) return null;
    const parentPos = new THREE.Vector3(parentPosRaw.x, parentPosRaw.y, parentPosRaw.z);
    const offset = this.getMoonWorldOffsetAU(moon, parentBody, new THREE.Vector3());
    const parentCollision = this.getPlanetCollisionRadius(parentBody.radiusAU, this.planetScale);
    const ring = RING_CONFIGS[parentBody.name];
    const pose = moonArrivalPose({
      moonPos: offset.clone().add(parentPos),
      parentPos,
      orbitR: offset.length(),
      renderedR: Math.max(moon.radiusAU, parentBody.radiusAU * PlanetariumMode.MOON_MIN_RENDER_RATIO),
      parentCollision,
      // Rings render as a flat disc, but a spherical clearance is simpler and
      // never lets an arrival pop in among the ring particles.
      parentClearance: Math.max(
        parentCollision * 1.25,
        ring ? parentBody.radiusAU * ring.outerFactor * 1.05 : 0,
      ),
      camDist: PlanetariumMode.CRUISE_CAM_DIST_AU,
      shipClearance: PlanetariumMode.SHIP_CLEARANCE_AU,
    });
    return { position: pose.position, lookTarget: pose.aimPoint };
  }

  /**
   * Headless-screenshot support: pose the camera at a planet by name, with no
   * "Jumped to…" toast. Installed on `window.__moon` by the entry point under
   * Vite dev only. Returns false when the name isn't a top-level planet.
   */
  devJumpToBody(name: string, distanceMultiplier = 1): boolean {
    if (!this.solarSystem) return false;
    const mesh = this.solarSystem.planets.find((p) => p.data.name === name);
    if (!mesh) return false;
    this.jumpToPlanet(mesh.data, { notify: false, distanceMultiplier });
    this.player.moving = false; // hold position so the body stays centered for capture
    return true;
  }

  /** Names of the top-level planets, for the dev screenshot harness. */
  devListBodies(): string[] {
    return this.solarSystem ? this.solarSystem.planets.map((p) => p.data.name) : [];
  }

  /**
   * Headless-screenshot support: hide the spacecraft, orbit lines, body labels,
   * and the HTML HUD so a capture shows only the sky and the framed body. Pass
   * true to restore. Dev bridge only.
   */
  devSetChrome(visible: boolean): void {
    this.showShip = visible;
    this.showOrbitLines = visible;
    this.showBodyLabels = visible;
    this.player.group.visible = visible;
    if (this.solarSystem) {
      for (const o of this.solarSystem.orbitLines) o.visible = visible;
    }
    if (!visible) this.planetLabels?.hideAll();
    // HTML overlays that sit outside the per-frame visibility loop: the HUD,
    // the wordmark header, and the Sun/distance label container.
    for (const id of ['planetarium-ui', 'top-bar', 'planet-labels']) {
      const el = document.getElementById(id);
      if (el) el.style.display = visible ? '' : 'none';
    }
  }

  /** Headless-screenshot support: set the planetarium camera FOV (degrees) to zoom. */
  devSetFov(deg: number): void {
    const cam = this.camera as THREE.PerspectiveCamera;
    cam.fov = deg;
    cam.updateProjectionMatrix();
  }

  /**
   * Headless-screenshot support: frame a planet centered, filling `fillFraction`
   * of the vertical view. Sits a few radii out, points at it, halts, and skips
   * collision so the close vantage holds. `phaseAngleDeg` is the Sun–planet–camera
   * angle: 0 sits sunward (full-phase lit); swing toward 180 for the night side,
   * the only view where the back-lit crescent (warm terminator + Mie forward
   * scatter) shows. Dev bridge only.
   */
  devFrameBody(name: string, fillFraction = 0.6, phaseAngleDeg = 0): boolean {
    if (!this.solarSystem) return false;
    // Resolve a top-level planet or, failing that, a moon (parent world position
    // plus the same offset the renderer uses) so the harness can frame either.
    let pos: { x: number; y: number; z: number } | undefined;
    let r = 0;
    const planet = this.solarSystem.planets.find((p) => p.data.name === name);
    if (planet) {
      pos = this.planetWorldPositions.get(name);
      r = planet.data.radiusAU; // planets render at true scale (group scale 1)
    } else {
      for (const [parentName, moons] of this.planetMoons) {
        const moon = moons.find((mm) => mm.data.name === name);
        if (!moon) continue;
        const parentPos = this.planetWorldPositions.get(parentName);
        if (parentPos) {
          const off = computeMoonOffsetEquatorialAU(name, parentName, this.timeState.currentUtcMs, this.tmpMoonOffset);
          pos = { x: parentPos.x + off.x, y: parentPos.y + off.y, z: parentPos.z + off.z };
          r = moon.data.radiusAU;
        }
        break;
      }
    }
    if (!pos || r === 0) return false;
    this.devFreeCamera = true;
    const dist = r * 5;
    // Camera direction from the planet, rotated off the sun line by the phase
    // angle. The rotation axis is any vector perpendicular to the sun line.
    const toSun = new THREE.Vector3(-pos.x, -pos.y, -pos.z);
    if (toSun.lengthSq() < 1e-8) toSun.set(-1, 0.25, 0);
    toSun.normalize();
    const axis = new THREE.Vector3(0, 1, 0).cross(toSun);
    if (axis.lengthSq() < 1e-6) axis.set(1, 0, 0); // sun line parallel to world up
    axis.normalize();
    const dir = toSun.clone().applyAxisAngle(axis, THREE.MathUtils.degToRad(phaseAngleDeg));
    this.player.posX = pos.x + dir.x * dist;
    this.player.posY = pos.y + dir.y * dist;
    this.player.posZ = pos.z + dir.z * dist;
    this.player.headToward(pos.x, pos.z, pos.y);
    this.player.moving = false;
    // Aim the camera straight at the body from the scene origin. The chase cam's
    // ship-scale offset and downward tilt would shove a zoomed planet off-frame.
    const sceneOffset = new THREE.Vector3(
      pos.x - this.player.posX,
      pos.y - this.player.posY,
      pos.z - this.player.posZ,
    );
    const cam = this.camera as THREE.PerspectiveCamera;
    cam.position.set(0, 0, 0);
    cam.fov = THREE.MathUtils.radToDeg((2 * Math.atan(r / dist)) / fillFraction);
    cam.updateProjectionMatrix();
    cam.lookAt(sceneOffset);
    this.controls.target.copy(sceneOffset);
    return true;
  }

  /** Headless-screenshot diagnostics: read back camera/body geometry. */
  devProbe(name: string): unknown {
    let pos = this.planetWorldPositions.get(name) ?? null;
    const mesh = this.solarSystem?.planets.find((p) => p.data.name === name);
    let radiusAU = mesh?.data.radiusAU ?? null;
    let parentAbs: { x: number; y: number; z: number } | null = null;
    if (!pos) {
      // Moons resolve live from the parent + the ephemeris seam — the same
      // derivation the moon-precise jump uses, so its QA can read distances.
      const moon = MOONS.find((m) => m.name === name);
      const parentBody = moon ? PLANETARIUM_BODIES.find((b) => b.name === moon.parentPlanet) : null;
      const parentPos = moon ? this.planetWorldPositions.get(moon.parentPlanet) : null;
      if (moon && parentBody && parentPos) {
        const offset = this.getMoonWorldOffsetAU(moon, parentBody, new THREE.Vector3());
        pos = { x: parentPos.x + offset.x, y: parentPos.y + offset.y, z: parentPos.z + offset.z };
        radiusAU = moon.radiusAU;
        parentAbs = parentPos;
      }
    }
    const cam = this.camera as THREE.PerspectiveCamera;
    const playerAbs = { x: this.player.posX, y: this.player.posY, z: this.player.posZ };
    return {
      found: !!pos,
      radiusAU,
      bodyAbs: pos,
      parentAbs,
      playerAbs,
      distToBodyAU: pos ? Math.hypot(playerAbs.x - pos.x, playerAbs.y - pos.y, playerAbs.z - pos.z) : null,
      distToParentAU: parentAbs
        ? Math.hypot(playerAbs.x - parentAbs.x, playerAbs.y - parentAbs.y, playerAbs.z - parentAbs.z)
        : null,
      camPos: { x: cam.position.x, y: cam.position.y, z: cam.position.z },
      camLen: Math.hypot(cam.position.x, cam.position.y, cam.position.z),
      fov: cam.fov,
      moving: this.player.moving,
      devFree: this.devFreeCamera,
      userOrbiting: this.userOrbiting,
    };
  }

  /**
   * Headless support: land on a body via the real landing path (routes through
   * enterLandedMode → applyLandedTarget, unlike devFrameBody). Resolves a
   * top-level planet, else a moon by name (with its parent). Dev bridge only.
   */
  devLand(name: string): boolean {
    if (!this.solarSystem) return false;
    if (this.solarSystem.planets.some((p) => p.data.name === name)) {
      this.enterLandedMode({ type: 'planet', name });
      return true;
    }
    for (const [parentName, moons] of this.planetMoons) {
      if (moons.some((m) => m.data.name === name)) {
        this.enterLandedMode({ type: 'moon', name, parentPlanet: parentName });
        return true;
      }
    }
    return false;
  }

  /** Headless support: enter the Observatory surface view ("Look up"). */
  devLookUp(): boolean {
    if (!this.landedOn) return false;
    this.enterSurfaceView();
    return true;
  }

  /** Headless support: leave the surface view (immediate, no ease). */
  devExitSurface(): void {
    this.exitSurfaceView(true);
  }

  /** Headless support: pick a Look-at target by name ("Io", "Sun", "Jupiter"). */
  devLookAt(name: string): boolean {
    if (!this.landedOn) return false;
    const wanted = name.replace(/^the /i, '').toLowerCase();
    const choice = this.buildSurfaceTargetChoices().find(
      (c) => c.name.replace(/^the /, '').toLowerCase() === wanted,
    );
    if (!choice) return false;
    this.pickSurfaceTarget(choice.target);
    return true;
  }

  /** Headless support: open the Observatory panel + start its upcoming-events
   *  search (the per-frame work that loads when landed — for lag profiling). */
  devOpenObservatory(): boolean {
    if (!this.landedOn) return false;
    this.bottomBar.closeStats();
    this.observatoryPanel.show();
    this.renderObservatoryPanel();
    this.startObservatoryEventSearch();
    return true;
  }

  /** Headless support: trigger the Observatory vantage swap ("Stand on …"). */
  devSwapVantage(): boolean {
    if (!this.landedOn || !this.swapCompanionTarget()) return false;
    this.swapLandedVantage();
    return true;
  }

  /** Headless support: jump to the prev/next Observatory event of a kind. */
  devJumpEvent(type: EventType, direction: 1 | -1 = 1): boolean {
    if (!this.landedOn) return false;
    this.handleObservatoryJump(type, direction);
    return true;
  }

  /**
   * Headless diagnostics for the landed/Observatory state: the subject's
   * on-screen fill fraction is the number the swap-shrink bug moves. In orbit
   * view the subject is the landed body at scene origin; in surface view it's
   * the tracked target measured from the surface vantage.
   */
  devProbeLanded(): unknown {
    const cam = this.camera as THREE.PerspectiveCamera;
    const camLen = cam.position.length();
    let subjectName = '';
    let subjectAngularDeg = 0;
    if (this.landedView === 'surface' && this.surfaceTarget) {
      subjectName = JSON.stringify(this.surfaceTarget);
      subjectAngularDeg = this.surfaceTargetAngularDiameterDeg(this.surfaceTarget);
    } else if (this.landedOn) {
      subjectName = this.landedOn.name;
      const r = this.getLandedBodyRenderedRadiusAU();
      subjectAngularDeg = (2 * Math.atan(r / Math.max(camLen, 1e-12)) * 180) / Math.PI;
    }
    return {
      landedOn: this.landedOn ? { type: this.landedOn.type, name: this.landedOn.name } : null,
      view: this.landedView,
      fov: cam.fov,
      surfaceFovDeg: this.surfaceFovDeg,
      camLenAU: camLen,
      subjectName,
      subjectAngularDeg,
      subjectFillFraction: cam.fov > 0 ? subjectAngularDeg / cam.fov : 0,
    };
  }

  devTutorialStart(): boolean {
    this.startTutorial();
    return this.tutorial !== null;
  }

  devTutorialNext(): void {
    this.advanceTutorial();
  }

  devTutorialBack(): void {
    this.backTutorial();
  }

  devTutorialSkip(): void {
    this.stopTutorial({ restore: true, toast: 'skip' });
  }

  /** One flat snapshot of everything the headless QA walk asserts per stop. */
  devTutorialState(): unknown {
    const tutorial = this.tutorial;
    return {
      active: tutorial !== null,
      stepId: tutorial ? TUTORIAL_STEPS[tutorial.stepIndex].id : null,
      stepIndex: tutorial?.stepIndex ?? -1,
      phase: tutorial?.phase ?? null,
      totalityReached: tutorial?.totalityReached ?? false,
      arrivalInFlight: this.arrivalInFlight,
      veilCovering:
        document.getElementById('arrival-veil')?.classList.contains('covering') ?? false,
      landedOn: this.landedOn?.name ?? null,
      surface: this.landedView === 'surface',
      panelOpen: this.observatoryPanel.isOpen(),
      rate: this.timeState.rate,
      paused: this.timeState.paused,
      timeMs: this.timeState.currentUtcMs,
    };
  }

  /** The landed system's parent planet name, or null when not landed. */
  private observatoryParentPlanetName(): string | null {
    if (!this.landedOn) return null;
    return this.landedOn.type === 'planet' ? this.landedOn.name : this.landedOn.parentPlanet;
  }

  private updateObservatoryButtonVisibility() {
    const button = document.getElementById('planetarium-btn-observatory');
    if (!button) return;
    const missionActive = this.isMissionActive();
    button.style.display = missionActive ? 'none' : '';
    // The panel is a landed-state surface: takeoff closes it (every landed
    // body is a subject — moonless ones get the Quiet-sky variant). The deck
    // is legal in any state but missions own the ship.
    if (missionActive || !this.landedOn) this.closeObservatoryPanel();
    if (missionActive) {
      this.closeDeck();
      this.closeSurfaceTargetMenu();
    }
  }

  private closeObservatoryPanel() {
    this.observatoryPanel.hide();
    this.cancelObservatoryEventSearch();
    this.updateClusterOnStates();
  }

  /** The one panel-open sequence (idempotent): one instrument at a time —
   *  the Stats card yields — then render, kick the upcoming-events search,
   *  and light the cluster chip. */
  private openObservatoryPanel() {
    this.bottomBar.closeStats();
    this.observatoryPanel.show();
    this.renderObservatoryPanel();
    this.startObservatoryEventSearch();
    this.updateClusterOnStates();
  }

  /** Brief pulse on the Observatory chip — the visible hand-off when the panel
   *  is tucked away (the Stats card taking the single instrument slot). */
  private pulseObservatoryChip() {
    const chip = document.getElementById('planetarium-btn-observatory');
    if (!chip) return;
    chip.classList.remove('handoff');
    void chip.offsetWidth; // restart the keyframe if a pulse is mid-flight
    chip.classList.add('handoff');
  }

  private toggleObservatoryPanel() {
    if (this.observatoryPanel.isOpen()) {
      this.closeObservatoryPanel();
    } else {
      this.openObservatoryPanel();
    }
  }

  private toggleSurfaceView() {
    if (this.landedView === 'surface') {
      this.exitSurfaceView();
      return;
    }
    // Second click while the picker is up reads as "never mind".
    if (this.surfaceTargetMenu.isOpen()) {
      this.closeSurfaceTargetMenu();
      return;
    }
    if (this.lookupOpensMenu()) {
      this.openSurfaceTargetMenu();
      return;
    }
    // A live event always outranks the remembered pick — "Look up" during an
    // eclipse must show the eclipse (the no-arg path derives that target).
    const pick = this.relevantObservatoryEvent() ? null : this.surfacePickedTarget;
    if (pick) this.enterSurfaceView(pick, 'companion');
    else this.enterSurfaceView();
  }

  /**
   * Will "Look up" ask what to look at first? Only where the default answer
   * is arbitrary: a generic planet's no-event target is the Sun while its
   * moons — the system's actual show — sit unlisted. Earth (→ the Moon) and
   * moon vantages (→ the parent) have obvious defaults and enter directly,
   * as do live events and a landing that already picked.
   */
  private lookupOpensMenu(): boolean {
    return (
      this.landedView !== 'surface' &&
      this.landedOn?.type === 'planet' &&
      this.landedOn.name !== 'Earth' &&
      getMoonsByPlanet(this.landedOn.name).length > 0 &&
      !this.relevantObservatoryEvent() &&
      this.surfacePickedTarget === null
    );
  }

  /** All pickable sky targets from the current vantage, menu-ordered. */
  private buildSurfaceTargetChoices(): SurfaceTargetChoice[] {
    const landedInfo = this.surfaceLandedInfo();
    if (!landedInfo) return [];
    const choices: SurfaceTargetChoice[] = [];
    const add = (target: SurfaceTarget, name: string, color: number) =>
      choices.push(
        makeSurfaceTargetChoice(target, name, this.surfaceTargetAngularDiameterDeg(target), color),
      );
    if (landedInfo.type === 'moon' && landedInfo.parentPlanet) {
      add(
        { kind: 'parent' },
        landedInfo.parentPlanet,
        PLANETARIUM_BODIES.find((b) => b.name === landedInfo.parentPlanet)?.color ?? 0xffffff,
      );
    }
    // The Sun has no catalog row color (it's never a travel target) — warm glint.
    add({ kind: 'sun' }, 'the Sun', 0xffd580);
    const parentName = this.observatoryParentPlanetName();
    for (const m of this.planetMoons.get(parentName ?? '') ?? []) {
      if (m.data.name === landedInfo.name) continue; // never the ground underfoot
      add({ kind: 'moon', moonName: m.data.name }, bodyDisplayName(m.data.name), m.data.color);
    }
    return orderSurfaceTargetChoices(choices);
  }

  /** Cheap row count for gating the ⌖ chip — no positions computed. Both
   *  vantage types sum the same: on a planet it's the Sun + the moons; on a
   *  moon the parent replaces yourself in that count. */
  private surfaceTargetChoiceCount(): number {
    if (!this.landedOn) return 0;
    return 1 + getMoonsByPlanet(this.observatoryParentPlanetName() ?? '').length;
  }

  private openSurfaceTargetMenu() {
    const choices = this.buildSurfaceTargetChoices();
    if (choices.length === 0 || !this.landedOn) return;
    // One modal at a time, extended to the picker.
    this.closeMenuPanel();
    this.closeDeck();
    const inView = this.landedView === 'surface';
    this.setWorldLabelsVisible(false);
    this.surfaceTargetMenu.open(
      choices,
      inView ? surfaceTargetKey(this.surfaceTarget) : null,
      inView
        ? 'Pick a target — the view swings to it.'
        : `Pick a target — you’ll look up from ${bodyDisplayName(this.landedOn.name)}.`,
    );
  }

  private closeSurfaceTargetMenu() {
    // The menu's own close handler restores label visibility (self-gated).
    this.surfaceTargetMenu.close();
  }

  /** Menu pick: remember it for this landing and point the view at it. */
  private pickSurfaceTarget(target: SurfaceTarget) {
    this.surfacePickedTarget = target;
    this.enterSurfaceView(target, 'companion');
  }

  private renderObservatoryPanel() {
    if (!this.observatoryPanel.isOpen() || !this.landedOn) return;
    const subject = this.buildObservatorySubject();
    if (!subject) return;
    const extras: ObservatoryRenderExtras = {
      vantageName: `From ${bodyDisplayName(this.landedOn.name)}`,
      vantageBody: this.landedOn.name,
      swapName: this.swapCompanionTarget()?.name ?? null,
      nowTag: this.observatoryNowTag(),
      surfaceActive: this.landedView === 'surface',
      lookupOpensMenu: this.lookupOpensMenu(),
      nextDates: this.observatoryNextDates(),
    };
    this.observatoryPanel.render(this.timeState.currentUtcMs, subject, extras);
  }

  /** The phase hero's subject, with disc data read from the rendered scene objects. */
  private buildObservatorySubject(): ObservatorySubjectInfo | null {
    if (!this.landedOn) return null;
    const parentName = this.observatoryParentPlanetName()!;
    if (parentName === 'Earth') {
      const subject = this.landedOn.type === 'moon' ? ('Earth' as const) : ('Moon' as const);
      const target: SurfaceTarget =
        subject === 'Moon' ? { kind: 'moon', moonName: 'Moon' } : { kind: 'parent' };
      const pos = this.resolveSurfaceTargetScenePos(target, this.tmpSurfaceTargetPos);
      const distAU = pos ? pos.length() : 0;
      return {
        kind: 'earth',
        subject,
        angularDiameterDeg: angularDiameterDeg(this.surfaceTargetRadiusAU(target), distAU),
        distanceKm: distAU * KM_PER_AU,
      };
    }
    if (this.landedOn.type === 'moon') {
      const pos = this.resolveSurfaceTargetScenePos({ kind: 'parent' }, this.tmpSurfaceTargetPos);
      const distAU = pos ? pos.length() : 0;
      return {
        kind: 'moon-phase',
        parentName,
        moonName: this.landedOn.name,
        illumination: this.computeParentIllumination(parentName, this.landedOn.name),
        waxing: this.isParentWaxing(parentName, this.landedOn.name),
        angularDiameterDeg: angularDiameterDeg(this.surfaceTargetRadiusAU({ kind: 'parent' }), distAU),
        distanceKm: distAU * KM_PER_AU,
      };
    }
    if (getMoonsByPlanet(parentName).length === 0) {
      const body = PLANETARIUM_BODIES.find((b) => b.name === parentName);
      return {
        kind: 'companionless',
        planetName: parentName,
        tintCss: body ? `#${body.color.toString(16).padStart(6, '0')}` : '#5b6377',
      };
    }
    return { kind: 'events-only', parentName };
  }

  /** Is the parent's lit fraction (seen from the moon) increasing? Glyph side. */
  private isParentWaxing(parentName: string, moonName: string): boolean {
    const body = PLANETARIUM_BODIES.find(b => b.name === parentName);
    if (!body) return true;
    const illuminationAt = (utcMs: number) => {
      const parentPos = computeBodyPositionAU(body, utcMs);
      const offset = computeMoonOffsetEquatorialAU(moonName, parentName, utcMs, this.tmpSurfaceVantage);
      const d = parentPos.length() * offset.length();
      if (d === 0) return 0.5;
      return (1 - parentPos.dot(offset) / d) / 2;
    };
    const now = this.timeState.currentUtcMs;
    return illuminationAt(now + 3_600_000) >= illuminationAt(now);
  }

  private observatoryNowTag(): string {
    return formatTimeRateLabel(this.timeState.rate, this.timeState.paused).toLowerCase();
  }

  /**
   * Earth finder metas: full/new via findEvent (cached until stale or
   * crossed), eclipse rows reuse the chunked upcoming-search results.
   */
  private observatoryNextDates(): { full: string; new: string; lunar: string; solar: string } | null {
    if (this.observatoryParentPlanetName() !== 'Earth') return null;
    const now = this.timeState.currentUtcMs;
    const cache = this.observatoryNextDatesCache;
    // Stale on drift, on any backward move (a short back-jump can put a
    // closer event in front of the cached one), or once the cached event is
    // crossed. The +60s search epsilon keeps a parked-at syzygy from
    // re-reporting itself as "next".
    const stale =
      !cache ||
      now < cache.computedAtUtcMs ||
      now - cache.computedAtUtcMs > 6 * 3_600_000 ||
      (cache.fullMs !== null && now > cache.fullMs) ||
      (cache.newMs !== null && now > cache.newMs);
    if (stale) {
      const from = new Date(now + 60_000);
      this.observatoryNextDatesCache = {
        computedAtUtcMs: now,
        fullMs: findEvent('full-moon', from, 1)?.getTime() ?? null,
        newMs: findEvent('new-moon', from, 1)?.getTime() ?? null,
      };
    }
    const fresh = this.observatoryNextDatesCache!;
    const searchActive = this.observatoryEventSearch !== null;
    const dateMeta = (ms: number | null) => (ms ? `next · ${formatDateCompact(ms)}` : '');
    // Eclipse rows reuse the single-result upcoming search, which reports an
    // in-progress event — label that case "now" instead of a parked-at date.
    const eclipseMeta = (event: ShadowEvent | undefined) => {
      if (!event) return searchActive ? '· · ·' : '';
      if (now >= event.startUtcMs && now <= event.endUtcMs) return 'happening now';
      return `next · ${formatDateCompact(event.peakUtcMs)}`;
    };
    return {
      full: dateMeta(fresh.fullMs),
      new: dateMeta(fresh.newMs),
      lunar: eclipseMeta(this.observatoryEventResults.get('eclipse|Moon')),
      solar: eclipseMeta(this.observatoryEventResults.get('shadow-transit|Moon')),
    };
  }

  /** The last jumped-to event while the clock sits inside its (padded) window. */
  private relevantObservatoryEvent(): ShadowEvent | null {
    const event = this.lastObservatoryEvent;
    if (!event) return null;
    if (event.spec.parentPlanet !== this.observatoryParentPlanetName()) return null;
    const now = this.timeState.currentUtcMs;
    const padMs = 3_600_000;
    if (now < event.startUtcMs - padMs || now > event.endUtcMs + padMs) return null;
    return event;
  }

  private surfaceTargetDisplayName(target: SurfaceTarget): string {
    switch (target.kind) {
      case 'sun':
      case 'sun-from-spot':
        return 'the Sun';
      case 'parent':
        return this.landedOn?.type === 'moon' ? this.landedOn.parentPlanet : 'the planet';
      case 'moon':
        return bodyDisplayName(target.moonName);
    }
  }

  /**
   * Present-tense one-liner for what the surface observer sees of the event.
   * Pure observer/event relationship (surfaceView.ts) — never derived from
   * the camera target, which the vantage swap and free look re-point.
   */
  private surfaceNarrative(spec: ShadowEventSpec): string {
    const landed = this.surfaceLandedInfo();
    return landed ? surfaceEventNarrative(landed, spec) : '';
  }

  /** Warm countdown for the HUD subline — always relative to the engine's peak/contacts. */
  private static peakCountdown(nowUtcMs: number, event: ShadowEvent): string | null {
    const fmt = (ms: number) => {
      const minutes = Math.max(1, Math.round(ms / 60_000));
      if (minutes < 60) return `${minutes}m`;
      const hours = Math.floor(minutes / 60);
      return `${hours}h ${minutes % 60}m`;
    };
    if (nowUtcMs < event.startUtcMs) return `starts in ${fmt(event.startUtcMs - nowUtcMs)}`;
    if (nowUtcMs < event.peakUtcMs) return `peak in ${fmt(event.peakUtcMs - nowUtcMs)}`;
    if (nowUtcMs <= event.endUtcMs) return `ends in ${fmt(event.endUtcMs - nowUtcMs)}`;
    return null;
  }

  /** 8 Hz surface-HUD text pass (headline, narrative, when-line, FOV, disc note). */
  private renderSurfaceHud() {
    if (!this.landedOn || this.landedView !== 'surface') return;
    const now = this.timeState.currentUtcMs;
    const event = this.relevantObservatoryEvent();
    let headline: string;
    let subText: string;
    let subWarm: string | null = null;
    if (event) {
      headline = PlanetariumMode.shadowEventLabel(event.spec);
      subText = this.surfaceNarrative(event.spec);
      // "What you'll see": without it, an honest penumbral
      // dimming reads as nothing-happened while you watch.
      const hint = this.eventExpectation(event);
      if (hint) subText += ` — ${hint}`;
      subWarm = PlanetariumMode.peakCountdown(now, event);
    } else {
      const subject = this.buildObservatorySubject();
      const phase = subject ? observatoryPhaseText(now, subject) : null;
      headline = phase?.headline ?? `${this.landedOn.name} sky`;
      subText = phase?.meta ?? '';
    }

    let discNote: string | null = null;
    const fmtDeg = formatDiscDeg;
    const targetPos = this.resolveSurfaceTargetScenePos(this.surfaceTarget, this.tmpSurfaceTargetPos);
    if (targetPos) {
      const targetDeg = angularDiameterDeg(
        this.surfaceTargetRadiusAU(this.surfaceTarget),
        targetPos.distanceTo(this.camera.position),
      );
      const baseName = this.surfaceTargetDisplayName(this.surfaceTarget).replace(/^the /, '');
      discNote = `${baseName} ∅ ${fmtDeg(targetDeg)}°`;
      // Honesty caption while the reticle is up: say why there is no disc,
      // and whether tightening the zoom would produce one. ("Resolve" — a
      // borderline target can still render a few marginal pixels.)
      if (this.surfaceMarkerKind === 'reticle') {
        const canvasH = this.renderer.domElement.clientHeight;
        const resolvesAtMaxZoom =
          projectedDiscPx(targetDeg, SURFACE_FOV_MIN_DEG, canvasH) >= MARKER_BRACKETS_MIN_PX;
        discNote += resolvesAtMaxZoom
          ? ' · zoom in to resolve'
          : ' · too small to resolve at any zoom';
      }
      if (this.surfaceTarget.kind === 'sun-from-spot') {
        const parentName = this.observatoryParentPlanetName();
        const occluder = this.planetMoons
          .get(parentName ?? '')
          ?.find(m => m.data.name === (this.surfaceTarget as { occluderMoonName: string }).occluderMoonName);
        const systemGroup = this.moonSystemGroups.get(parentName ?? '');
        if (occluder && systemGroup) {
          const moonDeg = angularDiameterDeg(
            occluder.data.radiusAU,
            this.tmpSurfaceAxis
              .copy(systemGroup.position)
              .add(occluder.mesh.position)
              .distanceTo(this.camera.position),
          );
          discNote += ` · ${occluder.data.name} ∅ ${fmtDeg(moonDeg)}°`;
          if (event && now >= event.startUtcMs && now <= event.endUtcMs) discNote += ' · transiting';
        }
      }
    }

    const companion = this.swapCompanionTarget();
    const state: SurfaceHudState = {
      eyebrow: `Surface view · standing on ${bodyDisplayName(this.landedOn.name)}`,
      headline,
      subText,
      subWarm,
      whenText: formatObservatoryClock(now),
      whenTag: this.observatoryNowTag(),
      paused: this.timeState.paused,
      fovDeg: this.camera.fov,
      tracking: this.surfaceTracking,
      targetName: this.surfaceTargetDisplayName(this.surfaceTarget),
      showLookatChip: this.surfaceTargetChoiceCount() >= 2,
      discNote,
      swapLabel: companion ? `Stand on ${bodyDisplayName(companion.name)}` : null,
    };
    this.observatoryHud.render(state);
  }

  /**
   * Illuminated fraction of the parent planet's disc as seen from one of its
   * moons: (1 + cos θ)/2 with θ the Sun–parent–moon angle, from the same
   * position set the renderer draws (heliocentric parent, seam moon offset).
   */
  private computeParentIllumination(parentName: string, moonName: string): number {
    const parentPos = this.planetWorldPositions.get(parentName);
    const parentBody = PLANETARIUM_BODIES.find(b => b.name === parentName);
    const moonMesh = this.planetMoons.get(parentName)?.find(m => m.data.name === moonName);
    if (!parentPos || !parentBody || !moonMesh) return 0.5;
    const offset = this.getMoonWorldOffsetAU(moonMesh.data, parentBody, this.tmpMoonOffset);
    const parentDist = Math.hypot(parentPos.x, parentPos.y, parentPos.z);
    const offsetLen = offset.length();
    if (parentDist === 0 || offsetLen === 0) return 0.5;
    const cosTheta =
      -(parentPos.x * offset.x + parentPos.y * offset.y + parentPos.z * offset.z) /
      (parentDist * offsetLen);
    return (1 + cosTheta) / 2;
  }

  private static shadowSpecKey(spec: ShadowEventSpec): string {
    return `${spec.kind}|${spec.moonName}`;
  }

  /** Event title — reads like an event, not engineer notation. */
  private static shadowEventLabel(spec: ShadowEventSpec): string {
    if (spec.parentPlanet === 'Earth' && spec.moonName === 'Moon') {
      return spec.kind === 'eclipse' ? 'Lunar Eclipse' : 'Solar Eclipse';
    }
    return spec.kind === 'eclipse'
      ? `${spec.moonName} eclipsed by ${spec.parentPlanet}`
      : `${spec.moonName}'s shadow crosses ${spec.parentPlanet}`;
  }

  /**
   * Magnitude shown only where it reads sanely: Earth's eclipses ("mag 1.10").
   * A tiny moon deep in Jupiter's umbra produces meaningless four-digit
   * immersion magnitudes — generic systems keep the classification badge only.
   */
  private static eventMagnitudeText(event: ShadowEvent): string | null {
    if (event.spec.parentPlanet !== 'Earth' || event.spec.kind !== 'eclipse') return null;
    const magnitude =
      event.classification === 'annular' ? event.antumbralMagnitude
      : event.classification === 'penumbral' ? event.penumbralMagnitude
      : event.umbralMagnitude;
    return magnitude !== undefined ? `mag ${magnitude.toFixed(2)}` : null;
  }

  /** Jump toast: date first, then narration + classification + what-you'll-see. */
  private describeShadowEvent(event: ShadowEvent): string {
    const spec = event.spec;
    const narration =
      spec.parentPlanet === 'Earth' && spec.moonName === 'Moon'
        ? PlanetariumMode.shadowEventLabel(spec)
        : spec.kind === 'eclipse'
          ? `${spec.moonName} is eclipsed by ${spec.parentPlanet}`
          : `${spec.moonName}'s shadow is crossing ${spec.parentPlanet}`;
    let text = `${formatUtcLabel(event.peakUtcMs)} — ${narration} · ${event.classification}`;
    const magnitudeText = PlanetariumMode.eventMagnitudeText(event);
    if (magnitudeText) text += ` (${magnitudeText})`;
    const hint = this.eventExpectation(event);
    if (hint) text += ` · ${hint}`;
    return text;
  }

  /** Observer-conditioned "what you'll see" for an event, '' off-surface. */
  private eventExpectation(event: ShadowEvent): string {
    const landed = this.surfaceLandedInfo();
    return landed ? surfaceEventExpectation(landed, event.spec, event.classification) : '';
  }

  /**
   * Restart the chunked upcoming-events search from the current clock.
   * Open/jump/date-set restarts clear the old results (the clock may have
   * moved anywhere); the expiry path keeps still-valid rows on screen and
   * only drops completed ones, so the list never blanks mid-watch while the
   * sweep re-fills (fresh finds overwrite per spec key as they arrive).
   */
  private startObservatoryEventSearch(opts?: { preserveValidResults?: boolean }) {
    const parentPlanet = this.observatoryParentPlanetName();
    if (!parentPlanet || !this.observatoryPanel.isOpen()) {
      this.cancelObservatoryEventSearch();
      return;
    }
    if (opts?.preserveValidResults) {
      const now = this.timeState.currentUtcMs;
      for (const [key, event] of this.observatoryEventResults) {
        if (event.endUtcMs <= now) this.observatoryEventResults.delete(key);
      }
    } else {
      this.observatoryEventResults.clear();
    }
    const specs = listShadowEventSpecs(parentPlanet);
    // A moonless system has no shadow events to search — publish the empty
    // list instead of ticking a zero-spec search every frame.
    if (specs.length === 0) {
      this.observatoryEventSearch = null;
      this.publishObservatoryEvents();
      return;
    }
    this.observatoryEventSearch = {
      parentPlanet,
      specs,
      index: 0,
      resumeCursorUtcMs: null,
      fromUtcMs: this.timeState.currentUtcMs,
    };
    this.publishObservatoryEvents();
  }

  private cancelObservatoryEventSearch() {
    this.observatoryEventSearch = null;
    this.observatoryEventResults.clear();
    this.observatoryRowsMinEndUtcMs = null;
  }

  /**
   * With the clock running (jumps park at T−3 min, 1×), displayed events
   * complete on their own: once `now` crosses the earliest displayed end,
   * restart the chunked search so the list and the Earth eclipse metas roll
   * forward — preserving still-valid rows so the list never blanks. Cheap
   * 8 Hz check; never fires while a search is in flight (which also bounds
   * the restart churn at absurd time rates to one sweep per completion).
   */
  private invalidateExpiredObservatoryEvents() {
    if (!this.observatoryPanel.isOpen() || this.observatoryEventSearch) return;
    const minEnd = this.observatoryRowsMinEndUtcMs;
    if (minEnd === null || this.timeState.currentUtcMs <= minEnd) return;
    this.startObservatoryEventSearch({ preserveValidResults: true });
  }

  /**
   * Run a slice of the upcoming-events search (called every landed frame).
   * Each (moon, kind) spec is searched once; `searchShadowEvent` pauses itself
   * at the frame budget and resumes from the returned cursor next frame, so a
   * full-system sweep (Saturn: 36 specs) never blocks the main thread.
   */
  private pumpObservatoryEventSearch() {
    const search = this.observatoryEventSearch;
    if (!search) return;
    if (!this.observatoryPanel.isOpen()) {
      this.cancelObservatoryEventSearch();
      return;
    }
    const deadlineMs = performance.now() + PlanetariumMode.OBSERVATORY_SEARCH_FRAME_BUDGET_MS;
    let listChanged = false;
    while (search.index < search.specs.length) {
      const remainingMs = deadlineMs - performance.now();
      if (remainingMs <= 0) break;
      const spec = search.specs[search.index];
      const result = searchShadowEvent(spec, search.resumeCursorUtcMs ?? search.fromUtcMs, 1, {
        timeBudgetMs: remainingMs,
        // Anchor the horizon at the original start so resumed slices can't
        // slide the search window forward forever.
        searchOriginUtcMs: search.fromUtcMs,
      });
      if (result.status === 'paused') {
        search.resumeCursorUtcMs = result.cursorUtcMs;
        break;
      }
      if (result.status === 'found') {
        this.observatoryEventResults.set(PlanetariumMode.shadowSpecKey(spec), result.event);
        listChanged = true;
      }
      search.index++;
      search.resumeCursorUtcMs = null;
    }
    const done = search.index >= search.specs.length;
    if (listChanged || done) this.publishObservatoryEvents();
    if (done) this.observatoryEventSearch = null;
  }

  /** Push the current result set (sorted, capped) + search status into the panel. */
  private publishObservatoryEvents() {
    const search = this.observatoryEventSearch;
    const events = [...this.observatoryEventResults.values()]
      .sort((a, b) => a.peakUtcMs - b.peakUtcMs)
      .slice(0, PlanetariumMode.OBSERVATORY_EVENTS_MAX_ROWS);
    const landedInfo = this.surfaceLandedInfo();
    const rows: ObservatoryEventRow[] = events.map(e => {
      // ∅ of the body this event is *watched* on from here — the surface-
      // target table decides which body that is (a transit seen from the
      // parent means watching the Sun; your own eclipse likewise — so
      // self-event rows never read as specks). Measured at the CURRENT
      // clock, accepted: sibling distances can swing by peak time, but the
      // jump republishes and the badge answers "from here, now".
      const discDeg = landedInfo
        ? this.surfaceTargetAngularDiameterDeg(selectSurfaceTarget(landedInfo, e.spec))
        : 0;
      return {
        event: e,
        label: PlanetariumMode.shadowEventLabel(e.spec),
        classification: e.classification,
        hint: this.eventExpectation(e),
        magnitudeText: PlanetariumMode.eventMagnitudeText(e),
        discDeg,
        speck: isBelowResolutionAtMaxZoom(discDeg),
      };
    });
    this.observatoryRowsMinEndUtcMs = events.length
      ? events.reduce((min, e) => Math.min(min, e.endUtcMs), Infinity)
      : null;
    // Sheet-form panel height follows the row count — the chevron's cached
    // clamp rect must re-measure.
    this.panelRectCache = null;
    const status = search && search.index < search.specs.length
      ? `Scanning ${search.index + 1}/${search.specs.length}…`
      : rows.length === 0 ? 'No events in range' : '';
    this.observatoryPanel.setEvents(rows, status, this.timeState.currentUtcMs);
  }

  private jumpToShadowEvent(event: ShadowEvent) {
    // A jump moves the clock — every ∅ the open picker baked is now wrong.
    this.closeSurfaceTargetMenu();
    this.lastObservatoryEvent = event;
    // Park shortly before the peak with the clock running at 1× real time —
    // the user watches the event happen instead of landing on a frozen peak.
    this.timeState = { ...this.timeState, rate: 1, paused: false };
    this.setCurrentUtcMs(event.peakUtcMs - OBSERVATORY_JUMP_LEAD_MS);
    this.observatoryPanel.flashNowBar();
    if (this.landedView === 'surface') {
      // Surface view active: re-point it at the event's observer-level target
      // instead of orbit-framing (jumps never auto-enter the surface view).
      // The clock just moved, so refresh the scene graph before the re-entry
      // fits its FOV off the (otherwise stale) target geometry.
      this.refreshLandedScene();
      const landedInfo = this.surfaceLandedInfo();
      if (landedInfo) this.enterSurfaceView(selectSurfaceTarget(landedInfo, event.spec), 'event');
    } else {
      this.frameObservatoryEvent(event.spec);
    }
    // Sheet form: a jump parks the sheet at peek — the framed event clears
    // the sheet and the peek's now-bar shows when you are. The bottom time
    // pill is hidden while the sheet is open.
    this.observatoryPanel.collapseSheetToPeek();
    this.renderObservatoryPanel();
    this.startObservatoryEventSearch();
    this.notification.show(this.describeShadowEvent(event));
  }

  private static shadowSpecsEqual(a: ShadowEventSpec, b: ShadowEventSpec): boolean {
    return a.kind === b.kind && a.parentPlanet === b.parentPlanet && a.moonName === b.moonName;
  }

  private handleObservatoryJump(type: EventType, direction: 1 | -1) {
    // Same clock-move staleness as the shadow jumps (which close it again).
    this.closeSurfaceTargetMenu();
    if (type === 'lunar-eclipse' || type === 'solar-eclipse') {
      // Eclipse jumps run on the shadow engine: it lands on the true peak
      // (not the syzygy instant) and knows the classification for the toast.
      const spec: ShadowEventSpec = {
        kind: type === 'lunar-eclipse' ? 'eclipse' : 'shadow-transit',
        parentPlanet: 'Earth',
        moonName: 'Moon',
      };
      // The clock sits inside the last jumped-to event (parked at T−lead,
      // running) — a plain search from now would re-find it forever.
      const last = this.lastObservatoryEvent;
      const parked = last && PlanetariumMode.shadowSpecsEqual(last.spec, spec) ? last : null;
      const fromUtcMs = stepperSearchFromUtcMs(parked, this.timeState.currentUtcMs, direction);
      const event = findShadowEvent(spec, fromUtcMs, direction);
      if (!event) {
        this.notification.show('No event found within the search range');
        return;
      }
      this.jumpToShadowEvent(event);
      return;
    }

    const lastPhase = this.lastPhaseJump;
    const parkedPhase =
      lastPhase && lastPhase.type === type
        ? { startUtcMs: lastPhase.utcMs, peakUtcMs: lastPhase.utcMs, endUtcMs: lastPhase.utcMs }
        : null;
    const fromUtcMs = stepperSearchFromUtcMs(parkedPhase, this.timeState.currentUtcMs, direction);
    const found = findEvent(type, new Date(fromUtcMs), direction);
    if (!found) {
      this.notification.show('No event found within the search range');
      return;
    }
    this.lastPhaseJump = { type, utcMs: found.getTime() };
    // Same park-and-watch policy as the shadow jumps.
    this.timeState = { ...this.timeState, rate: 1, paused: false };
    this.setCurrentUtcMs(found.getTime() - OBSERVATORY_JUMP_LEAD_MS);
    this.observatoryPanel.flashNowBar();
    if (this.landedView === 'surface') {
      // Phase jumps point the surface view at the companion (the Moon you
      // just made full), never at an event geometry. The clock moved, so
      // refresh the scene graph before the re-entry fits its FOV.
      this.refreshLandedScene();
      const landedInfo = this.surfaceLandedInfo();
      if (landedInfo) this.enterSurfaceView(selectSurfaceTarget(landedInfo, null), 'companion');
    } else {
      this.frameObservatoryEvent();
    }
    // Same sheet-to-peek policy as the shadow jumps.
    this.observatoryPanel.collapseSheetToPeek();
    this.renderObservatoryPanel();
    this.startObservatoryEventSearch();
    // Toast leads with the date — after a jump, *when* is the headline.
    this.notification.show(`${formatUtcLabel(found.getTime())} — ${OBSERVATORY_EVENT_LABELS[type]}`);
  }

  /**
   * Swing the landed orbit camera so the event's companion body sits in frame
   * next to the landed body — which stays at scene origin: the involved moon
   * when watching from the planet, the parent when watching your own event
   * from that moon, the sibling moon when watching another moon's event. A
   * side nudge keeps the landed body's limb from occluding the companion;
   * auto-rotate is stopped so the framed event doesn't drift.
   */
  private frameObservatoryEvent(spec?: ShadowEventSpec) {
    // Moonless systems bail on the moonMesh lookup below — no companion to frame.
    if (!this.landedOn) return;
    const parentName = this.observatoryParentPlanetName()!;
    const parentBody = PLANETARIUM_BODIES.find(b => b.name === parentName);
    const moonName = spec?.moonName ?? 'Moon';
    const moonMesh = this.planetMoons.get(parentName)?.find(m => m.data.name === moonName);
    if (!parentBody || !moonMesh) return;

    // Direction from the landed body toward the companion, in world AU.
    const dir = this.getMoonWorldOffsetAU(moonMesh.data, parentBody, new THREE.Vector3());
    if (this.landedOn.type === 'moon') {
      if (this.landedOn.name === moonName) {
        dir.negate();
      } else {
        const ownMesh = this.planetMoons.get(parentName)?.find(m => m.data.name === this.landedOn!.name);
        if (ownMesh) dir.sub(this.getMoonWorldOffsetAU(ownMesh.data, parentBody, this.tmpMoonOffset));
      }
    }
    if (dir.lengthSq() < 1e-20) return;
    dir.normalize();

    // Earth/Moon keep their hand-tuned distances (the radius term stays below
    // them); larger bodies like Jupiter scale with their radius instead.
    const visualRadius = this.getLandedBodyRadiusAU() * this.planetScale;
    const wantedDist = Math.max(visualRadius * 5, this.landedOn.type === 'moon' ? 0.0006 : 0.001);
    const camDist = THREE.MathUtils.clamp(wantedDist, this.controls.minDistance, this.controls.maxDistance);
    const side = new THREE.Vector3().crossVectors(dir, PlanetariumMode.SCENE_NORTH);
    if (side.lengthSq() < 1e-10) side.set(1, 0, 0);
    else side.normalize();

    // Watching a moon's shadow cross the landed planet: the transiting moon is
    // sunward, so the default far-side framing would show the night side. Put
    // the camera on the moon's side instead, facing the lit hemisphere the
    // shadow spot crawls across.
    const moonSide = spec?.kind === 'shadow-transit' && this.landedOn.type === 'planet';
    this.camera.position
      .copy(dir)
      .multiplyScalar(moonSide ? camDist : -camDist)
      .addScaledVector(side, camDist / 5);
    this.camera.lookAt(0, 0, 0);
    this.controls.autoRotate = false;
  }

  // ================================================================
  // Surface view — the Observatory's narrow-FOV look-from-the-surface camera
  // ================================================================

  /** The landed body as the pure target-selection table's input shape. */
  private surfaceLandedInfo(): { type: 'planet' | 'moon'; name: string; parentPlanet?: string } | null {
    if (!this.landedOn) return null;
    return this.landedOn.type === 'planet'
      ? { type: 'planet', name: this.landedOn.name }
      : { type: 'moon', name: this.landedOn.name, parentPlanet: this.landedOn.parentPlanet };
  }

  /** Scene position of a surface target — read from the same objects the renderer draws. */
  private resolveSurfaceTargetScenePos(target: SurfaceTarget, out: THREE.Vector3): THREE.Vector3 | null {
    if (!this.solarSystem) return null;
    switch (target.kind) {
      case 'sun':
      case 'sun-from-spot':
        // Floating origin: sun.position is already body→Sun in scene coords.
        return out.copy(this.solarSystem.sun.position);
      case 'parent': {
        if (this.landedOn?.type !== 'moon') return null;
        const parentPlanet = this.landedOn.parentPlanet;
        const parent = this.solarSystem.planets.find(p => p.data.name === parentPlanet);
        return parent ? out.copy(parent.group.position) : null;
      }
      case 'moon': {
        const parentName = this.observatoryParentPlanetName();
        if (!parentName) return null;
        const moonMesh = this.planetMoons.get(parentName)?.find(m => m.data.name === target.moonName);
        const systemGroup = this.moonSystemGroups.get(parentName);
        if (!moonMesh || !systemGroup) return null;
        return out.copy(systemGroup.position).add(moonMesh.mesh.position);
      }
    }
  }

  /** True radius of a surface target (AU). */
  private surfaceTargetRadiusAU(target: SurfaceTarget): number {
    switch (target.kind) {
      case 'sun':
      case 'sun-from-spot':
        return KM_CONSTANTS.SUN_RADIUS / KM_PER_AU;
      case 'parent': {
        const parentName = this.landedOn?.type === 'moon' ? this.landedOn.parentPlanet : null;
        return PLANETARIUM_BODIES.find(b => b.name === parentName)?.radiusAU ?? 0;
      }
      case 'moon': {
        const parentName = this.observatoryParentPlanetName();
        return (
          this.planetMoons.get(parentName ?? '')?.find(m => m.data.name === target.moonName)?.data
            .radiusAU ?? 0
        );
      }
    }
  }

  /** True angular diameter (deg) of a surface target from the landed body, for the entry FOV. */
  private surfaceTargetAngularDiameterDeg(target: SurfaceTarget): number {
    const pos = this.resolveSurfaceTargetScenePos(target, this.tmpSurfaceTargetPos);
    if (!pos) return 0;
    // The landed body sits at scene origin, but the OBSERVER stands on its
    // surface — measure from there, not the center. For inner moons watched
    // from their parent the difference is a full planet radius (Metis from
    // Jupiter: ∅0.019° center vs ∅0.045° vantage) and flips the speck
    // classification the HUD would then contradict.
    const bodyRadiusAU = this.getLandedBodyRadiusAU();
    const observerDistAU = Math.max(
      pos.length() - (bodyRadiusAU + surfaceAltitudeAU(bodyRadiusAU)),
      1e-9,
    );
    return angularDiameterDeg(this.surfaceTargetRadiusAU(target), observerDistAU);
  }

  /**
   * Enter the surface view (or re-point an active one after a jump/swap):
   * the camera leaves orbit, glides down to a vantage on the landed body's
   * surface, and tracks the target until the user drags. OrbitControls hand
   * the pointer to SurfaceLook until exit. `immediate` snaps the FOV instead of
   * easing it when already in surface view — used by the vantage swap, where
   * the subject changes (see the re-point branch).
   */
  enterSurfaceView(target?: SurfaceTarget, entryContext?: SurfaceEntryContext, immediate = false) {
    const landedInfo = this.surfaceLandedInfo();
    if (!landedInfo) return;
    // Entering (or re-pointing — event jumps route here too) supersedes any
    // open picker; this also makes the pick handler self-closing.
    this.closeSurfaceTargetMenu();
    this.bottomBar.closeStats();
    // Surface view hides the whole bottom bar — an open Time panel would
    // otherwise reappear stale on exit.
    this.bottomBar.closeTime();
    // Manual entry right after an event jump points at the event's
    // observer-level target — "Look up" during an eclipse shows the eclipse.
    const liveEvent = this.relevantObservatoryEvent();
    this.surfaceTarget = target ?? selectSurfaceTarget(landedInfo, liveEvent?.spec ?? null);
    // No explicit context: entries derived while an event is live frame the
    // event; plain "Look up" frames the companion subject.
    const context = entryContext ?? (target === undefined && liveEvent ? 'event' : 'companion');
    this.surfaceTracking = true;
    // Fresh target, fresh marker: the hysteresis band must not inherit the
    // previous target's brackets/reticle state across entries/jumps/swaps.
    this.surfaceMarkerKind = 'brackets';
    // Re-seed the transported tracking-up from the camera's current local up
    // so the first tracked frame is continuous with what's on screen.
    this.surfaceUpTangent.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
    const entryFov = entryFovDeg(
      this.surfaceTargetAngularDiameterDeg(this.surfaceTarget),
      context,
      this.surfaceTarget.kind === 'sun',
    );
    this.surfaceFovDeg = entryFov;
    if (this.landedView === 'surface') {
      if (immediate) {
        // Vantage swap: the subject itself changed, so easing the FOV would
        // show the new body at the old body's zoom for ~½s — a jarring flash
        // (swap to Earth briefly fills the frame; swap to the Moon opens as a
        // speck and "grows in"), which reads as the swap lagging or not firing.
        // Snap straight to the fitted framing; the vantage re-pins next frame.
        this.surfaceFovAnim = null;
        this.camera.fov = entryFov;
        this.camera.updateProjectionMatrix();
        return;
      }
      // Re-point (event jump): a short ease to the new target's fitted FOV
      // (predictable framing beats preserving a zoom tuned for the previous
      // subject).
      this.surfaceFovAnim = {
        fromFov: this.camera.fov,
        toFov: entryFov,
        fromPos: null,
        elapsed: 0,
        duration: 0.45,
        finalizeExit: false,
      };
      return;
    }
    this.landedView = 'surface';
    // The panel makes way for the sky: it covered the event on
    // mobile and intercepted HUD clicks on desktop. The HUD's Observatory
    // chip reopens it over the surface view as an explicit opt-in; exiting
    // does not auto-reopen.
    this.closeObservatoryPanel();
    // The orbit-details overlay is an orbit-view instrument — the surface sky
    // must not carry ellipse axes/sectors across it.
    this.syncOrbitDetailsVisibility();
    this.preSurfaceCameraPos.copy(this.camera.position);
    this.preSurfaceAutoRotate = this.controls.autoRotate;
    this.controls.enabled = false;
    this.surfaceLook.attach();
    this.setSurfaceLabelContainersHidden(true);
    // One-time controls hint on first-ever surface entry. Tutorial entries skip
    // it entirely: the banner is muted then anyway, and showing it would
    // consume the seen-flag without the user ever reading the hint.
    if (!this.tutorial && !this.store.hasSeenSurfaceHint()) {
      this.store.markSurfaceHintSeen();
      this.notification.show('Drag to look around · scroll or pinch to zoom');
    }
    this.surfaceFovAnim = {
      fromFov: this.camera.fov,
      toFov: entryFov,
      fromPos: this.preSurfaceCameraPos.clone(),
      elapsed: 0,
      duration: 0.9,
      finalizeExit: false,
    };
    document.body.classList.add('surface-view-active');
    this.observatoryHud.show();
    this.renderSurfaceHud();
    this.renderObservatoryPanel(); // the Look up button flips to "Return to orbit"
  }

  /**
   * Leave the surface view: ease the FOV back to the shared 60° and then
   * restore the orbit camera/controls/labels (`immediate` skips the ease —
   * the teardown paths exitLandedMode/deactivate call it that way). This is
   * the single FOV restore point.
   */
  exitSurfaceView(immediate = false) {
    if (this.landedView !== 'surface') return;
    // The chip-opened picker must not outlive the sky it lists.
    this.closeSurfaceTargetMenu();
    // Finish now on teardown, on a second Escape mid-ease, or when aborting
    // the entry glide (easing out from mid-glide would snap down to the
    // vantage first — abort means "put me back").
    if (immediate || this.surfaceFovAnim?.finalizeExit || this.surfaceFovAnim?.fromPos) {
      this.finalizeSurfaceExit();
      return;
    }
    this.surfaceFovAnim = {
      fromFov: this.camera.fov,
      toFov: 60,
      fromPos: null,
      elapsed: 0,
      duration: 0.45,
      finalizeExit: true,
    };
  }

  private finalizeSurfaceExit() {
    this.landedView = 'orbit';
    this.surfaceFovAnim = null;
    this.surfaceLook.detach();
    this.camera.up.set(0, 1, 0); // OrbitControls assumes world-up
    this.camera.fov = 60;
    this.camera.updateProjectionMatrix();
    this.setSurfaceLabelContainersHidden(false);
    this.observatoryHud.hide();
    document.body.classList.remove('surface-view-active');
    if (this.landedOn) {
      this.controls.enabled = true;
      this.controls.autoRotate = this.preSurfaceAutoRotate;
      this.camera.position.copy(this.preSurfaceCameraPos);
      this.camera.lookAt(0, 0, 0);
      this.controls.target.set(0, 0, 0);
      this.renderObservatoryPanel(); // Look up label flips back
    }
    // The now-bar's visibility just flipped via the body class — no content
    // rebuild tracks that, so the peek height must re-measure here.
    this.observatoryPanel.refreshSheetLayout();
    this.syncOrbitDetailsVisibility();
  }

  private setSurfaceLabelContainersHidden(hidden: boolean) {
    // A half-degree disc at 10° FOV doesn't want a 14px DOM label on it.
    // #planet-labels also hosts the Sun label; constellation labels stay
    // (they're the sky itself). Un-hiding on surface exit still respects the
    // "Planet labels" setting.
    const show = !hidden && this.showBodyLabels;
    const planetLabelsEl = document.getElementById('planet-labels');
    if (planetLabelsEl) planetLabelsEl.style.display = show ? '' : 'none';
    if (this.moonLabelContainer) this.moonLabelContainer.style.display = show ? '' : 'none';
    // The marker sprites are Three.js objects owned by the renderLabels loop —
    // which surface view (and the setting) skips — so hide them explicitly.
    if (!show) this.planetLabels?.hideAll();
  }

  /** Drag look-around: content follows the finger; any drag breaks tracking. */
  private applySurfaceLook(dxPx: number, dyPx: number) {
    if (this.landedView !== 'surface') return;
    this.surfaceTracking = false;
    // A full-viewport-height drag pans one FOV — "grab the sky".
    const radPerPx =
      (this.camera.fov * DEG2RAD) / Math.max(this.renderer.domElement.clientHeight, 1);
    const zenith = this.tmpSurfaceZenith.copy(this.camera.position).normalize();
    // Yaw about the local zenith keeps panning level with the horizon.
    this.camera.quaternion.premultiply(
      this.tmpSurfaceQuat.setFromAxisAngle(zenith, dxPx * radPerPx),
    );
    // Pitch about the camera's right axis, clamped short of zenith/nadir so
    // the view can never flip over the pole.
    const forward = this.camera.getWorldDirection(this.tmpSurfaceAxis);
    const elevation = Math.asin(THREE.MathUtils.clamp(forward.dot(zenith), -1, 1));
    const maxElevation = 89 * DEG2RAD;
    const targetElevation = THREE.MathUtils.clamp(
      elevation + dyPx * radPerPx,
      -maxElevation,
      maxElevation,
    );
    const right = this.tmpSurfaceRight.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    this.camera.quaternion.premultiply(
      this.tmpSurfaceQuat.setFromAxisAngle(right, targetElevation - elevation),
    );
  }

  /** Wheel/pinch zoom: multiplicative FOV change, clamped to [1.5°, 45°]. */
  private applySurfaceZoom(factor: number) {
    if (this.landedView !== 'surface' || this.surfaceFovAnim?.finalizeExit) return;
    this.surfaceFovDeg = clampSurfaceFovDeg(this.surfaceFovDeg * factor);
    if (this.surfaceFovAnim) {
      this.surfaceFovAnim.toFov = this.surfaceFovDeg;
    } else {
      this.camera.fov = this.surfaceFovDeg;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Per-frame surface camera: re-pin the vantage (sub-target point, or the
   * shadow-spot point for solar-eclipse views), advance the FOV ease, and
   * track the target while tracking is on. Runs at the end of updateLanded
   * so this frame's moon positions are already in place.
   */
  private updateSurfaceCamera(dt: number) {
    const targetPos = this.resolveSurfaceTargetScenePos(this.surfaceTarget, this.tmpSurfaceTargetPos);
    if (!targetPos) {
      // Unresolvable target must not stall a pending exit ease forever.
      if (this.surfaceFovAnim?.finalizeExit) this.finalizeSurfaceExit();
      return;
    }

    const radiusAU = this.getLandedBodyRadiusAU(); // true radius — planetScale is 1
    const vantage = this.tmpSurfaceVantage;
    let spotPosed = false;
    if (this.surfaceTarget.kind === 'sun-from-spot' && this.landedOn?.type === 'planet') {
      const parentName = this.landedOn.name;
      const parentPos = this.planetWorldPositions.get(parentName);
      const occluder = this.planetMoons
        .get(parentName)
        ?.find(m => m.data.name === (this.surfaceTarget as { occluderMoonName: string }).occluderMoonName);
      if (parentPos && occluder) {
        // Occluder offset from the landed parent = the mesh's parent-relative
        // position (the parent sits at scene origin); shadow axis = the
        // moon's anti-sunward heliocentric direction. Same helper chain as
        // the rendered transit spot, so observer and spot agree.
        const axis = this.tmpSurfaceAxis
          .set(parentPos.x, parentPos.y, parentPos.z)
          .add(occluder.mesh.position)
          .normalize();
        computeShadowSpotVantage(radiusAU, occluder.mesh.position, axis, vantage);
        spotPosed = true;
      }
    }
    if (!spotPosed) {
      // Moons: refresh the orbit-normal pole reference (planets cached theirs
      // at landing). Cheap — one element propagation; Earth's Moon is a copy.
      if (this.landedOn?.type === 'moon') {
        const landedMoon = this.landedOn;
        const parentBody = PLANETARIUM_BODIES.find(b => b.name === landedMoon.parentPlanet);
        const moonMesh = this.planetMoons
          .get(landedMoon.parentPlanet)
          ?.find(m => m.data.name === landedMoon.name);
        if (parentBody && moonMesh) {
          this.getMoonWorldOffsetAU(
            moonMesh.data,
            parentBody,
            this.tmpSurfacePoleOffset,
            this.surfacePoleAxis,
          );
          if (this.surfacePoleAxis.lengthSq() > 0) this.surfacePoleAxis.normalize();
          else this.surfacePoleAxis.set(0, 1, 0);
        }
      }
      computeSubTargetVantage(
        radiusAU,
        targetPos,
        this.surfacePoleAxis,
        SURFACE_TARGET_ELEVATION_DEG,
        vantage,
      );
    }

    const anim = this.surfaceFovAnim;
    if (anim) {
      anim.elapsed = Math.min(anim.elapsed + dt, anim.duration);
      const t = smoothstepUnclamped(anim.elapsed / anim.duration);
      this.camera.fov = THREE.MathUtils.lerp(anim.fromFov, anim.toFov, t);
      this.camera.updateProjectionMatrix();
      if (anim.fromPos) {
        this.camera.position.lerpVectors(anim.fromPos, vantage, t);
      } else {
        this.camera.position.copy(vantage);
      }
      if (anim.elapsed >= anim.duration) {
        const finalize = anim.finalizeExit;
        this.surfaceFovAnim = null;
        if (finalize) {
          this.finalizeSurfaceExit();
          return;
        }
      }
    } else {
      this.camera.position.copy(vantage);
      if (this.camera.fov !== this.surfaceFovDeg) {
        this.camera.fov = this.surfaceFovDeg;
        this.camera.updateProjectionMatrix();
      }
    }

    // Tracking-camera orientation. The vantage puts the target at the local
    // zenith, so a zenith up would be parallel to the look direction and
    // lookAt's basis degenerate (orientation was fp noise — frames wandered
    // up to ~20° off-target). Parallel-transport a tangent up instead; it is
    // seeded from the camera's current up on entry/re-point/resume so
    // tracking never starts with a roll snap.
    if (this.surfaceTracking) {
      const forward = this.tmpSurfaceZenith.copy(targetPos).sub(this.camera.position);
      if (forward.lengthSq() > 0) forward.normalize();
      this.camera.up.copy(transportTrackingUp(this.surfaceUpTangent, forward));
      this.camera.lookAt(targetPos);
    }

    // Marker over the tracked target (per-frame screen projection): brackets
    // for a resolvable disc, the hairline reticle for sub-pixel specks (the
    // 70px bracket floor around empty sky read as "something visible here"),
    // and an edge chevron pointing back when free look loses the target.
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const proj = projectToScreen(targetPos, this.camera, w, h);
    const discDeg = angularDiameterDeg(
      this.surfaceTargetRadiusAU(this.surfaceTarget),
      targetPos.distanceTo(this.camera.position),
    );
    const discPx = projectedDiscPx(discDeg, this.camera.fov, h);
    this.surfaceMarkerKind = resolveMarkerKind(discPx, this.surfaceMarkerKind);
    // On-frame test inflated by the disc radius: a big disc (Jupiter fills
    // ~60% of the frame) must not flip to "off frame" the moment its CENTER
    // leaves the viewport while half of it is plainly visible.
    const discR = discPx / 2;
    const onFrame =
      proj.ndcZ < 1 &&
      proj.x >= -discR && proj.x <= w + discR &&
      proj.y >= -discR && proj.y <= h + discR;
    if (onFrame) {
      const sizePx = THREE.MathUtils.clamp(
        (discDeg / this.camera.fov) * h * 1.3,
        70,
        h * 0.85,
      );
      this.observatoryHud.updateMarker({
        mode: this.surfaceMarkerKind,
        xPx: proj.x,
        yPx: proj.y,
        sizePx,
      });
    } else {
      // Edge chevron: direction from screen center toward the target's
      // projection (mirrored when it's behind the camera), placed by
      // component-wise clamp of a far point along that ray into an inset
      // frame — never mirrored or off-rect even when an inset crosses the
      // screen center (a ray-march's t went negative there). Insets reserve
      // the HUD bands — top chips and the bottom narrative/FOV/transport
      // zone.
      let dx = proj.x - w / 2;
      let dy = proj.y - h / 2;
      if (proj.ndcZ >= 1) {
        dx = -dx;
        dy = -dy;
      }
      const len = Math.hypot(dx, dy);
      if (len > 0) {
        dx /= len;
        dy /= len;
      } else {
        dy = -1;
      }
      const insetX = 28;
      const insetTop = 96;
      const insetBottom = 150;
      // Clamp against the Observatory panel when it's open over the surface
      // view: a chevron under it is visible but unclickable. The
      // rect is cached per viewport size — the panel is CSS-fixed and only
      // moves on resize (per-frame getBoundingClientRect after the HUD's
      // style writes would force reflow). Desktop docks it right (clamp the
      // right inset); ≤640px it's a bottom sheet (grow the bottom inset).
      let insetRight = insetX;
      let sheetBottom = insetBottom;
      if (this.observatoryPanel.isOpen()) {
        if (!this.panelRectCache || this.panelRectCache.w !== w || this.panelRectCache.h !== h) {
          const rect = document.getElementById('observatory-panel')?.getBoundingClientRect();
          this.panelRectCache = { w, h, left: rect ? rect.left : w, top: rect ? rect.top : h };
        }
        const cache = this.panelRectCache;
        if (cache.left > w * 0.4) {
          insetRight = Math.min(
            Math.max(insetX, w - cache.left + 12),
            Math.max(insetX, w - insetX - 44),
          );
        } else if (cache.top > h * 0.4) {
          sheetBottom = Math.max(insetBottom, h - cache.top + 12);
        }
      }
      const ex = THREE.MathUtils.clamp(w / 2 + dx * (w + h), insetX, Math.max(insetX + 1, w - insetRight));
      const ey = THREE.MathUtils.clamp(h / 2 + dy * (w + h), insetTop, Math.max(insetTop + 1, h - sheetBottom));
      this.observatoryHud.updateMarker({
        mode: 'chevron',
        xPx: ex,
        yPx: ey,
        angleDeg: (Math.atan2(dy, dx) * 180) / Math.PI,
      });
    }
  }

  /** The moon-system (parent planet name) a target belongs to. */
  private parentSystemOf(target: NonNullable<LandedTarget>): string {
    return target.type === 'moon' ? target.parentPlanet : target.name;
  }

  // Systems whose photo maps have already been drained to the GPU under an
  // arrival cover — one veil beat per system per session (context loss clears
  // the entry, since it frees the uploads).
  private warmedSystems = new Set<string>();

  /** Queue a system's arrived moon photo/normal maps for warm upload. Photos
   * only — a GPU-painted procedural map is render-target-backed (already
   * resident) and a CPU CanvasTexture is small; the real normal map (the
   * Moon's) is the other multi-MB upload. */
  private queueSystemMoonMapsForWarm(parentName: string): void {
    for (const m of this.planetMoons.get(parentName) ?? []) {
      const mat = m.mesh.material as THREE.MeshStandardMaterial;
      if (mat.userData.photoLoaded && mat.map) queueTextureWarm(mat.map);
      if (mat.normalMap) queueTextureWarm(mat.normalMap);
    }
  }

  /** The one-shot 4K upgrade handles of the landed body and its vantage
   * companion — the pair the Observatory magnifies regardless of distance. */
  private landedPairUpgrades(): TextureUpgrade[] {
    if (!this.landedOn) return [];
    const ups: TextureUpgrade[] = [];
    for (const body of [this.landedOn, this.swapCompanionTarget()]) {
      if (!body) continue;
      const up =
        body.type === 'planet'
          ? this.solarSystem?.planets.find((p) => p.data.name === body.name)?.textureUpgrade
          : this.planetMoons.get(body.parentPlanet)?.find((m) => m.data.name === body.name)?.textureUpgrade;
      if (up) ups.push(up);
    }
    return ups;
  }

  /**
   * Run an instant teleport (`action`), but if the destination system's moons
   * aren't painted yet — or carry 4K-class photo maps that haven't reached the
   * GPU — cover the screen first, make the system drawable, then reveal. A
   * quick-travel must never flash an unpainted (or, with the visibility gate,
   * a missing) moon, and a first arrival must not play a train of ~100ms
   * upload frames on screen (a 4096-wide upload is unsliceable and one lands
   * per pump frame — four Galileans means four stalled frames in a row).
   * Landings also hold the cover (bounded) for the landed pair's pre-triggered
   * 4K fetch+decode, so those uploads drain under it instead of just after the
   * reveal. Warm systems act immediately, exactly as before. A second arrival
   * while one is mid-flight is ignored.
   */
  private arriveThen(target: NonNullable<LandedTarget>, action: () => void): void {
    if (this.arrivalInFlight) return;
    const parentName = this.parentSystemOf(target);
    const moons = this.planetMoons.get(parentName);
    const needsPaint = !!moons && moons.some((m) => !m.painted);
    // 4K-class photo maps still waiting for their first GPU upload get drained
    // under the veil below. Smaller maps (the Moon's 2K photo) upload within a
    // frame or two off-gesture via the warm pump — no veil beat for those.
    const needsUploadCover =
      !!moons &&
      !this.warmedSystems.has(parentName) &&
      moons.some((m) => {
        const mat = m.mesh.material as THREE.MeshStandardMaterial;
        const img = mat.map?.image as { width?: number } | undefined;
        return !!mat.userData.photoLoaded && (img?.width ?? 0) >= 4096;
      });
    if (!moons || (!needsPaint && !needsUploadCover)) {
      action();
      return;
    }
    this.arrivalInFlight = true;
    const veil = document.getElementById('arrival-veil');
    const coverStart = performance.now();
    veil?.classList.add('covering'); // snaps fully opaque (no fade-in) — see CSS
    const coverGen = ++this.arrivalCoverGen;
    // Two frames so the opaque veil is actually composited before we block the
    // main thread painting; otherwise the paint freezes a half-covered veil and
    // the unpainted scene shows through it.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        try {
          // The mode could have been left during the two-frame cover window —
          // don't paint or teleport into a deactivated mode (the finally still
          // clears the flag and lifts the veil).
          if (!this.active) return;
          this.moonPainter.paintSystemNow(parentName, moons);
          action();
          // Upload the system's arrived photo/normal maps while the cover is
          // opaque (a landing already queued them via applyLandedTarget; a
          // cruise jump queues here), so the reveal frame draws a fully
          // resident system instead of stalling once per big map.
          this.queueSystemMoonMapsForWarm(parentName);
          pumpTextureWarmQueue(Number.POSITIVE_INFINITY);
          this.warmedSystems.add(parentName);
        } catch (err) {
          debugError('Arrival failed', err);
        } finally {
          this.arrivalInFlight = false;
          // A landing pre-triggers the landed pair's 4K upgrades
          // (applyLandedTarget), and their fetch+decode may still be in flight
          // when the drain above runs — revealed too early, each finishes as a
          // ~100ms upload frame on the fresh scene. Keep the opaque cover up
          // until they resolve (bounded — a stalled fetch must never pin the
          // veil), drain once more, then reveal.
          const holdDeadline = coverStart + PlanetariumMode.ARRIVAL_UPGRADE_HOLD_MAX_MS;
          const tryLift = () => {
            if (coverGen !== this.arrivalCoverGen) return; // a newer arrival owns the veil now
            if (
              this.active &&
              performance.now() < holdDeadline &&
              this.landedPairUpgrades().some((up) => up.state === 'loading')
            ) {
              requestAnimationFrame(tryLift);
              return;
            }
            pumpTextureWarmQueue(Number.POSITIVE_INFINITY);
            // Hold the cover until the painted, teleported scene has rendered
            // (the landed/jumped system first appears on the next
            // update→render) and at least the min dwell, so a fast machine
            // reads it as an intentional beat rather than a flicker. Removing
            // the class fades it back out.
            const wait = Math.max(48, PlanetariumMode.ARRIVAL_MIN_DWELL_MS - (performance.now() - coverStart));
            window.setTimeout(() => {
              if (coverGen === this.arrivalCoverGen) veil?.classList.remove('covering');
            }, wait);
          };
          tryLift();
        }
      }),
    );
  }

  enterLandedMode(target: NonNullable<LandedTarget>) {
    if (this.isMissionActive()) return;
    this.preLandSpeed = this.player.speedMultiplier;
    this.preLandAutopilot = this.autopilot;
    this.applyLandedTarget(target);
    this.notification.show(`Landed on ${target.name}`);
  }

  /**
   * State-configuration core of landing: everything `enterLandedMode` does
   * except capturing `preLand*` and the arrival toast — so the Observatory's
   * vantage swap can re-land on the companion body without the exit/enter
   * ceremony (no speed restore, no "Departing" toast, take-off state intact).
   */
  private applyLandedTarget(target: NonNullable<LandedTarget>, preserveOrbitPair = false) {
    // Every landing path funnels through here (enterLandedMode, restoreState,
    // the Observatory menu's landed→landed re-land) — clearing the vantage
    // pair here, not per call site, is what keeps a stale pair from
    // resurrecting a moon subject on a later fresh landing on its parent.
    // Only the vantage swap preserves the pair it just set.
    if (!preserveOrbitPair) this.orbitPairMoon = null;
    // Every deck pick closes the deck before acting, but the cluster stays
    // clickable above its backdrop — a landing can still fire under an open
    // deck whose rows and HERE pill would go stale the instant the ground
    // changes. Defensive close (no-op on deck-initiated landings).
    this.closeDeck();
    // New ground, new sky: the picker's rows and the remembered Look-at
    // target both describe the vantage being left behind.
    this.closeSurfaceTargetMenu();
    this.surfacePickedTarget = null;
    this.landedOn = target;
    // The landed system's moons are about to be drawn up close: mark them
    // warm-eligible (late-arriving photos/normals queue on arrival) and queue
    // any already-arrived maps now, so their GPU uploads happen on the next
    // quiet frames. Without this, frustum culling defers an off-screen moon's
    // first draw — and its whole decode+upload bill — to exactly the gesture
    // that points the camera at it (vantage swap, Look up, even Leave).
    const warmParent = this.parentSystemOf(target);
    setWarmEligibleMoonParents(new Set([warmParent]));
    this.queueSystemMoonMapsForWarm(warmParent);
    // The landed body and its vantage companion are this session's guaranteed
    // close-ups (the Observatory magnifies them regardless of distance), so
    // start their one-shot 4K upgrades now: fetch, decode, and upload spend
    // the parked seconds right after touchdown instead of the first
    // magnifying gesture (a 4096-wide upload alone is a ~100ms frame).
    for (const up of this.landedPairUpgrades()) upgradeTextureOnApproach(up);
    // The reticle's screen position belongs to the previous target — drop it
    // now rather than letting it float stale until the next landed frame
    // (cross-system picks can interpose a transition with no guide pass).
    this.hideFootprintReticle();
    // Chrome hook: ≤640px the landed top bar drops the wordmark/mode toggle.
    document.body.classList.add('planetarium-landed');
    // A different subject can show/hide panel sections — the chevron's
    // cached clamp rect must re-measure.
    this.panelRectCache = null;

    // Vantage azimuth reference (planets: constant IAU pole, cached here;
    // moons refresh their orbit normal per frame in updateSurfaceCamera).
    if (target.type === 'planet') {
      const body = PLANETARIUM_BODIES.find(b => b.name === target.name);
      if (body) this.surfacePoleAxis.copy(raDecToVector(body.poleRaDeg, body.poleDecDeg)).normalize();
    } else if (target.type === 'moon') {
      // Observatory magnifies the moon to a fixed screen fraction, so re-render
      // its procedural texture sharper than the flythrough baseline. No-op for
      // photo moons / already-sharp ones; fail-closed; the upgrade stays for the
      // session.
      const moons = this.planetMoons.get(target.parentPlanet);
      const moon = moons?.find((m) => m.data.name === target.name);
      if (moon && moons) {
        // Cold restore (restoreState → enterLandedMode) runs no gate/veil first,
        // so the system may still be unpainted; paint it now so the upgrade has a
        // baseline to sharpen (otherwise it no-ops and the moon stays low-res).
        if (this.moonPainter.hasPending(target.parentPlanet)) {
          this.moonPainter.paintSystemNow(target.parentPlanet, moons);
        }
        this.moonTexturer.upgrade(moon, PlanetariumMode.OBSERVE_MOON_TEXTURE_WIDTH);
      }
    }

    // Stop ship
    this.player.speedMultiplier = 0;
    this.player.moving = false;
    this.player.group.visible = false;

    // Disable autopilot silently (target preserved for restore)
    this.autopilot = false;
    // Landing retires a destination the user never chose (a target migrated
    // from an old save without provenance) — otherwise takeoff resumes a
    // ghost trip and the bottom-bar chip keeps pointing at it forever.
    if (!this.autopilotUserEngaged) {
      this.autopilotTarget = null;
      this.preLandAutopilot = false;
    }
    this.updateAutopilotButton();

    // Move player to body position so floating origin centers on it.
    const pos = this.getLandedBodyWorldPosition();
    if (pos) {
      this.player.posX = pos.x;
      this.player.posY = pos.y;
      this.player.posZ = pos.z;
    }

    // Configure OrbitControls to orbit the body. The player is parked at the
    // body's world position, so the next floating-origin pass puts the body —
    // planet or moon — exactly at scene origin.
    const trueRadiusAU = this.getLandedBodyRadiusAU();
    const renderedRadiusAU = this.getLandedBodyRenderedRadiusAU();

    this.controls.enabled = true;
    this.controls.target.set(0, 0, 0);
    this.controls.minDistance = landedMinDistanceAU(renderedRadiusAU, this.camera.near);
    this.controls.maxDistance = this.landedMaxDistanceAU(trueRadiusAU);
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.5;
    this.userOrbiting = false;

    // Frame the body to ~⅓ of the view (see landedView), opening on its lit
    // hemisphere. The camera ends up 1.5×camDist from the body at scene origin.
    const camDist = landedFrameCamDistAU(renderedRadiusAU, this.camera.near);
    const litDir = this.computeLandedCameraDir(pos);
    this.camera.position.copy(litDir).multiplyScalar(camDist * 1.5);
    this.camera.lookAt(0, 0, 0);

    // UI: hide flight controls, show leave button
    // Close any open popovers before hiding — the rail itself stays live
    // (time is the one throttle always available on the ground).
    this.bottomBar.closeStats();
    this.bottomBar.closeTime();
    // Parked: dim the speed group inert (kept laid out so the bar doesn't
    // reflow). Pilot stays visible — its tab lifts off and flies from here.
    const speedGroup = document.querySelector('.bar-speed-main .speed-group') as HTMLElement | null;
    if (speedGroup) speedGroup.classList.add('inert');
    const hide = ['planetarium-keys-hint', 'touch-flight-zone', 'planetarium-btn-land'];
    for (const id of hide) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
    const leaveBtn = document.getElementById('planetarium-btn-leave');
    if (leaveBtn) leaveBtn.style.display = '';
    const leaveName = document.getElementById('leave-body-name');
    if (leaveName) leaveName.textContent = target.name;

    this.updateObservatoryButtonVisibility();

    // Shadow visuals live in the landed system's moon group (Mercury/Venus
    // have none — attach is skipped and update() finds no moons).
    const systemGroup = this.moonSystemGroups.get(this.observatoryParentPlanetName() ?? '');
    if (systemGroup) {
      this.shadowVisuals.attach(systemGroup);
      this.shadowVisuals.setGuidesVisible(this.showShadowGuides);
      this.orbitDetailsVisuals.attach(systemGroup);
    }
    const orbitSubject = this.resolveOrbitSubject();
    this.observatoryPanel.setOrbitDetailsAvailable(orbitSubject !== null);
    if (!orbitSubject) this.observatoryPanel.setOrbitReadout(null);
    this.updateOrbitDetails(true);
  }

  /**
   * Re-derive the landed scene graph — player offset, floating origin, and moon
   * orbital offsets — from the current world positions. updateLanded does this
   * every frame, so a read taken *between* frames sees last frame's geometry.
   * The surface view's one-shot entry-FOV fit is exactly such a read when it
   * fires synchronously right after a vantage swap (player moved to the
   * companion) or a clock jump (time moved): the look target, still placed at
   * the previous vantage's origin, reads a ~180° disc and pins the entry FOV to
   * its widest, so the view opens zoomed all the way out. Refreshing here makes
   * the fit measure true geometry. Callers must have current planet world
   * positions first — a same-clock swap leaves them valid; setCurrentUtcMs
   * rebuilds them after a jump.
   */
  private refreshLandedScene() {
    const bodyPos = this.getLandedBodyWorldPosition();
    if (bodyPos) {
      this.player.posX = bodyPos.x;
      this.player.posY = bodyPos.y;
      this.player.posZ = bodyPos.z;
    }
    this.applyFloatingOrigin();
    this.updateMoonPositions();
  }

  /** The unique companion body for the vantage swap: moon → its parent, Earth → the Moon. */
  swapCompanionTarget(): NonNullable<LandedTarget> | null {
    if (!this.landedOn) return null;
    if (this.landedOn.type === 'moon') {
      return { type: 'planet', name: this.landedOn.parentPlanet };
    }
    if (this.landedOn.name === 'Earth') {
      return { type: 'moon', name: 'Moon', parentPlanet: 'Earth' };
    }
    return null;
  }

  /**
   * Vantage swap: re-land on the companion body (Moon ↔ Earth, moon ↔ parent)
   * in place — no departure, no toast ceremony. Same system, so moon
   * positions and the upcoming-events search stay valid. If the surface view
   * is active it stays active — pointed at the live event's observer-level
   * target when the clock sits inside one (swapping mid-eclipse must keep
   * showing the eclipse from the new vantage), otherwise back at the body
   * you just left.
   */
  swapLandedVantage() {
    if (this.isMissionActive()) return;
    const companion = this.swapCompanionTarget();
    if (!companion || !this.landedOn) return;
    const previous = this.landedOn;
    const wasSurface = this.landedView === 'surface';
    // Remember the pair moon across a moon→parent swap: the orbit-details
    // subject survives standing on the parent (the better vantage on the
    // whole ellipse — and there is no one-tap swap back from a generic parent).
    if (previous.type === 'moon' && companion.type === 'planet') {
      this.orbitPairMoon = { moonName: previous.name, parentName: previous.parentPlanet };
    }
    this.applyLandedTarget(companion, true);
    // applyLandedTarget parked the player on the companion, but the scene graph
    // still reflects the old vantage until the next frame — and the surface
    // re-entry below reads it synchronously to fit the FOV. Refresh it now.
    this.refreshLandedScene();
    if (wasSurface) {
      // applyLandedTarget re-enabled OrbitControls and reset the camera for
      // orbit view — re-assert the surface invariants. Its fresh orbit camera
      // position becomes the exit restore point for the *new* body (the old
      // one was scaled to the previous body's radius).
      this.preSurfaceCameraPos.copy(this.camera.position);
      this.preSurfaceAutoRotate = this.controls.autoRotate;
      this.controls.enabled = false;
      // No-arg re-derives from the relevant event (landedOn just changed —
      // the same event reads differently from the companion: a transit seen
      // from the parent is a solar eclipse, from the moon it's your own
      // shadow). Without a live event, point back at the body you left.
      const liveSwapEvent = this.relevantObservatoryEvent();
      this.enterSurfaceView(
        liveSwapEvent
          ? undefined
          : previous.type === 'moon'
            ? { kind: 'moon', moonName: previous.name }
            : { kind: 'parent' },
        liveSwapEvent ? 'event' : 'companion',
        true, // snap the FOV — the subject changed, an ease would flash/lag
      );
    }
    this.notification.show(`Standing on ${companion.name}`);
    this.renderObservatoryPanel();
    // Row hints/∅ badges are observer-conditioned and baked at publish time —
    // republish from the cached results so they describe the NEW vantage (the
    // same penumbral eclipse is "subtle dimming" from Mars but "daylight
    // barely dims" standing on Phobos).
    this.publishObservatoryEvents();
  }

  // ── Orbit details (Observatory footer toggle) ────────────────────────────

  /**
   * The orbit-details subject: the moon member of the landed vantage pair —
   * the landed moon itself, Earth's companion Moon, or (standing on a parent
   * after a vantage swap) the remembered pair moon. A generic parent with no
   * pair memory has no subject; the footer row hides.
   */
  private resolveOrbitSubject(): { moonName: string; parentName: string } | null {
    if (!this.landedOn) return null;
    if (this.landedOn.type === 'moon') {
      return { moonName: this.landedOn.name, parentName: this.landedOn.parentPlanet };
    }
    const companion = this.swapCompanionTarget();
    if (companion?.type === 'moon') {
      return { moonName: companion.name, parentName: companion.parentPlanet };
    }
    if (this.orbitPairMoon && this.orbitPairMoon.parentName === this.landedOn.name) {
      return this.orbitPairMoon;
    }
    return null;
  }

  private handleOrbitDetailsToggle(on: boolean) {
    this.showOrbitDetails = on;
    if (this.landedOn) {
      this.controls.maxDistance = this.landedMaxDistanceAU(
        this.getLandedBodyRadiusAU() * this.planetScale,
      );
      this.updateOrbitDetails(true);
    }
    this.syncOrbitDetailsVisibility();
  }

  /**
   * Landed zoom-out limit. With orbit details on it must contain the
   * SUBJECT's orbit (Nereid's apoapsis is 0.064 AU, Neso's 0.49 — far past
   * the stock 0.01 floor), keyed off the resolved subject so a post-swap
   * parent vantage reaches the ellipse too. Earth's Moon (apo 0.0027 AU)
   * never exceeds the stock floor — the max() simply no-ops there; don't
   * "fix" that. Toggle-off returns the stock value and OrbitControls
   * re-clamps on the next update (accepted jump cut).
   */
  private landedMaxDistanceAU(visualRadius: number): number {
    let max = Math.max(visualRadius * 30, 0.01);
    if (this.showOrbitDetails) {
      const subject = this.resolveOrbitSubject();
      if (subject) {
        max = Math.max(max, getMoonApoapsisAU(subject.moonName, subject.parentName) * 2.2);
      }
    }
    return max;
  }

  /** Central visibility gate: the overlay is an orbit-view instrument —
   *  toggle on, subject resolved, landed, NOT in surface view. */
  private syncOrbitDetailsVisibility() {
    const visible =
      this.showOrbitDetails &&
      this.landedOn !== null &&
      this.landedView !== 'surface' &&
      this.orbitDetailsVisuals.isAttached() &&
      this.resolveOrbitSubject() !== null;
    this.orbitDetailsVisuals.setVisible(visible);
    if (!visible) this.hideOrbitFocusLabels();
  }

  private hideOrbitFocusLabels() {
    if (this.orbitFocusF1El) this.orbitFocusF1El.style.display = 'none';
    if (this.orbitFocusF2El) this.orbitFocusF2El.style.display = 'none';
  }

  private ensureOrbitFocusEls() {
    if (!this.orbitFocusF1El) {
      this.orbitFocusF1El = document.getElementById('orbit-focus-f1');
      this.orbitFocusF1SpanEl = this.orbitFocusF1El?.querySelector('span') ?? null;
    }
    if (!this.orbitFocusF2El) {
      this.orbitFocusF2El = document.getElementById('orbit-focus-f2');
      this.orbitFocusF2SpanEl = this.orbitFocusF2El?.querySelector('span') ?? null;
    }
  }

  /**
   * 8 Hz pass: resample the orbit when the clock drifts past the staleness
   * guard (or the subject changed), and rebuild the two Kepler sectors from
   * fresh seam evals. All positions come from computeMoonOffsetEquatorialAU —
   * the seam the renderer draws with, so the subject sits on the line.
   */
  private updateOrbitDetails(force = false) {
    if (!this.showOrbitDetails || !this.landedOn || !this.orbitDetailsVisuals.isAttached()) {
      this.syncOrbitDetailsVisibility();
      return;
    }
    const subject = this.resolveOrbitSubject();
    if (!subject) {
      this.syncOrbitDetailsVisibility();
      return;
    }
    const nowMs = this.timeState.currentUtcMs;
    const display = getMoonDisplayOrbit(subject.moonName, subject.parentName);
    if (
      force ||
      this.orbitSampledSubject !== subject.moonName ||
      needsResample(nowMs, this.orbitSampleRefUtcMs, display.periodDays)
    ) {
      this.resampleOrbitDetails(subject, display, nowMs);
    }
    // Surface view hides the overlay — skip the 8 Hz sector rebuild (34 seam
    // evals + geometry swaps for an invisible result). The resample/readout
    // path above stays live so a swap-during-surface-view still publishes
    // the new subject's readout and zoom limit.
    if (this.landedView !== 'surface') {
      const windows = sectorWindows(nowMs, display.periodDays);
      this.orbitDetailsVisuals.updateSectors(
        this.sampleOrbitArc(subject, windows.trailingStartMs, windows.trailingEndMs),
        this.sampleOrbitArc(subject, windows.offsetStartMs, windows.offsetEndMs),
      );
    }
    this.syncOrbitDetailsVisibility();
  }

  private resampleOrbitDetails(
    subject: { moonName: string; parentName: string },
    display: MoonDisplayOrbit,
    nowMs: number,
  ) {
    const segments = orbitSampleSegments(display.eccentricity);
    const times = sampleSpanTimesMs(nowMs, display.periodDays, segments);
    const points = times.map((t) =>
      computeMoonOffsetEquatorialAU(subject.moonName, subject.parentName, t, new THREE.Vector3()),
    );
    const geometry = deriveOrbitGeometry(points);
    const parentRadiusAU =
      PLANETARIUM_BODIES.find((b) => b.name === subject.parentName)?.radiusAU ?? 0;
    this.orbitDetailsVisuals.setOrbit(points, geometry, {
      closeLoop: shouldCloseLoop(geometry),
      suppressApsides: isCircularDegenerate(geometry),
      suppressEmptyFocus: areFociMerged(geometry, parentRadiusAU),
    });
    this.orbitSampleRefUtcMs = nowMs;
    this.orbitSampledSubject = subject.moonName;
    this.observatoryPanel.setOrbitReadout(
      formatOrbitReadout(geometry, display, {
        isEarthMoon: subject.moonName === 'Moon' && subject.parentName === 'Earth',
        parentRadiusAU,
      }),
    );
    // A subject change can change how far the zoom must reach.
    this.controls.maxDistance = this.landedMaxDistanceAU(
      this.getLandedBodyRadiusAU() * this.planetScale,
    );
  }

  private sampleOrbitArc(
    subject: { moonName: string; parentName: string },
    startMs: number,
    endMs: number,
  ): THREE.Vector3[] {
    const STEPS = 16;
    const arc: THREE.Vector3[] = [];
    for (let i = 0; i <= STEPS; i++) {
      const t = startMs + ((endMs - startMs) * i) / STEPS;
      arc.push(
        computeMoonOffsetEquatorialAU(subject.moonName, subject.parentName, t, new THREE.Vector3()),
      );
    }
    return arc;
  }

  /**
   * Per-frame F1/F2 focus-glyph projection ("a label, not geometry" — the
   * world-space rings would be sub-pixel for the irregulars). Orbit view
   * only: unlike the footprint reticle, which deliberately stays alive in
   * surface view, the focus glyphs are part of the orbit instrument.
   */
  private updateOrbitFocusLabels() {
    if (this.landedView === 'surface' || !this.orbitDetailsVisuals.isVisible()) {
      this.hideOrbitFocusLabels();
      return;
    }
    const subject = this.resolveOrbitSubject();
    const systemGroup = subject ? this.moonSystemGroups.get(subject.parentName) : null;
    if (!subject || !systemGroup) {
      this.hideOrbitFocusLabels();
      return;
    }
    const { hasOrbit, showF2 } = this.orbitDetailsVisuals.getFocusLocalPositions(
      this.tmpOrbitFocus1,
      this.tmpOrbitFocus2,
    );
    if (!hasOrbit) {
      this.hideOrbitFocusLabels();
      return;
    }
    this.ensureOrbitFocusEls();
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const place = (
      el: HTMLElement | null,
      span: HTMLElement | null,
      local: THREE.Vector3,
      label: string,
      show: boolean,
    ) => {
      if (!el) return;
      if (!show) {
        el.style.display = 'none';
        return;
      }
      local.add(systemGroup.position);
      const proj = projectToScreen(local, this.camera, w, h, this.orbitFocusProjection);
      if (proj.ndcZ >= 1 || proj.x < 0 || proj.x > w || proj.y < 0 || proj.y > h) {
        el.style.display = 'none';
        return;
      }
      if (span && span.textContent !== label) span.textContent = label;
      // Transform, not left/top: fractional positioning, no paint snap.
      el.style.transform = `translate(${proj.x}px, ${proj.y}px)`;
      el.style.display = '';
    };
    place(this.orbitFocusF1El, this.orbitFocusF1SpanEl, this.tmpOrbitFocus1, `F1 · ${subject.parentName}`, true);
    place(this.orbitFocusF2El, this.orbitFocusF2SpanEl, this.tmpOrbitFocus2, 'F2 · empty focus', showF2);
  }

  exitLandedMode() {
    if (!this.landedOn) return;
    // The governor is frozen while landed, so a cap tightened on the approach
    // must not ramp-limit the departure. Reset it here — the single takeoff
    // chokepoint (also the excursion Leave and deactivate paths) — so flight
    // resumes from an unconstrained cap, mirroring the teleport reset.
    this.moonCapEased = Infinity;
    // Back to cruise: no landed system means no moons owed a warm upload.
    setWarmEligibleMoonParents(new Set());
    // Leave sits in the cluster above the deck's backdrop, so takeoff can
    // fire while the deck is open — a deck describing the ground being left
    // (HERE pill, reveal target) closes with it.
    this.closeDeck();
    this.closeSurfaceTargetMenu();
    this.surfacePickedTarget = null;
    // Teardown path: restore FOV/controls/labels instantly — the code below
    // reconfigures the controls and camera for flight anyway.
    this.exitSurfaceView(true);
    const bodyName = this.landedOn.name;

    const excursion = this.observatoryExcursion;
    this.observatoryExcursion = null;
    if (excursion) {
      // Observatory excursion: the menu grabbed the ship out of cruise, so
      // Leave returns it exactly there — pose, speed, motion state — instead
      // of departing from the body.
      this.player.posX = excursion.posX;
      this.player.posY = excursion.posY;
      this.player.posZ = excursion.posZ;
      this.player.heading = excursion.heading;
      this.player.pitch = excursion.pitch;
      this.player.speedMultiplier = excursion.speedMultiplier;
      this.player.systemSpeedMultiplier = excursion.systemSpeedMultiplier;
      this.inSystemMode = excursion.inSystemMode;
      this.player.moving = excursion.moving;
    } else {
      const bodyPos = this.getLandedBodyWorldPosition();
      const radiusAU = this.getLandedBodyRadiusAU();

      if (bodyPos) {
        // The cruise camera sits camDist behind the player. By facing AWAY
        // from the body, the camera ends up between the player and the body,
        // giving a close-up view of the body as you depart.
        const camDist = 0.000094; // must match resetCruiseCamera
        let safeDist: number;
        if (this.landedOn.type === 'planet') {
          // Camera must clear collision radius
          const collisionR = this.getPlanetCollisionRadius(radiusAU, this.planetScale);
          safeDist = camDist + collisionR * 1.5;
        } else {
          // Moons: no collision handler, place so camera is close
          safeDist = camDist * 1.5;
        }

        // Direction away from Sun (outward from body)
        const awayDir = new THREE.Vector3(bodyPos.x, bodyPos.y, bodyPos.z);
        if (awayDir.lengthSq() < 1e-8) awayDir.set(1, 0.1, 0);
        awayDir.normalize();

        this.player.posX = bodyPos.x + awayDir.x * safeDist;
        this.player.posY = bodyPos.y + awayDir.y * safeDist;
        this.player.posZ = bodyPos.z + awayDir.z * safeDist;

        // Head AWAY from the body — camera (behind player) ends up close to body
        this.player.headToward(
          this.player.posX + awayDir.x,
          this.player.posZ + awayDir.z,
          this.player.posY + awayDir.y,
        );
      }

      // Restore speed and movement — set a gentle system speed for nearby flight
      this.player.speedMultiplier = Math.max(this.preLandSpeed, PlayerShip.SPEED_DEFAULT);
      this.player.systemSpeedMultiplier = 0.02; // ~6k km/s — slow near planet
      this.inSystemMode = true; // force system mode display since we're near the body
      this.player.moving = true;
    }
    this.player.group.visible = this.showShip;
    this.updateSpeedSlider();

    // Reset OrbitControls — disable on touch devices during flight
    this.controls.enabled = !this.isTouchDevice;
    this.controls.autoRotate = false;
    this.controls.minDistance = 0.00001;
    this.controls.maxDistance = 5;
    this.resetCruiseCamera();

    // Restore autopilot
    this.autopilot = this.preLandAutopilot;
    this.updateAutopilotButton();

    this.landedOn = null;
    document.body.classList.remove('planetarium-landed');

    // Restore bottom bar (hidden by updateMissionControlState when landedOn was set)
    const bottomBar = document.getElementById('planetarium-bottom-bar');
    if (bottomBar) bottomBar.style.display = '';

    // UI: restore flight controls, hide leave button
    const speedGroup = document.querySelector('.bar-speed-main .speed-group') as HTMLElement | null;
    if (speedGroup) speedGroup.classList.remove('inert');
    const show: Array<[string, string]> = [
      ['planetarium-btn-travel', ''],
      ['planetarium-btn-autopilot', ''],
    ];
    for (const [id, display] of show) {
      const el = document.getElementById(id);
      if (el) el.style.display = display;
    }
    // Conditionally show touch/keyboard hints
    const isTouchDevice = 'ontouchstart' in window;
    const keysHint = document.getElementById('planetarium-keys-hint');
    if (keysHint) keysHint.style.display = isTouchDevice ? 'none' : '';
    const touchZone = document.getElementById('touch-flight-zone');
    if (touchZone) touchZone.style.display = isTouchDevice ? '' : 'none';

    const leaveBtn = document.getElementById('planetarium-btn-leave');
    if (leaveBtn) leaveBtn.style.display = 'none';

    this.shadowVisuals.detach();
    this.orbitDetailsVisuals.detach();
    this.hideOrbitFocusLabels();
    this.orbitPairMoon = null;
    this.orbitSampledSubject = null;
    this.observatoryPanel.setOrbitDetailsAvailable(false);
    this.observatoryPanel.setOrbitReadout(null);
    // The guide camera pass only runs while landed — takeoff is its last
    // word, so the reticle must drop here, not wait for a pass that won't come.
    this.hideFootprintReticle();
    this.updateObservatoryButtonVisibility();
    this.notification.show(`Departing ${bodyName}`);
  }

  private updateLanded(dt: number) {
    if (!this.solarSystem) return;

    // Advance astronomical time — planets keep moving/rotating
    this.timeState = advancePlanetariumTime(this.timeState, dt);
    this.rebuildPlanetPositions(dt);

    // Track the landed body: update player position to body's world position
    const bodyPos = this.getLandedBodyWorldPosition();
    if (bodyPos) {
      this.player.posX = bodyPos.x;
      this.player.posY = bodyPos.y;
      this.player.posZ = bodyPos.z;
    }

    // Apply floating origin (scene offset by player = body position). The
    // landed body — planet or moon — renders exactly at scene origin because
    // its mesh position comes from the same seam the player tracks.
    this.applyFloatingOrigin();
    if (this.landedView !== 'surface') {
      this.controls.target.set(0, 0, 0);
      this.controls.update();
    }

    this.fpsFrames++;
    const fpsNow = performance.now();
    const fpsElapsed = (fpsNow - this.fpsLastTime) / 1000;
    if (fpsElapsed >= 0.5) {
      this.fpsDisplay = Math.round(this.fpsFrames / fpsElapsed);
      this.fpsFrames = 0;
      this.fpsLastTime = fpsNow;
    }

    this.uiRefreshAccumulator += dt;
    const shouldRefreshUi = this.uiRefreshAccumulator >= PlanetariumMode.UI_REFRESH_INTERVAL_S;
    if (shouldRefreshUi) {
      this.uiRefreshAccumulator %= PlanetariumMode.UI_REFRESH_INTERVAL_S;
    }

    this.updatePlanetScaling();
    this.updateMoonPositions();
    // Same same-frame-geometry rule as the cruise path — and the landed
    // Observatory telescope (narrow FOV) is exactly where 2K softness shows,
    // so the 4K trigger keeps running while landed.
    this.updateTextureLOD();
    this.updateShadowVisuals();
    if (shouldRefreshUi) this.updateOrbitDetails();
    this.pumpObservatoryEventSearch();

    // Occlusion pipeline while landed: planets → moons + ship → labels.
    // Surface view and the labels setting: the label containers are hidden
    // and these per-frame renders would re-show them — the pipeline only
    // feeds labels, skip it.
    if (this.planetLabels && this.landedView !== 'surface' && this.showBodyLabels) {
      const scenePositions = new Map<string, { x: number; y: number; z: number }>();
      for (const planet of this.solarSystem.planets) {
        scenePositions.set(planet.data.name, {
          x: planet.group.position.x,
          y: planet.group.position.y,
          z: planet.group.position.z,
        });
      }
      this.planetLabels.collectForegroundDiscs(scenePositions, this.renderer);
      this.collectDynamicOccluders();
      const landedPlanetName = this.landedOn?.type === 'planet' ? this.landedOn.name : undefined;
      this.planetLabels.renderLabels(scenePositions, { x: 0, y: 0, z: 0 }, this.renderer, landedPlanetName);
    }

    // Update constellation labels while landed
    if (this.constellations && this.showConstellations) {
      this.constellations.updateLabels(
        this.camera,
        this.renderer.domElement.clientWidth,
        this.renderer.domElement.clientHeight,
      );
    }

    if (this.landedView !== 'surface' && this.showBodyLabels) {
      this.renderMoonLabels();
      this.updateSunLabel();
    }
    this.updateSunShader(dt);
    this.updateOrbitLineVisibility();

    // Surface camera last — after updateMoonPositions/updateShadowVisuals —
    // so the vantage and look target use this frame's positions (the skipped
    // controls block above runs before those refreshes).
    if (this.landedView === 'surface') {
      this.updateSurfaceCamera(dt);
    }
    this.updateShadowGuideCamera();
    this.updateOrbitFocusLabels();

    if (shouldRefreshUi) {
      this.invalidateExpiredObservatoryEvents();
      this.updateStatsUI();
      this.updateTimeUI();
      this.renderObservatoryPanel();
      if (this.landedView === 'surface') this.renderSurfaceHud();
    }
  }

  manualSave() {
    this.store.saveState(this.getState());
  }

  private getState(): PlanetariumState {
    // While a tutorial runs, every persistence caller gets the pre-tutorial snapshot
    // (timestamp refreshed): the 30s autosave, the ☰ Save button, manualSave,
    // and deactivate's final save all keep writing the journey the user left,
    // never the staged showcase — so a reload mid-tutorial resumes the pre-tutorial
    // state. Any reader that wants the LIVE scene (the way
    // rememberPreMissionState stashes a mission return point) must run after
    // the tutorial has stopped; the mission-start hook does exactly that.
    if (this.tutorial) {
      return { ...this.tutorial.snapshot.state, timestamp: Date.now() };
    }
    return {
      positionAU: { x: this.player.posX, y: this.player.posY, z: this.player.posZ },
      headingRad: this.player.heading,
      pitchRad: this.player.pitch,
      // When landed, speed/autopilot are zeroed — save the pre-land originals
      // so they restore correctly on load.
      speed: this.landedOn ? this.preLandSpeed : this.player.speedMultiplier,
      moving: this.landedOn ? false : this.player.moving,
      visitedPlanets: Array.from(this.player.visitedPlanets),
      distanceTraveled: this.player.distanceTraveled,
      timeElapsed: this.player.timeElapsed,
      timestamp: Date.now(),
      autopilot: this.landedOn ? this.preLandAutopilot : this.autopilot,
      layoutMode: this.layoutMode,
      astroTimeUtcMs: this.timeState.currentUtcMs,
      astroTimeRate: this.timeState.rate,
      astroTimePaused: this.timeState.paused,
      planetScale: this.planetScale,
      showShip: this.showShip,
      showConstellations: this.showConstellations,
      showBodyLabels: this.showBodyLabels,
      showOrbitLines: this.showOrbitLines,
      landedOn: this.landedOn,
      systemSpeed: this.player.systemSpeedMultiplier,
      systemSlowdown: this.systemSlowdown,
      autopilotTarget: this.autopilotTarget,
      autopilotUserEngaged: this.autopilotUserEngaged,
      // Absent until the user flips the toggle — JSON.stringify drops the
      // undefined, so an untouched preference never bakes a device default
      // into the save.
      skyPref: this.skyPrefStored ?? undefined,
    };
  }

  private restoreState(saved: PlanetariumState) {
    this.player.posX = saved.positionAU.x;
    this.player.posY = saved.positionAU.y;
    this.player.posZ = saved.positionAU.z;
    this.player.heading = saved.headingRad;
    this.player.pitch = saved.pitchRad ?? 0;
    this.player.speedMultiplier = saved.speed;
    this.player.moving = saved.landedOn ? false : (saved.moving ?? saved.speed > 0);
    // A restore is a position discontinuity; drop any ramped moon cap so a
    // flight resumed on the same mode instance (deactivate→reactivate) isn't
    // throttled by a value left over from wherever the ship last was.
    this.moonCapEased = Infinity;
    this.player.distanceTraveled = saved.distanceTraveled;
    this.player.timeElapsed = saved.timeElapsed;
    this.player.visitedPlanets = new Set(saved.visitedPlanets);

    this.autopilot = saved.autopilot;
    this.layoutMode = 'realistic';
    this.timeState = {
      currentUtcMs: saved.astroTimeUtcMs,
      rate: saved.astroTimeRate ?? 1,
      paused: saved.astroTimePaused ?? false,
    };
    this.planetScale = 1; // Always use true scale regardless of saved value
    this.player.systemSpeedMultiplier = saved.systemSpeed ?? PlayerShip.SYSTEM_SPEED_DEFAULT;
    this.systemSlowdown = saved.systemSlowdown ?? true;
    const throttleLabel = document.getElementById('settings-throttle-label');
    if (throttleLabel) throttleLabel.textContent = this.systemSlowdown ? 'On' : 'Off';
    this.showShip = saved.showShip;
    this.player.group.visible = this.showShip;
    this.showConstellations = saved.showConstellations ?? false;
    if (this.showConstellations) {
      this.ensureConstellationsReady();
    } else if (this.constellations) {
      this.constellations.setVisible(false);
    }
    const constLabel = document.getElementById('settings-constellations-label');
    if (constLabel) constLabel.textContent = this.showConstellations ? 'On' : 'Off';
    this.showBodyLabels = saved.showBodyLabels ?? true;
    this.applyBodyLabelVisibility();
    const labelsLabel = document.getElementById('settings-labels-label');
    if (labelsLabel) labelsLabel.textContent = this.showBodyLabels ? 'On' : 'Off';
    this.showOrbitLines = saved.showOrbitLines ?? false;
    const orbitsLabel = document.getElementById('settings-orbits-label');
    if (orbitsLabel) orbitsLabel.textContent = this.showOrbitLines ? 'On' : 'Off';

    // Restore autopilot target (kept even when landed — resumes on exit).
    // Pre-provenance saves migrate by heuristic in the store sanitizer (only
    // user picks ever produce a non-Mercury target).
    this.autopilotTarget = saved.autopilotTarget ?? null;
    this.autopilotUserEngaged = saved.autopilotUserEngaged ?? false;
    this.updateAutopilotButton();
    this.skyPrefStored = saved.skyPref ?? null;
    const shipLabel = document.getElementById('settings-ship-label');
    if (shipLabel) shipLabel.textContent = this.showShip ? 'On' : 'Off';

    this.rebuildPlanetPositions();

    this.updateSpeedSlider();
    this.updateTimeUI();

    if (saved.landedOn) {
      this.enterLandedMode(saved.landedOn);
    } else {
      this.resetCruiseCamera();
    }
  }

  private getTargetWorldPosition(target: NonNullable<LandedTarget>): { x: number; y: number; z: number } | null {
    if (target.type === 'planet') {
      return this.planetWorldPositions.get(target.name) ?? null;
    }
    // For moons, use precise position when available; fall back to parent planet
    return this.moonWorldPositions.get(target.name)
      ?? this.planetWorldPositions.get(target.parentPlanet)
      ?? null;
  }

  private applyAutopilot() {
    if (!this.autopilotTarget) return;
    const pos = this.getTargetWorldPosition(this.autopilotTarget);
    if (!pos) return;
    this.player.headToward(pos.x, pos.z, pos.y);
  }

  private engageAutopilot(target: NonNullable<LandedTarget>) {
    this.autopilotTarget = target;
    this.autopilot = true;
    this.autopilotUserEngaged = true;
    this.player.moving = true;
    if (this.player.speedMultiplier < PlayerShip.SPEED_DEFAULT) {
      this.player.speedMultiplier = PlayerShip.SPEED_DEFAULT;
    }
    this.updateSpeedSlider();
    this.updateAutopilotButton();
    this.notification.show(`Autopilot: heading to ${target.name}`);
  }

  private disengageAutopilot() {
    this.autopilotTarget = null;
    this.autopilot = false;
    this.autopilotUserEngaged = false;
    this.updateAutopilotButton();
  }

  private disableAutopilot() {
    if (!this.autopilot) return;
    this.disengageAutopilot();
    this.notification.show('Manual flight — steer freely');
  }

  private updateAutopilotButton() {
    const btn = document.getElementById('planetarium-btn-autopilot');
    if (!btn) return;
    btn.classList.toggle('active', this.autopilot);
    // Only a destination the user picked widens the chip with its name — a
    // target migrated from an old save without provenance stays label-free.
    const target = this.autopilotUserEngaged ? this.autopilotTarget : null;
    btn.classList.toggle('act-wide', target !== null);
    // Set only the label span — the SVG glyph sibling must survive every update.
    const lbl = btn.querySelector('.autopilot-lbl');
    if (lbl) lbl.textContent = target ? target.name : '';
    const tip = btn.querySelector('.act-tip');
    if (tip) {
      tip.innerHTML = this.autopilot
        ? 'Autopilot engaged — click to disengage'
        : 'Pilot <kbd>P</kbd>';
    }
  }

  private toggleAutopilot() {
    if (this.autopilot) {
      this.disengageAutopilot();
      this.notification.show('Autopilot disengaged');
    } else {
      // Idle there is never a stored destination (disengaging clears it), so
      // engaging always starts at the picker: the deck's Autopilot tab.
      this.toggleDeck('pilot');
    }
  }

  private checkAutopilotArrival() {
    if (!this.autopilotTarget) return;
    const pos = this.getTargetWorldPosition(this.autopilotTarget);
    if (!pos) return;
    const dx = this.player.posX - pos.x;
    const dy = this.player.posY - pos.y;
    const dz = this.player.posZ - pos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    let threshold: number;
    if (this.autopilotTarget.type === 'planet') {
      const body = PLANETARIUM_BODIES.find(b => b.name === this.autopilotTarget!.name);
      threshold = body ? body.systemRadiusAU * 0.3 : 0.003;
    } else {
      const moons = this.planetMoons.get(this.autopilotTarget.parentPlanet);
      const moonMesh = moons?.find(m => m.data.name === this.autopilotTarget!.name);
      threshold = moonMesh ? Math.max(moonMesh.data.radiusAU * 10, 0.0003) : 0.0003;
    }

    if (dist < threshold) {
      const name = this.autopilotTarget.name;
      this.disengageAutopilot();
      this.notification.show(`Arrived at ${name}`);
    }
  }

  /**
   * Re-sample the orbit lines when the sim clock has drifted from the epoch
   * they were sampled at. The realistic lines are the bodies' rendered
   * trajectories over one period centered on that epoch, so each planet sits
   * on its own line by construction — but only near the epoch: past half a
   * period (Mercury: 44 d) a body re-treads a loop that has precessed a
   * little, and year-over-year perturbation wiggle (Earth: ~0.5 R⊕) creeps
   * in. 60 days keeps every body within ~a third of its own radius of the
   * drawn line (pinned in SolarSystem.test.ts) for a few-ms resample a
   * handful of times per simulated year. Mechanics live in resampleOrbitLines.
   */
  private rebuildOrbitLinesIfStale() {
    if (!this.solarSystem || this.layoutMode !== 'realistic') return;
    const SIXTY_DAYS_MS = 60 * 86_400_000;
    if (Math.abs(this.timeState.currentUtcMs - this.solarSystem.orbitLinesEpochUtcMs) < SIXTY_DAYS_MS) {
      return;
    }
    resampleOrbitLines(this.solarSystem, this.layoutMode, this.timeState.currentUtcMs);
  }

  rebuildPlanetPositions(_dt = 0) {
    if (!this.solarSystem) return;
    this.rebuildOrbitLinesIfStale();
    for (let i = 0; i < this.solarSystem.planets.length; i++) {
      const planet = this.solarSystem.planets[i];
      const body = PLANETARIUM_BODIES[i];
      const state = computeBodyState(body, this.timeState.currentUtcMs);

      planet.group.quaternion.copy(state.orientationQuaternion);
      planet.mesh.rotation.y = 0;
      if (planet.cloudsMesh) {
        const cloudDrift = body.name === 'Earth'
          ? ((this.timeState.currentUtcMs / 3_600_000) * 0.02) % (Math.PI * 2)
          : 0;
        planet.cloudsMesh.rotation.y = cloudDrift;
      }
      const localSunDir = this.tmpLocalSunDir
        .copy(state.sunDirection)
        .applyQuaternion(this.tmpInvGroupQuat.copy(planet.group.quaternion).invert());
      if (planet.nightMaterial) {
        planet.nightMaterial.uniforms.sunDirection.value.copy(localSunDir);
      }
      if (planet.fx) {
        planet.fx.uSunDirWorld.value.copy(state.sunDirection);
        planet.fx.uSunDirLocal.value.copy(localSunDir);
      }
      if (planet.ringFx) {
        planet.ringFx.uSunDirLocal.value.copy(localSunDir);
        planet.ringFx.uSunDirWorld.value.copy(state.sunDirection);
      }
      if (planet.atmosphere) {
        const atmoMat = planet.atmosphere.material as THREE.ShaderMaterial;
        if (atmoMat.uniforms.uSunDirWorld) {
          atmoMat.uniforms.uSunDirWorld.value.copy(state.sunDirection);
        }
      }

      planet.group.userData.worldPosAU = {
        x: state.positionAU.x,
        y: state.positionAU.y,
        z: state.positionAU.z,
      };
      this.planetWorldPositions.set(body.name, {
        x: state.positionAU.x,
        y: state.positionAU.y,
        z: state.positionAU.z,
      });
    }
  }

  private stepTimeRate(direction: -1 | 1) {
    this.timeState = stepSimulationRate(this.timeState, direction, TIME_RATE_PRESETS);
    this.updateTimeUI({ flash: true });
  }

  private updateTimeUI(opts?: { flash?: boolean }) {
    this.timePanel.render(this.timeState, opts);
    const gyroLabel = document.getElementById('settings-gyro-label');
    if (gyroLabel) gyroLabel.textContent = this.gyro.statusLabel();
    const gyroToggle = document.getElementById('settings-gyro-toggle');
    if (gyroToggle) {
      gyroToggle.classList.toggle('active', this.gyro.enabled);
      gyroToggle.setAttribute('aria-pressed', this.gyro.enabled ? 'true' : 'false');
      const status = this.gyro.statusLabel();
      gyroToggle.setAttribute('title',
        status === 'Denied'
          ? 'Motion sensor permission was denied'
          : status === 'N/A'
            ? 'Motion sensors are not available on this device'
            : this.gyro.enabled
              ? 'Gyro steering is active'
              : 'Enable gyro steering',
      );
    }
  }

  private setFlightTouchFromPoint(clientX: number, clientY: number) {
    const zone = document.getElementById('touch-flight-zone');
    if (!zone) return;
    const rect = zone.getBoundingClientRect();
    const rawX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const rawY = 1 - ((clientY - rect.top) / rect.height) * 2;
    const applyDeadZone = (value: number) => {
      const deadZone = 0.12;
      if (Math.abs(value) < deadZone) return 0;
      return THREE.MathUtils.clamp(
        ((Math.abs(value) - deadZone) / (1 - deadZone)) * Math.sign(value),
        -1,
        1,
      );
    };

    this.touchYaw = applyDeadZone(rawX);
    this.touchPitch = applyDeadZone(rawY);
  }

  dispose() {
    this.deactivate();
    resetTextureWarmer(); // drop queued warm-ups and the renderer binding with the mode
    this.moonTexturer.dispose();
    this.notification.dispose();
    if (this.planetLabels) {
      this.planetLabels.dispose();
      this.planetLabels = null;
    }
    if (this.moonLabelContainer) {
      this.moonLabelContainer.remove();
      this.moonLabelContainer = null;
      this.moonLabels.clear();
    }
    this.sunLabel.dispose();
    this.shadowVisuals.dispose();
    this.orbitDetailsVisuals.dispose();
    this.hideOrbitFocusLabels();
    if (this.solarSystem) {
      this.solarSystem.sun.removeFromParent();
      this.solarSystem.asteroidBelt.removeFromParent();
      for (const p of this.solarSystem.planets) p.group.removeFromParent();
      for (const o of this.solarSystem.orbitLines) {
        o.removeFromParent();
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
      for (const g of this.moonSystemGroups.values()) g.removeFromParent();
    }
    this.player.group.removeFromParent();
    if (this.starfield) this.starfield.removeFromParent();
    if (this.constellations) {
      this.constellations.dispose();
      this.constellations = null;
    }
  }
}
