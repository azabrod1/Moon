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
  SEA_WIND_MAX_MS as GENERATOR_WIND_MAX_MS, DEFAULTS, bandStatistics, buildField,
  encodeWindGrey, meanSquareSlope as generatorMeanSquareSlope, pointEvaluator,
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

  it('holds the calm lobe where the shipped calm map was measured', () => {
    // A weight of one means "this calm": the calm map the app loads was baked
    // against a reference lobe at 0.6 m/s, so the shader's lobe stays that
    // number while that map is read, or a weight would draw a sea the design
    // did not put there. The generator no longer has a calm reference: its
    // one map is the wind alone.
    expect(SEA_CALM_LOBE_WIND_MS).toBe(0.6);
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
      expect(field(lon + 360, lat)).toBeCloseTo(here, 9);
      expect(field(lon - 720, lat)).toBeCloseTo(here, 9);
    }
    // And the slope across the date line is a slope, not a crease: the
    // one-sided differences at the seam disagree by the field's own
    // curvature, which halves with the step, where a crease would hold.
    const mismatch = (lat: number, step: number): number => Math.abs(
      ((field(180, lat) - field(180 - step, lat))
        - (field(180 + step, lat) - field(180, lat))) / step,
    );
    for (const lat of [-45, -20, -2, 0, 2, 10, 20, 45]) {
      const coarse = mismatch(lat, 0.01);
      const fine = mismatch(lat, 0.0025);
      expect(fine).toBeLessThan(coarse * 0.3 + 1e-6);
    }
  });


  it('is the field it was: a few points pinned, so a drift in the arithmetic is a deliberate re-bake', () => {
    // Move these only with `npm run gen:seawind` and the shipped hash below.
    // They are the open sea's wind the pair before this map carried in its
    // windy map at the same points: removing the calm lanes and regions left
    // the wind under them as it was.
    const pins: Array<[number, number, number]> = [
      [-160, -12, 3.305083],
      [30, 0, 3.173800],
      [120, 25, 5.691913],
      [-45, -40, 7.210969],
      [0, 60, 12.334111],
      [90, -55, 9.641751],
    ];
    for (const [lon, lat, wind] of pins) expect(field(lon, lat)).toBeCloseTo(wind, 5);
  });

  it('blows at the climatology by band, rising from the tropics to the Southern Ocean, and is almost never glassy', () => {
    // A small bake, one point a texel: the statistics are the design's.
    const small = buildField(256, 128, { supersample: 1 });
    expect(small.windMs).toHaveLength(256 * 128);
    const tropics = bandStatistics(small, 0, 15);
    const trades = bandStatistics(small, 15, 30);
    const westerlies = bandStatistics(small, 30, 45);
    const roaring = bandStatistics(small, 45, 60);
    // The zonal table's own mean over |lat| 0-15 is about 5.2 m/s; the broad
    // structure moves a band's mean little.
    expect(tropics.meanWindMs).toBeGreaterThan(4.5);
    expect(tropics.meanWindMs).toBeLessThan(6);
    expect(tropics.meanWindMs).toBeLessThan(trades.meanWindMs);
    expect(trades.meanWindMs).toBeLessThan(westerlies.meanWindMs);
    expect(westerlies.meanWindMs).toBeLessThan(roaring.meanWindMs);
    expect(roaring.meanWindMs).toBeGreaterThan(9);
    // With no calm lanes or regions a glassy sea is the broad structure's
    // rare trough: under a metre a second nearly nowhere, under two over a
    // few percent of the tropics at most, where the lanes put a fifth to a
    // third of it.
    for (const band of [tropics, trades, westerlies, roaring]) expect(band.under1Fraction).toBeLessThan(0.01);
    expect(tropics.under2Fraction).toBeLessThan(0.05);
    // The field is floored at 0.1 m/s.
    let windMin = Infinity;
    for (const wind of small.windMs) windMin = Math.min(windMin, wind);
    expect(windMin).toBeGreaterThan(0.09);
    // Every byte of the encoding is a texel: grey, three a texel, north-up —
    // its first row is the field's last, which a hash pin moved on a re-bake
    // could not tell from a map upside down.
    const grey = encodeWindGrey(small);
    expect(grey).toHaveLength(256 * 128 * 3);
    expect(grey[0]).toBe(grey[1]);
    expect(grey[1]).toBe(grey[2]);
    const byte = (wind: number): number => Math.round(Math.min(1, Math.max(0, wind / SEA_WIND_MAX_MS)) * 255);
    expect(grey[0]).toBe(byte(small.windMs[127 * 256]));
    expect(grey[grey.length - 3]).toBe(byte(small.windMs[255]));
  });

  it('is smooth enough that a block\'s mean wind keeps the glint, which is why a mip of the map is fine', () => {
    // Averaging winds is biased where a block holds very different winds:
    // the glint's brightness at a facet tilt goes as exp(-tan²/mss) / mss,
    // convex in the wind, and over the calm lanes the pair before this map
    // held, a block's mean wind lost a fifth of the peak. This field has
    // nothing finer than its broad cells. Over 2-degree blocks of 16x16
    // points — about six texels of the shipped map, a mip two to three
    // levels down — the
    // brightness from the block's mean wind against the mean of its points'
    // brightnesses, at the centre of the glint and off it.
    const lobe = (mss: number, tiltDeg: number): number => {
      const tan = Math.tan((tiltDeg * Math.PI) / 180);
      return Math.exp((-tan * tan) / mss) / mss;
    };
    let state = 99;
    const random = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    const errors: Record<number, number[]> = { 0: [], 5: [], 10: [] };
    for (let block = 0; block < 60; block++) {
      const lon0 = random() * 360 - 180;
      const lat0 = random() * 120 - 60;
      const winds: number[] = [];
      for (let row = 0; row < 16; row++) {
        for (let column = 0; column < 16; column++) winds.push(field(lon0 + (column + 0.5) / 8, lat0 + (row + 0.5) / 8));
      }
      const windMean = winds.reduce((sum, wind) => sum + wind, 0) / winds.length;
      for (const tilt of [0, 5, 10]) {
        const reference = winds.reduce((sum, wind) => sum + lobe(generatorMeanSquareSlope(wind), tilt), 0) / winds.length;
        errors[tilt].push(Math.abs(lobe(generatorMeanSquareSlope(windMean), tilt) / reference - 1));
      }
    }
    const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
    // Within a few percent on average, at the centre and off it, and no
    // block off by a tenth.
    for (const tilt of [0, 5, 10]) {
      expect(mean(errors[tilt])).toBeLessThan(0.03);
      expect(Math.max(...errors[tilt])).toBeLessThan(0.1);
    }
  });

  it('ships the map the generator bakes, and the pair the app reads until the shader draws one lobe', () => {
    // The hash moves only with `npm run gen:seawind`, and a re-bake whose
    // bytes differ ships under a new name, as every data file the service
    // worker caches does.
    const hashOf = (file: string): string =>
      createHash('sha256').update(readFileSync(`public/textures/${file}`)).digest('hex');
    expect(hashOf('earth-seawind.v1.webp'))
      .toBe('fa489ef7320ee3cdb24f54f73db6d4716d4fbd06812f1817f8f7c682026bc9d6');
    // Lossless webp, the container the loader decodes as a picture: RIFF,
    // WEBP, VP8L.
    const mapBytes = readFileSync('public/textures/earth-seawind.v1.webp');
    expect(mapBytes.toString('ascii', 0, 4)).toBe('RIFF');
    expect(mapBytes.toString('ascii', 8, 12)).toBe('WEBP');
    expect(mapBytes.toString('ascii', 12, 16)).toBe('VP8L');
    // And the shipped DEFAULTS are what that hash was baked from.
    expect(DEFAULTS.supersample).toBe(4);
    expect(DEFAULTS.grain).toBe(0);
    expect(DEFAULTS.broadSpread).toBe(0.45);
    // The pair the boot loads and warms today, baked by this generator
    // before it lost the calm lanes and regions; pinned until the app reads
    // the one map instead.
    expect(PLANET_TEXTURE_FILES.earthSeaCalm).toBe('earth-seawind-calm.v1.webp');
    expect(PLANET_TEXTURE_FILES.earthSeaWindy).toBe('earth-seawind-windy.v1.webp');
    expect(hashOf(PLANET_TEXTURE_FILES.earthSeaCalm))
      .toBe('a0f814051033fc5c6829d359465b2cb839e20282debb999babb791c2482a8e61');
    expect(hashOf(PLANET_TEXTURE_FILES.earthSeaWindy))
      .toBe('383f23550b9992f0e7b1c8a9d7cee2b9dc78be743e8e1b56bc49f940c5a6dd20');
  });
});
