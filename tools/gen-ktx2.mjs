// Regenerate the GPU-compressed 8K colour rungs under public/textures/8k/.
//
// Why these files exist: uploading an 8K albedo as raw RGBA is the largest
// unsliceable main-thread bill in the app — ~134MB through texImage2D plus a
// runtime mipmap build, measured as THE dropped frame right after a Moon
// teleport — and 170.7 MiB of a device's texture envelope for as long as it
// is held. A KTX2 container (UASTC, full mip chain baked at build time)
// uploads in a few milliseconds and stays compressed in VRAM at 42.7 MiB,
// which is what lets four 8K maps be resident where two used to be the
// ceiling. The trade is network size: UASTC+zstd is a few times larger on the
// wire than a webp — paid only when a session actually earns the 8K tier, and
// cached by the service worker after the first visit.
//
// Where a job's pixels come from is the one thing that differs between them,
// and it follows one rule: the container ships THE SAME PIXELS the rung would
// otherwise have. Where an 8K webp is also on disk (the Moon, the cloud deck,
// which predate this pipeline and stay as the fallback for a device with no
// KTX2 loader), the container is a pure transcode of that file, so the two
// paths draw the same map. Where none ships — Earth's day and night maps,
// which exist at 8K only as a container — the source is the graded level-0
// equirect tools/gen-tiles.mjs cuts its tiles and its 4K rung from, resampled
// here exactly as that tool resamples its own downsamples. So an 8K rung is a
// pure sharpen of the 4K below it, and neither the ocean grade nor the night
// map's no-data mask can drift between the globe and the sectors over it.
//
// -y_flip bakes the vertical flip: three's CompressedTexture cannot flipY at
// upload, so the file itself must store what a flipY'd image texture presents.
//
// Name the jobs to run: basisu's output is not identical across its own
// builds (a 1.16.3 and a 1.16.4 encoder differ by a few dozen bytes on the
// same input), so a blanket run on a machine with a different binary rewrites
// every container and pushes 25 MB of re-download per map for a picture
// nobody can tell apart.
//
// Usage: node tools/gen-ktx2.mjs <job...> | --all  [--keep-png]
//        node tools/gen-ktx2.mjs earthDay --cache=<dir>
// Needs: run from the repo root; the @gpu-tex-enc/basis devDependency (the
// basisu binary, built for every platform — the encoder is the same one
// upstream ships and BASISU points at another); Chromium for Playwright for
// the webp jobs (decodes the webp — no native webp decoder is assumed on the
// host); and, for the two jobs cut from a level, `npm i --no-save
// sharp@0.35.4` plus the sources under .moon-data-cache/ that gen-tiles reads
// (--cache moves that directory; the night level's cached resample is what
// keeps that job minutes rather than hours).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, chmodSync, statSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// gen-tiles resolves its own paths against the working directory, and this
// tool borrows its job table.
process.chdir(repo);

const TEX = path.join(repo, 'public/textures');

/** The basisu binary for this host. @gpu-tex-enc/basis carries the same
 *  encoder built for every platform, one directory per platform-arch, which
 *  is what makes this pipeline runnable on the machine the maps are authored
 *  on; the non-SSE build is the one named, because the SSE build is the same
 *  encoder with a code path that does not exist on arm64 and the two do not
 *  produce identical bytes. BASISU overrides it for a host neither covers. */
const basisu = process.env.BASISU
  ?? path.join(repo, 'node_modules/@gpu-tex-enc/basis/bin', `${process.platform}-${process.arch}`, 'basisu');
// Every rung this tool writes is the 8K tier; the width is the tier's, not a
// per-job choice, because the ladder charges and draws it as that tier.
const WIDTH = 8192;
const HEIGHT = WIDTH / 2;

/** A job whose pixels are an 8K webp already on disk: the container is a pure
 *  transcode of exactly those bytes, so the fallback and the compressed rung
 *  are the same map. */
const fromWebp = (file) => ({ kind: 'webp', file: path.join(TEX, '8k', file) });

/** A job with no 8K webp: the pixels come from the level-0 equirect
 *  gen-tiles builds for that job — graded and masked as its tiles are — and
 *  are resampled to 8192 with the kernel gen-tiles uses for its own
 *  downsamples, so this rung and the 4K below it are one resample apart. */
const fromLevel = (job) => ({ kind: 'level', job });

const JOBS = {
  moon: { source: fromWebp('moon.webp'), out: '8k/moon.ktx2' },
  earthClouds: { source: fromWebp('earth-clouds.webp'), out: '8k/earth-clouds.ktx2' },
  earthDay: { source: fromLevel('earth'), out: '8k/earth-day.v2.ktx2' },
  earthNight: { source: fromLevel('earth-night'), out: '8k/earth-night.v2.ktx2' },
};

const args = process.argv.slice(2);
const keepPng = args.includes('--keep-png');
const wanted = args.includes('--all') ? Object.keys(JOBS) : args.filter((a) => !a.startsWith('--'));
if (wanted.length === 0) {
  console.error(`usage: node tools/gen-ktx2.mjs <job...> | --all  [--keep-png] [--cache=dir]\njobs: ${Object.keys(JOBS).join(', ')}`);
  process.exit(2);
}
for (const name of wanted) {
  if (!JOBS[name]) {
    console.error(`unknown job ${name}; known: ${Object.keys(JOBS).join(', ')}`);
    process.exit(2);
  }
}

/** One browser for the whole run: launching Chromium per map is seconds each
 *  and the decode itself is the only thing that needs it. */
let browser = null;
async function chromiumPage() {
  if (!browser) {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({
      executablePath: process.env.PW_CHROMIUM || undefined,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
  }
  return browser.newPage();
}

/** Decode an image to PNG inside headless Chromium. Base64 across the bridge:
 *  the evaluate boundary is JSON, and an 8K PNG is ~100 MB of it. */
async function decodeToPng(srcFile, mime, pngOut) {
  const page = await chromiumPage();
  try {
    const pngBase64 = await page.evaluate(async ([b64, type]) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type }));
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
    }, [readFileSync(srcFile).toString('base64'), mime]);
    writeFileSync(pngOut, Buffer.from(pngBase64, 'base64'));
  } finally {
    await page.close();
  }
}

/** The level-0 equirect of a gen-tiles job, resampled to the 8K tier. Same
 *  kernel and same `fit` as that tool's own downsamples: the 4K rung under
 *  this one is the identical call at half the width. */
async function levelToPng(jobName, pngOut) {
  const [{ default: sharp }, tiles] = await Promise.all([
    import('sharp'),
    import('./gen-tiles.mjs'),
  ]);
  const job = tiles.JOBS[jobName];
  if (!job) throw new Error(`gen-tiles has no ${jobName} job`);
  const { rows } = await tiles.levelRowSource(job, job.levels[0]);
  try {
    console.log(`  level 0 is ${rows.width}x${rows.height}; resampling to ${WIDTH}x${HEIGHT}`);
    const whole = await rows.whole();
    await sharp(whole, { raw: { width: rows.width, height: rows.height, channels: 3 }, limitInputPixels: false })
      .resize(WIDTH, HEIGHT, { fit: 'fill', kernel: 'lanczos3' })
      .png({ compressionLevel: 1 })
      .toFile(pngOut);
  } finally {
    await rows.close();
  }
}

async function sourcePng(source, pngOut) {
  if (source.kind === 'webp') {
    if (!existsSync(source.file)) throw new Error(`${source.file} is not on disk`);
    console.log('  decoding', path.relative(repo, source.file));
    await decodeToPng(source.file, 'image/webp', pngOut);
    return;
  }
  await levelToPng(source.job, pngOut);
}

/**
 * Encode. UASTC (the high-quality mode — ETC1S bands on the maria), level 2
 * with mild RDO, zstd supercompressed. The mip chain deliberately uses a BOX
 * filter on raw sRGB bytes — radiometrically naive, but exactly what the GPU's
 * generateMipmap builds for the webp tiers (the 4K rung included), and the
 * tier ladder's no-brightness-pop rule binds to the shipped look, not to
 * linear-light purity (a -mip_srgb kaiser chain measured ~5/255 brighter on
 * lit pixels than the webp 8K at the same pose; box-on-sRGB brings the swap
 * back to compression noise).
 */
function encode(png, out) {
  if (!existsSync(basisu)) {
    throw new Error(`no basisu for ${process.platform}-${process.arch} at ${basisu}; set BASISU to one`);
  }
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
      '-output_file', out,
      png,
    ],
    { stdio: 'inherit' },
  );
}

/** KTX2 magic, the tier's own dimensions, and a full mip chain: the three
 *  things the app assumes of a container before it has read a byte of it. */
function checkContainer(out) {
  const buf = readFileSync(out);
  const magic = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb];
  if (!magic.every((b, i) => buf[i] === b)) throw new Error(`${out} is not a KTX2 file`);
  const width = buf.readUInt32LE(20);
  const height = buf.readUInt32LE(24);
  const levels = buf.readUInt32LE(40);
  if (width !== WIDTH || height !== HEIGHT) throw new Error(`${out} is ${width}x${height}, not ${WIDTH}x${HEIGHT}`);
  if (levels !== Math.log2(WIDTH) + 1) throw new Error(`${out} carries ${levels} mip levels, not a full chain`);
  return buf;
}

for (const name of wanted) {
  const job = JOBS[name];
  const out = path.join(TEX, job.out);
  const before = existsSync(out) ? createHash('sha256').update(readFileSync(out)).digest('hex') : null;
  const work = mkdtempSync(path.join(tmpdir(), `ktx2-${name}-`));
  const png = path.join(work, `${name}.png`);
  const t0 = Date.now();
  console.log(`== ${name} -> ${job.out}`);
  try {
    await sourcePng(job.source, png);
    console.log('  source PNG:', (statSync(png).size / 1e6).toFixed(1), 'MB');
    const tEncode = Date.now();
    encode(png, out);
    const buf = checkContainer(out);
    const after = createHash('sha256').update(buf).digest('hex');
    console.log(
      `  wrote ${job.out} ${(buf.length / 1e6).toFixed(1)} MB` +
      ` (encode ${((Date.now() - tEncode) / 1000).toFixed(0)} s, job ${((Date.now() - t0) / 1000).toFixed(0)} s)`,
    );
    console.log(`  sha256 ${after}${before === null ? ' (new)' : before === after ? ' (unchanged)' : ` (was ${before})`}`);
    if (keepPng) console.log(`  kept ${png}`);
  } finally {
    if (!keepPng) rmSync(work, { recursive: true, force: true });
  }
}
await browser?.close();
