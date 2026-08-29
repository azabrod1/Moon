/**
 * The ladder fixtures the tests share: a handle over a real material, the
 * textures a rung really produces, and the two states most release and
 * restore tests start from.
 *
 * They were written nine times across four test files, and the copies had
 * drifted — two `onFourK`s differing by one field, three texture builders
 * differing in whether the image was decodable. A fixture that is not the
 * same everywhere quietly makes two suites test two different things.
 *
 * Test-only: nothing in src/ imports this. It lives beside the code rather
 * than under a test root because the app has no test root, and because a
 * fixture that models a TextureUpgrade has to move when TextureUpgrade does.
 */
import * as THREE from 'three';
import {
  captureDeviceCaps,
  resetDeviceCapsForTests,
  TIER_MAP_WIDTH,
  type TextureTier,
} from '../world/texturePolicy';
import { LEGACY_DESKTOP_PROFILE, LEGACY_TOUCH_PROFILE } from '../world/gpuEnvelope';
import {
  makeTextureUpgrade,
  resolveTierFile,
  RESTORE_STANDIN_WIDTH,
  TIER_RANK,
  type TextureUpgrade,
} from '../world/textureLadder';
import { equirectMapGpuBytes } from '../world/textureBytes';

/** A ladder handle over a standard material. TextureUpgrade.material is
 *  THREE.Material — a shader shell (Earth's night lights) climbs the same
 *  ladder — so the narrower type is stated here once, for the cases that poke
 *  at `map` and `bumpMap` directly. */
export type StandardUpgrade = TextureUpgrade & { material: THREE.MeshStandardMaterial };

/** Device caps are captured from the live renderer; a fake renderer is the
 *  seam. Production captures once, so a test asking a second question clears
 *  the first. 4096 is the pre-capture default — restore it in an afterEach so
 *  test order cannot leak a cap into another file's expectations. */
export function withMaxTextureSize(size: number, touch = false): void {
  resetDeviceCapsForTests();
  captureDeviceCaps({
    capabilities: { getMaxAnisotropy: () => 8, maxTextureSize: size },
  } as unknown as THREE.WebGLRenderer, touch ? LEGACY_TOUCH_PROFILE : LEGACY_DESKTOP_PROFILE);
}

const tracked: THREE.Material[] = [];

/** Free every material a fixture built. Call from an afterEach: a material
 *  left behind holds its maps, and three's disposal is an event other tests
 *  are listening for. */
export function disposeTrackedMaterials(): void {
  for (const mat of tracked.splice(0)) mat.dispose();
}

/** Track a material the test built itself, so one afterEach frees them all. */
export function trackMaterial<T extends THREE.Material>(material: T): T {
  tracked.push(material);
  return material;
}

/** A ladder handle over a fresh standard material. Throws rather than
 *  returning undefined: a test naming a key with no ladder is a typo, and a
 *  fixture that hands back undefined turns it into an assertion 40 lines on. */
export function ladderHandle(key: string): StandardUpgrade {
  const material = trackMaterial(new THREE.MeshStandardMaterial());
  const up = makeTextureUpgrade(key, material);
  if (!up) throw new Error(`no upgrade ladder for ${key}`);
  return up as StandardUpgrade;
}

/** An equirect colour map of this width, as a decoded image behind a texture. */
export function mapTexture(width: number): THREE.Texture {
  return new THREE.Texture({ width, height: width / 2 } as unknown as HTMLImageElement);
}

/** The texture a rung really produces: an image for a classic map, and for a
 *  compressed container the blocks it carries with its baked mip chain.
 *  UASTC transcodes to ASTC 4x4 or BC7, both a byte a texel. */
export function rungTexture(key: string, tier: TextureTier): THREE.Texture {
  const width = TIER_MAP_WIDTH[tier];
  if (!resolveTierFile(key, tier).endsWith('.ktx2')) return mapTexture(width);
  const mipmaps: Array<{ width: number; height: number; data: Uint8Array }> = [];
  for (let w = width, h = width / 2; w >= 4; w >>= 1, h >>= 1) {
    mipmaps.push({ width: w, height: h, data: new Uint8Array(w * h) });
  }
  return new THREE.CompressedTexture(mipmaps as unknown as ImageData[], width, width / 2);
}

/** A handle on a real 4K map, as a body that has climbed one rung has. What
 *  a suite adds on top — the flag a streamed photo sets, the clock that makes
 *  a release due — is that suite's subject, so it stays at the call site. */
export function climbedToFourK(key = 'moon'): StandardUpgrade {
  const up = ladderHandle(key);
  up.material.map = mapTexture(4096);
  up.material.userData.colorTierRank = TIER_RANK['4k'];
  up.appliedTier = '4k';
  return up;
}

/** A rung as a restore finds it: a real tier applied, and a stand-in image
 *  where the decoded source used to be. */
export function onStandin(key: string): { up: StandardUpgrade; tex: THREE.Texture } {
  const up = ladderHandle(key);
  up.appliedTier = '4k';
  const tex = new THREE.Texture({
    width: RESTORE_STANDIN_WIDTH, height: RESTORE_STANDIN_WIDTH / 2, close: () => {},
  } as unknown as HTMLImageElement);
  tex.userData.sourceReleased = true;
  tex.userData.gpuBytes = equirectMapGpuBytes(4096);
  up.material.map = tex;
  return { up, tex };
}

let generation = 0;

/** Put an attempt on a handle the way upgradeTextureOnApproach does, for the
 *  tests that are about what the handle then permits rather than what the
 *  fetch does. */
export function startAttempt(up: TextureUpgrade, tier: TextureTier, startedAtMs = 0): number {
  up.attempt = { tier, generation: ++generation, startedAtMs };
  up.retryAtMs = undefined;
  return up.attempt.generation;
}

/** Disposal is an event, not a flag, on both textures and geometries. */
export function watchDispose(resource: THREE.Texture | THREE.BufferGeometry): () => boolean {
  let disposed = false;
  resource.addEventListener('dispose', () => { disposed = true; });
  return () => disposed;
}
