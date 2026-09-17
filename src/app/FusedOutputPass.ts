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
 * `?fused=0` on any build puts the old three-pass chain back — the kill switch,
 * and the A/B for anything the four differences might have moved. In DEV
 * `?perfoff=fused-final` does the same through the switch registry.
 *
 * **Four shader texts, one per variant.** `{ lens, glow }` × {true, false}: the
 * planetarium's composer wants the warp and the other three do not, and bloom
 * can be off on any of them. There is one composer in the app, rebuilt per
 * camera, so a single memoised text would hand whichever mode was entered first
 * its own text to every later mode — and a warped text on a material with no
 * warp uniforms is a TypeError in three's uniform upload on that mode's first
 * render, not a wrong pixel. The texts are assembled on first use rather than
 * at module load: a module-level string edit is work a bundler keeps (built
 * eagerly, the replacements survived tree-shaking and shipped).
 */
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputShader } from 'three/addons/shaders/OutputShader.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { OutputTargetPass } from './UpscalePass';
import { bloomHighPassMaterial } from './bloomTargets';
import { installLensUniforms, type LensUniforms } from './LensPass';
import {
  HIGH_PASS_UV_ANCHOR, OUTPUT_UV_ANCHOR, installSubRectUniforms, patchSceneRead, scaleSceneRead,
  type SubRectUniforms,
} from './sceneSubRect';

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

/** Which of the finishing pass's two optional halves a text carries: the lens
 *  warp on its read of the scene, and the glow added before the tone curve. */
export interface FusedVariant {
  lens: boolean;
  glow: boolean;
}

/** The glow line, and the sampler it reads: the same add (ONE, ONE) the bloom
 *  blend material performed, in the same place in the pipeline, one surface
 *  earlier. */
const GLOW_DECLARATION = 'uniform sampler2D tDiffuse;\n\t\tuniform sampler2D tBloom;';
const GLOW_LINE = `${OUTPUT_UV_ANCHOR}\n\t\t\tgl_FragColor.rgb += texture2D( tBloom, vUv ).rgb;`;

const fusedTexts = new Map<string, string>();

/** One variant's fragment text, assembled on first use and kept. */
export function fusedFragmentText(variant: FusedVariant): string {
  const key = `${variant.lens ? 'warp' : 'flat'}:${variant.glow ? 'glow' : 'plain'}`;
  let text = fusedTexts.get(key);
  if (text === undefined) {
    const withGlow = variant.glow
      ? OutputShader.fragmentShader
        .replace('uniform sampler2D tDiffuse;', GLOW_DECLARATION)
        .replace(OUTPUT_UV_ANCHOR, GLOW_LINE)
      : OutputShader.fragmentShader;
    text = scaleSceneRead(withGlow, OUTPUT_UV_ANCHOR, variant.lens);
    fusedTexts.set(key, text);
  }
  return text;
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
    && carries('gl_FragColor.rgb += texture2D( tBloom, vUv ).rgb;', variant.glow);
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
 * through the lens warp and adding the bloom composite before the tone curve.
 *
 * With neither half it is three's own OutputPass text with the scaled read,
 * which is what the pass was before the fold.
 */
export class FusedOutputPass extends OutputTargetPass {
  readonly variant: FusedVariant;

  constructor(opts: { bloom: BloomChainPass | null; lens: LensUniforms | null }) {
    super();
    this.variant = { lens: opts.lens !== null, glow: opts.bloom !== null };
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
    this.material.needsUpdate = true;
  }
}
