import { describe, expect, it } from 'vitest';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import {
  applyMapOrbitButtCaps,
  createMapMoonRingMaterial,
  createMapPlanetOrbitMaterial,
} from './mapOrbitMaterial';

describe('applyMapOrbitButtCaps', () => {
  it('removes the overlapping round cap while preserving the segment body', () => {
    const input = new LineMaterial({ linewidth: 2.5, opacity: 0.7, transparent: true });
    const material = applyMapOrbitButtCaps(input);

    // Patches IN PLACE: a fresh default material here would silently drop the
    // caller's configured accessor-backed settings (they live in uniforms).
    expect(material).toBe(input);
    expect(material.linewidth).toBe(2.5);
    expect(material.opacity).toBe(0.7);

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

describe('map orbit material factories', () => {
  // The factories exist so the cap patch cannot be dropped from one call site
  // without failing here — the moon rings shipped un-patched once exactly
  // because the two sites configured their own materials.
  it('planet-orbit material: butt-capped with the map depth contract', () => {
    const material = createMapPlanetOrbitMaterial(0.85);
    expect(material.fragmentShader).not.toContain('if ( len2 > 1.0 ) discard;');
    expect(material.customProgramCacheKey()).toBe('map-orbit-butt-caps-v1');
    expect(material.linewidth).toBe(1.5);
    expect(material.vertexColors).toBe(true);
    expect(material.transparent).toBe(true);
    expect(material.opacity).toBe(0.85);
    expect(material.depthTest).toBe(true);
    expect(material.depthWrite).toBe(false);
    expect(material.toneMapped).toBe(false);
  });

  it('moon-ring material: butt-capped, catalog-tinted, same depth contract', () => {
    const material = createMapMoonRingMaterial(0x88ccff, 0.5);
    expect(material.fragmentShader).not.toContain('if ( len2 > 1.0 ) discard;');
    expect(material.customProgramCacheKey()).toBe('map-orbit-butt-caps-v1');
    expect(material.color.getHex()).toBe(0x88ccff);
    expect(material.linewidth).toBe(1);
    expect(material.vertexColors).toBe(false);
    expect(material.transparent).toBe(true);
    expect(material.opacity).toBe(0.5);
    expect(material.depthTest).toBe(true);
    expect(material.depthWrite).toBe(false);
    expect(material.toneMapped).toBe(false);
  });
});
