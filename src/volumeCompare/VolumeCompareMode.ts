/**
 * Mode controller for the "How many fit?" volume-compare tool. Clones the
 * MoonFlight lifecycle shape — a group-visibility flip (via CompareScene),
 * onExit(cb), and activate/deactivate/update/onResize/dispose. Session-only:
 * every activate() starts a fresh session at the default pair (Fill Jupiter
 * with Earths) and touches no storage keys, ever.
 *
 * This owns the camera, its OrbitControls, the DOM panel, and the pair/session
 * state; CompareScene owns the studio content. Pair state runs through the
 * frozen pure core (buildComparison / formatCount) and the commitSession /
 * isStale reset idiom — every async texture resolve checks staleness and, if a
 * newer pick has landed, disposes what it loaded and bails.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DEG2RAD } from '../shared/math/angles';
import { CompareScene, VC_FRAMING, defaultOrbitDistance } from './CompareScene';
import { ComparePanel } from './ui/ComparePanel';
import {
  buildComparison,
  commitSession,
  isStale,
  meanRadiusKm,
  type Comparison,
  type CompareSession,
  type FillRegime,
} from './compareLogic';

const DEFAULT_CONTAINER = 'Jupiter';
const DEFAULT_FILLER = 'Earth';
const FPS_WINDOW = 60; // frames in the rolling fps average reported by devState

export interface CompareDevState {
  pair: [string, string] | null;
  n: number;
  across: number;
  regime: FillRegime;
  subUnity: boolean;
  phase: 'loading' | 'idle';
  texturesReady: boolean;
  fps: number;
  /** Measured mean luminance of the container's ghost map (0 = no ghost). */
  ghostMeanLum: number;
}

export class VolumeCompareMode {
  private camera: THREE.PerspectiveCamera;
  private compareScene: CompareScene;
  private controls: OrbitControls;
  private panel: ComparePanel;

  private active = false;
  private onExitCallback: (() => void) | null = null;

  // Pair + session state (the pure core is the source of truth).
  private session: CompareSession = commitSession(0);
  private container = DEFAULT_CONTAINER;
  private filler = DEFAULT_FILLER;
  private comparison: Comparison = buildComparison(DEFAULT_CONTAINER, DEFAULT_FILLER);
  private texturesReady = false;

  private fpsSamples: number[] = [];
  private cameraWorldPos = new THREE.Vector3();
  // The last aspect-fit default distance: resize re-fits only while the camera
  // still sits at it — a zoom the user chose is never yanked away.
  private lastDefaultDistance: number = VC_FRAMING.distance;

  // The shared top-bar wordmark: hidden while the mode runs so Leave owns the
  // top-left corner, restored on exit so the Planetarium is left exactly as found.
  private topBarPrevDisplay: string | null = null;

  private handleKeyDown = (e: KeyboardEvent) => {
    if (!this.active) return;
    if (e.key === 'Escape') this.escCascade();
  };

  constructor(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    renderer: THREE.WebGLRenderer,
    // The composer's VC bloom identity is built in main.ts (shared 0.8 / 0.92);
    // the mode takes the flag for construction parity and P3's authored glint.
    _useBloom: boolean,
  ) {
    this.camera = camera;
    this.compareScene = new CompareScene(scene, renderer);
    this.panel = new ComparePanel(() => this.requestExit());

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

  private escCascade(): void {
    // P2 has nothing else open, so Esc leaves the mode. P3 inserts the picker /
    // end-card / pause-pour rungs above this (compareLogic.escIntent).
    this.requestExit();
  }

  /**
   * Enter the mode: show the UI, own the top-left corner, enable controls, and
   * start a fresh session at the default pair. The returned promise resolves
   * only once the default pair's textures are applied — the #mode-transition
   * veil covers the load, so nothing half-loaded is ever visible.
   */
  async activate(): Promise<void> {
    this.active = true;

    const topBar = document.getElementById('top-bar');
    if (topBar) {
      this.topBarPrevDisplay = topBar.style.display;
      topBar.style.display = 'none';
    }
    const ui = document.getElementById('volume-compare-ui');
    if (ui) ui.style.display = 'block';
    this.panel.bind();

    this.compareScene.setVisible(true);
    this.controls.enabled = true;
    window.addEventListener('keydown', this.handleKeyDown);
    this.fpsSamples.length = 0;

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

    // Cancel any in-flight texture load: bumping the generation makes a pending
    // applyPair resolve see itself as stale, dispose what it loaded, and bail.
    this.session = commitSession(this.session.generation);
    this.panel.setLoading(false);
    this.compareScene.setDimmed(false);
  }

  dispose(): void {
    this.deactivate();
    this.controls.dispose();
    this.compareScene.dispose();
  }

  update(dt: number): void {
    if (!this.active) return;
    this.controls.update();
    this.camera.getWorldPosition(this.cameraWorldPos);
    this.compareScene.update(this.cameraWorldPos);
    if (dt > 0) {
      this.fpsSamples.push(1 / dt);
      if (this.fpsSamples.length > FPS_WINDOW) this.fpsSamples.shift();
    }
  }

  onResize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    // Keep the default framing responsive (phone rotation, window resize) —
    // but only while the camera still sits at the default; a user zoom sticks.
    const current = this.camera.position.distanceTo(this.controls.target);
    if (Math.abs(current - this.lastDefaultDistance) < 0.05) {
      const dist = defaultOrbitDistance(aspect);
      this.camera.position
        .sub(this.controls.target)
        .setLength(dist)
        .add(this.controls.target);
      this.lastDefaultDistance = dist;
      this.controls.update();
    }
  }

  // ---- pair commit ---------------------------------------------------------

  /**
   * Commit a pair: reset the session (generation++), render the panel, show the
   * loading state, load + apply the textures, then clear the loading state —
   * unless a newer commit has landed meanwhile, in which case the stale resolve
   * already disposed its own textures inside CompareScene and we leave the live
   * pair alone.
   */
  private async commitPair(container: string, filler: string): Promise<void> {
    this.container = container;
    this.filler = filler;
    this.comparison = buildComparison(container, filler);
    this.session = commitSession(this.session.generation);
    const gen = this.session.generation;
    this.texturesReady = false;

    this.panel.render({
      container,
      filler,
      n: this.comparison.n,
      subUnity: this.comparison.subUnity,
    });
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
  }

  private frameInitial(): void {
    this.controls.target.copy(VC_FRAMING.target);
    this.camera.up.set(0, 1, 0);
    const dist = defaultOrbitDistance(this.camera.aspect);
    this.lastDefaultDistance = dist;
    this.camera.position.copy(
      orbitPose(0, VC_FRAMING.elevationDeg, dist, VC_FRAMING.target),
    );
    this.controls.update();
  }

  // ---- dev bridge (DEV-only via window.__moon) -----------------------------

  devExit(): void {
    this.requestExit();
  }

  devPick(container: string, filler: string): boolean {
    if (meanRadiusKm(container) === null || meanRadiusKm(filler) === null) return false;
    void this.commitPair(container, filler);
    return true;
  }

  devState(): CompareDevState {
    return {
      pair: [this.container, this.filler],
      n: this.comparison.n,
      across: this.comparison.across,
      regime: this.comparison.regime,
      subUnity: this.comparison.subUnity,
      phase: this.texturesReady ? 'idle' : 'loading',
      texturesReady: this.texturesReady,
      fps: this.avgFps(),
      ghostMeanLum: this.compareScene.getGhostMeanLum(),
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

  /** The pour lands in P3; the slider is an honest stub until then. */
  devSlider(_f: number): boolean {
    return false;
  }

  /** The melt lands in P3; this is an honest stub until then. */
  devMelt(): boolean {
    return false;
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
