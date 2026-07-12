// Headless screenshot harness for the Planetarium.
//
// Drives the running Vite dev server through the `window.__moon` dev bridge
// (installed by src/main.ts under DEV): pose the camera at each body, let it
// settle, capture a PNG. Outputs one folder per run so phases compare cleanly.
//
// Prereq: dev server running (`npm run dev`). Then:
//   node tools/shoot.mjs --label=phase1 --bodies=Earth,Jupiter,Saturn
//   node tools/shoot.mjs --time=2026-06-14T00:00:00Z --fill=0.85
//   node tools/shoot.mjs --label=crescent --phase=145   # back-lit crescent
//
// Renders on the real GPU (ANGLE/Metal) by default; pass --software to force
// SwiftShader if a machine's headless GPU path returns black frames.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

const url = arg('url', 'http://localhost:5174');
const label = arg('label', 'shot');
const outDir = arg('out', path.join('/tmp/moon-shots', label));
const bodies = arg('bodies', 'Mercury,Venus,Earth,Mars,Jupiter,Saturn,Uranus,Neptune,Pluto')
  .split(',').map((s) => s.trim()).filter(Boolean);
const timeIso = arg('time', '');
const fill = Number(arg('fill', '0.6'));
const phase = Number(arg('phase', '0')); // Sun-planet-camera angle; 0 lit, ~145 back-lit crescent
const W = Number(arg('w', '1600'));
const H = Number(arg('h', '900'));
const settle = Number(arg('settle', '2500'));

await mkdir(outDir, { recursive: true });

// GPU (ANGLE/Metal) by default — ~15x less CPU than software and renders
// identically here. Pass --software to force SwiftShader if a machine's
// headless GPU path returns black frames.
const useGpu = !process.argv.includes('--software');
const browser = await chromium.launch({
  headless: true,
  args: useGpu
    ? ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader']
    : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
console.log(`[shoot] renderer: ${useGpu ? 'GPU (ANGLE/Metal)' : 'software (SwiftShader)'}`);

let captured = 0;
try {
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  // Mark first-run overlays as already seen so they don't cover the scene.
  await context.addInitScript(() => {
    try {
      // Clean slate so the "Welcome back" resume prompt (PlanetariumStore finds a
      // saved journey) never pre-empts ?auto=planetarium's straight-to-scene entry.
      localStorage.clear();
      sessionStorage.clear();
      indexedDB.deleteDatabase('orbital-sim-storage');
      localStorage.setItem('planetarium-help-seen', '1');
      localStorage.setItem('planetarium-surface-hint-seen', '1');
    } catch { /* storage blocked — harmless */ }
  });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const target = `${url}/?auto=planetarium`;
  console.log(`[shoot] ${target} -> ${outDir}`);
  await page.goto(target, { waitUntil: 'domcontentloaded' });

  // Wait for the dev bridge + solar system, then for the loading overlay to clear.
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 45000 });
  await page.waitForFunction(() => {
    const ls = document.getElementById('loading-screen');
    return !ls || ls.classList.contains('hidden');
  }, { timeout: 45000 }).catch(() => {});

  // Clean shot: drop the spacecraft, HUD, orbit lines, and labels.
  await page.evaluate(() => window.__moon.setChrome(false));

  if (timeIso) {
    const ms = Date.parse(timeIso);
    if (!Number.isNaN(ms)) await page.evaluate((t) => window.__moon.setTimeMs(t), ms);
  }

  const known = await page.evaluate(() => window.__moon.bodies());
  console.log(`[shoot] bodies available: ${known.join(', ')}`);

  // Let textures finish their first upload before the first capture.
  await page.waitForTimeout(1500);
  const settleFrames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  for (const body of bodies) {
    const ok = await page.evaluate(([n, f, p]) => window.__moon.frame(n, f, p), [body, fill, phase]);
    if (!ok) { console.log(`[shoot] SKIP ${body} (not a top-level planet)`); continue; }
    await page.waitForTimeout(settle);
    await settleFrames();
    const probe = await page.evaluate((n) => window.__moon.probe(n), body);
    console.log(`[probe] ${body} ${JSON.stringify(probe)}`);
    const file = path.join(outDir, `${body}.png`);
    await page.screenshot({ path: file });
    captured++;
    console.log(`[shoot] ${body} -> ${file}`);
  }

  if (errors.length) {
    console.log(`[shoot] page errors (${errors.length}):`);
    for (const e of errors.slice(0, 10)) console.log('    ', e);
  }
} finally {
  await browser.close();
}

console.log(`[shoot] done: ${captured}/${bodies.length} captured in ${outDir}`);
if (captured === 0) process.exit(1);
