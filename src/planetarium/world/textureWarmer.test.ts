import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  bindTextureWarmer,
  invalidateTextureWarmCache,
  pumpTextureWarmQueue,
  queueTextureWarm,
  resetTextureWarmer,
  abandonSlicedUpload,
  bindSlicedUploader,
  warmBudgetMs,
  warmPumpAllowed,
  warmRepayMs,
  WARM_BUDGET_CAP_MS,
  WARM_BUDGET_FLOOR_MS,
  WARM_STARVE_MS,
} from './textureWarmer';

describe('warmBudgetMs', () => {
  it('gives a 60 Hz frame the budget the fixed figure used to', () => {
    expect(warmBudgetMs(16.7)).toBeCloseTo(5.845, 3);
  });

  it('spends less of a shorter frame, so 120 Hz is not eaten by uploads', () => {
    expect(warmBudgetMs(8.33)).toBeCloseTo(2.9155, 3);
  });

  it('never exceeds the cap however long the frame', () => {
    expect(warmBudgetMs(100)).toBe(WARM_BUDGET_CAP_MS);
  });

  it('never falls below the floor, or the queue would never drain', () => {
    expect(warmBudgetMs(1)).toBe(WARM_BUDGET_FLOOR_MS);
  });

  it('falls back to the cap when the interval is not a usable number', () => {
    expect(warmBudgetMs(Number.NaN)).toBe(WARM_BUDGET_CAP_MS);
    expect(warmBudgetMs(0)).toBe(WARM_BUDGET_CAP_MS);
    expect(warmBudgetMs(-5)).toBe(WARM_BUDGET_CAP_MS);
  });
});

describe('warmRepayMs', () => {
  it('sits out a whole frame when ONE map outran the budget', () => {
    // The measured shape: a 9.2 ms tile upload, a 2.9 ms budget, an 8.33 ms
    // frame. The 6.3 ms owed lets the next frame upload again; a frame does not.
    expect(warmRepayMs(9.2, 9.2, 2.9, 8.33)).toBeCloseTo(8.33, 5);
  });

  it('repays only the debt when a BURST of small maps filled the budget', () => {
    // Three 1 ms moon maps against a 2.9 ms budget: none of them made a frame
    // late, so the boot-idle warm keeps draining every frame as it always did.
    expect(warmRepayMs(3, 1, 2.9, 8.33)).toBeCloseTo(0.1, 5);
  });

  it('repays the overrun when it is longer than a frame', () => {
    expect(warmRepayMs(30, 30, 6, 8.33)).toBeCloseTo(24, 5);
  });

  it('owes nothing for a call that stayed inside its budget', () => {
    expect(warmRepayMs(4, 4, 6, 16.7)).toBe(0);
  });

  it('owes nothing at all for an unbudgeted drain', () => {
    expect(warmRepayMs(120, 120, Number.POSITIVE_INFINITY, 8.33)).toBe(0);
  });

  it('falls back to the overrun when the frame length is not usable', () => {
    expect(warmRepayMs(9.2, 9.2, 2.9, Number.NaN)).toBeCloseTo(6.3, 5);
    expect(warmRepayMs(9.2, 9.2, 2.9, -1)).toBeCloseTo(6.3, 5);
  });
});

describe('warmPumpAllowed', () => {
  it('lets the pump run when it owes nothing', () => {
    expect(warmPumpAllowed(1_000, 0, 900)).toBe(true);
  });

  it('holds the pump back while an overrun is still being repaid', () => {
    expect(warmPumpAllowed(1_000, 1_010, 995)).toBe(false);
  });

  it('forces an upload through rather than starve the queue', () => {
    expect(warmPumpAllowed(1_000, 5_000, 1_000 - WARM_STARVE_MS)).toBe(true);
  });

  it('treats a queue that has never uploaded as starving', () => {
    expect(warmPumpAllowed(1_000, 5_000, null)).toBe(true);
  });
});

describe('textureWarmer', () => {
  let uploaded: THREE.Texture[];
  let clock: number;
  let uploadCostMs: number;
  let nowSpy: ReturnType<typeof vi.spyOn>;

  const upload = (tex: THREE.Texture) => {
    uploaded.push(tex);
    clock += uploadCostMs; // each upload advances the mocked clock by its cost
  };

  beforeEach(() => {
    resetTextureWarmer();
    uploaded = [];
    clock = 0;
    uploadCostMs = 0;
    nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock);
  });

  afterEach(() => {
    nowSpy.mockRestore();
    resetTextureWarmer();
  });

  it('holds entries queued before bind, then drains them once bound', () => {
    const t = new THREE.Texture();
    queueTextureWarm(t);
    pumpTextureWarmQueue(10, 8.33);
    expect(uploaded).toEqual([]); // no upload fn yet — nothing to do, nothing lost
    bindTextureWarmer(upload);
    pumpTextureWarmQueue(10, 8.33);
    expect(uploaded).toEqual([t]);
  });

  it('repays an overrun before paying the next unsliceable upload', () => {
    bindTextureWarmer(upload);
    uploadCostMs = 10; // every upload alone exceeds the budget
    const a = new THREE.Texture();
    const b = new THREE.Texture();
    queueTextureWarm(a);
    queueTextureWarm(b);
    pumpTextureWarmQueue(6, 8.33);
    expect(uploaded).toEqual([a]); // 10 ms paid against a 6 ms budget, in an 8.33 ms frame
    pumpTextureWarmQueue(6, 8.33);
    expect(uploaded).toEqual([a]); // the very next frame sits the overrun out
    clock += 4; // the 4 ms owed is served, but not yet a whole frame
    pumpTextureWarmQueue(6, 8.33);
    expect(uploaded).toEqual([a]);
    clock += 4.33;
    pumpTextureWarmQueue(6, 8.33);
    expect(uploaded).toEqual([a, b]); // a frame has passed, FIFO order kept
  });

  it('repays the overrun itself when it is longer than a frame', () => {
    bindTextureWarmer(upload);
    uploadCostMs = 30; // an 8K-class map: 24 ms over a 6 ms budget
    const a = new THREE.Texture();
    const b = new THREE.Texture();
    queueTextureWarm(a);
    queueTextureWarm(b);
    pumpTextureWarmQueue(6, 8.33);
    expect(uploaded).toEqual([a]);
    clock += 8.33; // one frame is not enough to clear a 24 ms debt
    pumpTextureWarmQueue(6, 8.33);
    expect(uploaded).toEqual([a]);
    clock += 16;
    pumpTextureWarmQueue(6, 8.33);
    expect(uploaded).toEqual([a, b]);
  });

  it('lets an unbudgeted drain through while the pump is still repaying', () => {
    bindTextureWarmer(upload);
    uploadCostMs = 10;
    const a = new THREE.Texture();
    const b = new THREE.Texture();
    queueTextureWarm(a);
    queueTextureWarm(b);
    pumpTextureWarmQueue(6, 8.33);
    expect(uploaded).toEqual([a]); // a frame is now owed
    // The arrival veil drains with no budget: refusing it here would lift an
    // opaque cover over a map that is not resident.
    pumpTextureWarmQueue(Number.POSITIVE_INFINITY, 8.33);
    expect(uploaded).toEqual([a, b]);
  });

  it('leaves no debt behind an unbudgeted drain', () => {
    bindTextureWarmer(upload);
    uploadCostMs = 40;
    const a = new THREE.Texture();
    const b = new THREE.Texture();
    queueTextureWarm(a);
    pumpTextureWarmQueue(Number.POSITIVE_INFINITY, 8.33);
    expect(uploaded).toEqual([a]);
    queueTextureWarm(b);
    pumpTextureWarmQueue(6, 8.33); // the very next budgeted frame may still upload
    expect(uploaded).toEqual([a, b]);
  });

  it('forces an upload through rather than let the queue starve', () => {
    bindTextureWarmer(upload);
    uploadCostMs = 5_000; // an absurd cost, so the debt would outlast the wait
    const a = new THREE.Texture();
    const b = new THREE.Texture();
    queueTextureWarm(a);
    queueTextureWarm(b);
    pumpTextureWarmQueue(6, 8.33);
    expect(uploaded).toEqual([a]);
    clock += WARM_STARVE_MS - 1;
    pumpTextureWarmQueue(6, 8.33);
    expect(uploaded).toEqual([a]); // still repaying
    clock += 1;
    pumpTextureWarmQueue(6, 8.33);
    expect(uploaded).toEqual([a, b]); // a quarter second is the longest wait
  });

  it('keeps draining after a burst of small maps merely filled the budget', () => {
    // The boot-idle and system-moon warms are bursts of maps that each upload
    // well inside the budget. Making them sit out a frame would halve their
    // throughput for a stutter none of them caused.
    bindTextureWarmer(upload);
    uploadCostMs = 1;
    const texes = [new THREE.Texture(), new THREE.Texture(), new THREE.Texture(), new THREE.Texture()];
    for (const t of texes) queueTextureWarm(t);
    pumpTextureWarmQueue(2.9, 8.33);
    expect(uploaded).toEqual(texes.slice(0, 3)); // 3 ms paid, 0.1 ms owed
    clock += 0.2;
    pumpTextureWarmQueue(2.9, 8.33);
    expect(uploaded).toEqual(texes); // and not a frame later
  });

  it('always uploads at least one, and batches small uploads within budget', () => {
    bindTextureWarmer(upload);
    uploadCostMs = 1;
    const texes = [new THREE.Texture(), new THREE.Texture(), new THREE.Texture()];
    for (const t of texes) queueTextureWarm(t);
    pumpTextureWarmQueue(6, 8.33); // 3×1ms fits one call
    expect(uploaded).toEqual(texes);
  });

  it('never uploads a texture disposed while queued', () => {
    bindTextureWarmer(upload);
    const dead = new THREE.Texture();
    const live = new THREE.Texture();
    queueTextureWarm(dead);
    queueTextureWarm(live);
    dead.dispose();
    pumpTextureWarmQueue(10, 8.33);
    expect(uploaded).toEqual([live]); // and the dead entry consumed no budget
  });

  it('is idempotent per texture', () => {
    bindTextureWarmer(upload);
    const t = new THREE.Texture();
    queueTextureWarm(t);
    queueTextureWarm(t);
    pumpTextureWarmQueue(10, 8.33);
    expect(uploaded).toEqual([t]);
  });

  it('does not re-upload a drained texture until it changes', () => {
    bindTextureWarmer(upload);
    const t = new THREE.Texture();
    queueTextureWarm(t);
    pumpTextureWarmQueue(10, 8.33);
    queueTextureWarm(t);
    pumpTextureWarmQueue(10, 8.33);
    expect(uploaded).toEqual([t]);

    t.needsUpdate = true; // increments Texture.version
    queueTextureWarm(t);
    pumpTextureWarmQueue(10, 8.33);
    expect(uploaded).toEqual([t, t]);
  });

  it('allows textures to warm again after WebGL context loss', () => {
    bindTextureWarmer(upload);
    const t = new THREE.Texture();
    queueTextureWarm(t);
    pumpTextureWarmQueue(10, 8.33);
    invalidateTextureWarmCache();
    queueTextureWarm(t);
    pumpTextureWarmQueue(10, 8.33);
    expect(uploaded).toEqual([t, t]);
  });

  it('treats dispose after a drain as inert', () => {
    bindTextureWarmer(upload);
    const t = new THREE.Texture();
    queueTextureWarm(t);
    pumpTextureWarmQueue(10, 8.33);
    expect(() => t.dispose()).not.toThrow();
    pumpTextureWarmQueue(10, 8.33);
    expect(uploaded).toEqual([t]);
  });

  it('drops a throwing upload and keeps pumping without escaping', () => {
    const bad = new THREE.Texture();
    const good = new THREE.Texture();
    bindTextureWarmer((tex) => {
      if (tex === bad) throw new Error('context lost');
      upload(tex);
    });
    queueTextureWarm(bad);
    queueTextureWarm(good);
    expect(() => pumpTextureWarmQueue(10, 8.33)).not.toThrow();
    expect(uploaded).toEqual([good]);
  });
});

describe('textureWarmer onOutcome', () => {
  let uploaded: THREE.Texture[];

  beforeEach(() => {
    resetTextureWarmer();
    uploaded = [];
  });

  afterEach(() => {
    resetTextureWarmer();
  });

  it('settles warmed exactly once, after the upload, and never before the pump', () => {
    bindTextureWarmer((tex) => uploaded.push(tex));
    const tex = new THREE.Texture();
    const calls: string[] = [];
    queueTextureWarm(tex, (o) => calls.push(`${o}@${uploaded.length}`));
    expect(calls).toEqual([]);
    pumpTextureWarmQueue(Number.POSITIVE_INFINITY, 8.33);
    expect(calls).toEqual(['warmed@1']); // ran after the upload landed
    pumpTextureWarmQueue(Number.POSITIVE_INFINITY, 8.33);
    expect(calls).toEqual(['warmed@1']);
  });

  it('settles warmed at once for a texture that is already resident', () => {
    bindTextureWarmer((tex) => uploaded.push(tex));
    const tex = new THREE.Texture();
    queueTextureWarm(tex);
    pumpTextureWarmQueue(Number.POSITIVE_INFINITY, 8.33);
    const calls: string[] = [];
    queueTextureWarm(tex, (o) => calls.push(o));
    expect(calls).toEqual(['warmed']);
    expect(uploaded.length).toBe(1); // no second upload
  });

  it('settles disposed for a texture disposed before its turn, and never uploads it', () => {
    bindTextureWarmer((tex) => uploaded.push(tex));
    const tex = new THREE.Texture();
    const calls: string[] = [];
    queueTextureWarm(tex, (o) => calls.push(o));
    tex.dispose();
    pumpTextureWarmQueue(Number.POSITIVE_INFINITY, 8.33);
    expect(calls).toEqual(['disposed']);
    expect(uploaded).toEqual([]);
  });

  it('settles failed for an upload that threw (the texture is not resident)', () => {
    bindTextureWarmer(() => { throw new Error('context lost'); });
    const tex = new THREE.Texture();
    const calls: string[] = [];
    queueTextureWarm(tex, (o) => calls.push(o));
    pumpTextureWarmQueue(Number.POSITIVE_INFINITY, 8.33);
    expect(calls).toEqual(['failed']);
  });

  it('a callback registered on a re-queue of a pending texture replaces, not duplicates', () => {
    bindTextureWarmer((tex) => uploaded.push(tex));
    const tex = new THREE.Texture();
    const calls: string[] = [];
    queueTextureWarm(tex, () => calls.push('first'));
    queueTextureWarm(tex, () => calls.push('second'));
    pumpTextureWarmQueue(Number.POSITIVE_INFINITY, 8.33);
    expect(calls).toEqual(['second']);
    expect(uploaded.length).toBe(1);
  });

  it('a teardown settles every pending callback as disposed, exactly once', () => {
    bindTextureWarmer((tex) => uploaded.push(tex));
    const a = new THREE.Texture();
    const b = new THREE.Texture();
    const calls: string[] = [];
    queueTextureWarm(a, (o) => calls.push(`a:${o}`));
    queueTextureWarm(b, (o) => calls.push(`b:${o}`));
    resetTextureWarmer();
    expect(calls.sort()).toEqual(['a:disposed', 'b:disposed']);
    // Nothing survives the reset: a later dispose or pump reports nothing more.
    a.dispose();
    pumpTextureWarmQueue(Number.POSITIVE_INFINITY, 8.33);
    expect(calls.length).toBe(2);
    expect(uploaded).toEqual([]);
  });
});

describe('sliced uploads through the pump', () => {
  let uploaded: THREE.Texture[];
  let steps: number;
  let plan: Array<'more' | 'done' | 'failed'>;

  const stubSlicer = (sliceable: (t: THREE.Texture) => boolean) => ({
    begin: (t: THREE.Texture) => (sliceable(t) ? { t } : null),
    step: () => {
      steps++;
      return plan.shift() ?? 'done';
    },
  });

  beforeEach(() => {
    resetTextureWarmer();
    uploaded = [];
    steps = 0;
    plan = [];
    bindTextureWarmer((t) => { uploaded.push(t); });
  });

  afterEach(() => {
    resetTextureWarmer();
  });

  it('settles warmed only after the last band, never mid-slice', () => {
    bindSlicedUploader(stubSlicer(() => true));
    const outcomes: string[] = [];
    const big = new THREE.Texture();
    queueTextureWarm(big, (o) => outcomes.push(o));
    plan = ['more', 'more', 'done'];

    pumpTextureWarmQueue(6, 8.33);
    expect(outcomes).toEqual([]); // band 1: nothing may draw it yet
    pumpTextureWarmQueue(6, 8.33);
    expect(outcomes).toEqual([]); // band 2
    pumpTextureWarmQueue(6, 8.33);
    expect(outcomes).toEqual(['warmed']); // mip chain in, and only now
    expect(steps).toBe(3);
    expect(uploaded).toEqual([]); // never went through the one-shot path
  });

  it('leaves a small texture to the single-shot path', () => {
    bindSlicedUploader(stubSlicer(() => false));
    const small = new THREE.Texture();
    queueTextureWarm(small);
    pumpTextureWarmQueue(6, 8.33);
    expect(uploaded).toEqual([small]);
    expect(steps).toBe(0);
  });

  it('holds the queue behind the slice in flight', () => {
    bindSlicedUploader(stubSlicer((t) => t.name === 'big'));
    const big = new THREE.Texture();
    big.name = 'big';
    const small = new THREE.Texture();
    queueTextureWarm(big);
    queueTextureWarm(small);
    plan = ['more', 'done'];

    pumpTextureWarmQueue(6, 8.33);
    expect(uploaded).toEqual([]); // the small one waits its turn
    pumpTextureWarmQueue(6, 8.33);
    pumpTextureWarmQueue(6, 8.33);
    expect(uploaded).toEqual([small]);
  });

  it('reports failed rather than resident when a step gives up', () => {
    bindSlicedUploader(stubSlicer(() => true));
    const outcomes: string[] = [];
    const big = new THREE.Texture();
    queueTextureWarm(big, (o) => outcomes.push(o));
    plan = ['failed'];
    pumpTextureWarmQueue(6, 8.33);
    expect(outcomes).toEqual(['failed']);
  });

  it('re-queues a slice a lost context abandoned, and never settles it warmed', () => {
    bindSlicedUploader(stubSlicer(() => true));
    const outcomes: string[] = [];
    const big = new THREE.Texture();
    queueTextureWarm(big, (o) => outcomes.push(o));
    plan = ['more'];
    pumpTextureWarmQueue(6, 8.33);
    expect(outcomes).toEqual([]);

    abandonSlicedUpload();
    expect(outcomes).toEqual([]); // abandoning is not an outcome

    plan = ['done'];
    pumpTextureWarmQueue(6, 8.33); // the texture is back on the queue, so it restarts
    expect(outcomes).toEqual(['warmed']);
  });

  it('settles disposed, not warmed, for a texture freed mid-slice', () => {
    bindSlicedUploader(stubSlicer(() => true));
    const outcomes: string[] = [];
    const big = new THREE.Texture();
    queueTextureWarm(big, (o) => outcomes.push(o));
    plan = ['more', 'done'];
    pumpTextureWarmQueue(6, 8.33);
    big.dispose();
    pumpTextureWarmQueue(6, 8.33);
    expect(outcomes).toEqual(['disposed']);
  });
});
