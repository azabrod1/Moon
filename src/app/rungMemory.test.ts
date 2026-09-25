import { describe, expect, it } from 'vitest';
import {
  RUNG_MEMORY_KEY,
  RUNG_MEMORY_MAX_AGE_MS,
  RUNG_MEMORY_VERSION,
  RungMemoryMirror,
  clearRungMemory,
  readRungMemory,
  rungMemoryApplies,
  rungMemoryUrlBlock,
  writeRungMemory,
  type RungMemoryConfig,
  type RungMemoryEntry,
  type RungMemoryFacts,
  type RungMemorySource,
  type RungMemoryStorage,
} from './rungMemory';
import type { SeedOutcome } from './resolutionController';

/** A localStorage the test can look inside, counting what is written. */
class FakeStorage implements RungMemoryStorage {
  readonly items = new Map<string, string>();
  sets = 0;
  removes = 0;
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.sets++;
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.removes++;
    this.items.delete(key);
  }
  stored(): RungMemoryEntry | null {
    const raw = this.items.get(RUNG_MEMORY_KEY);
    return raw === undefined ? null : (JSON.parse(raw) as RungMemoryEntry);
  }
}

/** What private browsing looks like from here. */
const THROWING: RungMemoryStorage = {
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

const NOW = Date.UTC(2026, 8, 25, 12);
const LADDER = [2 / 1.33, 2 / 1.15, 2, 2.5, 3];

/** This project's Mac at 1280×800 in WebKit, as a boot finds it. */
const CONFIG: RungMemoryConfig = {
  tick: 16.67,
  outputRatio: 2,
  pixels: 1280 * 800 * 4,
  renderer: 'Apple GPU',
};

const FACTS: RungMemoryFacts = { ...CONFIG, nowMs: NOW, ladder: LADDER, mediumIndex: 2 };

function entry(over: Partial<RungMemoryEntry> = {}): RungMemoryEntry {
  return { v: RUNG_MEMORY_VERSION, ratio: 3, ...CONFIG, at: NOW - 60_000, trial: false, ...over };
}

describe('whether a stored rung applies to this boot', () => {
  it('applies where everything matches', () => {
    expect(rungMemoryApplies(entry(), FACTS)).toEqual({ ok: true });
    expect(rungMemoryApplies(entry({ ratio: 2.5 }), FACTS)).toEqual({ ok: true });
  });

  it('deletes what is wrong for every boot: another version, too old, dated ahead, still on trial', () => {
    const cases: Partial<RungMemoryEntry>[] = [
      { v: 2 },
      { at: NOW - RUNG_MEMORY_MAX_AGE_MS - 1 },
      { at: NOW + 25 * 60 * 60 * 1000 },
      { trial: true },
    ];
    for (const over of cases) {
      const verdict = rungMemoryApplies(entry(over), FACTS);
      expect(verdict.ok).toBe(false);
      expect(verdict.ok === false && verdict.discard).toBe(true);
    }
    // Thirty days to the millisecond is still in time, and a clock a few
    // hours fast is still a clock.
    expect(rungMemoryApplies(entry({ at: NOW - RUNG_MEMORY_MAX_AGE_MS }), FACTS).ok).toBe(true);
    expect(rungMemoryApplies(entry({ at: NOW + 3 * 60 * 60 * 1000 }), FACTS).ok).toBe(true);
  });

  it('keeps what is wrong only for this configuration: another GPU, pixel ratio or refresh, a larger window, a ladder without the rung', () => {
    const cases: [Partial<RungMemoryEntry>, Partial<RungMemoryFacts>][] = [
      [{}, { renderer: 'AMD Radeon Pro' }],
      [{}, { outputRatio: 1 }],
      [{}, { tick: 1000 / 120 }],
      [{}, { tick: 1000 / 30 }],
      [{}, { tick: 16.67 * 1.06 }],
      [{}, { pixels: CONFIG.pixels * 1.06 }],
      [{ ratio: 2.75 }, {}],
      [{}, { ladder: [1.5, 1.74, 2, 2.5] }],
    ];
    for (const [over, facts] of cases) {
      const verdict = rungMemoryApplies(entry(over), { ...FACTS, ...facts });
      expect(verdict.ok).toBe(false);
      expect(verdict.ok === false && verdict.discard).toBe(false);
    }
  });

  it('allows a tick inside 5 % and a canvas up to 5 % larger, and any smaller one', () => {
    expect(rungMemoryApplies(entry(), { ...FACTS, tick: 16.67 * 1.04 }).ok).toBe(true);
    expect(rungMemoryApplies(entry(), { ...FACTS, tick: 16.67 * 0.96 }).ok).toBe(true);
    expect(rungMemoryApplies(entry(), { ...FACTS, pixels: CONFIG.pixels * 1.049 }).ok).toBe(true);
    expect(rungMemoryApplies(entry(), { ...FACTS, pixels: CONFIG.pixels * 0.5 }).ok).toBe(true);
  });

  it('refuses a ratio at or below Medium, which is nothing to climb to', () => {
    for (const ratio of [2, 2 / 1.15]) {
      const verdict = rungMemoryApplies(entry({ ratio }), FACTS);
      expect(verdict).toMatchObject({ ok: false, discard: false });
    }
  });
});

describe('the stored entry', () => {
  it('round-trips under one standalone key', () => {
    const store = new FakeStorage();
    expect(readRungMemory(store)).toEqual({ entry: null, malformed: false });
    expect(writeRungMemory(entry(), store)).toBe(true);
    expect([...store.items.keys()]).toEqual([RUNG_MEMORY_KEY]);
    expect(readRungMemory(store)).toEqual({ entry: entry(), malformed: false });
    clearRungMemory(store);
    expect(readRungMemory(store).entry).toBeNull();
  });

  it('reads anything that is not an entry as nothing, and says it was there', () => {
    const store = new FakeStorage();
    const good = JSON.parse(JSON.stringify(entry())) as Record<string, unknown>;
    const bad: string[] = [
      '',
      'nope',
      '3',
      '[]',
      'null',
      JSON.stringify({ ...good, ratio: '3' }),
      JSON.stringify({ ...good, ratio: null }),
      JSON.stringify({ ...good, ratio: -3 }),
      JSON.stringify({ ...good, ratio: 0 }),
      JSON.stringify({ ...good, tick: null }),
      JSON.stringify({ ...good, pixels: 'many' }),
      JSON.stringify({ ...good, at: undefined }),
      JSON.stringify({ ...good, outputRatio: 1e400 }),
      JSON.stringify({ ...good, renderer: 7 }),
      JSON.stringify({ ...good, trial: 'false' }),
      '{"v":1,"ratio":NaN}',
    ];
    for (const raw of bad) {
      store.items.set(RUNG_MEMORY_KEY, raw);
      expect(readRungMemory(store)).toEqual({ entry: null, malformed: true });
    }
  });

  it('never writes a number it could not read back', () => {
    const store = new FakeStorage();
    for (const over of [{ ratio: NaN }, { tick: Infinity }, { pixels: -1 }, { at: 0 }, { outputRatio: NaN }]) {
      expect(writeRungMemory(entry(over), store)).toBe(false);
    }
    expect(store.sets).toBe(0);
  });

  it('survives a store that throws on every call', () => {
    expect(readRungMemory(THROWING)).toEqual({ entry: null, malformed: false });
    expect(writeRungMemory(entry(), THROWING)).toBe(false);
    expect(() => clearRungMemory(THROWING)).not.toThrow();
  });
});

/** The controller as the mirror sees it. */
class Source implements RungMemorySource {
  memoryVersion = 0;
  memory: { ratio: number } | null = null;
  seedOutcome: SeedOutcome | null = null;
  hold(ratio: number | null): void {
    this.memory = ratio === null ? null : { ratio };
    this.memoryVersion++;
  }
  outcome(outcome: SeedOutcome): void {
    this.seedOutcome = outcome;
    this.memoryVersion++;
  }
}

describe('the mirror', () => {
  const config = (): RungMemoryConfig => CONFIG;

  it('writes nothing over ten thousand frames in which nothing moved', () => {
    const store = new FakeStorage();
    const mirror = new RungMemoryMirror(store);
    const source = new Source();
    for (let i = 0; i < 10_000; i++) mirror.sync(source, config, NOW + i);
    expect(store.sets).toBe(0);
    source.hold(3);
    for (let i = 0; i < 10_000; i++) mirror.sync(source, config, NOW + i);
    expect(store.sets).toBe(1);
    expect(store.removes).toBe(0);
  });

  it('writes the session’s first held rung even when it equals what is stored, so the date follows the device', () => {
    const store = new FakeStorage();
    writeRungMemory(entry({ at: NOW - 20 * 24 * 60 * 60 * 1000 }), store);
    const sets = store.sets;
    const mirror = new RungMemoryMirror(store);
    const source = new Source();
    source.hold(3);
    expect(mirror.sync(source, config, NOW)).toEqual({ wrote: 3 });
    expect(store.sets).toBe(sets + 1);
    expect(store.stored()).toEqual(entry({ at: NOW }));
  });

  it('then writes only a change against its own last write, never an equal hold after an epoch', () => {
    const store = new FakeStorage();
    const mirror = new RungMemoryMirror(store);
    const source = new Source();
    source.hold(3);
    mirror.sync(source, config, NOW);
    source.hold(null);
    expect(mirror.sync(source, config, NOW + 1)).toBeNull();
    source.hold(3);
    expect(mirror.sync(source, config, NOW + 2)).toBeNull();
    expect(store.sets).toBe(1);
    // A cleared memory deletes nothing.
    expect(store.stored()?.ratio).toBe(3);
    source.hold(2.5);
    expect(mirror.sync(source, config, NOW + 3)).toEqual({ wrote: 2.5 });
    expect(store.stored()?.ratio).toBe(2.5);
    expect(store.sets).toBe(2);
  });

  it('marks the trial when the remembered climb is applied, and clears it once the rung has held its minute', () => {
    const store = new FakeStorage();
    writeRungMemory(entry(), store);
    const mirror = new RungMemoryMirror(store);
    const source = new Source();
    source.outcome('armed');
    mirror.sync(source, config, NOW);
    source.outcome('applied');
    expect(mirror.markTrial(entry())).toBe(true);
    mirror.sync(source, config, NOW);
    expect(store.stored()?.trial).toBe(true);
    expect(mirror.onTrial).toBe(true);
    // Held: the memory and the outcome move in the same step.
    source.hold(3);
    source.outcome('passed');
    expect(mirror.sync(source, config, NOW + 61_000)).toEqual({ wrote: 3 });
    expect(store.stored()).toEqual(entry({ at: NOW + 61_000 }));
    expect(mirror.onTrial).toBe(false);
  });

  it('clears the trial on a pass even where the memory did not move', () => {
    const store = new FakeStorage();
    const mirror = new RungMemoryMirror(store);
    const source = new Source();
    source.hold(3);
    mirror.sync(source, config, NOW);
    mirror.markTrial(entry());
    source.outcome('passed');
    expect(mirror.sync(source, config, NOW + 1)).toBe('passed');
    expect(store.stored()).toEqual(entry());
  });

  it('deletes the entry when the remembered rung failed by measurement', () => {
    const store = new FakeStorage();
    writeRungMemory(entry(), store);
    const mirror = new RungMemoryMirror(store);
    const source = new Source();
    mirror.markTrial(entry());
    source.outcome('applied');
    mirror.sync(source, config, NOW);
    source.outcome('dropped');
    expect(mirror.sync(source, config, NOW + 5000)).toBe('dropped');
    expect(store.stored()).toBeNull();
    expect(mirror.onTrial).toBe(false);
    // A clean unload after it writes nothing back.
    const sets = store.sets;
    mirror.hide(source, config, NOW + 9000);
    expect(store.sets).toBe(sets);
    expect(store.stored()).toBeNull();
  });

  it('keeps the entry, on trial, through a trial abandoned with no verdict, and pagehide clears only the flag', () => {
    const store = new FakeStorage();
    writeRungMemory(entry(), store);
    const mirror = new RungMemoryMirror(store);
    const source = new Source();
    mirror.markTrial(entry());
    source.outcome('applied');
    mirror.sync(source, config, NOW);
    source.outcome('abandoned');
    expect(mirror.sync(source, config, NOW + 5000)).toBeNull();
    expect(store.stored()?.trial).toBe(true);
    mirror.hide(source, config, NOW + 9000);
    expect(store.stored()).toEqual(entry());
  });

  it('deletes at pagehide a drop the page did not live to sync, rather than saving it off trial', () => {
    const store = new FakeStorage();
    writeRungMemory(entry(), store);
    const mirror = new RungMemoryMirror(store);
    const source = new Source();
    mirror.markTrial(entry());
    source.outcome('applied');
    mirror.sync(source, config, NOW);
    // The hand-back, and the page goes before its next frame.
    source.outcome('dropped');
    mirror.hide(source, config, NOW + 5000);
    expect(store.stored()).toBeNull();
  });

  it('writes nothing on pagehide with no trial standing', () => {
    const store = new FakeStorage();
    writeRungMemory(entry(), store);
    const sets = store.sets;
    const mirror = new RungMemoryMirror(store);
    const source = new Source();
    mirror.hide(source, config, NOW + 9000);
    expect(store.sets).toBe(sets);
  });

  it('a store that throws during the trial write says so and breaks nothing', () => {
    const mirror = new RungMemoryMirror(THROWING);
    const source = new Source();
    expect(mirror.markTrial(entry())).toBe(false);
    source.hold(3);
    source.outcome('passed');
    expect(() => mirror.sync(source, config, NOW)).not.toThrow();
    expect(() => mirror.hide(source, config, NOW)).not.toThrow();
  });

  it('forget deletes the entry and writes nothing until the memory moves — then even a ratio written before', () => {
    const store = new FakeStorage();
    const mirror = new RungMemoryMirror(store);
    const source = new Source();
    source.hold(3);
    mirror.sync(source, config, NOW);
    mirror.forget(source);
    expect(store.stored()).toBeNull();
    for (let i = 0; i < 100; i++) mirror.sync(source, config, NOW + i);
    expect(store.stored()).toBeNull();
    source.hold(null);
    mirror.sync(source, config, NOW + 200);
    source.hold(3);
    mirror.sync(source, config, NOW + 300);
    expect(store.stored()?.ratio).toBe(3);
  });
});

describe('a page that stops drawing, and one whose context is lost', () => {
  const config = (): RungMemoryConfig => CONFIG;

  /** An entry stored, told this boot, climbed to and marked on trial. */
  const onTrial = () => {
    const store = new FakeStorage();
    writeRungMemory(entry(), store);
    const mirror = new RungMemoryMirror(store);
    const source = new Source();
    source.outcome('armed');
    mirror.sync(source, config, NOW);
    source.outcome('applied');
    mirror.markTrial(entry());
    mirror.sync(source, config, NOW + 1);
    expect(store.stored()?.trial).toBe(true);
    return { store, mirror, source };
  };

  it('a hidden page lifts the flag and a shown one marks it again while the trial stands', () => {
    const { store, mirror, source } = onTrial();
    mirror.hide(source, config, NOW + 2);
    expect(store.stored()).toEqual(entry());
    expect(mirror.onTrial).toBe(false);
    expect(mirror.shown(source)).toBe(true);
    expect(store.stored()).toEqual(entry({ trial: true }));
    // Twice over, as a tab is switched away from and back to.
    mirror.hide(source, config, NOW + 3);
    expect(store.stored()?.trial).toBe(false);
    expect(mirror.shown(source)).toBe(true);
    expect(store.stored()?.trial).toBe(true);
  });

  it('a page restored from the back-forward cache after its pagehide is marked again too', () => {
    const { store, mirror, source } = onTrial();
    mirror.hide(source, config, NOW + 2);
    expect(store.stored()?.trial).toBe(false);
    expect(mirror.shown(source)).toBe(true);
    expect(store.stored()?.trial).toBe(true);
  });

  it('a page shown once the trial is over is not marked', () => {
    for (const end of ['passed', 'abandoned'] as const) {
      const { store, mirror, source } = onTrial();
      mirror.hide(source, config, NOW + 2);
      source.outcome(end);
      const sets = store.sets;
      expect(mirror.shown(source)).toBe(false);
      expect(store.sets).toBe(sets);
      expect(store.stored()?.trial).toBe(false);
    }
  });

  it('a page shown with no trial ever marked writes nothing', () => {
    const store = new FakeStorage();
    writeRungMemory(entry(), store);
    const sets = store.sets;
    const mirror = new RungMemoryMirror(store);
    const source = new Source();
    source.outcome('applied');
    mirror.hide(source, config, NOW);
    expect(mirror.shown(source)).toBe(false);
    expect(store.sets).toBe(sets);
  });

  it('the context lost with the page visible and the trial standing deletes the entry, and nothing is written after', () => {
    const { store, mirror, source } = onTrial();
    expect(mirror.lostAtRung(true)).toBe('deleted');
    expect(store.stored()).toBeNull();
    const sets = store.sets;
    // What follows on a dead canvas — the rung restored, a later hold, the
    // tab hidden, shown and unloaded — writes nothing back.
    source.outcome('abandoned');
    source.hold(3);
    mirror.sync(source, config, NOW + 10);
    mirror.hide(source, config, NOW + 11);
    mirror.shown(source);
    mirror.hide(source, config, NOW + 12);
    expect(store.sets).toBe(sets);
    expect(store.stored()).toBeNull();
    expect(mirror.isStopped).toBe(true);
  });

  it('the context lost with the page hidden keeps the entry: that is the system reclaiming a background tab', () => {
    const { store, mirror, source } = onTrial();
    mirror.hide(source, config, NOW + 2);
    expect(mirror.lostAtRung(false)).toBe('kept');
    expect(store.stored()).toEqual(entry());
    expect(mirror.isStopped).toBe(false);
  });

  it('a hang: the stall read as silence ended the trial with no verdict before the loss arrived — the standing flag still deletes the entry', () => {
    // The controller ends the trial 'abandoned' on the first frame after the
    // stall — 'unverified' inside the check, a gap in the held minute — and
    // the loss is dispatched after that frame. Either way the flag stands.
    for (const why of ['a gap', 'unverified']) {
      const { store, mirror, source } = onTrial();
      source.outcome('abandoned');
      mirror.sync(source, config, NOW + 4000);
      expect(store.stored()?.trial, why).toBe(true);
      expect(mirror.lostAtRung(true), why).toBe('deleted');
      expect(store.stored(), why).toBeNull();
    }
  });

  it('the same stall and loss with the page hidden keeps the entry', () => {
    const { store, mirror, source } = onTrial();
    source.outcome('abandoned');
    mirror.sync(source, config, NOW + 4000);
    mirror.hide(source, config, NOW + 4001);
    expect(mirror.lostAtRung(false)).toBe('kept');
    expect(store.stored()).toEqual(entry());
  });

  it('the GPU clock priced off at the rung takes the same path: the flag standing, the page visible, the entry goes', () => {
    const { store, mirror, source } = onTrial();
    // The sensor's own verdict reaches the mirror before the controller
    // restores Medium for it.
    expect(mirror.lostAtRung(true)).toBe('deleted');
    expect(store.stored()).toBeNull();
    source.outcome('abandoned');
    mirror.sync(source, config, NOW + 10);
    mirror.hide(source, config, NOW + 11);
    expect(store.stored()).toBeNull();
  });

  it('a loss with no trial flag standing touches nothing — none marked, or one cleared by a pass, a drop or a hide', () => {
    for (const outcome of [null, 'armed', 'passed', 'abandoned', 'dropped'] as const) {
      const store = new FakeStorage();
      writeRungMemory(entry(), store);
      const mirror = new RungMemoryMirror(store);
      const source = new Source();
      if (outcome !== null) source.outcome(outcome);
      mirror.sync(source, config, NOW);
      const sets = store.sets;
      const removes = store.removes;
      expect(mirror.lostAtRung(true)).toBeNull();
      expect(store.sets).toBe(sets);
      expect(store.removes).toBe(removes);
    }
    const passed = onTrial();
    passed.source.hold(3);
    passed.source.outcome('passed');
    passed.mirror.sync(passed.source, config, NOW + 61_000);
    expect(passed.mirror.lostAtRung(true)).toBeNull();
    expect(passed.store.stored()).toEqual(entry({ at: NOW + 61_000 }));
    const hidden = onTrial();
    hidden.mirror.hide(hidden.source, config, NOW + 2);
    expect(hidden.mirror.lostAtRung(true)).toBeNull();
    expect(hidden.store.stored()).toEqual(entry());
  });

  it('stopped — synthetic samples were injected — nothing is written or deleted again, but forget still deletes', () => {
    const { store, mirror, source } = onTrial();
    mirror.stop();
    const sets = store.sets;
    source.outcome('dropped');
    mirror.sync(source, config, NOW + 5);
    source.hold(2.5);
    mirror.sync(source, config, NOW + 6);
    mirror.markTrial(entry());
    mirror.hide(source, config, NOW + 7);
    mirror.shown(source);
    expect(mirror.lostAtRung(true)).toBeNull();
    expect(store.sets).toBe(sets);
    expect(store.removes).toBe(0);
    expect(store.stored()?.trial).toBe(true);
    mirror.forget(source);
    expect(store.stored()).toBeNull();
  });
});

describe('what keeps the memory out of a boot', () => {
  it('the kill switch', () => {
    expect(rungMemoryUrlBlock('?rungmemory=0')).not.toBeNull();
    expect(rungMemoryUrlBlock('?rungmemory=1')).toBeNull();
  });

  it('a render-path switch or a measurement pin', () => {
    for (const q of ['?msaa=0', '?msaa=4', '?fused=0', '?alloc=0', '?canvasaa=1', '?perfoff=fused-final', '?ratio=3',
      '?refresh=120', '?envelope=512', '?upscale=1.5', '?sectors=0', '?synth=0', '?gpuclock=0']) {
      expect(rungMemoryUrlBlock(q)).not.toBeNull();
    }
  });

  it('a fixed level, but not Dynamic named outright', () => {
    for (const q of ['?quality=medium', '?quality=high', '?quality=low']) expect(rungMemoryUrlBlock(q)).not.toBeNull();
    expect(rungMemoryUrlBlock('?quality=dynamic')).toBeNull();
    expect(rungMemoryUrlBlock('?auto=planetarium&quality=dynamic&debug=1')).toBeNull();
    expect(rungMemoryUrlBlock('')).toBeNull();
  });
});
