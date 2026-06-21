// Isolate the Jupiter inner-moon stall: is it the one-time texture paint
// (cached on revisit) or the Observatory search (every time)?
import { chromium } from 'playwright';
const url = process.argv.find((a) => a.startsWith('--url='))?.slice(6) || 'http://localhost:5181';
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => { try { localStorage.clear(); sessionStorage.clear(); indexedDB.deleteDatabase('orbital-sim-storage'); localStorage.setItem('planetarium-help-seen','1'); localStorage.setItem('planetarium-surface-hint-seen','1'); } catch {} });
  const page = await ctx.newPage();
  await page.goto(`${url}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 45000 });
  await page.waitForFunction(() => { const ls = document.getElementById('loading-screen'); return !ls || ls.classList.contains('hidden'); }, { timeout: 45000 }).catch(()=>{});
  await page.evaluate((t) => window.__moon.setTimeMs(t), Date.parse('2026-06-17T00:00:00Z'));
  await page.waitForTimeout(800);
  const jank = (dur) => page.evaluate((d) => new Promise((res) => { const g=[]; let l=performance.now(); const s=l; const t=(n)=>{g.push(n-l); l=n; if(n-s<d) requestAnimationFrame(t); else { g.shift(); res({maxMs:+Math.max(...g).toFixed(1), janky50:g.filter(x=>x>50).length}); } }; requestAnimationFrame(t); }), dur);

  const step = async (label, fn) => { await page.evaluate(fn); const j = await jank(3000); console.log(`${label.padEnd(34)} ${JSON.stringify(j)}`); };

  await step('Earth (baseline, no obs)',        () => { window.__moon.exitSurface(); window.__moon.land('Earth'); });
  await step('Io #1 (no obs) — first paint?',   () => { window.__moon.exitSurface(); window.__moon.land('Io'); });
  await step('Mars (flush)',                    () => { window.__moon.exitSurface(); window.__moon.land('Mars'); });
  await step('Io #2 (no obs) — cached?',        () => { window.__moon.exitSurface(); window.__moon.land('Io'); });
  await step('Io #3 + openObservatory (search)',() => { window.__moon.exitSurface(); window.__moon.land('Io'); window.__moon.openObservatory(); });
  await step('Europa #1 (no obs) — first paint?',() => { window.__moon.exitSurface(); window.__moon.land('Europa'); });
  await step('Europa #2 (no obs) — cached?',    () => { window.__moon.exitSurface(); window.__moon.land('Europa'); });
  await step('Ganymede #1 — first paint?',      () => { window.__moon.exitSurface(); window.__moon.land('Ganymede'); });
  await step('Callisto #1 — first paint?',      () => { window.__moon.exitSurface(); window.__moon.land('Callisto'); });
  await step('Triton #1 — first paint?',        () => { window.__moon.exitSurface(); window.__moon.land('Triton'); });
} finally { await browser.close(); }
