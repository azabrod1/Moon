// The ocean glint as LINEAR radiance, measured on the app's own GPU against a
// CPU reference of the same equations, at the astronaut's view of the sea.
//
//   node tools/glint-probe.mjs                       # 400 km up, the Sun 10° high, aimed at the mirror point, then 8° and 16° down
//   node tools/glint-probe.mjs --deps=mirror,6,12,20 --sunelev=5 --wind=5 --label=calm
//   node tools/glint-probe.mjs --alt=35786 --deps=90 --fov=20 --label=geo    # the geostationary view, straight down
//   node tools/glint-probe.mjs --look --extra='&seawindmap=http://localhost:5174/planning/candidate.png'   # a grey map from gen-seawind --png
//   node tools/glint-probe.mjs --meter --assert                    # the highlight meter's prediction against the pixels, the shipped maps
//   node tools/glint-probe.mjs --meter --clouds --bearings=180,90,0,270 --deps=mirror --run=12 --assert
//   node tools/glint-probe.mjs --meter --azimuth=180 --deps=mirror --assert   # turned away from the beam: the meter must ask nothing
//
// Method. The sea is given ONE wind everywhere — a raw byte wind map served
// from memory through `?seawindmap=`, so the sea is one Beckmann
// lobe at Cox-Munk's mean-square slope for that wind — the clouds are hidden
// (the deck and the sea's cut under it), the ground's detail synthesis and the
// sector tiles are off, the clock is frozen and the exposure pinned. At each
// pose the scene target is read back as float RGBA (`__moon.readScene`: before
// the lens, the bloom, the exposure and the tone curve) twice, with the mirror
// term at its full scale (`__moon.glint({keep: 1})`) and with it removed
// (`keep: 0`); the difference is the glint as the app draws it, carrying
// everything the app does to the lobe afterwards — the cap, the limb
// darkening, the air. The same pair is read with the ground's air off
// (`__moon.atmoTier('analytic')`), which separates the air's share.
//
// The reference evaluates, per scene pixel along the same ray, the Sun's
// irradiance (the point light's intensity and colour, its distance falloff)
// times N·L times water's Fresnel at the half vector times the Beckmann lobe
// at that wind with Beckmann's own Smith shadowing (Walter's rational G1): the
// physics, with no cap, no limb darkening and no air. Beside it, what the
// app's chain SHOULD give before the cap, the darkening and the air (GGX's
// correlated Smith on the Beckmann lobe, which is what the shader runs), so
// the ratio app/reference is attributed: the Smith mismatch, the limb
// darkening 1 - 0.3 (1 - mu), the cap, the air. three's multiple-scattering
// compensation on the specular term is left out of both: at water's F0 it is
// under a ten-thousandth of the single-scatter term.
//
// The chain in force is read off `__moon.glint()` (seaBeam, sunPath): the
// "expected" column takes Beckmann's Smith under the beam chain and GGX's
// under the old one, the limb-darkening factor is applied to it only under
// the old chain, and a fourth pair of readings with the Sun's path switched
// off (`__moon.glint({sunPath: false})`) measures the Sun-path factor the
// reference cannot compute without the atmosphere tables, which is then
// folded into the expected value. So "app-air-off / expected" reads 1 under
// either chain when the shader matches its own equations and no cap engaged.
//
// Per pose: the peak (scene units, and in whites — a white Lambert disc under
// the Sun), the profile along the principal line (the frame's centre column:
// from the nadir side up to the horizon, with the Sun's azimuth straight
// ahead) as app / reference at each view angle, the beam's half-maximum width
// along and across that line (degrees of view, and km of ground along it),
// the share of the beam's pixels the tone curve puts at or above 0.95 of white
// at the pinned exposure (the clip fraction), the share held at the cap, and
// the air's transmittance on the glint from the on/off pair. Writes
// <out>/report.json, <out>/report.txt and a PNG of each pose (the frame as
// the app shows it, air on, clouds hidden). No bar yet: this is the
// instrument; the energy chain's commit sets the numbers it must hold.
//
// `--look` is the picture arm: the shipped maps (or `--extra='&seawindmap=…'`),
// the clouds shown, the tiles on, the same poses, PNGs only — the frames that
// go beside the ISS photographs.
//
// `--meter` is the highlight meter's arm (planetarium/highlightMeter): the
// SHIPPED maps, because the meter predicts from coarse copies of them and a
// served wind would be a different sea from the one it reads; the clouds
// hidden unless `--clouds` (then the deck is drawn and the meter's cloud keep
// at the peak is what it must track). At each pose it reads
// `__moon.glintMeter()` and holds the predicted drawn peak — its value, its
// place along the ground and on the frame, its half-maximum widths and its
// share of the frame — against the keep-on minus keep-off readback, maximum
// channel per pixel; then releases the exposure pin, lets the meter settle
// and reads the exposure the renderer applies, so the brightest beam pixel
// after exposure is held against the meter's target with the non-glint share
// at that pixel reported; then flips the switch off and reads exactly one.
// `--bearings=a,b,c` runs the poses at several bearings (a cloud lands over
// one of them where the sheet's bearing is clear); `--run=<s>` ends with the
// clock at 1000x for that long at the last pose, the exposure released, the
// telemetry read every frame, and reports the largest per-frame change of
// the exposure in stops against the meter's own rate (a coastline sliding
// under the mirror point must not step it); `--assert` fails on the bars
// written at the report's end.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { takeBrowserLock } from './browserLock.mjs';

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
const flag = (name) => process.argv.includes(`--${name}`);

const url = arg('url', 'http://localhost:5174');
const look = flag('look');
const meter = flag('meter');
const showClouds = flag('clouds');
const assertBars = flag('assert');
const runSeconds = Number(arg('run', '0'));
const label = arg('label', look ? 'look' : meter ? 'meter' : 'probe');
const outDir = arg('out', path.join('/tmp/moon-glint-probe', label));
const extra = arg('extra', '');
const timeIso = arg('time', '2026-10-03T16:40:00Z');
const windMs = Number(arg('wind', '7'));
const altitudeKm = Number(arg('alt', '400'));
const sunElevDeg = Number(arg('sunelev', '10'));
const bearingDeg = Number(arg('bearing', '180'));
const bearings = arg('bearings', '').split(',').map((s) => Number(s.trim())).filter((v) => Number.isFinite(v));
if (!bearings.length) bearings.push(bearingDeg);
const azimuthDeg = Number(arg('azimuth', '0'));
const fovDeg = Number(arg('fov', '40'));
const depressions = arg('deps', 'mirror,8,16').split(',').map((s) => s.trim()).filter(Boolean);
const W = Number(arg('w', '1200'));
const H = Number(arg('h', '800'));
const exposure = Number(arg('exposure', '1'));
const settle = Number(arg('settle', look ? '7000' : '2500'));
const bootTimeout = Number(arg('boot', '240000'));
const useGpu = !flag('software');

// The app's own numbers (world/seaWind, world/surfaceShading), stated here so
// the reference is independent of the module graph. The Sun's light and the
// sea's cap, knee and cap are READ from the running app at boot (the DEV
// bridge's sunLight() and glint()), because they moved once already — the
// cream Sun at 3 became a neutral one at the 1.4 baseline — and a reference
// carrying the old numbers would have graded the app against a Sun it no
// longer has. These are the fallbacks if the bridge has no answer.
let SUN_LIGHT_INTENSITY = 3.8616;
const SUN_LIGHT_DECAY = 0.3;
let SUN_LIGHT_COLOR = 0xffffff;
const COX_MUNK_SLOPE_CALM = 0.003;
const COX_MUNK_SLOPE_PER_MS = 0.00512;
const SEA_WIND_MAX_MS = 16;
const SEA_WATER_IOR = 1.33;
const SEA_WATER_F0 = ((SEA_WATER_IOR - 1) / (SEA_WATER_IOR + 1)) ** 2;
let OCEAN_GLINT_CAP = 1.75;
const LIMB_DARKENING_EARTH = 0.3;
const AU_KM = 149_597_870.7;
const LUMA = [0.2126, 0.7152, 0.0722];

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const sunColour = [16, 8, 0].map((shift) => srgbToLinear(((SUN_LIGHT_COLOR >> shift) & 0xff) / 255));
const lum = (c) => c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
// A white Lambert disc under the Sun, in scene units: three's irradiance is
// N·L times the light's colour and its Lambert term is albedo / pi.
const whiteLum = (SUN_LIGHT_INTENSITY / Math.PI) * lum(sunColour);

// The wind map the probe serves: one byte a texel, the wind over 16 m/s, a
// width twice the height. 64 x 32 is the smallest shape the loader takes that
// still has a mip chain to walk, and every texel is the same byte.
const windByte = Math.round((windMs / SEA_WIND_MAX_MS) * 255);
const windMap = Buffer.alloc(64 * 32, windByte);
const windAsDrawn = (windByte / 255) * SEA_WIND_MAX_MS;
const mss = COX_MUNK_SLOPE_CALM + COX_MUNK_SLOPE_PER_MS * windAsDrawn;

// three's ACES filmic fit, as the tone curve applies it (exposure / 0.6 in).
const ACES_IN = [[0.59719, 0.35458, 0.04823], [0.07600, 0.90834, 0.01566], [0.02840, 0.13383, 0.83777]];
const ACES_OUT = [[1.60475, -0.53108, -0.07367], [-0.10208, 1.10813, -0.00605], [-0.00327, -0.07276, 1.07602]];
const mulMat3 = (m, v) => m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
function acesFilmic(c, exp) {
  let v = mulMat3(ACES_IN, c.map((x) => (x * exp) / 0.6));
  v = v.map((x) => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.4329510) + 0.238081));
  return mulMat3(ACES_OUT, v).map((x) => Math.min(Math.max(x, 0), 1));
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
// three's Matrix4.toArray is column-major: element c*4+k is column c, row k.
const mulMat4 = (m, v) => [0, 1, 2, 3].map((k) => m[k] * v[0] + m[4 + k] * v[1] + m[8 + k] * v[2] + m[12 + k] * v[3]);

/** The world ray through scene pixel (i, j), j counted from the BOTTOM row. */
function rayFor(camera, i, j, w, h) {
  const ndcX = ((i + 0.5) / w) * 2 - 1;
  const ndcY = ((j + 0.5) / h) * 2 - 1;
  const p = mulMat4(camera.projectionMatrixInverse, [ndcX, ndcY, 1, 1]);
  const local = norm([p[0] / p[3], p[1] / p[3], p[2] / p[3]]);
  const m = camera.matrixWorld;
  return norm([
    m[0] * local[0] + m[4] * local[1] + m[8] * local[2],
    m[1] * local[0] + m[5] * local[1] + m[9] * local[2],
    m[2] * local[0] + m[6] * local[1] + m[10] * local[2],
  ]);
}

/** Project a scene point to a pixel (x right, y up from the bottom), or null behind the camera. */
function projectPoint(camera, point, w, h) {
  const m = camera.matrixWorld;
  // The camera sits at the origin: the inverse of its rotation is the transpose.
  const local = [
    m[0] * point[0] + m[1] * point[1] + m[2] * point[2],
    m[4] * point[0] + m[5] * point[1] + m[6] * point[2],
    m[8] * point[0] + m[9] * point[1] + m[10] * point[2],
  ];
  const inv = camera.projectionMatrixInverse;
  // The projection itself is not handed over; invert the inverse's action on
  // the view direction by a two-step search over the frame instead would be
  // slow, so the perspective is reconstructed from the camera's own numbers.
  const f = 1 / Math.tan((camera.fov * Math.PI) / 360);
  void inv;
  if (local[2] >= 0) return null;
  const x = (f / camera.aspect) * (local[0] / -local[2]);
  const y = f * (local[1] / -local[2]);
  return { x: ((x + 1) / 2) * w, y: ((y + 1) / 2) * h, ndcX: x, ndcY: y };
}

/** Walter's rational fit of Beckmann's Smith G1, a = 1 / (alpha tan theta). */
function beckmannG1(cosTheta, alpha) {
  const sin = Math.sqrt(Math.max(1 - cosTheta * cosTheta, 0));
  if (sin < 1e-9) return 1;
  const a = cosTheta / (alpha * sin);
  if (a >= 1.6) return 1;
  return (3.535 * a + 2.181 * a * a) / (1 + 2.276 * a + 2.577 * a * a);
}

/**
 * The reference at one pixel: the glint's radiance per channel as the physics
 * gives it, the app's own chain's expected value, the limb-darkening factor
 * the app applies, and the geometry, or null for the sky.
 */
function referenceAt(pose, camera, i, j, w, h) {
  const d = rayFor(camera, i, j, w, h);
  const B = pose.bodyScene;
  const R = pose.radiusAU;
  const db = dot(d, B);
  const disc = db * db - (dot(B, B) - R * R);
  if (disc < 0) return null;
  const t = db - Math.sqrt(disc);
  if (t <= 0) return null;
  const P = scale(d, t);
  const N = scale(sub(P, B), 1 / R);
  const V = scale(d, -1);
  const toSun = sub(pose.sunScene, P);
  const sunDist = Math.hypot(...toSun);
  const L = scale(toSun, 1 / sunDist);
  const Hv = norm([L[0] + V[0], L[1] + V[1], L[2] + V[2]]);
  const NdotL = Math.max(dot(N, L), 0);
  const NdotV = Math.max(dot(N, V), 0);
  const NdotH = Math.max(dot(N, Hv), 0);
  const VdotH = Math.max(dot(V, Hv), 0);
  const groundAngleDeg = (Math.acos(Math.min(Math.max(dot(N, pose.up), -1), 1)) * 180) / Math.PI;
  const viewAngleDeg = (Math.acos(Math.min(Math.max(dot(d, pose.aim), -1), 1)) * 180) / Math.PI
    * (dot(d, pose.up) > dot(pose.aim, pose.up) ? 1 : -1);
  const limb = 1 - LIMB_DARKENING_EARTH * (1 - NdotV);
  const geometry = { groundAngleDeg, viewAngleDeg, slantKm: t * AU_KM, NdotL, NdotV, NdotH, VdotH, limb };
  if (NdotL <= 0) return { ref: [0, 0, 0], app: [0, 0, 0], ...geometry };
  const E = scale(sunColour, SUN_LIGHT_INTENSITY / Math.max(sunDist ** SUN_LIGHT_DECAY, 0.01));
  const tail = 2 ** ((-5.55473 * VdotH - 6.98316) * VdotH);
  const F = SEA_WATER_F0 + (1 - SEA_WATER_F0) * tail;
  const cos2 = Math.max(NdotH * NdotH, 1e-6);
  const D = Math.exp((cos2 - 1) / (cos2 * mss)) / (Math.PI * mss * cos2 * cos2);
  const alpha = Math.sqrt(mss);
  const vBeck = (beckmannG1(NdotL, alpha) * beckmannG1(NdotV, alpha)) / Math.max(4 * NdotL * NdotV, 1e-6);
  const gv = NdotL * Math.sqrt(mss + (1 - mss) * NdotV * NdotV);
  const gl = NdotV * Math.sqrt(mss + (1 - mss) * NdotL * NdotL);
  const vGgx = 0.5 / Math.max(gv + gl, 1e-6);
  const common = NdotL * F * D;
  return { ref: scale(E, common * vBeck), app: scale(E, common * (chain.seaBeam ? vBeck : vGgx)), ...geometry };
}

/** The beam chain's shoulder (world/surfaceShading OCEAN_BEAM_KNEE/CAP) and
 *  its inverse: what a drawn value was before the shoulder held it. The
 *  shoulder is per channel and invertible below the cap; a channel at the
 *  cap itself has no finite preimage and is reported at the cap. */
function unshoulder(y, knee, cap) {
  const range = cap - knee;
  return y.map((v) => {
    if (v <= knee) return v;
    const t = 1 - (v - knee) / range;
    return t <= 1e-6 ? cap + range * 13.8 : knee - range * Math.log(t);
  });
}

/** Half-maximum extent of a 1-D profile about its peak, in index units. */
function halfMaxExtent(values) {
  let peak = 0;
  let at = -1;
  for (let i = 0; i < values.length; i++) if (values[i] > peak) { peak = values[i]; at = i; }
  if (at < 0 || peak <= 0) return null;
  let lo = at;
  while (lo > 0 && values[lo - 1] >= peak / 2) lo--;
  let hi = at;
  while (hi < values.length - 1 && values[hi + 1] >= peak / 2) hi++;
  return { peak, at, lo, hi };
}

function decodeRead(read) {
  const bytes = Buffer.from(read.data, 'base64');
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Float32Array(copy);
}

/** The whole scene target as one float array, read in bands so no single
 *  message carries the frame. */
async function readScene(page) {
  const head = await page.evaluate(() => window.__moon.readScene({ w: 1, h: 1 }));
  if (!head) throw new Error('readScene: no scene target (is the float composer up?)');
  const { width, height } = head;
  const data = new Float32Array(width * height * 4);
  const bands = 4;
  for (let b = 0; b < bands; b++) {
    const y = Math.floor((b * height) / bands);
    const h = Math.floor(((b + 1) * height) / bands) - y;
    const part = await page.evaluate(([yy, hh]) => window.__moon.readScene({ y: yy, h: hh }), [y, h]);
    data.set(decodeRead(part), y * width * 4);
  }
  return { width, height, data, exposure: head.exposure, camera: head.camera, toneMapping: head.toneMapping };
}

// The chain in force, read once the page is up: which Smith term the app's
// own equations carry, and whether the limb darkening touches the glint.
const chain = { seaBeam: true, sunPath: true };

const waitFrames = (page, n = 3) => page.evaluate((k) => new Promise((resolve) => {
  const step = (left) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
  step(k);
}), n);

/** The angle between two pixels' rays, degrees: an extent's width as the
 *  camera sees it, wherever in the frame it sits. */
function angleBetweenPixels(camera, i0, j0, i1, j1, w, h) {
  const a = rayFor(camera, i0, j0, w, h);
  const b = rayFor(camera, i1, j1, w, h);
  return (Math.acos(Math.min(Math.max(dot(a, b), -1), 1)) * 180) / Math.PI;
}

const telemetryOf = (page) => page.evaluate(() => {
  const t = window.__moon.glintMeter();
  const ex = window.__moon.exposure();
  return { ...t, applied: ex.current, sunMeter: ex.target, auto: ex.auto };
});

/**
 * One pose of the meter arm: the prediction against the drawn beam, the
 * exposure hand-off, the switch. Returns the pose's summary; bars broken are
 * pushed onto `failures`.
 */
async function meterPose(page, pose, poseLabel, png, capture, failures) {
  // The meter needs its maps; the first approach decodes them.
  await page.waitForFunction(() => {
    const t = window.__moon.glintMeter();
    return !!t.maps && t.maps.ready.length === 3 && t.hold !== 'maps decoding';
  }, null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await waitFrames(page, 3);
  const tel = await telemetryOf(page);
  const onFull = await capture(1);
  await page.screenshot({ path: png });
  const onBase = await capture(0);
  await page.evaluate(() => window.__moon.glint({ keep: 1 }));
  const { width, height, camera } = onFull;
  const px = (frame, i, j) => { const k = (j * width + i) * 4; return [frame.data[k], frame.data[k + 1], frame.data[k + 2]]; };
  // The drawn beam: the difference, its maximum channel per pixel.
  const drawn = new Float32Array(width * height);
  let M = 0; let im = 0; let jm = 0; let cm = 0;
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
    const a = px(onFull, i, j); const b = px(onBase, i, j);
    let v = 0; let c = 0;
    for (let k = 0; k < 3; k++) { const d = a[k] - b[k]; if (d > v) { v = d; c = k; } }
    drawn[j * width + i] = v;
    if (v > M) { M = v; im = i; jm = j; cm = c; }
  }
  const geo = M > 0 ? referenceAt(pose, camera, im, jm, width, height) : null;
  // Where the prediction puts the peak: along the principal line at its
  // ground angle, projected through the pose's own camera.
  const th = (tel.groundAngleDeg * Math.PI) / 180;
  const n = [0, 1, 2].map((k) => pose.up[k] * Math.cos(th) + pose.sunAzimuth[k] * Math.sin(th));
  const q = [0, 1, 2].map((k) => pose.bodyScene[k] + pose.radiusAU * n[k]);
  const predictedPixel = tel.hold === 'metering' ? projectPoint(camera, q, width, height) : null;
  const pixelGap = predictedPixel ? Math.hypot(predictedPixel.x - (im + 0.5), predictedPixel.y - (jm + 0.5)) : null;
  // The drawn beam AT the prediction (the brightest pixel within 7 px of it):
  // under a broken deck the frame's maximum can be a speck through a hole
  // elsewhere, which the coarse cloud map cannot see and the meter does not
  // meter for; the local reading says whether the prediction is right where
  // it points.
  let atPrediction = null;
  if (predictedPixel) {
    const ci = Math.round(predictedPixel.x - 0.5), cj = Math.round(predictedPixel.y - 0.5);
    let v = 0;
    for (let j = Math.max(0, cj - 7); j <= Math.min(height - 1, cj + 7); j++) for (let i = Math.max(0, ci - 7); i <= Math.min(width - 1, ci + 7); i++) v = Math.max(v, drawn[j * width + i]);
    atPrediction = v;
  }
  // The extents through the measured peak, in degrees of view.
  const column = []; for (let j = 0; j < height; j++) column.push(drawn[j * width + im]);
  const row = []; for (let i = 0; i < width; i++) row.push(drawn[jm * width + i]);
  const ea = halfMaxExtent(column); const ec = halfMaxExtent(row);
  const alongDeg = ea ? angleBetweenPixels(camera, im, ea.lo, im, ea.hi, width, height) : null;
  const acrossDeg = ec ? angleBetweenPixels(camera, ec.lo, jm, ec.hi, jm, width, height) : null;
  let over = 0; for (let k = 0; k < drawn.length; k++) if (drawn[k] >= M / 2) over++;
  const coverage = over / (width * height);
  const total = px(onFull, im, jm);
  const nonGlintShare = total[cm] > 0 ? 1 - drawn[jm * width + im] / total[cm] : null;
  // The hand-off: the exposure pin released (near and ratio re-pinned), the
  // meter given time to settle at its rates, the renderer's exposure read.
  await page.evaluate(() => { window.__moon.pinCapture(null); window.__moon.pinCapture({ near: 1e-7, pixelRatio: 1 }); });
  await page.waitForTimeout(3000);
  await waitFrames(page, 3);
  const hand = await telemetryOf(page);
  const afterExposure = M * hand.applied;
  const core = acesFilmic(total, hand.applied);
  // The frame as the meter exposes it, beside the pinned one.
  await page.screenshot({ path: png.replace(/\.png$/, '-metered.png') });
  // The switch: off is exactly one, at once.
  const off = await page.evaluate(() => new Promise((resolve) => {
    window.__moon.glintMeter({ on: false });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const t = window.__moon.glintMeter();
      const ex = window.__moon.exposure();
      window.__moon.glintMeter({ on: true });
      resolve({ hold: t.hold, exposure: t.exposure, applied: ex.current, sunMeter: ex.target });
    }));
  }));
  await page.evaluate((e) => window.__moon.pinCapture({ near: 1e-7, exposure: e, pixelRatio: 1 }), exposure);
  const ratio = (a, b) => (a > 0 && b > 0 ? a / b : null);
  const summary = {
    key: poseLabel, pose, png,
    meter: {
      hold: tel.hold, maps: tel.maps, costUs: tel.costUs, knobs: tel.knobs,
      predicted: {
        drawnMax: tel.drawnMax, drawn: tel.drawn, carried: tel.carried, groundAngleDeg: tel.groundAngleDeg,
        halfWidthAlongDeg: tel.halfWidthAlongDeg, halfWidthAcrossDeg: tel.halfWidthAcrossDeg, coverage: tel.coverage,
        sample: tel.peakSample, pixel: predictedPixel, target: tel.target,
      },
      measured: {
        drawnMax: M, channel: cm, pixel: { x: im + 0.5, y: jm + 0.5 }, atPrediction, groundAngleDeg: geo?.groundAngleDeg ?? null,
        viewAngleDeg: geo?.viewAngleDeg ?? null, halfMaxAlongDeg: alongDeg, halfMaxAcrossDeg: acrossDeg, coverage,
        alongExtent: ea ? { lo: ea.lo, hi: ea.hi } : null, acrossExtent: ec ? { lo: ec.lo, hi: ec.hi } : null,
        pixelGapFromPrediction: pixelGap, totalAtPeak: total, nonGlintShare,
      },
      ratios: {
        value: ratio(M, tel.drawnMax), valueAtPrediction: ratio(atPrediction, tel.drawnMax), along: ratio(alongDeg, 2 * tel.halfWidthAlongDeg), across: ratio(acrossDeg, 2 * tel.halfWidthAcrossDeg),
        coverage: ratio(coverage, tel.coverage), groundAngleGapDeg: geo ? geo.groundAngleDeg - tel.groundAngleDeg : null,
      },
      handoff: {
        meterExposure: hand.exposure, meterTarget: hand.target, sunMeter: hand.sunMeter, applied: hand.applied, auto: hand.auto,
        peakAfterExposure: afterExposure, peakOverTarget: ratio(afterExposure, hand.knobs.target), coreThroughToneCurve: Math.max(...core) * 255,
        atFloor: hand.exposure <= hand.knobs.floor + 1e-6, fadedIn: tel.coverage >= hand.knobs.fadeHi,
      },
      off,
    },
  };
  // The bars. A beam under the fade's own threshold of the frame — a speck
  // through a hole in the deck, a sparkle from far away — is one the meter
  // holds at one by construction, so its value and place are reported and
  // only that hold is checked.
  const m = summary.meter;
  const fail = (what) => failures.push(`${poseLabel}: ${what}`);
  const speck = coverage < tel.knobs.fadeLo || tel.coverage < tel.knobs.fadeLo;
  summary.meter.speck = speck;
  if (tel.hold === 'metering' && M > 0 && speck) {
    if (!(m.handoff.meterTarget > 0.9)) fail(`a speck (coverage ${coverage.toFixed(4)} measured, ${tel.coverage.toFixed(4)} predicted) yet the meter asked ${m.handoff.meterTarget.toFixed(3)}`);
  } else if (tel.hold === 'metering' && M > 0) {
    if (!(m.ratios.value > 0.75 && m.ratios.value < 1.33)) fail(`drawn peak measured/predicted ${m.ratios.value?.toFixed(3)} outside 0.75..1.33`);
    if (predictedPixel && ea && ec && !(predictedPixel.y >= ea.lo && predictedPixel.y <= ea.hi + 1 && predictedPixel.x >= ec.lo && predictedPixel.x <= ec.hi + 1)) {
      fail(`predicted peak at (${predictedPixel.x.toFixed(0)}, ${predictedPixel.y.toFixed(0)}) outside the measured half-maximum extent (cols ${ec.lo}..${ec.hi}, rows ${ea.lo}..${ea.hi})`);
    }
    if (!(m.ratios.coverage > 0.4 && m.ratios.coverage < 2.5)) fail(`coverage measured/predicted ${m.ratios.coverage?.toFixed(3)} outside 0.4..2.5`);
    const h = m.handoff;
    if (h.auto && h.sunMeter >= 0.999 && !h.atFloor && h.fadedIn && h.meterTarget < 1 && Math.abs(h.meterExposure - h.meterTarget) < 0.02) {
      if (!(h.peakOverTarget > 0.85 && h.peakOverTarget < 1.18)) fail(`brightest beam pixel after exposure ${h.peakAfterExposure.toFixed(3)} against the target ${h.knobs?.target ?? hand.knobs.target}: ratio ${h.peakOverTarget?.toFixed(3)} outside 0.85..1.18`);
    }
  } else if (tel.hold === 'metering' && M <= 0) {
    fail('the meter metered a beam the readback does not show');
  } else if (tel.hold !== 'metering' && M > tel.knobs.target) {
    fail(`the meter held (${tel.hold}) with a drawn beam at ${M.toFixed(2)} in the frame`);
  }
  if (!(off.hold === 'off' && off.exposure === 1)) fail(`switch off: hold ${off.hold}, exposure ${off.exposure} (one exactly expected)`);
  console.log(`[glint-probe] ${poseLabel} meter: ${tel.hold}${speck ? ' (speck)' : ''}; predicted ${tel.drawnMax.toFixed(3)} at ${tel.groundAngleDeg.toFixed(1)}° (cloud keep ${tel.peakSample?.cloudKeep?.toFixed(2)}, water ${tel.peakSample?.water?.toFixed(2)}); measured ${M.toFixed(3)} at ${geo ? geo.groundAngleDeg.toFixed(1) : '?'}°, ratio ${m.ratios.value?.toFixed(3)} (at the prediction ${m.ratios.valueAtPrediction?.toFixed(3)}); gap ${pixelGap?.toFixed(0)} px; widths along ${m.ratios.along?.toFixed(2)} across ${m.ratios.across?.toFixed(2)} coverage ${m.ratios.coverage?.toFixed(2)}; hand-off applied ${hand.applied.toFixed(3)} -> peak ${afterExposure.toFixed(2)} (${m.handoff.peakOverTarget?.toFixed(3)} of target); off ${off.hold} ${off.exposure}`);
  return summary;
}

/** The clock at 1000x at the LAST pose (so a live beam goes last in
 *  `--bearings`) with the exposure released: the
 *  telemetry every frame, the exposure's per-frame motion in stops against
 *  the meter's own rates. */
async function meterRun(page, seconds, failures) {
  await page.evaluate(() => { window.__moon.pinCapture(null); window.__moon.pinCapture({ near: 1e-7, pixelRatio: 1 }); window.__moon.setTimeRate(1000); });
  const series = await page.evaluate((secs) => new Promise((resolve) => {
    const out = []; const t0 = performance.now();
    const step = () => {
      const t = window.__moon.glintMeter(); const ex = window.__moon.exposure();
      out.push([performance.now() - t0, t.hold === 'metering' ? 1 : 0, t.exposure, t.target, t.drawnMax, t.coverage, t.peakSample ? t.peakSample.cloudKeep : 1, t.peakSample ? t.peakSample.water : 0, ex.current, t.costUs]);
      if (performance.now() - t0 < secs * 1000) requestAnimationFrame(step); else resolve(out);
    };
    requestAnimationFrame(step);
  }), seconds);
  await page.evaluate(() => { window.__moon.setTimeRate(0); window.__moon.pinCapture({ near: 1e-7, exposure: 1, pixelRatio: 1 }); });
  const rates = await page.evaluate(() => { const t = window.__moon.glintMeter(); return { knobs: t.knobs }; });
  const down = 3; const up = 0.75; // HIGHLIGHT_DOWN_STOPS_PER_S / HIGHLIGHT_UP_STOPS_PER_S
  let maxStepStops = 0; let maxStepAt = 0; let maxBound = 0; let worstOver = 0; let nonFinite = 0; let metering = 0;
  let minE = Infinity; let maxE = 0; let maxTargetStep = 0; const targetSteps = [];
  for (let k = 0; k < series.length; k++) {
    const s = series[k];
    if (!Number.isFinite(s[2]) || !Number.isFinite(s[3])) nonFinite++;
    if (s[1]) metering++;
    minE = Math.min(minE, s[2]); maxE = Math.max(maxE, s[2]);
    if (k === 0) continue;
    const p = series[k - 1];
    const dt = (s[0] - p[0]) / 1000;
    const step = Math.abs(Math.log2(s[2] / p[2]));
    const bound = (s[2] < p[2] ? down : up) * dt + 0.02;
    if (step > maxStepStops) { maxStepStops = step; maxStepAt = s[0]; maxBound = bound; }
    if (step - bound > worstOver) worstOver = step - bound;
    if (p[3] > 0 && s[3] > 0) { const ts = Math.abs(Math.log2(s[3] / p[3])); targetSteps.push(ts); if (ts > maxTargetStep) maxTargetStep = ts; }
  }
  targetSteps.sort((a, b) => a - b);
  const p95 = targetSteps.length ? targetSteps[Math.floor(0.95 * (targetSteps.length - 1))] : 0;
  const cloudKeeps = series.map((s) => s[6]); const waters = series.map((s) => s[7]);
  const run = {
    seconds, frames: series.length, meteringShare: series.length ? metering / series.length : 0, nonFinite,
    exposure: { first: series[0]?.[2] ?? null, last: series[series.length - 1]?.[2] ?? null, min: minE, max: maxE },
    maxStepStops, maxStepAtMs: maxStepAt, boundThere: maxBound, worstOverBound: worstOver,
    target: { maxStepStops: maxTargetStep, p95StepStops: p95 },
    cloudKeepAtPeak: { min: Math.min(...cloudKeeps), max: Math.max(...cloudKeeps) },
    waterAtPeak: { min: Math.min(...waters), max: Math.max(...waters) },
    knobs: rates.knobs,
    series,
  };
  if (nonFinite) failures.push(`run: ${nonFinite} frames with a non-finite exposure or target`);
  if (worstOver > 0) failures.push(`run: the exposure moved ${maxStepStops.toFixed(3)} stops in one frame at ${(maxStepAt / 1000).toFixed(2)} s, over the rate's bound ${maxBound.toFixed(3)}`);
  console.log(`[glint-probe] run: ${series.length} frames over ${seconds} s at 1000x; metering ${(run.meteringShare * 100).toFixed(0)}%; exposure ${run.exposure.first?.toFixed(3)} -> ${run.exposure.last?.toFixed(3)} (min ${minE.toFixed(3)}, max ${maxE.toFixed(3)}); largest per-frame step ${maxStepStops.toFixed(3)} stops (bound ${maxBound.toFixed(3)}); target's largest step ${maxTargetStep.toFixed(3)}, p95 ${p95.toFixed(3)}; cloud keep at the peak ${run.cloudKeepAtPeak.min.toFixed(2)}..${run.cloudKeepAtPeak.max.toFixed(2)}; water ${run.waterAtPeak.min.toFixed(2)}..${run.waterAtPeak.max.toFixed(2)}`);
  return run;
}

await mkdir(outDir, { recursive: true });
const release = await takeBrowserLock('glint-probe');
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: useGpu
    ? ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader']
    : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
console.log(`[glint-probe] renderer: ${useGpu ? 'GPU (ANGLE/Metal)' : 'software (SwiftShader)'}`);
const report = {
  label, url, timeIso, look, windMs: look ? null : windAsDrawn, mss: look ? null : mss,
  altitudeKm, sunElevDeg, bearingDeg, azimuthDeg, fovDeg, exposure, frame: { W, H }, whiteLum, poses: [],
};
try {
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    try {
      localStorage.clear(); sessionStorage.clear(); indexedDB.deleteDatabase('orbital-sim-storage');
      localStorage.setItem('planetarium-help-seen', '1');
      localStorage.setItem('planetarium-surface-hint-seen', '1');
    } catch { /* storage blocked */ }
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const windUrl = `${url}/__glint-probe/wind-${windMs}.raw`;
  await page.route('**/__glint-probe/*.raw', (route) => route.fulfill({ body: windMap, contentType: 'application/octet-stream' }));
  const params = look
    ? `&quality=medium${extra}`
    : meter
      ? `&quality=medium&synth=0&sectors=0${extra}`
      : `&quality=medium&synth=0&sectors=0&seawindmap=${encodeURIComponent(windUrl)}${extra}`;
  const target = `${url}/?auto=planetarium${params}`;
  console.log(`[glint-probe] ${target} -> ${outDir}`);
  const t0 = Date.now();
  await page.goto(target, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: bootTimeout });
  await page.waitForFunction(() => {
    const ls = document.getElementById('loading-screen');
    return !ls || ls.classList.contains('hidden') || getComputedStyle(ls).display === 'none' || getComputedStyle(ls).opacity === '0';
  }, { timeout: bootTimeout }).catch(() => {});
  console.log(`[glint-probe] booted in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await page.evaluate((t) => {
    window.__moon.setChrome(false);
    window.__moon.setShipVisible?.(false);
    // The asteroid belt's sprites would stand in the sky above the horizon.
    window.__moon.setBeltVisible?.(false);
    window.__moon.setTimeMs(t);
    window.__moon.setTimeRate?.(0);
  }, Date.parse(timeIso));
  // The sea reads its maps once both have landed; with the override, that
  // source. The ground's air arrives with the atmosphere tables a few seconds
  // in; both are waited for so the first reading is the settled picture.
  const needMap = look || meter ? (/[?&]seawindmap=/.test(extra) ? 'override' : 'shipped') : 'override';
  await page.waitForFunction((need) => {
    const g = window.__moon.glint?.();
    if (!g || !g.seaWind || g.map === 'none') return false;
    return need === 'override' ? /__glint-probe|seawindmap|http/.test(g.map) || g.map !== 'shipped' : true;
  }, needMap, { timeout: 60000 });
  const airOn = await page.waitForFunction(() => window.__moon.atmoNight?.('Earth')?.airOn === true, null, { timeout: 60000 })
    .then(() => true).catch(() => false);
  const glintState = await page.evaluate(() => window.__moon.glint());
  chain.seaBeam = glintState.seaBeam !== false;
  chain.sunPath = glintState.sunPath !== false;
  // The Sun and the sea's cap as the app has them tonight, so the reference
  // grades the app against its own light and not a remembered one.
  const sunState = await page.evaluate(() => (typeof window.__moon.sunLight === 'function' ? window.__moon.sunLight() : null));
  if (sunState && Number.isFinite(sunState.intensity)) {
    SUN_LIGHT_INTENSITY = sunState.intensity;
    SUN_LIGHT_COLOR = parseInt(String(sunState.color).replace('#', ''), 16);
  }
  if (Number.isFinite(glintState.cap)) OCEAN_GLINT_CAP = glintState.cap;
  console.log(`[glint-probe] the app's Sun: ${sunState ? `${sunState.color} at ${sunState.intensity.toFixed(4)} (luminance ${sunState.luminance.toFixed(4)})` : 'unread, using the fallbacks'}; glint cap ${OCEAN_GLINT_CAP}`);
  console.log(`[glint-probe] sea maps: ${glintState.map}; ground air: ${airOn ? 'on' : 'NOT on (tables never landed)'}; chain: ${chain.seaBeam ? 'beam' : 'old'}, Sun path ${chain.sunPath ? 'on' : 'off'}`);
  report.seaMaps = glintState.map;
  report.airTables = airOn;
  report.chain = { ...chain, beamKnee: glintState.beamKnee ?? null, beamCap: glintState.beamCap ?? null };
  if (!look) {
    if (!(meter && showClouds)) await page.evaluate(() => window.__moon.setRoleHidden('clouds', true));
    await page.evaluate((e) => window.__moon.pinCapture({ near: 1e-7, exposure: e, pixelRatio: 1 }), exposure);
  } else {
    await page.evaluate((e) => window.__moon.pinCapture({ near: 1e-7, exposure: e, pixelRatio: 1 }), exposure);
  }

  const meterFailures = [];
  for (const bearing of bearings) for (const depKey of depressions) {
    const depressionDeg = depKey === 'mirror' ? null : Number(depKey);
    const pose = await page.evaluate((o) => window.__moon.horizonView('Earth', o), {
      altitudeKm, sunElevDeg, bearingDeg: bearing, azimuthDeg, depressionDeg, fovDeg,
    });
    if (!pose) throw new Error('horizonView refused the pose');
    const poseLabel = bearings.length > 1 ? `b${bearing}-dep-${depKey}` : `dep-${depKey}`;
    console.log(`[glint-probe] ${poseLabel}: depression ${pose.depressionDeg.toFixed(2)}°, horizon dip ${pose.horizonDipDeg.toFixed(2)}°, mirror ${pose.mirror ? `${pose.mirror.groundAngleDeg.toFixed(2)}° along the ground at depression ${pose.mirror.depressionDeg.toFixed(2)}°, Sun ${pose.mirror.sunElevDeg.toFixed(2)}° high there, ${pose.mirror.slantKm.toFixed(0)} km away` : 'none (Sun below that horizon)'}`);
    await page.waitForTimeout(settle);
    await waitFrames(page, 3);
    const png = path.join(outDir, `${poseLabel}.png`);
    if (look) {
      await page.screenshot({ path: png });
      report.poses.push({ key: depKey, pose, png });
      continue;
    }
    const capture = async (keep) => {
      await page.evaluate((k) => window.__moon.glint({ keep: k }), keep);
      await waitFrames(page, 3);
      return readScene(page);
    };
    if (meter) {
      report.poses.push(await meterPose(page, pose, poseLabel, png, capture, meterFailures));
      continue;
    }
    const onFull = await capture(1);
    await page.screenshot({ path: png });
    const onBase = await capture(0);
    // The Sun's path, with the air still on (the term reads the tables, which
    // the analytic tier unbinds): the glint without it over the glint with it
    // is the factor the reference cannot compute without those tables.
    let pathFull = null;
    let pathBase = null;
    if (chain.sunPath) {
      await page.evaluate(() => window.__moon.glint({ sunPath: false }));
      pathFull = await capture(1);
      pathBase = await capture(0);
      await page.evaluate(() => window.__moon.glint({ sunPath: true }));
    }
    await page.evaluate(() => window.__moon.atmoTier('analytic'));
    await page.waitForFunction(() => window.__moon.atmoNight?.('Earth')?.airOn === false, null, { timeout: 20000 }).catch(() => {});
    await waitFrames(page, 3);
    const offFull = await capture(1);
    const offBase = await capture(0);
    await page.evaluate(() => { window.__moon.atmoTier(null); window.__moon.glint({ keep: 1 }); });
    await page.waitForFunction(() => window.__moon.atmoNight?.('Earth')?.airOn === true, null, { timeout: 20000 }).catch(() => {});

    const { width, height, camera } = onFull;
    const ic = Math.floor(width / 2);
    const knee = report.chain?.beamKnee ?? 0;
    const cap = report.chain?.beamCap ?? 1;
    const px = (frame, i, j) => { const k = (j * width + i) * 4; return [frame.data[k], frame.data[k + 1], frame.data[k + 2]]; };
    const diff = (a, b, i, j) => { const x = px(a, i, j); const y = px(b, i, j); return [x[0] - y[0], x[1] - y[1], x[2] - y[2]]; };
    // The column profile, bottom row first (the nadir side) up to the sky.
    const column = [];
    for (let j = 0; j < height; j++) {
      const r = referenceAt(pose, camera, ic, j, width, height);
      const onDrawn = diff(onFull, onBase, ic, j);
      const offDrawn = diff(offFull, offBase, ic, j);
      const pathDrawn = pathFull ? diff(pathFull, pathBase, ic, j) : onDrawn;
      // Under the beam chain the shoulder sits last, on every reading: undo
      // it, so each number below is the term as the chain carried it.
      const un = (v) => (chain.seaBeam ? unshoulder(v, knee, cap) : v);
      const on = un(onDrawn);
      const off = un(offDrawn);
      const noPath = un(pathDrawn);
      const sunPathFactor = lum(noPath) > 1e-6 ? lum(on) / lum(noPath) : 1;
      const limbOnGlint = r ? (chain.seaBeam ? 1 : r.limb) : 1;
      column.push({
        j, ground: r, appOn: lum(on), appOff: lum(off), appDrawn: lum(onDrawn), appOnRgb: on, appOffRgb: off,
        ref: r ? lum(r.ref) : 0, appExpected: r ? lum(r.app) : 0,
        sunPathFactor, limbOnGlint,
        total: lum(px(onFull, ic, j)),
      });
    }
    // Where the mirror point lands in the frame.
    let mirrorPixel = null;
    if (pose.mirror) {
      const th = (pose.mirror.groundAngleDeg * Math.PI) / 180;
      const n = [0, 1, 2].map((k) => pose.up[k] * Math.cos(th) + pose.sunAzimuth[k] * Math.sin(th));
      const q = [0, 1, 2].map((k) => pose.bodyScene[k] + pose.radiusAU * n[k]);
      mirrorPixel = projectPoint(camera, q, width, height);
    }
    // The beam's extent along the column, app and reference.
    const along = (key) => {
      const e = halfMaxExtent(column.map((c) => c[key]));
      if (!e) return null;
      const g = (j) => column[j].ground;
      return {
        peak: e.peak, peakRow: e.at,
        peakViewAngleDeg: g(e.at)?.viewAngleDeg ?? null,
        peakGroundAngleDeg: g(e.at)?.groundAngleDeg ?? null,
        halfMaxViewDeg: g(e.lo) && g(e.hi) ? g(e.hi).viewAngleDeg - g(e.lo).viewAngleDeg : null,
        halfMaxGroundKm: g(e.lo) && g(e.hi) ? Math.abs(g(e.hi).groundAngleDeg - g(e.lo).groundAngleDeg) * (Math.PI / 180) * pose.radiusAU * AU_KM : null,
        reachedTheSky: !g(e.hi) || e.hi === height - 1,
      };
    };
    const alongApp = along('appOn');
    const alongAppOff = along('appOff');
    const alongRef = along('ref');
    // Across the beam, on the row through the app's peak.
    const across = (frameA, frameB, row, refOnly) => {
      const vals = [];
      const geo = [];
      for (let i = 0; i < width; i++) {
        const r = referenceAt(pose, camera, i, row, width, height);
        geo.push(r);
        if (refOnly) vals.push(r ? lum(r.ref) : 0);
        else vals.push(lum(diff(frameA, frameB, i, row)));
      }
      const e = halfMaxExtent(vals);
      if (!e) return null;
      const ang = (i) => {
        const d = rayFor(camera, i, row, width, height);
        return (Math.acos(Math.min(Math.max(dot(d, pose.aim), -1), 1)) * 180) / Math.PI * (i < ic ? -1 : 1);
      };
      return { peak: e.peak, peakCol: e.at, halfMaxViewDeg: ang(e.hi) - ang(e.lo), lo: e.lo, hi: e.hi };
    };
    const acrossApp = alongApp ? across(onFull, onBase, alongApp.peakRow, false) : null;
    const acrossRef = alongRef ? across(null, null, alongRef.peakRow, true) : null;
    // Over the beam window (the reference above a twentieth of its peak over
    // the whole frame): the clip and cap fractions, the energy ratio, the air.
    let refPeak = 0;
    const refFrame = new Float32Array(width * height);
    const limbFrame = new Float32Array(width * height);
    const appExpFrame = new Float32Array(width * height);
    for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
      const r = referenceAt(pose, camera, i, j, width, height);
      const k = j * width + i;
      refFrame[k] = r ? lum(r.ref) : 0;
      appExpFrame[k] = r ? lum(r.app) : 0;
      limbFrame[k] = r ? r.limb : 1;
      if (refFrame[k] > refPeak) refPeak = refFrame[k];
    }
    let windowCount = 0; let clipped = 0; let capped = 0; let shouldered = 0; let sumDrawn = 0;
    let sumApp = 0; let sumAppOff = 0; let sumRef = 0; let sumAppExp = 0; let sumAppExpLimb = 0;
    let airNum = 0; let airDen = 0; let pathNum = 0; let pathDen = 0;
    const beamCap = report.chain?.beamCap ?? OCEAN_GLINT_CAP;
    for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
      const k = j * width + i;
      if (refFrame[k] < refPeak / 20) continue;
      windowCount++;
      const total = px(onFull, i, j);
      const out = acesFilmic(total, onFull.exposure);
      if (Math.max(out[0], out[1], out[2]) >= 0.95) clipped++;
      const offDrawn = diff(offFull, offBase, i, j);
      const onDrawn = diff(onFull, onBase, i, j);
      const pathDrawn = pathFull ? diff(pathFull, pathBase, i, j) : onDrawn;
      const un = (v) => (chain.seaBeam ? unshoulder(v, knee, cap) : v);
      const on = un(onDrawn);
      const off = un(offDrawn);
      const noPath = un(pathDrawn);
      if (chain.seaBeam) {
        // The shoulder engaged: a drawn channel over the knee.
        if (Math.max(onDrawn[0], onDrawn[1], onDrawn[2]) > knee) shouldered++;
        if (Math.max(onDrawn[0], onDrawn[1], onDrawn[2]) >= beamCap * 0.97) capped++;
      } else {
        const rawCapped = off.map((c) => c / Math.max(limbFrame[k], 1e-3));
        if (Math.max(rawCapped[0], rawCapped[1], rawCapped[2]) >= OCEAN_GLINT_CAP - 0.002) capped++;
      }
      const limbOnGlint = chain.seaBeam ? 1 : limbFrame[k];
      sumApp += lum(on); sumAppOff += lum(off); sumRef += refFrame[k]; sumAppExp += appExpFrame[k];
      sumDrawn += lum(onDrawn);
      // The expected value carries the measured Sun-path factor and, under
      // the old chain, the limb darkening. The air-off reading carries no Sun
      // path (the term reads the tables the analytic tier unbinds).
      sumAppExpLimb += appExpFrame[k] * limbOnGlint;
      airNum += lum(on); airDen += lum(off * (lum(noPath) > 1e-6 ? lum(on) / lum(noPath) : 1));
      pathNum += lum(on); pathDen += lum(noPath);
    }
    const peakApp = alongApp?.peak ?? 0;
    const peakRow = alongApp?.peakRow ?? 0;
    const peakRef = column[peakRow]?.ref ?? 0;
    const peakAppExp = column[peakRow]?.appExpected ?? 0;
    const peakLimb = column[peakRow]?.limbOnGlint ?? 1;
    const peakPath = column[peakRow]?.sunPathFactor ?? 1;
    const peakOff = column[peakRow]?.appOff ?? 0;
    const summary = {
      key: depKey, pose, png, mirrorPixel, frame: { width, height, exposure: onFull.exposure, toneMapping: onFull.toneMapping },
      peak: {
        appScene: peakApp, appWhites: peakApp / whiteLum, appOffScene: peakOff,
        refScene: peakRef, refWhites: peakRef / whiteLum, appExpectedScene: peakAppExp,
        drawnScene: column[peakRow]?.appDrawn ?? 0, drawnWhites: (column[peakRow]?.appDrawn ?? 0) / whiteLum,
        limbFactorThere: peakLimb, sunPathFactorThere: peakPath,
        // The air's own share: the on reading over the off one, the Sun's path
        // taken out of the on reading since the off one never carried it.
        airFactorThere: peakOff > 0 ? peakApp / (peakOff * peakPath) : null,
        appOverRef: peakRef > 0 ? peakApp / peakRef : null,
        appOffOverExpected: peakAppExp > 0 ? peakOff / (peakAppExp * peakLimb) : null,
        refPeakAnywhere: refPeak, refPeakAnywhereWhites: refPeak / whiteLum,
      },
      along: { app: alongApp, appAirOff: alongAppOff, ref: alongRef },
      across: { app: acrossApp, ref: acrossRef },
      window: {
        pixels: windowCount, clipFraction: windowCount ? clipped / windowCount : null,
        capFraction: windowCount ? capped / windowCount : null,
        energyAppOverRef: sumRef > 0 ? sumApp / sumRef : null,
        energyAppOffOverExpectedLimb: sumAppExpLimb > 0 ? sumAppOff / sumAppExpLimb : null,
        shoulderFraction: windowCount && chain.seaBeam ? shouldered / windowCount : null,
        energyDrawnOverCarried: sumApp > 0 ? sumDrawn / sumApp : null,
        energyAppOffOverExpected: sumAppExp > 0 ? sumAppOff / sumAppExp : null,
        airTransmittanceOnGlint: airDen > 0 ? airNum / airDen : null,
        sunPathOnGlint: pathDen > 0 ? pathNum / pathDen : null,
      },
      // The column at every twentieth row: view angle, ground angle, the four numbers.
      profile: column.filter((c, idx) => idx % Math.max(1, Math.floor(height / 40)) === 0 || idx === peakRow).map((c) => ({
        row: c.j,
        viewDeg: c.ground ? +c.ground.viewAngleDeg.toFixed(2) : null,
        groundDeg: c.ground ? +c.ground.groundAngleDeg.toFixed(2) : null,
        mu: c.ground ? +c.ground.NdotV.toFixed(3) : null,
        sunElevDeg: c.ground ? +((Math.asin(c.ground.NdotL) * 180) / Math.PI).toFixed(2) : null,
        appOn: +c.appOn.toFixed(4), appOff: +c.appOff.toFixed(4), ref: +c.ref.toFixed(4), appExpected: +c.appExpected.toFixed(4),
        limb: c.ground ? +c.limbOnGlint.toFixed(3) : null,
        sunPath: +c.sunPathFactor.toFixed(3),
        total: +c.total.toFixed(4),
      })),
    };
    report.poses.push(summary);
    console.log(`[glint-probe] ${poseLabel}: peak app ${peakApp.toFixed(3)} (${(peakApp / whiteLum).toFixed(2)} whites) vs reference ${peakRef.toFixed(3)} (${(peakRef / whiteLum).toFixed(2)} whites); air on glint ${summary.window.airTransmittanceOnGlint?.toFixed(3)}; clip ${summary.window.clipFraction === null ? 'n/a' : (summary.window.clipFraction * 100).toFixed(1) + '%'}; cap ${summary.window.capFraction === null ? 'n/a' : (summary.window.capFraction * 100).toFixed(1) + '%'}; half-max along app ${alongApp?.halfMaxViewDeg?.toFixed(2)}° ref ${alongRef?.halfMaxViewDeg?.toFixed(2)}°`);
  }
  if (meter && runSeconds > 0) report.run = await meterRun(page, runSeconds, meterFailures);
  if (meter) report.meterFailures = meterFailures;
  if (errors.length) {
    console.log(`[glint-probe] page errors (${errors.length}):`);
    for (const e of errors.slice(0, 10)) console.log('    ', e);
    report.errors = errors.slice(0, 20);
  }
} finally {
  await browser.close();
  await release();
}

await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
const lines = [];
lines.push(`glint-probe ${label}: ${look ? 'look arm' : `wind ${windAsDrawn.toFixed(2)} m/s (mss ${mss.toFixed(5)})`}, chain ${report.chain?.seaBeam ? 'beam' : 'old'} (Sun path ${report.chain?.sunPath ? 'on' : 'off'}), ${altitudeKm} km up, Sun ${sunElevDeg}° high at the stand point, bearing ${bearingDeg}°, azimuth ${azimuthDeg}°, fov ${fovDeg}°, exposure ${exposure}, ${timeIso}`);
lines.push(`one white (a Lambert disc under the Sun) = ${whiteLum.toFixed(4)} scene units; sea maps: ${report.seaMaps}; air tables: ${report.airTables}`);
for (const p of report.poses) {
  lines.push('');
  lines.push(`pose ${p.key}: depression ${p.pose.depressionDeg.toFixed(2)}°, horizon dip ${p.pose.horizonDipDeg.toFixed(2)}°, mirror ${p.pose.mirror ? `${p.pose.mirror.groundAngleDeg.toFixed(2)}° along the ground, depression ${p.pose.mirror.depressionDeg.toFixed(2)}°, Sun ${p.pose.mirror.sunElevDeg.toFixed(2)}° high there, ${p.pose.mirror.slantKm.toFixed(0)} km away` : 'none'}${p.mirrorPixel ? `, in frame at (${p.mirrorPixel.x.toFixed(0)}, ${p.mirrorPixel.y.toFixed(0)} from the bottom)` : ''}`);
  if (look) continue;
  if (meter) {
    const m = p.meter; const pr = m.predicted; const me = m.measured; const r = m.ratios; const h = m.handoff;
    lines.push(`  meter: ${m.hold}, maps ${m.maps.ready.length}/3, scan ${m.costUs.toFixed(0)} µs; predicted drawn max ${pr.drawnMax.toFixed(3)} at ${pr.groundAngleDeg.toFixed(2)}° along the ground (water ${pr.sample.water.toFixed(2)}, calm ${pr.sample.calm.toFixed(2)}, wind ${pr.sample.windMs.toFixed(1)} m/s, cloud keep ${pr.sample.cloudKeep.toFixed(2)}), half-widths ${pr.halfWidthAlongDeg.toFixed(2)}° along ${pr.halfWidthAcrossDeg.toFixed(2)}° across, coverage ${pr.coverage.toFixed(4)}${pr.pixel ? `, at pixel (${pr.pixel.x.toFixed(0)}, ${pr.pixel.y.toFixed(0)})` : ''}`);
    lines.push(`  measured: drawn max ${me.drawnMax.toFixed(3)} (channel ${'rgb'[me.channel]}) at pixel (${me.pixel.x.toFixed(0)}, ${me.pixel.y.toFixed(0)}), ${me.groundAngleDeg === null ? 'sky' : `${me.groundAngleDeg.toFixed(2)}° along the ground`}, ${me.pixelGapFromPrediction === null ? 'no prediction' : `${me.pixelGapFromPrediction.toFixed(0)} px from the prediction`}${me.atPrediction === null ? '' : `, ${me.atPrediction.toFixed(3)} within 7 px of the prediction`}${m.speck ? ' — a SPECK, under the fade\'s threshold, held at one by construction' : ''}; half-max ${me.halfMaxAlongDeg?.toFixed(2)}° along (rows ${me.alongExtent?.lo}..${me.alongExtent?.hi}) ${me.halfMaxAcrossDeg?.toFixed(2)}° across (cols ${me.acrossExtent?.lo}..${me.acrossExtent?.hi}); coverage ${me.coverage.toFixed(4)} (pixels at or over half the peak)`);
    lines.push(`  measured / predicted: value ${r.value?.toFixed(3)} (at the prediction ${r.valueAtPrediction?.toFixed(3)}), ground angle gap ${r.groundAngleGapDeg?.toFixed(2)}°, width along ${r.along?.toFixed(3)}, across ${r.across?.toFixed(3)}, coverage ${r.coverage?.toFixed(3)}`);
    lines.push(`  hand-off: the meter asks ${h.meterExposure.toFixed(4)} (its target ${h.meterTarget.toFixed(4)}${h.atFloor ? ', at the floor' : ''}${h.fadedIn ? '' : ', fade not full'}), the Sun's meter ${h.sunMeter.toFixed(4)}, applied ${h.applied.toFixed(4)}${h.auto ? '' : ' (auto exposure OFF)'} -> the brightest beam pixel after exposure ${h.peakAfterExposure.toFixed(3)} against the target ${m.knobs.target} (${h.peakOverTarget?.toFixed(3)}), its core through the tone curve ${h.coreThroughToneCurve.toFixed(0)}, non-glint share at that pixel ${me.nonGlintShare === null ? 'n/a' : me.nonGlintShare.toFixed(3)}`);
    lines.push(`  switch off: hold ${m.off.hold}, exposure ${m.off.exposure}, applied ${m.off.applied.toFixed(4)}`);
    continue;
  }
  const k = p.peak;
  lines.push(`  peak on the centre column: app ${k.appScene.toFixed(4)} (${k.appWhites.toFixed(2)} whites) as carried to the camera${report.chain?.seaBeam ? `, drawn ${k.drawnScene.toFixed(4)} (${k.drawnWhites.toFixed(2)} whites) after the shoulder` : ''} | reference ${k.refScene.toFixed(4)} (${k.refWhites.toFixed(2)} whites) | app/ref ${k.appOverRef?.toFixed(3)}`);
  lines.push(`    attributed there: limb darkening on the glint x${k.limbFactorThere.toFixed(3)}, Sun's path x${k.sunPathFactorThere.toFixed(3)}, air on the camera leg x${k.airFactorThere?.toFixed(3)}, app-air-off / (chain's expected x limb) ${k.appOffOverExpected?.toFixed(3)} (1 = the shader matches its own equations)`);
  lines.push(`  reference peak anywhere in frame: ${k.refPeakAnywhere.toFixed(4)} (${k.refPeakAnywhereWhites.toFixed(2)} whites)`);
  lines.push(`  beam half-max along the column: app ${p.along.app?.halfMaxViewDeg?.toFixed(2)}° of view (${p.along.app?.halfMaxGroundKm?.toFixed(0)} km of ground${p.along.app?.reachedTheSky ? ', reaches the horizon' : ''}) | reference ${p.along.ref?.halfMaxViewDeg?.toFixed(2)}° (${p.along.ref?.halfMaxGroundKm?.toFixed(0)} km${p.along.ref?.reachedTheSky ? ', reaches the horizon' : ''})`);
  lines.push(`  beam half-max across: app ${p.across.app?.halfMaxViewDeg?.toFixed(2)}° | reference ${p.across.ref?.halfMaxViewDeg?.toFixed(2)}°`);
  const w = p.window;
  lines.push(`  beam window (${w.pixels} px where the reference is over a twentieth of its peak): clip ${(w.clipFraction * 100).toFixed(1)}% at >= 0.95 white through the tone curve, ${report.chain?.seaBeam ? `shoulder engaged on ${(w.shoulderFraction * 100).toFixed(1)}% (over the knee ${report.chain.beamKnee}), ${(w.capFraction * 100).toFixed(1)}% within 3% of the cap ${report.chain.beamCap}, drawn/carried energy ${w.energyDrawnOverCarried?.toFixed(3)}` : `cap ${(w.capFraction * 100).toFixed(1)}% held at ${OCEAN_GLINT_CAP}`}, energy app/ref ${w.energyAppOverRef?.toFixed(3)}, air-off app / (expected x limb) ${w.energyAppOffOverExpectedLimb?.toFixed(3)}, Sun's path on the glint ${w.sunPathOnGlint?.toFixed(3)}, air on the camera leg ${w.airTransmittanceOnGlint?.toFixed(3)}`);
  lines.push('  profile (centre column, bottom to top): view°  ground°  mu  sun°   app(on)  app(off)  ref  expected  limb  path  total');
  for (const r of p.profile) {
    lines.push(`    ${String(r.viewDeg ?? 'sky').padStart(7)} ${String(r.groundDeg ?? '').padStart(7)} ${String(r.mu ?? '').padStart(6)} ${String(r.sunElevDeg ?? '').padStart(6)}  ${r.appOn.toFixed(4)}  ${r.appOff.toFixed(4)}  ${r.ref.toFixed(4)}  ${r.appExpected.toFixed(4)}  ${r.limb ?? ''}  ${r.sunPath}  ${r.total.toFixed(4)}`);
  }
}
if (meter && report.run) {
  const r = report.run;
  lines.push('');
  lines.push(`run: the clock at 1000x for ${r.seconds} s at the last pose, ${r.frames} frames, metering ${(r.meteringShare * 100).toFixed(0)}% of them, ${r.nonFinite} non-finite; exposure ${r.exposure.first?.toFixed(4)} -> ${r.exposure.last?.toFixed(4)} (min ${r.exposure.min.toFixed(4)}, max ${r.exposure.max.toFixed(4)}); largest per-frame step ${r.maxStepStops.toFixed(4)} stops at ${(r.maxStepAtMs / 1000).toFixed(2)} s against the rate's bound ${r.boundThere.toFixed(4)} there (worst over any bound ${r.worstOverBound.toFixed(4)}); the un-eased target's largest step ${r.target.maxStepStops.toFixed(4)}, p95 ${r.target.p95StepStops.toFixed(4)}; cloud keep at the peak ${r.cloudKeepAtPeak.min.toFixed(2)}..${r.cloudKeepAtPeak.max.toFixed(2)}, water ${r.waterAtPeak.min.toFixed(2)}..${r.waterAtPeak.max.toFixed(2)}`);
}
if (meter) {
  lines.push('');
  lines.push(`bars (a beam under the fade's threshold of the frame, measured or predicted, is a speck: only the meter's hold near one is checked): drawn peak measured/predicted within 0.75..1.33; the predicted peak inside the measured half-maximum extent; coverage within 0.4..2.5; where the meter settled under one with the fade full, off the floor and the Sun's meter at one, the brightest beam pixel after exposure within 0.85..1.18 of the target; the switch off exactly one; a run's exposure never past its rate in a frame, never non-finite`);
  lines.push(report.meterFailures.length ? `VERDICT: FAIL (${report.meterFailures.length})\n  ${report.meterFailures.join('\n  ')}` : 'VERDICT: PASS');
  if (assertBars && report.meterFailures.length) process.exitCode = 1;
}
await writeFile(path.join(outDir, 'report.txt'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
console.log(`[glint-probe] wrote ${outDir}/report.{json,txt}`);
