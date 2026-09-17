import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FRAME_RATE, FRAME_RATES, FRAME_RATE_LABELS, FRAME_RATE_STORAGE_KEY,
  clearFrameRate, isScreenRate, nextFrameRate, parseFrameRateParam, readFrameRate,
  requestedMsFor, resolveBootFrameRate, writeFrameRate,
} from './frameRateSetting';
import type { QualityStorage } from './qualitySetting';

function fakeStorage(seed: Record<string, string> = {}): QualityStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

/** What private browsing looks like from here. */
const hostileStorage: QualityStorage = {
  getItem() { throw new Error('denied'); },
  setItem() { throw new Error('denied'); },
  removeItem() { throw new Error('denied'); },
};

describe('the saved value', () => {
  it('reads back what was written', () => {
    const store = fakeStorage();
    writeFrameRate('30', store);
    expect(store.map.get(FRAME_RATE_STORAGE_KEY)).toBe('30');
    expect(readFrameRate(store)).toBe('30');
    clearFrameRate(store);
    expect(readFrameRate(store)).toBeNull();
  });

  it('refuses a value this build does not offer', () => {
    expect(readFrameRate(fakeStorage({ [FRAME_RATE_STORAGE_KEY]: '90' }))).toBeNull();
    expect(readFrameRate(fakeStorage({ [FRAME_RATE_STORAGE_KEY]: 'panel' }))).toBeNull();
    expect(readFrameRate(fakeStorage({ [FRAME_RATE_STORAGE_KEY]: ' SCREEN ' }))).toBe('screen');
  });

  it('survives a storage that throws, because a preference is not worth a boot', () => {
    expect(readFrameRate(hostileStorage)).toBeNull();
    expect(() => writeFrameRate('60', hostileStorage)).not.toThrow();
    expect(() => clearFrameRate(hostileStorage)).not.toThrow();
  });
});

describe('precedence', () => {
  it('is URL, then saved, then Screen', () => {
    const saved = fakeStorage({ [FRAME_RATE_STORAGE_KEY]: '30' });
    expect(resolveBootFrameRate('?fps=120', saved)).toBe('120');
    expect(resolveBootFrameRate('', saved)).toBe('30');
    expect(resolveBootFrameRate('', fakeStorage())).toBe(DEFAULT_FRAME_RATE);
    expect(DEFAULT_FRAME_RATE).toBe('screen');
  });

  it('takes ?fps= on any build, and ignores a word it does not know', () => {
    expect(parseFrameRateParam('?fps=screen')).toBe('screen');
    expect(parseFrameRateParam('?fps=30')).toBe('30');
    expect(parseFrameRateParam('?fps=')).toBeNull();
    expect(parseFrameRateParam('?fps=45')).toBeNull();
    expect(parseFrameRateParam('?quality=low')).toBeNull();
  });
});

describe('the row', () => {
  it('cycles Screen, 30, 60, 120 and back', () => {
    expect(FRAME_RATES).toEqual(['screen', '30', '60', '120']);
    let rate = DEFAULT_FRAME_RATE;
    const seen = FRAME_RATES.map(() => {
      rate = nextFrameRate(rate);
      return rate;
    });
    expect(seen).toEqual(['30', '60', '120', 'screen']);
  });

  it('labels every value in the panel\'s plain voice', () => {
    expect(FRAME_RATES.map((r) => FRAME_RATE_LABELS[r])).toEqual(['Screen', '30 fps', '60 fps', '120 fps']);
  });

  it('asks for the interval each value means, with Screen asking for 60', () => {
    expect(requestedMsFor('screen')).toBeCloseTo(1000 / 60, 9);
    expect(requestedMsFor('30')).toBeCloseTo(1000 / 30, 9);
    expect(requestedMsFor('60')).toBeCloseTo(1000 / 60, 9);
    expect(requestedMsFor('120')).toBeCloseTo(1000 / 120, 9);
    expect(isScreenRate('screen')).toBe(true);
    expect(FRAME_RATES.filter((r) => r !== 'screen').every((r) => !isScreenRate(r))).toBe(true);
  });
});
