import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  cancelTextureUpgrade,
  createLateTextureSlot,
  initialColorTierRank,
  planTextureRetry,
  shouldApplyColorTier,
  TEXTURE_LOAD_ATTEMPTS,
  type TextureUpgrade,
} from './PlanetFactory';

function upgrade(state: TextureUpgrade['state']): TextureUpgrade {
  return {
    key: 'moon',
    material: new THREE.MeshStandardMaterial(),
    state,
  };
}

describe('covered texture upgrades', () => {
  it('cancels an optional 4K fetch that missed its covered window', () => {
    const up = upgrade('loading');
    cancelTextureUpgrade(up);
    expect(up.state).toBe('cancelled');
    up.material.dispose();
  });

  it('does not cancel an upgrade before it starts or after it settles', () => {
    for (const state of ['idle', 'done', 'failed'] as const) {
      const up = upgrade(state);
      cancelTextureUpgrade(up);
      expect(up.state).toBe(state);
      up.material.dispose();
    }
  });
});

// Ranks: procedural floor 0, 2K 2, 4K 4.
describe('colour-tier ranking', () => {
  it('lets a real map replace the procedural floor', () => {
    expect(shouldApplyColorTier(0, 2)).toBe(true);
    expect(shouldApplyColorTier(0, 4)).toBe(true);
  });

  it('refuses a late 2K arrival over a 4K that already won', () => {
    expect(shouldApplyColorTier(4, 2)).toBe(false);
  });

  it('refuses a second map of the tier already applied', () => {
    expect(shouldApplyColorTier(2, 2)).toBe(false);
    expect(shouldApplyColorTier(4, 4)).toBe(false);
  });

  it('still lets the 4K upgrade land on a real 2K', () => {
    expect(shouldApplyColorTier(2, 4)).toBe(true);
  });

  it('ranks a construction texture by whether it is the fallback', () => {
    expect(initialColorTierRank({ userData: { proceduralFallback: true } })).toBe(0);
    expect(initialColorTierRank({ userData: {} })).toBe(2);
    expect(initialColorTierRank({})).toBe(2);
  });

  it('keeps a real construction map safe from a late duplicate', () => {
    const real = initialColorTierRank({ userData: {} });
    expect(shouldApplyColorTier(real, 2)).toBe(false);
    const fallback = initialColorTierRank({ userData: { proceduralFallback: true } });
    expect(shouldApplyColorTier(fallback, 2)).toBe(true);
  });
});

describe('late texture delivery', () => {
  class FakeTexture {
    disposed = false;
    dispose(): void { this.disposed = true; }
  }

  it('hands a late texture straight to a registered swap', () => {
    const slot = createLateTextureSlot<FakeTexture>();
    const got: FakeTexture[] = [];
    slot.connect((tex) => got.push(tex));
    const late = new FakeTexture();
    slot.deliver(late);
    expect(got).toEqual([late]);
    expect(late.disposed).toBe(false);
  });

  // The material does not exist until the awaiting caller resumes, so an
  // arrival can precede the registration — it must not be dropped.
  it('replays a texture that arrived before the material existed', () => {
    const slot = createLateTextureSlot<FakeTexture>();
    const late = new FakeTexture();
    slot.deliver(late);
    const got: FakeTexture[] = [];
    slot.connect((tex) => got.push(tex));
    expect(got).toEqual([late]);
  });

  it('replays a held texture exactly once', () => {
    const slot = createLateTextureSlot<FakeTexture>();
    slot.deliver(new FakeTexture());
    let calls = 0;
    slot.connect(() => { calls += 1; });
    expect(calls).toBe(1);
    slot.connect(() => { calls += 1; });
    expect(calls).toBe(1);
  });

  it('frees a hold that a second arrival supersedes', () => {
    const slot = createLateTextureSlot<FakeTexture>();
    const first = new FakeTexture();
    const second = new FakeTexture();
    slot.deliver(first);
    slot.deliver(second);
    expect(first.disposed).toBe(true);
    const got: FakeTexture[] = [];
    slot.connect((tex) => got.push(tex));
    expect(got).toEqual([second]);
    expect(second.disposed).toBe(false);
  });

  it('does nothing when no texture ever arrives', () => {
    const slot = createLateTextureSlot<FakeTexture>();
    let calls = 0;
    slot.connect(() => { calls += 1; });
    expect(calls).toBe(0);
  });
});

describe('bounded texture retries', () => {
  it('retries a failed fetch with a growing backoff', () => {
    expect(planTextureRetry(1)).toEqual({ retry: true, delayMs: 400 });
    expect(planTextureRetry(2)).toEqual({ retry: true, delayMs: 1200 });
  });

  it('stops once the attempt budget is spent', () => {
    expect(planTextureRetry(TEXTURE_LOAD_ATTEMPTS).retry).toBe(false);
    expect(planTextureRetry(TEXTURE_LOAD_ATTEMPTS + 5).retry).toBe(false);
  });

  it('schedules exactly one retry short of the budget', () => {
    let retries = 0;
    for (let failed = 1; failed <= TEXTURE_LOAD_ATTEMPTS; failed++) {
      if (planTextureRetry(failed).retry) retries += 1;
    }
    expect(retries).toBe(TEXTURE_LOAD_ATTEMPTS - 1);
  });

  it('honours a tighter budget and never retries before a failure', () => {
    expect(planTextureRetry(1, 1).retry).toBe(false);
    expect(planTextureRetry(0).retry).toBe(false);
  });

  it('keeps both retries inside the load timeout', () => {
    const total = planTextureRetry(1).delayMs + planTextureRetry(2).delayMs;
    expect(total).toBeLessThan(8000);
  });
});
