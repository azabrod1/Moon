/**
 * ΔT = TT − UTC: the offset between the uniform Terrestrial Time that
 * ephemeris theories (Meeus series, IAU rotation models) are written in and
 * civil UTC. Piecewise polynomial fit by Espenak & Meeus ("Five Millennium
 * Canon of Solar Eclipses", NASA eclipse site), ~±1 s over the telescopic era;
 * the post-2005 extrapolation runs a few seconds high of observed values —
 * irrelevant at this app's accuracy. Strictly ΔT is TT − UT1; UTC is kept
 * within 0.9 s of UT1, well below this fit's own error.
 *
 * Pure and dependency-free so both ephemeris.ts and planetary.ts can use it
 * without import cycles.
 */

const SECONDS_PER_DAY = 86_400;

/** ΔT in seconds for a decimal year (e.g. 2026.45). */
export function deltaTSeconds(decimalYear: number): number {
  const y = decimalYear;

  if (y < -500 || y >= 2150) {
    const u = (y - 1820) / 100;
    return -20 + 32 * u * u;
  }
  if (y < 500) {
    const u = y / 100;
    return 10583.6 + u * (-1014.41 + u * (33.78311 + u * (-5.952053 +
      u * (-0.1798452 + u * (0.022174192 + u * 0.0090316521)))));
  }
  if (y < 1600) {
    const u = (y - 1000) / 100;
    return 1574.2 + u * (-556.01 + u * (71.23472 + u * (0.319781 +
      u * (-0.8503463 + u * (-0.005050998 + u * 0.0083572073)))));
  }
  if (y < 1700) {
    const t = y - 1600;
    return 120 + t * (-0.9808 + t * (-0.01532 + t / 7129));
  }
  if (y < 1800) {
    const t = y - 1700;
    return 8.83 + t * (0.1603 + t * (-0.0059285 + t * (0.00013336 - t / 1_174_000)));
  }
  if (y < 1860) {
    const t = y - 1800;
    return 13.72 + t * (-0.332447 + t * (0.0068612 + t * (0.0041116 +
      t * (-0.00037436 + t * (0.0000121272 + t * (-0.0000001699 + t * 0.000000000875))))));
  }
  if (y < 1900) {
    const t = y - 1860;
    return 7.62 + t * (0.5737 + t * (-0.251754 + t * (0.01680668 +
      t * (-0.0004473624 + t / 233_174))));
  }
  if (y < 1920) {
    const t = y - 1900;
    return -2.79 + t * (1.494119 + t * (-0.0598939 + t * (0.0061966 - t * 0.000197)));
  }
  if (y < 1941) {
    const t = y - 1920;
    return 21.20 + t * (0.84493 + t * (-0.076100 + t * 0.0020936));
  }
  if (y < 1961) {
    const t = y - 1950;
    return 29.07 + t * (0.407 + t * (-1 / 233 + t / 2547));
  }
  if (y < 1986) {
    const t = y - 1975;
    return 45.45 + t * (1.067 + t * (-1 / 260 - t / 718));
  }
  if (y < 2005) {
    const t = y - 2000;
    return 63.86 + t * (0.3345 + t * (-0.060374 + t * (0.0017275 +
      t * (0.000651814 + t * 0.00002373599))));
  }
  if (y < 2050) {
    const t = y - 2000;
    return 62.92 + t * (0.32217 + t * 0.005589);
  }
  // 2050 ≤ y < 2150
  const u = (y - 1820) / 100;
  return -20 + 32 * u * u - 0.5628 * (2150 - y);
}

/** Espenak's decimal-year convention: the middle of the date's month. */
export function decimalYearFromDate(date: Date): number {
  return date.getUTCFullYear() + (date.getUTCMonth() + 0.5) / 12;
}

/** ΔT in days for a date — add to a UTC Julian Day to get a TT Julian Day. */
export function deltaTDaysAtDate(date: Date): number {
  return deltaTSeconds(decimalYearFromDate(date)) / SECONDS_PER_DAY;
}
