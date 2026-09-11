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
 * others switchable, devModel for now), a poorly constrained or not yet
 * modelled body draws an unresolved whole with its bulk line — an
 * illustrative scenario only on request, and labelled.
 *
 * Session-only: every activate() opens on the body it is handed and
 * touches no storage keys. Body changes run under a generation guard, the
 * compare studio's idiom: every async map resolve checks staleness and, if
 * a newer pick landed, disposes what it loaded and bails.
 *
 * The presentation clock is the tool's own: the cut animation and the
 * pattern drift run on it, never on the solar-system clock, and the dev
 * bridge can set and freeze it so a capture is reproducible.
 *
 * The inspector and the evidence popover (phase 1B) and Temperature mode
 * (phase 2B) are still to come; the legend reads the schema already.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DEG2RAD } from '../shared/math/angles';
import { isPhoneViewport } from '../shared/dom';
import { debugLog, debugWarn } from '../shared/debug';
import { bodyDisplayName } from '../planetarium/surfaceView';
import { InteriorScene, resolveInteriorBody, BODY_RADIUS, type InteriorBody } from './InteriorScene';
import {
  CUT_VIEWS,
  CUT_VIEW_ANGLE_DEG,
  MAX_OPENING_ANGLE_DEG,
  computeCutFrame,
  createCutFrame,
  cutViewForAngle,
  openingAngleDegToRad,
  yawCutFrame,
  type CutView,
} from './cutFrame';
import {
  READABLE_MIN_PX,
  framingDistance,
  minDisplayFraction,
  projectedRadiusPx,
  readableRemap,
  toDisplayFraction,
  type ReadableRemap,
} from './interiorGeometry';
import { COVERAGE_BADGE, INTERIOR_DEFAULT_BODY, coverageFor, coverageStateFor, defaultModelFor, modelFor } from './data/interiorRegistry';
import { coverageBulk, type Coverage, type CoverageState } from './data/interiorTypes';
import { drawnFromModel, drawnUnresolved, outerFractionsInsideOut, type DrawnModel } from './drawnModel';
import { BodyPicker } from '../planetarium/ui/BodyPicker';
import { artParamsFor, depthTint, incandescence, swatchHex, type ArtParams } from './data/artParams';
import type { SectionRegionLook } from './rendering/sectionMaterial';

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

/** The cut opens and closes over this long, on an ease-in-out. */
const CUT_ANIMATION_S = 0.9;
/** The wedge is turned this far off the view axis, so the viewer looks at
 *  its near face and along its terraces rather than straight into the crease. */
const WEDGE_YAW_DEG = 22;
/** The Readable blend eases over this long. */
const SCALE_BLEND_S = 0.5;
const FPS_WINDOW = 60;
/** Recompute the remap when the projected radius moves this much. */
const REMAP_PX_TOLERANCE = 0.5;

export interface InteriorDevRegion {
  key: string;
  name: string;
  outerKm: number;
  /** Outer radius as drawn, a fraction of the disc. */
  displayOuter: number;
}

export interface InteriorDevState {
  bodyId: string;
  /** The drawn model's id, or null for the unresolved whole. */
  modelId: string | null;
  coverage: CoverageState;
  illustrative: boolean;
  view: CutView | null;
  openingAngleDeg: number;
  targetAngleDeg: number;
  readable: boolean;
  scaleBlend: number;
  projectedRadiusPx: number;
  presentationSeconds: number;
  frozen: boolean;
  loading: boolean;
  ready: boolean;
  fps: number;
  regions: InteriorDevRegion[];
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function formatKm(km: number): string {
  if (km < 10) return km.toFixed(1);
  return Math.round(km).toLocaleString('en-US');
}

/** The one line under the body chip: what is drawn and how much to trust it. */
function captionFor(coverage: Coverage, drawn: DrawnModel): string {
  const radius = `radius ${formatKm(drawn.referenceRadiusKm)} km`;
  const model = drawn.model;
  if (model) {
    const review = model.review === 'reviewed' ? 'Reviewed model' : 'Provisional model';
    if (model.illustrative) return `Illustrative scenario, not a measurement · ${radius}`;
    if (coverage.state === 'competing') return `${review}, one of ${coverage.models.length} · ${radius}`;
    return `${review} · ${radius}`;
  }
  const bulk = coverageBulk(coverage)?.densityKgM3 ?? null;
  const density = bulk ? `bulk density ${Math.round(bulk.value).toLocaleString('en-US')} kg/m³` : 'no measured density';
  const lead = coverage.state === 'notYetModelled' ? 'Not yet modelled here' : 'Interior unresolved';
  return `${lead} · ${density}`;
}

/** The legend row for the unresolved whole. */
function unresolvedComposition(coverage: Coverage): string {
  return coverage.state === 'notYetModelled' ? 'Not yet modelled here' : 'Not measured';
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

export class InteriorMode {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly interiorScene: InteriorScene;
  private readonly controls: OrbitControls;
  private readonly isMultisampled: () => boolean;

  private active = false;
  private onExitCallback: (() => void) | null = null;
  private generation = 0;
  private loading = false;

  private body: InteriorBody | null = null;
  private coverage: Coverage = coverageFor(INTERIOR_DEFAULT_BODY);
  private drawn: DrawnModel = drawnUnresolved(INTERIOR_DEFAULT_BODY, 1, '');
  private readonly picker: BodyPicker;
  private utcMs = Date.now();

  // The cut.
  private readonly frame = createCutFrame();
  private angleDeg = 0;
  private angleFromDeg = 0;
  private angleToDeg = CUT_VIEW_ANGLE_DEG.cutaway;
  private angleElapsedS = CUT_ANIMATION_S;

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
    this.interiorScene = new InteriorScene(scene, renderer, floatCapable);

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
      includeSun: false, // the Sun waits for its own model (plan §9, phase 3)
      renderTitle: (title) => {
        const strong = document.createElement('b');
        strong.textContent = 'Look inside';
        title.append(strong, document.createTextNode(' another world'));
      },
      rowBadge: (name) => {
        const pill = document.createElement('span');
        const state = coverageStateFor(name);
        const drawnByDefault = state === 'constrained' || state === 'competing';
        pill.className = 'pk-tag-cover' + (drawnByDefault ? ' on' : '');
        pill.textContent = COVERAGE_BADGE[state];
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

    this.interiorScene.setEdgeMode(this.isMultisampled());
    this.interiorScene.setVisible(true);
    this.controls.enabled = true;
    window.addEventListener('keydown', this.handleKeyDown);
    this.fpsSamples.length = 0;
    this.presentationSeconds = 0;
    this.frozen = false;

    this.frameInitial();
    // Open closed, then swing to the default view once the map is on: the
    // reveal. Phones open on Section, the view that reads at a small size.
    this.angleDeg = 0;
    this.setTargetAngle(0, false);
    await this.commitBody(bodyId);
    if (!this.active) return;
    this.setTargetAngle(CUT_VIEW_ANGLE_DEG[isPhoneViewport() ? 'section' : 'cutaway'], true);
  }

  deactivate(): void {
    this.active = false;
    this.generation++; // cancels any in-flight map load
    this.loading = false;
    this.interiorScene.setVisible(false);
    this.picker.close();
    const ui = document.getElementById('interior-ui');
    if (ui) ui.style.display = 'none';
    this.controls.enabled = false;
    window.removeEventListener('keydown', this.handleKeyDown);
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
    this.controls.update();

    // The cut frame follows the camera continuously (plan §5): hinge = the
    // camera's own up, so nothing snaps through the poles.
    tmpLocalUp.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
    computeCutFrame(this.camera.position, tmpLocalUp, ORIGIN, openingAngleDegToRad(this.angleDeg), this.frame);
    yawCutFrame(this.frame, WEDGE_YAW_DEG * DEG2RAD);
    this.interiorScene.applyCut(this.frame);
    this.interiorScene.updateForCamera(this.camera);

    this.projectedPx = projectedRadiusPx(
      BODY_RADIUS,
      this.camera.position.distanceTo(ORIGIN),
      this.camera.fov,
      window.innerHeight,
    );
    this.refreshRemapIfNeeded();
  }

  private advanceCut(dt: number): void {
    if (this.angleElapsedS >= CUT_ANIMATION_S) {
      this.angleDeg = this.angleToDeg;
      return;
    }
    this.angleElapsedS = Math.min(CUT_ANIMATION_S, this.angleElapsedS + dt);
    const t = easeInOutCubic(this.angleElapsedS / CUT_ANIMATION_S);
    this.angleDeg = this.angleFromDeg + (this.angleToDeg - this.angleFromDeg) * t;
    this.syncAngleReadout();
  }

  private advanceScale(dt: number): void {
    if (this.scaleBlend === this.scaleBlendTarget) return;
    const step = dt / SCALE_BLEND_S;
    this.scaleBlend = this.scaleBlend < this.scaleBlendTarget
      ? Math.min(this.scaleBlendTarget, this.scaleBlend + step)
      : Math.max(this.scaleBlendTarget, this.scaleBlend - step);
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
    const fractions = outerFractionsInsideOut(this.drawn);
    const remap = readableRemap(fractions, minDisplayFraction(READABLE_MIN_PX, this.projectedPx), this.scaleBlend);
    this.remap = remap;
    const artInsideOut = this.regionArt();
    const looks: SectionRegionLook[] = this.drawn.regionsInsideOut.map((region, index) => {
      // A physical transition's width, through the same remap as its boundary.
      const halfPhysical = region.transitionKm / (2 * this.drawn.referenceRadiusKm);
      const blendDisplay = halfPhysical > 0
        ? (toDisplayFraction(remap, fractions[index] + halfPhysical) - toDisplayFraction(remap, fractions[index] - halfPhysical)) / 2
        : 0;
      return {
        outerDisplay: toDisplayFraction(remap, fractions[index]),
        blendDisplay,
        art: artInsideOut[index],
        // An unknown temperature is cold, never a guessed glow; Temperature
        // mode will hatch it (phase 2B).
        heat: incandescence(region.temperatureK ?? 0),
      };
    });
    this.interiorScene.applyRegions(looks);
  }

  /** Each region's look, inside-out like the drawn model, with the family
   *  depth tint applied — the one place the legend and the faces get their colours. */
  private regionArt(): ArtParams[] {
    const reference = this.drawn.referenceRadiusKm;
    return this.drawn.regionsInsideOut.map((region) => {
      const depthMidFraction = 1 - (region.outerRadiusKm + region.innerRadiusKm) / (2 * reference);
      return depthTint(artParamsFor(region.family, region.phase), region.family, depthMidFraction);
    });
  }

  // ---- the cut and the scale ----------------------------------------------

  private setTargetAngle(deg: number, animate: boolean): void {
    const target = THREE.MathUtils.clamp(deg, 0, MAX_OPENING_ANGLE_DEG);
    this.angleFromDeg = this.angleDeg;
    this.angleToDeg = target;
    this.angleElapsedS = animate ? 0 : CUT_ANIMATION_S;
    if (!animate) this.angleDeg = target;
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

  private async commitBody(bodyId: string): Promise<boolean> {
    let body = resolveInteriorBody(bodyId);
    if (!body) {
      debugWarn('Look inside: unknown body, opening Earth instead', { bodyId });
      body = resolveInteriorBody(INTERIOR_DEFAULT_BODY)!;
    }
    const generation = ++this.generation;
    this.loading = true;
    this.body = body;
    this.coverage = coverageFor(body.id);
    const model = defaultModelFor(body.id);
    this.drawn = model
      ? drawnFromModel(model)
      : drawnUnresolved(body.id, body.radiusKm, unresolvedComposition(this.coverage));
    this.remap = null; // the new model's boundaries go out on the next frame
    this.renderPanel();
    this.interiorScene.setPose(body, this.utcMs);
    const applied = await this.interiorScene.loadBody(body, () => generation !== this.generation);
    if (generation !== this.generation) return false;
    this.loading = false;
    debugLog('Look inside: body applied', { bodyId: body.id, applied });
    return applied;
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
  }

  private renderPanel(): void {
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
    const legend = document.getElementById('interior-legend');
    if (legend) {
      legend.replaceChildren();
      const art = this.regionArt();
      // The legend reads outside-in, the way a reader meets the layers.
      for (let index = this.drawn.regionsInsideOut.length - 1; index >= 0; index--) {
        const region = this.drawn.regionsInsideOut[index];
        const depthTop = this.drawn.referenceRadiusKm - region.outerRadiusKm;
        const depthBottom = this.drawn.referenceRadiusKm - region.innerRadiusKm;
        const row = document.createElement('div');
        row.className = 'interior-row';
        row.dataset.region = region.key;
        const swatch = document.createElement('i');
        swatch.className = 'interior-swatch';
        const swatchColor = swatchHex(art[index], incandescence(region.temperatureK ?? 0));
        swatch.style.background = `#${swatchColor.toString(16).padStart(6, '0')}`;
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
        legend.append(row);
      }
    }
    this.syncViewButtons();
    this.syncAngleReadout();
    this.setReadable(this.readable);
  }

  private syncViewButtons(): void {
    const current = cutViewForAngle(this.angleToDeg);
    for (const view of CUT_VIEWS) {
      document.getElementById(`interior-view-${view}`)?.classList.toggle('on', view === current);
    }
  }

  private syncAngleReadout(): void {
    const slider = document.getElementById('interior-angle') as HTMLInputElement | null;
    if (slider && document.activeElement !== slider) slider.value = String(Math.round(this.angleDeg));
    const readout = document.getElementById('interior-angle-value');
    if (readout) readout.textContent = `${Math.round(this.angleDeg)}°`;
  }

  /** The Esc cascade: the picker first, then the tool itself. */
  private handleKeyDown = (event: KeyboardEvent) => {
    if (!this.active) return;
    if (event.key !== 'Escape') return;
    if (this.picker.isOpen()) {
      this.picker.close();
      return;
    }
    this.requestExit();
  };

  private openPicker(): void {
    if (!this.active) return;
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

  /** True only once the map is applied and the cut has settled. */
  devReady(): boolean {
    return this.active && !this.loading && this.angleElapsedS >= CUT_ANIMATION_S && this.scaleBlend === this.scaleBlendTarget;
  }

  /** Draw a named model of the current body (a competing alternative, or a
   *  poorly constrained body's illustrative scenario). The UI switch is phase 2B. */
  devModel(modelId: string): boolean {
    if (!this.active || !this.body) return false;
    const model = modelFor(this.body.id, modelId);
    if (!model) return false;
    this.drawn = drawnFromModel(model);
    this.remap = null;
    this.renderPanel();
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
      view: cutViewForAngle(this.angleDeg),
      openingAngleDeg: this.angleDeg,
      targetAngleDeg: this.angleToDeg,
      readable: this.readable,
      scaleBlend: this.scaleBlend,
      projectedRadiusPx: this.projectedPx,
      presentationSeconds: this.presentationSeconds,
      frozen: this.frozen,
      loading: this.loading,
      ready: this.devReady(),
      fps: this.avgFps(),
      regions: regionsInsideOut.map((region, index) => ({
        key: region.key,
        name: region.name,
        outerKm: region.outerRadiusKm,
        displayOuter: this.remap ? toDisplayFraction(this.remap, fractions[index]) : fractions[index],
      })),
    };
  }

  private avgFps(): number {
    if (this.fpsSamples.length === 0) return 0;
    let sum = 0;
    for (const sample of this.fpsSamples) sum += sample;
    return sum / this.fpsSamples.length;
  }
}
