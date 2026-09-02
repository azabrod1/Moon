import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LINE_CLIP_ANCHOR, SPRITE_CLIP_ANCHOR } from './lensShader';

// The lens splices rewrite two lines of three's own shaders by string
// replacement. A three bump that reworded either line would turn the splice
// into a silent no-op — so the installed shaders are checked for both needles
// (and the `#include <common>` the GLSL block is inserted after).

describe('lens splice anchors', () => {
  it('still finds its line in the installed sprite shader', () => {
    const vert = THREE.ShaderLib.sprite.vertexShader;
    expect(vert).toContain('#include <common>');
    expect(vert).toContain(SPRITE_CLIP_ANCHOR);
  });

  it('still finds its line in the installed LineMaterial shader', () => {
    const material = new LineMaterial();
    expect(material.vertexShader).toContain('#include <common>');
    expect(material.vertexShader).toContain(LINE_CLIP_ANCHOR);
    material.dispose();
  });
});
