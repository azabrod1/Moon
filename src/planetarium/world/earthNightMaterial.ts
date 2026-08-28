/**
 * Earth's night lights, as one material used two ways: the SHELL that draws
 * the whole night hemisphere from the globe's own night map, and the SECTOR
 * tiles that draw a sharper patch of the same thing on top of it. One factory
 * for both, sharing the sun-direction uniform OBJECT rather than a copy of its
 * value, so a term added to the glow — an atmospheric transmittance, a
 * different twilight ramp — is added once and reaches every mesh that draws
 * lights. The tile's own map and its UV rectangle are the only things a sector
 * does not share.
 *
 * Depth is the whole mechanism by which a sector replaces the shell under it,
 * and it is not the mechanism the day tiles use. A day tile replaces the globe
 * because the GLOBE writes depth and the tile, drawn first, writes a nearer
 * one; the night shell writes no depth at all, so a night sector that wrote
 * none either would simply add on top of it and every resident sector would be
 * exactly twice as bright, with a rectangle at its edge. So a night sector
 * material writes depth (at the shell's own radius, pulled one unit nearer per
 * level so the shell's coincident fragments are strictly further and fail the
 * test) while staying `transparent: true` — the flag here is a render-list
 * choice, not a blending one. Additive blending applies either way, but an
 * opaque-list sector at a negative renderOrder would draw before the globe and
 * punch it out under itself.
 *
 * The shell keeps `depthWrite: false`: it is the layer being replaced, and
 * writing depth over the whole night hemisphere would reject the cloud deck
 * and anything else drawn after it.
 */
import * as THREE from 'three';
import {
  EARTH_NIGHT_MIX_LIT,
  earthNightFragmentShader,
  earthNightMix,
  earthNightVertexShader,
} from '../../shared/shaders/atmosphere';
import type { SectorMaps } from './sectorMaterial';
import type { SectorFamily } from './sectorStreamer';

/** The per-frame uniform every night-lights mesh shares: the world-space
 *  direction to the Sun, written once per frame by the mode. */
export type EarthNightSunUniform = { value: THREE.Vector3 };

function nightMaterial(
  map: THREE.Texture | null,
  sunDirection: EarthNightSunUniform,
  uvOffset: THREE.Vector2,
  uvRepeat: THREE.Vector2,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      nightTexture: { value: map },
      sunDirection,
      uUvOffset: { value: uvOffset },
      uUvRepeat: { value: uvRepeat },
    },
    vertexShader: earthNightVertexShader,
    fragmentShader: earthNightFragmentShader,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}

/** The night-lights shell: the whole equirect over the whole globe. */
export function createEarthNightShellMaterial(map: THREE.Texture | null): THREE.ShaderMaterial {
  return nightMaterial(
    map,
    { value: new THREE.Vector3(1, 0, 0) },
    new THREE.Vector2(0, 0),
    new THREE.Vector2(1, 1),
  );
}

/**
 * One night sector's material: the shell's program over the sector's own tile.
 * The UV rectangle comes off the tile texture, which the streamer has already
 * given the (grid, sector, layout) transform its image was cut on — one source
 * of truth for where a tile's interior sits, shared with the day family.
 */
export function createEarthNightSectorMaterial(
  shell: THREE.ShaderMaterial,
  maps: SectorMaps,
  level: number,
): THREE.ShaderMaterial {
  const mat = nightMaterial(
    maps.map,
    shell.uniforms.sunDirection as EarthNightSunUniform,
    maps.map.offset.clone(),
    maps.map.repeat.clone(),
  );
  mat.depthWrite = true;
  // The sector's vertices coincide with the shell's, so the depth it writes
  // ties exactly with the shell's fragments and three's LessEqual test passes
  // on a tie. A units-only offset breaks it one step per level, finest
  // nearest. The slope factor stays 0: it grows without bound at the limb,
  // where it would pull a sector out through the cloud deck above it.
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = 0;
  mat.polygonOffsetUnits = -(level + 1);
  return mat;
}

/**
 * Earth's night-lights sector family: tiles on the night shell, gated and
 * ranked by the shell's own response to the sun rather than by daylight.
 * A sector is worth fetching when its DARKEST point is past the lit edge —
 * exactly the condition for some pixel of it to draw anything at all — and
 * ranks by how much of it the shell is actually lighting.
 */
export function earthNightSectorFamily(shell: THREE.ShaderMaterial): SectorFamily {
  return {
    side: 'night',
    lightEdge: EARTH_NIGHT_MIX_LIT,
    weight: earthNightMix,
    createMaterial: (maps, level) => createEarthNightSectorMaterial(shell, maps, level),
    // Nothing to mirror: the sector holds the shell's own sun uniform object,
    // so what the mode writes for the shell IS what the sector reads. Its map
    // is its own tile, which is the one thing it must not take from the shell.
    syncMaterial: () => {},
    drawnColorMapWidth: () => {
      const img = (shell.uniforms.nightTexture?.value as THREE.Texture | null)?.image as
        | { width?: unknown }
        | undefined;
      return img && typeof img.width === 'number' ? img.width : 0;
    },
  };
}
