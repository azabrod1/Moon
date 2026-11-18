// Bitmap fonts as web fonts made of square pixels: the Retro look's type.
//
// The Retro look sets its interface in real bitmap fonts of the period (the
// X11 distribution's Helvetica-style bitmaps and its fixed 5×7), at a whole
// number of device pixels per font pixel, so they draw as hard pixels. A
// browser only takes outline fonts, so each lit pixel becomes a square of the
// outline: runs of pixels in a row are joined, and runs that repeat on the
// next row are joined downwards, so a glyph is a handful of rectangles. With
// font-size = the font's pixel size × the interface's pixel, every square
// lands exactly on the device pixel grid and the rasteriser has no edge to
// smooth.
//
// Pure functions, no dependencies (tools/gen-pixel-fonts.mjs fetches the
// sources and writes the files; tools/pixelFont.test.ts drives these):
//   parseBdf(text)            the font, from BDF source
//   glyphRectangles(glyph)    the squares, joined into rectangles
//   buildTrueType(font, opts) a TrueType file: glyf outlines, cmap 4, the lot
//   wrapWoff(ttf)             the same in WOFF 1.0, zlib per table
//
// Units: UNITS_PER_PIXEL to a font pixel, and unitsPerEm = the font's pixel
// size × that, so CSS `font-size: calc(<pixel size> * var(--ui-px))` makes one
// font pixel one interface pixel. Line metrics are the BDF's FONT_ASCENT and
// FONT_DESCENT, so the line box is a whole number of font pixels.
import { deflateSync } from 'node:zlib';

export const UNITS_PER_PIXEL = 64;

/** The BDF as data: pixel size, line metrics, the copyright comment block and
 *  every glyph by code point. */
export function parseBdf(text) {
  const lines = text.split(/\r?\n/);
  const font = { pixelSize: 0, ascent: 0, descent: 0, copyright: [], glyphs: new Map(), family: '', weight: '' };
  let inCopyright = false;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const [keyword, ...rest] = line.split(' ');
    if (keyword === 'COMMENT') {
      const comment = line.slice('COMMENT'.length).replace(/^ /, '');
      if (comment.trim() === '+') inCopyright = true;
      else if (comment.trim() === '-') inCopyright = false;
      else if (inCopyright) font.copyright.push(comment.replace(/^ /, ''));
    } else if (keyword === 'PIXEL_SIZE') font.pixelSize = Number(rest[0]);
    else if (keyword === 'FONT_ASCENT') font.ascent = Number(rest[0]);
    else if (keyword === 'FONT_DESCENT') font.descent = Number(rest[0]);
    else if (keyword === 'FAMILY_NAME') font.family = rest.join(' ').replace(/"/g, '');
    else if (keyword === 'WEIGHT_NAME') font.weight = rest.join(' ').replace(/"/g, '');
    else if (keyword === 'STARTCHAR') {
      const glyph = { code: -1, advance: 0, width: 0, height: 0, xOffset: 0, yOffset: 0, rows: [] };
      index++;
      while (index < lines.length && lines[index] !== 'ENDCHAR') {
        const [glyphKeyword, ...values] = lines[index].split(' ');
        if (glyphKeyword === 'ENCODING') glyph.code = Number(values[0]);
        else if (glyphKeyword === 'DWIDTH') glyph.advance = Number(values[0]);
        else if (glyphKeyword === 'BBX') [glyph.width, glyph.height, glyph.xOffset, glyph.yOffset] = values.map(Number);
        else if (glyphKeyword === 'BITMAP') {
          for (let row = 0; row < glyph.height; row++) {
            const hex = lines[++index].trim();
            const bits = [];
            for (let column = 0; column < glyph.width; column++) {
              const nibble = parseInt(hex[column >> 2], 16);
              bits.push((nibble >> (3 - (column & 3))) & 1);
            }
            glyph.rows.push(bits);
          }
        }
        index++;
      }
      if (glyph.code >= 0) font.glyphs.set(glyph.code, glyph);
    }
    index++;
  }
  if (!font.pixelSize) throw new Error('BDF: no PIXEL_SIZE');
  return font;
}

/**
 * The glyph's lit pixels as rectangles in font pixels, y up from the baseline:
 * [x0, y0, x1, y1], x1 and y1 exclusive. Runs in a row are joined; a run with
 * the same span on the next row down extends the rectangle above it. The
 * rectangles never overlap.
 */
export function glyphRectangles(glyph) {
  const done = [];
  let open = new Map();
  for (let row = 0; row < glyph.height; row++) {
    const top = glyph.yOffset + glyph.height - row;
    const bits = glyph.rows[row];
    const runs = [];
    for (let column = 0; column < glyph.width; column++) {
      if (!bits[column]) continue;
      const start = column;
      while (column < glyph.width && bits[column]) column++;
      runs.push([start, column]);
    }
    const next = new Map();
    for (const [start, end] of runs) {
      const key = `${start},${end}`;
      const rectangle = open.get(key) ?? [glyph.xOffset + start, top - 1, glyph.xOffset + end, top];
      rectangle[1] = top - 1;
      open.delete(key);
      next.set(key, rectangle);
    }
    for (const rectangle of open.values()) done.push(rectangle);
    open = next;
  }
  for (const rectangle of open.values()) done.push(rectangle);
  return done.sort((a, b) => b[3] - a[3] || a[0] - b[0]);
}

// ---------------------------------------------------------------- bytes
class Writer {
  constructor() { this.bytes = []; }
  u8(value) { this.bytes.push(value & 0xff); return this; }
  u16(value) { return this.u8(value >> 8).u8(value); }
  i16(value) { return this.u16(value < 0 ? value + 0x10000 : value); }
  u32(value) { return this.u16(Math.floor(value / 0x10000) & 0xffff).u16(value & 0xffff); }
  tag(text) { for (const character of text) this.u8(character.charCodeAt(0)); return this; }
  raw(bytes) { for (const byte of bytes) this.bytes.push(byte); return this; }
  pad4() { while (this.bytes.length % 4) this.bytes.push(0); return this; }
  get length() { return this.bytes.length; }
  out() { return Uint8Array.from(this.bytes); }
}

function checksum(bytes) {
  let sum = 0;
  for (let offset = 0; offset < bytes.length; offset += 4) {
    const word = ((bytes[offset] ?? 0) << 24 >>> 0) + ((bytes[offset + 1] ?? 0) << 16) + ((bytes[offset + 2] ?? 0) << 8) + (bytes[offset + 3] ?? 0);
    sum = (sum + word) >>> 0;
  }
  return sum;
}

function binarySearchFields(count, unit) {
  let power = 1;
  let exponent = 0;
  while (power * 2 <= count) { power *= 2; exponent++; }
  return { searchRange: power * unit, entrySelector: exponent, rangeShift: count * unit - power * unit };
}

/** One glyph's glyf record and its bounds, from rectangles in font pixels. */
function glyfRecord(rectangles) {
  if (rectangles.length === 0) return { bytes: new Uint8Array(0), bounds: null, points: 0, contours: 0 };
  const scale = UNITS_PER_PIXEL;
  const points = [];
  for (const [x0, y0, x1, y1] of rectangles) {
    // Clockwise with y up: the TrueType direction for a filled contour.
    points.push([x0 * scale, y0 * scale], [x0 * scale, y1 * scale], [x1 * scale, y1 * scale], [x1 * scale, y0 * scale]);
  }
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const writer = new Writer();
  writer.i16(rectangles.length).i16(bounds[0]).i16(bounds[1]).i16(bounds[2]).i16(bounds[3]);
  for (let contour = 0; contour < rectangles.length; contour++) writer.u16(contour * 4 + 3);
  writer.u16(0); // no instructions
  const flags = [];
  const xBytes = new Writer();
  const yBytes = new Writer();
  let previousX = 0;
  let previousY = 0;
  for (const [x, y] of points) {
    let flag = 0x01; // on the curve
    const deltaX = x - previousX;
    const deltaY = y - previousY;
    if (deltaX === 0) flag |= 0x10;
    else if (Math.abs(deltaX) <= 255) { flag |= 0x02 | (deltaX > 0 ? 0x10 : 0); xBytes.u8(Math.abs(deltaX)); }
    else xBytes.i16(deltaX);
    if (deltaY === 0) flag |= 0x20;
    else if (Math.abs(deltaY) <= 255) { flag |= 0x04 | (deltaY > 0 ? 0x20 : 0); yBytes.u8(Math.abs(deltaY)); }
    else yBytes.i16(deltaY);
    flags.push(flag);
    previousX = x;
    previousY = y;
  }
  writer.raw(flags).raw(xBytes.bytes).raw(yBytes.bytes);
  while (writer.length % 4) writer.u8(0);
  return { bytes: writer.out(), bounds, points: points.length, contours: rectangles.length };
}

function nameTable(names) {
  // Windows, Unicode BMP, US English, in UTF-16BE: what every browser reads.
  const ids = Object.keys(names).map(Number).sort((a, b) => a - b);
  const strings = ids.map((id) => {
    const writer = new Writer();
    for (const character of names[id]) writer.u16(character.charCodeAt(0));
    return writer.bytes;
  });
  const writer = new Writer();
  writer.u16(0).u16(ids.length).u16(6 + ids.length * 12);
  let offset = 0;
  ids.forEach((id, index) => {
    writer.u16(3).u16(1).u16(0x409).u16(id).u16(strings[index].length).u16(offset);
    offset += strings[index].length;
  });
  for (const string of strings) writer.raw(string);
  return writer.out();
}

function cmapTable(codeToGlyph) {
  const codes = [...codeToGlyph.keys()].filter((code) => code <= 0xfffe).sort((a, b) => a - b);
  const segments = [];
  for (const code of codes) {
    const glyph = codeToGlyph.get(code);
    const last = segments[segments.length - 1];
    if (last && code === last.end + 1 && glyph === last.glyph + (code - last.start)) last.end = code;
    else segments.push({ start: code, end: code, glyph });
  }
  segments.push({ start: 0xffff, end: 0xffff, glyph: 0, final: true });
  const segmentCount = segments.length;
  const { searchRange, entrySelector, rangeShift } = binarySearchFields(segmentCount, 2);
  const sub = new Writer();
  const length = 16 + segmentCount * 8;
  sub.u16(4).u16(length).u16(0).u16(segmentCount * 2).u16(searchRange).u16(entrySelector).u16(rangeShift);
  for (const segment of segments) sub.u16(segment.end);
  sub.u16(0);
  for (const segment of segments) sub.u16(segment.start);
  for (const segment of segments) sub.u16(segment.final ? 1 : (segment.glyph - segment.start + 0x10000) & 0xffff);
  for (let index = 0; index < segmentCount; index++) sub.u16(0);
  const writer = new Writer();
  // Two encoding records, Unicode (0, 3) and Windows BMP (3, 1), sharing one subtable.
  writer.u16(0).u16(2).u16(0).u16(3).u32(20).u16(3).u16(1).u32(20).raw(sub.bytes);
  return writer.out();
}

/**
 * A TrueType file for `font` (parseBdf), keeping the code points `keep`
 * accepts. `familyName` and `styleName` name it; `bold` sets the weight
 * fields; `monospace` the post table's flag.
 */
export function buildTrueType(font, { familyName, styleName, bold, monospace, keep, version = '1.0' }) {
  const scale = UNITS_PER_PIXEL;
  const codes = [...font.glyphs.keys()].filter(keep).sort((a, b) => a - b);
  if (!codes.includes(32)) throw new Error('font has no space');
  // Glyph 0, .notdef: an empty box the width of a digit.
  const zero = font.glyphs.get(48) ?? font.glyphs.get(32);
  const boxWidth = Math.max(2, zero.advance - 1);
  const boxHeight = Math.max(2, font.ascent - 1);
  const notdefRectangles = [[0, 0, boxWidth, 1], [0, boxHeight - 1, boxWidth, boxHeight], [0, 1, 1, boxHeight - 1], [boxWidth - 1, 1, boxWidth, boxHeight - 1]];
  const glyphList = [{ code: -1, advance: zero.advance, rectangles: notdefRectangles }];
  for (const code of codes) glyphList.push({ code, advance: font.glyphs.get(code).advance, rectangles: glyphRectangles(font.glyphs.get(code)) });
  const records = glyphList.map((glyph) => glyfRecord(glyph.rectangles));

  const glyf = new Writer();
  const loca = new Writer();
  for (const record of records) { loca.u32(glyf.length); glyf.raw(record.bytes); }
  loca.u32(glyf.length);

  const codeToGlyph = new Map(codes.map((code, index) => [code, index + 1]));
  const advances = glyphList.map((glyph) => glyph.advance * scale);
  const boundsList = records.map((record) => record.bounds);
  const drawn = boundsList.filter(Boolean);
  const xMin = Math.min(...drawn.map((b) => b[0]));
  const yMin = Math.min(...drawn.map((b) => b[1]));
  const xMax = Math.max(...drawn.map((b) => b[2]));
  const yMax = Math.max(...drawn.map((b) => b[3]));
  const ascender = font.ascent * scale;
  const descender = -font.descent * scale;
  const unitsPerEm = font.pixelSize * scale;

  const head = new Writer();
  head.u32(0x00010000).u32(0x00010000).u32(0).u32(0x5f0f3cf5).u16(0x0009).u16(unitsPerEm)
    // Fixed dates (early 2026), so the same sources make the same bytes.
    .u32(0).u32(0xe5a0e000).u32(0).u32(0xe5a0e000)
    .i16(xMin).i16(yMin).i16(xMax).i16(yMax).u16(bold ? 1 : 0).u16(6).i16(2).i16(1).i16(0);

  const lefts = records.map((record) => (record.bounds ? record.bounds[0] : 0));
  const rights = records.map((record, index) => (record.bounds ? advances[index] - record.bounds[2] : 0));
  const extents = records.map((record) => (record.bounds ? record.bounds[2] : 0));
  const hhea = new Writer();
  hhea.u32(0x00010000).i16(ascender).i16(descender).i16(0).u16(Math.max(...advances))
    .i16(Math.min(...lefts)).i16(Math.min(...rights)).i16(Math.max(...extents))
    .i16(1).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).u16(glyphList.length);

  const hmtx = new Writer();
  glyphList.forEach((glyph, index) => hmtx.u16(advances[index]).i16(lefts[index]));

  const maxp = new Writer();
  maxp.u32(0x00010000).u16(glyphList.length)
    .u16(Math.max(...records.map((record) => record.points))).u16(Math.max(...records.map((record) => record.contours)))
    .u16(0).u16(0).u16(2).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0);

  const visible = codes.filter((code) => code > 32 && code < 127);
  const averageWidth = Math.round(visible.reduce((sum, code) => sum + font.glyphs.get(code).advance, 0) / Math.max(1, visible.length) * scale);
  const capHeight = (font.glyphs.get(72)?.height ?? font.ascent) * scale;
  const xHeight = (font.glyphs.get(120)?.height ?? Math.round(font.ascent * 0.7)) * scale;
  const os2 = new Writer();
  os2.u16(4).i16(averageWidth).u16(bold ? 700 : 400).u16(5).u16(0)
    .i16(Math.round(unitsPerEm * 0.65)).i16(Math.round(unitsPerEm * 0.6)).i16(0).i16(Math.round(unitsPerEm * 0.075))
    .i16(Math.round(unitsPerEm * 0.65)).i16(Math.round(unitsPerEm * 0.6)).i16(0).i16(Math.round(unitsPerEm * 0.35))
    .i16(scale).i16(Math.round(xHeight / 2)).i16(0)
    .raw([2, 11, bold ? 8 : 6, 0, 0, 0, 0, 0, 0, 0])
    .u32(0x00000003).u32(0).u32(0).u32(0) // Basic Latin, Latin-1 Supplement
    .tag('XORG')
    .u16((bold ? 0x20 : 0x40) | 0x80) // bold or regular; use the typo metrics
    .u16(Math.min(...codes)).u16(Math.min(0xffff, Math.max(...codes)))
    .i16(ascender).i16(descender).i16(0).u16(ascender).u16(-descender)
    .u32(0x00000001).u32(0) // Latin 1
    .i16(xHeight).i16(capHeight).u16(0).u16(32).u16(1);

  const post = new Writer();
  post.u32(0x00030000).u32(0).i16(-scale).i16(scale).u32(monospace ? 1 : 0).u32(0).u32(0).u32(0).u32(0);

  const postScript = `${familyName}-${styleName}`.replace(/[^A-Za-z0-9-]/g, '');
  const name = nameTable({
    0: font.copyright.join(' ').replace(/\s+/g, ' ').trim(),
    1: familyName,
    2: styleName,
    3: `${postScript};${version}`,
    4: `${familyName} ${styleName}`,
    5: `Version ${version}`,
    6: postScript,
  });

  const tables = {
    'OS/2': os2.out(), cmap: cmapTable(codeToGlyph), glyf: glyf.out(), head: head.out(), hhea: hhea.out(),
    hmtx: hmtx.out(), loca: loca.out(), maxp: maxp.out(), name, post: post.out(),
  };
  return assembleSfnt(tables);
}

function assembleSfnt(tables) {
  const tags = Object.keys(tables).sort();
  const { searchRange, entrySelector, rangeShift } = binarySearchFields(tags.length, 16);
  const header = new Writer();
  header.u32(0x00010000).u16(tags.length).u16(searchRange).u16(entrySelector).u16(rangeShift);
  let offset = 12 + tags.length * 16;
  const body = new Writer();
  const entries = [];
  for (const tag of tags) {
    const data = tables[tag];
    entries.push({ tag, checksum: checksum(data), offset, length: data.length });
    body.raw(data).pad4();
    offset = 12 + tags.length * 16 + body.length;
  }
  for (const entry of entries) header.tag(entry.tag).u32(entry.checksum).u32(entry.offset).u32(entry.length);
  const font = new Uint8Array(header.length + body.length);
  font.set(header.out(), 0);
  font.set(body.out(), header.length);
  // head.checkSumAdjustment: the whole file's sum is 0xB1B0AFBA.
  const headEntry = entries.find((entry) => entry.tag === 'head');
  const adjustment = (0xb1b0afba - checksum(font)) >>> 0;
  new DataView(font.buffer).setUint32(headEntry.offset + 8, adjustment);
  return font;
}

/** The sfnt's tables, read back: tag → bytes. For the WOFF wrapper and the tests. */
export function readTables(font) {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const count = view.getUint16(4);
  const tables = {};
  for (let index = 0; index < count; index++) {
    const at = 12 + index * 16;
    const tag = String.fromCharCode(font[at], font[at + 1], font[at + 2], font[at + 3]);
    tables[tag] = { checksum: view.getUint32(at + 4), offset: view.getUint32(at + 8), length: view.getUint32(at + 12) };
  }
  return tables;
}

export { checksum as sfntChecksum };

/** WOFF 1.0: the same tables, each zlib-compressed where that is smaller. */
export function wrapWoff(font) {
  const tables = readTables(font);
  const tags = Object.keys(tables).sort();
  const directory = new Writer();
  const data = new Writer();
  const headerSize = 44 + tags.length * 20;
  let totalSfntSize = 12 + tags.length * 16;
  for (const tag of tags) {
    const { checksum: tableChecksum, offset, length } = tables[tag];
    const original = font.subarray(offset, offset + length);
    const compressed = deflateSync(original, { level: 9 });
    const stored = compressed.length < original.length ? compressed : original;
    directory.tag(tag).u32(headerSize + data.length).u32(stored.length).u32(length).u32(tableChecksum);
    data.raw(stored).pad4();
    totalSfntSize += (length + 3) & ~3;
  }
  const header = new Writer();
  header.tag('wOFF').u32(0x00010000).u32(headerSize + data.length).u16(tags.length).u16(0)
    .u32(totalSfntSize).u16(1).u16(0).u32(0).u32(0).u32(0).u32(0).u32(0);
  return Uint8Array.from([...header.bytes, ...directory.bytes, ...data.bytes]);
}
