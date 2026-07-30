import { describe, it, expect } from 'vitest';
import {
  mapBody,
  mapBodyAcceptsCamera,
  mapBodyRefFor,
  MAP_BODIES,
  MAP_LABEL_CAPACITY,
  MAP_PICK_ANCHOR_CAPACITY,
} from './mapBodies';
import { PLANETARIUM_BODIES, SUN_DATA } from '../planets/planetData';
import { MOONS } from '../planets/moonData';

describe('the map roster', () => {
  it('holds the Sun, every planet and every moon, once each', () => {
    expect(MAP_BODIES.length).toBe(1 + PLANETARIUM_BODIES.length + MOONS.length);
    const names = MAP_BODIES.map((b) => b.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain(SUN_DATA.name);
    for (const planet of PLANETARIUM_BODIES) expect(names).toContain(planet.name);
    for (const moon of MOONS) expect(names).toContain(moon.name);
  });

  it('leads with the Sun, then the planets inner→outer — the label priority', () => {
    expect(MAP_BODIES[0].name).toBe(SUN_DATA.name);
    expect(MAP_BODIES.slice(1, 1 + PLANETARIUM_BODIES.length).map((b) => b.name))
      .toEqual(PLANETARIUM_BODIES.map((b) => b.name));
  });

  it('carries each body its true radius and its catalog tint', () => {
    const sun = mapBody(SUN_DATA.name);
    expect(sun).toMatchObject({
      kind: 'sun',
      parentPlanet: null,
      radiusAU: SUN_DATA.radiusAU,
      color: SUN_DATA.color,
    });
    const jupiter = PLANETARIUM_BODIES.find((b) => b.name === 'Jupiter')!;
    expect(mapBody('Jupiter')).toMatchObject({
      kind: 'planet',
      parentPlanet: null,
      radiusAU: jupiter.radiusAU,
      color: jupiter.color,
    });
    const io = MOONS.find((m) => m.name === 'Io')!;
    expect(mapBody('Io')).toMatchObject({
      kind: 'moon',
      parentPlanet: 'Jupiter',
      radiusAU: io.radiusAU,
      color: io.color,
    });
  });

  it('gives every moon a parent that is a planet on the chart', () => {
    const planets = new Set(PLANETARIUM_BODIES.map((b) => b.name));
    for (const body of MAP_BODIES) {
      if (body.kind !== 'moon') continue;
      expect(body.parentPlanet).not.toBeNull();
      expect(planets.has(body.parentPlanet!)).toBe(true);
    }
  });

  it('answers an unknown name with null, never with a zeroed body', () => {
    for (const name of ['Nibiru', '', 'sun', '__ship', 'Jupiter ', 'Moonx']) {
      expect(mapBody(name)).toBeNull();
      expect(mapBodyRefFor(name)).toBeNull();
    }
  });
});

describe('pool capacities', () => {
  it('size the pick anchors from the catalogs: every body at once, plus the ship', () => {
    expect(MAP_PICK_ANCHOR_CAPACITY)
      .toBe(1 + PLANETARIUM_BODIES.length + MOONS.length + 1);
    expect(MAP_PICK_ANCHOR_CAPACITY).toBeGreaterThanOrEqual(MAP_BODIES.length + 1);
  });

  it('size the label pool for every body the roster holds', () => {
    expect(MAP_LABEL_CAPACITY).toBe(MAP_BODIES.length);
  });
});

describe('mapBodyAcceptsCamera', () => {
  // The chart as it draws today: the Sun and the planets.
  const drawsPlanets = (name: string) => PLANETARIUM_BODIES.some((b) => b.name === name);

  it('refuses a moon while the chart draws no moon', () => {
    for (const name of ['Cordelia', 'Io', 'Moon', 'Naiad', 'Charon']) {
      expect(mapBodyAcceptsCamera(name, drawsPlanets)).toBe(false);
    }
  });

  it('accepts the Sun and every drawn planet', () => {
    expect(mapBodyAcceptsCamera(SUN_DATA.name, drawsPlanets)).toBe(true);
    for (const planet of PLANETARIUM_BODIES) {
      expect(mapBodyAcceptsCamera(planet.name, drawsPlanets)).toBe(true);
    }
  });

  it('refuses a planet the scene has not built yet', () => {
    expect(mapBodyAcceptsCamera('Neptune', () => false)).toBe(false);
    // The Sun orbits nothing, so it never needs the parent clearance the rest
    // of this policy is about.
    expect(mapBodyAcceptsCamera(SUN_DATA.name, () => false)).toBe(true);
  });

  it('lifts for a body the moment the scene draws it', () => {
    const withIo = (name: string) => drawsPlanets(name) || name === 'Io';
    expect(mapBodyAcceptsCamera('Io', withIo)).toBe(true);
    expect(mapBodyAcceptsCamera('Europa', withIo)).toBe(false);
  });

  it('refuses a name the chart does not know, whatever the scene says', () => {
    expect(mapBodyAcceptsCamera('Nibiru', () => true)).toBe(false);
    expect(mapBodyAcceptsCamera('', () => true)).toBe(false);
  });
});

describe('mapBodyRefFor', () => {
  it('hands a moon its parent, so a commit target names the system', () => {
    expect(mapBodyRefFor('Io')).toEqual({ type: 'moon', name: 'Io', parentPlanet: 'Jupiter' });
    expect(mapBodyRefFor('Charon')).toEqual({ type: 'moon', name: 'Charon', parentPlanet: 'Pluto' });
    expect(mapBodyRefFor('Moon')).toEqual({ type: 'moon', name: 'Moon', parentPlanet: 'Earth' });
  });

  it('rides a planet, and the Sun, as a planet-typed target', () => {
    expect(mapBodyRefFor('Mars')).toEqual({ type: 'planet', name: 'Mars' });
    expect(mapBodyRefFor(SUN_DATA.name)).toEqual({ type: 'planet', name: SUN_DATA.name });
  });
});
