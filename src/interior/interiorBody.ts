/**
 * Which catalog body the Look-inside tool can open, resolved by catalog
 * name: the Sun, every planet the planetarium ships (Pluto included: it is
 * in PLANETARIUM_BODIES, not PLANETS), and every moon. The registry answers
 * for the same set (interiorRegistry.interiorBodyIds), and the test pins
 * that every id it lists resolves here, so the picker can never offer a
 * body that the mode then quietly swaps for the default.
 */
import { PLANETARIUM_BODIES, SUN_DATA, type PlanetData } from '../planetarium/planets/planetData';
import { MOONS, type MoonData } from '../planetarium/planets/moonData';

/** A catalog body the tool can open: the Sun, or a planet or a moon with a radius and a map. */
export interface InteriorBody {
  id: string;
  planet: PlanetData | null;
  moon: MoonData | null;
  /** The Sun: no map, the planetarium's photosphere shader as its skin. */
  sun: boolean;
  radiusKm: number;
}

const PLANET_BY_NAME = new Map<string, PlanetData>(PLANETARIUM_BODIES.map((planet) => [planet.name, planet]));
const MOON_BY_NAME = new Map<string, MoonData>(MOONS.map((moon) => [moon.name, moon]));

export function resolveInteriorBody(bodyId: string): InteriorBody | null {
  if (bodyId === 'Sun') return { id: 'Sun', planet: null, moon: null, sun: true, radiusKm: SUN_DATA.radiusKm };
  const planet = PLANET_BY_NAME.get(bodyId) ?? null;
  const moon = planet ? null : MOON_BY_NAME.get(bodyId) ?? null;
  if (!planet && !moon) return null;
  return { id: bodyId, planet, moon, sun: false, radiusKm: planet?.radiusKm ?? moon!.radiusKm };
}
