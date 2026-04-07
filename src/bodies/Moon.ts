import * as THREE from 'three';
import { SCENE } from '../utils/constants';
import { positionInOrbitPlaneFromLongitude } from '../utils/lunarOrbit';
import { orientOrbitPlane } from '../utils/orbitPlane';
import { LoadedTextures } from '../utils/textures';

export class Moon {
  group: THREE.Group;
  orbitGroup: THREE.Group;
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;

  constructor(textures: LoadedTextures) {
    // orbitGroup sits at Earth's center; rotates by node (Y) then tilts by inclination (X)
    this.orbitGroup = new THREE.Group();
    orientOrbitPlane(this.orbitGroup, SCENE.MOON_INCLINATION, 0);

    // group holds the moon mesh at the orbital distance
    this.group = new THREE.Group();
    this.group.position.copy(positionInOrbitPlaneFromLongitude(0, 0));
    this.orbitGroup.add(this.group);

    const moonGeo = new THREE.SphereGeometry(SCENE.MOON_RADIUS, 64, 32);
    this.material = new THREE.MeshStandardMaterial({
      map: textures.moon,
      roughness: 0.9,
      metalness: 0.0,
      bumpMap: textures.moon,
      bumpScale: 0.005,
    });
    this.mesh = new THREE.Mesh(moonGeo, this.material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.group.add(this.mesh);
  }

  /**
   * Set the Moon's orbital angle (degrees, 0 = +X from Earth).
   * Node angle rotates the orbit's line of nodes.
   */
  setOrbitalPosition(angleDeg: number, nodeAngleDeg: number) {
    const nodeAngle = (nodeAngleDeg * Math.PI) / 180;
    const localPosition = positionInOrbitPlaneFromLongitude(angleDeg, nodeAngleDeg);
    orientOrbitPlane(this.orbitGroup, SCENE.MOON_INCLINATION, nodeAngle);

    // Position moon along orbit
    this.group.position.copy(localPosition);

    // Tidal locking: moon always faces Earth
    // The moon's -Z should point toward Earth (origin)
    this.mesh.rotation.y = -Math.atan2(localPosition.z, localPosition.x) + Math.PI;
  }

  getWorldPosition(): THREE.Vector3 {
    const pos = new THREE.Vector3();
    this.group.getWorldPosition(pos);
    return pos;
  }

  setEclipseAppearance(eclipseType: 'none' | 'lunar' | 'solar', eclipseQuality: number) {
    if (eclipseType === 'lunar' && eclipseQuality > 0) {
      const tintStrength = Math.min(1, 0.35 + eclipseQuality * 0.45);
      this.material.color.setRGB(0.78, 0.7, 0.68);
      this.material.emissive.setRGB(0.55, 0.16, 0.08);
      this.material.emissiveIntensity = tintStrength;
      return;
    }

    this.material.color.setRGB(1, 1, 1);
    this.material.emissive.setRGB(0, 0, 0);
    this.material.emissiveIntensity = 0;
  }
}
