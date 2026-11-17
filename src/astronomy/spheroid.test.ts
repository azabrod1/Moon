import { describe, expect, it } from 'vitest';
import {
  projectedOutlineRadius,
  raySpheroidT,
  spheroidNormal,
  spheroidRadiusToward,
  SPHERE_SHAPE,
  type SpheroidShape,
} from './spheroid';
import { bodyShape } from './bodyShape';
import { PLANETARIUM_BODIES } from '../planetarium/planets/planetData';

// Saturn's shape, its pole tipped off every axis so nothing lines up by luck.
const EQUATORIAL = 60_268;
const POLAR = 54_364;
const pole = (() => {
  const x = 0.3, y = 0.9, z = -0.2;
  const length = Math.hypot(x, y, z);
  return { x: x / length, y: y / length, z: z / length };
})();
const SATURN: SpheroidShape = { flattening: 1 - POLAR / EQUATORIAL, poleX: pole.x, poleY: pole.y, poleZ: pole.z };

/** |v⊥|²/a² + (v·p̂)²/c²: 1 on the surface. */
function surfaceValue(x: number, y: number, z: number): number {
  const along = x * pole.x + y * pole.y + z * pole.z;
  const acrossSquared = x * x + y * y + z * z - along * along;
  return acrossSquared / EQUATORIAL ** 2 + (along * along) / POLAR ** 2;
}

/** A unit vector perpendicular to `sight`, rotated by `angle` about it. */
function across(sight: { x: number; y: number; z: number }, angle: number) {
  const helper = Math.abs(sight.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  let ux = helper.y * sight.z - helper.z * sight.y;
  let uy = helper.z * sight.x - helper.x * sight.z;
  let uz = helper.x * sight.y - helper.y * sight.x;
  const length = Math.hypot(ux, uy, uz);
  ux /= length; uy /= length; uz /= length;
  const vx = sight.y * uz - sight.z * uy, vy = sight.z * ux - sight.x * uz, vz = sight.x * uy - sight.y * ux;
  return { x: ux * Math.cos(angle) + vx * Math.sin(angle), y: uy * Math.cos(angle) + vy * Math.sin(angle), z: uz * Math.cos(angle) + vz * Math.sin(angle) };
}

describe('spheroid', () => {
  it('meets a line where the spheroid is: c along the pole, a across it', () => {
    const far = 400_000;
    expect(far - raySpheroidT(pole.x * far, pole.y * far, pole.z * far, -pole.x, -pole.y, -pole.z, EQUATORIAL, SATURN)).toBeCloseTo(POLAR, 6);
    const equator = across(pole, 0.7);
    expect(far - raySpheroidT(equator.x * far, equator.y * far, equator.z * far, -equator.x, -equator.y, -equator.z, EQUATORIAL, SATURN)).toBeCloseTo(EQUATORIAL, 6);
    // Any line that hits lands on the surface.
    let state = 12345;
    const random = () => ((state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
    for (let trial = 0; trial < 200; trial++) {
      const ox = random() * 150_000, oy = random() * 150_000, oz = random() * 150_000;
      const dx = -ox + random() * 40_000, dy = -oy + random() * 40_000, dz = -oz + random() * 40_000;
      const t = raySpheroidT(ox, oy, oz, dx, dy, dz, EQUATORIAL, SATURN);
      if (Number.isNaN(t)) continue;
      expect(surfaceValue(ox + t * dx, oy + t * dy, oz + t * dz)).toBeCloseTo(1, 9);
    }
  });

  it('is the sphere at zero flattening', () => {
    const t = raySpheroidT(0, 0, 200_000, 0, 0, -1, EQUATORIAL, SPHERE_SHAPE);
    expect(t).toBe(200_000 - EQUATORIAL);
    expect(spheroidRadiusToward(0.6, 0.8, 0, EQUATORIAL, SPHERE_SHAPE)).toBe(EQUATORIAL);
    expect(projectedOutlineRadius(0, 0, 1, 1, 0, 0, EQUATORIAL, SPHERE_SHAPE)).toBe(EQUATORIAL);
    const normal = spheroidNormal(3, 4, 0, SPHERE_SHAPE, { x: 0, y: 0, z: 0 });
    expect([normal.x, normal.y, normal.z]).toEqual([0.6, 0.8, 0]);
  });

  it('gives the surface its radius and its normal', () => {
    expect(spheroidRadiusToward(pole.x, pole.y, pole.z, EQUATORIAL, SATURN)).toBeCloseTo(POLAR, 6);
    const equator = across(pole, 1.9);
    expect(spheroidRadiusToward(equator.x, equator.y, equator.z, EQUATORIAL, SATURN)).toBeCloseTo(EQUATORIAL, 6);
    // At 40° latitude the normal is the gradient: perpendicular to the surface
    // through two neighbouring surface points.
    const direction = { x: equator.x * Math.cos(0.7) + pole.x * Math.sin(0.7), y: equator.y * Math.cos(0.7) + pole.y * Math.sin(0.7), z: equator.z * Math.cos(0.7) + pole.z * Math.sin(0.7) };
    const pointAt = (shift: number) => {
      const dx = direction.x + equator.x * 0 + pole.x * shift, dy = direction.y + pole.y * shift, dz = direction.z + pole.z * shift;
      const length = Math.hypot(dx, dy, dz);
      const radius = spheroidRadiusToward(dx / length, dy / length, dz / length, EQUATORIAL, SATURN);
      return { x: (dx / length) * radius, y: (dy / length) * radius, z: (dz / length) * radius };
    };
    const here = pointAt(0);
    const next = pointAt(1e-5);
    const normal = spheroidNormal(here.x, here.y, here.z, SATURN, { x: 0, y: 0, z: 0 });
    const tangent = { x: next.x - here.x, y: next.y - here.y, z: next.z - here.z };
    const tangentLength = Math.hypot(tangent.x, tangent.y, tangent.z);
    expect(Math.abs(normal.x * tangent.x + normal.y * tangent.y + normal.z * tangent.z) / tangentLength).toBeLessThan(1e-4);
  });

  it("draws the outline the lines see: the projected ellipse matches a ray oracle", () => {
    for (const sightLatitudeDeg of [0, 15, 27, 60]) {
      const equator = across(pole, 0.4);
      const latitude = (sightLatitudeDeg * Math.PI) / 180;
      const sight = {
        x: equator.x * Math.cos(latitude) + pole.x * Math.sin(latitude),
        y: equator.y * Math.cos(latitude) + pole.y * Math.sin(latitude),
        z: equator.z * Math.cos(latitude) + pole.z * Math.sin(latitude),
      };
      for (const angle of [0, 0.5, 1.2, Math.PI / 2, 2.6]) {
        const direction = across(sight, angle);
        // The oracle: the farthest offset along `direction` at which a line of
        // sight still meets the body, by bisection on the exact ray test.
        let inside = 0, outside = 2 * EQUATORIAL;
        for (let step = 0; step < 60; step++) {
          const offset = (inside + outside) / 2;
          const hit = raySpheroidT(
            direction.x * offset - sight.x * 1e6, direction.y * offset - sight.y * 1e6, direction.z * offset - sight.z * 1e6,
            sight.x, sight.y, sight.z, EQUATORIAL, SATURN,
          );
          if (Number.isNaN(hit)) outside = offset; else inside = offset;
        }
        const radius = projectedOutlineRadius(sight.x, sight.y, sight.z, direction.x, direction.y, direction.z, EQUATORIAL, SATURN);
        expect(radius, `latitude ${sightLatitudeDeg}°, angle ${angle}`).toBeCloseTo(inside, 3);
      }
    }
  });
});

describe("the giants' shapes", () => {
  it('flatten the four giants by their published polar radii, and nothing else', () => {
    // IAU WGCCRE equatorial and polar radii at the 1-bar level, km.
    const published: Record<string, [number, number]> = {
      Jupiter: [71_492, 66_854], Saturn: [60_268, 54_364], Uranus: [25_559, 24_973], Neptune: [24_764, 24_341],
    };
    for (const body of PLANETARIUM_BODIES) {
      const shape = bodyShape(body.name);
      const radii = published[body.name];
      if (!radii) {
        expect(shape.flattening, body.name).toBe(0);
        continue;
      }
      expect(body.radiusKm, body.name).toBe(radii[0]);
      expect(body.radiusKm * (1 - shape.flattening), body.name).toBeCloseTo(radii[1], 6);
      // Along the pole the globe is drawn on (planetary.ts' pole basis).
      expect(Math.hypot(shape.poleX, shape.poleY, shape.poleZ), body.name).toBeCloseTo(1, 12);
    }
  });
});
