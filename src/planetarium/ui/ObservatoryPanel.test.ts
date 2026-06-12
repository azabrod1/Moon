import { describe, it, expect } from 'vitest';
import { sheetReleaseTarget } from './ObservatoryPanel';

// Pins for the bottom sheet's free-drag release decision (≤640px form).
// dy is finger travel in px, down positive; target height = start − dy.
// Tap discrimination (|dy| < 6 on the handle) happens at the call site — the
// function only ever sees drags. 'peek'/'full' are tracking states (they
// follow the floor/ceiling as content changes); a number is a hand-picked px.
describe('sheetReleaseTarget', () => {
  const FULL = 500;
  const PEEK = 200;

  it('parks where the finger leaves it — no detent snap', () => {
    expect(sheetReleaseTarget(300, -50, FULL, PEEK)).toBe(350);
    expect(sheetReleaseTarget(300, 91, FULL, PEEK)).toBe(209);
    expect(sheetReleaseTarget(PEEK, -150, FULL, PEEK)).toBe(350);
  });

  it('snaps releases within 8px of an edge onto the tracking state', () => {
    expect(sheetReleaseTarget(300, -192, FULL, PEEK)).toBe('full'); // target 492
    expect(sheetReleaseTarget(300, -191, FULL, PEEK)).toBe(491);
    expect(sheetReleaseTarget(300, 92, FULL, PEEK)).toBe('peek'); // target 208
    expect(sheetReleaseTarget(300, 91, FULL, PEEK)).toBe(209);
  });

  it('clamps overshoot past the ceiling to the tracking full state', () => {
    expect(sheetReleaseTarget(300, -300, FULL, PEEK)).toBe('full'); // target 600
    expect(sheetReleaseTarget(FULL, -1, FULL, PEEK)).toBe('full');
  });

  it('from the floor: a >80px pull down dismisses, exactly 80 settles back', () => {
    expect(sheetReleaseTarget(PEEK, 81, FULL, PEEK)).toBe('dismiss');
    expect(sheetReleaseTarget(PEEK, 80, FULL, PEEK)).toBe('peek');
    expect(sheetReleaseTarget(PEEK, 0, FULL, PEEK)).toBe('peek');
  });

  it('from height: a dismiss must travel the whole stack plus the threshold', () => {
    // start 500 → target must fall below 200 − 80 = 120: dy > 380.
    expect(sheetReleaseTarget(FULL, 380, FULL, PEEK)).toBe('peek');
    expect(sheetReleaseTarget(FULL, 381, FULL, PEEK)).toBe('dismiss');
  });

  it('between-floor-and-ceiling pulls below the floor settle at peek', () => {
    expect(sheetReleaseTarget(300, 150, FULL, PEEK)).toBe('peek'); // target 150
    expect(sheetReleaseTarget(300, 179, FULL, PEEK)).toBe('peek'); // target 121
    expect(sheetReleaseTarget(300, 181, FULL, PEEK)).toBe('dismiss'); // target 119
  });

  it('degenerate (content no taller than the peek): only dismiss acts', () => {
    expect(sheetReleaseTarget(200, 81, 200, 200)).toBe('dismiss');
    expect(sheetReleaseTarget(200, 80, 200, 200)).toBe('peek');
    expect(sheetReleaseTarget(200, -200, 200, 200)).toBe('peek');
  });

  it('clamps a peek measurement that exceeds full (measurement race)', () => {
    // Effective floor = min(600, 500) = 500 = ceiling → degenerate.
    expect(sheetReleaseTarget(500, 81, 500, 600)).toBe('dismiss');
    expect(sheetReleaseTarget(500, 80, 500, 600)).toBe('peek');
    expect(sheetReleaseTarget(500, -100, 500, 600)).toBe('peek');
  });

  it('nearly-degenerate range resolves every park to a tracking state — peek wins the overlap', () => {
    // floor 490, ceiling 500: the two 8px snap ranges cover the whole range
    // (peek's reaches 498, full's starts at 492); peek wins where they overlap.
    expect(sheetReleaseTarget(495, -3, 500, 490)).toBe('peek'); // target 498: both
    expect(sheetReleaseTarget(495, 3, 500, 490)).toBe('peek'); // target 492: both
    expect(sheetReleaseTarget(495, -4, 500, 490)).toBe('full'); // target 499: full only
  });
});
