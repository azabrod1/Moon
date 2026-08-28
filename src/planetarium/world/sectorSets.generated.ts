/**
 * GENERATED — written by `node tools/gen-tiles.mjs` from the tile sets on
 * disk (and mirrored in that tiles root's sets.v1.json). Never edit by hand.
 *
 * A sector tile set is published under a folder named for its own contents,
 * tiles/<key>/<tier>.<setHash8>/, and this table is where the app reads that
 * hash. The set hash is what a tile pathname promises: those exact bytes or a
 * 404, never a re-cut set under a name a cache already holds — which is what
 * lets a tile be cached forever, on a CDN or in the service worker, without a
 * revalidation. The layout numbers are the ones the tiles were measured to
 * have; world/sectorGrid.ts samples them with the same arithmetic and
 * sectorTiles.assets.test.ts holds the two together.
 *
 * The literal below is JSON between its markers so tools/swPlugin.mjs can
 * read the same table at build time without a TypeScript toolchain.
 */

export interface GeneratedSectorSet {
  /** First 8 hex of SHA-256 over the sorted (file name, file SHA-256) list
   *  of the whole set — and the suffix of the folder it lives in. */
  setHash8: string;
  grid: { cols: number; rows: number };
  /** Surface px per sector inside the gutter. */
  content: number;
  gutter: number;
  tileWidth: number;
  tileHeight: number;
  /** Width of the equirect the set was cut from: content × cols. */
  baseWidth: number;
  /** Sectors of longitude one tile spans (normal-map crops: 2). */
  spanU: number;
  fileCount: number;
}

/** Every shipped set, keyed `<key>/<tier>`. */
export const SECTOR_SET_TABLE: Record<string, GeneratedSectorSet> = /* table:begin */ {
  "earth-bump/2k": {
    "setHash8": "bcb10829",
    "grid": {
      "cols": 8,
      "rows": 4
    },
    "content": 256,
    "gutter": 8,
    "tileWidth": 272,
    "tileHeight": 272,
    "baseWidth": 2048,
    "spanU": 1,
    "fileCount": 32
  },
  "earth-day.v2/16k": {
    "setHash8": "62444e44",
    "grid": {
      "cols": 8,
      "rows": 4
    },
    "content": 2032,
    "gutter": 8,
    "tileWidth": 2048,
    "tileHeight": 2048,
    "baseWidth": 16256,
    "spanU": 1,
    "fileCount": 32
  },
  "earth-day.v2/32k": {
    "setHash8": "f4174afc",
    "grid": {
      "cols": 16,
      "rows": 8
    },
    "content": 2032,
    "gutter": 8,
    "tileWidth": 2048,
    "tileHeight": 2048,
    "baseWidth": 32512,
    "spanU": 1,
    "fileCount": 128
  },
  "earth-night.v2/16k": {
    "setHash8": "94dfda55",
    "grid": {
      "cols": 8,
      "rows": 4
    },
    "content": 2032,
    "gutter": 8,
    "tileWidth": 2048,
    "tileHeight": 2048,
    "baseWidth": 16256,
    "spanU": 1,
    "fileCount": 32
  },
  "earth-night.v2/32k": {
    "setHash8": "abb03849",
    "grid": {
      "cols": 16,
      "rows": 8
    },
    "content": 2032,
    "gutter": 8,
    "tileWidth": 2048,
    "tileHeight": 2048,
    "baseWidth": 32512,
    "spanU": 1,
    "fileCount": 128
  },
  "earth-roughness.v2/4k": {
    "setHash8": "a10813ad",
    "grid": {
      "cols": 8,
      "rows": 4
    },
    "content": 512,
    "gutter": 8,
    "tileWidth": 528,
    "tileHeight": 528,
    "baseWidth": 4096,
    "spanU": 1,
    "fileCount": 32
  },
  "mars-normal.v2/2k": {
    "setHash8": "f7efa0d7",
    "grid": {
      "cols": 8,
      "rows": 4
    },
    "content": 180,
    "gutter": 8,
    "tileWidth": 392,
    "tileHeight": 196,
    "baseWidth": 1440,
    "spanU": 2,
    "fileCount": 32
  },
  "mars.v2/16k": {
    "setHash8": "917c9862",
    "grid": {
      "cols": 8,
      "rows": 4
    },
    "content": 2032,
    "gutter": 8,
    "tileWidth": 2048,
    "tileHeight": 2048,
    "baseWidth": 16256,
    "spanU": 1,
    "fileCount": 32
  },
  "moon/16k": {
    "setHash8": "51b7c463",
    "grid": {
      "cols": 8,
      "rows": 4
    },
    "content": 2032,
    "gutter": 8,
    "tileWidth": 2048,
    "tileHeight": 2048,
    "baseWidth": 16256,
    "spanU": 1,
    "fileCount": 32
  },
  "moon-normal/4k": {
    "setHash8": "09986655",
    "grid": {
      "cols": 8,
      "rows": 4
    },
    "content": 360,
    "gutter": 8,
    "tileWidth": 752,
    "tileHeight": 376,
    "baseWidth": 2880,
    "spanU": 2,
    "fileCount": 32
  }
} /* table:end */;
