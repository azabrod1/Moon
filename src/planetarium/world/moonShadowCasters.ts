/**
 * Which of a planet's moons may paint a shadow on it.
 *
 * The surface shader takes a few caster slots per frame. Candidates are the
 * largest moons whose umbra can actually reach the surface — a moon whose
 * umbra falls short (Phobos on Mars, Iapetus on Saturn) would paint a full
 * black spot where the sky shows an annulus, and a big far moon must not
 * take a slot from a real caster (Tethys, Galatea). The umbra test is
 * geometric: the moon's radius against the Sun's angular radius at the
 * parent times the moon's distance.
 *
 * The catalog carries a moon's MEAN distance only. Earth's Moon fails the
 * umbra test at its mean distance by about 3 % and passes it near perigee —
 * which is exactly when total solar eclipses happen — so the prefilter
 * tests the umbra at a perigee margin below the mean, and the per-frame
 * check against the live distance decides whether the spot is drawn. A
 * margin of 0.85 admits every moon with an eccentricity under 0.15 (the
 * Moon's is 0.055) and still rejects the annular cases by a wide factor.
 */

/** Fraction of the mean distance the umbra test is taken at. */
export const CASTER_PERIGEE_MARGIN = 0.85;

/** A moon smaller than this fraction of its parent's radius never casts a
 *  spot worth drawing. */
export const CASTER_MIN_RADIUS_RATIO = 0.003;

export interface CasterCandidate {
  name: string;
  radiusAU: number;
  orbitalRadiusAU: number;
}

/** The umbra reaches the surface at distance `distanceAU` when the moon's
 *  radius exceeds the Sun's angular radius (tan) times that distance. */
export function umbraReachesSurface(radiusAU: number, distanceAU: number, sunTanAtParent: number): boolean {
  return radiusAU > distanceAU * sunTanAtParent;
}

/**
 * The caster candidates for one parent: umbra-capable moons (at the perigee
 * margin), largest first, at most `slots` of them. Pure; the caller caches
 * the result while the Sun's angular size at the parent holds.
 */
export function selectMoonShadowCasters(
  moons: ReadonlyArray<CasterCandidate>,
  parentRadiusAU: number,
  sunTanAtParent: number,
  slots: number,
): string[] {
  return moons
    .filter((m) => m.radiusAU / parentRadiusAU > CASTER_MIN_RADIUS_RATIO
      && umbraReachesSurface(m.radiusAU, m.orbitalRadiusAU * CASTER_PERIGEE_MARGIN, sunTanAtParent))
    .sort((a, b) => b.radiusAU - a.radiusAU)
    .slice(0, slots)
    .map((m) => m.name);
}
