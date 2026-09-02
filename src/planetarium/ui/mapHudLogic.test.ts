import { describe, expect, it } from 'vitest';
import { cardClickArmed, cardOverflowPlan } from './mapHudLogic';

describe('cardClickArmed', () => {
  const row = { id: 'row' };
  const btn = { id: 'btn' };

  it('passes a keyboard activation whatever is armed', () => {
    expect(cardClickArmed(0, null, row)).toBe(true);
    expect(cardClickArmed(0, btn, row)).toBe(true);
  });

  it('passes a pointer click only on the control its own press armed', () => {
    expect(cardClickArmed(1, row, row)).toBe(true);
    expect(cardClickArmed(1, btn, row)).toBe(false);
  });

  it('refuses a synthesized click that no press armed', () => {
    expect(cardClickArmed(1, null, row)).toBe(false);
    expect(cardClickArmed(2, null, row)).toBe(false);
  });
});

describe('cardOverflowPlan', () => {
  const MIN = 66;

  it('keeps everything when the facts fit', () => {
    expect(cardOverflowPlan(100, null, MIN)).toEqual({ dropEventRow: false, dropFacts: false });
    expect(cardOverflowPlan(MIN, null, MIN)).toEqual({ dropEventRow: false, dropFacts: false });
  });

  it('sheds the event row first when that buys the facts their viewport', () => {
    expect(cardOverflowPlan(40, 70, MIN)).toEqual({ dropEventRow: true, dropFacts: false });
    expect(cardOverflowPlan(MIN - 1, MIN, MIN)).toEqual({ dropEventRow: true, dropFacts: false });
  });

  it('keeps the news and drops the facts when losing the row would not save them', () => {
    expect(cardOverflowPlan(40, 60, MIN)).toEqual({ dropEventRow: false, dropFacts: true });
  });

  it('drops the facts on a card with no row to shed', () => {
    expect(cardOverflowPlan(40, null, MIN)).toEqual({ dropEventRow: false, dropFacts: true });
  });
});
