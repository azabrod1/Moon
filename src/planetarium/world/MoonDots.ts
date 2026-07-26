/**
 * The photometric moon-dot layer: one THREE.Points holding a vertex per catalog
 * moon (~64). A sub-pixel moon is drawn here as a star-scale point at its
 * apparent magnitude and crossfades out as the real mesh disc resolves. The
 * controller fills the buffers each frame (from the pure moonDots.ts photometry)
 * AFTER the final camera pose; hidden moons write alpha 0.
 *
 * Shares the starfield's point shader (round soft falloff, gl_PointSize ×
 * pixelRatio) and its normal transparent blending, so a dot reads like a star
 * rather than a hot additive blob. depthTest stays ON / depthWrite OFF, so
 * planets and nearer moons occlude a dot while the layer never writes depth.
 * frustumCulled is off — the vertices carry absolute floating-origin scene
 * positions the controller rewrites every frame, so a cached bounding sphere
 * would cull wrongly (the count is tiny; culling buys nothing).
 */
import * as THREE from 'three';
import {
  applyLensShaderUniforms,
  createLensShaderUniforms,
  lensShaderGLSL,
  type LensShaderUniforms,
} from '../../shared/three/lensShader';

/** gl_PointSize is framebuffer pixels, so a point that should read as N CSS px
 *  must be N × the renderer's pixel ratio — capped at 2 to match the sizes the
 *  shared mapping was tuned against (same clamp the starfield uses). */
function moonDotPixelRatio(rendererPixelRatio: number): number {
  return Math.min(rendererPixelRatio, 2);
}

export class MoonDots {
  readonly points: THREE.Points;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private positions: Float32Array;
  private colors: Float32Array;
  private sizes: Float32Array;
  private alphas: Float32Array;

  constructor(count: number, rendererPixelRatio: number) {
    this.positions = new Float32Array(count * 3);
    this.colors = new Float32Array(count * 3);
    this.sizes = new Float32Array(count);
    this.alphas = new Float32Array(count); // 0 → nothing drawn until the first fill

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1));
    this.geo.setAttribute('alpha', new THREE.BufferAttribute(this.alphas, 1));

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        pixelRatio: { value: moonDotPixelRatio(rendererPixelRatio) },
        ...createLensShaderUniforms(),
      },
      vertexShader: `
        attribute float size;
        attribute float alpha;
        varying vec3 vColor;
        varying float vAlpha;
        varying vec2 vLensOutputCentre;
        varying float vLensTargetDiameterPx;
        uniform float pixelRatio;
        ${lensShaderGLSL}
        void main() {
          vColor = color;
          vAlpha = alpha;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          vec2 sourceCentre = gl_Position.xy / gl_Position.w;
          vLensOutputCentre = lensWarpSourceNdc(sourceCentre);
          vLensTargetDiameterPx = size * pixelRatio;
          vec2 halfOutputNdc = vec2(
            vLensTargetDiameterPx / max(uLensFramebufferPx.x, 1.0),
            vLensTargetDiameterPx / max(uLensFramebufferPx.y, 1.0)
          );
          vec2 sourceA = lensUnwarpOutputNdc(vLensOutputCentre + halfOutputNdc);
          vec2 sourceB = lensUnwarpOutputNdc(vLensOutputCentre - halfOutputNdc);
          vec2 sourceC = lensUnwarpOutputNdc(vLensOutputCentre + vec2(halfOutputNdc.x, -halfOutputNdc.y));
          vec2 sourceD = lensUnwarpOutputNdc(vLensOutputCentre + vec2(-halfOutputNdc.x, halfOutputNdc.y));
          vec2 halfA = abs(sourceA - sourceCentre) * uLensFramebufferPx * 0.5;
          vec2 halfB = abs(sourceB - sourceCentre) * uLensFramebufferPx * 0.5;
          vec2 halfC = abs(sourceC - sourceCentre) * uLensFramebufferPx * 0.5;
          vec2 halfD = abs(sourceD - sourceCentre) * uLensFramebufferPx * 0.5;
          float sourceHalfPx = max(
            max(max(halfA.x, halfA.y), max(halfB.x, halfB.y)),
            max(max(halfC.x, halfC.y), max(halfD.x, halfD.y))
          );
          gl_PointSize = max(1.0, 2.0 * sourceHalfPx);
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;
        varying vec2 vLensOutputCentre;
        varying float vLensTargetDiameterPx;
        ${lensShaderGLSL}
        void main() {
          vec2 sourceNdc = gl_FragCoord.xy / uLensFramebufferPx * 2.0 - 1.0;
          vec2 outputNdc = lensWarpSourceNdc(sourceNdc);
          vec2 outputOffsetPx = (outputNdc - vLensOutputCentre) * uLensFramebufferPx * 0.5;
          float d = length(outputOffsetPx) / max(vLensTargetDiameterPx, 1e-6);
          if (d > 0.5) discard;
          float falloff = 1.0 - smoothstep(0.2, 0.5, d);
          gl_FragColor = vec4(vColor, falloff * vAlpha);
        }
      `,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      vertexColors: true,
      blending: THREE.NormalBlending,
    });

    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 0;
  }

  /** Retune point size when the renderer's pixel ratio changes (DPR / resize). */
  setPixelRatio(rendererPixelRatio: number): void {
    this.mat.uniforms.pixelRatio.value = moonDotPixelRatio(rendererPixelRatio);
  }

  /** Keep source-prewarp point footprints invariant in final framebuffer px. */
  setLens(
    camera: THREE.PerspectiveCamera,
    viewportWidthPx: number,
    viewportHeightPx: number,
    rendererPixelRatio: number,
  ): void {
    applyLensShaderUniforms(
      this.mat.uniforms as unknown as LensShaderUniforms,
      camera,
      viewportWidthPx,
      viewportHeightPx,
      rendererPixelRatio,
    );
  }

  /** Write one moon's dot (absolute scene position, chromaticity × brightness,
   *  point size px, alpha). Call for every vertex each frame; hidden moons get
   *  `hide`. */
  setDot(
    index: number,
    x: number,
    y: number,
    z: number,
    r: number,
    g: number,
    b: number,
    sizePx: number,
    alpha: number,
  ): void {
    const i3 = index * 3;
    this.positions[i3] = x;
    this.positions[i3 + 1] = y;
    this.positions[i3 + 2] = z;
    this.colors[i3] = r;
    this.colors[i3 + 1] = g;
    this.colors[i3 + 2] = b;
    this.sizes[index] = sizePx;
    this.alphas[index] = alpha;
  }

  hide(index: number): void {
    this.alphas[index] = 0;
  }

  /** Push the frame's buffer writes to the GPU — one needsUpdate per attribute. */
  flush(): void {
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.size as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.alpha as THREE.BufferAttribute).needsUpdate = true;
  }

  setVisible(visible: boolean): void {
    this.points.visible = visible;
  }

  /** Blank every dot (WebGL context loss, mode teardown) — nothing renders until
   *  the next fill. */
  clear(): void {
    this.alphas.fill(0);
    (this.geo.attributes.alpha as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
