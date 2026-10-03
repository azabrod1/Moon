// The texture-unit census of Earth's surface programs, asserted on a real link.
//
// A program spends its ACTIVE samplers — the ones the compiler kept — and the
// surface shader relies on the compiler dropping some (the ground's deck block
// under the cloud field's archetype define), so the only honest count is GL's
// own ACTIVE_UNIFORMS list after a link. The app's DEV bridge builds and links
// every combination of the switch defines that change a sampler
// (src/planetarium/world/samplerCensus.ts: CLOUD_SHADOW, CLOUD_FIELD and
// CLOUD_LIGHT, the full and the half atmosphere tables, the ground with and
// without its water mask) and this battery holds them to:
//
//   - every program within the GPU's fragment texture units;
//   - Earth's ground with room left for the sea's wind maps (SEA_WIND_SLOT
//     units, a branch not landed yet) in every combination, counting the
//     field's two samplers as spent wherever the field is compiled — the
//     ground declares them now and reads them once its shadow read goes
//     through the field;
//   - the deck compiled with the field holds exactly the field's two samplers
//     more; the ground compiled with it drops its dead uCloudDetail tap and
//     holds nothing else new but those two;
//   - the live globe and deck, as this boot linked them, hold exactly what the
//     census row with their defines holds — the check that the census builds
//     the app's programs and not some other ones.
//
//   node tools/sampler-census.mjs --url=http://localhost:5744
//   node tools/sampler-census.mjs --url=… --extra='&cloudtiles=1&cloudshadows=1'
import { chromium } from 'playwright';
import { takeBrowserLock } from './browserLock.mjs';

function arg(name, fallback) {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}
const baseUrl = arg('url', 'http://localhost:5174');
const extra = arg('extra', '');
const FIELD_SAMPLERS = ['uCloudPages', 'uCloudPageTable'];

const failures = [];
const fail = (message) => { failures.push(message); console.log(`  FAIL  ${message}`); };

const releaseLock = await takeBrowserLock('sampler-census');
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    try {
      localStorage.setItem('planetarium-help-seen', '1');
      localStorage.setItem('planetarium-surface-hint-seen', '1');
    } catch { /* storage blocked — harmless */ }
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.goto(`${baseUrl}/?auto=planetarium&quality=medium${extra}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 180000 });
  await page.waitForFunction(() => {
    const loading = document.getElementById('loading-screen');
    return !loading || loading.classList.contains('hidden');
  }, { timeout: 180000 }).catch(() => {});

  // The deck's live program is the one with its relief: wait for it to land.
  let census = null;
  for (let i = 0; i < 40; i++) {
    census = await page.evaluate(() => window.__moon.samplerCensus());
    const deck = census.live.find((l) => l.surface === 'deck');
    if (deck?.samplers?.includes('normalMap')) break;
    await page.waitForTimeout(500);
  }

  const key = (r) => `${r.surface} ${r.tables} ${r.waterMask ? 'water' : 'dry'} [${r.defines.join(' ')}]`;
  console.log(`# sampler census @ ${baseUrl}${extra ? ` (${extra})` : ''}`);
  console.log(`  fragment texture units ${census.maxUnits}, sea-wind slot ${census.seaWindSlot}`);
  // A ground compiled with the field declares its two samplers before it
  // reads them: what it will spend counts them.
  const spentBy = (r) => new Set([...r.samplers, ...(r.defines.includes('CLOUD_FIELD') ? FIELD_SAMPLERS : [])]).size;
  for (const r of census.rows) {
    const spent = spentBy(r);
    const later = spent > r.samplers.length ? ` (${spent} reading the field)` : '';
    const room = r.surface === 'ground' && r.waterMask ? `, +${census.seaWindSlot} sea wind = ${spent + census.seaWindSlot}` : '';
    console.log(`  ${key(r).padEnd(52)} ${String(r.samplers.length).padStart(2)}${later}${room}  ${r.samplers.join(' ')}`);
  }

  const find = (surface, defines, tables, waterMask) => census.rows.find((r) => r.surface === surface
    && r.tables === tables && r.waterMask === waterMask
    && r.defines.length === defines.length && defines.every((d) => r.defines.includes(d)));
  const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  for (const r of census.rows) {
    const n = r.samplers.length;
    const field = r.defines.includes('CLOUD_FIELD');
    const spent = spentBy(r);
    if (n === 0) fail(`${key(r)}: no linked program`);
    if (spent > census.maxUnits) fail(`${key(r)}: ${spent} samplers, over the ${census.maxUnits} units`);
    if (r.surface === 'ground' && r.waterMask && spent + census.seaWindSlot > census.maxUnits) {
      fail(`${key(r)}: ${spent} samplers leave no room for the sea wind's ${census.seaWindSlot}`);
    }
    if (!field) {
      for (const s of FIELD_SAMPLERS) if (r.samplers.includes(s)) fail(`${key(r)}: ${s} active without the field`);
      continue;
    }
    const without = find(r.surface, r.defines.filter((d) => d !== 'CLOUD_FIELD'), r.tables, r.waterMask);
    if (!without) { fail(`${key(r)}: no row without the field to hold it to`); continue; }
    if (r.surface === 'deck') {
      // The deck reads the field: exactly its two samplers more.
      if (!same(r.samplers, [...without.samplers, ...FIELD_SAMPLERS])) {
        fail(`${key(r)}: holds ${r.samplers.join(' ')}, wanted ${key(without)} and the field's two`);
      }
    } else {
      // The ground knows it is not the deck: uCloudDetail is gone, and the
      // field's two are all it may have gained.
      if (r.samplers.includes('uCloudDetail')) fail(`${key(r)}: the deck's uCloudDetail is still active`);
      const base = without.samplers.filter((s) => s !== 'uCloudDetail');
      const gained = r.samplers.filter((s) => !base.includes(s));
      if (gained.some((s) => !FIELD_SAMPLERS.includes(s)) || base.some((s) => !r.samplers.includes(s))) {
        fail(`${key(r)}: holds ${r.samplers.join(' ')}, wanted ${base.join(' ')} and at most the field's two`);
      }
    }
  }
  for (const l of census.live) {
    const row = find(l.surface, l.defines, l.tables, l.surface === 'ground');
    const what = `live ${l.surface} ${l.tables} [${l.defines.join(' ')}]`;
    console.log(`  ${what.padEnd(52)} ${l.samplers ? String(l.samplers.length).padStart(2) : ' -'}  ${l.samplers ? l.samplers.join(' ') : 'not linked'}`);
    if (!l.samplers) { fail(`${what}: not linked`); continue; }
    if (!row) { fail(`${what}: no census row with these defines`); continue; }
    if (JSON.stringify(l.samplers) !== JSON.stringify(row.samplers)) {
      fail(`${what}: holds ${l.samplers.join(' ')}, the census row ${row.samplers.join(' ')}`);
    }
  }
  if (census.live.length < 2) fail(`only ${census.live.length} live surface(s) found`);
  if (pageErrors.length) fail(`${pageErrors.length} page error(s): ${pageErrors[0]}`);
  await context.close();
} finally {
  await browser.close();
  releaseLock();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nPASS');
process.exit(failures.length ? 1 : 0);
