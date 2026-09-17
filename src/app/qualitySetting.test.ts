import { describe, expect, it } from 'vitest';
import {
  clearPending,
  clearQualityLevel,
  markPending,
  pendingAtBoot,
  QUALITY_PENDING_KEY,
  QUALITY_STORAGE_KEY,
  readQualityLevel,
  writeQualityLevel,
  type QualityStorage,
} from './qualitySetting';

/** A localStorage the test can look inside. */
class FakeStorage implements QualityStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

/** What private browsing looks like from here. */
const THROWING: QualityStorage = {
  getItem() {
    throw new DOMException('denied');
  },
  setItem() {
    throw new DOMException('denied');
  },
  removeItem() {
    throw new DOMException('denied');
  },
};

describe('the saved level', () => {
  it('round-trips under one standalone key', () => {
    const store = new FakeStorage();
    expect(readQualityLevel(store)).toBeNull();
    writeQualityLevel('high', store);
    expect(store.items.get(QUALITY_STORAGE_KEY)).toBe('high');
    expect(store.items.size).toBe(1);
    expect(readQualityLevel(store)).toBe('high');
    writeQualityLevel('dynamic', store);
    expect(readQualityLevel(store)).toBe('dynamic');
    clearQualityLevel(store);
    expect(readQualityLevel(store)).toBeNull();
  });

  it('reads a value another build could have written as nothing at all', () => {
    const store = new FakeStorage();
    for (const written of ['', 'ultra', 'LOW ', '1', '{"level":"low"}']) {
      store.items.set(QUALITY_STORAGE_KEY, written);
      const level = readQualityLevel(store);
      expect(level === null || level === 'low').toBe(true);
    }
    store.items.set(QUALITY_STORAGE_KEY, 'ultra');
    expect(readQualityLevel(store)).toBeNull();
    store.items.set(QUALITY_STORAGE_KEY, ' Medium ');
    expect(readQualityLevel(store)).toBe('medium');
  });

  it('survives a storage that refuses every call', () => {
    expect(() => writeQualityLevel('low', THROWING)).not.toThrow();
    expect(readQualityLevel(THROWING)).toBeNull();
    expect(() => clearQualityLevel(THROWING)).not.toThrow();
    expect(() => markPending('low', THROWING)).not.toThrow();
    expect(pendingAtBoot(THROWING)).toBeNull();
    expect(() => clearPending(THROWING)).not.toThrow();
  });

  it('touches no storage of its own accord when there is none', () => {
    expect(() => readQualityLevel()).not.toThrow();
    expect(() => pendingAtBoot()).not.toThrow();
  });
});

describe('the boot-loop marker', () => {
  it('names the level a boot was applying, and forgets it once a frame is live', () => {
    const store = new FakeStorage();
    expect(pendingAtBoot(store)).toBeNull();
    markPending('high', store);
    expect(store.items.get(QUALITY_PENDING_KEY)).toBe('high');
    expect(pendingAtBoot(store)).toBe('high');
    clearPending(store);
    expect(pendingAtBoot(store)).toBeNull();
    // The saved level itself is untouched by either.
    expect(store.items.has(QUALITY_STORAGE_KEY)).toBe(false);
  });

  it('is what a boot that never reached a frame leaves behind', () => {
    const store = new FakeStorage();
    writeQualityLevel('high', store);
    // A boot applies the saved level and dies before markLive.
    markPending(readQualityLevel(store) ?? 'medium', store);
    // The next boot finds it, and knows what to refuse.
    expect(pendingAtBoot(store)).toBe('high');
    expect(readQualityLevel(store)).toBe('high');
  });

  it('keeps the two keys apart', () => {
    const store = new FakeStorage();
    writeQualityLevel('low', store);
    markPending('high', store);
    expect(readQualityLevel(store)).toBe('low');
    expect(pendingAtBoot(store)).toBe('high');
    clearPending(store);
    expect(readQualityLevel(store)).toBe('low');
    expect(QUALITY_PENDING_KEY).not.toBe(QUALITY_STORAGE_KEY);
  });
});
