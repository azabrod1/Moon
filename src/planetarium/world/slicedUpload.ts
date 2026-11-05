/**
 * Sliced GPU texture upload: a big map paid over several frames.
 *
 * A texture upload is one synchronous driver call that cannot be interrupted,
 * so whichever frame pays it wears the whole bill. Measured at 120 Hz, an
 * upload past about 3 ms drops a frame and an 8K map drops several — and no
 * per-frame budget can prevent it, because the pump can only choose whether to
 * START an upload, never how long it takes. Slicing is the only fix that
 * generalises.
 *
 * The allocation is three's, not ours. `Source.dataReady = false` makes
 * three's uploadTexture run everything EXCEPT the pixel transfer: it creates
 * the GL texture, computes the cache key that its own refcounting is keyed on,
 * sets the wrap/filter/anisotropy parameters, and calls texStorage2D for the
 * full mip chain. Only the fill is ours. Doing it the other way — allocating
 * by hand and stamping three's private properties — means forging __cacheKey,
 * and a forged key that misses three's source table orphans the GL texture on
 * the next upload and throws on dispose.
 *
 * After that allocation pass three considers the texture current (it stamps
 * both __version fields), so it never re-uploads and the pixels are ours to
 * fill. Which also means: on context loss three's property store is discarded
 * wholesale, so a job in flight is abandoned and its texture re-queued rather
 * than left half-filled.
 *
 * Because the allocation is three's, the bands have to speak its format. Three
 * allocates from utils.convert(texture.format, texture.colorSpace), which for
 * a compressed texture in an sRGB colour space is the sRGB variant of the
 * format's enum — a different number from the one on texture.format, and on
 * S3TC from a different extension. Uploading a band with the wrong one is a
 * rejected call, an empty texture and a body drawing a blank map, so the
 * band's format is derived from the same two inputs three reads.
 *
 * Whether the driver then takes bands of that format into the storage three
 * allocated is asked ONCE per session for each pair of compressed format and
 * colour-space transfer, by a probe that allocates a 16×16 texture the same
 * way, uploads one band and reads the GL error queue once: at boot, under the
 * loading cover, for the formats this device's containers transcode to, and
 * at the first job of any other pair. A pair the driver refuses uploads whole
 * from its first job on, and no band of it is ever attempted. No job reads the
 * error queue. getError is a synchronous round trip: Chrome flushes the
 * command buffer and waits for the GPU process to work through it, behind
 * whatever upload the frame has just queued. Read twice per map, it held the
 * main thread 1–7 ms a map on an M5 Max under Chrome as an approach to Earth
 * streamed its 8K rungs, and up to 16 ms a read where the GPU was busiest.
 * Reading it a frame later instead would not be exact either: the queue is
 * global, so a deferred read could blame a band for an error some other call
 * raised that frame, and hand an 8K map back to the one-shot upload this
 * module exists to avoid. What that gives up: the probe asks about the
 * format, at 16×16. A driver that took a small band of a format and refused a
 * full-size one of the same format would now go unnoticed, where before the
 * first band of each map would have caught it. No such driver is known.
 *
 * The no-half-loaded rule holds by construction. Nothing here assigns a map to
 * a material; the pump settles its 'warmed' callback only when the last band
 * and the mip chain are in, and that callback is the seam callers already use
 * to assign.
 *
 * Refused, and left to the single-shot path, when any assumption below fails:
 * a flipped texture (UNPACK_FLIP_Y_WEBGL flips each band independently, which
 * would tile the image), a format whose GL enums we do not know exactly, a
 * compressed format whose block size we do not know, or one whose bands the
 * probe saw the driver refuse.
 */
import * as THREE from 'three';
import { debugWarn } from '../../shared/debug';
import { drainErrors } from '../../shared/three/glErrors';
import { smoothTraceEvent } from '../smoothnessTrace';
import {
  COMPRESSED_BLOCK_ROWS,
  nextBandRows,
  shouldSlice,
  updateRowRate,
} from './slicedUploadPlan';

/**
 * The compressed formats a KTX2 rung can transcode to, keyed by the constant
 * three puts on `texture.format` — which is the LINEAR GL enum, never the one
 * a band may be uploaded with.
 *
 * `blockBytes` is bytes per 4×4 block. A format missing from this table is
 * refused rather than guessed: a wrong block size reads the wrong bytes and
 * writes garbage into the texture.
 *
 * The enum names are the two variants of the same format. An sRGB variant is a
 * DIFFERENT enum, and on S3TC it lives on a different extension a device may
 * not have at all; three's WebGLUtils.convert picks it whenever the texture's
 * colour space carries the sRGB transfer, and allocates the storage with it.
 * A band uploaded with the other enum is a format mismatch — the driver
 * rejects the call, the texture stays empty, and the body draws an unfilled
 * map — so the band's format is derived through this table from the same two
 * inputs three reads, and never taken from `texture.format` directly.
 */
interface CompressedFormat {
  blockBytes: number;
  ext: string;
  linear: string;
  srgbExt: string;
  srgb: string;
}
const COMPRESSED_FORMATS: Record<number, CompressedFormat> = {
  // THREE.RGBA_ASTC_4x4_Format
  37808: {
    blockBytes: 16,
    ext: 'WEBGL_compressed_texture_astc',
    linear: 'COMPRESSED_RGBA_ASTC_4x4_KHR',
    srgbExt: 'WEBGL_compressed_texture_astc',
    srgb: 'COMPRESSED_SRGB8_ALPHA8_ASTC_4x4_KHR',
  },
  // THREE.RGBA_BPTC_Format (BC7)
  36492: {
    blockBytes: 16,
    ext: 'EXT_texture_compression_bptc',
    linear: 'COMPRESSED_RGBA_BPTC_UNORM_EXT',
    srgbExt: 'EXT_texture_compression_bptc',
    srgb: 'COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT',
  },
  // THREE.RGB_S3TC_DXT1_Format
  33776: {
    blockBytes: 8,
    ext: 'WEBGL_compressed_texture_s3tc',
    linear: 'COMPRESSED_RGB_S3TC_DXT1_EXT',
    srgbExt: 'WEBGL_compressed_texture_s3tc_srgb',
    srgb: 'COMPRESSED_SRGB_S3TC_DXT1_EXT',
  },
  // THREE.RGBA_S3TC_DXT1_Format
  33777: {
    blockBytes: 8,
    ext: 'WEBGL_compressed_texture_s3tc',
    linear: 'COMPRESSED_RGBA_S3TC_DXT1_EXT',
    srgbExt: 'WEBGL_compressed_texture_s3tc_srgb',
    srgb: 'COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT',
  },
  // THREE.RGBA_S3TC_DXT3_Format
  33778: {
    blockBytes: 16,
    ext: 'WEBGL_compressed_texture_s3tc',
    linear: 'COMPRESSED_RGBA_S3TC_DXT3_EXT',
    srgbExt: 'WEBGL_compressed_texture_s3tc_srgb',
    srgb: 'COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT',
  },
  // THREE.RGBA_S3TC_DXT5_Format
  33779: {
    blockBytes: 16,
    ext: 'WEBGL_compressed_texture_s3tc',
    linear: 'COMPRESSED_RGBA_S3TC_DXT5_EXT',
    srgbExt: 'WEBGL_compressed_texture_s3tc_srgb',
    srgb: 'COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT',
  },
  // THREE.RGB_ETC2_Format
  37492: {
    blockBytes: 8,
    ext: 'WEBGL_compressed_texture_etc',
    linear: 'COMPRESSED_RGB8_ETC2',
    srgbExt: 'WEBGL_compressed_texture_etc',
    srgb: 'COMPRESSED_SRGB8_ETC2',
  },
  // THREE.RGBA_ETC2_EAC_Format
  37496: {
    blockBytes: 16,
    ext: 'WEBGL_compressed_texture_etc',
    linear: 'COMPRESSED_RGBA8_ETC2_EAC',
    srgbExt: 'WEBGL_compressed_texture_etc',
    srgb: 'COMPRESSED_SRGB8_ALPHA8_ETC2_EAC',
  },
};

/** Whether a colour space decodes through the sRGB transfer function. This is
 *  the test three's format conversion makes, not an equality against
 *  SRGBColorSpace: every space that carries that transfer takes the same
 *  branch there and must take it here. */
export function hasSrgbTransfer(colorSpace: string): boolean {
  return THREE.ColorManagement.getTransfer(colorSpace) === THREE.SRGBTransfer;
}

/**
 * The GL enum a band of this compressed texture must be uploaded with — the
 * same value three's WebGLUtils.convert(texture.format, texture.colorSpace)
 * resolves, and therefore the internal format three allocated the storage
 * with. Null when the format is one this module does not slice, or when the
 * extension carrying the needed variant is missing; both are refusals, never
 * a guess, because a mismatched format is a rejected upload and an empty map.
 */
export function compressedUploadFormat(
  gl: { getExtension(name: string): unknown },
  format: number,
  colorSpace: string,
): number | null {
  const entry = COMPRESSED_FORMATS[format];
  if (!entry) return null;
  const srgb = hasSrgbTransfer(colorSpace);
  const ext = gl.getExtension(srgb ? entry.srgbExt : entry.ext) as Record<string, unknown> | null;
  const value = ext?.[srgb ? entry.srgb : entry.linear];
  return typeof value === 'number' ? value : null;
}

/** The one uncompressed shape this slicer takes. The app also streams
 *  one-channel R8 masks (world/texturePolicy's 'mask' kind), which are below
 *  the slicing size and are refused here rather than sliced — a mask large
 *  enough to slice would need a RED row added. Anything else is refused
 *  rather than have this file duplicate three's format conversion table. */
function uncompressedEnums(
  gl: WebGL2RenderingContext,
  texture: THREE.Texture,
): { format: number; type: number } | null {
  if (texture.format !== THREE.RGBAFormat) return null;
  if (texture.type !== THREE.UnsignedByteType) return null;
  return { format: gl.RGBA, type: gl.UNSIGNED_BYTE };
}

interface CompressedLevel {
  level: number;
  width: number;
  height: number;
  data: Uint8Array;
  blockBytes: number;
}

/**
 * The internal format three would have chosen. Only the one shape this module
 * slices is covered, taken from three's getInternalFormat: an RGBA byte
 * texture is SRGB8_ALPHA8 when its colour space carries the sRGB transfer and
 * RGBA8 otherwise. Getting this wrong changes what the driver stores, so the
 * parity readback is what proves it right.
 */
function internalFormatFor(
  gl: WebGL2RenderingContext,
  texture: THREE.Texture,
): number {
  return hasSrgbTransfer(texture.colorSpace) ? gl.SRGB8_ALPHA8 : gl.RGBA8;
}

export interface SliceJob {
  texture: THREE.Texture;
  renderer: THREE.WebGLRenderer;
  compressed: boolean;
  /** Allocated with texImage2D rather than texStorage2D — see the patch. */
  mutable: boolean;
  width: number;
  height: number;
  /** Rows of the base level already uploaded. */
  rowsDone: number;
  /** Measured cost per row, an EMA — see slicedUploadPlan. */
  msPerRow: number | null;
  /** Compressed levels above the base, uploaded whole after the base. */
  tailLevels: CompressedLevel[];
  baseLevel: CompressedLevel | null;
  /** The enum every band is uploaded with — for a compressed texture the one
   *  three allocated the storage with, not the constant on texture.format. */
  glFormat: number;
  glType: number;
  /** The mip chain still has to be built (uncompressed only). */
  needsMipmap: boolean;
  bands: number;
  /** Milliseconds of GPU transfer this map has cost so far, across every
   *  band. Reported once at the end: a sliced map that vanished from the
   *  upload telemetry would look like an upload that stopped happening. */
  totalMs: number;
  /** The GL context this job's storage belongs to. A lost context invalidates
   *  it, and three's property store goes with it. */
  contextLost: boolean;
}

/** A texture three has already uploaded, or one whose assumptions we do not
 *  meet, is not a candidate. */
export function canSlice(renderer: THREE.WebGLRenderer, texture: THREE.Texture): boolean {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  // Already on the GPU: three drew it before the pump got to it. Slicing it
  // now would allocate nothing (three's allocation pass no-ops on a version
  // it has already stamped) and then re-transfer the whole map band by band
  // for no picture at all — 39 bands of dead traffic for an 8K container.
  // The test is three's own, the version it stamped on its record for this
  // texture against the texture's, so the two cannot come to differ.
  const uploaded = (renderer.properties.get(texture) as { __version?: number } | undefined)?.__version;
  if (uploaded !== undefined && uploaded === texture.version) return false;
  const compressed = (texture as THREE.CompressedTexture).isCompressedTexture === true;
  const image = texture.image as { width?: number; height?: number } | undefined;
  const mipmaps = (texture as THREE.CompressedTexture).mipmaps;
  const width = compressed ? mipmaps?.[0]?.width ?? 0 : image?.width ?? 0;
  const height = compressed ? mipmaps?.[0]?.height ?? 0 : image?.height ?? 0;
  if (!width || !height) return false;
  if (!shouldSlice({ compressed, width, height })) return false;
  // A flipped upload cannot be banded: the flip is applied per call, so each
  // band would land mirrored into the wrong rows.
  if (texture.flipY) return false;
  if (compressed) {
    // Both halves of the compressed contract, checked before three allocates
    // anything: a block size this module knows exactly, and the one enum the
    // bands may be uploaded with. Refusing here leaves the map to the one-shot
    // path with nothing to undo.
    if (!COMPRESSED_FORMATS[texture.format as unknown as number]) return false;
    if (compressedUploadFormat(gl, texture.format as unknown as number, texture.colorSpace) === null) {
      return false;
    }
    return Array.isArray(mipmaps) && mipmaps.length > 0;
  }
  // An sRGB map is refused, and this is the whole reason the slicer is narrow.
  // The driver's sRGB conversion is charged per UPLOAD CALL over the whole
  // source, not per sub-rectangle, so splitting one call into N pays it N
  // times. Measured on ANGLE Metal with a 4096x2048 map: one shot 5.6 ms,
  // sliced 34.3 ms; at 2048x2048, 2.3 ms against 26.7 ms. The same map with a
  // linear colour space slices for 1.0x. Slicing these would multiply the very
  // cost it exists to spread.
  if (hasSrgbTransfer(texture.colorSpace)) return false;
  // texSubImage2D takes a real image source. A DataTexture's image is a plain
  // {data,width,height} record, and handing that to the DOM-source overload
  // throws — so only genuine sources are sliced.
  const source = texture.image as object;
  const uploadable = typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap
    || typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement
    || typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement
    || typeof OffscreenCanvas !== 'undefined' && source instanceof OffscreenCanvas;
  if (!uploadable) return false;
  return uncompressedEnums(gl, texture) !== null;
}

/**
 * Allocate storage through three and hand back a job that fills it.
 *
 * Returns null when the texture is not a candidate, in which case the caller
 * must upload it in one shot exactly as before.
 */
export function beginSlicedUpload(
  renderer: THREE.WebGLRenderer,
  texture: THREE.Texture,
): SliceJob | null {
  if (!canSlice(renderer, texture)) return null;
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const compressed = (texture as THREE.CompressedTexture).isCompressedTexture === true;
  // A pair the driver refused uploads whole, before anything is allocated
  // here. A pair that could not be asked (the context is lost) goes on as a
  // job, whose first step reports the lost context exactly as any other job's.
  if (compressed && probeCompressedBands(renderer, texture.format as unknown as number, texture.colorSpace) === false) {
    return null;
  }
  const mipmaps = (texture as THREE.CompressedTexture).mipmaps as CompressedLevel[] | undefined;
  const image = texture.image as { width: number; height: number };
  const width = compressed ? mipmaps![0].width : image.width;
  const height = compressed ? mipmaps![0].height : image.height;

  const source = texture.source;
  const previousDataReady = source.dataReady;
  // A map that opted out of immutable storage must stay out of it: that flag
  // (patches/three) exists because texStorage2D makes the driver pay a
  // full-image sRGB conversion, measured at ~200 ms of frozen main thread for
  // an 8K on Chromium. Its branch is also NOT gated by dataReady, so the
  // allocation trick below cannot be the same one.
  const mutable = texture.userData?.mutableStorage === true;
  // The mutable branch reallocates level 0 as an RGBA byte image, which a
  // compressed container is not. Nothing sets the flag on one today; the
  // refusal is here so nothing can start to.
  if (mutable) {
    return compressed ? null : beginMutableSlice(renderer, texture, gl, width, height);
  }
  try {
    // generateMipmaps is left exactly as the caller set it. Three reads the
    // level count from it, so leaving it true gets the full chain allocated;
    // and it is one of the fourteen fields three's texture cache key is built
    // from, so changing it here would orphan this allocation the next time
    // anything touched the texture. The cost is that three runs one
    // generateMipmap over storage that has no pixels in it yet, which is
    // cheaper than the alternatives: stub mipmap records reach an overload
    // that cannot take them, and a false generateMipmaps allocates one level.
    source.dataReady = false;
    renderer.initTexture(texture);
  } catch (err) {
    debugWarn('Sliced upload could not allocate; falling back to one shot', { err: String(err) });
    source.dataReady = previousDataReady;
    return null;
  }
  source.dataReady = previousDataReady;

  // canSlice already proved both of these resolve; they are re-read rather
  // than carried so this function has one source for what a band uploads with.
  const enums = compressed
    ? {
      format: compressedUploadFormat(gl, texture.format as unknown as number, texture.colorSpace)!,
      type: 0,
    }
    : uncompressedEnums(gl, texture)!;
  const blockBytes = compressed
    ? COMPRESSED_FORMATS[texture.format as unknown as number].blockBytes
    : 0;

  const levelsIn = compressed ? mipmaps! : [];
  return {
    texture,
    renderer,
    compressed,
    mutable: false,
    width,
    height,
    rowsDone: 0,
    msPerRow: null,
    baseLevel: compressed ? { ...levelsIn[0], level: 0, blockBytes } : null,
    tailLevels: compressed
      ? levelsIn.slice(1).map((m, i) => ({ ...m, level: i + 1, blockBytes }))
      : [],
    glFormat: enums.format,
    glType: enums.type,
    needsMipmap: !compressed,
    bands: 0,
    totalMs: 0,
    contextLost: false,
  };
}

/**
 * Allocate a mutable-storage map without uploading it.
 *
 * The patched mutable branch is `texImage2D(TEXTURE_2D, 0, ifmt, fmt, type,
 * image)` with no dataReady gate, so there is no way to ask three to allocate
 * and not upload. Instead it is handed a one-pixel image: three creates the GL
 * texture, computes the cache key its refcounting is keyed on, sets the
 * texture parameters and stamps both __version fields — everything except the
 * pixels — for the cost of a 1×1 upload. The real image goes back afterwards
 * WITHOUT bumping any version, so three considers the texture current and
 * never uploads it again; level 0 is then reallocated at full size, which
 * mutable storage allows and immutable storage would not.
 */
function beginMutableSlice(
  renderer: THREE.WebGLRenderer,
  texture: THREE.Texture,
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): SliceJob | null {
  // Three's upload branches on isDataTexture, not on what the image is, so a
  // data texture cannot be allocated by handing it a stand-in image: that
  // branch would read `image.data` off the canvas below and find nothing.
  if ((texture as THREE.DataTexture).isDataTexture) return null;
  const realImage = texture.image;
  try {
    const tiny = document.createElement('canvas');
    tiny.width = 1;
    tiny.height = 1;
    texture.image = tiny;
    renderer.initTexture(texture);
  } catch (err) {
    debugWarn('Sliced upload could not allocate a mutable map', { err: String(err) });
    texture.image = realImage;
    return null;
  }
  texture.image = realImage;
  const job: SliceJob = {
    texture,
    renderer,
    compressed: false,
    mutable: true,
    width,
    height,
    rowsDone: 0,
    msPerRow: null,
    baseLevel: null,
    tailLevels: [],
    glFormat: gl.RGBA,
    glType: gl.UNSIGNED_BYTE,
    needsMipmap: true,
    bands: 0,
    totalMs: 0,
    contextLost: false,
  };
  // Reallocate level 0 at the real size with no data. No texStorage2D, so the
  // driver never does the whole-image conversion the patch exists to avoid;
  // the per-band texSubImage2D calls pay it a band at a time instead.
  const gl2 = bindForUpload(job);
  gl2.pixelStorei(gl2.UNPACK_FLIP_Y_WEBGL, 0);
  gl2.pixelStorei(gl2.UNPACK_PREMULTIPLY_ALPHA_WEBGL, texture.premultiplyAlpha ? 1 : 0);
  gl2.pixelStorei(gl2.UNPACK_ALIGNMENT, texture.unpackAlignment);
  gl2.texImage2D(
    gl2.TEXTURE_2D, 0, internalFormatFor(gl2, texture),
    width, height, 0, gl2.RGBA, gl2.UNSIGNED_BYTE, null,
  );
  return job;
}

/** Bind through three's state cache, never raw: a raw bind desyncs the cache
 *  and a later draw silently samples whatever three thinks is bound. */
function bindTextureForUpload(renderer: THREE.WebGLRenderer, texture: THREE.Texture): WebGL2RenderingContext {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const properties = (renderer as unknown as {
    properties: { get(t: THREE.Texture): { __webglTexture?: WebGLTexture } };
  }).properties;
  const state = (renderer as unknown as {
    state: { bindTexture(type: number, tex: WebGLTexture | null, slot?: number): void };
  }).state;
  state.bindTexture(gl.TEXTURE_2D, properties.get(texture).__webglTexture ?? null, gl.TEXTURE0);
  return gl;
}

function bindForUpload(job: SliceJob): WebGL2RenderingContext {
  return bindTextureForUpload(job.renderer, job.texture);
}

/** The driver's answer for each (compressed format, colour-space transfer)
 *  pair asked so far this session: true when it took the probe's band. A pair
 *  missing here has not been asked, or could not be. Kept across a context
 *  loss: what it records is which enum the driver accepts for which storage,
 *  a fact about the device and not about any GL object a loss takes away. */
const bandVerdicts = new Map<string, boolean>();

function bandVerdictKey(format: number, colorSpace: string): string {
  return `${format}:${hasSrgbTransfer(colorSpace) ? 'srgb' : 'linear'}`;
}

/** The probe texture: four blocks a side of every format this module takes,
 *  and a band of two block rows across its whole width — the shape of a real
 *  band at a size that costs nothing. */
const PROBE_SIZE = 16;
const PROBE_BAND_ROWS = 8;

/**
 * Ask the driver whether bands of this compressed format, in this colour
 * space, are accepted into storage three allocated for it — at most once per
 * session per pair, and cached. The probe allocates a 16×16 texture exactly as
 * a job does (`Source.dataReady = false`, so three runs its texStorage2D and
 * nothing else), uploads one band with the enum `compressedUploadFormat`
 * derives, reads the error queue once (drained just before, so the read can
 * only be the probe's) and frees the texture.
 *
 * True or false is the answer, recorded; null means it could not be asked —
 * the format is not one this module slices, or the context is lost, in which
 * case nothing is recorded and the next job of the pair asks again.
 */
export function probeCompressedBands(
  renderer: THREE.WebGLRenderer,
  format: number,
  colorSpace: string,
): boolean | null {
  const key = bandVerdictKey(format, colorSpace);
  const known = bandVerdicts.get(key);
  if (known !== undefined) return known;
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const entry = COMPRESSED_FORMATS[format];
  const uploadFormat = compressedUploadFormat(gl, format, colorSpace);
  if (!entry || uploadFormat === null || gl.isContextLost()) return null;
  const blocksWide = PROBE_SIZE / COMPRESSED_BLOCK_ROWS;
  const data = new Uint8Array(blocksWide * blocksWide * entry.blockBytes);
  const texture = new THREE.CompressedTexture(
    [{ data, width: PROBE_SIZE, height: PROBE_SIZE }] as unknown as ImageData[],
    PROBE_SIZE, PROBE_SIZE,
    format as unknown as THREE.CompressedPixelFormat,
    THREE.UnsignedByteType,
  );
  texture.colorSpace = colorSpace;
  texture.flipY = false;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  let accepted: boolean | null = null;
  try {
    // Emptied first, so the one read below can only be an error the probe
    // raised.
    drainErrors(gl);
    texture.source.dataReady = false;
    renderer.initTexture(texture);
    texture.source.dataReady = true;
    bindTextureForUpload(renderer, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, texture.unpackAlignment);
    gl.compressedTexSubImage2D(
      gl.TEXTURE_2D, 0, 0, 0, PROBE_SIZE, PROBE_BAND_ROWS, uploadFormat,
      data.subarray(0, (PROBE_BAND_ROWS / COMPRESSED_BLOCK_ROWS) * blocksWide * entry.blockBytes),
    );
    const error = gl.getError();
    if (!gl.isContextLost()) accepted = error === gl.NO_ERROR;
  } catch (err) {
    debugWarn('Compressed band probe threw', { format, err: String(err) });
    if (!gl.isContextLost()) accepted = false;
  } finally {
    texture.source.dataReady = true;
    texture.dispose();
  }
  if (accepted === null) return null;
  bandVerdicts.set(key, accepted);
  if (!accepted) {
    debugWarn('The driver refused a compressed band; every map of this format uploads whole', {
      format, uploadFormat, srgb: hasSrgbTransfer(colorSpace),
    });
  }
  return accepted;
}

/**
 * The compressed formats this device's KTX2 containers transcode to, as
 * three's KTX2Loader picks them: the first entry of its priority list whose
 * extension the device exposes, for an opaque container (every one this app
 * ships is opaque and sRGB; textureTiers.assets.test.ts pins each file). UASTC
 * goes to ASTC 4×4, else BC7, else ETC2, else ETC1, else DXT1; ETC1S to ETC2,
 * else ETC1, else BC7, else DXT1. Only formats this module slices are
 * returned — ETC1 and PVRTC upload whole and need no probe. A copy of three's
 * choice rather than a call into it: the choice is made inside the
 * transcoder's worker. Getting it wrong costs timing and nothing else — a
 * format this misses is probed at its own first job.
 */
export function ktx2TranscodeFormats(has: (extension: string) => boolean): number[] {
  const astc = has('WEBGL_compressed_texture_astc');
  const bptc = has('EXT_texture_compression_bptc');
  const etc2 = has('WEBGL_compressed_texture_etc');
  const etc1 = has('WEBGL_compressed_texture_etc1');
  const dxt = has('WEBGL_compressed_texture_s3tc');
  const uastc = astc ? THREE.RGBA_ASTC_4x4_Format
    : bptc ? THREE.RGBA_BPTC_Format
      : etc2 ? THREE.RGB_ETC2_Format
        : etc1 ? null
          : dxt ? THREE.RGBA_S3TC_DXT1_Format
            : null;
  const etc1s = etc2 ? THREE.RGB_ETC2_Format
    : etc1 ? null
      : bptc ? THREE.RGBA_BPTC_Format
        : dxt ? THREE.RGBA_S3TC_DXT1_Format
          : null;
  const formats: number[] = [];
  for (const format of [uastc, etc1s]) {
    if (format !== null && COMPRESSED_FORMATS[format] && !formats.includes(format)) formats.push(format);
  }
  return formats;
}

/** Test seam: forget every verdict, as a new session would. */
export function resetCompressedBandProbesForTests(): void {
  bandVerdicts.clear();
}

/**
 * Spend up to `budgetMs` on this job. Returns 'more' while work remains,
 * 'done' when the texture is fully resident with its mip chain, and 'failed'
 * when the context went away underneath it — in which case the caller must
 * discard and re-queue, never draw.
 */
export function stepSlicedUpload(job: SliceJob, budgetMs: number): 'more' | 'done' | 'failed' {
  const gl = bindForUpload(job);
  if (gl.isContextLost()) {
    job.contextLost = true;
    return 'failed';
  }
  // The call's own clock bounds the budget; each GL operation is timed where
  // it happens, so the reported cost is transfer alone and not this loop.
  const started = performance.now();
  let finished = false;
  try {
    if (job.rowsDone < job.height) {
      // Band the base level. Every other level is small enough to go whole.
      const texture = job.texture;
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, texture.premultiplyAlpha ? 1 : 0);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, texture.unpackAlignment);
      // Nothing in this loop reads anything back from the GPU process: the
      // band format was settled by the probe before the job began, and
      // isContextLost is a flag the client holds.
      while (job.rowsDone < job.height) {
        const spent = performance.now() - started;
        if (job.bands > 0 && spent >= budgetMs) break;
        const rows = nextBandRows({
          remainingRows: job.height - job.rowsDone,
          msPerRow: job.msPerRow,
          budgetMs,
          blockRows: job.compressed ? COMPRESSED_BLOCK_ROWS : 1,
        });
        if (rows <= 0) break;
        const bandStart = performance.now();
        if (job.compressed) {
          const base = job.baseLevel!;
          const blocksWide = Math.ceil(job.width / COMPRESSED_BLOCK_ROWS);
          const bytesPerBlockRow = blocksWide * base.blockBytes;
          const firstBlockRow = job.rowsDone / COMPRESSED_BLOCK_ROWS;
          const blockRows = Math.ceil(rows / COMPRESSED_BLOCK_ROWS);
          const view = new Uint8Array(
            base.data.buffer,
            base.data.byteOffset + firstBlockRow * bytesPerBlockRow,
            Math.min(blockRows * bytesPerBlockRow, base.data.byteLength - firstBlockRow * bytesPerBlockRow),
          );
          gl.compressedTexSubImage2D(
            gl.TEXTURE_2D, 0, 0, job.rowsDone, job.width, rows, job.glFormat, view,
          );
        } else {
          gl.pixelStorei(gl.UNPACK_ROW_LENGTH, job.width);
          gl.pixelStorei(gl.UNPACK_SKIP_ROWS, job.rowsDone);
          gl.texSubImage2D(
            gl.TEXTURE_2D, 0, 0, job.rowsDone, job.width, rows,
            job.glFormat, job.glType, job.texture.image as TexImageSource,
          );
          gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
          gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
        }
        job.rowsDone += rows;
        job.bands++;
        const bandMs = performance.now() - bandStart;
        job.totalMs += bandMs;
        job.msPerRow = updateRowRate(job.msPerRow, rows, bandMs);
      }
      if (job.rowsDone < job.height) return 'more';
    }
    // The base level is in. Everything below is one step per call so a big
    // mip chain cannot stack onto the frame that finished the base.
    if (job.tailLevels.length > 0) {
      const level = job.tailLevels.shift()!;
      const levelStart = performance.now();
      gl.compressedTexSubImage2D(
        gl.TEXTURE_2D, level.level, 0, 0, level.width, level.height, job.glFormat, level.data,
      );
      job.totalMs += performance.now() - levelStart;
      if (job.tailLevels.length > 0 || job.needsMipmap) return 'more';
      finished = true;
      return 'done';
    }
    if (job.needsMipmap) {
      const mipStart = performance.now();
      gl.generateMipmap(gl.TEXTURE_2D);
      job.needsMipmap = false;
      job.totalMs += performance.now() - mipStart;
    }
    finished = true;
    return 'done';
  } catch (err) {
    debugWarn('Sliced upload step failed', { err: String(err) });
    return 'failed';
  } finally {
    if (finished && import.meta.env.DEV) {
      const source = typeof job.texture.userData?.sourceUrl === 'string'
        ? job.texture.userData.sourceUrl.split(/[/?#]/).filter(Boolean).pop()
        : '';
      smoothTraceEvent(
        'upload',
        `${job.texture.name || source || 'texture'} `
        + `${job.width}x${job.height} sliced x${job.bands}`,
        job.totalMs,
      );
    }
    if (gl.isContextLost()) job.contextLost = true;
  }
}
