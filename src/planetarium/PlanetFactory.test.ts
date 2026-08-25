import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyColorTierTexture,
  applyNormalTierTexture,
  armArrivalWarmGoal,
  bindKtx2TierLoader,
  canAttempt,
  cancelTextureUpgrade,
  cancelNormalUpgrade,
  disarmArrivalWarmGoal,
  pumpArrivalWarmGoal,
  resolveTierFile,
  makeNormalUpgrade,
  normalUpgradePending,
  upgradeNormalOnApproach,
  connectLateDetailMap,
  createLateTextureSlot,
  createMoonMeshes,
  earnedUpgradeTier,
  FALLBACK_AFTER_FAILURES,
  firstTierPrefetchUrls,
  firstUpgradeTier,
  initialColorTierRank,
  loadTexture,
  lodMeasurementRelevant,
  makeGeometryUpgrade,
  makeTextureUpgrade,
  needsGeometryUpgrade,
  needsUpgradeCover,
  resolveUpgradeTier,
  setUpgradeTextureLoader,
  shouldApplyColorTier,
  TIER_RANK,
  upgradeComplete,
  upgradeGeometryOnApproach,
  upgradeTextureOnApproach,
  UPGRADE_TRIGGER_FRACTION,
  wireEarthLateDetail,
  type TextureUpgrade,
} from './PlanetFactory';
import { retryDelayMs, urlSpread } from './world/textureRetryPolicy';
import { captureDeviceTextureCaps, type TextureTier } from './world/texturePolicy';
import { bindTextureWarmer, pumpTextureWarmQueue, queueTextureWarm, resetTextureWarmer } from './world/textureWarmer';

// Device caps are captured from the live renderer; a fake renderer is the seam.
function withMaxTextureSize(size: number): void {
  captureDeviceTextureCaps({
    capabilities: { getMaxAnisotropy: () => 8, maxTextureSize: size },
  } as unknown as THREE.WebGLRenderer);
}

const materials: THREE.MeshStandardMaterial[] = [];

function handle(key: string): TextureUpgrade {
  const material = new THREE.MeshStandardMaterial();
  materials.push(material);
  const up = makeTextureUpgrade(key, material);
  if (!up) throw new Error(`no upgrade ladder for ${key}`);
  return up;
}

let generation = 0;
/** Put an attempt on a handle the way upgradeTextureOnApproach does, for the
 *  tests that are about what the handle then permits rather than what the
 *  fetch does. */
function startAttempt(up: TextureUpgrade, tier: TextureTier, startedAtMs = 0): number {
  up.attempt = { tier, generation: ++generation, startedAtMs };
  up.retryAtMs = undefined;
  return up.attempt.generation;
}

/** Disposal is an event, not a flag, on both textures and geometries. */
function watchDispose(resource: THREE.Texture | THREE.BufferGeometry): () => boolean {
  let disposed = false;
  resource.addEventListener('dispose', () => { disposed = true; });
  return () => disposed;
}

beforeEach(() => withMaxTextureSize(8192));

afterEach(() => {
  for (const mat of materials.splice(0)) mat.dispose();
  withMaxTextureSize(4096); // the pre-capture default
  resetTextureWarmer();
});

describe('upgrade ladders', () => {
  it('gives the Moon an 8K goal and the cloud deck a 4K one', () => {
    expect(handle('moon').tiers).toEqual(['4k', '8k']);
    expect(handle('moon').effectiveMaxTier).toBe('8k');
    expect(handle('earthClouds').tiers).toEqual(['4k']);
  });

  it('builds no ladder for a key with nothing higher on disk', () => {
    // Earth's day map ships one resolution only: nothing may ever request a
    // 4k/ or 8k/ URL for it.
    const mat = new THREE.MeshStandardMaterial();
    materials.push(mat);
    expect(makeTextureUpgrade('earthDay', mat)).toBeUndefined();
    expect(makeTextureUpgrade('venus', mat)).toBeUndefined();
    expect(makeTextureUpgrade(undefined, mat)).toBeUndefined();
  });

  it('settles at the ceiling a 4096-cap device can hold, without re-arming', () => {
    withMaxTextureSize(4096);
    const up = handle('moon');
    expect(up.effectiveMaxTier).toBe('4k');
    expect(resolveUpgradeTier(up, '8k')).toBe('4k');
    up.appliedTier = '4k';
    // Goal reached as far as this device is concerned — no further fetch, so
    // the trigger can't spin on a tier the GPU could never hold.
    expect(resolveUpgradeTier(up, '8k')).toBeNull();
    expect(canAttempt(up, 0)).toBe(false);
  });

  it('honours no step at all below 4096', () => {
    withMaxTextureSize(2048);
    const up = handle('moon');
    expect(firstUpgradeTier(up)).toBeNull();
    expect(canAttempt(up, 0)).toBe(false);
    expect(needsUpgradeCover(up)).toBe(false);
  });

  it('resolves the device ceiling once, at creation', () => {
    const up = handle('moon');
    expect(up.effectiveMaxTier).toBe('8k');
    // Caps are captured before any handle exists; re-reading them later would
    // make a handle's ceiling drift under it. Every reader must go through the
    // stored ceiling, not the live cap.
    withMaxTextureSize(2048);
    expect(up.effectiveMaxTier).toBe('8k');
    expect(firstUpgradeTier(up)).toBe('4k');
    expect(canAttempt(up, 0)).toBe(true);
  });
});

describe('screen-fraction band policy', () => {
  it('climbs one rung at a time from the boot map, even when the top is earned', () => {
    const up = handle('moon');
    const earned = earnedUpgradeTier(up, 0.35);
    expect(earned).toBe('8k');
    // The first rung is a quarter of the bytes, so the body sharpens seconds
    // sooner; a flyby that leaves before it applies never pays for the top
    // tier; and a phone whose 8K decode dies still holds the 4K it climbed
    // through. The top tier follows the moment the rung has applied.
    expect(resolveUpgradeTier(up, earned!)).toBe('4k');
    up.appliedTier = '4k';
    expect(resolveUpgradeTier(up, earned!)).toBe('8k');
  });

  it('stages the ladder when the approach crosses the lower fraction first', () => {
    const up = handle('moon');
    expect(earnedUpgradeTier(up, 0.2)).toBe('4k');
    up.appliedTier = '4k';
    expect(earnedUpgradeTier(up, 0.35)).toBe('8k');
    expect(resolveUpgradeTier(up, '8k')).toBe('8k');
  });

  it('earns nothing for a body still small on screen', () => {
    expect(earnedUpgradeTier(handle('moon'), 0.1)).toBeNull();
  });

  it('gives a single-step ladder its one tier', () => {
    expect(earnedUpgradeTier(handle('earthClouds'), 0.9)).toBe('4k');
  });

  it('reaches 8K at the telescope framing the tier exists for', () => {
    // Standing on Earth, the Observatory telescope's default framing puts the
    // Moon at 0.25 of the viewport height. The gate has to sit under that.
    expect(UPGRADE_TRIGGER_FRACTION['8k']).toBeLessThan(0.25);
    expect(earnedUpgradeTier(handle('moon'), 0.25)).toBe('8k');
  });

  it('needs the fraction strictly past a gate, not merely at it', () => {
    const up = handle('moon');
    expect(earnedUpgradeTier(up, UPGRADE_TRIGGER_FRACTION['8k']!)).toBe('4k');
    expect(earnedUpgradeTier(up, UPGRADE_TRIGGER_FRACTION['4k']!)).toBeNull();
  });
});

describe('upgrade attempts', () => {
  it('refuses a second fetch while one is in flight', () => {
    const up = handle('moon');
    startAttempt(up, '4k', 1_000);
    expect(canAttempt(up, 1_500)).toBe(false);
  });

  it('supersedes a fetch at exactly the hung-attempt age, not a moment before', () => {
    const up = handle('moon');
    startAttempt(up, '4k', 0);
    expect(canAttempt(up, 59_999)).toBe(false);
    expect(canAttempt(up, 60_000)).toBe(true);
  });

  it('keeps a released fetch running so it can still apply', () => {
    const up = handle('moon');
    const gen = startAttempt(up, '4k', 0);
    cancelTextureUpgrade(up, 'keep', 1_000);
    // Same attempt, same generation: the completion is not stale, so the map
    // applies on a later quiet frame instead of being thrown away.
    expect(up.attempt?.generation).toBe(gen);
    expect(up.retryAtMs).toBeUndefined();
  });

  it('discards an abandoned fetch and retries at exactly the cooldown instant', () => {
    const up = handle('moon');
    const gen = startAttempt(up, '4k', 0);
    cancelTextureUpgrade(up, 'discard', 1_000);
    // The completion no longer matches the handle, so it disposes itself.
    expect(up.attempt?.generation).not.toBe(gen);
    expect(up.retryAtMs).toBe(9_000);
    expect(canAttempt(up, 8_999)).toBe(false);
    expect(canAttempt(up, 9_000)).toBe(true);
  });
});

describe('arrival cover policy', () => {
  it('covers a body that has not got its first step yet', () => {
    const idle = handle('moon');
    expect(needsUpgradeCover(idle)).toBe(true);
    const loading = handle('moon');
    startAttempt(loading, '4k', 0);
    expect(needsUpgradeCover(loading)).toBe(true);
  });

  it('does not cover a fetch that jumped straight to the ceiling', () => {
    // The on-screen trigger can start an 8K fetch on a body still showing its
    // boot map; no landing waits behind a download that size.
    const up = handle('moon');
    startAttempt(up, '8k', 0);
    expect(needsUpgradeCover(up)).toBe(false);
  });

  it('does not cover a body already on a photo tier reaching for its goal', () => {
    const up = handle('moon');
    up.appliedTier = '4k';
    expect(needsUpgradeCover(up)).toBe(false);
    expect(canAttempt(up, 0)).toBe(true); // the 8K goal still rides the on-screen trigger
  });

  it('leaves a higher step\'s cooldown for the arrival to respect', () => {
    // An arrival clears retryAtMs only where it is covering the work. A failed
    // 8K keeps its cooldown across landings; only a failed first step is
    // retried under the cover.
    const up = handle('moon');
    up.appliedTier = '4k';
    up.retryAtMs = 9_000;
    expect(needsUpgradeCover(up)).toBe(false);
    expect(canAttempt(up, 8_999)).toBe(false);
  });
});

describe('what a fetch puts on the material', () => {
  type Pending = { url: string; onLoad: (tex: THREE.Texture) => void; onError: (err: unknown) => void };
  let pending: Pending[] = [];
  let restore: ((load: never) => void) | null = null;

  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  /** A texture whose decode this test releases by hand, so the window between
   *  arrival and apply — the one cancellation has to survive — is steerable. */
  function arriving(): { tex: THREE.Texture; finishDecode: () => void } {
    const tex = new THREE.Texture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    tex.image = { decode: () => gate };
    return { tex, finishDecode: release };
  }

  beforeEach(() => {
    pending = [];
    const previous = setUpgradeTextureLoader((url, onLoad, onError) => {
      pending.push({ url, onLoad, onError });
    });
    restore = () => setUpgradeTextureLoader(previous);
  });

  afterEach(() => {
    restore?.(undefined as never);
    restore = null;
  });

  it('applies a completed fetch and queues its upload', async () => {
    const uploaded: THREE.Texture[] = [];
    bindTextureWarmer((tex) => uploaded.push(tex));
    const up = handle('moon');
    up.appliedTier = '4k'; // past the first rung, the earned top is fetched directly
    upgradeTextureOnApproach(up, '8k', 1_000);
    expect(pending).toHaveLength(1);
    expect(pending[0].url).toMatch(/textures\/8k\/moon\.webp$/);

    const arrival = arriving();
    pending[0].onLoad(arrival.tex);
    arrival.finishDecode();
    await flush();

    expect(up.material.map).toBe(arrival.tex);
    expect(up.appliedTier).toBe('8k');
    expect(up.attempt).toBeUndefined();
    pumpTextureWarmQueue(Number.POSITIVE_INFINITY);
    expect(uploaded).toEqual([arrival.tex]);
  });

  it('drops a fetch abandoned before its image arrived', async () => {
    const up = handle('moon');
    upgradeTextureOnApproach(up, '4k', 0);
    cancelTextureUpgrade(up, 'discard', 0);

    const arrival = arriving();
    const disposed = watchDispose(arrival.tex);
    pending[0].onLoad(arrival.tex);
    await flush();

    expect(disposed()).toBe(true);
    expect(up.material.map).toBeNull();
    expect(up.appliedTier).toBeNull();
  });

  it('drops a fetch abandoned while its image was decoding', async () => {
    const up = handle('moon');
    upgradeTextureOnApproach(up, '4k', 0);

    const arrival = arriving();
    const disposed = watchDispose(arrival.tex);
    pending[0].onLoad(arrival.tex); // past the first check, now decoding
    cancelTextureUpgrade(up, 'discard', 0);
    arrival.finishDecode();
    await flush();

    expect(disposed()).toBe(true);
    expect(up.material.map).toBeNull();
    expect(up.appliedTier).toBeNull();
  });

  it('lets a released fetch apply after the cover has gone', async () => {
    const up = handle('moon');
    upgradeTextureOnApproach(up, '4k', 0);
    cancelTextureUpgrade(up, 'keep', 0);

    const arrival = arriving();
    pending[0].onLoad(arrival.tex);
    arrival.finishDecode();
    await flush();

    expect(up.material.map).toBe(arrival.tex);
    expect(up.appliedTier).toBe('4k');
  });

  it('cannot let a superseded fetch overwrite the one that replaced it', async () => {
    const up = handle('moon');
    upgradeTextureOnApproach(up, '4k', 0);
    upgradeTextureOnApproach(up, '8k', 61_000); // the first one hung; supersede it
    expect(pending).toHaveLength(2);

    const stale = arriving();
    const staleDisposed = watchDispose(stale.tex);
    pending[0].onLoad(stale.tex);
    await flush();
    expect(staleDisposed()).toBe(true);
    expect(up.material.map).toBeNull();

    const fresh = arriving();
    pending[1].onLoad(fresh.tex);
    fresh.finishDecode();
    await flush();
    expect(up.material.map).toBe(fresh.tex);
    // The superseding attempt re-resolved from the boot floor: the first rung.
    expect(up.appliedTier).toBe('4k');
  });

  it('walks the ladder through a first-rung failure to the top', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const up = handle('moon');
      // Close approach earns 8K, but from the boot map the climb starts at
      // the first rung — and that fetch dies (a 404, a dropped connection).
      upgradeTextureOnApproach(up, '8k', 0);
      expect(pending[0].url).toMatch(/4k\/moon/);
      pending[0].onError(new Error('network dropped'));
      expect(up.lastFailure).toEqual({ tier: '4k', streak: 1 });

      // Next attempt (cooldown passed, body still huge): the rung is retried,
      // succeeds, and clears its failure record.
      upgradeTextureOnApproach(up, '8k', 60_000);
      expect(pending[1].url).toMatch(/4k\/moon/);
      const arrival = arriving();
      pending[1].onLoad(arrival.tex);
      arrival.finishDecode();
      await flush();
      expect(up.appliedTier).toBe('4k');
      expect(up.lastFailure).toBeUndefined();

      // With the rung applied, the earned top is fetched directly — so a
      // failing top tier can only ever strand the ladder one rung short,
      // never on the boot map.
      upgradeTextureOnApproach(up, '8k', 120_000);
      expect(pending[2].url).toMatch(/8k\/moon/);
      const eight = arriving();
      pending[2].onLoad(eight.tex);
      eight.finishDecode();
      await flush();
      expect(up.appliedTier).toBe('8k');
    } finally {
      warn.mockRestore();
    }
  });

  it('backs off a repeatedly failing tier exponentially, capped', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const up = handle('moon');
      up.appliedTier = '4k'; // no rung left below the goal
      const delays: number[] = [];
      for (let i = 0; i < 7; i++) {
        up.retryAtMs = undefined;
        upgradeTextureOnApproach(up, '8k', i * 1_000_000);
        const before = performance.now();
        pending[pending.length - 1].onError(new Error('still failing'));
        delays.push((up.retryAtMs ?? 0) - before);
      }
      // 8s, 16s, 32s, 64s, 128s, then held at the cap.
      const tolerant = delays.map((d) => Math.round(d / 1000));
      expect(tolerant).toEqual([8, 16, 32, 64, 128, 128, 128]);
      expect(up.lastFailure).toEqual({ tier: '8k', streak: 7 });
    } finally {
      warn.mockRestore();
    }
  });

  it('streams the Moon relief tier once the disc has earned the first rung', async () => {
    const mat = new THREE.MeshStandardMaterial();
    materials.push(mat);
    const nu = makeNormalUpgrade('moonNormal', mat);
    expect(nu).toBeDefined();
    expect(makeNormalUpgrade('marsNormal', mat)).toBeUndefined(); // no tier on disk
    expect(makeNormalUpgrade(undefined, mat)).toBeUndefined();

    // Below the first colour rung's fraction the relief stays boot-tier.
    upgradeNormalOnApproach(nu, UPGRADE_TRIGGER_FRACTION['4k']!, 0);
    expect(pending).toHaveLength(0);
    expect(normalUpgradePending(nu)).toBe(true);

    upgradeNormalOnApproach(nu, 0.3, 0);
    expect(pending).toHaveLength(1);
    expect(pending[0].url).toMatch(/textures\/4k\/moon-normal\.webp$/);
    // In flight: the trigger must not double-fetch.
    upgradeNormalOnApproach(nu, 0.3, 1);
    expect(pending).toHaveLength(1);

    const arrival = arriving();
    pending[0].onLoad(arrival.tex);
    arrival.finishDecode();
    await flush();
    expect(mat.normalMap).toBe(arrival.tex);
    expect(normalUpgradePending(nu)).toBe(false); // done — the LOD loop stops measuring for it
    upgradeNormalOnApproach(nu, 0.9, 2);
    expect(pending).toHaveLength(1);
  });

  it('never lets a late boot relief downgrade the streamed tier', () => {
    const mat = new THREE.MeshStandardMaterial();
    materials.push(mat);
    const four = new THREE.Texture();
    const boot = new THREE.Texture();
    const bootDisposed = watchDispose(boot);
    expect(applyNormalTierTexture(mat, four, TIER_RANK['4k'])).toBe(true);
    // The durable boot fetch lands minutes later on a bad link: rank-guarded out.
    expect(applyNormalTierTexture(mat, boot, TIER_RANK['2k'])).toBe(false);
    expect(mat.normalMap).toBe(four);
    expect(bootDisposed()).toBe(true);
  });

  it('cools down a failed relief fetch, then lets the trigger ask again', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const mat = new THREE.MeshStandardMaterial();
      materials.push(mat);
      const nu = makeNormalUpgrade('moonNormal', mat)!;
      upgradeNormalOnApproach(nu, 0.3, 0);
      const before = performance.now();
      pending[0].onError(new Error('404'));
      expect(normalUpgradePending(nu)).toBe(true);
      expect(nu.retryAtMs).toBeGreaterThanOrEqual(before + 8_000);
      // Still cooling: no fetch. Past the cooldown: one more attempt.
      upgradeNormalOnApproach(nu, 0.3, nu.retryAtMs! - 1);
      expect(pending).toHaveLength(1);
      upgradeNormalOnApproach(nu, 0.3, nu.retryAtMs!);
      expect(pending).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('abandons a hung relief fetch at the attempt timeout, then tries again', async () => {
    const mat = new THREE.MeshStandardMaterial();
    materials.push(mat);
    const nu = makeNormalUpgrade('moonNormal', mat)!;
    upgradeNormalOnApproach(nu, 0.3, 0);
    expect(pending).toHaveLength(1);
    // A request that never calls back holds the handle only until the shared
    // attempt timeout; the next trigger past it starts a fresh fetch.
    upgradeNormalOnApproach(nu, 0.3, 59_999);
    expect(pending).toHaveLength(1);
    upgradeNormalOnApproach(nu, 0.3, 60_000);
    expect(pending).toHaveLength(2);
    // The abandoned attempt's eventual completion disposes itself.
    const stale = arriving();
    const staleDisposed = watchDispose(stale.tex);
    pending[0].onLoad(stale.tex);
    await flush();
    expect(mat.normalMap).toBeNull();
    expect(staleDisposed()).toBe(true);
    // The live attempt still lands normally.
    const live = arriving();
    pending[1].onLoad(live.tex);
    live.finishDecode();
    await flush();
    expect(mat.normalMap).toBe(live.tex);
    expect(normalUpgradePending(nu)).toBe(false);
  });

  it('drops a relief completion that lands after cancellation', async () => {
    const mat = new THREE.MeshStandardMaterial();
    materials.push(mat);
    const nu = makeNormalUpgrade('moonNormal', mat)!;
    upgradeNormalOnApproach(nu, 0.3, 0);
    expect(pending).toHaveLength(1);
    // Mode disposal abandons the attempt; the late callback must not write to
    // the torn-down material or queue an upload into the reset warmer.
    cancelNormalUpgrade(nu);
    const arrival = arriving();
    const disposed = watchDispose(arrival.tex);
    pending[0].onLoad(arrival.tex);
    await flush();
    expect(mat.normalMap).toBeNull();
    expect(disposed()).toBe(true);
  });

  it('denies the relief tier to a device that cannot hold it', () => {
    withMaxTextureSize(2048);
    const mat = new THREE.MeshStandardMaterial();
    materials.push(mat);
    expect(makeNormalUpgrade('moonNormal', mat)).toBeUndefined();
  });

  it('stamps a failed fetch\'s cooldown from the moment it failed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const up = handle('moon');
      upgradeTextureOnApproach(up, '4k', 0); // a start stamp far from the real clock
      const before = performance.now();
      pending[0].onError(new Error('404'));
      const after = performance.now();
      expect(up.attempt).toBeUndefined();
      // Wall clock at failure, not the attempt's start stamp: a cooldown
      // measured from the start would already be in the past.
      expect(up.retryAtMs).toBeGreaterThanOrEqual(before + 8_000);
      expect(up.retryAtMs).toBeLessThanOrEqual(after + 8_000);
    } finally {
      warn.mockRestore();
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

  it('keeps the cloud deck on the higher tier when its boot-tier fetch recovers late', () => {
    // The deck is the one late slot that is also a ranked colour map, so it
    // takes arrivals from two directions. In this order — boot fetch times
    // out, the approach installs 4K, the boot fetch finally recovers — a
    // direct assign would free the 4K and leave the deck downgraded for the
    // session, because the upgrade handle still reports 4K applied and never
    // fetches it again.
    const s = slots();
    const fallback = fallbackTexture();
    const cloudMat = new THREE.MeshStandardMaterial({ map: fallback });
    materials.push(cloudMat);
    cloudMat.userData.colorTierRank = initialColorTierRank(fallback);
    wireEarthLateDetail(
      s,
      new THREE.ShaderMaterial({ uniforms: { nightTexture: { value: null } } }),
      cloudMat,
      new THREE.MeshStandardMaterial(),
    );

    const sharp = fakeTexture('clouds-4k');
    expect(applyColorTierTexture(cloudMat, sharp, TIER_RANK['4k'])).toBe(true);

    const recovered = fakeTexture('clouds-2k');
    const recoveredSpy = disposeSpy(recovered);
    s.clouds.deliver(recovered);

    expect(cloudMat.map).toBe(sharp);
    // The loser is freed rather than left resident with nothing pointing at it.
    expect(recoveredSpy.disposed).toBe(true);
  });

  it('still adopts a recovered boot-tier deck when nothing better has landed', () => {
    const s = slots();
    const fallback = fallbackTexture();
    const cloudMat = new THREE.MeshStandardMaterial({ map: fallback });
    materials.push(cloudMat);
    cloudMat.userData.colorTierRank = initialColorTierRank(fallback);
    wireEarthLateDetail(
      s,
      new THREE.ShaderMaterial({ uniforms: { nightTexture: { value: null } } }),
      cloudMat,
      new THREE.MeshStandardMaterial(),
    );
    const recovered = fakeTexture('clouds-2k');
    s.clouds.deliver(recovered);
    expect(cloudMat.map).toBe(recovered);
  });
});

describe('silhouette detail', () => {
  function sphere(radiusAU: number, segments: number): THREE.Mesh {
    return new THREE.Mesh(new THREE.SphereGeometry(radiusAU, segments, segments / 2));
  }
  const widthSegments = (mesh: THREE.Mesh) =>
    (mesh.geometry as THREE.SphereGeometry).parameters.widthSegments;

  it('leaves a body alone until its chords could show', () => {
    const mesh = sphere(1, 64);
    const before = mesh.geometry;
    const up = makeGeometryUpgrade([{ mesh, radiusAU: 1 }]);
    expect(needsGeometryUpgrade(up, 900)).toBe(false);
    expect(upgradeGeometryOnApproach(up, 900)).toBe(false);
    expect(mesh.geometry).toBe(before);
    expect(up.applied).toBe(false);
  });

  it('needs the footprint strictly past the threshold, not merely at it', () => {
    const mesh = sphere(1, 64);
    const up = makeGeometryUpgrade([{ mesh, radiusAU: 1 }]);
    expect(upgradeGeometryOnApproach(up, 1250)).toBe(false);
    expect(upgradeGeometryOnApproach(up, 1251)).toBe(true);
  });

  it('rebuilds every sphere at its own radius and disposes what it replaced', () => {
    // Earth's shape: globe plus the two shells that draw an edge at the body's
    // own radius, each of which has to keep its offset.
    const globe = sphere(1, 64);
    const night = sphere(1.001, 64);
    const clouds = sphere(1.01, 64);
    const dropped = [globe, night, clouds].map((m) => watchDispose(m.geometry));
    const up = makeGeometryUpgrade([
      { mesh: globe, radiusAU: 1 },
      { mesh: night, radiusAU: 1.001 },
      { mesh: clouds, radiusAU: 1.01 },
    ]);

    expect(upgradeGeometryOnApproach(up, 4000)).toBe(true);
    for (const mesh of [globe, night, clouds]) expect(widthSegments(mesh)).toBe(256);
    expect((globe.geometry as THREE.SphereGeometry).parameters.radius).toBe(1);
    expect((night.geometry as THREE.SphereGeometry).parameters.radius).toBe(1.001);
    expect((clouds.geometry as THREE.SphereGeometry).parameters.radius).toBe(1.01);
    expect(dropped.map((d) => d())).toEqual([true, true, true]);
  });

  it('rebuilds once and then stops asking', () => {
    const mesh = sphere(1, 48);
    const up = makeGeometryUpgrade([{ mesh, radiusAU: 1 }]);
    expect(upgradeGeometryOnApproach(up, 4000)).toBe(true);
    const fine = mesh.geometry;
    const disposedAfter = watchDispose(fine);

    expect(needsGeometryUpgrade(up, 9000)).toBe(false);
    expect(upgradeGeometryOnApproach(up, 9000)).toBe(false);
    expect(mesh.geometry).toBe(fine); // the same buffers, not an identical rebuild
    expect(disposedAfter()).toBe(false);
  });

  it('keeps the transform the render curve writes', () => {
    // Mesh scale carries the moon render-curve inflation and the rotation
    // carries the real phase; a geometry swap must not touch either.
    const mesh = sphere(1, 48);
    mesh.scale.setScalar(3.5);
    mesh.rotation.set(0.1, 0.2, 0.3);
    const up = makeGeometryUpgrade([{ mesh, radiusAU: 1 }]);
    upgradeGeometryOnApproach(up, 4000);
    expect(mesh.scale.x).toBe(3.5);
    expect(mesh.scale.y).toBe(3.5);
    expect(mesh.scale.z).toBe(3.5);
    expect([mesh.rotation.x, mesh.rotation.y, mesh.rotation.z]).toEqual([0.1, 0.2, 0.3]);
  });

  it('builds the fine sphere full and 2:1, with untouched angular extents', () => {
    // A partial phi/theta range or a squashed height count would keep the
    // texture registered wrong or the pole caps coarse while every other
    // assertion here still passes.
    const mesh = sphere(1, 64);
    const up = makeGeometryUpgrade([{ mesh, radiusAU: 1 }]);
    upgradeGeometryOnApproach(up, 4000);
    const p = (mesh.geometry as THREE.SphereGeometry).parameters;
    expect(p.widthSegments).toBe(256);
    expect(p.heightSegments).toBe(128);
    expect(p.phiStart).toBe(0);
    expect(p.phiLength).toBe(Math.PI * 2);
    expect(p.thetaStart).toBe(0);
    expect(p.thetaLength).toBe(Math.PI);
  });

  it('disposes a replaced geometry exactly once', () => {
    const mesh = sphere(1, 64);
    let disposals = 0;
    mesh.geometry.addEventListener('dispose', () => disposals++);
    const up = makeGeometryUpgrade([{ mesh, radiusAU: 1 }]);
    upgradeGeometryOnApproach(up, 4000);
    upgradeGeometryOnApproach(up, 4000);
    expect(disposals).toBe(1);
  });
});

describe('upgradeComplete', () => {
  const handle = (appliedTier: TextureTier | null, effectiveMaxTier: TextureTier) =>
    ({ appliedTier, effectiveMaxTier }) as TextureUpgrade;

  it('is the settled state the per-frame loop skips on', () => {
    expect(upgradeComplete(handle(null, '8k'))).toBe(false); // still on the boot map
    expect(upgradeComplete(handle('4k', '8k'))).toBe(false); // mid-ladder
    expect(upgradeComplete(handle('8k', '8k'))).toBe(true); // goal reached
    expect(upgradeComplete(handle('4k', '4k'))).toBe(true); // device ceiling reached
  });
});

describe('colour tier precedence', () => {
  it('keeps the highest tier whichever order the maps arrive in', () => {
    const mat = new THREE.MeshStandardMaterial();
    materials.push(mat);
    const big = new THREE.Texture();
    expect(applyColorTierTexture(mat, big, TIER_RANK['8k'])).toBe(true);
    expect(mat.map).toBe(big);

    const late = new THREE.Texture();
    const lateDisposed = watchDispose(late);
    expect(applyColorTierTexture(mat, late, TIER_RANK['4k'])).toBe(false);
    expect(mat.map).toBe(big);
    expect(lateDisposed()).toBe(true);
  });

  it('moves a colour-as-bump alias onto the upgraded map', () => {
    // Pluto (and every non-gas body without a normal map) aliases one texture
    // as both colour and bump; the alias must never point at freed memory.
    const base = new THREE.Texture();
    const mat = new THREE.MeshStandardMaterial({ map: base, bumpMap: base });
    materials.push(mat);
    const baseDisposed = watchDispose(base);
    const sharp = new THREE.Texture();
    expect(applyColorTierTexture(mat, sharp, TIER_RANK['4k'])).toBe(true);
    expect(mat.map).toBe(sharp);
    expect(mat.bumpMap).toBe(sharp);
    expect(baseDisposed()).toBe(true);
  });

  it('drops a superseded map that was still waiting in the warm queue', () => {
    const uploaded: THREE.Texture[] = [];
    bindTextureWarmer((tex) => uploaded.push(tex));
    const mat = new THREE.MeshStandardMaterial();
    materials.push(mat);

    const mid = new THREE.Texture();
    applyColorTierTexture(mat, mid, TIER_RANK['4k']);
    queueTextureWarm(mid);

    const big = new THREE.Texture();
    applyColorTierTexture(mat, big, TIER_RANK['8k']); // disposes mid
    queueTextureWarm(big);

    pumpTextureWarmQueue(Number.POSITIVE_INFINITY);
    // Uploading the disposed map would allocate GPU storage nothing frees.
    expect(uploaded).toEqual([big]);
  });
});

describe('lodMeasurementRelevant', () => {
  const H = 844;
  const geoApplied = () => ({ ...makeGeometryUpgrade([]), applied: true });

  it('pulls the measurement when the overestimate crosses the geometry threshold', () => {
    const geo = makeGeometryUpgrade([]);
    expect(lodMeasurementRelevant(geo, [], 1251, H, null)).toBe(true);
    expect(lodMeasurementRelevant(geo, [], 1249, H, null)).toBe(false);
    expect(lodMeasurementRelevant(geoApplied(), [], 1e6, H, null)).toBe(false);
  });

  it('pulls the measurement when an unfinished ladder could earn a tier', () => {
    withMaxTextureSize(16384);
    const up = handle('moon'); // ['4k', '8k']
    expect(lodMeasurementRelevant(geoApplied(), [up], 0.16 * H, H, null)).toBe(true);
    expect(lodMeasurementRelevant(geoApplied(), [up], 0.14 * H, H, null)).toBe(false);
    up.appliedTier = '8k'; // ladder complete: nothing to earn at any size
    expect(lodMeasurementRelevant(geoApplied(), [up], 1e6, H, null)).toBe(false);
  });

  it('keeps measuring a partially-climbed ladder, but not a band it already climbed', () => {
    withMaxTextureSize(16384);
    const up = handle('moon');
    up.appliedTier = '4k';
    expect(lodMeasurementRelevant(geoApplied(), [up], 0.23 * H, H, null)).toBe(true);
    // Inside the 4K band with 4K already applied nothing is fetchable: the
    // earned tier must also RESOLVE to a remaining step to pull a measurement.
    expect(lodMeasurementRelevant(geoApplied(), [up], 0.16 * H, H, null)).toBe(false);
    expect(lodMeasurementRelevant(geoApplied(), [up], 0.14 * H, H, null)).toBe(false);
  });

  it('pulls the measurement for an eligible procedural moon above its disc threshold', () => {
    expect(lodMeasurementRelevant(geoApplied(), [], 81, H, 80)).toBe(true);
    expect(lodMeasurementRelevant(geoApplied(), [], 79, H, 80)).toBe(false);
    expect(lodMeasurementRelevant(geoApplied(), [], 500, H, null)).toBe(false);
  });

  it('an Infinity estimate (near/straddling pose) always measures while work remains', () => {
    withMaxTextureSize(16384);
    const up = handle('moon');
    expect(lodMeasurementRelevant(geoApplied(), [up], Infinity, H, null)).toBe(true);
    expect(lodMeasurementRelevant(makeGeometryUpgrade([]), [], Infinity, H, null)).toBe(true);
  });
});

describe('arrival warm goals', () => {
  let pending: Array<{ url: string; onLoad: (tex: THREE.Texture) => void; onError: (err: unknown) => void }>;
  let restore: (() => void) | null = null;
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  /** Complete a pending fetch with an instantly-decoding texture. */
  async function land(entry: { onLoad: (tex: THREE.Texture) => void }): Promise<THREE.Texture> {
    const tex = new THREE.Texture();
    tex.image = { decode: () => Promise.resolve() };
    entry.onLoad(tex);
    await flush();
    return tex;
  }

  beforeEach(() => {
    pending = [];
    const previous = setUpgradeTextureLoader((url, onLoad, onError) => {
      pending.push({ url, onLoad, onError });
    });
    restore = () => setUpgradeTextureLoader(previous);
  });

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('arms to the top tier an approach can earn', () => {
    const up = handle('moon');
    expect(armArrivalWarmGoal(up)).toBe(true);
    expect(up.warmGoal).toBe('8k');
  });

  it('refuses to arm when the device holds no step', () => {
    withMaxTextureSize(2048);
    const up = handle('moon');
    expect(armArrivalWarmGoal(up)).toBe(false);
    expect(up.warmGoal).toBeUndefined();
    expect(pumpArrivalWarmGoal(up, 0)).toBe(false);
    expect(pending).toHaveLength(0);
  });

  it('climbs the whole ladder rung by rung from a single arm', async () => {
    const up = handle('moon');
    armArrivalWarmGoal(up);
    expect(pumpArrivalWarmGoal(up, 0)).toBe(true);
    expect(pending).toHaveLength(1);
    expect(pending[0].url).toMatch(/textures\/4k\/moon\.webp$/);
    // In flight: further pumps start nothing.
    expect(pumpArrivalWarmGoal(up, 16)).toBe(true);
    expect(pending).toHaveLength(1);

    await land(pending[0]);
    expect(up.appliedTier).toBe('4k');
    expect(pumpArrivalWarmGoal(up, 32)).toBe(true);
    expect(pending).toHaveLength(2);
    expect(pending[1].url).toMatch(/textures\/8k\/moon\.webp$/);

    await land(pending[1]);
    expect(up.appliedTier).toBe('8k');
    // Goal reached: the pump disarms and reports itself prunable.
    expect(pumpArrivalWarmGoal(up, 48)).toBe(false);
    expect(up.warmGoal).toBeUndefined();
  });

  it('settles at the device ceiling', async () => {
    withMaxTextureSize(4096);
    const up = handle('moon');
    expect(armArrivalWarmGoal(up)).toBe(true);
    pumpArrivalWarmGoal(up, 0);
    expect(pending).toHaveLength(1);
    await land(pending[0]);
    expect(up.appliedTier).toBe('4k');
    // 8K is out of this device's reach — the goal is done, not stuck.
    expect(pumpArrivalWarmGoal(up, 16)).toBe(false);
    expect(pending).toHaveLength(1);
  });

  it('hands a failed tier back to the on-screen trigger instead of retrying', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const up = handle('moon');
      armArrivalWarmGoal(up);
      pumpArrivalWarmGoal(up, 0);
      pending[0].onError(new Error('offline'));
      await flush();
      // Disarmed: no background retry loop, even long past the cooldown.
      expect(pumpArrivalWarmGoal(up, 10_000_000)).toBe(false);
      expect(pending).toHaveLength(1);
      expect(up.warmGoal).toBeUndefined();
      // The demand-driven trigger path is untouched and retries as always.
      upgradeTextureOnApproach(up, '4k', 10_000_000);
      expect(pending).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('never warm-fetches a tier that already failed before arming', () => {
    const up = handle('moon');
    up.lastFailure = { tier: '4k', streak: 1 };
    expect(armArrivalWarmGoal(up)).toBe(true);
    // Cooldown long over — the warm-up still declines; only the on-screen
    // trigger may retry a tier with a failure on record.
    expect(pumpArrivalWarmGoal(up, 10_000_000)).toBe(false);
    expect(pending).toHaveLength(0);
    expect(up.warmGoal).toBeUndefined();
  });

  it('disarm stops the climb between rungs', async () => {
    const up = handle('moon');
    armArrivalWarmGoal(up);
    pumpArrivalWarmGoal(up, 0);
    await land(pending[0]);
    expect(up.appliedTier).toBe('4k');
    disarmArrivalWarmGoal(up);
    expect(pumpArrivalWarmGoal(up, 16)).toBe(false);
    expect(pending).toHaveLength(1); // the 8K fetch never starts
  });
});

describe('the compressed 8K tier override', () => {
  let pending: Array<{ url: string; onLoad: (tex: THREE.Texture) => void; onError: (err: unknown) => void }>;
  let restore: (() => void) | null = null;
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    pending = [];
    const previous = setUpgradeTextureLoader((url, onLoad, onError) => {
      pending.push({ url, onLoad, onError });
    });
    restore = () => setUpgradeTextureLoader(previous);
  });

  afterEach(() => {
    bindKtx2TierLoader(null);
    restore?.();
    restore = null;
  });

  it('is inert while no KTX2 loader is bound: the classic map is fetched', () => {
    expect(resolveTierFile('moon', '8k')).toBe('moon.webp');
    const up = handle('moon');
    up.appliedTier = '4k';
    upgradeTextureOnApproach(up, '8k', 0);
    expect(pending).toHaveLength(1);
    expect(pending[0].url).toMatch(/textures\/8k\/moon\.webp$/);
  });

  it('routes the 8K through the bound loader and leaves every other rung classic', async () => {
    const ktx2Calls: Array<{ url: string; onLoad: (tex: THREE.Texture) => void }> = [];
    bindKtx2TierLoader((url, onLoad) => ktx2Calls.push({ url, onLoad }));
    expect(resolveTierFile('moon', '8k')).toBe('moon.ktx2');
    expect(resolveTierFile('moon', '4k')).toBe('moon.webp');
    expect(resolveTierFile('earthClouds', '4k')).toBe('earth-clouds.webp');

    const up = handle('moon');
    up.appliedTier = '4k';
    upgradeTextureOnApproach(up, '8k', 0);
    expect(pending).toHaveLength(0); // never the image path
    expect(ktx2Calls).toHaveLength(1);
    expect(ktx2Calls[0].url).toMatch(/textures\/8k\/moon\.ktx2$/);

    // A compressed arrival applies through the same rank machinery. Its
    // loader-set colour space must survive applyTextureDefaults untouched.
    const uploaded: THREE.Texture[] = [];
    bindTextureWarmer((t) => uploaded.push(t));
    const tex = new THREE.CompressedTexture([], 8192, 4096);
    tex.colorSpace = THREE.SRGBColorSpace;
    ktx2Calls[0].onLoad(tex);
    await flush();
    expect(up.appliedTier).toBe('8k');
    expect(up.material.map).toBe(tex);
    expect(tex.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(tex.userData.mutableStorage).toBeUndefined(); // compressed keeps texStorage2D
    pumpTextureWarmQueue(Number.POSITIVE_INFINITY);
    expect(uploaded).toEqual([tex]);
  });
});

describe('firstTierPrefetchUrls', () => {
  it('lists each unfetched first tier once, likeliest destinations first', () => {
    const ups = [handle('jupiter'), handle('mars'), handle('moon'), handle('jupiter')];
    expect(firstTierPrefetchUrls(ups)).toEqual([
      '/textures/4k/moon.webp',
      '/textures/4k/mars.webp',
      '/textures/4k/jupiter.webp',
    ]);
  });

  it('skips handles that already applied a tier — their veil never waits', () => {
    const mars = handle('mars');
    mars.appliedTier = '4k';
    expect(firstTierPrefetchUrls([mars, handle('pluto')])).toEqual(['/textures/4k/pluto.webp']);
  });

  it('prefetches nothing a capped device could never load', () => {
    withMaxTextureSize(2048);
    expect(firstTierPrefetchUrls([handle('moon'), handle('jupiter')])).toEqual([]);
  });
});
