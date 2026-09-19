// Mini-size probe: is the corner chart resizable, and is it still a chart at
// every size? Drives the real app through the dev bridge and the browser's
// own input pipeline — a mouse drag on the grip, a two-finger pinch on the
// chart, a tap, the ☰ row — and reads back what the mode says it did.
//
//   node tools/mini-size-probe.mjs --url=http://localhost:5174
//   node tools/mini-size-probe.mjs --scenario=look            # captures only
//   node tools/mini-size-probe.mjs --scenario=drag,row,tap,pinch,persist
//   node tools/mini-size-probe.mjs --software                 # SwiftShader
//
// Scenarios:
//   look     every detent and the ceiling at a desktop canvas and at 390×844,
//            the chart cropped at 2× and the whole frame at Medium and at the
//            ceiling — the pictures a look is judged from. Asserts the rect
//            stays inside the canvas and under the hard caps, keeps its
//            shape, and the marks grow only above the default.
//   drag     a real mouse drag on the grip grows the chart under the pointer,
//            holds the target reserve for the length of the gesture and
//            releases it after, commits and saves on release; Escape mid-drag
//            puts the size back and saves nothing; a double-click on the grip
//            resets to Medium.
//   row      the ☰ row steps Small → Medium → Large and reads its label.
//   tap      a click on the chart opens the full map, which stands the chart
//            down; Escape brings it back.
//   pinch    on a touch canvas two fingers spreading on the chart grow it and
//            never open the map; a single tap still does.
//   persist  a committed size survives a save and a reload (the resume path).
//
// PASS: every assertion holds. GPU flags as every battery; takes
// /tmp/moon-browser.lock. Captures land in /tmp/moon-shots/<label>/.
import { chromium } from 'playwright';
import { takeBrowserLock } from './browserLock.mjs';
import { mkdirSync } from 'node:fs';

const arg = (k, d) => { const m = process.argv.find((a) => a.startsWith(`--${k}=`)); return m ? m.slice(k.length + 3) : d; };
const URL = arg('url', 'http://localhost:5174');
const LABEL = arg('label', 'mini-size');
const SCENARIOS = new Set(arg('scenario', 'look,drag,row,tap,pinch,persist').split(','));
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

const release = await takeBrowserLock('mini-size');
// A pinned-browser environment names its Chromium here (the shoot.mjs idiom).
const browser = await chromium.launch({ headless: true, args: GPU_ARGS, executablePath: process.env.PW_CHROMIUM || undefined });
try {
  /** A page booted straight into the planetarium with the chart on. `keep`
   *  leaves storage alone (the reload leg of `persist`). */
  const boot = async (context, { chartOn = 'bridge' } = {}) => {
    const page = await context.newPage();
    page.on('pageerror', (e) => { console.log('[pageerror]', e.message); failures.push(`pageerror: ${e.message}`); });
    await page.goto(`${URL}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__moon?.ready?.(), null, { timeout: 120_000 });
    await page.waitForFunction(() => { const s = document.getElementById('loading-screen'); return !s || s.classList.contains('hidden') || getComputedStyle(s).display === 'none'; }, null, { timeout: 120_000 });
    await sleep(1500);
    if (chartOn === 'bridge') await page.evaluate(() => window.__moon.setMiniChart(true));
    // The ☰ toggle is the one writer of the persisted preference; a persist
    // leg turns the chart on through it so the save carries the chart.
    if (chartOn === 'toggle') await page.evaluate(() => document.getElementById('settings-mini-toggle').click());
    await draws(page, 3);
    return page;
  };
  const draws = (page, n = 2) => page.evaluate((k) => window.__moon.waitForDraw(k), n);
  const mini = (page) => page.evaluate(() => {
    const s = window.__moon.miniState();
    if (!s) return null;
    const box = document.getElementById('mini-chart-box');
    const b = box ? box.getBoundingClientRect() : null;
    return {
      open: s.open, rect: s.rect, draw: { w: s.draw.widthDevicePx, h: s.draw.heightDevicePx },
      sizeScale: s.sizeScale, sizePref: s.sizePref, sizeRange: s.sizeRange, sizeLabel: s.sizeLabel,
      presentationScale: s.presentationScale, marks: s.marks, targetAlloc: s.targetAlloc, targetReserve: s.targetReserve,
      surface: s.surface, box: b ? { left: b.left, top: b.top, width: b.width, height: b.height, display: getComputedStyle(box).display } : null,
      label: document.getElementById('settings-minisize-label')?.textContent ?? null,
      pressed: document.getElementById('settings-minisize-toggle')?.getAttribute('aria-pressed') ?? null,
    };
  });
  const gripCentre = (page) => page.evaluate(() => {
    const r = document.getElementById('mini-chart-grip').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const chartCentre = (page) => page.evaluate(() => {
    const r = document.getElementById('mini-chart').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const shotChart = async (page, file, pad = 24) => {
    const s = await mini(page);
    const clip = { x: Math.max(0, s.rect.left - pad), y: Math.max(0, s.rect.top - pad), width: s.rect.width + 2 * pad, height: s.rect.height + 2 * pad };
    await page.screenshot({ path: `${OUT}/${file}`, clip });
  };
  const fresh = (viewport, extra = {}) => browser.newContext({
    viewport: { width: viewport.w, height: viewport.h }, deviceScaleFactor: viewport.dsf ?? 1, ...extra,
  }).then(async (context) => {
    await context.addInitScript(() => {
      try {
        if (!localStorage.getItem('probe-keep')) {
          localStorage.clear(); sessionStorage.clear(); indexedDB.deleteDatabase('orbital-sim-storage');
        }
        localStorage.setItem('planetarium-help-seen', '1'); localStorage.setItem('planetarium-surface-hint-seen', '1');
      } catch {}
    });
    return context;
  });
  const DESKTOP = { w: 1400, h: 900, dsf: 1, name: 'desktop' };
  const PHONE = { w: 390, h: 844, dsf: 2, name: 'phone' };

  // ── look ────────────────────────────────────────────────────────────────
  if (SCENARIOS.has('look')) {
    console.log('[look]');
    for (const vp of [DESKTOP, PHONE]) {
      const context = await fresh(vp);
      const page = await boot(context);
      let lastWidth = 0;
      for (const [name, scale] of [['small', 0.75], ['medium', 1], ['large', 1.5], ['ceiling', 2.2]]) {
        await page.evaluate((s) => window.__moon.setMiniSize(s), scale);
        await draws(page, 3);
        const s = await mini(page);
        const inside = s.rect.left >= 0 && s.rect.top >= 0 && s.rect.left + s.rect.width <= vp.w && s.rect.top + s.rect.height <= vp.h;
        const capped = s.rect.width <= vp.w * 0.6 + 1 && s.rect.height <= vp.h * 0.4 + 1;
        const shape = Math.abs(s.rect.width / s.rect.height - 4 / 3) < 0.02;
        const boxMatches = s.box && Math.abs(s.box.width - s.rect.width) < 0.6 && Math.abs(s.box.height - s.rect.height) < 0.6
          && Math.abs(s.box.left - s.rect.left) < 0.6 && Math.abs(s.box.top - s.rect.top) < 0.6 && s.box.display === 'block';
        const grows = s.rect.width > lastWidth;
        const marks = scale <= 1 ? s.presentationScale === 1 : s.presentationScale > 1;
        check(s.open && inside && capped && shape && boxMatches && grows && marks, `${vp.name} ${name}`, {
          rect: s.rect, draw: s.draw, presentation: +s.presentationScale.toFixed(3), ship: +s.marks.shipPx.toFixed(1),
          minPx: +s.marks.body.minPx.toFixed(2), line: +s.marks.lineWidthScale.toFixed(2), label: s.sizeLabel, alloc: s.targetAlloc,
        });
        lastWidth = s.rect.width;
        // The label layer sits above the canvas the chart is drawn on: no
        // body label may be printed inside the chart's rectangle.
        const overChart = await page.evaluate((rect) => {
          const hits = [];
          for (const el of document.querySelectorAll('.planet-label, .moon-label')) {
            if (getComputedStyle(el).display === 'none') continue;
            const b = el.getBoundingClientRect();
            if (b.width === 0 || b.height === 0) continue;
            if (b.left < rect.left + rect.width && rect.left < b.right && b.top < rect.top + rect.height && rect.top < b.bottom) {
              hits.push(el.textContent.trim().slice(0, 24));
            }
          }
          return hits;
        }, s.rect);
        check(overChart.length === 0, `${vp.name} ${name}: no body label prints over the chart`, overChart);
        await shotChart(page, `${vp.name}-${name}-chart.png`);
        if (name === 'medium' || name === 'ceiling') await page.screenshot({ path: `${OUT}/${vp.name}-${name}-frame.png` });
      }
      await page.evaluate(() => window.__moon.setMiniSize(1));
      await context.close();
    }
  }

  // ── drag ────────────────────────────────────────────────────────────────
  if (SCENARIOS.has('drag')) {
    console.log('[drag]');
    const context = await fresh(DESKTOP);
    const page = await boot(context);
    const before = await mini(page);
    check(before.sizePref === null && before.surface.commits === 0, 'starts with no stored size', { pref: before.sizePref });
    // Hover shows the grip; take the picture people will see.
    let g = await gripCentre(page);
    await page.mouse.move(g.x - 40, g.y - 40);
    await draws(page, 2);
    await shotChart(page, 'desktop-hover-grip.png');
    await page.mouse.move(g.x, g.y);
    await page.mouse.down();
    let mid = null;
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(g.x + 12 * i, g.y + 9 * i);
      await draws(page, 1);
      if (i === 6) mid = await mini(page);
    }
    const live = await mini(page);
    await shotChart(page, 'desktop-mid-drag.png', 40);
    check(mid.surface.gesture === 'drag' && live.surface.gesture === 'drag', 'a drag is live while the button is down', mid.surface);
    check(live.rect.width > before.rect.width && live.rect.width >= mid.rect.width, 'the chart grows under the pointer', { from: before.rect.width, mid: mid.rect.width, to: live.rect.width });
    check(Math.abs(live.rect.width - (before.rect.width + 120)) <= 2, 'the corner tracks the pointer (120 px right = 120 px wider)', { width: live.rect.width, expected: before.rect.width + 120 });
    check(live.targetReserve !== null && live.targetAlloc && live.targetAlloc.widthDevicePx >= live.targetReserve.widthDevicePx && live.targetAlloc.widthDevicePx > live.draw.w, 'the target is reserved at the ceiling and drawn into a sub-rectangle', { reserve: live.targetReserve, alloc: live.targetAlloc, draw: live.draw });
    check(live.sizePref === null, 'nothing is saved mid-drag', { pref: live.sizePref });
    check(live.box && live.box.width === live.rect.width, 'the frame follows the rect', live.box);
    await page.mouse.up();
    await draws(page, 3);
    const after = await mini(page);
    check(after.surface.gesture === null && after.surface.commits === 1, 'release commits once', after.surface);
    check(after.sizePref !== null && Math.abs(after.sizePref - after.sizeScale) < 1e-9, 'the committed size is the stored one', { pref: after.sizePref, scale: after.sizeScale, label: after.sizeLabel });
    check(after.targetReserve === null && after.targetAlloc && after.targetAlloc.widthDevicePx === after.draw.w && after.targetAlloc.heightDevicePx === after.draw.h, 'the reserve is released and the target refits to what it draws', { alloc: after.targetAlloc, draw: after.draw });
    check(after.label === after.sizeLabel && (after.label === 'Custom' || after.label === 'Large'), 'the ☰ row reads the dragged size', { label: after.label, pressed: after.pressed });
    await shotChart(page, 'desktop-after-drag.png');

    // Escape mid-drag: back where it started, nothing new saved.
    g = await gripCentre(page);
    await page.mouse.move(g.x, g.y);
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) { await page.mouse.move(g.x - 10 * i, g.y - 8 * i); await draws(page, 1); }
    const moved = await mini(page);
    await page.keyboard.press('Escape');
    await draws(page, 2);
    const escaped = await mini(page);
    await page.mouse.up();
    await draws(page, 2);
    const released = await mini(page);
    check(moved.rect.width < after.rect.width, 'the second drag shrank it live', { from: after.rect.width, to: moved.rect.width });
    check(escaped.rect.width === after.rect.width && escaped.surface.gesture === null, 'Escape puts the size back and ends the drag', { width: escaped.rect.width });
    check(released.surface.commits === 1 && released.sizePref === after.sizePref, 'an escaped drag saves nothing', { commits: released.surface.commits, pref: released.sizePref });

    // Double-click the grip: Medium again, saved.
    g = await gripCentre(page);
    await page.mouse.dblclick(g.x, g.y);
    await draws(page, 3);
    const reset = await mini(page);
    check(reset.sizeScale === 1 && reset.sizePref === 1 && reset.sizeLabel === 'Medium' && reset.surface.gesture === null, 'a double-click on the grip resets to Medium', { scale: reset.sizeScale, pref: reset.sizePref });
    await context.close();
  }

  // ── row ─────────────────────────────────────────────────────────────────
  if (SCENARIOS.has('row')) {
    console.log('[row]');
    const context = await fresh(DESKTOP);
    const page = await boot(context);
    const click = () => page.evaluate(() => document.getElementById('settings-minisize-toggle').click());
    const seq = [];
    for (let i = 0; i < 4; i++) { await click(); await draws(page, 2); const s = await mini(page); seq.push({ scale: s.sizeScale, label: s.label, pressed: s.pressed, width: s.rect.width }); }
    check(seq.map((s) => s.label).join(' → ') === 'Large → Small → Medium → Large', 'the row cycles Large → Small → Medium → Large from Medium', seq);
    check(seq[0].pressed === 'true' && seq[2].pressed === 'false', 'highlighted off Medium only', seq.map((s) => s.pressed));
    const s = await mini(page);
    check(s.sizePref === 1.5, 'the row persists its pick', { pref: s.sizePref });
    await context.close();
  }

  // ── tap ─────────────────────────────────────────────────────────────────
  if (SCENARIOS.has('tap')) {
    console.log('[tap]');
    const context = await fresh(DESKTOP);
    const page = await boot(context);
    const c = await chartCentre(page);
    await page.mouse.click(c.x, c.y);
    await draws(page, 3);
    const opened = await mini(page);
    const mapOpen = await page.evaluate(() => window.__moon.mapState()?.open === true);
    check(!opened.open && mapOpen, 'a click on the chart opens the full map and stands the chart down', { chartOpen: opened.open, mapOpen });
    // The Esc cascade folds the map's panel first and closes the map second,
    // and the close flies for most of a second: press until the chart is back.
    let back = null;
    for (let i = 0; i < 4 && !(back && back.open); i++) {
      await page.keyboard.press('Escape');
      await sleep(1200);
      await draws(page, 2);
      back = await mini(page);
    }
    check(back && back.open, 'Escape closes the map and the chart returns', { chartOpen: back?.open });
    // A press that wanders is not a tap.
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x + 30, c.y + 10, { steps: 4 });
    await page.mouse.up();
    await draws(page, 3);
    const wandered = await mini(page);
    check(wandered.open, 'a press that travels past the slop opens nothing', { chartOpen: wandered.open });
    await context.close();
  }

  // ── pinch ───────────────────────────────────────────────────────────────
  if (SCENARIOS.has('pinch')) {
    console.log('[pinch]');
    const context = await fresh(PHONE, { hasTouch: true, isMobile: true });
    const page = await boot(context);
    const cdp = await context.newCDPSession(page);
    const before = await mini(page);
    await shotChart(page, 'phone-medium-touch.png');
    const c = await chartCentre(page);
    const points = (spread) => [{ x: c.x - spread, y: c.y, id: 0 }, { x: c.x + spread, y: c.y, id: 1 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(20) });
    await draws(page, 1);
    let mid = null;
    for (let i = 1; i <= 8; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(20 + 6 * i) });
      await draws(page, 1);
      if (i === 4) mid = await mini(page);
    }
    const live = await mini(page);
    await shotChart(page, 'phone-mid-pinch.png', 40);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await draws(page, 3);
    const after = await mini(page);
    check(mid.surface.gesture === 'pinch' && live.surface.gesture === 'pinch', 'two fingers on the chart are a pinch', mid.surface);
    check(live.rect.width > before.rect.width, 'spreading them grows the chart', { from: before.rect.width, to: live.rect.width });
    check(Math.abs(live.rect.width - Math.round(before.rect.width * (68 / 20))) <= 2 || live.rect.width === before.sizeRange.maxWidthPx, 'the chart scales with the finger distance, or stops at the ceiling', { width: live.rect.width, ceiling: before.sizeRange.maxWidthPx });
    check(after.open && after.surface.gesture === null && after.surface.commits === 1 && after.sizePref !== null, 'lifting commits, saves, and never opens the map', { open: after.open, commits: after.surface.commits, pref: after.sizePref });
    check(live.targetReserve !== null && after.targetReserve === null, 'the target reserve is held through the pinch and released after', { live: live.targetReserve, after: after.targetReserve });
    await shotChart(page, 'phone-after-pinch.png');
    await page.screenshot({ path: `${OUT}/phone-after-pinch-frame.png` });
    // One finger is still a tap.
    const c2 = await chartCentre(page);
    await page.touchscreen.tap(c2.x, c2.y);
    await draws(page, 3);
    const tapped = await mini(page);
    check(!tapped.open, 'a single tap opens the map', { chartOpen: tapped.open });
    await context.close();
  }

  // ── persist ─────────────────────────────────────────────────────────────
  if (SCENARIOS.has('persist')) {
    console.log('[persist]');
    const context = await fresh(DESKTOP);
    const page = await boot(context, { chartOn: 'toggle' });
    await page.evaluate(() => document.getElementById('settings-minisize-toggle').click());
    await draws(page, 2);
    const picked = await mini(page);
    const saved = await page.evaluate(() => {
      window.dispatchEvent(new Event('pagehide'));
      const raw = localStorage.getItem('orbital-sim-planetarium-state');
      return raw ? JSON.parse(raw) : null;
    });
    check(saved && saved.miniChartSizePref === picked.sizePref && saved.miniChartPref === true, 'the save carries the size and the chart', { pref: saved?.miniChartSizePref, chart: saved?.miniChartPref });
    await page.evaluate(() => localStorage.setItem('probe-keep', '1'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__moon?.ready?.(), null, { timeout: 120_000 });
    // The returning journey's prompt: resume it.
    await page.waitForFunction(() => {
      const s = document.getElementById('loading-screen');
      return !s || s.classList.contains('hidden') || getComputedStyle(s).display === 'none';
    }, null, { timeout: 120_000 });
    await sleep(1000);
    const resumeIds = await page.evaluate(() => [...document.querySelectorAll('#planetarium-resume-prompt button')].map((b) => ({ id: b.id, text: b.textContent.trim(), shown: getComputedStyle(b).display !== 'none' && !!b.offsetParent })));
    const resume = resumeIds.find((b) => /resume|continue|welcome/i.test(b.text) || /resume/i.test(b.id));
    if (resume) await page.evaluate((id) => document.getElementById(id).click(), resume.id);
    await sleep(2000);
    await draws(page, 3);
    const restored = await mini(page);
    check(restored && restored.open && restored.sizeScale === picked.sizePref && restored.sizePref === picked.sizePref && restored.label === 'Large', 'a reload restores the chart at its saved size', { prompt: resumeIds, restored: restored && { open: restored.open, scale: restored.sizeScale, pref: restored.sizePref, label: restored.label } });
    await context.close();
  }
} finally {
  await browser.close();
  release();
}

if (failures.length) {
  console.log(`\nFAIL (${failures.length}): ${failures.join('; ')}`);
  process.exit(1);
}
console.log(`\nPASS — captures in ${OUT}`);
