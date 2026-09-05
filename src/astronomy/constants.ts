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

/** Kilometres per astronomical unit (IAU 2012 definition). */
export const KM_PER_AU = 149_597_870.7;

/** Nominal solar radius (IAU 2015 Resolution B3), kilometres. */
export const SUN_RADIUS_KM = 695_700;

/**
 * Solar radius in AU. The solar angular-radius terms in the world pass divide
 * this by a distance — the umbra test that picks a planet's shadow-casting
 * moons and the surface shader's penumbra width — so it has one definition
 * here. (The drawn Sun and the eclipse geometry use the catalog's
 * photospheric radius, a slightly different measurement of the same star.)
 */
export const SUN_RADIUS_AU = SUN_RADIUS_KM / KM_PER_AU;
