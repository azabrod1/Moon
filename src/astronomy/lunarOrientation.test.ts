import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { lunarOrientationQuaternion } from './lunarOrientation';
import { computeMoonGeocentricEquatorialAU } from './planetary';
import golden from './bodyOrientation.goldens.json';

describe("the Moon's orientation (IAU lunar model)", () => {
  it("puts the sub-Earth point where Horizons' MOON_ME frame does, librations included", () => {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const wrap = (degrees: number) => ((degrees % 360) + 540) % 360 - 180;
    const rows = golden.rows.filter((row) => row.planet === 'Moon');
    expect(rows.length).toBeGreaterThan(0);
    let widestLongitude = 0;
    for (const row of rows) {
      const [year, month, day] = row.utc.slice(0, 11).split('-');
      const jdTT = Date.UTC(Number(year), months.indexOf(month), Number(day)) / 86_400_000 + 2440587.5;
      // One light time back (1.3 s): the Moon as seen, not as it is.
      const toEarth = computeMoonGeocentricEquatorialAU(jdTT, new THREE.Vector3()).negate();
      const lightDays = (toEarth.length() * 499.004784) / 86_400;
      toEarth.normalize().applyQuaternion(lunarOrientationQuaternion(jdTT - lightDays).invert());
      const eastDeg = (Math.atan2(-toEarth.z, toEarth.x) * 180) / Math.PI;
      const latDeg = (Math.asin(toEarth.y) * 180) / Math.PI;
      widestLongitude = Math.max(widestLongitude, Math.abs(row.lonDeg > 180 ? row.lonDeg - 360 : row.lonDeg));
      expect(Math.abs(wrap(eastDeg - row.lonDeg)), row.utc).toBeLessThan(0.02);
      expect(Math.abs(latDeg - row.latDeg), row.utc).toBeLessThan(0.02);
    }
    // The rows librate by degrees: a face locked on Earth would miss them all.
    expect(widestLongitude).toBeGreaterThan(3);
  });
});
