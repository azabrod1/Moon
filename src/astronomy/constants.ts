/**
 * Shared astronomy constants. Re-declared locally in modules would drift;
 * all callers import from here.
 *
 * DEG/RAD are the astronomy-domain aliases of the single source of truth in
 * `shared/math/angles.ts`; J2000 and OBLIQUITY_DEG are domain constants kept here.
 */
export { DEG2RAD as DEG, RAD2DEG as RAD } from '../shared/math/angles';
import { KM_CONSTANTS } from '../shared/constants/physicalData';

/** Julian Day Number of the J2000.0 epoch (2000 Jan 1.5 TT). */
export const J2000 = 2451545.0;

/** Mean obliquity of the ecliptic at J2000.0 (degrees). */
export const OBLIQUITY_DEG = 23.4392911;

/** Kilometres per astronomical unit (IAU 2012 definition). */
export const KM_PER_AU = 149_597_870.7;

/**
 * The Sun's photospheric radius, kilometres (KM_CONSTANTS, the measured
 * 696,342 ± 65 km of Emilio et al. 2012): the one radius the drawn Sun, the
 * eclipse geometry and the world pass's shadow terms all use.
 */
export const SUN_RADIUS_KM = KM_CONSTANTS.SUN_RADIUS;

/**
 * Solar radius in AU. The solar angular-radius terms in the world pass divide
 * this by a distance — the umbra test that picks a planet's shadow-casting
 * moons and the surface shader's penumbra width.
 */
export const SUN_RADIUS_AU = SUN_RADIUS_KM / KM_PER_AU;

/** The range a JS Date can hold, in ms from the epoch: the sim clock is
 *  clamped to it on restore and saturates at it when advancing, since past it
 *  every ephemeris call is NaN and the sky empties. */
export const MAX_UTC_MS = 8.64e15;
