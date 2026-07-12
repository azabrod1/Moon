/**
 * Procedural geometry primitives shared by the Planetarium ship models
 * (default ship + historic probes). Pure THREE geometry builders — no state.
 */
import * as THREE from 'three';

/** Engine bell with proper nozzle curve */
export function createEngineBell(radius: number, length: number): THREE.LatheGeometry {
  const profilePoints: THREE.Vector2[] = [
    new THREE.Vector2(radius * 0.3, 0),           // throat (top, narrow)
    new THREE.Vector2(radius * 0.25, -length * 0.05),
    new THREE.Vector2(radius * 0.3, -length * 0.12),
    new THREE.Vector2(radius * 0.5, -length * 0.22),
    new THREE.Vector2(radius * 0.75, -length * 0.32),
    new THREE.Vector2(radius * 1.05, -length * 0.4), // bell rim
    new THREE.Vector2(radius * 1.0, -length * 0.4),  // inner rim
    new THREE.Vector2(radius * 0.7, -length * 0.3),
    new THREE.Vector2(radius * 0.45, -length * 0.18),
    new THREE.Vector2(radius * 0.25, -length * 0.03),
    new THREE.Vector2(radius * 0.28, 0),           // inner throat
  ];
  return new THREE.LatheGeometry(profilePoints, 20);
}

export function createParabolicDishGeometry(radius: number, depth: number): THREE.LatheGeometry {
  const points: THREE.Vector2[] = [];
  const steps = 20;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const r = radius * t;
    const y = -(t * t) * depth;
    points.push(new THREE.Vector2(r, y));
  }

  points.push(new THREE.Vector2(radius * 0.96, -depth * 0.92));
  points.push(new THREE.Vector2(radius * 0.88, -depth * 0.72));
  points.push(new THREE.Vector2(radius * 0.16, -depth * 0.08));

  return new THREE.LatheGeometry(points, 40);
}

export function createRodBetween(
  start: THREE.Vector3,
  end: THREE.Vector3,
  radius: number,
  material: THREE.Material,
  radialSegments = 8,
): THREE.Mesh {
  const direction = new THREE.Vector3().subVectors(end, start);
  const length = direction.length();
  const rod = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, length, radialSegments),
    material,
  );
  rod.position.copy(start).add(end).multiplyScalar(0.5);
  // Guard a zero-length rod: dividing by length === 0 would feed a non-finite
  // axis into setFromUnitVectors and corrupt the orientation.
  if (length > 1e-9) {
    rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.divideScalar(length));
  }
  return rod;
}
