import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  PREFERENCE_KEYS,
  migratePreferencesFromJourney,
  miniChartSizeSetting,
  orbitLinesSetting,
  resolvePreferences,
  showShipSetting,
  skyPanelOnArrivalSetting,
  withPreferenceFields,
  withoutPreferenceFields,
} from './preferences';
import { createDefaultPlanetariumState, sanitizePlanetariumState, type PlanetariumState } from './PlanetariumStore';
import { MINI_SIZE_MAX_SCALE } from './map/miniChart';
import { QUALITY_STORAGE_KEY } from '../app/qualitySetting';
import type { QualityStorage } from '../app/qualitySetting';

function fakeStorage(seed: Record<string, string> = {}): QualityStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { map.delete(key); },
  };
}

/** A storage that reads fine but refuses every write: a full or private store. */
function readOnlyStorage(seed: Record<string, string> = {}): QualityStorage {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); },
  };
}

/** A journey from the era when the preferences rode inside it. */
function legacyJourney(overrides: Record<string, unknown> = {}): PlanetariumState {
  return {
    ...createDefaultPlanetariumState(),
    showShip: false,
    showOrbitLines: true,
    labelDistancesMode: 'always',
    miniChartSizePref: 1.5,
    ...overrides,
  } as PlanetariumState;
}

describe('the keys', () => {
  it('are one per preference, each its own, and none of them a graphics key', () => {
    expect(new Set(PREFERENCE_KEYS).size).toBe(PREFERENCE_KEYS.length);
    expect(PREFERENCE_KEYS).toHaveLength(10);
    for (const key of PREFERENCE_KEYS) {
      expect(key.startsWith('planetarium-')).toBe(true);
      expect(key).not.toBe(QUALITY_STORAGE_KEY);
    }
  });
});

describe('resolvePreferences', () => {
  it('takes the default when nothing is saved anywhere', () => {
    expect(resolvePreferences(null, fakeStorage())).toEqual(DEFAULT_PREFERENCES);
  });

  it('takes the journey\'s copy over the default, for a save from before the keys', () => {
    const prefs = resolvePreferences(legacyJourney(), fakeStorage());
    expect(prefs.showShip).toBe(false);
    expect(prefs.showOrbitLines).toBe(true);
    expect(prefs.labelDistancesMode).toBe('always');
    expect(prefs.miniChartSizePref).toBe(1.5);
    // Untouched in that journey, so still no opinion.
    expect(prefs.skyPref).toBeNull();
    expect(prefs.miniChartPref).toBeNull();
  });

  it('takes a key over the journey\'s copy: the standalone value always wins', () => {
    const store = fakeStorage({ [showShipSetting.key]: 'true', [orbitLinesSetting.key]: 'false' });
    const prefs = resolvePreferences(legacyJourney(), store);
    expect(prefs.showShip).toBe(true);
    expect(prefs.showOrbitLines).toBe(false);
    // A preference with no key still falls through to the journey.
    expect(prefs.labelDistancesMode).toBe('always');
  });

  it('bounds a hand-edited size key the way the journey sanitiser does', () => {
    const store = fakeStorage({ [miniChartSizeSetting.key]: '999' });
    expect(resolvePreferences(null, store).miniChartSizePref).toBe(MINI_SIZE_MAX_SCALE);
  });

  it('leaves a tri-state absent when neither the key nor the journey has an opinion', () => {
    const prefs = resolvePreferences(createDefaultPlanetariumState(), fakeStorage());
    expect(prefs.skyPref).toBeNull();
    expect(prefs.miniChartPref).toBeNull();
    expect(prefs.miniChartSizePref).toBeNull();
  });
});

describe('migratePreferencesFromJourney', () => {
  it('copies each carried value onto an absent key, once, and reports complete', () => {
    const store = fakeStorage();
    const first = migratePreferencesFromJourney(legacyJourney(), store);
    expect(first.complete).toBe(true);
    expect(first.written).toEqual(expect.arrayContaining([showShipSetting.key, orbitLinesSetting.key]));
    expect(showShipSetting.read(store)).toBe(false);
    expect(orbitLinesSetting.read(store)).toBe(true);
    expect(miniChartSizeSetting.read(store)).toBe(1.5);
    // The keys are there now: a second pass has nothing to do.
    const second = migratePreferencesFromJourney(legacyJourney({ showShip: true }), store);
    expect(second.written).toEqual([]);
    expect(second.complete).toBe(true);
    expect(showShipSetting.read(store)).toBe(false);
  });

  it('never overwrites an existing key with the journey\'s copy', () => {
    const store = fakeStorage({ [showShipSetting.key]: 'true' });
    migratePreferencesFromJourney(legacyJourney({ showShip: false }), store);
    expect(showShipSetting.read(store)).toBe(true);
  });

  it('leaves an absent tri-state absent: a device default is never written as a choice', () => {
    const store = fakeStorage();
    migratePreferencesFromJourney(createDefaultPlanetariumState(), store);
    expect(skyPanelOnArrivalSetting.read(store)).toBeNull();
    expect(store.map.has(skyPanelOnArrivalSetting.key)).toBe(false);
  });

  it('reports incomplete when a write is refused, so the journey keeps its copies', () => {
    const result = migratePreferencesFromJourney(legacyJourney(), readOnlyStorage());
    expect(result.complete).toBe(false);
    expect(result.written).toEqual([]);
  });

  it('has nothing to do, and is complete, for a journey without copies — as the app reads it, through the sanitiser', () => {
    const store = fakeStorage();
    const stripped = withoutPreferenceFields(legacyJourney());
    expect(migratePreferencesFromJourney(stripped, store)).toEqual({ written: [], complete: true });
    // The sanitiser must not hand the migration defaults to copy: a stripped
    // save read on the next boot writes no key the user never chose.
    const reread = sanitizePlanetariumState(JSON.parse(JSON.stringify(stripped)));
    expect(migratePreferencesFromJourney(reread, store)).toEqual({ written: [], complete: true });
    expect(store.map.size).toBe(0);
  });
});

describe('the journey record', () => {
  it('drops every preference copy once the keys hold them, and the old save still parses', () => {
    const stripped = withoutPreferenceFields(legacyJourney());
    expect('showShip' in stripped).toBe(false);
    expect('labelDistancesMode' in stripped).toBe(false);
    expect('miniChartSizePref' in stripped).toBe(false);
    expect(stripped.positionAU).toEqual(createDefaultPlanetariumState().positionAU);
    // What the sanitiser makes of it is a valid journey carrying no
    // preference at all; the defaults apply at read, never from the save.
    const parsed = sanitizePlanetariumState(JSON.parse(JSON.stringify(stripped)));
    expect(parsed).not.toBeNull();
    expect(parsed?.showShip).toBeUndefined();
    expect(resolvePreferences(parsed, fakeStorage())).toEqual(DEFAULT_PREFERENCES);
  });

  it('carries the live preferences while the keys are not confirmed, nulls left out', () => {
    const carried = withPreferenceFields(withoutPreferenceFields(legacyJourney()), {
      ...DEFAULT_PREFERENCES,
      showShip: false,
      skyPref: null,
    });
    expect(carried.showShip).toBe(false);
    expect('skyPref' in carried).toBe(false);
    expect(carried.systemSlowdown).toBe(true);
  });
});
