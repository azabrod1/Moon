// Asserting GPU check for the precomputed atmosphere tables: bakes them on the
// real GPU, reads samples back through the 8-bit blit path at 16-bit precision,
// and compares them against the CPU reference integrator in
// src/planetarium/world/atmosphereModel.ts. Also reports the numbers commit 1
// is accepted on — bake wall time, draw count, program links, peak bytes.
//
// The graded comparison is phase-free on both sides by construction, so four
// detectors sit beside it, each covering something it cannot see: the combined
// lookup WITH the shader's own phase functions and Mie recovery, the irradiance
// table (which nothing else reads back), the twilight band at mu_s <= 0, and
// the multi-order ratio, which is the only place the ground albedo reaches. A
// last page loses the GPU context mid-bake: the tier has to come back.
//
// Samples land on table texel centres: the question is whether the bake is
// right, and an off-centre sample would fold the lookup's own interpolation
// error into that answer. Grazing samples on both sides of the horizon are
// included by construction — they are the outermost texels of each half of the
// folded mu axis.
//
// Prereq: npx vite --port 5636 --strictPort
//   node tools/atmo-lut-check.mjs
//   node tools/atmo-lut-check.mjs --browser=webkit --url=http://localhost:5636
import { chromium, webkit } from 'playwright';

function arg(name, fallback) {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

const baseUrl = arg('url', 'http://localhost:5636');
const browserName = arg('browser', 'chromium');
const tolerancePct = Number(arg('tolerance-pct', '2'));
// Below half-float's smallest normal a table entry is a subnormal a GPU may
// flush to zero; nothing there is the bake's fault, or visible.
const FLOOR_ABS = 6.1e-5;
// The combined lookup adds the shader's own phase functions and Mie recovery to
// the 2% the phase-free comparison holds; the Mie recovery is an approximation
// on the GPU side only, which is what the extra room is for.
const PHASE_TOLERANCE_PCT = 6;
// The reference integrates the same 16x64 hemisphere the bake does, but with
// coarser inner sample counts than the shader's 50/500 - that difference, not
// the table, is what this tolerance holds.
const IRRADIANCE_TOLERANCE_PCT = 8;
const TWILIGHT_TOLERANCE_PCT = 4;
// Multiple scattering against single, at the same texel. The ground albedo only
// reaches the table through these orders, so the bands are what a wrong albedo
// falls out of.
// Measured 1.43 low / 1.63 high with the ground albedo at 0.1; at 0.5 the high
// one goes to 2.37 while the low one barely moves, which is why both are here.
const LOW_SUN_RATIO = [1.25, 1.65];
const HIGH_SUN_RATIO = [1.40, 1.90];
// How far the validated sample may sit from the CPU reference - the same band
// the tier's own validation applies, checked here against the numbers.
const VALIDATION_BAND = [0.5, 3.0];
const skipLadder = process.argv.includes('--no-ladder');

const launcher = browserName === 'webkit' ? webkit : chromium;
const browser = await launcher.launch({
  headless: true,
  executablePath: process.env.PW_CHROMIUM && browserName === 'chromium' ? process.env.PW_CHROMIUM : undefined,
  args: browserName === 'chromium'
    ? [
      '--use-gl=angle',
      '--use-angle=metal',
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-swiftshader',
      ...(process.env.PW_NO_SANDBOX ? ['--no-sandbox'] : []),
    ]
    : undefined,
});

const failures = [];
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  });
  await context.addInitScript(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
      indexedDB.deleteDatabase('orbital-sim-storage');
      localStorage.setItem('planetarium-help-seen', '1');
      localStorage.setItem('planetarium-surface-hint-seen', '1');
    } catch { /* storage can be unavailable in hardened contexts */ }
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  const bootStart = Date.now();
  await page.goto(`${baseUrl}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => !!(window.__moon && window.__moon.ready && window.__moon.ready()),
    { timeout: 90000 },
  );
  await page.waitForFunction(() => {
    const loading = document.getElementById('loading-screen');
    return !loading || loading.classList.contains('hidden');
  }, { timeout: 90000 });
  const bootMs = Date.now() - bootStart;

  // The boot bake is armed for the idle after the load screen; let it finish
  // before any measurement bake, or the two fight over the same GPU.
  await page.waitForFunction(() => {
    const s = window.__moon?.atmoState?.();
    return !!s && (s.stats.length > 0 || s.capability === false);
  }, { timeout: 120000 }).catch(() => {});
  const probe = await page.evaluate(() => window.__moon.atmoState());
  console.log(`browser        ${browserName}`);
  console.log(`boot to ready  ${bootMs} ms`);
  console.log(`LUT probe      ${probe ? probe.capability : 'no planetarium'}`);
  console.log(`table sizes    ${JSON.stringify(probe?.sizes)}`);
  const boot = probe?.stats?.[0];
  if (boot) {
    const mib = (b) => (b / (1024 * 1024)).toFixed(2);
    console.log(
      `boot bake      ${boot.wallMs.toFixed(0)} ms wall, ${boot.submitMs.toFixed(0)} ms submit, `
      + `${boot.drawCalls} draws, ${boot.slices} slices, links ${boot.programsBefore}\u2192${boot.programsAfter}, `
      + `peak ${mib(boot.peakBytes)} MiB, resident ${mib(boot.residentBytes)} MiB, `
      + `orders ${boot.orders}, validated ${boot.validated}`,
    );
  } else {
    console.log('boot bake      none recorded');
  }

  // The comparison bakes ONE order, so the accumulator holds exactly single
  // scattering and the CPU reference has the same thing to compute.
  const result = await page.evaluate(async (tolerance) => {
    const M = await import('/src/planetarium/world/atmosphereModel.ts');
    const params = M.atmosphereParams('Earth');
    const state = window.__moon.atmoState();
    const sizes = state.sizes;

    const bake = await window.__moon.atmoBake({ orders: 1, drawsPerSlice: 1e9 });
    if (!bake || !bake.validated) return { bake, error: 'single-order bake did not validate' };

    // --- sample coordinates, at texel centres -------------------------------
    const centre = (i, n) => (i + 0.5) / n;
    const transmittanceSamples = [];
    for (const ri of [0, Math.round(sizes.transmittanceH * 0.25), Math.round(sizes.transmittanceH * 0.5),
      Math.round(sizes.transmittanceH * 0.75), sizes.transmittanceH - 1]) {
      for (const mi of [0, Math.round(sizes.transmittanceW * 0.35), Math.round(sizes.transmittanceW * 0.7),
        sizes.transmittanceW - 1]) {
        const { r, mu } = M.rMuFromTransmittanceUv(
          params, { u: centre(mi, sizes.transmittanceW), v: centre(ri, sizes.transmittanceH) }, sizes,
        );
        transmittanceSamples.push({ r, mu, label: `r[${ri}] mu[${mi}]` });
      }
    }

    const scatteringSamples = [];
    const muIndices = [
      // The two texels either side of the horizon on each half of the folded
      // mu axis, plus interior ones.
      0, 1, Math.round(sizes.scatteringMu * 0.25), sizes.scatteringMu / 2 - 1,
      sizes.scatteringMu / 2, Math.round(sizes.scatteringMu * 0.75),
      sizes.scatteringMu - 2, sizes.scatteringMu - 1,
    ];
    for (const ri of [1, Math.round(sizes.scatteringR * 0.5), sizes.scatteringR - 2]) {
      for (const mi of muIndices) {
        const msi = Math.round(sizes.scatteringMuS * 0.75);
        const uvwz = {
          uNu: 3 / (sizes.scatteringNu - 1),
          uMuS: centre(msi, sizes.scatteringMuS),
          uMu: centre(mi, sizes.scatteringMu),
          uR: centre(ri, sizes.scatteringR),
        };
        const s = M.rMuMuSNuFromScatteringUvwz(params, uvwz, sizes);
        // nu is not free: outside this range the three angles are not a real
        // geometry, and the bake clamped it before integrating.
        const span = Math.sqrt(Math.max(0, (1 - s.mu * s.mu) * (1 - s.muS * s.muS)));
        const nu = Math.min(Math.max(s.nu, s.mu * s.muS - span), s.mu * s.muS + span);
        scatteringSamples.push({
          r: s.r, mu: s.mu, muS: s.muS, nu, hitsGround: s.intersectsGround,
          label: `r[${ri}] mu[${mi}] ${s.intersectsGround ? 'ground' : 'sky'}`,
        });
      }
    }

    // --- readback, with a fixed auto-range ladder ---------------------------
    // The blit is 8-bit twice; the scale puts the value in the top of the
    // 16-bit window. The ladder is fixed, not derived from the expected value.
    // Optical depth reaches ~22 on a horizon path; single-scattering radiance
    // reaches ~1e-7. One ladder spans both. `channels` keeps the transmittance
    // table's constant alpha out of the range decision.
    const LADDER = [1 / 32, 1 / 8, 1 / 2, 2, 8, 32, 128, 512];
    const readWithRange = (descriptors, channels) => {
      const out = descriptors.map(() => null);
      for (const scale of LADDER) {
        const pending = descriptors
          .map((d, i) => ({ d, i }))
          .filter(({ i }) => out[i] === null);
        if (pending.length === 0) break;
        const read = window.__moon.atmoSample(pending.map(({ d }) => ({ ...d, scale })));
        pending.forEach(({ i }, k) => {
          const v = read[k];
          const peak = Math.max(...v.slice(0, channels)) * scale;
          // Accept once the largest channel sits inside the window without
          // clipping it; at the last rung, take whatever it reads.
          const usable = peak >= 0.02 && peak < 0.999;
          if (usable || scale === LADDER[LADDER.length - 1]) out[i] = { value: v, scale };
        });
      }
      return out;
    };

    const tRead = readWithRange(
      transmittanceSamples.map((s) => ({ kind: 'transmittance', r: s.r, mu: s.mu })), 3,
    );
    const sRead = readWithRange(scatteringSamples.map((s) => ({
      kind: 'scattering', r: s.r, mu: s.mu, muS: s.muS, nu: s.nu, hitsGround: s.hitsGround,
    })), 4);

    // --- CPU reference ------------------------------------------------------
    const rows = [];
    const relErr = (a, b) => (Math.abs(a) < 1e-7 && Math.abs(b) < 1e-7 ? 0 : Math.abs(a - b) / Math.max(Math.abs(b), 1e-7));

    // The transmittance table stores OPTICAL DEPTH; compare what is stored.
    transmittanceSamples.forEach((s, i) => {
      const cpu = M.opticalDepthToTopBoundary(params, s.r, s.mu);
      const gpu = tRead[i].value;
      for (let c = 0; c < 3; c++) {
        rows.push({
          table: 'opticalDepth', label: `${s.label} ch${c}`,
          cpu: cpu[c], gpu: gpu[c], err: relErr(gpu[c], cpu[c]),
        });
      }
    });

    scatteringSamples.forEach((s, i) => {
      const cpu = M.computeSingleScattering(params, s.r, s.mu, s.muS, s.nu, s.hitsGround, 50, 500);
      const gpu = sRead[i].value;
      for (let c = 0; c < 3; c++) {
        rows.push({
          table: 'rayleigh', label: `${s.label} ch${c}`,
          cpu: cpu.rayleigh[c], gpu: gpu[c], err: relErr(gpu[c], cpu.rayleigh[c]),
        });
      }
      rows.push({
        table: 'mie', label: `${s.label} a`,
        cpu: cpu.mie[0], gpu: gpu[3], err: relErr(gpu[3], cpu.mie[0]),
      });
    });

    // Below half-float's smallest normal a table entry is a subnormal that GPUs
    // are free to flush to zero, so nothing there is the bake's fault — and
    // nothing there is visible either.
    const FLOOR = 6.1e-5;
    const graded = rows.filter((row) => Math.abs(row.cpu) > FLOOR);
    const worst = graded.reduce((a, b) => (a && a.err > b.err ? a : b), null);
    const mean = graded.reduce((sum, row) => sum + row.err, 0) / Math.max(graded.length, 1);
    return {
      bake,
      compared: graded.length,
      skippedBelowFloor: rows.length - graded.length,
      meanErrPct: mean * 100,
      worstErrPct: worst ? worst.err * 100 : 0,
      worst,
      failures: graded.filter((row) => row.err > tolerance / 100).slice(0, 12),
      all: rows.map((r) => ({ table: r.table, label: r.label, cpu: r.cpu, gpu: r.gpu, err: r.err })),
    };
  }, tolerancePct);

  if (result.error) failures.push(result.error);
  console.log('');
  console.log('CPU-vs-table comparison (single scattering, texel centres)');
  console.log(`  samples compared   ${result.compared ?? 'none - '} (${result.skippedBelowFloor ?? 'no'} below the readback floor)`);
  console.log(`  mean relative err  ${result.meanErrPct?.toFixed(3) ?? '-'} %`);
  console.log(`  worst relative err ${result.worstErrPct?.toFixed(3) ?? '-'} % ${result.worst ? `(${result.worst.table} ${result.worst.label}: cpu ${result.worst.cpu.toExponential(4)} vs gpu ${result.worst.gpu.toExponential(4)})` : ''}`);
  if (process.argv.includes('--dump')) {
    const sorted = [...result.all].sort((a, b) => b.err - a.err);
    for (const row of sorted) {
      console.log(`  ${row.err > 0.02 ? '!' : ' '} ${(row.err * 100).toFixed(2).padStart(8)} %  ${row.table.padEnd(14)} ${row.label.padEnd(28)} cpu ${row.cpu.toExponential(4)}  gpu ${row.gpu.toExponential(4)}`);
    }
  }
  // -------------------------------------------------------------------------
  // Detectors the 2% comparison above cannot see: the phase functions (the
  // table is phase-free by construction on both sides), the irradiance table
  // (compared against nothing), and the twilight band the campaign exists for
  // (the comparison above samples one mu_s texel, at a sun 17.6 degrees up).
  // -------------------------------------------------------------------------
  const detectors = await page.evaluate(async (tolerances) => {
    const M = await import('/src/planetarium/world/atmosphereModel.ts');
    const params = M.atmosphereParams('Earth');
    const sizes = window.__moon.atmoState().sizes;
    const centre = (i, n) => (i + 0.5) / n;
    const rows = [];
    const relErr = (gpu, cpu) => Math.abs(gpu - cpu) / Math.max(Math.abs(cpu), 1e-30);
    // The probe blit is a [0, 1] window; pick the rung that puts the largest
    // channel inside it, exactly as the comparison above does.
    const LADDER = [1 / 32, 1 / 8, 1 / 2, 2, 8, 32, 128, 512, 2048, 8192];
    const readRanged = (descriptor, channels) => {
      let last = null;
      for (const scale of LADDER) {
        const v = window.__moon.atmoSample([{ ...descriptor, scale }])[0];
        last = { value: v, scale };
        const peak = Math.max(...v.slice(0, channels)) * scale;
        if (peak >= 0.02 && peak < 0.999) return last;
      }
      return last;
    };

    // --- (i) the combined lookup, with both phase functions applied on the GPU
    // A one-order table holds exactly single scattering, so the CPU reference
    // can produce the same radiance; the shader's phases, its Mie recovery and
    // the g it was handed are the only things that can differ.
    const one = await window.__moon.atmoBake({ orders: 1, drawsPerSlice: 1e9 });
    if (!one || !one.validated) return { error: 'one-order bake did not validate' };

    const geometry = (ri, mi, msi) => {
      const s = M.rMuMuSNuFromScatteringUvwz(params, {
        uNu: 3 / (sizes.scatteringNu - 1),
        uMuS: centre(msi, sizes.scatteringMuS),
        uMu: centre(mi, sizes.scatteringMu),
        uR: centre(ri, sizes.scatteringR),
      }, sizes);
      return s;
    };
    const physicalNu = (mu, muS, nu) => {
      const span = Math.sqrt(Math.max(0, (1 - mu * mu) * (1 - muS * muS)));
      return Math.min(Math.max(nu, mu * muS - span), mu * muS + span);
    };

    const phase = [];
    const msiSun = Math.round(sizes.scatteringMuS * 0.75);
    for (const [ri, mi] of [[1, 80], [1, 70]].map(([a, b]) => [a, Math.round(b * sizes.scatteringMu / 128)])) {
      const g = geometry(ri, mi, msiSun);
      for (const wanted of [0.9, -0.5]) {
        const nu = physicalNu(g.mu, g.muS, wanted);
        const read = readRanged({
          kind: 'combined', r: g.r, mu: g.mu, muS: g.muS, nu, hitsGround: g.intersectsGround,
        }, 3);
        const cpu = M.singleScatteringRadiance(
          params, g.r, g.mu, g.muS, nu, g.intersectsGround, 50, 500,
        );
        for (let c = 0; c < 3; c++) {
          phase.push({
            label: `r[${ri}] mu[${mi}] nu ${nu.toFixed(3)} ch${c}`,
            cpu: cpu[c], gpu: read.value[c], err: relErr(read.value[c], cpu[c]),
          });
        }
        rows.push({ group: 'phase', nu, mu: g.mu, muS: g.muS, r: g.r });
      }
    }

    // --- (iii) twilight: mu_s at or below the horizon, where the tool has
    // never compared anything and where the whole campaign happens.
    const twilightMu = Math.round(0.75 * sizes.scatteringMu);
    const twilightR = [2, Math.round(sizes.scatteringR * 0.25)];
    const twilightIndices = [];
    for (let msi = 0; msi < sizes.scatteringMuS; msi++) {
      const g = geometry(twilightR[0], twilightMu, msi);
      if (g.muS <= 0) twilightIndices.push({ msi, muS: g.muS });
    }
    // The two DEEPEST texels below the horizon that the table can still hold:
    // past a certain depth the radiance is a half-float subnormal and there is
    // nothing left to compare. Choosing them by the reference rather than by
    // index means a parameter change moves the samples instead of silently
    // emptying the detector.
    const chosen = twilightIndices.filter(({ msi }) => twilightR.every((ri) => {
      const g = geometry(ri, twilightMu, msi);
      const cpu = M.computeSingleScattering(
        params, g.r, g.mu, g.muS, physicalNu(g.mu, g.muS, g.nu), g.intersectsGround, 50, 500,
      );
      return Math.max(...cpu.rayleigh) > 4 * 6.1e-5;
    })).slice(0, 2);
    const twilight = [];
    for (const { msi } of chosen) {
      for (const ri of twilightR) {
        const g = geometry(ri, twilightMu, msi);
        const nu = physicalNu(g.mu, g.muS, g.nu);
        const read = readRanged({
          kind: 'scattering', r: g.r, mu: g.mu, muS: g.muS, nu, hitsGround: g.intersectsGround,
        }, 3);
        const cpu = M.computeSingleScattering(
          params, g.r, g.mu, g.muS, nu, g.intersectsGround, 50, 500,
        );
        for (let c = 0; c < 3; c++) {
          twilight.push({
            label: `r[${ri}] muS ${g.muS.toFixed(3)} ch${c}`,
            muS: g.muS, cpu: cpu.rayleigh[c], gpu: read.value[c],
            err: relErr(read.value[c], cpu.rayleigh[c]),
          });
        }
      }
    }

    // --- (ii) the irradiance table. Two orders puts exactly the sky's
    // first-order irradiance in it, which is the one part of that table a
    // table-free reference can reproduce.
    const two = await window.__moon.atmoBake({ orders: 2, drawsPerSlice: 1e9 });
    if (!two || !two.validated) return { error: 'two-order bake did not validate' };
    const irradiance = [];
    for (const [ri, msiFraction] of [[0, 0.75], [4, 0.875], [8, 0.625]]) {
      const msi = Math.round(sizes.irradianceW * msiFraction);
      const { r, muS } = M.rMuSFromIrradianceUv(params, {
        u: centre(msi, sizes.irradianceW), v: centre(ri, sizes.irradianceH),
      }, sizes);
      const read = readRanged({ kind: 'irradiance', r, mu: 1, muS }, 3);
      // The reference's own sample counts, not a cheaper pair: at the ground
      // row a 25/250 integration sits 20 % under a 50/500 one, which would be
      // read as the table being wrong.
      const cpu = M.computeIndirectIrradianceOrder1(params, r, muS, 50, 500);
      for (let c = 0; c < 3; c++) {
        irradiance.push({
          label: `r[${ri}] muS ${muS.toFixed(3)} ch${c}`,
          cpu: cpu[c], gpu: read.value[c], err: relErr(read.value[c], cpu[c]),
        });
      }
    }

    // --- the validation sample's own margin, and the order-2+ response.
    // The ground albedo only enters at order 2 and later, through the
    // ground-reflected term of the scattering density, so a ratio of a
    // multi-order table to a one-order one is the only place it is visible.
    const v = { r: params.bottomRadius + 0.2 * (params.topRadius - params.bottomRadius), mu: 0.4, muS: 0.8, nu: 0.3 };
    const lowSun = {
      r: params.bottomRadius + 0.05 * (params.topRadius - params.bottomRadius),
      mu: 0.3, muS: 0.05, nu: 0.2,
    };
    const highSun = {
      r: params.bottomRadius + 0.02 * (params.topRadius - params.bottomRadius),
      mu: 0.5, muS: 0.9, nu: 0.4,
    };
    const sampleAt = (s) => window.__moon.atmoSample([{ kind: 'scattering', ...s, hitsGround: false, scale: 1 }])[0];
    await window.__moon.atmoBake({ orders: 1, drawsPerSlice: 1e9 });
    const single = { low: sampleAt(lowSun), high: sampleAt(highSun), validation: sampleAt(v) };
    await window.__moon.atmoBake({ orders: 4, drawsPerSlice: 1e9 });
    const four = { low: sampleAt(lowSun), high: sampleAt(highSun), validation: sampleAt(v) };
    const cpuValidation = M.computeSingleScattering(params, v.r, v.mu, v.muS, v.nu, false, 50, 500).rayleigh;

    return {
      phase, twilight, irradiance, rows,
      twilightCandidates: twilightIndices.map((t) => t.muS),
      twilightUsed: chosen.map((t) => t.muS),
      orders: {
        lowSunRatio: four.low[2] / Math.max(single.low[2], 1e-12),
        highSunRatio: four.high[2] / Math.max(single.high[2], 1e-12),
        lowSunSingleBlue: single.low[2],
        highSunSingleBlue: single.high[2],
      },
      validation: {
        cpu: cpuValidation,
        single: single.validation.slice(0, 3),
        four: four.validation.slice(0, 3),
        probeScale: tolerances.probeScale,
      },
    };
  }, { probeScale: 8 });

  console.log('');
  if (detectors.error) {
    failures.push(detectors.error);
  } else {
    const worstOf = (list) => list.reduce((a, b) => (a && a.err > b.err ? a : b), null);
    const report = (name, list, tolerance) => {
      const graded = list.filter((row) => Math.abs(row.cpu) > FLOOR_ABS);
      const worst = worstOf(graded);
      console.log(
        `  ${name.padEnd(22)} ${String(graded.length).padStart(2)}/${list.length} graded, `
        + `worst ${worst ? (worst.err * 100).toFixed(2) : '-'} % (${worst ? worst.label : '-'}: `
        + `cpu ${worst ? worst.cpu.toExponential(3) : '-'} gpu ${worst ? worst.gpu.toExponential(3) : '-'}), `
        + `tolerance ${tolerance} %`,
      );
      if (graded.length < Math.ceil(list.length / 3)) {
        failures.push(`${name}: only ${graded.length} of ${list.length} samples are above the readback floor`);
      }
      if (worst && worst.err * 100 > tolerance) {
        failures.push(`${name}: ${(worst.err * 100).toFixed(2)} % at ${worst.label} (tolerance ${tolerance} %)`);
      }
    };
    console.log('Detectors (phase functions, irradiance table, twilight band)');
    report('combined + phases', detectors.phase, PHASE_TOLERANCE_PCT);
    report('irradiance table', detectors.irradiance, IRRADIANCE_TOLERANCE_PCT);
    report('twilight (mu_s <= 0)', detectors.twilight, TWILIGHT_TOLERANCE_PCT);
    console.log(
      `  twilight mu_s         used ${detectors.twilightUsed.map((m) => m.toFixed(3)).join(', ')} `
      + `of ${detectors.twilightCandidates.map((m) => m.toFixed(3)).join(', ')}`,
    );
    if (detectors.twilightUsed.length < 2) failures.push('fewer than two twilight samples are representable');

    const o = detectors.orders;
    console.log(
      `  order response        low sun x${o.lowSunRatio.toFixed(3)} `
      + `(band ${LOW_SUN_RATIO[0]}..${LOW_SUN_RATIO[1]}), high sun x${o.highSunRatio.toFixed(3)} `
      + `(band ${HIGH_SUN_RATIO[0]}..${HIGH_SUN_RATIO[1]})`,
    );
    if (!(o.lowSunRatio >= LOW_SUN_RATIO[0] && o.lowSunRatio <= LOW_SUN_RATIO[1])) {
      failures.push(`low-sun order ratio ${o.lowSunRatio.toFixed(3)} outside ${LOW_SUN_RATIO.join('..')}`);
    }
    if (!(o.highSunRatio >= HIGH_SUN_RATIO[0] && o.highSunRatio <= HIGH_SUN_RATIO[1])) {
      failures.push(`high-sun order ratio ${o.highSunRatio.toFixed(3)} outside ${HIGH_SUN_RATIO.join('..')}`);
    }

    const val = detectors.validation;
    const ratio = (a, b) => (b === 0 ? Infinity : a / b);
    console.log(
      '  validation sample     cpu '
      + val.cpu.map((c) => c.toExponential(3)).join(' / ')
      + '  one order x' + val.single.map((s, i) => ratio(s, val.cpu[i]).toFixed(2)).join('/')
      + '  four orders x' + val.four.map((s, i) => ratio(s, val.cpu[i]).toFixed(2)).join('/'),
    );
    console.log(
      '  probe window at x' + val.probeScale + '   '
      + val.four.map((s) => (s * val.probeScale).toFixed(3)).join(' / ')
      + '  (must stay inside 0..1)',
    );
    for (let c = 0; c < 3; c++) {
      const r = ratio(val.four[c], val.cpu[c]);
      if (!(r >= VALIDATION_BAND[0] && r <= VALIDATION_BAND[1])) {
        failures.push(`validation sample channel ${c} at x${r.toFixed(2)} of the reference, outside the accepted ${VALIDATION_BAND.join('..')}`);
      }
      if (val.four[c] * val.probeScale >= 0.999) {
        failures.push(`validation sample channel ${c} clips the probe window at scale ${val.probeScale}`);
      }
    }
  }

  if (result.failures?.length) {
    for (const row of result.failures) {
      console.log(`  FAIL ${row.table} ${row.label}: cpu ${row.cpu.toExponential(4)} gpu ${row.gpu.toExponential(4)} err ${(row.err * 100).toFixed(2)} %`);
    }
    failures.push(`${result.failures.length}+ samples outside ${tolerancePct} %`);
  }

  if (!skipLadder) {
    console.log('');
    console.log('Bake ladder (one-shot, wall time includes the validating readback)');
    const ladder = [
      { name: 'full tables, 4 orders', options: { orders: 4, drawsPerSlice: 1e9 } },
      { name: 'full tables, 2 orders', options: { orders: 2, drawsPerSlice: 1e9 } },
      // The first half-size rung pays the program links its defines need; the
      // second is the same work with a warm cache.
      { name: 'half tables, 2 orders (cold links)', options: { orders: 2, half: true, drawsPerSlice: 1e9 } },
      { name: 'half tables, 2 orders (warm)', options: { orders: 2, half: true, drawsPerSlice: 1e9 } },
      { name: 'full tables, 4 orders, sliced 8/frame', options: { orders: 4 } },
      { name: 'half tables, 2 orders, sliced 8/frame', options: { orders: 2, half: true } },
    ];
    for (const rung of ladder) {
      const stats = await page.evaluate((options) => window.__moon.atmoBake(options), rung.options);
      if (!stats) { failures.push(`${rung.name}: no stats`); continue; }
      if (!stats.validated) failures.push(`${rung.name}: validation failed`);
      const mib = (b) => (b / (1024 * 1024)).toFixed(2);
      console.log(
        `  ${rung.name.padEnd(38)} ${stats.wallMs.toFixed(0).padStart(6)} ms wall  `
        + `${stats.submitMs.toFixed(0).padStart(5)} ms submit  ${String(stats.drawCalls).padStart(4)} draws  `
        + `${String(stats.slices).padStart(4)} slices  links ${stats.programsBefore}→${stats.programsAfter}  `
        + `peak ${mib(stats.peakBytes)} MiB  resident ${mib(stats.residentBytes)} MiB`,
      );
    }
  }

  // The CPU reference can only see single scattering, so the one part of the
  // pipeline it cannot check is whether the further orders accumulate at all.
  // Same sample, one order against four: the difference IS the twilight.
  const orders = await page.evaluate(async () => {
    const M = await import('/src/planetarium/world/atmosphereModel.ts');
    const params = M.atmosphereParams('Earth');
    // A sky ray low over the ground with the Sun near the horizon — where
    // multiple scattering is most of the light.
    const sample = {
      kind: 'scattering',
      r: params.bottomRadius + 0.05 * (params.topRadius - params.bottomRadius),
      mu: 0.3, muS: 0.05, nu: 0.2, hitsGround: false, scale: 1,
    };
    const read = async (n) => {
      const stats = await window.__moon.atmoBake({ orders: n, drawsPerSlice: 1e9 });
      // A bake that did not validate leaves no tables to sample; say so rather
      // than reading null.
      const values = stats && stats.validated ? window.__moon.atmoSample([sample]) : null;
      return values ? values[0] : null;
    };
    return { one: await read(1), four: await read(4) };
  });
  console.log('');
  if (!orders.one || !orders.four) {
    console.log('multi-order    no validated table to sample');
    failures.push('the multi-order comparison had no validated table to sample');
  } else {
    const ratio = orders.four[2] / Math.max(orders.one[2], 1e-9);
    console.log(`multi-order    blue single ${orders.one[2].toExponential(3)} \u2192 four orders ${orders.four[2].toExponential(3)} (\u00d7${ratio.toFixed(2)})`);
    if (!(ratio > 1.05)) failures.push(`orders 2..4 add nothing (ratio ${ratio.toFixed(3)})`);
  }

  const finalState = await page.evaluate(() => window.__moon.atmoState());
  console.log('');
  console.log(`tier state     ${finalState?.state}`);
  console.log(`programs       ${finalState?.programs}`);
  if (errors.length) {
    for (const error of errors.slice(0, 10)) console.log(`  console error: ${error}`);
    failures.push(`${errors.length} page errors`);
  }
  // One app tab at a time: the second context would be a second live WebGL
  // context competing with this one's render loop.
  await page.close();

  // The QA path must have no tables at all: the analytic shell is the whole
  // look there, and a tier that came up anyway would hide that.
  const noFloatPage = await context.newPage();
  await noFloatPage.goto(`${baseUrl}/?auto=planetarium&nofloat=1`, { waitUntil: 'domcontentloaded' });
  await noFloatPage.waitForFunction(
    () => !!(window.__moon && window.__moon.ready && window.__moon.ready()),
    { timeout: 90000 },
  );
  const noFloat = await noFloatPage.evaluate(async () => {
    await window.__moon.atmoBake({ orders: 1, drawsPerSlice: 1e9 });
    const s = window.__moon.atmoState();
    return { capability: s.capability, state: s.state, bakes: s.stats.length };
  });
  console.log(`?nofloat=1     capability ${noFloat.capability}, state ${noFloat.state}, bakes ${noFloat.bakes}`);
  if (noFloat.capability !== false || noFloat.state !== 'unavailable') {
    failures.push('?nofloat=1 did not force the LUT tier off');
  }
  await noFloatPage.close();

  // A context lost DURING the first bake must not cost the session its tier.
  // The restore re-bakes every body that was ASKED for, and while the first
  // bake is in flight nothing has finished yet, so a restore that re-baked only
  // finished bodies would re-bake nothing and nothing would ask again.
  const lossPage = await context.newPage();
  await lossPage.goto(`${baseUrl}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
  await lossPage.waitForFunction(
    () => !!(window.__moon && window.__moon.ready && window.__moon.ready()),
    { timeout: 90000 },
  );
  const loss = await lossPage.evaluate(async () => {
    const state = () => window.__moon.atmoState();
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    let caughtBaking = false;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const s = state();
      if (s && s.state === 'baking') { caughtBaking = true; break; }
      if (s && s.state === 'ready') break;
      await frame();
    }
    const validatedBefore = state().stats.filter((row) => row.validated).length;
    const gl = document.querySelector('canvas').getContext('webgl2');
    const ext = gl.getExtension('WEBGL_lose_context');
    ext.loseContext();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const during = state();
    ext.restoreContext();
    const readyBy = Date.now() + 40000;
    while (Date.now() < readyBy) {
      if (state().state === 'ready') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const after = state();
    return {
      caughtBaking,
      validatedBefore,
      during: { state: during.state, capability: during.capability, bakes: during.stats.length },
      after: {
        state: after.state,
        capability: after.capability,
        bakes: after.stats.length,
        aborted: after.stats.filter((row) => row.aborted).length,
        validated: after.stats.filter((row) => row.validated).length,
      },
    };
  });
  console.log('');
  console.log(
    `context loss   caught the bake in flight: ${loss.caughtBaking}; during loss `
    + `${loss.during.state} (bakes ${loss.during.bakes}, validated before the loss `
    + `${loss.validatedBefore}); after restore ${loss.after.state} `
    + `(bakes ${loss.after.bakes}, aborted ${loss.after.aborted}, validated ${loss.after.validated})`,
  );
  if (!loss.caughtBaking) failures.push('never caught the first bake in flight, so the loss did not land mid-bake');
  // The point of the scenario is a loss with NOTHING baked yet: a restore that
  // re-baked only finished bodies would re-bake nothing here.
  if (loss.validatedBefore !== 0) failures.push('a bake had already validated before the loss, so the first-bake window was missed');
  if (loss.during.state !== 'unavailable') failures.push('the tier survived a lost context');
  if (loss.after.state !== 'ready') failures.push('the tier did not come back after the context was restored');
  if (!(loss.after.bakes >= 2)) failures.push(`only ${loss.after.bakes} bake(s) recorded across the loss`);
  await lossPage.close();
  await context.close();
} finally {
  await browser.close();
}

if (failures.length) {
  console.log('');
  for (const failure of failures) console.log(`FAIL ${failure}`);
  process.exit(1);
}
console.log('\nPASS');
