/**
 * Spike S1 throwaway code (docs/descent/ROADMAP.md) — replaced by the production
 * DescentMode in P1. The surviving artifact is the shell refactor this exercises
 * (src/app/renderPipeline.ts).
 *
 * Thin controller: owns the sky/world scenes, the descent camera, and the fly
 * 450 km → 2 m proof. Renders through the shell's per-mode pass list; restores
 * the shared renderer's toneMappingExposure + autoClear exactly on exit (an AC).
 */
import * as THREE from 'three';
import { debugWarn } from '../../../shared/debug';
import type { ScenePassSpec } from '../../../app/renderPipeline';
import { computeNearFar, MOON_RADIUS_M } from './frames';
import { SpikeWorld, BODY_RADIUS_M } from './spikeWorld';
import { SpikeSky } from './spikeSky';

const START_ALT_M = 450_000;
const MIN_ALT_M = 2;
const RELIEF_M = 4_500; // worst-case Mons-Hadley-class relief for the far-plane stress
const DESCENT_TAU_S = 6; // exp ease 450 km → 2 m over ~74 s
const RING = 240; // frame-time ring buffer length
// Nominal exposure: at EV +2 the sun light (2.2·2^EV = 8.8) lands sunlit terrain
// at ~0.4–0.8 pre-bloom radiance — well lit, and BELOW the 1.0 bloom threshold
// (the "terrain never blooms" operating point). Cranking EV higher is the stress.
const NOMINAL_EV = 2;
// A fixed post-bloom final grade the mode applies to toneMappingExposure and
// restores on exit. It grades the composited image only (OutputPass runs AFTER
// bloom, so it can't push terrain over the threshold) — its real job here is to
// exercise the shared-renderer-state save/restore contract (an AC).
const MODE_TONEMAP_GRADE = 1.2;

function isDev(): boolean {
  try {
    return Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);
  } catch {
    return false;
  }
}

export interface SpikeDevState {
  altM: number;
  near: number;
  far: number;
  frameMsAvg: number;
  frameMsP95: number;
  drawCalls: number;
  exposureEV: number;
  naive: boolean;
  paused: boolean;
}

export class SpikeS1Mode {
  readonly camera: THREE.PerspectiveCamera;

  private renderer: THREE.WebGLRenderer;
  private world: SpikeWorld | null = null;
  private sky: SpikeSky | null = null;
  private active = false;

  private altitude = START_ALT_M;
  private yawDeg = 0;
  private pitchDeg = 0;
  private paused = false;
  private exposureEV = NOMINAL_EV;

  private savedExposure = 1;
  private savedAutoClear = true;

  private hud: HTMLDivElement | null = null;
  private hudClock = 0;

  private frameMs: number[] = [];
  private lastFrameNow = 0;
  private onExitCallback: (() => void) | null = null;

  private _look = new THREE.Vector3();
  private _horiz = new THREE.Vector3();
  private _camPos = { x: 0, y: 0, z: 0 };

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.4, 2_000_000);
  }

  private ensureBuilt(): void {
    if (this.world) return;
    this.world = new SpikeWorld(this.renderer);
    this.sky = new SpikeSky();
  }

  /** Sky first, then world with a fresh depth range (the two-pass split). */
  scenePasses(): ScenePassSpec[] {
    this.ensureBuilt();
    return [{ scene: this.sky!.scene }, { scene: this.world!.scene, clearDepthBefore: true }];
  }

  onExit(cb: () => void): void {
    this.onExitCallback = cb;
  }

  // ---- lifecycle -----------------------------------------------------------

  async activate(): Promise<void> {
    this.ensureBuilt();
    this.savedExposure = this.renderer.toneMappingExposure;
    this.savedAutoClear = this.renderer.autoClear;
    // Mode grade (restored on exit) — a distinct value so the restore is verifiable.
    this.renderer.toneMappingExposure = MODE_TONEMAP_GRADE;

    this.active = true;
    this.altitude = START_ALT_M;
    this.yawDeg = 0;
    this.pitchDeg = 0;
    this.paused = false;
    this.exposureEV = NOMINAL_EV;
    this.frameMs.length = 0;
    this.lastFrameNow = performance.now();

    window.addEventListener('keydown', this.handleKey);
    this.showHud();
    this.poseAndFrame();
  }

  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    window.removeEventListener('keydown', this.handleKey);
    this.hideHud();

    // Restore shared renderer state EXACTLY (the AC).
    this.renderer.toneMappingExposure = this.savedExposure;
    this.renderer.autoClear = this.savedAutoClear;
    if (isDev() && this.renderer.toneMappingExposure !== this.savedExposure) {
      debugWarn('SpikeS1Mode: toneMappingExposure not restored on exit');
    }

    // Geometry/material disposal (leak hygiene); rebuilt on the next entry.
    this.world?.dispose();
    this.sky?.dispose();
    this.world = null;
    this.sky = null;
  }

  onResize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  // ---- per-frame -----------------------------------------------------------

  update(dt: number): void {
    if (!this.active || !this.world || !this.sky) return;
    if (!this.paused) {
      this.altitude = Math.max(MIN_ALT_M, this.altitude * Math.exp(-dt / DESCENT_TAU_S));
    }
    this.poseAndFrame();

    const now = performance.now();
    this.frameMs.push(now - this.lastFrameNow);
    this.lastFrameNow = now;
    if (this.frameMs.length > RING) this.frameMs.shift();

    this.hudClock += dt;
    if (this.hudClock >= 0.1) { this.renderHud(); this.hudClock = 0; }
  }

  /** Camera-relative pose + world/sky offsets + dynamic near/far. */
  private poseAndFrame(): void {
    if (!this.world || !this.sky) return;
    const alt = this.altitude;
    // Camera on the site zenith line, above the TERRAIN (not the bare datum).
    this._camPos.x = 0;
    this._camPos.y = BODY_RADIUS_M + this.world.siteGroundHeightM() + alt;
    this._camPos.z = 0;

    // Look blend: near-nadir high up → near-horizon (slightly-up to catch Earth)
    // below ~500 m. Manual yaw/pitch offsets ride on top for QA framing.
    const t = THREE.MathUtils.clamp(
      (Math.log(alt) - Math.log(MIN_ALT_M)) / (Math.log(500) - Math.log(MIN_ALT_M)),
      0, 1,
    );
    const basePitch = THREE.MathUtils.lerp(2, -82, t);
    const az = (0 + this.yawDeg) * THREE.MathUtils.DEG2RAD;
    const pitch = (basePitch + this.pitchDeg) * THREE.MathUtils.DEG2RAD;
    this._horiz.set(Math.sin(az), 0, -Math.cos(az)); // east·sin + north·cos, north = −Z
    this._look.copy(this._horiz).multiplyScalar(Math.cos(pitch));
    this._look.y = Math.sin(pitch);

    this.camera.up.set(0, 1, 0);
    this.camera.position.set(0, 0, 0); // camera-relative: camera at scene origin
    this.camera.lookAt(this._look);

    this.world.update(this._camPos, this.exposureEV);
    this.sky.setExposure(this.exposureEV);

    const { near, far } = computeNearFar(alt, RELIEF_M, MOON_RADIUS_M);
    this.camera.near = near;
    this.camera.far = far;
    this.camera.updateProjectionMatrix();
  }

  // ---- keys ----------------------------------------------------------------

  private handleKey = (e: KeyboardEvent): void => {
    if (!this.active) return;
    if (e.key === 'Escape') { this.onExitCallback?.(); }
    else if (e.key === ' ') { this.paused = !this.paused; }
    else if (e.key === 'r' || e.key === 'R') { this.altitude = START_ALT_M; this.paused = false; }
  };

  // ---- dev HUD -------------------------------------------------------------

  private showHud(): void {
    if (!this.hud) {
      const el = document.createElement('div');
      el.id = 'spike-s1-hud';
      el.style.cssText = [
        'position:fixed', 'top:12px', 'left:12px', 'z-index:20',
        'font:12px/1.5 ui-monospace,monospace', 'color:#cfe',
        'background:rgba(8,10,16,0.62)', 'padding:8px 11px', 'border-radius:6px',
        'border:1px solid rgba(150,180,220,0.25)', 'pointer-events:none', 'white-space:pre',
      ].join(';');
      document.body.appendChild(el);
      this.hud = el;
    }
    this.hud.style.display = 'block';
    this.renderHud();
  }

  private renderHud(): void {
    if (!this.hud) return;
    const s = this.devState();
    const altStr = s.altM >= 1000 ? `${(s.altM / 1000).toFixed(1)} km` : `${s.altM.toFixed(1)} m`;
    this.hud.textContent =
      `DESCENT SPIKE S1\n` +
      `alt   ${altStr}\n` +
      `near  ${s.near.toFixed(2)} m\n` +
      `far   ${(s.far / 1000).toFixed(1)} km\n` +
      `frame ${s.frameMsAvg.toFixed(1)} ms (p95 ${s.frameMsP95.toFixed(1)})\n` +
      `EV    ${s.exposureEV >= 0 ? '+' : ''}${s.exposureEV}\n` +
      `naive ${s.naive ? 'ON (jitter)' : 'off'}${s.paused ? '  [PAUSED]' : ''}`;
  }

  private hideHud(): void {
    if (this.hud) this.hud.style.display = 'none';
  }

  // ---- dev bridge ----------------------------------------------------------

  devState(): SpikeDevState {
    const sorted = this.frameMs.slice().sort((a, b) => a - b);
    const avg = sorted.length ? sorted.reduce((s, v) => s + v, 0) / sorted.length : 0;
    const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
    return {
      altM: this.altitude,
      near: this.camera.near,
      far: this.camera.far,
      frameMsAvg: avg,
      frameMsP95: p95,
      drawCalls: this.renderer.info.render.calls,
      exposureEV: this.exposureEV,
      naive: this.world?.isNaive() ?? false,
      paused: this.paused,
    };
  }

  setAlt(m: number): void { this.altitude = THREE.MathUtils.clamp(m, MIN_ALT_M, START_ALT_M); }
  setLook(yawDeg: number, pitchDeg: number): void { this.yawDeg = yawDeg; this.pitchDeg = pitchDeg; }
  setExposureEV(ev: number): void { this.exposureEV = ev; }
  setPaused(p: boolean): void { this.paused = p; }
  setNaive(on: boolean): void { this.world?.setNaive(on); }
}
