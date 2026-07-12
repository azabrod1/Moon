// A/B: GPU moon paint vs the old CPU path, identical scenario. Measures the
// total MAIN-THREAD time spent painting all moons (the jank source) and the
// worst frame gap during the startup drain. Forces CPU via __forceCpuMoonPaint
// (a DEV switch the texturer reads), set before boot via addInitScript.
//   node tools/gpu-vs-cpu.mjs --url=http://localhost:5190
import { chromium } from 'playwright';
const url = process.argv.find((a) => a.startsWith('--url='))?.slice(6) || 'http://localhost:5190';
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });

async function run(forceCpu) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addInitScript((fc) => {
    try { localStorage.clear(); sessionStorage.clear(); indexedDB.deleteDatabase('orbital-sim-storage'); localStorage.setItem('planetarium-help-seen','1'); localStorage.setItem('planetarium-surface-hint-seen','1'); } catch {}
    if (fc) window.__forceCpuMoonPaint = true;
  }, forceCpu);
  const page = await ctx.newPage();
  await page.goto(`${url}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 45000 });
  // Measure frame gaps for 6s while the background pump drains all moons.
  const jank = await page.evaluate(() => new Promise((res) => {
    const g = []; let l = performance.now(); const s = l;
    const t = (n) => { g.push(n - l); l = n; if (n - s < 6000) requestAnimationFrame(t); else { g.shift(); res({ maxMs: +Math.max(...g).toFixed(1), janky16: g.filter((x) => x > 16).length, janky50: g.filter((x) => x > 50).length, frames: g.length }); } };
    requestAnimationFrame(t);
  }));
  const stats = await page.evaluate(() => window.__gpuMoonStats || null);
  await ctx.close();
  return { jank, stats };
}

const gpu = await run(false);
const cpu = await run(true);
await browser.close();

const row = (label, r) => {
  const s = r.stats || {};
  const paints = (s.gpuPaints || 0) + (s.cpuPaints || 0);
  const ms = (s.gpuMs || 0) + (s.cpuMs || 0);
  console.log(`${label.padEnd(12)} paints=${paints}  totalPaintMs=${ms.toFixed(1)}  avgPerMoon=${(ms / Math.max(paints,1)).toFixed(2)}ms  | drain maxFrame=${r.jank.maxMs}ms  >50ms:${r.jank.janky50}  >16ms:${r.jank.janky16}/${r.jank.frames}`);
};
console.log('\n=== GPU moon paint vs old CPU path (all moons, identical scenario) ===');
row('GPU', gpu);
row('CPU (old)', cpu);
const g = (gpu.stats?.gpuMs || 0) + (gpu.stats?.cpuMs || 0);
const c = (cpu.stats?.gpuMs || 0) + (cpu.stats?.cpuMs || 0);
if (g > 0) console.log(`\nspeedup: CPU spends ${(c / g).toFixed(1)}x the main-thread time GPU does (${c.toFixed(0)}ms vs ${g.toFixed(0)}ms).`);
console.log('raw GPU stats:', JSON.stringify(gpu.stats));
console.log('raw CPU stats:', JSON.stringify(cpu.stats));
