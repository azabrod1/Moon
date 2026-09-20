// What a Look-inside open COSTS, through the app's own doors and the app's own
// marks — the battery behind any claim that the tool opens faster.
//
// It drives the real entries: `?auto=interior&body=` for a first entry (the
// door a link takes), `__moon.interiorPick` for a swap, and
// `__moon.interiorExit` + `__moon.interiorOpen` for a return entry. It never
// patches the app: every number comes from the marks the app already keeps —
// `interiorState().timings` on the dev server, and the `Look inside: open
// timings` / `Look inside: switch timings` console lines in a production
// build, where there is no bridge and a phone would answer the same way
// through `?debug=1`.
//
// Beside the marks it records what a reader would feel: the rAF gaps across
// the open (measured from the callback's own execution time — a rAF timestamp
// goes stale after a busy main thread), the long tasks, and every fragment
// shader the page submitted, with the light counts compiled into it. The last
// is what says whether a program was built for a light state nothing draws:
// `directionalLights[ 2 ]` in a warm-up beside `directionalLights[ 1 ]` in the
// draw is a program built twice and used once.
//
// The driver's shader cache survives a fresh browser context, so an ordinary
// run is a WARM-cache run however new the page is. `--cold-cache` is the other
// reading: a fresh user data dir with the GPU's disk cache off, which is what a
// machine's first visit after a deploy pays.
//
//   node tools/interior-open-probe.mjs --url=http://127.0.0.1:5173 --label=dev-desktop
//   node tools/interior-open-probe.mjs --url=http://127.0.0.1:4173 --phone --repeats=10
//   node tools/interior-open-probe.mjs --cold-cache --repeats=3 --label=dev-desktop-cold
//   node tools/interior-open-probe.mjs --assert          # the pass conditions, as a gate
//
// The gate (`--assert`) fails on:
//   - any fragment shader compiled for two directional or two hemisphere
//     lights (the studio's own lights counted twice);
//   - any fragment shader submitted after `present` on a swap (a program the
//     reader waits for, built while they are watching);
//   - `programsWhenReady !== programsAtReveal` on a swap (the same, counted);
//   - an entry whose veil lifted before a frame of the studio was drawn, or
//     after the reveal started (firstFrame < veilLifted < revealStart);
//   - a body seen twice that builds anything but its own skin, or builds it
//     anywhere but inside the close: the studio holds its own programs (rings,
//     air, corona, photosphere, ghost, deck) for the session, and a body's skin
//     is the one thing left that a body change can compile — which is what the
//     close's warm-up is for.
//
// One browser at a time on this machine (tools/browserLock.mjs), real GPU.
import { chromium } from 'playwright';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { takeBrowserLock } from './browserLock.mjs';

function arg(name, fallback) {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const baseUrl = arg('url', 'http://127.0.0.1:5173');
const label = arg('label', 'open-probe');
const outDir = arg('out', `planning/interior-profile/open-probe/${label}`);
const phone = flag('phone');
const coldCache = flag('cold-cache');
const asserting = flag('assert');
// The cached paths (a swap, a return entry) are cheap, so they carry the
// repeats; a first entry reboots the whole app and takes its own, smaller count.
const repeats = Number(arg('repeats', '10'));
const entries = Number(arg('entries', '3'));
const bodies = arg('bodies', 'Earth,Mars,Moon,Jupiter,Saturn,Sun,Europa').split(',').filter(Boolean);
// Appended to every URL this opens, both doors alike.
const extraQuery = arg('extra', '');
const timeoutMs = Number(arg('timeout', '180000'));

await mkdir(outDir, { recursive: true });

const failures = [];
const notes = [];
function check(condition, message) {
  if (condition) return true;
  failures.push(message);
  console.log(`  FAIL ${message}`);
  return false;
}

/** Everything the page keeps for us, installed before any app code runs. */
function initScript() {
  try {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('orbital-sim-storage');
    localStorage.setItem('planetarium-help-seen', '1');
  } catch { /* a fresh context may refuse storage; the app copes */ }
  window.__openProbe = { frames: [], longTasks: [], shaders: [] };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__openProbe.longTasks.push({ start: entry.startTime, ms: entry.duration });
    }).observe({ type: 'longtask', buffered: true });
  } catch { /* no long-task observer here */ }
  // The callback's OWN execution time, never the rAF timestamp: a timestamp
  // handed to a callback after a busy main thread is the frame that was due,
  // not the frame that ran, and the gap a reader felt would vanish from it.
  let previous = null;
  const tick = () => {
    const now = performance.now();
    if (previous !== null) window.__openProbe.frames.push({ start: previous, ms: now - previous });
    previous = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  // Every fragment shader the page compiles, with the light counts baked into
  // it and the instant it was submitted.
  const record = (source) => {
    if (typeof source !== 'string' || !source.includes('gl_FragColor')) return;
    window.__openProbe.shaders.push({
      t: performance.now(),
      chars: source.length,
      name: (source.match(/#define SHADER_NAME ([^\n]+)/) || [])[1] || '',
      dir: Number((source.match(/uniform DirectionalLight directionalLights\[ (\d+) \]/) || [])[1] ?? 0),
      hemi: Number((source.match(/uniform HemisphereLight hemisphereLights\[ (\d+) \]/) || [])[1] ?? 0),
      section: source.includes('sectionSample'),
      skin: source.includes('uCutHalfAngle'),
    });
  };
  for (const proto of [window.WebGL2RenderingContext?.prototype, window.WebGLRenderingContext?.prototype]) {
    if (!proto) continue;
    const original = proto.shaderSource;
    proto.shaderSource = function (shader, source) {
      try { record(source); } catch { /* recording must never break a compile */ }
      return original.call(this, shader, source);
    };
  }
}

const release = await takeBrowserLock('interior-open-probe');
let browser = null;
let userDataDir = null;
const results = [];
const pageErrors = [];

/** Wait for an open to finish. With the bridge, inside the page — never
 *  through `waitForFunction`, which injects a poll into every animation frame
 *  and makes the very hitch this is measuring. Without it (a production build)
 *  the wait is here in node, on the tool's own console line, and the page is
 *  left entirely alone. */
async function waitForOpen(page, bodyId, deadlineMs, { hasBridge, lines, from }) {
  if (hasBridge) {
    return page.evaluate(async ({ bodyId, deadlineMs }) => {
      const started = performance.now();
      const settled = () => {
        const state = window.__moon.interiorState();
        return !!state && state.bodyId === bodyId && window.__moon.interiorReady()
          && !document.getElementById('mode-transition')?.classList.contains('active');
      };
      for (;;) {
        if (settled()) return { ok: true, waitedMs: performance.now() - started };
        if (performance.now() - started > deadlineMs) return { ok: false, waitedMs: performance.now() - started };
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    }, { bodyId, deadlineMs });
  }
  const started = Date.now();
  for (;;) {
    if (lines.slice(from).some((entry) => entry.kind === 'open' && entry.parsed.bodyId === bodyId)) {
      return { ok: true, waitedMs: Date.now() - started };
    }
    if (Date.now() - started > deadlineMs) return { ok: false, waitedMs: Date.now() - started };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** What was going on around one open: the gaps, the long tasks and the shaders. */
async function collectCase(page, startedAt) {
  return page.evaluate((from) => {
    const probe = window.__openProbe;
    const gaps = probe.frames.filter((f) => f.start >= from).map((f) => f.ms).sort((a, b) => a - b);
    const at = (fraction) => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * fraction))] : null);
    return {
      frameGaps: { n: gaps.length, median: at(0.5), p95: at(0.95), worst: gaps.length ? gaps[gaps.length - 1] : null },
      longTasks: probe.longTasks.filter((t) => t.start >= from).map((t) => ({ start: Math.round(t.start - from), ms: Math.round(t.ms) })),
      shaders: probe.shaders.filter((s) => s.t >= from).map((s) => ({ ...s, t: Math.round((s.t - from) * 10) / 10 })),
    };
  }, startedAt);
}

function summarize(values) {
  const sorted = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  return { n: sorted.length, median: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

const MARKS = ['prepareStart', 'prepareEnd', 'present', 'precompileStart', 'precompileEnd', 'firstFrame', 'veilLifted', 'firstVisibleFrame', 'revealStart', 'ready'];

try {
  const args = ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    ...(coldCache ? ['--disable-gpu-shader-disk-cache', '--disable-gpu-program-cache'] : []),
    ...(process.env.PW_NO_SANDBOX ? ['--no-sandbox'] : [])];
  const viewport = phone ? { width: 390, height: 844 } : { width: 1400, height: 800 };
  const contextOptions = { viewport, deviceScaleFactor: phone ? 3 : 1, isMobile: phone, hasTouch: phone };

  let context;
  if (coldCache) {
    // A fresh user data dir is the only way to reach the driver's own shader
    // cache: it outlives a browser context, so a new page is a WARM run.
    userDataDir = await mkdtemp(path.join(tmpdir(), 'moon-open-probe-'));
    context = await chromium.launchPersistentContext(userDataDir, { headless: true, args, ...contextOptions });
    browser = context.browser();
  } else {
    browser = await chromium.launch({ headless: true, args });
    context = await browser.newContext(contextOptions);
  }
  await context.addInitScript(initScript);

  /** One page, its console kept HERE: the tool's own lines are a production
   *  build's only report, and reading them in node leaves the page alone.
   *  `console.log(line, extra)` prints the object twice — once as JSON inside
   *  the line and once as the browser's own rendering — so the match stops at
   *  the first closing brace; these lines are flat. */
  async function openPage(lines) {
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('console', (message) => {
      const text = message.text();
      const open = text.match(/Look inside: open timings (\{[^}]*\})/);
      const switched = text.match(/Look inside: switch timings (\{[^}]*\})/);
      if (!open && !switched) return;
      try {
        lines.push({ at: Date.now(), kind: open ? 'open' : 'switch', parsed: JSON.parse((open ?? switched)[1]) });
      } catch { /* a line we cannot read is a line we do not keep */ }
    });
    return page;
  }

  /** The machine and the frame this run was measured on, saved beside every
   *  number: a millisecond means nothing without them. */
  async function machineOf(page) {
    return page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      const gl = canvas?.getContext('webgl2') ?? null;
      const ext = gl?.getExtension('WEBGL_debug_renderer_info');
      return {
        gpu: gl ? (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : null,
        dpr: window.devicePixelRatio,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        renderPath: window.__moon?.renderPath?.() ?? null,
        targets: window.__moon?.perfTargets?.() ?? null,
        build: document.getElementById('menu-build')?.textContent ?? null,
        bridge: !!window.__moon,
      };
    });
  }

  /** A case's marks, collected and filed. `kind` is how the tool was reached. */
  async function runCase(page, { kind, bodyId, repeat, drive, lines, hasBridge }) {
    const mark = lines.length;
    const startedAt = await page.evaluate(() => {
      const now = performance.now();
      window.__openProbe.caseStartedAt = now;
      return now;
    });
    await drive();
    const waited = await waitForOpen(page, bodyId, timeoutMs, { hasBridge, lines, from: mark });
    // The marks, whichever build this is: the bridge on the dev server, the
    // tool's own console line in a production build.
    const fromBridge = hasBridge ? await page.evaluate(() => window.__moon.interiorState()?.timings ?? null) : null;
    const since = lines.slice(mark);
    const line = since.filter((entry) => entry.kind === 'open' && entry.parsed.bodyId === bodyId).map((entry) => entry.parsed).pop() ?? null;
    const switchLine = since.filter((entry) => entry.kind === 'switch').map((entry) => entry.parsed).pop() ?? null;
    const around = await collectCase(page, startedAt);
    const marksOf = fromBridge ?? line;
    // The marks are measured from the open's own start (the activate, or the
    // pick); everything collected here from the start of the case, which for an
    // entry is the page load. One origin or the two cannot be compared: the
    // open settled `waited.waitedMs` into the case and `ready` ms into itself,
    // and the difference is the offset between them (a frame's worth at worst).
    const offsetMs = marksOf && typeof marksOf.ready === 'number' ? waited.waitedMs - marksOf.ready : 0;
    const shaders = around.shaders.map((shader) => ({ ...shader, mark: Math.round((shader.t - offsetMs) * 10) / 10 }));
    const record = {
      kind, bodyId, repeat,
      settled: waited.ok,
      observedMs: Math.round(waited.waitedMs),
      timings: marksOf,
      timingsSource: fromBridge ? 'bridge' : (line ? 'console' : 'none'),
      switchTimings: switchLine,
      originOffsetMs: Math.round(offsetMs),
      ...around,
      shaders,
    };
    results.push(record);
    const marks = record.timings ?? {};
    console.log(`  ${kind} ${bodyId}#${repeat} observed ${record.observedMs}ms`
      + ` prepare ${marks.prepareEnd ?? '-'} present ${marks.present ?? '-'} reveal ${marks.revealStart ?? '-'}`
      + ` veil ${marks.veilLifted ?? '-'} ready ${marks.ready ?? '-'}`
      + ` programs ${marks.programsAtReveal ?? '-'}→${marks.programsWhenReady ?? '-'}`
      + ` worst gap ${record.frameGaps.worst === null ? '-' : Math.round(record.frameGaps.worst)}ms`
      + ` shaders ${record.shaders.length}`);
    return record;
  }

  const query = `?quality=medium&nosw=1${extraQuery}`;
  let machine = null;

  // --- first entries: a fresh page each, the door a link takes ---------------
  for (let repeat = 0; repeat < entries; repeat++) {
    const lines = [];
    const page = await openPage(lines);
    const body = bodies[0];
    console.log(`[entry] ${body} repeat ${repeat + 1}/${entries}${coldCache ? ' (fresh profile)' : ''}`);
    await page.goto(`${baseUrl}/${query}&auto=interior&body=${body}`, { waitUntil: 'domcontentloaded' });
    const hasBridge = await page.evaluate(() => !!window.__moon?.interiorState);
    await runCase(page, { kind: 'entry', bodyId: body, repeat, drive: async () => {}, lines, hasBridge });
    if (!machine) machine = await machineOf(page);
    await page.close();
  }

  // --- swaps and return entries: one page, the cached paths -----------------
  {
    const lines = [];
    const page = await openPage(lines);
    console.log(`[swaps] ${bodies.join(' → ')} × ${repeats}`);
    await page.goto(`${baseUrl}/${query}&auto=interior&body=${bodies[0]}`, { waitUntil: 'domcontentloaded' });
    const hasBridge = await page.evaluate(() => !!window.__moon?.interiorPick);
    await runCase(page, { kind: 'entry-page', bodyId: bodies[0], repeat: 0, drive: async () => {}, lines, hasBridge });
    if (!machine) machine = await machineOf(page);
    if (!hasBridge) {
      notes.push('no dev bridge on this build: swaps and return entries are driven through the picker UI');
    }
    for (let repeat = 0; repeat < repeats; repeat++) {
      for (const body of bodies) {
        if (repeat === 0 && body === bodies[0]) continue; // already on it
        await runCase(page, {
          kind: 'swap', bodyId: body, repeat, lines, hasBridge,
          drive: async () => {
            if (hasBridge) {
              await page.evaluate((id) => window.__moon.interiorPick(id), body);
              return;
            }
            // No bridge: the reader's own way in — the body chip, then the row.
            await page.click('#interior-body-chip');
            await page.fill('#interior-picker-search', body);
            await page.click(`#interior-picker-list .pk-row:has-text("${body}")`);
          },
        });
      }
    }
    // A return entry: the module is in the map and the driver has the programs,
    // so what is left is the switch itself.
    if (hasBridge) {
      for (let repeat = 0; repeat < Math.min(2, entries); repeat++) {
        const body = bodies[0];
        await page.evaluate(() => window.__moon.interiorExit());
        await page.evaluate(async () => {
          for (let i = 0; i < 600; i++) {
            if (!document.getElementById('mode-transition')?.classList.contains('active')) return;
            await new Promise((resolve) => requestAnimationFrame(resolve));
          }
        });
        await runCase(page, {
          kind: 'return-entry', bodyId: body, repeat, lines, hasBridge,
          drive: async () => { await page.evaluate((id) => window.__moon.interiorOpen(id), body); },
        });
      }
    }
    await page.close();
  }

  // --- the table ------------------------------------------------------------
  const byKind = new Map();
  for (const record of results) {
    const list = byKind.get(record.kind) ?? [];
    list.push(record);
    byKind.set(record.kind, list);
  }
  const table = [];
  for (const [kind, records] of byKind) {
    const row = { kind, n: records.length, marks: {}, worstGapMs: null, programsGrew: 0, shadersAfterPresent: 0 };
    for (const mark of MARKS) row.marks[mark] = summarize(records.map((record) => record.timings?.[mark] ?? null));
    row.observed = summarize(records.map((record) => record.observedMs));
    row.worstGapMs = Math.round(Math.max(...records.map((record) => record.frameGaps.worst ?? 0)));
    row.programsGrew = records.filter((record) => {
      const marks = record.timings;
      return marks && marks.programsAtReveal !== null && marks.programsWhenReady !== null && marks.programsWhenReady !== marks.programsAtReveal;
    }).length;
    row.shadersAfterPresent = records.reduce((total, record) => {
      const present = record.timings?.present ?? null;
      if (present === null) return total;
      return total + record.shaders.filter((shader) => shader.mark > present).length;
    }, 0);
    row.twoLightShaders = records.reduce((total, record) => total + record.shaders.filter((shader) => shader.dir > 1 || shader.hemi > 1).length, 0);
    table.push(row);
  }

  console.log('');
  console.log(`label ${label}  url ${baseUrl}  ${phone ? 'phone 390×844 dpr3' : 'desktop 1400×800 dpr1'}  driver cache ${coldCache ? 'cold' : 'warm'}`);
  console.log(`gpu ${machine?.gpu ?? '?'}  sceneRatio ${machine?.renderPath?.sceneRatio ?? '?'}  samples ${machine?.renderPath?.sceneTargetSamples ?? '?'}  build ${machine?.build ?? '(dev)'}`);
  for (const row of table) {
    const cell = (mark) => {
      const summary = row.marks[mark];
      return summary ? `${mark} ${Math.round(summary.median)}/${Math.round(summary.p95)}` : `${mark} -`;
    };
    console.log(`${row.kind.padEnd(12)} n=${String(row.n).padEnd(3)} observed ${Math.round(row.observed?.median ?? 0)}/${Math.round(row.observed?.p95 ?? 0)}ms  `
      + [cell('prepareEnd'), cell('present'), cell('revealStart'), cell('veilLifted'), cell('firstVisibleFrame'), cell('ready')].join('  '));
    console.log(`${''.padEnd(12)} worst frame gap ${row.worstGapMs}ms, ${row.twoLightShaders} two-light shaders, ${row.shadersAfterPresent} fragment submissions after present, ${row.programsGrew} opens whose program count grew after the reveal`);
  }

  // --- the gate -------------------------------------------------------------
  if (asserting) {
    const twoLight = results.flatMap((record) => record.shaders.filter((shader) => shader.dir > 1 || shader.hemi > 1).map((shader) => `${record.kind} ${record.bodyId}: ${shader.name || '?'} dir=${shader.dir} hemi=${shader.hemi}`));
    check(twoLight.length === 0, `shaders compiled for two lights: ${twoLight.slice(0, 6).join('; ')}`);
    for (const record of results.filter((row) => row.kind === 'swap')) {
      const present = record.timings?.present ?? null;
      if (present === null) continue;
      const late = record.shaders.filter((shader) => shader.mark > present);
      check(late.length === 0, `${record.bodyId} swap compiled ${late.length} fragment shaders after present (${late.map((s) => s.name || '?').slice(0, 4).join(', ')})`);
      check(record.timings.programsWhenReady === record.timings.programsAtReveal,
        `${record.bodyId} swap grew from ${record.timings.programsAtReveal} to ${record.timings.programsWhenReady} programs after the reveal`);
    }
    for (const record of results.filter((row) => row.kind === 'entry' || row.kind === 'entry-page' || row.kind === 'return-entry')) {
      const marks = record.timings;
      if (!marks || marks.veilLifted === null) { notes.push(`${record.kind} ${record.bodyId}: no veilLifted mark`); continue; }
      check(marks.firstFrame !== null && marks.firstFrame <= marks.veilLifted,
        `${record.kind} ${record.bodyId}: the veil lifted at ${marks.veilLifted}ms with the studio's first frame at ${marks.firstFrame}`);
      check(marks.revealStart !== null && marks.veilLifted <= marks.revealStart,
        `${record.kind} ${record.bodyId}: the reveal started at ${marks.revealStart}ms, before the veil lifted at ${marks.veilLifted}ms`);
    }
    // A body seen twice must bring nothing new: the studio's own programs are
    // held for the session, so the only thing a repeat visit could build is a
    // skin the driver has already seen. Program counts are compared per body,
    // because each body's SKIN keys differently and only the body on screen
    // has one alive — the count moves with the body and must not move with the
    // visit.
    const visits = new Map();
    for (const record of results.filter((row) => row.kind === 'swap' && row.timings)) {
      const seen = visits.get(record.bodyId) ?? [];
      seen.push(record);
      visits.set(record.bodyId, seen);
      if (seen.length === 1) continue; // the first visit can still overlap the idle warm-up
      // Nothing but the skin, and nothing outside the close. Every other
      // program the studio draws is held for the session.
      const late = record.shaders.filter((shader) => shader.mark > (record.timings.present ?? 0));
      check(late.length === 0, `${record.bodyId} compiled ${late.length} fragment shaders after present on a repeat visit`);
      check(record.shaders.length <= 1,
        `${record.bodyId} compiled ${record.shaders.length} fragment shaders on a repeat visit, at most its own skin was expected`);
      if (seen.length > 2) {
        const previous = seen[seen.length - 2].timings.programsWhenReady;
        check(record.timings.programsWhenReady === previous,
          `${record.bodyId} holds ${record.timings.programsWhenReady} programs on visit ${seen.length}, ${previous} on the one before`);
      }
    }
    check(pageErrors.length === 0, `page errors: ${pageErrors.slice(0, 3).join(' | ')}`);
  }

  await writeFile(path.join(outDir, 'results.json'), JSON.stringify({
    label, url: baseUrl, phone, coldCache, repeats, entries, bodies, machine,
    table, results, pageErrors, notes, failures,
    takenAt: new Date().toISOString(),
  }, null, 2));
  console.log('');
  for (const note of notes) console.log(`note: ${note}`);
  console.log(`${results.length} opens → ${path.join(outDir, 'results.json')}`);
  if (asserting) console.log(failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`);
} finally {
  await browser?.close();
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
  release();
}

if (asserting && failures.length > 0) process.exit(1);
