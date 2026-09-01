import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  augmentSurfaceMaterial, setSurfaceSynthesis, surfaceShadingArgsOf, surfaceSynthesisOf,
} from './surfaceShading';
import { createSectorMaterial, syncSectorMaterial } from './sectorMaterial';

/** Run a material's onBeforeCompile hook against a minimal shader stub and
 *  return the uniforms it bound. */
function compiledUniforms(mat: THREE.Material): Record<string, { value: unknown }> {
  const shader = {
    uniforms: {} as Record<string, { value: unknown }>,
    vertexShader: '#include <common>\n#include <begin_vertex>\n',
    fragmentShader: '#include <common>\n#include <opaque_fragment>\n',
  };
  (mat.onBeforeCompile as (s: typeof shader) => void)(shader);
  return shader.uniforms;
}

describe('createSectorMaterial', () => {
  it('shares the base body\'s per-frame fx objects and re-derives the private uniforms', () => {
    const base = new THREE.MeshStandardMaterial();
    const fx = augmentSurfaceMaterial(base, 'rocky', { inner: 1, outer: 2 }, 0.004);
    const tile = new THREE.Texture();
    const sector = createSectorMaterial(base, { map: tile });
    const baseU = compiledUniforms(base);
    const sectorU = compiledUniforms(sector);
    for (const key of Object.keys(fx) as (keyof typeof fx)[]) {
      if (key === 'air') continue; // a block of its own, checked uniform by uniform below
      expect(sectorU[key]).toBe(fx[key]); // the very same object the mode writes into
      expect(baseU[key]).toBe(fx[key]);
    }
    // The air: the tables, the parameters that address them and the two numbers
    // that scale them. A sector draws ABOVE the globe, so a second set here is
    // a tile hazed differently from the pixel beside it — and the tables arrive
    // mid-session, long after the tile material was built, so it has to be the
    // same objects and not copies of their values.
    expect(Object.keys(fx.air).length).toBeGreaterThan(10);
    for (const key of Object.keys(fx.air)) {
      expect(sectorU[key], key).toBe(fx.air[key]);
      expect(baseU[key], key).toBe(fx.air[key]);
    }
    // And the table dimensions, which are #defines: a sector compiled against a
    // different set would read the same texture at a different stride.
    expect(sector.defines).toEqual(base.defines);
    expect(sector.defines?.SCATTERING_TEXTURE_NU_SIZE).toBeDefined();
    // Private (per-augment) uniforms match by value: same archetype, ring, sun.
    expect(sectorU.uRingInner.value).toBe(baseU.uRingInner.value);
    expect(sectorU.uRingOuter.value).toBe(baseU.uRingOuter.value);
    expect(sectorU.uSunTan.value).toBe(baseU.uSunTan.value);
    expect(sectorU.uLimbDarkening.value).toBe(baseU.uLimbDarkening.value);
    expect((sectorU.uNightColor.value as THREE.Color).getHex()).toBe((baseU.uNightColor.value as THREE.Color).getHex());
    expect(surfaceShadingArgsOf(sector)?.fx).toBe(fx);
  });

  it('never references a base texture — its maps are its own', () => {
    const base = new THREE.MeshStandardMaterial({
      map: new THREE.Texture(),
      bumpMap: new THREE.Texture(),
      roughnessMap: new THREE.Texture(),
    });
    augmentSurfaceMaterial(base, 'earth');
    const maps = { map: new THREE.Texture(), bumpMap: new THREE.Texture(), roughnessMap: new THREE.Texture() };
    const sector = createSectorMaterial(base, maps);
    expect(sector.map).toBe(maps.map);
    expect(sector.bumpMap).toBe(maps.bumpMap);
    expect(sector.roughnessMap).toBe(maps.roughnessMap);
    expect(sector.normalMap).toBeNull();
    expect(sector.map).not.toBe(base.map);
    expect(sector.bumpMap).not.toBe(base.bumpMap);
  });

  it('mirrors the base\'s scalar state at creation and on sync (the eclipse tint path)', () => {
    const base = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0.05 });
    base.bumpScale = 0.02;
    base.normalScale.set(0.5, 0.5);
    augmentSurfaceMaterial(base, 'airless');
    const sector = createSectorMaterial(base, { map: new THREE.Texture() });
    expect(sector.roughness).toBe(0.95);
    expect(sector.metalness).toBe(0.05);
    expect(sector.bumpScale).toBe(0.02);
    expect(sector.normalScale.x).toBe(0.5);
    // A blood-Moon frame: the mode tints the base material directly.
    base.color.setRGB(0.6, 0.2, 0.1);
    base.emissive.setRGB(0.3, 0.05, 0);
    base.emissiveIntensity = 0.4;
    syncSectorMaterial(sector, base);
    expect(sector.color.getHex()).toBe(base.color.getHex());
    expect(sector.emissive.getHex()).toBe(base.emissive.getHex());
    expect(sector.emissiveIntensity).toBe(0.4);
  });

  it('draws with a units-only polygon offset in its own favour', () => {
    const base = new THREE.MeshStandardMaterial();
    augmentSurfaceMaterial(base, 'rocky');
    const sector = createSectorMaterial(base, { map: new THREE.Texture() });
    expect(sector.polygonOffset).toBe(true);
    expect(sector.polygonOffsetFactor).toBe(0);
    expect(sector.polygonOffsetUnits).toBe(-1);
  });

  it('is a plain standard material for an un-augmented base (no hook, no throw)', () => {
    const base = new THREE.MeshStandardMaterial();
    const sector = createSectorMaterial(base, { map: new THREE.Texture() });
    expect(surfaceShadingArgsOf(sector)).toBeUndefined();
  });

  it("lands on the globe's own ground, at the globe's own strength", () => {
    // The close-range detail field is seeded by the BODY, so a sector has to
    // read the same patch of it as the globe under it; and how much of the term
    // is drawn is eased in wall time by the body's owner, so a sector left
    // holding whatever it was born with would fade on a schedule of its own —
    // which is a rectangle appearing on the surface.
    const base = new THREE.MeshStandardMaterial();
    augmentSurfaceMaterial(base, 'airless', undefined, 0, undefined, undefined, 'Moon');
    setSurfaceSynthesis(base, 0.4, 'none');
    const sector = createSectorMaterial(base, { map: new THREE.Texture() });
    expect(surfaceShadingArgsOf(sector)?.seedName).toBe('Moon');
    expect(compiledUniforms(sector).uSynthSeed.value)
      .toEqual(compiledUniforms(base).uSynthSeed.value);
    expect(surfaceSynthesisOf(sector)?.envelope).toBe(0.4);
    setSurfaceSynthesis(base, 0.9, 'none');
    syncSectorMaterial(sector, base);
    expect(surfaceSynthesisOf(sector)?.envelope).toBe(0.9);
  });

  it('answers for the relief on its OWN crops', () => {
    // A sector carries crops of whatever relief maps the base had, so whether a
    // synthesized relief would be a second set of craters is the tile's own
    // question and not the globe's.
    const base = new THREE.MeshStandardMaterial();
    augmentSurfaceMaterial(base, 'airless', undefined, 0, undefined, undefined, 'Moon');
    setSurfaceSynthesis(base, 1, 'none');
    const bare = createSectorMaterial(base, { map: new THREE.Texture() });
    expect(surfaceSynthesisOf(bare)?.relief).toBe('none');
    const relieved = createSectorMaterial(base, {
      map: new THREE.Texture(), normalMap: new THREE.Texture(),
    });
    expect(surfaceSynthesisOf(relieved)?.relief).toBe('measured');
    syncSectorMaterial(relieved, base);
    expect(surfaceSynthesisOf(relieved)?.relief).toBe('measured');
  });
});
