import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { assembleScenePasses, renderPassesDirect, type ScenePassSpec } from './renderPipeline';

// RenderPass instances construct without a GL context (the constructor only sets
// properties), so the assembly path is testable in node.

describe('assembleScenePasses', () => {
  const cam = new THREE.PerspectiveCamera();

  it('gives the first pass the default full clear', () => {
    const passes = assembleScenePasses([{ scene: new THREE.Scene() }], cam);
    expect(passes).toHaveLength(1);
    expect(passes[0].clear).toBe(true);
    expect(passes[0].clearDepth).toBe(false);
    expect(passes[0].camera).toBe(cam);
  });

  it('preserves colour on later passes and reflects clearDepthBefore', () => {
    const specs: ScenePassSpec[] = [
      { scene: new THREE.Scene() },
      { scene: new THREE.Scene(), clearDepthBefore: true },
    ];
    const passes = assembleScenePasses(specs, cam);
    expect(passes[0].clear).toBe(true);
    expect(passes[1].clear).toBe(false);
    expect(passes[1].clearDepth).toBe(true);
    expect(passes[0].scene).toBe(specs[0].scene);
    expect(passes[1].scene).toBe(specs[1].scene);
  });

  it('leaves clearDepth false on a later pass that does not ask for it', () => {
    const passes = assembleScenePasses(
      [{ scene: new THREE.Scene() }, { scene: new THREE.Scene() }],
      cam,
    );
    expect(passes[1].clear).toBe(false);
    expect(passes[1].clearDepth).toBe(false);
  });
});

// A minimal hand-rolled renderer that records its call sequence and autoClear
// writes — enough to pin renderPassesDirect without a real WebGL context.
function fakeRenderer() {
  const calls: string[] = [];
  const autoClearWrites: boolean[] = [];
  let autoClear = true;
  const r = {
    get autoClear() { return autoClear; },
    set autoClear(v: boolean) { autoClearWrites.push(v); autoClear = v; },
    render: () => { calls.push('render'); },
    clear: () => { calls.push('clear'); },
    clearDepth: () => { calls.push('clearDepth'); },
  };
  return { renderer: r as unknown as THREE.WebGLRenderer, calls, autoClearWrites, get autoClearNow() { return autoClear; } };
}

describe('renderPassesDirect', () => {
  const cam = new THREE.PerspectiveCamera();

  it('single pass renders once and never touches autoClear (pre-refactor parity)', () => {
    const f = fakeRenderer();
    renderPassesDirect(f.renderer, [{ scene: new THREE.Scene() }], cam);
    expect(f.calls).toEqual(['render']);
    expect(f.autoClearWrites).toEqual([]);
  });

  it('multi pass clears once, clears depth per spec, and restores autoClear', () => {
    const f = fakeRenderer();
    renderPassesDirect(
      f.renderer,
      [{ scene: new THREE.Scene() }, { scene: new THREE.Scene(), clearDepthBefore: true }],
      cam,
    );
    // clear once, sky render, depth clear before world, world render.
    expect(f.calls).toEqual(['clear', 'render', 'clearDepth', 'render']);
    // Toggled off, then restored to the original true.
    expect(f.autoClearWrites).toEqual([false, true]);
    expect(f.autoClearNow).toBe(true);
  });

  it('restores a non-default autoClear value it found', () => {
    const f = fakeRenderer();
    f.renderer.autoClear = false; // some caller left it off
    f.autoClearWrites.length = 0; // ignore that setup write
    renderPassesDirect(
      f.renderer,
      [{ scene: new THREE.Scene() }, { scene: new THREE.Scene(), clearDepthBefore: true }],
      cam,
    );
    expect(f.autoClearNow).toBe(false);
  });
});
