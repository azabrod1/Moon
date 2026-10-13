/**
 * One stored user setting: a standalone synchronous localStorage key, read
 * through a codec that refuses what it cannot parse, and never part of the
 * journey save. "New Journey" clears the journey, and a save that fails
 * validation is cleared too; a preference must survive both. This is the
 * shape `qualitySetting.ts`, `frameRateSetting.ts` and `nightSidesSetting.ts`
 * each spell out by hand, made once, so a preference costs a key and a codec
 * rather than a module.
 *
 * Every access is wrapped: localStorage throws in private mode, and a
 * preference is never worth a boot failure. A read that fails, or finds
 * nothing legible, is null and the caller resolves the default. A write
 * reports whether it landed, so a migration can keep its source until it has.
 * The storage is injectable so tests can drive a fake, including one whose
 * every method throws.
 */
import type { QualityStorage } from './qualitySetting';

/** How a value becomes the string under the key, and back. `parse` returns
 *  null for anything this build does not offer. */
export interface SettingCodec<T> {
  parse(raw: string): T | null;
  serialize(value: T): string;
}

export interface StoredSetting<T> {
  readonly key: string;
  /** The saved value, or null where nothing legible is saved. */
  read(storage?: QualityStorage | null): T | null;
  /** Save the value; true when the storage took it. */
  write(value: T, storage?: QualityStorage | null): boolean;
  /** Forget the saved value, so the next read resolves to the default. */
  clear(storage?: QualityStorage | null): void;
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

export function storedSetting<T>(key: string, codec: SettingCodec<T>): StoredSetting<T> {
  return {
    key,
    read(storage = null) {
      const store = storage ?? webStorage();
      if (store === null) return null;
      try {
        const raw = store.getItem(key);
        return raw === null ? null : codec.parse(raw);
      } catch {
        return null;
      }
    },
    write(value, storage = null) {
      const store = storage ?? webStorage();
      if (store === null) return false;
      try {
        store.setItem(key, codec.serialize(value));
        return true;
      } catch {
        return false;
      }
    },
    clear(storage = null) {
      const store = storage ?? webStorage();
      if (store === null) return;
      try {
        store.removeItem(key);
      } catch {
        /* ignore: private browsing */
      }
    },
  };
}

/** The words "true" and "false", nothing else. */
export const booleanCodec: SettingCodec<boolean> = {
  parse(raw) {
    const value = raw.trim().toLowerCase();
    return value === 'true' ? true : value === 'false' ? false : null;
  },
  serialize(value) {
    return value ? 'true' : 'false';
  },
};

/** One of a fixed set of words, matched without regard to case or padding. */
export function enumCodec<T extends string>(values: readonly T[]): SettingCodec<T> {
  return {
    parse(raw) {
      const value = raw.trim().toLowerCase();
      return values.includes(value as T) ? (value as T) : null;
    },
    serialize(value) {
      return value;
    },
  };
}

/** A finite number, held inside the bounds the caller gives, so a hand-edited
 *  key cannot ask for something the control would never offer. */
export function numberCodec(clamp: (value: number) => number): SettingCodec<number> {
  return {
    parse(raw) {
      const value = Number(raw);
      return Number.isFinite(value) ? clamp(value) : null;
    },
    serialize(value) {
      return String(value);
    },
  };
}
