// E2E assertion for the arrival warm-up (committed-destination tier prefetch).
//
// Drives a REAL cruise teleport to the Moon (travelTo → commitBodyPick →
// arriveThen, the exact path a deck "Travel" pick takes) and asserts the
// destination's LOD work starts at arrival commit instead of mid-glide:
//
//  - the 4K relief (moon-normal) request is the clean discriminator: nothing
//    but the warm-up can issue it at commit — before this change it required
//    the glide to grow the disc past 15% of the viewport (~2.5 s of approach);
//  - the colour ladder (4K then 8K albedo) walks to the top after commit;
//  - the arrival veil still lifts (the warm-up must never extend it), the
//    revealed frame isn't black, and the page logs no errors.
//
// Run: node tools/warmup-e2e.mjs [url]   (dev server must be up;
//      PW_CHROMIUM=<path> for pinned-browser environments)
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:5173/?auto=planetarium';

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM || undefined, // pinned-browser environments
  // Functional assertion, not a perf capture: deterministic software GL is
  // fine here (a shared container has no GPU to engage).
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.addInitScript(() => {
  localStorage.clear();
  sessionStorage.clear();
  indexedDB.deleteDatabase('orbital-sim-storage');
});

/** @type {{path: string, atMs: number}[]} */
const tierFetches = [];
page.on('request', (req) => {
  const m = req.url().match(/textures\/((?:4k|8k)\/[^?#]*)/);
  if (m) tierFetches.push({ path: m[1], atMs: Date.now() });
});
const errors = [];
page.on('pageerror', (err) => errors.push(`pageerror: ${err}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
});

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  console.error('tier fetches seen:', tierFetches);
  if (errors.length) console.error('page errors:', errors);
  process.exitCode = 1;
  return browser.close().then(() => process.exit());
};
const moonDistAU = () =>
  page.evaluate(() => globalThis.__moon.probe('Moon')?.distToBodyAU ?? null);

await page.goto(url);
await page.waitForFunction(() => globalThis.__moon?.ready?.(), null, { timeout: 90_000 });

const preCommit = tierFetches.filter((f) => f.path.includes('moon'));
const preJumpDist = await moonDistAU();
const commitAtMs = Date.now();
const committed = await page.evaluate(() => globalThis.__moon.travelTo('Moon'));
if (!committed) await fail('travelTo("Moon") returned false');
// The teleport pose applies inside the veiled action, two (possibly slow)
// frames after the commit call — wait for the position snap, then read the
// arrival standoff distance. Reading immediately would take the BOOT
// position as d0 and turn every later ratio into noise.
let d0 = null;
let poseAtMs = commitAtMs;
{
  const poseDeadline = Date.now() + 20_000;
  while (Date.now() < poseDeadline) {
    const d = await moonDistAU();
    if (d !== null && preJumpDist !== null && d < preJumpDist * 0.5) {
      d0 = d;
      poseAtMs = Date.now();
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
if (d0 === null) await fail('teleport pose never applied (distance never snapped in)');

// Watch the ladder land, recording the ship→Moon distance at each request so
// the log shows the fetches fired at the standoff, not after an approach.
const want = ['4k/moon-normal.webp', '4k/moon.webp', '8k/moon.ktx2'];
/** @type {Record<string, {atMs: number, distAU: number}>} */
const seen = {};
const deadline = Date.now() + 30_000;
while (Date.now() < deadline && Object.keys(seen).length < want.length) {
  for (const w of want) {
    if (!seen[w] && tierFetches.some((f) => f.path === w && f.atMs >= commitAtMs)) {
      seen[w] = { atMs: tierFetches.find((f) => f.path === w).atMs, distAU: await moonDistAU() };
    }
  }
  await new Promise((r) => setTimeout(r, 50));
}
for (const w of want) {
  if (!seen[w]) await fail(`${w} was never fetched after the travel commit`);
}
// The discriminator: the relief fetch belongs to the commit, not the glide.
// Only the warm-up can issue it at the standoff — the on-screen trigger
// needs the disc past 15% of the viewport, which the glide reaches only
// after closing to ~0.55x the commit distance. Time is a soft signal (a
// loaded machine stretches the veil's two-frame deferral); distance is the
// physics, so it arbitrates.
const relief = seen['4k/moon-normal.webp'];
const reliefMs = relief.atMs - poseAtMs;
if (reliefMs > 1_500 && !(relief.distAU > 0.6 * d0)) {
  await fail(
    `4K relief requested ${reliefMs} ms after the arrival pose at ${(relief.distAU / d0).toFixed(2)}x the standoff — that's glide-trigger territory, not commit territory`,
  );
}

// Veil-neutrality: the cover (if this cold arrival raised one) must lift on
// its own schedule — the warm-up may never pin it.
await page
  .waitForFunction(
    () => !document.getElementById('arrival-veil')?.classList.contains('covering'),
    null,
    { timeout: 6_000 },
  )
  .catch(() => fail('arrival veil still covering 6 s after commit'));

await page.waitForTimeout(2_500); // let the warm pump drain the uploads
// Blackness check via in-page canvas readback (no PNG dep needed out here).
const lum = await page.evaluate(async (b64) => {
  const img = new Image();
  img.src = `data:image/png;base64,${b64}`;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
  return sum / (d.length / 4) / 3;
}, (await page.screenshot()).toString('base64'));
if (lum < 2) await fail(`revealed frame reads black (mean channel ${lum.toFixed(2)})`);
if (errors.length) await fail(`page errors during the run:\n  ${errors.join('\n  ')}`);

console.log('PASS');
console.log(`  pre-commit moon tier fetches: ${preCommit.length}`);
console.log(`  distance at commit: ${d0?.toExponential(3)} AU`);
for (const w of want) {
  const s = seen[w];
  const ratio = d0 ? (s.distAU / d0).toFixed(2) : '?';
  console.log(`  ${w}: +${s.atMs - commitAtMs} ms, at ${ratio}× the commit distance`);
}
console.log(`  revealed frame mean channel: ${lum.toFixed(1)}`);
await browser.close();
