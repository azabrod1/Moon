import { describe, expect, it } from 'vitest';
import {
  computeSurfaceSkyDrive,
  ECLIPSE_SKY_FLOOR,
  eclipseSkyDim,
  surfaceSkyParams,
} from './surfaceSky';
import { ATMOSPHERES } from '../PlanetFactory';

// Sun-elevation sines used throughout: 30° up is full day, horizon is 0,
// -30° is deep night.
const DAY = Math.sin((30 * Math.PI) / 180);
const NIGHT = -DAY;

describe('eclipseSkyDim', () => {
  it('leaves a clear-sky day untouched and bottoms out on the floor', () => {
    expect(eclipseSkyDim(1)).toBeCloseTo(1, 12);
    expect(eclipseSkyDim(0)).toBeCloseTo(ECLIPSE_SKY_FLOOR, 10);
  });

  it('is monotone in the exposed fraction', () => {
    let prev = -Infinity;
    for (let vis = 0; vis <= 1.0001; vis += 0.01) {
      const dim = eclipseSkyDim(vis);
      expect(dim).toBeGreaterThanOrEqual(prev);
      prev = dim;
    }
  });

  it('barely dims a half-covered Sun but plunges through the last percents', () => {
    // Perceptual compression: half cover keeps most of the day...
    expect(eclipseSkyDim(0.5)).toBeGreaterThan(0.65);
    // ...while 1% exposed is already a dramatic gloom.
    expect(eclipseSkyDim(0.01)).toBeLessThan(0.15);
  });
});

describe('computeSurfaceSkyDrive', () => {
  it('reads full day with the Sun high and clear', () => {
    const drive = computeSurfaceSkyDrive(DAY, 1);
    expect(drive.daylight).toBe(1);
    expect(drive.skylight).toBeCloseTo(1, 12);
    expect(drive.duskRing).toBe(0);
    expect(drive.starVisibility).toBe(0); // daylight hides the field
  });

  it('reads black night with the Sun well below the horizon', () => {
    const drive = computeSurfaceSkyDrive(NIGHT, 1);
    expect(drive.daylight).toBe(0);
    expect(drive.skylight).toBe(0);
    expect(drive.twilight).toBe(0);
    expect(drive.duskRing).toBe(0);
    expect(drive.starVisibility).toBe(1); // the stars belong to the night
  });

  it('warms the horizon through sunset without fully dying at the horizon crossing', () => {
    const sunset = computeSurfaceSkyDrive(0, 1);
    expect(sunset.twilight).toBeGreaterThan(0.9);
    expect(sunset.skylight).toBeGreaterThan(0.3);
    expect(sunset.skylight).toBeLessThan(1);
    // The bell closes on both sides.
    expect(computeSurfaceSkyDrive(0.4, 1).twilight).toBe(0);
    expect(computeSurfaceSkyDrive(-0.3, 1).twilight).toBe(0);
  });

  it('collapses to the dusk floor with the ring armed at totality', () => {
    const totality = computeSurfaceSkyDrive(DAY, 0);
    expect(totality.skylight).toBeCloseTo(ECLIPSE_SKY_FLOOR, 10);
    expect(totality.duskRing).toBe(1);
    // Stars flood back — this is the eclipse's whole reveal.
    expect(totality.starVisibility).toBeGreaterThan(0.9);
  });

  it('holds the ring and the stars back through the partial phases', () => {
    const partial = computeSurfaceSkyDrive(DAY, 0.3);
    expect(partial.duskRing).toBe(0);
    expect(partial.starVisibility).toBe(0);
    expect(partial.skylight).toBeGreaterThan(0.5);
  });

  it('never rings at night, however covered the Sun is', () => {
    expect(computeSurfaceSkyDrive(NIGHT, 0).duskRing).toBe(0);
  });

  it('is monotone in the exposed fraction at fixed elevation', () => {
    let prevSky = -Infinity;
    let prevStars = Infinity;
    for (let vis = 0; vis <= 1.0001; vis += 0.005) {
      const drive = computeSurfaceSkyDrive(DAY, vis);
      expect(drive.skylight).toBeGreaterThanOrEqual(prevSky);
      expect(drive.starVisibility).toBeLessThanOrEqual(prevStars);
      prevSky = drive.skylight;
      prevStars = drive.starVisibility;
    }
  });

  it('keeps every lever in [0, 1] across the input plane', () => {
    for (let elev = -1; elev <= 1.0001; elev += 0.1) {
      for (let vis = 0; vis <= 1.0001; vis += 0.1) {
        const drive = computeSurfaceSkyDrive(elev, vis);
        for (const value of Object.values(drive)) {
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe('surfaceSkyParams', () => {
  it('exists exactly for the bodies with an atmosphere shell', () => {
    for (const name of Object.keys(ATMOSPHERES)) {
      expect(surfaceSkyParams(name), name).not.toBeNull();
    }
    expect(surfaceSkyParams('Moon')).toBeNull();
    expect(surfaceSkyParams('Mercury')).toBeNull();
    expect(surfaceSkyParams('Neptune')).toBeNull(); // deliberately shell-less
  });

  it('derives the palette from the shell config (blue Earth day, warm Earth dusk)', () => {
    const earth = surfaceSkyParams('Earth')!;
    expect(earth.day.b).toBeGreaterThan(earth.day.r); // Rayleigh blue
    expect(earth.sunset.r).toBeGreaterThan(earth.sunset.b); // warm dusk
    // The horizon whitens off the zenith hue instead of restating a colour.
    expect(earth.horizon.r).toBeGreaterThan(earth.day.r);
  });

  it('reads Mars thinner than Earth', () => {
    expect(surfaceSkyParams('Mars')!.strength).toBeLessThan(
      surfaceSkyParams('Earth')!.strength,
    );
  });
});
