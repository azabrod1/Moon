/**
 * The interface's frosted glass, blurred by the renderer instead of the
 * browser.
 *
 * **Why.** Every panel and button of the interface is a tinted surface with a
 * CSS `backdrop-filter` blur. The canvas under them changes every frame, so the
 * browser's compositor re-blurs each one every frame as a readback and a blur
 * of its own, outside anything the app can see or schedule: in the ship view
 * at Earth, seven of them held an M5 Max (Chromium on Metal, 3456 × 2234 at
 * High) at 102.6 fps where the same frame without them ran at the display's
 * 120, and while the view is dragged that side work spiked to 4–7.6 ms. Games
 * and Apple's own interface do this the other way round: they blur a shrunk
 * copy of the frame themselves and sample it behind each panel. That is what
 * this does, inside the frame the app already draws.
 *
 * **The source.** A quarter-size copy of the finished picture, made before the
 * finishing pass writes the canvas, so the canvas write stays the frame's last
 * render pass and the glass continues it: a tile GPU never has to load a
 * canvas it has just stored. A pass placed after the bloom chain
 * (GlassSourcePass) draws the finishing pass's own material — the lens warp,
 * the glow and the tone curve, the same uniforms the canvas write is about to
 * use — at half the canvas's size into an 8-bit target, then averages that
 * 2:1 into the quarter-size one. Read at one bilinear tap per sixteen canvas
 * pixels the picture would alias: a star, the glint or a city light would
 * shimmer under the glass as the view turned. Where the scene is drawn at the
 * canvas's own size (Medium, the native route) the half-size draw's one
 * bilinear read is itself a 2 × 2 average of the scene and the 2:1 box makes
 * it 4 × 4: the prefilter covers the quarter texel's whole footprint. Where
 * the scene is drawn larger (High, and Dynamic's rungs above Medium, at 1.5×
 * or 1.25× the canvas) a half texel spans 3 × 3 scene texels and the read
 * averages only 2 × 2 of them, so the prefilter is narrower than its
 * footprint and a point much brighter than its neighbours can still flicker
 * under a small blur as it crosses texels; on the upscale route (a smaller
 * scene) it is wider. Only the panels' own boxes are drawn, never the whole frame: each
 * pass is a quad per panel, so the work follows the glass on screen.
 * The finishing material is read live from the finishing pass every frame —
 * a composer is rebuilt for every camera and disposes its passes — and its
 * dither and its supersample's box (`uBox`, where the variant carries one)
 * are held off for this draw and put back. On the upscale route the finishing
 * pass's own 8-bit target holds the frame already, but at the scene's size and
 * not on every route; the half-size draw serves every route the same way, and
 * over the panels alone it is a hundredth of a millisecond (below).
 *
 * **The blur.** One separable Gaussian per panel at quarter size, inside the
 * panel's own box, the box's edges mirrored — what Chromium and WebKit draw:
 * the backdrop is clipped to the element's border box and the blur's edges
 * reflect inside it, so a bright band just outside a panel does not bleed
 * into it. The standard deviation is the CSS radius in canvas pixels
 * (app/glassRects.ts), less the 2-pixel blur the 4 × 4 prefilter and the
 * final bilinear stretch already add at the native ratio, so a 2px blur is a
 * 2px blur and a 30px one is not 30.07. That correction is the native
 * ratio's: where the scene is drawn larger the prefilter adds a little less,
 * and the drawn blur comes out that much under the radius — a fraction of a
 * pixel, which no radius in use shows. Both passes run at quarter size, horizontal into a
 * scratch target and vertical back into the quarter-size source. A vertical
 * pass drawn at the canvas's size inside the composite would read its whole
 * kernel per canvas pixel — sixteen times the taps for a picture that is a
 * smooth blur either way — and the browsers themselves blur a large radius at
 * reduced size and stretch it back. Taps
 * are the Gaussian truncated at 3σ, read in bilinear pairs (two texels a
 * fetch), normalised by their own sum. Each read is mirrored into the box and
 * then held between the centres of the box's first and last whole texels, so
 * a bilinear tap never reaches a texel centred outside it.
 *
 * **The composite.** Right after the canvas write, in the same pass: a quad
 * per panel over its box, which reads the blurred copy, applies `saturate()`
 * with the CSS matrix (0.213 / 0.715 / 0.072, clamped) in display-encoded
 * values, as the browsers do, rounds the corners with the box's own radii,
 * adds the frame's output dither (app/outputDither.ts — every 8-bit write of
 * the picture carries it) and blends the result over the canvas by its
 * coverage: the rounded box's antialiased edge times the opacity share
 * glassRects.ts works out. The blend leaves the canvas's alpha as the
 * finishing pass wrote it (source factor zero, destination one): writing a
 * coverage into it would reach the page compositor. A pixel the rounded box
 * does not cover is discarded, so the canvas outside the panels is the
 * finishing pass's to the byte.
 *
 * Two panels that overlap are never drawn here: both go back to the browser
 * (app/glassRects.ts). Two that come within a texel of each other share the
 * margin of the targets, and the later one's copy wins it; both are blurs of
 * the same picture, so it does not show. Nothing is drawn and no target is
 * touched in a frame with no glass on screen, except the one warm-up frame:
 * its three programs of its own (the box, the blur, the composite) are
 * linked at boot under the loading screen, and the first frame drawn on a
 * glass route draws a panel that covers nothing through every pass
 * (`warm`), which makes the targets for the canvas's size — re-made only when
 * that size changes — so the first panel opened mid-session links nothing,
 * allocates nothing and builds no pipeline state. The half-size draw is the
 * finishing pass's own program, drawn into an 8-bit target in that frame.
 *
 * **What it costs.** M5 Max, Chromium on Metal, the ship view at 1.05 R at
 * High (3456 × 2234) with seven panels up: the frame rate went from 103–106
 * fps with the browser's blur to the display's 120, the same as with no blur
 * at all, and the compositor's 51-encoder side work per frame is gone. Its
 * own GPU time, read off a Metal trace: the half-size draw 0.011 ms, the box
 * 0.005, the two blur passes 0.016 and 0.026, and the composite too small to
 * separate from the canvas pass it rides in.
 *
 * Which frames carry the engine's glass, and the class that turns the
 * browser's blur off for them, is main's drawWorldFrame: the composer's
 * frames that end in the fused finishing pass. `?glass=0` on any build never
 * builds this at all, and the browser blurs as before.
 */
import * as THREE from 'three';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { createLdrTarget } from './UpscalePass';
import { OUTPUT_DITHER_GLSL, outputDitherUniform } from './outputDither';
import { GLASS_MAX_RECTS, type GlassRect } from './glassRects';

/** The `?glass=0` door, on any build: the renderer's glass never built, and
 *  every panel blurred by the browser as before. */
export function parseGlassParam(search: string): boolean {
  return new URLSearchParams(search).get('glass') !== '0';
}

/** The variance, in canvas pixels², of the blur the pipeline adds by itself
 *  where the scene is drawn at the canvas's size: the 4 × 4 box of the
 *  prefilter (16/12) and the bilinear stretch from a quarter-size texel back
 *  to the canvas (a tent four pixels each side, 16/6). A requested blur loses
 *  this much before it is drawn. With the scene drawn larger the prefilter
 *  is narrower and this slightly over-counts (see the header). */
export const GLASS_PIPELINE_VARIANCE = 16 / 12 + 16 / 6;
/** The most texel pairs one blur pass reads each side of its centre. 32
 *  pairs reach 3σ for σ up to 21 quarter texels — a 30px blur at the
 *  desktop's top ratio of 2.5 is 18.75. */
export const GLASS_MAX_PAIRS = 32;

/** The blur's standard deviation in quarter-size texels for a CSS blur of
 *  `sigma` canvas pixels, with the pipeline's own blur taken out; never
 *  below a quarter texel. */
export function glassQuarterSigma(sigma: number, canvasToQuarter: number): number {
  const s2 = Math.max(sigma * sigma - GLASS_PIPELINE_VARIANCE, 0);
  return Math.max(Math.sqrt(s2) * canvasToQuarter, 0.25);
}

/** The quarter-size target's size for a canvas of `w × h`, and the half-size
 *  one's, exactly twice it, so a quarter texel's centre is the shared corner
 *  of four half texels and one bilinear read is their average. */
export function glassTargetSizes(w: number, h: number): { quarter: [number, number]; half: [number, number] } {
  const qw = Math.max(1, Math.ceil(w / 4));
  const qh = Math.max(1, Math.ceil(h / 4));
  return { quarter: [qw, qh], half: [2 * qw, 2 * qh] };
}

/** The pair taps of a Gaussian of `sigma` texels truncated at 3σ, as the blur
 *  shader builds them: the centre's weight, then each pair's summed weight
 *  and its offset, all normalised. For the tests; the shader computes them
 *  in place. */
export function glassPairTaps(sigma: number): { centre: number; pairs: Array<{ weight: number; offset: number }> } {
  const radius = Math.ceil(3 * sigma);
  const n = Math.min(Math.ceil(radius / 2), GLASS_MAX_PAIRS);
  const g = (k: number): number => Math.exp((-0.5 * k * k) / (sigma * sigma));
  const pairs: Array<{ weight: number; offset: number }> = [];
  let total = 1;
  for (let p = 0; p < n; p++) {
    const k = 2 * p + 1;
    const wa = g(k);
    const wb = g(k + 1);
    const w = wa + wb;
    pairs.push({ weight: w, offset: (k * wa + (k + 1) * wb) / w });
    total += 2 * w;
  }
  return { centre: 1 / total, pairs: pairs.map((p) => ({ weight: p.weight / total, offset: p.offset })) };
}

/** The blur shader's mirrorInto, in texels: `p` reflected into [lo, hi] and
 *  held between the centres of the first and last texels centred inside. */
export function glassMirrorInto(p: number, lo: number, hi: number): number {
  const first = Math.ceil(lo - 0.5) + 0.5;
  const last = Math.floor(hi - 0.5) + 0.5;
  const len = hi - lo;
  if (len <= 0 || last < first) return 0.5 * (lo + hi);
  let t = (((p - lo) % (2 * len)) + 2 * len) % (2 * len);
  if (t > len) t = 2 * len - t;
  return Math.min(Math.max(lo + t, first), last);
}

/** The CSS `saturate()` matrix (Filter Effects §13.4), row-major. */
export function saturateMatrix(s: number): number[] {
  return [
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
  ];
}

// --- shaders ----------------------------------------------------------------

const N = GLASS_MAX_RECTS;

/** The quad of one panel, placed from its box: the box in canvas pixels,
 *  scaled to the target being drawn, rounded outward to whole texels and
 *  grown by a margin. Vertex position.xy is the quad's corner (0 or 1),
 *  position.z the panel's index. */
const QUAD_VERTEX = /* glsl */ `
precision highp float;
in vec3 position;
uniform vec4 uBounds[${N}];
uniform vec2 uCanvasSize;
uniform vec2 uTargetSize;
uniform float uMargin;
flat out int vRect;
void main() {
  int i = int(position.z + 0.5);
  vRect = i;
  vec4 b = uBounds[i];
  vec2 scale = uTargetSize / uCanvasSize;
  vec2 lo = clamp(floor(b.xy * scale) - uMargin, vec2(0.0), uTargetSize);
  vec2 hi = clamp(ceil(b.zw * scale) + uMargin, vec2(0.0), uTargetSize);
  gl_Position = vec4(mix(lo, hi, position.xy) / uTargetSize * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** Half size to quarter: one bilinear read at the shared corner of four
 *  half-size texels is their average. */
const BOX_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tSource;
uniform vec2 uTargetSize;
out vec4 fragColor;
void main() {
  fragColor = vec4(texture(tSource, gl_FragCoord.xy / uTargetSize).rgb, 1.0);
}
`;

/** One axis of the blur, at quarter size, inside the panel's box. */
const BLUR_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tSource;
uniform vec2 uTargetSize;
uniform vec2 uCanvasSize;
uniform vec4 uBounds[${N}];
uniform vec4 uParams[${N}];
// (1, 0) the horizontal pass, (0, 1) the vertical.
uniform vec2 uDirection;
flat in int vRect;
out vec4 fragColor;

// A coordinate in texels reflected into [lo, hi] (the browsers' mirrored
// edge), then held between the centres of the first and last texels whose
// centres lie inside the box, so a bilinear read never reaches a texel
// centred outside it, wherever in a texel the box's edges fall
// (glassMirrorInto is the same arithmetic, for the tests). A box too narrow
// to hold a texel centre, or of no width at all, reads its middle.
float mirrorInto(float p, float lo, float hi) {
  float first = ceil(lo - 0.5) + 0.5;
  float last = floor(hi - 0.5) + 0.5;
  float len = hi - lo;
  if (len <= 0.0 || last < first) return 0.5 * (lo + hi);
  float t = mod(p - lo, 2.0 * len);
  t = t > len ? 2.0 * len - t : t;
  return clamp(lo + t, first, last);
}

void main() {
  vec4 b = uBounds[vRect];
  vec2 scale = uTargetSize / uCanvasSize;
  vec2 lo = b.xy * scale;
  vec2 hi = b.zw * scale;
  // The texel's centre, with the cross axis reflected into the box: a margin
  // texel outside it holds the mirrored picture's value.
  vec2 p = gl_FragCoord.xy;
  vec2 q = vec2(mirrorInto(p.x, lo.x, hi.x), mirrorInto(p.y, lo.y, hi.y));
  vec2 base = uDirection.x > 0.5 ? vec2(p.x, q.y) : vec2(q.x, p.y);
  float along = dot(base, uDirection);
  float aLo = dot(lo, uDirection);
  float aHi = dot(hi, uDirection);
  vec2 cross = base * (vec2(1.0) - uDirection);
  float sigma = uParams[vRect].x;
  float inv = -0.5 / (sigma * sigma);
  int pairs = min(int(ceil(ceil(3.0 * sigma) * 0.5)), ${GLASS_MAX_PAIRS});
  vec3 sum = texture(tSource, (cross + uDirection * mirrorInto(along, aLo, aHi)) / uTargetSize).rgb;
  float total = 1.0;
  for (int i = 0; i < ${GLASS_MAX_PAIRS}; i++) {
    if (i >= pairs) break;
    float k = float(2 * i + 1);
    float wa = exp(k * k * inv);
    float wb = exp((k + 1.0) * (k + 1.0) * inv);
    float w = wa + wb;
    float off = (k * wa + (k + 1.0) * wb) / w;
    vec2 plus = cross + uDirection * mirrorInto(along + off, aLo, aHi);
    vec2 minus = cross + uDirection * mirrorInto(along - off, aLo, aHi);
    sum += (texture(tSource, plus / uTargetSize).rgb + texture(tSource, minus / uTargetSize).rgb) * w;
    total += 2.0 * w;
  }
  fragColor = vec4(sum / total, 1.0);
}
`;

/** The blurred copy over the canvas, inside each panel's rounded box. */
const COMPOSITE_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tBlur;
uniform vec2 uCanvasSize;
uniform vec4 uBounds[${N}];
uniform vec4 uRadii[${N}];
uniform vec4 uParams[${N}];
flat in int vRect;
out vec4 fragColor;
${OUTPUT_DITHER_GLSL}

void main() {
  vec4 b = uBounds[vRect];
  // A side clipped by the canvas's edge is not an edge of the panel: push it
  // out of reach, so it is neither antialiased nor rounded.
  vec2 lo = vec2(b.x <= 0.0 ? -1e5 : b.x, b.y <= 0.0 ? -1e5 : b.y);
  vec2 hi = vec2(b.z >= uCanvasSize.x ? 1e5 : b.z, b.w >= uCanvasSize.y ? 1e5 : b.w);
  vec2 p = gl_FragCoord.xy;
  vec2 d = p - 0.5 * (lo + hi);
  vec2 h = 0.5 * (hi - lo);
  // Radii in GL order: bottom-left, bottom-right, top-right, top-left.
  vec4 r4 = uRadii[vRect];
  float r = d.x < 0.0 ? (d.y < 0.0 ? r4.x : r4.w) : (d.y < 0.0 ? r4.y : r4.z);
  vec2 e = abs(d) - h + r;
  float dist = length(max(e, 0.0)) + min(max(e.x, e.y), 0.0) - r;
  float cover = clamp(0.5 - dist, 0.0, 1.0) * uParams[vRect].z;
  if (cover <= 0.0) discard;
  vec3 c = texture(tBlur, p / uCanvasSize).rgb;
  float s = uParams[vRect].y;
  if (s != 1.0) {
    mat3 m = mat3(
      0.213 + 0.787 * s, 0.213 - 0.213 * s, 0.213 - 0.213 * s,
      0.715 - 0.715 * s, 0.715 + 0.285 * s, 0.715 - 0.715 * s,
      0.072 - 0.072 * s, 0.072 - 0.072 * s, 0.072 + 0.928 * s);
    c = clamp(m * c, 0.0, 1.0);
  }
  fragColor = vec4(c + outputDither(p), cover);
}
`;

function glassMaterial(fragmentShader: string, uniforms: Record<string, THREE.IUniform>, blending: THREE.Blending = THREE.NoBlending): THREE.RawShaderMaterial {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: QUAD_VERTEX,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
    blending,
  });
}

/** Sixteen quads, one per panel slot: corners in position.xy, the slot in z. */
function panelQuads(): THREE.BufferGeometry {
  const positions = new Float32Array(N * 4 * 3);
  const index: number[] = [];
  for (let i = 0; i < N; i++) {
    const corners = [[0, 0], [1, 0], [0, 1], [1, 1]];
    corners.forEach(([x, y], k) => positions.set([x, y, i], (i * 4 + k) * 3));
    const v = i * 4;
    index.push(v, v + 1, v + 2, v + 2, v + 1, v + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(index);
  return geometry;
}

/** The warm-up's panel: one canvas pixel in the corner, covering nothing
 *  (coverage 0, so the composite discards it), saturating so the saturate
 *  branch runs too. */
const WARM_RECT: GlassRect = { x0: 0, y0: 0, x1: 1, y1: 1, radii: [0, 0, 0, 0], sigma: 2, saturation: 1.6, coverage: 0 };

/** The finishing pass as the source draw needs it: three's OutputPass
 *  material (a RawShaderMaterial, so its program does not depend on the
 *  target it draws). */
export interface GlassFinishing {
  material: THREE.ShaderMaterial | THREE.RawShaderMaterial;
}

/**
 * Whether three's OutputPass has built its defines for the renderer's
 * current tone curve and output colour space. It builds them in its own
 * render, from two fields it keeps for the purpose; before its first render
 * on a new composer, or on the first frame after a mode changed the tone
 * curve, its program is not yet the one the canvas write will use, and a draw
 * of it would link another. Tracks the installed three's OutputPass.render.
 */
export function finishingDefinesReady(finishing: GlassFinishing, renderer: THREE.WebGLRenderer): boolean {
  const p = finishing as unknown as { _outputColorSpace?: string | null; _toneMapping?: number | null };
  return p._outputColorSpace === renderer.outputColorSpace && p._toneMapping === renderer.toneMapping;
}

/** One frame's statistics, for `__moon.glass()`. */
export interface GlassFrameStats {
  rects: number;
  drew: boolean;
  /** Why a frame with glass on screen drew none, if it did not. */
  skipped: string | null;
}

/**
 * The session's one glass: its targets, its four programs, the frame's
 * panels. main makes it once (unless `?glass=0`) and a GlassSourcePass for
 * every composer it builds.
 */
export class GlassBackdrop {
  private half: THREE.WebGLRenderTarget | null = null;
  private quarter: THREE.WebGLRenderTarget | null = null;
  private scratch: THREE.WebGLRenderTarget | null = null;
  private readonly quads = panelQuads();
  private readonly mesh: THREE.Mesh;
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly bounds = Array.from({ length: N }, () => new THREE.Vector4());
  private readonly radii = Array.from({ length: N }, () => new THREE.Vector4());
  private readonly params = Array.from({ length: N }, () => new THREE.Vector4());
  private readonly canvasSize = new THREE.Vector2(1, 1);
  private readonly targetSize = new THREE.Vector2(1, 1);
  private readonly bufferSize = new THREE.Vector2();
  private readonly boxMaterial: THREE.RawShaderMaterial;
  private readonly blurMaterial: THREE.RawShaderMaterial;
  private readonly compositeMaterial: THREE.RawShaderMaterial;
  /** The half-size draw of the finishing material: one quad per panel in
   *  clip space with the uv the material reads, rebuilt per frame. */
  private readonly finishQuads = new THREE.BufferGeometry();
  private readonly finishPositions = new Float32Array(N * 4 * 3);
  private readonly finishUvs = new Float32Array(N * 4 * 2);
  private readonly finishMesh: THREE.Mesh;

  /** This frame's panels; empty outside a frame that carries the glass. */
  private frameRects: GlassRect[] = [];
  /** Whether the source pass drew this frame's blurred copy. */
  private sourceDrawn = false;
  /** Set when a frame with panels drew none, and why. */
  private skipReason: string | null = null;
  /** Draw calls the glass made in the frame being drawn. */
  draws = 0;
  /** The panels this frame carries, the warm-up's not counted. */
  private realRects = 0;
  /** Set by warm(): the next frame draws the warm-up's panel through every
   *  pass. Cleared once it has. */
  private warmPending = false;
  private lastStats: GlassFrameStats = { rects: 0, drew: false, skipped: null };

  constructor() {
    const shared = {
      uBounds: { value: this.bounds },
      uCanvasSize: { value: this.canvasSize },
      uTargetSize: { value: this.targetSize },
      uMargin: { value: 0 },
    };
    this.boxMaterial = glassMaterial(BOX_FRAGMENT, { ...shared, tSource: { value: null } });
    this.blurMaterial = glassMaterial(BLUR_FRAGMENT, {
      ...shared,
      tSource: { value: null },
      uParams: { value: this.params },
      uDirection: { value: new THREE.Vector2(1, 0) },
    });
    this.compositeMaterial = glassMaterial(COMPOSITE_FRAGMENT, {
      ...shared,
      tBlur: { value: null },
      uRadii: { value: this.radii },
      uParams: { value: this.params },
      uDither: outputDitherUniform,
    }, THREE.CustomBlending);
    const m = this.compositeMaterial;
    m.blendEquation = THREE.AddEquation;
    m.blendSrc = THREE.SrcAlphaFactor;
    m.blendDst = THREE.OneMinusSrcAlphaFactor;
    // The canvas's alpha stays what the finishing pass wrote.
    m.blendEquationAlpha = THREE.AddEquation;
    m.blendSrcAlpha = THREE.ZeroFactor;
    m.blendDstAlpha = THREE.OneFactor;
    this.mesh = new THREE.Mesh(this.quads, this.boxMaterial);
    this.mesh.frustumCulled = false;
    this.finishQuads.setAttribute('position', new THREE.BufferAttribute(this.finishPositions, 3).setUsage(THREE.DynamicDrawUsage));
    this.finishQuads.setAttribute('uv', new THREE.BufferAttribute(this.finishUvs, 2).setUsage(THREE.DynamicDrawUsage));
    const index: number[] = [];
    for (let i = 0; i < N; i++) {
      const v = i * 4;
      index.push(v, v + 1, v + 2, v + 2, v + 1, v + 3);
    }
    this.finishQuads.setIndex(index);
    this.finishMesh = new THREE.Mesh(this.finishQuads);
    this.finishMesh.frustumCulled = false;
  }

  /**
   * Ready everything now — at boot, under the loading screen — so the first
   * panel shown mid-session pays for nothing: the three programs linked here,
   * and the next frame drawn on a glass route drawn with a panel that covers
   * nothing, which makes the three targets at the canvas's size and binds
   * them (three gives a target its GL storage on the first bind) and has the
   * driver build every pass's pipeline state, the half-size finishing draw
   * and the composite included, before anyone sees a frame. A route that
   * never carries the glass (`?fused=0`, the direct route) never reaches that
   * frame and allocates nothing.
   */
  warm(renderer: THREE.WebGLRenderer): void {
    const scene = new THREE.Scene();
    for (const material of [this.boxMaterial, this.blurMaterial, this.compositeMaterial]) {
      const mesh = new THREE.Mesh(this.quads, material);
      mesh.frustumCulled = false;
      scene.add(mesh);
    }
    renderer.compile(scene, this.camera);
    this.warmPending = true;
  }

  /** One of the three targets, for the render-target readout; null before
   *  they are made. */
  targetOf(name: 'half' | 'quarter' | 'scratch'): THREE.WebGLRenderTarget | null {
    return name === 'half' ? this.half : name === 'quarter' ? this.quarter : this.scratch;
  }

  /** This frame's panels, before the frame draws; endFrame after it, so a
   *  draw outside a frame (the boot's warm-up) carries no glass. */
  setFrame(rects: GlassRect[]): void {
    this.realRects = rects.length;
    // The warm-up's panel rides the first frame that has none of its own.
    this.frameRects = rects.length === 0 && this.warmPending ? [WARM_RECT] : rects;
    this.sourceDrawn = false;
    this.skipReason = null;
    this.draws = 0;
  }

  /** The frame is drawn: keep its statistics and carry no glass until the
   *  next setFrame. */
  endFrame(): void {
    // A frame with no panel of its own (the warm-up's) reports no draw and no
    // skip: there was nothing of the reader's to draw.
    this.lastStats = this.realRects > 0
      ? { rects: this.realRects, drew: this.sourceDrawn, skipped: this.skipReason }
      : { rects: 0, drew: false, skipped: null };
    this.frameRects = [];
    this.realRects = 0;
    this.sourceDrawn = false;
  }

  /** Whether this frame's glass is drawn, or there was none to draw. */
  get frameComplete(): boolean {
    return this.realRects === 0 || this.sourceDrawn;
  }

  /** The last drawn frame's statistics. */
  stats(): GlassFrameStats {
    return { ...this.lastStats };
  }

  /** The targets' sizes, for the readout; null before the first glass frame. */
  targets(): { half: [number, number]; quarter: [number, number] } | null {
    return this.half && this.quarter
      ? { half: [this.half.width, this.half.height], quarter: [this.quarter.width, this.quarter.height] }
      : null;
  }

  /** The frame's per-panel uniforms, one slot per panel this frame draws. */
  private loadRects(canvasToQuarter: number): void {
    const rects = this.frameRects;
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      this.bounds[i].set(r.x0, r.y0, r.x1, r.y1);
      this.radii[i].set(r.radii[0], r.radii[1], r.radii[2], r.radii[3]);
      this.params[i].set(glassQuarterSigma(r.sigma, canvasToQuarter), r.saturation, r.coverage, 0);
    }
  }

  private ensureTargets(w: number, h: number): void {
    const { quarter, half } = glassTargetSizes(w, h);
    const fit = (t: THREE.WebGLRenderTarget | null, [tw, th]: [number, number]): THREE.WebGLRenderTarget => {
      const target = t ?? createLdrTarget();
      if (target.width !== tw || target.height !== th) target.setSize(tw, th);
      return target;
    };
    this.half = fit(this.half, half);
    this.quarter = fit(this.quarter, quarter);
    this.scratch = fit(this.scratch, quarter);
  }

  /** Draw the mesh's quads for this frame's panels into `target`. */
  private drawQuads(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null, material: THREE.RawShaderMaterial, margin: number): void {
    const count = this.frameRects.length;
    if (target) this.targetSize.set(target.width, target.height);
    else this.targetSize.copy(this.canvasSize);
    material.uniforms.uMargin.value = margin;
    material.uniformsNeedUpdate = true;
    this.mesh.material = material;
    this.quads.setDrawRange(0, count * 6);
    renderer.setRenderTarget(target);
    // An offscreen target is cleared first: nothing in it outside this
    // frame's panels is ever read, and a clear that opens the pass is a
    // tile GPU's cue not to load the old contents from memory at all.
    if (target) renderer.clear(true, false, false);
    renderer.render(this.mesh, this.camera);
    this.draws++;
  }

  /**
   * The source and both blur passes, before the finishing pass: the finishing
   * material at half size over each panel's box, the 2:1 box, the horizontal
   * pass into the scratch target and the vertical one back into the quarter
   * target. `readBuffer` is the scene the finishing pass is about to read.
   */
  drawSource(renderer: THREE.WebGLRenderer, readBuffer: THREE.WebGLRenderTarget, finishing: GlassFinishing | null): void {
    const count = this.frameRects.length;
    if (count === 0) return;
    if (!finishing) {
      this.skipReason = 'no finishing pass';
      return;
    }
    const material = finishing.material;
    // Its defines not yet built for this tone curve: that frame keeps the
    // browser's blur (main reads frameComplete).
    if (!finishingDefinesReady(finishing, renderer)) {
      this.skipReason = 'finishing pass not drawn yet';
      return;
    }
    renderer.getDrawingBufferSize(this.bufferSize);
    const w = Math.max(1, Math.floor(this.bufferSize.x));
    const h = Math.max(1, Math.floor(this.bufferSize.y));
    this.canvasSize.set(w, h);
    this.ensureTargets(w, h);
    const half = this.half!;
    const quarter = this.quarter!;
    const scratch = this.scratch!;
    this.loadRects(quarter.width / w);

    const oldAutoClear = renderer.autoClear;
    const u = material.uniforms;
    const oldDither = u.uDither?.value;
    const oldBox = u.uBox?.value;
    renderer.autoClear = false;
    try {
      // 1. The finishing material at half size, over each panel's box and a
      //    margin of three half texels (what the 2:1 box and its own margin
      //    read). Its uniforms are the ones the canvas write will use; its
      //    dither and its supersample's box are held off for this draw.
      if (u.uDither) u.uDither.value = 0;
      if (u.uBox) u.uBox.value = 0;
      u.tDiffuse.value = readBuffer.texture;
      if (u.toneMappingExposure) u.toneMappingExposure.value = renderer.toneMappingExposure;
      this.buildFinishQuads(half.width, half.height, 3);
      material.uniformsNeedUpdate = true;
      this.finishMesh.material = material;
      this.finishQuads.setDrawRange(0, count * 6);
      renderer.setRenderTarget(half);
      renderer.clear(true, false, false);
      renderer.render(this.finishMesh, this.camera);
      this.draws++;

      // 2. Half to quarter, a texel of margin beyond the box.
      this.boxMaterial.uniforms.tSource.value = half.texture;
      this.drawQuads(renderer, quarter, this.boxMaterial, 1);
      // 3–4. The blur, horizontal into the scratch target, vertical back.
      const blur = this.blurMaterial.uniforms;
      blur.tSource.value = quarter.texture;
      (blur.uDirection.value as THREE.Vector2).set(1, 0);
      this.drawQuads(renderer, scratch, this.blurMaterial, 1);
      blur.tSource.value = scratch.texture;
      (blur.uDirection.value as THREE.Vector2).set(0, 1);
      this.drawQuads(renderer, quarter, this.blurMaterial, 1);
      this.sourceDrawn = true;
    } finally {
      if (u.uDither) u.uDither.value = oldDither;
      if (u.uBox) u.uBox.value = oldBox;
      this.blurMaterial.uniforms.tSource.value = null;
      this.boxMaterial.uniforms.tSource.value = null;
      renderer.autoClear = oldAutoClear;
    }
  }

  /** The finishing draw's quads: each panel's box at half size, rounded
   *  outward and grown by `margin` texels, in clip space and uv. */
  private buildFinishQuads(tw: number, th: number, margin: number): void {
    const w = this.canvasSize.x;
    const h = this.canvasSize.y;
    const rects = this.frameRects;
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      const x0 = Math.max(0, Math.floor((r.x0 / w) * tw) - margin) / tw;
      const x1 = Math.min(tw, Math.ceil((r.x1 / w) * tw) + margin) / tw;
      const y0 = Math.max(0, Math.floor((r.y0 / h) * th) - margin) / th;
      const y1 = Math.min(th, Math.ceil((r.y1 / h) * th) + margin) / th;
      const corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]];
      for (let k = 0; k < 4; k++) {
        const [u, v] = corners[k];
        this.finishPositions.set([u * 2 - 1, v * 2 - 1, 0], (i * 4 + k) * 3);
        this.finishUvs.set([u, v], (i * 4 + k) * 2);
      }
    }
    (this.finishQuads.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.finishQuads.attributes.uv as THREE.BufferAttribute).needsUpdate = true;
  }

  /** The blurred copy over the canvas, right after the canvas write: one
   *  quad per panel, blended by its coverage. */
  composite(renderer: THREE.WebGLRenderer): void {
    if (!this.sourceDrawn || this.frameRects.length === 0) return;
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    try {
      this.compositeMaterial.uniforms.tBlur.value = this.quarter!.texture;
      this.drawQuads(renderer, null, this.compositeMaterial, 0);
      this.warmPending = false;
    } finally {
      this.compositeMaterial.uniforms.tBlur.value = null;
      renderer.autoClear = oldAutoClear;
    }
  }

  /** The source pass for one composer, placed after its bloom chain and
   *  before its finishing pass. */
  sourcePass(finishing: () => GlassFinishing | null): GlassSourcePass {
    return new GlassSourcePass(this, finishing);
  }

  dispose(): void {
    this.half?.dispose();
    this.quarter?.dispose();
    this.scratch?.dispose();
    this.half = this.quarter = this.scratch = null;
    this.quads.dispose();
    this.finishQuads.dispose();
    this.boxMaterial.dispose();
    this.blurMaterial.dispose();
    this.compositeMaterial.dispose();
  }
}

/**
 * The glass's source draw as a composer pass: it writes only the glass's own
 * targets and never swaps the composer's buffers, so every pass after it
 * reads what it would have read. Disposing it frees nothing — the targets and
 * programs are the session's, and a composer rebuilt for another camera
 * builds a new one of these over the same glass.
 */
export class GlassSourcePass extends Pass {
  constructor(private readonly glass: GlassBackdrop, private readonly finishing: () => GlassFinishing | null) {
    super();
    this.needsSwap = false;
  }

  render(renderer: THREE.WebGLRenderer, _writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    this.glass.drawSource(renderer, readBuffer, this.finishing());
  }
}
