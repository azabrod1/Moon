// Save probe: does a save write the journey the user left — never a scene
// something else staged over it?
//
//   node tools/save-probe.mjs --url=http://localhost:5174
//   node tools/save-probe.mjs --scenario=mission
//
// Scenarios:
//   mission   a historic mission (Voyager 1, from the Tools popover) stages its
//             own scene, 1977 and the launch; the ☰ Save made during it writes
//             the journey the mission took over — its clock within a minute of
//             a save made just before the mission, its position within 0.01 AU
//             — not the mission's scene; and Exit still puts that journey back.
//
// The save is read back from localStorage (PlanetariumStore's key). Boots
// with storage cleared and the first-run help marked seen, so no modal holds
// the clock. PASS: every assertion holds. GPU flags as every battery; takes
// /tmp/moon-browser.lock.
import { chromium } from 'playwright';
import { takeBrowserLock } from './browserLock.mjs';

const arg = (k, d) => { const m = process.argv.find((a) => a.startsWith(`--${k}=`)); return m ? m.slice(k.length + 3) : d; };
const URL = arg('url', 'http://localhost:5174');
const SCENARIOS = new Set(arg('scenario', 'mission').split(','));
const SOFTWARE = process.argv.includes('--software');
const GPU_ARGS = SOFTWARE
  ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
  : ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'];
const SAVE_KEY = 'orbital-sim-planetarium-state';
const DAY_MS = 86_400_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (ok, what, detail) => {
  console.log(`${ok ? '  ok ' : ' FAIL'} ${what}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  if (!ok) failures.push(what);
};
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 19) : String(ms));
const auApart = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

const release = await takeBrowserLock('save');
const browser = await chromium.launch({ headless: true, args: GPU_ARGS, executablePath: process.env.PW_CHROMIUM || undefined });
try {
  const boot = async () => {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
    await context.addInitScript(() => {
      // Once per context: a reload inside a scenario must keep what it saved.
      if (sessionStorage.getItem('save-probe-cleared')) return;
      try {
        localStorage.clear(); indexedDB.deleteDatabase('orbital-sim-storage');
        localStorage.setItem('planetarium-help-seen', '1'); localStorage.setItem('planetarium-surface-hint-seen', '1');
        sessionStorage.setItem('save-probe-cleared', '1');
      } catch {}
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => { console.log('[pageerror]', e.message); failures.push(`pageerror: ${e.message}`); });
    await page.goto(`${URL}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__moon?.ready?.(), null, { timeout: 180_000 });
    await page.waitForFunction(() => {
      const s = document.getElementById('loading-screen');
      return !s || s.classList.contains('hidden') || getComputedStyle(s).display === 'none';
    }, null, { timeout: 180_000 });
    await sleep(1500);
    return { context, page };
  };
  const menuOpen = (page) => page.evaluate(() => document.getElementById('planetarium-menu-panel').classList.contains('visible'));
  /** ☰, Save, read the save back, and ☰ again to close. */
  const saveFromMenu = async (page) => {
    await page.evaluate((key) => localStorage.removeItem(key), SAVE_KEY);
    if (!(await menuOpen(page))) await page.click('#planetarium-btn-menu');
    await sleep(300);
    await page.click('#planetarium-btn-save');
    await page.waitForFunction((key) => localStorage.getItem(key) !== null, SAVE_KEY, { timeout: 10_000 });
    const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), SAVE_KEY);
    await page.click('#planetarium-btn-menu');
    await sleep(300);
    return saved;
  };

  // ── mission ─────────────────────────────────────────────────────────────
  if (SCENARIOS.has('mission')) {
    console.log('[mission]');
    const { context, page } = await boot();
    const before = await saveFromMenu(page);
    await page.click('#planetarium-btn-tools');
    await sleep(300);
    await page.click('.tools-parent');
    await sleep(200);
    await page.click('.tools-subitem >> nth=0');
    // The mission owns the scene once its controls lock and its clock reads its own year.
    await page.waitForFunction(() => document.getElementById('planetarium-btn-map')?.disabled === true
      && window.__moon.getTimeMs() < Date.UTC(1990, 0, 1), null, { timeout: 120_000 });
    await sleep(2000);
    const missionNow = await page.evaluate(() => window.__moon.getTimeMs());
    const during = await saveFromMenu(page);
    const stillMission = await page.evaluate(() => document.getElementById('planetarium-btn-map')?.disabled === true);
    const detail = {
      beforeTime: iso(before.astroTimeUtcMs), missionTime: iso(missionNow), savedTime: iso(during.astroTimeUtcMs),
      savedAuFromBefore: auApart(during.positionAU, before.positionAU),
    };
    check(stillMission, 'mission: the save was made with the mission still running', { stillMission });
    check(Math.abs(during.astroTimeUtcMs - before.astroTimeUtcMs) < 60_000 && Math.abs(during.astroTimeUtcMs - missionNow) > 365 * DAY_MS,
      'mission: a save during the mission keeps the journey\'s clock, not the mission\'s', detail);
    check(detail.savedAuFromBefore < 0.01, 'mission: and the journey\'s position', detail);
    // Exit puts the journey back, as it did before saves served the stash.
    await page.click('#historic-exit');
    await page.waitForFunction(() => document.getElementById('planetarium-btn-map')?.disabled === false, null, { timeout: 60_000 });
    await sleep(1500);
    const afterExit = await page.evaluate(() => window.__moon.getTimeMs());
    check(Math.abs(afterExit - before.astroTimeUtcMs) < 10 * 60_000, 'mission: Exit restores the journey\'s clock', { afterExit: iso(afterExit), before: iso(before.astroTimeUtcMs) });
    await context.close();
  }

} finally {
  await browser.close();
  release();
}

console.log(failures.length ? `\nFAIL (${failures.length}): ${failures.join('; ')}` : '\nPASS');
process.exit(failures.length ? 1 : 0);
