/**
 * The shipped tile sets against the layout the app reads them with. The tool
 * that cuts tiles (tools/gen-tiles.mjs) and the runtime that samples them
 * (sectorGrid / sectorStreamer) hold the same gutter, grid and crop-width
 * arithmetic independently; this test ties them together through the table
 * gen-tiles generates, so a regeneration with a different gutter, a base map
 * at a new width, or a set the app doesn't name fails CI instead of shipping
 * misregistered sectors.
 *
 * Two halves, deliberately separate. The first needs nothing but the
 * generated table and the base maps, and stays true wherever the tiles are
 * served from. The second reads the tile files themselves — including
 * recomputing each set's hash from its bytes — and is the half that belongs
 * to gen-tiles once the sets are published from their own repository rather
 * than from public/. Reads only WebP headers — no decode.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { SECTOR_GRID_16K, SECTOR_TILE, dataCropLayout } from './sectorGrid';
import { SECTOR_SETS, type SectorTileSet } from './sectorStreamer';
import { SECTOR_SET_TABLE, type GeneratedSectorSet } from './sectorSets.generated';
import { PLANET_TEXTURE_FILES } from '../PlanetFactory';

const TEXTURES = resolve(__dirname, '../../../public/textures');
const SETS_JSON = resolve(TEXTURES, 'tiles/sets.v1.json');

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

/** Every set the app names, with the table entry it resolves to. */
function appSets(): Array<{ body: string; slot: string; set: SectorTileSet; entry: GeneratedSectorSet }> {
  const out = [];
  for (const [body, spec] of Object.entries(SECTOR_SETS)) {
    for (const [slot, set] of [['map', spec.color] as const, ...Object.entries(spec.crops)]) {
      const entry = SECTOR_SET_TABLE[`${set.key}/${set.tier}`];
      expect(entry, `${body} ${slot}: no generated entry for ${set.key}/${set.tier}`).toBeDefined();
      out.push({ body, slot, set, entry });
    }
  }
  return out;
}

function setDir(set: SectorTileSet): string {
  return resolve(TEXTURES, 'tiles', set.key, `${set.tier}.${set.hash}`);
}

describe('sector tile sets: what the app asks for', () => {
  it('names a generated set, at the hash the table publishes', () => {
    // The hash in the URL is the whole promise a tile path makes; a stale one
    // is a 404, and a 404 is a globe that quietly stays soft.
    for (const { body, slot, set, entry } of appSets()) {
      expect(set.hash, `${body} ${slot}`).toBe(entry.setHash8);
      expect(set.hash, `${body} ${slot}`).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it('reads every set at the grid and gutter it was cut with', () => {
    for (const { body, slot, entry } of appSets()) {
      expect(entry.grid, `${body} ${slot}`).toEqual(SECTOR_GRID_16K);
      expect(entry.gutter, `${body} ${slot}`).toBe(SECTOR_TILE.gutterY);
      expect(entry.fileCount, `${body} ${slot}`).toBe(SECTOR_GRID_16K.cols * SECTOR_GRID_16K.rows);
      expect(entry.baseWidth, `${body} ${slot}`).toBe(entry.content * entry.grid.cols);
    }
  });

  it('colour tiles are the 2048² tile layout', () => {
    for (const spec of Object.values(SECTOR_SETS)) {
      const entry = SECTOR_SET_TABLE[`${spec.color.key}/${spec.color.tier}`];
      expect({ width: entry.tileWidth, height: entry.tileHeight }).toEqual({
        width: SECTOR_TILE.width,
        height: SECTOR_TILE.height,
      });
      expect(entry.spanU).toBe(SECTOR_TILE.spanU);
    }
  });

  it('crops match the layout cut from the base map’s real width', () => {
    // The app builds its crop layout from the width and span in the table;
    // this is the check that the arithmetic reproduces the tile size gen-tiles
    // actually measured on disk.
    for (const [body, spec] of Object.entries(SECTOR_SETS)) {
      for (const [slot, crop] of Object.entries(spec.crops)) {
        const entry = SECTOR_SET_TABLE[`${crop.key}/${crop.tier}`];
        const layout = dataCropLayout(SECTOR_GRID_16K, crop.baseWidth, crop.spanU);
        expect({ width: entry.tileWidth, height: entry.tileHeight }, `${body} ${slot}`).toEqual({
          width: layout.width,
          height: layout.height,
        });
      }
    }
  });

  it('every set key is the file stem of the map it was cut from', () => {
    // The stem carries a re-based map's new name into its tiles' paths, so
    // tiles cut from one map can never be paired with a globe drawing
    // another.
    const stem = (file: string) => file.replace(/^.*\//, '').replace(/\.webp$/, '');
    expect(SECTOR_SETS.Earth.color.key).toBe(stem(PLANET_TEXTURE_FILES.earthDay));
    expect(SECTOR_SETS.Mars.color.key).toBe(stem(PLANET_TEXTURE_FILES.mars));
    expect(SECTOR_SETS.Moon.color.key).toBe(stem(PLANET_TEXTURE_FILES.moon));
    expect(SECTOR_SETS.Earth.crops.bumpMap!.key).toBe(stem(PLANET_TEXTURE_FILES.earthBump));
    expect(SECTOR_SETS.Earth.crops.roughnessMap!.key).toBe(stem(PLANET_TEXTURE_FILES.earthRoughness));
    expect(SECTOR_SETS.Mars.crops.normalMap!.key).toBe(stem(PLANET_TEXTURE_FILES.marsNormal));
    expect(SECTOR_SETS.Moon.crops.normalMap!.key).toBe(stem(PLANET_TEXTURE_FILES.moonNormal));
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

describe('sector tile sets: the files on disk', () => {
  // This half only holds while the sets ship inside the app. Once they are
  // published from their own repository the same checks live in
  // `gen-tiles --verify`, where the bytes are.
  it('every named set is a full grid of tiles at its declared size', () => {
    for (const { body, slot, set, entry } of appSets()) {
      const dir = setDir(set);
      expect(existsSync(dir), `${body} ${slot}: no folder ${set.key}/${set.tier}.${set.hash}`).toBe(true);
      const files = readdirSync(dir).filter((f) => f.endsWith('.webp')).sort();
      const expected: string[] = [];
      for (let r = 0; r < entry.grid.rows; r++) {
        for (let c = 0; c < entry.grid.cols; c++) expected.push(`${c}_${r}.webp`);
      }
      expect(files, `${body} ${slot}`).toEqual(expected.sort());
      for (const f of files) {
        expect(webpSize(resolve(dir, f)), `${body} ${slot} ${f}`).toEqual({
          width: entry.tileWidth,
          height: entry.tileHeight,
        });
      }
    }
  });

  it('ships the same table in sets.v1.json as in the generated module', () => {
    // gen-tiles writes both from one object in one pass, so they can only
    // differ if a run was interrupted or one of them was hand-edited — and
    // sets.v1.json is what a publisher or a smoke script reads to find the
    // folder the app is asking for.
    expect(JSON.parse(readFileSync(SETS_JSON, 'utf8'))).toEqual(SECTOR_SET_TABLE);
  });

  it('every set folder is named for the bytes inside it', () => {
    // gen-tiles' recipe: SHA-256 over the sorted `<name>\0<file sha256>\n`
    // list of the whole set, first 8 hex. One changed tile moves the folder,
    // which is what lets a tile URL be cached with no expiry.
    for (const { body, slot, set } of appSets()) {
      const dir = setDir(set);
      const files = readdirSync(dir).filter((f) => f.endsWith('.webp')).sort();
      const hash = createHash('sha256');
      for (const name of files) {
        const digest = createHash('sha256').update(readFileSync(resolve(dir, name))).digest('hex');
        hash.update(`${name}\0${digest}\n`);
      }
      expect(hash.digest('hex').slice(0, 8), `${body} ${slot} ${set.key}/${set.tier}`).toBe(set.hash);
    }
  });
});
