import { describe, expect, it } from 'vitest';
import { KM_PER_AU } from '../../astronomy/constants';
import { getMoonsByPlanet } from '../planets/moonData';
import { PLANETARIUM_BODIES } from '../planets/planetData';
import { CASTER_PERIGEE_MARGIN, selectMoonShadowCasters, umbraReachesSurface } from './moonShadowCasters';

const SUN_RADIUS_AU = 695_700 / KM_PER_AU;
const parent = (name: string) => PLANETARIUM_BODIES.find((b) => b.name === name)!;
const sunTanAt = (distanceAU: number) => SUN_RADIUS_AU / distanceAU;
const moon = (planet: string, name: string) => getMoonsByPlanet(planet).find((m) => m.name === name)!;

describe('moon shadow casters', () => {
  it("admits Earth's Moon, whose umbra reaches the ground only inside its mean distance", () => {
    const m = moon('Earth', 'Moon');
    const tan = sunTanAt(1);
    // At the catalog mean the umbra falls just short; near perigee it reaches.
    expect(umbraReachesSurface(m.radiusAU, m.orbitalRadiusAU, tan)).toBe(false);
    expect(umbraReachesSurface(m.radiusAU, m.orbitalRadiusAU * CASTER_PERIGEE_MARGIN, tan)).toBe(true);
    const perigeeAU = 363_300 / KM_PER_AU;
    expect(umbraReachesSurface(m.radiusAU, perigeeAU, tan)).toBe(true);
    expect(selectMoonShadowCasters(getMoonsByPlanet('Earth'), parent('Earth').radiusAU, tan, 4)).toEqual(['Moon']);
  });

  it('keeps the annular cases out even at the perigee margin', () => {
    const mars = parent('Mars');
    const tan = sunTanAt(mars.semiMajorAxisAU ?? 1.524);
    expect(selectMoonShadowCasters(getMoonsByPlanet('Mars'), mars.radiusAU, tan, 4)).toEqual([]);
    const saturn = parent('Saturn');
    const saturnCasters = selectMoonShadowCasters(getMoonsByPlanet('Saturn'), saturn.radiusAU, sunTanAt(saturn.semiMajorAxisAU ?? 9.54), 4);
    expect(saturnCasters).not.toContain('Iapetus');
    expect(saturnCasters).toContain('Titan');
  });

  it('takes the largest umbra-capable moons first, at most one per slot', () => {
    const jupiter = parent('Jupiter');
    const casters = selectMoonShadowCasters(getMoonsByPlanet('Jupiter'), jupiter.radiusAU, sunTanAt(jupiter.semiMajorAxisAU ?? 5.2), 2);
    expect(casters).toEqual(['Ganymede', 'Callisto']);
    const all = selectMoonShadowCasters(getMoonsByPlanet('Jupiter'), jupiter.radiusAU, sunTanAt(5.2), 4);
    expect(all).toContain('Io');
    expect(all.length).toBeLessThanOrEqual(4);
  });
});
