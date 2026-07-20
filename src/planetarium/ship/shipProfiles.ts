/** Ship identities shared by the renderer, menu, persistence, and missions. */

export const PLAYER_SHIPS = [
  { id: 'default', label: 'Default', note: 'Moon needle' },
  { id: 'apollo', label: 'Apollo', note: 'Lunar command ship' },
  { id: 'shuttle', label: 'Space Shuttle', note: 'Orbital glider' },
  { id: 'soyuz', label: 'Soyuz', note: 'Classic capsule' },
  { id: 'falcon', label: 'Millennium Falcon', note: 'Corellian freighter' },
  { id: 'enterprise', label: 'USS Enterprise', note: 'Federation explorer' },
  { id: 'saucer', label: 'UFO', note: 'Unknown origin' },
  { id: 'starship', label: 'SpaceX Starship', note: 'Stainless giant' },
  { id: 'dragon', label: 'SpaceX Dragon', note: 'Crew capsule' },
  { id: 'xwing', label: 'X-wing', note: 'Rebel starfighter' },
  { id: 'tie', label: 'TIE Fighter', note: 'Imperial starfighter' },
  { id: 'starDestroyer', label: 'Star Destroyer', note: 'Imperial destroyer' },
  { id: 'naboo', label: 'Naboo Starfighter', note: 'Royal starfighter' },
  { id: 'ywing', label: 'Y-wing', note: 'Rebel bomber' },
] as const;

export type PlayerShipProfile = (typeof PLAYER_SHIPS)[number]['id'];

export type HistoricShipProfile = 'voyager' | 'cassini' | 'newHorizons' | 'juno';
export type ShipProfile = PlayerShipProfile | HistoricShipProfile;

const PLAYER_SHIP_IDS = new Set<string>(PLAYER_SHIPS.map((ship) => ship.id));

export function isPlayerShipProfile(value: unknown): value is PlayerShipProfile {
  return typeof value === 'string' && PLAYER_SHIP_IDS.has(value);
}

export function playerShipLabel(profile: PlayerShipProfile): string {
  return PLAYER_SHIPS.find((ship) => ship.id === profile)?.label ?? 'Default';
}
