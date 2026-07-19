// Mean RGB of one or more pixel boxes in an image — for verifying feature
// contrast in harness screenshots numerically instead of by eyeball.
//   node tools/pxprobe.mjs <img> <x,y[,size]> [<x,y[,size]> ...]   (size default 16)
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const [img, ...boxArgs] = process.argv.slice(2);
const boxes = boxArgs.map((s) => {
  const [x, y, size] = s.split(',').map(Number);
  return { x, y, size: size || 16 };
});
const uri = `data:image/png;base64,${(await readFile(img)).toString('base64')}`;
const br = await chromium.launch({ headless: true });
const pg = await br.newPage();
const rows = await pg.evaluate(async ({ uri, boxes }) => {
  const i = await new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.src = uri; });
  const c = document.createElement('canvas');
  c.width = i.naturalWidth; c.height = i.naturalHeight;
  const x2 = c.getContext('2d', { willReadFrequently: true });
  x2.drawImage(i, 0, 0);
  return boxes.map(({ x, y, size }) => {
    const d = x2.getImageData(x - (size >> 1), y - (size >> 1), size, size).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let k = 0; k < d.length; k += 4) { r += d[k]; g += d[k + 1]; b += d[k + 2]; n++; }
    return { x, y, rgb: [r / n, g / n, b / n].map((v) => Math.round(v)) };
  });
}, { uri, boxes });
for (const r of rows) console.log(`(${r.x},${r.y})  rgb ${r.rgb.join(' ')}`);
await br.close();
