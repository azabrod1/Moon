// Spike S1 QA capture harness. Drives the running Vite dev server through the
// window.__moon dev bridge to reproduce every S1 acceptance-criteria capture
// (docs/descent/spikes/S1-FINDINGS.md). The spike mode itself is throwaway
// (src/descent/spikes/s1, entered via ?spike=s1); this driver survives so the
// ACs stay reproducible — notably the pass-cost number, which needs a real GPU.
//
// Run from the repo root (relative paths + node_modules resolve from here):
//   npm run dev -- --port 5174 --strictPort        # in one terminal
//   node tools/descent/spike-s1-capture.mjs spike  # all spike stills + AC captures
//   node tools/descent/spike-s1-capture.mjs parity --label=parity-before  # planetarium refactor-parity frame
//
// Output (screenshots + report.json) goes to planning/spike-s1/, which is
// gitignored — runs never dirty the tree. Commit any frame worth keeping into
// docs/descent/spikes/frames/ by hand.
//
// Rendering path: defaults to the real GPU (that is the point — this box had no
// working headless GPU, so the pass-cost AC was deferred to real hardware). Pass
// --software (or SPIKE_SOFTWARE=1) for the SwiftShader fallback if GPU frames come
// out black. Overrides: SPIKE_CHROME=<chrome path>, SPIKE_GL_ARGS="a,b,c" (raw
// launch flags), SPIKE_URL=<origin> (default http://localhost:5174).
import { chromium } from "playwright";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const OUT = "planning/spike-s1";
const URL = process.env.SPIKE_URL || "http://localhost:5174";

// Chrome binary: explicit override, else this environment's preinstalled build if
// present, else let Playwright launch its own bundled Chromium (the local case).
const PREINSTALLED = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const EXE = process.env.SPIKE_CHROME || (existsSync(PREINSTALLED) ? PREINSTALLED : undefined);

const SOFTWARE = process.argv.includes("--software") || process.env.SPIKE_SOFTWARE === "1";
// Real-GPU flags by default; SwiftShader software rasterization on request. Frame-ms
// / draw-call numbers are only meaningful on the GPU path — software is indicative.
const ARGS = process.env.SPIKE_GL_ARGS
  ? process.env.SPIKE_GL_ARGS.split(",")
  : SOFTWARE
    ? ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
    : ["--use-gl=angle", "--enable-gpu", "--ignore-gpu-blocklist"];

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
const mode = process.argv[2] || 'spike';

async function launch() {
  return chromium.launch({ headless: true, args: ARGS, ...(EXE ? { executablePath: EXE } : {}) });
}

async function newPage(browser, w = 1000, h = 640) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => {
    try {
      localStorage.clear(); sessionStorage.clear();
      indexedDB.deleteDatabase('orbital-sim-storage');
      localStorage.setItem('planetarium-help-seen', '1');
      localStorage.setItem('planetarium-surface-hint-seen', '1');
    } catch { /* storage blocked — harmless */ }
  });
  const page = await ctx.newPage();
  page._errs = [];
  page._warns = [];
  page.on('pageerror', (e) => page._errs.push(String(e)));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !t.includes('Failed to load resource')) page._errs.push(t);
    if (m.type() === 'warning') page._warns.push(t);
  });
  return page;
}

async function bootPlanetarium(page, query = '?auto=planetarium') {
  await page.goto(`${URL}/${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 90000 });
  await page.waitForFunction(() => { const ls = document.getElementById('loading-screen'); return !ls || ls.classList.contains('hidden'); }, { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

const settleFrames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

// Decode two PNGs in a 2D canvas and return mean-abs per-channel diff + max — the
// WebGL canvas can't be read live (no preserveDrawingBuffer), so we diff the saved
// PNGs instead. Region = optional [x0,y0,x1,y1] fraction of the frame.
async function pixelDiff(page, aPath, bPath, region) {
  const a = `data:image/png;base64,${(await readFile(aPath)).toString('base64')}`;
  const b = `data:image/png;base64,${(await readFile(bPath)).toString('base64')}`;
  return page.evaluate(async ({ a, b, region }) => {
    const load = (s) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = s; });
    const ia = await load(a), ib = await load(b);
    const w = Math.min(ia.naturalWidth, ib.naturalWidth), h = Math.min(ia.naturalHeight, ib.naturalHeight);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(ia, 0, 0); const da = x.getImageData(0, 0, w, h).data;
    x.clearRect(0, 0, w, h); x.drawImage(ib, 0, 0); const db = x.getImageData(0, 0, w, h).data;
    const [x0, y0, x1, y1] = region ? region : [0, 0, 1, 1];
    const px0 = Math.floor(x0 * w), py0 = Math.floor(y0 * h), px1 = Math.ceil(x1 * w), py1 = Math.ceil(y1 * h);
    let sr = 0, sg = 0, sb = 0, mx = 0, n = 0, nz = 0;
    for (let py = py0; py < py1; py++) for (let px = px0; px < px1; px++) {
      const i = (py * w + px) * 4;
      const dr = Math.abs(da[i] - db[i]), dg = Math.abs(da[i + 1] - db[i + 1]), dbl = Math.abs(da[i + 2] - db[i + 2]);
      sr += dr; sg += dg; sb += dbl; mx = Math.max(mx, dr, dg, dbl); n++;
      if (dr + dg + dbl > 6) nz++;
    }
    return { meanR: sr / n, meanG: sg / n, meanB: sb / n, max: mx, changedFrac: nz / n, w, h };
  }, { a, b, region });
}

async function meanLum(page, imgPath, region) {
  const img = `data:image/png;base64,${(await readFile(imgPath)).toString('base64')}`;
  return page.evaluate(async ({ img, region }) => {
    const load = (s) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = s; });
    const im = await load(img);
    const w = im.naturalWidth, h = im.naturalHeight;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(im, 0, 0); const d = x.getImageData(0, 0, w, h).data;
    const [x0, y0, x1, y1] = region ? region : [0, 0, 1, 1];
    const px0 = Math.floor(x0 * w), py0 = Math.floor(y0 * h), px1 = Math.ceil(x1 * w), py1 = Math.ceil(y1 * h);
    let s = 0, n = 0; for (let py = py0; py < py1; py++) for (let px = px0; px < px1; px++) { const i = (py * w + px) * 4; s += d[i] + d[i + 1] + d[i + 2]; n++; }
    return s / n / 3;
  }, { img, region });
}

// ---------------------------------------------------------------------------

async function runParity() {
  const label = arg('label', 'parity-before');
  const browser = await launch();
  try {
    const page = await newPage(browser, 1000, 640);
    await bootPlanetarium(page);
    await page.evaluate(() => window.__moon.setChrome(false));
    // Pin the clock AND pause so both runs sit at the identical sim instant
    // (settle-time wall-clock drift would otherwise move the moons between runs).
    await page.evaluate(() => window.__moon.setTimeMs(Date.parse('2026-07-14T00:00:00Z')));
    await page.evaluate(() => window.__moon.setTimePaused(true));
    for (const body of ['Jupiter', 'Saturn', 'Earth']) {
      await page.evaluate((n) => window.__moon.frame(n, 0.6, 0), body);
      await page.waitForTimeout(1800);
      await settleFrames(page);
      const file = path.join(OUT, `${label}-${body}.png`);
      await page.screenshot({ path: file });
      console.log(`[parity] ${body} -> ${file}`);
    }
    if (page._errs.length) console.log('[parity] page errors:', page._errs.slice(0, 6));
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------

async function bootSpike(page, extra = '') {
  await page.goto(`${URL}/?spike=s1&debug=1${extra}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.spikeState && window.__moon.spikeState()), { timeout: 90000 });
  await page.waitForFunction(() => { const ls = document.getElementById('loading-screen'); return !ls || ls.classList.contains('hidden'); }, { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(1200);
}

async function shootAt(page, alt, file, { look } = {}) {
  await page.evaluate(() => window.__moon.spikeSetPaused(true));
  await page.evaluate((a) => window.__moon.spikeSetAlt(a), alt);
  if (look) await page.evaluate(([y, p]) => window.__moon.spikeSetLook(y, p), look);
  await page.waitForTimeout(400);
  await settleFrames(page); await settleFrames(page);
  await page.screenshot({ path: file });
  const st = await page.evaluate(() => window.__moon.spikeState());
  console.log(`[spike] alt=${alt} -> ${path.basename(file)}  near=${st.near.toFixed(3)} far=${(st.far/1000).toFixed(1)}km draws=${st.drawCalls}`);
  return st;
}

async function runSpike() {
  const report = {};
  const browser = await launch();
  try {
    const page = await newPage(browser, 1000, 640);
    await bootSpike(page);

    // 1) Altitude stills.
    report.stills = {};
    for (const alt of [450000, 20000, 2000, 100, 2]) {
      const st = await shootAt(page, alt, path.join(OUT, `s1-alt-${alt}.png`));
      report.stills[alt] = { near: st.near, far: st.far, drawCalls: st.drawCalls };
    }

    // 2) Jitter proof at ~2 m eye, looking down at the checker ground (EV nominal
    //    so the detail is visible). The naive path bakes ABSOLUTE selenocentric
    //    float32 coords, so its patch is displaced/terraced vs the camera-relative
    //    path — and it stair-steps under a small descent while the relative path is
    //    smooth. Alts are non-multiples of the 0.125 m float32 ULP so naive is off.
    const GROUND = [0, 0.4, 1, 1];
    await page.evaluate(() => window.__moon.spikeSetPaused(true));
    await page.evaluate(() => window.__moon.spikeSetLook(0, -55)); // steep down: checker fills the frame
    const jitAlts = [2.55, 2.43, 2.31, 2.19, 2.07];
    const shootSeries = async (naive) => {
      await page.evaluate((n) => window.__moon.spikeSetNaive(n), naive);
      const tag = naive ? 'naive' : 'rel';
      for (let i = 0; i < jitAlts.length; i++) {
        await page.evaluate((a) => window.__moon.spikeSetAlt(a), jitAlts[i]);
        await page.waitForTimeout(220); await settleFrames(page); await settleFrames(page);
        await page.screenshot({ path: path.join(OUT, `s1-jitter-${tag}-${i}.png`) });
      }
    };
    await shootSeries(false);
    await shootSeries(true);
    await page.evaluate(() => window.__moon.spikeSetNaive(false));
    await page.evaluate(() => window.__moon.spikeSetLook(0, 0));
    // Adjacent-frame diffs within each series: rel should be smooth/even, naive
    // erratic (frozen plateaus then jumps). Plus the static rel-vs-naive shift.
    const stepDiffs = async (tag) => {
      const out = [];
      for (let i = 1; i < jitAlts.length; i++) {
        const d = await pixelDiff(page, path.join(OUT, `s1-jitter-${tag}-${i - 1}.png`), path.join(OUT, `s1-jitter-${tag}-${i}.png`), GROUND);
        out.push(+d.changedFrac.toFixed(4));
      }
      return out;
    };
    const relSteps = await stepDiffs('rel');
    const naiveSteps = await stepDiffs('naive');
    const staticShift = await pixelDiff(page, path.join(OUT, 's1-jitter-rel-4.png'), path.join(OUT, 's1-jitter-naive-4.png'), GROUND);
    const spread = (a) => Math.max(...a) - Math.min(...a);
    report.jitter = {
      relStepChangedFrac: relSteps, naiveStepChangedFrac: naiveSteps,
      relStepSpread: +spread(relSteps).toFixed(4), naiveStepSpread: +spread(naiveSteps).toFixed(4),
      staticRelVsNaiveChangedFrac: staticShift.changedFrac, staticRelVsNaiveMeanDiff: (staticShift.meanR + staticShift.meanG + staticShift.meanB) / 3,
    };
    console.log(`[jitter] rel steps=${JSON.stringify(relSteps)} (spread ${spread(relSteps).toFixed(4)})`);
    console.log(`[jitter] naive steps=${JSON.stringify(naiveSteps)} (spread ${spread(naiveSteps).toFixed(4)})`);
    console.log(`[jitter] static rel-vs-naive: changed=${(staticShift.changedFrac*100).toFixed(2)}% meanDiff=${((staticShift.meanR+staticShift.meanG+staticShift.meanB)/3).toFixed(2)}`);

    // 3) Bloom AC: at 100 m facing the sun, bloom on vs off. Ground (below horizon)
    //    diff ~0 while the sun-glare region differs — bloom lives on the HDR sky
    //    only. Tested at nominal EV+2 (clean, terrain sub-threshold) AND EV+4 (the
    //    over-ceiling stress where a naive exposure multiply pushes sunlit terrain
    //    past the threshold — the documented bound).
    await page.evaluate(() => window.__moon.spikeSetPaused(true));
    await page.evaluate(() => window.__moon.spikeSetAlt(100));
    await page.evaluate(() => window.__moon.spikeSetLook(135, 50)); // face sun; sun near top, ground below
    const SKY = [0, 0, 1, 0.3], GRND = [0, 0.62, 1, 1];
    report.bloom = {};
    for (const ev of [2, 4]) {
      await page.evaluate((e) => window.__moon.spikeSetExposureEV(e), ev);
      await page.evaluate(() => window.__moon.spikeSetBloomEnabled(true));
      await page.waitForTimeout(300); await settleFrames(page); await settleFrames(page);
      await page.screenshot({ path: path.join(OUT, `s1-bloom-on-ev${ev}.png`) });
      await page.evaluate(() => window.__moon.spikeSetBloomEnabled(false));
      await page.waitForTimeout(300); await settleFrames(page); await settleFrames(page);
      await page.screenshot({ path: path.join(OUT, `s1-bloom-off-ev${ev}.png`) });
      await page.evaluate(() => window.__moon.spikeSetBloomEnabled(true));
      const g = await pixelDiff(page, path.join(OUT, `s1-bloom-on-ev${ev}.png`), path.join(OUT, `s1-bloom-off-ev${ev}.png`), GRND);
      const s = await pixelDiff(page, path.join(OUT, `s1-bloom-on-ev${ev}.png`), path.join(OUT, `s1-bloom-off-ev${ev}.png`), SKY);
      report.bloom[`ev${ev}`] = {
        groundChangedFrac: g.changedFrac, groundMeanDiff: (g.meanR + g.meanG + g.meanB) / 3,
        skyChangedFrac: s.changedFrac, skyMeanDiff: (s.meanR + s.meanG + s.meanB) / 3,
      };
      console.log(`[bloom EV+${ev}] ground changed=${(g.changedFrac*100).toFixed(3)}% meanDiff=${((g.meanR+g.meanG+g.meanB)/3).toFixed(3)}  sky changed=${(s.changedFrac*100).toFixed(2)}% meanDiff=${((s.meanR+s.meanG+s.meanB)/3).toFixed(2)}`);
    }
    await page.evaluate(() => window.__moon.spikeSetExposureEV(2));
    await page.evaluate(() => window.__moon.spikeSetLook(0, 0));

    // 4) Pass-cost: average frame ms sky-on vs sky-off over ~300 frames (done in
    //    the spike, before the exit, to avoid a slow planetarium reload mid-run).
    await page.evaluate(() => window.__moon.spikeSetPaused(true));
    await page.evaluate(() => window.__moon.spikeSetAlt(2000));
    await page.evaluate(() => window.__moon.spikeSetLook(0, 0));
    await page.waitForTimeout(500);
    const passCost = async (skyOn) => {
      await page.evaluate((on) => window.__moon.spikeSetSkyPassEnabled(on), skyOn);
      await page.waitForTimeout(300);
      const samples = await page.evaluate(async () => {
        const N = 300; const t = [];
        let last = performance.now();
        await new Promise((res) => {
          let i = 0;
          const step = () => { const now = performance.now(); t.push(now - last); last = now; if (++i >= N) return res(); requestAnimationFrame(step); };
          requestAnimationFrame(step);
        });
        t.sort((a, b) => a - b);
        return { avg: t.reduce((s, v) => s + v, 0) / t.length, p50: t[Math.floor(t.length * 0.5)] };
      });
      return samples;
    };
    const skyOn = await passCost(true);
    const skyOff = await passCost(false);
    await page.evaluate(() => window.__moon.spikeSetSkyPassEnabled(true));
    report.passCost = { skyOnAvgMs: skyOn.avg, skyOffAvgMs: skyOff.avg, deltaMs: skyOn.avg - skyOff.avg };
    console.log(`[passcost] sky-on avg=${skyOn.avg.toFixed(2)}ms  sky-off avg=${skyOff.avg.toFixed(2)}ms  delta=${(skyOn.avg-skyOff.avg).toFixed(2)}ms [SOFTWARE — indicative only]`);

    // 5) AA probe: obelisk silhouette at 100 m, default vs samples=4.
    await page.evaluate(() => window.__moon.spikeSetPaused(true));
    await page.evaluate(() => window.__moon.spikeSetAlt(100));
    await page.evaluate(() => window.__moon.spikeSetLook(3, -3)); // obelisk to one side against the sky
    await page.waitForTimeout(400); await settleFrames(page); await settleFrames(page);
    await page.screenshot({ path: path.join(OUT, 's1-aa-default.png') });
    const aa4 = await page.evaluate(() => window.__moon.spikeRebuildComposer(4));
    await page.waitForTimeout(500); await settleFrames(page); await settleFrames(page);
    await page.screenshot({ path: path.join(OUT, 's1-aa-msaa4.png') });
    const aaDiff = await pixelDiff(page, path.join(OUT, 's1-aa-default.png'), path.join(OUT, 's1-aa-msaa4.png'));
    const aaState = await page.evaluate(() => window.__moon.spikeState());
    report.aa = { rebuildOk: aa4, changedFrac: aaDiff.changedFrac, maxDiff: aaDiff.max, framePresent: aaState != null };
    console.log(`[aa] samples=4 rebuild=${aa4}  frame changed=${(aaDiff.changedFrac*100).toFixed(2)}% max=${aaDiff.max}`);
    await page.evaluate(() => window.__moon.spikeRebuildComposer()); // back to default
    await page.evaluate(() => window.__moon.spikeSetLook(0, 0));

    // 6) No-bloom fallback path: fresh page with &nobloom=1, one 100 m frame —
    //    proves the two-pass renderPassesDirect path (sky above horizon, ground correct).
    {
      const p2 = await newPage(browser, 1000, 640);
      await bootSpike(p2, '&nobloom=1');
      await p2.evaluate(() => window.__moon.spikeSetPaused(true));
      await p2.evaluate(() => window.__moon.spikeSetAlt(100));
      await p2.evaluate(() => window.__moon.spikeSetLook(135, 45)); // face sun so sky/glare shows above the ground
      await p2.waitForTimeout(400); await settleFrames(p2); await settleFrames(p2);
      await p2.screenshot({ path: path.join(OUT, 's1-nobloom-100.png') });
      const skyLum = await meanLum(p2, path.join(OUT, 's1-nobloom-100.png'), [0, 0, 1, 0.3]);
      const groundLum = await meanLum(p2, path.join(OUT, 's1-nobloom-100.png'), [0, 0.7, 1, 1]);
      report.nobloom = { skyLum, groundLum };
      console.log(`[nobloom] sky region lum=${skyLum.toFixed(2)} ground region lum=${groundLum.toFixed(2)}  (page errors: ${p2._errs.length ? p2._errs.slice(0,3) : 'none'})`);
      await p2.close();
    }

    // 7) Exposure-restore AC (LAST — this exits the spike): the mode grades
    //    toneMappingExposure to 1.2 on entry and must restore the pre-entry 1.0
    //    (startup value; the planetarium never touches it). EV+3 only scales the
    //    sun LIGHT (pre-bloom) — it never touches toneMappingExposure by design.
    await page.evaluate(() => window.__moon.spikeSetExposureEV(3));
    const before = await page.evaluate(() => window.__moon.rendererState());
    await page.evaluate(() => window.__moon.spikeExit());
    // Wait until deactivate() actually restores it (the switch has its own sleeps;
    // the planetarium was already loaded at boot so ready() alone returns too soon).
    await page.waitForFunction(() => window.__moon.rendererState().toneMappingExposure !== 1.2, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => window.__moon.rendererState());
    report.exposureRestore = { inSpikeExposure: before.toneMappingExposure, afterExitExposure: after.toneMappingExposure, afterExitAutoClear: after.autoClear };
    console.log(`[exposure] in-spike toneMappingExposure=${before.toneMappingExposure} → after exit=${after.toneMappingExposure} (autoClear=${after.autoClear})`);
    // Post-exit planetarium frame (proves the round-trip back to a working app).
    await page.evaluate(() => window.__moon.setChrome && window.__moon.setChrome(false));
    await page.evaluate(() => window.__moon.frame && window.__moon.frame('Jupiter', 0.6, 0));
    await page.waitForTimeout(1800); await settleFrames(page);
    await page.screenshot({ path: path.join(OUT, 's1-postexit-planetarium.png') });

    report.pageErrors = page._errs.slice(0, 10);
    report.pageWarnings = page._warns.filter((w) => w.includes('background') || w.includes('sky') || w.includes('pass')).slice(0, 10);
    console.log('[spike] page errors:', report.pageErrors.length ? report.pageErrors : 'none');
    console.log('[spike] relevant warnings:', report.pageWarnings.length ? report.pageWarnings : 'none');
  } finally {
    await browser.close();
  }
  await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`[spike] report -> ${path.join(OUT, 'report.json')}`);
}

// ---------------------------------------------------------------------------

async function main() {
  await mkdir(OUT, { recursive: true });
  if (mode === 'parity') await runParity();
  else if (mode === 'spike') await runSpike();
  else { console.error(`unknown mode: ${mode}`); process.exit(1); }
}

await main();
