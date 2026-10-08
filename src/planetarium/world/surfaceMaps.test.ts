import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  COARSE_MAP_HEIGHT, COARSE_MAP_WIDTH, EarthSurfaceMaps, coarseFromRgba, pickCloudCoverage, pickRed, pickWater, sampleCoarse,
  type CoarseMap,
} from './surfaceMaps';
import { bodyToDeck, cloudRayDirection, sphereEquirectUv } from './cloudDeck';
import { ROUGHNESS_MAP_LAND, ROUGHNESS_MAP_WATER } from './surfaceShading';
import { SEA_WIND_MAX_MS, seaWindAxisFromByte } from './seaWind';
import { PLANET_TEXTURE_FILES } from './textureLadder';

const grid = (w: number, h: number, f: (x: number, y: number) => number): CoarseMap => {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = Math.round(f(x, y) * 255);
  return { width: w, height: h, data };
};

describe('the coarse sampler', () => {
  it('reads texel centres exactly, wraps in longitude and clamps in latitude', () => {
    const map = grid(8, 4, (x, y) => (x + y * 8) / 40);
    // Texel (3, 1) sits at u = 3.5/8, v = 1.5/4.
    expect(sampleCoarse(map, 3.5 / 8, 1.5 / 4)).toBeCloseTo(11 / 40, 2);
    // Wrapping: a quarter texel left of the first column reads between the
    // last column and the first.
    const left = sampleCoarse(map, 0.25 / 8, 0.5 / 4);
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(sampleCoarse(map, 7.5 / 8, 0.5 / 4));
    expect(sampleCoarse(map, 1.5 / 8 + 1, 0.5 / 4)).toBeCloseTo(sampleCoarse(map, 1.5 / 8, 0.5 / 4), 12);
    // Clamping: past the poles reads the last row.
    expect(sampleCoarse(map, 0.5 / 8, 1.2)).toBeCloseTo(sampleCoarse(map, 0.5 / 8, 3.5 / 4), 12);
    expect(sampleCoarse(map, 0.5 / 8, -0.5)).toBeCloseTo(sampleCoarse(map, 0.5 / 8, 0.5 / 4), 12);
  });
});

describe('the coarse decode', () => {
  it('boxes the source texels and flips a north-up picture so row 0 is the south', () => {
    // A 4 x 4 picture, red = row index / 3 (north-up: row 0 is the north).
    const w = 4, h = 4;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; rgba[i] = Math.round((y / 3) * 255); rgba[i + 3] = 255; }
    const map = coarseFromRgba(rgba, w, h, pickRed, 2, 2);
    // The south half of the picture (rows 2 and 3, red 2/3 and 1) lands in coarse row 0.
    expect(map.data[0] / 255).toBeCloseTo((2 / 3 + 1) / 2, 1);
    expect(map.data[2] / 255).toBeCloseTo((0 + 1 / 3) / 2, 1);
  });

  it('derives the water fraction from the roughness red as the shader does', () => {
    expect(pickWater(Math.round(ROUGHNESS_MAP_LAND * 255))).toBeCloseTo(0, 1);
    expect(pickWater(Math.round(ROUGHNESS_MAP_WATER * 255))).toBeCloseTo(1, 1);
    const mid = (ROUGHNESS_MAP_LAND + ROUGHNESS_MAP_WATER) / 2;
    expect(pickWater(mid * 255)).toBeCloseTo(0.5, 2);
    // Cloud coverage: black is clear, white is covered.
    expect(pickCloudCoverage(0, 0, 0)).toBe(0);
    expect(pickCloudCoverage(255, 255, 255)).toBe(1);
  });
});

describe("Earth's maps together", () => {
  // A fake decode: a sea everywhere but a land band at the equator's east
  // (lon 0..90 E), the wind at 8 m/s, cloud over the whole north.
  const fakeDecode = async (url: string, width: number, height: number) => {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const lon = (x / width) * 360 - 180; // the picture's column, west to east
        const north = y < height / 2;
        let r = 0, g = 0, b = 0;
        if (url.includes('rough')) r = lon > 0 && lon < 90 && Math.abs(y - height / 2) < height / 8 ? ROUGHNESS_MAP_LAND * 255 : ROUGHNESS_MAP_WATER * 255;
        else if (url.includes('wind')) r = (8 / SEA_WIND_MAX_MS) * 255;
        else if (url.includes('cloud')) { const v = north ? 255 : 0; r = v; g = v; b = v; }
        rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
      }
    }
    return { rgba, width, height };
  };
  const urls = { water: 'x/rough.webp', wind: 'x/wind.webp', cloud: 'x/cloud.webp' } as const;

  it('holds the meter while a map is missing, then answers from all three', async () => {
    const maps = new EarthSurfaceMaps(urls, fakeDecode, { width: 72, height: 36 });
    const out = { water: 0, windMs: 0, cloudKeep: 1, deckKeep: 1, axisX: 0, axisY: 0 };
    maps.sampleAt(1, 0, 0, 0, out);
    expect(out.water).toBe(0);
    expect(maps.ready).toBe(false);
    maps.request();
    expect(maps.state().loading.length).toBe(3);
    await new Promise((r) => setTimeout(r, 20));
    expect(maps.ready).toBe(true);
    expect(maps.state().ready).toEqual(['water', 'wind', 'cloud']);
    // Open sea in the south-west: water, 8 m/s, no cloud.
    const sw = dirAt(-30, -120);
    maps.sampleAt(sw[0], sw[1], sw[2], 0, out);
    expect(out.water).toBeCloseTo(1, 1);
    expect(out.windMs).toBeCloseTo(8, 0);
    expect(out.cloudKeep).toBeCloseTo(1, 1);
    // The land band: no water.
    const land = dirAt(0, 45);
    maps.sampleAt(land[0], land[1], land[2], 0, out);
    expect(out.water).toBeLessThan(0.1);
    // Under the northern cloud: the beam is cut.
    const north = dirAt(45, -120);
    maps.sampleAt(north[0], north[1], north[2], 0, out);
    expect(out.cloudKeep).toBeLessThan(0.1);
    // The deck drifted half a turn: the cloud is now over the south.
    maps.sampleAt(sw[0], sw[1], sw[2], Math.PI, out);
    expect(out.cloudKeep).toBeCloseTo(1, 1);
    const spunNorth = dirAt(45, 60);
    maps.sampleAt(spunNorth[0], spunNorth[1], spunNorth[2], Math.PI, out);
    expect(out.cloudKeep).toBeLessThan(0.1);
  });

  it('marks a map that failed to decode and keeps the hold', async () => {
    const maps = new EarthSurfaceMaps(urls, async (url, w, h) => { if (url.includes('cloud')) throw new Error('no'); return fakeDecode(url, w, h); }, { width: 36, height: 18 });
    maps.request();
    await new Promise((r) => setTimeout(r, 20));
    expect(maps.ready).toBe(false);
    expect(maps.state().failed).toEqual(['cloud']);
    const out = { water: 0, windMs: 0, cloudKeep: 1, deckKeep: 1, axisX: 0, axisY: 0 };
    maps.sampleAt(1, 0, 0, 0, out);
    expect(out.water).toBe(0);
  });

  it('samples through the same mapping as the deck module, with the deck turned by its drift', async () => {
    const maps = new EarthSurfaceMaps(urls, fakeDecode, { width: 72, height: 36 });
    maps.request();
    await new Promise((r) => setTimeout(r, 20));
    const out = { water: 0, windMs: 0, cloudKeep: 1, deckKeep: 1, axisX: 0, axisY: 0 };
    for (const [lat, lon, spin] of [[10, 20, 0.7], [-40, -100, 2.9], [60, 170, 5.5]]) {
      const n = dirAt(lat, lon);
      maps.sampleAt(n[0], n[1], n[2], spin, out);
      const uv = sphereEquirectUv(n[0], n[1], n[2]);
      const d = bodyToDeck(n, spin);
      const duv = sphereEquirectUv(d[0], d[1], d[2]);
      expect(out.water).toBeCloseTo(sampleCoarse((maps as unknown as { maps: { water: CoarseMap } }).maps.water, uv[0], uv[1]), 12);
      expect(out.cloudKeep).toBeCloseTo(1 - sampleCoarse((maps as unknown as { maps: { cloud: CoarseMap } }).maps.cloud, duv[0], duv[1]), 12);
    }
  });

  it("reads the deck where a ray from the ground crosses its shell, through the deck module's own geometry", () => {
    // A cloud map with structure at every scale the test can reach, so a
    // read at the wrong point shows.
    const maps = new EarthSurfaceMaps(urls, fakeDecode, { width: 72, height: 36 });
    maps.install('cloud', grid(72, 36, (x, y) => ((x * 7 + y * 13) % 17) / 16));
    const hOverR = 10 / 6371;
    const cloud = (maps as unknown as { maps: { cloud: CoarseMap } }).maps.cloud;
    for (const [lat, lon, spin, dLat, dLon, elev] of [
      [10, 20, 0.7, 0, 1, 5], [-40, -100, 2.9, 1, 0, 30], [60, 170, 5.5, -0.6, 0.8, 80], [0, 0, 0, 0.3, -0.95, 1],
    ]) {
      const n = dirAt(lat, lon);
      // A direction elev above the local horizon, toward (dLat, dLon) on it.
      const east = norm3([n[2], 0, -n[0]]);
      const north = norm3(cross3(n, east));
      const e = (elev * Math.PI) / 180;
      const d = norm3([0, 1, 2].map((k) => Math.cos(e) * (dLat * north[k] + dLon * east[k]) + Math.sin(e) * n[k]) as [number, number, number]);
      const pierce = bodyToDeck(cloudRayDirection(n, d, hOverR), spin);
      const uv = sphereEquirectUv(pierce[0], pierce[1], pierce[2]);
      expect(maps.keepToward(n[0], n[1], n[2], d[0], d[1], d[2], hOverR, spin)).toBeCloseTo(1 - sampleCoarse(cloud, uv[0], uv[1]), 12);
    }
    // No cloud map: nothing in the way.
    const bare = new EarthSurfaceMaps(urls, fakeDecode, { width: 72, height: 36 });
    expect(bare.keepToward(1, 0, 0, 0, 1, 0, hOverR, 0)).toBe(1);
  });

  it('leaves the deck over the point unread for a caller that reads it elsewhere', async () => {
    const maps = new EarthSurfaceMaps(urls, fakeDecode, { width: 72, height: 36 });
    maps.request();
    await new Promise((r) => setTimeout(r, 20));
    const north = dirAt(45, -120);
    const read = { water: 0, windMs: 0, cloudKeep: 1, deckKeep: 1, axisX: 0, axisY: 0 };
    const unread = { water: 0, windMs: 0, cloudKeep: 0.3, deckKeep: 1, axisX: 0, axisY: 0 };
    maps.sampleAt(north[0], north[1], north[2], 0, read);
    maps.sampleAt(north[0], north[1], north[2], 0, unread, false);
    expect(read.cloudKeep).toBeLessThan(0.1);
    expect(unread.cloudKeep).toBe(1);
    expect(unread.water).toBe(read.water);
    expect(unread.windMs).toBe(read.windMs);
  });

  it('defaults to the coarse grid the meter was designed for', () => {
    expect(COARSE_MAP_WIDTH).toBe(360);
    expect(COARSE_MAP_HEIGHT).toBe(180);
  });
});

describe("the wind's axis", () => {
  // A wind picture as a decode hands it over (RGBA, north-up): 8 m/s
  // everywhere, and the axis at each texel's centre from a function of its
  // latitude and longitude, stored 128 + round(127 x) as the bake stores it.
  const axisPicture = (axisAt: (latDeg: number, lonDeg: number) => [number, number]) =>
    async (url: string, width: number, height: number) => {
      const rgba = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const lat = 90 - ((y + 0.5) / height) * 180;
          const lon = ((x + 0.5) / width) * 360 - 180;
          const [x1, x2] = url.includes('wind') ? axisAt(lat, lon) : [0, 0];
          rgba[i] = url.includes('wind') ? (8 / SEA_WIND_MAX_MS) * 255 : url.includes('rough') ? ROUGHNESS_MAP_WATER * 255 : 0;
          rgba[i + 1] = 128 + Math.round(127 * x1);
          rgba[i + 2] = 128 + Math.round(127 * x2);
          rgba[i + 3] = 255;
        }
      }
      return { rgba, width, height };
    };
  const urls = { water: 'x/rough.webp', wind: 'x/wind.webp', cloud: 'x/cloud.webp' } as const;
  // The pure trades in doubled angle: the NE trade blows toward the
  // south-west, theta 225 degrees, 2 theta 90: (0, +1); the SE trade toward
  // the north-west, theta 135, 2 theta 270: (0, -1). Calm across the equator.
  const trades = (lat: number): [number, number] => (lat > 5 ? [0, 1] : lat < -5 ? [0, -1] : [0, 0]);
  /** The axis the CPU reads at the NE trades (15 N 150 W) and at the SE
   *  trades (15 S 150 W), through the shader's own equirect mapping. */
  async function readTrades(axisAt: (lat: number, lon: number) => [number, number]): Promise<{ ne: [number, number]; se: [number, number] }> {
    const maps = new EarthSurfaceMaps(urls, axisPicture(axisAt), { width: 72, height: 36 });
    maps.request();
    await new Promise((r) => setTimeout(r, 20));
    expect(maps.ready).toBe(true);
    const out = { water: 0, windMs: 0, cloudKeep: 1, deckKeep: 1, axisX: 0, axisY: 0 };
    const ne = dirAt(15, -150);
    maps.sampleAt(ne[0], ne[1], ne[2], 0, out);
    const neAxis: [number, number] = [out.axisX, out.axisY];
    expect(out.windMs).toBeCloseTo(8, 0);
    const se = dirAt(-15, -150);
    maps.sampleAt(se[0], se[1], se[2], 0, out);
    return { ne: neAxis, se: [out.axisX, out.axisY] };
  }
  const handed = ({ ne, se }: { ne: [number, number]; se: [number, number] }): boolean =>
    Math.abs(ne[0]) < 0.01 && Math.abs(ne[1] - 1) < 0.01 && Math.abs(se[0]) < 0.01 && Math.abs(se[1] + 1) < 0.01;

  it('decodes the NE trades to (0, +1) and the SE trades to (0, -1), and a mirrored or swapped picture fails that', async () => {
    const read = await readTrades(trades);
    expect(read.ne[0]).toBeCloseTo(0, 6);
    expect(read.ne[1]).toBeCloseTo(1, 6);
    expect(read.se[0]).toBeCloseTo(0, 6);
    expect(read.se[1]).toBeCloseTo(-1, 6);
    expect(handed(read)).toBe(true);
    // The same field written north for south — a picture whose rows were
    // not flipped — reads each trade as the other's: the check catches it.
    expect(handed(await readTrades((lat) => trades(-lat)))).toBe(false);
    // And green and blue swapped: the trades read east-west.
    expect(handed(await readTrades((lat) => { const [x1, x2] = trades(lat); return [x2, x1]; }))).toBe(false);
  });

  it('reads no axis from a wind map installed alone, and none while a map is missing', async () => {
    const maps = new EarthSurfaceMaps(urls, axisPicture(trades), { width: 72, height: 36 });
    const out = { water: 0, windMs: 0, cloudKeep: 1, deckKeep: 1, axisX: 0.5, axisY: 0.5 };
    maps.sampleAt(1, 0, 0, 0, out);
    expect([out.axisX, out.axisY]).toEqual([0, 0]);
    maps.request();
    await new Promise((r) => setTimeout(r, 20));
    maps.install('wind', grid(72, 36, () => 0.5));
    const ne = dirAt(15, -150);
    maps.sampleAt(ne[0], ne[1], ne[2], 0, out);
    expect([out.axisX, out.axisY]).toEqual([0, 0]);
    expect(out.windMs).toBeCloseTo(8, 1);
  });

  it("holds the shipped map's bytes at ten named points to the source's axis over each texel, within a byte", () => {
    // tools/gen-seawind.mjs writes these: per point the shipped map's bytes
    // at the texel holding it, read back from the decoded webp, beside the
    // quarter-degree source averaged over that texel's footprint straight
    // from the unrolled file, and the source cell nearest the point. A roll,
    // a row flip or a G/B swap in the shipped file moves the bytes away from
    // both. The footprint is the check (the texel IS its footprint, to the
    // byte); the nearest cell differs from it by a few bytes where the wind
    // turns inside a texel (the equator, the doldrums), so it is held more
    // loosely.
    interface Point {
      name: string;
      latDeg: number;
      lonDeg: number;
      nearestCell: { windMs: number; x1: number; x2: number };
      footprint: { windMs: number; x1: number; x2: number; unfilled: number };
      map: { column: number; row: number; bytes: [number, number, number, number] };
    }
    const golden = JSON.parse(readFileSync('tools/goldens/seawind/earth-seawind.v2.points.json', 'utf8')) as {
      map: string; sha256: string; width: number; height: number; points: Point[];
    };
    // The bytes are the shipped file's.
    expect(golden.map).toBe(PLANET_TEXTURE_FILES.earthSeaWind);
    const shipped = readFileSync(`public/textures/${PLANET_TEXTURE_FILES.earthSeaWind}`);
    expect(createHash('sha256').update(shipped).digest('hex')).toBe(golden.sha256);
    expect(golden.points).toHaveLength(10);
    const byte = 1 / 127 + 1e-9;
    for (const point of golden.points) {
      const [r, g, b, a] = point.map.bytes;
      // The texel holding the point, as the shader's u = (lon + 180) / 360
      // and v from the south read it.
      expect(point.map.column, point.name).toBe(Math.floor(((point.lonDeg + 180) / 360) * golden.width) % golden.width);
      expect(point.map.row, point.name).toBe(Math.floor(((point.latDeg + 90) / 180) * golden.height));
      expect(a, point.name).toBe(255);
      expect(point.footprint.unfilled, point.name).toBe(0);
      expect(Math.abs(seaWindAxisFromByte(g) - point.footprint.x1), point.name).toBeLessThanOrEqual(byte);
      expect(Math.abs(seaWindAxisFromByte(b) - point.footprint.x2), point.name).toBeLessThanOrEqual(byte);
      expect(Math.abs((r / 255) * SEA_WIND_MAX_MS - point.footprint.windMs), point.name).toBeLessThanOrEqual(SEA_WIND_MAX_MS / 255 + 1e-9);
      expect(Math.abs(seaWindAxisFromByte(g) - point.nearestCell.x1), point.name).toBeLessThan(0.05);
      expect(Math.abs(seaWindAxisFromByte(b) - point.nearestCell.x2), point.name).toBeLessThan(0.05);
    }
    // And what the data say at them, in the doubled angle's terms: the NE
    // trades lean north of the parallel (x2 > 0), the SE trades blow nearly
    // due west (x2 near 0, a mirror at most), the Southern Ocean westerly is
    // east-west (x1 > 0), and the Arabian Sea's two monsoons, opposite
    // vectors, keep one strong axis (|x| > 0.85) where a plain mean would
    // cancel.
    const at = (name: string): [number, number] => {
      const bytes = golden.points.find((point) => point.name === name)!.map.bytes;
      return [seaWindAxisFromByte(bytes[1]), seaWindAxisFromByte(bytes[2])];
    };
    expect(at('ne-trades')[1]).toBeGreaterThan(0.3);
    expect(at('se-trades')[1]).toBeLessThan(at('ne-trades')[1]);
    expect(at('southern-westerly')[0]).toBeGreaterThan(0.5);
    expect(Math.abs(at('southern-westerly')[1])).toBeLessThan(0.15);
    expect(Math.hypot(...at('arabian-sea'))).toBeGreaterThan(0.85);
  });
});

const cross3 = (a: readonly number[], b: readonly number[]): [number, number, number] =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a: readonly number[]): [number, number, number] => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** A unit direction in the mesh's frame for a latitude and longitude, through
 *  the shader's own equirect mapping inverted: u = lon from the map's left
 *  edge, v from the south. */
function dirAt(latDeg: number, lonDeg: number): [number, number, number] {
  // sphereEquirectUv: u = atan2(z, -x) / 2π wrapped, v = 0.5 + asin(y) / π.
  const v = 0.5 + (latDeg * Math.PI) / 180 / Math.PI;
  const u = (lonDeg + 180) / 360;
  const y = Math.sin((v - 0.5) * Math.PI);
  const r = Math.sqrt(Math.max(1 - y * y, 0));
  const ang = u * 2 * Math.PI;
  const x = -r * Math.cos(ang);
  const z = r * Math.sin(ang);
  const back = sphereEquirectUv(x, y, z);
  if (Math.abs(back[0] - (u - Math.floor(u))) > 1e-6 || Math.abs(back[1] - v) > 1e-6) throw new Error('dirAt does not invert sphereEquirectUv');
  return [x, y, z];
}
