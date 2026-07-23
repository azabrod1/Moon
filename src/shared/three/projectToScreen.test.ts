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
    expect(sphere.footprintKind).toBe('none');
  });

  // A rim tangent ray crosses the camera plane (angular radius ~10° at 85° off
  // axis puts the far rim past 90°), so this reaches the covering-fallback path
  // — where the disjoint test must classify it 'none', not viewport-filling.
  // This is the exact cruise-blackout geometry: an off-frame Sun.
  for (const axis of ['+x', '-x', '+y'] as const) {
    it(`returns no footprint for a tangent-crossing off-frustum sphere on the ${axis} side plane`, () => {
      const width = 1280;
      const height = 720;
      const camera = lensCamera(width, height);
      const rad85 = THREE.MathUtils.degToRad(85);
      const off = Math.sin(rad85) * 10;
      const depth = -Math.cos(rad85) * 10;
      const centre = axis === '+x' ? new THREE.Vector3(off, 0, depth)
        : axis === '-x' ? new THREE.Vector3(-off, 0, depth)
          : new THREE.Vector3(0, off, depth);
      const sphere = projectSphereToScreen(centre, 1.8, camera, width, height);
      expect(sphere.footprintKind).toBe('none');
      expect(sphere.radiusPx).toBe(0);
      expect(sphere.radiusPx).not.toBe(Math.hypot(width, height));
      // The centre projection is retained on a 'none' footprint (finite, off the
      // frame) so a consumer edge-clamping toward the off-screen body still aims.
      expect(Number.isFinite(sphere.x)).toBe(true);
      expect(Number.isFinite(sphere.y)).toBe(true);
      expect(sphere.footprintX).toBe(sphere.x);
      expect(sphere.footprintY).toBe(sphere.y);
      const onFrame = sphere.x >= 0 && sphere.x <= width && sphere.y >= 0 && sphere.y <= height;
      expect(onFrame).toBe(false);
    });
  }

  it('keeps the covering fallback when a rim ray crosses the plane but the sphere is in view', () => {
    // Very large, very close, centred well off axis: the near rim sits ~2° off
    // axis (squarely inside the frustum) while the far rim swings past 90° and
    // crosses the camera plane, so a rim ray can't be projected. The sphere
    // genuinely intersects the source frustum, so the disjoint plane tests must
    // NOT fire — it falls through to the conservative viewport-covering guess.
    const width = 1280;
    const height = 720;
    const camera = lensCamera(width, height, 60);
    const off = 55; // degrees off axis
    const distance = 2;
    const centre = new THREE.Vector3(
      Math.sin(THREE.MathUtils.degToRad(off)) * distance,
      0,
      -Math.cos(THREE.MathUtils.degToRad(off)) * distance,
    );
    const sphere = projectSphereToScreen(centre, 1.6, camera, width, height);
    expect(sphere.footprintKind).toBe('covering');
    expect(sphere.radiusPx).toBe(Math.hypot(width, height));
  });

  it('returns no footprint for the tangent-crossing off-frustum sphere in portrait', () => {
    const width = 390;
    const height = 844;
    const camera = lensCamera(width, height);
    const rad85 = THREE.MathUtils.degToRad(85);
    const sphere = projectSphereToScreen(
      new THREE.Vector3(Math.sin(rad85) * 10, 0, -Math.cos(rad85) * 10),
      1.8,
      camera,
      width,
      height,
    );
    expect(sphere.footprintKind).toBe('none');
    expect(sphere.radiusPx).toBe(0);
  });

  it('keeps the real off-screen footprint for an off-frustum sphere that projects cleanly', () => {
    // 75° off axis with a tiny angular radius: no rim ray crosses the camera
    // plane, so it never reaches the covering fallback. It IS outside the
    // frustum, but zeroing it would pop the Sun's glare terms as it crosses the
    // frustum boundary — the footprint stays a real (off-screen) measurement.
    const width = 1280;
    const height = 720;
    const camera = lensCamera(width, height);
    const rad75 = THREE.MathUtils.degToRad(75);
    const sphere = projectSphereToScreen(
      new THREE.Vector3(Math.sin(rad75) * 10, 0, -Math.cos(rad75) * 10),
      0.1,
      camera,
      width,
      height,
    );
    expect(sphere.footprintKind).toBe('sampled');
    expect(sphere.radiusPx).toBeGreaterThan(0);
    expect(sphere.minX).toBeGreaterThan(width); // bounds entirely right of the viewport
  });

  it('keeps a positive footprint for a sphere grazing just off the display edge', () => {
    const width = 1280;
    const height = 720;
    const camera = lensCamera(width, height);
    const ray = screenPointToWorldRay(
      (1.05 * 0.5 + 0.5) * width,
      0.5 * height,
      camera,
      width,
      height,
      new THREE.Vector3(),
    );
    const sphere = projectSphereToScreen(
      ray.multiplyScalar(10),
      1,
      camera,
      width,
      height,
    );
    expect(sphere.radiusPx).toBeGreaterThan(0);
    expect(sphere.footprintKind).toBe('sampled');
    expect(sphere.minX).toBeLessThan(width);
  });

  it('classifies against a translated, rotated camera frustum', () => {
    const width = 1280;
    const height = 720;
    const camera = lensCamera(width, height);
    camera.position.set(5, 2, -3);
    camera.lookAt(6, 2, -3); // forward along +x
    camera.updateMatrixWorld(true);
    const ahead = projectSphereToScreen(new THREE.Vector3(15, 2, -3), 1, camera, width, height);
    expect(ahead.footprintKind).toBe('sampled');
    expect(ahead.radiusPx).toBeGreaterThan(0);
    const behind = projectSphereToScreen(new THREE.Vector3(-5, 2, -3), 1, camera, width, height);
    expect(behind.footprintKind).toBe('none');
    expect(behind.radiusPx).toBe(0);
  });

  it('still reports a covering footprint when the camera is inside the sphere', () => {
    const width = 1280;
    const height = 720;
    const camera = lensCamera(width, height);
    const sphere = projectSphereToScreen(
      new THREE.Vector3(0, 0, -1),
      5,
      camera,
      width,
      height,
    );
    expect(sphere.footprintKind).toBe('covering');
    expect(sphere.radiusPx).toBe(Math.hypot(width, height));
  });
});
