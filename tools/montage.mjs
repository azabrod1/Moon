// Tile a folder of PNGs into one labelled grid image — for scanning many frames
// (e.g. a time sweep hunting a moon-shadow transit) in a single look.
//
//   node tools/montage.mjs --dir=/tmp/moon-shots/scan --out=/tmp/moon-shots/scan.png --cols=4
import { chromium } from 'playwright';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

const dir = arg('dir', '/tmp/moon-shots/scan');
const out = arg('out', '/tmp/moon-shots/montage.png');
const cols = Number(arg('cols', '4'));

const files = (await readdir(dir)).filter((f) => f.endsWith('.png')).sort();
if (!files.length) { console.log(`[montage] no PNGs in ${dir}`); process.exit(1); }

const cells = [];
for (const f of files) {
  const uri = `data:image/png;base64,${(await readFile(path.join(dir, f))).toString('base64')}`;
  cells.push(`<figure><img src="${uri}"><figcaption>${f.replace('.png', '')}</figcaption></figure>`);
}

await mkdir(path.dirname(out), { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: cols * 340 + 20, height: 200 }, deviceScaleFactor: 1 });
  const html = `<!doctype html><html><head><style>
    body{margin:0;background:#08080c;font-family:-apple-system,sans-serif}
    .grid{display:grid;grid-template-columns:repeat(${cols},1fr);gap:6px;padding:10px}
    figure{margin:0;position:relative}
    img{width:100%;display:block;border-radius:3px}
    figcaption{position:absolute;top:5px;left:6px;font-size:12px;color:#cde;
      background:rgba(0,0,0,.6);padding:2px 7px;border-radius:4px}
  </style></head><body><div class="grid">${cells.join('')}</div></body></html>`;
  await page.setContent(html, { waitUntil: 'load' });
  await page.waitForTimeout(200);
  await (await page.$('.grid')).screenshot({ path: out });
  console.log(`[montage] ${files.length} frames -> ${out}`);
} finally {
  await browser.close();
}
