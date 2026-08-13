// Repro + metrics for the near-Moon camera issues (dev server + __moon bridge).
//
//   node tools/stutter-probe.mjs --mode=turn   # keyboard yaw near Moon; stutter metric
//   node tools/stutter-probe.mjs --mode=tap    # mobile first-touch after teleport; snap metric
//   node tools/stutter-probe.mjs --mode=drag   # desktop first click-drag after teleport; snap metric
//
// Both modes: teleport to the Moon through the real map flow
// (openMap -> mapPick -> mapCommit('travel')), wait for arrival, trace the
// Moon's per-frame screen position via devTraceStart/Stop, and report
// frame-to-frame screen-velocity discontinuities. Also logs every texture
// tier request (textures/4k|8k) seen during the run.
import { chromium } from 'playwright';

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
const url = arg('url', 'http://localhost:5174');
const mode = arg('mode', 'turn');
const out = arg('out', '');

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
try {
  const isTap = mode === 'tap';
  const context = await browser.newContext(
    isTap
      ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
      : { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
  );
  await context.addInitScript(() => {
    try {
      localStorage.clear(); sessionStorage.clear();
      indexedDB.deleteDatabase('orbital-sim-storage');
      localStorage.setItem('planetarium-help-seen', '1');
      localStorage.setItem('planetarium-surface-hint-seen', '1');
    } catch { /* ignore */ }
  });
  const page = await context.newPage();
  const tierRequests = [];
  page.on('request', (r) => {
    const u = r.url();
    if (/textures\/(4k|8k)\//.test(u)) tierRequests.push({ t: Date.now(), url: u.split('/').slice(-2).join('/') });
  });
  page.on('response', (r) => {
    const u = r.url();
    if (/textures\/(4k|8k)\//.test(u)) console.log(`[tier] ${r.status()} ${u.split('/').slice(-2).join('/')}`);
  });
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));

  await page.goto(`${url}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__moon?.ready?.(), { timeout: 90000 });
  await page.waitForFunction(() => {
    const ls = document.getElementById('loading-screen');
    return !ls || ls.classList.contains('hidden');
  }, { timeout: 60000 });
  await page.waitForTimeout(1500);

  // Teleport to the Moon through the real travel flow.
  const picked = await page.evaluate(() => {
    if (!window.__moon.openMap()) return 'openMap failed';
    if (!window.__moon.mapPick('Moon')) return 'mapPick failed';
    if (!window.__moon.mapCommit('travel')) return 'mapCommit failed';
    return 'ok';
  });
  console.log(`[probe] teleport: ${picked}`);
  if (picked !== 'ok') process.exit(1);

  // Wait for arrival: distance to Moon stabilizes.
  await page.waitForFunction(() => {
    const p = window.__moon.probe('Moon');
    return p && p.distToBodyAU != null && p.distToBodyAU < 1e-4;
  }, { timeout: 60000 });
  // Drag mode probes the seconds right after arrival — the arrival camera
  // look is at full weight and the user's first instinct-click lands here.
  // The other modes let the approach/park finish first.
  if (mode !== 'drag') {
    await page.waitForFunction(() => {
      const p = window.__moon.probe('Moon');
      return p && p.moving === false;
    }, { timeout: 90000 }).catch(() => console.log('[probe] ship still moving after 90s — tracing anyway'));
  }
  const parked = await page.evaluate(() => window.__moon.probe('Moon'));
  console.log(`[probe] parked: ${JSON.stringify(parked)}`);

  await page.evaluate(() => window.__moon.traceStart('Moon', 1200));

  if (isTap) {
    // First touch after teleport — the reported snap. A held touch via CDP so
    // the game loop sees it even at low headless frame rates.
    const cdp = await context.newCDPSession(page);
    const hold = async (x, y, ms) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      await page.waitForTimeout(ms);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    await page.waitForTimeout(500);
    await hold(300, 300, 1500);
    await page.waitForTimeout(1500);
    // Second touch for comparison (arrival look already cancelled).
    await hold(300, 300, 1500);
    await page.waitForTimeout(1500);
  } else if (mode === 'drag') {
    // Desktop first click-drag after teleport: a mouse press that moves a few
    // pixels — the smallest gesture that crosses the 4px orbit-drag threshold.
    const drag = async (px) => {
      await page.mouse.move(640, 400);
      await page.mouse.down();
      for (let i = 1; i <= 6; i++) {
        await page.mouse.move(640 + (px * i) / 6, 400);
        await page.waitForTimeout(32);
      }
      await page.mouse.up();
    };
    await page.waitForTimeout(500);
    await drag(24);
    await page.waitForTimeout(1500);
    // Second drag for comparison (arrival look already cancelled).
    await drag(24);
    await page.waitForTimeout(1500);
  } else {
    await page.waitForTimeout(500);     // quiet lead-in
    await page.keyboard.down('d');      // yaw right
    await page.waitForTimeout(2000);
    await page.keyboard.up('d');
    await page.waitForTimeout(800);
  }

  const trace = await page.evaluate(() => window.__moon.traceStop());
  if (!trace) { console.log('no trace'); process.exit(1); }
  const F = Object.fromEntries(trace.fields.map((f, i) => [f, i]));
  const rows = trace.rows;
  console.log(`[trace] ${rows.length} frames, fields: ${trace.fields.join(',')}`);

  // Screen-velocity discontinuity analysis on the Moon's projected position.
  const samples = [];
  for (let i = 1; i < rows.length; i++) {
    const dt = (rows[i][F.t] - rows[i - 1][F.t]) / 1000;
    if (dt <= 0) continue;
    const vx = (rows[i][F.scrX] - rows[i - 1][F.scrX]) / dt;
    const vy = (rows[i][F.scrY] - rows[i - 1][F.scrY]) / dt;
    const cam = [rows[i][F.camX], rows[i][F.camY], rows[i][F.camZ]];
    const moon = [rows[i][F.moonX], rows[i][F.moonY], rows[i][F.moonZ]];
    const dist = Math.hypot(cam[0] - moon[0], cam[1] - moon[1], cam[2] - moon[2]);
    samples.push({ i, t: rows[i][F.t], dtMs: dt * 1000, vx, vy, distAU: dist, discPx: rows[i][F.discPx] });
  }
  // Jerk: change in screen velocity between consecutive frames (px/s per frame).
  const jerks = [];
  for (let i = 1; i < samples.length; i++) {
    const dj = Math.hypot(samples[i].vx - samples[i - 1].vx, samples[i].vy - samples[i - 1].vy);
    jerks.push({ i: samples[i].i, t: samples[i].t, dj, dtMs: samples[i].dtMs, distAU: samples[i].distAU });
  }
  if (isTap || mode === 'drag') {
    console.log(`[${mode}] per-frame moon screen position:`);
    for (const s of samples) {
      console.log(`   f${s.i} t=${Math.round(s.t)} dt=${s.dtMs.toFixed(0)}ms scr=(${rows[s.i][F.scrX].toFixed(1)},${rows[s.i][F.scrY].toFixed(1)}) disc=${s.discPx.toFixed(0)}px`);
    }
  }
  const sorted = jerks.slice().sort((a, b) => b.dj - a.dj);
  const med = sorted[Math.floor(sorted.length / 2)]?.dj ?? 0;
  console.log(`[stutter] frames=${samples.length} medianJerk=${med.toFixed(1)}px/s  p95=${sorted[Math.floor(sorted.length * 0.05)]?.dj.toFixed(1)}px/s`);
  console.log('[stutter] top-10 discontinuities (frame, t(ms), Δv px/s, frame dt ms, dist AU):');
  for (const j of sorted.slice(0, 10)) {
    console.log(`   f${j.i}  t=${Math.round(j.t)}  dv=${j.dj.toFixed(1)}  dt=${j.dtMs.toFixed(1)}  dist=${j.distAU.toExponential(3)}`);
  }
  // Distance floor detection (safety-shell clamp signature): count frames at ~identical minimum distance.
  const dmin = Math.min(...samples.map((s) => s.distAU));
  const atFloor = samples.filter((s) => s.distAU < dmin * 1.0005).length;
  console.log(`[shell] min cam-moon dist=${dmin.toExponential(4)} AU, frames within 0.05% of it: ${atFloor}`);
  console.log(`[tiers] requests: ${JSON.stringify(tierRequests.map((r) => r.url))}`);

  if (out) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(out, JSON.stringify({ fields: trace.fields, rows, tierRequests }, null, 0));
    console.log(`[trace] saved -> ${out}`);
  }
} finally {
  await browser.close();
}
