import * as THREE from 'three';
import { SCENE } from '../utils/constants';
import {
  sunCoronaVertexShader,
  sunCoronaFragmentShader,
  sunGlowVertexShader,
  sunGlowFragmentShader,
} from '../shaders/sun';

export class Sun {
  group: THREE.Group;
  mesh: THREE.Mesh;
  glowMesh: THREE.Mesh;
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

    // Use a broader, softer corona so eclipses read as a diffuse halo instead of an annulus.
    const glowScale = useBloom ? 2.4 : 3.4;
    const glowAlpha = useBloom ? 0.22 : 0.35;
    const glowGeo = new THREE.SphereGeometry(SCENE.SUN_RADIUS * glowScale, 64, 32);
    const glowMat = new THREE.ShaderMaterial({
      vertexShader: sunGlowVertexShader,
      fragmentShader: sunGlowFragmentShader,
      transparent: true,
      side: THREE.BackSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { alphaScale: { value: glowAlpha } },
    });
    this.glowMesh = new THREE.Mesh(glowGeo, glowMat);
    this.group.add(this.glowMesh);

    // Extra soft outer halo when bloom is off (fake bloom)
    if (!useBloom) {
      const haloGeo = new THREE.SphereGeometry(SCENE.SUN_RADIUS * 5.0, 32, 16);
      const haloMat = new THREE.ShaderMaterial({
        vertexShader: sunGlowVertexShader,
        fragmentShader: sunGlowFragmentShader,
        transparent: true,
        side: THREE.BackSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: { alphaScale: { value: 0.15 } },
      });
      this.group.add(new THREE.Mesh(haloGeo, haloMat));
    }

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
}
