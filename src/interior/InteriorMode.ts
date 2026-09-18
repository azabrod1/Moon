/**
 * Mode controller for the Look-inside tool. Owns the camera, its
 * OrbitControls, the DOM (the strip along the top, the panel with its pages,
 * the view options and the picker), the presentation clock and the cut
 * animation; InteriorScene owns the studio content. The mode maps the pure
 * modules — cutFrame for where the cut is, interiorGeometry for the Readable
 * remap, interiorLayout for the framing, drawnModel for the model's regions —
 * onto the scene's per-frame uniforms.
 *
 * What is drawn comes from the registry (data/interiorRegistry): a
 * constrained body draws its model, a competing body its default (the
 * others switchable from the model switch under the caption), a poorly
 * constrained or not yet modelled body draws an unresolved whole with its
 * bulk line — an illustrative scenario only on request, and labelled.
 *
 * On a phone the panel is a sheet the reader drags: the grip's pointer
 * gestures set its height freely between a peek and its own content (a flick
 * throws it to either end, a press that stays put toggles, and so does the
 * Layers row), and the body's framing follows — fitted to the band above the
 * sheet and centred in it, gliding with the snap and sticking to the finger.
 * A page opens the sheet to its own content: a summary is a compact card, the
 * details and the evidence a reading height. The layers are drawn at their
 * true thickness by default, the body's own proportions; the note under the
 * display buttons names the layers too thin to see at the current size, with
 * the one-tap way to enlarge them.
 *
 * Session-only: every activate() opens on the body it is handed and
 * touches no storage keys. Body changes run under a generation guard, the
 * compare studio's idiom: every async map resolve checks staleness and, if
 * a newer pick landed, disposes what it loaded and bails. Every commit owns
 * its own reveal, so a pick that lands during the first load supersedes
 * the entry's and still opens the cut. A body that cannot be brought in (a
 * throw in its preparation or its presentation) leaves the previous body
 * on, reopens the cut onto it and warns through debugWarn; on a first
 * entry the throw reaches the mode switch, which falls back.
 *
 * The presentation clock is the tool's own: the cut animation and the
 * pattern drift run on it, never on the solar-system clock, and the dev
 * bridge can set and freeze it so a capture is reproducible.
 *
 * Every open is timed. One stopwatch per open (the activate's, or a swap's
 * own from the pick) marks the steps the reader waits through — prepare,
 * present, precompile, the reveal, the first frame after it and ready — and
 * carries the renderer's program count at the reveal and once ready. The set
 * reaches the bridge as `interiorState().timings` and debugLog once, so the
 * question "what is it doing for those seconds" is answerable on a phone.
 *
 * Hover and pin: a pointer ray is picked on the CPU against the terraced cut
 * (interiorPick, the same frame and remap the shaders use); the region under
 * it is emphasised through two uniforms and its legend row lights; a hover
 * card previews it on a fine pointer; a tap or click SELECTS it, which opens
 * its summary page in the panel (ui/InteriorPages: the summary, its details,
 * its evidence grouped by property, and the model page — one host, one page
 * at a time, the layer list the page they all return to). Hovering a legend
 * row emphasises the region in 3D. On touch a tap selects and a drag orbits;
 * interiorInteraction tells the two apart, and a pinch is neither. The Esc
 * cascade: the view options, the picker, a page back to its summary, the
 * selection, then the tool itself.
 *
 * Two diagrams: Materials, the material key, and Temperature, the body's own
 * scale with a hatch for what nobody knows, in the reader's unit (kelvin
 * unless they ask for celsius, session-only); the legend's swatches follow
 * the mode so the key and the face never disagree. A body with competing
 * models, or a poorly constrained one with an illustrative scenario, gets a
 * model switch under its layers. The controls a reader touches rarely — the
 * cut angle, the thin-layer enlargement, the rings, the unit — live behind
 * View options in the strip along the top, beside the way back and the one
 * body selector.
 *
 * The framing is stage-aware (interiorLayout): the body is fitted to the
 * rectangle the panel and the strip leave free and centred in it, and the
 * fit follows the sheet's height on a phone, keeping the zoom the reader had
 * relative to it.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DEG2RAD } from '../shared/math/angles';
import { isPhoneViewport } from '../shared/dom';
import { debugLog, debugWarn } from '../shared/debug';
import { bodyDisplayName } from '../planetarium/surfaceView';
import { InteriorScene, BODY_RADIUS, TERRACE_STEP, type PreparedSkin } from './InteriorScene';
import { TAP_MAX_MS, TAP_MAX_PX, TapRecognizer, type PointerSample } from './interiorInteraction';
import { resolveInteriorBody, type InteriorBody } from './interiorBody';
import {
  CUT_VIEWS,
  CUT_VIEW_ANGLE_DEG,
  computeCutFrame,
  createCutFrame,
  cutViewForAngle,
  openingAngleDegToRad,
  wedgeYawForOpening,
  yawCutFrame,
  type CutFaceSide,
  type CutView,
} from './cutFrame';
import {
  EMPHASIS_S,
  advanceCutTween,
  advanceEmphasis,
  createCutTween,
  createEmphasisState,
  cutTweenSettled,
  emphasisTarget,
  regionArtInsideOut,
  regionLooks,
  setCutTarget,
  stepToward,
  subtitleFor,
  thinLayersNoteText,
  unresolvedComposition,
} from './interiorLogic';
import { NOT_KNOWN, formatKm, temperatureQuantityText, temperatureRangeText, temperatureValueText, type TemperatureUnit } from './ui/inspectorText';
import {
  IDENTITY_REMAP,
  READABLE_MIN_PX,
  minDisplayFraction,
  projectedRadiusPx,
  readableRemap,
  toDisplayFraction,
  toPhysicalFraction,
  tooThinToSeeIndices,
  type ReadableRemap,
} from './interiorGeometry';
import { fitDistance, stageViewOffset, visibleStageRect, zoomRatio, type StageRect } from './interiorLayout';
import { createPickHit, pickInterior, type PickHit, type PickLayout, type PickSurface } from './interiorPick';
import { renderHoverCard, renderPage, type InteriorPanelPage } from './ui/InteriorPages';
import { DepthRuler } from './ui/DepthRuler';
import { createRulerLayout, rulerLayout, rulerSide, type RulerInput } from './ruler';
import { regionEvidenceSummary } from './evidenceSummary';
import { CHOOSE_BODY, ILLUSTRATIVE_NOTE, INTERIOR_MODEL, LAYERS, STRUCTURE_UNCERTAIN } from './ui/interiorCopy';
import { INTERIOR_DEFAULT_BODY, coverageBadge, coverageFor, defaultModelFor, modelFor } from './data/interiorRegistry';
import { coverageModels } from './data/interiorTypes';
import {
  bodyTemperatureRange,
  temperatureScaleGradientCss,
  temperatureScaleHex,
  temperatureT,
  type TemperatureRange,
} from './temperatureScale';
import { coverageBulk, type ClaimKind, type Coverage, type CoverageState } from './data/interiorTypes';
import { drawnFromModel, drawnUnresolved, outerFractionsInsideOut, type DrawnModel } from './drawnModel';
import { BodyPicker } from '../planetarium/ui/BodyPicker';
import { coverageTags } from './ui/coverageTag';
import { PHASE_LABEL, incandescence, swatchHex } from './data/artParams';

const FRAMING = {
  fovDeg: 40,
  /** Start orbit: a gentle elevation and an azimuth a little off the key. */
  elevationDeg: 16,
  azimuthDeg: -28,
  minDistance: 1.55,
  maxDistance: 9,
  dampingFactor: 0.06,
  /** How much of the stage's shorter side the disc's diameter takes. */
  fill: 0.9,
  /** The stage keeps at least this much of the viewport's shorter side, so a
   *  reading-height sheet never shrinks the body to a coin behind it. */
  stageMinFraction: 0.5,
  /** Air between the stage and what bounds it. */
  stageMarginPx: 12,
} as const;

/** Phones: the sheet's resting height reaches the last row of view buttons —
 *  the body's name, the way to another world and both rows of buttons within
 *  reach — with this much air under it. The fraction stands in before the panel
 *  has been laid out and is the floor; the second caps what content may claim. */
const SHEET_PEEK_FRACTION = 0.16;
/** The sheet's own air under it (index.html: bottom: 12px), part of what it takes from the stage. */
const SHEET_BOTTOM_MARGIN_PX = 12;
const SHEET_PEEK_TAIL_PX = 10;
const SHEET_PEEK_MAX_FRACTION = 0.45;
/** The sheet never takes more of the screen than this, however tall its content. */
const SHEET_FULL_FRACTION = 0.85;
/** A flick: a release moving at least this fast (px/ms) throws the sheet to the
 *  end it was going, instead of leaving it where the finger stopped. */
const SHEET_FLICK_PX_PER_MS = 0.6;
/** A sheet snap eases over this long, and the body's framing glides with it. */
const SHEET_SNAP_S = 0.26;

/** A body swap cross-fades the skin over this long, behind the closed cut. */
const SWAP_FADE_S = 0.45;
/** The reveal's exterior ghost starts this opaque and clears as the cut opens. */
const GHOST_OPACITY = 0.32;
/** The wedge is turned this far off the view axis, so the viewer looks at
 *  its near face and along its terraces rather than straight into the crease. */
const WEDGE_YAW_DEG = 22;
/** ...and this far at Section, where the turn tapers out. Not zero: a disc
 *  face-on is a flat circle, and on a body with no rings and no air around it
 *  nothing else says the circle is a sphere with its near half gone. This
 *  much leaves a crescent of the skin's rim on one side (about a twentieth of
 *  the radius wide — ten degrees showed a hair, which the Moon's one brown
 *  mantle swallowed) and puts the two halves of every terrace at different
 *  angles to the key, so the middle reads as a crease rather than a seam. */
const SECTION_YAW_DEG = 18;
/** The Readable blend eases over this long. */
const SCALE_BLEND_S = 0.5;
const FPS_WINDOW = 60;
/** Recompute the remap when the projected radius moves this much. */
const REMAP_PX_TOLERANCE = 0.5;
/** The hover card sits this far from the pointer. */
const HOVER_CARD_OFFSET_PX = 14;
/** The ruler is fully drawn once the cut has opened this far. */
const RULER_FULL_DEG = 40;

export interface InteriorDevRegion {
  key: string;
  name: string;
  outerKm: number;
  /** Outer radius as drawn, a fraction of the disc. */
  displayOuter: number;
}

export interface InteriorDevHover {
  surface: PickSurface;
  regionKey: string;
  /** Depth below the surface at the hit, km, physical; null on the skin. */
  depthKm: number | null;
}

export type InteriorDisplayMode = 'composition' | 'temperature';

/**
 * What one open of a body cost, ms from the activate (or, for a swap, from the
 * pick) that started it — null for a step not reached yet. The tool's open is a
 * chain of serial steps, and the only way to say which one a reader is waiting
 * on is to mark them: the bridge serves these as `interiorState().timings` and
 * the mode logs them once through debugLog, so `?debug=1` on a phone answers
 * the question on the device that is slow.
 */
export interface InteriorOpenTimings {
  /** The session's first entry (which pays the shader compiles) or a later swap. */
  kind: 'entry' | 'swap';
  /** The body these marks describe. */
  bodyId: string;
  /** The colour map's fetch and the skin build (InteriorScene.prepareBody). */
  prepareStart: number | null;
  prepareEnd: number | null;
  /** The skin, the air and the rings on the body (InteriorScene.presentBody). */
  present: number | null;
  /** Linking the programs the reveal draws, under the veil (a first entry only). */
  precompileStart: number | null;
  precompileEnd: number | null;
  /** The cut starts opening. */
  revealStart: number | null;
  /** The first frame drawn after the reveal started: the first one a reader sees. */
  firstFrame: number | null;
  /** The first frame devReady() is true: the map applied, the cut and the morph settled. */
  ready: number | null;
  /** renderer.info.programs.length as the reveal starts and once ready — how many
   *  programs the studio still compiles while the reader is watching. */
  programsAtReveal: number | null;
  programsWhenReady: number | null;
}

/** The steps an open marks, in the order they happen. */
type OpenTimingMark =
  | 'prepareStart' | 'prepareEnd' | 'present'
  | 'precompileStart' | 'precompileEnd'
  | 'revealStart' | 'firstFrame' | 'ready';

/** One open's stopwatch: the marks it fills in and the instant they measure
 *  from. A commit holds its own, so a superseded commit's late steps land in an
 *  object nobody reads instead of overwriting the live open's marks. */
interface OpenStopwatch {
  readonly startedAt: number;
  readonly timings: InteriorOpenTimings;
}

function startOpenStopwatch(kind: 'entry' | 'swap', bodyId: string): OpenStopwatch {
  return {
    startedAt: performance.now(),
    timings: {
      kind,
      bodyId,
      prepareStart: null,
      prepareEnd: null,
      present: null,
      precompileStart: null,
      precompileEnd: null,
      revealStart: null,
      firstFrame: null,
      ready: null,
      programsAtReveal: null,
      programsWhenReady: null,
    },
  };
}

/** Mark one step, to a tenth of a millisecond. The first mark of a step stands:
 *  a step reached twice (a reveal onto the body that was already on) is still
 *  the moment the reader waited for. */
function markOpenStep(watch: OpenStopwatch, step: OpenTimingMark): void {
  if (watch.timings[step] !== null) return;
  watch.timings[step] = Math.round((performance.now() - watch.startedAt) * 10) / 10;
}

/** A finger on the sheet's grip: where it took hold, the heights it may drag
 *  between (measured once, so a move costs no layout), and how fast it is going. */
interface SheetDrag {
  pointerId: number;
  startClientY: number;
  startHeightPx: number;
  peekPx: number;
  fullPx: number;
  lastClientY: number;
  /** Event times, not clock reads: a slow frame must not distort a gesture. */
  lastMoveMs: number;
  /** px/ms, positive upward — the direction the sheet grows. */
  velocityPxPerMs: number;
  startMs: number;
  movedPx: number;
}

export interface InteriorDevState {
  bodyId: string;
  /** The drawn model's id, or null for the unresolved whole. */
  modelId: string | null;
  coverage: CoverageState;
  illustrative: boolean;
  displayMode: InteriorDisplayMode;
  /** The Temperature-mode scale, K, or null when no region's temperature is known. */
  temperatureRange: TemperatureRange | null;
  /** Whether the rings are shown; null for a body without any. */
  rings: boolean | null;
  view: CutView | null;
  openingAngleDeg: number;
  targetAngleDeg: number;
  readable: boolean;
  scaleBlend: number;
  projectedRadiusPx: number;
  /** The projection offset the camera applies right now, px: the disc's centre
   *  is the viewport's centre less this. */
  viewOffset: { x: number; y: number };
  presentationSeconds: number;
  frozen: boolean;
  loading: boolean;
  /** Whether a skin is on the body: false before the first body lands. */
  skin: boolean;
  ready: boolean;
  fps: number;
  regions: InteriorDevRegion[];
  /** The hovered, pinned and emphasised regions by key, and the open claim. */
  hover: string | null;
  pinned: string | null;
  evidence: ClaimKind | null;
  /** The page the panel shows, the reader's temperature unit, and whether View options is up. */
  page: InteriorPanelPage['kind'];
  unit: TemperatureUnit;
  optionsOpen: boolean;
  emphasis: { region: string | null; amount: number };
  /** What the open of this body cost, step by step (see InteriorOpenTimings). */
  timings: InteriorOpenTimings;
}

function orbitPose(azimuthDeg: number, elevationDeg: number, distance: number, out: THREE.Vector3): THREE.Vector3 {
  const azimuth = azimuthDeg * DEG2RAD;
  const elevation = elevationDeg * DEG2RAD;
  return out.set(
    distance * Math.sin(azimuth) * Math.cos(elevation),
    distance * Math.sin(elevation),
    distance * Math.cos(azimuth) * Math.cos(elevation),
  );
}

const ORIGIN = new THREE.Vector3(0, 0, 0);
const tmpLocalUp = new THREE.Vector3();
const tmpNdc = new THREE.Vector2();

/** A button in a radio group: its on class and its checked state, together. */
function setRadio(id: string, on: boolean): void {
  const button = document.getElementById(id);
  if (!button) return;
  button.classList.toggle('on', on);
  button.setAttribute('aria-checked', String(on));
}

export class InteriorMode {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly interiorScene: InteriorScene;
  private readonly controls: OrbitControls;
  private readonly isMultisampled: () => boolean;
  /** Whether the frame is drawn into a render target (the composer) or straight
   *  to the canvas: three keys every program on it, so the reveal's warm-up
   *  must compile with the live path's kind of target bound. A different
   *  question from isMultisampled, and the owner of the composer answers it. */
  private readonly drawsThroughComposer: () => boolean;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly domElement: HTMLElement;

  private active = false;
  private onExitCallback: (() => void) | null = null;
  private generation = 0;
  private loading = false;

  private body: InteriorBody | null = null;
  private coverage: Coverage = coverageFor(INTERIOR_DEFAULT_BODY);
  private drawn: DrawnModel = drawnUnresolved(INTERIOR_DEFAULT_BODY, 1, '');
  private displayMode: InteriorDisplayMode = 'composition';
  private ringsOn = true;
  private temperatureRange: TemperatureRange | null = null;
  private readonly picker: BodyPicker;
  private readonly ruler = new DepthRuler();
  private readonly cameraDirection = new THREE.Vector3();
  private utcMs = Date.now();

  // The cut: the frame the scene reads and the tween that moves its opening.
  private readonly frame = createCutFrame();
  private readonly cut = createCutTween(CUT_VIEW_ANGLE_DEG.cutaway);

  // The ruler: its input and layout are reused frame after frame, and it is
  // laid out and drawn again only when one of the things it depends on moved.
  private readonly rulerInput: RulerInput = {
    frame: this.frame,
    side: 'a',
    referenceRadiusKm: 1,
    remap: IDENTITY_REMAP,
    outerDisplay: [1],
    regionsInsideOut: [],
    annotations: [],
    terraceStep: TERRACE_STEP,
  };
  private readonly rulerLayoutCache = createRulerLayout();
  private readonly rulerKey = {
    angleDeg: NaN,
    remap: null as ReadableRemap | null,
    drawn: null as DrawnModel | null,
    side: 'a' as CutFaceSide,
    opacity: -1,
    width: 0,
    height: 0,
    cameraWorld: new THREE.Matrix4(),
    projection: new THREE.Matrix4(),
  };
  /** The ruler was hidden or never drawn: the next render must draw whatever the key says. */
  private rulerStale = true;

  // The Readable scale: off by default, so a reader's first look is the body's
  // own proportions and the note offers Readable where it would help.
  private readable = false;
  /** The model switch's note, and whether the reader has opened it past its first line. */
  private modelsNoteText = '';
  private modelsNoteExpanded = false;
  private scaleBlend = 0;
  private scaleBlendTarget = 0;
  private remap: ReadableRemap | null = null;
  private remapPx = -1;
  private remapBlend = -1;
  private projectedPx = 0;

  // The presentation clock.
  private presentationSeconds = 0;
  private frozen = false;

  // Hover, pin and emphasis.
  private readonly raycaster = new THREE.Raycaster();
  private readonly pickHit = createPickHit();
  private readonly pickLayout: PickLayout;
  private hoverIndex = -1;
  private legendHoverIndex = -1;
  private pinnedIndex = -1;
  private readonly emphasis = createEmphasisState();
  /** The page the panel shows: the layers, or one region's summary, details or evidence, or the model. */
  private page: InteriorPanelPage = { kind: 'layers' };
  /** The reader's temperature unit, session-only. */
  private temperatureUnit: TemperatureUnit = 'kelvin';
  /** Where the layer list was scrolled to when a page left it, restored on the way back. */
  private layersScrollTop = 0;
  /** The view options card is up, and who opened it (focus goes back there). */
  private optionsOpen = false;
  private optionsOpener: HTMLElement | null = null;
  /** Which canvas gesture is a tap (pin) and which a drag or a pinch (the orbit's). */
  private readonly tap = new TapRecognizer();
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  /** The cut is opening onto a freshly presented body: the ghost lingers over the opening. */
  private revealing = false;
  private cutSettledResolvers: (() => void)[] = [];

  // The phone sheet: its height is what the drag leaves behind, and the body's
  // framing follows it. The projection offset the camera applies is eased
  // toward its target so the disc glides with a snap and sticks to a finger.
  private sheetHeightPx = 0;
  /** The height the reader had before the inspector took the sheet, or null. */
  private sheetHeightBeforeInspectPx: number | null = null;
  private sheetDrag: SheetDrag | null = null;
  /** A drag that moved: the click that ends the gesture is its tail, not a tap. */
  private sheetDragMoved = false;
  private viewOffsetXPx = 0;
  private viewOffsetYPx = 0;
  private viewOffsetYTargetPx = 0;
  /** The distance the glide in flight spans, so it takes SHEET_SNAP_S whatever its length. */
  private viewOffsetSpanPx = 0;
  /** The fit distance the stage last asked for: a reader's zoom is kept as a ratio to it. */
  private fitDistanceNow = 0;
  /** The camera distance the framing glides toward (0: nothing pending) and that glide's span. */
  private distanceTargetNow = 0;
  private distanceSpan = 0;

  private readonly fpsSamples: number[] = [];
  /** Seconds since the last drawn frame: what the gauge divides, so it counts
   *  draws rather than ticks. */
  private presentAccumS = 0;
  private topBarPrevDisplay: string | null = null;

  // What the open cost. The stopwatch of the open that is running or last ran;
  // devState serves its marks and update() logs them once, when it settles.
  private openStopwatch: OpenStopwatch = startOpenStopwatch('entry', '');
  /** The reveal has started and the frame after it is not marked yet. */
  private awaitingFirstRevealFrame = false;
  /** The current open's marks have not been logged yet. */
  private openTimingsLogged = true;

  constructor(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    renderer: THREE.WebGLRenderer,
    floatCapable: boolean,
    isMultisampled: () => boolean,
    drawsThroughComposer: () => boolean,
  ) {
    this.camera = camera;
    this.isMultisampled = isMultisampled;
    this.drawsThroughComposer = drawsThroughComposer;
    this.renderer = renderer;
    this.domElement = renderer.domElement;
    this.interiorScene = new InteriorScene(scene, renderer, floatCapable);
    this.pickLayout = { frame: this.frame, outerDisplay: [1], terraceStep: TERRACE_STEP };

    this.controls = new OrbitControls(camera, renderer.domElement);
    this.controls.enabled = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = FRAMING.dampingFactor;
    this.controls.enablePan = false;
    this.controls.minDistance = FRAMING.minDistance;
    this.controls.maxDistance = FRAMING.maxDistance;
    this.controls.target.copy(ORIGIN);

    this.picker = new BodyPicker({
      ids: {
        root: 'interior-picker',
        list: 'interior-picker-list',
        title: 'interior-picker-title',
        search: 'interior-picker-search',
        empty: 'interior-picker-empty',
        close: 'interior-picker-close',
      },
      includeSun: true,
      renderTitle: (title) => {
        const strong = document.createElement('b');
        strong.textContent = CHOOSE_BODY;
        title.append(strong);
      },
      // The same pills the planetarium's Tools row shows, from the one builder.
      rowBadge: (name) => coverageTags(name, name === this.body?.id ? 'open now' : null),
      onPick: (name) => {
        this.picker.close();
        void this.commitBody(name);
      },
      onClose: () => this.setBackgroundInert(false),
    });

    this.bindPanel();
  }

  onExit(callback: () => void): void {
    this.onExitCallback = callback;
  }

  private requestExit(): void {
    this.onExitCallback?.();
  }

  // ---- lifecycle -----------------------------------------------------------

  /**
   * Open on a body at the planetarium's instant. Resolves once the map is
   * applied — the #mode-transition veil covers the load, so nothing
   * half-loaded shows. A name the catalog lacks opens as Earth.
   */
  async activate(bodyId: string, utcMs: number): Promise<void> {
    // The open's stopwatch starts here, so every mark is measured from the
    // instant the mode was handed the body (a swap later starts its own).
    this.openStopwatch = startOpenStopwatch('entry', bodyId);
    this.openTimingsLogged = false;
    this.active = true;
    this.utcMs = utcMs;
    this.camera.near = 0.05;
    this.camera.far = 300;
    this.camera.fov = FRAMING.fovDeg;
    this.camera.updateProjectionMatrix();

    const topBar = document.getElementById('top-bar');
    if (topBar) {
      this.topBarPrevDisplay = topBar.style.display;
      topBar.style.display = 'none';
    }
    const ui = document.getElementById('interior-ui');
    if (ui) ui.style.display = 'block';
    this.picker.bind();
    this.ruler.bind('interior-ruler');

    this.interiorScene.setEdgeMode(this.isMultisampled());
    this.interiorScene.setVisible(true);
    this.controls.enabled = true;
    window.addEventListener('keydown', this.handleKeyDown);
    this.domElement.addEventListener('pointermove', this.handlePointerMove);
    this.domElement.addEventListener('pointerdown', this.handlePointerDown);
    this.domElement.addEventListener('pointerup', this.handlePointerUp);
    this.domElement.addEventListener('pointercancel', this.handlePointerCancel);
    // OrbitControls captures the pointer on its down; a capture lost mid-gesture
    // is an up this never sees.
    this.domElement.addEventListener('lostpointercapture', this.handlePointerCancel);
    this.domElement.addEventListener('pointerleave', this.handlePointerLeave);
    window.addEventListener('blur', this.handleBlur);
    this.fpsSamples.length = 0;
    this.presentationSeconds = 0;
    this.frozen = false;

    this.resetSheetHeight();
    this.frameInitial();
    this.interiorScene.setMotionScale(this.reducedMotion.matches ? 0 : 1);
    // Open closed, then swing to the chosen view once the map is on: the
    // reveal, which the commit owns (a pick during this load supersedes the
    // entry's commit, and that pick's commit reveals instead). Phones open
    // on Section, the view that reads at a small size.
    this.setTargetAngle(CUT_VIEW_ANGLE_DEG[isPhoneViewport() ? 'section' : 'cutaway'], false);
    this.setTargetAngle(0, false, false);
    await this.commitBody(bodyId);
  }

  /** Open the cut onto a freshly presented body, the exterior ghost lingering over the opening. */
  private reveal(toDeg: number): void {
    const animate = !this.reducedMotion.matches;
    this.revealing = animate;
    this.setTargetAngle(toDeg, animate);
  }

  deactivate(): void {
    this.active = false;
    this.generation++; // cancels any in-flight map load
    this.loading = false;
    // A swap parked on the closing cut wakes, finds itself stale and frees what it prepared.
    this.settleCut();
    this.interiorScene.setVisible(false);
    this.picker.close();
    this.closeOptions();
    this.ruler.hide();
    const ui = document.getElementById('interior-ui');
    if (ui) ui.style.display = 'none';
    this.controls.enabled = false;
    window.removeEventListener('keydown', this.handleKeyDown);
    this.domElement.removeEventListener('pointermove', this.handlePointerMove);
    this.domElement.removeEventListener('pointerdown', this.handlePointerDown);
    this.domElement.removeEventListener('pointerup', this.handlePointerUp);
    this.domElement.removeEventListener('pointercancel', this.handlePointerCancel);
    this.domElement.removeEventListener('lostpointercapture', this.handlePointerCancel);
    this.domElement.removeEventListener('pointerleave', this.handlePointerLeave);
    window.removeEventListener('blur', this.handleBlur);
    this.tap.reset();
    this.clearSelection();
    this.sheetDrag = null;
    this.sheetDragMoved = false;
    this.sheetHeightPx = 0;
    this.sheetHeightBeforeInspectPx = null;
    const panel = document.getElementById('interior-panel');
    panel?.classList.remove('snapping');
    panel?.style.removeProperty('--sheet-h');
    this.viewOffsetXPx = 0;
    this.viewOffsetYPx = 0;
    this.viewOffsetYTargetPx = 0;
    this.fitDistanceNow = 0;
    this.distanceTargetNow = 0;
    this.layersScrollTop = 0;
    this.camera.clearViewOffset();
    const topBar = document.getElementById('top-bar');
    if (topBar) topBar.style.display = this.topBarPrevDisplay ?? '';
    this.topBarPrevDisplay = null;
    this.interiorScene.releaseBodyResources();
  }

  dispose(): void {
    this.deactivate();
    this.controls.dispose();
    this.interiorScene.dispose();
  }

  // ---- per-frame -----------------------------------------------------------

  /**
   * One tick. `willDraw` is whether it ends in a drawn frame — false only
   * where the Frame rate row's target skips one, and the tool takes the cap
   * like the app it was launched from. The studio's own simulation runs on
   * every tick; the ruler, which is laid out against the camera, waits for a
   * draw, and so does the gauge, which reports the rate a reader sees.
   */
  update(dt: number, willDraw = true): void {
    if (!this.active) return;
    this.presentAccumS += dt;
    if (willDraw && this.presentAccumS > 0) {
      this.fpsSamples.push(1 / this.presentAccumS);
      if (this.fpsSamples.length > FPS_WINDOW) this.fpsSamples.shift();
    }
    if (willDraw) this.presentAccumS = 0;
    if (!this.frozen) this.presentationSeconds += dt;
    this.interiorScene.setPresentationTime(this.presentationSeconds);

    this.advanceCut(dt);
    this.advanceScale(dt);
    this.interiorScene.advance(dt);
    this.controls.update();
    this.advanceViewShift(dt);

    // The regions go out before the cut is posed: applyCut sizes the faces
    // and the shells by the region count, so a model that changed since the
    // last frame is drawn whole, never with the old count for one frame.
    this.projectedPx = projectedRadiusPx(
      BODY_RADIUS,
      this.camera.position.distanceTo(ORIGIN),
      this.camera.fov,
      window.innerHeight,
    );
    this.refreshRemapIfNeeded();

    // The cut frame follows the camera continuously (plan §5): hinge = the
    // camera's own up, so nothing snaps through the poles.
    tmpLocalUp.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
    computeCutFrame(this.camera.position, tmpLocalUp, ORIGIN, openingAngleDegToRad(this.cut.angleDeg), this.frame);
    // The wedge yaw tapers from the cutaway's full turn to the Section floor,
    // which is what keeps a Section reading as a sphere and not as a disc.
    yawCutFrame(this.frame, wedgeYawForOpening(this.frame.openingAngle, WEDGE_YAW_DEG * DEG2RAD, SECTION_YAW_DEG * DEG2RAD));
    this.interiorScene.applyCut(this.frame);
    this.interiorScene.updateForCamera(this.camera);

    this.advanceEmphasis(dt);
    if (willDraw) this.renderRuler();
  }

  /**
   * A frame has been drawn. The open's last two marks are both frames rather
   * than steps — the first one the reader SEES and the first one everything
   * has settled on — so they are taken here and not inside update(), where a
   * tick that drew nothing would claim them.
   */
  afterDraw(_drawSeq: number, _nowMs: number): void {
    if (!this.active) return;
    this.traceOpenProgress();
  }

  /** The open's last two marks, both of them frames rather than steps: the first
   *  frame drawn after the reveal started (the first one the reader sees) and
   *  the first frame everything has settled on. The set is logged once, there —
   *  `?debug=1` on a phone then says where the open's time went. */
  private traceOpenProgress(): void {
    const watch = this.openStopwatch;
    if (this.awaitingFirstRevealFrame) {
      this.awaitingFirstRevealFrame = false;
      markOpenStep(watch, 'firstFrame');
    }
    if (this.openTimingsLogged || watch.timings.revealStart === null || !this.devReady()) return;
    this.openTimingsLogged = true;
    markOpenStep(watch, 'ready');
    watch.timings.programsWhenReady = this.programCount();
    debugLog('Look inside: open timings', { ...watch.timings });
  }

  /** How many shader programs the renderer holds right now: the count before
   *  and after a reveal says how much of the studio compiles in front of the
   *  reader instead of under the veil. */
  private programCount(): number {
    return this.renderer.info.programs?.length ?? 0;
  }

  /** The depth ruler along the near face, through the remap; hidden on phones
   *  and while the cut is closed. Laid out and drawn again only when something
   *  it depends on moved — the cut, the remap, the model, the face it sits on,
   *  the camera, the viewport, its opacity — so a frame at rest costs nothing here. */
  private renderRuler(): void {
    if (isPhoneViewport() || !this.remap || this.cut.angleDeg <= 0.5 || this.loading) {
      this.ruler.hide();
      this.rulerStale = true;
      return;
    }
    // The camera's matrices are current from the last render; the projection
    // is a frame behind at worst, which the eye cannot see.
    this.camera.updateMatrixWorld();
    this.cameraDirection.copy(this.camera.position).normalize();
    const side = rulerSide(this.frame, this.cameraDirection);
    const opacity = Math.min(1, this.cut.angleDeg / RULER_FULL_DEG);
    const width = window.innerWidth;
    const height = window.innerHeight;
    const key = this.rulerKey;
    const unchanged = !this.rulerStale
      && key.angleDeg === this.cut.angleDeg && key.remap === this.remap && key.drawn === this.drawn && key.side === side
      && key.opacity === opacity && key.width === width && key.height === height
      && key.cameraWorld.equals(this.camera.matrixWorld) && key.projection.equals(this.camera.projectionMatrix);
    if (unchanged) return;
    key.angleDeg = this.cut.angleDeg;
    key.remap = this.remap;
    key.drawn = this.drawn;
    key.side = side;
    key.opacity = opacity;
    key.width = width;
    key.height = height;
    key.cameraWorld.copy(this.camera.matrixWorld);
    key.projection.copy(this.camera.projectionMatrix);
    this.rulerStale = false;
    const input = this.rulerInput;
    input.side = side;
    input.referenceRadiusKm = this.drawn.referenceRadiusKm;
    input.remap = this.remap;
    input.outerDisplay = this.pickLayout.outerDisplay;
    input.regionsInsideOut = this.drawn.regionsInsideOut;
    input.annotations = this.drawn.model?.annotations ?? [];
    this.ruler.render(rulerLayout(input, this.rulerLayoutCache), this.camera, width, height, opacity);
  }

  private advanceCut(dt: number): void {
    if (cutTweenSettled(this.cut)) {
      advanceCutTween(this.cut, dt);
      this.settleCut();
      return;
    }
    const progress = advanceCutTween(this.cut, dt);
    // The reveal's ghost: the removed skin lingers, translucent, and clears as the cut opens.
    if (this.revealing) this.interiorScene.setGhost(GHOST_OPACITY * (1 - progress));
    this.syncAngleReadout();
    if (cutTweenSettled(this.cut)) this.settleCut();
  }

  /** The cut animation has landed: the ghost clears and anyone waiting on the close proceeds. */
  private settleCut(): void {
    if (this.revealing) {
      this.revealing = false;
      this.interiorScene.setGhost(0);
    }
    if (this.cutSettledResolvers.length > 0) {
      const resolvers = this.cutSettledResolvers;
      this.cutSettledResolvers = [];
      for (const resolve of resolvers) resolve();
    }
  }

  /** Resolves on the frame the cut animation lands (at once when it is not moving). */
  private cutSettled(): Promise<void> {
    if (cutTweenSettled(this.cut)) return Promise.resolve();
    return new Promise((resolve) => this.cutSettledResolvers.push(resolve));
  }

  private advanceScale(dt: number): void {
    // Under prefers-reduced-motion the Readable morph lands at once, like the rest of the tool's motion.
    this.scaleBlend = this.reducedMotion.matches
      ? this.scaleBlendTarget
      : stepToward(this.scaleBlend, this.scaleBlendTarget, dt / SCALE_BLEND_S);
  }

  /**
   * The Readable policy, recomputed when the disc's projected size or the
   * blend moves: region boundaries go to the faces in display space.
   */
  private refreshRemapIfNeeded(): void {
    if (
      this.remap &&
      Math.abs(this.projectedPx - this.remapPx) < REMAP_PX_TOLERANCE &&
      this.remapBlend === this.scaleBlend
    ) {
      return;
    }
    this.remapPx = this.projectedPx;
    this.remapBlend = this.scaleBlend;
    const remap = readableRemap(outerFractionsInsideOut(this.drawn), minDisplayFraction(READABLE_MIN_PX, this.projectedPx), this.scaleBlend);
    this.remap = remap;
    const looks = regionLooks(this.drawn, remap, regionArtInsideOut(this.drawn), this.temperatureRange);
    this.interiorScene.applyRegions(looks);
    this.interiorScene.setTemperatureScale(this.temperatureRange);
    this.pickLayout.outerDisplay = looks.map((look) => look.outerDisplay);
    // The disc's size moved, so the count of layers too thin to see may have too.
    this.syncThicknessNote();
  }

  // ---- the cut and the scale ----------------------------------------------

  private setTargetAngle(deg: number, animate: boolean, remember = true): void {
    // Under prefers-reduced-motion every move of the cut lands at once, the view buttons' included.
    setCutTarget(this.cut, deg, animate && !this.reducedMotion.matches, remember);
    this.syncViewButtons();
    this.syncAngleReadout();
  }

  private setView(view: CutView): void {
    this.setTargetAngle(CUT_VIEW_ANGLE_DEG[view], true);
  }

  private setReadable(on: boolean): void {
    this.readable = on;
    this.scaleBlendTarget = on ? 1 : 0;
    const toggle = document.getElementById('interior-readable-toggle') as HTMLInputElement | null;
    if (toggle) toggle.checked = on;
    // A one-region body has nothing to widen.
    const oneRegion = this.drawn.regionsInsideOut.length <= 1;
    const row = document.getElementById('interior-readable-row');
    if (row) row.style.display = oneRegion ? 'none' : '';
    this.syncThicknessNote();
  }

  /** The thin-layers note under the display buttons: which layers are too thin
   *  to see at the disc's current size, with the one-tap way to enlarge them —
   *  or, enlarged, the word that says so. The same words sit under the switch
   *  in View options. The DOM is written only when the words change, and the
   *  sheet's resting height follows the row's coming and going. */
  private syncThicknessNote(): void {
    const names = this.readable
      ? []
      : tooThinToSeeIndices(outerFractionsInsideOut(this.drawn), READABLE_MIN_PX, this.projectedPx)
        .map((index) => this.drawn.regionsInsideOut[index]?.name ?? '')
        .filter((name) => name !== '');
    const text = thinLayersNoteText(this.readable, names);
    const row = document.getElementById('interior-thin-note');
    const label = document.getElementById('interior-thin-text');
    const toggle = document.getElementById('interior-thin-toggle');
    if (row && label && toggle) {
      const display = text ? '' : 'none';
      const rowMoved = row.style.display !== display;
      if (rowMoved) row.style.display = display;
      if (label.textContent !== text) label.textContent = text;
      const toggleText = this.readable ? 'Actual size' : 'Enlarge';
      if (toggle.textContent !== toggleText) toggle.textContent = toggleText;
      if (rowMoved) this.syncSheetToContent();
    }
    const note = document.getElementById('interior-readable-note');
    if (note) {
      if (note.textContent !== text) note.textContent = text;
      note.style.display = text ? '' : 'none';
    }
  }

  // ---- body ------------------------------------------------------------------

  /**
   * Bring a body in. The first body of a session loads under the veil with
   * the cut closed and is presented at once; a swap is the ceremony of plan
   * §4: the cut closes over the old body while the new map loads, the skin
   * cross-fades behind the closed cut once both are done, the panel turns
   * over, and the cut reopens onto the new body with the exterior ghost.
   * Either way the commit reveals onto what it presented, and onto programs
   * that are already linked: a first entry warms the whole reveal under the
   * veil, a swap the prepared skin inside its own close. Nothing
   * half-loaded is ever shown, and a newer pick cancels an older one at
   * every await. A throw on the way (a shader that changed shape, a moon
   * without a map) leaves the body that was on, reopens onto it and warns;
   * on a first entry it reaches the mode switch instead.
   */
  private async commitBody(bodyId: string): Promise<boolean> {
    let body = resolveInteriorBody(bodyId);
    if (!body) {
      debugWarn('Look inside: unknown body, opening Earth instead', { bodyId });
      body = resolveInteriorBody(INTERIOR_DEFAULT_BODY)!;
    }
    // The body already on, with nothing in flight: nothing to bring in.
    if (this.body?.id === body.id && !this.loading && this.interiorScene.hasSkin()) return true;
    const generation = ++this.generation;
    const stale = () => generation !== this.generation;
    const animate = !this.reducedMotion.matches;
    const swap = this.body !== null && this.interiorScene.hasSkin();
    const reopenDeg = this.cut.chosenDeg;
    // A swap is its own open, timed from the pick; a first entry's marks are
    // measured from activate(), which started that stopwatch. Either way this
    // commit marks into the object it holds here: a commit superseded by a
    // newer pick writes its late steps into nobody's timings.
    const watch = swap
      ? (this.openStopwatch = startOpenStopwatch('swap', body.id))
      : this.openStopwatch;
    if (swap) this.openTimingsLogged = false;
    else watch.timings.bodyId = body.id;
    this.loading = true;
    if (swap) {
      this.revealing = false;
      this.interiorScene.setGhost(0);
      this.clearSelection();
      this.setTargetAngle(0, animate, false); // the ceremony's close is not a chosen view
    }
    let prepared: PreparedSkin | null = null;
    let presented = false;
    try {
      markOpenStep(watch, 'prepareStart');
      prepared = await this.interiorScene.prepareBody(body, stale);
      if (!prepared || stale()) return false;
      markOpenStep(watch, 'prepareEnd');
      if (swap) {
        // The close is 0.9 s of animation with nothing else to do in it: the
        // prepared skin's program is linked in that window, so the cross-fade
        // does not stall on it.
        await this.interiorScene.warmUpPreparedSkin(prepared, this.camera, this.drawsThroughComposer());
        if (stale()) return false;
        await this.cutSettled();
        if (stale()) return false;
      }
      // The swap moment, behind the closed cut: the pose and the skin first
      // (the steps that can throw, and a throw there leaves the old body
      // whole), then the faces and the panel turn over.
      this.interiorScene.setPose(body, this.utcMs);
      this.interiorScene.presentBody(prepared, swap && animate ? SWAP_FADE_S : 0);
      markOpenStep(watch, 'present');
      presented = true;
      this.body = body;
      this.coverage = coverageFor(body.id);
      const model = defaultModelFor(body.id);
      this.drawn = model
        ? drawnFromModel(model)
        : drawnUnresolved(body.id, body.radiusKm, unresolvedComposition(this.coverage));
      this.applyDrawn(true);
      this.syncRingsRow();
      if (swap) {
        await this.interiorScene.fadeDone();
        if (stale()) return false;
      } else {
        // A first entry is where the studio's programs are paid for: the faces,
        // the shells and the ghost are hidden until the cut opens, so they used
        // to be compiled on the frames the reveal is drawn on. Linked here
        // instead, under the veil, with the cut still closed and nothing on
        // screen to disturb (InteriorScene.warmUpRevealShaders). Fail-open: a
        // warm-up that cannot run leaves the reveal exactly as it was.
        markOpenStep(watch, 'precompileStart');
        await this.interiorScene.warmUpRevealShaders(this.camera, this.drawsThroughComposer());
        if (stale()) return false;
        markOpenStep(watch, 'precompileEnd');
      }
      markOpenStep(watch, 'revealStart');
      watch.timings.programsAtReveal = this.programCount();
      this.awaitingFirstRevealFrame = true;
      this.reveal(reopenDeg);
      debugLog('Look inside: body applied', { bodyId: body.id, swap });
      return true;
    } catch (error) {
      if (stale()) return false; // a newer pick owns the state now
      debugWarn('Look inside: the body could not be brought in', { bodyId: body.id, swap, error: String(error) });
      if (!swap) throw error; // a first entry has nothing to reopen onto: the mode switch falls back
      this.reveal(reopenDeg); // the body that was on is still on
      return false;
    } finally {
      // A prepared skin nobody presented is freed, its late slot included; a
      // stale commit's flags belong to the newer commit and are left alone.
      if (prepared && !presented) this.interiorScene.discardPrepared(prepared);
      if (!stale()) this.loading = false;
    }
  }

  /** Draw a model of the current body (null: the unresolved whole, for a
   *  body whose coverage draws nothing by default). */
  private selectModel(modelId: string | null): boolean {
    if (!this.body) return false;
    if (modelId === null) {
      if (this.coverage.state !== 'poorlyConstrained' && this.coverage.state !== 'notYetModelled') return false;
      this.drawn = drawnUnresolved(this.body.id, this.body.radiusKm, unresolvedComposition(this.coverage));
    } else {
      const model = modelFor(this.body.id, modelId);
      if (!model) return false;
      this.drawn = drawnFromModel(model);
    }
    this.applyDrawn();
    return true;
  }

  /** A new drawn model: its scale, its boundaries on the faces at once, a fresh
   *  panel (its rows fading in outside-in when a body is revealed). */
  private applyDrawn(reveal = false): void {
    this.temperatureRange = bodyTemperatureRange(this.drawn.regionsInsideOut.flatMap((region) => (region.region ? [region.region.temperatureK] : [])));
    // The new model's boundaries go out now, not on the next frame: the faces,
    // the pick layout and the ruler never see the old model's count or radii.
    this.remap = null;
    this.refreshRemapIfNeeded();
    this.clearSelection();
    this.renderPanel(reveal);
  }

  private setRings(on: boolean): void {
    this.ringsOn = on;
    this.interiorScene.setRingsVisible(on);
    const toggle = document.getElementById('interior-rings-toggle') as HTMLInputElement | null;
    if (toggle) toggle.checked = on;
    this.applyViewportFraming(false); // the rings widen what has to fit
  }

  /** The rings row shows only for a body that has rings, which makes the footer
   *  taller — so the sheet's resting height follows it. */
  private syncRingsRow(): void {
    const row = document.getElementById('interior-rings-row');
    if (row) row.style.display = this.interiorScene.hasRings() ? '' : 'none';
    this.applyViewportFraming(false);
  }

  private setDisplayMode(mode: InteriorDisplayMode): void {
    this.displayMode = mode;
    this.interiorScene.setDisplayMode(mode === 'temperature' ? 1 : 0);
    setRadio('interior-mode-composition', mode === 'composition');
    setRadio('interior-mode-temperature', mode === 'temperature');
    this.renderPanel();
  }

  /** The reader's temperature unit: every temperature the panel shows follows it. */
  private setUnit(unit: TemperatureUnit): void {
    if (unit === this.temperatureUnit) return;
    this.temperatureUnit = unit;
    setRadio('interior-unit-kelvin', unit === 'kelvin');
    setRadio('interior-unit-celsius', unit === 'celsius');
    this.renderPanel();
  }

  // ---- DOM -------------------------------------------------------------------

  private bindPanel(): void {
    document.getElementById('interior-leave')?.addEventListener('click', () => this.requestExit());
    document.getElementById('interior-body-chip')?.addEventListener('click', () => this.openPicker());
    const optionsOpen = document.getElementById('interior-options-open');
    optionsOpen?.addEventListener('click', () => this.openOptions(optionsOpen));
    document.getElementById('interior-options-close')?.addEventListener('click', () => this.closeOptions());
    // The card's backdrop closes it, like the picker's.
    document.getElementById('interior-options')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) this.closeOptions();
    });
    this.bindRadioGroup(CUT_VIEWS.map((view) => `interior-view-${view}`), (index) => this.setView(CUT_VIEWS[index]));
    this.bindRadioGroup(['interior-mode-composition', 'interior-mode-temperature'], (index) => this.setDisplayMode(index === 0 ? 'composition' : 'temperature'));
    this.bindRadioGroup(['interior-unit-kelvin', 'interior-unit-celsius'], (index) => this.setUnit(index === 0 ? 'kelvin' : 'celsius'));
    const slider = document.getElementById('interior-angle') as HTMLInputElement | null;
    slider?.addEventListener('input', () => {
      this.setTargetAngle(Number(slider.value), false);
    });
    const readable = document.getElementById('interior-readable-toggle') as HTMLInputElement | null;
    readable?.addEventListener('change', () => this.setReadable(readable.checked));
    document.getElementById('interior-thin-toggle')?.addEventListener('click', () => this.setReadable(!this.readable));
    document.getElementById('interior-legend-head')?.addEventListener('click', () => {
      if (isPhoneViewport()) this.toggleSheet();
    });
    document.getElementById('interior-model-info')?.addEventListener('click', () => this.showPage({ kind: 'model' }));
    this.bindSheetGrip();
    document.getElementById('interior-scroll')?.addEventListener('scroll', () => this.updateScrollCue(), { passive: true });
    const more = document.getElementById('interior-models-more');
    more?.addEventListener('click', () => {
      this.modelsNoteExpanded = !this.modelsNoteExpanded;
      this.syncModelsNote();
    });
    const rings = document.getElementById('interior-rings-toggle') as HTMLInputElement | null;
    rings?.addEventListener('change', () => this.setRings(rings.checked));
  }

  /** A row of buttons as a radio group: a click picks, and the arrow keys move the pick. */
  private bindRadioGroup(buttonIds: readonly string[], onPick: (index: number) => void): void {
    const buttons = buttonIds.map((id) => document.getElementById(id));
    buttons.forEach((button, index) => {
      if (!button) return;
      button.addEventListener('click', () => onPick(index));
      button.addEventListener('keydown', (event) => {
        const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
          : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
        if (step === 0) return;
        event.preventDefault();
        const next = (index + step + buttons.length) % buttons.length;
        onPick(next);
        buttons[next]?.focus();
      });
    });
  }

  private renderPanel(reveal = false): void {
    const body = this.body;
    const name = document.getElementById('interior-body-name');
    if (name && body) {
      const display = bodyDisplayName(body.id);
      name.textContent = display.charAt(0).toUpperCase() + display.slice(1);
    }
    const subtitle = document.getElementById('interior-subtitle');
    if (subtitle) {
      const text = subtitleFor(this.coverage, this.drawn);
      subtitle.textContent = text;
      subtitle.style.display = text ? '' : 'none';
    }
    const coverageNote = document.getElementById('interior-coverage-note');
    if (coverageNote) {
      // The bulk line, only when nothing is drawn: what the density says.
      const bulk = this.drawn.model === null ? coverageBulk(this.coverage) : null;
      coverageNote.textContent = bulk ? bulk.note : '';
      coverageNote.style.display = bulk ? '' : 'none';
    }
    this.renderModelSwitch();
    const temperature = this.displayMode === 'temperature';
    const legend = document.getElementById('interior-legend');
    if (legend) {
      legend.replaceChildren();
      // Rows fade in outside-in on a reveal; any other re-render is instant.
      const revealRows = reveal && !this.reducedMotion.matches;
      legend.classList.toggle('reveal', revealRows);
      if (revealRows) {
        // The class comes off once the last row (the innermost, appended last
        // with the longest delay) has faded in. A display:none cancels a CSS
        // animation and a return to display restarts it, so a legend left
        // wearing the class would replay its fade every time the phone's
        // inspector gave the sheet back to the layers.
        legend.addEventListener('animationend', function settleReveal(event: AnimationEvent) {
          if (event.animationName !== 'interior-row-in' || event.target !== legend.lastElementChild) return;
          legend.classList.remove('reveal');
          legend.removeEventListener('animationend', settleReveal);
        });
      }
      const art = regionArtInsideOut(this.drawn);
      // The legend reads outside-in, the way a reader meets the layers.
      for (let index = this.drawn.regionsInsideOut.length - 1; index >= 0; index--) {
        const region = this.drawn.regionsInsideOut[index];
        const depthTop = this.drawn.referenceRadiusKm - region.outerRadiusKm;
        const depthBottom = this.drawn.referenceRadiusKm - region.innerRadiusKm;
        const row = document.createElement('div');
        row.className = 'interior-row';
        row.dataset.region = region.key;
        row.dataset.index = String(index);
        row.style.setProperty('--row', String(this.drawn.regionsInsideOut.length - 1 - index));
        row.tabIndex = 0;
        row.setAttribute('role', 'listitem');
        row.setAttribute('aria-label', `${region.name}: open details`);
        // The row is the region: hover emphasises it in 3-D, a click pins it.
        row.addEventListener('pointerenter', () => this.setLegendHover(index));
        row.addEventListener('pointerleave', () => {
          if (this.legendHoverIndex === index) this.setLegendHover(-1);
        });
        row.addEventListener('click', () => this.togglePin(index));
        row.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            this.togglePin(index);
          }
        });
        const swatch = document.createElement('i');
        swatch.className = 'interior-swatch';
        // The swatch is what the face shows in this mode: the material's tone
        // (heated by its incandescence), or its place on the temperature scale.
        if (!temperature && art[index].pattern === 'hatch') {
          swatch.classList.add('hatched'); // the unresolved whole is hatched in both modes
        } else if (!temperature) {
          const swatchColor = swatchHex(art[index], incandescence(region.temperatureK ?? 0));
          swatch.style.background = `#${swatchColor.toString(16).padStart(6, '0')}`;
        } else if (region.temperatureK !== null && this.temperatureRange) {
          const swatchColor = temperatureScaleHex(temperatureT(this.temperatureRange, region.temperatureK));
          swatch.style.background = `#${swatchColor.toString(16).padStart(6, '0')}`;
        } else {
          swatch.classList.add('hatched');
        }
        const text = document.createElement('div');
        text.className = 'interior-row-text';
        const title = document.createElement('div');
        title.className = 'interior-row-name';
        title.textContent = region.name;
        const detail = document.createElement('div');
        detail.className = 'interior-row-detail';
        // In Temperature mode the row says the temperature, since that is what the face shows.
        detail.textContent = temperature
          ? (region.region ? temperatureQuantityText(region.region.temperatureK, this.temperatureUnit) : NOT_KNOWN)
          : region.composition;
        text.append(title, detail);
        // The row's second line: how deep it lies, what state it is in and how
        // hot it is — the three things a reader compares between layers.
        // Each piece carries its own separator, so a line that wraps on a narrow
        // panel never begins with a middot.
        const secondLine = document.createElement('div');
        secondLine.className = 'interior-row-depth';
        const pieces = [`${formatKm(depthTop)}–${formatKm(depthBottom)} km`];
        const phase = PHASE_LABEL[region.phase];
        if (phase) pieces.push(phase);
        // The reader's unit; the basis word is the details page's.
        const temperatureRange = region.region ? temperatureRangeText(region.region.temperatureK, this.temperatureUnit) : '';
        if (temperatureRange) pieces.push(temperatureRange);
        for (let pieceIndex = 0; pieceIndex < pieces.length; pieceIndex++) {
          const last = pieceIndex === pieces.length - 1;
          const part = document.createElement('span');
          part.className = 'interior-row-part';
          part.textContent = last ? pieces[pieceIndex] : `${pieces[pieceIndex]} ·`;
          secondLine.append(part);
          if (!last) secondLine.append(document.createTextNode(' '));
        }
        row.append(swatch, text, secondLine);
        // What the evidence makes of the region, in words from the KIND of
        // evidence (evidenceSummary) — never a score.
        if (region.region) {
          const summary = regionEvidenceSummary(region.region);
          const standing = document.createElement('div');
          standing.className = `interior-row-standing ii-standing-${summary.standing}`;
          standing.textContent = summary.phrase;
          row.append(standing);
        }
        legend.append(row);
      }
    }
    const legendHead = document.getElementById('interior-legend-head');
    if (legendHead) {
      const count = this.drawn.regionsInsideOut.length;
      legendHead.textContent = count > 1 ? `${LAYERS} · ${count}` : LAYERS;
    }
    this.renderScale();
    this.syncLegendEmphasis();
    this.renderPage();
    this.syncViewButtons();
    this.syncAngleReadout();
    this.setReadable(this.readable);
    this.syncSheetToContent();
    requestAnimationFrame(() => this.updateScrollCue());
  }

  // ---- the phone sheet -------------------------------------------------------

  /**
   * The sheet's grip: a drag handle on a phone. The height follows the finger
   * between the sheet's peek and its full height, a flick throws it to the end
   * it was going, and a press that stays put toggles peek ↔ full. The toggle is
   * the click, so a keyboard reaches it too; a drag suppresses the click that
   * follows it.
   */
  private bindSheetGrip(): void {
    const grip = document.getElementById('interior-grip');
    if (!grip) return;
    grip.addEventListener('pointerdown', (event) => {
      if (!isPhoneViewport() || this.sheetDrag !== null) return;
      try {
        grip.setPointerCapture(event.pointerId);
      } catch {
        return; // the pointer is already gone: never arm a gesture that cannot end
      }
      // Gesture times come from the events themselves, not from the clock the
      // handler reads: a frame that took a while to render must not make a
      // quick flick read as a slow drag, or a tap as a long press.
      const nowMs = event.timeStamp;
      // A snap in flight stops where the eye sees it: the finger takes the sheet
      // from that height, not from the one the snap was heading for.
      const panel = document.getElementById('interior-panel');
      const startHeightPx = panel ? Math.round(panel.getBoundingClientRect().height) : this.peekHeightPx();
      this.sheetDragMoved = false;
      this.sheetDrag = {
        pointerId: event.pointerId,
        startClientY: event.clientY,
        startHeightPx,
        peekPx: this.peekHeightPx(),
        fullPx: this.fullHeightPx(),
        lastClientY: event.clientY,
        lastMoveMs: nowMs,
        velocityPxPerMs: 0,
        startMs: nowMs,
        movedPx: 0,
      };
      this.setSheetHeight(startHeightPx, { snap: false, bounds: this.sheetDrag });
    });
    grip.addEventListener('pointermove', (event) => {
      const drag = this.sheetDrag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const nowMs = event.timeStamp;
      const sinceLastMoveMs = nowMs - drag.lastMoveMs;
      if (sinceLastMoveMs > 0) drag.velocityPxPerMs = (drag.lastClientY - event.clientY) / sinceLastMoveMs;
      drag.movedPx = Math.max(drag.movedPx, Math.abs(event.clientY - drag.startClientY));
      drag.lastClientY = event.clientY;
      drag.lastMoveMs = nowMs;
      // The finger asks for a height; the sheet gives what it can of it.
      this.setSheetHeight(drag.startHeightPx + (drag.startClientY - event.clientY), { snap: false, bounds: drag });
    });
    const endDrag = (event: PointerEvent) => {
      const drag = this.sheetDrag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      this.sheetDrag = null;
      const heldStill = drag.movedPx <= TAP_MAX_PX && event.timeStamp - drag.startMs <= TAP_MAX_MS;
      if (heldStill) return; // the click that follows is the tap, and toggles the sheet
      this.sheetDragMoved = true;
      // The click the browser makes out of this gesture is its tail, not a tap.
      // It is dispatched in the same task as the pointerup, so the next turn of
      // the loop is the earliest a real tap — or a keyboard Enter — could come.
      window.setTimeout(() => { this.sheetDragMoved = false; }, 0);
      // A flick lands at the end it was thrown at; anything slower stays where the finger left it.
      if (Math.abs(drag.velocityPxPerMs) >= SHEET_FLICK_PX_PER_MS) {
        this.setSheetHeight(drag.velocityPxPerMs > 0 ? drag.fullPx : drag.peekPx, { snap: true, bounds: drag });
      }
    };
    grip.addEventListener('pointerup', endDrag);
    grip.addEventListener('pointercancel', endDrag);
    grip.addEventListener('lostpointercapture', endDrag);
    grip.addEventListener('click', () => {
      if (this.sheetDragMoved) {
        this.sheetDragMoved = false;
        return;
      }
      this.toggleSheet();
    });
  }

  /** Peek ↔ full: the grip's press and the Layers row both do this. */
  private toggleSheet(): void {
    if (!isPhoneViewport()) return;
    const fullPx = this.fullHeightPx();
    const atFull = this.sheetHeightPx >= fullPx - 1;
    this.setSheetHeight(atFull ? this.peekHeightPx() : fullPx, { snap: true });
  }

  /** The sheet's resting height: down through the Layers row, so the two rows of
   *  buttons and the way to the list are one tap away before anything is dragged. */
  private peekHeightPx(): number {
    const fractionPx = Math.round(window.innerHeight * SHEET_PEEK_FRACTION);
    const lastRow = document.getElementById('interior-legend-head');
    if (!lastRow || lastRow.offsetHeight <= 0) return fractionPx;
    // offsetTop is measured from the panel, the positioned ancestor, and does
    // not move with the sheet's own scrolling: this is the unscrolled reach.
    const throughRowPx = lastRow.offsetTop + lastRow.offsetHeight + SHEET_PEEK_TAIL_PX;
    return Math.min(Math.max(fractionPx, throughRowPx), Math.round(window.innerHeight * SHEET_PEEK_MAX_FRACTION));
  }

  /** The sheet's ceiling: its own content — the grip and everything the page
   *  scrolls — capped at a fraction of the viewport, so a short page (a summary)
   *  never shows empty glass under its last row. */
  private fullHeightPx(): number {
    const scroll = document.getElementById('interior-scroll');
    if (!scroll) return this.peekHeightPx();
    const grip = document.getElementById('interior-grip');
    const contentPx = (grip?.offsetHeight ?? 0) + scroll.scrollHeight;
    return Math.max(this.peekHeightPx(), Math.min(Math.round(window.innerHeight * SHEET_FULL_FRACTION), contentPx));
  }

  /**
   * Set the sheet's height (px), clamped to what the sheet may be. A snap eases
   * the height in CSS and glides the body's framing with it; a drag transitions
   * nothing, so the sheet and the disc both stay under the finger. `bounds` is
   * a gesture's own measurement, kept so a move costs no layout.
   */
  private setSheetHeight(
    heightPx: number,
    options: { snap: boolean; bounds?: { peekPx: number; fullPx: number }; frameAtOnce?: boolean },
  ): void {
    const panel = document.getElementById('interior-panel');
    if (!panel || !isPhoneViewport()) return;
    const peekPx = options.bounds?.peekPx ?? this.peekHeightPx();
    const fullPx = Math.max(peekPx, options.bounds?.fullPx ?? this.fullHeightPx());
    const clampedPx = Math.round(Math.min(fullPx, Math.max(peekPx, heightPx)));
    panel.classList.toggle('snapping', options.snap && !this.reducedMotion.matches);
    this.sheetHeightPx = clampedPx;
    panel.style.setProperty('--sheet-h', `${clampedPx}px`);
    // The grip says where the sheet is: expanded only when it is at its ceiling.
    const grip = document.getElementById('interior-grip');
    if (grip) {
      const atFull = clampedPx >= fullPx - 1;
      grip.setAttribute('aria-expanded', String(atFull));
      grip.setAttribute('aria-label', atFull ? 'Shrink the panel' : 'Expand the panel');
      document.getElementById('interior-legend-head')?.setAttribute('aria-expanded', String(atFull));
    }
    this.applyViewportFraming(options.frameAtOnce === true);
    this.updateScrollCue();
  }

  /** A fresh entry: the sheet rests at its peek, with the body framed above it. */
  private resetSheetHeight(): void {
    this.sheetHeightBeforeInspectPx = null;
    if (!isPhoneViewport()) return;
    this.setSheetHeight(this.peekHeightPx(), { snap: false, frameAtOnce: true });
  }

  /** The panel's content is what sets the sheet's resting height — a body with
   *  rings has a taller footer — so a sheet still at rest follows the content
   *  when it turns over. One the reader has drawn taller stays where they put it. */
  private syncSheetToContent(): void {
    if (!isPhoneViewport() || this.sheetDrag !== null) return;
    const peekPx = this.peekHeightPx();
    if (this.sheetHeightPx <= peekPx) this.setSheetHeight(peekPx, { snap: true });
  }

  /** Leaving the inspector: the sheet goes back to the height the reader had. */
  private restoreSheetHeightAfterInspect(): void {
    const heightPx = this.sheetHeightBeforeInspectPx;
    this.sheetHeightBeforeInspectPx = null;
    if (heightPx === null || !isPhoneViewport()) return;
    this.setSheetHeight(heightPx, { snap: true });
  }

  /** The fade at the panel's bottom edge: only while there is more below it. */
  private updateScrollCue(): void {
    const scroll = document.getElementById('interior-scroll');
    if (!scroll) return;
    scroll.classList.toggle('can-scroll', scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop > 2);
  }

  // ---- hover, pin, emphasis --------------------------------------------------

  /** The nearest visible surface under a client-space point, or null off the body. */
  private pickAt(clientX: number, clientY: number): PickHit | null {
    const rect = this.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    tmpNdc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(tmpNdc, this.camera);
    return pickInterior(this.raycaster.ray.origin, this.raycaster.ray.direction, this.pickLayout, this.pickHit);
  }

  /** Depth below the surface at a display radius, km: through the inverse
   *  remap, so what the card says is physical whatever the Readable scale did. */
  private depthKmAtDisplay(radiusDisplay: number): number {
    const physical = this.remap ? toPhysicalFraction(this.remap, radiusDisplay) : radiusDisplay;
    return this.drawn.referenceRadiusKm * (1 - Math.min(1, Math.max(0, physical)));
  }

  private setHover(index: number, clientX: number, clientY: number, depthKm: number | null): void {
    if (index !== this.hoverIndex) {
      this.hoverIndex = index;
      this.syncLegendEmphasis();
    }
    const card = document.getElementById('interior-hover');
    if (!card) return;
    const region = index >= 0 ? this.drawn.regionsInsideOut[index] : undefined;
    if (!region || this.modalOpen()) {
      card.style.display = 'none';
      return;
    }
    renderHoverCard(card, region, depthKm);
    card.style.display = 'block';
    // Beside the pointer, kept inside the viewport.
    const x = Math.min(clientX + HOVER_CARD_OFFSET_PX, window.innerWidth - card.offsetWidth - 8);
    const y = Math.min(clientY + HOVER_CARD_OFFSET_PX, window.innerHeight - card.offsetHeight - 8);
    card.style.left = `${Math.max(8, x)}px`;
    card.style.top = `${Math.max(8, y)}px`;
  }

  private clearHover(): void {
    this.setHover(-1, 0, 0, null);
  }

  private setLegendHover(index: number): void {
    this.legendHoverIndex = index;
  }

  /** A tap or a row on a region selects it and opens its summary; the same
   *  region again keeps it, so a reader who taps twice is not bounced back to
   *  the list — the summary's own Layers row is the way out. */
  private togglePin(index: number): void {
    if (index === this.pinnedIndex && this.page.kind !== 'layers') return;
    this.setPinned(index);
  }

  /** Select a region (its summary opens) or none (back to the layers). */
  private setPinned(index: number): void {
    const region = this.drawn.regionsInsideOut[index];
    if (!region) {
      if (this.pinnedIndex < 0 && this.page.kind === 'layers') return;
      this.pinnedIndex = -1;
      this.page = { kind: 'layers' };
    } else {
      this.pinnedIndex = index;
      this.page = { kind: 'summary', regionKey: region.key };
    }
    this.clearHover();
    this.renderPage();
    this.syncLegendEmphasis();
  }

  /** Go to a page. A region page keeps that region selected (and emphasised). */
  private showPage(page: InteriorPanelPage): void {
    this.page = page;
    if (page.kind !== 'layers' && page.kind !== 'model') this.pinnedIndex = this.regionIndexFor(page.regionKey);
    this.clearHover();
    this.renderPage();
    this.syncLegendEmphasis();
  }

  private regionIndexFor(regionKey: string): number {
    return this.drawn.regionsInsideOut.findIndex((region) => region.key === regionKey);
  }

  /** The claim kind the evidence page shows, or null when it is not the page. */
  private evidenceKind(): ClaimKind | null {
    return this.page.kind === 'evidence' ? this.page.claimKind : null;
  }

  private modalOpen(): boolean {
    return this.picker.isOpen() || this.optionsOpen;
  }

  /** The page the panel shows, rendered into its host: the layer list, or one
   *  region's summary, details or evidence, or the model page. A region page
   *  whose region the drawn model no longer has falls back to the layers. On a
   *  phone a page opens the sheet to its own content — a summary is a short
   *  card, the details a reading height — and the layers get back the height
   *  and the scroll the reader left them at. */
  private renderPage(): void {
    const host = document.getElementById('interior-inspector');
    const layersPage = document.getElementById('interior-page-layers');
    const scroll = document.getElementById('interior-scroll');
    if (!host || !layersPage || !scroll) return;
    const page = this.page;
    const regionKey = page.kind === 'layers' || page.kind === 'model' ? null : page.regionKey;
    const regionIndex = regionKey === null ? -1 : this.regionIndexFor(regionKey);
    if (regionKey !== null && regionIndex < 0) {
      this.page = { kind: 'layers' };
      this.pinnedIndex = -1;
      this.renderPage();
      return;
    }
    if (page.kind === 'layers') {
      host.hidden = true;
      host.replaceChildren();
      delete host.dataset.page;
      layersPage.hidden = false;
      scroll.scrollTop = this.layersScrollTop;
      this.restoreSheetHeightAfterInspect();
      this.updateScrollCue();
      return;
    }
    if (!layersPage.hidden) this.layersScrollTop = scroll.scrollTop;
    const asked = renderPage(host, page, {
      drawn: this.drawn,
      coverage: this.coverage,
      unit: this.temperatureUnit,
      index: regionIndex,
      onLayers: () => this.setPinned(-1),
      onSummary: () => { if (regionKey !== null) this.showPage({ kind: 'summary', regionKey }); },
      onDetails: () => { if (regionKey !== null) this.showPage({ kind: 'details', regionKey }); },
      onEvidence: (claimKind) => { if (regionKey !== null) this.showPage({ kind: 'evidence', regionKey, claimKind }); },
      onModel: () => this.showPage({ kind: 'model' }),
    });
    layersPage.hidden = true;
    // Shown BEFORE the sheet is measured: a hidden page measures as nothing.
    host.hidden = false;
    if (isPhoneViewport()) {
      // The height the reader had is kept for when they come back to the layers.
      if (this.sheetHeightBeforeInspectPx === null) this.sheetHeightBeforeInspectPx = this.sheetHeightPx;
      this.setSheetHeight(this.fullHeightPx(), { snap: true });
    }
    scroll.scrollTop = 0;
    if (asked) asked.scrollIntoView({ block: 'start', behavior: this.reducedMotion.matches ? 'auto' : 'smooth' });
    this.updateScrollCue();
  }

  /** Nothing hovered, selected or open: a body or model change, or leaving. */
  private clearSelection(): void {
    this.page = { kind: 'layers' };
    this.pinnedIndex = -1;
    this.legendHoverIndex = -1;
    this.clearHover();
    this.renderPage();
    this.emphasis.index = -1;
    this.emphasis.amount = 0;
    this.interiorScene.setEmphasis(-1, 0);
  }

  private advanceEmphasis(dt: number): void {
    const target = emphasisTarget(this.legendHoverIndex, this.hoverIndex, this.pinnedIndex);
    const step = this.reducedMotion.matches ? 1 : dt / EMPHASIS_S;
    advanceEmphasis(this.emphasis, target, step);
    this.interiorScene.setEmphasis(this.emphasis.index, this.emphasis.amount);
  }

  /** The legend's rows follow the 3-D state: hot for the hovered region, pinned for the pinned one. */
  private syncLegendEmphasis(): void {
    const legend = document.getElementById('interior-legend');
    if (!legend) return;
    for (const row of legend.querySelectorAll<HTMLElement>('.interior-row')) {
      const index = Number(row.dataset.index);
      row.classList.toggle('hot', index === this.hoverIndex);
      row.classList.toggle('pinned', index === this.pinnedIndex);
    }
  }

  // Pointer: hover on a fine pointer; a tap pins and a drag orbits on any.
  // Every pointer's moves reach the recognizer, a touch's included: its travel
  // is what tells a drag from a tap, and only the hover is a fine pointer's.
  private handlePointerMove = (event: PointerEvent) => {
    if (!this.active) return;
    this.tap.move(pointerSample(event));
    if (event.pointerType === 'touch') return;
    if (this.tap.dragging()) {
      this.clearHover(); // dragging the orbit
      return;
    }
    const hit = this.pickAt(event.clientX, event.clientY);
    if (hit && hit.surface !== 'skin') {
      this.setHover(hit.regionIndex, event.clientX, event.clientY, this.depthKmAtDisplay(hit.radiusDisplay));
    } else {
      this.clearHover();
    }
  };

  private handlePointerDown = (event: PointerEvent) => {
    if (!this.active) return;
    this.tap.down(pointerSample(event), event.pointerType !== 'mouse' || event.button === 0);
  };

  private handlePointerCancel = (event: PointerEvent) => {
    this.tap.cancel(event.pointerId);
  };

  private handleBlur = () => {
    this.tap.reset();
  };

  private handlePointerUp = (event: PointerEvent) => {
    if (!this.active) return;
    if (!this.tap.up(pointerSample(event))) return;
    if (this.modalOpen()) return;
    const hit = this.pickAt(event.clientX, event.clientY);
    if (hit && hit.surface !== 'skin') this.togglePin(hit.regionIndex);
    else this.setPinned(-1);
  };

  private handlePointerLeave = () => {
    this.clearHover();
  };

  /** The model switch under the caption: competing models by title, or a
   *  poorly constrained body's unresolved whole and its illustrative scenario. */
  private renderModelSwitch(): void {
    const root = document.getElementById('interior-models');
    const kicker = document.getElementById('interior-models-kicker');
    if (!root || !kicker) return;
    root.replaceChildren();
    const choices: { modelId: string | null; label: string }[] = [];
    let noteText = '';
    let kickerText = '';
    if (this.coverage.state === 'competing') {
      for (const model of coverageModels(this.coverage)) choices.push({ modelId: model.modelId, label: model.title });
      noteText = this.coverage.distinguishedBy;
      kickerText = `${coverageBadge(this.coverage)} fit the data`;
    } else if (this.coverage.state === 'poorlyConstrained' && this.coverage.illustrative) {
      choices.push({ modelId: null, label: STRUCTURE_UNCERTAIN });
      choices.push({ modelId: this.coverage.illustrative.modelId, label: `${this.coverage.illustrative.title} (illustrative)` });
      noteText = this.drawn.illustrative ? ILLUSTRATIVE_NOTE : '';
      kickerText = INTERIOR_MODEL;
    }
    kicker.textContent = kickerText;
    kicker.style.display = choices.length > 0 ? '' : 'none';
    root.style.display = choices.length > 0 ? '' : 'none';
    for (const choice of choices) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'interior-view interior-model' + (choice.modelId === this.drawn.modelId ? ' on' : '');
      button.textContent = choice.label;
      button.dataset.modelId = choice.modelId ?? '';
      button.addEventListener('click', () => this.selectModel(choice.modelId));
      root.append(button);
    }
    this.modelsNoteText = noteText;
    this.syncModelsNote();
  }

  /** The model note: one line with "more" until the reader asks for the rest. */
  private syncModelsNote(): void {
    const note = document.getElementById('interior-models-note');
    const text = document.getElementById('interior-models-note-text');
    const more = document.getElementById('interior-models-more');
    if (!note || !text || !more) return;
    text.textContent = this.modelsNoteText;
    note.style.display = this.modelsNoteText ? '' : 'none';
    note.classList.toggle('collapsed', !this.modelsNoteExpanded);
    more.textContent = this.modelsNoteExpanded ? 'less' : 'more';
    more.setAttribute('aria-expanded', String(this.modelsNoteExpanded));
    this.updateScrollCue();
  }

  /** Temperature mode's key: the body's scale with its range, and the hatch. */
  private renderScale(): void {
    const scale = document.getElementById('interior-scale');
    if (!scale) return;
    const range = this.temperatureRange;
    if (this.displayMode !== 'temperature' || !range) {
      scale.style.display = 'none';
      return;
    }
    const bar = document.getElementById('interior-scale-bar');
    if (bar) bar.style.background = temperatureScaleGradientCss();
    const min = document.getElementById('interior-scale-min');
    const max = document.getElementById('interior-scale-max');
    const mid = scale.querySelector('.interior-scale-mid');
    if (min) min.textContent = temperatureValueText(range.minK, this.temperatureUnit);
    if (max) max.textContent = temperatureValueText(range.maxK, this.temperatureUnit);
    if (mid) mid.textContent = range.log ? 'Temperature (log scale)' : 'Temperature';
    // The band key line, only where a boundary is drawn with a band.
    const bandNote = document.getElementById('interior-band-note');
    if (bandNote) {
      const banded = this.drawn.regionsInsideOut.some((region) => {
        const kind = region.region?.boundary.knowledge.location?.kind;
        return kind === 'interval' || kind === 'modelSpread';
      });
      bandNote.style.display = banded ? '' : 'none';
    }
    scale.style.display = '';
  }

  private syncViewButtons(): void {
    const current = cutViewForAngle(this.cut.toDeg);
    for (const view of CUT_VIEWS) setRadio(`interior-view-${view}`, view === current);
  }

  private syncAngleReadout(): void {
    const slider = document.getElementById('interior-angle') as HTMLInputElement | null;
    if (slider && document.activeElement !== slider) slider.value = String(Math.round(this.cut.angleDeg));
    const readout = document.getElementById('interior-angle-value');
    if (readout) readout.textContent = `${Math.round(this.cut.angleDeg)}°`;
  }

  /** The Esc cascade: the view options, the picker, a page back to its region's
   *  summary (the model page back to the layers), the selection, then the tool
   *  itself. The event is spent here, so the app behind hears no Escape. */
  private handleKeyDown = (event: KeyboardEvent) => {
    if (!this.active) return;
    if (event.key !== 'Escape') return;
    event.preventDefault();
    this.escapeOnce();
  };

  /** One step of the Esc cascade. */
  private escapeOnce(): void {
    if (this.optionsOpen) {
      this.closeOptions();
      return;
    }
    if (this.picker.isOpen()) {
      this.picker.close();
      return;
    }
    const page = this.page;
    if (page.kind === 'details' || page.kind === 'evidence') {
      this.showPage({ kind: 'summary', regionKey: page.regionKey });
      return;
    }
    if (page.kind === 'model' || this.pinnedIndex >= 0) {
      this.setPinned(-1);
      return;
    }
    this.requestExit();
  }

  private openPicker(): void {
    if (!this.active) return;
    this.closeOptions(); // one modal at a time
    this.clearHover();
    this.picker.open();
    this.setBackgroundInert(true);
  }

  /** The view options card: a modal, so it and the picker close each other and
   *  the panel and the strip go inert under it; focus goes back to its opener. */
  private openOptions(opener: HTMLElement | null): void {
    if (!this.active || this.optionsOpen) return;
    this.picker.close();
    this.optionsOpen = true;
    this.optionsOpener = opener;
    this.clearHover();
    document.getElementById('interior-options')?.classList.add('visible');
    this.setBackgroundInert(true);
    (document.getElementById('interior-options-close') as HTMLElement | null)?.focus();
  }

  private closeOptions(): void {
    if (!this.optionsOpen) return;
    this.optionsOpen = false;
    document.getElementById('interior-options')?.classList.remove('visible');
    this.setBackgroundInert(false);
    const opener = this.optionsOpener;
    this.optionsOpener = null;
    if (opener && opener.isConnected) opener.focus();
  }

  /** Under a modal the panel and the strip take no focus and no clicks. */
  private setBackgroundInert(inert: boolean): void {
    for (const id of ['interior-panel', 'interior-top']) {
      document.getElementById(id)?.toggleAttribute('inert', inert);
    }
  }

  // ---- camera ----------------------------------------------------------------

  private frameInitial(): void {
    this.controls.target.copy(ORIGIN);
    this.camera.up.set(0, 1, 0);
    // Posed at the fit for the stage as it is now; the offset follows from that pose.
    const fit = this.fitFor(this.stageRect());
    this.fitDistanceNow = fit;
    this.distanceTargetNow = 0;
    this.distanceSpan = 0;
    orbitPose(FRAMING.azimuthDeg, FRAMING.elevationDeg, fit, this.camera.position);
    this.controls.update();
    this.applyViewportFraming(true);
  }

  /** The rectangle the body may occupy: the viewport less the strip along the
   *  top and the sheet (phones) or the side panel (desktop), with air around it. */
  private stageRect(): StageRect {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const strip = document.getElementById('interior-top');
    const top = strip ? Math.max(0, Math.round(strip.getBoundingClientRect().bottom)) : 0;
    const obstacles = { top, bottom: 0, left: 0, right: 0 };
    if (isPhoneViewport()) {
      if (this.sheetHeightPx <= 0) this.sheetHeightPx = this.peekHeightPx();
      obstacles.bottom = this.sheetHeightPx + SHEET_BOTTOM_MARGIN_PX;
    } else {
      const panel = document.getElementById('interior-panel');
      obstacles.right = panel ? Math.max(0, Math.round(width - panel.getBoundingClientRect().left)) : 0;
    }
    const minSize = Math.round(FRAMING.stageMinFraction * Math.min(width, height));
    return visibleStageRect(width, height, obstacles, FRAMING.stageMarginPx, minSize);
  }

  /** The distance that fits the body — its rings included when they show — to the stage. */
  private fitFor(stage: StageRect): number {
    const fit = fitDistance(stage, window.innerHeight, this.camera.fov, this.interiorScene.boundRadius(), FRAMING.fill);
    return Number.isFinite(fit) ? THREE.MathUtils.clamp(fit, FRAMING.minDistance, FRAMING.maxDistance) : FRAMING.maxDistance;
  }

  /** The framing for the stage as it is now: the body fitted to it, keeping the
   *  zoom the reader had relative to the last fit, and centred in it. On a phone
   *  the distance and the shift glide with a sheet snap and stick to a finger on
   *  the grip; on desktop the x lands at once, since the panel does not move. */
  private applyViewportFraming(atOnce = false): void {
    const stage = this.stageRect();
    const fit = this.fitFor(stage);
    const current = this.camera.position.distanceTo(ORIGIN);
    const ratio = this.fitDistanceNow > 0 && current > 0
      ? zoomRatio(current, this.fitDistanceNow, FRAMING.minDistance / fit, FRAMING.maxDistance / fit)
      : 1;
    this.fitDistanceNow = fit;
    const distance = THREE.MathUtils.clamp(fit * ratio, FRAMING.minDistance, FRAMING.maxDistance);
    const immediate = atOnce || this.reducedMotion.matches || this.sheetDrag !== null;
    if (immediate) {
      this.distanceTargetNow = 0;
      this.setCameraDistance(distance);
    } else {
      this.distanceTargetNow = distance;
      this.distanceSpan = Math.abs(distance - current);
    }
    const offset = stageViewOffset(stage, window.innerWidth, window.innerHeight);
    this.setViewOffsetTarget(offset.x, offset.y, atOnce);
  }

  /** Move the camera along its own line of sight to a distance from the body. */
  private setCameraDistance(distance: number): void {
    const current = this.camera.position.distanceTo(ORIGIN);
    if (current <= 0 || Math.abs(current - distance) < 1e-6) return;
    this.camera.position.multiplyScalar(distance / current);
  }

  /** Ask for a projection offset. The x lands at once — the desktop panel does
   *  not move under the reader — and the y glides, so the body follows the
   *  sheet's snap instead of jumping with it. A finger on the grip, reduced
   *  motion and a fresh entry all take the offset at once. */
  private setViewOffsetTarget(xPx: number, yPx: number, atOnce: boolean): void {
    this.viewOffsetXPx = xPx;
    this.viewOffsetYTargetPx = yPx;
    if (atOnce || this.reducedMotion.matches || this.sheetDrag !== null) {
      this.viewOffsetYPx = yPx;
      this.viewOffsetSpanPx = 0;
    } else {
      this.viewOffsetSpanPx = Math.abs(yPx - this.viewOffsetYPx);
    }
    this.applyViewOffset();
  }

  /** Put the offset the camera holds this frame onto its projection. */
  private applyViewOffset(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const x = Math.round(this.viewOffsetXPx);
    const y = Math.round(this.viewOffsetYPx);
    if (x === 0 && y === 0) this.camera.clearViewOffset();
    else this.camera.setViewOffset(width, height, x, y, width, height);
    this.camera.updateProjectionMatrix();
  }

  /** The framing's glide: the applied shift steps toward its target over
   *  SHEET_SNAP_S, so a sheet snap and the body's move read as one gesture. */
  private advanceViewShift(dt: number): void {
    // The distance's glide, at the shift's pace; landed, the reader's own zoom is theirs again.
    if (this.distanceTargetNow > 0) {
      const current = this.camera.position.distanceTo(ORIGIN);
      const remaining = Math.abs(this.distanceTargetNow - current);
      if (remaining < 1e-6) {
        this.distanceTargetNow = 0;
      } else {
        const step = this.distanceSpan > 0 ? (this.distanceSpan * dt) / SHEET_SNAP_S : remaining;
        this.setCameraDistance(stepToward(current, this.distanceTargetNow, step));
      }
    }
    if (this.viewOffsetYPx === this.viewOffsetYTargetPx) return;
    const remainingPx = Math.abs(this.viewOffsetYTargetPx - this.viewOffsetYPx);
    const stepPx = this.viewOffsetSpanPx > 0 ? (this.viewOffsetSpanPx * dt) / SHEET_SNAP_S : remainingPx;
    this.viewOffsetYPx = stepToward(this.viewOffsetYPx, this.viewOffsetYTargetPx, stepPx);
    this.applyViewOffset();
  }

  onResize(aspect: number): void {
    this.camera.aspect = aspect;
    // The reader's sheet height survives a rotation, re-clamped to the new viewport.
    if (isPhoneViewport()) this.setSheetHeight(this.sheetHeightPx > 0 ? this.sheetHeightPx : this.peekHeightPx(), { snap: false, frameAtOnce: true });
    else this.applyViewportFraming(true);
    this.interiorScene.onResize();
    this.renderPage(); // the page's host rules follow the breakpoint
  }

  // ---- dev bridge (DEV-only via window.__moon) -----------------------------

  devExit(): void {
    this.requestExit();
  }

  devPick(bodyId: string): boolean {
    if (!this.active) return false;
    this.picker.close();
    void this.commitBody(bodyId);
    return true;
  }

  devPickerOpen(): boolean {
    if (!this.active) return false;
    this.openPicker();
    return this.picker.isOpen();
  }

  devEsc(): void {
    this.escapeOnce();
  }

  devView(view: CutView): boolean {
    if (!this.active || !CUT_VIEWS.includes(view)) return false;
    this.setView(view);
    return true;
  }

  devAngle(deg: number, animate = false): boolean {
    if (!this.active || !Number.isFinite(deg)) return false;
    this.setTargetAngle(deg, animate);
    return true;
  }

  devScale(mode: 'true' | 'readable', blend?: number): boolean {
    if (!this.active) return false;
    this.setReadable(mode === 'readable');
    if (blend !== undefined && Number.isFinite(blend)) {
      this.scaleBlend = THREE.MathUtils.clamp(blend, 0, 1);
      this.scaleBlendTarget = this.scaleBlend;
    } else {
      this.scaleBlend = this.scaleBlendTarget;
    }
    return true;
  }

  devTime(seconds: number): boolean {
    if (!this.active || !Number.isFinite(seconds)) return false;
    this.presentationSeconds = seconds;
    return true;
  }

  devFreeze(on: boolean): boolean {
    if (!this.active) return false;
    this.frozen = on;
    return true;
  }

  devOrbit(azimuthDeg: number, elevationDeg: number = FRAMING.elevationDeg, distance?: number): boolean {
    if (!this.active) return false;
    const current = distance ?? this.camera.position.distanceTo(this.controls.target);
    orbitPose(azimuthDeg, elevationDeg, current, this.camera.position);
    this.controls.update();
    return true;
  }

  /** True only once the map is applied (the real one, not the loader's
   *  fallback with the real one still to come), the regions are on the faces,
   *  and the cut and the Readable morph have settled. */
  devReady(): boolean {
    return this.active
      && !this.loading
      && this.remap !== null
      && !this.interiorScene.isFading()
      && !this.interiorScene.awaitingLateMap()
      && cutTweenSettled(this.cut)
      && this.scaleBlend === this.scaleBlendTarget;
  }

  /** Draw a named model of the current body (a competing alternative, or a
   *  poorly constrained body's illustrative scenario), or null for the unresolved whole. */
  devModel(modelId: string | null): boolean {
    if (!this.active) return false;
    return this.selectModel(modelId);
  }

  devRings(on: boolean): boolean {
    if (!this.active) return false;
    this.setRings(on);
    return true;
  }

  devDisplayMode(mode: InteriorDisplayMode): boolean {
    if (!this.active || (mode !== 'composition' && mode !== 'temperature')) return false;
    this.setDisplayMode(mode);
    return true;
  }

  /** Pick at client coordinates and hover what is there, as the pointer would. */
  devHover(x: number, y: number): InteriorDevHover | null {
    if (!this.active) return null;
    const hit = this.pickAt(x, y);
    if (!hit) {
      this.clearHover();
      return null;
    }
    const region = this.drawn.regionsInsideOut[hit.regionIndex];
    if (!region) {
      // The pick layout and the drawn model are refreshed together; a hit past the model is nothing to hover.
      this.clearHover();
      return null;
    }
    const depthKm = hit.surface === 'skin' ? null : this.depthKmAtDisplay(hit.radiusDisplay);
    if (hit.surface !== 'skin') this.setHover(hit.regionIndex, x, y, depthKm);
    else this.clearHover();
    return { surface: hit.surface, regionKey: region.key, depthKm };
  }

  /** Pin a region by key (null unpins). */
  devPin(regionKey: string | null): boolean {
    if (!this.active) return false;
    if (regionKey === null) {
      this.setPinned(-1);
      return true;
    }
    const index = this.drawn.regionsInsideOut.findIndex((region) => region.key === regionKey);
    if (index < 0) return false;
    this.setPinned(index);
    return true;
  }

  /** Open the pinned region's claim of a kind in the popover (null closes it). */
  devEvidence(claimKind: ClaimKind | null): boolean {
    if (!this.active) return false;
    const region = this.drawn.regionsInsideOut[this.pinnedIndex];
    if (!region) return false;
    if (claimKind === null) {
      if (this.page.kind === 'evidence') this.showPage({ kind: 'summary', regionKey: region.key });
      return true;
    }
    if (!region.region?.claims.some((claim) => claim.kind === claimKind)) return false;
    this.showPage({ kind: 'evidence', regionKey: region.key, claimKind });
    return true;
  }

  /** Headless support: go to a page of the panel (a region page needs a selection). */
  devPage(kind: InteriorPanelPage['kind']): boolean {
    if (!this.active) return false;
    if (kind === 'layers') {
      this.setPinned(-1);
      return true;
    }
    if (kind === 'model') {
      this.showPage({ kind: 'model' });
      return true;
    }
    const region = this.drawn.regionsInsideOut[this.pinnedIndex];
    if (!region) return false;
    if (kind === 'evidence') this.showPage({ kind: 'evidence', regionKey: region.key, claimKind: null });
    else this.showPage({ kind, regionKey: region.key });
    return true;
  }

  devUnit(unit: TemperatureUnit): boolean {
    if (!this.active || (unit !== 'kelvin' && unit !== 'celsius')) return false;
    this.setUnit(unit);
    return true;
  }

  /** Headless support: put the view options up. */
  devOptionsOpen(): boolean {
    if (!this.active) return false;
    this.openOptions(document.getElementById('interior-options-open'));
    return this.optionsOpen;
  }

  devState(): InteriorDevState {
    const fractions = outerFractionsInsideOut(this.drawn);
    const regionsInsideOut = this.drawn.regionsInsideOut;
    return {
      bodyId: this.body?.id ?? '',
      modelId: this.drawn.modelId,
      coverage: this.coverage.state,
      illustrative: this.drawn.illustrative,
      displayMode: this.displayMode,
      temperatureRange: this.temperatureRange,
      rings: this.interiorScene.hasRings() ? this.ringsOn : null,
      view: cutViewForAngle(this.cut.angleDeg),
      openingAngleDeg: this.cut.angleDeg,
      targetAngleDeg: this.cut.toDeg,
      readable: this.readable,
      scaleBlend: this.scaleBlend,
      projectedRadiusPx: this.projectedPx,
      viewOffset: { x: this.viewOffsetXPx, y: this.viewOffsetYPx },
      presentationSeconds: this.presentationSeconds,
      frozen: this.frozen,
      loading: this.loading,
      skin: this.interiorScene.hasSkin(),
      ready: this.devReady(),
      fps: this.avgFps(),
      regions: regionsInsideOut.map((region, index) => ({
        key: region.key,
        name: region.name,
        outerKm: region.outerRadiusKm,
        displayOuter: this.remap ? toDisplayFraction(this.remap, fractions[index]) : fractions[index],
      })),
      hover: regionsInsideOut[this.hoverIndex]?.key ?? null,
      pinned: regionsInsideOut[this.pinnedIndex]?.key ?? null,
      evidence: this.evidenceKind(),
      page: this.page.kind,
      unit: this.temperatureUnit,
      optionsOpen: this.optionsOpen,
      emphasis: { region: regionsInsideOut[this.emphasis.index]?.key ?? null, amount: this.emphasis.amount },
      timings: { ...this.openStopwatch.timings },
    };
  }

  private avgFps(): number {
    if (this.fpsSamples.length === 0) return 0;
    let sum = 0;
    for (const sample of this.fpsSamples) sum += sample;
    return sum / this.fpsSamples.length;
  }
}

/** The recognizer's reading of a pointer event: its id, its client point and its own clock. */
function pointerSample(event: PointerEvent): PointerSample {
  return { pointerId: event.pointerId, x: event.clientX, y: event.clientY, timeMs: event.timeStamp };
}
