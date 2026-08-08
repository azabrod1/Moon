import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyColorTierTexture,
  canAttempt,
  cancelTextureUpgrade,
  earnedUpgradeTier,
  firstUpgradeTier,
  makeTextureUpgrade,
  needsUpgradeCover,
  resolveUpgradeTier,
  TIER_RANK,
  type TextureUpgrade,
} from './PlanetFactory';
import { captureDeviceTextureCaps, type TextureTier } from './world/texturePolicy';
import { bindTextureWarmer, pumpTextureWarmQueue, queueTextureWarm, resetTextureWarmer } from './world/textureWarmer';

// The screen fractions PlanetariumMode.UPGRADE_AT tunes: the mode owns the
// numbers, this file pins the policy they drive.
const TRIGGER_AT: Partial<Record<TextureTier, number>> = { '4k': 0.15, '8k': 0.3 };

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
/** Put an attempt on a handle the way upgradeTextureOnApproach does, without
 *  a loader: the tests are about what the handle then permits. */
function startAttempt(up: TextureUpgrade, tier: TextureTier, startedAtMs = 0): number {
  up.attempt = { tier, generation: ++generation, startedAtMs };
  up.retryAtMs = undefined;
  return up.attempt.generation;
}

function watchDispose(tex: THREE.Texture): () => boolean {
  let disposed = false;
  tex.addEventListener('dispose', () => { disposed = true; });
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
    expect(needsUpgradeCover(up, 0)).toBe(false);
  });
});

describe('screen-fraction band policy', () => {
  it('goes straight to the ceiling for a body already filling the screen', () => {
    const up = handle('moon');
    const earned = earnedUpgradeTier(up, 0.35, TRIGGER_AT);
    expect(earned).toBe('8k');
    // No 4K on the way: the intermediate map would be replaced seconds later,
    // for a whole extra download and upload.
    expect(resolveUpgradeTier(up, earned!)).toBe('8k');
  });

  it('stages the ladder when the approach crosses the lower fraction first', () => {
    const up = handle('moon');
    expect(earnedUpgradeTier(up, 0.2, TRIGGER_AT)).toBe('4k');
    up.appliedTier = '4k';
    expect(earnedUpgradeTier(up, 0.35, TRIGGER_AT)).toBe('8k');
    expect(resolveUpgradeTier(up, '8k')).toBe('8k');
  });

  it('earns nothing for a body still small on screen', () => {
    expect(earnedUpgradeTier(handle('moon'), 0.1, TRIGGER_AT)).toBeNull();
  });

  it('gives a single-step ladder its one tier', () => {
    expect(earnedUpgradeTier(handle('earthClouds'), 0.9, TRIGGER_AT)).toBe('4k');
  });
});

describe('upgrade attempts', () => {
  it('refuses a second fetch while one is in flight', () => {
    const up = handle('moon');
    startAttempt(up, '4k', 1_000);
    expect(canAttempt(up, 1_500)).toBe(false);
  });

  it('lets a hung fetch be superseded after a minute', () => {
    const up = handle('moon');
    startAttempt(up, '4k', 1_000);
    expect(canAttempt(up, 60_999)).toBe(false);
    expect(canAttempt(up, 61_001)).toBe(true);
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

  it('discards an abandoned fetch and cools down before retrying', () => {
    const up = handle('moon');
    const gen = startAttempt(up, '4k', 0);
    cancelTextureUpgrade(up, 'discard', 1_000);
    // The completion no longer matches the handle, so it disposes itself.
    expect(up.attempt?.generation).not.toBe(gen);
    expect(canAttempt(up, 1_100)).toBe(false);
    expect(canAttempt(up, 9_100)).toBe(true);
  });
});

describe('arrival cover policy', () => {
  it('covers a body that has not got its first step yet', () => {
    const idle = handle('moon');
    expect(needsUpgradeCover(idle, 0)).toBe(true);
    const loading = handle('moon');
    startAttempt(loading, '4k', 0);
    expect(needsUpgradeCover(loading, 0)).toBe(true);
  });

  it('does not cover a body already on a photo tier reaching for its goal', () => {
    const up = handle('moon');
    up.appliedTier = '4k';
    expect(needsUpgradeCover(up, 0)).toBe(false);
    expect(canAttempt(up, 0)).toBe(true); // the 8K goal still rides the on-screen trigger
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
