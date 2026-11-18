/**
 * The Retro look's picture: a post-process on the finished frame.
 *
 * The planetarium renders exactly as it always does. With this pass enabled
 * and last in the composer, the finishing pass writes its own 8-bit target
 * instead of the canvas (app/UpscalePass.ts OutputTargetPass, the same route
 * the upscaler uses), and this pass draws the canvas from it in two steps:
 *
 *  1. Reduce: one texel per big pixel (grid.ts), the average of the frame's
 *     pixels under it — except against dark sky. There a lone point (a star,
 *     a moon dot) is drawn by its light, as bright as the full-resolution
 *     frame drew it (POINT_CURVE), in the one big pixel that holds its
 *     middle, and a line or a bigger bright pixel mostly keeps its brightest
 *     pixel; faint ones fade out. Light rather than the brightest pixel, and
 *     soft edges rather than thresholds, because a point's brightest pixel
 *     swings by half as it slides across the frame's pixels (the lens's
 *     resample, a scene drawn coarser than the canvas: grid.ts), and with
 *     thresholds the stars blinked whenever the view moved.
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
uniform float uPixelArea;
uniform vec2 uPointCurve;
out vec4 fragColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float lumaAt(ivec2 texel, ivec2 last) {
  return dot(texelFetch(tInput, clamp(texel, ivec2(0), last), 0).rgb, LUMA);
}

// A display value back to the light before the tone curve, and forward again:
// the sRGB transfer and three's ACES fit, on luminance. The exposure stays
// folded into the light, so it cancels on the way back.
float toLight(float display) {
  float y = display <= 0.04045 ? display / 12.92 : pow((display + 0.055) / 1.055, 2.4);
  y = min(y, 0.99);
  float a = 1.0 - 0.983729 * y;
  float b = 0.0245786 - 0.432951 * y;
  float c = -(0.000090537 + 0.238081 * y);
  return (-b + sqrt(b * b - 4.0 * a * c)) / (2.0 * a);
}
float toDisplay(float light) {
  float y = (light * (light + 0.0245786) - 0.000090537) / (light * (0.983729 * light + 0.432951) + 0.238081);
  y = clamp(y, 0.0, 1.0);
  return y <= 0.0031308 ? y * 12.92 : 1.055 * pow(y, 1.0 / 2.4) - 0.055;
}

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
  ivec2 last = ivec2(uInputSize) - 1;
  vec3 sum = vec3(0.0);
  float count = 0.0;
  vec3 peak = vec3(0.0);
  float peakLuma = -1.0;
  ivec2 peakAt = lo;
  float lit = 0.0;
  for (int j = 0; j < ${MAX_TAPS}; j++) {
    int y = lo.y + j * max(1, (hi.y - lo.y + ${MAX_TAPS - 1}) / ${MAX_TAPS});
    if (y >= hi.y) break;
    for (int i = 0; i < ${MAX_TAPS}; i++) {
      int x = lo.x + i * max(1, (hi.x - lo.x + ${MAX_TAPS - 1}) / ${MAX_TAPS});
      if (x >= hi.x) break;
      vec3 colour = texelFetch(tInput, ivec2(x, y), 0).rgb;
      sum += colour;
      count += 1.0;
      float luma = dot(colour, LUMA);
      if (luma > peakLuma) { peakLuma = luma; peak = colour; peakAt = ivec2(x, y); }
      if (luma > 0.08) lit += 1.0;
    }
  }
  vec3 average = sum / max(count, 1.0);
  float averageLuma = dot(average, LUMA);

  // Against dark sky a bright pixel or a streak across the block (a line)
  // keeps most of its brightness, so the coarse grid does not average it
  // away; on a lit planet the brightest pixel is a cloud speck, and letting it
  // win would speckle the disc. Every edge is soft, so nothing flicks on or
  // off as it moves.
  float contrast = peakLuma / max(averageLuma, 0.01);
  float bright = max(smoothstep(0.25, 0.35, peakLuma), lit >= 0.1 * count ? smoothstep(0.1, 0.14, peakLuma) : 0.0);
  float keep = (1.0 - smoothstep(0.05, 0.07, averageLuma)) * smoothstep(2.0, 2.6, contrast) * bright
    * min(0.85, max(contrast - 2.2, 0.0) * 0.25 + 0.45);
  vec3 kept = peak;

  // A lone point (a star, a moon dot) is drawn by its light rather than its
  // brightest pixel: the lens's resample and a coarse scene spread a point
  // over its pixels, which moves its brightest pixel by half as it slides
  // across them but keeps the sum. First the point's own brightest pixel,
  // which may be across the block's edge.
  ivec2 centre = peakAt;
  float centreLuma = peakLuma;
  for (int climb = 0; climb < 2; climb++) {
    ivec2 from = centre;
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        ivec2 texel = clamp(from + ivec2(dx, dy), ivec2(0), last);
        float luma = lumaAt(texel, last);
        if (luma > centreLuma) { centreLuma = luma; centre = texel; }
      }
    }
  }
  // The ring two pixels out: the sky behind the point, and whether anything
  // else is lit there. A line or a disc's edge crosses it at least twice.
  float ringLow = 1.0;
  float ringLit = 0.0;
  for (int dy = -2; dy <= 2; dy++) {
    for (int dx = -2; dx <= 2; dx++) {
      if (abs(dx) < 2 && abs(dy) < 2) continue;
      float luma = lumaAt(centre + ivec2(dx, dy), last);
      ringLow = min(ringLow, luma);
      ringLit += smoothstep(0.35, 0.65, luma / max(centreLuma, 1e-3));
    }
  }
  float lone = (1.0 - smoothstep(0.8, 1.8, ringLit)) * (1.0 - smoothstep(0.03, 0.08, ringLow));
  // Its light above the sky, and where its middle is: the one big pixel
  // holding that draws it, so a point across two blocks is drawn once.
  float sky = toLight(ringLow);
  float light = 0.0;
  vec2 moment = vec2(0.0);
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      float above = max(toLight(lumaAt(centre + ivec2(dx, dy), last)) - sky, 0.0);
      light += above;
      moment += above * vec2(dx, dy);
    }
  }
  vec2 middle = vec2(centre) + 0.5 + moment / max(light, 1e-6);
  bool here = all(greaterThanEqual(middle, vec2(lo))) && all(lessThan(middle, vec2(hi)));
  // As the full-resolution frame drew it: its brightest pixel there, which
  // grows more slowly than its light, a brighter point being bigger.
  float fullLight = light * uPixelArea;
  float pointLuma = toDisplay(sky + uPointCurve.x * pow(fullLight, uPointCurve.y));
  // The point's rule alone draws a lone point, in whichever block holds it.
  keep *= 1.0 - lone;
  float pointKeep = here ? lone * smoothstep(0.22, 0.32, pointLuma) * 0.85 : 0.0;
  if (pointKeep > keep) {
    keep = pointKeep;
    vec3 colour = texelFetch(tInput, centre, 0).rgb;
    kept = colour * (pointLuma / max(dot(colour, LUMA), 1e-4));
    kept /= max(1.0, max(kept.r, max(kept.g, kept.b)));
  }
  fragColor = vec4(mix(average, kept, keep), 1.0);
}
`;

/**
 * A lone point's brightest pixel at full resolution, from its light there
 * (both before the tone curve, the light counted in full-resolution pixels):
 * `scale · light ^ power`. The app draws a brighter star bigger as well as
 * brighter, so its peak grows more slowly than its light. The power and a
 * scale of 0.22 fit about 4,400 of the app's stars, each matched with its
 * full-resolution frame, to within a tenth across the whole range; the scale
 * is raised to 0.27 so that as many stars show as that frame showed, the
 * frame's own peaks scattering more stars over the edge than this steady
 * measure does.
 */
const POINT_CURVE = { scale: 0.27, power: 0.68 };

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
  /** One texel per big pixel: raw 8-bit storage, read by exact texel. */
  private readonly small = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.UnsignedByteType, colorSpace: THREE.NoColorSpace, depthBuffer: false,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
  });
  /** The grid, in one set of uniform objects both steps share. */
  private readonly gridUniforms = {
    uBuffer: { value: new THREE.Vector2() }, uBlock: { value: 1 }, uVirtual: { value: new THREE.Vector2() },
  };
  private readonly inputUniforms = {
    tInput: { value: null as THREE.Texture | null }, uInputSize: { value: new THREE.Vector2() },
    uPixelArea: { value: 1 }, uPointCurve: { value: new THREE.Vector2(POINT_CURVE.scale, POINT_CURVE.power) },
  };
  private readonly paletteUniform = { value: null as THREE.DataTexture | null };
  private readonly reduce = material(REDUCE_SHADER, { ...this.inputUniforms, ...this.gridUniforms });
  // setSize keeps the small target's texture object, so it is bound once.
  private readonly present = material(PRESENT_SHADER, {
    tSmall: { value: this.small.texture }, tPalette: this.paletteUniform, ...this.gridUniforms,
  });
  private readonly reduceQuad = new FullScreenQuad(this.reduce);
  private readonly presentQuad = new FullScreenQuad(this.present);

  constructor(private readonly source: FrameSource) {
    super();
    this.needsSwap = false;
  }

  render(renderer: THREE.WebGLRenderer): void {
    const input = this.source.target;
    if (!input || !this.renderToScreen) return;
    const shared = this.gridUniforms;
    const buffer = renderer.getDrawingBufferSize(shared.uBuffer.value);
    const grid = retroGrid(buffer.x, buffer.y, renderer.getPixelRatio());
    if (this.small.width !== grid.virtual.width || this.small.height !== grid.virtual.height) {
      this.small.setSize(grid.virtual.width, grid.virtual.height);
    }
    shared.uBlock.value = grid.block;
    shared.uVirtual.value.set(grid.virtual.width, grid.virtual.height);
    const drawn = drawnSize(input);
    this.inputUniforms.tInput.value = input.texture;
    this.inputUniforms.uInputSize.value.set(drawn.width, drawn.height);
    // A frame pixel is (canvas / frame)² full-resolution pixels.
    const across = buffer.x / drawn.width;
    this.inputUniforms.uPixelArea.value = across * across;
    renderer.setRenderTarget(this.small);
    this.reduceQuad.render(renderer);
    this.paletteUniform.value = retroPaletteTexture();
    renderer.setRenderTarget(null);
    this.presentQuad.render(renderer);
    this.inputUniforms.tInput.value = null;
  }

  dispose(): void {
    this.reduce.dispose();
    this.present.dispose();
    this.reduceQuad.dispose();
    this.presentQuad.dispose();
    this.small.dispose();
  }
}
