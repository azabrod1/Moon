import { describe, it, expect } from 'vitest';
import { discRadiusPx } from './PlanetLabels';

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
