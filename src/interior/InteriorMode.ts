/**
 * Mode controller for the Look-inside tool. Owns the camera, its
 * OrbitControls, the DOM (the panel: body chip, caption, the three views,
 * the opening-angle slider, a legend and the Readable toggle), the
 * presentation clock and the cut animation; InteriorScene owns the studio
 * content. The mode maps the pure modules — cutFrame for where the cut is,
 * interiorGeometry for the Readable remap, drawnModel for the model's
 * regions — onto the scene's per-frame uniforms.
 *
 * What is drawn comes from the registry (data/interiorRegistry): a
 * constrained body draws its model, a competing body its default (the
 * others switchable from the model switch under the caption), a poorly
 * constrained or not yet modelled body draws an unresolved whole with its
 * bulk line — an illustrative scenario only on request, and labelled.
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
 * Hover and pin (plan §4): a pointer ray is picked on the CPU against the
 * terraced cut (interiorPick, the same frame and remap the shaders use);
 * the region under it is emphasised through two uniforms and its legend
 * row lights; a hover card previews it; a tap or click pins the inspector
 * (ui/LayerInspector), whose claim rows open the evidence popover
 * (ui/EvidencePopover). Hovering a legend row emphasises the region in 3D.
 * On touch a tap pins and a drag orbits. The Esc cascade: the popover, the
 * picker, the pinned inspector, then the tool itself.
 *
 * Two diagrams (plan §5): Composition, the material key, and Temperature,
 * the body's own scale with a hatch for what nobody knows; the legend's
 * swatches follow the mode so the key and the face never disagree. A body
 * with competing models, or a poorly constrained one with an illustrative
 * scenario, gets a model switch under its caption.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DEG2RAD } from '../shared/math/angles';
import { isPhoneViewport } from '../shared/dom';
import { debugLog, debugWarn } from '../shared/debug';
import { bodyDisplayName } from '../planetarium/surfaceView';
import { InteriorScene, BODY_RADIUS, TERRACE_STEP, type PreparedSkin } from './InteriorScene';
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
  captionFor,
  createCutTween,
  createEmphasisState,
  cutTweenSettled,
  emphasisTarget,
  regionArtInsideOut,
  regionLooks,
  setCutTarget,
  stepToward,
  unresolvedComposition,
} from './interiorLogic';
import { formatKm, formatNumber } from './ui/inspectorText';
import {
  IDENTITY_REMAP,
  READABLE_MIN_PX,
  framingDistance,
  minDisplayFraction,
  projectedRadiusPx,
  readableRemap,
  toDisplayFraction,
  toPhysicalFraction,
  type ReadableRemap,
} from './interiorGeometry';
import { createPickHit, pickInterior, type PickHit, type PickLayout, type PickSurface } from './interiorPick';
import { renderHoverCard, renderInspector } from './ui/LayerInspector';
import { DepthRuler } from './ui/DepthRuler';
import { createRulerLayout, rulerLayout, rulerSide, type RulerInput } from './ruler';
import { renderEvidencePopover } from './ui/EvidencePopover';
import { INTERIOR_DEFAULT_BODY, coverageBadge, coverageFor, defaultModelFor, modelFor } from './data/interiorRegistry';
import { coverageModels } from './data/interiorTypes';
import {
  bodyTemperatureRange,
  temperatureScaleGradientCss,
  temperatureScaleHex,
  temperatureT,
  type TemperatureRange,
} from './temperatureScale';
import { buildMeter, claimScores } from './ui/LayerInspector';
import { coverageBulk, type ClaimKind, type Coverage, type CoverageState } from './data/interiorTypes';
import { drawnFromModel, drawnUnresolved, outerFractionsInsideOut, type DrawnModel } from './drawnModel';
import { BodyPicker } from '../planetarium/ui/BodyPicker';
import { incandescence, swatchHex } from './data/artParams';

const FRAMING = {
  fovDeg: 40,
  /** Start orbit: a gentle elevation and an azimuth a little off the key. */
  elevationDeg: 16,
  azimuthDeg: -28,
  minDistance: 1.55,
  maxDistance: 9,
  dampingFactor: 0.06,
  /** Phones: the legend is a bottom sheet, so the body sits in the upper part
   *  of the viewport — a projection offset (screen space, orbit-independent)
   *  of this fraction of the height, and the disc fits the width less. */
  phoneViewShiftFraction: 0.17,
  phoneWidthFraction: 0.84,
} as const;

/** A body swap cross-fades the skin over this long, behind the closed cut. */
const SWAP_FADE_S = 0.45;
/** The reveal's exterior ghost starts this opaque and clears as the cut opens. */
const GHOST_OPACITY = 0.32;
/** The wedge is turned this far off the view axis, so the viewer looks at
 *  its near face and along its terraces rather than straight into the crease. */
const WEDGE_YAW_DEG = 22;
/** The Readable blend eases over this long. */
const SCALE_BLEND_S = 0.5;
const FPS_WINDOW = 60;
/** Recompute the remap when the projected radius moves this much. */
const REMAP_PX_TOLERANCE = 0.5;
/** A press that moves less than this (px) and ends within this (ms) is a tap, not a drag. */
const TAP_MAX_PX = 8;
const TAP_MAX_MS = 400;
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
  emphasis: { region: string | null; amount: number };
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

export class InteriorMode {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly interiorScene: InteriorScene;
  private readonly controls: OrbitControls;
  private readonly isMultisampled: () => boolean;
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

  // The Readable scale.
  private readable = true;
  private scaleBlend = 1;
  private scaleBlendTarget = 1;
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
  /** The claim index open in the popover, −1 when closed. */
  private evidenceClaim = -1;
  private tapStart: { x: number; y: number; t: number } | null = null;
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  /** The cut is opening onto a freshly presented body: the ghost lingers over the opening. */
  private revealing = false;
  private cutSettledResolvers: (() => void)[] = [];

  private readonly fpsSamples: number[] = [];
  private topBarPrevDisplay: string | null = null;

  constructor(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    renderer: THREE.WebGLRenderer,
    floatCapable: boolean,
    isMultisampled: () => boolean,
  ) {
    this.camera = camera;
    this.isMultisampled = isMultisampled;
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
        strong.textContent = 'Look inside';
        title.append(strong, document.createTextNode(' another world'));
      },
      rowBadge: (name) => {
        const pill = document.createElement('span');
        const coverage = coverageFor(name);
        const drawnByDefault = coverage.state === 'constrained' || coverage.state === 'competing';
        pill.className = 'pk-tag-cover' + (drawnByDefault ? ' on' : '');
        pill.textContent = coverageBadge(coverage);
        return pill;
      },
      onPick: (name) => {
        this.picker.close();
        void this.commitBody(name);
      },
      onClose: () => {},
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
    this.domElement.addEventListener('pointercancel', this.clearTap);
    this.domElement.addEventListener('pointerleave', this.handlePointerLeave);
    window.addEventListener('blur', this.clearTap);
    this.fpsSamples.length = 0;
    this.presentationSeconds = 0;
    this.frozen = false;

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
    this.ruler.hide();
    const ui = document.getElementById('interior-ui');
    if (ui) ui.style.display = 'none';
    this.controls.enabled = false;
    window.removeEventListener('keydown', this.handleKeyDown);
    this.domElement.removeEventListener('pointermove', this.handlePointerMove);
    this.domElement.removeEventListener('pointerdown', this.handlePointerDown);
    this.domElement.removeEventListener('pointerup', this.handlePointerUp);
    this.domElement.removeEventListener('pointercancel', this.clearTap);
    this.domElement.removeEventListener('pointerleave', this.handlePointerLeave);
    window.removeEventListener('blur', this.clearTap);
    this.clearTap();
    this.clearSelection();
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

  update(dt: number): void {
    if (!this.active) return;
    if (dt > 0) {
      this.fpsSamples.push(1 / dt);
      if (this.fpsSamples.length > FPS_WINDOW) this.fpsSamples.shift();
    }
    if (!this.frozen) this.presentationSeconds += dt;
    this.interiorScene.setPresentationTime(this.presentationSeconds);

    this.advanceCut(dt);
    this.advanceScale(dt);
    this.interiorScene.advance(dt);
    this.controls.update();

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
    // The wedge yaw tapers to none at Section, so the disc is face-on there.
    yawCutFrame(this.frame, wedgeYawForOpening(this.frame.openingAngle, WEDGE_YAW_DEG * DEG2RAD));
    this.interiorScene.applyCut(this.frame);
    this.interiorScene.updateForCamera(this.camera);

    this.advanceEmphasis(dt);
    this.renderRuler();
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
    const note = document.getElementById('interior-readable-note');
    if (note) note.style.display = on ? '' : 'none';
  }

  // ---- body ------------------------------------------------------------------

  /**
   * Bring a body in. The first body of a session loads under the veil with
   * the cut closed and is presented at once; a swap is the ceremony of plan
   * §4: the cut closes over the old body while the new map loads, the skin
   * cross-fades behind the closed cut once both are done, the panel turns
   * over, and the cut reopens onto the new body with the exterior ghost.
   * Either way the commit reveals onto what it presented. Nothing
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
      prepared = await this.interiorScene.prepareBody(body, stale);
      if (!prepared || stale()) return false;
      if (swap) {
        await this.cutSettled();
        if (stale()) return false;
      }
      // The swap moment, behind the closed cut: the pose and the skin first
      // (the steps that can throw, and a throw there leaves the old body
      // whole), then the faces and the panel turn over.
      this.interiorScene.setPose(body, this.utcMs);
      this.interiorScene.presentBody(prepared, swap && animate ? SWAP_FADE_S : 0);
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
      }
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
  }

  /** The rings row shows only for a body that has rings. */
  private syncRingsRow(): void {
    const row = document.getElementById('interior-rings-row');
    if (row) row.style.display = this.interiorScene.hasRings() ? '' : 'none';
  }

  private setDisplayMode(mode: InteriorDisplayMode): void {
    this.displayMode = mode;
    this.interiorScene.setDisplayMode(mode === 'temperature' ? 1 : 0);
    document.getElementById('interior-mode-composition')?.classList.toggle('on', mode === 'composition');
    document.getElementById('interior-mode-temperature')?.classList.toggle('on', mode === 'temperature');
    this.renderPanel();
  }

  // ---- DOM -------------------------------------------------------------------

  private bindPanel(): void {
    document.getElementById('interior-leave')?.addEventListener('click', () => this.requestExit());
    document.getElementById('interior-body-chip')?.addEventListener('click', () => this.openPicker());
    for (const view of CUT_VIEWS) {
      document.getElementById(`interior-view-${view}`)?.addEventListener('click', () => this.setView(view));
    }
    const slider = document.getElementById('interior-angle') as HTMLInputElement | null;
    slider?.addEventListener('input', () => {
      this.setTargetAngle(Number(slider.value), false);
    });
    const toggle = document.getElementById('interior-readable-toggle') as HTMLInputElement | null;
    toggle?.addEventListener('change', () => this.setReadable(toggle.checked));
    const rings = document.getElementById('interior-rings-toggle') as HTMLInputElement | null;
    rings?.addEventListener('change', () => this.setRings(rings.checked));
    document.getElementById('interior-mode-composition')?.addEventListener('click', () => this.setDisplayMode('composition'));
    document.getElementById('interior-mode-temperature')?.addEventListener('click', () => this.setDisplayMode('temperature'));
    // The popover's backdrop closes it; the card's own close button too.
    document.getElementById('interior-evidence')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) this.closeEvidence();
    });
  }

  private renderPanel(reveal = false): void {
    const body = this.body;
    const name = document.getElementById('interior-body-name');
    if (name && body) {
      const display = bodyDisplayName(body.id);
      name.textContent = display.charAt(0).toUpperCase() + display.slice(1);
    }
    const caption = document.getElementById('interior-caption');
    if (caption) caption.textContent = captionFor(this.coverage, this.drawn);
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
      legend.classList.toggle('reveal', reveal && !this.reducedMotion.matches);
      const art = regionArtInsideOut(this.drawn);
      const scores = this.drawn.regionsInsideOut.map((_, index) => claimScores({ drawn: this.drawn, index, coverage: this.coverage }));
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
        if (!temperature) {
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
        detail.textContent = region.composition;
        text.append(title, detail);
        const depth = document.createElement('div');
        depth.className = 'interior-row-depth';
        depth.textContent = `${formatKm(depthTop)}–${formatKm(depthBottom)} km`;
        row.append(swatch, text, depth);
        // The existence claim's meter with its level word (plan §4).
        const existence = region.region?.claims.findIndex((claim) => claim.kind === 'existence') ?? -1;
        if (existence >= 0) {
          const meter = document.createElement('div');
          meter.className = 'interior-row-meter';
          meter.append(buildMeter(scores[index][existence]));
          row.append(meter);
        }
        legend.append(row);
      }
    }
    this.renderScale();
    this.syncLegendEmphasis();
    this.renderPinned();
    this.syncViewButtons();
    this.syncAngleReadout();
    this.setReadable(this.readable);
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
    if (!region || this.picker.isOpen() || this.evidenceClaim >= 0) {
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

  private togglePin(index: number): void {
    this.setPinned(this.pinnedIndex === index ? -1 : index);
  }

  private setPinned(index: number): void {
    if (index === this.pinnedIndex) return;
    this.pinnedIndex = index;
    this.closeEvidence();
    this.renderPinned();
    this.syncLegendEmphasis();
  }

  /** The inspector for the pinned region: its own panel on desktop, docked
   *  under the legend in the sheet on phones. Hidden when nothing is pinned. */
  private renderPinned(): void {
    const root = document.getElementById('interior-inspector');
    if (!root) return;
    const index = this.pinnedIndex;
    if (index < 0 || index >= this.drawn.regionsInsideOut.length) {
      root.style.display = 'none';
      root.replaceChildren();
      return;
    }
    const phone = isPhoneViewport();
    const host = document.getElementById(phone ? 'interior-panel' : 'interior-ui');
    if (host && root.parentElement !== host) host.append(root);
    root.classList.toggle('docked', phone);
    renderInspector(root, {
      drawn: this.drawn,
      index,
      coverage: this.coverage,
      onEvidence: (claimIndex) => this.openEvidence(claimIndex),
      onClose: () => this.setPinned(-1),
    });
    root.style.display = '';
    root.scrollTop = 0;
    // In the sheet the inspector sits under the legend: bring it into view.
    if (phone && host) host.scrollTop = Math.max(0, root.offsetTop - 8);
  }

  private openEvidence(claimIndex: number): void {
    const region = this.drawn.regionsInsideOut[this.pinnedIndex];
    const claim = region?.region?.claims[claimIndex];
    const root = document.getElementById('interior-evidence');
    const card = document.getElementById('interior-evidence-card');
    if (!region || !claim || !root || !card) return;
    const scores = claimScores({ drawn: this.drawn, index: this.pinnedIndex, coverage: this.coverage });
    this.picker.close(); // one modal at a time
    this.evidenceClaim = claimIndex;
    renderEvidencePopover(card, { regionName: region.name, claim, score: scores[claimIndex], onClose: () => this.closeEvidence() });
    root.classList.add('visible');
    this.clearHover();
    (card.querySelector('.pk-x') as HTMLElement | null)?.focus();
  }

  private closeEvidence(): void {
    if (this.evidenceClaim < 0) return;
    this.evidenceClaim = -1;
    document.getElementById('interior-evidence')?.classList.remove('visible');
  }

  /** Nothing hovered, pinned or open: a body or model change, or leaving. */
  private clearSelection(): void {
    this.closeEvidence();
    this.pinnedIndex = -1;
    this.legendHoverIndex = -1;
    this.clearHover();
    this.renderPinned();
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
  private handlePointerMove = (event: PointerEvent) => {
    if (!this.active || event.pointerType === 'touch') return;
    if (this.tapStart && Math.hypot(event.clientX - this.tapStart.x, event.clientY - this.tapStart.y) > TAP_MAX_PX) {
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
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    this.tapStart = { x: event.clientX, y: event.clientY, t: performance.now() };
  };

  private clearTap = () => {
    this.tapStart = null;
  };

  private handlePointerUp = (event: PointerEvent) => {
    const tap = this.tapStart;
    this.clearTap();
    if (!this.active || !tap) return;
    const moved = Math.hypot(event.clientX - tap.x, event.clientY - tap.y);
    if (moved > TAP_MAX_PX || performance.now() - tap.t > TAP_MAX_MS) return;
    if (this.picker.isOpen() || this.evidenceClaim >= 0) return;
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
    const note = document.getElementById('interior-models-note');
    if (!root || !note) return;
    root.replaceChildren();
    const choices: { modelId: string | null; label: string }[] = [];
    let noteText = '';
    if (this.coverage.state === 'competing') {
      for (const model of coverageModels(this.coverage)) choices.push({ modelId: model.modelId, label: model.title });
      noteText = this.coverage.distinguishedBy;
    } else if (this.coverage.state === 'poorlyConstrained' && this.coverage.illustrative) {
      choices.push({ modelId: null, label: 'Unresolved' });
      choices.push({ modelId: this.coverage.illustrative.modelId, label: `${this.coverage.illustrative.title}, illustrative` });
      noteText = this.drawn.illustrative ? 'One way it could be built, drawn to show the idea; nothing has measured it.' : '';
    }
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
    note.textContent = noteText;
    note.style.display = noteText ? '' : 'none';
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
    if (min) min.textContent = `${formatNumber(range.minK)} K`;
    if (max) max.textContent = `${formatNumber(range.maxK)} K`;
    if (mid) mid.textContent = range.log ? 'temperature, log scale' : 'temperature';
    scale.style.display = '';
  }

  private syncViewButtons(): void {
    const current = cutViewForAngle(this.cut.toDeg);
    for (const view of CUT_VIEWS) {
      document.getElementById(`interior-view-${view}`)?.classList.toggle('on', view === current);
    }
  }

  private syncAngleReadout(): void {
    const slider = document.getElementById('interior-angle') as HTMLInputElement | null;
    if (slider && document.activeElement !== slider) slider.value = String(Math.round(this.cut.angleDeg));
    const readout = document.getElementById('interior-angle-value');
    if (readout) readout.textContent = `${Math.round(this.cut.angleDeg)}°`;
  }

  /** The Esc cascade: the popover, the picker, the pinned inspector, then the tool itself. */
  private handleKeyDown = (event: KeyboardEvent) => {
    if (!this.active) return;
    if (event.key !== 'Escape') return;
    if (this.evidenceClaim >= 0) {
      this.closeEvidence();
      return;
    }
    if (this.picker.isOpen()) {
      this.picker.close();
      return;
    }
    if (this.pinnedIndex >= 0) {
      this.setPinned(-1);
      return;
    }
    this.requestExit();
  };

  private openPicker(): void {
    if (!this.active) return;
    this.closeEvidence(); // one modal at a time
    this.picker.open();
  }

  // ---- camera ----------------------------------------------------------------

  private frameInitial(): void {
    this.controls.target.copy(ORIGIN);
    this.camera.up.set(0, 1, 0);
    this.applyViewportFraming();
    const distance = framingDistance(
      this.camera.aspect,
      FRAMING.fovDeg,
      undefined,
      isPhoneViewport() ? FRAMING.phoneWidthFraction : undefined,
    );
    orbitPose(FRAMING.azimuthDeg, FRAMING.elevationDeg, distance, this.camera.position);
    this.controls.update();
  }

  /** The phone's projection shift: the body draws in the upper part of the
   *  viewport, above the sheet, whatever the orbit. Desktop clears it. */
  private applyViewportFraming(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    if (isPhoneViewport()) {
      const shift = Math.round(height * FRAMING.phoneViewShiftFraction);
      this.camera.setViewOffset(width, height, 0, shift, width, height);
    } else {
      this.camera.clearViewOffset();
    }
    this.camera.updateProjectionMatrix();
  }

  onResize(aspect: number): void {
    this.camera.aspect = aspect;
    this.applyViewportFraming();
    this.interiorScene.onResize();
    this.renderPinned(); // re-dock across the breakpoint
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
    this.handleKeyDown(new KeyboardEvent('keydown', { key: 'Escape' }));
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
    if (claimKind === null) {
      this.closeEvidence();
      return true;
    }
    const region = this.drawn.regionsInsideOut[this.pinnedIndex]?.region;
    const claimIndex = region ? region.claims.findIndex((claim) => claim.kind === claimKind) : -1;
    if (claimIndex < 0) return false;
    this.openEvidence(claimIndex);
    return true;
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
      evidence: regionsInsideOut[this.pinnedIndex]?.region?.claims[this.evidenceClaim]?.kind ?? null,
      emphasis: { region: regionsInsideOut[this.emphasis.index]?.key ?? null, amount: this.emphasis.amount },
    };
  }

  private avgFps(): number {
    if (this.fpsSamples.length === 0) return 0;
    let sum = 0;
    for (const sample of this.fpsSamples) sum += sample;
    return sum / this.fpsSamples.length;
  }
}
