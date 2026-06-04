/**
 * Shared astronomy constants. Re-declared locally in modules would drift;
 * all callers import from here.
 *
 * DEG/RAD are the astronomy-domain aliases of the single source of truth in
 * `shared/math/angles.ts`; J2000 and OBLIQUITY_DEG are domain constants kept here.
 */
export { DEG2RAD as DEG, RAD2DEG as RAD } from '../shared/math/angles';

/** Julian Day Number of the J2000.0 epoch (2000 Jan 1.5 TT). */
export const J2000 = 2451545.0;

/** Mean obliquity of the ecliptic at J2000.0 (degrees). */
export const OBLIQUITY_DEG = 23.4392911;
