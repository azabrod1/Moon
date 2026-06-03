/**
 * Procedural geometry primitives shared by the Planetarium ship models
 * (default ship + historic probes). Pure THREE geometry builders — no state.
 */
import * as THREE from 'three';

/** Build a smooth hull profile via LatheGeometry */
export function createHullGeometry(radius: number, length: number): THREE.LatheGeometry {
  // Profile points from nose tip (top) to engine base (bottom)
  // x = radius at that point, y = height
  const pts: THREE.Vector2[] = [
    new THREE.Vector2(0, length * 1.1),                    // nose tip
    new THREE.Vector2(radius * 0.12, length * 1.05),       // nose start
    new THREE.Vector2(radius * 0.4, length * 0.9),         // nose shoulder
    new THREE.Vector2(radius * 0.75, length * 0.7),        // upper taper
    new THREE.Vector2(radius * 0.92, length * 0.5),        // cockpit area
    new THREE.Vector2(radius, length * 0.3),               // max width
    new THREE.Vector2(radius, length * 0.0),               // mid body
    new THREE.Vector2(radius * 0.97, -length * 0.2),       // slight waist
    new THREE.Vector2(radius * 0.9, -length * 0.35),       // lower waist
    new THREE.Vector2(radius * 0.85, -length * 0.45),      // pre-engine taper
    new THREE.Vector2(radius * 0.75, -length * 0.5),       // engine mount
  ];
  return new THREE.LatheGeometry(pts, 24);
}

/** Engine bell with proper nozzle curve */
export function createEngineBell(radius: number, length: number): THREE.LatheGeometry {
  const pts: THREE.Vector2[] = [
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
  return new THREE.LatheGeometry(pts, 20);
}

export function createVoyagerDishGeometry(radius: number, depth: number): THREE.LatheGeometry {
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
  rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  return rod;
}

export function createFin(R: number, L: number): THREE.Mesh {
  const shape = new THREE.Shape();
  // Swept delta fin profile
  shape.moveTo(0, L * 0.05);                  // leading edge root
  shape.lineTo(R * 0.15, -L * 0.1);           // along hull
  shape.quadraticCurveTo(
    R * 1.6, -L * 0.35,                       // control point (sweep)
    R * 1.8, -L * 0.5,                        // tip trailing edge
  );
  shape.lineTo(R * 1.4, -L * 0.45);           // tip leading edge
  shape.quadraticCurveTo(
    R * 0.8, -L * 0.2,                        // control point back
    0, -L * 0.05,                              // root trailing edge
  );
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: R * 0.04,
    bevelEnabled: true,
    bevelThickness: R * 0.015,
    bevelSize: R * 0.015,
    bevelSegments: 2,
  });
  const mat = new THREE.MeshStandardMaterial({
    color: 0x8090a8,
    emissive: 0x141c28,
    emissiveIntensity: 0.25,
    roughness: 0.3,
    metalness: 0.7,
    side: THREE.DoubleSide,
  });
  const fin = new THREE.Mesh(geo, mat);
  fin.position.y = -L * 0.3;

  // Red fin tip accent
  const tipGeo = new THREE.SphereGeometry(R * 0.06, 6, 6);
  const tipMat = new THREE.MeshStandardMaterial({
    color: 0xdd2200,
    emissive: 0x661100,
    emissiveIntensity: 0.4,
    roughness: 0.3,
    metalness: 0.5,
  });
  const tip = new THREE.Mesh(tipGeo, tipMat);
  tip.position.set(R * 1.7, -L * 0.18, R * 0.02);
  fin.add(tip);

  return fin;
}
