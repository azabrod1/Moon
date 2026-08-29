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

/** Bytes per 4×4 block, for the formats a KTX2 rung can transcode to. A
 *  format missing here is refused rather than guessed: a wrong block size
 *  reads the wrong bytes and writes garbage into the texture. */
const BLOCK_BYTES: Record<number, number> = {
  0x93b0: 16, // COMPRESSED_RGBA_ASTC_4x4_KHR
  0x8e8c: 16, // COMPRESSED_RGBA_BPTC_UNORM (BC7)
  0x83f0: 8, // COMPRESSED_RGB_S3TC_DXT1_EXT
  0x83f1: 8, // COMPRESSED_RGBA_S3TC_DXT1_EXT
  0x83f2: 16, // COMPRESSED_RGBA_S3TC_DXT3_EXT
  0x83f3: 16, // COMPRESSED_RGBA_S3TC_DXT5_EXT
  0x9274: 8, // COMPRESSED_RGB8_ETC2
  0x9278: 16, // COMPRESSED_RGBA8_ETC2_EAC
};

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

export interface SliceJob {
  texture: THREE.Texture;
  renderer: THREE.WebGLRenderer;
  compressed: boolean;
  width: number;
  height: number;
  /** Rows of the base level already uploaded. */
  rowsDone: number;
  /** Measured cost per row, an EMA — see slicedUploadPlan. */
  msPerRow: number | null;
  /** Compressed levels above the base, uploaded whole after the base. */
  tailLevels: CompressedLevel[];
  baseLevel: CompressedLevel | null;
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
    const format = texture.format as unknown as number;
    if (!BLOCK_BYTES[format]) return false;
    return Array.isArray(mipmaps) && mipmaps.length > 0;
  }
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

  const enums = compressed
    ? { format: texture.format as unknown as number, type: 0 }
    : uncompressedEnums(gl, texture)!;

  const levelsIn = compressed ? mipmaps! : [];
  return {
    texture,
    renderer,
    compressed,
    width,
    height,
    rowsDone: 0,
    msPerRow: null,
    baseLevel: compressed
      ? { ...levelsIn[0], level: 0, blockBytes: BLOCK_BYTES[enums.format] }
      : null,
    tailLevels: compressed
      ? levelsIn.slice(1).map((m, i) => ({ ...m, level: i + 1, blockBytes: BLOCK_BYTES[enums.format] }))
      : [],
    glFormat: enums.format,
    glType: enums.type,
    needsMipmap: !compressed,
    bands: 0,
    totalMs: 0,
    contextLost: false,
  };
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
