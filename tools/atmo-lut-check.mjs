// Asserting GPU check for the precomputed atmosphere tables: bakes them on the
// real GPU, reads samples back through the 8-bit blit path at 16-bit precision,
// and compares them against the CPU reference integrator in
// src/planetarium/world/atmosphereModel.ts. Also reports the numbers commit 1
// is accepted on — bake wall time, draw count, program links, peak bytes.
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
    // Optical depth reaches ~24 on a horizon path; single-scattering radiance
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
  console.log(`  samples compared   ${result.compared} (${result.skippedBelowFloor} below the readback floor)`);
  console.log(`  mean relative err  ${result.meanErrPct?.toFixed(3)} %`);
  console.log(`  worst relative err ${result.worstErrPct?.toFixed(3)} % ${result.worst ? `(${result.worst.table} ${result.worst.label}: cpu ${result.worst.cpu.toExponential(4)} vs gpu ${result.worst.gpu.toExponential(4)})` : ''}`);
  if (process.argv.includes('--dump')) {
    const sorted = [...result.all].sort((a, b) => b.err - a.err);
    for (const row of sorted) {
      console.log(`  ${row.err > 0.02 ? '!' : ' '} ${(row.err * 100).toFixed(2).padStart(8)} %  ${row.table.padEnd(14)} ${row.label.padEnd(28)} cpu ${row.cpu.toExponential(4)}  gpu ${row.gpu.toExponential(4)}`);
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
      await window.__moon.atmoBake({ orders: n, drawsPerSlice: 1e9 });
      return window.__moon.atmoSample([sample])[0];
    };
    return { one: await read(1), four: await read(4) };
  });
  const ratio = orders.four[2] / Math.max(orders.one[2], 1e-9);
  console.log('');
  console.log(`multi-order    blue single ${orders.one[2].toExponential(3)} \u2192 four orders ${orders.four[2].toExponential(3)} (\u00d7${ratio.toFixed(2)})`);
  if (!(ratio > 1.05)) failures.push(`orders 2..4 add nothing (ratio ${ratio.toFixed(3)})`);

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
