import { describe, expect, it } from 'vitest';
import {
  COVERAGE_E,
  SOLAR_EXPOSURE_FLOOR,
  TAU_DIM,
  TAU_RECOVER,
  solarExposureTarget,
  solarViewportCoverage,
  stepExposure,
} from './solarExposure';

const FOVY = Math.PI / 3; // 60°
const ASPECT = 16 / 9;
const SUN_R = 0.00465; // AU, ≈ the real photosphere radius the app uses

/** Coverage for a disc centred dead ahead at distance `d` (in radii). */
function coverageCentered(dOverR: number, fovY = FOVY, aspect = ASPECT): number {
  return solarViewportCoverage(0, 0, -dOverR, 1, fovY, aspect);
}

describe('solarViewportCoverage', () => {
  it('reads 0 (and target 1) when the Sun is far, off-screen, or behind', () => {
    // Far ahead, tiny disc.
    expect(coverageCentered(215)).toBeGreaterThan(0);
    expect(coverageCentered(215)).toBeLessThan(1e-3);
    // Directly behind the camera (positive z is behind the −z view axis).
    expect(solarViewportCoverage(0, 0, 5, 1, FOVY, ASPECT)).toBe(0);
    // Off to the side, well outside the frustum.
    expect(solarViewportCoverage(50, 0, -1, 1, FOVY, ASPECT)).toBe(0);
    // Coverage 0 → target is exactly 1.
    expect(solarExposureTarget(0)).toBe(1);
  });

  it('is nondecreasing as the disc grows (rho up) at a fixed centre', () => {
    let prev = -1;
    for (let r = 0.001; r <= 0.9; r += 0.02) {
      // Fixed centre (dead ahead) at fixed distance; larger radius → larger rho.
      const c = solarViewportCoverage(0, 0, -1, r, FOVY, ASPECT);
      expect(c).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = c;
    }
  });

  it('is nondecreasing as distance shrinks along a fixed ray', () => {
    const dir = new Float64Array([0.15, -0.1, -1]);
    const len = Math.hypot(dir[0], dir[1], dir[2]);
    let prev = -1;
    for (let d = 40; d >= 1.0; d -= 0.25) {
      const s = d / len;
      const c = solarViewportCoverage(dir[0] * s, dir[1] * s, dir[2] * s, 1, FOVY, ASPECT);
      expect(c).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = c;
    }
  });

  it('target is nonincreasing over a coverage grid', () => {
    let prev = Infinity;
    for (let c = 0; c <= 1; c += 0.01) {
      const t = solarExposureTarget(c);
      expect(t).toBeLessThanOrEqual(prev + 1e-12);
      prev = t;
    }
  });

  it('slides across the viewport edge continuously, hitting exactly 0 once fully out', () => {
    // March the disc centre horizontally out of frame in fine steps.
    const r = 0.05;
    const d = 1;
    let prev = solarViewportCoverage(0, 0, -d, r, FOVY, ASPECT);
    let sawZero = false;
    for (let x = 0; x <= 3; x += 0.01) {
      const c = solarViewportCoverage(x, 0, -d, r, FOVY, ASPECT);
      expect(Math.abs(c - prev)).toBeLessThan(0.02); // bounded per-step delta
      if (c === 0) sawZero = true;
      prev = c;
    }
    expect(sawZero).toBe(true);
  });

  it('does not jump across the d → R boundary', () => {
    const justOutside = coverageCentered(1.0001);
    const atSurface = coverageCentered(1); // hits the d <= R early return
    expect(atSurface).toBe(1);
    // A disc at the surface overflows the frame, so just outside it is already ~1.
    expect(justOutside).toBeGreaterThan(0.99);
    expect(Math.abs(atSurface - justOutside)).toBeLessThan(0.01);
  });

  it('is monotone and jump-free as d shrinks through R into the early return', () => {
    let prev = -1;
    for (let dOverR = 3; dOverR >= 0.2; dOverR -= 0.02) {
      const c = coverageCentered(dOverR);
      expect(c).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(c).toBeLessThanOrEqual(1 + 1e-12);
      prev = c;
    }
  });

  it('matches 4·rho²/(fovX·fovY) for a small fully-inside centred disc', () => {
    const d = 20; // radii — disc comfortably inside the frame
    const rho = Math.asin(1 / d);
    const fovX = 2 * Math.atan(Math.tan(FOVY / 2) * ASPECT);
    const expected = (4 * rho * rho) / (fovX * FOVY);
    expect(coverageCentered(d)).toBeCloseTo(expected, 6);
  });

  it('returns exactly 1 at and inside the photosphere; target there is the floor', () => {
    for (const dOverR of [1, 0.5, 0]) {
      expect(coverageCentered(dOverR)).toBe(1);
    }
    expect(solarExposureTarget(1)).toBeCloseTo(SOLAR_EXPOSURE_FLOOR, 4);
  });

  it('handles portrait aspect and reaches 1 sooner in a narrow FOV', () => {
    // Portrait (aspect 0.5): finite, monotone.
    let prev = -1;
    for (let dOverR = 30; dOverR >= 1.2; dOverR -= 0.5) {
      const c = coverageCentered(dOverR, FOVY, 0.5);
      expect(Number.isFinite(c)).toBe(true);
      expect(c).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = c;
    }
    // A narrow FOV frames the disc larger, so coverage is higher at equal distance.
    const wide = coverageCentered(8, FOVY, ASPECT);
    const narrow = coverageCentered(8, (1.5 * Math.PI) / 180, ASPECT);
    expect(narrow).toBeGreaterThan(wide);
    expect(narrow).toBe(1); // a 1.5° frame is filled by a disc 8 radii away
  });

  it('returns a finite value in [0,1] for any finite inputs', () => {
    const samples = [-100, -1, -0.001, 0.001, 1, 37, 1e6];
    for (const x of samples) {
      for (const y of samples) {
        for (const z of samples) {
          const c = solarViewportCoverage(x, y, z, 0.3, FOVY, ASPECT);
          expect(Number.isFinite(c)).toBe(true);
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('degenerates to 0 when aspect is 0 (fovX collapses)', () => {
    expect(solarViewportCoverage(0, 0, -5, 1, FOVY, 0)).toBe(0);
  });
});

describe('solarExposureTarget — constants sweep', () => {
  const place = (dOverR: number) => solarViewportCoverage(0, 0, -dOverR * SUN_R, SUN_R, FOVY, ASPECT);

  it('crushes near the Sun and opens up far away', () => {
    // Earth-distance (~215 R): coverage tiny, exposure essentially 1.
    const earth = place(215);
    expect(earth).toBeLessThan(1e-3);
    expect(solarExposureTarget(earth)).toBeGreaterThan(0.99);

    // 10 R: mid recovery.
    expect(solarExposureTarget(place(10))).toBeCloseTo(0.74, 1);

    // 3 R: deep in the crush.
    const t3 = solarExposureTarget(place(3));
    expect(t3).toBeGreaterThan(0.055);
    expect(t3).toBeLessThan(0.075);

    // At the photosphere: the floor.
    expect(solarExposureTarget(place(1))).toBeCloseTo(SOLAR_EXPOSURE_FLOOR, 4);
  });

  it('exposes tuned constants', () => {
    expect(SOLAR_EXPOSURE_FLOOR).toBe(0.04);
    expect(COVERAGE_E).toBe(0.075);
    expect(TAU_DIM).toBeLessThan(TAU_RECOVER); // clamp down fast, open up slow
  });
});

describe('stepExposure', () => {
  it('clamps down faster than it recovers over equal dt', () => {
    const dimStep = 1 - stepExposure(1, SOLAR_EXPOSURE_FLOOR, 0.1); // ground covered falling
    const recoverStep = stepExposure(SOLAR_EXPOSURE_FLOOR, 1, 0.1) - SOLAR_EXPOSURE_FLOOR;
    expect(dimStep).toBeGreaterThan(recoverStep);
  });

  it('converges toward the target from both directions', () => {
    let down = 1;
    let up = SOLAR_EXPOSURE_FLOOR;
    for (let i = 0; i < 400; i++) {
      down = stepExposure(down, SOLAR_EXPOSURE_FLOOR, 0.05);
      up = stepExposure(up, 1, 0.05);
    }
    expect(down).toBeCloseTo(SOLAR_EXPOSURE_FLOOR, 3);
    expect(up).toBeCloseTo(1, 3);
  });

  it('a huge dt lands essentially on the target, and dt <= 0 holds current', () => {
    expect(stepExposure(1, 0.1, 1000)).toBeCloseTo(0.1, 6);
    expect(stepExposure(0.5, 0.9, 0)).toBe(0.5);
    expect(stepExposure(0.5, 0.9, -3)).toBe(0.5);
  });
});
