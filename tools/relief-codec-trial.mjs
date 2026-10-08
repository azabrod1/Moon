// What a GPU block format would do to a relief crop, in degrees of normal.
//
// The relief under a sector is a tangent-space normal map held on the GPU; the
// question this answers is whether it could be held compressed. It takes one
// shipped crop, encodes it the ways a device could hold it, decodes each back
// and measures the angle between every decoded normal and the crop's own:
//
//   - UASTC (basisu, level 3, linear, no RDO), transcoded as three's KTX2Loader
//     would on each class of device: BC7 (desktop with BPTC), ASTC 4x4 (phones
//     and Apple), ETC1 (ETC2 devices with no alpha) and BC1 (DXT-only);
//   - BC5 — two independent BC4 channels, the block format made for normals —
//     through a reference encoder here (a small endpoint search, 8 levels a
//     block a channel), with z rebuilt as √(1 − x² − y²);
//   - the floor: z rebuilt from the exact 8-bit x and y against the stored
//     blue, which is what reading two channels costs on its own.
//
// Measured on mars-normal.v3/8k crop 2_1 (2026-10-07, basisu 1.15):
//
//   UASTC→BC7     mean 0.53°  p99 3.8°  max 17.8°  16.8 % of texels > 1°
//   UASTC→ASTC    mean 0.51°  p99 3.7°  max 18.4°  16.1 %
//   UASTC→ETC1    mean 1.87°  p99 12.8° max 55°    56.8 %
//   UASTC→BC1     mean 1.38°  p99 8.6°  max 43°    49.8 %
//   BC5 (ref.)    mean 0.25°  p99 2.0°  max 8.0°    5.7 %
//   z from x, y   mean 0.004° max 0.46°
//
// A 4×4 block fits its texels to one line in colour space (two for BC5), and a
// crater rim's normals do not lie on one: the tail is the rim. Level 4 and the
// red-plus-alpha layout basisu offers for normals moved none of these numbers.
// That is why the app stores every normal map as its two channels, lossless,
// at two bytes a texel (world/texturePolicy's 'normal' kind) rather than as
// blocks at one: half the bytes for nothing, against a quarter for a visible
// rim.
//
// Prereq: npm i --no-save sharp@0.35.4; the @gpu-tex-enc/basis devDependency.
// Usage: node tools/relief-codec-trial.mjs [--crop=<webp>] [--level=3] [--keep]
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const hit = args.find((a) => a.startsWith(`--${name}=`)); return hit ? hit.slice(name.length + 3) : fallback; };
const crop = path.resolve(opt('crop', 'public/textures/tiles/mars-normal.v3/8k.232997f4/2_1.webp'));
const level = Number(opt('level', '3'));
const keep = args.includes('--keep');
/** The same binary tools/gen-ktx2.mjs encodes the colour rungs with. */
const basisu = process.env.BASISU
  ?? path.resolve('node_modules/@gpu-tex-enc/basis/bin', `${process.platform}-${process.arch}`, 'basisu');
if (!existsSync(basisu)) throw new Error(`no basisu at ${basisu}; set BASISU`);
chmodSync(basisu, 0o755);

const work = mkdtempSync(path.join(tmpdir(), 'relief-codec-'));
const png = path.join(work, 'crop.png');
const ref = await sharp(crop).removeAlpha().raw().toBuffer({ resolveWithObject: true });
if (ref.info.channels !== 3) throw new Error(`${crop}: ${ref.info.channels} channels, not 3`);
await sharp(crop).removeAlpha().png().toFile(png);
const { width, height } = ref.info;
const texels = width * height;
console.log(`${path.relative(process.cwd(), crop)}: ${width}×${height}`);

/** The angle between two 8-bit tangent normals, in degrees. `z` null means rebuild it from x and y. */
function angleDeg(ax, ay, az, bx, by, bz) {
  const unit = (x, y, z) => { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };
  const a = unit(ax / 127.5 - 1, ay / 127.5 - 1, az / 127.5 - 1);
  const bxn = bx / 127.5 - 1, byn = by / 127.5 - 1;
  const b = unit(bxn, byn, bz === null ? Math.sqrt(Math.max(0, 1 - bxn * bxn - byn * byn)) : bz / 127.5 - 1);
  return Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180 / Math.PI;
}

/** Angle statistics of a decoded map (`get(i) -> [x, y, z|null]`) against a reference raster. */
function stats(label, get, reference) {
  const angles = new Float32Array(texels);
  let sum = 0; let over1 = 0;
  for (let i = 0; i < texels; i++) {
    const [x, y, z] = get(i);
    const a = angleDeg(reference[i * 3], reference[i * 3 + 1], reference[i * 3 + 2], x, y, z);
    angles[i] = a; sum += a; if (a > 1) over1++;
  }
  angles.sort();
  const q = (f) => angles[Math.min(texels - 1, Math.floor(f * texels))];
  console.log(`  ${label.padEnd(14)} mean ${(sum / texels).toFixed(3)}°  p50 ${q(0.5).toFixed(2)}°  p99 ${q(0.99).toFixed(2)}°  max ${q(1).toFixed(2)}°  >1°: ${(100 * over1 / texels).toFixed(1)} %`);
}

// --- UASTC, through basisu, as the KTX2Loader's targets would see it ---
const ktx2 = path.join(work, 'crop.ktx2');
execFileSync(basisu, ['-ktx2', '-uastc', '-uastc_level', String(level), '-linear', '-mipmap', '-mip_filter', 'box', '-y_flip', '-output_file', ktx2, png], { stdio: 'ignore' });
execFileSync(basisu, ['-unpack', '-no_ktx', '-file', ktx2], { cwd: work, stdio: 'ignore' });
// -y_flip stores the image upside down, so the unpacked rows are compared
// against the crop's flip.
const flipped = (await sharp(png).flip().raw().toBuffer({ resolveWithObject: true })).data;
console.log(`UASTC level ${level}, as each device class transcodes it:`);
for (const target of ['BC7_RGBA', 'ASTC_RGBA', 'ETC1_RGB', 'BC1_RGB']) {
  const file = path.join(work, `crop_unpacked_rgb_${target}_0_0_0000.png`);
  const got = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  stats(target, (i) => [got.data[i * 3], got.data[i * 3 + 1], got.data[i * 3 + 2]], flipped);
}

// --- BC5: two BC4 channels through a reference encoder ---
function bc4Palette(e0, e1) {
  const p = [e0, e1];
  if (e0 > e1) for (let i = 1; i <= 6; i++) p.push(((7 - i) * e0 + i * e1) / 7);
  else { for (let i = 1; i <= 4; i++) p.push(((5 - i) * e0 + i * e1) / 5); p.push(0, 255); }
  return p;
}
function encodeBc4(values) {
  let lo = 255; let hi = 0;
  for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (lo === hi) return values.map(() => lo);
  let best = null;
  const attempt = (e0, e1) => {
    if (!(e0 > e1)) return;
    const palette = bc4Palette(e0, e1);
    let err = 0; const out = new Array(16);
    for (let i = 0; i < 16; i++) {
      let bestIndex = 0; let bestDistance = Infinity;
      for (let k = 0; k < 8; k++) { const d = Math.abs(palette[k] - values[i]); if (d < bestDistance) { bestDistance = d; bestIndex = k; } }
      out[i] = palette[bestIndex]; err += bestDistance * bestDistance;
    }
    if (!best || err < best.err) best = { out, err };
  };
  // The block's line need not end at its extremes: a few pairs pulled inward.
  for (let s = 0; s <= 3; s++) {
    const shrink = (hi - lo) * s / 14;
    const e0 = Math.round(hi - shrink); const e1 = Math.round(lo + shrink);
    attempt(e0, e1); attempt(Math.min(255, e0 + 1), e1); attempt(e0, Math.max(0, e1 - 1));
  }
  return best.out;
}
const bc5 = [new Float32Array(texels), new Float32Array(texels)];
for (let channel = 0; channel < 2; channel++) {
  for (let by = 0; by < height; by += 4) {
    for (let bx = 0; bx < width; bx += 4) {
      const values = [];
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) values.push(ref.data[(Math.min(height - 1, by + j) * width + Math.min(width - 1, bx + i)) * 3 + channel]);
      const decoded = encodeBc4(values);
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
        const x = bx + i; const y = by + j;
        if (x < width && y < height) bc5[channel][y * width + x] = decoded[j * 4 + i];
      }
    }
  }
}
console.log('BC5, a reference encoder (two channels, z rebuilt):');
stats('BC5', (i) => [bc5[0][i], bc5[1][i], null], ref.data);
console.log('The floor: z rebuilt from the exact x and y against the stored blue:');
stats('z from x, y', (i) => [ref.data[i * 3], ref.data[i * 3 + 1], null], ref.data);
if (!keep) rmSync(work, { recursive: true, force: true });
else console.log(`kept ${work}`);
