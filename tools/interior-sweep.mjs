// The Look-inside battery (plan §11): drives the tool through the dev bridge
// and asserts what a reader relies on — the legend matches the drawn model,
// the inspector says what the model says, a hover across the section
// resolves regions in order even mid-animation of the Readable remap, a
// model switch adds and removes rows, a region with an unknown temperature
// is hatched and never coloured, an uncertain boundary carries its band, and
// every render path draws the disc — then writes a capture per body × view ×
// mode for a look. Runs at desktop and 390×844 by default.
//
// Prereq: npm run dev (port 5173)
//   node tools/interior-sweep.mjs
//   node tools/interior-sweep.mjs --bodies=Earth,Europa --viewport=desktop --out=planning/interior-sweep
//   node tools/interior-sweep.mjs --paths=0            # skip the render-path cases
//
// Frame delivery is tools/smoothness-gate.mjs's job, not this one's; on a
// software GPU the numbers here would mean nothing.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decodePng } from './pngDecode.mjs';
import { takeBrowserLock } from './browserLock.mjs';

function arg(name, fallback) {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

const baseUrl = arg('url', 'http://localhost:5173');
const outDir = arg('out', 'planning/interior-sweep');
const bodies = arg('bodies', 'Earth,Moon,Europa,Jupiter,Mars,Phobos,Mercury').split(',').filter(Boolean);
const viewportChoice = arg('viewport', 'both');
const runPaths = arg('paths', '1') !== '0';
await mkdir(outDir, { recursive: true });

const VIEWPORTS = [
  { name: 'desktop', width: 1400, height: 800 },
  { name: 'phone', width: 390, height: 844 },
].filter((viewport) => viewportChoice === 'both' || viewport.name === viewportChoice);
const VIEWS = ['closed', 'cutaway', 'section'];
const MODES = ['composition', 'temperature'];
const PATHS = [
  { name: 'composer', query: '' },
  { name: 'msaa0', query: '&msaa=0' },
  { name: 'nofloat', query: '&nofloat=1' },
];

const failures = [];
const notes = [];
function check(condition, message) {
  if (condition) return true;
  failures.push(message);
  console.log(`  FAIL ${message}`);
  return false;
}

const release = await takeBrowserLock('interior-sweep');
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader',
    ...(process.env.PW_SOFTWARE ? ['--use-angle=swiftshader'] : []),
    ...(process.env.PW_NO_SANDBOX ? ['--no-sandbox'] : [])],
});

function luminance(pixels, channels, index) {
  const offset = index * channels;
  return 0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2];
}

/** Mean and standard deviation of luminance in a block of a decoded screenshot. */
function blockStats(image, x0, y0, size) {
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  let max = 0;
  for (let y = y0; y < y0 + size; y++) {
    for (let x = x0; x < x0 + size; x++) {
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
      const value = luminance(image.pixels, image.channels, y * image.width + x);
      sum += value;
      sumSquares += value * value;
      max = Math.max(max, value);
      count++;
    }
  }
  const mean = count ? sum / count : 0;
  const variance = count ? sumSquares / count - mean * mean : 0;
  return { mean, std: Math.sqrt(Math.max(0, variance)), max, count };
}

async function openTool(context, body, query = '') {
  const page = await context.newPage();
  page.setDefaultTimeout(240000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error).slice(0, 300)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text().slice(0, 300)); });
  await page.goto(`${baseUrl}/?auto=interior&body=${body}${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.interiorReady && window.__moon.interiorReady()), undefined, { timeout: 240000 });
  return { page, errors };
}

const settle = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
/** Run `capture` with the depth ruler hidden: it draws its line through the disc centre and along the
 *  face, so a pixel read of the face steps it aside (visibility, which the ruler's own display toggle
 *  leaves alone). The saved captures keep it. */
async function withoutRuler(page, capture) {
  await page.evaluate(() => { document.getElementById('interior-ruler').style.visibility = 'hidden'; });
  await settle(page);
  try {
    return await capture();
  } finally {
    await page.evaluate(() => { document.getElementById('interior-ruler').style.visibility = ''; });
  }
}
async function ready(page) {
  await page.waitForFunction(() => window.__moon.interiorReady(), undefined, { timeout: 120000 });
  await page.evaluate(() => { window.__moon.interiorTime(12); window.__moon.interiorFreeze(true); });
  await page.waitForTimeout(250);
  await settle(page);
}
const state = (page) => page.evaluate(() => window.__moon.interiorState());
const legendRegions = (page) => page.evaluate(() => [...document.querySelectorAll('#interior-legend .interior-row')].map((row) => row.dataset.region));

/** The disc centre in client px: the body sits at the origin; project it. */
async function discCentre(page, viewport) {
  const shift = viewport.width <= 640 ? Math.round(viewport.height * 0.17) : 0;
  return { x: viewport.width / 2, y: viewport.height / 2 - shift };
}

async function sweepBody(context, viewport, body) {
  const tag = `${viewport.name}/${body}`;
  console.log(`\n== ${tag}`);
  const { page, errors } = await openTool(context, body);
  await ready(page);
  const initial = await state(page);
  const regionKeys = initial.regions.map((region) => region.key);

  // 0. The body that opened is the one asked for: an unknown name falls back to the default with only a warning.
  check(initial.bodyId === body, `${tag}: opened ${initial.bodyId || '(nothing)'} when ${body} was asked for`);

  // 1. The legend is the drawn model, outside-in.
  const rows = await legendRegions(page);
  check(rows.length === regionKeys.length, `${tag}: legend has ${rows.length} rows for ${regionKeys.length} regions`);
  check(rows.slice().reverse().join(',') === regionKeys.join(','), `${tag}: legend rows ${rows} are not the regions ${regionKeys} outside-in`);

  // 2. The pinned inspector says what the model says.
  for (const key of regionKeys) {
    await page.evaluate((regionKey) => window.__moon.interiorPin(regionKey), key);
    await settle(page);
    const shown = await page.evaluate(() => ({ name: document.querySelector('#interior-inspector .ii-name')?.textContent ?? '', text: document.getElementById('interior-inspector')?.textContent ?? '' }));
    const region = initial.regions.find((entry) => entry.key === key);
    check(shown.name === region.name, `${tag}: pinned ${key} shows "${shown.name}", expected "${region.name}"`);
    const pinned = (await state(page)).pinned;
    check(pinned === key, `${tag}: interiorState.pinned is ${pinned} after pinning ${key}`);
  }
  await page.evaluate(() => window.__moon.interiorPin(null));

  // 3. A hover sweep across the section resolves regions in order outward
  // from the centre, at rest and mid-blend. Both directions: at Section the
  // wedge yaw has tapered to none and the disc is face-on, so both sides
  // must show every region out to the rim.
  await page.evaluate(() => window.__moon.interiorView('section'));
  await ready(page);
  const centre = await discCentre(page, viewport);
  const radiusPx = (await state(page)).projectedRadiusPx;
  for (const blend of [1, 0.5, 0]) {
    await page.evaluate((value) => window.__moon.interiorScale('readable', value), blend);
    await settle(page);
    const seen = [];
    for (const direction of [-1, 1]) {
      let previousIndex = -1;
      let monotone = true;
      for (let dx = 0; dx <= radiusPx + 4; dx += 2) {
        const hit = await page.evaluate(([x, y]) => window.__moon.interiorHover(x, y), [centre.x + direction * dx, centre.y]);
        if (!hit || hit.surface === 'skin') continue;
        const index = regionKeys.indexOf(hit.regionKey);
        if (index < previousIndex) monotone = false;
        previousIndex = Math.max(previousIndex, index);
        if (!seen.includes(hit.regionKey)) seen.push(hit.regionKey);
      }
      check(monotone, `${tag}: hover regions are not in order outward (${direction < 0 ? 'left' : 'right'}) at blend ${blend}`);
    }
    if (blend === 1) {
      check(seen.length === regionKeys.length, `${tag}: at Readable, the sweep reached ${seen.length} of ${regionKeys.length} regions (${seen})`);
    }
  }
  await page.evaluate(() => window.__moon.interiorScale('readable'));
  await page.evaluate(() => window.__moon.interiorHover(-1, -1));

  // 4. A model switch adds and removes rows.
  const coverage = initial.coverage;
  if (coverage === 'competing' || (coverage === 'poorlyConstrained' && await page.evaluate(() => document.querySelectorAll('#interior-models .interior-model').length) > 0)) {
    const buttons = await page.evaluate(() => [...document.querySelectorAll('#interior-models .interior-model')].map((button) => button.dataset.modelId));
    check(buttons.length >= 2, `${tag}: model switch has ${buttons.length} choices`);
    for (const modelId of buttons) {
      const switched = await page.evaluate((id) => window.__moon.interiorModel(id === '' ? null : id), modelId);
      check(switched, `${tag}: interiorModel(${modelId || 'null'}) refused`);
      await ready(page);
      const after = await state(page);
      const afterRows = await legendRegions(page);
      check(afterRows.length === after.regions.length, `${tag}/${modelId}: legend has ${afterRows.length} rows for ${after.regions.length} regions`);
      check((after.modelId ?? '') === modelId, `${tag}: drawn model is ${after.modelId} after switching to ${modelId || 'null'}`);
    }
    await page.evaluate((id) => window.__moon.interiorModel(id), initial.modelId);
    await ready(page);
  }

  // 5. Captures: every view × mode, plus the pixel checks in Temperature mode.
  for (const mode of MODES) {
    await page.evaluate((value) => window.__moon.interiorMode(value), mode);
    for (const view of VIEWS) {
      await page.evaluate((value) => window.__moon.interiorView(value), view);
      await ready(page);
      const file = path.join(outDir, `${viewport.name}-${body}-${view}-${mode}.png`);
      await page.screenshot({ path: file, type: 'png' });
      if (view === 'section' && mode === 'temperature') {
        const image = decodePng(await withoutRuler(page, () => page.screenshot({ type: 'png' })));
        const scale = image.width / viewport.width;
        const innermost = initial.regions[0];
        const innerPx = innermost.displayOuter * radiusPx * scale;
        const size = Math.max(6, Math.min(24, Math.floor(innerPx * 0.5)));
        const centreBlock = blockStats(image, Math.round(centre.x * scale - size / 2), Math.round(centre.y * scale - size / 2), size);
        const unknown = initial.temperatureRange === null || (await page.evaluate(() => document.querySelector('#interior-legend .interior-row:last-child .interior-swatch')?.classList.contains('hatched')));
        if (unknown) {
          // The hatch: grey (its light stripe is 0.15 linear, about 110 in sRGB,
          // well under any warm scale colour) and striped, a standard
          // deviation a flat tone cannot have.
          check(centreBlock.max < 150, `${tag}: unknown temperature at the centre is not the grey hatch (max luminance ${centreBlock.max.toFixed(0)})`);
          check(centreBlock.std > 4, `${tag}: unknown temperature at the centre is not hatched (std ${centreBlock.std.toFixed(1)})`);
        } else {
          check(centreBlock.mean > 40, `${tag}: the known centre temperature is not drawn (mean luminance ${centreBlock.mean.toFixed(0)})`);
        }
        notes.push(`${tag} temperature centre: mean ${centreBlock.mean.toFixed(0)} std ${centreBlock.std.toFixed(1)} max ${centreBlock.max.toFixed(0)}`);
      }
    }
  }
  await page.evaluate(() => window.__moon.interiorMode('composition'));

  check(errors.length === 0, `${tag}: page errors: ${errors.join(' | ')}`);
  await page.close();
}

/** Europa's core boundary is a model spread of 300–700 km: the band must be there in Temperature mode. */
async function bandCase(context, viewport) {
  const tag = `${viewport.name}/Europa band`;
  console.log(`\n== ${tag}`);
  const { page, errors } = await openTool(context, 'Europa');
  await page.evaluate(() => { window.__moon.interiorView('section'); window.__moon.interiorMode('temperature'); window.__moon.interiorScale('true', 0); });
  await ready(page);
  const current = await state(page);
  const centre = await discCentre(page, viewport);
  const radiusPx = current.projectedRadiusPx;
  const reference = 1560.8;
  const image = decodePng(await withoutRuler(page, () => page.screenshot({ type: 'png' })));
  const scale = image.width / viewport.width;
  // True scale: display radius = physical radius. In the band (300–700 km) versus above it (800–1400 km).
  const inBandR = ((500 / reference) * radiusPx) * scale;
  const outBandR = ((1000 / reference) * radiusPx) * scale;
  const size = 14;
  const inBand = blockStats(image, Math.round(centre.x * scale + inBandR - size / 2), Math.round(centre.y * scale - size / 2), size);
  const outBand = blockStats(image, Math.round(centre.x * scale + outBandR - size / 2), Math.round(centre.y * scale - size / 2), size);
  notes.push(`${tag}: in-band std ${inBand.std.toFixed(2)} out-of-band std ${outBand.std.toFixed(2)}`);
  check(inBand.std > outBand.std * 2.5 && inBand.std > 3, `${tag}: no hatched band where the boundary is uncertain (std ${inBand.std.toFixed(2)} in, ${outBand.std.toFixed(2)} out)`);
  await page.screenshot({ path: path.join(outDir, `${viewport.name}-Europa-band-true-temperature.png`) });
  check(errors.length === 0, `${tag}: page errors: ${errors.join(' | ')}`);
  await page.close();
}

/** Each render path draws the disc in both modes and reports itself. */
async function pathCases(context, viewport) {
  for (const renderPath of PATHS) {
    const tag = `${viewport.name}/Earth ${renderPath.name}`;
    console.log(`\n== ${tag}`);
    const { page, errors } = await openTool(context, 'Earth', renderPath.query);
    await page.evaluate(() => window.__moon.interiorView('section'));
    await ready(page);
    const reported = await page.evaluate(() => window.__moon.renderPath());
    notes.push(`${tag}: renderPath ${JSON.stringify(reported)}`);
    if (renderPath.name === 'nofloat') check(reported.composer === false, `${tag}: expected the direct path, got ${JSON.stringify(reported)}`);
    if (renderPath.name === 'msaa0') check(reported.composer === true && reported.sceneTargetSamples === 0, `${tag}: expected the composer with 0 samples, got ${JSON.stringify(reported)}`);
    const centre = await discCentre(page, viewport);
    for (const mode of MODES) {
      await page.evaluate((value) => window.__moon.interiorMode(value), mode);
      await ready(page);
      await page.screenshot({ path: path.join(outDir, `${viewport.name}-Earth-section-${mode}-${renderPath.name}.png`), type: 'png' });
      const image = decodePng(await withoutRuler(page, () => page.screenshot({ type: 'png' })));
      const scale = image.width / viewport.width;
      const block = blockStats(image, Math.round(centre.x * scale - 8), Math.round(centre.y * scale - 8), 16);
      check(block.mean > 40, `${tag}/${mode}: the disc centre is dark (mean ${block.mean.toFixed(0)})`);
    }
    check(errors.length === 0, `${tag}: page errors: ${errors.join(' | ')}`);
    await page.close();
  }
}

try {
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 });
    // A clean boot per page: the saved journey lives in localStorage AND the
    // store's IndexedDB, and a page that finds one asks whether to resume —
    // a prompt the ?auto= entry waits on, which is a hang in a battery.
    await context.addInitScript(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
        indexedDB.deleteDatabase('orbital-sim-storage');
        localStorage.setItem('planetarium-help-seen', '1');
        localStorage.setItem('planetarium-surface-hint-seen', '1');
      } catch {}
    });
    for (const body of bodies) await sweepBody(context, viewport, body);
    if (bodies.includes('Europa')) await bandCase(context, viewport);
    if (runPaths && viewport.name === 'desktop') await pathCases(context, viewport);
    await context.close();
  }
} finally {
  await browser.close();
  await release();
}

await writeFile(path.join(outDir, 'summary.json'), JSON.stringify({ failures, notes }, null, 2));
console.log('\n' + notes.join('\n'));
if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\ninterior-sweep: all checks passed');
