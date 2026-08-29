/**
 * The colour ladder against the files on disk. Every rung a body's ladder
 * names resolves to a pathname at run time, and those pathnames are invisible
 * to both tsc and Vite — a missing one is a 404 that the app survives by
 * staying on a coarser map, which is exactly the kind of silent quality loss
 * nobody notices for a release.
 *
 * The GPU-compressed rungs carry a second claim: whether a classic map of the
 * same resolution ships beside the container. The ladder's memory arithmetic
 * and its fallback both read that flag, so a rung declared to have a webp twin
 * and shipping without one would leave a device with no transcoder fetching a
 * URL that does not exist — and one declared WITHOUT a twin that ships with
 * one is 4 MB of dead weight in every deploy. Both directions are checked.
 *
 * Reads headers only — no decode.
 */
import { describe, it, expect } from 'vitest';
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PLANET_TEXTURE_FILES,
  TEXTURE_UPGRADE_TIERS,
  TIER_FILE_OVERRIDES,
} from './PlanetFactory';
import { TIER_MAP_WIDTH, type TextureTier } from './world/texturePolicy';

const TEXTURES = resolve(__dirname, '../../public/textures');

/** Where resolveTextureUrl would look, as a path on disk. */
function tierPath(file: string, tier: TextureTier): string {
  return tier === '2k' ? resolve(TEXTURES, file) : resolve(TEXTURES, tier, file);
}

function head(path: string, bytes: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    readSync(fd, buf, 0, bytes, 0);
    return buf;
  } finally {
    closeSync(fd);
  }
}

/** KTX2 identifier, from the spec's section 3.1. */
const KTX2_MAGIC = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The fixed header the container opens with: dimensions at 20/24, the
 *  number of mip levels at 40, the supercompression scheme at 44 and where
 *  the data format descriptor sits at 48, all little-endian u32 — plus the
 *  two bytes of that descriptor's basic block that say WHICH compressed
 *  format the blocks are in and how they are to be read back. The descriptor
 *  follows the level index, so a kilobyte covers it for any level count these
 *  maps reach.
 *
 *  The format is not cosmetic. `colorModel` is the difference between UASTC
 *  and ETC1S: ETC1S is a quarter of the wire size and bands visibly on the
 *  Moon's maria, so a container that quietly encoded as ETC1S would ship a
 *  worse picture than the webp rung it replaced. `transferFunction` is what
 *  the loader sets the texture's colour space from — a container marked
 *  linear draws the globe washed out, and nothing in the app would correct it
 *  because applyTextureDefaults deliberately leaves a compressed texture's
 *  colour space alone. */
function ktx2Header(path: string): {
  width: number;
  height: number;
  levels: number;
  supercompression: number;
  colorModel: number;
  transferFunction: number;
} {
  const buf = head(path, 1024);
  expect(buf.subarray(0, 12).equals(KTX2_MAGIC)).toBe(true);
  // dfdByteOffset points at the descriptor's own total-size word; the basic
  // block starts four bytes later, and its colour model is eight into that.
  const basicBlock = buf.readUInt32LE(48) + 4;
  return {
    width: buf.readUInt32LE(20),
    height: buf.readUInt32LE(24),
    levels: buf.readUInt32LE(40),
    supercompression: buf.readUInt32LE(44),
    colorModel: buf[basicBlock + 8],
    transferFunction: buf[basicBlock + 10],
  };
}

/** KHR_DF_MODEL_UASTC, and the sRGB transfer function. */
const DF_MODEL_UASTC = 166;
const DF_TRANSFER_SRGB = 2;

describe('the files behind the colour ladder', () => {
  it('ships every rung every body can climb to', () => {
    for (const [key, tiers] of Object.entries(TEXTURE_UPGRADE_TIERS)) {
      for (const tier of tiers) {
        const rung = TIER_FILE_OVERRIDES[key]?.[tier];
        // A rung with no compressed container ships as one webp; one WITH a
        // container ships the container, plus the webp only where it says so.
        const wanted = rung
          ? [rung.file, ...(rung.webp ? [PLANET_TEXTURE_FILES[key]] : [])]
          : [PLANET_TEXTURE_FILES[key]];
        for (const file of wanted) {
          expect(`${key} ${tier}: ${file}`).toBe(
            existsSync(tierPath(file, tier)) ? `${key} ${tier}: ${file}` : `${key} ${tier}: MISSING ${file}`,
          );
        }
      }
    }
  });

  it('ships no classic map for a rung that declares none — the ladder stops instead', () => {
    // The claim the fallback rests on: with no KTX2 loader bound these rungs
    // are absent, which is only true while nothing of that resolution is on
    // disk under the key's shared filename. A stray file here would make the
    // "ladder stops one rung short" behaviour a 4 MB lie.
    for (const [key, byTier] of Object.entries(TIER_FILE_OVERRIDES)) {
      for (const [tier, rung] of Object.entries(byTier)) {
        if (rung.webp) continue;
        const path = tierPath(PLANET_TEXTURE_FILES[key], tier as TextureTier);
        expect(`${key} ${tier}`).toBe(existsSync(path) ? `${key} ${tier} ships an unused ${path}` : `${key} ${tier}`);
      }
    }
  });

  it('ships the containers the wire rules admitted, and no others', () => {
    // Which rungs get a container is a decision about DOWNLOAD size — the
    // reasoning is on the rows in PlanetFactory and in gen-ktx2.mjs's job
    // table — and it is the kind of decision that gets quietly widened by
    // anyone adding a map. Every 8K rung earns one. A 4K rung earns one only
    // by staying inside four times the webp twin that has to keep shipping
    // beside it, which of the maps a session tours is Mercury and Mars alone;
    // the Moon, the cloud deck and Earth's night lights are the three the
    // boot warm uploads on every session, downloaded once per device rather
    // than once per tour, and admitted on that basis. Written out in the
    // table's own order so a tenth container has to be argued for here too.
    const shipped = Object.entries(TIER_FILE_OVERRIDES).flatMap(([key, byTier]) =>
      Object.entries(byTier).map(([tier, rung]) => `${key} ${tier}: ${tier}/${rung.file}`));
    expect(shipped).toEqual([
      'mercury 4k: 4k/mercury.ktx2',
      'mars 4k: 4k/mars.v2.ktx2',
      'moon 4k: 4k/moon.ktx2',
      'moon 8k: 8k/moon.ktx2',
      'earthClouds 4k: 4k/earth-clouds.ktx2',
      'earthClouds 8k: 8k/earth-clouds.ktx2',
      'earthDay 8k: 8k/earth-day.v2.ktx2',
      'earthNight 4k: 4k/earth-night.v2.ktx2',
      'earthNight 8k: 8k/earth-night.v2.ktx2',
    ]);
  });

  it('carries a full baked mip chain at the tier width in every container', () => {
    for (const [key, byTier] of Object.entries(TIER_FILE_OVERRIDES)) {
      for (const [tier, rung] of Object.entries(byTier)) {
        const width = TIER_MAP_WIDTH[tier as TextureTier];
        const header = ktx2Header(tierPath(rung.file, tier as TextureTier));
        // A 2:1 equirect at the tier's own width. A container a size off
        // would be charged the tier's bytes and drawn at another.
        expect({ key, ...header }).toEqual({
          key,
          width,
          height: width / 2,
          // Every level down to 1x1: three cannot build mips for a
          // compressed texture, so a chain that stops early leaves the
          // globe aliasing at every distance the missing levels covered.
          levels: Math.log2(width) + 1,
          // 2 = zstd. The blocks are what the GPU holds either way; this is
          // the wire size, and an unsupercompressed container is several
          // times the download for the same picture.
          supercompression: 2,
          colorModel: DF_MODEL_UASTC,
          transferFunction: DF_TRANSFER_SRGB,
        });
      }
    }
  });
});
