import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain .mjs module without types
import { buildTrueType, glyphRectangles, parseBdf, readTables, sfntChecksum, wrapWoff } from './pixelFont.mjs';

// A tiny BDF in the X.Org layout: a space, an "L" and a "T", 4 px wide, ascent 5, descent 1.
const BDF = `STARTFONT 2.1
FONT -Test-Tiny-Bold-R-Normal--6-60-75-75-P-40-ISO10646-1
SIZE 6 75 75
FONTBOUNDINGBOX 4 6 0 -1
COMMENT +
COMMENT  Copyright 2026 Test Foundry.
COMMENT -
STARTPROPERTIES 4
FAMILY_NAME "Tiny"
WEIGHT_NAME "Bold"
PIXEL_SIZE 6
FONT_ASCENT 5
FONT_DESCENT 1
ENDPROPERTIES
CHARS 3
STARTCHAR space
ENCODING 32
DWIDTH 3 0
BBX 1 1 0 0
BITMAP
00
ENDCHAR
STARTCHAR L
ENCODING 76
DWIDTH 4 0
BBX 3 5 0 0
BITMAP
80
80
80
80
E0
ENDCHAR
STARTCHAR T
ENCODING 84
DWIDTH 4 0
BBX 3 5 0 0
BITMAP
E0
40
40
40
40
ENDCHAR
ENDFONT
`;

describe('the pixel font builder', () => {
  const font = parseBdf(BDF);
  const ttf = buildTrueType(font, { familyName: 'Tiny', styleName: 'Bold', bold: true, monospace: false, keep: () => true });
  const tables = readTables(ttf);

  it('reads the BDF and joins each glyph\'s pixels into non-overlapping rectangles', () => {
    expect([font.pixelSize, font.ascent, font.descent]).toEqual([6, 5, 1]);
    expect(font.copyright).toEqual(['Copyright 2026 Test Foundry.']);
    expect(glyphRectangles(font.glyphs.get(76))).toEqual([[0, 1, 1, 5], [0, 0, 3, 1]]);
    expect(glyphRectangles(font.glyphs.get(84))).toEqual([[0, 4, 3, 5], [1, 0, 2, 4]]);
  });

  it('writes the ten tables a browser requires, with true checksums', () => {
    expect(Object.keys(tables).sort()).toEqual(['OS/2', 'cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post']);
    for (const [tag, entry] of Object.entries(tables) as [string, { checksum: number; offset: number; length: number }][]) {
      const data = ttf.slice(entry.offset, entry.offset + entry.length);
      if (tag === 'head') new DataView(data.buffer).setUint32(8, 0);
      expect(sfntChecksum(data), tag).toBe(entry.checksum);
    }
    expect(sfntChecksum(ttf)).toBe(0xb1b0afba);
  });

  it('wraps the same tables in WOFF, each inflating back to the original', () => {
    const woff = wrapWoff(ttf);
    const view = new DataView(woff.buffer, woff.byteOffset, woff.byteLength);
    expect(String.fromCharCode(...woff.slice(0, 4))).toBe('wOFF');
    for (let index = 0; index < view.getUint16(12); index++) {
      const at = 44 + index * 20;
      const tag = String.fromCharCode(...woff.slice(at, at + 4));
      const [offset, compressed, original] = [view.getUint32(at + 4), view.getUint32(at + 8), view.getUint32(at + 12)];
      const stored = woff.slice(offset, offset + compressed);
      const data = compressed < original ? inflateSync(stored) : stored;
      const entry = tables[tag];
      expect(Buffer.from(data).equals(Buffer.from(ttf.slice(entry.offset, entry.offset + entry.length))), tag).toBe(true);
    }
  });
});
