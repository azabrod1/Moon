import { describe, expect, it } from 'vitest';
import { BRACKET_ARM_BIG_PIXELS, BRACKET_MARGIN_BIG_PIXELS, bracketBox } from './RetroTargetBrackets';

describe('the target brackets box', () => {
  it('grows the disc by the margin and snaps outwards to whole big pixels', () => {
    const box = bracketBox({ left: 401.3, top: 150.9, right: 702.2, bottom: 449.5 }, 4, 1280, 800)!;
    for (const edge of [box.left, box.top, box.right, box.bottom]) expect(edge % 4).toBe(0);
    expect(box.left).toBeLessThanOrEqual(401.3 - BRACKET_MARGIN_BIG_PIXELS * 4);
    expect(box.right).toBeGreaterThanOrEqual(702.2 + BRACKET_MARGIN_BIG_PIXELS * 4);
    expect(box.left).toBeGreaterThan(401.3 - (BRACKET_MARGIN_BIG_PIXELS + 1) * 4);
    expect(box).toEqual({ left: 392, top: 140, right: 712, bottom: 460 });
  });

  it('stays inside the viewport, on the grid', () => {
    const box = bracketBox({ left: -50, top: -20, right: 300, bottom: 830 }, 4, 1282, 801)!;
    expect(box).toEqual({ left: 0, top: 0, right: 308, bottom: 800 });
  });

  it('is nothing for a disc too small to frame, or without a grid', () => {
    const small = BRACKET_ARM_BIG_PIXELS * 4;
    expect(bracketBox({ left: 100, top: 100, right: 100 + small / 2, bottom: 100 + small / 2 }, 4, 1280, 800)).toBeNull();
    expect(bracketBox({ left: 100, top: 100, right: 400, bottom: 400 }, 0, 1280, 800)).toBeNull();
  });
});
