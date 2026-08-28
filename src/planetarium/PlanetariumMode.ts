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
  ORBIT_LINE_RESAMPLE_MAX_AGE_MS,
  orbitLineOpacity,
  resampleOrbitLines,
  type SolarSystemObjects,
  type PlanetariumLayout,
} from './SolarSystem';
import type { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { PlayerShip, type ShipProfile } from './PlayerShip';
import { PlanetLabels, discRadiusPx, pickBodyAtPointer, type PickCandidate } from './PlanetLabels';
import { PlanetariumStore, createDefaultPlanetariumState, type PlanetariumState, type LandedTarget, type LabelDistancesMode } from './PlanetariumStore';
import { solarExposureTarget } from './solarExposure';
import { computeStats } from './stats';
import {
  PLANETARIUM_BODIES,
  SUN_DATA,
  SUN_POLE_DEC_DEG,
  SUN_POLE_RA_DEG,
  type PlanetData,
} from './planets/planetData';
import { appliedTierGpuBytes, applySunGlowTier, armArrivalWarmGoal, bindKtx2TierLoader, canAttempt, cancelNormalUpgrade, cancelTextureUpgrade, createMoonMeshes, createShaderWarmupProbes, disarmArrivalWarmGoal, earnedUpgradeTier, firstUpgradeTier, lodMeasurementRelevant, needsUpgradeCover, normalUpgradePending, pumpArrivalWarmGoal, resolveUpgradeTier, setWarmEligibleMoonParents, upgradeComplete, upgradeGeometryOnApproach, upgradeNormalOnApproach, upgradeTextureOnApproach, ATMOSPHERES, ATMOSPHERE_SHELL_SCALES, PLANET_TEXTURE_FILES, UPGRADE_TRIGGER_FRACTION, type MoonMesh, type PlanetMesh, type TextureUpgrade } from './PlanetFactory';
import type { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import type { SurfaceShadingFx } from './world/surfaceShading';
import { bindTextureWarmer, invalidateTextureWarmCache, pumpTextureWarmQueue, queueTextureWarm, resetTextureWarmer } from './world/textureWarmer';
import { SECTOR_SETS, SectorStreamer, type SectorMeasure, type SectorStats, type SectorSuspend } from './world/sectorStreamer';
import { loadBrightStarCatalog } from './world/starCatalogLoader';
import {
  advancePlanetariumTime,
  computeBodyPositionAU,
  computeBodyState,
  ECLIPTIC_NORTH_EQUATORIAL,
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
  shadowAxisSurfacePoint,
  type MoonShadingState,
  type ShadowEvent,
  type ShadowEventSpec,
} from '../astronomy/shadows';
import { ShadowVisuals, createShadowVisualsWarmupProbes, type GuideSlotInput } from './world/ShadowVisuals';
import { warmUpSceneShaders } from './world/shaderWarmup';
import { OBSERVATORY_JUMP_LEAD_MS, resolveLiveEvent, stepperSearchFromUtcMs } from './observatoryTime';
import { resolveShowVantage } from './observatoryJump';
import { surfacePerfBeginSpan, surfacePerfEndSpan } from './surfacePerf';
import { findEvent, type EventType } from '../astronomy/ephemeris';
import { KM_PER_AU } from '../astronomy/constants';
import {
  createPlanetariumStarfield,
  setStarfieldGain,
  setStarfieldPixelRatio,
  starfieldFaintLimitMag,
} from './world/starfield';
import { MoonDots } from './world/MoonDots';
import {
  MOON_DOT_PARAMS,
  albedoProxyFromColor,
  chromaticityRGB,
  discDiameterPx,
  moonDotVisual,
  parentDominanceFade,
  systemEdgeFade,
  type MoonDotParams,
  type MoonDotVisual,
} from './moonDots';
import {
  LABEL_DOT_MIN_ALPHA,
  LABEL_READABLE_RADIUS_PX,
  MOON_LABEL_PLACEMENT_PARAMS,
  clampAnchorClearOfDisc,
  edgeLabelSystemCap,
  placeMoonLabels,
  type AnchorSlide,
  type MoonLabelCandidate,
  type MoonLabelPlacementParams,
} from './moonLabelPlacement';
import {
  applySunGlareMaskParams,
  sunGlareMaskActivation,
  sunGlareMaskCoreOuterPx,
  type SunGlareMaskParams,
  type SunGlareMaskActivationInput,
  type SunGlareMaskUniforms,
} from './world/sunGlareMask';
import { MoonPainter } from './world/MoonPainter';
import { ProceduralMoonTexturer } from './world/ProceduralMoonTexturer';
import { captureDeviceTextureCaps, resolveTextureUrl, TIER_MAP_WIDTH } from './world/texturePolicy';
import { warmBitmapUploadProbe } from './world/textureBitmapLoader';
import { planetshineIntensity } from './world/planetshine';
import {
  advanceSilhouetteOwners,
  makeSilhouetteOwners,
  smoothShadeFraction,
  type SilhouetteOwners,
  type SilhouetteTarget,
  type SilhouetteAdvanceOptions,
} from './world/shadeSmoothing';
import { debugError, debugWarn } from '../shared/debug';
import { cssHexColor } from '../shared/color';
import { markerQuadPx } from './planetMarkers';
import { CRUISE_TAP_FLOORS, SYSTEM_TAP_FLOORS, stepThrottleTap, systemSpeedFactor, type SystemSpeedResult } from './throttlePolicy';
import { GyroSteering } from './input/GyroSteering';
import { SurfaceLook } from './input/SurfaceLook';
import {
  angularDiameterDeg,
  bodyDisplayName,
  clampSurfaceFovDeg,
  computeAnchoredSpotVantage,
  computeShadowSpotVantage,
  computeSpotAnchorLocal,
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
  type SurfaceLandedInfo,
  type SurfaceMarkerKind,
  type SurfaceTarget,
  type SurfaceTargetChoice,
} from './surfaceView';
import { DEG2RAD, RAD2DEG } from '../shared/math/angles';
import {
  applyDesignFov,
  displayFovDeg,
  lensDisplayHalfTan,
  lensMaxFrameScale,
} from '../shared/math/lensProjection';
import { SUN_GLARE_EXTENT_SOLAR_RADII, SUN_VEIL_BETA, SUN_VEIL_SCALE_H } from '../shared/shaders/sun';
import { landedFrameCamDistAU, landedMinDistanceAU, landedNearAU, LANDED_NEAR_AU } from './landedView';
import {
  MOON_RENDER_ANCHOR_RATIO,
  MOON_RENDER_ANCHOR_RATIO_OBSERVING,
  MOON_RENDER_GAMMA,
  renderedMoonRadiusAU,
} from './moonRenderSize';
import {
  advanceDiamondRing,
  advanceSunEmergenceFlash,
  chromosphereSideWeights,
  CHROMOSPHERE_ATTACK_TAU_S,
  CHROMOSPHERE_RELEASE_TAU_S,
  circleOcclusionFraction,
  diamondRingStrength,
  eclipseOccluderLikeness,
  projectedSourceRadiusAtPlane,
  silhouetteSizeGate,
  sunGlareFloodOpacity,
  sunInteriorWhiteout,
  sunWhiteoutFraction,
  targetSunExposure,
  visibleCrescentGeometry,
  type CrescentGeometry,
} from './sunAppearance';
import {
  SHIP_CLEARANCE_AU,
  CRUISE_CAM_DIST_AU,
  SHIP_OCCLUDER_RADIUS_AU,
  SHIP_ANY_HULL_EXTENT_AU,
  CRUISE_CONTROLS_MIN_DISTANCE_AU,
  CAMERA_BODY_MARGIN_AU,
  CAM_FOLLOW_TAU_IDLE_S,
  CAM_FOLLOW_TAU_TURN_S,
  CAM_FOLLOW_TURN_BLEND_S,
  ORBIT_DAMPING_TAU_S,
  ORBIT_POLAR_MARGIN_RAD,
  cameraFollowGain,
  chaseIdealOffset,
  reacquireCameraStep,
  planetEnvelopeRadiusAU,
  cruiseCameraNearAU,
  escapeCameraPenetrations,
  nearestShellSurfaceDistanceAU,
  ringAnnulusDistanceAU,
  type CameraBodyShell,
} from './cruiseView';
import {
  SHIP_SUN_DISC_SAMPLES,
  shipHullMayOverlapSource,
  unblockedShipSunFraction,
} from './shipSunOcclusion';
import {
  eclipticHeadingPitchFromEquatorial,
  flightAnglesFromSceneDirection,
  FLIGHT_UP_SCENE,
} from './flightFrame';
import { KM_CONSTANTS } from '../shared/constants/physicalData';
import { smoothstepUnclamped } from '../shared/math/smoothstep';
import {
  estimateSphereScreenDiameterPx,
  placeSphereInFrustum,
  projectedStepScale,
  projectSphereToScreen,
  projectToScreen,
  screenPointToWorldRay,
  type ProjectedStepScale,
  type ScreenProjection,
  type SphereScreenProjection,
} from '../shared/three/projectToScreen';
import { applyLensShaderUniforms, type LensShaderUniforms } from '../shared/three/lensShader';
import { isPhoneViewport, setText } from '../shared/dom';
import { Constellations } from './Constellations';
import { snapConstellations } from './data/constellationGeometry';
import { getMoonsByPlanet, MOONS, type MoonData } from './planets/moonData';
import { RING_CONFIGS, type RingStyle } from './planets/rings';
import { filterDeckRows, groupDeckBodies, observeArrivalAction, type DeckRow } from './deckLogic';
import {
  advanceBodyCap,
  autopilotAimBlend,
  autopilotArrived,
  autopilotGlideCap,
  contactAimStep,
  grazeDeflectAim,
  initialBodyCapState,
  moonArrivalPose,
  moonArrivalStandoffAU,
  moonCollisionRadius,
  movingBodySpeedCap,
  sunArrivalPose,
  BODY_APPROACH_V_MIN_AU_S,
  BODY_CAP_CLEAR_HOLD_S,
  CONTACT_AIM_TTL_S,
  CONTACT_ALIGN_OUT_MAX,
  MOON_APPROACH_K_PER_S,
  PLANET_APPROACH_K_PER_S,
  PLANET_ARRIVAL_STANDOFF_FLOOR_AU,
  SUN_APPROACH_SURFACE_RADII,
  SUN_ARRIVAL_RADII,
  sweepSegmentSphere,
  type BodyCapState,
  type SweepContact,
  type MoonArrivalInputs,
} from './arrivalLogic';
import {
  clearArrivalLook,
  createCruiseAimState,
  cutAim,
  releaseArrivalLook,
  startArrivalLook,
  stepCruiseAim,
} from './cruiseAim';
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
  formatEventRowTime,
  liveEventVerb,
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
import {
  MAP_LAYER_DEFAULTS,
  SystemMap,
  type MapLayerState,
  type MapOrbitStyleParams,
  type MapTextureSource,
} from './map/SystemMap';
import { MapHUD } from './ui/MapHUD';
import { buildMapFocusRows } from './map/mapFocusRows';
import { mapCardActions, mapCardOffersVerb, commitBodyPickOutcome, type MapVerb } from './map/mapLogic';
import { mapBody, mapBodyRefFor } from './map/mapBodies';
import {
  guardMapEvent,
  latchMapEventReverse,
  makeMapEventReverseLatch,
  mapEventReverseRunning,
  mapEventSearchTarget,
  resetMapEventReverseLatch,
} from './map/mapEvents';
import {
  shadowEventSpecKey,
  startShadowEventSearch,
  stepShadowEventSearch,
  type ShadowEventSearch,
} from './shadowEventSearch';
import { tidalLockQuaternion, tidalRollNorth } from './world/tidalLock';
import {
  type MapBodySizeParams,
  type MapMarkerZoomParams,
  type MapSunSizeParams,
} from './map/mapBodySize';
import { type MapMoonOffsetParams } from './map/mapMoonOffset';
import { type MapStarParams } from './map/mapStars';
import {
  MAP_DOUBLE_TAP_MS,
  formatMapZoomRatio,
  mapCameraOwnsPose,
  mapFocusReleasable,
  mapOverviewAvailable,
  mapZoomReadoutQuantum,
  type MapZoomAvailability,
} from './map/mapCamera';
import { HOVER_RECLAIM_MOVE_PX, resolveMapHover } from './map/mapHover';
import { mapFactRows, mapHoverMeta } from './map/mapFacts';
import { isTap } from './map/mapPicking';
import { projectMapPoint } from './map/mapProjection';
import {
  makeTeleportPick,
  outerOrbitExtentAU,
  resolveTeleportPick,
  teleportChipLabel,
  type TeleportPick,
} from './map/mapTeleport';
import {
  miniChartRect,
  miniChartVisible,
  miniDrawRect,
  miniRectStale,
  type MiniChartRect,
  type MiniChartVisibility,
  type MiniDrawRect,
} from './map/miniChart';
import { flushOrbitDamping } from './input/orbitDamping';
import { formatBodyDistance, bodyDistanceQuantum } from './bodyDistance';

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

// Average sunlight fraction surviving a crossing of each ring system, for the
// Sun-glare sightline: dense Saturn rings dim hard, the faint dust systems
// barely register. Band structure/gaps are deliberately averaged out.
const RING_GLARE_TRANSMISSION: Record<RingStyle, number> = {
  saturn: 0.45,
  uranus: 0.8,
  jupiter: 0.93,
  neptune: 0.9,
};

// Sun's angular radius seen from 1 AU — the reference distance for the veiling
// glare's falloff (the ISS reference stills that inspired it are at Earth).
const SUN_ANG_RADIUS_AT_1AU = Math.asin(SUN_DATA.radiusAU);

/** The Sun's rotation axis as a scene direction. Built once through the frame's
 *  single chirality definition site, so the corona's lobes inherit the same
 *  sky the stars and constellations are drawn in. */
const SUN_POLE_DIRECTION = raDecToVector(SUN_POLE_RA_DEG, SUN_POLE_DEC_DEG).normalize();

// Visibility floor the veil billboard is sized to: the pixel radius where the
// wash and arms fall below this HDR value is the quad's support, so the quad
// tracks the light instead of an authored amount. Small enough that the
// drawn-quad edge fade lands well inside where the wash is already invisible.
const SUN_VEIL_EPSILON = 0.0015;

// The Sun sits at the world frame's origin by construction; navigation code
// that resolves target positions returns this shared literal for it.
const SUN_WORLD_POSITION = { x: 0, y: 0, z: 0 };

export interface PlanetariumActivationProgress {
  completedUnits: number;
  totalUnits: number;
}

/** Width of the finest colour map a body's ladder will reach on this device
 *  — the one its sectors' magnification is measured against — or undefined
 *  for a body whose boot map is its finest. */
function topMapWidthOf(ups: readonly TextureUpgrade[], material: THREE.Material): number | undefined {
  const up = ups.find((u) => u.material === material);
  return up ? TIER_MAP_WIDTH[up.effectiveMaxTier] : undefined;
}

export class PlanetariumMode {
  // The cruise rig (clearance pads, chase distance, occluder disc, zoom
  // floor) lives in cruiseView.ts as one derived chain.
  private static readonly UI_REFRESH_INTERVAL_S = 1 / 8;
  private static readonly SCENE_NORTH = new THREE.Vector3(0, 1, 0);
  // Moon rendered sizes (anchor ratios + γ curve) live in moonRenderSize.ts
  // as the single sizing policy; the state-dependent anchor pick is
  // moonRenderAnchorRatio, and every controller consumer resolves through
  // renderedMoonSizeAU so the dev γ override reaches all of them.
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
    'planetarium-btn-map',
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
  private labelDistancesMode: LabelDistancesMode = 'hover';
  private showBodyMarkers = true;
  private showOrbitLines = false;

  // Hover/tap body reveal. `revealedBody` is the one body (planet, moon, or
  // 'Sun') whose label is drawn regardless of the label/marker settings and of
  // hide-distances — resolved once per frame from the pointer against a live
  // pick list. Touch reveal holds for a spell after a tap; mouse hover tracks
  // the pointer live. `worldLabelsModalHidden` is the separate modal-hide.
  private revealedBody: string | null = null;
  private hoverClientX = 0;
  private hoverClientY = 0;
  private hoverEligible = false; // pointer is a mouse currently over canvas/touch-zone
  private touchRevealBody: string | null = null;
  private touchRevealUntil = 0;
  // A recognized tap queues its point; the next pipeline frame builds a fresh
  // pick list and resolves it (a flick can be faster than one render frame, so
  // hit-testing right in the pointerup handler would read a stale/empty list).
  private pendingTapX = 0;
  private pendingTapY = 0;
  private hasPendingTap = false;
  private static readonly TOUCH_REVEAL_MS = 2500;
  private static readonly TAP_SLOP_PX = 4;
  private static readonly TAP_MAX_MS = 500;
  // Tap gesture bookkeeping for the window-level tracker.
  private gesturePointerId: number | null = null;
  private gestureStartX = 0;
  private gestureStartY = 0;
  private gestureStartT = 0;
  private gestureMoved = false;
  private gestureMultiPointer = false;
  private pointersDown = 0;
  private worldLabelsModalHidden = false;
  // Pooled pick list (references into `bodyPickPool`, exact length each frame)
  // and its projection scratch — zero allocation in steady state.
  private bodyPickPool: PickCandidate[] = [];
  private bodyPickList: PickCandidate[] = [];
  private pickProjScratch: ScreenProjection = { x: 0, y: 0, ndcX: 0, ndcY: 0, ndcZ: 0 };
  private pickTempV = new THREE.Vector3();
  private pickScenePositions: Map<string, { x: number; y: number; z: number }> | null = null;
  private readonly labelPlayerOrigin = { x: 0, y: 0, z: 0 };
  private planetLabelsContainerEl: HTMLElement | null = null;

  // A gesture is only tracked when it BEGINS on the renderer canvas or a
  // touch-flight-zone — never on UI/overlay chrome sitting above them.
  private isCanvasOrZone(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    if (target === this.renderer.domElement) return true;
    return target.classList.contains('touch-flight-zone');
  }

  // Window-level, capture-phase pointer tracker owned by the mode: the orbit
  // canvas listener early-returns outside drags, and coarse-pointer cruise
  // touches land on the touch-zones above the canvas, so neither sees the taps
  // and hovers the reveal needs. It only OBSERVES — no preventDefault — so a
  // body tap still steers exactly as before.
  private onWindowPointerDown = (e: PointerEvent): void => {
    if (!this.active) return;
    const originOk = this.isCanvasOrZone(e.target);
    this.hoverClientX = e.clientX;
    this.hoverClientY = e.clientY;
    this.hoverEligible = e.pointerType === 'mouse' && originOk;
    this.pointersDown++;
    if (this.gesturePointerId === null && this.pointersDown === 1 && originOk) {
      this.gesturePointerId = e.pointerId;
      this.gestureStartX = e.clientX;
      this.gestureStartY = e.clientY;
      this.gestureStartT = e.timeStamp;
      this.gestureMoved = false;
      this.gestureMultiPointer = false;
    } else {
      // A second finger (or a down that didn't start the gesture) disqualifies
      // the current tap.
      this.gestureMultiPointer = true;
    }
  };

  private onWindowPointerMove = (e: PointerEvent): void => {
    if (!this.active) return;
    this.hoverClientX = e.clientX;
    this.hoverClientY = e.clientY;
    this.hoverEligible = e.pointerType === 'mouse' && this.isCanvasOrZone(e.target);
    if (this.gesturePointerId === e.pointerId) {
      const dx = e.clientX - this.gestureStartX;
      const dy = e.clientY - this.gestureStartY;
      const slop = PlanetariumMode.TAP_SLOP_PX;
      if (dx * dx + dy * dy > slop * slop) this.gestureMoved = true;
    }
  };

  private onWindowPointerUp = (e: PointerEvent): void => {
    if (!this.active) return;
    this.pointersDown = Math.max(0, this.pointersDown - 1);
    if (this.gesturePointerId === e.pointerId) {
      const heldMs = e.timeStamp - this.gestureStartT;
      const isTap = !this.gestureMoved && !this.gestureMultiPointer && heldMs <= PlanetariumMode.TAP_MAX_MS;
      // Mouse clicks rely on live hover, not the timed reveal, so only touch/pen
      // taps arm the 2.5 s window.
      if (isTap && e.pointerType !== 'mouse') this.handleBodyTap(e.clientX, e.clientY);
      this.gesturePointerId = null;
    }
  };

  private onWindowPointerCancel = (e: PointerEvent): void => {
    this.pointersDown = Math.max(0, this.pointersDown - 1);
    if (this.gesturePointerId === e.pointerId) this.gesturePointerId = null;
    this.clearBodyReveal();
  };

  /** Window-level disarm for map gestures whose release the canvas never
   *  sees (drag ends over the HUD, capture lost without a canvas
   *  pointercancel). Named so dispose() can remove it. */
  private onWindowMapDisarm = (e: PointerEvent): void => {
    this.mapPointerCancel(e);
  };

  /** Focus loss cancels every armed gesture and held key — the matching
   *  releases may never arrive. Named so dispose() can remove it. */
  private onWindowBlur = (): void => {
    // Focus loss mid-drag: the pointerup may never arrive, so cancel the
    // gesture outright — OrbitControls' capture and document listeners tear
    // down with our bookkeeping.
    this.cancelOrbitGesture();
    // The map's armed pick would strand the same way — and a mouse reuses
    // one pointer id, so the NEXT click's release could then tap against
    // this gesture's stale down point. A half-made double-tap goes with it.
    this.mapPickPointerId = null;
    this.mapPickPoisoned = false;
    this.mapTapName = null;
    // An armed teleport press strands the same way: its timer would mature
    // over a window nobody is looking at. The offer already on screen goes
    // too — it names a point chosen against a chart the user has left.
    this.cancelMapLongPress();
    this.dismissMapTeleportChip();
    // A held zoom button strands the same way — its pointerup goes to
    // whatever took the focus, and the repeat would run on unwatched.
    this.stopMapZoomHold();
    // The map's hover latch strands the same way: no move arrives while the
    // window is away, so the stored pointer would still claim a cursor that
    // could be anywhere by the time focus comes back.
    this.resetMapHover();
    // Focus loss (e.g. Cmd-Tab) means the keyups won't arrive, so a held key
    // would linger — with W held the ship accelerates unattended. Drop every
    // held key; yaw/pitch/throttle recompute from this set each frame
    // (processInput), so clearing it is enough.
    this.keys.clear();
    this.clearBodyReveal();
    // The map's pointer book strands the same way: a contact whose terminal
    // event never reaches the window would suppress its wheel/pinch forever.
    this.systemMap?.retirePointers();
  };

  // Planet world positions in AU (true positions, not offset)
  private planetWorldPositions = new Map<string, { x: number; y: number; z: number }>();

  // Planet moons: map from planet name to array of moon meshes
  private planetMoons = new Map<string, MoonMesh[]>();
  /** The same meshes, keyed by moon name — the map's per-frame lookup. */
  private moonMeshByName = new Map<string, MoonMesh>();
  /** Planet meshes keyed by name — the per-frame lookups (surface camera,
   *  map texture sync) index here instead of scanning the planets array. */
  private planetMeshByName = new Map<string, PlanetMesh>();
  /** Reused result for the per-frame system-throttle read (throttlePolicy). */
  private readonly systemSpeedScratch: SystemSpeedResult = { factor: 1, planet: null };

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
  // it, a big one takes its frame alone (the pump always uploads at least one).
  private static readonly TEXTURE_WARM_BUDGET_MS = 6;
  /** Above this rotation rate on screen (degrees of body spin per real
   *  second — Earth at 900 s/s) a globe turns visibly under the camera, so
   *  admitting sector tiles would only churn 21 MiB uploads — residents hold,
   *  nothing new starts. Measured per body from its world orientation, so a
   *  slow turner (the Moon: 27× Earth) keeps streaming at rates that would
   *  spin Earth into a blur. */
  private static readonly SECTOR_SPIN_SUSPEND_DEG_PER_S = 3.75;
  /** Admissions resume only once the rate has stayed under this lower figure
   *  for the hold: a body turning at the suspend rate would otherwise pulse
   *  admissions on and off with frame jitter. */
  private static readonly SECTOR_SPIN_RESUME_DEG_PER_S = 3;
  private static readonly SECTOR_SPIN_HOLD_MS = 400;
  /** Tangent step, in body radii, used to measure how large a sector's
   *  surface draws (see updateSectorStreaming). Small enough that the
   *  projection is straight across it — a quarter of a 16K texel — and far
   *  larger than double precision needs to resolve the two projected points. */
  private static readonly SECTOR_TANGENT_STEP_RADII = 1e-4;
  // Speculative warm of the Earth+Moon pair's first colour steps a beat after
  // activation: eclipse vantages land on Earth and the Moon is the most-taken
  // first close-up, so spending idle seconds on their fetch+decode means a
  // later arrival's veil finds the maps resident instead of holding its full
  // bounded window on a cold cache. The delay keeps the fetches clear of the
  // boot texture wave; the uploads ride the budgeted warm pump like any other
  // upgrade, off the first draw that would otherwise pay them mid-gesture
  // (the pump itself runs every frame, so each 4096-wide upload still costs
  // one frame somewhere in the seconds after the fetch lands).
  private bootPairWarmTimer: number | undefined;
  private static readonly BOOT_PAIR_WARM_DELAY_MS = 5000;
  // Arrival veil re-entrancy guard (rapid picks, or a pick while one is running).
  private arrivalInFlight = false;
  /** Monotonic veil-cover token: each veiled arrival claims the veil, so a
   *  previous arrival's lift timer can't uncover a newer arrival mid-flight.
   *  Reachable whenever a new veiled arrival starts inside the last one's
   *  reveal dwell — e.g. a parked tutorial stop restoring the moment the
   *  in-flight flag clears, or two quick deck picks. */
  private arrivalCoverGen = 0;
  /** What the live cover is waiting on: the first-step fetches in flight when
   *  it went up, by handle and attempt identity. Taken once per arrival, so a
   *  fetch that starts later — including the next step of a ladder — can never
   *  extend a hold that is already running. */
  private arrivalUpgradeBatch: Array<{ up: TextureUpgrade; generation: number }> = [];
  /** Delayed reveal of the veil's busy note — cleared whenever the veil lifts. */
  private arrivalNoteTimer: number | undefined;
  private static readonly ARRIVAL_MIN_DWELL_MS = 150;
  // Longest the arrival cover waits (from cover start) for the landed pair's
  // in-flight first-tier fetch+decode before revealing anyway — a stalled fetch
  // must never pin the veil.
  private static readonly ARRIVAL_UPGRADE_HOLD_MAX_MS = 900;
  /** How long the veil takes to fade back out once its class comes off — the
   *  0.3 s CSS transition on `#arrival-veil`, plus a frame of slack because the
   *  transition starts at the next style recalc, not at the class removal.
   *  Anything gated on "the veil is gone" has to wait out the fade too: through
   *  it the element is still painted, just no longer taking pointers, so a
   *  layer that appeared under it would both show through and be clickable. */
  private static readonly ARRIVAL_VEIL_FADE_MS = 360;
  /**
   * When the arrival veil will have finished fading, in `performance.now()` ms.
   * Infinity while it is up. `arrivalInFlight` is NOT the same question: it
   * clears in the arrival's `finally`, while the veil stays opaque through the
   * upgrade hold and the minimum dwell and then fades for its transition.
   */
  private arrivalVeilClearAtMs = 0;
  // Map dive on a Teleport/Observatory commit: the camera eases in over
  // DIVE_CAM_MS, then the fade blacks out over DIVE_FADE_MS — total under the
  // 450 ms cap so it never reads as lag. Autopilot has no dive: just a short
  // fade-close. A second tap/Enter skips the camera ease straight to the fade.
  private static readonly DIVE_CAM_MS = 300;
  private static readonly DIVE_FADE_MS = 120;
  private static readonly DIVE_TOTAL_MS = 420;
  private static readonly AUTOPILOT_CLOSE_MS = 150;
  // The map's zoom buttons. A press is one notch; the delay is what keeps a
  // deliberate single press from turning into a run, and past it the button
  // repeats every REPEAT_MS — fast enough to read as a glide rather than a
  // stutter.
  private static readonly MAP_ZOOM_HOLD_DELAY_MS = 320;
  private static readonly MAP_ZOOM_HOLD_REPEAT_MS = 110;
  // And it accelerates, because the chart spans five decades: at one notch a
  // repeat the far end is six seconds of holding. Every REPEAT_RAMP repeats the
  // press spends one more notch, up to REPEAT_MAX — which crosses the whole
  // range in about three seconds while the first second still steps gently
  // enough to stop where you meant to.
  private static readonly MAP_ZOOM_REPEAT_RAMP = 10;
  private static readonly MAP_ZOOM_REPEAT_MAX = 3;
  /** How long the "scroll or pinch" line stays up when nothing dismisses it. */
  private static readonly MAP_ZOOM_HINT_MS = 6000;
  /** How long a finger has to rest on empty chart before it means "teleport
   *  here". Past the tap window the double-tap focus uses, so a slow tap is
   *  never mistaken for a hold; short enough that the offer feels like an
   *  answer to the press rather than a delay. */
  private static readonly MAP_TP_PRESS_MS = 450;
  /** The chip floats this far above the point it names, so the point itself
   *  stays visible under it. */
  private static readonly MAP_TP_CHIP_LIFT_PX = 14;
  /**
   * How far from the Sun a chosen point may be. A FIXED figure off the planet
   * catalog — Pluto's orbit with a margin — never the chart's live extent: the
   * ship's own marker is part of that extent, so measuring against it would let
   * each teleport outward widen the range the next one may reach.
   */
  private static readonly MAP_TP_EXTENT_AU = outerOrbitExtentAU(PLANETARIUM_BODIES);
  private tmpMoonOffset = new THREE.Vector3();
  private tmpMoonOrbitNormal = new THREE.Vector3();
  private tmpMoonShadowLocal = new THREE.Vector3();
  private tmpMoonShadowQuat = new THREE.Quaternion();
  private tmpPlanetshine = new THREE.Vector3();
  private tmpLocalSunDir = new THREE.Vector3();
  private tmpInvGroupQuat = new THREE.Quaternion();
  private tmpShadingParentPos = new THREE.Vector3();
  private sunExposure = 1;
  private lastSunVisibleFraction = 1;
  private sunEmergenceFlash = 0;
  /** Wall-time envelope behind uDiamondRing. The authored strength is a pure
   *  function of the exposed fraction, which a warped clock can cross in one
   *  frame; this carries the blaze at human speed regardless of time rate. */
  private sunDiamondRing = 0;
  /** Headless-QA scale on the uDiamondRing write (1 = normal). Lets a capture
   *  decompose a contact frame into diamond-term vs everything-else shares. */
  private devDiamondScale = 1;
  /** Wall-time envelope behind uBeadCarveDepth — the bead's silhouette-cut
   *  kill. Smoothed so eligibility edges (the occluder ratio crossing out of
   *  the eclipse-like range while the bead still releases) fade, never pop. */
  private sunBeadCarveDepth = 0;
  /** Last usable screen angle of the Sun's rotation axis. Held across the frames
   *  where the axis points too near the camera to project into a direction. */
  private sunPoleScreenAngle = 0;
  /** Wall-time envelopes behind uChromoAnti/uChromoToward — the contact
   *  chromosphere on the limb away from the occluder and on the limb toward it.
   *  Same reason as the blaze above: the geometry that lights them is a sliver
   *  of the eclipse a warped clock steps straight over. */
  private sunChromoAnti = 0;
  private sunChromoToward = 0;
  // DOM chrome flood at the whiteout wall; last written opacity string keeps
  // the per-frame style write to actual changes only.
  private sunGlareFloodEl: HTMLElement | null = null;
  private sunGlareFloodLast = '';
  // When set, the next Sun-shader frame reseeds the emergence-flash baseline so a
  // one-frame jump in the Sun's visible fraction — teleport, landing, takeoff,
  // restore, time set, event jump, surface-view entry — is never mistaken for a
  // real limb clearing. Starts true so the first frame after construction seeds
  // cleanly. See noteSunViewDiscontinuity().
  private sunFlashResetPending = true;
  private sunAtmosphereMix = 0;
  private readonly sunAtmosphereColor = new THREE.Color(1, 0.55, 0.24);
  /** Set by computeVisibleSunFraction: angular radius of the strongest solar
   *  occluder this frame (scratch for the corona's eclipse-likeness gate). */
  private sunDominantOccluderAngularRadius = 0;
  /** Unit camera→occluder direction of that same strongest occluder — valid
   *  only while sunDominantOccluderAngularRadius > 0. Positions the glare
   *  shader's silhouette carve at the body's true screen offset. */
  private sunDominantOccluderDirection = new THREE.Vector3();
  private tmpSunOccluderDelta = new THREE.Vector3();
  /** Surface-shading uniforms of the strongest occluder this frame. */
  private sunDominantOccluderFx: SurfaceShadingFx | null = null;
  /** Mesh identity of the incumbent dominant occluder, held across frames for
   *  the ownership hysteresis in computeVisibleSunFraction — a conjunct pair
   *  trading the lead frame to frame must not flip the carve/silhouette. */
  private sunDominantOccluderMesh: THREE.Object3D | null = null;
  /** Captured direction of the best challenger / the incumbent while the
   *  hysteresis picks between them (alloc-free scratch). */
  private tmpBestOccluderDirection = new THREE.Vector3();
  private tmpIncumbentOccluderDirection = new THREE.Vector3();
  /** Per-pass scratch for computeVisibleSunFraction's occluder scan — held on
   *  the instance so the scan runs alloc-free every frame. Reset at the start of
   *  each call; the incumbent slot is seeded from sunDominantOccluderMesh so a
   *  commit mid-scan can still overwrite it without losing the pass's incumbent. */
  private sunOccBestOcclusion = 0;
  private sunOccSecondOcclusion = 0;
  private sunOccBestMesh: THREE.Object3D | null = null;
  private sunOccBestAngularRadius = 0;
  private sunOccBestFx: SurfaceShadingFx | null = null;
  private sunOccIncumbentMesh: THREE.Object3D | null = null;
  private sunOccIncumbentOcclusion = 0;
  private sunOccIncumbentAngularRadius = 0;
  private sunOccIncumbentFx: SurfaceShadingFx | null = null;
  /** Two-owner wall-time smoothing for the night-lift silhouette dim: the
   *  current owner ramps toward its gated target, an ex-owner fades out. Keeps
   *  a warp-compressed eclipse from strobing the night fills. */
  private sunSilhouetteOwners: SilhouetteOwners<SurfaceShadingFx> =
    makeSilhouetteOwners<SurfaceShadingFx>();
  /** Persistent target + options passed to advanceSilhouetteOwners each frame:
   *  fields are mutated in place so the per-frame silhouette advance allocates
   *  nothing. */
  private sunSilhouetteTarget: SilhouetteTarget<SurfaceShadingFx> = { owner: null, shade: 0 };
  private sunSilhouetteAdvanceOptions: SilhouetteAdvanceOptions = { snap: false };
  /** Set by noteSunViewDiscontinuity(), consumed in updateSunShader: the next
   *  silhouette advance snaps both slots to target so a teleport never shows a
   *  fading ghost of the previous scene's dark disc. */
  private sunSilhouetteSnapPending = true;
  /** The size gate applied to the current dominant occluder this frame (1 for
   *  eclipse-scale, 0 for a horizon-filling body) — readback only. */
  private sunSilhouetteGate = 1;
  /** The visible-crescent decomposition of the dominant occluder this frame —
   *  the light origin for the glare (centroidSr signed away from the occluder).
   *  extentSr is telemetry only. */
  private sunCrescent: CrescentGeometry = { centroidSr: 0, extentSr: 0 };
  /** Guarded signed centroid (solar radii) actually driving the glare/mask this
   *  frame; 0 with no occluder or when a second body muddies the single lens. */
  private sunCrescentCentroidSr = 0;
  /** The centroid displacement in CSS px (|centroidSr| x solarRadiusPx) the quad
   *  grows by so the shifted wash never clips at the billboard edge. */
  private sunCrescentDisplacementPx = 0;
  /** Set by computeVisibleSunFraction: the second-strongest single-body solar
   *  occlusion this frame. Above ~0.05 the single-lens centroid is a lie, so the
   *  centroid shift and diamond ring are gated off — two bodies on the disc have
   *  no one crescent to hang the light on. */
  private sunSecondOccluderFraction = 0;
  private tmpCrescentTangent = new THREE.Vector3();
  private tmpCrescentDir = new THREE.Vector3();
  private tmpCrescentPoint = new THREE.Vector3();
  private tmpCrescentProj: ScreenProjection = { x: 0, y: 0, ndcX: 0, ndcY: 0, ndcZ: 0 };
  private lastSunOccluderAngularRadius = 0;
  private tmpSunDirection = new THREE.Vector3();
  private tmpRingNormal = new THREE.Vector3();
  private tmpRingHit = new THREE.Vector3();
  private tmpSunCameraForward = new THREE.Vector3();
  private tmpSunScreen = new THREE.Vector3();
  private tmpScreenRay = new THREE.Vector3();
  private readonly tmpScreenForward = new THREE.Vector3(0, 0, -1);
  private tmpScreenOffsetQuat = new THREE.Quaternion();
  private tmpScreenInverseQuat = new THREE.Quaternion();
  private devDiagnosticSphere: THREE.Mesh | null = null;
  private probeLimbMarker: THREE.Sprite | null = null;
  private probeLimbDir = new THREE.Vector3();
  private sphereScreenProjection: SphereScreenProjection = {
    x: 0, y: 0, ndcX: 0, ndcY: 0, ndcZ: 0,
    footprintX: 0, footprintY: 0, radiusPx: 0, diameterPx: 0,
    minX: 0, maxX: 0, minY: 0, maxY: 0,
    footprintKind: 'none',
  };
  /** Sector streaming (world/sectorStreamer): the hero bodies' 16K tiles.
   *  Null when disabled (`?sectors=0`) or before the system exists. */
  private sectors: SectorStreamer | null = null;
  private readonly sectorsEnabled = new URLSearchParams(location.search).get('sectors') !== '0';
  /** Latched from webglcontextlost to webglcontextrestored: a GL call on a
   *  lost context silently succeeds, so an upload "warmed" in that window is
   *  a texture that never reached the GPU — nothing may be admitted until
   *  the context is back, and whatever was admitted is dropped again then. */
  private glContextLost = false;
  private readonly sectorCamLocal = new THREE.Vector3();
  private readonly sectorWorldCentre = new THREE.Vector3();
  private readonly sectorWorldScale = new THREE.Vector3();
  private readonly sectorSunLocal = new THREE.Vector3();
  private readonly sectorSunWorld = new THREE.Vector3();
  private readonly sectorPoint = new THREE.Vector3();
  private readonly sectorNormal = new THREE.Vector3();
  private readonly sectorEast = new THREE.Vector3();
  private readonly sectorNorth = new THREE.Vector3();
  private readonly sectorToCam = new THREE.Vector3();
  private readonly sectorStepScale: ProjectedStepScale = { maxPx: 0, minPx: 0, x: 0, y: 0 };
  private readonly sectorWorldQuat = new THREE.Quaternion();
  private readonly sectorWorldQuatInv = new THREE.Quaternion();
  /** Last frame's world orientation per streamed body, for the spin gate. */
  private readonly sectorSpin = new Map<string, { quat: THREE.Quaternion; tMs: number; heldUntilMs: number }>();
  /** Monotonic per-update() stamp guarding the shared projection caches (the
   *  Sun's below, and each moon's on MoonMesh). One increment site covers
   *  cruise and landed: updateLanded runs inside update(). */
  private frameStamp = 0;
  /** The frameStamp whose OrbitControls damping step has already run — the
   *  controls wrapper (see the constructor) uses it to hold the instance to
   *  one step per rendered frame. */
  private controlsDampingFrame = -1;
  /** The Sun's screen projection, measured once per frame and shared by its
   *  four per-frame consumers (exposure meter, occlusion pass, sun shader,
   *  sun label) — identical inputs, so one measurement serves all. Its own
   *  object, never the sphereScreenProjection scratch: consumers hold the
   *  reference across their whole pass. */
  private sunScreenProjectionCache: SphereScreenProjection = {
    x: 0, y: 0, ndcX: 0, ndcY: 0, ndcZ: 0,
    footprintX: 0, footprintY: 0, radiusPx: 0, diameterPx: 0,
    minX: 0, maxX: 0, minY: 0, maxY: 0,
    footprintKind: 'none',
  };
  private sunScreenProjectionFrame = -1;
  private tmpSunOccluderPosition = new THREE.Vector3();
  private tmpSunOccluderDirection = new THREE.Vector3();
  private tmpSunOccluderScale = new THREE.Vector3();
  private tmpSunAtmosphereOffset = new THREE.Vector3();
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
  // resolveOrbitSubject memo — see its comment; keyed by reference identity.
  private orbitSubjectMemo: {
    landedOn: LandedTarget;
    pairMoon: { moonName: string; parentName: string } | null;
    subject: { moonName: string; parentName: string } | null;
  } | null = null;
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
  /** Cached flyby aim for the autopilot blend zone. `moonArrivalPose` builds a
   *  dozen vectors per call, and the pose depends only on the moon/parent
   *  state — so recompute when the moon has moved a couple percent of the
   *  standoff (every frame under warp, almost never at 1×), not per frame. */
  private autopilotAim = new THREE.Vector3();
  private autopilotAimMoonPos = new THREE.Vector3();
  private autopilotAimFor: string | null = null;

  /** Per-planet moon-shadow caster candidates, keyed by the sun's angular
   *  size at the parent when built — see the rebuild gate in
   *  updateMoonPositions. */
  private moonShadowCasterCache = new Map<string, { sunTan: number; names: Set<string> }>();

  // Moon world positions in AU (true positions, not offset). Entries are
  // written only while a moon is shown and are never pruned, so `pass` (the
  // updateMoonPositions pass that last wrote the entry, from
  // moonVelPassIndex) is the freshness stamp: consumers that must not act on
  // a frozen position from a system left long ago (getTargetWorldPosition)
  // accept an entry only within one pass of current. Entries are mutated in
  // place — steady-state frames allocate nothing here.
  private moonWorldPositions = new Map<string, { x: number; y: number; z: number; pass: number }>();
  /** Per-moon world velocity (AU per frame-second, the same capped dt the
   *  ship integrates on), differenced in updateMoonPositions from
   *  consecutive passes of the map above — the governor's moving-body
   *  credit reads it (same one-frame staleness as the positions, so the
   *  pair stays consistent). `pass` gates the difference: a moon whose
   *  entry wasn't written on the immediately previous pass (re-entering
   *  visibility, a mode gap) restamps at zero instead of reading the gap
   *  as a teleport. */
  private moonWorldVels = new Map<string, { x: number; y: number; z: number; pass: number }>();
  /** Pass counter + the sim clock the last pass saw: updateMoonPositions
   *  detects clock discontinuities ITSELF (the sim advance not matching
   *  dt × rate) rather than trusting every jump seam to raise a flag —
   *  timeJumpToNow, the typed date field, and milestone stagings all write
   *  the clock without going through setCurrentUtcMs. */
  private moonVelPassIndex = 0;
  private moonVelPrevSimMs = Number.NaN;
  /** Photometric sub-pixel moon dots (world/MoonDots) + their live knobs. The
   *  buffers fill in updateMoonDotsForCamera after the final camera pose. */
  private moonDots: MoonDots | null = null;
  private moonDotParams: MoonDotParams = { ...MOON_DOT_PARAMS };
  private moonLabelPlacementParams: MoonLabelPlacementParams = { ...MOON_LABEL_PLACEMENT_PARAMS };
  /** Faint-limit magnitude the dots' faint-end handoff lines up to — the
   *  starfield's pinned anchor, not the catalog's dimmest entry. */
  private starFaintLimitMag = 6.5;
  /** Eased telescope light grasp behind the starfield's uStarGain. 1 outside
   *  the surface view, where it is a no-op on every star. */
  private starGain = 1;
  /** Per-system inward fade [0,1], cached in updateMoonPositions where the
   *  player distance / visibility threshold are in hand. */
  private moonSystemEdgeFade = new Map<string, number>();
  private tmpDotMoonPos = new THREE.Vector3();
  /** Parent planet's world position for the dot pass, seeded once per planet so
   *  the per-moon proximity release reads it without clobbering tmpDotMoonPos. */
  private tmpDotParentPos = new THREE.Vector3();
  private tmpDotChroma = { r: 1, g: 1, b: 1 };
  private tmpDotVisual: MoonDotVisual = { intensity: 0, alpha: 0, sizePx: 0, brightness: 0, magnitude: 0 };
  /** Dedicated scratch for the fully-lit twin of each dot. Separate from
   *  tmpDotVisual on purpose: that result's size and brightness are still needed
   *  for the GPU write, so sharing one object would corrupt the dot itself. */
  private tmpDotLitVisual: MoonDotVisual = { intensity: 0, alpha: 0, sizePx: 0, brightness: 0, magnitude: 0 };
  /** The moon a nav lock is aimed at, kept alive past autopilot disengage /
   *  arrival-look drop so its dot floor and label exemption survive manual
   *  flight to the moon. Session-only, never persisted; cleared on a jump/engage
   *  to a different body, landing, deactivate, and on leaving the parent's
   *  system threshold (see updateMoonPositions / currentDotTargetMoon). */
  private dotNavMoon: { name: string; parentPlanet: string } | null = null;
  /** The latest moon-jump target, governed and collision-checked by name
   *  while its mesh may still be unpainted behind the arrival veil (the
   *  visibility-keyed set can't see it there). Drops once the mesh shows;
   *  a stale seed is neutralized by distance on its own. */
  private governedMoonSeed: { name: string; parentPlanet: string } | null = null;
  /** The cruise aim pipeline's state (see cruiseAim.ts, the module header
   *  is the subsystem doc): arrival-look bookkeeping plus the continuity
   *  filter that makes one-frame aim snaps structurally impossible outside
   *  an authored cut. Advanced once per frame by updateCruiseAimStage —
   *  the LAST cruise camera writer, after the final position. */
  private cruiseAim = createCruiseAimState();
  /** Catalog refs for the live arrival look's analytic position (parent
   *  world + ephemeris offset — a cold jump's mesh is invisible while it
   *  paints, so the mesh transform can never be the source). Set by
   *  jumpToMoon, cleared wherever the look is cleared. */
  private arrivalLookMoon: MoonData | null = null;
  private arrivalLookParentBody: PlanetData | null = null;
  private tmpAimMoonWorld = new THREE.Vector3();
  private tmpAimDir = new THREE.Vector3();
  private tmpAimTarget = new THREE.Vector3();
  /** Reused arrival-pose inputs for the engaged moon autopilot: refilled from
   *  live positions/scale each frame (resolveAutopilotMoonInputs) so the glide
   *  cap, aim blend, and arrival test allocate nothing in steady flight. */
  private tmpAutopilotInputs: MoonArrivalInputs = {
    moonPos: new THREE.Vector3(),
    parentPos: new THREE.Vector3(),
    orbitR: 0,
    renderedR: 0,
    parentCollision: 0,
    parentClearance: 0,
    camDist: CRUISE_CAM_DIST_AU,
    shipClearance: SHIP_CLEARANCE_AU,
  };
  /** Body-proximity governor state: the eased candidate/applied cap plus the
   *  engaged latch and its clear-hold (see arrivalLogic.advanceBodyCap).
   *  Reset to initialBodyCapState() on every flight discontinuity — jump,
   *  takeoff, restore — so no ramp or partial clear-hold survives one. */
  private bodyCap: BodyCapState = initialBodyCapState();
  /** Pooled shell list for the per-frame camera-safety pass (grown once,
   *  fields overwritten each frame — no steady-state allocation). */
  private cameraShellPool: CameraBodyShell[] = [];
  private cameraShellCount = 0;
  private tmpRingLocal = new THREE.Vector3();
  /** The player position applyFloatingOrigin subtracted THIS frame — i.e.
   *  the frame the scene actually renders in. See applyFloatingOrigin. */
  private renderOriginAU = { x: 0, y: 0, z: 0 };
  /** Player position at the top of the frame — the collision sweep needs the
   *  whole segment, not the endpoint (one 100 ms frame at the in-system
   *  default steps ~2,500 km, clean through a small moon's bubble). */
  private prevPlayerPos = new THREE.Vector3();
  /** The armed shell-contact graze (see applyShellContact / applyContactAim):
   *  the unit aim the nose eases onto after a hands-off bump. Transient —
   *  never saved; steering input, autopilot, jumps, landings, and the
   *  post-contact TTL all retire it. */
  private contactAimTarget = new THREE.Vector3();
  private contactAimActive = false;
  private contactAimAgeS = 0;
  private tmpContactForward = new THREE.Vector3();

  private layoutMode: PlanetariumLayout = 'realistic';
  // The current frame's wall delta in ms — the system map's scale animation
  // rides real time, not the sim-capped clock. Set at the top of update().
  private lastFrameDtMs = 16;

  private timeState: SimulationTime = {
    currentUtcMs: Date.now(),
    rate: 1,
    paused: false,
  };
  // Until when (performance.now()) a resume re-asserts the pause instead of
  // starting the clock — armed whenever the clock freezes, with a window
  // sized by how knowingly it froze. See setTimePausedFromControl.
  private pauseGuardUntilMs = -Infinity;

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
  // The profile-aware ship/Sun QA pose must survive updatePlanetScaling's
  // deliberate per-frame mission-profile reassertion. Null in normal runtime;
  // only the DEV bridge can set it.
  private devShipProfileOverride: ShipProfile | null = null;

  // Near-Sun coverage meter — telemetry for the dev bridge only. The exposure
  // that actually reaches the render is sunExposure: updateSunShader adapts it
  // (asymmetric clamp/recover, interior-dive tier, eclipse fraction) and
  // takeExposureTarget() hands the pre-smoothed value to main.ts, the sole
  // renderer.toneMappingExposure writer, which pins 1 in every other mode.
  private exposureTarget = 1;
  private exposureCoverage = 0;
  private tmpSunView = new THREE.Vector3();

  /** Removals for the constructor's canvas listeners (orbit drag, map pick,
   *  contextmenu): the renderer's canvas is shared across app modes and
   *  outlives this one, so its listeners must be dropped in dispose() or they
   *  keep the whole mode reachable. */
  private canvasTeardowns: Array<() => void> = [];

  // Touch and gyro flight state. Touch has no throttle axis: thrust rides the
  // on-screen speed buttons, the zone steers only.
  private touchYaw = 0;
  private touchPitch = 0;
  private activeFlightTouchId: number | null = null;
  private gyro: GyroSteering;

  // Chase camera ownership. 'chase' follows the ship; 'orbit' hands the camera
  // to a live user drag and its damping coast; 'reacquiring' walks the outside
  // of the camera sphere back to the chase pose. A flight discontinuity or
  // steering input is what leaves 'orbit' — there is no timed handback.
  private camOwner: 'chase' | 'orbit' | 'reacquiring' = 'chase';
  // 0 idle → 1 turning, eased — the chase-follow τ rides on it.
  private camFollowTurnBlend = 0;
  private orbitDragging = false;
  private orbitPointerId: number | null = null;
  // A scripted transfer that completes under a still-held drag owes the chase
  // a reclaim; the release handler consumes it.
  private pendingChaseReclaim = false;
  private orbitPointerStartX = 0;
  private orbitPointerStartY = 0;
  private readonly tmpChaseIdeal = new THREE.Vector3();
  /** Scratch for per-frame writeForwardDirection reads (chase follow,
   *  reacquire, body-cap governor, shell contact). Each consumer uses the
   *  vector immediately — never held across another consumer's turn. */
  private readonly tmpForwardDir = new THREE.Vector3();

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
  // Set when the click that dismissed the coach mark is the same click
  // entering the surface view; consumed by that one entry. Every window-click
  // path that ends WITHOUT entering (picker opens instead, mission gap, live
  // event gone) clears it — left armed, it would eat the hint on some later,
  // unrelated entry.
  private coachSuppressesNextSurfaceHint = false;
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
  // Solar-eclipse standing point, pinned at the event's peak in the landed
  // planet's rotating frame (computeSpotAnchorLocal) so the observer stays on
  // real ground while the eclipse sweeps over. Pinned lazily on the first
  // spot frame, cleared on every surface entry/re-point/exit.
  private surfaceSpotAnchor: THREE.Vector3 | null = null;
  // Marker over the tracked target — sticky across the hysteresis band.
  private surfaceMarkerKind: SurfaceMarkerKind = 'brackets';
  // Observatory-panel rect, cached per viewport size for the chevron clamp
  // (the panel is CSS-fixed; it only moves on resize — desktop side panel
  // vs ≤640px bottom sheet).
  private panelRectCache: { w: number; h: number; left: number; top: number } | null = null;

  // System map: a full-screen schematic of the whole solar system, a
  // session-only sub-state (surface-view pattern). Built lazily on first open;
  // never persisted. While open, the world simulation keeps running but its
  // presentation is gated — see the mapOpen writer guards and the
  // system-map-active body class.
  private systemMap: SystemMap | null = null;
  // The corner chart: the same schematic, drawn small in the top-left while
  // cruising, so the chart flies with you. Off unless the user turns it on —
  // the ☰ toggle is the one writer of the persisted preference (below), so a
  // save has an opinion only after a deliberate flip; dev/capture paths move
  // this widget state without touching it. The DOM surface that frames the
  // WebGL rectangle and takes the tap, and the rect both of those are written
  // from — one definition, so the frame and the pixels cannot drift apart.
  private showMiniChart = false;
  /** Stored corner-chart preference — null until the user flips the ☰ toggle,
   *  the skyPref idiom: an untouched preference is never persisted. */
  private miniChartPrefStored: boolean | null = null;
  private miniChartEl: HTMLElement | null = null;
  private miniRect: MiniChartRect = { left: 0, top: 0, width: 0, height: 0 };
  /** The same rectangle snapped inward to whole device pixels — what is
   *  actually drawn, and what the chart's camera is metered against. */
  private miniDraw: MiniDrawRect = {
    left: 0, bottom: 0, width: 0, height: 0,
    leftDevicePx: 0, bottomDevicePx: 0, widthDevicePx: 0, heightDevicePx: 0,
  };
  /** The canvas and pixel ratio the cached rects were built for. Both are pure
   *  functions of those, so a frame that finds them unchanged reuses the
   *  objects — and the ratio matters as much as the size, since the snap is
   *  what turns a CSS rectangle into device rows. */
  private miniRectCanvasW = -1;
  private miniRectCanvasH = -1;
  private miniRectPixelRatio = -1;
  /** Scratch for getDrawingBufferSize — read only on rect rebuilds. */
  private miniBufferSize = new THREE.Vector2();
  /** Scratch the ship's course is written into for the chart, both charts. The
   *  chart is handed the vector the ship itself flies along, never the pose
   *  angles behind it, and reading it must not allocate on a cruise frame. */
  private mapShipForward = new THREE.Vector3();
  /** The visibility question, asked every frame and answered in place — a fresh
   *  literal per frame is a per-frame allocation in the steady state. */
  private miniVisibility: MiniChartVisibility = {
    enabled: true,
    ready: false,
    landed: false,
    mapOpen: false,
    deckOpen: false,
    missionActive: false,
    tutorialActive: false,
    helpOpen: false,
    arrivalVeilUp: false,
  };
  /** What building the chart cost, wall ms (DEV forensics). It is built on the
   *  first frame it is wanted, which is a cruise frame. */
  private miniConstructMs = -1;
  /** Dev forensics: how many times the chart's rectangle has been built. It is
   *  a pure function of the canvas size, so this climbing on a still window is
   *  a per-frame allocation and shows up here and nowhere else. */
  private miniRectBuilds = 0;
  // Whether a plain close should reopen the Observatory panel / re-enter
  // surface view (the snapshot-and-restore ethos). openMap sets these when it
  // closes those states; a commit-side close clears them (reverse close).
  private mapRestorePanel = false;
  private mapRestoreSurface = false;
  private mapHud = new MapHUD(
    (trueScale) => this.setMapScale(trueScale),
    // The X during a committed dive cancels like Esc — the map stays open and
    // the camera restores — rather than closing over the commit and dropping
    // it with nothing on screen to say so.
    () => (this.mapDiving ? this.cancelMapDive() : this.closeMap()),
    (verb) => this.commitMapCard(verb),
    () => this.focusMapCard(),
    () => this.mapOverviewPressed(),
    () => this.warpToMapEvent(),
  );
  // Whether the chart's control panel is folded down to its glyph chip right
  // now, and what the next map open should show.
  // Two fields because they answer different questions: a dismissal folds the
  // panel away without speaking for the user, and only the collapse control
  // itself banks a preference. NOT to be confused with mapRestorePanel above,
  // which is about the OBSERVATORY panel.
  private mapPanelCollapsed = false;
  private mapPanelCollapsedPref = false;
  // Whether the first map of the session has decided the panel's opening
  // shape yet. It cannot be decided before then: the answer depends on which
  // layout the panel lays out in, and that is a measurement.
  private mapPanelSeeded = false;
  // Whether the gesture guide stands open beside the panel. Reset whenever
  // the panel folds away or the map closes: a rung of the Esc cascade answers
  // this flag, and it must never fire for a card nobody can see.
  private mapHelpOpen = false;
  // The (followed body, releasable) pair the find-a-body list was last painted
  // for, so the per-frame refresh repaints the chip only when it changes.
  private mapFollowingPainted: string | null = null;
  // The zoom readout's last written quantum, so the string is rebuilt only when
  // the printed number changes.
  private mapZoomReadoutQ = Number.NaN;
  // Which chart layers are switched on. Session state: the chart itself goes
  // back to the defaults on close, because the corner chart draws the same
  // objects and is not this session's to restyle.
  private mapLayers: MapLayerState = { ...MAP_LAYER_DEFAULTS };
  // The catalog name of the body the card is open on, or null. Also the map's
  // "picked" bridge state.
  private mapPicked: NonNullable<LandedTarget> | null = null;
  // Pointer bookkeeping for tap-vs-drag picking on the map canvas.
  private mapPickPointerId: number | null = null;
  // Set when the armed gesture can no longer be a tap (a second concurrent
  // pointer joined, or the pointer left the tap slop); cleared with the id.
  private mapPickPoisoned = false;
  private mapPickDownX = 0;
  private mapPickDownY = 0;
  private mapPickPointerType = 'mouse';
  // Double-tap candidate: the body a completed, unpoisoned pick landed on and
  // when. A second pick of the SAME body inside the window focuses it. Set only
  // by a real pick commit, and dropped by everything that ends the gesture or
  // takes the camera away — a stale candidate would focus a body the user last
  // touched minutes and one pinch ago.
  private mapTapName: string | null = null;
  private mapTapAtMs = 0;
  // Hover latch (fine pointers only). The map's bodies move under a resting
  // cursor at warp, so hover is resolved every frame from the last mouse
  // position rather than only when the mouse moves — and held, so a body does
  // not lose the emphasis the moment it slides off the pixel. `Valid` is
  // whether that stored position still describes a mouse on the canvas; the
  // anchor and the stamp are where and when the hold was last confirmed, which
  // is what both release terms are measured against.
  private mapHoverX = 0;
  private mapHoverY = 0;
  private mapHoverValid = false;
  private mapHoverName: string | null = null;
  private mapHoverAnchorX = 0;
  private mapHoverAnchorY = 0;
  private mapHoverHitMs = 0;
  // The cursor the canvas is carrying, so the per-frame pass writes it only
  // when it changes rather than on every frame a hover holds.
  private mapHoverCursor = false;
  // The held body a pointerdown landed on the hold's anchor — snapshotted at
  // DOWN, because between down and up the tap slop (6 px) and the latch's
  // reclaim radius (4 px) would otherwise disagree inside one gesture. Set
  // means the release commits this body without re-picking.
  private mapPickHeldName: string | null = null;
  // Dive / autopilot-close transition. The generation token is bumped by every
  // closeMap and by a cancel, so a superseded transition never fires its
  // commit. mapDiving gates picking/hover while a transition runs; mapCommitting
  // tells closeMap to leave the dive fade black for the hand-off.
  private mapDiving = false;
  private mapDiveGen = 0;
  private mapDiveActiveGen = -1;
  // Bumped by every user journey change — the map card's commit gesture, the
  // shared commit core's accepted commits (deck paths included), landings,
  // and takeoffs — so an async continuation (a mission's profile fetch) can
  // detect that a newer journey superseded it, whether that journey's dive
  // is still running or its arrival has already landed.
  private journeyCommitGen = 0;
  private mapDiveVerb: MapVerb | null = null;
  private mapDiveTarget: NonNullable<LandedTarget> | null = null;
  /** The other kind of commit the transition can carry: a chosen point in open
   *  space, which has no body and so no verb and no camera dive — just the
   *  fade-close the Autopilot commit already uses. */
  private mapDiveTeleport: { x: number; y: number; z: number; radiusAU: number } | null = null;
  private mapDiveIsCamera = false;
  // Wall-clock stamp (performance.now) of when the current transition began. The
  // input lock is timed off real elapsed time, not the sim dt (capped at 100 ms
  // in main.ts) — a frame hitch must never stretch the dive past its cap.
  private mapTransitionStartMs = 0;
  private mapCommitting = false;
  // Last distance value formatted onto the open card, quantized to the shown
  // precision, so the per-frame refresh reformats (and allocates a string) only
  // when the readout actually changes.
  private mapCardDistQ = NaN;
  // Last dive-fade opacity written to the DOM, quantized to 2 decimals, so the
  // per-frame fade skips redundant style writes.
  private mapFadeOpacityQ = -1;
  // The zoom buttons: which way each may still go (refilled in place every
  // frame), the last state painted onto the DOM, and the held-press repeat —
  // its pointer id, its direction, and the timer that spends the next notch.
  private mapZoomAvail: MapZoomAvailability = { zoomIn: false, zoomOut: false };
  private mapZoomInEnabled = true;
  private mapZoomOutEnabled = true;
  private mapZoomHoldPointerId: number | null = null;
  private mapZoomHoldDir = 0;
  private mapZoomHoldTimer = 0;
  private mapZoomHoldRepeats = 0;
  // The "scroll or pinch" line. Session-scoped by design: shown for the first
  // map of a page session and never again, and deliberately not persisted, so
  // a later session gets the reminder back.
  private mapZoomHintSeen = false;
  private mapZoomHintShown = false;
  private mapZoomHintTimer = 0;

  // ── Teleport anywhere ──────────────────────────────────────────────────
  // One gesture machine over the chart, alongside the pick and the map's own
  // controls: a right-click (desktop, which catches macOS ctrl-click and the
  // trackpad's two-finger tap) or a press held past MAP_TP_PRESS_MS on empty
  // chart offers a point in real space; the chip confirms it.
  //
  // The armed press: which pointer, where it went down (client px, the frame
  // the pick's own slop test uses), and the timer that matures it.
  private mapTpPressPointerId: number | null = null;
  private mapTpPressX = 0;
  private mapTpPressY = 0;
  private mapTpPressTimer = 0;
  /** The offer itself: the RAW heliocentric point in AU the chip names, null
   *  for no offer standing. Raw, not chart, on purpose — the chip reprojects
   *  it every frame, so it survives a follow flight, a drag and a scale
   *  animation without ever detaching from the place it means. */
  private mapTpPoint: { x: number; y: number; z: number } | null = null;
  private mapTpRadiusAU = 0;
  private mapTpChipEl: HTMLElement | null = null;
  private mapTpChipWired = false;
  private mapTpChipX = NaN;
  private mapTpChipY = NaN;
  /** False only between a matured long-press's offer and the next pointerdown
   *  on the chip itself: the maturing press's own finger-lift synthesizes a
   *  click at the touch point, and when the range clamp has walked the chip
   *  onto the finger that click would commit an offer nobody accepted. */
  private mapTpChipArmed = true;
  /** Half the chip's laid-out width, measured when it is shown — the frame
   *  clamp that keeps a long chip from clipping off a phone's edge. */
  private mapTpChipHalfW = 0;
  /** The chip's laid-out height, measured with the width — the top-edge clamp
   *  (the chip hangs entirely ABOVE its anchor, so a press near the top of the
   *  frame would otherwise stand an offer nobody can see). */
  private mapTpChipH = 0;
  /** Catalog moon-system reach per planet (see teleportSystemReachAU). */
  private tpSystemReachCache = new Map<string, number>();
  private mapTpRayOrigin = new THREE.Vector3();
  private mapTpRayDir = new THREE.Vector3();
  private mapTpChart = new THREE.Vector3();
  private mapTpScreen = { x: 0, y: 0 };
  private mapTpPick: TeleportPick = makeTeleportPick();

  // Moon labels
  private moonLabels = new Map<string, HTMLDivElement>();
  private moonLabelContainer: HTMLDivElement | null = null;
  // Pooled per-frame scratch for renderMoonLabels' de-overlap pass. The element
  // and the moon record ride along so the decision can be applied without a
  // lookup; the contest itself sees only the DOM-free candidate fields.
  private moonLabelCandidates: Array<
    MoonLabelCandidate & { label: HTMLDivElement; moon: MoonMesh }
  > = [];
  /** The names the label contest placed last frame, and the buffer this frame
   *  refills. Two sets swapped and refilled rather than one rebuilt, so an
   *  incumbent's defence of its slot never allocates a set per frame. Both are
   *  cleared wherever the previous frame's sky stops being an argument about
   *  this one — see clearMoonLabelIncumbents. */
  private moonLabelIncumbents = new Set<string>();
  private moonLabelIncumbentsBuffer = new Set<string>();
  /** Which way each label last slid to clear its own moon's disc. Same lifecycle
   *  as the incumbents: after a scene jump the side a name held is about a moon
   *  that is no longer there. */
  private moonLabelSlideSides = new Map<string, number>();
  /** Scratch for one anchor slide — the pass reads it out before the next call. */
  private moonLabelSlide: AnchorSlide = { x: 0, y: 0, side: 0 };
  private resumePrompt = new PlanetariumResumePrompt();
  private helpModal = new PlanetariumHelpModal();
  private menuPanel = new PlanetariumMenuPanel();
  private bottomBar = new PlanetariumBottomBar();
  private statsPanel = new PlanetariumStatsPanel();
  // Rail gestures land here directly (not through the window key handler),
  // so they carry their own menu/help lock — see timeControlsLocked.
  private timePanel = new PlanetariumTimePanel(TIME_RATE_PRESETS, {
    onRateIndex: (index) => { if (!this.timeControlsLocked()) this.setRailRateIndex(index); },
    onStep: (direction) => { if (!this.timeControlsLocked()) this.stepTimeRate(direction); },
    onPauseToggle: () => { if (!this.timeControlsLocked()) this.timeTogglePause(); },
    onNow: () => { if (!this.timeControlsLocked()) this.timeJumpToNow(); },
  });
  private observatoryPanel = new ObservatoryPanel(
    (type, direction) => this.handleObservatoryJump(type, direction),
    (event) => this.jumpToShadowEvent(event),
    (on) => {
      this.showShadowGuides = on;
      this.shadowVisuals.setGuidesVisible(on);
    },
    () => {
      this.cancelObservatoryEventSearch();
      // Self-closes (the panel's X, the phone sheet's drag-dismiss) bypass
      // closeObservatoryPanel — resync the telescope chip's .on accent here
      // or it stays lit until the next deck/panel toggle.
      this.updateClusterOnStates();
    },
    () => this.toggleSurfaceView(),
    () => this.watchLiveEvent(),
    (viaWindow) => {
      this.store.markLookupCoachSeen();
      // Two first-timer notices inside two seconds is one too many; the
      // controls hint comes back on the next entry if it is still unseen.
      this.coachSuppressesNextSurfaceHint = viaWindow;
    },
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
      // handlers — one idiom, no duplicate state (including the menu lock).
      if (this.timeControlsLocked()) return;
      if (action === 'pause') this.setTimePausedFromControl(true);
      else if (action === 'resume') this.setTimePausedFromControl(false);
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
  private observatoryEventSearch: ShadowEventSearch | null = null;
  private observatoryEventResults = new Map<string, ShadowEvent>();
  // Earliest end among the *displayed* event rows — with the clock running,
  // crossing it means a row has completed and the search must refresh.
  private observatoryRowsMinEndUtcMs: number | null = null;
  // The clock time the current result set was searched forward FROM. Reverse
  // playback can run the clock behind it, leaving every event in between
  // missing from "Upcoming" — the expiry check restarts off this anchor.
  private observatoryEventAnchorUtcMs: number | null = null;
  // What a sweep slice found this frame. One array, reused by both callers —
  // they run in the same thread and read it before releasing the frame.
  private eventSearchSlice: ShadowEvent[] = [];

  // The same sweep for the map card's next-event row, over the picked body's
  // system. Its own state end to end: the chart and the panel are never open
  // together (opening the map stashes the panel), but neither owns the other's
  // clock, results or restarts.
  private mapEventSearch: ShadowEventSearch | null = null;
  private mapEventResults = new Map<string, ShadowEvent>();
  /** Instant the live (or last) map sweep searched from; NaN before the first. */
  private mapEventFromUtcMs = Number.NaN;
  /** The event the row is showing, and what a tap on it warps to. */
  private mapEventRowEvent: ShadowEvent | null = null;
  /** Set by any rendered frame that sees the clock running backwards, so a
   *  reversal over between two guard looks still restarts the sweep. Only the
   *  guard tick and the sweep's own restarts/cancels clear it. */
  private mapEventReverseLatch = makeMapEventReverseLatch();
  /** Wall clock of the last guard tick — the guard runs at the UI cadence, not
   *  per frame, because its restarts are what a fast warp would otherwise
   *  churn. */
  private mapEventGuardAtMs = 0;

  // Sun label
  private sunLabel = new SunLabel();

  // FPS tracking (uses wall-clock time, not dt, for accuracy)
  private fpsFrames = 0;
  private fpsLastTime = performance.now();
  private fpsDisplay = 0;

  // UI elements
  private speedValueEl: HTMLElement | null = null;
  private lastSpeedText = '';
  private speedLabelEl: HTMLElement | null = null;
  private speedCenterEl: HTMLElement | null = null;
  private uiRefreshAccumulator = PlanetariumMode.UI_REFRESH_INTERVAL_S;
  private activeHistoricJourney: HistoricJourney | null = null;
  // Bumped on every mission start/stop: a start awaiting its profile fetch
  // re-checks it after the await and yields to whatever superseded it.
  private missionRequestGen = 0;
  private historicMilestoneIndex = 0;
  private historicPanelDismissed = false;
  private scriptedTransfer: ScriptedTransfer | null = null;
  private preMissionState: PlanetariumState | null = null;
  private preMissionMenuVisible = false;
  /** The pre-tool journey stashed when the volume-compare tool is entered. main.ts
   *  deactivates this mode for the tool (which exits landed mode and saves the
   *  taken-off state), so the snapshot is what restores the exact landing/camera/
   *  clock on return — and what getState() serves meanwhile, so a tab-close inside
   *  the tool reloads to the pre-tool landing. Same idiom as preMissionState. */
  private preToolState: PlanetariumState | null = null;
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
    this.updateTimeUI();
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
    this.updateTimeUI();
    this.helpModal.show();
  }

  private hideHelp() {
    if (!this.helpModal.isOpen()) return;
    this.helpModal.hide();
    if (this.resumeShipAfterHelp) this.player.moving = true;
    if (this.resumeTimeAfterHelp) this.timeState.paused = false;
    this.updateTimeUI();
    this.resumeShipAfterHelp = false;
    this.resumeTimeAfterHelp = false;
    this.store.markHelpSeen();
  }

  // Mode switching lives in main.ts, not here; the "How many fit?" Tools entry
  // calls this stored callback so main.ts can drive switchAppMode
  // (MoonFlight's onExit idiom).
  private volumeCompareRequestCb: (() => void) | null = null;
  onVolumeCompareRequest(cb: () => void): void {
    this.volumeCompareRequestCb = cb;
  }

  active = false;
  private useBloom: boolean;
  /** Live answer to "does the scene render into a target (the composer) or
   *  straight to the canvas" — the owner of the composer supplies it, so the
   *  boot shader warm-up compiles the variant the frame actually draws. */
  private readonly rendersThroughComposer: () => boolean;
  // Dev tripwire for the warm-up: program count right after it, compared a
  // couple of frames later — the first live frames must not compile anything
  // it missed (that stall is the very thing it exists to prevent).
  private shaderWarmupProgramCount: number | null = null;
  private framesSinceShaderWarmup = 0;

  constructor(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    renderer: THREE.WebGLRenderer,
    useBloom = true,
    rendersThroughComposer: () => boolean = () => useBloom,
  ) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.useBloom = useBloom;
    this.rendersThroughComposer = rendersThroughComposer;
    // Capture device texture caps from the live renderer before any body loads,
    // so anisotropy and tier limits apply to the very first textures created.
    // The touch budget is the same device class the sector caps and the
    // boot warm use, not a bare touchscreen test: a touch laptop is a desktop.
    captureDeviceTextureCaps(renderer, this.touchFirstDevice());
    // Resolve the bitmap-upload probe during construction: every streamed
    // boot texture awaits its verdict before fetching, so starting it here
    // takes it off the first fetch's critical path.
    warmBitmapUploadProbe();
    // Warm uploads go through the renderer so freshly loaded maps reach the
    // GPU on quiet frames instead of inside a gesture's first draw.
    bindTextureWarmer((tex) => renderer.initTexture(tex));
    // The 8K compressed tier's loader (see PlanetFactory's TIER_FILE_OVERRIDES),
    // bound lazily: the KTX2 machinery — loader chunk, transcoder worker, wasm —
    // loads only if a session actually earns that tier. Fail-open at every step:
    // a failed import or load lands in the ladder's own onError, whose cooldown
    // and one-rung-short worst case are the same as any 8K network failure.
    bindKtx2TierLoader((url, onLoad, onError) => {
      this.ktx2Loader ??= import('three/examples/jsm/loaders/KTX2Loader.js').then(({ KTX2Loader }) =>
        new KTX2Loader()
          .setTranscoderPath(import.meta.env.BASE_URL + 'basis/')
          .detectSupport(renderer),
      );
      this.ktx2Loader.then(
        (loader) => loader.load(url, onLoad, undefined, onError),
        (err) => onError(err),
      );
    });
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
      invalidateTextureWarmCache();
      // Sector tiles closed their decoded bitmaps after upload, so a restore
      // cannot re-upload them: drop every sector now and hold streaming off
      // until the context is back (see glContextLost); they stream back in
      // from the service-worker cache after the restore.
      this.glContextLost = true;
      this.sectors?.dropAll();
      this.invalidateRtPaintedMoons(this.moonTexturer.onContextLost());
      // Dots gate on painted moons — blank them with the same invalidation so a
      // stale dot can't outlive the mesh it belonged to.
      this.moonDots?.clear();
    });
    glCanvas.addEventListener('webglcontextrestored', () => {
      this.moonTexturer.onContextRestored();
      // Anything a stray frame admitted while the context was lost was
      // "uploaded" into nothing: drop it before the latch clears.
      this.sectors?.dropAll();
      this.glContextLost = false;
    });
    this.player = new PlayerShip();
    this.store = new PlanetariumStore();

    this.controls = new OrbitControls(camera, renderer.domElement);
    this.controls.enableDamping = true;
    // Re-derived from real frame time at the top of update(); this seeds the
    // first frame only.
    this.controls.dampingFactor = cameraFollowGain(1 / 60, ORBIT_DAMPING_TAU_S);
    this.controls.enabled = false;
    this.controls.minDistance = CRUISE_CONTROLS_MIN_DISTANCE_AU;
    this.controls.maxDistance = 5;
    // OrbitControls advances its damping by a fixed fraction per update()
    // CALL, and its own pointer/wheel handlers each call update() on top of
    // this mode's per-frame call. Whether a frame catches an input event is
    // set by the beat between device report rate and refresh rate, so during
    // a drag the camera advanced ~2× on event frames vs quiet ones — a speed
    // flutter that reads as jitter against a large nearby disc. Hold the
    // instance to ONE step per rendered frame: the first call in a frame
    // claims the stamp, later ones just accumulate their input deltas for the
    // next frame's step — the render could not have shown them any earlier.
    // While the mode is inactive update() never stamps, so pass handler calls
    // through untouched rather than gate them against a frozen stamp.
    const stepControlsDamping = this.controls.update.bind(this.controls);
    this.controls.update = (deltaTime?: number | null): boolean => {
      if (this.active) {
        if (this.controlsDampingFrame === this.frameStamp) return false;
        this.controlsDampingFrame = this.frameStamp;
      }
      return stepControlsDamping(deltaTime);
    };

    // Yield the chase cam only on an actual orbit drag, never on a plain
    // click. We track raw pointer pixels because the chase cam moves the
    // camera every frame, so an angle-based OrbitControls test would
    // false-trigger.
    const orbitDom = renderer.domElement;
    // Registered through this helper so dispose() can remove them: the canvas
    // outlives the mode (main.ts shares one renderer across modes).
    const onCanvas = <K extends keyof HTMLElementEventMap>(
      type: K,
      listener: (e: HTMLElementEventMap[K]) => void,
      options?: AddEventListenerOptions,
    ) => {
      orbitDom.addEventListener(type, listener, options);
      this.canvasTeardowns.push(() => orbitDom.removeEventListener(type, listener, options));
    };
    onCanvas('pointerdown', (e) => {
      // Surface view owns the pointer (SurfaceLook): don't let its drags
      // pollute the orbit chase-cam bookkeeping.
      if (!this.active || this.landedView === 'surface') return;
      // Only a primary-button drag on a device where cruise OrbitControls is
      // live may claim the camera. A device that cannot orbit (touch, where a
      // bottom-bar swipe would otherwise freeze the chase) or a pan/dolly
      // button must never take ownership — there is no longer a timeout to
      // hand it back.
      if (!this.controls.enabled || e.button !== 0) return;
      // One pointer owns the drag bookkeeping: a second touch/button joins
      // OrbitControls' own gesture but never rebinds the tracked id (a rebind
      // would leave the first pointer uncancellable at a discontinuity).
      if (this.orbitDragging) return;
      this.orbitDragging = true;
      this.orbitPointerId = e.pointerId;
      this.orbitPointerStartX = e.clientX;
      this.orbitPointerStartY = e.clientY;
      // A press is already interaction intent: hand the flythrough look back
      // NOW, not at the 4px drag threshold — otherwise a held-still press
      // sits under a camera that starts tracking the moon a few seconds in.
      // Matches the touch zone, where a stationary tap is full input. (The
      // camera does not move here: at the standoff the look is un-engaged —
      // zero deflection — and mid-pass the release is the eased fade.)
      releaseArrivalLook(this.cruiseAim);
    });
    onCanvas('pointermove', (e) => {
      if (!this.orbitDragging || e.pointerId !== this.orbitPointerId || this.camOwner === 'orbit') return;
      const dx = e.clientX - this.orbitPointerStartX;
      const dy = e.clientY - this.orbitPointerStartY;
      if (dx * dx + dy * dy > 16) {
        // Moved > 4px = a drag: the user owns the camera. Legal from any
        // owner — OrbitControls re-derives its spherical from the live camera.
        this.camOwner = 'orbit';
        // Keep the user's orbiting off the rig's polar singularities, but
        // ratchet to the grab pose: a steep-flight chase pose can sit inside
        // the margin, and a fixed clamp would snap the camera on grab. The
        // user can always drag away from a pole, never newly into one.
        const polar = this.controls.getPolarAngle();
        this.controls.minPolarAngle = Math.min(ORBIT_POLAR_MARGIN_RAD, polar);
        this.controls.maxPolarAngle = Math.max(Math.PI - ORBIT_POLAR_MARGIN_RAD, polar);
        // The arrival look fades out under the drag rather than cancelling —
        // a one-frame cancel snapped the centred moon to the chase aim.
        releaseArrivalLook(this.cruiseAim);
      }
    });
    const endOrbitDrag = (e?: PointerEvent) => {
      if (!this.orbitDragging) return;
      if (e && e.pointerId !== this.orbitPointerId) return;
      this.orbitDragging = false;
      this.orbitPointerId = null;
      // No timeout: release leaves the camera where it was placed. The damping
      // coast finishes under 'orbit' ownership; steering or a flight
      // discontinuity is what reacquires the chase.
      if (this.pendingChaseReclaim) {
        // A transfer completed under this held drag; now that the pointer is
        // up, hand the parked postcard framing back to the chase.
        this.pendingChaseReclaim = false;
        if (this.camOwner === 'orbit') {
          flushOrbitDamping(this.controls);
          this.camOwner = 'reacquiring';
        }
      }
    };
    onCanvas('pointerup', endOrbitDrag);
    onCanvas('pointercancel', endOrbitDrag);
    // A wheel zoom is camera work like any drag or keypress: the player is
    // already composing the shot, so the flythrough look hands back rather
    // than panning underneath them. (OrbitControls consumes the wheel for
    // the dolly itself; this only retires the look.)
    onCanvas('wheel', () => {
      if (!this.active || this.landedView === 'surface') return;
      releaseArrivalLook(this.cruiseAim);
    }, { passive: true });

    // System-map picking shares the canvas with the map's OrbitControls: a tap
    // (small travel) picks a body / dismisses the card, a drag orbits. All the
    // handlers no-op unless the map owns the frame.
    onCanvas('pointerdown', (e) => this.mapPointerDown(e));
    onCanvas('pointerup', (e) => this.mapPointerUp(e));
    onCanvas('pointercancel', (e) => this.mapPointerCancel(e));
    onCanvas('pointermove', (e) => this.mapPointerMove(e));
    onCanvas('pointerleave', () => this.mapPointerLeave());
    // The desktop half of "teleport anywhere". The contextmenu event rather
    // than a button-2 pointerdown because it is the gesture, however it was
    // made: a right-click, macOS ctrl-click, a trackpad two-finger tap.
    onCanvas('contextmenu', (e) => this.mapContextMenu(e));
    // A release the canvas never sees (drag ends over the HUD, capture lost
    // without a canvas pointercancel) still ends the gesture: the window pair
    // only ever DISARMS — commits stay canvas-only, and after an on-canvas
    // release these run second and find the id already cleared.
    window.addEventListener('pointerup', this.onWindowMapDisarm);
    window.addEventListener('pointercancel', this.onWindowMapDisarm);

    window.addEventListener('blur', this.onWindowBlur);

    // Window-level capture tracker for the hover/tap body reveal (see the
    // handler fields). Registered once; every handler gates on `this.active`.
    window.addEventListener('pointerdown', this.onWindowPointerDown, true);
    window.addEventListener('pointermove', this.onWindowPointerMove, true);
    window.addEventListener('pointerup', this.onWindowPointerUp, true);
    window.addEventListener('pointercancel', this.onWindowPointerCancel, true);

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
    // Setting the clock rebuilds the whole sky at once — every body steps, so
    // the Sun's exposed fraction can jump. Snap the Sun-optics state (flash
    // baseline, silhouette dim, occluder incumbent) instead of reading the jump
    // as a limb clearing or letting a stale scene's occluder linger.
    this.noteSunViewDiscontinuity();
  }

  // Shared clock handlers — the time rail, its panel, the keyboard, and the
  // surface transport strip drive the same state through these (one clock,
  // one idiom).
  private setTimePausedFromControl(paused: boolean) {
    // A resume arriving moments after the clock froze is usually the second
    // half of a double-click, or a Pause-intent click chasing the silent
    // step-down detent. Re-assert the freeze in that window. An explicit
    // pause is idempotent: even if delivery was delayed by a busy frame, a
    // control that said Pause can never accidentally resume the clock.
    if (!paused && this.timeState.paused && performance.now() < this.pauseGuardUntilMs) {
      this.updateTimeUI({ flash: true });
      return;
    }
    this.timeState.paused = paused;
    if (paused) this.pauseGuardUntilMs = performance.now() + 350;
    this.updateTimeUI({ flash: true });
  }

  private timeTogglePause() {
    this.setTimePausedFromControl(!this.timeState.paused);
  }

  private timeJumpToNow() {
    this.timeState.currentUtcMs = Date.now();
    this.rebuildPlanetPositions();
    this.updateTimeUI();
    // A clock jump moves every body at once — the Sun's exposed fraction can
    // step hard, so reseed the flash baseline instead of reading it as a rise.
    this.noteSunViewDiscontinuity();
    // Clock jump invalidates the Observatory panel's upcoming-events list, and
    // the chart card's next-event row with it.
    this.startObservatoryEventSearch();
    this.startMapEventSearch();
  }

  /** The ☰ menu auto-pauses the clock and restores it on close, and the help
   *  modal freezes the scene — a rail gesture mid-menu would clobber the
   *  pause state the menu puts back. The window-level , . N shortcuts carry
   *  the same guard inline. */
  private timeControlsLocked(): boolean {
    return this.menuPanel.isOpen() || this.isHelpOpen();
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

  /** Per-frame bookkeeping shared verbatim by both frame drivers (update and
   *  updateLanded): FPS over wall-clock (independent of dt capping) and the
   *  8 Hz UI-refresh accumulator. Returns whether this frame refreshes UI. */
  private tickFrameCadence(dt: number): boolean {
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
    return shouldRefreshUi;
  }

  /** The sun-optics state family at its neutral baseline — one definition for
   *  activate() and deactivate(), so a field added to the family cannot be
   *  reset on one side of a mode switch and stay stale on the other. */
  private resetSunOpticsBaseline() {
    this.sunExposure = 1;
    this.lastSunVisibleFraction = 1;
    this.sunEmergenceFlash = 0;
    this.sunDiamondRing = 0;
    this.sunPoleScreenAngle = 0;
    this.sunChromoAnti = 0;
    this.sunChromoToward = 0;
    this.sunAtmosphereMix = 0;
    this.starGain = 1;
    this.renderer.toneMappingExposure = 1;
  }

  async activate(onProgress?: (progress: PlanetariumActivationProgress) => void): Promise<void> {
    this.active = true;
    this.resetSunOpticsBaseline();
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
        // The star catalog rides the same gate as the solar system: awaiting
        // it HERE (not later, next to the starfield build) keeps activate's
        // yield points where they always were — update() frames run during
        // activation, and a new suspension between the solarSystem assignment
        // and restoreState would hand them constructor-default state on a
        // slow network. main.ts kicked the load at init; this await usually
        // finds it already settled.
        const [solarSystem] = await Promise.all([
          createSolarSystem((progress) => {
            reportActivationProgress(progress.completedUnits);
          }, this.useBloom, this.layoutMode, new Date(initialWorldUtcMs)),
          loadBrightStarCatalog(),
        ]);
        this.solarSystem = solarSystem;
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
        this.planetMeshByName.set(planet.data.name, planet);
        const pos = planet.group.position;
        planet.worldPosAU = { x: pos.x, y: pos.y, z: pos.z };
        this.planetWorldPositions.set(planet.data.name, { x: pos.x, y: pos.y, z: pos.z });

        const moons = createMoonMeshes(planet.data.name);
        if (moons.length > 0) {
          this.planetMoons.set(planet.data.name, moons);
          const systemGroup = new THREE.Group();
          for (const m of moons) {
            systemGroup.add(m.mesh);
            this.moonMeshByName.set(m.data.name, m);
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
      this.registerSectorBodies();

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
    // Cache the label container the PlanetLabels constructor just appended, so
    // the per-frame container-visibility sync doesn't query the DOM each frame.
    this.planetLabelsContainerEl = document.getElementById('planet-labels');
    // The Sun label lives inside that container, which deactivate() destroys
    // with PlanetLabels — so it must re-attach per activation, not in the
    // once-per-session wireUpUI (a mode round-trip would orphan it: never
    // rendering again while its blocker rect still suppressed planet labels).
    this.sunLabel.attach();

    // Create the Planetarium starfield.
    if (!this.starfield) {
      performance.mark('plm:starfield:start');
      this.starfield = createPlanetariumStarfield(this.renderer.getPixelRatio());
      this.scene.add(this.starfield);
      performance.measure('plm:starfield', 'plm:starfield:start');
    }

    // Create the photometric moon-dot layer — one point per catalog moon, in
    // the fixed planet→moon iteration order the per-frame fill reuses. Recreated
    // on each activation (disposed on deactivate) like the planet labels.
    if (!this.moonDots) {
      this.starFaintLimitMag = starfieldFaintLimitMag();
      let dotCount = 0;
      for (const planet of this.solarSystem.planets) {
        dotCount += this.planetMoons.get(planet.data.name)?.length ?? 0;
      }
      this.moonDots = new MoonDots(dotCount, this.renderer.getPixelRatio());
      this.scene.add(this.moonDots.points);
    }

    if (this.preToolState) {
      // Returning from the volume-compare tool — restore the exact pre-tool
      // journey (landed body, camera, clock) captured on entry, not the store's
      // copy. Cleared so a later fresh activation reads the store normally.
      // Session-only landed sub-states (surface view, orbit details) drop, same
      // as a reload; the deck/panel are already closed by that entry.
      const pre = this.preToolState;
      this.preToolState = null;
      this.restoreState(pre);
    } else if (savedState && shouldPromptForResume) {
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
    this.camOwner = 'chase';
    if (!this.landedOn) {
      this.updateCruiseCamera(1 / 60); // one nominal-frame seat; the loop takes over
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
      performance.mark('plm:precompile:start');
      const probes = createShaderWarmupProbes();
      // The landed system's shadow visuals attach at landing, after this
      // compile pass — probe their material families here too, or the first
      // surface-view entry links those programs mid-gesture (a frozen frame
      // that reads as a dead click on slow GPUs).
      const shadowProbes = createShadowVisualsWarmupProbes();
      this.scene.add(probes.group, shadowProbes.group);
      // Compile with the live path's kind of target bound (three keys every
      // program on it) and force the links with one 1-pixel draw — see
      // world/shaderWarmup.ts for the why and the pinned contract. Fail-open:
      // on any failure lazy first-draw compilation remains the fallback.
      const { compiled } = await warmUpSceneShaders(this.renderer, this.scene, this.camera, {
        drawsThroughComposer: this.rendersThroughComposer(),
        probeGroups: [probes.group, shadowProbes.group],
        onError: (stage, err) => debugError(`Shader warm-up ${stage} failed`, err),
      });
      this.shaderWarmupProgramCount = this.renderer.info.programs?.length ?? null;
      this.framesSinceShaderWarmup = 0;
      // Probe materials are disposed only once compileAsync's poll has fully
      // settled — disposing a material mid-poll throws inside a timer callback
      // that no try/catch around the await could reach.
      void compiled.then(() => {
        this.scene.remove(probes.group, shadowProbes.group);
        probes.dispose();
        shadowProbes.dispose();
      });
      performance.measure('plm:precompile', 'plm:precompile:start');
    }

    // A restored landed session bypasses arriveThen's arrival veil. The load
    // screen is its cover: give the landed pair's first colour step the same
    // bounded settle window and upload it here if it arrives inside it.
    if (buildingSolarSystem && this.landedOn) {
      await this.settleRestoredLandedTextureUpgrades();
    }

    // Warm the constellation snap here, still behind the load screen: the
    // banded build costs ~10ms, and paying it now — rather than scheduling it
    // for later — guarantees the session's first consumer (the system map's
    // chart on M, or the sky's toggle) finds the memo hot however soon the
    // gesture comes.
    snapConstellations();

    this.scheduleBootPairWarm();

    reportActivationProgress(FIRST_PLANETARIUM_ACTIVATION_TOTAL_UNITS);
    performance.measure('plm:activate', 'plm:activate:start');
  }

  /** Arm the speculative Earth+Moon warm (see BOOT_PAIR_WARM_DELAY_MS).
   *  Idempotent across activations: a step already applied or in flight
   *  no-ops in upgradeTextureOnApproach's own guards. */
  private scheduleBootPairWarm(): void {
    window.clearTimeout(this.bootPairWarmTimer);
    this.bootPairWarmTimer = window.setTimeout(() => {
      if (!this.active) return;
      // An arrival owns the network and the frame budget for as long as its
      // veil is on screen. Speculation yields and tries again later.
      if (this.arrivalVeilUp()) {
        this.scheduleBootPairWarm();
        return;
      }
      // A metered connection gets no speculative bytes — the pair still
      // sharpens through the normal triggers when actually visited.
      const connection = (navigator as { connection?: { saveData?: boolean } }).connection;
      if (connection?.saveData) return;
      // Full speculation decodes and uploads the maps, parking two 4096-wide
      // maps' GPU storage for a pair the session may never visit. That is a
      // desktop budget; a touch-first device gets the bytes pulled into the
      // HTTP/service-worker cache only, so its later arrival skips the
      // network but pays no residency up front. (Quality tiers stay
      // capability-based — this split concerns speculation only, and
      // saveData is absent on iOS Safari so it cannot be the gate.)
      const cacheOnly = this.touchFirstDevice();
      for (const up of this.landingPairUpgrades({ type: 'planet', name: 'Earth' })) {
        // The live loader's attempt/cooldown gate, so a re-armed timer never
        // duplicates a pending desktop attempt. The cache-only fetch marks no
        // attempt on the handle, so a reactivation inside its download window
        // can start the same transfer twice — bounded, and the second ride
        // comes off the cache it is filling.
        if (!canAttempt(up, performance.now())) continue;
        const first = firstUpgradeTier(up);
        if (!first) continue;
        if (cacheOnly) {
          const tier = resolveUpgradeTier(up, first);
          // The body must be read to completion: an unread Response is
          // dropped, and the browser may cancel the transfer with it — the
          // bytes only reliably reach the HTTP/service-worker cache once the
          // stream has been drained.
          if (tier) {
            fetch(resolveTextureUrl(PLANET_TEXTURE_FILES[up.key], tier))
              .then((r) => r.arrayBuffer())
              .catch(() => {});
          }
        } else {
          upgradeTextureOnApproach(up, first);
        }
      }
    }, PlanetariumMode.BOOT_PAIR_WARM_DELAY_MS);
  }

  /** A phone or tablet: the device class that gets cache-only speculation and
   *  the smaller sector-tile working set. Capability-based quality tiers are
   *  unaffected; this only sizes what is held in memory on speculation. */
  private touchFirstDevice(): boolean {
    return (
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) || // iPadOS desktop UA
      (navigator.maxTouchPoints > 0 && window.innerWidth <= 1024)
    );
  }

  /** Wire the hero bodies' sector sets (SECTOR_SETS) onto their globe meshes.
   *  Sector meshes become children of the globe, so they ride its spin, pole
   *  and (for the Moon) the render-curve scale; the streamer forces the fine
   *  silhouette grid before the first sector shows. */
  private registerSectorBodies(): void {
    if (!this.sectorsEnabled || !this.solarSystem) return;
    const sectors = new SectorStreamer({ touch: this.touchFirstDevice() });
    for (const planet of this.solarSystem.planets) {
      const spec = SECTOR_SETS[planet.data.name];
      if (!spec) continue;
      const material = planet.mesh.material as THREE.MeshStandardMaterial;
      sectors.register({
        name: planet.data.name,
        spec,
        mesh: planet.mesh,
        material,
        radiusAU: planet.data.radiusAU,
        topMapWidth: topMapWidthOf(planet.textureUpgrades, material),
        ensureFineGeometry: () => { upgradeGeometryOnApproach(planet.geometryUpgrade, Number.POSITIVE_INFINITY); },
      });
    }
    for (const moons of this.planetMoons.values()) {
      for (const m of moons) {
        const spec = SECTOR_SETS[m.data.name];
        if (!spec) continue;
        const material = m.mesh.material as THREE.MeshStandardMaterial;
        sectors.register({
          name: m.data.name,
          spec,
          mesh: m.mesh,
          material,
          radiusAU: m.data.radiusAU,
          topMapWidth: topMapWidthOf(m.textureUpgrades, material),
          ensureFineGeometry: () => { upgradeGeometryOnApproach(m.geometryUpgrade, Number.POSITIVE_INFINITY); },
        });
      }
    }
    this.sectors = sectors;
  }

  /**
   * Per-frame sector streaming for the hero bodies. Runs every frame for
   * every registered body, independently of updateBodyLOD's skips: a fully
   * upgraded globe filling the view is exactly the one whose sectors must
   * keep being measured, admitted and released. Per body: the camera and the
   * Sun in the globe's local frame (radius = catalog radius there, whatever
   * the render scale), the magnification bound at its nearest surface point,
   * then per facing sector its frame membership (its bounding sphere against
   * the frustum) and the magnification at its nearest point — DEVICE pixels
   * per local unit along the screen direction the projection magnifies most,
   * which the streamer turns into pixels per texel of the finest map the globe
   * will hold.
   */
  private updateSectorStreaming(): void {
    const sectors = this.sectors;
    if (!sectors || !this.solarSystem) return;
    if (this.glContextLost) {
      sectors.dropAll();
      return;
    }
    const canvasW = this.renderer.domElement.clientWidth;
    const canvasH = this.renderer.domElement.clientHeight;
    const dpr = this.renderer.getPixelRatio();
    const nowMs = performance.now();
    const chart = this.isMapOpen();
    const grounded = this.landedView === 'surface' ? this.landedOn?.name ?? null : null;
    // The projections below read the camera's inverse world matrix; this
    // pass must not depend on the LOD pass (skipped under the chart) having
    // refreshed it this frame.
    this.camera.updateMatrixWorld();
    this.solarSystem.sun.getWorldPosition(this.sectorSunWorld);
    // Device pixels a world unit covers at unit distance at the CENTRE of the
    // displayed frame. The lens normalises the design FOV onto the frame's
    // edge, so the conversion is its displayed half-tangent; tan(fov/2) is the
    // overscan render's scale and reads 8% small at this FOV.
    const lens = this.camera.userData.lens as
      | { strength: number; designFovDeg: number; effectiveStrength?: number }
      | undefined;
    const lensStrength = lens ? lens.effectiveStrength ?? lens.strength : 0;
    const designFovDeg = displayFovDeg(this.camera);
    const focalDevicePx = ((canvasH / 2) / lensDisplayHalfTan(designFovDeg, lensStrength)) * dpr;
    // The lens stretches outward from the axis, so the same patch of surface
    // draws larger in a corner than at the centre. The skip-the-whole-body
    // bound below carries that factor to stay an upper bound on every sector.
    const maxFrameScale = lensMaxFrameScale(designFovDeg, this.camera.aspect, lensStrength);

    const visit = (name: string, mesh: THREE.Mesh, radiusAU: number, hidden: boolean) => {
      if (!sectors.has(name)) return;
      mesh.getWorldPosition(this.sectorWorldCentre); // refreshes matrixWorld too
      mesh.getWorldQuaternion(this.sectorWorldQuat);
      this.sectorWorldQuatInv.copy(this.sectorWorldQuat).invert();
      // Spin gate: how fast this body's orientation turned since its last
      // visit, in degrees per real second.
      let spinning = false;
      const prev = this.sectorSpin.get(name);
      if (prev) {
        const dtS = (nowMs - prev.tMs) / 1000;
        const angle = 2 * Math.acos(Math.min(1, Math.abs(prev.quat.dot(this.sectorWorldQuat))));
        const rate = dtS > 0 ? (angle * RAD2DEG) / dtS : 0;
        // Latched: past the suspend rate the hold starts, and any rate above
        // the resume rate while held extends it.
        const held = nowMs < prev.heldUntilMs;
        if (rate > PlanetariumMode.SECTOR_SPIN_SUSPEND_DEG_PER_S || (held && rate > PlanetariumMode.SECTOR_SPIN_RESUME_DEG_PER_S)) {
          prev.heldUntilMs = nowMs + PlanetariumMode.SECTOR_SPIN_HOLD_MS;
        }
        spinning = nowMs < prev.heldUntilMs;
        prev.quat.copy(this.sectorWorldQuat);
        prev.tMs = nowMs;
      } else {
        this.sectorSpin.set(name, { quat: this.sectorWorldQuat.clone(), tMs: nowMs, heldUntilMs: 0 });
      }
      // The ground under a surface observer isn't drawn (the near plane culls
      // it) and every sector "faces" a camera on the surface: hold nothing.
      // A hidden globe (an unpainted or out-of-range moon) holds nothing either.
      let suspend: SectorSuspend = 'none';
      if (hidden || grounded === name) suspend = 'all';
      else if (spinning || chart) suspend = 'admissions';
      const worldScale = mesh.getWorldScale(this.sectorWorldScale).x;
      const worldR = radiusAU * worldScale;
      this.sectorCamLocal.copy(this.camera.position);
      mesh.worldToLocal(this.sectorCamLocal);
      // Sun direction in the globe's frame, for the night-side gate.
      this.sectorSunLocal.copy(this.sectorSunWorld).sub(this.sectorWorldCentre).normalize()
        .applyQuaternion(this.sectorWorldQuatInv);
      // The most magnified surface point is the nearest one: device pixels
      // per local unit there bound every sector, and let the streamer skip
      // the per-sector work for a globe that is not close.
      const distCentre = this.sectorWorldCentre.distanceTo(this.camera.position);
      const pxPerLocalUnitNearest = (focalDevicePx * maxFrameScale * worldScale)
        / Math.max(distCentre - worldR, 1e-12);
      // One tangent step in this globe's local units. A texel of even the
      // finest map is smaller, and the projection is straight across it.
      const tangentStep = radiusAU * PlanetariumMode.SECTOR_TANGENT_STEP_RADII;
      const measure = (
        bsCentreLocal: THREE.Vector3, bsRadiusLocal: number, surfaceDirLocal: THREE.Vector3,
      ): SectorMeasure | null => {
        // Frame membership from the bounding sphere against the frustum. Not
        // from a projected footprint: close in, the camera sits INSIDE a
        // sector's bounding sphere, and the projected centre of a sphere the
        // camera is inside lands anywhere at all — which is what marked a
        // whole limb strip off-frame at a grazing pose and left it unfetched.
        this.sectorWorldCentre.copy(bsCentreLocal);
        mesh.localToWorld(this.sectorWorldCentre);
        const placement = placeSphereInFrustum(
          this.sectorWorldCentre, bsRadiusLocal * worldScale, this.camera,
        );
        // Nothing of it is in front of the camera: no measurement to make.
        if (placement === 'behind') return null;
        // Entirely outside the frame: nothing to sharpen, but a resident one
        // is a pan away — the streamer keeps it while it stays magnified.
        const offscreen = placement === 'aside';
        // Magnification at the surface point the streamer asks about (the
        // sector's point nearest the camera's): how many device pixels one
        // step of surface covers there, along the direction the projection
        // magnifies most. That is the larger singular value of the screen
        // Jacobian — a cosine between the normal and the line of sight gives
        // the SMALLER one, which foreshortens a limb sector to nothing while
        // its texels are still drawn several pixels wide along the limb.
        this.sectorNormal.copy(surfaceDirLocal);
        this.sectorPoint.copy(this.sectorNormal).multiplyScalar(radiusAU);
        mesh.localToWorld(this.sectorPoint);
        // The map's own axes at that point: east around the local +Y pole,
        // north across it. Any perpendicular pair of the same length would
        // give the same largest singular value; these are the ones the tiles
        // are cut on.
        this.sectorEast.set(this.sectorNormal.z, 0, -this.sectorNormal.x);
        if (this.sectorEast.lengthSq() < 1e-18) this.sectorEast.set(1, 0, 0);
        else this.sectorEast.normalize();
        this.sectorNorth.crossVectors(this.sectorNormal, this.sectorEast);
        this.sectorEast.multiplyScalar(tangentStep * worldScale).applyQuaternion(this.sectorWorldQuat);
        this.sectorNorth.multiplyScalar(tangentStep * worldScale).applyQuaternion(this.sectorWorldQuat);
        const scale = projectedStepScale(
          this.sectorPoint, this.sectorEast, this.sectorNorth,
          this.camera, canvasW, canvasH, this.sectorStepScale,
        );
        if (!scale) {
          // The point is at or behind the camera plane (a grazing pose): no
          // screen scale exists there, and nothing says where on the frame it
          // would land. Hold it at the scale it would have facing the camera
          // at its distance, so a resident sector swinging behind the viewer
          // is kept for the pan back rather than dropped.
          this.sectorToCam.copy(this.camera.position).sub(this.sectorPoint);
          const dist = this.sectorToCam.length();
          if (!(dist > 0)) return null;
          return { pxPerLocalUnit: (focalDevicePx * worldScale) / dist, centrality: 0, offscreen };
        }
        // Centrality of the measured point itself — the place that has to be
        // sharp — rather than of a bounding sphere reaching a quarter of the
        // way round the globe.
        const dx = (scale.x - canvasW / 2) / Math.max(canvasW / 2, 1);
        const dy = (scale.y - canvasH / 2) / Math.max(canvasH / 2, 1);
        return {
          pxPerLocalUnit: (scale.maxPx * dpr) / tangentStep,
          centrality: Math.max(0, 1 - Math.hypot(dx, dy)),
          offscreen,
        };
      };
      sectors.update(name, this.sectorCamLocal, measure, nowMs, suspend, this.sectorSunLocal, pxPerLocalUnitNearest);
    };

    // Measure every body first, then let the streamer reconcile them together:
    // the bodies are visited in catalog order, and a working set decided body
    // by body would rank Earth's fresh scores against the Moon's last frame.
    sectors.setGlobalMapBytes(this.liveGlobalMapBytes());
    sectors.beginFrame();
    // Paired: between these two the streamer only measures. A body that
    // threw on the way past would otherwise leave the frame open for good —
    // every later frame measuring and none of them ever reconciling, which
    // reads as tiles quietly stopping rather than as an error.
    try {
      for (const planet of this.solarSystem.planets) {
        visit(planet.data.name, planet.mesh, planet.data.radiusAU, !planet.mesh.visible);
      }
      for (const moons of this.planetMoons.values()) {
        for (const m of moons) visit(m.data.name, m.mesh, m.data.radiusAU, !m.mesh.visible);
      }
    } finally {
      sectors.endFrame();
    }
  }

  /**
   * What the sector streamer is owed on a frame that measures nothing (the
   * system map owns it). The ladder behind the chart keeps applying globe
   * maps and the tile fetches keep ageing, so the sectors' share of the
   * memory envelope and the deadline on a hung load are kept current here.
   * Trims and expires only — nothing is fetched for a surface the frame
   * does not draw.
   */
  private maintainSectorStreaming(): void {
    const sectors = this.sectors;
    if (!sectors || !this.solarSystem) return;
    if (this.glContextLost) {
      sectors.dropAll();
      return;
    }
    sectors.maintain(this.liveGlobalMapBytes(), performance.now());
  }

  /**
   * GPU bytes the colour tiers the ladder has streamed in are holding right
   * now — the Moon's 8K rung, Earth's cloud deck, every close-approach
   * upgrade. The sector budget is what one memory envelope leaves over these,
   * so a body on its finest map and a body streaming tiles cannot each spend
   * the device's memory as if the other were not there. The boot maps every
   * device carries regardless are not in it: this figure is the ladder's
   * OPTIONAL weight, which is what the envelope was measured against.
   */
  private liveGlobalMapBytes(): number {
    if (!this.solarSystem) return 0;
    let bytes = 0;
    for (const planet of this.solarSystem.planets) {
      for (const up of planet.textureUpgrades) bytes += appliedTierGpuBytes(up);
    }
    for (const moons of this.planetMoons.values()) {
      for (const m of moons) for (const up of m.textureUpgrades) bytes += appliedTierGpuBytes(up);
    }
    return bytes;
  }

  /** Dev bridge: what the streamer holds right now. */
  devSectorStats(): SectorStats | null {
    return this.sectors?.stats() ?? null;
  }

  private ensureConstellationsReady() {
    if (!this.constellations) {
      this.constellations = new Constellations();
      this.scene.add(this.constellations.lines);
    }
    this.constellations.setVisible(this.showConstellations);
  }

  private async settleRestoredLandedTextureUpgrades(): Promise<void> {
    // The load screen owns the wait-list the same way an arrival cover does,
    // so a teleport taken straight out of a restored session sees it too.
    // Boot waits on the landed BODY alone, not the pair: the reveal frames
    // the body front and centre, and holding a returning player's whole boot
    // behind the companion's cloud deck (4 MB for a backdrop) is what pushed
    // this hold to its cap on every landed-on-the-Moon save. The companion's
    // prefetch still runs — it just sharpens a beat after the reveal.
    this.arrivalUpgradeBatch = this.coverWaitList(
      this.landedOn ? this.textureUpgradesForTarget(this.landedOn) : [],
    );
    const batch = this.arrivalUpgradeBatch;
    const stillInFlight = () => batch.filter((e) => e.up.attempt?.generation === e.generation);
    const deadline = performance.now() + PlanetariumMode.ARRIVAL_UPGRADE_HOLD_MAX_MS;
    while (this.active && performance.now() < deadline && stillInFlight().length > 0) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    // Bounded, so a slow fetch can reach here still running. Release the wait
    // and let it finish — it applies on a quiet frame later instead of leaving
    // the body on its boot map for the session.
    for (const e of stillInFlight()) cancelTextureUpgrade(e.up, 'keep');
    pumpTextureWarmQueue(Number.POSITIVE_INFINITY);
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
    // Clear + cut: deactivation is an authored discontinuity (the next
    // activation reposes absolutely), so the aim adopts fresh on return.
    clearArrivalLook(this.cruiseAim);
    cutAim(this.cruiseAim);
    this.arrivalLookMoon = null;
    this.arrivalLookParentBody = null;
    this.dotNavMoon = null;
    this.clearMoonLabelIncumbents();
    this.clearBodyReveal();
    // Another mode gets the GPU memory back; sectors stream in again from the
    // service-worker cache on the next activation.
    this.sectors?.dropAll();
    this.sectorSpin.clear();
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
    window.clearTimeout(this.bootPairWarmTimer);
    this.resetSunOpticsBaseline();
    if (this.starfield) setStarfieldGain(this.starfield, 1);
    this.applySunGlareFlood(0);
    this.clearSunSilhouette();

    // Hand the camera back on the fixed near plane — another mode (or a
    // reactivation's first landed frame) must never inherit cruise's
    // dynamic near, which can sit as small as 3 km after a close pass.
    if (this.camera.near !== LANDED_NEAR_AU) {
      this.camera.near = LANDED_NEAR_AU;
      this.camera.updateProjectionMatrix();
    }
    // Same for the camera basis: cruise leaves the flight horizon on
    // camera.up, and another mode (or a reactivation's first landed frame)
    // must inherit plain world-up.
    this.setCameraFrameUp(PlanetariumMode.SCENE_NORTH);
    // Same for the governor: activation flips `active` before the restore
    // resolves, so the reactivation window must not run on this journey's
    // leftover cap or clear-hold.
    this.bodyCap = initialBodyCapState();
    this.player.speedCapAUPerS = Infinity;

    this.store.saveState(this.getState());
    this.store.stopAutoSave();

    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    this.gyro.detach();
    this.touchYaw = 0;
    this.touchPitch = 0;
    this.uiRefreshAccumulator = PlanetariumMode.UI_REFRESH_INTERVAL_S;

    // Camera ownership is session-transient: a reactivation reseats the chase.
    // Cancel any held drag first so OrbitControls' gesture (capture, document
    // listeners) doesn't outlive the mode.
    this.cancelOrbitGesture();
    this.camOwner = 'chase';
    this.pendingChaseReclaim = false;

    this.controls.enabled = false;

    const planetariumUI = document.getElementById('planetarium-ui');
    if (planetariumUI) planetariumUI.style.display = 'none';
    // The mode is tearing down — close the map without restoring its transient
    // panel/surface state (there is nothing to return to). The corner chart
    // stands down here rather than at its own per-frame rule: the update pass
    // that owns that rule stops running the moment `active` goes false.
    this.closeMap({ restore: false });
    this.hideMiniChart();
    this.closeObservatoryPanel();
    this.closeDeck();
    this.closeSurfaceTargetMenu();
    this.closeToolsMenu();

    this.setObjectsVisible(false);

    // The footprint reticle is driven by the per-frame guide pass, which
    // stops with the mode — hide it explicitly so it can't linger. Same for
    // the orbit-details focus glyphs (their pass also stops with the mode).
    this.hideFootprintReticle();
    this.hideOrbitFocusLabels();

    // Dispose planet labels — and the Sun label, whose element lives inside
    // the container this removes (re-attached on activate).
    if (this.planetLabels) {
      this.planetLabels.dispose();
      this.planetLabels = null;
    }
    this.sunLabel.dispose();

    // Dispose the moon-dot layer (geometry + material); recreated on activate.
    if (this.moonDots) {
      this.scene.remove(this.moonDots.points);
      this.moonDots.dispose();
      this.moonDots = null;
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
    if (this.moonDots) this.moonDots.setVisible(visible);
    if (this.constellations) this.constellations.setVisible(visible && this.showConstellations);
  }

  /** Called by main.ts after it reapplies the render resolution on a window
   *  resize (which may reclamp the renderer's pixel ratio). Star point sizes
   *  track the renderer's ratio, so retune them to the new value. */
  onResize(): void {
    if (this.starfield) setStarfieldPixelRatio(this.starfield, this.renderer.getPixelRatio());
    if (this.moonDots) this.moonDots.setPixelRatio(this.renderer.getPixelRatio());
    // A resize can carry the layout across the breakpoint, and the phone
    // invariant — the expanded sheet and the body card are never up together —
    // is otherwise enforced only on the edges that OPEN one of them. A window
    // dragged narrow with both standing re-applies the card-open rule here:
    // the sheet folds (non-banked, a layout reflex), the card stays.
    if (this.isMapOpen() && this.isPhoneLayout()
      && !this.mapPanelCollapsed && this.mapHud.isCardOpen()) {
      this.setMapPanelCollapsed(true, { bank: false });
    }
    // The panel is re-capped BEFORE the chart re-projects: the label pass
    // inside onResize measures the panel's rect, and a rotation changes both
    // the cap and the panel's whole shape. Measured after, the labels would
    // dodge the shape the panel had in the old viewport for a frame — and on a
    // phone that shape is a full-width band. measurePanel's own geometry door
    // drops the chrome cache and re-docks the hint.
    this.mapHud.measurePanel();
    this.mapHud.measureCard();
    this.systemMap?.onResize();
  }

  update(dt: number): void {
    if (!this.active || !this.solarSystem) return;
    this.lastFrameDtMs = dt * 1000;
    this.frameStamp++;
    if (this.shaderWarmupProgramCount !== null && ++this.framesSinceShaderWarmup >= 3) {
      const now = this.renderer.info.programs?.length ?? 0;
      if (now > this.shaderWarmupProgramCount) {
        debugWarn('Boot shader warm-up missed programs: the first live frames compiled more', {
          afterWarmup: this.shaderWarmupProgramCount,
          now,
        });
      }
      this.shaderWarmupProgramCount = null;
    }
    // One damping step runs per frame (the controls wrapper enforces it), so
    // size that step by the frame's real duration: the coast then decays at
    // e^(−t/τ) in wall time on any refresh rate, and a hitch frame advances
    // by exactly the time it took.
    this.controls.dampingFactor = cameraFollowGain(dt, ORBIT_DAMPING_TAU_S);

    // Upload one budget's worth of freshly loaded textures while nothing is
    // being asked of the frame — otherwise the whole decode+upload bill lands
    // inside whatever gesture first draws the map. Runs in every mode so
    // landed sessions warm up too.
    pumpTextureWarmQueue(PlanetariumMode.TEXTURE_WARM_BUDGET_MS);
    // Climb any committed destination's warm ladder (see
    // warmArrivalDestination) — a no-op the moment every goal has disarmed.
    this.pumpArrivalWarmGoals();

    // Runs in both branches below — a tutorial narrates landed and cruise scenes.
    this.updateTutorial();
    // Also both: the light grasp belongs to the surface view, which lives in the
    // landed pipeline, and it still has to ease back to 1 out in cruise.
    this.updateStarGain(dt);

    // Landed mode: camera orbits body, skip flight controls
    if (this.landedOn) {
      // Coverage meter reads neutral while landed (telemetry only — the
      // driving exposure keeps adapting in updateSunShader, which runs in the
      // landed pipeline too so Observatory sun views stay protected).
      this.exposureTarget = 1;
      this.updateLanded(dt);
      // End of the landed branch: positions are final, refresh the map if open.
      this.updateMapView();
      // Runs here too, so the ground is one of the states that stands the
      // corner chart down rather than a state it is simply never told about.
      this.updateMiniChart();
      return;
    }

    const isScriptedTransfer = this.updateScriptedTransfer(dt);
    // A paused clock holds the ship with the world: no steering, no
    // autopilot, no governor maturation — cruise resumes exactly as left.
    // Scripted transfers are the deliberate exception (a milestone pauses
    // the clock and THEN flies its arc). Derived every frame, never saved.
    this.player.held = !isScriptedTransfer && this.timeState.paused;
    if (!isScriptedTransfer) {
      // Process keyboard input (held: early-returns with zeroed steering)
      this.processInput();

      if (!this.player.held) {
        // Autopilot: steer toward target if no manual steering input
        if (this.autopilot && this.autopilotTarget && this.player.yawInput === 0 && this.player.pitchInput === 0) {
          this.applyAutopilot();
        }

        // Shell-contact graze: ease the nose along the armed deflection
        // (hands-off only; any steering input reclaims the stick).
        this.applyContactAim(dt);

        // Compute system speed throttle before player update
        const throttleResult = this.computeSystemSpeedFactor();
        this.systemSpeedFactor = throttleResult.factor;
        this.nearestSystemPlanet = throttleResult.planet;
        this.player.systemSpeedFactor = (this.throttleOverride || !this.systemSlowdown) ? 1.0 : this.systemSpeedFactor;
      }
    }

    // Body-proximity governor (moons + planets + the Sun): the planet
    // throttle knows nothing smaller than a system, so near a body it still
    // allows the in-system setting — several standoffs per second. Cap the
    // closing speed at K × surface distance and the receding speed at the
    // distance-tied leave law instead (same escape hatch as the throttle),
    // each measured in the body's own rest frame — its motion rides on top
    // (movingBodySpeedCap: nose credit leaving, sightline-recession credit
    // closing), so a body sweeping toward the ship can shove it but never
    // trap it, and a fleeing body can still be caught by the glide.
    // Tightening applies instantly; loosening runs through a short
    // transition ease onto the leave law, so a flyby ends with a steady
    // pull-away, never a time-exponential detonation.
    // The throttle override (and systemSlowdown off) bypasses the applied
    // cap the same frame — no lingering crawl — while the candidate keeps
    // integrating and the engaged latch keeps telling the override
    // auto-clear that a body is still being escaped (a moon can govern well
    // outside the parent's system-throttle radius). Runs during scripted
    // transfers too: the applied cap is unused there (player.update is
    // skipped) but the state stays current, so a transfer never ends on a
    // stale-tight ramp.
    // Held, the governor freezes with the ship: its release ramp and the
    // override clear-hold mature on wall dt, and a pause taken mid-flyby
    // must not hand back a fully released cap in one frame. Geometry can't
    // change while everything is frozen, so a stale state is a current one.
    if (!this.player.held) {
      this.bodyCap = advanceBodyCap(
        this.bodyCap,
        this.computeBodySpeedCap(),
        this.player.commandedSpeedAUPerS,
        this.throttleOverride || !this.systemSlowdown,
        dt,
      );
      this.player.speedCapAUPerS = this.bodyCap.applied;
    }

    // Autopilot glide: bring the cruise to rest at the arrival standoff, not
    // the collision shell, by capping closing speed at K × distance-past-the-
    // standoff. Applied AFTER the governor's own cap and OUTSIDE the override
    // latch (a plain min on the effective speed) — the pilot's contract is that
    // you leave the glide by disengaging, never by out-throttling it.
    if (!this.player.held && this.autopilot && this.autopilotTarget) {
      const inp = this.resolveAutopilotMoonInputs(this.autopilotTarget);
      if (inp) {
        const dx = inp.moonPos.x - this.player.posX;
        const dy = inp.moonPos.y - this.player.posY;
        const dz = inp.moonPos.z - this.player.posZ;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const glide = autopilotGlideCap(dist, moonArrivalStandoffAU(inp));
        if (glide < this.player.speedCapAUPerS) this.player.speedCapAUPerS = glide;
      }
    }

    if (!isScriptedTransfer) {
      this.prevPlayerPos.set(this.player.posX, this.player.posY, this.player.posZ);
      this.player.update(dt);
    }
    this.timeState = advancePlanetariumTime(this.timeState, dt);
    this.rebuildPlanetPositions(dt);

    this.updatePlanetScaling();
    this.player.group.scale.setScalar(0.5);
    // Resolve collisions BEFORE the floating origin so the frame renders the
    // RESOLVED state. Rendering first and resolving after leaves a one-frame
    // lag, and under sustained shell contact with a moving body (a parked
    // ship being overtaken by Mercury at 47 km/s, a moon sweeping past at
    // time warp) the rendered gap alternates by the per-frame pushback —
    // invisible at the old 17,000 km chase distance, a visible shimmy of the
    // near-full-screen disc at 3,000 km.
    // Scripted transfers own the ship and skip the resolvers: prevPlayerPos
    // freezes at the transfer's origin (it refreshes only on integrating
    // frames), so the sweep would re-test the whole traveled chord each
    // frame and pin the ship to any body the path grazes. The first
    // post-transfer frame re-seeds prevPlayerPos before integrating, so
    // handback resolves cleanly. Plain teleports are safe the same way —
    // their handlers run between frames, ahead of that re-seed.
    if (!this.devFreeCamera && !isScriptedTransfer) {
      this.resolvePlanetCollisions();
      this.resolveMoonCollisions();
    }

    // Apply floating origin: offset everything by player position
    this.applyFloatingOrigin();

    this.updateCruiseCamera(dt);

    const shouldRefreshUi = this.tickFrameCadence(dt);

    // Check orbit crossings and visits after scale/collision are applied so the
    // reachable interaction shell matches the visual shell.
    this.checkOrbitCrossings();
    this.checkPlanetVisits();

    // Position moon meshes first so `collectDynamicOccluders` can read their
    // scene-space positions and record discs for label culling.
    this.updateMoonPositions(dt);

    // AFTER the moon pass on purpose: proximity reads the just-refreshed
    // moonWorldPositions instead of re-propagating every in-range moon's
    // ephemeris a second time at the same instant (~18 duplicate Kepler
    // solves per frame inside Saturn's system).
    this.checkProximityLand();

    // Camera safety + dynamic near. Deliberately AFTER updateMoonPositions —
    // at the top time rates a capped 100 ms frame moves a moon 36 simulated
    // days, so "last frame's positions" can be a different sky — and BEFORE
    // the label pass, which projects through the final camera.
    this.updateCruiseCameraSafety();
    this.updateCruiseAimStage(dt);

    // Raise map resolution and sphere detail for any body that grows large on
    // screen. Sits after the floating-origin and moon passes (the footprint
    // may only measure same-frame geometry — frame-one and teleport frames
    // otherwise read stale offsets, and one mis-read fires a download) AND
    // after the aim stage: LOD projects through the camera, and during a
    // reacquire the pre-aim orientation is arbitrarily stale now that the
    // aim stage is the frame's only aim writer — one misclassified footprint
    // could fire an irreversible texture upload. Skipped while the chart
    // owns the frame: the world spheres aren't drawn there, so a
    // schematic-view zoom must not fetch anything for an unseen surface.
    // (`mapOpen` also gates the other world-presentation passes below — the
    // world composer is bypassed entirely while the chart owns the frame, so
    // per-frame work whose only output is the world render is pure waste.)
    const mapOpen = this.isMapOpen();
    if (!mapOpen) {
      this.updateBodyLOD();
      // Sector tiles are world render too: nothing to measure or fetch for a
      // chart that never draws the spheres.
      this.updateSectorStreaming();
    } else {
      // What the streamer is owed regardless: the ladder keeps applying globe
      // maps behind the chart and the tile fetches keep ageing, so the byte
      // budget and the load deadlines stay current while the measuring stops.
      this.maintainSectorStreaming();
    }

    // The HTML label/marker projections below read camera.matrixWorldInverse,
    // which the renderer refreshes only at render time — after this update().
    // Refresh it now, past this frame's final cruise camera pose (the camera
    // follow + controls.update above, and the safety escape just applied), or
    // every label trails the camera by a frame during orbit drags and fast pans.
    this.camera.updateMatrixWorld();

    // Photometric moon dots: fill the buffers now the cruise camera is settled
    // (safety escape + arrival look applied), before the label pass reads each
    // dot's screen contribution for its sub-pixel gating. Skipped with the
    // rest of the world passes while the map owns the frame — the label pass
    // that reads the contributions is gated the same way, and the fill reruns
    // before the first world render after the map closes.
    if (!mapOpen) this.updateMoonDotsForCamera();

    // Coverage meter: output-space overlap of the displayed tangent footprint,
    // not the overscan camera's rectilinear angular box. Telemetry for
    // devExposurePeek() only; updateSunShader owns the adapted render exposure.
    // The shared measurement uses sun.position, which IS the Sun's world
    // position here: a direct scene child, posed by applyFloatingOrigin
    // earlier this frame.
    const exposureWidth = this.renderer.domElement.clientWidth;
    const exposureHeight = this.renderer.domElement.clientHeight;
    const exposureFootprint = this.getSunScreenProjection();
    const overlapW = Math.max(
      0,
      Math.min(exposureFootprint.maxX, exposureWidth) - Math.max(exposureFootprint.minX, 0),
    );
    const overlapH = Math.max(
      0,
      Math.min(exposureFootprint.maxY, exposureHeight) - Math.max(exposureFootprint.minY, 0),
    );
    this.exposureCoverage = THREE.MathUtils.clamp(
      (overlapW * overlapH) / Math.max(exposureWidth * exposureHeight, 1),
      0,
      1,
    );
    this.exposureTarget = solarExposureTarget(this.exposureCoverage);

    // Occlusion + label/marker + hover-reveal pipeline: planet discs → Sun +
    // moon + ship discs → pick list → reveal → labels + markers.
    // Main (flight) path: landedOn is null here — narrowed by early return above.
    // The hull test rides along only here: the ship is drawn in flight, so its
    // beacon occlusion needs the precise raycast.
    if (!mapOpen) {
      this.runBodyLabelPipeline(undefined, this.isMarkerBehindShip);
    }

    // Update constellation labels
    if (this.constellations && this.showConstellations && !mapOpen) {
      this.constellations.updateLabels(
        this.camera,
        this.renderer.domElement.clientWidth,
        this.renderer.domElement.clientHeight,
      );
    }

    // Held, arrival stays undetected too: the check can disengage the
    // autopilot and park the ship, and a frozen frame must decide nothing.
    if (this.autopilotTarget && !this.player.held) {
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

    if (import.meta.env.DEV && this.devTraceMesh) this.devTraceRecord();

    // End of the cruise branch: ship position finalized after collisions,
    // refresh the map if open.
    this.updateMapView();
    this.updateMiniChart();
  }

  private applyFloatingOrigin() {
    if (!this.solarSystem) return;

    const px = this.player.posX;
    const py = this.player.posY;
    const pz = this.player.posZ;

    // The origin this frame RENDERS at. Collision pushback mutates
    // player.pos* after this pass, so anything measuring against rendered
    // geometry later in the frame (the camera-safety pass) must subtract
    // THIS offset, not the live player position — after a fast override
    // impact the two differ by the whole pushback distance.
    this.renderOriginAU.x = px;
    this.renderOriginAU.y = py;
    this.renderOriginAU.z = pz;

    this.solarSystem.sun.position.set(-px, -py, -pz);

    // Offset planets (and their moon-system groups, which track the planet)
    for (const planet of this.solarSystem.planets) {
      const wp = planet.worldPosAU!;
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

  private readonly bodyLODTmp = new THREE.Vector3();
  /**
   * Raise a body's detail as it grows large on screen: higher-resolution
   * colour maps, and a finer sphere once its polygon chords would show. Both
   * read the one screen footprint measured here per body — apparent size, not
   * raw distance, so a body magnified by the Observatory's narrow-FOV
   * telescope upgrades exactly as a close fly-by would.
   *
   * Cheap to call each frame: a body with nothing left to gain is skipped
   * before its projection, a colour handle that has reached its goal answers
   * canAttempt in a couple of comparisons, and no body is ever projected twice
   * however many handles it carries.
   */
  private updateBodyLOD(): void {
    if (!this.solarSystem) return;
    const canvasW = this.renderer.domElement.clientWidth;
    const canvasH = this.renderer.domElement.clientHeight;
    const nowMs = performance.now();
    this.camera.updateMatrixWorld();
    for (const planet of this.solarSystem.planets) {
      const ups = planet.textureUpgrades;
      const geo = planet.geometryUpgrade;
      // Nothing left to measure: every ladder has reached its goal and the
      // silhouette is already fine. (every() is true for a ladder-less body.)
      if (geo.applied && ups.every(upgradeComplete)) continue;
      planet.group.getWorldPosition(this.bodyLODTmp);
      // A body with work left still skips the full 32-ray measurement while a
      // conservative overestimate of its diameter stays under every trigger
      // it could pull — the overestimate crossing first is what makes the
      // skip unable to miss a real trigger.
      const estPx = estimateSphereScreenDiameterPx(
        this.bodyLODTmp, planet.data.radiusAU, this.camera, canvasW, canvasH,
      );
      if (!lodMeasurementRelevant(geo, ups, estPx, canvasH, null)) continue;
      const footprint = projectSphereToScreen(
        this.bodyLODTmp,
        planet.data.radiusAU,
        this.camera,
        canvasW,
        canvasH,
        this.sphereScreenProjection,
      );
      upgradeGeometryOnApproach(geo, footprint.diameterPx);
      this.triggerTextureUpgrades(ups, footprint.diameterPx / Math.max(canvasH, 1), nowMs);
    }
    // Cruise re-renders a procedural moon's texture sharper on close approach;
    // the landed/Observatory path already does this on observe, so gate it to
    // cruise. Throttled to one successful upgrade per frame — GPU paint is
    // sub-ms, but don't burst a whole system's worth in one frame.
    const allowMoonTexUpgrade = !this.landedOn;
    let moonTexUpgraded = false;
    for (const moons of this.planetMoons.values()) {
      for (const m of moons) {
        // Hidden moons sit at their parent's center (updateMoonPositions skips
        // them) — a fake position the triggers must never measure. An invisible
        // moon can't legitimately span the viewport anyway.
        if (!m.mesh.visible) continue;
        const ups = m.textureUpgrades;
        const geo = m.geometryUpgrade;
        // A pending relief tier keeps the moon measurable the same way an
        // unfinished colour ladder does (it shares the colour ladder's first
        // trigger fraction below).
        const normalPending = normalUpgradePending(m.normalUpgrade);
        // Nothing to measure: silhouette already fine, no colour ladder, and
        // the procedural re-render is off, ineligible for this moon (photo /
        // CPU-painted / already sharp — the texturer's own screen, so a moon
        // upgrade() would refuse never buys a measurement), or this frame's
        // single slot is already spent.
        const tryProcedural = allowMoonTexUpgrade && !moonTexUpgraded
          && this.moonTexturer.canUpgrade(m, PlanetariumMode.OBSERVE_MOON_TEXTURE_WIDTH);
        if (!tryProcedural && !normalPending && geo.applied && ups.every(upgradeComplete)) continue;
        m.mesh.getWorldPosition(this.bodyLODTmp);
        // Rendered size (mesh scale carries the render-curve inflation): the
        // triggers must measure the disc actually on screen.
        const renderedR = m.data.radiusAU * m.mesh.scale.x;
        // Same skip as the planet loop: a conservative overestimate under
        // every pullable trigger proves the full measurement moot this frame.
        const estPx = estimateSphereScreenDiameterPx(
          this.bodyLODTmp, renderedR, this.camera, canvasW, canvasH,
        );
        if (!lodMeasurementRelevant(
          geo, ups, estPx, canvasH,
          tryProcedural ? this.moonDotParams.texUpgradeDiscPx : null,
        ) && !(normalPending
          && estPx / Math.max(canvasH, 1) > (UPGRADE_TRIGGER_FRACTION['4k'] ?? Infinity))) continue;
        const footprint = projectSphereToScreen(
          this.bodyLODTmp,
          renderedR,
          this.camera,
          canvasW,
          canvasH,
          this.sphereScreenProjection,
        );

        // Most procedural moons carry no colour ladder, so the disc threshold
        // sits above the photo-upgrade guard. `upgrade` returns false for a
        // photo / already-sharp / CPU-painted moon, leaving the frame's slot
        // for a real one (no starvation).
        if (tryProcedural && footprint.diameterPx > this.moonDotParams.texUpgradeDiscPx) {
          if (this.moonTexturer.upgrade(m, PlanetariumMode.OBSERVE_MOON_TEXTURE_WIDTH)) {
            moonTexUpgraded = true;
          }
        }

        upgradeGeometryOnApproach(geo, footprint.diameterPx);
        const fraction = footprint.diameterPx / Math.max(canvasH, 1);
        if (ups.length > 0) {
          this.triggerTextureUpgrades(ups, fraction, nowMs);
        }
        upgradeNormalOnApproach(m.normalUpgrade, fraction, nowMs);
      }
    }
  }

  /** Fetch whatever step each of a body's handles has earned at this screen
   *  fraction. */
  private triggerTextureUpgrades(ups: readonly TextureUpgrade[], fraction: number, nowMs: number): void {
    for (const up of ups) {
      if (!canAttempt(up, nowMs)) continue;
      const earned = earnedUpgradeTier(up, fraction);
      if (earned) upgradeTextureOnApproach(up, earned, nowMs);
    }
  }

  /** The one per-frame cruise-camera writer, dispatched on ownership. Target
   *  is pinned to origin in every branch (the ship is scene origin), and
   *  exactly one writer runs: 'orbit' → OrbitControls; 'reacquiring' → the
   *  spherical step; 'chase' → the follow + OrbitControls, byte-for-byte as
   *  before. Skipped entirely under devFreeCamera (headless framing). */
  private updateCruiseCamera(dt: number) {
    if (this.devFreeCamera) return; // headless framing drives the camera directly
    // Player is always at scene origin due to floating origin.
    this.controls.target.set(0, 0, 0);

    // The polar keep-out exists only under user ownership: OrbitControls
    // re-clamps from the live camera on every update() call, and the chase
    // pose crosses the margin legitimately during steep flight.
    if (this.camOwner !== 'orbit') this.clearOrbitPolarClamps();

    if (this.camOwner === 'orbit') {
      // The user owns the camera: OrbitControls is the sole writer and its
      // damping coast finishes the gesture. Nothing follows or reverses it.
      this.controls.update();
      return;
    }

    if (this.camOwner === 'reacquiring') {
      // Walk the outside of the camera sphere back to the chase pose: slerp the
      // offset direction and spring the radius separately, so a rotation-only
      // return never dollies inward. Derive the live offset from the camera
      // every frame — the downstream safety pass may have moved it, so feeding
      // that back keeps the step and the escape from fighting, and lets a
      // re-grab promote straight to 'orbit'. OrbitControls stays idle here.
      const tau = this.advanceChaseFollowTau(dt);
      const ideal = this.clampChaseIdealToShells(chaseIdealOffset(
        this.player.writeForwardDirection(this.tmpForwardDir),
        FLIGHT_UP_SCENE,
        this.tmpChaseIdeal,
      ));
      // No lookAt here: the aim stage is the frame's last aim writer and
      // aims at origin (plus any fading deflection) from the final position.
      const settled = reacquireCameraStep(this.camera.position, this.camera.position, ideal, dt, tau);
      if (settled) this.camOwner = 'chase'; // state switch only — the step already posed the camera
      return;
    }

    this.updateCameraFollow(dt);
    this.controls.update();
  }

  private clearOrbitPolarClamps() {
    this.controls.minPolarAngle = 0;
    this.controls.maxPolarAngle = Math.PI;
  }

  /** Advance the idle↔turning blend and return the eased follow τ. Shared by
   *  the steady chase and the reacquire step so the return hands off at the
   *  same pursuit rate the chase runs, instead of the slower idle τ. */
  private advanceChaseFollowTau(dt: number): number {
    const turning = Math.abs(this.player.yawInput) + Math.abs(this.player.pitchInput) > 0 ? 1 : 0;
    this.camFollowTurnBlend +=
      (turning - this.camFollowTurnBlend) * cameraFollowGain(dt, CAM_FOLLOW_TURN_BLEND_S);
    return THREE.MathUtils.lerp(CAM_FOLLOW_TAU_IDLE_S, CAM_FOLLOW_TAU_TURN_S, this.camFollowTurnBlend);
  }

  private updateCameraFollow(dt: number) {
    // Chase camera: smoothly lerp behind the ship. The τ eases between idle and
    // steering so a tap bends the pursuit curve instead of stepping it, and the
    // gain derives from dt so 60 Hz and 120 Hz converge alike.
    const forward = this.player.writeForwardDirection(this.tmpForwardDir);
    const idealPos = this.clampChaseIdealToShells(
      chaseIdealOffset(forward, FLIGHT_UP_SCENE, this.tmpChaseIdeal),
    );
    const tau = this.advanceChaseFollowTau(dt);
    this.camera.position.lerp(idealPos, cameraFollowGain(dt, tau));
  }

  /** Keep the chase/reacquire target itself out of every padded body shell.
   *  Parked at a moon's standoff, the swinging chase offset dips inside the
   *  camera's exclusion shell across a whole arc of headings; chasing an
   *  illegal target left the downstream safety escape re-projecting the
   *  camera undamped every frame of a turn — error accumulating against the
   *  clamp, then releasing in a rush — which a near-full-screen disc reads
   *  as stutter. Clamping the TARGET keeps the follow lerp continuous; the
   *  safety escape stays as the backstop for fast geometry. Shells are last
   *  frame's pool (built by updateCruiseCameraSafety after the camera step);
   *  one frame of body motion is well inside the escape's own margin, and
   *  resetCruiseCamera empties the pool so the frame after a jump or takeoff
   *  clamps against nothing rather than shells from the old origin. */
  private clampChaseIdealToShells(ideal: THREE.Vector3): THREE.Vector3 {
    const escaped = escapeCameraPenetrations(
      ideal, this.cameraShellPool, this.cameraShellCount, CAMERA_BODY_MARGIN_AU,
    );
    if (escaped) ideal.set(escaped.x, escaped.y, escaped.z);
    return ideal;
  }

  /** The single LAST aim writer of the cruise frame (see cruiseAim.ts):
   *  composes the engage-gated flythrough look over the origin aim and
   *  rate-limits the deflection so no upstream seam can emit a one-frame
   *  aim snap. Runs after OrbitControls + camera safety — aim derives from
   *  the FINAL camera position, which is what lets the safety escape skip
   *  its old stale-quaternion re-aim. The look's moon position is ANALYTIC
   *  (parent world + ephemeris offset): a cold jump's mesh is invisible
   *  while it paints, and the look must resolve through that veil window. */
  private updateCruiseAimStage(dt: number): void {
    if (this.landedOn || this.devFreeCamera) return;

    let moonWorld: THREE.Vector3 | null = null;
    const moon = this.arrivalLookMoon;
    const parentBody = this.arrivalLookParentBody;
    if (this.cruiseAim.look && moon && parentBody) {
      const parentPos = this.planetWorldPositions.get(moon.parentPlanet);
      if (parentPos) {
        this.getMoonWorldOffsetAU(moon, parentBody, this.tmpAimMoonWorld);
        this.tmpAimMoonWorld.x += parentPos.x;
        this.tmpAimMoonWorld.y += parentPos.y;
        this.tmpAimMoonWorld.z += parentPos.z;
        moonWorld = this.tmpAimMoonWorld;
      }
    }

    stepCruiseAim(
      this.cruiseAim,
      this.camera.position,
      moonWorld,
      this.renderOriginAU,
      dt,
      this.tmpAimDir,
    );
    this.camera.lookAt(
      this.tmpAimTarget.copy(this.camera.position).add(this.tmpAimDir),
    );
    if (!this.cruiseAim.look) {
      this.arrivalLookMoon = null;
      this.arrivalLookParentBody = null;
    }
  }

  /** The moon whose dot never fully fades and whose label wins de-overlap: the
   *  just-jumped moon the camera is tracking, an actively engaged moon
   *  autopilot, or — once those drop (manual steering disengages the autopilot;
   *  any manual input nulls the arrival look) — the retained nav moon, so the
   *  floor and label
   *  survive a hand-flown final approach. `dotNavMoon` is cleared when you jump/
   *  engage elsewhere, land, deactivate, or leave the parent's system. */
  private currentDotTargetMoon(): string | null {
    if (this.cruiseAim.look) return this.cruiseAim.look.name;
    if (
      this.autopilot &&
      this.autopilotUserEngaged &&
      this.autopilotTarget?.type === 'moon'
    ) {
      return this.autopilotTarget.name;
    }
    return this.dotNavMoon?.name ?? null;
  }

  /**
   * Fill the moon-dot buffers for this frame's FINAL camera pose. Runs after the
   * camera is settled (cruise safety + arrival look; the landed/surface re-pin),
   * reading the scene positions, rendered sizes, and eclipse shading cached in
   * updateMoonPositions. A sub-pixel lit moon becomes a star-scale point at its
   * apparent magnitude; the point crossfades out as the real disc resolves.
   * Hidden or landed-on moons write alpha 0. Zero steady-state allocation.
   */
  private updateMoonDotsForCamera(): void {
    if (!this.moonDots || !this.solarSystem) return;
    const canvasW = this.renderer.domElement.clientWidth;
    const canvasH = this.renderer.domElement.clientHeight;
    this.moonDots.setLens(
      this.camera,
      canvasW,
      canvasH,
      this.renderer.getPixelRatio(),
    );
    const params = this.moonDotParams;
    const sun = this.solarSystem.sun.position;
    const cam = this.camera.position;
    const targetMoon = this.currentDotTargetMoon();
    const landedMoonName = this.landedOn?.type === 'moon' ? this.landedOn.name : null;
    const kneeActive = this.starGain > 1.001;

    let idx = 0;
    for (const planet of this.solarSystem.planets) {
      const moons = this.planetMoons.get(planet.data.name);
      if (!moons) continue;
      // Two independent fade slots now (they can't be pre-multiplied per system,
      // because the parent gate carries a per-moon proximity release):
      //  · systemFade — no one-frame constellations at the visibility threshold.
      //  · parentFade — no bright-star points beside a planet that is itself
      //    only a few pixels, UNLESS you are inside a given moon's own orbit
      //    neighborhood (then it shows on its photometric merits).
      // Seed the parent's world position unconditionally (even at systemFade 0)
      // so the per-moon proximity ratio never reads a stale parent.
      const systemFade = this.moonSystemEdgeFade.get(planet.data.name) ?? 0;
      planet.group.getWorldPosition(this.tmpDotParentPos);
      // The gate asks whether the parent anchors the SCENE, so its input is the
      // analytic tangent size from camera distance alone — never the rendered
      // footprint, which measures 0 px once the parent leaves the frustum and
      // would blank every moon dot in the system the moment the parent is
      // steered past the camera plane, with its moons still mid-viewport.
      const parentDiscPx = discDiameterPx(
        planet.data.radiusAU,
        this.tmpDotParentPos.distanceTo(cam),
        displayFovDeg(this.camera),
        canvasH,
      );
      for (const m of moons) {
        const i = idx++;
        // Same gate as the mesh: only a shown (visible & painted) moon dots, and
        // never the body you're standing on — its disc fills the sky, so the
        // crossfade would kill the dot anyway; skip the math.
        if (!m.mesh.visible || m.data.name === landedMoonName) {
          this.moonDots.hide(i);
          m.dotScreenAlpha = 0;
          m.dotLitScreenAlpha = 0;
          m.dotLitScreenSizePx = 0;
          continue;
        }

        m.mesh.getWorldPosition(this.tmpDotMoonPos);
        const dx = this.tmpDotMoonPos.x - cam.x;
        const dy = this.tmpDotMoonPos.y - cam.y;
        const dz = this.tmpDotMoonPos.z - cam.z;
        const distAU = Math.sqrt(dx * dx + dy * dy + dz * dz);
        // moon→sun (scene) = sun − moon; its length is the moon's heliocentric
        // distance (the Sun sits at the world origin).
        const sdx = sun.x - this.tmpDotMoonPos.x;
        const sdy = sun.y - this.tmpDotMoonPos.y;
        const sdz = sun.z - this.tmpDotMoonPos.z;
        const sunDistAU = Math.sqrt(sdx * sdx + sdy * sdy + sdz * sdz) || 1e-9;
        // phaseCos = cos(sun–moon–observer): moon→cam = −(dx,dy,dz).
        const phaseCos =
          distAU > 0 ? -(sdx * dx + sdy * dy + sdz * dz) / (sunDistAU * distAU) : 1;

        const renderedR = m.data.radiusAU * m.mesh.scale.x;
        const discPx = projectSphereToScreen(
          this.tmpDotMoonPos,
          renderedR,
          this.camera,
          canvasW,
          canvasH,
          this.sphereScreenProjection,
        ).diameterPx;
        const albedo = albedoProxyFromColor(m.data.color, params);
        const shade = m.dotSunVisibleFraction ?? 1;

        // Proximity release: camera→moon distance over the moon's own orbital
        // radius (|moon − parent|). Inside its neighborhood the parent gate
        // opens for this moon however small the parent's disc; outside its orbit
        // shell the gate holds.
        const moonOrbitR = this.tmpDotMoonPos.distanceTo(this.tmpDotParentPos);
        const proximityRatio = moonOrbitR > 0 ? distAU / moonOrbitR : Infinity;
        const parentFade = parentDominanceFade(parentDiscPx, proximityRatio, params);

        const v = moonDotVisual(
          renderedR,
          distAU,
          sunDistAU,
          phaseCos,
          albedo,
          shade,
          discPx,
          targetMoon === m.data.name,
          systemFade,
          parentFade,
          this.starFaintLimitMag,
          params,
          undefined,
          this.tmpDotVisual,
        );
        // The same dot with illumination forced full — phase and eclipse shading
        // both 1, every other argument identical. The label pass names a moon by
        // this alpha, so a terminator or an eclipse cannot strobe a name off,
        // while the parent gate, the system edge and the disc handoff still
        // reach it and retire the name honestly. Its own scratch object: `v`
        // still has to feed the GPU write below.
        const lit = moonDotVisual(
          renderedR,
          distAU,
          sunDistAU,
          1,
          albedo,
          1,
          discPx,
          targetMoon === m.data.name,
          systemFade,
          parentFade,
          this.starFaintLimitMag,
          params,
          undefined,
          this.tmpDotLitVisual,
        );
        // The dots share the starfield's telescope light grasp, same soft knee:
        // the mapping contract says a moon dot is as visible as an equally
        // bright star, and the surface view is exactly where both are honest
        // photometry — a gained sky over ungained dots would sink every dot
        // below its star twin. Inactive (gain 1) everywhere else. Both alphas
        // take it, or they would differ by more than illumination.
        const dotAlpha = kneeActive
          ? 1 - Math.pow(1 - v.alpha, this.starGain)
          : v.alpha;
        m.dotScreenAlpha = dotAlpha;
        m.dotLitScreenAlpha = kneeActive
          ? 1 - Math.pow(1 - lit.alpha, this.starGain)
          : lit.alpha;
        m.dotScreenSizePx = v.sizePx;
        // The lit twin's SIZE travels with its alpha: the label contest bids the
        // product, and the star mapping shrinks an unlit dot as well as dimming
        // it, so a bid built from the real size would still move with the
        // terminator.
        m.dotLitScreenSizePx = lit.sizePx;

        if (dotAlpha <= 0) {
          this.moonDots.hide(i);
          continue;
        }

        // Place the point at the moon's camera-facing surface + a small epsilon,
        // so the opaque mesh's front fragments can't depth-kill the dot mid
        // crossfade; depthTest stays on, so planets and nearer moons still
        // occlude it. toCam = −(dx,dy,dz)/dist.
        const surf = (renderedR * 1.05) / Math.max(distAU, 1e-12);
        const px = this.tmpDotMoonPos.x - dx * surf;
        const py = this.tmpDotMoonPos.y - dy * surf;
        const pz = this.tmpDotMoonPos.z - dz * surf;
        const chroma = chromaticityRGB(m.data.color, this.tmpDotChroma);
        this.moonDots.setDot(
          i,
          px,
          py,
          pz,
          chroma.r * v.brightness,
          chroma.g * v.brightness,
          chroma.b * v.brightness,
          v.sizePx,
          dotAlpha,
        );
      }
    }
    this.moonDots.flush();
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
    // Through the shared seam, so the same moon at the same instant faces the
    // same way here and on the system map.
    tidalLockQuaternion(offsetFromParent, rollNorth, mesh.quaternion);
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
      // tidal-lock roll stays on ecliptic north. The choice lives in one place
      // so the world and the map roll the same moon the same way; the shadow
      // engine and the guide slots read the true normal straight from the seam.
      tidalRollNorth(moon.name, parentPlanet.name, outOrbitNormal, outOrbitNormal);
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

  /** Margin past the farthest moon's reach that still counts as "inside the
   *  system" — shared by the live moon-system threshold and the teleport
   *  warm-up reach, which must draw the same line. */
  private static readonly MOON_SYSTEM_REACH_MARGIN = 1.15;

  private getMoonSystemThresholdAU(planetRadiusAU: number, moons: MoonMesh[]): number {
    return Math.max(
      planetRadiusAU * 120,
      this.getFarthestMoonReachAU(moons) * PlanetariumMode.MOON_SYSTEM_REACH_MARGIN,
      0.3,
    );
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
   * true size, small moons inflated through the render curve (the same sizing
   * updateMoonPositions applies, so they stay visible). The landed camera
   * frames off this, so a small moon's inflated mesh fills the view like any
   * other body and the camera never seats itself inside the mesh. Uses the
   * flythrough anchor deliberately, not the state selector: the framing target
   * must stay stable while surface view (anchor 0) is active.
   */
  private getLandedBodyRenderedRadiusAU(): number {
    const trueRadiusAU = this.getLandedBodyRadiusAU();
    if (!this.landedOn || this.landedOn.type === 'planet') return trueRadiusAU;
    const parentName = this.landedOn.parentPlanet;
    const parent = PLANETARIUM_BODIES.find(b => b.name === parentName);
    if (!parent) return trueRadiusAU;
    return this.renderedMoonSizeAU(trueRadiusAU, parent.radiusAU, MOON_RENDER_ANCHOR_RATIO);
  }

  /**
   * Anchor ratio (fraction of the parent's radius) for rendered moon sizes in
   * `parentName`'s system, given the current landed/view state. Moons below
   * the anchor inflate toward it on the moonRenderSize curve — most are a
   * sliver of their giant parent and would be sub-pixel at true scale — and
   * the anchor depends on what you're looking at:
   *  - Flying, or any system you're not landed in: the full flythrough anchor,
   *    so every moon stays a findable speck as you pass.
   *  - Observing the parent PLANET: a smaller anchor — you're focused on the
   *    system, and it should read closer to honest relative sizes.
   *  - Observing a MOON: the flythrough anchor (unchanged), so the siblings
   *    stay findable around the one being inspected.
   *  - Surface view: no inflation — true angular sizes, a moon crossing the
   *    Sun must be its real size.
   * The anchor only ever changes across a landing/leave/swap/surface
   * transition, each of which reframes the camera in the same frame, so the
   * resize always lands inside a hard cut.
   * Centralised so the drawn mesh and the label-occlusion discs stay in sync.
   */
  private moonRenderAnchorRatio(parentName: string): number {
    if (parentName !== this.observatoryParentPlanetName()) {
      return MOON_RENDER_ANCHOR_RATIO; // flythrough / other systems
    }
    if (this.landedView === 'surface') return 0; // true angular sizes
    if (this.landedOn?.type === 'planet') return MOON_RENDER_ANCHOR_RATIO_OBSERVING;
    return MOON_RENDER_ANCHOR_RATIO; // observing a moon: unchanged
  }

  /** Dev-bridge γ override for live curve tuning; null = the shipped constant. */
  private devMoonGamma: number | null = null;

  /** Every controller consumer of a rendered moon size resolves through here,
   *  so the dev γ override reaches the mesh, labels, framing, and arrivals
   *  alike (meshes re-scale on the next updateMoonPositions pass). */
  private renderedMoonSizeAU(trueRadiusAU: number, parentRadiusAU: number, anchorRatio: number): number {
    return renderedMoonRadiusAU(trueRadiusAU, parentRadiusAU, anchorRatio, this.devMoonGamma ?? MOON_RENDER_GAMMA);
  }

  devSetMoonSizeGamma(gamma: number | null): void {
    this.devMoonGamma = gamma;
  }

  /** Dev-bridge live tuning of the moon-dot knobs (photometry, crossfade window,
   *  target floor, edge fade, and the texture-upgrade disc threshold). A partial
   *  merges into the running copy; null resets to the shipped defaults. */
  devSetMoonDotParams(partial: Partial<MoonDotParams> | null): void {
    this.moonDotParams = partial === null
      ? { ...MOON_DOT_PARAMS }
      : { ...this.moonDotParams, ...partial };
  }

  /** Dev-bridge live tuning of the moon-label placement knobs (the dark-label
   *  band). A partial merges into the running copy; null resets to the shipped
   *  defaults. */
  devSetMoonLabelPlacementParams(partial: Partial<MoonLabelPlacementParams> | null): void {
    this.moonLabelPlacementParams = partial === null
      ? { ...MOON_LABEL_PLACEMENT_PARAMS }
      : { ...this.moonLabelPlacementParams, ...partial };
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

  /** The per-frame system throttle — the law lives in throttlePolicy.ts with
   *  its tests; this binds it to the live player pose and world positions. */
  private computeSystemSpeedFactor(): SystemSpeedResult {
    return systemSpeedFactor(
      this.player.posX,
      this.player.posY,
      this.player.posZ,
      PLANETARIUM_BODIES,
      this.planetWorldPositions,
      this.systemSpeedScratch,
    );
  }

  private updatePlanetScaling() {
    if (!this.solarSystem) return;
    for (const planet of this.solarSystem.planets) {
      planet.group.scale.setScalar(1);

      // Atmosphere alpha: fade in as player approaches the planet's system radius
      if (planet.atmosphere) {
        const wp = planet.worldPosAU!;
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
        const wp = planet.worldPosAU!;
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
    this.player.setProfile(
      this.devShipProfileOverride
        ?? this.activeHistoricJourney?.shipProfile
        ?? 'default',
    );
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
   * positions and per-moon frame velocities. Label placement is split into
   * `renderMoonLabels()` so that moon labels can consult the full set of
   * foreground occluders (planets, other moons, ship) gathered mid-frame.
   *
   * `dtS` is the frame's capped dt — the same step the sim clock and the
   * ship integrate on — and the denominator of the per-moon velocities.
   * Pass 0 from any out-of-frame refresh (a vantage swap): that pass stamps
   * positions and zeroes velocities, like any discontinuity.
   */
  private updateMoonPositions(dtS = 0) {
    if (!this.solarSystem) return;
    const PLANETSHINE_GAIN = 500; // lift faint physical planetshine to a visible night-side glow
    const PLANETSHINE_MAX = 0.12; // cap well below daylight; large/near parents (Jupiter) sit at the cap
    const shadeNowMs = performance.now(); // wall clock for the applied-shading limiter

    // Moon-velocity pass bookkeeping. Velocities may only be differenced
    // across two consecutive passes whose clock advanced by exactly this
    // frame's dt × rate — any other step (an event jump, Now, a typed date,
    // a milestone staging: seams that write the clock directly) is a
    // teleport, and differencing across it would hand the governor an
    // astronomical bogus velocity, whose credit would unbind the cap for a
    // frame. Detected here, at the one consumer, instead of trusting every
    // jump seam to raise a flag.
    this.moonVelPassIndex++;
    const simNowMs = this.timeState.currentUtcMs;
    const expectedSimStepS = this.timeState.paused ? 0 : dtS * this.timeState.rate;
    const simStepS = (simNowMs - this.moonVelPrevSimMs) / 1000;
    const simStepContinuous =
      Number.isFinite(simStepS) &&
      Math.abs(simStepS - expectedSimStepS) <= Math.max(Math.abs(expectedSimStepS) * 0.25, 0.05);
    this.moonVelPrevSimMs = simNowMs;
    const velDenomS = dtS > 0 && simStepContinuous ? dtS : 0;
    // Nearest system with textures still queued — the background drain paints it
    // first (you're likeliest to reach it next). Tracked across the planet loop.
    let nearestPending: string | null = null;
    let nearestPendingDist = Infinity;
    for (const planet of this.solarSystem.planets) {
      const moons = this.planetMoons.get(planet.data.name);
      if (!moons || moons.length === 0) continue;

      const wp = planet.worldPosAU!;
      const dx = this.player.posX - wp.x;
      const dy = this.player.posY - wp.y;
      const dz = this.player.posZ - wp.z;
      const distToPlayer = Math.sqrt(dx * dx + dy * dy + dz * dz);

      const threshold = this.getMoonSystemThresholdAU(planet.data.radiusAU, moons);
      const visible = distToPlayer < threshold;
      const parentR = planet.data.radiusAU;

      // Leaving the retained nav moon's parent system drops the retention: the
      // dot floor / label exemption shouldn't outlive the system going out of
      // range. Checked here where the threshold is already computed (no cost).
      if (this.dotNavMoon?.parentPlanet === planet.data.name && !visible) {
        this.dotNavMoon = null;
      }

      // Cache the system-edge fade for the dot pass: dots ramp in over the last
      // slice of the visibility threshold so a system never appears as a
      // one-frame constellation. Zeroed when the system is out of range.
      this.moonSystemEdgeFade.set(
        planet.data.name,
        visible ? systemEdgeFade(distToPlayer, threshold, this.moonDotParams) : 0,
      );

      // Moon-shadow casters fed to the parent surface shader (Io on Jupiter,
      // etc.): reset per frame, accumulate in the loop below. Pick the largest
      // moons by radius (catalog order isn't size order — Titan must outrank
      // Mimas) and skip any whose umbra never reaches the surface (annular, e.g.
      // Phobos), so a tiny moon can't paint a full black spot.
      const surfFx = planet.fx;
      let moonShadowCount = 0;
      let casterNames: Set<string> | null = null;
      let sunTanAtParent = 0;
      // Only for a shown system: hidden systems' moons all early-out below,
      // so their caster set is never consulted (the count still zeroes after
      // the loop), and the selection sort/Set need not be built for them.
      if (surfFx && visible) {
        this.tmpMoonShadowQuat.copy(planet.group.quaternion).invert();
        const SUN_RADIUS_AU = 695_700 / 149_597_870.7;
        sunTanAtParent = SUN_RADIUS_AU / Math.max(Math.hypot(wp.x, wp.y, wp.z), 1e-9);
        // The candidate set depends only on catalog constants and the sun's
        // angular size at the parent, which drifts on the parent's orbital
        // timescale — cache it and rebuild on a >0.5% sun-size change instead
        // of re-filtering/sorting/allocating per frame. Selection is a coarse
        // mean-distance prefilter; the live per-frame umbra check below stays.
        let casterCache = this.moonShadowCasterCache.get(planet.data.name);
        if (!casterCache || Math.abs(casterCache.sunTan - sunTanAtParent) > casterCache.sunTan * 0.005) {
          casterCache = {
            sunTan: sunTanAtParent,
            names: new Set(
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
            ),
          };
          this.moonShadowCasterCache.set(planet.data.name, casterCache);
        }
        casterNames = casterCache.names;
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
        // Wall-clock limiter on the APPLIED fraction: at warp an immersion
        // compresses below one frame and the raw value strobes bright↔black;
        // the shown tint ramps instead. The blood-moon branch stays held while
        // the smoothed value is under its red floor — the branches only meet
        // continuously above it.
        const smoothedShade = smoothShadeFraction(
          this.moonShading.sunVisibleFraction,
          m.shadeSmoothed,
          shadeNowMs - (m.shadeStampMs ?? 0),
        );
        m.shadeSmoothed = smoothedShade;
        m.shadeStampMs = shadeNowMs;
        m.shadeUmbraSticky =
          this.moonShading.inUmbra ||
          (m.shadeUmbraSticky === true && smoothedShade < PlanetariumMode.BLOOD_MOON_FLOOR_R);
        this.moonShading.sunVisibleFraction = smoothedShade;
        this.moonShading.inUmbra = m.shadeUmbraSticky;
        this.applyMoonShading(m, this.moonShading);
        // Cache this frame's sun-visible fraction so the dot pass reuses it for
        // eclipse dimming instead of recomputing the shading geometry.
        m.dotSunVisibleFraction = smoothedShade;

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

        // World velocity (AU per frame-second) for the governor's moving-body
        // credit, differenced against the entry values this pass overwrites —
        // valid only when that entry was written on the immediately previous
        // pass and this pass's clock step was continuous (velDenomS above).
        // The position entry is mutated in place (difference first, then
        // overwrite), so steady-state frames allocate nothing.
        let moonPos = this.moonWorldPositions.get(m.data.name);
        // A just-created entry holds zeros, not a previous position — it must
        // never feed the difference (the same first-write hole the old
        // fresh-object write dodged by checking existence).
        const hadPrevPos = moonPos !== undefined;
        if (!moonPos) {
          moonPos = { x: 0, y: 0, z: 0, pass: 0 };
          this.moonWorldPositions.set(m.data.name, moonPos);
        }
        let moonVel = this.moonWorldVels.get(m.data.name);
        if (!moonVel) {
          moonVel = { x: 0, y: 0, z: 0, pass: 0 };
          this.moonWorldVels.set(m.data.name, moonVel);
        }
        if (hadPrevPos && velDenomS > 0 && moonVel.pass === this.moonVelPassIndex - 1) {
          moonVel.x = (wp.x + offset.x - moonPos.x) / velDenomS;
          moonVel.y = (wp.y + offset.y - moonPos.y) / velDenomS;
          moonVel.z = (wp.z + offset.z - moonPos.z) / velDenomS;
        } else {
          moonVel.x = 0;
          moonVel.y = 0;
          moonVel.z = 0;
        }
        moonVel.pass = this.moonVelPassIndex;

        moonPos.x = wp.x + offset.x;
        moonPos.y = wp.y + offset.y;
        moonPos.z = wp.z + offset.z;
        moonPos.pass = this.moonVelPassIndex;

        // Rendered size: moons below the anchor inflate toward it on the
        // compressive curve (size ordering survives — small moons no longer
        // pin to one identical marble); the rest draw true-size. The anchor
        // varies with what you're observing (see moonRenderAnchorRatio):
        // smaller when focused on the parent planet, none in surface view
        // where angular sizes must be real (an Io silhouette on the Sun must
        // be Io-sized).
        const anchor = this.moonRenderAnchorRatio(planet.data.name);
        m.mesh.scale.setScalar(this.renderedMoonSizeAU(m.data.radiusAU, parentR, anchor) / m.data.radiusAU);

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
      // Precedence: where the player is going, then the system the open map is
      // showing, then whatever is nearest. An open map is a system somebody is
      // looking at right now, and its moons ride tinted dots until paint lands.
      const mapSystem = this.systemMap?.isOpen()
        ? this.systemMap.preferredPaintSystem()
        : null;
      const preferred =
        targetSystem && this.moonPainter.hasPending(targetSystem) ? targetSystem
          : mapSystem && this.moonPainter.hasPending(mapSystem) ? mapSystem
            : nearestPending;
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
  /** Red channel of the blood-moon floor: above this the red and gray branches
   *  agree, so it is also the release level for the smoothed-shading umbra
   *  hold. */
  private static readonly BLOOD_MOON_FLOOR_R = 0.3;

  private applyMoonShading(m: MoonMesh, shading: MoonShadingState) {
    const material = m.mesh.material as THREE.MeshStandardMaterial;
    const fraction = shading.sunVisibleFraction;
    const isEarthMoon = m.data.name === 'Moon' && m.data.parentPlanet === 'Earth';
    if (isEarthMoon && shading.inUmbra) {
      material.color.setRGB(
        Math.max(fraction, PlanetariumMode.BLOOD_MOON_FLOOR_R),
        Math.max(fraction, 0.07),
        Math.max(fraction, 0.05),
      );
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
   * a collapsed (sub-resolution) true-scale footprint. The guides size their
   * occluder discs from the display fov — the overscan in `camera.fov` is not
   * an angle anything on screen is measured against.
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
      this.shadowVisuals.updateCameraGuides(
        this.tmpGuideCamLocal,
        systemGroup.position,
        this.camera,
        w,
        h,
        displayFovDeg(this.camera),
      );
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

  /** Reveal is inert while any overlay owns the screen (or in surface view):
   *  the pointer there aims at UI, not the sky behind it. */
  private isRevealBlocked(): boolean {
    return this.landedView === 'surface'
      // The map owns the frame and the canvas: its taps and hovers are map
      // gestures, and the label pipeline is skipped outright while it is up, so
      // an unblocked tap would otherwise sit queued and resolve on close.
      || this.isMapOpen()
      || this.isDeckOpen()
      || this.menuPanel.isOpen()
      || this.isHelpOpen()
      || this.isToolsMenuOpen()
      || this.surfaceTargetMenu.isOpen()
      || this.isMissionActive()
      || this.tutorial !== null;
  }

  /** Drop every scrap of transient reveal + gesture state at once. */
  private clearBodyReveal(): void {
    this.revealedBody = null;
    this.touchRevealBody = null;
    this.touchRevealUntil = 0;
    this.hoverEligible = false;
    this.gesturePointerId = null;
    this.hasPendingTap = false;
    // A blur/deactivate mid-gesture never delivers the matching pointerup, so
    // reset the down-count too — otherwise it strands above zero and the
    // single-pointer guard rejects every future tap.
    this.pointersDown = 0;
  }

  private pickListHas(name: string): boolean {
    for (const c of this.bodyPickList) if (c.name === name) return true;
    return false;
  }

  /** A recognized single-tap on the sky queues a timed reveal of whatever body
   *  sits under it — resolved next frame against a fresh pick list. Additive, so
   *  the tap still steers as usual. */
  private handleBodyTap(clientX: number, clientY: number): void {
    if (this.isRevealBlocked()) return;
    this.pendingTapX = clientX;
    this.pendingTapY = clientY;
    this.hasPendingTap = true;
  }

  /**
   * The one place the labels/markers/reveal pipeline runs each cruise or landed
   * (non-surface) frame. Occluders and the pick list refresh first; the reveal
   * resolves against them; then the label + marker passes draw, threaded with
   * the revealed body. Kept ungated on the label/marker settings so a hover can
   * be detected even with everything toggled off.
   *
   * `markerShipTest` comes from the flight path only: the ship is not drawn
   * while landed, so there is no hull that could cover a beacon there.
   */
  private runBodyLabelPipeline(
    excludeName?: string,
    markerShipTest?: (markerWorldPos: THREE.Vector3) => boolean,
  ): void {
    if (!this.planetLabels || !this.solarSystem) return;

    const blocked = this.isRevealBlocked();
    const touchActive = this.touchRevealBody !== null && performance.now() < this.touchRevealUntil;
    const gestureActive = this.gesturePointerId !== null;
    // The picker only needs to run while the user is actually pointing at the
    // sky — a mouse over the canvas, a live touch gesture, a queued tap, or a
    // touch reveal still counting down. Everything else keeps the steady-state
    // cost at zero.
    const pickerWanted = !blocked && (this.hoverEligible || touchActive || gestureActive || this.hasPendingTap);
    const runOccluders = this.showBodyLabels || this.showBodyMarkers || this.revealedBody !== null || pickerWanted;

    if (runOccluders) {
      const scenePositions = this.ensurePickScenePositions();
      for (const planet of this.solarSystem.planets) {
        const p = planet.group.position;
        const slot = scenePositions.get(planet.data.name)!;
        slot.x = p.x; slot.y = p.y; slot.z = p.z;
      }
      this.planetLabels.collectForegroundDiscs(scenePositions, this.renderer);
      this.collectDynamicOccluders();
      if (pickerWanted) {
        this.buildBodyPickList(scenePositions, excludeName);
        // Resolve a just-recognized tap against this fresh pick list.
        if (this.hasPendingTap) {
          const hit = pickBodyAtPointer(this.bodyPickList, this.planetLabels.foregroundDiscs, this.pendingTapX, this.pendingTapY);
          if (hit) {
            this.touchRevealBody = hit;
            this.touchRevealUntil = performance.now() + PlanetariumMode.TOUCH_REVEAL_MS;
          }
          this.hasPendingTap = false;
        }
      } else {
        this.bodyPickList.length = 0;
      }

      this.resolveBodyReveal(pickerWanted);

      if (this.showBodyLabels || this.showBodyMarkers || this.revealedBody !== null) {
        this.planetLabels.renderLabels(scenePositions, this.labelPlayerOrigin, this.renderer, {
          showMarkers: this.showBodyMarkers,
          showLabels: this.showBodyLabels,
          excludeName,
          revealedBody: this.revealedBody ?? undefined,
          sunMask: this.sunGlareMaskParams,
          sunPos: this.solarSystem.sun.position,
          // Last frame's rect (the Sun label updates after this pass; it
          // moves sub-pixel per frame, so the lag is invisible).
          sunLabelRect: this.sunLabel.blockerRect(),
          markerShipTest,
        });
      }
      if (this.showBodyLabels || this.revealedBody !== null) {
        this.renderMoonLabels();
        this.updateSunLabel();
      }
    } else {
      this.bodyPickList.length = 0;
      this.resolveBodyReveal(false);
    }

    this.syncWorldLabelContainers();
  }

  private ensurePickScenePositions(): Map<string, { x: number; y: number; z: number }> {
    if (!this.pickScenePositions) {
      this.pickScenePositions = new Map();
      if (this.solarSystem) {
        for (const planet of this.solarSystem.planets) {
          this.pickScenePositions.set(planet.data.name, { x: 0, y: 0, z: 0 });
        }
      }
    }
    return this.pickScenePositions;
  }

  /**
   * Rebuild the per-frame pick list: every planet, the Sun and every visible
   * moon that has something drawn on screen this frame. With both labels AND
   * markers off, a marker-tier planet is invisible, so only resolved discs
   * (visible meshes) stay aimable. Reuses a pooled candidate array + one
   * projection scratch, so a steady-state frame allocates nothing.
   */
  private buildBodyPickList(
    scenePositions: Map<string, { x: number; y: number; z: number }>,
    excludeName?: string,
  ): void {
    this.bodyPickList.length = 0;
    if (!this.planetLabels || !this.solarSystem) return;
    const canvasW = this.renderer.domElement.clientWidth;
    const canvasH = this.renderer.domElement.clientHeight;
    const halfFovTan = Math.tan((this.camera.fov * Math.PI) / 360);
    // markerQuadPx is the on-screen quad SIZE (diameter) — the same policy
    // function PlanetLabels draws the sprite with, so the pick's catch radius
    // cannot drift from the drawn quad. The 18 px floor in pushPickCandidate
    // then sets the actual catch radius.
    const markerRadiusPx = markerQuadPx(canvasW, canvasH) / 2;
    const bothOff = !this.showBodyLabels && !this.showBodyMarkers;
    const targetMoon = this.currentDotTargetMoon();
    const cam = this.camera.position;
    const proj = this.pickProjScratch;

    // Planets.
    for (const planet of this.solarSystem.planets) {
      if (planet.data.name === excludeName) continue;
      const pos = scenePositions.get(planet.data.name);
      if (!pos) continue;
      const dx = pos.x - cam.x;
      const dy = pos.y - cam.y;
      const dz = pos.z - cam.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const isDisc = (planet.data.radiusAU * 2) / Math.max(dist, 0.0001) > 0.01;
      if (bothOff && !isDisc) continue;
      projectToScreen(pos, this.camera, canvasW, canvasH, proj);
      if (!this.pickProjOnScreen(canvasW, canvasH)) continue;
      const drawnPx = isDisc ? discRadiusPx(planet.data.radiusAU, dist, halfFovTan, canvasH) : markerRadiusPx;
      this.pushPickCandidate(planet.data.name, proj.x, proj.y, drawnPx, dist);
    }

    // The Sun — always drawn; the reveal still gates it on the 1.67 AU rule.
    {
      const sunPos = this.solarSystem.sun.position;
      const dist = cam.distanceTo(sunPos);
      projectToScreen(sunPos, this.camera, canvasW, canvasH, proj);
      if (this.pickProjOnScreen(canvasW, canvasH)) {
        this.pushPickCandidate('Sun', proj.x, proj.y, discRadiusPx(SUN_DATA.radiusAU, dist, halfFovTan, canvasH), dist);
      }
    }

    // Visible moons. The invariant is that pick and label agree: anything you
    // can read the name of is aimable, and nothing else is. So this reuses the
    // label pass's own thresholds — a readable disc, or a dot bright enough to
    // see, or the nav target — plus, for a moon whose dot has gone dark, the
    // label the placement pass actually drew.
    const tempV = this.pickTempV;
    // Whether a drawn label is even possible this frame; without one, a dark
    // moon has nothing on screen to tap.
    const labelsShowing = this.showBodyLabels || this.revealedBody !== null;
    for (const planet of this.solarSystem.planets) {
      const moons = this.planetMoons.get(planet.data.name);
      if (!moons) continue;
      const parentR = planet.data.radiusAU;
      const anchor = this.moonRenderAnchorRatio(planet.data.name);
      for (const m of moons) {
        if (!m.mesh.visible) continue;
        if (this.landedOn?.type === 'moon' && this.landedOn.name === m.data.name) continue;
        m.mesh.getWorldPosition(tempV);
        const dx = tempV.x - cam.x;
        const dy = tempV.y - cam.y;
        const dz = tempV.z - cam.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        projectToScreen(tempV, this.camera, canvasW, canvasH, proj);
        if (!this.pickProjOnScreen(canvasW, canvasH)) continue;
        const effR = this.renderedMoonSizeAU(m.data.radiusAU, parentR, anchor);
        const discPadPx = discRadiusPx(effR, dist, halfFovTan, canvasH) * 1.1;
        const dotAlpha = m.dotScreenAlpha ?? 0;
        const aimable = discPadPx >= LABEL_READABLE_RADIUS_PX
          || dotAlpha >= LABEL_DOT_MIN_ALPHA
          || m.data.name === targetMoon
          || (labelsShowing && (m.labelDisplayed ?? false));
        if (!aimable) continue;
        const dotPx = (m.dotScreenSizePx ?? 0) / 2;
        this.pushPickCandidate(m.data.name, proj.x, proj.y, Math.max(discPadPx, dotPx), dist);
      }
    }
  }

  /** Append one pick candidate, reusing a pooled object (zero allocation in
   *  steady state). pickRadiusPx floors at 18 so tiny dots stay hittable. */
  private pushPickCandidate(name: string, x: number, y: number, radiusPx: number, dist: number): void {
    const n = this.bodyPickList.length;
    let c = this.bodyPickPool[n];
    if (!c) {
      c = { name: '', screenX: 0, screenY: 0, pickRadiusPx: 0, distFromCamera: 0 };
      this.bodyPickPool[n] = c;
    }
    c.name = name;
    c.screenX = x;
    c.screenY = y;
    c.pickRadiusPx = Math.max(radiusPx, 18);
    c.distFromCamera = dist;
    this.bodyPickList.push(c);
  }

  /** Whether the current `pickProjScratch` projection is in front of the camera
   *  and within the label margin. */
  private pickProjOnScreen(canvasW: number, canvasH: number): boolean {
    const p = this.pickProjScratch;
    return p.ndcZ < 1 && p.x > -50 && p.x < canvasW + 50 && p.y > -50 && p.y < canvasH + 50;
  }

  /** Resolve `revealedBody` from the pointer: touch reveal first (while its
   *  window is open and the body is still drawn), then live mouse hover. */
  private resolveBodyReveal(pickerWanted: boolean): void {
    if (this.isRevealBlocked()) {
      this.revealedBody = null;
      this.touchRevealBody = null;
      this.touchRevealUntil = 0;
      this.hasPendingTap = false;
      // Drop hover eligibility too: an overlay can open over a still pointer, so
      // without this the last hover would re-fire the instant the overlay closes,
      // with no pointer movement.
      this.hoverEligible = false;
      return;
    }
    if (this.touchRevealBody !== null) {
      if (performance.now() >= this.touchRevealUntil || !this.pickListHas(this.touchRevealBody)) {
        this.touchRevealBody = null;
        this.touchRevealUntil = 0;
      } else {
        this.revealedBody = this.touchRevealBody;
        return;
      }
    }
    if (pickerWanted && this.hoverEligible && this.planetLabels) {
      this.revealedBody = pickBodyAtPointer(
        this.bodyPickList, this.planetLabels.foregroundDiscs, this.hoverClientX, this.hoverClientY,
      );
      return;
    }
    this.revealedBody = null;
  }

  /** Container-level visibility for the HTML label layers. They stay renderable
   *  whenever labels are on OR a body is being revealed (per-child hiding does
   *  the rest), fold away in surface view, and honour the modal hide. */
  private syncWorldLabelContainers(): void {
    const show = !this.worldLabelsModalHidden
      && this.landedView !== 'surface'
      // Nothing may re-show world labels over the map: the system-map-active
      // class force-hides the DOM anyway, but a modal closing under the map
      // would otherwise clear the hide flag and leave them nominally shown.
      && !this.isMapOpen()
      && (this.showBodyLabels || this.revealedBody !== null);
    const disp = show ? '' : 'none';
    const planetEl = this.planetLabelsContainerEl;
    if (planetEl && planetEl.style.display !== disp) planetEl.style.display = disp;
    if (this.moonLabelContainer && this.moonLabelContainer.style.display !== disp) {
      this.moonLabelContainer.style.display = disp;
    }
  }

  /**
   * Second pass: contribute foreground discs for the Sun, visible moons and
   * the player ship to `planetLabels`, so any label or marker rendered
   * afterwards (planet, moon, sun) is occluded when it would sit on top of
   * one of them. Must run AFTER `planetLabels.collectForegroundDiscs()` and
   * BEFORE any label rendering (`renderLabels`, `renderMoonLabels`,
   * `updateSunLabel`). A body blocks only while it is a face seen from
   * outside: one the camera sits inside is a room, not an obstacle.
   */
  /** See sunScreenProjectionCache. Every caller runs inside update(), after
   *  applyFloatingOrigin has posed the Sun and the camera is final, so one
   *  measurement per frameStamp serves them all. The viewport floor matches
   *  updateSunShader's historical Math.max(…, 1): only a zero-sized (hidden)
   *  canvas is affected, where nothing draws anyway. */
  private getSunScreenProjection(): SphereScreenProjection {
    if (this.sunScreenProjectionFrame !== this.frameStamp && this.solarSystem) {
      this.sunScreenProjectionFrame = this.frameStamp;
      projectSphereToScreen(
        this.solarSystem.sun.position,
        SUN_DATA.radiusAU,
        this.camera,
        Math.max(this.renderer.domElement.clientWidth, 1),
        Math.max(this.renderer.domElement.clientHeight, 1),
        this.sunScreenProjectionCache,
      );
    }
    return this.sunScreenProjectionCache;
  }

  /** A moon's effective-radius screen projection, measured at most once per
   *  frame (MoonMesh.effProj): the occlusion-disc and label passes ask with
   *  identical inputs — the mesh's world position, the rendered-size radius,
   *  the settled camera — so whichever runs first serves the other. Gates
   *  differ per pass (occluders skip small discs, labels skip hidden names),
   *  which the lazy fill absorbs: a moon only ever measures for its first
   *  asker. A cache hit ignores the arguments, so only those two passes may
   *  call this. updateBodyLOD in particular must NOT join: it runs before the
   *  camera-safety pass and deliberately measures a different camera pose. */
  private moonEffScreenProjection(
    m: MoonMesh,
    worldPos: THREE.Vector3,
    effRadiusAU: number,
  ): NonNullable<MoonMesh['effProj']> {
    let cache = m.effProj;
    if (!cache) {
      cache = m.effProj = { frame: -1, x: 0, y: 0, ndcZ: 0, radiusPx: 0, footprintX: 0, footprintY: 0 };
    }
    if (cache.frame !== this.frameStamp) {
      const proj = projectSphereToScreen(
        worldPos,
        effRadiusAU,
        this.camera,
        this.renderer.domElement.clientWidth,
        this.renderer.domElement.clientHeight,
        this.sphereScreenProjection,
      );
      cache.frame = this.frameStamp;
      cache.x = proj.x;
      cache.y = proj.y;
      cache.ndcZ = proj.ndcZ;
      cache.radiusPx = proj.radiusPx;
      cache.footprintX = proj.footprintX;
      cache.footprintY = proj.footprintY;
    }
    return cache;
  }

  private collectDynamicOccluders() {
    if (!this.planetLabels || !this.solarSystem) return;
    const canvasW = this.renderer.domElement.clientWidth;
    const canvasH = this.renderer.domElement.clientHeight;
    const camX = this.camera.position.x;
    const camY = this.camera.position.y;
    const camZ = this.camera.position.z;
    const tempV = this.tmpLabelMoonWorld;

    // The Sun. No angular-size gate: markers no longer depth-test, so this
    // disc is the only thing keeping a far planet's marker (and label) from
    // drawing over the solar disc — however few pixels it covers. The Sun
    // label itself is safe: equal camera distance short-circuits the test.
    {
      const sunPos = this.solarSystem.sun.position;
      const distFromCamera = this.camera.position.distanceTo(sunPos);
      const proj = this.getSunScreenProjection();
      if (proj.ndcZ < 1 && distFromCamera > 0) {
        const radiusPx = proj.radiusPx * 1.1;
        this.planetLabels.addForegroundDisc({
          screenX: proj.footprintX, screenY: proj.footprintY, radiusPx, distFromCamera, name: 'Sun',
        });
      }
    }

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
        // Effective rendered radius: the same curve the mesh uses, so the
        // occlusion disc matches what's actually drawn.
        const effectiveRadiusAU = this.renderedMoonSizeAU(m.data.radiusAU, parentR, this.moonRenderAnchorRatio(planet.data.name));
        // A sphere the camera is inside occludes nothing: its back faces cull
        // and you see out through it. The projection answers 'covering' there —
        // a conservative classification, not a measured disc — which as a
        // blocker would blank every label and beacon in the sky. Testing it
        // first also guarantees a positive distance for the ratio below.
        if (distFromCamera <= effectiveRadiusAU) continue;
        // Angular-size gate, compared WITHOUT a floor under the distance: a
        // floored denominator turns the ratio into an absolute-size test at
        // close range, and no moon whose rendered radius is under ~75 km can
        // ever satisfy it — Phobos and Deimos would contribute no occlusion
        // disc at any distance, letting labels and beacons draw over their faces.
        if (effectiveRadiusAU * 2 <= 0.01 * distFromCamera) continue;

        const proj = this.moonEffScreenProjection(m, tempV, effectiveRadiusAU);
        if (proj.ndcZ >= 1) continue;
        const screenX = proj.footprintX;
        const screenY = proj.footprintY;
        const radiusPx = proj.radiusPx * 1.1;
        this.planetLabels.addForegroundDisc({ screenX, screenY, radiusPx, distFromCamera, name: `moon:${m.data.name}` });
      }
    }

    // Player ship (visible + not landed): sits at scene origin (floating
    // origin), so its camera distance is just the camera's magnitude.
    if (this.player.group.visible && !this.landedOn) {
      const distFromCamera = this.camera.position.length();
      if (distFromCamera > 0) {
        const shipSceneRadiusAU = SHIP_OCCLUDER_RADIUS_AU;
        const angularSize = (shipSceneRadiusAU * 2) / distFromCamera;
        if (angularSize > 0.005) {
          const proj = projectSphereToScreen(
            tempV.set(0, 0, 0),
            shipSceneRadiusAU,
            this.camera,
            canvasW,
            canvasH,
            this.sphereScreenProjection,
          );
          if (proj.ndcZ < 1) {
            const screenX = proj.footprintX;
            const screenY = proj.footprintY;
            const radiusPx = proj.radiusPx;
            this.planetLabels.addForegroundDisc({ screenX, screenY, radiusPx, distFromCamera, name: 'ship' });
          }
        }
      }
    }
  }

  // Marker-vs-hull raycast scratch (isMarkerBehindShip). Reused per call —
  // the sphere pre-reject means the traversal + raycast run only for
  // markers whose sight line passes the hull, typically zero per frame.
  private markerShipRaycaster = new THREE.Raycaster();
  private markerShipRayDir = new THREE.Vector3();
  /** Moon world-position scratch for the occluder + moon-label passes (they
   *  never nest; each read is consumed within its own loop iteration). */
  private readonly tmpLabelMoonWorld = new THREE.Vector3();
  private markerShipMeshes: THREE.Object3D[] = [];
  private markerShipHits: THREE.Intersection[] = [];
  private shipSunRight = new THREE.Vector3();
  private shipSunUp = new THREE.Vector3();
  private shipSunRayDir = new THREE.Vector3();
  private shipSunToShip = new THREE.Vector3();
  private shipSunVisibility = 1;
  private shipSunRaycastCount = 0;
  private devShipSunOcclusionEnabled = true;

  /** Refresh the live solid-hull list. Profile swaps and Cassini's async GLB
   *  resolution make a persistent cache unsafe without invalidation, while the
   *  Sun overlap gate makes this rare traversal cheap in practice. */
  private collectSolidShipMeshes(): void {
    this.player.group.updateWorldMatrix(true, true);
    this.markerShipMeshes.length = 0;
    const collect = (object: THREE.Object3D): void => {
      if (!object.visible) return;
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) {
        const material = mesh.material as THREE.Material | THREE.Material[];
        const additive = Array.isArray(material)
          ? material.every((candidate) => candidate.blending === THREE.AdditiveBlending)
          : material.blending === THREE.AdditiveBlending;
        if (!additive) this.markerShipMeshes.push(mesh);
      }
      for (const child of object.children) collect(child);
    };
    collect(this.player.group);
  }

  /** Test one bounded camera ray against the hull list collected above. */
  private rayHitsCollectedShip(direction: THREE.Vector3, far = Infinity): boolean {
    this.markerShipRaycaster.set(this.camera.position, direction);
    this.markerShipRaycaster.near = 0;
    this.markerShipRaycaster.far = far;
    this.markerShipHits.length = 0;
    return this.markerShipRaycaster.intersectObjects(
      this.markerShipMeshes,
      false,
      this.markerShipHits,
    ).length > 0;
  }

  /**
   * True when the sight line from the camera to a far marker passes through
   * the ship's solid hull. Solid meshes only, skipping invisible subtrees
   * and additive-blended meshes (the exhaust flame is light, not hull, and
   * shouldn't eat a beacon; the glow sprites aren't meshes at all). Any
   * hull hit occludes: the marker's body is always AU away, far behind
   * every part of the ship.
   */
  private isMarkerBehindShip = (markerWorldPos: THREE.Vector3): boolean => {
    if (!this.player.group.visible || this.landedOn) return false;
    // Exact pre-reject before any traversal: the ship rides the scene
    // origin (floating origin), so the sight line clears every profile's
    // hull when its closest approach to the origin exceeds the widest hull
    // sphere — unless the camera itself sits inside that sphere (the
    // wheel-zoom floor, 3.3 reference radii, is inside the 4.5 sphere).
    const cam = this.camera.position;
    const dir = this.markerShipRayDir.copy(markerWorldPos).sub(cam).normalize();
    const camDistSq = cam.lengthSq();
    const extentSq = SHIP_ANY_HULL_EXTENT_AU * SHIP_ANY_HULL_EXTENT_AU;
    if (camDistSq > extentSq) {
      const t = -cam.dot(dir); // ray parameter at closest approach to the origin
      if (t <= 0 || camDistSq - t * t > extentSq) return false;
    }
    // The hull pose is a frame stale at label time: player.update() moved it
    // earlier this frame but world matrices refresh at render — and a
    // just-swapped profile has never been through a render at all.
    this.collectSolidShipMeshes();
    return this.rayHitsCollectedShip(dir);
  };

  /**
   * Fraction of deterministic rays across the physical solar disc that reach
   * the Sun without hitting the foreground ship. This is an independent
   * camera-optics transmission signal: it must never enter celestial eclipse,
   * exposure, corona, flash, or silhouette state.
   */
  private computeShipSunVisibility(
    sunDirection: THREE.Vector3,
    sunDistance: number,
    sunAngularRadius: number,
    eligible: boolean,
  ): number {
    this.shipSunRaycastCount = 0;
    if (
      !this.devShipSunOcclusionEnabled ||
      !eligible ||
      !this.player.group.visible ||
      this.landedOn
    ) return 1;

    const cameraDistance = this.camera.position.length();
    // The dev free-camera Sun rig may seat the camera at the floating origin,
    // inside the visible ship. That is not a meaningful foreground hull pose.
    if (!(cameraDistance > 1e-12)) return 1;

    const toShip = this.shipSunToShip.copy(this.camera.position)
      .multiplyScalar(-1 / cameraDistance);
    const shipAlongRay = cameraDistance * toShip.dot(sunDirection);
    if (
      shipAlongRay + SHIP_ANY_HULL_EXTENT_AU <= 0 ||
      shipAlongRay - SHIP_ANY_HULL_EXTENT_AU >= sunDistance
    ) return 1;
    if (!shipHullMayOverlapSource(
      cameraDistance,
      SHIP_ANY_HULL_EXTENT_AU,
      toShip.dot(sunDirection),
      sunAngularRadius,
    )) return 1;

    this.collectSolidShipMeshes();

    // Form an exact tangent basis around the Sun direction from camera-right.
    // Projecting first keeps the sample disc circular even when the Sun is
    // off-axis. Fall back to camera-up only at the degenerate parallel case.
    this.camera.updateMatrixWorld();
    const elements = this.camera.matrixWorld.elements;
    const right = this.shipSunRight.set(elements[0], elements[1], elements[2]);
    right.addScaledVector(sunDirection, -right.dot(sunDirection));
    if (right.lengthSq() < 1e-12) {
      right.set(elements[4], elements[5], elements[6]);
      right.addScaledVector(sunDirection, -right.dot(sunDirection));
    }
    right.normalize();
    const up = this.shipSunUp.crossVectors(sunDirection, right).normalize();
    const tangentRadius = Math.tan(sunAngularRadius);
    let unblocked = 0;
    for (const sample of SHIP_SUN_DISC_SAMPLES) {
      const ray = this.shipSunRayDir.copy(sunDirection)
        .addScaledVector(right, sample.x * tangentRadius)
        .addScaledVector(up, sample.y * tangentRadius)
        .normalize();
      this.shipSunRaycastCount++;
      if (!this.rayHitsCollectedShip(ray, sunDistance)) unblocked++;
    }
    return unblockedShipSunFraction(unblocked, SHIP_SUN_DISC_SAMPLES.length);
  }

  /**
   * Third pass: place HTML labels for visible moons. Uses the occluder set
   * populated by `planetLabels.collectForegroundDiscs` + `collectDynamicOccluders`.
   */
  private renderMoonLabels() {
    if (!this.solarSystem || this.moonLabelContainer === null) return;
    const canvasW = this.renderer.domElement.clientWidth;
    const canvasH = this.renderer.domElement.clientHeight;
    const tempV = this.tmpLabelMoonWorld;

    // Two passes: gather the placeable labels here, then hand the contest to
    // placeMoonLabels — who yields to whom is a rule set with its own tests, and
    // this pass owns only the gathering and the DOM. Rects are estimated
    // (reading offsetWidth would force reflow). Candidate objects are pooled —
    // steady-state frames allocate nothing.
    const candidates = this.moonLabelCandidates;
    let candidateCount = 0;
    const targetMoon = this.currentDotTargetMoon();
    // With labels off the pass still runs to draw a single revealed moon; every
    // other moon stays hidden.
    const labelsOn = this.showBodyLabels;
    const revealedMoon = this.revealedBody;
    // A moon earns a label when its disc reads as more than a point, OR its dot
    // would be at least faintly visible with the moon fully lit, OR it is the
    // explicit nav target. Judging by the lit dot is the point: a moon in
    // eclipse or at new phase is still there and still aimable, so its name
    // holds through the darkness in the .unlit style instead of strobing with
    // the terminator. A moon too faint to dot even fully lit gets no label
    // pointing at empty sky — and the nav target is the one wayfinding
    // exception, named however dim, because you asked for it by name.
    const placement = this.moonLabelPlacementParams;

    for (const planet of this.solarSystem.planets) {
      const moons = this.planetMoons.get(planet.data.name);
      if (!moons) continue;
      for (const m of moons) {
        // Cleared on the way in and set only where a label is really placed, so
        // every path out of this loop leaves the pick list an honest answer. The
        // dark-style bit is read here and cleared with it: a moon that drops out
        // of the pass — hidden, landed on, off the back of the camera — comes
        // back through the enter threshold rather than being held on the leave
        // one by a memory of the last time it was dark.
        m.labelDisplayed = false;
        const wasUnlit = m.labelUnlit ?? false;
        m.labelUnlit = false;
        const label = this.moonLabels.get(m.data.name);
        if (!label) continue;
        // Suppress the landed moon's own label — no need to label what you're standing on.
        if (this.landedOn?.type === 'moon' && this.landedOn.name === m.data.name) {
          if (label.style.display !== 'none') label.style.display = 'none';
          continue;
        }
        // With labels off, only the revealed moon draws; everything else hides.
        if (!labelsOn && m.data.name !== revealedMoon) {
          if (label.style.display !== 'none') label.style.display = 'none';
          continue;
        }
        if (!m.mesh.visible) continue;

        m.mesh.getWorldPosition(tempV);
        const moonCamDist = tempV.distanceTo(this.camera.position);
        // Rendered disc radius: the same curve the mesh uses, padded so the
        // label anchor clears the limb instead of riding on the moon's face.
        // One measurement serves anchor and pad — a sphere projection's centre
        // fields are radius-independent (pinned in the projectToScreen tests)
        // — and it is the same measurement the occlusion pass already took for
        // this moon this frame.
        const effRadiusAU = this.renderedMoonSizeAU(
          m.data.radiusAU,
          planet.data.radiusAU,
          this.moonRenderAnchorRatio(planet.data.name),
        );
        const proj = this.moonEffScreenProjection(m, tempV, effRadiusAU);
        if (proj.ndcZ >= 1) {
          if (label.style.display !== 'none') label.style.display = 'none';
          continue;
        }
        const discRadiusPadPx = proj.radiusPx * 1.1;

        // Sub-pixel gating: a moon whose disc doesn't read and whose dot is too
        // faint to see even fully lit keeps no label — unless it's the nav target.
        const dotAlpha = m.dotScreenAlpha ?? 0;
        const dotLitAlpha = m.dotLitScreenAlpha ?? 0;
        const readable = discRadiusPadPx >= LABEL_READABLE_RADIUS_PX;
        const isTarget = targetMoon === m.data.name;
        if (!readable && dotLitAlpha < LABEL_DOT_MIN_ALPHA && !isTarget) {
          if (label.style.display !== 'none') label.style.display = 'none';
          continue;
        }
        // Dark-kept: the name is held by the lit dot while the real one has gone
        // out. The band is sticky per moon so the style cannot pulse with a dot
        // flickering across a single threshold. A readable disc never takes the
        // style — a resolved moon sits at a low dot alpha as its normal state,
        // handed off to the disc.
        const dark = wasUnlit
          ? dotAlpha <= placement.unlitLeaveAlpha
          : dotAlpha < placement.unlitEnterAlpha;
        const isUnlit = !readable && dark && dotLitAlpha >= LABEL_DOT_MIN_ALPHA;
        m.labelUnlit = isUnlit;
        // Lift the anchor clear of whichever is larger — the disc limb or the
        // dot glyph (for a sub-pixel moon the dot is the only thing on screen).
        const radiusPx = Math.max(discRadiusPadPx, (m.dotScreenSizePx ?? 0) / 2);

        // Lift the anchor above the limb BEFORE the on-screen test, so a
        // screen-filling moon pins its label to the top margin (dimmed via the
        // .edge class) rather than holding it at full opacity on the disc.
        const syLifted = proj.y - radiusPx;
        let sx = proj.x;
        let sy = syLifted;
        const margin = 30;
        const onScreen = sx >= margin && sx <= canvasW - margin &&
                         sy >= margin && sy <= canvasH - margin;
        sx = Math.max(margin, Math.min(canvasW - margin, sx));
        sy = Math.max(margin, Math.min(canvasH - margin, sy));
        // Estimated half-width of the drawn name (measuring one would force a
        // layout): the slide is bounded by it, and the contest below rects by it.
        const halfW = (m.data.name.length * 6.5 + 12) / 2;
        // The clamp can shove the anchor back onto the disc when the limb has
        // left the screen — there's no "just above" to show there, so the anchor
        // slides along the margin it is pinned to until it clears the limb, and
        // hides only when nothing on that edge clears (the self-excluded
        // occlusion probe below never catches this). Only a clamped anchor can
        // be inside: unclamped it sits exactly on the limb, where this distance
        // test would be at the mercy of float rounding.
        const clampedX = sx !== proj.x;
        const clampedY = sy !== syLifted;
        if (clampedX || clampedY) {
          const slide = this.moonLabelSlide;
          const cleared = clampAnchorClearOfDisc(
            sx, sy, clampedX, clampedY,
            proj.x, proj.y, radiusPx, halfW,
            margin, canvasW - margin, margin, canvasH - margin,
            this.moonLabelSlideSides.get(m.data.name) ?? 0,
            slide,
            placement,
          );
          if (!cleared) {
            if (label.style.display !== 'none') label.style.display = 'none';
            continue;
          }
          sx = slide.x;
          sy = slide.y;
          // Remember which way it went, but never forget it on a frame that
          // needed no slide — the side has to outlive the moments the anchor
          // happens to sit clear, or it flips the moment it is needed again.
          if (slide.side !== 0) this.moonLabelSlideSides.set(m.data.name, slide.side);
        }
        // Label sits above the moon (translate(-50%, -100%) + -6px margin).
        // Exclude this moon's own disc so it doesn't cull itself.
        const selfDisc = `moon:${m.data.name}`;
        const labelOccluded = this.planetLabels?.isScreenPointOccluded(sx, sy - 10, moonCamDist, selfDisc) ?? false;
        if (labelOccluded) {
          label.style.display = 'none';
          continue;
        }
        // A dark-kept label has no dot under it, so nothing on screen ties the
        // name to the moon: require the moon's own centre unoccluded too, or the
        // name floats over the parent's limb announcing something you cannot
        // see. A lit moon needs no such proof — its dot is the proof.
        if (isUnlit
          && (this.planetLabels?.isScreenPointOccluded(proj.x, proj.y, moonCamDist, selfDisc) ?? false)) {
          if (label.style.display !== 'none') label.style.display = 'none';
          continue;
        }
        let c = candidates[candidateCount];
        if (!c) {
          c = {
            label, moon: m, name: '', parent: '', sx: 0, sy: 0, onScreen: false, priorityPx: 0,
            halfW: 0, isTarget: false, isRevealed: false, isUnlit: false, placed: false,
          };
          candidates.push(c);
        }
        c.label = label;
        c.moon = m;
        c.name = m.data.name;
        c.parent = planet.data.name;
        c.sx = sx;
        c.sy = sy;
        c.onScreen = onScreen;
        c.isTarget = isTarget;
        c.isRevealed = revealedMoon === m.data.name;
        c.isUnlit = isUnlit;
        // Collision priority is apparent footprint: a readable disc by its px
        // radius, a sub-pixel moon by its dot's weighted glyph size, so among
        // piled-up dots the brighter one keeps its label. A dark-kept moon
        // contests with the footprint it would have fully lit — BOTH factors
        // from the lit twin, since the star mapping shrinks an unlit dot as
        // well as dimming it. Eclipse state must not reorder the contest, or
        // the strobe just moves to whichever neighbour loses the slot.
        c.priorityPx = Math.max(
          discRadiusPadPx,
          isUnlit
            ? dotLitAlpha * (m.dotLitScreenSizePx ?? 0)
            : dotAlpha * (m.dotScreenSizePx ?? 0),
        );
        c.halfW = halfW;
        candidateCount++;
      }
    }

    candidates.length = candidateCount;
    // On a phone-width canvas each system pins at most one off-screen moon's
    // label to the margins — see edgeLabelSystemCap. Desktop is uncapped.
    placeMoonLabels(candidates, this.moonLabelIncumbents, placement, edgeLabelSystemCap(canvasW));
    // Apply the decision, and record this frame's winners as the next frame's
    // incumbents. The two sets are swapped rather than rebuilt, and a name that
    // stops being a candidate simply ages out of the buffer being refilled.
    const nextIncumbents = this.moonLabelIncumbentsBuffer;
    nextIncumbents.clear();
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (!c.placed) {
        if (c.label.style.display !== 'none') c.label.style.display = 'none';
        continue;
      }
      c.label.style.display = 'block';
      c.label.style.left = `${c.sx}px`;
      c.label.style.top = `${c.sy}px`;
      c.label.classList.toggle('edge', !c.onScreen);
      c.label.classList.toggle('unlit', c.isUnlit);
      c.label.classList.toggle('revealed', c.isRevealed);
      c.moon.labelDisplayed = true;
      nextIncumbents.add(c.name);
    }
    this.moonLabelIncumbentsBuffer = this.moonLabelIncumbents;
    this.moonLabelIncumbents = nextIncumbents;
  }

  /** Mark that the camera or scene just jumped, so the next Sun-shader frame
   *  reseeds the emergence-flash baseline with that frame's own visible fraction
   *  instead of reading the jump as a rise. Call from every discontinuity where
   *  the Sun's exposed fraction can step in a single frame — teleport, landing,
   *  takeoff, restore, time set, event jump, surface-view entry — otherwise the
   *  glare burst meant for a limb clearing fires on the jump and reads as a
   *  glitch. The stored flash keeps decaying on its own. */
  private noteSunViewDiscontinuity(): void {
    this.sunFlashResetPending = true;
    this.sunSilhouetteSnapPending = true;
    // Drop the cross-frame dominant-occluder incumbent: after a scene jump the
    // previous frame's occluder is a different sky, so its ownership hysteresis
    // must not out-vote the new scene's true dominant occluder through the 15%
    // rule. The next computeVisibleSunFraction elects a fresh incumbent.
    this.sunDominantOccluderMesh = null;
    this.clearMoonLabelIncumbents();
  }

  /** Drop the moon labels' cross-frame incumbents, so the next contest runs
   *  cold. Call wherever the previous frame's sky stops being an argument about
   *  this one: a scene jump lands on different moons entirely, and a held name
   *  from the sky you left would defend a slot it never earned here. */
  private clearMoonLabelIncumbents(): void {
    this.moonLabelIncumbents.clear();
    this.moonLabelIncumbentsBuffer.clear();
    this.moonLabelSlideSides.clear();
    // The per-moon label bits are the same memory kept somewhere else. The pick
    // list reads labelDisplayed one frame late, so without this a name from the
    // sky just left stays aimable for a frame in the sky just arrived at.
    for (const moons of this.planetMoons.values()) {
      for (const m of moons) {
        m.labelDisplayed = false;
        m.labelUnlit = false;
      }
    }
  }

  // Scratch for the veil support pass, reused across the gate's upper-bound and
  // the final per-frame call so neither allocates.
  private sunVeilSupport = { halfPx: 0, armDecayPx: 0, armDecayYPx: 0 };
  // The glint minimum-footprint scale updateSunShader computed this frame
  // (1 inside ~5 AU, 0.46 in the outer system) — the glare-mask core floor
  // shrinks by the same factor so the dot cull tracks the drawn glint.
  private sunGlintFloorScale = 1;

  // One persistent glare-mask parameter set, filled at the end of every
  // updateSunShader and read by the star/belt point materials and the label
  // overlays so nothing shows *through* the Sun's glare. Inactive by default:
  // consumers render byte-identically until the Sun is genuinely eligible.
  private sunGlareMaskParams: SunGlareMaskParams = {
    active: false,
    sunXPx: 0,
    sunYPx: 0,
    peak: 0,
    transmission: 1,
    armCoeff: 0,
    armDecayPx: 0,
    armDecayYPx: 0,
    coreOuterPx: 0,
    viewportHeight: 1,
  };

  /** Persistent input to sunGlareMaskActivation, mutated in place each frame so
   *  the per-frame mask pass allocates nothing. */
  private sunGlareMaskActivationInput: SunGlareMaskActivationInput = {
    sunFootprintKind: 'none',
    sunXPx: 0,
    sunYPx: 0,
    coreOuterPx: 0,
    washSupportPx: 0,
    viewportWidth: 1,
    viewportHeight: 1,
  };

  /** Push the current mask params into the GPU point consumers. The CPU
   *  consumers (labels, Sun label) read `sunGlareMaskParams` directly. */
  private applySunGlareMaskToPoints(viewportWidth: number): void {
    const params = this.sunGlareMaskParams;
    if (this.starfield) {
      applySunGlareMaskParams(
        (this.starfield.material as THREE.ShaderMaterial).uniforms as unknown as SunGlareMaskUniforms,
        params,
        viewportWidth,
        this.camera,
        this.renderer.getPixelRatio(),
      );
    }
    const beltUniforms = this.solarSystem?.asteroidBelt.userData.sunGlareMaskUniforms as
      | SunGlareMaskUniforms
      | undefined;
    if (beltUniforms) applySunGlareMaskParams(
      beltUniforms,
      params,
      viewportWidth,
      this.camera,
      this.renderer.getPixelRatio(),
    );
  }

  /** Collapse the mask to an inactive no-op and push it (used on the buried-
   *  camera path, where there is no glare to obscure anything). */
  private deactivateSunGlareMask(): void {
    this.sunGlareMaskParams.active = false;
    this.applySunGlareMaskToPoints(Math.max(this.renderer.domElement.clientWidth, 1));
  }

  /** Screen-space support the veiling glare needs, in CSS pixels: the radius
   *  where the Moffat wash and the diffraction arms fall below the visibility
   *  floor. The billboard is grown to this so it tracks how far the light
   *  actually carries rather than an authored size, and the arm decay lengths it
   *  hands back are the same ones the shader draws with (one source of truth, so
   *  the quad always contains the arms it renders). Writes into shared scratch. */
  private computeSunVeilSupport(
    veilAmt: number,
    veilStrength: number,
    exposureScale: number,
    viewportHeight: number,
    armCoeff: number,
  ): void {
    const h = viewportHeight;
    // The shader multiplies the veil by up to 1.5 during a limb-clearing flash;
    // sizing to that peak keeps a flash from clipping at the quad edge.
    const peak = veilStrength * veilAmt * exposureScale * 1.5;
    // Invert the wash's Moffat profile for the dHat where it reaches the
    // floor, then convert that normalized distance back to pixels. Scale and
    // exponent come from the shader's own exported constants.
    const washRatio = Math.pow(peak / SUN_VEIL_EPSILON, 1 / SUN_VEIL_BETA);
    const washHalfPx = SUN_VEIL_SCALE_H * h * Math.sqrt(Math.max(washRatio, 1) - 1);
    // The arms reach as far as the wash carries: full length at 1 AU (the wash
    // spans the frame), collapsing together in the outer system. Driving the
    // reach off the wash support keeps this non-circular — the arm term folds
    // into the combined support below without feeding back into its own length.
    const reachScale = THREE.MathUtils.clamp(washHalfPx / (0.55 * h), 0, 1);
    // e-folds capped in CSS px so a tall viewport can't stretch the arms: the
    // visible arm runs to roughly 80 px at Earth and collapses outward in
    // step with the wash reach.
    const armDecayPx = Math.min(0.032 * h, 32) * reachScale;
    const armDecayYPx = Math.min(0.012 * h, 12) * reachScale;
    // The horizontal arm decays as exp(-x / armDecayPx); solve for the x where it
    // hits the floor. Its longer reach bounds the vertical pair too.
    const armHalfPx = armDecayPx * Math.log(Math.max((peak * armCoeff) / SUN_VEIL_EPSILON, 1));
    this.sunVeilSupport.halfPx = Math.min(Math.max(washHalfPx, armHalfPx), 0.62 * h);
    this.sunVeilSupport.armDecayPx = armDecayPx;
    this.sunVeilSupport.armDecayYPx = armDecayYPx;
  }

  /** Advance the two-owner silhouette dim one frame and write the smoothed
   *  value onto each owner's night-lift uniform. `target` is the dominant
   *  occluder's fx (null when nothing eclipse-scale silhouettes the Sun);
   *  `shade` is its already-gated target (occluderShade × silhouetteSizeGate).
   *  The ramp keeps a warp-compressed eclipse from strobing the night fills;
   *  `snap` (a queued view discontinuity) lands both slots on target instantly
   *  so a teleport shows no fading ghost of the previous scene's dark disc. */
  private advanceSunSilhouette(
    target: SurfaceShadingFx | null,
    shade: number,
    nowMs: number,
    snap: boolean,
  ) {
    const state = this.sunSilhouetteOwners;
    const prevCurrent = state.current.owner;
    const prevEx = state.ex.owner;
    this.sunSilhouetteTarget.owner = target;
    this.sunSilhouetteTarget.shade = shade;
    this.sunSilhouetteAdvanceOptions.snap = snap;
    advanceSilhouetteOwners(state, this.sunSilhouetteTarget, nowMs, this.sunSilhouetteAdvanceOptions);
    const curr = state.current;
    const ex = state.ex;
    if (curr.owner) curr.owner.uSilhouette.value = curr.applied;
    if (ex.owner) ex.owner.uSilhouette.value = ex.applied;
    // Zero any body that left both slots this frame — released after fading, or
    // evicted when a brand-new owner reused its slot; the smoothing forgot it,
    // so nobody else will lower its uniform.
    if (prevCurrent && prevCurrent !== curr.owner && prevCurrent !== ex.owner) {
      prevCurrent.uSilhouette.value = 0;
    }
    if (prevEx && prevEx !== curr.owner && prevEx !== ex.owner) {
      prevEx.uSilhouette.value = 0;
    }
  }

  /** Clear the two-owner silhouette state: zero any body still carrying the
   *  dim and empty both slots. Used by deactivation and the inside-photosphere
   *  reset; the per-frame driver is advanceSunSilhouette(). */
  private clearSunSilhouette() {
    const state = this.sunSilhouetteOwners;
    if (state.current.owner) state.current.owner.uSilhouette.value = 0;
    if (state.ex.owner) state.ex.owner.uSilhouette.value = 0;
    state.current.owner = null;
    state.current.applied = 0;
    state.current.stampMs = 0;
    state.ex.owner = null;
    state.ex.applied = 0;
    state.ex.stampMs = 0;
    this.sunDominantOccluderMesh = null;
  }

  /** Drive the DOM chrome flood from this frame's whiteout. The element sits
   *  over the everyday HUD (never over the tutorial card, ☰ menu, veils, or
   *  help) and never takes pointer events, so the washed-out cockpit stays
   *  operable inside the blaze. */
  private applySunGlareFlood(whiteout: number) {
    // The map force-hides #sun-glare-flood via the body class; skip the opacity
    // computation and DOM write while it owns the frame (updateSunShader still
    // runs, so the exposure/solar state stays live for the return to the world).
    if (this.isMapOpen()) return;
    const el = (this.sunGlareFloodEl ??= document.getElementById('sun-glare-flood'));
    if (!el) return;
    const value = sunGlareFloodOpacity(whiteout).toFixed(3);
    if (value !== this.sunGlareFloodLast) {
      this.sunGlareFloodLast = value;
      el.style.opacity = value;
    }
  }

  private updateSunShader(dt: number) {
    if (!this.solarSystem) return;
    const sunMat = this.solarSystem.sun.userData.sunMaterial as THREE.ShaderMaterial | undefined;
    const interiorMesh = this.solarSystem.sun.userData.sunInteriorMesh as THREE.Mesh | undefined;
    const prominenceMat = this.solarSystem.sun.userData.sunProminenceMaterial as THREE.ShaderMaterial | undefined;
    const glareMat = this.solarSystem.sun.userData.sunGlareMaterial as THREE.ShaderMaterial | undefined;
    const ghostMat = this.solarSystem.sun.userData.sunLensGhostMaterial as THREE.ShaderMaterial | undefined;
    if (sunMat) {
      sunMat.uniforms.time.value += dt;
    }
    if (prominenceMat) prominenceMat.uniforms.time.value += dt;

    const toSun = this.tmpSunDirection
      .copy(this.solarSystem.sun.position)
      .sub(this.camera.position);
    const sunDistance = toSun.length();
    if (!(sunDistance > SUN_DATA.radiusAU)) {
      // Dev poses can put the camera inside the photosphere; ease the
      // exposure back to neutral rather than freezing it mid-adaptation.
      this.sunEmergenceFlash = advanceSunEmergenceFlash({
        previousVisibleFraction: this.lastSunVisibleFraction,
        visibleFraction: 1,
        flash: this.sunEmergenceFlash,
        dt,
        eligible: false,
      });
      this.lastSunVisibleFraction = 1;
      // This path already pins the baseline and runs ineligible (no flash can
      // fire), so any queued discontinuity reseed is moot — consume it. The
      // silhouette state was just cleared to zero, so its snap is moot too.
      this.sunFlashResetPending = false;
      this.sunSilhouetteSnapPending = false;
      this.sunAtmosphereMix = 0;
      // One submersion fade drives everything a buried camera can still see:
      // the shell's interior fog, the glare quad's wash (which would otherwise
      // hold a flat grey until the billboard plane snaps behind the camera at
      // the exact centre), and the exposure floor. Full brightness at the
      // surface keeps the crossing continuous with the close-up view; a small
      // floor keeps the deep interior an ember glow rather than a dead screen.
      const submersion = THREE.MathUtils.clamp(sunDistance / SUN_DATA.radiusAU, 0, 1);
      const interiorFade = 0.006 + 0.994 * THREE.MathUtils.smoothstep(submersion, 0.25, 0.95);
      const whiteout = sunInteriorWhiteout(submersion);
      this.applySunGlareFlood(whiteout);
      if (interiorMesh) interiorMesh.visible = true;
      if (sunMat) {
        sunMat.uniforms.uAtmosphereMix.value = 0;
        sunMat.uniforms.uInteriorFade.value = interiorFade;
        sunMat.uniforms.uWhiteout.value = whiteout;
      }
      if (glareMat) {
        const baseStrength = (glareMat.userData.baseGlareStrength ??=
          glareMat.uniforms.uGlareStrength.value);
        glareMat.uniforms.uGlareStrength.value = baseStrength * interiorFade;
        glareMat.uniforms.uVisibleFraction.value = 1;
        glareMat.uniforms.uShipSunVisibility.value = 1;
        glareMat.uniforms.uAtmosphereMix.value = 0;
        glareMat.uniforms.uEmergenceFlash.value = this.sunEmergenceFlash;
        // Inside the photosphere the veil has no meaning; collapse the billboard.
        glareMat.uniforms.uVeilAmt.value = 0;
        glareMat.uniforms.uVeilHalfPx.value = 0;
        glareMat.uniforms.uOccluderShade.value = 0;
        // No occluder crescent from inside the photosphere: clear the light-shift
        // and contact-blaze uniforms and undo the crescent's min-size growth, so a
        // buried-camera frame entered straight from a second-contact pose can't
        // leave a displaced glare centroid, a diamond ring, or a contact arc
        // live. Those terms carry no visibleEnergy factor, so only an explicit
        // reset zeroes them — and their envelope state goes with them, or the
        // frame that surfaces again would release from a stale blaze.
        glareMat.uniforms.uGlareCentroidSr.value.set(0, 0);
        glareMat.uniforms.uDiamondOccluderSr.value.set(0, 0);
        glareMat.uniforms.uDiamondRing.value = 0;
        glareMat.uniforms.uBeadCarveDepth.value = 0;
        glareMat.uniforms.uChromoAnti.value = 0;
        glareMat.uniforms.uChromoToward.value = 0;
        this.sunDiamondRing = 0;
        this.sunBeadCarveDepth = 0;
        this.sunChromoAnti = 0;
        this.sunChromoToward = 0;
        const baseMinHalfPx = (glareMat.userData.baseMinHalfPx ??=
          glareMat.uniforms.uMinHalfSizePx.value);
        glareMat.uniforms.uMinHalfSizePx.value = baseMinHalfPx;
      }
      this.shipSunVisibility = 1;
      this.shipSunRaycastCount = 0;
      this.clearSunSilhouette();
      if (ghostMat) ghostMat.uniforms.uGhostStrength.value = 0;
      // No limb sits in front of a camera buried in the photosphere; kill the
      // prominence shell's close-up ring so it can't hang as a stale halo.
      if (prominenceMat) prominenceMat.uniforms.uCloseVisibility.value = 0;
      const insideBlend = 1 - Math.exp(-Math.max(dt, 0) / 0.9);
      // At the surface both sides of the crossing are whiteout-pinned to full
      // exposure, so entering the photosphere never steps the scene
      // brightness; the target relaxes toward the ember tier only as the
      // whiteout hands off and the fog itself darkens.
      const insideTarget = THREE.MathUtils.lerp(
        THREE.MathUtils.lerp(1, 0.25, interiorFade), 1, whiteout,
      );
      this.sunExposure = THREE.MathUtils.lerp(this.sunExposure, insideTarget, insideBlend);
      // No glare to obscure anything from inside the photosphere.
      this.deactivateSunGlareMask();
      return;
    }

    toSun.multiplyScalar(1 / sunDistance);
    if (interiorMesh) interiorMesh.visible = false;
    if (sunMat) sunMat.uniforms.uInteriorFade.value = 1;
    // Proximity whiteout: stateless, so teleports land on the correct bleach
    // instantly and only the exposure below glides. View-independent on
    // purpose — at a couple of radii the photosphere floor fills the frame in
    // every direction that isn't open space.
    const whiteout = sunWhiteoutFraction(sunDistance / SUN_DATA.radiusAU);
    if (sunMat) sunMat.uniforms.uWhiteout.value = whiteout;
    this.applySunGlareFlood(whiteout);
    const inFront = toSun.dot(this.camera.getWorldDirection(this.tmpSunCameraForward)) > 0;
    const solarAngularRadius = Math.asin(THREE.MathUtils.clamp(SUN_DATA.radiusAU / sunDistance, 0, 0.999999));
    const viewportWidth = Math.max(this.renderer.domElement.clientWidth, 1);
    const viewportHeight = Math.max(this.renderer.domElement.clientHeight, 1);
    if (glareMat) applyLensShaderUniforms(
      glareMat.uniforms as unknown as LensShaderUniforms,
      this.camera,
      viewportWidth,
      viewportHeight,
      this.renderer.getPixelRatio(),
    );
    if (ghostMat) applyLensShaderUniforms(
      ghostMat.uniforms as unknown as LensShaderUniforms,
      this.camera,
      viewportWidth,
      viewportHeight,
      this.renderer.getPixelRatio(),
    );
    let targetExposure = 1;
    let visibleFraction = 1;
    // Body-only exposed fraction (no ring transmission) — the emergence flash
    // reads this so a soft ring-gap crossing can't strobe it.
    let bodyVisibleFraction = 1;
    let centreDistanceNdc = Infinity;
    let opticalFx = 0;
    let solarRadiusPx = 0;
    let appearanceEligible = false;
    // Veiling-glare amount fed to the wide screen-space wash: occlusion x
    // distance falloff x huge-disc cutoff, 0 unless the wash is actually visible.
    let veilAmt = 0;
    // The wide veil's arm coefficient (0.28 faded out as the disc resolves),
    // held at function scope so the after-exposure support pass and the shader
    // uniform draw with exactly the same value.
    let veilArmCoeff = 0;

    if (inFront) {
      const sunProjection = this.getSunScreenProjection();
      this.tmpSunScreen.set(sunProjection.ndcX, sunProjection.ndcY, sunProjection.ndcZ);
      centreDistanceNdc = Math.hypot(this.tmpSunScreen.x, this.tmpSunScreen.y);
      const glareExtent = SUN_GLARE_EXTENT_SOLAR_RADII;
      solarRadiusPx = sunProjection.radiusPx;
      const projectedRadiusNdc = (solarRadiusPx * 2) / viewportHeight;
      opticalFx = 1 - THREE.MathUtils.smoothstep(solarRadiusPx, 22, 82);
      if (glareMat) {
        glareMat.uniforms.uViewportHeight.value = viewportHeight;
        glareMat.uniforms.uPointLike.value = 1 - THREE.MathUtils.smoothstep(solarRadiusPx, 2, 10);
        glareMat.uniforms.uCameraFx.value = opticalFx;
      }

      // One amplitude driver for the wide veil. The ISS reference stills are at
      // 1 AU, so 1 AU is full strength; a^1.8 makes it fall roughly with the
      // Sun's irradiance, so Jupiter is a compact steep glow and Pluto is back
      // to the bare point-glint rather than a bounded grey fog dome. hugeFade
      // also kills it as the disc grows huge so a full-frame close-up never
      // double-brightens.
      const a = THREE.MathUtils.clamp(solarAngularRadius / SUN_ANG_RADIUS_AT_1AU, 0, 1);
      const veilAmplitudeResponse = Math.pow(a, 1.8);
      // The physical PSF has no distance term of its own: its quad tracks the
      // disc until the minimum-pixel glint floor engages (~1 AU out), after
      // which footprint and energy would stay frozen from Saturn to Pluto.
      // Compress both with the same angular-size ratio the veil falls by, so
      // the outer-system Sun shrinks toward a brilliant star-point instead of
      // holding an Earth-sized blob. Both curves are 1 inside ~5 AU: the
      // Earth/Jupiter looks and every eclipse view keep their exact values.
      if (glareMat) {
        const baseMinHalfPx = (glareMat.userData.baseMinHalfPx ??=
          glareMat.uniforms.uMinHalfSizePx.value);
        const baseStrength = (glareMat.userData.baseGlareStrength ??=
          glareMat.uniforms.uGlareStrength.value);
        const glintFloorScale = THREE.MathUtils.lerp(
          0.46, 1, THREE.MathUtils.smoothstep(a, 0.03, 0.22),
        );
        this.sunGlintFloorScale = glintFloorScale;
        glareMat.uniforms.uMinHalfSizePx.value = baseMinHalfPx * glintFloorScale;
        // Two-stage energy trim. The first stage alone still left the glint's
        // HDR core ~2.4 beyond Uranus; through bloom that painted a wide grey
        // wash over the belt from a Pluto vantage. The second stage bites only
        // past ~12 AU (1 at Saturn's a and inward) and floors the core near
        // ~1.5 — still above the bloom threshold, so the outer-system Sun
        // keeps a star-point blaze without the fog dome.
        const glintEnergyTrim = THREE.MathUtils.lerp(
          0.5, 1, THREE.MathUtils.smoothstep(a, 0.02, 0.15),
        ) * THREE.MathUtils.lerp(
          0.55, 1, THREE.MathUtils.smoothstep(a, 0.012, 0.08),
        );
        glareMat.uniforms.uGlareStrength.value = baseStrength * glintEnergyTrim;
      }
      const hugeFade = 1 - THREE.MathUtils.smoothstep(
        solarRadiusPx, viewportHeight * 0.30, viewportHeight * 0.42,
      );
      const veilReachGeom = veilAmplitudeResponse * hugeFade;
      const veilStrength = glareMat ? glareMat.uniforms.uVeilStrength.value : 1.4;
      // The diffraction arms are a point-source camera artifact, so they fade as
      // the photosphere resolves into a disc — about three-quarters strength at
      // Earth's ~3.8 px solar radius, gone past ~8 px (Mercury sits near 10) —
      // rather than growing with brightness. This stops them reading as
      // ruler-straight exaggerated lines exactly where the Sun is closest.
      const armGate = 1 - THREE.MathUtils.smoothstep(solarRadiusPx, 2, 8);
      veilArmCoeff = 0.28 * armGate;

      // Size the billboard from where the wash and arms fall below the visibility
      // floor rather than from an authored amount. This upper bound (full Sun,
      // full exposure — occlusion and dimming only shrink it) both widens the
      // eligibility gate so the wide wash is never stranded off-screen and,
      // recomputed with the real occlusion after exposure below, sizes the quad.
      this.computeSunVeilSupport(veilReachGeom, veilStrength, 1, viewportHeight, veilArmCoeff);
      const veilHalfNdcMax = (this.sunVeilSupport.halfPx * 2) / viewportHeight;
      if (centreDistanceNdc < 1.5 + projectedRadiusNdc * glareExtent + veilHalfNdcMax) {
        appearanceEligible = true;
        bodyVisibleFraction = this.computeVisibleSunFraction(toSun, sunDistance, solarAngularRadius);
        // Rings are translucent dimmers, not a solid limb. Their transmission
        // dims the disc's brightness (exposure, glare, veil, ghost all read the
        // ring-multiplied fraction below) but is kept out of the emergence flash:
        // a ring edge is spatially near-hard, so a cruise past a gap would step
        // the fraction and strobe a false "clearing" pulse. The flash reads
        // bodyVisibleFraction only.
        visibleFraction = bodyVisibleFraction * this.sunTransmissionThroughRings(toSun, sunDistance);
        this.updateSunAtmosphereGrazing(toSun, sunDistance, solarAngularRadius);
        // Partial-phase metering: any exposed sliver of photosphere still has
        // full solar surface brightness (eclipse photography keeps the same
        // filter on until totality), so the meter reads it like the whole
        // disc instead of opening up as the cover deepens — this is what
        // darkens a deep partial/annular scene and keeps the ring's bloom
        // from flooding the silhouette. Only the last fraction of a percent
        // releases toward the totality corona exposure.
        const meterVis = Math.max(
          visibleFraction,
          THREE.MathUtils.smoothstep(visibleFraction, 0, 0.012),
        );
        targetExposure = targetSunExposure({
          projectedRadiusNdc,
          centerDistanceNdc: centreDistanceNdc,
          visibleFraction: meterVis,
        });
        // The whiteout overrides the close-up study tier: past ~2.6 radii the
        // metering stops winning — adaptation gives up and exposure rides back
        // to full so the slammed photosphere reads as a truly blinding screen.
        targetExposure = THREE.MathUtils.lerp(targetExposure, 1, whiteout);
        // Linear occlusion, deliberately harder than the physical PSF's ^0.38
        // energy: the veil dims in step with the exposed fraction and dies hard
        // in a partial eclipse. 0 fraction collapses the billboard entirely.
        veilAmt = veilReachGeom * THREE.MathUtils.clamp(visibleFraction, 0, 1);
      }
    }

    if (!appearanceEligible) this.sunAtmosphereMix = 0;
    // This frame's occluder geometry, resolved once: the strongest occluder's
    // angular size against the Sun's, whether that size reads as an eclipse at
    // all, and how deeply the disc is covered. The chromosphere shell just
    // below and every eclipse term on the glare plane are driven from these.
    const occluderAngularRadius = this.sunDominantOccluderAngularRadius;
    const occluderToSunRatio = occluderAngularRadius > 0
      ? occluderAngularRadius / solarAngularRadius
      : 0;
    const occluderLikeness = eclipseOccluderLikeness(occluderToSunRatio);
    // Silhouette carve: a body covering the Sun reads as a dark disc through
    // the PSF/veil wash (the shader multiplies those terms down inside it).
    // Driven by body-only coverage — ring dimming must not punch silhouettes.
    // The gate is overlap-exists, not overlap-depth: a new moon biting the Sun
    // is backlit and void-black from first contact, so the carve reaches full
    // strength by ~15% cover — ramping it in over deep coverage instead left the
    // glare painting across the dark disc all through the partial phases, a
    // translucent Moon the light seemed to pass through. Only a grazing sliver
    // keeps the full wash: that bite really is smaller than the saturated core.
    const coverage = 1 - THREE.MathUtils.clamp(bodyVisibleFraction, 0, 1);
    const occluderShade = occluderAngularRadius > 0 && appearanceEligible
      ? THREE.MathUtils.smoothstep(coverage, 0.03, 0.15)
      : 0;
    if (prominenceMat) {
      // The 1.065-radii shell is limb detail for a close approach. An eclipse
      // occluder is only a few percent wider than the photosphere, so at deep
      // zoom the shell pokes out all the way around it — a full pink ring where
      // the sky should be black. Hand the reds to the glare plane's contact
      // chromosphere while such a body is on the disc. A sub-Sun (annular)
      // occluder can never hide the shell, and likeness reads 0 there, so that
      // geometry keeps it.
      prominenceMat.uniforms.uCloseVisibility.value = inFront
        ? THREE.MathUtils.smoothstep(solarRadiusPx, 55, 160)
          * (1 - occluderShade * occluderLikeness)
        : 0;
    }
    // A queued view discontinuity reseeds the baseline with THIS frame's
    // body-only fraction, so the advance below sees previous === current and no
    // artificial rise survives the jump. The stored flash keeps decaying.
    if (this.sunFlashResetPending) {
      this.lastSunVisibleFraction = appearanceEligible ? bodyVisibleFraction : 1;
      this.sunFlashResetPending = false;
    }
    this.sunEmergenceFlash = advanceSunEmergenceFlash({
      previousVisibleFraction: this.lastSunVisibleFraction,
      // Body-only: a flash marks a solid limb clearing, not the soft step of
      // crossing a ring gap (rings live in visibleFraction, for brightness only).
      visibleFraction: bodyVisibleFraction,
      flash: this.sunEmergenceFlash,
      dt,
      eligible: appearanceEligible,
    });
    this.lastSunVisibleFraction = appearanceEligible ? bodyVisibleFraction : 1;

    if (glareMat) {
      glareMat.uniforms.uVisibleFraction.value = visibleFraction;
      glareMat.uniforms.uEmergenceFlash.value = this.sunEmergenceFlash;
      glareMat.uniforms.uAtmosphereMix.value = this.sunAtmosphereMix;
      glareMat.uniforms.uAtmosphereColor.value.copy(this.sunAtmosphereColor);
      // veilAmt is 0 unless the wash is on-screen and unoccluded; the billboard
      // size and arm uniforms are set after exposure below (they need it).
      glareMat.uniforms.uVeilAmt.value = veilAmt;
      // Where the Sun's rotation axis lies across the frame. Decomposed on the
      // camera basis exactly the way the occluder offset is, because the corona
      // measures its angles in that same camera-view XY frame — output pixels
      // would be the wrong space. As the axis turns toward the camera its
      // projection shortens until it names no direction at all; short of that
      // the last good angle is held and the shape relaxes toward isotropic,
      // rather than letting a vanishing vector spin the streamers.
      {
        const e = this.camera.matrixWorld.elements;
        const poleX = SUN_POLE_DIRECTION.x * e[0]
          + SUN_POLE_DIRECTION.y * e[1] + SUN_POLE_DIRECTION.z * e[2];
        const poleY = SUN_POLE_DIRECTION.x * e[4]
          + SUN_POLE_DIRECTION.y * e[5] + SUN_POLE_DIRECTION.z * e[6];
        const acrossFrame = Math.hypot(poleX, poleY);
        if (acrossFrame > 0.05) this.sunPoleScreenAngle = Math.atan2(poleY, poleX);
        glareMat.uniforms.uSunPoleScreenAngle.value = this.sunPoleScreenAngle;
        glareMat.uniforms.uSunPoleAnisotropy.value =
          THREE.MathUtils.smoothstep(acrossFrame, 0.05, 0.25);
      }
      // Corona gate: 1 when the strongest occluder is Sun-sized (a true
      // eclipse), 0 when a whole planet fills the sky in front of the Sun.
      // The occluder's size in solar radii also positions the shader's
      // carve-out of the eclipsing disc, which the silhouette shade above
      // drives, positioned from the occluder's true direction so an off-centre
      // partial carves where the body actually is.
      glareMat.uniforms.uEclipseLike.value = occluderLikeness;
      glareMat.uniforms.uOccluderRadii.value = occluderAngularRadius > 0
        ? THREE.MathUtils.clamp(occluderToSunRatio, 0.5, 3)
        : 1;
      glareMat.uniforms.uOccluderShade.value = occluderShade;
      // The silhouetted body itself also drops its night-side lifts (starlight
      // fill, planetshine): backlit by the photosphere it reads void black —
      // the exposure belongs to the ring or corona behind it. But only when the
      // occluder is eclipse-scale: a body tens of solar diameters wide isn't a
      // backlit silhouette, it's the near landscape at local night, and its
      // night side must keep the fills the dark-adapted eye sees. Gate ONLY the
      // night-lift kill by the RAW occluder/Sun ratio — the glare carve above
      // keeps its ungated value, or the wash repaints across the dark disc (the
      // translucent-Moon artifact). The value smooths through two owner slots so
      // a warp-compressed eclipse never strobes the fills.
      const silhouetteGate = silhouetteSizeGate(occluderToSunRatio);
      this.sunSilhouetteGate = silhouetteGate;
      const silhouetteShade = occluderShade * silhouetteGate;
      const silhouetteSnap = this.sunSilhouetteSnapPending;
      this.sunSilhouetteSnapPending = false;
      this.advanceSunSilhouette(
        silhouetteShade > 0 ? this.sunDominantOccluderFx : null,
        silhouetteShade,
        performance.now(),
        silhouetteSnap,
      );
      // Default to no light shift and no diamond unless an occluder is on the
      // disc this frame. Reset every frame so nothing goes stale — with one
      // exception: while the diamond envelope is still releasing into totality,
      // hold the last contact-point shift. The crescent centroid drops to 0 the
      // frame coverage completes, and re-centring the residual bead would flash
      // a symmetric halo behind the occulted disc; the dazzle must melt where
      // the light died. Every discontinuity snaps the envelope to 0 first, so
      // the latch can never carry a contact point across a jump.
      const holdContactPoint = occluderShade > 0
        && bodyVisibleFraction <= 0
        && this.sunDiamondRing > 0.01
        && !silhouetteSnap;
      if (!holdContactPoint) {
        this.sunCrescentCentroidSr = 0;
        this.sunCrescentDisplacementPx = 0;
      }
      let diamondTarget = 0;
      let chromoAntiTarget = 0;
      let chromoTowardTarget = 0;
      if (occluderShade > 0) {
        // The glare quad billboards in camera-view XY and its fragment
        // measures in solar radii, so the offset is the angular separation
        // decomposed on the camera basis, divided by the Sun's angular radius.
        const e = this.camera.matrixWorld.elements;
        const d = this.tmpSunOccluderDelta
          .copy(this.sunDominantOccluderDirection)
          .sub(toSun);
        const offsetSr = glareMat.uniforms.uOccluderOffsetSr.value;
        offsetSr.set(
          (d.x * e[0] + d.y * e[1] + d.z * e[2]) / solarAngularRadius,
          (d.x * e[4] + d.y * e[5] + d.z * e[6]) / solarAngularRadius,
        );
        // Centre separation in solar radii, from the true angular separation and
        // the RAW occluder/Sun ratio (never the clamped uOccluderRadii). Every
        // occluded frame needs it: the contact latch below freezes the crescent,
        // but where the two limbs stand is what tells the chromosphere whether a
        // contact is happening at all.
        const separationSr = Math.acos(THREE.MathUtils.clamp(
          this.sunDominantOccluderDirection.dot(toSun), -1, 1,
        )) / solarAngularRadius;
        // Two bodies on the disc make one lens centroid meaningless; fade the
        // shift, the diamond, and the contact reds off when a runner-up
        // occluder is non-trivial.
        const guard = 1 - THREE.MathUtils.smoothstep(this.sunSecondOccluderFraction, 0.05, 0.12);
        // Contact reds, one weight per limb. Body-only coverage again: rings
        // dim brightness, they do not change which limb is buried.
        const chromo = chromosphereSideWeights({
          separationSr,
          occluderRadiiSr: occluderToSunRatio,
          visibleFraction: bodyVisibleFraction,
        });
        chromoAntiTarget = chromo.anti * occluderLikeness * guard;
        chromoTowardTarget = chromo.toward * occluderLikeness * guard;
        if (holdContactPoint) {
          // uGlareCentroidSr keeps its last exposed-frame value; only the quad
          // growth needs re-applying, because the base half-size is rewritten
          // every frame. diamondTarget stays 0 — totality earns no bead, this
          // is just the residual melting in place.
          glareMat.uniforms.uMinHalfSizePx.value += this.sunCrescentDisplacementPx;
        } else {
          // The bead's silhouette cut follows the live occluder only while a
          // crescent burns; through the latch it keeps its last exposed-frame
          // value, frozen with the centroid, so the melting bead and the black
          // limb that cuts it fade as one picture at any clock rate.
          (glareMat.uniforms.uDiamondOccluderSr.value as THREE.Vector2).copy(offsetSr);
          // Exposed-crescent centroid on uOccluderOffsetSr's solar-radii
          // camera-basis frame: unit(toward occluder) x centroidSr, and
          // centroidSr is signed negative — away from the occluder, onto the lit
          // limb — so the glare hangs on the exposed crescent, not over the bite.
          visibleCrescentGeometry(separationSr, occluderToSunRatio, this.sunCrescent);
          const centroidSr = this.sunCrescent.centroidSr * guard;
          this.sunCrescentCentroidSr = centroidSr;
          const offsetLen = Math.hypot(offsetSr.x, offsetSr.y);
          if (offsetLen > 1e-6) {
            const scale = centroidSr / offsetLen;
            glareMat.uniforms.uGlareCentroidSr.value.set(offsetSr.x * scale, offsetSr.y * scale);
          } else {
            glareMat.uniforms.uGlareCentroidSr.value.set(0, 0);
          }
          // The quad grows by the centroid displacement so the shifted wash and PSF
          // never clip at the billboard edge.
          this.sunCrescentDisplacementPx = Math.abs(centroidSr) * solarRadiusPx;
          glareMat.uniforms.uMinHalfSizePx.value += this.sunCrescentDisplacementPx;
          // Authored diamond ring: annular gets none, exactly 0 at totality, same
          // guard as the shift. Body-only coverage (rings dim brightness, not the
          // contact topology).
          diamondTarget = diamondRingStrength(occluderLikeness, bodyVisibleFraction) * guard;
        }
      } else {
        glareMat.uniforms.uOccluderOffsetSr.value.set(0, 0);
        glareMat.uniforms.uGlareCentroidSr.value.set(0, 0);
        glareMat.uniforms.uDiamondOccluderSr.value.set(0, 0);
      }
      // The authored strength is a per-frame function of the exposed fraction,
      // and its band is narrow enough that a warped clock steps across the whole
      // of it between two frames. The uniform therefore follows on wall time:
      // the rise and release always take the same real interval, so a fast clock
      // costs the bead amplitude rather than turning it into a one-frame pop. A
      // queued view discontinuity snaps it — a jump has no motion to smooth.
      this.sunDiamondRing = advanceDiamondRing({
        current: this.sunDiamondRing,
        target: diamondTarget,
        dt,
        snap: silhouetteSnap,
      });
      glareMat.uniforms.uDiamondRing.value = this.sunDiamondRing * this.devDiamondScale;
      // The bead's silhouette-cut kill rides its own envelope: shade and
      // likeness are continuous almost everywhere, but likeness has a hard
      // edge at ratio 1 and a residual bead can still be releasing when the
      // geometry crosses it.
      this.sunBeadCarveDepth = advanceDiamondRing({
        current: this.sunBeadCarveDepth,
        target: 0.99 * occluderShade * occluderLikeness,
        dt,
        snap: silhouetteSnap,
        releaseTau: 0.2,
      });
      glareMat.uniforms.uBeadCarveDepth.value = this.sunBeadCarveDepth;
      // The contact reds have the same problem and take the same treatment, on
      // their own slower constants: the arc lights as the limb breaks and holds
      // a beat after it closes.
      this.sunChromoAnti = advanceDiamondRing({
        current: this.sunChromoAnti,
        target: chromoAntiTarget,
        dt,
        snap: silhouetteSnap,
        attackTau: CHROMOSPHERE_ATTACK_TAU_S,
        releaseTau: CHROMOSPHERE_RELEASE_TAU_S,
      });
      this.sunChromoToward = advanceDiamondRing({
        current: this.sunChromoToward,
        target: chromoTowardTarget,
        dt,
        snap: silhouetteSnap,
        attackTau: CHROMOSPHERE_ATTACK_TAU_S,
        releaseTau: CHROMOSPHERE_RELEASE_TAU_S,
      });
      glareMat.uniforms.uChromoAnti.value = this.sunChromoAnti;
      glareMat.uniforms.uChromoToward.value = this.sunChromoToward;
    }

    // Eyes/cameras clamp down quickly on a bright source and recover more
    // slowly into darkness. Exponential smoothing is frame-rate independent.
    const tau = targetExposure < this.sunExposure ? 0.12 : 0.9;
    const blend = 1 - Math.exp(-Math.max(dt, 0) / tau);
    this.sunExposure = THREE.MathUtils.lerp(this.sunExposure, targetExposure, blend);
    const exposureScale = Math.sqrt(this.sunExposure);
    if (sunMat) {
      sunMat.uniforms.uAtmosphereMix.value = this.sunAtmosphereMix;
      sunMat.uniforms.uAtmosphereColor.value.copy(this.sunAtmosphereColor);
    }
    // Sample after the camera-safety and chase passes have finalised the frame's
    // pose. Keep this render-only source transmission entirely separate from
    // the celestial visibility/exposure/flash state resolved above.
    // While the map owns the frame the world composer never draws, so the
    // hull traversal + disc raycasts (a sustained cost on sunward legs, where
    // the overlap gate stays open) would feed nothing — hold the last value;
    // the probe re-runs in update() before the first world render after close.
    if (!this.isMapOpen()) {
      this.shipSunVisibility = this.computeShipSunVisibility(
        toSun,
        sunDistance,
        solarAngularRadius,
        inFront && appearanceEligible,
      );
    }
    if (glareMat) {
      glareMat.uniforms.uShipSunVisibility.value = this.shipSunVisibility;
    }
    const effectiveVeilAmt = veilAmt * this.shipSunVisibility;
    // The arm terms the glare draws with this frame; mirrored into the mask so
    // the fade uses exactly the profile on screen. 0 whenever the wash is off.
    let maskArmCoeff = 0;
    let maskArmDecayPx = 0;
    let maskArmDecayYPx = 0;
    if (glareMat) {
      glareMat.uniforms.uExposureScale.value = exposureScale;
      // Now that occlusion and exposure are both known, size the billboard to
      // where the wash and arms actually fade out and hand the shader the exact
      // arm decay lengths used to size it — the quad always contains the arms it
      // draws. 0 amount (off-screen, occluded, in totality) collapses it all.
      if (appearanceEligible && effectiveVeilAmt > 0) {
        this.computeSunVeilSupport(
          effectiveVeilAmt,
          glareMat.uniforms.uVeilStrength.value,
          exposureScale,
          viewportHeight,
          veilArmCoeff,
        );
        // Grow the veil billboard by the centroid displacement so the wash
        // shifted onto the exposed crescent never clips at the quad edge.
        glareMat.uniforms.uVeilHalfPx.value = this.sunVeilSupport.halfPx + this.sunCrescentDisplacementPx;
        glareMat.uniforms.uArmDecayPx.value = this.sunVeilSupport.armDecayPx;
        glareMat.uniforms.uArmDecayYPx.value = this.sunVeilSupport.armDecayYPx;
        glareMat.uniforms.uArmCoeff.value = veilArmCoeff;
        maskArmCoeff = veilArmCoeff;
        maskArmDecayPx = this.sunVeilSupport.armDecayPx;
        maskArmDecayYPx = this.sunVeilSupport.armDecayYPx;
      } else {
        glareMat.uniforms.uVeilHalfPx.value = 0;
        glareMat.uniforms.uArmDecayPx.value = 0;
        glareMat.uniforms.uArmDecayYPx.value = 0;
        glareMat.uniforms.uArmCoeff.value = 0;
      }
    }
    if (ghostMat) {
      const offAxis = THREE.MathUtils.smoothstep(centreDistanceNdc, 0.12, 0.55);
      const edgeFade = 1 - THREE.MathUtils.smoothstep(centreDistanceNdc, 1.02, 1.45);
      const visibleEnergy = Math.pow(THREE.MathUtils.clamp(visibleFraction, 0, 1), 0.5);
      const shipEnergy = Math.pow(this.shipSunVisibility, 0.5);
      ghostMat.uniforms.uSunNdc.value.set(this.tmpSunScreen.x, this.tmpSunScreen.y);
      ghostMat.uniforms.uViewportPx.value.set(viewportWidth, viewportHeight);
      ghostMat.uniforms.uGhostStrength.value = appearanceEligible
        ? opticalFx * offAxis * edgeFade * visibleEnergy * shipEnergy * 0.05
        : 0;
      ghostMat.uniforms.uExposureScale.value = exposureScale;
      ghostMat.uniforms.uEmergenceFlash.value = this.sunEmergenceFlash;
      ghostMat.uniforms.uAtmosphereMix.value = this.sunAtmosphereMix;
      ghostMat.uniforms.uAtmosphereColor.value.copy(this.sunAtmosphereColor);
    }

    // Fill the persistent glare-mask params from this frame's finalised
    // exposure/occlusion, then push them into the point consumers (stars, belt).
    // The label overlays run earlier in the frame, so they read this object one
    // frame late — imperceptible for a fade. peak is the shader's veilEnergy
    // without the flash/atmosphere terms; it is 0 whenever the wash is idle or
    // occluded, leaving only the geometric core to obscure the bare glint.
    const maskParams = this.sunGlareMaskParams;
    maskParams.active = inFront && appearanceEligible;
    // The wash mask must sit on the wash it fades against, so when the glare
    // re-centres on the crescent the mask follows — through the lens seam, not by
    // adding px in output space. Tilt toSun by the centroid angle toward the
    // exposed side and project that point on the Sun's sphere; the geometric core
    // still covers the whole disc, so this only moves the wash centre.
    let maskCentred = false;
    if (this.sunCrescentCentroidSr !== 0 && appearanceEligible) {
      const dir = this.sunDominantOccluderDirection;
      const along = dir.dot(toSun);
      const tangent = this.tmpCrescentTangent.copy(dir).addScaledVector(toSun, -along);
      const tangentLen = tangent.length();
      if (tangentLen > 1e-6) {
        tangent.multiplyScalar(1 / tangentLen);
        const centroidDir = this.tmpCrescentDir.copy(toSun)
          .addScaledVector(tangent, Math.tan(this.sunCrescentCentroidSr * solarAngularRadius))
          .normalize();
        const point = this.tmpCrescentPoint.copy(this.camera.position)
          .addScaledVector(centroidDir, sunDistance);
        const proj = projectToScreen(point, this.camera, viewportWidth, viewportHeight, this.tmpCrescentProj);
        maskParams.sunXPx = proj.x;
        maskParams.sunYPx = proj.y;
        maskCentred = true;
      }
    }
    if (!maskCentred) {
      maskParams.sunXPx = (this.tmpSunScreen.x * 0.5 + 0.5) * viewportWidth;
      maskParams.sunYPx = (-this.tmpSunScreen.y * 0.5 + 0.5) * viewportHeight;
    }
    const veilStrengthNow = glareMat ? glareMat.uniforms.uVeilStrength.value : 1.4;
    maskParams.peak = veilStrengthNow * veilAmt * exposureScale;
    maskParams.transmission = this.shipSunVisibility;
    maskParams.armCoeff = maskArmCoeff;
    maskParams.armDecayPx = maskArmDecayPx;
    maskParams.armDecayYPx = maskArmDecayYPx;
    // The core's floor tracks the glint's actual drawn footprint (the same
    // scale that shrinks uMinHalfSizePx): a fixed 30 px floor culled belt
    // dots out to ~4× the outer-system glint's radius — from Pluto, a dot-free
    // circle far wider than the glow it protects. The core scales with the
    // body-only exposed fraction (ring transmission dims brightness but a
    // ring-dimmed Sun still shows a blazing disc), so a covered Sun stops
    // erasing the sky and stars appear beside the corona at totality.
    const glintFloorPx = (this.useBloom ? 30 : 22) * this.sunGlintFloorScale;
    // A 'covering' Sun footprint is hypot(w,h) — a conservative guess, not a
    // measurement (a rim ray crossed the camera plane while the disc still
    // intersected the frustum). Building a core from that giant radius is how the
    // off-frame Sun erased the sky, so keep only the honest glint floor here; the
    // activation gate below then also refuses to activate on a covering footprint.
    // Read the Sun's OWN projection: the shared scratch has been overwritten
    // by moon/ship measurements since the Sun was measured this frame.
    const sunFootprintKind = inFront ? this.getSunScreenProjection().footprintKind : 'none';
    maskParams.coreOuterPx = sunFootprintKind === 'covering'
      ? glintFloorPx
      : sunGlareMaskCoreOuterPx(solarRadiusPx, glintFloorPx, bodyVisibleFraction);
    maskParams.viewportHeight = viewportHeight;
    // The mask can obscure nothing when its support disc sits wholly off-frame,
    // and a covering footprint must never activate it (see above). sunVeilSupport
    // holds the real wash reach only when the veil is live; it is stale scratch
    // otherwise, so pass 0 in that case rather than a bogus reach.
    const washSupportPx = effectiveVeilAmt > 0 ? this.sunVeilSupport.halfPx : 0;
    const activationInput = this.sunGlareMaskActivationInput;
    activationInput.sunFootprintKind = sunFootprintKind;
    activationInput.sunXPx = maskParams.sunXPx;
    activationInput.sunYPx = maskParams.sunYPx;
    activationInput.coreOuterPx = maskParams.coreOuterPx;
    activationInput.washSupportPx = washSupportPx;
    activationInput.viewportWidth = viewportWidth;
    activationInput.viewportHeight = viewportHeight;
    maskParams.active = maskParams.active
      && this.shipSunVisibility > 0
      && sunGlareMaskActivation(activationInput);
    this.applySunGlareMaskToPoints(viewportWidth);
  }

  /** Warm and attenuate sunlight whose camera ray grazes a rendered atmosphere.
   *  `solarAngularRadius` bounds the tint by the occluder's apparent size — a
   *  distant planet whose limb the sightline threads can only colour the sliver
   *  of the Sun its disc actually spans. */
  private updateSunAtmosphereGrazing(
    sunDirection: THREE.Vector3,
    sunDistance: number,
    solarAngularRadius: number,
  ): void {
    this.sunAtmosphereMix = 0;
    for (const planet of this.solarSystem?.planets ?? []) {
      const config = ATMOSPHERES[planet.data.name];
      if (!config || !planet.mesh.visible) continue;

      planet.mesh.getWorldPosition(this.tmpSunOccluderPosition);
      const offset = this.tmpSunAtmosphereOffset
        .copy(this.tmpSunOccluderPosition)
        .sub(this.camera.position);
      const planeDistance = offset.dot(sunDirection);
      if (!(planeDistance > 0) || planeDistance >= sunDistance) continue;

      const closestDistance = Math.sqrt(Math.max(0, offset.lengthSq() - planeDistance * planeDistance));
      planet.mesh.getWorldScale(this.tmpSunOccluderScale);
      const solidRadius = planet.data.radiusAU * Math.max(
        Math.abs(this.tmpSunOccluderScale.x),
        Math.abs(this.tmpSunOccluderScale.y),
        Math.abs(this.tmpSunOccluderScale.z),
      );
      const shellRadius = solidRadius * config.scale;
      const solarBand = projectedSourceRadiusAtPlane(
        SUN_DATA.radiusAU,
        sunDistance,
        planeDistance,
      );
      const inner = Math.max(0, solidRadius - solarBand);
      const outer = shellRadius + solarBand;
      if (closestDistance <= inner || closestDistance >= outer) continue;

      const geometricStrength = closestDistance < solidRadius
        ? THREE.MathUtils.smoothstep(closestDistance, inner, solidRadius)
        : 1 - THREE.MathUtils.smoothstep(closestDistance, solidRadius, outer);
      // How much of the solar disc this occluder can actually cover: a speck of a
      // planet transiting from far away spans a hair of the Sun and barely warms
      // it, while a looming planet spans the whole disc and floods it at full
      // strength. offset.length() is the camera→planet-centre distance already in
      // hand (no new allocation).
      const occluderAngularRadius = Math.asin(THREE.MathUtils.clamp(shellRadius / offset.length(), 0, 1));
      const angularCoverage = THREE.MathUtils.clamp(occluderAngularRadius / solarAngularRadius, 0, 1);
      const strength = geometricStrength
        * THREE.MathUtils.clamp(0.62 + config.intensity * 0.55, 0, 1)
        * angularCoverage;
      if (strength <= this.sunAtmosphereMix) continue;
      this.sunAtmosphereMix = strength;
      this.sunAtmosphereColor.setRGB(...config.sunsetColor);
    }
  }

  /** Render-truth solar visibility from the angular overlap of drawn bodies.
   *  Occluders multiply as if independent: two bodies overlapping each other
   *  on the disc double-count their shared area (true union math costs far
   *  more than this is worth). The corona additionally needs a Sun-sized
   *  dominant occluder, which keeps that overstatement from faking totality.
   *  Side effect: `sunDominantOccluderAngularRadius` / `Direction` / `Fx` /
   *  `Mesh` hold the dominant occluder (0/null when nothing occludes), chosen
   *  with cross-frame ownership hysteresis so a conjunct pair doesn't flicker —
   *  the corona gate uses the radius to tell an eclipsing moon from a planet
   *  blotting out the sky. */
  private computeVisibleSunFraction(
    sunDirection: THREE.Vector3,
    sunDistance: number,
    sunAngularRadius: number,
  ): number {
    let visible = 1;

    // Ownership hysteresis: keep the incumbent dominant occluder unless a
    // challenger clearly wins, so a conjunct pair trading the lead frame to
    // frame doesn't flip the carve position and silhouette owner. considerSunOccluder
    // tracks the strongest challenger, the second-strongest, and the incumbent's
    // current occlusion together — each with its angular radius / direction / fx —
    // in one pass, then commitDominantSunOccluder decides. The scan state lives in
    // instance scratch so this hot per-frame path never allocates.
    this.sunOccBestOcclusion = 0;
    this.sunOccSecondOcclusion = 0;
    this.sunOccBestMesh = null;
    this.sunOccBestAngularRadius = 0;
    this.sunOccBestFx = null;
    this.sunOccIncumbentMesh = this.sunDominantOccluderMesh;
    this.sunOccIncumbentOcclusion = 0;
    this.sunOccIncumbentAngularRadius = 0;
    this.sunOccIncumbentFx = null;

    for (const planet of this.solarSystem?.planets ?? []) {
      visible *= 1 - this.considerSunOccluder(planet.mesh, planet.fx ?? null, sunDirection, sunDistance, sunAngularRadius);
      if (visible < 1e-4) {
        this.commitDominantSunOccluder();
        return 0;
      }
    }
    for (const moons of this.planetMoons.values()) {
      for (const moon of moons) {
        visible *= 1 - this.considerSunOccluder(moon.mesh, moon.fx ?? null, sunDirection, sunDistance, sunAngularRadius);
        if (visible < 1e-4) {
          this.commitDominantSunOccluder();
          return 0;
        }
      }
    }
    this.commitDominantSunOccluder();
    return THREE.MathUtils.clamp(visible, 0, 1);
  }

  /** One occluder's contribution to computeVisibleSunFraction's scan. Returns its
   *  occlusion of the Sun and folds it into the best / second / incumbent instance
   *  scratch. sunOcclusionByMesh leaves this mesh's angular radius + unit direction
   *  in the scratch; both are snapshotted before the next call overwrites them. */
  private considerSunOccluder(
    mesh: THREE.Mesh,
    fx: SurfaceShadingFx | null,
    sunDirection: THREE.Vector3,
    sunDistance: number,
    sunAngularRadius: number,
  ): number {
    const occlusion = this.sunOcclusionByMesh(mesh, sunDirection, sunDistance, sunAngularRadius);
    if (occlusion <= 0) return occlusion;
    if (occlusion > this.sunOccBestOcclusion) {
      this.sunOccSecondOcclusion = this.sunOccBestOcclusion;
      this.sunOccBestOcclusion = occlusion;
      this.sunOccBestMesh = mesh;
      this.sunOccBestAngularRadius = this.lastSunOccluderAngularRadius;
      this.sunOccBestFx = fx;
      this.tmpBestOccluderDirection.copy(this.tmpSunOccluderDirection);
    } else if (occlusion > this.sunOccSecondOcclusion) {
      this.sunOccSecondOcclusion = occlusion;
    }
    if (mesh === this.sunOccIncumbentMesh) {
      this.sunOccIncumbentOcclusion = occlusion;
      this.sunOccIncumbentAngularRadius = this.lastSunOccluderAngularRadius;
      this.sunOccIncumbentFx = fx;
      this.tmpIncumbentOccluderDirection.copy(this.tmpSunOccluderDirection);
    }
    return occlusion;
  }

  /** Resolve the scan's best / incumbent scratch into this frame's dominant
   *  occluder. Transfer dominance only when the challenger's coverage exceeds the
   *  incumbent's by more than 15%, or the incumbent has all but cleared the Sun
   *  (< 1% cover). Otherwise the incumbent holds — including through a frame where
   *  it briefly trails a near-equal neighbour. Also publishes the second-strongest
   *  single-body occlusion: two bodies on the disc make the single-lens crescent
   *  centroid a lie, so a strong runner-up gates the centroid shift off. */
  private commitDominantSunOccluder(): void {
    this.sunSecondOccluderFraction = this.sunOccSecondOcclusion;
    const incumbentMesh = this.sunOccIncumbentMesh;
    const keepIncumbent =
      incumbentMesh !== null &&
      this.sunOccIncumbentOcclusion >= 0.01 &&
      this.sunOccBestOcclusion <= this.sunOccIncumbentOcclusion * 1.15;
    if (keepIncumbent) {
      this.sunDominantOccluderMesh = incumbentMesh;
      this.sunDominantOccluderAngularRadius = this.sunOccIncumbentAngularRadius;
      this.sunDominantOccluderFx = this.sunOccIncumbentFx;
      this.sunDominantOccluderDirection.copy(this.tmpIncumbentOccluderDirection);
    } else if (this.sunOccBestMesh !== null) {
      this.sunDominantOccluderMesh = this.sunOccBestMesh;
      this.sunDominantOccluderAngularRadius = this.sunOccBestAngularRadius;
      this.sunDominantOccluderFx = this.sunOccBestFx;
      this.sunDominantOccluderDirection.copy(this.tmpBestOccluderDirection);
    } else {
      this.sunDominantOccluderMesh = null;
      this.sunDominantOccluderAngularRadius = 0;
      this.sunDominantOccluderFx = null;
    }
  }

  /** Fraction of sunlight that survives ring crossings on the camera→Sun
   *  sightline (1 = clear). Rings have no collision or depth presence for the
   *  screen-space glare, so this is what dims a Sun setting behind them. */
  private sunTransmissionThroughRings(sunDirection: THREE.Vector3, sunDistance: number): number {
    let transmission = 1;
    for (const planet of this.solarSystem?.planets ?? []) {
      const rings = planet.rings;
      const cfg = RING_CONFIGS[planet.data.name];
      if (!rings || !rings.visible || !cfg) continue;
      rings.getWorldPosition(this.tmpSunOccluderPosition);
      const e = rings.matrixWorld.elements;
      // Ring geometry lies in its local XY plane; world normal = basis Z.
      const normal = this.tmpRingNormal.set(e[8], e[9], e[10]).normalize();
      const denom = normal.dot(sunDirection);
      if (Math.abs(denom) < 1e-9) continue;
      const t = normal.dot(this.tmpRingHit.copy(this.tmpSunOccluderPosition).sub(this.camera.position)) / denom;
      if (!(t > 0) || t >= sunDistance) continue;
      const hit = this.tmpRingHit.copy(sunDirection).multiplyScalar(t).add(this.camera.position);
      const radial = hit.sub(this.tmpSunOccluderPosition).length();
      const inner = planet.data.radiusAU * cfg.innerFactor;
      const outer = planet.data.radiusAU * cfg.outerFactor;
      // Penumbral softening: the Sun's disc projected onto the ring plane.
      const band = Math.max(
        projectedSourceRadiusAtPlane(SUN_DATA.radiusAU, sunDistance, t),
        1e-7,
      );
      const enter = THREE.MathUtils.smoothstep(radial, inner - band, inner + band);
      const exit = 1 - THREE.MathUtils.smoothstep(radial, outer - band, outer + band);
      const inside = enter * exit;
      const styleTransmission = RING_GLARE_TRANSMISSION[cfg.style] ?? 0.85;
      transmission *= 1 - inside * (1 - styleTransmission);
    }
    return transmission;
  }

  private sunOcclusionByMesh(
    mesh: THREE.Mesh,
    sunDirection: THREE.Vector3,
    sunDistance: number,
    sunAngularRadius: number,
  ): number {
    if (!mesh.visible) return 0;

    mesh.getWorldPosition(this.tmpSunOccluderPosition);
    const bodyDirection = this.tmpSunOccluderDirection
      .copy(this.tmpSunOccluderPosition)
      .sub(this.camera.position);
    const bodyDistance = bodyDirection.length();
    if (!(bodyDistance > 0) || bodyDistance >= sunDistance) return 0;

    const geometry = mesh.geometry;
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    const localRadius = geometry.boundingSphere?.radius ?? 0;
    mesh.getWorldScale(this.tmpSunOccluderScale);
    const renderedRadius = localRadius * Math.max(
      Math.abs(this.tmpSunOccluderScale.x),
      Math.abs(this.tmpSunOccluderScale.y),
      Math.abs(this.tmpSunOccluderScale.z),
    );
    if (!(renderedRadius > 0)) return 0;

    bodyDirection.multiplyScalar(1 / bodyDistance);
    const separation = Math.acos(THREE.MathUtils.clamp(bodyDirection.dot(sunDirection), -1, 1));
    const angularRadius = Math.asin(THREE.MathUtils.clamp(renderedRadius / bodyDistance, 0, 0.999999));
    this.lastSunOccluderAngularRadius = angularRadius;
    return circleOcclusionFraction(sunAngularRadius, angularRadius, separation);
  }

  /**
   * The exposure main.ts (the sole renderer.toneMappingExposure writer) should
   * apply this frame. The value is sunExposure, already smoothed inside
   * updateSunShader — the asymmetric clamp/recover glide, the interior-dive
   * tier, and the discontinuity handling all live there, coherent with the
   * glare/veil uniforms derived from the same number — so `snap` is always
   * true: the loop must land on it verbatim, never re-glide it.
   */
  takeExposureTarget(): { value: number; snap: boolean } {
    return { value: this.sunExposure, snap: true };
  }

  private updateOrbitLineVisibility() {
    if (!this.solarSystem) return;
    // Surface view shows the sky, not the scene furniture — a planet's orbit
    // line crossing the ecliptic would streak straight through the eclipse.
    // The "Orbit lines" setting hides the same furniture everywhere else.
    const hideAll = this.landedView === 'surface' || !this.showOrbitLines;
    // The asteroid belt is scene furniture too: its particles aren't
    // photometric (a real belt asteroid sits far below naked-eye), so on the
    // eclipse-dimmed surface sky they were the only "stars" that survived the
    // exposure — a false string of dots along the ecliptic.
    this.solarSystem.asteroidBelt.visible = this.landedView !== 'surface';
    const playerSunDistAU = this.player.getDistanceFromSun();
    // Scene coords: the Sun sits at -player (floating origin), both call sites
    // run after applyFloatingOrigin and the camera pose, so this is fresh.
    const cameraSunDistAU = this.camera.position.distanceTo(this.solarSystem.sun.position);
    for (let i = 0; i < this.solarSystem.orbitLines.length; i++) {
      const orbit = this.solarSystem.orbitLines[i];
      orbit.visible = !hideAll;
      if (hideAll) continue;
      const body = PLANETARIUM_BODIES[i];
      (orbit.material as LineMaterial).opacity = orbitLineOpacity(
        playerSunDistAU,
        cameraSunDistAU,
        body.semiMajorAxisAU,
      );
    }
    if (!hideAll) {
      // One shared uniform block for all nine lines' width pre-distortion
      // (material.resolution itself is refreshed by LineSegments2 per draw).
      applyLensShaderUniforms(
        this.solarSystem.orbitLensUniforms,
        this.camera,
        this.renderer.domElement.clientWidth,
        this.renderer.domElement.clientHeight,
      );
    }
  }

  private processInput() {
    if (this.landedOn) return;
    // The map is a clock instrument, not a cockpit: while it owns the frame,
    // no key/touch/gyro steers the coasting ship and the throttle is inert.
    // A held ship (paused clock) is inert the same way — and the key set
    // keeps tracking the physical keys through both, so what resumes on
    // unpause is exactly what the hands are doing at that moment.
    if (this.isMapOpen() || this.player.held) {
      this.player.yawInput = 0;
      this.player.pitchInput = 0;
      return;
    }
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

    // Throttle (keyboard)
    const throttle =
      (this.keys.has('w') ? 1 : 0) -
      (this.keys.has('s') ? 1 : 0);

    const steering = yaw !== 0 || pitch !== 0;
    const hasManualInput = steering || throttle !== 0;

    // The arrival look is cinematic assistance, never a control lock. Any
    // explicit flight input hands the camera back to the pilot — eased over
    // MOON_ARRIVAL_RELEASE_S rather than in one frame: on the touch flight
    // zone a stationary tap is already full steering, and the instant cancel
    // read as the camera snapping on the first touch after a teleport.
    if (hasManualInput) releaseArrivalLook(this.cruiseAim);

    // Flying reacquires the chase camera — but an actively held drag outranks
    // steering (a hand on the orbit and a finger on W: the drag wins until
    // released), so this fires edge-triggered only when the user is not
    // physically dragging.
    if (this.camOwner === 'orbit' && hasManualInput && !this.orbitDragging) {
      flushOrbitDamping(this.controls);
      this.camOwner = 'reacquiring';
    }

    // Manual STEERING disengages autopilot — taking the stick means flying
    // yourself. The throttle stays a free axis: cranking a slow cruise up (or
    // braking one) is speed control on a flight the ship is still aiming, the
    // same split the steering gate in update() makes when it lets autopilot
    // steer only while yaw/pitch are idle. Disengaging on W was how a 20c
    // hurry-up quietly went ballistic and sailed past its destination with
    // nothing left to park the ship.
    if (this.autopilot && steering) {
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

  /** True when a Space keypress landed on a focused button / role=button, which
   *  the browser activates natively — global Space verbs must yield to it. */
  private isSpaceOnControl(e: KeyboardEvent): boolean {
    return e.key === ' ' && !!(e.target as HTMLElement).closest?.('button, [role="button"]');
  }

  private handleKeyDown(e: KeyboardEvent) {
    if (!this.active) return;
    // The rail/clock widgets preventDefault the keys they handle — a handled
    // key must not also steer the ship or toggle thrust here.
    if (e.defaultPrevented) return;

    // The saved-journey resume prompt is a full-screen modal that owns the
    // keyboard while it's up: no shortcut — not the Esc cascade, not T/O/P, the
    // time keys, or Space — may act on the scene behind it (T otherwise opens
    // the deck under the prompt and Enter commits a real teleport). It resolves
    // only through its own on-screen buttons.
    if (this.resumePrompt.isVisible()) return;

    // Escape always works — even while typing in the deck search
    if (e.key === 'Escape') {
      // One physical press, one rung. A held Esc auto-repeats about thirty
      // times a second while every rung below takes a beat to play out — the
      // map's release flight alone runs most of a second — so repeats would
      // machine-gun down the cascade, shutting the map and then walking out of
      // surface view, the panel and the landing from a single press. No rung
      // here wants a repeat: each one is a discrete dismissal.
      if (e.repeat) return;
      // The arrival veil's contract is that nothing half-loaded may be
      // interacted with — it blocks pointers by construction, but the
      // keyboard arrives here, and an Esc inside the covered hold would walk
      // the cascade to exitLandedMode(): a takeoff fired under an opaque
      // veil, "Departing" toast and all. Swallow the press for the ~1 s the
      // veil owns the screen; the ceremony ends with everything dismissable.
      if (this.arrivalVeilUp()) return;
      if (this.isHelpOpen()) { this.hideHelp(); return; }
      // One Esc, one meaning while tutorialing: end the tutorial. Above the deck rung
      // on purpose — during the deck theater the open deck is tutorial-owned, and
      // closing just it would leave the pending commit to teleport anyway.
      if (this.tutorial) { this.stopTutorial({ restore: true, toast: 'skip' }); return; }
      // Tools is a transient popover — above the deck rung (the ☰ menu is
      // deliberately NOT in the cascade; Tools is).
      if (this.isToolsMenuOpen()) { this.closeToolsMenu(); return; }
      if (this.isDeckOpen()) { this.closeDeck(); return; }
      if (this.bottomBar.isTimeOpen()) { this.bottomBar.closeTime(); return; }
      if (this.bottomBar.isStatsOpen()) { this.bottomBar.closeStats(); return; }
      // Map micro-rungs, above the map rung: Esc gives back a standing
      // teleport offer; then Esc mid-dive cancels the dive (map stays open);
      // then Esc closes the gesture guide; then Esc dismisses the
      // picked-body card; then Esc releases a focus back to the overview; then
      // Esc folds the panel away; then Esc over the map drops back into the
      // ship. Each rung produces a visible change, in that order. The chip rung
      // asks whether an offer STANDS, on-screen or not: a chip the camera swung
      // off the frame keeps its offer, and an Esc that skipped it would let
      // that stale offer resurface later — the one press this cascade spends
      // invisibly is cheaper than that. Help sits above the release-swallow
      // rung below, or an Esc with the grid open during a release flight would
      // be eaten by the flight.
      //
      // One rung is not in this list and cannot be: a focused search field
      // takes Esc on its own element, before the window ever hears it. That is
      // DOM mechanics rather than a rung — the field clears its query, or gives
      // the keyboard back, and the cascade below resumes from the next press.
      if (this.mapTpPoint) { this.dismissMapTeleportChip(); return; }
      if (this.isMapOpen() && this.mapDiving) { this.cancelMapDive(); return; }
      if (this.isMapOpen() && this.mapHelpOpen) { this.setMapHelpOpen(false); return; }
      if (this.mapHud.isCardOpen()) { this.dismissMapCard(); return; }
      if (this.isMapOpen() && this.mapFocusActive()) { this.releaseMapFocus(); return; }
      // A release already flying IS the answer to Esc. Swallow the key rather
      // than letting an impatient second press fall through and shut the map.
      if (this.isMapOpen() && this.isMapReleasing()) return;
      // Esc is a dismissal, not a layout choice: the panel folds away without
      // banking the preference, so the next map still opens with it standing.
      if (this.isMapOpen() && !this.mapPanelCollapsed) {
        this.setMapPanelCollapsed(true, { bank: false });
        return;
      }
      if (this.isMapOpen()) { this.closeMap(); return; }
      if (this.surfaceTargetMenu.isOpen()) { this.closeSurfaceTargetMenu(); return; }
      if (this.landedView === 'surface') { this.exitSurfaceView(); return; }
      if (this.observatoryPanel.isOpen()) { this.closeObservatoryPanel(); return; }
      if (this.landedOn) { this.exitLandedMode(); return; }
    }

    // The same veil contract holds for every verb below the Esc rung: the
    // veil element blocks pointers by construction, but the keyboard lands
    // here — T would open the deck invisibly UNDER the cover (deck z-index
    // sits below the veil's), O would override the arrival's own land-open
    // decision, Space would silently invert an arrival's authored park/glide
    // state, and the time keys would warp the clock in the middle of the
    // ceremony. Swallow them all; the ceremony ends with every verb live.
    if (this.arrivalVeilUp()) return;

    // A second Enter while the map camera dives skips the ease and blacks out.
    if (this.isMapOpen() && this.mapDiving && e.key === 'Enter'
      && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      this.skipMapDive();
      return;
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
      // Space on a focused deck control (tab, close, preference switch) must
      // activate it natively — the printable-key branch below would otherwise
      // count Space as text and yank focus to the search box instead.
      if (this.isSpaceOnControl(e)) return;
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

    // M toggles the system map — everywhere outside a mission, the help modal,
    // a running tutorial, the ☰ menu, or an in-flight arrival (a dropped
    // commit would end the ceremony over the origin scene). M while the deck is
    // open types into its search — the deck-open branch above already returned.
    if (key === 'm' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (
        this.isMissionActive() ||
        this.isHelpOpen() ||
        this.isTutorialActive() ||
        this.menuPanel.isOpen() ||
        this.arrivalInFlight ||
        // A committed dive is running: closing the map now would silently drop
        // the queued journey. Esc is the deliberate cancel.
        this.mapDiving
      ) {
        return;
      }
      e.preventDefault();
      // A held M auto-repeats; without this it would flap the map open/closed.
      if (e.repeat) return;
      if (this.isMapOpen()) this.closeMap();
      else this.openMap();
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
    const spaceOnControl = this.isSpaceOnControl(e);

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

    // The map is a clock instrument, not a cockpit: don't accumulate flight
    // keys while it owns the frame, or a key still held at close resumes as
    // phantom thrust the instant processInput reads the set again.
    if (!this.isMapOpen()) this.keys.add(e.key.toLowerCase());

    // Space toggles pause
    if (e.key === ' ' && !spaceOnControl) {
      e.preventDefault();
      // Over the map, Space pauses the clock (the map is a clock instrument);
      // ordinary cruise keeps Space on ship thrust. Key auto-repeat must not
      // re-fire either toggle while the key is held.
      if (e.repeat) return;
      if (this.isMapOpen()) this.timeTogglePause();
      // A paused clock holds the ship; a thrust toggle banked invisibly
      // under the freeze would fire as surprise thrust (or a mystery park)
      // on unpause — Space goes inert instead of latching.
      else if (!this.timeState.paused) this.player.moving = !this.player.moving;
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
      const pos = planet.worldPosAU;
      if (!pos) continue;
      const dx = this.player.posX - pos.x;
      const dy = this.player.posY - pos.y;
      const dz = this.player.posZ - pos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      const visitDist = Math.max(
        planet.data.radiusAU * 10,
        this.getPlanetCollisionRadius(planet.data.name, planet.data.radiusAU, planet.group.scale.x) * 1.02,
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
      const wp = planet.worldPosAU;
      if (!wp) continue;
      const dx = this.player.posX - wp.x;
      const dy = this.player.posY - wp.y;
      const dz = this.player.posZ - wp.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const threshold = this.getPlanetCollisionRadius(planet.data.name, planet.data.radiusAU, planet.group.scale.x) * 2;
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
        // The moon pass just wrote this frame's world position — reuse it
        // rather than re-propagating the ephemeris at the same instant. A
        // stale/absent entry means the moon isn't shown (unpainted first
        // frame in a system): nothing to land on yet, skip it.
        const mp = this.moonWorldPositions.get(m.data.name);
        if (!mp || this.moonVelPassIndex - mp.pass > 1) continue;
        const mdx = this.player.posX - mp.x;
        const mdy = this.player.posY - mp.y;
        const mdz = this.player.posZ - mp.z;
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
    if (nameEl) nameEl.textContent = target ? bodyDisplayName(target.name) : '';
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

  private readonly sunLabelOcclusionProbe = (x: number, y: number, depth: number): boolean =>
    this.planetLabels?.isScreenPointOccluded(x, y, depth) ?? false;

  private updateSunLabel() {
    if (!this.solarSystem) return;
    const sunPos = this.solarSystem.sun.position;
    const distanceFromSunAU = this.player.getDistanceFromSun();
    const revealed = this.revealedBody === 'Sun';
    // The footprint (32 rim rays through the lens) only feeds the visible
    // label's offset — when the label's own gates will hide it anyway, pass a
    // zero radius and skip the measurement.
    const sunRadiusPx = SunLabel.wantsFootprint(this.showBodyLabels, revealed, distanceFromSunAU)
      ? this.getSunScreenProjection().radiusPx
      : 0;
    this.sunLabel.update(
      sunPos,
      this.camera,
      this.renderer.domElement,
      distanceFromSunAU,
      sunRadiusPx,
      this.sunLabelOcclusionProbe,
      this.showBodyLabels,
      revealed,
      this.sunGlareMaskParams,
      // Fresh this frame: renderLabels just placed the revealed label.
      this.planetLabels?.revealedLabelRect() ?? null,
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

    // Auto-disable override once genuinely clear: outside the planet
    // throttle AND the body cap has read unbound for the full hold — one
    // grazing frame at the engage boundary can't clear a latched override.
    // systemSpeedFactor alone reflects only the parent-system throttle, so
    // without the body check the override would clear itself the instant you
    // stepped outside a planet's radius — even while an outer moon still caps.
    if (this.throttleOverride && this.systemSpeedFactor >= 1.0
        && this.bodyCap.unboundS >= BODY_CAP_CLEAR_HOLD_S) {
      this.throttleOverride = false;
      // The hold proves the GEOMETRY has been open for the full interval; the
      // eased candidate may still carry wall-level ramp memory, and handing
      // that to the applied cap would brake a full-speed ship to a crawl the
      // frame the bypass ends. The escape is complete — start clean, exactly
      // like every other flight discontinuity.
      this.bodyCap = initialBodyCapState();
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
      const speedText =
        this.inSystemMode || actualC < 0.05
          ? (actualC < 0.0005 ? '0 km/s' : this.formatSystemSpeed(actualC))
          : `${actualC.toFixed(1)}c`;
      if (speedText !== this.lastSpeedText) {
        this.lastSpeedText = speedText;
        this.speedValueEl.textContent = speedText;
        // The readout box is fixed-width; a string that overflows it drops
        // the font a step (and returns) rather than resizing the bar. Always
        // measured unsqueezed — measuring at the small size would clear the
        // class and oscillate.
        this.speedValueEl.classList.remove('squeeze');
        if (this.speedValueEl.scrollWidth > this.speedValueEl.clientWidth) {
          this.speedValueEl.classList.add('squeeze');
        }
      }
    }
  }

  isMissionActive(): boolean {
    return this.activeHistoricJourney !== null;
  }

  /** Whether a guided tutorial is running — it owns the scene and holds a live
   *  pre-tutorial snapshot, so main.ts's ?auto=volumeCompare fast path must not
   *  switch away and strand it. */
  isTutorialActive(): boolean {
    return this.tutorial !== null;
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
    this.clearBodyReveal();
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
    this.updateSceneStealingMenuItems();
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
      this.updateSceneStealingMenuItems();
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
   * inside totality. The surface vantage is pinned once at the peak's umbral
   * ground point (updateSurfaceCamera's stand-still anchor), so realtime
   * totality plays out overhead while the user lingers.
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
      // The card teaches the panel as the way to find an eclipse, so it must
      // be on screen even when the tutorial's arrival was quiet and the panel
      // never opened (surface entry only keeps a panel that was already open).
      // On phones show() starts the sheet at peek, clear of the centered Sun,
      // and the HUD chevron clamps to it.
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

  // The ☰ Tutorial item steals the whole scene, so it is disabled while a tutorial
  // runs — it owns the scene and holds a live pre-tutorial snapshot that a mode switch
  // would strand. ("How many fit?" is now a Tools-menu row, disabled at build time by
  // buildToolsMenu's `running` flag.) Called on tutorial start and end.
  private updateSceneStealingMenuItems(): void {
    const running = this.tutorial !== null;
    const btn = document.getElementById('planetarium-btn-tutorial') as HTMLButtonElement | null;
    if (btn) btn.disabled = running;
  }

  // ── Tools front door ─────────────────────────────────────
  // The cluster button (right of Observe) opens an anchored popover launching
  // the "How many fit?" tool. Visible in cruise AND landed (missions hide it via
  // updateObservatoryButtonVisibility); transient popover in the Esc cascade and
  // the one-modal-at-a-time set, but NOT a new keyboard key.

  /** Enter the "How many fit?" tool. A no-op while the tutorial owns the scene;
   *  closes every entry surface first (the ☰ menu auto-pauses ship + clock and
   *  restores on close, so leave with that resolved, as startTutorial does). */
  private requestVolumeCompare() {
    if (this.tutorial !== null || this.isMissionActive()) return;
    // Snapshot the pre-tool journey before main.ts deactivates this mode — that
    // deactivate exits landed mode and saves the taken-off state, so without this
    // the landing (and any Observatory excursion) is lost. getState() then serves
    // this snapshot to every persistence path, and activate() restores it on
    // return, so leaving the tool — or a tab-close inside it — resumes exactly
    // here. Mirrors preMissionState + the tutorial's getState()-serves-snapshot.
    this.preToolState = this.getState();
    this.closeMenuPanel();
    this.hideHelp();
    this.closeToolsMenu();
    this.volumeCompareRequestCb?.();
  }

  private isToolsMenuOpen(): boolean {
    return document.getElementById('tools-menu')?.classList.contains('visible') ?? false;
  }

  private toggleToolsMenu() {
    if (this.isToolsMenuOpen()) this.closeToolsMenu();
    else this.openToolsMenu();
  }

  private openToolsMenu() {
    const menu = document.getElementById('tools-menu');
    if (!menu) return;
    // A committed dive owns the map; superseding it would drop the commit.
    if (this.mapDiving) return;
    // One modal at a time — Tools joins the deck / ☰ / Look-at trio.
    this.closeMap({ restore: false });
    this.closeMenuPanel();
    this.closeDeck();
    this.closeSurfaceTargetMenu();
    this.buildToolsMenu();
    menu.classList.add('visible');
    // Anchor the card under the Tools button. Measured after .visible (a
    // display:none card has no width) and clamped to the viewport — on narrow
    // phones the button sits further left than the card can follow.
    const card = menu.querySelector<HTMLElement>('.tools-card');
    const btn = document.getElementById('planetarium-btn-tools');
    if (card && btn) {
      const rect = btn.getBoundingClientRect();
      const left = Math.min(Math.max(rect.left, 14), window.innerWidth - card.offsetWidth - 14);
      card.style.left = `${left}px`;
      card.style.right = 'auto';
    }
  }

  private closeToolsMenu() {
    document.getElementById('tools-menu')?.classList.remove('visible');
  }

  /** Rebuild the popover rows (built dynamically so the tutorial-disabled state
   *  is read live): the volume-compare tool, then the expandable Historic
   *  journeys group. */
  private buildToolsMenu() {
    const list = document.getElementById('tools-menu-list');
    if (!list) return;
    list.textContent = '';
    const running = this.tutorial !== null;
    const row = document.createElement('button');
    row.className = 'pk-row tools-row' + (running ? ' tools-dim' : '');
    row.disabled = running;
    const info = document.createElement('span');
    info.className = 'pk-info';
    const name = document.createElement('b');
    name.textContent = 'How many fit?';
    const sub = document.createElement('span');
    sub.className = 'tools-sub';
    sub.textContent = 'Pour one world into another.';
    info.append(name, sub);
    row.append(info);
    row.addEventListener('click', () => this.requestVolumeCompare());
    list.appendChild(row);

    // Historic journeys: one expandable group (parent row + a submenu of the five
    // missions) so the popover stays compact and reads as a single item until the
    // user opens it. Collapsed on every build — the menu opens tidy each time. Not
    // disabled during the tutorial: startHistoricJourney restores it first, exactly
    // as the old ☰ entries did.
    const divider = document.createElement('div');
    divider.className = 'tools-divider';
    list.appendChild(divider);

    const parent = document.createElement('button');
    parent.className = 'pk-row tools-row tools-parent';
    parent.setAttribute('aria-expanded', 'false');
    const parentInfo = document.createElement('span');
    parentInfo.className = 'pk-info';
    const parentName = document.createElement('b');
    parentName.textContent = 'Historic journeys';
    const parentSub = document.createElement('span');
    parentSub.className = 'tools-sub';
    parentSub.textContent = 'Retrace a historic mission.';
    parentInfo.append(parentName, parentSub);
    const chevron = document.createElement('span');
    chevron.className = 'tools-chevron';
    chevron.textContent = '▸'; // ▸ — rotates to ▾ when expanded
    parent.append(parentInfo, chevron);
    list.appendChild(parent);

    const submenu = document.createElement('div');
    submenu.className = 'tools-submenu';
    const missions: { id: HistoricMissionId; label: string }[] = [
      { id: 'voyager1', label: 'Voyager 1 (1977)' },
      { id: 'voyager2', label: 'Voyager 2 (1977)' },
      { id: 'cassini', label: 'Cassini-Huygens (1997)' },
      { id: 'newHorizons', label: 'New Horizons (2006)' },
      { id: 'juno', label: 'Juno (2011)' },
    ];
    for (const m of missions) {
      const mrow = document.createElement('button');
      mrow.className = 'pk-row tools-row tools-subitem';
      const minfo = document.createElement('span');
      minfo.className = 'pk-info';
      const mname = document.createElement('b');
      mname.textContent = m.label; // name-only — missions aren't catalog bodies (no pk-dot)
      minfo.append(mname);
      mrow.append(minfo);
      mrow.addEventListener('click', () => {
        this.closeToolsMenu(); // one modal at a time — the mission takes the scene
        void this.startHistoricJourney(m.id);
      });
      submenu.appendChild(mrow);
    }
    list.appendChild(submenu);

    // Toggle the group open/closed in place — the parent never leaves the menu.
    parent.addEventListener('click', () => {
      const expanded = submenu.classList.toggle('visible');
      parent.classList.toggle('expanded', expanded);
      parent.setAttribute('aria-expanded', String(expanded));
    });
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
      }
    }

    if (missionActive) {
      this.keys.clear();
      this.closeDeck();
    }

    this.updateObservatoryButtonVisibility();
  }

  private wireUpUI() {
    // The covering arrival veil catches pointers by design (nothing
    // half-loaded may be interacted with) — but a caught click must not die
    // silently: reveal the busy note at once and pulse it, so the click
    // reads as heard-but-not-ready instead of a dead button.
    document.getElementById('arrival-veil')?.addEventListener('pointerdown', (e) => {
      const veil = e.currentTarget as HTMLElement;
      if (!veil.classList.contains('covering')) return;
      const note = document.getElementById('arrival-veil-note');
      if (!note) return;
      note.classList.add('show');
      note.classList.remove('pulse');
      void note.offsetWidth; // restart the pulse animation
      note.classList.add('pulse');
    });

    // Tap speed center to toggle system throttle override (temporary)
    document.querySelector('.speed-center')?.addEventListener('click', () => {
      if (this.isMissionActive()) return;
      // A held ship takes no throttle commands: a change banked under the
      // freeze would act only at unpause, as a surprise.
      if (this.timeState.paused) return;
      if (!this.systemSlowdown) return; // already disabled globally
      this.throttleOverride = !this.throttleOverride;
      // Arming starts a fresh clear-hold — a stale unbound interval from
      // before the tap must not auto-clear the override moments later.
      if (this.throttleOverride) this.bodyCap = { ...this.bodyCap, unboundS: 0 };
      // Name the state change: the pill sits between the − / + steppers on
      // phones, and an unnoticed fat-finger arms a full-speed bypass.
      this.notification.show(this.throttleOverride
        ? 'Speed limits off — full throttle everywhere.'
        : 'Speed limits back on.');
      this.updateSpeedSlider();
    });

    document.getElementById('planetarium-speed-up')?.addEventListener('click', () => {
      if (this.isMissionActive()) return;
      if (this.timeState.paused) return; // held ship: throttle inert
      this.reviveParkedShip(); // stepping the throttle up means "go"
      // The tap law (engage floor, ×1.35, cap) lives in throttlePolicy.ts.
      if (this.inSystemMode) {
        this.player.systemSpeedMultiplier = stepThrottleTap(
          this.player.systemSpeedMultiplier, 1, SYSTEM_TAP_FLOORS, PlayerShip.SYSTEM_SPEED_MAX);
      } else {
        this.player.speedMultiplier = stepThrottleTap(
          this.player.speedMultiplier, 1, CRUISE_TAP_FLOORS, PlayerShip.SPEED_MAX);
      }
      this.updateSpeedSlider();
    });
    document.getElementById('planetarium-speed-down')?.addEventListener('click', () => {
      if (this.isMissionActive()) return;
      if (this.timeState.paused) return; // held ship: throttle inert
      // Same tap law downward: cut floor to exactly zero, else ×0.72.
      if (this.inSystemMode) {
        this.player.systemSpeedMultiplier = stepThrottleTap(
          this.player.systemSpeedMultiplier, -1, SYSTEM_TAP_FLOORS, PlayerShip.SYSTEM_SPEED_MAX);
      } else {
        this.player.speedMultiplier = stepThrottleTap(
          this.player.speedMultiplier, -1, CRUISE_TAP_FLOORS, PlayerShip.SPEED_MAX);
      }
      this.updateSpeedSlider();
    });

    document.getElementById('planetarium-btn-save')?.addEventListener('click', () => {
      // Forced: mid-tutorial the banner is muted (and the save then writes the
      // pre-tutorial snapshot on purpose), but a pressed Save must answer —
      // honestly: with storage blocked or full, every backend can reject, and
      // a false "saved" costs the user their journey.
      void this.store.saveState(this.getState()).then((saved) => {
        this.notification.show(
          saved ? 'Game saved!' : "Couldn't save — storage is blocked or full",
          { force: true },
        );
      });
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

    // The five historic-journey starts now live as Tools-menu rows (buildToolsMenu).
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
        // A committed dive owns the map; superseding it would drop the commit.
        if (this.mapDiving) return;
        // One modal at a time (the deck closes ☰ on open, symmetric).
        this.closeMap({ restore: false });
        this.closeDeck();
        this.closeSurfaceTargetMenu();
        this.closeToolsMenu();
        this.resumeShipAfterMenu = this.player.moving;
        this.resumeTimeAfterMenu = !this.timeState.paused;
        this.player.moving = false;
        this.timeState.paused = true;
        this.updateTimeUI();
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
    // ☰ "System map": close the menu (restoring its auto-pause) then open the
    // map. The M key is the other front door.
    document.getElementById('planetarium-btn-map')?.addEventListener('click', () => {
      this.closeMenuPanel();
      this.openMap();
    });
    // The map's zoom pair. Wired on pointerdown rather than click: the press
    // has to spend its first notch immediately and then keep spending while the
    // button is held, and a click only ever arrives once, at the end.
    this.bindMapZoomButton('map-zoom-in', 1);
    this.bindMapZoomButton('map-zoom-out', -1);
    document.getElementById('help-take-tutorial')?.addEventListener('click', () => this.startTutorial());
    document.getElementById('help-explore')?.addEventListener('click', () => this.hideHelp());
    document.getElementById('planetarium-help-close')?.addEventListener('click', () => this.hideHelp());
    document.querySelector('#planetarium-help .planetarium-help-backdrop')?.addEventListener('click', () => this.hideHelp());

    // Tools front door: the cluster button toggles the anchored popover. The
    // full-screen catcher (Look-at idiom) closes on an outside click; because it
    // sits above the cluster, a second button click lands on the catcher and
    // closes rather than re-opening.
    document.getElementById('planetarium-btn-tools')?.addEventListener('click', () => {
      if (this.isMissionActive()) return;
      this.toggleToolsMenu();
    });
    document.getElementById('tools-menu')?.addEventListener('click', (e) => {
      if (e.target === document.getElementById('tools-menu')) this.closeToolsMenu();
    });

    this.bottomBar.bind();
    this.mapHud.bind();
    // The panel's own rows. The card's and the segment's callbacks arrived
    // with the HUD's constructor; these are assigned, the bottom bar's idiom.
    this.mapHud.onHelp = () => this.toggleMapHelp();
    this.mapHud.onHelpClose = () => this.setMapHelpOpen(false);
    // The chevron banks the preference; every other way the panel folds away
    // does not (Esc is a dismissal, and the phone's card exclusion is a
    // layout reflex), so only this path passes bank.
    this.mapHud.onCollapse = () => this.setMapPanelCollapsed(true, { bank: true });
    this.mapHud.onExpand = () => this.setMapPanelCollapsed(false, { bank: true });
    this.mapHud.onPickRow = (name) => this.pickMapFocusRow(name);
    this.mapHud.onReleaseFocus = () => { this.releaseMapFocus(); };
    this.mapHud.onLayer = (key, on) => this.setMapLayer(key, on);
    // Every way the panel's shape can change funnels here: the label placer
    // caches the panel's rect (it is chrome that does not move on its own), and
    // the zoom hint measured its dock once when it was shown.
    this.mapHud.onPanelGeometry = () => {
      this.systemMap?.invalidateLabelChrome();
      this.redockMapZoomHint();
    };
    // One instrument at a time: opening the Stats card tucks the Observatory
    // panel back into its chip, with a brief pulse so the hop reads.
    this.bottomBar.onStatsToggle = (open) => {
      if (open && this.observatoryPanel.isOpen()) {
        this.closeObservatoryPanel();
        this.pulseObservatoryChip();
      }
      // Same pairing with the map card: opening Stats dismisses it.
      if (open) this.dismissMapCard();
      this.standMapPanelDown(open);
    };
    // Opening the Time panel dismisses the map card (one instrument at a time).
    this.bottomBar.onTimeToggle = (open) => {
      if (open) this.dismissMapCard();
      this.standMapPanelDown(open);
    };

    // Astronomy time controls. The transport, Now, and date input keep their
    // id-based handlers here — the rail widget's callbacks only cover the
    // gestures these buttons don't (drag/tap/keys on the rails).
    // All four transports carry the same lock the rail gestures and , . N keys
    // do: the ☰ menu auto-pauses the clock and restores it on close, so a
    // transport click while it's open would clobber the state the menu puts
    // back.
    // Pause sits in a radio group beside Play and Reverse: it SELECTS the
    // paused state rather than toggling, so a click delivered late (a busy
    // frame can queue it) can never resume a clock the user asked to stop.
    // Rail taps and Space stay toggles — those gestures carry no promise.
    document.getElementById('planetarium-time-pause')?.addEventListener('click', () => {
      if (this.timeControlsLocked()) return;
      this.setTimePausedFromControl(true);
    });
    document.getElementById('planetarium-time-play')?.addEventListener('click', () => {
      if (this.timeControlsLocked()) return;
      this.timeState.paused = false;
      if (this.timeState.rate < 0) this.timeState.rate *= -1;
      this.updateTimeUI({ flash: true });
    });
    document.getElementById('planetarium-time-reverse')?.addEventListener('click', () => {
      if (this.timeControlsLocked()) return;
      this.timeState.paused = false;
      this.timeState.rate = -Math.abs(this.timeState.rate);
      this.updateTimeUI({ flash: true });
    });
    document.getElementById('planetarium-time-now')?.addEventListener('click', () => {
      if (this.timeControlsLocked()) return;
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
          // A typed date can leap the bodies far in one step — reseed the flash
          // baseline so the new geometry doesn't read as a Sun emergence.
          this.noteSunViewDiscontinuity();
          this.startObservatoryEventSearch();
          // Reachable over an open map: only the expanded panel closes with the
          // map, the bottom bar's date field stays live.
          this.startMapEventSearch();
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

    const labelDistancesToggle = document.getElementById('settings-label-distances-toggle');
    labelDistancesToggle?.addEventListener('click', () => {
      this.labelDistancesMode = this.labelDistancesMode === 'always' ? 'hover' : 'always';
      this.applyBodyLabelVisibility();
      const label = document.getElementById('settings-label-distances-label');
      if (label) label.textContent = this.labelDistancesMode === 'always' ? 'Always' : 'On hover';
      labelDistancesToggle.setAttribute('aria-pressed', String(this.labelDistancesMode === 'always'));
    });

    document.getElementById('settings-markers-toggle')?.addEventListener('click', () => {
      this.showBodyMarkers = !this.showBodyMarkers;
      this.applyBodyLabelVisibility();
      const label = document.getElementById('settings-markers-label');
      if (label) label.textContent = this.showBodyMarkers ? 'On' : 'Off';
    });

    const orbitsToggle = document.getElementById('settings-orbits-toggle');
    orbitsToggle?.addEventListener('click', () => {
      // Per-frame updateOrbitLineVisibility applies the flag.
      this.showOrbitLines = !this.showOrbitLines;
      const label = document.getElementById('settings-orbits-label');
      if (label) label.textContent = this.showOrbitLines ? 'On' : 'Off';
      orbitsToggle.setAttribute('aria-pressed', String(this.showOrbitLines));
    });

    document.getElementById('settings-mini-toggle')?.addEventListener('click', () => {
      // The one writer of the persisted preference: only this deliberate flip
      // gives the save an opinion about the corner chart.
      this.miniChartPrefStored = !this.showMiniChart;
      this.setMiniChartEnabled(!this.showMiniChart);
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
      // A committed dive owns the map; takeoff would close it over the commit.
      if (this.mapDiving) return;
      this.exitLandedMode();
    });
    document.getElementById('planetarium-btn-land')?.addEventListener('click', () => {
      if (this.mapDiving) return;
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
    // A committed dive owns the map: the deck opening would close it and
    // silently drop the queued journey. The cluster looks live through the
    // whole 420 ms window, so this refusal is what keeps a hurry-tap harmless.
    if (this.mapDiving) return;
    const wasOpen = this.isDeckOpen();
    this.deckVerb = verb;
    this.deckOpenedFromPanel = opts.fromPanel ?? false;
    const search = document.getElementById('deck-search') as HTMLInputElement | null;
    if (!wasOpen) {
      // One modal at a time; labels restore on close (deferring to surface
      // view / the labels setting). The map is mutually exclusive with the
      // deck (same z-slot) — opening a tab supersedes it, no restore.
      this.closeMap({ restore: false });
      this.closeMenuPanel();
      this.closeSurfaceTargetMenu();
      this.closeToolsMenu();
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
    // A committed dive owns the map: superseding it here would drop the
    // queued journey with no feedback. Esc is the deliberate cancel.
    if (this.mapDiving) return;
    // O over the map closes it first, then opens the panel — this defines
    // "reopens via O"; the reverse close skips the panel/surface restore.
    this.closeMap({ restore: false });
    if (!this.isDeckOpen() && this.landedOn) {
      this.toggleObservatoryPanel();
      return;
    }
    this.toggleDeck('observe');
  }

  // ── System map ──────────────────────────────────────────────────────────

  isMapOpen(): boolean {
    return this.systemMap?.isOpen() ?? false;
  }

  /** main.ts renders this to the backbuffer instead of the composer while the
   *  map owns the frame; the map owns its own renderer-state transaction. */
  renderMapFrame(): void {
    this.systemMap?.render();
  }

  // ── The corner chart ────────────────────────────────────────────────────

  /**
   * Per-frame corner chart, called at the end of both update branches. It owns
   * its own lifecycle: the visibility rule decides whether the chart exists
   * this frame, and the two edges of that decision are what start and stop it.
   * The chart is built on the first frame it is actually wanted — a journey
   * spent entirely landed never pays for it.
   */
  private updateMiniChart(): void {
    const q = this.miniVisibility;
    q.enabled = this.showMiniChart;
    q.ready = this.active && !!this.solarSystem;
    q.landed = this.landedOn !== null;
    q.mapOpen = this.isMapOpen();
    q.deckOpen = this.isDeckOpen();
    q.missionActive = this.isMissionActive();
    q.tutorialActive = this.isTutorialActive();
    q.helpOpen = this.isHelpOpen();
    q.arrivalVeilUp = this.arrivalVeilUp();
    if (!miniChartVisible(q)) {
      this.hideMiniChart();
      return;
    }
    if (!this.systemMap) {
      const t0 = import.meta.env.DEV ? performance.now() : 0;
      this.systemMap = new SystemMap(this.renderer, this.mapTextureSource());
      if (import.meta.env.DEV) this.miniConstructMs = performance.now() - t0;
    }
    if (!this.systemMap.isMiniOpen()) this.systemMap.openMini(this.timeState.currentUtcMs);

    const el = this.renderer.domElement;
    const canvasW = Math.max(el.clientWidth, 1);
    const canvasH = Math.max(el.clientHeight, 1);
    const pixelRatio = this.renderer.getPixelRatio();
    if (miniRectStale(this.miniRectCanvasW, this.miniRectCanvasH, canvasW, canvasH)
      || this.miniRectPixelRatio !== pixelRatio) {
      this.miniRectCanvasW = canvasW;
      this.miniRectCanvasH = canvasH;
      this.miniRectPixelRatio = pixelRatio;
      this.miniRect = miniChartRect(canvasW, canvasH);
      // The REAL buffer dims, not css·ratio: the renderer floors that product
      // on both axes, and the snap's whole job is agreeing with the driver.
      this.renderer.getDrawingBufferSize(this.miniBufferSize);
      this.miniDraw = miniDrawRect(
        this.miniRect,
        canvasW,
        canvasH,
        this.miniBufferSize.x,
        this.miniBufferSize.y,
        pixelRatio,
      );
      this.miniRectBuilds++;
      this.applyMiniChartSurface();
    }
    const draw = this.miniDraw;
    this.setMiniChartSurfaceShown(true);

    const fwd = this.player.writeForwardDirection(this.mapShipForward);
    this.systemMap.updateMini(
      this.timeState.currentUtcMs,
      this.player.posX,
      this.player.posY,
      this.player.posZ,
      fwd.x,
      fwd.y,
      fwd.z,
      // Effective motion: a held ship (paused clock) reads as not moving,
      // so the chart's chevron sits still instead of pulsing over a frozen
      // world — the original complaint this state exists to fix.
      this.player.moving && !this.player.held,
      // Never landed: the ground is one of the states that stands the chart
      // down, so a live corner chart is always a flying one.
      null,
      this.lastFrameDtMs,
      // The DRAWN size, not the one that was asked for: the camera aspect and
      // every screen-metered marker have to describe the rectangle the driver
      // is given, which the device snap may have shaved by a fraction of a px.
      draw.width,
      draw.height,
    );
  }

  /**
   * Whether the arrival veil is on screen. `arrivalInFlight` clears in the
   * arrival's own `finally`, but the veil then holds for the texture-upgrade
   * wait and the minimum dwell and fades out over its CSS transition — and
   * through the fade it is still painted while no longer taking pointers, so
   * anything that appeared under it would show through AND be clickable. The
   * stamp is written where the class is actually removed; reading it is a
   * number compare, never a style read.
   */
  private arrivalVeilUp(): boolean {
    return this.arrivalInFlight || performance.now() < this.arrivalVeilClearAtMs;
  }

  /** main.ts draws this over the world frame, after the composer has finished
   *  with it. Nothing happens unless the chart is live. */
  renderMiniChartFrame(): void {
    if (!this.systemMap?.isMiniOpen()) return;
    this.systemMap.renderMini(this.miniDraw);
  }

  private hideMiniChart(): void {
    if (this.systemMap?.isMiniOpen()) this.systemMap.closeMini();
    this.setMiniChartSurfaceShown(false);
  }

  /** The stylesheet hides the surface by default, so shown/hidden is an inline
   *  display either way — an empty string would hand it back to the rule that
   *  hides it. Written only on a change; the property is read every frame. */
  private setMiniChartSurfaceShown(shown: boolean): void {
    const el = this.miniChartSurface();
    if (!el) return;
    const want = shown ? 'block' : 'none';
    if (el.style.display !== want) el.style.display = want;
  }

  private applyMiniChartSurface(): void {
    const el = this.miniChartSurface();
    if (!el) return;
    el.style.left = `${this.miniRect.left}px`;
    el.style.top = `${this.miniRect.top}px`;
    el.style.width = `${this.miniRect.width}px`;
    el.style.height = `${this.miniRect.height}px`;
  }

  /**
   * The chart's tap target, wired once. It has to be a real DOM surface: on
   * coarse pointers the flight zone is a transparent full-width layer above
   * the canvas, so a canvas hit-test never fires under it, and a pointerdown
   * check could never intercept a wheel in any case. It sits ABOVE that zone
   * and covers the whole rectangle, and the zone stays live everywhere else —
   * unlike the full map, the corner chart does not take steering away.
   */
  private miniChartSurface(): HTMLElement | null {
    if (this.miniChartEl) return this.miniChartEl;
    const el = document.getElementById('mini-chart');
    if (!el) return null;
    this.miniChartEl = el;
    el.addEventListener('pointerdown', (e) => {
      const pe = e as PointerEvent;
      if (pe.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      this.openMap();
    });
    // Swallow the scroll over the chart: the world is not what a wheel here
    // means, and the corner chart has no zoom of its own.
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();
    }, { passive: false });
    el.addEventListener('keydown', (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key !== 'Enter' && ke.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      this.openMap();
    });
    this.applyMiniChartSurface();
    return el;
  }

  /** The ☰ toggle, and the dev bridge behind it. */
  private setMiniChartEnabled(enabled: boolean): void {
    this.showMiniChart = enabled;
    const label = document.getElementById('settings-mini-label');
    if (label) label.textContent = enabled ? 'On' : 'Off';
    document.getElementById('settings-mini-toggle')
      ?.setAttribute('aria-pressed', String(enabled));
    if (!enabled) this.hideMiniChart();
  }

  /** Dev bridge: flip the corner chart without opening the menu. */
  devSetMiniChart(enabled: boolean): void {
    this.setMiniChartEnabled(enabled);
  }

  /** Dev bridge: draw the corner chart over the world frame instead of on its
   *  own field, so both looks can be captured. */
  devSetMiniOpaque(opaque: boolean): void {
    this.systemMap?.setMiniOpaque(opaque);
  }

  /** Dev forensics: the corner chart's pose, its blend bookkeeping and what it
   *  costs per frame, plus the rectangle it is drawing into. */
  devMiniState(): (ReturnType<SystemMap['miniStats']> & {
    rect: MiniChartRect;
    draw: MiniDrawRect;
    pixelRatio: number;
    constructMs: number;
    rectBuilds: number;
    veilUp: boolean;
  }) | null {
    if (!this.systemMap) return null;
    return {
      ...this.systemMap.miniStats(),
      rect: this.miniRect,
      draw: this.miniDraw,
      pixelRatio: this.miniRectPixelRatio,
      constructMs: this.miniConstructMs,
      rectBuilds: this.miniRectBuilds,
      veilUp: this.arrivalVeilUp(),
    };
  }

  /**
   * Live read-only view of the world's surface textures for the map's globes.
   * Resolved on every call rather than cached: the world swaps a body's colour
   * map when a sharper tier lands and disposes the one it replaces, so the only
   * safe answer is the one the material carries at this instant.
   */
  private mapTextureSource(): MapTextureSource {
    // Indexed like moonMeshFor: the map re-resolves ~18 textures per frame,
    // and a linear scan costs a fresh predicate closure per call.
    const planetOf = (name: string) => this.planetMeshByName.get(name);
    return {
      colorMap: (name) => {
        const planet = planetOf(name);
        if (planet) {
          return (planet.mesh.material as THREE.MeshStandardMaterial).map ?? null;
        }
        // A moon: only once MoonPainter has actually finished it. The map falls
        // back to its own tinted marker until then, which is a chart keeping the
        // body present — never a half-painted surface.
        const moon = this.moonMeshFor(name);
        if (!moon?.painted) return null;
        return (moon.mesh.material as THREE.MeshStandardMaterial).map ?? null;
      },
      ringMap: (name) =>
        (planetOf(name)?.rings?.material as THREE.MeshStandardMaterial | undefined)?.map ?? null,
    };
  }

  /** The built mesh for a moon by name. Indexed rather than searched: the map
   *  asks once per revealed moon per frame, and a nested scan over every
   *  system's array would allocate a predicate each time for a lookup that
   *  never changes. */
  private moonMeshFor(name: string): MoonMesh | null {
    return this.moonMeshByName.get(name) ?? null;
  }

  /** Dev bridge: open/close/state/gamma, delegating to the same paths a real
   *  tap uses (the M-key guards are the load-bearing ones). */
  devOpenMap(): boolean {
    this.openMap();
    return this.isMapOpen();
  }

  devCloseMap(): boolean {
    const was = this.isMapOpen();
    // Same rule as the X: a committed dive cancels (map stays open) rather
    // than closing over the commit and silently dropping it.
    if (this.mapDiving) this.cancelMapDive();
    else this.closeMap();
    return was;
  }

  devMapState(): ({
    open: boolean;
    blend: number;
    trueScale: boolean;
    curve: string;
    curveParam: number;
    bodySize: MapBodySizeParams;
    sunSize: MapSunSizeParams;
    markerZoom: MapMarkerZoomParams;
    cameraDist: number;
    near: number;
    far: number;
    picked: string | null;
    camState: string;
    flyGoal: string | null;
    focused: string | null;
    panelCollapsed: boolean;
    helpOpen: boolean;
    layers: MapLayerState;
    diving: boolean;
    diveGapAU: number | null;
    ship: { rotationRad: number; docked: boolean };
    // The zoom forensics ride along whole (the devMiniState idiom): a new
    // field added to zoomState() flows through without a restated shape.
  } & ReturnType<SystemMap['zoomState']>) | null {
    if (!this.systemMap) return null;
    const curve = this.systemMap.getCurve();
    const cam = this.systemMap.getCameraState();
    const zoom = this.systemMap.zoomState();
    return {
      open: this.systemMap.isOpen(),
      // How far the map is blended toward true scale, plus which radial curve
      // the compressed end is drawn with and its one parameter.
      blend: this.systemMap.getBlend(),
      trueScale: this.systemMap.isTrueScale(),
      curve: curve.kind,
      curveParam: curve.kind === 'power' ? curve.gamma : curve.s0,
      bodySize: this.systemMap.getBodySizeParams(),
      sunSize: this.systemMap.getSunSizeParams(),
      markerZoom: this.systemMap.getMarkerZoomParams(),
      cameraDist: this.systemMap.getCameraDistance(),
      // The clip planes this frame drew with — a body on screen at a healthy
      // radius but rendering nothing is a near plane standing in front of it.
      near: this.systemMap.getClipPlanes().near,
      far: this.systemMap.getClipPlanes().far,
      picked: this.mapPicked?.name ?? null,
      // Which of the four states owns the camera, where a flight is headed, and
      // the body a focus rides (still named while a release flies away from it).
      camState: cam.camState,
      flyGoal: cam.flyGoal,
      focused: cam.focusName,
      panelCollapsed: this.mapPanelCollapsed,
      helpOpen: this.mapHelpOpen,
      layers: { ...this.mapLayers },
      diving: this.mapDiving,
      // Camera-aim-vs-live-dot gap: ~0 once the ease lands proves the dive
      // tracked the moving dot instead of a stale snapshot.
      diveGapAU: this.systemMap.diveTargetGapAU(),
      // The chevron's screen rotation, which is rebuilt from the camera like
      // sizes and labels are — and, unlike them, cannot be read off the pixels.
      ship: this.systemMap.shipMarkerState(),
      // Where the camera and the point it orbits actually are, the overview's
      // cursor-zoom state, and the pointer bookkeeping on both sides of the
      // seam — zoomState()'s whole snapshot, spread as-is.
      ...zoom,
    };
  }

  /** Dev bridge: draw the map's compressed end with the power-law curve at this
   *  exponent, for comparison against the shipped asinh curve. */
  devSetMapGamma(gamma: number): void {
    this.systemMap?.setCurve({ kind: 'power', gamma });
  }

  /** Dev bridge: the asinh curve's softening scale in AU — smaller compresses
   *  harder, larger keeps more of the system near true. */
  devSetMapS(s0: number): void {
    this.systemMap?.setCurve({ kind: 'asinh', s0 });
  }

  /** Dev bridge: live tuning of the map's drawn-size policy; null resets. */
  devSetMapBodySize(partial: Partial<MapBodySizeParams> | null): void {
    this.systemMap?.setBodySizeParams(partial);
  }

  /** Dev bridge: live tuning of the Sun's zoom-responsive size curve
   *  (gamma, pivotPx, floorPx); null resets. */
  devSetMapSunSize(partial: Partial<MapSunSizeParams> | null): void {
    this.systemMap?.setSunSizeParams(partial);
  }

  /** Dev bridge: live tuning of the markers' zoom response (gamma,
   *  refAuPerPx, floorScale, depthShare); null resets. */
  devSetMapMarkerZoom(partial: Partial<MapMarkerZoomParams> | null): void {
    this.systemMap?.setMarkerZoomParams(partial);
  }

  /** Dev bridge: the orbit lines' style — a partial ({opacity, brightness})
   *  retunes live, null restores defaults. */
  devSetMapOrbitStyle(
    partial: Partial<MapOrbitStyleParams> | null,
  ): MapOrbitStyleParams | null {
    return this.systemMap?.setOrbitStyle(partial) ?? null;
  }

  /** Dev bridge: the chart's star backdrop — false/true toggles, a partial
   *  ({alphaMul, sizeMul}) retunes, null restores defaults. */
  devSetMapStars(
    arg: boolean | Partial<MapStarParams> | null,
  ): (MapStarParams & { visible: boolean }) | null {
    return this.systemMap?.setStars(arg) ?? null;
  }

  /** Dev bridge: live tuning of the moon-offset policy (gamma, x0, the Io
   *  anchor, the cap, the clearance); null resets. Every drawn orbit
   *  reprojects on the next frame. False when the merged knobs would not draw
   *  a chart — the standing ones keep drawing. */
  devSetMapMoonOffset(partial: Partial<MapMoonOffsetParams> | null): boolean {
    return this.systemMap?.setMoonOffsetParams(partial) ?? false;
  }

  /** Dev bridge: the moon pipeline's counters — ring buffer writes, position
   *  passes, which systems are revealed, how many moons are drawn. */
  devMapMoonStats(): ReturnType<SystemMap['moonStats']> | null {
    return this.systemMap?.moonStats() ?? null;
  }

  /** Dev bridge: how one map body is drawing (globe or dot, footprint) and
   *  whether the texture it borrowed is still the one the world holds. */
  devMapProbe(name: string): ReturnType<SystemMap['probeBody']> {
    return this.systemMap?.probeBody(name) ?? null;
  }

  /** Dev bridge: open the card on any body the chart can name (the Sun, a
   *  planet, a moon), as a real pick would. Returns whether the card opened. */
  devMapPick(name: string): boolean {
    if (!this.isMapOpen() || this.mapDiving || this.isMapCameraFlying()) return false;
    if (!mapBodyRefFor(name)) return false;
    this.openMapCard(name);
    return this.mapHud.isCardOpen();
  }

  /** Dev bridge: press the card's verb button — the same disabled/ordering
   *  rules a real tap follows (closeMap strictly before the commit). */
  devMapCommit(verb: MapVerb): boolean {
    return this.commitMapCard(verb);
  }

  /** Dev bridge: the teleport gesture at a canvas pixel — the same resolution
   *  a right-click or a matured hold runs, body pick included, so a click on a
   *  body opens its card here too. Returns what the chip now offers. */
  devMapTeleportAt(xPx: number, yPx: number): ReturnType<PlanetariumMode['devMapTeleportState']> {
    if (this.isMapOpen() && !this.mapDiving && !this.isMapCameraFlying() && this.systemMap) {
      const hit = this.systemMap.pick(xPx, yPx, 'mouse');
      if (hit.kind === 'body') this.openMapCard(hit.name);
      else if (hit.kind === 'empty') this.offerMapTeleport(xPx, yPx);
    }
    return this.devMapTeleportState();
  }

  /** Dev bridge: the offer standing over the chart, or null for none. */
  devMapTeleportState(): {
    radiusAU: number;
    pointAU: [number, number, number];
    label: string;
    visible: boolean;
    screen: [number, number];
  } | null {
    if (!this.mapTpPoint) return null;
    return {
      radiusAU: this.mapTpRadiusAU,
      pointAU: [this.mapTpPoint.x, this.mapTpPoint.y, this.mapTpPoint.z],
      label: this.mapTpChipEl?.textContent ?? '',
      visible: this.isMapTeleportChipVisible(),
      screen: [this.mapTpChipX, this.mapTpChipY],
    };
  }

  /** Dev bridge: press the chip (commit) or give the offer back (dismiss). */
  devMapTeleportCommit(): boolean {
    return this.commitMapTeleport();
  }

  devMapTeleportDismiss(): void {
    this.dismissMapTeleportChip();
  }

  /** Dev bridge: focus a body (the card's Focus button / a double-tap), or
   *  release the focus with null (the Esc rung). */
  devMapFocus(name: string | null): boolean {
    return name === null ? this.releaseMapFocus() : this.focusMapBody(name);
  }

  /** Dev bridge: the panel's Reset view row — a release flight when there is a
   *  focus to give back, an instant re-fit when the free zoom has wandered.
   *  Which one it was is what `mapState().camState` says a frame later. */
  devMapOverview(): boolean {
    return this.mapOverviewPressed();
  }

  /** Dev bridge: the gesture guide. Kept under its old name — it is the
   *  same question ("is the map's help showing?") asked of the surface that
   *  replaced the in-panel grid. */
  devMapInfo(open: boolean): boolean {
    this.setMapHelpOpen(open);
    return this.mapHelpOpen;
  }

  /** Dev bridge: the chart's layer switches. A partial writes only the keys it
   *  carries, null restores the defaults; the answer is the session state now
   *  in force, which is what a reopened map will show. */
  devSetMapLayers(partial: Partial<MapLayerState> | null): MapLayerState {
    this.mapLayers = partial === null
      ? { ...MAP_LAYER_DEFAULTS }
      : { ...this.mapLayers, ...partial };
    this.applyMapLayers();
    return { ...this.mapLayers };
  }

  /** Dev bridge: read or drive the control panel. No argument reads it, a
   *  partial writes only the fields it carries, null puts the defaults back;
   *  the answer is always the state now in force. `sheetExpanded` is derived —
   *  at the phone breakpoint an open panel IS the expanded sheet — and is
   *  read-only for that reason. */
  devMapPanel(
    partial?: { collapsed?: boolean; helpOpen?: boolean } | null,
  ): { collapsed: boolean; helpOpen: boolean; sheetExpanded: boolean } {
    if (partial === null) {
      this.setMapHelpOpen(false);
      this.setMapPanelCollapsed(false, { bank: true });
    } else if (partial) {
      if (partial.collapsed !== undefined) {
        this.setMapPanelCollapsed(partial.collapsed, { bank: true });
      }
      if (partial.helpOpen !== undefined) this.setMapHelpOpen(partial.helpOpen);
    }
    return {
      collapsed: this.mapPanelCollapsed,
      helpOpen: this.mapHelpOpen,
      sheetExpanded: this.isPhoneLayout() && !this.mapPanelCollapsed,
    };
  }

  /** Open the full-screen system map. The single safe gate for every entry
   *  (M key, ☰ item, dev bridge): refused during a mission, the help modal, a
   *  running tutorial, or while the arrival veil is up — the whole ceremony
   *  including its dwell-and-fade tail, not just the in-flight leg: the veil's
   *  contract is that nothing appears (clickable) underneath it. */
  private openMap() {
    if (!this.active || !this.solarSystem || this.isMapOpen()) return;
    if (this.isMissionActive() || this.isHelpOpen() || this.isTutorialActive() || this.arrivalVeilUp()) {
      return;
    }

    // One modal at a time: fold every transient overlay away first. The corner
    // chart goes with them — its own per-frame rule would only catch up next
    // frame, leaving its tap surface live over the map for one.
    this.hideMiniChart();
    this.closeMenuPanel();
    this.closeDeck();
    this.closeSurfaceTargetMenu();
    this.closeToolsMenu();
    this.bottomBar.closeStats();
    this.bottomBar.closeTime();

    // Restore-on-close: reopen the panel and re-enter surface view exactly as
    // the user left them (the pick survives in surfacePickedTarget).
    this.mapRestorePanel = this.observatoryPanel.isOpen();
    if (this.mapRestorePanel) this.closeObservatoryPanel();
    this.mapRestoreSurface = this.landedView === 'surface';
    // The instant path — the default glide would leave SurfaceLook attached
    // under the map's controls.
    if (this.mapRestoreSurface) this.exitSurfaceView(true);

    // Hand the pointer over cleanly (surface-view idiom, plus the cruise
    // camera's reclaim/settle contract). End any held cruise orbit drag — its
    // OrbitControls gesture and document listeners with it — drop the damping
    // residuals, and put the chase back in charge so the invisible cruise
    // camera keeps following the ship and closes to a proper chase pose.
    this.cancelOrbitGesture();
    flushOrbitDamping(this.controls);
    this.pendingChaseReclaim = false;
    this.camOwner = 'chase';
    this.controls.enabled = false;
    // A held W must not resume as phantom thrust when the map closes.
    this.keys.clear();
    this.touchYaw = 0;
    this.touchPitch = 0;

    // The full-screen touch flight zone would eat every map gesture AND steer
    // the coasting ship — hide it and drop any pointer it has captured.
    this.setTouchFlightZoneHidden(true);

    document.body.classList.add('system-map-active');
    // Nothing may re-show world labels over the map (the setWorldLabelsVisible
    // defer term enforces it; the class force-hides the DOM regardless).
    this.setWorldLabelsVisible(false);

    this.systemMap ??= new SystemMap(this.renderer, this.mapTextureSource());
    this.mapHud.bind();
    this.bindMapTeleportChip();
    this.systemMap.openMap(this.timeState.currentUtcMs);
    this.mapHud.show();
    this.mapHud.render(this.systemMap.isTrueScale());
    // The panel comes back the way it was left this session; help does not —
    // it is a thing you open to read once.
    this.mapHelpOpen = false;
    this.mapHud.setHelpOpen(false);
    // First map of the session: a phone opens with the sheet folded to its
    // chip. Expanded it is two thirds of the screen and every drawn body
    // sits behind it — the chart is what the screen is for, and a control
    // panel over an empty patch of stars is not a map. The desktop panel is a
    // corner instrument and opens standing. Seeded once, then it is the
    // session's to remember.
    if (!this.mapPanelSeeded) {
      this.mapPanelSeeded = true;
      this.mapHud.setPanelCollapsed(false);
      this.mapPanelCollapsedPref = this.isPhoneLayout();
    }
    this.mapPanelCollapsed = this.mapPanelCollapsedPref;
    this.mapHud.setPanelCollapsed(this.mapPanelCollapsed);
    // The find-a-body list is the chart's roster gated by the camera's own
    // accept rule, so every row is a body the pick will actually reach; the
    // 'here' pill is the landed body and nothing else.
    this.mapHud.setFocusRows(buildMapFocusRows(
      (name) => this.systemMap!.acceptsFocus(name),
      this.landedOn?.name ?? null,
    ));
    this.mapFollowingPainted = null;
    this.mapZoomReadoutQ = Number.NaN;
    // The chart reopens with the session's layers; close() left it on the
    // defaults so the corner chart could never inherit them.
    this.applyMapLayers();
    // The gestures the buttons cannot show, for the first map of the session.
    this.showMapZoomHint();
    this.updateMapView();
  }

  /**
   * Close the map. Idempotent (a commit re-enters via applyLandedTarget /
   * exitLandedMode). `restore` defaults on for the user gestures (M, Esc, the
   * close chip) — those reopen the panel / re-enter surface view; a
   * reverse-close from another front door passes `restore: false`.
   */
  private closeMap(opts: { restore?: boolean } = {}) {
    if (!this.isMapOpen()) return;
    const restore = opts.restore ?? true;
    const restorePanel = this.mapRestorePanel;
    const restoreSurface = this.mapRestoreSurface;
    this.mapRestorePanel = false;
    this.mapRestoreSurface = false;

    // Kill any in-flight dive: bump the token so a pending commit never fires,
    // drop the picked-body card. The one exception is the dive's OWN commit,
    // which sets mapCommitting so the fade stays black for the hand-off.
    this.mapDiveGen++;
    this.mapDiving = false;
    this.mapDiveVerb = null;
    this.mapDiveTarget = null;
    this.mapDiveTeleport = null;
    this.mapPicked = null;
    this.cancelMapEventSearch();
    if (!this.mapCommitting) this.clearDiveFade();

    this.systemMap?.close();
    // The gesture guide goes with the chart: landing, takeoff, deactivation, a
    // mission start, M and Esc all reach here, so no close path has to
    // remember it on its own. The collapsed/open preference deliberately does
    // NOT reset — that is the one thing the session keeps.
    this.mapHelpOpen = false;
    this.mapHud.setHelpOpen(false);
    this.mapHud.hide();
    // The zoom pair goes down with the layer, so a held run has nothing left to
    // press against; the hint goes with it whether or not its own clock ran out.
    this.stopMapZoomHold();
    this.hideMapZoomHint();
    // Drop the hover latch whole — the held body, the stored pointer, and the
    // cursor the map's own feedback left on the canvas.
    this.resetMapHover();
    document.body.classList.remove('system-map-active');
    // A held key must not survive the map — closing with W down would otherwise
    // resume phantom thrust the moment processInput reads the flight keys again.
    this.keys.clear();
    // Nor an armed pick gesture: ids are recycled across gestures, so a
    // stranded one could commit a later, unrelated tap. Same for a half-made
    // double-tap — the next open starts from nothing.
    this.mapPickPointerId = null;
    this.mapPickPoisoned = false;
    this.mapTapName = null;
    // The teleport gesture goes with the chart it was aimed at, armed or
    // offered. (Deactivation reaches this through its own closeMap.)
    this.cancelMapLongPress();
    this.dismissMapTeleportChip();
    // Give the canvas back to the world only when the mode is live: a teardown
    // close (deactivate) must leave the touch zone and controls inert, or it
    // re-arms the very controls deactivate just retired.
    if (this.active) {
      this.setTouchFlightZoneHidden(false);
      // The chase reseats itself, landed orbit controls resume (the activate() rule).
      this.controls.enabled = !!this.landedOn || !this.isTouchDevice;
    }
    this.setWorldLabelsVisible(this.showBodyLabels);

    // Surface view first (it closes the panel on entry), then the panel — so a
    // sky watched with the panel open comes back exactly as it was left.
    if (restore && restoreSurface) {
      const pick = this.relevantObservatoryEvent() ? null : this.surfacePickedTarget;
      if (pick) this.enterSurfaceView(pick, 'companion');
      else this.enterSurfaceView();
    }
    if (restore && restorePanel) this.openObservatoryPanel();
  }

  // ── System map: the zoom pair and the gesture hint ──────────────────────

  /**
   * Wire one zoom button. `dir` is +1 for closer, −1 for further.
   *
   * The press spends its first notch on pointerdown and then keeps spending
   * while the button is held. Every way a hold can end is covered: the button's
   * own release and cancel, the capture it took being lost to something else,
   * the window losing focus (wired with the other stranded-gesture cleanups),
   * the map closing, and the camera reaching the clamp — that last one is the
   * one a timer cannot see, so the notch itself reports it.
   */
  private bindMapZoomButton(id: string, dir: number): void {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('pointerdown', (e) => {
      const ev = e as PointerEvent;
      // Left button / touch / pen only: a right-click must not start a run
      // that its own release never ends.
      if (ev.button !== 0) return;
      ev.preventDefault();
      this.stopMapZoomHold();
      if (!this.mapZoomBy(dir)) return;
      // Capture so a finger that slides off the button still delivers its
      // release here; the lost-capture handler is the backstop for the times
      // the browser takes it away instead.
      try { btn.setPointerCapture(ev.pointerId); } catch { /* no capture available */ }
      this.mapZoomHoldPointerId = ev.pointerId;
      this.mapZoomHoldDir = dir;
      this.mapZoomHoldRepeats = 0;
      this.scheduleMapZoomRepeat(PlanetariumMode.MAP_ZOOM_HOLD_DELAY_MS);
    });
    const release = (e: Event): void => {
      const pid = (e as PointerEvent).pointerId;
      if (this.mapZoomHoldPointerId !== null && pid !== this.mapZoomHoldPointerId) return;
      this.stopMapZoomHold();
    };
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('lostpointercapture', release);
    // Keyboard activation arrives as a click with no pointer behind it (detail
    // 0) and never touches the pointer path above, so it is the whole press.
    btn.addEventListener('click', (e) => {
      if ((e as MouseEvent).detail !== 0) return;
      this.mapZoomBy(dir);
    });
  }

  /** One notch, through the same guards a scale-segment press meets: a running
   *  dive owns the camera whether or not it is the kind that moves it, so the
   *  mode's own flag is checked as well as the map's camera state. */
  private mapZoomBy(dir: number): boolean {
    if (!this.systemMap?.isOpen() || this.mapDiving) return false;
    return this.systemMap.zoomNotches(dir);
  }

  private scheduleMapZoomRepeat(delayMs: number): void {
    this.mapZoomHoldTimer = window.setTimeout(() => {
      this.mapZoomHoldTimer = 0;
      if (this.mapZoomHoldPointerId === null) return;
      const step = Math.min(
        PlanetariumMode.MAP_ZOOM_REPEAT_MAX,
        1 + Math.floor(this.mapZoomHoldRepeats / PlanetariumMode.MAP_ZOOM_REPEAT_RAMP),
      );
      this.mapZoomHoldRepeats++;
      // The clamp is the stop: a notch that cannot move the camera ends the
      // run rather than repeating against a shell it has already reached.
      if (!this.mapZoomBy(this.mapZoomHoldDir * step)) {
        this.stopMapZoomHold();
        return;
      }
      this.scheduleMapZoomRepeat(PlanetariumMode.MAP_ZOOM_HOLD_REPEAT_MS);
    }, delayMs);
  }

  private stopMapZoomHold(): void {
    if (this.mapZoomHoldTimer) {
      window.clearTimeout(this.mapZoomHoldTimer);
      this.mapZoomHoldTimer = 0;
    }
    this.mapZoomHoldPointerId = null;
    this.mapZoomHoldDir = 0;
    this.mapZoomHoldRepeats = 0;
  }

  /** Paint the pair's enabled state from the map's own predicate — never from
   *  the controls' distance clamps, which are rewritten every frame. Writes
   *  only on a change. */
  private refreshMapZoomButtons(map: SystemMap): void {
    const avail = map.zoomAvailability(this.mapZoomAvail);
    // A running dive owns the camera even when it is the fade-only kind the
    // map's camera state knows nothing about.
    const live = !this.mapDiving;
    this.setMapZoomButtonEnabled('map-zoom-in', live && avail.zoomIn, true);
    this.setMapZoomButtonEnabled('map-zoom-out', live && avail.zoomOut, false);
  }

  private setMapZoomButtonEnabled(id: string, enabled: boolean, isIn: boolean): void {
    if (enabled === (isIn ? this.mapZoomInEnabled : this.mapZoomOutEnabled)) return;
    if (isIn) this.mapZoomInEnabled = enabled;
    else this.mapZoomOutEnabled = enabled;
    const btn = document.getElementById(id) as HTMLButtonElement | null;
    if (btn) btn.disabled = !enabled;
    // A button that goes dead under a held finger takes its run with it.
    if (!enabled && this.mapZoomHoldDir === (isIn ? 1 : -1)) this.stopMapZoomHold();
  }

  /** The gesture hint, for the first map of the session. */
  private showMapZoomHint(): void {
    if (this.mapZoomHintSeen) return;
    const el = document.getElementById('map-zoom-hint');
    if (!el) return;
    // Shown once, marked once: closing the map before the line has faded still
    // counts, or every open would re-teach the same thing.
    this.mapZoomHintSeen = true;
    this.mapZoomHintShown = true;
    this.dockMapZoomHint(el);
    el.classList.add('visible');
    this.mapZoomHintTimer = window.setTimeout(
      () => this.hideMapZoomHint(),
      PlanetariumMode.MAP_ZOOM_HINT_MS,
    );
  }

  /** Dock the hint clear of the dock. The block is two lines and grows
   *  UPWARD, and on a phone the dock owns the band it would land in — the
   *  full-width sheet no less than the folded two-chip dock — so the hint
   *  sits above whichever of them is standing. A desktop keeps the
   *  stylesheet's floor; the corner instrument is beside the centred line,
   *  not under it. */
  private dockMapZoomHint(el: HTMLElement): void {
    const rect = this.isPhoneLayout()
      ? document.getElementById('map-dock')?.getBoundingClientRect()
      : null;
    el.style.bottom = rect && rect.height > 0
      ? `${Math.round(window.innerHeight - rect.top + 8)}px`
      : '';
  }

  /** The sheet grew or shrank under a hint that measured its dock once, when
   *  it was shown. */
  private redockMapZoomHint(): void {
    if (!this.mapZoomHintShown) return;
    const el = document.getElementById('map-zoom-hint');
    if (el) this.dockMapZoomHint(el);
  }

  private hideMapZoomHint(): void {
    if (this.mapZoomHintTimer) {
      window.clearTimeout(this.mapZoomHintTimer);
      this.mapZoomHintTimer = 0;
    }
    if (!this.mapZoomHintShown) return;
    this.mapZoomHintShown = false;
    document.getElementById('map-zoom-hint')?.classList.remove('visible');
  }

  private setMapScale(trueScale: boolean) {
    // A dive owns the camera; a scale change mid-dive would capture a zoom ratio
    // from the half-dived pose and corrupt the post-cancel restore. Only
    // close/cancel/skip escape a dive — refuse and reflect nothing on the HUD.
    if (!this.systemMap || this.mapDiving) return;
    this.systemMap.setScale(trueScale);
    this.mapHud.render(trueScale);
  }

  /** Per-frame map refresh — called at the end of both update branches once
   *  positions are final. The map recomputes bodies from the clock; it never
   *  reads mid-frame scene state. */
  private updateMapView() {
    if (!this.systemMap?.isOpen()) return;
    // The card's next-event sweep runs BEFORE the chart's update on purpose:
    // its first result adds the event row and grows the phone's bottom sheet,
    // and the label pass inside the update measures the card to duck labels
    // under it — a row landing after that pass would leave one frame of names
    // painted beneath the taller card. The sweep reads only the clock and its
    // own cursors, so nothing here needs the update to have run.
    this.updateMapEventSearch();
    // The panel's own rows follow the camera state from the map's predicates;
    // the map has no HUD reference of its own, so the per-frame refresh owns
    // them. Greying a row changes nothing about the chart's geometry — the
    // panel holds its size and place whatever its buttons say.
    const cam = this.systemMap.getCameraState();
    // A running dive owns the camera even when it is the fade-only kind the
    // map's own state knows nothing about, so the mode's flag joins both.
    const cameraFree = !this.mapDiving;
    this.mapHud.setOverviewEnabled(
      cameraFree && mapOverviewAvailable(cam, this.systemMap.isZoomFree()),
    );
    // The course as a VECTOR, from the ship's own forward math — the chart
    // charts a point one step along it and never re-derives a heading of its
    // own. Landing goes over whole: the chart places the marker differently on
    // a moon (inside its system's drawn space) than on a planet.
    const fwd = this.player.writeForwardDirection(this.mapShipForward);
    this.systemMap.update(
      this.timeState.currentUtcMs,
      this.player.posX,
      this.player.posY,
      this.player.posZ,
      fwd.x,
      fwd.y,
      fwd.z,
      // Effective motion — held reads as still, same as the corner chart.
      this.player.moving && !this.player.held,
      this.landedOn,
      this.lastFrameDtMs,
    );
    // Hover after the bodies have moved and before anything reads the frame:
    // the anchors this resolves against are the ones just written.
    this.updateMapHover();
    // And the teleport chip, which rides a point rather than a body: the
    // camera it projects against has just been written too.
    this.updateMapTeleportChip();
    // Live distance on the open card (writes only on a change), and mirror the
    // arrival-busy state onto the verb buttons.
    if (this.mapPicked && this.mapHud.isCardOpen()) {
      const distAU = this.systemMap.trueDistanceFromShip(
        this.mapPicked.name,
        this.player.posX,
        this.player.posY,
        this.player.posZ,
      );
      // Reformat only when the shown value changes — the raw distance drifts
      // every frame but the string does not. A body the chart stops being able
      // to measure keeps the last distance it reported rather than reading zero.
      if (distAU !== null) {
        const q = bodyDistanceQuantum(distAU);
        if (q !== this.mapCardDistQ) {
          this.mapCardDistQ = q;
          this.mapHud.setDistanceText(formatBodyDistance(distAU));
        }
      }
      this.mapHud.setActionsDisabled(this.arrivalInFlight);
    }
    // The zoom pair follows the camera state from the map's own predicate; the
    // map has no HUD reference of its own, so the per-frame refresh owns it.
    this.refreshMapZoomButtons(this.systemMap);
    this.refreshMapPanelReadouts();
    // The hint has said its piece once the chart has been zoomed by hand.
    if (this.mapZoomHintShown && this.systemMap.sawZoomGesture()) this.hideMapZoomHint();
    // Advance an in-flight dive / autopilot-close transition.
    if (this.mapDiving) this.advanceMapTransition();
  }

  /**
   * The panel's two live readouts, refreshed after the chart has settled this
   * frame: how far in the camera is, and which row of the find-a-body list is
   * the one being ridden.
   *
   * Both write only on a change. The readout is quantized first so the string
   * is built only when the printed number moves; the chip's repaint keys on
   * the pair (followed body, is a release actually on offer) — the chip is the
   * release control, and one shown during the flight home would offer a
   * journey already under way.
   */
  private refreshMapPanelReadouts(): void {
    const map = this.systemMap;
    if (!map) return;
    const ratio = map.zoomRatio();
    const q = mapZoomReadoutQuantum(ratio);
    if (q !== this.mapZoomReadoutQ) {
      this.mapZoomReadoutQ = q;
      this.mapHud.setZoomReadout(formatMapZoomRatio(ratio));
    }
    const cam = map.getCameraState();
    const following = mapFocusReleasable(cam) ? cam.focusName : null;
    if (following !== this.mapFollowingPainted) {
      this.mapFollowingPainted = following;
      this.mapHud.setFollowing(following);
    }
    // The rings row keys on the COMMITTED scale, not the blend: the switch
    // should wake the moment True scale is pressed, and the rings arrive when
    // the animation lands. Writes on change.
    this.mapHud.setRingsRowDim(!map.isTrueScale());
  }

  /**
   * A chart layer was switched. The session holds the answer; the chart is
   * told only while it is open — a closed map is on the defaults, and writing
   * a session layer into it would leak straight into the corner chart, which
   * draws the same objects.
   */
  private setMapLayer(key: keyof MapLayerState, on: boolean): void {
    if (this.mapLayers[key] === on) return;
    this.mapLayers = { ...this.mapLayers, [key]: on };
    this.applyMapLayers();
  }

  private applyMapLayers(): void {
    if (this.isMapOpen()) this.systemMap?.setLayers(this.mapLayers);
    this.mapHud.setLayers(this.mapLayers);
  }

  // ── System map: pick → card → commit, and the dive ──────────────────────

  /** Canvas pointerdown while the map owns the frame — remember the down point
   *  so pointerup can tell a tap (a pick) from a drag (an orbit gesture). */
  private mapPointerDown(e: PointerEvent) {
    if (!this.isMapOpen()) return;
    const pointerType = e.pointerType || 'mouse';
    // A finger or a pen takes over: the stored mouse position no longer says
    // anything about where anyone is pointing. This runs before every gate
    // below — a touch that arrives during a dive, during a camera flight, or
    // as the second pointer of a gesture still ends the mouse's hover, and a
    // reset left downstream of those would leave the emphasis and the stored
    // position alive to be picked up again with no mouse in the room.
    if (pointerType !== 'mouse') this.resetMapHover();
    // A second tap while the camera dives skips straight to the fade.
    if (this.mapDiving) {
      if (this.mapDiveIsCamera) this.skipMapDive();
      return;
    }
    // A flight is under way: arm nothing. The release lands after the camera
    // has, and a gesture armed here would pick whatever the flight brought
    // under the pointer — a body the user never aimed at.
    if (this.isMapCameraFlying()) {
      this.poisonMapPick();
      return;
    }
    if (e.button !== 0) return;
    // One gesture end to end: a second finger (pinch zoom) must not rebind the
    // armed tap or move its down point — releasing the pinch would then read
    // as a tap wherever that finger landed. The id stays armed until ITS
    // pointerup/cancel (or blur/close) releases it, the same contract as the
    // cruise chase drag. The second finger also POISONS the armed tap: a pinch
    // can zoom while the first finger holds perfectly still, and that first
    // finger's release must not read as a tap either.
    if (this.mapPickPointerId !== null) {
      this.mapPickPoisoned = true;
      this.mapPickHeldName = null;
      // A second finger is a pinch, not a hold — whatever the first one was
      // resting on, this gesture is about zooming now.
      this.cancelMapLongPress();
      return;
    }
    // macOS ctrl-click is the context-menu gesture, and it arrives as a
    // PRIMARY pointerdown as well as a contextmenu event. Arming a pick for it
    // would let the release dismiss the offer that same gesture just made.
    if (e.ctrlKey) {
      this.poisonMapPick();
      return;
    }
    this.mapPickPoisoned = false;
    this.mapPickPointerId = e.pointerId;
    this.mapPickDownX = e.clientX;
    this.mapPickDownY = e.clientY;
    this.mapPickPointerType = pointerType;
    this.mapPickHeldName = null;
    // A finger or a pen has no right button; the hold is its way of naming a
    // place. A mouse has one, and a mouse hold is how the map is dragged.
    if (pointerType !== 'mouse') {
      this.armMapLongPress(e);
      return;
    }
    // A click commits the body the emphasis names. If the press lands on the
    // live hold's anchor, that body is what this gesture is for — snapshotted
    // here, at DOWN, so the release never re-picks a chart that has moved on.
    if (this.mapHoverName && this.mapHoverValid) {
      const rect = this.renderer.domElement.getBoundingClientRect();
      const dx = e.clientX - rect.left - this.mapHoverAnchorX;
      const dy = e.clientY - rect.top - this.mapHoverAnchorY;
      if (Math.hypot(dx, dy) <= HOVER_RECLAIM_MOVE_PX) this.mapPickHeldName = this.mapHoverName;
    }
  }

  /** Canvas pointerup while the map owns the frame: a small-travel gesture is a
   *  pick. A body opens (or replaces) the card, the ship marker is inert, empty
   *  space dismisses the card. */
  private mapPointerUp(e: PointerEvent) {
    if (!this.isMapOpen()) return;
    // The lift ends the hold whether or not this pointer still owns a pick —
    // a matured hold has already disarmed the pick, and its timer must not be
    // left running against the next gesture.
    if (this.mapTpPressPointerId === e.pointerId) this.cancelMapLongPress();
    if (this.mapPickPointerId !== e.pointerId) return;
    // Disarm BEFORE the dive check: a release that arrives mid-dive must still
    // end its gesture, or the stranded id would tap against this gesture's
    // stale down point after the dive (pointer ids are recycled — a mouse
    // reuses one id for every click).
    this.mapPickPointerId = null;
    const poisoned = this.mapPickPoisoned;
    const held = this.mapPickHeldName;
    this.mapPickPoisoned = false;
    this.mapPickHeldName = null;
    if (poisoned) {
      // A pinched or dragged gesture is not a tap, so it cannot be half of a
      // double-tap either.
      this.mapTapName = null;
      return;
    }
    // Taps stand down while the camera writes its own pose: the body under the
    // pointer is not the body that will be there a frame later.
    if (this.mapDiving || this.isMapCameraFlying() || !this.systemMap) return;
    if (!isTap(this.mapPickDownX, this.mapPickDownY, e.clientX, e.clientY)) return;
    // A tap on the chart is the chart's again: whatever the panel had open
    // over it steps aside, whether the tap lands on a body or on empty space.
    // A standing teleport offer is one of those things — the chip's own press
    // never reaches the canvas, so a tap out here is the answer "not there".
    this.setMapHelpOpen(false);
    this.dismissMapTeleportChip();
    // A press that landed on the emphasis commits what the emphasis named, with
    // no second look at a chart that has moved since. The declared consequence:
    // a press on apparently empty space that is in fact the hold's anchor opens
    // the held body rather than dismissing the card — which is the rule working,
    // since the body slid off that pixel between the frame and the finger.
    let name = held;
    if (!name) {
      const rect = this.renderer.domElement.getBoundingClientRect();
      const hit = this.systemMap.pick(e.clientX - rect.left, e.clientY - rect.top, this.mapPickPointerType);
      if (hit.kind !== 'body') {
        // Anything but a body ends the run: a tap elsewhere and back must not
        // read as two taps on the same body.
        this.mapTapName = null;
        if (hit.kind === 'empty') this.dismissMapCard();
        // 'ship' is inert — swallow, dismiss nothing.
        return;
      }
      name = hit.name;
    }
    this.openMapCard(name);
    const now = performance.now();
    const doubled = this.mapTapName === name && now - this.mapTapAtMs <= MAP_DOUBLE_TAP_MS;
    // Consume the candidate on a double, so a third tap starts a fresh run.
    this.mapTapName = doubled ? null : name;
    this.mapTapAtMs = now;
    if (doubled) this.focusMapBody(name);
  }

  /** A cancelled or off-canvas-released gesture (palm rejection, system
   *  gesture take-over, drag ending over the HUD or a lost capture) disarms
   *  the pick without committing anything. Also bound at the window level —
   *  after an on-canvas release the canvas handler has already disarmed, so
   *  the window pass is a no-op there. */
  private mapPointerCancel(e: PointerEvent) {
    if (this.mapTpPressPointerId === e.pointerId) this.cancelMapLongPress();
    if (this.mapPickPointerId === e.pointerId) {
      this.mapPickPointerId = null;
      this.mapPickPoisoned = false;
      this.mapTapName = null;
      this.mapPickHeldName = null;
    }
  }

  /** Fine-pointer hover: remember where the cursor is. What is under it is
   *  decided per frame (updateMapHover) — a body crossing a cursor that has not
   *  moved sends no event, and at a year a second that is most of them. */
  private mapPointerMove(e: PointerEvent) {
    if (!this.isMapOpen()) return;
    // Travel latch: once the armed pointer leaves the tap slop the gesture can
    // never be a tap again, even if it wanders back — an endpoint-only test
    // would read an out-and-back orbit drag as a tap on the down point.
    if (e.pointerId === this.mapPickPointerId
      && !isTap(this.mapPickDownX, this.mapPickDownY, e.clientX, e.clientY)) {
      this.mapPickPoisoned = true;
      this.mapTapName = null;
      this.mapPickHeldName = null;
      // The hold rides the SAME slop, through the same latch: a finger that has
      // travelled far enough to be a drag is orbiting the chart, not naming a
      // place on it.
      this.cancelMapLongPress();
    }
    if (e.pointerType !== 'mouse') return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mapHoverX = e.clientX - rect.left;
    this.mapHoverY = e.clientY - rect.top;
    this.mapHoverValid = true;
  }

  /** The cursor left the canvas — for the HUD, the card, or the window. Nothing
   *  is under it any more, and without this the per-frame path would keep
   *  acquiring bodies under a pointer parked on the card. */
  private mapPointerLeave() {
    if (!this.isMapOpen()) return;
    this.resetMapHover();
  }

  /**
   * Per-frame hover: what is under the resting cursor right now, held through
   * the near misses and the fly-bys that a chart at warp produces, and released
   * once the hold has lapsed or the pointer has aimed somewhere else.
   *
   * Runs on exactly the gates the pointer handlers already use — a dive is
   * broader than the camera predicate (an Autopilot commit dives with the
   * camera left alone) and hover must stay dead through that fade too.
   */
  private updateMapHover() {
    const map = this.systemMap;
    if (!map || !this.mapHoverValid) return;
    if (this.mapDiving || this.isMapCameraFlying()) return;
    // One anchor rebuild per frame, which is the point: the anchors ARE this
    // frame's screen positions, and a cached set would answer with last
    // frame's — the bug the latch exists to fix.
    const candidate = map.hoverAt(this.mapHoverX, this.mapHoverY);
    const now = performance.now();
    // A held body the limb gate has since hidden releases NOW, not at the
    // hold's timeout: its anchor is gone, so the hold could only bridge a tap
    // onto something the screen no longer shows.
    const held = this.mapHoverName !== null && map.isBodyOccluded(this.mapHoverName)
      ? null
      : this.mapHoverName;
    const resolved = resolveMapHover(
      held,
      candidate,
      now - this.mapHoverHitMs,
      Math.hypot(this.mapHoverX - this.mapHoverAnchorX, this.mapHoverY - this.mapHoverAnchorY),
    );
    // A confirmed hit — the candidate won, whether it was adopted or refreshed
    // — restamps the hold. A hold surviving a miss keeps the anchor it was
    // confirmed at, so a slow drift away from it still adds up to a release.
    if (resolved !== null && resolved === candidate) {
      this.mapHoverHitMs = now;
      this.mapHoverAnchorX = this.mapHoverX;
      this.mapHoverAnchorY = this.mapHoverY;
    }
    // On the transition only: the chip's text is a catalog lookup, and the
    // hover resolves every frame.
    if (resolved !== this.mapHoverName) {
      this.mapHud.setHoverMeta(resolved === null ? null : mapHoverMeta(resolved));
    }
    this.mapHoverName = resolved;
    map.setHover(resolved);
    this.setMapHoverCursor(resolved !== null);
  }

  /** The canvas cursor, written only when it changes. */
  private setMapHoverCursor(pointer: boolean) {
    if (pointer === this.mapHoverCursor) return;
    this.mapHoverCursor = pointer;
    this.renderer.domElement.style.cursor = pointer ? 'pointer' : '';
  }

  /** Drop the latch and everything it shows: the held body, its timer and
   *  anchor, the cursor, the emphasis on the chart and the chip that named
   *  what was under it — but KEEP the stored pointer valid. With the name
   *  null and the stamps zeroed, the next per-frame pass acquires fresh (the
   *  latch's elapsed/distance arguments only gate an EXISTING hover), so this
   *  is safe for a gesture that merely suspends hovering: a focus or release
   *  flight ends with the cursor still parked over the chart, and hover comes
   *  back on its own. The chip is the piece a per-frame writer cannot retract
   *  itself — the frame pass stands down the moment a flight or dive starts,
   *  so the clear has to come from the gesture that started it. */
  private retractMapHover() {
    this.mapHoverName = null;
    this.mapHoverHitMs = 0;
    this.mapHoverAnchorX = 0;
    this.mapHoverAnchorY = 0;
    this.mapPickHeldName = null;
    this.systemMap?.setHover(null);
    this.mapHud.setHoverMeta(null);
    this.setMapHoverCursor(false);
  }

  /** Retract AND invalidate the stored pointer: for paths where the pointer
   *  itself is gone or about to be lied about — close, dive, pointerleave,
   *  blur, a non-mouse takeover. After this, hover stays down until a real
   *  pointermove restores a position worth resolving. */
  private resetMapHover() {
    this.retractMapHover();
    this.mapHoverValid = false;
  }

  /** Open (or replace in place) the picked-body card. Pairs with the time /
   *  stats popovers one-instrument-at-a-time. */
  private openMapCard(name: string) {
    // The commit target comes from the roster, so a moon arrives at the card
    // carrying its parent — the shape the landed body and every commit already
    // speak in. A name the chart does not know opens nothing.
    const target = mapBodyRefFor(name);
    if (!target) return;
    this.mapPicked = target;
    // One instrument at a time — fold the bottom-bar popovers and the gesture
    // guide away. On a phone the sheet folds to its chip as well: at 320 px
    // an expanded sheet and this card cannot both be read, and what gives is
    // the control the user is not looking at.
    this.bottomBar.closeTime();
    this.bottomBar.closeStats();
    this.setMapHelpOpen(false);
    if (!this.mapPanelCollapsed && this.isPhoneLayout()) {
      this.setMapPanelCollapsed(true, { bank: false });
    }
    // A body is a different answer to "where do you want to go": the offer of
    // a bare point steps aside for it.
    this.dismissMapTeleportChip();
    const actions = mapCardActions(target, this.landedOn);
    const color = this.bodyTintCss(name);
    // Zero only while there is no map open to measure against.
    const distAU = this.systemMap?.trueDistanceFromShip(
      name,
      this.player.posX,
      this.player.posY,
      this.player.posZ,
    ) ?? 0;
    this.mapCardDistQ = bodyDistanceQuantum(distAU);
    // The facts are resolved here and handed over finished — the HUD paints
    // them and knows nothing about catalogs.
    const facts = mapFactRows(name);
    this.mapHud.showCard(
      bodyDisplayName(name),
      color,
      formatBodyDistance(distAU),
      actions,
      this.arrivalInFlight,
      facts.rows,
      facts.oneLiner,
    );
    // A new card is a new system to watch: the row starts empty (showCard
    // cleared it) and fills in as the sweep finds something.
    this.startMapEventSearch();
  }

  private dismissMapCard() {
    if (!this.mapHud.isCardOpen()) return;
    this.mapHud.hideCard();
    this.mapPicked = null;
    this.cancelMapEventSearch();
  }

  // ── System map: the card's next-event row ───────────────────────────────

  /**
   * (Re)start the sweep behind the card's event row, over the system the
   * picked body belongs to. A body whose sky has nothing to report (the Sun,
   * a moonless planet) clears the row instead.
   *
   * `preserveValidResults` is the hand-over case: the shown event has ended,
   * so drop the finished ones and keep the rest while the new sweep re-fills —
   * the row moves to the next event instead of blanking and coming back.
   */
  private startMapEventSearch(opts?: { preserveValidResults?: boolean }) {
    const picked = this.mapPicked;
    const parentPlanet = picked && this.mapHud.isCardOpen()
      ? mapEventSearchTarget(picked.name)
      : null;
    if (!parentPlanet) {
      this.cancelMapEventSearch();
      return;
    }
    if (opts?.preserveValidResults) {
      const now = this.timeState.currentUtcMs;
      for (const [key, event] of this.mapEventResults) {
        if (event.endUtcMs <= now) this.mapEventResults.delete(key);
      }
    } else {
      this.mapEventResults.clear();
    }
    this.mapEventFromUtcMs = this.timeState.currentUtcMs;
    this.mapEventSearch = startShadowEventSearch(parentPlanet, this.mapEventFromUtcMs);
    resetMapEventReverseLatch(this.mapEventReverseLatch);
    this.publishMapEvent();
  }

  private cancelMapEventSearch() {
    this.mapEventSearch = null;
    this.mapEventResults.clear();
    this.mapEventRowEvent = null;
    this.mapEventFromUtcMs = Number.NaN;
    resetMapEventReverseLatch(this.mapEventReverseLatch);
    this.mapHud.setEventRow(null);
  }

  /**
   * One frame of the card's sweep, plus the periodic guard that decides when
   * the sweep's answer has gone stale. Called from the map's per-frame refresh,
   * so it runs in both update branches and stops with the map.
   */
  private updateMapEventSearch() {
    if (!this.mapHud.isCardOpen()) return;
    const reverse = mapEventReverseRunning(this.timeState.rate, this.timeState.paused);
    latchMapEventReverse(this.mapEventReverseLatch, this.timeState.rate, this.timeState.paused);
    const nowMs = performance.now();
    if (nowMs - this.mapEventGuardAtMs >= PlanetariumMode.UI_REFRESH_INTERVAL_S * 1000) {
      this.mapEventGuardAtMs = nowMs;
      const action = guardMapEvent(this.mapEventReverseLatch, {
        nowUtcMs: this.timeState.currentUtcMs,
        timeRate: this.timeState.rate,
        paused: this.timeState.paused,
        searching: this.mapEventSearch !== null,
        fromUtcMs: this.mapEventFromUtcMs,
        rowEndUtcMs: this.mapEventRowEvent?.endUtcMs ?? null,
      });
      if (action === 'restart') this.startMapEventSearch();
      else if (action === 'restart-preserve') {
        this.startMapEventSearch({ preserveValidResults: true });
      }
    }
    if (reverse) {
      // A "next event" measured against a clock running the other way is not a
      // fact about anything. The row goes; the sweep waits for the clock.
      this.mapEventRowEvent = null;
      this.mapHud.setEventRow(null);
      return;
    }
    const search = this.mapEventSearch;
    if (!search) return;
    const done = stepShadowEventSearch(
      search,
      PlanetariumMode.OBSERVATORY_SEARCH_FRAME_BUDGET_MS,
      this.eventSearchSlice,
    );
    for (const event of this.eventSearchSlice) {
      this.mapEventResults.set(shadowEventSpecKey(event.spec), event);
    }
    if (this.eventSearchSlice.length > 0 || done) this.publishMapEvent();
    if (done) this.mapEventSearch = null;
  }

  /** Put the soonest event found so far on the card — the sky's next word about
   *  this system. Nothing found yet says nothing: a chart narrating its own
   *  search would be noise where the Observatory's list has room for a status. */
  private publishMapEvent() {
    let soonest: ShadowEvent | null = null;
    for (const event of this.mapEventResults.values()) {
      if (!soonest || event.peakUtcMs < soonest.peakUtcMs) soonest = event;
    }
    this.mapEventRowEvent = soonest;
    if (!soonest) {
      this.mapHud.setEventRow(null);
      return;
    }
    // The panel's own words for the same event, so one sky reads one way.
    const includeYear = Math.abs(soonest.peakUtcMs - this.timeState.currentUtcMs)
      > 300 * 86_400_000;
    this.mapHud.setEventRow({
      label: PlanetariumMode.shadowEventLabel(soonest.spec),
      when: formatEventRowTime(soonest.peakUtcMs, includeYear),
    });
  }

  /**
   * The row is the warp: park the clock just before the event at 1×, running,
   * and leave the chart exactly where it is — the point is to watch the system
   * do it on the diagram you are already reading.
   */
  private warpToMapEvent() {
    const event = this.mapEventRowEvent;
    if (!event || !this.isMapOpen()) return;
    // Park shortly before the peak with the clock running at real time, the
    // way an event jump from the panel does — the user watches it happen
    // rather than landing on a frozen peak. setCurrentUtcMs rebuilds the world
    // positions, the time readout and the Sun-optics baseline itself.
    this.timeState = { ...this.timeState, rate: 1, paused: false };
    this.setCurrentUtcMs(event.peakUtcMs - OBSERVATORY_JUMP_LEAD_MS);
    // The landed scene is still standing behind the chart, and the clock just
    // moved under it.
    if (this.landedOn) this.refreshLandedScene();
    // Cross-instrument and deliberate: "the most recent event jump" is what the
    // Observatory's steppers dedupe against and what the surface HUD narrates,
    // and this jump IS the most recent one. Session-only — it is absent from
    // the saved state, so it never reaches disk.
    this.lastObservatoryEvent = event;
    // The clock has left the sweep's anchor far behind.
    this.startMapEventSearch();
    this.notification.show(this.describeShadowEvent(event));
  }

  /** Whether the map camera is writing its own pose — taps and hover stand down
   *  for the duration, the way they already do under a dive. */
  private isMapCameraFlying(): boolean {
    const cam = this.systemMap?.getCameraState();
    return !!cam && mapCameraOwnsPose(cam);
  }

  /** The card's Focus button: fly to the body the card names and follow it. The
   *  card stays open — this moves the camera and commits nothing, so the verbs
   *  are still one tap away on the body you are now looking at. */
  private focusMapCard(): boolean {
    return this.mapPicked ? this.focusMapBody(this.mapPicked.name) : false;
  }

  /** Focus entry shared by the card button, the double-tap, and the bridge. */
  private focusMapBody(name: string): boolean {
    if (!this.systemMap?.isOpen() || this.mapDiving) return false;
    this.poisonMapPick();
    this.dismissMapTeleportChip();
    const flying = this.systemMap.focusBody(name);
    // The hover pass stands down while the camera owns the pose, so the gesture
    // that starts the flight retracts the hover itself — or the chip and
    // emphasis ride the whole flight pointing at where a body used to be. The
    // pointer stays valid: it is still parked over the chart, and hover
    // re-acquires on its own when the flight ends.
    if (flying) this.retractMapHover();
    return flying;
  }

  /** The ◂ Overview chip and the Esc cascade's focus rung: fly back out. */
  private releaseMapFocus(): boolean {
    if (!this.systemMap?.isOpen() || this.mapDiving) return false;
    this.poisonMapPick();
    this.dismissMapTeleportChip();
    const flying = this.systemMap.releaseFocus();
    if (flying) this.retractMapHover();
    return flying;
  }

  /** End any gesture in progress without committing it: a held pointer keeps
   *  its id until its own release, so the way to void it is to poison it, the
   *  way a second finger does. A flight starting voids one for the same reason
   *  a pinch does — whatever it was aimed at is about to move. */
  private poisonMapPick(): void {
    if (this.mapPickPointerId !== null) this.mapPickPoisoned = true;
    this.mapTapName = null;
    this.mapPickHeldName = null;
    // An armed teleport hold is the same kind of half-made gesture, and it is
    // aimed at a chart that is about to move. (A hold that has already matured
    // disarms itself first, so this never cancels the press that called it.)
    this.cancelMapLongPress();
  }

  /** Whether Esc has a focus to release before it closes the map. Deliberately
   *  narrower than what the ◂ chip offers: the chip also re-fits a drifted
   *  overview, and Esc there closes the map, exactly as it always has. */
  private mapFocusActive(): boolean {
    const cam = this.systemMap?.getCameraState();
    return !!cam && mapFocusReleasable(cam);
  }

  /** The panel's Reset view row. Two journeys home behind one button: give a
   *  focus back, or — at an overview a free zoom has wandered off — re-fit the
   *  chart. Which one is on offer is what the row's own predicate says, and at
   *  the parked fit neither is, which is when the row greys out. */
  private mapOverviewPressed(): boolean {
    const map = this.systemMap;
    const cam = map?.getCameraState();
    if (!map?.isOpen() || !cam || this.mapDiving) return false;
    if (mapFocusReleasable(cam)) return this.releaseMapFocus();
    // A re-fit moves the camera under the pointer the same way a flight does.
    this.poisonMapPick();
    this.dismissMapTeleportChip();
    return map.recenterOverview();
  }

  // ── System map: the control panel ───────────────────────────────────────

  /** Stats and Time open into the panel's own corner, and both sit UNDER the
   *  map layer. While one of them is up the panel steps aside — and the help
   *  grid, which is only readable while the panel stands, goes with it. */
  private standMapPanelDown(down: boolean): void {
    if (!this.isMapOpen()) return;
    if (down) this.setMapHelpOpen(false);
    // The panel is label chrome — on a phone it is a full-width sheet the
    // labels dodge — and it just changed with no resize to announce it. That
    // announcement is the panel's own geometry door; nothing here repeats it.
    this.mapHud.setPanelStoodDown(down);
  }

  /** Whether the dock lays out as the phone's bottom sheet. Asked of the
   *  stylesheet's own media condition rather than of a rect: the panel now
   *  ANIMATES between its shapes, and a rect read mid-fold answers with the
   *  animation's progress, not the layout. (The card dock and the label pass
   *  still read rects — they want painted truth, not intent.) */
  private isPhoneLayout(): boolean {
    return isPhoneViewport();
  }

  /**
   * Fold the panel away, or bring it back. `bank` decides whether the session
   * remembers it: only the explicit collapse control speaks for the user, so
   * an Esc dismissal or the phone's card exclusion leaves the next map open
   * showing the panel exactly as before.
   */
  private setMapPanelCollapsed(collapsed: boolean, opts: { bank: boolean }): void {
    if (!this.isMapOpen()) return;
    if (opts.bank) this.mapPanelCollapsedPref = collapsed;
    if (collapsed === this.mapPanelCollapsed) return;
    this.mapPanelCollapsed = collapsed;
    // Folding the panel takes the open guide with it: the fold is a step
    // back from the corner, and a guide left floating beside a chip would
    // outrank the chart the fold just gave the screen to.
    if (collapsed) this.setMapHelpOpen(false);
    this.mapHud.setPanelCollapsed(collapsed);
    // The sheet is a band, and both the teleport chip and an open body card
    // would be under it — the card entirely so, at either phone size. The
    // exclusion runs BOTH ways: opening the card folds the sheet, and
    // unfolding the sheet dismisses the card. Desktop keeps both — the panel
    // is a corner instrument there, and they have room beside it. Layout
    // intent, not a rect: at this instant the sheet is one frame into its
    // unfold and still measures as the chip.
    if (!collapsed && this.isPhoneLayout()) {
      this.dismissMapTeleportChip();
      this.dismissMapCard();
    }
  }

  /** The gesture guide behind the `?` chip. It stands beside the panel, not
   *  in it, so a folded panel is no bar to reading it (the two-chip dock);
   *  nothing else opens WITH it — on a phone the guide and the body card are
   *  the same strip of screen. */
  private setMapHelpOpen(open: boolean): void {
    if (open) {
      if (!this.isMapOpen()) return;
      this.dismissMapCard();
      this.bottomBar.closeTime();
      this.bottomBar.closeStats();
    } else if (!this.mapHelpOpen) {
      return;
    }
    this.mapHelpOpen = open;
    this.mapHud.setHelpOpen(open);
  }

  private toggleMapHelp(): void {
    this.setMapHelpOpen(!this.mapHelpOpen);
  }

  /** A find-a-body row was picked: exactly what a double-tap on the chart does
   *  — the card opens on that body and the camera flies to it. */
  private pickMapFocusRow(name: string): void {
    if (!this.isMapOpen() || this.mapDiving) return;
    this.openMapCard(name);
    this.focusMapBody(name);
  }

  /** Whether the camera is already on its way back to the overview. */
  private isMapReleasing(): boolean {
    const cam = this.systemMap?.getCameraState();
    return !!cam && cam.camState === 'focusFly' && cam.flyGoal === 'overview';
  }

  /** The catalog tint of a map body as a CSS colour — planet, moon or the Sun,
   *  through the chart's one roster. White for a name it does not know, which
   *  no card path can produce. */
  private bodyTintCss(name: string): string {
    return cssHexColor(mapBody(name)?.color ?? 0xffffff);
  }

  /** A card verb was pressed (real tap or bridge). Teleport/Observatory dive;
   *  Autopilot fade-closes. Refused while an arrival is in flight. */
  private commitMapCard(verb: MapVerb): boolean {
    if (!this.isMapOpen()) return false;
    // A second press while the camera dives skips straight to the fade.
    if (this.mapDiving) {
      if (this.mapDiveIsCamera) this.skipMapDive();
      return false;
    }
    if (!this.mapPicked || this.arrivalInFlight) return false;
    const target = this.mapPicked;
    // Only a verb the card actually offers this pick may commit — guards the
    // bridge and any UI race where the pick changed under the click (a bare
    // mapCommit('observe') on the Sun must not try to land on it).
    if (!mapCardOffersVerb(target, this.landedOn, verb)) return false;
    // The transition takes over from here; nothing half-tapped and no standing
    // offer of somewhere else survives it.
    this.mapTapName = null;
    this.cancelMapLongPress();
    this.dismissMapTeleportChip();
    this.mapDiveVerb = verb;
    this.mapDiveTarget = target;
    // Autopilot never dives, and neither does a body the map camera may not
    // visit: the transition falls back to the plain fade-close rather than
    // running a camera ease the map has refused, which would hold the black
    // wall for the length of a dive that never happened.
    this.mapDiveIsCamera = verb !== 'pilot' && !!this.systemMap?.beginDive(target.name);
    this.mapDiving = true;
    // The chart is about to be left behind; nothing on it is under the cursor
    // any more, whichever kind of transition this is.
    this.resetMapHover();
    this.mapTransitionStartMs = performance.now();
    this.mapDiveActiveGen = ++this.mapDiveGen;
    this.journeyCommitGen++;
    return true;
  }

  /** Per-frame transition driver (called from updateMapView while mapDiving). */
  private advanceMapTransition() {
    if (this.mapDiveActiveGen !== this.mapDiveGen) return; // superseded
    const e = performance.now() - this.mapTransitionStartMs;
    if (this.mapDiveIsCamera) {
      const camT = Math.min(1, e / PlanetariumMode.DIVE_CAM_MS);
      this.systemMap?.setDivePose(camT * camT); // ease-in
      const fade = Math.max(0, Math.min(1, (e - PlanetariumMode.DIVE_CAM_MS) / PlanetariumMode.DIVE_FADE_MS));
      this.setDiveFadeOpacity(fade);
      if (e >= PlanetariumMode.DIVE_TOTAL_MS) this.finishMapTransition();
    } else {
      // Autopilot: no camera dive, just a short fade-close.
      this.setDiveFadeOpacity(Math.min(1, e / PlanetariumMode.AUTOPILOT_CLOSE_MS));
      if (e >= PlanetariumMode.AUTOPILOT_CLOSE_MS) this.finishMapTransition();
    }
  }

  /** A second tap / Enter on a diving card skips the camera ease and blacks out. */
  private skipMapDive() {
    if (!this.mapDiving || !this.mapDiveIsCamera) return;
    // Push the start stamp back so elapsed is at least the camera-ease duration
    // (never forward — that would rewind an already-past-ease dive), and snap the
    // pose home; the fade then starts on the next frame.
    this.mapTransitionStartMs = Math.min(
      this.mapTransitionStartMs,
      performance.now() - PlanetariumMode.DIVE_CAM_MS,
    );
    this.systemMap?.setDivePose(1);
  }

  /** The transition reached the black wall: close the map (strictly first —
   *  the ordering invariant), then run the commit through the shared core. If
   *  arriveThen raises the real veil it takes over invisibly; otherwise the
   *  dive fade lifts on the destination. */
  private finishMapTransition() {
    if (this.mapDiveActiveGen !== this.mapDiveGen) return;
    const verb = this.mapDiveVerb;
    const target = this.mapDiveTarget;
    const teleport = this.mapDiveTeleport;
    this.systemMap?.endDive(true);
    // closeMap tears the map down and normally clears the fade; mapCommitting
    // keeps it black for the hand-off to the commit / arrival veil.
    this.mapCommitting = true;
    this.closeMap({ restore: false });
    this.mapCommitting = false;
    if (teleport) this.applyFreeSpaceTeleport(teleport);
    else if (verb && target) this.commitBodyPick(verb, target, {});
    this.liftDiveFade();
  }

  /** Esc mid-dive: cancel the transition, keep the map open, restore the
   *  camera, lift the fade. The token bump stops any queued commit. */
  private cancelMapDive() {
    if (!this.mapDiving) return;
    this.mapDiveGen++;
    this.mapDiving = false;
    this.mapDiveVerb = null;
    this.mapDiveTarget = null;
    this.mapDiveTeleport = null;
    this.systemMap?.endDive(false);
    this.liftDiveFade();
  }

  private setDiveFadeOpacity(opacity: number) {
    const el = document.getElementById('map-dive-fade');
    if (!el) return;
    el.classList.remove('lifting');
    el.style.display = 'block';
    // Quantize to 2 decimals and write only on a change — the fade holds at 0
    // through the camera ease and at 1 after, so most frames write nothing.
    const q = Math.round(opacity * 100) / 100;
    // Pointer-catching rides the DRAWN opacity — the quantized value, not the
    // raw one: below the quantum the cover paints 0.00 and must not catch
    // (through the camera ease a tap must still reach the canvas to skip).
    // Kept outside the write-on-change return so the class can't go stale.
    el.classList.toggle('covering', q > 0);
    if (q === this.mapFadeOpacityQ) return;
    this.mapFadeOpacityQ = q;
    el.style.opacity = q.toFixed(2);
  }

  /** Fade the dive cover back out over ~200 ms, then hide it. If the arrival
   *  veil raised meanwhile, this lifts under it (black under black). */
  private liftDiveFade() {
    const el = document.getElementById('map-dive-fade');
    if (!el) return;
    // The lift fades out over the destination scene, which must be live
    // immediately — the cover stops catching pointers the moment it lets go.
    el.classList.remove('covering');
    el.classList.add('lifting');
    el.style.opacity = '0';
    this.mapFadeOpacityQ = 0; // keep the quantized cache in step with the direct write
    window.setTimeout(() => {
      // Only hide if nothing re-raised it since.
      if (el.style.opacity === '0') {
        el.style.display = 'none';
        el.classList.remove('lifting');
      }
    }, 220);
  }

  private clearDiveFade() {
    const el = document.getElementById('map-dive-fade');
    if (!el) return;
    el.classList.remove('covering');
    el.classList.remove('lifting');
    el.style.opacity = '0';
    el.style.display = 'none';
    this.mapFadeOpacityQ = 0; // keep the quantized cache in step with the direct write
  }

  // ── System map: teleport anywhere ───────────────────────────────────────

  /**
   * The desktop gesture: a right-click (however it was made) on the chart.
   *
   * The native menu is suppressed for the whole time the map owns the frame,
   * unconditionally. OrbitControls suppresses it too, but only while it is
   * ENABLED — and the map disables its controls for every dive and every
   * follow flight, which is exactly when a stray browser menu over the chart
   * would be most confusing.
   *
   * The body pick runs here rather than being inherited: a right-click never
   * reaches the primary-button pick path, so without this a right-click on
   * Jupiter would offer to teleport into the middle of it.
   */
  private mapContextMenu(e: MouseEvent): void {
    if (!this.isMapOpen()) return;
    e.preventDefault();
    if (this.mapDiving || this.isMapCameraFlying() || !this.systemMap) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    // The hover emphasis's claim comes first, exactly as it does for a primary
    // press: at time warp the held body can slide off the fresh pick radius
    // while its emphasis still names it on screen, and a right-click on that
    // emphasis is about the body — not an offer to teleport into the space it
    // just vacated.
    if (this.mapHoverName && this.mapHoverValid) {
      const dx = x - this.mapHoverAnchorX;
      const dy = y - this.mapHoverAnchorY;
      if (Math.hypot(dx, dy) <= HOVER_RECLAIM_MOVE_PX) {
        this.openMapCard(this.mapHoverName);
        return;
      }
    }
    const hit = this.systemMap.pick(x, y, 'mouse');
    if (hit.kind === 'body') {
      this.openMapCard(hit.name);
      return;
    }
    // The ship marker is inert to a right-click for the same reason it is
    // inert to a tap: it is where you already are.
    if (hit.kind === 'ship') return;
    this.offerMapTeleport(x, y);
  }

  /** Arm the phone's half of the gesture. One press at a time; every way a
   *  press can end (lift, cancel, second finger, drag, blur, close, a camera
   *  flight) routes through cancelMapLongPress. */
  private armMapLongPress(e: PointerEvent): void {
    this.cancelMapLongPress();
    this.mapTpPressPointerId = e.pointerId;
    this.mapTpPressX = e.clientX;
    this.mapTpPressY = e.clientY;
    this.mapTpPressTimer = window.setTimeout(
      () => this.matureMapLongPress(),
      PlanetariumMode.MAP_TP_PRESS_MS,
    );
  }

  private cancelMapLongPress(): void {
    if (this.mapTpPressTimer) {
      window.clearTimeout(this.mapTpPressTimer);
      this.mapTpPressTimer = 0;
    }
    this.mapTpPressPointerId = null;
  }

  /**
   * The press has lasted: it is a teleport gesture now, not a tap.
   *
   * A matured hold takes the gesture over completely — it poisons the armed
   * tap (so the finger-lift does not dismiss the offer it just made) and ends
   * the chart controls' own gesture and damping (so the chart does not keep
   * rotating out from under the chip). A hold that resolves to nothing leaves
   * both alone: the press is still a perfectly good tap.
   */
  private matureMapLongPress(): void {
    const pointerId = this.mapTpPressPointerId;
    this.mapTpPressTimer = 0;
    this.mapTpPressPointerId = null;
    if (pointerId === null || !this.isMapOpen() || !this.systemMap) return;
    if (this.mapDiving || this.isMapCameraFlying()) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = this.mapTpPressX - rect.left;
    const y = this.mapTpPressY - rect.top;
    // A hold on a body is not a gesture of its own: the lift still opens the
    // card, exactly as a plain tap would.
    if (this.systemMap.pick(x, y, 'touch').kind !== 'empty') return;
    if (!this.offerMapTeleport(x, y)) return;
    this.poisonMapPick();
    // The finger is still down on this offer. Its lift will synthesize a
    // click, and the chip may be sitting under it — disarmed until a press
    // that starts ON the chip (see mapTpChipArmed).
    this.mapTpChipArmed = false;
    this.systemMap.cancelControlsGesture(pointerId);
  }

  /**
   * Read a point on the chart back into real space and put the offer on it.
   * False when the gesture resolves to nothing — a ray that misses the
   * ecliptic plane, one arriving too nearly edge-on to mean a place, or a
   * point inside a revealed moon system, whose chart space is amplified around
   * its parent and says nothing about a distance from the Sun.
   */
  private offerMapTeleport(xPx: number, yPx: number): boolean {
    const map = this.systemMap;
    if (!map) return false;
    if (!map.chartRayAt(xPx, yPx, this.mapTpRayOrigin, this.mapTpRayDir)) return false;
    const pick = resolveTeleportPick(
      this.mapTpRayOrigin,
      this.mapTpRayDir,
      ECLIPTIC_NORTH_EQUATORIAL,
      map.getBlend(),
      map.getCurve(),
      PlanetariumMode.MAP_TP_EXTENT_AU,
      this.mapTpPick,
    );
    if (!pick) return false;
    if (map.chartPointInRevealedSystem(pick.chartX, pick.chartY, pick.chartZ)) return false;
    this.mapTpPoint = { x: pick.x, y: pick.y, z: pick.z };
    this.mapTpRadiusAU = pick.radiusAU;
    this.showMapTeleportChip(teleportChipLabel(pick.radiusAU));
    return true;
  }

  /** Cache the chip and wire its press once (the MapHUD bind idiom). */
  private bindMapTeleportChip(): void {
    this.mapTpChipEl = document.getElementById('map-tp-chip');
    if (this.mapTpChipWired || !this.mapTpChipEl) return;
    this.mapTpChipWired = true;
    // A deliberate press on the chip always begins with its own pointerdown;
    // the long-press that MADE the offer never produces one (its pointer went
    // down on the chart). That asymmetry is the whole disarm mechanism.
    this.mapTpChipEl.addEventListener('pointerdown', () => { this.mapTpChipArmed = true; });
    this.mapTpChipEl.addEventListener('click', (e) => {
      // Suppress the disarmed chip's synthesized click (see mapTpChipArmed).
      // A keyboard activation arrives with detail 0 and no lift behind it, so
      // it always passes — the Esc rung can focus the chip and Enter works.
      if (!this.mapTpChipArmed && e.detail > 0) return;
      this.commitMapTeleport();
    });
  }

  private showMapTeleportChip(label: string): void {
    const el = this.mapTpChipEl;
    if (!el) return;
    el.textContent = label;
    el.classList.add('visible');
    // Every fresh offer starts armed; only a matured long-press disarms, and
    // it does so AFTER this call (the right-click path never disarms at all).
    this.mapTpChipArmed = true;
    // Measured once per show, after the label is set and the chip displays:
    // the width only changes with the label, and the per-frame clamp must not
    // re-read layout.
    this.mapTpChipHalfW = el.offsetWidth / 2;
    this.mapTpChipH = el.offsetHeight;
    // Force the first placement write — the chip may be reappearing at exactly
    // the pixel the last one was left at.
    this.mapTpChipX = NaN;
    this.mapTpChipY = NaN;
    this.updateMapTeleportChip();
  }

  /** Whether an offer stands AND is on screen — the dev bridge's state read.
   *  Deliberately NOT the Esc rung's predicate: that rung dismisses any
   *  standing offer, visible or not, so a hidden one cannot outlive the
   *  press and resurface. */
  private isMapTeleportChipVisible(): boolean {
    return this.mapTpPoint !== null && !!this.mapTpChipEl?.classList.contains('visible');
  }

  private dismissMapTeleportChip(): void {
    if (!this.mapTpPoint) return;
    this.mapTpPoint = null;
    this.mapTpRadiusAU = 0;
    this.mapTpChipEl?.classList.remove('visible');
    // An offer dismissed by Esc must not leave the keyboard on a chip that is
    // no longer there.
    this.mapTpChipEl?.blur();
  }

  /**
   * Re-place the chip on the point it names, every map frame. The chip is
   * anchored to a place, not to a pixel: following a body translates the
   * camera every frame and the scale toggle re-projects the whole chart, and a
   * screen-fixed chip would drift off the point within a frame of either. Off
   * the frame it hides and keeps the offer — the camera can swing back.
   */
  private updateMapTeleportChip(): void {
    const el = this.mapTpChipEl;
    const map = this.systemMap;
    const point = this.mapTpPoint;
    if (!el || !map || !point) return;
    projectMapPoint(point.x, point.y, point.z, map.getBlend(), map.getCurve(), this.mapTpChart);
    if (!map.projectChartPoint(this.mapTpChart, this.mapTpScreen)) {
      el.classList.remove('visible');
      return;
    }
    el.classList.add('visible');
    // Write only on a change: a settled chart re-derives the same pixel every
    // frame (the label pass's rule). The x clamp keeps the whole line inside
    // the frame — a phone press near an edge would otherwise clip the chip
    // mid-sentence. The anchor tether stretches at the edge; the point itself
    // is what the chip names, and it stays where it is.
    const halfW = this.mapTpChipHalfW;
    const rawX = Math.round(this.mapTpScreen.x);
    const maxX = window.innerWidth - halfW - 8;
    const x = maxX > halfW + 8 ? Math.round(Math.min(Math.max(rawX, halfW + 8), maxX)) : rawX;
    // The y clamp mirrors it for the top edge: the chip body hangs above the
    // anchor (translateY(-100%) plus the lift), so an anchor high in the frame
    // would draw it off-screen — yet the standing offer still owns the next
    // Esc. Pin it fully on-frame instead; the tether stretches like x's.
    const minY = this.mapTpChipH + PlanetariumMode.MAP_TP_CHIP_LIFT_PX + 8;
    const y = Math.round(Math.max(this.mapTpScreen.y, minY));
    if (x === this.mapTpChipX && y === this.mapTpChipY) return;
    this.mapTpChipX = x;
    this.mapTpChipY = y;
    el.style.transform = `translate(-50%, -100%) translate(${x}px, ${
      y - PlanetariumMode.MAP_TP_CHIP_LIFT_PX
    }px)`;
  }

  /**
   * The chip's press. The chart leaves the same way an Autopilot commit leaves
   * it — a short fade-close, no camera dive, since there is no body to dive at
   * — and the transition hands the jump over at the black wall, where the
   * arrival veil can take over invisibly if the destination needs painting.
   * Esc during that beat cancels the whole thing, exactly as it does a dive.
   */
  private commitMapTeleport(): boolean {
    if (!this.isMapOpen() || !this.mapTpPoint) return false;
    // A committed transition owns the way out; the chip is not a second door.
    if (this.mapDiving || this.isMissionActive()) return false;
    if (this.arrivalInFlight) {
      // Never a silent drop: the veil is up over an arrival the user cannot
      // see, and a chip that did nothing would read as a broken button.
      this.notification.show('Still arriving — try that again in a moment');
      return false;
    }
    this.mapDiveTeleport = {
      x: this.mapTpPoint.x,
      y: this.mapTpPoint.y,
      z: this.mapTpPoint.z,
      radiusAU: this.mapTpRadiusAU,
    };
    this.dismissMapTeleportChip();
    this.mapTapName = null;
    this.mapDiveVerb = null;
    this.mapDiveTarget = null;
    this.mapDiveIsCamera = false;
    this.mapDiving = true;
    // The chart is about to be left behind; nothing on it is under the cursor.
    this.resetMapHover();
    this.mapTransitionStartMs = performance.now();
    this.mapDiveActiveGen = ++this.mapDiveGen;
    this.journeyCommitGen++;
    return true;
  }

  /**
   * The free-space jump itself, run at the black wall.
   *
   * Deliberately NOT a body arrival: there is no target to hand the body path,
   * so the transaction is written here — and it holds the throttle exactly as
   * the pilot left it. The body-jump path floors the commanded cruise speed at
   * 1c, and that command would outlive this jump and launch a deliberately
   * resting ship the moment the throttle came up.
   *
   * The ship arrives at rest facing the Sun. A body arrival stays under way
   * because it has a subject to close on; a chosen point in empty space has
   * none, so rest is the honest answer — and the throttle revives it (together
   * with the clock, if the jump was made paused).
   *
   * The veil still gates it: a point chosen among a planet's moons warms that
   * system first, so the arrival never reveals a half-painted one.
   */
  private applyFreeSpaceTeleport(
    point: { x: number; y: number; z: number; radiusAU: number },
  ): void {
    this.arriveAtSystem(this.nearestSystemAt(point.x, point.y, point.z), () => {
      // A teleport from the ground must hold the throttle as the pilot left it
      // too: exitLandedMode restores an ordinary takeoff, which floors the
      // command at 1c and drops the system throttle to a near-planet crawl —
      // both of which would outlive this jump. Snapshot around it.
      const speedCmd = this.landedOn ? this.preLandSpeed : this.player.speedMultiplier;
      const systemCmd = this.player.systemSpeedMultiplier;
      if (this.landedOn) this.exitLandedMode();
      this.player.speedMultiplier = speedCmd;
      this.player.systemSpeedMultiplier = systemCmd;
      this.updateSpeedSlider(); // exitLandedMode refreshed it with its own values
      // Clear only: the resetCruiseCamera below this jump's repose cuts.
      clearArrivalLook(this.cruiseAim);
      this.arrivalLookMoon = null;
      this.arrivalLookParentBody = null;
      this.dotNavMoon = null;
      // A pilot left engaged re-aims the ship at its own target on the very
      // next frame — you would leave the chosen point before ever seeing it.
      this.disengageAutopilot();
      this.player.setPosition(point.x, point.y, point.z);
      this.player.headToward(0, 0, 0); // the Sun sits at the scene origin
      // A teleport is a flight discontinuity: no eased cap and no partial
      // clear-hold may cross it, and the Sun can go from hidden behind a body
      // to bare in one frame.
      this.bodyCap = initialBodyCapState();
      this.noteSunViewDiscontinuity();
      // Park LAST, and here rather than inside a jump helper: the never-park
      // default of a body arrival is load-bearing, and a park flag threaded
      // through it would outlive this jump.
      this.player.moving = false;
      this.resetCruiseCamera();
      this.notification.show(`Parked ${formatBodyDistance(point.radiusAU)} from the Sun`);
    }, false);
  }

  /**
   * The moon system a point in open space sits inside, or null for a point
   * with no system around it. This is the warm-up key the free-space jump
   * hands the arrival veil: a point chosen among Jupiter's moons must not
   * arrive on an unpainted system, and one out between the orbits owes the
   * veil nothing.
   */
  private nearestSystemAt(x: number, y: number, z: number): string | null {
    let best: string | null = null;
    let bestD2 = Infinity;
    for (const body of PLANETARIUM_BODIES) {
      const pos = this.planetWorldPositions.get(body.name);
      if (!pos) continue;
      const dx = x - pos.x;
      const dy = y - pos.y;
      const dz = z - pos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const reach = this.teleportSystemReachAU(body.name, body.systemRadiusAU);
      if (d2 > reach * reach || d2 >= bestD2) continue;
      bestD2 = d2;
      best = body.name;
    }
    return best;
  }

  /**
   * How far out a planet's moon system extends for the warm-up test — from
   * the CATALOG, because the whole point is a system that has never been
   * built: `systemRadiusAU` is only the speed-throttle radius (Neptune's is
   * 0.01 AU while Neso swings out to ~0.49), and the live meshes a cold
   * system does not have yet. Apoapsis with MOON_SYSTEM_REACH_MARGIN — the
   * same line the moon-system threshold draws — cached, since the catalog
   * cannot change.
   */
  private teleportSystemReachAU(planetName: string, systemRadiusAU: number): number {
    let reach = this.tpSystemReachCache.get(planetName);
    if (reach === undefined) {
      let moonReachAU = 0;
      for (const moon of getMoonsByPlanet(planetName)) {
        moonReachAU = Math.max(moonReachAU, getMoonApoapsisAU(moon.name, planetName));
      }
      reach = Math.max(systemRadiusAU, moonReachAU * PlanetariumMode.MOON_SYSTEM_REACH_MARGIN);
      this.tpSystemReachCache.set(planetName, reach);
    }
    return reach;
  }

  /** Show/hide the full-screen touch flight overlay and drop any captured
   *  pointer. Landed mode hides it the same way; the map borrows the idiom. */
  private setTouchFlightZoneHidden(hidden: boolean) {
    const zone = document.getElementById('touch-flight-zone');
    if (hidden) {
      if (this.activeFlightTouchId !== null) {
        // releasePointerCapture throws on a pointer it no longer holds.
        try {
          (zone as HTMLElement | null)?.releasePointerCapture?.(this.activeFlightTouchId);
        } catch { /* pointer already released */ }
        this.activeFlightTouchId = null;
        this.touchYaw = 0;
        this.touchPitch = 0;
      }
      zone?.classList.remove('active');
      if (zone) zone.style.display = 'none';
      return;
    }
    // Restore to the world state: hidden while landed or on a keyboard device,
    // visible on a touch device in cruise.
    if (zone) zone.style.display = this.landedOn || !this.isTouchDevice ? 'none' : '';
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
    if (verb !== 'observe') {
      // The Sun has no surface to host an observatory, so its row rides only
      // the Travel and Autopilot tabs, above the planet groups.
      list.appendChild(this.makeDeckRow({ type: 'planet', name: 'Sun' }, SUN_DATA.color, 'Our star'));
    }
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
    const css = cssHexColor(color);
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

  /** Deck wrapper: read the tab + from-panel flag, close the deck's own UI,
   *  then hand the commit to the shared core. The core owns every arrival
   *  semantic — the deck contributes only its state. */
  private commitDeckPick(target: NonNullable<LandedTarget>) {
    // Keep the original guard order: a mission refuses before the deck closes,
    // so a queued click during a mission-start never tears the deck down.
    if (this.isMissionActive()) return;
    const verb = this.deckVerb;
    if (!verb) return;
    const fromPanel = this.deckOpenedFromPanel;
    this.closeDeck();
    this.commitBodyPick(verb, target, { fromPanel });
  }

  /**
   * The semantic core of a body commit, shared by the deck, the map card, and
   * the dev bridge. Reads and writes NO deck state (deckVerb, the deck DOM, the
   * from-panel flag) — callers close their own UI first. Returns true when the
   * commit is accepted, false when refused (a mission) or busy (a Teleport /
   * Observatory commit that the in-flight arrival veil would silently drop).
   */
  private commitBodyPick(
    verb: MapVerb,
    target: NonNullable<LandedTarget>,
    opts: { fromPanel?: boolean } = {},
  ): boolean {
    const sameBody = this.landedOn?.type === target.type && this.landedOn.name === target.name;
    const outcome = commitBodyPickOutcome({
      missionActive: this.isMissionActive(),
      arrivalInFlight: this.arrivalInFlight,
      verb,
      sameBody,
    });
    if (outcome !== 'accepted') return false;
    this.journeyCommitGen++;
    const fromPanel = opts.fromPanel ?? false;
    if (verb === 'observe') {
      this.commitObservePick(target, sameBody, fromPanel);
      return true;
    }
    if (sameBody) {
      // Your own row on Travel/Autopilot: lift off and park nearby.
      this.exitLandedMode();
      return true;
    }
    if (verb === 'travel') {
      this.arriveThen(target, () => {
        if (this.landedOn) this.exitLandedMode();
        if (target.type === 'moon') {
          const moon = MOONS.find((m) => m.name === target.name);
          if (moon) this.jumpToMoon(moon);
        } else if (target.name === 'Sun') {
          this.jumpToSun();
        } else {
          const body = PLANETARIUM_BODIES.find((b) => b.name === target.name);
          if (body) this.jumpToPlanet(body);
        }
      });
      return true;
    }
    if (this.landedOn) this.exitLandedMode();
    this.engageAutopilot(target);
    return true;
  }

  /**
   * Hide/restore the planet+moon label layers around a modal. This is only the
   * modal-hide flag; the resting container visibility (labels setting + active
   * reveal + surface view) is `syncWorldLabelContainers`, which reads it.
   */
  private setWorldLabelsVisible(visible: boolean) {
    this.worldLabelsModalHidden = !visible;
    this.syncWorldLabelContainers();
  }

  /** Apply the two independent visibility flags. The HTML label layers follow
   *  `showBodyLabels` (plus any live reveal); the marker sprites follow
   *  `showBodyMarkers`. When both are off the sprites need clearing here; when
   *  only the markers are off, clear them too (the pipeline keeps running for
   *  labels but won't re-show a sprite it's told to keep hidden). The distance
   *  line shows only in 'always' mode — 'hover' leaves the container in
   *  `hide-distances`, where the per-label reveal class does the revealing. */
  private applyBodyLabelVisibility() {
    // Labels going away take their incumbency with them: coming back, every
    // name should have to win its slot again rather than inherit one.
    this.clearMoonLabelIncumbents();
    this.syncWorldLabelContainers();
    this.planetLabels?.setDistancesVisible(this.labelDistancesMode === 'always');
    if (!this.showBodyLabels && !this.showBodyMarkers) {
      this.planetLabels?.hideAll();
    } else if (!this.showBodyMarkers) {
      this.planetLabels?.hideMarkers();
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
        this.notification.show(`Standing on ${bodyDisplayName(target.name)}`);
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
    // The profile fetch below yields (Cassini loads a GLB). Anything the user
    // does meanwhile — picking another mission, New Journey, leaving the mode —
    // must win over this stale continuation, or a slow load resurrects a
    // mission the user already abandoned.
    const requestGen = ++this.missionRequestGen;
    const journeyGen = this.journeyCommitGen;
    await this.player.ensureProfileLoaded(journey.shipProfile);
    if (requestGen !== this.missionRequestGen || !this.active) return;
    // A journey committed during the fetch (map card or deck) is the newer
    // action — this stale mission continuation yields to it, same as the
    // request-gen rule, whether that journey's dive is still running or its
    // arrival already landed.
    if (this.journeyCommitGen !== journeyGen) return;
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
    // The stash above keeps the user's pilot for the post-mission restore, but
    // the mission itself must fly clean: a live autopilot re-aims the ship at
    // its own target every frame, turning the parked probe (and the camera)
    // away from each milestone the moment its transfer ends. Runs after
    // exitLandedMode, which re-engages a pre-landing pilot on takeoff.
    this.disengageAutopilot();
    this.activeHistoricJourney = journey;
    this.historicPanelDismissed = false;
    this.showShip = true;
    this.player.group.visible = true;
    this.player.setProfile(journey.shipProfile);
    const shipLabel = document.getElementById('settings-ship-label');
    if (shipLabel) shipLabel.textContent = 'On';
    this.closeMenuPanel();
    this.closeToolsMenu(); // the mission started from the Tools popover — seal it shut
    this.updateMissionControlState();
    this.showHistoricMilestone(0);
    this.notification.show(journey.readyNotification);
  }

  private stopHistoricJourney(restorePreviousState = true) {
    // Ending a mission (or New Journey's reset) also invalidates any mission
    // start still awaiting its profile fetch.
    this.missionRequestGen++;
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

    // Historic scenes were framed against the old 0.001 AU floor — keep
    // passing it so every authored milestone parks the ship where it always
    // has (the ~2° Earth postcards are the look those scenes were built on).
    const destination = this.getJumpDestination(body, milestone.viewDistanceMultiplier ?? 1, 0.001);
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
    // Through the flight-frame seam, not an inline atan2 pair: the pose
    // fields this lerps into are ecliptic angles, and hand-framed milestone
    // postcards would otherwise aim up to 23.4° off their look target.
    const aim = flightAnglesFromSceneDirection(
      options.lookTarget.x - options.targetPosition.x,
      options.lookTarget.y - options.targetPosition.y,
      options.lookTarget.z - options.targetPosition.z,
    );
    const startHeading = this.player.heading;
    // Shortest-path heading lerp: pick the equivalent endHeading within ±π of
    // start so we never sweep the long way around. The wrap must be fully
    // modular, not a single ±2π nudge: `heading` accumulates unbounded under
    // sustained yaw (a full-stick turn adds a revolution every ~8 s), and a
    // one-step correction would leave N whole extra revolutions in the lerp.
    const TWO_PI = 2 * Math.PI;
    const dh = ((aim.headingRad - startHeading) % TWO_PI + 3 * Math.PI) % TWO_PI - Math.PI;
    const endHeading = startHeading + dh;
    this.scriptedTransfer = {
      elapsed: 0,
      duration: 1.15,
      startPos: new THREE.Vector3(this.player.posX, this.player.posY, this.player.posZ),
      endPos: options.targetPosition.clone(),
      startHeading,
      endHeading,
      startPitch: this.player.pitch,
      endPitch: aim.pitchRad,
      endMoving: options.movingAfter,
    };
    // The transfer owns the pose from here; an armed contact graze must not
    // resume steering on the handback frame.
    this.contactAimActive = false;
    this.player.moving = true;
    // A scripted transfer never poses the camera, so a user-owned camera must
    // reacquire the chase rather than snap to it — snapping from a 90° offset
    // replays the old chord-cut dolly. 'reacquiring' rides the transfer arc
    // back onto the ship. (Not gated on an active drag: a transfer never
    // starts mid-canvas-drag.)
    if (this.camOwner !== 'chase') {
      flushOrbitDamping(this.controls);
      this.camOwner = 'reacquiring';
    }
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
    // player.update() is skipped during a scripted transfer, and it is the
    // only other writer of the model quaternion — without this the visible
    // probe holds its old orientation through the whole transfer arc and
    // snaps to the destination heading on the first post-transfer frame.
    this.player.syncModelOrientation();

    if (t >= 1) {
      this.player.moving = transfer.endMoving;
      this.scriptedTransfer = null;
      // A drag grabbed mid-transfer would otherwise wedge the parked milestone
      // postcard off-axis forever (no timeout hands it back). An actively held
      // drag still wins — but only until release: latch the reclaim so the
      // release handler completes it.
      if (this.camOwner === 'orbit') {
        if (!this.orbitDragging) {
          flushOrbitDamping(this.controls);
          this.camOwner = 'reacquiring';
        } else {
          this.pendingChaseReclaim = true;
        }
      }
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
    // A reset is an absolute repose to chase: end any held drag (and
    // OrbitControls' own gesture with it), drop its damping residuals, then
    // seat the camera at the chase pose. It is also THE aim cut site: every
    // deliberate cruise discontinuity (jumps, takeoff, intro, restore)
    // funnels through here, and the aim stage adopts fresh on the next
    // frame instead of sweeping from pre-repose state.
    cutAim(this.cruiseAim);
    // Same cut for the contact graze: a deliberate repose supersedes any
    // armed deflection, which must not steer the fresh pose.
    this.contactAimActive = false;
    this.cancelOrbitGesture();
    // Cruise rides the flight horizon. Every cruise entry funnels through
    // here — first pointing, Travel jumps, takeoff, a non-landed restore — so
    // this is where the basis flips back after any landed excursion.
    this.setCameraFrameUp(FLIGHT_UP_SCENE);
    this.pendingChaseReclaim = false;
    flushOrbitDamping(this.controls);
    this.camOwner = 'chase';
    // The chase-ideal clamp reads last frame's shell pool, and a cruise entry
    // is exactly where "last frame" lies: after a Travel jump or takeoff the
    // floating origin moved, so those shells sit anywhere but on the bodies.
    // Drop them; the clamp no-ops for one frame until updateCruiseCameraSafety
    // rebuilds the pool at the new origin (its escape stays the backstop).
    this.cameraShellCount = 0;
    const forward = this.player.getForwardDirection();
    chaseIdealOffset(forward, FLIGHT_UP_SCENE, this.camera.position);
    this.controls.target.set(0, 0, 0);
  }

  /**
   * The single writer of the camera's up axis outside surface view: cruise
   * rides the flight horizon (so the system's plane renders level at every
   * heading), landed framing rides world-up.
   *
   * OrbitControls caches its orbit axis from `object.up` at construction
   * (`_quat`/`_quatInverse`, verified against three r0.183.2), so writing
   * `camera.up` alone would leave drags — and landed autoRotate — precessing
   * about the old axis. The cached axis is therefore resynced on EVERY call,
   * even when the requested up is already in place: the dev framing rigs pose
   * the camera themselves and write `camera.up` directly without touching the
   * controls, so "already correct" up is no proof the cache agrees. Two
   * quaternion ops, and this only runs at mode transitions. A rename on a
   * three upgrade falls through to a DEV warning and the up write alone.
   */
  private setCameraFrameUp(up: THREE.Vector3) {
    if (!this.camera.up.equals(up)) {
      // Flipping the basis under a live gesture would swing the view in the
      // user's hand: end the gesture (no-op when nothing is held) and drop the
      // damping residuals so no coast replays in the old basis.
      this.cancelOrbitGesture();
      flushOrbitDamping(this.controls);
      this.camera.up.copy(up);
    }
    const c = this.controls as unknown as {
      _quat?: THREE.Quaternion;
      _quatInverse?: THREE.Quaternion;
    };
    if (c._quat && c._quatInverse) {
      c._quat.setFromUnitVectors(this.camera.up, PlanetariumMode.SCENE_NORTH);
      c._quatInverse.copy(c._quat).invert();
      return;
    }
    if (import.meta.env.DEV) {
      console.warn('OrbitControls orbit-axis fields missing — three upgrade renamed them; drags will orbit the stale axis');
    }
  }

  /** End a physically held orbit drag across a flight discontinuity: dispatch a
   *  synthetic pointercancel for the tracked pointer so OrbitControls' own
   *  gesture (pointer capture, internal state, document-level listeners) tears
   *  down together with our bookkeeping — a teleport veil does not otherwise
   *  stop those document listeners. A discontinuity thus ends the gesture
   *  (re-press to orbit again). */
  private cancelOrbitGesture() {
    if (this.orbitPointerId === null) return;
    this.renderer.domElement.dispatchEvent(
      new PointerEvent('pointercancel', { pointerId: this.orbitPointerId }),
    );
    this.orbitDragging = false;
    this.orbitPointerId = null;
  }

  /** Hard standoff shell around a planet: the rendered ENVELOPE — atmosphere
   *  shell included, since it's the outermost surface you see (Jupiter's is
   *  ~1,072 km thick and runs at full alpha up close; parking against the
   *  solid radius would sit ship and camera inside the glow) — plus the hull
   *  clearance pad. */
  private getPlanetCollisionRadius(name: string, radiusAU: number, renderedScale: number): number {
    return planetEnvelopeRadiusAU(radiusAU, renderedScale, ATMOSPHERE_SHELL_SCALES[name]) + SHIP_CLEARANCE_AU;
  }

  /** Standoff for a planet teleport: 8 radii (a ~14° disc from the chase
   *  camera) or the collision shell + 2 radii, whichever is farther. The
   *  floor sits INSIDE the max, before the multiplier — historic journeys
   *  pass the legacy 0.001 AU here so their authored milestone framings
   *  keep binding exactly where they always did. */
  private getJumpDestination(
    planet: PlanetData,
    distanceMultiplier = 1,
    floorAU = PLANET_ARRIVAL_STANDOFF_FLOOR_AU,
  ) {
    const pos = this.planetWorldPositions.get(planet.name);
    if (!pos) return null;

    const viewDist = Math.max(
      planet.radiusAU * 8,
      this.getPlanetCollisionRadius(planet.name, planet.radiusAU, this.planetScale) + planet.radiusAU * 2,
      floorAU,
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
   *  positions refresh each frame in updateMoonPositions) plus the jump
   *  seed, whose position resolves live from the parent + ephemeris offset
   *  while its mesh is still veiled. Rendered radii come from the live mesh
   *  scale (true size, or the render curve's size below the anchor), i.e.
   *  the sphere you actually see.
   *  Staleness: ship collision and the governor read this BEFORE the frame's
   *  refresh — one frame behind, fine at real cruise speeds but a different
   *  orbital epoch at the top time rates (1 yr/s moves a moon 36 simulated
   *  days per capped frame). Pre-existing, main-parity; the camera-safety
   *  pass runs AFTER the refresh and is immune. */
  private forEachGovernedMoon(
    cb: (
      x: number, y: number, z: number, renderedRAU: number,
      vxAUPerS: number, vyAUPerS: number, vzAUPerS: number,
    ) => void,
  ) {
    for (const moons of this.planetMoons.values()) {
      for (const m of moons) {
        if (!m.painted || !m.mesh.visible) continue;
        if (this.governedMoonSeed && m.data.name === this.governedMoonSeed.name) {
          this.governedMoonSeed = null; // the visible mesh covers it from here
        }
        const wp = this.moonWorldPositions.get(m.data.name);
        if (!wp) continue;
        const vel = this.moonWorldVels.get(m.data.name);
        cb(wp.x, wp.y, wp.z, m.data.radiusAU * m.mesh.scale.x, vel?.x ?? 0, vel?.y ?? 0, vel?.z ?? 0);
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
      // Flythrough anchor deliberately, not the state selector: jump seeds
      // only exist in cruise, where the flythrough anchor is the live one.
      this.renderedMoonSizeAU(moon.radiusAU, parent.radiusAU, MOON_RENDER_ANCHOR_RATIO),
      // The seed lives only behind the arrival veil, where the ship is parked
      // at the standoff — no moving-body credit needed before the painted
      // mesh takes over.
      0, 0, 0,
    );
  }

  /** Min proximity cap over every governed body: visible painted moons (plus
   *  the jump seed) at rendered radii, all planets at their envelope radii,
   *  and the Sun at SUN_APPROACH_SURFACE_RADII × its photosphere — the Sun
   *  has no collision shell, and the system throttle's inner edge sits
   *  INSIDE the photosphere, so this glide is the only brake. Each body's
   *  law is evaluated in ITS rest frame (movingBodySpeedCap credits the
   *  body's velocity along the nose on the leave side and its recession
   *  along the sightline on the approach side): a moon sweeping into the
   *  ship used to outrun the world-frame leave creep and bulldoze it
   *  forever, and a planet's trailing face used to outrun the world-frame
   *  glide so a chasing ship stalled ~30 km/s short of it forever — with
   *  the credits the ship can always walk off a moving shell and glide onto
   *  a receding one. */
  private computeBodySpeedCap(): number {
    const f = this.player.writeForwardDirection(this.tmpForwardDir);
    let cap = Infinity;
    const consider = (
      x: number, y: number, z: number, surfaceR: number, kPerS: number,
      vxAUPerS: number, vyAUPerS: number, vzAUPerS: number,
    ) => {
      const dx = x - this.player.posX;
      const dy = y - this.player.posY;
      const dz = z - this.player.posZ;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < 1e-12) return;
      const cos = (dx * f.x + dy * f.y + dz * f.z) / dist;
      // Raw surface distance, deliberately unclamped: at or inside the
      // collision shell both laws clamp themselves — the approach to its
      // floor, the leave law to the shell's own creep.
      const c = movingBodySpeedCap(
        dist - surfaceR, surfaceR, cos,
        vxAUPerS * f.x + vyAUPerS * f.y + vzAUPerS * f.z,
        (vxAUPerS * dx + vyAUPerS * dy + vzAUPerS * dz) / dist,
        kPerS, BODY_APPROACH_V_MIN_AU_S,
      );
      if (c < cap) cap = c;
    };
    this.forEachGovernedMoon((x, y, z, renderedR, vx, vy, vz) =>
      consider(x, y, z, renderedR, MOON_APPROACH_K_PER_S, vx, vy, vz));
    if (this.solarSystem) {
      for (const planet of this.solarSystem.planets) {
        const wp = planet.worldPosAU;
        if (!wp) continue;
        const vel = planet.worldVelAUPerS;
        consider(
          wp.x, wp.y, wp.z,
          planetEnvelopeRadiusAU(planet.data.radiusAU, planet.group.scale.x, ATMOSPHERE_SHELL_SCALES[planet.data.name]),
          PLANET_APPROACH_K_PER_S,
          vel?.x ?? 0, vel?.y ?? 0, vel?.z ?? 0,
        );
      }
      // The Sun sits pinned at the heliocentric origin.
      consider(
        0, 0, 0,
        (KM_CONSTANTS.SUN_RADIUS / KM_PER_AU) * SUN_APPROACH_SURFACE_RADII,
        PLANET_APPROACH_K_PER_S,
        0, 0, 0,
      );
    }
    return cap;
  }

  private pushCameraShell(sceneX: number, sceneY: number, sceneZ: number, surfaceRadiusAU: number) {
    let s = this.cameraShellPool[this.cameraShellCount];
    if (!s) {
      s = { x: 0, y: 0, z: 0, surfaceRadiusAU: 0 };
      this.cameraShellPool.push(s);
    }
    s.x = sceneX;
    s.y = sceneY;
    s.z = sceneZ;
    s.surfaceRadiusAU = surfaceRadiusAU;
    this.cameraShellCount++;
  }

  /** Camera safety + dynamic near plane, cruise only. Collisions move only
   *  the PLAYER; at the shrunken chase trail the camera itself can dip
   *  inside a mesh — a bounce turnaround lerps it toward the body, a drag
   *  orbit at max approach sweeps it under the surface, and a high-rate
   *  time step can drop a moon onto it. Escape any padded-shell penetration
   *  in one deterministic step (see cruiseView.escapeCameraPenetrations),
   *  re-aim at the ship, then set the near plane from live distances.
   *  Everything works in scene space (bodies at world − player). */
  private updateCruiseCameraSafety() {
    // frame()/shoot.mjs pose the camera (and its near plane) deliberately.
    if (this.devFreeCamera) return;

    // Measure in the frame the scene RENDERS in: collision pushback may have
    // moved the player after the floating origin was applied, and shells
    // derived from the live position would sit the whole pushback away from
    // the meshes on screen.
    const px = this.renderOriginAU.x;
    const py = this.renderOriginAU.y;
    const pz = this.renderOriginAU.z;
    this.cameraShellCount = 0;
    this.forEachGovernedMoon((x, y, z, renderedR) =>
      this.pushCameraShell(x - px, y - py, z - pz, renderedR));
    if (this.solarSystem) {
      for (const planet of this.solarSystem.planets) {
        const wp = planet.worldPosAU;
        if (!wp) continue;
        this.pushCameraShell(
          wp.x - px, wp.y - py, wp.z - pz,
          planetEnvelopeRadiusAU(planet.data.radiusAU, planet.group.scale.x, ATMOSPHERE_SHELL_SCALES[planet.data.name]),
        );
      }
      // The Sun sits at the heliocentric origin; its governed surface floats
      // above the photosphere (no collision shell exists to back this up).
      this.pushCameraShell(-px, -py, -pz, (KM_CONSTANTS.SUN_RADIUS / KM_PER_AU) * SUN_APPROACH_SURFACE_RADII);
    }

    const camPos = this.camera.position;
    const escaped = escapeCameraPenetrations(camPos, this.cameraShellPool, this.cameraShellCount, CAMERA_BODY_MARGIN_AU);
    if (escaped) {
      camPos.set(escaped.x, escaped.y, escaped.z);
      // No re-aim needed: the aim stage runs after this pass and derives
      // the frame's aim from the FINAL camera position by construction.
    }

    // Near plane from the FINAL camera position: nearest body surface,
    // camera-to-hull gap, nearest ring annulus.
    const near = cruiseCameraNearAU(
      nearestShellSurfaceDistanceAU(camPos, this.cameraShellPool, this.cameraShellCount),
      camPos.length(),
      this.nearestRingDistanceAU(camPos),
    );
    // Assign behind a small relative deadband — near sweeps smoothly, no
    // reason to rebuild the projection matrix on sub-1% jitter.
    if (Math.abs(near - this.camera.near) > this.camera.near * 0.01) {
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Distance from the camera to the nearest ring annulus (Infinity when no
   *  ringed planet is within 4× its outer ring radius). Rings have no
   *  collision — pass-through is deliberate — so only the near plane keeps a
   *  ring skim from clipping a hole through the geometry. */
  private nearestRingDistanceAU(camScene: THREE.Vector3): number {
    if (!this.solarSystem) return Infinity;
    // Render frame, same as the shell pass (worldToLocal already reads the
    // rendered matrices; the gate must agree with them).
    const px = this.renderOriginAU.x;
    const py = this.renderOriginAU.y;
    const pz = this.renderOriginAU.z;
    let min = Infinity;
    for (const planet of this.solarSystem.planets) {
      const rings = planet.rings;
      const config = RING_CONFIGS[planet.data.name];
      if (!rings || !config) continue;
      const wp = planet.worldPosAU;
      if (!wp) continue;
      const outerR = planet.data.radiusAU * config.outerFactor;
      const dx = camScene.x - (wp.x - px);
      const dy = camScene.y - (wp.y - py);
      const dz = camScene.z - (wp.z - pz);
      if (dx * dx + dy * dy + dz * dz > outerR * outerR * 16) continue; // beyond 4× the annulus
      // Ring geometry is baked into the mesh's local XZ plane; worldToLocal
      // refreshes ancestor world matrices itself.
      this.tmpRingLocal.copy(camScene);
      rings.worldToLocal(this.tmpRingLocal);
      const d = ringAnnulusDistanceAU(
        Math.hypot(this.tmpRingLocal.x, this.tmpRingLocal.z),
        this.tmpRingLocal.y,
        planet.data.radiusAU * config.innerFactor,
        outerR,
      );
      if (d < min) min = d;
    }
    return min;
  }

  /**
   * Land a swept shell contact: park the ship on the shell and, when the
   * pilot's hands are off the stick, arm the graze — deflect the nose onto
   * the forward direction's tangential part plus a small outward bias
   * (grazeDeflectAim), swung there over a few tenths of a second by
   * applyContactAim — so a bump skims the limb and peels away. The old
   * response snapped the nose 180° to the radial in one frame: it discarded
   * the approach direction, whipped the chase camera, and on a moving body's
   * leading face aimed the ship straight along the bulldozer blade. An
   * actively steering pilot keeps their heading — the shell holds them
   * regardless, and re-aiming against a held stick was the reported
   * grind-fight. Autopilot ends on contact: its glide contract already
   * failed (a body swept in at time warp), and its re-aim would fight the
   * deflection frame by frame — silently, since the pilot did nothing to
   * take the stick. A parked ship is revived (the pilot's own throttle-up
   * guards apply): a body plowing into it is a physical shove, and a dead
   * hull would otherwise be bulldozed across the sky with no way out.
   */
  private applyShellContact(cx: number, cy: number, cz: number, shellR: number, hit: SweepContact) {
    this.player.posX = cx + hit.ox * shellR;
    this.player.posY = cy + hit.oy * shellR;
    this.player.posZ = cz + hit.oz * shellR;
    if (this.autopilot) this.disengageAutopilot();
    this.reviveParkedShip();
    if (this.player.yawInput !== 0 || this.player.pitchInput !== 0) return;
    const forward = this.player.writeForwardDirection(this.tmpForwardDir);
    if (forward.x * hit.ox + forward.y * hit.oy + forward.z * hit.oz < CONTACT_ALIGN_OUT_MAX) {
      grazeDeflectAim(
        forward.x, forward.y, forward.z,
        hit.ox, hit.oy, hit.oz,
        this.contactAimTarget,
      );
      this.contactAimActive = true;
      this.contactAimAgeS = 0;
    }
  }

  /**
   * One frame of the armed contact graze: swing the nose toward the deflected
   * aim on the contact τ (contactAimStep). Steering input or autopilot
   * reclaims the stick instantly; convergence or the post-contact TTL retires
   * the swing. Runs in the cruise steering slot — after processInput, before
   * the ship integrates — so the frame flies the eased heading.
   */
  private applyContactAim(dt: number) {
    if (!this.contactAimActive) return;
    if (this.player.yawInput !== 0 || this.player.pitchInput !== 0 || this.autopilot) {
      this.contactAimActive = false;
      return;
    }
    this.contactAimAgeS += dt;
    const forward = this.player.writeForwardDirection(this.tmpContactForward);
    const done = contactAimStep(forward, this.contactAimTarget, dt, forward);
    this.player.headToward(
      this.player.posX + forward.x,
      this.player.posZ + forward.z,
      this.player.posY + forward.y,
    );
    if (done || this.contactAimAgeS >= CONTACT_AIM_TTL_S) this.contactAimActive = false;
  }

  private resolveMoonCollisions() {
    const p0 = this.prevPlayerPos;
    this.forEachGovernedMoon((x, y, z, renderedR) => {
      // Same clearance bubble as the arrival standoff and camera safety.
      const collisionR = moonCollisionRadius(renderedR, SHIP_CLEARANCE_AU);
      const hit = sweepSegmentSphere(
        p0.x, p0.y, p0.z,
        this.player.posX, this.player.posY, this.player.posZ,
        x, y, z, collisionR,
      );
      if (hit) this.applyShellContact(x, y, z, collisionR, hit);
    });
  }

  private resolvePlanetCollisions() {
    if (!this.solarSystem) return;
    const p0 = this.prevPlayerPos;
    for (const planet of this.solarSystem.planets) {
      const worldPos = planet.worldPosAU;
      if (!worldPos) continue;
      const collisionRadius = this.getPlanetCollisionRadius(planet.data.name, planet.data.radiusAU, planet.group.scale.x);
      const hit = sweepSegmentSphere(
        p0.x, p0.y, p0.z,
        this.player.posX, this.player.posY, this.player.posZ,
        worldPos.x, worldPos.y, worldPos.z, collisionRadius,
      );
      if (hit) this.applyShellContact(worldPos.x, worldPos.y, worldPos.z, collisionRadius, hit);
    }
  }

  jumpToPlanet(planet: PlanetData, options: { notify?: boolean; distanceMultiplier?: number } = {}) {
    if (this.isMissionActive()) return;
    const destination = this.getJumpDestination(planet, options.distanceMultiplier ?? 1);
    if (!destination) return;
    this.applyJumpDestination(destination, planet.name, options.notify !== false);
  }

  jumpToSun(options: { notify?: boolean } = {}) {
    if (this.isMissionActive()) return;
    const destination = sunArrivalPose(
      new THREE.Vector3(this.player.posX, this.player.posY, this.player.posZ),
      SUN_DATA.radiusAU,
    );
    this.applyJumpDestination(destination, 'Sun', options.notify !== false);
  }

  jumpToMoon(moon: MoonData, options: { notify?: boolean } = {}) {
    if (this.isMissionActive()) return;
    const destination = this.getMoonJumpDestination(moon);
    if (!destination) return;
    this.applyJumpDestination(destination, moon.name, options.notify !== false);
    // The engage-gated tracking look (cruiseAim.ts): weight is EXACTLY zero
    // at this arrival distance, so the teleport arrives in the settled chase
    // pose — aim at the ship, moon riding upper-frame off the flyby heading —
    // and the first click, drag, or keypress finds zero deflection and moves
    // nothing. Tracking fades in only if the player lets the flythrough
    // develop hands-off, holding the moon in frame through closest approach.
    // (An always-on look here put ~20° between the arrival and settled
    // poses, and every first input paid it as a visible adjust.)
    // Moonlet arrivals (flythrough: false) aim dead at the body with no pass
    // to film: no look, nothing for the camera to do but hold the chase.
    if (destination.flythrough) {
      this.tmpAimDir
        .copy(destination.bodyPosition)
        .sub(destination.position);
      const arrivalDistanceAU = this.tmpAimDir.distanceTo(this.camera.position);
      startArrivalLook(this.cruiseAim, moon.name, moon.parentPlanet, arrivalDistanceAU);
      // Catalog refs for the analytic per-frame moon position (the mesh is
      // not a legal source: it may be unpainted and untransformed for the
      // whole veil window).
      this.arrivalLookMoon = moon;
      this.arrivalLookParentBody =
        PLANETARIUM_BODIES.find((b) => b.name === moon.parentPlanet) ?? null;
    } else {
      // A moonlet "arrival under way" is a bounce, not an approach: full
      // thrust crosses the whole standoff in seconds, slides off the
      // pebble-sized collision shell, and the leave valve slings the moon
      // out of frame. Park instead — the caller decision the jump funnel
      // reserves (the same one dev framing and the tutorial use) — with the
      // body dead-centre; the throttle revives the ship the moment the
      // player wants to close in.
      this.player.moving = false;
    }
    // Retain the nav moon (applyJumpDestination cleared it above): keeps the
    // dot floor + label if the player takes manual control before arrival.
    this.dotNavMoon = { name: moon.name, parentPlanet: moon.parentPlanet };
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
    // Clear here; the resetCruiseCamera in this repose is the matching cut.
    clearArrivalLook(this.cruiseAim);
    this.arrivalLookMoon = null;
    this.arrivalLookParentBody = null;
    // A jump to a different body drops the retained nav moon; a moon jump
    // re-sets it right after (jumpToMoon), so a planet jump is the clearing case.
    this.dotNavMoon = null;
    // A jump supersedes the pilot. Autopilot re-aims at its own target every
    // frame, so an engaged pilot surviving the teleport snaps the heading back
    // to the OLD destination one frame after the pose below — you arrive at a
    // moon facing wherever the pilot was going. Silent: the "Jumped to" toast
    // is the story here, not a manual-flight banner.
    this.disengageAutopilot();

    this.player.posX = destination.position.x;
    this.player.posY = destination.position.y;
    this.player.posZ = destination.position.z;
    this.player.headToward(destination.lookTarget.x, destination.lookTarget.z, destination.lookTarget.y);

    // A teleport always arrives under way. Parking is a caller decision (dev
    // framing, tutorial freeze-frames), never the arrival default — a park
    // left set here outlives the jump and freezes every later arrival too.
    this.player.moving = true;

    // A teleport is a discontinuity: a tight cap eased down at the previous
    // body must not ramp-limit the arrival scene's first seconds, and no
    // partial clear-hold survives either.
    this.bodyCap = initialBodyCapState();
    // The Sun can swing from hidden-behind-the-old-body to fully exposed in one
    // frame; reseed the flash baseline so the arrival doesn't glare.
    this.noteSunViewDiscontinuity();

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
      this.notification.show(`Jumped to ${bodyDisplayName(bodyName)}`);
    }
    this.resetCruiseCamera();
  }

  /**
   * Arrival pose for a moon-precise jump. The position derives live from the
   * parent's world position plus the ephemeris offset — never from
   * `moonWorldPositions`, which is only written for visible painted moons and
   * silently falls back to the parent across the rest of the catalog. The
   * rendered size comes from the catalog through the render curve, not the
   * live mesh (scale is still 1 in never-visited systems). The pose
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
    const parentCollision = this.getPlanetCollisionRadius(parentBody.name, parentBody.radiusAU, this.planetScale);
    const ring = RING_CONFIGS[parentBody.name];
    const bodyPosition = offset.clone().add(parentPos);
    const pose = moonArrivalPose({
      moonPos: bodyPosition,
      parentPos,
      orbitR: offset.length(),
      // Flythrough anchor deliberately: jumps commit from cruise, where the
      // flythrough anchor is the size the arriving player will see.
      renderedR: this.renderedMoonSizeAU(moon.radiusAU, parentBody.radiusAU, MOON_RENDER_ANCHOR_RATIO),
      parentCollision,
      // Rings render as a flat disc, but a spherical clearance is simpler and
      // never lets an arrival pop in among the ring particles.
      parentClearance: Math.max(
        parentCollision * 1.25,
        ring ? parentBody.radiusAU * ring.outerFactor * 1.05 : 0,
      ),
      camDist: CRUISE_CAM_DIST_AU,
      shipClearance: SHIP_CLEARANCE_AU,
    });
    return {
      position: pose.position,
      lookTarget: pose.aimPoint,
      bodyPosition,
      flythrough: pose.flythrough,
    };
  }

  /**
   * Headless-screenshot support: pose the camera at a planet by name, with no
   * "Jumped to…" toast. Installed on `window.__moon` by the entry point under
   * Vite dev only. Returns false when the name isn't a top-level planet.
   */
  devJumpToBody(name: string, distanceMultiplier = 1): boolean {
    if (!this.solarSystem) return false;
    if (name === 'Sun') {
      this.jumpToSun({ notify: false });
      this.player.moving = false; // hold position so the body stays centered for capture
      return true;
    }
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
    this.showBodyMarkers = visible;
    // The corner chart draws in WebGL, so hiding the HTML overlay below would
    // leave it painting into a "clean" capture. It goes with the chrome, and
    // setMiniChart(true) brings it back for the captures that want it.
    this.setMiniChartEnabled(visible);
    this.player.group.visible = visible;
    if (this.solarSystem) {
      for (const o of this.solarSystem.orbitLines) o.visible = visible;
    }
    // Toggle both label layers and the sprites together, and hide the moon-label
    // divs the raw sprite clear would leave frozen on screen.
    this.applyBodyLabelVisibility();
    // HTML overlays that sit outside the per-frame visibility loop: the HUD,
    // the wordmark header, and the Sun/distance label container.
    for (const id of ['planetarium-ui', 'top-bar', 'planet-labels']) {
      const el = document.getElementById(id);
      if (el) el.style.display = visible ? '' : 'none';
    }
  }

  /**
   * Telescope light grasp. A narrow field on a dark sky is exactly what a
   * telescope buys you — the same aperture spread over less sky, so faint stars
   * climb out of the background — and the surface view is the only place the
   * app offers one. Everywhere else the gain is exactly 1 and the field renders
   * as built. It eases rather than steps so a zoom gesture doesn't strobe the
   * faint end, and the shader clamps each star so the lift can only reach the
   * stars that have opacity left to gain.
   */
  private updateStarGain(dt: number): void {
    if (!this.starfield) return;
    const target = this.landedView === 'surface'
      ? THREE.MathUtils.clamp(Math.pow(60 / Math.max(displayFovDeg(this.camera), 1e-3), 0.6), 1, 3)
      : 1;
    const blend = 1 - Math.exp(-Math.max(dt, 0) / 0.3);
    this.starGain += (target - this.starGain) * blend;
    setStarfieldGain(this.starfield, this.starGain);
  }

  /** The one legal camera-FOV writer: routes through the lens overscan. */
  private setDisplayFov(deg: number): void {
    applyDesignFov(this.camera as THREE.PerspectiveCamera, deg);
  }

  /** Rotate an already-centred camera so its current look target lands at the
   * requested DISPLAY/output NDC. The inverse lens ray is the source of truth;
   * using the overscan `camera.fov` directly overshoots every QA edge pose. */
  private offsetCameraTargetToOutputNdc(
    cam: THREE.PerspectiveCamera,
    offNdcX: number,
    offNdcY: number,
  ): void {
    if (offNdcX === 0 && offNdcY === 0) return;
    cam.updateMatrixWorld(true);
    screenPointToWorldRay(
      (offNdcX * 0.5 + 0.5) * 2,
      (-offNdcY * 0.5 + 0.5) * 2,
      cam,
      2,
      2,
      this.tmpScreenRay,
    );
    // Express the requested ray in the current camera's local frame, then
    // rotate that ray onto local forward. Post-multiplication preserves the
    // current world-space look direction while moving it to the requested pixel.
    this.tmpScreenInverseQuat.copy(cam.quaternion).invert();
    this.tmpScreenRay.applyQuaternion(this.tmpScreenInverseQuat);
    this.tmpScreenOffsetQuat.setFromUnitVectors(this.tmpScreenRay, this.tmpScreenForward);
    cam.quaternion.multiply(this.tmpScreenOffsetQuat).normalize();
    cam.updateMatrixWorld(true);
  }

  /** Iteratively place a sphere's DISPLAYED limb centre at an output NDC. Under
   * stereographic projection a finite small circle's Euclidean centre is a few
   * pixels radially offset from the projected direction to its 3D centre. */
  private frameSphereAtOutputNdc(
    cam: THREE.PerspectiveCamera,
    target: THREE.Vector3,
    radius: number,
    offNdcX: number,
    offNdcY: number,
  ): void {
    const canvas = this.renderer.domElement;
    // Framing rigs are world-up, not flight-horizon: a stored screenshot
    // baseline must not roll 23.4° the day cruise changed its horizon, or
    // before/after comparisons stop comparing. (These poses bypass the cruise
    // camera entirely — updateCruiseCamera is skipped under devFreeCamera.)
    cam.up.set(0, 1, 0);
    let aimNdcX = offNdcX;
    let aimNdcY = offNdcY;
    for (let i = 0; i < 4; i++) {
      cam.lookAt(target);
      // lookAt only mutates the quaternion. Projection below reads
      // matrixWorldInverse, so refresh even for the centred (zero-offset) case.
      cam.updateMatrixWorld(true);
      this.offsetCameraTargetToOutputNdc(cam, aimNdcX, aimNdcY);
      const footprint = projectSphereToScreen(
        target,
        radius,
        cam,
        canvas.clientWidth,
        canvas.clientHeight,
        this.sphereScreenProjection,
      );
      const actualX = (footprint.footprintX / Math.max(canvas.clientWidth, 1)) * 2 - 1;
      const actualY = 1 - (footprint.footprintY / Math.max(canvas.clientHeight, 1)) * 2;
      aimNdcX += offNdcX - actualX;
      aimNdcY += offNdcY - actualY;
    }
  }

  /** Headless-screenshot support: set the planetarium camera FOV (degrees) to zoom. */
  devSetFov(deg: number): void {
    this.setDisplayFov(deg);
  }

  /**
   * Headless-screenshot support: frame a planet centered, filling `fillFraction`
   * of the vertical view. Sits a few radii out, points at it, halts, and skips
   * collision so the close vantage holds. `phaseAngleDeg` is the Sun–planet–camera
   * angle: 0 sits sunward (full-phase lit); swing toward 180 for the night side,
   * the only view where the back-lit crescent (warm terminator + Mie forward
   * scatter) shows. `distMul` sets the standoff in body radii (default 5); the
   * Sun QA sweeps it (5/15/114 radii) to reproduce the baseline flyby distances.
   * Dev bridge only.
   */
  devFrameBody(
    name: string,
    fillFraction = 0.6,
    phaseAngleDeg = 0,
    distMul = 5,
    offNdcX = 0,
    offNdcY = 0,
  ): boolean {
    if (!this.solarSystem) return false;
    // Resolve the Sun, a top-level planet, or a moon (parent world position plus
    // the same offset the renderer uses) so the harness can frame any of them.
    let pos: { x: number; y: number; z: number } | undefined;
    let r = 0;
    const planet = this.solarSystem.planets.find((p) => p.data.name === name);
    if (name === 'Sun') {
      // The Sun sits at the heliocentric origin — the frame is posed in absolute
      // coords, where that is exactly (0,0,0), NOT sun.getWorldPosition (a scene
      // offset). The degenerate zero direction is seeded by the toSun guard below.
      pos = { x: 0, y: 0, z: 0 };
      r = SUN_DATA.radiusAU;
    } else if (planet) {
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
    const dist = r * distMul;
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
    this.setDisplayFov(THREE.MathUtils.radToDeg((2 * Math.atan(r / dist)) / fillFraction));
    // Optional off-centre slide (same convention as devFrameSun): lets the
    // harness study off-axis projection on any body, not just the Sun.
    this.frameSphereAtOutputNdc(cam, sceneOffset, r, offNdcX, offNdcY);
    this.controls.target.copy(sceneOffset);
    return true;
  }

  /** Headless-QA pose: camera `distanceAU` from the Sun, looking at it.
   *  Optional NDC offsets slide the Sun off screen-centre (exercises the
   *  centre-weighted exposure metering); values ≳1 push it just off-screen. */
  devFrameSun(distanceAU = 1, fovDeg = 60, offNdcX = 0, offNdcY = 0): boolean {
    if (!this.solarSystem) return false;
    this.devFreeCamera = true;
    // A fixed off-ecliptic direction keeps the pose reproducible and stops the
    // asteroid-belt band from slicing through the halo.
    const dir = new THREE.Vector3(0.62, 0.18, 0.76).normalize();
    this.player.posX = dir.x * distanceAU;
    this.player.posY = dir.y * distanceAU;
    this.player.posZ = dir.z * distanceAU;
    this.player.moving = false;
    this.player.headToward(0, 0, 0);
    const cam = this.camera as THREE.PerspectiveCamera;
    cam.position.set(0, 0, 0);
    this.setDisplayFov(fovDeg);
    // Floating origin: the Sun sits at scene position −player.
    const sunScene = new THREE.Vector3(-this.player.posX, -this.player.posY, -this.player.posZ);
    this.frameSphereAtOutputNdc(cam, sunScene, SUN_DATA.radiusAU, offNdcX, offNdcY);
    this.controls.target.copy(sunScene);
    return true;
  }

  /**
   * Headless-QA pose for the reported regression: hold the ship at screen
   * centre and put the Sun on a requested output-space ray behind it. The
   * profile is loaded before the pose is returned so sparse probes and the
   * async Cassini GLB can be swept deterministically.
   */
  async devFrameSunBehindShip(
    distanceAU = 5,
    offNdcX = 0,
    offNdcY = 0,
    profile: ShipProfile = 'default',
  ): Promise<boolean> {
    if (!this.solarSystem) return false;
    if (profile !== 'default') await this.player.ensureProfileLoaded(profile);
    this.devShipProfileOverride = profile;
    this.player.setProfile(profile);
    this.showShip = true;
    this.player.group.visible = true;
    this.player.moving = false;
    this.devFreeCamera = true;

    const forward = this.tmpSunView.set(1, 0, 0);
    const aim = flightAnglesFromSceneDirection(forward.x, forward.y, forward.z);
    this.player.heading = aim.headingRad;
    this.player.pitch = aim.pitchRad;
    this.player.syncModelOrientation();

    const cam = this.camera as THREE.PerspectiveCamera;
    this.setDisplayFov(60);
    this.setCameraFrameUp(FLIGHT_UP_SCENE);
    chaseIdealOffset(forward, FLIGHT_UP_SCENE, cam.position);
    this.controls.target.set(0, 0, 0);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld(true);

    const canvas = this.renderer.domElement;
    screenPointToWorldRay(
      (offNdcX * 0.5 + 0.5) * Math.max(canvas.clientWidth, 1),
      (-offNdcY * 0.5 + 0.5) * Math.max(canvas.clientHeight, 1),
      cam,
      Math.max(canvas.clientWidth, 1),
      Math.max(canvas.clientHeight, 1),
      this.tmpScreenRay,
    );
    const sunScene = this.tmpSunDirection.copy(cam.position)
      .addScaledVector(this.tmpScreenRay, Math.max(distanceAU, SUN_DATA.radiusAU * 2));
    // Floating origin maps the heliocentric Sun (0,0,0) to -player.
    this.player.posX = -sunScene.x;
    this.player.posY = -sunScene.y;
    this.player.posZ = -sunScene.z;
    this.noteSunViewDiscontinuity();
    return true;
  }

  /** DEV-only A/B gate; production always starts enabled. */
  devSetShipSunOcclusion(enabled: boolean): boolean {
    this.devShipSunOcclusionEnabled = enabled;
    return this.devShipSunOcclusionEnabled;
  }

  /** Solid, non-HDR limb target for assertion-based lens QA. It deliberately
   * bypasses the textured Sun/glare so thresholding measures one connected
   * geometric silhouette rather than whichever saturated optical layer wins. */
  devFrameDiagnosticSphere(
    offNdcX = 0,
    offNdcY = 0,
    fovDeg = 60,
    angularRadiusDeg = 6,
  ): boolean {
    this.devFreeCamera = true;
    this.player.moving = false;
    const cam = this.camera as THREE.PerspectiveCamera;
    cam.position.set(0, 0, 0);
    cam.quaternion.identity();
    this.setDisplayFov(fovDeg);
    cam.updateMatrixWorld(true);
    const distance = 10;
    const radius = distance * Math.sin(THREE.MathUtils.degToRad(angularRadiusDeg));
    if (!this.devDiagnosticSphere) {
      this.devDiagnosticSphere = new THREE.Mesh(
        new THREE.SphereGeometry(radius, 192, 96),
        new THREE.MeshBasicMaterial({ color: 0xb8b8b8, toneMapped: false }),
      );
      this.devDiagnosticSphere.name = 'Lens diagnostic sphere';
      this.devDiagnosticSphere.frustumCulled = false;
      this.devDiagnosticSphere.userData.baseRadius = radius;
      this.scene.add(this.devDiagnosticSphere);
    }
    // The radius is fixed by the one-time geometry; every harness call uses the
    // same default angular radius. Scale keeps the hook honest if QA overrides it.
    const geometryRadius = this.devDiagnosticSphere.userData.baseRadius as number;
    this.devDiagnosticSphere.scale.setScalar(radius / geometryRadius);
    this.devDiagnosticSphere.position.set(0, 0, -distance);
    for (const child of this.scene.children) {
      child.traverse(object => { object.visible = false; });
    }
    this.devDiagnosticSphere.visible = true;
    this.controls.target.copy(this.devDiagnosticSphere.position);
    this.frameSphereAtOutputNdc(
      cam,
      this.devDiagnosticSphere.position,
      radius,
      offNdcX,
      offNdcY,
    );
    return true;
  }

  /** The live analytic foreground-occlusion disc a planet contributed this frame
   *  (screen centre + radius px from `collectForegroundDiscs` under the lens), so
   *  the harness can place a marker at its predicted limb. Needs the label pass
   *  to have run (markers or labels on). */
  devPlanetOccluderDisc(name: string): unknown {
    const disc = this.planetLabels?.foregroundDiscs.find((d) => d.name === name);
    if (!disc) return null;
    return {
      screenX: disc.screenX, screenY: disc.screenY, radiusPx: disc.radiusPx,
      distFromCamera: disc.distFromCamera,
      viewport: { w: this.renderer.domElement.clientWidth, h: this.renderer.domElement.clientHeight },
    };
  }

  /** Dev-only: show/hide the player ship (the marker-limb case keeps markers on
   *  for the occlusion pass but wants the ship out of frame). */
  devSetShipVisible(visible: boolean): void {
    this.player.group.visible = visible;
  }

  /**
   * Place a bright-red marker SPRITE at a DISPLAYED screen pixel and cull it
   * through the REAL analytic occlusion path (`isScreenPointOccluded` against the
   * foreground occluder discs), exactly as a planet marker beacon is culled — so
   * its DRAWN pixels reflect the analytic-disc decision, not GPU depth. `depthAU`
   * is the marker's camera distance for the depth compare (put it behind the
   * occluding planet). Returns the occlusion verdict. Dev only.
   */
  devProbeLimbMarker(screenX: number, screenY: number, depthAU: number): { occluded: boolean } | null {
    if (!this.solarSystem || !this.planetLabels) return null;
    const cam = this.camera as THREE.PerspectiveCamera;
    const canvas = this.renderer.domElement;
    cam.updateMatrixWorld(true);
    screenPointToWorldRay(
      screenX, screenY, cam, canvas.clientWidth, canvas.clientHeight, this.probeLimbDir,
    );
    if (!this.probeLimbMarker) {
      // Same material family as the planet beacons: fixed screen size
      // (sizeAttenuation off), no depth test — visibility is owned entirely by
      // the analytic occlusion decision.
      const mat = new THREE.SpriteMaterial({
        color: new THREE.Color(1, 0, 0), sizeAttenuation: false, depthTest: false, depthWrite: false,
      });
      this.probeLimbMarker = new THREE.Sprite(mat);
      this.probeLimbMarker.renderOrder = 12;
      this.probeLimbMarker.scale.setScalar(0.02);
      this.scene.add(this.probeLimbMarker);
    }
    this.probeLimbMarker.position.copy(cam.position).add(this.probeLimbDir.multiplyScalar(depthAU));
    const occluded = this.planetLabels.isScreenPointOccluded(screenX, screenY, depthAU);
    this.probeLimbMarker.visible = !occluded;
    return { occluded };
  }

  /** DEV-only: live-tune the veiling-glare knobs for the warmth A/B montage and
   *  strength QA without rebuilding the Sun material. */
  devSetDiamondScale(k: number): boolean {
    if (!Number.isFinite(k)) return false;
    this.devDiamondScale = Math.max(k, 0);
    return true;
  }

  devSetVeil(opts: { warmth?: number; strength?: number }): boolean {
    const glareMat = this.solarSystem?.sun.userData.sunGlareMaterial as THREE.ShaderMaterial | undefined;
    if (!glareMat) return false;
    if (typeof opts.warmth === 'number') glareMat.uniforms.uVeilWarmth.value = opts.warmth;
    if (typeof opts.strength === 'number') glareMat.uniforms.uVeilStrength.value = opts.strength;
    return true;
  }

  /** Headless-QA readback for the glare-obscuration mask fed to stars, the belt,
   *  and the label overlays (a snapshot of the persistent per-frame params). */
  devSunGlareMask(): unknown {
    return { ...this.sunGlareMaskParams };
  }

  /** The Sun's drawn screen position and radius in CSS pixels, through the same
   *  lens-aware projection the shader path meters with. Readback only. */
  private devSunScreenGeometry(): { sunXPx: number; sunYPx: number; sunRadiusPx: number } {
    if (!this.solarSystem) return { sunXPx: 0, sunYPx: 0, sunRadiusPx: 0 };
    const width = Math.max(this.renderer.domElement.clientWidth, 1);
    const height = Math.max(this.renderer.domElement.clientHeight, 1);
    const projection = projectSphereToScreen(
      this.solarSystem.sun.position, SUN_DATA.radiusAU, this.camera, width, height,
      this.sphereScreenProjection,
    );
    return {
      sunXPx: (projection.ndcX * 0.5 + 0.5) * width,
      sunYPx: (-projection.ndcY * 0.5 + 0.5) * height,
      sunRadiusPx: projection.radiusPx,
    };
  }

  /** Headless-QA readback for transient Sun optics and atmospheric grazing. */
  devSunAppearance(): unknown {
    const sunMat = this.solarSystem?.sun.userData.sunMaterial as THREE.ShaderMaterial | undefined;
    const glareMat = this.solarSystem?.sun.userData.sunGlareMaterial as THREE.ShaderMaterial | undefined;
    const offset = glareMat?.uniforms.uOccluderOffsetSr.value as THREE.Vector2 | undefined;
    const centroid = glareMat?.uniforms.uGlareCentroidSr.value as THREE.Vector2 | undefined;
    return {
      exposure: this.sunExposure,
      whiteout: sunMat ? (sunMat.uniforms.uWhiteout.value as number) : 0,
      visibleFraction: this.lastSunVisibleFraction,
      shipSunVisibility: this.shipSunVisibility,
      shipSunRaycastCount: this.shipSunRaycastCount,
      emergenceFlash: this.sunEmergenceFlash,
      atmosphereMix: this.sunAtmosphereMix,
      atmosphereColor: `#${this.sunAtmosphereColor.getHexString()}`,
      occluderShade: glareMat ? (glareMat.uniforms.uOccluderShade.value as number) : 0,
      occluderRadii: glareMat ? (glareMat.uniforms.uOccluderRadii.value as number) : 0,
      occluderOffsetSr: offset ? [offset.x, offset.y] : [0, 0],
      glareCentroidSr: centroid ? [centroid.x, centroid.y] : [0, 0],
      diamondRing: glareMat ? (glareMat.uniforms.uDiamondRing.value as number) : 0,
      diamondOccluderSr: glareMat
        ? [
          (glareMat.uniforms.uDiamondOccluderSr.value as THREE.Vector2).x,
          (glareMat.uniforms.uDiamondOccluderSr.value as THREE.Vector2).y,
        ]
        : [0, 0],
      beadCarveDepth: glareMat ? (glareMat.uniforms.uBeadCarveDepth.value as number) : 0,
      poleScreenAngle: this.sunPoleScreenAngle,
      poleAnisotropy: glareMat ? (glareMat.uniforms.uSunPoleAnisotropy.value as number) : 0,
      chromoAnti: glareMat ? (glareMat.uniforms.uChromoAnti.value as number) : 0,
      chromoToward: glareMat ? (glareMat.uniforms.uChromoToward.value as number) : 0,
      closeProminences: this.solarSystem
        ? ((this.solarSystem.sun.userData.sunProminenceMaterial as THREE.ShaderMaterial | undefined)
          ?.uniforms.uCloseVisibility.value as number ?? 0)
        : 0,
      // Where the disc actually landed this frame, so a capture can put a
      // measurement window on a named part of it (a limb, the bead) instead of
      // guessing from the frame centre.
      ...this.devSunScreenGeometry(),
      secondOccluderFraction: this.sunSecondOccluderFraction,
      // Applied (smoothed) dim of the current silhouette owner, and the size
      // gate that scaled its target this frame.
      silhouetteDim: this.sunSilhouetteOwners.current.applied,
      silhouetteGate: this.sunSilhouetteGate,
      maskActive: this.sunGlareMaskParams.active,
      maskCoreOuterPx: this.sunGlareMaskParams.coreOuterPx,
    };
  }

  /** Dev bridge: measure every link of the anchored solar-eclipse chain at the
   *  current instant — anchor vs live axis point, camera vs anchor, rendered
   *  moon vs ephemeris, and pin/render quaternion agreement. Diagnostic only;
   *  allocations are fine here. */
  devEclipseDebug(): unknown {
    const landed = this.landedOn;
    if (landed?.type !== 'planet' || this.surfaceTarget.kind !== 'sun-from-spot') return null;
    const t = this.timeState.currentUtcMs;
    const body = PLANETARIUM_BODIES.find((b) => b.name === landed.name);
    const parentPlanet = this.solarSystem?.planets.find((p) => p.data.name === landed.name);
    if (!body || !parentPlanet) return null;
    const moonName = (this.surfaceTarget as { occluderMoonName: string }).occluderMoonName;
    const KM = 149_597_870.7;
    const offset = computeMoonOffsetEquatorialAU(moonName, landed.name, t, new THREE.Vector3());
    const planetHelio = computeBodyPositionAU(body, t);
    const axis = planetHelio.clone().add(offset).normalize();
    const liveSpot = shadowAxisSurfacePoint(offset, axis, body.radiusAU, new THREE.Vector3());
    const anchorWorld = this.surfaceSpotAnchor
      ? this.surfaceSpotAnchor
          .clone()
          .applyQuaternion(parentPlanet.group.quaternion)
          .normalize()
          .multiplyScalar(body.radiusAU)
      : null;
    const stateQ = computeBodyState(body, t).orientationQuaternion;
    const camDir = this.camera.position.clone().normalize();
    const sunFromCam = planetHelio.clone().multiplyScalar(-1).sub(this.camera.position).normalize();
    const moonMesh = this.planetMoons.get(landed.name)?.find((m) => m.data.name === moonName) ?? null;
    const modelMoonFromCam = offset.clone().sub(this.camera.position).normalize();
    const renderMoonFromCam = moonMesh
      ? moonMesh.mesh.position.clone().sub(this.camera.position).normalize()
      : null;
    return {
      utc: new Date(t).toISOString(),
      hasAnchor: !!this.surfaceSpotAnchor,
      quatDot: Math.abs(stateQ.dot(parentPlanet.group.quaternion)),
      anchorVsLiveSpotKm: anchorWorld ? anchorWorld.distanceTo(liveSpot) * KM : null,
      camVsAnchorDeg: anchorWorld
        ? THREE.MathUtils.radToDeg(camDir.angleTo(anchorWorld.clone().normalize()))
        : null,
      camVsLiveSpotDeg: THREE.MathUtils.radToDeg(camDir.angleTo(liveSpot.clone().normalize())),
      modelSepDeg: THREE.MathUtils.radToDeg(sunFromCam.angleTo(modelMoonFromCam)),
      renderSepDeg: renderMoonFromCam
        ? THREE.MathUtils.radToDeg(sunFromCam.angleTo(renderMoonFromCam))
        : null,
      renderVsModelMoonKm: moonMesh ? moonMesh.mesh.position.distanceTo(offset) * KM : null,
    };
  }

  /**
   * Headless-screenshot support: stand at one body and look toward another —
   * the far-marker taste view (how Earth's beacon reads from Neptune). Poses
   * the player a few radii out from `fromName` along the sightline so the
   * vantage body sits behind the camera, aims the camera straight at `toName`,
   * and hides the ship hull + HUD (the pose bypasses the chase rig, which
   * would otherwise park the hull across the frame). Markers and labels stay
   * on — they are the subject. Dev bridge only.
   */
  devViewFrom(fromName: string, toName: string, fovDeg = 45): boolean {
    if (!this.solarSystem) return false;
    const resolve = (name: string): { x: number; y: number; z: number } | undefined => {
      // The Sun sits at the heliocentric origin in the absolute coords this
      // pose works in (same convention as devFrameBody).
      if (name === 'Sun') return { x: 0, y: 0, z: 0 };
      return this.planetWorldPositions.get(name);
    };
    const from = resolve(fromName);
    const to = resolve(toName);
    if (!from || !to) return false;
    const fromR =
      this.solarSystem.planets.find((p) => p.data.name === fromName)?.data.radiusAU ??
      SUN_DATA.radiusAU;
    const dir = new THREE.Vector3(to.x - from.x, to.y - from.y, to.z - from.z);
    if (dir.lengthSq() < 1e-12) return false;
    dir.normalize();
    this.devFreeCamera = true;
    // A few radii out along the sightline: clear of the vantage body's own disc.
    this.player.posX = from.x + dir.x * fromR * 8;
    this.player.posY = from.y + dir.y * fromR * 8;
    this.player.posZ = from.z + dir.z * fromR * 8;
    this.player.headToward(to.x, to.z, to.y);
    this.player.moving = false;
    const sceneOffset = new THREE.Vector3(
      to.x - this.player.posX,
      to.y - this.player.posY,
      to.z - this.player.posZ,
    );
    const cam = this.camera as THREE.PerspectiveCamera;
    cam.position.set(0, 0, 0);
    // The lens owns overscan: applyDesignFov (via setDisplayFov) is the only
    // legal camera.fov writer — a raw `cam.fov = fovDeg` would set the display
    // FOV as the overscan and desync every lens seam.
    this.setDisplayFov(fovDeg);
    cam.up.set(0, 1, 0); // framing rig, not the cruise rig — world-up baseline
    cam.lookAt(sceneOffset);
    this.controls.target.copy(sceneOffset);
    this.showShip = false;
    this.player.group.visible = false;
    for (const id of ['planetarium-ui', 'top-bar']) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
    // Auto-exposure settles on its own from the smoothed target (same as the
    // sibling dev pose helpers) — no manual snap flag exists on this path.
    return true;
  }

  /**
   * Headless-screenshot support: park the camera close to a body and aim it
   * exactly at the limb's tangent point, so the horizon arc crosses the frame
   * center — the close-approach view where silhouette tessellation shows.
   * Stands on the sunlit side so the limb is lit. Dev bridge only.
   */
  devLimbView(name: string, kRadii = 1.5, fovDeg = 50): boolean {
    if (!this.solarSystem) return false;
    const body = this.planetWorldPositions.get(name);
    const r = this.solarSystem.planets.find((p) => p.data.name === name)?.data.radiusAU;
    if (!body || !r || kRadii <= 1) return false;
    const d = r * kRadii;
    // Sunward side: the Sun sits at the heliocentric origin of these coords.
    const sunward = new THREE.Vector3(-body.x, -body.y, -body.z).normalize();
    this.devFreeCamera = true;
    this.player.posX = body.x + sunward.x * d;
    this.player.posY = body.y + sunward.y * d;
    this.player.posZ = body.z + sunward.z * d;
    this.player.moving = false;
    // Tangent point T = B + R·n with n = −(R/d)·w + √(1−R²/d²)·v, where w is
    // the camera→center axis and v a perpendicular: the exact point where the
    // sight line grazes the sphere, putting the limb arc mid-frame.
    const w = sunward.clone().negate();
    const up = Math.abs(w.y) < 0.95 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const v = new THREE.Vector3().crossVectors(w, up).normalize();
    const rd = r / d;
    const n = w.clone().multiplyScalar(-rd).addScaledVector(v, Math.sqrt(1 - rd * rd));
    const tangentOffset = new THREE.Vector3(
      body.x + r * n.x - this.player.posX,
      body.y + r * n.y - this.player.posY,
      body.z + r * n.z - this.player.posZ,
    );
    const cam = this.camera as THREE.PerspectiveCamera;
    cam.position.set(0, 0, 0);
    // applyDesignFov (via setDisplayFov) is the only legal camera.fov writer
    // under the lens contract; a raw `cam.fov = fovDeg` desyncs the overscan.
    this.setDisplayFov(fovDeg);
    cam.up.set(0, 1, 0); // framing rig, not the cruise rig — world-up baseline
    cam.lookAt(tangentOffset);
    this.controls.target.copy(tangentOffset);
    this.showShip = false;
    this.player.group.visible = false;
    for (const id of ['planetarium-ui', 'top-bar']) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
    // Auto-exposure settles on its own from the smoothed target (same as the
    // sibling dev pose helpers) — no manual snap flag exists on this path.
    return true;
  }

  /** Peek the coverage meter for the dev bridge — telemetry only (the adapted
   *  Sun exposure in devSunAppearance() is what actually reaches the render). */
  devExposurePeek(): { target: number; coverage: number } {
    return { target: this.exposureTarget, coverage: this.exposureCoverage };
  }

  /** Swap the Sun's glow tier to match a runtime bloom toggle (the construction
   *  tier is baked from the hardware capability). Dev bridge only. */
  devApplySunGlowTier(useBloom: boolean): void {
    if (this.solarSystem) applySunGlowTier(this.solarSystem.sun, useBloom);
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
    // Dot + label render-truth (DEV QA): the moon's final screen alpha this
    // frame, the same alpha with illumination forced full (what the label gate
    // reads), and whether its label is shown. Null for a planet (no dot/label).
    let dotScreenAlpha: number | null = null;
    let dotLitScreenAlpha: number | null = null;
    for (const moons of this.planetMoons.values()) {
      const mm = moons.find((x) => x.data.name === name);
      if (mm) {
        dotScreenAlpha = mm.dotScreenAlpha ?? 0;
        dotLitScreenAlpha = mm.dotLitScreenAlpha ?? 0;
        break;
      }
    }
    const lbl = this.moonLabels.get(name);
    const labelVisible = lbl ? lbl.style.display !== 'none' : null;
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
      // Which frame the camera is riding: the flight horizon in cruise,
      // world-up landed and under the dev framing rigs.
      camUp: { x: cam.up.x, y: cam.up.y, z: cam.up.z },
      // The DISPLAYED field of view, never cam.fov: under the lens cam.fov
      // holds the overscan, and angular-size comparisons against it understate.
      fov: displayFovDeg(cam),
      overscanFov: cam.fov,
      moving: this.player.moving,
      devFree: this.devFreeCamera,
      camOwner: this.camOwner,
      userOrbiting: this.camOwner === 'orbit', // forensics back-compat
      dotScreenAlpha,
      dotLitScreenAlpha,
      labelVisible,
    };
  }

  // --- Dev motion trace: one render-truth sample per cruise frame, for motion
  // forensics (stutter hunting). The buffer is preallocated and the recorder
  // never allocates mid-flight — a GC pause is one of the suspects it exists
  // to catch, so it must not cause any itself.
  private devTraceBuf: Float64Array | null = null;
  private devTraceCount = 0;
  private devTraceMax = 0;
  private devTraceMesh: THREE.Mesh | null = null;
  private devTraceMoon: MoonMesh | null = null;
  private static readonly DEV_TRACE_FIELDS = [
    't', 'simMs', 'scrX', 'scrY', 'ndcZ',
    'camX', 'camY', 'camZ', 'moonX', 'moonY', 'moonZ',
    'speedAUPerS', 'capAUPerS',
    // Dot + label render-truth for the continuity invariant (DEV QA).
    'dotAlpha', 'dotSizePx', 'discPx', 'labelVis',
    // Camera forward (world): the aim-rate battery derives per-frame aim
    // angular velocity from consecutive samples to assert the cruise-aim
    // continuity cap (see cruiseAim.ts).
    'aimX', 'aimY', 'aimZ',
  ] as const;
  private devTraceWorld = new THREE.Vector3();
  private devTraceAim = new THREE.Vector3();
  private devTraceProj: ScreenProjection = { x: 0, y: 0, ndcX: 0, ndcY: 0, ndcZ: 0 };

  /** Start recording per-frame samples of a moon's rendered state. */
  devTraceStart(name: string, maxFrames = 3600): boolean {
    let mesh: THREE.Mesh | null = null;
    let moon: MoonMesh | null = null;
    for (const moons of this.planetMoons.values()) {
      const m = moons.find((mm) => mm.data.name === name);
      if (m) { mesh = m.mesh; moon = m; break; }
    }
    if (!mesh) return false;
    this.devTraceMesh = mesh;
    this.devTraceMoon = moon;
    this.devTraceMax = maxFrames;
    this.devTraceCount = 0;
    const n = PlanetariumMode.DEV_TRACE_FIELDS.length;
    if (!this.devTraceBuf || this.devTraceBuf.length < maxFrames * n) {
      this.devTraceBuf = new Float64Array(maxFrames * n);
    }
    return true;
  }

  /** Stop and return the recorded rows (layout = DEV_TRACE_FIELDS). */
  devTraceStop(): { fields: readonly string[]; rows: number[][] } | null {
    const buf = this.devTraceBuf;
    if (!buf) return null;
    const n = PlanetariumMode.DEV_TRACE_FIELDS.length;
    const rows: number[][] = [];
    for (let i = 0; i < this.devTraceCount; i++) {
      rows.push(Array.from(buf.subarray(i * n, (i + 1) * n)));
    }
    this.devTraceMesh = null;
    this.devTraceMoon = null;
    this.devTraceBuf = null;
    return { fields: PlanetariumMode.DEV_TRACE_FIELDS, rows };
  }

  private devTraceRecord() {
    const mesh = this.devTraceMesh;
    const buf = this.devTraceBuf;
    if (!mesh || !buf || this.devTraceCount >= this.devTraceMax) return;
    // Sample what the GPU will draw this frame: refresh the world matrices of
    // just this mesh + the camera, then project through the live projection.
    mesh.updateWorldMatrix(true, false);
    this.devTraceWorld.setFromMatrixPosition(mesh.matrixWorld);
    this.camera.updateMatrixWorld();
    const el = this.renderer.domElement;
    const proj = projectToScreen(
      this.devTraceWorld, this.camera, el.clientWidth, el.clientHeight, this.devTraceProj);
    const n = PlanetariumMode.DEV_TRACE_FIELDS.length;
    let k = this.devTraceCount * n;
    buf[k++] = performance.now();
    buf[k++] = this.getCurrentUtcMs();
    buf[k++] = proj.x;
    buf[k++] = proj.y;
    buf[k++] = proj.ndcZ;
    buf[k++] = this.camera.position.x;
    buf[k++] = this.camera.position.y;
    buf[k++] = this.camera.position.z;
    buf[k++] = this.devTraceWorld.x;
    buf[k++] = this.devTraceWorld.y;
    buf[k++] = this.devTraceWorld.z;
    buf[k++] = this.player.speedAUPerS;
    buf[k++] = this.player.speedCapAUPerS;
    // Dot + label render-truth: the moon's final screen alpha/size from the dot
    // pass, the disc diameter it was measured against, and whether its label is
    // shown this frame — the fields the outbound continuity invariant reads.
    const moon = this.devTraceMoon;
    let dotAlpha = 0, dotSizePx = 0, disc = 0, labelVis = 0;
    if (moon) {
      dotAlpha = moon.dotScreenAlpha ?? 0;
      dotSizePx = moon.dotScreenSizePx ?? 0;
      const renderedR = moon.data.radiusAU * moon.mesh.scale.x;
      disc = projectSphereToScreen(
        this.devTraceWorld,
        renderedR,
        this.camera,
        el.clientWidth,
        el.clientHeight,
        this.sphereScreenProjection,
      ).diameterPx;
      const lbl = this.moonLabels.get(moon.data.name);
      labelVis = lbl && lbl.style.display !== 'none' ? 1 : 0;
    }
    buf[k++] = dotAlpha;
    buf[k++] = dotSizePx;
    buf[k++] = disc;
    buf[k++] = labelVis;
    this.camera.getWorldDirection(this.devTraceAim);
    buf[k++] = this.devTraceAim.x;
    buf[k++] = this.devTraceAim.y;
    buf[k] = this.devTraceAim.z;
    this.devTraceCount++;
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

  /** Headless support: a cruise teleport through the REAL pick pipeline
   *  (commitBodyPick → arriveThen, its veil, and the arrival warm-up) —
   *  unlike devJumpToBody, which poses the jump directly and resolves
   *  top-level planets only. Resolves a planet, else a moon by name. */
  devTravelTo(name: string): boolean {
    if (!this.active || !this.solarSystem) return false;
    let target: NonNullable<LandedTarget> | null = null;
    if (this.solarSystem.planets.some((p) => p.data.name === name)) {
      target = { type: 'planet', name };
    } else {
      for (const [parentName, moons] of this.planetMoons) {
        if (moons.some((m) => m.data.name === name)) {
          target = { type: 'moon', name, parentPlanet: parentName };
          break;
        }
      }
    }
    return target ? this.commitBodyPick('travel', target, {}) : false;
  }

  /** Headless support: an Observatory relocation through the REAL pick
   *  pipeline (commitBodyPick → arriveThen and its veil), unlike devLand,
   *  which enters landed mode directly and never raises the cover. */
  devObserve(name: string): boolean {
    // Unlike devLand this refuses when another mode owns the screen: the
    // relocation would flash the global arrival veil over that mode.
    if (!this.active || !this.solarSystem) return false;
    let target: NonNullable<LandedTarget> | null = null;
    if (this.solarSystem.planets.some((p) => p.data.name === name)) {
      target = { type: 'planet', name };
    } else {
      for (const [parentName, moons] of this.planetMoons) {
        if (moons.some((m) => m.data.name === name)) {
          target = { type: 'moon', name, parentPlanet: parentName };
          break;
        }
      }
    }
    return target ? this.commitBodyPick('observe', target, {}) : false;
  }

  /** Headless support: enter the volume-compare tool through the REAL gate, so a
   *  test exercises the same snapshot capture + tutorial/mission refusal a user
   *  gets (the raw switchAppMode path would bypass the pre-tool snapshot). */
  devEnterVolumeCompare(): void {
    this.requestVolumeCompare();
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
    // Through the one panel-open sequence, so the dev bridge lights the
    // cluster chip exactly like the user path.
    this.openObservatoryPanel();
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
    // Measure against the DISPLAYED field of view, never cam.fov: under the
    // lens cam.fov holds the overscan, which would systematically understate
    // the fill fraction — the exact number this probe exists to pin.
    const displayFov = displayFovDeg(cam);
    return {
      landedOn: this.landedOn ? { type: this.landedOn.type, name: this.landedOn.name } : null,
      view: this.landedView,
      fov: displayFov,
      surfaceFovDeg: this.surfaceFovDeg,
      camLenAU: camLen,
      subjectName,
      subjectAngularDeg,
      subjectFillFraction: displayFov > 0 ? subjectAngularDeg / displayFov : 0,
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
    // Tools mirrors the Observatory button's mission-hide (visible in cruise AND
    // landed; only a mission takes it away). Set both here.
    const tools = document.getElementById('planetarium-btn-tools');
    if (tools) tools.style.display = missionActive ? 'none' : '';
    // The panel is a landed-state surface: takeoff closes it (every landed
    // body is a subject — moonless ones get the Quiet-sky variant). The deck
    // is legal in any state but missions own the ship.
    if (missionActive || !this.landedOn) this.closeObservatoryPanel();
    if (missionActive) {
      this.closeDeck();
      this.closeSurfaceTargetMenu();
      this.closeToolsMenu();
    }
  }

  private closeObservatoryPanel() {
    this.observatoryPanel.hide();
    this.cancelObservatoryEventSearch();
    this.updateClusterOnStates();
  }

  /** The one panel-open sequence (idempotent): one instrument at a time —
   *  the Stats card yields — then render, kick the upcoming-events search,
   *  and light the cluster chip. Tools closes too: every pointer path folds
   *  it via its full-screen catcher, but the O key arrives here directly and
   *  would otherwise open the panel beneath the still-standing catcher. */
  private openObservatoryPanel() {
    this.closeToolsMenu();
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
      this.coachSuppressesNextSurfaceHint = false;
      this.exitSurfaceView();
      return;
    }
    // Second click while the picker is up reads as "never mind".
    if (this.surfaceTargetMenu.isOpen()) {
      this.coachSuppressesNextSurfaceHint = false;
      this.closeSurfaceTargetMenu();
      return;
    }
    // A live event outranks the picker and the remembered pick alike — the
    // window says what is overhead, so the click has to deliver exactly that.
    if (this.liveShadowEventNow()) {
      this.watchLiveEvent();
      return;
    }
    if (this.lookupOpensMenu()) {
      this.coachSuppressesNextSurfaceHint = false;
      this.openSurfaceTargetMenu();
      return;
    }
    const pick = this.surfacePickedTarget;
    if (pick) this.enterSurfaceView(pick, 'companion');
    else this.enterSurfaceView();
    this.dismissSheetAfterDoorEntry();
  }

  /**
   * Entering the surface through the panel commits the screen to the sky —
   * and the ≤640px sheet is an overlay covering exactly that sky, holding
   * the HUD lifted into it. It leaves with the click; the desktop panel sits
   * beside the scene and stays.
   */
  private dismissSheetAfterDoorEntry() {
    if (this.landedView === 'surface' && this.observatoryPanel.sheetFormActive()) {
      this.closeObservatoryPanel();
    }
  }

  /**
   * Step onto the ground the live event is worth watching from: relocate
   * when another body in the system is the better seat, then point the sky
   * at what the event looks like from there.
   *
   * Shadow guides ride along deliberately — an explicit step through the
   * window enters the surface with the cones still drawn (they render there),
   * and leaving restores the instrument view.
   */
  private watchLiveEvent() {
    // Missions hide the Observatory control and close its panel; the watch
    // row and window can outlive the panel by the length of a click.
    if (this.isMissionActive()) {
      this.coachSuppressesNextSurfaceHint = false;
      return;
    }
    const event = this.liveShadowEventNow();
    const landed = this.surfaceLandedInfo();
    if (!event || !landed) {
      this.coachSuppressesNextSurfaceHint = false;
      return;
    }
    // The tutorial stages its own ground, clock and surface entry, and holds
    // its Next button on a fixed instant of that staging: a click under an
    // open card must not move the ground beneath it. It still enters — a
    // control that does nothing reads as broken.
    const tutorialActive = this.tutorial !== null;
    const relocate = !tutorialActive && this.liveEventRelocates(event, landed);
    const wasSurface = relocate
      ? this.relandInSystem({ type: 'planet', name: event.spec.parentPlanet })
      : this.landedView === 'surface';
    // Built AFTER any re-land: hoisted, it would select the surface target
    // for the vantage the step just left.
    const landedInfo = this.surfaceLandedInfo();
    if (!landedInfo) return;
    // The surface HUD narrates from the last event — this step is what makes
    // this one the sky being watched.
    this.lastObservatoryEvent = event;
    this.enterSurfaceView(selectSurfaceTarget(landedInfo, event.spec), 'event', {
      // From the ground the re-point must snap: easing would show the new
      // body at the old body's zoom. From orbit the flag is a no-op and the
      // normal entry glide runs.
      immediate: wasSurface,
      // Every live entry puts the event's own toast in the single
      // notification slot, so the one-time controls hint would be consumed
      // unread.
      suppressHint: true,
    });
    if (relocate) {
      // Row hints and ∅ badges are observer-conditioned and baked at publish
      // time — republish so they describe the ground you now stand on.
      this.renderObservatoryPanel();
      this.publishObservatoryEvents();
    }
    this.dismissSheetAfterDoorEntry();
    if (tutorialActive) return;
    this.notification.show(
      this.jumpToastPrefix(relocate ? event.spec.parentPlanet : null) +
        this.describeShadowEvent(event),
    );
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
      !this.liveShadowEventNow() &&
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
    this.closeToolsMenu();
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
    this.dismissSheetAfterDoorEntry();
  }

  private renderObservatoryPanel() {
    if (!this.observatoryPanel.isOpen() || !this.landedOn) return;
    const subject = this.buildObservatorySubject();
    const landed = this.surfaceLandedInfo();
    if (!subject || !landed) return;
    const live = this.liveShadowEventNow();
    const extras: ObservatoryRenderExtras = {
      vantageName: `From ${bodyDisplayName(this.landedOn.name)}`,
      // A verb, not a place: the bare name read as a link to the Moon.
      swapName: (() => {
        const companion = this.swapCompanionTarget();
        return companion ? `Stand on ${bodyDisplayName(companion.name)}` : null;
      })(),
      nowTag: this.observatoryNowTag(),
      // The tag's other job is the rate label — worth replacing only where
      // that would read the uninformative "realtime". Every jump parks at
      // rate 1, unpaused, so a jump into an event always shows the verb.
      nowVerb:
        live && this.timeState.rate === 1 && !this.timeState.paused
          ? liveEventVerb(live.spec)
          : null,
      nextDates: this.observatoryNextDates(),
      finderAffix: this.landedOn.type === 'moon' ? `from ${this.landedOn.parentPlanet}` : null,
      window: {
        surfaceActive: this.landedView === 'surface',
        lookupOpensMenu: this.lookupOpensMenu(),
        landed,
        live: live ? { spec: live.spec, classification: live.classification } : null,
        relocates: live ? this.liveEventRelocates(live, landed) : false,
      },
      // The tutorial stages its own scenes through this panel and owns the
      // single card slot; a coach mark under one of them is noise.
      showCoach:
        this.tutorial === null &&
        this.landedView !== 'surface' &&
        !this.store.hasSeenLookupCoach(),
    };
    this.observatoryPanel.render(this.timeState.currentUtcMs, subject, extras);
  }

  /** Would stepping through the window re-land the player first? */
  private liveEventRelocates(event: ShadowEvent, landed: SurfaceLandedInfo): boolean {
    return resolveShowVantage({
      eventParentPlanet: event.spec.parentPlanet,
      eventMoonName: event.spec.moonName,
      landed,
    }).relocateToParent;
  }

  /** One subject per instant: the panel and the surface HUD both render on
   *  the same 8 Hz tick, and on a moon vantage each build costs several full
   *  ephemeris evaluations (parent illumination + waxing probes). The
   *  subject is a pure function of the clock and the vantage identity, so
   *  key on exactly those. */
  private observatorySubjectMemo: {
    utcMs: number; type: string; name: string; value: ObservatorySubjectInfo | null;
  } | null = null;

  private buildObservatorySubject(): ObservatorySubjectInfo | null {
    if (!this.landedOn) return null;
    const memo = this.observatorySubjectMemo;
    if (
      memo &&
      memo.utcMs === this.timeState.currentUtcMs &&
      memo.type === this.landedOn.type &&
      memo.name === this.landedOn.name
    ) {
      return memo.value;
    }
    const value = this.buildObservatorySubjectUncached();
    this.observatorySubjectMemo = {
      utcMs: this.timeState.currentUtcMs,
      type: this.landedOn.type,
      name: this.landedOn.name,
      value,
    };
    return value;
  }

  /** The phase hero's subject, with disc data read from the rendered scene objects. */
  private buildObservatorySubjectUncached(): ObservatorySubjectInfo | null {
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
        tintCss: this.bodyTintCss(subject),
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
        tintCss: this.bodyTintCss(parentName),
      };
    }
    if (getMoonsByPlanet(parentName).length === 0) {
      return {
        kind: 'companionless',
        planetName: parentName,
        tintCss: this.bodyTintCss(parentName),
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
    // A bare date, no "next ·" prefix: the row is a finder, so the date on it
    // can only be the next one — and the line also carries the almanac affix
    // and two steppers.
    const dateMeta = (ms: number | null) => (ms ? formatDateCompact(ms) : '');
    // Eclipse rows reuse the single-result upcoming search, which reports an
    // in-progress event — label that case "now" instead of a parked-at date.
    const eclipseMeta = (event: ShadowEvent | undefined) => {
      if (!event) return searchActive ? '· · ·' : '';
      if (now >= event.startUtcMs && now <= event.endUtcMs) return 'now';
      return formatDateCompact(event.peakUtcMs);
    };
    return {
      full: dateMeta(fresh.fullMs),
      new: dateMeta(fresh.newMs),
      lunar: eclipseMeta(this.observatoryEventResults.get('eclipse|Moon')),
      solar: eclipseMeta(this.observatoryEventResults.get('shadow-transit|Moon')),
    };
  }

  /**
   * The event in this system's sky right now — what the panel's window and
   * watch row offer to take you to. Resolved from the events the chunked
   * upcoming search has already found, so asking costs a map walk and never
   * a search; re-resolved at click time so the offer and what it delivers
   * can't disagree.
   */
  private liveShadowEventNow(): ShadowEvent | null {
    const parentPlanet = this.observatoryParentPlanetName();
    if (!parentPlanet) return null;
    return resolveLiveEvent(
      this.timeState.currentUtcMs,
      parentPlanet,
      this.observatoryEventResults.values(),
      this.lastObservatoryEvent,
    );
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

  /** True when the surface view is pointed at the phase hero's own subject —
   *  the body the no-event headline is describing. */
  private isPhaseSubjectTracked(info: ObservatorySubjectInfo): boolean {
    const target = this.surfaceTarget;
    if (info.kind === 'earth') {
      return info.subject === 'Moon'
        ? target.kind === 'moon' && target.moonName === 'Moon'
        : target.kind === 'parent';
    }
    return info.kind === 'moon-phase' && target.kind === 'parent';
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
      // A new companion is a real sight the frame cannot show: the disc is up
      // there with its night side turned to you. Say so, or an empty frame
      // reads as the body having failed to load. Keyed to the headline's own
      // phase name — a "New" name spans under ~1% lit — so this line can never
      // call a disc dark while the headline calls it a crescent.
      if (
        subject &&
        phase &&
        phase.headline.startsWith('New ') &&
        this.isPhaseSubjectTracked(subject)
      ) {
        subText += ' — its unlit side faces you, so the disc is dark';
      }
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
      fovDeg: displayFovDeg(this.camera),
      tracking: this.surfaceTracking,
      // The chip shows the name standalone, so the prose article goes: "Sun",
      // not "the Sun".
      targetName: this.surfaceTargetDisplayName(this.surfaceTarget).replace(/^the /, ''),
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
    // A moonless system has no shadow events to search — the shared sweep
    // refuses one, and the panel publishes the empty list instead of ticking a
    // zero-spec search every frame.
    this.observatoryEventSearch = startShadowEventSearch(
      parentPlanet,
      this.timeState.currentUtcMs,
    );
    this.observatoryEventAnchorUtcMs = this.timeState.currentUtcMs;
    this.publishObservatoryEvents();
  }

  private cancelObservatoryEventSearch() {
    this.observatoryEventSearch = null;
    this.observatoryEventResults.clear();
    this.observatoryRowsMinEndUtcMs = null;
    this.observatoryEventAnchorUtcMs = null;
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
    // Reverse playback (the transport rail steps below pause into reverse)
    // can run the clock BEHIND the anchor the list was searched forward from:
    // every event between now and the anchor is then missing from "Upcoming",
    // and the forward expiry check below can never notice — its threshold sits
    // weeks ahead of the receded clock. While the clock is still flowing
    // backward a restart would only re-anchor ahead of an ever-receding now,
    // so hold; the first check after reverse ends (pause or forward) rebuilds.
    // Still-standing rows survive the sweep — from back here they are all
    // valid future events, just no longer the nearest ones.
    const anchor = this.observatoryEventAnchorUtcMs;
    if (anchor !== null && this.timeState.currentUtcMs < anchor) {
      if (this.timeState.rate < 0 && !this.timeState.paused) return;
      this.startObservatoryEventSearch({ preserveValidResults: true });
      return;
    }
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
    // Liveness stays with the caller: the shared sweep knows nothing about
    // panels, and a closed one has nothing to fill.
    if (!this.observatoryPanel.isOpen()) {
      this.cancelObservatoryEventSearch();
      return;
    }
    const done = stepShadowEventSearch(
      search,
      PlanetariumMode.OBSERVATORY_SEARCH_FRAME_BUDGET_MS,
      this.eventSearchSlice,
    );
    for (const event of this.eventSearchSlice) {
      this.observatoryEventResults.set(shadowEventSpecKey(event.spec), event);
    }
    if (this.eventSearchSlice.length > 0 || done) this.publishObservatoryEvents();
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
    this.observatoryPanel.setEvents(rows, status);
  }

  /**
   * Jump to a shadow event: park the clock just before its peak and show the
   * event from where the player already is. A jump moves time and nothing
   * else — not the ground, not the view mode. The sky window is the one door
   * to the surface, and it is the click that carries relocation and aim.
   */
  private jumpToShadowEvent(event: ShadowEvent) {
    // Missions hide the Observatory control and close its panel: a jump
    // reaching the handler is a click that outlived the panel it came from.
    // Same for a takeoff — every jump is an Observatory verb, and with no
    // ground under it it would only warp the clock mid-cruise.
    if (this.isMissionActive() || !this.landedOn) return;
    // A jump moves the clock — every ∅ the open picker baked is now wrong.
    this.closeSurfaceTargetMenu();
    // The clock leaps to the event and reframes; reseed the flash baseline so
    // the jump's one-frame visibility step doesn't fire a Sun emergence.
    this.noteSunViewDiscontinuity();
    this.lastObservatoryEvent = event;
    // Park shortly before the peak with the clock running at 1× real time —
    // the user watches the event happen instead of landing on a frozen peak.
    this.timeState = { ...this.timeState, rate: 1, paused: false };
    this.setCurrentUtcMs(event.peakUtcMs - OBSERVATORY_JUMP_LEAD_MS);
    this.observatoryPanel.flashNowBar();
    // The clock just moved, so realign the scene graph before the entry FOV
    // fit and the orbit framing read the geometry off it.
    this.refreshLandedScene();
    const landedInfo = this.surfaceLandedInfo();
    if (this.landedView === 'surface' && landedInfo) {
      // Already on the ground: re-point the sky it is showing, from the ground
      // it is standing on. A jump never relocates — the window carries the
      // better-vantage offer, and taking it is the user's call.
      this.enterSurfaceView(selectSurfaceTarget(landedInfo, event.spec), 'event', {
        suppressHint: true,
      });
    } else {
      this.frameObservatoryEvent(event.spec);
    }
    // Sheet form: a jump parks the sheet at peek — the framed event clears
    // the sheet and the peek's now-bar shows when you are. The bottom time
    // pill is hidden while the sheet is open.
    this.observatoryPanel.collapseSheetToPeek();
    this.renderObservatoryPanel();
    this.startObservatoryEventSearch();
    // One toast per jump. Nothing moved but the clock, so it leads with the
    // event itself.
    this.notification.show(this.describeShadowEvent(event) + this.observatoryJumpHandoff());
  }

  /**
   * The instant after a jump is the weakest moment in the whole flow: the
   * clock moved and it isn't obvious what to do next. When the jump left the
   * window live, flash it — and when the step it now offers would move the
   * player to better ground, say so in the toast. Returns the suffix.
   */
  private observatoryJumpHandoff(): string {
    const live = this.liveShadowEventNow();
    if (!live) return '';
    this.observatoryPanel.flashWindow();
    const landed = this.surfaceLandedInfo();
    if (!landed || !this.liveEventRelocates(live, landed)) return '';
    return ` — Look up to stand on ${bodyDisplayName(live.spec.parentPlanet)}`;
  }

  /** "Standing on Earth — " when the step moved you there; '' when it didn't. */
  private jumpToastPrefix(relocatedTo: string | null): string {
    return relocatedTo ? `Standing on ${bodyDisplayName(relocatedTo)} — ` : '';
  }

  private static shadowSpecsEqual(a: ShadowEventSpec, b: ShadowEventSpec): boolean {
    return a.kind === b.kind && a.parentPlanet === b.parentPlanet && a.moonName === b.moonName;
  }

  /**
   * The four Earth-almanac stepper rows. They are event-TYPE requests named
   * for Earth-sky phenomena — the row says whose almanac that is — and like
   * every jump they move the clock alone: the ground and the view stay put.
   */
  private handleObservatoryJump(type: EventType, direction: 1 | -1) {
    // Stepper clicks defer 10 ms so the pressed pill paints before the search
    // blocks the thread; a mission can begin in that gap, and it hides the
    // Observatory control and closes the panel this click came from. A
    // takeoff fits in the gap too — a jump with no ground under it would
    // warp the clock mid-cruise.
    if (this.isMissionActive() || !this.landedOn) return;
    // Same clock-move staleness as the shadow jumps (which close it again).
    this.closeSurfaceTargetMenu();
    // Same clock-leap-and-reframe as the shadow jumps: reseed the flash baseline
    // (the eclipse branch also routes through jumpToShadowEvent, which reseeds).
    this.noteSunViewDiscontinuity();
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
    // A full-moon jump can land inside a coinciding lunar eclipse. Adopt it:
    // the HUD then narrates the eclipse over the phase framing (same body,
    // wider story), the eclipse steppers treat it as parked and search past
    // it, and the window stays lit through the frames the restarted search
    // below needs to re-find it — resolved now, while the old results still
    // hold the event. FORWARD steps only: a PREV jump lands before the old
    // results' search anchor, so a coinciding eclipse there resolves null and
    // lights up a few seconds later, when the restarted sweep re-finds it —
    // accepted over paying a second ~40-lunation probe on every backward
    // step. With nothing overhead the last event simply stands; it only ever
    // resurfaces through its own window gate.
    const coinciding = this.liveShadowEventNow();
    if (coinciding) this.lastObservatoryEvent = coinciding;
    // Same reason as the shadow jumps: the clock moved, so realign the scene
    // graph before anything fits a FOV off it.
    this.refreshLandedScene();
    const landedInfo = this.surfaceLandedInfo();
    if (this.landedView === 'surface' && landedInfo) {
      // Phase jumps point the surface view at the companion (the Moon you
      // just made full), never at an event geometry.
      this.enterSurfaceView(selectSurfaceTarget(landedInfo, null), 'companion', {
        suppressHint: true,
      });
    } else {
      this.frameObservatoryEvent();
    }
    // Same sheet-to-peek policy as the shadow jumps.
    this.observatoryPanel.collapseSheetToPeek();
    this.renderObservatoryPanel();
    this.startObservatoryEventSearch();
    // Toast leads with the date — after a jump, *when* is the headline. A
    // phase jump can still land inside a coinciding eclipse, so it gets the
    // same hand-off.
    this.notification.show(
      `${formatUtcLabel(found.getTime())} — ${OBSERVATORY_EVENT_LABELS[type]}` +
        this.observatoryJumpHandoff(),
    );
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
        // Indexed, not scanned: the surface camera resolves its target every
        // landed frame, and a .find here is a fresh closure per frame.
        const parent = this.planetMeshByName.get(this.landedOn.parentPlanet);
        return parent ? out.copy(parent.group.position) : null;
      }
      case 'moon': {
        const parentName = this.observatoryParentPlanetName();
        if (!parentName) return null;
        const moonMesh = this.moonMeshByName.get(target.moonName);
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
   * easing it when already in surface view — used where the body underfoot
   * changed (see the re-point branch). `suppressHint` is for entries that put
   * their own message in the notification slot right after (see the hint).
   */
  enterSurfaceView(
    target?: SurfaceTarget,
    entryContext?: SurfaceEntryContext,
    opts?: { immediate?: boolean; suppressHint?: boolean },
  ) {
    const perfSpan = import.meta.env.DEV ? surfacePerfBeginSpan('enterSurfaceView') : null;
    try {
      this.enterSurfaceViewImpl(target, entryContext, opts);
    } finally {
      if (import.meta.env.DEV) {
        surfacePerfEndSpan(perfSpan, {
          programs: this.renderer.info.programs?.length ?? 0,
          textures: this.renderer.info.memory.textures,
        });
      }
    }
  }

  private enterSurfaceViewImpl(
    target?: SurfaceTarget,
    entryContext?: SurfaceEntryContext,
    opts?: { immediate?: boolean; suppressHint?: boolean },
  ) {
    const landedInfo = this.surfaceLandedInfo();
    if (!landedInfo) return;
    // Consume the coach's one-entry hint suppression here, whichever branch
    // below this entry takes — it belongs to the click, not to the outcome.
    const coachSuppress = this.coachSuppressesNextSurfaceHint;
    this.coachSuppressesNextSurfaceHint = false;
    this.clearBodyReveal();
    // Entering surface view drops the landed system's 5%-of-parent mesh-scale
    // floor, so a moon shrinks to its true silhouette in one frame — its Sun
    // occlusion can fall and the exposed fraction rise. Re-pointing/event jumps
    // also move the clock. Reseed the flash baseline so neither reads as a real
    // limb clearing (the ongoing per-frame emergence is untouched).
    this.noteSunViewDiscontinuity();
    // Entering (or re-pointing — event jumps route here too) supersedes any
    // open picker; this also makes the pick handler self-closing.
    this.closeSurfaceTargetMenu();
    this.bottomBar.closeStats();
    // Surface view hides the whole bottom bar — an open Time panel would
    // otherwise reappear stale on exit.
    this.bottomBar.closeTime();
    // Surface view hides the ☰ button with the rest of the top cluster, so a
    // menu left open would float orphaned over the sky with Escape mapped to
    // the view exit, not the menu.
    this.closeMenuPanel();
    // Manual entry right after an event jump points at the event's
    // observer-level target — "Look up" during an eclipse shows the eclipse.
    const liveEvent = this.relevantObservatoryEvent();
    this.surfaceTarget = target ?? selectSurfaceTarget(landedInfo, liveEvent?.spec ?? null);
    // Fresh standing point per entry/re-point: an event jump routes here, so
    // the next spot frame re-pins from the (possibly new) event's peak.
    this.surfaceSpotAnchor = null;
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
      if (opts?.immediate) {
        // The ground under the observer changed, so easing the FOV would
        // show the new body at the old body's zoom for ~½s — a jarring flash
        // (swap to Earth briefly fills the frame; swap to the Moon opens as a
        // speck and "grows in"), which reads as the swap lagging or not firing.
        // Snap straight to the fitted framing; the vantage re-pins next frame.
        this.surfaceFovAnim = null;
        this.setDisplayFov(entryFov);
        return;
      }
      // Re-point (event jump): a short ease to the new target's fitted FOV
      // (predictable framing beats preserving a zoom tuned for the previous
      // subject). If the ENTRY glide is still running, carry a position ease
      // too: a positionless anim pins the camera straight to the (possibly
      // relocated) vantage next frame — a visible mid-air pop when an event
      // row is clicked inside the entry's 0.35 s. Seed it from the camera's
      // live position so the glide continues from exactly where it is.
      const midEntryGlide = this.surfaceFovAnim?.fromPos != null;
      this.surfaceFovAnim = {
        fromFov: displayFovDeg(this.camera),
        toFov: entryFov,
        fromPos: midEntryGlide ? this.camera.position.clone() : null,
        elapsed: 0,
        duration: 0.45,
        finalizeExit: false,
      };
      return;
    }
    this.landedView = 'surface';
    // An open panel survives the entry: its event rows and vantage button are
    // how the sky was found, and losing them on "Look up" read as the panel
    // vanishing. Re-showing parks the phone sheet at peek so the centred
    // subject stays clear; the HUD's Observatory chip still toggles it both
    // ways, and a closed panel stays closed — the bare sky is the default.
    if (this.observatoryPanel.isOpen()) this.observatoryPanel.show();
    // The orbit-details overlay is an orbit-view instrument — the surface sky
    // must not carry ellipse axes/sectors across it.
    this.syncOrbitDetailsVisibility();
    this.preSurfaceCameraPos.copy(this.camera.position);
    this.preSurfaceAutoRotate = this.controls.autoRotate;
    this.controls.enabled = false;
    this.surfaceLook.attach();
    this.setSurfaceLabelContainersHidden(true);
    // One-time controls hint on first-ever surface entry. Tutorial, event-jump
    // and just-read-the-coach entries skip it entirely: each puts its own
    // message in the single notification slot immediately after, so showing
    // the hint would consume the seen-flag without the user ever reading it.
    if (!this.tutorial && !opts?.suppressHint && !coachSuppress && !this.store.hasSeenSurfaceHint()) {
      this.store.markSurfaceHintSeen();
      this.notification.show('Drag to look around · scroll or pinch to zoom');
    }
    this.surfaceFovAnim = {
      fromFov: displayFovDeg(this.camera),
      toFov: entryFov,
      fromPos: this.preSurfaceCameraPos.clone(),
      elapsed: 0,
      // Keep enough motion to explain the orbit→ground viewpoint change, but
      // finish quickly enough that the first click never reads as input lag.
      duration: 0.35,
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
      fromFov: displayFovDeg(this.camera),
      toFov: 60,
      fromPos: null,
      elapsed: 0,
      duration: 0.45,
      finalizeExit: true,
    };
  }

  private finalizeSurfaceExit() {
    this.landedView = 'orbit';
    // The telescope's light grasp leaves with the telescope: no easing back on
    // the way out, or the cruise sky would carry a lifted faint end for a beat.
    this.starGain = 1;
    if (this.starfield) setStarfieldGain(this.starfield, 1);
    this.surfaceFovAnim = null;
    this.surfaceSpotAnchor = null;
    this.surfaceLook.detach();
    // Back to the landed orbit view, which is world-up (OrbitControls' cached
    // orbit axis is already world-up from the landing). The cruise basis is
    // the flight horizon and gets reapplied by resetCruiseCamera on takeoff.
    this.camera.up.set(0, 1, 0);
    this.setDisplayFov(60);
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
    // The marker sprites are Three.js objects owned by the renderLabels loop,
    // which surface view skips — clear them only when nothing should paint them
    // (entering surface view, or both the label and marker flags off). Exiting
    // with labels off but markers on leaves them for the pipeline to revive.
    if (hidden || (!this.showBodyLabels && !this.showBodyMarkers)) this.planetLabels?.hideAll();
  }

  /** Drag look-around: content follows the finger; any drag breaks tracking. */
  private applySurfaceLook(dxPx: number, dyPx: number) {
    if (this.landedView !== 'surface') return;
    this.surfaceTracking = false;
    // A full-viewport-height drag pans one FOV — "grab the sky".
    const radPerPx =
      (displayFovDeg(this.camera) * DEG2RAD) / Math.max(this.renderer.domElement.clientHeight, 1);
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
      this.setDisplayFov(this.surfaceFovDeg);
    }
  }

  /**
   * Lazily pin the stand-still eclipse anchor from the relevant event's peak
   * geometry, through the same astronomy seams the shadow engine and the
   * renderer share (allocations are pin-time only). Null when no matching
   * shadow-transit event is in reach — the caller then rides the live axis
   * point as a defensive fallback.
   */
  private ensureSurfaceSpotAnchor(occluderMoonName: string): THREE.Vector3 | null {
    if (this.surfaceSpotAnchor) return this.surfaceSpotAnchor;
    const landed = this.landedOn;
    if (landed?.type !== 'planet') return null;
    const event = this.relevantObservatoryEvent();
    if (
      !event ||
      event.spec.kind !== 'shadow-transit' ||
      event.spec.parentPlanet !== landed.name ||
      event.spec.moonName !== occluderMoonName
    ) {
      return null;
    }
    const body = PLANETARIUM_BODIES.find(b => b.name === landed.name);
    if (!body) return null;
    const offset = computeMoonOffsetEquatorialAU(
      occluderMoonName,
      landed.name,
      event.peakUtcMs,
      new THREE.Vector3(),
    );
    const axis = computeBodyPositionAU(body, event.peakUtcMs).add(offset).normalize();
    this.surfaceSpotAnchor = computeSpotAnchorLocal(
      offset,
      axis,
      body.radiusAU,
      computeBodyState(body, event.peakUtcMs).orientationQuaternion,
      new THREE.Vector3(),
    );
    return this.surfaceSpotAnchor;
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
      const occluder = this.moonMeshByName.get(
        (this.surfaceTarget as { occluderMoonName: string }).occluderMoonName,
      );
      if (parentPos && occluder) {
        // Stand still and let the eclipse come to you: the vantage is the
        // peak's shadow-spot point carried in the planet's rotating frame.
        // Re-deriving the point from the live shadow geometry every frame
        // chased maximum cover instead — three Sun-occluder alignments per
        // event where a real observer sees one clean pass.
        const parentPlanet = this.planetMeshByName.get(parentName);
        let anchor = this.ensureSurfaceSpotAnchor(occluder.data.name);
        if (!anchor && parentPlanet) {
          // No pinnable event (defensive) — pin at the CURRENT live spot
          // instead of riding it per frame: per-frame re-derivation is the
          // max-cover chase (three Sun–occluder alignments per event) that
          // stand-still anchoring exists to prevent.
          const axis = this.tmpSurfaceAxis
            .set(parentPos.x, parentPos.y, parentPos.z)
            .add(occluder.mesh.position)
            .normalize();
          anchor = this.surfaceSpotAnchor = computeSpotAnchorLocal(
            occluder.mesh.position,
            axis,
            radiusAU,
            parentPlanet.group.quaternion,
            new THREE.Vector3(),
          );
        }
        if (anchor && parentPlanet) {
          computeAnchoredSpotVantage(radiusAU, anchor, parentPlanet.group.quaternion, vantage);
          spotPosed = true;
        } else {
          // No planet entity to express the rotating frame (shouldn't happen)
          // — the live axis point still beats the sub-target default.
          const axis = this.tmpSurfaceAxis
            .set(parentPos.x, parentPos.y, parentPos.z)
            .add(occluder.mesh.position)
            .normalize();
          computeShadowSpotVantage(radiusAU, occluder.mesh.position, axis, vantage);
          spotPosed = true;
        }
      }
    }
    if (!spotPosed) {
      // Moons: refresh the orbit-normal pole reference (planets cached theirs
      // at landing). Cheap — one element propagation; Earth's Moon is a copy.
      if (this.landedOn?.type === 'moon') {
        const landedMoon = this.landedOn;
        const parentBody = this.planetMeshByName.get(landedMoon.parentPlanet)?.data;
        const moonMesh = this.moonMeshByName.get(landedMoon.name);
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
      this.setDisplayFov(THREE.MathUtils.lerp(anim.fromFov, anim.toFov, t));
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
      if (displayFovDeg(this.camera) !== this.surfaceFovDeg) {
        this.setDisplayFov(this.surfaceFovDeg);
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

    // The surface camera is now fully posed for this frame. Refresh its world
    // matrix so the marker projection below — and the guide-reticle/orbit-focus
    // passes that run downstream this frame — read this pose; the renderer won't
    // refresh matrixWorldInverse until render time, so a projection off the raw
    // lookAt/position would lag a frame while tracking or dragging the look.
    this.camera.updateMatrixWorld();

    // Marker over the tracked target (per-frame screen projection): brackets
    // for a resolvable disc, the hairline reticle for sub-pixel specks (the
    // 70px bracket floor around empty sky read as "something visible here"),
    // and an edge chevron pointing back when free look loses the target.
    // Projects through the world matrix refreshed just above — nothing has
    // touched the camera since.
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const targetRadiusAU = this.surfaceTargetRadiusAU(this.surfaceTarget);
    const proj = projectSphereToScreen(
      targetPos,
      targetRadiusAU,
      this.camera,
      w,
      h,
      this.sphereScreenProjection,
    );
    const discPx = proj.diameterPx;
    this.surfaceMarkerKind = resolveMarkerKind(discPx, this.surfaceMarkerKind, h);
    // On-frame test inflated by the disc radius: a big disc (Jupiter fills
    // ~60% of the frame) must not flip to "off frame" the moment its CENTER
    // leaves the viewport while half of it is plainly visible.
    const discR = discPx / 2;
    const onFrame =
      proj.ndcZ < 1 &&
      proj.x >= -discR && proj.x <= w + discR &&
      proj.y >= -discR && proj.y <= h + discR;
    if (onFrame) {
      // Pill mode passes the true disc size — the cluster anchors under the
      // limb (clamped above the bottom bands); the capped box only sizes the
      // bracket drawing itself.
      const sizePx = this.surfaceMarkerKind === 'pill'
        ? discPx
        : THREE.MathUtils.clamp(
            discPx * 1.3,
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

  /** Colour handles with a live arrival warm goal (armArrivalWarmGoal): the
   *  committed destination's ladder, climbing from jump commit instead of
   *  waiting for the glide to cross each on-screen trigger. Rebuilt per
   *  arrival; pruned as goals disarm themselves. */
  private arrivalWarmUps: TextureUpgrade[] = [];

  /** Lazily imported KTX2 loader behind the compressed-tier binding — null
   *  until the first .ktx2 tier fetch of the session. */
  private ktx2Loader: Promise<KTX2Loader> | null = null;

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

  private textureUpgradesForTarget(body: NonNullable<LandedTarget>): TextureUpgrade[] {
    const found = body.type === 'planet'
      ? this.solarSystem?.planets.find((p) => p.data.name === body.name)?.textureUpgrades
      : this.planetMoons.get(body.parentPlanet)?.find((m) => m.data.name === body.name)?.textureUpgrades;
    return found ?? [];
  }

  /** Every colour-tier handle in the system, for teardown. */
  private allTextureUpgrades(): TextureUpgrade[] {
    const ups: TextureUpgrade[] = [];
    for (const p of this.solarSystem?.planets ?? []) ups.push(...p.textureUpgrades);
    for (const moons of this.planetMoons.values()) for (const m of moons) ups.push(...m.textureUpgrades);
    return ups;
  }

  /** The colour-tier handles of a landing body and the companion its
   * Observatory can magnify — a body's globe and cloud shell each contribute
   * one. This pre-landing form lets arriveThen decide that the first tier
   * itself requires a cover, before applyLandedTarget runs. */
  private landingPairUpgrades(target: NonNullable<LandedTarget>): TextureUpgrade[] {
    const companion: NonNullable<LandedTarget> | null = target.type === 'moon'
      ? { type: 'planet', name: target.parentPlanet }
      : target.name === 'Earth'
        ? { type: 'moon', name: 'Moon', parentPlanet: 'Earth' }
        : null;
    const ups: TextureUpgrade[] = [];
    for (const body of [target, companion]) {
      if (!body) continue;
      for (const up of this.textureUpgradesForTarget(body)) if (!ups.includes(up)) ups.push(up);
    }
    return ups;
  }

  /** The current landed body's pair — used while its cover/load screen is live. */
  private landedPairUpgrades(): TextureUpgrade[] {
    return this.landedOn ? this.landingPairUpgrades(this.landedOn) : [];
  }

  /** The landed pair's first-step fetches running right now, by attempt
   *  identity. A cover waits on these and nothing else: a higher step the
   *  on-screen trigger started is not what the reveal is hiding, and a step
   *  that begins after this list is taken cannot extend the hold. */
  private coverWaitList(
    ups: readonly TextureUpgrade[] = this.landedPairUpgrades(),
  ): Array<{ up: TextureUpgrade; generation: number }> {
    return ups.flatMap((up) =>
      up.attempt && up.attempt.tier === firstUpgradeTier(up)
        ? [{ up, generation: up.attempt.generation }]
        : [],
    );
  }

  /**
   * Run an instant teleport (`action`), but if the destination system's moons
   * aren't painted yet — or carry 4096-wide-or-larger photo maps that haven't
   * reached the GPU — cover the screen first, make the system drawable, then
   * reveal. A quick-travel must never flash an unpainted (or, with the
   * visibility gate, a missing) moon, and a first arrival must not play a train
   * of ~100ms upload frames on screen (a 4096-wide upload is unsliceable and
   * one lands per pump frame — four Galileans means four stalled frames in a
   * row).
   * Landings also hold the cover (bounded) for the landed pair's pre-triggered
   * first-tier fetch+decode, so those uploads drain under it instead of just
   * after the reveal. Higher tiers are never cover work — they arrive later
   * through the on-screen trigger. Warm systems act immediately, exactly as
   * before. A second arrival while one is mid-flight is ignored.
   */
  private arriveThen(
    target: NonNullable<LandedTarget>,
    action: () => void,
  ): void {
    if (this.arrivalInFlight) return;
    const landingUpgrades = this.landingPairUpgrades(target);
    let upgradeCover = false;
    // Every arrival — landing OR cruise jump — covers the pair's first
    // steps. Cruise jumps used to skip this, and the warm-up's pre-fetched
    // first tiers then decoded+uploaded on the first visible seconds of the
    // approach (measured: the Moon's 4K albedo and Earth's 4K cloud deck
    // each as a dropped frame right after a Moon teleport — the boot moon
    // map sits under the 4096 upload-cover threshold, so no other veil
    // condition catches that jump). First steps only, bounded by
    // ARRIVAL_UPGRADE_HOLD_MAX_MS, and only while a body still sits on its
    // boot map — repeat jumps stay instant.
    for (const up of landingUpgrades) {
      if (!needsUpgradeCover(up)) continue;
      // A cover is the ideal moment to retry a first step that failed
      // earlier: its fetch, decode and upload get a bounded window with
      // nothing on screen. A higher step that failed keeps its cooldown,
      // because nothing here is covering that one.
      up.retryAtMs = undefined;
      upgradeCover = true;
    }
    this.arriveAtSystem(
      this.parentSystemOf(target),
      // Warm-up runs WITH the action — under the opaque veil on a cold
      // arrival, on the teleport's own cut frame on a warm one — and after
      // it, so a landing's first-tier kick (applyLandedTarget) already owns
      // its handle when the goals arm.
      () => {
        action();
        this.warmArrivalDestination(target);
      },
      upgradeCover,
      landingUpgrades,
      bodyDisplayName(target.name),
    );
  }

  /**
   * Committed-destination warm-up: a jump knows where it is going, so the LOD
   * work its approach is certain to earn — the colour rungs above the boot
   * map, the Moon's close-approach relief, the fine silhouette — starts at
   * commit instead of when the glide crosses each on-screen trigger
   * mid-flight (each of those crossings used to land a fetch+decode plus an
   * unsliceable GPU upload as a visible frame spike during the approach —
   * worst on WebKit, where a 4K/8K upload is the largest single-frame bill
   * the app pays). Fetch+decode overlap the veil and the early glide; the
   * uploads drain under the veiled pump(∞) or the budgeted warm pump.
   *
   * Deliberately veil-neutral: nothing armed here joins coverWaitList (it
   * admits only the landed pair's FIRST-tier attempts), so a cruise jump's
   * veil lifts exactly as before. Target only, not the Observatory pair —
   * the companion keeps riding its own on-screen triggers.
   */
  private warmArrivalDestination(target: NonNullable<LandedTarget>): void {
    const nowMs = performance.now();
    this.arrivalWarmUps = [];
    const targetUps = this.textureUpgradesForTarget(target);
    for (const up of targetUps) {
      if (armArrivalWarmGoal(up)) this.arrivalWarmUps.push(up);
    }
    // The vantage companion gets its FIRST step only, landing-style: on a
    // moon arrival the parent fills a good share of the sky, and its boot
    // map's first sharpen used to land as a mid-approach upload spike
    // (measured: Earth's 4K cloud deck after a Moon teleport). One step, no
    // goal — the companion's higher rungs stay demand-driven.
    for (const up of this.landingPairUpgrades(target)) {
      if (targetUps.includes(up)) continue;
      const first = firstUpgradeTier(up);
      if (first) upgradeTextureOnApproach(up, first, nowMs);
    }
    // First rung starts now — under the veil, or with the teleport cut.
    this.pumpArrivalWarmGoals();
    if (target.type === 'moon') {
      const moon = this.planetMoons
        .get(target.parentPlanet)
        ?.find((m) => m.data.name === target.name);
      if (moon) {
        // Fraction 1 is the forced form of the LOD loop's own call: the
        // approach will cross the relief trigger anyway, and a failure keeps
        // its cooldown and falls back to that trigger.
        upgradeNormalOnApproach(moon.normalUpgrade, 1, nowMs);
        upgradeGeometryOnApproach(moon.geometryUpgrade, Number.POSITIVE_INFINITY);
      }
    } else {
      const planet = this.solarSystem?.planets.find((p) => p.data.name === target.name);
      if (planet) upgradeGeometryOnApproach(planet.geometryUpgrade, Number.POSITIVE_INFINITY);
    }
  }

  /** Climb the armed destination goals — at most one gated fetch start per
   *  handle per frame — pruning goals that have disarmed themselves. */
  private pumpArrivalWarmGoals(): void {
    if (this.arrivalWarmUps.length === 0) return;
    const nowMs = performance.now();
    let keep = 0;
    for (const up of this.arrivalWarmUps) {
      if (pumpArrivalWarmGoal(up, nowMs)) this.arrivalWarmUps[keep++] = up;
    }
    this.arrivalWarmUps.length = keep;
  }

  /**
   * The veil core of the arrival above, keyed on the SYSTEM rather than on a
   * body — so a destination that is not a body at all (a point chosen on the
   * chart) can hold the same no-half-painted-scene guarantee without a
   * fabricated target being pushed through the body path. `systemName` null is
   * a destination with no system around it: nothing to paint, nothing to warm.
   * `keepUpgrades` are the fetches the destination itself wants; every other
   * one in flight is abandoned here.
   */
  private arriveAtSystem(
    systemName: string | null,
    action: () => void,
    upgradeCover: boolean,
    keepUpgrades: readonly TextureUpgrade[] = [],
    noteLabel: string | null = null,
  ): void {
    if (this.arrivalInFlight) return;
    // A teleport abandons every fetch in flight anywhere in the system except
    // the ones for where it is going. Sweeping all the handles, rather than
    // just the ones the last arrival started, is what catches a fetch the
    // on-screen trigger began during a close approach: left behind, it would
    // otherwise still land and pay a full-size upload on the first frames of
    // the destination. Handles this destination wants keep their fetch — it is
    // the same map.
    for (const up of this.allTextureUpgrades()) {
      if (!keepUpgrades.includes(up)) {
        cancelTextureUpgrade(up, 'discard');
        // A departed destination's warm goal goes with its fetches — a goal
        // may only outlive the approach it was armed for on the body the
        // player is still headed to.
        disarmArrivalWarmGoal(up);
      }
    }
    // Every sector tile goes now, destination included: a tile upload for
    // the globe being left must not land under the veil or on the first
    // frames of the new scene (a released tile leaves the warm queue through
    // its dispose hook), and the destination's own sectors stream back in a
    // beat after the reveal — from the cache, for a body seen before.
    this.sectors?.dropAll();
    this.arrivalUpgradeBatch = [];
    const moons = systemName ? this.planetMoons.get(systemName) : undefined;
    const needsPaint = !!moons && moons.some((m) => !m.painted);
    // Photo maps 4096 wide or larger still waiting for their first GPU upload
    // get drained under the veil below. Smaller maps (a moon's boot-tier photo)
    // upload within a frame or two off-gesture via the warm pump — no veil beat
    // for those.
    const needsUploadCover =
      !!moons &&
      !!systemName &&
      !this.warmedSystems.has(systemName) &&
      moons.some((m) => {
        const mat = m.mesh.material as THREE.MeshStandardMaterial;
        const img = mat.map?.image as { width?: number } | undefined;
        return !!mat.userData.photoLoaded && (img?.width ?? 0) >= 4096;
      });
    if (!needsPaint && !needsUploadCover && !upgradeCover) {
      action();
      return;
    }
    this.arrivalInFlight = true;
    const veil = document.getElementById('arrival-veil');
    const coverStart = performance.now();
    veil?.classList.add('covering'); // snaps fully opaque (no fade-in) — see CSS
    // The covering black over mostly-black space reads as a dead screen (and
    // deliberately catches clicks), so a hold that outlives a beat names
    // itself. Instant arrivals — the common warm case — never flash it.
    const note = document.getElementById('arrival-veil-note');
    if (note) {
      note.textContent = `Preparing ${noteLabel ?? 'the view'}…`;
      note.classList.remove('show', 'pulse');
    }
    window.clearTimeout(this.arrivalNoteTimer);
    this.arrivalNoteTimer = window.setTimeout(() => {
      if (veil?.classList.contains('covering')) note?.classList.add('show');
    }, 350);
    // The veil owns the screen from here until its fade-out finishes.
    this.arrivalVeilClearAtMs = Number.POSITIVE_INFINITY;
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
          if (moons && systemName) this.moonPainter.paintSystemNow(systemName, moons);
          action();
          // Upload the system's arrived photo/normal maps while the cover is
          // opaque (a landing already queued them via applyLandedTarget; a
          // cruise jump queues here), so the reveal frame draws a fully
          // resident system instead of stalling once per big map.
          if (systemName) {
            this.queueSystemMoonMapsForWarm(systemName);
            pumpTextureWarmQueue(Number.POSITIVE_INFINITY);
            this.warmedSystems.add(systemName);
          }
          // Take the hold's wait-list once, now that the arrival has started
          // its fetches (applyLandedTarget or the arrival warm-up, inside the
          // action above). Taken over the destination's own handles
          // (keepUpgrades), not the landed pair, so a cruise jump's covered
          // first step is waited on exactly like a landing's; a destination
          // with no body starts no fetch and the list is empty. Only
          // FIRST-tier attempts enter (coverWaitList's own rule) — the warm
          // ladder's higher rungs can never extend the hold.
          this.arrivalUpgradeBatch = this.coverWaitList(keepUpgrades);
        } catch (err) {
          debugError('Arrival failed', err);
        } finally {
          this.arrivalInFlight = false;
          // A landing pre-triggers the landed pair's first colour step
          // (applyLandedTarget), and its fetch+decode may still be in flight
          // when the drain above runs — revealed too early, each finishes as a
          // ~100ms upload frame on the fresh scene. Keep the opaque cover up
          // until they resolve (bounded — a stalled fetch must never pin the
          // veil), drain once more, then reveal.
          const batch = this.arrivalUpgradeBatch;
          const holdDeadline = coverStart + PlanetariumMode.ARRIVAL_UPGRADE_HOLD_MAX_MS;
          const tryLift = () => {
            if (coverGen !== this.arrivalCoverGen) return; // a newer arrival owns the veil now
            const pending = batch.filter((e) => e.up.attempt?.generation === e.generation);
            if (this.active && performance.now() < holdDeadline && pending.length > 0) {
              requestAnimationFrame(tryLift);
              return;
            }
            // A step that missed the covered window is released, not dropped:
            // the body keeps the map it has, and the download that is already
            // on its way applies on a quiet frame after the reveal. Throwing it
            // away here is what used to pin a body to its boot map for the rest
            // of the session.
            for (const e of pending) cancelTextureUpgrade(e.up, 'keep');
            pumpTextureWarmQueue(Number.POSITIVE_INFINITY);
            // Hold the cover until the painted, teleported scene has rendered
            // (the landed/jumped system first appears on the next
            // update→render) and at least the min dwell, so a fast machine
            // reads it as an intentional beat rather than a flicker. Removing
            // the class fades it back out.
            const wait = Math.max(48, PlanetariumMode.ARRIVAL_MIN_DWELL_MS - (performance.now() - coverStart));
            window.setTimeout(() => {
              if (coverGen !== this.arrivalCoverGen) return;
              veil?.classList.remove('covering');
              window.clearTimeout(this.arrivalNoteTimer);
              document.getElementById('arrival-veil-note')?.classList.remove('show', 'pulse');
              this.arrivalVeilClearAtMs = performance.now() + PlanetariumMode.ARRIVAL_VEIL_FADE_MS;
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
    this.notification.show(`Landed on ${bodyDisplayName(target.name)}`);
  }

  /**
   * State-configuration core of landing: everything `enterLandedMode` does
   * except capturing `preLand*` and the arrival toast — so the Observatory's
   * vantage swap can re-land on the companion body without the exit/enter
   * ceremony (no speed restore, no "Departing" toast, take-off state intact).
   */
  private applyLandedTarget(target: NonNullable<LandedTarget>, preserveOrbitPair = false) {
    // Every landing change funnels through here — first landings, the
    // Observatory's companion swap, tutorial staging — and each is a journey
    // change a pending mission continuation must yield to (the takeoff bump
    // lives in exitLandedMode, which doesn't route through this).
    this.journeyCommitGen++;
    // The same seam clears any transient reveal, so a touch reveal can't
    // survive a ground change or companion swap.
    this.clearBodyReveal();
    // Clear + cut: the landed framing below is an authored repose, and the
    // cruise aim must adopt fresh at the next takeoff, not sweep from a
    // pre-landing deflection.
    clearArrivalLook(this.cruiseAim);
    cutAim(this.cruiseAim);
    this.contactAimActive = false;
    this.arrivalLookMoon = null;
    this.arrivalLookParentBody = null;
    // Landing (and the landed→landed vantage swap) can flip the Sun's exposed
    // fraction in one frame; reseed the flash baseline so it doesn't glare.
    this.noteSunViewDiscontinuity();
    // Landing ends the cruise nav: drop the retained nav moon (the dot pass is
    // skipped in surface view anyway, but the orbit-view dot floor shouldn't
    // keep flooring a moon you have just parked at).
    this.dotNavMoon = null;
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
    this.closeToolsMenu();
    // A commit re-enters here; the map must be gone before the new ground
    // takes over (idempotent — no restore of the map's own transient state).
    this.closeMap({ restore: false });
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
    // start their first colour step now: fetch, decode, and upload spend
    // the parked seconds right after touchdown instead of the first
    // magnifying gesture (a 4096-wide upload alone is a ~100ms frame). Only
    // the first step — the tiers above it ride the on-screen trigger, so no
    // goal can hold a landing behind its cover.
    for (const up of this.landedPairUpgrades()) {
      const first = firstUpgradeTier(up);
      if (first) upgradeTextureOnApproach(up, first);
    }
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

    // Landed runs on a fixed near plane per landing — the stock value, shrunk
    // for bodies smaller than it (landedNearAU: surface view keeps culling
    // the ground, tiny moons keep the full ~18.9° frame). Apply it BEFORE the
    // two framing consumers below read camera.near (cruise leaves a dynamic
    // value here, as small as 3 km after a close pass).
    const trueRadiusAU = this.getLandedBodyRadiusAU();
    const nearAU = landedNearAU(trueRadiusAU);
    if (this.camera.near !== nearAU) {
      this.camera.near = nearAU;
      this.camera.updateProjectionMatrix();
    }

    // Configure OrbitControls to orbit the body. The player is parked at the
    // body's world position, so the next floating-origin pass puts the body —
    // planet or moon — exactly at scene origin.
    const renderedRadiusAU = this.getLandedBodyRenderedRadiusAU();

    this.controls.enabled = true;
    this.controls.target.set(0, 0, 0);
    this.controls.minDistance = landedMinDistanceAU(renderedRadiusAU, this.camera.near);
    this.controls.maxDistance = this.landedMaxDistanceAU(trueRadiusAU);
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.5;
    // The cruise pipeline is dead while landed, so this only matters for the
    // takeoff reset that reads it — a landed drag may later set 'orbit'
    // harmlessly.
    this.camOwner = 'chase';
    // Landed framing is world-up: the orbit view, its autoRotate precession
    // and the lit-side opening pose are all authored against celestial north.
    // Must precede the framing lookAt below (it reads camera.up).
    this.setCameraFrameUp(PlanetariumMode.SCENE_NORTH);

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

    // Shadow visuals live in the landed system's moon group. Detach comes
    // first, unconditionally: a ceremony-free re-land (observe-tab pick) onto
    // a planet WITHOUT a group (Mercury/Venus have no moons) would otherwise
    // skip both branches and leave the previous system's spots/guides parented
    // — frozen in whatever pose they last drew — until the next takeoff.
    this.shadowVisuals.detach();
    this.orbitDetailsVisuals.detach();
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
   * Re-land on another body of the same system in place — no departure, no
   * arrival ceremony, no toast. Shared by the vantage swap and the event
   * jumps that stage their namesake observer, so the invariants exist once.
   * Returns whether the surface view was active on entry: the caller owns the
   * re-entry (swap and jump point the new sky at different targets), and it
   * must pass `immediate` so the fitted FOV snaps — the subject changed.
   *
   * The pair-moon memory is kept on purpose: after a moon → parent re-land the
   * orbit-details subject stays the moon you left (the better vantage on the
   * whole ellipse), and a generic parent has no one-tap swap back.
   */
  private relandInSystem(target: NonNullable<LandedTarget>): boolean {
    const previous = this.landedOn;
    const wasSurface = this.landedView === 'surface';
    if (previous?.type === 'moon' && target.type === 'planet') {
      this.orbitPairMoon = { moonName: previous.name, parentName: previous.parentPlanet };
    }
    this.applyLandedTarget(target, true);
    // applyLandedTarget parked the player on the new body, but the scene graph
    // still reflects the old vantage until the next frame — and the surface
    // re-entry reads it synchronously to fit the FOV. Refresh it now.
    this.refreshLandedScene();
    if (wasSurface) {
      // applyLandedTarget re-enabled OrbitControls and reset the camera for
      // orbit view — re-assert the surface invariants, or the ground gets dual
      // camera control (OrbitControls live under SurfaceLook). Its fresh orbit
      // camera position becomes the exit restore point for the *new* body (the
      // old one was scaled to the previous body's radius).
      this.preSurfaceCameraPos.copy(this.camera.position);
      this.preSurfaceAutoRotate = this.controls.autoRotate;
      this.controls.enabled = false;
    }
    return wasSurface;
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
    const wasSurface = this.relandInSystem(companion);
    if (wasSurface) {
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
        // Snap the FOV — the subject changed, an ease would flash/lag.
        { immediate: true },
      );
    }
    this.notification.show(`Standing on ${bodyDisplayName(companion.name)}`);
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
    // Reference-keyed memo: the subject is a pure function of the landed
    // target and the pair memory, both replaced (never mutated) on change —
    // the focus-glyph pass asks every landed frame, and the uncached resolve
    // allocates a fresh subject (and swapCompanionTarget a fresh target).
    const memo = this.orbitSubjectMemo;
    if (memo && memo.landedOn === this.landedOn && memo.pairMoon === this.orbitPairMoon) {
      return memo.subject;
    }
    const subject = this.resolveOrbitSubjectUncached();
    this.orbitSubjectMemo = { landedOn: this.landedOn, pairMoon: this.orbitPairMoon, subject };
    return subject;
  }

  private resolveOrbitSubjectUncached(): { moonName: string; parentName: string } | null {
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
    // the new subject's readout and zoom limit. The open map force-hides the
    // overlay the same way, so it earns the same skip.
    if (this.landedView !== 'surface' && !this.isMapOpen()) {
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
    // Takeoff is a journey change: a mission continuation awaiting its ship
    // profile must yield to it. (Mission startup's own exitLandedMode call
    // runs after its generation check has already passed — no self-abort.)
    this.journeyCommitGen++;
    this.clearBodyReveal();
    // The governor is frozen while landed, so a cap tightened on the approach
    // must not ramp-limit the departure — and no partial clear-hold may
    // survive into it. Reset here — the single takeoff chokepoint (also the
    // excursion Leave and deactivate paths) — mirroring the teleport reset.
    this.bodyCap = initialBodyCapState();
    // Takeoff re-exposes the sky the ground was blocking; reseed the flash
    // baseline so the departure frame doesn't glare.
    this.noteSunViewDiscontinuity();
    // Back to cruise: no landed system means no moons owed a warm upload.
    setWarmEligibleMoonParents(new Set());
    // Leave sits in the cluster above the deck's backdrop, so takeoff can
    // fire while the deck is open — a deck describing the ground being left
    // (HERE pill, reveal target) closes with it.
    this.closeDeck();
    this.closeSurfaceTargetMenu();
    this.closeToolsMenu();
    // Takeoff supersedes the map (a commit re-enters here); no restore.
    this.closeMap({ restore: false });
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
        const camDist = CRUISE_CAM_DIST_AU; // must match resetCruiseCamera
        let safeDist: number;
        if (this.landedOn.type === 'planet') {
          // Camera must clear collision radius
          const collisionR = this.getPlanetCollisionRadius(this.landedOn.name, radiusAU, this.planetScale);
          safeDist = camDist + collisionR * 1.5;
        } else {
          // Same shape as the planet branch: the camera (camDist toward the
          // body) must clear the moon's collision shell on the depart view.
          // Rendered radius, not catalog — the shell wraps the inflated mesh.
          const renderedR = this.getLandedBodyRenderedRadiusAU();
          safeDist = camDist + moonCollisionRadius(renderedR, SHIP_CLEARANCE_AU) * 1.5;
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
    this.controls.minDistance = CRUISE_CONTROLS_MIN_DISTANCE_AU;
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
    this.notification.show(`Departing ${bodyDisplayName(bodyName)}`);
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
      // Landed orbiting keeps the full polar range (looking straight down a
      // pole at the globe is a legitimate framing); a clamp ratcheted during
      // a cruise grab must not leak across the landing.
      this.clearOrbitPolarClamps();
      this.controls.update();
      // Label/marker projections later this frame read camera.matrixWorldInverse,
      // which the renderer refreshes only at render time. Refresh it here, past
      // the orbit camera's final pose, so they track this frame — not last.
      this.camera.updateMatrixWorld();
    }

    const shouldRefreshUi = this.tickFrameCadence(dt);

    this.updatePlanetScaling();
    this.updateMoonPositions(dt);
    // Same same-frame-geometry rule as the cruise path — and the landed
    // Observatory telescope (narrow FOV) is exactly where a soft map and a
    // chorded limb show, so the triggers keep running while landed. Skipped
    // while the chart owns the frame: the ground isn't drawn there, so nothing
    // should fetch for it.
    // World-presentation passes are gated while the map owns the frame.
    const mapOpen = this.isMapOpen();

    if (!mapOpen) {
      this.updateBodyLOD();
      this.updateSectorStreaming();
    } else {
      // Same as the cruise branch: the streamer's budget and load deadlines
      // keep moving while the chart owns the frame and nothing is measured.
      this.maintainSectorStreaming();
    }
    // Shadow spots/guides live in the world scene, which the map never draws —
    // same gate as the cruise branch, and they rebuild on the first frame back.
    if (!mapOpen) this.updateShadowVisuals();
    if (shouldRefreshUi) this.updateOrbitDetails();
    this.pumpObservatoryEventSearch();

    // Moon dots for the orbit camera (settled at the top of updateLanded, before
    // this frame's positions refreshed — but nothing re-poses it after), so the
    // label pass below reads fresh dot contributions. Surface view fills its own
    // dots after the surface camera re-pins (labels are hidden there anyway).
    // Skipped under the open map like the cruise branch: nothing draws or reads
    // the fill until the first world frame after close, which refills it.
    if (this.landedView !== 'surface' && !mapOpen) this.updateMoonDotsForCamera();

    // Occlusion + label/marker + hover-reveal pipeline while landed; surface
    // view runs its own hidden-label handling, so skip it there.
    if (this.landedView !== 'surface' && !mapOpen) {
      const landedPlanetName = this.landedOn?.type === 'planet' ? this.landedOn.name : undefined;
      this.runBodyLabelPipeline(landedPlanetName);
    }

    // Update constellation labels while landed
    if (this.constellations && this.showConstellations && !mapOpen) {
      this.constellations.updateLabels(
        this.camera,
        this.renderer.domElement.clientWidth,
        this.renderer.domElement.clientHeight,
      );
    }
    this.updateOrbitLineVisibility();

    // Surface camera last — after updateMoonPositions/updateShadowVisuals —
    // so the vantage and look target use this frame's positions (the skipped
    // controls block above runs before those refreshes).
    if (this.landedView === 'surface') {
      this.updateSurfaceCamera(dt);
      // Dots after the surface camera re-pins: from a moon's surface the sibling
      // moons are real angular points (anchorRatio 0 → true sizes), so the
      // photometry is honest naked-eye sky.
      this.updateMoonDotsForCamera();
    }
    // After the surface re-pin: the Sun metering (screen position, occlusion,
    // corona gate) must read this frame's camera pose, not last frame's.
    // Camera.updateMatrixWorld also refreshes matrixWorldInverse, which the
    // NDC projection reads directly.
    this.camera.updateMatrixWorld();
    this.updateSunShader(dt);
    if (!mapOpen) {
      // Landed reticle + orbit-detail foci are world-anchored HTML; the map
      // force-hides them and the passes that place them can rest.
      this.updateShadowGuideCamera();
      this.updateOrbitFocusLabels();
    }

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
    // While the volume-compare tool holds the scene, every persistence caller gets
    // the pre-tool snapshot (timestamp refreshed) — the same override the tutorial
    // uses — so deactivate's save + any autosave keep writing the journey the user
    // left, and a reload inside the tool resumes the pre-tool landing rather than
    // the torn-down takeoff. Cleared in activate() on return.
    if (this.preToolState) {
      return { ...this.preToolState, timestamp: Date.now() };
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
      labelDistancesMode: this.labelDistancesMode,
      showBodyMarkers: this.showBodyMarkers,
      showOrbitLines: this.showOrbitLines,
      // Absent until the toggle is flipped, like skyPref below — the widget
      // state itself is NOT the preference (dev/capture paths move it).
      miniChartPref: this.miniChartPrefStored ?? undefined,
      landedOn: this.landedOn,
      systemSpeed: this.player.systemSpeedMultiplier,
      systemSlowdown: this.systemSlowdown,
      autopilotTarget: this.autopilotTarget,
      autopilotUserEngaged: this.autopilotUserEngaged,
      // Absent until the user flips the toggle — JSON.stringify drops the
      // undefined, so an untouched preference never bakes a device default
      // into the save.
      skyPref: this.skyPrefStored ?? undefined,
      // Stamped at the source, not in saveState: every session-internal
      // snapshot (pre-mission, pre-tool, the tutorial's) round-trips through
      // here and back into restoreState, and an unlabeled one would be read
      // as legacy and re-rotate the ship on every tutorial exit or tool return.
      headingBasis: 'ecliptic',
    };
  }

  private restoreState(saved: PlanetariumState) {
    // Clear + cut: a restore reposes the whole journey absolutely.
    clearArrivalLook(this.cruiseAim);
    cutAim(this.cruiseAim);
    this.arrivalLookMoon = null;
    this.arrivalLookParentBody = null;
    this.player.posX = saved.positionAU.x;
    this.player.posY = saved.positionAU.y;
    this.player.posZ = saved.positionAU.z;
    // Saves written before the flight frame moved onto the ecliptic hold
    // scene-equatorial angles; convert at APPLY so the ship still aims at the
    // same world direction (unconverted, a saved close approach would miss
    // its target by ~4.7 arrival-disc diameters). The stored copy stays
    // unflagged with its legacy angles, so the conversion fires exactly once
    // per load however many times the save is written back.
    if (saved.headingBasis === 'ecliptic') {
      this.player.heading = saved.headingRad;
      this.player.pitch = saved.pitchRad ?? 0;
    } else {
      const converted = eclipticHeadingPitchFromEquatorial(saved.headingRad, saved.pitchRad ?? 0);
      this.player.heading = converted.headingRad;
      this.player.pitch = converted.pitchRad;
    }
    this.player.speedMultiplier = saved.speed;
    this.player.moving = saved.landedOn ? false : (saved.moving ?? saved.speed > 0);
    // A restore is a position discontinuity; drop the whole governor state
    // (ramped cap, latch, clear-hold) so a flight resumed on the same mode
    // instance (deactivate→reactivate) isn't throttled — or auto-cleared —
    // by values left over from wherever the ship last was.
    this.bodyCap = initialBodyCapState();
    // The ship can reappear anywhere relative to the Sun; reseed the flash
    // baseline so the resumed view doesn't glare on its first frame.
    this.noteSunViewDiscontinuity();
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
    this.labelDistancesMode = saved.labelDistancesMode ?? 'hover';
    this.showBodyMarkers = saved.showBodyMarkers ?? true;
    this.applyBodyLabelVisibility();
    const labelsLabel = document.getElementById('settings-labels-label');
    if (labelsLabel) labelsLabel.textContent = this.showBodyLabels ? 'On' : 'Off';
    const labelDistancesLabel = document.getElementById('settings-label-distances-label');
    if (labelDistancesLabel) labelDistancesLabel.textContent = this.labelDistancesMode === 'always' ? 'Always' : 'On hover';
    document.getElementById('settings-label-distances-toggle')
      ?.setAttribute('aria-pressed', String(this.labelDistancesMode === 'always'));
    const markersLabel = document.getElementById('settings-markers-label');
    if (markersLabel) markersLabel.textContent = this.showBodyMarkers ? 'On' : 'Off';
    this.showOrbitLines = saved.showOrbitLines ?? false;
    const orbitsLabel = document.getElementById('settings-orbits-label');
    if (orbitsLabel) orbitsLabel.textContent = this.showOrbitLines ? 'On' : 'Off';
    document.getElementById('settings-orbits-toggle')
      ?.setAttribute('aria-pressed', String(this.showOrbitLines));
    // Off unless the user has deliberately turned it on. An absent key is a
    // save with no opinion — including every save from the on-by-default era,
    // whose always-written `showMiniChart` the store deliberately ignores: it
    // baked `true` without a user behind it, for exactly the users the
    // default change is for.
    this.miniChartPrefStored = saved.miniChartPref ?? null;
    this.setMiniChartEnabled(saved.miniChartPref ?? false);

    // Restore autopilot target (kept even when landed — resumes on exit).
    // Pre-provenance saves migrate by heuristic in the store sanitizer (only
    // user picks ever produce a non-Mercury target).
    this.autopilotTarget = saved.autopilotTarget ?? null;
    this.autopilotUserEngaged = saved.autopilotUserEngaged ?? false;
    // The flag and the target restore from separate fields, and the store
    // sanitizer can drop a malformed/renamed target while keeping the flag —
    // an engaged Pilot chip steering nothing. Targetless, disengage.
    if (this.autopilot && !this.autopilotTarget) this.autopilot = false;
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
      // The Sun is the world frame's origin (the floating origin subtracts the
      // player elsewhere), so it never appears in planetWorldPositions. One
      // shared literal keeps this per-frame autopilot path allocation-free.
      if (target.name === 'Sun') return SUN_WORLD_POSITION;
      return this.planetWorldPositions.get(target.name) ?? null;
    }
    // For moons, use the precise cached position only while it is FRESH —
    // written for a currently-shown moon this pass or the one before (the
    // autopilot runs before the frame's refill). Entries persist unpruned
    // after a system drops out of range, so an unguarded read would steer
    // the far-field autopilot toward where the moon was when last seen —
    // arbitrarily far from the live moon after a clock warp — and ring the
    // moon-branch arrival test in empty space. Stale or absent, fall back to
    // the parent planet like the never-visited case always has.
    const wp = this.moonWorldPositions.get(target.name);
    if (wp && this.moonVelPassIndex - wp.pass <= 1) return wp;
    return this.planetWorldPositions.get(target.parentPlanet) ?? null;
  }

  /**
   * Refill `tmpAutopilotInputs` from the engaged autopilot moon's LIVE mesh
   * position and rendered scale, returning it — or null when the moon is not
   * independently resolvable this frame. "Resolvable" means its own world
   * position is in `moonWorldPositions` (written only for a shown moon, and
   * where `getTargetWorldPosition` would otherwise fall back to the parent) and
   * its painted, visible mesh is present. The postcard standoff is meaningless
   * against the parent fallback, so those frames keep the legacy behavior.
   * Zero allocation: the temp and its vectors are reused.
   */
  private resolveAutopilotMoonInputs(
    target: NonNullable<LandedTarget>,
  ): MoonArrivalInputs | null {
    if (target.type !== 'moon') return null;
    const wp = this.moonWorldPositions.get(target.name);
    if (!wp) return null;
    const parentPos = this.planetWorldPositions.get(target.parentPlanet);
    if (!parentPos) return null;
    const parentBody = PLANETARIUM_BODIES.find((b) => b.name === target.parentPlanet);
    if (!parentBody) return null;
    const mesh = this.planetMoons.get(target.parentPlanet)?.find((m) => m.data.name === target.name);
    if (!mesh || !mesh.painted || !mesh.mesh.visible) return null;

    const inp = this.tmpAutopilotInputs;
    inp.moonPos.set(wp.x, wp.y, wp.z);
    inp.parentPos.set(parentPos.x, parentPos.y, parentPos.z);
    inp.orbitR = inp.moonPos.distanceTo(inp.parentPos);
    // Live rendered radius (true size, or the render curve's size below the
    // anchor) — the sphere the arriving player actually sees, same as the
    // governor uses in forEachGovernedMoon.
    inp.renderedR = mesh.data.radiusAU * mesh.mesh.scale.x;
    inp.parentCollision = this.getPlanetCollisionRadius(
      parentBody.name,
      parentBody.radiusAU,
      this.planetScale,
    );
    const ring = RING_CONFIGS[parentBody.name];
    inp.parentClearance = Math.max(
      inp.parentCollision * 1.25,
      ring ? parentBody.radiusAU * ring.outerFactor * 1.05 : 0,
    );
    // camDist / shipClearance are rig constants — set once at construction.
    return inp;
  }

  private applyAutopilot() {
    if (!this.autopilotTarget) return;
    const pos = this.getTargetWorldPosition(this.autopilotTarget);
    if (!pos) return;
    // Near a resolvable moon, ease the heading from its center toward the flyby
    // aim so the ship parks pre-aimed past the limb — the pose a Travel jump
    // arrives in. The pose is served from the cache (see `autopilotAim`);
    // outside the blend zone (or on the parent fallback) fly straight at the
    // target.
    const inp = this.resolveAutopilotMoonInputs(this.autopilotTarget);
    if (inp) {
      const standoff = moonArrivalStandoffAU(inp);
      const dx = inp.moonPos.x - this.player.posX;
      const dy = inp.moonPos.y - this.player.posY;
      const dz = inp.moonPos.z - this.player.posZ;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < 3 * standoff) {
        const blend = autopilotAimBlend(dist, standoff);
        const staleSq = (0.02 * standoff) ** 2;
        if (
          this.autopilotAimFor !== this.autopilotTarget.name ||
          this.autopilotAimMoonPos.distanceToSquared(inp.moonPos) > staleSq
        ) {
          this.autopilotAim.copy(moonArrivalPose(inp).aimPoint);
          this.autopilotAimMoonPos.copy(inp.moonPos);
          this.autopilotAimFor = this.autopilotTarget.name;
        }
        const aim = this.autopilotAim;
        this.player.headToward(
          inp.moonPos.x + (aim.x - inp.moonPos.x) * blend,
          inp.moonPos.z + (aim.z - inp.moonPos.z) * blend,
          inp.moonPos.y + (aim.y - inp.moonPos.y) * blend,
        );
        return;
      }
    }
    this.player.headToward(pos.x, pos.z, pos.y);
  }

  private engageAutopilot(target: NonNullable<LandedTarget>) {
    // Autopilot steering is invisible to hasManualInput (the steering-reclaim
    // seam), and manual steering would disengage it — so without this the
    // camera would sit off-axis through the whole autopilot cruise. Reacquire
    // the chase on engage.
    if (this.camOwner !== 'chase') {
      flushOrbitDamping(this.controls);
      this.camOwner = 'reacquiring';
    }
    // Retain the nav moon so its dot floor + label survive a manual-steering
    // disengage on final approach; a planet engage clears it (nav moved off a
    // moon). Kept through disengageAutopilot — that's the point.
    this.dotNavMoon =
      target.type === 'moon'
        ? { name: target.name, parentPlanet: target.parentPlanet }
        : null;
    this.autopilotTarget = target;
    this.autopilot = true;
    this.autopilotUserEngaged = true;
    this.player.moving = true;
    if (this.player.speedMultiplier < PlayerShip.SPEED_DEFAULT) {
      this.player.speedMultiplier = PlayerShip.SPEED_DEFAULT;
    }
    this.updateSpeedSlider();
    this.updateAutopilotButton();
    this.notification.show(`Autopilot: heading to ${bodyDisplayName(target.name)}`);
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

    let arrived: boolean;
    if (this.autopilotTarget.type === 'planet') {
      if (this.autopilotTarget.name === 'Sun') {
        // The Sun governor glides asymptotically toward its 1.2-photosphere
        // shell, so a tight threshold would never be crossed. 1.5x the
        // teleport standoff lets the pilot ring the bell while the final
        // glide is still visibly under way.
        arrived = dist < SUN_DATA.radiusAU * SUN_ARRIVAL_RADII * 1.5;
      } else {
        const body = PLANETARIUM_BODIES.find(b => b.name === this.autopilotTarget!.name);
        arrived = dist < (body ? body.systemRadiusAU * 0.3 : 0.003);
      }
    } else {
      // Resolvable moon: the glide has eased the ship to rest at the postcard
      // standoff (`pos` is the moon's own world position here, so `dist` is to
      // its center). Otherwise fall back to the legacy surface-proximity
      // threshold — the parent-fallback position has no meaningful standoff.
      const inp = this.resolveAutopilotMoonInputs(this.autopilotTarget);
      if (inp) {
        arrived = autopilotArrived(dist, moonArrivalStandoffAU(inp));
      } else {
        const moons = this.planetMoons.get(this.autopilotTarget.parentPlanet);
        const moonMesh = moons?.find(m => m.data.name === this.autopilotTarget!.name);
        arrived = dist < (moonMesh ? Math.max(moonMesh.data.radiusAU * 10, 0.0003) : 0.0003);
      }
    }

    if (arrived) {
      const name = this.autopilotTarget.name;
      this.disengageAutopilot();
      if (name !== 'Sun') {
        // Park at the standoff so the ship rests on the postcard instead of
        // drifting on into the surface; throttle-up (reviveParkedShip) resumes.
        // The Sun is the exception: its arrival bell rings mid-glide and the
        // governor's asymptotic ease toward the photosphere shell IS the
        // arrival — there is no surface to drift into, so let it run.
        this.player.moving = false;
      }
      this.notification.show(`Arrived at ${bodyDisplayName(name)}`);
    }
  }

  /**
   * Re-sample the orbit lines when the sim clock has drifted from the epoch
   * they were sampled at. The realistic lines are the bodies' rendered
   * trajectories over one period centered on that epoch, so each planet sits
   * on its own line by construction — but only near the epoch (the drift and
   * the chosen tolerance are in ORBIT_LINE_RESAMPLE_MAX_AGE_MS; the mechanics
   * are in resampleOrbitLines, pinned in SolarSystem.test.ts).
   */
  private rebuildOrbitLinesIfStale() {
    if (!this.solarSystem || this.layoutMode !== 'realistic') return;
    if (
      Math.abs(this.timeState.currentUtcMs - this.solarSystem.orbitLinesEpochUtcMs) <
      ORBIT_LINE_RESAMPLE_MAX_AGE_MS
    ) {
      return;
    }
    resampleOrbitLines(this.solarSystem, this.layoutMode, this.timeState.currentUtcMs);
  }

  rebuildPlanetPositions(dtS = 0) {
    if (!this.solarSystem) return;
    this.rebuildOrbitLinesIfStale();
    for (let i = 0; i < this.solarSystem.planets.length; i++) {
      const planet = this.solarSystem.planets[i];
      const body = PLANETARIUM_BODIES[i];
      const state = computeBodyState(body, this.timeState.currentUtcMs);

      // Per-frame world velocity (AU per frame-second, the same capped dt
      // the ship integrates on) for the governor's moving-body credit,
      // differenced against the position this pass replaces. A dt-less
      // rebuild is a discontinuity (clock set, restore) and reads as zero —
      // a jump is a teleport, not motion.
      const prevPos = planet.worldPosAU;
      let vel = planet.worldVelAUPerS;
      if (!vel) {
        vel = { x: 0, y: 0, z: 0 };
        planet.worldVelAUPerS = vel;
      }
      if (dtS > 0 && prevPos) {
        vel.x = (state.positionAU.x - prevPos.x) / dtS;
        vel.y = (state.positionAU.y - prevPos.y) / dtS;
        vel.z = (state.positionAU.z - prevPos.z) / dtS;
      } else {
        vel.x = 0;
        vel.y = 0;
        vel.z = 0;
      }

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
        // The night-lights shader turns sunDirection into view space with the
        // viewMatrix alone, then compares it against a world-space surface
        // normal (normalMatrix * normal) — so it needs the WORLD sun direction,
        // not the object-space localSunDir the ring/surface uniforms take.
        // Feeding it localSunDir double-rotates the mask, drifting city lights
        // onto the daylit hemisphere as Earth spins.
        planet.nightMaterial.uniforms.sunDirection.value.copy(state.sunDirection);
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

      planet.worldPosAU = {
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
    const wasPaused = this.timeState.paused;
    this.timeState = stepSimulationRate(this.timeState, direction, TIME_RATE_PRESETS);
    // Stepping down through 1× parks at the pause detent silently — arm the
    // long fresh-pause window so a Pause click chasing the stepper re-asserts
    // the freeze instead of resuming a clock the user never saw stop.
    if (this.timeState.paused && !wasPaused) this.pauseGuardUntilMs = performance.now() + 1500;
    this.updateTimeUI({ flash: true });
  }

  private updateTimeUI(opts?: { flash?: boolean }) {
    this.timePanel.render(this.timeState, opts);
    // The Surface Pause button dispatches the action its rendered label
    // promised, rather than blindly toggling current state. Synchronize that
    // promise on every clock write (event jumps and menu/help restores can
    // otherwise leave it stale until the next 8 Hz HUD pass).
    this.observatoryHud.syncPaused(this.timeState.paused);
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
    // The constructor's window-level listeners (activate/deactivate own only
    // the key handlers): without these removals a disposed mode — and its
    // whole scene graph, through the closures — stays reachable, and its
    // blur handler keeps firing.
    window.removeEventListener('pointerup', this.onWindowMapDisarm);
    window.removeEventListener('pointercancel', this.onWindowMapDisarm);
    window.removeEventListener('blur', this.onWindowBlur);
    window.removeEventListener('pointerdown', this.onWindowPointerDown, true);
    window.removeEventListener('pointermove', this.onWindowPointerMove, true);
    window.removeEventListener('pointerup', this.onWindowPointerUp, true);
    window.removeEventListener('pointercancel', this.onWindowPointerCancel, true);
    // The canvas outlives the mode (one renderer, many modes) — its listeners
    // root the mode the same way the window's do. So do the UI classes'
    // window/document listeners, and OrbitControls' own canvas set.
    for (const teardown of this.canvasTeardowns) teardown();
    this.canvasTeardowns.length = 0;
    this.controls.dispose();
    this.timePanel.dispose();
    this.observatoryPanel.dispose();
    this.observatoryHud.dispose();
    // Abandon every colour-tier fetch still in flight: a callback that landed
    // after this point would apply to a material nothing draws and queue an
    // upload into a warmer with no renderer behind it. Warm goals go with
    // them — nothing may start a fetch after this point.
    for (const up of this.allTextureUpgrades()) {
      cancelTextureUpgrade(up, 'discard');
      disarmArrivalWarmGoal(up);
    }
    this.arrivalWarmUps = [];
    // Unbind before the loader teardown so no late tier fetch can race a
    // disposing transcoder; a loader never instantiated disposes nothing.
    bindKtx2TierLoader(null);
    this.ktx2Loader?.then((loader) => loader.dispose()).catch(() => {});
    this.ktx2Loader = null;
    // The relief tiers ride the same network and need the same abandonment.
    for (const moons of this.planetMoons.values()) {
      for (const m of moons) cancelNormalUpgrade(m.normalUpgrade);
    }
    this.sectors?.dispose();
    this.sectors = null;
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
    // The map (built lazily by the corner chart on most sessions) holds its
    // own window/canvas listeners, OrbitControls, GPU resources and label DOM.
    this.systemMap?.dispose();
    this.systemMap = null;
  }
}
