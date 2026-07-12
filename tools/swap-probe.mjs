// Reproduce the Observatory "stand on Earth / stand on Moon back-and-forth
// shrinks the subject" bug. Drives the real landing path via the dev bridge
// (window.__moon.land / lookUp / swapVantage / probeLanded) and records the
// subject's on-screen fill fraction after each vantage swap.
//
//   node tools/swap-probe.mjs            # default localhost:5181
//   node tools/swap-probe.mjs --url=http://localhost:5174 --n=14
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

const url = arg('url', 'http://localhost:5181');
const N = Number(arg('n', '14'));
const timeIso = arg('time', '2026-06-17T00:00:00Z');
const outDir = arg('out', '/tmp/moon-shots/swap-bug');
const W = Number(arg('w', '1600'));
const H = Number(arg('h', '900'));
const useGpu = !process.argv.includes('--software');

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: useGpu
    ? ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader']
    : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
console.log(`[swap] renderer: ${useGpu ? 'GPU (ANGLE/Metal)' : 'software (SwiftShader)'}`);

const fmt = (p) =>
  `${String(p.landedOn?.name ?? '-').padEnd(6)} ${p.view.padEnd(7)} ` +
  `fov=${p.fov.toFixed(3).padStart(8)} subj∅=${p.subjectAngularDeg.toFixed(4).padStart(9)}° ` +
  `fill=${(p.subjectFillFraction * 100).toFixed(3).padStart(8)}%  [${p.subjectName}]`;

try {
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
      indexedDB.deleteDatabase('orbital-sim-storage');
      localStorage.setItem('planetarium-help-seen', '1');
      localStorage.setItem('planetarium-surface-hint-seen', '1');
    } catch { /* storage blocked */ }
  });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(`${url}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 45000 });
  await page.waitForFunction(() => {
    const ls = document.getElementById('loading-screen');
    return !ls || ls.classList.contains('hidden');
  }, { timeout: 45000 }).catch(() => {});

  const ms = Date.parse(timeIso);
  if (!Number.isNaN(ms)) await page.evaluate((t) => window.__moon.setTimeMs(t), ms);
  await page.waitForTimeout(800);

  const settle = async (msWait) => {
    await page.waitForTimeout(msWait);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  };
  const probe = () => page.evaluate(() => window.__moon.probeLanded());

  // ---- Scenario A: ORBIT-view vantage swaps ----
  console.log('\n=== ORBIT swaps (land Earth, then swap back and forth) ===');
  await page.evaluate(() => window.__moon.land('Earth'));
  await settle(900);
  console.log(`  0  ${fmt(await probe())}`);
  for (let i = 1; i <= N; i++) {
    await page.evaluate(() => window.__moon.swapVantage());
    await settle(750);
    console.log(`  ${String(i).padStart(2)} ${fmt(await probe())}`);
  }

  // ---- Scenario B: SURFACE-view vantage swaps (with screenshots) ----
  console.log('\n=== SURFACE swaps (land Earth, Look up, then swap back and forth) ===');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 45000 });
  if (!Number.isNaN(ms)) await page.evaluate((t) => window.__moon.setTimeMs(t), ms);
  await page.waitForTimeout(800);

  await page.evaluate(() => window.__moon.land('Earth'));
  await settle(400);
  await page.evaluate(() => window.__moon.lookUp());
  await settle(1100);
  await page.evaluate(() => window.__moon.setChrome(false));
  await settle(300);
  const shoot = (i, p) =>
    page.screenshot({ path: path.join(outDir, `surf_${String(i).padStart(2, '0')}_${p.landedOn?.name ?? 'x'}.png`) });
  let p0 = await probe();
  console.log(`  0  ${fmt(p0)}`);
  await shoot(0, p0);
  for (let i = 1; i <= N; i++) {
    await page.evaluate(() => window.__moon.swapVantage());
    await settle(750);
    const p = await probe();
    console.log(`  ${String(i).padStart(2)} ${fmt(p)}`);
    if (i % 2 === 0 || i <= 2 || i === N) await shoot(i, p);
  }

  if (errors.length) {
    console.log(`\n[swap] page errors (${errors.length}):`);
    for (const e of errors.slice(0, 10)) console.log('    ', e);
  }
  console.log(`\n[swap] screenshots in ${outDir}`);
} finally {
  await browser.close();
}
