import * as THREE from 'three';
import { SCENE } from '../utils/constants';
import {
  sunCoronaVertexShader,
  sunCoronaFragmentShader,
} from '../shaders/sun';

function createRadialGlowTexture(stops: Array<{ stop: number; color: string }>, size = 256): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const center = size / 2;

  const gradient = ctx.createRadialGradient(center, center, 0, center, center, center);
  for (const { stop, color } of stops) {
    gradient.addColorStop(stop, color);
  }

  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createSunGlowSprite(radius: number, scale: number, texture: THREE.Texture, opacity: number): THREE.Sprite {
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    opacity,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  });

  const sprite = new THREE.Sprite(material);
  sprite.scale.setScalar(radius * scale * 2);
  sprite.renderOrder = 8;
  return sprite;
}

export class Sun {
  group: THREE.Group;
  mesh: THREE.Mesh;
  glowMesh: THREE.Sprite;
  haloMesh: THREE.Sprite;
  light: THREE.DirectionalLight;
  coronaMaterial: THREE.ShaderMaterial;

  constructor(useBloom = true) {
    this.group = new THREE.Group();
    this.group.position.set(SCENE.EARTH_SUN_DIST, 0, 0);

    // Sun surface with animated corona shader
    const sunGeo = new THREE.SphereGeometry(SCENE.SUN_RADIUS, 64, 32);
    this.coronaMaterial = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
      },
      vertexShader: sunCoronaVertexShader,
      fragmentShader: sunCoronaFragmentShader,
    });
    this.mesh = new THREE.Mesh(sunGeo, this.coronaMaterial);
    this.group.add(this.mesh);

    // Use billboarded radial glows so the Sun always stays circular on screen.
    const innerGlowTexture = createRadialGlowTexture([
      { stop: 0.0, color: 'rgba(255,255,245,1.0)' },
      { stop: 0.18, color: 'rgba(255,244,220,0.95)' },
      { stop: 0.42, color: 'rgba(255,188,92,0.45)' },
      { stop: 0.72, color: 'rgba(255,120,26,0.12)' },
      { stop: 1.0, color: 'rgba(255,120,26,0.0)' },
    ]);
    const outerGlowTexture = createRadialGlowTexture([
      { stop: 0.0, color: 'rgba(255,235,190,0.24)' },
      { stop: 0.35, color: 'rgba(255,190,96,0.12)' },
      { stop: 0.7, color: 'rgba(255,130,36,0.04)' },
      { stop: 1.0, color: 'rgba(255,130,36,0.0)' },
    ]);

    this.glowMesh = createSunGlowSprite(
      SCENE.SUN_RADIUS,
      useBloom ? 4.6 : 5.4,
      innerGlowTexture,
      1.0,
    );
    this.haloMesh = createSunGlowSprite(
      SCENE.SUN_RADIUS,
      useBloom ? 7.5 : 9.0,
      outerGlowTexture,
      useBloom ? 0.5 : 0.58,
    );
    this.group.add(this.haloMesh);
    this.group.add(this.glowMesh);

    // Directional light toward Earth (origin)
    this.light = new THREE.DirectionalLight(0xfff5e0, 3.0);
    this.light.castShadow = true;
    this.light.shadow.mapSize.set(2048, 2048);
    this.light.shadow.camera.near = 0.5;
    this.light.shadow.camera.far = SCENE.EARTH_SUN_DIST * 2;
    const shadowSize = SCENE.EARTH_MOON_DIST * 1.5;
    this.light.shadow.camera.left = -shadowSize;
    this.light.shadow.camera.right = shadowSize;
    this.light.shadow.camera.top = shadowSize;
    this.light.shadow.camera.bottom = -shadowSize;
    this.group.add(this.light);
    this.light.target.position.set(-SCENE.EARTH_SUN_DIST, 0, 0);
    this.group.add(this.light.target);

    // Avoid an extra unshadowed fill light here, otherwise eclipsed bodies stay visibly lit.
  }

  /**
   * Set the Sun's ecliptic longitude (degrees).
   * Sun orbits Earth at fixed distance (really Earth orbits Sun, but geocentric view).
   */
  setPosition(angleDeg: number) {
    const angle = (angleDeg * Math.PI) / 180;
    this.group.position.set(
      SCENE.EARTH_SUN_DIST * Math.cos(angle),
      0,
      SCENE.EARTH_SUN_DIST * Math.sin(angle),
    );
    // Point directional light at Earth
    this.light.target.position.set(
      -SCENE.EARTH_SUN_DIST * Math.cos(angle),
      0,
      -SCENE.EARTH_SUN_DIST * Math.sin(angle),
    );
  }

  getDirection(): THREE.Vector3 {
    return this.group.position.clone().normalize();
  }

  update(dt: number) {
    this.coronaMaterial.uniforms.time.value += dt;
  }

  setVisualScale(scale: number) {
    this.mesh.scale.setScalar(scale);
    this.glowMesh.scale.setScalar(scale);
    this.haloMesh.scale.setScalar(scale);
  }
}
