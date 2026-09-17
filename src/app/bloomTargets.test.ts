import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { holdBloomSize } from './bloomTargets';

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
