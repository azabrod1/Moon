import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { augmentSurfaceMaterial, surfaceShadingArgsOf } from './surfaceShading';
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
      expect(sectorU[key]).toBe(fx[key]); // the very same object the mode writes into
      expect(baseU[key]).toBe(fx[key]);
    }
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

  it('lands in the globe\'s shader program, so the first sector draw links nothing', () => {
    // three keys the program cache on customProgramCacheKey(), whose default
    // is the onBeforeCompile SOURCE. Both materials get that hook from
    // surfaceShading, so a sector reuses the globe's already-linked program —
    // which is why a sector can appear mid-glide without a compile hitch. An
    // override, or a per-instance value folded into the key, would silently
    // double the program count and put a link back on that frame.
    const base = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
    augmentSurfaceMaterial(base, 'rocky', { inner: 1, outer: 2 }, 0.004);
    const sector = createSectorMaterial(base, { map: new THREE.Texture() });
    expect(sector.customProgramCacheKey()).toBe(base.customProgramCacheKey());
    expect(sector.onBeforeCompile.toString()).toBe(base.onBeforeCompile.toString());
    // Not vacuously equal because neither is augmented.
    expect(base.customProgramCacheKey()).not.toBe(
      new THREE.MeshStandardMaterial().customProgramCacheKey(),
    );
    // Same map slots too: three's own program parameters count which maps are
    // bound, so a sector that dropped one would fall into a second program
    // even with an identical hook.
    expect(!!sector.map).toBe(!!base.map);
    expect(!!sector.normalMap).toBe(!!base.normalMap);
    expect(!!sector.bumpMap).toBe(!!base.bumpMap);
    expect(!!sector.roughnessMap).toBe(!!base.roughnessMap);
  });

  it('is a plain standard material for an un-augmented base (no hook, no throw)', () => {
    const base = new THREE.MeshStandardMaterial();
    const sector = createSectorMaterial(base, { map: new THREE.Texture() });
    expect(surfaceShadingArgsOf(sector)).toBeUndefined();
  });
});
