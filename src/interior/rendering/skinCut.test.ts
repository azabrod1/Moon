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
import { computeCutFrame, cutFaceBasis, insideWedge } from '../cutFrame';
import { SKIN_CUT_FRAGMENT_TEXT, applyAtmosphereCut, applyPhotosphereCut, applyRawShaderCut, createSkinCutUniforms } from './skinCut';

const interiorSceneSource = readFileSync(fileURLToPath(new URL('../InteriorScene.ts', import.meta.url)), 'utf8');

describe('the raw-shader cuts', () => {
  it('splice into the analytic atmosphere shell the studio builds', () => {
    const uniforms = createSkinCutUniforms();
    const material = createAtmosphereMaterial(ATMOSPHERES.Earth, 1, 'analytic', { initialAlpha: 0.7, initialSunDir: new THREE.Vector3(0, 0, 1) });
    expect(() => applyAtmosphereCut(material, uniforms)).not.toThrow();
    expect(material.fragmentShader).toContain('gl_FragColor = vec4(radiance * interiorCutCoverage, 1.0);');
    expect(material.fragmentShader).toContain('uniform float uCutHalfAngle;');
    // The far-side reflection: the shell is drawn from its back, so the test is on the screen
    // position covered — through the plane facing the camera this frame, not the wedge's axis.
    expect(material.fragmentShader).toContain('if (cutAlong < 0.0) cutOffset -= 2.0 * cutAlong * uCutCamera;');
    // The wedge is the pair of half-spaces its faces bound: outside by the distance to the nearer plane.
    expect(material.fragmentShader).toContain('float cutSigned = -min(dot(cutOffset, uCutNormalA), dot(cutOffset, uCutNormalB));');
    expect(material.uniforms.uCutHalfAngle).toBe(uniforms.uCutHalfAngle);
    expect(material.uniforms.uCutNormalA).toBe(uniforms.uCutNormalA);
    expect(material.uniforms.uCutCamera).toBe(uniforms.uCutCamera);
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
    expect(material.fragmentShader).toContain('vec3 studioColor = mix(color, vec3(1.000, 0.600, 0.220), 0.000);');
    expect(material.fragmentShader).toContain('gl_FragColor = vec4(studioColor * (radiance * 0.500 + 0.000 * limbDarkening), interiorCutCoverage);');
    expect(material.vertexShader).toContain('vInteriorCutWorld = (modelMatrix * vec4(position, 1.0)).xyz;');
    expect(material.fragmentShader).toContain('varying vec3 vInteriorCutWorld;');
    expect(material.uniforms.uCutNormalB).toBe(uniforms.uCutNormalB);
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
    // The corona passes its scale as the disc gate; the planets' air passes nothing.
    expect(interiorSceneSource).toContain('applyAtmosphereCut(material, this.cutUniforms, body.sun ? atmosphere.scale : undefined);');
    expect(interiorSceneSource).toContain('applyPhotosphereCut(material, this.cutUniforms, SUN_STUDIO_EXPOSURE, SUN_STUDIO_LIFT, SUN_STUDIO_TINT);');
    // The rings take the same cut, on the standard-material path.
    expect(interiorSceneSource).toContain('applySkinCut(mesh.material as THREE.MeshStandardMaterial, this.cutUniforms);');
  });

  it("pin the skin's own discard: the plane pair, inverted for the ghost, and the feather in alpha", () => {
    // The standard-material path — the skin, the rings — carries its own copy of the test; a change there must come here.
    expect(SKIN_CUT_FRAGMENT_TEXT).toContain('return -min(dot(offset, uCutNormalA), dot(offset, uCutNormalB));');
    expect(SKIN_CUT_FRAGMENT_TEXT).toContain('float cutSigned = interiorCutOutside(vInteriorCutWorld) * (1.0 - 2.0 * uCutInvert);');
    expect(SKIN_CUT_FRAGMENT_TEXT).toContain('? clamp(cutSigned / cutWidth + 0.5, 0.0, 1.0)');
    expect(SKIN_CUT_FRAGMENT_TEXT).toContain(': step(0.0, cutSigned);');
    expect(SKIN_CUT_FRAGMENT_TEXT).toContain('diffuseColor.a *= interiorCutCoverage;');
  });

  it("gate a halo on the coverage, after the feather, so the gate's step is never the width the feather measures", () => {
    const uniforms = createSkinCutUniforms();
    const material = createAtmosphereMaterial(ATMOSPHERES.Earth, 1, 'analytic', { initialAlpha: 0.7, initialSunDir: new THREE.Vector3(0, 0, 1) });
    applyAtmosphereCut(material, uniforms, 1.3);
    const text = material.fragmentShader;
    const feather = text.indexOf('interiorCutCoverage = clamp(cutSigned / cutWidth + 0.5, 0.0, 1.0);');
    const gate = text.indexOf('* 1.3000 >= 1.0) interiorCutCoverage = 1.0;');
    expect(feather).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(feather);
    expect(text).not.toContain('cutSigned = 1e3');
  });

  it("remove exactly the wedge the pick removes, from the face basis's own normals, at every opening and pose", () => {
    // Not a transcription: the normals come from cutFaceBasis, the wedge from insideWedge, and the two must agree.
    const centre = new THREE.Vector3();
    let agreed = 0;
    for (const openingDeg of [5, 45, 90, 135, 179, 180]) {
      for (const [azimuthDeg, elevationDeg] of [[0, 0], [-28, 16], [152, 16], [90, -40]]) {
        const az = THREE.MathUtils.degToRad(azimuthDeg);
        const el = THREE.MathUtils.degToRad(elevationDeg);
        const position = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(3);
        const frame = computeCutFrame(position, new THREE.Vector3(0, 1, 0), centre, THREE.MathUtils.degToRad(openingDeg));
        const normalA = cutFaceBasis(frame, 'a').normal.clone();
        const normalB = cutFaceBasis(frame, 'b').normal.clone();
        for (let sample = 0; sample < 400; sample++) {
          const point = new THREE.Vector3(Math.sin(sample * 1.7) * 0.9, Math.cos(sample * 0.37) * 0.9, Math.sin(sample * 0.91 + 2.0) * 0.9);
          const outside = -Math.min(point.dot(normalA), point.dot(normalB));
          if (Math.abs(outside) < 1e-6) continue; // on the edge itself
          expect(outside < 0).toBe(insideWedge(frame, point));
          agreed++;
        }
      }
    }
    expect(agreed).toBeGreaterThan(9000);
  });

  it('remove the same wedge as the angle test, and stay linear at the hinge where the angle has no answer', () => {
    // The GLSL's interiorCutOutside in TypeScript: outside by the distance to the nearer bounding plane.
    const half = Math.PI / 4;
    const view = new THREE.Vector3(0, 0, 1);
    const side = new THREE.Vector3(1, 0, 0);
    const normalA = view.clone().multiplyScalar(Math.sin(half)).addScaledVector(side, -Math.cos(half));
    const normalB = view.clone().multiplyScalar(Math.sin(half)).addScaledVector(side, Math.cos(half));
    const outside = (point: THREE.Vector3) => -Math.min(point.dot(normalA), point.dot(normalB));
    const angleInside = (point: THREE.Vector3) => Math.atan2(Math.abs(point.dot(side)), point.dot(view)) < half;
    for (let step = 0; step < 360; step += 7) {
      for (const y of [-0.9, 0, 0.7]) {
        const radians = (step * Math.PI) / 180;
        const point = new THREE.Vector3(Math.sin(radians) * 0.6, y, Math.cos(radians) * 0.6);
        if (Math.abs(Math.abs(Math.atan2(Math.abs(point.dot(side)), point.dot(view))) - half) < 1e-6) continue; // on the edge itself
        expect(outside(point) < 0).toBe(angleInside(point));
      }
    }
    // On the hinge line the planes meet: the distance is exactly zero, with a finite slope either way.
    expect(outside(new THREE.Vector3(0, 1, 0))).toBeCloseTo(0, 12);
    expect(outside(new THREE.Vector3(0, 1, 1e-3))).toBeCloseTo(-1e-3 * Math.sin(half), 9);
    expect(outside(new THREE.Vector3(0, 1, -1e-3))).toBeCloseTo(1e-3 * Math.sin(half), 9);
  });
});
