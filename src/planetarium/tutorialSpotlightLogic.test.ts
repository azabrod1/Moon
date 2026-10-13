import { describe, expect, it } from 'vitest';
import {
  BUBBLE_GAP_PX,
  BUBBLE_MARGIN_PX,
  SPOTLIGHT_CUTOUT_PAD_PX,
  SUBJECT_FIT_FRACTION,
  angularErrorRad,
  distanceForDiameter,
  largestFreeRect,
  placeBubble,
  rectInside,
  rectsOverlap,
  spotlightCutout,
  subjectFrame,
} from './tutorialSpotlightLogic';
import type { Rect } from './tutorialSpotlightLogic';

const DESKTOP: Rect = { x: 0, y: 0, w: 1400, h: 900 };
const PHONE: Rect = { x: 0, y: 0, w: 390, h: 844 };
// The chrome as the walk measures it: the card top-left on desktop and
// top-docked on the phone, the cluster top-right, the bar along the bottom.
const DESKTOP_CARD: Rect = { x: 12, y: 88, w: 360, h: 200 };
const DESKTOP_CLUSTER: Rect = { x: 1200, y: 14, w: 186, h: 38 };
const DESKTOP_BAR: Rect = { x: 300, y: 836, w: 800, h: 56 };
const PHONE_CARD: Rect = { x: 8, y: 60, w: 374, h: 230 };
const PHONE_CLUSTER: Rect = { x: 200, y: 14, w: 176, h: 38 };
const PHONE_BAR: Rect = { x: 6, y: 780, w: 378, h: 56 };

describe('rect helpers', () => {
  it('overlap is strict: touching edges do not overlap', () => {
    expect(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBe(false);
    expect(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 9, y: 9, w: 10, h: 10 })).toBe(true);
  });

  it('inside allows the tolerance and no more', () => {
    const outer = { x: 100, y: 100, w: 200, h: 200 };
    expect(rectInside({ x: 100, y: 100, w: 200, h: 200 }, outer)).toBe(true);
    expect(rectInside({ x: 99, y: 100, w: 200, h: 200 }, outer)).toBe(false);
    expect(rectInside({ x: 99, y: 100, w: 202, h: 200 }, outer, 1)).toBe(true);
    expect(rectInside({ x: 98, y: 100, w: 200, h: 200 }, outer, 1)).toBe(false);
  });
});

describe('spotlightCutout', () => {
  it('pads the target on every side', () => {
    const cutout = spotlightCutout({ x: 100, y: 50, w: 38, h: 38 }, DESKTOP);
    expect(cutout).toEqual({
      x: 100 - SPOTLIGHT_CUTOUT_PAD_PX,
      y: 50 - SPOTLIGHT_CUTOUT_PAD_PX,
      w: 38 + SPOTLIGHT_CUTOUT_PAD_PX * 2,
      h: 38 + SPOTLIGHT_CUTOUT_PAD_PX * 2,
    });
  });

  it('is held inside the viewport for a control on the edge', () => {
    const cutout = spotlightCutout({ x: 1362, y: 0, w: 38, h: 38 }, DESKTOP);
    expect(cutout.x + cutout.w).toBe(1400);
    expect(cutout.y).toBe(0);
    expect(cutout.w).toBe(38 + SPOTLIGHT_CUTOUT_PAD_PX);
  });
});

describe('placeBubble', () => {
  const size = { w: 120, h: 34 };

  it('takes the first side with room: below a chip in the open', () => {
    const cutout = { x: 600, y: 400, w: 50, h: 50 };
    const placed = placeBubble({ cutout, size, viewport: DESKTOP, avoid: [DESKTOP_CARD] });
    expect(placed.side).toBe('below');
    expect(placed.y).toBe(450 + BUBBLE_GAP_PX);
    expect(placed.x).toBe(625 - 60);
    // The arrow points at the cutout's centre.
    expect(placed.arrow).toBe(60);
  });

  it('the top-right Teleport chip gets its bubble below, kept inside the viewport', () => {
    const chip = spotlightCutout({ x: 1348, y: 14, w: 38, h: 38 }, DESKTOP);
    const placed = placeBubble({ cutout: chip, size, viewport: DESKTOP, avoid: [DESKTOP_CARD] });
    expect(placed.side).toBe('below');
    expect(placed.x + size.w).toBeLessThanOrEqual(1400 - BUBBLE_MARGIN_PX);
    // Clamped sideways, the arrow still aims at the chip's centre.
    expect(placed.x + placed.arrow).toBe(chip.x + chip.w / 2);
  });

  it('avoids the narrator card: the phone Teleport chip, with the card right under it, is labelled from the left', () => {
    // Below lands on the top-docked card and above leaves the screen, so the
    // bubble takes the first side that is clear of both.
    const chip = spotlightCutout({ x: 280, y: 14, w: 38, h: 38 }, PHONE);
    const placed = placeBubble({ cutout: chip, size, viewport: PHONE, avoid: [PHONE_CARD] });
    expect(placed.side).toBe('left');
    expect(rectsOverlap({ ...placed, w: size.w, h: size.h }, PHONE_CARD)).toBe(false);
    expect(placed.x + size.w + BUBBLE_GAP_PX).toBe(chip.x);
  });

  it('falls back to the least-overlapping side when every side collides', () => {
    const everything = { x: 0, y: 0, w: 1400, h: 900 };
    const cutout = { x: 600, y: 400, w: 50, h: 50 };
    const placed = placeBubble({ cutout, size, viewport: DESKTOP, avoid: [everything] });
    expect(placed.side).toBe('below');
    expect(placed.x).toBeGreaterThanOrEqual(BUBBLE_MARGIN_PX);
  });

  it('a phone sheet row near the bottom is labelled above, clear of the sheet edge', () => {
    const cutout = { x: 20, y: 800, w: 350, h: 31 };
    const placed = placeBubble({ cutout, size, viewport: PHONE, avoid: [PHONE_CARD] });
    expect(placed.side).toBe('above');
    expect(placed.y + size.h + BUBBLE_GAP_PX).toBe(800);
  });

  it('a bubble wider than the viewport still lands on screen', () => {
    const placed = placeBubble({
      cutout: { x: 10, y: 10, w: 20, h: 20 },
      size: { w: 500, h: 34 },
      viewport: PHONE,
      avoid: [],
    });
    expect(placed.x).toBe(BUBBLE_MARGIN_PX);
    expect(placed.side).toBe('below');
  });
});

describe('largestFreeRect', () => {
  it('with no obstacles the whole viewport, inset by the margin', () => {
    expect(largestFreeRect(DESKTOP, [], 16)).toEqual({ x: 16, y: 16, w: 1368, h: 868 });
  });

  it('desktop: the column right of the card and left of the cluster, down to the bar (the squarer of the two candidates)', () => {
    const free = largestFreeRect(DESKTOP, [DESKTOP_CARD, DESKTOP_CLUSTER, DESKTOP_BAR]);
    expect(free).toEqual({ x: 372, y: 0, w: 828, h: 836 });
    for (const block of [DESKTOP_CARD, DESKTOP_CLUSTER, DESKTOP_BAR]) {
      expect(rectsOverlap(free, block)).toBe(false);
    }
  });

  it('phone: the band between the top-docked card and the bottom bar', () => {
    const free = largestFreeRect(PHONE, [PHONE_CARD, PHONE_CLUSTER, PHONE_BAR]);
    expect(free).toEqual({ x: 0, y: 290, w: 390, h: 490 });
  });

  it('prefers the squarer area over a longer strip', () => {
    // A 1400×100 strip along the top versus a 500×500 square: the square wins.
    const viewport = { x: 0, y: 0, w: 1400, h: 600 };
    const wall = { x: 0, y: 100, w: 900, h: 500 };
    const free = largestFreeRect(viewport, [wall]);
    expect(free).toEqual({ x: 900, y: 0, w: 500, h: 600 });
  });

  it('ignores empty and off-screen obstacles', () => {
    const free = largestFreeRect(DESKTOP, [
      { x: 10, y: 10, w: 0, h: 50 },
      { x: 2000, y: 0, w: 100, h: 100 },
    ]);
    expect(free).toEqual(DESKTOP);
  });

  it('an obstacle covering everything leaves nothing', () => {
    const free = largestFreeRect(DESKTOP, [DESKTOP]);
    expect(free.w).toBe(0);
    expect(free.h).toBe(0);
  });
});

describe('subject fit', () => {
  it('the frame is centred and spans the fit fraction of the shorter side', () => {
    const frame = subjectFrame({ x: 372, y: 52, w: 1028, h: 784 });
    expect(frame.x).toBe(886);
    expect(frame.y).toBe(444);
    expect(frame.diameterPx).toBeCloseTo(784 * SUBJECT_FIT_FRACTION);
  });

  it('distance makes the sphere subtend the asked diameter at the frame centre', () => {
    // A 1 unit sphere shown 450 px across in a 900 px, 60° view: 30° subtended.
    const distance = distanceForDiameter(1, 450, 60, 900);
    expect(distance).toBeCloseTo(1 / Math.sin((15 * Math.PI) / 180), 9);
    // Smaller on screen means farther away.
    expect(distanceForDiameter(1, 225, 60, 900)).toBeGreaterThan(distance);
  });

  it('a pixel error reads as the turn that cancels it', () => {
    expect(angularErrorRad(900, 60, 900)).toBeCloseTo((60 * Math.PI) / 180);
    expect(angularErrorRad(-45, 60, 900)).toBeCloseTo((-3 * Math.PI) / 180);
  });
});
