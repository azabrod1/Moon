// The smoothness gate: a scripted battery that answers one question per
// scenario — was every frame delivered on time, and when one was not, what was
// happening that frame.
//
//   node tools/smoothness-gate.mjs --label=baseline
//   node tools/smoothness-gate.mjs --scenario=boot,earth-near --json
//   node tools/smoothness-gate.mjs --rescore=/tmp/moon-shots/smooth/baseline
//   node tools/smoothness-gate.mjs --scenario=boot --cold-cache --label=cold
//   node tools/smoothness-gate.mjs --scenario=earth-near --no-precise-memory
//   node tools/smoothness-gate.mjs --list
//
// Needs a dev server (this checkout, `npx vite --port 5656 --strictPort`) and,
// for the sector tiles, a tile host (`node planning/_tiles-serve.mjs` on 5622).
// Runs ONE browser and ONE tab at a time on the real GPU: a second WebGL tab
// steals the GPU process and every number below becomes fiction. That is
// enforced machine-wide, not by convention — this takes /tmp/moon-browser.lock
// and waits for it, as every browser run on this machine does. A concurrent
// battery has already killed one run of this one mid-scenario.
//
// The record comes from the app's own DEV frame trace (smoothnessTrace.ts),
// armed with ?smooth=1 before the first frame so a cold boot is measurable.
// Each frame carries its raf gap, whether the arrival veil was over it, and a
// one-word cause for the heavy events that fired inside it.
//
// VERDICT (per scenario): PASS when, after the loading screen is gone and
// outside the arrival veil's sanctioned cuts, no frame took longer than TWO
// vsyncs at the machine's own refresh rate, p99 is at most 20 ms, and no long
// task ran past 50 ms. The machine's rate is read from the run itself — the
// median gap — so the same rule means the same thing on a 60 Hz display
// (33 ms) and a 120 Hz one (16.7 ms) instead of quietly forgiving two extra
// refreshes on the faster machine. A four-vsync count rides along as the
// severity split, and fixed 33/50 ms columns stay for cross-machine reading.
//
// Frames under the veil are counted and reported separately rather than
// dropped, so a hitch that merely hid behind a cut is still visible.
//
// PHONE = PROFILE + SLOW SILICON. A phone row is a phone viewport, a phone UA
// (the device profile reads it, and a phone profile is a different app) AND a
// 4x CPU throttle, because this machine's cores are not a phone's: unthrottled,
// a phone-shaped run here passes everything while the real device stutters.
// The throttle is what made the tile-upload stall reproducible at all — the
// same flight showed 16 tile-attributed late frames throttled and none without.
//
// One consequence: at 4x the absolute PASS bar is unreachable even with the
// feature under test turned off — the Mars floor leg drops seven frames over
// two vsyncs with sector streaming OFF. So EVERY throttled phone row is a
// PAIR: an `<id>-floor` leg flying the same route with `?sectors=0`, and the
// row itself scored DIFFERENTIALLY against it through `requires` and the
// verify hook. No throttled row carries an absolute verdict, because such a
// row would be red whatever the app did, and a gate that is red by
// construction stops being run — which is worse than no gate at all. What the
// pair asserts instead: no late frame carried a sector-tile upload, and the
// scored leg is no worse than its own floor bar two frames of scatter.
//
// And a limit worth knowing before trusting a phone row: this runs Chromium
// wearing a phone's user agent, and some costs are the ENGINE's, not the
// silicon's. A 2048 sector tile uploaded from an ImageBitmap measured 6-7 ms
// here at 4x throttle and a median 10 ms in Playwright WebKit with no throttle
// at all — so for anything that leans on how a browser hands an image to the
// GPU, a green phone row here is not evidence about Safari. Measure that in
// WebKit (the repo's Safari oracle) before calling such a thing done.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
// Extra query on every page the battery opens. What it exists for: an app
// switch whose cost is the question (?synth=0 takes the close-range surface
// term out), measured by running the same scenarios twice and reading the
// p50/p95 shift between the two runs.
const EXTRA_QUERY = arg('query', '');
const PRINT_JSON = has('json');
const RESCORE = arg('rescore', '');
// Which browser to measure in. The default headless shell is an OLD-headless
// binary with no real display; a real Chrome is the ground truth a person sees.
const ENGINE = arg('engine', 'shell');
// Appended to every scenario's boot URL, after the scenario's own query. The
// A/B seam: a feature switch given here turns the whole battery into the same
// battery with that feature off, which is how a row is shown to be about the
// feature and not about the machine (`--extra='&tilebytes=0'`).
const EXTRA = arg('extra', '');

// --cold-cache: measure a FIRST visit, where every shader program still has to
// be compiled and linked by the driver. Three caches sit between a run and that
// state and all three have to go, or the run measures a boot no user gets:
//   - the browser profile (a fresh --user-data-dir per scenario, so scenario
//     two is as cold as scenario one),
//   - Chrome's own on-disk program cache (--disable-gpu-shader-disk-cache and
//     friends below),
//   - and macOS's Metal library cache, which lives outside the profile, is
//     keyed on the shader SOURCE, and no browser flag clears. That last one is
//     why a "cold" run used to look warm. `?shaderSalt=` (DEV only) appends a
//     no-op #define carrying a per-scenario nonce to every shader, so the
//     source differs from anything the OS has cached and the driver links cold.
const COLD_CACHE = has('cold-cache');
let coldSalt = '';

// Whether the heap column is measured at all (see MEMORY_ARGS below).
const PRECISE_MEMORY = !has('no-precise-memory');

// Fixed thresholds, kept so two machines' runs can be read side by side. The
// verdict does not use them: it uses two of the run's own vsyncs (see analyze).
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
const round1 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : v);

// ---------------------------------------------------------------- page setup

// The recorder stops at the end of its buffer rather than wrapping, so a
// scenario that outruns it loses its TAIL — silently, if nobody looks. Each
// scenario declares the wall seconds it expects and the buffer is sized from
// that with room to spare, at 120 Hz plus a wide margin.
function appUrl(extra = '', expectSeconds = 120) {
  const params = new URLSearchParams();
  params.set('auto', 'planetarium');
  params.set('smooth', '1');
  params.set('smoothFrames', String(Math.ceil(expectSeconds * 130 * 1.5)));
  if (TILES) params.set('tiles', TILES);
  if (COLD_CACHE) params.set('shaderSalt', coldSalt);
  return `${URL_BASE}/?${params.toString()}${extra}${EXTRA_QUERY}${EXTRA}`;
}

async function openPage(browser, device, cpuThrottle = 0) {
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
  if (cpuThrottle > 1) {
    // The renderer's own main thread, slowed by the protocol — the only way
    // this machine can stand in for phone silicon.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle });
    notes.push(`CPU throttled ${cpuThrottle}x`);
  }
  page.on('pageerror', (e) => notes.push(`pageerror: ${String(e).slice(0, 200)}`));
  page.on('crash', () => notes.push('the renderer process CRASHED'));
  page.on('console', (m) => {
    if (m.type() === 'error') notes.push(`console: ${m.text().slice(0, 200)}`);
  });
  return { context, page, notes };
}

async function bootTo(page, extra = '', expectSeconds = 120) {
  await page.goto(appUrl(extra, expectSeconds), { waitUntil: 'domcontentloaded' });
  // In-page again, and one round trip: the boot scenario's scored window opens
  // the instant the loading screen goes, so a per-frame CDP poll waiting for
  // exactly that would be polling across the frames it is about to score.
  await page.evaluate(async (timeoutMs) => {
    const nap = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
    const deadline = performance.now() + timeoutMs;
    const revealed = () => {
      const screen = document.getElementById('loading-screen');
      return !!window.__moon?.ready?.() && (!screen || screen.classList.contains('hidden'));
    };
    while (performance.now() < deadline && !revealed()) await nap(100);
  }, 120_000);
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

/** Travel through the real pick pipeline and wait out the veil and the park. */
async function travelAndSettle(page, name, settleMs = 4_000) {
  await mark(page, `travel:${name}`);
  const ok = await page.evaluate((n) => window.__moon.travelTo(n), name);
  if (!ok) return `travelTo(${name}) refused`;
  // ONE round trip: the waiting happens inside the page. waitForFunction's
  // default polling injects its predicate and runs it on every animation
  // frame, so a harness that waits that way is adding app work to the frames
  // it is about to score — a gate must not measure its own instrumentation.
  const settled = await page.evaluate(async ({ n, timeoutMs, tailMs, parkRadii, parkClosing, departRatio }) => {
    const nap = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
    const radiiNow = () => {
      const p = window.__moon.probe(n);
      return p && p.found && p.radiusAU ? p.distToBodyAU / p.radiusAU : null;
    };
    // The flight needs a beat to start, or a stationary read is "has not left
    // yet" rather than "arrived".
    await nap(2_500);
    const deadline = performance.now() + timeoutMs;
    // Two ways to arrive, because the app has two. A body the ship parks at
    // goes still nearby. Every moon is now flown PAST — one camera boom, no
    // park — so its arrival is a closest approach that has been made and left
    // behind, and a signal that waits for stillness there waits for something
    // that is never coming: the range grows without limit and the run reports
    // an absurd "closing" speed for a pass that went exactly to plan.
    let still = 0;
    let departing = 0;
    let minRadii = Infinity;
    let closingPerS = null;
    while (performance.now() < deadline) {
      const before = radiiNow();
      const atMs = performance.now();
      await nap(200);
      const after = radiiNow();
      if (before === null || after === null) continue;
      minRadii = Math.min(minRadii, after);
      closingPerS = (before - after) / ((performance.now() - atMs) / 1000);
      still = (after <= parkRadii && Math.abs(closingPerS) <= parkClosing) ? still + 1 : 0;
      if (still >= 3) {
        await nap(tailMs);
        return { outcome: 'parked', radii: radiiNow(), minRadii, closingPerS };
      }
      // Receding, from a closest approach that actually happened.
      departing = (minRadii <= parkRadii && after > minRadii * departRatio) ? departing + 1 : 0;
      if (departing >= 3) {
        await nap(tailMs);
        return { outcome: 'flyby', radii: radiiNow(), minRadii, closingPerS };
      }
    }
    return { outcome: 'timeout', radii: radiiNow(), minRadii, closingPerS };
  }, {
    n: name,
    timeoutMs: 120_000,
    tailMs: settleMs,
    // Generous in distance, because arrivals deliberately stand off and a
    // moonlet's radius is tiny; strict about stillness, which is the half the
    // old player.moving signal got wrong.
    parkRadii: 400,
    parkClosing: 0.5,
    // Far enough past closest approach that drift cannot read as departure.
    departRatio: 1.25,
  });
  // Always report which of the two arrivals happened. "It arrived" is not the
  // useful fact when one body parks and the next is flown past — a leg that
  // silently changed class is exactly what the old signal hid.
  if (settled.outcome !== 'timeout') {
    return `${name}: ${settled.outcome} — ${round1(settled.radii)} radii out,`
      + ` closest ${round1(settled.minRadii)}`;
  }
  // A timeout is where the pose record earns its keep: it says what the
  // arrival MEANT to do, which is the difference between a bad signal and a
  // pass that never happened.
  const pose = await page.evaluate(() => ({
    pose: window.__moon.arrivalPose(),
    governor: window.__moon.governorOwner(),
  }));
  return `${name}: never settled — ${settled.radii} radii out, closest ${settled.minRadii},`
    + ` pose ${JSON.stringify(pose.pose)}, governor ${JSON.stringify(pose.governor)}`;
}

/**
 * Pose the ship a given number of body radii out.
 *
 * `jumpTo`'s multiplier scales the standard standoff, and what that comes to
 * in radii is the body's business — the figure that used to be written here by
 * hand (0.13) put the camera at 1.04 radii, INSIDE the descent target, so
 * every "governed descent" below exited on its first check and the legs named
 * for a descent never flew one. One calibration jump reads the standoff, and
 * the multiplier follows from it: view distance scales linearly in it.
 */
async function jumpToRadii(page, name, targetRadii) {
  return page.evaluate(async ({ n, target }) => {
    const nap = (ms) => new Promise((r) => { setTimeout(r, ms); });
    const radii = () => {
      const p = window.__moon.probe(n);
      return p && p.found && p.radiusAU ? p.distToBodyAU / p.radiusAU : null;
    };
    window.__moon.jumpTo(n, 1);
    await nap(150);
    const base = radii();
    if (base === null) return null;
    window.__moon.jumpTo(n, target / base);
    await nap(150);
    return radii();
  }, { n: name, target: targetRadii });
}

/** Hold a key for a while, letting the app's own governor decide the motion. */
async function holdKey(page, key, ms) {
  await page.keyboard.down(key);
  await sleep(ms);
  await page.keyboard.up(key);
}

/** Throttle toward the body until it fills the target radii, or time runs out. */
async function descendTo(page, name, targetRadii, budgetMs = 25_000) {
  await page.keyboard.down('w');
  try {
    // Again one round trip: two key events bracket the descent and the watch
    // between them runs in-page, so the only traffic across a scored window is
    // the input a pilot would really generate.
    return await page.evaluate(async ({ n, target, timeoutMs }) => {
      const nap = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
      const radiiNow = () => {
        const p = window.__moon.probe(n);
        return p && p.found && p.radiusAU ? p.distToBodyAU / p.radiusAU : null;
      };
      const deadline = performance.now() + timeoutMs;
      while (performance.now() < deadline) {
        const radii = radiiNow();
        if (radii !== null && radii <= target) break;
        await nap(250);
      }
      return radiiNow();
    }, { n: name, target: targetRadii, timeoutMs: budgetMs });
  } finally {
    await page.keyboard.up('w');
  }
}

/**
 * Hold the throttle toward a body until it fills the target radii.
 *
 * The same key a pilot holds, and the same governor: an approach flown this
 * way streams its sector tiles WHILE the camera watches, which a veiled
 * travelTo never does — the veil covers exactly the frames the tiles land on.
 */
async function flyIn(page, name, targetRadii, budgetMs = 120_000) {
  await page.keyboard.down('w');
  try {
    return await page.evaluate(async ({ n, target, timeoutMs }) => {
      const nap = (ms) => new Promise((r) => { setTimeout(r, ms); });
      const radii = () => {
        const p = window.__moon.probe(n);
        return p && p.found && p.radiusAU ? p.distToBodyAU / p.radiusAU : null;
      };
      const deadline = performance.now() + timeoutMs;
      while (performance.now() < deadline) {
        const at = radii();
        if (at !== null && at <= target) break;
        await nap(250);
      }
      return radii();
    }, { n: name, target: targetRadii, timeoutMs: budgetMs });
  } finally {
    await page.keyboard.up('w');
  }
}

/** The flown Mars approach, with and without the tiles. Both legs are the same
 *  flight so the pair can be read as one differential. */
function marsFlown(id, title, extra) {
  return {
    id,
    title,
    device: PHONE,
    cpuThrottle: 4,
    // The tiles stream between these two marks. Everything before 'cruise' is
    // the boot, the reveal and the pose — frames both legs pay identically and
    // neither owns — so a differential judgement is taken over the approach.
    window: ['cruise', 'coast'],
    async run(page, note) {
      note(`renderer: ${await bootTo(page, extra, 300)}`);
      note(`device: ${JSON.stringify(await page.evaluate(() => window.__moon.device()))}`);
      await sleep(3_000);
      await mark(page, 'pose');
      note(`posed at ${await jumpToRadii(page, 'Mars', 300)} radii`);
      await sleep(2_000);
      await mark(page, 'cruise');
      note(`cruise ended at ${await flyIn(page, 'Mars', 1.8)} radii`);
      await mark(page, 'coast');
      await sleep(15_000);
      note(`sectors: ${JSON.stringify(await page.evaluate(() => window.__moon.sectors()))}`);
    },
  };
}

/**
 * A throttled phone row, and the reference leg it is scored against.
 *
 * A phone row is a phone viewport, a phone UA and a 4x CPU throttle, and at 4x
 * the absolute bar is out of reach even with sector streaming off — the Mars
 * floor run drops seven frames over two vsyncs with `?sectors=0`. An absolute
 * verdict on such a row is red whatever the app does, and a gate that is red
 * by construction stops being run, which is worse than no gate. So each of
 * these ships as a PAIR: the same flight with `?sectors=0` is the floor this
 * silicon can reach at all, and the row itself is judged against that floor
 * rather than against a number no phone row can meet.
 *
 * `fly` takes the boot query, so the two legs differ in exactly one thing.
 */
function phonePair(id, what, fly) {
  const shared = (extra) => ({
    device: PHONE,
    cpuThrottle: 4,
    // The tiles stream from the descent onward. Everything before it — the
    // boot, the cruise, the pose — is work both legs pay identically, and
    // letting it into a comparison of two separate runs swamps the difference
    // the pair exists to show.
    window: ['descent'],
    async run(page, note) {
      await fly(page, note, extra);
    },
  });
  return [
    {
      ...shared('&sectors=0'),
      id: `${id}-floor`,
      title: `Phone (4x CPU): ${what} with ?sectors=0 — the reference floor`,
      verify(analysis) {
        const problems = [];
        if (analysis.tileMaterializations > 0) {
          problems.push(`?sectors=0 still materialised ${analysis.tileMaterializations} tile(s)`);
        }
        if (!analysis.window || analysis.window.frames < 500) {
          problems.push(`the scored leg holds ${analysis.window?.frames ?? 0} frames`
            + ' — nothing for the row below to compare against');
        }
        return problems;
      },
    },
    {
      ...shared(''),
      id,
      title: `Phone (430x932 @3, 4x CPU): ${what}`,
      requires: `${id}-floor`,
      verify(analysis, trace, done) {
        const floor = done.find((r) => r.scenario === `${id}-floor`);
        if (!floor) return [`no ${id}-floor result to compare against — run it in the same battery`];
        const problems = [];
        if (analysis.tileMaterializations < 4) {
          problems.push(`only ${analysis.tileMaterializations} tile(s) streamed — the leg did not`
            + ' exercise what it exists to measure');
        }
        if (analysis.lateWithTileUpload > 0) {
          problems.push(`${analysis.lateWithTileUpload} late frame(s) carried a sector-tile upload`);
        }
        // A margin of two frames: the floor is a separate run of a moving
        // scene, not a replay, and an exact count would fail on its scatter.
        if (analysis.windowOver2x > floor.windowOver2x + 2) {
          problems.push(`${analysis.windowOver2x} frame(s) over two vsyncs on the scored leg,`
            + ` against the sectors-off floor's ${floor.windowOver2x}`);
        }
        return problems;
      },
    },
  ];
}

/** Travel to Earth, fly down from 8 radii, hover. */
async function flyEarthNear(page, note, extra) {
  await bootTo(page, extra, 230);
  await sleep(2_000);
  note(`device: ${JSON.stringify(await page.evaluate(() => window.__moon.device()))}`);
  note(await travelAndSettle(page, 'Earth'));
  note(`posed at ${await jumpToRadii(page, 'Earth', 8)} radii`);
  await sleep(2_500);
  await mark(page, 'descent');
  note(`descent ended at ${await descendTo(page, 'Earth', 1.6, 60_000)} radii`);
  await mark(page, 'hover');
  await sleep(20_000);
}

/** The same descent, then a slow yaw across the day/night terminator. */
async function flyTerminator(page, note, extra) {
  await bootTo(page, extra, 280);
  await sleep(2_000);
  note(await travelAndSettle(page, 'Earth'));
  note(`posed at ${await jumpToRadii(page, 'Earth', 8)} radii`);
  await sleep(2_500);
  await mark(page, 'descent');
  note(`pan altitude ${await descendTo(page, 'Earth', 1.4, 60_000)} radii`);
  await sleep(3_000);
  await mark(page, 'pan');
  for (let i = 0; i < 14; i++) {
    await holdKey(page, 'a', 250);
    await sleep(1_000);
  }
  await sleep(3_000);
}

// ----------------------------------------------------------------- scenarios

const SCENARIOS = [
  {
    // Proves the instrument before anyone trusts a number from it. Two known
    // main-thread blocks are injected after the reveal; the trace must show
    // them. A gate that cannot see a 60 ms stall it caused itself cannot be
    // believed when it reports none. Not part of the battery — ask for it.
    id: 'selftest',
    title: 'Instrument check: inject known main-thread blocks and see them',
    device: DESKTOP,
    selfTestOnly: true,
    async run(page, note) {
      note(`renderer: ${await bootTo(page, '', 60)}`);
      await sleep(2_000);
      await mark(page, 'selftest');
      const blocks = await page.evaluate(async () => {
        const seen = [];
        const blockOnce = (ms) => new Promise((resolve) => {
          requestAnimationFrame(() => {
            const until = performance.now() + ms;
            while (performance.now() < until) { /* hold the main thread */ }
            seen.push(ms);
            resolve();
          });
        });
        for (const ms of [30, 60, 120]) {
          await blockOnce(ms);
          await new Promise((r) => setTimeout(r, 600));
        }
        return seen;
      });
      note(`injected blocks: ${blocks.join(', ')} ms`);
    },
    // The trace has to show a gap at least as long as each block it was given.
    verify(analysis, trace) {
      const problems = [];
      const after = trace.gapMs
        .map((gap, i) => ({ gap, i }))
        .filter((g) => g.gap !== null && g.i >= analysis.revealFrame)
        .map((g) => g.gap);
      for (const ms of [30, 60, 120]) {
        // Allow a little slack under the injected figure for timer resolution;
        // anything materially below it means the recorder is not seeing stalls.
        if (!after.some((gap) => gap >= ms * 0.9)) {
          problems.push(`no frame gap near the injected ${ms} ms block —`
            + ` the recorder cannot see main-thread stalls`);
        }
      }
      if (analysis.over2x < 3) {
        problems.push(`only ${analysis.over2x} frame(s) over two vsyncs;`
          + ' three injected blocks should each produce one');
      }
      // The blocks run inside a rAF callback, so their cost lands on the NEXT
      // frame. The worst frames must therefore be attributed, not bare.
      return problems;
    },
  },
  {
    id: 'boot',
    title: 'Cold boot → first frame → the idle warm settling',
    device: DESKTOP,
    async run(page, note) {
      note(`renderer: ${await bootTo(page, '', 30)}`);
      // No mark here. The reveal already marks this boundary, and a second
      // one lands a protocol round trip on the frames right after the reveal —
      // which is the very window this scenario exists to score. Measured: it
      // cost a 16.7 ms frame and failed the run on its own.
      await sleep(15_000);
    },
  },
  {
    // Artefact hunt, cut to the scene that actually failed: a long cruise at
    // 60x, mid-flight, 40-160 s after the travel began — where tour-60x's
    // Uranus leg put 161 of its 187 over-budget frames. The two differ in one
    // thing only: whether the harness talks to the page across the scored
    // window. If the once-per-second beat shows up with NOTHING crossing the
    // wire, it is the engine; if only under polling, it is the measurement.
    id: 'uranus-quiet',
    title: 'Artefact probe: 120 s mid-cruise to Uranus at 60x, no protocol traffic',
    device: DESKTOP,
    selfTestOnly: true,
    async run(page, note) {
      note(`renderer: ${await bootTo(page, '', 200)}`);
      await sleep(2_000);
      await page.evaluate(() => { window.__moon.setTimeRate(60); window.__moon.travelTo('Uranus'); });
      await sleep(40_000);
      await mark(page, 'window');
      await sleep(120_000);
    },
  },
  {
    id: 'uranus-polled',
    title: 'Artefact probe: the same cruise, with waitForFunction polling on raf',
    device: DESKTOP,
    selfTestOnly: true,
    async run(page, note) {
      note(`renderer: ${await bootTo(page, '', 200)}`);
      await sleep(2_000);
      await page.evaluate(() => { window.__moon.setTimeRate(60); window.__moon.travelTo('Uranus'); });
      await sleep(40_000);
      await mark(page, 'window');
      // The predicate the baseline harness actually used. devProbe is not a
      // cheap read: it refreshes world matrices, projects to screen, walks the
      // moon map and reads label style off the DOM. waitForFunction's default
      // polling runs that IN THE PAGE on every animation frame, so the harness
      // was adding app work to the frames it was scoring.
      await page.waitForFunction(
        (n) => { const p = window.__moon.probe(n); return !!p && p.moving === false; },
        'Uranus',
        { timeout: 120_000 },
      ).catch(() => {});
    },
  },
  {
    id: 'earth-near',
    title: 'travelTo Earth → arrival → governed descent to the near band → 20 s hover',
    device: DESKTOP,
    async run(page, note) {
      await bootTo(page, '', 190);
      await sleep(2_000);
      note(await travelAndSettle(page, 'Earth'));
      await mark(page, 'near-band');
      note(`posed at ${await jumpToRadii(page, 'Earth', 8)} radii`);
      await sleep(2_500);
      await mark(page, 'descent');
      const at = await descendTo(page, 'Earth', 1.6, 40_000);
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
      await bootTo(page, '', 230);
      await sleep(2_000);
      note(await travelAndSettle(page, 'Earth'));
      note(`posed at ${await jumpToRadii(page, 'Earth', 8)} radii`);
      await sleep(2_500);
      await mark(page, 'descent');
      const at = await descendTo(page, 'Earth', 1.4, 40_000);
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
      await bootTo(page, '', 560);
      await sleep(2_000);
      for (const body of ['Earth', 'Moon', 'Mars', 'Earth']) {
        note(await travelAndSettle(page, body, 6_000));
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
      await bootTo(page, '&envelope=200', 510);
      await sleep(2_000);
      note(await travelAndSettle(page, 'Earth'));
      note(`posed at ${await jumpToRadii(page, 'Earth', 8)} radii`);
      await sleep(2_500);
      await mark(page, 'descent');
      note(`descent ended at ${await descendTo(page, 'Earth', 1.6, 40_000)} radii`);
      await mark(page, 'squeeze-hover');
      await sleep(20_000);
      note(`ladder: ${JSON.stringify(await page.evaluate(() => window.__moon.ladder()))}`);
      note(`sectors: ${JSON.stringify(await page.evaluate(() => window.__moon.sectors()))}`);
      // A hop away and back is what forces the release to be paid back.
      note(await travelAndSettle(page, 'Mars', 6_000));
      note(await travelAndSettle(page, 'Earth', 10_000));
    },
  },
  {
    id: 'moonlets',
    title: 'Tiny-moon flybys: Mars, then Phobos and Deimos',
    device: DESKTOP,
    async run(page, note) {
      await bootTo(page, '', 220);
      await sleep(2_000);
      // Mars first. A moonlet reached from wherever the boot leaves the ship
      // is a multi-minute cruise that arrives inside no sane timeout, and the
      // run then measures that cruise instead of the flyby it is named for.
      for (const body of ['Mars', 'Phobos', 'Deimos']) {
        note(await travelAndSettle(page, body, 8_000));
      }
    },
  },
  {
    // The pose a per-fragment surface term costs the most in: one body across
    // the whole frame with its colour map magnified past a texel a pixel over
    // every pixel of it, so nothing is being paid for at a fraction of the
    // screen. The camera is POSED rather than flown, for two reasons that both
    // matter: forward thrust after a moon arrival is not aimed at the moon
    // (a scenario that throttles in flies away for half a minute and scores a
    // cruise), and the pose stands for a device whose ladder cannot reach the
    // top rung, where a body this size on screen really is this coarse.
    //
    // Held still, with nothing streaming once it settles, so there is no event
    // to blame a heavy frame on: the score to read here is the p50 and p95
    // shift, not a count of frames over budget.
    id: 'moon-close',
    title: 'Moon across the whole frame, magnified past a texel a pixel: 30 s hold',
    device: DESKTOP,
    async run(page, note) {
      await bootTo(page, '', 240);
      await sleep(2_000);
      note(await travelAndSettle(page, 'Moon', 8_000));
      await page.evaluate(() => window.__moon.frame('Moon', 2.2));
      // Long enough for the tiles this pose wants to arrive and stop arriving.
      await sleep(12_000);
      // The magnification the run really achieved, so the score is read
      // against a measured density rather than an assumed one.
      note(`density: ${JSON.stringify(await page.evaluate(() => window.__moon.surfaceDensity()))}`);
      await mark(page, 'hold');
      await sleep(30_000);
    },
  },
  {
    // The same pose on a body that draws SYNTHESIZED RELIEF, which the Moon
    // never does: the Moon wears measured elevation, so a close hold on it
    // prices the grain and nothing else. Titania wears a painted crater bump
    // that has run out of texels at this magnification, which is the one case
    // where the term perturbs the normal too — the whole cost, on the frame
    // that pays all of it.
    id: 'titania-close',
    title: 'Titania across the whole frame, synthesized relief on: 30 s hold',
    device: DESKTOP,
    async run(page, note) {
      await bootTo(page, '', 240);
      await sleep(2_000);
      note(await travelAndSettle(page, 'Titania', 8_000));
      await page.evaluate(() => window.__moon.frame('Titania', 0.81));
      await sleep(12_000);
      note(`density: ${JSON.stringify(await page.evaluate(() => window.__moon.surfaceDensity()))}`);
      await mark(page, 'hold');
      await sleep(30_000);
    },
  },
  {
    // The close-range term's worst fill-rate case, on the device shape with the
    // least fill rate to spare. Its field is drawn on three flat charts, one
    // per axis of the body's frame, and a fragment on a body-frame DIAGONAL is
    // drawn by all three — six texture fetches where a fragment over a chart's
    // own axis takes two. That case is a place on the body, not a distance, so
    // it has to be aimed at: the roll about the Sun line is swept and the pose
    // with the three components most nearly equal is the one held.
    id: 'phone-titania-corner',
    title: 'Phone: Titania across the frame on a chart corner, relief on: 30 s hold',
    device: PHONE,
    async run(page, note) {
      await bootTo(page, '', 240);
      await sleep(2_000);
      note(`device: ${JSON.stringify(await page.evaluate(() => window.__moon.device()))}`);
      note(await travelAndSettle(page, 'Titania', 8_000));
      const aimed = await page.evaluate(async ({ name, fill, phase }) => {
        const nap = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
        const dirOf = () => {
          const d = (window.__moon.surfaceDensity() ?? []).find((x) => x.name === name);
          return d && d.subCameraBodyDir ? d.subCameraBodyDir : null;
        };
        let best = { roll: 0, score: -1, dir: null };
        for (let roll = 0; roll < 360; roll += 15) {
          window.__moon.frame(name, fill, phase, undefined, 0, 0, roll);
          await nap(150);
          const dir = dirOf();
          if (!dir) continue;
          // Equal in all three is the corner; the smallest component says how
          // close a pose got, and 0.577 is the corner itself.
          const score = Math.min(Math.abs(dir[0]), Math.abs(dir[1]), Math.abs(dir[2]));
          if (score > best.score) best = { roll, score, dir };
        }
        window.__moon.frame(name, fill, phase, undefined, 0, 0, best.roll);
        return best;
      }, { name: 'Titania', fill: 0.81, phase: 40 });
      note(`corner pose: roll ${aimed.roll}°, body direction ${JSON.stringify(aimed.dir)},`
        + ` smallest component ${round1(aimed.score * 100) / 100} of 0.58`);
      await sleep(12_000);
      note(`density: ${JSON.stringify(await page.evaluate(() => window.__moon.surfaceDensity()))}`);
      await mark(page, 'hold');
      await sleep(30_000);
    },
  },
  {
    id: 'tour-60x',
    title: 'Planet tour at 60× time rate',
    device: DESKTOP,
    async run(page, note) {
      await bootTo(page, '', 900);
      await sleep(2_000);
      await page.evaluate(() => window.__moon.setTimeRate(60));
      for (const body of ['Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune']) {
        note(await travelAndSettle(page, body, 4_000));
      }
      await page.evaluate(() => window.__moon.setTimeRate(1));
    },
  },
  ...phonePair(
    'phone-earth-near',
    'travel to Earth, governed descent from 8 radii, 20 s hover',
    flyEarthNear,
  ),
  ...phonePair(
    'phone-terminator',
    'slow pan across the terminator in the near band',
    flyTerminator,
  ),
  {
    // The reference leg. Same flight, sector streaming off: this is the floor
    // the throttled phone can reach at all, and it is not a PASS — at 4x even
    // a bare cruise drops frames. Scored only for the figures the leg below
    // is judged against.
    ...marsFlown(
      'mars-flown-floor',
      'Phone (4× CPU): flown approach to Mars with ?sectors=0 — the reference floor',
      '&sectors=0',
    ),
    verify(analysis) {
      const problems = [];
      if (analysis.tileMaterializations > 0) {
        problems.push(`?sectors=0 still materialised ${analysis.tileMaterializations} tile(s)`);
      }
      if (analysis.scoredFrames < 5_000) {
        problems.push(`only ${analysis.scoredFrames} frames scored — the flight did not happen`);
      }
      // The leg the run below is compared against has to exist, or the
      // comparison is against nothing.
      if (!analysis.window || analysis.window.frames < 1_000) {
        problems.push(`the approach window holds ${analysis.window?.frames ?? 0} frames`
          + ' — nothing to compare against');
      }
      return problems;
    },
  },
  {
    ...marsFlown(
      'mars-flown',
      'Phone (4× CPU): flown approach to Mars, tiles streaming under the eye',
      '',
    ),
    requires: 'mars-flown-floor',
    // DIFFERENTIAL, not the absolute rule. At 4x the reference above fails the
    // absolute bar on its own, so the only honest question is what the TILES
    // cost on top of it: no late frame may carry a tile upload, and the run's
    // late-frame count must not sit above the floor's.
    verify(analysis, trace, done) {
      const floor = done.find((r) => r.scenario === 'mars-flown-floor');
      const problems = [];
      if (!floor) {
        return ['no mars-flown-floor result to compare against — run it in the same battery'];
      }
      if (analysis.tileMaterializations < 10) {
        problems.push(`only ${analysis.tileMaterializations} tiles streamed — the leg did not`
          + ' exercise what it exists to measure');
      }
      if (analysis.lateWithTileUpload > 0) {
        problems.push(`${analysis.lateWithTileUpload} late frame(s) carried a sector-tile upload`);
      }
      // Counted over the approach, where the tiles are: the boot and reveal
      // frames before it are the same work in both legs and swamp the
      // difference this is asking about. A margin of two frames on top,
      // because the floor is a separate run of a moving scene, not a replay,
      // and an exact count would fail on the reference's own scatter.
      if (analysis.windowOver2x > floor.windowOver2x + 2) {
        problems.push(`${analysis.windowOver2x} frame(s) over two vsyncs during the approach,`
          + ` against the sectors-off floor's ${floor.windowOver2x}`);
      }
      return problems;
    },
  },
  {
    // The same flight with every tile uploaded as one indivisible bitmap —
    // the shape that shipped before the banded byte path. Ask for it by name
    // to see the stall the pair above exists to prove gone; it is not part of
    // the battery because it is MEANT to fail.
    ...marsFlown(
      'mars-flown-bitmap',
      'Phone (4× CPU): the flown Mars approach with ?tilebytes=0 — the one-shot arm',
      '&tilebytes=0',
    ),
    selfTestOnly: true,
  },
];

// ------------------------------------------------------------------ analysis

// The same list as smoothnessTrace's SMOOTH_CAUSES, in the same order: the
// trace stores a bitmask, so a name inserted anywhere but the end would
// re-read every stored trace's causes as something else.
const CAUSES = ['veil', 'tile', 'release', 'rung', 'upload', 'mark', 'warm'];
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
  const worstFirst = scored.slice().sort((a, b) => b.gap - a.gap);
  // A frame's gap is raf(N) − raf(N−1), so the work that made it late ran
  // DURING frame N−1. Attribute the blame there; frame N is the one that
  // arrived late, not the one that spent the time.
  const eventsOf = (i) => (eventsByFrame.get(i) ?? []).map((e) => ({
    kind: e.kind,
    name: e.name,
    durationMs: e.durationMs,
  }));
  const worst = worstFirst.slice(0, 10).map(({ i, gap }) => ({
    frame: i,
    atMs: atMs[i],
    gapMs: round2(gap),
    causes: causeNames(causeMask[Math.max(0, i - 1)] | causeMask[i]).filter((c) => c !== 'veil'),
    blamedOn: Math.max(0, i - 1),
    events: [...eventsOf(Math.max(0, i - 1)), ...eventsOf(i)],
  }));

  const tasksAfterReveal = longTasks.filter((t) => t.atMs >= revealAtMs);
  // The veil is the app's sanctioned cut; a task inside one is covered work,
  // not a stutter. Both counts are reported so nothing is hidden by the split.
  const frameAtMs = (i) => atMs[i];
  const veilSpans = windows.map(([a, b]) => [frameAtMs(a), frameAtMs(b)]);
  const inVeilTime = (t) => veilSpans.some(([a, b]) => t >= a && t <= b);
  const tasksOutside = tasksAfterReveal.filter((t) => !inVeilTime(t.atMs));

  // A sector tile's texture is named for its file, and a tile file is
  // <column>_<row>.webp — nothing else the app streams is. The trace stamps
  // that name plus the size, banded or whole, so this matches a tile upload
  // however it was paid.
  //
  // The name alone is not enough: a sector's relief and roughness CROPS are
  // cut on the same grid and carry the same <c>_<r>.webp name at a few hundred
  // pixels square, and they upload in well under a millisecond. Blaming a late
  // frame on one of those would count a cost nothing could have felt. So a
  // tile is a big image, or an upload that actually took a millisecond —
  // either is a cost worth attributing, and a crop is neither.
  const TILE_MIN_TEXELS = 1024 * 1024;
  const TILE_MIN_MS = 1;
  const uploadTexels = (name) => {
    const size = /\s(\d+)x(\d+)$/.exec(name ?? '');
    return size ? Number(size[1]) * Number(size[2]) : 0;
  };
  const isTileUpload = (e) => e.kind === 'upload'
    && /^\d+_\d+\.webp /.test(e.name ?? '')
    && (uploadTexels(e.name) >= TILE_MIN_TEXELS || (e.durationMs ?? 0) >= TILE_MIN_MS);

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

  // A scenario may name the leg it is really about — `window: ['cruise',
  // 'coast']` — and the counts inside it are reported beside the whole-run
  // ones. The verdict still comes from the whole run: a hitch at the reveal
  // is a real hitch. But a DIFFERENTIAL judgement compares two separate runs
  // of a moving scene, and letting reveal and pose frames into that comparison
  // swamps the difference the legs exist to show with noise neither leg owns.
  const markAt = (name) => events.find((e) => e.kind === 'mark' && e.name === name)?.frame ?? null;
  // A window given one mark runs from it to the end of the run; two marks
  // bound it at both ends.
  const windowFrom = scenario.window ? markAt(scenario.window[0]) : null;
  const windowTo = scenario.window?.[1] ? markAt(scenario.window[1]) : null;
  const inScoreWindow = ({ i }) => (windowFrom === null || i >= windowFrom)
    && (windowTo === null || i <= windowTo);

  const maxMs = round2(sorted.at(-1) ?? 0);
  const p99 = round2(percentile(sorted, 0.99));
  // The machine's own refresh, read from the run: on an unloaded run the
  // median gap IS one vsync. A run whose median has itself drifted to two
  // refreshes would relax its own budget, so p50 is reported beside every
  // verdict — a p50 that is not near a plausible refresh invalidates the run,
  // not the rule.
  const vsyncMs = round2(percentile(sorted, 0.5));
  const twoVsyncMs = round2(vsyncMs * 2);
  const fourVsyncMs = round2(vsyncMs * 4);
  const over2x = scored.filter((s) => s.gap > twoVsyncMs).length;
  const lateWithTileUpload = scored.filter(({ i, gap }) => gap > twoVsyncMs
    && [...eventsOf(Math.max(0, i - 1)), ...eventsOf(i)].some(isTileUpload)).length;
  const over4x = scored.filter((s) => s.gap > fourVsyncMs).length;
  const windowed = scenario.window ? scored.filter(inScoreWindow) : [];
  const windowOver2x = windowed.filter((s) => s.gap > twoVsyncMs).length;
  const windowOver4x = windowed.filter((s) => s.gap > fourVsyncMs).length;
  const windowLateWithTileUpload = windowed.filter(({ i, gap }) => gap > twoVsyncMs
    && [...eventsOf(Math.max(0, i - 1)), ...eventsOf(i)].some(isTileUpload)).length;
  const maxTaskMs = tasksOutside.reduce((m, t) => Math.max(m, t.durationMs), 0);
  const failures = [];
  if (maxMs > twoVsyncMs) {
    failures.push(`${over2x} frame(s) over two vsyncs (${twoVsyncMs} ms) outside veils,`
      + ` ${over4x} of them over four (${fourVsyncMs} ms), worst ${maxMs} ms`);
  }
  if (p99 > P99_BUDGET_MS) failures.push(`p99 ${p99} ms over the ${P99_BUDGET_MS} ms budget`);
  if (maxTaskMs > LONG_TASK_MS) {
    failures.push(`${tasksOutside.filter((t) => t.durationMs > LONG_TASK_MS).length} long task(s)`
      + ` over ${LONG_TASK_MS} ms after reveal, worst ${round2(maxTaskMs)} ms`);
  }

  // Frames the buffer could not hold are unmeasured, not clean: a PASS over a
  // run whose tail was never recorded would be a claim about seconds nobody
  // looked at.
  if (trace.dropped > 0) {
    const lastAtMs = atMs.at(-1) ?? 0;
    failures.push(`${trace.dropped} frame(s) past the buffer went unrecorded —`
      + ` nothing after ${round2(lastAtMs / 1000)} s was scored`);
  }
  const verdict = trace.dropped > 0 ? 'INCOMPLETE' : (failures.length ? 'FAIL' : 'PASS');

  return {
    scenario: scenario.id,
    title: scenario.title,
    verdict,
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
    p50Ms: vsyncMs,
    vsyncMs,
    twoVsyncMs,
    fourVsyncMs,
    over2x,
    over4x,
    /** The leg the scenario named, when it named one: the frames a
     *  differential verdict is taken over, and how many of them were late. */
    window: scenario.window
      ? { marks: scenario.window, fromFrame: windowFrom, toFrame: windowTo, frames: windowed.length }
      : null,
    windowOver2x,
    windowOver4x,
    windowLateWithTileUpload,
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
    /** Late frames (over two vsyncs, outside the veil) that carried a sector
     *  tile's upload — the column the tile work is judged by. */
    lateWithTileUpload,
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

// --------------------------------------------------------------------- lock

// One browser run at a time, machine-wide. mkdir is the atomic claim; the pid
// inside is what lets a crashed run's lock be reclaimed rather than blocking
// the machine until someone notices.
const LOCK_DIR = '/tmp/moon-browser.lock';

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
        process.stdout.write(`[gate] clearing a stale lock (pid ${holder.pid} is gone)\n`);
        rmSync(LOCK_DIR, { recursive: true, force: true });
        continue;
      }
      if (!announced) {
        process.stdout.write(`[gate] another browser run holds ${LOCK_DIR}`
          + `${holder.pid ? ` (pid ${holder.pid})` : ''} — waiting for it\n`);
        announced = true;
      }
      await sleep(10_000);
    }
  }
  writeFileSync(join(LOCK_DIR, 'pid'), String(process.pid));
  if (announced) process.stdout.write('[gate] lock acquired\n');
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

// ------------------------------------------------------------------ printing

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

function printTable(results, label) {
  console.log(`\n=== smoothness gate: ${label} ===`);
  console.log([
    pad('scenario', 18), num('frames', 7), num('p50', 6), num('mean', 6), num('p95', 6),
    num('p99', 6), num('max', 8), num('>2x', 5), num('>4x', 5), num('>33', 5), num('>50', 5),
    num('tasks', 6), num('up>8', 6), num('tile!', 6), num('leg>2x', 7), '  verdict',
  ].join(''));
  for (const r of results) {
    console.log([
      pad(r.scenario, 18), num(r.scoredFrames ?? '-', 7), num(r.p50Ms ?? '-', 6),
      num(r.meanMs ?? '-', 6), num(r.p95Ms ?? '-', 6), num(r.p99Ms ?? '-', 6),
      num(r.maxMs ?? '-', 8), num(r.over2x ?? '-', 5), num(r.over4x ?? '-', 5),
      num(r.over33 ?? '-', 5), num(r.over50 ?? '-', 5),
      num(r.longTasksOutsideVeils ?? '-', 6), num(r.uploadsOverBudget ?? '-', 6),
      num(r.lateWithTileUpload ?? '-', 6),
      // The named leg's own late count, for the rows judged differentially:
      // a dash where the scenario named no leg and the whole run IS the leg.
      num(r.window ? r.windowOver2x : '-', 7),
      '  ', r.verdict,
    ].join(''));
    for (const f of r.failures ?? []) console.log(`${' '.repeat(18)}- ${f}`);
  }
}

// ---------------------------------------------------------------------- main

// Re-score stored traces under the current rule. A gate's thresholds move; the
// runs behind them are expensive, so a rule change must not cost a re-run.
if (RESCORE) {
  const rescored = [];
  // A scenario scored against a reference has to be re-scored AFTER it, and
  // filename order is not that order — `mars-flown-floor.json` sorting before
  // `mars-flown.json` is a coincidence of `-` sorting under `.`, and a
  // reference renamed anything later would silently score against nothing.
  // The live path pulls references in first; this does the same.
  const rank = (id) => {
    const scenario = SCENARIOS.find((candidate) => candidate.id === id);
    return scenario?.requires ? 1 : 0;
  };
  const files = readdirSync(RESCORE)
    .filter((f) => f.endsWith('.json') && f !== 'summary.json')
    .sort();
  const idOf = (file) => {
    const stored = JSON.parse(readFileSync(join(RESCORE, file), 'utf8'));
    return stored.analysis?.scenario ?? file.replace(/\.json$/, '');
  };
  files.sort((a, b) => rank(idOf(a)) - rank(idOf(b)));
  for (const file of files) {
    const stored = JSON.parse(readFileSync(join(RESCORE, file), 'utf8'));
    if (!stored.trace) continue;
    const previous = stored.analysis ?? {};
    const id = previous.scenario ?? file.replace(/\.json$/, '');
    const scenario = SCENARIOS.find((candidate) => candidate.id === id)
      ?? { id, title: previous.title ?? '' };
    const analysis = analyze(stored.trace, scenario, previous.notes ?? []);
    analysis.wallSeconds = previous.wallSeconds;
    // A scenario that judges itself keeps judging itself on a re-score: the
    // self-test is MEANT to blow the frame budget, and the generic rule would
    // read its injected stalls as a failure of the app.
    if (scenario.verify) {
      const problems = scenario.verify(analysis, stored.trace, rescored);
      analysis.failures = problems;
      analysis.verdict = problems.length ? 'FAIL' : 'PASS';
    }
    rescored.push(analysis);
    writeFileSync(join(RESCORE, file), JSON.stringify({ analysis, trace: stored.trace }, null, 1));
  }
  writeFileSync(join(RESCORE, 'summary.json'), JSON.stringify(rescored, null, 1));
  printTable(rescored, `${RESCORE} (re-scored)`);
  if (PRINT_JSON) console.log(JSON.stringify(rescored, null, 1));
  process.exit(rescored.some((r) => r.verdict !== 'PASS') ? 1 : 0);
}

mkdirSync(OUT_DIR, { recursive: true });

// A scenario scored against a reference cannot run without it, so asking for
// one by name brings its reference along — in the array's own order, which is
// what puts the reference first.
const asked = ONLY.length
  ? SCENARIOS.filter((s) => ONLY.includes(s.id))
  : SCENARIOS.filter((s) => !s.selfTestOnly);
const needed = new Set(asked.map((s) => s.id));
for (const s of asked) if (s.requires) needed.add(s.requires);
const chosen = SCENARIOS.filter((s) => needed.has(s.id));
// What would run, and in what order, without taking the lock or a browser.
if (has('list')) {
  for (const s of chosen) {
    console.log(`${s.id}${s.requires ? ` (after ${s.requires})` : ''}: ${s.title}`);
  }
  process.exit(0);
}
if (!chosen.length) {
  console.error(`No scenario matched ${ONLY.join(',')}. Known: ${SCENARIOS.map((s) => s.id).join(', ')}`);
  process.exit(2);
}

// A crashed browser must not take the rest of the battery down with it: the
// scenario that died is recorded as such and the next one gets a fresh one.
const GPU_ARGS = [
  '--use-gl=angle',
  '--use-angle=metal',
  '--enable-gpu',
  '--ignore-gpu-blocklist',
  '--enable-unsafe-swiftshader',
];

// Without this, Chromium reports `performance.memory` bucketed to 5 MiB and
// refreshed at most once every 20 minutes, so the recorder's heap column reads
// the same figure for a whole run and no collection can ever be seen. The
// figures it unlocks are the live ones, which is what makes a drop between two
// samples a collection rather than a rounding step — the GC line in every
// report below is only evidence while this is passed.
//
// --no-precise-memory takes it away again, and exists for one question: an
// instrument that changes the run it measures cannot be used to judge that run.
// Reading a precise usedJSHeapSize walks V8's spaces where the bucketed read
// returns a cached figure, so the two are not the same amount of work on the
// frame that reads. Comparing a batch of runs with the flag against a batch
// without is what says whether the column costs anything; the answer belongs
// in the report, not in an assumption. The heap column is dead weight in a run
// launched this way — every drop test silently fails to fire — so a `gcDrops`
// of 0 from one of these means nothing was measured, not that nothing happened.
const MEMORY_ARGS = PRECISE_MEMORY ? ['--enable-precise-memory-info'] : [];

// Only under --cold-cache: the browser's own program caches. Playwright already
// hands every launch a fresh --user-data-dir; these stop a compiled program
// being written into it at all.
const COLD_ARGS = COLD_CACHE
  ? ['--disable-gpu-shader-disk-cache', '--disable-gpu-program-cache', '--disable-gpu-disk-cache']
  : [];

// shell   — chrome-headless-shell, Playwright's default for headless: true.
//           Old headless, no display, its own frame scheduler.
// new     — full Chromium under --headless=new: the same renderer a person
//           runs, with the window never shown.
// chrome  — installed Google Chrome, headed. Ground truth, and the only engine
//           that must stay visible: an occluded window throttles rAF to 1 Hz
//           and every gap it reports is a lie.
const ENGINES = {
  shell: { headless: true, args: [...GPU_ARGS, ...MEMORY_ARGS, ...COLD_ARGS] },
  new: { headless: true, channel: 'chromium', args: [...GPU_ARGS, ...MEMORY_ARGS, ...COLD_ARGS] },
  chrome: { headless: false, channel: 'chrome', args: [...GPU_ARGS, ...MEMORY_ARGS, ...COLD_ARGS] },
};

const launchBrowser = () => {
  const options = ENGINES[ENGINE];
  if (!options) {
    console.error(`Unknown --engine=${ENGINE}. Known: ${Object.keys(ENGINES).join(', ')}`);
    process.exit(2);
  }
  return chromium.launch({
    executablePath: process.env.PW_CHROMIUM || undefined,
    ...options,
  });
};
const releaseLock = await takeBrowserLock();
let browser = await launchBrowser();

const results = [];
// True only while the close below is this script's own doing, so a browser that
// really crashed still says so.
let closedForCold = false;
try {
  for (const [index, scenario] of chosen.entries()) {
    const startedAt = Date.now();
    process.stdout.write(`[gate] ${scenario.id}: ${scenario.title}\n`);
    if (COLD_CACHE) {
      // A scenario's own profile, and a salt no earlier run of this build has
      // handed the driver: without both, only the first scenario is cold.
      coldSalt = `${scenario.id.replace(/[^a-z0-9]/gi, '')}${Date.now().toString(36)}`;
      if (index > 0 && browser.isConnected()) {
        await browser.close();
        closedForCold = true;
      }
    }
    if (!browser.isConnected()) {
      if (!closedForCold) process.stdout.write('       browser had died; relaunching\n');
      browser = await launchBrowser();
      closedForCold = false;
    }
    const { context, page, notes } = await openPage(browser, scenario.device, scenario.cpuThrottle);
    const note = (message) => notes.push(message);
    if (COLD_CACHE) note(`cold cache: fresh profile, disk shader cache off, shaderSalt=${coldSalt}`);
    if (!PRECISE_MEMORY) note('heap column not measured: --enable-precise-memory-info withheld, so gcDrops is 0 by construction');
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
    if (scenario.verify) {
      const problems = scenario.verify(analysis, trace, results);
      analysis.failures = problems;
      analysis.verdict = problems.length ? 'FAIL' : 'PASS';
    }
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
  releaseLock();
}

writeFileSync(join(OUT_DIR, 'summary.json'), JSON.stringify(results, null, 1));

printTable(results, LABEL);
console.log(`\nJSON: ${OUT_DIR}`);
if (PRINT_JSON) console.log(JSON.stringify(results, null, 1));

const failed = results.filter((r) => r.verdict !== 'PASS');
process.exit(failed.length ? 1 : 0);
