// The smoothness gate: a scripted battery that answers one question per
// scenario — was every frame delivered on time, and when one was not, what was
// happening that frame.
//
//   node tools/smoothness-gate.mjs --label=baseline
//   node tools/smoothness-gate.mjs --scenario=boot,earth-near --json
//
// Needs a dev server (this checkout, `npx vite --port 5656 --strictPort`) and,
// for the sector tiles, a tile host (`node planning/_tiles-serve.mjs` on 5622).
// Runs ONE browser and ONE tab at a time on the real GPU: a second WebGL tab
// steals the GPU process and every number below becomes fiction.
//
// The record comes from the app's own DEV frame trace (smoothnessTrace.ts),
// armed with ?smooth=1 before the first frame so a cold boot is measurable.
// Each frame carries its raf gap, whether the arrival veil was over it, and a
// one-word cause for the heavy events that fired inside it.
//
// VERDICT (per scenario): PASS when, after the loading screen is gone and
// outside the arrival veil's sanctioned cuts, no frame took more than 33 ms
// (two vsyncs at 60 Hz), p99 is at most 20 ms, and no long task ran past
// 50 ms. Frames under the veil are counted and reported separately rather
// than dropped, so a hitch that merely hid behind a cut is still visible.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
const has = (name) => process.argv.includes(`--${name}`);

const URL_BASE = arg('url', 'http://localhost:5656');
const TILES = arg('tiles', 'http://localhost:5622/');
const LABEL = arg('label', 'baseline');
const OUT_DIR = join(arg('out', '/tmp/moon-shots/smooth'), LABEL);
const ONLY = arg('scenario', '').split(',').map((s) => s.trim()).filter(Boolean);
const PRINT_JSON = has('json');

// Two vsyncs at 60 Hz. A frame past this is a visible hitch, not jitter.
const HITCH_MS = 33;
const BAD_MS = 50;
const P99_BUDGET_MS = 20;
const LONG_TASK_MS = 50;
const UPLOAD_BUDGET_MS = 8;
// A heap sample this much below its predecessor is a collection, not churn.
const GC_DROP_MIB = 5;

const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
// An iPhone 14 Pro Max viewport at its real device pixel ratio. The UA matters:
// the device profile reads it, and a phone profile is a different app.
const PHONE = {
  viewport: { width: 430, height: 932 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15'
    + ' (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- page setup

function appUrl(extra = '') {
  const params = new URLSearchParams();
  params.set('auto', 'planetarium');
  params.set('smooth', '1');
  if (TILES) params.set('tiles', TILES);
  const url = `${URL_BASE}/?${params.toString()}${extra}`;
  return url;
}

async function openPage(browser, device) {
  const context = await browser.newContext(device);
  await context.addInitScript(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
      indexedDB.deleteDatabase('orbital-sim-storage');
      // The first-run cards are not what the gate is measuring.
      localStorage.setItem('planetarium-help-seen', '1');
      localStorage.setItem('planetarium-surface-hint-seen', '1');
    } catch { /* a fresh profile may refuse storage; nothing to clear anyway */ }
    // Mark the frame the world actually becomes visible on. Polling on raf
    // rather than from out of process keeps the mark inside one frame of the
    // reveal, which is what "after reveal" has to mean to be worth anything.
    const watchReveal = () => {
      const screen = document.getElementById('loading-screen');
      const gone = !screen || screen.classList.contains('hidden')
        || getComputedStyle(screen).display === 'none';
      if (gone && window.__moon?.smoothMark) {
        window.__moon.smoothMark('reveal');
        return;
      }
      requestAnimationFrame(watchReveal);
    };
    requestAnimationFrame(watchReveal);
  });
  const page = await context.newPage();
  const notes = [];
  page.on('pageerror', (e) => notes.push(`pageerror: ${String(e).slice(0, 200)}`));
  page.on('console', (m) => {
    if (m.type() === 'error') notes.push(`console: ${m.text().slice(0, 200)}`);
  });
  return { context, page, notes };
}

async function bootTo(page, extra = '') {
  await page.goto(appUrl(extra), { waitUntil: 'domcontentloaded' });
  // waitForFunction takes the page argument second; an options object in that
  // slot is passed to the predicate and the wait silently uses its default.
  await page.waitForFunction(() => window.__moon?.ready?.(), null, { timeout: 120_000 });
  await page.waitForFunction(() => {
    const screen = document.getElementById('loading-screen');
    return !screen || screen.classList.contains('hidden');
  }, null, { timeout: 120_000 });
  // A software rasteriser would make every number below fiction, and it fails
  // silently: the app renders, just on the CPU.
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  });
  if (/swiftshader|llvmpipe|software/i.test(renderer)) {
    throw new Error(`software rasteriser (${renderer})`);
  }
  return renderer;
}

// ------------------------------------------------------------- drive helpers

const mark = (page, label) => page.evaluate((l) => window.__moon.smoothMark(l), label);

/** How close the ship is in the body's own radii — the only distance that
 *  means the same thing at Phobos and at Jupiter. probe() reports the radius
 *  and the absolute range; nothing reports the ratio. */
const radiiFrom = (page, name) => page.evaluate((n) => {
  const p = window.__moon.probe(n);
  return p && p.found && p.radiusAU ? p.distToBodyAU / p.radiusAU : null;
}, name);

/** Travel through the real pick pipeline and wait out the veil and the park. */
async function travelAndSettle(page, name, settleMs = 4_000) {
  await mark(page, `travel:${name}`);
  const ok = await page.evaluate((n) => window.__moon.travelTo(n), name);
  if (!ok) return `travelTo(${name}) refused`;
  // The flight needs a beat to start, or "not moving" reads as arrived when
  // it only means the ship has not left yet.
  await sleep(2_500);
  await page.waitForFunction(
    (n) => { const p = window.__moon.probe(n); return !!p && p.moving === false; },
    name,
    { timeout: 120_000 },
  ).catch(() => {});
  await sleep(settleMs);
  const radii = await radiiFrom(page, name);
  return radii === null || radii > 400 ? `${name}: parked ${radii} radii out` : null;
}

/** Hold a key for a while, letting the app's own governor decide the motion. */
async function holdKey(page, key, ms) {
  await page.keyboard.down(key);
  await sleep(ms);
  await page.keyboard.up(key);
}

/** Throttle toward the body until it fills the target radii, or time runs out. */
async function descendTo(page, name, targetRadii, budgetMs = 25_000) {
  const started = Date.now();
  await page.keyboard.down('w');
  try {
    while (Date.now() - started < budgetMs) {
      const radii = await radiiFrom(page, name);
      if (radii !== null && radii <= targetRadii) break;
      await sleep(250);
    }
  } finally {
    await page.keyboard.up('w');
  }
  return radiiFrom(page, name);
}

// ----------------------------------------------------------------- scenarios

const SCENARIOS = [
  {
    id: 'boot',
    title: 'Cold boot → first frame → the idle warm settling',
    device: DESKTOP,
    async run(page, note) {
      note(`renderer: ${await bootTo(page)}`);
      // The boot-idle warm runs after the reveal; nothing may cost a frame.
      await mark(page, 'idle-warm');
      await sleep(15_000);
    },
  },
  {
    id: 'earth-near',
    title: 'travelTo Earth → arrival → governed descent to the near band → 20 s hover',
    device: DESKTOP,
    async run(page, note) {
      await bootTo(page);
      await sleep(2_000);
      const failed = await travelAndSettle(page, 'Earth');
      if (failed) note(failed);
      await mark(page, 'near-band');
      await page.evaluate(() => window.__moon.jumpTo('Earth', 0.13));
      await sleep(2_500);
      await mark(page, 'descent');
      const at = await descendTo(page, 'Earth', 1.6);
      note(`descent ended at ${at} radii`);
      await mark(page, 'hover');
      await sleep(20_000);
    },
  },
  {
    id: 'terminator',
    title: 'Slow pan across the terminator in the near band (day/night families swap)',
    device: DESKTOP,
    async run(page, note) {
      await bootTo(page);
      await sleep(2_000);
      const failed = await travelAndSettle(page, 'Earth');
      if (failed) note(failed);
      await page.evaluate(() => window.__moon.jumpTo('Earth', 0.13));
      await sleep(2_500);
      const at = await descendTo(page, 'Earth', 1.4);
      note(`pan altitude ${at} radii`);
      await sleep(3_000);
      await mark(page, 'pan');
      // Short yaw taps rather than one long hold: the pan has to be slow
      // enough that the sector set changes a few tiles at a time, which is the
      // condition the day/night swap is worth measuring under.
      for (let i = 0; i < 14; i++) {
        await holdKey(page, 'a', 250);
        await sleep(1_000);
      }
      await sleep(3_000);
    },
  },
  {
    id: 'hops',
    title: 'Earth → Moon → Mars → Earth, arrivals and departures',
    device: DESKTOP,
    async run(page, note) {
      await bootTo(page);
      await sleep(2_000);
      for (const body of ['Earth', 'Moon', 'Mars', 'Earth']) {
        const failed = await travelAndSettle(page, body, 6_000);
        if (failed) note(failed);
      }
    },
  },
  {
    id: 'squeeze',
    title: 'Ladder squeeze under a 200 MiB envelope while hovering (release + re-fetch)',
    device: DESKTOP,
    // The envelope is read when the device profile is resolved, so it has to
    // be on the boot URL — it cannot be turned on mid-run.
    async run(page, note) {
      await bootTo(page, '&envelope=200');
      await sleep(2_000);
      const failed = await travelAndSettle(page, 'Earth');
      if (failed) note(failed);
      await page.evaluate(() => window.__moon.jumpTo('Earth', 0.13));
      await sleep(2_500);
      await descendTo(page, 'Earth', 1.6);
      await mark(page, 'squeeze-hover');
      await sleep(20_000);
      note(`ladder: ${JSON.stringify(await page.evaluate(() => window.__moon.ladder()))}`);
      note(`sectors: ${JSON.stringify(await page.evaluate(() => window.__moon.sectors()))}`);
      // A hop away and back is what forces the release to be paid back.
      const away = await travelAndSettle(page, 'Mars', 6_000);
      if (away) note(away);
      const back = await travelAndSettle(page, 'Earth', 10_000);
      if (back) note(back);
    },
  },
  {
    id: 'moonlets',
    title: 'Tiny-moon flybys: Phobos, then Styx',
    device: DESKTOP,
    async run(page, note) {
      await bootTo(page);
      await sleep(2_000);
      for (const body of ['Phobos', 'Styx']) {
        const failed = await travelAndSettle(page, body, 8_000);
        if (failed) note(failed);
      }
    },
  },
  {
    id: 'tour-60x',
    title: 'Planet tour at 60× time rate',
    device: DESKTOP,
    async run(page, note) {
      await bootTo(page);
      await sleep(2_000);
      await page.evaluate(() => window.__moon.setTimeRate(60));
      for (const body of ['Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune']) {
        const failed = await travelAndSettle(page, body, 4_000);
        if (failed) note(failed);
      }
      await page.evaluate(() => window.__moon.setTimeRate(1));
    },
  },
  {
    id: 'phone-earth-near',
    title: 'Phone (430×932 @3): travel to Earth, governed descent, 20 s hover',
    device: PHONE,
    async run(page, note) {
      await bootTo(page);
      await sleep(2_000);
      note(`device: ${JSON.stringify(await page.evaluate(() => window.__moon.device()))}`);
      const failed = await travelAndSettle(page, 'Earth');
      if (failed) note(failed);
      await page.evaluate(() => window.__moon.jumpTo('Earth', 0.13));
      await sleep(2_500);
      const at = await descendTo(page, 'Earth', 1.6);
      note(`descent ended at ${at} radii`);
      await mark(page, 'hover');
      await sleep(20_000);
    },
  },
  {
    id: 'phone-terminator',
    title: 'Phone (430×932 @3): slow pan across the terminator',
    device: PHONE,
    async run(page, note) {
      await bootTo(page);
      await sleep(2_000);
      const failed = await travelAndSettle(page, 'Earth');
      if (failed) note(failed);
      await page.evaluate(() => window.__moon.jumpTo('Earth', 0.13));
      await sleep(2_500);
      await descendTo(page, 'Earth', 1.4);
      await sleep(3_000);
      await mark(page, 'pan');
      for (let i = 0; i < 14; i++) {
        await holdKey(page, 'a', 250);
        await sleep(1_000);
      }
      await sleep(3_000);
    },
  },
];

// ------------------------------------------------------------------ analysis

const CAUSES = ['veil', 'tile', 'release', 'rung', 'upload', 'mark'];
const causeNames = (mask) => CAUSES.filter((_, i) => mask & (1 << i));

function veilWindows(causeMask) {
  const bit = 1 << CAUSES.indexOf('veil');
  const windows = [];
  let start = -1;
  for (let i = 0; i <= causeMask.length; i++) {
    const veiled = i < causeMask.length && (causeMask[i] & bit) !== 0;
    if (veiled && start === -1) start = i;
    if (!veiled && start !== -1) {
      // The frame on each side straddles the transition and is half covered;
      // neither can be scored honestly, so both go with the cut.
      windows.push([Math.max(0, start - 1), Math.min(causeMask.length - 1, i)]);
      start = -1;
    }
  }
  return windows;
}

const inWindows = (i, windows) => windows.some(([a, b]) => i >= a && i <= b);

function percentile(sortedAsc, fraction) {
  if (!sortedAsc.length) return 0;
  const rank = Math.ceil(fraction * sortedAsc.length);
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))];
}

const round2 = (v) => Math.round(v * 100) / 100;

function analyze(trace, scenario, notes) {
  const { gapMs, causeMask, atMs, events, longTasks, heapMB } = trace;
  const windows = veilWindows(causeMask);
  const revealEvent = events.find((e) => e.kind === 'mark' && e.name === 'reveal');
  const revealFrame = revealEvent ? revealEvent.frame : 0;
  const revealAtMs = revealEvent ? revealEvent.atMs : 0;

  const eventsByFrame = new Map();
  for (const e of events) {
    if (!eventsByFrame.has(e.frame)) eventsByFrame.set(e.frame, []);
    eventsByFrame.get(e.frame).push(e);
  }

  const scored = [];
  const veiled = [];
  for (let i = revealFrame; i < gapMs.length; i++) {
    const gap = gapMs[i];
    if (gap === null) continue;
    (inWindows(i, windows) ? veiled : scored).push({ i, gap });
  }
  const gaps = scored.map((s) => s.gap);
  const sorted = gaps.slice().sort((a, b) => a - b);
  const sum = gaps.reduce((a, b) => a + b, 0);

  const hitches = scored.filter((s) => s.gap > HITCH_MS);
  const worst = scored.slice().sort((a, b) => b.gap - a.gap).slice(0, 10).map(({ i, gap }) => ({
    frame: i,
    atMs: atMs[i],
    gapMs: round2(gap),
    causes: causeNames(causeMask[i]).filter((c) => c !== 'veil'),
    events: (eventsByFrame.get(i) ?? []).map((e) => ({
      kind: e.kind,
      name: e.name,
      durationMs: e.durationMs,
    })),
  }));

  const tasksAfterReveal = longTasks.filter((t) => t.atMs >= revealAtMs);
  // The veil is the app's sanctioned cut; a task inside one is covered work,
  // not a stutter. Both counts are reported so nothing is hidden by the split.
  const frameAtMs = (i) => atMs[i];
  const veilSpans = windows.map(([a, b]) => [frameAtMs(a), frameAtMs(b)]);
  const inVeilTime = (t) => veilSpans.some(([a, b]) => t >= a && t <= b);
  const tasksOutside = tasksAfterReveal.filter((t) => !inVeilTime(t.atMs));

  const uploads = events
    .filter((e) => e.kind === 'upload' && (e.durationMs ?? 0) > UPLOAD_BUDGET_MS)
    .map((e) => ({ atMs: e.atMs, frame: e.frame, name: e.name, durationMs: e.durationMs }))
    .sort((a, b) => b.durationMs - a.durationMs);

  const gcDrops = [];
  let previous = null;
  for (let i = 0; i < heapMB.length; i++) {
    const sample = heapMB[i];
    if (sample === null) continue;
    if (previous !== null && previous.mb - sample > GC_DROP_MIB) {
      gcDrops.push({ frame: i, atMs: atMs[i], freedMiB: round2(previous.mb - sample) });
    }
    previous = { mb: sample, frame: i };
  }

  const maxMs = round2(sorted.at(-1) ?? 0);
  const p99 = round2(percentile(sorted, 0.99));
  const maxTaskMs = tasksOutside.reduce((m, t) => Math.max(m, t.durationMs), 0);
  const failures = [];
  if (maxMs > HITCH_MS) {
    failures.push(`${hitches.length} frame(s) over ${HITCH_MS} ms outside veils, worst ${maxMs} ms`);
  }
  if (p99 > P99_BUDGET_MS) failures.push(`p99 ${p99} ms over the ${P99_BUDGET_MS} ms budget`);
  if (maxTaskMs > LONG_TASK_MS) {
    failures.push(`${tasksOutside.filter((t) => t.durationMs > LONG_TASK_MS).length} long task(s)`
      + ` over ${LONG_TASK_MS} ms after reveal, worst ${round2(maxTaskMs)} ms`);
  }

  return {
    scenario: scenario.id,
    title: scenario.title,
    verdict: failures.length ? 'FAIL' : 'PASS',
    failures,
    frames: gapMs.length,
    droppedFrames: trace.dropped,
    revealFrame,
    revealAtMs,
    scoredFrames: gaps.length,
    veiledFrames: veiled.length,
    veilWindows: windows.length,
    veilMsTotal: round2(veilSpans.reduce((a, [x, y]) => a + (y - x), 0)),
    meanMs: gaps.length ? round2(sum / gaps.length) : 0,
    p50Ms: round2(percentile(sorted, 0.5)),
    p95Ms: round2(percentile(sorted, 0.95)),
    p99Ms: p99,
    maxMs,
    over33: hitches.length,
    over50: scored.filter((s) => s.gap > BAD_MS).length,
    over33InVeil: veiled.filter((s) => s.gap > HITCH_MS).length,
    longTasksAfterReveal: tasksAfterReveal.length,
    longTasksOutsideVeils: tasksOutside.length,
    longTaskMaxOutsideMs: round2(maxTaskMs),
    longTasksWorst: tasksOutside.slice().sort((a, b) => b.durationMs - a.durationMs).slice(0, 5),
    uploadsOverBudget: uploads.length,
    uploadsWorst: uploads.slice(0, 8),
    tileMaterializations: events.filter((e) => e.kind === 'tile').length,
    tileReleases: events.filter((e) => e.kind === 'release').length,
    rungApplies: events.filter((e) => e.kind === 'rung').length,
    gcDrops: gcDrops.length,
    gcWorst: gcDrops.slice().sort((a, b) => b.freedMiB - a.freedMiB).slice(0, 3),
    worstFrames: worst,
    marks: events.filter((e) => e.kind === 'mark').map((e) => ({ atMs: e.atMs, name: e.name })),
    notes,
    environment: trace.environment,
  };
}

// ---------------------------------------------------------------------- main

mkdirSync(OUT_DIR, { recursive: true });

const chosen = ONLY.length ? SCENARIOS.filter((s) => ONLY.includes(s.id)) : SCENARIOS;
if (!chosen.length) {
  console.error(`No scenario matched ${ONLY.join(',')}. Known: ${SCENARIOS.map((s) => s.id).join(', ')}`);
  process.exit(2);
}

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: [
    '--use-gl=angle',
    '--use-angle=metal',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader',
  ],
});

const results = [];
try {
  for (const scenario of chosen) {
    const startedAt = Date.now();
    process.stdout.write(`[gate] ${scenario.id}: ${scenario.title}\n`);
    const { context, page, notes } = await openPage(browser, scenario.device);
    const note = (message) => notes.push(message);
    let trace = null;
    try {
      await scenario.run(page, note);
      trace = await page.evaluate(() => window.__moon.smoothStop());
    } catch (err) {
      note(`scenario threw: ${String(err).slice(0, 300)}`);
      trace = await page.evaluate(() => window.__moon?.smoothStop?.() ?? null).catch(() => null);
    } finally {
      await context.close();
    }
    if (!trace) {
      results.push({
        scenario: scenario.id,
        title: scenario.title,
        verdict: 'NO DATA',
        failures: ['the frame trace was never armed or returned nothing'],
        notes,
      });
      continue;
    }
    const analysis = analyze(trace, scenario, notes);
    analysis.wallSeconds = Math.round((Date.now() - startedAt) / 100) / 10;
    results.push(analysis);
    writeFileSync(join(OUT_DIR, `${scenario.id}.json`), JSON.stringify({ analysis, trace }, null, 1));
    process.stdout.write(
      `       ${analysis.verdict}  mean ${analysis.meanMs}  p95 ${analysis.p95Ms}`
      + `  p99 ${analysis.p99Ms}  max ${analysis.maxMs}  >33 ${analysis.over33}`
      + `  >50 ${analysis.over50}  tasks ${analysis.longTasksOutsideVeils}\n`,
    );
  }
} finally {
  await browser.close();
}

writeFileSync(join(OUT_DIR, 'summary.json'), JSON.stringify(results, null, 1));

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);
console.log(`\n=== smoothness gate: ${LABEL} ===`);
console.log([
  pad('scenario', 18), num('frames', 7), num('mean', 7), num('p95', 7), num('p99', 7),
  num('max', 8), num('>33', 5), num('>50', 5), num('tasks', 6), num('up>8', 6), '  verdict',
].join(''));
for (const r of results) {
  console.log([
    pad(r.scenario, 18), num(r.scoredFrames ?? '-', 7), num(r.meanMs ?? '-', 7),
    num(r.p95Ms ?? '-', 7), num(r.p99Ms ?? '-', 7), num(r.maxMs ?? '-', 8),
    num(r.over33 ?? '-', 5), num(r.over50 ?? '-', 5), num(r.longTasksOutsideVeils ?? '-', 6),
    num(r.uploadsOverBudget ?? '-', 6), '  ', r.verdict,
  ].join(''));
  for (const f of r.failures ?? []) console.log(`${' '.repeat(18)}- ${f}`);
}
console.log(`\nJSON: ${OUT_DIR}`);
if (PRINT_JSON) console.log(JSON.stringify(results, null, 1));

const failed = results.filter((r) => r.verdict !== 'PASS');
process.exit(failed.length ? 1 : 0);
