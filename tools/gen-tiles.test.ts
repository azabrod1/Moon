import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// tools/gen-tiles.mjs builds every streamed surface level a body has, and a
// level is gigabytes nobody can check by eye. These pin the parts of the
// resample chain a level's bytes come from on rasters small enough to hold:
// a grey mosaic read one byte a texel has to come out as the first channel of
// the same mosaic read as RGB, cold or out of the cache, across a band
// boundary, the ±180° seam and the rows the product never measured; and a
// level derived from a mosaic level has to be the linear-light average of it.
//
// The tool needs sharp, which is not a dependency (`npm i --no-save
// sharp@0.35.4`, as its header says). Without it these are skipped, and say so.

let sharp: typeof import('sharp') | null = null;
try {
  sharp = (await import('sharp')).default;
} catch {
  sharp = null;
}

// The tool reads its cache root from its command line when it is imported, so
// the root is put there first: everything these write lands in a folder of
// their own.
const root = await mkdtemp(path.join(tmpdir(), 'gen-tiles-test-'));
process.argv.push(`--cache=${root}`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tool: any = sharp ? await import('./gen-tiles.mjs') : null;

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

// A small world with the shipped geometry's arithmetic: level 1 is 16x8
// sectors of 32 texels (512x256) resampled from a 720x360 source at 32/45, so
// one band of the level is 45 source rows and the halo is 45 source px; level 0
// is the octave below it (256x128).
const SW = 720;
const SH = 360;
const CONTENT = 32;
// Rows [20, 342) are the measured ground, as Mercury's 166 m mosaic holds its
// ground between 80 N and 81.25 S; the rows outside hold junk the product
// never measured, which must never reach a measured texel.
const VALID: [number, number] = [20, 342];

/** Ground: a smooth field of 1..255 plus a sharp stripe at the seam, so a
 *  resample that clamps instead of wrapping is visible there. Junk past the
 *  measured rows: alternating 0 and 255. */
function syntheticGrey(): Buffer {
  const g = Buffer.alloc(SW * SH);
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      let v: number;
      if (y < VALID[0] || y >= VALID[1]) v = (x + y) % 2 ? 255 : 0;
      else if (x < 3 || x >= SW - 3) v = 250;
      else v = 1 + Math.round(127 + 100 * Math.sin(x / 17) * Math.cos(y / 11) + 20 * Math.sin((x * y) / 97));
      g[y * SW + x] = y < VALID[0] || y >= VALID[1] ? v : Math.max(1, Math.min(255, v));
    }
  }
  return g;
}

const toRgb = (g: Buffer) => {
  const rgb = Buffer.alloc(g.length * 3);
  for (let i = 0; i < g.length; i++) rgb[3 * i] = rgb[3 * i + 1] = rgb[3 * i + 2] = g[i];
  return rgb;
};

function job(key: string, channels: 1 | 3, file: string, extra: Record<string, unknown> = {}) {
  return {
    key,
    content: CONTENT,
    rawToken: 'test.v1',
    levels: [
      { tier: 'l0', grid: { cols: 8, rows: 4 }, source: { kind: 'pyramid', of: 1 } },
      {
        tier: 'l1',
        grid: { cols: 16, rows: 8 },
        source: { kind: 'mosaic', channels, files: () => [file], across: 1, down: 1, validRows: () => VALID },
      },
    ],
    ...extra,
  };
}

/** The whole level resampled in ONE resize of the whole source — wrapped in
 *  longitude by a halo of the far edge, the rows past the measured band read
 *  as its edge row — which is what the band-by-band build promises to equal. */
async function wholeLevelOracle(g: Buffer, W: number, H: number): Promise<Buffer> {
  const q = 45;
  const p = 32;
  const rows = SH + 2 * q;
  const cols = SW + 2 * q;
  const padded = Buffer.alloc(cols * rows);
  for (let y = 0; y < rows; y++) {
    const sy = Math.max(VALID[0], Math.min(VALID[1] - 1, y - q));
    for (let x = 0; x < cols; x++) padded[y * cols + x] = g[sy * SW + (((x - q) % SW) + SW) % SW];
  }
  return sharp!(padded, { raw: { width: cols, height: rows, channels: 1 } })
    .resize(W + 2 * p, H + 2 * p, { fit: 'fill', kernel: 'lanczos3' })
    .extract({ left: p, top: p, width: W, height: H })
    .toColourspace('b-w').raw().toBuffer();
}

const firstChannel = (rgb: Buffer) => Buffer.from(Array.from({ length: rgb.length / 3 }, (_, i) => rgb[3 * i]));
const allGrey = (rgb: Buffer) => {
  for (let i = 0; i < rgb.length; i += 3) if (rgb[i] !== rgb[i + 1] || rgb[i] !== rgb[i + 2]) return false;
  return true;
};

describe.skipIf(!sharp)('gen-tiles: a grey mosaic level and the levels derived from it', () => {
  const grey = syntheticGrey();
  let greyTif = '';
  let rgbTif = '';

  beforeAll(async () => {
    greyTif = path.join(root, 'grey.tif');
    rgbTif = path.join(root, 'rgb.tif');
    await sharp!(grey, { raw: { width: SW, height: SH, channels: 1 } }).toColourspace('b-w').tiff({ compression: 'lzw' }).toFile(greyTif);
    await sharp!(toRgb(grey), { raw: { width: SW, height: SH, channels: 3 } }).tiff({ compression: 'lzw' }).toFile(rgbTif);
    // The TIFF round trip is the test's own premise: the file holds these
    // bytes, one band in the one and three equal bands in the other.
    const back = await sharp!(greyTif).metadata();
    expect(back.channels).toBe(1);
  });

  it('resamples one byte a texel to the first channel of its RGB twin, cold and from the cache', async () => {
    const g = job('grey', 1, greyTif);
    const c = job('rgb', 3, rgbTif);
    const greyFile = await tool.levelRawFile(g, 1);
    const rgbFile = await tool.levelRawFile(c, 1);
    // The cache names its layout, so a grey cache is never read as RGB.
    expect(greyFile.endsWith('.r8')).toBe(true);
    expect(rgbFile.endsWith('.rgb')).toBe(true);
    expect((await stat(path.join(root, 'raw', 'grey.tif.r8'))).size).toBe(SW * SH);
    const greyLevel = await readFile(greyFile);
    const rgbLevel = await readFile(rgbFile);
    expect(greyLevel.length).toBe(512 * 256);
    expect(rgbLevel.length).toBe(512 * 256 * 3);
    expect(allGrey(rgbLevel)).toBe(true);
    expect(greyLevel.equals(firstChannel(rgbLevel))).toBe(true);

    // Band by band equals the whole level in one resample: the band joins,
    // the ±180° seam (the stripe at the source's edge columns) and both edges
    // of the measured rows. Exact, because the halo puts every band on the
    // whole map's sample grid.
    expect(greyLevel.equals(await wholeLevelOracle(grey, 512, 256))).toBe(true);

    // Cached: the level's file is read back, not rebuilt.
    const before = (await stat(greyFile)).mtimeMs;
    expect(await tool.levelRawFile(g, 1)).toBe(greyFile);
    expect((await stat(greyFile)).mtimeMs).toBe(before);
    // Rebuilt from the cached decode alone: the same bytes as the cold run.
    await rm(greyFile);
    await tool.levelRawFile(g, 1);
    expect((await readFile(greyFile)).equals(greyLevel)).toBe(true);

    // And read through the row source the cutter uses, across a band
    // boundary and past both poles, where rows clamp to the edge.
    const rowsGrey = (await tool.levelRowSource(g, g.levels[1])).rows;
    const rowsRgb = (await tool.levelRowSource(c, c.levels[1])).rows;
    try {
      expect(rowsGrey.channels).toBe(1);
      for (const [y0, n] of [[-5, 12], [28, 8], [250, 12]]) {
        const a = await rowsGrey.read(y0, n);
        const b = await rowsRgb.read(y0, n);
        expect(a.length).toBe(512 * n);
        expect(a.equals(firstChannel(b))).toBe(true);
      }
    } finally {
      await rowsGrey.close();
      await rowsRgb.close();
    }
  });

  it('never lets an unmeasured row into a measured texel, and says which texels it reached', async () => {
    // The junk past the measured rows (alternating 0 and 255) replaced by
    // something else entirely must not move a single texel.
    const other = Buffer.from(grey);
    for (let y = 0; y < SH; y++) {
      if (y >= VALID[0] && y < VALID[1]) continue;
      for (let x = 0; x < SW; x++) other[y * SW + x] = 77;
    }
    const otherTif = path.join(root, 'other.tif');
    await sharp!(other, { raw: { width: SW, height: SH, channels: 1 } }).toColourspace('b-w').tiff({ compression: 'lzw' }).toFile(otherTif);
    const seen: { y0: number; rows: number; coverage: Buffer }[] = [];
    const fill = async (_band: Buffer, place: { y0: number; rows: number; coverage: Buffer }) => {
      seen.push({ y0: place.y0, rows: place.rows, coverage: Buffer.from(place.coverage) });
    };
    const a = await readFile(await tool.levelRawFile(job('junkA', 1, greyTif), 1));
    const b = await readFile(await tool.levelRawFile(job('junkB', 1, otherTif, { fill }), 1));
    expect(a.equals(b)).toBe(true);

    // One call per band, in order, with the coverage of every level row.
    expect(seen.map((s) => s.y0)).toEqual([0, 32, 64, 96, 128, 160, 192, 224]);
    const coverage = Buffer.concat(seen.map((s) => s.coverage));
    expect(coverage.length).toBe(256);
    // The measured band's edges in level rows (32/45 of the source's), and
    // the three level rows lanczos3 reaches at this scale: texels wholly
    // outside are 0, texels wholly inside 255, and only the rows between
    // lean on the repeated edge.
    const north = (VALID[0] * 32) / 45;
    const south = (VALID[1] * 32) / 45;
    for (let y = 0; y < 256; y++) {
      const c = y + 0.5;
      if (c < north - 3.5 || c > south + 3.5) expect(coverage[y]).toBe(0);
      if (c > north + 3.5 && c < south - 3.5) expect(coverage[y]).toBe(255);
    }
    expect(coverage.filter((v) => v > 0 && v < 255).length).toBeGreaterThan(0);
  });

  it('refuses a 0 inside the measured rows, the product\'s no-data value', async () => {
    const holed = Buffer.from(grey);
    holed[100 * SW + 300] = 0;
    const holedTif = path.join(root, 'holed.tif');
    await sharp!(holed, { raw: { width: SW, height: SH, channels: 1 } }).toColourspace('b-w').tiff({ compression: 'lzw' }).toFile(holedTif);
    await expect(tool.levelRawFile(job('holed', 1, holedTif), 1)).rejects.toThrow(/samples of 0 inside the measured rows/);
  });

  it('derives a level from a mosaic level by a linear-light average, grey and RGB alike', async () => {
    const g = job('grey', 1, greyTif);
    const c = job('rgb', 3, rgbTif);
    const greyFile = await tool.levelRawFile(g, 0);
    const rgbFile = await tool.levelRawFile(c, 0);
    expect(greyFile.endsWith('.r8')).toBe(true);
    const greyL0 = await readFile(greyFile);
    const rgbL0 = await readFile(rgbFile);
    expect(greyL0.length).toBe(256 * 128);
    expect(greyL0.equals(firstChannel(rgbL0))).toBe(true);

    // Against one linear-light resize of the whole parent, wrapped by a halo
    // of its far edge and clamped at the poles: the bands join exactly.
    const parent = await readFile(await tool.levelRawFile(g, 1));
    const halo = 32;
    const cols = 512 + 2 * halo;
    const rows = 256 + 2 * halo;
    const padded = Buffer.alloc(cols * rows);
    for (let y = 0; y < rows; y++) {
      const sy = Math.max(0, Math.min(255, y - halo));
      for (let x = 0; x < cols; x++) padded[y * cols + x] = parent[sy * 512 + (((x - halo) % 512) + 512) % 512];
    }
    const oracle = await sharp!(padded, { raw: { width: cols, height: rows, channels: 1 } })
      .pipelineColourspace('scrgb')
      .resize(256 + halo, 128 + halo, { fit: 'fill', kernel: 'lanczos3' })
      .toColourspace('srgb')
      .extract({ left: halo / 2, top: halo / 2, width: 256, height: 128 })
      .extractChannel(0).raw().toBuffer();
    expect(greyL0.equals(oracle)).toBe(true);

    // Its linear mean is the parent's: the reason the chain exists.
    const lin = (v: number) => { const u = v / 255; return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4; };
    const mean = (b: Buffer) => b.reduce((s, v) => s + lin(v), 0) / b.length;
    expect(Math.abs(mean(greyL0) / mean(parent) - 1)).toBeLessThan(0.002);
  });
});

describe.skipIf(!sharp)('gen-tiles: Mercury\'s levels are graded by gen-moonmaps\' own curve', () => {
  it('levelLut is the curve applyLevel puts on every count at the logged gain', async () => {
    const moonmaps = await import('./gen-moonmaps.mjs');
    const spec = moonmaps.JOBS.mercury.level;
    const gain = tool.MERCURY_LEVEL_GAIN;
    expect(gain).toBe(1.849244);
    // Every count on all three channels, levelled the way gen-moonmaps levels
    // a rung once its gain is solved.
    const data = Buffer.alloc(256 * 3);
    for (let v = 0; v < 256; v++) data[3 * v] = data[3 * v + 1] = data[3 * v + 2] = v;
    moonmaps.applyLevel({ data, width: 256, height: 1, channels: 3 }, null, spec, gain);
    const lut = moonmaps.levelLut(gain, spec);
    for (let v = 0; v < 256; v++) {
      expect(lut[v]).toBe(data[3 * v]);
      expect(tool.MERCURY_LEVEL_LUT[v]).toBe(data[3 * v]);
    }
    // The gain is logged to six decimals; anywhere in that rounding interval
    // the table is the same, so the logged number fixes the curve.
    const lo = moonmaps.levelLut(gain - 5e-7, spec);
    const hi = moonmaps.levelLut(gain + 5e-7, spec);
    expect(Buffer.from(lo).equals(Buffer.from(lut))).toBe(true);
    expect(Buffer.from(hi).equals(Buffer.from(lut))).toBe(true);
    // Mercury's spec has the shoulder: counts above the knee bend rather than
    // clip, and the table never turns back.
    expect(lut[150]).toBeLessThan(255);
    for (let v = 1; v < 256; v++) expect(lut[v]).toBeGreaterThanOrEqual(lut[v - 1]);
    expect(lut[100]).toBe(Math.round((100 / 255) * gain * 255));
  });
});

describe.skipIf(!sharp)('gen-tiles: polar caps filled once, from a filled reference', () => {
  // A filled reference at a quarter of level 1's width, as Mercury's 8K rung
  // is to its 64K level (there 127/16, here exactly 4): its own pattern
  // everywhere, so the cap rows can be told apart from the ground.
  const RW = 128;
  const RH = 64;
  const refGrey = Buffer.alloc(RW * RH);
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) refGrey[y * RW + x] = 40 + ((x * 7 + y * 13) % 170);
  // The test world's measured rows [20, 342) of 360 are 80 N to 81 S.
  const caps = { north: 80, south: -81 };
  let refPng = '';
  let greyTif = '';

  beforeAll(async () => {
    refPng = path.join(root, 'ref.png');
    greyTif = path.join(root, 'grey2.tif');
    await sharp!(toRgb(refGrey), { raw: { width: RW, height: RH, channels: 3 } }).png().toFile(refPng);
    await sharp!(syntheticGrey(), { raw: { width: SW, height: SH, channels: 1 } }).toColourspace('b-w').tiff({ compression: 'lzw' }).toFile(greyTif);
  });

  /** The reference enlarged to the whole level in one linear-light resize,
   *  wrapped by a halo of its far edge. */
  async function enlarged(W: number, H: number) {
    const halo = 8;
    const cols = RW + 2 * halo;
    const padded = Buffer.alloc(cols * RH);
    for (let y = 0; y < RH; y++) for (let x = 0; x < cols; x++) padded[y * cols + x] = refGrey[y * RW + (((x - halo) % RW) + RW) % RW];
    const k = W / RW;
    return sharp!(padded, { raw: { width: cols, height: RH, channels: 1 } })
      .pipelineColourspace('scrgb').resize(W + 2 * halo * k, H, { fit: 'fill', kernel: 'lanczos3' }).toColourspace('srgb')
      .extract({ left: halo * k, top: 0, width: W, height: H }).extractChannel(0).raw().toBuffer();
  }

  it('takes the caps from the reference, keeps the ground, and blends the seam in linear light', async () => {
    // A reference texel here is four level rows, so a margin of one covers the
    // three rows lanczos3 reaches (Mercury's half texel is four 64K rows).
    const spec = { ref: refPng, ...caps, margin: 1, feather: 2 };
    const filled = await readFile(await tool.levelRawFile(job('capped', 1, greyTif, { fill: tool.capFill(spec), rawToken: 'caps.v1' }), 1));
    const bare = await readFile(await tool.levelRawFile(job('bare', 1, greyTif), 1));
    const big = await enlarged(512, 256);
    const w = tool.capWeights(256, { ...caps, refHeight: RH, margin: spec.margin, feather: spec.feather });
    let capRows = 0;
    let seamRows = 0;
    for (let y = 0; y < 256; y++) {
      const row = (b: Buffer) => b.subarray(y * 512, (y + 1) * 512);
      if (w[y] === 1) { capRows++; expect(row(filled).equals(row(big))).toBe(true); continue; }
      if (w[y] === 0) { expect(row(filled).equals(row(bare))).toBe(true); continue; }
      seamRows++;
      for (let x = 0; x < 512; x++) {
        const want = w[y] * tool.LINEAR_OF(big[y * 512 + x]) + (1 - w[y]) * tool.LINEAR_OF(bare[y * 512 + x]);
        const encoded = 255 * (want <= 0.0031308 ? 12.92 * want : 1.055 * want ** (1 / 2.4) - 0.055);
        expect(Math.abs(filled[y * 512 + x] - encoded)).toBeLessThanOrEqual(0.5 + 1e-9);
      }
    }
    expect(capRows).toBeGreaterThan(20);
    expect(seamRows).toBeGreaterThan(4);
    // Both caps, the north and the south one.
    expect(w[0]).toBe(1);
    expect(w[255]).toBe(1);
    expect(w[128]).toBe(0);
  });

  it('stops when a texel the resample built partly from unmeasured rows is not wholly the fill\'s', async () => {
    const tooTight = tool.capFill({ ref: refPng, ...caps, margin: -1, feather: 2 });
    await expect(tool.levelRawFile(job('tight', 1, greyTif, { fill: tooTight, rawToken: 'tight.v1' }), 1))
      .rejects.toThrow(/reached past the measured rows/);
  });

  it('is in every level derived from the filled one, averaged down with it', async () => {
    const g = job('capped', 1, greyTif, { fill: tool.capFill({ ref: refPng, ...caps, margin: 1, feather: 2 }), rawToken: 'caps.v1' });
    const l0 = await readFile(await tool.levelRawFile(g, 0));
    const l1 = await readFile(await tool.levelRawFile(g, 1));
    // The top cap of level 0 is the 2x2 linear average of level 1's, to a
    // count or so (lanczos3, not a box, does the averaging).
    let worst = 0;
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 256; x++) {
        const box = [0, 1].flatMap((dy) => [0, 1].map((dx) => tool.LINEAR_OF(l1[(2 * y + dy) * 512 + 2 * x + dx])))
          .reduce((a, b) => a + b, 0) / 4;
        worst = Math.max(worst, Math.abs(tool.LINEAR_OF(l0[y * 256 + x]) - box));
      }
    }
    expect(worst).toBeLessThan(0.05);
  });
});
