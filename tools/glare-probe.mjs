// The Sun's glare must be round on screen at every framing. This probe poses
// the Sun through the dev bridge (centred, at an edge, at a corner), captures
// the frame, and fits the glow's isophotes: the connected region brighter than
// each of several levels, grown from the glow's peak. For every isophote it
// reports the covariance axis ratio (an ellipse's long axis over its short
// one), the mirror asymmetry of the four half-extents through the peak, and
// the equivalent radius. A glow drawn round in the rectilinear source and then
// warped by the lens reads elongated across the radial direction and longer on
// the side nearer the frame edge; a glow authored in output pixels reads round
// and symmetric everywhere.
//
// The centred rows double as the SIZE BASELINE: the equivalent radius per
// level, per viewport, per path, written to glare-profile.json. A change to
// how the glare measures its pixels is judged against those numbers.
//
// Prereq: npm run dev -- --port 5174
//   node tools/glare-probe.mjs                         # report only
//   node tools/glare-probe.mjs --assert                # exit 1 on a failure
//   node tools/glare-probe.mjs --dist=3 --dsf=2        # a farther Sun, a Retina display
//   node tools/glare-probe.mjs --software              # SwiftShader (headless GPU gives black frames)
//
// Takes /tmp/moon-browser.lock (tools/browserLock.mjs).
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { takeBrowserLock } from './browserLock.mjs';

function arg(name, fallback) {
  const found = process.argv.find(value => value.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

const baseUrl = arg('url', 'http://localhost:5174');
const outDir = arg('out', 'planning/glare-probe');
const assertMode = process.argv.includes('--assert');
// An isophote's long axis over its short one, as a percentage over 1. The
// lens leaves a source-authored glow 10% oval half-way to a landscape edge
// and 16% in the reported screenshot; a round glow measures under 1% at the
// centre on this fit, so 2.5% leaves room for SwiftShader's and the
// starfield's noise without passing the defect.
const maxAxisErrorPct = Number(arg('max-axis-error-pct', '2.5'));
// |near − far| / (near + far) of the two half-extents on one axis through the
// peak, as a percentage. The defect reads 8–9% at the reported framing.
const maxAsymmetryPct = Number(arg('max-asymmetry-pct', '5'));
const distanceAu = Number(arg('dist', '1'));
const dsf = Number(arg('dsf', '1'));
const useSoftware = process.argv.includes('--software');
await mkdir(outDir, { recursive: true });

const viewports = [
  { name: 'desktop', width: 1600, height: 900 },
  { name: 'phone', width: 390, height: 844 },
];
// The bloom path is what ships; it also runs at half lens strength, where the
// blend is no longer conformal and a limb-hugging term can only stay round if
// it is measured on the sky rather than on the quad.
const modes = [
  { name: 'bloom', query: '', bloom: true, strengths: [1, 0.5] },
  { name: 'no-bloom', query: '', bloom: false, strengths: [1] },
  { name: 'no-float', query: '&nofloat=1', bloom: false, strengths: [1] },
  // The three-pass chain, where a lens pass of its own warps the scene before
  // the bloom reads it.
  { name: 'unfused', query: '&fused=0', bloom: true, strengths: [1] },
];
function posesFor(viewport) {
  const portrait = viewport.height > viewport.width;
  // The same edge and corner fractions the lens probe uses for its sphere.
  const edgeX = portrait ? 0.45 : 0.78;
  const cornerX = portrait ? 0.45 : 0.72;
  const cornerY = 0.68;
  return [
    { name: 'centre', x: 0, y: 0 },
    { name: 'left', x: -edgeX, y: 0 },
    { name: 'top', x: 0, y: cornerY },
    { name: 'top-right', x: cornerX, y: cornerY },
  ];
}
// Display-referred levels (0–255, max channel after a 5×5 box blur) from the
// saturated core out to the faint wash.
const levels = [200, 120, 60, 30, 15];

function slug(value) {
  return value.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
}

const release = await takeBrowserLock('glare');
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PW_CHROMIUM || undefined, // pinned-browser environments
  args: useSoftware
    ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
    : ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});

const failures = [];
const rows = [];
try {
  for (const viewport of viewports) {
    for (const mode of modes) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: dsf,
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
      page.on('pageerror', error => errors.push(String(error)));
      page.on('console', message => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await page.goto(`${baseUrl}/?auto=planetarium${mode.query}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => !!(window.__moon && window.__moon.ready && window.__moon.ready()),
        { timeout: 90000 },
      );
      await page.waitForFunction(() => {
        const loading = document.getElementById('loading-screen');
        return !loading || loading.classList.contains('hidden');
      }, { timeout: 90000 });
      await page.evaluate((bloom) => {
        window.__moon.setChrome(false);
        window.__moon.setBloom(bloom);
      }, mode.bloom);

      for (const strength of mode.strengths) {
        await page.evaluate((s) => window.__moon.setLens(s), strength);
        for (const pose of posesFor(viewport)) {
          const ok = await page.evaluate(
            ({ dist, x, y }) => window.__moon.frameSun(dist, 60, x, y),
            { dist: distanceAu, x: pose.x, y: pose.y },
          );
          if (!ok) throw new Error('frameSun dev hook unavailable');
          // The exposure glides toward the pose's target over ~1 s; the shape
          // measurement is level-relative, but a settled frame keeps the
          // baseline radii repeatable.
          await page.waitForTimeout(2500);
          await page.evaluate(() => new Promise(resolve => {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
          }));
          const sun = await page.evaluate(() => window.__moon.sunAppearance());
          const tag = `${viewport.name}/${mode.name}/s${strength}/${pose.name}`;
          const filename = `${viewport.name}-${mode.name}-s${strength}-${slug(pose.name)}.png`;
          const screenshot = await page.screenshot({ path: path.join(outDir, filename) });
          const expected = { x: sun.sunXPx * dsf, y: sun.sunYPx * dsf };

          const measurement = await page.evaluate(async ({ png, expectedPoint, levels: wanted }) => {
            const image = await new Promise((resolve, reject) => {
              const candidate = new Image();
              candidate.onload = () => resolve(candidate);
              candidate.onerror = reject;
              candidate.src = `data:image/png;base64,${png}`;
            });
            const canvas = document.createElement('canvas');
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(image, 0, 0);
            const width = canvas.width;
            const height = canvas.height;
            const pixels = ctx.getImageData(0, 0, width, height).data;
            // Max channel, then a 5×5 box blur: stars are a few pixels wide
            // and the glow is hundreds, so the blur drops them below any
            // level without moving an isophote.
            const lum = new Float32Array(width * height);
            for (let i = 0; i < width * height; i++) {
              lum[i] = Math.max(pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2]);
            }
            const horizontal = new Float32Array(width * height);
            for (let y = 0; y < height; y++) {
              for (let x = 0; x < width; x++) {
                let sum = 0;
                let n = 0;
                for (let dx = -2; dx <= 2; dx++) {
                  const sx = x + dx;
                  if (sx < 0 || sx >= width) continue;
                  sum += lum[y * width + sx];
                  n++;
                }
                horizontal[y * width + x] = sum / n;
              }
            }
            const smooth = new Float32Array(width * height);
            for (let y = 0; y < height; y++) {
              for (let x = 0; x < width; x++) {
                let sum = 0;
                let n = 0;
                for (let dy = -2; dy <= 2; dy++) {
                  const sy = y + dy;
                  if (sy < 0 || sy >= height) continue;
                  sum += horizontal[sy * width + x];
                  n++;
                }
                smooth[y * width + x] = sum / n;
              }
            }
            // The peak: the brightest smoothed value within 40 px of where the
            // controller says the Sun is (a bright star elsewhere must not
            // win), located at the centroid of the pixels within a count of
            // it. The core saturates into a flat plateau, and the first pixel
            // of a plateau sits at its edge, which would read as asymmetry.
            let peak = -1;
            const x0 = Math.round(expectedPoint.x);
            const y0 = Math.round(expectedPoint.y);
            for (let dy = -40; dy <= 40; dy++) {
              for (let dx = -40; dx <= 40; dx++) {
                const x = x0 + dx;
                const y = y0 + dy;
                if (x < 0 || x >= width || y < 0 || y >= height) continue;
                peak = Math.max(peak, smooth[y * width + x]);
              }
            }
            if (peak < 0) return { error: 'the Sun is off-frame' };
            let plateauN = 0;
            let plateauX = 0;
            let plateauY = 0;
            for (let dy = -40; dy <= 40; dy++) {
              for (let dx = -40; dx <= 40; dx++) {
                const x = x0 + dx;
                const y = y0 + dy;
                if (x < 0 || x >= width || y < 0 || y >= height) continue;
                if (smooth[y * width + x] < peak - 1) continue;
                plateauN++;
                plateauX += x;
                plateauY += y;
              }
            }
            const peakX = Math.round(plateauX / plateauN);
            const peakY = Math.round(plateauY / plateauN);

            const visited = new Uint8Array(width * height);
            const queue = new Int32Array(width * height);
            const isophotes = [];
            for (const level of wanted) {
              if (peak < level) continue;
              visited.fill(0);
              let head = 0;
              let tail = 0;
              const seed = peakY * width + peakX;
              queue[tail++] = seed;
              visited[seed] = 1;
              let count = 0;
              let sumX = 0; let sumY = 0; let sumXX = 0; let sumYY = 0; let sumXY = 0;
              let clipped = false;
              while (head < tail) {
                const index = queue[head++];
                const x = index % width;
                const y = (index - x) / width;
                count++;
                sumX += x; sumY += y; sumXX += x * x; sumYY += y * y; sumXY += x * y;
                if (x === 0 || y === 0 || x === width - 1 || y === height - 1) clipped = true;
                const neighbours = [[1, 0], [-1, 0], [0, 1], [0, -1]];
                for (const [dx, dy] of neighbours) {
                  const nx = x + dx;
                  const ny = y + dy;
                  if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
                  const next = ny * width + nx;
                  if (visited[next] || smooth[next] < level) continue;
                  visited[next] = 1;
                  queue[tail++] = next;
                }
              }
              const meanX = sumX / count;
              const meanY = sumY / count;
              const covXX = sumXX / count - meanX * meanX;
              const covYY = sumYY / count - meanY * meanY;
              const covXY = sumXY / count - meanX * meanY;
              const trace = covXX + covYY;
              const root = Math.sqrt(Math.max((covXX - covYY) ** 2 + 4 * covXY * covXY, 0));
              const eigenMax = (trace + root) / 2;
              const eigenMin = (trace - root) / 2;
              // The four half-extents through the peak, in pixels.
              const extent = (dx, dy) => {
                let n = 0;
                let x = peakX;
                let y = peakY;
                for (;;) {
                  x += dx; y += dy;
                  if (x < 0 || x >= width || y < 0 || y >= height) break;
                  if (smooth[y * width + x] < level) break;
                  n++;
                }
                return n;
              };
              const left = extent(-1, 0);
              const right = extent(1, 0);
              const up = extent(0, -1);
              const down = extent(0, 1);
              isophotes.push({
                level,
                count,
                clipped,
                equivalentRadiusPx: Math.sqrt(count / Math.PI),
                axisErrorPct: (Math.sqrt(eigenMax / Math.max(eigenMin, 1e-9)) - 1) * 100,
                longAxisDeg: (Math.atan2(2 * covXY, covXX - covYY) / 2) * 180 / Math.PI,
                verticalOverHorizontal: (up + down) / Math.max(left + right, 1),
                horizontalAsymmetryPct: (Math.abs(left - right) / Math.max(left + right, 1)) * 100,
                verticalAsymmetryPct: (Math.abs(up - down) / Math.max(up + down, 1)) * 100,
                extents: { left, right, up, down },
              });
            }
            return { peakX, peakY, peak, isophotes };
          }, { png: screenshot.toString('base64'), expectedPoint: expected, levels });

          if (measurement.error) {
            failures.push(`${tag}: ${measurement.error}`);
            continue;
          }
          for (const iso of measurement.isophotes) {
            const row = {
              viewport: viewport.name,
              mode: mode.name,
              strength,
              pose: pose.name,
              sunPx: { x: sun.sunXPx, y: sun.sunYPx, radius: sun.sunRadiusPx },
              ...iso,
            };
            rows.push(row);
            const flag = iso.clipped ? ' (touches the frame edge: shape not judged)' : '';
            console.log(
              `${viewport.name.padEnd(7)} ${mode.name.padEnd(8)} s=${String(strength).padEnd(3)} ${pose.name.padEnd(9)} ` +
              `L${String(iso.level).padStart(3)} r=${iso.equivalentRadiusPx.toFixed(1).padStart(6)}px ` +
              `axis=${iso.axisErrorPct.toFixed(2).padStart(5)}% at ${iso.longAxisDeg.toFixed(0).padStart(4)}° ` +
              `V/H=${iso.verticalOverHorizontal.toFixed(3)} asym=${iso.horizontalAsymmetryPct.toFixed(1)}%/${iso.verticalAsymmetryPct.toFixed(1)}%${flag}`,
            );
            if (iso.clipped) continue;
            if (iso.axisErrorPct > maxAxisErrorPct) failures.push(`${tag} L${iso.level}: axis ${iso.axisErrorPct.toFixed(2)}%`);
            if (iso.horizontalAsymmetryPct > maxAsymmetryPct) failures.push(`${tag} L${iso.level}: horizontal asymmetry ${iso.horizontalAsymmetryPct.toFixed(1)}%`);
            if (iso.verticalAsymmetryPct > maxAsymmetryPct) failures.push(`${tag} L${iso.level}: vertical asymmetry ${iso.verticalAsymmetryPct.toFixed(1)}%`);
          }
        }
      }
      for (const error of errors) failures.push(`${viewport.name}/${mode.name}: browser error: ${error}`);
      await context.close();
    }
  }
} finally {
  await browser.close();
  release();
}

await writeFile(path.join(outDir, 'glare-profile.json'), JSON.stringify({
  distanceAu, dsf, levels, rows,
}, null, 2));
console.log(`\n[glare-probe] ${rows.length} isophotes, ${failures.length} failures; captures and glare-profile.json: ${outDir}`);
if (failures.length) {
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  if (assertMode) process.exit(1);
}
