/**
 * The format a compressed band is uploaded with.
 *
 * three allocates a compressed texture's storage from
 * utils.convert(texture.format, texture.colorSpace), and for an sRGB colour
 * space that is the sRGB VARIANT of the format's enum — a different number
 * from the constant three leaves on texture.format, and on S3TC one that
 * lives on a second extension. A band uploaded with the constant instead is
 * rejected by the driver and the texture stays empty, which is invisible to
 * any test that allocates its own storage with the same wrong number.
 *
 * So the enums here are the WebGL spec's own values, written out rather than
 * read back from the module under test: the linear name must resolve to
 * exactly the constant three puts on texture.format, and the sRGB name must
 * resolve to something else.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  beginSlicedUpload,
  canSlice,
  compressedUploadFormat,
  hasSrgbTransfer,
  ktx2TranscodeFormats,
  probeCompressedBands,
  resetCompressedBandProbesForTests,
  stepSlicedUpload,
} from './slicedUpload';

/** Extension objects as a driver exposes them, with the spec's enum values. */
const ASTC = {
  COMPRESSED_RGBA_ASTC_4x4_KHR: 0x93b0,
  COMPRESSED_SRGB8_ALPHA8_ASTC_4x4_KHR: 0x93d0,
};
const BPTC = {
  COMPRESSED_RGBA_BPTC_UNORM_EXT: 0x8e8c,
  COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT: 0x8e8d,
};
const S3TC = {
  COMPRESSED_RGB_S3TC_DXT1_EXT: 0x83f0,
  COMPRESSED_RGBA_S3TC_DXT1_EXT: 0x83f1,
  COMPRESSED_RGBA_S3TC_DXT3_EXT: 0x83f2,
  COMPRESSED_RGBA_S3TC_DXT5_EXT: 0x83f3,
};
const S3TC_SRGB = {
  COMPRESSED_SRGB_S3TC_DXT1_EXT: 0x8c4c,
  COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT: 0x8c4d,
  COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT: 0x8c4e,
  COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT: 0x8c4f,
};
const ETC = {
  COMPRESSED_RGB8_ETC2: 0x9274,
  COMPRESSED_SRGB8_ETC2: 0x9275,
  COMPRESSED_RGBA8_ETC2_EAC: 0x9278,
  COMPRESSED_SRGB8_ALPHA8_ETC2_EAC: 0x9279,
};

const ALL_EXTENSIONS: Record<string, object> = {
  WEBGL_compressed_texture_astc: ASTC,
  EXT_texture_compression_bptc: BPTC,
  WEBGL_compressed_texture_s3tc: S3TC,
  WEBGL_compressed_texture_s3tc_srgb: S3TC_SRGB,
  WEBGL_compressed_texture_etc: ETC,
};

function fakeGl(available: Record<string, object> = ALL_EXTENSIONS) {
  return { getExtension: (name: string) => available[name] ?? null };
}

/** Every format the slicer takes, with the sRGB enum the spec gives it. */
const FORMATS: Array<[string, number, number]> = [
  ['ASTC 4x4', THREE.RGBA_ASTC_4x4_Format, 0x93d0],
  ['BC7', THREE.RGBA_BPTC_Format, 0x8e8d],
  ['DXT1 RGB', THREE.RGB_S3TC_DXT1_Format, 0x8c4c],
  ['DXT1 RGBA', THREE.RGBA_S3TC_DXT1_Format, 0x8c4d],
  ['DXT3', THREE.RGBA_S3TC_DXT3_Format, 0x8c4e],
  ['DXT5', THREE.RGBA_S3TC_DXT5_Format, 0x8c4f],
  ['ETC2 RGB', THREE.RGB_ETC2_Format, 0x9275],
  ['ETC2 EAC', THREE.RGBA_ETC2_EAC_Format, 0x9279],
];

describe('compressedUploadFormat', () => {
  for (const [name, constant, srgbEnum] of FORMATS) {
    it(`${name}: linear is three's own constant, sRGB is the other enum`, () => {
      const gl = fakeGl();
      expect(compressedUploadFormat(gl, constant, THREE.NoColorSpace)).toBe(constant);
      expect(compressedUploadFormat(gl, constant, THREE.SRGBColorSpace)).toBe(srgbEnum);
      expect(srgbEnum).not.toBe(constant);
    });
  }

  it('refuses a format it does not slice', () => {
    expect(compressedUploadFormat(fakeGl(), THREE.RGBAFormat, THREE.SRGBColorSpace)).toBeNull();
  });

  it('refuses when the extension carrying the enum is absent', () => {
    const noAstc = { ...ALL_EXTENSIONS };
    delete noAstc.WEBGL_compressed_texture_astc;
    expect(compressedUploadFormat(fakeGl(noAstc), THREE.RGBA_ASTC_4x4_Format, THREE.NoColorSpace))
      .toBeNull();
  });

  it('refuses an sRGB S3TC map on a device with only the linear extension', () => {
    // The sRGB S3TC enums are a separate extension, and three's own conversion
    // returns nothing when it is missing. Guessing the linear enum here would
    // put the mismatch back.
    const noSrgb = { ...ALL_EXTENSIONS };
    delete noSrgb.WEBGL_compressed_texture_s3tc_srgb;
    const gl = fakeGl(noSrgb);
    expect(compressedUploadFormat(gl, THREE.RGBA_S3TC_DXT5_Format, THREE.SRGBColorSpace)).toBeNull();
    expect(compressedUploadFormat(gl, THREE.RGBA_S3TC_DXT5_Format, THREE.NoColorSpace))
      .toBe(THREE.RGBA_S3TC_DXT5_Format);
  });
});

describe('canSlice', () => {
  /** A renderer with three's property store: a texture record is whatever the
   *  test put in it, and an untouched texture has an empty one, exactly as
   *  three's own WebGLProperties hands back. */
  function fakeRenderer(records = new Map<THREE.Texture, { __version?: number }>()) {
    const renderer = {
      getContext: () => fakeGl(),
      properties: {
        get: (obj: THREE.Texture) => {
          let record = records.get(obj);
          if (!record) { record = {}; records.set(obj, record); }
          return record;
        },
      },
    } as unknown as THREE.WebGLRenderer;
    return { renderer, records };
  }

  /** A compressed container as a KTX2 rung arrives: mip chain, linear format,
   *  and the version its loader stamps. */
  function container(): THREE.CompressedTexture {
    const mipmaps = [{ width: 4096, height: 2048, data: new Uint8Array(4096 * 2048) }];
    const tex = new THREE.CompressedTexture(mipmaps as unknown as ImageData[], 4096, 2048);
    tex.format = THREE.RGBA_ASTC_4x4_Format;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;
    tex.needsUpdate = true;
    return tex;
  }

  it('takes a compressed container three has not uploaded', () => {
    const { renderer } = fakeRenderer();
    expect(canSlice(renderer, container())).toBe(true);
  });

  it('refuses a texture three has already uploaded', () => {
    // A queued map that gets drawn before the pump reaches it is uploaded by
    // three at that draw. Beginning a job for it afterwards allocates nothing
    // and re-transfers the whole map band by band for no picture.
    const { renderer, records } = fakeRenderer();
    const tex = container();
    records.set(tex, { __version: tex.version });
    expect(canSlice(renderer, tex)).toBe(false);
  });

  it('takes a texture whose record is from an older version of it', () => {
    // A map three uploaded and something then mutated is due another upload,
    // which is exactly the one worth slicing.
    const { renderer, records } = fakeRenderer();
    const tex = container();
    records.set(tex, { __version: tex.version - 1 });
    expect(canSlice(renderer, tex)).toBe(true);
  });
});

describe('hasSrgbTransfer', () => {
  it('splits the colour spaces the app puts on a texture', () => {
    expect(hasSrgbTransfer(THREE.SRGBColorSpace)).toBe(true);
    expect(hasSrgbTransfer(THREE.LinearSRGBColorSpace)).toBe(false);
    expect(hasSrgbTransfer(THREE.NoColorSpace)).toBe(false);
  });

  it('reads the transfer function, so a space three registers later follows it', () => {
    // A colour space is a registration, not a fixed list: anything registered
    // with the sRGB transfer takes the sRGB branch in three's format
    // conversion, so it has to take it here too.
    const wide = 'test-wide-srgb';
    THREE.ColorManagement.define({
      [wide]: { ...THREE.ColorManagement.spaces[THREE.SRGBColorSpace] },
    });
    expect(wide).not.toBe(THREE.SRGBColorSpace);
    expect(hasSrgbTransfer(wide)).toBe(true);
    expect(compressedUploadFormat(fakeGl(), THREE.RGBA_ASTC_4x4_Format, wide)).toBe(0x93d0);
  });
});

describe('the compressed band probe', () => {
  const NO_ERROR = 0;
  const INVALID_ENUM = 0x0500;
  const INVALID_OPERATION = 0x0502;
  const CONTEXT_LOST_WEBGL = 0x9242;

  /** The internal format three's own conversion allocates with: the sRGB
   *  variant from the spec's table for an sRGB texture, the constant itself
   *  otherwise. */
  const threeAllocates = (format: number, srgb: boolean): number =>
    (srgb ? FORMATS.find(([, constant]) => constant === format)![2] : format);

  /**
   * A renderer and a GL context the slicer can drive. `initTexture` stands in
   * for three's allocation pass: it creates the record, allocates storage with
   * `allocate` (three's conversion unless a test says otherwise) and stamps the
   * version. A compressed band whose enum is not the storage's raises
   * INVALID_OPERATION on the error queue and is otherwise recorded — which is
   * what a driver does: no exception, an error flag, an empty texture.
   */
  function fakeRenderer(allocate = threeAllocates) {
    const records = new Map<THREE.Texture, { __webglTexture?: object; __version?: number }>();
    const storage = new Map<object, number>();
    const allocations: Array<{ texture: THREE.Texture; internalFormat: number; width: number }> = [];
    const bands: Array<{ storage: object | null; format: number; y: number; height: number }> = [];
    const gl = {
      NO_ERROR,
      TEXTURE_2D: 0x0de1,
      TEXTURE0: 0x84c0,
      UNPACK_FLIP_Y_WEBGL: 0x9240,
      UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
      UNPACK_ALIGNMENT: 0x0cf5,
      lost: false,
      queue: [] as number[],
      reads: 0,
      bound: null as object | null,
      getExtension: (name: string) => ALL_EXTENSIONS[name] ?? null,
      isContextLost() { return this.lost; },
      getError() {
        this.reads++;
        if (this.lost) return CONTEXT_LOST_WEBGL;
        return this.queue.shift() ?? NO_ERROR;
      },
      pixelStorei() {},
      compressedTexSubImage2D(_target: number, level: number, _x: number, y: number, _w: number, h: number, format: number) {
        if (this.lost) return;
        if (level === 0) bands.push({ storage: this.bound, format, y, height: h });
        if (this.bound === null || storage.get(this.bound) !== format) this.queue.push(INVALID_OPERATION);
      },
    };
    const record = (t: THREE.Texture) => {
      let r = records.get(t);
      if (!r) { r = {}; records.set(t, r); }
      return r;
    };
    const renderer = {
      getContext: () => gl,
      properties: { get: record },
      state: { bindTexture: (_target: number, tex: object | null) => { gl.bound = tex; } },
      initTexture: (texture: THREE.Texture) => {
        const r = record(texture);
        r.__webglTexture ??= {};
        gl.bound = r.__webglTexture;
        if (gl.lost) return;
        const internalFormat = allocate(texture.format as unknown as number, hasSrgbTransfer(texture.colorSpace));
        storage.set(r.__webglTexture, internalFormat);
        const width = (texture as THREE.CompressedTexture).mipmaps?.[0]?.width ?? 0;
        allocations.push({ texture, internalFormat, width });
        r.__version = texture.version;
      },
    } as unknown as THREE.WebGLRenderer;
    const probes = () => allocations.filter((a) => a.width === 16).length;
    /** The storage three's record holds for a texture. */
    const storageOf = (t: THREE.Texture) => record(t).__webglTexture;
    return { renderer, gl, allocations, bands, probes, storageOf };
  }

  /** A KTX2 rung as the loader hands it over: 1024×512 ASTC (the format this
   *  Mac's UASTC containers become), base plus one level, sRGB by default. */
  function container(colorSpace: string = THREE.SRGBColorSpace): THREE.CompressedTexture {
    const mipmaps = [
      { width: 1024, height: 512, data: new Uint8Array(256 * 128 * 16) },
      { width: 512, height: 256, data: new Uint8Array(128 * 64 * 16) },
    ];
    const tex = new THREE.CompressedTexture(mipmaps as unknown as ImageData[], 1024, 512, THREE.RGBA_ASTC_4x4_Format);
    tex.colorSpace = colorSpace;
    tex.flipY = false;
    tex.needsUpdate = true;
    return tex;
  }

  function finish(job: NonNullable<ReturnType<typeof beginSlicedUpload>>): string {
    for (let i = 0; i < 1000; i++) {
      const outcome = stepSlicedUpload(job, Number.POSITIVE_INFINITY);
      if (outcome !== 'more') return outcome;
    }
    return 'never finished';
  }

  beforeEach(() => resetCompressedBandProbesForTests());

  it('asks once per pair, and then bands every map of it without reading the error queue', () => {
    const { renderer, gl, bands, probes, storageOf } = fakeRenderer();
    const first = container();
    const job = beginSlicedUpload(renderer, first)!;
    expect(job).not.toBeNull();
    expect(probes()).toBe(1);
    // The drain's one read and the probe's own.
    expect(gl.reads).toBe(2);
    const readsBeforeBands = gl.reads;
    expect(finish(job)).toBe('done');
    expect(gl.reads).toBe(readsBeforeBands);
    const own = bands.filter((b) => b.storage === storageOf(first));
    expect(own.length).toBeGreaterThan(1);
    expect(own.every((b) => b.format === 0x93d0)).toBe(true);
    expect(gl.queue).toEqual([]);

    const second = beginSlicedUpload(renderer, container())!;
    expect(second).not.toBeNull();
    expect(probes()).toBe(1);
    expect(gl.reads).toBe(readsBeforeBands);
    expect(finish(second)).toBe('done');
    expect(gl.reads).toBe(readsBeforeBands);
  });

  it('a pair asked under the boot cover costs its first job nothing', () => {
    const { renderer, gl, probes } = fakeRenderer();
    expect(probeCompressedBands(renderer, THREE.RGBA_ASTC_4x4_Format, THREE.SRGBColorSpace)).toBe(true);
    const reads = gl.reads;
    const job = beginSlicedUpload(renderer, container())!;
    expect(finish(job)).toBe('done');
    expect(gl.reads).toBe(reads);
    expect(probes()).toBe(1);
  });

  it('a pair the driver refuses uploads whole from its first job, with no band of a map ever attempted', () => {
    // Storage allocated with the plain enum while the band speaks the sRGB
    // one: the mismatch the derivation exists to prevent.
    const { renderer, gl, allocations, bands, probes, storageOf } = fakeRenderer((format) => format);
    const first = container();
    expect(beginSlicedUpload(renderer, first)).toBeNull();
    expect(probes()).toBe(1);
    // Nothing allocated for the map itself, and the probe's band the only band.
    expect(allocations.filter((a) => a.texture === first)).toEqual([]);
    expect(bands).toHaveLength(1);
    expect(bands[0].storage).not.toBe(storageOf(first));
    const reads = gl.reads;
    expect(beginSlicedUpload(renderer, container())).toBeNull();
    expect(probes()).toBe(1);
    expect(gl.reads).toBe(reads);
    expect(bands).toHaveLength(1);
  });

  it('asks each colour space on its own', () => {
    const { renderer, probes } = fakeRenderer();
    finish(beginSlicedUpload(renderer, container(THREE.SRGBColorSpace))!);
    finish(beginSlicedUpload(renderer, container(THREE.NoColorSpace))!);
    expect(probes()).toBe(2);
    finish(beginSlicedUpload(renderer, container(THREE.LinearSRGBColorSpace))!);
    // Linear is linear, whichever linear space the texture names.
    expect(probes()).toBe(2);
  });

  it('drains an error someone else left on the queue instead of blaming the format for it', () => {
    const { renderer, gl } = fakeRenderer();
    gl.queue.push(INVALID_ENUM);
    expect(probeCompressedBands(renderer, THREE.RGBA_ASTC_4x4_Format, THREE.SRGBColorSpace)).toBe(true);
    expect(gl.queue).toEqual([]);
  });

  it('on a lost context asks nothing and records nothing, and the next job asks again', () => {
    const { renderer, gl, probes } = fakeRenderer();
    gl.lost = true;
    expect(probeCompressedBands(renderer, THREE.RGBA_ASTC_4x4_Format, THREE.SRGBColorSpace)).toBeNull();
    // The job goes ahead as any job on a lost context does, and reports it.
    const job = beginSlicedUpload(renderer, container());
    expect(job).not.toBeNull();
    expect(stepSlicedUpload(job!, Number.POSITIVE_INFINITY)).toBe('failed');
    expect(probes()).toBe(0);
    gl.lost = false;
    expect(finish(beginSlicedUpload(renderer, container())!)).toBe('done');
    expect(probes()).toBe(1);
  });

  it('keeps its verdict through a lost and restored context', () => {
    // The answer is about which enum the driver takes for which storage, not
    // about any GL object the loss takes away.
    const { renderer, gl, probes } = fakeRenderer();
    finish(beginSlicedUpload(renderer, container())!);
    gl.lost = true;
    expect(stepSlicedUpload(beginSlicedUpload(renderer, container())!, Number.POSITIVE_INFINITY)).toBe('failed');
    gl.lost = false;
    const reads = gl.reads;
    expect(finish(beginSlicedUpload(renderer, container())!)).toBe('done');
    expect(probes()).toBe(1);
    expect(gl.reads).toBe(reads);
  });

  it('never probes a format it does not slice', () => {
    const { renderer, probes } = fakeRenderer();
    expect(probeCompressedBands(renderer, THREE.RGB_ETC1_Format, THREE.SRGBColorSpace)).toBeNull();
    expect(probes()).toBe(0);
  });
});

describe('ktx2TranscodeFormats', () => {
  // The device shapes the app meets, by the extensions they expose, and what
  // three's KTX2Loader transcodes an opaque UASTC and ETC1S container to there.
  const has = (...names: string[]) => (name: string) => names.includes(name);
  it('an Apple GPU: UASTC to ASTC, ETC1S to ETC2', () => {
    expect(ktx2TranscodeFormats(has(
      'WEBGL_compressed_texture_astc', 'EXT_texture_compression_bptc',
      'WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_etc',
    ))).toEqual([THREE.RGBA_ASTC_4x4_Format, THREE.RGB_ETC2_Format]);
    expect(ktx2TranscodeFormats(has('WEBGL_compressed_texture_astc', 'WEBGL_compressed_texture_etc')))
      .toEqual([THREE.RGBA_ASTC_4x4_Format, THREE.RGB_ETC2_Format]);
  });
  it('a desktop with BC only: both to BC7, asked once', () => {
    expect(ktx2TranscodeFormats(has('EXT_texture_compression_bptc', 'WEBGL_compressed_texture_s3tc')))
      .toEqual([THREE.RGBA_BPTC_Format]);
  });
  it('S3TC alone: both to DXT1', () => {
    expect(ktx2TranscodeFormats(has('WEBGL_compressed_texture_s3tc'))).toEqual([THREE.RGBA_S3TC_DXT1_Format]);
  });
  it('ETC2 alone: both to ETC2', () => {
    expect(ktx2TranscodeFormats(has('WEBGL_compressed_texture_etc'))).toEqual([THREE.RGB_ETC2_Format]);
  });
  it('nothing it slices: ETC1, PVRTC or no compression at all', () => {
    expect(ktx2TranscodeFormats(has('WEBGL_compressed_texture_etc1'))).toEqual([]);
    expect(ktx2TranscodeFormats(has('WEBGL_compressed_texture_pvrtc'))).toEqual([]);
    expect(ktx2TranscodeFormats(has())).toEqual([]);
  });
});
