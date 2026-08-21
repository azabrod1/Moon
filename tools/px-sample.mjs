// Mean RGB of a box region across PNGs: node tools/px-sample.mjs --box=x,y,w,h file1 file2 ...
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
const boxArg = process.argv.find((a) => a.startsWith('--box='));
const [bx, by, bw, bh] = boxArg.slice(6).split(',').map(Number);
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
for (const f of files) {
  const uri = `data:image/png;base64,${(await readFile(f)).toString('base64')}`;
  const res = await page.evaluate(async ({ uri, bx, by, bw, bh }) => {
    const img = new Image();
    await new Promise((ok, err) => { img.onload = ok; img.onerror = err; img.src = uri; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(bx, by, bw, bh).data;
    let r = 0, gg = 0, b = 0, n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
    return { r: (r / n).toFixed(1), g: (gg / n).toFixed(1), b: (b / n).toFixed(1) };
  }, { uri, bx, by, bw, bh });
  console.log(f.split('/').slice(-2).join('/'), JSON.stringify(res));
}
await browser.close();
