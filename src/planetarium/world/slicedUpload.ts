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
 * band's format is derived from the same two inputs three reads and the first
 * band is checked against the GL error queue; a rejected band abandons slicing
 * and hands the map back to three whole.
 *
 * The no-half-loaded rule holds by construction. Nothing here assigns a map to
 * a material; the pump settles its 'warmed' callback only when the last band
 * and the mip chain are in, and that callback is the seam callers already use
 * to assign.
 *
 * Refused, and left to the single-shot path, when any assumption below fails:
 * a flipped texture (UNPACK_FLIP_Y_WEBGL flips each band independently, which
 * would tile the image), a format whose GL enums we do not know exactly, or a
 * compressed format whose block size we do not know.
 */
import * as THREE from 'three';
import { debugWarn } from '../../shared/debug';
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

/** The only uncompressed shape the app streams. Anything else is refused
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
  /** The first compressed band has been read back off the GL error queue. */
  formatChecked: boolean;
  /** The bands were abandoned and three uploaded the map whole instead. */
  fellBack: boolean;
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
    formatChecked: !compressed,
    fellBack: false,
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
    formatChecked: true,
    fellBack: false,
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
function bindForUpload(job: SliceJob): WebGL2RenderingContext {
  const renderer = job.renderer;
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const properties = (renderer as unknown as {
    properties: { get(t: THREE.Texture): { __webglTexture?: WebGLTexture } };
  }).properties;
  const state = (renderer as unknown as {
    state: { bindTexture(type: number, tex: WebGLTexture | null, slot?: number): void };
  }).state;
  state.bindTexture(gl.TEXTURE_2D, properties.get(job.texture).__webglTexture ?? null, gl.TEXTURE0);
  return gl;
}

/** Empty the GL error queue, so the check after the first band can only be
 *  reading an error this job raised. Bounded because a lost context reports
 *  the same error on every call. */
function drainGlErrors(gl: WebGL2RenderingContext): void {
  for (let i = 0; i < 8; i++) if (gl.getError() === gl.NO_ERROR) return;
}

/**
 * Abandon the bands and let three upload the whole map, after a band was
 * rejected. Nothing three owns is disposed: the storage it allocated is
 * correct and stays, and this only fills it. Bumping the source version is
 * what makes three fill it at all — the allocation pass stamped the texture
 * current, so without the bump three would consider the empty storage
 * finished and the body would draw an unfilled map.
 *
 * The cost is the single-frame upload slicing exists to avoid, which is the
 * right trade for a map that would otherwise never be right.
 */
function fallBackToOneShot(job: SliceJob): 'done' | 'failed' {
  job.fellBack = true;
  try {
    job.texture.needsUpdate = true;
    job.renderer.initTexture(job.texture);
    return 'done';
  } catch (err) {
    debugWarn('Sliced upload could not fall back to one shot', { err: String(err) });
    return 'failed';
  }
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
      if (!job.formatChecked) drainGlErrors(gl);
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
        // The derivation above says which enum three allocated with; this is
        // the proof. A rejected first band means the two disagree, and every
        // later band would be rejected the same way and leave the map empty.
        if (!job.formatChecked) {
          job.formatChecked = true;
          if (gl.getError() !== gl.NO_ERROR) {
            debugWarn('Sliced upload band rejected; uploading the map whole instead', {
              format: job.glFormat,
              size: `${job.width}x${job.height}`,
            });
            const outcome = fallBackToOneShot(job);
            finished = outcome === 'done';
            return outcome;
          }
        }
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
        + `${job.width}x${job.height} sliced x${job.bands}`
        + (job.fellBack ? ' → one shot' : ''),
        job.totalMs,
      );
    }
    if (gl.isContextLost()) job.contextLost = true;
  }
}
