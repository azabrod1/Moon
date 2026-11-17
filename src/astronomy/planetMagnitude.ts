/**
 * The planets' apparent visual (V) magnitudes: the equations of Mallama &
 * Hilton (2018), "Computing apparent planetary magnitudes for The Astronomical
 * Almanac", Astronomy and Computing 25, 10–24 (arXiv:1808.01973). JPL Horizons'
 * APmag column computes the same model, Saturn with its rings (the paper's
 * note that Horizons printed the globe alone is out of date):
 * planetMagnitude.test.ts holds the two to each other on Horizons' own rows
 * (tools/planet-magnitudes-golden.mjs): under a thousandth of a magnitude
 * apart, but for Mars, whose longitude and season terms (below) Horizons
 * applies and this leaves out — a tenth of a magnitude at most.
 *
 * Each planet is V = 5 log10(r Δ) + V1(α), r and Δ its distances from the Sun
 * and the observer in AU, α the phase angle in degrees. The paper's curves
 * cover the phase angles seen from Earth, and most continue past them from
 * spacecraft data; here they are joined and bounded so the magnitude is
 * continuous wherever an observer in this app can stand:
 *   - where the paper matched two curves at their join (Mars at 50°, Jupiter
 *     at 12°, Saturn's globe at 6°) they are used as given;
 *   - Uranus's (3.1°) and Neptune's (1.9°) wide-angle curves are shifted to
 *     meet the Earth-range ones at the join, which the paper leaves 0.02 and
 *     0.015 mag apart;
 *   - past a curve's last valid angle (Venus 179°, Jupiter 130°, Saturn 150°,
 *     Uranus 154°, Neptune 133°) its phase term is held at that angle;
 *   - Venus keeps its real break at 163.7° (forward scattering in its haze).
 * Saturn's point is the planet with its rings: the paper's ring model (Eq. 10)
 * holds below 6.5°; past it the globe follows Eq. 12 and the rings keep the
 * brightening they had at 6.5°, the one join the paper gives no curve for.
 * Mars's corrections for the longitude it shows and its season (Mallama 2007,
 * ±0.06 mag) are left out.
 */
import { bodyShape } from './bodyShape';
import type { SpheroidShape } from './spheroid';

/** Where an apparent magnitude is seen from: distances in AU, angles in
 *  degrees, the year as a decimal CE year (Neptune brightened 1980–2000). */
export interface MagnitudeGeometry {
  sunDistanceAU: number;
  observerDistanceAU: number;
  phaseAngleDeg: number;
  year: number;
  /** Saturn: the observer's and the Sun's planetocentric latitudes over its
   *  ring plane (its equator). */
  ringObserverLatDeg?: number;
  ringSunLatDeg?: number;
  /** Uranus: the observer's and the Sun's planetographic sub-latitudes. */
  observerPlanetographicLatDeg?: number;
  sunPlanetographicLatDeg?: number;
}

const polynomial = (alpha: number, coefficients: readonly number[]): number => {
  let value = 0;
  for (let power = coefficients.length - 1; power >= 0; power--) value = value * alpha + coefficients[power];
  return value;
};

/** Eq. 9's albedo ratio for Jupiter past 12°, as a magnitude. */
function jupiterWideTerm(alpha: number): number {
  const x = alpha / 180;
  return -2.5 * Math.log10(polynomial(x, [1, -1.507, -0.363, -0.062, 2.809, -1.876]));
}

/** Saturn's globe alone (Eq. 11 to 6°, Eq. 12 to 150°). */
function saturnGlobeMagnitudeTerm(phaseAngleDeg: number): number {
  const alpha = Math.min(phaseAngleDeg, 150);
  return alpha <= 6
    ? polynomial(alpha, [-8.95, -3.7e-4, 6.16e-4])
    : polynomial(alpha, [-8.94, 2.446e-4, 2.672e-4, -1.505e-6, 4.767e-9]);
}

/** Saturn with its rings (Eq. 10), effective inclination from the two
 *  latitudes: their geometric mean when the Sun and the observer see the
 *  same face, nothing when they see opposite faces (the rings back-lit). */
function saturnRingSystemTerm(alpha: number, observerLatDeg: number, sunLatDeg: number): number {
  const product = observerLatDeg * sunLatDeg;
  const inclinationDeg = product > 0 ? Math.min(Math.sqrt(product), 27) : 0;
  const sinBeta = Math.sin((inclinationDeg * Math.PI) / 180);
  return -8.914 - 1.825 * sinBeta + 0.026 * alpha - 0.378 * sinBeta * Math.exp(-2.25 * alpha);
}

/** Neptune's V1(0) for the year (Eq. 16). */
function neptuneZeroPhase(year: number): number {
  if (year < 1980) return -6.89;
  if (year <= 2000) return -6.89 - 0.0054 * (year - 1980);
  return -7.0;
}

/** The magnitude's phase-and-body part, V1(α): V minus 5 log10(r Δ). NaN for
 *  a body the paper has no equation for. */
export function planetMagnitudeTerm(name: string, geometry: MagnitudeGeometry): number {
  const alpha = Math.max(0, geometry.phaseAngleDeg);
  switch (name) {
    case 'Mercury':
      return polynomial(alpha, [-0.613, 6.328e-2, -1.6336e-3, 3.3644e-5, -3.4265e-7, 1.6893e-9, -3.0334e-12]);
    case 'Venus': {
      if (alpha <= 163.7) return polynomial(alpha, [-4.384, -1.044e-3, 3.687e-4, -2.814e-6, 8.938e-9]);
      return polynomial(Math.min(alpha, 179), [236.05828, -2.81914, 8.39034e-3]);
    }
    case 'Earth':
      return polynomial(alpha, [-3.99, -1.06e-3, 2.054e-4]);
    case 'Mars':
      return alpha <= 50
        ? polynomial(alpha, [-1.601, 0.02267, -0.0001302])
        : polynomial(alpha, [-0.367, -0.02573, 0.0003445]);
    case 'Jupiter':
      return alpha <= 12 ? polynomial(alpha, [-9.395, -3.7e-4, 6.16e-4]) : -9.428 + jupiterWideTerm(Math.min(alpha, 130));
    case 'Saturn': {
      const observerLat = geometry.ringObserverLatDeg ?? 0;
      const sunLat = geometry.ringSunLatDeg ?? 0;
      if (alpha < 6.5) return saturnRingSystemTerm(alpha, observerLat, sunLat);
      return saturnGlobeMagnitudeTerm(alpha) + saturnRingSystemTerm(6.5, observerLat, sunLat) - saturnGlobeMagnitudeTerm(6.5);
    }
    case 'Uranus': {
      const latitude = (Math.abs(geometry.observerPlanetographicLatDeg ?? 0) + Math.abs(geometry.sunPlanetographicLatDeg ?? 0)) / 2;
      const base = -7.11 - 8.4e-4 * latitude;
      if (alpha <= 3.1) return base;
      const wide = (a: number) => polynomial(a, [0, 6.587e-3, 1.045e-4]);
      return base + wide(Math.min(alpha, 154)) - wide(3.1);
    }
    case 'Neptune': {
      const base = neptuneZeroPhase(geometry.year);
      if (alpha <= 1.9) return base;
      const wide = (a: number) => polynomial(a, [0, 7.944e-3, 9.617e-5]);
      return base + wide(Math.min(alpha, 133)) - wide(1.9);
    }
    default:
      return Number.NaN;
  }
}

/** A planet's apparent V magnitude (NaN for a body without an equation). */
export function planetApparentMagnitude(name: string, geometry: MagnitudeGeometry): number {
  return 5 * Math.log10(geometry.sunDistanceAU * geometry.observerDistanceAU) + planetMagnitudeTerm(name, geometry);
}

/** Planetographic latitude from planetocentric, for a body of flattening f:
 *  tan φ′ = tan φ / (1 − f)². */
export function planetographicLatitudeDeg(planetocentricDeg: number, flattening: number): number {
  const radians = (planetocentricDeg * Math.PI) / 180;
  const ratio = (1 - flattening) * (1 - flattening);
  return (Math.atan2(Math.sin(radians), Math.cos(radians) * ratio) * 180) / Math.PI;
}

interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** Latitude, in degrees, of a direction over a pole (both in one frame). */
function latitudeOverPoleDeg(dx: number, dy: number, dz: number, length: number, shape: SpheroidShape): number {
  const sine = (dx * shape.poleX + dy * shape.poleY + dz * shape.poleZ) / length;
  return (Math.asin(Math.max(-1, Math.min(1, sine))) * 180) / Math.PI;
}

/**
 * A planet's apparent magnitude from the positions of the planet, the Sun and
 * the observer, in any one frame and unit of AU (the scene's floating origin
 * included): the distances, the phase angle, and, from the body's drawn pole
 * (bodyShape), Saturn's ring latitudes and Uranus's sub-latitudes. Geometric
 * positions: no light time, which moves no magnitude by a thousandth.
 */
export function planetMagnitudeFromPositions(
  name: string,
  planet: Point3,
  sun: Point3,
  observer: Point3,
  year: number,
): number {
  const sunX = sun.x - planet.x;
  const sunY = sun.y - planet.y;
  const sunZ = sun.z - planet.z;
  const observerX = observer.x - planet.x;
  const observerY = observer.y - planet.y;
  const observerZ = observer.z - planet.z;
  const sunDistanceAU = Math.hypot(sunX, sunY, sunZ);
  const observerDistanceAU = Math.hypot(observerX, observerY, observerZ);
  if (!(sunDistanceAU > 0) || !(observerDistanceAU > 0)) return Number.NaN;
  const cosine = (sunX * observerX + sunY * observerY + sunZ * observerZ) / (sunDistanceAU * observerDistanceAU);
  const geometry: MagnitudeGeometry = {
    sunDistanceAU,
    observerDistanceAU,
    phaseAngleDeg: (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI,
    year,
  };
  if (name === 'Saturn' || name === 'Uranus') {
    const shape = bodyShape(name);
    const observerLat = latitudeOverPoleDeg(observerX, observerY, observerZ, observerDistanceAU, shape);
    const sunLat = latitudeOverPoleDeg(sunX, sunY, sunZ, sunDistanceAU, shape);
    if (name === 'Saturn') {
      geometry.ringObserverLatDeg = observerLat;
      geometry.ringSunLatDeg = sunLat;
    } else {
      geometry.observerPlanetographicLatDeg = planetographicLatitudeDeg(observerLat, shape.flattening);
      geometry.sunPlanetographicLatDeg = planetographicLatitudeDeg(sunLat, shape.flattening);
    }
  }
  return planetApparentMagnitude(name, geometry);
}
