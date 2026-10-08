/**
 * Earth's night lights, as one material used two ways: the SHELL that draws
 * the whole night hemisphere from the globe's own night map, and the SECTOR
 * tiles that draw a sharper patch of the same thing on top of it. One factory
 * for both, sharing the sun-direction and air uniform OBJECTS rather than
 * copies of their values, so a term added to the glow — an atmospheric
 * transmittance, a different twilight ramp — is added once and reaches every
 * mesh that draws lights. The tile's own map and its UV rectangle are the only
 * things a sector does not share, and that is stated once, in OWN_UNIFORMS,
 * rather than by listing what IS shared: a uniform added to the shell has to
 * reach the sectors by default, or the tiles are the one layer a new term
 * misses — which is the same rectangle-on-the-surface bug the day family's
 * shared fx exists to prevent.
 *
 * The air is the body's own `fx.air`, the objects the globe and the cloud deck
 * read, so the lights dim through exactly the column that hazes the ground.
 * Its lookup radius is the shell's own, not the surface archetype's: the lights
 * are on the ground and this mesh is not, so the segment's far end is
 * substituted back down to the surface (NIGHT_LIGHTS_AIR_LOOKUP_RADIUS) and the
 * whole column applies. Only `x T` — the globe underneath has already added the
 * air's in-scattered light, and an additive layer that added it again would
 * count the night side's airlight twice.
 *
 * What replaces the shell under a sector is the CUT (world/groundCull), and it
 * is not the mechanism the day tiles use. A day tile replaces the globe by
 * depth: the globe writes depth and the tile, drawn first, writes a nearer
 * one. Depth cannot do it here. The tiles are built at the GLOBE's radius
 * (PlanetariumMode registers the family) and the shell 6 km above it, so for
 * any camera outside the globe the shell is the NEARER surface: it passes the
 * depth test over a tile by tens of depth units at orbital range, far past
 * what a units-only offset reaches, and both layers are additive, so the shell
 * would add its lights again over every resident tile — a rectangle twice as
 * bright. So the streamer leaves the shell's leaves under every drawn night
 * tile out of the shell's draw, and the family sets `cutAlways`: that cut
 * stands under `?groundcull=0` and the DEV switch, which are cost switches for
 * ground that loses the depth test anyway and would otherwise change this
 * picture.
 *
 * A night sector material still writes depth, pulled one unit nearer per
 * level on top of the shell's base bias, while staying `transparent: true` —
 * the flag here is a render-list choice, not a blending one. The depth write
 * and the offset are there for the tile against the GROUND under it (the
 * globe's own lattice, where the depths tie exactly and the offset puts the
 * tile in front of the day tiles over the same ground) and for the night
 * levels' order among themselves, finest nearest. Its silhouette is the
 * ground's own: built at the shell's radius the tiles wrote depth 6 km past
 * the ground's limb, and the air behind that band was rejected, a black line
 * along the horizon. Additive blending applies either way, but an opaque-list
 * sector at a negative renderOrder would draw before the globe and punch it
 * out under itself.
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
import {
  AERIAL_PERSPECTIVE_GLSL,
  ATMOSPHERE_LOOKUP_GLSL,
  atmosphereSessionSizes,
  atmosphereTableDefines,
} from './atmosphereLut';
import { perfSwitchUniform } from '../../app/perfSwitches';
import { NIGHT_SHELL_DEPTH_BIAS_UNITS, nightSectorDepthBiasUnits } from './shellDepthBias';
import { NIGHT_LIGHTS_AIR_LOOKUP_RADIUS, type SurfaceAirFx } from './surfaceShading';
import type { SectorMaps } from './sectorMaterial';
import type { SectorFamily } from './sectorStreamer';

/** The only uniforms a night sector owns rather than shares with its shell:
 *  its own tile, and which rectangle of that tile it draws. Everything else in
 *  the shell's uniform set is handed over by reference. */
const OWN_UNIFORMS: readonly string[] = ['nightTexture', 'uUvOffset', 'uUvRepeat'];

function nightMaterial(
  uniforms: Record<string, THREE.IUniform>,
  defines: Record<string, string>,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms,
    // The lookup half of the table GLSL, then the aerial functions, then the
    // shader that calls them: the conventions here are not recoverable from
    // the textures, so there is one text and every consumer prepends it. The
    // standalone form, with its own precision block and PI — a ShaderMaterial
    // gets no <common> chunk to supply either. Identical text and identical
    // defines on the shell and on every sector, which is what lets them share
    // one compiled program.
    vertexShader: earthNightVertexShader,
    fragmentShader: ATMOSPHERE_LOOKUP_GLSL + AERIAL_PERSPECTIVE_GLSL + earthNightFragmentShader,
    defines,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    // Lifted off the globe for the same reason the deck above it is: 6.4 km of
    // clearance is under one depth step at cruise range (world/shellDepthBias).
    // The sectors that replace this shell keep their own step on top of the
    // shared base, so a sector still beats the shell it stands in for.
    polygonOffset: true,
    polygonOffsetFactor: 0,
    polygonOffsetUnits: -NIGHT_SHELL_DEPTH_BIAS_UNITS,
  });
}

/** The night-lights shell: the whole equirect over the whole globe. `air` is
 *  the body's own SurfaceAirFx — the same objects the globe and the cloud deck
 *  were augmented with. */
export function createEarthNightShellMaterial(
  map: THREE.Texture | null,
  air: SurfaceAirFx,
): THREE.ShaderMaterial {
  // The map goes into the AIR's own uniform, and the shell reads that object
  // under its own name. The cloud deck glows cities through itself from the
  // same object, so the ladder that sharpens the shell's map sharpens what the
  // deck lights with — a uniform of its own would leave the deck on the boot
  // map for the rest of the session.
  air.uNightLights.value = map;
  return nightMaterial(
    {
      nightTexture: air.uNightLights,
      sunDirection: { value: new THREE.Vector3(1, 0, 0) },
      uUvOffset: { value: new THREE.Vector2(0, 0) },
      uUvRepeat: { value: new THREE.Vector2(1, 1) },
      ...air,
      // ...and all of that column: the lights are on the ground, this shell is
      // not, and the difference is most of the air. Its own object, spread
      // AFTER the air so it wins over the surface archetype's radius, and
      // handed on to the sectors like every other shared uniform.
      uAirLookupRadius: { value: NIGHT_LIGHTS_AIR_LOOKUP_RADIUS },
      // The A/B for the early-out the fragment shader carries. Shared, like
      // every other uniform here, so the shell and its sectors switch in the
      // same frame — a capture of two halves of the disc under two different
      // paths would not be a comparison of anything. Nothing in a production
      // build: the shader there has one path and no uniform to read.
      ...(import.meta.env.DEV ? { uPerfNightEarly: perfSwitchUniform('night-early') } : {}),
    },
    atmosphereTableDefines(atmosphereSessionSizes()),
  );
}

/**
 * One night sector's material: the shell's program over the sector's own tile.
 * The UV rectangle comes off the tile texture, which the streamer has already
 * given the (grid, sector, layout) transform its image was cut on — one source
 * of truth for where a tile's interior sits, shared with the day family.
 *
 * Everything else is the shell's own uniform object, the air included, so the
 * transmittance the mode binds once per body dims a tile exactly as it dims the
 * shell around it. The defines come off the shell too rather than being asked
 * for a second time: two different table sizes would be two programs drawing
 * the same lights.
 */
export function createEarthNightSectorMaterial(
  shell: THREE.ShaderMaterial,
  maps: SectorMaps,
  level: number,
): THREE.ShaderMaterial {
  const uniforms: Record<string, THREE.IUniform> = {};
  for (const [name, uniform] of Object.entries(shell.uniforms)) {
    if (!OWN_UNIFORMS.includes(name)) uniforms[name] = uniform;
  }
  uniforms.nightTexture = { value: maps.map };
  uniforms.uUvOffset = { value: maps.map.offset.clone() };
  uniforms.uUvRepeat = { value: maps.map.repeat.clone() };
  const mat = nightMaterial(uniforms, (shell.defines ?? {}) as Record<string, string>);
  mat.depthWrite = true;
  // The sector's vertices coincide with the GLOBE's (it is built at the
  // globe's radius on the globe's lattice), so the depth it writes ties exactly
  // with the ground under it, and three's LessEqual test passes on a tie. The
  // units-only offset, one step per level on top of the shell's base, puts it
  // in front of the day tiles over the same ground and orders the night levels
  // among themselves, finest nearest. It does not put the tile in front of the
  // shell, which is 6 km further out and the nearer surface: the streamer's
  // cut leaves the shell out under a drawn tile (the family's cutAlways). The
  // slope factor stays 0: it grows without bound at the limb, where it would
  // pull a sector out through the cloud deck above it.
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = 0;
  mat.polygonOffsetUnits = -nightSectorDepthBiasUnits(level);
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
    // Nothing to mirror: the sector holds the shell's own sun and air uniform
    // objects, so what the mode writes for the shell IS what the sector reads.
    // Its map is its own tile, which is the one thing it must not take from
    // the shell.
    syncMaterial: () => {},
    drawnColorMapWidth: () => {
      const img = (shell.uniforms.nightTexture?.value as THREE.Texture | null)?.image as
        | { width?: unknown }
        | undefined;
      return img && typeof img.width === 'number' ? img.width : 0;
    },
    // One program by construction — the same text and the shell's own defines
    // object — and asked rather than assumed, so a sector built any other way
    // covers nothing.
    sharesProgram: (coverer, covered) => {
      const a = coverer as THREE.ShaderMaterial;
      const b = covered as THREE.ShaderMaterial;
      return a.vertexShader === b.vertexShader && a.fragmentShader === b.fragmentShader && a.defines === b.defines;
    },
    // The shell is the nearer surface and both layers add, so the cut is the
    // only thing that keeps a tile's lights from being drawn twice: it is not
    // the cost switch `?groundcull=0` turns off (the header says why).
    cutAlways: true,
  };
}
