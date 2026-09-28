import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NIGHT_SIDES, NIGHT_SIDES, NIGHT_SIDES_LABELS, NIGHT_SIDES_NOTES, NIGHT_SIDES_STORAGE_KEY,
  clearNightSides, nightSidesSummary, parseNightSidesParam, readNightSides, resolveBootNightSides,
  writeNightSides,
} from './nightSidesSetting';
import { FRAME_RATE_STORAGE_KEY } from './frameRateSetting';
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
  it('reads back what was written, on a key of its own', () => {
    const store = fakeStorage();
    writeNightSides('brightened', store);
    expect(store.map.get(NIGHT_SIDES_STORAGE_KEY)).toBe('brightened');
    expect(readNightSides(store)).toBe('brightened');
    clearNightSides(store);
    expect(readNightSides(store)).toBeNull();
    // Not the journey save and not another setting's key: New Journey clears
    // the journey, and the Graphics page's keys are theirs.
    expect(NIGHT_SIDES_STORAGE_KEY).toBe('planetarium-night-sides');
    expect(NIGHT_SIDES_STORAGE_KEY).not.toBe(FRAME_RATE_STORAGE_KEY);
  });

  it('refuses a value this build does not offer', () => {
    expect(readNightSides(fakeStorage({ [NIGHT_SIDES_STORAGE_KEY]: 'flood' }))).toBeNull();
    expect(readNightSides(fakeStorage({ [NIGHT_SIDES_STORAGE_KEY]: '' }))).toBeNull();
    expect(readNightSides(fakeStorage({ [NIGHT_SIDES_STORAGE_KEY]: ' Brightened ' }))).toBe('brightened');
  });

  it('survives a storage that throws, because a preference is not worth a boot', () => {
    expect(readNightSides(hostileStorage)).toBeNull();
    expect(() => writeNightSides('real', hostileStorage)).not.toThrow();
    expect(() => clearNightSides(hostileStorage)).not.toThrow();
    expect(resolveBootNightSides('', hostileStorage)).toBe('real');
  });
});

describe('precedence', () => {
  it('is URL, then saved, then Real', () => {
    const saved = fakeStorage({ [NIGHT_SIDES_STORAGE_KEY]: 'brightened' });
    expect(resolveBootNightSides('?nightsides=real', saved)).toBe('real');
    expect(resolveBootNightSides('', saved)).toBe('brightened');
    expect(resolveBootNightSides('', fakeStorage())).toBe(DEFAULT_NIGHT_SIDES);
    expect(DEFAULT_NIGHT_SIDES).toBe('real');
  });

  it('takes ?nightsides= on any build, and ignores a word it does not know', () => {
    expect(parseNightSidesParam('?nightsides=real')).toBe('real');
    expect(parseNightSidesParam('?auto=planetarium&nightsides=brightened')).toBe('brightened');
    expect(parseNightSidesParam('?nightsides=BRIGHTENED')).toBe('brightened');
    expect(parseNightSidesParam('?nightsides=')).toBeNull();
    expect(parseNightSidesParam('?nightsides=flood')).toBeNull();
    expect(parseNightSidesParam('?fps=30')).toBeNull();
  });
});

describe('the Night sides control', () => {
  it('offers Real and Brightened, in that order, with Real the default', () => {
    expect(NIGHT_SIDES).toEqual(['real', 'brightened']);
    expect(NIGHT_SIDES.map((m) => NIGHT_SIDES_LABELS[m])).toEqual(['Real', 'Brightened']);
  });

  it('says what each value does in a line of its own', () => {
    for (const mode of NIGHT_SIDES) {
      const note = NIGHT_SIDES_NOTES[mode];
      expect(note.length, mode).toBeGreaterThan(0);
      expect(note.endsWith('.'), mode).toBe(true);
    }
    // Brightened says out loud that it is not the real sky.
    expect(NIGHT_SIDES_NOTES.brightened).toContain('Brighter than it really is');
  });

  it('names what the value is about on the root row', () => {
    expect(nightSidesSummary('real')).toBe('Real nights');
    expect(nightSidesSummary('brightened')).toBe('Brightened nights');
  });
});
