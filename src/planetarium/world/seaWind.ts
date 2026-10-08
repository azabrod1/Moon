/**
 * The wind over the sea, as the mirror lobe the ocean is drawn with.
 *
 * A glint is a picture of the wind. The slope of a wind-roughened sea is close
 * to Gaussian with a mean square that grows with the wind (Cox and Munk, 1954:
 * 0.003 + 0.00512 U, U the wind in m/s), so the lobe the sea reflects the Sun
 * through is narrow and bright where the wind has dropped and wide and faint
 * where it blows. Where the wind field varies faster than the lobe is wide
 * (about 20 degrees of facet tilt at trade winds) the glint's shape is the
 * field's; where it varies slower, the shape is the lobe's, which on a sphere
 * is a circle. One roughness for the whole sea draws the circle.
 *
 * So the sea reads, per fragment, a baked map of the wind
 * (textures/earth-seawind.v2.webp, 1024x512, four bytes a texel, row 0 the
 * south), shipped by `npm run gen:seawind` from NOAA NCEI's Blended Sea Winds
 * monthly climatology, 1991-2020 (tools/gen-seawind.mjs):
 *   R  the annual mean scalar wind over SEA_WIND_MAX_MS;
 *   G, B  the wind's AXIS in doubled angle, (byte - 128) / 127 each, so 128
 *         is exactly no axis (tools/seaWindMap.mjs says how it is weighted
 *         and why the angle is doubled);
 *   A  opaque, never data.
 * The surface shader reads R and draws one Beckmann lobe at Cox-Munk's
 * mean-square slope for that wind — Beckmann with alpha² = mss IS the
 * Gaussian slope law, and three's GGX has a heavy tail that spread the sheen
 * into haze — in place of three's one GGX lobe (world/surfaceShading). The
 * axis is carried for the lobe's ellipse along the wind and is not read by
 * the shader yet; the CPU's coarse copies (world/surfaceMaps) decode it
 * already. The map is mip-chained: averaging winds is biased only where a
 * block holds very different winds, and the bake measures that on the map it
 * ships, for the speed and for the anisotropy the shader will build from two
 * channels (tools/goldens/seawind/earth-seawind.v2.stats.json: under half a
 * percent on average at every level, against the bar of three percent the
 * test holds it to). The mask the roughness map carries still says where
 * there is sea at all, so land and a coast's fraction are untouched.
 *
 * The map arrives like Earth's other detail maps (PlanetFactory's
 * loadTexture), as the 'data' kind of world/texturePolicy — linear, every
 * channel kept; a one-channel 'mask' upload would drop the axis — and is
 * installed here on a shared uniform every augmented material carries. Until
 * it has landed the sea is drawn at OCEAN_ROUGHNESS, the one width; a map
 * that misses the boot's timeout lands late through the same seam the
 * roughness map does.
 *
 * One rule for a map with no axis: G = B = 128 and A = 255, exactly
 * isotropic (`seaWindRgbaFromSpeed`), applied to a raw byte map and to a
 * picture that is grey at every texel, so every map this module builds is
 * RGBA and no uniform says whether there is an axis.
 *
 * `?seawind=0` (any build) draws the whole sea at OCEAN_ROUGHNESS with three's
 * own lobe — the kill switch, and the A/B against the one-width sea. The DEV
 * `?seawindmap=<url>` reads the map from a file instead of the shipped one (a
 * picture whose red is the wind and whose green and blue are the axis, as the
 * bake's `--png` writes one; a grey picture is the wind alone; or a raw byte
 * map of one wind a texel), and `?glint=` / `__moon.glint` force one width,
 * or move the scale and the cap, live.
 */
import * as THREE from 'three';
import { applyTextureDefaults } from './texturePolicy';

/** Cox-Munk's mean-square slope of a clean sea: this at no wind, and this much
 *  more per metre a second. tools/seaWindField.mjs and the surface shader
 *  carry the same two numbers, and the tests hold them to these. */
export const COX_MUNK_SLOPE_CALM = 0.003;
export const COX_MUNK_SLOPE_PER_MS = 0.00512;

/** The wind the map's full scale stands for, m/s: past a gale the sheen has
 *  stopped changing. */
export const SEA_WIND_MAX_MS = 16;

/** Cox-Munk's mean-square slope at a wind. */
export function meanSquareSlope(windMs: number): number {
  return COX_MUNK_SLOPE_CALM + COX_MUNK_SLOPE_PER_MS * Math.max(windMs, 0);
}

/**
 * The roughness a sea under this wind is drawn at: alpha as the root of
 * Cox-Munk's mean-square slope, roughness as alpha's root, because three
 * squares the roughness into alpha. With the Beckmann lobe the shader draws
 * this is exact — alpha² is the mean-square slope — and it lands the roughness
 * map's own 0.45 at a 7 m/s sea, the mean over the ocean.
 */
export function windRoughness(windMs: number): number {
  return Math.pow(meanSquareSlope(windMs), 0.25);
}

/** The axis's bytes: 128 + round(127 x) a channel, read back (byte - 128) /
 *  127, so 128 is exactly no axis and the decode is affine (a mip of the
 *  bytes is the mip of the axis). tools/seaWindMap.mjs writes them. */
export const SEA_WIND_AXIS_ZERO = 128;
export const SEA_WIND_AXIS_SCALE = 127;

/** One component of the wind's axis from its byte, or from a mean of bytes
 *  (a box or a bilinear read of them): affine, so the mean decodes too. */
export function seaWindAxisFromByte(byte: number): number {
  return (byte - SEA_WIND_AXIS_ZERO) / SEA_WIND_AXIS_SCALE;
}

/** A map's bytes as the shader reads them: four a texel, row 0 the south
 *  pole — R the wind over SEA_WIND_MAX_MS, G and B the wind's axis, A 255. */
export interface SeaWindMapBytes {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * The one rule for a map with no axis: the wind, one byte a texel, into the
 * map's four bytes with G = B = 128 (exactly isotropic) and A = 255. The row
 * order is kept.
 */
export function seaWindRgbaFromSpeed(speed: ArrayLike<number>, width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let texel = 0; texel < width * height; texel++) {
    data[texel * 4] = speed[texel];
    data[texel * 4 + 1] = SEA_WIND_AXIS_ZERO;
    data[texel * 4 + 2] = SEA_WIND_AXIS_ZERO;
    data[texel * 4 + 3] = 255;
  }
  return data;
}

/**
 * A decoded picture of the map — RGBA, north-up as a canvas reads it — into
 * the map's bytes, row 0 the south. A picture whose green and blue equal its
 * red at EVERY texel is grey, the wind alone (a speed-only picture from
 * before the axis): it gets the rule for a map with no axis. Any other keeps
 * its red, green and blue, and its alpha is set to 255.
 */
export function seaWindBytesFromRgba(rgba: ArrayLike<number>, width: number, height: number): SeaWindMapBytes {
  let grey = true;
  for (let texel = 0; texel < width * height && grey; texel++) {
    const red = rgba[texel * 4];
    grey = rgba[texel * 4 + 1] === red && rgba[texel * 4 + 2] === red;
  }
  const flipped = new Uint8Array(width * height * 4);
  for (let pictureRow = 0; pictureRow < height; pictureRow++) {
    const row = height - 1 - pictureRow;
    for (let column = 0; column < width; column++) {
      const from = (pictureRow * width + column) * 4;
      const to = (row * width + column) * 4;
      flipped[to] = rgba[from];
      flipped[to + 1] = rgba[from + 1];
      flipped[to + 2] = rgba[from + 2];
      flipped[to + 3] = 255;
    }
  }
  if (!grey) return { data: flipped, width, height };
  const speed = new Uint8Array(width * height);
  for (let texel = 0; texel < width * height; texel++) speed[texel] = flipped[texel * 4];
  return { data: seaWindRgbaFromSpeed(speed, width, height), width, height };
}

/** A raw wind map is one byte a texel — the wind alone, no axis — with the
 *  width twice the height, so its size says its shape (2048x1024, 1440x720,
 *  1024x512), or it has no shape. A raw map of four bytes a texel cannot be
 *  told apart this way (1024x512 at four bytes is 2048x1024 at one), so a
 *  raw map is always read as one byte a texel; a map with an axis comes as a
 *  picture. */
export function seaWindMapDimensions(byteLength: number): { width: number; height: number } | null {
  const width = Math.round(Math.sqrt(byteLength * 2));
  const height = width / 2;
  return Number.isInteger(height) && height >= 1 && width * height === byteLength ? { width, height } : null;
}

let mipsEnabled = true;

/** `?seawindmips=0` (DEV only): the map with no mip chain, sampled at its
 *  full resolution from any distance — the A/B for whether the chain is
 *  eating the structure. */
export function setSeaWindMips(on: boolean): void {
  mipsEnabled = on;
}

/**
 * How the sea samples the map: repeat-wrapped around the date line and
 * clamped at the poles, mip-chained because the sea is looked at from a
 * whole-disc distance where a texel is well under a pixel. Applied to the
 * shipped map on arrival and to a texture built from bytes; a map already
 * uploaded is re-uploaded once.
 */
export function applySeaWindSampling(tex: THREE.Texture): THREE.Texture {
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = mipsEnabled ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.generateMipmaps = mipsEnabled;
  tex.needsUpdate = true;
  return tex;
}

/** A map's bytes as a texture: four bytes a texel (RGBA), row 0 the south;
 *  any other byte count is refused, because the expansion of a map with no
 *  axis is `seaWindRgbaFromSpeed`'s and nobody else's. Data, not colour — an
 *  sRGB decode would bend the numbers. */
export function seaWindTextureFrom(map: SeaWindMapBytes): THREE.DataTexture {
  if (map.data.length !== map.width * map.height * 4) {
    throw new Error(`sea wind map: ${map.data.length} bytes for ${map.width}x${map.height} is not four a texel`);
  }
  const tex = new THREE.DataTexture(map.data, map.width, map.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  applyTextureDefaults(tex, 'data');
  // Four bytes a texel already aligns every row; one says so for any width.
  tex.unpackAlignment = 1;
  applySeaWindSampling(tex);
  return tex;
}

let installed: THREE.Texture | null = null;
let mapSource = 'none';
let overrideRequested = false;

/**
 * The map the sea reads, once one is installed — the shipped one on arrival
 * (PlanetFactory), or a DEV override's — and null before that. Bound by every
 * augmented material through a shared uniform (world/surfaceShading's
 * seaWindUniforms); the installer's caller rebinds the seas already drawn.
 */
export function seaWindTexture(): THREE.Texture | null {
  return installed;
}

/** Which map the sea reads: 'none' before one lands, 'shipped', or the DEV
 *  `?seawindmap=` file's URL. */
export function seaWindMapSource(): string {
  return installed ? mapSource : 'none';
}

/**
 * Put the map in place: the shipped one (`source` 'shipped'), or one from a
 * file. Returns the texture now installed, or null when it was refused — a
 * shipped arrival after a DEV override was asked for, whichever of the two
 * lands first, so a sheet captured through `?seawindmap=` never shows the
 * shipped map. The previous map is retired, to be disposed once the sea is
 * rebound to its successor; a refused one is the caller's.
 */
export function installSeaWindMap(tex: THREE.Texture, source: string): THREE.Texture | null {
  if (source === 'shipped' && overrideRequested) return null;
  const previous = installed;
  installed = tex;
  mapSource = source;
  if (previous && previous !== tex) retired.push(previous);
  return tex;
}

/** The maps an install replaced, disposed once the sea's uniform points at
 *  their successor (`rebindSeaWindMap` calls this after binding): a map
 *  disposed while still bound would be re-uploaded from a bitmap its dispose
 *  listener has closed. */
const retired: THREE.Texture[] = [];
export function disposeRetiredSeaWindMaps(): void {
  for (const tex of retired.splice(0)) tex.dispose();
}

/** `?seawindmap=<url>` (DEV only): the sea's map from a file instead of the
 *  shipped one — a picture, north-up, whose red is the wind over
 *  SEA_WIND_MAX_MS and whose green and blue are the axis (the bake's `--png`
 *  form; a grey picture is the wind alone), or a raw byte map of one wind a
 *  texel — so a field baked elsewhere or a real wind day is judged in the
 *  app under its own clouds and air. Asking for one refuses the shipped map
 *  from then on. */
export function parseSeaWindMapParam(search: string): string | null {
  const url = new URLSearchParams(search).get('seawindmap') || null;
  if (url && import.meta.env.DEV) overrideRequested = true;
  return url;
}

/** The pixels of a picture, through a 2D canvas: a whole-image read, once. */
function readPicture(source: CanvasImageSource, width: number, height: number): Uint8ClampedArray {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('sea wind map: no 2d context to read the picture through');
  context.drawImage(source, 0, 0);
  return context.getImageData(0, 0, width, height).data;
}

/**
 * Fetch a map for the override. A picture (.png, .webp, .jpg) carries the
 * wind in its red and the axis in its green and blue, or is grey, the wind
 * alone (`seaWindBytesFromRgba`); anything else is a raw wind map, wind over
 * SEA_WIND_MAX_MS a byte, row 0 the south, its shape read off its size, with
 * no axis. Development only.
 */
export async function loadSeaWindMap(url: string): Promise<SeaWindMapBytes> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`sea wind map: ${url} answered ${response.status}`);
  if (/\.(png|webp|jpe?g)(\?.*)?$/i.test(url)) {
    const bitmap = await createImageBitmap(await response.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    try {
      return seaWindBytesFromRgba(readPicture(bitmap, bitmap.width, bitmap.height), bitmap.width, bitmap.height);
    } finally {
      bitmap.close();
    }
  }
  const speed = new Uint8Array(await response.arrayBuffer());
  const shape = seaWindMapDimensions(speed.byteLength);
  if (!shape) throw new Error(`sea wind map: ${url} is ${speed.byteLength} bytes, not a width x width/2 byte map`);
  return { data: seaWindRgbaFromSpeed(speed, shape.width, shape.height), ...shape };
}

/** The `?seawind=0` kill switch, on any build: the whole sea at one width, in
 *  the house style of `?fused=0` and `?ride=0`. */
export function parseSeaWindParam(search: string): boolean {
  return new URLSearchParams(search).get('seawind') !== '0';
}
