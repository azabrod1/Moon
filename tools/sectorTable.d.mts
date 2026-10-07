// Types for tools/sectorTable.mjs, so the tests can import the tool's own
// table reconciliation rather than a copy of it.

/** The markers the generated module keeps its JSON table between. */
export const TABLE_BEGIN: string;
export const TABLE_END: string;

/** The table out of the generated module's source. */
export function parseSectorTable<T = unknown>(source: string): Record<string, T>;

/** The table's `<key>/<tier>` ids in the order an index of a root writes them. */
export function sectorTableOrder<T extends { setHash8: string }>(table: Record<string, T>): string[];

/** The root's rows for the sets it holds, the held rows for every other set,
 *  in walk order, with the ids that were kept. */
export function mergeSectorTable<T extends { setHash8: string }>(
  fromRoot: Record<string, T>,
  held: Record<string, T>,
): { table: Record<string, T>; kept: string[] };
