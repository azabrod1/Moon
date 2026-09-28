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
 * is a circle. One roughness for the whole sea draws the circle; so did a
 * field of zonal means with broad structure on top, as a featureless round
 * glow. What EPIC's frames show is a broad faint sheen from the trade-wind
 * sea, a bright irregular core wherever a calm region sits under the specular
 * point, and dark calm lanes off-centre.
 *
 * So the sea reads, per fragment, a baked pair of maps of a bimodal, streaked
 * wind field (tools/seaWindField.mjs, shipped by `npm run gen:seawind`), and
 * the pair holds not one wind but a MIXTURE:
 *   the CALM map (textures/earth-seawind-calm.v1.webp, 2048x1024): the calm
 *     weight w, the share of the texel's sea that is glassy, held against a
 *     reference lobe (Cox-Munk at SEA_CALM_LOBE_WIND_MS);
 *   the WINDY map (textures/earth-seawind-windy.v1.webp, 1024x512): the
 *     windy speed U_w of the rest of it, over SEA_WIND_MAX_MS, a smooth field
 *     of the open sea with nothing finer than a degree in it.
 * The surface shader draws w * lobe(calm) + (1 - w) * lobe(U_w), two Beckmann
 * lobes — Beckmann with alpha² = mss IS the Gaussian slope law, and three's
 * GGX has a heavy tail that spread the sheen into haze — in place of three's
 * one GGX lobe (world/surfaceShading). A mixture because reflectance is
 * linear in w, so a box-filtered mip of the calm map is exact at every angle,
 * and the windy map is smooth enough that its mips are near-exact; a mip of a
 * WIND is biased, a block of glassy and windy texels averaging to a middling
 * wind that renders at two thirds of the brightness the block has. Two files
 * because the bytes said so (the generator's header has the numbers). The
 * mask the roughness map carries still says where there is sea at all, so
 * land and a coast's fraction are untouched, and a coast's calm weight is
 * scaled by its water fraction.
 *
 * Both maps are grey pictures and arrive like Earth's other detail maps
 * (PlanetFactory's loadTexture, the one-channel 'mask' kind of
 * world/texturePolicy: one byte a texel where the device takes the upload),
 * and are installed here on two shared uniforms every augmented material
 * carries. Until both have landed the sea is drawn at OCEAN_ROUGHNESS, the
 * one width; a map that misses the boot's timeout lands late through the same
 * seam the roughness map does.
 *
 * `?seawind=0` (any build) draws the whole sea at OCEAN_ROUGHNESS with three's
 * own lobe — the kill switch, and the A/B against the one-width sea. The DEV
 * `?seawindmap=<url>` reads a map from a file instead of the shipped pair (a
 * picture with the calm weight in red and the windy speed in green, as the
 * bake job's `--rgb` writes one, or a raw byte map of one wind a texel), and
 * `?glint=` / `__moon.glint` force one width, or move the calm lobe and the
 * cap, live.
 */
import * as THREE from 'three';
import { applyTextureDefaults } from './texturePolicy';

/** Cox-Munk's mean-square slope of a clean sea: this at no wind, and this much
 *  more per metre a second. tools/seaWindField.mjs and the surface shader
 *  carry the same two numbers, and the tests hold them to these. */
export const COX_MUNK_SLOPE_CALM = 0.003;
export const COX_MUNK_SLOPE_PER_MS = 0.00512;

/** The wind the windy map's full scale stands for, m/s: past a gale the
 *  sheen has stopped changing. */
export const SEA_WIND_MAX_MS = 16;

/**
 * The glassy lobe the calm weight is measured against: Cox-Munk at this wind,
 * mss 0.00607, whose peak is 0.83 of white at normal incidence and whose
 * half-maximum sits at 3.7 degrees of facet tilt. The generator's reference
 * (tools/seaWindField.mjs DEFAULTS.calmReferenceWindMs) is the same number,
 * so a weight of one draws the sea the design put there; the DEV
 * `__moon.glint({calm})` moves the lobe alone, as a look knob on the cores.
 * Cox-Munk's zero-wind floor is an extrapolation of their fit — a truly
 * glassy sea is calmer than 0.003 — which is why the knob also takes an mss.
 */
export const SEA_CALM_LOBE_WIND_MS = 0.6;

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

/** A mean-square slope as the roughness the shader holds a lobe as, so
 *  three's geometry roughness can be added before it is squared into alpha. */
export function slopeRoughness(meanSquare: number): number {
  return Math.pow(Math.max(meanSquare, 0), 0.25);
}

/** The calm lobe as the shader holds it. */
export const SEA_CALM_LOBE_ROUGHNESS = windRoughness(SEA_CALM_LOBE_WIND_MS);

/** A pair of maps' bytes as the shader reads them: one byte a texel each,
 *  row 0 the south pole, the windy map possibly smaller than the calm map. */
export interface SeaWindMapBytes {
  calm: Uint8Array;
  width: number;
  height: number;
  windy: Uint8Array;
  windyWidth: number;
  windyHeight: number;
}

/**
 * A decoded picture of both maps — red the calm weight, green the windy speed,
 * north-up as a canvas reads it — into the pair's bytes, row 0 the south.
 */
export function seaWindBytesFromRgba(rgba: ArrayLike<number>, width: number, height: number): SeaWindMapBytes {
  const calm = new Uint8Array(width * height);
  const windy = new Uint8Array(width * height);
  for (let pictureRow = 0; pictureRow < height; pictureRow++) {
    const row = height - 1 - pictureRow;
    for (let column = 0; column < width; column++) {
      const from = (pictureRow * width + column) * 4;
      const to = row * width + column;
      calm[to] = rgba[from];
      windy[to] = rgba[from + 1];
    }
  }
  return { calm, width, height, windy, windyWidth: width, windyHeight: height };
}

/**
 * A raw map of one wind a texel (wind over SEA_WIND_MAX_MS a byte, row 0 the
 * south — a real wind day, or a candidate from the offline simulator) into the
 * mixture: a texel calmer than the calm lobe is all calm weight, any other is
 * the windy lobe at its own wind. The DEV override reads these.
 */
export function seaWindBytesFromWindMap(bytes: Uint8Array, width: number, height: number): SeaWindMapBytes {
  const calm = new Uint8Array(width * height);
  const windy = new Uint8Array(width * height);
  const calmByte = (SEA_CALM_LOBE_WIND_MS / SEA_WIND_MAX_MS) * 255;
  for (let index = 0; index < width * height; index++) {
    const isCalm = bytes[index] < calmByte;
    calm[index] = isCalm ? 255 : 0;
    windy[index] = isCalm ? Math.round(calmByte) : bytes[index];
  }
  return { calm, width, height, windy, windyWidth: width, windyHeight: height };
}

/** A raw wind map is one byte a texel with the width twice the height, so its
 *  size says its shape (2048x1024, 1440x720, 1024x512), or it has no shape. */
export function seaWindMapDimensions(byteLength: number): { width: number; height: number } | null {
  const width = Math.round(Math.sqrt(byteLength * 2));
  const height = width / 2;
  return Number.isInteger(height) && height >= 1 && width * height === byteLength ? { width, height } : null;
}

let mipsEnabled = true;

/** `?seawindmips=0` (DEV only): the maps with no mip chain, sampled at their
 *  full resolution from any distance — the A/B for whether the chain is
 *  eating the fine structure. */
export function setSeaWindMips(on: boolean): void {
  mipsEnabled = on;
}

/**
 * How the sea samples a map: repeat-wrapped around the date line and clamped
 * at the poles, mip-chained because the sea is looked at from a whole-disc
 * distance where a texel is well under a pixel — and the calm weight's mips
 * are exact by construction. Applied to a shipped map on arrival and to a
 * texture built from bytes; a map already uploaded is re-uploaded once.
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

/** One map's bytes as a texture: one channel, one byte a texel, row 0 the
 *  south. Data, not colour — an sRGB decode would bend the number. */
export function seaWindTextureFrom(data: Uint8Array, width: number, height: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, width, height, THREE.RedFormat, THREE.UnsignedByteType);
  applyTextureDefaults(tex, 'data');
  // One byte a texel: a row of a map from a file need not be four bytes' multiple.
  tex.unpackAlignment = 1;
  applySeaWindSampling(tex);
  return tex;
}

/** The pair as textures, from bytes (the DEV override, and the tests). */
export function seaWindTexturesFrom(map: SeaWindMapBytes): { calm: THREE.DataTexture; windy: THREE.DataTexture } {
  return {
    calm: seaWindTextureFrom(map.calm, map.width, map.height),
    windy: seaWindTextureFrom(map.windy, map.windyWidth, map.windyHeight),
  };
}

export type SeaWindMapKind = 'calm' | 'windy';
const installed: Record<SeaWindMapKind, THREE.Texture | null> = { calm: null, windy: null };
let mapSource = 'none';
let overrideRequested = false;

/**
 * The maps the sea reads, each once one is installed — the shipped one on
 * arrival (PlanetFactory), or a DEV override's — and null before that. Bound
 * by every augmented material through two shared uniforms
 * (world/surfaceShading's seaWindUniforms) once both are here; the
 * installer's caller rebinds the seas already drawn.
 */
export function seaWindTextures(): Readonly<Record<SeaWindMapKind, THREE.Texture | null>> {
  return installed;
}

/** Which maps the sea reads: 'none' before both land, 'shipped', or the DEV
 *  `?seawindmap=` file's URL. */
export function seaWindMapSource(): string {
  return installed.calm && installed.windy ? mapSource : 'none';
}

/**
 * Put one map in place: the shipped one (`source` 'shipped'), or one from a
 * file. Returns the texture now installed, or null when it was refused — a
 * shipped arrival after a DEV override was asked for, whichever of the two
 * lands first, so a sheet captured through `?seawindmap=` never shows the
 * shipped maps. The previous map of the kind is disposed; a refused one is
 * the caller's.
 */
export function installSeaWindMap(kind: SeaWindMapKind, tex: THREE.Texture, source: string): THREE.Texture | null {
  if (source === 'shipped' && overrideRequested) return null;
  const previous = installed[kind];
  installed[kind] = tex;
  mapSource = source;
  if (previous && previous !== tex) previous.dispose();
  return tex;
}

/** `?seawindmap=<url>` (DEV only): the sea's maps from a file instead of the
 *  shipped pair — a picture with the calm weight in red and the windy speed
 *  over SEA_WIND_MAX_MS in green, north-up (the bake job's `--rgb` form), or
 *  a raw byte map of one wind a texel — so a field baked elsewhere, a real
 *  wind day or a candidate from the offline simulator, is judged in the app
 *  under its own clouds and air. Asking for one refuses the shipped pair from
 *  then on. */
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
 * Fetch maps for the override. A picture (.png, .webp, .jpg) carries both in
 * its red and green; anything else is a raw wind map, wind over
 * SEA_WIND_MAX_MS a byte, row 0 the south, its shape read off its size.
 * Development only.
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
  const bytes = new Uint8Array(await response.arrayBuffer());
  const shape = seaWindMapDimensions(bytes.byteLength);
  if (!shape) throw new Error(`sea wind map: ${url} is ${bytes.byteLength} bytes, not a width x width/2 byte map`);
  return seaWindBytesFromWindMap(bytes, shape.width, shape.height);
}

/** The `?seawind=0` kill switch, on any build: the whole sea at one width, in
 *  the house style of `?fused=0` and `?ride=0`. */
export function parseSeaWindParam(search: string): boolean {
  return new URLSearchParams(search).get('seawind') !== '0';
}
