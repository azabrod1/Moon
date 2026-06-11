import { describe, expect, it } from 'vitest';
import { createDefaultPlanetariumState, sanitizePlanetariumState } from './PlanetariumStore';

/** A minimal valid raw save; fields under test get spread over it. */
function rawSave(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    positionAU: { x: 1, y: 0, z: 0 },
    headingRad: 0,
    speed: 1,
    visitedPlanets: [],
    distanceTraveled: 0,
    timeElapsed: 0,
    timestamp: 0,
    autopilot: true,
    layoutMode: 'realistic',
    astroTimeUtcMs: 1_700_000_000_000,
    planetScale: 1,
    showShip: true,
    ...overrides,
  };
}

describe('autopilot provenance migration (autopilotUserEngaged)', () => {
  it('keeps an explicit flag from new-format saves', () => {
    const engaged = sanitizePlanetariumState(
      rawSave({ autopilotTarget: { type: 'planet', name: 'Mercury' }, autopilotUserEngaged: true }),
    );
    expect(engaged?.autopilotUserEngaged).toBe(true);
    const unengaged = sanitizePlanetariumState(
      rawSave({ autopilotTarget: { type: 'planet', name: 'Jupiter' }, autopilotUserEngaged: false }),
    );
    expect(unengaged?.autopilotUserEngaged).toBe(false);
  });

  it('legacy save with the Mercury onboarding default migrates un-engaged', () => {
    const state = sanitizePlanetariumState(
      rawSave({ autopilotTarget: { type: 'planet', name: 'Mercury' } }),
    );
    expect(state?.autopilotUserEngaged).toBe(false);
  });

  it('legacy save with a non-Mercury target migrates engaged (only user picks produce one)', () => {
    const planet = sanitizePlanetariumState(
      rawSave({ autopilotTarget: { type: 'planet', name: 'Jupiter' } }),
    );
    expect(planet?.autopilotUserEngaged).toBe(true);
    const moon = sanitizePlanetariumState(
      rawSave({ autopilotTarget: { type: 'moon', name: 'Io', parentPlanet: 'Jupiter' } }),
    );
    expect(moon?.autopilotUserEngaged).toBe(true);
  });

  it('legacy save with no target migrates un-engaged', () => {
    expect(sanitizePlanetariumState(rawSave({}))?.autopilotUserEngaged).toBe(false);
    expect(sanitizePlanetariumState(rawSave({ autopilotTarget: null }))?.autopilotUserEngaged).toBe(false);
  });

  it('default state starts un-engaged', () => {
    expect(createDefaultPlanetariumState().autopilotUserEngaged).toBe(false);
  });
});
