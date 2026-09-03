// The texture arithmetic behind the map generator's fills, with no image
// library behind it: the blur every measurement here is made with, the seeded
// grain every fill is made of, the per-octave amplitude that ties one to the
// other, and the coverage-gap pass built on all three. Kept apart from
// tools/gen-moonmaps.mjs so it can be exercised on a synthetic raster without
// a decoder in the loop (src/planetarium/surfaceGrain.test.ts).
//
// COVERAGE GAPS, which is what the pass at the bottom exists for. A global
// mosaic is a patchwork of what several spacecraft happened to fly over:
// Galileo strips at a few hundred metres per pixel laid over Voyager fill at
// ten times that, all resampled onto one grid. Every pixel of it is a real
// measurement, so none of this is missing data and none of it wants the
// no-data fill. But the coarse patches are rectangles — a mosaic changes
// product on a frame boundary, and a frame boundary is a straight line, which
// is the one thing a real surface never draws. From orbit that reads as
// terrain; with the moon filling the screen it reads as pieces of different
// pictures stitched together, which is what it is.
//
// So the coarse patches are given back the one thing the resample took off
// them: grain, at the amplitude the sharp parts of this same map measure, in
// a continuous ramp that follows how much detail is actually missing. Three
// rules hold it honest, and each one is a rule about what a map may assert:
//
//   * Isotropic grain and nothing else. No craters, no directional shading,
//     no patches borrowed from elsewhere on the body. A crater drawn into an
//     albedo map is a claim that there is a crater there; grain is a claim
//     that the ground is rough, which is true of every one of these surfaces.
//     The relief term draws craters at close range by tilting the normal, and
//     that is the term allowed to invent, because it is lit by the real Sun
//     and vanishes at the terminator like real relief does.
//   * Continuous everywhere. The fill is scaled by a deficit that is measured
//     over a window and then blurred over degrees, so it fades in across the
//     coarse patch's own boundary. A binary mask would replace one straight
//     edge with another.
//   * Zero mean. The map's mean in linear light is its albedo (see the LEVELS
//     note in gen-moonmaps.mjs), so a fill that brightened or darkened what it
//     touched would move the body off the albedo curve the whole batch is
//     graded against.
//
// Where the map already carries detail the deficit is zero by construction and
// the pass adds literally nothing: those pixels come out bit-identical.

/**
 * Separable box blur, three passes, which is a gaussian to within a per cent.
 * Wraps in x — every raster here is a globe, and a blur that runs off the
 * prime meridian instead of round it leaves a line down the middle of a
 * tidally locked moon's face — and clamps in y at the poles.
 *
 * `radiusX` may be one radius per ROW instead of one number, which is what a
 * window measured in DEGREES needs on an equirect map: a degree of longitude
 * is cos(lat) as many pixels as a degree of latitude, so a window that is
 * square on the ground is wider in the raster the further it sits from the
 * equator. `radiusY` defaults to `radiusX` and must be a number.
 *
 * `src` and the result are Float32Array of one channel.
 */
export function blurMono(src, W, H, radiusX, radiusY = radiusX) {
  // Half a turn is the widest a wrapping box can be before it starts counting
  // the same pixels twice, which at the poles a latitude-scaled radius asks
  // for on its own.
  const cap = Math.max(1, (W - 1) >> 1);
  const rows = new Int32Array(H);
  let any = false;
  for (let y = 0; y < H; y++) {
    const want = typeof radiusX === 'number' ? radiusX : radiusX[y];
    const r = want < 0.5 ? 0 : Math.min(cap, Math.max(1, Math.round(want)));
    rows[y] = r;
    if (r) any = true;
  }
  const ry = radiusY < 0.5 ? 0 : Math.max(1, Math.round(radiusY));
  if (!any && !ry) return Float32Array.from(src);
  let cur = Float32Array.from(src);
  const tmp = new Float32Array(W * H);
  for (let pass = 0; pass < 3; pass++) {
    // x, wrapping
    for (let y = 0; y < H; y++) {
      const row = y * W;
      const r = rows[y];
      if (!r) {
        for (let x = 0; x < W; x++) tmp[row + x] = cur[row + x];
        continue;
      }
      let sum = 0;
      for (let d = -r; d <= r; d++) sum += cur[row + ((d % W) + W) % W];
      const inv = 1 / (2 * r + 1);
      for (let x = 0; x < W; x++) {
        tmp[row + x] = sum * inv;
        sum += cur[row + ((x + r + 1) % W)] - cur[row + ((x - r) % W + W) % W];
      }
    }
    // y, clamped
    if (!ry) { cur.set(tmp); continue; }
    for (let x = 0; x < W; x++) {
      let sum = 0;
      for (let d = -ry; d <= ry; d++) sum += tmp[Math.min(H - 1, Math.max(0, d)) * W + x];
      const inv = 1 / (2 * ry + 1);
      for (let y = 0; y < H; y++) {
        cur[y * W + x] = sum * inv;
        sum += tmp[Math.min(H - 1, y + ry + 1) * W + x] - tmp[Math.max(0, y - ry) * W + x];
      }
    }
  }
  return cur;
}

/** One radius per row: `basePx` at the equator, widened by 1/cos(lat) toward
 *  the poles so the window covers the same piece of ground everywhere, and
 *  held at `maxScale` where cos(lat) runs to nothing. */
export function latScaledRadii(H, basePx, maxScale = 6) {
  const out = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    const lat = ((90 - ((y + 0.5) * 180) / H) * Math.PI) / 180;
    out[y] = basePx * Math.min(maxScale, 1 / Math.max(1e-3, Math.cos(lat)));
  }
  return out;
}

/**
 * One value-noise octave's peak-to-peak amplitude per unit of standard
 * deviation. Measured rather than derived: `matched` scales the interpolated
 * value between hashed cell corners, and smoothstepping between two corners
 * has a good deal less spread than the corners themselves do, so grain asked
 * for at amplitude A comes out at A/4.63 of a standard deviation. Getting this
 * wrong is not a rounding error — it is a fill that lands at two thirds of the
 * amount of variation it was told to match.
 */
export const NOISE_AMP_PER_SIGMA = 4.63;

/** Two octaves of seeded value noise, so a filled region carries grain
 *  instead of a flat wash — and the same grain every bake, because a moon
 *  must not change face between sessions. */
export function valueNoise(W) {
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
  const at = (x, y, cell, s, cols) => {
    const gx = Math.floor(x / cell);
    const gy = Math.floor(y / cell);
    const fx = x / cell - gx;
    const fy = y / cell - gy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    // Cells across, which is what the wrap is taken modulo. A caller that
    // needs the grain to meet itself at the map's edge states the count and
    // sizes its cell as W/count; a cell that does not divide the width wraps
    // onto a different value than it started from and leaves a step down one
    // meridian.
    const gw = cols ?? Math.max(1, Math.ceil(W / cell));
    const wrap = (g) => ((g % gw) + gw) % gw;
    const a = hash(wrap(gx), gy, s);
    const b = hash(wrap(gx + 1), gy, s);
    const c = hash(wrap(gx), gy + 1, s);
    const d = hash(wrap(gx + 1), gy + 1, s);
    const top = a + (b - a) * sx;
    return top + (c + (d - c) * sx - top) * sy;
  };
  return {
    /** The historical two-octave grain, in units of one standard deviation. */
    plain: (x, y) => (at(x, y, Math.max(2, W / 256), 1) - 0.5) * 1.1 + (at(x, y, Math.max(2, W / 64), 2) - 0.5) * 0.7,
    /** Octaves at stated cell sizes and stated amplitudes, in counts. */
    matched: (octaves, seed = 3) => (x, y) => {
      let v = 0;
      for (let k = 0; k < octaves.length; k++) {
        v += (at(x, y, Math.max(2, octaves[k].cell), seed + k, octaves[k].cols) - 0.5) * octaves[k].amp;
      }
      return v;
    },
  };
}

/**
 * The requested cell size, adjusted to tile the map's width exactly, as the
 * `{ cell, cols }` pair `matched` wants. A whole number of cells across is
 * what lets the grain meet itself at the map's edge — which on a globe is not
 * an edge at all but a meridian straight down the middle of a hemisphere.
 */
export function wrappingCell(W, want) {
  const cols = Math.max(1, Math.round(W / want));
  return { cell: W / cols, cols };
}

/**
 * How much variation a band carries, octave by octave.
 *
 * A fill that has the right mean and no structure reads as fog, and a fill
 * with structure at the wrong amplitude reads as a different moon. What makes
 * it read as the same surface continuing is having the same amount of
 * variation at each scale, so each octave's amplitude is measured here — as
 * the spread of what one blur keeps and the next blur throws away — over the
 * pixels that carry the real picture, and handed to noise cells of that size.
 *
 * The amplitude comes back in the peak-to-peak units `matched` scales, via
 * NOISE_AMP_PER_SIGMA, so grain built from it has the spread that was
 * measured. A fill that wants less than that says so with a gain of its own.
 *
 * The spread is a MEDIAN absolute deviation, not an RMS. A flyby mosaic's
 * terminator strip is a few per cent of the pixels carrying ten times the
 * contrast of the rest, and an RMS of the whole imaged half is really a
 * measurement of that strip — grain built from it buries the moon in noise.
 * The median asks what a typical piece of this surface does.
 *
 * `groups` is a list of populations to measure over — `[(i) => !mask[i]]` for
 * one, more when two parts of the same map are being compared with each other
 * — and the answer comes back one octave list per group. `band` should already
 * hold something sane (the imaged mean, say) wherever a pixel may not be
 * measured, since the blurs read every pixel whatever the groups say.
 */
export function bandAmplitudes(band, W, H, cells, groups, stride = 7) {
  const n = W * H;
  const out = groups.map(() => []);
  let finer = band;
  for (const spec of cells) {
    const cell = typeof spec === 'number' ? spec : spec.cell;
    // One blur per octave, each from the original band, and only two of them
    // alive at a time: a source-resolution mosaic is a hundred megapixels and
    // a full ladder of blurs held at once is gigabytes for no reason.
    const coarser = blurMono(band, W, H, cell / 2);
    const samples = groups.map(() => []);
    for (let i = 0; i < n; i += stride) {
      let d = -1;
      for (let g = 0; g < groups.length; g++) {
        if (!groups[g](i)) continue;
        if (d < 0) d = Math.abs(finer[i] - coarser[i]);
        samples[g].push(d);
      }
    }
    for (let g = 0; g < groups.length; g++) {
      const s = samples[g];
      s.sort((a, b) => a - b);
      const mad = s.length ? s[Math.floor(s.length / 2)] : 0;
      out[g].push({ ...(typeof spec === 'number' ? { cell } : spec), amp: NOISE_AMP_PER_SIGMA * 1.4826 * mad, samples: s.length });
    }
    finer = coarser;
  }
  return out;
}

/**
 * Mean of |band - blur(band, deg)| over a window a degree or so across: how
 * much variation the picture carries at scales FINER than `deg`.
 *
 * `valid` is the no-data mask's complement, or null. The mean is weighted by
 * coverage rather than taken flat, since a hole inside the window would
 * otherwise drag the energy down and report the ground beside it as smeared.
 */
function windowEnergy(band, W, H, deg, pxPerDeg, winRows, winPx, valid) {
  const n = W * H;
  const r = deg * pxPerDeg;
  const work = blurMono(band, W, H, latScaledRadii(H, r), r);
  for (let i = 0; i < n; i++) work[i] = valid && !valid[i] ? 0 : Math.abs(band[i] - work[i]);
  const energy = blurMono(work, W, H, winRows, winPx);
  if (valid) {
    for (let i = 0; i < n; i++) work[i] = valid[i] ? 1 : 0;
    const cover = blurMono(work, W, H, winRows, winPx);
    for (let i = 0; i < n; i++) energy[i] = cover[i] > 1e-6 ? energy[i] / cover[i] : 0;
  }
  return energy;
}

/**
 * How much the finest band varies in the direction it varies LEAST.
 *
 * The gradient structure tensor of the fine band, averaged over the window and
 * reduced to its smaller eigenvalue. Ground that has been stretched along one
 * axis still steps sharply across its streaks and does nothing along them, so
 * an average of |gradient| over all directions reads it as detail; the smaller
 * eigenvalue is the variation the least-varying direction carries, and a
 * stretched panel has none.
 *
 * The two differences are taken over steps covering the same GROUND either
 * way — a degree of longitude is cos(lat) as much ground as a degree of
 * latitude — so an equirect map's own stretch toward the pole is not read as
 * a smear.
 */
function fineDirectional(band, W, H, fineDeg, stepDeg, pxPerDeg, winRows, winPx, valid) {
  const n = W * H;
  const r = fineDeg * pxPerDeg;
  let hp = blurMono(band, W, H, latScaledRadii(H, r), r);
  for (let i = 0; i < n; i++) hp[i] = band[i] - hp[i];
  const stepY = Math.max(1, Math.round(stepDeg * pxPerDeg));
  let jxx = new Float32Array(n);
  let jyy = new Float32Array(n);
  let jxy = new Float32Array(n);
  let cover = new Float32Array(n);
  for (let y = 0; y < H; y++) {
    const lat = ((90 - ((y + 0.5) * 180) / H) * Math.PI) / 180;
    const sx = Math.max(1, Math.round(stepY / Math.max(0.08, Math.cos(lat))));
    const y0 = Math.max(0, y - stepY);
    const y1 = Math.min(H - 1, y + stepY);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const xa = y * W + ((x + sx) % W);
      const xb = y * W + ((x - sx + W) % W);
      const ya = y1 * W + x;
      const yb = y0 * W + x;
      // A difference that reaches into a hole is not a measurement of the
      // ground, so it is left out of the window mean rather than counted as
      // no variation.
      if (valid && !(valid[i] && valid[xa] && valid[xb] && valid[ya] && valid[yb])) continue;
      const gx = hp[xa] - hp[xb];
      const gy = hp[ya] - hp[yb];
      jxx[i] = gx * gx;
      jyy[i] = gy * gy;
      jxy[i] = gx * gy;
      cover[i] = 1;
    }
  }
  hp = null;
  const sxx = blurMono(jxx, W, H, winRows, winPx);
  jxx = null;
  const syy = blurMono(jyy, W, H, winRows, winPx);
  jyy = null;
  const sxy = blurMono(jxy, W, H, winRows, winPx);
  jxy = null;
  const cov = valid ? blurMono(cover, W, H, winRows, winPx) : null;
  cover = null;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const k = cov ? (cov[i] > 1e-6 ? 1 / cov[i] : 0) : 1;
    const xx = sxx[i] * k;
    const yy = syy[i] * k;
    const xy = sxy[i] * k;
    const d = Math.sqrt(Math.max(0, (xx - yy) ** 2 + 4 * xy * xy));
    out[i] = Math.sqrt(Math.max(0, (xx + yy - d) / 2));
  }
  return out;
}

/**
 * Where the picture stopped carrying detail.
 *
 * The measure is a RATIO: how much of what a piece of ground varies by sits in
 * its finest band (below about a tenth of a degree) against how much sits in
 * everything below a degree. Cratered ground carries both and the ratio is
 * high; ground that has been through a resample from ten times the pixel size
 * keeps its coarse shape and has nothing left at the fine end, and the ratio
 * collapses. The reference is a high percentile of the ratio over the whole
 * body rather than a fixed number, so a map that is soft everywhere is judged
 * against itself and no absolute idea of "sharp" is imported from another moon.
 *
 * A ratio and not the fine energy on its own, which is what this measured
 * before. Energy scales with how much light the ground reflects, so an
 * absolute threshold reads a dark cratered plain as half-smeared and a bright
 * one as sharp: on Callisto's own source, the plain fine energy puts a Galileo
 * swath at a deficit of 0.21 and the smeared south-polar swath at 0.86, while
 * the ratio separates the same two at 0.04 and 0.77. What is wanted is ground
 * that has lost its detail, not ground that is dark.
 *
 * The numerator is directional (see fineDirectional) so that a panel stretched
 * along one axis fails it too. On Callisto's own polar smear that costs
 * nothing and buys nothing — those streaks radiate, so a window a degree and a
 * half across holds every direction at once and the tensor reads them as
 * nearly isotropic (anisotropy 0.26 there against 0.11 on cratered ground) —
 * but a mosaic that stretches a frame along a map axis is the other half of
 * the same fault, and an isotropic measure calls it detail.
 *
 * Deficit is 1 - r/r_ref clamped to [0, 1], blurred wide so it changes over
 * degrees rather than over pixels: what it scales is a fill, and a fill that
 * switched on inside a pixel would draw exactly the kind of edge this pass
 * exists to remove.
 *
 * Unmeasured pixels are flat, so left in they would read as the deepest
 * deficit on the body; they are excluded from the window means, from the
 * percentile, and from the result. What to put in a hole is a different
 * question with a different answer (see fillNoData in gen-moonmaps.mjs).
 *
 * `energy` comes back with the deficit: it is the fine-band energy the fill
 * has to match, and measuring it twice would be measuring it differently.
 */
export function detailDeficit(band, W, H, spec, pxPerDeg, valid = null) {
  const n = W * H;
  const winPx = spec.windowDeg * pxPerDeg;
  const widePx = spec.wideDeg * pxPerDeg;
  const winRows = latScaledRadii(H, winPx);

  let ratio = fineDirectional(
    band, W, H, spec.fineDeg, spec.stepDeg ?? spec.fineDeg, pxPerDeg, winRows, winPx, valid,
  );
  const energy = windowEnergy(band, W, H, spec.fineDeg, pxPerDeg, winRows, winPx, valid);
  let coarse = windowEnergy(band, W, H, spec.coarseDeg, pxPerDeg, winRows, winPx, valid);
  // Ground with no variation at all in either band has no ratio to speak of
  // and gets no opinion: a hundredth of a count is below what an 8-bit map
  // can hold, so nothing there is being measured.
  for (let i = 0; i < n; i++) ratio[i] = coarse[i] > 0.01 ? ratio[i] / coarse[i] : 0;
  // A hundred-megapixel mosaic makes each of these arrays half a gigabyte, and
  // the wide blur below wants two more.
  coarse = null;

  const sample = [];
  for (let i = 0; i < n; i += spec.stride ?? 7) if (!valid || valid[i]) sample.push(ratio[i]);
  sample.sort((a, b) => a - b);
  const pick = (p) => (sample.length ? sample[Math.min(sample.length - 1, Math.floor(p * sample.length))] : 0);
  const ref = pick(spec.refPercentile ?? 0.6);

  // Clamped symmetrically, blurred, and only then cut at zero. A ratio
  // measured off a picture wanders either side of the reference even on ground
  // that is uniformly sharp, and cutting first would keep every wander that
  // went one way and throw away every wander that went the other — which puts
  // a small positive deficit on ground that has lost nothing. The wide blur is
  // what turns the wander into the average it should be.
  for (let i = 0; i < n; i++) {
    const d = ref > 0 ? 1 - ratio[i] / ref : 0;
    ratio[i] = d < -1 ? -1 : d > 1 ? 1 : d;
  }
  const deficit = blurMono(ratio, W, H, latScaledRadii(H, widePx), widePx);
  ratio = null;
  for (let i = 0; i < n; i++) if (deficit[i] < 0) deficit[i] = 0;
  // Ground that measured at or above the reference comes out of the blur a
  // few parts in a hundred million short of zero rather than at it, and a
  // fill that touches every pixel on the body by a millionth of a count is a
  // fill that cannot say it left the sharp ground alone. Below a thousandth
  // there is nothing to add: at that amplitude the grain is four hundredths of
  // a count, which is not a value an 8-bit map can hold.
  const floor = spec.floor ?? 0.001;
  for (let i = 0; i < n; i++) if (deficit[i] < floor) deficit[i] = 0;
  if (valid) for (let i = 0; i < n; i++) if (!valid[i]) deficit[i] = 0;
  return { deficit, energy, ref, median: pick(0.5) };
}

/**
 * Give the coarse parts of a mosaic the grain the sharp parts have.
 *
 * Returns the change as its own band — nothing is written to `band` — because
 * a colour mosaic wants it added to all three channels equally: grain is a
 * change of brightness and not of colour, and these mosaics carry no more
 * detail in their chroma than in their luminance anyway.
 *
 * The grain octaves are measured over the map's own sharp ground, which is
 * where the deficit is low, and they sit inside the band the deficit was
 * measured in — a fill coarser than that would be adding shape the detector
 * never asked about.
 */
export function coverageFill(band, W, H, spec, pxPerDeg, valid = null) {
  const n = W * H;
  const { deficit, energy, ref, median } = detailDeficit(band, W, H, spec, pxPerDeg, valid);

  // Two populations of the same map, measured together. The reference is the
  // ground that still has its detail — a generous cut, so the sample is most
  // of the body rather than its sharpest strip — and the other is the ground
  // that has lost it.
  const refCut = spec.referenceBelow ?? 0.15;
  const gapCut = spec.gapAbove ?? 0.6;
  const isRef = (i) => deficit[i] <= refCut && (!valid || valid[i]);
  const isGap = (i) => deficit[i] >= gapCut && (!valid || valid[i]);

  const blurPx = spec.fineDeg * pxPerDeg;
  // As multiples of the finest band the detector measures, up to the coarse
  // one: the fill fits inside the band the deficit is a statement about, and
  // grain coarser than that would be shape nothing asked about.
  const cells = [];
  for (const f of spec.grainCells ?? [1, 2, 4, 8]) {
    const cell = wrappingCell(W, Math.max(2, Math.min(spec.coarseDeg * pxPerDeg, blurPx * f)));
    // Two octaves whose blurs round to the same radius are one octave and an
    // empty one, and an empty octave is amplitude the fill silently does not
    // carry.
    const r = Math.max(1, Math.round(cell.cell / 2));
    if (cells.some((c) => Math.max(1, Math.round(c.cell / 2)) === r)) continue;
    cells.push(cell);
  }
  const [refOct, gapOct] = bandAmplitudes(band, W, H, cells, [isRef, isGap], spec.stride ?? 7);
  // What to ADD is what is missing, not what a sharp region holds: the coarse
  // end of a smeared patch still carries most of its own variation, and grain
  // laid on top of that at the full reference amplitude would leave the patch
  // busier than the ground around it. Subtracting in quadrature is what makes
  // the two agree once the grain is in, octave by octave — and it is only
  // trustworthy where the gap population is big enough to have a median worth
  // the name.
  const enough = (gapOct[0]?.samples ?? 0) * (spec.stride ?? 7) > 0.002 * n;
  const octaves = refOct.map((o, k) => ({
    ...o,
    amp: enough ? Math.sqrt(Math.max(0, o.amp * o.amp - gapOct[k].amp * gapOct[k].amp)) : o.amp,
  }));
  // The octaves above say what SHAPE the grain has — how its variation is
  // spread across scales, measured octave by octave off this map's own sharp
  // ground. They do not say how much of it there is: those amplitudes are
  // median deviations, which is what makes them robust to a terminator strip
  // ten times the contrast of everything else, and a median under-reads the
  // energy of ground whose contrast is in its craters. So the LEVEL is solved
  // instead of assumed. A tile of the grain is measured exactly the way the
  // fine band was — the same blur, the same absolute mean — and the whole
  // ladder is scaled so that ground at full deficit comes out carrying the
  // reference ground's fine-band energy. That is what "energy-matched" has to
  // mean to be worth stating. The deficit's own reference is a RATIO and says
  // only where the fill goes; how much of it there is comes from the energy.
  const refEnergy = [];
  for (let i = 0; i < n; i += spec.stride ?? 7) if (isRef(i)) refEnergy.push(energy[i]);
  refEnergy.sort((a, b) => a - b);
  const energyRef = refEnergy.length ? refEnergy[refEnergy.length >> 1] : 0;
  const noise = valueNoise(W);
  const probe = (octs) => {
    const tw = Math.min(W, 512);
    const th = Math.min(H, 512);
    const at = noise.matched(octs, spec.seed ?? 11);
    const tile = new Float32Array(tw * th);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) tile[y * tw + x] = at(x, y);
    const low = blurMono(tile, tw, th, blurPx);
    // The blur wraps in x and clamps in y, which a tile of a bigger picture
    // does not, so the margin it gets wrong stays out of the mean.
    const m = Math.min(Math.floor(Math.min(tw, th) / 4), Math.max(2, Math.round(3 * blurPx)));
    let sum = 0;
    let count = 0;
    for (let y = m; y < th - m; y++) {
      for (let x = m; x < tw - m; x++) { sum += Math.abs(tile[y * tw + x] - low[y * tw + x]); count++; }
    }
    return count ? sum / count : 0;
  };
  const carried = probe(octaves);
  const level = carried > 1e-6 ? Math.min(spec.maxLevel ?? 3, energyRef / carried) : 1;
  for (const o of octaves) o.amp *= level;
  const grainAt = noise.matched(octaves, spec.seed ?? 11);

  // How bright this part of the body is, against how bright the reference
  // ground is. A surface's contrast is a variation in how much light it
  // reflects, so it scales with what it reflects: the same grain in counts
  // that reads as roughness on the cratered plains reads as sensor noise on a
  // dark polar floor half as bright.
  const toneRadii = latScaledRadii(H, spec.wideDeg * pxPerDeg);
  const tone = blurMono(band, W, H, toneRadii, spec.wideDeg * pxPerDeg);
  let refSum = 0;
  let refPixels = 0;
  for (let i = 0; i < n; i++) if (isRef(i)) { refSum += band[i]; refPixels++; }
  const refTone = refPixels ? refSum / refPixels : 128;
  const toneLo = spec.toneFloor ?? 0.35;
  const toneHi = spec.toneCeiling ?? 1.6;

  const delta = new Float32Array(n);
  let sum = 0;
  let touched = 0;
  let peak = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const d = deficit[i];
      if (d <= 0) continue;
      const t = Math.min(toneHi, Math.max(toneLo, tone[i] / refTone));
      const v = grainAt(x, y) * d * t;
      delta[i] = v;
      sum += v;
      touched++;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
  }
  return {
    delta,
    deficit,
    octaves,
    refOctaves: refOct,
    gapOctaves: gapOct,
    quadrature: enough,
    ref,
    energyRef,
    median,
    level,
    refTone,
    refFraction: refPixels / n,
    touchedFraction: touched / n,
    meanDelta: sum / n,
    peakDelta: peak,
  };
}

// ---------------------------------------------------------------------------
// Frame-boundary brightness steps
// ---------------------------------------------------------------------------

/** Longest run of consecutive indices where `sign * v[i] >= min`, with the
 *  median of |v| over it. `circular` closes the sequence, which is what a run
 *  of longitude needs and a run of latitude must not have. */
function longestRun(v, len, min, sign, circular) {
  let best = null;
  const val = (i) => v[((i % len) + len) % len];
  let from = 0;
  if (circular) {
    // Start somewhere the run is broken, so a run across the wrap is seen
    // whole rather than as two pieces.
    while (from < len && sign * val(from) >= min) from++;
    if (from === len) from = 0; // the whole circle steps the same way
  }
  let run = 0;
  let start = 0;
  for (let k = 0; k <= len; k++) {
    const i = from + k;
    const ok = k < len && sign * val(i) >= min;
    if (ok) { if (!run) start = i; run++; continue; }
    if (run) {
      const s = [];
      for (let j = start; j < start + run; j++) s.push(Math.abs(val(j)));
      s.sort((a, b) => a - b);
      if (!best || run > best.run) best = { start, run, median: s[s.length >> 1] };
      run = 0;
    }
  }
  return best;
}

/**
 * Take the frame-to-frame brightness steps out of a mosaic without taking the
 * body's albedo out with them.
 *
 * The instrument the pipeline already had for this — split the picture into
 * hemispheric albedo, a frame-sized middle band and detail, and halve the
 * middle — works on a body whose real features are either much wider or much
 * finer than a frame. On a moon that is nothing but craters from half a degree
 * to thirty it takes two thirds of the surface out with the steps: on Callisto
 * it leaves 36 per cent of the variation between 1.2 and 8 degrees standing.
 *
 * So this finds the steps instead of filtering for them. A frame boundary in a
 * map-projected mosaic is a STRAIGHT line, usually along a meridian or a
 * parallel, and a straight line is the one thing a real surface never draws: a
 * column where the low-passed picture steps the same way for ten degrees of
 * ground is not a coincidence of craters. Each one found is then closed the
 * way a named seam is — measure the step along it, spread half of it into each
 * side with a weight that decays over a few degrees — so every pixel keeps its
 * own detail and the two sides simply arrive at the boundary agreeing about
 * how bright this moon is.
 *
 * What counts as a step is the jump ON TOP of the slope the ground already
 * has: the difference across the line, less the difference the two sides'
 * own slopes would have produced across it anyway. Measuring the plain
 * difference instead finds every broad albedo gradient on the body and
 * flattens a few degrees of it into a ledge, and misses the real frame
 * boundaries, which sit where the brightness was already changing.
 *
 * What it deliberately does not do: a boundary running diagonally is left
 * alone, since a correction spread the wrong way across it would smear the
 * step along the edge instead of closing it. Those are what the coverage fill
 * has to carry on its own.
 */
/**
 * The straight brightness steps in a map, worst first.
 *
 * `only` re-measures a list of lines that were found before instead of
 * scanning for new ones, which is how a repair is checked: the same lines, the
 * same window, the same arithmetic, before and after.
 */
export function findEdges(band, W, H, spec, pxPerDeg, valid = null, only = null) {
  const lookDeg = spec.lookDeg ?? 0.5;
  const alongDeg = spec.alongDeg ?? 1;
  const minStep = spec.minStep ?? 3;
  const minSpanDeg = spec.minSpanDeg ?? 5;
  const maxEdges = spec.maxEdges ?? 64;
  const smoothDeg = spec.smoothDeg ?? 0.4;
  const ok = (i) => !valid || valid[i];
  const wrapX = (x) => ((x % W) + W) % W;
  const cosAt = (y) => Math.max(0.08, Math.cos(((90 - ((y + 0.5) * 180) / H) * Math.PI) / 180));
  // The caps are not scanned. A window measured in degrees of GROUND is
  // hundreds of pixels wide up there, wide enough that what it reads is the
  // shape of the terrain rather than a step in it, and the ground it reads is
  // a few pixels of the drawn globe.
  const skip = Math.round((H * (90 - (spec.skipLatDeg ?? 80))) / 180);
  const L = blurMono(band, W, H, latScaledRadii(H, smoothDeg * pxPerDeg), smoothDeg * pxPerDeg);

  // The jump across a line, less the slope the two sides carry into it: 1.5 of
  // the near difference against 0.5 of the far one is that second difference
  // written out.
  const stepMeridian = (at, y, d) => {
    const near0 = y * W + wrapX(at - d);
    const near1 = y * W + wrapX(at + d - 1);
    const far0 = y * W + wrapX(at - 3 * d);
    const far1 = y * W + wrapX(at + 3 * d - 1);
    if (!ok(near0) || !ok(near1) || !ok(far0) || !ok(far1)) return 0;
    return 1.5 * (L[near1] - L[near0]) - 0.5 * (L[far1] - L[far0]);
  };
  const stepParallel = (at, x, d) => {
    if (at - 3 * d < 0 || at + 3 * d - 1 >= H) return 0;
    const near0 = (at - d) * W + x;
    const near1 = (at + d - 1) * W + x;
    const far0 = (at - 3 * d) * W + x;
    const far1 = (at + 3 * d - 1) * W + x;
    if (!ok(near0) || !ok(near1) || !ok(far0) || !ok(far1)) return 0;
    return 1.5 * (L[near1] - L[near0]) - 0.5 * (L[far1] - L[far0]);
  };
  const lookMeridian = (y) => Math.max(1, Math.round((lookDeg * pxPerDeg) / cosAt(y)));
  const lookParallel = Math.max(1, Math.round(lookDeg * pxPerDeg));
  /** The step along one line, smoothed so it follows the calibration rather
   *  than whatever crater sits against the boundary. */
  const profileOf = (axis, at) => {
    const len = axis === 'meridian' ? H : W;
    const raw = new Float32Array(len);
    const soft = new Float32Array(len);
    for (let k = 0; k < len; k++) {
      if (axis === 'meridian' && (k < skip || k >= H - skip)) continue;
      raw[k] = axis === 'meridian' ? stepMeridian(at, k, lookMeridian(k)) : stepParallel(at, k, lookParallel);
    }
    const along = axis === 'meridian'
      ? Math.max(1, Math.round(alongDeg * pxPerDeg))
      : Math.max(1, Math.round((alongDeg * pxPerDeg) / cosAt(at)));
    boxAlong(raw, soft, len, along, axis === 'parallel');
    return soft;
  };

  if (only) {
    return {
      lowPass: L,
      profileOf,
      edges: only.map((e) => {
        const soft = profileOf(e.axis, e.at);
        const vals = [];
        for (let k = e.from; k < e.to; k++) vals.push(soft[e.axis === 'parallel' ? wrapX(k) : k]);
        // Signed, so a re-measurement that has gone past zero says so rather
        // than reporting the size of its own overshoot as a leftover step.
        vals.sort((a, b) => a - b);
        const step = vals.length ? vals[vals.length >> 1] : 0;
        return { ...e, step, score: e.spanDeg * Math.abs(step) };
      }),
    };
  }

  const edges = [];
  const step = new Float32Array(Math.max(W, H));
  const soft = new Float32Array(Math.max(W, H));
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) step[y] = y < skip || y >= H - skip ? 0 : stepMeridian(x, y, lookMeridian(y));
    boxAlong(step, soft, H, Math.max(1, Math.round(alongDeg * pxPerDeg)), false);
    for (const sign of [1, -1]) {
      const run = longestRun(soft, H, minStep, sign, false);
      if (!run) continue;
      const spanDeg = (run.run * 180) / H;
      if (spanDeg < minSpanDeg) continue;
      edges.push({ axis: 'meridian', at: x, from: run.start, to: run.start + run.run, spanDeg, step: sign * run.median, score: spanDeg * run.median });
    }
  }
  // A run along a parallel is measured in ground degrees: a run of longitude
  // at 70 north covers a third of the ground the same run covers at the
  // equator.
  for (let y = skip; y < H - skip; y++) {
    for (let x = 0; x < W; x++) step[x] = stepParallel(y, x, lookParallel);
    boxAlong(step, soft, W, Math.max(1, Math.round((alongDeg * pxPerDeg) / cosAt(y))), true);
    for (const sign of [1, -1]) {
      const run = longestRun(soft, W, minStep, sign, true);
      if (!run) continue;
      const spanDeg = ((run.run * 360) / W) * cosAt(y);
      if (spanDeg < minSpanDeg) continue;
      edges.push({ axis: 'parallel', at: y, from: run.start, to: run.start + run.run, spanDeg, step: sign * run.median, score: spanDeg * run.median });
    }
  }

  // One correction per boundary: neighbouring lines see the same step through
  // the same window, and correcting each of them would move the ground several
  // times over.
  edges.sort((a, b) => b.score - a.score);
  const apart = Math.max(2, Math.round((spec.apartDeg ?? 3 * lookDeg) * pxPerDeg));
  const taken = [];
  for (const e of edges) {
    const overlaps = (t) => (e.axis === 'parallel'
      ? true
      : !(e.to <= t.from || e.from >= t.to));
    if (taken.some((t) => t.axis === e.axis && Math.abs(t.at - e.at) < apart && overlaps(t))) continue;
    taken.push(e);
    if (taken.length >= maxEdges) break;
  }
  return { edges: taken, lowPass: L, profileOf };
}

export function levelEdges(band, W, H, spec, pxPerDeg, valid = null) {
  const rampDeg = spec.rampDeg ?? 4;
  const rounds = spec.rounds ?? 2;
  const wrapX = (x) => ((x % W) + W) % W;
  const cosAt = (y) => Math.max(0.08, Math.cos(((90 - ((y + 0.5) * 180) / H) * Math.PI) / 180));
  const found = [];
  for (let round = 0; round < rounds; round++) {
    const { edges, profileOf } = findEdges(band, W, H, spec, pxPerDeg, valid);
    if (!edges.length) break;
    for (const e of edges) {
      const len = e.axis === 'meridian' ? H : W;
      const soft = profileOf(e.axis, e.at);
      // Bounded by what this edge typically is, so one crater against the
      // boundary cannot become a ridge on the far side.
      const cap = 3 * Math.abs(e.step);
      // Where the correction acts is decided by the measurement, not by the
      // ends of the run that found the edge: a boundary fades out where its
      // step does, and a correction cut off at a row number would draw a step
      // at right angles to the one it just closed. Below a third of the
      // threshold nothing is corrected at all, which is what keeps this off
      // the ground either side of the boundary's real extent.
      const lo = 0.3 * (spec.minStep ?? 3);
      const hi = spec.minStep ?? 3;
      const weightAt = (k) => {
        const v = Math.abs(soft[e.axis === 'parallel' ? wrapX(k) : k]);
        const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
        return t * t * (3 - 2 * t);
      };
      for (let k = 0; k < len; k++) {
        const w0 = weightAt(k);
        if (w0 <= 0) continue;
        const half = Math.max(-cap, Math.min(cap, soft[e.axis === 'parallel' ? wrapX(k) : k])) * w0;
        if (!half) continue;
        const ramp = Math.max(2, Math.round(
          e.axis === 'meridian' ? (rampDeg * pxPerDeg) / cosAt(k) : rampDeg * pxPerDeg));
        for (let d = 0; d <= ramp; d++) {
          const t = 1 - d / ramp;
          const w = 0.5 * t * t * (3 - 2 * t);
          if (w <= 0) continue;
          let il;
          let ir;
          if (e.axis === 'meridian') {
            il = k * W + wrapX(e.at - 1 - d);
            ir = k * W + wrapX(e.at + d);
          } else {
            const yl = e.at - 1 - d;
            const yr = e.at + d;
            if (yl < 0 || yr >= H) continue;
            il = yl * W + wrapX(k);
            ir = yr * W + wrapX(k);
          }
          band[il] = Math.min(255, Math.max(0, band[il] + half * w));
          band[ir] = Math.min(255, Math.max(0, band[ir] - half * w));
        }
      }
      found.push({ ...e, round });
    }
  }
  return { edges: found };
}

/** Running-mean smoothing of one profile, `circular` for a profile that runs
 *  round the globe. */
function boxAlong(src, dst, len, r, circular = false) {
  const at = (i) => src[circular ? ((i % len) + len) % len : Math.min(len - 1, Math.max(0, i))];
  let sum = 0;
  for (let d = -r; d <= r; d++) sum += at(d);
  const inv = 1 / (2 * r + 1);
  for (let i = 0; i < len; i++) {
    dst[i] = sum * inv;
    sum += at(i + r + 1) - at(i - r);
  }
}
