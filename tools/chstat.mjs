// Per-channel mean + delta between two images (same dimensions assumed/cropped
// to the smaller). Used to detect a colour-grading/tint shift between a 2K base
// map and a candidate 4K replacement, so an upgrade-on-approach swap doesn't pop.
//   node tools/chstat.mjs <imgA> <imgB>
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
const [a, b] = process.argv.slice(2);
async function uri(p) { return `data:image/jpeg;base64,${(await readFile(p)).toString('base64')}`; }
const br = await chromium.launch({ headless: true });
const pg = await br.newPage();
const ua = await uri(a), ub = await uri(b);
const r = await pg.evaluate(async ({ ua, ub }) => {
  const load = (s) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = s; });
  const ia = await load(ua), ib = await load(ub);
  const w = Math.min(ia.naturalWidth, ib.naturalWidth), h = Math.min(ia.naturalHeight, ib.naturalHeight);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(ia, 0, 0, w, h); const da = x.getImageData(0, 0, w, h).data;
  x.clearRect(0, 0, w, h); x.drawImage(ib, 0, 0, w, h); const db = x.getImageData(0, 0, w, h).data;
  let ar = 0, ag = 0, ab = 0, dr = 0, dg = 0, db_ = 0, n = 0;
  for (let i = 0; i < da.length; i += 4) {
    ar += da[i]; ag += da[i + 1]; ab += da[i + 2];
    dr += da[i] - db[i]; dg += da[i + 1] - db[i + 1]; db_ += da[i + 2] - db[i + 2]; n++;
  }
  return { meanA: [ar / n, ag / n, ab / n], meanB: [(ar - dr) / n, (ag - dg) / n, (ab - db_) / n], delta: [dr / n, dg / n, db_ / n] };
}, { ua, ub });
console.log('A mean RGB     :', r.meanA.map((v) => v.toFixed(1)).join(', '));
console.log('B mean RGB     :', r.meanB.map((v) => v.toFixed(1)).join(', '));
console.log('delta (A - B)  :', r.delta.map((v) => v.toFixed(1)).join(', '));
await br.close();
