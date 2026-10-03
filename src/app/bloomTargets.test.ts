import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { LuminosityHighPassShader } from 'three/addons/shaders/LuminosityHighPassShader.js';
import {
  HIGH_PASS_KNEE_GLSL, HIGH_PASS_STEP_ANCHOR, HIGH_PASS_STEP_SHARE_GLSL, SEA_BLOOM_SHARE_GLSL, bloomHighPassMaterial, holdBloomSize, installBloomKnee,
  installSeaBloomShare,
  parseBloomKneeParam,
} from './bloomTargets';
import { BLOOM_KNEE, BLOOM_THRESHOLD, bloomExcess } from './bloomConfig';
import { HIGH_PASS_UV_ANCHOR, patchUvScale } from './sceneSubRect';

/** The first mip the pass blurs — half the requested resolution, and the one
 *  `devRenderTargets().bloomMip0` reports. */
const mip0 = (pass: UnrealBloomPass): THREE.WebGLRenderTarget =>
  (pass as unknown as { renderTargetsHorizontal: THREE.WebGLRenderTarget[] }).renderTargetsHorizontal[0];

/** What EffectComposer does to every pass on a resize: the effective size,
 *  whatever that pass thinks of it. */
const cascade = (pass: UnrealBloomPass, width: number, height: number): void => {
  pass.setSize(width, height);
};

describe('holdBloomSize', () => {
  it('leaves the chain exactly where it was when the composer re-sizes', () => {
    // The bloom chain is sized at its own ratio, not the scene's: a step from
    // scene 2 to scene 2.5 must not touch it at all. Without the hold, the
    // composer's cascade would size eleven half-float targets to the scene and
    // sizeBloomPass would size them back — two dimension changes, two
    // disposes, ~115 MB of churn per step.
    const pass = new UnrealBloomPass(new THREE.Vector2(1728, 1117), 1, 0.4, 1);
    const sizeChain = holdBloomSize(pass);
    sizeChain(1728 * 2, 1117 * 2);
    const before = { width: mip0(pass).width, height: mip0(pass).height };
    expect(before.width).toBe(Math.round(1728 * 2 / 2));
    cascade(pass, 1728 * 2.5, 1117 * 2.5);
    cascade(pass, 1728 * 1.5, 1117 * 1.5);
    expect(mip0(pass).width).toBe(before.width);
    expect(mip0(pass).height).toBe(before.height);
  });

  it('hands the real sizer back, so its one owner can still move it', () => {
    const pass = new UnrealBloomPass(new THREE.Vector2(1728, 1117), 1, 0.4, 1);
    const sizeChain = holdBloomSize(pass);
    sizeChain(1728 * 2, 1117 * 2);
    const at2 = mip0(pass).width;
    // A real display change (a move to a 1x monitor) still reaches the chain.
    sizeChain(1728, 1117);
    expect(mip0(pass).width).toBeLessThan(at2);
    expect(mip0(pass).width).toBe(Math.round(1728 / 2));
  });

  it('is the only writer: the pass\'s own method does nothing afterwards', () => {
    const pass = new UnrealBloomPass(new THREE.Vector2(800, 600), 1, 0.4, 1);
    const sizeChain = holdBloomSize(pass);
    sizeChain(800, 600);
    const before = mip0(pass).width;
    pass.setSize(4000, 3000);
    expect(mip0(pass).width).toBe(before);
    sizeChain(4000, 3000);
    expect(mip0(pass).width).toBe(2000);
  });
});

describe('installSeaBloomShare', () => {
  it('puts the share on three\'s step when the knee is off, and leaves a knee-patched material alone', () => {
    const pass = new UnrealBloomPass(new THREE.Vector2(64, 64), 1, 0.4, 1);
    const material = bloomHighPassMaterial(pass);
    installSeaBloomShare(material);
    expect(material.fragmentShader).not.toContain(HIGH_PASS_STEP_ANCHOR);
    expect(material.fragmentShader).toContain(HIGH_PASS_STEP_SHARE_GLSL);
    expect(material.fragmentShader.split(SEA_BLOOM_SHARE_GLSL).length - 1).toBe(1);
    const kneed = bloomHighPassMaterial(new UnrealBloomPass(new THREE.Vector2(64, 64), 1, 0.4, 1));
    installBloomKnee(kneed, 0.25);
    const before = kneed.fragmentShader;
    installSeaBloomShare(kneed);
    expect(kneed.fragmentShader).toBe(before);
    expect(kneed.fragmentShader.split(SEA_BLOOM_SHARE_GLSL).length - 1).toBe(1);
  });
});

describe('installBloomKnee', () => {
  const highPass = (): THREE.ShaderMaterial => new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(LuminosityHighPassShader.uniforms),
    vertexShader: LuminosityHighPassShader.vertexShader,
    fragmentShader: LuminosityHighPassShader.fragmentShader,
  });

  it('replaces the step with the excess, on the pass\'s own material', () => {
    const pass = new UnrealBloomPass(new THREE.Vector2(64, 64), 1, 0.4, 1);
    const material = bloomHighPassMaterial(pass);
    expect(material.fragmentShader).toContain(HIGH_PASS_STEP_ANCHOR);
    installBloomKnee(material, BLOOM_KNEE);
    expect(material.fragmentShader).not.toContain(HIGH_PASS_STEP_ANCHOR);
    expect(material.fragmentShader).toContain('uniform float uBloomKnee;');
    expect(material.fragmentShader).toContain(HIGH_PASS_KNEE_GLSL);
    expect((material.uniforms.uBloomKnee as { value: number }).value).toBe(BLOOM_KNEE);
    // The sub-rectangle patch edits a different line of the same text, so
    // the two compose in either order (main.ts applies this one second).
    expect(material.fragmentShader).toContain(HIGH_PASS_UV_ANCHOR);
    patchUvScale(material, HIGH_PASS_UV_ANCHOR);
    expect(material.fragmentShader).toContain(HIGH_PASS_KNEE_GLSL);
  });

  it('throws rather than patching nothing when the anchor is gone', () => {
    const material = highPass();
    material.fragmentShader = material.fragmentShader.replace(HIGH_PASS_STEP_ANCHOR, 'gl_FragColor = texel;');
    expect(() => installBloomKnee(material, BLOOM_KNEE)).toThrow(/installed three/);
  });

  it('never divides by a knee of zero', () => {
    const material = highPass();
    installBloomKnee(material, 0);
    expect((material.uniforms.uBloomKnee as { value: number }).value).toBeGreaterThan(0);
  });

  it('is the TypeScript twin, arm for arm', () => {
    // The GLSL carries the same two arms bloomExcess does, in the same
    // spelling, so a change to one is a change to both or a failing test.
    expect(HIGH_PASS_KNEE_GLSL).toContain('max( v - luminosityThreshold, 0.0 )');
    expect(HIGH_PASS_KNEE_GLSL).toContain('bloomOver * bloomOver / ( 2.0 * uBloomKnee )');
    expect(HIGH_PASS_KNEE_GLSL).toContain('bloomOver - 0.5 * uBloomKnee');
    expect(HIGH_PASS_KNEE_GLSL).toContain('bloomShare * bloomExcess / max( v, 1e-4 )');
    // The sea's share: a negative alpha is water, which hands the blur nothing;
    // everything at zero or more passes whole, so the Sun's glow is untouched.
    expect(HIGH_PASS_KNEE_GLSL).toContain(SEA_BLOOM_SHARE_GLSL);
    expect(SEA_BLOOM_SHARE_GLSL).toBe('float bloomShare = 1.0 - clamp( -texel.a, 0.0, 1.0 );');
  });
});

describe('bloomExcess', () => {
  const threshold = BLOOM_THRESHOLD;
  const knee = BLOOM_KNEE;

  it('hands over nothing at or under the threshold, which keeps the stars out', () => {
    expect(bloomExcess(0, threshold, knee)).toBe(0);
    expect(bloomExcess(0.999, threshold, knee)).toBe(0);
    expect(bloomExcess(threshold, threshold, knee)).toBe(0);
  });

  it('hands over a few hundredths of a pixel just over the line, and all but one unit of the Sun', () => {
    // The ocean glint's core after the keep and the air: about a tenth over.
    expect(bloomExcess(1.1, threshold, knee)).toBeCloseTo(0.02, 3);
    // three's step handed the same pixel over whole.
    expect(bloomExcess(1.1, threshold, knee) / 1.1).toBeLessThan(0.02);
    // The photosphere sits far over the line and loses only the threshold
    // and half the knee.
    expect(bloomExcess(50, threshold, knee)).toBeCloseTo(50 - threshold - knee / 2, 9);
  });

  it('meets itself at the knee in value and in slope', () => {
    const at = threshold + knee;
    const eps = 1e-6;
    // Both arms at the knee itself: the square's half knee and the line's.
    expect((knee * knee) / (2 * knee)).toBeCloseTo(knee - knee / 2, 12);
    expect(bloomExcess(at - eps, threshold, knee)).toBeCloseTo(bloomExcess(at + eps, threshold, knee), 5);
    const slopeBelow = (bloomExcess(at, threshold, knee) - bloomExcess(at - eps, threshold, knee)) / eps;
    const slopeAbove = (bloomExcess(at + eps, threshold, knee) - bloomExcess(at, threshold, knee)) / eps;
    expect(slopeBelow).toBeCloseTo(1, 4);
    expect(slopeAbove).toBeCloseTo(1, 4);
  });

  it('is monotone, and the pure excess with no knee', () => {
    let last = -1;
    for (let v = 0; v <= 5; v += 0.01) {
      const now = bloomExcess(v, threshold, knee);
      expect(now).toBeGreaterThanOrEqual(last);
      last = now;
    }
    expect(bloomExcess(1.5, threshold, 0)).toBe(0.5);
  });
});

describe('parseBloomKneeParam', () => {
  it('is on unless the link says 0', () => {
    expect(parseBloomKneeParam('')).toBe(true);
    expect(parseBloomKneeParam('?bloomknee=1')).toBe(true);
    expect(parseBloomKneeParam('?fused=0')).toBe(true);
    expect(parseBloomKneeParam('?bloomknee=0')).toBe(false);
  });
});
