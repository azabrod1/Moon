import { describe, it, expect } from 'vitest';
import { shipHeadingRotationRad } from './mapShipHeading';

describe('shipHeadingRotationRad', () => {
  it('points straight up for a course toward the top of the frame', () => {
    expect(shipHeadingRotationRad(0, 0.2, 800, 600)).toBeCloseTo(0, 12);
  });

  it('points down for a course toward the bottom', () => {
    expect(Math.abs(shipHeadingRotationRad(0, -0.2, 800, 600))).toBeCloseTo(Math.PI, 12);
  });

  it('turns a quarter for a course straight across the frame', () => {
    // Screen-right: the chevron's up must swing onto +x, which is a quarter
    // turn clockwise, i.e. negative in the sprite's CCW convention.
    expect(shipHeadingRotationRad(0.2, 0, 800, 600)).toBeCloseTo(-Math.PI / 2, 12);
    expect(shipHeadingRotationRad(-0.2, 0, 800, 600)).toBeCloseTo(Math.PI / 2, 12);
  });

  it('reads the same clip-space course differently at different aspects', () => {
    // A 45° course in CLIP space is not a 45° course on screen: the viewport
    // stretches x and y by different amounts. This is exactly the bug the
    // corner chart would hit if it used the canvas dimensions.
    const ndcDx = 0.1;
    const ndcDy = 0.1;
    const wide = shipHeadingRotationRad(ndcDx, ndcDy, 1400, 900);
    const mini = shipHeadingRotationRad(ndcDx, ndcDy, 184, 138);
    expect(wide).not.toBeCloseTo(mini, 3);

    // Both match the closed form for their own viewport.
    const expected = (w: number, h: number) =>
      -Math.atan2((ndcDx * w) / 2, (ndcDy * h) / 2);
    expect(wide).toBeCloseTo(expected(1400, 900), 12);
    expect(mini).toBeCloseTo(expected(184, 138), 12);

    // The wide canvas stretches x relative to y (aspect 1.56 vs 1.33), so the
    // same clip course reads as running further across the frame there.
    expect(Math.abs(wide)).toBeGreaterThan(Math.abs(mini));
  });

  it('depends only on the viewport aspect, not on its size', () => {
    const a = shipHeadingRotationRad(0.07, -0.03, 184, 138);
    const b = shipHeadingRotationRad(0.07, -0.03, 368, 276);
    expect(a).toBeCloseTo(b, 12);
  });

  it('is unchanged by the course step length', () => {
    const near = shipHeadingRotationRad(0.01, 0.004, 184, 138);
    const far = shipHeadingRotationRad(0.5, 0.2, 184, 138);
    expect(near).toBeCloseTo(far, 12);
  });
});
