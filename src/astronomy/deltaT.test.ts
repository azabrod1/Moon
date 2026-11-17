/**
 * ΔT golden values come from the IERS/USNO observed series; the Espenak–Meeus
 * fit should land within a couple of seconds of them in the telescopic era.
 */
import { describe, expect, it } from 'vitest';
import { decimalYearFromDate, deltaTDaysAtDate, deltaTSeconds, ttMinusUtcSeconds } from './deltaT';

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
    expect(deltaTDaysAtDate(date) * 86_400).toBeCloseTo(ttMinusUtcSeconds(date.getTime()), 9);
  });
});

describe('ttMinusUtcSeconds', () => {
  // TT − UTC = 32.184 s + (TAI − UTC). TAI − UTC from IERS Bulletin C, as
  // tabulated in ERFA's dat.c (github.com/liberfa/erfa).
  it('is exact from the leap-second table', () => {
    expect(ttMinusUtcSeconds(Date.UTC(1972, 0, 1))).toBeCloseTo(42.184, 9);
    expect(ttMinusUtcSeconds(Date.UTC(1972, 5, 30, 23, 59, 59))).toBeCloseTo(42.184, 9);
    expect(ttMinusUtcSeconds(Date.UTC(1972, 6, 1))).toBeCloseTo(43.184, 9);
    expect(ttMinusUtcSeconds(Date.UTC(1999, 0, 1))).toBeCloseTo(64.184, 9);
    expect(ttMinusUtcSeconds(Date.UTC(2016, 11, 31, 23, 59, 59, 999))).toBeCloseTo(68.184, 9);
    expect(ttMinusUtcSeconds(Date.UTC(2017, 0, 1))).toBeCloseTo(69.184, 9);
  });

  it('holds the last tabulated offset after 2017', () => {
    expect(ttMinusUtcSeconds(Date.UTC(2026, 10, 17))).toBeCloseTo(69.184, 9);
    expect(ttMinusUtcSeconds(Date.UTC(2034, 11, 31))).toBeCloseTo(69.184, 9);
  });

  it('stays within the 0.9 s UT1 − UTC bound of observed ΔT', () => {
    // Observed ΔT (TT − UT1) at 2000.0 is 63.83 s (USNO); UTC differs from
    // UT1 by at most 0.9 s, so TT − UTC must sit within that of it.
    expect(Math.abs(ttMinusUtcSeconds(Date.UTC(2000, 0, 1)) - 63.83)).toBeLessThan(0.9);
  });

  it('follows the long-term fit before the table and after the forecast join', () => {
    expect(ttMinusUtcSeconds(Date.UTC(1900, 0, 1))).toBeCloseTo(deltaTSeconds(1900.0), 1);
    expect(ttMinusUtcSeconds(Date.UTC(2200, 0, 1))).toBeCloseTo(deltaTSeconds(2200.0), 1);
  });

  it('has no step where its pieces meet, other than real leap seconds', () => {
    const oneMs = 1;
    for (const joinMs of [Date.UTC(1970, 0, 1), Date.UTC(1972, 0, 1), Date.UTC(2035, 0, 1), Date.UTC(2100, 0, 1)]) {
      const before = ttMinusUtcSeconds(joinMs - oneMs);
      const after = ttMinusUtcSeconds(joinMs);
      expect(Math.abs(after - before), `at ${new Date(joinMs).toISOString()}`).toBeLessThan(1e-3);
    }
  });

  it('joins the long-term fit at 2100 with a matching slope', () => {
    const yearMs = 365.25 * 86_400_000;
    const joinMs = Date.UTC(2100, 0, 1);
    const slopeBefore = ttMinusUtcSeconds(joinMs) - ttMinusUtcSeconds(joinMs - yearMs);
    const slopeAfter = ttMinusUtcSeconds(joinMs + yearMs) - ttMinusUtcSeconds(joinMs);
    expect(Math.abs(slopeAfter - slopeBefore)).toBeLessThan(0.05);
  });

  it('only grows through the forecast years', () => {
    let previous = ttMinusUtcSeconds(Date.UTC(2035, 0, 1));
    for (let year = 2036; year <= 2100; year++) {
      const current = ttMinusUtcSeconds(Date.UTC(year, 0, 1));
      expect(current, `at ${year}`).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });
});
