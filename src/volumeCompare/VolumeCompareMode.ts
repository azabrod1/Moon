/**
 * Mode controller for the "How many fit?" volume-compare tool. Owns the camera,
 * its OrbitControls, the DOM (panel + picker), and the pair/session + phase
 * state; CompareScene owns the studio content and the solver-driven pour. The
 * mode maps the pure phase machine (compareLogic) onto the scene's per-frame
 * commands, runs the brim/melt/rain transitions off the scene's status, and
 * drives the panel.
 *
 * Session-only: every activate() starts a fresh session at the default pair and
 * touches no storage keys. Pair changes and Reset run through commitSession /
 * isStale — every async texture resolve checks staleness and, if a newer pick
 * landed, disposes what it loaded and bails.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DEG2RAD } from '../shared/math/angles';
import {
  CompareScene,
  VC_FRAMING,
  CONTAINER_R,
  LIQUID_RIM_Y,
  defaultOrbitDistance,
  tallSceneDistance,
  SUB_UNITY_LOOM_RF,
  type PourControl,
  type PourStatus,
} from './CompareScene';
import { ComparePanel, type PresetKey, type ChipSlot } from './ui/ComparePanel';
import { ComparePicker } from './ui/ComparePicker';
import {
  buildComparison,
  commitSession,
  isStale,
  meanRadiusKm,
  nextPhase,
  escIntent,
  sliderTargetCount,
  sliderForTarget,
  sliderFillsExactly,
  targetReached,
  liquidAtRim,
  sandGrainBudget,
  brimStats,
  endCardModel,
  formatCount,
  formatOdometer,
  formatAcross,
  bodyDisplayName,
  pluralizeBody,
  capitalizeSentence,
  pausedStatus,
  COMPARE_TUNABLES,
  type Comparison,
  type CompareSession,
  type ComparePhase,
  type CompareEvent,
  type FillRegime,
  type BrimStats,
  type EndCardModel,
} from './compareLogic';

const DEFAULT_CONTAINER = 'Jupiter';
const DEFAULT_FILLER = 'Earth';
const FPS_WINDOW = 60;
const PANEL_TICK_S = 0.1; // ~10 Hz odometer/status refresh
const SUB_UNITY_MAX_DISTANCE = 30; // controls.maxDistance while a sub-unity pose is framed
// While the end-card plaque (left) is up, pan the view so the filled vessel reads
// in the right two-thirds (negative → vessel shifts right). Desktop only; applied
// as a pan (target + camera together) so the distance-keyed resize is indifferent.
const CARD_PAN_X = -0.55;

export interface CompareDevState {
  pair: [string, string] | null;
  n: number;
  across: number;
  regime: FillRegime;
  subUnity: boolean;
  phase: ComparePhase;
  texturesReady: boolean;
  fps: number;
  ghostMeanLum: number;
  poured: number;
  melted: number;
  live: number;
  asleepFrac: number;
  fillFraction: number;
  target: number;
  slider: number;
  autoMelt: boolean;
  paused: boolean;
  pickerOpen: boolean;
  endCardShown: boolean;
  /** Visible boulder-pool meshes (leftover check: 0 marbles/sand, ≤2 boulders, 1 sub-unity). */
  boulderMeshes: number;
  /** Mouth iris (0 sealed closed sphere → 1 open) — seals at idle/brim/complete. */
  mouthOpen: number;
  /** Live sand grains (stream + spill) this frame — 0 when the pool is cleared. */
  grainsLive: number;
  /** Live marble-rain fallers this frame — >0 during raining, 0 at complete. */
  fallersLive: number;
  /** The eased liquid render level (height above the bottom pole) — QA rim clearance. */
  liquidLevelY: number;
  /** Measured band bottom (px from viewport top): the occluder's top edge, or 0
   *  on desktop. QA asserts the vessel box clears this. */
  bandTopPx: number;
  /** The vessel's projected screen box (px) — QA asserts bottom < bandTopPx. */
  vesselBox: { top: number; bottom: number; left: number; right: number };
  /** Live cold-open empty-lift (1 empty → 0 early in the pour) — QA probe. */
  emptyLift: number;
  /** Framing QA: the applied orbit distance, target x, and the zoom-out cap. */
  frameDist: number;
  targetX: number;
  maxDist: number;
}

export class VolumeCompareMode {
  private camera: THREE.PerspectiveCamera;
  private compareScene: CompareScene;
  private controls: OrbitControls;
  private panel: ComparePanel;
  private picker: ComparePicker;

  private active = false;
  private onExitCallback: (() => void) | null = null;

  // Pair + session state (the pure core is the source of truth).
  private session: CompareSession = commitSession(0);
  private container = DEFAULT_CONTAINER;
  private filler = DEFAULT_FILLER;
  private comparison: Comparison = buildComparison(DEFAULT_CONTAINER, DEFAULT_FILLER);
  private texturesReady = false;

  // Pour-session UI state.
  private slider = 0;
  private paused = false;
  private autoMelt = true;
  private lastStatus: PourStatus | null = null;

  // Phase timers + brim capture.
  private brimTime = 0;
  private autoMeltTimer = 0;
  private endCardTimer = 0;
  private brimAtHit: BrimStats | null = null;
  private brimPileSize = 0;
  private cardPresented = false; // the end card auto-shows once; a dismiss must stick
  private spilled = false; // the overflow spill ran (its endCardDelayS already spent)
  private cardPanX = 0; // eased horizontal pan while the plaque is up
  private appliedPanX = 0; // pan already applied to target + camera (a delta each frame)
  private pourPanY = 0; // eased vertical pan centring the vessel in the measured band
  private appliedPanY = 0; // vertical pan already applied (a delta each frame)
  private measuredBandTopPx = 0; // top edge of the bottom occluder (bar/sheet); 0 = desktop
  private vesselCenterScratch = new THREE.Vector3();
  private panelClock = 0;
  // The live-pile cap the brim check reads — marbleTotalCap scaled once at
  // activate (mobileCapScale on ≤640px phones, matching the scene's spawn caps).
  private liveCapTotal: number = COMPARE_TUNABLES.marbleTotalCap;
  // Reused per-frame command object (the scene consumes it within updateSim and
  // never retains it), so pourControl allocates nothing.
  private ctlScratch: PourControl = {
    targetCount: 0, spawnEnabled: false, meltRate: 0, rainEnabled: false,
    paused: false, regime: 'marbles',
  };

  private fpsSamples: number[] = [];
  private lastDefaultDistance: number = VC_FRAMING.distance;

  private topBarPrevDisplay: string | null = null;

  private handleKeyDown = (e: KeyboardEvent) => {
    if (!this.active) return;
    if (e.key === 'Escape') this.escCascade();
  };

  // Tap-to-skip: a quick tap on the scene during the overflow spill jumps
  // straight to the end card (the particles finish falling under it). A drag
  // (orbit) is excluded by the small movement threshold.
  private domElement: HTMLElement;
  private tapStart: { x: number; y: number; t: number } | null = null;
  private dragging = false; // a canvas drag (orbit) is in progress — freeze the measured pan
  private handlePointerDown = (e: PointerEvent) => {
    if (!this.active) return;
    this.tapStart = { x: e.clientX, y: e.clientY, t: performance.now() };
    this.dragging = true;
  };
  // Shared drag-end: clears the framing freeze + tap state. Wired to pointercancel,
  // lostpointercapture, and window blur (pointerup runs it too, after its tap check)
  // so an interrupted gesture can never leave the measured mobile framing frozen.
  private clearDrag = () => {
    this.dragging = false;
    this.tapStart = null;
  };
  private handlePointerUp = (e: PointerEvent) => {
    const tap = this.tapStart;
    this.clearDrag();
    if (!this.active || !tap) return;
    const moved = Math.hypot(e.clientX - tap.x, e.clientY - tap.y);
    const dt = performance.now() - tap.t;
    if (moved < 8 && dt < 400 && this.session.phase === 'spilling') this.fire('fill-complete');
  };

  private useBloom: boolean;
  // A keyboard-ish device (matches PlanetariumMode's sky-pref signal): the "Esc to
  // leave" pause hint only makes sense where there is an Esc key. Captured once.
  private hasFinePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  constructor(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    renderer: THREE.WebGLRenderer,
    useBloom: boolean,
  ) {
    this.camera = camera;
    this.useBloom = useBloom;
    this.domElement = renderer.domElement;
    this.compareScene = new CompareScene(scene, renderer);
    this.panel = new ComparePanel({
      onLeave: () => this.requestExit(),
      onSlider: (f) => this.onSlider(f),
      onPreset: (k) => this.onPreset(k),
      onMelt: () => this.onMelt(),
      onReset: () => this.resetSession(),
      onAutoMelt: (on) => this.onAutoMelt(on),
      onChip: (slot) => this.openPicker(slot),
      onSwap: () => this.swapPair(),
      onTeaserSwap: () => this.swapPair(),
      onEndTry: (c, f) => this.commitTryNext(c, f),
      onPourAgain: () => this.pourAgain(),
      onEndClose: () => this.dismissEndCard(),
    });
    this.picker = new ComparePicker(
      (name) => this.onPickerPick(name),
      () => {}, // pickerOpen is read live via picker.isOpen()
    );

    this.controls = new OrbitControls(camera, renderer.domElement);
    this.controls.enabled = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = VC_FRAMING.dampingFactor;
    this.controls.enablePan = false;
    this.controls.minDistance = VC_FRAMING.minDistance;
    this.controls.maxDistance = VC_FRAMING.maxDistance;
    this.controls.target.copy(VC_FRAMING.target);
  }

  onExit(cb: () => void): void {
    this.onExitCallback = cb;
  }

  private requestExit(): void {
    this.onExitCallback?.();
  }

  // ---- lifecycle -----------------------------------------------------------

  async activate(): Promise<void> {
    this.active = true;

    // Tighten the near plane (the vessel never comes closer than minDistance − R
    // ≈ 0.7): the default 0.01 leaves the depth buffer too coarse at the vessel's
    // distance, so the R_liq liquid (0.995) z-fights the glass shell (1.0) at
    // grazing/top angles. 0.5 lifts precision ~50× without clipping. Far stays
    // large for the starfield.
    this.camera.near = 0.5;
    this.camera.updateProjectionMatrix();

    const topBar = document.getElementById('top-bar');
    if (topBar) {
      this.topBarPrevDisplay = topBar.style.display;
      topBar.style.display = 'none';
    }
    const ui = document.getElementById('volume-compare-ui');
    if (ui) ui.style.display = 'block';
    this.panel.bind();
    this.picker.bind();

    this.compareScene.setVisible(true);
    this.controls.enabled = true;
    window.addEventListener('keydown', this.handleKeyDown);
    this.domElement.addEventListener('pointerdown', this.handlePointerDown);
    this.domElement.addEventListener('pointerup', this.handlePointerUp);
    this.domElement.addEventListener('pointercancel', this.clearDrag);
    this.domElement.addEventListener('lostpointercapture', this.clearDrag);
    window.addEventListener('blur', this.clearDrag);
    this.fpsSamples.length = 0;

    // Phones get lighter physics caps — captured once per activation (a mid-pour
    // desktop resize keeps its caps; re-entering the mode re-reads the width).
    const isMobile = window.matchMedia('(max-width: 640px)').matches;
    const capScale = isMobile ? COMPARE_TUNABLES.mobileCapScale : 1;
    this.compareScene.setCapScale(capScale);
    this.liveCapTotal = COMPARE_TUNABLES.marbleTotalCap * capScale;
    // Two sand-grain tiers, one boolean: weak (no-bloom OR mobile) halves the
    // pool so the signals never stack down to a quarter. Activation-captured.
    this.compareScene.setGrainBudget(sandGrainBudget(this.useBloom, isMobile));

    this.slider = 0;
    this.paused = false;
    this.autoMelt = true;
    this.panel.setAutoMelt(true);
    this.frameInitial();
    await this.commitPair(DEFAULT_CONTAINER, DEFAULT_FILLER);
  }

  deactivate(): void {
    this.active = false;
    this.compareScene.setVisible(false);
    const ui = document.getElementById('volume-compare-ui');
    if (ui) ui.style.display = 'none';
    this.controls.enabled = false;
    window.removeEventListener('keydown', this.handleKeyDown);
    this.domElement.removeEventListener('pointerdown', this.handlePointerDown);
    this.domElement.removeEventListener('pointerup', this.handlePointerUp);
    this.domElement.removeEventListener('pointercancel', this.clearDrag);
    this.domElement.removeEventListener('lostpointercapture', this.clearDrag);
    window.removeEventListener('blur', this.clearDrag);
    this.clearDrag(); // clear the framing freeze + tap state explicitly on exit
    // Synchronously clear any live grains/spill so nothing lingers into the next entry.
    this.compareScene.cancelTransients();

    const topBar = document.getElementById('top-bar');
    if (topBar) topBar.style.display = this.topBarPrevDisplay ?? '';
    this.topBarPrevDisplay = null;

    this.picker.close();
    this.panel.showEndCard(null);
    // Cancel any in-flight texture load by bumping the generation.
    this.session = commitSession(this.session.generation);
    this.panel.setLoading(false);
    this.compareScene.setDimmed(false);
  }

  dispose(): void {
    this.deactivate();
    this.controls.dispose();
    this.compareScene.dispose();
  }

  // ---- per-frame -----------------------------------------------------------

  update(dt: number): void {
    if (!this.active) return;
    this.applyCardPan(dt);
    this.applyMeasuredFraming(dt);
    this.controls.update();
    this.compareScene.update(this.camera);
    this.compareScene.tickReveal(dt); // ease the vessel in after a pair load (held hidden meanwhile)

    if (this.texturesReady && !this.comparison.subUnity) {
      const ctl = this.pourControl();
      const status = this.compareScene.updateSim(dt, ctl);
      this.lastStatus = status;
      this.runPhases(status, dt);
      this.panelClock += dt;
      if (this.panelClock >= PANEL_TICK_S) {
        this.tickPanel(status);
        this.panelClock = 0;
      }
    }

    if (dt > 0) {
      this.fpsSamples.push(1 / dt);
      if (this.fpsSamples.length > FPS_WINDOW) this.fpsSamples.shift();
    }
  }

  /**
   * Pan the view sideways while the end-card plaque is up so the filled vessel
   * clears the card. Applied as a pan (target + camera by the same delta) so the
   * camera→target distance is unchanged and the distance-keyed resize is
   * indifferent. Desktop only — the mobile card is a bottom sheet.
   */
  private applyCardPan(dt: number): void {
    const desktop = window.innerWidth > 640;
    const want = desktop && this.cardPresented && this.panel.isEndCardShown() ? CARD_PAN_X : 0;
    this.cardPanX += (want - this.cardPanX) * (1 - Math.exp(-dt / 0.1)); // ~300 ms ease
    const delta = this.cardPanX - this.appliedPanX;
    if (Math.abs(delta) > 1e-6) {
      this.controls.target.x += delta;
      this.camera.position.x += delta;
      this.appliedPanX = this.cardPanX;
    }
  }

  /**
   * MEASURED framing (replaces the old fixed applyPourPan): on a ≤640px phone the
   * pour panel is a bottom bar (and the end card a bottom sheet), so the visible
   * band runs from the viewport top down to the top edge of whichever bottom
   * occluder is up — the end-card sheet if shown, else the bar. Pan the vessel UP
   * so it centres in that band and never sits behind the bar. The magnitude is
   * measured from the occluder's top edge and the current distance (the vertical
   * projection factor P11 = projectionMatrix[1][1]) rather than a fixed guess, so
   * it re-tracks the row-4 grow, the card open/close, and resize. Same
   * equal-translation trick as the card pan (target + camera together), so zoom
   * and the distance-keyed resize stay indifferent. Desktop keeps the top-right
   * panel + horizontal applyCardPan and gets no vertical pan.
   */
  private applyMeasuredFraming(dt: number): void {
    this.remeasureBand();
    let wantPanY = this.pourPanY; // hold by default (desktop, sub-unity, or mid-drag)
    // Freeze while the user is orbiting so the centring never fights a vertical
    // drag; resume centring the moment they let go.
    if (window.innerWidth <= 640 && !this.comparison.subUnity && !this.dragging) {
      const vh = window.innerHeight || 1;
      const barTop = this.measuredBandTopPx > 0 ? this.measuredBandTopPx : vh;
      const desiredCentrePx = barTop / 2; // centre of the band [0, barTop]
      // Measure the ACTUAL projected vessel centre (includes the pan applied so
      // far) and drive it to the band centre — a feedback loop, so it is exact
      // regardless of the elevation/target baseline the analytic pan mis-estimated.
      const box = this.vesselScreenBox();
      const errPx = (box.top + box.bottom) / 2 - desiredCentrePx; // + → vessel too low
      const p11 = this.camera.projectionMatrix.elements[5] || 2.7;
      const worldPerPx = this.lastDefaultDistance / (p11 * vh * 0.5);
      wantPanY = this.pourPanY - errPx * worldPerPx; // pan up (−) to lift a low vessel
    } else if (window.innerWidth > 640 || this.comparison.subUnity) {
      wantPanY = 0; // desktop / sub-unity: no vertical pan (applyCardPan owns the card)
    }
    this.pourPanY += (wantPanY - this.pourPanY) * (1 - Math.exp(-dt / 0.25)); // ~0.7 s ease
    const delta = this.pourPanY - this.appliedPanY;
    if (Math.abs(delta) > 1e-6) {
      this.controls.target.y += delta;
      this.camera.position.y += delta;
      this.appliedPanY = this.pourPanY;
    }
  }

  /**
   * Measure the top edge (px from the viewport top) of the bottom occluder — the
   * end-card sheet if it is up (the bar hides under it), else the pour bar. 0 on
   * desktop (no bottom occluder, no vertical pan). One layout read per frame; the
   * DOM is otherwise stable so it stays cheap (ObservatoryHUD measure precedent).
   */
  private remeasureBand(): void {
    if (window.innerWidth > 640) {
      this.measuredBandTopPx = 0;
      return;
    }
    const vh = window.innerHeight || 1;
    if (this.panel.isEndCardShown()) {
      const card = document.querySelector('.compare-endcard-card') as HTMLElement | null;
      if (card) {
        this.measuredBandTopPx = card.getBoundingClientRect().top;
        return;
      }
    }
    const bar = document.getElementById('compare-panel');
    this.measuredBandTopPx = bar ? bar.getBoundingClientRect().top : vh;
  }

  /** The vessel's projected screen box (px) — QA asserts it clears the bar. */
  private vesselScreenBox(): { top: number; bottom: number; left: number; right: number } {
    const vw = window.innerWidth || 1;
    const vh = window.innerHeight || 1;
    // Refresh the camera matrices so the projection reflects THIS frame's pose
    // (updateMatrixWorld sets matrixWorld; project reads matrixWorldInverse).
    this.camera.updateMatrixWorld();
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
    this.vesselCenterScratch.set(0, 0, 0).project(this.camera);
    const cx = (this.vesselCenterScratch.x * 0.5 + 0.5) * vw;
    const cy = (1 - (this.vesselCenterScratch.y * 0.5 + 0.5)) * vh;
    const dist = Math.max(0.001, this.camera.position.length()); // camera → vessel (origin)
    const p11 = this.camera.projectionMatrix.elements[5] || 2.7;
    const rPx = (p11 * 1) / dist * (vh / 2); // studio R = 1
    return { top: cy - rPx, bottom: cy + rPx, left: cx - rPx, right: cx + rPx };
  }

  /** Phase + slider + pause → the scene's per-frame commands. */
  private pourControl(): PourControl {
    const n = this.comparison.n;
    const melted = this.lastStatus?.melted ?? 0;
    const rawTarget = sliderTargetCount(n, this.slider);
    let targetCount = Math.max(rawTarget, melted); // drain floor (can't un-melt)
    let spawnEnabled = false;
    let meltRate = 0;
    let rainEnabled = false;
    switch (this.session.phase) {
      case 'pouring':
        spawnEnabled = true;
        break;
      case 'melting':
        meltRate = COMPARE_TUNABLES.meltPerSec;
        break;
      case 'raining':
        spawnEnabled = true;
        rainEnabled = true;
        // Keep the bottom-melt running so the pile always clears (a lone ball
        // floating above the risen level would never be consumed otherwise).
        meltRate = COMPARE_TUNABLES.meltPerSec;
        targetCount = n; // fill the volume to N
        break;
    }
    // Rewritten in place each frame (the scene never retains the commands).
    const ctl = this.ctlScratch;
    ctl.targetCount = targetCount;
    ctl.spawnEnabled = spawnEnabled;
    ctl.meltRate = meltRate;
    ctl.rainEnabled = rainEnabled;
    ctl.paused = this.paused;
    ctl.regime = this.comparison.regime;
    return ctl;
  }

  /** Run the phase machine off the scene's status (frozen while paused). */
  private runPhases(s: PourStatus, dt: number): void {
    if (this.paused) return;
    const n = this.comparison.n;
    const target = sliderTargetCount(n, this.slider);
    switch (this.session.phase) {
      case 'settling':
        // Pour whenever the target is unmet, judged per regime (targetReached):
        // marbles + sand floor the target to whole balls (the same floor as
        // target-met, or the two ping-pong); boulders compare the fractional melt
        // volume, so "half" of a 1.73 pair (0.865) pours and a 0.3 → 0.7 raise
        // pours the delta. Sand pours the stream now (P4 — the note is gone).
        if (!targetReached(target, s.poured, this.comparison.regime)) {
          this.fire('pour');
        }
        break;
      case 'pouring':
        if (this.comparison.regime === 'boulders') {
          if (s.bouldersDone) this.fire(this.sliderAtFillIt() ? 'fill-complete' : 'target-met');
        } else if (this.comparison.regime === 'sand') {
          // Sand: a full fill leaves via the VISUAL rim (top-out → spilling); a
          // partial target settles back (no card), exactly like a marble partial.
          if (this.sliderAtFillIt()) {
            if (s.fillFraction >= 1 - 1e-3 && liquidAtRim(s.liquidLevelY, LIQUID_RIM_Y, CONTAINER_R)) {
              this.compareScene.topOffSand();
              this.fire('top-out');
            }
          } else if (targetReached(target, s.poured, 'sand')) {
            this.fire('target-met');
          }
        } else if (targetReached(target, s.poured, this.comparison.regime)) {
          // Marbles reach floor(target) — poured is a whole-ball count, and a
          // fractional target (e.g. 287.6) would otherwise strand the pour at 287
          // just below target − 0.5 and never settle.
          this.fire('target-met');
          this.brimTime = 0;
        } else {
          const candidate =
            (s.atPackCeiling || s.live >= this.liveCapTotal || s.pileAtMouth) &&
            s.asleepFrac >= 0.5;
          this.brimTime = candidate ? this.brimTime + dt : 0;
          if (this.brimTime >= COMPARE_TUNABLES.brimQuietS) {
            if (this.sliderAtFillIt()) {
              this.brimAtHit = brimStats(n, s.poured);
              this.brimPileSize = s.poured;
              this.fire('brim-hit');
            } else {
              this.fire('target-met');
            }
            this.brimTime = 0;
          }
        }
        break;
      case 'brim':
        this.autoMeltTimer += dt;
        if (this.autoMelt && this.autoMeltTimer >= COMPARE_TUNABLES.autoMeltDelayS) {
          this.fire('melt-start');
        }
        break;
      case 'melting':
        if (s.melted >= 0.15 * Math.max(1, this.brimPileSize)) this.fire('melt-open');
        break;
      case 'raining': {
        // Whole marbles fill only floor(N)/N (no fractional ball), so completion
        // is "every whole ball poured and melted, the pile empty" — then top the
        // last fractional ball-volume off so the liquid reads exactly full. The
        // overflow spill waits for the VISUAL rim (the 0.35 s level ease trails
        // the count), so it can't fire before the surface arrives.
        const nFloor = Math.floor(n + 1e-9);
        if (s.poured >= nFloor - 0.5 && s.live === 0 && s.melted >= nFloor - 0.5) {
          this.compareScene.topOffLiquid();
          if (liquidAtRim(s.liquidLevelY, LIQUID_RIM_Y, CONTAINER_R)) this.fire('top-out');
        }
        break;
      }
      case 'spilling':
        // The overflow garnish runs; the end-card delay is spent here (so the
        // card presents right at complete). A tap skips straight to the card.
        this.endCardTimer += dt;
        if (this.endCardTimer >= COMPARE_TUNABLES.endCardDelayS) this.fire('fill-complete');
        break;
      case 'complete':
        // Boulders arrive here with no spill beat, so they still wait the delay;
        // marbles/sand already spent it in `spilling` (this.spilled). Auto-present
        // once; a dismiss (Esc / ✕) must stick. Defers while the picker is open.
        this.endCardTimer += dt;
        if (
          !this.cardPresented &&
          this.endCardTimer >= (this.spilled ? 0 : COMPARE_TUNABLES.endCardDelayS) &&
          !this.picker.isOpen()
        ) {
          this.cardPresented = true;
          this.showEndCard();
        }
        break;
    }
  }

  private fire(event: CompareEvent): void {
    const next = nextPhase(this.session.phase, event);
    if (!next) return;
    this.session.phase = next;
    this.onEnterPhase(next);
  }

  private onEnterPhase(phase: ComparePhase): void {
    switch (phase) {
      case 'brim':
        this.autoMeltTimer = 0;
        this.panel.showMelt(true);
        break;
      case 'melting':
        // Hide the Melt button (melt started) but KEEP the row-4 unit live through
        // melting — the brief keeps Melt/Auto-melt present across brim AND melting.
        this.panel.showMelt(false, true);
        break;
      case 'raining':
        this.panel.showMelt(false, false); // reconcile underway — drop the row-4 unit
        break;
      case 'spilling':
        // The overflow garnish (marbles AND sand); the end-card delay runs here.
        this.spilled = true;
        this.endCardTimer = 0;
        this.compareScene.beginSpill();
        this.panel.showMelt(false);
        break;
      case 'complete':
        this.endCardTimer = 0;
        this.panel.showMelt(false);
        // Cull the airborne spill/plume/droplet strays over ~0.5 s so the end card
        // settles over a clean scene (a graceful fade, not the instant swap clear).
        this.compareScene.retireTransients();
        break;
    }
  }

  private sliderAtFillIt(): boolean {
    // Full ONLY when the target is exactly N (the "fill it" preset lands slider = 1,
    // and dragging to the max reaches it). A raw near-max drag (0.995–0.999) targets
    // ~98.9%–99.8% of N, so it settles quietly as a partial — no brim/card, and sand
    // never hangs in `pouring` waiting for a top-out its sub-N target can't reach.
    return sliderFillsExactly(this.comparison.n, this.slider);
  }

  // ---- panel refresh (~10 Hz) ---------------------------------------------

  private tickPanel(s: PourStatus): void {
    this.panel.setReadout(this.odometerText(s), this.statusLine(s));
    const n = this.comparison.n;
    this.panel.setSliderTrack(sliderForTarget(n, s.poured), this.slider, this.fillerColor());
    this.updateGhost(s);
  }

  private odometerText(s: PourStatus): string {
    // Marbles count whole balls (formatOdometer). Boulders + sand run the tiered
    // ratio voice (formatCount): the sand odometer decelerates into its landing
    // and its final string equals the headline (both formatCount(N)).
    return this.comparison.regime === 'marbles' ? formatOdometer(s.poured) : formatCount(s.poured);
  }

  /** The ghost ring previews the target level and hides once it is satisfied. */
  private updateGhost(s: PourStatus): void {
    if (this.comparison.subUnity || this.comparison.regime === 'sand' || this.slider < 0.001) {
      this.compareScene.setGhostTarget(0, this.fillerColor());
      return;
    }
    const n = this.comparison.n;
    const target = sliderTargetCount(n, this.slider);
    const targetFrac = target / Math.max(n, 1e-9);
    // Satisfied per regime (the same rule the phase machine pours by), so the
    // ring neither lingers after a marble target's floor is met nor vanishes
    // mid-melt on a boulder's fractional progress.
    const reachedSolid = targetReached(target, s.poured, this.comparison.regime);
    const reachedLiquid = Math.abs(s.fillFraction - targetFrac) < 0.01; // liquid reached the line
    this.compareScene.setGhostTarget(reachedSolid || reachedLiquid ? 0 : targetFrac, this.fillerColor());
  }

  private statusLine(s: PourStatus): string {
    if (this.paused) return pausedStatus(this.hasFinePointer);
    switch (this.session.phase) {
      case 'settling':
        if (s.poured < 0.5 && this.comparison.regime !== 'sand') {
          // Plural: this zero-state meta counts how many fillers fit across the
          // container ("Earths — 11 across"), so the name reads as a population.
          return capitalizeSentence(
            `${pluralizeBody(this.filler)} — ${formatAcross(this.comparison.across)} across`,
          );
        }
        // Clear the label once the pile is actually at rest (don't read "settling…"
        // for seconds after it visibly stopped).
        return s.asleepFrac < 0.92 ? 'settling…' : '';
      case 'pouring':
        if (this.comparison.regime === 'boulders') {
          // Sentence-initial too: "The Sun can't fit…", never "the Sun can't fit…".
          return capitalizeSentence(
            `${bodyDisplayName(this.filler)} can't fit through any opening — it melts on the glass.`,
          );
        }
        return '';
      case 'brim':
        return this.brimAtHit
          ? `${this.brimAtHit.packedCount} poured — solid spheres leave gaps. Melt them and all ${this.brimAtHit.ratioText} fit.`
          : '';
      case 'melting':
        return 'melting…';
      case 'raining':
        return 'still pouring — new arrivals melt in';
      case 'spilling':
      case 'complete':
        return 'full to the brim';
      default:
        return '';
    }
  }

  private fillerColor(): number {
    return this.compareScene.fillerTintHex();
  }

  // ---- controls ------------------------------------------------------------

  private onSlider(f: number): void {
    this.slider = Math.min(1, Math.max(0, f));
    if (this.paused) this.setPaused(false);
    if (this.lastStatus) this.updateGhost(this.lastStatus);
  }

  private onPreset(key: PresetKey): void {
    const n = this.comparison.n;
    let s: number;
    switch (key) {
      case '10':
        s = Math.pow(0.1, 1 / COMPARE_TUNABLES.sliderGamma);
        break;
      case 'half':
        s = Math.pow(0.5, 1 / COMPARE_TUNABLES.sliderGamma);
        break;
      case 'one':
        s = sliderForTarget(n, 1);
        break;
      case 'fill':
      default:
        s = 1;
        break;
    }
    this.panel.setSliderValue(s);
    this.onSlider(s);
  }

  private onMelt(): void {
    if (this.paused) this.setPaused(false);
    if (this.session.phase === 'brim') this.fire('melt-start');
  }

  private onAutoMelt(on: boolean): void {
    this.autoMelt = on;
    this.panel.setAutoMelt(on);
    if (this.paused) this.setPaused(false);
  }

  private setPaused(paused: boolean): void {
    this.paused = paused;
    if (this.lastStatus) this.tickPanel(this.lastStatus);
  }

  // ---- Esc cascade ---------------------------------------------------------

  private escCascade(): void {
    // Pause is a mode flag, not a phase — Esc while paused leaves directly
    // (escIntent would answer 'pause-pour' forever otherwise).
    if (this.paused) {
      this.requestExit();
      return;
    }
    const intent = escIntent({
      pickerOpen: this.picker.isOpen(),
      endCardShown: this.panel.isEndCardShown(),
      phase: this.session.phase,
    });
    switch (intent) {
      case 'close-picker':
        this.picker.close();
        break;
      case 'dismiss-card':
        this.dismissEndCard();
        break;
      case 'pause-pour':
        this.setPaused(true);
        break;
      case 'skip-spill':
        // The overflow garnish is cosmetic — jump straight to the card, exactly
        // like a canvas tap during spilling (the grains finish falling under it).
        this.fire('fill-complete');
        break;
      case 'leave':
        this.requestExit();
        break;
    }
  }

  // ---- picker / pair commits ----------------------------------------------

  private openPicker(slot: ChipSlot): void {
    this.pickerActiveSlot = slot;
    this.panel.showEndCard(null); // one-modal-at-a-time
    this.picker.open(slot, this.container, this.filler);
  }

  private onPickerPick(name: string): void {
    const slot = this.pickerActiveSlot;
    this.picker.close();
    if (slot === 'container') void this.commitPair(name, this.filler);
    else void this.commitPair(this.container, name);
  }

  private swapPair(): void {
    void this.commitPair(this.filler, this.container);
  }

  /** A Try-next row commits the pair the ROW names (the end-card model filters
   *  the curated list, so a positional index would land on the wrong pair). */
  private commitTryNext(container: string, filler: string): void {
    if (meanRadiusKm(container) === null || meanRadiusKm(filler) === null) return;
    this.panel.showEndCard(null);
    void this.commitPair(container, filler);
  }

  /** "Pour again" replays the run: reset, then re-commit the finished slider
   *  target (auto-melt untouched) so it actually pours — after a fill-it run the
   *  whole arc re-runs, not just an empty vessel. */
  private pourAgain(): void {
    this.panel.showEndCard(null);
    const replay = this.slider;
    this.resetSession();
    if (replay > 0) {
      this.panel.setSliderValue(replay);
      this.onSlider(replay);
    }
  }

  private dismissEndCard(): void {
    this.panel.showEndCard(null);
    // The filled vessel stays on stage; phase remains complete until a reset/pair change.
  }

  private showEndCard(): void {
    this.panel.showEndCard(this.buildEndCardModel());
  }

  private buildEndCardModel(): EndCardModel {
    return endCardModel(this.container, this.filler, this.comparison, this.brimAtHit);
  }

  // ---- pair commit ---------------------------------------------------------

  private async commitPair(container: string, filler: string): Promise<void> {
    this.container = container;
    this.filler = filler;
    this.comparison = buildComparison(container, filler);
    this.session = commitSession(this.session.generation);
    const gen = this.session.generation;
    this.texturesReady = false;
    this.resetPourState();
    // Synchronously kill any live grains/spill BEFORE the async texture load — the
    // update loop stops driving the pool while texturesReady is false, so without
    // this the old pair's grains would freeze visibly through the load window.
    this.compareScene.cancelTransients();

    this.panel.render(this.panelState());
    this.panel.showEndCard(null);
    this.panel.setLoading(true);
    this.compareScene.setDimmed(true);
    // Hold the vessel hidden until the new pair is fully applied — the reveal eases
    // back in from afterPairReady, so the load window never shows the outgoing map
    // or a ghost-less shell (mode entry stacks this behind the #mode-transition veil).
    this.compareScene.beginPairLoad();

    await this.compareScene.applyPair(
      this.comparison,
      container,
      filler,
      () => isStale(gen, this.session.generation),
    );
    if (isStale(gen, this.session.generation)) return; // a newer pick won

    this.texturesReady = true;
    this.panel.setLoading(false);
    this.compareScene.setDimmed(false);
    this.afterPairReady();
  }

  /** Zero the pour-session UI state (not the scene — applyPair/resetSession do that). */
  private resetPourState(): void {
    this.slider = 0;
    this.paused = false;
    this.brimTime = 0;
    this.autoMeltTimer = 0;
    this.endCardTimer = 0;
    this.brimAtHit = null;
    this.brimPileSize = 0;
    this.cardPresented = false;
    this.spilled = false;
    this.lastStatus = null;
    this.panel.setSliderValue(0);
    this.panel.showMelt(false);
  }

  /** Textures live: fire 'ready' (→ settling), set the sub-unity/normal staging, frame. */
  private afterPairReady(): void {
    // The pair is fully presented (ghost, halo, filler, mouth all applied) — ease
    // the held vessel in. resetSession lands here too with the reveal already at 1.
    this.compareScene.revealPair();
    // commitSession left the phase in 'loading'; only 'ready' leaves it.
    this.fire('ready');
    if (this.comparison.subUnity) {
      this.compareScene.showSubUnity(this.comparison);
      this.panel.setTeaser(this.teaserText());
      this.controls.maxDistance = SUB_UNITY_MAX_DISTANCE;
    } else {
      this.panel.setTeaser(null);
      this.controls.maxDistance = VC_FRAMING.maxDistance;
    }
    this.compareScene.setGhostTarget(0, this.fillerColor());
    this.frameForComparison();
  }

  private teaserText(): string {
    // "the other way round: ⟨N⟩ fit" — the count with the pair swapped.
    const swapped = buildComparison(this.filler, this.container);
    return formatCount(swapped.n);
  }

  private panelState() {
    // Sand is pourable now (the stream). Only the sub-unity teaser hides the pour
    // controls. Sand HIDES the melt controls (Melt affordance + Auto-melt toggle):
    // a liquid-like fill never packs, so the pack-then-melt story doesn't apply.
    const pourable = !this.comparison.subUnity;
    const showMeltControls = this.comparison.regime !== 'sand';
    const presets: { key: PresetKey; label: string }[] =
      this.comparison.regime === 'boulders'
        ? [
            { key: 'one', label: '1' },
            { key: 'half', label: 'half' },
            { key: 'fill', label: 'fill it' },
          ]
        : [
            { key: '10', label: '10%' },
            { key: 'half', label: 'half' },
            { key: 'fill', label: 'fill it' },
          ];
    return {
      container: this.container,
      filler: this.filler,
      comparison: this.comparison,
      pourable,
      showMeltControls,
      presets,
    };
  }

  /** D15 Reset — same pair, cheap: re-zero the sim + liquid + UI, one generation bump. */
  private resetSession(): void {
    // Inert while a pair load is in flight: declaring "ready" here would flip a
    // half-loaded scene live (or strand the loading chip). The Reset control is
    // visually disabled during the swap; the in-flight commit lands moments later.
    if (!this.texturesReady) return;
    if (this.paused) this.paused = false;
    this.session = commitSession(this.session.generation);
    this.resetPourState();
    this.panel.showEndCard(null);
    this.compareScene.resetSession(this.comparison, this.filler);
    this.texturesReady = true; // textures already live — never sit in loading
    this.afterPairReady();
  }

  // ---- framing -------------------------------------------------------------

  private frameForComparison(): void {
    this.camera.up.set(0, 1, 0);
    // A fresh frame wipes any pan (end-card X, phone-pour Y): target back on axis.
    this.cardPanX = 0;
    this.appliedPanX = 0;
    this.pourPanY = 0;
    this.appliedPanY = 0;
    const aspect = this.camera.aspect;
    if (this.comparison.subUnity) {
      this.frameSubUnity(aspect);
      return;
    }
    this.controls.target.copy(VC_FRAMING.target);
    const top = this.compareScene.topExtentForPour(this.comparison);
    const dist =
      this.comparison.regime === 'boulders'
        ? tallSceneDistance(aspect, top, this.controls.maxDistance)
        : defaultOrbitDistance(aspect);
    // On a narrow phone the scale preview parks to the RIGHT of the vessel and clips
    // off-frame. Fit BOTH the vessel and the preview's bounding sphere horizontally.
    // Desktop (>640px) keeps the EXACT default numbers — this branch is skipped.
    if (window.innerWidth <= 640 && this.comparison.regime !== 'sand') {
      this.fitPreviewMobile(this.compareScene.previewBounds(), dist);
      return;
    }
    this.lastDefaultDistance = dist;
    this.camera.position.copy(orbitPose(VC_FRAMING.azimuthDeg, VC_FRAMING.elevationDeg, dist, this.controls.target));
    this.controls.update();
  }

  /**
   * Fit the vessel (sphere R=1 at origin) AND the scale preview (its bounding sphere)
   * inside [16, W−16] on a narrow phone: recenter on their SCREEN extents and pull back
   * until both clear the margin. Iterative in screen space (a one-shot framing call),
   * so it is exact under the orbit azimuth where world-x ≠ screen-x. Leaves the default
   * pose untouched if it already fits (small previews on a wide-enough phone).
   */
  private fitPreviewMobile(pb: { x: number; y: number; z: number; r: number }, startDist: number): void {
    const W = window.innerWidth || 1;
    const vh = window.innerHeight || 1;
    const az = VC_FRAMING.azimuthDeg;
    const el = VC_FRAMING.elevationDeg;
    const ty = VC_FRAMING.target.y;
    const scratch = new THREE.Vector3();
    const margin = 18; // a hair over the ≥16px requirement, so rounding never dips under
    let dist = startDist;
    let targetX = VC_FRAMING.target.x;
    for (let iter = 0; iter < 24; iter++) {
      this.controls.target.set(targetX, ty, 0);
      this.camera.position.copy(orbitPose(az, el, dist, this.controls.target));
      this.camera.updateMatrixWorld();
      this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
      const p11 = this.camera.projectionMatrix.elements[5] || 2.7;
      const projX = (x: number, y: number, z: number): number =>
        (scratch.set(x, y, z).project(this.camera).x * 0.5 + 0.5) * W;
      const rPx = (r: number, x: number, y: number, z: number): number =>
        (p11 * r) / Math.max(0.001, this.camera.position.distanceTo(scratch.set(x, y, z))) * (vh / 2);
      const vCx = projX(0, 0, 0);
      const vR = rPx(1, 0, 0, 0);
      const pCx = projX(pb.x, pb.y, pb.z);
      const pR = rPx(pb.r, pb.x, pb.y, pb.z);
      const left = Math.min(vCx - vR, pCx - pR);
      const right = Math.max(vCx + vR, pCx + pR);
      if (left >= margin && right <= W - margin) break;
      // Recenter the content between the margins AND ease out a touch — both run so a
      // centered-but-just-too-wide case (the 320px phone) still opens up the margin.
      const center = (left + right) / 2;
      targetX += (center - W / 2) / Math.max(vR, 1); // vR ≈ px per world unit at the vessel
      dist *= 1.04;
    }
    this.lastDefaultDistance = dist;
    this.controls.maxDistance = Math.max(this.controls.maxDistance, dist);
    this.controls.target.set(targetX, ty, 0);
    this.camera.position.copy(orbitPose(az, el, dist, this.controls.target));
    this.controls.update();
  }

  /**
   * Sub-unity staging, split by how big the filler is (fit-both fails at extreme
   * ratios — glass Earth would be a bead). r_f = n^(−1/3), the filler's studio
   * radius; the vessel is R = 1 and the filler is internally tangent at the
   * bottom pole (its top reaches 2·r_f − R).
   */
  private frameSubUnity(aspect: number): void {
    const R = 1;
    const rf = this.compareScene.subUnityRenderRf(); // the capped, actually-rendered radius
    const cy = this.compareScene.subUnityFillerCenterY(); // wedged filler centre
    const fillerTop = cy + rf;
    const vHalf = 20 * DEG2RAD; // half the 40° vertical FOV
    const hHalf = Math.atan(Math.tan(vHalf) * Math.max(aspect, 0.01));
    if (rf <= SUB_UNITY_LOOM_RF) {
      // Mild: fit both. Stack spans y ∈ [−R, fillerTop]; centre at its midpoint.
      this.controls.target.set(0, (fillerTop - R) / 2, 0);
      const halfH = (fillerTop + R) / 2 + 0.25;
      const distV = halfH / Math.tan(vHalf * 0.92);
      const distH = (rf + 0.25) / Math.tan(hHalf * 0.92); // the filler width (2·r_f) too
      const dist = Math.min(this.controls.maxDistance, Math.max(distV, distH));
      this.lastDefaultDistance = dist;
      this.camera.position.copy(orbitPose(VC_FRAMING.azimuthDeg, VC_FRAMING.elevationDeg, dist, this.controls.target));
    } else {
      // Honest loom: the GIANT owns the frame at its TRUE radius (Moon/Jupiter 40×),
      // the VESSEL shrinks to its readable/tappable floor — the smallness is the
      // story. Distance is keyed to the vessel's on-screen size (a hair above the
      // ≥90 px desktop / ≥56 px phone floor), not the giant's size.
      const target = new THREE.Vector3(0, 0.35, 0);
      this.controls.target.copy(target);
      const az = -33; // side azimuth catches the key-lit belly (X9 loom key)
      const vhPx = Math.max(1, window.innerHeight);
      const floorPx = window.innerWidth <= 640 ? 60 : 96; // a hair above the 56/90 contract
      const p11 = 1 / Math.tan(vHalf); // vertical projection factor (screenR = p11·R·vh/2 / dist)
      const dist = Math.min(this.controls.maxDistance, (p11 * R * vhPx * 0.5) / floorPx);
      // Keep the camera OUTSIDE the giant: start near-level (shows the wedge
      // contact for moderate ratios) and DIP the elevation for the enormous ones
      // (a positive elevation sits the camera near a huge giant's bottom and can't
      // escape it; dipping under keeps the vessel at its floor size while clearing
      // the giant). Real pairs need only a few degrees (Moon/Jupiter exits at 5°,
      // Moon/Sun at 1°); the −24° floor is a guaranteed-outside fallback for
      // ratios beyond the catalog, never approached in practice.
      const fillerCenter = new THREE.Vector3(0, cy, 0);
      let el = 5;
      for (let i = 0; i < 60; i++) {
        if (orbitPose(az, el, dist, target).distanceTo(fillerCenter) >= rf + 0.4) break;
        el -= 1;
        if (el <= -24) { el = -24; break; }
      }
      this.lastDefaultDistance = dist;
      this.camera.position.copy(orbitPose(az, el, dist, target));
    }
    this.controls.update();
  }

  private frameInitial(): void {
    this.controls.target.copy(VC_FRAMING.target);
    this.camera.up.set(0, 1, 0);
    const dist = defaultOrbitDistance(this.camera.aspect);
    this.lastDefaultDistance = dist;
    this.camera.position.copy(orbitPose(VC_FRAMING.azimuthDeg, VC_FRAMING.elevationDeg, dist, VC_FRAMING.target));
    this.controls.update();
  }

  onResize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.compareScene.onResize();
    // Re-fit only while the camera still sits at the default (a user zoom sticks).
    const current = this.camera.position.distanceTo(this.controls.target);
    if (Math.abs(current - this.lastDefaultDistance) < 0.05) {
      this.frameForComparison();
    }
  }

  // ---- dev bridge (DEV-only via window.__moon) -----------------------------

  private pickerActiveSlot: ChipSlot = 'container';

  devExit(): void {
    this.requestExit();
  }

  devPick(container: string, filler: string): boolean {
    if (meanRadiusKm(container) === null || meanRadiusKm(filler) === null) return false;
    void this.commitPair(container, filler);
    return true;
  }

  devSlider(f: number): boolean {
    this.panel.setSliderValue(f);
    this.onSlider(f);
    return true;
  }

  devMelt(): boolean {
    this.onMelt();
    return true;
  }

  devAutoMelt(on: boolean): boolean {
    this.onAutoMelt(on);
    return true;
  }

  devPreset(key: string): boolean {
    if (key !== '10' && key !== 'half' && key !== 'fill' && key !== 'one') return false;
    this.onPreset(key);
    return true;
  }

  devReset(): boolean {
    this.resetSession();
    return true;
  }

  /** Tap-to-skip the overflow spill (QA parity with a scene tap). */
  devSkip(): boolean {
    if (this.session.phase === 'spilling') this.fire('fill-complete');
    return this.session.phase === 'complete';
  }

  devEsc(): void {
    this.escCascade();
  }

  devEndCard(): EndCardModel | null {
    return this.panel.isEndCardShown() ? this.buildEndCardModel() : null;
  }

  devState(): CompareDevState {
    const s = this.lastStatus;
    return {
      pair: [this.container, this.filler],
      n: this.comparison.n,
      across: this.comparison.across,
      regime: this.comparison.regime,
      subUnity: this.comparison.subUnity,
      phase: this.texturesReady ? this.session.phase : 'loading',
      texturesReady: this.texturesReady,
      fps: this.avgFps(),
      ghostMeanLum: this.compareScene.getGhostMeanLum(),
      emptyLift: this.compareScene.getEmptyLift(),
      poured: s?.poured ?? 0,
      melted: s?.melted ?? 0,
      live: s?.live ?? 0,
      asleepFrac: s?.asleepFrac ?? 1,
      fillFraction: s?.fillFraction ?? 0,
      target: sliderTargetCount(this.comparison.n, this.slider),
      slider: this.slider,
      autoMelt: this.autoMelt,
      paused: this.paused,
      pickerOpen: this.picker.isOpen(),
      endCardShown: this.panel.isEndCardShown(),
      boulderMeshes: this.compareScene.visibleBoulderMeshes(),
      mouthOpen: this.compareScene.mouthOpenAmount(),
      grainsLive: this.compareScene.grainsLive(),
      fallersLive: this.compareScene.fallersLive(),
      liquidLevelY: s?.liquidLevelY ?? 0,
      bandTopPx: this.measuredBandTopPx,
      vesselBox: this.vesselScreenBox(),
      frameDist: this.lastDefaultDistance,
      targetX: this.controls.target.x,
      maxDist: this.controls.maxDistance,
    };
  }

  devScatter(n: number): boolean {
    this.compareScene.scatter(n);
    return true;
  }

  devFreezeTime(on: boolean): boolean {
    this.compareScene.setTimeFrozen(on);
    return true;
  }

  devOrbit(azimuthDeg: number, elevationDeg = 20): boolean {
    const dist = this.camera.position.distanceTo(this.controls.target);
    this.camera.position.copy(orbitPose(azimuthDeg, elevationDeg, dist, this.controls.target));
    this.controls.update();
    return true;
  }

  private avgFps(): number {
    if (this.fpsSamples.length === 0) return 0;
    let sum = 0;
    for (const f of this.fpsSamples) sum += f;
    return sum / this.fpsSamples.length;
  }
}

/** Camera position on the orbit sphere for an azimuth/elevation/distance. */
function orbitPose(azDeg: number, elDeg: number, dist: number, target: THREE.Vector3): THREE.Vector3 {
  const az = azDeg * DEG2RAD;
  const el = elDeg * DEG2RAD;
  return new THREE.Vector3(
    dist * Math.sin(az) * Math.cos(el),
    dist * Math.sin(el),
    dist * Math.cos(az) * Math.cos(el),
  ).add(target);
}
