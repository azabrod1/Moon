// The Look-inside battery (plan §11): drives the tool through the dev bridge
// and asserts what a reader relies on — the legend matches the drawn model,
// the pages say what the model says, a hover across the section
// resolves regions in order even mid-animation of the Readable remap, a
// model switch adds and removes rows, a region with an unknown temperature
// is hatched and never coloured, an uncertain boundary carries its band, and
// every render path draws the disc — then writes a capture per body × view ×
// mode for a look. Runs at desktop and 390×844 by default.
//
// The opt-in lifecycle scenario (--scenario=lifecycle) drives the tool's
// ceremonies through their races instead: the body-locked cut (an orbit
// leaves its frame alone and from behind the exterior hides it; "Cut faces
// the camera" swings it round; Reset view restores the entry frame), a
// rapid double pick, a pick during
// the reveal and during the cross-fade, the Esc cascade with View options and
// the picker closing each other and then a page back to its summary,
// prefers-reduced-motion (every move lands at once), the inspector page (a
// pin's summary and the pages on from it; the keyboard's way through them —
// a row's Enter opens its summary with focus inside, one Escape, its repeats
// ignored, returns focus to the row; and a model switch that drops the pinned
// region falls back to the layers), the phone sheet's drag
// (the height follows the finger, clamps at its peek, and a tap and a flick
// each land at an end, with the body's framing following), the planetarium's
// Tools row (it asks which world before it enters anything, and the world
// picked there is the one the tool opens on), and interiorReady()
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
// Appended to every page this opens, both doors alike: `--extra='&fps=30'`
// runs the whole sweep under a frame-rate target, where a callback may draw
// nothing and every wait has to be a wait for a DRAW.
const extraQuery = arg('extra', '');
const runSweep = scenarios.includes('sweep');
const runLifecycle = scenarios.includes('lifecycle');
await mkdir(outDir, { recursive: true });

const VIEWPORTS = [
  { name: 'desktop', width: 1400, height: 800, touch: false },
  // The phone is a touch device to the checks (no hover), though the context stays a mouse's for the drags.
  { name: 'phone', width: 390, height: 844, touch: true },
].filter((viewport) => viewportChoice === 'both' || viewport.name === viewportChoice);
const VIEWS = ['closed', 'cutaway', 'section'];
const MODES = ['composition', 'temperature'];
const PATHS = [
  { name: 'composer', query: '' },
  { name: 'msaa0', query: '&msaa=0' },
  { name: 'nofloat', query: '&nofloat=1' },
];

/** How far a face pixel may sit from the colour the output transform promises for it, per
 *  channel, 0..255: the composer's half-float rounding, the canvas's 8 bits and a software
 *  GPU's arithmetic, never a different curve — a wrong transfer or a stray light is tens. */
const FACE_PROBE_TOLERANCE = 6;
/** A region drawn thinner than this on screen has no pixel of its own at its middle: the limb's air,
 *  the rim's antialiasing and its neighbours all land in the 3×3 block the probe reads. Skipped, and said. */
/** How far above the sky a block must sit to count as corona still glowing. */
const CORONA_SKY_MARGIN = 3;
const FACE_PROBE_MIN_THICKNESS_PX = 6;
/** The hover sweep runs along the hinge, this far to one side of it so it lands on a face, not the seam. */
const SWEEP_OFF_HINGE_PX = 3;

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

/** The block's luminance spread with each column's mean taken out: a smooth
 *  radial ramp (the temperature scale across the disc, which runs along x at
 *  the centre row) leaves nothing, while a hatch's diagonal stripes vary
 *  within every column and survive. What "is there a hatch here" asks. */
function blockDetrendedStd(image, x0, y0, size) {
  const columns = [];
  for (let x = x0; x < x0 + size; x++) {
    const values = [];
    for (let y = y0; y < y0 + size; y++) {
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
      values.push(luminance(image.pixels, image.channels, y * image.width + x));
    }
    if (values.length) columns.push(values);
  }
  let sumSquares = 0;
  let count = 0;
  for (const values of columns) {
    const mean = values.reduce((total, value) => total + value, 0) / values.length;
    for (const value of values) {
      sumSquares += (value - mean) * (value - mean);
      count++;
    }
  }
  return count ? Math.sqrt(sumSquares / count) : 0;
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
  await page.goto(`${baseUrl}/?auto=interior&body=${body}${query}${extraQuery}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.interiorReady && window.__moon.interiorReady()), undefined, { timeout: 240000 });
  return { page, errors };
}

// Settle on DRAWS where the app offers it: under a frame-rate target a
// callback may present nothing, so three callbacks is not three frames.
const settle = (page) => page.evaluate(() => (window.__moon.waitForDraw
  ? window.__moon.waitForDraw(3)
  : new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))))));
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

/** The disc centre in client px: the body sits at the origin, and the mode's own
 *  projection offset is what moves it — up above the phone's sheet, however tall
 *  the reader has drawn it, or left of the desktop panel by half its width. */
async function discCentre(page, viewport) {
  const { viewOffset } = await state(page);
  return { x: viewport.width / 2 - viewOffset.x, y: viewport.height / 2 - viewOffset.y };
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
  // from the centre, at rest and mid-blend. Along the hinge (screen-vertical),
  // a few px to one side of it: the Section disc faces the camera (the wedge's
  // yaw fades to nothing at Section, cutFrame.cutYawRad), and along the hinge
  // the two half-discs meet, so a walk to either side of it crosses one face
  // each. Both directions along it, so both faces show every region out to the rim.
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
        const hit = await page.evaluate(([x, y]) => window.__moon.interiorHover(x, y), [centre.x + SWEEP_OFF_HINGE_PX, centre.y + direction * dx]);
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
  // Back to the tool's default, True, which is what the captures below show.
  await page.evaluate(() => window.__moon.interiorScale('true'));
  await page.evaluate(() => window.__moon.interiorHover(-1, -1));

  // 2b. On desktop the depth ruler lies on its face (ui/DepthRuler): its km labels exist at the
  // quarter wedge and each is placed by a matrix transform, never a flat x/y.
  if (!viewport.touch) {
    await page.evaluate(() => window.__moon.interiorView('cutaway'));
    await ready(page);
    const rulerText = await page.evaluate(() => [...document.querySelectorAll('#interior-ruler .ruler-label')]
      .filter((element) => element.style.display !== 'none')
      .map((element) => ({ transform: element.getAttribute('transform') ?? '', text: element.textContent ?? '' })));
    check(rulerText.length >= 2, `${tag}: the ruler shows ${rulerText.length} km label(s) at the quarter wedge`);
    check(rulerText.every((label) => label.transform.startsWith('matrix(')), `${tag}: a ruler label is not laid in the face's plane (${JSON.stringify(rulerText.slice(0, 3))})`);
    check(rulerText.some((label) => / km$/.test(label.text)) && rulerText.some((label) => label.text === '0'), `${tag}: the ruler's rim reads 0 and its deepest label carries the unit (${rulerText.map((label) => label.text).join(' | ')})`);
  }

  // 3a. A real pointer: the mode keeps a move for the frame and picks once there, so the
  // card follows a mouse without a rebuild per event (plan F27). Desktop only — a touch
  // has no hover — and through Playwright's mouse, which raises the pointer events a
  // mouse does. The centre of the disc at Section is the innermost region; far off the
  // disc is nothing, and the card goes.
  if (!viewport.touch) {
    await page.mouse.move(centre.x + SWEEP_OFF_HINGE_PX, centre.y);
    await settle(page);
    const shown = await page.evaluate(() => {
      const card = document.getElementById('interior-hover');
      return { display: getComputedStyle(card).display, text: card.textContent ?? '', transform: getComputedStyle(card).transform, hover: window.__moon.interiorState().hover };
    });
    const innermost = initial.regions[0];
    check(shown.display !== 'none' && shown.hover === innermost.key && shown.text.includes(innermost.name),
      `${tag}: a mouse over the centre should show ${innermost.name}'s card (display ${shown.display}, hover ${shown.hover}, "${shown.text}")`);
    check(shown.transform !== 'none', `${tag}: the hover card is placed by a transform, not by left/top (${shown.transform})`);
    await page.mouse.move(2, 2);
    await settle(page);
    const gone = await page.evaluate(() => ({ display: getComputedStyle(document.getElementById('interior-hover')).display, hover: window.__moon.interiorState().hover }));
    check(gone.display === 'none' && gone.hover === null, `${tag}: the card should go when the mouse leaves the disc (display ${gone.display}, hover ${gone.hover})`);
  }

  // 3b. In Temperature mode the face at a region's middle is the region's legend
  // swatch through the output path — the transform src/interior/rendering/
  // outputTransform.ts states, verified here on the real renderer rather than
  // believed. The probe (interiorFaceProbe) names the pixel and the two colours;
  // it is null for a region whose middle the diagram draws something else over
  // (an uncertainty band, a physical blend, an unknown temperature), and for
  // a body with no scale. The swatch is read back from the legend's own DOM.
  await page.evaluate(() => window.__moon.interiorMode('temperature'));
  await ready(page);
  const probes = [];
  for (const key of regionKeys) {
    const probe = await page.evaluate((regionKey) => window.__moon.interiorFaceProbe(regionKey), key);
    if (!probe) continue;
    if (probe.thicknessPx < FACE_PROBE_MIN_THICKNESS_PX) {
      notes.push(`${tag}: ${key} is ${probe.thicknessPx.toFixed(1)} px thick on screen, too thin for a face pixel of its own; not probed`);
      continue;
    }
    probes.push({ key, ...probe });
  }
  if (probes.length > 0) {
    const image = decodePng(await withoutRuler(page, () => page.screenshot({ type: 'png' })));
    const scale = image.width / viewport.width;
    const hex = (value) => `#${value.toString(16).padStart(6, '0')}`;
    for (const probe of probes) {
      const swatch = await page.evaluate((regionKey) => {
        const element = document.querySelector(`#interior-legend .interior-row[data-region="${regionKey}"] .interior-swatch`);
        return element ? getComputedStyle(element).backgroundColor : null;
      }, probe.key);
      const expectedSwatch = `rgb(${(probe.swatchHex >> 16) & 255}, ${(probe.swatchHex >> 8) & 255}, ${probe.swatchHex & 255})`;
      check(swatch === expectedSwatch, `${tag}: ${probe.key}'s legend swatch is ${swatch}, the scale says ${expectedSwatch}`);
      // The mean of a small block around the probe, against the transform's promise.
      const size = 3;
      const x0 = Math.round(probe.x * scale - size / 2);
      const y0 = Math.round(probe.y * scale - size / 2);
      const sums = [0, 0, 0];
      let count = 0;
      for (let y = y0; y < y0 + size; y++) {
        for (let x = x0; x < x0 + size; x++) {
          if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
          const offset = (y * image.width + x) * image.channels;
          for (let channel = 0; channel < 3; channel++) sums[channel] += image.pixels[offset + channel];
          count++;
        }
      }
      const seen = sums.map((sum) => sum / Math.max(count, 1));
      const expected = [(probe.faceHex >> 16) & 255, (probe.faceHex >> 8) & 255, probe.faceHex & 255];
      const worst = Math.max(...seen.map((value, channel) => Math.abs(value - expected[channel])));
      notes.push(`${tag}: ${probe.key} face at (${probe.x.toFixed(0)}, ${probe.y.toFixed(0)}) reads rgb(${seen.map((value) => value.toFixed(1)).join(', ')}) for ${hex(probe.faceHex)} (swatch ${hex(probe.swatchHex)}, ${probe.kelvin.toFixed(0)} K), off by ${worst.toFixed(1)}`);
      check(worst <= FACE_PROBE_TOLERANCE, `${tag}: ${probe.key}'s face reads rgb(${seen.map((value) => value.toFixed(1)).join(', ')}) where the transform promises ${hex(probe.faceHex)} (off by ${worst.toFixed(1)}, tolerance ${FACE_PROBE_TOLERANCE})`);
    }
  } else {
    notes.push(`${tag}: no region offered a face probe (every middle under a band or a blend, or no scale)`);
  }

  // 3c. On desktop a region whose temperature nobody knows says so on the face itself: under
  // its name on the ruler (ui/DepthRuler's note, ui/interiorCopy.TEMPERATURE_NOT_KNOWN), in
  // Temperature mode only, so the no-data hatch is never left to read as a texture. The note
  // goes only with a name the projection has room for, so it is required where the hatched
  // region is the innermost (its segment runs to the centre) and only noted elsewhere.
  if (!viewport.touch) {
    const rulerNotes = () => page.evaluate(() => [...document.querySelectorAll('#interior-ruler .ruler-note')]
      .filter((element) => element.style.display !== 'none')
      .map((element) => ({ transform: element.getAttribute('transform') ?? '', text: element.textContent ?? '' })));
    const hatchedKeys = await page.evaluate(() => [...document.querySelectorAll('#interior-legend .interior-row')]
      .filter((row) => row.querySelector('.interior-swatch')?.classList.contains('hatched'))
      .map((row) => row.getAttribute('data-region')));
    const shownNotes = await rulerNotes();
    check(shownNotes.every((note) => note.text === 'Temperature not known' && note.transform.startsWith('matrix(')),
      `${tag}: a ruler note is not the Temperature-mode note laid in the face's plane (${JSON.stringify(shownNotes)})`);
    if (hatchedKeys.length === 0) {
      check(shownNotes.length === 0, `${tag}: ${shownNotes.length} ruler note(s) with no hatched region`);
    } else if (hatchedKeys.includes(regionKeys[0])) {
      check(shownNotes.length >= 1, `${tag}: ${regionKeys[0]}'s temperature is not known and hatched, but the face carries no note`);
    } else {
      notes.push(`${tag}: hatched ${hatchedKeys.join(', ')}; ${shownNotes.length} note(s) on the face`);
    }
    await page.evaluate(() => window.__moon.interiorMode('composition'));
    await ready(page);
    const materialsNotes = await rulerNotes();
    check(materialsNotes.length === 0, `${tag}: ${materialsNotes.length} Temperature-mode note(s) survive in Materials mode`);
    await page.evaluate(() => window.__moon.interiorMode('temperature'));
    await ready(page);
  }
  await page.evaluate(() => window.__moon.interiorMode('composition'));
  await ready(page);

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

/** Saturn's diffuse core's outer boundary is a model spread of 30,000–40,000 km, between two
 *  regions whose temperatures are known and BRIGHT on Saturn's scale (about 8,000 K of a 134 K to
 *  12,000 K log scale): the band must be there in Temperature mode. Europa's spreads are the
 *  wrong probe — its core is unknown and hatched with the no-data hatch, so a block on that
 *  boundary reads a hatch whether or not the band is drawn, and its mantle band sits at the
 *  scale's dark end, where a 16% stripe is two grey levels. */
async function bandCase(context, viewport) {
  const tag = `${viewport.name}/Saturn band`;
  console.log(`\n== ${tag}`);
  const { page, errors } = await openTool(context, 'Saturn');
  await page.evaluate(() => { window.__moon.interiorView('section'); window.__moon.interiorMode('temperature'); window.__moon.interiorScale('true', 0); });
  await ready(page);
  const current = await state(page);
  const centre = await discCentre(page, viewport);
  const radiusPx = current.projectedRadiusPx;
  const reference = 58_232; // Saturn's volumetric mean radius, the model's referenceRadiusKm
  const image = decodePng(await withoutRuler(page, () => page.screenshot({ type: 'png' })));
  const scale = image.width / viewport.width;
  // True scale: display radius = physical radius, and the Section disc faces the camera, so a
  // radius lands where it says. In the band (30,000–40,000 km, centred on the boundary at 35,000)
  // versus the envelope at 49,500 km (a known temperature, outside both of Saturn's bands — the
  // envelope's own runs 40,000–45,000). Read across the hinge: the hinge itself is where the two
  // faces meet, and a seam through the block would be variance this check reads as a hatch.
  const inBandR = ((35_000 / reference) * radiusPx) * scale;
  const outBandR = ((49_500 / reference) * radiusPx) * scale;
  const size = 14;
  // The temperature ramp runs radially, so a block out of the band still carries a
  // gradient, and the core's 8,000 km physical blend is a radial one too; the ramp is
  // taken out column by column and what is left is the hatch.
  const inBand = blockDetrendedStd(image, Math.round(centre.x * scale + inBandR - size / 2), Math.round(centre.y * scale - size / 2), size);
  const outBand = blockDetrendedStd(image, Math.round(centre.x * scale + outBandR - size / 2), Math.round(centre.y * scale - size / 2), size);
  notes.push(`${tag}: in-band detrended std ${inBand.toFixed(2)} out-of-band ${outBand.toFixed(2)}`);
  check(inBand > outBand * 2.5 && inBand > 3, `${tag}: no hatched band where the boundary is uncertain (detrended std ${inBand.toFixed(2)} in, ${outBand.toFixed(2)} out)`);
  await page.screenshot({ path: path.join(outDir, `${viewport.name}-Saturn-band-true-temperature.png`) });
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

/** The opening the tool chooses on entry: Section on a phone, the 90° quarter wedge on desktop
 *  (cutFrame.ts CUT_VIEW_ANGLE_DEG). */
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
  // A swap's programs are all linked inside its close, under the cut: a count
  // that grew between the reveal and ready is a program built on the frames
  // the reader was watching.
  const marks = current.timings;
  if (marks && marks.kind === 'swap' && marks.programsAtReveal !== null && marks.programsWhenReady !== null) {
    check(marks.programsWhenReady === marks.programsAtReveal,
      `${tag}: the program count grew from ${marks.programsAtReveal} at the reveal to ${marks.programsWhenReady} once ready`);
  }
  return current;
}

/** Open the planetarium and wait for it to settle: where every entry into the
 *  tool really starts, and the only place the veil's lift can be watched. */
async function openPlanetarium(context, { reducedMotion = false } = {}) {
  const page = await context.newPage();
  page.setDefaultTimeout(240000);
  if (reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error).slice(0, 300)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text().slice(0, 300)); });
  await page.goto(`${baseUrl}/?auto=planetarium${extraQuery}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__moon?.ready?.()
    && !document.getElementById('mode-transition')?.classList.contains('active'), undefined, { timeout: 240000 });
  return { page, errors };
}

/**
 * Enter the tool and stop inside the veil's lift — the window where the body is
 * presented with its cut closed and the reveal is waiting for the veil to
 * finish coming off. The whole thing runs in ONE evaluate: the window is the
 * lift's own length, and a round trip per poll would step straight over it.
 * `act` is what to do the instant it is caught.
 */
async function inTheLift(page, body, act = 'nothing') {
  return page.evaluate(async ({ body, act }) => {
    window.__moon.interiorOpen(body);
    for (let frame = 0; frame < 1800; frame++) {
      const current = window.__moon.interiorState();
      if (current && current.revealWaiting) {
        const caught = {
          bodyId: current.bodyId,
          angleDeg: current.openingAngleDeg,
          ready: window.__moon.interiorReady(),
          loading: current.loading,
          skin: current.skin,
          revealStart: current.timings.revealStart,
          firstFrame: current.timings.firstFrame,
        };
        if (act === 'exit') window.__moon.interiorExit();
        if (act === 'pick') window.__moon.interiorPick('Mars');
        if (act === 'hide') {
          // Not a hidden tab — headless keeps drawing — but it is what the
          // app's own visibility handling is given to read.
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
          document.dispatchEvent(new Event('visibilitychange'));
        }
        return caught;
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return null;
  }, { body, act });
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
  // The dissolve is exactly the interval between `present` and `revealStart` on
  // a swap's own marks, and it is a quarter of a second: the poll and the
  // second pick go in ONE evaluate, because a round trip per poll steps over
  // it. (A freeze is no help here — devFreeze holds the presentation clock,
  // and the cut and the dissolve run on the frame's own dt.)
  const caught = await page.evaluate(async () => {
    window.__moon.interiorPick('Mars');
    for (let frame = 0; frame < 1800; frame++) {
      const marks = window.__moon.interiorState().timings;
      if (marks.kind === 'swap' && marks.present !== null && marks.revealStart === null) {
        const during = window.__moon.interiorState();
        window.__moon.interiorPick('Saturn');
        return { loading: during.loading, angleDeg: during.openingAngleDeg, bodyId: during.bodyId };
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return null;
  });
  check(caught !== null, `${tag}: the dissolve was never caught (presented with no reveal yet)`);
  if (caught) {
    check(caught.bodyId === 'Mars', `${tag}: the dissolve was caught on ${caught.bodyId}, expected Mars`);
    check(caught.loading === true, `${tag}: the commit says it is done while the skin is still dissolving`);
    check(caught.angleDeg < 1, `${tag}: the cut is ${caught.angleDeg.toFixed(1)}° open during the dissolve, expected closed`);
  }
  const end = await saneEnd(page, tag, { body: 'Saturn', angleDeg: chosenAngleDeg(viewport) });
  check(end.rings === true, `${tag}: Saturn's rings are ${end.rings}, expected on`);
  check(errors.length === 0, `${tag}: page errors: ${errors.join(' | ')}`);
  await page.close();
}

/**
 * The veil never lifts onto anything unready, and nothing is left stranded if
 * the reader acts inside the lift.
 *
 * The entry's cut opens once the veil has finished coming off, so there is a
 * window — the lift's own length — in which the body is presented, the cut is
 * closed and settled and every reveal program is linked. The tool must call
 * itself NOT ready in there (a capture would otherwise take a closed body for
 * the finished picture), and whatever the reader does in there must win: an
 * exit leaves, a pick brings its own body in and opens onto it.
 */
async function liftWindowCase(context, viewport) {
  const tag = `${viewport.name}/lifecycle the veil's lift`;
  console.log(`\n== ${tag}`);

  // 1. Inside the lift: presented, closed, and not ready.
  {
    const { page, errors } = await openPlanetarium(context);
    const caught = await inTheLift(page, 'Earth');
    check(caught !== null, `${tag}: the lift window was never caught`);
    if (caught) {
      check(caught.ready === false, `${tag}: interiorReady() is true with the cut still closed`);
      check(caught.angleDeg < 1, `${tag}: the cut is ${caught.angleDeg.toFixed(1)}° open inside the lift, expected closed`);
      check(caught.skin === true, `${tag}: no skin on the body inside the lift`);
      check(caught.revealStart === null, `${tag}: the reveal had already started inside the lift`);
      check(caught.firstFrame !== null, `${tag}: the studio had not drawn a frame when the veil started lifting`);
    }
    await saneEnd(page, `${tag} (opens after the lift)`, { body: 'Earth', angleDeg: chosenAngleDeg(viewport) });
    const after = await state(page);
    const marks = after.timings;
    check(marks.firstFrame !== null && marks.veilLifted !== null && marks.firstFrame <= marks.veilLifted,
      `${tag}: the veil lifted at ${marks.veilLifted} with the first drawn frame at ${marks.firstFrame}`);
    check(marks.revealStart !== null && marks.veilLifted <= marks.revealStart,
      `${tag}: the reveal started at ${marks.revealStart}, before the veil lifted at ${marks.veilLifted}`);
    check(errors.length === 0, `${tag}: page errors: ${errors.join(' | ')}`);
    await page.close();
  }

  // 2. An exit inside the lift: the tool goes, and nothing opens behind it.
  {
    const { page, errors } = await openPlanetarium(context);
    const caught = await inTheLift(page, 'Earth', 'exit');
    check(caught !== null, `${tag} (exit): the lift window was never caught`);
    await page.waitForFunction(() => document.getElementById('interior-ui').style.display === 'none'
      && !document.getElementById('mode-transition').classList.contains('active'), undefined, { timeout: 120000 });
    await page.waitForTimeout(600); // past the reveal that would have fired
    const left = await state(page);
    check(left === null || left.ready === false, `${tag} (exit): the tool still calls itself ready after leaving`);
    check(errors.length === 0, `${tag} (exit): page errors: ${errors.join(' | ')}`);
    // And the tool opens again afterwards, on the body asked for.
    await page.evaluate(() => window.__moon.interiorOpen('Mars'));
    await saneEnd(page, `${tag} (re-entry)`, { body: 'Mars', angleDeg: chosenAngleDeg(viewport) });
    await page.close();
  }

  // 3. A pick inside the lift: the pick owns the reveal, not the entry.
  {
    const { page, errors } = await openPlanetarium(context);
    const caught = await inTheLift(page, 'Earth', 'pick');
    check(caught !== null, `${tag} (pick): the lift window was never caught`);
    const end = await saneEnd(page, `${tag} (pick)`, { body: 'Mars', angleDeg: chosenAngleDeg(viewport) });
    check(end.timings.kind === 'swap', `${tag} (pick): the open that finished was an ${end.timings.kind}, expected the pick's swap`);
    check(errors.length === 0, `${tag} (pick): page errors: ${errors.join(' | ')}`);
    await page.close();
  }

  // 4. A tab that says it is hidden inside the lift. Headless keeps drawing, so
  //    this exercises the app's visibility handling and not a real background
  //    tab: what it proves is that the reveal is not stranded by it.
  {
    const { page, errors } = await openPlanetarium(context);
    const caught = await inTheLift(page, 'Earth', 'hide');
    check(caught !== null, `${tag} (hidden): the lift window was never caught`);
    await saneEnd(page, `${tag} (hidden)`, { body: 'Earth', angleDeg: chosenAngleDeg(viewport) });
    check(errors.length === 0, `${tag} (hidden): page errors: ${errors.join(' | ')}`);
    await page.close();
  }
  notes.push(`${tag}: the hidden-tab arm reports visibilityState only; headless keeps animating, so a true background tab is unverified here`);
}

/** The veil's `transitionend` never arrives — a cancelled transition, a tab
 *  hidden mid-fade, a re-added cover. The timer standing in for it must open
 *  the cut all the same. */
async function lostLiftEventCase(context, viewport) {
  const tag = `${viewport.name}/lifecycle the lift event lost`;
  console.log(`\n== ${tag}`);
  const page = await context.newPage();
  page.setDefaultTimeout(240000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error).slice(0, 300)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text().slice(0, 300)); });
  // Swallow every transitionend the veil would hand out, before the app runs.
  await page.addInitScript(() => {
    const install = () => {
      const veil = document.getElementById('mode-transition');
      if (!veil) return;
      const original = veil.addEventListener.bind(veil);
      veil.addEventListener = (type, listener, options) => {
        if (type === 'transitionend') return;
        return original(type, listener, options);
      };
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
    else install();
  });
  await page.goto(`${baseUrl}/?auto=interior&body=Earth${extraQuery}`, { waitUntil: 'domcontentloaded' });
  await saneEnd(page, tag, { body: 'Earth', angleDeg: chosenAngleDeg(viewport) });
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
  const optionsOpen = () => page.evaluate(() => document.getElementById('interior-options').classList.contains('visible'));
  const pageShown = () => page.evaluate(() => document.getElementById('interior-inspector').dataset.page ?? 'layers');
  await page.evaluate(() => window.__moon.interiorPin('outerCore'));
  let current = await state(page);
  check(current.pinned === 'outerCore' && current.page === 'summary', `${tag}: a pin did not open the summary (page ${current.page})`);
  check(await page.evaluate(() => window.__moon.interiorEvidence('existence')), `${tag}: evidence refused`);
  current = await state(page);
  check(current.page === 'evidence' && current.evidence === 'existence' && (await pageShown()) === 'evidence', `${tag}: the evidence page did not open`);
  // The two modals close each other; a page is not a modal and stays under them.
  check(await page.evaluate(() => window.__moon.interiorOptionsOpen()), `${tag}: view options refused`);
  check(await optionsOpen(), `${tag}: view options did not open`);
  check(await page.evaluate(() => window.__moon.interiorPickerOpen()), `${tag}: picker refused`);
  check(await pickerOpen() && !(await optionsOpen()), `${tag}: view options stayed open under the picker`);
  check(await page.evaluate(() => window.__moon.interiorOptionsOpen()), `${tag}: view options refused with the picker open`);
  check(await optionsOpen() && !(await pickerOpen()), `${tag}: the picker stayed open under view options`);
  check((await state(page)).page === 'evidence', `${tag}: the evidence page did not stay under the modals`);
  check(await page.evaluate(() => document.getElementById('interior-panel').hasAttribute('inert')), `${tag}: the panel is not inert under a modal`);
  // The cascade: the modal, then the page back to the summary, then the selection.
  await page.evaluate(() => window.__moon.interiorEsc());
  current = await state(page);
  check(!(await optionsOpen()) && current.page === 'evidence', `${tag}: the first Esc did not close only view options`);
  check(!(await page.evaluate(() => document.getElementById('interior-panel').hasAttribute('inert'))), `${tag}: the panel stayed inert after the modal closed`);
  await page.evaluate(() => window.__moon.interiorEsc());
  current = await state(page);
  check(current.page === 'summary' && current.evidence === null && current.pinned === 'outerCore', `${tag}: the second Esc did not take the evidence page back to the summary`);
  await page.evaluate(() => window.__moon.interiorPickerOpen());
  await page.evaluate(() => window.__moon.interiorEsc());
  current = await state(page);
  check(!(await pickerOpen()) && current.pinned === 'outerCore' && current.page === 'summary', `${tag}: the third Esc did not close only the picker`);
  await page.evaluate(() => window.__moon.interiorEsc());
  current = await state(page);
  check(current.pinned === null && current.page === 'layers' && (await pageShown()) === 'layers', `${tag}: the fourth Esc did not unselect`);
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
  // The Enlarge thin layers switch through the DOM, the way a reader reaches it
  // (View options): the morph must not ease. Actual size is the default, so
  // enlarging is the first move.
  check((await state(page)).readable === false, `${tag}: the tool did not open at actual size`);
  await page.evaluate(() => document.getElementById('interior-readable-toggle').click());
  await settle(page);
  current = await state(page);
  check(current.readable === true && current.scaleBlend === 1, `${tag}: the enlargement morph is at ${current.scaleBlend} three frames after the toggle; it should land at once`);
  await page.evaluate(() => document.getElementById('interior-readable-toggle').click());
  await settle(page);
  check((await state(page)).scaleBlend === 0, `${tag}: the enlargement morph did not land at once on the way back`);
  await page.evaluate(() => window.__moon.interiorPick('Mars'));
  await saneEnd(page, tag, { body: 'Mars', angleDeg: 180 });
  check(errors.length === 0, `${tag}: page errors: ${errors.join(' | ')}`);
  await page.close();

  // The entry itself: with motion stilled there is no opening to watch, so the
  // cut must already be at its angle when the veil comes off. Waiting for the
  // lift would show a CLOSED body fading in and then snapping open at the end
  // of it — worse than what it replaced, and not what "reduced motion stills
  // all of it" says.
  const entry = await openPlanetarium(context, { reducedMotion: true });
  const angles = await entry.page.evaluate(async () => {
    const veil = document.getElementById('mode-transition');
    let liftedAt = null;
    new MutationObserver(() => {
      if (!veil.classList.contains('active') && liftedAt === null) liftedAt = performance.now();
    }).observe(veil, { attributes: true, attributeFilter: ['class'] });
    window.__moon.interiorOpen('Earth');
    const samples = [];
    for (let frame = 0; frame < 1800; frame++) {
      if (liftedAt !== null) {
        samples.push(window.__moon.interiorState().openingAngleDeg);
        if (performance.now() - liftedAt > 400) break;
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return samples;
  });
  const smallest = angles.length ? Math.min(...angles) : -1;
  check(angles.length > 0, `${tag}: the veil never lifted on the entry`);
  check(smallest >= chosenAngleDeg(viewport) - 0.5,
    `${tag}: the cut was ${smallest.toFixed(1)}° open after the veil lifted, expected ${chosenAngleDeg(viewport)}° with motion stilled`);
  await saneEnd(entry.page, `${tag} (entry)`, { body: 'Earth', angleDeg: chosenAngleDeg(viewport) });
  check(entry.errors.length === 0, `${tag} (entry): page errors: ${entry.errors.join(' | ')}`);
  await entry.page.close();
}

/** A pin opens the region's summary page inside the panel — the sheet's scrolling body on a phone,
 *  the side panel on desktop, never a card of its own — and the pages lead on to the details, the
 *  evidence and back to the layers. */
/** Mars's two models: the basal molten layer is a region only one of them has. */
const MARS_LIQUID_MODEL = 'mars-large-liquid-core';
const MARS_BASAL_MODEL = 'mars-basal-molten-layer';

async function inspectorPageCase(context, viewport) {
  const tag = `${viewport.name}/lifecycle inspector page`;
  console.log(`\n== ${tag}`);
  const { page, errors } = await openTool(context, 'Earth');
  await page.evaluate(() => window.__moon.interiorPin('outerCore'));
  await settle(page);
  const inspect = () => page.evaluate(() => {
    const root = document.getElementById('interior-inspector');
    const layers = document.getElementById('interior-page-layers');
    return {
      page: root.dataset.page ?? 'layers',
      parent: root.parentElement?.id ?? '',
      display: getComputedStyle(root).display,
      layersDisplay: getComputedStyle(layers).display,
      name: root.querySelector('.ii-name')?.textContent ?? '',
      text: root.textContent ?? '',
      standalone: root.classList.contains('pn'),
    };
  });
  let inspector = await inspect();
  check(inspector.display !== 'none' && inspector.page === 'summary', `${tag}: the summary is not shown after a pin (page ${inspector.page})`);
  check(inspector.layersDisplay === 'none', `${tag}: the layers page stayed visible under the summary`);
  check(inspector.name === 'Outer core', `${tag}: the summary shows "${inspector.name}"`);
  check(inspector.parent === 'interior-scroll' && !inspector.standalone, `${tag}: the summary is not the panel's own content (in #${inspector.parent}, standalone ${inspector.standalone})`);
  check(!/of 95|rubric|published rule/i.test(inspector.text), `${tag}: the summary still carries the score`);
  check(await page.evaluate(() => window.__moon.interiorPage('details')), `${tag}: the details page refused`);
  inspector = await inspect();
  check(inspector.page === 'details' && /Properties/.test(inspector.text) && /Heat sources/.test(inspector.text), `${tag}: the details page is missing its sections`);
  check(await page.evaluate(() => window.__moon.interiorPage('evidence')), `${tag}: the evidence page refused`);
  inspector = await inspect();
  check(inspector.page === 'evidence' && /Structure/.test(inspector.text) && /Observed by seismology/.test(inspector.text), `${tag}: the evidence page is missing its groups`);
  check(await page.evaluate(() => window.__moon.interiorPage('layers')), `${tag}: the layers refused`);
  inspector = await inspect();
  check(inspector.display === 'none' && inspector.layersDisplay !== 'none' && (await state(page)).pinned === null, `${tag}: the layers did not come back`);

  // The keyboard's way through the pages: Enter on a row opens its summary with
  // focus inside it (the browser would otherwise drop focus to the body when the
  // row's page hides), and one Escape brings the reader back to that row. The
  // press is held: its auto-repeats must take no further rung, or a quarter
  // second on the key would walk the cascade out of the tool.
  await page.focus('#interior-legend .interior-row[data-region="outerCore"]');
  await page.keyboard.press('Enter');
  await settle(page);
  const afterEnter = await page.evaluate(() => ({
    page: document.getElementById('interior-inspector').dataset.page ?? 'layers',
    focusInPage: document.activeElement?.closest('#interior-inspector') !== null,
    focusText: document.activeElement?.textContent?.trim() ?? '',
  }));
  check(afterEnter.page === 'summary' && afterEnter.focusInPage, `${tag}: Enter on a row left focus outside its summary (page ${afterEnter.page}, focus on "${afterEnter.focusText}")`);
  await page.evaluate(() => {
    for (let repeat = 0; repeat < 8; repeat++) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', repeat: repeat > 0, bubbles: true, cancelable: true }));
    }
  });
  await settle(page);
  const afterEscape = await page.evaluate(() => ({
    page: document.getElementById('interior-inspector').dataset.page ?? 'layers',
    focusRegion: document.activeElement?.closest('.interior-row')?.dataset.region ?? null,
    toolOpen: document.getElementById('interior-ui').style.display !== 'none',
  }));
  check(afterEscape.toolOpen, `${tag}: a held Escape's repeats walked the cascade out of the tool`);
  check(afterEscape.page === 'layers', `${tag}: one Escape from the summary landed on ${afterEscape.page}`);
  check(afterEscape.focusRegion === 'outerCore', `${tag}: focus did not return to the row after Escape (on ${afterEscape.focusRegion})`);

  // A model switch that drops the pinned region: the page falls back to the
  // layers rather than rendering a region the drawn model no longer has.
  await page.evaluate(() => window.__moon.interiorPick('Mars'));
  // The outgoing body's own ready state must not satisfy the wait: Mars first, then ready.
  await page.waitForFunction(() => window.__moon.interiorState().bodyId === 'Mars', undefined, { timeout: 120000 });
  await ready(page);
  check(await page.evaluate((id) => window.__moon.interiorModel(id), MARS_BASAL_MODEL), `${tag}: interiorModel(${MARS_BASAL_MODEL}) refused`);
  await settle(page);
  check(await page.evaluate(() => window.__moon.interiorPin('basalMoltenLayer')), `${tag}: the basal layer would not pin`);
  await settle(page);
  check((await state(page)).page === 'summary', `${tag}: the basal layer's summary did not open`);
  check(await page.evaluate((id) => window.__moon.interiorModel(id), MARS_LIQUID_MODEL), `${tag}: interiorModel(${MARS_LIQUID_MODEL}) refused`);
  await settle(page);
  const afterSwitch = await state(page);
  inspector = await inspect();
  check(afterSwitch.page === 'layers' && afterSwitch.pinned === null && inspector.display === 'none', `${tag}: a switch to a model without the pinned region left page ${afterSwitch.page}, pinned ${afterSwitch.pinned}, host ${inspector.display}`);
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

/** The phone sheet is a drag, not only a toggle: its height follows the finger,
 *  clamps at its peek, and a tap and a flick each land it at an end — with the
 *  body's framing following, so the disc stays in the band above the sheet. */
async function sheetDragCase(context, viewport) {
  const tag = `${viewport.name}/lifecycle sheet drag`;
  console.log(`\n== ${tag}`);
  const { page, errors } = await openTool(context, 'Earth');
  await ready(page);
  const panelHeight = () => page.evaluate(() => Math.round(document.getElementById('interior-panel').getBoundingClientRect().height));
  const gripCentre = () => page.evaluate(() => {
    const box = document.getElementById('interior-grip').getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });
  const expanded = () => page.evaluate(() => document.getElementById('interior-grip').getAttribute('aria-expanded'));
  /** The height once the sheet has caught up with the height the tool asked
   *  for: a snap eases in CSS, and on a slow machine that takes many frames. */
  const settledHeight = async () => {
    await page.waitForFunction(() => {
      const panel = document.getElementById('interior-panel');
      const asked = parseFloat(panel.style.getPropertyValue('--sheet-h'));
      return !Number.isFinite(asked) || Math.abs(panel.getBoundingClientRect().height - asked) <= 1;
    }, undefined, { timeout: 60000, polling: 100 }).catch(() => {});
    return panelHeight();
  };
  /** Whether both rows of view buttons are inside the sheet's scrolling body. */
  const buttonsInView = () => page.evaluate(() => {
    const buttons = document.getElementById('interior-mode-temperature').getBoundingClientRect();
    const body = document.getElementById('interior-scroll').getBoundingClientRect();
    return buttons.top >= body.top - 1 && buttons.bottom <= body.bottom + 1;
  });
  const framingShift = async () => (await state(page)).viewOffset.y;
  /** A drag of the grip, upward positive: four steps 150 ms apart, well under
   *  the speed that would read as a flick. A flick itself is not driven from
   *  here — one synthesised move costs about a frame over the wire, so on a
   *  software renderer the fastest gesture this can send still reads as a slow
   *  drag; the threshold lives in InteriorMode, and the drag, the clamp and the
   *  tap below are what a battery can honestly assert. */
  const dragGrip = async (byPx) => {
    const from = await gripCentre();
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    const steps = 4;
    for (let step = 1; step <= steps; step++) {
      await page.mouse.move(from.x, from.y - (byPx * step) / steps);
      await page.waitForTimeout(150);
    }
    const heightUnderTheFinger = await panelHeight();
    await page.mouse.up();
    await settledHeight(); // a snap eases over 260 ms
    return heightUnderTheFinger;
  };

  // The sheet opens at its peek, with the body in the band above it.
  const peek = await panelHeight();
  const peekShift = await framingShift();
  check(await buttonsInView(), `${tag}: the sheet's peek (${peek} px) cuts off the rows of view buttons`);
  check(peek < viewport.height / 2, `${tag}: the sheet opens at ${peek} px, over half of ${viewport.height}`);
  check(await expanded() === 'false', `${tag}: the grip reports expanded at the peek`);
  check(peekShift > 0, `${tag}: the body is not lifted above the sheet (viewOffset.y ${peekShift})`);

  // A slow drag up: the height follows the finger and the framing follows the height.
  const dragged = await dragGrip(200);
  const draggedShift = await framingShift();
  check(dragged === await panelHeight(), `${tag}: the sheet moved on release (${dragged} px under the finger) without a flick`);
  check(draggedShift > peekShift, `${tag}: the body did not follow the taller sheet (viewOffset.y ${peekShift} to ${draggedShift})`);

  // A long drag down clamps at the peek, and the framing comes back with it.
  await dragGrip(-400);
  const backDown = await panelHeight();
  check(Math.abs(backDown - peek) <= 2, `${tag}: dragging past the bottom left the sheet at ${backDown} px, expected the peek ${peek}`);
  const backShift = await framingShift();
  check(Math.abs(backShift - peekShift) <= 2, `${tag}: the body did not come back with the sheet (viewOffset.y ${backShift}, expected ${peekShift})`);

  // A tap goes to the other end: the sheet's own content, under the 85% cap.
  await page.evaluate(() => document.getElementById('interior-grip').click());
  const full = await settledHeight();
  check(full > peek, `${tag}: a tap left the sheet at ${full} px, no taller than its peek ${peek}`);
  check(full <= Math.round(viewport.height * 0.85) + 1, `${tag}: the sheet grew to ${full} px, past 85% of ${viewport.height}`);
  check(await expanded() === 'true', `${tag}: the grip does not report expanded at the full height`);
  // Which says what the drag above should have reached: the finger, or that ceiling.
  const wanted = Math.min(peek + 200, full);
  check(Math.abs(dragged - wanted) <= 12, `${tag}: a 200 px drag from ${peek} px left the sheet at ${dragged} px, expected ${wanted}`);

  // And back: a tap at the full height returns the sheet to its peek.
  await page.evaluate(() => document.getElementById('interior-grip').click());
  const backToPeek = await settledHeight();
  check(Math.abs(backToPeek - peek) <= 2, `${tag}: a tap at the full height left the sheet at ${backToPeek} px, expected the peek ${peek}`);
  check(await expanded() === 'false', `${tag}: the grip still reports expanded back at the peek`);
  notes.push(`${tag}: peek ${peek} full ${full}, a 200 px drag reached ${dragged}; viewOffset.y ${peekShift} to ${draggedShift}`);
  check(errors.length === 0, `${tag}: page errors: ${errors.join(' | ')}`);
  await page.close();
}

/** The Tools row is a question, not a destination: tapping it puts the shared
 *  picker up with no tool entered, and the body picked there — Mars, which is
 *  neither the old default nor anywhere near the boot camera — is what the
 *  tool opens on. Boots the planetarium rather than the tool, so it is the
 *  only case here that walks in through the real front door. */
async function toolsRowPickerCase(context, viewport) {
  const tag = `${viewport.name}/lifecycle Tools row picker`;
  console.log(`\n== ${tag}`);
  const page = await context.newPage();
  page.setDefaultTimeout(240000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error).slice(0, 300)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text().slice(0, 300)); });
  await page.goto(`${baseUrl}/?auto=planetarium${extraQuery}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), undefined, { timeout: 300000 });
  await page.waitForFunction(() => {
    const loading = document.getElementById('loading-screen');
    return !loading || loading.classList.contains('hidden');
  }, undefined, { timeout: 120000 }).catch(() => {});
  const insideRow = '#tools-menu-list [data-tool="interior"]';
  await page.evaluate(() => document.getElementById('planetarium-btn-tools').click());
  await settle(page);
  const sub = await page.evaluate((selector) => document.querySelector(`${selector} .tools-sub`)?.textContent ?? '', insideRow);
  check(sub === 'Cut a world open and see its layers.', `${tag}: the row's sub-line reads "${sub}"`);
  await page.evaluate((selector) => document.querySelector(selector).click(), insideRow);
  await page.waitForFunction(() => window.__moon.toolsInsideOpen(), undefined, { timeout: 60000 });
  check(await page.evaluate(() => !document.getElementById('tools-menu').classList.contains('visible')),
    `${tag}: the Tools popover stayed open under the picker`);
  check(await page.evaluate(() => document.getElementById('interior-ui').style.display !== 'block'),
    `${tag}: the tool was entered before any world was picked`);
  const rows = () => page.evaluate(() => [...document.querySelectorAll('#tools-inside-picker-list .pk-row')]
    .map((row) => ({ name: row.querySelector('b')?.textContent ?? '', text: row.textContent ?? '' })));
  const listed = await rows();
  check(listed.some((row) => row.name === 'Sun') && listed.some((row) => row.name === 'Mars'),
    `${tag}: the picker lists ${listed.length} bodies, without the Sun or Mars among them`);
  // The pills ride in on the tool's chunk, a dynamic import: a beat behind the rows.
  await page.waitForFunction(() => !!document.querySelector('#tools-inside-picker-list .pk-row .pk-tag-cover'),
    undefined, { timeout: 60000 }).catch(() => {});
  const mars = (await rows()).find((row) => row.name === 'Mars');
  check(!!mars && mars.text.includes('models'), `${tag}: Mars's row carries no coverage pill ("${mars?.text ?? ''}")`);
  await page.evaluate(() => [...document.querySelectorAll('#tools-inside-picker-list .pk-row')]
    .find((row) => row.querySelector('b')?.textContent === 'Mars').click());
  await saneEnd(page, tag, { body: 'Mars', angleDeg: chosenAngleDeg(viewport) });
  check(await page.evaluate(() => !window.__moon.toolsInsideOpen()), `${tag}: the picker is still up inside the tool`);
  check(errors.length === 0, `${tag}: page errors: ${errors.join(' | ')}`);
  await page.close();
}

/** The cut is locked to the body: an orbit turns the body under it and leaves its frame
 *  alone, and from behind the cut is hidden by the intact exterior; "Cut faces the camera"
 *  swings it round to the camera and off freezes it there; Reset view chooses it afresh from
 *  the entry pose, which is the frame the tool opened with. */
async function bodyLockedCutCase(context, viewport) {
  const tag = `${viewport.name}/lifecycle body-locked cut`;
  console.log(`\n== ${tag}`);
  const { page, errors } = await openTool(context, 'Earth');
  await ready(page);
  const axes = (current) => [...current.cutFrame.view, ...current.cutFrame.hinge, ...current.cutFrame.side];
  const maxDelta = (a, b) => Math.max(...a.map((value, index) => Math.abs(value - b[index])));
  const orbit = async (azimuthDeg, elevationDeg) => {
    await page.evaluate(([azimuth, elevation]) => window.__moon.interiorOrbit(azimuth, elevation), [azimuthDeg, elevationDeg]);
    await settle(page);
  };
  const rulerHidden = () => page.evaluate(() => document.getElementById('interior-ruler').style.display === 'none');
  const atRest = await state(page);
  check(atRest.cutFollow === false, `${tag}: the cut follows the camera by default`);
  const centre = await discCentre(page, viewport);
  const centreHit = await page.evaluate(([x, y]) => window.__moon.interiorHover(x, y), [centre.x, centre.y]);
  check(centreHit && centreHit.surface === 'face', `${tag}: the disc centre is not on a face at rest (${JSON.stringify(centreHit)})`);
  // An orbit of forty degrees: the body turns under the cut, and the frame does not move.
  await orbit(12, 28);
  const orbited = await state(page);
  check(maxDelta(axes(orbited), axes(atRest)) < 1e-9, `${tag}: an orbit moved the cut frame (by ${maxDelta(axes(orbited), axes(atRest))})`);
  // From behind, the cut is behind the exterior: the centre of the disc is intact skin.
  await orbit(152, 16);
  const behind = await state(page);
  check(maxDelta(axes(behind), axes(atRest)) < 1e-9, `${tag}: the orbit round the back moved the cut frame`);
  const behindCentre = await discCentre(page, viewport);
  const behindHit = await page.evaluate(([x, y]) => window.__moon.interiorHover(x, y), [behindCentre.x, behindCentre.y]);
  check(behindHit && behindHit.surface === 'skin', `${tag}: from behind the disc centre is not intact skin (${JSON.stringify(behindHit)})`);
  if (viewport.name === 'desktop') check(await rulerHidden(), `${tag}: the ruler is still drawn with both faces turned away`);
  // Following: the cut swings round to the camera and the frame is a new one. The swing
  // runs on the tool's own ticks (CUT_SWING_S of them), and a software GPU ticks slowly,
  // so the frame is read once it stops moving between draws rather than after a fixed wait.
  check(await page.evaluate(() => window.__moon.interiorCutFollow(true)), `${tag}: interiorCutFollow(true) refused`);
  let following = await state(page);
  for (let draws = 0; draws < 40; draws++) {
    await settle(page);
    const next = await state(page);
    const moved = maxDelta(axes(next), axes(following));
    following = next;
    if (draws > 0 && moved < 1e-9) break;
  }
  check(following.cutFollow === true, `${tag}: cutFollow is not reported on`);
  check(maxDelta(axes(following), axes(atRest)) > 0.1, `${tag}: following, the cut did not swing round to the camera`);
  const followingCentre = await discCentre(page, viewport);
  const followingHit = await page.evaluate(([x, y]) => window.__moon.interiorHover(x, y), [followingCentre.x, followingCentre.y]);
  check(followingHit && followingHit.surface === 'face', `${tag}: following, the disc centre is not on a face (${JSON.stringify(followingHit)})`);
  if (viewport.name === 'desktop') check(!(await rulerHidden()), `${tag}: the ruler stayed hidden once the cut faced the camera`);
  // Off again: frozen where it is, and the next orbit leaves it there.
  await page.evaluate(() => window.__moon.interiorCutFollow(false));
  await settle(page);
  const frozen = await state(page);
  check(maxDelta(axes(frozen), axes(following)) < 1e-6, `${tag}: turning following off moved the cut`);
  await orbit(100, -10);
  const frozenOrbited = await state(page);
  check(maxDelta(axes(frozenOrbited), axes(frozen)) < 1e-9, `${tag}: an orbit moved the frozen cut`);
  // Reset view: the entry pose, and the frame the tool opened with.
  check(await page.evaluate(() => window.__moon.interiorResetView()), `${tag}: interiorResetView() refused`);
  await settle(page);
  const reset = await state(page);
  check(maxDelta(axes(reset), axes(atRest)) < 1e-6, `${tag}: Reset view did not restore the entry frame (by ${maxDelta(axes(reset), axes(atRest))})`);
  check(reset.cutFollow === false && Math.abs(reset.openingAngleDeg - atRest.openingAngleDeg) < 0.01, `${tag}: Reset view changed the following or the opening`);
  check(errors.length === 0, `${tag}: page errors: ${errors.join(' | ')}`);
  await page.close();
}

/**
 * Two things a body swap must get right, both of which shipped broken and were caught by a
 * review of the merged branch rather than by this battery:
 *
 *   the hover card   its cached content is keyed by REGION key, and a dozen models call their
 *                    innermost region 'core'. Hovering one world's core, swapping, and hovering
 *                    the next world's must rewrite the card, not match the cache and keep the
 *                    first world's name and material.
 *   the framing      the fit is the body WITH its air (InteriorScene.boundRadius): the Sun's
 *                    corona reaches 1.3 radii, and a fit taken before the body was presented
 *                    used the bare radius and cropped the corona against the stage.
 */
async function swapFreshnessCase(context, viewport) {
  const tag = `${viewport.name}/lifecycle swap freshness`;
  console.log(`\n== ${tag}`);
  const { page, errors } = await openTool(context, 'Ganymede');
  await page.evaluate(() => window.__moon.interiorView('section'));
  await ready(page);

  // The hover card across a swap. Desktop only: a touch has no hover.
  if (!viewport.touch) {
    const centre = await discCentre(page, viewport);
    const hoverAtCentre = async () => {
      await page.mouse.move(centre.x + SWEEP_OFF_HINGE_PX, centre.y);
      await settle(page);
      return page.evaluate(() => ({ text: document.getElementById('interior-hover').textContent ?? '', hover: window.__moon.interiorState().hover }));
    };
    const first = await hoverAtCentre();
    const firstRegion = (await state(page)).regions[0];
    check(first.hover === firstRegion.key && first.text.includes(firstRegion.name), `${tag}: Ganymede's innermost region did not show its card (hover ${first.hover}, "${first.text}")`);
    await page.mouse.move(2, 2);
    await settle(page);
    await page.evaluate(() => window.__moon.interiorPick('Venus'));
    await ready(page);
    const second = await hoverAtCentre();
    const secondRegion = (await state(page)).regions[0];
    // The two share a region key; only the words tell them apart.
    check(firstRegion.key === secondRegion.key, `${tag}: the two bodies' innermost keys differ (${firstRegion.key} vs ${secondRegion.key}); this case needs two that share one`);
    check(second.text.includes(secondRegion.name), `${tag}: after the swap the card still reads the old world's region ("${second.text}", expected ${secondRegion.name})`);
    check(second.text !== first.text, `${tag}: the card's words did not change across the swap ("${second.text}")`);
  }

  // The framing takes the air shell in. The Sun is the body that shows it: its corona is 1.3
  // radii, so a fit on the bare radius crops it. Read off the picture — the glow must fall back
  // to the sky inside the stage rather than run off its top edge.
  await page.evaluate(() => window.__moon.interiorPick('Sun'));
  await ready(page);
  await page.evaluate(() => window.__moon.interiorView('cutaway'));
  await ready(page);
  const image = decodePng(await withoutRuler(page, () => page.screenshot({ type: 'png' })));
  const scale = image.width / viewport.width;
  const centre = await discCentre(page, viewport);
  const stageTop = Math.round((await page.evaluate(() => {
    const strip = document.getElementById('interior-top');
    return strip ? strip.getBoundingClientRect().bottom : 0;
  })) * scale);
  const columnX = Math.round(centre.x * scale);
  const sky = blockStats(image, Math.round(4 * scale), stageTop + Math.round(4 * scale), Math.round(6 * scale)).mean;
  // Scan up the disc's own column from its centre: where does the corona reach the sky again?
  let fadesAt = null;
  for (let y = Math.round(centre.y * scale); y >= stageTop; y--) {
    if (blockStats(image, columnX - 2, y - 2, 5).mean < sky + CORONA_SKY_MARGIN) { fadesAt = y; break; }
  }
  check(fadesAt !== null, `${tag}: the Sun's corona still glows at the top of the stage (sky ${sky.toFixed(1)}); the fit is not taking the air shell in`);
  notes.push(`${tag}: the corona fades to sky at y=${fadesAt ?? 'never'} (stage top ${stageTop}, sky ${sky.toFixed(1)})`);
  await page.screenshot({ path: path.join(outDir, `${viewport.name}-Sun-corona-fit.png`) });

  check(errors.length === 0, `${tag}: page errors: ${errors.join(' | ')}`);
  await page.close();
}

async function lifecycleCases(context, viewport) {
  await toolsRowPickerCase(context, viewport);
  await bodyLockedCutCase(context, viewport);
  await rapidDoublePickCase(context, viewport);
  await pickDuringRevealCase(context, viewport);
  await pickDuringFadeCase(context, viewport);
  await liftWindowCase(context, viewport);
  await lostLiftEventCase(context, viewport);
  await escCascadeCase(context, viewport);
  await reducedMotionCase(context, viewport);
  await swapFreshnessCase(context, viewport);
  await inspectorPageCase(context, viewport);
  if (viewport.name === 'phone') await sheetDragCase(context, viewport);
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
      if (bodies.includes('Saturn')) await bandCase(context, viewport);
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
