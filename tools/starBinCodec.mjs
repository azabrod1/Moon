/**
 * Encoder for the bright-star catalog's binary sidecar
 * (public/stardata/bright-stars.v1.bin) — the node-side half of the format
 * whose browser-side parser lives in src/planetarium/data/brightStars.ts.
 * Used by gen-stars.mjs; nothing at runtime imports this.
 *
 * Format v1, all little-endian:
 *   header (12B): magic 'MSTR' | version u16 = 1 | nameCount u16 | starCount u32
 *   stars (starCount × 12B): raDeg×1e4 i32 | decDeg×1e4 i32 |
 *                            magnitude×1e2 i16 | colorIndex×1e2 i16
 *   names (nameCount ×): starIndex u16 | byteLen u8 | UTF-8 bytes
 *
 * The integer scales are exact for the catalog as generated: gen-stars.mjs
 * rounds ra/dec to 4 decimals and magnitude/colorIndex to 2, and a decimal
 * with ≤N places and the integer quotient value×10^N / 10^N round to the
 * SAME nearest double — so decode reproduces every value bit-identically.
 * encode() asserts that property per field per star and throws otherwise:
 * a source change that breaks it (more decimals, out-of-range values) must
 * be a deliberate format bump, never silent value drift.
 */

export const STAR_BIN_MAGIC = 'MSTR';
export const STAR_BIN_VERSION = 1;

const RA_DEC_SCALE = 1e4;
const MAG_CI_SCALE = 1e2;

function quantize(value, scale, range, field, index) {
  const scaled = Math.round(value * scale);
  if (!Number.isFinite(value) || scaled / scale !== value) {
    throw new Error(
      `star[${index}].${field} = ${value} does not survive the ×${scale} integer round-trip`,
    );
  }
  if (scaled < range.min || scaled > range.max) {
    throw new Error(`star[${index}].${field} = ${value} exceeds the ${field} storage range`);
  }
  return scaled;
}

const I32 = { min: -2147483648, max: 2147483647 };
const I16 = { min: -32768, max: 32767 };

/** Encode the catalog. Records keep their array order; names refer back by index. */
export function encodeBrightStarBin(records) {
  // u16 name indices address records 0..65535, so up to 65,536 records fit.
  if (records.length > 0x10000) {
    throw new Error(`star count ${records.length} exceeds the u16 name-index space`);
  }
  const encoder = new TextEncoder();
  const names = [];
  let namesBytes = 0;
  records.forEach((star, i) => {
    if (star.name === undefined) return;
    const bytes = encoder.encode(star.name);
    if (bytes.length === 0 || bytes.length > 0xff) {
      throw new Error(`star[${i}] name "${star.name}" is empty or exceeds 255 UTF-8 bytes`);
    }
    names.push({ index: i, bytes });
    namesBytes += 3 + bytes.length;
  });
  if (names.length > 0xffff) {
    throw new Error(`name count ${names.length} exceeds u16`);
  }

  const buf = new ArrayBuffer(12 + records.length * 12 + namesBytes);
  const view = new DataView(buf);
  const out = new Uint8Array(buf);
  out.set(encoder.encode(STAR_BIN_MAGIC), 0);
  view.setUint16(4, STAR_BIN_VERSION, true);
  view.setUint16(6, names.length, true);
  view.setUint32(8, records.length, true);

  let offset = 12;
  records.forEach((star, i) => {
    view.setInt32(offset, quantize(star.raDeg, RA_DEC_SCALE, I32, 'raDeg', i), true);
    view.setInt32(offset + 4, quantize(star.decDeg, RA_DEC_SCALE, I32, 'decDeg', i), true);
    view.setInt16(offset + 8, quantize(star.magnitude, MAG_CI_SCALE, I16, 'magnitude', i), true);
    view.setInt16(offset + 10, quantize(star.colorIndex, MAG_CI_SCALE, I16, 'colorIndex', i), true);
    offset += 12;
  });
  for (const { index, bytes } of names) {
    view.setUint16(offset, index, true);
    view.setUint8(offset + 2, bytes.length);
    out.set(bytes, offset + 3);
    offset += 3 + bytes.length;
  }
  return out;
}

/**
 * The golden fixture pinned by src/planetarium/data/brightStars.test.ts —
 * regenerated together with the bin so `npm run gen:stars` owns both, the
 * way gen:moons owns its goldens. The FNV-1a hash is over the same canonical
 * serialization the test recomputes in TS; the two implementations verify
 * each other every test run.
 */
export function catalogFixture(records) {
  const named = records
    .map((star, index) => ({ star, index }))
    .filter((entry) => entry.star.name !== undefined);
  const sampleIndices = new Set([
    ...Array.from({ length: 12 }, (_, i) => i),
    records.length - 1,
    named[0].index,
    named[Math.floor(named.length / 2)].index,
    named[named.length - 1].index,
  ]);
  return {
    count: records.length,
    nameCount: named.length,
    fnv1a32: fnv1a32(canonicalCatalogString(records)),
    samples: [...sampleIndices]
      .sort((a, b) => a - b)
      .map((index) => ({ index, ...records[index] })),
  };
}

export function canonicalCatalogString(records) {
  return records
    .map((s) => `${s.raDeg},${s.decDeg},${s.magnitude},${s.colorIndex},${s.name ?? ''}`)
    .join('\n');
}

export function fnv1a32(text) {
  const bytes = new TextEncoder().encode(text);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
