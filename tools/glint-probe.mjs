// The ocean glint as LINEAR radiance, measured on the app's own GPU against a
// CPU reference of the same equations, at the astronaut's view of the sea.
//
//   node tools/glint-probe.mjs                       # 400 km up, the Sun 10° high, aimed at the mirror point, then 8° and 16° down
//   node tools/glint-probe.mjs --deps=mirror,6,12,20 --sunelev=5 --wind=5 --label=calm
//   node tools/glint-probe.mjs --alt=35786 --deps=90 --fov=20 --label=geo    # the geostationary view, straight down
//   node tools/glint-probe.mjs --look --extra='&seawindmap=http://localhost:5174/planning/seawind-cand/F.png'
//
// Method. The sea is given ONE wind everywhere — a raw byte wind map served
// from memory through `?seawindmap=`, so the sea's mixture is one Beckmann
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
const label = arg('label', look ? 'look' : 'probe');
const outDir = arg('out', path.join('/tmp/moon-glint-probe', label));
const extra = arg('extra', '');
const timeIso = arg('time', '2026-10-03T16:40:00Z');
const windMs = Number(arg('wind', '7'));
const altitudeKm = Number(arg('alt', '400'));
const sunElevDeg = Number(arg('sunelev', '10'));
const bearingDeg = Number(arg('bearing', '180'));
const azimuthDeg = Number(arg('azimuth', '0'));
const fovDeg = Number(arg('fov', '40'));
const depressions = arg('deps', 'mirror,8,16').split(',').map((s) => s.trim()).filter(Boolean);
const W = Number(arg('w', '1200'));
const H = Number(arg('h', '800'));
const exposure = Number(arg('exposure', '1'));
const settle = Number(arg('settle', look ? '7000' : '2500'));
const bootTimeout = Number(arg('boot', '240000'));
const useGpu = !flag('software');

// The app's own numbers (PlanetFactory, world/seaWind, world/surfaceShading),
// stated here so the reference is independent of the module graph.
const SUN_LIGHT_INTENSITY = 3;
const SUN_LIGHT_DECAY = 0.3;
const SUN_LIGHT_COLOR = 0xfff5e0;
const COX_MUNK_SLOPE_CALM = 0.003;
const COX_MUNK_SLOPE_PER_MS = 0.00512;
const SEA_WIND_MAX_MS = 16;
const SEA_WATER_IOR = 1.33;
const SEA_WATER_F0 = ((SEA_WATER_IOR - 1) / (SEA_WATER_IOR + 1)) ** 2;
const OCEAN_GLINT_CAP = 1.25;
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
  return { ref: scale(E, common * vBeck), app: scale(E, common * vGgx), ...geometry };
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

const waitFrames = (page, n = 3) => page.evaluate((k) => new Promise((resolve) => {
  const step = (left) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
  step(k);
}), n);

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
  const needMap = look ? (/[?&]seawindmap=/.test(extra) ? 'override' : 'shipped') : 'override';
  await page.waitForFunction((need) => {
    const g = window.__moon.glint?.();
    if (!g || !g.seaWind || g.map === 'none') return false;
    return need === 'override' ? /__glint-probe|seawindmap|http/.test(g.map) || g.map !== 'shipped' : true;
  }, needMap, { timeout: 60000 });
  const airOn = await page.waitForFunction(() => window.__moon.atmoNight?.('Earth')?.airOn === true, null, { timeout: 60000 })
    .then(() => true).catch(() => false);
  const glintState = await page.evaluate(() => window.__moon.glint());
  console.log(`[glint-probe] sea maps: ${glintState.map}; ground air: ${airOn ? 'on' : 'NOT on (tables never landed)'}`);
  report.seaMaps = glintState.map;
  report.airTables = airOn;
  if (!look) {
    await page.evaluate(() => window.__moon.setRoleHidden('clouds', true));
    await page.evaluate((e) => window.__moon.pinCapture({ near: 1e-7, exposure: e, pixelRatio: 1 }), exposure);
  } else {
    await page.evaluate((e) => window.__moon.pinCapture({ near: 1e-7, exposure: e, pixelRatio: 1 }), exposure);
  }

  for (const depKey of depressions) {
    const depressionDeg = depKey === 'mirror' ? null : Number(depKey);
    const pose = await page.evaluate((o) => window.__moon.horizonView('Earth', o), {
      altitudeKm, sunElevDeg, bearingDeg, azimuthDeg, depressionDeg, fovDeg,
    });
    if (!pose) throw new Error('horizonView refused the pose');
    const poseLabel = `dep-${depKey}`;
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
    const onFull = await capture(1);
    await page.screenshot({ path: png });
    const onBase = await capture(0);
    await page.evaluate(() => window.__moon.atmoTier('analytic'));
    await page.waitForFunction(() => window.__moon.atmoNight?.('Earth')?.airOn === false, null, { timeout: 20000 }).catch(() => {});
    await waitFrames(page, 3);
    const offFull = await capture(1);
    const offBase = await capture(0);
    await page.evaluate(() => { window.__moon.atmoTier(null); window.__moon.glint({ keep: 1 }); });
    await page.waitForFunction(() => window.__moon.atmoNight?.('Earth')?.airOn === true, null, { timeout: 20000 }).catch(() => {});

    const { width, height, camera } = onFull;
    const ic = Math.floor(width / 2);
    const px = (frame, i, j) => { const k = (j * width + i) * 4; return [frame.data[k], frame.data[k + 1], frame.data[k + 2]]; };
    const diff = (a, b, i, j) => { const x = px(a, i, j); const y = px(b, i, j); return [x[0] - y[0], x[1] - y[1], x[2] - y[2]]; };
    // The column profile, bottom row first (the nadir side) up to the sky.
    const column = [];
    for (let j = 0; j < height; j++) {
      const r = referenceAt(pose, camera, ic, j, width, height);
      const on = diff(onFull, onBase, ic, j);
      const off = diff(offFull, offBase, ic, j);
      column.push({
        j, ground: r, appOn: lum(on), appOff: lum(off), appOnRgb: on, appOffRgb: off,
        ref: r ? lum(r.ref) : 0, appExpected: r ? lum(r.app) : 0,
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
    let windowCount = 0; let clipped = 0; let capped = 0;
    let sumApp = 0; let sumAppOff = 0; let sumRef = 0; let sumAppExp = 0; let sumAppExpLimb = 0;
    let airNum = 0; let airDen = 0;
    for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
      const k = j * width + i;
      if (refFrame[k] < refPeak / 20) continue;
      windowCount++;
      const total = px(onFull, i, j);
      const out = acesFilmic(total, onFull.exposure);
      if (Math.max(out[0], out[1], out[2]) >= 0.95) clipped++;
      const off = diff(offFull, offBase, i, j);
      const rawCapped = off.map((c) => c / Math.max(limbFrame[k], 1e-3));
      if (Math.max(rawCapped[0], rawCapped[1], rawCapped[2]) >= OCEAN_GLINT_CAP - 0.002) capped++;
      const on = diff(onFull, onBase, i, j);
      sumApp += lum(on); sumAppOff += lum(off); sumRef += refFrame[k]; sumAppExp += appExpFrame[k];
      sumAppExpLimb += appExpFrame[k] * limbFrame[k];
      airNum += lum(on); airDen += lum(off);
    }
    const peakApp = alongApp?.peak ?? 0;
    const peakRow = alongApp?.peakRow ?? 0;
    const peakRef = column[peakRow]?.ref ?? 0;
    const peakAppExp = column[peakRow]?.appExpected ?? 0;
    const peakLimb = column[peakRow]?.ground?.limb ?? 1;
    const peakOff = column[peakRow]?.appOff ?? 0;
    const summary = {
      key: depKey, pose, png, mirrorPixel, frame: { width, height, exposure: onFull.exposure, toneMapping: onFull.toneMapping },
      peak: {
        appScene: peakApp, appWhites: peakApp / whiteLum, appOffScene: peakOff,
        refScene: peakRef, refWhites: peakRef / whiteLum, appExpectedScene: peakAppExp,
        limbFactorThere: peakLimb, airFactorThere: peakOff > 0 ? peakApp / peakOff : null,
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
        energyAppOffOverExpected: sumAppExp > 0 ? sumAppOff / sumAppExp : null,
        airTransmittanceOnGlint: airDen > 0 ? airNum / airDen : null,
      },
      // The column at every twentieth row: view angle, ground angle, the four numbers.
      profile: column.filter((c, idx) => idx % Math.max(1, Math.floor(height / 40)) === 0 || idx === peakRow).map((c) => ({
        row: c.j,
        viewDeg: c.ground ? +c.ground.viewAngleDeg.toFixed(2) : null,
        groundDeg: c.ground ? +c.ground.groundAngleDeg.toFixed(2) : null,
        mu: c.ground ? +c.ground.NdotV.toFixed(3) : null,
        sunElevDeg: c.ground ? +((Math.asin(c.ground.NdotL) * 180) / Math.PI).toFixed(2) : null,
        appOn: +c.appOn.toFixed(4), appOff: +c.appOff.toFixed(4), ref: +c.ref.toFixed(4), appExpected: +c.appExpected.toFixed(4),
        limb: c.ground ? +c.ground.limb.toFixed(3) : null,
        total: +c.total.toFixed(4),
      })),
    };
    report.poses.push(summary);
    console.log(`[glint-probe] ${poseLabel}: peak app ${peakApp.toFixed(3)} (${(peakApp / whiteLum).toFixed(2)} whites) vs reference ${peakRef.toFixed(3)} (${(peakRef / whiteLum).toFixed(2)} whites); air on glint ${summary.window.airTransmittanceOnGlint?.toFixed(3)}; clip ${summary.window.clipFraction === null ? 'n/a' : (summary.window.clipFraction * 100).toFixed(1) + '%'}; cap ${summary.window.capFraction === null ? 'n/a' : (summary.window.capFraction * 100).toFixed(1) + '%'}; half-max along app ${alongApp?.halfMaxViewDeg?.toFixed(2)}° ref ${alongRef?.halfMaxViewDeg?.toFixed(2)}°`);
  }
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
lines.push(`glint-probe ${label}: ${look ? 'look arm' : `wind ${windAsDrawn.toFixed(2)} m/s (mss ${mss.toFixed(5)})`}, ${altitudeKm} km up, Sun ${sunElevDeg}° high at the stand point, bearing ${bearingDeg}°, azimuth ${azimuthDeg}°, fov ${fovDeg}°, exposure ${exposure}, ${timeIso}`);
lines.push(`one white (a Lambert disc under the Sun) = ${whiteLum.toFixed(4)} scene units; sea maps: ${report.seaMaps}; air tables: ${report.airTables}`);
for (const p of report.poses) {
  lines.push('');
  lines.push(`pose ${p.key}: depression ${p.pose.depressionDeg.toFixed(2)}°, horizon dip ${p.pose.horizonDipDeg.toFixed(2)}°, mirror ${p.pose.mirror ? `${p.pose.mirror.groundAngleDeg.toFixed(2)}° along the ground, depression ${p.pose.mirror.depressionDeg.toFixed(2)}°, Sun ${p.pose.mirror.sunElevDeg.toFixed(2)}° high there, ${p.pose.mirror.slantKm.toFixed(0)} km away` : 'none'}${p.mirrorPixel ? `, in frame at (${p.mirrorPixel.x.toFixed(0)}, ${p.mirrorPixel.y.toFixed(0)} from the bottom)` : ''}`);
  if (look) continue;
  const k = p.peak;
  lines.push(`  peak on the centre column: app ${k.appScene.toFixed(4)} (${k.appWhites.toFixed(2)} whites) | reference ${k.refScene.toFixed(4)} (${k.refWhites.toFixed(2)} whites) | app/ref ${k.appOverRef?.toFixed(3)}`);
  lines.push(`    attributed there: limb darkening x${k.limbFactorThere.toFixed(3)}, air x${k.airFactorThere?.toFixed(3)}, app-air-off / (chain's expected x limb) ${k.appOffOverExpected?.toFixed(3)} (1 = the cap did not engage and the shader matches its own equations)`);
  lines.push(`  reference peak anywhere in frame: ${k.refPeakAnywhere.toFixed(4)} (${k.refPeakAnywhereWhites.toFixed(2)} whites)`);
  lines.push(`  beam half-max along the column: app ${p.along.app?.halfMaxViewDeg?.toFixed(2)}° of view (${p.along.app?.halfMaxGroundKm?.toFixed(0)} km of ground${p.along.app?.reachedTheSky ? ', reaches the horizon' : ''}) | reference ${p.along.ref?.halfMaxViewDeg?.toFixed(2)}° (${p.along.ref?.halfMaxGroundKm?.toFixed(0)} km${p.along.ref?.reachedTheSky ? ', reaches the horizon' : ''})`);
  lines.push(`  beam half-max across: app ${p.across.app?.halfMaxViewDeg?.toFixed(2)}° | reference ${p.across.ref?.halfMaxViewDeg?.toFixed(2)}°`);
  const w = p.window;
  lines.push(`  beam window (${w.pixels} px where the reference is over a twentieth of its peak): clip ${(w.clipFraction * 100).toFixed(1)}% at >= 0.95 white through the tone curve, cap ${(w.capFraction * 100).toFixed(1)}% held at ${OCEAN_GLINT_CAP}, energy app/ref ${w.energyAppOverRef?.toFixed(3)}, air-off app / (expected x limb) ${w.energyAppOffOverExpectedLimb?.toFixed(3)}, air transmittance on the glint ${w.airTransmittanceOnGlint?.toFixed(3)}`);
  lines.push('  profile (centre column, bottom to top): view°  ground°  mu  sun°   app(on)  app(off)  ref  expected  limb  total');
  for (const r of p.profile) {
    lines.push(`    ${String(r.viewDeg ?? 'sky').padStart(7)} ${String(r.groundDeg ?? '').padStart(7)} ${String(r.mu ?? '').padStart(6)} ${String(r.sunElevDeg ?? '').padStart(6)}  ${r.appOn.toFixed(4)}  ${r.appOff.toFixed(4)}  ${r.ref.toFixed(4)}  ${r.appExpected.toFixed(4)}  ${r.limb ?? ''}  ${r.total.toFixed(4)}`);
  }
}
await writeFile(path.join(outDir, 'report.txt'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
console.log(`[glint-probe] wrote ${outDir}/report.{json,txt}`);
