import { describe, it, expect } from 'vitest';
import { sheetReleaseAction } from './ObservatoryPanel';

// Threshold pins for the bottom sheet's drag-release decision (≤640px form).
// dy is finger travel in px, down positive. Tap discrimination (|dy| < 6 on
// the handle) happens at the call site — the function only ever sees drags.
describe('sheetReleaseAction', () => {
  const FULL = 500;
  const PEEK = 200;

  it('peek: a 60px pull up expands, a >80px pull down dismisses', () => {
    expect(sheetReleaseAction('peek', -60, FULL, PEEK)).toBe('full');
    expect(sheetReleaseAction('peek', -59, FULL, PEEK)).toBe('peek');
    expect(sheetReleaseAction('peek', 80, FULL, PEEK)).toBe('peek');
    expect(sheetReleaseAction('peek', 81, FULL, PEEK)).toBe('dismiss');
    expect(sheetReleaseAction('peek', 0, FULL, PEEK)).toBe('peek');
  });

  it('full: a short pull collapses to peek; dismiss must travel past the peek position', () => {
    expect(sheetReleaseAction('full', 59, FULL, PEEK)).toBe('full');
    expect(sheetReleaseAction('full', 60, FULL, PEEK)).toBe('peek');
    // (fullH − peekH) + 80 = 380: the sheet can't skip straight off-screen.
    expect(sheetReleaseAction('full', 379, FULL, PEEK)).toBe('peek');
    expect(sheetReleaseAction('full', 380, FULL, PEEK)).toBe('dismiss');
    expect(sheetReleaseAction('full', -40, FULL, PEEK)).toBe('full');
  });

  it('degenerate (content no taller than the peek): one detent, only dismiss acts', () => {
    expect(sheetReleaseAction('peek', 81, 200, 200)).toBe('dismiss');
    expect(sheetReleaseAction('peek', 80, 200, 200)).toBe('peek');
    expect(sheetReleaseAction('peek', -200, 200, 200)).toBe('peek');
    expect(sheetReleaseAction('full', 81, 200, 200)).toBe('dismiss');
    expect(sheetReleaseAction('full', 60, 200, 200)).toBe('full');
  });

  it('clamps a peek measurement that exceeds full (measurement race) into the degenerate case', () => {
    expect(sheetReleaseAction('peek', 81, 500, 600)).toBe('dismiss');
    expect(sheetReleaseAction('peek', -100, 500, 600)).toBe('peek');
    expect(sheetReleaseAction('full', 70, 500, 600)).toBe('full');
  });

  it('nearly-degenerate gap stays two detents', () => {
    // gap 50 → dismiss threshold from full = 130
    expect(sheetReleaseAction('full', 129, 500, 450)).toBe('peek');
    expect(sheetReleaseAction('full', 130, 500, 450)).toBe('dismiss');
  });

  it('degeneracy boundary: gap 1 is one detent, gap 2 is two', () => {
    expect(sheetReleaseAction('full', 81, 501, 500)).toBe('dismiss');
    expect(sheetReleaseAction('full', 80, 501, 500)).toBe('full');
    // gap 2 → dismiss threshold from full = 82; a 60–81px pull collapses
    expect(sheetReleaseAction('full', 81, 502, 500)).toBe('peek');
    expect(sheetReleaseAction('full', 82, 502, 500)).toBe('dismiss');
  });
});
