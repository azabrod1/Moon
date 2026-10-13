import { describe, expect, it } from 'vitest';
import { booleanCodec, enumCodec, numberCodec, storedSetting } from './storedSetting';
import type { QualityStorage } from './qualitySetting';

function fakeStorage(seed: Record<string, string> = {}): QualityStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { map.delete(key); },
  };
}

/** What private browsing looks like from here. */
const hostileStorage: QualityStorage = {
  getItem() { throw new Error('denied'); },
  setItem() { throw new Error('denied'); },
  removeItem() { throw new Error('denied'); },
};

describe('a stored setting', () => {
  const flag = storedSetting('test-flag', booleanCodec);

  it('reads back what it wrote, on its own key, and reports the write', () => {
    const store = fakeStorage();
    expect(flag.read(store)).toBeNull();
    expect(flag.write(false, store)).toBe(true);
    expect(store.map.get('test-flag')).toBe('false');
    expect(flag.read(store)).toBe(false);
    flag.clear(store);
    expect(flag.read(store)).toBeNull();
  });

  it('refuses a value its codec does not offer', () => {
    expect(flag.read(fakeStorage({ 'test-flag': 'yes' }))).toBeNull();
    expect(flag.read(fakeStorage({ 'test-flag': '' }))).toBeNull();
    expect(flag.read(fakeStorage({ 'test-flag': ' TRUE ' }))).toBe(true);
  });

  it('survives a storage that throws, and says the write did not land', () => {
    expect(flag.read(hostileStorage)).toBeNull();
    expect(flag.write(true, hostileStorage)).toBe(false);
    expect(() => flag.clear(hostileStorage)).not.toThrow();
  });
});

describe('the codecs', () => {
  it('enum: one of the words, whatever the case', () => {
    const mode = storedSetting('test-mode', enumCodec(['hover', 'always'] as const));
    expect(mode.read(fakeStorage({ 'test-mode': 'Always' }))).toBe('always');
    expect(mode.read(fakeStorage({ 'test-mode': 'sometimes' }))).toBeNull();
    const store = fakeStorage();
    mode.write('hover', store);
    expect(store.map.get('test-mode')).toBe('hover');
  });

  it('number: finite, and held inside the bounds the caller gives', () => {
    const size = storedSetting('test-size', numberCodec((value) => Math.max(0.5, Math.min(2, value))));
    expect(size.read(fakeStorage({ 'test-size': '1.25' }))).toBe(1.25);
    expect(size.read(fakeStorage({ 'test-size': '40' }))).toBe(2);
    expect(size.read(fakeStorage({ 'test-size': 'big' }))).toBeNull();
    expect(size.read(fakeStorage({ 'test-size': 'Infinity' }))).toBeNull();
    const store = fakeStorage();
    size.write(0.75, store);
    expect(store.map.get('test-size')).toBe('0.75');
  });
});
