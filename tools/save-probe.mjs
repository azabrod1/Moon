// Save probe: does a save write the journey the user left — never a scene
// something else staged over it, and with the clock and the ship the way the
// user left them rather than the way a menu holds them?
//
//   node tools/save-probe.mjs --url=http://localhost:5174
//   node tools/save-probe.mjs --scenario=mission,menu
//
// Scenarios:
//   mission   a historic mission (Voyager 1, from the Tools popover) stages its
//             own scene, 1977 and the launch; the ☰ Save made during it writes
//             the journey the mission took over — its clock within a minute of
//             a save made just before the mission, its position within 0.01 AU
//             — not the mission's scene; and Exit still puts that journey back.
//   menu      opening ☰ pauses a running clock and stops a moving ship while
//             it is up; Save from inside it stores the clock running and the
//             ship moving, as the user left them. The control: a clock the
//             user paused (Space) before opening ☰ is stored paused. The help
//             sheet holds both the same way, and a save made under it (the
//             page-hide save, fired by hand) stores them running too.
//
// The save is read back from localStorage (PlanetariumStore's key). Boots
// with storage cleared and the first-run help marked seen, so no modal holds
// the clock. PASS: every assertion holds. GPU flags as every battery; takes
// /tmp/moon-browser.lock.
import { chromium } from 'playwright';
import { takeBrowserLock } from './browserLock.mjs';

const arg = (k, d) => { const m = process.argv.find((a) => a.startsWith(`--${k}=`)); return m ? m.slice(k.length + 3) : d; };
const URL = arg('url', 'http://localhost:5174');
const SCENARIOS = new Set(arg('scenario', 'mission,menu').split(','));
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

  // ── menu ────────────────────────────────────────────────────────────────
  if (SCENARIOS.has('menu')) {
    console.log('[menu]');
    const { context, page } = await boot();
    const t0 = await page.evaluate(() => window.__moon.getTimeMs());
    await sleep(1200);
    const t1 = await page.evaluate(() => window.__moon.getTimeMs());
    check(t1 > t0, 'menu: the clock is running before ☰ opens', { t0: iso(t0), t1: iso(t1) });
    const saved = await saveFromMenu(page);
    check(saved.astroTimePaused === false, 'menu: Save from ☰ stores the clock running, as the user left it', { astroTimePaused: saved.astroTimePaused });
    check(saved.moving === true, 'menu: and the ship moving', { moving: saved.moving });
    const t2 = await page.evaluate(() => window.__moon.getTimeMs());
    await sleep(1200);
    const t3 = await page.evaluate(() => window.__moon.getTimeMs());
    check(t3 > t2, 'menu: closing ☰ resumes the clock', { t2: iso(t2), t3: iso(t3) });
    // The control: the user's own pause is kept.
    await page.keyboard.press('Space');
    await sleep(400);
    const paused = await saveFromMenu(page);
    check(paused.astroTimePaused === true, 'menu: a clock the user paused first is stored paused', { astroTimePaused: paused.astroTimePaused });
    // The help sheet: running again, then ☰ → Help, and the page-hide save.
    await page.keyboard.press('Space');
    await sleep(400);
    await page.click('#planetarium-btn-menu');
    await sleep(300);
    await page.click('#planetarium-btn-help');
    await sleep(500);
    const help = await page.evaluate((key) => {
      localStorage.removeItem(key);
      const open = document.getElementById('planetarium-help')?.classList.contains('visible') ?? null;
      window.dispatchEvent(new Event('pagehide'));
      return { open, saved: JSON.parse(localStorage.getItem(key) ?? 'null') };
    }, SAVE_KEY);
    check(help.open === true && help.saved?.astroTimePaused === false && help.saved?.moving === true,
      'menu: a save under the help sheet stores the clock running and the ship moving',
      { helpOpen: help.open, astroTimePaused: help.saved?.astroTimePaused, moving: help.saved?.moving });
    await context.close();
  }
} finally {
  await browser.close();
  release();
}

console.log(failures.length ? `\nFAIL (${failures.length}): ${failures.join('; ')}` : '\nPASS');
process.exit(failures.length ? 1 : 0);
