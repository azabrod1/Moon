/**
 * Types for the tile publisher, hand-written because tools/ sits outside the
 * TypeScript project (tsconfig includes only src/). They exist so
 * src/planetarium/publishTiles.test.ts can run the real tool against a
 * temporary root and checkout instead of restating what it does.
 */

/** A set found in a tiles root, proven to hash to the name it is under. */
export interface TileSetOnDisk {
  /** `<key>/<tier>`, the way the set table keys it. */
  id: string;
  key: string;
  tier: string;
  /** `<tier>.<setHash8>` — the folder name, which is the content address. */
  folder: string;
  /** Absolute path to the set in the root (a level-0 link is not resolved). */
  dir: string;
  files: string[];
  bytes: number;
}

/** A set copied into the repo this run, and where it landed. Empty destination
 *  for a dry run with no checkout. */
export interface PublishedSet extends TileSetOnDisk {
  dest: string;
}

export interface PublishOptions {
  /** Tiles root holding sets.v1.json and the set folders it names. */
  root: string;
  /** Local checkout of the tiles repository. Required unless dryRun or verifyOnly. */
  repo?: string;
  /** The ref the app's VITE_TILE_ORIGIN is built against. Default 'main'. */
  ref?: string;
  dryRun?: boolean;
  verifyOnly?: boolean;
  /** `<user>/<repo>` for the CDN URL, when the checkout has no GitHub origin. */
  origin?: string;
  log?: (line: string) => void;
}

export interface PublishResult {
  sets: TileSetOnDisk[];
  added: PublishedSet[];
  present: TileSetOnDisk[];
  totalBytes: number;
  /** The full `https://cdn.jsdelivr.net/gh/<user>/<repo>@<ref>` URL, or ''. */
  origin: string;
  /** The commit made in the checkout, or null when nothing changed. */
  commit: string | null;
}

/** `<user>/<repo>` out of a GitHub remote URL; null for any other host. */
export function ownerRepoFromRemote(url: string): string | null;

/** Prove every set a root's table names is on disk with the bytes its folder
 *  name promises. Throws naming the set on the first failure. */
export function verifyRoot(root: string): Promise<{ table: Record<string, unknown>; sets: TileSetOnDisk[] }>;

/** `<user>/<repo>`: the checkout's GitHub origin, else the flag. Throws when
 *  they disagree or neither is there. */
export function resolveOwnerRepo(remoteUrl: string, flag: string): string;

export function publishTiles(options: PublishOptions): Promise<PublishResult>;
