// The sector-streaming regression battery: one asserting run over the two
// memory managers that share this app's GPU envelope — the sector tile
// streamer and the globe texture ladder.
//
// These are the only things that exercise the three orchestration rules the
// unit suite cannot reach: that a blocked admission for a rung a body is
// earning counts as pressure, that pressure must hold before a map is given
// back, and that a globe left on a stand-in is re-fetched before anything
// discretionary is released. They ran as scratch scripts through the whole
// HD/zoom quest; they live here so a later change is measured against them
// rather than against memory.
//
//   node tools/sector-probe.mjs
//   node tools/sector-probe.mjs --scenario=budget,sweep
//   node tools/sector-probe.mjs --url=http://localhost:5676 --tiles=http://localhost:5622/
//
// Prereqs: a dev server for this checkout (`npx vite --port 5676 --strictPort`)
// and, for the levels the app does not ship inside itself, a tile host
// (`node planning/_tiles-serve.mjs --port=5622`) named with --tiles.
//
// Runs ONE browser and ONE tab at a time on the real GPU: a second WebGL tab
// steals the GPU process and every byte figure below becomes fiction. That is
// enforced machine-wide rather than by convention — this takes
// /tmp/moon-browser.lock and waits for it, as every browser run here does.
//
// Scenarios:
//   budget    Desktop. Six poses; every 250 ms sample must satisfy
//             resident + reserved <= budget, and stay under the desktop ceiling.
//   touch     A 390x844 iPhone context: the same, under the touch ceiling.
//   tour      Six planets then Earth. The ladder used to keep every map it had
//             ever fetched, which left the tiles under one set for the rest of
//             the session; the maps must come back and the floor must hold.
//   envelope  The device -> class -> row switch, live, on four contexts
//             (Apple phone, Apple tablet, Android phone, WebKit) plus the
//             Moon's top rung on the phone against a desktop control.
//   gpu       A real GPU-object leak oracle: createTexture/deleteTexture are
//             counted from before any app code runs, over approach/flee cycles.
//   sweep     Distance sweep at a fixed display FOV: where admission dies.
import { chromium, webkit } from 'playwright';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MiB = 1048576;
/** One Earth day set — colour tile plus its two crops — as the room-for-one-
 *  more-set arithmetic below counts it. */
const EARTH_SET_BYTES = 23.128 * MiB;
/** The clock every scenario pins, so two runs measure the same sub-solar
 *  point: the terminator moves a fraction of a degree between wall-clock runs
 *  and that is a few per cent on the night family's demand. */
const CLOCK_MS = Date.parse('2026-06-14T11:00:00Z');

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1';
const IPAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Safari/605.1.15';
const PIXEL_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36';

const CONTEXTS = {
  desktop: { viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 },
  phone: {
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3,
    hasTouch: true, isMobile: true, userAgent: IPHONE_UA,
  },
  android: {
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625,
    hasTouch: true, isMobile: true, userAgent: PIXEL_UA,
  },
};

function arg(name, fallback) {
  const found = process.argv.find((v) => v.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

const URL_BASE = arg('url', 'http://localhost:5676');
const TILES = arg('tiles', 'http://localhost:5622/');
const TILES_QUERY = TILES ? `&tiles=${encodeURIComponent(TILES)}` : '';
const ONLY = arg('scenario', '').split(',').map((s) => s.trim()).filter(Boolean);
const CYCLES = Number(arg('cycles', '8'));
const TOUR_CONTEXT = arg('context', 'desktop');

const GPU_ARGS = [
  '--use-gl=angle', '--use-angle=metal', '--enable-gpu',
  '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader',
];

// --------------------------------------------------------------------- lock

// One browser run at a time, machine-wide. mkdir is the atomic claim; the pid
// inside is what lets a crashed run's lock be reclaimed rather than blocking
// the machine until someone notices.
const LOCK_DIR = '/tmp/moon-browser.lock';
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

function lockHolder() {
  let pid;
  try {
    pid = Number(readFileSync(join(LOCK_DIR, 'pid'), 'utf8').trim());
  } catch {
    // Claimed but not yet stamped: a live run mid-handshake, so wait for it.
    return { alive: true, pid: null };
  }
  if (!Number.isInteger(pid) || pid <= 0) return { alive: false, pid };
  try {
    process.kill(pid, 0);
    return { alive: true, pid };
  } catch {
    return { alive: false, pid };
  }
}

async function takeBrowserLock() {
  let announced = false;
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const holder = lockHolder();
      if (!holder.alive) {
        process.stdout.write(`[sector] clearing a stale lock (pid ${holder.pid} is gone)\n`);
        rmSync(LOCK_DIR, { recursive: true, force: true });
        continue;
      }
      if (!announced) {
        process.stdout.write(`[sector] another browser run holds ${LOCK_DIR}`
          + `${holder.pid ? ` (pid ${holder.pid})` : ''} — waiting for it\n`);
        announced = true;
      }
      await sleepMs(10_000);
    }
  }
  writeFileSync(join(LOCK_DIR, 'pid'), String(process.pid));
  if (announced) process.stdout.write('[sector] lock acquired\n');
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try { rmSync(LOCK_DIR, { recursive: true, force: true }); } catch { /* already gone */ }
  };
  process.on('exit', release);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => { release(); process.exit(130); });
  }
  return release;
}

// ------------------------------------------------------------------ harness

/** One booted tab, with its console/page errors collected from the first
 *  frame. `init` runs before any app code, for the scenarios that instrument
 *  the GL context. */
async function boot(browser, { context = CONTEXTS.desktop, query = '', init } = {}) {
  const ctx = await browser.newContext(context);
  await ctx.addInitScript(() => {
    try {
      localStorage.clear(); sessionStorage.clear(); indexedDB.deleteDatabase('orbital-sim-storage');
      localStorage.setItem('planetarium-help-seen', '1');
      localStorage.setItem('planetarium-surface-hint-seen', '1');
    } catch { /* a context that refuses storage still boots */ }
  });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const errors = [];
  const tileRequests = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('request', (r) => { if (r.url().includes('/tiles/')) tileRequests.push(r.url()); });
  await page.goto(`${URL_BASE}/?auto=planetarium${query}${TILES_QUERY}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), null, { timeout: 90_000 });
  await page.waitForFunction(
    () => { const ls = document.getElementById('loading-screen'); return !ls || ls.classList.contains('hidden'); },
    null, { timeout: 90_000 },
  ).catch(() => { /* a boot that never hides it still measures */ });
  await page.evaluate(() => window.__moon.setChrome(false));
  await page.evaluate((t) => window.__moon.setTimeMs(t), CLOCK_MS);
  await page.waitForTimeout(1500);
  return { ctx, page, errors, tileRequests };
}

const stats = (page) => page.evaluate(() => window.__moon.sectors());
const ladder = (page) => page.evaluate(() => window.__moon.ladder());
const pose = (page, body, how, mult) => page.evaluate(
  ([n, h, m]) => (h === 'jumpTo' ? window.__moon.jumpTo(n, m) : window.__moon.frame(n, m)), [body, how, mult],
);
const mib = (bytes) => (bytes / MiB).toFixed(1);

/** The tiles and the globe maps must be spending ONE envelope: the floor the
 *  ladder reads is the floor the streamer wrote, and the ladder's ceiling is
 *  the whole envelope less that floor. Split the two ledgers and every other
 *  figure on this page still looks sane, while the ladder is handed the whole
 *  floor the tiles were promised and admits a rung it should have been
 *  refused. Both readouts are taken in one evaluate, so they are one moment. */
function checkSharedEnvelope(r, where, s, l) {
  if (l.floorBytes !== s.floor) {
    r.fail(`${where}: the ladder reads a floor of ${mib(l.floorBytes)} MiB`
      + ` where the tiles are owed ${mib(s.floor)} — two envelopes, not one`);
  }
  const want = l.envelopeBytes - s.floor;
  if (l.ceilingBytes !== want) {
    r.fail(`${where}: ladder ceiling ${mib(l.ceilingBytes)} MiB, envelope ${mib(l.envelopeBytes)}`
      + ` less the floor ${mib(s.floor)} = ${mib(want)}`);
  }
}

/** What one scenario reports: its own lines, and the assertions it broke. */
function report() {
  const lines = [];
  const failures = [];
  return {
    lines,
    failures,
    say: (text) => lines.push(text),
    fail: (text) => failures.push(text),
    /** Console and page errors are a failure in every scenario. */
    errors: (errors) => {
      lines.push(`errors ${errors.length}${errors.length ? ' ' + JSON.stringify(errors.slice(0, 4)) : ''}`);
      if (errors.length) failures.push(`${errors.length} console/page error(s): ${errors[0]}`);
    },
  };
}

// ---------------------------------------------------------------- scenarios

/** Every sample of the streamer's own figures must satisfy the budget. The
 *  first pose is sampled long because it is where a slow leak would show.
 *  The absolute ceiling is read from the row the device landed on rather than
 *  written down here: an Apple phone takes the measured Apple row now, so a
 *  hardcoded touch figure would fail a phone for holding what it is allowed. */
async function budgetGate(r, page, { poses, longSamples = 40, shortSamples = 8, label }) {
  const row = await page.evaluate(() => (window.__moon.device ? window.__moon.device() : null));
  const ceilingBytes = row ? row.ceilingBytes : Infinity;
  r.say(`# ${label}`);
  if (row) r.say(`  row: ${row.deviceClass}/${row.family} ${row.profile} (${row.provenance}) — tiles ${mib(ceilingBytes)} MiB`);
  let first = true;
  for (const [body, how, mult] of poses) {
    if (!await pose(page, body, how, mult)) { r.fail(`${body} ${mult}: ${how} returned false`); continue; }
    await page.waitForTimeout(9000);
    const samples = first ? longSamples : shortSamples;
    first = false;
    let peak = 0;
    let worst = 0;
    let last = null;
    for (let i = 0; i < samples; i++) {
      const s = await stats(page);
      const held = s.budgetedBytes + s.reserved;
      if (held > s.budget) r.fail(`${body} ${mult}: held ${mib(held)} > budget ${mib(s.budget)} MiB`);
      if (held > ceilingBytes) r.fail(`${body} ${mult}: held ${mib(held)} MiB over this row's ${mib(ceilingBytes)} MiB ceiling`);
      peak = Math.max(peak, held);
      worst = Math.max(worst, held / Math.max(1, s.budget));
      last = s;
      await page.waitForTimeout(250);
    }
    const b = last.bodies[body] ?? { resident: [], byLevel: [] };
    r.say(`${body} ${how} ${mult} (${samples} samples): resident ${last.resident} held ${mib(peak)} MiB`
      + ` of budget ${mib(last.budget)} (${(worst * 100).toFixed(0)}%),`
      + ` globe maps ${mib(last.ladderBytes)} of envelope ${mib(last.envelope)}`);
    r.say(`   ${body}: [${b.resident.slice().sort().join(',')}] byLevel ${JSON.stringify(b.byLevel.map((l) => l.resident))}`
      + ` — one more sector would be ${mib(peak + EARTH_SET_BYTES)} MiB`);
  }
}

const SCENARIOS = {
  async budget(browser) {
    const r = report();
    const { ctx, page, errors } = await boot(browser);
    try {
      await budgetGate(r, page, {
        label: `budget gate @ ${URL_BASE} (desktop 1600x900)`,
        poses: [
          ['Earth', 'jumpTo', 0.3], ['Earth', 'jumpTo', 0.2], ['Earth', 'jumpTo', 0.15], ['Earth', 'jumpTo', 0.13],
          ['Moon', 'frame', 1.6],
          ['Mars', 'jumpTo', 0.15],
        ],
      });
      r.errors(errors);
    } finally { await ctx.close(); }
    return r;
  },

  async touch(browser) {
    const r = report();
    const { ctx, page, errors } = await boot(browser, { context: CONTEXTS.phone });
    try {
      await budgetGate(r, page, {
        label: `touch gate @ ${URL_BASE} (390x844, DPR 3, iPhone UA)`,
        longSamples: 16,
        shortSamples: 16,
        poses: [['Moon', 'frame', 1.6], ['Earth', 'jumpTo', 0.3]],
      });
      r.errors(errors);
    } finally { await ctx.close(); }
    return r;
  },

  async tour(browser) {
    const r = report();
    const context = CONTEXTS[TOUR_CONTEXT] ?? CONTEXTS.desktop;
    const { ctx, page, errors } = await boot(browser, { context });
    try {
      r.say(`# ${TOUR_CONTEXT} tour @ ${URL_BASE}`);
      const row = await page.evaluate(() => (window.__moon.device ? window.__moon.device() : null));
      if (row) {
        r.say(`  row: ${row.deviceClass}/${row.family} ${row.profile} (${row.provenance})`
          + ` — envelope ${mib(row.envelopeBytes)} MiB, tiles ${mib(row.ceilingBytes)} MiB`);
      }
      const RANK = { '2k': 2, '4k': 4, '8k': 8 };
      const tierOf = (rank) => Object.keys(RANK).find((k) => RANK[k] === rank) ?? 'boot';
      const rungs = new Map(); // key -> tier rank, to catch every swap down
      const releases = [];
      let peakMaps = 0;
      let minBudget = Infinity;
      let minSectorRoom = Infinity;
      const sample = async (where) => {
        const [s, l] = await page.evaluate(() => [window.__moon.sectors(), window.__moon.ladder()]);
        if (!s || !l) { r.fail(`${where}: no stats`); return null; }
        // A key that drops off the readout is back on its boot map: the
        // readout lists what the ladder is holding, so a release is a
        // disappearance.
        const now = new Map(l.rungs.map((x) => [x.key, x.tier ? RANK[x.tier] : 0]));
        for (const [key, was] of rungs) {
          const rank = now.get(key) ?? 0;
          if (rank < was) releases.push(`${where}: ${key} ${tierOf(was)} -> ${tierOf(rank)}`);
        }
        for (const key of rungs.keys()) rungs.set(key, now.get(key) ?? 0);
        for (const [key, rank] of now) rungs.set(key, rank);
        checkSharedEnvelope(r, where, s, l);
        if (l.heldBytes > l.ceilingBytes) {
          r.fail(`${where}: globe maps ${mib(l.heldBytes)} over the ladder ceiling ${mib(l.ceilingBytes)} MiB`);
        }
        if (s.budget < s.floor) r.fail(`${where}: budget ${mib(s.budget)} under the floor ${mib(s.floor)} MiB`);
        if (s.budgetedBytes + s.reserved > s.budget) r.fail(`${where}: held over budget`);
        peakMaps = Math.max(peakMaps, l.heldBytes);
        minBudget = Math.min(minBudget, s.budget);
        minSectorRoom = Math.min(minSectorRoom, Math.floor(s.budget / EARTH_SET_BYTES));
        return { s, l };
      };

      for (const body of ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Pluto']) {
        if (!await page.evaluate((n) => window.__moon.jumpTo(n, 0.3), body)) {
          r.fail(`${body}: jumpTo returned false`);
          continue;
        }
        for (let i = 0; i < 8; i++) { await page.waitForTimeout(1000); await sample(body); }
        const at = await sample(body);
        if (!at) continue;
        r.say(`${body}: globe maps ${mib(at.l.heldBytes)} of ${mib(at.l.ceilingBytes)},`
          + ` tiles ${at.s.resident} in ${mib(at.s.budget)} MiB (floor ${mib(at.s.floor)})`
          + ` — ${at.l.rungs.map((x) => `${x.key}:${x.tier ?? 'boot'}`).join(' ')}`);
      }
      await page.evaluate(() => window.__moon.jumpTo('Earth', 0.3));
      for (let i = 0; i < 30; i++) { await page.waitForTimeout(1000); await sample('Earth 0.3'); }
      const end = await sample('Earth 0.3');
      if (!end) return r;
      const earth = end.s.bodies.Earth ?? { resident: [], maxTexelPx: 0 };
      const want = row ? row.wantTexelPx : 1;
      const room = Math.floor((end.s.budget - end.s.budgetedBytes - end.s.reserved) / EARTH_SET_BYTES);
      r.say(`Earth 0.3: globe maps ${mib(end.l.heldBytes)} of ${mib(end.l.ceilingBytes)},`
        + ` tiles ${end.s.resident} = ${mib(end.s.budgetedBytes)} MiB in a budget of ${mib(end.s.budget)}`
        + ` (floor ${mib(end.s.floor)}), maxTexelPx ${earth.maxTexelPx.toFixed(2)} against a want of ${want},`
        + ` room for ${room} more set(s)`);
      r.say(`   rungs ${end.l.rungs.map((x) => `${x.key}:${x.tier ?? 'boot'}`).join(' ')}`);
      r.say(`peak globe maps ${mib(peakMaps)} MiB, lowest budget ${mib(minBudget)} MiB = ${minSectorRoom} Earth sets`);
      r.say(`releases: ${releases.length ? releases.join(' | ') : 'none'}`);
      // No sectors at Earth 0.3 is the DESIGN, not a fault: the globe carries
      // its own 8K map now, and at a third of the frame that map is finer than
      // a level-0 tile would be, so no sector is magnified past the want
      // threshold and none is asked for. Slots still carry a score at this
      // distance — a score ranks demand, it does not mean the demand qualifies
      // — so the honest gate is the threshold itself. What would be a fault is
      // a surface magnified past it with room for a whole set going spare.
      if (earth.resident.length === 0 && earth.maxTexelPx > want && room >= 1) {
        r.fail(`Earth 0.3: maxTexelPx ${earth.maxTexelPx.toFixed(2)} over the want of ${want},`
          + ` nothing resident, and room for ${room} set(s)`);
      }
      if (minSectorRoom < 1) r.fail('the budget fell under one whole set');
      r.errors(errors);
    } finally { await ctx.close(); }
    return r;
  },

  async envelope(browser) {
    const r = report();
    /** Assert the row a context landed on, and print what it buys. */
    const readRow = async (label, context, want, { engine = browser } = {}) => {
      const run = await boot(engine, { context, query: '&debug=1' });
      const dev = await run.page.evaluate(() => window.__moon.device());
      const seen = await run.page.evaluate(() => ({
        screen: `${screen.width}x${screen.height}`, dpr: devicePixelRatio,
        maxTouchPoints: navigator.maxTouchPoints,
        anyCoarse: matchMedia('(any-pointer: coarse)').matches,
      }));
      r.say(`\n# ${label} — ${JSON.stringify(seen)}`);
      r.say(`  class ${dev.deviceClass} / family ${dev.family} / row ${dev.profile} (${dev.provenance})`);
      r.say(`  envelope ${mib(dev.envelopeBytes)} MiB, tiles ${mib(dev.ceilingBytes)} MiB,`
        + ` floor ${mib(dev.sectorFloorBytes)} MiB, ${dev.residentCap}/${dev.inflightCap}/${dev.fetchPool},`
        + ` want ${dev.wantTexelPx}/${dev.releaseTexelPx}, warm ${dev.cacheOnlyWarm ? 'cached' : 'full'},`
        + ` caps ${JSON.stringify(dev.tierCaps)}`);
      for (const [k, v] of Object.entries(want)) {
        if (dev[k] !== v) r.fail(`${label}: ${k} ${JSON.stringify(dev[k])}, wanted ${JSON.stringify(v)}`);
      }
      if (run.errors.length) r.say(`  errors ${run.errors.length} ${JSON.stringify(run.errors.slice(0, 3))}`);
      return { ...run, dev };
    };

    // 1. An Apple phone at the closest Earth pose the desktop gate uses.
    const apple = await readRow('Apple phone 430x932 DPR 3', {
      viewport: { width: 430, height: 932 }, deviceScaleFactor: 3,
      hasTouch: true, isMobile: true, userAgent: IPHONE_UA,
    }, {
      deviceClass: 'phone', family: 'apple', profile: 'apple-phone',
      envelopeBytes: 768 * MiB, ceilingBytes: 256 * MiB, cacheOnlyWarm: false,
    });
    try {
      await apple.page.evaluate(() => window.__moon.jumpTo('Earth', 0.13));
      await apple.page.waitForTimeout(22_000);
      const [s, l] = await apple.page.evaluate(() => [window.__moon.sectors(), window.__moon.ladder()]);
      const e = s.bodies.Earth ?? { resident: [], byLevel: [] };
      r.say(`  Earth 0.13: ${s.resident} tiles = ${mib(s.budgetedBytes)} MiB of budget ${mib(s.budget)}`
        + ` (floor ${mib(s.floor)}), globe maps ${mib(l.heldBytes)} of ${mib(l.ceilingBytes)}`);
      r.say(`     Earth [${e.resident.slice().sort().join(',')}] byLevel ${JSON.stringify(e.byLevel.map((x) => x.resident))}`);
      r.say(`     rungs ${l.rungs.map((x) => `${x.key}:${x.tier ?? 'boot'}${x.top && x.top !== x.tier ? `(top ${x.top})` : ''}`).join(' ')}`);
      checkSharedEnvelope(r, 'apple phone Earth 0.13', s, l);
      if (s.budgetedBytes + s.reserved > s.budget) r.fail('apple phone: held over budget');
      if (s.resident === 0) r.fail('apple phone Earth 0.13: no tiles at all');
      const clouds = l.rungs.find((x) => x.key === 'earthClouds');
      if (clouds && clouds.tier === '8k') r.fail('apple phone: the cloud deck reached 8K past its fill-rate cap');
      r.say(`     cloud deck ${clouds ? clouds.tier : 'boot'},`
        + ` moon ${l.rungs.find((x) => x.key === 'moon')?.tier ?? 'boot'}`);
      // Another 20 s, then the ranking behind the working set. A phone that
      // stops one set short of its ceiling has either run out of demand or run
      // out of room, and the scores are the only place that shows which.
      await apple.page.waitForTimeout(20_000);
      const s2 = await apple.page.evaluate(() => window.__moon.sectors());
      const e2 = s2.bodies.Earth ?? { resident: [], scores: {} };
      const ranked = Object.entries(e2.scores).sort((a, b) => b[1] - a[1]);
      r.say(`  Earth 0.13 after 42 s: ${s2.resident} tiles = ${mib(s2.budgetedBytes)} MiB of ${mib(s2.budget)},`
        + ` room for ${Math.floor((s2.budget - s2.budgetedBytes - s2.reserved) / EARTH_SET_BYTES)} more sets`);
      r.say(`     wanted, strongest first: ${ranked.slice(0, 14).map(([k, v]) => `${k}:${v.toFixed(2)}${e2.resident.includes(k) ? '*' : ''}`).join(' ')}`);
      r.say(`     (* = resident) ${ranked.length} slots asked, ${e2.resident.length} in`);
    } finally { await apple.ctx.close(); }

    // The Moon on that phone at the pose that earns the top rung, against a
    // desktop control: the claim is "the phone reaches what the desktop
    // reaches", not "the phone reaches 8K at every framing".
    const atTheMoon = async (label, context, want) => {
      const run = await readRow(label, context, want);
      try {
        await run.page.evaluate(() => window.__moon.jumpTo('Moon', 0.5));
        await run.page.waitForTimeout(12_000);
        await run.page.evaluate(() => window.__moon.frame('Moon', 1.6));
        await run.page.waitForTimeout(25_000);
        const [s, l] = await run.page.evaluate(() => [window.__moon.sectors(), window.__moon.ladder()]);
        const rung = l.rungs.find((x) => x.key === 'moon');
        r.say(`  Moon 0.5 then 1.6: rung ${rung ? `${rung.tier} (top ${rung.top}, ${mib(rung.bytes)} MiB, source ${rung.sourceWidth})` : 'boot'},`
          + ` globe maps ${mib(l.heldBytes)} of ${mib(l.ceilingBytes)}`);
        r.say(`     tiles ${s.resident} = ${mib(s.budgetedBytes)} MiB of ${mib(s.budget)},`
          + ` Moon [${(s.bodies.Moon?.resident ?? []).slice().sort().join(',')}]`);
        checkSharedEnvelope(r, `${label} at the Moon`, s, l);
        if (s.budgetedBytes + s.reserved > s.budget) r.fail(`${label}: held over budget`);
        return rung ? rung.tier : 'boot';
      } finally { await run.ctx.close(); }
    };
    const phoneMoon = await atTheMoon('Apple phone at the Moon', {
      viewport: { width: 430, height: 932 }, deviceScaleFactor: 3,
      hasTouch: true, isMobile: true, userAgent: IPHONE_UA,
    }, { deviceClass: 'phone', family: 'apple', profile: 'apple-phone' });
    const desktopMoon = await atTheMoon('Desktop at the Moon (control)', CONTEXTS.desktop,
      { deviceClass: 'desktop', profile: 'unmeasured-desktop' });
    if (phoneMoon !== desktopMoon) r.fail(`the Moon rung differs: apple phone ${phoneMoon}, desktop ${desktopMoon}`);
    if (phoneMoon !== '8k') r.say(`  NOTE: neither reaches 8K at this pose (both ${phoneMoon})`);

    // 2. The iPad, which sends a desktop UA and is told apart by touch points.
    const ipad = await readRow('Apple tablet 834x1062 DPR 2', {
      viewport: { width: 834, height: 1062 }, deviceScaleFactor: 2,
      hasTouch: true, isMobile: true, userAgent: IPAD_UA,
    }, {
      deviceClass: 'tablet', family: 'apple', profile: 'apple-tablet',
      envelopeBytes: 768 * MiB, ceilingBytes: 256 * MiB, cacheOnlyWarm: false,
    });
    await ipad.ctx.close();

    // 3. An Android phone, which nobody has measured: the unmeasured row.
    const pixel = await readRow('Pixel 412x915 DPR 2.625', CONTEXTS.android, {
      deviceClass: 'phone', family: 'android', profile: 'unmeasured-touch',
      envelopeBytes: 320 * MiB, ceilingBytes: 144 * MiB, cacheOnlyWarm: true,
    });
    await pixel.ctx.close();

    // 4. The Safari oracle. Its touch viewport reports maxTouchPoints 0, so
    //    the any-pointer key is the only thing that can read it as a phone.
    const wk = await webkit.launch({ headless: true });
    try {
      const run = await readRow('Playwright WebKit, iPhone context', CONTEXTS.phone,
        { deviceClass: 'phone', family: 'apple', profile: 'apple-phone' }, { engine: wk });
      if (run.dev && run.dev.deviceClass === 'phone') {
        const tp = await run.page.evaluate(() => navigator.maxTouchPoints);
        r.say(`  read as a phone with maxTouchPoints ${tp}`);
      }
      await run.ctx.close();
    } finally { await wk.close(); }
    return r;
  },

  async gpu(browser) {
    const r = report();
    // Counted from before any app code runs: three's own disposal bookkeeping
    // cannot be the witness for whether three disposed anything.
    const instrument = () => {
      const G = { tex: 0, texDel: 0, buf: 0, bufDel: 0, bytes: 0 };
      window.__gl = G;
      for (const P of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
        if (!P) continue;
        const p = P.prototype;
        const ct = p.createTexture; const dt = p.deleteTexture;
        const cb = p.createBuffer; const db = p.deleteBuffer;
        p.createTexture = function () { G.tex++; return ct.apply(this, arguments); };
        p.deleteTexture = function (t) { if (t) G.texDel++; return dt.apply(this, arguments); };
        p.createBuffer = function () { G.buf++; return cb.apply(this, arguments); };
        p.deleteBuffer = function (b) { if (b) G.bufDel++; return db.apply(this, arguments); };
        if (p.texStorage2D) {
          const ts = p.texStorage2D;
          p.texStorage2D = function (t, lv, fmt, w, h) { G.bytes += w * h * 4 * 1.34; return ts.apply(this, arguments); };
        }
      }
    };
    const { ctx, page, errors, tileRequests } = await boot(browser, { init: instrument });
    try {
      const gl = () => page.evaluate(() => ({
        ...window.__gl, live: window.__gl.tex - window.__gl.texDel, liveBuf: window.__gl.buf - window.__gl.bufDel,
      }));
      const base = await gl();
      r.say(`baseline: live textures ${base.live}, live buffers ${base.liveBuf}, texStorage MB ${(base.bytes / MiB).toFixed(0)}`);
      const live = [];
      for (let i = 0; i < CYCLES; i++) {
        await page.evaluate(() => window.__moon.frame('Earth', 1.6, 0));
        await page.waitForTimeout(3000);
        const gNear = await gl(); const sNear = await stats(page);
        await page.evaluate(() => window.__moon.frame('Earth', 0.05, 0));
        await page.waitForTimeout(1800);
        const g = await gl(); const s = await stats(page);
        live.push(g.live);
        r.say(`cycle ${i}: near liveTex ${gNear.live} (r${sNear.resident}) -> far liveTex ${g.live} (r${s.resident})`
          + ` buf ${g.liveBuf} | cumulative texStorage ${(g.bytes / MiB).toFixed(0)} MB`);
        if (s.resident !== 0) r.fail(`cycle ${i}: ${s.resident} resident after flee`);
      }
      const drift = live[live.length - 1] - live[0];
      r.say(`live-texture drift across ${CYCLES} cycles: ${drift} (start ${live[0]}, end ${live[live.length - 1]})`);
      // Three under: a texture or two settling is not a leak; a per-cycle
      // one is, and it shows as a drift that keeps climbing.
      if (drift > 3) r.fail(`GPU texture leak: live WebGL textures drifted +${drift} over ${CYCLES} approach/flee cycles`);
      r.say(`tile requests total ${tileRequests.length}`);
      r.errors(errors);
    } finally { await ctx.close(); }
    return r;
  },

  async sweep(browser) {
    const r = report();
    const { ctx, page, errors } = await boot(browser);
    try {
      // The display FOV is held at 60 deg at every distance, so the body's
      // on-screen size grows purely with proximity.
      const DISTS = [4, 3, 2, 1.6, 1.4, 1.25, 1.15, 1.1, 1.07, 1.05, 1.03, 1.02];
      for (const body of ['Earth', 'Mars']) {
        r.say(`--- ${body} ---`);
        for (const d of DISTS) {
          const fill = (Math.atan(1 / d) * 180 / Math.PI) / 30;
          const ok = await page.evaluate(([n, f, p, dm]) => window.__moon.frame(n, f, p, dm), [body, fill, 0, d]);
          if (!ok) { r.say(`  d=${d}: frame() returned false`); continue; }
          await page.waitForTimeout(7000);
          const b = (await stats(page)).bodies[body] ?? { resident: [], loading: [], maxTexelPx: 0 };
          r.say(`  d=${d}R  resident ${String(b.resident.length).padStart(2)} loading ${b.loading.length}`
            + `  maxTexelPx ${b.maxTexelPx.toFixed(1).padStart(7)}  [${b.resident.join(',')}]`);
          // Magnified surface with nothing resident is admission dying, which
          // is the one thing this sweep exists to catch.
          if (b.maxTexelPx > 3 && b.resident.length === 0) {
            r.fail(`${body} d=${d}R: maxTexelPx ${b.maxTexelPx.toFixed(1)} but zero sectors resident`);
          }
        }
        await page.evaluate((n) => window.__moon.frame(n, 0.02, 0), body);
        await page.waitForTimeout(2000);
      }
      r.errors(errors);
    } finally { await ctx.close(); }
    return r;
  },
};

// ------------------------------------------------------------------- runner

const names = ONLY.length ? ONLY : Object.keys(SCENARIOS);
for (const name of names) {
  if (!SCENARIOS[name]) {
    console.error(`unknown scenario "${name}" — have: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(2);
  }
}

const release = await takeBrowserLock();
const results = [];
try {
  for (const name of names) {
    const browser = await chromium.launch({ headless: true, args: GPU_ARGS });
    let r;
    try {
      r = await SCENARIOS[name](browser);
    } catch (err) {
      r = report();
      r.fail(`threw: ${err && err.message ? err.message : String(err)}`);
    } finally {
      await browser.close();
    }
    console.log(`\n=== ${name} ===`);
    for (const line of r.lines) console.log(line);
    console.log(r.failures.length ? `${name}: FAIL` : `${name}: PASS`);
    results.push({ name, failures: r.failures });
  }
} finally {
  release();
}

console.log('\n=== sector probe ===');
for (const { name, failures } of results) {
  console.log(`  ${failures.length ? 'FAIL' : 'PASS'}  ${name}${failures.length ? ` (${failures.length})` : ''}`);
  for (const f of failures) console.log(`          ${f}`);
}
const failed = results.filter((x) => x.failures.length).length;
console.log(failed ? `\n${failed} of ${results.length} scenario(s) FAILED` : `\nall ${results.length} scenario(s) PASS`);
process.exit(failed ? 1 : 0);
