import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  applyDesignFov,
  displayFovDeg,
  lensDisplayHalfTan,
  lensMaxFrameScale,
} from '../math/lensProjection';
import {
  estimateSphereScreenDiameterPx,
  placeSphereInFrustum,
  projectedStepScale,
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

  it('reports centre x/y/ndc identically for any radius', () => {
    // The invariant that lets one measurement serve several consumers: the
    // centre fields come from the centre ray alone, so a pass that needs the
    // anchor of a true-radius sphere may read it off the padded-radius
    // measurement (and vice versa) with bit-identical results — across every
    // footprint regime, including near-covering, covering, and behind-camera.
    for (const [width, height] of [[390, 844], [1600, 900]] as const) {
      for (const camera of sweepCameras(width, height)) {
        for (const offAxisDeg of [0, 18, 40]) {
          for (const alphaDeg of [0.05, 2, 8]) {
            const { centre, radius } = sphereAt(offAxisDeg, 45, alphaDeg);
            const anchor = projectSphereToScreen(centre, radius, camera, width, height);
            const { x, y, ndcX, ndcY, ndcZ } = anchor;
            // Zero radius (point footprint), realistic rendered-size
            // inflation, a sphere straddling the camera plane, and one the
            // camera sits inside (covering) — every branch must agree.
            for (const otherRadius of [0, radius * 3, radius * 40, 9.9, 10.5]) {
              const other = projectSphereToScreen(centre, otherRadius, camera, width, height);
              expect(other.x).toBe(x);
              expect(other.y).toBe(y);
              expect(other.ndcX).toBe(ndcX);
              expect(other.ndcY).toBe(ndcY);
              expect(other.ndcZ).toBe(ndcZ);
            }
          }
        }
      }
    }
    // Behind the camera the fields still agree — both radii report the same
    // (unusable-for-drawing, but shared) centre.
    const camera = sweepCameras(390, 844)[0];
    const behind = new THREE.Vector3(0.4, -0.2, 5);
    const a = projectSphereToScreen(behind, 0.01, camera, 390, 844);
    const { x, y, ndcZ } = a;
    const b = projectSphereToScreen(behind, 2, camera, 390, 844);
    expect(b.x).toBe(x);
    expect(b.y).toBe(y);
    expect(b.ndcZ).toBe(ndcZ);
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

const DEG = Math.PI / 180;

/** Cameras spanning what the app actually points at this seam: the
 *  planetarium camera at full and reduced lens strength across its FOV
 *  range, and the lens-less flight/compare cameras. */
function sweepCameras(width: number, height: number): THREE.PerspectiveCamera[] {
  const cams: THREE.PerspectiveCamera[] = [];
  for (const fov of [1.5, 5, 20, 40, 60, 75, 90, 105]) {
    for (const strength of [1, 0.75, 0.5, null]) {
      const camera = new THREE.PerspectiveCamera(fov, width / height, 0.01, 100);
      if (strength !== null) {
        camera.userData.lens = { strength, designFovDeg: fov };
        applyDesignFov(camera, fov);
      }
      camera.updateMatrixWorld(true);
      cams.push(camera);
    }
  }
  return cams;
}

/** A sphere of angular radius alphaDeg, offAxisDeg off the view axis at
 *  azimuth azDeg, 10 units out. Camera sits at origin looking down -z. */
function sphereAt(offAxisDeg: number, azDeg: number, alphaDeg: number) {
  const d = 10;
  const theta = offAxisDeg * DEG;
  const az = azDeg * DEG;
  return {
    centre: new THREE.Vector3(
      Math.sin(theta) * Math.cos(az) * d,
      Math.sin(theta) * Math.sin(az) * d,
      -Math.cos(theta) * d,
    ),
    radius: Math.sin(alphaDeg * DEG) * d,
  };
}

describe('estimateSphereScreenDiameterPx', () => {

  it('never underestimates the sampled footprint across FOVs, strengths, aspects, and poses', () => {
    for (const [width, height] of [[390, 844], [1600, 900]] as const) {
      for (const camera of sweepCameras(width, height)) {
        const designFov = camera.userData.lens?.designFovDeg ?? camera.fov;
        for (const offFraction of [0, 0.3, 0.6, 0.9, 1.1, 1.3]) {
          for (const az of [0, 45, 90]) {
            for (const alphaDeg of [0.05, 0.5, 2, 8]) {
              const { centre, radius } = sphereAt((designFov / 2) * offFraction, az, alphaDeg);
              const est = estimateSphereScreenDiameterPx(centre, radius, camera, width, height);
              const full = projectSphereToScreen(centre, radius, camera, width, height);
              if (full.footprintKind === 'none') continue; // 0 px: any estimate satisfies the gate
              expect(est).toBeGreaterThanOrEqual(full.diameterPx);
            }
          }
        }
      }
    }
  });

  it('stays tight enough to be a useful gate for centred small bodies', () => {
    for (const [width, height] of [[390, 844], [1600, 900]] as const) {
      for (const camera of sweepCameras(width, height)) {
        for (const alphaDeg of [0.5, 2]) {
          const { centre, radius } = sphereAt(0, 0, alphaDeg);
          const est = estimateSphereScreenDiameterPx(centre, radius, camera, width, height);
          const full = projectSphereToScreen(centre, radius, camera, width, height);
          expect(est).toBeLessThanOrEqual(full.diameterPx * 2.5); // margin 1.5 x mild lens factors
        }
      }
    }
  });

  it('returns 0 behind the camera and Infinity for near/straddling poses', () => {
    const width = 1280;
    const height = 720;
    const camera = lensCamera(width, height);
    expect(estimateSphereScreenDiameterPx(new THREE.Vector3(0, 0, 5), 1, camera, width, height)).toBe(0);
    // Inside the sphere: the full path reports 'covering'; the estimate defers.
    expect(estimateSphereScreenDiameterPx(new THREE.Vector3(0, 0, -1), 5, camera, width, height)).toBe(Infinity);
    // Close (distance < 4 radii): defer to the full measurement.
    expect(estimateSphereScreenDiameterPx(new THREE.Vector3(0, 0, -3), 1, camera, width, height)).toBe(Infinity);
  });

  it('defers far-off-axis poses on non-conformal cameras to the full measurement', () => {
    const width = 1600;
    const height = 900;
    const rectilinear = new THREE.PerspectiveCamera(105, width / height, 0.01, 100);
    rectilinear.updateMatrixWorld(true);
    const theta = (105 / 2) * 1.3 * (Math.PI / 180);
    const centre = new THREE.Vector3(Math.sin(theta) * 10, 0, -Math.cos(theta) * 10);
    const radius = Math.sin(8 * (Math.PI / 180)) * 10;
    expect(estimateSphereScreenDiameterPx(centre, radius, rectilinear, width, height)).toBe(Infinity);
  });
});

/** The camera's own lens strength, the way every consumer must read it. */
function strengthOf(camera: THREE.PerspectiveCamera): number {
  const lens = camera.userData.lens as
    | { strength: number; effectiveStrength?: number }
    | undefined;
  return lens ? lens.effectiveStrength ?? lens.strength : 0;
}

/** Displayed pixels one world unit covers at unit distance at the centre of
 *  the frame — the streamer's focal length. */
function centreFocalPx(camera: THREE.PerspectiveCamera, height: number): number {
  return (height / 2) / lensDisplayHalfTan(displayFovDeg(camera), strengthOf(camera));
}

/** Two perpendicular steps of length `step`, both perpendicular to `dir`. */
function perpendicularSteps(dir: THREE.Vector3, step: number): [THREE.Vector3, THREE.Vector3] {
  const u = new THREE.Vector3()
    .crossVectors(dir, Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0))
    .normalize();
  const v = new THREE.Vector3().crossVectors(dir, u).normalize();
  return [u.multiplyScalar(step), v.multiplyScalar(step)];
}

describe('projectedStepScale', () => {
  const width = 1600;
  const height = 900;
  const step = 1e-4;

  it('matches the scalar view-angle formula for a patch square to the camera', () => {
    const camera = lensCamera(width, height);
    const distance = 9;
    const [u, v] = perpendicularSteps(new THREE.Vector3(0, 0, -1), step);
    const scale = projectedStepScale(
      new THREE.Vector3(0, 0, -distance), u, v, camera, width, height,
    );
    expect(scale).not.toBeNull();
    // Square to the camera the patch is isotropic, and the old
    // focal x cos(view angle) / distance reading agrees with it (the cosine is
    // 1 here) — as long as the focal length is the DISPLAYED one.
    const expected = centreFocalPx(camera, height) / distance;
    expect(Math.abs((scale!.maxPx / step) / expected - 1)).toBeLessThan(0.01);
    expect(Math.abs(scale!.minPx / scale!.maxPx - 1)).toBeLessThan(0.01);
    // The lens fits the design FOV onto the frame edge stereographically, so
    // its half-tangent is not tan(fov / 2): reading the scale off the tangent
    // gives up ~8% of the magnification at this FOV.
    const tangentFocalPx = (height / 2) / Math.tan(THREE.MathUtils.degToRad(displayFovDeg(camera) / 2));
    expect(tangentFocalPx / centreFocalPx(camera, height)).toBeCloseTo(0.928, 3);
  });

  it('reports the un-foreshortened tangent scale at the limb, where the cosine reads zero', () => {
    const camera = lensCamera(width, height);
    const centre = new THREE.Vector3(0, 0, -10);
    const radius = 1;
    // The tangent point: the one place on the limb where the surface normal is
    // exactly perpendicular to the line of sight.
    const sinAlpha = radius / centre.length();
    const toCentre = centre.clone().normalize();
    const normal = toCentre.clone().multiplyScalar(-sinAlpha)
      .addScaledVector(new THREE.Vector3(1, 0, 0), Math.sqrt(1 - sinAlpha * sinAlpha));
    const point = centre.clone().addScaledVector(normal, radius);
    const toCam = point.clone().negate();
    const distance = toCam.length();
    expect(Math.abs(toCam.dot(normal) / distance)).toBeLessThan(1e-12);
    const [u, v] = perpendicularSteps(normal, step);
    const scale = projectedStepScale(point, u, v, camera, width, height);
    expect(scale).not.toBeNull();
    // The tangent direction along the limb draws at the full scale for its
    // distance, so the patch is several pixels wide...
    const facingScale = centreFocalPx(camera, height) / distance;
    expect((scale!.maxPx / step) / facingScale).toBeGreaterThan(0.99);
    expect((scale!.maxPx / step) / facingScale).toBeLessThan(1.02);
    // ...while the direction across it is edge on. The cosine reports only
    // this one, which is what left the limb rendering from the base map.
    expect(scale!.minPx / scale!.maxPx).toBeLessThan(0.01);
  });

  it('reads the same whichever perpendicular pair measures the patch', () => {
    const camera = lensCamera(width, height);
    const point = new THREE.Vector3(2, -1, -8);
    const normal = new THREE.Vector3(0.3, 0.5, 0.81).normalize();
    const [u, v] = perpendicularSteps(normal, step);
    const base = projectedStepScale(point, u, v, camera, width, height);
    const turned = { max: 0, min: 0 };
    for (const deg of [17, 33, 61, 90]) {
      const rot = new THREE.Quaternion().setFromAxisAngle(normal, THREE.MathUtils.degToRad(deg));
      const scale = projectedStepScale(
        point, u.clone().applyQuaternion(rot), v.clone().applyQuaternion(rot),
        camera, width, height,
      );
      turned.max = Math.max(turned.max, Math.abs(scale!.maxPx / base!.maxPx - 1));
      turned.min = Math.max(turned.min, Math.abs(scale!.minPx / base!.minPx - 1));
    }
    // Equal to the difference two forward differences can make: the singular
    // values themselves do not depend on the basis.
    expect(turned.max).toBeLessThan(1e-4);
    expect(turned.min).toBeLessThan(1e-3);
  });

  it('reports nothing for a point behind the camera, on its plane, or inside the near plane', () => {
    const camera = lensCamera(width, height);
    const [u, v] = perpendicularSteps(new THREE.Vector3(0, 0, -1), step);
    expect(projectedStepScale(new THREE.Vector3(0, 0, 5), u, v, camera, width, height)).toBeNull();
    expect(projectedStepScale(new THREE.Vector3(0, 0, 0), u, v, camera, width, height)).toBeNull();
    expect(projectedStepScale(new THREE.Vector3(0.2, 0.1, -1e-9), u, v, camera, width, height)).toBeNull();
    // Behind a camera that has been moved and turned, too.
    camera.position.set(5, 2, -3);
    camera.lookAt(6, 2, -3);
    camera.updateMatrixWorld(true);
    expect(projectedStepScale(new THREE.Vector3(-5, 2, -3), u, v, camera, width, height)).toBeNull();
    expect(projectedStepScale(new THREE.Vector3(15, 2, -3), u, v, camera, width, height)).not.toBeNull();
  });

  it('never exceeds the frame-scale bound bodies are gated on', () => {
    // What the sector streamer relies on to skip a whole globe: the centre
    // focal length times lensMaxFrameScale, over the distance, bounds the
    // magnification of any patch anywhere in the frame.
    for (const [w, h] of [[390, 844], [1600, 900]] as const) {
      for (const camera of sweepCameras(w, h)) {
        const bound = centreFocalPx(camera, h)
          * lensMaxFrameScale(displayFovDeg(camera), camera.aspect, strengthOf(camera));
        for (const ndcX of [0, 0.5, 1]) {
          for (const ndcY of [0, 0.5, 1]) {
            const distance = 10;
            const ray = screenPointToWorldRay(
              (ndcX * 0.5 + 0.5) * w, (-ndcY * 0.5 + 0.5) * h, camera, w, h, new THREE.Vector3(),
            );
            const [u, v] = perpendicularSteps(ray, step);
            const scale = projectedStepScale(
              ray.clone().multiplyScalar(distance), u, v, camera, w, h,
            );
            expect(scale).not.toBeNull();
            expect(scale!.maxPx / step).toBeLessThanOrEqual((bound / distance) * 1.002);
          }
        }
      }
    }
  });
});

describe('placeSphereInFrustum', () => {
  const width = 1600;
  const height = 900;

  it('never calls a sphere aside while its measured footprint is on the frame', () => {
    // The property the sector streamer's off-frame test rests on: whatever the
    // 32-ray measurement can see, the plane tests keep.
    for (const [w, h] of [[390, 844], [1600, 900]] as const) {
      for (const camera of sweepCameras(w, h)) {
        const designFov = camera.userData.lens?.designFovDeg ?? camera.fov;
        for (const offFraction of [0, 0.5, 0.95, 1.2, 2]) {
          for (const az of [0, 45, 90, 200]) {
            for (const alphaDeg of [0.05, 2, 8, 30]) {
              const { centre, radius } = sphereAt((designFov / 2) * offFraction, az, alphaDeg);
              const full = projectSphereToScreen(centre, radius, camera, w, h);
              const onFrame = full.footprintKind !== 'none'
                && full.maxX >= 0 && full.minX <= w && full.maxY >= 0 && full.minY <= h;
              if (!onFrame) continue;
              // A rectilinear camera stretches a wide sphere past 60° off axis
              // into a footprint millions of pixels across, which straddles the
              // canvas by arithmetic rather than by being visible. Nothing
              // consumes a reading like that; skip it rather than pretend the
              // plane tests should agree with it.
              if (full.radiusPx > Math.hypot(w, h) * 4) continue;
              expect(placeSphereInFrustum(centre, radius, camera)).toBe('inside');
            }
          }
        }
      }
    }
  });

  it('keeps a sphere the camera sits inside, whatever its centre projects to', () => {
    // The grazing-limb case: the camera is inside a sector's bounding sphere,
    // whose centre sits behind the camera plane and projects far off frame.
    const camera = lensCamera(width, height);
    const centre = new THREE.Vector3(0.9, 0, 0.2);
    const radius = 4;
    const projected = projectSphereToScreen(centre, radius, camera, width, height);
    expect(projected.footprintKind).toBe('covering');
    expect(projected.footprintX).toBeLessThan(0); // the misleading reading
    expect(placeSphereInFrustum(centre, radius, camera)).toBe('inside');
  });

  it('reports behind and aside for spheres that reach no pixel', () => {
    const camera = lensCamera(width, height);
    expect(placeSphereInFrustum(new THREE.Vector3(0, 0, 10), 1, camera)).toBe('behind');
    expect(placeSphereInFrustum(new THREE.Vector3(0, 0, -10), 1, camera)).toBe('inside');
    const rad85 = THREE.MathUtils.degToRad(85);
    expect(placeSphereInFrustum(
      new THREE.Vector3(Math.sin(rad85) * 10, 0, -Math.cos(rad85) * 10), 1.8, camera,
    )).toBe('aside');
    // Translated and turned camera: the tests are in view space, not world.
    camera.position.set(5, 2, -3);
    camera.lookAt(6, 2, -3);
    camera.updateMatrixWorld(true);
    expect(placeSphereInFrustum(new THREE.Vector3(15, 2, -3), 1, camera)).toBe('inside');
    expect(placeSphereInFrustum(new THREE.Vector3(-5, 2, -3), 1, camera)).toBe('behind');
    expect(placeSphereInFrustum(new THREE.Vector3(15, 60, -3), 1, camera)).toBe('aside');
  });

  it('holds the overscan margin inside: the displayed frame is a subset of it', () => {
    const camera = lensCamera(width, height);
    // Just past the displayed frame's top edge, well inside the wider render
    // frustum the lens pass resamples.
    const theta = THREE.MathUtils.degToRad(displayFovDeg(camera) / 2 + 4);
    const centre = new THREE.Vector3(0, Math.sin(theta) * 10, -Math.cos(theta) * 10);
    expect(camera.fov).toBeGreaterThan(displayFovDeg(camera));
    expect(placeSphereInFrustum(centre, 0.01, camera)).toBe('inside');
  });
});
