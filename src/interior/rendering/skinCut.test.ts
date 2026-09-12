/**
 * The raw-shader cuts splice into two shaders they do not own by text: the
 * analytic atmosphere shell's and the Sun's photosphere's. applyRawShaderCut
 * throws when a seam is gone, which at runtime is a body swap that never
 * finishes; this test performs both splices on the materials the studio
 * builds, so a shader that changes shape fails here instead.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ATMOSPHERES, createAtmosphereMaterial } from '../../planetarium/PlanetFactory';
import { SUN_ATMOSPHERE_TINT_RGB, sunPhotosphereFragmentShader, sunPhotosphereVertexShader } from '../../shared/shaders/sun';
import { applyAtmosphereCut, applyPhotosphereCut, applyRawShaderCut, createSkinCutUniforms } from './skinCut';

const interiorSceneSource = readFileSync(fileURLToPath(new URL('../InteriorScene.ts', import.meta.url)), 'utf8');

describe('the raw-shader cuts', () => {
  it('splice into the analytic atmosphere shell the studio builds', () => {
    const uniforms = createSkinCutUniforms();
    const material = createAtmosphereMaterial(ATMOSPHERES.Earth, 1, 'analytic', { initialAlpha: 0.7, initialSunDir: new THREE.Vector3(0, 0, 1) });
    expect(() => applyAtmosphereCut(material, uniforms)).not.toThrow();
    expect(material.fragmentShader).toContain('gl_FragColor = vec4(radiance * interiorCutCoverage, 1.0);');
    expect(material.fragmentShader).toContain('uniform float uCutHalfAngle;');
    // The far-side reflection: the shell is drawn from its back, so the test is on the screen position covered.
    expect(material.fragmentShader).toContain('if (cutAlong < 0.0) cutDirection -= 2.0 * cutAlong * uCutView;');
    expect(material.uniforms.uCutHalfAngle).toBe(uniforms.uCutHalfAngle);
    expect(material.uniforms.uCutView).toBe(uniforms.uCutView);
    expect(material.version).toBeGreaterThan(0); // needsUpdate was set: the spliced text compiles afresh
  });

  it("splice into the Sun's photosphere as the studio builds it", () => {
    const uniforms = createSkinCutUniforms();
    const material = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        uAtmosphereMix: { value: 0 },
        uAtmosphereColor: { value: new THREE.Color(...SUN_ATMOSPHERE_TINT_RGB) },
        uInteriorFade: { value: 1 },
        uWhiteout: { value: 0 },
      },
      vertexShader: sunPhotosphereVertexShader,
      fragmentShader: sunPhotosphereFragmentShader,
    });
    expect(() => applyPhotosphereCut(material, uniforms, 0.5)).not.toThrow();
    expect(material.fragmentShader).toContain('gl_FragColor = vec4(color * radiance * 0.500, interiorCutCoverage);');
    expect(material.vertexShader).toContain('vInteriorCutWorld = (modelMatrix * vec4(position, 1.0)).xyz;');
    expect(material.fragmentShader).toContain('varying vec3 vInteriorCutWorld;');
    expect(material.uniforms.uCutSide).toBe(uniforms.uCutSide);
  });

  it('refuse a shader that changed shape rather than shipping it uncut', () => {
    const uniforms = createSkinCutUniforms();
    const missingOutput = new THREE.ShaderMaterial({ vertexShader: 'void main() { gl_Position = vec4(0.0); }', fragmentShader: 'void main() { gl_FragColor = vec4(1.0); }' });
    expect(() => applyRawShaderCut(missingOutput, uniforms, {
      vertexVarying: true,
      direction: 'vInteriorCutWorld',
      output: { find: 'gl_FragColor = vec4(radiance, 1.0);', replace: 'x' },
      reflectFarSide: false,
    })).toThrow('changed shape');
    const missingMain = new THREE.ShaderMaterial({ vertexShader: 'void main(){}', fragmentShader: 'void main() { gl_FragColor = vec4(1.0); }' });
    expect(() => applyRawShaderCut(missingMain, uniforms, {
      vertexVarying: true,
      direction: 'vInteriorCutWorld',
      output: { find: 'gl_FragColor = vec4(1.0);', replace: 'x' },
      reflectFarSide: false,
    })).toThrow('vertex shader changed shape');
  });

  it('are applied to the analytic tier, which InteriorScene asks for by name', () => {
    // The studio's air is a prop lit by the key: the analytic shell is the one the cut is written for.
    const call = /createAtmosphereMaterial\(\s*atmosphere,\s*BODY_RADIUS,\s*'([a-z]+)'/.exec(interiorSceneSource);
    expect(call?.[1]).toBe('analytic');
    expect(interiorSceneSource).toContain('applyAtmosphereCut(material, this.cutUniforms);');
    expect(interiorSceneSource).toContain('applyPhotosphereCut(material, this.cutUniforms, SUN_STUDIO_EXPOSURE);');
  });
});
