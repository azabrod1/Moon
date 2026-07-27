import { describe, it, expect } from 'vitest';
import {
  mapBodyRadiusAU,
  mapBodyRadiusPx,
  mapMarkerRadiusPx,
  MAP_BODY_SIZE_DEFAULTS,
  type MapBodySizeParams,
} from './mapBodySize';
import { KM_PER_AU } from '../../astronomy/constants';

const P = MAP_BODY_SIZE_DEFAULTS;
const auOf = (km: number) => km / KM_PER_AU;

// True equatorial radii (km), ascending — the ordering the policy must keep.
const RADIUS_KM = {
  Mercury: 2440,
  Mars: 3390,
  Venus: 6052,
  Earth: 6371,
  Neptune: 24622,
  Uranus: 25362,
  Saturn: 58232,
  Jupiter: 69911,
  Sun: 696340,
};

describe('mapMarkerRadiusPx', () => {
  it('floors every body at the legibility minimum', () => {
    // A grain far below the reference radius, and a degenerate one.
    expect(mapMarkerRadiusPx(auOf(1))).toBe(P.minPx);
    expect(mapMarkerRadiusPx(0)).toBe(P.minPx);
    expect(mapMarkerRadiusPx(-1)).toBe(P.minPx);
    for (const km of Object.values(RADIUS_KM)) {
      expect(mapMarkerRadiusPx(auOf(km))).toBeGreaterThanOrEqual(P.minPx);
    }
  });

  it('draws the reference radius exactly on the floor', () => {
    expect(mapMarkerRadiusPx(P.refRadiusAU)).toBeCloseTo(P.minPx, 12);
  });

  it('keeps the planets size-ordered at the overview', () => {
    const planets = Object.entries(RADIUS_KM).filter(([name]) => name !== 'Sun');
    let prev = 0;
    for (const [, km] of planets) {
      const px = mapMarkerRadiusPx(auOf(km));
      expect(px).toBeGreaterThan(prev);
      prev = px;
    }
  });

  it('holds every planet under the cap, so the orbits stay dominant', () => {
    for (const [name, km] of Object.entries(RADIUS_KM)) {
      if (name === 'Sun') continue;
      expect(mapMarkerRadiusPx(auOf(km))).toBeLessThan(P.maxPx);
    }
    // The Sun is the one body the cap binds for — 33 px of marker otherwise.
    expect(mapMarkerRadiusPx(auOf(RADIUS_KM.Sun))).toBe(P.maxPx);
  });

  it('compresses the true spread hard — markers, not marbles', () => {
    const trueRatio = RADIUS_KM.Jupiter / RADIUS_KM.Mercury; // ~28.7x
    const drawnRatio =
      mapMarkerRadiusPx(auOf(RADIUS_KM.Jupiter)) / mapMarkerRadiusPx(auOf(RADIUS_KM.Mercury));
    expect(trueRatio).toBeGreaterThan(28);
    expect(drawnRatio).toBeLessThan(3);
    expect(drawnRatio).toBeGreaterThan(1);
  });

  it('retunes from the params it is handed', () => {
    const flatter: MapBodySizeParams = { ...P, gamma: 0 };
    expect(mapMarkerRadiusPx(auOf(RADIUS_KM.Jupiter), flatter)).toBe(P.minPx);
    const bigger: MapBodySizeParams = { ...P, minPx: 12, maxPx: 40 };
    expect(mapMarkerRadiusPx(auOf(RADIUS_KM.Earth), bigger)).toBeGreaterThan(
      mapMarkerRadiusPx(auOf(RADIUS_KM.Earth)),
    );
  });
});

describe('mapBodyRadiusPx', () => {
  const earth = auOf(RADIUS_KM.Earth);

  it('keeps the marker while the true disc is smaller', () => {
    expect(mapBodyRadiusPx(earth, 0.001)).toBe(mapMarkerRadiusPx(earth));
  });

  it('hands over to true size once the disc overtakes the marker', () => {
    expect(mapBodyRadiusPx(earth, 300)).toBe(300);
  });

  it('meets truth exactly at the crossover — nothing pops', () => {
    const marker = mapMarkerRadiusPx(earth);
    expect(mapBodyRadiusPx(earth, marker)).toBe(marker);
    expect(mapBodyRadiusPx(earth, marker + 1e-9)).toBeCloseTo(marker, 6);
  });

  it('never draws a body smaller than its true projected size', () => {
    for (const km of Object.values(RADIUS_KM)) {
      const r = auOf(km);
      for (const truePx of [0.0001, 1, 5, 17.9, 18.1, 400]) {
        expect(mapBodyRadiusPx(r, truePx)).toBeGreaterThanOrEqual(truePx);
      }
    }
  });
});

describe('mapBodyRadiusAU', () => {
  const earth = auOf(RADIUS_KM.Earth);
  // 50 deg vertical FOV over an 800 px canvas — the map's own framing.
  const worldPerPxAtUnit = (2 * Math.tan((50 * Math.PI) / 180 / 2)) / 800;
  const drawnPx = (depthAU: number) =>
    mapBodyRadiusAU(earth, depthAU, worldPerPxAtUnit) / (worldPerPxAtUnit * depthAU);

  it('grows on screen as the camera closes, never shrinking', () => {
    let prev = 0;
    // 40 AU (whole-system overview) down to 1e-4 AU (a close pass).
    for (const depth of [40, 20, 10, 4, 1, 0.2, 0.02, 0.002, 4e-4, 1e-4]) {
      const px = drawnPx(depth);
      expect(px).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = px;
    }
  });

  it('is the marker at the overview and true size up close', () => {
    expect(drawnPx(40)).toBeCloseTo(mapMarkerRadiusPx(earth), 9);
    // Close enough that Earth's true disc dwarfs the marker: the drawn radius
    // is the real one, in AU.
    expect(mapBodyRadiusAU(earth, 1e-4, worldPerPxAtUnit)).toBeCloseTo(earth, 12);
  });

  it('survives a degenerate camera', () => {
    expect(mapBodyRadiusAU(earth, 0, worldPerPxAtUnit)).toBeGreaterThan(0);
    expect(mapBodyRadiusAU(earth, 10, 0)).toBe(earth);
  });
});
