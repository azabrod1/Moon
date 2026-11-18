/**
 * Where the Look is kept: Modern, the app as it is, or Retro. One localStorage
 * key of its own, never part of the journey save. `?retro=1` or `?retro=0`
 * overrides it for one load without saving.
 */

export const LOOKS = ['modern', 'retro'] as const;
export type Look = (typeof LOOKS)[number];

export const LOOK_LABELS: Record<Look, string> = { modern: 'Modern', retro: 'Retro' };

export const LOOK_NOTES: Record<Look, string> = {
  modern: 'The app as it is: full resolution and smooth panels.',
  retro: 'A 1990s screen: big pixels, 256 colours and bitmap type.',
};

/** The little of localStorage this needs; injectable for the test. */
export interface LookStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = 'planetarium-look';

function browserStorage(): LookStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The saved look and saving it; a storage that refuses (private mode) is no look. */
export const lookSetting = {
  read(storage: LookStorage | null = browserStorage()): Look | null {
    try {
      const value = storage?.getItem(KEY);
      return LOOKS.find((look) => look === value) ?? null;
    } catch {
      return null;
    }
  },
  write(look: Look, storage: LookStorage | null = browserStorage()): void {
    try {
      storage?.setItem(KEY, look);
    } catch {
      /* ignore: private browsing */
    }
  },
};

/** `?retro=1|0` (also on/off, retro/modern). Anything else reads as unasked. */
export function parseRetroParam(search: string): Look | null {
  const raw = new URLSearchParams(search).get('retro');
  if (raw === null) return null;
  const word = raw.trim().toLowerCase();
  if (word === '1' || word === 'on' || word === 'retro' || word === '') return 'retro';
  if (word === '0' || word === 'off' || word === 'modern') return 'modern';
  return null;
}

/** The look this load runs at: the URL's word, else the saved one, else Modern. */
export function resolveBootLook(search: string, storage: LookStorage | null = browserStorage()): Look {
  return parseRetroParam(search) ?? lookSetting.read(storage) ?? 'modern';
}
