/**
 * The last two full-screen passes of the frame, folded into one.
 *
 * The chain ends with UnrealBloomPass adding its glow into the lens result at
 * full resolution — a read, an add and a write of a whole RGBA16F surface —
 * and then OutputPass reading that same surface back to tone-map it onto the
 * canvas. On a tile-based GPU each of those is a render pass of its own: the
 * attachment is loaded into tile memory, touched once and stored back. Folding
 * them removes one full-resolution read-modify-write and one whole pass
 * boundary; the glow is still composited at half resolution by the bloom
 * chain, and the lens still runs before the blur, because a blur of a warped
 * image is not a warp of a blurred one.
 *
 * THIS IS THE ONE ITEM THAT CANNOT PROMISE THE SAME PIXELS, and it is off by
 * default for that reason. The current chain computes
 * `tonemap( fp16( lens + bloom ) )`: the sum lands in a half-float surface and
 * is rounded there before the tone curve reads it. Fused, the sum stays in the
 * fragment shader's own precision and that rounding disappears. Everything
 * else is held identical — the composite is the same half-resolution texture
 * sampled the same way, the add is the same (ONE, ONE) the blend material's
 * premultiplied additive blending performs, and the exposure, the tone curve
 * and the output colour transform are OutputShader's own text with one line
 * added to it.
 *
 * Built to be measured and reported. Nothing here runs unless the switch is
 * armed, and a production build carries none of it: the classes are reached
 * only from a DEV branch, and the fused text is put together on first use
 * rather than at module load, so there is no top-level work for the bundler
 * to keep. (Built eagerly, the two string replacements survived tree-shaking
 * and the text shipped.)
 */
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { OutputShader } from 'three/addons/shaders/OutputShader.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

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
  /** The half-resolution glow the fused output pass adds. */
  get compositeTexture(): THREE.Texture {
    return (this as unknown as BloomInternals).renderTargetsHorizontal[0].texture;
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
    //    full-screen draw that used to follow is the output pass's first line.
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

/** OutputShader's own fragment text, with the glow added to the sample it
 *  starts from — the same add (ONE, ONE) the blend material performed, in the
 *  same place in the pipeline, one surface earlier. Assembled on first use
 *  (see the header): a module-level string edit is work a bundler keeps. */
let fusedFragment: string | null = null;
function fusedFragmentText(): string {
  return (fusedFragment ??= OutputShader.fragmentShader
    .replace(
      'uniform sampler2D tDiffuse;',
      'uniform sampler2D tDiffuse;\n\t\tuniform sampler2D tBloom;',
    )
    .replace(
      'gl_FragColor = texture2D( tDiffuse, vUv );',
      'gl_FragColor = texture2D( tDiffuse, vUv );\n\t\t\tgl_FragColor.rgb += texture2D( tBloom, vUv ).rgb;',
    ));
}

/** OutputPass with the bloom composite added before the tone curve. */
export class FusedOutputPass extends OutputPass {
  constructor(bloom: BloomChainPass) {
    super();
    this.material.fragmentShader = fusedFragmentText();
    this.material.uniforms.tBloom = { value: bloom.compositeTexture };
    this.material.needsUpdate = true;
  }
}

/** Whether the fused text really carries both of its edits — a silent
 *  no-op replace would be a pass that drops the glow entirely. */
export function fusedFragmentIsWired(): boolean {
  const text = fusedFragmentText();
  return text.includes('uniform sampler2D tBloom;')
    && text.includes('gl_FragColor.rgb += texture2D( tBloom, vUv ).rgb;');
}
