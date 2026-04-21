/**
 * Shared astronomy constants. Re-declared locally in modules would drift;
 * all callers import from here.
 */
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

/** Julian Day Number of the J2000.0 epoch (2000 Jan 1.5 TT). */
export const J2000 = 2451545.0;

/** Mean obliquity of the ecliptic at J2000.0 (degrees). */
export const OBLIQUITY_DEG = 23.4392911;
