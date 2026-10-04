import { describe, expect, it } from 'vitest';
import {
  CLOUD_PAGE_ADMIT_MARGIN,
  CLOUD_PAGE_DAY_EDGE,
  CLOUD_PAGE_DWELL_MS,
  CLOUD_PAGE_FADE_IN_MS,
  CLOUD_PAGE_FADE_OUT_MS,
  CLOUD_PAGE_KEEP_LIGHT_MARGIN,
  CLOUD_PAGE_LOAD_TIMEOUT_MS,
  CLOUD_PAGE_RETRY_MS,
  CloudFieldResidency,
  type CloudFieldFrame,
} from './cloudFieldResidency';
import { CloudFieldMeasure, type CloudPageDemand, type FieldCamera } from './cloudFieldMeasure';
import {
  CLOUD_FIELD_GRID, CLOUD_FIELD_LEVEL_WIDTH, CLOUD_FIELD_RELEASE_TEXELS, CLOUD_TABLE_SEE_PARENT,
} from './cloudField';
import {
  SECTOR_ADMIT_MARGIN,
  SECTOR_ATTEMPT_TIMEOUT_MS,
  SECTOR_EVICT_DWELL_MS,
  SECTOR_KEEP_LIGHT_MARGIN,
  SECTOR_NIGHT_DOT,
  SECTOR_RETRY_MS,
} from './sectorStreamer';
import { lensEffectiveStrength, lensOverscanFovDeg } from '../../shared/math/lensProjection';

const PAGES = CLOUD_FIELD_GRID[0] * CLOUD_FIELD_GRID[1];
/** The desktop's ratio: the 32k level over the 8K base. Want line ≈ 3.97. */
const DESKTOP_RATIO = CLOUD_FIELD_LEVEL_WIDTH / 8192;
const WANT = DESKTOP_RATIO;

/** A page's decoded stand-in: its index, so an upload says whose bytes went
 *  into which layer. */
interface Decoded { page: number }

interface PendingLoad {
  page: number;
  signal: AbortSignal;
  resolve: (d: Decoded) => void;
  reject: (e: unknown) => void;
}

/** Every dependency of the residency, faked, with a record of what it did. */
class World {
  readonly table = new Uint8Array(PAGES * 2);
  readonly loads: PendingLoad[] = [];
  readonly uploads: Array<{ page: number; layer: number; step: 0 | 1 }> = [];
  readonly warnings: string[] = [];
  /** When each page's entry was last written from absent to resident. */
  readonly publishedAt = new Map<number, number>();
  writes = 0;
  ticks = 0;
  sectorsBusy = false;
  readonly residency: CloudFieldResidency<Decoded>;
  readonly demand = new FakeDemand();
  readonly frame: CloudFieldFrame = {
    nowMs: 0, ratio: DESKTOP_RATIO, hidden: false, grounded: false, spinning: false, chart: false, veil: false,
  };

  constructor(layers: number) {
    this.residency = new CloudFieldResidency<Decoded>({
      layers,
      wantTexelPx: 1,
      load: (page, signal) => new Promise<Decoded>((resolve, reject) => {
        this.loads.push({ page, signal, resolve, reject });
      }),
      upload: (d, layer, step) => { this.uploads.push({ page: d.page, layer, step }); },
      writeEntry: (page, r, g) => {
        this.writes += 1;
        if (this.table[page * 2] === 0 && r > 0) this.publishedAt.set(page, this.frame.nowMs);
        this.table[page * 2] = r;
        this.table[page * 2 + 1] = g;
      },
      sectorsBusy: () => this.sectorsBusy,
      warn: (m) => { this.warnings.push(m); },
      // A counter, not a clock: the update's own cost is not under test here,
      // and a whole number reads without allocating.
      clock: () => ++this.ticks,
    });
  }

  /** One frame at `nowMs`: the update, an upload step if one is ready, and
   *  the deck drawn. */
  step(nowMs: number, opts: { upload?: boolean; drawn?: boolean } = {}): void {
    this.frame.nowMs = nowMs;
    this.residency.update(this.frame, this.demand, null);
    if (opts.upload ?? true) this.residency.uploadStep(nowMs);
    if (opts.drawn ?? true) this.residency.deckDrawn(nowMs);
  }

  /** Frames every 16 ms from `from` through `to`. */
  run(from: number, to: number, opts: { upload?: boolean; drawn?: boolean } = {}): void {
    for (let t = from; t <= to; t += 16) this.step(t, opts);
  }

  /** The last load asked for, resolved, and the microtasks it queued run. */
  async resolve(page: number): Promise<void> {
    const l = this.loads.filter((x) => x.page === page).at(-1)!;
    l.resolve({ page });
    await flush();
  }

  r(page: number): number { return this.table[page * 2]; }
  g(page: number): number { return this.table[page * 2 + 1]; }
  /** Pages with an entry, by layer. */
  resident(): number[] {
    const out: number[] = [];
    for (let p = 0; p < PAGES; p++) if (this.r(p) > 0) out.push(p);
    return out;
  }
}

/** A demand of plain arrays: every page out of frame until set. */
class FakeDemand implements CloudPageDemand {
  readonly wantTexels = new Float64Array(PAGES).fill(Number.POSITIVE_INFINITY);
  readonly keepTexels = new Float64Array(PAGES).fill(Number.POSITIVE_INFINITY);
  readonly centrality = new Float32Array(PAGES);
  readonly sunDot = new Float32Array(PAGES).fill(Number.NEGATIVE_INFINITY);
  /** A page displayed at `texels`. */
  set(page: number, texels: number, centrality = 0.5, sunDot = 1): void {
    this.wantTexels[page] = texels;
    this.keepTexels[page] = texels;
    this.centrality[page] = centrality;
    this.sunDot[page] = sunDot;
  }
  /** A page only in the frame's margin, at `texels`: kept, never wanted. */
  setMargin(page: number, texels: number, sunDot = 1): void {
    this.wantTexels[page] = Number.POSITIVE_INFINITY;
    this.keepTexels[page] = texels;
    this.centrality[page] = 0;
    this.sunDot[page] = sunDot;
  }
  clear(page: number): void { this.set(page, Number.POSITIVE_INFINITY, 0, Number.NEGATIVE_INFINITY); }
}

const ease = (p: number): number => p * p * (3 - 2 * p);

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

/** Put a page into the pool and settle it: loaded, uploaded, faded in, and
 *  drawn for longer than the dwell. Returns the time after. */
async function makeResident(w: World, page: number, t: number): Promise<number> {
  w.step(t);
  expect(w.residency.stats().pipePage).toBe(page);
  await w.resolve(page);
  w.run(t + 16, t + 16 * 3);
  expect(w.r(page)).toBeGreaterThan(0);
  const end = t + 16 * 3 + Math.max(CLOUD_PAGE_FADE_IN_MS, CLOUD_PAGE_DWELL_MS) + 32;
  w.run(t + 16 * 4, end);
  expect(w.g(page)).toBe(255);
  return end + 16;
}

describe('the residency\'s numbers', () => {
  it('are the sector streamer\'s where they mean the same thing', () => {
    expect(CLOUD_PAGE_ADMIT_MARGIN).toBe(SECTOR_ADMIT_MARGIN);
    expect(CLOUD_PAGE_DWELL_MS).toBe(SECTOR_EVICT_DWELL_MS);
    expect(CLOUD_PAGE_RETRY_MS).toBe(SECTOR_RETRY_MS);
    expect(CLOUD_PAGE_LOAD_TIMEOUT_MS).toBe(SECTOR_ATTEMPT_TIMEOUT_MS);
    expect(CLOUD_PAGE_DAY_EDGE).toBe(SECTOR_NIGHT_DOT);
    expect(CLOUD_PAGE_KEEP_LIGHT_MARGIN).toBe(SECTOR_KEEP_LIGHT_MARGIN);
  });
});

describe('the table', () => {
  it('names a layer as layer + 1, below the codes it reserves, and refuses a pool it could not name', () => {
    expect(() => new World(CLOUD_TABLE_SEE_PARENT - 1)).not.toThrow();
    expect(() => new World(CLOUD_TABLE_SEE_PARENT)).toThrow(/cannot be named/);
  });
});

describe('admission', () => {
  it('starts the strongest wanted page first, one at a time', () => {
    const w = new World(6);
    w.demand.set(10, 3);
    w.demand.set(11, 1.5);
    w.demand.set(12, 2, 1);
    w.step(0);
    // Scores: want / T × (0.5 + 0.5 c): 1.98, 3.97, 1.98.
    expect(w.loads.map((l) => l.page)).toEqual([11]);
    w.run(16, 500);
    expect(w.loads.length).toBe(1);
    expect(w.residency.stats()).toMatchObject({ wanted: 3, pipe: 'loading', pipePage: 11 });
  });

  it('wants a page only past the base\'s own resolution, by day, and never past the guard\'s zero', () => {
    const w = new World(6);
    w.demand.set(1, WANT * 1.01);
    w.demand.set(2, 1, 1, CLOUD_PAGE_DAY_EDGE - 0.01);
    w.run(0, 200);
    expect(w.loads).toEqual([]);
    // A phone's 4K base: the want line would be 7.94, held under the guard's 8.
    w.frame.ratio = CLOUD_FIELD_LEVEL_WIDTH / 4096;
    w.demand.set(1, 7.9);
    w.demand.set(3, 8.05);
    w.step(216);
    expect(w.loads.map((l) => l.page)).toEqual([1]);
    // No base width known: nothing is wanted.
    const v = new World(6);
    v.frame.ratio = 0;
    v.demand.set(4, 0.5);
    v.run(0, 100);
    expect(v.loads).toEqual([]);
  });

  it('wants a page only for what the frame displays, and keeps one the margin still holds', async () => {
    const w = new World(1);
    w.demand.setMargin(6, 1);
    w.run(0, 300);
    expect(w.loads).toEqual([]);
    // Displayed, it comes in; pushed out to the margin, it stays.
    w.demand.set(6, 2);
    const t = await makeResident(w, 6, 316);
    w.demand.setMargin(6, 2);
    w.run(t, t + 3000);
    expect([w.r(6), w.g(6)]).toEqual([1, 255]);
    // ...but a displayed page takes its layer without needing the margin.
    w.demand.set(7, WANT);
    w.step(t + 3016);
    expect(w.loads.map((l) => l.page)).toEqual([6, 7]);
  });

  it('lets the sectors go first', () => {
    const w = new World(6);
    w.demand.set(5, 1);
    w.sectorsBusy = true;
    w.run(0, 300);
    expect(w.loads).toEqual([]);
    w.sectorsBusy = false;
    w.step(316);
    expect(w.loads.map((l) => l.page)).toEqual([5]);
  });

  it('takes a page in through an extra demand of the same shape', () => {
    const w = new World(6);
    const extra = new FakeDemand();
    extra.set(40, 2);
    w.frame.nowMs = 0;
    w.residency.update(w.frame, w.demand, extra);
    expect(w.loads.map((l) => l.page)).toEqual([40]);
  });
});

describe('a page arriving', () => {
  it('goes up in two steps, one a frame, then fades in over 600 ms with no write once it is still', async () => {
    const w = new World(6);
    w.demand.set(7, 1);
    w.step(0);
    await w.resolve(7);
    w.frame.nowMs = 16;
    w.residency.update(w.frame, w.demand, null);
    expect(w.residency.stats().pipe).toBe('uploading');
    expect(w.residency.uploadStep(16)).toBe(true);
    expect(w.residency.uploadStep(16)).toBe(false);
    expect(w.uploads).toEqual([{ page: 7, layer: 0, step: 0 }]);
    expect(w.r(7)).toBe(0);
    w.frame.nowMs = 32;
    w.residency.update(w.frame, w.demand, null);
    expect(w.residency.uploadStep(32)).toBe(true);
    expect(w.uploads.at(-1)).toEqual({ page: 7, layer: 0, step: 1 });
    // Published with a fade of zero, after the last level.
    expect([w.r(7), w.g(7)]).toEqual([1, 0]);
    w.step(32 + CLOUD_PAGE_FADE_IN_MS / 2);
    expect(w.g(7)).toBe(128);
    w.step(32 + CLOUD_PAGE_FADE_IN_MS);
    expect(w.g(7)).toBe(255);
    const writes = w.writes;
    w.run(700, 2000);
    expect(w.writes).toBe(writes);
    expect(w.residency.stats()).toMatchObject({ resident: 1, admissions: 1, fading: 0, freeLayers: 5, pipe: 'idle' });
  });

  it('says how long a ready step has waited, for the caller\'s starvation rule', async () => {
    const w = new World(6);
    w.demand.set(7, 1);
    w.step(0);
    await w.resolve(7);
    w.run(16, 500, { upload: false });
    expect(w.residency.uploadWaitMs(500)).toBe(500 - 16);
    expect(w.residency.uploadStep(500)).toBe(true);
    expect(w.residency.uploadWaitMs(600)).toBe(100);
  });

  it('says whether a step would run, so the caller gives the frame\'s turn only to one that will', async () => {
    const w = new World(6);
    expect(w.residency.uploadReady()).toBe(false);
    w.demand.set(7, 1);
    w.step(0);
    expect(w.residency.uploadReady()).toBe(false); // still loading
    await w.resolve(7);
    w.step(16, { upload: false });
    expect(w.residency.uploadReady()).toBe(true);
    expect(w.residency.uploadStep(16)).toBe(true);
    // One step a frame: the next waits for the next update.
    expect(w.residency.uploadReady()).toBe(false);
    w.step(32, { upload: false });
    expect(w.residency.uploadReady()).toBe(true);
    // Never under the veil.
    w.frame.veil = true;
    w.step(48, { upload: false });
    expect(w.residency.uploadReady()).toBe(false);
    expect(w.residency.uploadStep(48)).toBe(false);
  });
});

describe('eviction', () => {
  it('takes a resident only by the margin, and only once it has been drawn for the dwell', async () => {
    const w = new World(1);
    w.demand.set(1, 2);
    let t = await makeResident(w, 1, 0);
    // The resident's score: 3.97 / 2 × 0.75 = 1.49. A candidate 1.2 times it waits.
    w.demand.set(2, 2 / 1.2);
    w.run(t, t + 400);
    expect(w.loads.length).toBe(1);
    // 1.3 times it: past the margin, and page 1 was first drawn > 1 s ago.
    w.demand.set(2, 2 / 1.3);
    w.step(t + 416);
    expect(w.loads.map((l) => l.page)).toEqual([1, 2]);
    t += 432;
    // A fresh resident is protected until it has been drawn for the dwell —
    // and not drawn at all, it is protected outright.
    const v = new World(1);
    v.demand.set(1, 2);
    v.step(0);
    await v.resolve(1);
    v.run(16, 48, { drawn: false });
    expect(v.r(1)).toBe(1);
    v.demand.set(2, 0.5);
    v.run(64, 3000, { drawn: false });
    expect(v.loads.length).toBe(1);
    v.step(3016);
    v.run(3032, 3016 + CLOUD_PAGE_DWELL_MS - 16);
    expect(v.loads.length).toBe(1);
    v.step(3016 + CLOUD_PAGE_DWELL_MS + 16);
    expect(v.loads.map((l) => l.page)).toEqual([1, 2]);
  });

  it('fades the victim only once the replacement is decoded, over 300 ms, then hands its layer over', async () => {
    const w = new World(1);
    w.demand.set(1, 2);
    let t = await makeResident(w, 1, 0);
    w.demand.set(2, 1);
    w.step(t);
    expect(w.residency.stats().pipe).toBe('loading');
    w.run(t + 16, t + 400);
    expect(w.g(1)).toBe(255);
    await w.resolve(2);
    t += 416;
    w.step(t);
    // Chosen this frame; the fade runs from the next.
    expect(w.g(1)).toBe(255);
    w.step(t + CLOUD_PAGE_FADE_OUT_MS / 2);
    expect(w.g(1)).toBe(128);
    expect(w.uploads.filter((u) => u.page === 2)).toEqual([]);
    w.step(t + CLOUD_PAGE_FADE_OUT_MS);
    // Cleared, then the layer is the replacement's.
    expect([w.r(1), w.g(1)]).toEqual([0, 0]);
    expect(w.uploads.filter((u) => u.page === 2)).toEqual([{ page: 2, layer: 0, step: 0 }]);
    w.step(t + CLOUD_PAGE_FADE_OUT_MS + 16);
    expect([w.r(2), w.g(2)]).toEqual([1, 0]);
    expect(w.residency.stats()).toMatchObject({ admissions: 2, evictions: 1, resident: 1, pipe: 'idle' });
  });

  it('evicts nothing for a load that fails, and cools the page down, doubling', async () => {
    const w = new World(1);
    w.demand.set(1, 2);
    let t = await makeResident(w, 1, 0);
    w.demand.set(2, 1);
    w.step(t);
    w.loads.at(-1)!.reject(new Error('404'));
    await flush();
    w.run(t + 16, t + 1000);
    expect([w.r(1), w.g(1)]).toEqual([1, 255]);
    expect(w.warnings.length).toBe(1);
    expect(w.warnings[0]).toMatch(/page \d+_\d+ failed to load \(404\)/);
    expect(w.residency.stats().failed).toBe(1);
    // Not again until the cooldown runs out.
    w.run(t + 1016, t + CLOUD_PAGE_RETRY_MS - 16);
    expect(w.loads.length).toBe(2);
    w.step(t + CLOUD_PAGE_RETRY_MS + 16);
    expect(w.loads.length).toBe(3);
    t += CLOUD_PAGE_RETRY_MS + 16;
    w.loads.at(-1)!.reject(new Error('404'));
    await flush();
    w.run(t + 16, t + 2 * CLOUD_PAGE_RETRY_MS - 16);
    expect(w.loads.length).toBe(3);
    w.step(t + 2 * CLOUD_PAGE_RETRY_MS + 16);
    expect(w.loads.length).toBe(4);
    // Said once a session.
    expect(w.warnings.length).toBe(1);
  });

  it('turns a fading victim back from where it stands, with no reload, when it is wanted again', async () => {
    const w = new World(1);
    w.demand.set(1, 2);
    let t = await makeResident(w, 1, 0);
    w.demand.set(2, 1);
    w.step(t);
    await w.resolve(2);
    w.step(t + 16);
    w.step(t + 16 + CLOUD_PAGE_FADE_OUT_MS / 4);
    expect(w.g(1)).toBeLessThan(255);
    // Half-way out, page 1 comes to out-score page 2 by more than the margin.
    w.demand.set(1, 0.5);
    t += 16 + CLOUD_PAGE_FADE_OUT_MS / 2;
    w.step(t);
    expect(w.g(1)).toBe(128);
    // Back up at the fade-in's pace from where it stood: the other half in
    // 300 ms.
    w.step(t + CLOUD_PAGE_FADE_IN_MS / 4);
    expect(w.g(1)).toBe(Math.round(255 * ease(0.75)));
    w.step(t + CLOUD_PAGE_FADE_IN_MS / 2);
    expect(w.g(1)).toBe(255);
    // No reload of page 1, and page 2, with no other room, was dropped.
    expect(w.loads.map((l) => l.page)).toEqual([1, 2]);
    expect(w.residency.stats().pipe).toBe('idle');
    expect(w.uploads.filter((u) => u.page === 2)).toEqual([]);
  });

  it('reverses a page taken mid fade-in from its current value', async () => {
    const w = new World(1);
    w.demand.set(1, 2);
    w.step(0);
    await w.resolve(1);
    w.run(16, 48);
    expect(w.r(1)).toBe(1);
    const t0 = w.publishedAt.get(1)!;
    w.step(t0 + CLOUD_PAGE_FADE_IN_MS / 2);
    expect(w.g(1)).toBe(128);
    // Half-way in, the page leaves the frame: released, so it may go at once.
    w.demand.clear(1);
    w.demand.set(2, 1);
    w.step(t0 + CLOUD_PAGE_FADE_IN_MS / 2 + 16);
    await w.resolve(2);
    // Taken at 60 % of the way in.
    const t = t0 + 0.6 * CLOUD_PAGE_FADE_IN_MS;
    w.step(t);
    expect(w.g(1)).toBe(Math.round(255 * ease(0.6)));
    // Out at the fade-out's pace from there: gone in 180 ms, not 300.
    w.step(t + 0.5 * CLOUD_PAGE_FADE_OUT_MS);
    expect(w.g(1)).toBe(Math.round(255 * ease(0.1)));
    w.step(t + 0.6 * CLOUD_PAGE_FADE_OUT_MS);
    expect(w.r(1)).toBe(0);
  });

  it('keeps a released page until its layer is wanted, then lets it go without the dwell', async () => {
    const w = new World(1);
    w.demand.set(1, 2);
    let t = await makeResident(w, 1, 0);
    // Out of frame for a long time: still resident, its entry untouched.
    w.demand.clear(1);
    w.run(t, t + 10_000);
    expect([w.r(1), w.g(1)]).toEqual([1, 255]);
    expect(w.residency.stats()).toMatchObject({ resident: 1, wanted: 0 });
    // Back in frame: drawn at once, nothing fetched.
    w.demand.set(1, 2);
    t += 10_016;
    w.step(t);
    expect(w.loads.length).toBe(1);
    // Released again, and another page wants the layer: it goes.
    w.demand.clear(1);
    w.demand.set(2, 3.9);
    w.step(t + 16);
    expect(w.loads.map((l) => l.page)).toEqual([1, 2]);
  });
});

describe('a load in flight', () => {
  it('is aborted when its page is released, and its late answer dropped', async () => {
    const w = new World(6);
    w.demand.set(3, 1);
    w.step(0);
    const first = w.loads[0];
    w.demand.set(3, CLOUD_FIELD_RELEASE_TEXELS + 0.5);
    w.step(16);
    expect(first.signal.aborted).toBe(true);
    expect(w.residency.stats().pipe).toBe('idle');
    first.resolve({ page: 3 });
    await flush();
    w.run(32, 300);
    expect(w.uploads).toEqual([]);
    expect(w.r(3)).toBe(0);
  });

  it('drops a completion from an older generation and takes the newer one', async () => {
    const w = new World(6);
    w.demand.set(3, 1);
    w.step(0);
    const old = w.loads[0];
    w.residency.cancelInFlight();
    expect(old.signal.aborted).toBe(true);
    w.step(16);
    const fresh = w.loads[1];
    expect(fresh.page).toBe(3);
    old.resolve({ page: 3 });
    await flush();
    w.step(32);
    expect(w.residency.stats().pipe).toBe('loading');
    fresh.resolve({ page: 3 });
    await flush();
    w.run(48, 96);
    expect(w.r(3)).toBe(1);
  });

  it('is given up after 60 s, and its page cools down', () => {
    const w = new World(6);
    w.demand.set(3, 1);
    w.step(0);
    w.step(CLOUD_PAGE_LOAD_TIMEOUT_MS);
    expect(w.loads[0].signal.aborted).toBe(false);
    w.step(CLOUD_PAGE_LOAD_TIMEOUT_MS + 16);
    expect(w.loads[0].signal.aborted).toBe(true);
    expect(w.warnings[0]).toMatch(/timed out after 60 s/);
    expect(w.residency.stats()).toMatchObject({ pipe: 'idle', failed: 1 });
  });
});

describe('suspends', () => {
  it('releases everything with the deck hidden or the camera on the ground, keeping the layers', async () => {
    for (const state of ['hidden', 'grounded'] as const) {
      const w = new World(2);
      w.demand.set(1, 2);
      const t = await makeResident(w, 1, 0);
      w.demand.set(2, 1);
      w.step(t);
      const load = w.loads.at(-1)!;
      w.frame[state] = true;
      w.run(t + 16, t + 2000);
      expect(load.signal.aborted).toBe(true);
      expect(w.loads.length).toBe(2);
      expect([w.r(1), w.g(1)]).toEqual([1, 255]);
      expect(w.residency.stats().wanted).toBe(0);
      w.frame[state] = false;
      w.step(t + 2016);
      expect(w.loads.length).toBe(3);
    }
  });

  it('admits nothing while the globe spins or the chart owns the frame, and lets the pipe finish', async () => {
    for (const state of ['spinning', 'chart'] as const) {
      const w = new World(6);
      w.demand.set(1, 1);
      w.step(0);
      w.frame[state] = true;
      w.demand.set(2, 1);
      await w.resolve(1);
      w.run(16, 2000);
      expect(w.r(1)).toBe(1);
      expect(w.loads.length).toBe(1);
      w.frame[state] = false;
      w.step(2016);
      expect(w.loads.map((l) => l.page)).toEqual([1, 2]);
    }
  });

  it('admits and uploads nothing under the arrival veil', async () => {
    const w = new World(6);
    w.demand.set(1, 1);
    w.step(0);
    await w.resolve(1);
    w.frame.veil = true;
    w.demand.set(2, 1);
    w.run(16, 1000);
    expect(w.uploads).toEqual([]);
    expect(w.loads.length).toBe(1);
    w.frame.veil = false;
    w.run(1016, 1064);
    expect(w.r(1)).toBe(1);
  });

  it('cancels the pipe on an arrival or a tool visit and keeps every resident; a fading victim turns back', async () => {
    const w = new World(1);
    w.demand.set(1, 2);
    const t = await makeResident(w, 1, 0);
    w.demand.set(2, 1);
    w.step(t);
    await w.resolve(2);
    w.step(t + 16);
    w.step(t + 16 + CLOUD_PAGE_FADE_OUT_MS / 2);
    expect(w.g(1)).toBe(128);
    w.residency.cancelInFlight();
    expect(w.residency.stats().pipe).toBe('idle');
    // Admissions held by the veil while the arrival settles.
    w.frame.veil = true;
    w.run(t + 200, t + 200 + CLOUD_PAGE_FADE_IN_MS);
    expect([w.r(1), w.g(1)]).toEqual([1, 255]);
    expect(w.uploads.filter((u) => u.page === 2)).toEqual([]);
  });

  it('drops every entry and layer when the context is lost, and streams pages back once restored', async () => {
    const w = new World(2);
    w.demand.set(1, 2);
    const t = await makeResident(w, 1, 0);
    w.demand.set(2, 1);
    w.step(t);
    w.residency.contextLost();
    expect(w.loads.at(-1)!.signal.aborted).toBe(true);
    expect(w.resident()).toEqual([]);
    expect(w.residency.stats()).toMatchObject({ resident: 0, pipe: 'idle' });
    w.run(t + 16, t + 2000);
    expect(w.residency.stats()).toMatchObject({ resident: 0, freeLayers: 2 });
    expect(w.loads.length).toBe(2);
    w.residency.contextRestored();
    w.step(t + 2016);
    expect(w.loads.length).toBe(3);
  });

  it('clears every entry and layer on demand and goes straight on streaming, its wants still known', async () => {
    const w = new World(2);
    w.demand.set(1, 2);
    const t = await makeResident(w, 1, 0);
    expect(w.residency.isWanted(1)).toBe(true);
    expect(w.residency.isWanted(2)).toBe(false);
    w.demand.set(2, 1);
    w.step(t);
    w.residency.clear();
    expect(w.loads.at(-1)!.signal.aborted).toBe(true);
    expect(w.resident()).toEqual([]);
    expect(w.residency.stats()).toMatchObject({ resident: 0, freeLayers: 2, pipe: 'idle' });
    expect(w.residency.isWanted(2)).toBe(true);
    // Not a lost context: the next frame admits again.
    w.step(t + 16);
    expect(w.residency.stats().pipe).toBe('loading');
  });
});

describe('the pool', () => {
  it('is never over-filled, and the table names each layer once, through a long random session', async () => {
    let seed = 12345;
    const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (const layers of [1, 3, 6]) {
      const w = new World(layers);
      for (let f = 0; f < 3000; f++) {
        if (f % 40 === 0) {
          for (let p = 0; p < PAGES; p++) {
            if (r() < 0.06) w.demand.set(p, r() * 14, r(), r() * 2 - 1);
            else if (r() < 0.3) w.demand.clear(p);
          }
        }
        if (r() < 0.01) w.frame.spinning = !w.frame.spinning;
        if (r() < 0.003) w.residency.cancelInFlight();
        const open = w.loads.filter((l) => !l.signal.aborted);
        if (open.length > 0 && r() < 0.2) {
          const l = open[Math.floor(r() * open.length)];
          if (r() < 0.15) l.reject(new Error('flaky')); else l.resolve({ page: l.page });
          await flush();
        }
        w.step(f * 16, { upload: r() < 0.7 });
        const named = w.resident().map((p) => w.r(p) - 1);
        expect(named.length).toBeLessThanOrEqual(layers);
        expect(new Set(named).size).toBe(named.length);
        for (const l of named) expect(l).toBeLessThan(layers);
        const s = w.residency.stats();
        expect(s.resident + s.freeLayers + (s.pipe === 'uploading' ? 1 : 0)).toBe(layers);
      }
      expect(w.residency.stats().admissions).toBeGreaterThan(layers);
    }
  });
});

// ---------------------------------------------------------------------------
// The scripted pan: the real measure under a camera sweeping across pages.

const DECK_KM = 6371 + 10;
type V = [number, number, number];
const norm = (v: V): V => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** A camera `altKm` over the deck-frame direction `nadir`, pitched `tiltDeg`
 *  from straight down toward `heading` (a unit tangent there), written into
 *  `cam` in place: a desktop frame, 1600 × 1000 CSS pixels at a tile ratio of
 *  2, 60° design, full lens. */
function poseInto(cam: FieldCamera, nadir: V, heading: V, altKm: number, tiltDeg: number): void {
  const d = 1 + altKm / DECK_KM;
  const t = (tiltDeg * Math.PI) / 180;
  const fwd = norm([
    -nadir[0] * Math.cos(t) + heading[0] * Math.sin(t),
    -nadir[1] * Math.cos(t) + heading[1] * Math.sin(t),
    -nadir[2] * Math.cos(t) + heading[2] * Math.sin(t),
  ]);
  const back: V = [-fwd[0], -fwd[1], -fwd[2]];
  const right = norm(cross(heading, back));
  const up = cross(back, right);
  const pos = cam.pos as V; const r = cam.right as V; const u = cam.up as V; const b = cam.back as V;
  for (let i = 0; i < 3; i++) { pos[i] = nadir[i] * d; r[i] = right[i]; u[i] = up[i]; b[i] = back[i]; }
}

/** The frames the pan is flown in: a desktop window (1600 × 1000 CSS pixels)
 *  over the 8K base and a phone held upright (390 × 844) over the 4K base,
 *  both at a tile ratio of 2, 60° design, full lens. */
const FRAMES = {
  desktop: { aspect: 1.6, heightPx: 2000, ratio: CLOUD_FIELD_LEVEL_WIDTH / 8192 },
  phone: { aspect: 390 / 844, heightPx: 1688, ratio: CLOUD_FIELD_LEVEL_WIDTH / 4096 },
} as const;

function frameCamera(kind: keyof typeof FRAMES): FieldCamera {
  const { aspect, heightPx } = FRAMES[kind];
  const strength = lensEffectiveStrength(60, aspect, 1);
  return {
    pos: [0, 0, 2], right: [1, 0, 0], up: [0, 1, 0], back: [0, 0, 1],
    designFovDeg: 60, lensStrength: strength, aspect, heightPx,
    renderFovDeg: lensOverscanFovDeg(60, aspect, strength),
  };
}

/** The sub-camera point `s` radians along a great circle inclined 20° to the
 *  equator through (lon −30°, lat 0), and the heading along it. */
function track(s: number, nadir: V, heading: V): void {
  const inc = (20 * Math.PI) / 180;
  const lon0 = (-30 * Math.PI) / 180;
  // The circle's start and its direction of travel at the start, then turned.
  const a: V = [-Math.cos(lon0 + Math.PI), 0, Math.sin(lon0 + Math.PI)];
  const east: V = norm(cross([0, 1, 0], a));
  const b: V = norm([east[0] * Math.cos(inc), Math.sin(inc), east[2] * Math.cos(inc)]);
  for (let i = 0; i < 3; i++) {
    nadir[i] = a[i] * Math.cos(s) + b[i] * Math.sin(s);
    heading[i] = -a[i] * Math.sin(s) + b[i] * Math.cos(s);
  }
}

/** A minute of the pan: frames at 60 Hz, loads answered after `loadMs`, a
 *  step every frame. Reports what the pool did. */
async function pan(kind: keyof typeof FRAMES, layers: number, altKm: number, degPerS: number, tiltDeg: number, loadMs = 300) {
  const w = new World(layers);
  w.frame.ratio = FRAMES[kind].ratio;
  const measure = new CloudFieldMeasure();
  const cam = frameCamera(kind);
  const nadir: V = [0, 0, 0];
  const heading: V = [0, 0, 0];
  const sun: V = [0, 0, 0];
  // The Sun over the middle of the track: the whole sweep is in daylight.
  track((30 * Math.PI) / 180, sun, heading);
  const due = new Map<PendingLoad, number>();
  const lastEvicted = new Map<number, number>();
  const pingPong: string[] = [];
  let maxWanted = 0;
  let wantedSum = 0;
  const minuteMs = 60_000;
  let frames = 0;
  for (let t = 0; t <= minuteMs; t += 1000 / 60) {
    track((degPerS * t / 1000) * Math.PI / 180, nadir, heading);
    poseInto(cam, nadir, heading, altKm, tiltDeg);
    measure.measure(cam, sun);
    for (const l of w.loads) if (!due.has(l)) due.set(l, t + loadMs);
    let answered = false;
    for (const [l, at] of due) {
      if (at <= t && !l.signal.aborted) { l.resolve({ page: l.page }); due.delete(l); answered = true; }
      else if (l.signal.aborted) due.delete(l);
    }
    if (answered) await flush();
    const before = Array.from({ length: PAGES }, (_, p) => w.r(p));
    w.frame.nowMs = t;
    w.residency.update(w.frame, measure, null);
    w.residency.uploadStep(t);
    w.residency.deckDrawn(t);
    for (let p = 0; p < PAGES; p++) {
      const now = w.r(p);
      if (before[p] > 0 && now === 0) lastEvicted.set(p, t);
      if (before[p] === 0 && now > 0) {
        const ev = lastEvicted.get(p);
        if (ev !== undefined && t - ev < 5000) pingPong.push(`page ${p} back ${(t - ev).toFixed(0)} ms after eviction`);
      }
    }
    const s = w.residency.stats();
    maxWanted = Math.max(maxWanted, s.wanted);
    wantedSum += s.wanted;
    frames += 1;
  }
  const s = w.residency.stats();
  return {
    layers, altKm, admissions: s.admissions, evictions: s.evictions, maxWanted,
    meanWanted: wantedSum / frames, resident: s.resident, pingPong,
  };
}

describe('a scripted pan', () => {
  it('sweeps across page boundaries at 400, 3,000 and 6,000 km without handing a page back and forth', async () => {
    const rows: string[] = [];
    const results: Array<Awaited<ReturnType<typeof pan>>> = [];
    // Each altitude sweeps four pages' worth of track in the minute, looking
    // 45° ahead, so pages enter at the far edge and leave under the camera.
    for (const [kind, pools] of [['desktop', [6, 12]], ['phone', [6]]] as const) {
      for (const altKm of [400, 3000, 6000]) for (const layers of pools) {
        const r = await pan(kind, layers, altKm, 1.5, 45);
        rows.push(`${kind.padEnd(7)} ${String(altKm).padStart(5)} km, pool ${String(layers).padStart(2)}: `
          + `${r.admissions} admissions, ${r.evictions} evictions a minute; wanted ${r.meanWanted.toFixed(1)} mean, `
          + `${r.maxWanted} at most; ${r.resident} resident at the end${r.pingPong.length ? `; ${r.pingPong.join(', ')}` : ''}`);
        results.push(r);
      }
    }
    console.log(`scripted pan (1.5°/s along track, 45° ahead, loads answered in 300 ms):\n${rows.join('\n')}`);
    for (const r of results) {
      expect(r.pingPong).toEqual([]);
      expect(r.admissions).toBeGreaterThan(0);
      expect(r.resident).toBeLessThanOrEqual(r.layers);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Cost: the whole update, the measure included, and what it allocates.

describe('the residency\'s cost', () => {
  it('is a few hundredths of a millisecond at the worst pose found, and allocates nothing in steady state', async () => {
    // The pose that makes the measure read the most points, from a search over
    // altitude, pitch, field of view and frame (a phone held upright, a
    // desktop window and a tall 4K window, in tile-ratio pixels): a grid,
    // then a thousand seeded random poses.
    const measure = new CloudFieldMeasure();
    const nadir: V = [0, 0, 0];
    const heading: V = [0, 0, 0];
    track(0.2, nadir, heading);
    const sun: V = [nadir[0], nadir[1], nadir[2]];
    const camAt = (altKm: number, tiltDeg: number, fovDeg: number, aspect: number, heightPx: number): FieldCamera => {
      const strength = lensEffectiveStrength(fovDeg, aspect, 1);
      const cam: FieldCamera = {
        pos: [0, 0, 2], right: [1, 0, 0], up: [0, 1, 0], back: [0, 0, 1],
        designFovDeg: fovDeg, lensStrength: strength, aspect, heightPx,
        renderFovDeg: lensOverscanFovDeg(fovDeg, aspect, strength),
      };
      poseInto(cam, nadir, heading, altKm, tiltDeg);
      return cam;
    };
    let worst = { points: -1, label: '', cam: camAt(400, 0, 60, 1.6, 2000) };
    for (const altKm of [400, 1000, 3000, 6000, 10_000, 15_000, 20_000, 40_000]) {
      for (const tiltDeg of [0, 30, 60, 80]) {
        for (const fovDeg of [33, 50, 75]) {
          for (const [aspect, heightPx] of [[0.46, 1688], [1.6, 2000], [1.78, 2880]]) {
            const cam = camAt(altKm, tiltDeg, fovDeg, aspect, heightPx);
            measure.measure(cam, sun);
            if (measure.pointsRead > worst.points) {
              worst = { points: measure.pointsRead, label: `${altKm} km, ${tiltDeg}° from nadir, ${fovDeg}° design, ${aspect} aspect, ${heightPx} px tall`, cam };
            }
          }
        }
      }
    }
    let seed = 31;
    const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let n = 0; n < 1000; n++) {
      const altKm = Math.exp(Math.log(300) + r() * (Math.log(60_000) - Math.log(300)));
      const [aspect, heightPx] = [[0.46, 1688], [1.6, 2000], [1.78, 2880]][Math.floor(r() * 3)];
      const cam = camAt(altKm, r() * 85, 30 + r() * 50, aspect, heightPx);
      measure.measure(cam, sun);
      if (measure.pointsRead > worst.points) {
        worst = { points: measure.pointsRead, label: `${altKm.toFixed(0)} km (random), ${aspect} aspect, ${heightPx} px tall`, cam };
      }
    }
    // A pool of twelve filled by a pan first, then the camera moved to the
    // worst pose: every layer held, every page scored.
    const w = new World(12);
    let cam = camAt(3000, 30, 60, 1.6, 2000);
    let t = 0;
    const frame = () => {
      measure.measure(cam, sun);
      w.frame.nowMs = t;
      w.residency.update(w.frame, measure, null);
      w.residency.uploadStep(t);
      w.residency.deckDrawn(t);
      t += 16;
    };
    for (let i = 0; i < 3000 && w.residency.stats().resident < 12; i++) {
      track(0.2 + i * 0.0005, nadir, heading);
      poseInto(cam, nadir, heading, 3000, 30);
      for (const l of w.loads) l.resolve({ page: l.page });
      await flush();
      frame();
    }
    expect(w.residency.stats().resident).toBe(12);
    cam = worst.cam;
    frame();
    const time = (fn: () => void): [number, number] => {
      for (let i = 0; i < 300; i++) fn();
      const ts: number[] = [];
      for (let i = 0; i < 2000; i++) {
        const t0 = performance.now();
        fn();
        ts.push(performance.now() - t0);
      }
      ts.sort((a, b) => a - b);
      return [ts[1000] * 1000, ts[1980] * 1000];
    };
    const [measureMedian, measureP99] = time(() => measure.measure(cam, sun));
    const [median, p99] = time(frame);
    // A zoom moves the field of view every frame, and the rays through the
    // displayed frame are built again each time.
    const zoomed = { ...worst.cam };
    let flip = 0;
    const [zoomMedian, zoomP99] = time(() => {
      zoomed.designFovDeg = worst.cam.designFovDeg + ((flip ^= 1) ? 0.01 : 0);
      measure.measure(zoomed, sun);
    });
    console.log(`worst pose: ${worst.label}; ${measure.pagesRead} pages read point by point, ${measure.pagesBounded} by their floor, `
      + `${measure.pointsRead} points, ${w.residency.stats().resident} resident, ${w.residency.stats().wanted} wanted\n`
      + `  the measure: median ${measureMedian.toFixed(1)} µs, p99 ${measureP99.toFixed(1)} µs over 2,000\n`
      + `  the whole update with it: median ${median.toFixed(1)} µs, p99 ${p99.toFixed(1)} µs over 2,000\n`
      + `  the measure through a zoom: median ${zoomMedian.toFixed(1)} µs, p99 ${zoomP99.toFixed(1)} µs over 2,000`);
    // A ceiling with room for a slower machine than the one the figures were
    // taken on; the figures themselves are the log line.
    expect(median).toBeLessThan(1000);

    // Steady state: the heap after 10,000 more frames is the heap before.
    const v8 = await import('node:v8');
    const vm = await import('node:vm');
    v8.setFlagsFromString('--expose_gc');
    const gc = vm.runInNewContext('gc') as () => void;
    for (let i = 0; i < 2000; i++) frame();
    gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 10_000; i++) frame();
    const grown = process.memoryUsage().heapUsed - before;
    console.log(`  heap growth over 10,000 steady frames: ${grown} bytes`);
    expect(grown).toBeLessThan(16 * 1024);
  }, 60_000);
});
