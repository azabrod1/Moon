import * as THREE from 'three';
import { SCENE } from '../utils/constants';
import { LoadedTextures } from '../utils/textures';

export class Moon {
  group: THREE.Group;
  orbitGroup: THREE.Group;
  mesh: THREE.Mesh;

  constructor(textures: LoadedTextures) {
    // orbitGroup sits at Earth's center; rotates by node (Y) then tilts by inclination (X)
    this.orbitGroup = new THREE.Group();
    this.orbitGroup.rotation.order = 'YXZ';

    // group holds the moon mesh at the orbital distance
    this.group = new THREE.Group();
    this.group.position.set(SCENE.EARTH_MOON_DIST, 0, 0);
    this.orbitGroup.add(this.group);

    const moonGeo = new THREE.SphereGeometry(SCENE.MOON_RADIUS, 64, 32);
    const moonMat = new THREE.MeshStandardMaterial({
      map: textures.moon,
      roughness: 0.9,
      metalness: 0.0,
      bumpMap: textures.moon,
      bumpScale: 0.005,
    });
    this.mesh = new THREE.Mesh(moonGeo, moonMat);
    this.group.add(this.mesh);
  }

  /**
   * Set the Moon's orbital angle (radians, 0 = +X from Earth).
   * Node angle rotates the orbit's line of nodes.
   */
  setOrbitalPosition(angleDeg: number, nodeAngleDeg: number) {
    const angle = (angleDeg * Math.PI) / 180;
    const nodeAngle = (nodeAngleDeg * Math.PI) / 180;

    // Rotate the orbit plane around Y by the node angle
    this.orbitGroup.rotation.y = nodeAngle;
    // Tilt the orbit plane by inclination around X
    this.orbitGroup.rotation.x = SCENE.MOON_INCLINATION;

    // Position moon along orbit
    this.group.position.set(
      SCENE.EARTH_MOON_DIST * Math.cos(angle),
      0,
      SCENE.EARTH_MOON_DIST * Math.sin(angle),
    );

    // Tidal locking: moon always faces Earth
    // The moon's -Z should point toward Earth (origin)
    this.mesh.rotation.y = -angle + Math.PI;
  }

  getWorldPosition(): THREE.Vector3 {
    const pos = new THREE.Vector3();
    this.group.getWorldPosition(pos);
    return pos;
  }
}
