import { describe, it, expect, afterEach } from 'vitest';
import {
  DEFAULT_ALBEDO_PIVOT,
  SURFACE_LOOK,
  albedoContrast,
  parseSurfaceLookParams,
  resetSurfaceLookForTests,
  setSurfaceLookOverride,
  surfaceLookOf,
} from './surfaceLook';

afterEach(() => resetSurfaceLookForTests());

describe('the shipped look', () => {
  it('is the picture as it was: half-depth relief, the physics\' haze, the map\'s own contrast', () => {
    // These are the numbers Mars shipped with before the switches existed;
    // a change here IS a change of the default picture and wants a judgement
    // on a real screen behind it, not a test edit.
    expect(SURFACE_LOOK.Mars).toEqual({ relief: 0.5, haze: null, contrast: 1, contrastPivot: DEFAULT_ALBEDO_PIVOT });
    expect(surfaceLookOf('Mars')).toEqual(SURFACE_LOOK.Mars);
    // The pivot is a typical Mars albedo, not a grey card: the shipped 4K
    // map's mid-latitude median luminance.
    expect(DEFAULT_ALBEDO_PIVOT).toBeGreaterThan(0.1);
    expect(DEFAULT_ALBEDO_PIVOT).toBeLessThan(0.3);
  });

  it('is nothing for a body the table does not name', () => {
    expect(surfaceLookOf('Earth')).toBeUndefined();
    expect(setSurfaceLookOverride('Earth', { contrast: 2 })).toBeUndefined();
    expect(surfaceLookOf('Earth')).toBeUndefined();
  });
});

describe('the switches in a link', () => {
  it('read each knob by the body\'s lower-cased name', () => {
    expect(parseSurfaceLookParams('?marsrelief=1.5&marshaze=0.5&marscontrast=1.3'))
      .toEqual({ Mars: { relief: 1.5, haze: 0.5, contrast: 1.3 } });
    expect(parseSurfaceLookParams('?marscontrast=1.3')).toEqual({ Mars: { contrast: 1.3 } });
    expect(parseSurfaceLookParams('')).toEqual({});
    expect(parseSurfaceLookParams('?debug=1&sectors=0')).toEqual({});
  });

  it('ignore a mistyped value and clamp one past the limits', () => {
    // An empty value is a mistyped link, not a request for zero.
    expect(parseSurfaceLookParams('?marsrelief=&marshaze=abc&marscontrast=NaN')).toEqual({});
    expect(parseSurfaceLookParams('?marsrelief=9&marshaze=2&marscontrast=0'))
      .toEqual({ Mars: { relief: 4, haze: 1, contrast: 0.25 } });
    expect(parseSurfaceLookParams('?marsrelief=-1&marshaze=-0.5'))
      .toEqual({ Mars: { relief: 0, haze: 0 } });
  });

  it('name only bodies in the table', () => {
    expect(parseSurfaceLookParams('?earthcontrast=2&moonrelief=1')).toEqual({});
  });

  it('stand under the table at boot and leave the rest of it alone', () => {
    resetSurfaceLookForTests('?marsrelief=1&marshaze=0.5');
    expect(surfaceLookOf('Mars')).toEqual({ relief: 1, haze: 0.5, contrast: 1, contrastPivot: DEFAULT_ALBEDO_PIVOT });
  });
});

describe('the DEV pin', () => {
  it('moves one knob at a time, clamped like a link, and null puts the table back', () => {
    expect(setSurfaceLookOverride('Mars', { contrast: 1.5 })?.contrast).toBe(1.5);
    expect(surfaceLookOf('Mars')?.relief).toBe(0.5);
    expect(setSurfaceLookOverride('Mars', { relief: 7 })?.relief).toBe(4);
    expect(surfaceLookOf('Mars')?.contrast).toBe(1.5);
    expect(setSurfaceLookOverride('Mars', { contrast: null as unknown as number })?.contrast).toBe(1);
    expect(setSurfaceLookOverride('Mars', { haze: Number.NaN })?.haze).toBeNull();
  });
});

describe('the contrast grade, as the shader applies it', () => {
  const pivot = 0.18;
  it('is the identity at a gain of 1, exactly', () => {
    expect(albedoContrast([0.3, 0.16, 0.12], 1, pivot)).toEqual([0.3, 0.16, 0.12]);
  });

  it('turns about the pivot: ground at the pivot keeps its brightness at every gain', () => {
    // A grey at the pivot's luminance maps to itself.
    for (const gain of [0.5, 1.5, 2, 3]) {
      const out = albedoContrast([pivot, pivot, pivot], gain, pivot);
      out.forEach((v) => expect(v).toBeCloseTo(pivot, 12));
    }
  });

  it('deepens the dark and brightens the bright, by the gain in log luminance', () => {
    const luminance = (rgb: [number, number, number]) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    const dark: [number, number, number] = [0.15, 0.08, 0.06];
    const bright: [number, number, number] = [0.45, 0.26, 0.2];
    for (const gain of [1.5, 2]) {
      const darkOut = albedoContrast(dark, gain, pivot);
      const brightOut = albedoContrast(bright, gain, pivot);
      expect(luminance(darkOut)).toBeLessThan(luminance(dark));
      expect(luminance(brightOut)).toBeGreaterThan(luminance(bright));
      // Log-luminance contrast: the ratio between the two grows by the gain's power.
      const before = luminance(bright) / luminance(dark);
      const after = luminance(brightOut) / luminance(darkOut);
      expect(after).toBeCloseTo(before ** gain, 9);
    }
  });

  it('keeps the hue and the saturation: every channel scales by the one factor', () => {
    const rgb: [number, number, number] = [0.3, 0.16, 0.12];
    const out = albedoContrast(rgb, 1.5, pivot);
    expect(out[1] / out[0]).toBeCloseTo(rgb[1] / rgb[0], 12);
    expect(out[2] / out[0]).toBeCloseTo(rgb[2] / rgb[0], 12);
  });

  it('does not blow up on black', () => {
    const out = albedoContrast([0, 0, 0], 2, pivot);
    out.forEach((v) => expect(Number.isFinite(v)).toBe(true));
  });
});
