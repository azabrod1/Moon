// A scan ALONG the ground, across the terminator — the measurement the goldens'
// own limb scan cannot make.
//
// The captures carry a 41-point scan on the centre row, and every pose in the
// set frames the limb there, so that scan crosses the EDGE of the disc: sky,
// air, space. What it never crosses is the terminator on the surface, which is
// where a night source that arrives on the wrong ramp shows — as a band of
// ground darker than the ground on either side of it, between the twilight
// going out and the moonlight coming in.
//
// So: the mean of a band of rows, column by column, for one or more captures of
// the same pose. The band is what makes it readable — a single row across a
// night side is terrain albedo and 8-bit quantisation, and eighty rows of it
// average to a profile.
//
//   node tools/atmo-ground-scan.mjs a.png [b.png ...] --y0=380 --y1=470
//
// No browser: the PNGs are decoded here.
import { readFile } from 'node:fs/promises';
import { decodePng } from './pngDecode.mjs';

const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.slice(name.length + 3)) : def;
};
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const y0 = arg('y0', 380);
const y1 = arg('y1', 470);
const step = arg('step', 12);

const images = [];
for (const file of files) images.push(await decodePng(await readFile(file)));

/** One column's mean channel over the band. */
function column(img, x) {
  const sum = [0, 0, 0];
  for (let y = y0; y <= y1; y++) {
    const i = (y * img.width + x) * img.channels;
    for (let c = 0; c < 3; c++) sum[c] += img.pixels[i + c];
  }
  return sum.map((v) => v / (y1 - y0 + 1));
}

console.log(`[ground-scan] rows ${y0}-${y1}, every ${step}th column`);
console.log(`   x     ${files.map((f) => f.split('/').pop().padEnd(20)).join(' | ')}`);
const profiles = images.map(() => []);
for (let x = 0; x < images[0].width; x += step) {
  const cells = images.map((img) => column(img, x));
  console.log(String(x).padStart(4), cells.map((c) => c.map((v) => v.toFixed(2).padStart(6)).join(',')).join(' | '));
  // Green, which is where a moonlit ground reads against a twilight sky.
  cells.forEach((c, i) => profiles[i].push([x, c[1]]));
}
// The trough, and the ground past it — the MEDIAN of the columns beyond the
// trough rather than the last of them, because the far end of a night side is
// as likely to be a city as it is to be moonlit ground.
console.log('   green trough, against the ground beyond it:');
profiles.forEach((profile, i) => {
  let min = Infinity;
  let at = 0;
  for (const [x, v] of profile) if (v < min) { min = v; at = x; }
  const beyond = profile.filter(([x]) => x > at).map(([, v]) => v).sort((a, b) => a - b);
  const past = beyond.length ? beyond[beyond.length >> 1] : min;
  console.log(`     ${files[i].split('/').pop()}: min ${min.toFixed(2)} at x=${at}`
    + `, median beyond it ${past.toFixed(2)} = ${(past / Math.max(min, 1e-6)).toFixed(1)}x`);
});
