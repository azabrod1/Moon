/**
 * The Retro look's last pass: the small screen, cut to the palette and shown
 * with hard pixels.
 *
 * In retro the finishing pass (app/FusedOutputPass.ts) draws, unchanged, into
 * its own 8-bit target the size of the retro grid (app/retroScreen.ts) — the
 * lens warp solved once per big pixel, a scene drawn 1.5 × the grid averaged
 * down by its box, the glow and the tone curve as ever. This pass then draws
 * the canvas from that target:
 *
 *  1. Each canvas pixel finds the big pixel it sits in, counted from the
 *     canvas's TOP-left, the corner the interface's grid is anchored to; the
 *     target is stored bottom-up, so the row is flipped for the fetch. One
 *     exact texel, no filtering: every big pixel is a solid square.
 *  2. An 8 × 8 ordered (Bayer) dither, indexed by the big pixel and by nothing
 *     else, so a still view stays byte-identical frame to frame and the
 *     pattern is fixed to the screen, as on the real machines. It fades out
 *     towards black: the palette's darkest steps sit close together, and a
 *     full-strength pattern there would lay a faint checker over empty space.
 *  3. The nearest of the 256 colours (app/retroPalette.ts), from a lookup
 *     texture at 5 bits a channel: one fetch.
 *
 * The output dither (app/outputDither.ts) is not added: the Bayer pattern is
 * this frame's one dither, and ±1 of grain after the cut would leave the
 * palette. Every intermediate before this pass is written clean, as on the
 * other resample routes (app/UpscalePass.ts), because the finishing pass's
 * uDither is on only for a canvas write.
 *
 * A raw GLSL3 material, like the resample passes, so the destination's colour
 * space never re-keys its program. needsSwap is false: it reads the finishing
 * pass's own target, not the composer's buffers.
 */
import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { FSR1_VERTEX_SHADER } from './fsr1';
import { RETRO_LOOKUP_STEPS, retroLookup } from './retroPalette';
import type { RetroGrid } from './retroScreen';
import type { OutputTargetPass } from './UpscalePass';

/** How far the dither moves a colour before the cut: three quarters of the
 *  palette's mean spacing (256 colours → about 1/6.35 of the range a
 *  channel), times the strength tuned in the mock. */
export const RETRO_DITHER = (0.75 / Math.cbrt(256)) * 0.8;

export const RETRO_PRESENT_FRAGMENT_SHADER = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D tInput;
uniform sampler2D tPalette;
uniform float uBlock;
uniform vec2 uBuffer;
uniform ivec2 uVirtual;
uniform float uBayer;
out vec4 fragColor;

// The 8 x 8 Bayer threshold at a big pixel, in (0, 1).
float bayer8(ivec2 big) {
  int x = big.x & 7;
  int y = big.y & 7;
  int mixed = x ^ y;
  int index = 0;
  for (int bit = 0; bit < 3; bit++) {
    index = (index << 2) | (((mixed >> bit) & 1) << 1) | ((y >> bit) & 1);
  }
  return (float(index) + 0.5) / 64.0;
}

void main() {
  // The big pixel under this canvas pixel, counted from the top-left.
  ivec2 big = ivec2(
    int(floor(gl_FragCoord.x / uBlock)),
    int(floor((uBuffer.y - gl_FragCoord.y) / uBlock))
  );
  big = clamp(big, ivec2(0), uVirtual - 1);
  vec3 colour = texelFetch(tInput, ivec2(big.x, uVirtual.y - 1 - big.y), 0).rgb;
  // Faded out towards black, so empty space stays black instead of a faint
  // checker of the darkest ramp steps.
  float brightest = max(colour.r, max(colour.g, colour.b));
  colour += (bayer8(big) - 0.5) * uBayer * smoothstep(0.02, 0.1, brightest);
  ivec3 key = clamp(ivec3(floor(colour * ${RETRO_LOOKUP_STEPS - 1}.0 + 0.5)), ivec3(0), ivec3(${RETRO_LOOKUP_STEPS - 1}));
  fragColor = vec4(texelFetch(tPalette, ivec2(key.r + ${RETRO_LOOKUP_STEPS} * key.b, key.g), 0).rgb, 1.0);
}
`;

/** The lookup as a texture: exact texels, no mipmaps, raw bytes. Built once. */
let paletteTexture: THREE.DataTexture | null = null;
function retroPaletteTexture(): THREE.DataTexture {
  if (paletteTexture) return paletteTexture;
  const steps = RETRO_LOOKUP_STEPS;
  const texture = new THREE.DataTexture(retroLookup(), steps * steps, steps, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  paletteTexture = texture;
  return texture;
}

export class RetroPresentPass extends Pass {
  readonly material: THREE.RawShaderMaterial;
  private readonly quad: FullScreenQuad;
  private readonly bufferSize = new THREE.Vector2();

  /** `grid` is read at every render, so a resize needs no call here. */
  constructor(private readonly source: OutputTargetPass, private readonly grid: () => RetroGrid) {
    super();
    this.needsSwap = false;
    this.enabled = false;
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        tInput: { value: null },
        tPalette: { value: null },
        uBlock: { value: 1 },
        uBuffer: { value: new THREE.Vector2(1, 1) },
        uVirtual: { value: new THREE.Vector2(1, 1) },
        uBayer: { value: RETRO_DITHER },
      },
      vertexShader: FSR1_VERTEX_SHADER,
      fragmentShader: RETRO_PRESENT_FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  render(renderer: THREE.WebGLRenderer): void {
    const input = this.source.target;
    // Nothing to present: the finishing pass drew the canvas itself.
    if (!input || !this.renderToScreen) return;
    const grid = this.grid();
    renderer.getDrawingBufferSize(this.bufferSize);
    const u = this.material.uniforms;
    u.tInput.value = input.texture;
    u.tPalette.value = retroPaletteTexture();
    u.uBlock.value = grid.block;
    (u.uBuffer.value as THREE.Vector2).copy(this.bufferSize);
    (u.uVirtual.value as THREE.Vector2).set(grid.virtual.width, grid.virtual.height);
    renderer.setRenderTarget(null);
    this.quad.render(renderer);
    u.tInput.value = null;
  }

  /** Link the program now, under a cover, rather than on the first retro
   *  frame; and build the lookup with it. */
  warm(renderer: THREE.WebGLRenderer): void {
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(null);
    const input = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    input.needsUpdate = true;
    this.material.uniforms.tInput.value = input;
    this.material.uniforms.tPalette.value = retroPaletteTexture();
    const scene = new THREE.Scene();
    const geometry = new THREE.PlaneGeometry(2, 2);
    scene.add(new THREE.Mesh(geometry, this.material));
    renderer.compile(scene, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));
    this.material.uniforms.tInput.value = null;
    geometry.dispose();
    input.dispose();
    renderer.setRenderTarget(previous);
  }

  dispose(): void {
    this.material.dispose();
    this.quad.dispose();
  }
}
