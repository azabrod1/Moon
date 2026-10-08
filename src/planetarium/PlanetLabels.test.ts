import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  discOccludesScreenPoint,
  discRadiusPx,
  footprintNeedsCone,
  occluderCone,
  pickBodyAtPointer,
  type ForegroundDisc,
  type PickCandidate,
  type ScreenRayResolver,
} from './PlanetLabels';
import { projectSphereToScreen, screenPointToWorldRay } from '../shared/three/projectToScreen';

function candidate(over: Partial<PickCandidate> & { name: string }): PickCandidate {
  return { screenX: 0, screenY: 0, pickRadiusPx: 20, distFromCamera: 10, ...over };
}
function blocker(over: Partial<ForegroundDisc> & { name: string }): ForegroundDisc {
  return { screenX: 0, screenY: 0, radiusPx: 20, distFromCamera: 5, ...over };
}

// Screen geometry shared by the cases: fov 60° (halfFovTan ≈ 0.5774), 900 px tall.
const HALF_FOV_TAN = Math.tan((60 * Math.PI) / 360);
const CANVAS_H = 900;

describe('discRadiusPx', () => {
  it('matches the linear R/d projection in the far field', () => {
    const R = 0.0004; // ~Saturn in AU
    const d = R * 1000;
    const linear = (R / (d * HALF_FOV_TAN)) * (CANVAS_H / 2);
    const exact = discRadiusPx(R, d, HALF_FOV_TAN, CANVAS_H);
    // R/√(d²−R²) → R/d as d ≫ R; at 1000R they differ by <0.0001%.
    expect(exact).toBeCloseTo(linear, 6);
  });

  it('projects the true silhouette up close, wider than R/d', () => {
    const R = 0.0004;
    const d = R * 1.2; // a landed/orbit camera just off the surface
    const expected = (R / (Math.sqrt(d * d - R * R) * HALF_FOV_TAN)) * (CANVAS_H / 2);
    expect(discRadiusPx(R, d, HALF_FOV_TAN, CANVAS_H)).toBeCloseTo(expected, 8);
    // The linear form under-reads this by ~34% — the gap that let labels of
    // moons hidden behind the planet leak onto its rendered face.
    const linear = (R / (d * HALF_FOV_TAN)) * (CANVAS_H / 2);
    expect(discRadiusPx(R, d, HALF_FOV_TAN, CANVAS_H)).toBeGreaterThan(linear * 1.3);
  });

  it('stays finite and screen-covering with the camera at or inside the surface', () => {
    const R = 0.0004;
    for (const d of [R, R * 0.5, 0]) {
      const px = discRadiusPx(R, d, HALF_FOV_TAN, CANVAS_H);
      expect(Number.isFinite(px)).toBe(true);
      expect(px).toBeGreaterThan(CANVAS_H * 4); // covers any screen
    }
  });
});

describe('pickBodyAtPointer', () => {
  it('hits a body whose catch radius contains the pointer', () => {
    const cands = [candidate({ name: 'Mars', screenX: 100, screenY: 100, pickRadiusPx: 20 })];
    expect(pickBodyAtPointer(cands, [], 110, 105)).toBe('Mars');
  });

  it('misses when the pointer is outside every catch radius', () => {
    const cands = [candidate({ name: 'Mars', screenX: 100, screenY: 100, pickRadiusPx: 20 })];
    expect(pickBodyAtPointer(cands, [], 200, 200)).toBeNull();
  });

  it('catches a tiny dot through its floored catch radius', () => {
    // A distant marker draws sub-pixel, but the mode floors pickRadiusPx to 18.
    const cands = [candidate({ name: 'Pluto', screenX: 100, screenY: 100, pickRadiusPx: 18 })];
    expect(pickBodyAtPointer(cands, [], 115, 100)).toBe('Pluto'); // 15 px away
  });

  it('rejects a candidate whose centre sits under a nearer blocker', () => {
    const cands = [candidate({ name: 'Neptune', screenX: 100, screenY: 100, distFromCamera: 30 })];
    const blockers = [blocker({ name: 'Jupiter', screenX: 100, screenY: 100, radiusPx: 40, distFromCamera: 5 })];
    expect(pickBodyAtPointer(cands, blockers, 100, 100)).toBeNull();
  });

  it('a farther blocker does not occlude', () => {
    const cands = [candidate({ name: 'Neptune', screenX: 100, screenY: 100, distFromCamera: 5 })];
    const blockers = [blocker({ name: 'Jupiter', screenX: 100, screenY: 100, radiusPx: 40, distFromCamera: 30 })];
    expect(pickBodyAtPointer(cands, blockers, 100, 100)).toBe('Neptune');
  });

  it('the ship blocks but is never returned (it is not a candidate)', () => {
    const cands = [candidate({ name: 'Saturn', screenX: 100, screenY: 100, distFromCamera: 40 })];
    const shipBlocker = [blocker({ name: 'ship', screenX: 100, screenY: 100, radiusPx: 30, distFromCamera: 1 })];
    expect(pickBodyAtPointer(cands, shipBlocker, 100, 100)).toBeNull();
  });

  it('a moon disc never occludes its own pick (moon: prefix stripped)', () => {
    const cands = [candidate({ name: 'Io', screenX: 100, screenY: 100, distFromCamera: 20 })];
    const ownDisc = [blocker({ name: 'moon:Io', screenX: 100, screenY: 100, radiusPx: 40, distFromCamera: 20 })];
    expect(pickBodyAtPointer(cands, ownDisc, 100, 100)).toBe('Io');
  });

  it('the nearest pointer-to-centre distance wins', () => {
    const cands = [
      candidate({ name: 'Far', screenX: 100, screenY: 100, pickRadiusPx: 40 }),
      candidate({ name: 'Near', screenX: 108, screenY: 100, pickRadiusPx: 40 }),
    ];
    expect(pickBodyAtPointer(cands, [], 110, 100)).toBe('Near');
  });

  it('an exact distance tie breaks to the nearer body in depth', () => {
    const cands = [
      candidate({ name: 'Behind', screenX: 100, screenY: 100, pickRadiusPx: 40, distFromCamera: 50 }),
      candidate({ name: 'Front', screenX: 100, screenY: 100, pickRadiusPx: 40, distFromCamera: 10 }),
    ];
    expect(pickBodyAtPointer(cands, [], 100, 100)).toBe('Front');
  });
});

describe('occluderCone', () => {
  it('points at the body with the padded angular radius', () => {
    // A unit sphere 2 units down +X: angular radius 30°, padded 1.1× in the sine.
    const cone = occluderCone(0, 0, 0, 2, 0, 0, 1, 1.1)!;
    expect(cone.dirX).toBeCloseTo(1, 12);
    expect(cone.dirY).toBeCloseTo(0, 12);
    expect(cone.dirZ).toBeCloseTo(0, 12);
    expect(cone.cosHalfAngle).toBeCloseTo(Math.sqrt(1 - 0.55 * 0.55), 12);
  });

  it('is null with the camera on or inside the body, and for no radius', () => {
    expect(occluderCone(0, 0, 0, 1, 0, 0, 1, 1)).toBeNull();
    expect(occluderCone(0, 0, 0, 0.5, 0, 0, 1, 1)).toBeNull();
    expect(occluderCone(0, 0, 0, 2, 0, 0, 0, 1)).toBeNull();
  });

  it('a body that nearly fills the sky stays a cone short of the whole sphere', () => {
    const cone = occluderCone(0, 0, 0, 1.05, 0, 0, 1, 1.1)!;
    expect(cone.cosHalfAngle).toBeGreaterThan(0);
  });

  it('the pad stops halfway to a camera skimming the surface', () => {
    // At 1.01 R the true angular radius is 81.9°. A full 1.1× pad would put
    // the camera inside the padded sphere and the cone at ~90° — the whole
    // half-space below the horizontal. Halfway (1.005 R) is 84.3°.
    const cone = occluderCone(0, 0, 0, 1.01, 0, 0, 1, 1.1)!;
    const halfAngleDeg = THREE.MathUtils.radToDeg(Math.acos(cone.cosHalfAngle));
    expect(halfAngleDeg).toBeCloseTo(THREE.MathUtils.radToDeg(Math.asin(1.005 / 1.01)), 6);
    expect(halfAngleDeg).toBeLessThan(85);
    // Far from the body the pad is the full 1.1×, as the screen circle's is.
    const far = occluderCone(0, 0, 0, 10, 0, 0, 1, 1.1)!;
    expect(far.cosHalfAngle).toBeCloseTo(Math.sqrt(1 - 0.11 * 0.11), 12);
  });
});

describe('footprintNeedsCone', () => {
  it('only the covering guess needs one', () => {
    expect(footprintNeedsCone('covering')).toBe(true);
    expect(footprintNeedsCone('sampled')).toBe(false);
    expect(footprintNeedsCone('none')).toBe(false);
  });
});

describe('discOccludesScreenPoint', () => {
  // A resolver that reads the screen point as a direction: x across, y down,
  // on a unit sphere, so a cone test can be posed in pixels.
  const rayFromScreen: ScreenRayResolver = (x, y, out) => {
    const len = Math.hypot(x, y, 100);
    out.x = x / len; out.y = y / len; out.z = 100 / len;
    return out;
  };

  it('a disc without a cone is its screen circle', () => {
    const disc = blocker({ name: 'Mars', screenX: 100, screenY: 100, radiusPx: 20 });
    expect(discOccludesScreenPoint(disc, 110, 100, rayFromScreen)).toBe(true);
    expect(discOccludesScreenPoint(disc, 130, 100, rayFromScreen)).toBe(false);
  });

  it('a disc with a cone ignores its circle and tests the ray', () => {
    // The cone looks straight down +Z with a 30° half-angle; the circle is a
    // dot at the origin that would cover nothing.
    const disc = blocker({
      name: 'Mars', screenX: 0, screenY: 0, radiusPx: 0,
      cone: { dirX: 0, dirY: 0, dirZ: 1, cosHalfAngle: Math.cos(THREE.MathUtils.degToRad(30)) },
    });
    // 100·tan(20°) px off the axis is inside the cone; 100·tan(40°) is outside.
    expect(discOccludesScreenPoint(disc, 100 * Math.tan(THREE.MathUtils.degToRad(20)), 0, rayFromScreen)).toBe(true);
    expect(discOccludesScreenPoint(disc, 100 * Math.tan(THREE.MathUtils.degToRad(40)), 0, rayFromScreen)).toBe(false);
  });

  it('a cone disc covers nothing without a resolver — it errs visible, never blank', () => {
    const disc = blocker({
      name: 'Mars', screenX: 0, screenY: 0, radiusPx: 5000,
      cone: { dirX: 0, dirY: 0, dirZ: 1, cosHalfAngle: 0.5 },
    });
    expect(discOccludesScreenPoint(disc, 0, 0)).toBe(false);
  });

  it('pickBodyAtPointer honours a cone blocker through the resolver', () => {
    const cands = [
      candidate({ name: 'Saturn', screenX: 10, screenY: 0, distFromCamera: 40 }),
      candidate({ name: 'Uranus', screenX: 200, screenY: 0, distFromCamera: 60 }),
    ];
    const blockers = [blocker({
      name: 'Mars', screenX: 0, screenY: 0, radiusPx: 5000, distFromCamera: 1,
      cone: { dirX: 0, dirY: 0, dirZ: 1, cosHalfAngle: Math.cos(THREE.MathUtils.degToRad(30)) },
    })];
    expect(pickBodyAtPointer(cands, blockers, 10, 0, rayFromScreen)).toBeNull();
    expect(pickBodyAtPointer(cands, blockers, 200, 0, rayFromScreen)).toBe('Uranus');
    // Without the resolver the covering circle is never consulted either.
    expect(pickBodyAtPointer(cands, blockers, 10, 0)).toBe('Saturn');
  });
});

describe('a world that fills half the frame, with the view turned part way off it', () => {
  // The parked-ship case: Mars at a 55° angular radius, its centre 35° off the
  // view axis. A rim ray crosses the camera plane, so the projection has no
  // limb to sample and answers the viewport-covering guess — a circle of the
  // viewport diagonal that, used as an occluder, hid Saturn in clear sky on
  // the far side of the frame (and every other marker and label with it).
  const W = 1600;
  const H = 900;
  const camera = new THREE.PerspectiveCamera(60, W / H, 1e-7, 10);
  const off = THREE.MathUtils.degToRad(35);
  camera.position.set(0, 0, 0);
  camera.lookAt(new THREE.Vector3(Math.sin(off), 0, -Math.cos(off)));
  camera.updateMatrixWorld();
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  const radiusAU = Math.sin(THREE.MathUtils.degToRad(55));
  const mars = { x: 0, y: 0, z: -1 };
  const proj = projectSphereToScreen(mars, radiusAU, camera, W, H);
  const rayAt: ScreenRayResolver = (x, y, out) => {
    const ray = screenPointToWorldRay(x, y, camera, W, H, new THREE.Vector3());
    out.x = ray.x; out.y = ray.y; out.z = ray.z;
    return out;
  };

  it('is the case the projection cannot measure', () => {
    expect(proj.footprintKind).toBe('covering');
    expect(proj.radiusPx).toBeCloseTo(Math.hypot(W, H), 6);
  });

  it('as a circle it would hide the whole frame; as a cone it hides the face and nothing else', () => {
    const circle = blocker({
      name: 'Mars', screenX: proj.footprintX, screenY: proj.footprintY, radiusPx: proj.radiusPx * 1.1,
      distFromCamera: 1,
    });
    const asCone = blocker({ ...circle, cone: occluderCone(0, 0, 0, mars.x, mars.y, mars.z, radiusAU, 1.1) });
    // Clear sky at the frame's far edge, 56° from Mars's centre: the circle
    // swallows it, the cone does not.
    const clearSkyX = W - 10;
    expect(discOccludesScreenPoint(circle, clearSkyX, H / 2, rayAt)).toBe(true);
    expect(discOccludesScreenPoint(asCone, clearSkyX, H / 2, rayAt)).toBe(false);
    // The face of Mars, left of centre: both hide a point there.
    expect(discOccludesScreenPoint(asCone, 10, H / 2, rayAt)).toBe(true);
    // The limb, where the cone's padded edge lies: the test turns over within
    // a few degrees of 60.5° (55° padded 1.1× in the sine) from the centre.
    const angleOf = (x: number) => {
      const ray = rayAt(x, H / 2, { x: 0, y: 0, z: 0 })!;
      return THREE.MathUtils.radToDeg(Math.acos(-ray.z));
    };
    let limbX = 0;
    for (let x = 0; x < W; x += 1) {
      if (!discOccludesScreenPoint(asCone, x, H / 2, rayAt)) { limbX = x; break; }
    }
    const padded = THREE.MathUtils.radToDeg(Math.asin(Math.min(1.1 * radiusAU, 1)));
    expect(angleOf(limbX)).toBeCloseTo(padded, 0);
  });
});
