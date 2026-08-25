// Profile the "Preparing <planet>…" arrival veil hold.
//
// Drives __moon.travelTo(<body>) — the real cruise travel pipeline — against a
// running dev server (`npm run dev`, port 5174) and reads the DEV forensics
// the source installs (window.__arrivalProfile: per-phase wall times of the
// veil hold; __texProfile: per-attempt tier fetch+decode; __uploadProfile:
// warm-pump uploads; __paintProfile: per-moon paints) plus resource timing, to
// break down exactly where the covered time goes.
//
// Findings that shaped the arrival path (2026-08): the hold's dominant cost is
// the destination's first colour-tier NETWORK fetch — hence the post-boot
// cache prefetch (world/tierPrefetch) and the at-commit fetch kick in
// arriveThen. Repeat visits must report "no veil (warm/instant arrival)".
//
// Caveat on machines without a real GPU (SwiftShader): frames run ~1s, so the
// 2-rAF / dwell rows inflate wildly and bitmap decode crawls — read the fetch
// rows (a 0KB transfer = cache hit) and phase STRUCTURE there, not absolutes.
// A small viewport (--w=480 --h=300) keeps software frames tolerable.
//
// Usage: node tools/travel-profile.mjs [--bodies=Jupiter,Mars] [--throttle]
//        [--settle=9000] [--w=480 --h=300] [--url=http://localhost:5174]
// --throttle emulates 25 Mbps / 40 ms RTT; --settle waits that long after boot
// (12s lets the throttled prefetch finish; 1200 races it, for the cold path).
import { chromium } from 'playwright';

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
const url = arg('url', 'http://localhost:5174');
const bodies = arg('bodies', 'Jupiter,Mars,Saturn,Uranus').split(',').map((s) => s.trim()).filter(Boolean);
const throttle = process.argv.includes('--throttle');

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=vulkan', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});

try {
  const W = Number(arg('w', '1280'));
  const H = Number(arg('h', '800'));
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
      indexedDB.deleteDatabase('orbital-sim-storage');
      localStorage.setItem('planetarium-help-seen', '1');
      localStorage.setItem('planetarium-surface-hint-seen', '1');
    } catch {}
  });

  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', String(e)));

  if (throttle) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    // A decent home broadband: 25 Mbit/s down, 40 ms RTT.
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 40, downloadThroughput: (25e6) / 8, uploadThroughput: (5e6) / 8,
    });
    console.log('[profile] network throttled: 25 Mbps / 40 ms RTT');
  }

  await page.goto(`${url}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 90000 });
  await page.waitForFunction(() => {
    const ls = document.getElementById('loading-screen');
    return !ls || ls.classList.contains('hidden');
  }, { timeout: 90000 }).catch(() => {});
  // Let boot settle (boot preloads, star catalog, first paints, prefetch).
  await page.waitForTimeout(Number(arg('settle', '4000')));

  for (const body of bodies) {
    const before = await page.evaluate(() => ({
      resLen: performance.getEntriesByType('resource').length,
      texLen: (window.__texProfile || []).length,
      upLen: (window.__uploadProfile || []).length,
      paintLen: (window.__paintProfile || []).length,
      now: performance.now(),
    }));
    const ok = await page.evaluate((n) => window.__moon.travelTo(n), body);
    if (!ok) { console.log(`\n=== ${body} === SKIP: travelTo returned false`); continue; }

    // Wait for the veil cycle to finish (arrival profile has revealAt), or for
    // a warm no-veil arrival (no new profile within 3s).
    await page.waitForFunction((t0) => {
      const p = window.__arrivalProfile;
      return p && p.start >= t0 - 100 && p.revealAt !== undefined;
    }, before.now, { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(800); // let stragglers (decode/uploads) log

    const data = await page.evaluate((b) => ({
      prof: window.__arrivalProfile || null,
      tex: (window.__texProfile || []).slice(b.texLen),
      uploads: (window.__uploadProfile || []).slice(b.upLen),
      paints: (window.__paintProfile || []).slice(b.paintLen),
      res: performance.getEntriesByType('resource').slice(b.resLen).map((r) => ({
        name: r.name.split('/').slice(-2).join('/'),
        start: Math.round(r.startTime - b.now),
        dur: Math.round(r.duration),
        kb: Math.round((r.transferSize || r.decodedBodySize || 0) / 1024),
      })),
    }), before);

    console.log(`\n=== ${body} ===`);
    const p = data.prof && data.prof.start >= before.now - 100 ? data.prof : null;
    if (!p) {
      console.log('no veil (warm/instant arrival)');
    } else {
      const d = (a, b2) => (p[a] !== undefined && p[b2] !== undefined ? Math.round(p[b2] - p[a]) : '?');
      console.log(`flags: needsPaint=${p.needsPaint} upgradeCover=${p.upgradeCover} uploadCover=${p.uploadCover} waitBatch=${p.waitBatch} abandonedAtDeadline=${p.fetchAbandoned}`);
      console.log(`total cover→reveal:      ${d('start', 'revealAt')} ms`);
      console.log(`  2-rAF veil composite:  ${d('start', 'coveredAt')} ms`);
      console.log(`  paintSystemNow:        ${d('coveredAt', 'paintDoneAt')} ms  (${data.paints.length} moons)`);
      console.log(`  action (teleport+warm):${d('paintDoneAt', 'actionDoneAt')} ms`);
      console.log(`  warm pump uploads:     ${d('actionDoneAt', 'warmPumpDoneAt')} ms`);
      console.log(`  fetch+decode hold:     ${d('warmPumpDoneAt', 'fetchWaitDoneAt')} ms`);
      console.log(`  final pump:            ${d('fetchWaitDoneAt', 'finalPumpDoneAt')} ms`);
      console.log(`  dwell/reveal wait:     ${d('finalPumpDoneAt', 'revealAt')} ms`);
    }
    if (data.paints.length) {
      const total = data.paints.reduce((s, x) => s + x.ms, 0);
      const top = [...data.paints].sort((a, b2) => b2.ms - a.ms).slice(0, 6);
      console.log(`paints: ${data.paints.length} moons, ${Math.round(total)} ms total; top: ${top.map((x) => `${x.moon} ${x.ms.toFixed(1)}ms`).join(', ')}`);
    }
    for (const t of data.tex) {
      const fetchMs = t.loadedAt !== undefined ? Math.round(t.loadedAt - t.startedAt) : '?';
      const decodeMs = t.decodedAt !== undefined && t.loadedAt !== undefined ? Math.round(t.decodedAt - t.loadedAt) : '?';
      console.log(`tex ${t.key}@${t.tier}: fetch+bitmap ${fetchMs} ms, decode ${decodeMs} ms (started +${Math.round(t.startedAt - before.now)} ms)`);
    }
    if (data.uploads.length) {
      const total = data.uploads.reduce((s, x) => s + x.ms, 0);
      const top = [...data.uploads].sort((a, b2) => b2.ms - a.ms).slice(0, 8);
      console.log(`uploads: ${data.uploads.length} total ${Math.round(total)} ms; top: ${top.map((x) => `${x.name} ${x.size} ${x.ms.toFixed(1)}ms@+${Math.round(x.at - before.now)}`).join(', ')}`);
    }
    if (data.res.length) {
      console.log(`fetches: ${data.res.map((r) => `${r.name} ${r.kb}KB +${r.start}ms dur=${r.dur}ms`).join('\n         ')}`);
    }
  }
} finally {
  await browser.close();
}
