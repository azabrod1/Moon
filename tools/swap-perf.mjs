// Time the Observatory vantage swap (Stand on Moon <-> Stand on Earth) to
// settled, per engine. WebKit here is the local Safari oracle.
//
//   node tools/swap-perf.mjs --engine=webkit --n=6
//   node tools/swap-perf.mjs --engine=chromium --n=6
//
// Per swap, an in-page rAF recorder captures frame timestamps and the
// arrival-veil transitions; reported: time to veil-down, time until frames
// smooth (10 consecutive gaps < 30 ms), worst frame gap, count of gaps > 50 ms.
import { chromium, webkit } from 'playwright';

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
const engineName = arg('engine', 'webkit');
const url = arg('url', 'http://localhost:5174');
const N = Number(arg('n', '6'));
const DPR = Number(arg('dpr', '1'));
const SURFACE = process.argv.includes('--surface');

const browser = engineName === 'webkit'
  ? await webkit.launch({ headless: true })
  : await chromium.launch({
      headless: true,
      args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
    });
console.log(`[swap-perf] engine: ${engineName}`);
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: DPR });
  await context.addInitScript(() => {
    try {
      localStorage.clear(); sessionStorage.clear();
      indexedDB.deleteDatabase('orbital-sim-storage');
      localStorage.setItem('planetarium-help-seen', '1');
      localStorage.setItem('planetarium-surface-hint-seen', '1');
    } catch {}
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });

  await page.goto(`${url}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 60000 });
  await page.waitForFunction(() => {
    const ls = document.getElementById('loading-screen');
    return !ls || ls.classList.contains('hidden');
  }, { timeout: 60000 }).catch(() => {});

  await page.evaluate(() => { window.__moon.land('Earth'); });
  await page.waitForTimeout(5000);
  if (SURFACE) {
    await page.evaluate(() => { window.__moon.lookUp(); });
    await page.waitForTimeout(3000);
  }

  const swapTimed = () => page.evaluate(() => new Promise((resolve) => {
    const veil = document.getElementById('arrival-veil');
    const t0 = performance.now();
    const gaps = [];
    let last = t0;
    let veilSeenUp = false;
    let veilDownAt = null;
    let smoothAt = null;
    let smoothRun = 0;
    window.__moon.swapVantage();
    const tick = (now) => {
      const gap = now - last;
      last = now;
      gaps.push(gap);
      const covering = veil ? veil.classList.contains('covering') : false;
      if (covering) veilSeenUp = true;
      if (veilSeenUp && !covering && veilDownAt === null) veilDownAt = now - t0;
      if (gap < 30) { smoothRun++; } else { smoothRun = 0; smoothAt = null; }
      // Smooth counts only after the veil has fallen (or 1s in, for no-veil swaps).
      if (smoothRun >= 10 && smoothAt === null && (veilDownAt !== null || now - t0 > 1000)) {
        smoothAt = now - t0;
      }
      if ((smoothAt !== null && now - t0 > 1500) || now - t0 > 12000) {
        const sorted = [...gaps].sort((a, b) => b - a);
        resolve({
          landed: window.__moon.probeLanded()?.landedOn?.name,
          veilDown: veilDownAt === null ? null : Math.round(veilDownAt),
          smooth: smoothAt === null ? null : Math.round(smoothAt),
          maxGap: Math.round(sorted[0]),
          top3: sorted.slice(0, 3).map((g) => Math.round(g)),
          over50: gaps.filter((g) => g > 50).length,
          frames: gaps.length,
        });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));

  for (let i = 1; i <= N; i++) {
    const r = await swapTimed();
    console.log(
      ` swap ${i}: -> ${String(r.landed).padEnd(6)} veilDown=${String(r.veilDown).padStart(5)}ms ` +
      `smooth=${String(r.smooth).padStart(5)}ms maxGap=${String(r.maxGap).padStart(5)}ms ` +
      `top3=[${r.top3.join(', ')}] over50=${r.over50}`,
    );
    await page.waitForTimeout(1200);
  }
  if (errors.length) console.log('[errors]', errors.slice(0, 6));
} finally {
  await browser.close();
}
