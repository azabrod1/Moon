import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  CALM_PATCH_WIND_MS, COX_MUNK_SLOPE_CALM, COX_MUNK_SLOPE_PER_MS, SEA_WIND_MAP_HEIGHT, SEA_WIND_MAP_WIDTH,
  SEA_WIND_MAX_MS, WIND_BROAD_SPREAD, WIND_FINE_SPREAD, ZONAL_WIND_MS, buildSeaWindMap, mapNoise, parseSeaWindParam,
  seaWindAt, seaWindTexture, windRoughness, zonalWindMs,
} from './seaWind';
import { ROUGHNESS_MAP_WATER } from './surfaceShading';

describe('windRoughness', () => {
  it('is Cox-Munk\'s slope law as a GGX roughness, and lands the map\'s own water value at the mean sea', () => {
    expect(windRoughness(0)).toBeCloseTo(Math.pow(COX_MUNK_SLOPE_CALM, 0.25), 12);
    // The roughness map grades open water at 0.45; that is a 7 m/s sea here,
    // which is about the mean wind over the ocean.
    expect(windRoughness(7.4)).toBeCloseTo(ROUGHNESS_MAP_WATER, 2);
    // A glassy patch is drawn narrow, a gale wide, and nothing in between goes
    // the other way.
    expect(windRoughness(CALM_PATCH_WIND_MS)).toBeLessThan(0.27);
    expect(windRoughness(SEA_WIND_MAX_MS)).toBeGreaterThan(0.5);
    let last = 0;
    for (let wind = 0; wind <= SEA_WIND_MAX_MS; wind += 0.25) {
      expect(windRoughness(wind)).toBeGreaterThan(last);
      last = windRoughness(wind);
    }
    // A negative wind is no wind.
    expect(windRoughness(-3)).toBe(windRoughness(0));
    expect(COX_MUNK_SLOPE_PER_MS).toBe(0.00512);
  });
});

describe('zonalWindMs', () => {
  it('is calm at the equator, light in the subtropics and strongest over the Southern Ocean', () => {
    expect(zonalWindMs(0)).toBeLessThan(zonalWindMs(15));
    expect(zonalWindMs(30)).toBeLessThan(zonalWindMs(15));
    expect(zonalWindMs(-55)).toBeGreaterThan(zonalWindMs(50));
    for (const [latitude, wind] of ZONAL_WIND_MS) expect(zonalWindMs(latitude)).toBeCloseTo(wind, 12);
    // Between rows it interpolates, and beyond the poles it clamps.
    expect(zonalWindMs(1.5)).toBeCloseTo((zonalWindMs(0) + zonalWindMs(3)) / 2, 12);
    expect(zonalWindMs(120)).toBe(zonalWindMs(90));
    expect(zonalWindMs(-120)).toBe(zonalWindMs(-90));
  });
});

describe('mapNoise', () => {
  it('is periodic in longitude, bounded, and the same noise every time', () => {
    for (const [v, cells, seed] of [[0.3, 9, 1], [0.62, 30, 2], [0.5, 144, 3]] as const) {
      expect(mapNoise(0, v, cells, seed)).toBeCloseTo(mapNoise(1, v, cells, seed), 12);
      expect(mapNoise(0.25, v, cells, seed)).toBeCloseTo(mapNoise(1.25, v, cells, seed), 12);
    }
    let low = 1;
    let high = 0;
    for (let i = 0; i < 2000; i++) {
      const value = mapNoise((i * 0.618) % 1, (i * 0.382) % 1, 30, 2);
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
    expect(low).toBeGreaterThanOrEqual(0);
    expect(high).toBeLessThan(1);
    expect(high - low).toBeGreaterThan(0.5);
    expect(mapNoise(0.1, 0.2, 9, 1)).toBe(mapNoise(0.1, 0.2, 9, 1));
    expect(mapNoise(0.1, 0.2, 9, 1)).not.toBe(mapNoise(0.1, 0.2, 9, 2));
  });
});

describe('buildSeaWindMap', () => {
  const map = buildSeaWindMap();

  it('is the map size, a byte a texel, the same map twice', () => {
    expect(map.width).toBe(SEA_WIND_MAP_WIDTH);
    expect(map.height).toBe(SEA_WIND_MAP_HEIGHT);
    expect(map.data).toHaveLength(SEA_WIND_MAP_WIDTH * SEA_WIND_MAP_HEIGHT);
    const again = buildSeaWindMap();
    expect(Buffer.compare(Buffer.from(map.data), Buffer.from(again.data))).toBe(0);
  });

  it('blows at about the mean wind over the ocean, with a few glassy patches and none in the Southern Ocean', () => {
    expect(map.meanWindMs).toBeGreaterThan(6);
    expect(map.meanWindMs).toBeLessThan(9);
    expect(map.calmFraction).toBeGreaterThan(0.003);
    expect(map.calmFraction).toBeLessThan(0.05);
    // The Southern Ocean rows: 45°S to 65°S, the map's lower quarter.
    let calmSouth = 0;
    for (let row = Math.floor(map.height * (25 / 180)); row < Math.floor(map.height * (45 / 180)); row++) {
      for (let column = 0; column < map.width; column++) {
        if (map.data[row * map.width + column] < (1 / SEA_WIND_MAX_MS) * 255) calmSouth++;
      }
    }
    expect(calmSouth).toBe(0);
    // The equatorial band has the most.
    let calmEquator = 0;
    let equatorTexels = 0;
    for (let row = Math.floor(map.height * (80 / 180)); row < Math.floor(map.height * (100 / 180)); row++) {
      for (let column = 0; column < map.width; column++) {
        equatorTexels++;
        if (map.data[row * map.width + column] < (1 / SEA_WIND_MAX_MS) * 255) calmEquator++;
      }
    }
    expect(calmEquator / equatorTexels).toBeGreaterThan(map.calmFraction);
  });

  it('wraps at the date line: the first and last columns are neighbours', () => {
    let seam = 0;
    let inland = 0;
    for (let row = 0; row < map.height; row++) {
      const first = map.data[row * map.width];
      const last = map.data[row * map.width + map.width - 1];
      const mid = map.data[row * map.width + 500];
      const midNext = map.data[row * map.width + 501];
      seam += Math.abs(first - last);
      inland += Math.abs(mid - midNext);
    }
    expect(seam).toBeLessThan(inland * 3 + map.height);
  });

  it('is the south pole on row 0, which is how three uploads it', () => {
    // The Southern Ocean is the windier of the two 55° rows, so a row mean
    // tells the map's ends apart: 55°S lies in the lower quarter.
    const rowMean = (row: number): number => {
      let sum = 0;
      for (let column = 0; column < map.width; column++) sum += map.data[row * map.width + column];
      return (sum / map.width / 255) * SEA_WIND_MAX_MS;
    };
    const south55 = rowMean(Math.round(map.height * (35 / 180)));
    const north55 = rowMean(Math.round(map.height * (145 / 180)));
    expect(south55).toBeGreaterThan(north55);
    // A row crosses nine broad noise cells, so its mean sits within a tenth
    // of the zonal value rather than on it.
    expect(Math.abs(south55 - zonalWindMs(-55)) / zonalWindMs(-55)).toBeLessThan(0.1);
    expect(Math.abs(north55 - zonalWindMs(55)) / zonalWindMs(55)).toBeLessThan(0.1);
    // And a single texel carries the structure on top of the zonal mean.
    expect(Math.abs(seaWindAt(0.5, 0.001) - zonalWindMs(-89.8)))
      .toBeLessThan(zonalWindMs(-89.8) * (WIND_BROAD_SPREAD + WIND_FINE_SPREAD) + 1e-9);
  });
});

describe('seaWindTexture', () => {
  it('is one channel, wrapped around the date line, clamped at the poles, built once', () => {
    const tex = seaWindTexture();
    expect(tex.format).toBe(THREE.RedFormat);
    expect(tex.type).toBe(THREE.UnsignedByteType);
    expect(tex.wrapS).toBe(THREE.RepeatWrapping);
    expect(tex.wrapT).toBe(THREE.ClampToEdgeWrapping);
    expect(tex.generateMipmaps).toBe(true);
    expect(tex.colorSpace).toBe(THREE.NoColorSpace);
    expect(tex.image.width).toBe(SEA_WIND_MAP_WIDTH);
    expect(seaWindTexture()).toBe(tex);
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
