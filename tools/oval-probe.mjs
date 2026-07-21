// Assertion-based GPU lens integration probe. A solid diagnostic sphere is
// rendered against black, its connected geometric limb is circle-fit, and the
// script fails on shape, placement, shader, or runtime regressions.
//
// Prereq: npm run dev -- --port 5174
//   node tools/oval-probe.mjs
//   node tools/oval-probe.mjs --url=http://localhost:5174 --out=planning/lens-probe
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

function arg(name, fallback) {
  const found = process.argv.find(value => value.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

const baseUrl = arg('url', 'http://localhost:5174');
const outDir = arg('out', 'planning/lens-probe');
const maxRmsPx = Number(arg('max-rms', '2'));
const maxAxisErrorPct = Number(arg('max-axis-error-pct', '0.5'));
const maxCentreErrorPx = Number(arg('max-centre-error', '2'));
await mkdir(outDir, { recursive: true });

const viewports = [
  { name: 'desktop', width: 1600, height: 900 },
  { name: 'phone', width: 390, height: 844 },
];
const modes = [
  { name: 'bloom', query: '', bloom: true },
  { name: 'no-bloom', query: '', bloom: false },
  { name: 'no-float', query: '&nofloat=1', bloom: false },
];
function posesFor(viewport) {
  const portrait = viewport.height > viewport.width;
  const edgeX = portrait ? 0.45 : 0.78;
  const cornerX = portrait ? 0.45 : 0.72;
  const cornerY = 0.68;
  return [
    { name: 'centre', x: 0, y: 0 },
    // Near-limb composition from the reported screenshots: the full globe is
    // still measurable, but it fills most of the short viewport dimension.
    {
      name: 'large-centre', x: 0, y: 0,
      angularRadiusDeg: portrait ? 12 : 22,
    },
    { name: 'left', x: -edgeX, y: 0 },
    { name: 'right', x: edgeX, y: 0 },
    { name: 'top-left', x: -cornerX, y: cornerY },
    { name: 'top-right', x: cornerX, y: cornerY },
    { name: 'bottom-left', x: -cornerX, y: -cornerY },
    { name: 'bottom-right', x: cornerX, y: -cornerY },
  ];
}

function slug(value) {
  return value.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
}

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=metal',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader',
  ],
});

const failures = [];
const rows = [];
try {
  for (const viewport of viewports) {
    for (const mode of modes) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
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
      page.on('pageerror', error => errors.push(String(error)));
      page.on('console', message => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await page.goto(`${baseUrl}/?auto=planetarium${mode.query}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => !!(window.__moon && window.__moon.ready && window.__moon.ready()),
        { timeout: 45000 },
      );
      await page.waitForFunction(() => {
        const loading = document.getElementById('loading-screen');
        return !loading || loading.classList.contains('hidden');
      }, { timeout: 45000 });
      await page.waitForFunction(() => {
        const loading = document.getElementById('loading-screen');
        return !loading || Number(getComputedStyle(loading).opacity) < 0.01;
      }, { timeout: 5000 });
      await page.evaluate((bloom) => {
        window.__moon.setChrome(false);
        window.__moon.setAutoExposure(false);
        window.__moon.setBloom(bloom);
      }, mode.bloom);

      for (const pose of posesFor(viewport)) {
        const ok = await page.evaluate(
          ({ x, y, angularRadiusDeg }) =>
            window.__moon.diagnosticSphere(x, y, 60, angularRadiusDeg ?? 6),
          pose,
        );
        if (!ok) throw new Error('diagnosticSphere dev hook unavailable');
        await page.evaluate(() => new Promise(resolve => {
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        }));
        const screenshot = await page.screenshot();
        const filename = `${viewport.name}-${mode.name}-${slug(pose.name)}.png`;
        await page.screenshot({ path: path.join(outDir, filename) });
        const expected = {
          x: (pose.x * 0.5 + 0.5) * viewport.width,
          y: (-pose.y * 0.5 + 0.5) * viewport.height,
        };
        const measurement = await page.evaluate(async ({ png, expectedPoint }) => {
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
          const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          const width = canvas.width;
          const height = canvas.height;
          const lit = (x, y) => {
            if (x < 0 || x >= width || y < 0 || y >= height) return false;
            const index = (y * width + x) * 4;
            return pixels[index] + pixels[index + 1] + pixels[index + 2] > 120;
          };
          let seedX = Math.round(expectedPoint.x);
          let seedY = Math.round(expectedPoint.y);
          if (!lit(seedX, seedY)) {
            let found = false;
            for (let radius = 1; radius <= 20 && !found; radius++) {
              for (let dy = -radius; dy <= radius && !found; dy++) {
                for (let dx = -radius; dx <= radius; dx++) {
                  if (lit(seedX + dx, seedY + dy)) {
                    seedX += dx;
                    seedY += dy;
                    found = true;
                    break;
                  }
                }
              }
            }
            if (!found) return { error: 'no lit component at requested centre' };
          }

          const visited = new Uint8Array(width * height);
          const queue = new Int32Array(width * height);
          let head = 0;
          let tail = 0;
          const seed = seedY * width + seedX;
          queue[tail++] = seed;
          visited[seed] = 1;
          const boundary = [];
          let count = 0;
          let minX = width;
          let maxX = -1;
          let minY = height;
          let maxY = -1;
          let sumX = 0;
          let sumY = 0;
          let sumXX = 0;
          let sumYY = 0;
          let sumXY = 0;
          const neighbours = [[1, 0], [-1, 0], [0, 1], [0, -1]];
          while (head < tail) {
            const index = queue[head++];
            const x = index % width;
            const y = Math.floor(index / width);
            count++;
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
            sumX += x;
            sumY += y;
            sumXX += x * x;
            sumYY += y * y;
            sumXY += x * y;
            let edge = false;
            for (const [dx, dy] of neighbours) {
              const nx = x + dx;
              const ny = y + dy;
              if (!lit(nx, ny)) {
                edge = true;
                continue;
              }
              const next = ny * width + nx;
              if (!visited[next]) {
                visited[next] = 1;
                queue[tail++] = next;
              }
            }
            if (edge) boundary.push([x, y]);
          }

          // Kåsa least-squares circle: x²+y² + A·x + B·y + C = 0.
          const matrix = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
          for (const [x, y] of boundary) {
            const row = [x, y, 1];
            const rhs = -(x * x + y * y);
            for (let r = 0; r < 3; r++) {
              for (let c = 0; c < 3; c++) matrix[r][c] += row[r] * row[c];
              matrix[r][3] += row[r] * rhs;
            }
          }
          for (let pivot = 0; pivot < 3; pivot++) {
            let best = pivot;
            for (let row = pivot + 1; row < 3; row++) {
              if (Math.abs(matrix[row][pivot]) > Math.abs(matrix[best][pivot])) best = row;
            }
            [matrix[pivot], matrix[best]] = [matrix[best], matrix[pivot]];
            const divisor = matrix[pivot][pivot];
            if (Math.abs(divisor) < 1e-9) return { error: 'singular circle fit' };
            for (let c = pivot; c < 4; c++) matrix[pivot][c] /= divisor;
            for (let row = 0; row < 3; row++) {
              if (row === pivot) continue;
              const factor = matrix[row][pivot];
              for (let c = pivot; c < 4; c++) matrix[row][c] -= factor * matrix[pivot][c];
            }
          }
          const [a, b, c] = matrix.map(row => row[3]);
          const centreX = -a / 2;
          const centreY = -b / 2;
          const radiusPx = Math.sqrt(Math.max(centreX * centreX + centreY * centreY - c, 0));
          let squaredError = 0;
          for (const [x, y] of boundary) {
            const residual = Math.hypot(x - centreX, y - centreY) - radiusPx;
            squaredError += residual * residual;
          }
          // Filled-component covariance gives a quantization-stable ellipse-axis
          // ratio (unlike integer bbox width/height, where one pixel is already
          // 0.6% on a 166 px phone limb).
          const meanX = sumX / count;
          const meanY = sumY / count;
          const covXX = sumXX / count - meanX * meanX;
          const covYY = sumYY / count - meanY * meanY;
          const covXY = sumXY / count - meanX * meanY;
          const trace = covXX + covYY;
          const root = Math.sqrt(Math.max((covXX - covYY) ** 2 + 4 * covXY * covXY, 0));
          const eigenMax = (trace + root) / 2;
          const eigenMin = (trace - root) / 2;
          return {
            count,
            boundaryCount: boundary.length,
            widthPx: maxX - minX + 1,
            heightPx: maxY - minY + 1,
            centreX,
            centreY,
            radiusPx,
            rmsPx: Math.sqrt(squaredError / Math.max(boundary.length, 1)),
            axisErrorPct: (Math.sqrt(eigenMax / Math.max(eigenMin, 1e-9)) - 1) * 100,
          };
        }, { png: screenshot.toString('base64'), expectedPoint: expected });

        if (measurement.error) {
          failures.push(`${viewport.name}/${mode.name}/${pose.name}: ${measurement.error}`);
          continue;
        }
        const axisErrorPct = measurement.axisErrorPct;
        const centreErrorPx = Math.hypot(
          measurement.centreX - expected.x,
          measurement.centreY - expected.y,
        );
        const row = {
          viewport: viewport.name,
          mode: mode.name,
          pose: pose.name,
          axisErrorPct,
          rmsPx: measurement.rmsPx,
          centreErrorPx,
          diameter: `${measurement.widthPx}x${measurement.heightPx}`,
        };
        rows.push(row);
        console.log(
          `${viewport.name.padEnd(7)} ${mode.name.padEnd(8)} ${pose.name.padEnd(12)} ` +
          `${row.diameter.padStart(9)} axis=${axisErrorPct.toFixed(3)}% ` +
          `rms=${measurement.rmsPx.toFixed(3)}px centre=${centreErrorPx.toFixed(3)}px`,
        );
        if (axisErrorPct > maxAxisErrorPct) failures.push(`${viewport.name}/${mode.name}/${pose.name}: axis ${axisErrorPct.toFixed(3)}%`);
        if (measurement.rmsPx > maxRmsPx) failures.push(`${viewport.name}/${mode.name}/${pose.name}: RMS ${measurement.rmsPx.toFixed(3)}px`);
        if (centreErrorPx > maxCentreErrorPx) failures.push(`${viewport.name}/${mode.name}/${pose.name}: centre ${centreErrorPx.toFixed(3)}px`);
      }
      for (const error of errors) failures.push(`${viewport.name}/${mode.name}: browser error: ${error}`);
      await context.close();
    }
  }

  // ---- marker-behind-limb integration case (REAL pipeline, strength 1) ------
  // A REAL planet is framed off-axis; its analytic foreground-occlusion disc
  // (collectForegroundDiscs, lens-projected) is read live, and a REAL marker
  // sprite is placed at that disc's predicted limb ± margin and culled by the
  // REAL analytic path (isScreenPointOccluded) exactly as a planet beacon is —
  // so the DRAWN marker pixels gate on the analytic-disc sizing, not GPU depth.
  // Runs with bloom off so the bright marker can't bloom a halo past the limb.
  {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
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
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`${baseUrl}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => !!(window.__moon && window.__moon.ready && window.__moon.ready()),
      { timeout: 45000 },
    );
    await page.waitForFunction(() => {
      const loading = document.getElementById('loading-screen');
      return !loading || loading.classList.contains('hidden');
    }, { timeout: 45000 });
    await page.evaluate(() => {
      window.__moon.setLens(1);
      window.__moon.setBloom(false);
      window.__moon.setAutoExposure(false);
      window.__moon.setTimeMs(Date.parse('2026-07-20T00:00:00Z'));
      // Markers ON so the label pass populates the foreground occluder discs.
      window.__moon.setChrome(true);
      window.__moon.frame('Jupiter', 0.42, 20, 6, 0.5, 0.2);
    });
    await page.waitForTimeout(1000);
    await page.evaluate(() => window.__moon.setShipVisible(false));
    await page.waitForTimeout(300);
    const disc = await page.evaluate(() => window.__moon.planetOccluderDisc('Jupiter'));
    const tag = 'marker-limb';
    const countRedNear = (b64, cx, cy, r) => page.evaluate(async ([data, x0, y0, rad]) => {
      const img = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = `data:image/png;base64,${data}`; });
      const cv = document.createElement('canvas');
      cv.width = img.naturalWidth; cv.height = img.naturalHeight;
      const g = cv.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const W = cv.width, H = cv.height, px = g.getImageData(0, 0, W, H).data;
      let n = 0;
      const x1 = Math.max(0, Math.floor(x0 - rad)), x2 = Math.min(W - 1, Math.ceil(x0 + rad));
      const y1 = Math.max(0, Math.floor(y0 - rad)), y2 = Math.min(H - 1, Math.ceil(y0 + rad));
      for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) {
        if ((x - x0) ** 2 + (y - y0) ** 2 > rad * rad) continue;
        const i = (y * W + x) * 4;
        if (px[i] > 120 && px[i + 1] < 70 && px[i + 2] < 70) n++;
      }
      return n;
    }, [b64, cx, cy, r]);
    if (!disc) {
      failures.push(`${tag}: no analytic occluder disc for Jupiter (label pass / markers off?)`);
    } else {
      let ux = disc.screenX - disc.viewport.w / 2;
      let uy = disc.screenY - disc.viewport.h / 2;
      const un = Math.hypot(ux, uy) || 1;
      ux /= un; uy /= un;
      const margin = Math.max(0.04 * disc.radiusPx, 4);
      const inside = { x: disc.screenX + ux * (disc.radiusPx - margin), y: disc.screenY + uy * (disc.radiusPx - margin) };
      const outside = { x: disc.screenX + ux * (disc.radiusPx + margin), y: disc.screenY + uy * (disc.radiusPx + margin) };
      const depthAU = disc.distFromCamera * 2;
      const inRes = await page.evaluate((a) => window.__moon.probeLimbMarker(a.x, a.y, a.d), { x: inside.x, y: inside.y, d: depthAU });
      await page.waitForTimeout(300);
      const inRed = await countRedNear((await page.screenshot()).toString('base64'), inside.x, inside.y, 24);
      const outRes = await page.evaluate((a) => window.__moon.probeLimbMarker(a.x, a.y, a.d), { x: outside.x, y: outside.y, d: depthAU });
      await page.waitForTimeout(300);
      const outRed = await countRedNear((await page.screenshot()).toString('base64'), outside.x, outside.y, 24);
      await page.screenshot({ path: path.join(outDir, 'marker-limb.png') });
      rows.push({ viewport: 'desktop', mode: 'no-bloom', pose: tag });
      console.log(
        `desktop no-bloom ${tag.padEnd(12)} disc R=${disc.radiusPx.toFixed(1)}px ` +
        `inside occluded=${inRes?.occluded} redPx=${inRed} · outside occluded=${outRes?.occluded} redPx=${outRed}`,
      );
      if (!(inRes?.occluded === true && inRed <= 4)) failures.push(`${tag}: inside limb not culled (occluded=${inRes?.occluded} redPx=${inRed})`);
      if (!(outRes?.occluded === false && outRed >= 20)) failures.push(`${tag}: outside limb not drawn (occluded=${outRes?.occluded} redPx=${outRed})`);
    }
    for (const error of errors) failures.push(`${tag}: browser error: ${error}`);
    await context.close();
  }
} finally {
  await browser.close();
}

console.log(`\n[oval-probe] ${rows.length} measurements, ${failures.length} failures; captures: ${outDir}`);
if (failures.length) {
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exit(1);
}
