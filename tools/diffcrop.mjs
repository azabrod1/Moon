// 1:1 crop comparator for harness screenshots. Unlike compare.mjs (which scales
// to a thumbnail and hides resolution differences), this composites a centred
// native-resolution crop of before|after and prints the mean per-pixel
// difference — so a texture-tier swap (2K -> 4K) is both visible and measurable.
//
//   node tools/diffcrop.mjs --before=/tmp/moon-shots/4k-before \
//     --after=/tmp/moon-shots/4k-after --bodies=Moon,Mars --crop=560
import { chromium } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
const beforeDir = arg('before', '/tmp/moon-shots/4k-before');
const afterDir = arg('after', '/tmp/moon-shots/4k-after');
const outDir = arg('out', '/tmp/moon-shots/4k-diff');
const crop = Number(arg('crop', '560'));
const bodies = arg('bodies', 'Moon,Mars').split(',').map((s) => s.trim()).filter(Boolean);

async function dataUri(p) { return `data:image/png;base64,${(await readFile(p)).toString('base64')}`; }

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  for (const body of bodies) {
    let before, after;
    try {
      before = await dataUri(path.join(beforeDir, `${body}.png`));
      after = await dataUri(path.join(afterDir, `${body}.png`));
    } catch { console.log(`[diffcrop] SKIP ${body} (missing pair)`); continue; }
    const res = await page.evaluate(async ({ before, after, crop, body }) => {
      const load = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = src; });
      const bi = await load(before), ai = await load(after);
      const w = bi.naturalWidth, h = bi.naturalHeight;
      const c = document.createElement('canvas'); c.width = w; c.height = h; const cx = c.getContext('2d', { willReadFrequently: true });
      cx.drawImage(bi, 0, 0); const bd = cx.getImageData(0, 0, w, h).data;
      cx.clearRect(0, 0, w, h); cx.drawImage(ai, 0, 0); const ad = cx.getImageData(0, 0, w, h).data;
      let sum = 0, n = 0;
      for (let i = 0; i < bd.length; i += 4) {
        sum += (Math.abs(bd[i] - ad[i]) + Math.abs(bd[i + 1] - ad[i + 1]) + Math.abs(bd[i + 2] - ad[i + 2])) / 3;
        n++;
      }
      const cs = crop, x0 = Math.round((w - cs) / 2), y0 = Math.round((h - cs) / 2);
      const out = document.createElement('canvas'); out.width = cs * 2 + 30; out.height = cs + 48;
      const ox = out.getContext('2d');
      ox.fillStyle = '#0a0a0f'; ox.fillRect(0, 0, out.width, out.height);
      ox.drawImage(bi, x0, y0, cs, cs, 0, 48, cs, cs);
      ox.drawImage(ai, x0, y0, cs, cs, cs + 30, 48, cs, cs);
      ox.fillStyle = '#fff'; ox.font = '20px sans-serif';
      ox.fillText('BEFORE 2K (1:1)', 10, 30);
      ox.fillText('AFTER 4K (1:1)', cs + 40, 30);
      return { meanDiff: sum / n, dataUrl: out.toDataURL('image/png') };
    }, { before, after, crop, body });
    await writeFile(path.join(outDir, `${body}.png`), Buffer.from(res.dataUrl.split(',')[1], 'base64'));
    console.log(`[diffcrop] ${body}: meanAbsDiff=${res.meanDiff.toFixed(3)}/255 -> ${path.join(outDir, body + '.png')}`);
  }
} finally { await browser.close(); }
