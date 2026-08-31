// F1 repro: does a climbing colour rung draw partially filled?
//
// Drives a MANUAL approach (no travelTo, no veil) with __moon.frame(), which
// only poses the camera, and records every compositor frame through the CDP
// screencast so the frames between "rung assigned" and "slice finished" are
// actually on disk. Then reads its own PNGs back and flags the ones with a
// hard horizontal edge across the body's disc — the band boundary of a
// half-filled upload.
//
// node tools/f1-wipe-probe.mjs --url=http://localhost:5688 --label=f1-repro
import { chromium } from 'playwright';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { decodePng } from './pngDecode.mjs';

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

const url = arg('url', 'http://localhost:5688');
const tiles = arg('tiles', 'http://localhost:5622/');
const label = arg('label', 'f1-repro');
const outDir = arg('out', path.join('/tmp/moon-shots', label));
const body = arg('body', 'Moon');
const fill = Number(arg('fill', '0.30'));
const settleMs = Number(arg('settle', '6000'));
const captureMs = Number(arg('capture', '9000'));
const W = Number(arg('w', '1280'));
const H = Number(arg('h', '720'));

// Re-read a run's own PNGs instead of capturing: the detector can be retuned
// without spending another GPU browser run.
const analyzeOnly = process.argv.includes('--analyze');
if (!analyzeOnly) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
}

const frames = [];
if (analyzeOnly) {
  const { readdir } = await import('node:fs/promises');
  const names = (await readdir(outDir)).filter((f) => f.endsWith('.png')).sort();
  const saved = JSON.parse(await readFile(path.join(outDir, 'report.json'), 'utf8'));
  const stamps = new Map((saved.report ?? saved).map((x) => [x.name, x.t]));
  for (const nm of names) frames.push({ t: stamps.get(nm) ?? 0, data: (await readFile(path.join(outDir, nm))).toString('base64') });
  console.log(`[f1] analyze-only: ${frames.length} saved frames`);
}

const browser = analyzeOnly ? null : await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});

try {
  if (!browser) throw { skip: true };
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
      indexedDB.deleteDatabase('orbital-sim-storage');
      localStorage.setItem('planetarium-help-seen', '1');
      localStorage.setItem('planetarium-surface-hint-seen', '1');
    } catch { /* storage blocked */ }
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const target = `${url}/?auto=planetarium&tiles=${encodeURIComponent(tiles)}`;
  console.log(`[f1] ${target} -> ${outDir}`);
  await page.goto(target, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 60000 });
  await page.waitForFunction(() => {
    const ls = document.getElementById('loading-screen');
    return !ls || ls.classList.contains('hidden');
  }, { timeout: 60000 }).catch(() => {});
  await page.evaluate(() => window.__moon.setChrome(false));

  // Let the boot-idle pair warm finish so the climb we capture is the one the
  // approach earns, not the speculative one.
  await page.waitForTimeout(settleMs);
  const before = await page.evaluate(() => window.__moon.ladder());
  console.log('[f1] ladder before approach:', JSON.stringify(before?.rungs ?? []));

  // Page-side ladder log, one sample a frame, wall-clock stamped so it lines
  // up with the screencast frame timestamps.
  await page.evaluate(() => {
    window.__f1log = [];
    const tick = () => {
      const l = window.__moon.ladder();
      const moon = (l?.rungs ?? []).filter((r) => r.key === 'moon' || r.key === 'earthDay');
      window.__f1log.push({ t: Date.now(), rungs: moon });
      window.__f1raf = requestAnimationFrame(tick);
    };
    tick();
  });

  const cdp = await context.newCDPSession(page);
  cdp.on('Page.screencastFrame', async (ev) => {
    frames.push({ t: ev.metadata.timestamp * 1000, data: ev.data });
    try { await cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }); } catch { /* closed */ }
  });
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });

  // The manual approach: pose the camera at the body across the trigger
  // fraction. frame() only poses — no travelTo, so no arrival veil.
  const t0 = Date.now();
  await page.evaluate(([n, f]) => window.__moon.frame(n, f), [body, fill]);
  await page.waitForTimeout(captureMs);
  await cdp.send('Page.stopScreencast');

  const log = await page.evaluate(() => { cancelAnimationFrame(window.__f1raf); return window.__f1log; });
  const after = await page.evaluate(() => window.__moon.ladder());
  console.log('[f1] ladder after approach:', JSON.stringify(after?.rungs ?? []));
  await writeFile(path.join(outDir, 'ladder.json'), JSON.stringify({ before, after, log, t0 }, null, 2));
  if (errors.length) console.log('[f1] page errors:', errors.slice(0, 5));
} catch (e) {
  if (!e || e.skip !== true) throw e;
} finally {
  await browser?.close();
}

console.log(`[f1] ${frames.length} screencast frames`);

// --- write + analyse --------------------------------------------------------
// The body is posed at screen centre, so the centre box is its surface. A map
// whose storage is allocated but not yet filled draws there as the driver
// decodes unwritten blocks — magenta on ANGLE/Metal, black elsewhere — so the
// two tells are a magenta cast (R and B far above G) and a luminance far under
// the run's own median.
const report = [];
for (let i = 0; i < frames.length; i++) {
  const buf = Buffer.from(frames[i].data, 'base64');
  const name = `frame-${String(i).padStart(3, '0')}.png`;
  if (!analyzeOnly) await writeFile(path.join(outDir, name), buf);
  let png;
  try { png = decodePng(buf); } catch (e) { report.push({ name, err: String(e) }); continue; }
  const { width, height, channels, pixels } = png;
  const half = Math.round(Math.min(width, height) * 0.05);
  const cx = Math.round(width / 2);
  const cy = Math.round(height / 2);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = cy - half; y <= cy + half; y++) {
    for (let x = cx - half; x <= cx + half; x++) {
      const o = (y * width + x) * channels;
      r += pixels[o]; g += pixels[o + 1]; b += pixels[o + 2]; n++;
    }
  }
  r /= n; g /= n; b /= n;
  report.push({
    name, t: frames[i].t,
    r: +r.toFixed(1), g: +g.toFixed(1), b: +b.toFixed(1),
    lum: +(0.299 * r + 0.587 * g + 0.114 * b).toFixed(1),
    magenta: +(Math.min(r, b) - g).toFixed(1),
  });
}
// Only the frames from the pose onward are the approach; the ones before it
// are whatever the boot view happened to be pointing at.
const poseAtMs = JSON.parse(await readFile(path.join(outDir, 'ladder.json'), 'utf8')).t0 ?? 0;
const lums = report.filter((x) => x.lum !== undefined).map((x) => x.lum).sort((a, b) => a - b);
const median = lums.length ? lums[Math.floor(lums.length / 2)] : 0;
// The bug is a GOOD picture being replaced by an unfilled map, so a frame
// counts only once the pose has actually produced a good one — otherwise the
// first frames, still showing wherever the boot view pointed, read as dark.
let sawGood = false;
for (const x of report) {
  if (x.lum === undefined) continue;
  x.unfilled = sawGood && (x.magenta > 25 || x.lum < median * 0.4);
  if (x.t >= poseAtMs && x.lum > median * 0.7 && x.magenta < 25) sawGood = true;
}
await writeFile(path.join(outDir, 'report.json'), JSON.stringify({ median, report }, null, 2));

const bad = report.filter((x) => x.unfilled);
console.log(`[f1] centre-box median luminance ${median}`);
for (const x of report) {
  if (x.lum === undefined) continue;
  if (!x.unfilled && !report.some((y) => y.unfilled && Math.abs(report.indexOf(y) - report.indexOf(x)) <= 2)) continue;
  console.log(`  ${x.name} rgb=${x.r}/${x.g}/${x.b} lum=${x.lum} magenta=${x.magenta}${x.unfilled ? '  <== UNFILLED MAP DRAWN' : ''}`);
}
console.log(`[f1] frames drawing an unfilled map: ${bad.length ? bad.map((x) => x.name).join(', ') : 'NONE'}`);
