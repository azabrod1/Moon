/**
 * Earth's cloud field for one session, streaming by itself: the pool
 * (world/cloudFieldPool), the residency that decides which pages it holds
 * (world/cloudFieldResidency) and the measure that gives the residency its
 * demand (world/cloudFieldMeasure), wired to the live frame. PlanetariumMode
 * holds one where the field is on — imported with the pool, so a session
 * without the field loads none of it — and calls it from the frame, the warm
 * pump's turn, an arrival or a deactivation, the context handlers and the
 * `?debug=1` memory line.
 *
 * THE FRAME (`frame`, from the mode's memory passes, after the sectors have
 * reconciled). What the residency is handed, filled in place:
 * - the camera as the scene target sees it, in the deck MESH's frame and in
 *   deck radii (the mesh carries the deck's drift, so a page is addressed
 *   where the shader addresses it): its position and basis, the render
 *   camera's overscan FOV, the displayed FOV and the lens strength in force,
 *   the aspect, and the scene target's height at the TILE ratio — the grid
 *   the shader's guard is held to;
 * - the Sun's direction in the same frame;
 * - the flags: the deck hidden (the mesh not visible — its range gate or a
 *   role switch, what `fx.uCloudAbove` follows), the camera on Earth's
 *   ground (the Observatory), the deck spinning (the sectors' spin latch,
 *   world/sectorSpinGate, kept on the deck's own orientation, so it holds
 *   under `?sectors=0` and holds admissions for a moment after a clock jump),
 *   the chart, the arrival veil, and the page level's width over the width of
 *   the base rung the deck is drawn with now (its tier's, through the ladder:
 *   the map's own image is trimmed to a stand-in once its upload is paid).
 * Nothing is measured where nothing could be wanted — the deck hidden, the
 * camera on the ground — nor on a frame the chart owns, where the last
 * world frame's demand stands. A frame that will draw the deck starts the
 * dwell of every resident drawn for the first time.
 *
 * UPLOADS (`uploadTurn`, in the warm pump's place). A page goes up in two
 * steps, last in line behind the texture queue: a step takes a frame only
 * when the queue has nothing to upload, or once it has waited
 * CLOUD_PAGE_STARVE_MS, when the pump sits that frame out; one step a frame
 * at most, on the pump's own repay ledger (textureWarmer `takeWarmTurn`),
 * never in an unbudgeted drain and never under the veil.
 *
 * SECTORS FIRST. A page starts only while a sector load slot is free
 * (sectorStreamer `loadSlotsFull`, read after the same frame's reconcile);
 * under `?sectors=0` nothing is busy.
 *
 * LIFECYCLE. `cancelInFlight` on an arrival and on deactivation: the load
 * aborted, a decoded page or its half-written layer dropped, every resident
 * kept, so a return finds its pages. `contextLost` and `contextRestored` from
 * the mode's handlers; a restore whose re-allocation fails reports it, for the
 * mode to turn the field off.
 *
 * BY HAND (development only): `setAuto(false)` hands the pool to the bridge
 * (world/cloudFieldDev), the residency's entries and layers cleared and its
 * updates and uploads stopped; `setAuto(true)` hands it back with the table
 * cleared, and pages stream in again from demand.
 *
 * Nothing is allocated per frame: the camera, the Sun, the frame and the
 * spin latch are this object's own, filled in place, and the matrix and
 * vectors are scratch members.
 */
import * as THREE from 'three';
import { CLOUD_FIELD_GRID, CLOUD_FIELD_LEVEL_WIDTH } from './cloudField';
import { CloudFieldMeasure, type FieldCamera } from './cloudFieldMeasure';
import { CloudFieldPool, type CloudFieldAllocation, type CloudPage } from './cloudFieldPool';
import {
  CloudFieldResidency, type CloudFieldFrame, type CloudFieldResidencyStats,
} from './cloudFieldResidency';
import { advanceSpinLatch, type SectorSpinLatch } from './sectorSpinGate';
import { materialColorWidth } from './textureLadder';
import { takeWarmTurn, textureWarmIdle } from './textureWarmer';
import { displayFovDeg } from '../../shared/math/lensProjection';
import { debugWarn } from '../../shared/debug';

/** A page upload step waiting this long takes the next frame from the texture
 *  queue, which sits that frame out: a queue that never empties must not
 *  hold a decoded page in memory for ever. */
export const CLOUD_PAGE_STARVE_MS = 500;

const PAGES = CLOUD_FIELD_GRID[0] * CLOUD_FIELD_GRID[1];

type Vec3 = [number, number, number];

/** The measure's camera, written in place each frame. */
interface LiveFieldCamera extends FieldCamera {
  pos: Vec3;
  right: Vec3;
  up: Vec3;
  back: Vec3;
}

export class CloudFieldSession {
  readonly pool: CloudFieldPool;
  private readonly measure = new CloudFieldMeasure();
  private readonly residency: CloudFieldResidency<CloudPage>;
  private readonly cam: LiveFieldCamera = {
    pos: [0, 0, 2], right: [1, 0, 0], up: [0, 1, 0], back: [0, 0, 1],
    renderFovDeg: 60, designFovDeg: 60, lensStrength: 0, aspect: 1, heightPx: 1,
  };
  private readonly sun: Vec3 = [1, 0, 0];
  private readonly frameIn: CloudFieldFrame = {
    nowMs: 0, ratio: 0, hidden: true, grounded: false, spinning: false, chart: false, veil: false,
  };
  private spin: SectorSpinLatch | null = null;
  private auto = true;
  // The upload turn's page step, bound once.
  private turnNowMs = 0;
  private readonly step = (): void => { this.residency.uploadStep(this.turnNowMs); };
  // Scratch.
  private readonly inverse = new THREE.Matrix4();
  private readonly worldQuat = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly centre = new THREE.Vector3();
  private deckRadius = 0;
  private deckOf: THREE.Mesh | null = null;
  // What the bridge reads.
  loadsStarted = 0;
  loadsDecoded = 0;
  frameMicros = 0;

  private constructor(pool: CloudFieldPool, wantTexelPx: number, sectorsBusy: () => boolean) {
    this.pool = pool;
    this.residency = new CloudFieldResidency<CloudPage>({
      layers: pool.layerCount,
      wantTexelPx,
      load: (page, signal) => {
        this.loadsStarted += 1;
        return pool.load(page, signal).then((decoded) => {
          this.loadsDecoded += 1;
          return decoded;
        });
      },
      upload: (decoded, layer, step) => pool.upload(decoded, layer, step),
      writeEntry: (page, r, g) => pool.writeEntry(page, r, g),
      sectorsBusy,
      warn: debugWarn,
      clock: () => performance.now(),
    });
  }

  /**
   * Allocate the pool and build the session round it. On a GL error only the
   * report comes back, for the caller to turn the field off.
   */
  static allocate(
    renderer: THREE.WebGLRenderer, layers: number, wantTexelPx: number, sectorsBusy: () => boolean,
  ): { session: CloudFieldSession | null; report: CloudFieldAllocation } {
    const { pool, report } = CloudFieldPool.allocate(renderer, layers);
    return { session: pool ? new CloudFieldSession(pool, wantTexelPx, sectorsBusy) : null, report };
  }

  /**
   * One frame's residency. `deck` is Earth's cloud deck (null before it is
   * built), `heightPx` the canvas's CSS height times the tile ratio,
   * `willDraw` whether this tick ends in a drawn frame.
   */
  frame(
    deck: THREE.Mesh | null, camera: THREE.PerspectiveCamera, sun: THREE.Object3D, nowMs: number,
    heightPx: number, grounded: boolean, chart: boolean, veil: boolean, willDraw: boolean,
  ): void {
    if (!this.auto) return;
    const t0 = performance.now();
    const f = this.frameIn;
    f.nowMs = nowMs;
    f.grounded = grounded;
    f.chart = chart;
    f.veil = veil;
    f.hidden = deck === null || !deck.visible;
    if (deck) {
      deck.getWorldQuaternion(this.worldQuat); // refreshes matrixWorld too
      if (!this.spin) this.spin = { quat: this.worldQuat.clone(), tMs: nowMs, heldUntilMs: 0 };
      f.spinning = advanceSpinLatch(this.spin, this.worldQuat, nowMs);
      const width = materialColorWidth(deck.material as THREE.Material);
      f.ratio = width > 0 ? CLOUD_FIELD_LEVEL_WIDTH / width : 0;
      if (!chart && !f.hidden && !grounded) {
        this.fillCamera(deck, camera, heightPx);
        this.fillSun(deck, sun);
        this.measure.measure(this.cam, this.sun);
      }
    }
    this.residency.update(f, this.measure, null);
    if (willDraw && !f.hidden && !chart) this.residency.deckDrawn(nowMs);
    this.frameMicros = (performance.now() - t0) * 1000;
  }

  /** The camera in the deck mesh's frame, in deck radii. */
  private fillCamera(deck: THREE.Mesh, camera: THREE.PerspectiveCamera, heightPx: number): void {
    if (this.deckOf !== deck) {
      this.deckOf = deck;
      this.deckRadius = (deck.geometry as THREE.SphereGeometry).parameters.radius;
    }
    const inv = this.inverse.copy(deck.matrixWorld).invert();
    const c = this.cam;
    const v = this.v.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inv).divideScalar(this.deckRadius);
    c.pos[0] = v.x; c.pos[1] = v.y; c.pos[2] = v.z;
    this.v.setFromMatrixColumn(camera.matrixWorld, 0).transformDirection(inv);
    c.right[0] = this.v.x; c.right[1] = this.v.y; c.right[2] = this.v.z;
    this.v.setFromMatrixColumn(camera.matrixWorld, 1).transformDirection(inv);
    c.up[0] = this.v.x; c.up[1] = this.v.y; c.up[2] = this.v.z;
    this.v.setFromMatrixColumn(camera.matrixWorld, 2).transformDirection(inv);
    c.back[0] = this.v.x; c.back[1] = this.v.y; c.back[2] = this.v.z;
    const lens = camera.userData.lens as { strength: number; effectiveStrength?: number } | undefined;
    c.renderFovDeg = camera.fov;
    c.designFovDeg = displayFovDeg(camera);
    c.lensStrength = lens ? lens.effectiveStrength ?? lens.strength : 0;
    c.aspect = camera.aspect;
    c.heightPx = heightPx;
  }

  /** The Sun's direction from the deck's centre, in the deck mesh's frame. */
  private fillSun(deck: THREE.Mesh, sun: THREE.Object3D): void {
    this.centre.setFromMatrixPosition(deck.matrixWorld);
    sun.getWorldPosition(this.v).sub(this.centre).transformDirection(this.inverse);
    this.sun[0] = this.v.x; this.sun[1] = this.v.y; this.sun[2] = this.v.z;
  }

  /**
   * The warm pump's place in the frame: one page upload step, when the
   * residency has one ready and the frame is the field's to take. Returns
   * whether the field took the frame's turn — the pump then sits it out,
   * whether or not the ledger let the step run, since the pump's own call
   * would have answered to the same ledger.
   */
  uploadTurn(nowMs: number, budgetMs: number, frameIntervalMs: number): boolean {
    if (!this.auto || !this.residency.uploadReady()) return false;
    if (!textureWarmIdle() && this.residency.uploadWaitMs(nowMs) < CLOUD_PAGE_STARVE_MS) return false;
    this.turnNowMs = nowMs;
    takeWarmTurn(budgetMs, frameIntervalMs, 'cloud field page', this.step);
    return true;
  }

  /** An arrival, a tool visit or a mode switch: work in flight given up,
   *  residents kept. */
  cancelInFlight(): void {
    this.residency.cancelInFlight();
  }

  contextLost(): void {
    this.pool.contextLost();
    this.residency.contextLost();
  }

  /** The pool allocated again and checked; on success pages stream back in.
   *  The report says whether it failed, for the caller to turn the field off. */
  contextRestored(): CloudFieldAllocation {
    const report = this.pool.contextRestored();
    if (report.glError === 0) this.residency.contextRestored();
    return report;
  }

  stats(): Readonly<CloudFieldResidencyStats> {
    return this.residency.stats();
  }

  /** Development only: hand the pool to the bridge (false) or take it back
   *  (true), the table cleared either way. */
  setAuto(on: boolean): void {
    if (on === this.auto) return;
    this.auto = on;
    if (!on) {
      this.residency.clear();
      return;
    }
    for (let p = 0; p < PAGES; p++) this.pool.writeEntry(p, 0, 0);
  }

  get isAuto(): boolean {
    return this.auto;
  }

  /** Development only: the residency's numbers and the wanted pages with the
   *  page texels a pixel spans on each. */
  devState(): Record<string, unknown> {
    const stats = this.residency.stats();
    const wanted: Array<{ page: string; T: number }> = [];
    for (let p = 0; p < PAGES; p++) {
      if (!this.residency.isWanted(p)) continue;
      const col = p % CLOUD_FIELD_GRID[0];
      wanted.push({ page: `${col}_${(p - col) / CLOUD_FIELD_GRID[0]}`, T: +this.measure.wantTexels[p].toFixed(3) });
    }
    const inPipe = stats.pipe === 'decoded' || stats.pipe === 'uploading' ? 1 : 0;
    return {
      auto: this.auto,
      ...stats,
      loadsStarted: this.loadsStarted,
      loadsDecoded: this.loadsDecoded,
      droppedAfterDecode: this.loadsDecoded - stats.admissions - inPipe,
      wantedPages: wanted,
      frame: { ...this.frameIn },
      frameMicros: +this.frameMicros.toFixed(1),
    };
  }
}
