// Asserting regression battery for teleport arrivals (the drive-by): drives
// the REAL map-Travel funnel per target, records the authored pose from
// __moon.arrivalPose() and a 100 ms trace of distance + speed + governor
// owner, then asserts the arrival contract:
//   drop at the authored standoff (planets ~8.8 radii), a pass at the
//   authored impact parameter — 1.8 rendered radii, or the hull clearance
//   floor where that is wider, which is the moonlet case — never a graze,
//   no foreign body BINDING the speed cap on the approach (the Deimos
//   signature), and a completed departure. No arrival parks: the smallest
//   moons in the catalogue fly the same pass as the Moon.
// The clock is PINNED per scenario: incidental-moon encounters are epoch
// lottery, so a drifting epoch would make failures unreproducible.
//
// Usage: node tools/flyby-probe.mjs [comma-separated target keys]
//   MOON_URL=http://localhost:5173/ overrides the dev server.
// Exit code 0 = every assertion on every target passed.
import { chromium } from 'playwright';

const URL_BASE = process.env.MOON_URL || 'http://localhost:5173/';
// Fixed epoch for every run (2026-08-22T00:00Z) + a second Mars epoch 10
// days on, hunting the moon-lane lottery deterministically.
const EPOCH_MS = Date.UTC(2026, 7, 22);

const ALL = [
  { key: 'mars', name: 'Mars', ms: 45_000 },
  { key: 'mars-epoch2', name: 'Mars', ms: 45_000, epochMs: EPOCH_MS + 10 * 86400e3 },
  { key: 'mercury', name: 'Mercury', ms: 40_000 },
  { key: 'venus', name: 'Venus', ms: 45_000 },
  { key: 'jupiter', name: 'Jupiter', ms: 60_000 },
  { key: 'saturn', name: 'Saturn', ms: 60_000 },
  { key: 'uranus', name: 'Uranus', ms: 60_000 },
  // Uranus at its ~2030 solstice: the ring pole rides the sun line — the
  // pole-on geometry the candidate fan must rotate away from.
  { key: 'uranus-2030', name: 'Uranus', ms: 60_000, epochMs: Date.UTC(2030, 9, 1) },
  { key: 'neptune', name: 'Neptune', ms: 60_000 },
  { key: 'pluto', name: 'Pluto', ms: 45_000 },
  { key: 'io', name: 'Io', ms: 30_000, parent: 'Jupiter' },
  { key: 'ganymede', name: 'Ganymede', ms: 30_000, parent: 'Jupiter' },
  // The two smallest passes in the battery — the ex-park class. Their whole
  // encounter fits inside the camera boom, so the window is the moonlet
  // glide's own timeline, not the boom's. Styx gets the long one: its
  // authored miss clears the collision shell by 10 km, the pass grazes it,
  // and the graze costs it roughly twice Deimos's time to settle and sling
  // (measured 31.7 s against 16.1 s).
  { key: 'deimos', name: 'Deimos', ms: 30_000, parent: 'Mars' },
  { key: 'styx', name: 'Styx', ms: 60_000, parent: 'Pluto' },
];
const only = process.argv[2] ? process.argv[2].split(',') : null;
const TARGETS = only ? ALL.filter((t) => only.includes(t.key)) : ALL;

const IMPACT_RADII = 1.8;
const failures = [];
const note = (target, ok, label, detail) => {
  const line = `${ok ? '  ok ' : 'FAIL '} ${target.padEnd(12)} ${label}${detail ? `  (${detail})` : ''}`;
  console.log(line);
  if (!ok) failures.push(line);
};

const v3 = (a) => ({ x: a[0], y: a[1], z: a[2] });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const len = (a) => Math.hypot(a.x, a.y, a.z);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const kmS = (text) => {
  const m = /([\d,]+) km\/s/.exec(text ?? '');
  return m ? Number(m[1].replaceAll(',', '')) : null;
};

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});

for (const T of TARGETS) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
      indexedDB.deleteDatabase('orbital-sim-storage');
    } catch { /* fresh-profile best effort */ }
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => !!(window.__moon && window.__moon.ready() === true),
    undefined,
    { timeout: 120_000 },
  );

  // First-run help card silently blocks openMap().
  for (let i = 0; i < 3; i++) {
    const open = await page.evaluate(
      () => !!document.querySelector('#planetarium-help.visible'),
    );
    if (!open) break;
    const btn = await page.$('#planetarium-help .planetarium-help-card button');
    if (btn) await btn.click().catch(() => {});
    else await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
  }

  await page.evaluate((ms) => window.__moon.setTimeMs(ms), T.epochMs ?? EPOCH_MS);
  await page.waitForTimeout(800);

  const opened = await page.evaluate(() => window.__moon.openMap());
  await page.waitForTimeout(1500);
  const picked = await page.evaluate((n) => window.__moon.mapPick(n), T.name);
  await page.waitForTimeout(600);
  const committed = await page.evaluate((n) => {
    window.__trace = [];
    const t0 = performance.now();
    window.__traceTimer = setInterval(() => {
      const p = window.__moon.probe(n);
      const o = window.__moon.governorOwner();
      window.__trace.push({
        t: (performance.now() - t0) / 1000,
        dist: p && p.distToBodyAU,
        moving: p && p.moving,
        owner: o && o.name,
        binding: !!(o && o.binding),
        speedKmS: (() => {
          const m = /([\d,]+) km\/s/.exec(
            (document.getElementById('stat-speed') || {}).textContent ?? '',
          );
          return m ? Number(m[1].replaceAll(',', '')) : null;
        })(),
      });
    }, 100);
    return window.__moon.mapCommit('travel');
  }, T.name);

  await page.waitForTimeout(T.ms);
  const trace = await page.evaluate(() => {
    clearInterval(window.__traceTimer);
    return window.__trace;
  });
  const pose = await page.evaluate(() => window.__moon.arrivalPose());
  await context.close();

  note(T.key, opened && picked && committed, 'funnel opened/picked/committed',
    `${opened}/${picked}/${committed}`);
  note(T.key, errors.length === 0, 'no page errors', errors.join('; ').slice(0, 120));
  if (!pose) {
    note(T.key, false, 'authored pose recorded');
    continue;
  }
  note(T.key, pose.body === T.name, 'pose is for this target', pose.body);

  const pos = v3(pose.position);
  const aim = v3(pose.aimPoint);
  const body = v3(pose.bodyPosition);
  const R = pose.renderedRAU;
  const sep = len(sub(pos, body));
  note(T.key, Math.abs(sep - pose.standoffAU) < 1e-9 * Math.max(sep, 1e-9),
    'drop sits exactly at the authored standoff');

  const samples = trace.filter((s) => Number.isFinite(s.dist));
  const perigee = samples.reduce((m, s) => Math.min(m, s.dist), Infinity);
  const perigeeIdx = samples.findIndex((s) => s.dist === perigee);

  if (!T.parent) {
    const ratio = pose.standoffAU / R;
    note(T.key, ratio > 8.5 && ratio < 9.2, 'planet standoff ~8.8 radii', ratio.toFixed(3));
  }
  // Authored b comes straight off the pose record (the aim point includes
  // the one-shot lead, so re-deriving from the jump-time center is off by
  // exactly the lead); the ray check below still guards gross aim breakage.
  // The law is max(1.8 rendered radii, the hull clearance floor): the pad
  // does not shrink with the mesh, so at moonlet scale the floor is the
  // wider term and the pass flies it instead.
  const bAU = pose.bAU ?? IMPACT_RADII * R;
  const bLaw = Math.max(IMPACT_RADII * R, 1.15 * pose.shellAU);
  note(T.key, bAU > 0.98 * bLaw && bAU < 1.06 * bLaw,
    'authored b is max(1.8 radii, clearance floor)',
    `${(bAU / bLaw).toFixed(4)} of law, ${(bAU / R).toFixed(2)} R`);
  // Measured against the LED centre, not the jump-time one: the aim is
  // composed around where the body will be at closest approach, and at
  // moonlet scale that lead is several times the impact parameter itself
  // (Deimos and Styx read 1.74x against the jump-time centre while their
  // FLOWN perigees sit on the authored b).
  const aimCentre = v3(pose.aimCenter);
  const u = sub(aim, pos);
  const uLen = len(u);
  const un = { x: u.x / uLen, y: u.y / uLen, z: u.z / uLen };
  const rel = sub(aimCentre, pos);
  const along = Math.max(dot(rel, un), 0);
  const missAU = len(sub(rel, { x: un.x * along, y: un.y * along, z: un.z * along }));
  const authored = missAU / bAU;
  note(T.key, authored > 0.9 && authored < 1.1, 'aim ray passes the led centre at the authored b',
    authored.toFixed(4));

  const measured = perigee / bAU;
  note(T.key, measured > 0.85 && measured < 1.25, 'measured perigee near authored',
    measured.toFixed(4));
  note(T.key, perigee >= 1.2 * R, 'never a graze', `${(perigee / R).toFixed(3)} R`);

  // The dance test, the product contract itself: on the glide (inside 0.8
  // standoffs, above the sling zone where the cap legitimately opens), speed
  // never RISES more than 5% sample-to-sample. A foreign body may shadow the
  // cap — that reads as a slightly conservative glide — but only while it
  // stays within 0.80 of the target's own law; below that it surges on
  // release (measured: 0.83 shadows seamlessly, 0.54 dances).
  const KM_PER_AU = 1.496e8;
  const glide = samples.filter((s, i) =>
    i <= perigeeIdx && s.dist < pose.standoffAU * 0.8 && s.dist > R * 2.5 &&
    Number.isFinite(s.speedKmS));
  let rises = 0;
  for (let i = 1; i < glide.length; i++) {
    if (glide[i].speedKmS > glide[i - 1].speedKmS * 1.05) rises++;
  }
  note(T.key, rises === 0, 'no speed surges on the glide (the dance test)',
    rises ? `${rises} rises` : '');

  const okOwners = new Set([T.name, T.parent].filter(Boolean));
  const deepForeign = glide.filter((s) => {
    if (!s.binding || !s.owner || okOwners.has(s.owner)) return false;
    const targetLawKmS = 0.25 * Math.max(s.dist - R, 0) * KM_PER_AU;
    return targetLawKmS > 0 && s.speedKmS < targetLawKmS * 0.8;
  });
  note(T.key, deepForeign.length === 0,
    'no foreign body suppresses the glide below 0.8 of the target law',
    deepForeign.length
      ? `${deepForeign.length} samples, first ${deepForeign[0].owner} @ t=${deepForeign[0].t.toFixed(1)}s`
      : '');

  // Departure: the pass completes and the ship genuinely leaves.
  const last = samples[samples.length - 1];
  note(T.key, perigeeIdx < samples.length - 5 && last.dist > perigee * 2,
    'pass completes and departs', `final ${(last.dist / R).toFixed(1)} R`);
}

await browser.close();
console.log(failures.length ? `\n${failures.length} FAILURES` : '\nALL PASS');
process.exit(failures.length ? 1 : 0);
