// QA: the arrival veil's busy note. Cold throttled boot -> map-commit an
// observe landing on Mars (veiled arrival) -> click mid-hold -> screenshot.
import { webkit } from 'playwright';
import { mkdir } from 'node:fs/promises';
const browser = await webkit.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
  await context.route('**/{textures,stardata,models,historic,fonts}/**', async (route) => {
    const resp = await route.fetch();
    const body = await resp.body();
    await new Promise((r) => setTimeout(r, 40 + (body.length / (2 * 1024 * 1024)) * 1000));
    await route.fulfill({ response: resp, body });
  });
  await context.addInitScript(() => {
    try {
      localStorage.clear(); sessionStorage.clear();
      indexedDB.deleteDatabase('orbital-sim-storage');
      localStorage.setItem('planetarium-help-seen', '1');
      localStorage.setItem('planetarium-surface-hint-seen', '1');
    } catch {}
  });
  const page = await context.newPage();
  await page.goto('http://localhost:5174/?auto=planetarium', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 60000 });
  await mkdir('/tmp/moon-shots/veil-note', { recursive: true });
  await page.evaluate(() => {
    window.__moon.openMap();
    window.__moon.mapPick('Mars');
    window.__moon.mapCommit('observe');
  });
  // Wait for the veil to cover, then click into it and catch the note.
  await page.waitForFunction(() =>
    document.getElementById('arrival-veil')?.classList.contains('covering'), { timeout: 15000 });
  await page.waitForTimeout(420);
  await page.mouse.click(700, 450);
  await page.waitForTimeout(180);
  const state = await page.evaluate(() => ({
    covering: document.getElementById('arrival-veil')?.classList.contains('covering'),
    note: document.getElementById('arrival-veil-note')?.textContent,
    shown: document.getElementById('arrival-veil-note')?.classList.contains('show'),
    pulsed: document.getElementById('arrival-veil-note')?.classList.contains('pulse'),
  }));
  console.log('[veil]', JSON.stringify(state));
  await page.screenshot({ path: '/tmp/moon-shots/veil-note/mid-hold.png' });
  console.log('[saved] /tmp/moon-shots/veil-note/mid-hold.png');
} finally { await browser.close(); }
