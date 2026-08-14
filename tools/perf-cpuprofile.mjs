// CPU-profile the Planetarium boot: starts a V8 sampling profile before
// navigation, stops after the loading screen hides (+ settle), and prints the
// top functions by self time. Run against a served build:
//   node tools/perf-cpuprofile.mjs --url=http://localhost:4173
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
const url = arg('url', 'http://localhost:4173');
const out = arg('out', '/tmp/moon-perf/boot.cpuprofile');
const settleMs = Number(arg('settle', '6000'));

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  await context.addInitScript(() => {
    try {
      localStorage.clear(); sessionStorage.clear();
      indexedDB.deleteDatabase('orbital-sim-storage');
      localStorage.setItem('planetarium-help-seen', '1');
      localStorage.setItem('planetarium-surface-hint-seen', '1');
    } catch { /* ignore */ }
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await cdp.send('Profiler.start');

  await page.goto(`${url}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const ls = document.getElementById('loading-screen');
    return ls && ls.classList.contains('hidden');
  }, { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(settleMs);

  const { profile } = await cdp.send('Profiler.stop');
  await writeFile(out, JSON.stringify(profile));

  // Aggregate self time per node.
  const dt = [];
  for (let i = 1; i < profile.timeDeltas.length; i++) dt.push(profile.timeDeltas[i]);
  const selfUs = new Map();
  for (let i = 1; i < profile.samples.length; i++) {
    const id = profile.samples[i];
    selfUs.set(id, (selfUs.get(id) || 0) + profile.timeDeltas[i]);
  }
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const rows = [...selfUs.entries()]
    .map(([id, us]) => ({ n: byId.get(id), us }))
    .filter((r) => r.n)
    .sort((a, b) => b.us - a.us)
    .slice(0, 30);
  const total = [...selfUs.values()].reduce((a, b) => a + b, 0);
  console.log(`total sampled: ${(total / 1e6).toFixed(1)}s -> ${out}`);
  for (const r of rows) {
    const f = r.n.callFrame;
    const loc = f.url ? `${f.url.split('/').pop()}:${f.lineNumber}` : '';
    console.log(`${(r.us / 1e6).toFixed(2)}s  ${f.functionName || '(anonymous)'}  ${loc}`);
  }
} finally {
  await browser.close();
}
