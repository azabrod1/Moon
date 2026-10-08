/**
 * Earth's surface maps on the CPU, coarsely: the water fraction, the sea's
 * wind (its speed, and its axis from the same picture), and the cloud deck's
 * coverage, each decoded once per session to a small equirect grid (360 x 180
 * by default) and sampled bilinearly, so a term that runs on the main thread
 * each frame — the highlight meter's prediction of the sea's beam
 * (world/glintMeter) — can read what the shader reads without a readback.
 *
 * The shipped textures go to the GPU as image bitmaps and keep no bytes, so
 * these are decoded again from the same files, lazily, on the first call for
 * them: a `createImageBitmap` with the browser's own downscale, drawn once
 * onto a small canvas and read back, about a millisecond of main thread per
 * map. Until a map has landed the sampler answers as if the surface were not
 * there (no water, no cloud), which holds the meter at one; nothing is
 * stepped when it arrives because the meter eases in stops.
 *
 * The coarse grid is a box of the texture, which is the right estimator for
 * what the shader mixes linearly (the water fraction) and near enough for
 * the rest — the bake measures a box of the wind map's speed against the
 * mean of what its texels draw, under half a percent on average down to
 * 16-texel blocks (tools/goldens/seawind), so a box of it is the wind the
 * shader's own mips read. The axis comes from the SAME decode of the wind's
 * picture as the speed (its green and blue, which with the picture's alpha
 * opaque come through the canvas exactly): two more coarse maps of the raw
 * bytes, decoded (byte - 128) / 127 only at sample time, which is exact
 * because that decode is affine and so commutes with the box and with the
 * bilinear read. The meter reads the speed alone; the axis is there for the
 * glint's ellipse along the wind. The box also removes the texel-to-texel
 * swing that would otherwise move the exposure from one frame to the next as
 * the ground slides under the mirror point. The equirect convention is the shader's
 * (`sphereEquirectUv` in world/cloudDeck): u wraps, v is the latitude from the
 * south, and a decoded picture is north-up, so rows are read flipped.
 *
 * The deck is read in two ways: straight over a ground point (`sampleAt`), and
 * where a ray from the point crosses the deck's shell (`keepToward`), which is
 * where the ground's cloud shadow reads it on the way to the Sun and where the
 * drawn deck stands in the line of sight on the way to the camera.
 */
import { cloudCoverageAlpha } from './cloudDeck';
import { ROUGHNESS_MAP_LAND, ROUGHNESS_MAP_WATER } from './surfaceShading';
import { SEA_WIND_MAX_MS, seaWindAxisFromByte } from './seaWind';
import type { SurfaceSample } from './glintMeter';

/** One channel of a map, bytes, row 0 the SOUTH (the shader's v = 0). */
export interface CoarseMap {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export const COARSE_MAP_WIDTH = 360;
export const COARSE_MAP_HEIGHT = 180;

/** Bilinear read of a coarse map at the shader's (u, v): u wrapping, v
 *  clamped, the result in 0..1. */
export function sampleCoarse(map: CoarseMap, u: number, v: number): number {
  const w = map.width, h = map.height;
  const x = (u - Math.floor(u)) * w - 0.5;
  const y = Math.min(Math.max(v, 0), 1) * h - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const xa = ((x0 % w) + w) % w, xb = (xa + 1) % w;
  const ya = Math.min(Math.max(y0, 0), h - 1), yb = Math.min(Math.max(y0 + 1, 0), h - 1);
  const d = map.data;
  const top = d[ya * w + xa] * (1 - fx) + d[ya * w + xb] * fx;
  const bot = d[yb * w + xa] * (1 - fx) + d[yb * w + xb] * fx;
  return (top * (1 - fy) + bot * fy) / 255;
}

/** A coarse map from RGBA bytes of a north-up picture: one channel, or the
 *  linear luminance through the coverage law for the cloud map, averaged
 *  over the box of source texels each coarse texel covers, rows flipped so
 *  row 0 is the south. */
export function coarseFromRgba(
  rgba: ArrayLike<number>, width: number, height: number,
  pick: (r: number, g: number, b: number) => number,
  outWidth = COARSE_MAP_WIDTH, outHeight = COARSE_MAP_HEIGHT,
): CoarseMap {
  const data = new Uint8Array(outWidth * outHeight);
  for (let oy = 0; oy < outHeight; oy++) {
    // Coarse row oy is the south-up row; source rows run north-up.
    const sy0 = Math.floor(((outHeight - 1 - oy) * height) / outHeight);
    const sy1 = Math.max(Math.floor(((outHeight - oy) * height) / outHeight), sy0 + 1);
    for (let ox = 0; ox < outWidth; ox++) {
      const sx0 = Math.floor((ox * width) / outWidth);
      const sx1 = Math.max(Math.floor(((ox + 1) * width) / outWidth), sx0 + 1);
      let sum = 0, n = 0;
      for (let y = sy0; y < sy1; y++) {
        for (let x = sx0; x < sx1; x++) {
          const i = (y * width + x) * 4;
          sum += pick(rgba[i], rgba[i + 1], rgba[i + 2]);
          n++;
        }
      }
      data[oy * outWidth + ox] = Math.round(Math.min(Math.max(sum / n, 0), 1) * 255);
    }
  }
  return { width: outWidth, height: outHeight, data };
}

const srgbToLinear = (byte: number): number => {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};

/** The water fraction from the roughness map's red, as the shader derives it. */
export const pickWater = (r: number): number =>
  Math.min(Math.max((ROUGHNESS_MAP_LAND - r / 255) / (ROUGHNESS_MAP_LAND - ROUGHNESS_MAP_WATER), 0), 1);
/** The wind's speed: the map's red as it is. */
export const pickRed = (r: number): number => r / 255;
/** The wind's axis, its two bytes raw (decoded at sample time). */
export const pickGreen = (_r: number, g: number): number => g / 255;
export const pickBlue = (_r: number, _g: number, b: number): number => b / 255;
/** The deck's coverage from the cloud picture's linear luminance. */
export const pickCloudCoverage = (r: number, g: number, b: number): number =>
  cloudCoverageAlpha(0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b));

/** Decode a picture to RGBA bytes at a small size on the main thread: the
 *  browser's own resize inside `createImageBitmap` where it honours it, else
 *  the canvas draw scales. A millisecond or so, once. */
export async function decodePictureRgba(url: string, width: number, height: number): Promise<{ rgba: Uint8ClampedArray; width: number; height: number }> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`surfaceMaps: ${url} ${response.status}`);
  const blob = await response.blob();
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high', colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  } catch {
    bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  }
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!ctx) throw new Error('surfaceMaps: no 2d context');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const image = ctx.getImageData(0, 0, width, height);
  return { rgba: image.data, width, height };
}

export type EarthMapKind = 'water' | 'wind' | 'cloud';
const EARTH_MAP_KINDS: readonly EarthMapKind[] = ['water', 'wind', 'cloud'];

/** The three maps for one body, loaded lazily and sampled together. */
export class EarthSurfaceMaps {
  private maps: Partial<Record<EarthMapKind, CoarseMap>> = {};
  /** The wind's axis, its green and its blue as raw bytes, from the wind's
   *  own decode; absent (no axis) for a wind map installed alone. */
  private windAxis: { x: CoarseMap; y: CoarseMap } | null = null;
  /** The deck's drift last turned through, with its cosine and sine: a
   *  frame asks for one drift a few hundred times. */
  private spin = 0;
  private spinCos = 1;
  private spinSin = 0;
  private loading: Partial<Record<EarthMapKind, Promise<void>>> = {};
  private failed = new Set<EarthMapKind>();

  constructor(
    private readonly urls: Readonly<Record<EarthMapKind, string>>,
    private readonly decode: (url: string, w: number, h: number) => Promise<{ rgba: ArrayLike<number>; width: number; height: number }> = decodePictureRgba,
    private readonly size: { width: number; height: number } = { width: COARSE_MAP_WIDTH, height: COARSE_MAP_HEIGHT },
  ) {}

  /** Whether every map is here. */
  get ready(): boolean {
    return !!(this.maps.water && this.maps.wind && this.maps.cloud);
  }

  /** Which maps are here, which failed. */
  state(): { ready: EarthMapKind[]; failed: EarthMapKind[]; loading: EarthMapKind[] } {
    return {
      ready: EARTH_MAP_KINDS.filter((k) => !!this.maps[k]),
      failed: EARTH_MAP_KINDS.filter((k) => this.failed.has(k)),
      loading: EARTH_MAP_KINDS.filter((k) => !!this.loading[k] && !this.maps[k] && !this.failed.has(k)),
    };
  }

  /** Start the decodes that have not started; returns at once. */
  request(): void {
    for (const kind of EARTH_MAP_KINDS) {
      if (this.maps[kind] || this.loading[kind] || this.failed.has(kind)) continue;
      // The source picture is decoded at twice the coarse grid so the box
      // the coarse texel averages holds four source texels, a real box.
      const w = this.size.width * 2, h = this.size.height * 2;
      this.loading[kind] = this.decode(this.urls[kind], w, h).then((pic) => {
        const pick = kind === 'water' ? pickWater : kind === 'cloud' ? pickCloudCoverage : pickRed;
        const coarse = (picker: typeof pick): CoarseMap =>
          coarseFromRgba(pic.rgba, pic.width, pic.height, picker, this.size.width, this.size.height);
        if (kind === 'wind') this.windAxis = { x: coarse(pickGreen), y: coarse(pickBlue) };
        this.maps[kind] = coarse(pick);
      }).catch(() => { this.failed.add(kind); });
    }
  }

  private turnTo(spin: number): void {
    if (spin === this.spin) return;
    this.spin = spin;
    this.spinCos = Math.cos(spin);
    this.spinSin = Math.sin(spin);
  }

  /** Install a map decoded elsewhere (a test, a served override). A wind
   *  map installed this way is the speed alone: no axis. */
  install(kind: EarthMapKind, map: CoarseMap): void {
    this.maps[kind] = map;
    if (kind === 'wind') this.windAxis = null;
  }

  /**
   * The sample at a unit direction in the body's own frame (the mesh's local
   * axes), with the deck's drift for the cloud; a surface with a map missing
   * reads as no water or no cloud, which is the meter's hold. Without
   * `cloudOver` the deck straight over the point is not read and the keep is
   * left at one, for a caller that reads the deck elsewhere (keepToward).
   */
  sampleAt(nx: number, ny: number, nz: number, cloudSpin: number, out: SurfaceSample, cloudOver = true): void {
    const water = this.maps.water, wind = this.maps.wind, cloud = this.maps.cloud;
    if (!water || !wind || !cloud) {
      out.water = 0; out.windMs = 0; out.cloudKeep = 1; out.axisX = 0; out.axisY = 0;
      return;
    }
    // sphereEquirectUv and bodyToDeck (world/cloudDeck), inlined so a frame
    // allocates nothing; the tests hold this against those functions.
    const u0 = Math.atan2(nz, -nx) / (2 * Math.PI);
    const u = u0 - Math.floor(u0);
    const v = 0.5 + Math.asin(Math.min(1, Math.max(-1, ny))) / Math.PI;
    out.water = sampleCoarse(water, u, v);
    out.windMs = sampleCoarse(wind, u, v) * SEA_WIND_MAX_MS;
    const axis = this.windAxis;
    out.axisX = axis ? seaWindAxisFromByte(sampleCoarse(axis.x, u, v) * 255) : 0;
    out.axisY = axis ? seaWindAxisFromByte(sampleCoarse(axis.y, u, v) * 255) : 0;
    if (!cloudOver) { out.cloudKeep = 1; return; }
    this.turnTo(cloudSpin);
    const c = this.spinCos, sn = this.spinSin;
    const dx = c * nx - sn * nz, dz = sn * nx + c * nz;
    const du0 = Math.atan2(dz, -dx) / (2 * Math.PI);
    out.cloudKeep = 1 - sampleCoarse(cloud, du0 - Math.floor(du0), v);
  }

  /**
   * The share the deck lets through where the ray from the ground point n
   * toward the unit direction d crosses its shell, `hOverR` above the ground
   * in radii, with the deck's drift: 1 with no cloud map. cloudRayDirection,
   * bodyToDeck and sphereEquirectUv (world/cloudDeck), inlined so a frame
   * allocates nothing; the tests hold this against those functions.
   */
  keepToward(nx: number, ny: number, nz: number, dx: number, dy: number, dz: number, hOverR: number, cloudSpin: number): number {
    const cloud = this.maps.cloud;
    if (!cloud) return 1;
    const mu = nx * dx + ny * dy + nz * dz;
    const k = hOverR * (2 + hOverR);
    const root = Math.sqrt(mu * mu + k);
    const t = mu >= 0 ? k / (root + mu) : root - mu;
    let qx = nx + t * dx, qy = ny + t * dy, qz = nz + t * dz;
    const len = Math.hypot(qx, qy, qz);
    qx /= len; qy /= len; qz /= len;
    this.turnTo(cloudSpin);
    const c = this.spinCos, sn = this.spinSin;
    const ex = c * qx - sn * qz, ez = sn * qx + c * qz;
    const u0 = Math.atan2(ez, -ex) / (2 * Math.PI);
    const v = 0.5 + Math.asin(Math.min(1, Math.max(-1, qy))) / Math.PI;
    return 1 - sampleCoarse(cloud, u0 - Math.floor(u0), v);
  }
}
