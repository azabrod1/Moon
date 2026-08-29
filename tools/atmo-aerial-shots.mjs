// The look, not the numbers: aerial perspective A/B in the two frames the owner
// judges it in — the Land-on-Earth arrival range over desert, and the near band
// looking along the ground toward the horizon (the ISS geometry). One session
// per tier so the only difference between a pair is which shell and which air
// the frame was drawn with; the app's own auto-exposure, not a pinned one,
// because what is being judged is what he would see.
//
//   npx vite --port 5646 --strictPort
//   node tools/atmo-aerial-shots.mjs --url=http://localhost:5646 --out=/tmp/moon-shots/atmo3
//
// Writes the individual frames, iss-vs-app-day.png (the four-panel board) and
// horizon-haze.png (a 2x crop of the far ground fading into the limb).
//
// --night swaps the daylight frames for the same geometry past the terminator,
// on a full-Moon clock, and puts the photograph the campaign is drawn from in
// the board beside them:
//
//   node tools/atmo-aerial-shots.mjs --night --out=/tmp/moon-shots/atmo4 \
//     --photo=/path/to/the/iss/frame.png
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const url = arg('url', 'http://localhost:5646');
const out = arg('out', '/tmp/moon-shots/atmo3');
const W = Number(arg('w', '900'));
const H = Number(arg('h', '675'));
const night = process.argv.includes('--night');
// The photograph the night board is judged against, unedited. Left out and the
// board is just the two tiers.
const photo = arg('photo', '');
// Northern summer, late morning UTC: the sub-solar point sits over the Sahara,
// so the arrival frame is desert under a clear sky rather than ocean. At night
// the clock is the Moon's instead: 2026-04-02 02:00 UTC is as full as the Moon
// gets without being eclipsed (phase angle 2.9 degrees), so it stands over the
// middle of the night hemisphere and lights the ground the camera is looking
// along. The fuller Moon a month earlier is a total lunar eclipse and gives no
// light at all — the eclipse term working, and a useless frame.
const TIME_MS = Date.parse(arg('time', night ? '2026-04-02T02:00:00Z' : '2026-06-21T11:00:00Z'));

const { chromium } = await import('playwright');
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
await mkdir(out, { recursive: true });

async function session(tier) {
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
  await context.addInitScript(() => {
    try {
      localStorage.clear(); sessionStorage.clear();
      indexedDB.deleteDatabase('orbital-sim-storage');
      localStorage.setItem('planetarium-help-seen', '1');
      localStorage.setItem('planetarium-surface-hint-seen', '1');
    } catch { /* storage blocked — harmless */ }
  });
  const page = await context.newPage();
  await page.goto(`${url}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon?.ready?.()), { timeout: 60000 });
  await page.waitForFunction(() => {
    const ls = document.getElementById('loading-screen');
    return !ls || ls.classList.contains('hidden');
  }, { timeout: 60000 }).catch(() => {});
  await page.evaluate(() => window.__moon.setChrome(false));
  await page.evaluate((t) => window.__moon.setTimeMs(t), TIME_MS);
  await page.evaluate(() => window.__moon.setTimeRate(0));
  await page.waitForFunction(
    () => (window.__moon.atmoState()?.state === 'ready' ? window.__moon.atmoState() : null),
    { timeout: 45000 },
  ).catch(() => null);
  const wearing = await page.evaluate((t) => window.__moon.atmoTier(t), tier === 'lut' ? null : 'analytic');
  if (wearing?.Earth !== tier) throw new Error(`${tier}: shell is ${wearing?.Earth}`);
  return { context, page };
}

const POSES = night
  ? [
    // The ISS geometry past the terminator: 1.05 R, looking along the ground
    // toward the horizon, 150 degrees round from the sub-solar point.
    { name: 'night-oblique', pose: (p) => p.evaluate(() => window.__moon.limbView('Earth', 1.05, 60, 150, 0.72)) },
    // And the limb itself, where the airglow line lives.
    { name: 'night-limb', pose: (p) => p.evaluate(() => window.__moon.limbView('Earth', 1.05, 60, 150, 1)) },
  ]
  : [
    { name: 'arrival', pose: (p) => p.evaluate(() => window.__moon.jumpTo('Earth', 0.13)) },
    { name: 'oblique', pose: (p) => p.evaluate(() => window.__moon.limbView('Earth', 1.05, 60, 0, 0.72)) },
  ];

for (const tier of ['analytic', 'lut']) {
  const { context, page } = await session(tier);
  for (const { name, pose } of POSES) {
    await pose(page);
    await page.evaluate((t) => window.__moon.setTimeMs(t), TIME_MS);
    // Long enough for the arrival's texture ladder and the auto-exposure to
    // settle: a frame caught mid-climb is a different picture, not a tier.
    await page.waitForTimeout(4000);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await writeFile(path.join(out, `${name}.${tier}.png`), await page.screenshot());
    const moon = await page.evaluate(() => window.__moon.atmoNight?.('Earth') ?? null);
    console.log(`[shots] ${name}.${tier}`
      + (moon ? `  moon phase ${moon.phaseDeg?.toFixed(1)} deg, irradiance ${moon.moonIrradiance.map((v) => v.toFixed(4)).join('/')}` : ''));
  }
  await context.close();
}

/** Lay panels out with captions and shoot the result. */
async function board(cells, file, cols, scale = 1, note = '') {
  const context = await browser.newContext({ viewport: { width: 100, height: 100 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const figures = [];
  for (const c of cells) {
    const uri = `data:image/png;base64,${(await readFile(c.file)).toString('base64')}`;
    const crop = c.crop
      ? `<div class="crop" style="width:${c.crop.w * scale}px;height:${c.crop.h * scale}px">
           <img src="${uri}" style="margin-left:${-c.crop.x * scale}px;margin-top:${-c.crop.y * scale}px;width:${c.width * scale}px">
         </div>`
      : `<img src="${uri}">`;
    figures.push(
      `<figure${c.span ? ' class="span"' : ''}>${crop}<figcaption>${c.label}</figcaption></figure>`);
  }
  await page.setContent(`<style>
    body { margin:0; background:#0b0d10; font:600 15px/1.4 ui-sans-serif,system-ui,sans-serif; color:#c9d2dd; }
    .board { width:max-content; }
    .grid { display:grid; grid-template-columns:repeat(${cols},max-content); gap:14px; padding:14px; width:max-content; }
    figure { margin:0; }
    figure.span { grid-column:1 / -1; }
    img { display:block; max-width:900px; height:auto; }
    .crop { overflow:hidden; }
    figcaption { padding-top:6px; letter-spacing:.02em; }
    .note { padding:0 14px 14px; font-weight:400; color:#8b96a4; max-width:${cols * 900}px; }
  </style><div class="board"><div class="grid">${figures.join('')}</div>${
    note ? `<div class="note">${note}</div>` : ''}</div>`);
  const el = await page.$('.board');
  await writeFile(file, await el.screenshot());
  console.log(`[shots] ${file}`);
  await context.close();
}

const px = W * 2; // deviceScaleFactor 2
if (night) {
  await board([
    ...(photo ? [{
      file: photo,
      label: 'the photograph, unedited',
      width: px,
      span: true,
    }] : []),
    { file: path.join(out, 'night-oblique.analytic.png'), label: 'past the terminator, no tables', width: px },
    { file: path.join(out, 'night-oblique.lut.png'), label: 'past the terminator, airglow + moonlight', width: px },
    { file: path.join(out, 'night-limb.analytic.png'), label: 'the night limb, no tables', width: px },
    { file: path.join(out, 'night-limb.lut.png'), label: 'the night limb, airglow + moonlight', width: px },
  ], path.join(out, 'iss-vs-app-night.png'), 2, 1,
  'City lights here are the 2K night map on its own shell — this branch has no '
  + 'streamed night tiles. The Moon is full and stands over the middle of the '
  + 'night hemisphere; the analytic panels are the same frame with no tables, '
  + 'which is what the weakest hardware draws.');
  // What the app's night side is drawn from, so the board is not read as more
  // than it is: this branch has no night TILES, and the city lights in these
  // frames are the 2K night map on its own shell.
  console.log('[shots] night board: city lights are the 2K night map, not the streamed night tiles');
  await browser.close();
  process.exit(0);
}
await board([
  { file: path.join(out, 'arrival.analytic.png'), label: 'arrival range, no aerial perspective', width: px },
  { file: path.join(out, 'arrival.lut.png'), label: 'arrival range, hazed', width: px },
  { file: path.join(out, 'oblique.analytic.png'), label: '1.05 R toward the horizon, no aerial perspective', width: px },
  { file: path.join(out, 'oblique.lut.png'), label: '1.05 R toward the horizon, hazed', width: px },
], path.join(out, 'iss-vs-app-day.png'), 2);

// The far ground meeting the limb, at 2x: the band the whole commit is about.
const cropW = 440;
const cropH = 330;
const cropX = px - cropW - 120;
const cropY = H * 2 / 2 - cropH / 2;
await board([
  { file: path.join(out, 'oblique.analytic.png'), label: 'the far ground, no aerial perspective', width: px, crop: { x: cropX, y: cropY, w: cropW, h: cropH } },
  { file: path.join(out, 'oblique.lut.png'), label: 'the far ground, hazed', width: px, crop: { x: cropX, y: cropY, w: cropW, h: cropH } },
], path.join(out, 'horizon-haze.png'), 2, 2);

await browser.close();
