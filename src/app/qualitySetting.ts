/**
 * Where the Graphics quality setting is kept.
 *
 * ONE standalone synchronous localStorage key, in the same shape as the
 * intro-help and surface-hint flags, and deliberately NOT part of the journey
 * save: that state is loaded asynchronously from IndexedDB long after the
 * composer is built, and "New Journey" clears it — a graphics preference must
 * survive both. main.ts reads this at module init, before there is a renderer
 * to size.
 *
 * Every access is wrapped: localStorage throws in private mode, and a
 * preference is never worth a boot failure. An unreadable or unknown value
 * reads as null, which the caller resolves to the default.
 *
 * **The boot-loop marker.** A level that a machine cannot allocate would be
 * re-applied on the reload after it died, with no way out but clearing site
 * data. So before a persisted non-default level is applied, the level is
 * written as a pending marker; the marker is cleared the moment the first
 * live frame is on screen. A marker still set at the next boot means the last
 * boot did not reach a frame under that level, so that boot falls back to
 * medium and says so. The marker is written with the level it was applying
 * rather than a flag, so the fallback can name what it refused.
 *
 * The storage is injectable so the tests can drive a fake — including one
 * whose every method throws, which is what private mode looks like from here.
 */

import { QUALITY_LEVELS, type QualityLevel } from './renderQuality';

/** The saved level. */
export const QUALITY_STORAGE_KEY = 'planetarium-graphics-quality';

/** The level a boot is in the middle of applying, cleared once a frame is
 *  live. */
export const QUALITY_PENDING_KEY = 'planetarium-graphics-quality-pending';

/** The three calls this module makes of a store, so a test can supply one. */
export interface QualityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The browser's own localStorage, or null where there is none (a worker, a
 *  test, a browser that refuses it outright). */
function webStorage(): QualityStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function read(key: string, storage: QualityStorage | null): string | null {
  const store = storage ?? webStorage();
  if (store === null) return null;
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string, storage: QualityStorage | null): void {
  const store = storage ?? webStorage();
  if (store === null) return;
  try {
    store.setItem(key, value);
  } catch {
    /* ignore: private browsing */
  }
}

function remove(key: string, storage: QualityStorage | null): void {
  const store = storage ?? webStorage();
  if (store === null) return;
  try {
    store.removeItem(key);
  } catch {
    /* ignore: private browsing */
  }
}

function asLevel(raw: string | null): QualityLevel | null {
  if (raw === null) return null;
  const value = raw.trim().toLowerCase();
  return QUALITY_LEVELS.includes(value as QualityLevel) ? (value as QualityLevel) : null;
}

/** The saved level, or null where nothing legible is saved — a first visit, a
 *  private window, or a value written by a build that offered other words. */
export function readQualityLevel(storage: QualityStorage | null = null): QualityLevel | null {
  return asLevel(read(QUALITY_STORAGE_KEY, storage));
}

/** Save the level the user picked. */
export function writeQualityLevel(level: QualityLevel, storage: QualityStorage | null = null): void {
  write(QUALITY_STORAGE_KEY, level, storage);
}

/** Forget the saved level, so the next boot takes the default. */
export function clearQualityLevel(storage: QualityStorage | null = null): void {
  remove(QUALITY_STORAGE_KEY, storage);
}

/** About to apply a saved level: record it until a frame is live. */
export function markPending(level: QualityLevel, storage: QualityStorage | null = null): void {
  write(QUALITY_PENDING_KEY, level, storage);
}

/** A frame is on screen under the level that was pending. */
export function clearPending(storage: QualityStorage | null = null): void {
  remove(QUALITY_PENDING_KEY, storage);
}

/** The level a previous boot was applying when it stopped reaching frames, or
 *  null. Read once at boot, BEFORE markPending writes this boot's own. */
export function pendingAtBoot(storage: QualityStorage | null = null): QualityLevel | null {
  return asLevel(read(QUALITY_PENDING_KEY, storage));
}
