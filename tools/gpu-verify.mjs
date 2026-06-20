// Decisive GPU-paint verification, de-confounded from io-isolate:
//  - confirms the GPU path actually engages (reads window.__gpuMoonStats)
//  - separates PROCEDURAL cost (Uranus moons — none photo-backed) from PHOTO
//    decode/upload cost (Io/Europa — JPG-backed). Landing makes the whole system
//    visible, so we land a system that has NEVER been visible to measure its
//    true first-paint, and read the gpu/cpu paint counters before/after.
//   node tools/gpu-verify.mjs --url=http://localhost:5190
import { chromium } from 'playwright';
const url = process.argv.find((a) => a.startsWith('--url=')) ?.slice(6) || 'http://localhost:5190';
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => { try { localStorage.clear(); sessionStorage.clear(); indexedDB.deleteDatabase('orbital-sim-storage'); localStorage.setItem('planetarium-help-seen','1'); localStorage.setItem('planetarium-surface-hint-seen','1'); } catch {} });
  const page = await ctx.newPage();
  page.on('console', (m) => { const t = m.text(); if (t.includes('gpu-moon') || t.includes('GPU moon')) console.log('  [console]', t); });
  await page.goto(`${url}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 45000 });
  await page.waitForFunction(() => { const ls = document.getElementById('loading-screen'); return !ls || ls.classList.contains('hidden'); }, { timeout: 45000 }).catch(()=>{});
  await page.evaluate((t) => window.__moon.setTimeMs(t), Date.parse('2026-06-17T00:00:00Z'));
  await page.waitForTimeout(800);

  const jank = (dur) => page.evaluate((d) => new Promise((res) => { const g=[]; let l=performance.now(); const s=l; const t=(n)=>{g.push(n-l); l=n; if(n-s<d) requestAnimationFrame(t); else { g.shift(); res({maxMs:+Math.max(...g).toFixed(1), janky50:g.filter(x=>x>50).length}); } }; requestAnimationFrame(t); }), dur);
  const stats = () => page.evaluate(() => window.__gpuMoonStats || null);

  console.log('after activation:', JSON.stringify(await stats()));
  const step = async (label, body) => {
    const before = await stats();
    await page.evaluate((b) => { window.__moon.exitSurface(); window.__moon.land(b); }, body);
    const j = await jank(2500);
    const after = await stats();
    const dg = after && before ? after.gpuPaints - before.gpuPaints : '?';
    const dc = after && before ? after.cpuPaints - before.cpuPaints : '?';
    console.log(`${label.padEnd(30)} ${JSON.stringify(j)}  +gpu:${dg} +cpu:${dc}`);
  };

  // Procedural-only systems (no moon here is JPG-backed): pure GPU-paint cost.
  await step('Titania (Uranus, proc-only)', 'Titania');
  await step('Oberon (Uranus, cached)', 'Oberon');
  await step('Rhea (Saturn, proc-only)', 'Rhea');
  // Photo systems: procedural floor (GPU) + JPG decode/upload (unchanged).
  await step('Io (Jupiter, PHOTO)', 'Io');
  await step('Europa (Jupiter, PHOTO)', 'Europa');
  console.log('final:', JSON.stringify(await stats()));
} finally { await browser.close(); }
