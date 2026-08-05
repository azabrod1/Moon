import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyColorTierTexture,
  cancelTextureUpgrade,
  connectLateDetailMap,
  createLateTextureSlot,
  initialColorTierRank,
  planTextureRetry,
  loadTexture,
  shouldApplyColorTier,
  TEXTURE_LOAD_ATTEMPTS,
  wireEarthLateDetail,
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

// ── The production seams themselves ──────────────────────────────────────────
// The suites above pin the pure decisions; these drive the seams the decisions
// wire into, so removing a delivery, a disposal, or a swap in the production
// code fails a test rather than only changing runtime behavior. The loader is
// faked (network) and the fallback constructor injected (its canvas needs a
// DOM); everything else — loadTexture, applyColorTierTexture,
// connectLateDetailMap — is the real code.

const loaderState = vi.hoisted(() => ({
  loads: [] as Array<{
    url: string;
    onLoad: (tex: unknown) => void;
    onError: (err: unknown) => void;
  }>,
}));

vi.mock('three', async (importOriginal) => {
  const three = await importOriginal<typeof import('three')>();
  class FakeTextureLoader {
    load(
      url: string,
      onLoad: (tex: unknown) => void,
      _onProgress: unknown,
      onError: (err: unknown) => void,
    ) {
      loaderState.loads.push({ url, onLoad, onError });
    }
  }
  return { ...three, TextureLoader: FakeTextureLoader };
});

/** A texture whose image carries no decode(), so the decode guards fall
 *  straight through synchronously in node. */
function fakeTexture(label: string): THREE.Texture {
  const tex = new THREE.Texture();
  tex.image = { width: 2048, height: 1024, label };
  return tex;
}

function fallbackTexture(): THREE.Texture {
  const tex = new THREE.Texture();
  tex.image = { width: 256, height: 128 };
  tex.userData.proceduralFallback = true;
  return tex;
}

function disposeSpy(tex: THREE.Texture): { disposed: boolean } {
  const flag = { disposed: false };
  tex.addEventListener('dispose', () => {
    flag.disposed = true;
  });
  return flag;
}

describe('loadTexture end-to-end (faked loader + injected fallback)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    loaderState.loads.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves the real texture when it beats the timeout, and never falls back', async () => {
    const promise = loadTexture('jupiter', '2k', 'color', { makeFallback: fallbackTexture });
    const real = fakeTexture('real');
    loaderState.loads[0].onLoad(real);
    await expect(promise).resolves.toBe(real);
    // The cleared timer must not fire a late fallback resolution.
    await vi.advanceTimersByTimeAsync(10_000);
  });

  it('resolves the fallback at the timeout, then delivers the late texture to the slot', async () => {
    const delivered: THREE.Texture[] = [];
    const late = { deliver: (t: THREE.Texture) => delivered.push(t), connect: () => {} };
    const promise = loadTexture('jupiter', '2k', 'color', { late, makeFallback: fallbackTexture });
    await vi.advanceTimersByTimeAsync(8_000);
    const settled = await promise;
    expect(settled.userData.proceduralFallback).toBe(true);
    const real = fakeTexture('late');
    loaderState.loads[0].onLoad(real);
    expect(delivered).toEqual([real]);
  });

  it('disposes a late texture when the caller passed no slot', async () => {
    const promise = loadTexture('jupiter', '2k', 'color', { makeFallback: fallbackTexture });
    await vi.advanceTimersByTimeAsync(8_000);
    await promise;
    const real = fakeTexture('late');
    const spy = disposeSpy(real);
    loaderState.loads[0].onLoad(real);
    expect(spy.disposed).toBe(true);
  });

  it('retries a failed fetch on the planned backoff and resolves the recovered texture', async () => {
    const promise = loadTexture('saturn', '2k', 'color', { makeFallback: fallbackTexture });
    loaderState.loads[0].onError(new Error('net down'));
    expect(loaderState.loads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(loaderState.loads).toHaveLength(2);
    loaderState.loads[1].onError(new Error('net down'));
    await vi.advanceTimersByTimeAsync(1_200);
    expect(loaderState.loads).toHaveLength(3);
    const real = fakeTexture('recovered');
    loaderState.loads[2].onLoad(real);
    await expect(promise).resolves.toBe(real);
  });

  it('settles for the fallback when the attempt budget is spent, and never fetches again', async () => {
    const promise = loadTexture('saturn', '2k', 'color', { makeFallback: fallbackTexture });
    loaderState.loads[0].onError(new Error('one'));
    await vi.advanceTimersByTimeAsync(400);
    loaderState.loads[1].onError(new Error('two'));
    await vi.advanceTimersByTimeAsync(1_200);
    loaderState.loads[2].onError(new Error('three'));
    const settled = await promise;
    expect(settled.userData.proceduralFallback).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(loaderState.loads).toHaveLength(3);
  });

  it('stops retrying after the fallback resolved when no late slot exists', async () => {
    const promise = loadTexture('saturn', '2k', 'color', { makeFallback: fallbackTexture });
    await vi.advanceTimersByTimeAsync(8_000);
    await promise;
    loaderState.loads[0].onError(new Error('late failure'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(loaderState.loads).toHaveLength(1);
  });
});

describe('applyColorTierTexture ownership', () => {
  it('swaps a fallback for the real map, moves the bump alias, and frees the fallback', () => {
    const fallback = fallbackTexture();
    const spy = disposeSpy(fallback);
    const mat = new THREE.MeshStandardMaterial({ map: fallback });
    mat.bumpMap = fallback; // the colour-as-bump alias on rocky bodies
    mat.userData.colorTierRank = initialColorTierRank(fallback);
    const real = fakeTexture('real2k');
    expect(applyColorTierTexture(mat, real, 2)).toBe(true);
    expect(mat.map).toBe(real);
    expect(mat.bumpMap).toBe(real);
    expect(mat.userData.colorTierRank).toBe(2);
    expect(spy.disposed).toBe(true);
  });

  it('refuses a late 2K over a 4K that already won, and disposes the loser', () => {
    const four = fakeTexture('won4k');
    const mat = new THREE.MeshStandardMaterial({ map: four });
    mat.userData.colorTierRank = 4;
    const late = fakeTexture('late2k');
    const spy = disposeSpy(late);
    expect(applyColorTierTexture(mat, late, 2)).toBe(false);
    expect(mat.map).toBe(four);
    expect(spy.disposed).toBe(true);
  });
});

describe('connectLateDetailMap', () => {
  it('assigns the arrival before freeing what it replaces, and flags the material', () => {
    const prev = fallbackTexture();
    const order: string[] = [];
    prev.addEventListener('dispose', () => order.push('disposed-prev'));
    const mat = new THREE.MeshStandardMaterial({ bumpMap: prev });
    mat.needsUpdate = false;
    const slot = createLateTextureSlot();
    connectLateDetailMap(
      slot,
      mat,
      () => mat.bumpMap,
      (tex) => {
        order.push('assigned');
        mat.bumpMap = tex;
      },
    );
    const real = fakeTexture('bump');
    slot.deliver(real);
    expect(order).toEqual(['assigned', 'disposed-prev']);
    expect(mat.bumpMap).toBe(real);
  });

  it('feeds a shader uniform the same way the night-lights material is wired', () => {
    const prev = fallbackTexture();
    const spy = disposeSpy(prev);
    const shader = new THREE.ShaderMaterial({ uniforms: { nightTexture: { value: prev } } });
    const slot = createLateTextureSlot();
    connectLateDetailMap(
      slot,
      shader,
      () => shader.uniforms.nightTexture.value as THREE.Texture | null,
      (tex) => {
        shader.uniforms.nightTexture.value = tex;
      },
    );
    const real = fakeTexture('night');
    slot.deliver(real);
    expect(shader.uniforms.nightTexture.value).toBe(real);
    expect(spy.disposed).toBe(true);
  });
});

describe('wireEarthLateDetail', () => {
  function slots() {
    return {
      night: createLateTextureSlot(),
      clouds: createLateTextureSlot(),
      bump: createLateTextureSlot(),
      roughness: createLateTextureSlot(),
    };
  }

  it('connects all four detail slots to their own channels', () => {
    const s = slots();
    const nightPrev = fallbackTexture();
    const nightMat = new THREE.ShaderMaterial({ uniforms: { nightTexture: { value: nightPrev } } });
    const cloudMat = new THREE.MeshStandardMaterial({ map: fallbackTexture() });
    const earthMat = new THREE.MeshStandardMaterial();
    earthMat.bumpMap = fallbackTexture();
    earthMat.roughnessMap = fallbackTexture();
    wireEarthLateDetail(s, nightMat, cloudMat, earthMat);
    const night = fakeTexture('night');
    const clouds = fakeTexture('clouds');
    const bump = fakeTexture('bump');
    const rough = fakeTexture('rough');
    s.night.deliver(night);
    s.clouds.deliver(clouds);
    s.bump.deliver(bump);
    s.roughness.deliver(rough);
    expect(nightMat.uniforms.nightTexture.value).toBe(night);
    expect(cloudMat.map).toBe(clouds);
    expect(earthMat.bumpMap).toBe(bump);
    expect(earthMat.roughnessMap).toBe(rough);
  });

  it('frees each fallback its arrival replaces — an unconnected slot would hold and leak instead', () => {
    const s = slots();
    const prevs = [fallbackTexture(), fallbackTexture(), fallbackTexture(), fallbackTexture()];
    const spies = prevs.map(disposeSpy);
    const nightMat = new THREE.ShaderMaterial({ uniforms: { nightTexture: { value: prevs[0] } } });
    const cloudMat = new THREE.MeshStandardMaterial({ map: prevs[1] });
    const earthMat = new THREE.MeshStandardMaterial();
    earthMat.bumpMap = prevs[2];
    earthMat.roughnessMap = prevs[3];
    wireEarthLateDetail(s, nightMat, cloudMat, earthMat);
    s.night.deliver(fakeTexture('n'));
    s.clouds.deliver(fakeTexture('c'));
    s.bump.deliver(fakeTexture('b'));
    s.roughness.deliver(fakeTexture('r'));
    expect(spies.map((f) => f.disposed)).toEqual([true, true, true, true]);
  });
});
