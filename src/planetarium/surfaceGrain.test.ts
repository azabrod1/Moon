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
// the quarter of a degree that is a ten-pixel blur on Callisto's 42 px per
// degree is 1.8 degrees here and the same ten pixels.

const W = 2048;
const H = 1024;
const PX_PER_DEG = W / 360;
const SPEC = { blurDeg: 1.8, windowDeg: 8, wideDeg: 10, refPercentile: 0.6 };
const PATCH = { x0: W - 200, x1: 200, y0: 300, y1: 700 };

/**
 * A grain field over a slow background, with `smeared` rectangles holding the
 * background alone — which is what a coarse patch of a mosaic is.
 *
 * The right third carries half again as much grain, because a map with one
 * uniform amount of detail has no ground the reference percentile can call
 * sharp: on a real mosaic the sharp strips are what the deficit is measured
 * against, and there the ground away from a coarse patch comes out at a
 * deficit of exactly zero and is left exactly alone.
 */
function synthetic(smeared: Array<{ x0: number; x1: number; y0: number; y1: number }>) {
  const noise = valueNoise(W);
  const fine = noise.matched([
    { ...wrappingCell(W, 4), amp: 26 },
    { ...wrappingCell(W, 9), amp: 18 },
  ], 7);
  // Slower than anything the passes look at, so it is the body's own albedo
  // rather than something either of them has an opinion about.
  const slow = noise.matched([{ ...wrappingCell(W, 400), amp: 60 }], 21);
  const band = new Float32Array(W * H);
  const inside = (x: number, y: number) => smeared.some((r) => y >= r.y0 && y < r.y1
    && (r.x0 <= r.x1 ? x >= r.x0 && x < r.x1 : x >= r.x0 || x < r.x1));
  const sharp = (x: number) => x > 0.6 * W && x < 0.95 * W;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      band[y * W + x] = 120 + slow(x, y) + (inside(x, y) ? 0 : fine(x, y) * (sharp(x) ? 1.5 : 1));
    }
  }
  return { band, inside, sharp };
}

/** The detector's own measure: how much the picture varies below `blurDeg`,
 *  averaged over a window. */
function energy(band: Float32Array): Float32Array {
  const r = SPEC.blurDeg * PX_PER_DEG;
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
    expect(at(0)).toBeGreaterThan(0.9);
    expect(at(W - 80)).toBeGreaterThan(0.9);
    expect(at(80)).toBeGreaterThan(0.9);
  });

  it('is exactly zero on the ground that kept its detail', () => {
    expect(at(Math.round(0.8 * W))).toBe(0);
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
    expect(ref).toBeGreaterThan(0.5 * median(outside));
    expect(ref).toBeLessThan(median(outside));
    expect(median(within)).toBeLessThan(0.15 * median(outside));
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
        if (inside(x, y) && fill.deficit[y * W + x] > 0.9) within.push(e[y * W + x]);
      }
    }
    expect(within.length).toBeGreaterThan(1000);
    const ratio = median(within) / fill.ref;
    expect(ratio).toBeGreaterThan(0.85);
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
    const { band } = synthetic([]);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) if (x >= at && x < at + W / 2) band[y * W + x] += offset;
    }
    return band;
  }

  // Only the middle latitudes: this raster's grain is laid out in PIXELS, so
  // toward its poles it is finer on the ground than a real map's would be, and
  // a scan there would be reading the test's own geometry.
  const spec = {
    lookDeg: 3, alongDeg: 6, minStep: 8, minSpanDeg: 20, rampDeg: 20, smoothDeg: 2, rounds: 2, skipLatDeg: 45,
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
      expect(Math.abs(after[k].step)).toBeLessThan(0.25 * Math.abs(before[k].step));
    }
    const now = energy(band);
    const kept: number[] = [];
    for (let i = 0; i < W * H; i += 7) if (detail[i] > 0) kept.push(now[i] / detail[i]);
    expect(median(kept)).toBeGreaterThan(0.97);
  });

  it('leaves a slow gradient alone', () => {
    // A step is what the ground does ON TOP of the slope it already has. A
    // body's own albedo runs from bright to dark over tens of degrees, and
    // flattening a stretch of that would put a ledge where there was none.
    const { band } = synthetic([]);
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
