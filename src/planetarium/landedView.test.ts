import { describe, it, expect } from 'vitest';
import { LANDED_FRAME_RADII, landedFrameCamDistAU, landedMinDistanceAU } from './landedView';

const RAD2DEG = 180 / Math.PI;
const NEAR_AU = 0.000001; // planetariumCamera near plane (main.ts)
const KM_PER_AU = 149_597_870.7;

// Angular diameter (deg) the rendered body subtends from the landing camera,
// which sits 1.5·camDist from the body (the (d, d/2, d) placement).
function framedDiameterDeg(renderedRadiusAU: number): number {
  const dist = landedFrameCamDistAU(renderedRadiusAU, NEAR_AU) * 1.5;
  return 2 * Math.atan(renderedRadiusAU / dist) * RAD2DEG;
}

// Rendered radii (AU): planets at true size; a Pluto small moon is floored to
// 5% of Pluto — the smallest landable target, the case a too-large guard breaks.
const EARTH = 6378 / KM_PER_AU;
const JUPITER = 71_492 / KM_PER_AU;
const PLUTO_SMALL_MOON = 0.05 * (1188 / KM_PER_AU);

describe('landed framing', () => {
  it('frames every body to ~⅓ of the 60° view (~18.9°), independent of size', () => {
    for (const renderedRadiusAU of [EARTH, JUPITER, PLUTO_SMALL_MOON]) {
      expect(framedDiameterDeg(renderedRadiusAU)).toBeCloseTo(18.92, 1);
    }
  });

  it('frames the smallest real body by its radius, not the guard', () => {
    expect(landedFrameCamDistAU(PLUTO_SMALL_MOON, NEAR_AU)).toBe(PLUTO_SMALL_MOON * LANDED_FRAME_RADII);
  });

  it('guards only a degenerate zero radius', () => {
    expect(landedFrameCamDistAU(0, NEAR_AU)).toBe(NEAR_AU * 1.5);
  });

  it('keeps the surface in front of the near plane at max zoom-in', () => {
    const surfaceClearance = landedMinDistanceAU(PLUTO_SMALL_MOON, NEAR_AU) - PLUTO_SMALL_MOON;
    expect(surfaceClearance).toBeGreaterThanOrEqual(NEAR_AU);
  });
});
