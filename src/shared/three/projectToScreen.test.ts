import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyDesignFov } from '../math/lensProjection';
import {
  projectSphereToScreen,
  projectToScreen,
  screenPointToWorldRay,
} from './projectToScreen';

function lensCamera(width: number, height: number, fov = 60): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(fov, width / height, 0.01, 100);
  camera.userData.lens = { strength: 1, designFovDeg: fov };
  applyDesignFov(camera, fov);
  camera.position.set(0, 0, 0);
  camera.quaternion.identity();
  camera.updateMatrixWorld(true);
  return camera;
}

describe('screenPointToWorldRay', () => {
  it('round-trips displayed centre, edge, and corner coordinates', () => {
    for (const [width, height] of [[1600, 900], [390, 844]] as const) {
      const camera = lensCamera(width, height);
      for (const [ndcX, ndcY] of [[0, 0], [0.75, 0], [-0.82, 0.68], [0.9, -0.9]]) {
        const ray = screenPointToWorldRay(
          (ndcX * 0.5 + 0.5) * width,
          (-ndcY * 0.5 + 0.5) * height,
          camera,
          width,
          height,
          new THREE.Vector3(),
        );
        const projected = projectToScreen(ray.multiplyScalar(10), camera, width, height);
        expect(projected.ndcX).toBeCloseTo(ndcX, 9);
        expect(projected.ndcY).toBeCloseTo(ndcY, 9);
      }
    }
  });
});

describe('projectSphereToScreen', () => {
  it('measures the displayed tangent limb as a circle off axis', () => {
    const width = 1600;
    const height = 900;
    const camera = lensCamera(width, height);
    const ray = screenPointToWorldRay(
      0.87 * width,
      0.18 * height,
      camera,
      width,
      height,
      new THREE.Vector3(),
    );
    const sphere = projectSphereToScreen(
      ray.multiplyScalar(10),
      1.2,
      camera,
      width,
      height,
    );
    const widthPx = sphere.maxX - sphere.minX;
    const heightPx = sphere.maxY - sphere.minY;
    expect(Math.abs(widthPx / heightPx - 1)).toBeLessThan(0.005);
    expect(sphere.radiusPx).toBeGreaterThan(0);
  });

  it('reports the overscan-aware centre scale instead of the old camera-fov scale', () => {
    const width = 1600;
    const height = 900;
    const camera = lensCamera(width, height);
    const distance = 10;
    const radius = 1;
    const sphere = projectSphereToScreen(
      new THREE.Vector3(0, 0, -distance),
      radius,
      camera,
      width,
      height,
    );
    const oldOverscanDiameter = (
      radius /
      (Math.sqrt(distance * distance - radius * radius) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)))
    ) * height;
    expect(sphere.diameterPx).toBeGreaterThan(oldOverscanDiameter * 1.25);
  });

  it('returns no footprint for a sphere entirely behind the camera', () => {
    const camera = lensCamera(1600, 900);
    const sphere = projectSphereToScreen(
      new THREE.Vector3(0, 0, 10),
      1,
      camera,
      1600,
      900,
    );
    expect(sphere.radiusPx).toBe(0);
    expect(sphere.diameterPx).toBe(0);
  });
});
