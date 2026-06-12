/**
 * Texture URLs for the Moon-flight sky scene (and the unwired
 * deprecatedSkybox). Planetarium textures are listed in
 * `src/planetarium/planets/planetData.ts` alongside each planet.
 */
const BASE = import.meta.env.BASE_URL + 'textures/';

export const TEXTURES = {
  EARTH_DAY: BASE + 'earth-day.jpg',
  EARTH_BUMP: BASE + 'earth-bump.png',
  MOON: BASE + 'moon.jpg',
  MILKY_WAY: BASE + 'starmap_milkyway.jpg',
};
