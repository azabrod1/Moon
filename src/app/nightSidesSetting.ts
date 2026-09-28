/**
 * Where the Night sides setting is kept.
 *
 * Real, the default, is the physics: a night side is black where no sunlight
 * falls, and what light it does get is the light the scene models — a nearby
 * planet's (planetshine), the sky's own twilight on a body with air. Under the
 * tone curve's toe the authored starlight floor draws nothing, so a new Mars
 * from space is black, which is what a camera would record. Brightened is the
 * reader's choice to see the ground anyway: a dimmed copy of the surface in its
 * own colours on the dark half (world/surfaceShading `applyNightLift`), brighter
 * than it really is and labelled as such.
 *
 * One standalone synchronous localStorage key, the shape `frameRateSetting.ts`
 * uses, and deliberately NOT part of the journey save: that state loads from
 * IndexedDB long after the first frame, and "New Journey" clears it — a way of
 * looking at the sky must survive both. There is no boot-loop marker: the
 * setting is one uniform and allocates nothing, so no value of it can stop a
 * boot reaching a frame.
 *
 * Every access is wrapped: localStorage throws in private mode, and a
 * preference is never worth a boot failure. The storage is injectable so the
 * tests can drive a fake, including one whose every method throws.
 */

import type { QualityStorage } from './qualitySetting';

/** The saved value. */
export const NIGHT_SIDES_STORAGE_KEY = 'planetarium-night-sides';

/** Every value, in the order the menu offers them. */
export const NIGHT_SIDES = ['real', 'brightened'] as const;
export type NightSides = (typeof NIGHT_SIDES)[number];

/** The physics. */
export const DEFAULT_NIGHT_SIDES: NightSides = 'real';

/** What each segment reads. */
export const NIGHT_SIDES_LABELS: Record<NightSides, string> = {
  real: 'Real',
  brightened: 'Brightened',
};

/** The line under the control, for the value that is checked. */
export const NIGHT_SIDES_NOTES: Record<NightSides, string> = {
  real: 'Black where no sunlight falls. Light from a nearby planet and twilight still show.',
  brightened: 'Lifted so the ground on the dark side still shows. Brighter than it really is.',
};

/** What the ☰ root's Display row carries beside it. A bare "Real" says
 *  nothing on a row named Display, so the value names what it is about. */
export function nightSidesSummary(mode: NightSides): string {
  return mode === 'brightened' ? 'Brightened nights' : 'Real nights';
}

/** What the control does to the app, so the control itself owns no policy. */
export interface NightSidesControl {
  /** The value the session is running at. */
  mode(): NightSides;
  /** Pick one: saved, and applied to every body from the next frame. */
  set(mode: NightSides): void;
}

function webStorage(): QualityStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function asMode(raw: string | null): NightSides | null {
  if (raw === null) return null;
  const value = raw.trim().toLowerCase();
  return NIGHT_SIDES.includes(value as NightSides) ? (value as NightSides) : null;
}

/** The saved value, or null where nothing legible is saved. */
export function readNightSides(storage: QualityStorage | null = null): NightSides | null {
  const store = storage ?? webStorage();
  if (store === null) return null;
  try {
    return asMode(store.getItem(NIGHT_SIDES_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Save the value the user picked. */
export function writeNightSides(mode: NightSides, storage: QualityStorage | null = null): void {
  const store = storage ?? webStorage();
  if (store === null) return;
  try {
    store.setItem(NIGHT_SIDES_STORAGE_KEY, mode);
  } catch {
    /* ignore: private browsing */
  }
}

/** Forget the saved value, so the next boot takes the default. */
export function clearNightSides(storage: QualityStorage | null = null): void {
  const store = storage ?? webStorage();
  if (store === null) return;
  try {
    store.removeItem(NIGHT_SIDES_STORAGE_KEY);
  } catch {
    /* ignore: private browsing */
  }
}

/** `?nightsides=real|brightened`, on any build. Anything else reads as
 *  unasked. */
export function parseNightSidesParam(search: string): NightSides | null {
  const raw = new URLSearchParams(search).get('nightsides');
  if (raw === null || raw.trim() === '') return null;
  return asMode(raw);
}

/** The value this boot runs at: the URL's word, else the saved one, else
 *  Real. The URL is this boot's own instruction and wins outright. */
export function resolveBootNightSides(search: string, storage: QualityStorage | null = null): NightSides {
  return parseNightSidesParam(search) ?? readNightSides(storage) ?? DEFAULT_NIGHT_SIDES;
}
