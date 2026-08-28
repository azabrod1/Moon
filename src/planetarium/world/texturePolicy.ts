/**
 * Texture loading policy for the Planetarium, in one place: device capability
 * capture (anisotropy, max size), colour-space by map kind, and the
 * resolution-tier → URL mapping. Centralising it keeps every creation site
 * (planet, moon, ring, procedural fallback) consistent, and lets a new
 * resolution ship as a folder plus a tier entry instead of an edit to each
 * loader.
 */
import * as THREE from 'three';

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

/** Sector tile sets live under textures/tiles/<key>/<tier>/<c>_<r>.webp —
 *  a colour set's tier names its source resolution ('16k'), a data crop's
 *  the base map it was cut from ('2k', '4k'). Cut by tools/gen-tiles.mjs.
 *  The layout the app reads into a pathname — the 8×4 grid, the 8-px gutter,
 *  the two-sector-wide normal crops (sectorGrid) — is part of that pathname's
 *  contract: the service worker may serve a one-deploy-old body under it for
 *  a boot, so a layout change ships under a new folder (a new tier name or
 *  key), never as new code reading the old paths. */
export function resolveTileUrl(key: string, tier: string, c: number, r: number): string {
  return `${TEXTURE_BASE}tiles/${key}/${tier}/${c}_${r}.webp`;
}

// Smallest GL max-texture-size that can hold a tier's maps. The boot tier has
// no floor: it is what the device gets when nothing larger fits.
const TIER_MIN_TEXTURE_SIZE: Record<TextureTier, number> = { '2k': 0, '4k': 4096, '8k': 8192 };

// Captured once from the live renderer before any texture loads: anisotropy
// needs the GL context, and the max texture size decides which tiers are even
// loadable. The defaults are safe pre-capture — anisotropy 1 is "off", and
// 4096 admits the 4K tier while holding 8K back until a real cap is known.
let chosenAnisotropy = 1;
let maxTextureSize = 4096;
let touchBudget = false;

export function captureDeviceTextureCaps(
  renderer: THREE.WebGLRenderer,
  touch: boolean = typeof window !== 'undefined' && 'ontouchstart' in window,
): void {
  // Cap at 8: past the point of visible return for these few large spheres and
  // the rings, and cheaper than the 16 most desktops report.
  chosenAnisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  maxTextureSize = renderer.capabilities.maxTextureSize;
  touchBudget = touch;
}

/** True on a touch device. WebGL exposes no GPU-memory figure, and a phone's
 *  GL max-texture-size (16384 on every recent iPhone) says nothing about how
 *  many 8K maps its shared memory will hold at once — so the one budget
 *  decision that is about total residency, not a single map's size, falls
 *  back on this coarse signal. See TOUCH_TIER_CAP in PlanetFactory. */
export function touchTextureBudget(): boolean {
  return touchBudget;
}

/**
 * Stamp anisotropy + colour space onto a freshly created texture. Colour maps
 * decode from sRGB; data maps (bump / normal / roughness) carry linear values
 * and must not be gamma-decoded. Call at every texture creation site.
 */
export function applyTextureDefaults(tex: THREE.Texture, kind: MapKind): void {
  tex.anisotropy = chosenAnisotropy;
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
