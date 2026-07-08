/**
 * The Planetarium's time-rate ladder: nine preset magnitudes from realtime up
 * to a year per second. Its own module so the mode controller and the time
 * rail widget derive stepping, detent count, labels, and positions from the
 * same array — the rail must never hardcode nine.
 */
export const TIME_RATE_PRESETS: readonly number[] = [
  1, // realtime
  60, // 1 min/s
  1200, // 20 min/s
  3600, // 1 hr/s
  21600, // 6 hr/s
  86400, // 1 day/s
  604800, // 1 wk/s
  2592000, // 1 mo/s (30 days)
  31557600, // 1 yr/s (Julian year)
];
