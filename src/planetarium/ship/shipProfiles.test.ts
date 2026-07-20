import { describe, expect, it } from 'vitest';
import indexHtml from '../../../index.html?raw';
import {
  PLAYER_SHIP_GROUPS,
  PLAYER_SHIPS,
  playerShipTravelEffect,
  playerShipTravelPolicy,
  type PlayerShipProfile,
} from './shipProfiles';

describe('player ship catalog', () => {
  it('orders the four requested categories and keeps each category even', () => {
    expect(PLAYER_SHIPS.map(({ id }) => id)).toEqual([
      'default', 'starship', 'dragon', 'orion', 'starliner', 'dreamChaser', 'soyuz', 'saucer',
      'apollo', 'shuttle',
      'falcon', 'xwing', 'ywing', 'tie', 'starDestroyer', 'naboo',
      'enterprise', 'ussVoyager', 'klingon', 'romulan',
    ]);
    const counts = new Map<string, number>();
    for (const ship of PLAYER_SHIPS) counts.set(ship.group, (counts.get(ship.group) ?? 0) + 1);
    expect([...counts.keys()]).toEqual(PLAYER_SHIP_GROUPS.map(({ id }) => id));
    expect(Object.fromEntries(counts)).toEqual({ modern: 8, historic: 2, starWars: 6, starTrek: 4 });
    for (const count of counts.values()) expect(count % 2).toBe(0);
  });

  it('assigns hyperspace only to Star Wars craft', () => {
    const starWars: PlayerShipProfile[] = ['falcon', 'xwing', 'ywing', 'tie', 'starDestroyer', 'naboo'];
    for (const ship of PLAYER_SHIPS) {
      expect(playerShipTravelEffect(ship.id)).toBe(starWars.includes(ship.id) ? 'hyperspace' : (
        ship.group === 'starTrek' ? 'warp' : null
      ));
    }
  });

  it('keeps the four category policies explicit', () => {
    expect(PLAYER_SHIP_GROUPS).toEqual([
      { id: 'modern', label: 'Modern spacecraft', travelEffect: null },
      { id: 'historic', label: 'Historic spacecraft', travelEffect: null },
      { id: 'starWars', label: 'Star Wars', travelEffect: 'hyperspace' },
      { id: 'starTrek', label: 'Star Trek', travelEffect: 'warp' },
    ]);
  });

  it('suppresses animated travel when reduced motion is requested', () => {
    expect(playerShipTravelPolicy('falcon', false)).toEqual({ effect: 'hyperspace', animate: true });
    expect(playerShipTravelPolicy('enterprise', false)).toEqual({ effect: 'warp', animate: true });
    expect(playerShipTravelPolicy('falcon', true)).toEqual({ effect: 'hyperspace', animate: false });
    expect(playerShipTravelPolicy('default', false)).toEqual({ effect: null, animate: false });
  });

  it('keeps the UFO origin classified', () => {
    expect(PLAYER_SHIPS.find(({ id }) => id === 'saucer')?.note).toBe('Classified origin');
  });

  it('styles the current ship like the other settings-column values', () => {
    expect(indexHtml).toMatch(/\.ship-picker-current\s*\{[^}]*color:\s*var\(--text-secondary\)/s);
  });

  it('keeps the static icon markup in one-to-one catalog order', () => {
    const groups = [...indexHtml.matchAll(/data-ship-group="([^"]+)"/g)].map((match) => match[1]);
    const buttons = [...indexHtml.matchAll(
      /<button class="ship-choice(?: selected)?" data-ship-profile="([^"]+)"[^>]*title="([^"]*)"[^>]*aria-label="([^"]*)"/g,
    )].map((match) => ({ id: match[1], note: match[2], accessibleName: match[3] }));

    expect(groups).toEqual(PLAYER_SHIP_GROUPS.map(({ id }) => id));
    expect(buttons).toEqual(PLAYER_SHIPS.map((ship) => ({
      id: ship.id,
      note: ship.note,
      accessibleName: `${ship.label} — ${ship.note}`,
    })));
  });
});
