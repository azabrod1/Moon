// How much does the Observatory panel change on screen while the clock runs
// fast? Stands on a planet whose moons keep the sky busy (Jupiter by default),
// opens the panel, lets the first upcoming-events sweep finish, then runs the
// clock at --rate for --seconds of wall time and counts what moved: rebuilds
// of the upcoming-events list, changes of the status line under it, and
// changes of the sky window's title. The counts are what a person watching the
// panel sees as churn; the sim hours covered say how busy the sky really was.
//
//   PW_CHROMIUM=/opt/pw-browsers/chromium node tools/observatory-churn-probe.mjs \
//     --body=Jupiter --rate=3600 --seconds=60 --out=DIR
//
// Takes the machine-wide browser lock. Needs the dev server (npx vite --port
// 5174 --strictPort). Prints one JSON summary line at the end.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { takeBrowserLock } from './browserLock.mjs';

const arg = (key, fallback) => {
  const match = process.argv.find((a) => a.startsWith(`--${key}=`));
  return match ? match.slice(key.length + 3) : fallback;
};
const URL = arg('url', 'http://127.0.0.1:5174');
const BODY = arg('body', 'Jupiter');
const RATE = Number(arg('rate', '3600'));
const SECONDS = Number(arg('seconds', '60'));
const OUT = arg('out', '/tmp/moon-observatory-churn');
mkdirSync(OUT, { recursive: true });
const GPU_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

const release = await takeBrowserLock('observatory-churn');
const browser = await chromium.launch({ headless: true, args: GPU_ARGS, executablePath: process.env.PW_CHROMIUM || undefined });
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem('planetarium-help-seen', '1');
      localStorage.setItem('planetarium-surface-hint-seen', '1');
    } catch {}
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  await page.goto(`${URL}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__moon?.ready?.(), null, { timeout: 300_000 });
  await page.waitForFunction(() => {
    const ls = document.getElementById('loading-screen');
    return !ls || ls.classList.contains('hidden');
  }, null, { timeout: 120_000 }).catch(() => {});

  console.log(`[land] ${BODY}`);
  await page.evaluate((body) => window.__moon.land(body), BODY);
  await page.waitForFunction((body) => window.__moon.probeLanded()?.landedOn?.name === body, BODY, { timeout: 120_000 });
  await page.waitForTimeout(3000);
  console.log('[panel] open, waiting for the first sweep');
  await page.evaluate(() => window.__moon.openObservatory());
  await page.waitForFunction(() => {
    const status = document.getElementById('observatory-events-status')?.textContent ?? '';
    const rows = document.getElementById('observatory-events-list')?.children.length ?? 0;
    return !/^Scanning/.test(status) && rows > 0;
  }, null, { timeout: 180_000 });
  const before = await page.evaluate(() => ({
    utcMs: window.__moon.getTimeMs(),
    rows: Array.from(document.getElementById('observatory-events-list').children).map((el) => el.querySelector('.obs-ev-name')?.textContent ?? ''),
    status: document.getElementById('observatory-events-status')?.textContent ?? '',
  }));
  console.log('[rows]', before.rows.join(' | '));

  await page.evaluate(() => {
    const counters = {
      rebuilds: 0, rebuildAtMs: [], rowSnapshots: [],
      statusChanges: 0, statuses: [], lastStatus: null,
      windowChanges: 0, windowTitles: [],
    };
    const t0 = performance.now();
    const list = document.getElementById('observatory-events-list');
    const names = () => Array.from(list.children).map((el) => el.querySelector('.obs-ev-name')?.textContent ?? '').join(' | ');
    new MutationObserver(() => {
      counters.rebuilds++;
      if (counters.rebuildAtMs.length < 200) counters.rebuildAtMs.push(Math.round(performance.now() - t0));
      if (counters.rowSnapshots.length < 40) counters.rowSnapshots.push(names());
    }).observe(list, { childList: true });
    const status = document.getElementById('observatory-events-status');
    counters.lastStatus = status.textContent;
    new MutationObserver(() => {
      const text = status.textContent;
      if (text === counters.lastStatus) return;
      counters.lastStatus = text;
      counters.statusChanges++;
      if (counters.statuses.length < 40) counters.statuses.push(text);
    }).observe(status, { childList: true, characterData: true, subtree: true });
    const title = document.getElementById('observatory-window-title');
    let lastTitle = title.textContent;
    new MutationObserver(() => {
      const text = title.textContent;
      if (text === lastTitle) return;
      lastTitle = text;
      counters.windowChanges++;
      if (counters.windowTitles.length < 40) counters.windowTitles.push(text);
    }).observe(title, { childList: true, characterData: true, subtree: true });
    window.__churn = counters;
  });
  console.log(`[run] rate ${RATE} for ${SECONDS}s`);
  await page.evaluate((rate) => { window.__moon.setTimePaused(false); window.__moon.setTimeRate(rate); }, RATE);
  await page.waitForTimeout(SECONDS * 1000);
  const after = await page.evaluate(() => ({
    utcMs: window.__moon.getTimeMs(),
    rows: Array.from(document.getElementById('observatory-events-list').children).map((el) => el.querySelector('.obs-ev-name')?.textContent ?? ''),
    status: document.getElementById('observatory-events-status')?.textContent ?? '',
    counters: window.__churn,
  }));
  await page.screenshot({ path: path.join(OUT, `panel-${BODY}-${RATE}.png`) });
  const simHours = (after.utcMs - before.utcMs) / 3_600_000;
  const summary = {
    body: BODY, rate: RATE, wallSeconds: SECONDS, simHours: Math.round(simHours * 10) / 10,
    listRebuilds: after.counters.rebuilds,
    statusChanges: after.counters.statusChanges,
    windowTitleChanges: after.counters.windowChanges,
    rowsBefore: before.rows, rowsAfter: after.rows, statusAfter: after.status,
    rebuildAtMs: after.counters.rebuildAtMs,
    statuses: after.counters.statuses,
    windowTitles: after.counters.windowTitles,
    rowSnapshots: after.counters.rowSnapshots,
    errors: errors.slice(0, 5),
  };
  console.log('[summary]', JSON.stringify(summary));
} finally {
  await browser.close();
  release();
}
