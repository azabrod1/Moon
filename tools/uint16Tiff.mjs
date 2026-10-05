// A minimal reader for an uncompressed 16-bit grayscale TIFF — enough for the
// LOLA elevation grids (NASA SVS CGI Moon Kit, ldem_16_uint.tif at 5760x2880
// and ldem_64_uint.tif at 23040x11520) and nothing more. Shared by
// gen-maps.mjs (the boot and close-approach relief, through a browser canvas)
// and tools/gen-moon-relief.mjs (the sector relief, in Node). Heights stay
// 16-bit here: the 8-bit canvas path would quantize the Moon's ~20 km of
// relief into ~78 m steps that show as terracing across the smooth maria.
export function readUint16Tiff(buf) {
  const order = buf.readUInt16LE(0);
  if (order !== 0x4949) throw new Error('expected a little-endian ("II") TIFF');
  if (buf.readUInt16LE(2) !== 42) throw new Error('not a TIFF (bad magic)');
  const TYPE_SIZE = { 1: 1, 3: 2, 4: 4 }; // BYTE / SHORT / LONG — the rest is skipped
  const entries = new Map();
  const ifd = buf.readUInt32LE(4);
  const count = buf.readUInt16LE(ifd);
  for (let i = 0; i < count; i++) {
    const at = ifd + 2 + i * 12;
    const tag = buf.readUInt16LE(at), type = buf.readUInt16LE(at + 2), n = buf.readUInt32LE(at + 4);
    const size = TYPE_SIZE[type] || 0;
    if (!size) continue; // ascii/rational tags carry nothing this reader needs
    const base = n * size > 4 ? buf.readUInt32LE(at + 8) : at + 8;
    const vals = [];
    for (let k = 0; k < n; k++) {
      const o = base + k * size;
      vals.push(type === 1 ? buf.readUInt8(o) : type === 3 ? buf.readUInt16LE(o) : buf.readUInt32LE(o));
    }
    entries.set(tag, vals);
  }
  const one = (tag, def) => (entries.has(tag) ? entries.get(tag)[0] : def);
  const width = one(256), height = one(257);
  const bits = one(258, 8), samples = one(277, 1), compression = one(259, 1);
  if (width === undefined || height === undefined) throw new Error('TIFF is missing image dimensions');
  if (bits !== 16 || samples !== 1) throw new Error(`expected 16-bit single-sample data, got ${bits}-bit x${samples}`);
  if (compression !== 1) throw new Error(`expected uncompressed data, got compression ${compression}`);
  const offsets = entries.get(273), counts = entries.get(279);
  if (!offsets || !counts) throw new Error('TIFF is missing strip offsets/byte counts');
  const rowsPerStrip = one(278, height);
  const out = new Uint16Array(width * height);
  let row = 0;
  for (let s = 0; s < offsets.length; s++) {
    const rows = Math.min(rowsPerStrip, height - row);
    const need = rows * width * 2;
    if (counts[s] < need) throw new Error(`strip ${s} is short: ${counts[s]} < ${need} bytes`);
    for (let i = 0; i < rows * width; i++) out[row * width + i] = buf.readUInt16LE(offsets[s] + i * 2);
    row += rows;
  }
  if (row !== height) throw new Error(`strips cover ${row} of ${height} rows`);
  return { width, height, data: out };
}
