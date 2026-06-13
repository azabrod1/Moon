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
import { createMoonMeshes, paintMoonTextures, type MoonMesh } from './PlanetFactory';
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
  MARKER_BRACKETS_MIN_PX,
  projectedDiscPx,
  resolveMarkerKind,
  selectSurfaceTarget,
  SURFACE_FOV_DEFAULT_DEG,
  SURFACE_FOV_MIN_DEG,
  SURFACE_TARGET_ELEVATION_DEG,
  surfaceAltitudeAU,
  surfaceEventExpectation,
  surfaceEventNarrative,
  transportTrackingUp,
  type SurfaceEntryContext,
  type SurfaceMarkerKind,
  type SurfaceTarget,
} from './surfaceView';
import { DEG2RAD } from '../shared/math/angles';
import { KM_CONSTANTS } from '../shared/constants/physicalData';
import { smoothstepUnclamped } from '../shared/math/smoothstep';
import { projectToScreen, type ScreenProjection } from '../shared/three/projectToScreen';
import { setText } from '../shared/dom';
import { Constellations } from './Constellations';
import { getMoonsByPlanet, type MoonData } from './planets/moonData';
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
import { SunLabel } from './ui/SunLabel';

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
  private static readonly TIME_RATE_PRESETS = [1, 60, 1200, 3600, 21600, 86400, 604800, 2592000, 31557600];
  private static readonly SHIP_CLEARANCE_AU = (1_737.4 / KM_PER_AU) * 1.5;
  // Conservative disc radius for ship occlusion. Default hull is ~3 moon-radii
  // long with 0.5x group scale applied → half-length ≈ 0.75 moon-radii.
  private static readonly SHIP_OCCLUDER_RADIUS_AU = (1_737.4 / KM_PER_AU) * 0.75;
  private static readonly UI_REFRESH_INTERVAL_S = 1 / 8;
  private static readonly SCENE_NORTH = new THREE.Vector3(0, 1, 0);
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
  private showOrbitLines = true;

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
  // and the synchronous gate paint when a system is about to become visible.
  private moonPainter = new MoonPainter(paintMoonTextures);
  private static readonly MOON_PAINT_FRAME_BUDGET_MS = 8;
  // Arrival veil re-entrancy guard (rapid picks, or a pick while one is running).
  private arrivalInFlight = false;
  private static readonly ARRIVAL_MIN_DWELL_MS = 150;
  private tmpMoonOffset = new THREE.Vector3();
  private tmpMoonOrbitNormal = new THREE.Vector3();
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

  // Autopilot: auto-steer toward target
  private autopilot = true;
  private autopilotTarget: NonNullable<LandedTarget> | null = null;
  // Provenance: did the user pick the target, or is it the onboarding default?
  // Only user-engaged targets render the "→ name" chip or survive a landing.
  private autopilotUserEngaged = false;

  // Moon world positions in AU (true positions, not offset)
  private moonWorldPositions = new Map<string, { x: number; y: number; z: number }>();

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
  private observatoryExcursion: {
    posX: number; posY: number; posZ: number;
    heading: number; pitch: number;
    speedMultiplier: number; systemSpeedMultiplier: number;
    inSystemMode: boolean; moving: boolean;
  } | null = null;
  private nearbyLandTarget: NonNullable<LandedTarget> | null = null;
  private travelSelection: NonNullable<LandedTarget> | null = null;

  // Surface view (Observatory): narrow-FOV look-from-the-surface sub-state of
  // landed mode. Session-only — never persisted; restore always lands in orbit
  // view. While active, OrbitControls hand over to SurfaceLook and the camera
  // is re-pinned every frame at the end of updateLanded.
  private landedView: 'orbit' | 'surface' = 'orbit';
  private surfaceTarget: SurfaceTarget = { kind: 'sun' };
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
  private timePanel = new PlanetariumTimePanel();
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

  // Shared clock handlers — the time popover and the surface transport
  // strip drive the same state through these (one clock, one idiom).
  private timeTogglePause() {
    this.timeState.paused = !this.timeState.paused;
    this.updateTimeUI();
  }

  private timeJumpToNow() {
    this.timeState.currentUtcMs = Date.now();
    this.rebuildPlanetPositions();
    this.updateTimeUI();
    // Clock jump invalidates the Observatory panel's upcoming-events list.
    this.startObservatoryEventSearch();
  }

  async activate(onProgress?: (progress: PlanetariumActivationProgress) => void): Promise<void> {
    this.active = true;
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
    this.speedValueEl = document.getElementById('planetarium-speed-value');
    this.speedLabelEl = document.getElementById('planetarium-speed-label');
    this.speedCenterEl = document.querySelector('.speed-center') as HTMLElement | null;

    const savedState = await this.store.loadState();
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
      this.scene.add(this.solarSystem.ambientLight);
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
      this.pointTowardMercury();
      // Auto-engage autopilot toward Mercury for new users — an onboarding
      // default, not a user destination (no chip; retired on first landing).
      this.autopilotTarget = { type: 'planet', name: 'Mercury' };
      this.autopilot = true;
      this.autopilotUserEngaged = false;
      this.updateAutopilotButton();
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
    this.autopilotTarget = { type: 'planet', name: 'Mercury' };
    this.autopilot = true;
    this.autopilotUserEngaged = false;
    this.updateAutopilotButton();
    this.showIntroText();
  }

  deactivate(): void {
    this.resumePrompt.cancel();

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
    this.closeObservatoryMenu();

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
      this.solarSystem.ambientLight.visible = visible;
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

      this.player.update(dt);
    }
    this.timeState = advancePlanetariumTime(this.timeState, dt);
    this.rebuildPlanetPositions(dt);

    // Apply floating origin: offset everything by player position
    this.applyFloatingOrigin();

    this.updateCameraFollow();
    this.controls.update();

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
    this.resolvePlanetCollisions();

    // Check orbit crossings and visits after scale/collision are applied so the
    // reachable interaction shell matches the visual shell.
    this.checkOrbitCrossings();
    this.checkPlanetVisits();
    this.checkProximityLand();

    // Position moon meshes first so `collectDynamicOccluders` can read their
    // scene-space positions and record discs for label culling.
    this.updateMoonPositions();

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

  private updateCameraFollow() {
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
          glowMat.uniforms.alphaScale.value = 0.15 + 0.3 * t;
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
   * First pass: position moon meshes, update visibility, and record world AU
   * positions. Label placement is split into `renderMoonLabels()` so that
   * moon labels can consult the full set of foreground occluders (planets,
   * other moons, ship) gathered mid-frame.
   */
  private updateMoonPositions() {
    if (!this.solarSystem) return;
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

        this.moonWorldPositions.set(m.data.name, {
          x: wp.x + offset.x,
          y: wp.y + offset.y,
          z: wp.z + offset.z,
        });

        const realRatio = m.data.radiusAU / parentR;
        const minRatio = 0.05;
        // Surface view sees true angular sizes: the landed system drops the
        // small-moon visual floor while it's active (an Io silhouette on the
        // Sun must be Io-sized, and a landed small moon's inflated mesh must
        // not swallow the vantage point). Orbit view keeps the floor.
        const trueScale =
          this.landedView === 'surface' &&
          planet.data.name === this.observatoryParentPlanetName();
        if (!trueScale && realRatio < minRatio) {
          m.mesh.scale.setScalar(minRatio / realRatio);
        } else {
          m.mesh.scale.setScalar(1);
        }
      }
    }

    // Background drain: paint a slice of any still-queued systems, the one the
    // player is in/heading toward first. Costs nothing once everything's painted.
    if (!this.moonPainter.isEmpty()) {
      const target = this.autopilotTarget ?? this.landedOn;
      const targetSystem = target ? this.parentSystemOf(target) : null;
      const preferred =
        targetSystem && this.moonPainter.hasPending(targetSystem) ? targetSystem : nearestPending;
      this.moonPainter.pump(PlanetariumMode.MOON_PAINT_FRAME_BUDGET_MS, preferred);
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
        // Effective rendered radius: small moons are scaled up to a floor ratio.
        const effectiveRadiusAU = Math.max(m.data.radiusAU, 0.05 * parentR);
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

    // Escape always works — even while typing in search input
    if (e.key === 'Escape') {
      if (this.isHelpOpen()) { this.hideHelp(); return; }
      if (this.isTravelMenuOpen()) { this.closeTravelMenu(); return; }
      if (this.isObservatoryMenuOpen()) { this.closeObservatoryMenu(); return; }
      if (this.landedView === 'surface') { this.exitSurfaceView(); return; }
      if (this.observatoryPanel.isOpen()) { this.closeObservatoryPanel(); return; }
      if (this.landedOn) { this.exitLandedMode(); return; }
    }

    // Don't capture other keys if typing in an input
    if ((e.target as HTMLElement).tagName === 'INPUT') return;

    // T opens/closes travel menu (not from the surface view — its label and
    // chrome state would leak; exit the view first)
    if (e.key.toLowerCase() === 't') {
      if (this.isMissionActive() || this.landedView === 'surface') return;
      this.toggleTravelMenu();
      // The toggle focuses the search input; without this the same keystroke
      // then types "t" into it and the list opens pre-filtered.
      e.preventDefault();
      return;
    }

    // Suppress all other keys while landed
    if (this.landedOn) return;
    if (this.isMissionActive()) return;

    this.keys.add(e.key.toLowerCase());

    // Space toggles pause
    if (e.key === ' ') {
      e.preventDefault();
      this.player.moving = !this.player.moving;
    }

    // P toggles autopilot
    if (e.key.toLowerCase() === 'p') {
      this.toggleAutopilot();
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

    // Auto-disable override when leaving all planet systems
    if (this.throttleOverride && this.systemSpeedFactor >= 1.0) {
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
      if (this.inSystemMode) {
        this.speedValueEl.textContent = this.player.systemSpeedMultiplier < 0.0005
          ? '0 km/s'
          : this.formatSystemSpeed(this.player.systemSpeedMultiplier);
      } else {
        this.speedValueEl.textContent = this.player.speedMultiplier < 0.01
          ? '0c'
          : `${this.player.speedC.toFixed(1)}c`;
      }
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
      this.closeTravelMenu();
      this.closeObservatoryMenu();
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
      this.notification.show('Game saved!');
    });

    // New Journey button
    document.getElementById('planetarium-btn-new')?.addEventListener('click', () => {
      // The reset throws the journey away — the excursion return pose with it.
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
      this.autopilotTarget = { type: 'planet', name: 'Mercury' };
      this.autopilot = true;
      this.updateAutopilotButton();
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
      // If landed, take off first so the travel menu can actually fly
      // somewhere (on an Observatory excursion that's the return-to-cruise
      // pose — deliberate: leaving by any door goes back where you were).
      if (this.landedOn) this.exitLandedMode();
      this.toggleAutopilot();
    });

    // Menu panel toggle — auto-pause while open
    document.getElementById('planetarium-btn-menu')?.addEventListener('click', () => {
      if (this.menuPanel.isOpen()) {
        this.closeMenuPanel();
      } else {
        // One modal at a time (the body menus close ☰ on open, symmetric).
        this.closeTravelMenu();
        this.closeObservatoryMenu();
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
    document.getElementById('planetarium-help-close')?.addEventListener('click', () => this.hideHelp());
    document.querySelector('#planetarium-help .planetarium-help-backdrop')?.addEventListener('click', () => this.hideHelp());

    document.getElementById('planetarium-btn-historic')?.addEventListener('click', () => {
      const submenu = document.getElementById('planetarium-historic-submenu');
      const trigger = document.getElementById('planetarium-btn-historic');
      const expanded = submenu?.classList.toggle('visible') ?? false;
      trigger?.classList.toggle('expanded', expanded);
    });

    this.bottomBar.bind();

    this.sunLabel.attach();

    // Astronomy time controls
    document.getElementById('planetarium-time-pause')?.addEventListener('click', () => {
      this.timeTogglePause();
    });
    document.getElementById('planetarium-time-play')?.addEventListener('click', () => {
      this.timeState.paused = false;
      if (this.timeState.rate < 0) this.timeState.rate *= -1;
      this.updateTimeUI();
    });
    document.getElementById('planetarium-time-reverse')?.addEventListener('click', () => {
      this.timeState.paused = false;
      this.timeState.rate = -Math.abs(this.timeState.rate);
      this.updateTimeUI();
    });
    document.getElementById('planetarium-time-slower')?.addEventListener('click', () => {
      this.stepTimeRate(-1);
    });
    document.getElementById('planetarium-time-faster')?.addEventListener('click', () => {
      this.stepTimeRate(1);
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

    // Travel menu
    document.getElementById('planetarium-btn-travel')?.addEventListener('click', () => {
      if (this.isMissionActive()) return;
      // If landed, take off first so the travel menu can actually fly somewhere.
      if (this.landedOn) this.exitLandedMode();
      this.toggleTravelMenu();
    });
    document.getElementById('travel-menu-close')?.addEventListener('click', () => {
      this.closeTravelMenu();
    });
    const travelSearch = document.getElementById('travel-search') as HTMLInputElement;
    travelSearch?.addEventListener('input', () => {
      this.filterBodyList(document.getElementById('travel-list'), travelSearch.value);
    });
    document.getElementById('observatory-menu-close')?.addEventListener('click', () => {
      this.closeObservatoryMenu();
    });
    const observatorySearch = document.getElementById('observatory-search') as HTMLInputElement;
    observatorySearch?.addEventListener('input', () => {
      this.filterBodyList(document.getElementById('observatory-list'), observatorySearch.value);
    });
    document.getElementById('planetarium-btn-leave')?.addEventListener('click', () => {
      this.exitLandedMode();
    });
    // One button, one meaning: the vantage menu, cruising or landed.
    // Landed, picking another body re-lands directly; picking the body
    // you're on just (re)opens its panel.
    document.getElementById('planetarium-btn-observatory')?.addEventListener('click', () => {
      if (this.isMissionActive()) return;
      this.toggleObservatoryMenu();
    });
    document.getElementById('planetarium-btn-land')?.addEventListener('click', () => {
      if (this.nearbyLandTarget) {
        this.enterLandedMode(this.nearbyLandTarget);
      }
    });
    // Travel action bar: Fly To, Jump, Land
    document.getElementById('travel-action-fly')?.addEventListener('click', () => {
      if (!this.travelSelection) return;
      const selectedTarget = this.travelSelection;
      this.closeTravelMenu();
      if (this.landedOn) this.exitLandedMode();
      this.engageAutopilot(selectedTarget);
    });
    document.getElementById('travel-action-land')?.addEventListener('click', () => {
      if (this.travelSelection) {
        const selectedTarget = this.travelSelection;
        this.closeTravelMenu();
        this.arriveThen(selectedTarget, () => {
          // The T-key opens this menu while landed: exit first so the landing
          // gets the full ceremony — preLand* captured from real flight state,
          // and any excursion stash consumed rather than outliving its landing
          // (Leave from the new body must not teleport to a stale cruise pose).
          if (this.landedOn) this.exitLandedMode();
          this.enterLandedMode(selectedTarget);
        });
      }
    });
    document.getElementById('travel-action-jump')?.addEventListener('click', () => {
      if (this.travelSelection) {
        const selectedTarget = this.travelSelection;
        this.closeTravelMenu();
        this.arriveThen(selectedTarget, () => {
          if (this.landedOn) this.exitLandedMode();
          if (selectedTarget.type === 'planet') {
            const body = PLANETARIUM_BODIES.find(b => b.name === selectedTarget.name);
            if (body) this.jumpToPlanet(body);
          } else {
            // Jump near the moon's parent planet
            const body = PLANETARIUM_BODIES.find(b => b.name === selectedTarget.parentPlanet);
            if (body) this.jumpToPlanet(body);
          }
        });
      }
    });
    this.buildTravelList();
    this.buildObservatoryList();

    this.updateTimeUI();
    this.updateMissionControlState();
  }

  /**
   * Populate a planets-and-moons list (travel menu + observatory menu share
   * the layout; they differ in which bodies appear and what a tap does).
   */
  private buildBodyList(
    list: HTMLElement,
    opts: {
      filter?: (target: NonNullable<LandedTarget>) => boolean;
      onPick: (target: NonNullable<LandedTarget>) => void;
    },
  ) {
    list.innerHTML = '';

    for (const body of PLANETARIUM_BODIES) {
      const planetTarget = { type: 'planet', name: body.name } as const;
      if (!opts.filter || opts.filter(planetTarget)) {
        const item = document.createElement('button');
        item.className = 'travel-item';
        item.dataset.type = 'planet';
        item.dataset.name = body.name;
        item.innerHTML = `
          <span class="travel-item-dot" style="background:#${body.color.toString(16).padStart(6, '0')}"></span>
          <span class="travel-item-info">
            <span class="travel-item-name">${body.name}</span>
            <span class="travel-item-detail">${body.description.split('.')[0]}</span>
          </span>`;
        item.addEventListener('click', () => opts.onPick(planetTarget));
        list.appendChild(item);
      }

      const moons = getMoonsByPlanet(body.name);
      for (const moon of moons) {
        const moonTarget = { type: 'moon', name: moon.name, parentPlanet: moon.parentPlanet } as const;
        if (opts.filter && !opts.filter(moonTarget)) continue;
        const moonItem = document.createElement('button');
        moonItem.className = 'travel-item travel-item-moon';
        moonItem.dataset.type = 'moon';
        moonItem.dataset.name = moon.name;
        moonItem.dataset.parent = moon.parentPlanet;
        moonItem.innerHTML = `
          <span class="travel-item-dot" style="background:#${moon.color.toString(16).padStart(6, '0')}"></span>
          <span class="travel-item-info">
            <span class="travel-item-name">${moon.name}</span>
            <span class="travel-item-detail">Moon of ${moon.parentPlanet} · r = ${moon.radiusKm.toLocaleString()} km</span>
          </span>`;
        moonItem.addEventListener('click', () => opts.onPick(moonTarget));
        list.appendChild(moonItem);
      }
    }
  }

  private buildTravelList() {
    const list = document.getElementById('travel-list');
    if (!list) return;
    this.buildBodyList(list, {
      onPick: (target) => this.selectTravelTarget(target),
    });
  }

  /** Subjects only: bodies whose system has catalog moons. Mercury/Venus stay
   * travel-only — their landed state has no Observatory panel to open. */
  private buildObservatoryList() {
    const list = document.getElementById('observatory-list');
    if (!list) return;
    this.buildBodyList(list, {
      filter: (target) => this.isObservatorySubject(target),
      onPick: (target) => this.pickObservatoryBody(target),
    });
  }

  private toggleTravelMenu(autopilotMode = false) {
    if (this.isMissionActive()) return;
    const menu = document.getElementById('travel-menu');
    if (!menu) return;
    const isVisible = menu.classList.contains('visible');
    if (isVisible) {
      this.closeTravelMenu();
    } else {
      // Close sibling popovers — one modal at a time
      this.closeMenuPanel();
      this.closeObservatoryMenu();
      menu.classList.add('visible');
      this.travelSelection = null;
      // Swap primary button styling based on mode
      const landBtn = document.getElementById('travel-action-land');
      const flyBtn = document.getElementById('travel-action-fly');
      if (landBtn && flyBtn) {
        if (autopilotMode) {
          flyBtn.className = 'travel-action-btn';
          landBtn.className = 'travel-action-btn travel-action-btn-dim';
        } else {
          landBtn.className = 'travel-action-btn';
          flyBtn.className = 'travel-action-btn travel-action-btn-dim';
        }
      }
      const actionBar = document.getElementById('travel-action-bar');
      if (actionBar) actionBar.style.display = 'none';
      // Hide planet/moon labels so they don't show through the menu
      this.setWorldLabelsVisible(false);
      const search = document.getElementById('travel-search') as HTMLInputElement;
      if (search) {
        search.value = '';
        this.filterBodyList(document.getElementById('travel-list'), '');
        if (!('ontouchstart' in window)) search.focus();
      }
    }
  }

  private closeTravelMenu() {
    const menu = document.getElementById('travel-menu');
    if (menu) menu.classList.remove('visible');
    this.travelSelection = null;
    this.setWorldLabelsVisible(true);
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

  /** Cruise-state Observatory entry: a travel-style menu of vantage bodies. */
  private toggleObservatoryMenu() {
    if (this.isMissionActive()) return;
    const menu = document.getElementById('observatory-menu');
    if (!menu) return;
    if (menu.classList.contains('visible')) {
      this.closeObservatoryMenu();
      return;
    }
    this.closeMenuPanel();
    this.closeTravelMenu();
    menu.classList.add('visible');
    this.setWorldLabelsVisible(false);
    // Landed, the menu doubles as the switch-body path — the
    // subtitle says so, and the current vantage is marked and scrolled into
    // view (Carme sits below thirty Jupiter rows; an off-screen marker is
    // no affordance at all). Picking the marked row just reopens the panel.
    setText(
      'observatory-menu-sub',
      this.landedOn
        ? 'Pick a vantage — or reopen this sky.'
        : 'Pick a vantage — you’ll land there with its sky open.',
    );
    const search = document.getElementById('observatory-search') as HTMLInputElement;
    if (search) {
      search.value = '';
      this.filterBodyList(document.getElementById('observatory-list'), '');
      if (!('ontouchstart' in window)) search.focus();
    }
    // After the filter reset: scrollIntoView on a row a stale search left
    // display:none would no-op, and rows un-hidden above it would shove the
    // marker off-screen anyway.
    this.markObservatoryCurrentRow();
  }

  /** Re-derived on every open: mark (and reveal) the landed body's row. */
  private markObservatoryCurrentRow() {
    const list = document.getElementById('observatory-list');
    if (!list) return;
    let current: HTMLElement | null = null;
    for (const item of list.querySelectorAll<HTMLElement>('.travel-item')) {
      const isCurrent =
        this.landedOn !== null &&
        item.dataset.type === this.landedOn.type &&
        item.dataset.name === this.landedOn.name;
      item.classList.toggle('travel-item-current', isCurrent);
      if (isCurrent) current = item;
    }
    if (current) current.scrollIntoView({ block: 'center' });
  }

  private closeObservatoryMenu() {
    const menu = document.getElementById('observatory-menu');
    if (!menu || !menu.classList.contains('visible')) return;
    menu.classList.remove('visible');
    this.setWorldLabelsVisible(true);
  }

  private isObservatoryMenuOpen(): boolean {
    return document.getElementById('observatory-menu')?.classList.contains('visible') ?? false;
  }

  /**
   * Observatory-menu pick: land on (or re-land to) the body and open its
   * panel. The panel opens here, at the pick site only — enterLandedMode
   * itself never auto-opens it (restore/proximity/Land & Orbit stay as-is).
   */
  private pickObservatoryBody(target: NonNullable<LandedTarget>) {
    if (this.isMissionActive()) return;
    this.closeObservatoryMenu();
    const sameBody =
      this.landedOn?.type === target.type && this.landedOn.name === target.name;
    const panelWasOpen = this.observatoryPanel.isOpen();
    const openPanel = () => {
      this.observatoryPanel.show();
      this.renderObservatoryPanel();
      this.startObservatoryEventSearch();
    };
    if (sameBody) {
      if (!panelWasOpen) openPanel();
      return;
    }
    // Excursion entry: the menu grabs the ship out of cruise — remember the
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
    // Teleport behind the arrival veil if the destination isn't painted yet; the
    // panel opens after the landing so it reads the new subject, not the old.
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
      openPanel();
    });
  }

  private selectTravelTarget(target: NonNullable<LandedTarget>) {
    this.travelSelection = target;
    const actionBar = document.getElementById('travel-action-bar');
    const nameEl = document.getElementById('travel-action-name');
    if (actionBar) actionBar.style.display = '';
    if (nameEl) nameEl.textContent = target.name;
  }

  private isTravelMenuOpen(): boolean {
    return document.getElementById('travel-menu')?.classList.contains('visible') ?? false;
  }

  private filterBodyList(list: HTMLElement | null, query: string) {
    if (!list) return;
    const normalizedQuery = query.toLowerCase().trim();
    const items = list.querySelectorAll('.travel-item') as NodeListOf<HTMLElement>;

    if (!normalizedQuery) {
      for (const item of items) item.style.display = '';
      return;
    }

    // First pass: determine which planets match (either directly or via a matching moon)
    const matchingParents = new Set<string>();
    for (const item of items) {
      const name = (item.dataset.name ?? '').toLowerCase();
      const parent = item.dataset.parent ?? '';
      if (name.includes(normalizedQuery)) {
        if (item.dataset.type === 'moon') matchingParents.add(parent);
        else matchingParents.add(item.dataset.name ?? '');
      }
    }

    // Second pass: show/hide
    for (const item of items) {
      const name = (item.dataset.name ?? '').toLowerCase();
      if (name.includes(normalizedQuery)) {
        item.style.display = '';
      } else if (item.dataset.type === 'planet' && matchingParents.has(item.dataset.name ?? '')) {
        // Show parent planet if a moon matches
        item.style.display = '';
      } else if (item.dataset.type === 'moon' && matchingParents.has(item.dataset.parent ?? '')) {
        // Show sibling moons when planet matches
        item.style.display = '';
      } else {
        item.style.display = 'none';
      }
    }
  }

  private async startHistoricJourney(missionId: HistoricMissionId) {
    const journey = HISTORIC_JOURNEYS[missionId];
    await this.player.ensureProfileLoaded(journey.shipProfile);
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
    const camDist = 0.000094;
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
    this.player.posX = destination.position.x;
    this.player.posY = destination.position.y;
    this.player.posZ = destination.position.z;
    this.player.headToward(destination.lookTarget.x, destination.lookTarget.z, destination.lookTarget.y);

    // Don't touch cruise speedMultiplier — the system throttle automatically
    // slows the player near the planet. Just ensure cruise is at least 1c
    // so they can leave the system.
    if (this.player.speedMultiplier < PlayerShip.SPEED_DEFAULT) {
      this.player.speedMultiplier = PlayerShip.SPEED_DEFAULT;
    }
    // Cap system speed for safe planet approach
    if (this.player.systemSpeedMultiplier > PlayerShip.SYSTEM_SPEED_DEFAULT) {
      this.player.systemSpeedMultiplier = PlayerShip.SYSTEM_SPEED_DEFAULT;
    }
    this.updateSpeedSlider();

    if (options.notify !== false) {
      this.notification.show(`Jumped to ${planet.name}`);
    }
    this.resetCruiseCamera();
  }

  /** Any landed body whose system has catalog moons gets the Observatory panel. */
  private isObservatorySubject(target: LandedTarget): boolean {
    if (!target) return false;
    const parentName = target.type === 'planet' ? target.name : target.parentPlanet;
    return getMoonsByPlanet(parentName).length > 0;
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
    const landedSubject = this.landedOn !== null && this.isObservatorySubject(this.landedOn);
    // The button always opens the vantage menu, so it shows everywhere
    // outside missions — even landed on a moonless body (Mercury), where the
    // menu is the way TO an observatory.
    button.style.display = missionActive ? 'none' : '';
    // The panel is a landed-state surface: takeoff and moonless bodies close
    // it. The menu is legal in any state but missions own the ship.
    if (missionActive || !landedSubject) this.closeObservatoryPanel();
    if (missionActive) this.closeObservatoryMenu();
  }

  private closeObservatoryPanel() {
    this.observatoryPanel.hide();
    this.cancelObservatoryEventSearch();
  }

  private toggleObservatoryPanel() {
    if (this.observatoryPanel.isOpen()) {
      this.closeObservatoryPanel();
    } else {
      this.observatoryPanel.show();
      this.renderObservatoryPanel();
      this.startObservatoryEventSearch();
    }
  }

  private toggleSurfaceView() {
    if (this.landedView === 'surface') this.exitSurfaceView();
    else this.enterSurfaceView();
  }

  private renderObservatoryPanel() {
    if (!this.observatoryPanel.isOpen() || !this.landedOn) return;
    const subject = this.buildObservatorySubject();
    if (!subject) return;
    const extras: ObservatoryRenderExtras = {
      vantageName: `You're on ${bodyDisplayName(this.landedOn.name)}`,
      vantageBody: this.landedOn.name,
      swapName: this.swapCompanionTarget()?.name ?? null,
      nowTag: this.observatoryNowTag(),
      surfaceActive: this.landedView === 'surface',
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
    this.observatoryEventSearch = {
      parentPlanet,
      specs: listShadowEventSpecs(parentPlanet),
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
    this.lastObservatoryEvent = event;
    // Park shortly before the peak with the clock running at 1× real time —
    // the user watches the event happen instead of landing on a frozen peak.
    this.timeState = { ...this.timeState, rate: 1, paused: false };
    this.setCurrentUtcMs(event.peakUtcMs - OBSERVATORY_JUMP_LEAD_MS);
    this.observatoryPanel.flashNowBar();
    if (this.landedView === 'surface') {
      // Surface view active: re-point it at the event's observer-level target
      // instead of orbit-framing (jumps never auto-enter the surface view).
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
      // just made full), never at an event geometry.
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
    if (!this.landedOn || !this.isObservatorySubject(this.landedOn)) return;
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
   * the pointer to SurfaceLook until exit.
   */
  enterSurfaceView(target?: SurfaceTarget, entryContext?: SurfaceEntryContext) {
    const landedInfo = this.surfaceLandedInfo();
    if (!landedInfo) return;
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
    const entryFov = entryFovDeg(this.surfaceTargetAngularDiameterDeg(this.surfaceTarget), context);
    this.surfaceFovDeg = entryFov;
    if (this.landedView === 'surface') {
      // Re-point: a short ease to the new target's fitted FOV (predictable
      // framing beats preserving a zoom tuned for the previous subject).
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
    // One-time controls hint on first-ever surface entry.
    if (!this.store.hasSeenSurfaceHint()) {
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

  /**
   * Run an instant teleport (`action`), but if the destination system's moons
   * aren't painted yet, cover the screen first, paint them, then reveal — so a
   * quick-travel never flashes an unpainted (or, with the visibility gate, a
   * missing) moon. Warm systems (already painted, or none) act immediately,
   * exactly as before. A second arrival while one is mid-flight is ignored.
   */
  private arriveThen(target: NonNullable<LandedTarget>, action: () => void): void {
    if (this.arrivalInFlight) return;
    const parentName = this.parentSystemOf(target);
    const moons = this.planetMoons.get(parentName);
    if (!moons || moons.every((m) => m.painted)) {
      action();
      return;
    }
    this.arrivalInFlight = true;
    const veil = document.getElementById('arrival-veil');
    const coverStart = performance.now();
    veil?.classList.add('covering'); // snaps fully opaque (no fade-in) — see CSS
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
        } catch (err) {
          debugError('Arrival failed', err);
        } finally {
          this.arrivalInFlight = false;
          // Hold the cover until the painted, teleported scene has rendered (the
          // landed/jumped system first appears on the next update→render) and at
          // least the min dwell, so a fast machine reads it as an intentional
          // beat rather than a flicker. Removing the class fades it back out.
          const wait = Math.max(48, PlanetariumMode.ARRIVAL_MIN_DWELL_MS - (performance.now() - coverStart));
          window.setTimeout(() => veil?.classList.remove('covering'), wait);
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
    // The menu has no backdrop, so non-menu landing paths (Land button,
    // proximity, T-key) can fire while it's open — its "you're here" marker
    // would go stale the instant the ground changes. Menu-initiated picks
    // already closed it (no-op here).
    this.closeObservatoryMenu();
    this.landedOn = target;
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
    }

    // Stop ship
    this.player.speedMultiplier = 0;
    this.player.moving = false;
    this.player.group.visible = false;

    // Disable autopilot silently (target preserved for restore)
    this.autopilot = false;
    // Landing retires a destination the user never chose (the onboarding
    // default) — otherwise takeoff resumes a ghost trip and the bottom-bar
    // chip keeps pointing at it forever.
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
    const radiusAU = this.getLandedBodyRadiusAU();
    const visualRadius = radiusAU * this.planetScale;

    this.controls.enabled = true;
    this.controls.target.set(0, 0, 0);
    this.controls.minDistance = visualRadius * 1.5;
    this.controls.maxDistance = this.landedMaxDistanceAU(visualRadius);
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.5;
    this.userOrbiting = false;

    // Position camera for a nice initial view
    const camDist = Math.max(visualRadius * 4, 0.0005);
    this.camera.position.set(camDist, camDist * 0.5, camDist);
    this.camera.lookAt(0, 0, 0);

    // UI: hide flight controls, show leave button
    // Close any open popovers before hiding
    document.getElementById('stats-popover')?.classList.remove('visible');
    document.getElementById('stats-chevron')?.classList.remove('expanded');
    document.getElementById('time-popover')?.classList.remove('visible');
    document.getElementById('time-chevron')?.classList.remove('expanded');
    // Hide +/- speed group inside bar but keep Pilot button (doubles as "travel" while landed)
    const speedGroup = document.querySelector('.bar-speed-main .speed-group') as HTMLElement | null;
    if (speedGroup) speedGroup.style.display = 'none';
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
    // A menu opened while landed describes a ground that's about to vanish
    // (Leave is clickable around the backdrop-less menu) — close it.
    this.closeObservatoryMenu();
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
    if (speedGroup) speedGroup.style.display = '';
    const show: Array<[string, string]> = [
      ['planetarium-btn-travel', ''],
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
    this.showOrbitLines = saved.showOrbitLines ?? true;
    const orbitsLabel = document.getElementById('settings-orbits-label');
    if (orbitsLabel) orbitsLabel.textContent = this.showOrbitLines ? 'On' : 'Off';

    // Restore autopilot target (kept even when landed — resumes on exit).
    // Pre-provenance saves migrate by heuristic in the store sanitizer (only
    // user picks ever produce a non-Mercury target).
    this.autopilotTarget = saved.autopilotTarget ?? null;
    this.autopilotUserEngaged = saved.autopilotUserEngaged ?? false;
    this.updateAutopilotButton();
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
    // Only a destination the user picked earns the chip — the onboarding
    // default steers silently and reads as plain "Pilot".
    if (this.autopilotTarget && this.autopilotUserEngaged) {
      btn.innerHTML = '&#x1F916; &rarr; ' + this.autopilotTarget.name;
    } else {
      btn.innerHTML = '&#x1F916; Pilot';
    }
  }

  private toggleAutopilot() {
    if (this.autopilot) {
      this.disengageAutopilot();
      this.notification.show('Autopilot disengaged');
    } else {
      this.toggleTravelMenu(true);
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
      if (planet.nightMaterial) {
        const localSunDir = state.sunDirection
          .clone()
          .applyQuaternion(planet.group.quaternion.clone().invert());
        planet.nightMaterial.uniforms.sunDirection.value.copy(localSunDir);
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
    this.timeState = stepSimulationRate(this.timeState, direction, PlanetariumMode.TIME_RATE_PRESETS);
    this.updateTimeUI();
  }

  private updateTimeUI() {
    this.timePanel.render(this.timeState);
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
      this.solarSystem.ambientLight.removeFromParent();
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
