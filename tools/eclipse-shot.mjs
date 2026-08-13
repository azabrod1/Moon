// Solar-eclipse surface-view capture harness: land(Earth) -> Observatory ->
// jumpEvent(solar-eclipse) -> lookUp (the sun-from-spot vantage) -> wheel-zoom,
// then screenshots at second offsets around the jump time with the full
// geometry (probe) and sun-optics (sunAppearance) state logged per frame.
//
//   node tools/eclipse-shot.mjs --label=annular --offsets=-180,0,180
//   node tools/eclipse-shot.mjs --iphone            # 390x844 @3x, iOS UA
//
// Prereq: dev server on :5174 (or pass --url=). PW_CHROMIUM pins the browser
// binary in pinned-browser environments.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

const url = arg('url', 'http://localhost:5174');
const label = arg('label', 'eclipse');
const outDir = path.join('/tmp/moon-shots', label);
const W = Number(arg('w', '900'));
const H = Number(arg('h', '1600'));
const offsets = arg('offsets', '-180,0').split(',').map(Number); // seconds vs peak-ish time

await mkdir(outDir, { recursive: true });

const useGpu = !process.argv.includes('--software');
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: useGpu
    ? ['--use-gl=angle', '--use-angle=vulkan', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader']
    : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

try {
  const iphone = process.argv.includes('--iphone');
  const context = await browser.newContext(
    iphone
      ? {
          viewport: { width: 390, height: 844 },
          deviceScaleFactor: 3,
          userAgent:
            'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
          hasTouch: true,
          isMobile: true,
        }
      : { viewport: { width: W, height: H }, deviceScaleFactor: 1 },
  );
  await context.addInitScript(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
      indexedDB.deleteDatabase('orbital-sim-storage');
      localStorage.setItem('planetarium-help-seen', '1');
      localStorage.setItem('planetarium-surface-hint-seen', '1');
    } catch { /* ignore */ }
  });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(`${url}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 60000 });
  await page.waitForFunction(() => {
    const ls = document.getElementById('loading-screen');
    return !ls || ls.classList.contains('hidden');
  }, { timeout: 60000 }).catch(() => {});

  await page.evaluate(() => window.__moon.land('Earth'));
  await page.waitForTimeout(4000);
  await page.evaluate(() => window.__moon.openObservatory());
  await page.waitForTimeout(1500);
  const jumped = await page.evaluate(() => window.__moon.jumpEvent('solar-eclipse', 1));
  console.log('[eclipse] jumpEvent ->', jumped);
  await page.waitForTimeout(5000);
  const looked = await page.evaluate(() => window.__moon.lookUp());
  console.log('[eclipse] lookUp ->', looked);
  await page.waitForTimeout(4000);
  // Zoom the surface view with real wheel events (surfaceFovDeg is pinch/wheel-owned).
  await page.mouse.move(W / 2, H * 0.5);
  for (let i = 0; i < 40; i++) {
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(80);
    const fov = (await page.evaluate(() => window.__moon.probeLanded()))?.surfaceFovDeg ?? 99;
    if (fov <= 2.1) break;
  }
  await page.waitForTimeout(1500);

  const state = await page.evaluate(() => ({
    probe: window.__moon.probeLanded(),
    timeMs: window.__moon.getTimeMs(),
  }));
  console.log('[eclipse] state', JSON.stringify(state));
  const baseMs = state.timeMs;

  const settleFrames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  for (const off of offsets) {
    await page.evaluate((t) => window.__moon.setTimeMs(t), baseMs + off * 1000);
    await page.waitForTimeout(1500);
    await settleFrames();
    const file = path.join(outDir, `t${off >= 0 ? '+' : ''}${off}.png`);
    await page.screenshot({ path: file });
    const geo = await page.evaluate(() => {
      const m = window.__moon.probe('Moon');
      const cam = m.camPos;
      // Direction vantage->body in world = bodyAbs - playerAbs - camPos? camPos is
      // scene-space (world - player). Scene pos of body = bodyAbs - playerAbs.
      const p = m.playerAbs;
      const moonScene = { x: m.bodyAbs.x - p.x, y: m.bodyAbs.y - p.y, z: m.bodyAbs.z - p.z };
      const sunScene = { x: -p.x, y: -p.y, z: -p.z };
      const v = (a) => ({ x: a.x - cam.x, y: a.y - cam.y, z: a.z - cam.z });
      const mv = v(moonScene), sv = v(sunScene);
      const len = (a) => Math.hypot(a.x, a.y, a.z);
      const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
      const sepDeg = Math.acos(Math.min(1, Math.max(-1, dot(mv, sv) / (len(mv) * len(sv))))) * 180 / Math.PI;
      const moonAngDeg = 2 * Math.atan(m.radiusAU / len(mv)) * 180 / Math.PI;
      return { sepDeg, moonAngDeg, moonDistAU: len(mv), probeLanded: window.__moon.probeLanded() };
    });
    console.log('[geo]', JSON.stringify(geo));
    const sun = await page.evaluate(() => window.__moon.sunAppearance());
    console.log('[sun]', JSON.stringify(sun));
    console.log('[eclipse]', new Date(baseMs + off * 1000).toISOString(), '->', file);
  }

  if (errors.length) {
    console.log(`[eclipse] page errors (${errors.length}):`);
    for (const e of errors.slice(0, 10)) console.log('    ', e);
  }
} finally {
  await browser.close();
}
