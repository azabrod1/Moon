import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOOK, LOOKS, RETRO_STORAGE_KEY, lookSetting, parseRetroParam, resolveBootLook } from './retroSetting';
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

const hostileStorage: QualityStorage = {
  getItem() { throw new Error('denied'); },
  setItem() { throw new Error('denied'); },
  removeItem() { throw new Error('denied'); },
};

describe('the saved look', () => {
  it('reads back what was written, on its own key', () => {
    const store = fakeStorage();
    expect(lookSetting.write('retro', store)).toBe(true);
    expect(store.map.get(RETRO_STORAGE_KEY)).toBe('retro');
    expect(lookSetting.read(store)).toBe('retro');
    lookSetting.clear(store);
    expect(lookSetting.read(store)).toBeNull();
  });

  it('refuses a word this build does not offer, and survives a storage that throws', () => {
    expect(lookSetting.read(fakeStorage({ [RETRO_STORAGE_KEY]: 'vga' }))).toBeNull();
    expect(lookSetting.read(hostileStorage)).toBeNull();
    expect(lookSetting.write('retro', hostileStorage)).toBe(false);
  });
});

describe('precedence', () => {
  it('is URL, then saved, then Modern', () => {
    const saved = fakeStorage({ [RETRO_STORAGE_KEY]: 'retro' });
    expect(resolveBootLook('?retro=0', saved)).toBe('modern');
    expect(resolveBootLook('', saved)).toBe('retro');
    expect(resolveBootLook('', fakeStorage())).toBe(DEFAULT_LOOK);
    expect(DEFAULT_LOOK).toBe('modern');
    expect(LOOKS).toEqual(['modern', 'retro']);
  });

  it('takes the usual spellings of ?retro= and ignores the rest', () => {
    for (const word of ['1', 'on', 'retro', 'ON', '']) expect(parseRetroParam(`?retro=${word}`)).toBe('retro');
    for (const word of ['0', 'off', 'modern']) expect(parseRetroParam(`?retro=${word}`)).toBe('modern');
    expect(parseRetroParam('?retro=vga')).toBeNull();
    expect(parseRetroParam('?quality=low')).toBeNull();
  });
});

describe('the boot script in index.html', () => {
  // The page puts the class on <html> before main runs, so it must read the
  // same key and give the URL the same precedence, or the first paint and the
  // renderer would disagree about the look.
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const head = html.slice(0, html.indexOf('</head>'));

  it('reads the same key and the same URL switch', () => {
    expect(head).toContain(`'${RETRO_STORAGE_KEY}'`);
    expect(head).toContain(".get('retro')");
    expect(head).toContain("classList.add('retro')");
  });

  it('decides exactly as resolveBootLook does, for every URL and saved word', () => {
    const scriptText = [...head.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).find((text) => text.includes('retro'));
    expect(scriptText).toBeDefined();
    const run = (search: string, saved: string | null) => {
      const classes = new Set<string>();
      const document = { documentElement: { classList: { add: (name: string) => classes.add(name) } } };
      const localStorage = { getItem: (key: string) => (key === RETRO_STORAGE_KEY ? saved : null) };
      new Function('location', 'document', 'localStorage', scriptText!)({ search }, document, localStorage);
      return classes.has('retro') ? 'retro' : 'modern';
    };
    for (const search of ['', '?retro=1', '?retro=on', '?retro=', '?retro=0', '?retro=modern', '?retro=vga', '?quality=low']) {
      for (const saved of [null, 'retro', 'modern', 'junk']) {
        const store = fakeStorage(saved === null ? {} : { [RETRO_STORAGE_KEY]: saved });
        expect(run(search, saved), `${search} with ${saved}`).toBe(resolveBootLook(search, store));
      }
    }
  });
});
