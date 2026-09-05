/**
 * What a texture costs the device, in one place.
 *
 * Two allocators spend one memory envelope — the globe texture ladder and the
 * sector streamer — and a byte figure only means something if both price the
 * same texture the same way. Every "how big is this" question in the app is
 * answered here: the equirect map a ladder rung holds, the tile an admission
 * reserves before a byte of it decodes, the texture that is really on a
 * material, and the decoded image still sitting in RAM behind it.
 *
 * Three conventions the whole file rests on:
 *
 * - A texel is four bytes uncompressed and one compressed. A GPU-compressed
 *   container's real cost is the blocks it carries, which is a quarter to an
 *   eighth of the raw map depending on the format; where the blocks can be
 *   counted they are, and one byte a texel is the estimate for the rest.
 * - A mip chain adds a third. A texture that will not be mipped does not pay
 *   it, which is why `textureGpuBytes` asks the texture rather than assuming.
 * - A figure stashed on the texture (`userData.gpuBytes`) wins over anything
 *   measured. Both allocators close a decoded source once its upload is paid,
 *   and what is on the GPU has not changed just because the image behind it
 *   is gone.
 */
import type * as THREE from 'three';

/** A mip chain is every halving of the base image, which sums to a third of it
 *  again. Textures that carry their own mip levels (a KTX2 container) are
 *  measured level by level instead. */
const MIP_CHAIN_FACTOR = 4 / 3;

/** Bytes one image of this size holds on the GPU. */
function imageGpuBytes(width: number, height: number, compressed: boolean, mipped: boolean): number {
  return Math.round(width * height * (compressed ? 1 : 4) * (mipped ? MIP_CHAIN_FACTOR : 1));
}

/**
 * GPU bytes an equirect colour map of this width holds: its texel count (a
 * 2:1 map) times four bytes — or one, for a GPU-compressed upload, which is
 * what a transcoded map costs — plus a third for its mip chain.
 */
export function equirectMapGpuBytes(width: number, compressed = false): number {
  if (!(width > 0)) return 0;
  return imageGpuBytes(width, width / 2, compressed, true);
}

/** GPU bytes an image of this tile layout holds: RGBA8 at its pixel size plus
 *  a third for its mip chain. Known before the fetch — which is what lets an
 *  admission reserve what it is about to hold. */
export function layoutGpuBytes(layout: { width: number; height: number }): number {
  return imageGpuBytes(layout.width, layout.height, false, true);
}

/** A texture as this module has to read it: three's public surface says
 *  nothing about compressed containers or a stashed figure. */
type MeasurableTexture = THREE.Texture & {
  isCompressedTexture?: boolean;
  mipmaps?: Array<{ data?: { byteLength?: number } } | null>;
};

/**
 * GPU bytes one texture holds, read from what is really there rather than
 * from the name of the tier or the level that asked for it: a GPU-compressed
 * rung holds exactly the blocks its container carries (and the ratio is the
 * format's, not ours to assume), a map is not always the width its tier is
 * named for — Earth's day map boots wider than its tier name — and a texture
 * that will not be mipped does not pay for a mip chain.
 *
 * `nominalWidth` is the fallback for a texture with no readable image, priced
 * as an equirect map of that width; 0 asks for no fallback.
 *
 * Takes a plain texture, not a handle, so the same measurement runs on a
 * decoded CANDIDATE before it is applied — the moment the admission test has
 * to weigh it, and the moment a handle-shaped reader can say nothing at all.
 */
export function textureGpuBytes(tex: THREE.Texture | null | undefined, nominalWidth = 0): number {
  const map = tex as MeasurableTexture | null | undefined;
  if (!map) return 0;
  const stashed = map.userData?.gpuBytes;
  if (typeof stashed === 'number') return stashed;
  const compressed = map.isCompressedTexture === true;
  if (compressed) {
    let bytes = 0;
    for (const level of map.mipmaps ?? []) bytes += level?.data?.byteLength ?? 0;
    if (bytes > 0) return bytes;
  }
  const img = map.image as { width?: unknown; height?: unknown } | undefined;
  const w = img && typeof img.width === 'number' ? img.width : 0;
  const h = img && typeof img.height === 'number' ? img.height : 0;
  if (w > 0 && h > 0) {
    const mipped = map.generateMipmaps !== false || (map.mipmaps?.length ?? 0) > 1;
    return imageGpuBytes(w, h, compressed, mipped);
  }
  return equirectMapGpuBytes(nominalWidth, compressed);
}

/** Bytes of decoded image a texture is still holding in RAM. Two decodes
 *  retain one — a bitmap, and the raw RGBA buffer a sector tile is decoded
 *  into so the driver has no source to convert — and they cost the same four
 *  bytes a texel until the upload is paid and the source is freed, so both are
 *  counted. A compressed texture's mip data is what `textureGpuBytes` already
 *  measures, and counting it twice would make one honest measurement look
 *  like two. */
export function retainedSourceBytes(tex: THREE.Texture | null | undefined): number {
  const map = tex as (THREE.Texture & { isCompressedTexture?: boolean }) | null | undefined;
  if (!map || map.isCompressedTexture) return 0;
  // A rung whose source has been closed keeps a small stand-in to re-upload
  // from after a context loss — 2 MiB against the 33 MiB it replaced, and a
  // couple of rungs' worth across the whole scene. Freeing a tile's byte
  // buffer marks the texture the same way, so one check covers both.
  if (map.userData?.sourceReleased === true) return 0;
  const img = map.image as { width?: unknown; height?: unknown; close?: unknown } | undefined;
  // A bitmap is recognised by being closable; a byte buffer this app decoded
  // and owns says so on the texture. An <img> element is neither, and holds
  // nothing this module can free.
  if (!img || (typeof img.close !== 'function' && map.userData?.ownedPixels !== true)) return 0;
  const w = typeof img.width === 'number' ? img.width : 0;
  const h = typeof img.height === 'number' ? img.height : 0;
  return w > 0 && h > 0 ? w * h * 4 : 0;
}
