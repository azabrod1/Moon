import { describe, expect, it } from 'vitest';
import { resolveInteriorBody } from './interiorBody';
import { interiorBodyIds } from './data/interiorRegistry';
import { SUN_DATA } from '../planetarium/planets/planetData';

describe('resolveInteriorBody', () => {
  it('resolves every body the registry answers for, so nothing the picker offers falls back to the default', () => {
    const ids = interiorBodyIds();
    expect(ids.length).toBeGreaterThan(20);
    for (const bodyId of ids) {
      const body = resolveInteriorBody(bodyId);
      expect(body, bodyId).not.toBeNull();
      expect(body!.id).toBe(bodyId);
      expect(body!.radiusKm).toBeGreaterThan(0);
    }
  });

  it('resolves Pluto as a planet: the planetarium ships it outside PLANETS', () => {
    const pluto = resolveInteriorBody('Pluto');
    expect(pluto?.planet?.name).toBe('Pluto');
    expect(pluto?.moon).toBeNull();
    expect(pluto?.sun).toBe(false);
    expect(pluto?.radiusKm).toBeCloseTo(1188, -1);
  });

  it('resolves the Sun with the catalog radius and no map', () => {
    const sun = resolveInteriorBody('Sun');
    expect(sun).toEqual({ id: 'Sun', planet: null, moon: null, sun: true, radiusKm: SUN_DATA.radiusKm });
  });

  it('resolves a moon by name with its own radius', () => {
    const europa = resolveInteriorBody('Europa');
    expect(europa?.moon?.name).toBe('Europa');
    expect(europa?.planet).toBeNull();
    expect(europa?.radiusKm).toBe(europa?.moon?.radiusKm);
  });

  it('returns null for a name the catalog does not carry', () => {
    expect(resolveInteriorBody('Vulcan')).toBeNull();
    expect(resolveInteriorBody('')).toBeNull();
    expect(resolveInteriorBody('pluto')).toBeNull();
  });
});
