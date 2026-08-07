import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyColorTierTexture,
  cancelTextureUpgrade,
  connectLateDetailMap,
  createLateTextureSlot,
  createMoonMeshes,
  FALLBACK_AFTER_FAILURES,
  initialColorTierRank,
  loadTexture,
  shouldApplyColorTier,
  wireEarthLateDetail,
  type TextureUpgrade,
} from './PlanetFactory';
import { retryDelayMs, urlSpread } from './world/textureRetryPolicy';

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

  /** Advance to the retry the last failure scheduled, asserting it did not go
   *  out early. `failures` is how many have happened so far. */
  async function advanceToRetry(failures: number): Promise<void> {
    const delay = retryDelayMs(failures, urlSpread(loaderState.loads[0].url));
    const before = loaderState.loads.length;
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(loaderState.loads).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(loaderState.loads).toHaveLength(before + 1);
  }

  it('retries a failed fetch on the planned backoff and resolves the recovered texture', async () => {
    const promise = loadTexture('saturn', '2k', 'color', { makeFallback: fallbackTexture });
    loaderState.loads[0].onError(new Error('net down'));
    expect(loaderState.loads).toHaveLength(1);
    await advanceToRetry(1);
    const real = fakeTexture('recovered');
    loaderState.loads[1].onLoad(real);
    await expect(promise).resolves.toBe(real);
  });

  // The scene cannot wait out a real outage, so the procedural map resolves —
  // but the fetch behind it is never abandoned.
  it('settles for the fallback once the connection is plainly down, and keeps fetching', async () => {
    const late = createLateTextureSlot();
    const promise = loadTexture('saturn', '2k', 'color', { late, makeFallback: fallbackTexture });
    loaderState.loads[0].onError(new Error('one'));
    await advanceToRetry(1);
    loaderState.loads[1].onError(new Error('two'));
    const settled = await promise;
    expect(settled.userData.proceduralFallback).toBe(true);
    expect(FALLBACK_AFTER_FAILURES).toBe(2);
    await advanceToRetry(2);
    expect(loaderState.loads).toHaveLength(3);
  });

  it('adopts a texture that lands long after the fallback, through the late slot', async () => {
    const delivered: THREE.Texture[] = [];
    const late = { deliver: (t: THREE.Texture) => delivered.push(t), connect: () => {} };
    const promise = loadTexture('saturn', '2k', 'color', { late, makeFallback: fallbackTexture });
    for (let failure = 1; failure <= 12; failure++) {
      loaderState.loads[failure - 1].onError(new Error(`outage ${failure}`));
      await advanceToRetry(failure);
    }
    expect((await promise).userData.proceduralFallback).toBe(true);
    // Two full minutes of failures in, the ladder is still asking — and the
    // arrival goes to the same seam a 4K upgrade swaps through.
    const real = fakeTexture('recovered');
    loaderState.loads[12].onLoad(real);
    expect(delivered).toEqual([real]);
  });


  it('stops retrying after the fallback resolved when no late slot exists', async () => {
    const promise = loadTexture('saturn', '2k', 'color', { makeFallback: fallbackTexture });
    await vi.advanceTimersByTimeAsync(8_000);
    await promise;
    loaderState.loads[0].onError(new Error('late failure'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(loaderState.loads).toHaveLength(1);
  });

  // The other way the fallback resolves. A caller with nowhere to put a late
  // arrival must stop the ladder here too, or a body nobody can hand a map to
  // keeps polling for the session.
  it('stops retrying when the second failure resolved the fallback and no slot exists', async () => {
    const promise = loadTexture('saturn', '2k', 'color', { makeFallback: fallbackTexture });
    loaderState.loads[0].onError(new Error('one'));
    await advanceToRetry(1);
    loaderState.loads[1].onError(new Error('two'));
    expect((await promise).userData.proceduralFallback).toBe(true);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(loaderState.loads).toHaveLength(2);
  });
});

// ── The decode window ────────────────────────────────────────────────────────
// A texture that lands mid-session is decoded off-thread before it is assigned,
// and the material it was meant for can be torn down (or lose a rank race)
// while that decode is pending. Driven through the real moon-normal seam rather
// than the private helper, so the guard is pinned where it actually runs.

/** A texture whose decode the test settles by hand. */
function decodableTexture(label: string) {
  let fulfil!: () => void;
  let reject!: (err: unknown) => void;
  const decoded = new Promise<void>((res, rej) => { fulfil = res; reject = rej; });
  const tex = new THREE.Texture();
  tex.image = { width: 2048, height: 1024, label, decode: () => decoded };
  return {
    tex,
    /** Settle the decode and let the seam's `.then` callbacks run. */
    async settle(outcome: 'decoded' | 'failed') {
      if (outcome === 'decoded') fulfil();
      else reject(new Error('image decode failed'));
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

/** Listeners three is still holding on the texture — a guard that forgets to
 *  detach shows up here rather than as a slow leak. */
function disposeListenerCount(tex: THREE.Texture): number {
  const dispatcher = tex as unknown as { _listeners?: Record<string, unknown[] | undefined> };
  return dispatcher._listeners?.dispose?.length ?? 0;
}

describe('decode-window disposal', () => {
  beforeEach(() => {
    loaderState.loads.length = 0;
  });

  /** Earth's Moon is the one body with a measured normal map. */
  function moonNormalFetch() {
    const moons = createMoonMeshes('Earth');
    const mesh = moons.find((m) => m.data.name === 'Moon')!;
    const load = loaderState.loads.find((l) => l.url.includes('normal'))!;
    return { material: mesh.mesh.material as THREE.MeshStandardMaterial, load };
  }

  it('assigns a normal map that decodes cleanly', async () => {
    const { material, load } = moonNormalFetch();
    const arriving = decodableTexture('lola');
    load.onLoad(arriving.tex);
    expect(material.normalMap).toBeNull(); // not before the decode
    await arriving.settle('decoded');
    expect(material.normalMap).toBe(arriving.tex);
    expect(disposeListenerCount(arriving.tex)).toBe(0);
  });

  it('drops a texture disposed while its decode was still pending', async () => {
    const { material, load } = moonNormalFetch();
    const arriving = decodableTexture('lola');
    load.onLoad(arriving.tex);
    arriving.tex.dispose(); // the material lost the race, or was torn down
    await arriving.settle('decoded');
    expect(material.normalMap).toBeNull();
    expect(disposeListenerCount(arriving.tex)).toBe(0);
  });

  // A decode can fail on a corrupt image. The texture is still the one the
  // caller asked for, so it is adopted — three uploads it the old way.
  it('still adopts a texture whose decode rejected', async () => {
    const { material, load } = moonNormalFetch();
    const arriving = decodableTexture('lola');
    load.onLoad(arriving.tex);
    await arriving.settle('failed');
    expect(material.normalMap).toBe(arriving.tex);
    expect(disposeListenerCount(arriving.tex)).toBe(0);
  });

  it('drops a disposed texture on the rejected path too', async () => {
    const { material, load } = moonNormalFetch();
    const arriving = decodableTexture('lola');
    load.onLoad(arriving.tex);
    arriving.tex.dispose();
    await arriving.settle('failed');
    expect(material.normalMap).toBeNull();
    expect(disposeListenerCount(arriving.tex)).toBe(0);
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
