/**
 * Where the Look is kept: Modern, the app as it is, or Retro. One localStorage
 * key of its own (app/storedSetting.ts), never part of the journey save.
 * `?retro=1` or `?retro=0` overrides it for one load without saving.
 */
import { enumCodec, storedSetting } from '../app/storedSetting';
import type { QualityStorage } from '../app/qualitySetting';

export const LOOKS = ['modern', 'retro'] as const;
export type Look = (typeof LOOKS)[number];

export const LOOK_LABELS: Record<Look, string> = { modern: 'Modern', retro: 'Retro' };

export const LOOK_NOTES: Record<Look, string> = {
  modern: 'The app as it is: full resolution and smooth panels.',
  retro: 'A 1990s screen: big pixels, 256 colours and bitmap type.',
};

export const lookSetting = storedSetting<Look>('planetarium-look', enumCodec(LOOKS));

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
export function resolveBootLook(search: string, storage: QualityStorage | null = null): Look {
  return parseRetroParam(search) ?? lookSetting.read(storage) ?? 'modern';
}
