import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputShader } from 'three/addons/shaders/OutputShader.js';
import { LuminosityHighPassShader } from 'three/addons/shaders/LuminosityHighPassShader.js';
import {
  HIGH_PASS_UV_ANCHOR, OUTPUT_UV_ANCHOR, UV_READ, UV_UNIFORM_ANCHOR,
  allocationSceneRatio, applySubRect, installSubRectUniforms, parseAllocParam, patchSceneRead,
  patchUvScale, sceneRects, uvScaleIsWired,
} from './sceneSubRect';
import { dynamicLadder, qualityBounds, sceneTargetSize, type QualityBoundsInput } from './renderQuality';
import { lensSourceUvGlsl } from '../shared/math/lensProjection';

/** A display whose bounds offer High: the case where the allocation and the
 *  rung differ at all. */
const DESKTOP: QualityBoundsInput = {
  outputRatio: 2,
  platform: 'apple',
  envelopeBytes: 2_000 * 1024 * 1024,
  cssWidth: 1728,
  cssHeight: 1117,
  samples: 0,
  hasComposer: true,
  supersampleFallback: false,
  maxGlSize: 16384,
};

/** A display whose bounds refuse High — here because its GPU completed no
 *  multisampled half-float target — so its ladder tops out at medium and the
 *  frame always fills its allocation. */
const NO_SUPERSAMPLE: QualityBoundsInput = { ...DESKTOP, supersampleFallback: true };

const ladderFor = (input: QualityBoundsInput) => dynamicLadder(qualityBounds(input));

describe('the allocation size', () => {
  it('is the ladder’s top rung, whatever rung Dynamic sits on', () => {
    const ladder = ladderFor(DESKTOP);
    const top = ladder.rungs[ladder.rungs.length - 1];
    expect(top).toBeGreaterThan(2);
    for (const rung of ladder.rungs) {
      expect(allocationSceneRatio(rung, ladder, true)).toBe(top);
    }
  });

  it('is the rung itself where the fixed allocation does not apply', () => {
    // A fixed level, another mode's composer, a measurement pin, ?alloc=0:
    // every one of them allocates exactly what it draws, as it always did.
    const ladder = ladderFor(DESKTOP);
    for (const rung of ladder.rungs) {
      expect(allocationSceneRatio(rung, ladder, false)).toBe(rung);
    }
  });

  it('is medium’s own size where the ladder tops out there', () => {
    const ladder = ladderFor(NO_SUPERSAMPLE);
    expect(allocationSceneRatio(ladder.rungs[0], ladder, true)).toBe(2);
    // So the frame at medium fills its allocation and nothing is scaled.
    const alloc = sceneTargetSize(NO_SUPERSAMPLE.cssWidth, NO_SUPERSAMPLE.cssHeight, 2);
    const rects = sceneRects(alloc, sceneTargetSize(NO_SUPERSAMPLE.cssWidth, NO_SUPERSAMPLE.cssHeight, 2));
    expect(rects.uvScale).toEqual({ x: 1, y: 1 });
    expect(rects.clamped).toBe(false);
  });

  it('never sits below the ratio being drawn', () => {
    // A ladder that cannot reach the live ratio must not leave the frame
    // drawing outside its own storage.
    const ladder = { rungs: [1, 1.5], mediumIndex: 1 };
    expect(allocationSceneRatio(3, ladder, true)).toBe(3);
  });
});

describe('the sub-rectangle', () => {
  it('scales by draw over allocation on each axis', () => {
    const alloc = sceneTargetSize(1728, 1117, 3);
    const draw = sceneTargetSize(1728, 1117, 2);
    const rects = sceneRects(alloc, draw);
    expect(rects.alloc).toEqual({ width: 5184, height: 3351 });
    expect(rects.draw).toEqual({ width: 3456, height: 2234 });
    expect(rects.uvScale.x).toBeCloseTo(3456 / 5184, 12);
    expect(rects.uvScale.y).toBeCloseTo(2234 / 3351, 12);
    expect(rects.clamped).toBe(false);
  });

  it('clamps a draw larger than its allocation and says so', () => {
    const rects = sceneRects({ width: 100, height: 80 }, { width: 120, height: 80 });
    expect(rects.draw).toEqual({ width: 100, height: 80 });
    expect(rects.clamped).toBe(true);
  });

  it('puts the far edge half a texel inside the frame’s own edge', () => {
    const uniforms = installSubRectUniforms({});
    const rects = sceneRects({ width: 400, height: 200 }, { width: 300, height: 100 });
    applySubRect(uniforms, rects);
    const scale = uniforms.uUvScale.value as THREE.Vector2;
    const max = uniforms.uUvMax.value as THREE.Vector2;
    expect(scale.x).toBeCloseTo(0.75, 12);
    expect(max.x).toBeCloseTo(0.75 - 0.5 / 400, 12);
    expect(max.y).toBeCloseTo(0.5 - 0.5 / 200, 12);
  });

  it('is the whole target where the frame fills it', () => {
    const uniforms = installSubRectUniforms({});
    applySubRect(uniforms, sceneRects({ width: 400, height: 200 }, { width: 400, height: 200 }));
    expect((uniforms.uUvScale.value as THREE.Vector2).x).toBe(1);
    expect((uniforms.uUvScale.value as THREE.Vector2).y).toBe(1);
  });
});

describe('the ?alloc= kill switch', () => {
  it('is on unless a URL says 0', () => {
    expect(parseAllocParam('')).toBe(true);
    expect(parseAllocParam('?quality=dynamic')).toBe(true);
    expect(parseAllocParam('?alloc=1')).toBe(true);
    expect(parseAllocParam('?alloc=0')).toBe(false);
    expect(parseAllocParam('?debug=1&alloc=0&quality=dynamic')).toBe(false);
  });
});

describe('the shader anchors, against the installed three', () => {
  it('names text both of three’s shaders really carry', () => {
    // String.replace with a missing needle is a silent no-op: a three release
    // that reformats either shader would leave a pass reading its whole
    // allocation, and the symptom is the previous rung's image smeared into
    // the frame's top and right — caught by eye or not at all.
    expect(LuminosityHighPassShader.fragmentShader).toContain(HIGH_PASS_UV_ANCHOR);
    expect(LuminosityHighPassShader.fragmentShader).toContain(UV_UNIFORM_ANCHOR);
    expect(OutputShader.fragmentShader).toContain(OUTPUT_UV_ANCHOR);
    expect(OutputShader.fragmentShader).toContain(UV_UNIFORM_ANCHOR);
    expect(HIGH_PASS_UV_ANCHOR).toContain(UV_READ);
    expect(OUTPUT_UV_ANCHOR).toContain(UV_READ);
  });

  it('throws rather than patching nothing', () => {
    const material = new THREE.ShaderMaterial({
      uniforms: {},
      fragmentShader: 'uniform sampler2D tDiffuse;\nvoid main() { gl_FragColor = vec4(1.0); }',
    });
    expect(() => patchUvScale(material, OUTPUT_UV_ANCHOR)).toThrow(/no longer carries/);
  });

  it('scales the read and installs the uniforms', () => {
    const material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(OutputShader.uniforms),
      fragmentShader: OutputShader.fragmentShader,
    });
    const uniforms = patchUvScale(material, OUTPUT_UV_ANCHOR);
    expect(uvScaleIsWired(material)).toBe(true);
    expect(material.fragmentShader).not.toContain(OUTPUT_UV_ANCHOR);
    expect(material.uniforms.uUvScale).toBe(uniforms.uUvScale);
    // Patched a second time — which the fused finishing pass does — the
    // uniforms already handed out stay the live ones.
    material.fragmentShader = OutputShader.fragmentShader;
    expect(patchUvScale(material, OUTPUT_UV_ANCHOR).uUvScale).toBe(uniforms.uUvScale);
  });

  it('leaves the bloom blend and composite exactly as three wrote them', () => {
    // The blend draws into the buffer whose viewport IS the sub-rectangle and
    // samples full images of it, so it is correct untouched — and a patch
    // applied to it would double-scale the glow.
    const pass = new UnrealBloomPass(new THREE.Vector2(256, 256), 1, 0.4, 1);
    const internals = pass as unknown as {
      blendMaterial: THREE.ShaderMaterial;
      compositeMaterial: THREE.ShaderMaterial;
    };
    expect(internals.blendMaterial.fragmentShader).not.toContain('uUvScale');
    expect(internals.compositeMaterial.fragmentShader).not.toContain('uUvScale');
  });
});

describe('the inverse map’s own two reads', () => {
  it('both go through the sub-rectangle', () => {
    // The early-out (the optical centre, and a strength of zero) and the
    // warped lookup. A scale applied to one and not the other would move the
    // frame's centre against its edges. Pinned on the shared function rather
    // than on the lens pass, because the bright pass and the finishing pass
    // read through the same two lines.
    expect(lensSourceUvGlsl).toContain('min(vUv * uUvScale, uUvMax)');
    expect(lensSourceUvGlsl).toContain('clamp(srcUv * uUvScale, vec2(0.0), uUvMax)');
    expect(lensSourceUvGlsl).not.toContain('clamp(srcUv, 0.0, 1.0)');
  });
});

describe('a site that reads through the lens warp', () => {
  const outputMaterial = () => new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(OutputShader.uniforms),
    fragmentShader: OutputShader.fragmentShader,
  });

  it('warps its read and carries the function once', () => {
    const material = outputMaterial();
    const uniforms = patchSceneRead(material, OUTPUT_UV_ANCHOR, true);
    expect(uvScaleIsWired(material)).toBe(true);
    expect(material.fragmentShader).toContain('texture2D( tDiffuse, lensSourceUv( vUv ) )');
    expect(material.fragmentShader).not.toContain('texture2D( tDiffuse, min( vUv * uUvScale, uUvMax ) )');
    expect(material.fragmentShader).toContain(lensSourceUvGlsl);
    expect(material.uniforms.uUvMax).toBe(uniforms.uUvMax);
  });

  it('declares each uniform exactly once, either way round', () => {
    // Two declarations of the same uniform do not compile, and the wiring
    // checks are string checks: nothing else would catch it before a black
    // frame on the mode that built the material.
    for (const lens of [false, true]) {
      const material = outputMaterial();
      patchSceneRead(material, OUTPUT_UV_ANCHOR, lens);
      for (const declaration of ['uniform vec2 uUvScale;', 'uniform vec2 uUvMax;']) {
        expect(material.fragmentShader.split(declaration)).toHaveLength(2);
      }
      // The warp's own four come with the function, and only with it.
      expect(material.fragmentShader.includes('uniform float uStrength;')).toBe(lens);
    }
  });

  it('throws on the bright pass’s anchor too, rather than patching nothing', () => {
    const material = new THREE.ShaderMaterial({
      uniforms: {},
      fragmentShader: 'uniform sampler2D tDiffuse;\nvoid main() { gl_FragColor = vec4(1.0); }',
    });
    expect(() => patchSceneRead(material, HIGH_PASS_UV_ANCHOR, true)).toThrow(/no longer carries/);
  });

  it('is what the bright pass really gets from three’s own text', () => {
    const material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(LuminosityHighPassShader.uniforms),
      fragmentShader: LuminosityHighPassShader.fragmentShader,
    });
    patchSceneRead(material, HIGH_PASS_UV_ANCHOR, true);
    expect(material.fragmentShader).toContain('vec4 texel = texture2D( tDiffuse, lensSourceUv( vUv ) );');
    // Threshold, smooth width and default colour are untouched: the pass is the
    // same high pass, reading a different position.
    expect(material.fragmentShader).toContain('smoothstep( luminosityThreshold, luminosityThreshold + smoothWidth, v )');
  });
});
