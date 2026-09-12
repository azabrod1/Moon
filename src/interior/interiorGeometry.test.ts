import { describe, expect, it } from 'vitest';
import {
  IDENTITY_REMAP,
  framingDistance,
  minDisplayFraction,
  projectedRadiusPx,
  readableRemap,
  toDisplayFraction,
  toPhysicalFraction,
  tooThinToSeeCount,
} from './interiorGeometry';

// Earth's five regions, inside-out, as fractions of 6371 km.
const EARTH = [1221 / 6371, 3480 / 6371, 5711 / 6371, 6336 / 6371, 1];

function displayThicknesses(outerFractions: number[], minFraction: number, blend = 1): number[] {
  const remap = readableRemap(outerFractions, minFraction, blend);
  const result: number[] = [];
  for (let index = 1; index < remap.knots.length; index++) {
    result.push(remap.knots[index].display - remap.knots[index - 1].display);
  }
  return result;
}

describe('readableRemap', () => {
  it('is the identity at blend 0 and for regions already thick enough', () => {
    const identity = readableRemap(EARTH, 0.02, 0);
    for (const knot of identity.knots) expect(knot.display).toBeCloseTo(knot.physical, 12);
    const untouched = readableRemap([0.5, 1], 0.1, 1);
    for (const knot of untouched.knots) expect(knot.display).toBeCloseTo(knot.physical, 12);
  });

  it('gives every thin region the minimum and takes it from the thick ones in proportion to their slack', () => {
    const minFraction = 0.02; // 6 px on a 300 px disc
    const thickness = displayThicknesses(EARTH, minFraction);
    // The crust (35 km of 6371 = 0.55%) is lifted to 2%.
    expect(thickness[4]).toBeCloseTo(minFraction, 12);
    for (const value of thickness) expect(value).toBeGreaterThanOrEqual(minFraction - 1e-12);
    expect(thickness.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
    // The thick regions lose in proportion to slack: their ratios of (thickness − min) are unchanged.
    const physical = [1221, 3480 - 1221, 5711 - 3480, 6336 - 5711].map((km) => km / 6371);
    const slackBefore = physical.map((value) => value - minFraction);
    const slackAfter = thickness.slice(0, 4).map((value) => value - minFraction);
    for (let index = 1; index < 4; index++) {
      expect(slackAfter[index] / slackAfter[0]).toBeCloseTo(slackBefore[index] / slackBefore[0], 9);
    }
  });

  it('stays monotone and inverts exactly', () => {
    const remap = readableRemap(EARTH, 0.02, 0.6);
    let previousDisplay = -1;
    for (const knot of remap.knots) {
      expect(knot.display).toBeGreaterThan(previousDisplay);
      previousDisplay = knot.display;
    }
    for (let physical = 0; physical <= 1; physical += 0.01) {
      const display = toDisplayFraction(remap, physical);
      expect(toPhysicalFraction(remap, display)).toBeCloseTo(physical, 9);
    }
    expect(toDisplayFraction(remap, 0)).toBe(0);
    expect(toDisplayFraction(remap, 1)).toBe(1);
    expect(toPhysicalFraction(remap, 1)).toBe(1);
  });

  it('applies the fallback when the minimums cannot fit: the minimum scales down together', () => {
    // Ten regions asking for 15% each cannot fit; each gets 10%.
    const outer = Array.from({ length: 10 }, (_, index) => (index + 1) / 10);
    const thin = outer.map((value, index) => (index === 9 ? 1 : value * 0.05));
    const thickness = displayThicknesses(thin, 0.15);
    for (const value of thickness) expect(value).toBeCloseTo(0.1, 9);
  });

  it('blends knot by knot between identity and policy', () => {
    const full = readableRemap(EARTH, 0.02, 1);
    const half = readableRemap(EARTH, 0.02, 0.5);
    for (let index = 0; index < full.knots.length; index++) {
      const expected = (full.knots[index].physical + full.knots[index].display) / 2;
      expect(half.knots[index].display).toBeCloseTo(expected, 12);
    }
  });

  it('handles the degenerate inputs', () => {
    expect(readableRemap([], 0.1)).toBe(IDENTITY_REMAP);
    expect(readableRemap([0, 0], 0.1)).toBe(IDENTITY_REMAP);
    expect(toDisplayFraction(IDENTITY_REMAP, 0.3)).toBeCloseTo(0.3, 12);
  });

  it('widens Phobos’s 100 m regolith to the minimum on any disc', () => {
    const phobos = [11.2 / 11.3, 1];
    const thickness = displayThicknesses(phobos, minDisplayFraction(6, 300));
    expect(thickness[1]).toBeCloseTo(6 / 300, 12);
  });
});

describe('minDisplayFraction', () => {
  it('is minPx over the projected radius, and zero before there is a disc', () => {
    expect(minDisplayFraction(6, 300)).toBeCloseTo(0.02, 12);
    expect(minDisplayFraction(6, 0)).toBe(0);
    expect(minDisplayFraction(0, 300)).toBe(0);
  });
});

describe('projectedRadiusPx', () => {
  it('projects a unit sphere by its angular radius', () => {
    // At distance 1/sin(13°) the sphere subtends 13°, which on a 40° camera
    // over 900 px is tan(13°)/tan(20°) × 450.
    const distance = 1 / Math.sin((13 * Math.PI) / 180);
    const expected = (Math.tan((13 * Math.PI) / 180) / Math.tan((20 * Math.PI) / 180)) * 450;
    expect(projectedRadiusPx(1, distance, 40, 900)).toBeCloseTo(expected, 9);
  });

  it('fills the viewport from inside the sphere', () => {
    expect(projectedRadiusPx(1, 0.5, 40, 900)).toBe(900);
  });
});

describe('framingDistance', () => {
  it('frames by height on a wide screen and by width on a phone', () => {
    const wide = framingDistance(16 / 9, 40);
    expect(wide).toBeCloseTo(1 / Math.sin(0.66 * (20 * Math.PI) / 180), 9);
    const phone = framingDistance(390 / 844, 40);
    const horizontalHalf = Math.atan(Math.tan((20 * Math.PI) / 180) * (390 / 844));
    expect(phone).toBeCloseTo(1 / Math.sin(0.92 * horizontalHalf), 9);
    expect(phone).toBeGreaterThan(wide);
  });
});

describe('tooThinToSeeCount', () => {
  it('counts the regions under the minimum at true thickness', () => {
    // Earth's thinnest regions are the crust (35 km of 6,371) and the
    // transition zone: on a 200 px disc they are 1.1 px and 19.6 px, so one
    // of the five is under six pixels; on a 60 px disc the lower mantle's
    // neighbours go too.
    expect(tooThinToSeeCount(EARTH, 6, 200)).toBe(1);
    expect(tooThinToSeeCount(EARTH, 6, 60)).toBe(2);
    expect(tooThinToSeeCount(EARTH, 6, 2000)).toBe(0);
  });

  it('counts nothing before the disc has a size, and nothing for one whole region', () => {
    expect(tooThinToSeeCount(EARTH, 6, 0)).toBe(0);
    expect(tooThinToSeeCount(EARTH, 0, 200)).toBe(0);
    expect(tooThinToSeeCount([1], 6, 200)).toBe(0);
  });
});
