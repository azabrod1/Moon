/**
 * Canonical planet + moon reference data for the Planetarium: physical and
 * display properties only. Orbital elements live in astronomy/standish.ts
 * (keyed by these names); semiMajorAxisAU here is a static catalog value for
 * UI heuristics (ring radii, fades, crossing toasts), not the position source.
 * PLANETARIUM_BODIES is the ordered list driving scene construction.
 */

export interface PlanetData {
  name: string;
  symbol: string;
  semiMajorAxisAU: number;
  radiusAU: number;       // equatorial radius in AU
  radiusKm: number;
  axialTiltDeg: number;
  orbitalVelocityKmS: number;
  color: number;           // hex color for markers
  textureKey: string;      // key into texture map
  hasRings: boolean;
  surfaceGravityG: number; // relative to Earth
  rotationPeriodHours: number;
  moons: number;
  description: string;
  poleRaDeg: number;          // IAU north pole right ascension
  poleDecDeg: number;         // IAU north pole declination
  primeMeridianDegAtJ2000: number;   // IAU prime meridian angle at J2000.0
  primeMeridianRateDegPerDay: number; // rotation rate in degrees/day
  systemRadiusAU: number;             // radius at which speed throttle begins
}

import { KM_PER_AU } from '../../astronomy/constants';

function kmToAU(km: number): number {
  return km / KM_PER_AU;
}

export const SUN_DATA = {
  name: 'Sun',
  radiusAU: kmToAU(696_340),     // ~0.00465 AU
  radiusKm: 696_340,
  color: 0xfff5e0,
};

export const PLANETS: PlanetData[] = [
  {
    name: 'Mercury',
    symbol: '\u263F',
    semiMajorAxisAU: 0.387,
    radiusAU: kmToAU(2_440),
    radiusKm: 2_440,
    axialTiltDeg: 0.034,
    orbitalVelocityKmS: 47.87,
    color: 0x7a7168,
    textureKey: 'mercury',
    hasRings: false,
    surfaceGravityG: 0.38,
    rotationPeriodHours: 1407.6,
    moons: 0,
    description: 'Smallest planet, heavily cratered',
    poleRaDeg: 281.0097,
    poleDecDeg: 61.4143,
    primeMeridianDegAtJ2000: 329.5469,
    primeMeridianRateDegPerDay: 6.1385025,
    systemRadiusAU: 0.01,
  },
  {
    name: 'Venus',
    symbol: '\u2640',
    semiMajorAxisAU: 0.723,
    radiusAU: kmToAU(6_052),
    radiusKm: 6_052,
    axialTiltDeg: 177.36,
    orbitalVelocityKmS: 35.02,
    color: 0xc4b08a,
    textureKey: 'venus',
    hasRings: false,
    surfaceGravityG: 0.90,
    rotationPeriodHours: 5832.5,
    moons: 0,
    description: 'Thick sulfuric acid clouds, hellish surface',
    poleRaDeg: 272.76,
    poleDecDeg: 67.16,
    primeMeridianDegAtJ2000: 160.20,
    primeMeridianRateDegPerDay: -1.4813688,
    systemRadiusAU: 0.01,
  },
  {
    name: 'Earth',
    symbol: '\u2295',
    semiMajorAxisAU: 1.000,
    radiusAU: kmToAU(6_378),
    radiusKm: 6_378,
    axialTiltDeg: 23.44,
    orbitalVelocityKmS: 29.78,
    color: 0x3a6ec0,
    textureKey: 'earthDay',
    hasRings: false,
    surfaceGravityG: 1.00,
    rotationPeriodHours: 23.93,
    moons: 1,
    description: 'Our home world',
    poleRaDeg: 0,
    poleDecDeg: 90,
    primeMeridianDegAtJ2000: 190.147,
    primeMeridianRateDegPerDay: 360.9856235,
    systemRadiusAU: 0.01,
  },
  {
    name: 'Mars',
    symbol: '\u2642',
    semiMajorAxisAU: 1.524,
    radiusAU: kmToAU(3_396),
    radiusKm: 3_396,
    axialTiltDeg: 25.19,
    orbitalVelocityKmS: 24.08,
    color: 0x9a4a2a,
    textureKey: 'mars',
    hasRings: false,
    surfaceGravityG: 0.38,
    rotationPeriodHours: 24.62,
    moons: 2,
    description: 'The Red Planet, with polar ice caps',
    poleRaDeg: 317.269202,
    poleDecDeg: 54.432516,
    primeMeridianDegAtJ2000: 176.049863,
    primeMeridianRateDegPerDay: 350.89198226,
    systemRadiusAU: 0.01,
  },
  {
    name: 'Jupiter',
    symbol: '\u2643',
    semiMajorAxisAU: 5.203,
    radiusAU: kmToAU(71_492),
    radiusKm: 71_492,
    axialTiltDeg: 3.13,
    orbitalVelocityKmS: 13.07,
    color: 0xa89060,
    textureKey: 'jupiter',
    hasRings: false,
    surfaceGravityG: 2.53,
    rotationPeriodHours: 9.93,
    moons: 95,
    description: 'Gas giant, Great Red Spot, cloud bands',
    poleRaDeg: 268.056595,
    poleDecDeg: 64.495303,
    primeMeridianDegAtJ2000: 284.95,
    primeMeridianRateDegPerDay: 870.536,
    systemRadiusAU: 0.032,
  },
  {
    name: 'Saturn',
    symbol: '\u2644',
    semiMajorAxisAU: 9.588,
    radiusAU: kmToAU(60_268),
    radiusKm: 60_268,
    axialTiltDeg: 26.73,
    orbitalVelocityKmS: 9.69,
    color: 0xbfb08a,
    textureKey: 'saturn',
    hasRings: true,
    surfaceGravityG: 1.07,
    rotationPeriodHours: 10.66,
    moons: 274,
    description: 'Iconic ring system, pale gold gas giant',
    poleRaDeg: 40.589,
    poleDecDeg: 83.537,
    primeMeridianDegAtJ2000: 38.90,
    primeMeridianRateDegPerDay: 810.7939024,
    systemRadiusAU: 0.036,
  },
  {
    name: 'Uranus',
    symbol: '\u26E2',
    semiMajorAxisAU: 19.191,
    radiusAU: kmToAU(25_559),
    radiusKm: 25_559,
    axialTiltDeg: 97.77,
    orbitalVelocityKmS: 6.81,
    color: 0x6aa0b8,
    textureKey: 'uranus',
    hasRings: false,
    surfaceGravityG: 0.89,
    rotationPeriodHours: 17.24,
    moons: 27,
    description: 'Ice giant tilted on its side, pale cyan',
    poleRaDeg: 257.311,
    poleDecDeg: -15.175,
    primeMeridianDegAtJ2000: 203.81,
    primeMeridianRateDegPerDay: -501.1600928,
    systemRadiusAU: 0.01,
  },
  {
    name: 'Neptune',
    symbol: '\u2646',
    semiMajorAxisAU: 30.061,
    radiusAU: kmToAU(24_764),
    radiusKm: 24_764,
    axialTiltDeg: 29.56,
    orbitalVelocityKmS: 5.43,
    color: 0x2a4ab8,
    textureKey: 'neptune',
    hasRings: false,
    surfaceGravityG: 1.14,
    rotationPeriodHours: 16.11,
    moons: 14,
    description: 'Deep blue ice giant, strongest winds',
    poleRaDeg: 299.36,
    poleDecDeg: 43.46,
    primeMeridianDegAtJ2000: 249.978,
    primeMeridianRateDegPerDay: 541.1397757,
    systemRadiusAU: 0.01,
  },
];

export const PLUTO: PlanetData = {
  name: 'Pluto',
  symbol: '\u2647',
  semiMajorAxisAU: 39.48,
  radiusAU: kmToAU(1_188),
  radiusKm: 1_188,
  axialTiltDeg: 119.6,
  orbitalVelocityKmS: 4.67,
  color: 0x9a8e7a,
  textureKey: 'pluto',
  hasRings: false,
  surfaceGravityG: 0.06,
  rotationPeriodHours: 153.3,
  moons: 5,
  description: 'Dwarf planet at the edge, icy surface',
  // WGCCRE 2009 right-hand-rule convention (post-2006 dwarf-planet rules):
  // W = 302.695 + 56.3625225·d about this pole — the rate is POSITIVE by
  // construction (RHR derives the pole from the spin, so W can never run
  // backward). The retired pre-2006 convention used the anti-pole (313.02,
  // +9.09) with a negative rate; mixing the two (this pole, negative rate)
  // spun Pluto backward — caught in the cycle-2 implementation review.
  poleRaDeg: 132.993,
  poleDecDeg: -6.163,
  primeMeridianDegAtJ2000: 302.695,
  primeMeridianRateDegPerDay: 56.3625225,
  systemRadiusAU: 0.02,
};

// All bodies including Pluto
export const PLANETARIUM_BODIES: PlanetData[] = [...PLANETS, PLUTO];

// Asteroid belt range
export const ASTEROID_BELT = {
  innerAU: 2.1,
  outerAU: 3.3,
};

// Constants
export const LIGHT_SPEED_AU_PER_S = 1 / 499.0; // ~0.002 AU/s
export const LIGHT_SPEED_KM_PER_S = 299_792.458;
