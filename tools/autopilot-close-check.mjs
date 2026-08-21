// QA for the autopilot close-approach retarget: engaging Autopilot while
// already inside the arrival postcard must fly a real approach to the close
// standoff (1.5x the collision bubble) instead of instantly ringing
// "Arrived" and parking the ship where it stands — and a normal far engage
// must still park at the postcard. Dev server + __moon.
import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    try {
      localStorage.clear(); sessionStorage.clear();
      indexedDB.deleteDatabase('orbital-sim-storage');
      localStorage.setItem('planetarium-help-seen', '1');
      localStorage.setItem('planetarium-surface-hint-seen', '1');
    } catch { /* ignore */ }
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

  await page.goto('http://localhost:5174/?auto=planetarium', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__moon?.ready?.(), { timeout: 90000 });
  await page.waitForFunction(() => {
    const ls = document.getElementById('loading-screen');
    return !ls || ls.classList.contains('hidden');
  }, { timeout: 60000 });
  await page.waitForTimeout(1500);

  // Log every notification with a timestamp, so the "Arrived" timing is visible.
  await page.evaluate(() => {
    const el = document.getElementById('planetarium-notification');
    window.__notes = [];
    new MutationObserver(() => {
      const t = el.textContent?.trim();
      if (t) window.__notes.push({ t: performance.now(), text: t });
    }).observe(el, { childList: true, characterData: true, subtree: true });
  });

  const sample = () => page.evaluate(() => {
    const pr = window.__moon.probe('Moon');
    const btn = document.getElementById('planetarium-btn-autopilot');
    return {
      d: pr?.distToBodyAU ?? pr?.distanceToBodyAU ?? null,
      moving: pr?.moving,
      pilot: btn?.classList.contains('active') ?? null,
      notes: window.__notes.splice(0).map((n) => n.text),
    };
  });

  // --- Scenario A: Travel to the Moon (parks at the postcard), then engage
  // Autopilot right there — the reported bug: instant "Arrived" + stop.
  const traveled = await page.evaluate(() =>
    window.__moon.openMap() && window.__moon.mapPick('Moon') && window.__moon.mapCommit('travel'));
  console.log(`[A] travel commit: ${traveled}`);
  await page.waitForTimeout(6000); // let the teleport + veil settle
  const atPostcard = await sample();
  console.log(`[A] at postcard: dist=${atPostcard.d?.toExponential(3)} notes=${JSON.stringify(atPostcard.notes)}`);

  const engaged = await page.evaluate(() =>
    window.__moon.openMap() && window.__moon.mapPick('Moon') && window.__moon.mapCommit('pilot'));
  console.log(`[A] pilot commit: ${engaged}`);

  let arrivedNote = null; let last = null;
  for (let i = 0; i < 150; i++) {
    await page.waitForTimeout(2000);
    last = await sample();
    for (const n of last.notes) {
      console.log(`[A][note t=${(i + 1) * 2}s] ${n}`);
      if (/^Arrived at/.test(n)) arrivedNote = { t: (i + 1) * 2, text: n };
    }
    if (i % 5 === 0 || arrivedNote) console.log(`[A] t=${(i + 1) * 2}s dist=${last.d?.toExponential(3)} moving=${last.moving} pilot=${last.pilot}`);
    if (arrivedNote && !last.pilot) break;
  }
  const MOON_R = 1.1614e-5; // AU, catalog radius
  console.log(`[A] RESULT: arrived=${JSON.stringify(arrivedNote)} finalDist=${last.d?.toExponential(3)} (${(last.d / MOON_R).toFixed(2)} radii)`);
  const aPass = arrivedNote && arrivedNote.t > 4 && last.d < 3 * MOON_R;
  console.log(`[A] ${aPass ? 'PASS' : 'FAIL'}: close-approach glide (no instant arrival, parks near the shell)`);

  // --- Scenario B: regression — a far engage still parks at the postcard.
  await page.evaluate(() => window.__moon.frame('Moon', 0.2, 0, 60)); // 60 radii out, well past the ~23-radii postcard
  await page.waitForTimeout(1000);
  const engagedB = await page.evaluate(() =>
    window.__moon.openMap() && window.__moon.mapPick('Moon') && window.__moon.mapCommit('pilot'));
  console.log(`[B] pilot commit: ${engagedB}`);
  let arrivedB = null; let lastB = null;
  for (let i = 0; i < 150; i++) {
    await page.waitForTimeout(2000);
    lastB = await sample();
    for (const n of lastB.notes) {
      console.log(`[B][note t=${(i + 1) * 2}s] ${n}`);
      if (/^Arrived at/.test(n)) arrivedB = { t: (i + 1) * 2, text: n };
    }
    if (i % 5 === 0 || arrivedB) console.log(`[B] t=${(i + 1) * 2}s dist=${lastB.d?.toExponential(3)} moving=${lastB.moving} pilot=${lastB.pilot}`);
    if (arrivedB && !lastB.pilot) break;
  }
  console.log(`[B] RESULT: arrived=${JSON.stringify(arrivedB)} finalDist=${lastB.d?.toExponential(3)} (${(lastB.d / MOON_R).toFixed(2)} radii)`);
  const bPass = arrivedB && lastB.d > 15 * MOON_R;
  console.log(`[B] ${bPass ? 'PASS' : 'FAIL'}: far engage still parks at the postcard`);

  process.exitCode = aPass && bPass ? 0 : 1;
} finally {
  await browser.close();
}
