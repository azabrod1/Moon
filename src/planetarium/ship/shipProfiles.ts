/** Ship identities shared by the renderer, menu, persistence, and missions. */

export const PLAYER_SHIP_GROUPS = [
  { id: 'modern', label: 'Modern spacecraft', travelEffect: null },
  { id: 'historic', label: 'Historic spacecraft', travelEffect: null },
  { id: 'starWars', label: 'Star Wars', travelEffect: 'hyperspace' },
  { id: 'starTrek', label: 'Star Trek', travelEffect: 'warp' },
] as const;

export type PlayerShipGroup = (typeof PLAYER_SHIP_GROUPS)[number]['id'];
export type PlayerShipTravelEffect = (typeof PLAYER_SHIP_GROUPS)[number]['travelEffect'];
export interface PlayerShipTravelPolicy {
  /** Non-null when this craft still receives an intentional arrival cover. */
  effect: PlayerShipTravelEffect;
  /** False under reduced motion: teleport without moving stars or flashes. */
  animate: boolean;
}

export const PLAYER_SHIPS = [
  { id: 'default', label: 'Default', note: 'Moon needle', group: 'modern' },
  { id: 'starship', label: 'SpaceX Starship', note: 'Reusable upper stage', group: 'modern' },
  { id: 'dragon', label: 'SpaceX Dragon', note: 'Crew capsule', group: 'modern' },
  { id: 'orion', label: 'NASA Orion', note: 'Artemis crew spacecraft', group: 'modern' },
  { id: 'starliner', label: 'Boeing Starliner', note: 'Reusable crew capsule', group: 'modern' },
  { id: 'dreamChaser', label: 'Dream Chaser', note: 'Reusable spaceplane', group: 'modern' },
  { id: 'soyuz', label: 'Soyuz', note: 'Operational crew capsule', group: 'modern' },
  { id: 'saucer', label: 'UFO', note: 'Classified origin', group: 'modern' },
  { id: 'apollo', label: 'Apollo', note: 'Lunar command ship', group: 'historic' },
  { id: 'shuttle', label: 'Space Shuttle', note: 'Orbital glider', group: 'historic' },
  { id: 'falcon', label: 'Millennium Falcon', note: 'Corellian freighter', group: 'starWars' },
  { id: 'xwing', label: 'X-wing', note: 'Rebel starfighter', group: 'starWars' },
  { id: 'ywing', label: 'Y-wing', note: 'Rebel bomber', group: 'starWars' },
  { id: 'tie', label: 'TIE Fighter', note: 'Imperial starfighter', group: 'starWars' },
  { id: 'starDestroyer', label: 'Star Destroyer', note: 'Imperial destroyer', group: 'starWars' },
  { id: 'naboo', label: 'Naboo Starfighter', note: 'Royal starfighter', group: 'starWars' },
  { id: 'enterprise', label: 'USS Enterprise', note: 'Federation explorer', group: 'starTrek' },
  { id: 'ussVoyager', label: 'USS Voyager', note: 'Intrepid-class explorer', group: 'starTrek' },
  { id: 'klingon', label: 'Klingon Bird-of-Prey', note: 'Klingon raider', group: 'starTrek' },
  { id: 'romulan', label: 'Romulan Warbird', note: 'D’deridex-class warbird', group: 'starTrek' },
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

/** The category owns its franchise-specific teleport treatment. */
export function playerShipTravelEffect(profile: PlayerShipProfile): PlayerShipTravelEffect {
  const group = PLAYER_SHIPS.find((ship) => ship.id === profile)?.group;
  return PLAYER_SHIP_GROUPS.find((candidate) => candidate.id === group)?.travelEffect ?? null;
}

export function playerShipTravelPolicy(
  profile: PlayerShipProfile,
  prefersReducedMotion: boolean,
): PlayerShipTravelPolicy {
  const effect = playerShipTravelEffect(profile);
  return { effect, animate: effect !== null && !prefersReducedMotion };
}
