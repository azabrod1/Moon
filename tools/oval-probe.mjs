// Measures how oval an off-centre Sun disc renders: captures poses at
// increasing NDC offsets, thresholds the near-saturated disc, and prints the
// bounding-box width/height ratio next to the rectilinear 1/cos(theta)
// prediction. Prereq: dev server on :5174.
//   node tools/oval-probe.mjs
import { chromium } from 'playwright';

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
    } catch { /* harmless */ }
  });
  const page = await context.newPage();
  await page.goto('http://localhost:5174/?auto=planetarium', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 45000 });
  await page.evaluate(() => window.__moon.setChrome(false));

  const poses = [
    { name: 'centred', offX: 0, offY: 0 },
    { name: 'offX 0.35', offX: 0.35, offY: 0 },
    { name: 'offX 0.6', offX: 0.6, offY: 0 },
    { name: 'offX 0.9', offX: 0.9, offY: 0 },
    { name: 'corner 0.75/0.65', offX: 0.75, offY: 0.65 },
  ];
  for (const pose of poses) {
    await page.evaluate(([x, y]) => window.__moon.frameSun(0.02, 60, x, y), [pose.offX, pose.offY]);
    await page.waitForTimeout(1800);
    const shot = (await page.screenshot()).toString('base64');
    const m = await page.evaluate(async (b64) => {
      const img = await new Promise((res) => {
        const i = new Image(); i.onload = () => res(i); i.src = `data:image/png;base64,${b64}`;
      });
      const snap = document.createElement('canvas');
      snap.width = img.naturalWidth; snap.height = img.naturalHeight;
      const g = snap.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, snap.width, snap.height).data;
      let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1, count = 0;
      for (let y = 0; y < snap.height; y++) {
        for (let x = 0; x < snap.width; x++) {
          const i = (y * snap.width + x) * 4;
          if (d[i] >= 253 && d[i + 1] >= 253 && d[i + 2] >= 250) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            count++;
          }
        }
      }
      return { w: maxX - minX + 1, h: maxY - minY + 1, count };
    }, shot);
    // Rectilinear prediction: radial stretch 1/cos(theta) at off-axis angle
    // theta; for a horizontal offset the stretch axis is x.
    const halfV = Math.tan((60 / 2) * Math.PI / 180);
    const aspect = 1600 / 900;
    const dx = halfV * aspect * pose.offX;
    const dy = halfV * pose.offY;
    const theta = Math.atan(Math.hypot(dx, dy));
    console.log(
      `${pose.name.padEnd(18)} disc ${String(m.w).padStart(4)}x${String(m.h).padStart(4)} px  ` +
      `ratio ${(m.w / m.h).toFixed(3)}  predicted radial stretch ${(1 / Math.cos(theta)).toFixed(3)}  (${m.count}px)`,
    );
  }
} finally {
  await browser.close();
}
