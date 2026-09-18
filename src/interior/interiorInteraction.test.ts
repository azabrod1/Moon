import { describe, expect, it } from 'vitest';
import { TAP_MAX_MS, TAP_MAX_PX, TapRecognizer, type PointerSample } from './interiorInteraction';

function at(pointerId: number, x: number, y: number, timeMs: number): PointerSample {
  return { pointerId, x, y, timeMs };
}

describe('a tap', () => {
  it('is one pointer down and up in place, in time', () => {
    const tap = new TapRecognizer();
    tap.down(at(1, 100, 100, 0));
    expect(tap.pressed()).toBe(true);
    expect(tap.dragging()).toBe(false);
    tap.move(at(1, 103, 101, 50));
    expect(tap.up(at(1, 103, 101, 120))).toBe(true);
    expect(tap.pressed()).toBe(false);
  });

  it('commits once: a second up for the same pointer is nothing', () => {
    const tap = new TapRecognizer();
    tap.down(at(1, 0, 0, 0));
    expect(tap.up(at(1, 0, 0, 10))).toBe(true);
    expect(tap.up(at(1, 0, 0, 20))).toBe(false);
  });

  it('is not a long press', () => {
    const tap = new TapRecognizer();
    tap.down(at(1, 0, 0, 0));
    expect(tap.up(at(1, 0, 0, TAP_MAX_MS + 1))).toBe(false);
    tap.down(at(1, 0, 0, 1000));
    expect(tap.up(at(1, 0, 0, 1000 + TAP_MAX_MS))).toBe(true);
  });

  it('never starts from a mouse button that is not the main one', () => {
    const tap = new TapRecognizer();
    tap.down(at(1, 0, 0, 0), false);
    expect(tap.pressed()).toBe(true);
    expect(tap.dragging()).toBe(true); // a pan: the hover card gets out of the way
    expect(tap.up(at(1, 0, 0, 10))).toBe(false);
  });
});

describe('a drag', () => {
  it('that comes back to where it started is still a drag', () => {
    const tap = new TapRecognizer();
    tap.down(at(1, 100, 100, 0));
    tap.move(at(1, 100 + TAP_MAX_PX + 1, 100, 40));
    expect(tap.dragging()).toBe(true);
    tap.move(at(1, 100, 100, 80));
    expect(tap.dragging()).toBe(true);
    expect(tap.up(at(1, 100, 100, 120))).toBe(false);
  });

  it('within the travel limit is a tap', () => {
    const tap = new TapRecognizer();
    tap.down(at(1, 100, 100, 0));
    tap.move(at(1, 100 + TAP_MAX_PX, 100, 40));
    expect(tap.dragging()).toBe(false);
    expect(tap.up(at(1, 100 + TAP_MAX_PX, 100, 80))).toBe(true);
  });

  it('is judged by the up as well, for a pointer whose moves never arrived', () => {
    const tap = new TapRecognizer();
    tap.down(at(1, 100, 100, 0));
    expect(tap.up(at(1, 100 + TAP_MAX_PX + 1, 100, 80))).toBe(false);
  });
});

describe('a pinch', () => {
  it('cancels the first finger and never makes a tap of the second', () => {
    const tap = new TapRecognizer();
    tap.down(at(1, 100, 100, 0));
    tap.down(at(2, 200, 100, 30));
    expect(tap.dragging()).toBe(true);
    // The second finger lifts first, in place and in time: the old test read this as a tap.
    expect(tap.up(at(2, 200, 100, 90))).toBe(false);
    expect(tap.up(at(1, 100, 100, 120))).toBe(false);
    expect(tap.pressed()).toBe(false);
  });

  it('whose first finger lifts first leaves the second no tap either', () => {
    const tap = new TapRecognizer();
    tap.down(at(1, 100, 100, 0));
    tap.down(at(2, 200, 100, 30));
    expect(tap.up(at(1, 100, 100, 60))).toBe(false);
    expect(tap.pressed()).toBe(true);
    expect(tap.up(at(2, 200, 100, 90))).toBe(false);
  });

  it('is over once every finger is up, and the next single finger taps again', () => {
    const tap = new TapRecognizer();
    tap.down(at(1, 100, 100, 0));
    tap.down(at(2, 200, 100, 30));
    tap.up(at(1, 100, 100, 60));
    tap.up(at(2, 200, 100, 90));
    tap.down(at(3, 150, 150, 500));
    expect(tap.up(at(3, 150, 150, 560))).toBe(true);
  });

  it('a third finger joining while one is still held starts nothing', () => {
    const tap = new TapRecognizer();
    tap.down(at(1, 100, 100, 0));
    tap.down(at(2, 200, 100, 30));
    tap.up(at(1, 100, 100, 60));
    tap.down(at(3, 150, 150, 70));
    expect(tap.up(at(3, 150, 150, 100))).toBe(false);
  });
});

describe('a cancel', () => {
  it('ends the candidate: the up that follows is not a tap', () => {
    const tap = new TapRecognizer();
    tap.down(at(1, 100, 100, 0));
    tap.cancel(1);
    expect(tap.pressed()).toBe(false);
    expect(tap.up(at(1, 100, 100, 50))).toBe(false);
  });

  it('a lost capture mid-gesture is a cancel, and a later up is nothing', () => {
    const tap = new TapRecognizer();
    tap.down(at(1, 100, 100, 0));
    tap.cancel(1);
    expect(tap.up(at(1, 100, 100, 100))).toBe(false);
    tap.down(at(1, 100, 100, 200));
    expect(tap.up(at(1, 100, 100, 260))).toBe(true);
  });

  it('a reset lets a pointer whose up never came be forgotten', () => {
    const tap = new TapRecognizer();
    tap.down(at(7, 100, 100, 0));
    tap.reset();
    expect(tap.pressed()).toBe(false);
    tap.down(at(8, 100, 100, 500));
    expect(tap.up(at(8, 100, 100, 560))).toBe(true);
  });
});

describe('the mouse, whose id is reused', () => {
  it('a down after a missed up heals the held set', () => {
    const tap = new TapRecognizer();
    tap.down(at(1, 100, 100, 0));
    // No up arrived. The same id goes down again: one pointer held, a fresh candidate.
    tap.down(at(1, 300, 300, 1000));
    expect(tap.dragging()).toBe(false);
    expect(tap.up(at(1, 300, 300, 1050))).toBe(true);
  });
});
