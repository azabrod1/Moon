import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  BODY_ALBEDO_GRADE, MOON_ALBEDO_SCALE, albedoGradeOf, applyAlbedoGrade, devAlbedoGrade,
  inheritAlbedoGrade, restoreAlbedoGrade,
} from './albedoGrade';
import { SUN_LIGHT_AUTHORED_HUE, luminanceOf } from '../sunLight';

describe('the albedo grade', () => {
  it("takes the Moon to 0.3 of its map's luminance in the cream's hue", () => {
    expect(luminanceOf(SUN_LIGHT_AUTHORED_HUE)).toBeCloseTo(1, 12);
    const cream = new THREE.Color(0xfff5e0);
    expect(SUN_LIGHT_AUTHORED_HUE[2] / SUN_LIGHT_AUTHORED_HUE[0]).toBeCloseTo(cream.b / cream.r, 12);
    const moon = BODY_ALBEDO_GRADE.Moon;
    expect(luminanceOf(moon)).toBeCloseTo(MOON_ALBEDO_SCALE, 12);
    expect(MOON_ALBEDO_SCALE).toBe(0.3);
    expect(albedoGradeOf('Mars')).toEqual([1, 1, 1]);
  });

  it('waits for the paint, survives a rung swap, and reaches the sectors', () => {
    const mat = new THREE.MeshStandardMaterial({ color: 0x8899aa });
    applyAlbedoGrade(mat, 'Moon', false);
    // Still the placeholder until the real map lands.
    expect(mat.color.getHex()).toBe(0x8899aa);
    restoreAlbedoGrade(mat);
    const moon = BODY_ALBEDO_GRADE.Moon;
    expect([mat.color.r, mat.color.g, mat.color.b]).toEqual([...moon]);
    // The ladder's reset restores the grade, not white.
    mat.color.setRGB(1, 1, 1);
    restoreAlbedoGrade(mat);
    expect(mat.color.r).toBeCloseTo(moon[0], 12);
    const sector = new THREE.MeshStandardMaterial();
    inheritAlbedoGrade(mat, sector);
    expect([sector.color.r, sector.color.g, sector.color.b]).toEqual([...moon]);
    // An ungraded body's materials stay white through the same calls.
    const mars = new THREE.MeshStandardMaterial();
    applyAlbedoGrade(mars, 'Mars');
    expect(mars.color.getHex()).toBe(0xffffff);
    restoreAlbedoGrade(mars);
    expect(mars.color.getHex()).toBe(0xffffff);
  });

  it('is overridden live for every material of the body, and put back', () => {
    const painted = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
    applyAlbedoGrade(painted, 'Moon');
    const before = painted.color.r;
    const state = devAlbedoGrade('Moon', [0.5, 0.5, 0.5]);
    expect(state.grade).toEqual([0.5, 0.5, 0.5]);
    expect(state.materials).toBeGreaterThan(0);
    expect(painted.color.r).toBe(0.5);
    // A material made after the override takes it too.
    const later = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
    applyAlbedoGrade(later, 'Moon');
    expect(later.color.r).toBe(0.5);
    devAlbedoGrade('Moon', null);
    expect(painted.color.r).toBeCloseTo(before, 12);
    expect(albedoGradeOf('Moon')).toEqual([...BODY_ALBEDO_GRADE.Moon]);
  });
});
