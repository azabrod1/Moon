// Comprehensive surface-view ("Look up") framing sweep across every system.
// For each landable body: land → lookUp → probe the entry FOV, on-screen fill,
// target, whether the view actually activated, and how long lookUp took (lag).
// Catches regressions where tuning Earth/Moon quietly breaks other systems, and
// the reported "Look up on a Jupiter moon does nothing / lags" bug.
//
//   node tools/surface-sweep.mjs
import { chromium } from 'playwright';

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
const url = arg('url', 'http://localhost:5181');
const timeIso = arg('time', '2026-06-17T00:00:00Z');
const useGpu = !process.argv.includes('--software');

// Representative landable bodies per system (moons indented under their parent).
const BODIES = [
  'Mercury', 'Venus', 'Earth', 'Moon', 'Mars', 'Phobos', 'Deimos',
  'Jupiter', 'Io', 'Europa', 'Ganymede', 'Callisto', 'Amalthea', 'Metis',
  'Saturn', 'Mimas', 'Titan', 'Iapetus', 'Phoebe',
  'Uranus', 'Miranda', 'Titania', 'Oberon',
  'Neptune', 'Triton', 'Nereid',
  'Pluto', 'Charon',
];

const browser = await chromium.launch({
  headless: true,
  args: useGpu
    ? ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader']
    : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
console.log(`[sweep] renderer: ${useGpu ? 'GPU (ANGLE/Metal)' : 'software'}`);

try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    try {
      localStorage.clear(); sessionStorage.clear();
      indexedDB.deleteDatabase('orbital-sim-storage');
      localStorage.setItem('planetarium-help-seen', '1');
      localStorage.setItem('planetarium-surface-hint-seen', '1');
    } catch { /* */ }
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

  const settle = async (w) => { await page.waitForTimeout(w); await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); };

  console.log('body        landed look  ms   fov     fill%    subj∅     target');
  console.log('─'.repeat(86));
  for (const body of BODIES) {
    // Return to orbit + land fresh each time.
    const landed = await page.evaluate((b) => {
      if (window.__moon.exitSurface) window.__moon.exitSurface();
      return window.__moon.land(b);
    }, body);
    if (!landed) { console.log(`${body.padEnd(11)} NO (not landable / unknown name)`); continue; }
    await settle(500); // let the painter/positions settle, as on arrival
    const t0 = Date.now();
    const looked = await page.evaluate(() => window.__moon.lookUp());
    await settle(900);
    const lookMs = Date.now() - t0;
    const p = await page.evaluate(() => window.__moon.probeLanded());
    const active = p.view === 'surface' ? 'yes' : 'NO!';
    const indent = ['Mercury','Venus','Earth','Mars','Jupiter','Saturn','Uranus','Neptune','Pluto'].includes(body) ? '' : '  ';
    console.log(
      `${(indent + body).padEnd(11)} yes    ${active.padEnd(4)} ${String(lookMs).padStart(4)} ` +
      `${p.fov.toFixed(2).padStart(7)} ${(p.subjectFillFraction * 100).toFixed(2).padStart(7)} ` +
      `${p.subjectAngularDeg.toFixed(3).padStart(8)}  ${p.subjectName}` + (looked ? '' : '  (lookUp=false)'),
    );
    // Back to orbit for the next land.
    await page.evaluate(() => { if (window.__moon.exitSurface) window.__moon.exitSurface(); });
    await settle(150);
  }

  if (errors.length) {
    console.log(`\n[sweep] page errors (${errors.length}):`);
    for (const e of errors.slice(0, 12)) console.log('   ', e);
  }
} finally {
  await browser.close();
}
