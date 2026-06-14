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
//   mercury-normal   mercury-height.* -> mercury-normal.png
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
// transform options.
const JOBS = {
  'earth-roughness': { src: 'earth-day.jpg', out: 'earth-roughness.png', fn: 'oceanRoughness', scale: 0.25 },
  'moon-normal':     { src: 'moon-height.png',    out: 'moon-normal.png',    fn: 'heightToNormal', scale: 1, opts: { strength: 3.0 } },
  'mars-normal':     { src: 'mars-height.png',    out: 'mars-normal.png',    fn: 'heightToNormal', scale: 1, opts: { strength: 2.5 } },
  'mercury-normal':  { src: 'mercury-height.png', out: 'mercury-normal.png', fn: 'heightToNormal', scale: 1, opts: { strength: 3.0 } },
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

  // Height -> tangent-space normal via a central difference. Red holds height
  // (grayscale source). Longitude wraps; latitude clamps at the poles. ny is
  // flipped to match the OpenGL/Three normal convention against the equirect UV.
  function heightToNormal(src, dst, w, h, opts) {
    const strength = (opts && opts.strength) || 2.0;
    const s = src.data, d = dst.data;
    const H = (x, y) => {
      x = ((x % w) + w) % w;
      y = y < 0 ? 0 : y >= h ? h - 1 : y;
      return s[(y * w + x) * 4] / 255;
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dzdx = (H(x + 1, y) - H(x - 1, y)) * strength;
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

  return { oceanRoughness, heightToNormal };
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
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const srcData = ctx.getImageData(0, 0, w, h);
    const dstData = ctx.createImageData(w, h);
    T[fn](srcData, dstData, w, h, opts);
    ctx.putImageData(dstData, 0, 0);
    return cv.toDataURL('image/png').split(',')[1];
  }, { b64: buf.toString('base64'), mime, fn: def.fn, scale: def.scale, opts: def.opts || {}, transforms: PAGE_TRANSFORMS });
  const outPath = path.join(TEX, def.out);
  await writeFile(outPath, Buffer.from(outB64, 'base64'));
  console.log(`[gen-maps] ${name}: ${def.src} -> ${def.out}`);
  return true;
}

const requested = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const jobs = requested.length ? requested : Object.keys(JOBS);

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  let ok = 0;
  for (const j of jobs) if (await runJob(page, j)) ok++;
  console.log(`[gen-maps] done: ${ok}/${jobs.length}`);
} finally {
  await browser.close();
}
