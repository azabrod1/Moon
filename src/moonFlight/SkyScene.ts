import * as THREE from 'three';
import { TEXTURES } from '../utils/constants';
import {
  angularDiameterRad,
  EARTH_RADIUS_KM,
  SUN_RADIUS_KM,
  type LightingSnapshot,
} from './lightingSnapshot';

/**
 * Sky rendered using the angular-size trick: Earth and Sun are placed at
 * arbitrary fixed display distances (not their real distances) and sized so
 * they subtend the correct angular diameter as seen by the camera.
 *
 * Why: real distances (Earth 384,000 km, Sun 150M km) blow out depth precision
 * in a single float32 framebuffer. Parking them at ~few thousand km of display
 * distance gives the same visual result with zero precision headaches.
 *
 * The scene unit is 1 km.
 */

const EARTH_DISPLAY_DISTANCE_KM = 5000;
const SUN_DISPLAY_DISTANCE_KM = 8000;
const STAR_SPHERE_RADIUS_KM = 9500;

export class SkyScene {
  readonly group: THREE.Group;

  private earth: THREE.Mesh;
  private earthTexture: THREE.Texture | null = null;
  private earthBumpTexture: THREE.Texture | null = null;
  private sunDisk: THREE.Mesh;
  private sunGlow: THREE.Mesh;
  private stars: THREE.Mesh;
  private starTexture: THREE.Texture | null = null;

  /** Shared directional light. Lives in the main flight group so it lights the Moon too. */
  readonly sunLight: THREE.DirectionalLight;
  /** Soft earthshine ambient. Intensity scales with Earth phase. */
  readonly earthshine: THREE.AmbientLight;

  private snapshot: LightingSnapshot | null = null;

  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'MoonFlightSky';

    // Earth: lit sphere, textured day side only for phase 2.
    const earthRadius = 1; // placeholder; resized in applySnapshot
    const earthGeo = new THREE.SphereGeometry(earthRadius, 64, 32);
    const earthMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.85,
      metalness: 0.0,
      toneMapped: false,
    });
    this.earth = new THREE.Mesh(earthGeo, earthMat);
    this.earth.name = 'SkyEarth';
    this.group.add(this.earth);

    // Sun disk: bright emissive sphere. Light source is a separate DirectionalLight.
    const sunRadius = 1;
    const sunGeo = new THREE.SphereGeometry(sunRadius, 32, 16);
    const sunMat = new THREE.MeshBasicMaterial({ color: 0xffeec8, toneMapped: false });
    this.sunDisk = new THREE.Mesh(sunGeo, sunMat);
    this.sunDisk.name = 'SkySun';
    this.group.add(this.sunDisk);

    // Sun glow halo: larger transparent shell with soft falloff.
    const glowGeo = new THREE.SphereGeometry(sunRadius * 3.5, 32, 16);
    const glowMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0xffeec8) },
      },
      vertexShader: `
        varying vec3 vNormal;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vNormal;
        uniform vec3 uColor;
        void main() {
          float falloff = pow(1.0 - abs(vNormal.z), 2.5);
          gl_FragColor = vec4(uColor, falloff * 0.55);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    this.sunGlow = new THREE.Mesh(glowGeo, glowMat);
    this.sunGlow.name = 'SkySunGlow';
    this.group.add(this.sunGlow);

    // Stars: large inverted sphere with equirectangular milky way texture.
    // Positioned relative to camera each frame (see update()) so it's always
    // visible regardless of camera's world position and never hits the far plane.
    const starGeo = new THREE.SphereGeometry(STAR_SPHERE_RADIUS_KM, 64, 32);
    const starMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false, // keep stars at full brightness on tone-mapped renderers
    });
    this.stars = new THREE.Mesh(starGeo, starMat);
    this.stars.name = 'SkyStars';
    this.stars.renderOrder = -1000;
    this.group.add(this.stars);

    // Sun directional light. Intensity tuned for a dramatic lunar day.
    this.sunLight = new THREE.DirectionalLight(0xfff4e0, 3.2);
    this.sunLight.name = 'SkySunLight';
    // Don't parent to the sky group — main flight group owns it so
    // both Moon and Earth are lit consistently.

    this.earthshine = new THREE.AmbientLight(0x0a1428, 0.0);
    this.earthshine.name = 'SkyEarthshine';
  }

  async load(onProgress?: (done: number, total: number) => void): Promise<void> {
    const loader = new THREE.TextureLoader();
    const total = 3;
    let done = 0;

    const [earth, earthBump, stars] = await Promise.all([
      loader.loadAsync(TEXTURES.EARTH_DAY).then((t) => {
        onProgress?.(++done, total);
        return t;
      }),
      loader.loadAsync(TEXTURES.EARTH_BUMP).then((t) => {
        onProgress?.(++done, total);
        return t;
      }),
      loader.loadAsync(TEXTURES.MILKY_WAY).then((t) => {
        onProgress?.(++done, total);
        return t;
      }),
    ]);

    earth.colorSpace = THREE.SRGBColorSpace;
    earth.anisotropy = 8;
    this.earthTexture = earth;
    (this.earth.material as THREE.MeshStandardMaterial).map = earth;

    earthBump.anisotropy = 4;
    this.earthBumpTexture = earthBump;
    const em = this.earth.material as THREE.MeshStandardMaterial;
    em.bumpMap = earthBump;
    em.bumpScale = 0.002;
    em.needsUpdate = true;

    stars.colorSpace = THREE.SRGBColorSpace;
    stars.anisotropy = 2;
    this.starTexture = stars;
    (this.stars.material as THREE.MeshBasicMaterial).map = stars;
    (this.stars.material as THREE.MeshBasicMaterial).needsUpdate = true;
  }

  /** Apply snapshot: size objects by angular diameter + set lighting direction. */
  applySnapshot(snap: LightingSnapshot): void {
    this.snapshot = snap;

    // Earth mesh radius = display_distance * tan(angular_radius), so from the
    // camera (which is always at display_distance from the mesh) it subtends the
    // correct angular diameter.
    const earthAng = angularDiameterRad(EARTH_RADIUS_KM, snap.earthDistanceKm);
    const earthDisplayRadius = EARTH_DISPLAY_DISTANCE_KM * Math.tan(earthAng / 2);
    this.earth.scale.setScalar(earthDisplayRadius);

    const sunAng = angularDiameterRad(SUN_RADIUS_KM, snap.sunDistanceKm);
    const sunDisplayRadius = SUN_DISPLAY_DISTANCE_KM * Math.tan(sunAng / 2);
    this.sunDisk.scale.setScalar(sunDisplayRadius);
    this.sunGlow.scale.setScalar(sunDisplayRadius);

    // Directional light: a DirectionalLight in Three.js uses (target - position)
    // as its incoming-light vector. Parking it at origin - sunDir*D and pointing
    // at origin means rays travel in -sunDir, which is correct for sunlight from
    // +sunDir. Position/target are static — only direction matters for unshadowed
    // directional lights.
    this.sunLight.position.copy(snap.sunDir).multiplyScalar(SUN_DISPLAY_DISTANCE_KM);
    this.sunLight.target.position.set(0, 0, 0);
    this.sunLight.target.updateMatrixWorld();

    this.earthshine.intensity = snap.earthPhaseFrac * 0.18;
  }

  /**
   * Each frame, re-anchor sky objects to the camera so they render at a fixed
   * display distance regardless of where the camera is in the moon-local frame.
   * This is the angular-size trick done correctly: the sky follows the viewer.
   */
  update(cameraWorldPos: THREE.Vector3): void {
    if (!this.snapshot) return;
    this.stars.position.copy(cameraWorldPos);
    this.earth.position
      .copy(this.snapshot.earthDir).multiplyScalar(EARTH_DISPLAY_DISTANCE_KM)
      .add(cameraWorldPos);
    this.sunDisk.position
      .copy(this.snapshot.sunDir).multiplyScalar(SUN_DISPLAY_DISTANCE_KM)
      .add(cameraWorldPos);
    this.sunGlow.position.copy(this.sunDisk.position);
  }

  dispose(): void {
    this.earth.geometry.dispose();
    (this.earth.material as THREE.Material).dispose();
    this.earthTexture?.dispose();
    this.earthBumpTexture?.dispose();

    this.sunDisk.geometry.dispose();
    (this.sunDisk.material as THREE.Material).dispose();

    this.sunGlow.geometry.dispose();
    (this.sunGlow.material as THREE.Material).dispose();

    this.stars.geometry.dispose();
    (this.stars.material as THREE.Material).dispose();
    this.starTexture?.dispose();
  }
}
