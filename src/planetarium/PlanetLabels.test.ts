import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { applyDesignFov } from '../shared/math/lensProjection';
import { projectToScreen, screenPointToWorldRay } from '../shared/three/projectToScreen';
import {
  discRadiusPx,
  pickBodyAtPointer,
  sphereHidesPoint,
  type ForegroundSphere,
  type PickCandidate,
} from './PlanetLabels';

const DEG = Math.PI / 180;
const AU_PER_KM = 1 / 149597870.7;
const EARTH_R = 6371 * AU_PER_KM;

// A body straight ahead (−z): its picker catch and its sight line.
function candidate(over: Partial<PickCandidate> & { name: string }): PickCandidate {
  return {
    screenX: 0, screenY: 0, pickRadiusPx: 20, distFromCamera: 10, dirX: 0, dirY: 0, dirZ: -1, ...over,
  };
}
// A unit sphere on that same line, `distFromCamera` ahead unless placed.
function blocker(over: Partial<ForegroundSphere> & { name: string }): ForegroundSphere {
  const dist = over.distFromCamera ?? 5;
  return { x: 0, y: 0, z: -dist, radiusAU: 1, distFromCamera: dist, ...over };
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

describe('sphereHidesPoint', () => {
  // Earth's centre straight below a camera 300 km up: the horizon dips
  // acos(R / (R + h)) ≈ 17.2° under the horizontal, and the centre itself sits
  // beside the camera plane whenever the view runs along the ground — the
  // pose where a circle fitted on the screen had nothing honest to offer.
  const h = 300 * AU_PER_KM;
  const earth: ForegroundSphere = {
    x: 0, y: -(EARTH_R + h), z: 0, radiusAU: EARTH_R, distFromCamera: EARTH_R + h, name: 'Earth',
  };
  const dip = Math.acos(EARTH_R / (EARTH_R + h));
  // A sight line `a` below the horizontal, in the plane of the centre.
  const below = (a: number) => [Math.cos(a), -Math.sin(a), 0] as const;

  it('hides a far body under the horizon seen from low orbit, and shows one above it', () => {
    const far = 5; // AU: Jupiter
    expect(sphereHidesPoint(earth, ...below(dip + 1 * DEG), far)).toBe(true);
    expect(sphereHidesPoint(earth, ...below(dip - 1 * DEG), far)).toBe(false);
    // Exact to a hundredth of a degree either side of the limb.
    expect(sphereHidesPoint(earth, ...below(dip + 0.01 * DEG), far)).toBe(true);
    expect(sphereHidesPoint(earth, ...below(dip - 0.01 * DEG), far)).toBe(false);
    // Straight ahead along the ground is sky; straight down is ground.
    expect(sphereHidesPoint(earth, 1, 0, 0, far)).toBe(false);
    expect(sphereHidesPoint(earth, 0, -1, 0, far)).toBe(true);
  });

  it('a body between the camera and the ground stays visible; one beyond the ground hides', () => {
    // Straight down: the ground is h away.
    expect(sphereHidesPoint(earth, 0, -1, 0, h * 0.5)).toBe(false);
    expect(sphereHidesPoint(earth, 0, -1, 0, h * 1.5)).toBe(true);
  });

  it('a sphere behind the camera hides nothing in front of it', () => {
    const behind = blocker({ name: 'Mars', x: 0, y: 0, z: 5, distFromCamera: 5 });
    expect(sphereHidesPoint(behind, 0, 0, -1, 100)).toBe(false);
    expect(sphereHidesPoint(behind, 0, 0.2, -0.98, 100)).toBe(false);
  });

  it('just inside the limb hides, just outside does not', () => {
    const ball = blocker({ name: 'Jupiter', distFromCamera: 10 }); // limb at asin(1/10)
    const limb = Math.asin(0.1);
    const aside = (a: number) => [Math.sin(a), 0, -Math.cos(a)] as const;
    expect(sphereHidesPoint(ball, ...aside(limb - 1e-4), 100)).toBe(true);
    expect(sphereHidesPoint(ball, ...aside(limb + 1e-4), 100)).toBe(false);
  });

  it('a label pixel under the horizon is hidden through the lens, one above it is not', () => {
    // The whole path a label takes: its anchor pixel, back through the lens
    // to its sight line, against the sphere — on a camera looking along the
    // ground, Earth's centre straight below it.
    const width = 1600;
    const height = 900;
    const camera = new THREE.PerspectiveCamera(60, width / height, 0.01, 100);
    camera.userData.lens = { strength: 1, designFovDeg: 60 };
    applyDesignFov(camera, 60);
    camera.position.set(0, 0, 0);
    camera.quaternion.identity(); // looking along −z, horizontal
    camera.updateMatrixWorld(true);
    const line = new THREE.Vector3();
    for (const [offsetDeg, hidden] of [[1, true], [-1, false], [8, true], [-8, false]] as const) {
      const a = dip + offsetDeg * DEG;
      // Where a far body that far under the horizontal is drawn.
      const far = { x: 0, y: -Math.sin(a) * 5, z: -Math.cos(a) * 5 };
      const px = projectToScreen(far, camera, width, height);
      screenPointToWorldRay(px.x, px.y, camera, width, height, line);
      expect(sphereHidesPoint(earth, line.x, line.y, line.z, 5)).toBe(hidden);
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

  it('rejects a candidate whose sight line passes through a nearer blocker', () => {
    const cands = [candidate({ name: 'Neptune', screenX: 100, screenY: 100, distFromCamera: 30 })];
    const blockers = [blocker({ name: 'Jupiter', distFromCamera: 5 })];
    expect(pickBodyAtPointer(cands, blockers, 100, 100)).toBeNull();
  });

  it('a nearer blocker beside the sight line does not occlude', () => {
    const cands = [candidate({ name: 'Neptune', screenX: 100, screenY: 100, distFromCamera: 30 })];
    const blockers = [blocker({ name: 'Jupiter', x: 1.5, y: 0, z: -5, distFromCamera: Math.hypot(1.5, 5) })];
    expect(pickBodyAtPointer(cands, blockers, 100, 100)).toBe('Neptune');
  });

  it('a farther blocker does not occlude', () => {
    const cands = [candidate({ name: 'Neptune', screenX: 100, screenY: 100, distFromCamera: 5 })];
    const blockers = [blocker({ name: 'Jupiter', distFromCamera: 30 })];
    expect(pickBodyAtPointer(cands, blockers, 100, 100)).toBe('Neptune');
  });

  it('the ship blocks but is never returned (it is not a candidate)', () => {
    const cands = [candidate({ name: 'Saturn', screenX: 100, screenY: 100, distFromCamera: 40 })];
    const shipBlocker = [blocker({ name: 'ship', distFromCamera: 1, radiusAU: 0.5 })];
    expect(pickBodyAtPointer(cands, shipBlocker, 100, 100)).toBeNull();
  });

  it('a moon sphere never occludes its own pick (moon: prefix stripped)', () => {
    // Its own sphere's near face is nearer than its centre, so only the name
    // exclusion keeps the pick alive.
    const cands = [candidate({ name: 'Io', screenX: 100, screenY: 100, distFromCamera: 20 })];
    const ownSphere = [blocker({ name: 'moon:Io', distFromCamera: 20 })];
    expect(pickBodyAtPointer(cands, ownSphere, 100, 100)).toBe('Io');
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
