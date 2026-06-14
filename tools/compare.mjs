// Side-by-side before/after compositor for harness screenshots.
//
// Reads two folders of same-named PNGs and writes one labelled "before | after"
// image per body (no imagemagick needed — composites in a headless page).
//
//   node tools/compare.mjs --before=/tmp/moon-shots/before --after=/tmp/moon-shots/after \
//     --out=/tmp/moon-shots/compare --bodies=Earth,Venus,Saturn
import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

const beforeDir = arg('before', '/tmp/moon-shots/before');
const afterDir = arg('after', '/tmp/moon-shots/after');
const outDir = arg('out', '/tmp/moon-shots/compare');
const bodies = arg('bodies', 'Earth,Venus,Mars,Jupiter,Saturn,Uranus,Neptune')
  .split(',').map((s) => s.trim()).filter(Boolean);

async function dataUri(p) {
  return `data:image/png;base64,${(await readFile(p)).toString('base64')}`;
}

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 340 }, deviceScaleFactor: 1 });
  for (const body of bodies) {
    let before, after;
    try {
      before = await dataUri(path.join(beforeDir, `${body}.png`));
      after = await dataUri(path.join(afterDir, `${body}.png`));
    } catch {
      console.log(`[compare] SKIP ${body} (missing pair)`); continue;
    }
    const html = `<!doctype html><html><head><style>
      body{margin:0;background:#0a0a0f;font-family:-apple-system,sans-serif}
      .wrap{display:flex}
      figure{margin:0;position:relative}
      figcaption{position:absolute;top:8px;left:12px;font-size:15px;color:#fff;
        background:rgba(0,0,0,.55);padding:3px 10px;border-radius:5px;letter-spacing:1px}
      .title{position:absolute;top:8px;right:12px;font-size:15px;color:#9ad;
        background:rgba(0,0,0,.55);padding:3px 10px;border-radius:5px}
      img{width:540px;height:auto;display:block}
    </style></head><body><div class="wrap">
      <figure><figcaption>BEFORE</figcaption><img src="${before}"></figure>
      <figure><figcaption>AFTER</figcaption><span class="title">${body}</span><img src="${after}"></figure>
    </div></body></html>`;
    await page.setContent(html, { waitUntil: 'load' });
    await page.waitForTimeout(200);
    const out = path.join(outDir, `${body}.png`);
    await (await page.$('.wrap')).screenshot({ path: out });
    console.log(`[compare] ${body} -> ${out}`);
  }
} finally {
  await browser.close();
}
