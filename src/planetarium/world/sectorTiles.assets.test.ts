/**
 * The shipped tile sets against the layout the app reads them with. The tool
 * that cuts tiles (tools/gen-tiles.mjs) and the runtime that samples them
 * (sectorGrid / sectorStreamer) hold the same gutter, grid and crop-width
 * arithmetic independently; this test is the one place that ties the files
 * on disk to the runtime's numbers, so a regeneration with a different
 * gutter, a base map at a new width, or a missing tile fails CI instead of
 * shipping misregistered sectors. Reads only WebP headers — no decode.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { SECTOR_GRID_16K, SECTOR_TILE, dataCropLayout } from './sectorGrid';
import { SECTOR_SETS } from './sectorStreamer';
import { PLANET_TEXTURE_FILES } from '../PlanetFactory';

const TEXTURES = resolve(__dirname, '../../../public/textures');

/** Canvas size from a WebP container: VP8 (lossy), VP8L (lossless) or VP8X
 *  (extended) first chunk. */
function webpSize(file: string): { width: number; height: number } {
  const b = readFileSync(file);
  expect(b.toString('ascii', 0, 4)).toBe('RIFF');
  expect(b.toString('ascii', 8, 12)).toBe('WEBP');
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  }
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  if (chunk === 'VP8 ') {
    // Key frame: 3-byte frame tag, 3-byte start code, then 14-bit width/height.
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  throw new Error(`${file}: unknown WebP chunk ${chunk}`);
}

function tileDir(key: string, tier: string): string {
  return resolve(TEXTURES, 'tiles', key, tier);
}

function expectFullSet(dir: string, size: { width: number; height: number }) {
  const { cols, rows } = SECTOR_GRID_16K;
  const files = readdirSync(dir).filter((f) => f.endsWith('.webp')).sort();
  const expected: string[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) expected.push(`${c}_${r}.webp`);
  expect(files).toEqual(expected.sort());
  for (const f of files) expect(webpSize(resolve(dir, f))).toEqual(size);
}

describe('shipped sector tile sets', () => {
  for (const [body, set] of Object.entries(SECTOR_SETS)) {
    it(`${body}: 32 colour tiles at the 2048² tile layout`, () => {
      expectFullSet(tileDir(set.colorKey, '16k'), { width: SECTOR_TILE.width, height: SECTOR_TILE.height });
    });

    for (const [slot, crop] of Object.entries(set.crops)) {
      it(`${body}: ${slot} crops match the layout cut from the base map's real width`, () => {
        const layout = dataCropLayout(SECTOR_GRID_16K, crop.baseWidth, crop.spanU ?? 1);
        expectFullSet(tileDir(crop.key, crop.tier), { width: layout.width, height: layout.height });
      });
    }
  }

  it('every set key is the file stem of the map it was cut from', () => {
    // The stem carries a re-based map's new name into its tiles' paths, so
    // the service worker can never pair an old globe with new tiles or the
    // reverse (it may serve a one-deploy-old body under an unchanged
    // pathname for a boot).
    const stem = (file: string) => file.replace(/^.*\//, '').replace(/\.webp$/, '');
    expect(SECTOR_SETS.Earth.colorKey).toBe(stem(PLANET_TEXTURE_FILES.earthDay));
    expect(SECTOR_SETS.Mars.colorKey).toBe(stem(PLANET_TEXTURE_FILES.mars));
    expect(SECTOR_SETS.Moon.colorKey).toBe(stem(PLANET_TEXTURE_FILES.moon));
    expect(SECTOR_SETS.Earth.crops.bumpMap!.key).toBe(stem(PLANET_TEXTURE_FILES.earthBump));
    expect(SECTOR_SETS.Earth.crops.roughnessMap!.key).toBe(stem(PLANET_TEXTURE_FILES.earthRoughness));
    expect(SECTOR_SETS.Mars.crops.normalMap!.key).toBe(stem(PLANET_TEXTURE_FILES.marsNormal));
    expect(SECTOR_SETS.Moon.crops.normalMap!.key).toBe(stem(PLANET_TEXTURE_FILES.moonNormal));
    for (const [body, set] of Object.entries(SECTOR_SETS)) {
      expect(existsSync(tileDir(set.colorKey, '16k')), `${body}: no 16k folder for ${set.colorKey}`).toBe(true);
    }
  });

  it('every crop set names the width of the base map it was cut from', () => {
    // The map each crop set was cut from. Earth's gloss mask is derived by
    // gen-tiles from one full-resolution water score: the crops are cut from
    // its 4096 resize, the whole-globe file is its 2048 resize (the far view
    // needs no more) — so the shipped width is half the crops' base width,
    // which is all this pins; the crop dimensions are pinned above.
    const baseFiles: Record<string, { file: string; shippedScale: number }> = {
      'earth-bump': { file: PLANET_TEXTURE_FILES.earthBump, shippedScale: 1 },
      'earth-roughness.v2': { file: PLANET_TEXTURE_FILES.earthRoughness, shippedScale: 0.5 },
      'mars-normal.v2': { file: PLANET_TEXTURE_FILES.marsNormal, shippedScale: 1 },
      'moon-normal': { file: `4k/${PLANET_TEXTURE_FILES.moonNormal}`, shippedScale: 1 },
    };
    for (const set of Object.values(SECTOR_SETS)) {
      for (const crop of Object.values(set.crops)) {
        const base = baseFiles[crop.key];
        expect(base, `no base map known for crop set ${crop.key}`).toBeDefined();
        const path = resolve(TEXTURES, base.file);
        expect(existsSync(path), `${base.file} missing on disk`).toBe(true);
        expect(webpSize(path).width, `${crop.key} baseWidth vs ${base.file}`).toBe(crop.baseWidth * base.shippedScale);
      }
    }
  });
});
