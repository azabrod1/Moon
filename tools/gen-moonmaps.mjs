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
// carries. There is no hard data edge on the drawn body, and the fill carries
// the imaged hemisphere's own grain at the imaged hemisphere's own amplitude,
// measured octave by octave, so a close look finds surface rather than smoke.
//
// Three of these products carry marks that are not surface, and each gets a
// pass of its own rather than a hand-painted patch:
//
//   * A mosaic's coverage boundary is antialiased: the column where imaged
//     terrain meets no-data holds a partial-coverage pixel a long way darker
//     than either. Left alone it survives the resample as a dotted near-black
//     curve tracing the edge of the data — the single most artificial thing on
//     Miranda and on Ariel. It is not a measurement, so the no-data mask is
//     GROWN by a pixel or two before the reduction (`noData.edgeGrow`) and the
//     rim is filled with the surface instead. The same rule takes the dark
//     wedges the Uranian mosaics carry along their terminator, where the
//     Voyager frames run out of light: a pixel counts as unmeasured when it is
//     dark AND its neighbourhood is dark (`noData.darkPatch`), which is a
//     region test, so a genuinely black crater floor inside bright terrain
//     keeps its measurement.
//   * Where a mosaic changes resolution it can change it on a straight line of
//     longitude, and a straight line is the one thing a real surface never
//     draws. `seamFeather` blends a narrow band across that longitude: both
//     sides keep their own pixels, the razor between them goes.
//   * Where a mosaic is assembled from frames at different phase it carries a
//     brightness offset per frame, with the frame's own polygon boundary as a
//     hard step. `destripe` splits the picture into hemispheric albedo, the
//     frame-sized band the offsets live in, and detail, then softens and halves
//     only the middle one. The real large-scale albedo and every bit of detail
//     come through untouched. That instrument needs a body whose real features
//     are either much wider than a frame or much finer, which Titan is and the
//     Galileans are not: on Callisto, whose features run from half a degree to
//     thirty, it leaves 36 per cent of the variation between 1.2 and 8 degrees
//     standing and still leaves most of the step. So the three Galilean
//     mosaics do not use it, and the steps they carry — 45, 34 and 20 counts
//     on Callisto's worst three, on a map whose mean is 58 — are still there.
//     tools/surfaceGrain.mjs can measure them (`findEdges`); closing them
//     without leaving a mark of its own is unfinished work.
//   * Where a mosaic changes RESOLUTION it leaves rectangles of smeared ground
//     against crisp cratered ground, and from close up those read as pieces of
//     different pictures stitched together. `coverageFill` measures how much
//     detail each part of the map is short of and gives the short parts grain
//     at the amplitude the sharp parts measure, which is what the Galileans
//     take. It lives in tools/surfaceGrain.mjs with the blur, the noise and
//     the per-octave amplitude it is built on.
//
// LEVELS. A map is an sRGB-encoded albedo texture, so its mean in LINEAR light
// is proportional to the body's albedo, and every graded map here is put on one
// line: linear mean = ALBEDO_LEVEL_SCALE x the published geometric albedo. The
// scale is fitted to the products nobody has graded — the USGS colour mosaics
// for Io, Ganymede and Callisto — and it is what stops a batch of separately
// normalised grey mosaics from rendering every icy moon at the same middling
// grey. Enceladus reflects nearly everything that hits it and Callisto reflects
// almost nothing, and after this pass their maps say so.
//
// Prereq (not a package.json dependency — this runs once per asset drop):
//   npm i --no-save sharp@0.35.4
// Usage:
//   node tools/gen-moonmaps.mjs <job...>     # one or more bodies
//   node tools/gen-moonmaps.mjs --all
//   node tools/gen-moonmaps.mjs --verify     # re-check source digests only
//   --cache=<dir>  .moon-data-cache root (sources live in <dir>/zoom)
//   --no-rungs     skip the KTX2 intermediates (the slow part)
// HEAP. The source-resolution passes hold several hundred megabytes per field
// at once — a 66 megapixel mosaic is 265 MB for one Float32Array and the detail
// deficit has nine of them live — and V8 grows its old space by running full
// collections rather than by asking for the memory up front. Measured on
// Ganymede's source: the first detail deficit takes 924 seconds on a heap that
// has to grow into it and 24 on one that is already big enough, for the same
// answer to three decimals. So this is run with the size asked for at startup
// (see the gen:moonmaps script), and a run started by hand without those flags
// will look hung when it is only collecting.
import sharp from 'sharp';
import {
  NOISE_AMP_PER_SIGMA, bandAmplitudes, blurMono, coverageFill, detailDeficit, findEdges, levelEdges,
  valueNoise,
} from './surfaceGrain.mjs';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/** Rec. 709 luminance weights — the same mix the renderer's own tone stage
 *  weights these channels by, so "how bright is this map" means one thing
 *  through the whole pipeline. */
const REC709 = [0.2126, 0.7152, 0.0722];

/**
 * A ramp with its levels taken back out: the hue at every stop is kept and the
 * brightness is forced back to the source's, so the pass tilts colour and
 * nothing else.
 *
 * A ramp that both colours and levels a map is two decisions in one table, and
 * when the levels are owned by the albedo curve below it is the wrong two: a
 * ramp's slope through the midtones is a contrast decision made by eye, and on
 * a body with a real albedo dichotomy it is also the width of that dichotomy.
 * Under this wrapper the source's own spread survives exactly and the level
 * stage moves the whole thing at once.
 */
const chromaOf = (stops) => {
  const base = ramp(stops);
  return (L) => {
    const c = base(L);
    const lum = REC709[0] * c[0] + REC709[1] * c[1] + REC709[2] * c[2];
    const k = lum > 1 ? (L * 255) / lum : 1;
    return [c[0] * k, c[1] * k, c[2] * k];
  };
};

const srgbEncode = (u) => (u <= 0.0031308 ? 12.92 * u : 1.055 * Math.pow(u, 1 / 2.4) - 0.055);
const srgbDecode = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

/**
 * Linear map mean per unit of published geometric albedo — the one number the
 * whole batch's levels come off.
 *
 * Fitted (geometric mean, since the relation is multiplicative) to the three
 * products in this set that carry no grade of anyone's: the USGS mosaics for
 * Io, Ganymede and Callisto, whose cos-latitude-weighted means come to 0.393,
 * 0.382 and 0.353 of their published albedos in linear light. Three
 * independently assembled mosaics of three different moons agreeing inside
 * five per cent is what says the relation is real and that these products can
 * be read as photometry rather than as pictures. Residuals against the fit:
 * +4.7% Io, +1.7% Ganymede, -6.1% Callisto.
 *
 * The factor itself is not physics: it is the renderer's exposure headroom,
 * the room a map has to leave so a lit disc at full sun does not sit on the
 * clip.
 */
const ALBEDO_LEVEL_SCALE = 0.3753;

/** The 0..255 mean an albedo asks a map for. */
const albedoLevel = (albedo) => 255 * srgbEncode(ALBEDO_LEVEL_SCALE * albedo);

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
 * name); `outputs` are the shipped maps; `rungs` are the widths written to the
 * cache as PNG for gen-ktx2 to encode.
 *
 * Every tier ABOVE a body's boot map is a rung, never an output, because every
 * one of them ships GPU-compressed and alone: an ETC1S container of one of
 * these maps is about the size of its webp twin on the wire and a quarter of it
 * in VRAM, so a webp of the same tier beside it would be pure weight in the
 * deploy — and the assets tests refuse one, since a rung that declares no
 * classic map must not have one on disk. The container's pixels therefore come
 * from the PNG written here rather than from a shipped file, which keeps the
 * rung a pure sharpen of the boot map under it: both come out of one resample
 * of one source in one run.
 *
 * Widths are not free choices. A body's BOOT width is whatever the app
 * already fetches for it — re-basing a map is a change of product, not of the
 * ladder's arithmetic, so callisto stays 1800 and io/europa/ganymede stay 4096
 * exactly as they ship today. The new bodies boot at 2048 like every other
 * moon. A rung is written only where the source can actually fill it: Titan's
 * mosaic is 4040 px and Miranda's and Ariel's are 1440, so those three are
 * boot-only and the rest of their detail is the procedural blend's job.
 */
const JOBS = {
  // --- the eight that ship as noise balls today -----------------------------
  titan: {
    src: 'Titan_ISS_P19658_Mosaic_Global_4km.tif',
    outputs: [{ width: 2048, out: 'titan.webp' }],
    // Cassini ISS 938 nm methane-window mosaic: what it records is surface
    // brightness through the haze, and the haze is what the renderer draws
    // over it anyway (atmosphereModel treats Titan as a haze ball).
    //
    // Titan is the one body here whose level and hue do NOT come off the
    // albedo curve, and it is not close: the 0.2 in the tables is the disc of
    // orange smog, not this ground, and a neutral map under that haze turns
    // the one moon everybody can name from across the solar system into a pale
    // tan ball. So the surface is graded to the tint the app already draws
    // Titan in — moonData's catalog colour, 0xc89040, which is where the haze
    // ball got its orange — with the dune fields holding the most of it and
    // the bright uplands the least, because that is the direction Titan's own
    // colour runs. What survives the haze is a faint darker equatorial
    // structure on an orange globe, which is Titan from space.
    colour: gains([1.0, 0.66, 0.24], [1.0, 0.78, 0.42]),
    level: { mean: 105, why: 'holds the disc where the haze ball drew it' },
    // The ISS mosaic is stitched from frames taken at different phase, and
    // each frame carries its own brightness offset with its own polygon
    // outline as a hard step — flat-toned tiles, visible straight across the
    // sub-Saturn face. The band those offsets live in is a few degrees wide;
    // Xanadu and Shangri-La are far wider and every dune is far finer, so both
    // come through.
    destripe: { fineDeg: 0.9, coarseDeg: 9, midGain: 0.35 },
  },
  enceladus: {
    src: 'Enceladus_Cassini_mosaic_global_110m.tif',
    outputs: [{ width: 2048, out: 'enceladus.webp' }],
    rungs: [{ width: 4096, name: 'enceladus-4k' }],
    // The most reflective surface in the solar system and as close to neutral
    // as anything gets: the gain is a whisper of blue in the shadows and
    // nothing at all in the highlights.
    colour: gains([0.98, 0.99, 1.0], [1.0, 1.0, 1.0]),
    level: { albedo: 1.04 },
  },
  mimas: {
    src: 'PIA17214_Mimas_global_map_2017.tif',
    outputs: [{ width: 2048, out: 'mimas.webp' }],
    rungs: [{ width: 4096, name: 'mimas-4k' }],
    colour: gains([0.99, 0.975, 0.95], [1.0, 0.995, 0.985]),
    level: { albedo: 0.6 },
  },
  dione: {
    src: 'Dione_Cassini_Voyager_mosaic_global_154m.tif',
    outputs: [{ width: 2048, out: 'dione.webp' }],
    rungs: [{ width: 4096, name: 'dione-4k' }],
    colour: gains([0.99, 0.975, 0.95], [1.0, 0.995, 0.985]),
    level: { albedo: 0.6 },
  },
  tethys: {
    src: 'Tethys_Cassini_mosaic_global_293m.tif',
    outputs: [{ width: 2048, out: 'tethys.webp' }],
    rungs: [{ width: 4096, name: 'tethys-4k' }],
    colour: gains([0.99, 0.98, 0.96], [1.0, 0.997, 0.99]),
    level: { albedo: 0.8 },
  },
  rhea: {
    src: 'Rhea_Cassini_Voyager_mosaic_global_417m.tif',
    outputs: [{ width: 2048, out: 'rhea.webp' }],
    rungs: [{ width: 4096, name: 'rhea-4k' }],
    colour: gains([0.99, 0.975, 0.95], [1.0, 0.995, 0.985]),
    level: { albedo: 0.6 },
    // Cassini's coverage of Rhea ends on a meridian, and west of 82.7E the
    // mosaic falls back to Voyager at a quarter of the detail. Both sides are
    // real and both stay; what goes is the straight line between them, which
    // no surface has and every eye finds.
    seamFeather: [{ lonDegEast: 82.7, sampleDeg: 0.8, smoothDeg: 2.5, rampDeg: 8 }],
  },
  iapetus: {
    src: 'Iapetus_Cassini_Voyager_mosaic_global_783m.tif',
    outputs: [{ width: 2048, out: 'iapetus.webp' }],
    rungs: [{ width: 4096, name: 'iapetus-4k' }],
    // The one Saturnian whose colour is the point: Cassini Regio is dark
    // red-brown and the trailing ice is very slightly yellow, so the two tones
    // want different chroma and a ramp is the honest way to give it to them.
    // Chroma only: the two-tone's own spread is the biggest albedo contrast on
    // any solar-system surface and it belongs to the source, not to a stop
    // table. The level stage then moves both tones together, which is a gain,
    // which leaves their ratio exactly where the mosaic put it.
    colour: chromaOf([
      [0.00, [26, 18, 13]], [0.16, [58, 41, 30]], [0.34, [104, 84, 68]],
      [0.55, [162, 152, 140]], [0.78, [214, 210, 200]], [1.00, [250, 249, 244]],
    ]),
    // The tables quote 0.6 for Iapetus, and that is the bright trailing side
    // alone; the leading side is 0.05, the darkest large surface anyone has
    // measured. One number for the whole globe is the mean of the two, and it
    // is what the map's mean is keyed to. The dichotomy itself is untouched.
    level: { albedo: 0.325 },
  },
  charon: {
    src: 'Charon_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif',
    outputs: [{ width: 2048, out: 'charon.webp' }],
    rungs: [{ width: 4096, name: 'charon-4k' }],
    // Neutral grey almost everywhere; the exception is Mordor Macula, the
    // red-brown tholin stain over the north pole, which New Horizons' colour
    // imaging showed and this map's luminance already holds as a dark cap. The
    // polar term reddens only what is BOTH high-latitude and dark, so nothing
    // at the equator picks up a tint from it.
    colour: gains([0.99, 0.985, 0.98], [1.0, 1.0, 1.0]),
    level: { albedo: 0.42 },
    polarTint: { fromLat: 50, gain: [1.30, 1.02, 0.86], darkerThan: 0.62 },
    // A third of this mosaic is polar night, all of it south of about 37S.
    // Pluto's shipped map ends the same way and for the same reason, so its
    // twin ends there too — softened over a blend, because a third of a map
    // is a lot to finish on a line.
    noData: { below: 12, mode: 'cap', tone: PLUTO_CAP, seam: 0.10 },
  },
  // Voyager 2 flew the Uranian system pole-on in one pass, so both of these
  // are one hemisphere of real terrain, a terminator the frames ran out of
  // light along, and nothing at all north of it. `darkPatch` gives the dead
  // terminator wedges to the fill instead of drawing them as black holes on a
  // lit globe, `edgeGrow` takes the antialiased rim of every coverage boundary
  // with them (that rim is the dotted curve these two used to wear), and the
  // fill matches the imaged half's own texture energy rather than fading to a
  // smudge.
  miranda: {
    src: 'Uranus_Miranda_nasa3d.tif',
    outputs: [{ width: 2048, out: 'miranda.webp' }],
    // Both NASA 3D textures were saved with a one-pixel dark frame: the last
    // column reads 109 against its neighbour's 138, the last row 100 against
    // 118. That column is a meridian on the globe.
    borderPx: 1,
    // The Uranian moons are as close to colourless as major moons come.
    colour: gains([0.995, 0.995, 1.0], [1.0, 1.0, 1.0]),
    level: { albedo: 0.27 },
    // These two are textures assembled as rectangles, and their two ends do
    // not agree: Miranda's is 22 counts adrift across its own wrap and
    // Ariel's 28, against a neighbouring-column difference of 3 and 1. On a
    // globe that wrap is a meridian, and a step there draws a hairline from
    // pole to pole — the anti-Uranus one, which is exactly where the app's
    // own arrival poses look.
    seamFeather: [{ lonDegEast: 180, sampleDeg: 1.5, smoothDeg: 6, rampDeg: 14 }],
    noData: {
      below: 12, mode: 'texture', seam: 0.16, edgeGrow: 2,
      darkPatch: { below: 46, radiusDeg: 1.1, regionBelow: 40 },
      matchTexture: true,
    },
  },
  ariel: {
    src: 'Uranus_Ariel_nasa3d.tif',
    outputs: [{ width: 2048, out: 'ariel.webp' }],
    borderPx: 1,
    colour: gains([0.995, 0.995, 1.0], [1.0, 1.0, 1.0]),
    level: { albedo: 0.34 },
    seamFeather: [{ lonDegEast: 180, sampleDeg: 1.5, smoothDeg: 6, rampDeg: 14 }],
    noData: {
      below: 12, mode: 'texture', seam: 0.16, edgeGrow: 2,
      darkPatch: { below: 46, radiusDeg: 1.1, regionBelow: 40 },
      matchTexture: true,
    },
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
    //
    // Chroma only, with the level left to the albedo curve. The first cut of
    // this ramp set Europa's levels by hand, reading 0.67 against Ganymede's
    // 0.43 as a ratio of MAP means and landing this map at 1.6x Ganymede's —
    // but a map is sRGB encoded, and 1.6x there is 3.0x in the linear light
    // those albedos are a ratio of. That is what made Europa the brightest
    // thing in the batch by a distance, ahead of Enceladus, which reflects
    // half again as much light as Europa does.
    colour: chromaOf([
      [0.00, [44, 36, 30]], [0.30, [100, 84, 68]], [0.48, [158, 142, 124]],
      [0.60, [198, 190, 178]], [0.72, [226, 224, 222]], [0.85, [242, 244, 246]],
      [1.00, [252, 253, 255]],
    ]),
    level: { albedo: 0.67 },
    // The coarse ground here is flat panels rather than smeared craters, and
    // it is a sixth of the sharp ground's detail before the fill. What the
    // fill puts back is grain, not lineae: this moon's real fine structure is
    // the ridges, and drawing those would be drawing terrain nobody imaged.
    coverageFill: { fineDeg: 0.12, coarseDeg: 1, windowDeg: 1.5, wideDeg: 2 },
    // Each frame carries its own calibration offset, with the frame's polygon
    // as a hard step; closed with the harmonic correction field (see
    // levelEdges, and the Callisto job for the measured sizes).
    levelEdges: {
      lookDeg: 0.5, alongDeg: 1, minStep: 3, minSpanDeg: 5, smoothDeg: 0.4, skipLatDeg: 80, rounds: 3,
      // These frames are outlines, not rows and columns: on Europa the worst of
      // them wanders seven degrees of latitude across fifty of longitude and
      // changes the sign of its own step four times along the way. Followed
      // from where the finest band's energy steps, at the same band the fill
      // measures its deficit in.
      curves: { fineDeg: 0.12 },
    },
    // The polar hole gets the matched fill (see the Callisto job and fillNoData).
    noData: { below: 12, mode: 'texture', seam: 0.03, matchTexture: true },
  },
  ganymede: {
    src: 'Ganymede_Voyager_GalileoSSI_Global_ClrMosaic_1435m.tif',
    outputs: [{ width: 4096, out: 'ganymede.v2.webp' }],
    rungs: [{ width: 8192, name: 'ganymede-8k' }],
    // Same patchwork as Callisto's, and the same answer. This is the one
    // colour source the fill runs on: it measures brightness and adds
    // brightness, equally on all three channels, so the mosaic's chroma comes
    // through exactly as the mission left it.
    coverageFill: { fineDeg: 0.12, coarseDeg: 1, windowDeg: 1.5, wideDeg: 2 },
    // Each frame carries its own calibration offset, with the frame's polygon
    // as a hard step; closed with the harmonic correction field (see
    // levelEdges, and the Callisto job for the measured sizes).
    levelEdges: {
      lookDeg: 0.5, alongDeg: 1, minStep: 3, minSpanDeg: 5, smoothDeg: 0.4, skipLatDeg: 80, rounds: 3,
      // These frames are outlines, not rows and columns: on Europa the worst of
      // them wanders seven degrees of latitude across fifty of longitude and
      // changes the sign of its own step four times along the way. Followed
      // from where the finest band's energy steps, at the same band the fill
      // measures its deficit in.
      curves: { fineDeg: 0.12 },
    },
    // The polar hole gets the matched fill (see the Callisto job and fillNoData).
    noData: { below: 12, mode: 'texture', seam: 0.03, matchTexture: true },
  },
  callisto: {
    src: 'Callisto_Voyager_GalileoSSI_global_mosaic_1km.tif',
    // 1800 is the width Callisto boots at today; the rung above it is
    // therefore a 2.28x sharpen rather than the 2x the rest of the set holds
    // to, and both files come out of this one run.
    outputs: [{ width: 1800, out: 'callisto.v2.webp' }],
    rungs: [{ width: 8192, name: 'callisto-8k' }, { width: 4096, name: 'callisto-4k' }],
    // Mono at 1 km, and no global colour Callisto raster exists either — no
    // agency has ever even published a name for its colour. What is published
    // is the slope: most of the surface is red-sloped from 700 to 1000 nm,
    // while the bright water-ice-rich regions are neutral or BLUE-sloped
    // (Denman et al. 2025, HST/STIS). So this ramp runs warm grey-brown in the
    // dark cratered plains and turns slightly COOL in the fresh ejecta and
    // palimpsests, which is the one thing about this moon's colour that is
    // actually measured. Chroma only: the stop table's first cut ran at slope
    // 0.79 through the midtones, which is exactly where Callisto's craters
    // live, and a moon whose whole surface is craters cannot afford to hand a
    // fifth of their contrast to a colour table.
    colour: chromaOf([
      [0.00, [30, 24, 20]], [0.22, [78, 64, 52]], [0.45, [126, 112, 98]],
      [0.68, [170, 162, 154]], [0.86, [206, 204, 204]], [1.00, [234, 236, 240]],
    ]),
    // The one body in this table whose level is not what its albedo asks for.
    // On the curve Callisto's 0.17 lands at 0.63 of Ganymede's map mean, and
    // down there the crater shadows that ARE this moon sit on the floor before
    // the renderer has done anything with them. Held at 0.75 of Ganymede
    // instead — still comfortably the darkest Galilean, so the ordering the
    // curve exists to protect is intact, and an exception stated rather than
    // an exception hidden in a stop table.
    level: { mean: 84.5, why: 'crater shadows survive the floor' },
    // And the punch back on top, at the scale a disc-filling Callisto draws
    // its craters at.
    localContrast: { radiusDeg: 1.2, gain: 0.45 },
    // The mosaic is Galileo strips at a few hundred metres a pixel laid over
    // Voyager fill at ten times that, and the Voyager ground reaches this map
    // with a tenth of the detail beside it. Measured on the source's own
    // pixels, before the reduction, so the rungs above the boot map get it
    // too: this fills 70 per cent of the source and takes the coarse ground's
    // detail from a fifth of the sharp ground's to a half.
    coverageFill: { fineDeg: 0.12, coarseDeg: 1, windowDeg: 1.5, wideDeg: 2 },
    // The frames these mosaics are built from carry a calibration offset each,
    // with the frame's own polygon boundary as a hard step: 41, 33 and 20
    // counts on Callisto's worst three, on a map whose mean is 58. Closed with
    // a harmonic correction field, which is the only kind that can close them
    // without leaving a mark where it stops (see levelEdges).
    levelEdges: {
      lookDeg: 0.5, alongDeg: 1, minStep: 3, minSpanDeg: 5, smoothDeg: 0.4, skipLatDeg: 80, rounds: 3,
      // These frames are outlines, not rows and columns: on Europa the worst of
      // them wanders seven degrees of latitude across fifty of longitude and
      // changes the sign of its own step four times along the way. Followed
      // from where the finest band's energy steps, at the same band the fill
      // measures its deficit in.
      curves: { fineDeg: 0.12 },
    },
    // The polar hole is a straight-sided polygon and the fill that goes in it
    // is what a player at close range reads as a rectangle, so it gets the
    // matched treatment: the mirror line smoothed along longitude instead of
    // per column, and grain at the octaves the imaged ground measures rather
    // than one guessed amplitude.
    noData: { below: 12, mode: 'texture', seam: 0.03, matchTexture: true },
  },
  pluto: {
    src: 'Pluto_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif',
    outputs: [{ width: 2048, out: 'pluto.v2.webp' }],
    rungs: [{ width: 8192, name: 'pluto-8k' }, { width: 4096, name: 'pluto-4k' }],
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
// Pixel plumbing
// ---------------------------------------------------------------------------

/** Grow a 0/1 mask by `r` pixels, wrapping in x. */
function dilateMask(mask, W, H, r) {
  if (r <= 0) return mask;
  const tmp = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (let d = -r; d <= r && !v; d++) v = mask[y * W + (((x + d) % W) + W) % W];
      tmp[y * W + x] = v;
    }
  }
  const out = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      let v = 0;
      for (let d = -r; d <= r && !v; d++) v = tmp[Math.min(H - 1, Math.max(0, y + d)) * W + x];
      out[y * W + x] = v;
    }
  }
  return out;
}

/**
 * Take the frame-to-frame brightness offsets out of a mosaic without taking
 * the body's albedo out with them.
 *
 * Three scales: what is broader than `coarseDeg` is the real hemispheric
 * albedo and passes through whole; what is finer than `fineDeg` is detail and
 * passes through whole; the band between is where a stitched frame's offset
 * lives, and it is both halved and blurred again, which turns each frame's
 * hard polygon edge into a gradient a couple of degrees wide. Operates on one
 * channel in place.
 */
export function destripe(band, W, H, spec, pxPerDeg) {
  const fine = blurMono(band, W, H, spec.fineDeg * pxPerDeg);
  const coarse = blurMono(band, W, H, spec.coarseDeg * pxPerDeg);
  const mid = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) mid[i] = fine[i] - coarse[i];
  const midSoft = blurMono(mid, W, H, spec.fineDeg * pxPerDeg * 2);
  for (let i = 0; i < W * H; i++) {
    const v = coarse[i] + midSoft[i] * spec.midGain + (band[i] - fine[i]);
    band[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
}

/**
 * Take a mosaic's seam off its straight line.
 *
 * What makes a mosaic boundary visible is not the resolution behind it — the
 * eye forgives a coarser patch — it is the brightness STEP where two products
 * calibrated differently meet, and this one is nine counts across a meridian
 * that runs pole to pole. Blurring a band across it is the wrong instrument
 * twice over: it leaves the step and adds a strip softer than the terrain on
 * either side of it, which reads as a drawn stripe.
 *
 * What works is additive and takes nothing away. Measure the step per row,
 * smooth that profile so it follows the calibration rather than the terrain,
 * then spread half of it into each side with a weight that decays to nothing a
 * few degrees out. Every pixel keeps its own detail; the two sides simply
 * arrive at the meridian agreeing about how bright this moon is.
 */
function featherSeam(band, W, H, spec, leftEdgeLonDegEast, mask) {
  // The raster's own column for that longitude: east increases rightward from
  // the manifest's left edge, so this is the same arithmetic the roll uses.
  // At the map's own left edge that comes out as column zero, and the wrap
  // makes the windows either side of it the map's two ends — which is where a
  // texture assembled as a rectangle rather than as a globe can carry a step
  // nobody saw, because nobody looks at the two ends of a picture together.
  const u = (((spec.lonDegEast - leftEdgeLonDegEast) / 360) % 1 + 1) % 1;
  const cx = Math.round(u * W);
  const pxPerDeg = W / 360;
  const sample = Math.max(2, Math.round(spec.sampleDeg * pxPerDeg));
  const ramp = Math.max(2, Math.round(spec.rampDeg * pxPerDeg));
  const wrap = (x) => ((x % W) + W) % W;
  const at = (x, y) => band[y * W + wrap(x)];
  const valid = (x, y) => !mask || !mask[y * W + wrap(x)];

  const step = new Float32Array(H);
  const has = new Uint8Array(H);
  for (let y = 0; y < H; y++) {
    let l = 0;
    let r = 0;
    let n = 0;
    for (let d = 1; d <= sample; d++) {
      if (!valid(cx - d, y) || !valid(cx + d - 1, y)) continue;
      l += at(cx - d, y); r += at(cx + d - 1, y); n++;
    }
    // A row with nothing measured on one side has no step to measure, and it
    // does not get to vote as a zero — on a half-imaged moon most rows are
    // that row, and their zeros would wash the real measurement out.
    if (n) { step[y] = (r - l) / n; has[y] = 1; }
  }
  // Smoothed down the meridian, over the rows that measured: one row's
  // difference is mostly whatever crater happens to sit there, and a
  // correction that follows craters puts them back as a ghost on the far side.
  const smoothRows = Math.max(1, Math.round(spec.smoothDeg * pxPerDeg));
  const soft = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    let s = 0;
    let n = 0;
    for (let d = -smoothRows; d <= smoothRows; d++) {
      const yy = y + d;
      if (yy < 0 || yy >= H || !has[yy]) continue;
      s += step[yy]; n++;
    }
    soft[y] = n ? s / n : 0;
  }
  // And bounded by what the seam typically is. A row where a big crater sits
  // against the meridian measures a step several times the calibration's, and
  // half of that pushed into the terrain either side would be a new artefact
  // in place of the old one.
  const sorted = [];
  for (let y = 0; y < H; y++) if (has[y]) sorted.push(Math.abs(soft[y]));
  sorted.sort((a, b) => a - b);
  const typical = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const cap = Math.max(1, 3 * typical);
  let peak = 0;
  for (let y = 0; y < H; y++) {
    soft[y] = Math.max(-cap, Math.min(cap, soft[y]));
    peak = Math.max(peak, Math.abs(soft[y]));
  }

  for (let d = 0; d <= ramp; d++) {
    const t = 1 - d / ramp;
    const w = 0.5 * t * t * (3 - 2 * t);
    if (w <= 0) continue;
    const xl = (((cx - 1 - d) % W) + W) % W;
    const xr = (cx + d) % W;
    for (let y = 0; y < H; y++) {
      const half = soft[y] * w;
      const il = y * W + xl;
      const ir = y * W + xr;
      band[il] = Math.min(255, Math.max(0, band[il] + half));
      band[ir] = Math.min(255, Math.max(0, band[ir] - half));
    }
  }
  return { column: cx, peak };
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
async function sourceRaster(file, entry, nd, job, leftEdgeLonDegEast) {
  const noDataBelow = nd.below;
  const { width, height } = await sharp(file, { limitInputPixels: false }).metadata();
  const raster = entry.raster ?? {};
  const spanLon = raster.spanDegLon ?? 360;
  const spanLat = raster.spanDegLat ?? 180;
  const topLat = raster.topLatDeg ?? 90;
  const pxPerDegX = width / spanLon;
  const pxPerDegY = height / spanLat;
  const top = Math.max(0, Math.round((topLat - 90) * pxPerDegY));
  // Even, always: the seam pass in resampleToTarget needs a source width that
  // shares a factor with the output width, and an odd one (Europa's mosaic is
  // 19631 columns) shares none with a power of two. One column of a mosaic
  // this wide is under a fiftieth of a degree, which is a tenth of an output
  // pixel and far inside the registration the gazetteer checks are made to.
  const w = Math.min(width, Math.round(360 * pxPerDegX)) & ~1;
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
  const n = info.width * info.height;
  const W = info.width;
  const H = info.height;
  const sc = info.channels;
  const pxPerDeg = W / 360;

  if (job.borderPx) {
    // Some products carry the frame they were saved in: the outermost ring of
    // pixels is a dark line that belongs to the file rather than to the body.
    // On a globe the right-hand one of those is a meridian, and it draws a
    // hairline from pole to pole. The repair is the neighbours' own values —
    // read across the wrap in longitude, where the map's two ends really are
    // adjacent, and from the row below at the poles, where they are not.
    const b = job.borderPx;
    for (let c = 0; c < sc; c++) {
      const at = (x, y) => data[(y * W + x) * sc + c];
      for (let y = 0; y < H; y++) {
        for (let k = 0; k < b; k++) {
          const l = at(b, y);
          const r = at(W - 1 - b, y);
          const f = (k + 1) / (b + 1);
          data[(y * W + (b - 1 - k)) * sc + c] = Math.round(l * (1 - f) + r * f);
          data[(y * W + (W - b + k)) * sc + c] = Math.round(r * (1 - f) + l * f);
        }
      }
      for (let x = 0; x < W; x++) {
        for (let k = 0; k < b; k++) {
          data[((b - 1 - k) * W + x) * sc + c] = at(x, b);
          data[((H - b + k) * W + x) * sc + c] = at(x, H - 1 - b);
        }
      }
    }
    console.log(`  repaired the outermost ${b} px of the file's own frame`);
  }

  // Mean of the source's channels, which is what every judgement below is
  // made on: the two colour mosaics that reach here have no repairs asked of
  // them, and every mosaic that does is single-band.
  const grey = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let c = 0; c < sc; c++) v += data[i * sc + c];
    grey[i] = v / sc;
  }

  // --- what is not a measurement -------------------------------------------
  const mask = new Uint8Array(n);
  let bad = 0;
  for (let i = 0; i < n; i++) if (grey[i] < noDataBelow) { mask[i] = 1; bad++; }
  const hard = bad;
  if (nd.darkPatch) {
    // A dark REGION is dead data; a dark pixel inside bright terrain is a
    // crater floor and belongs to the map. Blurring the picture and asking
    // whether the neighbourhood is dark too is what separates them.
    const dp = nd.darkPatch;
    const around = blurMono(grey, W, H, dp.radiusDeg * pxPerDeg);
    for (let i = 0; i < n; i++) {
      if (!mask[i] && grey[i] < dp.below && around[i] < dp.regionBelow) { mask[i] = 1; bad++; }
    }
  }
  let grown = mask;
  if (nd.edgeGrow) {
    // The boundary column between terrain and nothing is a partial-coverage
    // pixel: darker than either side, and a whole map's worth of them draws a
    // dotted curve round the edge of the data. It is not surface, so it goes
    // to the fill with the hole it belongs to.
    grown = dilateMask(mask, W, H, nd.edgeGrow);
    for (let i = 0; i < n; i++) if (grown[i] && !mask[i]) bad++;
  }
  console.log(`  source ${W}x${H}x${sc}, ${((100 * hard) / n).toFixed(2)}% empty`
    + `${bad !== hard ? ` -> ${((100 * bad) / n).toFixed(2)}% unmeasured after the dark-region and boundary rules` : ''}`);

  // --- repairs that belong at source resolution ----------------------------
  if (job.destripe || job.seamFeather || job.levelEdges || job.coverageFill) {
    // Every repair here works on the picture's BRIGHTNESS and writes its
    // answer back as a change of brightness on each channel, which leaves a
    // colour mosaic's chroma exactly where the mission left it. That is the
    // right shape for all of them: a frame's calibration offset, a seam's
    // step and a coarse patch's missing grain are all differences in how much
    // light a pixel says it reflects.
    let grey3 = sc === 3;
    for (let i = 0; grey3 && i < n; i += 997) {
      if (data[i * 3] !== data[i * 3 + 1] || data[i * 3] !== data[i * 3 + 2]) grey3 = false;
    }
    // These two are told which longitude to work on and are only ever set on
    // a mono product; the pair below find their own work and run on anything.
    if ((job.destripe || job.seamFeather) && sc !== 1 && !grey3) {
      throw new Error('destripe and seamFeather read one band; this source is colour');
    }
    const valid = new Uint8Array(n);
    for (let i = 0; i < n; i++) valid[i] = grown[i] ? 0 : 1;
    if (job.destripe) {
      destripe(grey, W, H, job.destripe, pxPerDeg);
      console.log(`  destriped: frame offsets between ${job.destripe.fineDeg} and ${job.destripe.coarseDeg} deg at ${job.destripe.midGain}x`);
    }
    for (const seam of job.seamFeather ?? []) {
      const { column, peak } = featherSeam(grey, W, H, seam, leftEdgeLonDegEast, grown);
      console.log(`  levelled the ${seam.lonDegEast} E seam (source column ${column}, step up to ${peak.toFixed(1)} counts, spread over ${seam.rampDeg} deg either side)`);
    }
    if (job.levelEdges) {
      // A boundary that is not a row or a column is followed rather than
      // scanned for, and what it is followed on is where the finest band's
      // energy steps. The deficit that goes with it is measured here rather
      // than borrowed from the fill: the fill measures its own after this pass
      // has changed the band, and one field cannot honestly be both.
      const seed = job.levelEdges.curves && job.coverageFill
        ? detailDeficit(grey, W, H, job.coverageFill, pxPerDeg, valid).deficit
        : null;
      const { edges: before } = findEdges(grey, W, H, job.levelEdges, pxPerDeg, valid);
      const { edges: fixed, perRound, capped, curves } = levelEdges(grey, W, H, job.levelEdges, pxPerDeg, valid, seed);
      const { edges: after } = findEdges(grey, W, H, job.levelEdges, pxPerDeg, valid, before.slice(0, 3));
      const say = (e) => (e.axis === 'meridian'
        ? `${((e.at / pxPerDeg) % 360).toFixed(0)}E`
        : `lat ${(90 - (e.at * 180) / H).toFixed(0)}`);
      // Per round, and whether the ceiling truncated any of them: a run that
      // corrects exactly the ceiling in every round has left boundaries
      // standing and cannot tell you so from the total alone.
      console.log(`  levelled ${fixed.length} straight brightness steps (${perRound.join(' + ')}`
        + `${capped ? ', TRUNCATED at the ceiling' : ''}); the worst three `
        + before.slice(0, 3).map((e, k) => `${say(e)} ${e.step.toFixed(1)} -> ${after[k].step.toFixed(1)}`).join(', ')
        + ' counts');
      if (curves.length) {
        const worst = curves.slice().sort((a, b) => b.firstMedianStep * b.spanDeg - a.firstMedianStep * a.spanDeg);
        console.log(`  traced ${curves.length} curved boundaries over `
          + `${curves.reduce((t, c) => t + c.spanDeg, 0).toFixed(0)} degrees of ground; the worst three `
          + worst.slice(0, 3).map((c) => `${c.spanDeg.toFixed(0)}deg ${c.firstMedianStep.toFixed(1)} -> ${c.medianStep.toFixed(1)}`).join(', ')
          + ' counts');
      }
    }
    if (job.coverageFill) {
      const fill = coverageFill(grey, W, H, job.coverageFill, pxPerDeg, valid);
      for (let i = 0; i < n; i++) grey[i] += fill.delta[i];
      console.log(`  coverage fill over ${(100 * fill.touchedFraction).toFixed(0)}% of the source`
        + ` (reference ground ${(100 * fill.refFraction).toFixed(0)}%, fine-band ratio ${fill.ref.toFixed(2)},`
        + ` energy ${fill.energyRef.toFixed(1)}):`
        + ` ${fill.octaves.map((o) => `${o.cell.toFixed(0)}px +-${(o.amp / 2).toFixed(1)}`).join(', ')}`
        + `, peak ${fill.peakDelta.toFixed(1)} counts, mean ${fill.meanDelta.toFixed(3)}`);
    }
    for (let i = 0; i < n; i++) {
      let was = 0;
      for (let c = 0; c < sc; c++) was += data[i * sc + c];
      const d = grey[i] - was / sc;
      if (!d) continue;
      for (let c = 0; c < sc; c++) {
        const v = data[i * sc + c] + d;
        data[i * sc + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
      }
    }
  }

  // The no-data mask rides along as alpha from here on — see splitAlpha.
  const ch = sc + 1;
  const withAlpha = Buffer.allocUnsafe(n * ch);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < sc; c++) withAlpha[i * ch + c] = data[i * sc + c];
    withAlpha[i * ch + sc] = grown[i] ? 0 : 255;
  }
  return { data: withAlpha, width: info.width, height: info.height, channels: ch };
}

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/** One raster rolled `by` columns to the right, wrapping. Integer columns
 *  only, so it is a copy and nothing is resampled. */
function rollRaster(src, by) {
  const ch = src.channels;
  const row = src.width * ch;
  const cut = ((by % src.width) + src.width) % src.width;
  if (cut === 0) return src;
  const out = Buffer.allocUnsafe(src.data.length);
  for (let y = 0; y < src.height; y++) {
    src.data.copy(out, y * row + cut * ch, y * row, y * row + (src.width - cut) * ch);
    src.data.copy(out, y * row, y * row + (src.width - cut) * ch, (y + 1) * row);
  }
  return { data: out, width: src.width, height: src.height, channels: ch };
}

/**
 * Resample to `width` x width/2, wrap-exact, then roll so the source's
 * left-edge longitude lands where the renderer samples it.
 *
 * A globe's map has no edges, and a resize does. Padding the source with a
 * halo of its own opposite edge is the obvious answer and it is half an answer:
 * the halo has to be a whole number of SOURCE pixels, so the crop that takes it
 * off again lands on a fraction of an OUTPUT pixel, and the map comes back with
 * one column repeated across its seam. On a body whose map is upsampled that is
 * a full texel of stall along a meridian, and it draws a hairline from pole to
 * pole — on a tidally locked moon, straight down the middle of the hemisphere
 * that faces away from its planet, which is exactly where an arrival looks.
 *
 * So the seam is resampled a second time from a rolled copy instead. The roll
 * is chosen as a whole number of source columns that is ALSO a whole number of
 * output columns (a multiple of srcWidth/gcd(srcWidth, width)), which makes the
 * second pass the same picture to the pixel, only with its own edges somewhere
 * else. The band around the seam is then taken from it. Nothing is
 * interpolated twice and nothing lands on a fraction of a pixel.
 */
async function resampleToTarget(src, width, leftEdgeLonDegEast) {
  const height = width / 2;
  const plain = async (raster) => {
    const r = await sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: raster.channels }, limitInputPixels: false })
      .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return r;
  };
  const { data, info } = await plain(src);
  const ch = info.channels;

  const step = src.width / gcd(src.width, width);
  const rollSrc = step * Math.max(1, Math.round(src.width / 4 / step));
  const rollOut = (rollSrc * width) / src.width;
  if (!Number.isInteger(rollOut) || rollOut <= 0 || rollOut >= width) {
    throw new Error(`no exact seam roll for ${src.width} -> ${width}: a source width sharing a factor with the output is what makes the second pass land on whole pixels (sourceRaster crops to an even width for exactly this)`);
  }
  const { data: other } = await plain(rollRaster(src, rollSrc));
  // `other` is this picture shifted right by rollOut output columns, so its
  // column (x + rollOut) holds what this map's column x should hold — with the
  // resize's own edge error a quarter of a turn away from here.
  const band = Math.max(4, Math.round(width / 128));
  const row = width * ch;
  for (let y = 0; y < height; y++) {
    for (let d = -band; d < band; d++) {
      const x = ((d % width) + width) % width;
      const sx = (x + rollOut) % width;
      other.copy(data, y * row + x * ch, y * row + sx * ch, y * row + (sx + 1) * ch);
    }
  }

  // u_target = u_source + 0.5 + leftEdgeLon/360, so the shift is what it takes
  // to put the left edge's longitude back at 180E.
  const shift = Math.round(width * ((((0.5 + leftEdgeLonDegEast / 360) % 1) + 1) % 1)) % width;
  if (shift === 0) return { data, width, height, channels: info.channels };
  const rolled = Buffer.allocUnsafe(data.length);
  const cut = (width - shift) * info.channels;
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

/**
 * Put the map's level where the body's albedo says it goes.
 *
 * One neutral gain on all three channels, so every ratio in the picture — the
 * two halves of Iapetus, the fracture beside the plain, the crater against its
 * floor — comes through exactly as the mosaic recorded it, and only the whole
 * thing moves. Above a knee the gain bends into a shoulder that approaches
 * white without ever reaching it, because the alternative on a body like
 * Enceladus, whose map has to come up by two thirds, is a flat white south
 * pole where the tiger stripes were.
 *
 * The gain is solved against the pixels the SOURCE actually measured, weighted
 * by cos(latitude). Two reasons, and both matter: on a half-imaged moon the
 * fill has not run yet and would otherwise vote with whatever the reflection
 * produced, and an equirect map gives a row at the pole as many pixels as a
 * row at the equator for a two-hundredth of the surface — an unweighted mean
 * of one is a measurement of its polar cap.
 */
function applyLevel(ras, mask, spec, forceGain) {
  const KNEE = 0.80;
  const shoulder = (x) => (x <= KNEE ? x : KNEE + (1 - KNEE) * (1 - Math.exp(-(x - KNEE) / (1 - KNEE))));
  const { width: W, height: H } = ras;
  const n = W * H;
  const hist = [new Float64Array(256), new Float64Array(256), new Float64Array(256)];
  let valid = 0;
  for (let y = 0; y < H; y++) {
    const cw = Math.cos(((90 - (180 * (y + 0.5)) / H) * Math.PI) / 180);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (mask && mask[i]) continue;
      valid += cw;
      for (let c = 0; c < 3; c++) hist[c][ras.data[i * 3 + c]] += cw;
    }
  }
  if (!valid) return null;
  const meanAt = (a) => {
    let sum = 0;
    for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let v = 0; v < 256; v++) if (hist[c][v]) s += hist[c][v] * shoulder((v / 255) * a) * 255;
      sum += REC709[c] * (s / valid);
    }
    return sum;
  };
  const before = meanAt(1);
  const target = spec.mean ?? albedoLevel(spec.albedo);
  let a = forceGain;
  if (a === undefined) {
    let lo = 0.05;
    let hi = 12;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (meanAt(mid) < target) lo = mid; else hi = mid;
    }
    a = (lo + hi) / 2;
  }
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    const x = Math.round(shoulder((v / 255) * a) * 255);
    lut[v] = x < 0 ? 0 : x > 255 ? 255 : x;
  }
  for (let i = 0; i < n * 3; i++) ras.data[i] = lut[ras.data[i]];
  return { before, after: meanAt(a), target, gain: a, shouldered: a > 1 ? Math.round((KNEE / a) * 255) : 255 };
}

/**
 * Unsharp at one stated scale: the picture plus a fraction of what a blur of
 * it throws away. Used where a body's whole surface is one size of feature and
 * the mosaic's own contrast does not carry it.
 */
function localContrast(ras, spec) {
  const { width: W, height: H } = ras;
  const n = W * H;
  const r = (spec.radiusDeg / 360) * W;
  for (let c = 0; c < 3; c++) {
    const band = new Float32Array(n);
    for (let i = 0; i < n; i++) band[i] = ras.data[i * 3 + c];
    const soft = blurMono(band, W, H, r);
    for (let i = 0; i < n; i++) {
      const v = band[i] + (band[i] - soft[i]) * spec.gain;
      ras.data[i * 3 + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    }
  }
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

/**
 * How much variation the imaged part of a map carries, octave by octave, as
 * the amplitudes `matched` wants — see bandAmplitudes for what is measured and
 * why it is a median.
 *
 * The holes hold whatever the reflection put there, and blurring that in would
 * make the measurement one of the fill, so they are flattened to the imaged
 * mean before the blurs and excluded from every sum.
 */
function textureOctaves(ras, mask, W, H, cells) {
  const n = W * H;
  const band = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    band[i] = (ras.data[i * 3] + ras.data[i * 3 + 1] + ras.data[i * 3 + 2]) / 3;
  }
  let sum = 0;
  let valid = 0;
  for (let i = 0; i < n; i++) if (!mask[i]) { sum += band[i]; valid++; }
  const mean = valid ? sum / valid : 128;
  for (let i = 0; i < n; i++) if (mask[i]) band[i] = mean;
  return bandAmplitudes(band, W, H, cells, [(i) => !mask[i]])[0];
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
 *    With `matchTexture` the grain is not one guessed amplitude but three
 *    octaves at the amplitudes the imaged half measures at those scales, and
 *    the reflection reads from a SMOOTHED data edge rather than each column's
 *    own. That second part matters more than it sounds: the coverage boundary
 *    on a Voyager flyby mosaic jumps tens of rows between neighbouring
 *    columns, and a per-column reflection of it combs the fill into vertical
 *    streaks — which is what the first cut of these two moons wore.
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

  // The row the reflection mirrors about, smoothed along longitude where a
  // body asks for it. Each column still reflects across its OWN data edge —
  // that is what keeps the picture continuous at the boundary — but the
  // mirror line is the running mean of the edge over a few degrees, so
  // neighbouring columns pull from neighbouring rows and the fill comes out
  // as surface rather than as combing.
  //
  // One line per pole, because a hole is wherever the spacecraft did not fly.
  // Miranda and Ariel are missing their northern halves and Callisto's hole is
  // over its south pole; a smoothed line built only for the top leaves a
  // southern hole reflecting each column across its own edge, which is the
  // combing this exists to stop.
  const smoothAlong = (v) => {
    const out = new Float32Array(W);
    const span = Math.max(1, Math.round(W / 48));
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let d = -span; d <= span; d++) s += v[(((x + d) % W) + W) % W];
      out[x] = s / (2 * span + 1);
    }
    return out;
  };
  let mirrorTop = null;
  let mirrorBottom = null;
  if (spec.matchTexture) {
    const first = new Float32Array(W);
    const last = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      let y = 0;
      while (y < H && mask[y * W + x]) y++;
      first[x] = y < H ? y : H / 2;
      let z = H - 1;
      while (z >= 0 && mask[z * W + x]) z--;
      last[x] = z >= 0 ? z : H / 2;
    }
    mirrorTop = smoothAlong(first);
    mirrorBottom = smoothAlong(last);
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
      const about = mirrorTop ? (y < H / 2 ? mirrorTop[x] : mirrorBottom[x]) : edge;
      let src = Math.round(2 * about - y);
      if (src < 0 || src >= H || mask[src * W + x]) src = 2 * edge - y;
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
  // The imaged half's own variation, per scale, and the grain built to match
  // it. Measured after the reflection so the octave blurs read a continuous
  // picture, and over the imaged pixels only so what they measure is surface.
  // The ladder reaches down to a few pixels. The first cut of this started at
  // a fiftieth of the map's width, which on an 8K rung is a cell two degrees
  // across: fine for half a moon seen from orbit, and nothing at all for a
  // hole in the ground a player is standing off by two diameters, where every
  // scale below a degree is what the eye is reading.
  const octaves = spec.matchTexture
    ? textureOctaves(ras, mask, W, H, [
      Math.max(3, W / 2048), Math.max(6, W / 512), Math.max(16, W / 128), Math.max(48, W / 32),
    ])
    : null;
  const grainAt = octaves ? noise.matched(octaves) : (x, y) => noise.plain(x, y) * std;
  // What the far field takes its SHAPE from. The reflection at the blur the
  // seam mixes with still carries the terminator strip's vertical spikes, and
  // a moon's unimaged half combed into vertical bands is what a smudge looks
  // like; at this radius only the broad tone survives, and the texture beside
  // it comes from the matched grain instead.
  let broad = null;
  if (spec.matchTexture) {
    broad = [];
    for (let c = 0; c < 3; c++) {
      const band = new Float32Array(W * H);
      for (let i = 0; i < W * H; i++) band[i] = ras.data[i * 3 + c];
      broad.push(blurMono(band, W, H, W / 24));
    }
  }
  // How much of that shape survives into the far field. The matched fill keeps
  // more, because the grain beside it is now at the right amplitude and a
  // little more shape reads as terrain rather than as a stain.
  const keepShape = spec.matchTexture ? 0.55 : 0.35;
  // Two thirds of the variation the imaged half measures, which is where the
  // half-imaged moons were cut and where they stay: at the full amplitude the
  // fill reads as a rougher surface than the one it continues from.
  const grainGain = spec.matchTexture ? 3.0 / NOISE_AMP_PER_SIGMA : 0.35;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!mask[i]) continue;
      const t = seam > 0 ? Math.min(1, dist[i] / seam) : 1;
      const w = t * t * (3 - 2 * t);
      const grain = grainAt(x, y);
      for (let c = 0; c < 3; c++) {
        const sharpV = ras.data[i * 3 + c];
        const softV = soft[i * 3 + c];
        const shapeV = broad ? broad[c][i] : softV;
        const far = spec.mode === 'cap'
          ? spec.tone[c]
          // Not all of the map's spread: the whole-map deviation is mostly
          // large-scale albedo, and grain at that amplitude is a sandstorm
          // rather than a surface.
          : mean + (shapeV - mean) * keepShape + grain * grainGain;
        const v = sharpV * (1 - w) + (softV * (1 - w) + far * w) * w;
        ras.data[i * 3 + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
      }
    }
  }
  return { mean, std, octaves };
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
  const src = await sourceRaster(file, entry, nd, job, left);
  console.log(`  left edge ${left} E`);
  const targets = [...(job.outputs ?? []).map((o) => ({ ...o, kind: 'map' })),
    ...(job.rungs ?? []).map((r) => ({ ...r, kind: 'rung' }))];
  if (!flag('no-rungs')) targets.sort((a, b) => b.width - a.width);
  // Solved once and reused: a rung is a sharpen of the boot below it, and two
  // gains solved separately on two resamples of one picture would leave them a
  // fraction of a count apart for no reason.
  let levelGain;
  for (const target of targets) {
    if (target.kind === 'rung' && flag('no-rungs')) continue;
    const resampled = await resampleToTarget(src, target.width, left);
    const { ras: bare, mask, fraction } = splitAlpha(resampled);
    let ras = colourise(bare, job);
    // Before the level, not after: an unsharp overshoots on a bright rim, and
    // the level's shoulder is the thing in this pipeline that catches an
    // overshoot without cutting it off.
    if (job.localContrast) localContrast(ras, job.localContrast);
    if (job.level) {
      const lv = applyLevel(ras, mask, job.level, levelGain);
      levelGain = lv.gain;
      const asked = job.level.mean !== undefined
        ? `${job.level.mean} (${job.level.why})`
        : `${lv.target.toFixed(1)} from albedo ${job.level.albedo}`;
      console.log(`  level ${lv.before.toFixed(1)} -> ${lv.after.toFixed(1)}, asked ${asked}`
        + `; gain ${lv.gain.toFixed(3)}, shoulder from ${lv.shouldered}`);
    }
    if (fraction > 0) {
      const { mean, std, octaves } = await fillNoData(ras, mask, nd);
      console.log(`  ${(100 * fraction).toFixed(2)}% no data -> ${nd.mode} fill (measured mean ${mean.toFixed(1)} std ${std.toFixed(1)}, seam ${(100 * (nd.seam ?? 0)).toFixed(0)}% of height)`);
      if (octaves) {
        console.log(`  matched grain: ${octaves.map((o) => `${o.cell.toFixed(0)}px +-${(o.amp / 2).toFixed(1)}`).join(', ')}`);
      }
    }
    if (job.polarTint) ras = polarTint(ras, job.polarTint);
    if (target.kind === 'map') await writeMap(ras, path.join(TEX, target.out));
    else await writeRung(ras, target.name);
  }
  console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

// Run only when this file is the program. Imported — by a measurement harness
// or by a test — it is a library of passes and must not start a bake.
const main = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
const wanted = !main ? [] : flag('all') ? Object.keys(JOBS) : args.filter((a) => !a.startsWith('--'));
if (!main) {
  // nothing to do
} else if (flag('verify')) {
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
