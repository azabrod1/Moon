import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  COX_MUNK_SLOPE_CALM, COX_MUNK_SLOPE_PER_MS, SEA_WIND_AXIS_SCALE, SEA_WIND_AXIS_ZERO, SEA_WIND_MAX_MS,
  disposeRetiredSeaWindMaps,
  installSeaWindMap, loadSeaWindMap, meanSquareSlope, parseSeaWindMapParam, parseSeaWindParam, seaWindAxisFromByte,
  seaWindBytesFromRgba, seaWindMapDimensions, seaWindMapSource, seaWindRgbaFromSpeed, seaWindTexture, seaWindTextureFrom,
  setSeaWindMips, windRoughness,
  WHITECAP_ALBEDO, WHITECAP_COVER_COEFFICIENT, WHITECAP_COVER_EXPONENT, WHITECAP_MEAN_FACTOR, whitecapCoverage,
} from './seaWind';
import { ROUGHNESS_MAP_LAND, ROUGHNESS_MAP_WATER, SEA_WATER_COLOUR } from './surfaceShading';
import { PLANET_TEXTURE_FILES } from './textureLadder';
import {
  COX_MUNK_SLOPE_CALM as GENERATOR_SLOPE_CALM, COX_MUNK_SLOPE_PER_MS as GENERATOR_SLOPE_PER_MS,
  SEA_WIND_MAX_MS as GENERATOR_WIND_MAX_MS, DEFAULTS, bandStatistics, buildField,
  meanSquareSlope as generatorMeanSquareSlope, pointEvaluator,
} from '../../../tools/seaWindField.mjs';
import {
  AXIS_SCALE, AXIS_ZERO, COX_MUNK_CROSSWIND_CALM, COX_MUNK_CROSSWIND_PER_MS, COX_MUNK_UPWIND_PER_MS,
  accumulateMonth, areaAverager, axisFromAccumulator, axisToByte, byteToAxis, createAccumulator, decodeWindMap,
  encodeWindMap, finishAccumulator, largeBodies, nearestFilledIndex, rollColumns, slopeAnisotropy, syntheticAxis,
} from '../../../tools/seaWindMap.mjs';

/** Four bytes a texel from one wind byte a texel: the map with no axis. */
const speedOnly = (...speed: number[]): Uint8Array => Uint8Array.from(speed.flatMap((byte) => [byte, 128, 128, 255]));

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
    // A glassy sea is drawn narrow, a gale wide, and nothing in between goes
    // the other way.
    expect(windRoughness(0.6)).toBeLessThan(0.3);
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

  it('is one slope law in the places that carry it', () => {
    expect(GENERATOR_SLOPE_CALM).toBe(COX_MUNK_SLOPE_CALM);
    expect(GENERATOR_SLOPE_PER_MS).toBe(COX_MUNK_SLOPE_PER_MS);
    expect(GENERATOR_WIND_MAX_MS).toBe(SEA_WIND_MAX_MS);
    expect(generatorMeanSquareSlope(3)).toBeCloseTo(meanSquareSlope(3), 12);
  });
});

describe('whitecapCoverage', () => {
  /** Γ(x) for x > 0.5, Lanczos (g = 7, nine terms): good to about 1e-13. */
  const gamma = (x: number): number => {
    const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
      -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    const z = x - 1;
    let a = c[0];
    const t = z + 7.5;
    for (let i = 1; i < 9; i++) a += c[i] / (z + i);
    return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * a;
  };
  /** E[W(U)] / W(E[U]) over a Weibull spread of winds of shape k. */
  const weibullFactor = (k: number): number =>
    gamma(1 + WHITECAP_COVER_EXPONENT / k) / Math.pow(gamma(1 + 1 / k), WHITECAP_COVER_EXPONENT);

  it('is Monahan and O\'Muircheartaigh\'s law, raised to the mean over a spread of winds about the annual mean', () => {
    expect(WHITECAP_COVER_COEFFICIENT).toBe(3.84e-6);
    expect(WHITECAP_COVER_EXPONENT).toBe(3.41);
    expect(gamma(5)).toBeCloseTo(24, 10);
    expect(gamma(1.5)).toBeCloseTo(Math.sqrt(Math.PI) / 2, 12);
    // The factor the sea takes sits between the open ocean's shapes, 2.34 at
    // k = 2 and 1.83 at k = 2.5; the steady trades' is about 1.35.
    expect(weibullFactor(2)).toBeCloseTo(2.34, 2);
    expect(weibullFactor(2.5)).toBeCloseTo(1.825, 3);
    expect(WHITECAP_MEAN_FACTOR).toBeLessThan(weibullFactor(2));
    expect(WHITECAP_MEAN_FACTOR).toBeGreaterThan(weibullFactor(2.5));
    expect((weibullFactor(3.5) + weibullFactor(4)) / 2).toBeCloseTo(1.37, 1);
    // The cover the header states.
    expect(whitecapCoverage(7)).toBeCloseTo(0.0061, 4);
    expect(whitecapCoverage(10)).toBeCloseTo(0.0207, 4);
    expect(whitecapCoverage(12)).toBeCloseTo(0.0386, 4);
    expect(whitecapCoverage(13.38)).toBeCloseTo(0.0559, 4);
    expect(whitecapCoverage(6)).toBeCloseTo(0.0036, 4);
    // No wind is no foam, and the share never passes the whole surface.
    expect(whitecapCoverage(0)).toBe(0);
    expect(whitecapCoverage(-4)).toBe(0);
    expect(whitecapCoverage(Number.NaN)).toBe(0);
    expect(whitecapCoverage(1000)).toBe(1);
    let last = 0;
    for (let wind = 0.25; wind <= SEA_WIND_MAX_MS; wind += 0.25) {
      expect(whitecapCoverage(wind)).toBeGreaterThan(last);
      last = whitecapCoverage(wind);
    }
  });

  it('greys the water colour rather than whitening it', () => {
    expect(WHITECAP_ALBEDO).toBe(0.22);
    const at = (cover: number) => SEA_WATER_COLOUR.map((water) => water * (1 - cover) + WHITECAP_ALBEDO * cover);
    const [red, green, blue] = at(0.04);
    expect(red / SEA_WATER_COLOUR[0]).toBeCloseTo(6.83, 2);
    expect(green / SEA_WATER_COLOUR[1]).toBeCloseTo(1.94, 2);
    expect(blue / SEA_WATER_COLOUR[2]).toBeCloseTo(1.27, 2);
    // Still far from white: at the windiest annual mean no channel reaches
    // 0.04, well under a tenth.
    expect(Math.max(...at(whitecapCoverage(13.38)))).toBeLessThan(0.04);
  });
});

describe('the bytes of the map', () => {
  it('reads a picture north-up into row 0 south, the wind in red and the axis in green and blue, alpha opaque', () => {
    // A 2x2 picture as the bake's --png writes one (here with an alpha the
    // canvas would hand over): the top row is the north.
    const rgba = new Uint8Array([
      10, 128, 255, 9, 11, 99, 0, 255, // picture row 0 (north)
      30, 1, 128, 255, 31, 0, 99, 0, // picture row 1 (south)
    ]);
    const map = seaWindBytesFromRgba(rgba, 2, 2);
    expect(map.width).toBe(2);
    expect(map.height).toBe(2);
    expect(Array.from(map.data)).toEqual([30, 1, 128, 255, 31, 0, 99, 255, 10, 128, 255, 255, 11, 99, 0, 255]);
  });

  it('reads a picture grey at every texel as the wind alone: green and blue 128, exactly isotropic', () => {
    // A speed-only picture from before the axis: G = B = R at EVERY texel.
    const grey = new Uint8Array([10, 10, 10, 255, 11, 11, 11, 255, 30, 30, 30, 255, 31, 31, 31, 255]);
    expect(Array.from(seaWindBytesFromRgba(grey, 2, 2).data)).toEqual(Array.from(speedOnly(30, 31, 10, 11)));
    // One texel off grey and the picture carries an axis: kept as it is.
    const almost = grey.slice();
    almost[13] = 12;
    expect(Array.from(seaWindBytesFromRgba(almost, 2, 2).data)).toEqual([30, 30, 30, 255, 31, 12, 31, 255, 10, 10, 10, 255, 11, 11, 11, 255]);
    // The rule is one function, and 128 is no axis to the last bit.
    expect(Array.from(seaWindRgbaFromSpeed([7, 200], 2, 1))).toEqual([7, 128, 128, 255, 200, 128, 128, 255]);
    expect(seaWindAxisFromByte(SEA_WIND_AXIS_ZERO)).toBe(0);
    expect(seaWindAxisFromByte(255)).toBe(1);
    expect(seaWindAxisFromByte(1)).toBe(-1);
    expect(SEA_WIND_AXIS_ZERO).toBe(AXIS_ZERO);
    expect(SEA_WIND_AXIS_SCALE).toBe(AXIS_SCALE);
  });

  it('reads a raw map\'s shape off its size', () => {
    expect(seaWindMapDimensions(2048 * 1024)).toEqual({ width: 2048, height: 1024 });
    expect(seaWindMapDimensions(1440 * 720)).toEqual({ width: 1440, height: 720 });
    expect(seaWindMapDimensions(1024 * 512)).toEqual({ width: 1024, height: 512 });
    expect(seaWindMapDimensions(1000)).toBeNull();
    expect(seaWindMapDimensions(2048 * 1024 + 1)).toBeNull();
    expect(seaWindMapDimensions(0)).toBeNull();
  });

  describe('a raw map from a file', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('is the wind a byte with no axis, row 0 the south, its shape read off its size, and a byte count with no shape is refused', async () => {
      // tools/glint-probe.mjs serves one of these from memory: one wind over
      // the whole sea, as it is, with no axis.
      const bytes = new Uint8Array(8 * 4).map((_, index) => index);
      vi.stubGlobal('fetch', async () => new Response(bytes));
      const map = await loadSeaWindMap('/__glint-probe/wind-7.raw');
      expect(map.width).toBe(8);
      expect(map.height).toBe(4);
      expect(Array.from(map.data)).toEqual(Array.from(speedOnly(...bytes)));
      vi.stubGlobal('fetch', async () => new Response(new Uint8Array(7)));
      await expect(loadSeaWindMap('/x.raw')).rejects.toThrow(/not a width x width\/2 byte map/);
      vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
      await expect(loadSeaWindMap('/x.raw')).rejects.toThrow(/answered 404/);
    });
  });
});

describe('the texture', () => {
  it('is four channels, wrapped around the date line, clamped at the poles, mip-chained, and read as data', () => {
    const tex = seaWindTextureFrom({ data: speedOnly(1, 2, 3, 4), width: 4, height: 1 });
    expect(tex.format).toBe(THREE.RGBAFormat);
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
    const flat = seaWindTextureFrom({ data: speedOnly(1, 2), width: 2, height: 1 });
    expect(flat.generateMipmaps).toBe(false);
    expect(flat.minFilter).toBe(THREE.LinearFilter);
    setSeaWindMips(true);
    // One byte a texel is refused: the expansion is seaWindRgbaFromSpeed's.
    expect(() => seaWindTextureFrom({ data: new Uint8Array([1, 2, 3, 4]), width: 4, height: 1 })).toThrow(/not four a texel/);
  });

  it('is installed once it lands, a replacement retires the old one, and an override refuses the shipped map', () => {
    expect(seaWindTexture()).toBeNull();
    expect(seaWindMapSource()).toBe('none');
    const first = seaWindTextureFrom({ data: speedOnly(0, 0), width: 2, height: 1 });
    expect(installSeaWindMap(first, 'shipped')).toBe(first);
    expect(seaWindMapSource()).toBe('shipped');
    expect(seaWindTexture()).toBe(first);
    // A replacement retires the map it replaces, disposed once the sea has
    // been rebound to the new one (rebindSeaWindMap calls this): disposed
    // while still bound, three would re-upload it from a bitmap its dispose
    // listener had closed.
    let disposed = 0;
    first.addEventListener('dispose', () => { disposed++; });
    const second = seaWindTextureFrom({ data: speedOnly(0, 0), width: 2, height: 1 });
    expect(installSeaWindMap(second, 'shipped')).toBe(second);
    expect(disposed).toBe(0);
    disposeRetiredSeaWindMaps();
    expect(disposed).toBe(1);
    disposeRetiredSeaWindMaps();
    expect(disposed).toBe(1);
    expect(seaWindTexture()).toBe(second);
    // Asking for a map from a file refuses the shipped map from then on,
    // whichever lands first — a sheet captured through the override never
    // shows the shipped map under it.
    expect(parseSeaWindMapParam('')).toBeNull();
    expect(parseSeaWindMapParam('?seawindmap=')).toBeNull();
    expect(parseSeaWindMapParam('?seawind=0&seawindmap=/planning/field.png')).toBe('/planning/field.png');
    const late = seaWindTextureFrom({ data: speedOnly(0, 0), width: 2, height: 1 });
    expect(installSeaWindMap(late, 'shipped')).toBeNull();
    expect(seaWindTexture()).toBe(second);
    const override = seaWindTextureFrom({ data: speedOnly(0, 0), width: 2, height: 1 });
    expect(installSeaWindMap(override, '/planning/field.png')).toBe(override);
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
    // The authored field is the bake's `--synthetic` arm now, whose speed is
    // byte for byte the old earth-seawind.v1.webp's: move these only with a
    // deliberate change to the field. They are the open sea's wind the pair
    // before that map carried in its windy map at the same points: removing
    // the calm lanes and regions left the wind under them as it was.
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
    // Every byte of the encoding is a texel: four a texel, north-up — its
    // first row is the field's last, which a hash pin moved on a re-bake
    // could not tell from a map upside down — and with no axis given, green
    // and blue are 128 and alpha opaque.
    const encoded = encodeWindMap(small);
    expect(encoded).toHaveLength(256 * 128 * 4);
    expect(Array.from(encoded.subarray(1, 4))).toEqual([128, 128, 255]);
    const byte = (wind: number): number => Math.round(Math.min(1, Math.max(0, wind / SEA_WIND_MAX_MS)) * 255);
    expect(encoded[0]).toBe(byte(small.windMs[127 * 256]));
    expect(encoded[encoded.length - 4]).toBe(byte(small.windMs[255]));
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

  it('keeps the authored field\'s shape', () => {
    // The synthetic arm's speed is byte for byte the old v1 map's because it
    // is these DEFAULTS at the shipped size.
    expect(DEFAULTS.supersample).toBe(4);
    expect(DEFAULTS.grain).toBe(0);
    expect(DEFAULTS.broadSpread).toBe(0.45);
  });
});

describe('the shipped map (tools/gen-seawind.mjs)', () => {
  it('ships the map the bake made, under the name the boot loads and warms, and every bar the bake held it to passed', () => {
    // The hash moves only with `npm run gen:seawind`, and a re-bake whose
    // bytes differ after shipping ships under a new name (.v3), as every
    // data file the service worker caches does.
    expect(PLANET_TEXTURE_FILES.earthSeaWind).toBe('earth-seawind.v2.webp');
    const mapBytes = readFileSync(`public/textures/${PLANET_TEXTURE_FILES.earthSeaWind}`);
    const sha256 = createHash('sha256').update(mapBytes).digest('hex');
    expect(sha256).toBe('c4d96d4e66c67a557cf2aa7cd91101402a6d3726df8ca581ae0058d404e58bd3');
    // Lossless webp, the container the loader decodes as a picture: RIFF,
    // WEBP, VP8L.
    expect(mapBytes.toString('ascii', 0, 4)).toBe('RIFF');
    expect(mapBytes.toString('ascii', 8, 12)).toBe('WEBP');
    expect(mapBytes.toString('ascii', 12, 16)).toBe('VP8L');
    // The statistics the bake measured on this very file (vitest cannot
    // decode the webp or read the HDF5 source, so the bake does and commits
    // them): they name this sha256, the source the manifest names, and
    // every bar passed.
    const stats = JSON.parse(readFileSync('tools/goldens/seawind/earth-seawind.v2.stats.json', 'utf8'));
    const sources = JSON.parse(readFileSync('tools/gen-seawind.sources.json', 'utf8'));
    expect(stats.arm).toBe('data');
    expect(stats.map.file).toBe(PLANET_TEXTURE_FILES.earthSeaWind);
    expect(stats.map.sha256).toBe(sha256);
    expect(stats.map.bytes).toBe(mapBytes.length);
    expect([stats.map.width, stats.map.height]).toEqual([1024, 512]);
    expect(stats.source.sha256).toBe(sources[stats.source.file].sha256);
    expect(stats.allBarsPassed).toBe(true);
    expect(stats.mipBias.pass).toBe(true);
    expect(stats.seams.pass).toBe(true);
    expect(stats.pointsHold).toBe(true);
    // Each bar, at every level (2 to 16 texels a side) and tilt, read again
    // here so a stats file edited by hand cannot pass on its flag alone.
    expect(stats.mipBias.levels.map((entry: { level: number }) => entry.level)).toEqual([1, 2, 3, 4]);
    for (const entry of stats.mipBias.levels) {
      expect(entry.speed.map((row: { tiltDeg: number }) => row.tiltDeg)).toEqual([0, 5, 10]);
      for (const row of [...entry.speed, ...entry.anisotropy]) {
        expect(row.mean).toBeLessThan(0.03);
        expect(row.p99).toBeLessThan(0.1);
      }
    }
  });
});

describe('the map\'s arithmetic (tools/seaWindMap.mjs)', () => {
  it('is Cox and Munk\'s anisotropy: sigma_u² - sigma_c², crossing zero at 2.42 m/s, the sum near the slope law', () => {
    expect(slopeAnisotropy(7)).toBeCloseTo(0.00316 * 7 - (0.003 + 0.00192 * 7), 12);
    expect(slopeAnisotropy(0.003 / 0.00124)).toBeCloseTo(0, 12);
    expect(slopeAnisotropy(2)).toBeLessThan(0);
    expect(slopeAnisotropy(3)).toBeGreaterThan(0);
    // The two variances add to the total law within its own fit (5.08 against
    // 5.12 thousandths a metre a second).
    const sum = (wind: number): number => COX_MUNK_UPWIND_PER_MS * wind + COX_MUNK_CROSSWIND_CALM + COX_MUNK_CROSSWIND_PER_MS * wind;
    for (const wind of [3, 7, 12]) expect(Math.abs(sum(wind) / meanSquareSlope(wind) - 1)).toBeLessThan(0.01);
  });

  it('stores the axis 128 + round(127 x), affine, clamped to the unit disc and none where d is near zero', () => {
    expect(axisToByte(0)).toBe(128);
    expect(axisToByte(1)).toBe(255);
    expect(axisToByte(-1)).toBe(1);
    expect(axisToByte(2)).toBe(255);
    for (const byte of [1, 64, 128, 200, 255]) expect(axisToByte(byteToAxis(byte))).toBe(byte);
    // Affine: the decode of a mean of bytes is the mean of the decodes, so a
    // mip of the bytes is the mip of the axis.
    expect(byteToAxis((40 + 220) / 2)).toBeCloseTo((byteToAxis(40) + byteToAxis(220)) / 2, 12);
    // a / d(R), clamped to the unit disc.
    const d7 = slopeAnisotropy(7);
    expect(axisFromAccumulator(0.5 * d7, -0.25 * d7, 7)).toEqual([0.5, -0.25]);
    const [x1, x2] = axisFromAccumulator(3 * d7, 4 * d7, 7);
    expect(Math.hypot(x1, x2)).toBeCloseTo(1, 12);
    expect(x2 / x1).toBeCloseTo(4 / 3, 12);
    expect(axisFromAccumulator(0.001, 0.001, 0.003 / 0.00124)).toEqual([0, 0]);
  });

  it('keeps a monsoon sea\'s axis in doubled angle, where opposite winds add, and turns the trades\' axis with the wind', () => {
    // Four cells, two months. Cell 0: toward the south-west in month 1, the
    // north-east in month 2 — the Arabian Sea's two monsoons, each steady
    // (k = 1). Cell 1: toward the north-west both months. Cell 2: land.
    // Cell 3: toward the east, half steady (|mean vector| half the speed).
    const s = Math.SQRT1_2 * 8;
    const months = [
      { u: [-s, -s, NaN, 4], v: [-s, s, NaN, 0], w: [8, 8, NaN, 8], mask: [1, 1, 0, 1] },
      { u: [s, -s, NaN, 4], v: [s, s, NaN, 0], w: [8, 8, NaN, 8], mask: [1, 1, 0, 1] },
    ];
    const acc = createAccumulator(4);
    for (const month of months) accumulateMonth(acc, month);
    const done = finishAccumulator(acc, 2);
    expect(Array.from(done.filled)).toEqual([1, 1, 0, 1]);
    expect(done.windMs[0]).toBeCloseTo(8, 12);
    // Opposite directions add: the axis is (0, +1) at full steadiness, where
    // the mean vector is zero.
    const monsoon = axisFromAccumulator(done.a1[0], done.a2[0], 8);
    expect(monsoon[0]).toBeCloseTo(0, 12);
    expect(monsoon[1]).toBeCloseTo(1, 12);
    // Toward the north-west, 2 theta = 270 degrees: (0, -1).
    const northWest = axisFromAccumulator(done.a1[1], done.a2[1], 8);
    expect(northWest[0]).toBeCloseTo(0, 12);
    expect(northWest[1]).toBeCloseTo(-1, 12);
    // East-west at half steadiness: (0.5, 0).
    const halfSteady = axisFromAccumulator(done.a1[3], done.a2[3], 8);
    expect(halfSteady[0]).toBeCloseTo(0.5, 12);
    expect(halfSteady[1]).toBeCloseTo(0, 12);
  });

  it('writes and reads every arm\'s map through one encoder, north-up, alpha opaque', () => {
    const fields = { width: 2, height: 2, windMs: [4, 8, 12, 16], axisX: [0, 1, -1, 0.5], axisY: [0, 0, 0.25, -0.5] };
    const rgba = encodeWindMap(fields);
    // Picture row 0 is the field's north row (its row 1).
    expect(Array.from(rgba)).toEqual([
      191, 1, 160, 255, 255, 192, 65, 255,
      64, 128, 128, 255, 128, 255, 128, 255,
    ]);
    const back = decodeWindMap(rgba, 2, 2);
    expect(Array.from(back.red)).toEqual([64, 128, 191, 255]);
    expect(back.axisX[1]).toBe(1);
    expect(back.axisY[3]).toBeCloseTo(-0.5, 2);
  });

  it('gives the synthetic arm east-west axes in both belts and none under the subtropical high', () => {
    expect(syntheticAxis(15)).toEqual(syntheticAxis(-50));
    expect(syntheticAxis(15)[1]).toBe(0);
    expect(syntheticAxis(15)[0]).toBeGreaterThan(0.5);
    expect(syntheticAxis(32.5)[0]).toBeCloseTo(0, 12);
  });

  it('rolls a grid that starts at 0 degrees to start at -180, and resamples and fills it periodically in longitude', () => {
    // A source like the product's: points at whole cells from 0 degrees, the
    // first cell straddling 0. Rolled by half, the field f(lon) = cos(lon)
    // area-averaged onto a map starting at -180 must be seamless and match
    // cos at the map's columns, at its edges as in its middle.
    const srcWidth = 360;
    const srcHeight = 4;
    const source = new Float64Array(srcWidth * srcHeight);
    for (let row = 0; row < srcHeight; row++) {
      for (let column = 0; column < srcWidth; column++) source[row * srcWidth + column] = Math.cos((column * Math.PI) / 180);
    }
    const rolled = rollColumns(source, srcWidth, srcHeight, srcWidth / 2);
    expect(rolled[0]).toBeCloseTo(-1, 12);
    expect(rolled[180]).toBeCloseTo(1, 12);
    const average = areaAverager({
      srcWidth, srcHeight, srcWestEdgeDeg: -180.5, srcLatCentreDeg: (row) => -1.5 + row, srcRowHeightDeg: 1,
      dstWidth: 100, dstHeight: 2,
    });
    const map = average(rolled);
    for (let column = 0; column < 100; column++) {
      const lon = ((column + 0.5) / 100) * 360 - 180;
      expect(map[column]).toBeCloseTo(Math.cos((lon * Math.PI) / 180), 3);
    }
    expect(Math.abs(map[0] - map[99])).toBeLessThan(1e-12);
    // The fill wraps too: a filled cell just west of the date line is the
    // nearest for an unfilled one just east of it.
    const filled = new Uint8Array(10 * 3);
    filled[1 * 10 + 9] = 1;
    filled[1 * 10 + 4] = 1;
    const nearest = nearestFilledIndex(filled, 10, 3);
    expect(nearest[1 * 10 + 0]).toBe(1 * 10 + 9);
    expect(nearest[2 * 10 + 1]).toBe(1 * 10 + 9);
    expect(nearest[0 * 10 + 5]).toBe(1 * 10 + 4);
  });

  it('seeds the land\'s fill from the open sea alone: a body joined across the date line and corners is kept, an inland lake is not', () => {
    // 8 x 4: a sea in columns 6..1 across the date line, touching a cell
    // diagonally at (2, 3); a two-cell lake at columns 3..4 of row 1.
    const W = 8;
    const mask = new Uint8Array(W * 4);
    for (let row = 0; row < 4; row++) for (const column of [6, 7, 0, 1]) mask[row * W + column] = 1;
    mask[3 * W + 2] = 1;
    mask[1 * W + 3] = 1;
    mask[1 * W + 4] = 1;
    const bodies = largeBodies(mask, W, 4, 5);
    expect(bodies.bodiesKept).toBe(1);
    expect(bodies.bodiesDropped).toBe(1);
    expect(bodies.cellsDropped).toBe(2);
    expect(bodies.kept[3 * W + 2]).toBe(1);
    expect(bodies.kept[1 * W + 3]).toBe(0);
    expect(Array.from(bodies.kept).reduce((sum, value) => sum + value, 0)).toBe(17);
  });
});
