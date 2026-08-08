import { describe, it, expect } from 'vitest';
import {
  discRadiusPx,
  pickBodyAtPointer,
  type ForegroundDisc,
  type PickCandidate,
} from './PlanetLabels';

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
