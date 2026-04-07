// All planet data in real units
// Distances in AU, radii in AU, periods in Earth years

export interface PlanetData {
  name: string;
  symbol: string;
  semiMajorAxisAU: number;
  radiusAU: number;       // equatorial radius in AU
  radiusKm: number;
  orbitalPeriodYears: number;
  eccentricity: number;
  inclinationDeg: number;
  axialTiltDeg: number;
  orbitalVelocityKmS: number;
  color: number;           // hex color for markers
  textureKey: string;      // key into texture map
  hasRings: boolean;
  surfaceGravityG: number; // relative to Earth
  rotationPeriodHours: number;
  moons: number;
  description: string;
  // Keplerian orbital elements at J2000.0 epoch
  meanLongitudeDeg: number;   // mean longitude at J2000.0
  lonPerihelionDeg: number;   // longitude of perihelion at J2000.0
  ascendingNodeDeg: number;   // longitude of ascending node at J2000.0
  poleRaDeg: number;          // IAU north pole right ascension
  poleDecDeg: number;         // IAU north pole declination
  primeMeridianDegAtJ2000: number;   // IAU prime meridian angle at J2000.0
  primeMeridianRateDegPerDay: number; // rotation rate in degrees/day
}

const AU_KM = 149_597_870.7;

function kmToAU(km: number): number {
  return km / AU_KM;
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
    orbitalPeriodYears: 0.2408,
    eccentricity: 0.206,
    inclinationDeg: 7.00,
    axialTiltDeg: 0.034,
    orbitalVelocityKmS: 47.87,
    color: 0x7a7168,
    textureKey: 'mercury',
    hasRings: false,
    surfaceGravityG: 0.38,
    rotationPeriodHours: 1407.6,
    moons: 0,
    description: 'Smallest planet, heavily cratered',
    meanLongitudeDeg: 252.25,
    lonPerihelionDeg: 77.46,
    ascendingNodeDeg: 48.331,
    poleRaDeg: 281.0097,
    poleDecDeg: 61.4143,
    primeMeridianDegAtJ2000: 329.5469,
    primeMeridianRateDegPerDay: 6.1385025,
  },
  {
    name: 'Venus',
    symbol: '\u2640',
    semiMajorAxisAU: 0.723,
    radiusAU: kmToAU(6_052),
    radiusKm: 6_052,
    orbitalPeriodYears: 0.6150,
    eccentricity: 0.007,
    inclinationDeg: 3.39,
    axialTiltDeg: 177.36,
    orbitalVelocityKmS: 35.02,
    color: 0xc4b08a,
    textureKey: 'venus',
    hasRings: false,
    surfaceGravityG: 0.90,
    rotationPeriodHours: 5832.5,
    moons: 0,
    description: 'Thick sulfuric acid clouds, hellish surface',
    meanLongitudeDeg: 181.98,
    lonPerihelionDeg: 131.53,
    ascendingNodeDeg: 76.680,
    poleRaDeg: 272.76,
    poleDecDeg: 67.16,
    primeMeridianDegAtJ2000: 160.20,
    primeMeridianRateDegPerDay: -1.4813688,
  },
  {
    name: 'Earth',
    symbol: '\u2295',
    semiMajorAxisAU: 1.000,
    radiusAU: kmToAU(6_378),
    radiusKm: 6_378,
    orbitalPeriodYears: 1.000,
    eccentricity: 0.017,
    inclinationDeg: 0.00,
    axialTiltDeg: 23.44,
    orbitalVelocityKmS: 29.78,
    color: 0x3a6ec0,
    textureKey: 'earthDay',
    hasRings: false,
    surfaceGravityG: 1.00,
    rotationPeriodHours: 23.93,
    moons: 1,
    description: 'Our home world',
    meanLongitudeDeg: 100.46,
    lonPerihelionDeg: 102.93,
    ascendingNodeDeg: 0,
    poleRaDeg: 0,
    poleDecDeg: 90,
    primeMeridianDegAtJ2000: 190.147,
    primeMeridianRateDegPerDay: 360.9856235,
  },
  {
    name: 'Mars',
    symbol: '\u2642',
    semiMajorAxisAU: 1.524,
    radiusAU: kmToAU(3_396),
    radiusKm: 3_396,
    orbitalPeriodYears: 1.8809,
    eccentricity: 0.093,
    inclinationDeg: 1.85,
    axialTiltDeg: 25.19,
    orbitalVelocityKmS: 24.08,
    color: 0x9a4a2a,
    textureKey: 'mars',
    hasRings: false,
    surfaceGravityG: 0.38,
    rotationPeriodHours: 24.62,
    moons: 2,
    description: 'The Red Planet, with polar ice caps',
    meanLongitudeDeg: 355.45,
    lonPerihelionDeg: 336.04,
    ascendingNodeDeg: 49.558,
    poleRaDeg: 317.269202,
    poleDecDeg: 54.432516,
    primeMeridianDegAtJ2000: 176.049863,
    primeMeridianRateDegPerDay: 350.89198226,
  },
  {
    name: 'Jupiter',
    symbol: '\u2643',
    semiMajorAxisAU: 5.203,
    radiusAU: kmToAU(71_492),
    radiusKm: 71_492,
    orbitalPeriodYears: 11.86,
    eccentricity: 0.048,
    inclinationDeg: 1.30,
    axialTiltDeg: 3.13,
    orbitalVelocityKmS: 13.07,
    color: 0xa89060,
    textureKey: 'jupiter',
    hasRings: false,
    surfaceGravityG: 2.53,
    rotationPeriodHours: 9.93,
    moons: 95,
    description: 'Gas giant, Great Red Spot, cloud bands',
    meanLongitudeDeg: 34.40,
    lonPerihelionDeg: 14.33,
    ascendingNodeDeg: 100.464,
    poleRaDeg: 268.056595,
    poleDecDeg: 64.495303,
    primeMeridianDegAtJ2000: 284.95,
    primeMeridianRateDegPerDay: 870.536,
  },
  {
    name: 'Saturn',
    symbol: '\u2644',
    semiMajorAxisAU: 9.588,
    radiusAU: kmToAU(60_268),
    radiusKm: 60_268,
    orbitalPeriodYears: 29.46,
    eccentricity: 0.056,
    inclinationDeg: 2.49,
    axialTiltDeg: 26.73,
    orbitalVelocityKmS: 9.69,
    color: 0xbfb08a,
    textureKey: 'saturn',
    hasRings: true,
    surfaceGravityG: 1.07,
    rotationPeriodHours: 10.66,
    moons: 274,
    description: 'Iconic ring system, pale gold gas giant',
    meanLongitudeDeg: 49.94,
    lonPerihelionDeg: 92.43,
    ascendingNodeDeg: 113.665,
    poleRaDeg: 40.589,
    poleDecDeg: 83.537,
    primeMeridianDegAtJ2000: 38.90,
    primeMeridianRateDegPerDay: 810.7939024,
  },
  {
    name: 'Uranus',
    symbol: '\u26E2',
    semiMajorAxisAU: 19.191,
    radiusAU: kmToAU(25_559),
    radiusKm: 25_559,
    orbitalPeriodYears: 84.07,
    eccentricity: 0.046,
    inclinationDeg: 0.77,
    axialTiltDeg: 97.77,
    orbitalVelocityKmS: 6.81,
    color: 0x6aa0b8,
    textureKey: 'uranus',
    hasRings: false,
    surfaceGravityG: 0.89,
    rotationPeriodHours: 17.24,
    moons: 27,
    description: 'Ice giant tilted on its side, pale cyan',
    meanLongitudeDeg: 313.23,
    lonPerihelionDeg: 170.96,
    ascendingNodeDeg: 74.006,
    poleRaDeg: 257.311,
    poleDecDeg: -15.175,
    primeMeridianDegAtJ2000: 203.81,
    primeMeridianRateDegPerDay: -501.1600928,
  },
  {
    name: 'Neptune',
    symbol: '\u2646',
    semiMajorAxisAU: 30.061,
    radiusAU: kmToAU(24_764),
    radiusKm: 24_764,
    orbitalPeriodYears: 164.82,
    eccentricity: 0.010,
    inclinationDeg: 1.77,
    axialTiltDeg: 29.56,
    orbitalVelocityKmS: 5.43,
    color: 0x2a4ab8,
    textureKey: 'neptune',
    hasRings: false,
    surfaceGravityG: 1.14,
    rotationPeriodHours: 16.11,
    moons: 14,
    description: 'Deep blue ice giant, strongest winds',
    meanLongitudeDeg: 304.88,
    lonPerihelionDeg: 44.97,
    ascendingNodeDeg: 131.784,
    poleRaDeg: 299.36,
    poleDecDeg: 43.46,
    primeMeridianDegAtJ2000: 249.978,
    primeMeridianRateDegPerDay: 541.1397757,
  },
];

export const PLUTO: PlanetData = {
  name: 'Pluto',
  symbol: '\u2647',
  semiMajorAxisAU: 39.48,
  radiusAU: kmToAU(1_188),
  radiusKm: 1_188,
  orbitalPeriodYears: 248.0,
  eccentricity: 0.249,
  inclinationDeg: 17.16,
  axialTiltDeg: 119.6,
  orbitalVelocityKmS: 4.67,
  color: 0x9a8e7a,
  textureKey: 'pluto',
  hasRings: false,
  surfaceGravityG: 0.06,
  rotationPeriodHours: 153.3,
  moons: 5,
  description: 'Dwarf planet at the edge, icy surface',
  meanLongitudeDeg: 238.93,
  lonPerihelionDeg: 224.07,
  ascendingNodeDeg: 110.299,
  poleRaDeg: 132.993,
  poleDecDeg: -6.163,
  primeMeridianDegAtJ2000: 302.695,
  primeMeridianRateDegPerDay: -56.3625225,
};

// All bodies including Pluto
export const ALL_BODIES: PlanetData[] = [...PLANETS, PLUTO];

// Asteroid belt range
export const ASTEROID_BELT = {
  innerAU: 2.1,
  outerAU: 3.3,
};

// Constants
export const AU_IN_KM = AU_KM;
export const LIGHT_SPEED_AU_PER_S = 1 / 499.0; // ~0.002 AU/s
export const LIGHT_SPEED_KM_PER_S = 299_792.458;
