import { describe, it, expect } from 'vitest';
import {
  anchorOnScreen,
  resolvePick,
  isTap,
  pickRadiusFor,
  pickRadiusForAnchor,
  PICK_DISC_PAD,
  PICK_RADIUS_FINE,
  PICK_RADIUS_COARSE,
  PICK_MOVE_SLOP,
  type PickAnchor,
} from './mapPicking';

const body = (name: string, x: number, y: number, discRadiusPx = 0): PickAnchor =>
  ({ name, x, y, pickable: true, discRadiusPx });
const ship = (x: number, y: number): PickAnchor =>
  ({ name: 'ship', x, y, pickable: false, discRadiusPx: 0 });

describe('pickRadiusFor', () => {
  it('is the fine radius for a mouse, the coarse radius otherwise', () => {
    expect(pickRadiusFor('mouse')).toBe(PICK_RADIUS_FINE);
    expect(pickRadiusFor('touch')).toBe(PICK_RADIUS_COARSE);
    expect(pickRadiusFor('pen')).toBe(PICK_RADIUS_COARSE);
    expect(pickRadiusFor('')).toBe(PICK_RADIUS_COARSE);
  });
});

describe('pickRadiusForAnchor', () => {
  it('leaves a footprint-less marker on exactly the pointer floor', () => {
    expect(pickRadiusForAnchor(PICK_RADIUS_FINE, 0)).toBe(PICK_RADIUS_FINE);
    expect(pickRadiusForAnchor(PICK_RADIUS_COARSE, 0)).toBe(PICK_RADIUS_COARSE);
  });

  it('keeps the floor while the drawn disc is smaller than it', () => {
    // A marker-sized body: the pad must never pull a hit target below the floor.
    expect(pickRadiusForAnchor(PICK_RADIUS_FINE, 6)).toBe(PICK_RADIUS_FINE);
    expect(pickRadiusForAnchor(PICK_RADIUS_COARSE, 18)).toBe(PICK_RADIUS_COARSE);
  });

  it('follows the disc plus a pad once the body is drawn large', () => {
    expect(pickRadiusForAnchor(PICK_RADIUS_FINE, 300)).toBe(300 + PICK_DISC_PAD);
    expect(pickRadiusForAnchor(PICK_RADIUS_COARSE, 300)).toBe(300 + PICK_DISC_PAD);
  });
});

describe('anchorOnScreen', () => {
  const W = 1280;
  const H = 800;

  it('keeps a marker whose centre is inside the frame, to the pixel', () => {
    expect(anchorOnScreen(0, 0, W, H)).toBe(true);
    expect(anchorOnScreen(W, H, W, H)).toBe(true);
    expect(anchorOnScreen(640, 400, W, H)).toBe(true);
  });

  it('drops a marker whose centre leaves the frame on any edge', () => {
    expect(anchorOnScreen(-1, 400, W, H)).toBe(false);
    expect(anchorOnScreen(W + 1, 400, W, H)).toBe(false);
    expect(anchorOnScreen(640, -1, W, H)).toBe(false);
    expect(anchorOnScreen(640, H + 1, W, H)).toBe(false);
  });

  it('keeps a body whose drawn disc is still showing past the edge', () => {
    // A 150 px globe centred 100 px off the left edge: a third of it is on
    // screen and clickable.
    expect(anchorOnScreen(-100, 400, W, H, 150)).toBe(true);
    expect(anchorOnScreen(W + 100, 400, W, H, 150)).toBe(true);
    expect(anchorOnScreen(640, -150, W, H, 150)).toBe(true);
    // Fully past the edge by more than its own radius: nothing left to click.
    expect(anchorOnScreen(-151, 400, W, H, 150)).toBe(false);
    expect(anchorOnScreen(640, H + 151, W, H, 150)).toBe(false);
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

  it('resolves dots exactly on the pointer floors — footprints change nothing', () => {
    // Regression: with no drawn disc the hit radii are the shipped 24/44 px,
    // to the pixel, on both sides of each boundary.
    const dot = [body('Mars', 200, 200)];
    expect(resolvePick(200, 224, dot, PICK_RADIUS_FINE)).toEqual({ kind: 'body', name: 'Mars' });
    expect(resolvePick(200, 225, dot, PICK_RADIUS_FINE)).toEqual({ kind: 'empty' });
    expect(resolvePick(200, 244, dot, PICK_RADIUS_COARSE)).toEqual({ kind: 'body', name: 'Mars' });
    expect(resolvePick(200, 245, dot, PICK_RADIUS_COARSE)).toEqual({ kind: 'empty' });
  });
});

describe('resolvePick over drawn discs', () => {
  it('picks a body clicked anywhere on its drawn disc, limb included', () => {
    const globe = [body('Jupiter', 400, 400, 150)];
    // Well outside the 24 px pointer floor, inside the disc.
    expect(resolvePick(400, 280, globe, PICK_RADIUS_FINE)).toEqual({ kind: 'body', name: 'Jupiter' });
    // The limb itself, plus the pad.
    expect(resolvePick(400 + 150 + PICK_DISC_PAD, 400, globe, PICK_RADIUS_FINE))
      .toEqual({ kind: 'body', name: 'Jupiter' });
    // Just beyond it is empty space again.
    expect(resolvePick(400 + 150 + PICK_DISC_PAD + 1, 400, globe, PICK_RADIUS_FINE))
      .toEqual({ kind: 'empty' });
  });

  it('lets a marker in front of a big disc take the tap', () => {
    // A small body sitting over a globe: nearest wins across mismatched radii.
    const stacked: PickAnchor[] = [body('Jupiter', 400, 400, 150), body('Io', 430, 400)];
    expect(resolvePick(432, 400, stacked, PICK_RADIUS_FINE)).toEqual({ kind: 'body', name: 'Io' });
    // Away from the marker, the globe still owns its own face.
    expect(resolvePick(340, 400, stacked, PICK_RADIUS_FINE)).toEqual({ kind: 'body', name: 'Jupiter' });
  });

  it('lets a drawn disc outrank a nearer marker only when the marker is out of range', () => {
    const stacked: PickAnchor[] = [body('Jupiter', 400, 400, 150), body('Io', 300, 400)];
    // 30 px from Io is outside Io's 24 px floor but inside Jupiter's disc.
    expect(resolvePick(270, 400, stacked, PICK_RADIUS_FINE)).toEqual({ kind: 'body', name: 'Jupiter' });
  });
});
