import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { earthNightFragmentShader, earthNightVertexShader } from '../../shared/shaders/atmosphere';
import {
  ATMOSPHERE_TABLE_SIZES_FULL,
  atmosphereParams,
  profileDensity,
  transmittanceOverSegment,
  type AtmosphereParams,
  type RGB,
} from './atmosphereModel';
import {
  AERIAL_PERSPECTIVE_GLSL,
  ATMOSPHERE_LOOKUP_BODY_GLSL,
  ATMOSPHERE_LOOKUP_GLSL,
  aerialSegmentRay,
  atmosphereTableDefines,
  type AtmosphereTables,
} from './atmosphereLut';
import { createAtmosphereShellMaterial } from './atmosphereShell';
import { PLANETS } from '../planets/planetData';
import { MOONS } from '../planets/moonData';
import { KM_PER_AU } from '../../astronomy/constants';
import {
  AIR_LOOKUP_RADIUS,
  NIGHT_LIGHTS_AIR_LOOKUP_RADIUS,
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
    fragmentShader: '#include <common>\nvoid main() {\n#include <normal_fragment_maps>\n#include <opaque_fragment>\n}',
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
      .toBe('862f7224fafb480070aebf0c7c125dddbd78c879780eb072e96988333154322a');
    expect(hash(shader.fragmentShader))
      .toBe('3a8019f4e5528686cce48f75a03cde664d34ced867ba3e1abb81410abb3d063d');
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
      /vec3 airS = aerialInscatter\(uScattering, seg, airT\)\s*\n\s*\* uAirlightScale \* \(uSolarIrradiance \* sunVisible\);/,
    );
    expect(glsl).toContain('outgoingLight = outgoingLight * airT + airS;');
    // Two in-scatter lookups, and they are the two SOURCES — one traversal,
    // the Sun's angles and the Moon's. A third would be a second traversal.
    expect(glsl.match(/aerialInscatter\(uScattering/g)).toHaveLength(2);
    expect(glsl).toContain('aerialForLight(seg, normalize(uMoonDirWorld))');
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

  it('lets a moon whose umbra only reaches near perigee be a caster at all', () => {
    // A caster's umbra reaches the surface when the moon is wider than the
    // shadow cone has converged over the distance it stands off — radius >
    // distance x the Sun's angular radius there. Earth's Moon fails that at its
    // MEAN distance and passes it well before perigee, which is what a total
    // solar eclipse IS. So the candidate set has to ORDER on the mean rather
    // than reject on it, or the one eclipse anybody would go and look at casts
    // no shadow on the ground and none on the air in front of it.
    const sunAngularRadius = (695_700 / KM_PER_AU) / 1.0149;   // Earth in early August
    const moon = MOONS.find((m) => m.name === 'Moon')!;
    const reachLimitKm = (moon.radiusAU / sunAngularRadius) * KM_PER_AU;
    expect(reachLimitKm).toBeLessThan(384_400);      // not at the mean distance
    expect(reachLimitKm).toBeGreaterThan(356_500);   // comfortably so at perigee
    const mode = src('../PlanetariumMode.ts');
    const casterBlock = mode.slice(
      mode.indexOf('const reachesAtMeanDistance'),
      mode.indexOf('this.moonShadowCasterCache.set'),
    );
    expect(casterBlock).not.toBe('');
    expect(casterBlock).toContain('reachesAtMeanDistance(b)');
    expect(casterBlock).not.toMatch(/\.filter\([^)]*reachesAtMeanDistance/);
    // And the live per-frame check, which is what actually admits one, still
    // measures the distance the moon is at right now.
    expect(mode).toContain('&& m.data.radiusAU > offset.length() * sunTanAtParent');
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
    // ...and its alpha is the coverage its own map states, not a flat fraction:
    // a constant here dims clear sky by it everywhere and caps the thickest
    // cloud at it, which is the wash the deck used to be.
    expect(cloudBlock).toContain('opacity: 1,');
    expect(cloudBlock).not.toMatch(/opacity: 0\.\d/);
    // And the deck carries none of the ground's own night terms: the globe
    // shows through it, so a second starlight floor or limb darkening there
    // would count the same thing twice.
    const surface = src('./surfaceShading.ts');
    expect(surface).toMatch(/cloud:\s*\{ color: 0x000000, strength: 0\.0/);
    expect(surface).toMatch(/cloud:\s*0\.0,/);
  });
});

describe('the segment, against the reference integral', () => {
  // aerialSegment is the third transcription of the entry-point shift and the
  // only one that also carries a LENGTH: the tables hold whole paths from a
  // point to the far boundary, so a segment is a difference of two of them and
  // its length is the only thing that says which difference. A sha of the
  // injected text catches an edit; it does not catch a WRONG edit, and neither
  // does a re-recorded capture. This does: the mirror's coordinates are fed to
  // the module's own reference integral and held against a brute-force
  // integration along the SAME segment in 3D, which shares no geometry code
  // with it at all.
  const params = atmosphereParams('Earth');
  type Point = readonly [number, number, number];

  /** Optical depth along the straight line from `camera` to `point`, summed in
   *  3D and truncated at the modelled top exactly as the model is. Nothing here
   *  knows about entry points, mu, or the folded axis. */
  function opticalDepthAlongLine(camera: Point, point: Point, samples = 200000): RGB {
    const step: Point = [point[0] - camera[0], point[1] - camera[1], point[2] - camera[2]];
    const length = Math.hypot(step[0], step[1], step[2]);
    let rayleigh = 0;
    let mie = 0;
    let ozone = 0;
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const radius = Math.hypot(
        camera[0] + step[0] * t, camera[1] + step[1] * t, camera[2] + step[2] * t,
      );
      if (radius > params.topRadius) continue;   // above the model there is no air
      const altitude = radius - params.bottomRadius;
      const weight = i === 0 || i === samples ? 0.5 : 1;
      rayleigh += profileDensity(params.rayleighDensity, altitude) * weight;
      mie += profileDensity(params.mieDensity, altitude) * weight;
      ozone += profileDensity(params.absorptionDensity, altitude) * weight;
    }
    const dx = length / samples;
    return [0, 1, 2].map((c) => dx * (
      params.rayleighScattering[c] * rayleigh
      + params.mieExtinction[c] * mie
      + params.absorptionExtinction[c] * ozone
    )) as unknown as RGB;
  }

  /** What the shader's coordinates say the segment's optical depth is. */
  function opticalDepthFromSegment(
    p: AtmosphereParams, camera: Point, point: Point,
  ): { tau: RGB; transmittance: RGB } {
    const seg = aerialSegmentRay(p, camera, point, [1, 0, 0]);
    expect(seg.valid).toBe(true);
    const transmittance = transmittanceOverSegment(p, seg.r, seg.mu, seg.d);
    return { tau: transmittance.map((t) => -Math.log(t)) as unknown as RGB, transmittance };
  }

  // Straight down at the ISS's altitude, and the same stand point looking along
  // the ground to a point 17.5 degrees away — the two poses the goldens capture
  // and the two regimes the segment has: one airmass and about twenty.
  const CAMERA: Point = [1.05, 0, 0];
  const OBLIQUE = (17.5 * Math.PI) / 180;
  const POSES: { name: string; point: Point }[] = [
    { name: 'nadir', point: [1, 0, 0] },
    { name: 'along the ground, 17.5 degrees away', point: [Math.cos(OBLIQUE), Math.sin(OBLIQUE), 0] },
  ];

  for (const pose of POSES) {
    it(`agrees with a 3D integration of the same line (${pose.name})`, () => {
      const mine = opticalDepthFromSegment(params, CAMERA, pose.point);
      const reference = opticalDepthAlongLine(CAMERA, pose.point);
      for (let c = 0; c < 3; c++) {
        expect(reference[c]).toBeGreaterThan(0.01);   // a pose with no air proves nothing
        expect(
          Math.abs(mine.tau[c] - reference[c]) / reference[c],
          `${pose.name} ${'rgb'[c]}: tau ${mine.tau[c]} vs ${reference[c]}`,
        ).toBeLessThan(0.05);
      }
    });
  }

  it('ends at the fragment, not at the ground under it', () => {
    // The segment is geometric, never a ray-vs-ground solve: a point held above
    // the surface has to come back with the shorter path, or every raised layer
    // is hazed as though it sat on the ground.
    const ground = opticalDepthFromSegment(params, CAMERA, [1, 0, 0]);
    const raised = opticalDepthFromSegment(params, CAMERA, [1.005, 0, 0]);
    for (let c = 0; c < 3; c++) expect(raised.tau[c]).toBeLessThan(ground.tau[c]);
  });

  it('returns nothing for a ray that never reaches the air', () => {
    // Both rejects, and neither may return a NaN: an invalid segment is how a
    // fragment outside the tables' domain gets no air rather than a speckle.
    const missesEntirely = aerialSegmentRay(params, [8, 0, 0], [8, 1, 0], [1, 0, 0]);
    expect(missesEntirely.valid).toBe(false);
    const zeroLength = aerialSegmentRay(params, [1.05, 0, 0], [1.05, 0, 0], [1, 0, 0]);
    expect(zeroLength.valid).toBe(false);
  });
});

describe('where the cloud deck looks its air up', () => {
  const params = atmosphereParams('Earth');
  const CAMERA = [1.05, 0, 0] as const;

  it('is a physical cloud top, not the mesh radius', () => {
    // 10 km up. The mesh is at 1.01 R because up close the deck owns the
    // silhouette, and 1.01 R is 64 km — above the whole air.
    const earthRadiusKm = PLANETS.find((p) => p.name === 'Earth')!.radiusKm;
    expect((AIR_LOOKUP_RADIUS.cloud - 1) * earthRadiusKm).toBeCloseTo(10, 9);
    expect((1.01 - 1) * earthRadiusKm).toBeGreaterThan(60);
    expect(AIR_LOOKUP_RADIUS.cloud).toBeLessThan(params.topRadius);
    expect(AIR_LOOKUP_RADIUS.cloud).toBeGreaterThan(params.bottomRadius);
    // Every other surface ends its segment at its own fragment.
    for (const archetype of ['airless', 'rocky', 'gas', 'icy', 'earth'] as const) {
      expect(AIR_LOOKUP_RADIUS[archetype], archetype).toBe(0);
    }
  });

  it('is the difference between no air at all and the haze band', () => {
    // The mesh radius makes `x T + S` a no-op, and the deck's own 0.35 alpha
    // then takes 35 % of the ground's airlight off every pixel it covers.
    const at = (radius: number, angleDeg: number): RGB => {
      const a = (angleDeg * Math.PI) / 180;
      const seg = aerialSegmentRay(
        params, CAMERA, [radius * Math.cos(a), radius * Math.sin(a), 0], [1, 0, 0],
      );
      expect(seg.valid).toBe(true);
      return transmittanceOverSegment(params, seg.r, seg.mu, seg.d);
    };
    // Straight down: the mesh sees no air; the cloud top sees about a quarter
    // of the ground's column.
    expect(at(1.01, 0)[2]).toBeGreaterThan(0.999);
    expect(at(AIR_LOOKUP_RADIUS.cloud, 0)[2]).toBeLessThan(0.94);
    // And along the ground, which is the band this exists for: the deck at its
    // mesh radius keeps essentially all its contrast where a photograph has
    // none left.
    expect(at(1.01, 17.5)[2]).toBeGreaterThan(0.99);
    expect(at(AIR_LOOKUP_RADIUS.cloud, 17.5)[2]).toBeLessThan(0.1);
  });

  it('substitutes the radius and leaves the direction alone', () => {
    const glsl = compile(augmented('cloud')).fragmentShader;
    expect(glsl).toContain('vec3 airEnd = uAirLookupRadius > 0.0');
    expect(glsl).toContain('? normalize(vAirFrag) * uAirLookupRadius');
    expect(glsl).toContain(': vAirFrag / uPlanetRadius;');
    // One text for every surface: the deck differs by the uniform's value only.
    expect(compile(augmented('earth')).fragmentShader).toBe(glsl);
    const uniforms = compile(augmented('cloud')).uniforms;
    expect(uniforms.uAirLookupRadius.value).toBe(AIR_LOOKUP_RADIUS.cloud);
    expect(compile(augmented('earth')).uniforms.uAirLookupRadius.value).toBe(0);
  });
});

describe('the night-lights shell', () => {
  it('reads the body\'s own air, through the same uniform objects', () => {
    // The shell is built by the factory the night SECTORS come out of, so the
    // air reaches every mesh that draws lights and not the shell alone.
    expect(src('../PlanetFactory.ts')).toContain(
      'createEarthNightShellMaterial(nightTex, fx.air)',
    );
    const nightMat = src('./earthNightMaterial.ts');
    expect(nightMat).toContain('...air,');
    // The standalone lookup form: a ShaderMaterial gets no <common> chunk, so
    // it needs the precision block and PI the surface hook must NOT repeat.
    expect(nightMat).toContain(
      'ATMOSPHERE_LOOKUP_GLSL + AERIAL_PERSPECTIVE_GLSL + earthNightFragmentShader',
    );
    expect(nightMat).toContain('atmosphereTableDefines(atmosphereSessionSizes())');
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

  it('looks its air up at the ground the lights are painted on', () => {
    // The mesh floats above the globe so it never z-fights it. At Earth's 8 km
    // Rayleigh scale height that clearance is more than half the column by
    // mass, so the segment's far end is substituted back down to the surface —
    // the same uniform the cloud deck moves the other way.
    expect(NIGHT_LIGHTS_AIR_LOOKUP_RADIUS).toBe(1);
    expect(earthNightFragmentShader).toContain(
      'normalize(vAirFrag) * uAirLookupRadius, normalize(sunDirection));',
    );
    expect(earthNightFragmentShader).toContain('uniform float uAirLookupRadius;');
    expect(src('./earthNightMaterial.ts')).toContain(
      'uAirLookupRadius: { value: NIGHT_LIGHTS_AIR_LOOKUP_RADIUS },',
    );
    // And the mesh really is off the ground, or none of this would matter.
    expect(src('../PlanetFactory.ts')).toContain('const EARTH_NIGHT_SHELL_SCALE = 1.001;');
  });

  it('is most of the air, which is why the substitution is worth making', () => {
    const params = atmosphereParams('Earth');
    const at = (radius: number, angleDeg: number): RGB => {
      const a = (angleDeg * Math.PI) / 180;
      const seg = aerialSegmentRay(
        params, [1.05, 0, 0], [radius * Math.cos(a), radius * Math.sin(a), 0], [1, 0, 0],
      );
      expect(seg.valid).toBe(true);
      return transmittanceOverSegment(params, seg.r, seg.mu, seg.d);
    };
    // Straight down the mesh's own radius keeps a fifth of the blue the ground
    // loses; along the ground, which is where a city at the limb is seen, it
    // keeps eight times as much light as the ground under it does.
    expect(at(1.001, 0)[2] / at(NIGHT_LIGHTS_AIR_LOOKUP_RADIUS, 0)[2]).toBeGreaterThan(1.15);
    expect(at(1.001, 17.5)[2] / at(NIGHT_LIGHTS_AIR_LOOKUP_RADIUS, 17.5)[2]).toBeGreaterThan(5);
  });
});
