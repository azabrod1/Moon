import { describe, expect, it } from 'vitest';
import { MOONS } from './planets/moonData';
import { PLANETARIUM_BODIES } from './planets/planetData';
import {
  systemMapBodyRadius,
  systemMapFrameExtent,
  systemMapMoonBodyRadius,
  systemMapMoonOrbitRadius,
  systemMapMoonsVisible,
  systemMapOrbitRadius,
} from './SystemMap';

const byName = (name: string) => PLANETARIUM_BODIES.find((b) => b.name === name)!;
const moonByName = (name: string) => MOONS.find((m) => m.name === name)!;

describe('system map distance compression', () => {
  it('is monotonic and keeps every planet distinct', () => {
    const order = ['Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto'];
    const radii = order.map((n) => systemMapOrbitRadius(byName(n).semiMajorAxisAU));
    for (let i = 1; i < radii.length; i++) {
      expect(radii[i]).toBeGreaterThan(radii[i - 1]);
    }
  });

  it('compresses the enormous inner:outer distance ratio into a legible span', () => {
    // Real Pluto:Mercury semimajor ratio is ~102x; the map must pull that under
    // ~10x so the inner system is not crushed to a dot beside Pluto's orbit.
    const inner = systemMapOrbitRadius(byName('Mercury').semiMajorAxisAU);
    const outer = systemMapOrbitRadius(byName('Pluto').semiMajorAxisAU);
    expect(outer / inner).toBeLessThan(10);
    expect(outer / inner).toBeGreaterThan(3);
  });

  it('separates the Sun, a ship inside Mercury, and Mercury itself', () => {
    const sun = systemMapOrbitRadius(0);
    const ship = systemMapOrbitRadius(0.28);
    const mercury = systemMapOrbitRadius(byName('Mercury').semiMajorAxisAU);
    expect(sun).toBe(0);
    expect(ship).toBeGreaterThan(0.3);
    expect(mercury).toBeGreaterThan(ship + 0.15);
  });
});

describe('system map body sizing', () => {
  it('preserves physical size order while bounding every planet to a readable radius', () => {
    const radii = PLANETARIUM_BODIES.map((b) => systemMapBodyRadius(b.radiusAU));
    expect(Math.min(...radii)).toBeGreaterThanOrEqual(0.11);
    expect(Math.max(...radii)).toBeLessThanOrEqual(0.58);
    expect(systemMapBodyRadius(byName('Jupiter').radiusAU)).toBeGreaterThan(
      systemMapBodyRadius(byName('Earth').radiusAU),
    );
    expect(systemMapBodyRadius(byName('Earth').radiusAU)).toBeGreaterThan(
      systemMapBodyRadius(byName('Pluto').radiusAU),
    );
  });
});

describe('system map framing', () => {
  it('always contains the outer system, and stretches to include a distant ship', () => {
    expect(systemMapFrameExtent(1)).toBeGreaterThanOrEqual(7.6);
    expect(systemMapFrameExtent(80)).toBeGreaterThan(systemMapFrameExtent(1));
  });
});

describe('system map moon ring compression', () => {
  // Real satellite systems span ~1.3 to ~70 parent radii. The ring must keep
  // that ordering while landing every moon in a band just outside the planet —
  // a moon inside the parent's own disc, or flung off frame, is unreadable.
  const PARENT_MAP_RADIUS = 0.3;

  it('keeps every real moon in a legible band outside its parent', () => {
    for (const moon of MOONS) {
      const parent = byName(moon.parentPlanet);
      const r = systemMapMoonOrbitRadius(moon.orbitalRadiusAU / parent.radiusAU, PARENT_MAP_RADIUS);
      expect(r).toBeGreaterThan(PARENT_MAP_RADIUS * 1.5);
      expect(r).toBeLessThan(PARENT_MAP_RADIUS * 6);
    }
  });

  it('preserves the order of a real system and separates its inner moons', () => {
    const jupiter = byName('Jupiter');
    const ring = (name: string) => systemMapMoonOrbitRadius(
      moonByName(name).orbitalRadiusAU / jupiter.radiusAU,
      PARENT_MAP_RADIUS,
    );
    // Io < Europa < Ganymede < Callisto, and Io/Europa stay visibly apart
    // rather than collapsing together against Callisto's 26-radii orbit.
    expect(ring('Io')).toBeLessThan(ring('Europa'));
    expect(ring('Europa')).toBeLessThan(ring('Ganymede'));
    expect(ring('Ganymede')).toBeLessThan(ring('Callisto'));
    expect(ring('Europa') - ring('Io')).toBeGreaterThan(PARENT_MAP_RADIUS * 0.15);
  });

  it('scales with the parent and is well behaved at zero distance', () => {
    expect(systemMapMoonOrbitRadius(10, 0.6)).toBeCloseTo(2 * systemMapMoonOrbitRadius(10, 0.3), 12);
    expect(systemMapMoonOrbitRadius(0, 0.3)).toBeCloseTo(PARENT_MAP_RADIUS * 1.7, 12);
    expect(Number.isFinite(systemMapMoonOrbitRadius(-5, 0.3))).toBe(true);
  });
});

describe('system map moon sizing', () => {
  const PARENT_MAP_RADIUS = 0.3;
  const size = (name: string) => systemMapMoonBodyRadius(moonByName(name).radiusAU, PARENT_MAP_RADIUS);

  it('orders real moons by true radius and keeps the smallest visible', () => {
    expect(size('Ganymede')).toBeGreaterThan(size('Europa'));
    expect(size('Europa')).toBeGreaterThan(size('Mimas'));
    // Phobos is ~11 km — it must still clear the floor rather than vanish.
    expect(size('Phobos')).toBeGreaterThanOrEqual(PARENT_MAP_RADIUS * 0.03);
  });

  it('never lets a moon rival its parent, at any radius', () => {
    for (const moon of MOONS) {
      const r = systemMapMoonBodyRadius(moon.radiusAU, PARENT_MAP_RADIUS);
      expect(r).toBeLessThanOrEqual(PARENT_MAP_RADIUS * 0.36);
      expect(r).toBeGreaterThanOrEqual(PARENT_MAP_RADIUS * 0.03);
    }
  });
});

describe('system map moon level of detail', () => {
  it('reveals moons only once the parent is close, and scales with its map size', () => {
    // Hidden at the whole-system overview, shown at the focus framing
    // (FOCUS_DISTANCE_RADII = 6 parent radii).
    expect(systemMapMoonsVisible(OUTER_SCENE_RADIUS_APPROX, 0.3)).toBe(false);
    expect(systemMapMoonsVisible(0.3 * 6, 0.3)).toBe(true);
    // The threshold is a multiple of the parent's rendered size, so at one
    // distance a big planet has revealed its system while a small one has not.
    expect(systemMapMoonsVisible(4.5, 0.3)).toBe(false);
    expect(systemMapMoonsVisible(4.5, 0.58)).toBe(true);
  });
});

// The default overview sits ~11 scene units out (OUTER_SCENE_RADIUS).
const OUTER_SCENE_RADIUS_APPROX = 11;
