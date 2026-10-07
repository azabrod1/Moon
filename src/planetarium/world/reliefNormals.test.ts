import { describe, expect, it } from 'vitest';
import {
  INV_COS_LAT_CLAMP,
  SHIPPED_RELIEF_EXAGGERATION,
  areaResampleHeights,
  encodeReliefNormals,
  equatorTexelKm,
  shippedStrengthAsExaggeration,
} from './reliefNormals';

const MOON_RADIUS_KM = 1737.4;

/** The slope a written normal encodes: tan of its tilt along x and y. */
function decodedSlopes(bytes: Uint8Array, index: number): { dzdx: number; dzdy: number } {
  const nx = bytes[index * 3] / 255 * 2 - 1;
  const ny = bytes[index * 3 + 1] / 255 * 2 - 1;
  const nz = bytes[index * 3 + 2] / 255 * 2 - 1;
  return { dzdx: -nx / nz, dzdy: ny / nz };
}

describe('shippedStrengthAsExaggeration', () => {
  it('reads the two shipped Moon tiers as the same 1.39x, which is what the constant records', () => {
    const boot = shippedStrengthAsExaggeration(3.0, 1440, MOON_RADIUS_KM);
    const close = shippedStrengthAsExaggeration(6.0, 2880, MOON_RADIUS_KM);
    expect(boot).toBeCloseTo(close, 6);
    expect(close).toBeCloseTo(SHIPPED_RELIEF_EXAGGERATION, 2);
  });
});

describe('encodeReliefNormals', () => {
  // A byte of normal is 1/127.5 of a unit, so a slope under ~0.008 is below
  // the map's own resolution: the fixtures use a body whose texels are 1 km
  // (radius = width / 2π) and fields with km of relief, so every slope under
  // test is tens of steps above that floor.
  const radiusForUnitTexel = (width: number) => width / (2 * Math.PI);

  it('encodes the physical slope of a known field at the equator, exaggeration 1', () => {
    const width = 720;
    const height = 360;
    const bodyRadiusKm = radiusForUnitTexel(width);
    const amplitudeKm = 40;
    const heights = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) heights[y * width + x] = amplitudeKm * Math.sin((2 * Math.PI * x) / width);
    }
    const out = encodeReliefNormals(heights, width, height, { bodyRadiusKm, exaggeration: 1 });
    const texelKm = equatorTexelKm(width, bodyRadiusKm);
    expect(texelKm).toBeCloseTo(1, 9);
    const row = height / 2; // just south of the equator: cos(lat) ≈ 1
    for (const x of [0, 90, 180, 450, 719]) {
      const east = amplitudeKm * Math.sin((2 * Math.PI * ((x + 1) % width)) / width);
      const west = amplitudeKm * Math.sin((2 * Math.PI * ((x - 1 + width) % width)) / width);
      const expected = (east - west) / (2 * texelKm);
      const { dzdx, dzdy } = decodedSlopes(out, row * width + x);
      expect(Math.abs(dzdx - expected)).toBeLessThan(0.02);
      expect(Math.abs(dzdy)).toBeLessThan(0.02);
    }
    for (let i = 2; i < out.length; i += 3) expect(out[i]).toBeGreaterThanOrEqual(128);
  });

  it('wraps longitude at the seam and clamps latitude at the poles', () => {
    const width = 64;
    const height = 32;
    const bodyRadiusKm = radiusForUnitTexel(width);
    const heights = new Float32Array(width * height);
    for (let y = 0; y < height; y++) heights[y * width + width - 1] = 1; // the last column 1 km high
    const out = encodeReliefNormals(heights, width, height, { bodyRadiusKm, exaggeration: 1 });
    const row = height / 2;
    // Column 0 sees its west neighbour, column 63, high: −1 km over two texels.
    expect(Math.abs(decodedSlopes(out, row * width).dzdx - -0.5)).toBeLessThan(0.02);
    // Column 62 sees its east neighbour high.
    expect(Math.abs(decodedSlopes(out, row * width + 62).dzdx - 0.5)).toBeLessThan(0.02);
    // The pole rows clamp: a field high only in the bottom row does not leak into the top row.
    const south = new Float32Array(width * height);
    for (let x = 0; x < width; x++) south[(height - 1) * width + x] = 5;
    const clamped = encodeReliefNormals(south, width, height, { bodyRadiusKm, exaggeration: 1 });
    expect(Math.abs(decodedSlopes(clamped, 0).dzdy)).toBeLessThan(0.02);
    // Row height−2 sees the high row to its south: +5 km over two texels.
    expect(Math.abs(decodedSlopes(clamped, (height - 2) * width + 3).dzdy - 2.5)).toBeLessThan(0.05);
  });

  it('scales the longitude slope by 1/cos(latitude), clamped near the poles, and applies the exaggeration', () => {
    const width = 360;
    const height = 180;
    const bodyRadiusKm = radiusForUnitTexel(width);
    const heights = new Float32Array(width * height);
    // A ramp rising 0.3 km a texel eastward, everywhere.
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) heights[y * width + x] = 0.3 * x;
    const ramp = encodeReliefNormals(heights, width, height, { bodyRadiusKm, exaggeration: 1 });
    const doubled = encodeReliefNormals(heights, width, height, { bodyRadiusKm, exaggeration: 2 });
    const equator = decodedSlopes(ramp, 90 * width + 100).dzdx;
    expect(Math.abs(equator - 0.3)).toBeLessThan(0.02);
    const lat = (0.5 - (30 + 0.5) / height) * Math.PI; // row 30, ~59.5° north
    expect(Math.abs(decodedSlopes(ramp, 30 * width + 100).dzdx - 0.3 / Math.cos(lat))).toBeLessThan(0.04);
    // The top row's cos is tiny; the factor stops at the clamp.
    expect(Math.abs(decodedSlopes(ramp, 100).dzdx - 0.3 * INV_COS_LAT_CLAMP)).toBeLessThan(0.1);
    expect(Math.abs(decodedSlopes(doubled, 90 * width + 100).dzdx - 0.6)).toBeLessThan(0.03);
  });

  it('refuses a grid or an output buffer of the wrong size', () => {
    expect(() => encodeReliefNormals(new Float32Array(10), 4, 2, { bodyRadiusKm: 1, exaggeration: 1 })).toThrow();
    expect(() => encodeReliefNormals(new Float32Array(8), 4, 2, { bodyRadiusKm: 1, exaggeration: 1 }, new Uint8Array(5))).toThrow();
  });
});

describe('areaResampleHeights', () => {
  it('keeps a constant field constant and scales units on the way', () => {
    const src = new Uint16Array(23 * 11).fill(2000); // half-metres: 1 km
    const out = areaResampleHeights(src, 23, 11, 8, 4, 0.0005);
    for (const v of out) expect(v).toBeCloseTo(1, 6);
  });

  it('is the plain mean at an integer ratio', () => {
    const src = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]); // 4×4
    const out = areaResampleHeights(src, 4, 4, 2, 2);
    expect(Array.from(out)).toEqual([3.5, 5.5, 11.5, 13.5]);
  });

  it('reproduces a linear ramp at a fractional ratio, every output cell the mean of what it covers', () => {
    const sw = 23;
    const src = new Float32Array(sw);
    for (let x = 0; x < sw; x++) src[x] = x;
    const dw = 8;
    const out = areaResampleHeights(src, sw, 1, dw, 1);
    const ratio = sw / dw;
    for (let i = 0; i < dw; i++) {
      // The mean of x over [i·ratio, (i+1)·ratio) of unit cells each valued at its index.
      const start = i * ratio;
      const end = (i + 1) * ratio;
      let sum = 0;
      for (let k = Math.floor(start); k < Math.ceil(end); k++) sum += k * (Math.min(end, k + 1) - Math.max(start, k));
      expect(out[i]).toBeCloseTo(sum / ratio, 5);
    }
  });
});
