// Probe the Observatory event-jump-while-in-surface-view FOV fit. Lands on
// Earth, enters surface view, then jumps prev/next through each event kind and
// records the resulting entry FOV + subject fill. Used to check whether the
// jump path shares the swap's stale-position FOV bug (and to verify the fix).
//
//   node tools/jump-probe.mjs            # default localhost:5181
import { chromium } from 'playwright';

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

const url = arg('url', 'http://localhost:5181');
const timeIso = arg('time', '2026-06-17T00:00:00Z');
const W = Number(arg('w', '1600'));
const H = Number(arg('h', '900'));
const useGpu = !process.argv.includes('--software');

const browser = await chromium.launch({
  headless: true,
  args: useGpu
    ? ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader']
    : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
console.log(`[jump] renderer: ${useGpu ? 'GPU (ANGLE/Metal)' : 'software (SwiftShader)'}`);

const fmt = (label, p) =>
  `${label.padEnd(22)} fov=${p.fov.toFixed(3).padStart(8)} subj∅=${p.subjectAngularDeg.toFixed(4).padStart(9)}° ` +
  `fill=${(p.subjectFillFraction * 100).toFixed(3).padStart(8)}%  [${p.subjectName}]`;

try {
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

  await page.goto(`${url}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 45000 });
  await page.waitForFunction(() => {
    const ls = document.getElementById('loading-screen');
    return !ls || ls.classList.contains('hidden');
  }, { timeout: 45000 }).catch(() => {});

  const ms = Date.parse(timeIso);
  const settle = async (msWait) => {
    await page.waitForTimeout(msWait);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  };
  const probe = () => page.evaluate(() => window.__moon.probeLanded());

  // Re-seed time before each jump so prev/next searches from a fixed origin.
  const reseed = async () => {
    if (!Number.isNaN(ms)) await page.evaluate((t) => window.__moon.setTimeMs(t), ms);
    await settle(500);
  };

  await reseed();
  await page.evaluate(() => window.__moon.land('Earth'));
  await settle(400);
  await page.evaluate(() => window.__moon.lookUp());
  await settle(1100);
  console.log(fmt('baseline (Look up)', await probe()));

  for (const type of ['lunar-eclipse', 'solar-eclipse', 'full-moon', 'new-moon']) {
    await reseed();
    // Re-enter surface view fresh each time (reseed via setTimeMs doesn't leave it),
    // matching the "jump while already looking up" scenario.
    const ok = await page.evaluate((t) => window.__moon.jumpEvent(t, 1), type);
    await settle(900);
    console.log(fmt(`jump → ${type}`, await probe()) + (ok ? '' : '  (jump returned false)'));
  }

  if (errors.length) {
    console.log(`\n[jump] page errors (${errors.length}):`);
    for (const e of errors.slice(0, 10)) console.log('    ', e);
  }
} finally {
  await browser.close();
}
