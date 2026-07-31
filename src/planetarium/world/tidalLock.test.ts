import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { tidalLockQuaternion, tidalRollNorth } from './tidalLock';
import { computeMoonOffsetEquatorialAU } from '../../astronomy/satellites';
import { eclipticToEquatorial } from '../../astronomy/planetary';

const UTC = Date.parse('2026-07-28T12:00:00Z');
const ECLIPTIC_NORTH = eclipticToEquatorial(new THREE.Vector3(0, 1, 0));

/** The offset and the seam's own orbit normal for a moon at one instant. */
function seam(moonName: string, parentName: string) {
  const offset = new THREE.Vector3();
  const normal = new THREE.Vector3();
  computeMoonOffsetEquatorialAU(moonName, parentName, UTC, offset, normal);
  return { offset, normal };
}

describe('tidalRollNorth', () => {
  it('levels Earth\'s Moon on ecliptic north, not on its own orbit normal', () => {
    const { normal } = seam('Moon', 'Earth');
    const roll = tidalRollNorth('Moon', 'Earth', normal, new THREE.Vector3());
    expect(roll.angleTo(ECLIPTIC_NORTH)).toBeLessThan(1e-9);
    // And the two really are different references: the lunar orbit is tilted
    // ~5.1° to the ecliptic, while the Moon's spin axis sits ~1.5° off it.
    const tiltDeg = (normal.angleTo(ECLIPTIC_NORTH) * 180) / Math.PI;
    expect(tiltDeg).toBeGreaterThan(4.5);
    expect(tiltDeg).toBeLessThan(5.5);
  });

  it('leaves every other moon on its own orbit normal, retrograde included', () => {
    for (const [moon, parent] of [['Io', 'Jupiter'], ['Triton', 'Neptune'], ['Phoebe', 'Saturn']]) {
      const { normal } = seam(moon, parent);
      const roll = tidalRollNorth(moon, parent, normal, new THREE.Vector3());
      expect(roll.angleTo(normal), moon).toBeLessThan(1e-12);
    }
    // Triton and Phoebe orbit backwards, so their normals point south of the
    // ecliptic — the case a hardcoded "north" would silently flip.
    expect(seam('Triton', 'Neptune').normal.dot(ECLIPTIC_NORTH)).toBeLessThan(0);
    expect(seam('Phoebe', 'Saturn').normal.dot(ECLIPTIC_NORTH)).toBeLessThan(0);
  });

  it('is what makes the two renderers agree about Earth\'s Moon', () => {
    // Both renderers now ask for the roll reference here, so both build this
    // quaternion. Rolling on the raw orbit normal instead would turn the
    // Moon's face by degrees — the regression this pins.
    const { offset, normal } = seam('Moon', 'Earth');
    const shared = new THREE.Quaternion();
    const raw = new THREE.Quaternion();
    expect(tidalLockQuaternion(
      offset, tidalRollNorth('Moon', 'Earth', normal, new THREE.Vector3()), shared,
    )).toBe(true);
    expect(tidalLockQuaternion(offset, normal, raw)).toBe(true);
    const apartDeg = (shared.angleTo(raw) * 180) / Math.PI;
    expect(apartDeg).toBeGreaterThan(2);
  });
});

describe('tidalLockQuaternion', () => {
  it('points the moon\'s near face at its parent', () => {
    const { offset, normal } = seam('Io', 'Jupiter');
    const q = new THREE.Quaternion();
    expect(tidalLockQuaternion(offset, normal, q)).toBe(true);
    // Texture longitude 0 sits on the mesh's +X axis; it must face the planet.
    const nearFace = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const toParent = offset.clone().multiplyScalar(-1).normalize();
    expect(nearFace.angleTo(toParent)).toBeLessThan(1e-9);
  });

  it('keeps the basis right-handed, so no texture is mirrored', () => {
    const { offset, normal } = seam('Triton', 'Neptune');
    const q = new THREE.Quaternion();
    tidalLockQuaternion(offset, normal, q);
    const x = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const y = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const z = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    expect(x.clone().cross(y).angleTo(z)).toBeLessThan(1e-9);
  });

  it('refuses degenerate geometry instead of writing a broken pose', () => {
    const q = new THREE.Quaternion(0, 0, 0, 1);
    expect(tidalLockQuaternion(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0), q))
      .toBe(false);
    // Roll reference parallel to the sub-parent direction: no basis exists.
    expect(tidalLockQuaternion(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, 0), q))
      .toBe(false);
    expect(q.w).toBe(1);
  });
});
