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
  'earth-bump.png', 'earth-roughness.png', 'earth-clouds-normal.png',
  'mars.jpg', 'mars-normal.png', 'jupiter.jpg',
  'saturn.jpg', 'uranus.jpg', 'neptune.jpg', 'pluto.jpg', 'moon.jpg', 'moon-normal.png',
  'io.jpg', 'europa.jpg', 'ganymede.jpg', 'callisto.jpg', 'triton.jpg',
  '4k/mars.jpg', '4k/jupiter.jpg', '4k/pluto.jpg', '4k/moon.jpg', '4k/earth-clouds.jpg',
  '4k/moon-normal.png', '8k/moon.jpg', '8k/earth-clouds.jpg',
];
const isData = (f) => /normal|bump|roughness/.test(f);
// The cloud relief is the one data map that does not get plain lossless. It is
// a height field guessed from a q60 colour map's brightness, and a cloud field
// is nearly incompressible: 998 KB lossless against 641 KB near-lossless, for
// two counts of worst-case error — under a degree of tilt on a map the deck
// reads at 0.6. Every other data map here holds a measurement and keeps its
// bytes exactly.
const isNearLossless = (f) => /earth-clouds-normal/.test(f);
// The cloud deck's colour map is the alpha as well as the colour now, so its
// compression noise reaches the coverage — but through a curve whose slope is
// 1.9 per unit of stored luminance, which turns 2/255 of encoder error into
// 0.015 of alpha. q60 still holds up in close crops and still halves the bytes
// of the heaviest maps under the arrival veils. The RELIEF cut from the same
// map is a data map and stays lossless, above.
const isCloudDeck = (f) => /earth-clouds\.(jpg|webp)$/.test(f);

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
  if (isNearLossless(file)) await img.webp({ lossless: true, nearLossless: true, quality: 60, effort: 5 }).keepMetadata().toFile(out);
  else if (isData(file)) await img.webp({ lossless: true, effort: 5 }).keepMetadata().toFile(out);
  else await img.webp({ quality: isCloudDeck(file) ? 60 : 85, effort: 5 }).keepMetadata().toFile(out);
  const outSize = (await stat(out)).size;
  from += size;
  to += outSize;
  const how = isNearLossless(file) ? '[near-lossless]' : isData(file) ? '[lossless]' : isCloudDeck(file) ? '[q60]' : '[q85]';
  console.log(`${file.padEnd(24)} ${(size / 1024).toFixed(0).padStart(6)}KB -> ${(outSize / 1024).toFixed(0).padStart(6)}KB ${how}`);
  if (clean) await unlink(src);
}
console.log(`total: ${(from / 1e6).toFixed(1)}MB -> ${(to / 1e6).toFixed(1)}MB (-${Math.round((1 - to / from) * 100)}%)${clean ? ', sources removed' : ''}`);
