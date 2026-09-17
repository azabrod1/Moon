/**
 * Where the Frame rate setting is kept.
 *
 * One standalone synchronous localStorage key, the shape `qualitySetting.ts`
 * uses, and deliberately NOT part of the journey save: that state loads from
 * IndexedDB long after the animation loop starts, and "New Journey" clears it
 * — a frame-rate preference must survive both.
 *
 * There is no boot-loop marker here, and there does not need to be one: a
 * target allocates nothing, so no value of it can stop a boot reaching a
 * frame. That is the one thing this module does not copy from the graphics
 * quality's.
 *
 * "Screen" is the default and means today's behaviour: draw on every callback
 * and hold the 60 fps budget, whatever the display's rate. A ProMotion Mac, an
 * iPad or a 120 Hz phone therefore keeps drawing at its own rate when the
 * frame is cheap, exactly as a build with no cap does. The other three values
 * are offered on every display: on a 60 Hz screen 120 means "as fast as the
 * screen", the way a game's cap above the monitor's rate does, and the debug
 * line says so.
 *
 * Every access is wrapped: localStorage throws in private mode, and a
 * preference is never worth a boot failure. The storage is injectable so the
 * tests can drive a fake, including one whose every method throws.
 */

import type { QualityStorage } from './qualitySetting';

/** The saved value. */
export const FRAME_RATE_STORAGE_KEY = 'planetarium-frame-rate';

/** The row's cycle, in order. */
export const FRAME_RATES = ['screen', '30', '60', '120'] as const;
export type FrameRate = (typeof FRAME_RATES)[number];

/** Today's behaviour, named. */
export const DEFAULT_FRAME_RATE: FrameRate = 'screen';

/** What the row's button reads. Plain, and in the panel's voice. */
export const FRAME_RATE_LABELS: Record<FrameRate, string> = {
  screen: 'Screen',
  '30': '30 fps',
  '60': '60 fps',
  '120': '120 fps',
};

/** What the row does to the app, so the row itself owns no policy. */
export interface FrameRateControl {
  /** The value the session is running at. */
  rate(): FrameRate;
  /** Pick one: saved, and applied to the live loop. */
  set(rate: FrameRate): void;
  /**
   * Draw the next tick whatever the cadence says.
   *
   * It lives here because the cap is what makes a draw something to ask for:
   * a cover that must show one painted frame before it lifts cannot depend on
   * the row's value for it. Nothing half-loaded is ever shown, at any target.
   */
  requestDraw(): void;
}

function webStorage(): QualityStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function asRate(raw: string | null): FrameRate | null {
  if (raw === null) return null;
  const value = raw.trim().toLowerCase();
  return FRAME_RATES.includes(value as FrameRate) ? (value as FrameRate) : null;
}

/** The saved value, or null where nothing legible is saved. */
export function readFrameRate(storage: QualityStorage | null = null): FrameRate | null {
  const store = storage ?? webStorage();
  if (store === null) return null;
  try {
    return asRate(store.getItem(FRAME_RATE_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Save the value the user picked. */
export function writeFrameRate(rate: FrameRate, storage: QualityStorage | null = null): void {
  const store = storage ?? webStorage();
  if (store === null) return;
  try {
    store.setItem(FRAME_RATE_STORAGE_KEY, rate);
  } catch {
    /* ignore: private browsing */
  }
}

/** Forget the saved value, so the next boot takes the default. */
export function clearFrameRate(storage: QualityStorage | null = null): void {
  const store = storage ?? webStorage();
  if (store === null) return;
  try {
    store.removeItem(FRAME_RATE_STORAGE_KEY);
  } catch {
    /* ignore: private browsing */
  }
}

/** `?fps=screen|30|60|120`, on any build. Anything else reads as unasked. */
export function parseFrameRateParam(search: string): FrameRate | null {
  const raw = new URLSearchParams(search).get('fps');
  if (raw === null || raw.trim() === '') return null;
  return asRate(raw);
}

/** The value this boot runs at: the URL's word, else the saved one, else
 *  Screen. The URL is this boot's own instruction and wins outright. */
export function resolveBootFrameRate(search: string, storage: QualityStorage | null = null): FrameRate {
  return parseFrameRateParam(search) ?? readFrameRate(storage) ?? DEFAULT_FRAME_RATE;
}

/** The next value in the row's cycle. */
export function nextFrameRate(current: FrameRate): FrameRate {
  const at = FRAME_RATES.indexOf(current);
  const from = at < 0 ? FRAME_RATES.length - 1 : at;
  return FRAME_RATES[(from + 1) % FRAME_RATES.length];
}

/** Whether a value paces nothing. */
export function isScreenRate(rate: FrameRate): boolean {
  return rate === 'screen';
}

/** The interval the value asks for. Screen asks for 60 — it paces nothing,
 *  but the number is what the budget and the readout hold. */
export function requestedMsFor(rate: FrameRate): number {
  return rate === 'screen' ? 1000 / 60 : 1000 / Number(rate);
}
