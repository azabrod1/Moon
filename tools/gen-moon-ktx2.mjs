// Regenerate public/textures/8k/moon.ktx2 from public/textures/8k/moon.webp.
//
// Why this file exists: uploading the 8K albedo as raw RGBA is the largest
// unsliceable main-thread bill in the app — ~134MB through texImage2D plus a
// runtime mipmap build, measured as THE dropped frame right after a Moon
// teleport. A GPU-compressed KTX2 (UASTC, full mip chain baked at build time)
// uploads in a few milliseconds and stays compressed in VRAM (~45MB instead
// of ~180MB). The trade is network size: UASTC+zstd is a few times larger on
// the wire than the webp — paid only when a session actually earns the 8K
// tier, and cached by the service worker after the first visit.
//
// The source of truth stays the colour-matched moon.webp (kept on disk as the
// runtime fallback for devices without a bound KTX2 loader): this tool is a
// pure transcode of those exact pixels, so the colormatch grade carries over
// bit-identically at level 0 before block compression.
//
// -y_flip bakes the vertical flip: three's CompressedTexture cannot flipY at
// upload, so the file itself must store what a flipY'd image texture presents.
//
// Usage: node tools/gen-moon-ktx2.mjs
// Needs: dev machine with Chromium for Playwright (decodes the webp — no
// native webp decoder is assumed on the host), and the basis_universal
// devDependency (bundled basisu binary).
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, chmodSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcWebp = path.join(repo, 'public/textures/8k/moon.webp');
const outKtx2 = path.join(repo, 'public/textures/8k/moon.ktx2');
const basisu = path.join(repo, 'node_modules/basis_universal/bin/basisu');

const work = mkdtempSync(path.join(tmpdir(), 'moon-ktx2-'));
try {
  // 1. Decode the webp to PNG inside headless Chromium.
  console.log('[gen-moon-ktx2] decoding', path.relative(repo, srcWebp));
  const browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage();
  const pngBase64 = await page.evaluate(async (webpBase64) => {
    const bytes = Uint8Array.from(atob(webpBase64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let out = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) {
      out += String.fromCharCode(...buf.subarray(i, i + CHUNK));
    }
    return btoa(out);
  }, readFileSync(srcWebp).toString('base64'));
  await browser.close();
  const png = path.join(work, 'moon.png');
  writeFileSync(png, Buffer.from(pngBase64, 'base64'));
  console.log('[gen-moon-ktx2] decoded PNG:', (statSync(png).size / 1e6).toFixed(1), 'MB');

  // 2. Encode. UASTC (the high-quality mode — ETC1S bands on the maria),
  // level 2 with mild RDO, zstd supercompressed. The mip chain deliberately
  // uses a BOX filter on raw sRGB bytes — radiometrically naive, but exactly
  // what the GPU's generateMipmap builds for the webp tiers (the 4K rung
  // included), and the tier ladder's no-brightness-pop rule binds to the
  // shipped look, not to linear-light purity (a -mip_srgb kaiser chain
  // measured ~5/255 brighter on lit pixels than the webp 8K at the same
  // pose; box-on-sRGB brings the swap back to compression noise).
  chmodSync(basisu, 0o755);
  execFileSync(
    basisu,
    [
      '-ktx2',
      '-uastc',
      '-uastc_level', '2',
      '-uastc_rdo_l', '1.0',
      '-uastc_rdo_d', '8192',
      '-mipmap',
      '-mip_filter', 'box',
      '-y_flip',
      '-ktx2_zstandard_level', '18',
      '-output_file', outKtx2,
      png,
    ],
    { stdio: 'inherit' },
  );

  // 3. Sanity: KTX2 magic + a plausible size.
  const out = readFileSync(outKtx2);
  const magic = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb];
  if (!magic.every((b, i) => out[i] === b)) throw new Error('output is not a KTX2 file');
  if (out.length < 1e6) throw new Error('output suspiciously small');
  console.log(
    '[gen-moon-ktx2] wrote',
    path.relative(repo, outKtx2),
    (out.length / 1e6).toFixed(1),
    'MB (webp source',
    (statSync(srcWebp).size / 1e6).toFixed(1),
    'MB)',
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
