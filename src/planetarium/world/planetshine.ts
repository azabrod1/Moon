/**
 * Planetshine (earthshine): a moon's night side is faintly lit by sunlight its
 * parent reflects back. Brightest when the parent is "full" as seen from the
 * moon — i.e. the Sun is behind the moon relative to the parent (Earth's Moon at
 * lunar new moon shows the strongest earthshine).
 *
 * Pure + unit-tested; the renderer applies a visibility gain on top (true
 * planetshine is ~1e-4 of sunlight — physically faint, so it's lifted for the
 * night side to read without rivalling daylight).
 */

/**
 * Relative planetshine strength at a moon.
 * @param parentAlbedo   parent bond albedo (Earth ~0.3, gas giants ~0.5)
 * @param parentRadiusAU parent radius (AU)
 * @param moonDistAU     moon–parent distance (AU)
 * @param cosPhase       dot(dirMoonToSun, dirMoonToParent): -1 when the parent
 *                       is full from the moon (Sun opposite the parent), +1 new
 * @returns albedo · (apparent parent area) · (parent illuminated fraction), ≥ 0
 */
export function planetshineIntensity(
  parentAlbedo: number,
  parentRadiusAU: number,
  moonDistAU: number,
  cosPhase: number,
): number {
  const apparentArea = (parentRadiusAU / Math.max(moonDistAU, 1e-9)) ** 2;
  const litFraction = (1 - cosPhase) / 2; // 1 when parent full (cosPhase = -1)
  return parentAlbedo * apparentArea * Math.max(0, Math.min(1, litFraction));
}
