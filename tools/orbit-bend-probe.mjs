// Orbit-bend probe: does the corner an orbit line shows from beside it get
// rounded, and does nothing else move?
//
// From a few hundred thousand km beside Pluto's orbit, looking along it, the
// exact projection of the line turns through ~120° inside a dozen pixels:
// the near stretch runs to its vanishing point and the far side of the ring
// lies along the orbit plane's horizon (src/planetarium/orbitLineBend.ts has
// the arithmetic). The pass rounds that one corner on screen; `?orbitbend=0`
// is the exact projection, and the control run must show the corner.
//
//   node tools/orbit-bend-probe.mjs --url=http://localhost:5173
//   node tools/orbit-bend-probe.mjs --url=... --lateral=1e5 --height=1.7e5 --along=3e6
//
// The pose: frame() aims the camera at Pluto from `along` km behind it along
// the orbit's velocity (the phase and roll that put the framing rig's
// direction on −v̂), so the line's forward vanishing point is screen-centre;
// then nudge() slides the ship `lateral` km outward (radially) and `height`
// km off the orbit plane without turning it. Chrome off, lines on, clock
// frozen at a fixed epoch.
//
// The reading, per run: the bridge's orbitBend() (which line the pass treats,
// the corner angle it read, σ, how many vertices it moved) and, from the
// PNG, the tightest bend of the line's centreline within the middle of the
// frame — the stroke's pixels are thinned to a centreline (cell centroids
// along a greedy walk), resampled at 1 px, smoothed over ±4 px, and the
// smallest circumradius over ±8 px triplets is the reading: a 5 px stroke's
// centreline cannot read under ~3 px even at a true corner, and the corner
// reads ~4 CSS px against a bend's ~16.
//
// PASS: the control reads a corner (tightest radius < CORNER_MAX_PX) and the
// pass is inactive on it; the treated run reads a bend (tightest radius >
// BEND_MIN_PX) with the pass active on Pluto. Frames land in
// /tmp/moon-shots/<label>/ beside a JSON of the readings. Takes
// /tmp/moon-browser.lock like every battery.
import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { takeBrowserLock } from './browserLock.mjs';
import { decodePng } from './pngDecode.mjs';

const arg = (k, d) => { const m = process.argv.find((a) => a.startsWith(`--${k}=`)); return m ? m.slice(k.length + 3) : d; };
const URL = arg('url', 'http://localhost:5173');
const LABEL = arg('label', 'orbit-bend');
const BODY = arg('body', 'Pluto');
const LATERAL_KM = Number(arg('lateral', '1e5'));
const HEIGHT_KM = Number(arg('height', '1.7e5'));
const ALONG_KM = Number(arg('along', '3e6'));
const W = Number(arg('w', '390'));
const H = Number(arg('h', '844'));
const DPR = Number(arg('dpr', '2'));
const CORNER_MAX_PX = Number(arg('corner', '6')) * DPR;
const BEND_MIN_PX = Number(arg('bend', '9')) * DPR;
const EPOCH_MS = Date.UTC(2026, 8, 11, 6, 52, 0);
const KM_PER_AU = 149_597_870.7;
const OUT = `/tmp/moon-shots/${LABEL}`;
mkdirSync(OUT, { recursive: true });

const PINNED_CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const executablePath = process.env.PW_CHROMIUM || (existsSync(PINNED_CHROMIUM) ? PINNED_CHROMIUM : undefined);
const useGpu = !process.argv.includes('--software') && !executablePath;
const ARGS = useGpu
  ? ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader']
  : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frames = (page, n) => page.evaluate((count) => new Promise((resolve) => {
  let i = 0;
  const tick = () => { if (++i >= count) resolve(); else requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}), n);

/** Pose the camera beside the body's orbit line, looking along it. */
async function pose(page) {
  return page.evaluate(({ body, lateralKm, heightKm, alongKm, epochMs, kmPerAu }) => {
    const m = window.__moon;
    m.setTimeMs(epochMs);
    m.setTimePaused(false);
    // Chrome off first: it takes the lines with it, and the lines go back on.
    m.setChrome(false);
    m.setOrbitLines(true);
    // A first frame() gives a posed scene with fresh velocities to read.
    if (!m.frame(body, 0.5, 90, 5, 0, 0)) return { ok: false, why: 'frame' };
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const probe = m.probe(body);
      const v = probe?.velAUPerS;
      const p = probe?.bodyAbs;
      const r = probe?.radiusAU;
      if (!v || !p || !r) return resolve({ ok: false, why: 'probe' });
      const norm = (a) => { const l = Math.hypot(a.x, a.y, a.z); return { x: a.x / l, y: a.y / l, z: a.z / l }; };
      const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
      const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
      const tangent = norm(v);
      const toSun = norm({ x: -p.x, y: -p.y, z: -p.z });
      // The framing rig: dir = toSun rotated by `phase` about ŷ×toSun, then by
      // `roll` about toSun. Solve both so dir = −tangent (camera behind the
      // body along the orbit, looking forward along it).
      let axis = cross({ x: 0, y: 1, z: 0 }, toSun);
      if (Math.hypot(axis.x, axis.y, axis.z) < 1e-6) axis = { x: 1, y: 0, z: 0 };
      axis = norm(axis);
      const target = { x: -tangent.x, y: -tangent.y, z: -tangent.z };
      const phaseRad = Math.acos(Math.max(-1, Math.min(1, dot(toSun, target))));
      const along = dot(toSun, target);
      const perp = norm({ x: target.x - toSun.x * along, y: target.y - toSun.y * along, z: target.z - toSun.z * along });
      const axisCrossSun = cross(axis, toSun);
      const rollRad = Math.atan2(dot(perp, axis), dot(perp, axisCrossSun));
      const distMul = alongKm / (r * kmPerAu);
      const fovDeg = 60;
      const fill = ((2 * Math.atan(r / (r * distMul))) * 180 / Math.PI) / fovDeg;
      if (!m.frame(body, fill, phaseRad * 180 / Math.PI, distMul, 0, 0, rollRad * 180 / Math.PI)) return resolve({ ok: false, why: 'frame2' });
      // Slide outward (radially) and off the plane; the camera keeps its aim.
      const radial = norm(p);
      const normal = norm(cross(radial, tangent));
      const dLat = lateralKm / kmPerAu;
      const dH = heightKm / kmPerAu;
      m.nudge(radial.x * dLat + normal.x * dH, radial.y * dLat + normal.y * dH, radial.z * dLat + normal.z * dH);
      m.setTimePaused(true);
      resolve({ ok: true, phaseDeg: phaseRad * 180 / Math.PI, rollDeg: rollRad * 180 / Math.PI, distMul, fill });
    })));
  }, { body: BODY, lateralKm: LATERAL_KM, heightKm: HEIGHT_KM, alongKm: ALONG_KM, epochMs: EPOCH_MS, kmPerAu: KM_PER_AU });
}

/**
 * The line's centreline in the frame's middle, as an ordered 1 px polyline,
 * and the tightest circumradius along it over 6 px triplets. The stroke is
 * the warm, dim pixels (the body's tint at line opacity; stars are white and
 * brighter). Thinning: the stroke pixels are grouped into 3 px cells along
 * the curve by a greedy walk from one end, each cell's centroid is a point.
 */
function tightestRadius(png, cx, cy, halfW, halfH) {
  const { width, height, channels, pixels } = png;
  const pts = [];
  for (let y = Math.max(0, cy - halfH); y < Math.min(height, cy + halfH); y++) {
    for (let x = Math.max(0, cx - halfW); x < Math.min(width, cx + halfW); x++) {
      const i = (y * width + x) * channels;
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      // Pluto's line: warm (r ≥ g ≥ b), dim to mid, never white.
      // The line at its opacity peaks near 120; a star's core is brighter
      // and white, its glow dim and neutral.
      if (luma > 18 && luma < 150 && r >= g && g >= b && r - b > 6) pts.push({ x, y, w: luma });
    }
  }
  if (pts.length < 20) return { radiusPx: NaN, points: pts.length, curve: [] };
  // Order by a greedy walk from one end of the stroke: the point farthest
  // from the centroid among those inside a stroke — a 3 px disc on a line
  // several px wide holds 14–28 stroke pixels; a warm star speck that
  // slipped the filter holds a handful, and would start a walk of one.
  const meanX = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const meanY = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const neighbours = (i) => { let n = 0; for (let j = 0; j < pts.length; j++) { if (j !== i && Math.hypot(pts[j].x - pts[i].x, pts[j].y - pts[i].y) <= 3) n++; } return n; };
  let start = -1;
  let far = -1;
  pts.forEach((p, i) => { const d = Math.hypot(p.x - meanX, p.y - meanY); if (d > far && neighbours(i) >= 14) { far = d; start = i; } });
  if (start < 0) return { radiusPx: NaN, points: pts.length, curveLengthPx: 0 };
  const used = new Uint8Array(pts.length);
  const curve = [];
  let cur = pts[start];
  used[start] = 1;
  for (;;) {
    // Gather the unused points within 3 px of the current one: one cell.
    const cell = [cur];
    for (let i = 0; i < pts.length; i++) {
      if (used[i]) continue;
      if (Math.hypot(pts[i].x - cur.x, pts[i].y - cur.y) <= 3) { used[i] = 1; cell.push(pts[i]); }
    }
    let sx = 0, sy = 0, sw = 0;
    for (const p of cell) { sx += p.x * p.w; sy += p.y * p.w; sw += p.w; }
    curve.push({ x: sx / sw, y: sy / sw });
    // Next: the nearest unused point ahead.
    let best = -1, bestD = Infinity;
    for (let i = 0; i < pts.length; i++) {
      if (used[i]) continue;
      const d = Math.hypot(pts[i].x - cur.x, pts[i].y - cur.y);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0 || bestD > 6) break;
    used[best] = 1;
    cur = pts[best];
  }
  // Resample at 1 px, smooth over ±4 px (the walk zigzags across the
  // stroke's width, and read raw those zigzags are kinks), and read
  // circumradii over ±8 px — away from the region's edge, where a truncated
  // cell bends the centreline.
  const rs = [curve[0]];
  let carry = 0;
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1], b = curve[i];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    let s = 1 - carry;
    while (s <= L) { const t = s / L; rs.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }); s += 1; }
    carry = L - (s - 1);
  }
  const smoothHalf = 4;
  const sm = rs.map((_, i) => {
    let sx = 0, sy = 0, n = 0;
    for (let j = Math.max(0, i - smoothHalf); j <= Math.min(rs.length - 1, i + smoothHalf); j++) { sx += rs[j].x; sy += rs[j].y; n++; }
    return { x: sx / n, y: sy / n };
  });
  const margin = 30;
  const inside = (p) => p.x > cx - halfW + margin && p.x < cx + halfW - margin && p.y > cy - halfH + margin && p.y < cy + halfH - margin;
  const span = 8;
  let radiusPx = Infinity, at = null;
  for (let i = span; i + span < sm.length; i++) {
    const a = sm[i - span], b = sm[i], c = sm[i + span];
    if (!inside(a) || !inside(b) || !inside(c)) continue;
    const ab = Math.hypot(b.x - a.x, b.y - a.y), bc = Math.hypot(c.x - b.x, c.y - b.y), ca = Math.hypot(a.x - c.x, a.y - c.y);
    const cr = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    const R = cr > 0 ? (ab * bc * ca) / (2 * cr) : Infinity;
    if (R < radiusPx) { radiusPx = R; at = b; }
  }
  return { radiusPx, at, points: pts.length, curveLengthPx: rs.length };
}

const release = await takeBrowserLock('orbit-bend');
const browser = await chromium.launch({ headless: true, executablePath, args: ARGS });
let allPass = true;
const report = {};
try {
  for (const run of [{ key: 'control', extra: '&orbitbend=0' }, { key: 'treated', extra: '' }]) {
    const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
    await context.addInitScript(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
        indexedDB.deleteDatabase('orbital-sim-storage');
        localStorage.setItem('planetarium-help-seen', '1');
        localStorage.setItem('planetarium-surface-hint-seen', '1');
      } catch {}
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log(`[orbit-bend] page error: ${e.message}`));
    await page.goto(`${URL}/?auto=planetarium${run.extra}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__moon?.ready?.(), null, { timeout: 90_000 });
    await sleep(1500);
    const posed = await pose(page);
    if (!posed.ok) { console.log(`[orbit-bend] ${run.key}: could not pose (${posed.why})`); allPass = false; await context.close(); continue; }
    await sleep(1500);
    await frames(page, 4);
    // The pass's cost, sampled over frames: the minimum is the work, the
    // median what a loaded main thread sees around it.
    const bend = await page.evaluate(() => new Promise((resolve) => {
      const samples = [];
      let lastState = null;
      const tick = () => {
        const b = window.__moon.orbitBend();
        if (b) { samples.push(b.passMs); lastState = b; }
        if (samples.length >= 20 || (!b && samples.length === 0 && ++tick.misses > 5)) {
          samples.sort((a, c) => a - c);
          resolve(lastState ? { ...lastState, passMsMin: samples[0], passMsMedian: samples[samples.length >> 1] } : null);
        } else requestAnimationFrame(tick);
      };
      tick.misses = 0;
      requestAnimationFrame(tick);
    }));
    const png = await page.screenshot({ type: 'png' });
    writeFileSync(`${OUT}/${run.key}.png`, png);
    const decoded = decodePng(png);
    const reading = tightestRadius(decoded, Math.round(decoded.width / 2), Math.round(decoded.height / 2), Math.round(decoded.width * 0.4), Math.round(decoded.height * 0.25));
    report[run.key] = { posed, bend, reading };
    const active = bend?.body === BODY;
    const ok = run.key === 'control'
      ? !active && reading.radiusPx < CORNER_MAX_PX
      : active && reading.radiusPx > BEND_MIN_PX;
    allPass = allPass && ok;
    console.log(`[orbit-bend] ${run.key}: ${ok ? 'PASS' : 'FAIL'} tightest radius ${reading.radiusPx.toFixed(1)} px (${reading.points} stroke px, centreline ${reading.curveLengthPx} px)`
      + (bend ? `; pass on ${bend.body}: turn ${bend.state.cornerTurnDeg.toFixed(1)}°, σ ${bend.state.sigmaPx.toFixed(1)} px, ${bend.state.smoothedCount} vertices, d ${(bend.state.distanceAU * KM_PER_AU).toFixed(0)} km, pass ${bend.passMsMin.toFixed(2)} ms min / ${bend.passMsMedian.toFixed(2)} ms median` : '; pass inactive'));
    await context.close();
  }
} finally {
  await browser.close();
  await release();
}
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log(`[orbit-bend] ${allPass ? 'PASS' : 'FAIL'} — frames in ${OUT}`);
process.exit(allPass ? 0 : 1);
