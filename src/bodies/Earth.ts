import * as THREE from 'three';
import { SCENE } from '../utils/constants';
import { LoadedTextures } from '../utils/textures';
import {
  atmosphereVertexShader,
  atmosphereFragmentShader,
  earthNightVertexShader,
  earthNightFragmentShader,
} from '../shaders/atmosphere';

export class Earth {
  group: THREE.Group;
  mesh: THREE.Mesh;
  cloudsMesh: THREE.Mesh;
  atmosphereMesh: THREE.Mesh;
  nightMesh: THREE.Mesh;
  nightMaterial: THREE.ShaderMaterial;

  constructor(textures: LoadedTextures) {
    this.group = new THREE.Group();

    // Earth axial tilt
    this.group.rotation.z = SCENE.EARTH_AXIAL_TILT;

    // Main Earth mesh
    const earthGeo = new THREE.SphereGeometry(SCENE.EARTH_RADIUS, 128, 64);
    const earthMat = new THREE.MeshStandardMaterial({
      map: textures.earthDay,
      bumpMap: textures.earthBump,
      bumpScale: 0.02,
      roughness: 0.8,
      metalness: 0.1,
    });
    this.mesh = new THREE.Mesh(earthGeo, earthMat);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.group.add(this.mesh);

    // Night lights layer (slightly larger to avoid z-fighting)
    const nightGeo = new THREE.SphereGeometry(SCENE.EARTH_RADIUS * 1.001, 128, 64);
    this.nightMaterial = new THREE.ShaderMaterial({
      uniforms: {
        nightTexture: { value: textures.earthNight },
        sunDirection: { value: new THREE.Vector3(1, 0, 0) },
      },
      vertexShader: earthNightVertexShader,
      fragmentShader: earthNightFragmentShader,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.nightMesh = new THREE.Mesh(nightGeo, this.nightMaterial);
    this.group.add(this.nightMesh);

    // Clouds
    const cloudsGeo = new THREE.SphereGeometry(SCENE.EARTH_RADIUS * 1.01, 128, 64);
    const cloudsMat = new THREE.MeshStandardMaterial({
      map: textures.earthClouds,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      roughness: 1.0,
    });
    this.cloudsMesh = new THREE.Mesh(cloudsGeo, cloudsMat);
    this.cloudsMesh.receiveShadow = true;
    this.group.add(this.cloudsMesh);

    // Atmosphere glow
    const atmosGeo = new THREE.SphereGeometry(SCENE.EARTH_RADIUS * 1.06, 64, 32);
    const atmosMat = new THREE.ShaderMaterial({
      vertexShader: atmosphereVertexShader,
      fragmentShader: atmosphereFragmentShader,
      transparent: true,
      side: THREE.BackSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.atmosphereMesh = new THREE.Mesh(atmosGeo, atmosMat);
    this.group.add(this.atmosphereMesh);
  }

  update(dt: number, sunWorldDir: THREE.Vector3) {
    // Slow rotation
    this.mesh.rotation.y += dt * 0.05;
    this.nightMesh.rotation.y = this.mesh.rotation.y;

    // Clouds rotate slightly faster
    this.cloudsMesh.rotation.y += dt * 0.06;

    // Update night lights sun direction (transform to Earth's local frame)
    const localSunDir = sunWorldDir.clone();
    const invMatrix = new THREE.Matrix4().copy(this.group.matrixWorld).invert();
    localSunDir.transformDirection(invMatrix);
    this.nightMaterial.uniforms.sunDirection.value.copy(localSunDir);
  }

  setVisualScale(scale: number) {
    this.group.scale.setScalar(scale);
  }
}
