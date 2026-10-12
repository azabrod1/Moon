// Tool-open failure probe: what does the planetarium say when a switch into a
// tool fails, and does it tell a chunk that did not arrive from a fault
// inside the tool (src/app/modeSwitchFailure.ts)?
//
//   node tools/tool-open-failure-probe.mjs --url=http://localhost:5174
//
// Scenarios:
//   chunk    the Look-inside chunk request answers 404 (a tab older than the
//            site, after a deploy): the toast names the tool, says the tab may
//            be stale, carries a Reload button, takes pointers, and the
//            planetarium is still up and clickable behind it. The button is
//            pressed and the page reloads.
//   fault    the chunk arrives but InteriorMode.activate throws: the toast
//            says the tool hit a problem, blames nothing on the connection and
//            carries no button; the planetarium is back.
//
// Captured in /tmp/moon-shots/tool-open-failure/. Takes /tmp/moon-browser.lock.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { takeBrowserLock } from './browserLock.mjs';

const arg = (k, d) => { const m = process.argv.find((a) => a.startsWith(`--${k}=`)); return m ? m.slice(k.length + 3) : d; };
const URL = arg('url', 'http://localhost:5174');
const OUT = '/tmp/moon-shots/tool-open-failure';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GPU_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

const failures = [];
const check = (ok, what, detail) => {
  console.log(`${ok ? '  ok ' : ' FAIL'} ${what}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  if (!ok) failures.push(what);
};

const release = await takeBrowserLock('tool-open-failure');
const browser = await chromium.launch({ headless: true, args: GPU_ARGS, executablePath: process.env.PW_CHROMIUM || undefined });
try {
  const boot = async (context) => {
    const page = await context.newPage();
    page.on('console', (m) => { if (/Mode switch failed/.test(m.text())) console.log('  [console]', m.text().slice(0, 160)); });
    await page.goto(`${URL}/?auto=planetarium&debug=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__moon?.ready?.(), null, { timeout: 180_000 });
    await page.waitForFunction(() => {
      const s = document.getElementById('loading-screen');
      return !s || s.classList.contains('hidden') || getComputedStyle(s).display === 'none';
    }, null, { timeout: 180_000 });
    await sleep(1500);
    return page;
  };
  const fresh = async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => {
      try {
        localStorage.clear(); sessionStorage.clear();
        localStorage.setItem('planetarium-help-seen', '1'); localStorage.setItem('planetarium-surface-hint-seen', '1');
      } catch {}
    });
    return context;
  };
  const toast = (page) => page.evaluate(() => {
    const el = document.getElementById('planetarium-notification');
    const button = el?.querySelector('button');
    return {
      visible: el?.classList.contains('visible') ?? false,
      text: el?.textContent ?? null,
      hasAction: el?.classList.contains('has-action') ?? false,
      button: button?.textContent ?? null,
      pointer: el ? getComputedStyle(el).pointerEvents : null,
      planetariumUp: document.getElementById('planetarium-ui')?.style.display !== 'none',
    };
  });
  // Interval polling, not the default animation-frame polling: under a
  // software GPU the frames come seconds apart, and the banner's hold is
  // measured from show(), not from the frame that first painted it.
  const waitForToast = (page) => page.waitForFunction(
    () => document.getElementById('planetarium-notification')?.classList.contains('visible'), null, { timeout: 30_000, polling: 50 },
  );

  // ── chunk: the Look-inside chunk answers 404 ────────────────────────────
  {
    const context = await fresh();
    await context.route(/\/src\/interior\/InteriorMode\.ts/, (route) => route.fulfill({ status: 404, body: 'gone' }));
    const page = await boot(context);
    const opened = await page.evaluate(() => window.__moon.interiorOpen('Earth'));
    console.log('  interiorOpen accepted:', opened);
    await waitForToast(page);
    const shownAt = Date.now();
    const t = await toast(page);
    check(t.visible && /^Look inside could not be downloaded/.test(t.text ?? '') && /older than the site/.test(t.text ?? ''),
      'chunk: the toast names the tool and the stale-tab cause', t.text);
    check(t.hasAction && t.button === 'Reload' && t.pointer === 'auto', 'chunk: a Reload button that takes the tap', { hasAction: t.hasAction, button: t.button, pointer: t.pointer });
    check(t.planetariumUp, 'chunk: the planetarium is still up behind it');
    // The press comes before any capture: the banner holds 12 s from show(),
    // and a software GPU draws a capture slowly. The site is "redeployed"
    // first (the chunk answers again), which is the stale tab's story: the
    // reload fetches a fresh index, and the tool opens.
    await context.unroute(/\/src\/interior\/InteriorMode\.ts/);
    const navigated = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).then(() => true, () => false);
    await page.click('#planetarium-notification .notification-action', { timeout: 10_000 });
    check(await navigated, 'chunk: Reload reloads the page', `pressed ${Date.now() - shownAt} ms after the banner showed`);
    await page.waitForFunction(() => window.__moon?.ready?.(), null, { timeout: 180_000, polling: 100 });
    await sleep(1500);
    await page.evaluate(() => window.__moon.interiorOpen('Earth'));
    const openedAfterReload = await page.waitForFunction(() => window.__moon.interiorReady(), null, { timeout: 120_000, polling: 100 }).then(() => true, () => false);
    check(openedAfterReload, 'chunk: after the reload, Look inside opens');
    await context.close();
  }

  // ── phone: the same banner at 390×844 ────────────────────────────────────
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    await context.addInitScript(() => {
      try {
        localStorage.clear(); sessionStorage.clear();
        localStorage.setItem('planetarium-help-seen', '1'); localStorage.setItem('planetarium-surface-hint-seen', '1');
      } catch {}
    });
    await context.route(/\/src\/interior\/InteriorMode\.ts/, (route) => route.fulfill({ status: 404, body: 'gone' }));
    const page = await boot(context);
    await page.evaluate(() => window.__moon.interiorOpen('Earth'));
    await waitForToast(page);
    const fits = await page.evaluate(() => {
      const r = document.getElementById('planetarium-notification').getBoundingClientRect();
      const b = document.querySelector('#planetarium-notification .notification-action').getBoundingClientRect();
      return { left: r.left, right: r.right, width: innerWidth, button: { w: b.width, h: b.height } };
    });
    check(fits.left >= 8 && fits.right <= fits.width - 8 && fits.button.h >= 20, 'phone: the banner fits the screen with its button', fits);
    await page.screenshot({ path: `${OUT}/chunk-toast-phone.png` });
    await context.close();
  }

  // ── fault: the chunk arrives, activate throws ───────────────────────────
  {
    const context = await fresh();
    const page = await boot(context);
    // Arm the throw inside the tool: InteriorMode reads the top bar on
    // activate; a getter that throws there is a fault in the app's own code.
    await page.evaluate(() => {
      const topBar = document.getElementById('top-bar');
      Object.defineProperty(topBar.style, 'display', { get() { throw new Error('probe: a fault inside the tool'); }, set() {} });
    });
    const opened = await page.evaluate(() => window.__moon.interiorOpen('Earth'));
    console.log('  interiorOpen accepted:', opened);
    await waitForToast(page);
    await sleep(600);
    const t = await toast(page);
    await page.screenshot({ path: `${OUT}/fault-toast.png` });
    check(t.visible && /^Look inside hit a problem/.test(t.text ?? '') && !/connection dropped|Reload/.test(t.text ?? ''),
      'fault: the toast blames the app, not the connection', t.text);
    check(!t.hasAction && t.button === null && t.pointer === 'none', 'fault: no button, and the banner takes no pointers', { hasAction: t.hasAction, pointer: t.pointer });
    check(t.planetariumUp, 'fault: the planetarium is back');
    await context.close();
  }
} finally {
  await browser.close();
  release();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nPASS');
process.exit(failures.length ? 1 : 0);
