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
      },
      vertexShader: `
        attribute float size;
        attribute float alpha;
        varying vec3 vColor;
        varying float vAlpha;
        uniform float pixelRatio;
        void main() {
          vColor = color;
          vAlpha = alpha;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          gl_PointSize = size * pixelRatio;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - vec2(0.5));
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
