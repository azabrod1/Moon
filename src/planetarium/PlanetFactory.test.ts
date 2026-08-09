import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyColorTierTexture,
  canAttempt,
  cancelTextureUpgrade,
  earnedUpgradeTier,
  firstUpgradeTier,
  makeGeometryUpgrade,
  makeTextureUpgrade,
  needsGeometryUpgrade,
  needsUpgradeCover,
  resolveUpgradeTier,
  setUpgradeTextureLoader,
  TIER_RANK,
  upgradeComplete,
  upgradeGeometryOnApproach,
  upgradeTextureOnApproach,
  UPGRADE_TRIGGER_FRACTION,
  type TextureUpgrade,
} from './PlanetFactory';
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
    expect(resolveUpgradeTier(up, '8k')).toBe('8k');
    expect(firstUpgradeTier(up)).toBe('4k');
    expect(canAttempt(up, 0)).toBe(true);
  });
});

describe('screen-fraction band policy', () => {
  it('goes straight to the ceiling for a body already filling the screen', () => {
    const up = handle('moon');
    const earned = earnedUpgradeTier(up, 0.35);
    expect(earned).toBe('8k');
    // No 4K on the way: the intermediate map would be replaced seconds later,
    // for a whole extra download and upload.
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
    upgradeTextureOnApproach(up, '8k', 1_000);
    expect(pending).toHaveLength(1);
    expect(pending[0].url).toMatch(/textures\/8k\/moon\.jpg$/);

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
    expect(up.appliedTier).toBe('8k');
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
