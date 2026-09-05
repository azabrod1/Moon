// Re-encode the shipped texture set as WebP: lossless for data maps
// (normal / bump / roughness — the lighting math reads exact values, and
// lossless WebP reproduces the PNG bit for bit at ~40% fewer bytes) and
// quality-85 for color photos (~40-50% fewer bytes; judged against the
// originals with tools/shoot.mjs before/after captures).
//
// Prereq (not a package.json dependency — this runs once per texture drop):
//   npm i --no-save sharp
//
// Regeneration flow: `npm run gen:maps` still writes PNGs (a canvas cannot
// encode lossless WebP), then this script converts and, with --clean,
// removes the heavier source it replaced:
//   node tools/encode-textures.mjs --clean
//
// SCOPE: this is the one-shot conversion for the LEGACY jpg/png names below,
// kept for a texture drop that still arrives in those formats. It is not the
// pipeline any current map goes through — gen-tiles.mjs writes the shipped
// .v2 maps as webp directly — so the list here names sources that no longer
// exist and skips them. Adding a map to the boot manifest does NOT mean
// adding it here.
import sharp from 'sharp';
import { stat, unlink } from 'node:fs/promises';
import path from 'node:path';

const TEX = path.resolve('public/textures');
const clean = process.argv.includes('--clean');

// The legacy source names, most of them long since replaced (see SCOPE
// above). A missing file is skipped, so the list is safe to leave as it is.
// Data maps (lossless) are the ones the shaders read as numbers; everything
// else is a photo (q85).
const FILES = [
  'mercury.jpg', 'venus.jpg', 'earth-day.jpg', 'earth-night.jpg', 'earth-clouds.jpg',
  'earth-bump.png', 'earth-roughness.png', 'mars.jpg', 'mars-normal.png', 'jupiter.jpg',
  'saturn.jpg', 'uranus.jpg', 'neptune.jpg', 'pluto.jpg', 'moon.jpg', 'moon-normal.png',
  'io.jpg', 'europa.jpg', 'ganymede.jpg', 'callisto.jpg', 'triton.jpg',
  '4k/mars.jpg', '4k/jupiter.jpg', '4k/pluto.jpg', '4k/moon.jpg', '4k/earth-clouds.jpg',
  '4k/moon-normal.png', '8k/moon.jpg', '8k/earth-clouds.jpg',
];
const isData = (f) => /normal|bump|roughness/.test(f);
// The cloud deck draws at 0.35 opacity over the globe, so its compression
// noise is a third as visible as a globe map's: q60 holds up in close crops
// and halves the bytes of the heaviest maps under the arrival veils.
const isCloudDeck = (f) => /earth-clouds/.test(f);

let from = 0;
let to = 0;
for (const file of FILES) {
  const src = path.join(TEX, file);
  const out = src.replace(/\.(jpg|jpeg|png)$/, '.webp');
  let size;
  try {
    size = (await stat(src)).size;
  } catch {
    console.log(`skip (absent): ${file}`);
    continue;
  }
  const img = sharp(src, { limitInputPixels: false });
  // keepMetadata carries any ICC profile across so a color-managed decode
  // shows the same colors the original showed.
  if (isData(file)) await img.webp({ lossless: true, effort: 5 }).keepMetadata().toFile(out);
  else await img.webp({ quality: isCloudDeck(file) ? 60 : 85, effort: 5 }).keepMetadata().toFile(out);
  const outSize = (await stat(out)).size;
  from += size;
  to += outSize;
  console.log(`${file.padEnd(24)} ${(size / 1024).toFixed(0).padStart(6)}KB -> ${(outSize / 1024).toFixed(0).padStart(6)}KB ${isData(file) ? '[lossless]' : isCloudDeck(file) ? '[q60]' : '[q85]'}`);
  if (clean) await unlink(src);
}
console.log(`total: ${(from / 1e6).toFixed(1)}MB -> ${(to / 1e6).toFixed(1)}MB (-${Math.round((1 - to / from) * 100)}%)${clean ? ', sources removed' : ''}`);
