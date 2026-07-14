import { describe, it, expect } from 'vitest';
import {
  LANDED_FRAME_RADII,
  LANDED_NEAR_AU,
  landedFrameCamDistAU,
  landedMinDistanceAU,
  landedNearAU,
} from './landedView';
import { MOONS } from './planets/moonData';
import { PLANETARIUM_BODIES } from './planets/planetData';
import { MOON_RENDER_ANCHOR_RATIO, renderedMoonRadiusAU } from './moonRenderSize';

const RAD2DEG = 180 / Math.PI;

// Angular diameter (deg) the rendered body subtends from the landing camera,
// which sits 1.5·camDist from the body (the (d, d/2, d) placement).
function framedDiameterDeg(renderedRadiusAU: number, nearAU: number): number {
  const dist = landedFrameCamDistAU(renderedRadiusAU, nearAU) * 1.5;
  return 2 * Math.atan(renderedRadiusAU / dist) * RAD2DEG;
}

// Every landable body with the rendered size the landing actually frames:
// planets at true size, moons through the production render curve — the
// same derivation the controller uses, so a sizing change re-runs this sweep.
const LANDABLE = [
  ...PLANETARIUM_BODIES.map((p) => ({ name: p.name, trueR: p.radiusAU, renderedR: p.radiusAU })),
  ...MOONS.map((m) => {
    const parent = PLANETARIUM_BODIES.find((b) => b.name === m.parentPlanet)!;
    return {
      name: m.name,
      trueR: m.radiusAU,
      renderedR: renderedMoonRadiusAU(m.radiusAU, parent.radiusAU, MOON_RENDER_ANCHOR_RATIO),
    };
  }),
];

describe('landed framing', () => {
  it('frames every landable body to ~⅓ of the 60° view (~18.9°), independent of size', () => {
    for (const body of LANDABLE) {
      expect(
        framedDiameterDeg(body.renderedR, landedNearAU(body.trueR)),
        `${body.name}: framed diameter`,
      ).toBeCloseTo(18.92, 1);
    }
  });

  it('the near-plane guard never decides a real body — the radius term does', () => {
    for (const body of LANDABLE) {
      expect(
        landedFrameCamDistAU(body.renderedR, landedNearAU(body.trueR)),
        `${body.name}: framing term`,
      ).toBe(body.renderedR * LANDED_FRAME_RADII);
    }
  });

  it('guards only a degenerate zero radius', () => {
    expect(landedFrameCamDistAU(0, LANDED_NEAR_AU)).toBe(LANDED_NEAR_AU * 1.5);
  });

  it('keeps the surface in front of the near plane at max zoom-in', () => {
    for (const body of LANDABLE) {
      const nearAU = landedNearAU(body.trueR);
      const surfaceClearance = landedMinDistanceAU(body.renderedR, nearAU) - body.renderedR;
      expect(surfaceClearance, `${body.name}: near clearance`).toBeGreaterThanOrEqual(nearAU);
    }
  });
});

describe('landedNearAU', () => {
  it('keeps the stock plane for every body at least as large as it', () => {
    for (const body of LANDABLE.filter((b) => b.trueR * 2.2 >= LANDED_NEAR_AU)) {
      expect(landedNearAU(body.trueR), `${body.name}: stock near`).toBe(LANDED_NEAR_AU);
    }
  });

  it('culls the whole ball on bodies smaller than the stock plane (surface-view ground cull)', () => {
    const small = LANDABLE.filter((b) => b.trueR * 2.2 < LANDED_NEAR_AU);
    expect(small.length).toBeGreaterThan(0); // the case exists in the catalog
    for (const body of small) {
      // Farthest ground point from a surface camera is one diameter away.
      expect(landedNearAU(body.trueR), `${body.name}: ball cull`).toBeGreaterThan(body.trueR * 2);
    }
  });

  it('floors at ~1.5 km only for a degenerate zero radius', () => {
    expect(landedNearAU(0)).toBe(0.00000001);
  });
});
