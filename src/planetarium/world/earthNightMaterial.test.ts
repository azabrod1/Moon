/**
 * The night-lights material, in its two forms, and the one geometric fact
 * every night sector rests on: the shell and the globe are the same frame.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import {
  createEarthNightSectorMaterial,
  createEarthNightShellMaterial,
  earthNightSectorFamily,
} from './earthNightMaterial';
import {
  SECTOR_GRID_16K,
  SECTOR_TILE,
  applySectorTileTransform,
  finerGrid,
  sectorCentreDirection,
  sectorTileTransform,
} from './sectorGrid';
import {
  EARTH_NIGHT_COLD_CUT,
  EARTH_NIGHT_MIX_SCALE,
  EARTH_NIGHT_WARM,
  EARTH_NIGHT_WARM_GLSL,
} from '../../shared/shaders/atmosphere';
import { sectorRenderOrder } from './sectorMaterial';
import {
  augmentSurfaceMaterial, createSurfaceAirFx, NIGHT_LIGHTS_AIR_LOOKUP_RADIUS,
} from './surfaceShading';
import { earthNightFragmentShader, earthNightMix, EARTH_NIGHT_MIX_DARK, EARTH_NIGHT_MIX_LIT } from '../../shared/shaders/atmosphere';

/** The shell as the factory builds it, on a body's own air — the same objects
 *  the globe and the cloud deck are augmented with. */
function shellOn(map: THREE.Texture | null, air = createSurfaceAirFx()): THREE.ShaderMaterial {
  return createEarthNightShellMaterial(map, air);
}

/** A tile texture as the streamer hands it over: its own image, carrying the
 *  UV transform of the (grid, sector, layout) it was cut on. */
function tile(grid: { cols: number; rows: number }, c: number, r: number): THREE.Texture {
  const tex = new THREE.Texture({ width: 2048, height: 2048 } as unknown as HTMLImageElement);
  applySectorTileTransform(tex, grid, { c, r }, SECTOR_TILE);
  return tex;
}

describe('the night sector material', () => {
  it('holds the shell\'s own sun uniform, and its own map', () => {
    // The object, not a copy of its value: what the mode writes for the shell
    // is what every night sector reads, so a term added to the glow is added
    // once. The colour map is the one thing that must NOT be shared — the
    // shell's is the whole equirect and the sector's is its tile.
    const shell = shellOn(new THREE.Texture());
    const family = earthNightSectorFamily(shell);
    const map = tile(SECTOR_GRID_16K, 3, 1);
    const sector = family.createMaterial({ map }, 0) as THREE.ShaderMaterial;
    family.syncMaterial(sector);
    expect(sector.uniforms.sunDirection).toBe(shell.uniforms.sunDirection);
    expect(sector.uniforms.nightTexture.value).toBe(map);
    expect(sector.uniforms.nightTexture.value).not.toBe(shell.uniforms.nightTexture.value);
    expect(sector.fragmentShader).toBe(shell.fragmentShader);
    expect(sector.vertexShader).toBe(shell.vertexShader);
    // The mode writes the sun once; the sector sees it without a sync.
    shell.uniforms.sunDirection.value.set(0, 0, 1);
    expect((sector.uniforms.sunDirection.value as THREE.Vector3).z).toBe(1);
  });

  it('dims a tile through the same air as the shell around it', () => {
    // The aerial term is `x T` on the night lights — the globe underneath has
    // already added the air's in-scattered light — and it has to reach the
    // SECTORS, not the shell alone: a tile is drawn over the shell, in exactly
    // the near-band pose the haze exists for, and an unhazed one is a bright
    // rectangle inside ten airmasses of atmosphere. The objects are the body's
    // own fx.air, and the tables arrive mid-session, long after a tile material
    // was built, so nothing here may be a copy of a value.
    const air = createSurfaceAirFx();
    const shell = shellOn(new THREE.Texture(), air);
    const sector = createEarthNightSectorMaterial(shell, { map: tile(SECTOR_GRID_16K, 2, 1) }, 0);
    for (const key of Object.keys(air)) {
      expect(shell.uniforms[key], key).toBe(air[key]);
      expect(sector.uniforms[key], key).toBe(air[key]);
    }
    // The lights are on the ground and neither mesh is, so the segment's far
    // end is substituted back down to the surface — the shell's own radius,
    // not the surface archetype's, and the sector holds that same object.
    expect(air.uAirLookupRadius).toBeUndefined(); // per-material, not part of the body's air
    expect(shell.uniforms.uAirLookupRadius.value).toBe(NIGHT_LIGHTS_AIR_LOOKUP_RADIUS);
    expect(sector.uniforms.uAirLookupRadius).toBe(shell.uniforms.uAirLookupRadius);
    // Binding the tables is one write for every mesh that draws lights.
    air.uAirDensity.value = 1;
    expect(sector.uniforms.uAirDensity.value).toBe(1);
    // Transmittance only: adding the in-scatter here would count the night
    // side's airlight twice, once on the globe and once on the lights over it.
    expect(shell.fragmentShader).toContain('lit *= aerialTransmittance(uTransmittance, seg);');
    // The shader's own text, not the function library prepended in front of it.
    expect(earthNightFragmentShader).not.toContain('aerialInscatter');
    // One program: same text, same table dimensions. A sector compiled against
    // a different set would read the same tables at a different stride.
    expect(sector.fragmentShader).toBe(shell.fragmentShader);
    expect(sector.defines).toEqual(shell.defines);
    expect(sector.defines?.SCATTERING_TEXTURE_NU_SIZE).toBeDefined();
  });

  it('shares every shell uniform except the tile and its rectangle', () => {
    // Stated as a subtraction on purpose: a uniform added to the shell has to
    // reach the sectors by default, or the tiles are the one layer a new term
    // misses.
    const shell = shellOn(new THREE.Texture());
    const sector = createEarthNightSectorMaterial(shell, { map: tile(SECTOR_GRID_16K, 4, 2) }, 0);
    expect(Object.keys(sector.uniforms).sort()).toEqual(Object.keys(shell.uniforms).sort());
    const own = ['nightTexture', 'uUvOffset', 'uUvRepeat'];
    for (const key of Object.keys(shell.uniforms)) {
      if (own.includes(key)) expect(sector.uniforms[key], key).not.toBe(shell.uniforms[key]);
      else expect(sector.uniforms[key], key).toBe(shell.uniforms[key]);
    }
  });

  it('writes depth in the transparent pass, which is what suppresses the shell', () => {
    // The shell writes no depth, so a sector that wrote none either would add
    // on top of it and every resident sector would be exactly twice as bright.
    // The sector writes depth at the shell's own radius, pulled one unit
    // nearer per level so the shell's coincident fragments are strictly
    // further and fail the test. `transparent` keeps it out of the opaque
    // list, where a negative renderOrder would draw it before the globe and
    // punch the globe out under it.
    const shell = shellOn(null);
    expect(shell.depthWrite).toBe(false);
    expect(shell.transparent).toBe(true);
    expect(shell.blending).toBe(THREE.AdditiveBlending);
    for (const level of [0, 1, 2]) {
      const sector = createEarthNightSectorMaterial(shell, { map: tile(SECTOR_GRID_16K, 0, 0) }, level);
      expect(sector.depthWrite, `level ${level}`).toBe(true);
      expect(sector.depthTest, `level ${level}`).toBe(true);
      expect(sector.transparent, `level ${level}`).toBe(true);
      expect(sector.blending, `level ${level}`).toBe(THREE.AdditiveBlending);
      expect(sector.polygonOffset, `level ${level}`).toBe(true);
      expect(sector.polygonOffsetFactor, `level ${level}`).toBe(0);
      // One step per level, in the same direction the draw order runs.
      expect(sector.polygonOffsetUnits, `level ${level}`).toBe(sectorRenderOrder(level));
    }
  });

  it('samples the tile through the rectangle the tile was cut on', () => {
    // A hand-written shader gets no mapTransform from three, so the tile's
    // interior has to arrive as uniforms; left on the identity a sector would
    // stretch its tile's western eighth across the whole patch. The rectangle
    // is read off the texture the streamer already transformed, so the two
    // families cannot disagree about where a tile's content is.
    const shell = shellOn(null);
    const grid1 = finerGrid(SECTOR_GRID_16K);
    const map = tile(grid1, 11, 5);
    const sector = createEarthNightSectorMaterial(shell, { map }, 1);
    const want = sectorTileTransform(grid1, { c: 11, r: 5 }, SECTOR_TILE);
    const off = sector.uniforms.uUvOffset.value as THREE.Vector2;
    const rep = sector.uniforms.uUvRepeat.value as THREE.Vector2;
    expect(off.x).toBeCloseTo(want.offsetX, 12);
    expect(off.y).toBeCloseTo(want.offsetY, 12);
    expect(rep.x).toBeCloseTo(want.repeatX, 12);
    expect(rep.y).toBeCloseTo(want.repeatY, 12);
    // A level-1 sector's rectangle is not its level-0 parent's.
    const parent = sectorTileTransform(SECTOR_GRID_16K, { c: 5, r: 2 }, SECTOR_TILE);
    expect(rep.x).not.toBeCloseTo(parent.repeatX, 6);
    // The shell draws the whole equirect.
    expect((shell.uniforms.uUvOffset.value as THREE.Vector2).toArray()).toEqual([0, 0]);
    expect((shell.uniforms.uUvRepeat.value as THREE.Vector2).toArray()).toEqual([1, 1]);
  });

  it('gates on the same night mask the shader draws with', () => {
    // The gate's edge and the shader's are one number: a sector is worth a
    // tile exactly when some pixel of it has a non-zero night mix.
    const family = earthNightSectorFamily(shellOn(null));
    expect(family.side).toBe('night');
    expect(family.lightEdge).toBe(EARTH_NIGHT_MIX_LIT);
    expect(family.weight).toBe(earthNightMix);
    expect(earthNightMix(EARTH_NIGHT_MIX_LIT)).toBe(0);
    expect(earthNightMix(EARTH_NIGHT_MIX_LIT + 0.5)).toBe(0);
    expect(earthNightMix(EARTH_NIGHT_MIX_DARK)).toBe(1);
    expect(earthNightMix(-1)).toBe(1);
    expect(earthNightMix((EARTH_NIGHT_MIX_DARK + EARTH_NIGHT_MIX_LIT) / 2)).toBeCloseTo(0.5, 12);
    // The shader is written from the same two numbers.
    expect(shellOn(null).fragmentShader)
      .toContain(`smoothstep(${EARTH_NIGHT_MIX_DARK.toFixed(1)}, ${EARTH_NIGHT_MIX_LIT.toFixed(1)}, sunDot)`);
  });

  it('fades out what is blue on the map and leaves the lights alone', () => {
    // Black Marble's lights are all warm and everything it draws that is not
    // a light is blue: snow and ice, the background wash, the polar no-data
    // fill. Additive over a dark globe an ice sheet reads as a lit continent
    // and blooms, so the shader keys on the sign of the chroma. These are the
    // means the edges were set from, measured on the shipped 4K map, and the
    // arithmetic is the shader's own line.
    // The shader's line, in counts: smoothstep(-cut, 0, red - blue).
    const keep = (r: number, b: number): number => {
      const t = Math.max(0, Math.min(1, (r - b + EARTH_NIGHT_COLD_CUT) / EARTH_NIGHT_COLD_CUT));
      return t * t * (3 - 2 * t);
    };
    expect(EARTH_NIGHT_COLD_CUT).toBe(12);
    // Patch means as (red, blue); green is not in the key.
    const artefacts: Array<[string, number, number]> = [
      ['Greenland interior (42,48,80)', 41.8, 80.0],
      ['Svalbard (31,35,66)', 30.6, 65.7],
      ['the Himalaya (26,25,48)', 26.0, 48.4],
      ['Norway highlands (20,22,42)', 20.0, 41.9],
      ['the Andes (26,25,49)', 25.6, 49.0],
      ['the Sahara background (35,32,60)', 35, 60],
      ['open ocean (4,5,16)', 4, 16],
    ];
    for (const [where, r, b] of artefacts) expect(keep(r, b), where).toBe(0);
    // Six cities sampled run 160 to 219 in red and 8 to 37 counts warm, so
    // the marginal one is eight counts clear of neutral — and neutral itself
    // is untouched, which is where the margin comes from.
    const lights: Array<[string, number, number]> = [
      ['the warmest-marginal city', 168, 160],
      ['a bright city core', 219, 182],
      ['neutral', 40, 40],
    ];
    for (const [where, r, b] of lights) expect(keep(r, b), where).toBe(1);
    // The one number, in the one place: the cloud deck glows cities through
    // itself from the same map and gates them with the same cut, so a second
    // transcription here would light Greenland's ice on the clouds above it.
    expect(shellOn(null).fragmentShader).toContain(
      `nightColor.rgb *= smoothstep(${(-EARTH_NIGHT_COLD_CUT / 255).toFixed(6)}, 0.0, nightColor.r - nightColor.b);`,
    );
  });

  it('draws the lights warm, in one constant all three consumers read', () => {
    // The look choice, and its counterpart is the cool tint moonlight is drawn
    // in: warm ground lighting under cool moonlit cloud is what a night frame
    // from orbit reads as. Red is held at 1 and the other two come down, so
    // the gain warms the lights without making any channel brighter than the
    // map already draws it.
    expect(EARTH_NIGHT_WARM[0]).toBe(1);
    expect(EARTH_NIGHT_WARM[1]).toBeLessThan(EARTH_NIGHT_WARM[0]);
    expect(EARTH_NIGHT_WARM[2]).toBeLessThan(EARTH_NIGHT_WARM[1]);
    // The literal every shader multiplies by is generated from that constant,
    // so there is nothing to transcribe.
    for (const v of EARTH_NIGHT_WARM) expect(EARTH_NIGHT_WARM_GLSL).toContain(v.toFixed(2));

    // Consumer one: the night-lights shell, after the mix scale and after the
    // chroma gate that tells a light from an ice sheet.
    const shell = shellOn(null);
    expect(shell.fragmentShader).toContain(
      `vec3 lit = nightColor.rgb * nightMix * ${EARTH_NIGHT_MIX_SCALE.toFixed(1)} `
        + `* ${EARTH_NIGHT_WARM_GLSL};`,
    );
    // Consumer two: the night sectors that replace patches of that shell. They
    // are the shell's own program, which is what makes a tile the same colour
    // as the shell it sits in.
    const sector = earthNightSectorFamily(shell)
      .createMaterial({ map: tile(SECTOR_GRID_16K, 3, 1) }, 0) as THREE.ShaderMaterial;
    expect(sector.fragmentShader).toBe(shell.fragmentShader);
    expect(sector.fragmentShader).toContain(EARTH_NIGHT_WARM_GLSL);
    // Consumer three: the glow the cloud deck picks up from the cities under
    // it. A second constant here is how a town ends up one colour through
    // cloud and another beside it.
    const deck = new THREE.MeshStandardMaterial();
    augmentSurfaceMaterial(deck, 'cloud');
    const injected = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n}',
      fragmentShader: '#include <common>\nvoid main() {\n#include <opaque_fragment>\n}',
    };
    (deck.onBeforeCompile as (s: typeof injected) => void)(injected);
    expect(injected.fragmentShader).toContain(`outgoingLight += city * ${EARTH_NIGHT_WARM_GLSL}`);
    // ...and the gate still runs on the map's own chroma, before the tint.
    expect(injected.fragmentShader.indexOf('city.r - city.b'))
      .toBeLessThan(injected.fragmentShader.indexOf(`city * ${EARTH_NIGHT_WARM_GLSL}`));
  });

  it('reads the width of the map the shell is drawing', () => {
    const shell = shellOn(null);
    const family = earthNightSectorFamily(shell);
    expect(family.drawnColorMapWidth()).toBe(0); // nothing readable yet
    shell.uniforms.nightTexture.value = new THREE.Texture(
      { width: 4096, height: 2048 } as unknown as HTMLImageElement,
    );
    expect(family.drawnColorMapWidth()).toBe(4096);
  });
});

describe('the night shell and the globe are one frame', () => {
  // Night sectors carry global equirect uvs and are gated, ranked and cut by
  // directions in the BODY frame — the same directions the day sectors use.
  // That only means the same ground if the shell and the globe turn together,
  // which they do because the body group carries the pole and the spin and
  // neither mesh has a rotation of its own. Nothing else states it, and a
  // rotation added to either mesh would silently slide every night tile off
  // the ground it belongs to.
  const src = (file: string) => readFileSync(resolve(__dirname, file), 'utf8');

  it('puts a point of a night sector over the same ground as the day sector under it', () => {
    const group = new THREE.Group();
    group.quaternion.setFromEuler(new THREE.Euler(0.41, 1.23, -0.7)); // a pole and a spin
    const globe = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 4));
    const shell = new THREE.Mesh(new THREE.SphereGeometry(1.001, 8, 4));
    group.add(globe);
    group.add(shell);
    group.updateMatrixWorld(true);
    const dir = sectorCentreDirection(SECTOR_GRID_16K, { c: 3, r: 1 }, new THREE.Vector3());
    const onGlobe = globe.localToWorld(dir.clone().multiplyScalar(1)).normalize();
    const onShell = shell.localToWorld(dir.clone().multiplyScalar(1.001)).normalize();
    expect(onShell.distanceTo(onGlobe)).toBeLessThan(1e-12);
  });

  it('leaves the spin on the group and neither Earth mesh turning on its own', () => {
    // Read as text because the only place this is decided is a per-frame
    // assignment inside the mode's rebuild, which has no seam to call.
    const factory = src('../PlanetFactory.ts');
    expect(factory).toMatch(/nightMesh = new THREE\.Mesh\(nightGeo, nightMat\);\s*\n\s*group\.add\(nightMesh\);/);
    expect(factory).not.toMatch(/nightMesh\.rotation/);
    const mode = src('../PlanetariumMode.ts');
    expect(mode).toContain('planet.group.quaternion.copy(state.orientationQuaternion);');
    expect(mode).toContain('planet.mesh.rotation.y = 0;');
    expect(mode).not.toMatch(/nightMesh\.rotation/);
  });
});
