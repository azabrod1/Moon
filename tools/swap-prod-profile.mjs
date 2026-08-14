// Cold vs warm profile of the landed flow — land, vantage swap, swap back,
// Look up — with each step's wall time split into veil-down, the state flip
// itself, and the first ten smooth frames, plus the network each step pulls.
//
//   node tools/swap-prod-profile.mjs [url] [--engine=webkit] [--net=2]
//
// Data assets are delayed by size/bandwidth + 40 ms RTT (--net, MB/s) so a
// dev server reproduces a cold first visit, where these steps hold the
// arrival veil for seconds; the veil logic being timed is the same one prod
// runs. COLD is a fresh context, WARM the same context reloaded.
import { chromium, webkit } from 'playwright';

const url = process.argv[2]?.startsWith('http') ? process.argv[2] : 'http://localhost:5174/';
const MBPS = Number((process.argv.find((a) => a.startsWith('--net=')) ?? '--net=3').slice(6)); // MB/s
const engineName = (process.argv.find((a) => a.startsWith('--engine=')) ?? '--engine=webkit').slice(9);
const browser = engineName === 'webkit'
  ? await webkit.launch({ headless: true })
  : await chromium.launch({
      headless: true,
      args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
    });
console.log(`[prod-profile] ${engineName} ${url}`);

const context = await browser.newContext({ viewport: { width: 1728, height: 1080 }, deviceScaleFactor: 2 });
await context.addInitScript(() => {
  try {
    localStorage.clear(); sessionStorage.clear();
    indexedDB.deleteDatabase('orbital-sim-storage');
    localStorage.setItem('planetarium-help-seen', '1');
    localStorage.setItem('planetarium-surface-hint-seen', '1');
  } catch {}
});
// Prod has no dev bridge, so emulate prod fetch times on the dev server:
// delay each data asset by size/bandwidth + 40 ms RTT. The veil logic being
// timed is identical dev vs prod.
await context.route('**/{textures,stardata,models,historic,fonts}/**', async (route) => {
  const resp = await route.fetch();
  const body = await resp.body();
  await new Promise((r) => setTimeout(r, 40 + (body.length / (MBPS * 1024 * 1024)) * 1000));
  await route.fulfill({ response: resp, body });
});
const page = await context.newPage();

let phase = 'boot';
const netByPhase = {};
page.on('response', (res) => {
  const len = Number(res.headers()['content-length'] ?? 0);
  (netByPhase[phase] ??= []).push({ url: res.url().split('/').slice(-2).join('/'), kb: Math.round(len / 1024) });
});

// Wall-time a bridge call until: veil (if it rose) is down again AND the
// predicate holds AND 10 smooth frames follow. Returns breakdown.
const timed = (call, predSrc) => page.evaluate(({ call, predSrc }) => new Promise((resolve) => {
  const veil = document.getElementById('arrival-veil');
  const pred = new Function('return (' + predSrc + ')')();
  const t0 = performance.now();
  let veilRose = false, veilDownAt = null, predAt = null, smoothRun = 0, last = t0, maxGap = 0;
  new Function('return (' + call + ')')()();
  const tick = (now) => {
    const gap = now - last; last = now; maxGap = Math.max(maxGap, gap);
    const covering = veil?.classList.contains('covering') ?? false;
    if (covering) veilRose = true;
    if (veilRose && !covering && veilDownAt === null) veilDownAt = now - t0;
    if (predAt === null && pred()) predAt = now - t0;
    smoothRun = gap < 34 ? smoothRun + 1 : 0;
    const veilOk = !veilRose || veilDownAt !== null;
    if ((veilOk && predAt !== null && smoothRun >= 10) || now - t0 > 40000) {
      resolve({ veilRose, veilDown: veilDownAt && Math.round(veilDownAt), pred: predAt && Math.round(predAt),
        settled: Math.round(now - t0), maxGap: Math.round(maxGap) });
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}), { call, predSrc });

const run = async (label) => {
  console.log(`\n=== ${label} ===`);
  phase = `${label}:boot`;
  await page.goto(`${url}?auto=planetarium`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 90000 });
  await page.waitForFunction(() => {
    const ls = document.getElementById('loading-screen');
    return !ls || ls.classList.contains('hidden');
  }, { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(2500);

  const steps = [
    ['land+swap', "() => { window.__moon.land('Earth'); window.__moon.swapVantage(); }", "() => window.__moon.probeLanded()?.landedOn?.name === 'Moon'"],
    ['swap->Moon', '() => window.__moon.swapVantage()', "() => window.__moon.probeLanded()?.landedOn?.name === 'Moon'"],
    ['swap->Earth', '() => window.__moon.swapVantage()', "() => window.__moon.probeLanded()?.landedOn?.name === 'Earth'"],
    ['lookUp', '() => window.__moon.lookUp()', "() => window.__moon.probeLanded()?.view === 'surface'"],
  ];
  for (const [name, call, pred] of steps) {
    phase = `${label}:${name}`;
    const r = await timed(call, pred);
    const net = netByPhase[phase] ?? [];
    const mb = (net.reduce((s, x) => s + x.kb, 0) / 1024).toFixed(1);
    console.log(` ${name.padEnd(11)} settled=${String(r.settled).padStart(6)}ms veil=${r.veilRose ? String(r.veilDown).padStart(5) + 'ms' : '  none '} ` +
      `pred=${String(r.pred).padStart(6)}ms maxGap=${String(r.maxGap).padStart(4)}ms net=${net.length} reqs ${mb}MB`);
    const big = net.filter((x) => x.kb > 200).sort((a, b) => b.kb - a.kb).slice(0, 6);
    for (const b of big) console.log(`      ${String(b.kb).padStart(6)}KB ${b.url}`);
    await page.waitForTimeout(1000);
  }
};

try {
  await run('COLD');   // fresh context: no SW, no HTTP cache
  await run('WARM');   // same context reloaded: SW installed, caches hot
} finally {
  await browser.close();
}
