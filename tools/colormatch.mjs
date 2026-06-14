// Colour-match a higher-res replacement map to an existing in-app map, so an
// upgrade-on-approach texture swap doesn't pop in brightness/tint. Reinhard
// per-channel transfer: out = (src - meanSrc) * (stdRef/stdSrc) + meanRef,
// clamped to [0,255]. Matches both brightness and contrast.
//
// Used for the 4K Moon: the NASA SVS CGI Moon Kit colour map
// (lroc_color_poles_4k.tif, https://svs.gsfc.nasa.gov/4720) is the SAME natural-
// colour LRO albedo as our shipped 2K moon.jpg but ~15% darker, so this re-grades
// it to the shipped look at 4K. Recipe:
//   curl -sL https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_4k.tif -o moon.tif
//   sips -s format jpeg -z 2048 4096 moon.tif --out moon_src.jpg
//   node tools/colormatch.mjs --src=moon_src.jpg --ref=public/textures/moon.jpg --out=public/textures/4k/moon.jpg
import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
const srcPath = arg('src', '/tmp/tex-dl/moon_lroc_4k.jpg');
const refPath = arg('ref', 'public/textures/moon.jpg');
const outPath = arg('out', 'public/textures/4k/moon.jpg');
const quality = Number(arg('quality', '0.92'));

async function uri(p) {
  const buf = await readFile(p);
  const mime = p.endsWith('.png') ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

const br = await chromium.launch({ headless: true });
try {
  const pg = await br.newPage();
  const out = await pg.evaluate(async ({ srcUri, refUri, quality }) => {
    const load = (s) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = s; });
    const stats = (img) => {
      const w = img.naturalWidth, h = img.naturalHeight;
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, w, h).data;
      const s = [0, 0, 0], sq = [0, 0, 0]; let n = 0;
      for (let i = 0; i < d.length; i += 4) { for (let k = 0; k < 3; k++) { s[k] += d[i + k]; sq[k] += d[i + k] * d[i + k]; } n++; }
      const mean = s.map((v) => v / n);
      const std = sq.map((v, k) => Math.sqrt(Math.max(v / n - mean[k] * mean[k], 1e-6)));
      return { mean, std };
    };
    const srcImg = await load(srcUri), refImg = await load(refUri);
    const src = stats(srcImg), ref = stats(refImg);
    const gain = [0, 1, 2].map((k) => ref.std[k] / src.std[k]);
    const w = srcImg.naturalWidth, h = srcImg.naturalHeight;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(srcImg, 0, 0);
    const img = x.getImageData(0, 0, w, h); const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      for (let k = 0; k < 3; k++) {
        const v = (d[i + k] - src.mean[k]) * gain[k] + ref.mean[k];
        d[i + k] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
    x.putImageData(img, 0, 0);
    return { dataUrl: c.toDataURL('image/jpeg', quality), srcMean: src.mean, refMean: ref.mean, gain };
  }, { srcUri: await uri(srcPath), refUri: await uri(refPath), quality });
  await writeFile(outPath, Buffer.from(out.dataUrl.split(',')[1], 'base64'));
  console.log(`[colormatch] src mean ${out.srcMean.map((v) => v.toFixed(1))} -> ref mean ${out.refMean.map((v) => v.toFixed(1))} (gain ${out.gain.map((v) => v.toFixed(3))})`);
  console.log(`[colormatch] wrote ${outPath}`);
} finally {
  await br.close();
}
