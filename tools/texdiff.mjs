// Numeric gate for a candidate texture against the map it replaces: does the new
// map carry the same tone, contrast and orientation, or would the in-app swap pop?
// Eyeballing two near-identical albedo maps is unreliable — this puts numbers on
// it. Compares a REFERENCE (the shipped map) against a CANDIDATE, both decoded in
// a headless Chromium canvas (no native image library is installed).
//
//   node tools/texdiff.mjs <ref> <candidate> [--resize] [--max-mean=2] [--max-rms=6]
//
// Reports per-channel mean/std, RMS, p99 absolute error, clipped-pixel share, and
// a four-quadrant check that catches a flipped or rotated candidate (a vertically
// mirrored map still matches on every global statistic). Exits nonzero when the
// tone gate fails, so it can guard an asset build.
//
// --resize compares at the smaller of the two sizes; without it, differing
// dimensions are an error (comparing a downsample you did not ask for hides the
// very difference you are gating on).
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
const flag = (name) => process.argv.includes(`--${name}`);

const [refPath, candPath] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!refPath || !candPath) {
  console.error('[texdiff] usage: node tools/texdiff.mjs <ref> <candidate> [--resize] [--max-mean=2] [--max-rms=6]');
  process.exit(2);
}
const maxMean = Number(arg('max-mean', '2'));   // per channel, 0-255 units
const maxRms = Number(arg('max-rms', '6'));     // all channels, 0-255 units
const resize = flag('resize');

async function uri(p) {
  const buf = await readFile(p);
  const mime = p.endsWith('.png') ? 'image/png' : p.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

const browser = await chromium.launch({ headless: true });
let r;
try {
  const page = await browser.newPage();
  r = await page.evaluate(async ({ refUri, candUri, resize }) => {
    const load = (s) => new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('decode failed'));
      i.src = s;
    });
    const ref = await load(refUri), cand = await load(candUri);
    const dims = {
      ref: [ref.naturalWidth, ref.naturalHeight],
      cand: [cand.naturalWidth, cand.naturalHeight],
    };
    if (!resize && (dims.ref[0] !== dims.cand[0] || dims.ref[1] !== dims.cand[1])) {
      return { dims, sizeMismatch: true };
    }
    const w = Math.min(dims.ref[0], dims.cand[0]), h = Math.min(dims.ref[1], dims.cand[1]);
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const pixels = (img) => {
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      return ctx.getImageData(0, 0, w, h).data;
    };
    const A = pixels(ref), B = pixels(cand);

    const sum = [[0, 0, 0], [0, 0, 0]], sq = [[0, 0, 0], [0, 0, 0]];
    const clip = [0, 0];
    const hist = new Float64Array(256); // absolute per-channel error histogram
    let sqErr = 0, n = 0, samples = 0;
    for (let i = 0; i < A.length; i += 4) {
      let clipA = false, clipB = false;
      for (let k = 0; k < 3; k++) {
        const a = A[i + k], b = B[i + k];
        sum[0][k] += a; sq[0][k] += a * a;
        sum[1][k] += b; sq[1][k] += b * b;
        const e = a - b;
        sqErr += e * e;
        hist[e < 0 ? -e : e]++;
        samples++;
        if (a === 0 || a === 255) clipA = true;
        if (b === 0 || b === 255) clipB = true;
      }
      if (clipA) clip[0]++;
      if (clipB) clip[1]++;
      n++;
    }
    const stats = (j) => ({
      mean: sum[j].map((v) => v / n),
      std: sq[j].map((v, k) => Math.sqrt(Math.max(v / n - (sum[j][k] / n) ** 2, 0))),
    });
    const sRef = stats(0), sCand = stats(1);

    // p99 of |error| straight off the histogram (exact, no sort of 25M samples).
    let acc = 0, p99 = 255;
    for (let e = 0; e < 256; e++) {
      acc += hist[e];
      if (acc >= samples * 0.99) { p99 = e; break; }
    }

    // Quadrant luma means: a flipped or rotated candidate matches every global
    // statistic but permutes these. Same-index pairs must be the closest pairs.
    const quadLuma = (D) => {
      const q = [0, 0, 0, 0], cnt = [0, 0, 0, 0];
      for (let y = 0; y < h; y++) {
        const top = y < h / 2 ? 0 : 2;
        for (let x = 0; x < w; x++) {
          const idx = top + (x < w / 2 ? 0 : 1);
          const i = (y * w + x) * 4;
          q[idx] += 0.2126 * D[i] + 0.7152 * D[i + 1] + 0.0722 * D[i + 2];
          cnt[idx]++;
        }
      }
      return q.map((v, k) => v / cnt[k]);
    };
    const qRef = quadLuma(A), qCand = quadLuma(B);

    // Wrap seam: mean |left column - right column| over the map's own edges. An
    // equirectangular map wraps in longitude, so this stays small; a candidate
    // that jumps here was cropped or shifted.
    const seam = (D) => {
      let s = 0;
      for (let y = 0; y < h; y++) {
        const l = (y * w) * 4, rr = (y * w + w - 1) * 4;
        for (let k = 0; k < 3; k++) s += Math.abs(D[l + k] - D[rr + k]);
      }
      return s / (h * 3);
    };

    return {
      dims, w, h,
      ref: sRef, cand: sCand,
      rms: Math.sqrt(sqErr / samples),
      p99,
      clip: [(clip[0] / n) * 100, (clip[1] / n) * 100],
      quad: { ref: qRef, cand: qCand },
      seam: [seam(A), seam(B)],
    };
  }, { refUri: await uri(refPath), candUri: await uri(candPath), resize });
} finally {
  await browser.close();
}

const f = (v, d = 2) => v.toFixed(d);
const trio = (a, d = 2) => a.map((v) => f(v, d).padStart(7)).join(' ');

console.log(`[texdiff] ref  ${refPath} ${r.dims.ref.join('x')}`);
console.log(`[texdiff] cand ${candPath} ${r.dims.cand.join('x')}`);
if (r.sizeMismatch) {
  console.error('[texdiff] FAIL: dimensions differ — pass --resize to compare at the smaller size');
  process.exit(2);
}
console.log(`[texdiff] compared at ${r.w}x${r.h}`);
console.log(`[texdiff]                    R       G       B`);
console.log(`[texdiff] ref  mean   ${trio(r.ref.mean)}`);
console.log(`[texdiff] cand mean   ${trio(r.cand.mean)}`);
const meanDelta = r.ref.mean.map((v, k) => v - r.cand.mean[k]);
const stdDelta = r.ref.std.map((v, k) => v - r.cand.std[k]);
console.log(`[texdiff] mean delta  ${trio(meanDelta)}`);
console.log(`[texdiff] ref  std    ${trio(r.ref.std)}`);
console.log(`[texdiff] cand std    ${trio(r.cand.std)}`);
console.log(`[texdiff] std delta   ${trio(stdDelta)}`);
console.log(`[texdiff] RMS ${f(r.rms)}   p99 |err| ${r.p99}   clipped px ref ${f(r.clip[0])}%  cand ${f(r.clip[1])}%`);
console.log(`[texdiff] wrap seam   ref ${f(r.seam[0])}  cand ${f(r.seam[1])}`);

// Orientation: for each quadrant, the same-index candidate quadrant must be its
// closest match. Quadrants are compared as deviations from each image's own mean
// so a plain brightness offset (which the tone gate already reports) can't fake a
// flip. A tie inside `slack` is not evidence of one either — a low-contrast map
// has near-equal quadrants — so only a clearly better mismatch fails.
const slack = 1.0;
const qNames = ['NW', 'NE', 'SW', 'SE'];
const centre = (q) => { const m = q.reduce((a, b) => a + b, 0) / q.length; return q.map((v) => v - m); };
const qRef = centre(r.quad.ref), qCand = centre(r.quad.cand);
const orient = [];
for (let i = 0; i < 4; i++) {
  const d = qCand.map((v) => Math.abs(qRef[i] - v));
  let best = 0;
  for (let j = 1; j < 4; j++) if (d[j] < d[best]) best = j;
  orient.push({ i, best, self: d[i], bestD: d[best] });
  console.log(`[texdiff] quad ${qNames[i]}   ref ${f(r.quad.ref[i])} (${f(qRef[i])})  cand ${f(r.quad.cand[i])} (${f(qCand[i])})  delta ${f(d[i])}  closest ${qNames[best]}`);
}
const flipped = orient.filter((o) => o.best !== o.i && o.self > o.bestD + slack);

const fails = [];
meanDelta.forEach((v, k) => {
  if (Math.abs(v) > maxMean) fails.push(`mean ${'RGB'[k]} delta ${f(v)} > ${maxMean}`);
});
if (r.rms > maxRms) fails.push(`RMS ${f(r.rms)} > ${maxRms}`);
if (flipped.length) fails.push(`orientation: ${flipped.map((o) => `${qNames[o.i]}->${qNames[o.best]}`).join(', ')}`);

if (fails.length) {
  console.error(`[texdiff] FAIL: ${fails.join('; ')}`);
  process.exit(1);
}
console.log(`[texdiff] PASS (mean <= ${maxMean}, RMS <= ${maxRms})`);
