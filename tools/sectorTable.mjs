// The app's sector-set table and a tiles root's: one shape, two scopes.
//
// gen-tiles ends every run by writing the set table twice (the generated
// module's header explains the table itself). A tiles root's sets.v1.json is
// the table of the sets IN that root — the file publish-tiles reads to find
// the folders it copies and holds to their bytes — so it is written from that
// root's folders alone. The app's generated module is wider: a set published
// from the tile host (Earth's 32K and 64K levels, its night pyramid, Mars's
// finer levels) has a folder in no checkout, so a module rebuilt from any one
// root's folders dropped every such row, and each re-cut ended with the rows
// put back by hand. Here the two are reconciled: the root's rows for every
// set it holds, the app's own rows for every set it does not.
//
// Dependency-free, so a test can import it beside the tool.

/** The markers the generated module keeps its JSON between, so a tool with no
 *  TypeScript toolchain (tools/swPlugin.mjs, this file) can read the table. */
export const TABLE_BEGIN = '/* table:begin */';
export const TABLE_END = '/* table:end */';

/** The table out of the generated module's source. */
export function parseSectorTable(source) {
  const begin = source.indexOf(TABLE_BEGIN);
  const end = begin < 0 ? -1 : source.indexOf(TABLE_END, begin + TABLE_BEGIN.length);
  if (begin < 0 || end < 0) throw new Error('sectorSets.generated.ts has no table markers');
  return JSON.parse(source.slice(begin + TABLE_BEGIN.length, end));
}

/** The table's `<key>/<tier>` ids in the order an index of a root writes
 *  them: keys sorted, then the folder name `<tier>.<setHash8>` sorted — a
 *  directory walk's order, so a kept row sits exactly where its folder would. */
export function sectorTableOrder(table) {
  return Object.keys(table).sort((a, b) => {
    const [keyA, tierA] = a.split('/');
    const [keyB, tierB] = b.split('/');
    if (keyA !== keyB) return keyA < keyB ? -1 : 1;
    const folderA = `${tierA}.${table[a].setHash8}`;
    const folderB = `${tierB}.${table[b].setHash8}`;
    return folderA < folderB ? -1 : folderA > folderB ? 1 : 0;
  });
}

/**
 * The app's table from a root's sets and the rows the app already holds for
 * sets the root does not: a `<key>/<tier>` the root holds takes the root's row
 * (a re-cut set replaces its own row, under its new hash), every other row is
 * kept as it stands, and the whole is in walk order. Returns the table and
 * the ids it kept, for the caller to print: a set the app has retired is
 * deleted from the table on purpose, never carried along unnoticed.
 */
export function mergeSectorTable(fromRoot, held) {
  const merged = { ...held, ...fromRoot };
  const table = {};
  for (const id of sectorTableOrder(merged)) table[id] = merged[id];
  const kept = Object.keys(table).filter((id) => !Object.hasOwn(fromRoot, id));
  return { table, kept };
}
