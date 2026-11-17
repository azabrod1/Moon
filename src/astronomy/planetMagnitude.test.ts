import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PLANETS } from '../planetarium/planets/planetData';
import { computeBodyPositionAU } from './planetary';
import {
  planetApparentMagnitude,
  planetMagnitudeFromPositions,
  planetMagnitudeTerm,
  planetographicLatitudeDeg,
} from './planetMagnitude';
import golden from './planetMagnitude.goldens.json';

describe('planetary magnitudes (Mallama & Hilton 2018)', () => {
  it("match JPL Horizons' APmag from Earth", () => {
    // Horizons' sub-latitudes are planetographic; Saturn's ring term reads
    // planetocentric ones (tan φ = (1 − f)² tan φ′, f = 0.09796).
    const saturnCentric = (graphicDeg: number) =>
      (Math.atan((1 - 0.09796) ** 2 * Math.tan((graphicDeg * Math.PI) / 180)) * 180) / Math.PI;
    for (const row of golden.rows) {
      const magnitude = planetApparentMagnitude(row.planet, {
        sunDistanceAU: row.r,
        observerDistanceAU: row.delta,
        phaseAngleDeg: row.phaseDeg,
        year: Number(row.utc.slice(0, 4)),
        ringObserverLatDeg: saturnCentric(row.observerLatDeg),
        ringSunLatDeg: saturnCentric(row.sunLatDeg),
        observerPlanetographicLatDeg: row.observerLatDeg,
        sunPlanetographicLatDeg: row.sunLatDeg,
      });
      // Mars's corrections for the longitude it shows and its season
      // (Mallama 2007) are left out; together they reach a tenth of a magnitude.
      const tolerance = row.planet === 'Mars' ? 0.12 : 0.01;
      expect(Math.abs(magnitude - row.apmag), `${row.planet} ${row.utc}`).toBeLessThan(tolerance);
    }
  });

  it("match Horizons from the drawn positions and poles", () => {
    // The scene's own seam: the drawn Earth, planet and Sun, and the poles the
    // globes are built on, give Saturn's ring latitudes and Uranus's
    // sub-latitudes here, not Horizons' columns.
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const earth = PLANETS.find((planet) => planet.name === 'Earth')!;
    const sun = new THREE.Vector3();
    for (const row of golden.rows) {
      const [year, month, day] = row.utc.slice(0, 11).split('-');
      const utcMs = Date.UTC(Number(year), months.indexOf(month), Number(day));
      const planet = computeBodyPositionAU(PLANETS.find((candidate) => candidate.name === row.planet)!, utcMs);
      const observer = computeBodyPositionAU(earth, utcMs);
      const magnitude = planetMagnitudeFromPositions(row.planet, planet, sun, observer, Number(year));
      const tolerance = row.planet === 'Mars' ? 0.12 : 0.01;
      expect(Math.abs(magnitude - row.apmag), `${row.planet} ${row.utc}`).toBeLessThan(tolerance);
    }
  });

  it('is continuous across every join, out to where an observer here can stand', () => {
    const at = (name: string, alpha: number) =>
      planetMagnitudeTerm(name, { sunDistanceAU: 1, observerDistanceAU: 1, phaseAngleDeg: alpha, year: 2026, ringObserverLatDeg: 20, ringSunLatDeg: 18 });
    const joins: Array<[string, number]> = [
      ['Mars', 50], ['Jupiter', 12], ['Jupiter', 130], ['Saturn', 6.5], ['Saturn', 150],
      ['Uranus', 3.1], ['Uranus', 154], ['Neptune', 1.9], ['Neptune', 133], ['Venus', 179],
    ];
    for (const [name, alpha] of joins) {
      expect(Math.abs(at(name, alpha + 1e-6) - at(name, alpha - 1e-6)), `${name} at ${alpha}°`).toBeLessThan(2e-3);
    }
    for (const name of ['Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune']) {
      for (let alpha = 0; alpha <= 180; alpha += 0.5) expect(Number.isFinite(at(name, alpha)), `${name} at ${alpha}°`).toBe(true);
    }
  });

  it("brightens Saturn with its rings open, and not when the Sun and the observer see opposite faces", () => {
    const saturn = (observerLat: number, sunLat: number) => planetApparentMagnitude('Saturn', {
      sunDistanceAU: 9.5, observerDistanceAU: 8.5, phaseAngleDeg: 2, year: 2026, ringObserverLatDeg: observerLat, ringSunLatDeg: sunLat,
    });
    expect(saturn(25, 25)).toBeLessThan(saturn(0, 0) - 0.7);
    expect(saturn(10, -10)).toBe(saturn(0, 0));
  });

  it('converts planetocentric latitude to planetographic', () => {
    // 45° on Uranus (f = 0.02293): tan φ′ = 1/(1 − f)².
    expect(planetographicLatitudeDeg(45, 0.02293)).toBeCloseTo((Math.atan(1 / (1 - 0.02293) ** 2) * 180) / Math.PI, 12);
    expect(planetographicLatitudeDeg(90, 0.02293)).toBeCloseTo(90, 9);
    expect(planetographicLatitudeDeg(0, 0.02293)).toBe(0);
  });
});
