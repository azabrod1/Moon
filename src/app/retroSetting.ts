/**
 * Where the Look setting is kept: Modern, the app as it is, or Retro, a 1990s
 * screen (app/retroScreen.ts for the grid, app/RetroPresentPass.ts for the
 * picture, the `retro` class on <html> for the interface).
 *
 * One standalone localStorage key through app/storedSetting.ts, never part of
 * the journey save: New Journey and a restore leave it alone. `?retro=1` or
 * `?retro=0` on any build overrides it for one boot without saving.
 *
 * It is read twice at boot. An inline script at the top of index.html reads
 * the same key (RETRO_STORAGE_KEY, spelled out there) to put the class on
 * <html> before the first paint, so the loading screen never flashes the
 * modern look; main then reads it here for the renderer. The two agree
 * because both resolve the URL first and the saved word second.
 */
import { enumCodec, storedSetting } from './storedSetting';
import type { QualityStorage } from './qualitySetting';

export const RETRO_STORAGE_KEY = 'planetarium-look';

/** Every value, in the order the menu offers them. */
export const LOOKS = ['modern', 'retro'] as const;
export type Look = (typeof LOOKS)[number];

export const DEFAULT_LOOK: Look = 'modern';

/** What each segment reads. */
export const LOOK_LABELS: Record<Look, string> = {
  modern: 'Modern',
  retro: 'Retro',
};

/** The line under the control, for the value that is checked. */
export const LOOK_NOTES: Record<Look, string> = {
  modern: 'The app as it is: full resolution and smooth panels.',
  retro: 'A 1990s screen: big pixels, 256 colours and bitmap type.',
};

export const lookSetting = storedSetting<Look>(RETRO_STORAGE_KEY, enumCodec(LOOKS));

/** What the control does to the app, so the control itself owns no policy. */
export interface LookControl {
  /** The look the session is running at. */
  look(): Look;
  /** Pick one: saved, and applied from the next frame. */
  set(look: Look): void;
  /** Whether this device can draw the retro picture (it needs the composer). */
  offered(): boolean;
}

/** `?retro=1|0` (also on/off, retro/modern), on any build. Anything else reads as unasked. */
export function parseRetroParam(search: string): Look | null {
  const raw = new URLSearchParams(search).get('retro');
  if (raw === null) return null;
  const word = raw.trim().toLowerCase();
  if (word === '1' || word === 'on' || word === 'retro' || word === '') return 'retro';
  if (word === '0' || word === 'off' || word === 'modern') return 'modern';
  return null;
}

/** The look this boot runs at: the URL's word, else the saved one, else Modern. */
export function resolveBootLook(search: string, storage: QualityStorage | null = null): Look {
  return parseRetroParam(search) ?? lookSetting.read(storage) ?? DEFAULT_LOOK;
}
