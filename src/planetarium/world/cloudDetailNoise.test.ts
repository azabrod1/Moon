import { describe, it, expect } from 'vitest';
import {
  buildCloudDetailNoise,
  CLOUD_DETAIL_COARSE_CELLS,
  CLOUD_DETAIL_FINE_LATTICE,
  CLOUD_DETAIL_GRADIENT_SCALE,
  CLOUD_DETAIL_ROTATION,
  CLOUD_DETAIL_ROTATION_DEG,
  CLOUD_DETAIL_SIZE,
  CLOUD_DETAIL_TILES_PER_TURN,
  CLOUD_DETAIL_UV_PER_RADIAN,
} from './cloudDetailNoise';

// A small map: the field is defined by fractions of the tile, so tiling,
// octave content and the gradient are all the same claims at any size, and 128
// keeps the suite fast.
const N = 128;
const built = buildCloudDetailNoise(N);
const at = (x: number, y: number, c: number): number =>
  built.data[((((y % N) + N) % N) * N + (((x % N) + N) % N)) * 4 + c];

describe('the cloud detail map', () => {
  it('tiles seamlessly, rotated octave included', () => {
    // The whole reason the fine octave's rotation is the 3-4-5 one. A rotation
    // that did not take the lattice into itself would leave a discontinuity
    // here, which on the globe is a visible line every thousand kilometres.
    //
    // Seamless means the step across the wrap is no bigger than the steps
    // inside: compare the left/right (and top/bottom) joins against the mean
    // absolute step of the whole field.
    let interior = 0;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N - 1; x++) interior += Math.abs(at(x + 1, y, 0) - at(x, y, 0));
    }
    interior /= N * (N - 1);
    let wrapX = 0;
    let wrapY = 0;
    for (let i = 0; i < N; i++) {
      wrapX += Math.abs(at(0, i, 0) - at(N - 1, i, 0));
      wrapY += Math.abs(at(i, 0, 0) - at(i, N - 1, 0));
    }
    expect(wrapX / N).toBeLessThanOrEqual(interior * 1.5);
    expect(wrapY / N).toBeLessThanOrEqual(interior * 1.5);
    // ...and the gradient channels wrap too, or the relief creases at the join.
    for (const c of [1, 2]) {
      let wrap = 0;
      let inside = 0;
      for (let i = 0; i < N; i++) wrap += Math.abs(at(0, i, c) - at(N - 1, i, c));
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N - 1; x++) inside += Math.abs(at(x + 1, y, c) - at(x, y, c));
      }
      expect(wrap / N).toBeLessThanOrEqual((inside / (N * (N - 1))) * 2);
    }
  });

  it('rotates the fine octave by the one angle near 37 degrees that tiles', () => {
    expect(CLOUD_DETAIL_ROTATION_DEG).toBeCloseTo(36.87, 2);
    // The integer matrix is the claim: [[4, 3], [-3, 4]] has determinant 25 and
    // maps the lattice into itself, which is what makes the rotated octave wrap
    // at all. Any other angle near 37 degrees does not.
    const [a, b] = CLOUD_DETAIL_ROTATION;
    expect(a * a + b * b).toBe(25);
    expect(Number.isInteger(a) && Number.isInteger(b)).toBe(true);
  });

  it('carries two octaves, the fine one five times the lattice it is built on', () => {
    // 32 cells of coarse and 125 of fine — a ratio near four, which is what
    // makes them read as two scales rather than as one blurred field.
    expect(CLOUD_DETAIL_COARSE_CELLS).toBe(32);
    expect(CLOUD_DETAIL_FINE_LATTICE * 5).toBe(125);
  });

  it('keeps every packed gradient inside the byte', () => {
    // A clipped gradient is a flat spot in the relief exactly where the field
    // is steepest — the edges the detail exists for.
    expect(buildCloudDetailNoise(CLOUD_DETAIL_SIZE).clipped).toBe(0);
  });

  it('packs the field\'s own gradient, not a second noise', () => {
    // G and B have to BE the derivative of R, or the relief lights against a
    // shape the erosion is not cutting. Compared against the finite difference
    // of the stored field, in the same units: the encoding is per tile width,
    // and one texel is 1/size of that. At the shipped size, which is the only
    // size where the finite difference means anything — the fine octave is 125
    // cells across the tile, so at 128 texels it sits on the Nyquist limit and
    // a central difference measures aliasing rather than slope.
    const full = buildCloudDetailNoise(CLOUD_DETAIL_SIZE);
    const S = CLOUD_DETAIL_SIZE;
    const px = (x: number, y: number, c: number): number =>
      full.data[((((y % S) + S) % S) * S + (((x % S) + S) % S)) * 4 + c];
    let worstU = 0;
    let worstV = 0;
    let checked = 0;
    for (let y = 0; y < S; y += 37) {
      for (let x = 0; x < S; x += 41) {
        const gu = ((px(x, y, 1) / 255) * 2 - 1) * CLOUD_DETAIL_GRADIENT_SCALE;
        const gv = ((px(x, y, 2) / 255) * 2 - 1) * CLOUD_DETAIL_GRADIENT_SCALE;
        worstU = Math.max(worstU, Math.abs(gu - ((px(x + 1, y, 0) - px(x - 1, y, 0)) / 255) * (S / 2)));
        worstV = Math.max(worstV, Math.abs(gv - ((px(x, y + 1, 0) - px(x, y - 1, 0)) / 255) * (S / 2)));
        checked++;
      }
    }
    // A few percent of the encoding's own range: the difference between an
    // analytic slope and a two-texel secant across a field whose finest cell is
    // eight texels wide, and nothing else.
    expect(worstU).toBeLessThan(CLOUD_DETAIL_GRADIENT_SCALE * 0.1);
    expect(worstV).toBeLessThan(CLOUD_DETAIL_GRADIENT_SCALE * 0.1);
    expect(checked).toBeGreaterThan(500);
  });

  it('is the same map on every device', () => {
    // Seeded from a fixed integer mixer rather than Math.random: the detail is
    // shading, and two players looking at the same cloud must see one cloud.
    const again = buildCloudDetailNoise(N);
    expect(again.data).toEqual(built.data);
  });

  it('lands one tile on a thousand kilometres, at a whole number per turn', () => {
    // ~1 km per texel at the equator is the scale the eye reads as cloud from
    // orbital altitude. The whole number is what keeps the antimeridian seam
    // out of the picture: the longitude the shader builds jumps by a full turn
    // there, which has to be a whole number of tiles.
    expect(CLOUD_DETAIL_TILES_PER_TURN).toBe(40);
    expect(Number.isInteger(CLOUD_DETAIL_UV_PER_RADIAN * 2 * Math.PI)).toBe(true);
    const equatorKm = 40075;
    expect((equatorKm / CLOUD_DETAIL_TILES_PER_TURN) / CLOUD_DETAIL_SIZE).toBeCloseTo(0.98, 2);
  });
});
