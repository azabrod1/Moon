import * as THREE from 'three';
import { TEXTURES } from '../utils/constants';
import { SkyScene } from './SkyScene';
import { snapshotLighting, MOON_RADIUS_KM, type LightingSnapshot } from './lightingSnapshot';

export interface MoonFlightActivationProgress {
  completedUnits: number;
  totalUnits: number;
}

export const FIRST_MOON_FLIGHT_ACTIVATION_TOTAL_UNITS = 4;

/**
 * Moon flight mode.
 *
 * Phase 2: proper sky (Earth, Sun, stars) lit from the snapshot ephemeris,
 * plus a real-textured Moon. Still no flight controls — camera is parked at
 * an orbital pose. Flight controls, streamed tiles, and procedural detail
 * arrive in later phases.
 *
 * Scene unit: 1 km. Moon sits at origin with radius 1737.4.
 */
export class MoonFlightMode {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;

  private group: THREE.Group;
  private moon: THREE.Mesh | null = null;
  private moonTexture: THREE.Texture | null = null;
  private sky: SkyScene | null = null;
  private snapshot: LightingSnapshot | null = null;

  private loaded = false;
  private active = false;
  private uiEl: HTMLElement | null = null;
  private onExitCallback: (() => void) | null = null;
  private _camWorldPos = new THREE.Vector3();
  private handleKeyDown = (e: KeyboardEvent) => {
    if (!this.active) return;
    if (e.key === 'Escape') this.requestExit();
  };

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.group = new THREE.Group();
    this.group.name = 'MoonFlightRoot';
    this.group.visible = false;
    this.scene.add(this.group);
  }

  hasLoaded(): boolean {
    return this.loaded;
  }

  onExit(cb: () => void): void {
    this.onExitCallback = cb;
  }

  private requestExit(): void {
    this.onExitCallback?.();
  }

  /**
   * Activate flight mode. If first entry, loads assets and builds scene.
   *
   * @param date  Current simulator date — used to snapshot sun/earth positions
   *              so the flight sky matches whatever lunar phase / eclipse state
   *              the user was just looking at.
   */
  async activate(date: Date, onProgress?: (p: MoonFlightActivationProgress) => void): Promise<void> {
    this.active = true;
    this.snapshot = snapshotLighting(date);

    if (!this.loaded) {
      let completed = 0;
      const report = () => onProgress?.({
        completedUnits: completed,
        totalUnits: FIRST_MOON_FLIGHT_ACTIVATION_TOTAL_UNITS,
      });
      report();

      // Load moon texture in parallel with sky textures.
      this.sky = new SkyScene();
      const skyLoad = this.sky.load(() => {
        completed++;
        report();
      });

      await Promise.all([
        this.buildMoon().then(() => {
          completed++;
          report();
        }),
        skyLoad,
      ]);

      this.group.add(this.sky.group);
      this.group.add(this.sky.sunLight);
      this.group.add(this.sky.sunLight.target);
      this.group.add(this.sky.earthshine);

      this.loaded = true;
    }

    if (this.sky) this.sky.applySnapshot(this.snapshot);
    this.orientMoonToFrame(this.snapshot);

    // Opening shot: high orbit on the far side relative to Earth, so Earth
    // peeks past the moon's limb (~22° above view center, just inside the
    // 27.5° vertical fov half-angle). The moon's lit hemisphere depends on
    // sun direction; tilt biases toward sunDir so the lit limb usually faces
    // the camera.
    const orbitAltitudeKm = 5000;
    const orbitRadiusKm = MOON_RADIUS_KM + orbitAltitudeKm;
    const earthDir = this.snapshot.earthDir.clone().normalize();
    const eclipticNorth = new THREE.Vector3(0, 0, 1);
    const tiltRaw = eclipticNorth.clone().multiplyScalar(0.85)
      .add(this.snapshot.sunDir.clone().multiplyScalar(0.4));
    const tilt = tiltRaw.sub(earthDir.clone().multiplyScalar(tiltRaw.dot(earthDir))).normalize();
    const camDir = earthDir.clone().multiplyScalar(-0.93)
      .add(tilt.multiplyScalar(0.367))
      .normalize();
    const camPos = camDir.multiplyScalar(orbitRadiusKm);

    this.camera.near = 1;
    this.camera.far = 12000;
    this.camera.fov = 55;
    this.camera.up.set(0, 0, 1);
    this.camera.position.copy(camPos);
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
    if (this.uiEl?.parentElement) this.uiEl.parentElement.removeChild(this.uiEl);
    this.uiEl = null;

    if (this.moon) {
      this.moon.geometry.dispose();
      (this.moon.material as THREE.Material).dispose();
      this.group.remove(this.moon);
      this.moon = null;
    }
    this.moonTexture?.dispose();
    this.moonTexture = null;

    if (this.sky) {
      this.group.remove(this.sky.group);
      this.group.remove(this.sky.sunLight);
      this.group.remove(this.sky.sunLight.target);
      this.group.remove(this.sky.earthshine);
      this.sky.dispose();
      this.sky = null;
    }

    this.scene.remove(this.group);
    this.loaded = false;
  }

  update(_dt: number): void {
    if (!this.active) return;
    if (this.sky) {
      this.camera.getWorldPosition(this._camWorldPos);
      this.sky.update(this._camWorldPos);
    }
  }

  onResize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Rotate the moon mesh so the texture's sub-Earth point (selenographic
   * longitude 0, mapped to mesh +X by Three.js's SphereGeometry) actually
   * points at Earth, with the spin axis ≈ ecliptic north. Tidal locking +
   * librations are not modeled; this is a static "snapshot" orientation.
   */
  private orientMoonToFrame(snap: LightingSnapshot): void {
    if (!this.moon) return;
    const earthDir = snap.earthDir.clone().normalize();
    const north = new THREE.Vector3(0, 0, 1);
    const yAxis = north.clone()
      .sub(earthDir.clone().multiplyScalar(north.dot(earthDir)))
      .normalize();
    const zAxis = new THREE.Vector3().crossVectors(earthDir, yAxis);
    const m = new THREE.Matrix4().makeBasis(earthDir, yAxis, zAxis);
    this.moon.quaternion.setFromRotationMatrix(m);
  }

  private async buildMoon(): Promise<void> {
    const loader = new THREE.TextureLoader();
    const moonTex = await loader.loadAsync(TEXTURES.MOON);
    moonTex.colorSpace = THREE.SRGBColorSpace;
    moonTex.anisotropy = 8;
    this.moonTexture = moonTex;

    const geo = new THREE.SphereGeometry(MOON_RADIUS_KM, 256, 128);
    const mat = new THREE.MeshStandardMaterial({
      map: moonTex,
      bumpMap: moonTex,
      bumpScale: 6, // km of apparent displacement (exaggerated for visual)
      roughness: 0.96,
      metalness: 0.0,
      color: 0xffffff,
    });
    this.moon = new THREE.Mesh(geo, mat);
    this.moon.name = 'FlightMoon';
    this.group.add(this.moon);
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
