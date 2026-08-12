// SCRATCH (throwaway): A/B the "boot -> land on the Moon -> Observatory ->
// surface view" flow through the DEV `window.__moon` bridge.
//
//   node tools/perf-obs-flow.mjs --a=http://localhost:5174 --b=http://localhost:5175 --pairs=3
//
// Interleaves the two dev servers run-by-run so machine noise hits both alike.
// Every step is timed twice: the synchronous cost of the bridge call itself,
// and the wall time until the step's settled signal (veil down / panel filled /
// surface view live). Network requests and console errors are attributed to
// whichever step was in flight.
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

function arg(name, def) {
  const hit = process.argv.find((x) => x.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
const A = arg('a', 'http://localhost:5174');
const B = arg('b', 'http://localhost:5175');
const pairs = Number(arg('pairs', '3'));
const out = arg('out', '/tmp/moon-perf/obs-flow.json');

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

async function flow(url) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  });
  await context.addInitScript(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
      indexedDB.deleteDatabase('orbital-sim-storage');
      localStorage.setItem('planetarium-help-seen', '1');
      localStorage.setItem('planetarium-surface-hint-seen', '1');
    } catch { /* blocked */ }
    window.__perf = { longTasks: [] };
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__perf.longTasks.push({ start: e.startTime, dur: e.duration });
      }).observe({ type: 'longtask', buffered: true });
    } catch { /* unsupported */ }
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });

  // Only asset traffic matters here — dev-server module requests are noise.
  let phase = 'boot';
  const net = { boot: [], land: [], observatory: [], lookup: [], tail: [] };
  page.on('response', async (res) => {
    const u = res.url();
    if (!/\.(jpg|jpeg|png|webp|ktx2|bin|glb)(\?|$)/.test(u)) return;
    let len = Number(res.headers()['content-length'] || 0);
    net[phase].push({ url: u.replace(/^https?:\/\/[^/]+\//, ''), bytes: len });
  });

  const t = {};
  const t0 = Date.now();
  await page.goto(`${url}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon?.ready?.()), { timeout: 240000 });
  await page.waitForFunction(() => {
    const ls = document.getElementById('loading-screen');
    return !ls || ls.classList.contains('hidden');
  }, { timeout: 240000 }).catch(() => {});
  t.boot = Date.now() - t0;
  // Let the post-entry texture drain quiet down so the landing measures the
  // landing, not the tail of boot.
  await page.waitForTimeout(6000);
  phase = 'land';

  // ---- step 1: land on the Moon -------------------------------------------
  const landCall = await page.evaluate(() => {
    const s = performance.now();
    const ok = window.__moon.land('Moon');
    return { sync: Math.round(performance.now() - s), ok };
  });
  t.landSync = landCall.sync;
  t.landOk = landCall.ok;
  const landStart = Date.now();
  await page.waitForFunction(() => {
    const p = window.__moon.probeLanded();
    if (!p || p.landedOn?.name !== 'Moon') return false;
    const veil = document.getElementById('arrival-veil');
    return !(veil && veil.classList.contains('covering'));
  }, { timeout: 120000 }).catch(() => {});
  t.landSettled = Date.now() - landStart;
  // Wait for the landed system's texture traffic to stop before the next step.
  t.landQuiet = await page.evaluate(() => new Promise((resolve) => {
    const s = performance.now();
    let idle = 0;
    const tick = () => {
      idle += 1;
      if (idle >= 45) resolve(Math.round(performance.now() - s));
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
  phase = 'observatory';

  // ---- step 2: open the Observatory ---------------------------------------
  const obsCall = await page.evaluate(() => {
    const s = performance.now();
    const ok = window.__moon.openObservatory();
    return { sync: Math.round(performance.now() - s), ok };
  });
  t.obsSync = obsCall.sync;
  t.obsOk = obsCall.ok;
  const obsStart = Date.now();
  await page.waitForFunction(() => {
    const p = document.getElementById('observatory-panel');
    return !!p && p.classList.contains('visible');
  }, { timeout: 60000 }).catch(() => {});
  t.obsVisible = Date.now() - obsStart;
  // "Populated" = the chunked shadow-event search has stopped changing the
  // list, held stable across 20 consecutive frames.
  t.obsPopulated = await page.evaluate(() => new Promise((resolve) => {
    const s = performance.now();
    const read = () => {
      const list = document.getElementById('observatory-events-list');
      const status = document.getElementById('observatory-events-status');
      const hero = document.getElementById('observatory-hero');
      return `${status?.textContent}|${list?.children.length}|${list?.textContent?.length}|${hero?.textContent?.length}`;
    };
    let last = read();
    let stable = 0;
    const tick = () => {
      const now = read();
      if (now === last) stable += 1; else { stable = 0; last = now; }
      if (stable >= 20 || performance.now() - s > 30000) resolve(Math.round(performance.now() - s));
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
  t.obsSnapshot = await page.evaluate(() => ({
    status: document.getElementById('observatory-events-status')?.textContent?.trim().slice(0, 60),
    rows: document.getElementById('observatory-events-list')?.children.length ?? -1,
    phase: document.getElementById('observatory-phase-name')?.textContent?.trim().slice(0, 40),
  }));
  phase = 'lookup';

  // ---- step 3: look up (surface view) -------------------------------------
  const lookCall = await page.evaluate(() => {
    const s = performance.now();
    const ok = window.__moon.lookUp();
    return { sync: Math.round(performance.now() - s), ok };
  });
  t.lookSync = lookCall.sync;
  t.lookOk = lookCall.ok;
  const lookStart = Date.now();
  await page.waitForFunction(() => window.__moon.probeLanded()?.view === 'surface', { timeout: 60000 })
    .catch(() => {});
  t.lookSettled = Date.now() - lookStart;
  // Surface HUD painted + the view's own texture traffic quiet.
  t.lookQuiet = await page.evaluate(() => new Promise((resolve) => {
    const s = performance.now();
    let idle = 0;
    const tick = () => {
      idle += 1;
      if (idle >= 45) resolve(Math.round(performance.now() - s));
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
  phase = 'tail';
  await page.waitForTimeout(1500);

  const lt = await page.evaluate(() => window.__perf.longTasks);
  await context.close();
  const sum = (arr) => arr.reduce((s, r) => s + r.bytes, 0);
  return {
    ...t,
    net: Object.fromEntries(Object.entries(net).map(([k, v]) => [k, { n: v.length, kb: Math.round(sum(v) / 1024) }])),
    netDetail: { land: net.land, observatory: net.observatory, lookup: net.lookup },
    errors: errors.slice(0, 5),
    longTasksAfterBoot: lt.filter((x) => x.start > 1000).length,
  };
}

const rows = { a: [], b: [] };
for (let i = 0; i < pairs; i++) {
  for (const which of (i % 2 === 0 ? ['a', 'b'] : ['b', 'a'])) {
    const r = await flow(which === 'a' ? A : B);
    rows[which].push(r);
    console.log(`[${which}] ${i + 1}/${pairs} boot=${r.boot} land(sync=${r.landSync} settled=${r.landSettled}) ` +
      `obs(sync=${r.obsSync} visible=${r.obsVisible} populated=${r.obsPopulated}) ` +
      `look(sync=${r.lookSync} settled=${r.lookSettled}) ` +
      `net land=${r.net.land.n}/${r.net.land.kb}KB obs=${r.net.observatory.n}/${r.net.observatory.kb}KB ` +
      `look=${r.net.lookup.n}/${r.net.lookup.kb}KB` + (r.errors.length ? ` ERR:${r.errors[0]}` : ''));
  }
}
await browser.close();
await writeFile(out, JSON.stringify(rows, null, 2));

const stat = (arr, get) => {
  const v = arr.map(get).filter((x) => x != null).sort((x, y) => x - y);
  return v.length ? `${v[Math.floor(v.length / 2)]} [${v[0]}..${v[v.length - 1]}]` : 'n/a';
};
const keys = [
  ['boot', (r) => r.boot],
  ['land sync', (r) => r.landSync], ['land settled', (r) => r.landSettled],
  ['obs sync', (r) => r.obsSync], ['obs visible', (r) => r.obsVisible], ['obs populated', (r) => r.obsPopulated],
  ['look sync', (r) => r.lookSync], ['look settled', (r) => r.lookSettled],
  ['net land KB', (r) => r.net.land.kb], ['net land n', (r) => r.net.land.n],
  ['net obs KB', (r) => r.net.observatory.kb], ['net obs n', (r) => r.net.observatory.n],
  ['net look KB', (r) => r.net.lookup.kb], ['net look n', (r) => r.net.lookup.n],
];
console.log('\nmetric              A(median [min..max])          B(median [min..max])');
for (const [n, g] of keys) console.log(`${n.padEnd(20)}${stat(rows.a, g).padEnd(30)}${stat(rows.b, g)}`);
console.log(`\nA=${A}  B=${B}  -> ${out}`);
