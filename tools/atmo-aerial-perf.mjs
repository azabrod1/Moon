// Frame time for aerial perspective, A/B on one session and one pose.
//
// The near band is where this costs anything: the hazed ground fills the frame,
// so every fragment pays two dependent 3D fetches for the in-scatter and two 2D
// fetches for the transmittance on top of what the globe already did. The shell
// is the cheap half — BackSide plus the depth test leave it shading a few
// degrees of annulus — so the A/B below is almost entirely the surfaces.
//
// A = the analytic tier (the dev pin, which turns the air off on the surfaces
// too), B = the LUT tier. One session, one pose, one canvas size: everything
// except the air is identical between the two halves.
//
// Or, with --timeB, A and B are two CLOCKS with the air on at both: the second
// source costs four dependent 3D fetches on every night fragment that has a
// Moon up, and the only way to see them is the same pose under a full Moon and
// under none. The pose's own clock has to be set on both sides of the framing —
// a pose is an absolute camera position worked out from where the body is, so
// moving the clock after it leaves the camera aimed at where Earth used to be.
//
// INTERLEAVED, A,B,A,B: one A followed by one B puts every slow drift in the
// machine — thermal throttling, the texture ladder still arriving, the exposure
// still settling — inside the difference the whole number is. Alternating and
// pooling cancels any drift that is linear over the run, and the per-pass rows
// below show what the drift was, so a delta smaller than the spread between
// passes can be read as the noise it is.
//
//   npx vite --port 5646 --strictPort
//   node tools/atmo-aerial-perf.mjs --url=http://localhost:5646
//   node tools/atmo-aerial-perf.mjs --w=1400 --h=1400 --dpr=2   # fill-bound
//   node tools/atmo-aerial-perf.mjs --repeats=3                 # A,B,A,B,A,B
//   node tools/atmo-aerial-perf.mjs --phase=150 \
//     --time=2026-03-19T01:00:00Z --timeB=2026-04-02T02:00:00Z   # new vs full Moon
//
// vsync is off. With it on, a 1.3 Mpx frame on a desktop GPU reports the
// display's period and measures the display.
const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const url = arg('url', 'http://localhost:5646');
const W = Number(arg('w', '390'));
const H = Number(arg('h', '844'));
const DPR = Number(arg('dpr', '2'));
const FRAMES = Number(arg('frames', '400'));
const AIM = Number(arg('aim', '0.72'));
const K = Number(arg('k', '1.05'));
// Where round the body the camera stands: 0 is the sub-solar side, 150 is past
// the terminator, which is the pose the non-solar sources cost anything at.
const PHASE = Number(arg('phase', '0'));
// How many A,B pairs. Two is the minimum that says anything about drift; the
// pass-to-pass spread is printed so it can be compared against the delta.
const REPEATS = Number(arg('repeats', '2'));
// The clock, because at night what the frame costs depends on whether there is
// a Moon in it: one that is up is four more dependent 3D fetches on every night
// fragment. Equinox noon is the set's own default; --timeB turns the A/B from
// the tier into the two clocks.
const TIME = Date.parse(arg('time', '2026-03-20T12:00:00Z'));
const TIME_B = arg('timeB', '') ? Date.parse(arg('timeB', '')) : null;

const { chromium } = await import('playwright');
const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader',
    // Otherwise every measurement comes back as the display's refresh period.
    '--disable-gpu-vsync', '--disable-frame-rate-limit',
  ],
});
const context = await browser.newContext({
  viewport: { width: W, height: H }, deviceScaleFactor: DPR, isMobile: true, hasTouch: true,
});
await context.addInitScript(() => {
  try {
    localStorage.clear(); sessionStorage.clear();
    indexedDB.deleteDatabase('orbital-sim-storage');
    localStorage.setItem('planetarium-help-seen', '1');
    localStorage.setItem('planetarium-surface-hint-seen', '1');
  } catch { /* storage blocked — harmless */ }
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`${url}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!(window.__moon?.ready?.()), { timeout: 60000 });
await page.waitForFunction(() => {
  const ls = document.getElementById('loading-screen');
  return !ls || ls.classList.contains('hidden');
}, { timeout: 60000 }).catch(() => {});
await page.evaluate(() => window.__moon.setChrome(false));
await page.evaluate((t) => window.__moon.setTimeMs(t), TIME);
await page.evaluate(() => window.__moon.setTimeRate(0));
const state = await page.waitForFunction(
  () => (window.__moon.atmoState()?.state === 'ready' ? window.__moon.atmoState() : null),
  { timeout: 45000 },
).then((h) => h.jsonValue()).catch(() => null);
if (!state) throw new Error('tables never baked — nothing to A/B');

async function measure(tier, timeMs) {
  const wearing = await page.evaluate((t) => window.__moon.atmoTier(t), tier);
  // The clock FIRST, then the framing, then the clock again: pinCapture is free
  // to move the camera's near plane and the framing hook reads where the body
  // is, so both ends of the pose have to be on the pose's own date.
  await page.evaluate((t) => window.__moon.setTimeMs(t), timeMs);
  await page.evaluate(([k, a, p]) => window.__moon.limbView('Earth', k, 60, p, a), [K, AIM, PHASE]);
  await page.evaluate(([d]) => window.__moon.pinCapture({ near: 1e-6, exposure: 1, pixelRatio: d }), [DPR]);
  await page.evaluate((t) => window.__moon.setTimeMs(t), timeMs);
  await page.waitForTimeout(1500); // settle: texture tiers, exposure, the swap itself
  const samples = await page.evaluate((n) => new Promise((resolve) => {
    const out = [];
    let last = performance.now();
    let warm = 60; // discard the first frames: the swap relinks nothing, but the cache is cold
    const step = () => {
      const now = performance.now();
      if (warm > 0) warm--; else out.push(now - last);
      last = now;
      if (out.length < n) requestAnimationFrame(step);
      else resolve(out);
    };
    requestAnimationFrame(step);
  }), FRAMES);
  // performance.now() is coarsened to 100 us without cross-origin isolation, so
  // a single frame's delta is quantised. The MEAN over a few hundred of them
  // recovers the resolution the quantisation hides, and it is the mean that
  // this A/B turns on.
  const mean = samples.reduce((x, y) => x + y, 0) / samples.length;
  samples.sort((a, b) => a - b);
  const pick = (q) => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))];
  const moon = await page.evaluate(() => window.__moon.atmoNight?.('Earth') ?? null);
  return {
    wearing: wearing?.Earth, mean, median: pick(0.5), p90: pick(0.9), min: samples[0],
    phaseDeg: moon?.phaseDeg ?? null,
  };
}

// Either the tier is the A/B (the air against no air) or the clock is (a Moon
// against none, on the tier that has one).
const SIDES = TIME_B === null
  ? { a: { label: 'air off', tier: 'analytic', time: TIME }, b: { label: 'air on ', tier: null, time: TIME } }
  : { a: { label: 'clock A', tier: null, time: TIME }, b: { label: 'clock B', tier: null, time: TIME_B } };

const passes = [];
for (let i = 0; i < REPEATS; i++) {
  passes.push({
    pass: i + 1,
    a: await measure(SIDES.a.tier, SIDES.a.time),
    b: await measure(SIDES.b.tier, SIDES.b.time),
  });
}
const mpx = (W * DPR * H * DPR) / 1e6;
console.log(`[aerial-perf] ${W}x${H} DPR ${DPR} = ${mpx.toFixed(2)} Mpx, pose ${K} R aim ${AIM}`
  + ` phase ${PHASE}, ${REPEATS} interleaved A,B pairs`);
for (const p of passes) {
  const phase = (m) => (m.phaseDeg === null ? 'none' : `${m.phaseDeg.toFixed(1)} deg`);
  console.log(`  pass ${p.pass}  ${SIDES.a.label} ${p.a.mean.toFixed(4)} ms (shell=${p.a.wearing}, moon ${phase(p.a)})`
    + `   ${SIDES.b.label} ${p.b.mean.toFixed(4)} ms (shell=${p.b.wearing}, moon ${phase(p.b)})`
    + `   delta ${(p.b.mean - p.a.mean >= 0 ? '+' : '')}${(p.b.mean - p.a.mean).toFixed(3)}`);
}
const mean = (xs) => xs.reduce((x, y) => x + y, 0) / xs.length;
const spread = (xs) => Math.max(...xs) - Math.min(...xs);
const aMean = mean(passes.map((p) => p.a.mean));
const bMean = mean(passes.map((p) => p.b.mean));
console.log(`  pooled   ${SIDES.a.label} ${aMean.toFixed(4)} ms (pass spread ${spread(passes.map((p) => p.a.mean)).toFixed(3)})`);
console.log(`           ${SIDES.b.label} ${bMean.toFixed(4)} ms (pass spread ${spread(passes.map((p) => p.b.mean)).toFixed(3)})`);
const d = bMean - aMean;
console.log(`  delta    ${d >= 0 ? '+' : ''}${d.toFixed(3)} ms  (${(d / mpx).toFixed(3)} ms/Mpx)`);
console.log(`  page errors ${errors.length}`);
await context.close();
await browser.close();
