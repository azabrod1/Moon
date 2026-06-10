/**
 * ΔT golden values come from the IERS/USNO observed series; the Espenak–Meeus
 * fit should land within a couple of seconds of them in the telescopic era.
 */
import { describe, expect, it } from 'vitest';
import { decimalYearFromDate, deltaTDaysAtDate, deltaTSeconds } from './deltaT';

describe('deltaTSeconds', () => {
  it('matches observed ΔT at modern epochs', () => {
    expect(deltaTSeconds(2000.0)).toBeCloseTo(63.86, 1); // observed 63.83 s
    expect(deltaTSeconds(1955.0)).toBeCloseTo(31.1, 0); // observed ~31.1 s
    expect(deltaTSeconds(1900.0)).toBeCloseTo(-2.79, 1); // observed ~−2.7 s
  });

  it('extrapolates a plausible present-day value', () => {
    const now = deltaTSeconds(2026.5);
    expect(now).toBeGreaterThan(65);
    expect(now).toBeLessThan(80);
  });

  it('is continuous across polynomial branch boundaries', () => {
    for (const boundary of [-500, 500, 1600, 1700, 1800, 1860, 1900, 1920, 1941, 1961, 1986, 2005, 2050, 2150]) {
      const below = deltaTSeconds(boundary - 0.01);
      const above = deltaTSeconds(boundary + 0.01);
      expect(Math.abs(below - above), `at year ${boundary}`).toBeLessThan(2);
    }
  });
});

describe('date helpers', () => {
  it('uses Espenak mid-month decimal years', () => {
    expect(decimalYearFromDate(new Date(Date.UTC(2026, 0, 15)))).toBeCloseTo(2026 + 0.5 / 12, 6);
    expect(decimalYearFromDate(new Date(Date.UTC(2026, 11, 15)))).toBeCloseTo(2026 + 11.5 / 12, 6);
  });

  it('converts to days for JD offsets', () => {
    const date = new Date(Date.UTC(2000, 5, 15));
    expect(deltaTDaysAtDate(date) * 86_400).toBeCloseTo(deltaTSeconds(decimalYearFromDate(date)), 6);
  });
});
