/**
 * The bright-star catalog: HYG Database v3.7 (Astronexus) filtered to visual
 * magnitude ≤ 7.5, sorted by magnitude, Sol first — 25,792 stars, 343 named.
 *
 * The catalog itself is NOT source: it ships as the binary sidecar
 * public/stardata/bright-stars.v1.bin (~313KB), regenerated only via
 * `npm run gen:stars` (which also rewrites brightStarsGolden.json — fixture
 * updates are deliberate, never incidental). It used to live here as a 1.9MB
 * object literal, which put a multi-hundred-ms parse on the boot critical
 * path of every visit; the binary decodes in single-digit milliseconds and
 * its values are bit-identical to what the literal carried (the generator
 * rounds ra/dec to 4 decimals and mag/ci to 2, so the ×1e4/×1e2 integer
 * quantization is exact — asserted per star at generation).
 *
 * This module is the pure half: format parser + the session's catalog store.
 * The fetch/retry half is world/starCatalogLoader.ts, which loads the bin
 * behind the loading screen (index.html fetch-warms it at HTML parse) and
 * installs it here before anything can ask. The accessor THROWS before then:
 * a starfield built from a missing catalog is exactly the kind of half-loaded
 * scene this app promises never to show.
 *
 * Format v1, little-endian (encoder: tools/starBinCodec.mjs):
 *   header (12B): magic 'MSTR' | version u16 = 1 | nameCount u16 | starCount u32
 *   stars (starCount × 12B): raDeg×1e4 i32 | decDeg×1e4 i32 |
 *                            magnitude×1e2 i16 | colorIndex×1e2 i16
 *   names (nameCount ×): starIndex u16 | byteLen u8 | UTF-8 bytes
 * A format change ships as bright-stars.v2.bin + a new constant here, so a
 * stale HTML/bundle from the 10-minute Pages cache window keeps fetching the
 * format it can parse.
 */

export interface StarRecord {
  raDeg: number;
  decDeg: number;
  magnitude: number;
  colorIndex: number;
  name?: string;
}

/** Sidecar path under BASE_URL. Runtime string — invisible to tsc and Vite;
 *  pinned to the shipped file by the on-disk test alongside this module. */
export const BRIGHT_STAR_BIN_FILE = 'stardata/bright-stars.v1.bin';

const MAGIC = 0x5254534d; // 'MSTR' read as u32 LE
const VERSION = 1;

/** Parse the sidecar. Throws on anything that isn't a complete, well-formed
 *  v1 catalog — truncated bytes must never install as a shorter sky. */
export function parseBrightStarBin(buf: ArrayBuffer): StarRecord[] {
  const view = new DataView(buf);
  if (buf.byteLength < 12 || view.getUint32(0, true) !== MAGIC) {
    throw new Error('bright-star bin: bad magic');
  }
  const version = view.getUint16(4, true);
  if (version !== VERSION) {
    throw new Error(`bright-star bin: unsupported version ${version}`);
  }
  const nameCount = view.getUint16(6, true);
  const starCount = view.getUint32(8, true);
  const starsEnd = 12 + starCount * 12;
  if (buf.byteLength < starsEnd) {
    throw new Error('bright-star bin: truncated star block');
  }
  const records: StarRecord[] = new Array(starCount);
  for (let i = 0; i < starCount; i++) {
    const offset = 12 + i * 12;
    records[i] = {
      raDeg: view.getInt32(offset, true) / 1e4,
      decDeg: view.getInt32(offset + 4, true) / 1e4,
      magnitude: view.getInt16(offset + 8, true) / 1e2,
      colorIndex: view.getInt16(offset + 10, true) / 1e2,
    };
  }
  const decoder = new TextDecoder();
  let offset = starsEnd;
  for (let n = 0; n < nameCount; n++) {
    if (buf.byteLength < offset + 3) {
      throw new Error('bright-star bin: truncated name block');
    }
    const starIndex = view.getUint16(offset, true);
    const byteLen = view.getUint8(offset + 2);
    if (starIndex >= starCount || buf.byteLength < offset + 3 + byteLen) {
      throw new Error('bright-star bin: bad name record');
    }
    records[starIndex].name = decoder.decode(new Uint8Array(buf, offset + 3, byteLen));
    offset += 3 + byteLen;
  }
  if (offset !== buf.byteLength) {
    throw new Error('bright-star bin: trailing bytes');
  }
  return records;
}

let catalog: StarRecord[] | null = null;

/** The session's catalog. Loaded once by world/starCatalogLoader before the
 *  first consumer runs (PlanetariumMode.activate gates the starfield on it);
 *  a read before that is a boot-ordering bug and fails loudly. */
export function brightStarCatalog(): StarRecord[] {
  if (!catalog) {
    throw new Error('bright-star catalog read before loadBrightStarCatalog resolved');
  }
  return catalog;
}

/** Install the parsed catalog (loader + test seam). */
export function setBrightStarCatalog(records: StarRecord[]): void {
  catalog = records;
}

// An HMR re-eval of this module would reset the store while the loader's memo
// still says "loaded", stranding every consumer on the throw until a manual
// reload. Editing this file in dev is rare; make it a clean full reload
// (self-accept then invalidate — Vite's way of saying "never hot-swap me").
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    import.meta.hot?.invalidate();
  });
}
