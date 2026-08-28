/**
 * The shipped tile sets against the layout the app reads them with. The tool
 * that cuts tiles (tools/gen-tiles.mjs) and the runtime that samples them
 * (sectorGrid / sectorStreamer) hold the same gutter, grid and crop-width
 * arithmetic independently; this test ties them together through the table
 * gen-tiles generates, so a regeneration with a different gutter, a base map
 * at a new width, or a set the app doesn't name fails CI instead of shipping
 * misregistered sectors. Every LEVEL of a body's colour pyramid is one of
 * those sets and is checked as one.
 *
 * Two halves, deliberately separate. The first needs nothing but the
 * generated table and the base maps, and stays true wherever the tiles are
 * served from. The second reads the tile files themselves — including
 * recomputing each set's hash from its bytes — and is the half that belongs
 * to gen-tiles once the sets are published from their own repository rather
 * than from public/. Reads only WebP headers — no decode.
 *
 * That second half runs against ONE tiles root: public/textures/tiles, or
 * whatever `TILES_ROOT` names (a staging root holding the levels that are too
 * big to ship inside the app). A set the root does not hold is skipped only
 * for a reason `absenceAllowed` will state — never for a level-0 set or a
 * crop, which ship in the app and whose absence is exactly the bug this
 * suite exists to catch.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { SECTOR_GRID_16K, SECTOR_TILE, dataCropLayout, type SectorGrid } from './sectorGrid';
import { SECTOR_SETS, levelSourceWidth, type SectorTileSet } from './sectorStreamer';
import { SECTOR_SET_TABLE, type GeneratedSectorSet } from './sectorSets.generated';
import { PLANET_TEXTURE_FILES } from '../PlanetFactory';

const TEXTURES = resolve(__dirname, '../../../public/textures');
/** The tiles root this run reads. A finer level is gigabytes and is published
 *  from the tile host rather than from public/, so a developer checking a
 *  staging root points this at it; CI has only the app's own. */
const TILES_ROOT = process.env.TILES_ROOT
  ? resolve(process.env.TILES_ROOT)
  : resolve(TEXTURES, 'tiles');
const SETS_JSON = resolve(TILES_ROOT, 'sets.v1.json');

/** Canvas size from a WebP container: VP8 (lossy), VP8L (lossless) or VP8X
 *  (extended) first chunk. */
function webpSize(file: string): { width: number; height: number } {
  // The header only: a level of tiles is 128 files and a level below it 512,
  // and reading them whole would put hundreds of megabytes through every
  // test run for thirty bytes of it.
  const b = Buffer.alloc(32);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, b, 0, b.length, 0);
  } finally {
    closeSync(fd);
  }
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

interface AppSet {
  body: string;
  slot: string;
  set: SectorTileSet;
  entry: GeneratedSectorSet;
  /** The grid the app will sample this set on. */
  grid: SectorGrid;
  /** Which level of the body's colour pyramid this is; null for a crop, which
   *  belongs to level 0 whatever samples it. */
  level: number | null;
}

/** Why a set the app names may legitimately have no folder under the tiles
 *  root being read — and nothing else may. A finer colour level is hundreds
 *  of megabytes published from the tile host; a root named by TILES_ROOT is
 *  being checked instead of the app's own. A level-0 set or a crop ships
 *  inside the app, so its absence is a 404'd quarter of a globe, not a
 *  configuration. */
export function absenceAllowed(set: Pick<AppSet, 'level'>): string | null {
  if (process.env.TILES_ROOT) return `TILES_ROOT points at ${process.env.TILES_ROOT}, not the app's own tiles`;
  if (set.level !== null && set.level > 0) return `level ${set.level} is published from the tile host, not from public/`;
  return null;
}

/** Every set the app names, with the table entry it resolves to. Every LEVEL
 *  of a body's colour pyramid is one of them: levels are separate sets, each
 *  its own row of the table under its own hash, so a level nothing published
 *  has to fail here rather than 404 a quarter of a globe into softness. */
function appSets(): AppSet[] {
  const out: AppSet[] = [];
  for (const [body, spec] of Object.entries(SECTOR_SETS)) {
    const named: Array<[string, SectorTileSet, SectorGrid, number | null]> = spec.levels.map(
      (l, level) => [`map L${level}`, l.set, l.grid, level],
    );
    // Crops are cut for level 0 and sampled there by every level above it.
    for (const [slot, crop] of Object.entries(spec.crops)) named.push([slot, crop, SECTOR_GRID_16K, null]);
    for (const [slot, set, grid, level] of named) {
      const entry = SECTOR_SET_TABLE[`${set.key}/${set.tier}`];
      expect(entry, `${body} ${slot}: no generated entry for ${set.key}/${set.tier}`).toBeDefined();
      out.push({ body, slot, set, entry, grid, level });
    }
  }
  return out;
}

function setDir(set: SectorTileSet): string {
  return resolve(TILES_ROOT, set.key, `${set.tier}.${set.hash}`);
}

/** Every `<key>/<tier>` the tiles root actually holds a folder for. */
function setsOnDisk(): string[] {
  const out: string[] = [];
  for (const key of readdirSync(TILES_ROOT)) {
    const keyDir = resolve(TILES_ROOT, key);
    if (!statSync(keyDir).isDirectory()) continue;
    for (const folder of readdirSync(keyDir)) {
      if (!statSync(resolve(keyDir, folder)).isDirectory()) continue;
      out.push(`${key}/${folder.split('.')[0]}`);
    }
  }
  return out;
}

/** The sets this run can read bytes for, and a line per set it cannot. */
function setsOnDiskForApp(): { present: AppSet[]; skipped: string[] } {
  const present: AppSet[] = [];
  const skipped: string[] = [];
  for (const s of appSets()) {
    if (existsSync(setDir(s.set))) {
      present.push(s);
      continue;
    }
    const why = absenceAllowed(s);
    expect(why, `${s.body} ${s.slot}: no folder ${s.set.key}/${s.set.tier}.${s.set.hash} under ${TILES_ROOT}`).not.toBeNull();
    skipped.push(`${s.set.key}/${s.set.tier}: ${why}`);
  }
  return { present, skipped };
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
    // The grid is the set's own: a finer colour level is the 16K grid
    // doubled, and a crop is cut on level 0's.
    for (const { body, slot, entry, grid } of appSets()) {
      expect(entry.grid, `${body} ${slot}`).toEqual(grid);
      expect(entry.gutter, `${body} ${slot}`).toBe(SECTOR_TILE.gutterY);
      expect(entry.fileCount, `${body} ${slot}`).toBe(grid.cols * grid.rows);
      expect(entry.baseWidth, `${body} ${slot}`).toBe(entry.content * entry.grid.cols);
    }
  });

  it('every colour level is the tile size and source width it declares', () => {
    // A level's demand is read against the width of the equirect it was cut
    // from, which the streamer derives from the layout below. This is where
    // that derivation meets the width gen-tiles measured on the files: a
    // level pointed at a set cut at another size would otherwise ask for
    // tiles at a magnification that set cannot repay.
    for (const [body, spec] of Object.entries(SECTOR_SETS)) {
      for (const [level, l] of spec.levels.entries()) {
        const entry = SECTOR_SET_TABLE[`${l.set.key}/${l.set.tier}`];
        expect({ width: entry.tileWidth, height: entry.tileHeight }, `${body} L${level}`).toEqual({
          width: l.layout.width,
          height: l.layout.height,
        });
        expect(entry.spanU, `${body} L${level}`).toBe(l.layout.spanU);
        expect(entry.baseWidth, `${body} L${level}`).toBe(levelSourceWidth(l));
      }
    }
  });

  it('normal-map crops span two sectors, scalar crops one', () => {
    // The tangent frame a normal map is sampled in needs the neighbouring
    // sector on both sides; bump and roughness are scalars and need none.
    // The runtime reads spanU from the generated table, so a re-cut at the
    // wrong span would agree with itself everywhere — this is the one place
    // the span is stated rather than measured.
    for (const [body, spec] of Object.entries(SECTOR_SETS)) {
      for (const [slot, crop] of Object.entries(spec.crops)) {
        const want = slot === 'normalMap' ? 2 : 1;
        expect(crop.spanU, `${body} ${slot}`).toBe(want);
        expect(SECTOR_SET_TABLE[`${crop.key}/${crop.tier}`].spanU, `${body} ${slot}`).toBe(want);
      }
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
    expect(SECTOR_SETS.Earth.levels[0].set.key).toBe(stem(PLANET_TEXTURE_FILES.earthDay));
    expect(SECTOR_SETS.Mars.levels[0].set.key).toBe(stem(PLANET_TEXTURE_FILES.mars));
    expect(SECTOR_SETS.Moon.levels[0].set.key).toBe(stem(PLANET_TEXTURE_FILES.moon));
    expect(SECTOR_SETS.Earth.crops.bumpMap!.key).toBe(stem(PLANET_TEXTURE_FILES.earthBump));
    expect(SECTOR_SETS.Earth.crops.roughnessMap!.key).toBe(stem(PLANET_TEXTURE_FILES.earthRoughness));
    expect(SECTOR_SETS.Mars.crops.normalMap!.key).toBe(stem(PLANET_TEXTURE_FILES.marsNormal));
    expect(SECTOR_SETS.Moon.crops.normalMap!.key).toBe(stem(PLANET_TEXTURE_FILES.moonNormal));
    // Every level of one body is a cut of that same map, so they share its
    // stem and are told apart by their tier — which is what makes `<key>/
    // <tier>` a name for one level rather than for a whole pyramid.
    for (const [body, spec] of Object.entries(SECTOR_SETS)) {
      const tiers = new Set<string>();
      for (const l of spec.levels) {
        expect(l.set.key, `${body} level keys`).toBe(spec.levels[0].set.key);
        expect(tiers.has(l.set.tier), `${body}: two levels in tier ${l.set.tier}`).toBe(false);
        tiers.add(l.set.tier);
      }
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

describe('sector tile sets: the files on disk', () => {
  // This half only holds while the sets ship inside the app. Once they are
  // published from their own repository the same checks live in
  // `gen-tiles --verify`, where the bytes are.
  it('only excuses a missing set folder for a level the app does not ship', () => {
    // This rule is what lets the suite run in CI, where only public/ exists.
    // It must never be able to excuse a set that ships inside the app: a
    // missing level-0 folder or crop is a quarter of a globe served as 404s,
    // which the streamer survives by staying soft and saying nothing.
    expect(absenceAllowed({ level: 0 })).toBeNull();
    expect(absenceAllowed({ level: null })).toBeNull();
    expect(absenceAllowed({ level: 1 })).toContain('tile host');
    const before = process.env.TILES_ROOT;
    try {
      process.env.TILES_ROOT = '/somewhere/else';
      expect(absenceAllowed({ level: 0 })).toContain('/somewhere/else');
    } finally {
      if (before === undefined) delete process.env.TILES_ROOT;
      else process.env.TILES_ROOT = before;
    }
  });

  it('every named set is a full grid of tiles at its declared size', () => {
    const { present, skipped } = setsOnDiskForApp();
    for (const line of skipped) console.log(`  skipped (not under ${TILES_ROOT}) ${line}`);
    for (const { body, slot, set, entry } of present) {
      const dir = setDir(set);
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
    // gen-tiles writes both from one object in one pass, so an entry can only
    // differ if a run was interrupted or one of them was hand-edited — and
    // sets.v1.json is what a publisher or a smoke script reads to find the
    // folder the app is asking for. A root publishes the sets that are IN it,
    // so the file is the table restricted to this root: every entry identical,
    // naming every folder the root holds and no folder it does not.
    const published: Record<string, GeneratedSectorSet> = JSON.parse(readFileSync(SETS_JSON, 'utf8'));
    for (const [id, entry] of Object.entries(published)) {
      expect(entry, `${id} in sets.v1.json`).toEqual(SECTOR_SET_TABLE[id]);
    }
    expect(new Set(Object.keys(published))).toEqual(new Set(setsOnDisk()));
  });

  it('every set folder is named for the bytes inside it', () => {
    // gen-tiles' recipe: SHA-256 over the sorted `<name>\0<file sha256>\n`
    // list of the whole set, first 8 hex. One changed tile moves the folder,
    // which is what lets a tile URL be cached with no expiry.
    for (const { body, slot, set } of setsOnDiskForApp().present) {
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
