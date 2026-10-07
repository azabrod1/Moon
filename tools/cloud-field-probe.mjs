// The cloud field's battery: does Earth's 1.2 km cloud field (on by default,
// `?cloudtiles=0` its kill switch; world/cloudFieldSession driving
// world/cloudFieldResidency) cost nothing when it is off, fill its pool by
// itself when it is on, hold still while the camera pans, stand down while
// Earth spins or the deck is hidden, and turn itself off cleanly when its pool
// cannot be had?
//
// Every verdict is read from the app's own counters — the residency's state
// and the pool's table through the DEV bridge (`__moon.cloudField()`), the
// envelope through `__moon.ladder()` — and from the network, never from a
// timing guess. Scenarios (all by default; `--scenario=a,b` for some):
//
//   off     Booted with `?cloudtiles=0`, posed where the field would want
//           pages: no request under `earth-clouds.v2/`, no pool, session or
//           worker module fetched, no worker started, no fixed bytes in the
//           envelope, and the deck's program holds neither of the field's
//           samplers.
//   arrive  A plain boot, the field on by default: a real `travelTo` Earth
//           from Mars, then the trades pose (400 km over the Pacific trade
//           cumulus, by day). Pages
//           must become resident on their own and settle (every wanted page in
//           the table at full fade, nothing in the pipe); no admission and no
//           load may start between two frames both under the arrival veil
//           (an arrival this soon after the boot is held under it; one that
//           was instant is reported as not exercising the rule). Time to the
//           first page and to settled.
//   hidden  The deck hidden by its role switch (`?perf=1`'s `clouds` arm, the
//           same `visible` flag the range gate writes): every page released —
//           none wanted, none kept, the pipe idle — and NOT evicted (the table
//           stands: the pool costs the same full or empty), nothing fetched
//           while hidden even at a pose that wants new pages, the residents
//           taken back with no fetch once the deck shows again, and that pose's
//           demand loading once it does.
//   spin    The clock at 900x from an emptied pool at trades: Earth's day
//           latch holds, pages are wanted, and nothing is admitted or loaded;
//           admissions resume once the clock stops.
//   pan     A 15 s roll sweep at 400 km and at 3,000 km, at the Mac display's
//           ratio: no page leaves the table and comes back inside 5 s;
//           admissions and evictions per minute reported.
//   fail    `?cloudpoolfail=1` (development only) reports the pool's boot
//           allocation out of memory: the field is off for the session (no
//           pool, no define, nothing reserved, nothing fetched), said in
//           exactly ONE warning, and the deck still draws its base sheet — the
//           frame with the deck shown against the same frame with it hidden
//           must brighten where the cloud is, never read as clear sky.
//
//   node tools/cloud-field-probe.mjs --url=http://localhost:5744 --assert
//   node tools/cloud-field-probe.mjs --url=… --scenario=off,fail
//
// Three boots at most (the kill switch; the default; the failed field), one
// tab each, at 1600x1000 and `quality=medium`; about a minute of browser time
// in all. The
// dev server may load the page a second time shortly after the first boot
// (its dependency pass): a scenario that sees a second load is set up and run
// again, once. GPU flags as every battery; takes /tmp/moon-browser.lock. A
// JSON of every reading and a run log land in /tmp/moon-shots/<label>/;
// `--assert` exits 1 on any failure.
import { chromium } from 'playwright';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import path from 'node:path';
import { takeBrowserLock } from './browserLock.mjs';
import { decodePng } from './pngDecode.mjs';

const arg = (k, d) => { const m = process.argv.find((a) => a.startsWith(`--${k}=`)); return m ? m.slice(k.length + 3) : d; };
const URL_BASE = arg('url', 'http://localhost:5174');
const LABEL = arg('label', 'cloud-field-probe');
const ALL = ['off', 'arrive', 'hidden', 'spin', 'pan', 'fail'];
const ASKED = arg('scenario', ALL.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const ASSERT = process.argv.includes('--assert');
const OUT = path.join('/tmp/moon-shots', LABEL);
const W = 1600;
const H = 1000;

for (const s of ASKED) {
  if (!ALL.includes(s)) {
    console.error(`unknown scenario ${s}; known: ${ALL.join(', ')}`);
    process.exit(2);
  }
}

// The trades pose: 400 km over 21 S 120 W at 17:20 UTC on 1 February 2026,
// the Sun 48° up, the open Pacific under trade cumulus, 50° displayed.
const TRADES_TIME = Date.parse('2026-02-01T17:20:00Z');
const TRADES = ['frame', 'Earth', 1.7303397579094035, 41.468376555090536, 1.0627155848228285, 0, -2.697731494258438, -77.34841618462669];
const R_KM = 6371;
/** Straight down over the same ground from `altKm`, a 60° field. */
const nadir = (altKm) => {
  const d = (R_KM + altKm) / R_KM;
  return ['frame', 'Earth', (2 * Math.atan(1 / d) * 180 / Math.PI) / 60, TRADES[3], d, 0, 0, TRADES[7]];
};
/** A page that leaves the table and is back within this is a flap. */
const FLAP_MS = 5000;
/** The deck's cloud must brighten at least this share of the frame by at
 *  least this many 8-bit levels of luminance over the deck hidden. */
const CLOUD_SHARE_MIN = 0.02;
const CLOUD_LIFT_LEVELS = 16;
const FIELD_PAGES = /\/earth-clouds\.v2\//;
const FIELD_MODULES = /cloudField(Pool|Session|Residency|Worker)\.ts/;

mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, 'run.log'), '');
const t0 = Date.now();
const log = (...a) => {
  const line = `[cloud-field ${((Date.now() - t0) / 1000).toFixed(0)}s] ${a.join(' ')}`;
  console.log(line);
  appendFileSync(path.join(OUT, 'run.log'), `${line}\n`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const result = {
  url: URL_BASE, viewport: { width: W, height: H, deviceScaleFactor: 1 }, hardware: null,
  scenarios: {}, browserSeconds: null,
};
const save = () => writeFileSync(path.join(OUT, 'report.json'), `${JSON.stringify(result, null, 1)}\n`);

// ------------------------------------------------------------------ harness

/** One booted tab and everything it saw: page loads, warnings, errors, the
 *  requests under the cloud sets and the field's modules, and its workers. */
async function open(browser, query) {
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    try {
      localStorage.clear(); sessionStorage.clear(); indexedDB.deleteDatabase('orbital-sim-storage');
      localStorage.setItem('planetarium-help-seen', '1');
      localStorage.setItem('planetarium-surface-hint-seen', '1');
    } catch { /* a context that refuses storage still boots */ }
  });
  const page = await context.newPage();
  const tab = { context, page, loads: 0, warnings: [], errors: [], pages: [], modules: [], workers: [] };
  page.on('load', () => { tab.loads += 1; });
  page.on('pageerror', (e) => tab.errors.push(`pageerror: ${String(e).slice(0, 300)}`));
  page.on('console', (m) => {
    if (m.type() === 'error') tab.errors.push(`console: ${m.text().slice(0, 300)}`);
    if (m.type() === 'warning') tab.warnings.push(m.text().slice(0, 400));
  });
  page.on('request', (r) => {
    const u = r.url();
    if (FIELD_PAGES.test(u)) tab.pages.push({ atMs: Date.now(), url: u.slice(u.indexOf('earth-clouds.v2/')) });
    if (FIELD_MODULES.test(u)) tab.modules.push(u.replace(/^.*\/src\//, 'src/'));
  });
  page.on('worker', (w) => tab.workers.push(w.url()));
  tab.url = `${URL_BASE}/?auto=planetarium&quality=medium${query}`;
  log('boot', tab.url);
  await page.goto(tab.url, { waitUntil: 'domcontentloaded' });
  await setup(tab);
  return tab;
}

/** Everything a scenario needs set on the page, and a token a reload wipes. */
async function setup(tab) {
  const { page } = tab;
  await page.waitForFunction(() => !!window.__moon?.ready?.(), null, { timeout: 120_000 });
  await page.waitForFunction(
    () => { const ls = document.getElementById('loading-screen'); return !ls || ls.classList.contains('hidden'); },
    null, { timeout: 120_000 },
  ).catch(() => { /* a boot that never hides it still answers */ });
  tab.token = `probe-${Date.now()}`;
  await page.evaluate((tok) => {
    const m = window.__moon;
    m.setChrome(false); m.setShipVisible(false); m.setMiniChart?.(false);
    m.setTimeRate(0); m.setAutoExposure(false);
    m.pinCapture({ near: 1e-7, exposure: 1, pixelRatio: 1 });
    window.__probeToken = tok;
  }, tab.token);
  if (!result.hardware) {
    const gl = await page.evaluate(() => {
      const ctx = document.createElement('canvas').getContext('webgl2');
      const ext = ctx?.getExtension('WEBGL_debug_renderer_info');
      return ext ? String(ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
    });
    result.hardware = { cpu: cpus()[0]?.model ?? 'unknown', gl, browser: `headless Chromium ${tab.context.browser().version()}` };
    log('hardware', JSON.stringify(result.hardware));
    if (/swiftshader|llvmpipe|software/i.test(gl)) throw new Error(`software rasteriser (${gl}): every figure would be fiction`);
  }
}

const alive = (tab) => tab.page.evaluate((tok) => window.__probeToken === tok, tab.token).catch(() => false);

/** A scenario, run again once if the page loaded a second time under it. */
async function run(tab, name, body) {
  for (let attempt = 0; ; attempt++) {
    if (!await alive(tab)) {
      log(name, ': the page lost its setup (a second load); setting up again');
      await setup(tab);
    }
    const loads = tab.loads;
    const r = { failures: [] };
    const fail = (msg) => { r.failures.push(msg); log(`  FAIL ${name}: ${msg}`); };
    const started = Date.now();
    try {
      await body(r, fail);
    } catch (err) {
      if (tab.loads === loads || attempt > 0) fail(`threw: ${String(err?.stack ?? err).slice(0, 400)}`);
    }
    if (tab.loads !== loads && attempt === 0) {
      log(name, ': the page loaded again mid-scenario; running it again');
      continue;
    }
    r.seconds = Math.round((Date.now() - started) / 100) / 10;
    r.verdict = r.failures.length ? 'FAIL' : 'PASS';
    result.scenarios[name] = r;
    log(`${name}: ${r.verdict} (${r.seconds} s)`);
    save();
    return;
  }
}

const pose = (page, call) => page.evaluate(([t, c]) => {
  const m = window.__moon;
  m.setTimeRate(0);
  m.setTimeMs(t);
  const [fn, ...a] = c;
  return m[fn](...a);
}, [TRADES_TIME, call]);
const draw = (page, n = 3) => page.evaluate((k) => window.__moon.waitForDraw(k), n);

/** The field as the bridge reports it, trimmed to what the verdicts read. */
const field = (page) => page.evaluate(async () => {
  const s = await window.__moon.cloudField();
  const r = s.residency;
  return {
    defineOn: s.defineOn,
    deckSamplers: s.deckProgram?.names ?? null,
    pool: s.pool && {
      layers: s.pool.layers, poolBytes: s.pool.poolBytes, workerStarted: s.pool.workerStarted,
      table: s.pool.table.map((e) => `${e.page}:${e.layer}:${e.fade}`),
    },
    r: r && {
      wanted: r.wanted, kept: r.kept, resident: r.resident, pipe: r.pipe, fading: r.fading, failed: r.failed,
      freeLayers: r.freeLayers, admissions: r.admissions, evictions: r.evictions, loadsStarted: r.loadsStarted,
      droppedAfterDecode: r.droppedAfterDecode, frame: r.frame, wantedPages: r.wantedPages.map((w) => w.page),
    },
  };
});

/**
 * Sample the residency in the page every `everyMs` (0: every frame) until it
 * has settled — nothing in the pipe, nothing fading, every wanted page in the
 * table at full fade, the table unmoved for `stillMs` — or, with `loadsOver`,
 * until a load past that count starts, or for `maxMs`. One round trip: the
 * waiting happens in the page.
 */
const watch = (page, { maxMs, stillMs = 1500, everyMs = 100, settle = true, loadsOver = null }) => page.evaluate(async (o) => {
  const m = window.__moon;
  const samples = [];
  const start = performance.now();
  let lastKey = null;
  let lastChange = 0;
  for (;;) {
    const t = performance.now() - start;
    const st = await m.cloudField();
    const r = st.residency;
    const table = st.pool.table.map((e) => `${e.page}:${e.fade}`).join(' ');
    const full = new Set(st.pool.table.filter((e) => e.fade === 1).map((e) => e.page));
    const veilEl = document.getElementById('arrival-veil');
    samples.push({
      t: Math.round(t), table, wanted: r.wanted, kept: r.kept, resident: r.resident, pipe: r.pipe,
      fading: r.fading, adm: r.admissions, ev: r.evictions, ls: r.loadsStarted,
      veil: r.frame.veil, covering: !!veilEl?.classList.contains('covering'),
      hidden: r.frame.hidden, spinning: r.frame.spinning, frameNow: r.frame.nowMs,
      allIn: r.wantedPages.every((w) => full.has(w.page)),
    });
    if (table !== lastKey) { lastKey = table; lastChange = t; }
    const s = samples.at(-1);
    if (o.settle && s.pipe === 'idle' && s.fading === 0 && s.allIn && t - lastChange >= o.stillMs) break;
    if (o.loadsOver !== null && s.ls > o.loadsOver) break;
    if (t >= o.maxMs) break;
    if (o.everyMs > 0) await new Promise((res) => setTimeout(res, o.everyMs));
    else await new Promise((res) => requestAnimationFrame(res));
  }
  return samples;
}, { maxMs, stillMs, everyMs, settle, loadsOver });

/** Pose and wait for the field to settle there. */
async function settleAt(page, call, maxMs = 20_000) {
  await pose(page, call);
  await draw(page, 3);
  const s = await watch(page, { maxMs });
  const last = s.at(-1);
  return { settled: last.pipe === 'idle' && last.fading === 0 && last.allIn, ms: last.t, last };
}

/** Pages that left the table and were back within FLAP_MS. */
function flaps(samples) {
  const gone = new Map();
  let prev = new Set();
  const out = [];
  for (const s of samples) {
    const now = new Set(s.table.split(' ').filter(Boolean).map((e) => e.split(':')[0]));
    for (const p of prev) if (!now.has(p)) gone.set(p, s.t);
    for (const p of now) {
      if (gone.has(p)) {
        if (s.t - gone.get(p) < FLAP_MS) out.push({ page: p, goneAtMs: gone.get(p), backAtMs: s.t });
        gone.delete(p);
      }
    }
    prev = now;
  }
  return out;
}

/** Luminance of an 8-bit RGB(A) pixel. */
const lum = (px, i) => 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];

// ---------------------------------------------------------------- scenarios

/** Nothing of the field anywhere in a session its kill switch turned off. */
async function scenarioOff(tab) {
  const { page } = tab;
  await run(tab, 'off', async (r, fail) => {
    // The two poses the field wants pages at: if anything of it were alive,
    // these are where it would fetch.
    for (const call of [TRADES, nadir(3000)]) {
      await pose(page, call);
      await draw(page, 3);
      await sleep(2500);
    }
    const f = await field(page);
    const l = await page.evaluate(() => window.__moon.ladder());
    r.requests = tab.pages.length;
    r.modules = [...new Set(tab.modules)];
    r.workers = tab.workers;
    r.defineOn = f.defineOn;
    r.pool = f.pool;
    r.fixedBytes = l.fixedBytes;
    r.availableBytes = l.availableBytes;
    r.envelopeBytes = l.envelopeBytes;
    r.deckSamplers = f.deckSamplers;
    log(`  off: ${r.requests} page requests, modules [${r.modules.join(', ')}], workers ${r.workers.length},`
      + ` define ${r.defineOn}, pool ${r.pool ? 'yes' : 'none'}, fixed ${r.fixedBytes} B`);
    if (r.requests) fail(`${r.requests} request(s) under earth-clouds.v2/: ${tab.pages[0].url}`);
    if (r.modules.length) fail(`the field's modules were fetched: ${r.modules.join(', ')}`);
    if (r.workers.some((u) => /cloudFieldWorker/.test(u))) fail(`the page worker started: ${r.workers.join(', ')}`);
    if (f.defineOn) fail('the deck is compiled with CLOUD_FIELD');
    if (f.pool || f.r) fail('a pool or a residency exists');
    if (l.fixedBytes !== 0 || l.availableBytes !== l.envelopeBytes) {
      fail(`the envelope reserves ${l.fixedBytes} B (available ${l.availableBytes} of ${l.envelopeBytes})`);
    }
    if (!f.deckSamplers) fail('the deck has no linked program to read');
    else if (f.deckSamplers.some((n) => /uCloudPage/.test(n))) fail(`the deck holds the field's samplers: ${f.deckSamplers.join(', ')}`);
    if (tab.errors.length) fail(`${tab.errors.length} console/page error(s): ${tab.errors[0]}`);
  });
}

/** A real arrival, then the pages arriving by themselves at trades. */
async function scenarioArrive(tab) {
  const { page } = tab;
  await run(tab, 'arrive', async (r, fail) => {
    await page.evaluate((t) => { window.__moon.setTimeMs(t); window.__moon.jumpTo('Mars', 0.3); }, TRADES_TIME);
    await sleep(1500);
    const before = await field(page);
    // The travel, the veil and the pose in ONE evaluate, sampled every frame.
    const got = await page.evaluate(async ([call, admBefore]) => {
      const m = window.__moon;
      const samples = [];
      let stop = false;
      let phase = 'travel';
      const start = performance.now();
      const veilEl = document.getElementById('arrival-veil');
      (async () => {
        while (!stop) {
          const st = await m.cloudField();
          const r = st.residency;
          samples.push({
            t: Math.round(performance.now() - start), phase, veil: r.frame.veil,
            covering: !!veilEl?.classList.contains('covering'), adm: r.admissions, ls: r.loadsStarted,
            pipe: r.pipe, resident: r.resident, wanted: r.wanted, fading: r.fading,
            table: st.pool.table.map((e) => `${e.page}:${e.fade}`).join(' '),
            allIn: r.wantedPages.every((w) => st.pool.table.some((e) => e.page === w.page && e.fade === 1)),
          });
          await new Promise((res) => requestAnimationFrame(res));
        }
      })();
      const ok = m.travelTo('Earth');
      // The veil, if any: at least 500 ms, then down for 300 ms running.
      let downSince = null;
      while (performance.now() - start < 15_000) {
        const up = veilEl?.classList.contains('covering');
        if (up) downSince = null; else if (downSince === null) downSince = performance.now();
        if (performance.now() - start > 500 && downSince !== null && performance.now() - downSince > 300) break;
        await new Promise((res) => setTimeout(res, 50));
      }
      await new Promise((res) => setTimeout(res, 500));
      phase = 'trades';
      const [fn, ...a] = call;
      m[fn](...a);
      const poseAt = Math.round(performance.now() - start);
      // Settled: nothing in the pipe or fading, every wanted page in at full
      // fade, the table unmoved for 2 s — or 30 s.
      let lastTable = null;
      let lastChange = 0;
      for (;;) {
        await new Promise((res) => setTimeout(res, 100));
        const s = samples.at(-1);
        const t = performance.now() - start;
        if (s.table !== lastTable) { lastTable = s.table; lastChange = t; }
        if (s.phase === 'trades' && s.adm > admBefore && s.pipe === 'idle' && s.fading === 0 && s.allIn && t - lastChange > 2000) break;
        if (t - poseAt > 30_000) break;
      }
      stop = true;
      return { ok, poseAt, samples };
    }, [TRADES, before.r.admissions]);
    const after = await field(page);
    const s = got.samples;
    // Two consecutive samples both under the veil: no admission and no load
    // may have started between them.
    let veiledPairs = 0;
    const underVeil = [];
    for (let i = 1; i < s.length; i++) {
      const veiled = (x) => x.veil || x.covering;
      if (!veiled(s[i]) || !veiled(s[i - 1])) continue;
      veiledPairs += 1;
      if (s[i].adm !== s[i - 1].adm || s[i].ls !== s[i - 1].ls) underVeil.push({ t: s[i].t, adm: s[i].adm, ls: s[i].ls });
    }
    const atTrades = s.filter((x) => x.phase === 'trades');
    const first = atTrades.find((x) => x.adm > before.r.admissions);
    let settledAt = null;
    let lastTable = null;
    for (const x of atTrades) if (x.table !== lastTable) { lastTable = x.table; settledAt = x.t; }
    const last = s.at(-1);
    r.travelAccepted = got.ok;
    r.veilFrames = s.filter((x) => x.veil || x.covering).length;
    r.veiledPairs = veiledPairs;
    r.admittedUnderVeil = underVeil;
    r.firstPageMs = first ? first.t - got.poseAt : null;
    r.settledMs = settledAt === null ? null : settledAt - got.poseAt;
    r.final = { resident: last.resident, wanted: last.wanted, pipe: last.pipe, fading: last.fading, allIn: last.allIn, table: last.table };
    r.admissions = after.r.admissions - before.r.admissions;
    r.loadsStarted = after.r.loadsStarted - before.r.loadsStarted;
    r.workerStarted = after.pool.workerStarted;
    r.pages = tab.pages.length;
    r.samples = s.length;
    log(`  arrive: veil frames ${r.veilFrames} (${veiledPairs} veiled pairs${veiledPairs ? '' : ': the arrival was instant, the veil rule NOT exercised'}),`
      + ` first page ${r.firstPageMs} ms, settled ${r.settledMs} ms after the pose,`
      + ` ${r.admissions} admitted of ${r.loadsStarted} loads, final ${JSON.stringify(r.final)}`);
    if (got.ok === false) fail('travelTo(Earth) refused');
    if (underVeil.length) fail(`${underVeil.length} admission(s) or load(s) under the veil: ${JSON.stringify(underVeil[0])}`);
    if (!first) fail('no page became resident at trades');
    if (!(last.pipe === 'idle' && last.fading === 0 && last.allIn && last.wanted > 0)) {
      fail(`never settled in 30 s: ${JSON.stringify(r.final)}`);
    }
    if (tab.errors.length) fail(`${tab.errors.length} console/page error(s): ${tab.errors[0]}`);
  });
}

/** The deck hidden: released, not evicted, nothing fetched; shown again:
 *  the residents found again with no fetch. */
async function scenarioHidden(tab) {
  const { page } = tab;
  await run(tab, 'hidden', async (r, fail) => {
    await page.waitForFunction(() => typeof window.__moon.perfArm === 'function', null, { timeout: 15_000 });
    const base = await settleAt(page, TRADES);
    if (!base.settled || base.last.resident === 0) fail(`trades did not settle with pages resident first: ${JSON.stringify(base.last)}`);
    const s0 = await field(page);
    const req0 = tab.pages.length;
    const hide = (on) => page.evaluate((v) => window.__moon.perfArm('clouds', v), on);
    if (!await hide(true)) fail('the clouds role switch is not on the bridge (boot with ?perf=1)');
    await draw(page, 4);
    // Hidden at trades, then at 3,000 km, where the field wants pages it does
    // not hold: neither may fetch anything.
    const atTrades = await watch(page, { maxMs: 1500, settle: false });
    await pose(page, nadir(3000));
    await draw(page, 3);
    const at3000 = await watch(page, { maxMs: 2000, settle: false });
    const hiddenSamples = [...atTrades, ...at3000];
    const s1 = await field(page);
    const fetchedHidden = tab.pages.length - req0;
    // Shown again at trades: the same residents, no fetch.
    await pose(page, TRADES);
    await hide(false);
    await draw(page, 4);
    const shown = await watch(page, { maxMs: 2000, settle: false });
    const s2 = await field(page);
    // Then at 3,000 km: the demand the hidden deck held off loads.
    await pose(page, nadir(3000));
    // Sectors first: the pose's tiles may hold the first page back a while.
    const resumed = await watch(page, { maxMs: 10_000, settle: false, loadsOver: s2.r.loadsStarted });
    const s3 = await field(page);
    r.residentBefore = s0.r.resident;
    r.hiddenFlagShare = hiddenSamples.filter((x) => x.hidden).length / hiddenSamples.length;
    r.hiddenWantedMax = Math.max(...hiddenSamples.map((x) => x.wanted));
    r.hiddenKeptMax = Math.max(...hiddenSamples.map((x) => x.kept));
    r.hiddenPipes = [...new Set(hiddenSamples.map((x) => x.pipe))];
    r.hiddenDelta = {
      admissions: s1.r.admissions - s0.r.admissions, evictions: s1.r.evictions - s0.r.evictions,
      loadsStarted: s1.r.loadsStarted - s0.r.loadsStarted, requests: fetchedHidden,
    };
    r.tableStood = s1.pool.table.join(' ') === s0.pool.table.join(' ');
    r.shownDelta = {
      admissions: s2.r.admissions - s1.r.admissions, loadsStarted: s2.r.loadsStarted - s1.r.loadsStarted,
      wanted: s2.r.wanted, kept: s2.r.kept,
    };
    r.tableAfterShown = s2.pool.table.join(' ') === s0.pool.table.join(' ');
    r.at3000Shown = { wanted: s3.r.wanted, loadsStarted: s3.r.loadsStarted - s2.r.loadsStarted, firstLoadMs: resumed.find((x) => x.ls > s2.r.loadsStarted)?.t ?? null };
    log(`  hidden: ${r.residentBefore} resident; hidden flag ${(r.hiddenFlagShare * 100).toFixed(0)}% of samples,`
      + ` wanted max ${r.hiddenWantedMax}, kept max ${r.hiddenKeptMax}, pipe ${r.hiddenPipes.join('/')},`
      + ` deltas ${JSON.stringify(r.hiddenDelta)}, table stood ${r.tableStood};`
      + ` shown ${JSON.stringify(r.shownDelta)} table same ${r.tableAfterShown}; at 3,000 km shown ${JSON.stringify(r.at3000Shown)}`);
    if (r.hiddenFlagShare < 1) fail(`the residency read the deck as shown on ${hiddenSamples.filter((x) => !x.hidden).length} hidden sample(s)`);
    if (r.hiddenWantedMax > 0 || r.hiddenKeptMax > 0) fail(`pages wanted (${r.hiddenWantedMax}) or kept (${r.hiddenKeptMax}) with the deck hidden`);
    if (r.hiddenPipes.some((p) => p !== 'idle')) fail(`the pipe ran with the deck hidden: ${r.hiddenPipes.join(', ')}`);
    const d = r.hiddenDelta;
    if (d.admissions || d.loadsStarted || d.requests) fail(`work with the deck hidden: ${JSON.stringify(d)}`);
    if (d.evictions || !r.tableStood) fail('a released page was evicted: the table moved with nothing admitted');
    if (r.shownDelta.loadsStarted || r.shownDelta.admissions) fail(`the residents were fetched again once shown: ${JSON.stringify(r.shownDelta)}`);
    if (r.shownDelta.kept === 0 || r.shownDelta.wanted === 0) fail(`nothing wanted or kept once shown again: ${JSON.stringify(r.shownDelta)}`);
    if (!r.at3000Shown.loadsStarted) fail(`the 3,000 km pose loaded nothing once shown, so the hidden check there proved nothing: ${JSON.stringify(r.at3000Shown)}`);
    if (tab.errors.length) fail(`${tab.errors.length} console/page error(s): ${tab.errors[0]}`);
  });
}

/** Earth spinning at 900x: no admission, no load; resumed once stopped. */
async function scenarioSpin(tab) {
  const { page } = tab;
  await run(tab, 'spin', async (r, fail) => {
    await pose(page, TRADES);
    await draw(page, 3);
    // The latch on first, then the pool emptied, so whatever the field wants
    // from here on it can only take by admitting.
    const s0 = await page.evaluate(async () => {
      const m = window.__moon;
      m.setTimeRate(900);
      await m.waitForDraw(6);
      await m.cloudField({ auto: false });
      await m.cloudField({ auto: true });
      return (await m.cloudField()).residency;
    });
    const spinning = await watch(page, { maxMs: 6000, settle: false });
    const s1 = (await field(page)).r;
    await pose(page, TRADES);
    const stopped = await watch(page, { maxMs: 15_000, stillMs: 1000 });
    const s2 = (await field(page)).r;
    r.during = {
      admissions: s1.admissions - s0.admissions, loadsStarted: s1.loadsStarted - s0.loadsStarted,
      spinningShare: +(spinning.filter((x) => x.spinning).length / spinning.length).toFixed(3),
      wantedMax: Math.max(...spinning.map((x) => x.wanted)), samples: spinning.length,
    };
    r.after = {
      admissions: s2.admissions - s1.admissions,
      firstPageMs: stopped.find((x) => x.adm > s1.admissions)?.t ?? null, resident: s2.resident,
    };
    log(`  spin: during ${JSON.stringify(r.during)}; after ${JSON.stringify(r.after)}`);
    if (r.during.spinningShare < 0.9) fail(`the day latch held on only ${(r.during.spinningShare * 100).toFixed(0)}% of samples`);
    if (r.during.wantedMax === 0) fail('nothing was wanted while spinning, so the hold proved nothing');
    if (r.during.admissions || r.during.loadsStarted) fail(`work while spinning: ${JSON.stringify(r.during)}`);
    if (!r.after.admissions) fail('no admission once the clock stopped');
    if (tab.errors.length) fail(`${tab.errors.length} console/page error(s): ${tab.errors[0]}`);
  });
}

/** A roll sweep at two heights: no flap, and the churn per minute. */
async function scenarioPan(tab) {
  const { page } = tab;
  await run(tab, 'pan', async (r, fail) => {
    // The Mac display's ratio: twice the pixels a page has to answer for.
    await page.evaluate(() => window.__moon.pinCapture({ near: 1e-7, exposure: 1, pixelRatio: 2 }));
    const SWEEP_MS = 15_000;
    for (const [name, call] of [['400 km', TRADES], ['3,000 km', nadir(3000)]]) {
      const base = await settleAt(page, call);
      const s0 = (await field(page)).r;
      const samples = await page.evaluate(async ([c, ms]) => {
        const m = window.__moon;
        const [fn, ...a] = c;
        const roll0 = a[6];
        const start = performance.now();
        let done = false;
        const loop = () => {
          const t = performance.now() - start;
          if (t >= ms) { done = true; return; }
          const args = [...a];
          args[6] = roll0 + 40 * (t / ms);
          m[fn](...args);
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
        const out = [];
        while (!done) {
          const st = await m.cloudField();
          out.push({
            t: Math.round(performance.now() - start), wanted: st.residency.wanted,
            table: st.pool.table.map((e) => `${e.page}:${e.fade}`).join(' '),
          });
          await new Promise((res) => setTimeout(res, 100));
        }
        return out;
      }, [call, SWEEP_MS]);
      const s1 = (await field(page)).r;
      const minutes = SWEEP_MS / 60_000;
      const w = samples.map((x) => x.wanted);
      const f = flaps(samples);
      r[name] = {
        settledFirst: base.settled,
        admissionsPerMin: +((s1.admissions - s0.admissions) / minutes).toFixed(1),
        evictionsPerMin: +((s1.evictions - s0.evictions) / minutes).toFixed(1),
        loadsStarted: s1.loadsStarted - s0.loadsStarted, droppedAfterDecode: s1.droppedAfterDecode - s0.droppedAfterDecode,
        wantedMean: +(w.reduce((a, b) => a + b, 0) / w.length).toFixed(2), wantedMax: Math.max(...w),
        residentEnd: s1.resident, flaps: f, samples: samples.length,
      };
      log(`  pan ${name}: ${JSON.stringify({ ...r[name], flaps: f.length })}`);
      if (f.length) fail(`${name}: ${f.length} page(s) back within ${FLAP_MS} ms of leaving: ${JSON.stringify(f[0])}`);
      if (Math.max(...w) === 0) fail(`${name}: nothing was wanted through the sweep, so it proved nothing`);
    }
    await page.evaluate(() => window.__moon.pinCapture({ near: 1e-7, exposure: 1, pixelRatio: 1 }));
    if (tab.errors.length) fail(`${tab.errors.length} console/page error(s): ${tab.errors[0]}`);
  });
}

/** The pool's allocation reported failed: off, said once, the base drawn. */
async function scenarioFail(tab) {
  const { page } = tab;
  await run(tab, 'fail', async (r, fail) => {
    await page.waitForFunction(() => typeof window.__moon.perfArm === 'function', null, { timeout: 15_000 });
    await pose(page, TRADES);
    await draw(page, 4);
    await sleep(2500);
    const f = await field(page);
    const l = await page.evaluate(() => window.__moon.ladder());
    const off = tab.warnings.filter((w) => /Cloud field off/.test(w));
    // The deck shown against the deck hidden, the same frozen frame.
    const hide = (on) => page.evaluate((v) => window.__moon.perfArm('clouds', v), on);
    await draw(page, 3);
    const shownPng = await page.screenshot({ type: 'png' });
    await hide(true);
    await draw(page, 4);
    const hiddenPng = await page.screenshot({ type: 'png' });
    await hide(false);
    writeFileSync(path.join(OUT, 'fail-deck-shown.png'), shownPng);
    writeFileSync(path.join(OUT, 'fail-deck-hidden.png'), hiddenPng);
    const a = decodePng(shownPng);
    const b = decodePng(hiddenPng);
    let lifted = 0;
    let sum = 0;
    const n = a.width * a.height;
    for (let i = 0; i < n; i++) {
      const d = lum(a.pixels, i * a.channels) - lum(b.pixels, i * b.channels);
      sum += d;
      if (d >= CLOUD_LIFT_LEVELS) lifted += 1;
    }
    r.warnings = off;
    r.defineOn = f.defineOn;
    r.pool = f.pool;
    r.fixedBytes = l.fixedBytes;
    r.requests = tab.pages.length;
    r.workers = tab.workers;
    r.cloudShare = +(lifted / n).toFixed(4);
    r.meanLift = +(sum / n).toFixed(2);
    log(`  fail: ${off.length} 'Cloud field off' warning(s) [${off[0]?.slice(0, 160) ?? ''}], define ${f.defineOn},`
      + ` pool ${f.pool ? 'yes' : 'none'}, fixed ${l.fixedBytes} B, ${r.requests} page requests;`
      + ` the deck lifts ${(r.cloudShare * 100).toFixed(1)}% of the frame by ${CLOUD_LIFT_LEVELS}+ levels (mean ${r.meanLift})`);
    if (off.length !== 1) fail(`${off.length} 'Cloud field off' warnings, where exactly one is owed`);
    if (f.defineOn || f.pool || f.r) fail('the field is still on after its allocation failed');
    if (l.fixedBytes !== 0) fail(`the envelope still reserves ${l.fixedBytes} B for a pool that failed`);
    if (r.requests) fail(`${r.requests} page request(s) with the field off`);
    if (r.workers.some((u) => /cloudFieldWorker/.test(u))) fail('the page worker started with the field off');
    if (r.cloudShare < CLOUD_SHARE_MIN) {
      fail(`the deck lifts only ${(r.cloudShare * 100).toFixed(2)}% of the frame over the deck hidden: clear sky where the base sheet has cloud`);
    }
    if (tab.errors.length) fail(`${tab.errors.length} console/page error(s): ${tab.errors[0]}`);
  });
}

// --------------------------------------------------------------------- main

const release = await takeBrowserLock('cloud-field');
const launchedAt = Date.now();
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
try {
  if (ASKED.includes('off')) {
    const tab = await open(browser, '&cloudtiles=0');
    await scenarioOff(tab);
    await tab.context.close();
  }
  const onScenarios = ['arrive', 'hidden', 'spin', 'pan'].filter((s) => ASKED.includes(s));
  if (onScenarios.length) {
    const tab = await open(browser, '&perf=1');
    const pool = await field(tab.page);
    log(`field: pool ${pool.pool ? `${pool.pool.layers} layers, ${pool.pool.poolBytes} B` : 'NONE'}`);
    if (!pool.pool) {
      for (const s of onScenarios) result.scenarios[s] = { verdict: 'FAIL', failures: ['no pool: the field did not start'] };
    } else {
      if (ASKED.includes('arrive')) await scenarioArrive(tab);
      if (ASKED.includes('hidden')) await scenarioHidden(tab);
      if (ASKED.includes('spin')) await scenarioSpin(tab);
      if (ASKED.includes('pan')) await scenarioPan(tab);
    }
    await tab.context.close();
  }
  if (ASKED.includes('fail')) {
    const tab = await open(browser, '&cloudpoolfail=1&perf=1');
    await scenarioFail(tab);
    await tab.context.close();
  }
} finally {
  await browser.close();
  result.browserSeconds = Math.round((Date.now() - launchedAt) / 1000);
  save();
  release();
}

const failed = Object.entries(result.scenarios).filter(([, s]) => s.verdict !== 'PASS');
console.log(`\n=== cloud field probe (${result.hardware?.cpu}, ${result.hardware?.browser}) ===`);
for (const [name, s] of Object.entries(result.scenarios)) {
  console.log(`${name.padEnd(8)} ${s.verdict}${s.failures.length ? `  ${s.failures.join(' | ')}` : ''}`);
}
console.log(`browser ${result.browserSeconds} s; JSON: ${path.join(OUT, 'report.json')}`);
process.exit(ASSERT && failed.length ? 1 : 0);
