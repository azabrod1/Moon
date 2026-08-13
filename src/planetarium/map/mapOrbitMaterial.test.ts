import { describe, expect, it } from 'vitest';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { applyMapOrbitButtCaps } from './mapOrbitMaterial';

describe('applyMapOrbitButtCaps', () => {
  it('removes the overlapping round cap while preserving the segment body', () => {
    const material = applyMapOrbitButtCaps(new LineMaterial());

    expect(material.fragmentShader).not.toContain('if ( len2 > 1.0 ) discard;');
    expect(material.fragmentShader).toMatch(
      /if \( abs\( vUv\.y \) > 1\.0 \) \{[\s\S]*?float len2 = a \* a \+ b \* b;\s+discard;\s+\}/,
    );
    expect(material.customProgramCacheKey()).toBe('map-orbit-butt-caps-v1');
  });

  it('refuses double application — the anchor is consumed by the first pass', () => {
    // Both map call sites patch at construction; a second application would
    // mean a refactor routed one material through the helper twice.
    const material = applyMapOrbitButtCaps(new LineMaterial());
    expect(() => applyMapOrbitButtCaps(material)).toThrow(
      'map orbit-line shader cap anchor not found exactly once',
    );
  });

  it('fails loudly if a Three.js upgrade removes the shader anchor', () => {
    const material = new LineMaterial();
    material.fragmentShader = material.fragmentShader.replace(
      'if ( len2 > 1.0 ) discard;',
      'discard;',
    );

    expect(() => applyMapOrbitButtCaps(material)).toThrow(
      'map orbit-line shader cap anchor not found exactly once',
    );
  });
});
