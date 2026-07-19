// One dramatic prominence portrait: finds the sim time when a loop-prominence
// anchor sits on the limb as seen from the devFrameSun camera, pins the
// eruption mid-lift-off, and shoots the arch towering toward the ship.
//
// Prereq: dev server on :5174. Then: node tools/prom-shot.mjs [--out=path]
import { chromium } from 'playwright';
import * as THREE from 'three';

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
const out = arg('out', '/tmp/moon-shots/prominence-toward-ship.png');

// --- Mirror of the app's frame math (planetary.ts conventions) ---
const DEG = Math.PI / 180;
const raDec = (raDeg, decDeg) => new THREE.Vector3(
  Math.cos(decDeg * DEG) * Math.cos(raDeg * DEG),
  Math.sin(decDeg * DEG),
  -Math.cos(decDeg * DEG) * Math.sin(raDeg * DEG),
);
const J2000_MS = Date.UTC(2000, 0, 1, 11, 58, 55, 816);
function sunOrientation(utcMs) {
  const d = (utcMs - J2000_MS) / 86_400_000; // ΔT offset is negligible at 14°/day
  const w = 84.176 + 14.1844 * d;
  const pole = raDec(286.13, 63.87).normalize();
  const prime = raDec(286.13 + 90, 0).applyAxisAngle(pole, w * DEG).normalize();
  const basisZ = new THREE.Vector3().crossVectors(prime, pole).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(prime, pole, basisZ),
  );
}

// The big loop's anchor — SUN_ACTIVE_REGIONS[0] (sun.ts).
const anchors = [
  new THREE.Vector3(0.38, -0.37, 0.85).normalize(),
];
const camDir = new THREE.Vector3(0.62, 0.18, 0.76).normalize(); // devFrameSun pose

// Hunt one Carrington rotation for an anchor near the limb (dot ≈ -0.02,
// so the arch rises over the horizon) whose arch plane is also viewed
// OBLIQUELY: end-on the shader fades the loop (it would contour into
// rings), so the money shot needs sideOn well above that fade band.
let best = null;
const t0 = Date.UTC(2026, 6, 19);
for (let h = 0; h < 26 * 24; h++) {
  const t = t0 + h * 3_600_000;
  const q = sunOrientation(t);
  const qInv = q.clone().invert();
  for (const anchor of anchors) {
    const a = anchor.clone().applyQuaternion(q);
    const limbDot = a.dot(camDir);
    if (limbDot < -0.05 || limbDot > 0.01) continue;
    const east = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), anchor).normalize();
    const foot1 = anchor.clone().addScaledVector(east, 0.10).normalize();
    const foot2 = anchor.clone().addScaledVector(east, -0.10).normalize();
    const n = new THREE.Vector3().crossVectors(foot1, foot2).normalize();
    const camObj = camDir.clone().multiplyScalar(2.8).applyQuaternion(qInv);
    const rayObj = anchor.clone().multiplyScalar(1.08).sub(camObj).normalize();
    const sideOn = Math.abs(rayObj.dot(n));
    if (!best || sideOn > best.sideOn) best = { sideOn, t, a: a.clone() };
  }
}
if (!best) throw new Error('no limb pass found');
console.log(`[prom-shot] sideOn ${best.sideOn.toFixed(2)}`);

// Slide the Sun off-centre so that limb point owns the frame. Image basis for
// a camera at camDir looking at the origin (matches devFrameSun's lookAt).
const forward = camDir.clone().negate();
const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
const up = new THREE.Vector3().crossVectors(right, forward).normalize();
const u = new THREE.Vector2(best.a.dot(right), best.a.dot(up)).normalize();
// Narrow-FOV close-up: the disc radius spans ~3.1 NDC at 14°, so slide the
// Sun almost a full disc radius off-centre — the anchor's limb point lands
// near frame centre with sky above it for the arch.
const offX = -u.x * 2.85;
const offY = -u.y * 2.85;
const iso = new Date(best.t).toISOString();
console.log(`[prom-shot] anchor limb pass at ${iso} (dot ${best.a.dot(camDir).toFixed(3)}), offNdc (${offX.toFixed(2)}, ${offY.toFixed(2)})`);

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    try {
      localStorage.clear(); sessionStorage.clear();
      indexedDB.deleteDatabase('orbital-sim-storage');
      localStorage.setItem('planetarium-help-seen', '1');
      localStorage.setItem('planetarium-surface-hint-seen', '1');
    } catch { /* storage blocked — harmless */ }
  });
  const page = await context.newPage();
  await page.goto('http://localhost:5174/?auto=planetarium', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 45000 });
  await page.evaluate(() => window.__moon.setChrome(false));
  await page.evaluate((t) => window.__moon.setTimeMs(t), best.t);
  // Mid-lift-off: the crown still fits inside the shell ceiling, so the whole
  // arch reads; full 1.0 would already have detached it. Rain on the legs.
  await page.evaluate(() => window.__moon.sunEruption(0.45));
  await page.evaluate(() => window.__moon.sunRain(0.7));
  await page.evaluate(([x, y]) => window.__moon.frameSun(0.013, 14, x, y), [offX, offY]);
  await page.waitForTimeout(2500);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.screenshot({ path: out });
  console.log(`[prom-shot] -> ${out}`);
} finally {
  await browser.close();
}
