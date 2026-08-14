// Boot-time profiler for the Planetarium (production builds).
//
// Emulates a mid-tier phone (390x844 @3x, 4x CPU throttle, 4G network) and
// measures startup milestones against a served dist/: navigation timings,
// time until the #loading-screen hides (user-perceived "app entered"),
// long tasks on the main thread, and per-type resource bytes.
//
//   npx vite preview --port 4173   # serve the build under test
//   node tools/perf-boot.mjs --url=http://localhost:4173 --label=current --runs=3
//
// Pass --trace to also write a Chrome trace (chrome://tracing / Perfetto)
// of the first run. Pass --nothrottle to skip CPU/network throttling.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

const url = arg('url', 'http://localhost:4173');
const label = arg('label', 'boot');
const runs = Number(arg('runs', '3'));
const outDir = arg('out', path.join('/tmp/moon-perf', label));
const doTrace = process.argv.includes('--trace');
const throttleCpu = !process.argv.includes('--nothrottle') && !process.argv.includes('--nocpu');
const throttleNet = !process.argv.includes('--nothrottle') && !process.argv.includes('--nonet');

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

const results = [];
try {
  for (let run = 0; run < runs; run++) {
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
      } catch { /* storage blocked */ }
      // Milestones + long-task ledger, read back after boot.
      window.__perf = { longTasks: [], loadingHiddenAt: null };
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) window.__perf.longTasks.push({ start: e.startTime, dur: e.duration });
        }).observe({ type: 'longtask', buffered: true });
      } catch { /* longtask unsupported */ }
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
        offline: false,
        latency: 150,
        downloadThroughput: (9 * 1024 * 1024) / 8, // ~9 Mbps: mid 4G
        uploadThroughput: (1.5 * 1024 * 1024) / 8,
      });
    }
    if (doTrace && run === 0) {
      await browser.startTracing(page, {
        path: path.join(outDir, 'trace.json'),
        categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8', 'blink.user_timing', 'loading'],
      });
    }

    const t0 = Date.now();
    await page.goto(`${url}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
    await page
      .waitForFunction(() => window.__perf && window.__perf.loadingHiddenAt != null, { timeout: 120000 })
      .catch(() => {});
    // Let post-entry streaming settle so resource totals are comparable.
    await page.waitForTimeout(6000);

    const metrics = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const res = performance.getEntriesByType('resource');
      const byType = {};
      for (const r of res) {
        const ext = (r.name.split('?')[0].match(/\.(\w+)$/) || [])[1] || 'other';
        const k = ['jpg', 'jpeg', 'png', 'webp', 'ktx2'].includes(ext) ? 'image'
          : ['js', 'mjs'].includes(ext) ? 'js'
          : ['css'].includes(ext) ? 'css' : ext;
        byType[k] = byType[k] || { n: 0, bytes: 0, ms: 0 };
        byType[k].n++;
        byType[k].bytes += r.transferSize || r.encodedBodySize || 0;
        byType[k].ms = Math.max(byType[k].ms, r.responseEnd);
      }
      const lt = window.__perf.longTasks;
      return {
        domContentLoaded: nav ? nav.domContentLoadedEventEnd : null,
        loadEvent: nav ? nav.loadEventEnd : null,
        loadingHiddenAt: window.__perf.loadingHiddenAt,
        longTaskCount: lt.length,
        longTaskTotalMs: Math.round(lt.reduce((s, t) => s + t.dur, 0)),
        worstLongTasks: lt.slice().sort((a, b) => b.dur - a.dur).slice(0, 5)
          .map((t) => ({ start: Math.round(t.start), dur: Math.round(t.dur) })),
        resources: byType,
      };
    });
    metrics.wallMs = Date.now() - t0;
    results.push(metrics);
    console.log(`[perf ${label} run ${run + 1}/${runs}] entered=${Math.round(metrics.loadingHiddenAt ?? -1)}ms ` +
      `dcl=${Math.round(metrics.domContentLoaded ?? -1)}ms longTasks=${metrics.longTaskCount}/${metrics.longTaskTotalMs}ms`);

    if (doTrace && run === 0) await browser.stopTracing();
    await context.close();
  }
} finally {
  await browser.close();
}

await writeFile(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
const med = (key) => {
  const v = results.map((r) => r[key]).filter((x) => x != null).sort((a, b) => a - b);
  return v.length ? Math.round(v[Math.floor(v.length / 2)]) : null;
};
console.log(`[perf ${label}] median entered=${med('loadingHiddenAt')}ms dcl=${med('domContentLoaded')}ms ` +
  `longTaskTotal=${med('longTaskTotalMs')}ms  -> ${outDir}/results.json`);
