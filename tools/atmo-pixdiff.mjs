// Pixel diff for the atmosphere goldens: how far apart two captures are, per
// channel, and WHERE.
//
// The where is the part worth having. A handful of pixels moving by 1/255 is
// what a longer shader compiles to; the same count gathered into a ring, a
// band or a spot is a picture that changed. So the report carries a histogram
// of the step sizes and the radial spread of the moved pixels about their own
// centroid, as a fraction of how far the furthest of them reaches. Scattered
// evenly over a disc's AREA that fraction is 0.707, because area grows as r^2;
// gathered in a ring at the disc's edge it approaches 1.
//
//   node tools/atmo-pixdiff.mjs a.png b.png [c.png d.png ...]
//
// Beside that, the two frames' own levels: the mean channel over every pixel
// that is not black in either, and the signed difference between them. A drift
// report says how MUCH moved; this says which way, which is the question when
// the two captures are a tier A/B rather than a before and after — a tier that
// takes light off the night side shows up here as a negative mean and nowhere
// else, because a hemisphere going quietly darker moves no pixel very far.
//
// No browser: the PNGs are decoded here.
import { readFile } from 'node:fs/promises';
import { decodePng } from './pngDecode.mjs';

const pairs = process.argv.slice(2).filter((a) => !a.startsWith('--'));

/** Median of an unsorted array of numbers. */
function median(values) {
  if (!values.length) return 0;
  const sorted = Float64Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

for (let i = 0; i < pairs.length; i += 2) {
  const [pathA, pathB] = [pairs[i], pairs[i + 1]];
  const [a, b] = await Promise.all([readFile(pathA).then(decodePng), readFile(pathB).then(decodePng)]);
  if (a.width !== b.width || a.height !== b.height) throw new Error(`${pathA}: size mismatch`);
  const histogram = new Map();
  const driftX = [];
  const driftY = [];
  const spots = [];
  let differing = 0;
  let worst = 0;
  let sum = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  let litCount = 0;
  const meanA = [0, 0, 0];
  const meanB = [0, 0, 0];
  for (let p = 0; p < a.width * a.height; p++) {
    const ia = p * a.channels;
    const ib = p * b.channels;
    let d = 0;
    let lit = 0;
    for (let c = 0; c < 3; c++) {
      d = Math.max(d, Math.abs(a.pixels[ia + c] - b.pixels[ib + c]));
      lit = Math.max(lit, a.pixels[ia + c], b.pixels[ib + c]);
    }
    if (lit > 0) {
      litCount++;
      for (let c = 0; c < 3; c++) {
        meanA[c] += a.pixels[ia + c];
        meanB[c] += b.pixels[ib + c];
      }
    }
    const px = p % a.width;
    const py = (p - px) / a.width;
    worst = Math.max(worst, d);
    if (d === 0) continue;
    differing++;
    sum += d;
    histogram.set(d, (histogram.get(d) ?? 0) + 1);
    driftX.push(px);
    driftY.push(py);
    x0 = Math.min(x0, px); x1 = Math.max(x1, px);
    y0 = Math.min(y0, py); y1 = Math.max(y1, py);
    if (d >= 3 && spots.length < 6) {
      spots.push([px, py, d,
        [a.pixels[ia], a.pixels[ia + 1], a.pixels[ia + 2]],
        [b.pixels[ib], b.pixels[ib + 1], b.pixels[ib + 2]]]);
    }
  }
  const total = a.width * a.height;
  console.log(`${pathA.split('/').pop()}: ${differing}/${total} px differ, worst ${worst}/255`
    + `, mean over differing ${(differing ? sum / differing : 0).toFixed(2)}`);
  if (litCount) {
    const fmt = (m) => m.map((v) => (v / litCount).toFixed(2)).join('/');
    const delta = [0, 1, 2].map((c) => (meanB[c] - meanA[c]) / litCount);
    console.log(`   level over ${litCount} non-black px: A ${fmt(meanA)}  B ${fmt(meanB)}`
      + `  B-A ${delta.map((v) => (v >= 0 ? '+' : '') + v.toFixed(2)).join('/')}`);
  }
  if (!differing) continue;
  // The histogram is the point at the small end — "1348 of them moved by one
  // step" is a different finding from "1348 moved" — and noise at the large
  // end, where a real change spreads over every step there is.
  const steps = [...histogram.entries()].sort((p, q) => p[0] - q[0]);
  const shown = steps.slice(0, 12).map(([step, count]) => `${step}:${count}`).join(' ');
  console.log(`   steps ${shown}${steps.length > 12 ? ` ... +${steps.length - 12} more` : ''}`);
  // About the moved pixels' OWN centroid, not the frame's: what is drifting is
  // usually a body that is nowhere near the middle of the capture.
  const cx = driftX.reduce((x, y) => x + y, 0) / differing;
  const cy = driftY.reduce((x, y) => x + y, 0) / differing;
  const radii = driftX.map((x, k) => Math.hypot(x - cx, driftY[k] - cy));
  // Spread over the whole argument list to Math.max would overflow the stack
  // on a frame where a hundred thousand pixels moved.
  let reach = 0;
  for (const r of radii) reach = Math.max(reach, r);
  const shape = median(radii) / reach;
  console.log(`   centroid ${cx.toFixed(0)},${cy.toFixed(0)}  reach ${reach.toFixed(1)} px`
    + `  median radius ${median(radii).toFixed(1)} px = ${shape.toFixed(3)} of it`
    + `  (0.707 = spread over the area, ~1 = a ring at the edge)`);
  console.log(`   bbox ${[x0, y0, x1, y1].join(',')}`);
  if (spots.length) console.log(`   samples ${JSON.stringify(spots)}`);
}
