import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyColorTierTexture,
  applyNormalTierTexture,
  armArrivalWarmGoal,
  arrivalWarmGoalsExpired,
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
  firstUpgradeTier,
  initialColorTierRank,
  loadTexture,
  appliedTierGpuBytes,
  appliedTierHeldBytes,
  bindTierAdmission,
  cancelTierRelease,
  equirectMapGpuBytes,
  expireTierRelease,
  ladderMapReferenceWidth,
  reachableTopTier,
  releaseBandFraction,
  releaseColorTier,
  releaseDue,
  releaseDwellMs,
  releaseExpired,
  releaseTargetTier,
  releaseUpgradeSource,
  retainedSourceBytes,
  startTierRelease,
  takeRestoreRefetch,
  textureGpuBytes,
  tierUploadBytes,
  trackReleaseBand,
  RELEASE_ATTEMPT_TIMEOUT_MS,
  RELEASE_BAND_DIVISOR,
  RELEASE_REEARN_GRACE_MS,
  RESTORE_STANDIN_WIDTH,
  type TierAdmission,
  lodMeasurementRelevant,
  makeGeometryUpgrade,
  makeTextureUpgrade,
  materialColorMap,
  needsGeometryUpgrade,
  needsUpgradeCover,
  resolveUpgradeTier,
  setUpgradeTextureLoader,
  shouldApplyColorTier,
  TEXTURE_UPGRADE_TIERS,
  TIER_RANK,
  upgradeComplete,
  upgradeGeometryOnApproach,
  upgradeTextureOnApproach,
  UPGRADE_TRIGGER_FRACTION,
  upgradeTriggerFraction,
  wireEarthLateDetail,
  type TextureUpgrade,
} from './PlanetFactory';
import { retryDelayMs, urlSpread } from './world/textureRetryPolicy';
import { captureDeviceCaps, resetDeviceCapsForTests, TIER_MAP_WIDTH, type TextureTier } from './world/texturePolicy';
import { ladderCeilingBytes, LEGACY_DESKTOP_PROFILE, LEGACY_TOUCH_PROFILE } from './world/gpuEnvelope';
import { SECTOR_SETS, sectorSetGpuBytes } from './world/sectorStreamer';
import { bindTextureWarmer, pumpTextureWarmQueue, queueTextureWarm, resetTextureWarmer } from './world/textureWarmer';

// Device caps are captured from the live renderer; a fake renderer is the
// seam. Production captures once, so a test asking a second question clears
// the first.
function withMaxTextureSize(size: number, touch = false): void {
  resetDeviceCapsForTests();
  captureDeviceCaps({
    capabilities: { getMaxAnisotropy: () => 8, maxTextureSize: size },
  } as unknown as THREE.WebGLRenderer, touch ? LEGACY_TOUCH_PROFILE : LEGACY_DESKTOP_PROFILE);
}

const materials: THREE.MeshStandardMaterial[] = [];

/** A ladder handle over a standard material. TextureUpgrade.material is
 *  THREE.Material — a shader shell (Earth's night lights) climbs the same
 *  ladder — so the narrower type is stated here once, for the cases that
 *  poke at `map` and `bumpMap` directly. */
type StandardUpgrade = TextureUpgrade & { material: THREE.MeshStandardMaterial };

function handle(key: string): StandardUpgrade {
  const material = new THREE.MeshStandardMaterial();
  materials.push(material);
  const up = makeTextureUpgrade(key, material);
  if (!up) throw new Error(`no upgrade ladder for ${key}`);
  return up as StandardUpgrade;
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
  it('gives the Moon and the cloud deck an 8K goal', () => {
    expect(handle('moon').tiers).toEqual(['4k', '8k']);
    expect(handle('moon').effectiveMaxTier).toBe('8k');
    expect(handle('earthClouds').tiers).toEqual(['4k', '8k']);
    expect(handle('earthClouds').effectiveMaxTier).toBe('8k');
  });

  it('caps the cloud deck at 4K on a touch device, and caps nothing else', () => {
    // The one cap that is not about memory: a full-screen transparent shell
    // at 8K is shaded per pixel over the whole globe, on the devices with the
    // least fill rate to spend. The Moon's 8K is a memory question, and the
    // envelope answers it wherever it is asked.
    withMaxTextureSize(16384, true);
    expect(handle('earthClouds').effectiveMaxTier).toBe('4k');
    expect(resolveUpgradeTier(handle('earthClouds'), '8k')).toBe('4k');
    expect(handle('moon').effectiveMaxTier).toBe('8k');
    // Desktop keeps both goals.
    withMaxTextureSize(16384, false);
    expect(handle('moon').effectiveMaxTier).toBe('8k');
    expect(handle('earthClouds').effectiveMaxTier).toBe('8k');
  });

  it('builds no ladder for a key with nothing higher on disk', () => {
    // Earth's day map ships one resolution only: nothing may ever request a
    // 4k/ or 8k/ URL for it.
    const mat = new THREE.MeshStandardMaterial();
    materials.push(mat);
    expect(makeTextureUpgrade('earthDay', mat)).toBeUndefined();
    expect(makeTextureUpgrade('uranus', mat)).toBeUndefined();
    expect(makeTextureUpgrade('neptune', mat)).toBeUndefined();
    expect(makeTextureUpgrade(undefined, mat)).toBeUndefined();
  });

  it('ships one 4K step for Mercury, Venus and Saturn (their SSS sources passed the same-product gate)', () => {
    for (const key of ['mercury', 'venus', 'saturn']) {
      const mat = new THREE.MeshStandardMaterial();
      materials.push(mat);
      expect(makeTextureUpgrade(key, mat)?.tiers, key).toEqual(['4k']);
    }
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
    expect(earnedUpgradeTier(handle('mars'), 0.9)).toBe('4k');
  });

  it('holds the cloud deck at 4K until Earth is close, past the telescope gate', () => {
    // The deck's 8K is for the close approach, where the 16K ground sectors
    // arrive; the Moon's 0.22 gate would fetch it for every boot-view Earth.
    const up = handle('earthClouds');
    expect(upgradeTriggerFraction('earthClouds', '8k')).toBeGreaterThan(UPGRADE_TRIGGER_FRACTION['8k']!);
    expect(upgradeTriggerFraction('earthClouds', '4k')).toBe(UPGRADE_TRIGGER_FRACTION['4k']);
    expect(upgradeTriggerFraction('moon', '8k')).toBe(UPGRADE_TRIGGER_FRACTION['8k']);
    expect(earnedUpgradeTier(up, 0.3)).toBe('4k');
    expect(earnedUpgradeTier(up, 0.9)).toBe('8k');
    // The measurement skip agrees: a 4K deck at 0.3 pulls no projection.
    up.appliedTier = '4k';
    const geo = { applied: true } as unknown as Parameters<typeof lodMeasurementRelevant>[0];
    expect(lodMeasurementRelevant(geo, [up], 0.3 * 1000, 1000, null)).toBe(false);
    expect(lodMeasurementRelevant(geo, [up], 0.9 * 1000, 1000, null)).toBe(true);
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

    expect(materialColorMap(up.material)).toBe(arrival.tex);
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
    expect(materialColorMap(up.material)).toBeNull();
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
    expect(materialColorMap(up.material)).toBeNull();
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

    expect(materialColorMap(up.material)).toBe(arrival.tex);
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
    expect(materialColorMap(up.material)).toBeNull();

    const fresh = arriving();
    pending[1].onLoad(fresh.tex);
    fresh.finishDecode();
    await flush();
    expect(materialColorMap(up.material)).toBe(fresh.tex);
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

describe('the ladder\'s live weight', () => {
  const mib = (bytes: number) => bytes / (1024 * 1024);

  it('counts an equirect map as RGBA8 with its mips', () => {
    expect(mib(equirectMapGpuBytes(4096))).toBeCloseTo(42.7, 1);
    expect(mib(equirectMapGpuBytes(8192))).toBeCloseTo(170.7, 1);
    // A transcoded upload is one byte a texel, not four.
    expect(mib(equirectMapGpuBytes(8192, true))).toBeCloseTo(42.7, 1);
    expect(equirectMapGpuBytes(0)).toBe(0);
  });

  it('weighs a handle by the tier it has applied, and nothing while it is on its boot map', () => {
    const material = new THREE.MeshStandardMaterial();
    const up = makeTextureUpgrade('moon', material)!;
    expect(appliedTierGpuBytes(up)).toBe(0); // still on the map it booted with
    up.appliedTier = '4k';
    expect(mib(appliedTierGpuBytes(up))).toBeCloseTo(42.7, 1);
    up.appliedTier = '8k';
    expect(mib(appliedTierGpuBytes(up))).toBeCloseTo(170.7, 1);
    // …at a quarter of that once the 8K arrives GPU-compressed.
    material.map = new THREE.Texture();
    (material.map as unknown as { isCompressedTexture: boolean }).isCompressedTexture = true;
    expect(mib(appliedTierGpuBytes(up))).toBeCloseTo(42.7, 1);
  });
});

describe('Earth\'s night lights on the colour ladder', () => {
  // The night map is a colour map on a shader shell rather than in `map`, so
  // it is the one place the ladder has to find a material's map somewhere
  // else. Everything below is the same machinery the globe and the cloud deck
  // use — that is the point of it.
  function nightMaterial(boot: THREE.Texture | null): THREE.ShaderMaterial {
    const mat = new THREE.ShaderMaterial({ uniforms: { nightTexture: { value: boot } } });
    wireEarthLateDetail(
      { night: createLateTextureSlot(), clouds: createLateTextureSlot(), bump: createLateTextureSlot(), roughness: createLateTextureSlot() },
      mat, new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial(),
    );
    return mat;
  }

  it('reads and writes the map through the uniform the material names', () => {
    const boot = fakeTexture('boot');
    const mat = nightMaterial(boot);
    expect(materialColorMap(mat)).toBe(boot);
    const sharper = fakeTexture('4k');
    expect(applyColorTierTexture(mat, sharper, TIER_RANK['4k'])).toBe(true);
    expect(mat.uniforms.nightTexture.value).toBe(sharper);
    expect(materialColorMap(mat)).toBe(sharper);
    // …and a standard material is still read out of `map`.
    const std = new THREE.MeshStandardMaterial({ map: boot });
    expect(materialColorMap(std)).toBe(boot);
  });

  it('refuses a lower tier once a higher one is on the shell', () => {
    const mat = nightMaterial(fakeTexture('boot'));
    const sharper = fakeTexture('8k');
    applyColorTierTexture(mat, sharper, TIER_RANK['8k']);
    const late = fakeTexture('2k late');
    const spy = disposeSpy(late);
    expect(applyColorTierTexture(mat, late, TIER_RANK['2k'])).toBe(false);
    expect(mat.uniforms.nightTexture.value).toBe(sharper);
    expect(spy.disposed).toBe(true);
  });

  it('stops at 4K on every profile — there is no 8K night map to fetch', () => {
    withMaxTextureSize(16384);
    expect(makeTextureUpgrade('earthNight', nightMaterial(null))!.tiers).toEqual(['4k']);
    expect(makeTextureUpgrade('earthNight', nightMaterial(null))!.effectiveMaxTier).toBe('4k');
    withMaxTextureSize(16384, true);
    expect(makeTextureUpgrade('earthNight', nightMaterial(null))!.effectiveMaxTier).toBe('4k');
  });

  it('weighs against the sector envelope like any other colour map', () => {
    withMaxTextureSize(16384);
    const mat = nightMaterial(fakeTexture('boot'));
    const up = makeTextureUpgrade('earthNight', mat)!;
    expect(appliedTierGpuBytes(up)).toBe(0); // still on the boot map
    up.appliedTier = '4k';
    mat.uniforms.nightTexture.value = new THREE.Texture({ width: 4096, height: 2048 } as unknown as HTMLImageElement);
    expect(appliedTierGpuBytes(up) / (1024 * 1024)).toBeCloseTo(42.7, 1);
  });
});

describe('the ladder against the sector memory envelope', () => {
  const mib = (bytes: number) => bytes / (1024 * 1024);
  /** Every body with a ladder on the top tier this profile allows, all at
   *  once, with nothing GPU-compressed — the heaviest the ladder can be on a
   *  device whose transcoder is unavailable and every optional map has been
   *  earned. `appliedTierGpuBytes` reads the texture, so the maps here are
   *  the real widths of the tiers. */
  function ladderWorstCaseBytes(touch: boolean): number {
    withMaxTextureSize(16384, touch);
    let bytes = 0;
    for (const key of Object.keys(TEXTURE_UPGRADE_TIERS)) {
      const material = new THREE.MeshStandardMaterial();
      materials.push(material);
      const up = makeTextureUpgrade(key, material)!;
      up.appliedTier = up.effectiveMaxTier;
      const width = up.appliedTier === '8k' ? 8192 : 4096;
      material.map = new THREE.Texture({ width, height: width / 2 } as unknown as HTMLImageElement);
      bytes += appliedTierGpuBytes(up);
    }
    return bytes;
  }

  it('leaves a desktop five sector sets at its heaviest, and its whole budget in the case it really hits', () => {
    const worst = ladderWorstCaseBytes(false);
    // Seven 4K maps — six planets and the night lights — plus TWO 8K ones,
    // the Moon and the cloud deck: a desktop that has toured every body,
    // earned every top rung and cannot transcode the Moon's compressed tier
    // still has 128 MiB of the envelope left, five Earth sector sets. It is
    // reachable, unlike the phone's below: it sits under the ladder's own
    // ceiling (the envelope less the tiles' floor), so nothing refuses it.
    expect(mib(worst)).toBeCloseTo(640.0, 1);
    expect(worst).toBeLessThanOrEqual(
      ladderCeilingBytes(LEGACY_DESKTOP_PROFILE, LEGACY_DESKTOP_PROFILE.sectorFloorBytes),
    );
    const worstBudget = LEGACY_DESKTOP_PROFILE.envelopeBytes - worst;
    expect(mib(worstBudget)).toBeCloseTo(128.0, 1);
    expect(worstBudget / sectorSetGpuBytes(SECTOR_SETS.Earth)).toBeGreaterThanOrEqual(5);
    // The case a desktop session actually reaches: the Moon's 8K ships
    // GPU-compressed, which hands ~128 MiB more back and leaves the sector
    // budget whole — the streamer runs at its own cap, eleven Earth sets,
    // with the envelope no longer the binding limit.
    const real = worst - equirectMapGpuBytes(8192) + equirectMapGpuBytes(8192, true);
    const budget = LEGACY_DESKTOP_PROFILE.envelopeBytes - real;
    expect(mib(budget)).toBeCloseTo(256.0, 1);
    // Whole to within the rounding of nine map estimates, not 3 bytes short
    // of anything the streamer can spend.
    expect(LEGACY_DESKTOP_PROFILE.ceilingBytes - budget).toBeLessThan(1024);
    expect(budget / sectorSetGpuBytes(SECTOR_SETS.Earth)).toBeGreaterThanOrEqual(11);
  });

  it('never lets a phone reach its heaviest: the rung that would is refused', () => {
    // Every ladder at its top at once, on a device whose transcoder is
    // unavailable — what the ladder USED to be able to hold, since nothing
    // ever asked whether the next map fit.
    const worst = ladderWorstCaseBytes(true);
    expect(mib(worst)).toBeGreaterThan(mib(LEGACY_TOUCH_PROFILE.envelopeBytes));
    // It is now unreachable. The rung that would cross the envelope less the
    // tiles' floor is refused before it is fetched, so the ladder settles
    // under that line and the tiles keep their floor whatever the session
    // has toured.
    const ceiling = ladderCeilingBytes(LEGACY_TOUCH_PROFILE, LEGACY_TOUCH_PROFILE.sectorFloorBytes);
    expect(mib(ceiling)).toBeCloseTo(273.7, 1);
    expect(LEGACY_TOUCH_PROFILE.envelopeBytes - ceiling)
      .toBeGreaterThanOrEqual(2 * sectorSetGpuBytes(SECTOR_SETS.Earth));
    // Six 4K maps fit under it; the seventh does not.
    const map4k = equirectMapGpuBytes(4096);
    expect(6 * map4k).toBeLessThanOrEqual(ceiling);
    expect(7 * map4k).toBeGreaterThan(ceiling);
  });

  it('charges a GPU-compressed rung the blocks its container really carries', () => {
    withMaxTextureSize(16384);
    const material = new THREE.MeshStandardMaterial();
    materials.push(material);
    const up = makeTextureUpgrade('moon', material)!;
    up.appliedTier = '8k';
    // A transcoded 8K with a full mip chain at 4 bits a texel.
    const mipmaps: Array<{ width: number; height: number; data: Uint8Array }> = [];
    for (let w = 8192, h = 4096; w >= 4; w >>= 1, h >>= 1) {
      mipmaps.push({ width: w, height: h, data: new Uint8Array((w * h) / 2) });
    }
    material.map = new THREE.CompressedTexture(mipmaps, 8192, 4096);
    expect(mib(appliedTierGpuBytes(up))).toBeCloseTo(21.3, 1);
    // …and the nominal figure only stands in for a texture with no image.
    material.map = new THREE.Texture();
    expect(mib(appliedTierGpuBytes(up))).toBeCloseTo(170.7, 1);
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
    expect(materialColorMap(up.material)).toBe(tex);
    expect(tex.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(tex.userData.mutableStorage).toBeUndefined(); // compressed keeps texStorage2D
    pumpTextureWarmQueue(Number.POSITIVE_INFINITY);
    expect(uploaded).toEqual([tex]);
  });
});

describe('the release band', () => {
  it('sits strictly below the trigger that earned the rung, for every ladder', () => {
    // The band is anchored to the TRIGGER, never to the fraction a body
    // happened to measure when it earned the tier: every committed arrival
    // earns at fraction 1, so a band a third of THAT would sit above the
    // trigger and flap forever at the framing the tier exists for.
    for (const [key, tiers] of Object.entries(TEXTURE_UPGRADE_TIERS)) {
      for (const tier of tiers) {
        const trigger = upgradeTriggerFraction(key, tier)!;
        expect(releaseBandFraction(key, tier), `${key} ${tier}`).toBe(trigger / RELEASE_BAND_DIVISOR);
        expect(releaseBandFraction(key, tier), `${key} ${tier}`).toBeLessThan(trigger);
      }
    }
  });

  it('holds a rung earned by an arrival at the framing that arrival lands on', () => {
    const up = handle('moon');
    // The teleport arms at fraction 1 and both rungs apply under the veil.
    armArrivalWarmGoal(up);
    up.appliedTier = '8k';
    // The player pulls back to a quarter of the viewport — still earning the
    // 8K (its trigger is 0.22), and nowhere near giving it back.
    trackReleaseBand(up, 0.25, 1_000);
    expect(up.belowBandSinceMs).toBeUndefined();
    expect(releaseDue(up, 60_000)).toBe(false);
  });

  it('tracks the clock continuously and resets on every crossing back up', () => {
    const up = handle('moon');
    up.appliedTier = '4k';
    const band = releaseBandFraction('moon', '4k');
    trackReleaseBand(up, band - 0.001, 1_000);
    expect(up.belowBandSinceMs).toBe(1_000);
    trackReleaseBand(up, band - 0.001, 5_000);
    expect(up.belowBandSinceMs).toBe(1_000); // still the same stay
    trackReleaseBand(up, band + 0.001, 6_000);
    expect(up.belowBandSinceMs).toBeUndefined();
    trackReleaseBand(up, 0, 7_000);
    expect(up.belowBandSinceMs).toBe(7_000);
  });

  it('waits out eight seconds for a 4K rung, at any frame rate', () => {
    expect(releaseDwellMs('4k', false)).toBe(8_000);
    for (const hz of [30, 60]) {
      const up = handle('mars');
      up.appliedTier = '4k';
      const step = 1_000 / hz;
      let due: number | null = null;
      for (let t = 0; t <= 20_000; t += step) {
        trackReleaseBand(up, 0, t);
        if (due === null && releaseDue(up, t)) due = t;
      }
      expect(due, `${hz} Hz`).not.toBeNull();
      expect(due!, `${hz} Hz`).toBeGreaterThanOrEqual(8_000);
      expect(due!, `${hz} Hz`).toBeLessThan(8_000 + step + 1);
    }
  });

  it('waits thirty for an 8K one, and eight when it arrived compressed', () => {
    expect(releaseDwellMs('8k', false)).toBe(30_000);
    expect(releaseDwellMs('8k', true)).toBe(8_000);
    const up = handle('moon');
    up.appliedTier = '8k';
    const step = 1_000 / 60;
    for (let t = 0; t <= 40_000; t += step) trackReleaseBand(up, 0, t);
    expect(releaseDue(up, 29_000)).toBe(false);
    expect(releaseDue(up, 30_001)).toBe(true);
    // The compressed rung re-uploads in milliseconds, so it is as cheap to
    // take back as a 4K.
    const compressed = new THREE.Texture();
    (compressed as unknown as { isCompressedTexture: boolean }).isCompressedTexture = true;
    up.material.map = compressed;
    expect(releaseDue(up, 8_001)).toBe(true);
  });

  it('never counts a dwell for a body that has hovered around the band', () => {
    const up = handle('mars');
    up.appliedTier = '4k';
    const band = releaseBandFraction('mars', '4k');
    const step = 1_000 / 30;
    // Half a minute of alternating just under and just over the band.
    for (let t = 0; t <= 30_000; t += step) {
      trackReleaseBand(up, Math.floor(t / 1_000) % 2 === 0 ? band - 0.001 : band + 0.001, t);
      expect(releaseDue(up, t), `t=${t}`).toBe(false);
    }
  });

  it('has nothing to give while the body is on its boot map', () => {
    const up = handle('mars');
    trackReleaseBand(up, 0, 1_000);
    expect(up.belowBandSinceMs).toBeUndefined();
    expect(releaseDue(up, 60_000)).toBe(false);
    expect(releaseTargetTier(up)).toBeNull();
  });

  it('names the tier below: one rung down, or the boot map', () => {
    const up = handle('moon');
    up.appliedTier = '8k';
    expect(releaseTargetTier(up)).toBe('4k');
    up.appliedTier = '4k';
    expect(releaseTargetTier(up)).toBe('2k'); // the map every device boots with
  });
});

describe('what a release puts on the material', () => {
  type Pending = { url: string; onLoad: (tex: THREE.Texture) => void; onError: (err: unknown) => void };
  let pending: Pending[] = [];
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
    restore?.();
    restore = null;
  });

  /** A handle on a real 4K map, as a body that has climbed one rung has. */
  function onFourK(key = 'moon'): StandardUpgrade {
    const up = handle(key);
    const map = new THREE.Texture({ width: 4096, height: 2048 } as unknown as HTMLImageElement);
    up.material.map = map;
    up.material.userData.colorTierRank = TIER_RANK['4k'];
    up.material.userData.photoLoaded = true;
    up.appliedTier = '4k';
    return up;
  }

  it('fetches the map below and swaps it in once it has decoded', async () => {
    const up = onFourK();
    up.appliedTier = '8k';
    up.material.userData.colorTierRank = TIER_RANK['8k'];
    expect(startTierRelease(up, 1_000)).toBe(true);
    expect(pending).toHaveLength(1);
    expect(pending[0].url).toMatch(/textures\/4k\/moon\.webp$/);
    // The body draws its 8K map the whole time the fetch is in the air.
    expect(up.appliedTier).toBe('8k');
    expect(up.material.userData.colorTierRank).toBe(TIER_RANK['8k']);

    const low = new THREE.Texture({ width: 4096, height: 2048 } as unknown as HTMLImageElement);
    pending[0].onLoad(low);
    await flush();
    expect(up.material.map).toBe(low);
    expect(up.appliedTier).toBe('4k');
    expect(up.material.userData.colorTierRank).toBe(TIER_RANK['4k']);
    expect(up.release).toBeUndefined();
  });

  it('drops to the boot map when the rung it gives back is the first', async () => {
    const up = onFourK('mars');
    expect(startTierRelease(up, 1_000)).toBe(true);
    expect(pending[0].url).toMatch(/textures\/mars\.v2\.webp$/);
    pending[0].onLoad(new THREE.Texture());
    await flush();
    // The boot map is not a member of the ladder, so the handle is back where
    // it started and the climb begins from the bottom rung again.
    expect(up.appliedTier).toBeNull();
    expect(up.material.userData.colorTierRank).toBe(2);
    expect(resolveUpgradeTier(up, '4k')).toBe('4k');
  });

  it('keeps the high map until the low one is on the material', async () => {
    const up = onFourK();
    const high = up.material.map!;
    const wasDisposed = watchDispose(high);
    let mapAtDispose: THREE.Texture | null | undefined;
    high.addEventListener('dispose', () => { mapAtDispose = up.material.map; });
    startTierRelease(up, 1_000);
    expect(wasDisposed()).toBe(false); // still drawing the high one, mid-fetch
    const low = new THREE.Texture();
    pending[0].onLoad(low);
    await flush();
    expect(up.material.map).toBe(low);
    // Assigned before disposed, exactly like the way up: no frame samples a
    // freed texture, and none draws a body with no map.
    expect(mapAtDispose).toBe(low);
    expect(wasDisposed()).toBe(true);
  });

  it('carries the colour-as-bump alias and keeps the body a photographed one', async () => {
    const up = onFourK('mars');
    up.material.bumpMap = up.material.map; // a body that bumps off its colour map
    startTierRelease(up, 1_000);
    const low = new THREE.Texture();
    pending[0].onLoad(low);
    await flush();
    expect(up.material.bumpMap).toBe(low); // never left pointing at freed memory
    // The body still has a real photograph on it: the lazy painter must not
    // start painting over the map a release just put there.
    expect(up.material.userData.photoLoaded).toBe(true);
  });

  it('earns nothing for five seconds afterwards', async () => {
    const up = onFourK();
    up.appliedTier = '8k';
    up.warmGoal = '8k'; // the arrival that fetched it is over; the goal is not
    startTierRelease(up, 1_000);
    pending[0].onLoad(new THREE.Texture());
    await flush();
    const releasedAt = up.releasedAtMs!;
    expect(canAttempt(up, releasedAt + RELEASE_REEARN_GRACE_MS - 1)).toBe(false);
    expect(canAttempt(up, releasedAt + RELEASE_REEARN_GRACE_MS + 1)).toBe(true);
    // …and the goal that would have climbed straight back up is gone with it.
    expect(up.warmGoal).toBeUndefined();
    expect(resolveUpgradeTier(up, '8k')).toBe('8k'); // still climbable, just not now
  });

  it('takes one swap at a time, and never while a rung is being fetched', () => {
    const up = onFourK();
    expect(startTierRelease(up, 1_000)).toBe(true);
    expect(startTierRelease(up, 1_100)).toBe(false);
    expect(pending).toHaveLength(1);
    cancelTierRelease(up);
    const climbing = onFourK();
    startAttempt(climbing, '8k', 1_000);
    expect(startTierRelease(climbing, 1_000)).toBe(false);
  });

  it('keeps the map it has when the fetch fails, and says so once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const up = onFourK();
      const high = up.material.map!;
      const settled: boolean[] = [];
      startTierRelease(up, 1_000, { onSettled: (ok) => settled.push(ok) });
      pending[0].onError(new Error('offline'));
      await flush();
      expect(settled).toEqual([false]);
      expect(up.material.map).toBe(high);
      expect(up.appliedTier).toBe('4k');
      expect(up.release).toBeUndefined();
      expect(up.releasedAtMs).toBeUndefined(); // nothing was given back
    } finally {
      warn.mockRestore();
    }
  });

  it('waits out a cooldown after a swap that could not be fetched', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const up = onFourK();
      up.belowBandSinceMs = 0;
      expect(releaseDue(up, 60_000)).toBe(true);
      startTierRelease(up, 60_000);
      pending[0].onError(new Error('offline'));
      await flush();
      // The same body is the farthest candidate again on the very next
      // frame; without the cooldown the planner would ask it for the rest of
      // the session.
      expect(releaseDue(up, up.releaseRetryAtMs! - 1)).toBe(false);
      expect(releaseDue(up, up.releaseRetryAtMs! + 1)).toBe(true);
      expect(up.releaseFailures).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('abandons a swap that has been in the air too long', () => {
    const up = onFourK();
    startTierRelease(up, 1_000);
    expect(releaseExpired(up, 1_000 + RELEASE_ATTEMPT_TIMEOUT_MS)).toBe(false);
    expect(releaseExpired(up, 1_001 + RELEASE_ATTEMPT_TIMEOUT_MS)).toBe(true);
    cancelTierRelease(up);
    expect(releaseExpired(up, 60_000)).toBe(false); // nothing in the air
  });

  it('drops a swap that lands after it was abandoned', async () => {
    const up = onFourK();
    const high = up.material.map!;
    startTierRelease(up, 1_000);
    cancelTierRelease(up); // a teleport, a timeout, mode disposal
    const low = new THREE.Texture();
    const wasDisposed = watchDispose(low);
    pending[0].onLoad(low);
    await flush();
    expect(up.material.map).toBe(high);
    expect(wasDisposed()).toBe(true);
    expect(up.appliedTier).toBe('4k');
  });

  it('re-fetches the same tier on a restore, and calls it no release', async () => {
    // A rung closes its decoded source once the upload is paid, so a lost GL
    // context has nothing to re-upload from: the map is fetched again at the
    // tier the body already had.
    const up = onFourK();
    expect(startTierRelease(up, 1_000, { restore: true })).toBe(true);
    expect(pending[0].url).toMatch(/textures\/4k\/moon\.webp$/);
    const again = new THREE.Texture();
    pending[0].onLoad(again);
    await flush();
    expect(up.material.map).toBe(again);
    expect(up.appliedTier).toBe('4k'); // unchanged: nothing was given back
    expect(up.releasedAtMs).toBeUndefined();
    expect(canAttempt(up, 1_100)).toBe(true);
  });

  it('puts a lower map on a material only through the deliberate swap', () => {
    // The rank guard exists to stop a late arrival undoing a finer map, so
    // the way down cannot go through it.
    const mat = new THREE.MeshStandardMaterial();
    materials.push(mat);
    mat.userData.colorTierRank = TIER_RANK['8k'];
    const low = new THREE.Texture();
    expect(applyColorTierTexture(mat, low, TIER_RANK['4k'])).toBe(false);
    const other = new THREE.Texture();
    releaseColorTier(mat, other, TIER_RANK['4k']);
    expect(mat.map).toBe(other);
    expect(mat.userData.colorTierRank).toBe(TIER_RANK['4k']);
  });
});

describe('what the ladder is allowed to hold', () => {
  type Pending = { url: string; onLoad: (tex: THREE.Texture) => void; onError: (err: unknown) => void };
  let pending: Pending[] = [];
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
    bindTierAdmission(null);
    bindKtx2TierLoader(null);
    restore?.();
    restore = null;
  });

  const always = (verdict: TierAdmission) => bindTierAdmission(() => verdict);

  it('does not start a fetch the ledger blocks', () => {
    always('blocked');
    const up = handle('moon');
    upgradeTextureOnApproach(up, '4k', 1_000);
    expect(pending).toHaveLength(0);
    // A refusal is arithmetic, not a failure: no cooldown, no attempt, and
    // the same question is asked again the next frame.
    expect(up.attempt).toBeUndefined();
    expect(up.retryAtMs).toBeUndefined();
    expect(up.lastFailure).toBeUndefined();
    expect(canAttempt(up, 1_016)).toBe(true);
    bindTierAdmission(null);
    upgradeTextureOnApproach(up, '4k', 1_016);
    expect(pending).toHaveLength(1);
  });

  it('keeps a warm goal that is only blocked, and drops one that can never fit', () => {
    always('blocked');
    const up = handle('moon');
    expect(armArrivalWarmGoal(up)).toBe(true);
    expect(pumpArrivalWarmGoal(up, 1_000)).toBe(true); // a release may still make room
    expect(up.warmGoal).toBe('8k');
    expect(pending).toHaveLength(0);
    always('refuse');
    expect(pumpArrivalWarmGoal(up, 2_000)).toBe(false);
    expect(up.warmGoal).toBeUndefined();
    // And a goal aimed at a rung nothing could ever fit never arms at all.
    expect(armArrivalWarmGoal(handle('mars'))).toBe(false);
  });

  it('drops a decoded map that turns out not to fit, and keeps the rung it has', async () => {
    // The estimate that admitted the fetch is nominal; the texture in hand is
    // the real figure, and a 4x transcode fallback is exactly the case.
    let verdict: TierAdmission = 'admit';
    bindTierAdmission(() => verdict);
    const up = handle('moon');
    const boot = new THREE.Texture();
    up.material.map = boot;
    up.material.userData.colorTierRank = 2;
    upgradeTextureOnApproach(up, '4k', 1_000);
    expect(pending).toHaveLength(1);
    verdict = 'blocked';
    const arrival = new THREE.Texture({ width: 4096, height: 2048 } as unknown as HTMLImageElement);
    const wasDisposed = watchDispose(arrival);
    pending[0].onLoad(arrival);
    await flush();
    expect(wasDisposed()).toBe(true);
    expect(up.material.map).toBe(boot); // a real map either way
    expect(up.appliedTier).toBeNull();
    expect(up.attempt).toBeUndefined();
  });

  it('charges a compressed container one byte a texel only where the transcoder has a target', () => {
    const mib = (bytes: number) => bytes / (1024 * 1024);
    // No loader bound at all: the classic map is what gets fetched.
    expect(mib(tierUploadBytes('moon', '8k'))).toBeCloseTo(170.7, 1);
    // Bound on a GPU with a compressed format to transcode into.
    bindKtx2TierLoader(() => {}, true);
    expect(mib(tierUploadBytes('moon', '8k'))).toBeCloseTo(42.7, 1);
    // Bound on one without: three transcodes to RGBA32 and hands back four
    // times the size the container's blocks suggest. The filename cannot
    // tell these two apart, which is why the charge does not read it.
    bindKtx2TierLoader(() => {}, false);
    expect(mib(tierUploadBytes('moon', '8k'))).toBeCloseTo(170.7, 1);
    expect(mib(tierUploadBytes('moon', '4k'))).toBeCloseTo(42.7, 1);
  });

  it('measures a decoded candidate, a stashed figure and a nominal tier alike', () => {
    const mib = (bytes: number) => bytes / (1024 * 1024);
    const tex = new THREE.Texture({ width: 4096, height: 2048 } as unknown as HTMLImageElement);
    expect(mib(textureGpuBytes(tex))).toBeCloseTo(42.7, 1);
    // A texture whose source was closed after its upload keeps the figure.
    tex.userData.gpuBytes = 123;
    expect(textureGpuBytes(tex)).toBe(123);
    // Nothing readable: the tier's nominal size, or nothing at all.
    expect(mib(textureGpuBytes(new THREE.Texture(), 8192))).toBeCloseTo(170.7, 1);
    expect(textureGpuBytes(null)).toBe(0);
  });

  it('counts the decoded image a rung is still holding in RAM', () => {
    const mib = (bytes: number) => bytes / (1024 * 1024);
    const up = handle('moon');
    up.appliedTier = '4k';
    const bitmap = { width: 4096, height: 2048, close: () => {} };
    up.material.map = new THREE.Texture(bitmap as unknown as HTMLImageElement);
    // 42.7 MiB on the GPU with its mips, and 32 more still in RAM behind it
    // — the same memory on the device where the envelope binds.
    expect(mib(appliedTierGpuBytes(up))).toBeCloseTo(42.7, 1);
    expect(mib(appliedTierHeldBytes(up))).toBeCloseTo(74.7, 1);
    // Once the source is closed and the figure stashed, only the GPU copy is
    // left to count: what is held in its place is a thumbnail to re-upload
    // from after a context loss.
    up.material.map.userData.gpuBytes = equirectMapGpuBytes(4096);
    up.material.map.userData.sourceReleased = true;
    up.material.map.image = { width: 256, height: 128, close: () => {} };
    expect(mib(appliedTierHeldBytes(up))).toBeCloseTo(42.7, 1);
    // And a body still on its boot map weighs nothing at all: the maps every
    // device carries regardless are not the ladder's optional weight.
    up.appliedTier = null;
    expect(appliedTierHeldBytes(up)).toBe(0);
  });

  it('follows a refusal down: the top the tiles are measured against', () => {
    // Sectors measured against an 8K the globe will not hold arrive at twice
    // the magnification they were meant for.
    const up = handle('moon');
    expect(reachableTopTier(up)).toBe('8k');
    bindTierAdmission((_up, tier) => (tier === '8k' ? 'blocked' : 'admit'));
    expect(reachableTopTier(up)).toBe('4k');
    up.appliedTier = '4k';
    expect(reachableTopTier(up)).toBe('4k');
    // What it already holds is reachable by definition, whatever the ledger
    // would say about fetching it now.
    up.appliedTier = '8k';
    always('blocked');
    expect(reachableTopTier(up)).toBe('8k');
    // A rung whose fetch failed leaves the ladder one short until it lands.
    up.appliedTier = null;
    bindTierAdmission(null);
    up.lastFailure = { tier: '4k', streak: 1 };
    expect(reachableTopTier(up)).toBeNull();
  });
});

describe('the map width the tiles are measured against', () => {
  afterEach(() => bindTierAdmission(null));

  it('never falls below the rung the body is drawing', () => {
    const up = handle('moon');
    // Nothing applied yet: the finest rung the ladder can reach governs.
    expect(ladderMapReferenceWidth(up)).toBe(TIER_MAP_WIDTH['8k']);
    up.appliedTier = '4k';
    bindTierAdmission((_u, tier) => (tier === '8k' ? 'blocked' : 'admit'));
    expect(ladderMapReferenceWidth(up)).toBe(TIER_MAP_WIDTH['4k']);
    // Released all the way back to the boot map while the ladder is still
    // blocked: nothing above is reachable, and the globe is drawing 2048.
    // The image behind that map is a stand-in kept for a context restore, so
    // reading the map's width off it would measure the tiles against a few
    // hundred texels and admit them at many times the magnification they are
    // sized for.
    up.appliedTier = null;
    bindTierAdmission(() => 'blocked');
    expect(reachableTopTier(up)).toBeNull();
    up.material.map = new THREE.Texture(
      { width: RESTORE_STANDIN_WIDTH, height: RESTORE_STANDIN_WIDTH / 2 } as unknown as HTMLImageElement,
    );
    expect(ladderMapReferenceWidth(up)).toBe(TIER_MAP_WIDTH['2k']);
  });
});

describe('fetching the maps back after a lost context', () => {
  afterEach(() => bindTierAdmission(null));

  /** A rung as a restore finds it: a real tier applied, a stand-in image. */
  function onStandin(key: string): { up: StandardUpgrade; tex: THREE.Texture } {
    const up = handle(key);
    up.appliedTier = '4k';
    const tex = new THREE.Texture(
      { width: RESTORE_STANDIN_WIDTH, height: RESTORE_STANDIN_WIDTH / 2, close: () => {} } as unknown as HTMLImageElement,
    );
    tex.userData.sourceReleased = true;
    tex.userData.gpuBytes = equirectMapGpuBytes(4096);
    up.material.map = tex;
    return { up, tex };
  }

  it('hands back one rung at a time, nearest first as queued', () => {
    const near = onStandin('moon');
    const far = onStandin('mars');
    const queue = [near, far];
    expect(takeRestoreRefetch(queue)).toEqual({ up: near.up, restore: true });
    expect(queue).toHaveLength(1);
    expect(takeRestoreRefetch(queue)).toEqual({ up: far.up, restore: true });
    expect(queue).toHaveLength(0);
    expect(takeRestoreRefetch(queue)).toBeNull();
  });

  it('leaves nothing stranded when an upgrade in flight fails', () => {
    const busy = onStandin('moon');
    startAttempt(busy.up, '8k');
    const free = onStandin('mars');
    const queue = [busy, free];
    // The busy handle is skipped, not dropped: a fetch in flight is the one
    // moment a context is most likely to be lost.
    expect(takeRestoreRefetch(queue)).toEqual({ up: free.up, restore: true });
    expect(queue).toEqual([busy]);
    expect(takeRestoreRefetch(queue)).toBeNull();
    // The upgrade fails, leaving the stand-in on the material. Nothing else
    // would ever re-drive the re-fetch, so the queue still has to.
    cancelTextureUpgrade(busy.up, 'discard');
    expect(takeRestoreRefetch(queue)).toEqual({ up: busy.up, restore: true });
  });

  it('waits on a squeeze and gives the rung back where it can never fit', () => {
    const blocked = onStandin('moon');
    const queue = [blocked];
    bindTierAdmission(() => 'blocked');
    // A release may still make room: keep asking rather than decoding a map
    // the ledger has just said it cannot hold.
    expect(takeRestoreRefetch(queue)).toBeNull();
    expect(queue).toHaveLength(1);
    bindTierAdmission(() => 'refuse');
    // Nothing can make room for this rung again — so it is handed back
    // instead, which fetches a smaller real map over the stand-in.
    expect(takeRestoreRefetch(queue)).toEqual({ up: blocked.up, restore: false });
    expect(queue).toHaveLength(0);
  });

  it('drops an entry whose real map arrived by another route', () => {
    const answered = onStandin('moon');
    answered.up.material.map = new THREE.Texture(); // an upgrade landed
    const queue = [answered];
    expect(takeRestoreRefetch(queue)).toBeNull();
    expect(queue).toHaveLength(0);
  });
});

describe('a swap down that never lands', () => {
  type Pending = {
    url: string;
    onLoad: (tex: THREE.Texture) => void;
    onError: (err: unknown) => void;
    signal?: AbortSignal;
  };
  let pending: Pending[] = [];
  let restore: (() => void) | null = null;

  beforeEach(() => {
    pending = [];
    const previous = setUpgradeTextureLoader((url, onLoad, onError, _wanted, signal) => {
      pending.push({ url, onLoad, onError, signal });
    });
    restore = () => setUpgradeTextureLoader(previous);
  });

  afterEach(() => {
    restore?.();
    restore = null;
  });

  function onFourK(): StandardUpgrade {
    const up = handle('moon');
    up.material.map = new THREE.Texture({ width: 4096, height: 2048 } as unknown as HTMLImageElement);
    up.material.userData.colorTierRank = TIER_RANK['4k'];
    up.appliedTier = '4k';
    up.belowBandSinceMs = 0;
    return up;
  }

  it('ends the transfer and backs off before the same body is asked again', () => {
    const up = onFourK();
    expect(releaseDue(up, 60_000)).toBe(true);
    startTierRelease(up, 60_000);
    expect(pending).toHaveLength(1);
    expect(pending[0].signal?.aborted).toBe(false);

    const expiredAt = 60_000 + RELEASE_ATTEMPT_TIMEOUT_MS + 1;
    expect(releaseExpired(up, expiredAt)).toBe(true);
    expireTierRelease(up, expiredAt);
    // The only reader the transfer had has stopped waiting for it.
    expect(pending[0].signal?.aborted).toBe(true);
    expect(up.release).toBeUndefined();
    expect(up.releaseTimeouts).toBe(1);
    // The dwell is still served, so without a cooldown the planner starts a
    // fresh fetch for the same body on the very next frame.
    expect(releaseDue(up, expiredAt + 1)).toBe(false);
    expect(releaseDue(up, expiredAt + RELEASE_ATTEMPT_TIMEOUT_MS - 1)).toBe(false);
    expect(releaseDue(up, expiredAt + RELEASE_ATTEMPT_TIMEOUT_MS + 1)).toBe(true);
  });

  it('doubles the wait per timeout, to a five-minute cap', () => {
    const up = onFourK();
    startTierRelease(up, 0);
    expireTierRelease(up, 0);
    expect(up.releaseRetryAtMs).toBe(RELEASE_ATTEMPT_TIMEOUT_MS);
    startTierRelease(up, 1_000);
    expireTierRelease(up, 1_000);
    expect(up.releaseTimeouts).toBe(2);
    expect(up.releaseRetryAtMs).toBe(1_000 + 2 * RELEASE_ATTEMPT_TIMEOUT_MS);
    up.releaseTimeouts = 20; // a link that has been gone all session
    startTierRelease(up, 2_000);
    expireTierRelease(up, 2_000);
    expect(up.releaseRetryAtMs).toBe(2_000 + 300_000);
  });

  it('forgets the timeouts once a swap gets through', async () => {
    const up = onFourK();
    startTierRelease(up, 0);
    expireTierRelease(up, 0);
    startTierRelease(up, 1_000);
    pending[1].onLoad(new THREE.Texture());
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(up.releaseTimeouts).toBeUndefined();
    expect(up.releaseRetryAtMs).toBeUndefined();
  });
});

describe('the transient a swap down holds', () => {
  type Pending = { url: string; onLoad: (tex: THREE.Texture) => void; onError: (err: unknown) => void };
  let pending: Pending[] = [];
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
    restore?.();
    restore = null;
  });

  it('is in the ledger from the low map\'s decode until the swap', async () => {
    const up = handle('moon');
    up.material.map = new THREE.Texture({ width: 8192, height: 4096 } as unknown as HTMLImageElement);
    up.material.userData.colorTierRank = TIER_RANK['8k'];
    up.appliedTier = '8k';
    const high = equirectMapGpuBytes(8192);
    const low = equirectMapGpuBytes(4096);
    expect(appliedTierHeldBytes(up)).toBeCloseTo(high, 0);

    const seen: Array<{ bytes: number; drawnWidth: number }> = [];
    startTierRelease(up, 1_000, {
      onLedgerChange: () => {
        // Both maps are on the device here: the high one is still what the
        // body draws, and the low one has decoded. Whoever shares the
        // envelope has to be told before the transient is spent, not after.
        seen.push({ bytes: appliedTierHeldBytes(up), drawnWidth: (up.material.map!.image as { width: number }).width });
      },
    });
    pending[0].onLoad(new THREE.Texture({ width: 4096, height: 2048 } as unknown as HTMLImageElement));
    await flush();

    expect(seen).toHaveLength(1);
    expect(seen[0].drawnWidth).toBe(8192); // reported before the assignment
    expect(seen[0].bytes).toBeCloseTo(high + low, 0);
    // And out again with the high map, in the same frame.
    expect(up.pendingReleaseBytes).toBeUndefined();
    expect(appliedTierHeldBytes(up)).toBeCloseTo(low, 0);
  });

  it('leaves nothing charged when the swap is abandoned', () => {
    const up = handle('mars');
    up.material.map = new THREE.Texture({ width: 4096, height: 2048 } as unknown as HTMLImageElement);
    up.appliedTier = '4k';
    startTierRelease(up, 1_000);
    up.pendingReleaseBytes = 999;
    cancelTierRelease(up);
    expect(up.pendingReleaseBytes).toBeUndefined();
  });
});

describe('how long a committed arrival keeps its warm goals', () => {
  const GRACE = 10_000;

  it('lets a cold climb run as long as it needs while nothing is squeezing the ladder', () => {
    // The box exists for a goal waiting on memory. With none of that waiting
    // to do, a goal is the ordinary staged climb — which over a slow link
    // outlasts any arrival grace, and whose remaining rungs would otherwise
    // land as upload spikes in front of a moving camera.
    expect(arrivalWarmGoalsExpired(false, { doneAtMs: 0 }, 100 * GRACE, GRACE)).toBe(false);
    expect(arrivalWarmGoalsExpired(false, null, 100 * GRACE, GRACE)).toBe(false);
  });

  it('boxes a goal to its arrival once the ladder is squeezed', () => {
    expect(arrivalWarmGoalsExpired(true, { doneAtMs: null }, 100 * GRACE, GRACE)).toBe(false);
    expect(arrivalWarmGoalsExpired(true, { doneAtMs: 0 }, GRACE - 1, GRACE)).toBe(false);
    expect(arrivalWarmGoalsExpired(true, { doneAtMs: 0 }, GRACE, GRACE)).toBe(true);
    // Nothing is arriving at all: the goals belong to no trip.
    expect(arrivalWarmGoalsExpired(true, null, 0, GRACE)).toBe(true);
  });
});

describe('a slow cold arrival', () => {
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
    restore?.();
    restore = null;
  });

  it('climbs 4K then 8K however long the link takes over it', async () => {
    const up = handle('moon');
    armArrivalWarmGoal(up);
    expect(pumpArrivalWarmGoal(up, 0)).toBe(true);
    // A minute of link for the first rung — six times the arrival grace.
    pending[0].onLoad(new THREE.Texture({ width: 4096, height: 2048 } as unknown as HTMLImageElement));
    await flush();
    expect(up.appliedTier).toBe('4k');
    // The goal is untouched: nothing is squeezing the ladder, so nothing
    // hands the last rung back to the on-screen trigger.
    expect(arrivalWarmGoalsExpired(false, { doneAtMs: 0 }, 60_000, 10_000)).toBe(false);
    expect(pumpArrivalWarmGoal(up, 60_000)).toBe(true);
    pending[1].onLoad(new THREE.Texture({ width: 8192, height: 4096 } as unknown as HTMLImageElement));
    await flush();
    expect(up.appliedTier).toBe('8k');
    expect(pumpArrivalWarmGoal(up, 120_000)).toBe(false); // reached, not abandoned
  });
});

describe('closing a rung\'s decoded source once its upload is paid', () => {
  type FakeBitmap = { width: number; height: number; closed: boolean; close: () => void };
  function fakeBitmap(width: number, height: number): FakeBitmap {
    const bmp: FakeBitmap = { width, height, closed: false, close: () => { bmp.closed = true; } };
    return bmp;
  }
  const host = globalThis as unknown as { createImageBitmap?: unknown };
  const previous = host.createImageBitmap;
  let asked: Array<{ resolve: (b: FakeBitmap) => void; reject: (e: unknown) => void; opts: ImageBitmapOptions }>;
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    asked = [];
    host.createImageBitmap = (_img: unknown, opts: ImageBitmapOptions) =>
      new Promise<FakeBitmap>((resolve, reject) => { asked.push({ resolve, reject, opts }); });
  });

  afterEach(() => {
    if (previous === undefined) delete host.createImageBitmap;
    else host.createImageBitmap = previous;
  });

  /** A 4K rung as the warm pump leaves it: uploaded, source still in RAM. */
  function warmedRung(): { tex: THREE.Texture; source: FakeBitmap } {
    const source = fakeBitmap(4096, 2048);
    return { tex: new THREE.Texture(source as unknown as HTMLImageElement), source };
  }

  it('leaves a boot-map-class globe behind, not a smear', () => {
    // What a restored context re-uploads while the real map is fetched back:
    // the boot map's width less one 2:1 rung, at 2 MiB a rung.
    expect(RESTORE_STANDIN_WIDTH).toBe(1024);
    expect(RESTORE_STANDIN_WIDTH * (RESTORE_STANDIN_WIDTH / 2) * 4).toBe(2 * 1024 * 1024);
  });

  it('swaps in a stand-in of the stated width and closes the source', async () => {
    const { tex, source } = warmedRung();
    expect(retainedSourceBytes(tex)).toBe(4096 * 2048 * 4);
    releaseUpgradeSource(tex);
    expect(asked[0].opts.resizeWidth).toBe(RESTORE_STANDIN_WIDTH);
    expect(asked[0].opts.resizeHeight).toBe(RESTORE_STANDIN_WIDTH / 2);
    const small = fakeBitmap(RESTORE_STANDIN_WIDTH, RESTORE_STANDIN_WIDTH / 2);
    asked[0].resolve(small);
    await flush();
    expect(tex.image).toBe(small);
    expect(source.closed).toBe(true);
    expect(tex.userData.sourceReleased).toBe(true);
    // What it holds on the GPU is unreadable from the stand-in, so the figure
    // is stashed before the swap and survives it.
    expect(tex.userData.gpuBytes).toBe(equirectMapGpuBytes(4096));
    expect(textureGpuBytes(tex)).toBe(equirectMapGpuBytes(4096));
    expect(retainedSourceBytes(tex)).toBe(0);
    tex.dispose();
    expect(small.closed).toBe(true); // the stand-in goes with the texture
  });

  it('keeps counting a source a browser hands back unresized', async () => {
    const { tex, source } = warmedRung();
    releaseUpgradeSource(tex);
    // The options were accepted and the resize ignored: a full-size copy.
    const copy = fakeBitmap(4096, 2048);
    asked[0].resolve(copy);
    await flush();
    expect(tex.image).toBe(source);
    expect(source.closed).toBe(false);
    expect(copy.closed).toBe(true); // the copy is what goes, not the source
    expect(tex.userData.sourceReleased).toBeUndefined();
    expect(tex.userData.gpuBytes).toBeUndefined();
    // The claim this makes is an accounting one, so an unchecked resize must
    // not be allowed to report memory that is still held as freed.
    expect(retainedSourceBytes(tex)).toBe(4096 * 2048 * 4);
  });

  it('keeps the source when the resize rejects', async () => {
    const { tex, source } = warmedRung();
    releaseUpgradeSource(tex);
    asked[0].reject(new Error('no'));
    await flush();
    expect(tex.image).toBe(source);
    expect(source.closed).toBe(false);
    expect(retainedSourceBytes(tex)).toBe(4096 * 2048 * 4);
  });

  it('closes a stand-in the texture disposed mid-resize will never draw', async () => {
    const { tex, source } = warmedRung();
    releaseUpgradeSource(tex);
    tex.dispose();
    const small = fakeBitmap(RESTORE_STANDIN_WIDTH, RESTORE_STANDIN_WIDTH / 2);
    asked[0].resolve(small);
    await flush();
    expect(small.closed).toBe(true);
    expect(tex.image).toBe(source);
    expect(tex.userData.sourceReleased).toBeUndefined();
  });

  it('asks for nothing where there is nothing to gain', () => {
    // Already at the stand-in size, and an image with no bitmap behind it.
    releaseUpgradeSource(new THREE.Texture(
      fakeBitmap(RESTORE_STANDIN_WIDTH, RESTORE_STANDIN_WIDTH / 2) as unknown as HTMLImageElement,
    ));
    releaseUpgradeSource(new THREE.Texture({ width: 4096, height: 2048 } as unknown as HTMLImageElement));
    expect(asked).toHaveLength(0);
  });
});
