import { describe, it, expect } from 'vitest';
import {
  intersectSunPlane,
  makeTeleportPick,
  outerOrbitExtentAU,
  resolveTeleportPick,
  teleportChipLabel,
  teleportRangeAU,
  TP_EXTENT_MARGIN,
  TP_MIN_INCIDENCE,
  TP_MIN_RADIUS_AU,
  type TpVec3,
} from './mapTeleport';
import { defaultMapCurve, projectMapPoint, type MapCurve } from './mapProjection';
import { PLANETARIUM_BODIES } from '../planets/planetData';
import { ECLIPTIC_NORTH_EQUATORIAL } from '../../astronomy/planetary';

const NORTH: TpVec3 = {
  x: ECLIPTIC_NORTH_EQUATORIAL.x,
  y: ECLIPTIC_NORTH_EQUATORIAL.y,
  z: ECLIPTIC_NORTH_EQUATORIAL.z,
};

const ASINH: MapCurve = defaultMapCurve();
const POWER: MapCurve = { kind: 'power', gamma: 0.45 };
const CURVES: Array<[string, MapCurve]> = [['asinh', ASINH], ['power', POWER]];
// Fully compressed, mid-blend (where the inverse has no closed form), true.
const BLENDS = [0, 0.35, 0.5, 0.9, 1];

const EXTENT_AU = outerOrbitExtentAU(PLANETARIUM_BODIES);

/** Two unit vectors spanning the ecliptic plane in the scene's equatorial
 *  frame, so a test can place a point ON the plane without re-deriving the
 *  obliquity. */
function eclipticBasis(): { u: TpVec3; v: TpVec3 } {
  // +X (the vernal equinox) lies in both planes by construction.
  const u: TpVec3 = { x: 1, y: 0, z: 0 };
  const v: TpVec3 = {
    x: NORTH.y * u.z - NORTH.z * u.y,
    y: NORTH.z * u.x - NORTH.x * u.z,
    z: NORTH.x * u.y - NORTH.y * u.x,
  };
  return { u, v };
}

/** A real heliocentric point on the ecliptic plane, `radiusAU` from the Sun at
 *  in-plane angle `angleRad`. */
function eclipticPoint(radiusAU: number, angleRad: number): TpVec3 {
  const { u, v } = eclipticBasis();
  const c = Math.cos(angleRad) * radiusAU;
  const s = Math.sin(angleRad) * radiusAU;
  return { x: u.x * c + v.x * s, y: u.y * c + v.y * s, z: u.z * c + v.z * s };
}

/** The chart image of a real point, at the given blend and curve. */
function chartPoint(p: TpVec3, blend: number, curve: MapCurve): TpVec3 {
  return projectMapPoint(p.x, p.y, p.z, blend, curve, { x: 0, y: 0, z: 0 });
}

/** A camera somewhere off the plane, aimed at a chart point — the gesture's
 *  own geometry, with no viewport in the way. */
function rayTo(target: TpVec3, camera: TpVec3): { origin: TpVec3; dir: TpVec3 } {
  return {
    origin: camera,
    dir: { x: target.x - camera.x, y: target.y - camera.y, z: target.z - camera.z },
  };
}

function distance(a: TpVec3, b: TpVec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

describe('outerOrbitExtentAU', () => {
  it('is the widest catalog orbit — Pluto, not Neptune', () => {
    expect(EXTENT_AU).toBeCloseTo(39.48, 6);
    const pluto = PLANETARIUM_BODIES.find((b) => b.name === 'Pluto');
    expect(pluto).toBeDefined();
    expect(EXTENT_AU).toBe(pluto!.semiMajorAxisAU);
  });

  it('reads nothing but the catalog: a far-flung ship radius cannot widen it', () => {
    // The live chart extent includes the ship marker. Feeding one in is not
    // even expressible here — the function takes orbits — so the point of the
    // test is that the same list always answers the same number.
    expect(outerOrbitExtentAU(PLANETARIUM_BODIES)).toBe(EXTENT_AU);
    expect(outerOrbitExtentAU([])).toBe(0);
  });
});

describe('teleportRangeAU', () => {
  it('reaches a margin past the outermost orbit and stops short of the Sun', () => {
    const range = teleportRangeAU(EXTENT_AU);
    expect(range.minAU).toBe(TP_MIN_RADIUS_AU);
    expect(range.maxAU).toBeCloseTo(EXTENT_AU * TP_EXTENT_MARGIN, 9);
    // Pluto's aphelion (~49.3 AU) is inside the range: the outer system is
    // reachable, not merely its mean orbit.
    expect(range.maxAU).toBeGreaterThan(49.3);
  });
});

describe('intersectSunPlane', () => {
  const down: TpVec3 = { x: -NORTH.x, y: -NORTH.y, z: -NORTH.z };

  it('hits the plane straight ahead of a camera above it', () => {
    const origin = { x: NORTH.x * 5, y: NORTH.y * 5, z: NORTH.z * 5 };
    expect(intersectSunPlane(origin, down, NORTH)).toBeCloseTo(5, 9);
  });

  it('swallows a ray pointing away from the plane', () => {
    const origin = { x: NORTH.x * 5, y: NORTH.y * 5, z: NORTH.z * 5 };
    expect(intersectSunPlane(origin, NORTH, NORTH)).toBeNull();
  });

  it('swallows a near-edge-on ray rather than answering a wild point', () => {
    const { u } = eclipticBasis();
    // A ray just inside the incidence floor, aimed slightly downward.
    const shallow = TP_MIN_INCIDENCE * 0.5;
    const scale = Math.sqrt(1 - shallow * shallow);
    const dir: TpVec3 = {
      x: u.x * scale - NORTH.x * shallow,
      y: u.y * scale - NORTH.y * shallow,
      z: u.z * scale - NORTH.z * shallow,
    };
    const origin = { x: NORTH.x * 2, y: NORTH.y * 2, z: NORTH.z * 2 };
    expect(intersectSunPlane(origin, dir, NORTH)).toBeNull();
    // The same geometry a hair past the floor does answer — the guard is a
    // threshold, not a blanket refusal of oblique views.
    const steep = TP_MIN_INCIDENCE * 1.5;
    const steepScale = Math.sqrt(1 - steep * steep);
    const steepDir: TpVec3 = {
      x: u.x * steepScale - NORTH.x * steep,
      y: u.y * steepScale - NORTH.y * steep,
      z: u.z * steepScale - NORTH.z * steep,
    };
    expect(intersectSunPlane(origin, steepDir, NORTH)).toBeGreaterThan(0);
  });
});

describe('resolveTeleportPick', () => {
  const out = makeTeleportPick();

  it('round-trips a real point through every blend and both curves', () => {
    const camera: TpVec3 = { x: NORTH.x * 60, y: NORTH.y * 60, z: NORTH.z * 60 };
    for (const [label, curve] of CURVES) {
      for (const blend of BLENDS) {
        for (const radiusAU of [0.4, 1, 5.2, 19.2, 30.1, 39.5]) {
          for (const angle of [0, 1.1, 2.7, 4.9]) {
            const real = eclipticPoint(radiusAU, angle);
            const chart = chartPoint(real, blend, curve);
            const ray = rayTo(chart, camera);
            const pick = resolveTeleportPick(
              ray.origin, ray.dir, NORTH, blend, curve, EXTENT_AU, out,
            );
            expect(pick, `${label} blend ${blend} r ${radiusAU}`).not.toBeNull();
            // The recovered point is the one the click was aimed at.
            expect(distance(pick!, real)).toBeLessThan(1e-6 * Math.max(1, radiusAU));
            expect(pick!.radiusAU).toBeCloseTo(radiusAU, 6);
            expect(pick!.clamped).toBe(false);
          }
        }
      }
    }
  });

  it('reports the chart-space hit alongside the real point', () => {
    const real = eclipticPoint(9.5, 0.6);
    const chart = chartPoint(real, 0, ASINH);
    const camera: TpVec3 = { x: NORTH.x * 40, y: NORTH.y * 40, z: NORTH.z * 40 };
    const ray = rayTo(chart, camera);
    const pick = resolveTeleportPick(ray.origin, ray.dir, NORTH, 0, ASINH, EXTENT_AU, out);
    expect(pick).not.toBeNull();
    expect(distance({ x: pick!.chartX, y: pick!.chartY, z: pick!.chartZ }, chart)).toBeLessThan(1e-9);
    // Compressed, the chart radius is far short of the real one — the whole
    // reason the inverse exists.
    expect(Math.hypot(pick!.chartX, pick!.chartY, pick!.chartZ)).toBeLessThan(pick!.radiusAU);
  });

  it('holds ONE real-AU limit across every blend and curve', () => {
    // The same reach-for-the-rim click, read at every scale the chart offers.
    const camera: TpVec3 = { x: NORTH.x * 400, y: NORTH.y * 400, z: NORTH.z * 400 };
    const limit = teleportRangeAU(EXTENT_AU).maxAU;
    for (const [label, curve] of CURVES) {
      for (const blend of BLENDS) {
        // A point far outside the catalog, aimed at through its own chart image.
        const real = eclipticPoint(4000, 2.2);
        const chart = chartPoint(real, blend, curve);
        const ray = rayTo(chart, camera);
        const pick = resolveTeleportPick(
          ray.origin, ray.dir, NORTH, blend, curve, EXTENT_AU, out,
        );
        expect(pick, `${label} blend ${blend}`).not.toBeNull();
        expect(pick!.clamped).toBe(true);
        expect(pick!.radiusAU).toBeCloseTo(limit, 6);
        expect(Math.hypot(pick!.x, pick!.y, pick!.z)).toBeCloseTo(limit, 6);
      }
    }
  });

  it('keeps that limit whatever the ship has been doing', () => {
    // The extent is a catalog figure, so the limit cannot move with the ship.
    // Standing in for "arbitrary saved ship positions": the same click read
    // from cameras parked at wildly different distances answers the same shell.
    const limit = teleportRangeAU(EXTENT_AU).maxAU;
    for (const dist of [12, 60, 300, 5000]) {
      const camera: TpVec3 = { x: NORTH.x * dist, y: NORTH.y * dist, z: NORTH.z * dist };
      const real = eclipticPoint(1e5, 0.3);
      const chart = chartPoint(real, 0, ASINH);
      const ray = rayTo(chart, camera);
      const pick = resolveTeleportPick(ray.origin, ray.dir, NORTH, 0, ASINH, EXTENT_AU, out);
      expect(pick).not.toBeNull();
      expect(pick!.radiusAU).toBeCloseTo(limit, 6);
    }
  });

  it('floors a click on the Sun itself well outside the star', () => {
    const camera: TpVec3 = { x: NORTH.x * 30, y: NORTH.y * 30, z: NORTH.z * 30 };
    const real = eclipticPoint(1e-4, 0.9);
    const chart = chartPoint(real, 0, ASINH);
    const ray = rayTo(chart, camera);
    const pick = resolveTeleportPick(ray.origin, ray.dir, NORTH, 0, ASINH, EXTENT_AU, out);
    expect(pick).not.toBeNull();
    expect(pick!.radiusAU).toBe(TP_MIN_RADIUS_AU);
    expect(pick!.clamped).toBe(true);
  });

  it('swallows a ray that never reaches the plane', () => {
    const camera: TpVec3 = { x: NORTH.x * 30, y: NORTH.y * 30, z: NORTH.z * 30 };
    // Straight up, away from the plane.
    const away = rayTo({ x: NORTH.x * 60, y: NORTH.y * 60, z: NORTH.z * 60 }, camera);
    expect(
      resolveTeleportPick(away.origin, away.dir, NORTH, 0, ASINH, EXTENT_AU, out),
    ).toBeNull();
  });

  it('swallows an edge-on ray instead of clamping it to the rim', () => {
    const { u } = eclipticBasis();
    const camera: TpVec3 = { x: NORTH.x * 0.2, y: NORTH.y * 0.2, z: NORTH.z * 0.2 };
    const shallow = TP_MIN_INCIDENCE * 0.25;
    const scale = Math.sqrt(1 - shallow * shallow);
    const dir: TpVec3 = {
      x: u.x * scale - NORTH.x * shallow,
      y: u.y * scale - NORTH.y * shallow,
      z: u.z * scale - NORTH.z * shallow,
    };
    expect(resolveTeleportPick(camera, dir, NORTH, 0, ASINH, EXTENT_AU, out)).toBeNull();
  });

  it('swallows a degenerate ray or normal', () => {
    const camera: TpVec3 = { x: NORTH.x * 30, y: NORTH.y * 30, z: NORTH.z * 30 };
    const zero: TpVec3 = { x: 0, y: 0, z: 0 };
    expect(resolveTeleportPick(camera, zero, NORTH, 0, ASINH, EXTENT_AU, out)).toBeNull();
    expect(
      resolveTeleportPick(camera, { x: 0, y: -1, z: 0 }, zero, 0, ASINH, EXTENT_AU, out),
    ).toBeNull();
  });

  it('swallows a ray that hits the Sun dead centre', () => {
    // The direction from the Sun is what the inverse rides; the origin has none.
    const camera: TpVec3 = { x: NORTH.x * 30, y: NORTH.y * 30, z: NORTH.z * 30 };
    const ray = rayTo({ x: 0, y: 0, z: 0 }, camera);
    expect(resolveTeleportPick(ray.origin, ray.dir, NORTH, 0, ASINH, EXTENT_AU, out)).toBeNull();
  });

  it('does not read the chart plane: a click is answered on the ecliptic', () => {
    // The same ray read against the chart's own equator would land somewhere
    // else entirely — the two planes are ~23.4° apart.
    const camera: TpVec3 = { x: NORTH.x * 50, y: NORTH.y * 50, z: NORTH.z * 50 };
    const real = eclipticPoint(20, 1.6);
    const ray = rayTo(chartPoint(real, 1, ASINH), camera);
    const onEcliptic = resolveTeleportPick(ray.origin, ray.dir, NORTH, 1, ASINH, EXTENT_AU, out);
    expect(onEcliptic).not.toBeNull();
    const eclipticHit = { x: onEcliptic!.x, y: onEcliptic!.y, z: onEcliptic!.z };
    const chartEquator = makeTeleportPick();
    const onEquator = resolveTeleportPick(
      ray.origin, ray.dir, { x: 0, y: 1, z: 0 }, 1, ASINH, EXTENT_AU, chartEquator,
    );
    expect(onEquator).not.toBeNull();
    expect(distance(eclipticHit, real)).toBeLessThan(1e-6);
    expect(distance({ x: onEquator!.x, y: onEquator!.y, z: onEquator!.z }, real))
      .toBeGreaterThan(1);
  });
});

describe('teleportChipLabel', () => {
  it('says where the point is, in the app’s own distance words', () => {
    expect(teleportChipLabel(12.345)).toBe('Teleport here · 12.35 AU from the Sun');
    expect(teleportChipLabel(TP_MIN_RADIUS_AU)).toBe('Teleport here · 0.10 AU from the Sun');
  });
});
