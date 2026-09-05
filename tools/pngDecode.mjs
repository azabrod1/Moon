// An 8-bit PNG decoder, so a capture tool can read its own output without a
// browser. There is no native image library installed here, and launching
// headless Chromium to call drawImage costs a GPU process and contends with
// whatever else is measuring — for two screenshots that is the whole job.
//
// Handles what Playwright's screenshots and this repo's goldens are: 8 bits per
// channel, colour type 2 (RGB) or 6 (RGBA), no interlace. Anything else throws
// rather than returning plausible garbage.
import { inflateSync } from 'node:zlib';

/** Decode to `{ width, height, channels, pixels }`, pixels row-major and
 *  unfiltered. */
export function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 4;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error(`bit depth ${data[8]} unsupported`);
      const colorType = data[9];
      if (colorType === 6) channels = 4;
      else if (colorType === 2) channels = 3;
      else throw new Error(`colour type ${colorType} unsupported`);
      if (data[12] !== 0) throw new Error('interlaced PNG unsupported');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const row = y * stride;
    const prior = row - stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[src++];
      const a = x >= channels ? out[row + x - channels] : 0;
      const b = y > 0 ? out[prior + x] : 0;
      const c = x >= channels && y > 0 ? out[prior + x - channels] : 0;
      let recon;
      if (filter === 0) recon = value;
      else if (filter === 1) recon = value + a;
      else if (filter === 2) recon = value + b;
      else if (filter === 3) recon = value + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        recon = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error(`filter ${filter} unknown`);
      out[row + x] = recon & 0xff;
    }
  }
  return { width, height, channels, pixels: out };
}
