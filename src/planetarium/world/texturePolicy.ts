/**
 * Texture loading policy for the Planetarium, in one place: device capability
 * capture (anisotropy, max size), colour-space by map kind, and the
 * resolution-tier → URL mapping. Centralising it keeps every creation site
 * (planet, moon, ring, procedural fallback) consistent, and lets a later phase
 * introduce 4K assets by flipping a tier instead of editing each loader.
 */
import * as THREE from 'three';

export type TextureTier = '2k' | '4k';
export type MapKind = 'color' | 'data';

// Folder convention: the original 2K assets live flat in public/textures/;
// 4K variants, when they exist, sit under public/textures/4k/ with identical
// filenames, so a texture's key/filename stays resolution-agnostic.
const TEXTURE_BASE = import.meta.env.BASE_URL + 'textures/';

export function resolveTextureUrl(file: string, tier: TextureTier): string {
  return tier === '4k' ? `${TEXTURE_BASE}4k/${file}` : `${TEXTURE_BASE}${file}`;
}

// Captured once from the live renderer before any texture loads: anisotropy
// needs the GL context, and the max texture size decides whether 4K is even
// loadable. The defaults are safe pre-capture — anisotropy 1 is "off", and
// 4096 is the smallest size a 4K tier needs.
let chosenAnisotropy = 1;
let maxTextureSize = 4096;

export function captureDeviceTextureCaps(renderer: THREE.WebGLRenderer): void {
  // Cap at 8: past the point of visible return for these few large spheres and
  // the rings, and cheaper than the 16 most desktops report.
  chosenAnisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  maxTextureSize = renderer.capabilities.maxTextureSize;
}

/**
 * Stamp anisotropy + colour space onto a freshly created texture. Colour maps
 * decode from sRGB; data maps (bump / normal / roughness) carry linear values
 * and must not be gamma-decoded. Call at every texture creation site.
 */
export function applyTextureDefaults(tex: THREE.Texture, kind: MapKind): void {
  tex.anisotropy = chosenAnisotropy;
  tex.colorSpace = kind === 'color' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
}

/**
 * Resolve the tier a device can actually honour: drop 4K → 2K only when the GL
 * max texture size can't hold a 4096 map. Capability-based, not a "this is a
 * phone" guess — modern phones are strong, so quality isn't gated on device
 * class. One-way — nothing upgrades past what this returns.
 */
export function clampTier(tier: TextureTier): TextureTier {
  if (tier === '4k' && maxTextureSize < 4096) return '2k';
  return tier;
}
