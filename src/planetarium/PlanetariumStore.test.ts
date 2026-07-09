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

describe('showBodyMarkers is a plain boolean (default true)', () => {
  it('defaults to true when the field is absent from the save', () => {
    expect(sanitizePlanetariumState(rawSave({}))?.showBodyMarkers).toBe(true);
    expect(createDefaultPlanetariumState().showBodyMarkers).toBe(true);
  });

  it('round-trips an explicit false', () => {
    expect(sanitizePlanetariumState(rawSave({ showBodyMarkers: false }))?.showBodyMarkers).toBe(false);
  });

  it('non-boolean garbage falls back to the default', () => {
    expect(sanitizePlanetariumState(rawSave({ showBodyMarkers: 'no' }))?.showBodyMarkers).toBe(true);
    expect(sanitizePlanetariumState(rawSave({ showBodyMarkers: 1 }))?.showBodyMarkers).toBe(true);
  });
});

describe('skyPref stays tri-state (absent until the user flips the toggle)', () => {
  it('round-trips an explicit flip', () => {
    expect(sanitizePlanetariumState(rawSave({ skyPref: false }))?.skyPref).toBe(false);
    expect(sanitizePlanetariumState(rawSave({ skyPref: true }))?.skyPref).toBe(true);
  });

  it('a session that never touched the toggle saves no skyPref field at all', () => {
    const state = sanitizePlanetariumState(rawSave({}));
    expect(state?.skyPref).toBeUndefined();
    // The auto-save writes JSON.stringify(state); the field must vanish there,
    // not concretize, or one device's default would follow the save around.
    expect('skyPref' in JSON.parse(JSON.stringify(state))).toBe(false);
  });

  it('non-boolean garbage sanitizes to absent, not to a default', () => {
    expect(sanitizePlanetariumState(rawSave({ skyPref: 'yes' }))?.skyPref).toBeUndefined();
    expect(sanitizePlanetariumState(rawSave({ skyPref: 1 }))?.skyPref).toBeUndefined();
  });

  it('the default state leaves it unset', () => {
    expect('skyPref' in createDefaultPlanetariumState()).toBe(false);
  });
});
