/**
 * The line between a moon's photo map and its procedural paint.
 *
 * Every photo moon draws a real mosaic over a procedural BUMP: only Earth's
 * Moon ships measured relief, so the rest keep the painter's height field
 * under a photographed colour. That makes the observe-time re-render a
 * half-and-half operation — sharpen the bump, leave the colour alone — and the
 * half it must leave alone is the one a player would notice, because throwing
 * the photo away for a noise field is a moon visibly getting worse the closer
 * you look.
 *
 * The screen that decides it is the needColor test inside renderAndAssign, so
 * these pin the OUTCOME of a real upgrade() rather than the eligibility
 * predicate in front of it: a photo moon comes out of one holding the same
 * texture object and the same colour-tier rank it went in with, at a higher
 * procedural width.
 *
 * The renderer is a stub — the class only asks it for a context, an anisotropy
 * cap, and a place to render — which is what lets the transaction be checked
 * off a GPU at all.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ProceduralMoonTexturer } from './ProceduralMoonTexturer';
import { moonTextureSize } from './proceduralMoon';
import { TIER_RANK } from './textureLadder';
import { makeGeometryUpgrade, type MoonMesh } from '../PlanetFactory';
import { MOONS } from '../planets/moonData';

/** Enough of a renderer for the paint transaction: the validation probe reads
 *  back the ~128 that says an sRGB target stores raw bytes, and the renders
 *  themselves go nowhere. */
function stubRenderer(): THREE.WebGLRenderer {
  return {
    getContext: () => ({ isContextLost: () => false }),
    capabilities: { getMaxAnisotropy: () => 8 },
    readRenderTargetPixels: (
      _rt: unknown, _x: number, _y: number, _w: number, _h: number, buf: Uint8Array,
    ) => { buf[0] = 128; },
    getRenderTarget: () => null,
    getViewport: (v: THREE.Vector4) => v,
    setRenderTarget: () => {},
    setViewport: () => {},
    render: () => {},
  } as unknown as THREE.WebGLRenderer;
}

function moonMesh(name: string, photo: THREE.Texture | null): MoonMesh {
  const data = MOONS.find((m) => m.name === name)!;
  const mat = new THREE.MeshStandardMaterial({ color: data.color });
  if (photo) {
    // Exactly what the streamed photo leaves behind (PlanetFactory's moon
    // photo fetch): the map, the boot tier's rank, and the flag the painter
    // reads.
    mat.map = photo;
    mat.userData.colorTierRank = TIER_RANK['2k'];
    mat.userData.photoLoaded = true;
  }
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(data.radiusAU, 8, 4), mat);
  return {
    mesh,
    data,
    painted: false,
    textureUpgrades: [],
    geometryUpgrade: makeGeometryUpgrade([{ mesh, radiusAU: data.radiusAU }]),
  };
}

describe('the observe-time re-render of a photo moon', () => {
  it('sharpens the bump and leaves the photograph exactly where it was', () => {
    const texturer = new ProceduralMoonTexturer(stubRenderer());
    const photo = new THREE.Texture();
    const moon = moonMesh('Enceladus', photo);
    const mat = moon.mesh.material as THREE.MeshStandardMaterial;

    texturer.paint(moon);
    expect(moon.painted).toBe(true);
    // The paint gave it a bump and nothing else: the photo is still the map.
    expect(mat.map).toBe(photo);
    expect(mat.bumpMap).not.toBeNull();
    expect(mat.userData.proceduralWidth).toBe(moonTextureSize(moon.data.radiusKm).width);

    const bump = mat.bumpMap;
    expect(texturer.upgrade(moon, 2048)).toBe(true);
    // The half that changed.
    expect(mat.userData.proceduralWidth).toBe(2048);
    expect(mat.bumpMap).not.toBe(bump);
    // The half that must not: same texture object, same rank. A new rank of 0
    // here would also let a late-arriving boot map win over the photo.
    expect(mat.map).toBe(photo);
    expect(mat.userData.colorTierRank).toBe(TIER_RANK['2k']);

    texturer.dispose();
  });

  it('re-renders the colour for a moon with no photo — the procedural floor is the map', () => {
    const texturer = new ProceduralMoonTexturer(stubRenderer());
    const moon = moonMesh('Umbriel', null);
    const mat = moon.mesh.material as THREE.MeshStandardMaterial;

    texturer.paint(moon);
    const painted = mat.map;
    expect(painted).not.toBeNull();
    expect(mat.userData.colorTierRank).toBe(0); // the procedural floor

    expect(texturer.upgrade(moon, 2048)).toBe(true);
    expect(mat.map).not.toBe(painted);
    expect(mat.userData.colorTierRank).toBe(0);
    expect(mat.userData.proceduralWidth).toBe(2048);

    texturer.dispose();
  });
});
