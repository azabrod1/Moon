/**
 * Spike S1 throwaway code (docs/descent/ROADMAP.md) — replaced by the production
 * DescentMode in P1. The surviving artifact is the shell refactor this exercises
 * (src/app/renderPipeline.ts).
 *
 * Sky scene: stars, Earth, and a deliberately-HDR sun glare, all on a fixed 50 km
 * shell inside the world frustum at every altitude. Rendered FIRST, depth cleared
 * before the world pass. The sun glare is the one element ABOVE the bloom threshold
 * — it proves bloom is alive while the terrain (kept sub-threshold) never blooms.
 */
import * as THREE from 'three';
import { BRIGHT_STAR_CATALOG } from '../../../planetarium/data/brightStars';
import { raDecToVector } from '../../../astronomy/planetary';
import { SUN_DIR_WORLD, EARTH_DIR_WORLD } from './spikeWorld';

const SKY_SHELL_M = 50_000; // inside [near, far] at every altitude (near ≤ 150 m, far ≥ ~130 km)

function makeStars(): THREE.Points {
  const catalog = BRIGHT_STAR_CATALOG.filter((s) => s.magnitude > -10); // drop Sol
  const n = catalog.length;
  const positions = new Float32Array(n * 3);
  const sizes = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = catalog[i];
    const p = raDecToVector(s.raDeg, s.decDeg, SKY_SHELL_M);
    positions[i * 3] = p.x; positions[i * 3 + 1] = p.y; positions[i * 3 + 2] = p.z;
    sizes[i] = THREE.MathUtils.clamp(4.5 - s.magnitude * 0.9, 1, 5); // mag → size
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uBright: { value: 1 } },
    vertexShader: `
      attribute float size;
      uniform float uBright;
      varying float vSize;
      void main() {
        vSize = size;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * uBright;
      }
    `,
    fragmentShader: `
      uniform float uBright;
      varying float vSize;
      void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        if (d > 0.5) discard;
        float a = (1.0 - smoothstep(0.2, 0.5, d)) * clamp(uBright, 0.3, 1.4);
        gl_FragColor = vec4(vec3(0.95), a);
      }
    `,
    transparent: true,
    depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return points;
}

function makeGlareTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,245,230,0.7)');
  g.addColorStop(1, 'rgba(255,240,220,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

export class SpikeSky {
  readonly scene = new THREE.Scene();
  private stars: THREE.Points;
  private sunSprite: THREE.Sprite;
  private disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];

  constructor() {
    this.scene.background = null;

    this.stars = makeStars();
    this.disposables.push(this.stars.geometry, this.stars.material as THREE.Material);
    this.scene.add(this.stars);

    // Earth: small blue-gray unlit sphere at the shell, sized for ~1.9° apparent
    // diameter, in the Earth direction (~66° elevation).
    const appDiam = 1.9 * THREE.MathUtils.DEG2RAD;
    const earthR = Math.tan(appDiam / 2) * SKY_SHELL_M;
    const earthGeo = new THREE.SphereGeometry(earthR, 32, 24);
    const earthMat = new THREE.MeshBasicMaterial({ color: 0x3a5a8c });
    const earth = new THREE.Mesh(earthGeo, earthMat);
    earth.position.copy(EARTH_DIR_WORLD).multiplyScalar(SKY_SHELL_M);
    earth.frustumCulled = false;
    this.scene.add(earth);
    this.disposables.push(earthGeo, earthMat);

    // Sun glare: additive sprite with HDR color (×4, well above the bloom
    // threshold) — the element that SHOULD bloom.
    const glareTex = makeGlareTexture();
    const spriteMat = new THREE.SpriteMaterial({
      map: glareTex,
      color: new THREE.Color(4.0, 3.7, 3.3),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.sunSprite = new THREE.Sprite(spriteMat);
    this.sunSprite.position.copy(SUN_DIR_WORLD).multiplyScalar(SKY_SHELL_M);
    const glareSize = Math.tan(5 * THREE.MathUtils.DEG2RAD) * SKY_SHELL_M; // ~5° glare
    this.sunSprite.scale.setScalar(glareSize);
    this.sunSprite.frustumCulled = false;
    this.scene.add(this.sunSprite);
    this.disposables.push(glareTex, spriteMat);
  }

  /** Key star and glare brightness off the same exposure EV the world uses
   *  (honest-star-policy seam, kept trivial). */
  setExposure(exposureEV: number): void {
    const k = THREE.MathUtils.clamp(Math.pow(2, exposureEV * 0.2), 0.5, 1.6);
    (this.stars.material as THREE.ShaderMaterial).uniforms.uBright.value = k;
    (this.sunSprite.material as THREE.SpriteMaterial).opacity = THREE.MathUtils.clamp(0.75 * k, 0.4, 1);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}
