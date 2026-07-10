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
  targetReached,
  brimStats,
  endCardModel,
  formatCount,
  formatOdometer,
  formatAcross,
  bodyDisplayName,
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
// On a ≤640px phone the top panel covers the mouth and the molten pool during
// the active arc: pan the view up (target + camera together, same trick as the
// card pan) so the mouth + liquid surface ride in the lower ~55% of the
// viewport. Released on complete — the end-card bottom sheet wants the vessel
// back in the upper band.
const POUR_PAN_Y = 0.55;

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
  private cardPanX = 0; // eased horizontal pan while the plaque is up
  private appliedPanX = 0; // pan already applied to target + camera (a delta each frame)
  private pourPanY = 0; // eased vertical pan during a phone pour (POUR_PAN_Y)
  private appliedPanY = 0; // vertical pan already applied (a delta each frame)
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
  private cameraWorldPos = new THREE.Vector3();
  private lastDefaultDistance: number = VC_FRAMING.distance;

  private topBarPrevDisplay: string | null = null;

  private handleKeyDown = (e: KeyboardEvent) => {
    if (!this.active) return;
    if (e.key === 'Escape') this.escCascade();
  };

  constructor(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    renderer: THREE.WebGLRenderer,
    _useBloom: boolean,
  ) {
    this.camera = camera;
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
    this.fpsSamples.length = 0;

    // Phones get lighter physics caps — captured once per activation (a mid-pour
    // desktop resize keeps its caps; re-entering the mode re-reads the width).
    const capScale = window.matchMedia('(max-width: 640px)').matches
      ? COMPARE_TUNABLES.mobileCapScale
      : 1;
    this.compareScene.setCapScale(capScale);
    this.liveCapTotal = COMPARE_TUNABLES.marbleTotalCap * capScale;

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
    this.applyPourPan(dt);
    this.controls.update();
    this.camera.getWorldPosition(this.cameraWorldPos);
    this.compareScene.update(this.cameraWorldPos);

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
   * On a ≤640px phone the top panel covers the mouth and the molten pool — the
   * money shot. While anything is in the vessel (an active pour, the brim wait,
   * the melt, the rain, or a settled pile), pan the view up so the mouth and the
   * liquid surface ride in the lower ~55% of the viewport; released on
   * complete/reset/commit (the end-card bottom sheet wants the vessel back in
   * the upper band). Same equal-translation trick as the card pan, so zoom and
   * the distance-keyed resize are indifferent.
   */
  private applyPourPan(dt: number): void {
    const phone = window.innerWidth <= 640;
    const phase = this.session.phase;
    const activeArc =
      phase === 'pouring' ||
      phase === 'brim' ||
      phase === 'melting' ||
      phase === 'raining' ||
      (phase === 'settling' && (this.lastStatus?.poured ?? 0) > 0);
    const want = phone && !this.comparison.subUnity && activeArc ? POUR_PAN_Y : 0;
    this.pourPanY += (want - this.pourPanY) * (1 - Math.exp(-dt / 0.25)); // ~0.7 s ease
    const delta = this.pourPanY - this.appliedPanY;
    if (Math.abs(delta) > 1e-6) {
      this.controls.target.y += delta;
      this.camera.position.y += delta;
      this.appliedPanY = this.pourPanY;
    }
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
        // marbles floor the target to whole balls (the same floor as target-met,
        // or the two ping-pong); boulders compare the fractional melt volume, so
        // "half" of a 1.73 pair (0.865) pours and a 0.3 → 0.7 raise pours the
        // delta. Sand never pours here — the honest note owns that pair.
        if (this.comparison.regime !== 'sand' && !targetReached(target, s.poured, this.comparison.regime)) {
          this.fire('pour');
        }
        break;
      case 'pouring':
        if (this.comparison.regime === 'boulders') {
          if (s.bouldersDone) this.fire(this.sliderAtFillIt() ? 'fill-complete' : 'target-met');
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
        // last fractional ball-volume off so the liquid reads exactly full.
        const nFloor = Math.floor(n + 1e-9);
        if (s.poured >= nFloor - 0.5 && s.live === 0 && s.melted >= nFloor - 0.5) {
          this.compareScene.topOffLiquid();
          this.fire('fill-complete');
        }
        break;
      }
      case 'complete':
        this.endCardTimer += dt;
        // Auto-present once; a dismiss (Esc / ✕) must stick — never re-raise it.
        // Defers while the picker is open (one modal at a time) and presents the
        // moment it closes.
        if (
          !this.cardPresented &&
          this.endCardTimer >= COMPARE_TUNABLES.endCardDelayS &&
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
        this.panel.showMelt(false);
        break;
      case 'complete':
        this.endCardTimer = 0;
        this.panel.showMelt(false);
        break;
    }
  }

  private sliderAtFillIt(): boolean {
    return this.slider >= 0.995;
  }

  // ---- panel refresh (~10 Hz) ---------------------------------------------

  private tickPanel(s: PourStatus): void {
    this.panel.setReadout(this.odometerText(s), this.statusLine(s));
    const n = this.comparison.n;
    this.panel.setSliderTrack(sliderForTarget(n, s.poured), this.slider, this.fillerColor());
    this.updateGhost(s);
  }

  private odometerText(s: PourStatus): string {
    // Boulders report a fractional melted volume (matches the ratio voice);
    // marbles/sand count whole balls.
    return this.comparison.regime === 'boulders' ? formatCount(s.poured) : formatOdometer(s.poured);
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
    if (this.paused) return 'paused — Esc to leave';
    switch (this.session.phase) {
      case 'settling':
        if (s.poured < 0.5 && this.comparison.regime !== 'sand') {
          return `${bodyDisplayName(this.filler)} — ${formatAcross(this.comparison.across)} across`;
        }
        // Clear the label once the pile is actually at rest (don't read "settling…"
        // for seconds after it visibly stopped).
        return s.asleepFrac < 0.92 ? 'settling…' : '';
      case 'pouring':
        if (this.comparison.regime === 'boulders') {
          return `${bodyDisplayName(this.filler)} can't fit through any opening — it melts on the glass.`;
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

    this.panel.render(this.panelState());
    this.panel.showEndCard(null);
    this.panel.setLoading(true);
    this.compareScene.setDimmed(true);

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
    this.lastStatus = null;
    this.panel.setSliderValue(0);
    this.panel.showMelt(false);
  }

  /** Textures live: fire 'ready' (→ settling), set the sub-unity/normal staging, frame. */
  private afterPairReady(): void {
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
    // Sand pairs are not pourable in P3 (P4 owns the stream). Keep the panel
    // alive with an honest note so the pair is never a dead end — swap + picker
    // stay on the sentence.
    this.panel.setNote(
      !this.comparison.subUnity && this.comparison.regime === 'sand'
        ? 'Too many to pour one by one — the sand pour is coming.'
        : null,
    );
    this.compareScene.setGhostTarget(0, this.fillerColor());
    this.frameForComparison();
  }

  private teaserText(): string {
    // "the other way round: ⟨N⟩ fit" — the count with the pair swapped.
    const swapped = buildComparison(this.filler, this.container);
    return formatCount(swapped.n);
  }

  private panelState() {
    const pourable = !this.comparison.subUnity && this.comparison.regime !== 'sand';
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
    return { container: this.container, filler: this.filler, comparison: this.comparison, pourable, presets };
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
    this.lastDefaultDistance = dist;
    this.camera.position.copy(orbitPose(VC_FRAMING.azimuthDeg, VC_FRAMING.elevationDeg, dist, this.controls.target));
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
      // Loom: glass whole in the lower third, the giant's belly overflowing the
      // top and curving out of frame. A low elevation silhouettes the wedge
      // contact (it must visibly TOUCH); a side azimuth catches the key-lit belly.
      const target = new THREE.Vector3(0, 0.55, 0);
      this.controls.target.copy(target);
      const az = -20;
      const el = 2; // near-level so the wedge contact silhouettes (isn't occluded by the vessel top)
      let dist = defaultOrbitDistance(aspect) * 1.55;
      // Guard: keep the camera OUTSIDE the giant filler (a fixed pull sits inside
      // it and renders an empty sky), pushing the distance out along the view ray.
      const fillerCenter = new THREE.Vector3(0, cy, 0);
      for (let i = 0; i < 40; i++) {
        const cam = orbitPose(az, el, dist, target);
        if (cam.distanceTo(fillerCenter) >= rf + 0.5 || dist >= this.controls.maxDistance) break;
        dist += 0.5;
      }
      dist = Math.min(dist, this.controls.maxDistance);
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
    };
  }

  devScatter(n: number): boolean {
    this.compareScene.scatter(n);
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
