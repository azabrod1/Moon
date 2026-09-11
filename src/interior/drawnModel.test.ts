import { describe, expect, it } from 'vitest';
import { EARTH_MODEL } from './data/models/earth';
import { EUROPA_MODEL } from './data/models/europa';
import { JUPITER_DILUTE_MODEL } from './data/models/jupiter';
import { drawnFromModel, drawnUnresolved, outerFractionsInsideOut } from './drawnModel';

describe('drawnModel', () => {
  it('flattens a schema model inside-out with inner radii chained from the previous outer', () => {
    const drawn = drawnFromModel(EARTH_MODEL);
    expect(drawn.modelId).toBe('earth-prem');
    expect(drawn.regionsInsideOut.map((region) => region.key)).toEqual(['innerCore', 'outerCore', 'lowerMantle', 'upperMantle', 'crust']);
    expect(drawn.regionsInsideOut[0].innerRadiusKm).toBe(0);
    expect(drawn.regionsInsideOut[1].innerRadiusKm).toBe(1221.5);
    expect(drawn.regionsInsideOut[4].outerRadiusKm).toBe(drawn.referenceRadiusKm);
    expect(drawn.illustrative).toBe(false);
    expect(drawn.model).toBe(EARTH_MODEL);
  });

  it('takes the representative temperature, the composition text and the outer transition width', () => {
    const drawn = drawnFromModel(EARTH_MODEL);
    const innerCore = drawn.regionsInsideOut[0];
    expect(innerCore.temperatureK).toBe((5700 + 5400) / 2);
    expect(innerCore.composition).toContain('Iron and nickel');
    expect(innerCore.transitionKm).toBe(0);
    const upperMantle = drawn.regionsInsideOut[3];
    expect(upperMantle.transitionKm).toBe(20);
    const jupiter = drawnFromModel(JUPITER_DILUTE_MODEL);
    expect(jupiter.regionsInsideOut[0].transitionKm).toBe(15_000);
  });

  it('carries an unknown temperature as null, never a default', () => {
    const europa = drawnFromModel(EUROPA_MODEL);
    expect(europa.regionsInsideOut[0].key).toBe('core');
    expect(europa.regionsInsideOut[0].temperatureK).toBeNull();
  });

  it('builds the unresolved whole as one region the size of the body', () => {
    const drawn = drawnUnresolved('Mercury', 2439.7, 'Not yet modelled here');
    expect(drawn.modelId).toBeNull();
    expect(drawn.regionsInsideOut).toHaveLength(1);
    expect(drawn.regionsInsideOut[0].family).toBe('unresolved');
    expect(drawn.regionsInsideOut[0].outerRadiusKm).toBe(2439.7);
    expect(drawn.regionsInsideOut[0].region).toBeNull();
    expect(outerFractionsInsideOut(drawn)).toEqual([1]);
  });

  it('gives increasing outer fractions ending exactly at 1', () => {
    const fractions = outerFractionsInsideOut(drawnFromModel(EARTH_MODEL));
    expect(fractions).toHaveLength(5);
    for (let index = 1; index < fractions.length; index++) expect(fractions[index]).toBeGreaterThan(fractions[index - 1]);
    expect(fractions[fractions.length - 1]).toBe(1);
    expect(fractions[0]).toBeCloseTo(1221.5 / 6371, 6);
  });
});
