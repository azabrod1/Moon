import * as THREE from 'three';

export interface MoonFlightActivationProgress {
  completedUnits: number;
  totalUnits: number;
}

export const FIRST_MOON_FLIGHT_ACTIVATION_TOTAL_UNITS = 1;

/**
 * Moon flight mode.
 *
 * Phase 1: mode shell only. A placeholder lunar sphere + directional light
 * so we can verify mode entry/exit, loading UI, composer swap, and disposal
 * work correctly before adding the real asset pipeline in later phases.
 *
 * Integration contract (mirrors ExploreMode):
 *   - ctor is cheap; all heavy work happens in activate()
 *   - activate(onProgress) is idempotent and reports loader progress
 *   - deactivate() hides content and DOM but keeps GPU resources for fast re-entry
 *   - dispose() releases every GPU/DOM resource this mode owns
 */
export class MoonFlightMode {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;

  private group: THREE.Group;
  private moon: THREE.Mesh | null = null;
  private sunLight: THREE.DirectionalLight | null = null;
  private ambient: THREE.AmbientLight | null = null;

  private loaded = false;
  private active = false;
  private uiEl: HTMLElement | null = null;
  private onExitCallback: (() => void) | null = null;
  private handleKeyDown = (e: KeyboardEvent) => {
    if (!this.active) return;
    if (e.key === 'Escape') this.requestExit();
  };

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.group = new THREE.Group();
    this.group.visible = false;
    this.scene.add(this.group);
  }

  hasLoaded(): boolean {
    return this.loaded;
  }

  /** Register callback invoked when the user hits Escape or clicks Exit. */
  onExit(cb: () => void): void {
    this.onExitCallback = cb;
  }

  private requestExit(): void {
    this.onExitCallback?.();
  }

  async activate(onProgress?: (p: MoonFlightActivationProgress) => void): Promise<void> {
    this.active = true;

    if (!this.loaded) {
      onProgress?.({ completedUnits: 0, totalUnits: FIRST_MOON_FLIGHT_ACTIVATION_TOTAL_UNITS });
      await this.buildPlaceholderScene();
      this.loaded = true;
      onProgress?.({ completedUnits: FIRST_MOON_FLIGHT_ACTIVATION_TOTAL_UNITS, totalUnits: FIRST_MOON_FLIGHT_ACTIVATION_TOTAL_UNITS });
    }

    // Camera: default orbital pose. Looking down at the placeholder Moon.
    // Placeholder uses scene-unit sphere of radius 1; real lunar-km frame
    // lands in phase 3 when the real sphere arrives.
    this.camera.near = 0.01;
    this.camera.far = 2000;
    this.camera.fov = 55;
    this.camera.position.set(0, 0.4, 2.6);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();

    this.group.visible = true;
    this.showUI();
    window.addEventListener('keydown', this.handleKeyDown);
  }

  deactivate(): void {
    this.active = false;
    this.group.visible = false;
    this.hideUI();
    window.removeEventListener('keydown', this.handleKeyDown);
  }

  dispose(): void {
    this.deactivate();
    if (this.uiEl?.parentElement) {
      this.uiEl.parentElement.removeChild(this.uiEl);
    }
    this.uiEl = null;

    if (this.moon) {
      this.moon.geometry.dispose();
      (this.moon.material as THREE.Material).dispose();
      this.group.remove(this.moon);
      this.moon = null;
    }
    if (this.sunLight) {
      this.group.remove(this.sunLight);
      this.sunLight = null;
    }
    if (this.ambient) {
      this.group.remove(this.ambient);
      this.ambient = null;
    }
    this.scene.remove(this.group);
    this.loaded = false;
  }

  update(_dt: number): void {
    if (!this.active) return;
    // Phase 1: no flight controls yet — scene is static. Phase 3+ fills this in.
  }

  onResize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  private async buildPlaceholderScene(): Promise<void> {
    const geo = new THREE.SphereGeometry(1.0, 128, 64);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x8a867e,
      roughness: 0.95,
      metalness: 0.0,
    });
    this.moon = new THREE.Mesh(geo, mat);
    this.group.add(this.moon);

    this.sunLight = new THREE.DirectionalLight(0xfff4e0, 3.0);
    this.sunLight.position.set(5, 2, 3);
    this.group.add(this.sunLight);

    this.ambient = new THREE.AmbientLight(0x0a0a14, 0.4);
    this.group.add(this.ambient);
  }

  private showUI(): void {
    if (!this.uiEl) {
      const el = document.createElement('div');
      el.id = 'moonflight-ui';
      el.style.cssText = [
        'position:fixed',
        'top:16px',
        'right:16px',
        'z-index:10',
        'display:flex',
        'gap:8px',
        'pointer-events:auto',
      ].join(';');

      const exitBtn = document.createElement('button');
      exitBtn.textContent = 'Exit Flight';
      exitBtn.style.cssText = [
        'padding:8px 16px',
        'background:rgba(20,20,30,0.75)',
        'backdrop-filter:blur(8px)',
        'color:#e8e8ea',
        'border:1px solid rgba(255,255,255,0.15)',
        'border-radius:8px',
        'font:500 12px/1.2 system-ui,sans-serif',
        'letter-spacing:0.3px',
        'cursor:pointer',
      ].join(';');
      exitBtn.addEventListener('click', () => this.requestExit());
      el.appendChild(exitBtn);

      document.body.appendChild(el);
      this.uiEl = el;
    }
    this.uiEl.style.display = 'flex';
  }

  private hideUI(): void {
    if (this.uiEl) this.uiEl.style.display = 'none';
  }
}
