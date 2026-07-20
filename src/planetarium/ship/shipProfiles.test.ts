import { describe, expect, it } from 'vitest';
import { PLAYER_SHIPS, playerShipUsesHyperspace, type PlayerShipProfile } from './shipProfiles';

describe('player ship catalog', () => {
  it('orders modern, historic, Star Wars, Star Trek, then unknown craft', () => {
    expect(PLAYER_SHIPS.map(({ id }) => id)).toEqual([
      'default', 'starship', 'dragon', 'soyuz',
      'apollo', 'shuttle',
      'falcon', 'xwing', 'ywing', 'tie', 'starDestroyer', 'naboo',
      'enterprise',
      'saucer',
    ]);
  });

  it('uses hyperspace only for Star Wars craft', () => {
    const starWars: PlayerShipProfile[] = ['falcon', 'xwing', 'ywing', 'tie', 'starDestroyer', 'naboo'];
    for (const ship of PLAYER_SHIPS) {
      expect(playerShipUsesHyperspace(ship.id)).toBe(starWars.includes(ship.id));
    }
  });
});
