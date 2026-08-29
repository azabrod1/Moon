import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { atmosphereFragmentShader, atmosphereVertexShader } from '../../shared/shaders/atmosphere';
import { ATMOSPHERES, createAtmosphereMaterial } from '../PlanetFactory';
import {
  ATMOSPHERE_TABLE_SIZES_FULL,
  ATMOSPHERE_TABLE_SIZES_HALF,
  atmosphereParams,
  singleScatteringRadiance,
} from './atmosphereModel';
import { atmosphereTableDefines } from './atmosphereLut';
import { atmosphereShellRay, createAtmosphereShellMaterial, type Vec3 } from './atmosphereShell';
import { MOON_SHADOW_TRACE_GLSL } from './surfaceShading';

const src = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const EARTH = atmosphereParams('Earth');
const RADIUS_AU = 4.2635e-5; // Earth, near enough — only its ratio to itself matters here

function shell(tier: 'analytic' | 'lut', sizes = ATMOSPHERE_TABLE_SIZES_FULL): THREE.ShaderMaterial {
  return createAtmosphereMaterial(ATMOSPHERES.Earth, RADIUS_AU, tier, {
    lut: { body: 'Earth', sizes },
  });
}

describe('the analytic tier', () => {
  it('is byte-identical to the shader that shipped', () => {
    // The LUT tier is an addition, never an edit: on hardware without tables —
    // ?nofloat=1, a failed probe, a lost context — this text IS the atmosphere,
    // and it must render what it rendered before the tables existed.
    const hash = (glsl: string): string => createHash('sha256').update(glsl).digest('hex');
    expect(hash(atmosphereVertexShader))
      .toBe('76eb59e875b1e1d42fe8c54ac98d25e1a453c2b340a1928bc76597a152e323ad');
    expect(hash(atmosphereFragmentShader))
      .toBe('09fc6242011c090a3ce8ffd14404682ab9ca37db52820d7b69cbd92957c8de36');
  });

  it('is what createAtmosphereMaterial builds when the tier says so', () => {
    const mat = shell('analytic');
    expect(mat.fragmentShader).toBe(atmosphereFragmentShader);
    expect(mat.vertexShader).toBe(atmosphereVertexShader);
    expect(mat.uniforms.uTransmittance).toBeUndefined();
  });

  it('is the tier the volume-compare ghost asks for by name', () => {
    // The ghost is a studio prop at container scale with a fixed key light and
    // no per-frame feed; a table-driven shell would be meaningless there, and
    // ?auto=volumeCompare bakes no tables at all.
    const compare = src('../../volumeCompare/CompareScene.ts');
    const call = /createAtmosphereMaterial\(\s*config,\s*CONTAINER_R,\s*'([a-z]+)'/.exec(compare);
    expect(call?.[1]).toBe('analytic');
  });
});

describe('the LUT shell material', () => {
  it('shares the analytic shell\'s mesh contract, so one mesh can wear either', () => {
    const analytic = shell('analytic');
    const lut = shell('lut');
    expect(lut.side).toBe(analytic.side);
    expect(lut.side).toBe(THREE.BackSide);
    expect(lut.depthWrite).toBe(analytic.depthWrite);
    expect(lut.blending).toBe(analytic.blending);
    expect(lut.transparent).toBe(analytic.transparent);
    // The two uniforms the mode feeds every frame, by name, whichever material
    // the mesh is wearing.
    expect(lut.uniforms.alphaScale.value).toBe(analytic.uniforms.alphaScale.value);
    expect(lut.uniforms.uSunDirWorld.value).toBeInstanceOf(THREE.Vector3);
  });

  it('reuses the tables\' own lookup GLSL rather than a second transcription', () => {
    const lut = shell('lut');
    const lookup = src('./atmosphereLut.ts');
    // Two functions whose conventions cannot be recovered from the textures:
    // the transmittance table holds optical depth, and the packed nu axis is
    // interpolated by hand.
    expect(lookup).toContain('export const ATMOSPHERE_LOOKUP_GLSL');
    expect(lut.fragmentShader).toContain('vec4 getScattering3DRGBA(');
    expect(lut.fragmentShader).toContain('return exp(-getOpticalDepthToTopAtmosphereBoundary');
    expect(lut.fragmentShader).toContain('highp');
  });

  it('compiles to one program for every body on one table profile', () => {
    // What makes the boot warm-up's single probe cover every shell: the shader
    // text and the defines are the whole program key, and neither carries the
    // body or its radius.
    const earth = createAtmosphereShellMaterial({
      planetRadius: RADIUS_AU, body: 'Earth', sizes: ATMOSPHERE_TABLE_SIZES_FULL,
    });
    const mars = createAtmosphereShellMaterial({
      planetRadius: RADIUS_AU * 0.53, body: 'Mars', sizes: ATMOSPHERE_TABLE_SIZES_FULL,
    });
    expect(mars.fragmentShader).toBe(earth.fragmentShader);
    expect(mars.vertexShader).toBe(earth.vertexShader);
    expect(mars.defines).toEqual(earth.defines);
    expect(earth.defines).toEqual(atmosphereTableDefines(ATMOSPHERE_TABLE_SIZES_FULL));
    // The body's own numbers travel as uniform values.
    expect(mars.uniforms.uTopRadius.value).not.toBe(earth.uniforms.uTopRadius.value);
    // A different profile is a different program, which is why the warm-up is
    // handed the session's sizes rather than a default.
    const half = shell('lut', ATMOSPHERE_TABLE_SIZES_HALF);
    expect(half.defines).not.toEqual(earth.defines);
  });

  it('is in the boot warm-up set, on the session\'s own table profile', () => {
    const factory = src('../PlanetFactory.ts');
    expect(factory).toMatch(/createShaderWarmupProbes\(\s*[\s\S]*?lutSizes\?: AtmosphereTableSizes,/);
    expect(factory).toMatch(/if \(lutSizes\) \{\s*\n\s*shell = createAtmosphereMaterial\([^)]*'lut'/);
    const mode = src('../PlanetariumMode.ts');
    expect(mode).toContain('this.atmosphereLut?.probeCapability() ? this.atmosphereLut.sizes : undefined');
  });

  it('traces the eclipse casters with the ground\'s own GLSL', () => {
    const lut = shell('lut');
    expect(lut.fragmentShader).toContain(MOON_SHADOW_TRACE_GLSL);
    expect(lut.fragmentShader).toContain('sunVisible *= 1.0 - moonShadowOcclusion(');
    // The visible-Sun factor has to reach the radiance, not just be computed.
    expect(lut.fragmentShader).toMatch(/radiance \* \(uSolarIrradiance \* uAirlightScale \* sunVisible \* alphaScale\)/);
  });

  it('takes the casters from the body\'s shared shading uniforms', () => {
    const fx = {
      uSunDirWorld: { value: new THREE.Vector3() },
      uSunDirLocal: { value: new THREE.Vector3() },
      uMoonShadow: { value: [new THREE.Vector4(1, 2, 3, 4)] },
      uMoonShadowCount: { value: 2 },
      uPlanetshineColor: { value: new THREE.Color() },
      uPlanetshineDir: { value: new THREE.Vector3() },
      uPlanetshineIntensity: { value: 0 },
      uSilhouette: { value: 0 },
    };
    const mat = createAtmosphereShellMaterial({
      planetRadius: RADIUS_AU, body: 'Earth', sizes: ATMOSPHERE_TABLE_SIZES_FULL, fx,
    });
    // The same objects the mode writes each frame — a copy would drift the
    // eclipse spot on the air away from the one on the ground below it.
    expect(mat.uniforms.uMoonShadow).toBe(fx.uMoonShadow);
    expect(mat.uniforms.uMoonShadowCount).toBe(fx.uMoonShadowCount);
  });
});

describe('the shell and the globe share one frame', () => {
  // The eclipse casters are given in the body frame, and the shell reuses those
  // uniform VALUES rather than a second set — which is only sound while the
  // shell is a sibling of the globe with no rotation of its own.
  it('adds the shell to the globe\'s group and never rotates it', () => {
    const factory = src('../PlanetFactory.ts');
    expect(factory).toContain('group.add(atmosphere);');
    // Nothing anywhere gives the shell a rotation or a quaternion.
    for (const file of ['../PlanetFactory.ts', '../PlanetariumMode.ts']) {
      expect(src(file)).not.toMatch(/atmosphere(Mesh)?\.(rotation|quaternion)/);
    }
  });

  it('holds the globe\'s own spin at identity, where the frames meet', () => {
    // The pole quaternion is on the group; the mesh's local rotation is pinned
    // to zero every frame. Both shells inherit the group, so all three read the
    // same body frame.
    expect(src('../PlanetariumMode.ts')).toContain('planet.mesh.rotation.y = 0;');
  });
});

describe('the view ray', () => {
  // Radius units, Earth: surface 1, air to 1.015679.
  const TOP = EARTH.topRadius;
  const SUN: Vec3 = [1, 0, 0];

  /** A ray from `d` radii out whose closest approach to the centre is `b`,
   *  aimed at the sunlit limb. */
  function grazing(d: number, b: number): { origin: Vec3; view: Vec3 } {
    const sinTheta = b / d;
    const cosTheta = Math.sqrt(1 - sinTheta * sinTheta);
    return { origin: [d, 0, 0], view: [-cosTheta, sinTheta, 0] };
  }

  it('starts at the atmosphere entry point, not at the camera', () => {
    // Both poses aim just over the horizon: the near band from 1.05 R, and the
    // whole-disc limb from 8 R.
    for (const [d, b] of [[1.05, 1.002], [8, 1.008]] as const) {
      const { origin, view } = grazing(d, b);
      const ray = atmosphereShellRay(EARTH, origin, view, SUN);
      expect(ray.reachesAir).toBe(true);
      expect(ray.hitsGround).toBe(false);
      // r is the table's top row exactly...
      expect(ray.r).toBeCloseTo(TOP, 12);
      // ...and mu is re-derived there. Independently: a ray's closest approach
      // is conserved, so at r = TOP the cosine is -sqrt(1 - (b/TOP)^2).
      const muAtEntry = -Math.sqrt(1 - (b / TOP) * (b / TOP));
      expect(ray.mu).toBeCloseTo(muAtEntry, 9);
      // The camera's own cosine is a different number entirely — looking the
      // table up at it is the way this port fails.
      expect(Math.abs(ray.mu - -Math.sqrt(1 - (b / d) * (b / d)))).toBeGreaterThan(0.01);
      expect(ray.entryDistance).toBeCloseTo(
        Math.sqrt(d * d - b * b) - Math.sqrt(TOP * TOP - b * b), 9,
      );
    }
  });

  it('lands within 5% of the reference radiance, where the unshifted ray does not', () => {
    for (const [d, b] of [[1.05, 1.002], [8, 1.008]] as const) {
      const { origin, view } = grazing(d, b);
      const ray = atmosphereShellRay(EARTH, origin, view, SUN);
      // The reference, from an independently derived entry point: advance along
      // the ray by the chord the closest approach gives, and read the angles
      // there without the shader's quadratic.
      const entry = Math.sqrt(d * d - b * b) - Math.sqrt(TOP * TOP - b * b);
      const p: Vec3 = [origin[0] + view[0] * entry, origin[1] + view[1] * entry, 0];
      const mu = -Math.sqrt(1 - (b / TOP) * (b / TOP));
      const muS = (p[0] * SUN[0] + p[1] * SUN[1]) / TOP;
      const nu = view[0] * SUN[0] + view[1] * SUN[1];
      const reference = singleScatteringRadiance(EARTH, TOP, mu, muS, nu, false);
      const shifted = singleScatteringRadiance(EARTH, ray.r, ray.mu, ray.muS, ray.nu, false);
      for (let c = 0; c < 3; c++) {
        expect(Math.abs(shifted[c] - reference[c]) / reference[c]).toBeLessThan(0.05);
      }
      // And what the shift buys: at the camera's own angles the same lookup is
      // not close — this is the whole reason the primary path exists.
      const unshifted = singleScatteringRadiance(
        EARTH, TOP, -Math.sqrt(1 - (b / d) * (b / d)), muS, nu, false,
      );
      expect(Math.abs(unshifted[2] - reference[2]) / reference[2]).toBeGreaterThan(0.05);
    }
  });

  it('draws nothing for a ray that ends on the ground', () => {
    // Straight at the disc centre.
    const ray = atmosphereShellRay(EARTH, [4, 0, 0], [-1, 0, 0], SUN);
    expect(ray.reachesAir).toBe(true);
    expect(ray.hitsGround).toBe(true);
    // A ray tangent to the surface itself counts as one: it ends on the ground,
    // and the mu axis puts it on the last texel of the ground half.
    const tangent = grazing(8, 1);
    expect(atmosphereShellRay(EARTH, tangent.origin, tangent.view, SUN).hitsGround).toBe(true);
    // The airlight in front of a surface belongs to that surface's shading: it
    // needs the segment camera -> fragment, not camera -> far boundary.
    expect(shell('lut').fragmentShader)
      .toContain('if (rayIntersectsGround(r, mu)) return;');
  });

  it('draws nothing outside the physical top, which is where it tapers away', () => {
    // The mesh is 1.02 R; the air ends at 1.015679 R. A ray through the gap
    // crosses the shell and must come back black, or the fringe ends on a wire.
    const gap = grazing(8, (TOP + 1.02) / 2);
    expect(atmosphereShellRay(EARTH, gap.origin, gap.view, SUN).reachesAir).toBe(false);
    // Behind the camera, too.
    expect(atmosphereShellRay(EARTH, [4, 0, 0], [1, 0, 0], SUN).reachesAir).toBe(false);
  });

  it('keeps the camera\'s own radius when it is inside the air', () => {
    // Dev poses only — the camera floor and the landed eye are both above the
    // top — but it is the one branch the primary path must not swallow.
    const inside = 1 + (TOP - 1) * 0.5;
    const ray = atmosphereShellRay(EARTH, [inside, 0, 0], [0, 1, 0], SUN);
    expect(ray.reachesAir).toBe(true);
    expect(ray.entryDistance).toBe(0);
    expect(ray.r).toBeCloseTo(inside, 12);
    expect(ray.mu).toBeCloseTo(0, 12);
  });
});
