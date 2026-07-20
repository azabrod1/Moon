import { describe, expect, it } from 'vitest';
import { PLAYER_SHIPS, playerShipUsesHyperspace, type PlayerShipProfile } from './shipProfiles';

describe('player ship catalog', () => {
  it('orders the four requested categories and keeps each category even', () => {
    expect(PLAYER_SHIPS.map(({ id }) => id)).toEqual([
      'default', 'starship', 'dragon', 'orion', 'starliner', 'dreamChaser', 'soyuz', 'saucer',
      'apollo', 'shuttle',
      'falcon', 'xwing', 'ywing', 'tie', 'starDestroyer', 'naboo',
      'enterprise', 'klingon',
    ]);
    const counts = new Map<string, number>();
    for (const ship of PLAYER_SHIPS) counts.set(ship.group, (counts.get(ship.group) ?? 0) + 1);
    expect(Object.fromEntries(counts)).toEqual({ modern: 8, historic: 2, starWars: 6, starTrek: 2 });
    for (const count of counts.values()) expect(count % 2).toBe(0);
  });

  it('uses hyperspace only for Star Wars craft', () => {
    const starWars: PlayerShipProfile[] = ['falcon', 'xwing', 'ywing', 'tie', 'starDestroyer', 'naboo'];
    for (const ship of PLAYER_SHIPS) {
      expect(playerShipUsesHyperspace(ship.id)).toBe(starWars.includes(ship.id));
    }
  });

  it('keeps the UFO origin classified', () => {
    expect(PLAYER_SHIPS.find(({ id }) => id === 'saucer')?.note).toBe('Origin: classified');
  });
});
