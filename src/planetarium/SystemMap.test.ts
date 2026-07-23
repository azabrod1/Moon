import { describe, expect, it } from 'vitest';
import { PLANETARIUM_BODIES } from './planets/planetData';
import { systemMapBodyRadius, systemMapFrameExtent, systemMapOrbitRadius } from './SystemMap';

const byName = (name: string) => PLANETARIUM_BODIES.find((b) => b.name === name)!;

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
