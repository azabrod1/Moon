import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TABLE_BEGIN, TABLE_END, mergeSectorTable, parseSectorTable, sectorTableOrder } from '../../../tools/sectorTable.mjs';
import { SECTOR_SET_TABLE, type GeneratedSectorSet } from './sectorSets.generated';

// gen-tiles ends every run by writing the set table twice (tools/sectorTable.mjs
// has the two scopes): the root's sets.v1.json from the root's folders alone,
// and the app's generated module from those folders plus the rows it already
// held for sets published from the tile host, which no checkout has a folder
// for. A module rebuilt from one root's folders once dropped those rows on
// every re-cut, and they were put back by hand. These pin the reconciliation,
// and that the parser reads the module the app ships.

function row(setHash8: string, tier = '16k'): GeneratedSectorSet {
  const level = ({ '16k': 0, '32k': 1, '64k': 2 } as Record<string, number>)[tier] ?? 0;
  return {
    setHash8,
    grid: { cols: 8 << level, rows: 4 << level },
    content: 2032,
    gutter: 8,
    tileWidth: 2048,
    tileHeight: 2048,
    baseWidth: 16256 << level,
    spanU: 1,
    fileCount: 32 << (2 * level),
  };
}

describe('the sector-set table a root writes into the app', () => {
  it('keeps the rows of sets the root does not hold and takes the root’s for the ones it does', () => {
    const held = {
      'earth-day.v2/16k': row('aaaaaaaa'),
      'earth-day.v2/32k': row('bbbbbbbb', '32k'),
      'mars.v3/16k': row('cccccccc'),
    };
    const fromRoot = {
      'earth-day.v2/16k': row('dddddddd'), // re-cut: the root's row, under its new hash
      'moon/16k': row('eeeeeeee'),
    };
    const { table, kept } = mergeSectorTable(fromRoot, held);
    expect(table['earth-day.v2/16k']).toEqual(fromRoot['earth-day.v2/16k']);
    expect(table['earth-day.v2/32k']).toEqual(held['earth-day.v2/32k']); // published from the host: kept
    expect(table['mars.v3/16k']).toEqual(held['mars.v3/16k']);
    expect(table['moon/16k']).toEqual(fromRoot['moon/16k']);
    expect(Object.keys(table)).toHaveLength(4);
    expect(kept).toEqual(['earth-day.v2/32k', 'mars.v3/16k']);
  });

  it('writes the table in the order a walk of the root would, wherever a row came from', () => {
    // Keys sorted, then the folder name <tier>.<hash>: the order a directory
    // walk gives, so a kept row sits where its folder would and a rewrite
    // that changed nothing moves nothing.
    const fromRoot = { 'moon/16k': row('11111111'), 'earth-day.v2/16k': row('22222222') };
    const held = {
      'earth-day.v2/64k': row('00000000', '64k'),
      'earth-day.v2/32k': row('33333333', '32k'),
      'earth-bump/2k': row('44444444'),
    };
    const { table } = mergeSectorTable(fromRoot, held);
    expect(Object.keys(table)).toEqual(['earth-bump/2k', 'earth-day.v2/16k', 'earth-day.v2/32k', 'earth-day.v2/64k', 'moon/16k']);
    expect(sectorTableOrder(table)).toEqual(Object.keys(table));
  });

  it('an empty held table is the root’s alone, and an empty root keeps everything', () => {
    const only = { 'moon/16k': row('11111111') };
    expect(mergeSectorTable(only, {})).toEqual({ table: only, kept: [] });
    expect(mergeSectorTable({}, only)).toEqual({ table: only, kept: ['moon/16k'] });
  });

  it('reads the shipped module back to the table the app imports, in walk order', () => {
    const source = readFileSync(resolve(__dirname, 'sectorSets.generated.ts'), 'utf8');
    expect(parseSectorTable(source)).toEqual(SECTOR_SET_TABLE);
    // In walk order already, so an index that keeps every row rewrites the
    // module byte for byte.
    expect(Object.keys(SECTOR_SET_TABLE)).toEqual(sectorTableOrder(SECTOR_SET_TABLE));
    expect(parseSectorTable(`${TABLE_BEGIN} {"a/1k": {"setHash8": "0"}} ${TABLE_END};`)).toEqual({ 'a/1k': { setHash8: '0' } });
    expect(() => parseSectorTable('nothing')).toThrow(/markers/);
  });
});
