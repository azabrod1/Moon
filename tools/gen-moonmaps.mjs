// Photo maps for the moons that ship as procedural balls, plus the re-based
// boots under the bodies whose sharper rungs are cut here.
//
// Every map this writes is one spacecraft mosaic resampled once. What makes
// that non-trivial is that no two of the sources are laid out the same way,
// and the renderer accepts exactly one layout:
//
//   TARGET: 0 degrees east at u = 0.5, east increasing rightward, so the left
//   edge is 180E. That is three's SphereGeometry (u = 0 lands on the mesh's
//   -X axis, u = 0.5 on +X, which is where the body frame puts the prime
//   meridian) and it is what every correctly-drawn map in the tree already
//   uses: Earth's Blue Marble has Greenwich at the centre, and Mars' equirect
//   is assembled from WMS bboxes that run -180..180 east.
//
// A source's own layout comes from the raster, not from the PDS3 label's
// POSITIVE_LONGITUDE_DIRECTION: that keyword describes the coordinate SYSTEM
// the label quotes numbers in, while the GeoTIFF's ModelTiepoint +
// ModelPixelScale + the projection's central-meridian GeoKey describe where
// the pixels are, and for every product here the pixels run EAST-increasing.
// Reading the label as if it also ordered the columns says seven of these
// fifteen maps are mirrored, and they are not — Loki Patera and Pele land on
// their gazetteer longitudes in the east-increasing reading of Io's mosaic
// and nowhere near them in the mirrored one. So the only transform a source
// ever needs here is a longitude ROLL, never a flip, and the roll follows
// from one number: the east longitude at the source's left edge
// (gen-moonmaps.sources.json, `longitude.leftEdgeLonDegEast`).
//
// Consequence worth stating plainly, because it changes what four shipped
// bodies look like: io.webp, europa.webp, ganymede.webp and callisto.webp are
// all laid out with 0E at the LEFT edge, which is half a turn off what the
// renderer samples — those four have been drawing the anti-Jupiter hemisphere
// where the sub-Jupiter one belongs. The .v2 re-bases here are cut in the
// target layout, so they turn 180 degrees against the maps they replace.
// Pluto is the one that was already right: tools/_plutobake.mjs rolled its
// source deliberately, and this pipeline reproduces that roll from the
// manifest rather than by hand.
//
// The resample is wrap-aware: a lanczos3 reduction reads a few dozen source
// columns per output column, and at the map's edge there is nothing to read,
// so the source is padded with a halo of its own opposite edge before the
// resize and the halo is cropped off after. Without it every map carries a
// soft seam, and for the half-rolled bodies that seam would land at the prime
// meridian — the middle of the disc on a tidally locked moon.
//
// Ten of the fifteen sources are single-band. A grey moon renders as a grey
// ball, so each mono body carries a colour pass keyed to its published
// appearance: either an explicit luminance -> RGB ramp (the recipe the
// shipped Pluto map was baked with, kept verbatim so its re-base is a pure
// sharpen) or a subtler luminance-keyed gain that leaves the source's
// photometry alone and only tilts its chroma. Nothing here invents a feature:
// colour follows brightness, which is the real correlation on these bodies,
// and the ramps stay close to neutral because these moons ARE nearly grey.
//
// Miranda and Ariel are the two partial sources: Voyager 2 imaged their
// southern hemispheres and the north is no-data black. They ship as full
// globes anyway, with the unimaged half filled from the imaged one —
// reflected across the data edge, blurred and noised toward the pole behind a
// wide soft blend, the same shape of answer Triton's shipped map already
// carries. There is no hard data edge on the drawn body.
//
// Prereq (not a package.json dependency — this runs once per asset drop):
//   npm i --no-save sharp@0.35.4
// Usage:
//   node tools/gen-moonmaps.mjs <job...>     # one or more bodies
//   node tools/gen-moonmaps.mjs --all
//   node tools/gen-moonmaps.mjs --verify     # re-check source digests only
//   --cache=<dir>  .moon-data-cache root (sources live in <dir>/zoom)
//   --no-rungs     skip the KTX2 intermediates (the slow part)
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

sharp.cache(false);
sharp.concurrency(0);

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TEX = path.join(repo, 'public/textures');
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const CACHE = path.join(path.resolve(opt('cache', '.moon-data-cache')), 'zoom');
// Where the KTX2 jobs read their pixels from: a rung that ships as a
// container alone has no shipped webp for tools/gen-ktx2.mjs to transcode, so
// the picture it encodes is written here instead of into public/.
const RUNGS = path.join(CACHE, 'rungs');

// The encoding idiom every shipped photo map uses (tools/encode-textures.mjs,
// tools/gen-tiles.mjs): quality 85 at effort 5.
const PHOTO_WEBP = { quality: 85, effort: 5 };

// Padding, in OUTPUT pixels, carried around the map's longitude seam through
// the resize. lanczos3 reads 3 output pixels either side of its centre, so 8
// is comfortably more than the kernel can reach.
const SEAM_HALO = 8;

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/**
 * An explicit luminance -> RGB ramp, for a body whose real colour varies with
 * brightness strongly enough to be the point of the map (Pluto's tholin-dark
 * to nitrogen-ice-pale range, Iapetus' two tones). Stops are [t, [r,g,b]] with
 * t the source luminance in 0..1, linearly interpolated.
 */
const ramp = (stops) => (L) => {
  for (let i = 1; i < stops.length; i++) {
    if (L <= stops[i][0]) {
      const [a, ca] = stops[i - 1];
      const [b, cb] = stops[i];
      const f = (L - a) / (b - a);
      return [ca[0] + (cb[0] - ca[0]) * f, ca[1] + (cb[1] - ca[1]) * f, ca[2] + (cb[2] - ca[2]) * f];
    }
  }
  return stops[stops.length - 1][1];
};

/**
 * The subtle one: keep the source's luminance exactly and tilt only its
 * chroma, by a per-channel gain that slides from `dark` at black to `light` at
 * white. A body whose published colour is "grey, slightly warmer where it is
 * dirtier" is one line of this and cannot drift far from the photometry it was
 * cut from, which a ramp can.
 */
const gains = (dark, light) => (L) => [
  L * 255 * (dark[0] + (light[0] - dark[0]) * L),
  L * 255 * (dark[1] + (light[1] - dark[1]) * L),
  L * 255 * (dark[2] + (light[2] - dark[2]) * L),
];

// Pluto's ramp, verbatim from the bake the shipped map came out of
// (tools/_plutobake.mjs): dark tholin red-brown -> mid tan -> pale N2-ice
// cream, with the never-imaged south left as a neutral "unknown" cap rather
// than ramped, so the map does not assert a colour for pixels that hold no
// data. Kept exactly so the re-base is a sharpen and not a new look.
const PLUTO_RAMP = ramp([
  [0.00, [58, 41, 32]], [0.28, [104, 80, 60]], [0.52, [156, 130, 102]],
  [0.74, [202, 184, 150]], [0.90, [228, 216, 190]], [1.00, [242, 236, 220]],
]);
const PLUTO_CAP = [42, 38, 34];

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/**
 * One job per body. `src` is the manifest key (which is the cached file's
 * name); `outputs` are the shipped maps, widest first for no reason but
 * readability; `rungs` are the widths written to the cache for gen-ktx2.
 *
 * Widths are not free choices. A body's BOOT width is whatever the app
 * already fetches for it — re-basing a map is a change of product, not of the
 * ladder's arithmetic, so callisto stays 1800 and io/europa/ganymede stay 4096
 * exactly as they ship today. The new bodies boot at 2048 like every other
 * moon. A 4K rung is written only where the source can actually fill it:
 * Titan's mosaic is 4040 px and Miranda's and Ariel's are 1440, so those three
 * are boot-only and the rest of their detail is the procedural blend's job.
 */
const JOBS = {
  // --- the eight that ship as noise balls today -----------------------------
  titan: {
    src: 'Titan_ISS_P19658_Mosaic_Global_4km.tif',
    outputs: [{ width: 2048, out: 'titan.webp' }],
    // Cassini ISS 938 nm methane-window mosaic: what it records is surface
    // brightness through the haze, and the haze is what the renderer draws
    // over it anyway (atmosphereModel treats Titan as a haze ball). The tint
    // is the dune-field brown the ISS/VIMS colour composites show, held well
    // back because almost none of it survives the haze.
    colour: gains([0.86, 0.74, 0.55], [1.0, 0.94, 0.80]),
  },
  enceladus: {
    src: 'Enceladus_Cassini_mosaic_global_110m.tif',
    outputs: [{ width: 4096, out: '4k/enceladus.webp' }, { width: 2048, out: 'enceladus.webp' }],
    // The most reflective surface in the solar system and as close to neutral
    // as anything gets: the gain is a whisper of blue in the shadows and
    // nothing at all in the highlights.
    colour: gains([0.98, 0.99, 1.0], [1.0, 1.0, 1.0]),
  },
  mimas: {
    src: 'PIA17214_Mimas_global_map_2017.tif',
    outputs: [{ width: 4096, out: '4k/mimas.webp' }, { width: 2048, out: 'mimas.webp' }],
    colour: gains([0.99, 0.975, 0.95], [1.0, 0.995, 0.985]),
  },
  dione: {
    src: 'Dione_Cassini_Voyager_mosaic_global_154m.tif',
    outputs: [{ width: 4096, out: '4k/dione.webp' }, { width: 2048, out: 'dione.webp' }],
    colour: gains([0.99, 0.975, 0.95], [1.0, 0.995, 0.985]),
  },
  tethys: {
    src: 'Tethys_Cassini_mosaic_global_293m.tif',
    outputs: [{ width: 4096, out: '4k/tethys.webp' }, { width: 2048, out: 'tethys.webp' }],
    colour: gains([0.99, 0.98, 0.96], [1.0, 0.997, 0.99]),
  },
  rhea: {
    src: 'Rhea_Cassini_Voyager_mosaic_global_417m.tif',
    outputs: [{ width: 4096, out: '4k/rhea.webp' }, { width: 2048, out: 'rhea.webp' }],
    colour: gains([0.99, 0.975, 0.95], [1.0, 0.995, 0.985]),
  },
  iapetus: {
    src: 'Iapetus_Cassini_Voyager_mosaic_global_783m.tif',
    outputs: [{ width: 4096, out: '4k/iapetus.webp' }, { width: 2048, out: 'iapetus.webp' }],
    // The one Saturnian whose colour is the point: Cassini Regio is dark
    // red-brown and the trailing ice is very slightly yellow, so the two tones
    // want different chroma and a ramp is the honest way to give it to them.
    // The ramp's luminance follows the source's within a couple of counts.
    colour: ramp([
      [0.00, [26, 18, 13]], [0.16, [58, 41, 30]], [0.34, [104, 84, 68]],
      [0.55, [162, 152, 140]], [0.78, [214, 210, 200]], [1.00, [250, 249, 244]],
    ]),
  },
  charon: {
    src: 'Charon_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif',
    outputs: [{ width: 4096, out: '4k/charon.webp' }, { width: 2048, out: 'charon.webp' }],
    // Neutral grey almost everywhere; the exception is Mordor Macula, the
    // red-brown tholin stain over the north pole, which New Horizons' colour
    // imaging showed and this map's luminance already holds as a dark cap. The
    // polar term reddens only what is BOTH high-latitude and dark, so nothing
    // at the equator picks up a tint from it.
    colour: gains([0.99, 0.985, 0.98], [1.0, 1.0, 1.0]),
    polarTint: { fromLat: 50, gain: [1.30, 1.02, 0.86], darkerThan: 0.62 },
    // A third of this mosaic is polar night, all of it south of about 37S.
    // Pluto's shipped map ends the same way and for the same reason, so its
    // twin ends there too — softened over a blend, because a third of a map
    // is a lot to finish on a line.
    noData: { below: 12, mode: 'cap', tone: PLUTO_CAP, seam: 0.10 },
  },
  miranda: {
    src: 'Uranus_Miranda_nasa3d.tif',
    outputs: [{ width: 2048, out: 'miranda.webp' }],
    // The Uranian moons are as close to colourless as major moons come.
    colour: gains([0.995, 0.995, 1.0], [1.0, 1.0, 1.0]),
    noData: { below: 12, mode: 'texture', seam: 0.16 },
  },
  ariel: {
    src: 'Uranus_Ariel_nasa3d.tif',
    outputs: [{ width: 2048, out: 'ariel.webp' }],
    colour: gains([0.995, 0.995, 1.0], [1.0, 1.0, 1.0]),
    noData: { below: 12, mode: 'texture', seam: 0.16 },
  },
  // --- the five re-bases ----------------------------------------------------
  // Each ships its boot map and its rung cut from ONE source in ONE run, so
  // the step up the ladder is a pure sharpen — which is the whole reason these
  // four bodies re-base rather than gaining a rung over the map they have.
  io: {
    src: 'Io_GalileoSSI-Voyager_Global_Mosaic_ClrMerge_1km.tif',
    outputs: [{ width: 4096, out: 'io.v2.webp' }],
    rungs: [{ width: 8192, name: 'io-8k' }],
  },
  europa: {
    src: 'Europa_Voyager_GalileoSSI_global_mosaic_500m.tif',
    outputs: [{ width: 4096, out: 'europa.v2.webp' }],
    rungs: [{ width: 8192, name: 'europa-8k' }],
    // The sharpest Galilean source is the 500 m MONO mosaic, and USGS
    // publishes no global colour Europa raster, so the colour is a ramp over
    // what Europa's brightness actually tracks: the bright plains are clean
    // water ice reading blue-white, and the dark lineae and mottled terrain
    // are where the non-ice contaminant sits and read tan-brown. Rather than
    // the flatter, redder ball the old boot map drew.
    // Levels are set against the real geometric albedos of the four
    // Galileans (Io 0.63, Europa 0.68, Ganymede 0.43, Callisto 0.22), so the
    // moons finally read at the right brightnesses relative to each other:
    // this map's mean luminance lands at 1.6x Ganymede's colour mosaic, which
    // is the ratio the albedos ask for.
    colour: ramp([
      [0.00, [44, 36, 30]], [0.30, [100, 84, 68]], [0.48, [158, 142, 124]],
      [0.60, [198, 190, 178]], [0.72, [226, 224, 222]], [0.85, [242, 244, 246]],
      [1.00, [252, 253, 255]],
    ]),
  },
  ganymede: {
    src: 'Ganymede_Voyager_GalileoSSI_Global_ClrMosaic_1435m.tif',
    outputs: [{ width: 4096, out: 'ganymede.v2.webp' }],
    rungs: [{ width: 8192, name: 'ganymede-8k' }],
  },
  callisto: {
    src: 'Callisto_Voyager_GalileoSSI_global_mosaic_1km.tif',
    // 1800 is the width Callisto boots at today; the rung above it is
    // therefore a 2.28x sharpen rather than the 2x the rest of the set holds
    // to, and both files come out of this one run.
    outputs: [{ width: 4096, out: '4k/callisto.v2.webp' }, { width: 1800, out: 'callisto.v2.webp' }],
    rungs: [{ width: 8192, name: 'callisto-8k' }],
    // Mono at 1 km, and no global colour Callisto raster exists either. The
    // dark cratered plains are the dirty, ice-poor ones and the bright crater
    // ejecta and palimpsests are excavated ice, so the same brightness-tracks-
    // composition ramp applies, warmer and dimmer than Europa's.
    colour: ramp([
      [0.00, [30, 24, 20]], [0.22, [78, 64, 52]], [0.45, [126, 110, 94]],
      [0.68, [172, 160, 146]], [0.86, [208, 200, 190]], [1.00, [238, 234, 228]],
    ]),
  },
  pluto: {
    src: 'Pluto_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif',
    outputs: [{ width: 4096, out: '4k/pluto.v2.webp' }, { width: 2048, out: 'pluto.v2.webp' }],
    rungs: [{ width: 8192, name: 'pluto-8k' }],
    colour: PLUTO_RAMP,
    // The south was in polar night for the whole encounter. Ramping its
    // near-black would paint a colour onto pixels that hold no measurement, so
    // it stays the neutral dark cap the shipped map has always had, with the
    // hard edge it has always had: this map re-bases to the same picture, and
    // softening the cap here would make that untrue.
    noData: { below: 14, mode: 'cap', tone: PLUTO_CAP, seam: 0 },
  },
};

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

const manifest = JSON.parse(await readFile(new URL('./gen-moonmaps.sources.json', import.meta.url), 'utf8'));

const fileDigest = (file) => new Promise((res, rej) => {
  const h = createHash('sha256');
  createReadStream(file).on('data', (c) => h.update(c)).on('end', () => res(h.digest('hex'))).on('error', rej);
});

/** The digest the shipped maps were cut from. A product re-downloaded after
 *  an upstream change would otherwise re-cut a map silently, and six months on
 *  nobody could say which bytes a moon came from. Streamed: these run to
 *  310 MB and a readFile of the set would be gigabytes of resident buffer. */
async function checkedSource(name) {
  const entry = manifest[name];
  if (!entry) throw new Error(`${name} is not in gen-moonmaps.sources.json`);
  const file = path.join(CACHE, name);
  const size = (await stat(file)).size;
  if (size !== entry.bytes) {
    throw new Error(`${name}: ${size} bytes, not the manifest's ${entry.bytes} — a different source; update gen-moonmaps.sources.json together with the assets cut from it`);
  }
  const digest = await fileDigest(file);
  if (digest !== entry.sha256) {
    throw new Error(`${name}: sha256 ${digest} is not the manifest's ${entry.sha256} — a different source; update gen-moonmaps.sources.json together with the assets cut from it`);
  }
  return { file, entry };
}

// ---------------------------------------------------------------------------
// The resample
// ---------------------------------------------------------------------------

/**
 * The source's pixels, cropped to exactly one wrap and to the poles.
 *
 * Several of these mosaics are a hair wider or taller than the sphere they
 * cover — Enceladus spans 360.025 degrees, Charon 360.03 and a tenth of a
 * degree past the north pole — because their line/sample counts were rounded
 * up. Resizing that to a 2:1 equirect stretches every longitude by the excess;
 * cropping it first costs a fraction of a source pixel and keeps the
 * registration the gazetteer checks are made against.
 */
async function sourceRaster(file, entry, noDataBelow) {
  const { width, height } = await sharp(file, { limitInputPixels: false }).metadata();
  const raster = entry.raster ?? {};
  const spanLon = raster.spanDegLon ?? 360;
  const spanLat = raster.spanDegLat ?? 180;
  const topLat = raster.topLatDeg ?? 90;
  const pxPerDegX = width / spanLon;
  const pxPerDegY = height / spanLat;
  const top = Math.max(0, Math.round((topLat - 90) * pxPerDegY));
  const w = Math.min(width, Math.round(360 * pxPerDegX));
  const h = Math.min(height - top, Math.round(180 * pxPerDegY));
  // Keep a single-band source single-band: sharp's default output colourspace
  // is sRGB, and letting it expand a 23040x11520 mono mosaic to three
  // channels triples both this buffer and the padded copy of it for pixels
  // that are all the same number anyway.
  const mono = (await sharp(file, { limitInputPixels: false }).metadata()).channels === 1;
  let pipeline = sharp(file, { limitInputPixels: false })
    .extract({ left: 0, top, width: w, height: h })
    .removeAlpha();
  if (mono) pipeline = pipeline.toColourspace('b-w');
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  if (top || w !== width || h !== height) {
    console.log(`  cropped ${width}x${height} -> ${w}x${h} (span ${spanLon.toFixed(4)} deg, top lat ${topLat.toFixed(4)})`);
  }
  // The no-data mask rides along as alpha from here on — see splitAlpha.
  const n = info.width * info.height;
  const ch = info.channels + 1;
  const withAlpha = Buffer.allocUnsafe(n * ch);
  let bad = 0;
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let c = 0; c < info.channels; c++) {
      const s = data[i * info.channels + c];
      withAlpha[i * ch + c] = s;
      v += s;
    }
    const empty = v / info.channels < noDataBelow;
    withAlpha[i * ch + info.channels] = empty ? 0 : 255;
    if (empty) bad++;
  }
  console.log(`  source ${info.width}x${info.height}x${info.channels}, ${((100 * bad) / n).toFixed(2)}% no data`);
  return { data: withAlpha, width: info.width, height: info.height, channels: ch };
}

/**
 * Resample to `width` x width/2 with the map's own opposite edge carried
 * through the reduction as a halo, then roll so the source's left-edge
 * longitude lands where the renderer samples it.
 *
 * The roll is done at the OUTPUT size: at half a turn — which is every roll in
 * this set — it is exact, and the fractional part of any other roll is under
 * half an output pixel. Doing it before the reduction would need the whole
 * source rolled in memory for nothing.
 */
async function resampleToTarget(src, width, leftEdgeLonDegEast) {
  const height = width / 2;
  const haloSrc = Math.max(1, Math.round((SEAM_HALO * src.width) / width));
  const ch = src.channels;
  const padW = src.width + 2 * haloSrc;
  const padded = Buffer.allocUnsafe(padW * src.height * ch);
  for (let y = 0; y < src.height; y++) {
    const from = y * src.width * ch;
    const to = y * padW * ch;
    // left halo = the map's right edge, right halo = its left edge
    src.data.copy(padded, to, from + (src.width - haloSrc) * ch, from + src.width * ch);
    src.data.copy(padded, to + haloSrc * ch, from, from + src.width * ch);
    src.data.copy(padded, to + (haloSrc + src.width) * ch, from, from + haloSrc * ch);
  }
  const { data, info } = await sharp(padded, { raw: { width: padW, height: src.height, channels: ch }, limitInputPixels: false })
    .resize(width + 2 * SEAM_HALO, height, { fit: 'fill', kernel: 'lanczos3' })
    .extract({ left: SEAM_HALO, top: 0, width, height })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // u_target = u_source + 0.5 + leftEdgeLon/360, so the shift is what it takes
  // to put the left edge's longitude back at 180E.
  const shift = Math.round(width * ((((0.5 + leftEdgeLonDegEast / 360) % 1) + 1) % 1)) % width;
  if (shift === 0) return { data, width, height, channels: info.channels };
  const rolled = Buffer.allocUnsafe(data.length);
  const cut = (width - shift) * info.channels;
  const row = width * info.channels;
  for (let y = 0; y < height; y++) {
    data.copy(rolled, y * row, y * row + cut, (y + 1) * row);
    data.copy(rolled, y * row + shift * info.channels, y * row, y * row + cut);
  }
  return { data: rolled, width, height, channels: info.channels };
}

// ---------------------------------------------------------------------------
// Colour and fill
// ---------------------------------------------------------------------------

/** Apply a body's colour pass, turning a 1-channel raster into 3. A source
 *  that is already colour keeps its own pixels: the only bodies with a real
 *  colour mosaic are Io and Ganymede, and nothing here improves on them. */
function colourise(ras, job) {
  if (ras.channels === 3 && !job.colour) return ras;
  if (!job.colour) throw new Error('a mono source needs a colour pass');
  const n = ras.width * ras.height;
  const out = Buffer.allocUnsafe(n * 3);
  const lut = new Uint8Array(256 * 3);
  for (let v = 0; v < 256; v++) {
    const c = job.colour(v / 255);
    for (let k = 0; k < 3; k++) {
      const x = Math.round(c[k]);
      lut[v * 3 + k] = x < 0 ? 0 : x > 255 ? 255 : x;
    }
  }
  const stride = ras.channels;
  for (let i = 0; i < n; i++) {
    // A 3-band greyscale source (the two NASA 3D textures) is read off its
    // first band; a real colour source never reaches here.
    const v = ras.data[i * stride];
    out[i * 3] = lut[v * 3];
    out[i * 3 + 1] = lut[v * 3 + 1];
    out[i * 3 + 2] = lut[v * 3 + 2];
  }
  return { data: out, width: ras.width, height: ras.height, channels: 3 };
}

/** Charon's polar stain: a warm gain that fades in with latitude and only
 *  touches pixels the mosaic already shows as dark, so it reddens Mordor
 *  Macula and leaves the bright polar ice beside it alone. */
function polarTint(ras, spec) {
  const { fromLat, gain, darkerThan } = spec;
  for (let y = 0; y < ras.height; y++) {
    const lat = 90 - (180 * (y + 0.5)) / ras.height;
    const t = Math.max(0, Math.min(1, (lat - fromLat) / (90 - fromLat)));
    if (t <= 0) continue;
    const w = t * t * (3 - 2 * t);
    for (let x = 0; x < ras.width; x++) {
      const i = (y * ras.width + x) * 3;
      const L = (ras.data[i] + ras.data[i + 1] + ras.data[i + 2]) / (3 * 255);
      const dark = Math.max(0, Math.min(1, (darkerThan - L) / darkerThan));
      const k = w * dark;
      if (k <= 0) continue;
      for (let c = 0; c < 3; c++) {
        const v = ras.data[i + c] * (1 + (gain[c] - 1) * k);
        ras.data[i + c] = v > 255 ? 255 : Math.round(v);
      }
    }
  }
  return ras;
}

/**
 * Split the resampled raster's alpha off as the no-data mask.
 *
 * Every mosaic in this set marks an unmeasured pixel the same way — exactly
 * zero — and every one of them has some: a few tenths of a percent of Cassini
 * seam, four percent of polar gap on the Galileans, a third of Charon and
 * Pluto (their souths were in polar night for the whole New Horizons
 * encounter), and three fifths of Miranda and Ariel (Voyager 2 flew the
 * Uranian system pole-on and imaged one hemisphere).
 *
 * The mask is carried through the reduction AS an alpha channel rather than
 * re-measured after it, because a reduction mixes the black into the two or
 * three real pixels beside every data edge. Re-measuring cannot separate
 * those from real dark terrain, and a threshold loose enough to catch them
 * eats a tenth of the map; what an alpha channel does instead is divide them
 * back out — libvips premultiplies through a resize, so a half-covered pixel
 * comes back as the average of the half that HAS data, at full brightness.
 * Without it every data edge ships a thin dark line, which is the one
 * artefact the fill exists to prevent.
 */
function splitAlpha(ras) {
  const { width: W, height: H } = ras;
  const n = W * H;
  const colour = ras.channels - 1;
  const mask = new Uint8Array(n);
  const out = Buffer.allocUnsafe(n * colour);
  let bad = 0;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < colour; c++) out[i * colour + c] = ras.data[i * ras.channels + c];
    // Half coverage or less is a pixel the fill should own; anything more has
    // been divided back out to a real value.
    if (ras.data[i * ras.channels + colour] < 128) { mask[i] = 1; bad++; }
  }
  return { ras: { data: out, width: W, height: H, channels: colour }, mask, fraction: bad / n };
}

/** Two octaves of seeded value noise, so a filled region carries grain
 *  instead of a flat wash — and the same grain every bake, because a moon
 *  must not change face between sessions. */
function valueNoise(W) {
  // A murmur3 finalizer, not a one-step multiply: a hash whose consecutive
  // cells step by a constant leaves its high bits in step too, and the noise
  // built on it comes out as a visible checkerboard at the cell size rather
  // than as grain (it did, once).
  const hash = (x, y, s) => {
    let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(s, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
  };
  const at = (x, y, cell, s) => {
    const gx = Math.floor(x / cell);
    const gy = Math.floor(y / cell);
    const fx = x / cell - gx;
    const fy = y / cell - gy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const gw = Math.max(1, Math.ceil(W / cell));
    const wrap = (g) => ((g % gw) + gw) % gw;
    const a = hash(wrap(gx), gy, s);
    const b = hash(wrap(gx + 1), gy, s);
    const c = hash(wrap(gx), gy + 1, s);
    const d = hash(wrap(gx + 1), gy + 1, s);
    const top = a + (b - a) * sx;
    return top + (c + (d - c) * sx - top) * sy;
  };
  return (x, y) => (at(x, y, Math.max(2, W / 256), 1) - 0.5) * 1.1 + (at(x, y, Math.max(2, W / 64), 2) - 0.5) * 0.7;
}

/**
 * Put something honest where the source has nothing.
 *
 * Both modes start the same way: an unmeasured pixel takes the map's own
 * pixels REFLECTED across the nearest data edge in its column, blurred harder
 * the further it sits from that edge. What they differ in is where that fade
 * ends up.
 *
 *  - `texture` carries the imaged hemisphere's statistics into the unimaged
 *    one: its mean, a third of its low-frequency shape, and grain matched to
 *    its own variation. Miranda and Ariel ship this way, because half a moon
 *    of flat tone is not a moon and the alternative — a hard black edge
 *    across a lit disc — reads as a bug rather than as missing data. It
 *    asserts no feature: everything past the blend is soft.
 *  - `cap` fades to one neutral dark tone, which is what a region that was in
 *    polar night should look like and what the shipped Pluto map has always
 *    done (tools/_plutobake.mjs). Charon takes the same treatment as its
 *    twin, with the edge softened over a blend rather than cut hard, since a
 *    third of the map is a big thing to end on a line.
 *
 * Pluto's own cap keeps its original hard edge (seam 0) so its re-base stays
 * the pure sharpen the rest of this pipeline promises.
 */
async function fillNoData(ras, mask, spec) {
  const { width: W, height: H } = ras;
  const seam = Math.max(0, Math.round(H * (spec.seam ?? 0)));
  const noise = valueNoise(W);

  // Nearest valid row per pixel, by column: one scan down and one up.
  const up = new Int32Array(W * H);
  const down = new Int32Array(W * H);
  for (let x = 0; x < W; x++) {
    let last = -1;
    for (let y = 0; y < H; y++) { if (!mask[y * W + x]) last = y; up[y * W + x] = last; }
    last = -1;
    for (let y = H - 1; y >= 0; y--) { if (!mask[y * W + x]) last = y; down[y * W + x] = last; }
  }

  // Statistics of what WAS measured, for the tone a texture fill settles on.
  let sum = 0;
  let sq = 0;
  let n = 0;
  for (let i = 0; i < W * H; i++) {
    if (mask[i]) continue;
    const v = (ras.data[i * 3] + ras.data[i * 3 + 1] + ras.data[i * 3 + 2]) / 3;
    sum += v; sq += v * v; n++;
  }
  const mean = n ? sum / n : 128;
  const std = n ? Math.sqrt(Math.max(0, sq / n - mean * mean)) : 8;

  // Pass one: the reflection, sharp. Done before the blur so no black bleeds
  // out of the hole and into the data around it.
  const dist = new Int32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!mask[i]) continue;
      const u = up[i];
      const d = down[i];
      const edge = u < 0 ? d : d < 0 ? u : (y - u <= d - y ? u : d);
      if (edge < 0) { dist[i] = H; continue; } // a column with no data at all
      dist[i] = Math.abs(y - edge);
      let src = 2 * edge - y;
      if (src < 0 || src >= H || mask[src * W + x]) src = edge;
      for (let c = 0; c < 3; c++) ras.data[i * 3 + c] = ras.data[(src * W + x) * 3 + c];
    }
  }

  // Pass two: fade the reflection out. Nothing to fade for a hard cap.
  const blurRadius = Math.max(2, Math.round(W / 128));
  const { data: soft } = seam > 0
    ? await sharp(ras.data, { raw: { width: W, height: H, channels: 3 } })
      .blur(blurRadius).raw().toBuffer({ resolveWithObject: true })
    : { data: ras.data };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!mask[i]) continue;
      const t = seam > 0 ? Math.min(1, dist[i] / seam) : 1;
      const w = t * t * (3 - 2 * t);
      const grain = noise(x, y) * std;
      for (let c = 0; c < 3; c++) {
        const sharpV = ras.data[i * 3 + c];
        const softV = soft[i * 3 + c];
        const far = spec.mode === 'cap'
          ? spec.tone[c]
          // A third of the map's own spread, not all of it: the whole-map
          // deviation is mostly large-scale albedo, and grain at that
          // amplitude is a sandstorm rather than a surface.
          : mean + (softV - mean) * 0.35 + grain * 0.35;
        const v = sharpV * (1 - w) + (softV * (1 - w) + far * w) * w;
        ras.data[i * 3 + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
      }
    }
  }
  return { mean, std };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

async function writeMap(ras, out) {
  await mkdir(path.dirname(out), { recursive: true });
  await sharp(ras.data, { raw: { width: ras.width, height: ras.height, channels: 3 } })
    .webp(PHOTO_WEBP)
    .toFile(out);
  const size = (await stat(out)).size;
  console.log(`  ${path.relative(TEX, out).padEnd(24)} ${ras.width}x${ras.height} ${(size / 1024).toFixed(0).padStart(6)} KB`);
}

async function writeRung(ras, name) {
  await mkdir(RUNGS, { recursive: true });
  const out = path.join(RUNGS, `${name}.png`);
  await sharp(ras.data, { raw: { width: ras.width, height: ras.height, channels: 3 } })
    .png({ compressionLevel: 1 })
    .toFile(out);
  const size = (await stat(out)).size;
  console.log(`  ${path.relative(CACHE, out).padEnd(24)} ${ras.width}x${ras.height} ${(size / 1e6).toFixed(1)} MB (for gen-ktx2)`);
}

async function runJob(name) {
  const job = JOBS[name];
  const t0 = Date.now();
  console.log(`== ${name}`);
  const { file, entry } = await checkedSource(job.src);
  const left = entry.longitude?.leftEdgeLonDegEast;
  if (typeof left !== 'number') {
    throw new Error(`${job.src}: gen-moonmaps.sources.json has no longitude.leftEdgeLonDegEast — the layout is UNKNOWN and a map cut from it would be a guess`);
  }
  if (entry.longitude.eastLonIncreasesRightward !== true) {
    throw new Error(`${job.src}: the manifest says east does not increase rightward; every source in this set does, and a mirrored one needs a flip this pipeline deliberately has no path for`);
  }
  // Every mosaic here has SOME no-data, if only a few Cassini seam pixels,
  // and a black pixel on a lit globe reads as a hole. The default policy
  // reflects the neighbouring surface across the gap, which for a seam or a
  // polar sliver is invisible; the bodies with a hemisphere missing say so.
  const nd = job.noData ?? { below: 12, mode: 'texture', seam: 0.03 };
  const src = await sourceRaster(file, entry, nd.below);
  console.log(`  left edge ${left} E`);
  const targets = [...(job.outputs ?? []).map((o) => ({ ...o, kind: 'map' })),
    ...(job.rungs ?? []).map((r) => ({ ...r, kind: 'rung' }))];
  if (!flag('no-rungs')) targets.sort((a, b) => b.width - a.width);
  for (const target of targets) {
    if (target.kind === 'rung' && flag('no-rungs')) continue;
    const resampled = await resampleToTarget(src, target.width, left);
    const { ras: bare, mask, fraction } = splitAlpha(resampled);
    let ras = colourise(bare, job);
    if (fraction > 0) {
      const { mean, std } = await fillNoData(ras, mask, nd);
      console.log(`  ${(100 * fraction).toFixed(2)}% no data -> ${nd.mode} fill (measured mean ${mean.toFixed(1)} std ${std.toFixed(1)}, seam ${(100 * (nd.seam ?? 0)).toFixed(0)}% of height)`);
    }
    if (job.polarTint) ras = polarTint(ras, job.polarTint);
    if (target.kind === 'map') await writeMap(ras, path.join(TEX, target.out));
    else await writeRung(ras, target.name);
  }
  console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

const wanted = flag('all') ? Object.keys(JOBS) : args.filter((a) => !a.startsWith('--'));
if (flag('verify')) {
  const names = wanted.length ? wanted.map((n) => JOBS[n]?.src ?? n) : Object.keys(manifest).filter((k) => !k.startsWith('_'));
  for (const name of names) {
    await checkedSource(name);
    console.log(`  ok ${name}`);
  }
} else if (wanted.length === 0) {
  console.error(`usage: node tools/gen-moonmaps.mjs <job...> | --all | --verify  [--cache=dir] [--no-rungs]\njobs: ${Object.keys(JOBS).join(', ')}`);
  process.exit(2);
} else {
  for (const name of wanted) {
    if (!JOBS[name]) {
      console.error(`unknown job ${name}; known: ${Object.keys(JOBS).join(', ')}`);
      process.exit(2);
    }
  }
  for (const name of wanted) await runJob(name);
}
