/**
 * The finishing pass: the lens warp, the glow and the tone map in one draw.
 *
 * This is the chain that ships. The frame used to end with three
 * full-resolution trips over a half-float surface between the scene and the
 * tone curve — the lens pass writing its warped image, the bloom blend reading
 * that surface back to add the glow into it, and the output pass reading the
 * result to tone-map it — and on a tile-based GPU each of those is a render
 * pass of its own: the attachment is loaded into tile memory, touched once and
 * stored back. Now the bright pass reads the scene image THROUGH the warp, and
 * one finishing pass does `tonemap( scene(warp(uv)) + composite(uv) )`. Gone
 * from every frame: one full-resolution write and read, and one full-resolution
 * read-modify-write. On the composers without a lens (Volume Compare, Look
 * inside, the dormant flight mode) the blend used to draw into the
 * multisampled scene target itself, so a second full resolve of it goes too.
 *
 * What is added: the warp's Newton solve also runs in the bright pass, at half
 * the bloom size — a quarter of the pixels — so about 1.25× the warp
 * arithmetic of the old chain for one fewer full-resolution surface.
 *
 * **Why the bloom stays in output space.** The bright pass warps its read
 * rather than the composite being looked up through the warp at the end. The
 * other way round changes three things at once: the halo becomes anisotropic
 * where the lens stretches, a bright source outside the displayed frame but
 * inside the overscan starts blooming into it, and the halo's width follows the
 * local magnification. Warping the bright pass's read keeps all three as they
 * were — every mip is the picture the chain blurs today, and the composite is
 * added at `vUv` exactly as the blend added it.
 *
 * **What cannot be byte-identical.** Four differences, all small, none of them
 * hidden:
 *  1. `lens + bloom` is no longer rounded to fp16 before the tone curve, so the
 *     8-bit output can flip by a least significant bit, sparsely. This one
 *     reaches every composer, the lens-less ones included.
 *  2. The bright pass's input. It used to take a bilinear sample, at the bloom
 *     chain's own texel centres, of the full-size warped image — itself a
 *     bilinear sample of the scene. Now it takes one bilinear sample of the
 *     scene at the warped position, and a bilinear of a bilinear has the wider
 *     footprint, so the bright target is a hair sharper before five octaves of
 *     blur. Differences show, if anywhere, at bright edges: the Sun's limb, the
 *     glint's peak, a plume.
 *  3. The frame boundary. The old bright pass read the lens OUTPUT, which holds
 *     displayed pixels only, clamped half a texel inside the sub-rect. A
 *     bilinear tap on the SCENE at the warped position can reach half a scene
 *     texel past the displayed corner into the overscan, so a bright source
 *     just outside the frame can contribute at the very corner.
 *  4. At strength 0 there is no warp at all and only (1) applies.
 *
 * The output dither (app/outputDither.ts) is not among them: both chains add
 * the same grain after the same transfer, on whichever write lands on the
 * canvas, and `?dither=0` takes it out of both exactly.
 *
 * `?fused=0` on any build puts the old three-pass chain back — the kill switch,
 * and the A/B for anything the four differences might have moved. In DEV
 * `?perfoff=fused-final` does the same through the switch registry.
 *
 * **A scene drawn larger than the canvas is averaged down here too.** High,
 * and Dynamic's rungs above the output ratio, draw the scene larger than the
 * canvas (1.5× and 1.25× its ratio). That frame used to be finished at SCENE
 * size into an 8-bit target of its own — 17 Mpx at ratio 3 on a 16" Mac — and
 * then box-averaged onto the canvas by app/UpscalePass.ts DownsamplePass: a
 * scene-sized 8-bit write and read, a second full-screen pass, and the warp's
 * Newton solve and the tone curve run once per scene pixel. With the box
 * carried here the pass draws the canvas at output size and averages the
 * scene's texels itself. Per output pixel: the warp is solved once, at the
 * pixel's centre, and differentiated (shared/math/lensProjection.ts
 * lensSourceFootprintGlsl), before the sub-rectangle clamp so the footprint is
 * not flattened at the edge; the taps of the downsample's own footprint are
 * placed along that derivative from the centre, each clamped into the
 * sub-rectangle; each tap is finished exactly as a scene-sized pixel was —
 * scene plus glow, the tone curve, the display transfer — and the encoded
 * colours are summed with the downsample's own weights
 * (app/UpscalePass.ts downsampleAxisWeights, `uFilter` box or tent); then the
 * frame's one dither and its opaque alpha go on after the sum, once. The glow
 * is read once, at the pixel's centre.
 *
 * The taps, per axis, follow the downsample's window: three from one below the
 * footprint's centre, the texels the old pass read. Where every footprint
 * covers exactly two texels and the shader's float arithmetic is exact — a
 * ratio of 1 + 1/2^k, which is 1.5 (High) and 1.25 (Dynamic's 2.5 on an even
 * window) — they are the two from the footprint's first texel instead: four
 * finishes a pixel and no tap of weight zero. The count is a uniform worked out
 * from the drawn sizes (`fusedBoxTaps`), so the loop is the same for every
 * pixel of a frame.
 *
 * What it saves was measured on an M5 Max (Chromium on Metal, a 1728×1117
 * window at 2×), one page, the switch flipped back and forth: at High the
 * finishing pass and the downsample took 1.8 ms between them and the box takes
 * 1.0 ms, and the whole frame's GPU time fell by about 0.5 ms. At Dynamic's
 * 2.5 on that window the drawn height is 2792 rows for a canvas of 2234, not
 * 1.25 of it, so the box reads three taps down that axis — six finishes a
 * pixel — and the frame came out within the measurement's noise of the old
 * one.
 *
 * One program: the text carries the box behind `uBox`, a branch on a uniform
 * like `uFilter`, so a step between ratio 2 and 2.5 changes a uniform and
 * relinks nothing, and the switch flips live. At ratio 2 and below `uBox` is 0
 * and the program runs the single-read text it always ran, unchanged.
 *
 * Not byte-identical to the downsample, and three things say why:
 *  1. The warp is solved at output resolution and extended linearly to the
 *     taps, where the old pass solved it at every scene pixel. The two differ
 *     by the warp's curvature over a pixel: a ten-thousandth of a texel.
 *  2. The taps are averaged in float, where the old pass rounded each finished
 *     pixel to 8 bits before the average, so an output pixel can land one
 *     least significant bit the other way.
 *  3. The glow is one sample per output pixel, not one per scene pixel: the
 *     same blurred image read at the footprint's centre instead of over it.
 * At lens strength 0 every tap lands on its scene texel's centre, the texel
 * the old pass's pixel read.
 *
 * `?fuseddown=0` on any build is that old path — the text carries no box, the
 * finishing pass draws its own target at scene size and the downsample pass
 * averages it — and `?fused=0` keeps it too, having no finishing pass to fold
 * into. In DEV the switch registry's `fused-downsample` flips the same choice
 * live, a uniform and a pass's enabled flag, so the A/B comes out of one page.
 * Only the planetarium's composer carries the box: it is the only one whose
 * scene can be drawn larger than its canvas.
 *
 * **Eight shader texts, one per variant.** `{ lens, glow, box }` × {true,
 * false}: the planetarium's composer wants the warp and the box and the other
 * three want neither, and bloom can be off on any of them. There is one
 * composer in the app, rebuilt per camera, so a single memoised text would
 * hand whichever mode was entered first its own text to every later mode. Nothing would break out loud: three uploads
 * only the uniforms a material carries, so a warped text on a material with no
 * warp uniforms reads a strength of zero and draws the plain read — Look inside
 * would pay the Newton solve's branch for nothing, and a text with no glow line
 * handed to a composer with a bloom chain would draw no glow at all, silently.
 * A text per variant, and a wiring check that knows which edits each variant is
 * made of, is what makes either mistake a failing test rather than a picture
 * somebody has to notice. The texts are assembled on first use rather than
 * at module load: a module-level string edit is work a bundler keeps (built
 * eagerly, the replacements survived tree-shaking and shipped).
 */
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputShader } from 'three/addons/shaders/OutputShader.js';
import {
  OUTPUT_DITHER_ADD, OUTPUT_OPAQUE_WRITE, ditherOutputText, outputDitherIsWired, outputWriteIsOpaque,
} from './outputDither';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { OutputTargetPass, drawnSize, type DownsampleFilter } from './UpscalePass';
import { bloomHighPassMaterial } from './bloomTargets';
import { installLensUniforms, type LensUniforms } from './LensPass';
import {
  HIGH_PASS_UV_ANCHOR, OUTPUT_UV_ANCHOR, installSubRectUniforms, patchSceneRead, scaleSceneRead,
  type SubRectUniforms,
} from './sceneSubRect';
import { lensSourceFootprintGlsl } from '../shared/math/lensProjection';

/** The blur axes the pass carries as statics, which its published types do
 *  not name. */
const BLUR = UnrealBloomPass as unknown as {
  BlurDirectionX: THREE.Vector2;
  BlurDirectionY: THREE.Vector2;
};

/** The private surface of UnrealBloomPass this file drives. */
interface BloomInternals {
  renderTargetBright: THREE.WebGLRenderTarget;
  renderTargetsHorizontal: THREE.WebGLRenderTarget[];
  renderTargetsVertical: THREE.WebGLRenderTarget[];
  highPassUniforms: Record<string, THREE.IUniform>;
  materialHighPassFilter: THREE.Material;
  separableBlurMaterials: Array<THREE.Material & { uniforms: Record<string, THREE.IUniform> }>;
  compositeMaterial: THREE.Material & { uniforms: Record<string, THREE.IUniform> };
  nMips: number;
  bloomTintColors: THREE.Vector3[];
  _oldClearColor: THREE.Color;
  _fsQuad: FullScreenQuad;
  clearColor: THREE.Color;
}

/**
 * UnrealBloomPass, stopped after its composite.
 *
 * Everything up to that point is three's own sequence, restated here because
 * the class offers no seam between the composite and the blend that follows
 * it. It is deliberately a transcription and not an improvement: it must stay
 * the chain the shipped pass runs, or what is being measured is two changes at
 * once. It tracks the installed three version's own render().
 */
export class BloomChainPass extends UnrealBloomPass {
  /** The half-resolution glow the finishing pass adds. */
  get compositeTexture(): THREE.Texture {
    return (this as unknown as BloomInternals).renderTargetsHorizontal[0].texture;
  }

  /**
   * Take the bright pass's read of the scene image through the lens warp, on
   * the shared uniform objects, and hand back the sub-rect pair its own writer
   * drives. Called once per build, before the pass's first render.
   */
  installLensWarp(lens: LensUniforms): SubRectUniforms {
    const material = bloomHighPassMaterial(this);
    const subRect = patchSceneRead(material, HIGH_PASS_UV_ANCHOR, true);
    installLensUniforms(material.uniforms as Record<string, THREE.IUniform>, lens);
    return subRect;
  }

  render(
    renderer: THREE.WebGLRenderer,
    _writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    const p = this as unknown as BloomInternals;
    renderer.getClearColor(p._oldClearColor);
    const oldClearAlpha = renderer.getClearAlpha();
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setClearColor(p.clearColor, 0);

    // 1. the bright areas
    p.highPassUniforms.tDiffuse.value = readBuffer.texture;
    p.highPassUniforms.luminosityThreshold.value = this.threshold;
    p._fsQuad.material = p.materialHighPassFilter;
    renderer.setRenderTarget(p.renderTargetBright);
    renderer.clear();
    p._fsQuad.render(renderer);

    // 2. the mip chain, blurred separably
    let input = p.renderTargetBright;
    for (let i = 0; i < p.nMips; i++) {
      p._fsQuad.material = p.separableBlurMaterials[i];
      p.separableBlurMaterials[i].uniforms.colorTexture.value = input.texture;
      p.separableBlurMaterials[i].uniforms.direction.value = BLUR.BlurDirectionX;
      renderer.setRenderTarget(p.renderTargetsHorizontal[i]);
      renderer.clear();
      p._fsQuad.render(renderer);

      p.separableBlurMaterials[i].uniforms.colorTexture.value = p.renderTargetsHorizontal[i].texture;
      p.separableBlurMaterials[i].uniforms.direction.value = BLUR.BlurDirectionY;
      renderer.setRenderTarget(p.renderTargetsVertical[i]);
      renderer.clear();
      p._fsQuad.render(renderer);

      input = p.renderTargetsVertical[i];
    }

    // 3. the composite, at half resolution — and then stop. The additive
    //    full-screen draw that used to follow is the finishing pass's first line.
    p._fsQuad.material = p.compositeMaterial;
    p.compositeMaterial.uniforms.bloomStrength.value = this.strength;
    p.compositeMaterial.uniforms.bloomRadius.value = this.radius;
    p.compositeMaterial.uniforms.bloomTintColors.value = p.bloomTintColors;
    renderer.setRenderTarget(p.renderTargetsHorizontal[0]);
    renderer.clear();
    p._fsQuad.render(renderer);

    renderer.setClearColor(p._oldClearColor, oldClearAlpha);
    renderer.autoClear = oldAutoClear;
  }
}

/** Which of the finishing pass's optional parts a text carries: the lens warp
 *  on its read of the scene, the glow added before the tone curve, and the
 *  supersample's box average behind `uBox`. */
export interface FusedVariant {
  lens: boolean;
  glow: boolean;
  /** Left out, no box: the composers whose scene is never larger than their
   *  canvas. */
  box?: boolean;
}

/** The glow line, and the sampler it reads: the same add (ONE, ONE) the bloom
 *  blend material performed, in the same place in the pipeline, one surface
 *  earlier. */
const GLOW_DECLARATION = 'uniform sampler2D tDiffuse;\n\t\tuniform sampler2D tBloom;';
const GLOW_LINE = `${OUTPUT_UV_ANCHOR}\n\t\t\tgl_FragColor.rgb += texture2D( tBloom, vUv ).rgb;`;

const fusedTexts = new Map<string, string>();

/** One variant's fragment text, assembled on first use and kept. */
export function fusedFragmentText(variant: FusedVariant): string {
  const key = `${variant.lens ? 'warp' : 'flat'}:${variant.glow ? 'glow' : 'plain'}:${variant.box ? 'box' : 'one'}`;
  let text = fusedTexts.get(key);
  if (text === undefined) {
    const withGlow = variant.glow
      ? OutputShader.fragmentShader
        .replace('uniform sampler2D tDiffuse;', GLOW_DECLARATION)
        .replace(OUTPUT_UV_ANCHOR, GLOW_LINE)
      : OutputShader.fragmentShader;
    // The dither goes in last, after the transfer, on every variant: the
    // write this text makes is an 8-bit one (app/outputDither.ts).
    text = ditherOutputText(scaleSceneRead(withGlow, OUTPUT_UV_ANCHOR, variant.lens));
    if (variant.box) text = withBox(text, variant);
    fusedTexts.set(key, text);
  }
  return text;
}

// --- the supersample's box -------------------------------------------------

/** Where three's main begins: the box goes in before it, and its body is
 *  wrapped in the branch on `uBox`. */
const MAIN_OPEN = 'void main() {';
/** The first line of three's finishing, and the transfer it ends with. */
const TONE_MAP_OPEN = '// tone mapping';
const TRANSFER_LINE = 'gl_FragColor = sRGBTransferOETF( gl_FragColor );';
/** The box's one read of the scene: a tap placed along the warp's derivative
 *  from the pixel's centre, clamped into the sub-rectangle. */
const BOX_TAP_READ = 'vec4 tap = texture2D( tDiffuse, clamp( s + dUdx * oi + dUdy * oj, vec2( 0.0 ), uUvMax ) );';
const BOX_GLOW_READ = 'vec3 glow = texture2D( tBloom, vUv ).rgb;';
const BOX_GLOW_ADD = 'tap.rgb += glow;';
const BOX_TRANSFER = 'tap = sRGBTransferOETF( tap );';
const BOX_SUM = 'sum += tap.rgb * ( wi * wj );';
const BOX_JACOBIAN_WARP = 'vec2 s = lensSourceFootprint( vUv, uOutputSize, dUdx, dUdy );';
const BOX_JACOBIAN_FLAT = 'vec2 s = vUv * uUvScale;';
const BOX_BRANCH_OPEN = 'if ( uBox > 0.5 ) {';
const BOX_BRANCH_ELSE = '} else {';
const BOX_WRITE = 'gl_FragColor = vec4( fusedBoxAverage(), 1.0 );';

/**
 * Three's finishing lines — the tone curve's branches and the display
 * transfer, everything after the read — taken out of its own text and pointed
 * at one tap. Taken rather than restated, so a three release that changes a
 * curve changes it in both branches; a throw if the text no longer has the
 * shape this cuts on.
 */
function finishingLinesForTap(): string {
  const src = OutputShader.fragmentShader;
  const open = src.indexOf(TONE_MAP_OPEN);
  const transfer = src.indexOf(TRANSFER_LINE);
  const close = transfer < 0 ? -1 : src.indexOf('#endif', transfer);
  if (open < 0 || transfer < open || close < 0) {
    throw new Error('fusedFragmentText: the installed three no longer carries the output shader lines the box finishes each tap with');
  }
  return src.slice(open, close + '#endif'.length).replace(/gl_FragColor/g, 'tap');
}

/** The box's uniforms and its two functions: one axis's taps, and the
 *  average of the finished taps over the pixel's footprint. GLSL ES 1.00,
 *  like the text it goes into. */
function boxGlsl(variant: FusedVariant): string {
  const footprint = variant.lens
    ? `${lensSourceFootprintGlsl}
vec3 fusedBoxAverage() {
	vec2 dUdx;
	vec2 dUdy;
	${BOX_JACOBIAN_WARP}`
    : `
vec3 fusedBoxAverage() {
	${BOX_JACOBIAN_FLAT}
	vec2 dUdx = vec2( uUvScale.x / uOutputSize.x, 0.0 );
	vec2 dUdy = vec2( 0.0, uUvScale.y / uOutputSize.y );`;
  return `
// The supersample's box (app/FusedOutputPass.ts): on while the scene is drawn
// larger than the canvas and this pass draws the canvas.
uniform float uBox;
// The scene's drawn sub-rectangle and the canvas, in pixels.
uniform vec2 uInputSize;
uniform vec2 uOutputSize;
// 0 the area box, 1 the tent (app/UpscalePass.ts DownsampleFilter).
uniform float uFilter;
// Taps per axis, 2 or 3 (fusedBoxTaps).
uniform vec2 uBoxTaps;

// One axis of the footprint, by the downsample's own rule
// (app/UpscalePass.ts downsampleAxisWeights): the taps' weights, normalised,
// and their offsets from the pixel's centre in output pixels. 'p' is the
// output pixel on this axis. A tap past the image is fetched at its edge
// texel and weighted by its own overlap, as the downsample does.
void fusedBoxAxis( float p, float inSize, float outSize, float taps, out vec3 weights, out vec3 offsets ) {
	float f = inSize / outSize;
	float from = p * f;
	float to = from + f;
	float centre = 0.5 * ( from + to );
	float first = taps > 2.5 ? floor( centre ) - 1.0 : floor( from );
	vec3 index = first + vec3( 0.0, 1.0, 2.0 );
	vec3 w;
	if ( uFilter > 0.5 ) {
		w = max( vec3( 0.0 ), 1.0 - abs( index + 0.5 - centre ) / f );
	} else {
		w = max( vec3( 0.0 ), min( vec3( to ), index + 1.0 ) - max( vec3( from ), index ) );
	}
	if ( taps < 2.5 ) w.z = 0.0;
	weights = w / max( w.x + w.y + w.z, 1e-6 );
	offsets = ( clamp( index, 0.0, inSize - 1.0 ) + 0.5 ) / f - ( p + 0.5 );
}
${footprint}
	vec2 p = floor( gl_FragCoord.xy );
	vec3 wx;
	vec3 ox;
	vec3 wy;
	vec3 oy;
	fusedBoxAxis( p.x, uInputSize.x, uOutputSize.x, uBoxTaps.x, wx, ox );
	fusedBoxAxis( p.y, uInputSize.y, uOutputSize.y, uBoxTaps.y, wy, oy );
${variant.glow ? `	${BOX_GLOW_READ}
` : ''}	vec3 sum = vec3( 0.0 );
	for ( int j = 0; j < 3; j ++ ) {
		if ( float( j ) >= uBoxTaps.y ) break;
		float wj = j == 0 ? wy.x : ( j == 1 ? wy.y : wy.z );
		float oj = j == 0 ? oy.x : ( j == 1 ? oy.y : oy.z );
		for ( int i = 0; i < 3; i ++ ) {
			if ( float( i ) >= uBoxTaps.x ) break;
			float wi = i == 0 ? wx.x : ( i == 1 ? wx.y : wx.z );
			float oi = i == 0 ? ox.x : ( i == 1 ? ox.y : ox.z );
			${BOX_TAP_READ}
${variant.glow ? `			${BOX_GLOW_ADD}
` : ''}			${finishingLinesForTap()}
			${BOX_SUM}
		}
	}
	return sum;
}
`;
}

/**
 * The box put into a variant's finished text: its declarations and functions
 * before main, and main's body wrapped so that with `uBox` on the pixel is the
 * average of its finished taps — with the dither added after the sum and the
 * alpha set opaque last, the order the single-read body keeps — and with it
 * off the body runs exactly as it was written.
 */
function withBox(text: string, variant: FusedVariant): string {
  const open = text.indexOf(MAIN_OPEN);
  const close = text.lastIndexOf('}');
  if (open < 0 || text.indexOf(MAIN_OPEN, open + 1) >= 0 || close < open) {
    throw new Error('fusedFragmentText: the installed three no longer carries one main to put the box beside');
  }
  const body = text.slice(open + MAIN_OPEN.length, close);
  return `${text.slice(0, open)}${boxGlsl(variant)}
${MAIN_OPEN}

	${BOX_BRANCH_OPEN}

		${BOX_WRITE}
		${OUTPUT_DITHER_ADD}
		${OUTPUT_OPAQUE_WRITE}

	${BOX_BRANCH_ELSE}
${body}
	}
${text.slice(close)}`;
}

/** Whether the box in a text is the one this file means: per tap the read,
 *  the glow, the tone curve and the transfer, in that order, then the sum;
 *  the derivative of the variant's own map; and a write that adds the dither
 *  after the average and ends opaque, with no second transfer after it. */
function boxIsWired(text: string, variant: FusedVariant): boolean {
  const fnOpen = text.indexOf('vec3 fusedBoxAverage() {');
  const mainOpen = text.indexOf(MAIN_OPEN);
  const branch = text.indexOf(BOX_BRANCH_OPEN);
  const otherwise = text.indexOf(BOX_BRANCH_ELSE, branch);
  if (fnOpen < 0 || mainOpen < fnOpen || branch < mainOpen || otherwise < branch) return false;
  const fn = text.slice(fnOpen, mainOpen);
  const boxBranch = text.slice(branch, otherwise);
  const read = fn.indexOf(BOX_TAP_READ);
  const tone = fn.indexOf('tap.rgb = ACESFilmicToneMapping( tap.rgb );');
  const transfer = fn.indexOf(BOX_TRANSFER);
  const sum = fn.indexOf(BOX_SUM);
  const glowAdd = fn.indexOf(BOX_GLOW_ADD);
  const once = (hay: string, needle: string): boolean => hay.split(needle).length === 2;
  return text.includes('uniform float uBox;')
    && fn.includes('for ( int j = 0; j < 3; j ++ )')
    && fn.includes('for ( int i = 0; i < 3; i ++ )')
    && once(fn, BOX_TAP_READ)
    && read >= 0 && read < tone && tone < transfer && transfer < sum
    && once(fn, 'sRGBTransferOETF(')
    && !fn.includes('gl_FragColor')
    && (variant.lens
      ? fn.includes(BOX_JACOBIAN_WARP) && text.includes('vec2 lensSourceFootprint(vec2 vUv, vec2 outputSize, out vec2 dUdx, out vec2 dUdy)')
      : fn.includes(BOX_JACOBIAN_FLAT) && !text.includes('lensSourceFootprint'))
    && (variant.glow
      ? once(fn, BOX_GLOW_READ) && fn.indexOf(BOX_GLOW_READ) < read && read < glowAdd && glowAdd < tone
      : !fn.includes('tBloom') && glowAdd < 0)
    && boxBranch.indexOf(BOX_WRITE) >= 0
    && boxBranch.indexOf(BOX_WRITE) < boxBranch.indexOf(OUTPUT_DITHER_ADD)
    && !boxBranch.includes('sRGBTransferOETF')
    && !boxBranch.includes('tDiffuse')
    && outputWriteIsOpaque(boxBranch);
}

/**
 * Taps per axis the box reads, from the drawn size, the canvas and the
 * kernel: the downsample's three, or two where every footprint covers exactly
 * two texels and the shader's arithmetic is exact. That is a ratio of
 * a/b = (b + 1)/b in lowest terms — a footprint 1 + 1/b texels wide starts at
 * a multiple of 1/b, so it never reaches a third texel — with b a power of two
 * no larger than 1024, so the ratio and every footprint's edges are exact in
 * 32-bit float and no edge lands a hair inside the texel before. The tent is
 * wider than its footprint and keeps three.
 */
export function fusedBoxTaps(inSize: number, outSize: number, filter: DownsampleFilter): 2 | 3 {
  if (filter === 'tent') return 3;
  const gcd = (x: number, y: number): number => (y === 0 ? x : gcd(y, x % y));
  const g = gcd(inSize, outSize);
  const a = inSize / g;
  const b = outSize / g;
  return a === b + 1 && b <= 1024 && (b & (b - 1)) === 0 ? 2 : 3;
}

/** One axis of the box as the shader computes it, for the tests that hold it
 *  to downsampleAxisWeights: the texel each tap fetches (clamped into the
 *  image), its normalised weight and its offset from the output pixel's
 *  centre in output pixels. */
export function fusedBoxAxis(
  inSize: number,
  outSize: number,
  outIndex: number,
  filter: DownsampleFilter,
  taps: number,
): { fetch: [number, number, number]; weights: [number, number, number]; offsets: [number, number, number] } {
  const f = inSize / outSize;
  const from = outIndex * f;
  const to = from + f;
  const centre = 0.5 * (from + to);
  const first = taps > 2 ? Math.floor(centre) - 1 : Math.floor(from);
  const raw: [number, number, number] = [0, 0, 0];
  const fetch: [number, number, number] = [0, 0, 0];
  const offsets: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const i = first + k;
    raw[k] = filter === 'tent'
      ? Math.max(0, 1 - Math.abs(i + 0.5 - centre) / f)
      : Math.max(0, Math.min(to, i + 1) - Math.max(from, i));
    fetch[k] = Math.min(Math.max(i, 0), inSize - 1);
    offsets[k] = (fetch[k] + 0.5) / f - (outIndex + 0.5);
  }
  if (taps < 3) raw[2] = 0;
  const sum = raw[0] + raw[1] + raw[2];
  const norm = Math.max(sum, 1e-6);
  return { fetch, weights: [raw[0] / norm, raw[1] / norm, raw[2] / norm], offsets };
}

/**
 * Whether a variant's text really carries the edits that variant is made of.
 *
 * Every one of them is a string replacement into three's own shader, and a
 * replacement that found nothing is silent: a pass that drops the glow
 * entirely, one that reads its whole allocation where the frame is a corner of
 * it, or one whose warp is missing so the frame comes out rectilinear. Given
 * the pass's material it checks what that material really compiles; given the
 * variant alone, the assembled text.
 */
export function fusedFragmentIsWired(variant: FusedVariant, material?: THREE.ShaderMaterial): boolean {
  const text = material?.fragmentShader ?? fusedFragmentText(variant);
  const carries = (needle: string, wanted: boolean): boolean => text.includes(needle) === wanted;
  return text.split('uniform vec2 uUvScale;').length === 2
    && text.includes('uniform vec2 uUvMax;')
    && carries('vec2 lensSourceUv(vec2 vUv)', variant.lens)
    && carries('texture2D( tDiffuse, lensSourceUv( vUv ) )', variant.lens)
    && carries('texture2D( tDiffuse, min( vUv * uUvScale, uUvMax ) )', !variant.lens)
    && carries('uniform sampler2D tBloom;', variant.glow)
    && carries('gl_FragColor.rgb += texture2D( tBloom, vUv ).rgb;', variant.glow)
    && (variant.box ? boxIsWired(text, variant) : !text.includes('uBox'))
    && outputDitherIsWired(text)
    && outputWriteIsOpaque(text);
}

/**
 * The `?fuseddown=0` kill switch, on any build: a scene drawn larger than the
 * canvas averaged down by the downsample pass of its own again, after a
 * finishing pass at scene size. The A/B for anything the box's three
 * differences might have moved, in the house style of `?fused=0`.
 */
export function parseFusedDownParam(search: string): boolean {
  return new URLSearchParams(search).get('fuseddown') !== '0';
}

/**
 * The `?fused=0` kill switch, on any build: the old three-pass chain back — a
 * lens pass of its own, the bloom blend, then three's output pass. The A/B for
 * anything the fused pass's four differences might have moved, in the house
 * style of `?alloc=0` and `?ride=0`.
 */
export function parseFusedParam(search: string): boolean {
  return new URLSearchParams(search).get('fused') !== '0';
}

/**
 * The finishing pass (app/UpscalePass.ts OutputTargetPass — three's OutputPass
 * with a target of its own when the upscaler follows), reading the scene image
 * through the lens warp and adding the bloom composite before the tone curve,
 * and — with `box` — averaging a scene drawn larger than the canvas down onto
 * it.
 *
 * With none of them it is three's own OutputPass text with the scaled read,
 * which is what the pass was before the fold.
 */
export class FusedOutputPass extends OutputTargetPass {
  readonly variant: FusedVariant;
  /** Whether main asked for the box: the scene is larger than the canvas and
   *  the downsample pass is off. */
  private boxWanted = false;
  private boxFilter: DownsampleFilter = 'box';

  private readonly bufferSize = new THREE.Vector2();

  constructor(opts: { bloom: BloomChainPass | null; lens: LensUniforms | null; box?: boolean }) {
    super();
    this.variant = { lens: opts.lens !== null, glow: opts.bloom !== null, box: opts.box ?? false };
    // The variant's whole text goes over the one OutputTargetPass built — the
    // scaled read is already in it, so it is not patched again — and the
    // uniforms that drive it stay the pair the base constructor installed, so
    // the reference its owner took is still the live one. Only the tDiffuse
    // read is scaled: the glow is a full image of the sub-rect's content,
    // sampled edge to edge like the blend it replaces.
    this.material.fragmentShader = fusedFragmentText(this.variant);
    this.subRect = installSubRectUniforms(this.material.uniforms);
    if (opts.bloom) this.material.uniforms.tBloom = { value: opts.bloom.compositeTexture };
    if (opts.lens) installLensUniforms(this.material.uniforms, opts.lens);
    if (this.variant.box) {
      const u = this.material.uniforms;
      u.uBox = { value: 0 };
      u.uInputSize = { value: new THREE.Vector2(1, 1) };
      u.uOutputSize = { value: new THREE.Vector2(1, 1) };
      u.uFilter = { value: 0 };
      u.uBoxTaps = { value: new THREE.Vector2(3, 3) };
    }
    // uDither stays the one the base constructor installed and sets per
    // render: on only for the write that lands on the canvas
    // (app/outputDither.ts). Every variant's text carries the dither.
    this.material.needsUpdate = true;
  }

  /**
   * Average a scene drawn larger than the canvas here, with the downsample's
   * kernel, or not. main's resample wiring calls it with the live direction;
   * a text without the box ignores it. Uniforms only: nothing relinks.
   */
  setBox(on: boolean, filter: DownsampleFilter): void {
    this.boxWanted = on && this.variant.box === true;
    this.boxFilter = filter;
  }

  /** Whether main has asked for the box: a frame drawn larger than the
   *  canvas is averaged here, and the downsample pass is off. */
  get boxOn(): boolean {
    return this.boxWanted;
  }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
    deltaTime = 0,
    maskActive = false,
  ): void {
    if (this.variant.box) {
      const u = this.material.uniforms;
      // Only while this write is the canvas: the box draws at output size,
      // and its own target is scene-sized. main never asks for it otherwise.
      const box = this.boxWanted && this.renderToScreen;
      u.uBox.value = box ? 1 : 0;
      if (box) {
        renderer.getDrawingBufferSize(this.bufferSize);
        const outW = Math.max(1, Math.floor(this.bufferSize.x));
        const outH = Math.max(1, Math.floor(this.bufferSize.y));
        // The sub-rectangle the scene was really drawn into, not its
        // allocation: under Dynamic the frame is a corner of a larger target.
        const drawn = drawnSize(readBuffer);
        (u.uInputSize.value as THREE.Vector2).set(drawn.width, drawn.height);
        (u.uOutputSize.value as THREE.Vector2).set(outW, outH);
        u.uFilter.value = this.boxFilter === 'tent' ? 1 : 0;
        (u.uBoxTaps.value as THREE.Vector2).set(
          fusedBoxTaps(drawn.width, outW, this.boxFilter),
          fusedBoxTaps(drawn.height, outH, this.boxFilter),
        );
      }
    }
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
  }
}
