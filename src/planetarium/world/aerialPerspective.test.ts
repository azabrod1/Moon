import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { earthNightFragmentShader, earthNightVertexShader } from '../../shared/shaders/atmosphere';
import { ATMOSPHERE_TABLE_SIZES_FULL, atmosphereParams } from './atmosphereModel';
import {
  AERIAL_PERSPECTIVE_GLSL,
  ATMOSPHERE_LOOKUP_BODY_GLSL,
  ATMOSPHERE_LOOKUP_GLSL,
  atmosphereTableDefines,
  type AtmosphereTables,
} from './atmosphereLut';
import { createAtmosphereShellMaterial } from './atmosphereShell';
import {
  augmentSurfaceMaterial,
  bindSurfaceAir,
  clearSurfaceAir,
  type SurfaceArchetype,
} from './surfaceShading';

/**
 * Aerial perspective — the air between the camera and everything drawn in front
 * of it. Three rules this file exists to hold:
 *
 *  1. ONE injected text. Every body takes the same augmentation, air or no air,
 *     and switches on a uniform: a per-body variant forks three's program cache,
 *     which keys on the shader source and the defines, and multiplies the
 *     cold-link count on exactly the devices that can least afford it.
 *  2. Multiplicative layers get `color * T + S`; layers that ADD to what is
 *     already on the screen get `* T` alone. The globe under an additive layer
 *     has already added the in-scattered light, and adding it twice doubles the
 *     whole night side's airlight.
 *  3. The eclipse dims the ground and the air in front of it by the SAME
 *     number, computed once.
 */

const src = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

/** Mimics the subset of three's shader object the hook mutates. */
function compile(mat: THREE.Material): {
  uniforms: Record<string, THREE.IUniform>;
  vertexShader: string;
  fragmentShader: string;
} {
  const shader = {
    uniforms: {} as Record<string, THREE.IUniform>,
    vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n}',
    fragmentShader: '#include <common>\nvoid main() {\n#include <opaque_fragment>\n}',
  };
  (mat.onBeforeCompile as (s: typeof shader) => void)(shader);
  return shader;
}

/** Tables with the right shape for the binder — nothing samples them here. */
function fakeTables(body: string): AtmosphereTables {
  return {
    params: atmosphereParams(body),
    sizes: ATMOSPHERE_TABLE_SIZES_FULL,
    transmittance: new THREE.DataTexture(),
    scattering: new THREE.Data3DTexture(),
    irradiance: new THREE.DataTexture(),
  } as unknown as AtmosphereTables;
}

function augmented(archetype: SurfaceArchetype): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial();
  augmentSurfaceMaterial(mat, archetype);
  return mat;
}

const hash = (glsl: string): string => createHash('sha256').update(glsl).digest('hex');

describe('the injected surface shader', () => {
  it('is one text for every body and both tiers', () => {
    // Earth with air, the Moon without, Mars with its own, and the cloud deck.
    const earth = augmented('earth');
    const moon = augmented('airless');
    const mars = augmented('rocky');
    const cloud = augmented('cloud');
    // And the LUT tier: the same materials with tables bound and the air on.
    const lit = new THREE.MeshStandardMaterial();
    const litFx = augmentSurfaceMaterial(lit, 'earth');
    bindSurfaceAir(litFx.air, fakeTables('Earth'), 4.2635e-5, 1.0);
    expect(litFx.air.uAirDensity.value).toBe(1);

    const texts = [earth, moon, mars, cloud, lit].map((m) => {
      const shader = compile(m);
      return hash(shader.vertexShader + shader.fragmentShader);
    });
    expect(new Set(texts).size).toBe(1);
    // The defines are the other half of three's program key.
    for (const m of [moon, mars, cloud, lit]) expect(m.defines).toEqual(earth.defines);
    expect(earth.defines).toMatchObject(atmosphereTableDefines(ATMOSPHERE_TABLE_SIZES_FULL));
  });

  it('is the text the goldens were captured through', () => {
    // The pinned radiances beside the captures only move when someone re-runs
    // the capture tool, so on their own they let a shader edit through until
    // then. This fails on the edit itself, and the two together mean the only
    // diff that lands green moves the shader, the captures and the pins.
    const shader = compile(augmented('earth'));
    expect(hash(shader.vertexShader))
      .toBe('d8e0588d27a55998fe129e3d7fda9d9e568465f9b51f04ba76d68dd2964bf05b');
    expect(hash(shader.fragmentShader))
      .toBe('6db5b3802f0510c66963e547d73b22375edc8ea2783d2db4b948f18cce143aa2');
  });

  it('reuses the tables\' own lookup GLSL rather than a second transcription', () => {
    const shader = compile(augmented('earth'));
    expect(shader.fragmentShader).toContain(ATMOSPHERE_LOOKUP_BODY_GLSL);
    expect(shader.fragmentShader).toContain(AERIAL_PERSPECTIVE_GLSL);
    // And it takes the body, not the header: three writes its own precision
    // block and <common> defines PI, so the standalone form would redefine both
    // in the middle of a shader.
    expect(ATMOSPHERE_LOOKUP_GLSL).toContain(ATMOSPHERE_LOOKUP_BODY_GLSL);
    expect(ATMOSPHERE_LOOKUP_BODY_GLSL).not.toContain('#define PI');
    expect(ATMOSPHERE_LOOKUP_BODY_GLSL).not.toContain('precision highp');
    expect(shader.fragmentShader).not.toContain('#define PI');
  });

  it('leaves no sampler for the renderer to fill, on a body with no air at all', () => {
    const fx = augmentSurfaceMaterial(new THREE.MeshStandardMaterial(), 'airless');
    expect(fx.air.uAirDensity.value).toBe(0);
    // 1x1 stand-ins, and a Data3DTexture in particular: there is no other 3D
    // texture in the app, so an unbound sampler3D would be the first place a
    // driver had to invent one.
    const scattering = fx.air.uScattering.value as THREE.Data3DTexture;
    expect(scattering).toBeInstanceOf(THREE.Data3DTexture);
    expect(scattering.image.width).toBe(1);
    expect(scattering.image.height).toBe(1);
    expect(scattering.image.depth).toBe(1);
    expect(scattering.magFilter).toBe(THREE.LinearFilter);
    expect(fx.air.uTransmittance.value).toBeInstanceOf(THREE.DataTexture);
    expect(fx.air.uIrradiance.value).toBeInstanceOf(THREE.DataTexture);
    // Every one of them reaches the shader.
    const uniforms = compile(augmented('airless')).uniforms;
    for (const key of Object.keys(fx.air)) expect(uniforms[key], key).toBeDefined();
  });

  it('lets go of a body\'s tables when the tier does', () => {
    const fx = augmentSurfaceMaterial(new THREE.MeshStandardMaterial(), 'earth');
    const tables = fakeTables('Earth');
    bindSurfaceAir(fx.air, tables, 4.2635e-5, 0.97);
    expect(fx.air.uScattering.value).toBe(tables.scattering);
    expect(fx.air.uSolarIrradiance.value).toBeCloseTo(0.97, 12);
    // A lost context frees the tables' textures; a sampler still pointed at one
    // is a bind of a dead name every frame until the re-bake lands.
    clearSurfaceAir(fx.air);
    expect(fx.air.uAirDensity.value).toBe(0);
    expect(fx.air.uScattering.value).not.toBe(tables.scattering);
    expect(fx.air.uTransmittance.value).not.toBe(tables.transmittance);
  });
});

describe('the layer rule', () => {
  // Every layer that draws over a body's surface, and what the air does to it.
  // A multiplicative layer is seen THROUGH the air and has the air's own light
  // in front of it; an additive layer is only seen through it, because whatever
  // it sits on has already added that light.
  const LAYERS: {
    name: string;
    blend: 'multiplicative' | 'additive';
    glsl: () => string;
  }[] = [
    { name: 'globe and its sectors', blend: 'multiplicative', glsl: () => compile(augmented('earth')).fragmentShader },
    { name: 'cloud deck', blend: 'multiplicative', glsl: () => compile(augmented('cloud')).fragmentShader },
    { name: 'night lights', blend: 'additive', glsl: () => earthNightFragmentShader },
  ];

  for (const layer of LAYERS) {
    it(`${layer.name} (${layer.blend}) applies the rule`, () => {
      const glsl = layer.glsl();
      expect(glsl).toContain('aerialTransmittance(uTransmittance');
      if (layer.blend === 'multiplicative') {
        expect(glsl).toContain('aerialInscatter(uScattering');
      } else {
        expect(glsl).not.toContain('aerialInscatter(uScattering');
      }
    });
  }

  it('applies color * T + S exactly once, scaled into the scene\'s own light', () => {
    const glsl = compile(augmented('earth')).fragmentShader;
    expect(glsl).toMatch(
      /outgoingLight = outgoingLight \* airT\s*\n\s*\+ airS \* uAirlightScale \* \(uSolarIrradiance \* sunVisible\);/,
    );
    expect(glsl.match(/aerialInscatter\(uScattering/g)).toHaveLength(1);
  });

  it('leaves the shell out of it: its radiance IS the whole sky segment', () => {
    // The shell draws only rays that miss every surface, so there is nothing in
    // front of it to attenuate and nothing behind it to add to.
    const shell = createAtmosphereShellMaterial({
      planetRadius: 4.2635e-5, body: 'Earth', sizes: ATMOSPHERE_TABLE_SIZES_FULL,
    });
    expect(shell.fragmentShader).not.toContain('aerialTransmittance(');
    expect(shell.fragmentShader).not.toContain('aerialInscatter(');
    expect(shell.fragmentShader).not.toContain(AERIAL_PERSPECTIVE_GLSL);
  });
});

describe('the eclipse on the ground and on the air', () => {
  it('dims both by one number, traced once', () => {
    const glsl = compile(augmented('earth')).fragmentShader;
    // One accumulation over the casters...
    expect(glsl).toContain('sunVisible *= 1.0 - occ * dayFactor;');
    expect(glsl.match(/moonShadowOcclusion\(uMoonShadow\[i\]/g)).toHaveLength(1);
    // ...applied to the light leaving the surface AND to the light the air in
    // front of it sends. Two expressions of one eclipse drift apart, and the way
    // that shows is a spot on the haze beside the spot on the ground.
    expect(glsl).toContain('outgoingLight *= sunVisible;');
    expect(glsl).toContain('uSolarIrradiance * sunVisible');
  });

  it('gives the cloud deck the casters it never had, in the body\'s frame', () => {
    const factory = src('../PlanetFactory.ts');
    // The deck shares the globe's fx — the same caster values, not a second set.
    expect(factory).toContain("augmentSurfaceMaterial(cloudMat, 'cloud', ringShadow, sunTan, fx);");
    // Its mesh carries a drift of its own on top of the body's spin, and the
    // shading has to be told, or the spot lands at a longitude of its own.
    expect(src('../PlanetariumMode.ts')).toContain('cloudArgs.uFrameSpin.value = cloudDrift;');
    const glsl = compile(augmented('cloud')).vertexShader;
    expect(glsl).toContain('if (uFrameSpin == 0.0) {');
    expect(glsl).toContain('vObjPos = position;');
  });
});

describe('the cloud deck', () => {
  it('is not premultiplied, and the composite is why', () => {
    // a(T_c C + S_c) + (1-a)(T_g G + S_g): the airlight is counted exactly once
    // per pixel, with the short path on the fraction that stops at the deck and
    // the full path on the fraction that reaches the ground. Premultiply the
    // alpha and the in-scatter is silently scaled by the cloud fraction.
    expect(new THREE.MeshStandardMaterial().premultipliedAlpha).toBe(false);
    const factory = src('../PlanetFactory.ts');
    const cloudBlock = factory.slice(
      factory.indexOf('const cloudMat = new THREE.MeshStandardMaterial({'),
      factory.indexOf('cloudsMesh = new THREE.Mesh(cloudGeo, cloudMat);'),
    );
    expect(cloudBlock).not.toBe('');
    expect(cloudBlock).not.toContain('premultipliedAlpha');
    expect(cloudBlock).toContain('opacity: 0.35');
    // And the deck carries none of the ground's own night terms: the globe
    // shows through it, so a second starlight floor or limb darkening there
    // would count the same thing twice.
    const surface = src('./surfaceShading.ts');
    expect(surface).toMatch(/cloud:\s*\{ color: 0x000000, strength: 0\.0/);
    expect(surface).toMatch(/cloud:\s*0\.0,/);
  });
});

describe('the night-lights shell', () => {
  it('reads the body\'s own air, through the same uniform objects', () => {
    const factory = src('../PlanetFactory.ts');
    expect(factory).toContain('...fx.air,');
    // The standalone lookup form: a ShaderMaterial gets no <common> chunk, so
    // it needs the precision block and PI the surface hook must NOT repeat.
    expect(factory).toContain(
      'ATMOSPHERE_LOOKUP_GLSL + AERIAL_PERSPECTIVE_GLSL + earthNightFragmentShader',
    );
    expect(factory).toContain('defines: atmosphereTableDefines(atmosphereSessionSizes())');
  });

  it('hands the air the same frame-free geometry the surfaces use', () => {
    for (const glsl of [earthNightVertexShader, compile(augmented('earth')).vertexShader]) {
      expect(glsl).toContain('vAirCam = cameraPosition - modelMatrix[3].xyz;');
      expect(glsl).toContain('vAirFrag = mat3(modelMatrix) * position;');
    }
  });

  it('is off, and unchanged, wherever there are no tables', () => {
    expect(earthNightFragmentShader).toContain('if (uAirDensity > 0.0) {');
    // The pre-air line, untouched: with the switch at 0 the fallback device
    // renders what it always did.
    expect(earthNightFragmentShader).toContain('vec3 lit = nightColor.rgb * nightMix * 1.5;');
  });
});
