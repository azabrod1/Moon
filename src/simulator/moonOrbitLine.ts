import * as THREE from 'three';
import { SCENE } from '../utils/constants';
import { createOrbitPoints } from '../utils/lunarOrbit';
import { orientOrbitPlane } from '../utils/orbitPlane';

export const MOON_ORBIT_SEGMENTS = 192;

function buildOrbitLineGeometry(
  segments: number,
  moonLocalPosition?: THREE.Vector3,
  exclusionRadius = 0,
): THREE.BufferGeometry {
  const points = createOrbitPoints(segments);
  const positions: number[] = [];

  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];

    if (moonLocalPosition && exclusionRadius > 0) {
      const midpoint = start.clone().lerp(end, 0.5);
      if (midpoint.distanceTo(moonLocalPosition) <= exclusionRadius) continue;
    }

    positions.push(start.x, start.y, start.z, end.x, end.y, end.z);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

export function createMoonOrbitLine(
  color: number,
  inclination: number,
  nodeAngle: number,
): THREE.LineSegments {
  const geometry = buildOrbitLineGeometry(MOON_ORBIT_SEGMENTS);
  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.25 });
  const line = new THREE.LineSegments(geometry, material);
  orientOrbitPlane(line, inclination, nodeAngle);
  return line;
}

export function updateMoonOrbitLine(
  line: THREE.LineSegments,
  moonLocalPosition: THREE.Vector3,
  moonRadiusScale: number,
  inclination: number,
  nodeAngle: number,
) {
  const geometry = buildOrbitLineGeometry(
    MOON_ORBIT_SEGMENTS,
    moonLocalPosition,
    SCENE.MOON_RADIUS * moonRadiusScale * 1.25,
  );
  line.geometry.dispose();
  line.geometry = geometry;
  orientOrbitPlane(line, inclination, nodeAngle);
}
