import { describe, expect, it } from 'vitest';
import { EARTH_MODEL } from './data/models/earth';
import { EUROPA_MODEL } from './data/models/europa';
import { endpoints, UNKNOWN } from './data/modelHelpers';
import {
  TEMPERATURE_SCALE_STOPS,
  bodyTemperatureRange,
  temperatureEndpoints,
  temperatureScaleColor,
  temperatureScaleGradientCss,
  temperatureScaleHex,
  temperatureT,
} from './temperatureScale';

describe('temperatureScale', () => {
  it('runs from the first stop to the last, monotone in brightness', () => {
    expect(temperatureScaleColor(0)).toEqual([...TEMPERATURE_SCALE_STOPS[0]]);
    expect(temperatureScaleColor(1)).toEqual([...TEMPERATURE_SCALE_STOPS[TEMPERATURE_SCALE_STOPS.length - 1]]);
    let previous = -1;
    for (let step = 0; step <= 20; step++) {
      const [red, green, blue] = temperatureScaleColor(step / 20);
      const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      expect(luminance).toBeGreaterThan(previous);
      previous = luminance;
    }
    expect(temperatureScaleColor(-1)).toEqual(temperatureScaleColor(0));
    expect(temperatureScaleColor(2)).toEqual(temperatureScaleColor(1));
  });

  it('keeps the top of the ramp below the bloom threshold in luminance', () => {
    const [red, green, blue] = temperatureScaleColor(1);
    expect(0.2126 * red + 0.7152 * green + 0.0722 * blue).toBeLessThan(0.97);
  });

  it('gives a hex and a CSS gradient from the same stops', () => {
    expect(temperatureScaleHex(0)).toBe((18 << 16) | (8 << 8) | 38);
    expect(temperatureScaleGradientCss()).toContain('rgb(18,8,38) 0%');
    expect(temperatureScaleGradientCss()).toContain('100%');
  });

  it('places a temperature on a range and clamps', () => {
    const range = { minK: 200, maxK: 1200 };
    expect(temperatureT(range, 200)).toBe(0);
    expect(temperatureT(range, 700)).toBe(0.5);
    expect(temperatureT(range, 5000)).toBe(1);
    expect(temperatureT({ minK: 300, maxK: 300 }, 300)).toBe(0.5);
  });

  it('reads endpoints from a quantity and nothing from unknown', () => {
    expect(temperatureEndpoints(endpoints(5700, 5400, 's', 'inferred'))).toEqual({ outerK: 5400, innerK: 5700, log: false });
    expect(temperatureEndpoints(endpoints(10, 1, 's', 'modelled', 'log'))?.log).toBe(true);
    expect(temperatureEndpoints(UNKNOWN)).toBeNull();
  });

  it("spans a body's known temperatures and ignores its unknowns", () => {
    expect(bodyTemperatureRange(EARTH_MODEL.regions.map((region) => region.temperatureK))).toEqual({ minK: 288, maxK: 5700 });
    // Europa's core temperature is unknown: the range comes from the other regions.
    expect(bodyTemperatureRange(EUROPA_MODEL.regions.map((region) => region.temperatureK))).toEqual({ minK: 100, maxK: 1500 });
    expect(bodyTemperatureRange([UNKNOWN])).toBeNull();
    expect(bodyTemperatureRange([])).toBeNull();
  });
});
