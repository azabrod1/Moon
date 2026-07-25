import { describe, it, expect } from 'vitest';
import {
  resolvePick,
  isTap,
  pickRadiusFor,
  PICK_RADIUS_FINE,
  PICK_RADIUS_COARSE,
  PICK_MOVE_SLOP,
  type PickAnchor,
} from './mapPicking';

const body = (name: string, x: number, y: number): PickAnchor => ({ name, x, y, pickable: true });
const ship = (x: number, y: number): PickAnchor => ({ name: 'ship', x, y, pickable: false });

describe('pickRadiusFor', () => {
  it('is the fine radius for a mouse, the coarse radius otherwise', () => {
    expect(pickRadiusFor('mouse')).toBe(PICK_RADIUS_FINE);
    expect(pickRadiusFor('touch')).toBe(PICK_RADIUS_COARSE);
    expect(pickRadiusFor('pen')).toBe(PICK_RADIUS_COARSE);
    expect(pickRadiusFor('')).toBe(PICK_RADIUS_COARSE);
  });
});

describe('isTap', () => {
  it('is a tap within the slop, a drag beyond it', () => {
    expect(isTap(100, 100, 103, 104, PICK_MOVE_SLOP)).toBe(true); // 5px < 6
    expect(isTap(100, 100, 110, 110, PICK_MOVE_SLOP)).toBe(false); // ~14px
  });

  it('treats exactly the slop distance as a tap', () => {
    expect(isTap(0, 0, PICK_MOVE_SLOP, 0)).toBe(true);
    expect(isTap(0, 0, PICK_MOVE_SLOP + 1, 0)).toBe(false);
  });
});

describe('resolvePick', () => {
  const anchors: PickAnchor[] = [body('Earth', 200, 200), body('Mars', 260, 200), ship(400, 400)];

  it('picks a body within radius', () => {
    expect(resolvePick(205, 205, anchors, PICK_RADIUS_FINE)).toEqual({ kind: 'body', name: 'Earth' });
  });

  it('returns empty on open space', () => {
    expect(resolvePick(320, 200, anchors, PICK_RADIUS_FINE)).toEqual({ kind: 'empty' });
  });

  it('lets the nearest anchor win', () => {
    // Midway-ish but closer to Mars.
    expect(resolvePick(250, 200, anchors, PICK_RADIUS_COARSE)).toEqual({ kind: 'body', name: 'Mars' });
    expect(resolvePick(215, 200, anchors, PICK_RADIUS_COARSE)).toEqual({ kind: 'body', name: 'Earth' });
  });

  it('treats the ship marker as inert — a hit swallows without picking', () => {
    expect(resolvePick(402, 402, anchors, PICK_RADIUS_FINE)).toEqual({ kind: 'ship' });
  });

  it('lets a nearer body outrank the ship when both are under the pointer', () => {
    const stacked: PickAnchor[] = [body('Io', 300, 300), ship(305, 305)];
    expect(resolvePick(300, 300, stacked, PICK_RADIUS_COARSE)).toEqual({ kind: 'body', name: 'Io' });
  });

  it('lets the ship win when it is the nearer of the two', () => {
    const stacked: PickAnchor[] = [body('Io', 320, 320), ship(302, 302)];
    expect(resolvePick(300, 300, stacked, PICK_RADIUS_COARSE)).toEqual({ kind: 'ship' });
  });

  it('resolves a coincident planet+ship tie to the planet (bodies precede the ship)', () => {
    // A docked ship ring lands exactly on its parent's dot; the planet is listed
    // first and the tie-break is strict, so the tap picks the body, not the ship.
    const coincident: PickAnchor[] = [body('Earth', 300, 300), ship(300, 300)];
    expect(resolvePick(300, 300, coincident, PICK_RADIUS_FINE)).toEqual({ kind: 'body', name: 'Earth' });
  });

  it('picks the planet when the docked ship anchor is omitted from the set', () => {
    // SystemMap drops the ship anchor while docked; only the planet remains.
    const planetOnly: PickAnchor[] = [body('Earth', 300, 300)];
    expect(resolvePick(300, 300, planetOnly, PICK_RADIUS_FINE)).toEqual({ kind: 'body', name: 'Earth' });
  });

  it('respects the radius (a far body is empty space)', () => {
    expect(resolvePick(200, 200, [body('Pluto', 200, 240)], PICK_RADIUS_FINE)).toEqual({ kind: 'empty' });
    expect(resolvePick(200, 200, [body('Pluto', 200, 240)], PICK_RADIUS_COARSE)).toEqual({ kind: 'body', name: 'Pluto' });
  });
});
