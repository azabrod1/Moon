import { describe, expect, it } from 'vitest';
import {
  createDefaultPlanetariumState,
  sanitizePlanetariumState,
  PlanetariumStore,
} from './PlanetariumStore';
import { PLAYER_SHIPS } from './ship/shipProfiles';

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

describe('showBodyLabelDistances is a plain boolean (default true)', () => {
  it('defaults to true when the field is absent from the save', () => {
    expect(sanitizePlanetariumState(rawSave({}))?.showBodyLabelDistances).toBe(true);
    expect(createDefaultPlanetariumState().showBodyLabelDistances).toBe(true);
  });

  it('round-trips an explicit false', () => {
    expect(sanitizePlanetariumState(rawSave({ showBodyLabelDistances: false }))?.showBodyLabelDistances).toBe(false);
  });

  it('non-boolean garbage falls back to the default', () => {
    expect(sanitizePlanetariumState(rawSave({ showBodyLabelDistances: 'no' }))?.showBodyLabelDistances).toBe(true);
  });
});

describe('player ship selection persistence', () => {
  it('round-trips every selectable profile', () => {
    for (const ship of PLAYER_SHIPS) {
      expect(sanitizePlanetariumState(rawSave({ shipProfile: ship.id }))?.shipProfile).toBe(ship.id);
    }
  });

  it('migrates old or malformed saves to the current ship', () => {
    expect(sanitizePlanetariumState(rawSave({}))?.shipProfile).toBe('default');
    expect(sanitizePlanetariumState(rawSave({ shipProfile: 'death-star' }))?.shipProfile).toBe('default');
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

// The store reads window.localStorage/window.sessionStorage inside try/catch,
// so a stubbed window on the node global is all it needs; indexedDB stays
// undefined here, which exercises the no-IDB fallback paths.
function fakeStorage(broken = false): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => {
      if (broken) throw new DOMException('quota', 'QuotaExceededError');
      map.set(k, v);
    },
  } as Storage;
}

async function withWindow<T>(
  local: Storage,
  session: Storage,
  fn: () => Promise<T>,
): Promise<T> {
  const g = globalThis as { window?: unknown };
  const prev = g.window;
  g.window = { localStorage: local, sessionStorage: session };
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete g.window;
    else g.window = prev;
  }
}

const STORAGE_KEY = 'orbital-sim-planetarium-state';
const LEGACY_STORAGE_KEY = 'orbital-sim-explore-state';

describe('legacy migration commits before it deletes', () => {
  it('a valid legacy save is written to the current key before the legacy copy goes', async () => {
    const local = fakeStorage();
    local.setItem(LEGACY_STORAGE_KEY, JSON.stringify(rawSave({})));
    const state = await withWindow(local, fakeStorage(), () => new PlanetariumStore().loadState());
    expect(state).not.toBeNull();
    // The replacement must exist under the current key — a crash after this
    // load may never reach the first autosave, and the journey must survive.
    expect(local.getItem(STORAGE_KEY)).not.toBeNull();
    expect(local.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });

  it('an unreadable legacy save is dropped and no current key appears', async () => {
    const local = fakeStorage();
    local.setItem(LEGACY_STORAGE_KEY, '{not json');
    const state = await withWindow(local, fakeStorage(), () => new PlanetariumStore().loadState());
    expect(state).toBeNull();
    expect(local.getItem(STORAGE_KEY)).toBeNull();
    expect(local.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });
});

describe('saveState reports whether anything committed', () => {
  it('resolves true when web storage takes the write', async () => {
    const local = fakeStorage();
    const ok = await withWindow(local, fakeStorage(), () =>
      new PlanetariumStore().saveState(createDefaultPlanetariumState()),
    );
    expect(ok).toBe(true);
    expect(local.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it('resolves false when every backend rejects (the Save toast must not lie)', async () => {
    const ok = await withWindow(fakeStorage(true), fakeStorage(true), () =>
      new PlanetariumStore().saveState(createDefaultPlanetariumState()),
    );
    expect(ok).toBe(false);
  });
});
