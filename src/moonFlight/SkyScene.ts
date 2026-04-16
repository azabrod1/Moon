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
    });
    this.earth = new THREE.Mesh(earthGeo, earthMat);
    this.earth.name = 'SkyEarth';
    this.group.add(this.earth);

    // Sun disk: bright emissive sphere. Light source is a separate DirectionalLight.
    const sunRadius = 1;
    const sunGeo = new THREE.SphereGeometry(sunRadius, 32, 16);
    const sunMat = new THREE.MeshBasicMaterial({ color: 0xffeec8 });
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
    const starGeo = new THREE.SphereGeometry(STAR_SPHERE_RADIUS_KM, 64, 32);
    const starMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
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

  /** Apply snapshot: position Earth/Sun, size by angular diameter, set light direction. */
  applySnapshot(snap: LightingSnapshot): void {
    // Earth: real angular diameter from current Moon-Earth distance.
    const earthAng = angularDiameterRad(EARTH_RADIUS_KM, snap.earthDistanceKm);
    const earthDisplayRadius = EARTH_DISPLAY_DISTANCE_KM * Math.tan(earthAng / 2);
    this.earth.scale.setScalar(earthDisplayRadius);
    this.earth.position.copy(snap.earthDir).multiplyScalar(EARTH_DISPLAY_DISTANCE_KM);

    // Sun: same treatment.
    const sunAng = angularDiameterRad(SUN_RADIUS_KM, snap.sunDistanceKm);
    const sunDisplayRadius = SUN_DISPLAY_DISTANCE_KM * Math.tan(sunAng / 2);
    this.sunDisk.scale.setScalar(sunDisplayRadius);
    this.sunDisk.position.copy(snap.sunDir).multiplyScalar(SUN_DISPLAY_DISTANCE_KM);
    this.sunGlow.scale.setScalar(sunDisplayRadius);
    this.sunGlow.position.copy(this.sunDisk.position);

    // Directional light: aim a distant source in the sun direction toward origin.
    // In Three.js, DirectionalLight.position relative to .target defines the
    // incoming light direction. Place it far along +sunDir so rays travel -sunDir.
    this.sunLight.position.copy(snap.sunDir).multiplyScalar(SUN_DISPLAY_DISTANCE_KM);
    this.sunLight.target.position.set(0, 0, 0);
    this.sunLight.target.updateMatrixWorld();

    // Earthshine fill: tint + intensity scale with Earth phase brightness.
    // Earth is ~4x brighter than a full moon on the Moon, but we want a subtle fill.
    this.earthshine.intensity = snap.earthPhaseFrac * 0.18;
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
