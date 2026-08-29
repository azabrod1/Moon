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
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { compressedUploadFormat, hasSrgbTransfer } from './slicedUpload';

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
