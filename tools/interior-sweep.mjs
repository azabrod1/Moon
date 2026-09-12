// The Look-inside battery (plan §11): drives the tool through the dev bridge
// and asserts what a reader relies on — the legend matches the drawn model,
// the inspector says what the model says, a hover across the section
// resolves regions in order even mid-animation of the Readable remap, a
// model switch adds and removes rows, a region with an unknown temperature
// is hatched and never coloured, an uncertain boundary carries its band, and
// every render path draws the disc — then writes a capture per body × view ×
// mode for a look. Runs at desktop and 390×844 by default.
//
// The opt-in lifecycle scenario (--scenario=lifecycle) drives the tool's
// ceremonies through their races instead: a rapid double pick, a pick during
// the reveal and during the cross-fade, the Esc cascade with the picker and
// the evidence popover closing each other, prefers-reduced-motion (every
// move lands at once), the phone's docked inspector, and interiorReady()
// against a colour map held back past the loader's timeout (the tool shows
// the loader's fallback, and must not call itself ready until the real map
// lands). Each case asserts the tool ends sane: a skin on, the cut open at
// the chosen angle, interiorReady() true, the legend the drawn model, no
// page errors.
//
// Prereq: npm run dev (port 5173)
//   node tools/interior-sweep.mjs
//   node tools/interior-sweep.mjs --bodies=Earth,Europa --viewport=desktop --out=planning/interior-sweep
//   node tools/interior-sweep.mjs --paths=0            # skip the render-path cases
//   node tools/interior-sweep.mjs --scenario=lifecycle # the ceremonies' races instead of the sweep
//   node tools/interior-sweep.mjs --scenario=sweep,lifecycle
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
const scenarios = arg('scenario', 'sweep').split(',').filter(Boolean);
const runSweep = scenarios.includes('sweep');
const runLifecycle = scenarios.includes('lifecycle');
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

/** Open the tool on a body in a fresh page. `reducedMotion` emulates the
 *  media query before the app boots, so the tool reads it from its first frame. */
async function openTool(context, body, query = '', { reducedMotion = false } = {}) {
  const page = await context.newPage();
  page.setDefaultTimeout(240000);
  if (reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' });
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

// ---- the lifecycle scenario ---------------------------------------------------

/** The opening the tool chooses for itself on a viewport: Section on a phone, Cutaway elsewhere. */
const chosenAngleDeg = (viewport) => (viewport.width <= 640 ? 180 : 90);

async function waitReady(page, timeout = 120000) {
  await page.waitForFunction(() => window.__moon.interiorReady(), undefined, { timeout });
}

/** Wait for the tool to be ready and assert it ended where a reader expects: the body asked
 *  for, a skin on it, the cut open at the chosen angle, the legend the drawn model. */
async function saneEnd(page, tag, { body, angleDeg }) {
  await waitReady(page);
  const current = await state(page);
  check(current.bodyId === body, `${tag}: ends on ${current.bodyId || '(nothing)'}, expected ${body}`);
  check(current.skin === true, `${tag}: no skin on the body at the end`);
  check(current.ready === true, `${tag}: interiorReady() is false at the end`);
  check(current.loading === false, `${tag}: still loading at the end`);
  check(Math.abs(current.openingAngleDeg - angleDeg) < 0.5, `${tag}: the cut is open at ${current.openingAngleDeg.toFixed(1)}°, expected ${angleDeg}°`);
  check(current.regions.length > 0, `${tag}: no regions drawn`);
  const rows = await legendRegions(page);
  check(rows.length === current.regions.length, `${tag}: legend has ${rows.length} rows for ${current.regions.length} regions`);
  return current;
}

/** Two picks in one task: the first is superseded before its map lands; the second is what the tool ends on. */
async function rapidDoublePickCase(context, viewport) {
  const tag = `${viewport.name}/lifecycle rapid double pick`;
  console.log(`\n== ${tag}`);
  const { page, errors } = await openTool(context, 'Earth');
  await page.evaluate(() => { window.__moon.interiorPick('Mars'); window.__moon.interiorPick('Europa'); });
  await saneEnd(page, tag, { body: 'Europa', angleDeg: chosenAngleDeg(viewport) });
  check(errors.length === 0, `${tag}: page errors: ${errors.join(' | ')}`);
  await page.close();
}

/** A pick while the previous swap's reveal is still opening the cut. */
async function pickDuringRevealCase(context, viewport) {
  const tag = `${viewport.name}/lifecycle pick during the reveal`;
  console.log(`\n== ${tag}`);
  const { page, errors } = await openTool(context, 'Earth');
  await page.evaluate(() => window.__moon.interiorPick('Mars'));
  // The reveal: Mars is on, the load is done, and the cut is still on its way open.
  await page.waitForFunction(() => {
    const current = window.__moon.interiorState();
    return current.bodyId === 'Mars' && !current.loading && current.openingAngleDeg < current.targetAngleDeg - 5;
  }, undefined, { timeout: 120000 });
  await page.evaluate(() => window.__moon.interiorPick('Moon'));
  await saneEnd(page, tag, { body: 'Moon', angleDeg: chosenAngleDeg(viewport) });
  check(errors.length === 0, `${tag}: page errors: ${errors.join(' | ')}`);
  await page.close();
}

/** A pick while the previous swap's cross-fade runs behind the closed cut. */
async function pickDuringFadeCase(context, viewport) {
  const tag = `${viewport.name}/lifecycle pick during the fade`;
  console.log(`\n== ${tag}`);
  const { page, errors } = await openTool(context, 'Earth');
  await page.evaluate(() => window.__moon.interiorPick('Mars'));
  // The fade: the body has turned over (Mars is on) but the commit is still loading, i.e. fading.
  await page.waitForFunction(() => {
    const current = window.__moon.interiorState();
    return current.bodyId === 'Mars';
  }, undefined, { timeout: 120000 });
  const during = await state(page);
  notes.push(`${tag}: second pick made with loading=${during.loading} angle=${during.openingAngleDeg.toFixed(1)}`);
  await page.evaluate(() => window.__moon.interiorPick('Saturn'));
  const end = await saneEnd(page, tag, { body: 'Saturn', angleDeg: chosenAngleDeg(viewport) });
  check(end.rings === true, `${tag}: Saturn's rings are ${end.rings}, expected on`);
  check(errors.length === 0, `${tag}: page errors: ${errors.join(' | ')}`);
  await page.close();
}

/** Esc closes one thing at a time — the popover, the picker, the pin, then the tool — and
 *  the picker and the popover close each other. */
async function escCascadeCase(context, viewport) {
  const tag = `${viewport.name}/lifecycle Esc cascade`;
  console.log(`\n== ${tag}`);
  const { page, errors } = await openTool(context, 'Earth');
  const pickerOpen = () => page.evaluate(() => document.getElementById('interior-picker').classList.contains('visible'));
  const evidenceOpen = () => page.evaluate(() => document.getElementById('interior-evidence').classList.contains('visible'));
  await page.evaluate(() => window.__moon.interiorPin('outerCore'));
  check((await state(page)).pinned === 'outerCore', `${tag}: pin refused`);
  check(await page.evaluate(() => window.__moon.interiorEvidence('existence')), `${tag}: evidence refused`);
  check(await evidenceOpen(), `${tag}: the popover did not open`);
  // Opening the picker closes the popover.
  check(await page.evaluate(() => window.__moon.interiorPickerOpen()), `${tag}: picker refused`);
  check(await pickerOpen(), `${tag}: the picker did not open`);
  check(!(await evidenceOpen()) && (await state(page)).evidence === null, `${tag}: the popover stayed open under the picker`);
  // Opening the popover closes the picker.
  check(await page.evaluate(() => window.__moon.interiorEvidence('existence')), `${tag}: evidence refused with the picker open`);
  check(await evidenceOpen() && !(await pickerOpen()), `${tag}: the picker stayed open under the popover`);
  // The cascade.
  await page.evaluate(() => window.__moon.interiorEsc());
  let current = await state(page);
  check(!(await evidenceOpen()) && current.evidence === null && current.pinned === 'outerCore', `${tag}: the first Esc did not close only the popover`);
  await page.evaluate(() => window.__moon.interiorPickerOpen());
  await page.evaluate(() => window.__moon.interiorEsc());
  current = await state(page);
  check(!(await pickerOpen()) && current.pinned === 'outerCore', `${tag}: the second Esc did not close only the picker`);
  await page.evaluate(() => window.__moon.interiorEsc());
  current = await state(page);
  check(current.pinned === null, `${tag}: the third Esc did not unpin`);
  await page.evaluate(() => window.__moon.interiorEsc());
  await page.waitForFunction(() => document.getElementById('interior-ui').style.display === 'none', undefined, { timeout: 60000 });
  await settle(page);
  current = await state(page);
  check(current.ready === false, `${tag}: the tool still reports ready after leaving`);
  check(errors.length === 0, `${tag}: page errors: ${errors.join(' | ')}`);
  await page.close();
}

/** Under prefers-reduced-motion every move lands at once: a view change, the Readable morph, a swap. */
async function reducedMotionCase(context, viewport) {
  const tag = `${viewport.name}/lifecycle reduced motion`;
  console.log(`\n== ${tag}`);
  const { page, errors } = await openTool(context, 'Earth', '', { reducedMotion: true });
  check(await page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches), `${tag}: the media query is not emulated`);
  await page.evaluate(() => window.__moon.interiorView('section'));
  await settle(page);
  let current = await state(page);
  check(Math.abs(current.openingAngleDeg - 180) < 0.01, `${tag}: Section is at ${current.openingAngleDeg.toFixed(1)}° three frames after the view change; it should land at once`);
  // The Readable toggle through the DOM, the way a reader reaches it: the morph must not ease.
  await page.evaluate(() => { const toggle = document.getElementById('interior-readable-toggle'); toggle.checked = false; toggle.dispatchEvent(new Event('change')); });
  await settle(page);
  current = await state(page);
  check(current.readable === false && current.scaleBlend === 0, `${tag}: the Readable morph is at ${current.scaleBlend} three frames after the toggle; it should land at once`);
  await page.evaluate(() => { const toggle = document.getElementById('interior-readable-toggle'); toggle.checked = true; toggle.dispatchEvent(new Event('change')); });
  await settle(page);
  check((await state(page)).scaleBlend === 1, `${tag}: the Readable morph did not land at once on the way back`);
  await page.evaluate(() => window.__moon.interiorPick('Mars'));
  await saneEnd(page, tag, { body: 'Mars', angleDeg: 180 });
  check(errors.length === 0, `${tag}: page errors: ${errors.join(' | ')}`);
  await page.close();
}

/** The pinned inspector docks under the legend in the sheet on a phone, and stands alone on desktop. */
async function dockedInspectorCase(context, viewport) {
  const tag = `${viewport.name}/lifecycle docked inspector`;
  console.log(`\n== ${tag}`);
  const { page, errors } = await openTool(context, 'Earth');
  await page.evaluate(() => window.__moon.interiorPin('outerCore'));
  await settle(page);
  const inspector = await page.evaluate(() => {
    const root = document.getElementById('interior-inspector');
    return { docked: root.classList.contains('docked'), parent: root.parentElement?.id ?? '', display: getComputedStyle(root).display, name: root.querySelector('.ii-name')?.textContent ?? '' };
  });
  const phone = viewport.width <= 640;
  check(inspector.display !== 'none', `${tag}: the inspector is hidden after a pin`);
  check(inspector.name === 'Outer core', `${tag}: the inspector shows "${inspector.name}"`);
  check(inspector.docked === phone, `${tag}: docked=${inspector.docked} on a ${phone ? 'phone' : 'desktop'} viewport`);
  check(inspector.parent === (phone ? 'interior-panel' : 'interior-ui'), `${tag}: the inspector sits in #${inspector.parent}`);
  check(errors.length === 0, `${tag}: page errors: ${errors.join(' | ')}`);
  await page.close();
}

/** A colour map held past the loader's timeout: the tool presents the loader's fallback and must
 *  not call itself ready until the real map lands through the late slot. */
async function lateMapCase(context, viewport) {
  const tag = `${viewport.name}/lifecycle late map`;
  console.log(`\n== ${tag}`);
  const { page, errors } = await openTool(context, 'Earth');
  const held = [];
  const marsMap = '**/textures/mars.v2.webp';
  await page.route(marsMap, (route) => { held.push(route); });
  await page.evaluate(() => window.__moon.interiorPick('Mars'));
  // The loader gives the fallback after its timeout (8 s) and the swap completes on it.
  await page.waitForFunction(() => {
    const current = window.__moon.interiorState();
    return current.bodyId === 'Mars' && !current.loading && Math.abs(current.openingAngleDeg - current.targetAngleDeg) < 0.01;
  }, undefined, { timeout: 90000 });
  await settle(page);
  const onFallback = await state(page);
  check(onFallback.skin === true, `${tag}: no skin on Mars while the map is held`);
  check(onFallback.ready === false, `${tag}: interiorReady() is true while the real map is still held back`);
  notes.push(`${tag}: ${held.length} request(s) held before release`);
  await page.unroute(marsMap);
  for (const route of held.splice(0)) await route.continue().catch(() => {});
  await saneEnd(page, tag, { body: 'Mars', angleDeg: chosenAngleDeg(viewport) });
  check(errors.length === 0, `${tag}: page errors: ${errors.join(' | ')}`);
  await page.close();
}

async function lifecycleCases(context, viewport) {
  await rapidDoublePickCase(context, viewport);
  await pickDuringRevealCase(context, viewport);
  await pickDuringFadeCase(context, viewport);
  await escCascadeCase(context, viewport);
  await reducedMotionCase(context, viewport);
  await dockedInspectorCase(context, viewport);
  if (viewport.name === 'desktop') await lateMapCase(context, viewport);
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
    if (runSweep) {
      for (const body of bodies) await sweepBody(context, viewport, body);
      if (bodies.includes('Europa')) await bandCase(context, viewport);
      if (runPaths && viewport.name === 'desktop') await pathCases(context, viewport);
    }
    if (runLifecycle) await lifecycleCases(context, viewport);
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
