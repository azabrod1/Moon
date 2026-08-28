/**
 * Texture loading policy for the Planetarium, in one place: device capability
 * capture (anisotropy, max size), colour-space by map kind, and the
 * resolution-tier → URL mapping. Centralising it keeps every creation site
 * (planet, moon, ring, procedural fallback) consistent, and lets a new
 * resolution ship as a folder plus a tier entry instead of an edit to each
 * loader.
 */
import * as THREE from 'three';
import { SECTOR_SET_TABLE } from './sectorSets.generated';
import { LEGACY_DESKTOP_PROFILE, type DeviceProfile } from './gpuEnvelope';

/** Every resolution tier that exists, ascending. This list names them and
 *  fixes that ascending convention: the device clamp walks it directly, and a
 *  body's own upgrade ladder names whichever subset it has on disk in the same
 *  order. A new resolution is an entry here plus a folder. */
export const TEXTURE_TIERS = ['2k', '4k', '8k'] as const;
export type TextureTier = (typeof TEXTURE_TIERS)[number];
export type MapKind = 'color' | 'data';

// Folder convention: the flat files in public/textures/ are the BOOT tier —
// whatever ships as a body's first-paint map, which is not literally 2048 wide
// for every body (earth-day boots at 4096). Higher tiers sit under
// public/textures/<tier>/ with identical filenames, so a texture's key and
// filename stay resolution-agnostic.
const TEXTURE_BASE = import.meta.env.BASE_URL + 'textures/';

export function resolveTextureUrl(file: string, tier: TextureTier): string {
  return tier === '2k' ? `${TEXTURE_BASE}${file}` : `${TEXTURE_BASE}${tier}/${file}`;
}

/**
 * Where tile sets are fetched from — the ONE place that reads it. Empty (the
 * default) means the app's own origin, exactly like the rest of textures/.
 * `VITE_TILE_ORIGIN` at build time points tiles, and only tiles, at another
 * host: a URL prefix including whatever path the host mirrors them under
 * ('https://cdn.example/gh/user/moon-tiles@v1'), with the same
 * textures/tiles/… layout beneath it. tools/swPlugin.mjs reads the same
 * variable to build the worker's allowlist, so the two cannot disagree about
 * where tiles live.
 *
 * `?tiles=<origin>` overrides it in dev, so a set that has not been published
 * yet can be served from a local checkout. It moves only the app's fetches:
 * the worker's allowlist is baked at build time and this cannot widen it (and
 * the worker does not run in dev at all).
 */
const TILE_BASE = ((): string => {
  const configured = import.meta.env.VITE_TILE_ORIGIN ?? '';
  const override = import.meta.env.DEV && typeof location !== 'undefined'
    ? new URLSearchParams(location.search).get('tiles')
    : null;
  const origin = (override ?? configured).trim().replace(/\/+$/, '');
  return origin ? `${origin}/` : import.meta.env.BASE_URL;
})();

/** Where one tile sits under a tile base:
 *  textures/tiles/<key>/<tier>.<setHash8>/<c>_<r>.webp — the key is the file
 *  stem of the map the set was cut from ('earth-day.v2'), a colour set's tier
 *  names its source resolution ('16k'), a data crop's the base map it was cut
 *  from ('2k', '4k'), and the hash is over the whole set's bytes. Cut by
 *  tools/gen-tiles.mjs, which writes the hashes into sectorSets.generated.ts.
 *
 *  The set hash is what the pathname promises: exactly those bytes or a 404.
 *  Everything else the app reads into a pathname — the map's identity through
 *  its stem, the 8×4 grid, the 8-px gutter, the two-sector-wide normal crops
 *  (sectorGrid) — is a layout the set was cut at, so a re-cut set lands on a
 *  new path by construction and no cache, near or far, can pair an old body
 *  with new code. The stem is the same rule one level up: a re-based base map
 *  ships under a new name and takes its tiles with it. */
export function tileSetPath(key: string, tier: string, hash: string): string {
  return `textures/tiles/${key}/${tier}.${hash}/`;
}

export function resolveTileUrl(key: string, tier: string, hash: string, c: number, r: number): string {
  return `${TILE_BASE}${tileSetPath(key, tier, hash)}${c}_${r}.webp`;
}

/** The published hash of a shipped set, or an empty string for a set the
 *  generated table does not name. Failing open is deliberate: this resolves
 *  while the SECTOR_SETS literal is built at module evaluation, so a throw
 *  here is a blank app before any code has run — including the `?sectors=0`
 *  switch that would turn streaming off. An empty hash instead 404s the
 *  tiles, which the body already survives by drawing its base map, and
 *  sectorStreamer's warning names the set. sectorTiles.assets.test.ts is
 *  what keeps every set the app names present in the table. */
export function sectorSetHash(key: string, tier: string): string {
  return SECTOR_SET_TABLE[`${key}/${tier}`]?.setHash8 ?? '';
}

/** The layout gen-tiles measured a set's tiles at: the width of the equirect
 *  they were cut from and how many sectors of longitude one tile spans. The
 *  crop arithmetic reads these instead of hand-copied numbers, so a re-cut at
 *  another width cannot leave the app sampling the old one. Unknown sets get
 *  a zero width on the same fail-open contract as the hash. */
export function sectorSetLayout(key: string, tier: string): { baseWidth: number; spanU: number } {
  const entry = SECTOR_SET_TABLE[`${key}/${tier}`];
  return { baseWidth: entry?.baseWidth ?? 0, spanU: entry?.spanU ?? 1 };
}

// Smallest GL max-texture-size that can hold a tier's maps. The boot tier has
// no floor: it is what the device gets when nothing larger fits.
const TIER_MIN_TEXTURE_SIZE: Record<TextureTier, number> = { '2k': 0, '4k': 4096, '8k': 8192 };

/** Nominal map width of a tier. The boot tier's is nominal only — a body
 *  may boot wider (earth-day at 4096); readers that care take the larger
 *  of this and the map's real width. */
export const TIER_MAP_WIDTH: Record<TextureTier, number> = { '2k': 2048, '4k': 4096, '8k': 8192 };

// Captured once from the live renderer before any texture loads: anisotropy
// needs the GL context, and the max texture size decides which tiers are even
// loadable. The defaults are safe pre-capture — anisotropy 1 is "off", 4096
// admits the 4K tier while holding 8K back until a real cap is known, and the
// desktop profile spends nothing a device cannot afford until the real one
// arrives.
let chosenAnisotropy = 1;
let maxTextureSize = 4096;
let deviceProfile: DeviceProfile = LEGACY_DESKTOP_PROFILE;
let capsCaptured = false;

/**
 * Take the device's caps and its memory profile, once. The first caller wins
 * and every later one gets that same snapshot back: the app has one renderer
 * and one session's worth of decisions resolved against these — a body's
 * ladder ceiling is fixed when its handle is made, the sector streamer's
 * limits are readonly from its constructor — so a second capture with a
 * different profile would split one session across two policies. Volume
 * compare and the planetarium both call it, in whichever order the session
 * takes them.
 */
export function captureDeviceCaps(renderer: THREE.WebGLRenderer, profile: DeviceProfile): DeviceProfile {
  if (capsCaptured) return deviceProfile;
  // Cap anisotropy at 8: past the point of visible return for these few large
  // spheres and the rings, and cheaper than the 16 most desktops report.
  chosenAnisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  maxTextureSize = renderer.capabilities.maxTextureSize;
  deviceProfile = profile;
  capsCaptured = true;
  return deviceProfile;
}

/** The captured profile — the memory numbers every consumer reads. */
export function deviceTextureProfile(): DeviceProfile {
  return deviceProfile;
}

/** Tests capture repeatedly, with a fake renderer, to ask what a given device
 *  would do. Production captures once (see above); this is what lets a test
 *  ask a second question. */
export function resetDeviceCapsForTests(): void {
  chosenAnisotropy = 1;
  maxTextureSize = 4096;
  deviceProfile = LEGACY_DESKTOP_PROFILE;
  capsCaptured = false;
}

/**
 * Stamp anisotropy + colour space onto a freshly created texture. Colour maps
 * decode from sRGB; data maps (bump / normal / roughness) carry linear values
 * and must not be gamma-decoded. Call at every texture creation site.
 */
export function applyTextureDefaults(tex: THREE.Texture, kind: MapKind): void {
  tex.anisotropy = chosenAnisotropy;
  // A GPU-compressed texture (a KTX2 tier) keeps everything else its loader
  // read from the file: colour space comes from the container's DFD, the mip
  // chain is baked, and the upload takes three's standard immutable path —
  // its blocks are already sRGB-encoded, so the driver conversion the
  // mutableStorage escape hatch below dodges never happens for it.
  if ((tex as THREE.CompressedTexture).isCompressedTexture) return;
  tex.colorSpace = kind === 'color' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  // Opt out of three's immutable texStorage2D allocation (the flag is our
  // patches/three escape hatch): for sRGB maps the driver pays a full-image
  // conversion inside the immutable upload — ~200ms frozen main thread for an
  // 8K on Chromium, a comparable deferred stall on WebKit — while the mutable
  // texImage2D path uploads the same bytes into the same internal format for
  // a fraction of that. Same pixels, same sampling, same mips; only the
  // allocation call changes. These maps upload once and never resize, so
  // immutability buys nothing here.
  tex.userData.mutableStorage = true;
}

/**
 * Resolve the tier a device can actually honour: the highest tier that is both
 * at or below the request and within the GL max texture size. One descending
 * pass, so a device that can't hold 4096 answers an 8K request with the boot
 * tier rather than stepping down a single rung to a 4K it also can't hold.
 * Capability-based, not a "this is a phone" guess — modern phones are strong,
 * so quality isn't gated on device class. One-way: nothing upgrades past what
 * this returns.
 */
export function clampTier(tier: TextureTier): TextureTier {
  for (let i = TEXTURE_TIERS.indexOf(tier); i > 0; i--) {
    if (maxTextureSize >= TIER_MIN_TEXTURE_SIZE[TEXTURE_TIERS[i]]) return TEXTURE_TIERS[i];
  }
  return TEXTURE_TIERS[0];
}
