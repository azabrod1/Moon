// SCRATCH (throwaway): interleaved A/B boot profiler.
//
// Alternates two served builds run-by-run inside one browser so machine noise
// hits both equally, and harvests the app's own `plm:*` performance measures
// (which survive the production build) alongside navigation/long-task data.
//
//   node tools/perf-ab.mjs --a=http://localhost:4173 --b=http://localhost:4174 --pairs=8
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

function arg(name, def) {
  const hit = process.argv.find((x) => x.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
const A = arg('a', 'http://localhost:4173');
const B = arg('b', 'http://localhost:4174');
const pairs = Number(arg('pairs', '6'));
const out = arg('out', '/tmp/moon-perf/ab.json');
const throttleCpu = process.argv.includes('--cpu');
const throttleNet = process.argv.includes('--net');

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

async function boot(url) {
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
    window.__perf = { longTasks: [], loadingHiddenAt: null };
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__perf.longTasks.push({ start: e.startTime, dur: e.duration });
      }).observe({ type: 'longtask', buffered: true });
    } catch { /* unsupported */ }
    const watch = () => {
      const ls = document.getElementById('loading-screen');
      if (!ls) { requestAnimationFrame(watch); return; }
      const check = () => {
        if (ls.classList.contains('hidden') && window.__perf.loadingHiddenAt == null) {
          window.__perf.loadingHiddenAt = performance.now();
        }
      };
      new MutationObserver(check).observe(ls, { attributes: true, attributeFilter: ['class'] });
      check();
    };
    document.addEventListener('DOMContentLoaded', watch);
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  if (throttleCpu) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  if (throttleNet) {
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 150,
      downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (1.5 * 1024 * 1024) / 8,
    });
  }
  await page.goto(`${url}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__perf?.loadingHiddenAt != null, { timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const m = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const phases = {};
    for (const e of performance.getEntriesByType('measure')) {
      if (e.name.startsWith('plm:')) phases[e.name.slice(4)] = Math.round(e.duration);
    }
    const marks = {};
    for (const e of performance.getEntriesByType('mark')) {
      if (e.name.startsWith('plm:')) marks[e.name.slice(4)] = Math.round(e.startTime);
    }
    // Main-bundle script resource timing (the entry chunk + the three chunk).
    const js = performance.getEntriesByType('resource')
      .filter((r) => /\.js($|\?)/.test(r.name))
      .map((r) => ({
        name: r.name.split('/').pop(),
        start: Math.round(r.startTime),
        end: Math.round(r.responseEnd),
        bytes: r.encodedBodySize || r.transferSize || 0,
      }));
    const img = performance.getEntriesByType('resource')
      .filter((r) => /\.(jpg|jpeg|png|webp|ktx2)($|\?)/.test(r.name));
    const imgBeforeEntry = img.filter((r) => r.responseEnd <= (window.__perf.loadingHiddenAt ?? Infinity));
    const lt = window.__perf.longTasks;
    return {
      dcl: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
      respStart: nav ? Math.round(nav.responseStart) : null,
      entered: window.__perf.loadingHiddenAt != null ? Math.round(window.__perf.loadingHiddenAt) : null,
      phases,
      marks,
      js,
      imgCount: img.length,
      imgBytes: img.reduce((s, r) => s + (r.encodedBodySize || r.transferSize || 0), 0),
      imgBeforeEntryCount: imgBeforeEntry.length,
      imgBeforeEntryBytes: imgBeforeEntry.reduce((s, r) => s + (r.encodedBodySize || r.transferSize || 0), 0),
      imgLastEndBeforeEntry: imgBeforeEntry.length
        ? Math.round(Math.max(...imgBeforeEntry.map((r) => r.responseEnd))) : 0,
      longTaskTotal: Math.round(lt.reduce((s, t) => s + t.dur, 0)),
      worstLongTasks: lt.slice().sort((a, b) => b.dur - a.dur).slice(0, 6)
        .map((t) => ({ start: Math.round(t.start), dur: Math.round(t.dur) })),
    };
  });
  await context.close();
  return m;
}

const rows = { a: [], b: [] };
// One warm-up boot per build so first-touch file caching doesn't land on run 1.
await boot(A); await boot(B);
for (let i = 0; i < pairs; i++) {
  // Alternate order each pair so any slow drift cancels out.
  const order = i % 2 === 0 ? ['a', 'b'] : ['b', 'a'];
  for (const which of order) {
    const m = await boot(which === 'a' ? A : B);
    rows[which].push(m);
    console.log(`[${which}] pair ${i + 1}/${pairs} entered=${m.entered} dcl=${m.dcl} ` +
      `activate=${m.phases.activate} solar=${m.phases['solar-system']} star=${m.phases.starfield} ` +
      `precompile=${m.phases.precompile} first-frame=${m.phases['first-frame']} lt=${m.longTaskTotal}`);
  }
}
await browser.close();
await writeFile(out, JSON.stringify(rows, null, 2));

const stat = (arr, get) => {
  const v = arr.map(get).filter((x) => x != null).sort((x, y) => x - y);
  if (!v.length) return 'n/a';
  return `${v[Math.floor(v.length / 2)]} [${v[0]}..${v[v.length - 1]}]`;
};
const keys = [
  ['dcl', (r) => r.dcl], ['entered', (r) => r.entered],
  ['activate', (r) => r.phases.activate], ['solar-system', (r) => r.phases['solar-system']],
  ['moon-meshes', (r) => r.phases['moon-meshes']], ['starfield', (r) => r.phases.starfield],
  ['precompile', (r) => r.phases.precompile], ['first-frame', (r) => r.phases['first-frame']],
  ['activateStartAt', (r) => r.marks['activate:start']],
  ['longTaskTotal', (r) => r.longTaskTotal],
  ['imgBeforeEntryBytes', (r) => r.imgBeforeEntryBytes],
  ['imgBeforeEntryCount', (r) => r.imgBeforeEntryCount],
];
console.log('\nmetric              A(median [min..max])          B(median [min..max])');
for (const [name, get] of keys) {
  console.log(`${name.padEnd(20)}${stat(rows.a, get).padEnd(30)}${stat(rows.b, get)}`);
}
console.log(`\nA=${A}  B=${B}  -> ${out}`);
