/**
 * The offset between the app's clock and Terrestrial Time (TT), the uniform
 * time that the ephemeris theories and rotation models are written in. The
 * clock is civil UTC; `ttMinusUtcSeconds` is the one place that turns it into
 * TT, in four pieces:
 *
 *  - From 1972, when UTC took SI seconds and whole leap seconds, the offset is
 *    exact: TT − UTC = 32.184 s + (TAI − UTC), from the leap-second table. It
 *    steps by one second at each leap second, as the real offset does.
 *  - Before 1972 the clock stands for UT, and the offset is ΔT = TT − UT from
 *    the Espenak–Meeus fit (`deltaTSeconds`), eased over 1970–71 into the
 *    table's first value so there is no step.
 *  - After the last leap second (2017-01-01) the offset is held at 69.184 s
 *    until 2035, the year by which leap seconds are to stop (CGPM 2022,
 *    Resolution 4). Since then UT1 has stayed within a second of UTC, so the
 *    hold is good to that second.
 *  - From 2035 it eases into the Espenak–Meeus long-term prediction, which it
 *    joins at 2100 with a matching slope. The future offset is a forecast,
 *    uncertain by tens of seconds within decades.
 *
 * Strictly ΔT is TT − UT1, and the Earth's rotation angle is a function of
 * UT1. The app treats its clock as UT1 too, which is good to the 0.9 s that
 * leap seconds keep UTC within (0.4 km of rotation at the equator).
 *
 * The Espenak–Meeus fit used to cover the whole range. Its 2005–2050 branch
 * runs high of the observed values (75.4 s in 2026 against 69.2 s), which put
 * every body about 6 s of motion late against the clock.
 *
 * Pure and dependency-free so both ephemeris.ts and planetary.ts can use it
 * without import cycles.
 */

const SECONDS_PER_DAY = 86_400;
const MS_PER_DAY = 86_400_000;

/** TT − TAI, by definition. */
const TT_MINUS_TAI_SECONDS = 32.184;

/**
 * TAI − UTC in seconds from each date (UTC, 00:00) onward, from 1972. Source:
 * the leap-second table in ERFA's `dat.c` (github.com/liberfa/erfa), which
 * follows IERS Bulletin C. The last entry is 2017-01-01; IERS has announced
 * none since.
 */
const LEAP_SECONDS: ReadonlyArray<readonly [utcMs: number, taiMinusUtcSeconds: number]> = [
  [Date.UTC(1972, 0, 1), 10],
  [Date.UTC(1972, 6, 1), 11],
  [Date.UTC(1973, 0, 1), 12],
  [Date.UTC(1974, 0, 1), 13],
  [Date.UTC(1975, 0, 1), 14],
  [Date.UTC(1976, 0, 1), 15],
  [Date.UTC(1977, 0, 1), 16],
  [Date.UTC(1978, 0, 1), 17],
  [Date.UTC(1979, 0, 1), 18],
  [Date.UTC(1980, 0, 1), 19],
  [Date.UTC(1981, 6, 1), 20],
  [Date.UTC(1982, 6, 1), 21],
  [Date.UTC(1983, 6, 1), 22],
  [Date.UTC(1985, 6, 1), 23],
  [Date.UTC(1988, 0, 1), 24],
  [Date.UTC(1990, 0, 1), 25],
  [Date.UTC(1991, 0, 1), 26],
  [Date.UTC(1992, 6, 1), 27],
  [Date.UTC(1993, 6, 1), 28],
  [Date.UTC(1994, 6, 1), 29],
  [Date.UTC(1996, 0, 1), 30],
  [Date.UTC(1997, 6, 1), 31],
  [Date.UTC(1999, 0, 1), 32],
  [Date.UTC(2006, 0, 1), 33],
  [Date.UTC(2009, 0, 1), 34],
  [Date.UTC(2012, 6, 1), 35],
  [Date.UTC(2015, 6, 1), 36],
  [Date.UTC(2017, 0, 1), 37],
];

const LEAP_TABLE_START_MS = LEAP_SECONDS[0][0];
/** Where the pre-1972 fit starts easing into the table's first value. */
const LEAP_TABLE_EASE_START_MS = Date.UTC(1970, 0, 1);
/** End of the hold at the last tabulated offset. */
const HOLD_END_MS = Date.UTC(2035, 0, 1);
/** Where the forecast ease joins the long-term Espenak–Meeus fit. */
const FORECAST_JOIN_MS = Date.UTC(2100, 0, 1);

const MS_PER_JULIAN_YEAR = 365.25 * MS_PER_DAY;

/** Decimal year of a UTC instant, continuous (no mid-month steps). Good to
 *  about a day, which moves ΔT by milliseconds. */
function decimalYearAtUtcMs(utcMs: number): number {
  return 1970 + utcMs / MS_PER_JULIAN_YEAR;
}

/** TT − UTC in seconds at a UTC instant; see the module note for the four
 *  pieces. Called for every body position, so it allocates nothing. */
export function ttMinusUtcSeconds(utcMs: number): number {
  if (utcMs >= LEAP_TABLE_START_MS) {
    if (utcMs < HOLD_END_MS) {
      for (let entryIndex = LEAP_SECONDS.length - 1; entryIndex >= 0; entryIndex--) {
        if (utcMs >= LEAP_SECONDS[entryIndex][0]) {
          return TT_MINUS_TAI_SECONDS + LEAP_SECONDS[entryIndex][1];
        }
      }
    }
    if (utcMs >= FORECAST_JOIN_MS) return deltaTSeconds(decimalYearAtUtcMs(utcMs));
    return forecastEaseSeconds(utcMs);
  }
  const fitted = deltaTSeconds(decimalYearAtUtcMs(utcMs));
  if (utcMs < LEAP_TABLE_EASE_START_MS) return fitted;
  const tableStart = TT_MINUS_TAI_SECONDS + LEAP_SECONDS[0][1];
  const easeFraction =
    (utcMs - LEAP_TABLE_EASE_START_MS) / (LEAP_TABLE_START_MS - LEAP_TABLE_EASE_START_MS);
  return fitted + (tableStart - fitted) * easeFraction;
}

/** Cubic Hermite from the held offset (slope 0) at HOLD_END_MS to the
 *  long-term fit's value and slope at FORECAST_JOIN_MS. */
function forecastEaseSeconds(utcMs: number): number {
  const heldSeconds = TT_MINUS_TAI_SECONDS + LEAP_SECONDS[LEAP_SECONDS.length - 1][1];
  const joinYear = decimalYearAtUtcMs(FORECAST_JOIN_MS);
  const spanYears = joinYear - decimalYearAtUtcMs(HOLD_END_MS);
  const joinSeconds = deltaTSeconds(joinYear);
  const joinSlopePerYear = (deltaTSeconds(joinYear + 0.5) - deltaTSeconds(joinYear - 0.5));
  const progress = (utcMs - HOLD_END_MS) / (FORECAST_JOIN_MS - HOLD_END_MS);
  const progressSquared = progress * progress;
  const progressCubed = progressSquared * progress;
  const startWeight = 2 * progressCubed - 3 * progressSquared + 1;
  const endWeight = -2 * progressCubed + 3 * progressSquared;
  const endSlopeWeight = progressCubed - progressSquared;
  return heldSeconds * startWeight + joinSeconds * endWeight + joinSlopePerYear * spanYears * endSlopeWeight;
}

/**
 * ΔT = TT − UT in seconds for a decimal year (e.g. 2026.45): the piecewise
 * polynomial fit by Espenak & Meeus ("Five Millennium Canon of Solar
 * Eclipses", NASA eclipse site), about ±1 s over the telescopic era. The clock
 * uses it before 1972 and after 2100 only; see the module note.
 */
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

/** TT − UTC in days for a date: add to a UTC Julian Day to get a TT Julian
 *  Day. The clock's one conversion, through `ttMinusUtcSeconds`. */
export function deltaTDaysAtDate(date: Date): number {
  return ttMinusUtcSeconds(date.getTime()) / SECONDS_PER_DAY;
}
