import { describe, expect, it } from 'vitest';
import { assignTiers, estimateTextWidth, thinLabels, type LabelCandidate } from './rulerLabels';

const rule = { minSpanPx: 44, gapPx: 8 };

describe('thinLabels', () => {
  it('keeps every label when they all clear each other', () => {
    const candidates: LabelCandidate[] = [
      { centre: 0, halfWidth: 20, span: 60 },
      { centre: 100, halfWidth: 20, span: 60 },
      { centre: 200, halfWidth: 20, span: 60 },
    ];
    expect(thinLabels(candidates, rule)).toEqual([true, true, true]);
  });

  it('drops a label whose span is under the minimum even with room around it', () => {
    const candidates: LabelCandidate[] = [
      { centre: 0, halfWidth: 20, span: 60 },
      { centre: 300, halfWidth: 20, span: 43 },
    ];
    expect(thinLabels(candidates, rule)).toEqual([true, false]);
  });

  it('keeps the wider span when two labels would overprint, whichever comes first', () => {
    const narrowFirst: LabelCandidate[] = [
      { centre: 0, halfWidth: 50, span: 50 },
      { centre: 40, halfWidth: 50, span: 90 },
    ];
    expect(thinLabels(narrowFirst, rule)).toEqual([false, true]);
    expect(thinLabels(narrowFirst.slice().reverse(), rule)).toEqual([true, false]);
  });

  it('breaks a tie on span by input order', () => {
    const candidates: LabelCandidate[] = [
      { centre: 0, halfWidth: 50, span: 60 },
      { centre: 40, halfWidth: 50, span: 60 },
    ];
    expect(thinLabels(candidates, rule)).toEqual([true, false]);
  });

  it('counts the gap: texts that touch are apart only when the gap is zero', () => {
    const touching: LabelCandidate[] = [
      { centre: 0, halfWidth: 50, span: 60 },
      { centre: 100, halfWidth: 50, span: 60 },
    ];
    expect(thinLabels(touching, { minSpanPx: 44, gapPx: 0 })).toEqual([true, true]);
    expect(thinLabels(touching, { minSpanPx: 44, gapPx: 1 })).toEqual([true, false]);
  });

  it('lets a later, smaller label through a hole the kept labels leave', () => {
    // Uranus's cutaway: three wide names on segments about 60 px apart keep
    // one; the short "Rock core" fits beside it only when its text clears.
    const candidates: LabelCandidate[] = [
      { centre: 30, halfWidth: 49, span: 50 }, // Hydrogen envelope
      { centre: 90, halfWidth: 49, span: 60 }, // Ionic water ocean
      { centre: 150, halfWidth: 46, span: 60 }, // Superionic water
      { centre: 260, halfWidth: 26, span: 45 }, // Rock core
    ];
    expect(thinLabels(candidates, rule)).toEqual([false, true, false, true]);
  });

  it('returns an empty list for no candidates', () => {
    expect(thinLabels([], rule)).toEqual([]);
  });
});

describe('assignTiers', () => {
  it('shares tier 0 across footprints that never overlap', () => {
    expect(assignTiers([{ low: 0, high: 10 }, { low: 20, high: 30 }, { low: 40, high: 50 }])).toEqual([0, 0, 0]);
  });

  it('steps an overlapping footprint down a tier', () => {
    expect(assignTiers([{ low: 0, high: 10 }, { low: 5, high: 15 }])).toEqual([0, 1]);
  });

  it('takes the lowest free tier, not the next one down', () => {
    // C overlaps B (tier 1) but not A (tier 0), so C goes back to tier 0.
    expect(assignTiers([{ low: 0, high: 10 }, { low: 5, high: 15 }, { low: 12, high: 20 }])).toEqual([0, 1, 0]);
  });

  it('stacks three mutual overlaps on three tiers', () => {
    expect(assignTiers([{ low: 0, high: 10 }, { low: 2, high: 12 }, { low: 4, high: 14 }])).toEqual([0, 1, 2]);
  });

  it('treats footprints that merely touch as apart', () => {
    expect(assignTiers([{ low: 0, high: 10 }, { low: 10, high: 20 }])).toEqual([0, 0]);
  });
});

describe('estimateTextWidth', () => {
  it('scales with the glyph count', () => {
    expect(estimateTextWidth('Rock core', 5.8)).toBeCloseTo(52.2);
    expect(estimateTextWidth('', 5.8)).toBe(0);
  });
});
