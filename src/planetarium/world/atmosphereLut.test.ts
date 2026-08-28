import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  atmosphereLutProfile,
  createScatteringTarget,
  createTableTarget,
} from './atmosphereLut';
import {
  ATMOSPHERE_TABLE_SIZES_FULL,
  ATMOSPHERE_TABLE_SIZES_HALF,
  scatteringTextureWidth,
} from './atmosphereModel';

describe('atmosphere table targets', () => {
  it('configures the 3D scattering target so a layer render can reach it', () => {
    const target = createScatteringTarget(ATMOSPHERE_TABLE_SIZES_FULL);
    try {
      // One output only: only slot 0 of a 3D render target is a Data3DTexture,
      // and the layer attach walks every attachment.
      expect(target.textures.length).toBe(1);
      expect((target.texture as THREE.Data3DTexture).isData3DTexture).toBe(true);
      expect(target.width).toBe(scatteringTextureWidth(ATMOSPHERE_TABLE_SIZES_FULL));
      expect(target.height).toBe(ATMOSPHERE_TABLE_SIZES_FULL.scatteringMu);
      expect(target.depth).toBe(ATMOSPHERE_TABLE_SIZES_FULL.scatteringR);
      expect(target.texture.type).toBe(THREE.HalfFloatType);
      // magFilter is only copied when the caller passes it, and a Data3DTexture
      // is born Nearest on both — the default is a banded lookup.
      expect(target.texture.magFilter).toBe(THREE.LinearFilter);
      expect(target.texture.minFilter).toBe(THREE.LinearFilter);
      expect(target.texture.generateMipmaps).toBe(false);
      expect(target.texture.wrapS).toBe(THREE.ClampToEdgeWrapping);
      expect(target.texture.wrapT).toBe(THREE.ClampToEdgeWrapping);
      expect(target.texture.wrapR).toBe(THREE.ClampToEdgeWrapping);
      // A depth renderbuffer is allocated per target, and samples > 0 routes
      // the bind into the multisample framebuffer before the 3D branch runs.
      expect(target.depthBuffer).toBe(false);
      expect(target.stencilBuffer).toBe(false);
      expect(target.samples).toBe(0);
    } finally {
      target.dispose();
    }
  });

  it('configures the 2D tables the same way', () => {
    const target = createTableTarget(256, 64);
    try {
      expect(target.texture.type).toBe(THREE.HalfFloatType);
      expect(target.texture.magFilter).toBe(THREE.LinearFilter);
      expect(target.texture.minFilter).toBe(THREE.LinearFilter);
      expect(target.depthBuffer).toBe(false);
      expect(target.stencilBuffer).toBe(false);
      expect(target.samples).toBe(0);
    } finally {
      target.dispose();
    }
  });

  it('sizes the scattering table so nu and mu_s share the x axis', () => {
    for (const sizes of [ATMOSPHERE_TABLE_SIZES_FULL, ATMOSPHERE_TABLE_SIZES_HALF]) {
      const target = createScatteringTarget(sizes);
      try {
        expect(target.width).toBe(sizes.scatteringNu * sizes.scatteringMuS);
        // The mu axis folds in half, so it must be even.
        expect(sizes.scatteringMu % 2).toBe(0);
      } finally {
        target.dispose();
      }
    }
  });

  it('gives touch devices half tables at two orders', () => {
    expect(atmosphereLutProfile(false)).toEqual({ sizes: ATMOSPHERE_TABLE_SIZES_FULL, orders: 4 });
    expect(atmosphereLutProfile(true)).toEqual({ sizes: ATMOSPHERE_TABLE_SIZES_HALF, orders: 2 });
    // The touch scattering table is a quarter of the desktop one.
    const full = createScatteringTarget(ATMOSPHERE_TABLE_SIZES_FULL);
    const half = createScatteringTarget(ATMOSPHERE_TABLE_SIZES_HALF);
    try {
      const texels = (t: THREE.WebGL3DRenderTarget) => t.width * t.height * t.depth;
      expect(texels(full) / texels(half)).toBe(4);
      expect(texels(full) * 8).toBe(8 * 1024 * 1024);
    } finally {
      full.dispose();
      half.dispose();
    }
  });
});
