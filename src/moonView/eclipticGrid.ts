/**
 * Ecliptic reference grid for the Moon view: a square wireframe on the ecliptic
 * plane (central lines highlighted) with a circular exclusion zone around the
 * origin. Pure builder.
 */
import * as THREE from 'three';

export function createEclipticGrid(
  size: number,
  divisions: number,
  centerColor: number,
  gridColor: number,
  exclusionRadius: number,
): THREE.LineSegments {
  const positions: number[] = [];
  const colors: number[] = [];
  const half = size / 2;
  const step = size / divisions;
  const center = divisions / 2;
  const centerColor3 = new THREE.Color(centerColor);
  const gridColor3 = new THREE.Color(gridColor);

  const pushSegment = (x1: number, z1: number, x2: number, z2: number, color: THREE.Color) => {
    positions.push(x1, 0, z1, x2, 0, z2);
    colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
  };

  for (let i = 0; i <= divisions; i++) {
    const offset = -half + i * step;
    const color = i === center ? centerColor3 : gridColor3;

    if (Math.abs(offset) >= exclusionRadius) {
      pushSegment(-half, offset, half, offset, color);
      pushSegment(offset, -half, offset, half, color);
      continue;
    }

    const clippedHalfSpan = Math.sqrt(Math.max(exclusionRadius * exclusionRadius - offset * offset, 0));
    pushSegment(-half, offset, -clippedHalfSpan, offset, color);
    pushSegment(clippedHalfSpan, offset, half, offset, color);
    pushSegment(offset, -half, offset, -clippedHalfSpan, color);
    pushSegment(offset, clippedHalfSpan, offset, half, color);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

  return new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
    }),
  );
}
