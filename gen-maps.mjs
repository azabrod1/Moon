// Derived texture maps for the Planetarium, generated from the shipped color /
// height maps. No native image library is installed, so the pixel work runs in a
// headless Chromium canvas (Playwright is already a dev dependency) and the
// result is written back to public/textures/.
//
//   node gen-maps.mjs                 # run every job
//   node gen-maps.mjs earth-roughness # run one job
//   node gen-maps.mjs --src=/tmp/dl   # read sources from elsewhere (downloads)
//
// Jobs:
//   earth-roughness  earth-day.jpg  -> earth-roughness.png  (ocean glossy, land matte)
//   moon-normal      moon-height.*  -> moon-normal.png      (tangent-space normal)
//   mars-normal      mars-height.*  -> mars-normal.png
//
// height->normal jobs need an elevation source dropped in first (USGS/MOLA/etc.);
// they no-op with a notice if the source file is absent.
import { chromium } from 'playwright';
import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

const TEX = path.resolve('public/textures');

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
const srcDir = path.resolve(arg('src', TEX));

// Each job: source filename (resolved against srcDir), output (always TEX), the
// transform name, an output scale (data maps don't need full color res), and
// transform options. earth-roughness runs from a shipped source; the normal jobs
// need an elevation source dropped into srcDir (--src=...) first:
//   moon-height.png  <- SVS CGI Moon Kit ldem_4_uint.tif (LOLA), TIFF->PNG via sips
//   mars-mola.jpg    <- NASA marsoweb MOLA_cylin.jpg (colorized; mola:true decodes hue->elevation)
const JOBS = {
  'earth-roughness': { src: 'earth-day.jpg',  out: 'earth-roughness.png', fn: 'oceanRoughness', scale: 0.25 },
  'moon-normal':     { src: 'moon-height.png', out: 'moon-normal.png',     fn: 'heightToNormal', scale: 1, opts: { strength: 3.0 } },
  'mars-normal':     { src: 'mars-mola.jpg',   out: 'mars-normal.png',     fn: 'heightToNormal', scale: 0.25, opts: { strength: 2.4, mola: true } },
};

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

// Runs in the page (injected as a string, eval'd to a map of transforms — robust
// against strict mode, no closure over Node scope). Each transform reads the src
// ImageData and writes the dst ImageData.
const PAGE_TRANSFORMS = `
(function () {
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  // Ocean glint: a roughness map where water is glossy (low roughness -> a tight
  // solar specular = the blue-marble sun glint) and land/cloud/ice is matte.
  // Ocean is the blue-dominant, darker pixels of a true-color day map; the green
  // channel carries roughness (MeshStandardMaterial samples roughnessMap.g).
  function oceanRoughness(src, dst, w, h) {
    const s = src.data, d = dst.data;
    for (let i = 0; i < s.length; i += 4) {
      const r = s[i] / 255, g = s[i + 1] / 255, b = s[i + 2] / 255;
      const blueDom = b - Math.max(r, g);          // > 0 over blue water, <= 0 on land/ice
      const ocean = clamp01((blueDom - 0.01) * 10.0); // clean ocean/land split
      const rough = 0.92 - ocean * 0.47;           // land 0.92 -> ocean ~0.45 (broad sheen, not a hot mirror dot)
      const v = Math.round(rough * 255);
      d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
    }
  }

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

  // Grayscale height (red channel) -> tangent-space normal via central difference.
  // Longitude wraps, latitude clamps. The longitude slope is divided by cos(lat):
  // equirectangular x-texels collapse toward the poles, and Three samples normal
  // maps in a normalized tangent frame, so that scaling has to live in the map.
  // ny is flipped to match the OpenGL/Three normal convention.
  function heightToNormal(src, dst, w, h, opts) {
    const strength = (opts && opts.strength) || 2.0;
    const s = src.data, d = dst.data;
    const H = (x, y) => {
      x = ((x % w) + w) % w;
      y = y < 0 ? 0 : y >= h ? h - 1 : y;
      return s[(y * w + x) * 4] / 255;
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

  return { oceanRoughness, heightToNormal, molaToHeight };
})()
`;

async function runJob(page, name) {
  const def = JOBS[name];
  if (!def) { console.log(`[gen-maps] unknown job: ${name}`); return false; }
  const srcPath = path.join(srcDir, def.src);
  if (!(await exists(srcPath))) {
    console.log(`[gen-maps] skip ${name}: source not found (${srcPath})`);
    return false;
  }
  const buf = await readFile(srcPath);
  const mime = def.src.endsWith('.png') ? 'image/png' : 'image/jpeg';
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
      ctx.drawImage(img, 0, 0);
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
