/**
 * Major moons of the solar system.
 * Only notable/named moons are included — not all 200+ known moons.
 */

const AU_KM = 149_597_870.7;

export interface MoonData {
  name: string;
  parentPlanet: string;
  radiusKm: number;
  radiusAU: number;
  orbitalRadiusKm: number;    // semi-major axis from parent
  orbitalRadiusAU: number;
  orbitalPeriodDays: number;
  color: number;              // hex fallback color
  textureKey?: string;        // optional texture (only for famous moons)
}

function moon(
  name: string,
  parentPlanet: string,
  radiusKm: number,
  orbitalRadiusKm: number,
  orbitalPeriodDays: number,
  color: number,
  textureKey?: string,
): MoonData {
  return {
    name,
    parentPlanet,
    radiusKm,
    radiusAU: radiusKm / AU_KM,
    orbitalRadiusKm,
    orbitalRadiusAU: orbitalRadiusKm / AU_KM,
    orbitalPeriodDays,
    color,
    textureKey,
  };
}

export const MOONS: MoonData[] = [
  // Earth
  moon('Moon', 'Earth', 1737.4, 384_400, 27.32, 0xaaaaaa, 'moon'),

  // Mars
  moon('Phobos', 'Mars', 11.3, 9_376, 0.319, 0x8a7e6e),
  moon('Deimos', 'Mars', 6.2, 23_460, 1.263, 0x9b9080),

  // Jupiter — Galilean moons
  moon('Io', 'Jupiter', 1821.6, 421_700, 1.769, 0xc8b040),
  moon('Europa', 'Jupiter', 1560.8, 671_100, 3.551, 0xb0a890),
  moon('Ganymede', 'Jupiter', 2634.1, 1_070_400, 7.155, 0x8a8070),
  moon('Callisto', 'Jupiter', 2410.3, 1_882_700, 16.689, 0x605848),

  // Saturn
  moon('Mimas', 'Saturn', 198.2, 185_520, 0.942, 0xc0c0c0),
  moon('Enceladus', 'Saturn', 252.1, 237_948, 1.370, 0xe8e8f0),
  moon('Tethys', 'Saturn', 531.1, 294_619, 1.888, 0xc8c8c8),
  moon('Dione', 'Saturn', 561.4, 377_396, 2.737, 0xb0b0b0),
  moon('Rhea', 'Saturn', 763.8, 527_108, 4.518, 0xa8a8a0),
  moon('Titan', 'Saturn', 2574.7, 1_221_870, 15.945, 0xc89040),
  moon('Iapetus', 'Saturn', 734.5, 3_560_820, 79.322, 0x808060),

  // Uranus
  moon('Miranda', 'Uranus', 235.8, 129_390, 1.413, 0xa0a0a0),
  moon('Ariel', 'Uranus', 578.9, 191_020, 2.520, 0xb0b0b0),
  moon('Umbriel', 'Uranus', 584.7, 266_300, 4.144, 0x707070),
  moon('Titania', 'Uranus', 788.4, 435_910, 8.706, 0xa8a0a0),
  moon('Oberon', 'Uranus', 761.4, 583_520, 13.463, 0x908888),

  // Neptune
  moon('Triton', 'Neptune', 1353.4, 354_759, 5.877, 0xb0a8a0),

  // Pluto
  moon('Charon', 'Pluto', 606, 19_591, 6.387, 0x909090),
];

// Group moons by parent planet for quick lookup
export function getMoonsByPlanet(planetName: string): MoonData[] {
  return MOONS.filter(m => m.parentPlanet === planetName);
}
