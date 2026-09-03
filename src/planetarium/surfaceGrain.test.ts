import { describe, expect, it } from 'vitest';
import {
  blurMono, coverageFill, detailDeficit, findEdges, latScaledRadii, levelEdges, valueNoise, wrappingCell,
} from '../../tools/surfaceGrain.mjs';

// tools/surfaceGrain.mjs is what gives the moon maps their texture: it decides
// where a mosaic stopped carrying detail, how much grain that ground is short
// of, and where the mosaic's frames step in brightness. None of that is
// checkable by eye on a hundred-megapixel raster — a fill that is half as
// strong as it should be looks like a fill — so it is checked here on a
// raster built to a known answer: a grain field of a stated amplitude with a
// rectangle of it smeared away, and a step of a stated size down a straight
// line.
//
// Everything the passes take is in DEGREES and scaled by the raster's own
// pixels per degree, so a small test raster is the same problem as a source
// mosaic with the numbers moved: 2048 px of longitude is 5.7 px per degree, so
// the tenth of a degree that is a five-pixel blur on Callisto's 42 px per
// degree is 0.9 degrees here and the same five pixels.

const W = 2048;
const H = 1024;
const PX_PER_DEG = W / 360;
const SPEC = { fineDeg: 0.9, coarseDeg: 7.4, windowDeg: 8, wideDeg: 10, refPercentile: 0.6 };
const PATCH = { x0: W - 300, x1: 300, y0: 250, y1: 750 };

/**
 * Ground with structure at every scale, and `smeared` rectangles that have
 * lost the finest of it — which is what a resample from ten times the pixel
 * size leaves behind. The middle octave stays inside the patch: a coarse strip
 * of a mosaic still carries its craters at the scale it can hold them, and a
 * detector that only ever sees flat ground in a gap is not being asked the
 * question a real mosaic asks.
 *
 * The right third carries two and a half times the fine grain, because a map
 * with one uniform amount of detail has no ground the reference percentile can
 * call sharp: on a real mosaic the sharp strips are what the deficit is measured
 * against, and there the ground away from a coarse patch comes out at a
 * deficit of exactly zero and is left exactly alone.
 */
function synthetic(
  smeared: Array<{ x0: number; x1: number; y0: number; y1: number }>,
  { midAmp = 24, sharpGain = 2.5 } = {},
) {
  const noise = valueNoise(W);
  const fine = noise.matched([
    { ...wrappingCell(W, 4), amp: 26 },
    { ...wrappingCell(W, 9), amp: 18 },
  ], 7);
  const mid = noise.matched([{ ...wrappingCell(W, 40), amp: midAmp }], 13);
  // Slower than anything the passes look at, so it is the body's own albedo
  // rather than something either of them has an opinion about.
  const slow = noise.matched([{ ...wrappingCell(W, 400), amp: 60 }], 21);
  const band = new Float32Array(W * H);
  const inside = (x: number, y: number) => smeared.some((r) => y >= r.y0 && y < r.y1
    && (r.x0 <= r.x1 ? x >= r.x0 && x < r.x1 : x >= r.x0 || x < r.x1));
  const sharp = (x: number) => x > 0.6 * W && x < 0.95 * W;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      band[y * W + x] = 120 + slow(x, y) + mid(x, y)
        + (inside(x, y) ? 0 : fine(x, y) * (sharp(x) ? sharpGain : 1));
    }
  }
  return { band, inside, sharp };
}

/** How much the picture varies below `fineDeg`, averaged over a window: the
 *  energy the fill has to match. */
function energy(band: Float32Array): Float32Array {
  const r = SPEC.fineDeg * PX_PER_DEG;
  const low = blurMono(band, W, H, latScaledRadii(H, r), r);
  const fine = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) fine[i] = Math.abs(band[i] - low[i]);
  const win = SPEC.windowDeg * PX_PER_DEG;
  return blurMono(fine, W, H, latScaledRadii(H, win), win);
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s[s.length >> 1];
};

describe('detailDeficit', () => {
  // Deliberately across x = 0. The raster is a globe, so its left and right
  // edges are the same meridian, and a window that stops at the edge instead
  // of running round reports the ground either side of it as smeared.
  const { band, inside, sharp } = synthetic([PATCH]);
  const { deficit, ref } = detailDeficit(band, W, H, SPEC, PX_PER_DEG, null);
  const at = (x: number, y = 500) => deficit[y * W + x];

  it('is near one inside a smeared patch, on both sides of the map edge', () => {
    // Not one: the patch keeps the middle octave a resample can still hold,
    // which is what real coarse ground does, so what it is short of is most
    // of its fine band rather than all of its detail.
    expect(at(0)).toBeGreaterThan(0.85);
    expect(at(W - 80)).toBeGreaterThan(0.85);
    expect(at(80)).toBeGreaterThan(0.85);
  });

  it('is exactly zero on the ground that kept its detail', () => {
    // Over the population rather than at one pixel: the ratio is measured
    // from the picture, so it wanders either side of the reference even on
    // ground that is uniformly sharp, and what the fill promises is that the
    // sharp ground comes out untouched.
    let zero = 0;
    let worst = 0;
    const seen: number[] = [];
    for (let y = 300; y < 700; y++) {
      for (let x = Math.round(0.65 * W); x < Math.round(0.9 * W); x++) {
        const d = at(x, y);
        seen.push(d);
        if (d === 0) zero++;
        if (d > worst) worst = d;
      }
    }
    expect(zero / seen.length).toBeGreaterThan(0.8);
    expect(median(seen)).toBeLessThan(0.02);
    expect(worst).toBeLessThan(0.55 * at(0));
    // Ordinary ground is neither: below the reference, so not zero, but
    // nowhere near a patch that has lost everything.
    expect(at(W >> 1)).toBeLessThan(0.35);
    expect(at(W >> 1)).toBeLessThan(0.4 * at(0));
  });

  it('measures the reference from the map itself', () => {
    const e = energy(band);
    const outside: number[] = [];
    const within: number[] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x += 3) {
        if (inside(x, y)) within.push(e[y * W + x]);
        else if (sharp(x)) outside.push(e[y * W + x]);
      }
    }
    // The reference is a ratio — how much the finest band varies against how
    // much everything below a degree does — so it is a number near one and
    // not a count of anything.
    expect(ref).toBeGreaterThan(0.1);
    expect(ref).toBeLessThan(5);
    expect(median(within)).toBeLessThan(0.15 * median(outside));
  });

  it('is not fooled by ground that is dark rather than smeared', () => {
    // Contrast scales with how much light the ground reflects, so ground at
    // half the albedo carries half the variation at every scale and none of
    // it is missing. An absolute threshold calls that a gap; a ratio does not.
    // Faded in over a hundred pixels, since a step would be a feature of its
    // own and the question here is only about level.
    const dim = Float32Array.from(band);
    const fade = (x: number) => {
      const t = Math.min(1, Math.min(x - 0.6 * W, 0.95 * W - x) / 150);
      return t <= 0 ? 1 : 1 - 0.6 * (t * t * (3 - 2 * t));
    };
    for (let y = 0; y < H; y++) {
      for (let x = Math.round(0.6 * W); x < Math.round(0.95 * W); x++) {
        dim[y * W + x] = 120 + (band[y * W + x] - 120) * fade(x);
      }
    }
    const d = detailDeficit(dim, W, H, SPEC, PX_PER_DEG, null).deficit;
    let worst = 0;
    for (let y = 200; y < 800; y++) {
      for (let x = Math.round(0.72 * W); x < Math.round(0.85 * W); x++) worst = Math.max(worst, d[y * W + x]);
    }
    expect(worst).toBeLessThan(0.15);
  });
});

/** A patch of the map's own ground stretched `by` along x — a frame resampled
 *  from a picture that was never that wide. Interpolated, not repeated: a
 *  resample that repeated its source pixel would leave a hard step every
 *  twelfth column, which is detail the detector would be right to find. */
function stretched(by: number, region: { x0: number; x1: number; y0: number; y1: number }) {
  const { band } = synthetic([]);
  const out = Float32Array.from(band);
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) {
      const u = region.x0 + (x - region.x0) / by;
      const i0 = Math.floor(u);
      const f = u - i0;
      out[y * W + x] = band[y * W + i0] * (1 - f) + band[y * W + i0 + 1] * f;
    }
  }
  return out;
}

/** How lopsided the fine band's gradients are over a window: 0 when a piece of
 *  ground varies the same amount whichever way you cross it, 1 when it varies
 *  one way and not the other. */
function anisotropy(band: Float32Array): Float32Array {
  const n = W * H;
  const r = SPEC.fineDeg * PX_PER_DEG;
  const low = blurMono(band, W, H, latScaledRadii(H, r), r);
  const hp = new Float32Array(n);
  for (let i = 0; i < n; i++) hp[i] = band[i] - low[i];
  const s = Math.max(1, Math.round(r));
  const jxx = new Float32Array(n);
  const jyy = new Float32Array(n);
  const jxy = new Float32Array(n);
  for (let y = s; y < H - s; y++) {
    for (let x = 0; x < W; x++) {
      const gx = hp[y * W + ((x + s) % W)] - hp[y * W + ((x - s + W) % W)];
      const gy = hp[(y + s) * W + x] - hp[(y - s) * W + x];
      jxx[y * W + x] = gx * gx;
      jyy[y * W + x] = gy * gy;
      jxy[y * W + x] = gx * gy;
    }
  }
  const win = SPEC.windowDeg * PX_PER_DEG;
  const rows = latScaledRadii(H, win);
  const sxx = blurMono(jxx, W, H, rows, win);
  const syy = blurMono(jyy, W, H, rows, win);
  const sxy = blurMono(jxy, W, H, rows, win);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const tr = sxx[i] + syy[i];
    const d = Math.sqrt(Math.max(0, (sxx[i] - syy[i]) ** 2 + 4 * sxy[i] * sxy[i]));
    out[i] = tr > 1e-9 ? d / tr : 0;
  }
  return out;
}

describe('detailDeficit on a stretched patch', () => {
  // A patch of the map's own sharp ground stretched 12x along one axis: it
  // still steps across its streaks, so an average of |gradient| over all
  // directions reads it as detail. It has nothing along them, which is what
  // the detector has to see.
  const REGION = { x0: 700, x1: 1100, y0: 300, y1: 700 };
  const { deficit } = detailDeficit(stretched(12, REGION), W, H, SPEC, PX_PER_DEG, null);
  const mid = (x: number, y = 500) => deficit[y * W + x];

  it('reads a stretched patch as a gap', () => {
    expect(mid(900)).toBeGreaterThan(0.6);
  });

  it('leaves the unstretched ground around it alone', () => {
    expect(mid(Math.round(0.8 * W))).toBeLessThan(0.2);
    expect(mid(400)).toBeLessThan(0.35);
  });
});

/** One region's variation about its own slow average, multiplied — a frame
 *  whose calibration left it more contrasty than the ground beside it, which
 *  is what a mosaic's coarse frames actually look like. */
function louder(band: Float32Array, r: { x0: number; x1: number; y0: number; y1: number }, gain: number) {
  const low = blurMono(band, W, H, latScaledRadii(H, 60), 60);
  const out = Float32Array.from(band);
  for (let y = r.y0; y < r.y1; y++) {
    for (let x = r.x0; x < r.x1; x++) {
      const i = y * W + x;
      out[i] = low[i] + (band[i] - low[i]) * gain;
    }
  }
  return out;
}

describe('detailDeficit on a frame that is only half smeared', () => {
  // The case the fill half-acted on. Stretched four times rather than twelve,
  // so it keeps enough of its finest band for the count to come out only a
  // little short — and carrying twice the contrast, because that is what these
  // frames look like. The plain count leaves it below the middle of the ramp
  // the fill removes invented shape over, so most of its streaks survive it.
  // What separates it from real ground is not how much its finest band varies
  // but how lopsidedly: 0.38 of the larger eigenvalue against sharp ground's
  // 0.91, which is the same split a stretched frame on Europa's own mosaic
  // measures.
  const REGION = { x0: 700, x1: 1100, y0: 300, y1: 700 };
  const band = louder(stretched(4, REGION), REGION, 2.2);
  const PLAIN = { ...SPEC, isotropyRef: 0 };
  const plain = detailDeficit(band, W, H, PLAIN, PX_PER_DEG, null).deficit;
  const gated = detailDeficit(band, W, H, SPEC, PX_PER_DEG, null).deficit;
  const mid = (d: Float32Array, x: number, y = 500) => d[y * W + x];
  const shape = anisotropy(band);
  const loHi = (x: number, y = 500) => (1 - shape[y * W + x]) / (1 + shape[y * W + x]);

  it('is one-directional inside and even-handed outside', () => {
    expect(loHi(900)).toBeLessThan(0.5);
    expect(loHi(Math.round(0.8 * W))).toBeGreaterThan(0.85);
  });

  it('slips half past a count of how much the finest band varies', () => {
    expect(mid(plain, 900)).toBeLessThan(0.55);
  });

  it('is a gap once that count is discounted by how one-directional it is', () => {
    expect(mid(gated, 900)).toBeGreaterThan(0.6);
    expect(mid(gated, 900)).toBeGreaterThan(1.2 * mid(plain, 900));
  });

  it('cannot be bought off with contrast either way', () => {
    // Both counts are ratios taken off the same picture, so multiplying a
    // frame's variation multiplies numerator and denominator alike and moves
    // neither. What contrast buys is how loud the frame LOOKS, which is why a
    // half-smeared frame reads as a piece of a different picture long before
    // an absolute measure of its detail would call it one.
    const quiet = stretched(4, REGION);
    expect(detailDeficit(quiet, W, H, PLAIN, PX_PER_DEG, null).deficit[500 * W + 900])
      .toBeCloseTo(mid(plain, 900), 2);
    expect(detailDeficit(quiet, W, H, SPEC, PX_PER_DEG, null).deficit[500 * W + 900])
      .toBeCloseTo(mid(gated, 900), 2);
  });

  it('leaves ground that varies the same way in every direction where it was', () => {
    expect(mid(gated, Math.round(0.8 * W))).toBe(0);
    expect(mid(gated, Math.round(0.8 * W))).toBe(mid(plain, Math.round(0.8 * W)));
    expect(mid(gated, 400)).toBeCloseTo(mid(plain, 400), 2);
  });
});

describe('coverageFill on a stretched patch', () => {
  // The point of replacing rather than adding: grain laid over streaks leaves
  // the streaks, and a straight-sided panel of streaks is what a player sees
  // as a piece of a different picture.
  const REGION = { x0: 700, x1: 1100, y0: 300, y1: 700 };
  const band = stretched(12, REGION);
  const fill = coverageFill(band, W, H, SPEC, PX_PER_DEG, null);
  const filled = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) filled[i] = band[i] + fill.delta[i];
  // The core of the patch, clear of the ramp the deficit fades over: what the
  // pass promises at the edges is a ramp, and what it promises in the middle
  // is ground that reads like the ground around it.
  const core = (v: Float32Array) => {
    const s: number[] = [];
    for (let y = REGION.y0; y < REGION.y1; y++) {
      for (let x = REGION.x0; x < REGION.x1; x += 2) {
        if (fill.deficit[y * W + x] > 0.8) s.push(v[y * W + x]);
      }
    }
    return median(s);
  };
  const around = (v: Float32Array) => {
    const s: number[] = [];
    for (let y = 300; y < 700; y++) {
      for (let x = Math.round(0.65 * W); x < Math.round(0.9 * W); x += 2) s.push(v[y * W + x]);
    }
    return median(s);
  };

  it('takes the streaks out rather than drawing over them', () => {
    const before = anisotropy(band);
    const after = anisotropy(filled);
    const ground = around(before);
    expect(core(before)).toBeGreaterThan(2 * ground);
    expect(core(after)).toBeLessThan(0.06 * core(before));
    // Not all the way down to the ground's own. A stretch of twelve moves
    // structure that was four to nine pixels wide out past the coarse low
    // pass, and above that scale the map is entitled to its own shape: the
    // removal takes the band between the low pass and the pixel, and what
    // sits above it stays. What the player sees at close range is the band
    // that goes.
    expect(core(after)).toBeLessThan(2 * ground);
  });

  it('leaves the patch with the detail the reference ground has', () => {
    const e = energy(filled);
    expect(core(e)).toBeGreaterThan(0.7 * fill.energyRef);
    expect(core(e)).toBeLessThan(1.3 * fill.energyRef);
  });
});

describe('coverageFill', () => {
  const { band, inside } = synthetic([PATCH]);
  const fill = coverageFill(band, W, H, SPEC, PX_PER_DEG, null);
  const filled = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) filled[i] = band[i] + fill.delta[i];

  it('brings the smeared patch back to the energy the map is measured against', () => {
    const e = energy(filled);
    const within: number[] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x += 3) {
        // The core of the patch, clear of the ramp the deficit fades over.
        if (inside(x, y) && fill.deficit[y * W + x] > 0.8) within.push(e[y * W + x]);
      }
    }
    expect(within.length).toBeGreaterThan(1000);
    // Scaled by the deficit, which inside this patch is a little under one
    // because the patch keeps the middle octave: a fill that is 0.87 of the
    // way to the reference on ground that is 0.87 short of it is the fill
    // doing what it says.
    const ratio = median(within) / fill.energyRef;
    expect(ratio).toBeGreaterThan(0.7);
    expect(ratio).toBeLessThan(1.15);
  });

  it('leaves the ground that has its detail bit-identical', () => {
    let zero = 0;
    let touched = 0;
    for (let i = 0; i < W * H; i++) {
      if (fill.deficit[i] !== 0) continue;
      zero++;
      if (fill.delta[i] !== 0) touched++;
    }
    expect(zero).toBeGreaterThan(0.05 * W * H);
    expect(touched).toBe(0);
  });

  it('adds no brightness', () => {
    // The map's mean in linear light is the body's albedo, so a fill that
    // brightened what it touched would move the body off the albedo curve the
    // whole batch is graded against.
    expect(Math.abs(fill.meanDelta)).toBeLessThan(0.02);
    let before = 0;
    let after = 0;
    for (let i = 0; i < W * H; i++) { before += band[i]; after += filled[i]; }
    expect(Math.abs(after - before) / before).toBeLessThan(0.001);
  });

  it('fades in over degrees rather than drawing its own edge', () => {
    // Across the patch's own boundary the deficit must climb, not jump.
    let worst = 0;
    for (let y = 320; y < 680; y++) {
      for (let x = 0; x < W; x++) {
        worst = Math.max(worst, Math.abs(fill.deficit[y * W + x] - fill.deficit[y * W + ((x + 1) % W)]));
      }
    }
    expect(worst).toBeLessThan(0.03);
  });
});

describe('findEdges and levelEdges', () => {
  /** A grained field with a constant offset added over one half, so there is a
   *  step of a known size down one meridian and nothing else. */
  function stepped(offset: number, at: number) {
    // No middle octave: this instrument reads the picture at a frame's own
    // scale, and grain there is what it has to tell a step apart from.
    const { band } = synthetic([], { midAmp: 0, sharpGain: 1 });
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) if (x >= at && x < at + W / 2) band[y * W + x] += offset;
    }
    return band;
  }

  // Only the middle latitudes: this raster's grain is laid out in PIXELS, so
  // toward its poles it is finer on the ground than a real map's would be, and
  // a scan there would be reading the test's own geometry.
  const spec = {
    lookDeg: 3, alongDeg: 6, minStep: 8, minSpanDeg: 20, smoothDeg: 2, skipLatDeg: 45,
  };

  it('finds a straight step where it is and sizes it', () => {
    const band = stepped(18, 300);
    const { edges } = findEdges(band, W, H, spec, PX_PER_DEG, null);
    const meridians = edges.filter((e) => e.axis === 'meridian');
    expect(meridians.length).toBeGreaterThan(0);
    const near = meridians.filter((e) => Math.abs(e.at - 300) <= 6 || Math.abs(e.at - (300 + W / 2)) <= 6);
    expect(near.length).toBe(meridians.length);
    expect(Math.abs(near[0].step)).toBeGreaterThan(14);
  });

  it('closes the step and leaves the ground its detail', () => {
    const band = stepped(18, 300);
    const before = findEdges(band, W, H, spec, PX_PER_DEG, null).edges.slice(0, 2);
    const detail = energy(band);
    levelEdges(band, W, H, spec, PX_PER_DEG, null);
    const after = findEdges(band, W, H, spec, PX_PER_DEG, null, before).edges;
    for (let k = 0; k < before.length; k++) {
      expect(Math.abs(after[k].step)).toBeLessThan(0.3 * Math.abs(before[k].step));
      // And under the threshold that counts as a step at all, which is the
      // claim that matters: what is left is not a boundary any more.
      expect(Math.abs(after[k].step)).toBeLessThan(spec.minStep);
    }
    const now = energy(band);
    const kept: number[] = [];
    for (let i = 0; i < W * H; i += 7) if (detail[i] > 0) kept.push(now[i] / detail[i]);
    expect(median(kept)).toBeGreaterThan(0.97);
  });

  it('leaves nothing straight behind, and the mean where it was', () => {
    // The correction this replaced spread half a step into each side over a
    // fixed ramp: it closed the boundary and left a band a few degrees wide
    // with ENDS, and where it stopped it drew a soft rectangle of its own. A
    // harmonic field cannot do that — it has no interior maximum to end on —
    // so a fresh scan of the corrected map finds no straight line anywhere.
    const band = stepped(18, 300);
    let was = 0;
    for (let i = 0; i < W * H; i++) was += band[i];
    expect(findEdges(band, W, H, spec, PX_PER_DEG, null).edges.length).toBeGreaterThan(0);
    levelEdges(band, W, H, spec, PX_PER_DEG, null);
    expect(findEdges(band, W, H, spec, PX_PER_DEG, null).edges).toEqual([]);
    let now = 0;
    for (let i = 0; i < W * H; i++) now += band[i];
    expect(Math.abs(now - was) / (W * H)).toBeLessThan(0.01);
  });

  it('closes a boundary only along the run it measured', () => {
    // A frame boundary is a segment, not a line round the body. Ground on the
    // same column beyond the segment carries steps of its own — a crater wall
    // here — and a jump laid along the whole column turns each of them into a
    // step in the correction: a grid of plateaus with straight edges, which is
    // the very thing this pass exists to remove.
    //
    // Its own raster, at the proportions where that shows: grain light enough
    // that a local feature registers at the finder's smoothing, on a map
    // coarse enough that the feature is longer than the finder's own reach
    // along the line.
    const LW = 1024;
    const LH = 512;
    const LPPD = LW / 360;
    const noise = valueNoise(LW);
    const fine = noise.matched([{ ...wrappingCell(LW, 4), amp: 10 }, { ...wrappingCell(LW, 9), amp: 8 }], 7);
    const slow = noise.matched([{ ...wrappingCell(LW, 400), amp: 60 }], 21);
    const band = new Float32Array(LW * LH);
    for (let y = 0; y < LH; y++) {
      for (let x = 0; x < LW; x++) band[y * LW + x] = 120 + slow(x, y) + fine(x, y);
    }
    const at = 300;
    // Inside the latitudes the finder scans, and shorter than them, so there
    // is scanned ground on the same column beyond both ends of the run.
    const top = Math.round((3 * LH) / 8);
    const bottom = Math.round((5 * LH) / 8);
    for (let y = top; y < bottom; y++) {
      for (let x = at; x < at + LW / 2; x++) band[y * LW + x] += 18;
    }
    // The local feature: 14 counts brighter on one side of the line, outside
    // the run but inside the scanned latitudes.
    const fy = Math.round(0.3 * LH);
    for (let y = fy - 20; y <= fy + 20; y++) {
      for (let x = at; x < at + 12; x++) band[y * LW + x] += 14;
    }
    const contrastAt = (y: number) => band[y * LW + at + 4] - band[y * LW + at - 4];
    const featureBefore = contrastAt(fy);
    const before = findEdges(band, LW, LH, spec, LPPD, null).edges
      .filter((e) => e.axis === 'meridian' && Math.abs(e.at - at) <= 6);
    expect(before.length).toBeGreaterThan(0);
    const snapshot = Float32Array.from(band);
    levelEdges(band, LW, LH, spec, LPPD, null);
    // Inside the run the step is closed.
    const after = findEdges(band, LW, LH, spec, LPPD, null, before).edges;
    expect(Math.abs(after[0].step)).toBeLessThan(spec.minStep);
    // Beyond the run the correction steps across the column by nothing: the
    // feature keeps its own contrast, and the scanned rows above the run gain
    // no ledge along the line. With the jump laid along the whole column the
    // feature lost two thirds of its contrast and the ledge ran to five counts.
    expect(Math.abs(contrastAt(fy) - featureBefore)).toBeLessThan(1);
    let ledge = 0;
    let rows = 0;
    for (let y = Math.round(LH / 4) + 4; y < top - 4; y++) {
      const d = (band[y * LW + at + 4] - snapshot[y * LW + at + 4]) - (band[y * LW + at - 4] - snapshot[y * LW + at - 4]);
      ledge += Math.abs(d);
      rows++;
    }
    expect(ledge / rows).toBeLessThan(1);
  });

  it('leaves a slow gradient alone', () => {
    // A step is what the ground does ON TOP of the slope it already has. A
    // body's own albedo runs from bright to dark over tens of degrees, and
    // flattening a stretch of that would put a ledge where there was none.
    const { band } = synthetic([], { midAmp: 0, sharpGain: 1 });
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) band[y * W + x] += 40 * Math.sin((2 * Math.PI * x) / W);
    }
    const { edges } = findEdges(band, W, H, spec, PX_PER_DEG, null);
    expect(edges.filter((e) => e.axis === 'meridian').length).toBe(0);
  });
});

describe('valueNoise', () => {
  it('meets itself at the map edge when the cell is told how many fit', () => {
    const noise = valueNoise(W);
    const octave = { ...wrappingCell(W, 13), amp: 100 };
    const grain = noise.matched([octave], 3);
    for (const y of [0, 137, 511]) expect(grain(W, y)).toBeCloseTo(grain(0, y), 9);
  });

  it('has the spread its amplitude says it has', () => {
    // The fill's whole claim is that it carries the amount of variation it
    // measured, and that claim is this constant.
    const noise = valueNoise(W);
    const grain = noise.matched([{ ...wrappingCell(W, 8), amp: 4.63 }], 5);
    let sum = 0;
    let sq = 0;
    let n = 0;
    for (let y = 0; y < 200; y++) {
      for (let x = 0; x < W; x++) { const v = grain(x, y); sum += v; sq += v * v; n++; }
    }
    const std = Math.sqrt(sq / n - (sum / n) ** 2);
    expect(std).toBeGreaterThan(0.95);
    expect(std).toBeLessThan(1.05);
  });
});
