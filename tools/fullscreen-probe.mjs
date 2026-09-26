// Full-screen probe: do the ☰ Full screen row and the F key do what
// src/app/fullscreen.ts says, through the browser's own input pipeline, in
// every mode that takes keys?
//
//   node tools/fullscreen-probe.mjs --url=http://localhost:5174
//   node tools/fullscreen-probe.mjs --scenario=desktop,phone
//   node tools/fullscreen-probe.mjs --software               # SwiftShader
//
// Scenarios:
//   desktop      the row enters and leaves and reads On/Off; Escape is locked
//                on the way in and given back on the way out; two presses in
//                one turn are one change; F and Shift+F toggle and the closed
//                menu's row follows; a held F is one change; an exit the app
//                did not ask for (the browser's) is followed by the row and
//                the lock; Ctrl+F and Alt+F stay the browser's; with the deck
//                open, F types into its search; a refused request says so in
//                a toast and leaves the row Off; F works while landed. The
//                row names F with a key chip and aria-keyshortcuts. The menu
//                is captured Off and On.
//   tools        F enters and leaves in Look inside and in How many fit?.
//   unavailable  where document.fullscreenEnabled is false there is no row and
//                F does nothing.
//   phone        at 390×844 on a touch canvas the row is there without its key
//                chip, a tap enters, and the panel still fits the screen;
//                captured Off and On.
//   box          the canvas is the fixed-position rect (index.html
//                canvas.scene-canvas) and the renderer follows the canvas's
//                OWN box (app/viewportSize.ts): its rect is the viewport and
//                the drawing buffer its size, and a change to that box alone —
//                a style that halves it, with no resize event at all, which is
//                what an iPad's full-screen transition amounted to — re-sizes
//                the renderer and the cameras, and the box's return restores
//                them; at a desktop window and at 390×844.
//   safearea     the page covers the screen (viewport-fit=cover) and the
//                chrome keeps out of the bars: with the safe-area insets
//                emulated through CDP (Emulation.setSafeAreaInsetsOverride —
//                a phone's status bar and home indicator upright, a notch on
//                both sides on its side) the canvas and the overlay stay on
//                the whole viewport while the action cluster, the bottom bar,
//                the wordmark and the corner chart move in by the bars, at
//                boot and again through a rotation; captured with the insets
//                on. Read on `?debug=1` with `__moon.viewport()`.
//
// What no Playwright run can show: its Chromium takes a page full screen
// without resizing the window, and its key presses reach the page without
// passing the browser's own Escape handling. So this proves the calls, the
// state the app reads back, the lock requests, the key routing and the layout
// — not what a real Escape press does in a real browser.
//
// PASS: every assertion holds. GPU flags as every battery; takes
// /tmp/moon-browser.lock. Captures land in /tmp/moon-shots/<label>/.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { takeBrowserLock } from './browserLock.mjs';

const arg = (k, d) => { const m = process.argv.find((a) => a.startsWith(`--${k}=`)); return m ? m.slice(k.length + 3) : d; };
const URL = arg('url', 'http://localhost:5174');
const LABEL = arg('label', 'fullscreen');
const SCENARIOS = new Set(arg('scenario', 'desktop,tools,unavailable,phone,box,safearea').split(','));
const SOFTWARE = process.argv.includes('--software');
const OUT = `/tmp/moon-shots/${LABEL}`;
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GPU_ARGS = SOFTWARE
  ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
  : ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'];

const failures = [];
const check = (ok, what, detail) => {
  console.log(`${ok ? '  ok ' : ' FAIL'} ${what}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  if (!ok) failures.push(what);
};

const release = await takeBrowserLock('fullscreen');
// A pinned-browser environment names its Chromium here (the shoot.mjs idiom).
const browser = await chromium.launch({ headless: true, args: GPU_ARGS, executablePath: process.env.PW_CHROMIUM || undefined });
try {
  /** A fresh context: storage cleared, first-run help marked seen, and every
   *  Keyboard Lock call recorded. `unavailable` makes the browser say no. */
  const fresh = async (viewport, { touch = false, unavailable = false } = {}) => {
    const context = await browser.newContext({
      viewport: { width: viewport.w, height: viewport.h }, deviceScaleFactor: viewport.dsf ?? 1,
      hasTouch: touch, isMobile: touch,
    });
    await context.addInitScript((opts) => {
      try {
        localStorage.clear(); sessionStorage.clear(); indexedDB.deleteDatabase('orbital-sim-storage');
        localStorage.setItem('planetarium-help-seen', '1'); localStorage.setItem('planetarium-surface-hint-seen', '1');
      } catch {}
      window.__fsLog = [];
      const keyboard = navigator.keyboard;
      if (keyboard) {
        const lock = keyboard.lock.bind(keyboard);
        const unlock = keyboard.unlock.bind(keyboard);
        keyboard.lock = (codes) => { window.__fsLog.push(`lock:${JSON.stringify(codes)}`); return lock(codes); };
        keyboard.unlock = () => { window.__fsLog.push('unlock'); return unlock(); };
      }
      if (opts.unavailable) Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false });
    }, { unavailable });
    return context;
  };

  const boot = async (context, query = '?auto=planetarium') => {
    const page = await context.newPage();
    page.on('pageerror', (e) => { console.log('[pageerror]', e.message); failures.push(`pageerror: ${e.message}`); });
    await page.goto(`${URL}/${query}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__moon?.ready?.(), null, { timeout: 180_000 });
    await page.waitForFunction(() => {
      const s = document.getElementById('loading-screen');
      return !s || s.classList.contains('hidden') || getComputedStyle(s).display === 'none';
    }, null, { timeout: 180_000 });
    await sleep(1500);
    return page;
  };

  /** What the page and the row say, and the lock calls since the last read. */
  const state = (page) => page.evaluate(() => {
    const toggle = document.getElementById('settings-fullscreen-toggle');
    const row = toggle?.closest('.settings-row');
    const chip = row?.querySelector('.settings-label .kbd');
    return {
      fullscreen: document.fullscreenElement === document.documentElement,
      label: document.getElementById('settings-fullscreen-label')?.textContent ?? null,
      pressed: toggle?.getAttribute('aria-pressed') ?? null,
      rowShown: !!row && !row.hidden && getComputedStyle(row).display !== 'none',
      // The chip's own display: the touch rule hides the chip, not the row.
      chip: chip ? { text: chip.textContent, shown: getComputedStyle(chip).display !== 'none' } : null,
      keys: toggle?.getAttribute('aria-keyshortcuts') ?? null,
      log: window.__fsLog.splice(0),
    };
  });
  // A request's promise settles in a task, but fullscreenchange is dispatched
  // in the next rendering update, before that update's animation-frame
  // callbacks — and under SwiftShader a frame of this app is slower than any
  // fixed sleep. So a settle waits for two frames, after which the event (and
  // everything listening to it) has run.
  const settle = async (page, ms = 150) => {
    await sleep(ms);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  };
  const menuOpen = (page) => page.evaluate(() => document.getElementById('planetarium-menu-panel').classList.contains('visible'));
  const openMenu = async (page) => {
    if (!(await menuOpen(page))) await page.click('#planetarium-btn-menu');
    await settle(page, 300);
  };
  const closeMenu = async (page) => {
    if (await menuOpen(page)) await page.click('#planetarium-btn-menu');
    await settle(page, 300);
  };
  const DESKTOP = { w: 1400, h: 900, dsf: 1 };
  const PHONE = { w: 390, h: 844, dsf: 3 };

  // ── desktop ─────────────────────────────────────────────────────────────
  if (SCENARIOS.has('desktop')) {
    console.log('[desktop]');
    const context = await fresh(DESKTOP);
    const page = await boot(context);
    await openMenu(page);
    let s = await state(page);
    check(s.rowShown && s.label === 'Off' && s.pressed === 'false' && !s.fullscreen, 'row shown, Off, not full screen', s);
    check(s.chip?.text === 'F' && s.chip.shown && s.keys === 'F',
      'the row names F with a key chip, and to a screen reader', { chip: s.chip, keys: s.keys });
    await page.locator('#planetarium-menu-panel').screenshot({ path: `${OUT}/desktop-menu-off.png` });

    await page.click('#settings-fullscreen-toggle');
    await settle(page);
    s = await state(page);
    check(s.fullscreen && s.label === 'On' && s.pressed === 'true', 'a click enters full screen and the row reads On', s);
    check(s.log.includes('lock:["Escape"]'), 'Escape is locked on the way in', s.log);
    check(await menuOpen(page), 'the menu stays open, as for every other row');
    await page.locator('#planetarium-menu-panel').screenshot({ path: `${OUT}/desktop-menu-on.png` });

    await page.click('#settings-fullscreen-toggle');
    await settle(page);
    s = await state(page);
    check(!s.fullscreen && s.label === 'Off' && s.pressed === 'false', 'a second click leaves and the row reads Off', s);
    check(s.log.includes('unlock'), 'Escape is given back on the way out', s.log);

    // Two clicks in one turn: the second lands while the first is answered.
    await page.evaluate(() => { const b = document.getElementById('settings-fullscreen-toggle'); b.click(); b.click(); });
    await settle(page);
    s = await state(page);
    check(s.fullscreen && s.label === 'On', 'a press mid-request is dropped, not a flap', s);
    await page.click('#settings-fullscreen-toggle');
    await settle(page);
    await state(page);

    await closeMenu(page);
    await page.keyboard.press('f');
    await settle(page);
    s = await state(page);
    check(s.fullscreen && s.label === 'On', 'F enters, and the closed menu\'s row follows', s);
    await page.keyboard.press('F'); // Shift, or Caps Lock
    await settle(page);
    s = await state(page);
    check(!s.fullscreen && s.label === 'Off', 'Shift+F leaves', s);

    // A held F: the first press acts, the repeats do not.
    await page.keyboard.down('f');
    await page.keyboard.down('f');
    await page.keyboard.down('f');
    await page.keyboard.up('f');
    await settle(page);
    s = await state(page);
    check(s.fullscreen, 'a held F is one change, not a flap', s);

    // The browser ending it — a held Escape, its own controls, a tab switch —
    // never passes through the app; the row and the lock follow anyway.
    await page.evaluate(() => document.exitFullscreen());
    await settle(page);
    s = await state(page);
    check(!s.fullscreen && s.label === 'Off' && s.log.includes('unlock'), 'an exit the app did not ask for is followed', s);

    for (const chord of ['Control+f', 'Alt+f']) {
      await page.keyboard.press(chord);
      await settle(page, 250);
      s = await state(page);
      check(!s.fullscreen, `${chord} is left to the browser`, s);
    }

    // The deck: an F is the first letter of a search. Out of the field first,
    // so the press takes the deck's own branch (which moves focus into the
    // search) rather than the typed-into-a-field guard.
    await page.keyboard.press('t');
    await settle(page, 500);
    const deckOpen = await page.evaluate(() => document.getElementById('deck')?.classList.contains('visible') ?? false);
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press('f');
    await settle(page);
    const query = await page.evaluate(() => document.getElementById('deck-search')?.value ?? null);
    s = await state(page);
    check(deckOpen && query === 'f' && !s.fullscreen, 'with the deck open, F types into its search', { deckOpen, query, fullscreen: s.fullscreen });
    await page.keyboard.press('Escape');
    await settle(page, 400);

    // Refused: the row cannot say why on its own, so the toast does.
    await page.evaluate(() => {
      window.__realRequest = Element.prototype.requestFullscreen;
      Element.prototype.requestFullscreen = () => Promise.reject(new TypeError('Permissions check failed'));
    });
    await openMenu(page);
    await page.click('#settings-fullscreen-toggle');
    await settle(page, 500);
    const toast = await page.evaluate(() => {
      const n = document.getElementById('planetarium-notification');
      return { text: n?.textContent ?? null, visible: n?.classList.contains('visible') ?? false };
    });
    s = await state(page);
    check(toast.visible && /didn’t allow full screen/.test(toast.text ?? '') && s.label === 'Off', 'a refusal is said out loud and the row stays Off', { toast, label: s.label });
    await page.evaluate(() => { Element.prototype.requestFullscreen = window.__realRequest; });
    await closeMenu(page);

    const landed = await page.evaluate(() => window.__moon.land('Moon'));
    await sleep(4000);
    await page.keyboard.press('f');
    await settle(page);
    s = await state(page);
    check(landed && s.fullscreen, 'F works while landed', { landed, fullscreen: s.fullscreen });
    await context.close();
  }

  // ── Look inside and How many fit? ───────────────────────────────────────
  if (SCENARIOS.has('tools')) {
    console.log('[tools]');
    // Each tool attaches its keydown handler in the same step that shows its
    // UI, so waiting for both proves the press reaches the tool's handler.
    const tools = [
      ['Look inside', '?auto=interior&body=Earth', 'interior-ui', () => window.__moon.interiorReady()],
      ['How many fit?', '?auto=volumeCompare', 'volume-compare-ui', () => window.__moon.compareState()?.texturesReady === true],
    ];
    for (const [name, query, uiId, ready] of tools) {
      const context = await fresh(DESKTOP);
      const page = await boot(context, query);
      await page.waitForFunction(ready, null, { timeout: 180_000 });
      await page.waitForFunction((id) => document.getElementById(id)?.style.display === 'block', uiId, { timeout: 60_000 });
      await page.keyboard.press('f');
      await settle(page);
      let s = await state(page);
      check(s.fullscreen && s.log.includes('lock:["Escape"]'), `${name}: F enters, Escape locked`, s);
      await page.keyboard.press('f');
      await settle(page);
      s = await state(page);
      check(!s.fullscreen && s.log.includes('unlock'), `${name}: F leaves, Escape given back`, s);
      await context.close();
    }
  }

  // ── a browser that says no ──────────────────────────────────────────────
  if (SCENARIOS.has('unavailable')) {
    console.log('[unavailable]');
    const context = await fresh(DESKTOP, { unavailable: true });
    const page = await boot(context);
    await openMenu(page);
    let s = await state(page);
    check(!s.rowShown, 'no row where full screen cannot work', s);
    await closeMenu(page);
    await page.keyboard.press('f');
    await settle(page);
    s = await state(page);
    check(!s.fullscreen, 'F does nothing there', s);
    await context.close();
  }

  // ── phone ───────────────────────────────────────────────────────────────
  if (SCENARIOS.has('phone')) {
    console.log('[phone]');
    const context = await fresh(PHONE, { touch: true });
    const page = await boot(context);
    await page.tap('#planetarium-btn-menu');
    await settle(page, 400);
    let s = await state(page);
    check(s.rowShown && s.label === 'Off', 'phone: the row is there', s);
    check(s.chip !== null && !s.chip.shown, 'phone: no key chip on a touch screen', s.chip);
    await page.screenshot({ path: `${OUT}/phone-menu-off.png` });
    await page.tap('#settings-fullscreen-toggle');
    await settle(page);
    s = await state(page);
    check(s.fullscreen && s.label === 'On', 'phone: a tap enters full screen', s);
    await page.screenshot({ path: `${OUT}/phone-menu-on.png` });
    const panel = await page.evaluate(() => {
      const r = document.getElementById('planetarium-menu-panel').getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    });
    check(panel.bottom <= PHONE.h, 'phone: the panel still fits the screen', panel);
    await context.close();
  }

  /** The viewport as the app sees it beside the rects the chrome lands on. */
  const geometry = (page) => page.evaluate(() => {
    const rect = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) };
    };
    return {
      viewport: window.__moon.viewport(),
      canvasPosition: getComputedStyle(document.querySelector('canvas.scene-canvas')).position,
      overlay: rect('#ui-overlay'),
      actions: rect('#planetarium-actions'),
      bar: rect('#planetarium-bottom-bar'),
      wordmark: rect('#top-bar h1'),
      chart: rect('#mini-chart'),
      resizes: window.__resizeEvents ?? null,
    };
  });
  const sameBox = (a, b) => a && b && a.width === b.width && a.height === b.height;
  /** The drawing buffer the renderer sizes for a box: floor(css × ratio) on each axis, as three does. */
  const bufferFor = (box, ratio) => ({ width: Math.floor(box.width * ratio), height: Math.floor(box.height * ratio) });

  // ── box ─────────────────────────────────────────────────────────────────
  if (SCENARIOS.has('box')) {
    console.log('[box]');
    for (const [label, viewport, touch] of [['desktop', DESKTOP, false], ['phone', PHONE, true]]) {
      const context = await fresh(viewport, { touch });
      const page = await boot(context);
      let g = await geometry(page);
      check(g.canvasPosition === 'fixed', `box ${label}: the canvas is position: fixed`, g.canvasPosition);
      check(g.viewport.canvas.left === 0 && g.viewport.canvas.top === 0
        && g.viewport.canvas.width === viewport.w && g.viewport.canvas.height === viewport.h,
      `box ${label}: the canvas's rect is the viewport`, g.viewport.canvas);
      check(sameBox(g.viewport.applied, g.viewport.canvas) && sameBox(g.viewport.drawingBuffer, bufferFor(g.viewport.canvas, g.viewport.pixelRatio)),
        `box ${label}: the renderer and its drawing buffer are sized to the canvas's box`, g.viewport);
      check(g.overlay.width === viewport.w && g.overlay.height === viewport.h, `box ${label}: the overlay is the whole viewport`, g.overlay);
      // The box alone moves: no resize event, no viewport change.
      await page.evaluate(() => { window.__resizeEvents = 0; window.addEventListener('resize', () => { window.__resizeEvents++; }); });
      await page.addStyleTag({ content: 'canvas.scene-canvas { height: 50% !important; }' });
      await settle(page, 300);
      g = await geometry(page);
      const half = Math.round(viewport.h / 2);
      check(g.viewport.canvas.height === half && g.viewport.applied.height === half
        && g.viewport.drawingBuffer.height === bufferFor(g.viewport.canvas, g.viewport.pixelRatio).height,
      `box ${label}: a box halved by style alone re-sizes the renderer, with no resize event`, { viewport: g.viewport, resizes: g.resizes });
      check(g.resizes === 0, `box ${label}: no resize event was fired for it`, g.resizes);
      await page.evaluate(() => { for (const style of document.querySelectorAll('style')) if (style.textContent.includes('canvas.scene-canvas { height: 50% !important; }')) style.remove(); });
      await settle(page, 300);
      g = await geometry(page);
      check(g.viewport.canvas.height === viewport.h && g.viewport.applied.height === viewport.h
        && sameBox(g.viewport.drawingBuffer, bufferFor(g.viewport.canvas, g.viewport.pixelRatio)),
      `box ${label}: the box's return restores the renderer`, g.viewport);
      await context.close();
    }
  }

  // ── safearea ────────────────────────────────────────────────────────────
  if (SCENARIOS.has('safearea')) {
    console.log('[safearea]');
    const UPRIGHT = { top: 47, right: 0, bottom: 34, left: 0 };
    const ON_ITS_SIDE = { top: 0, right: 47, bottom: 21, left: 47 };
    const LANDSCAPE = { w: PHONE.h, h: PHONE.w };
    /** The chrome against the bars: every offset carries the inset, the canvas none of it. */
    const checkInsets = async (page, label, viewport, insets) => {
      const g = await geometry(page);
      const read = g.viewport.safeArea;
      check(read.top === insets.top && read.right === insets.right && read.bottom === insets.bottom && read.left === insets.left,
        `safearea ${label}: the app reads the bars the browser laid it out under`, read);
      check(g.viewport.canvas.left === 0 && g.viewport.canvas.top === 0 && g.viewport.canvas.width === viewport.w && g.viewport.canvas.height === viewport.h,
        `safearea ${label}: the canvas covers the whole screen, bars included`, g.viewport.canvas);
      check(g.overlay.left === 0 && g.overlay.top === 0 && g.overlay.width === viewport.w && g.overlay.height === viewport.h,
        `safearea ${label}: the overlay is not inset (projected labels sit on it)`, g.overlay);
      check(g.actions.top === 14 + insets.top && g.actions.right === viewport.w - 14 - insets.right,
        `safearea ${label}: the action cluster keeps out of the top and right bars`, g.actions);
      const barLift = viewport.w <= 640 ? 8 : 12;
      check(g.bar.bottom === viewport.h - barLift - insets.bottom, `safearea ${label}: the bottom bar keeps out of the bottom bar`, g.bar);
      const wordmarkLeft = viewport.w <= 640 ? 10 : 16;
      check(g.wordmark.left === wordmarkLeft + insets.left, `safearea ${label}: the wordmark keeps out of the left bar`, g.wordmark);
      check(g.chart && g.chart.top === 56 + insets.top && g.chart.left === (viewport.w <= 380 ? 8 : viewport.w <= 640 ? 10 : 14) + insets.left,
        `safearea ${label}: the corner chart keeps out of the top and left bars`, g.chart);
      return g;
    };
    for (const [label, viewport, touch, insets] of [
      ['phone', PHONE, true, UPRIGHT], ['landscape', LANDSCAPE, true, ON_ITS_SIDE], ['desktop', DESKTOP, false, ON_ITS_SIDE],
    ]) {
      const context = await fresh(viewport, { touch });
      // The bars are there from the first layout, as on a phone that boots on its side.
      const page = await context.newPage();
      page.on('pageerror', (e) => { console.log('[pageerror]', e.message); failures.push(`pageerror: ${e.message}`); });
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets });
      await page.goto(`${URL}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__moon?.ready?.(), null, { timeout: 180_000 });
      await page.waitForFunction(() => {
        const s = document.getElementById('loading-screen');
        return !s || s.classList.contains('hidden') || getComputedStyle(s).display === 'none';
      }, null, { timeout: 180_000 });
      await sleep(1500);
      await page.evaluate(() => window.__moon.setMiniChart(true));
      await settle(page, 600);
      await checkInsets(page, label, viewport, insets);
      await page.screenshot({ path: `${OUT}/safearea-${label}.png` });
      if (label === 'phone') {
        // Turned on its side: the notch moves to the sides, the home indicator
        // shrinks, and the chrome follows through the resize.
        await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: ON_ITS_SIDE });
        await page.setViewportSize({ width: LANDSCAPE.w, height: LANDSCAPE.h });
        await settle(page, 800);
        await checkInsets(page, 'phone turned', LANDSCAPE, ON_ITS_SIDE);
        await page.screenshot({ path: `${OUT}/safearea-phone-turned.png` });
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
  release();
}

console.log(failures.length ? `\nFAIL (${failures.length}): ${failures.join('; ')}` : '\nPASS');
process.exit(failures.length ? 1 : 0);
