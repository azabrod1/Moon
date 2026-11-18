import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain .mjs module without types
import { UNITS_PER_PIXEL, buildTrueType, glyphRectangles, parseBdf, readTables, sfntChecksum, wrapWoff } from './pixelFont.mjs';
// @ts-expect-error -- a plain .mjs module without types
import { RETRO_FONTS, keepCode } from './gen-pixel-fonts.mjs';

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

describe('parseBdf', () => {
  const font = parseBdf(BDF);
  it('reads the metrics, the copyright block and every glyph', () => {
    expect([font.pixelSize, font.ascent, font.descent]).toEqual([6, 5, 1]);
    expect(font.copyright).toEqual(['Copyright 2026 Test Foundry.']);
    expect([...font.glyphs.keys()]).toEqual([32, 76, 84]);
    expect(font.glyphs.get(76).rows).toEqual([[1, 0, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0], [1, 1, 1]]);
  });
});

describe('glyphRectangles', () => {
  const font = parseBdf(BDF);
  it('joins runs across a row and down repeated rows, without overlap', () => {
    // L: the stem (4 rows of one pixel) and the foot (one row of three).
    expect(glyphRectangles(font.glyphs.get(76))).toEqual([[0, 1, 1, 5], [0, 0, 3, 1]]);
    // T: the bar and the stem under it.
    expect(glyphRectangles(font.glyphs.get(84))).toEqual([[0, 4, 3, 5], [1, 0, 2, 4]]);
    expect(glyphRectangles(font.glyphs.get(32))).toEqual([]);
  });

  it('covers exactly the lit pixels of every glyph in a real font', () => {
    const real = parseBdf(readFileSync(new URL('./pixelFont.fixture.bdf', import.meta.url), 'latin1'));
    for (const glyph of real.glyphs.values()) {
      const lit = new Set<string>();
      glyph.rows.forEach((row: number[], rowIndex: number) => row.forEach((bit, column) => {
        if (bit) lit.add(`${glyph.xOffset + column},${glyph.yOffset + glyph.height - rowIndex - 1}`);
      }));
      const covered = new Set<string>();
      for (const [x0, y0, x1, y1] of glyphRectangles(glyph)) {
        for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) {
          const key = `${x},${y}`;
          expect(covered.has(key), `overlap in ${glyph.code}`).toBe(false);
          covered.add(key);
        }
      }
      expect([...covered].sort()).toEqual([...lit].sort());
    }
  });
});

describe('buildTrueType and wrapWoff', () => {
  const font = parseBdf(BDF);
  const ttf = buildTrueType(font, { familyName: 'Tiny', styleName: 'Bold', bold: true, monospace: false, keep: () => true });
  const tables = readTables(ttf);
  const view = new DataView(ttf.buffer, ttf.byteOffset, ttf.byteLength);

  it('has the ten tables a browser requires, each with a true checksum', () => {
    expect(Object.keys(tables).sort()).toEqual(['OS/2', 'cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post']);
    for (const [tag, entry] of Object.entries(tables) as [string, { checksum: number; offset: number; length: number }][]) {
      const data = ttf.slice(entry.offset, entry.offset + entry.length);
      if (tag === 'head') new DataView(data.buffer).setUint32(8, 0);
      expect(sfntChecksum(data), tag).toBe(entry.checksum);
      expect(entry.offset % 4, tag).toBe(0);
    }
    // The whole file sums to the magic number through head.checkSumAdjustment.
    expect(sfntChecksum(ttf)).toBe(0xb1b0afba);
  });

  it('makes a font pixel UNITS_PER_PIXEL units, with the em the pixel size and the line the BDF metrics', () => {
    const head = tables.head.offset;
    expect(view.getUint16(head + 18)).toBe(6 * UNITS_PER_PIXEL);
    const hhea = tables.hhea.offset;
    expect(view.getInt16(hhea + 4)).toBe(5 * UNITS_PER_PIXEL);
    expect(view.getInt16(hhea + 6)).toBe(-1 * UNITS_PER_PIXEL);
    // .notdef and three glyphs, each advance the BDF's DWIDTH in units. .notdef
    // is as wide as the digit 0, or the space where a font has no 0 (this one).
    const hmtx = tables.hmtx.offset;
    expect([0, 1, 2, 3].map((index) => view.getUint16(hmtx + index * 4))).toEqual([3, 3, 4, 4].map((pixels) => pixels * UNITS_PER_PIXEL));
  });

  it('maps every kept code point through cmap format 4 to its glyph', () => {
    const cmap = tables.cmap.offset;
    const sub = cmap + view.getUint32(cmap + 8);
    expect(view.getUint16(sub)).toBe(4);
    const segments = view.getUint16(sub + 6) / 2;
    const ends = sub + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const lookup = (code: number) => {
      for (let index = 0; index < segments; index++) {
        if (code <= view.getUint16(ends + index * 2)) {
          if (code < view.getUint16(starts + index * 2)) return 0;
          return (code + view.getUint16(deltas + index * 2)) & 0xffff;
        }
      }
      return 0;
    };
    expect([lookup(32), lookup(76), lookup(84), lookup(65)]).toEqual([1, 2, 3, 0]);
  });

  it('wraps the same tables in WOFF 1.0, each one inflating back to the original', () => {
    const woff = wrapWoff(ttf);
    const woffView = new DataView(woff.buffer, woff.byteOffset, woff.byteLength);
    expect(String.fromCharCode(...woff.slice(0, 4))).toBe('wOFF');
    expect(woffView.getUint32(8)).toBe(woff.length);
    const count = woffView.getUint16(12);
    expect(count).toBe(10);
    for (let index = 0; index < count; index++) {
      const at = 44 + index * 20;
      const tag = String.fromCharCode(...woff.slice(at, at + 4));
      const offset = woffView.getUint32(at + 4);
      const compressed = woffView.getUint32(at + 8);
      const original = woffView.getUint32(at + 12);
      const stored = woff.slice(offset, offset + compressed);
      const data = compressed < original ? inflateSync(stored) : stored;
      const entry = tables[tag];
      expect(Buffer.from(data).equals(Buffer.from(ttf.slice(entry.offset, entry.offset + entry.length))), tag).toBe(true);
    }
  });

  it('is the same bytes every time from the same source', () => {
    const again = buildTrueType(parseBdf(BDF), { familyName: 'Tiny', styleName: 'Bold', bold: true, monospace: false, keep: () => true });
    expect(Buffer.from(again).equals(Buffer.from(ttf))).toBe(true);
  });
});

describe('the Retro fonts', () => {
  it('ship every file the interface names, from the sources the generator reads', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    for (const spec of RETRO_FONTS) {
      expect(html, spec.file).toContain(`fonts/${spec.file}.woff`);
      expect(readFileSync(new URL(`../public/fonts/${spec.file}.woff`, import.meta.url)).subarray(0, 4).toString('latin1')).toBe('wOFF');
    }
    expect(readFileSync(new URL('../public/fonts/RETRO-FONTS.txt', import.meta.url), 'utf8')).toContain('Adobe Systems Incorporated');
  });

  it('keep Latin-1 and the punctuation the interface uses, and nothing past the BMP', () => {
    for (const character of 'Az09 ·×°–—…‹›’→−') expect(keepCode(character.codePointAt(0)), character).toBe(true);
    expect(keepCode(0x03c0)).toBe(false);
    expect(keepCode(0x1f600)).toBe(false);
  });
});
