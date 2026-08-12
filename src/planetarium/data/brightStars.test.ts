import { describe, expect, it } from 'vitest';
import { parseBrightStarBin, type StarRecord } from './brightStars';
import { loadBrightStarCatalogFromDisk } from './brightStarsTestCatalog';
import golden from './brightStarsGolden.json';

// The golden fixture was captured from the last TS-literal catalog at the
// moment of the binary migration and is regenerated ONLY by `npm run
// gen:stars` (deliberately, alongside the bin). It pins the transport: if the
// shipped sidecar decodes to even one different value, the hash breaks.

/** Same canonical serialization + FNV-1a as tools/starBinCodec.mjs — the TS
 *  twin verifies the node-side one every run; drift in either breaks here. */
function fnv1a32(records: StarRecord[]): number {
  const text = records
    .map((s) => `${s.raDeg},${s.decDeg},${s.magnitude},${s.colorIndex},${s.name ?? ''}`)
    .join('\n');
  const bytes = new TextEncoder().encode(text);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

describe('bright-star binary sidecar', () => {
  const records = loadBrightStarCatalogFromDisk();

  it('decodes to exactly the catalog the golden fixture pinned', () => {
    expect(records).toHaveLength(golden.count);
    expect(records.filter((s) => s.name !== undefined)).toHaveLength(golden.nameCount);
    expect(fnv1a32(records)).toBe(golden.fnv1a32);
  });

  it('reproduces every sampled record field-for-field', () => {
    for (const { index, ...expected } of golden.samples) {
      expect(records[index], `sample at index ${index}`).toEqual(expected);
    }
  });

  it('keeps Sol first and the sky magnitude-sorted', () => {
    expect(records[0].name).toBe('Sol');
    for (let i = 2; i < records.length; i++) {
      expect(records[i].magnitude).toBeGreaterThanOrEqual(records[i - 1].magnitude);
    }
  });
});

describe('parseBrightStarBin rejections', () => {
  function validBin(): ArrayBuffer {
    // Tiny hand-built catalog: 1 star, 1 name.
    const buf = new ArrayBuffer(12 + 12 + 3 + 3);
    const view = new DataView(buf);
    new Uint8Array(buf).set(new TextEncoder().encode('MSTR'), 0);
    view.setUint16(4, 1, true);
    view.setUint16(6, 1, true);
    view.setUint32(8, 1, true);
    view.setInt32(12, 1012872, true);
    view.setInt32(16, -167161, true);
    view.setInt16(20, -144, true);
    view.setInt16(22, 1, true);
    view.setUint16(24, 0, true);
    view.setUint8(26, 3);
    new Uint8Array(buf).set(new TextEncoder().encode('Sir'), 27);
    return buf;
  }

  it('parses the hand-built catalog (fixture sanity)', () => {
    expect(parseBrightStarBin(validBin())).toEqual([
      { raDeg: 101.2872, decDeg: -16.7161, magnitude: -1.44, colorIndex: 0.01, name: 'Sir' },
    ]);
  });

  it('rejects a bad magic', () => {
    const buf = validBin();
    new Uint8Array(buf)[0] = 0x58;
    expect(() => parseBrightStarBin(buf)).toThrow(/bad magic/);
  });

  it('rejects a future version', () => {
    const buf = validBin();
    new DataView(buf).setUint16(4, 2, true);
    expect(() => parseBrightStarBin(buf)).toThrow(/unsupported version/);
  });

  it('rejects truncation anywhere', () => {
    const whole = validBin();
    for (const cut of [4, 12, 20, 25, whole.byteLength - 1]) {
      expect(() => parseBrightStarBin(whole.slice(0, cut)), `cut at ${cut}`).toThrow();
    }
  });

  it('rejects trailing garbage', () => {
    const whole = new Uint8Array(validBin());
    const padded = new Uint8Array(whole.length + 1);
    padded.set(whole, 0);
    expect(() => parseBrightStarBin(padded.buffer)).toThrow(/trailing/);
  });
});
