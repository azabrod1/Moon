// Ad-hoc: attribute post-teleport frame spikes to texture uploads.
// Arms the DEV surfacePerf trace (its upload ring is unconditional; its frame
// ring is input-gated, so rAF gaps are recorded here directly), runs a real
// travelTo('Moon'), then prints a timeline relative to the commit: veil
// transitions, every texture upload (name/size/duration), every rAF gap >40ms.
// Run: node tools/warmup-profile.mjs [url]   (dev server must be up)
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:5173/?auto=planetarium';
const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.addInitScript(() => {
  localStorage.clear();
  sessionStorage.clear();
  indexedDB.deleteDatabase('orbital-sim-storage');
});
await page.goto(url);
await page.waitForFunction(() => globalThis.__moon?.ready?.(), null, { timeout: 90_000 });

await page.evaluate(() => {
  const veil = document.getElementById('arrival-veil');
  const veilEvents = [];
  globalThis.__veilEvents = veilEvents;
  new MutationObserver(() => {
    veilEvents.push({ covering: veil.classList.contains('covering'), atMs: performance.now() });
  }).observe(veil, { attributes: true, attributeFilter: ['class'] });
  const gaps = [];
  globalThis.__gaps = gaps;
  let last = performance.now();
  const tick = (t) => {
    if (t - last > 40) gaps.push({ atMs: t, gapMs: t - last });
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  globalThis.__moon.surfacePerf('start');
  globalThis.__traceArmedAt = performance.now();
  if (!globalThis.__moon.travelTo('Moon')) throw new Error('travelTo failed');
  globalThis.__commitAt = performance.now();
});
await page.waitForTimeout(14_000);

const report = await page.evaluate(() => {
  const commitAt = globalThis.__commitAt;
  const armedAt = globalThis.__traceArmedAt;
  const rel = (t) => Math.round(t - commitAt);
  const snap = globalThis.__moon.surfacePerf('snapshot');
  return {
    veil: (globalThis.__veilEvents ?? []).map((e) => `${e.covering ? 'COVER' : 'LIFT '} at +${rel(e.atMs)}ms`),
    // Upload atMs is relative to trace start; shift onto the commit clock.
    uploads: (snap?.samples?.uploads ?? []).map(
      (u) => `+${rel(armedAt + u.atMs)}ms  ${u.name} ${u.width}x${u.height}  upload ${u.durationMs.toFixed(1)}ms`,
    ),
    spikes: (globalThis.__gaps ?? []).map((f) => `+${rel(f.atMs)}ms  frame gap ${f.gapMs.toFixed(0)}ms`),
  };
});

console.log('veil:');
for (const l of report.veil) console.log('  ' + l);
console.log('uploads:');
for (const l of report.uploads) console.log('  ' + l);
console.log('frame gaps > 40ms:');
for (const l of report.spikes) console.log('  ' + l);
await browser.close();
