// Pixel diff for the atmosphere goldens: decode two PNGs in a headless page (no
// native image library here) and report how far apart they are, per channel.
import { readFile } from 'node:fs/promises';
const pairs = process.argv.slice(2);
const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
for (let i = 0; i < pairs.length; i += 2) {
  const [a, b] = [pairs[i], pairs[i + 1]];
  const [ba, bb] = await Promise.all([readFile(a), readFile(b)]);
  const r = await page.evaluate(async ([ua, ub]) => {
    const load = (uri) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = uri; });
    const [ia, ib] = await Promise.all([load(ua), load(ub)]);
    const px = (im) => { const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; const x = c.getContext('2d'); x.drawImage(im, 0, 0); return x.getImageData(0, 0, c.width, c.height).data; };
    const pa = px(ia), pb = px(ib);
    let differing = 0, worst = 0, total = 0, sum = 0;
    for (let k = 0; k < pa.length; k += 4) {
      total++;
      let d = 0;
      for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(pa[k + c] - pb[k + c]));
      if (d > 0) { differing++; sum += d; }
      worst = Math.max(worst, d);
    }
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    const w = ia.naturalWidth;
    const spots = [];
    for (let k = 0; k < pa.length; k += 4) {
      let d = 0;
      for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(pa[k + c] - pb[k + c]));
      if (d > 0) {
        const px = (k / 4) % w, py = Math.floor((k / 4) / w);
        x0 = Math.min(x0, px); x1 = Math.max(x1, px);
        y0 = Math.min(y0, py); y1 = Math.max(y1, py);
        if (d >= 3 && spots.length < 6) {
          spots.push([px, py, d, [pa[k], pa[k + 1], pa[k + 2]], [pb[k], pb[k + 1], pb[k + 2]]]);
        }
      }
    }
    return { differing, worst, total, mean: differing ? sum / differing : 0, box: [x0, y0, x1, y1], spots };
  }, [`data:image/png;base64,${ba.toString('base64')}`, `data:image/png;base64,${bb.toString('base64')}`]);
  console.log(`${a.split('/').pop()}: ${r.differing}/${r.total} px differ, worst ${r.worst}/255, mean over differing ${r.mean.toFixed(2)}`);
  if (r.differing) console.log('   bbox', r.box.join(','), 'samples', JSON.stringify(r.spots));
}
await browser.close();
