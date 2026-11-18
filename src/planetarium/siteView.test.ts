import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { KM_PER_AU } from '../astronomy/constants';
import { lunarOrientationQuaternion } from '../astronomy/lunarOrientation';
import {
  computeBodyOrientationQuaternion,
  computeBodyPositionAU,
  computeMoonGeocentricEquatorialAU,
  ttJDFromUtcMs,
} from '../astronomy/planetary';
import { PLANETS } from './planets/planetData';
import {
  altAz,
  directionFromAltAz,
  findAltitudeCrossing,
  bodyDirectionFromLatLon,
  formatSiteCoordinates,
  formatSpot,
  latLonFromBodyDirection,
  parseCoordinates,
  raySphereDistance,
  horizonDipDeg,
  siteFrame,
  siteRiseText,
  type Site,
} from './siteView';
import golden from './siteView.goldens.json';

const MOON_RADIUS_KM = 1737.4;
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const earth = PLANETS.find((planet) => planet.name === 'Earth')!;

/** The drawn scene at an instant, as the app poses it: Earth one Sun–Earth
 *  light time back, the Moon about it, the Sun at the origin. */
function sceneAt(utcMs: number) {
  const jdTT = ttJDFromUtcMs(utcMs);
  const earthPosition = computeBodyPositionAU(earth, utcMs, new THREE.Vector3());
  const moonPosition = computeMoonGeocentricEquatorialAU(jdTT, new THREE.Vector3()).add(earthPosition);
  return {
    jdTT,
    positions: { Earth: earthPosition, Moon: moonPosition, Sun: new THREE.Vector3() } as Record<string, THREE.Vector3>,
    orientations: {
      Earth: computeBodyOrientationQuaternion(earth, jdTT),
      Moon: lunarOrientationQuaternion(jdTT),
    } as Record<string, THREE.Quaternion>,
  };
}

describe('sites', () => {
  it("see the sky where Horizons does: Sun and Moon from Earth, Earth and Sun from the Moon", () => {
    for (const row of golden.rows) {
      const [date, time] = row.utc.split(' ');
      const [year, month, day] = date.split('-');
      const [hour, minute] = time.split(':');
      const utcMs = Date.UTC(Number(year), months.indexOf(month), Number(day), Number(hour), Number(minute));
      const scene = sceneAt(utcMs);
      const site: Site = { body: row.body, latitudeDeg: row.latitudeDeg, longitudeDeg: row.longitudeDeg, heightKm: row.heightKm };
      const radiusKm = row.body === 'Moon' ? MOON_RADIUS_KM : earth.radiusKm;
      const frame = siteFrame(site, radiusKm, scene.orientations[row.body]);
      const eye = scene.positions[row.body].clone().addScaledVector(frame.offsetKm, 1 / KM_PER_AU);
      const seen = scene.positions[row.target].clone().sub(eye);
      const expected = directionFromAltAz(row.elevationDeg, row.azimuthDeg, frame, new THREE.Vector3());
      const errorDeg = THREE.MathUtils.radToDeg(seen.angleTo(expected));
      // Measured 1.5–10″: the Moon from Earth within 4″, the Sun 5–8″, Earth
      // and the Sun from the Moon about 10″ (the lunar model's own 0.003°).
      expect(errorDeg * 3600, `${row.site} ${row.target} ${row.utc}`).toBeLessThan(20);
      const measured = altAz(seen, frame);
      expect(Math.abs(measured.altitudeDeg - row.elevationDeg) * 3600, `${row.site} ${row.target} ${row.utc}`).toBeLessThan(20);
    }
  });

  it('dip the horizon by acos(R / (R + h)), at two metres as at a hundred kilometres', () => {
    expect(horizonDipDeg(MOON_RADIUS_KM, 0.002)).toBeCloseTo(THREE.MathUtils.radToDeg(Math.sqrt((2 * 0.002) / MOON_RADIUS_KM)), 4);
    expect(horizonDipDeg(MOON_RADIUS_KM, 100)).toBeCloseTo(THREE.MathUtils.radToDeg(Math.acos(MOON_RADIUS_KM / (MOON_RADIUS_KM + 100))), 12);
    expect(horizonDipDeg(MOON_RADIUS_KM, 0)).toBe(0);
  });

  it('find a rise and a set to the second, or say there is none', () => {
    // A body that climbs a degree an hour from −5° at the start.
    const altitudeAt = (utcMs: number) => -5 + utcMs / 3_600_000;
    expect(findAltitudeCrossing(altitudeAt, 0, -0.833, 'rise', 3_600_000, 48)! / 1000).toBeCloseTo(4.167 * 3600, -0.5);
    expect(findAltitudeCrossing(altitudeAt, 0, -0.833, 'set', 3_600_000, 48)).toBeNull();
  });

  it('turn a point on the globe into a latitude and longitude, and typed coordinates into a point', () => {
    // The body frame's own axes pin the signs: +X is longitude 0, +Y the
    // north pole, +Z longitude 90° W, so 90° E is −Z. A round trip alone
    // would pass with east and west swapped.
    const direction = new THREE.Vector3();
    expect(bodyDirectionFromLatLon(0, 90, direction).z).toBeCloseTo(-1, 12);
    expect(latLonFromBodyDirection(new THREE.Vector3(0, 0, 1)).longitudeDeg).toBeCloseTo(-90, 12);
    expect(latLonFromBodyDirection(new THREE.Vector3(0, 2, 0)).latitudeDeg).toBeCloseTo(90, 12);
    const back = latLonFromBodyDirection(bodyDirectionFromLatLon(-5.2, -68.6, direction).multiplyScalar(1737.4));
    expect(back.latitudeDeg).toBeCloseTo(-5.2, 10);
    expect(back.longitudeDeg).toBeCloseTo(-68.6, 10);
    // It is siteFrame's up, before the body is turned.
    const frame = siteFrame({ body: 'Moon', latitudeDeg: 26.13, longitudeDeg: 3.63, heightKm: 0 }, MOON_RADIUS_KM, new THREE.Quaternion());
    expect(bodyDirectionFromLatLon(26.13, 3.63, direction).distanceTo(frame.zenith)).toBeLessThan(1e-12);

    // A ray from six radii out, straight at the centre and then past the limb.
    const eye = new THREE.Vector3(6, 0, 0);
    expect(raySphereDistance(eye, new THREE.Vector3(-1, 0, 0), new THREE.Vector3(), 1)).toBeCloseTo(5, 12);
    expect(raySphereDistance(eye, new THREE.Vector3(-1, 0.2, 0).normalize(), new THREE.Vector3(), 1)).toBeNull();
    expect(raySphereDistance(eye, new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 1)).toBeNull();

    expect(parseCoordinates('2 S 80 W')).toEqual({ latitudeDeg: -2, longitudeDeg: -80 });
    expect(parseCoordinates('2.0° S, 80.0° W')).toEqual({ latitudeDeg: -2, longitudeDeg: -80 });
    expect(parseCoordinates(' 0.67N 23.47E ')).toEqual({ latitudeDeg: 0.67, longitudeDeg: 23.47 });
    expect(parseCoordinates('-45.44, 177.6')).toEqual({ latitudeDeg: -45.44, longitudeDeg: 177.6 });
    // Planetary maps often print east longitude 0–360.
    expect(parseCoordinates('-19.4, 267.2')!.longitudeDeg).toBeCloseTo(-92.8, 10);
    expect(parseCoordinates('91 N 10 E')).toBeNull();
    expect(parseCoordinates('Tranquility')).toBeNull();
    expect(parseCoordinates('12.7')).toBeNull();
    expect(formatSpot(-2, -80)).toBe('2.0° S, 80.0° W');
    expect(formatSpot(12.7, 86.52)).toBe('12.7° N, 86.5° E');
  });

  it('word a rise and a place the way the HUD prints them', () => {
    expect(siteRiseText(0, 30 * 60_000)).toBe('rises in 30 min');
    expect(siteRiseText(0, 5 * 3_600_000)).toBe('rises in 5 hours');
    expect(siteRiseText(0, 3 * 86_400_000)).toBe('rises in 3 days');
    expect(siteRiseText(0, null)).toBe('it does not rise here in the next month');
    expect(formatSiteCoordinates({ body: 'Moon', latitudeDeg: 0.6741, longitudeDeg: 23.473, heightKm: 0.002 })).toBe('0.67° N 23.47° E');
    expect(formatSiteCoordinates({ body: 'Moon', latitudeDeg: -26.1, longitudeDeg: -3.6, heightKm: 0.002 })).toBe('26.10° S 3.60° W');
  });
});
