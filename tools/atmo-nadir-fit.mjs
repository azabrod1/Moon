// What the LUT tier does to the ground, fitted out of a golden PAIR.
//
// The two captures at one pose differ only by the air, so across the frame
//
//     lut = T * analytic + S
//
// holds pixel by pixel with T the transmittance of the column in front of the
// ground and S the light that column sends. Fitting the pair recovers both
// without a probe, a uniform readback or a second shader — and it is the only
// measurement that sees the COMPOSITE, which is what a viewer sees: the cloud
// deck draws over the globe at 0.35 alpha, so what lands on screen is
// a(T_c C + S_c) + (1-a)(T_g G + S_g) and the fit reports the mixture.
//
// Reading it: the slope comes back as the GROUND's own transmittance whatever
// the deck does, because substituting G = (analytic - aC)/(1-a) leaves the
// deck's contribution in the constant. The intercept is the mixture,
// a*S_c + (1-a)*S_g, so intercept/S_g is 1 only if the deck's own segment is as
// deep as the ground's. A deck drawn at 1.01 R sits above the whole air and
// makes S_c zero, which pins the ratio at 1-a = 0.65 no matter what the tables
// say.
//
// No browser: the PNGs are decoded here (zlib plus the five PNG filters) and
// three's ACES tone map is inverted analytically, so this runs against goldens
// on disk with no GPU and no server.
//
//   node tools/atmo-nadir-fit.mjs tools/goldens/atmosphere/nadir-1.05r
//   node tools/atmo-nadir-fit.mjs tools/goldens/atmosphere/oblique-1.05r
//
// The pair is <stem>.analytic.png and <stem>.lut.png. `--exposure` must match
// the one the capture was pinned at (1, as the goldens are).
import { readFileSync } from 'node:fs';
import { decodePng } from './pngDecode.mjs';

const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const stems = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const EXPOSURE = Number(arg('exposure', '1'));
// Channels this close to the ends carry no information: 255 is clipped by the
// tone map's own saturate and 0 is below the quantisation.
const HIGH = Number(arg('high', '250'));
const LOW = Number(arg('low', '2'));

// three's ACESFilmicToneMapping, inverted. Forward: multiply by
// exposure/0.6, ACESInputMat, RRTAndODTFit, ACESOutputMat, saturate. The fit
// per channel is a ratio of two quadratics, so each step here is exact.
const ACES_IN = [
  [0.59719, 0.35458, 0.04823],
  [0.07600, 0.90834, 0.01566],
  [0.02840, 0.13383, 0.83777],
];
const ACES_OUT = [
  [1.60475, -0.53108, -0.07367],
  [-0.10208, 1.10813, -0.00605],
  [-0.00327, -0.07276, 1.07602],
];

function invert3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}
const ACES_IN_INV = invert3(ACES_IN);
const ACES_OUT_INV = invert3(ACES_OUT);
const apply3 = (m, v) => [0, 1, 2].map((r) => m[r][0] * v[0] + m[r][1] * v[1] + m[r][2] * v[2]);

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** Invert RRTAndODTFit for one channel: y(0.983729x^2 + 0.432951x + 0.238081)
 *  = x^2 + 0.0245786x - 0.000090537. */
function unfit(y) {
  const a = 1 - 0.983729 * y;
  const b = 0.0245786 - 0.432951 * y;
  const c = -0.000090537 - 0.238081 * y;
  if (Math.abs(a) < 1e-12) return -c / b;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return NaN;
  const root = Math.sqrt(disc);
  const x1 = (-b + root) / (2 * a);
  const x2 = (-b - root) / (2 * a);
  // The forward map is monotonic on the physical branch; take the non-negative
  // root, and the smaller one where both are.
  const candidates = [x1, x2].filter((x) => x >= 0).sort((p, q) => p - q);
  return candidates.length ? candidates[0] : NaN;
}

/** One 8-bit sRGB pixel back to the scene-linear radiance that produced it. */
function toRadiance(r8, g8, b8) {
  const display = [r8 / 255, g8 / 255, b8 / 255].map(srgbToLinear);
  const fitted = apply3(ACES_OUT_INV, display);
  const pre = fitted.map(unfit);
  if (pre.some((v) => !Number.isFinite(v))) return null;
  const linear = apply3(ACES_IN_INV, pre);
  return linear.map((v) => (v * 0.6) / EXPOSURE);
}

if (!stems.length) {
  console.log('usage: node tools/atmo-nadir-fit.mjs <golden stem> [...]');
  process.exit(1);
}

for (const stem of stems) {
  const a = decodePng(readFileSync(`${stem}.analytic.png`));
  const b = decodePng(readFileSync(`${stem}.lut.png`));
  if (a.width !== b.width || a.height !== b.height) throw new Error(`${stem}: size mismatch`);
  const sums = [0, 1, 2].map(() => ({ n: 0, sx: 0, sy: 0, sxx: 0, sxy: 0 }));
  for (let p = 0; p < a.width * a.height; p++) {
    const ia = p * a.channels;
    const ib = p * b.channels;
    // Saturated or black in EITHER frame carries no slope.
    const bytes = [a.pixels[ia], a.pixels[ia + 1], a.pixels[ia + 2],
      b.pixels[ib], b.pixels[ib + 1], b.pixels[ib + 2]];
    if (bytes.some((v) => v > HIGH) || bytes.every((v) => v < LOW)) continue;
    const ra = toRadiance(bytes[0], bytes[1], bytes[2]);
    const rb = toRadiance(bytes[3], bytes[4], bytes[5]);
    if (!ra || !rb) continue;
    for (let c = 0; c < 3; c++) {
      if (a.pixels[ia + c] < LOW && b.pixels[ib + c] < LOW) continue;
      const s = sums[c];
      s.n++;
      s.sx += ra[c];
      s.sy += rb[c];
      s.sxx += ra[c] * ra[c];
      s.sxy += ra[c] * rb[c];
    }
  }
  console.log(`\n${stem}  ${a.width}x${a.height}, exposure ${EXPOSURE}`);
  const slopes = [];
  const intercepts = [];
  for (let c = 0; c < 3; c++) {
    const { n, sx, sy, sxx, sxy } = sums[c];
    const denom = n * sxx - sx * sx;
    const slope = (n * sxy - sx * sy) / denom;
    const intercept = (sy - slope * sx) / n;
    slopes.push(slope);
    intercepts.push(intercept);
    console.log(`  ${'RGB'[c]}  n ${String(n).padStart(6)}   slope (fitted T) ${slope.toFixed(5)}`
      + `   intercept (fitted S) ${intercept.toFixed(6)}`);
  }
  console.log(`  slope     ${slopes.map((v) => v.toFixed(4)).join(' / ')}`);
  console.log(`  intercept ${intercepts.map((v) => v.toFixed(5)).join(' / ')}`);
}
