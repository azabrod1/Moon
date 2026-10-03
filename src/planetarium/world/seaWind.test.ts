import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  COX_MUNK_SLOPE_CALM, COX_MUNK_SLOPE_PER_MS, SEA_CALM_LOBE_ROUGHNESS, SEA_CALM_LOBE_WIND_MS, SEA_WIND_MAX_MS,
  disposeRetiredSeaWindMaps,
  installSeaWindMap, meanSquareSlope, parseSeaWindMapParam, parseSeaWindParam, seaWindBytesFromRgba,
  seaWindBytesFromWindMap, seaWindMapDimensions, seaWindMapSource, seaWindTextureFrom, seaWindTextures,
  seaWindTexturesFrom, setSeaWindMips, slopeRoughness, windRoughness,
} from './seaWind';
import { ROUGHNESS_MAP_LAND, ROUGHNESS_MAP_WATER } from './surfaceShading';
import { PLANET_TEXTURE_FILES } from './textureLadder';
import {
  COX_MUNK_SLOPE_CALM as GENERATOR_SLOPE_CALM, COX_MUNK_SLOPE_PER_MS as GENERATOR_SLOPE_PER_MS,
  SEA_WIND_MAX_MS as GENERATOR_WIND_MAX_MS, DEFAULTS, bandStatistics, buildField, calmWeightForWind,
  encodeCalmGrey, encodeSeaWindRgb, encodeWindyGrey, meanSquareSlope as generatorMeanSquareSlope, pointEvaluator,
} from '../../../tools/seaWindField.mjs';

describe('windRoughness', () => {
  it('is Cox-Munk\'s slope law as the roughness three squares into alpha, and lands the map\'s own water value at the mean sea', () => {
    expect(windRoughness(0)).toBeCloseTo(Math.pow(COX_MUNK_SLOPE_CALM, 0.25), 12);
    expect(meanSquareSlope(7)).toBeCloseTo(COX_MUNK_SLOPE_CALM + 7 * COX_MUNK_SLOPE_PER_MS, 12);
    // The roughness map grades open water at 0.45; that is a 7 m/s sea here,
    // which is about the mean wind over the ocean.
    expect(windRoughness(7.4)).toBeCloseTo(ROUGHNESS_MAP_WATER, 2);
    // Alpha squared is the mean-square slope: with the Beckmann lobe the
    // shader draws, the law is exact.
    expect(Math.pow(windRoughness(5), 4)).toBeCloseTo(meanSquareSlope(5), 12);
    expect(slopeRoughness(meanSquareSlope(5))).toBeCloseTo(windRoughness(5), 12);
    // A glassy patch is drawn narrow, a gale wide, and nothing in between goes
    // the other way.
    expect(windRoughness(SEA_CALM_LOBE_WIND_MS)).toBeLessThan(0.3);
    expect(windRoughness(SEA_WIND_MAX_MS)).toBeGreaterThan(0.5);
    let last = 0;
    for (let wind = 0; wind <= SEA_WIND_MAX_MS; wind += 0.25) {
      expect(windRoughness(wind)).toBeGreaterThan(last);
      last = windRoughness(wind);
    }
    // A negative wind is no wind.
    expect(windRoughness(-3)).toBe(windRoughness(0));
    expect(COX_MUNK_SLOPE_PER_MS).toBe(0.00512);
    expect(ROUGHNESS_MAP_LAND).toBeGreaterThan(windRoughness(SEA_WIND_MAX_MS));
  });

  it('holds the calm lobe where the generator measured the calm weight', () => {
    // A weight of one means "this calm": the shader's lobe and the bake's
    // reference are one number, or a weight would draw a sea the design did
    // not put there.
    expect(SEA_CALM_LOBE_WIND_MS).toBe(DEFAULTS.calmReferenceWindMs);
    expect(SEA_CALM_LOBE_ROUGHNESS).toBeCloseTo(windRoughness(SEA_CALM_LOBE_WIND_MS), 12);
    expect(Math.pow(SEA_CALM_LOBE_ROUGHNESS, 4)).toBeCloseTo(0.00607, 5);
    // And the slope law is one law in the three places that carry it.
    expect(GENERATOR_SLOPE_CALM).toBe(COX_MUNK_SLOPE_CALM);
    expect(GENERATOR_SLOPE_PER_MS).toBe(COX_MUNK_SLOPE_PER_MS);
    expect(GENERATOR_WIND_MAX_MS).toBe(SEA_WIND_MAX_MS);
    expect(generatorMeanSquareSlope(3)).toBeCloseTo(meanSquareSlope(3), 12);
  });
});

describe('the bytes of the maps', () => {
  it('reads a picture of both maps north-up into row 0 south, red the calm weight and green the windy speed', () => {
    // A 2x2 picture: the top row is the north.
    const rgba = new Uint8Array([
      10, 20, 0, 255, 11, 21, 0, 255, // picture row 0 (north)
      30, 40, 0, 255, 31, 41, 0, 255, // picture row 1 (south)
    ]);
    const map = seaWindBytesFromRgba(rgba, 2, 2);
    expect(map.width).toBe(2);
    expect(map.height).toBe(2);
    expect(map.windyWidth).toBe(2);
    expect(Array.from(map.calm)).toEqual([30, 31, 10, 11]);
    expect(Array.from(map.windy)).toEqual([40, 41, 20, 21]);
  });

  it('turns a raw map of one wind a texel into the mixture: calmer than the lobe is all calm, the rest is the windy lobe at its wind', () => {
    const calmByte = Math.round((SEA_CALM_LOBE_WIND_MS / SEA_WIND_MAX_MS) * 255);
    const map = seaWindBytesFromWindMap(new Uint8Array([0, calmByte - 1, calmByte, 112, 255]), 5, 1);
    expect(Array.from(map.calm)).toEqual([255, 255, 0, 0, 0]);
    expect(Array.from(map.windy)).toEqual([calmByte, calmByte, calmByte, 112, 255]);
    expect(map.windyWidth).toBe(5);
    expect(map.windyHeight).toBe(1);
  });

  it('reads a raw map\'s shape off its size', () => {
    expect(seaWindMapDimensions(2048 * 1024)).toEqual({ width: 2048, height: 1024 });
    expect(seaWindMapDimensions(1440 * 720)).toEqual({ width: 1440, height: 720 });
    expect(seaWindMapDimensions(1024 * 512)).toEqual({ width: 1024, height: 512 });
    expect(seaWindMapDimensions(1000)).toBeNull();
    expect(seaWindMapDimensions(2048 * 1024 + 1)).toBeNull();
    expect(seaWindMapDimensions(0)).toBeNull();
  });
});

describe('the textures', () => {
  it('are one channel, wrapped around the date line, clamped at the poles, mip-chained, and read as data', () => {
    const tex = seaWindTextureFrom(new Uint8Array([1, 2, 3, 4]), 4, 1);
    expect(tex.format).toBe(THREE.RedFormat);
    expect(tex.type).toBe(THREE.UnsignedByteType);
    expect(tex.wrapS).toBe(THREE.RepeatWrapping);
    expect(tex.wrapT).toBe(THREE.ClampToEdgeWrapping);
    expect(tex.generateMipmaps).toBe(true);
    expect(tex.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    expect(tex.colorSpace).toBe(THREE.NoColorSpace);
    expect(tex.unpackAlignment).toBe(1);
    expect(tex.image.width).toBe(4);
    // The DEV mip switch: the next texture built samples its full resolution
    // from any distance.
    setSeaWindMips(false);
    const flat = seaWindTextureFrom(new Uint8Array([1, 2]), 2, 1);
    expect(flat.generateMipmaps).toBe(false);
    expect(flat.minFilter).toBe(THREE.LinearFilter);
    setSeaWindMips(true);
    // A pair from bytes keeps each map's own size.
    const pair = seaWindTexturesFrom({
      calm: new Uint8Array(8), width: 4, height: 2, windy: new Uint8Array(2), windyWidth: 2, windyHeight: 1,
    });
    expect(pair.calm.image.width).toBe(4);
    expect(pair.windy.image.width).toBe(2);
    expect(pair.windy.generateMipmaps).toBe(true);
  });

  it('are installed one at a time, the sea reading them once both are here, and an override refuses the shipped pair', () => {
    expect(seaWindTextures().calm).toBeNull();
    expect(seaWindMapSource()).toBe('none');
    const first = seaWindTexturesFrom({
      calm: new Uint8Array(2), width: 2, height: 1, windy: new Uint8Array(2), windyWidth: 2, windyHeight: 1,
    });
    expect(installSeaWindMap('calm', first.calm, 'shipped')).toBe(first.calm);
    expect(seaWindMapSource()).toBe('none');
    expect(installSeaWindMap('windy', first.windy, 'shipped')).toBe(first.windy);
    expect(seaWindMapSource()).toBe('shipped');
    expect(seaWindTextures().calm).toBe(first.calm);
    expect(seaWindTextures().windy).toBe(first.windy);
    // A replacement of one kind retires the one it replaces, disposed once
    // the sea has been rebound to the new one (rebindSeaWindMaps calls this):
    // disposed while still bound, three would re-upload it from a bitmap its
    // dispose listener had closed.
    let disposed = 0;
    first.calm.addEventListener('dispose', () => { disposed++; });
    const second = seaWindTextureFrom(new Uint8Array(2), 2, 1);
    expect(installSeaWindMap('calm', second, 'shipped')).toBe(second);
    expect(disposed).toBe(0);
    disposeRetiredSeaWindMaps();
    expect(disposed).toBe(1);
    disposeRetiredSeaWindMaps();
    expect(disposed).toBe(1);
    expect(seaWindTextures().calm).toBe(second);
    // Asking for a map from a file refuses the shipped pair from then on,
    // whichever lands first — a sheet captured through the override never
    // shows the shipped maps under it.
    expect(parseSeaWindMapParam('')).toBeNull();
    expect(parseSeaWindMapParam('?seawindmap=')).toBeNull();
    expect(parseSeaWindMapParam('?seawind=0&seawindmap=/planning/field.png')).toBe('/planning/field.png');
    const late = seaWindTextureFrom(new Uint8Array(2), 2, 1);
    expect(installSeaWindMap('calm', late, 'shipped')).toBeNull();
    expect(seaWindTextures().calm).toBe(second);
    const override = seaWindTexturesFrom({
      calm: new Uint8Array(2), width: 2, height: 1, windy: new Uint8Array(2), windyWidth: 2, windyHeight: 1,
    });
    expect(installSeaWindMap('calm', override.calm, '/planning/field.png')).toBe(override.calm);
    expect(installSeaWindMap('windy', override.windy, '/planning/field.png')).toBe(override.windy);
    expect(seaWindMapSource()).toBe('/planning/field.png');
  });
});

describe('parseSeaWindParam', () => {
  it('is on unless the link says 0', () => {
    expect(parseSeaWindParam('')).toBe(true);
    expect(parseSeaWindParam('?seawind=1')).toBe(true);
    expect(parseSeaWindParam('?glint=0.2')).toBe(true);
    expect(parseSeaWindParam('?seawind=0')).toBe(false);
  });
});

describe('the generator (tools/seaWindField.mjs)', () => {
  const field = pointEvaluator();

  it('is exactly periodic in longitude, at every point, the equatorial blend band included', () => {
    let state = 777;
    const random = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    for (let sample = 0; sample < 600; sample++) {
      // A third of the samples inside the band where the two tilts blend.
      const lat = sample < 200 ? random() * 8 - 4 : random() * 140 - 70;
      const lon = random() * 360 - 180;
      const here = field(lon, lat);
      const roundOnce = field(lon + 360, lat);
      const roundTwiceBack = field(lon - 720, lat);
      expect(roundOnce.windMs).toBeCloseTo(here.windMs, 9);
      expect(roundOnce.calmWeight).toBeCloseTo(here.calmWeight, 9);
      expect(roundOnce.windyMs).toBeCloseTo(here.windyMs, 9);
      expect(roundTwiceBack.windMs).toBeCloseTo(here.windMs, 9);
    }
    // And the slope across the date line is a slope, not a crease: the
    // one-sided differences at the seam disagree by the field's own
    // curvature, which halves with the step, where a crease would hold.
    const mismatch = (lat: number, step: number): number => Math.abs(
      ((field(180, lat).windMs - field(180 - step, lat).windMs)
        - (field(180 + step, lat).windMs - field(180, lat).windMs)) / step,
    );
    for (const lat of [-45, -20, -2, 0, 2, 10, 20, 45]) {
      const coarse = mismatch(lat, 0.01);
      const fine = mismatch(lat, 0.0025);
      expect(fine).toBeLessThan(coarse * 0.3 + 1e-6);
    }
  });

  it('converts a calm sea into the weight that keeps the glint\'s peak, one for calmer than the lobe and zero at the wind', () => {
    expect(calmWeightForWind(0.3, 7, 0.6)).toBe(1);
    expect(calmWeightForWind(0.6, 7, 0.6)).toBeCloseTo(1, 12);
    expect(calmWeightForWind(7, 7, 0.6)).toBe(0);
    expect(calmWeightForWind(2, 2, 0.6)).toBe(0);
    const weight = calmWeightForWind(1.5, 7, 0.6);
    expect(weight).toBeGreaterThan(0.4);
    expect(weight).toBeLessThan(0.6);
    // The peak identity: the mixture's brightness at the centre of the glint
    // is the single lobe's, since a lobe's peak goes as 1 / mss.
    const peak = (wind: number): number => 1 / generatorMeanSquareSlope(wind);
    expect(weight * peak(0.6) + (1 - weight) * peak(7)).toBeCloseTo(peak(1.5), 9);
    let last = 1;
    for (let wind = 0.6; wind <= 7; wind += 0.2) {
      const next = calmWeightForWind(wind, 7, 0.6);
      expect(next).toBeLessThanOrEqual(last + 1e-12);
      last = next;
    }
  });

  it('is the field it was: a few points pinned, so a drift in the arithmetic is a deliberate re-bake', () => {
    // Move these only with `npm run gen:seawind` and the shipped hashes below.
    const pins: Array<[number, number, number, number, number]> = [
      [-160, -12, 3.305083, 0, 3.305083],
      [30, 0, 1.331001, 0.442952, 3.173800],
      [120, 25, 1.098598, 0.635078, 5.691913],
      [-45, -40, 7.210969, 0, 7.210969],
      [0, 60, 12.334111, 0, 12.334111],
      [90, -55, 9.641751, 0, 9.641751],
    ];
    for (const [lon, lat, wind, calm, windy] of pins) {
      const point = field(lon, lat);
      expect(point.windMs).toBeCloseTo(wind, 5);
      expect(point.calmWeight).toBeCloseTo(calm, 5);
      expect(point.windyMs).toBeCloseTo(windy, 5);
    }
  });

  it('keeps the calm share across the equator, where the two tilts blend', () => {
    // A blend of two noises has less spread than either, so a mask of the
    // blended noise under-delivered the table's share by a sixth in the band;
    // the masks are blended instead. The control is one orientation with no
    // blend at all (tilt 0), on the same 7200 points of the equator.
    const blended = pointEvaluator();
    const control = pointEvaluator({ tilt: 0 });
    const meanCalm = (field: (lon: number, lat: number) => { calmWeight: number }, lat: number): number => {
      let sum = 0;
      for (let i = 0; i < 7200; i++) sum += field(-180 + (360 * i) / 7200, lat).calmWeight;
      return sum / 7200;
    };
    for (const lat of [0, 2]) {
      expect(meanCalm(blended, lat)).toBeGreaterThan(meanCalm(control, lat) * 0.9);
      expect(meanCalm(blended, lat)).toBeLessThan(meanCalm(control, lat) * 1.3);
    }
  });

  it('blows at the climatology by band, calmest and most often glassy in the tropics, and never glassy in the Southern Ocean', () => {
    // A small bake, one point a texel: the statistics are the design's.
    const small = buildField(256, 128, { supersample: 1 });
    expect(small.calmWeight).toHaveLength(256 * 128);
    expect(small.windyWidth).toBe(128);
    expect(small.windyMs).toHaveLength(128 * 64);
    const tropics = bandStatistics(small, 0, 15);
    const trades = bandStatistics(small, 15, 30);
    const westerlies = bandStatistics(small, 30, 45);
    const roaring = bandStatistics(small, 45, 60);
    expect(tropics.meanWindMs).toBeGreaterThan(3.5);
    expect(tropics.meanWindMs).toBeLessThan(5);
    expect(tropics.meanWindMs).toBeLessThan(trades.meanWindMs);
    expect(trades.meanWindMs).toBeLessThan(westerlies.meanWindMs);
    expect(westerlies.meanWindMs).toBeLessThan(roaring.meanWindMs);
    expect(roaring.meanWindMs).toBeGreaterThan(9);
    expect(tropics.meanCalmWeight).toBeGreaterThan(trades.meanCalmWeight);
    expect(trades.meanCalmWeight).toBeGreaterThan(westerlies.meanCalmWeight);
    expect(westerlies.meanCalmWeight).toBeGreaterThan(roaring.meanCalmWeight);
    expect(roaring.meanCalmWeight).toBeLessThan(0.03);
    expect(tropics.under2Fraction).toBeGreaterThan(0.15);
    expect(tropics.under2Fraction).toBeLessThan(0.35);
    // The windy map is the open sea: never a lane's wind.
    let windyMin = Infinity;
    for (const wind of small.windyMs) windyMin = Math.min(windyMin, wind);
    expect(windyMin).toBeGreaterThan(0.09);
    // Every byte of the encodings is a texel: grey, north-up, three a texel.
    const calm = encodeCalmGrey(small);
    expect(calm).toHaveLength(256 * 128 * 3);
    expect(calm[0]).toBe(calm[1]);
    expect(calm[1]).toBe(calm[2]);
    const windy = encodeWindyGrey(small);
    expect(windy).toHaveLength(128 * 64 * 3);
    // Both grey pictures are north-up too: their first row is the field's
    // last, which a hash pin moved on a re-bake could not tell from a map
    // upside down.
    expect(calm[0]).toBe(Math.round(Math.min(1, Math.max(0, small.calmWeight[127 * 256])) * 255));
    expect(windy[0]).toBe(Math.round(Math.min(1, Math.max(0, small.windyMs[63 * 128] / SEA_WIND_MAX_MS)) * 255));
    expect(calm[calm.length - 3]).toBe(Math.round(Math.min(1, Math.max(0, small.calmWeight[255])) * 255));
    const both = encodeSeaWindRgb(small);
    expect(both).toHaveLength(256 * 128 * 3);
    // The picture's top row is the map's last row, the north.
    expect(both[0]).toBe(Math.round(Math.min(1, Math.max(0, small.calmWeight[127 * 256])) * 255));
    expect(both[2]).toBe(0);
  });

  it('mixes exactly where it matters: a block\'s mixture keeps the glint\'s peak, which a block\'s mean wind loses', () => {
    // The reason for two maps. Over 2-degree blocks of 16x16 points at the
    // shipped texel scale, the brightness at the centre of the glint from
    // the block-averaged calm weight and windy speed against the mean over
    // the points of the single-wind design, beside the same from the mean
    // wind alone. A lobe's brightness at a facet tilt goes as
    // exp(-tan²/mss) / mss; the common factors cancel in a ratio.
    const lobe = (mss: number, tiltDeg: number): number => {
      const tan = Math.tan((tiltDeg * Math.PI) / 180);
      return Math.exp((-tan * tan) / mss) / mss;
    };
    const referenceMss = generatorMeanSquareSlope(DEFAULTS.calmReferenceWindMs);
    let state = 99;
    const random = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    const errors: Record<number, { mixture: number[]; averaged: number[] }> = { 0: { mixture: [], averaged: [] }, 5: { mixture: [], averaged: [] }, 10: { mixture: [], averaged: [] } };
    let blocks = 0;
    while (blocks < 60) {
      const lon0 = random() * 360 - 180;
      const lat0 = random() * 50 - 25;
      const points = [];
      for (let row = 0; row < 16; row++) {
        for (let column = 0; column < 16; column++) points.push(field(lon0 + (column + 0.5) / 8, lat0 + (row + 0.5) / 8));
      }
      const calmMean = points.reduce((sum, point) => sum + point.calmWeight, 0) / points.length;
      if (calmMean < 0.05) continue; // a block with no calm in it mixes nothing
      blocks++;
      const windyWeight = points.reduce((sum, point) => sum + 1 - point.calmWeight, 0);
      const windyMean = points.reduce((sum, point) => sum + (1 - point.calmWeight) * point.windyMs, 0) / Math.max(windyWeight, 1e-9);
      const windMean = points.reduce((sum, point) => sum + point.windMs, 0) / points.length;
      for (const tilt of [0, 5, 10]) {
        const reference = points.reduce((sum, point) => sum + lobe(generatorMeanSquareSlope(point.windMs), tilt), 0) / points.length;
        const mixture = calmMean * lobe(referenceMss, tilt) + (1 - calmMean) * lobe(generatorMeanSquareSlope(windyMean), tilt);
        const averaged = lobe(generatorMeanSquareSlope(windMean), tilt);
        errors[tilt].mixture.push(Math.abs(mixture / reference - 1));
        errors[tilt].averaged.push(Math.abs(averaged / reference - 1));
      }
    }
    const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
    // At the centre the mixture is within a few percent and the mean wind a
    // fifth low, which is the dim wash the first map drew.
    expect(mean(errors[0].mixture)).toBeLessThan(0.08);
    expect(mean(errors[0].averaged)).toBeGreaterThan(0.15);
    expect(mean(errors[0].averaged)).toBeGreaterThan(mean(errors[0].mixture) * 3);
    // Off the centre both are approximations of the same order; the
    // mixture's is bounded.
    expect(mean(errors[5].mixture)).toBeLessThan(0.12);
    expect(mean(errors[10].mixture)).toBeLessThan(0.12);
  });

  it('ships the pair the generator bakes, under the names the boot loads and warms', () => {
    // The hashes move only with `npm run gen:seawind`. A re-bake keeps the
    // pathname: the worker keys the file by its content, and the `.v1` is
    // for a break in what the bytes MEAN, not a new look.
    expect(PLANET_TEXTURE_FILES.earthSeaCalm).toBe('earth-seawind-calm.v1.webp');
    expect(PLANET_TEXTURE_FILES.earthSeaWindy).toBe('earth-seawind-windy.v1.webp');
    const hashOf = (file: string): string =>
      createHash('sha256').update(readFileSync(`public/textures/${file}`)).digest('hex');
    expect(hashOf(PLANET_TEXTURE_FILES.earthSeaCalm))
      .toBe('a0f814051033fc5c6829d359465b2cb839e20282debb999babb791c2482a8e61');
    expect(hashOf(PLANET_TEXTURE_FILES.earthSeaWindy))
      .toBe('383f23550b9992f0e7b1c8a9d7cee2b9dc78be743e8e1b56bc49f940c5a6dd20');
    // Lossless webp, the container the loader decodes as a picture: RIFF,
    // WEBP, VP8L.
    const calmBytes = readFileSync(`public/textures/${PLANET_TEXTURE_FILES.earthSeaCalm}`);
    expect(calmBytes.toString('ascii', 0, 4)).toBe('RIFF');
    expect(calmBytes.toString('ascii', 8, 12)).toBe('WEBP');
    expect(calmBytes.toString('ascii', 12, 16)).toBe('VP8L');
    // And the shipped DEFAULTS are what those hashes were baked from.
    expect(DEFAULTS.supersample).toBe(2);
    expect(DEFAULTS.windyDownsample).toBe(2);
    expect(DEFAULTS.grain).toBe(0);
    expect(DEFAULTS.regionGust).toBe(0.5);
    expect(DEFAULTS.laneEdge).toBe(0.12);
  });
});
