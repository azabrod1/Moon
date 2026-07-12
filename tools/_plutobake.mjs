// Bake the shipped Pluto map: real USGS New Horizons grayscale mosaic -> registered,
// colorized base. Recipe (source = USGS LORRI-MVIC 300 m/px global mosaic, pre-
// downsampled to an 8K PNG via sips):
//  1) roll 180deg in longitude (register the heart onto the IAU prime-meridian UV)
//  2) colorize by luminance through Pluto's real albedo/colour ramp
//     (dark tholin red-brown -> mid tan -> pale N2-ice cream)
//  3) no-data south (near-black) -> clean neutral dark "unknown" cap, not ramped
//  4) progressive-halve down to TARGET wide (2048 base, 4096 for the 4K tier)
// Honest: geometry + brightness are real New Horizons data; colour follows the real
// brightness-vs-composition correlation and asserts no specific feature. The under-
// imaged far hemisphere is left as-is (soft) — synthetic relief/detail was tried and
// dropped (it read as fake craters at grazing light).
import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
const SRC = process.env.SRC || '/tmp/pluto-8k.png';
const OUT = process.env.OUT || '/tmp/pluto-baked-2k.jpg';
const TARGET = Number(process.env.TARGET || 2048);
const b64 = (await readFile(SRC)).toString('base64');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const out = await page.evaluate(async ({ b64, TARGET }) => {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
  const W = img.width, H = img.height;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const ctx = cv.getContext('2d');
  // 180deg longitude roll.
  ctx.drawImage(img, W / 2, 0, W / 2, H, 0, 0, W / 2, H);
  ctx.drawImage(img, 0, 0, W / 2, H, W / 2, 0, W / 2, H);
  const id = ctx.getImageData(0, 0, W, H), d = id.data;

  // Pluto albedo/colour ramp (luminance 0..1 -> rgb).
  const stops = [
    [0.00, [58, 41, 32]], [0.28, [104, 80, 60]], [0.52, [156, 130, 102]],
    [0.74, [202, 184, 150]], [0.90, [228, 216, 190]], [1.00, [242, 236, 220]],
  ];
  const ramp = (t) => {
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        const [a, ca] = stops[i - 1], [b, cb] = stops[i];
        const f = (t - a) / (b - a);
        return [ca[0] + (cb[0] - ca[0]) * f, ca[1] + (cb[1] - ca[1]) * f, ca[2] + (cb[2] - ca[2]) * f];
      }
    }
    return stops[stops.length - 1][1];
  };
  const CAP = [42, 38, 34]; // neutral dark "no-data / unilluminated" tone
  for (let i = 0; i < W * H; i++) {
    const p = i * 4, L = d[p] / 255;
    if (d[p] < 14) { d[p] = CAP[0]; d[p + 1] = CAP[1]; d[p + 2] = CAP[2]; continue; } // no-data cap
    const c = ramp(L);
    d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2];
  }
  ctx.putImageData(id, 0, 0);

  // Progressive halve to TARGET wide.
  let cur = cv, cw = W, ch = H;
  while (cw > TARGET) {
    const nw = cw >> 1, nh = ch >> 1;
    const nc = document.createElement('canvas'); nc.width = nw; nc.height = nh;
    const nx = nc.getContext('2d'); nx.imageSmoothingEnabled = true; nx.imageSmoothingQuality = 'high';
    nx.drawImage(cur, 0, 0, nw, nh);
    cur = nc; cw = nw; ch = nh;
  }
  return cur.toDataURL('image/jpeg', 0.92).split(',')[1];
}, { b64, TARGET });
await browser.close();
await writeFile(OUT, Buffer.from(out, 'base64'));
console.log(`baked ${SRC} -> ${OUT}`);
