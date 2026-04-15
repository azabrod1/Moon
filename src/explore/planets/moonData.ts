/**
 * Major moons of the solar system.
 * Only notable/named moons are included, not all 200+ known moons.
 */

const AU_KM = 149_597_870.7;

export interface MoonData {
  name: string;
  parentPlanet: string;
  radiusKm: number;
  radiusAU: number;
  orbitalRadiusKm: number; // Semi-major axis from parent
  orbitalRadiusAU: number;
  orbitalPeriodDays: number;
  orbitalPhaseDeg: number;
  color: number; // Hex fallback color
  textureKey?: string; // Optional texture (only for famous moons)
}

interface MoonOptions {
  orbitalPhaseDeg?: number;
  textureKey?: string;
}

function moon(
  name: string,
  parentPlanet: string,
  radiusKm: number,
  orbitalRadiusKm: number,
  orbitalPeriodDays: number,
  color: number,
  options: MoonOptions = {},
): MoonData {
  const {
    orbitalPhaseDeg = 0,
    textureKey,
  } = options;

  return {
    name,
    parentPlanet,
    radiusKm,
    radiusAU: radiusKm / AU_KM,
    orbitalRadiusKm,
    orbitalRadiusAU: orbitalRadiusKm / AU_KM,
    orbitalPeriodDays,
    orbitalPhaseDeg,
    color,
    textureKey,
  };
}

export const MOONS: MoonData[] = [
  // Earth
  moon('Moon', 'Earth', 1737.4, 384_400, 27.32, 0xaaaaaa, { textureKey: 'moon' }),

  // Mars
  moon('Phobos', 'Mars', 11.3, 9_376, 0.319, 0x8a7e6e),
  moon('Deimos', 'Mars', 6.2, 23_460, 1.263, 0x9b9080),

  // Jupiter
  moon('Metis', 'Jupiter', 21.5, 128_000, 0.295, 0x8a7860),
  moon('Amalthea', 'Jupiter', 83.5, 181_366, 0.498, 0x8b4513),
  moon('Thebe', 'Jupiter', 49.3, 221_889, 0.675, 0x8a7860),
  moon('Io', 'Jupiter', 1821.6, 421_700, 1.769, 0xc8b040, { textureKey: 'io' }),
  moon('Europa', 'Jupiter', 1560.8, 671_100, 3.551, 0xb0a890, { textureKey: 'europa' }),
  moon('Ganymede', 'Jupiter', 2634.1, 1_070_400, 7.155, 0x8a8070, { textureKey: 'ganymede' }),
  moon('Callisto', 'Jupiter', 2410.3, 1_882_700, 16.689, 0x605848, { textureKey: 'callisto' }),
  moon('Himalia', 'Jupiter', 85, 11_461_000, 250.6, 0x707060),
  moon('Lysithea', 'Jupiter', 18, 11_717_000, 259.2, 0x686860),
  moon('Elara', 'Jupiter', 43, 11_741_000, 259.6, 0x686860),
  moon('Ananke', 'Jupiter', 14, 21_276_000, 629.8, 0x606058),
  moon('Carme', 'Jupiter', 23, 23_404_000, 734.2, 0x585850),
  moon('Pasiphae', 'Jupiter', 30, 23_624_000, 743.6, 0x606058),
  moon('Sinope', 'Jupiter', 19, 23_939_000, 758.9, 0x585850),

  // Saturn
  moon('Pan', 'Saturn', 14.1, 133_584, 0.575, 0xc0c0b8),
  moon('Atlas', 'Saturn', 15.1, 137_670, 0.602, 0xb8b8b0),
  moon('Prometheus', 'Saturn', 43.1, 139_380, 0.613, 0xc0c0c0),
  moon('Pandora', 'Saturn', 40.7, 141_720, 0.629, 0xb8b8b8),
  moon('Epimetheus', 'Saturn', 58.1, 151_422, 0.694, 0xb0b0b0),
  moon('Janus', 'Saturn', 89.5, 151_472, 0.695, 0xb0b0a8),
  moon('Mimas', 'Saturn', 198.2, 185_520, 0.942, 0xc0c0c0),
  moon('Enceladus', 'Saturn', 252.1, 237_948, 1.37, 0xe8e8f0),
  moon('Tethys', 'Saturn', 531.1, 294_619, 1.888, 0xc8c8c8),
  moon('Calypso', 'Saturn', 10.7, 294_619, 1.888, 0xc0c0b8, { orbitalPhaseDeg: -60 }),
  moon('Telesto', 'Saturn', 12.4, 294_619, 1.888, 0xc0c0b8, { orbitalPhaseDeg: 60 }),
  moon('Dione', 'Saturn', 561.4, 377_396, 2.737, 0xb0b0b0),
  moon('Helene', 'Saturn', 17.6, 377_396, 2.737, 0xb8b8b0, { orbitalPhaseDeg: 60 }),
  moon('Rhea', 'Saturn', 763.8, 527_108, 4.518, 0xa8a8a0),
  moon('Titan', 'Saturn', 2574.7, 1_221_870, 15.945, 0xc89040),
  moon('Hyperion', 'Saturn', 135, 1_481_009, 21.28, 0xb0a080),
  moon('Iapetus', 'Saturn', 734.5, 3_560_820, 79.322, 0x808060),
  moon('Phoebe', 'Saturn', 106.5, 12_944_300, 550.3, 0x606060),

  // Uranus
  moon('Cordelia', 'Uranus', 20.1, 49_751, 0.335, 0x909090),
  moon('Ophelia', 'Uranus', 21.4, 53_764, 0.376, 0x909090),
  moon('Bianca', 'Uranus', 25.7, 59_165, 0.435, 0x888888),
  moon('Cressida', 'Uranus', 39.8, 61_767, 0.464, 0x888888),
  moon('Juliet', 'Uranus', 46.8, 64_358, 0.493, 0x888888),
  moon('Portia', 'Uranus', 67.6, 66_097, 0.513, 0x888888),
  moon('Rosalind', 'Uranus', 36, 69_927, 0.558, 0x888888),
  moon('Puck', 'Uranus', 81, 86_004, 0.762, 0x808080),
  moon('Miranda', 'Uranus', 235.8, 129_390, 1.413, 0xa0a0a0),
  moon('Ariel', 'Uranus', 578.9, 191_020, 2.52, 0xb0b0b0),
  moon('Umbriel', 'Uranus', 584.7, 266_300, 4.144, 0x707070),
  moon('Titania', 'Uranus', 788.4, 435_910, 8.706, 0xa8a0a0),
  moon('Oberon', 'Uranus', 761.4, 583_520, 13.463, 0x908888),
  moon('Caliban', 'Uranus', 36, 7_231_000, 579.7, 0x707070),
  moon('Sycorax', 'Uranus', 75, 12_179_000, 1288.3, 0x706868),

  // Neptune
  moon('Naiad', 'Neptune', 33, 48_227, 0.294, 0x808080),
  moon('Thalassa', 'Neptune', 41, 50_075, 0.311, 0x808080),
  moon('Despina', 'Neptune', 75, 52_526, 0.335, 0x808078),
  moon('Galatea', 'Neptune', 88, 61_953, 0.429, 0x808078),
  moon('Larissa', 'Neptune', 97, 73_548, 0.555, 0x787878),
  moon('Proteus', 'Neptune', 210, 117_647, 1.122, 0x808078),
  moon('Triton', 'Neptune', 1353.4, 354_759, 5.877, 0xb0a8a0, { textureKey: 'triton' }),
  moon('Nereid', 'Neptune', 170, 5_513_400, 360.1, 0x909088),
  moon('Halimede', 'Neptune', 31, 16_611_000, 1879.1, 0x787878),
  moon('Neso', 'Neptune', 30, 49_285_000, 9741, 0x787870),

  // Pluto
  moon('Charon', 'Pluto', 606, 19_591, 6.387, 0x909090),
  moon('Styx', 'Pluto', 5, 42_656, 20.16, 0x909090),
  moon('Nix', 'Pluto', 23, 48_694, 24.85, 0xa0a0a0),
  moon('Kerberos', 'Pluto', 6, 57_783, 32.17, 0x909090),
  moon('Hydra', 'Pluto', 25.5, 64_738, 38.2, 0xa8a8a8),
];

// Group moons by parent planet for quick lookup.
export function getMoonsByPlanet(planetName: string): MoonData[] {
  return MOONS.filter((moonEntry) => moonEntry.parentPlanet === planetName);
}
