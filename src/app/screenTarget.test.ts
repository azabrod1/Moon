import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createScreenTarget, screenTargetBytesPerPixel } from './screenTarget';

const require = createRequire(import.meta.url);
const three = (rel: string) => readFileSync(require.resolve(`three/src/${rel}`), 'utf8');

describe('a screen target', () => {
  it('is an XR-flagged sRGB target stored as plain RGBA8, nearest-filtered, with no depth resolve', () => {
    const t = createScreenTarget(320, 200, 4);
    expect((t as unknown as { isXRRenderTarget: boolean }).isXRRenderTarget).toBe(true);
    expect(t.texture.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(t.texture.internalFormat).toBe('RGBA8');
    expect(t.texture.type).toBe(THREE.UnsignedByteType);
    expect(t.texture.minFilter).toBe(THREE.NearestFilter);
    expect(t.texture.magFilter).toBe(THREE.NearestFilter);
    expect(t.samples).toBe(4);
    expect(t.depthBuffer).toBe(true);
    expect(t.stencilBuffer).toBe(false);
    const direct = createScreenTarget(8, 8, 4, { stencil: true, linear: true });
    expect(direct.stencilBuffer).toBe(true);
    expect(direct.texture.minFilter).toBe(THREE.LinearFilter);
    expect(direct.texture.magFilter).toBe(THREE.LinearFilter);
    expect(t.resolveDepthBuffer).toBe(false);
    expect([t.width, t.height]).toEqual([320, 200]);
  });

  it('counts its bytes: four samples of colour and depth, the resolve texture, and its depth plane', () => {
    expect(screenTargetBytesPerPixel(4)).toBe(40);
    expect(screenTargetBytesPerPixel(0)).toBe(8);
  });
});

/**
 * The three.js rules the screen target leans on, pinned as text so an upgrade
 * that changes any of them fails here rather than in a washed-out map.
 */
describe('the three.js rules behind it', () => {
  it('shades an XR-flagged target as the screen: tone mapping on, output colour space from its texture', () => {
    const programs = three('renderers/webgl/WebGLPrograms.js');
    expect(programs).toContain('if ( currentRenderTarget === null || currentRenderTarget.isXRRenderTarget === true ) {');
    expect(programs).toContain("outputColorSpace: ( currentRenderTarget === null ) ? renderer.outputColorSpace : ( currentRenderTarget.isXRRenderTarget === true ? currentRenderTarget.texture.colorSpace : LinearSRGBColorSpace )");
    const renderer = three('renderers/WebGLRenderer.js');
    expect(renderer).toContain('if ( _currentRenderTarget === null || _currentRenderTarget.isXRRenderTarget === true ) {');
    const uniforms = three('renderers/shaders/UniformsUtils.js');
    expect(uniforms).toContain('if ( currentRenderTarget.isXRRenderTarget === true ) {');
  });

  it('allocates the resolve texture without the XR linear-transfer override, which is why the internal format is named by hand', () => {
    const textures = three('renderers/webgl/WebGLTextures.js');
    // The resolve texture: four arguments, the transfer decided from the colour space alone.
    expect(textures).toContain('const glInternalFormat = getInternalFormat( texture.internalFormat, glFormat, glType, texture.colorSpace );');
    // The multisample renderbuffer: the flag forces a linear transfer here only.
    expect(textures).toContain('getInternalFormat( texture.internalFormat, glFormat, glType, texture.colorSpace, renderTarget.isXRRenderTarget === true );');
    // A named internal format wins before either transfer rule is consulted.
    expect(textures).toContain('if ( internalFormatName !== null ) {');
    // On a GPU with the render-to-texture extension there is no renderbuffer at all: the texture IS the attachment.
    expect(textures).toContain("return renderTarget.samples > 0 && extensions.has( 'WEBGL_multisampled_render_to_texture' ) === true");
  });
});
