/**
 * Types for the tile-set content address, hand-written because tools/ sits
 * outside the TypeScript project (tsconfig includes only src/). They let the
 * colocated tests hash a fixture with the very function that names a set on
 * disk, rather than with a copy of the formula.
 */

/** The tiles of a set, in the order its hash is taken over. */
export function tileNames(files: string[]): string[];

/** SHA-256 of a file, streamed, as hex. */
export function fileDigest(file: string): Promise<string>;

/** First 8 hex of SHA-256 over the sorted (name, file digest) list of a set. */
export function setHash8(dir: string, files: string[]): Promise<string>;
