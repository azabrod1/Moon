/**
 * The user's planetarium preferences: the ☰ root toggles (Show ship,
 * Constellations, Planet labels, Label distances, Planet markers, Orbit
 * lines, Mini map and its size, Slower near planets) and the deck's "Open sky
 * panel on arrival" switch. Each lives on its own storage key through
 * app/storedSetting.ts, so "New Journey", a save that fails validation and
 * the tutorial's restore all leave them alone: the journey is the ship, the
 * clock, the landing and the visited list, and a preference is none of those.
 *
 * Until this module the preferences travelled inside the journey save, which
 * is why "New Journey" used to reset every toggle. Those copies are read one
 * last time here: resolvePreferences takes a key's value first, the journey's
 * copy second (a save written before the keys existed), the default last; and
 * migratePreferencesFromJourney writes each copy onto its key when the key is
 * absent. The journey keeps carrying its copies until every needed write has
 * landed (the mode checks `complete` and strips the fields from its saves
 * only then), so a private window that refuses the keys loses nothing.
 *
 * Three preferences are tri-state: the sky panel's device-dependent default
 * (on for fine pointers) is resolved at read time and never stored, and the
 * mini map and its size carry an opinion only once the user has touched them.
 * An absent key stays absent, so one device's default never becomes another's
 * saved choice.
 */
import { booleanCodec, enumCodec, numberCodec, storedSetting, type StoredSetting } from '../app/storedSetting';
import type { QualityStorage } from '../app/qualitySetting';
import { clampMiniSizeScale } from './map/miniChart';
import type { LabelDistancesMode, PlanetariumState } from './PlanetariumStore';

export const LABEL_DISTANCES_MODES = ['hover', 'always'] as const;

export const showShipSetting = storedSetting('planetarium-show-ship', booleanCodec);
export const constellationsSetting = storedSetting('planetarium-constellations', booleanCodec);
export const bodyLabelsSetting = storedSetting('planetarium-body-labels', booleanCodec);
export const labelDistancesSetting = storedSetting<LabelDistancesMode>(
  'planetarium-label-distances',
  enumCodec(LABEL_DISTANCES_MODES),
);
export const bodyMarkersSetting = storedSetting('planetarium-body-markers', booleanCodec);
export const orbitLinesSetting = storedSetting('planetarium-orbit-lines', booleanCodec);
export const miniChartSetting = storedSetting('planetarium-mini-chart', booleanCodec);
export const miniChartSizeSetting = storedSetting('planetarium-mini-chart-size', numberCodec(clampMiniSizeScale));
export const slowerNearPlanetsSetting = storedSetting('planetarium-slower-near-planets', booleanCodec);
export const skyPanelOnArrivalSetting = storedSetting('planetarium-sky-panel-on-arrival', booleanCodec);

/** The preferences as the mode holds them. Tri-state fields are null until
 *  the user has touched the control. */
export interface PlanetariumPreferences {
  showShip: boolean;
  showConstellations: boolean;
  showBodyLabels: boolean;
  labelDistancesMode: LabelDistancesMode;
  showBodyMarkers: boolean;
  showOrbitLines: boolean;
  miniChartPref: boolean | null;
  miniChartSizePref: number | null;
  systemSlowdown: boolean;
  skyPref: boolean | null;
}

export const DEFAULT_PREFERENCES: Readonly<PlanetariumPreferences> = {
  showShip: true,
  showConstellations: false,
  showBodyLabels: true,
  labelDistancesMode: 'hover',
  showBodyMarkers: true,
  showOrbitLines: false,
  miniChartPref: null,
  miniChartSizePref: null,
  systemSlowdown: true,
  skyPref: null,
};

/** Each preference beside its key and the journey field it used to live in. */
const PREFERENCE_FIELDS: ReadonlyArray<{
  field: keyof PlanetariumPreferences;
  setting: StoredSetting<boolean> | StoredSetting<number> | StoredSetting<LabelDistancesMode>;
}> = [
  { field: 'showShip', setting: showShipSetting },
  { field: 'showConstellations', setting: constellationsSetting },
  { field: 'showBodyLabels', setting: bodyLabelsSetting },
  { field: 'labelDistancesMode', setting: labelDistancesSetting },
  { field: 'showBodyMarkers', setting: bodyMarkersSetting },
  { field: 'showOrbitLines', setting: orbitLinesSetting },
  { field: 'miniChartPref', setting: miniChartSetting },
  { field: 'miniChartSizePref', setting: miniChartSizeSetting },
  { field: 'systemSlowdown', setting: slowerNearPlanetsSetting },
  { field: 'skyPref', setting: skyPanelOnArrivalSetting },
];

/** Every key this module owns, for a probe or a reset. */
export const PREFERENCE_KEYS: readonly string[] = PREFERENCE_FIELDS.map((entry) => entry.setting.key);

/** The journey's copy of one preference, or null where the save carries none.
 *  The sanitiser has already typed and bounded these. */
function journeyValue(
  journey: PlanetariumState | null,
  field: keyof PlanetariumPreferences,
): boolean | number | LabelDistancesMode | null {
  if (!journey) return null;
  const value = journey[field];
  return value === undefined ? null : value;
}

/**
 * The preferences to apply: a key's value first, the journey's copy second,
 * the default last. A tri-state preference with neither stays null.
 */
export function resolvePreferences(
  journey: PlanetariumState | null,
  storage: QualityStorage | null = null,
): PlanetariumPreferences {
  const resolved: Record<string, unknown> = { ...DEFAULT_PREFERENCES };
  for (const { field, setting } of PREFERENCE_FIELDS) {
    const stored = setting.read(storage);
    if (stored !== null) {
      resolved[field] = stored;
      continue;
    }
    const carried = journeyValue(journey, field);
    if (carried !== null) resolved[field] = carried;
  }
  return resolved as unknown as PlanetariumPreferences;
}

/**
 * Write one preference to its key, or make sure the key cannot lie. A key
 * always outranks the journey's copy at boot (resolvePreferences), so when
 * the write is refused — a full store, with an older value still under the
 * key — the key is cleared: the journey carries the new value until a write
 * lands, and nothing stale can outrank it. Returns whether the write landed.
 */
export function persistPreference<T>(
  setting: StoredSetting<T>,
  value: T,
  storage: QualityStorage | null = null,
): boolean {
  if (setting.write(value, storage)) return true;
  setting.clear(storage);
  return false;
}

export interface PreferenceMigration {
  /** The keys written from the journey's copies. */
  written: string[];
  /** Every needed write landed (true when none was needed). Until this is
   *  true the journey must keep carrying its copies. */
  complete: boolean;
}

/**
 * The one-time copy from a save written before the keys existed: each
 * preference whose key is absent and whose value the journey carries is
 * written onto its key. An existing key always wins and is never touched; an
 * absent tri-state whose journey copy is also absent stays absent.
 */
export function migratePreferencesFromJourney(
  journey: PlanetariumState | null,
  storage: QualityStorage | null = null,
): PreferenceMigration {
  const written: string[] = [];
  let complete = true;
  for (const { field, setting } of PREFERENCE_FIELDS) {
    if (setting.read(storage) !== null) continue;
    const carried = journeyValue(journey, field);
    if (carried === null) continue;
    // Each setting's codec types its own value; the journey's copy came
    // through the sanitiser with that same type.
    const landed = (setting as unknown as StoredSetting<typeof carried>).write(carried, storage);
    if (landed) written.push(setting.key);
    else complete = false;
  }
  return { written, complete };
}

/** A journey record without the preference copies: what a save writes once
 *  the keys hold the preferences. */
export function withoutPreferenceFields(state: PlanetariumState): PlanetariumState {
  const stripped: Record<string, unknown> = { ...state };
  for (const { field } of PREFERENCE_FIELDS) delete stripped[field];
  return stripped as unknown as PlanetariumState;
}

/** A journey record carrying the live preferences: what a save writes while
 *  the keys have not all taken them. Tri-state nulls are left out, as the
 *  sanitiser expects. */
export function withPreferenceFields(
  state: PlanetariumState,
  prefs: PlanetariumPreferences,
): PlanetariumState {
  const carried: Record<string, unknown> = { ...withoutPreferenceFields(state) };
  for (const { field } of PREFERENCE_FIELDS) {
    const value = prefs[field];
    if (value !== null) carried[field] = value;
  }
  return carried as unknown as PlanetariumState;
}
