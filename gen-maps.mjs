// Derived texture maps for the Planetarium, generated from the shipped color /
// height maps. No native image library is installed, so the pixel work runs in a
// headless Chromium canvas (Playwright is already a dev dependency) and the
// result is written back to public/textures/.
//
//   node gen-maps.mjs                 # run every job
//   node gen-maps.mjs moon-normal     # run one job
//   node gen-maps.mjs --src=/tmp/dl   # read sources from elsewhere (downloads)
//
// Jobs:
//   moon-normal      ldem_16_uint.tif  -> moon-normal.png      (boot-tier tangent-space normal)
//   moon-normal-4k   ldem_16_uint.tif  -> 4k/moon-normal.png   (close-approach tier)
//   mars-normal      megt90n000eb.img  -> mars-normal.v2.png
//   earth-clouds-normal      8k/earth-clouds.webp -> earth-clouds-normal.png
//
// height->normal jobs need an elevation source dropped in first (USGS/LOLA/MOLA);
// they no-op with a notice if the source file is absent. Jobs whose source is a
// shipped texture read it from public/textures regardless of --src.
import { chromium } from 'playwright';
import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

const TEX = path.resolve('public/textures');

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
const srcDir = path.resolve(arg('src', TEX));

// Each job: source filename (resolved against srcDir, or against `from` when the
// source is a shipped map that must not follow --src), output (always TEX), the
// transform name, an output scale (data maps don't need full color res), an
// optional `decode` for sources no browser can read, and transform options.
// The normal jobs need an elevation source dropped into srcDir (--src=...) first:
//   ldem_16_uint.tif <- SVS CGI Moon Kit (LOLA), 5760x2880 unsigned 16-bit
//   megt90n000eb.img <- PDS MOLA MEGDR 16 ppd DEM (pds-geosciences.wustl.edu, mgsl_300x/meg016; 0-360E, rolled by rollU)
//
// moon-normal's strength is tied to its output resolution: per-texel height
// deltas shrink as texels get smaller, so halving the sample spacing needs
// roughly double the strength to keep the same macro relief.
//
// The lunar relief ships in two tiers: the 1440x720 boot map (8.8 MB at
// 2880x1440 was a third of all boot traffic, for relief no spawn-distance
// Moon can show) and the 2880x1440 close-approach map under 4k/, streamed
// when the Moon actually fills the view (PlanetFactory's normal upgrade).
// NOTE: the committed boot-tier file is the pre-16-bit-source original
// (heightToNormal from moon-height.png at strength 3.0); regenerating with
// the LOLA TIFF present replaces it with the 16-bit derivation below —
// visually equivalent at this scale, minus the 8-bit terracing.
const JOBS = {
  'moon-normal':     { src: 'ldem_16_uint.tif', out: 'moon-normal.png', fn: 'normalsFromHeights', scale: 0.25, decode: 'uint16-tiff', opts: { strength: 3.0 } },
  'moon-normal-4k':  { src: 'ldem_16_uint.tif', out: '4k/moon-normal.png', fn: 'normalsFromHeights', scale: 0.5, decode: 'uint16-tiff', opts: { strength: 6.0 } },
  // MOLA MEGDR 16 pixel/degree DEM (PDS megt90n000eb.img: 5760x2880 big-endian
  // 16-bit metres, 0–360°E with longitude 0 at its left edge). Every Mars
  // colour map here (and the tiles) puts −180° at the left, so rollU shifts
  // the relief by half a turn: Olympus Mons shades where the colour draws it.
  // 16-bit heights, like the Moon's: no 8-bit terracing across the plains.
  'mars-normal':     { src: 'megt90n000eb.img', out: 'mars-normal.v2.png', fn: 'normalsFromHeights', scale: 0.25, decode: 'int16be-raw', dims: { width: 5760, height: 2880 }, opts: { strength: 2.4, rollU: 0.5 } },
  // Cloud relief, from the deck's own 8K colour map: brightness stands in for
  // height, so what lights as a bank of cloud is exactly what draws as one and
  // the relief can never drift from the coverage. It is a PROXY and not an
  // elevation model — a bright low stratus deck is not a mountain — which is
  // why the material that reads it authors a shallow normalScale.
  //
  // ONE tier, and 1024 rather than 4096, because a cloud field's relief map is
  // nearly incompressible: the same job at 4096 is 15.6 MB lossless, 10.3 MB
  // near-lossless and 2.9 MB only as ordinary lossy webp, which is YUV420 and
  // puts 14 counts of RMS error into the two channels that ARE the tilt. For
  // comparison the deck's own 8K COLOUR rung — which doubles the resolution of
  // the picture rather than of a guess at its height — is 4.7 MB, and blurring
  // the height field first only reaches 7.9 MB at a blur that costs the relief
  // its shape. The band a 4K relief would have added (4 to 40 km) is the band
  // the procedural detail noise already covers, registered to nothing but
  // costing no bytes at all; this map's job is the macro relief, which is
  // registered to the actual clouds and is what 1024 holds.
  //
  // Strength 1.6, not the 0.4 the lunar pair's resolution rule would give for
  // an eighth-scale map. That rule (halve the spacing, double the strength)
  // holds where the field is smooth at the texel scale; cloud is not, so most
  // of an 8x downsample's gradient is lost to smoothing rather than to the
  // wider step. 1.6 here lands on the tilt distribution 2.0 does at 4096 —
  // median 10 degrees, 90th percentile 30 — measured, not derived.
  'earth-clouds-normal': { src: 'earth-clouds.webp', from: path.join(TEX, '8k'), out: 'earth-clouds-normal.png', fn: 'luminanceToNormal', scale: 0.125, opts: { strength: 1.6 } },
};

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

// Minimal reader for an uncompressed 16-bit grayscale TIFF, enough for the LOLA
// elevation maps and nothing more. It exists because the 8-bit canvas the rest of
// this file runs on would quantize the Moon's ~20km relief into ~78m steps, and
// those steps show up as terracing across the smooth maria. Heights therefore
// stay 16-bit here and float from there on.
function readUint16Tiff(buf) {
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

// Runs in the page (injected as a string, eval'd to a map of transforms — robust
// against strict mode, no closure over Node scope). Each transform reads the src
// ImageData and writes the dst ImageData.
const PAGE_TRANSFORMS = `
(function () {
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  // MOLA-style rainbow relief -> scalar elevation. The colormap sweeps blue
  // (low) through cyan/green/yellow to red (high), so HUE tracks elevation
  // monotonically and — unlike luminance — is largely immune to the hillshade
  // baked into brightness. Desaturated pixels (white summits / dark basins) fall
  // back to brightness. Used to recover a height field from the colorized map.
  function molaElevation(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
    const sat = mx > 1e-6 ? c / mx : 0;
    if (sat < 0.15) return mx; // grey/white: bright = high peak, dark = low
    let hue;
    if (mx === r) hue = ((g - b) / c) % 6;
    else if (mx === g) hue = (b - r) / c + 2;
    else hue = (r - g) / c + 4;
    hue = (hue * 60 + 360) % 360;
    return clamp01((240 - hue) / 240); // blue(240deg)->low, red(0deg)->high
  }

  // Decode a MOLA rainbow relief map to a grayscale height field (height in red).
  // Run at native resolution before any downscale, so interpolation can't blend
  // red+blue into purple (which molaElevation would read as a false low).
  function molaToHeight(src, dst, w, h) {
    const s = src.data, d = dst.data;
    for (let i = 0; i < s.length; i += 4) {
      const v = Math.round(molaElevation(s[i] / 255, s[i + 1] / 255, s[i + 2] / 255) * 255);
      d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
    }
  }

  // Colour -> tangent-space normal, with Rec.709 luminance as the height field.
  // The luminance is the file's STORED value, not a linearized one: the map was
  // graded by eye in that space, and the deck's coverage curve reads it there
  // too, so one brightness means one thing to both.
  function luminanceToNormal(src, dst, w, h, opts) {
    const s = src.data;
    const heights = new Float64Array(w * h);
    for (let i = 0; i < heights.length; i++) {
      const o = i * 4;
      heights[i] = (0.2126 * s[o] + 0.7152 * s[o + 1] + 0.0722 * s[o + 2]) / 255;
    }
    normalsFromHeights(heights, dst, w, h, opts);
  }

  // Grayscale height (red channel) -> tangent-space normal. Kept as the entry
  // point for sources that arrive as an image; the gradient work is shared with
  // the float path, which is the one that preserves 16-bit elevation detail.
  function heightToNormal(src, dst, w, h, opts) {
    const s = src.data;
    const heights = new Float64Array(w * h);
    for (let i = 0; i < heights.length; i++) heights[i] = s[i * 4] / 255;
    normalsFromHeights(heights, dst, w, h, opts);
  }

  // Bilinear resample of a float height field. Longitude wraps (equirectangular
  // maps are seamless in x), latitude clamps. At an exact 2:1 reduction the
  // half-texel offsets make this a 2x2 box average, so no detail is skipped.
  function resampleHeights(src, sw, sh, dw, dh) {
    const out = new Float64Array(dw * dh);
    const sx = sw / dw, sy = sh / dh;
    for (let y = 0; y < dh; y++) {
      let fy = (y + 0.5) * sy - 0.5;
      if (fy < 0) fy = 0; else if (fy > sh - 1) fy = sh - 1;
      const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, sh - 1), ty = fy - y0;
      for (let x = 0; x < dw; x++) {
        const fx = (x + 0.5) * sx - 0.5;
        const x0 = Math.floor(fx), tx = fx - x0;
        const xa = ((x0 % sw) + sw) % sw, xb = ((x0 + 1) % sw + sw) % sw;
        const top = src[y0 * sw + xa] * (1 - tx) + src[y0 * sw + xb] * tx;
        const bot = src[y1 * sw + xa] * (1 - tx) + src[y1 * sw + xb] * tx;
        out[y * dw + x] = top * (1 - ty) + bot * ty;
      }
    }
    return out;
  }

  // Float height field -> tangent-space normal via central difference.
  // Longitude wraps, latitude clamps. The longitude slope is divided by cos(lat):
  // equirectangular x-texels collapse toward the poles, and Three samples normal
  // maps in a normalized tangent frame, so that scaling has to live in the map.
  // ny is flipped to match the OpenGL/Three normal convention.
  function normalsFromHeights(s, dst, w, h, opts) {
    const strength = (opts && opts.strength) || 2.0;
    const d = dst.data;
    const H = (x, y) => {
      x = ((x % w) + w) % w;
      y = y < 0 ? 0 : y >= h ? h - 1 : y;
      return s[y * w + x];
    };
    for (let y = 0; y < h; y++) {
      const lat = (0.5 - (y + 0.5) / h) * Math.PI;          // +pi/2 N .. -pi/2 S
      const invCosLat = 1.0 / Math.max(Math.cos(lat), 0.2); // clamp so poles don't blow up
      for (let x = 0; x < w; x++) {
        const dzdx = (H(x + 1, y) - H(x - 1, y)) * strength * invCosLat;
        const dzdy = (H(x, y + 1) - H(x, y - 1)) * strength;
        const nx = -dzdx, ny = dzdy, nz = 1.0;
        const inv = 1.0 / Math.sqrt(nx * nx + ny * ny + nz * nz);
        const i = (y * w + x) * 4;
        d[i] = Math.round((nx * inv * 0.5 + 0.5) * 255);
        d[i + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
        d[i + 2] = Math.round((nz * inv * 0.5 + 0.5) * 255);
        d[i + 3] = 255;
      }
    }
  }

  return { heightToNormal, luminanceToNormal, normalsFromHeights, resampleHeights, molaToHeight };
})()
`;

// The 16-bit height path never touches an <img>: the samples cross into the page
// as raw bytes, become floats there, and only the finished normal map is rasterized.
// A raw big-endian 16-bit grid (a PDS MEGDR .img: no header, dimensions from
// its label), read into the same normalized 16-bit field the TIFF path yields
// (min..max of the samples → 0..65535, so `strength` means the same fraction
// of the body's relief per texel) and rolled by `rollU` of a turn so a
// 0–360°E product lines up with the −180°-left colour maps.
function readInt16BeRaw(buf, width, height, rollU = 0) {
  const n = width * height;
  if (buf.length < n * 2) throw new Error(`expected ${n * 2} bytes for ${width}x${height} int16, got ${buf.length}`);
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16BE(i * 2);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const shift = ((Math.round(width * rollU) % width) + width) % width;
  const scale = 65535 / Math.max(max - min, 1);
  const data = new Uint16Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = (x - shift + width) % width; // content moves east by `shift`
      data[y * width + x] = Math.round((buf.readInt16BE((y * width + sx) * 2) - min) * scale);
    }
  }
  console.log(`[gen-maps] int16 grid ${width}x${height}: heights ${min}..${max}, rolled ${shift} px`);
  return { width, height, data };
}

async function runHeightJob(page, def, buf) {
  const tif = def.decode === 'int16be-raw'
    ? readInt16BeRaw(buf, def.dims.width, def.dims.height, (def.opts && def.opts.rollU) || 0)
    : readUint16Tiff(buf);
  const w = Math.round(tif.width * def.scale), h = Math.round(tif.height * def.scale);
  return page.evaluate(async ({ b64, sw, sh, w, h, fn, opts, transforms }) => {
    const T = eval(transforms);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const raw = new Uint16Array(bytes.buffer);
    const heights = new Float64Array(raw.length);
    for (let i = 0; i < raw.length; i++) heights[i] = raw[i] / 65535;
    const field = sw === w && sh === h ? heights : T.resampleHeights(heights, sw, sh, w, h);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    const dst = ctx.createImageData(w, h);
    T[fn](field, dst, w, h, opts);
    ctx.putImageData(dst, 0, 0);
    return cv.toDataURL('image/png').split(',')[1];
  }, {
    b64: Buffer.from(tif.data.buffer, tif.data.byteOffset, tif.data.byteLength).toString('base64'),
    sw: tif.width, sh: tif.height, w, h, fn: def.fn, opts: def.opts || {}, transforms: PAGE_TRANSFORMS,
  });
}

async function runJob(page, name) {
  const def = JOBS[name];
  if (!def) { console.log(`[gen-maps] unknown job: ${name}`); return false; }
  const srcPath = path.join(def.from || srcDir, def.src);
  if (!(await exists(srcPath))) {
    // Only srcDir sources (the hand-dropped elevation maps) may be absent; a
    // `from` source is a shipped map, and skipping one quietly would let a
    // rename leave this job regenerating nothing while exiting green.
    if (def.from) {
      console.error(`[gen-maps] ${name}: shipped source missing (${srcPath})`);
      process.exitCode = 1;
      return false;
    }
    console.log(`[gen-maps] skip ${name}: source not found (${srcPath})`);
    return false;
  }
  const buf = await readFile(srcPath);
  if (def.decode === 'uint16-tiff' || def.decode === 'int16be-raw') {
    const b64 = await runHeightJob(page, def, buf);
    await writeFile(path.join(TEX, def.out), Buffer.from(b64, 'base64'));
    console.log(`[gen-maps] ${name}: ${def.src} -> ${def.out}`);
    return true;
  }
  const mime = def.src.endsWith('.png') ? 'image/png'
    : def.src.endsWith('.webp') ? 'image/webp'
    : 'image/jpeg';
  const outB64 = await page.evaluate(async ({ b64, mime, fn, scale, opts, transforms }) => {
    const T = eval(transforms);
    const img = new Image();
    img.src = `data:${mime};base64,${b64}`;
    await img.decode();
    const nw = img.naturalWidth, nh = img.naturalHeight;
    const w = Math.round(nw * scale), h = Math.round(nh * scale);
    const cv = document.createElement('canvas');
    const ctx = cv.getContext('2d');

    let srcData;
    if (opts && opts.mola) {
      // Decode the rainbow -> grayscale height at native res, then downscale the
      // grayscale (which interpolates cleanly), so colour blending can't fabricate
      // false lows at sharp red/blue elevation boundaries.
      cv.width = nw; cv.height = nh;
      // rollU: shift the source east by that fraction of a turn (drawn twice,
      // wrapping), for a source whose longitude origin differs from the maps'.
      const shift = Math.round(nw * (opts.rollU || 0));
      ctx.drawImage(img, shift, 0);
      if (shift) ctx.drawImage(img, shift - nw, 0);
      const grey = ctx.createImageData(nw, nh);
      T.molaToHeight(ctx.getImageData(0, 0, nw, nh), grey, nw, nh);
      ctx.putImageData(grey, 0, 0);
      const small = document.createElement('canvas');
      small.width = w; small.height = h;
      const sctx = small.getContext('2d');
      sctx.drawImage(cv, 0, 0, w, h);
      srcData = sctx.getImageData(0, 0, w, h);
    } else {
      cv.width = w; cv.height = h;
      ctx.drawImage(img, 0, 0, w, h);
      srcData = ctx.getImageData(0, 0, w, h);
    }

    cv.width = w; cv.height = h; // (re)size for output
    const outCtx = cv.getContext('2d');
    const dstData = outCtx.createImageData(w, h);
    T[fn](srcData, dstData, w, h, opts);
    outCtx.putImageData(dstData, 0, 0);
    return cv.toDataURL('image/png').split(',')[1];
  }, { b64: buf.toString('base64'), mime, fn: def.fn, scale: def.scale, opts: def.opts || {}, transforms: PAGE_TRANSFORMS });
  const outPath = path.join(TEX, def.out);
  await writeFile(outPath, Buffer.from(outB64, 'base64'));
  console.log(`[gen-maps] ${name}: ${def.src} -> ${def.out}`);
  return true;
}

const requested = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const jobs = requested.length ? requested : Object.keys(JOBS);

// A named job that doesn't exist is a mistake, not a no-op — fail loudly before
// spinning up Chromium (a known job whose source is absent still skips cleanly).
const unknown = requested.filter((j) => !(j in JOBS));
if (unknown.length) {
  console.error(`[gen-maps] unknown job(s): ${unknown.join(', ')}`);
  console.error(`[gen-maps] known jobs: ${Object.keys(JOBS).join(', ')}`);
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  let ok = 0;
  for (const j of jobs) if (await runJob(page, j)) ok++;
  console.log(`[gen-maps] done: ${ok}/${jobs.length}`);
} finally {
  await browser.close();
}
