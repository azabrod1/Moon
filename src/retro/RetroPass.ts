/**
 * The Retro look's picture: a post-process on the finished frame.
 *
 * The planetarium renders exactly as it always does. With this pass enabled
 * and last in the composer, the finishing pass writes its own 8-bit target
 * instead of the canvas (app/UpscalePass.ts OutputTargetPass, the same route
 * the upscaler uses), and this pass draws the canvas from it in two steps:
 *
 *  1. Reduce: one texel per big pixel (grid.ts), the average of the frame's
 *     pixels under it — except that where its brightest pixel is far
 *     brighter than the average (a star, a thin line), that pixel mostly
 *     wins, so the coarse grid does not average the sky's points away.
 *  2. Present: each canvas pixel shows its big pixel, counted from the top-left
 *     as the interface's grid is, cut to the 256-colour palette (palette.ts)
 *     with an 8 × 8 ordered dither fixed to the big pixel, faded out towards
 *     black so empty space stays black.
 *
 * Nothing upstream changes, so the rest of the app never needs to know this
 * pass exists, and it imports nothing from the app: all it reads is the
 * finishing pass's `target`. Raw GLSL3 materials, so drawing the canvas never
 * re-keys their programs.
 */
import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { retroGrid } from './grid';
import { RETRO_LOOKUP_STEPS, retroLookup } from './palette';

/** What the pass reads: the finished frame, in the finishing pass's own
 *  8-bit target, display-encoded (null until something needed it). */
export interface FrameSource {
  readonly target: THREE.WebGLRenderTarget | null;
}

const VERTEX_SHADER = /* glsl */ `
precision highp float;
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/** The part of a target a frame was drawn into: its viewport, which a fixed
 *  allocation narrows to a corner of the target. */
function drawnSize(target: THREE.WebGLRenderTarget): { width: number; height: number } {
  return {
    width: Math.min(target.width, Math.max(1, Math.round(target.viewport.z))),
    height: Math.min(target.height, Math.max(1, Math.round(target.viewport.w))),
  };
}

/** The most frame pixels a big pixel's average reads along each axis. */
const MAX_TAPS = 24;

const REDUCE_SHADER = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D tInput;
uniform vec2 uInputSize;
uniform vec2 uBuffer;
uniform float uBlock;
uniform ivec2 uVirtual;
out vec4 fragColor;

void main() {
  ivec2 big = ivec2(gl_FragCoord.xy);
  // This big pixel's span of the canvas, from the top-left, clipped to it.
  float rowFromTop = float(uVirtual.y - 1 - big.y);
  vec2 canvasMin = vec2(float(big.x) * uBlock, rowFromTop * uBlock);
  vec2 canvasMax = min(canvasMin + uBlock, uBuffer);
  // The same span in the frame's texels, which are stored bottom-up.
  vec2 scale = uInputSize / uBuffer;
  ivec2 lo = ivec2(floor(vec2(canvasMin.x, uBuffer.y - canvasMax.y) * scale));
  ivec2 hi = max(lo + 1, ivec2(ceil(vec2(canvasMax.x, uBuffer.y - canvasMin.y) * scale)));
  hi = min(hi, ivec2(uInputSize));
  vec3 sum = vec3(0.0);
  float count = 0.0;
  vec3 peak = vec3(0.0);
  float peakLuma = -1.0;
  for (int j = 0; j < ${MAX_TAPS}; j++) {
    int y = lo.y + j * max(1, (hi.y - lo.y + ${MAX_TAPS - 1}) / ${MAX_TAPS});
    if (y >= hi.y) break;
    for (int i = 0; i < ${MAX_TAPS}; i++) {
      int x = lo.x + i * max(1, (hi.x - lo.x + ${MAX_TAPS - 1}) / ${MAX_TAPS});
      if (x >= hi.x) break;
      vec3 colour = texelFetch(tInput, ivec2(x, y), 0).rgb;
      sum += colour;
      count += 1.0;
      float luma = dot(colour, vec3(0.2126, 0.7152, 0.0722));
      if (luma > peakLuma) { peakLuma = luma; peak = colour; }
    }
  }
  vec3 average = sum / max(count, 1.0);
  float averageLuma = dot(average, vec3(0.2126, 0.7152, 0.0722));
  if (peakLuma > 0.18 && peakLuma > averageLuma * 2.2) {
    float weight = min(0.85, (peakLuma / max(averageLuma, 0.01) - 2.2) * 0.25 + 0.45);
    average = mix(average, peak, weight);
  }
  fragColor = vec4(average, 1.0);
}
`;

/** How far the dither moves a colour before the cut: three quarters of the
 *  palette's mean spacing, times the strength tuned on frames of the app. */
const DITHER = (0.75 / Math.cbrt(256)) * 0.8;

const PRESENT_SHADER = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D tSmall;
uniform sampler2D tPalette;
uniform float uBlock;
uniform vec2 uBuffer;
uniform ivec2 uVirtual;
out vec4 fragColor;

// The 8 x 8 Bayer threshold at a big pixel, in (0, 1).
float bayer8(ivec2 big) {
  int y = big.y & 7;
  int mixed = (big.x & 7) ^ y;
  int index = 0;
  for (int bit = 0; bit < 3; bit++) index = (index << 2) | (((mixed >> bit) & 1) << 1) | ((y >> bit) & 1);
  return (float(index) + 0.5) / 64.0;
}

void main() {
  ivec2 big = clamp(ivec2(floor(gl_FragCoord.x / uBlock), floor((uBuffer.y - gl_FragCoord.y) / uBlock)), ivec2(0), uVirtual - 1);
  vec3 colour = texelFetch(tSmall, ivec2(big.x, uVirtual.y - 1 - big.y), 0).rgb;
  float brightest = max(colour.r, max(colour.g, colour.b));
  colour += (bayer8(big) - 0.5) * ${DITHER.toFixed(6)} * smoothstep(0.02, 0.1, brightest);
  ivec3 key = clamp(ivec3(floor(colour * ${RETRO_LOOKUP_STEPS - 1}.0 + 0.5)), ivec3(0), ivec3(${RETRO_LOOKUP_STEPS - 1}));
  fragColor = vec4(texelFetch(tPalette, ivec2(key.r + ${RETRO_LOOKUP_STEPS} * key.b, key.g), 0).rgb, 1.0);
}
`;

function material(fragmentShader: string, uniforms: Record<string, THREE.IUniform>): THREE.RawShaderMaterial {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, uniforms, vertexShader: VERTEX_SHADER, fragmentShader,
    depthTest: false, depthWrite: false, blending: THREE.NoBlending,
  });
}

/** The palette lookup as a texture, built the first time the look is drawn. */
let paletteTexture: THREE.DataTexture | null = null;
function retroPaletteTexture(): THREE.DataTexture {
  if (paletteTexture) return paletteTexture;
  const steps = RETRO_LOOKUP_STEPS;
  paletteTexture = new THREE.DataTexture(retroLookup(), steps * steps, steps, THREE.RGBAFormat, THREE.UnsignedByteType);
  paletteTexture.minFilter = THREE.NearestFilter;
  paletteTexture.magFilter = THREE.NearestFilter;
  paletteTexture.needsUpdate = true;
  return paletteTexture;
}

export class RetroPass extends Pass {
  private readonly reduce = material(REDUCE_SHADER, {
    tInput: { value: null }, uInputSize: { value: new THREE.Vector2() }, uBuffer: { value: new THREE.Vector2() },
    uBlock: { value: 1 }, uVirtual: { value: new THREE.Vector2() },
  });
  private readonly present = material(PRESENT_SHADER, {
    tSmall: { value: null }, tPalette: { value: null }, uBuffer: { value: new THREE.Vector2() },
    uBlock: { value: 1 }, uVirtual: { value: new THREE.Vector2() },
  });
  private readonly reduceQuad = new FullScreenQuad(this.reduce);
  private readonly presentQuad = new FullScreenQuad(this.present);
  /** One texel per big pixel: raw 8-bit storage, read by exact texel. */
  private readonly small = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.UnsignedByteType, colorSpace: THREE.NoColorSpace, depthBuffer: false,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
  });
  private readonly buffer = new THREE.Vector2();

  constructor(private readonly source: FrameSource) {
    super();
    this.needsSwap = false;
  }

  render(renderer: THREE.WebGLRenderer): void {
    const input = this.source.target;
    if (!input || !this.renderToScreen) return;
    renderer.getDrawingBufferSize(this.buffer);
    const grid = retroGrid(this.buffer.x, this.buffer.y, renderer.getPixelRatio());
    if (this.small.width !== grid.virtual.width || this.small.height !== grid.virtual.height) {
      this.small.setSize(grid.virtual.width, grid.virtual.height);
    }
    const drawn = drawnSize(input);
    const r = this.reduce.uniforms;
    r.tInput.value = input.texture;
    (r.uInputSize.value as THREE.Vector2).set(drawn.width, drawn.height);
    (r.uBuffer.value as THREE.Vector2).copy(this.buffer);
    r.uBlock.value = grid.block;
    (r.uVirtual.value as THREE.Vector2).set(grid.virtual.width, grid.virtual.height);
    renderer.setRenderTarget(this.small);
    this.reduceQuad.render(renderer);
    const p = this.present.uniforms;
    p.tSmall.value = this.small.texture;
    p.tPalette.value = retroPaletteTexture();
    (p.uBuffer.value as THREE.Vector2).copy(this.buffer);
    p.uBlock.value = grid.block;
    (p.uVirtual.value as THREE.Vector2).set(grid.virtual.width, grid.virtual.height);
    renderer.setRenderTarget(null);
    this.presentQuad.render(renderer);
    r.tInput.value = null;
  }

  dispose(): void {
    this.reduce.dispose();
    this.present.dispose();
    this.reduceQuad.dispose();
    this.presentQuad.dispose();
    this.small.dispose();
  }
}
