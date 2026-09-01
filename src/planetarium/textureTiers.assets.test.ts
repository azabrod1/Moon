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
} from './world/textureLadder';
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
 *  The format is not cosmetic, and it is not one choice for the whole tree.
 *  `colorModel` is the difference between UASTC and ETC1S: ETC1S is a few
 *  times smaller on the wire and half the VRAM, and what it spends for that
 *  is smooth gradients — its shared codebook needs a block index per distinct
 *  shade, so a slow ramp comes back as steps. That is why the Moon's maria and
 *  Earth's night falloff are UASTC and the cratered photo moons are ETC1S, and
 *  why each container's model is pinned per file below rather than left to
 *  whoever last ran the encoder. `transferFunction` is what the loader sets
 *  the texture's colour space from — a container marked linear draws the globe
 *  washed out, and nothing in the app would correct it because
 *  applyTextureDefaults deliberately leaves a compressed texture's colour
 *  space alone. */
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

/** KHR_DF_MODEL_UASTC and KHR_DF_MODEL_ETC1S, and the sRGB transfer
 *  function. */
const DF_MODEL_UASTC = 166;
const DF_MODEL_ETC1S = 163;
const DF_TRANSFER_SRGB = 2;

/** Supercompression scheme, which follows from the encoding: UASTC is zstd'd
 *  after the fact, ETC1S carries basisu's own BasisLZ. An unsupercompressed
 *  container is several times the download for the same picture, so the
 *  scheme is checked rather than ignored. */
const SUPERCOMPRESSION_BY_MODEL: Record<number, number> = {
  [DF_MODEL_UASTC]: 2,
  [DF_MODEL_ETC1S]: 1,
};

/**
 * The encoding every shipped container is cut in, by `<tier>/<file>`. A
 * container missing from here fails the header check rather than passing on a
 * default: the choice belongs to the map, and a new one has to be made
 * deliberately (tools/gen-ktx2.mjs's job table carries the measurement behind
 * each).
 *
 * UASTC for the maps built out of slow gradients — the Moon's maria, the cloud
 * deck's soft edges, Earth's night falloff, and the two planet rungs that
 * cleared the wire cap at that format.
 *
 * ETC1S for the photo moons, every one of which is cratered texture at every
 * scale, the codebook's best case: measured per body on a 4096x2048 candidate
 * these land at 0.80x to 2.99x their webp twin (ten of the twelve under 1.6x)
 * with RMS indistinguishable from webp's, so one file is small enough to be
 * the wire copy AND compressed in VRAM, and the rung ships as a container
 * alone.
 */
const CONTAINER_COLOR_MODEL: Record<string, number> = {
  '4k/mercury.ktx2': DF_MODEL_UASTC,
  '4k/mars.v2.ktx2': DF_MODEL_UASTC,
  '4k/moon.ktx2': DF_MODEL_UASTC,
  '8k/moon.ktx2': DF_MODEL_UASTC,
  '4k/earth-clouds.ktx2': DF_MODEL_UASTC,
  '8k/earth-clouds.ktx2': DF_MODEL_UASTC,
  '8k/earth-day.v2.ktx2': DF_MODEL_UASTC,
  '4k/earth-night.v2.ktx2': DF_MODEL_UASTC,
  '8k/earth-night.v2.ktx2': DF_MODEL_UASTC,
  '4k/enceladus.ktx2': DF_MODEL_ETC1S,
  '4k/mimas.ktx2': DF_MODEL_ETC1S,
  '4k/dione.ktx2': DF_MODEL_ETC1S,
  '4k/tethys.ktx2': DF_MODEL_ETC1S,
  '4k/rhea.ktx2': DF_MODEL_ETC1S,
  '4k/iapetus.ktx2': DF_MODEL_ETC1S,
  '4k/charon.ktx2': DF_MODEL_ETC1S,
  '4k/callisto.v2.ktx2': DF_MODEL_ETC1S,
  '4k/pluto.v2.ktx2': DF_MODEL_ETC1S,
  '8k/io.v2.ktx2': DF_MODEL_ETC1S,
  '8k/europa.v2.ktx2': DF_MODEL_ETC1S,
  '8k/ganymede.v2.ktx2': DF_MODEL_ETC1S,
  '8k/callisto.v2.ktx2': DF_MODEL_ETC1S,
  '8k/pluto.v2.ktx2': DF_MODEL_ETC1S,
};

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
    // reasoning is on the rows in textureLadder and in gen-ktx2.mjs's job
    // table — and it is the kind of decision that gets quietly widened by
    // anyone adding a map. The UASTC ones are held to the tight bar: every 8K
    // rung earns one because nothing else answers a 170.7 MiB upload, while a
    // 4K rung earns one only by staying inside four times the webp twin that
    // has to keep shipping beside it — of the maps a session tours, Mercury
    // and Mars alone. The Moon, the cloud deck and Earth's night lights are
    // the three the boot warm uploads on every session, downloaded once per
    // device rather than once per tour, and admitted on that basis.
    //
    // The photo moons are ETC1S, and that bar does not apply to them at all:
    // the container is roughly the webp's size on the wire, so there is no
    // twin and nothing extra to download. What they must not do is hold an
    // uncompressed map's VRAM through a nine-body tour, and at a quarter of it
    // they do not. Written out in the table's own order so a new container has
    // to be argued for here too.
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
      'enceladus 4k: 4k/enceladus.ktx2',
      'mimas 4k: 4k/mimas.ktx2',
      'dione 4k: 4k/dione.ktx2',
      'tethys 4k: 4k/tethys.ktx2',
      'rhea 4k: 4k/rhea.ktx2',
      'iapetus 4k: 4k/iapetus.ktx2',
      'charon 4k: 4k/charon.ktx2',
      'io 8k: 8k/io.v2.ktx2',
      'europa 8k: 8k/europa.v2.ktx2',
      'ganymede 8k: 8k/ganymede.v2.ktx2',
      'callisto 4k: 4k/callisto.v2.ktx2',
      'callisto 8k: 8k/callisto.v2.ktx2',
      'pluto 4k: 4k/pluto.v2.ktx2',
      'pluto 8k: 8k/pluto.v2.ktx2',
    ]);
  });

  it('carries a full baked mip chain at the tier width in every container', () => {
    const rungs: Array<[string, string, TextureTier]> = Object.entries(TIER_FILE_OVERRIDES)
      .flatMap(([, byTier]) => Object.entries(byTier)
        .map(([tier, rung]): [string, string, TextureTier] =>
          [`${tier}/${rung.file}`, tierPath(rung.file, tier as TextureTier), tier as TextureTier]));
    for (const [key, file, tier] of rungs) {
      const width = TIER_MAP_WIDTH[tier];
      const colorModel = CONTAINER_COLOR_MODEL[key];
      // A container nobody declared an encoding for is a container nobody
      // chose an encoding for.
      expect(`${key}: ${colorModel === undefined ? 'no declared encoding' : 'declared'}`)
        .toBe(`${key}: declared`);
      const header = ktx2Header(file);
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
        supercompression: SUPERCOMPRESSION_BY_MODEL[colorModel],
        colorModel,
        transferFunction: DF_TRANSFER_SRGB,
      });
    }
  });
});
