import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  bindTextureWarmer,
  invalidateTextureWarmCache,
  pumpTextureWarmQueue,
  queueTextureWarm,
  resetTextureWarmer,
} from './textureWarmer';

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
    pumpTextureWarmQueue(10);
    expect(uploaded).toEqual([]); // no upload fn yet — nothing to do, nothing lost
    bindTextureWarmer(upload);
    pumpTextureWarmQueue(10);
    expect(uploaded).toEqual([t]);
  });

  it('drains FIFO across pumps when the budget forces one upload per call', () => {
    bindTextureWarmer(upload);
    uploadCostMs = 10; // every upload alone exceeds the budget
    const a = new THREE.Texture();
    const b = new THREE.Texture();
    queueTextureWarm(a);
    queueTextureWarm(b);
    pumpTextureWarmQueue(6);
    expect(uploaded).toEqual([a]);
    pumpTextureWarmQueue(6);
    expect(uploaded).toEqual([a, b]);
  });

  it('always uploads at least one, and batches small uploads within budget', () => {
    bindTextureWarmer(upload);
    uploadCostMs = 1;
    const texes = [new THREE.Texture(), new THREE.Texture(), new THREE.Texture()];
    for (const t of texes) queueTextureWarm(t);
    pumpTextureWarmQueue(6); // 3×1ms fits one call
    expect(uploaded).toEqual(texes);
  });

  it('never uploads a texture disposed while queued', () => {
    bindTextureWarmer(upload);
    const dead = new THREE.Texture();
    const live = new THREE.Texture();
    queueTextureWarm(dead);
    queueTextureWarm(live);
    dead.dispose();
    pumpTextureWarmQueue(10);
    expect(uploaded).toEqual([live]); // and the dead entry consumed no budget
  });

  it('is idempotent per texture', () => {
    bindTextureWarmer(upload);
    const t = new THREE.Texture();
    queueTextureWarm(t);
    queueTextureWarm(t);
    pumpTextureWarmQueue(10);
    expect(uploaded).toEqual([t]);
  });

  it('does not re-upload a drained texture until it changes', () => {
    bindTextureWarmer(upload);
    const t = new THREE.Texture();
    queueTextureWarm(t);
    pumpTextureWarmQueue(10);
    queueTextureWarm(t);
    pumpTextureWarmQueue(10);
    expect(uploaded).toEqual([t]);

    t.needsUpdate = true; // increments Texture.version
    queueTextureWarm(t);
    pumpTextureWarmQueue(10);
    expect(uploaded).toEqual([t, t]);
  });

  it('allows textures to warm again after WebGL context loss', () => {
    bindTextureWarmer(upload);
    const t = new THREE.Texture();
    queueTextureWarm(t);
    pumpTextureWarmQueue(10);
    invalidateTextureWarmCache();
    queueTextureWarm(t);
    pumpTextureWarmQueue(10);
    expect(uploaded).toEqual([t, t]);
  });

  it('treats dispose after a drain as inert', () => {
    bindTextureWarmer(upload);
    const t = new THREE.Texture();
    queueTextureWarm(t);
    pumpTextureWarmQueue(10);
    expect(() => t.dispose()).not.toThrow();
    pumpTextureWarmQueue(10);
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
    expect(() => pumpTextureWarmQueue(10)).not.toThrow();
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
    pumpTextureWarmQueue(Number.POSITIVE_INFINITY);
    expect(calls).toEqual(['warmed@1']); // ran after the upload landed
    pumpTextureWarmQueue(Number.POSITIVE_INFINITY);
    expect(calls).toEqual(['warmed@1']);
  });

  it('settles warmed at once for a texture that is already resident', () => {
    bindTextureWarmer((tex) => uploaded.push(tex));
    const tex = new THREE.Texture();
    queueTextureWarm(tex);
    pumpTextureWarmQueue(Number.POSITIVE_INFINITY);
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
    pumpTextureWarmQueue(Number.POSITIVE_INFINITY);
    expect(calls).toEqual(['disposed']);
    expect(uploaded).toEqual([]);
  });

  it('settles failed for an upload that threw (the texture is not resident)', () => {
    bindTextureWarmer(() => { throw new Error('context lost'); });
    const tex = new THREE.Texture();
    const calls: string[] = [];
    queueTextureWarm(tex, (o) => calls.push(o));
    pumpTextureWarmQueue(Number.POSITIVE_INFINITY);
    expect(calls).toEqual(['failed']);
  });

  it('a callback registered on a re-queue of a pending texture replaces, not duplicates', () => {
    bindTextureWarmer((tex) => uploaded.push(tex));
    const tex = new THREE.Texture();
    const calls: string[] = [];
    queueTextureWarm(tex, () => calls.push('first'));
    queueTextureWarm(tex, () => calls.push('second'));
    pumpTextureWarmQueue(Number.POSITIVE_INFINITY);
    expect(calls).toEqual(['second']);
    expect(uploaded.length).toBe(1);
  });
});
