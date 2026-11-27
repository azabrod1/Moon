// Every ship on the ☰ Ship page, in the real app, on one contact sheet.
//
// For judging how the ships look after a change to a model or to the kit
// (src/planetarium/ship/models). It drives the running dev server through the
// `window.__moon` bridge: `setShip` flies each ship without saving the choice,
// and `shipStudio` parks it at screen centre with the camera and the Sun at
// the angles each view names, so the same poses come back every run. A ship
// is drawn by the app's own renderer here, with its light, its bloom and its
// lens; nothing is rendered apart from the app.
//
// Prereq: dev server running (`npm run dev`). Then:
//   node tools/ship-gallery.mjs                       # every ship, every view
//   node tools/ship-gallery.mjs --ships=saucer,manta  # some of them
//   node tools/ship-gallery.mjs --views=lit,backlit   # some of the views (lit, backlit, quarter, ahead, below)
//   node tools/ship-gallery.mjs --sun=0.05            # at the spawn point, where a hull is likeliest to bloom
//
// What to look for, per view: from the chase view (how the ship is nearly
// always seen) a clear silhouette and visible engines; back-lit, a ship that
// is still readable against the stars with no glare of its own; from below
// and ahead, no part missing or inside out.
//
// A parked ship burns nothing, so flames are not in these pictures: fly the
// ship to see them. Renders on the GPU by default; pass --software to force
// SwiftShader where the headless GPU path returns black frames. Takes
// /tmp/moon-browser.lock (tools/browserLock.mjs).
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { takeBrowserLock } from './browserLock.mjs';

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

const url = arg('url', 'http://localhost:5174');
const out = arg('out', '/tmp/moon-shots/ship-gallery.png');
const only = arg('ships', '').split(',').map((s) => s.trim()).filter(Boolean);
const onlyViews = arg('views', '').split(',').map((s) => s.trim()).filter(Boolean);
const sunDistanceAU = Number(arg('sun', '1'));
const cell = { width: 440, height: 330 };

// Camera and Sun as shipStudio takes them: azimuth 0 is dead astern, turning
// toward port; elevation is up; distance is in chase distances.
const VIEWS = [
  { key: 'lit', label: 'chase, Sun behind the camera', azimuthDeg: 0, elevationDeg: 18, distance: 1, sunAzimuthDeg: 20, sunElevationDeg: 35 },
  { key: 'backlit', label: 'chase, back-lit', azimuthDeg: 0, elevationDeg: 18, distance: 1, sunAzimuthDeg: 170, sunElevationDeg: 15 },
  { key: 'quarter', label: 'port quarter', azimuthDeg: 55, elevationDeg: 22, distance: 0.85, sunAzimuthDeg: 100, sunElevationDeg: 40 },
  { key: 'ahead', label: 'from ahead', azimuthDeg: 145, elevationDeg: 14, distance: 0.85, sunAzimuthDeg: 120, sunElevationDeg: 35 },
  { key: 'below', label: 'from below', azimuthDeg: 35, elevationDeg: -55, distance: 0.9, sunAzimuthDeg: 20, sunElevationDeg: -50 },
].filter((view) => !onlyViews.length || onlyViews.includes(view.key));
if (!VIEWS.length) throw new Error('no view to draw: --views takes lit, backlit, quarter, ahead, below');

const useGpu = !process.argv.includes('--software');
const release = await takeBrowserLock('ship-gallery');
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PW_CHROMIUM || undefined, // pinned-browser environments
  args: useGpu
    ? ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader']
    : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
console.log(`[ship-gallery] renderer: ${useGpu ? 'GPU' : 'software (SwiftShader)'}`);

try {
  const viewport = { width: 1280, height: 800 };
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
      indexedDB.deleteDatabase('orbital-sim-storage');
      localStorage.setItem('planetarium-help-seen', '1');
      localStorage.setItem('planetarium-surface-hint-seen', '1');
    } catch { /* storage blocked: harmless */ }
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(`${url}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 120000 });
  await page.waitForFunction(() => {
    const ls = document.getElementById('loading-screen');
    return !ls || ls.classList.contains('hidden');
  }, { timeout: 120000 }).catch(() => {});
  await page.evaluate(() => window.__moon.setChrome(false));

  // The ships the page offers, read from its own cards, so this list cannot go stale.
  const offered = await page.evaluate(() => [...document.querySelectorAll('.ship-card')].map((card) => card.dataset.value));
  const ships = only.length ? offered.filter((id) => only.includes(id)) : offered;
  if (!ships.length) throw new Error(`no ship to draw: the page offers ${offered.join(', ')}`);

  const clip = {
    x: (viewport.width - cell.width) / 2, y: (viewport.height - cell.height) / 2, width: cell.width, height: cell.height,
  };
  const cells = [];
  for (const ship of ships) {
    if (!(await page.evaluate((id) => window.__moon.setShip(id), ship))) throw new Error(`the app refused the ship "${ship}"`);
    for (const view of VIEWS) {
      const { key: _key, label, ...pose } = view;
      await page.evaluate((opts) => window.__moon.shipStudio(opts), { ...pose, sunDistanceAU });
      await page.evaluate(() => window.__moon.waitForDraw(4));
      const shot = await page.screenshot({ clip });
      cells.push(`<figure><img src="data:image/png;base64,${shot.toString('base64')}"><figcaption>${ship}: ${label}</figcaption></figure>`);
    }
    console.log(`[ship-gallery] ${ship}`);
  }

  const sheet = await context.newPage();
  await sheet.setViewportSize({ width: VIEWS.length * (cell.width + 6) + 14, height: 200 });
  await sheet.setContent(`<!doctype html><html><head><style>
    body{margin:0;background:#08080c;font-family:-apple-system,sans-serif}
    .grid{display:grid;grid-template-columns:repeat(${VIEWS.length},${cell.width}px);gap:6px;padding:10px}
    figure{margin:0;position:relative}
    img{width:100%;display:block;border-radius:3px}
    figcaption{position:absolute;top:5px;left:6px;font-size:12px;color:#cde;
      background:rgba(0,0,0,.6);padding:2px 7px;border-radius:4px}
  </style></head><body><div class="grid">${cells.join('')}</div></body></html>`, { waitUntil: 'load' });
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, await sheet.screenshot({ fullPage: true }));
  console.log(`[ship-gallery] ${ships.length} ships x ${VIEWS.length} views -> ${out}`);
  if (errors.length) {
    console.log(`[ship-gallery] page errors (${errors.length}):`);
    for (const e of errors.slice(0, 10)) console.log('    ', e);
  }
} finally {
  await browser.close();
  release();
}
