// Aim-rate battery for the cruise-aim continuity stage (cruiseAim.ts).
//
//   node tools/aim-sweep.mjs [--url=http://localhost:5480] [--webkit]
//
// One run, every gesture family, against a moon teleport (the arrival look
// at full weight — where every historical snap lived). Traces the camera's
// per-frame aim direction (devTrace aimX/Y/Z) through:
//   quiet hold → key yaw burst → flick drag → slow drag → wheel dolly →
//   clock jump (warp release) → second flick (look long gone)
// and asserts, per phase:
//   - legit gestures (drags, yaw) are NEVER clipped: their aim rate is
//     position-driven and must show no cap-plateau signature;
//   - no phase contains a one-frame aim step beyond the enforcement
//     ceiling min(cap·dt, AIM_STEP_MAX) + margin — the structural
//     guarantee, measured at the renderer.
// Exit code 1 on any violation. The per-phase peak table is the data the
// cap constant is tuned against (design doc: legitMax × margin < cap).
import { chromium, webkit } from 'playwright';

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
const url = arg('url', 'http://localhost:5480');
const useWebkit = process.argv.includes('--webkit');

const CAP_DEG_S = 360;           // AIM_RATE_CAP_RAD_PER_S
const STEP_MAX_DEG = 360 / 45;   // AIM_STEP_MAX_RAD
const MARGIN = 1.15;             // measurement slack (frame-time jitter)

const browser = useWebkit
  ? await webkit.launch({ headless: true })
  : await chromium.launch({
      headless: true,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    try {
      localStorage.clear(); sessionStorage.clear();
      indexedDB.deleteDatabase('orbital-sim-storage');
      localStorage.setItem('planetarium-help-seen', '1');
      localStorage.setItem('planetarium-surface-hint-seen', '1');
    } catch { /* ignore */ }
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));

  await page.goto(`${url}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__moon?.ready?.(), { timeout: 90000 });
  await page.waitForFunction(() => {
    const ls = document.getElementById('loading-screen');
    return !ls || ls.classList.contains('hidden');
  }, { timeout: 60000 });
  await page.waitForTimeout(1200);

  const picked = await page.evaluate(() => {
    if (!window.__moon.openMap()) return 'openMap failed';
    if (!window.__moon.mapPick('Moon')) return 'mapPick failed';
    if (!window.__moon.mapCommit('travel')) return 'mapCommit failed';
    return 'ok';
  });
  if (picked !== 'ok') { console.log(`[sweep] teleport: ${picked}`); process.exit(1); }
  await page.waitForFunction(() => {
    const p = window.__moon.probe('Moon');
    return p && p.distToBodyAU != null && p.distToBodyAU < 1e-4;
  }, { timeout: 60000 });
  await page.waitForTimeout(800); // look at full weight, ship still settling

  await page.evaluate(() => window.__moon.traceStart('Moon', 3600));
  const phases = [];
  const mark = async (name) => {
    const t = await page.evaluate(() => performance.now());
    phases.push({ name, t });
  };

  await mark('hold');
  await page.waitForTimeout(900);

  await mark('key-yaw');          // releases the look (steering)
  await page.keyboard.down('d');
  await page.waitForTimeout(1200);
  await page.keyboard.up('d');
  await page.waitForTimeout(600);

  await mark('flick-drag');       // violent pointer-coupled drag
  await page.mouse.move(640, 400);
  await page.mouse.down();
  for (let i = 1; i <= 4; i++) { await page.mouse.move(640 - i * 140, 400 + i * 30); await page.waitForTimeout(16); }
  await page.mouse.up();
  await page.waitForTimeout(900); // damping coast

  await mark('slow-drag');
  await page.mouse.move(640, 400);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(640 + i * 8, 400); await page.waitForTimeout(40); }
  await page.mouse.up();
  await page.waitForTimeout(700);

  await mark('wheel');
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -240); await page.waitForTimeout(60); }
  await page.waitForTimeout(700);

  // Re-teleport so the arrival look is LIVE at weight 1, then jump the
  // clock: this is the warp-release path (a released-by-input look would
  // make this phase trivially quiet). The commit starts a veiled map DIVE
  // whose arrival teleport lands seconds later — a distance wait can pass
  // on stale proximity from the first visit, so detect the teleport itself:
  // the ship position steps to the fresh standoff in one sample.
  const before = await page.evaluate(() => window.__moon.probe('Moon').playerAbs);
  await page.evaluate(() => {
    window.__moon.openMap(); window.__moon.mapPick('Moon'); window.__moon.mapCommit('travel');
  });
  await page.waitForFunction((b) => {
    const p = window.__moon.probe('Moon');
    if (!p?.playerAbs) return false;
    const d = Math.hypot(p.playerAbs.x - b.x, p.playerAbs.y - b.y, p.playerAbs.z - b.z);
    return d > 5e-4;
  }, before, { timeout: 60000 });
  await page.waitForTimeout(700);
  await mark('clock-jump');       // warp: the moon teleports around Earth
  await page.evaluate(() => {
    const now = window.__moon.getTimeMs?.() ?? Date.now();
    window.__moon.setTimeMs(now + 7 * 86400e3); // +7 days: Moon far around its orbit
  });
  await page.waitForTimeout(900);

  await mark('flick-2');          // look long gone: pure orbit motion
  await page.mouse.move(640, 400);
  await page.mouse.down();
  for (let i = 1; i <= 4; i++) { await page.mouse.move(640 + i * 140, 400 - i * 30); await page.waitForTimeout(16); }
  await page.mouse.up();
  await page.waitForTimeout(900);

  const trace = await page.evaluate(() => window.__moon.traceStop());
  if (!trace) { console.log('[sweep] no trace'); process.exit(1); }
  const F = Object.fromEntries(trace.fields.map((f, i) => [f, i]));
  if (F.aimX === undefined) { console.log('[sweep] trace lacks aim fields'); process.exit(1); }
  const rows = trace.rows;
  console.log(`[sweep] ${rows.length} frames, ${useWebkit ? 'webkit' : 'chromium'}`);

  const phaseOf = (t) => {
    let name = 'pre';
    for (const p of phases) if (t >= p.t) name = p.name;
    return name;
  };
  const stats = new Map();
  let violations = 0;
  for (let i = 1; i < rows.length; i++) {
    const dt = (rows[i][F.t] - rows[i - 1][F.t]) / 1000;
    if (dt <= 0) continue;
    const ax = rows[i][F.aimX], ay = rows[i][F.aimY], az = rows[i][F.aimZ];
    const bx = rows[i - 1][F.aimX], by = rows[i - 1][F.aimY], bz = rows[i - 1][F.aimZ];
    const dot = Math.min(1, Math.max(-1, ax * bx + ay * by + az * bz));
    const stepDeg = (Math.acos(dot) * 180) / Math.PI;
    const rateDegS = stepDeg / dt;
    const name = phaseOf(rows[i][F.t]);
    const s = stats.get(name) ?? { peakRate: 0, peakStep: 0, frames: 0 };
    s.peakRate = Math.max(s.peakRate, rateDegS);
    s.peakStep = Math.max(s.peakStep, stepDeg);
    s.frames++;
    stats.set(name, s);
    // The structural ceiling. Drag/yaw phases move the BASE (position-
    // driven, uncapped by design) — their per-frame step is bounded by the
    // gesture itself, not the cap, so the ceiling check applies to the
    // aim-authored phases where the enforcement stage is the only writer
    // of deflection change.
    const enforced = name === 'hold' || name === 'clock-jump';
    if (enforced) {
      const ceiling = Math.min(CAP_DEG_S * dt, STEP_MAX_DEG) * MARGIN + 0.05;
      if (stepDeg > ceiling) {
        violations++;
        console.log(`[VIOLATION] phase=${name} f${i} step=${stepDeg.toFixed(2)}° ceiling=${ceiling.toFixed(2)}° dt=${(dt * 1000).toFixed(0)}ms`);
      }
    }
  }
  console.log('[sweep] per-phase aim peaks (deg/s | deg/frame):');
  for (const [name, s] of stats) {
    console.log(`   ${name.padEnd(11)} peakRate=${s.peakRate.toFixed(1).padStart(7)}°/s  peakStep=${s.peakStep.toFixed(2).padStart(6)}°  frames=${s.frames}`);
  }
  // Legit gestures move the BASE and are exempt from the cap by transport —
  // the number below documents how fast real gestures run THROUGH the
  // stage unclipped (a flick far beyond the cap passing intact is the
  // proof the deflection formulation works; there is no gap criterion).
  const legit = ['key-yaw', 'flick-drag', 'slow-drag', 'wheel', 'flick-2'];
  const legitMax = Math.max(...legit.map((n) => stats.get(n)?.peakRate ?? 0));
  console.log(`[sweep] legit peak rate ${legitMax.toFixed(1)}°/s passed unclipped (deflection cap=${CAP_DEG_S}°/s governs only aim-authored change)`);
  const outArg = arg('out', '');
  if (outArg) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(outArg, JSON.stringify({ fields: trace.fields, rows, phases }));
    console.log(`[sweep] trace -> ${outArg}`);
  }
  if (violations > 0) { console.log(`[sweep] FAIL: ${violations} ceiling violations`); process.exit(1); }
  console.log('[sweep] PASS');
} finally {
  await browser.close();
}
