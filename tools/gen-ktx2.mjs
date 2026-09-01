// Regenerate the GPU-compressed colour rungs under public/textures/<tier>/.
//
// Why these files exist: uploading a big albedo as raw RGBA is the largest
// unsliceable main-thread bill in the app. The driver charges an sRGB
// conversion per upload call over the whole source, so the cost cannot be
// spread across frames by banding the rows: an 8K map is ~134MB through
// texImage2D plus a runtime mipmap build, measured as THE dropped frame right
// after a Moon teleport, and even a 4K one costs 2.9 to 4.0 ms in a single
// shot (measured through renderer.initTexture on an Apple GPU under
// Chromium) — a missed refresh at 120 Hz, and more on a device with less to
// spend, paid per map by the boot warm and by every arrival. A KTX2 container
// (full mip chain baked at build time) uploads as a memcpy of already-encoded
// blocks — a millisecond or so for a 4K, a few for an 8K, and it bands — and
// stays compressed in VRAM: 10.7 MiB for a 4K rung instead of 42.7, 42.7 for
// an 8K instead of 170.7, which is what lets four 8K maps be resident where
// two used to be the ceiling.
//
// Two encodings, and a job says which. UASTC is a fixed 8 bits a texel
// whatever the picture holds, so it costs several times the webp on the wire
// and many times it for a low-frequency map — worth it only where the picture
// needs it. ETC1S is a shared codebook, roughly webp-sized on the wire and
// half of UASTC in VRAM, and what it costs is smooth gradients: the codebook
// spends a block index per distinct shade, so a slow ramp comes back as steps.
// Which one a map wants is a question about the map. Either way the bytes are
// paid only when a session actually earns the tier, and cached by the service
// worker after the first visit.
//
// Where a job's pixels come from is the one thing that differs between them,
// and it follows one rule: the container ships THE SAME PIXELS the rung would
// otherwise have. Where a webp of that tier is also on disk (the planet rungs,
// and the 8K Moon and cloud deck, which stay as the fallback for a device
// with no KTX2 loader), the container is a pure transcode of that file, so
// the two paths draw the same map. Where none ships — Earth's 8K day and
// night maps, which exist at that tier only as a container — the source is
// the graded level-0 equirect tools/gen-tiles.mjs cuts its tiles and its 4K
// rung from, resampled here exactly as that tool resamples its own
// downsamples. So an 8K rung is a pure sharpen of the 4K below it, and
// neither the ocean grade nor the night map's no-data mask can drift between
// the globe and the sectors over it. The moon rungs are the third case: they
// ship as a container alone, so their pixels come from the PNG
// tools/gen-moonmaps.mjs writes beside the boot map it cuts in the same run.
//
// -y_flip bakes the vertical flip: three's CompressedTexture cannot flipY at
// upload, so the file itself must store what a flipY'd image texture presents.
//
// Name the jobs to run: basisu's output is not identical across its own
// builds (a 1.16.3 and a 1.16.4 encoder differ by a few dozen bytes on the
// same input), so a blanket run on a machine with a different binary rewrites
// every container and pushes megabytes of re-download per map for a picture
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
// A rung's width is its TIER's, never a per-job choice, because the ladder
// charges and draws it as that tier: a container a size off would be charged
// one tier's bytes and sampled at another's.
const TIER_WIDTH = { '4k': 4096, '8k': 8192 };

/** A job whose pixels are a webp of the same tier already on disk: the
 *  container is a pure transcode of exactly those bytes, so the fallback and
 *  the compressed rung are the same map. */
const fromWebp = (tier, file) => ({ kind: 'webp', file: path.join(TEX, tier, file) });

/** A job with no webp at its tier: the pixels come from the level-0 equirect
 *  gen-tiles builds for that job — graded and masked as its tiles are — and
 *  are resampled to the tier's width with the kernel gen-tiles uses for its
 *  own downsamples, so this rung and the one below it are one resample
 *  apart. */
const fromLevel = (job) => ({ kind: 'level', job });

/** A job whose pixels come from tools/gen-moonmaps.mjs' intermediate for that
 *  rung, under .moon-data-cache/zoom/rungs/. The two kinds above cannot serve
 *  a moon rung that ships as a container ALONE: fromWebp needs a shipped webp
 *  of that tier, which is exactly what such a rung does not have (and what
 *  textureTiers.assets.test.ts forbids it from having), and fromLevel needs a
 *  gen-tiles job, which only the three streamed bodies have. The
 *  intermediate is the same resample the body's shipped maps came out of, in
 *  the same run, so the container is a pure sharpen of the boot map under it
 *  by construction. */
const fromMoonmap = (name) => ({ kind: 'moonmap', name });

/** RDO lambda where a job does not name one. Higher trades a little picture
 *  for a smaller file: the UASTC blocks are a fixed 8 bits a texel either
 *  way, and what RDO buys is blocks that repeat, which is what zstd behind it
 *  compresses. */
const DEFAULT_RDO_LAMBDA = 1.0;

/** RDO match-window in bytes where a job does not name one. Larger finds more
 *  repeats for zstd behind it and costs only encode time. */
const DEFAULT_RDO_DICT = 8192;

/** One job per compressed rung the ladder can ask for. The 8K jobs keep the
 *  bare names they were first run under; a 4K job says its tier, because a
 *  key can now have a rung at both. */
const JOBS = {
  moon: { tier: '8k', source: fromWebp('8k', 'moon.webp'), out: '8k/moon.ktx2' },
  earthClouds: { tier: '8k', source: fromWebp('8k', 'earth-clouds.webp'), out: '8k/earth-clouds.ktx2' },
  earthDay: { tier: '8k', source: fromLevel('earth'), out: '8k/earth-day.v2.ktx2' },
  earthNight: { tier: '8k', source: fromLevel('earth-night'), out: '8k/earth-night.v2.ktx2' },
  // The 4K rungs whose container earns its place on the wire. A rung a
  // session TOURS may cost at most four times its webp twin to download: the
  // twin has to keep shipping (a device with no transcoder climbs it), and a
  // tour of six planets pulling tens of megabytes where it pulled a few is a
  // bill on mobile data that a smoother upload does not settle.
  //
  // Only two of the toured maps clear it, and the reason is UASTC's shape
  // rather than the encoder's settings: the blocks are a fixed 8 bits a texel
  // whatever the picture holds, so a 4096x2048 container has a floor near
  // 1.6 MB however smooth the map is, while a webp of smooth content is a
  // hundred-odd KB. The cap is therefore only reachable where the webp is
  // itself large. Measured across the whole set at RDO lambda 1, 2 and 4
  // (and, for the nearest misses, a 64K RDO dictionary as well): Venus and
  // Saturn barely move at all — 2.30 to 2.29 MB and 1.96 to 1.95 — because
  // they are already at that floor, and they sit at 17x their webp. Jupiter
  // lands at 11x, Pluto at 5.05x. Every one of them was well inside the
  // picture gate the whole way (worst |mean| 0.25 and RMS 2.09 against a
  // limit of 2 and 6), so it is the wire that rules them out and nothing
  // else. They keep their webp rung.
  //
  // Mercury clears it at the default lambda. Mars needs lambda 4 (4.53x at 1,
  // 4.24x at 2, 3.81x at 4) and is unharmed by it.
  mercury4k: { tier: '4k', source: fromWebp('4k', 'mercury.webp'), out: '4k/mercury.ktx2' },
  mars4k: { tier: '4k', rdo: 4.0, source: fromWebp('4k', 'mars.v2.webp'), out: '4k/mars.v2.ktx2' },
  // The three the boot warm uploads, which is why the toured cap does not
  // rule them: the idle after boot fetches these on EVERY session, so a
  // device downloads each one once and the worker serves it thereafter, while
  // the frame their upload costs is paid every session until the container
  // takes it away. Their bar is five times the twin, and the lambda ladder
  // plus the 64K dictionary is what gets them there — the Moon comes down
  // 7.05 MB at lambda 1 to 5.30 at 4 with the dictionary (4.8x), the cloud
  // deck 7.58 to 6.58 (4.9x). The night map is the stubborn one: 1.84 down to
  // 1.61 on that ladder and only 1.47 at lambda 16, which is 5.3x — over the
  // bar on ratio, 1.2 MB over it in bytes, and the encoder has nothing left
  // to give at this format. That trade is the row's, not this table's
  // (src/planetarium/PlanetFactory.ts).
  //
  // ETC1S was the other way out and was tried on all three: it is a few times
  // smaller, and it is refused on picture. Its shared codebook has to spend a
  // block index per distinct shade, so a slow ramp comes back as steps — and
  // a slow ramp is exactly what these three are made of (the maria, the
  // deck's soft edges, the night map's falloff into unlit land). A container
  // that quietly shipped ETC1S would put a WORSE picture on the globe than
  // the webp rung it replaced, which is why each container's format is pinned
  // per file rather than left to whoever runs the job:
  // textureTiers.assets.test.ts reads colorModel out of every one and checks
  // it against the mode this table chose for it.
  moon4k: { tier: '4k', rdo: 4.0, rdoDict: 65536, source: fromWebp('4k', 'moon.webp'), out: '4k/moon.ktx2' },
  earthClouds4k: { tier: '4k', rdo: 4.0, rdoDict: 65536, source: fromWebp('4k', 'earth-clouds.webp'), out: '4k/earth-clouds.ktx2' },
  earthNight4k: { tier: '4k', rdo: 16.0, rdoDict: 65536, source: fromWebp('4k', 'earth-night.v2.webp'), out: '4k/earth-night.v2.ktx2' },
  // ---------------------------------------------------------------------
  // The photo-moon rungs. Every one is ETC1S, and every one ships as a
  // container ALONE — no webp twin at that tier at all.
  //
  // The wire cap that rules the planet rungs above never binds here, because
  // ETC1S is not priced like UASTC: measured on a 4096x2048 candidate per
  // body, these containers come in at 0.67x to 2.99x their webp twin (ten of
  // the twelve under 1.9x) — Enceladus 0.67, Dione 0.82, Callisto 0.86,
  // Tethys 0.98, Europa 1.06, Pluto 1.19, Ganymede 1.34, Rhea 1.35, Iapetus
  // 1.45, Charon 1.76, Mimas 1.84, Io 2.99. Eight of those were re-measured
  // against the albedo-levelled maps; Io, Ganymede and Pluto's pictures did
  // not change, and Europa's ratio is its pre-levels one (its container moved
  // 5% on the level change, far inside the spread this argument turns on).
  // Against the same candidate read at
  // 2048 the two encodes are indistinguishable in RMS (webp 1.67-4.47, ETC1S
  // 1.68-4.21; ETC1S is the better of the pair on five of the twelve), and
  // the crops that decide it — Io's chroma, Enceladus' limb, Iapetus'
  // albedo boundary, Pluto's ramps — carry no banding and no blocking.
  //
  // Why these maps and not the Moon or Earth's night lights, which the table
  // above pins AGAINST ETC1S: what its codebook cannot hold is a slow ramp,
  // and that is what the maria and the night map's falloff into unlit land
  // are made of. A cratered icy moon is texture at every scale, which is the
  // codebook's best case.
  //
  // So the fork the planet rungs live with — a container for the upload,
  // a webp twin for the wire and for a device with no transcoder — collapses
  // for this batch: one file is both, at a quarter of the VRAM. What a
  // session with no transcoder loses is the rung, not the body; it stays on
  // the boot map, which is the same deal Earth's 8K day map already makes.
  //
  // Pixels come from the gen:moonmaps intermediates rather than from a
  // shipped file, which is what the third source kind above exists for.
  enceladus4k: { tier: '4k', mode: 'etc1s', source: fromMoonmap('enceladus-4k'), out: '4k/enceladus.ktx2' },
  mimas4k: { tier: '4k', mode: 'etc1s', source: fromMoonmap('mimas-4k'), out: '4k/mimas.ktx2' },
  dione4k: { tier: '4k', mode: 'etc1s', source: fromMoonmap('dione-4k'), out: '4k/dione.ktx2' },
  tethys4k: { tier: '4k', mode: 'etc1s', source: fromMoonmap('tethys-4k'), out: '4k/tethys.ktx2' },
  rhea4k: { tier: '4k', mode: 'etc1s', source: fromMoonmap('rhea-4k'), out: '4k/rhea.ktx2' },
  iapetus4k: { tier: '4k', mode: 'etc1s', source: fromMoonmap('iapetus-4k'), out: '4k/iapetus.ktx2' },
  charon4k: { tier: '4k', mode: 'etc1s', source: fromMoonmap('charon-4k'), out: '4k/charon.ktx2' },
  callisto4k: { tier: '4k', mode: 'etc1s', source: fromMoonmap('callisto-4k'), out: '4k/callisto.v2.ktx2' },
  pluto4k: { tier: '4k', mode: 'etc1s', source: fromMoonmap('pluto-4k'), out: '4k/pluto.v2.ktx2' },
  // The 8K rungs. Each sits behind a trigger gate that only a deliberate
  // close approach to that one body crosses, so it is never tour traffic
  // whatever it costs; what it must not do is hold 170.7 MiB, which is what
  // the uncompressed twin would be. At ETC1S it holds 21.3.
  io8k: { tier: '8k', mode: 'etc1s', source: fromMoonmap('io-8k'), out: '8k/io.v2.ktx2' },
  europa8k: { tier: '8k', mode: 'etc1s', source: fromMoonmap('europa-8k'), out: '8k/europa.v2.ktx2' },
  ganymede8k: { tier: '8k', mode: 'etc1s', source: fromMoonmap('ganymede-8k'), out: '8k/ganymede.v2.ktx2' },
  callisto8k: { tier: '8k', mode: 'etc1s', source: fromMoonmap('callisto-8k'), out: '8k/callisto.v2.ktx2' },
  pluto8k: { tier: '8k', mode: 'etc1s', source: fromMoonmap('pluto-8k'), out: '8k/pluto.v2.ktx2' },
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

/** The level-0 equirect of a gen-tiles job, resampled to the rung's tier.
 *  Same kernel and same `fit` as that tool's own downsamples: the rung under
 *  this one is the identical call at half the width. */
async function levelToPng(jobName, pngOut, width) {
  const [{ default: sharp }, tiles] = await Promise.all([
    import('sharp'),
    import('./gen-tiles.mjs'),
  ]);
  const job = tiles.JOBS[jobName];
  if (!job) throw new Error(`gen-tiles has no ${jobName} job`);
  const { rows } = await tiles.levelRowSource(job, job.levels[0]);
  try {
    console.log(`  level 0 is ${rows.width}x${rows.height}; resampling to ${width}x${width / 2}`);
    const whole = await rows.whole();
    await sharp(whole, { raw: { width: rows.width, height: rows.height, channels: 3 }, limitInputPixels: false })
      .resize(width, width / 2, { fit: 'fill', kernel: 'lanczos3' })
      .png({ compressionLevel: 1 })
      .toFile(pngOut);
  } finally {
    await rows.close();
  }
}

/** The gen:moonmaps intermediate for a rung, already a PNG at the tier's
 *  width. Copied rather than re-encoded: it IS the picture the rung ships. */
function moonmapPng(name, pngOut, width) {
  const cacheArg = process.argv.slice(2).find((a) => a.startsWith('--cache='));
  const cache = path.resolve(cacheArg ? cacheArg.slice('--cache='.length) : '.moon-data-cache');
  const src = path.join(cache, 'zoom', 'rungs', `${name}.png`);
  if (!existsSync(src)) {
    throw new Error(`${src} is not on disk — run \`node tools/gen-moonmaps.mjs ${name.replace(/-\d+k$/, '')}\` first`);
  }
  console.log('  reading', src);
  writeFileSync(pngOut, readFileSync(src));
  const meta = readFileSync(pngOut);
  const w = meta.readUInt32BE(16);
  if (w !== width) throw new Error(`${src} is ${w} px wide, not the tier's ${width}`);
}

async function sourcePng(source, pngOut, width) {
  if (source.kind === 'webp') {
    if (!existsSync(source.file)) throw new Error(`${source.file} is not on disk`);
    console.log('  decoding', path.relative(repo, source.file));
    await decodeToPng(source.file, 'image/webp', pngOut);
    return;
  }
  if (source.kind === 'moonmap') {
    moonmapPng(source.name, pngOut, width);
    return;
  }
  await levelToPng(source.job, pngOut, width);
}

/**
 * Encode, in one of the two modes basisu offers.
 *
 * UASTC is the high-quality one: fixed 8 bits a texel, level 2 with mild RDO,
 * zstd supercompressed. Size on the wire is what it costs, and it does not
 * depend on the picture — which is why a map whose webp is small can never
 * reach a container worth downloading.
 *
 * ETC1S is the small one: a shared codebook of 4x4 blocks, BasisLZ
 * supercompressed, a few times smaller than the same map in UASTC and half
 * its VRAM. What it costs is smooth gradients — the codebook has to spend a
 * block index on every distinct shade, so a slow ramp comes back as steps.
 * That rules it out for the maps made of ramps and rules it IN for the ones
 * made of texture, which is the split the job table draws: the planet and
 * Earth rungs are UASTC, the photo-moon rungs ETC1S. Neither can be shipped
 * by accident — every container's colour model is pinned per file in
 * textureTiers.assets.test.ts.
 *
 * -q 255 -comp_level 5 is basisu's largest codebooks and its slowest endpoint
 * search: encode time is a build-machine cost paid once per map, and the
 * codebook is exactly what an ETC1S picture lives or dies on.
 *
 * The mip chain deliberately uses a BOX filter on raw sRGB bytes in both —
 * radiometrically naive, but exactly what the GPU's generateMipmap builds for
 * a webp map: the boot map every body starts on, and the webp rung a device
 * with no transcoder still climbs to. The tier ladder's no-brightness-pop rule
 * binds to the shipped look, not to linear-light purity (a -mip_srgb kaiser
 * chain measured ~5/255 brighter on lit pixels than the webp 8K at the same
 * pose; box-on-sRGB brings the swap back to compression noise).
 */
function encode(png, out, mode, rdoLambda, rdoDict) {
  if (!existsSync(basisu)) {
    throw new Error(`no basisu for ${process.platform}-${process.arch} at ${basisu}; set BASISU to one`);
  }
  chmodSync(basisu, 0o755);
  // basisu's own supercompression for ETC1S (BasisLZ, which the container
  // records as scheme 1); zstd is the UASTC path's and does nothing here.
  const modeArgs = mode === 'etc1s'
    ? ['-q', '255', '-comp_level', '5']
    : ['-uastc', '-uastc_level', '2', '-uastc_rdo_l', String(rdoLambda), '-uastc_rdo_d', String(rdoDict),
      '-ktx2_zstandard_level', '18'];
  execFileSync(
    basisu,
    [
      '-ktx2',
      ...modeArgs,
      '-mipmap',
      '-mip_filter', 'box',
      '-y_flip',
      '-output_file', out,
      png,
    ],
    { stdio: 'inherit' },
  );
}

/** KTX2 magic, the tier's own dimensions, and a full mip chain: the three
 *  things the app assumes of a container before it has read a byte of it. */
function checkContainer(out, want) {
  const buf = readFileSync(out);
  const magic = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb];
  if (!magic.every((b, i) => buf[i] === b)) throw new Error(`${out} is not a KTX2 file`);
  const width = buf.readUInt32LE(20);
  const height = buf.readUInt32LE(24);
  const levels = buf.readUInt32LE(40);
  if (width !== want || height !== want / 2) throw new Error(`${out} is ${width}x${height}, not ${want}x${want / 2}`);
  if (levels !== Math.log2(want) + 1) throw new Error(`${out} carries ${levels} mip levels, not a full chain`);
  return buf;
}

for (const name of wanted) {
  const job = JOBS[name];
  const out = path.join(TEX, job.out);
  const before = existsSync(out) ? createHash('sha256').update(readFileSync(out)).digest('hex') : null;
  const work = mkdtempSync(path.join(tmpdir(), `ktx2-${name}-`));
  const png = path.join(work, `${name}.png`);
  const t0 = Date.now();
  const width = TIER_WIDTH[job.tier];
  console.log(`== ${name} -> ${job.out} (${width}x${width / 2})`);
  try {
    await sourcePng(job.source, png, width);
    console.log('  source PNG:', (statSync(png).size / 1e6).toFixed(1), 'MB');
    const tEncode = Date.now();
    encode(png, out, job.mode ?? 'uastc', job.rdo ?? DEFAULT_RDO_LAMBDA, job.rdoDict ?? DEFAULT_RDO_DICT);
    const buf = checkContainer(out, width);
    const after = createHash('sha256').update(buf).digest('hex');
    console.log(
      `  wrote ${job.out} ${(buf.length / 1e6).toFixed(1)} MB` +
      ` as ${job.mode ?? 'uastc'}${(job.mode ?? 'uastc') === 'uastc' ? ` rdo ${job.rdo ?? DEFAULT_RDO_LAMBDA}` : ''}` +
      ` (encode ${((Date.now() - tEncode) / 1000).toFixed(0)} s, job ${((Date.now() - t0) / 1000).toFixed(0)} s)`,
    );
    console.log(`  sha256 ${after}${before === null ? ' (new)' : before === after ? ' (unchanged)' : ` (was ${before})`}`);
    if (keepPng) console.log(`  kept ${png}`);
  } finally {
    if (!keepPng) rmSync(work, { recursive: true, force: true });
  }
}
await browser?.close();
