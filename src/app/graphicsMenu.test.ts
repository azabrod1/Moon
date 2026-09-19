import { describe, expect, it } from 'vitest';
import {
  FRAME_RATE_NOTES,
  QUALITY_LEVEL_NOTES,
  graphicsSummary,
  offeredQualityLevels,
  qualityReadout,
  stepChoice,
} from './graphicsMenu';
import {
  QUALITY_LEVELS,
  dynamicLadder,
  qualityBounds,
  type QualityBounds,
  type QualityBoundsInput,
} from './renderQuality';
import { FRAME_RATES } from './frameRateSetting';

const MiB = 1024 * 1024;

/** A display with room for everything: a 2x phone panel on a roomy envelope,
 *  so Low, Medium and High are three different pictures. */
function bounds(over: Partial<QualityBoundsInput> = {}): QualityBounds {
  return qualityBounds({
    outputRatio: 2,
    platform: 'apple',
    envelopeBytes: 1024 * MiB,
    cssWidth: 390,
    cssHeight: 844,
    samples: 0,
    partnerBound: false,
    hasComposer: true,
    supersampleFallback: false,
    maxGlSize: 16384,
    ...over,
  });
}

describe('the levels the Graphics page offers', () => {
  it('offers all four where the display has room for them', () => {
    expect(offeredQualityLevels(bounds())).toEqual(['low', 'medium', 'high', 'dynamic']);
  });

  it('leaves High out where the machine refuses a supersample', () => {
    // The byte budget is the usual refusal: a small envelope cannot hold the
    // scene-sized targets at 1.25x, let alone 1.5x.
    const tight = bounds({ envelopeBytes: 64 * MiB });
    expect(tight.highOffered).toBe(false);
    expect(offeredQualityLevels(tight)).toEqual(['low', 'medium', 'dynamic']);
  });

  it('leaves Low out where there is no composer to re-size', () => {
    // The no-float path: every level is medium, so Low would be a choice that
    // changes nothing — the same rule that hides High, read from the other end.
    const flat = bounds({ hasComposer: false });
    expect(offeredQualityLevels(flat)).toEqual(['medium', 'dynamic']);
  });

  it('leaves Low out where the output ratio is already the supersample floor', () => {
    // A GPU that completed no multisampled half-float target renders at the
    // old 1.5 floor, which IS Low, and the scene has no other antialiasing.
    const fallback = bounds({ outputRatio: 1.5, supersampleFallback: true });
    expect(fallback.low).toBeCloseTo(fallback.medium, 6);
    expect(offeredQualityLevels(fallback)).toEqual(['medium', 'dynamic']);
  });

  it('never omits Medium or Dynamic', () => {
    for (const b of [bounds(), bounds({ envelopeBytes: 64 * MiB }), bounds({ hasComposer: false })]) {
      expect(offeredQualityLevels(b)).toContain('medium');
      expect(offeredQualityLevels(b)).toContain('dynamic');
    }
  });

  it('keeps menu order', () => {
    const offered = offeredQualityLevels(bounds());
    expect(offered).toEqual(QUALITY_LEVELS.filter((level) => offered.includes(level)));
  });
});

describe('what the "Now rendering" line reads', () => {
  it('names Medium, Low and High at their own ratios', () => {
    const b = bounds();
    expect(qualityReadout(b.medium, b).word).toBe('Medium');
    expect(qualityReadout(b.low, b).word).toBe('Low');
    expect(qualityReadout(b.high, b).word).toBe('High');
  });

  it("reads Dynamic's deepest rung as Low", () => {
    // output / 1.33 against Low's 0.75 x output is 0.2 % apart: the same
    // picture, and a reader told "74.8 %" learns nothing.
    const b = bounds();
    const { rungs } = dynamicLadder(b);
    expect(rungs[0]).toBeGreaterThan(b.low);
    expect(qualityReadout(rungs[0], b).word).toBe('Low');
  });

  it('says which pair a rung in between sits between', () => {
    const b = bounds();
    const { rungs, mediumIndex } = dynamicLadder(b);
    expect(qualityReadout(rungs[1], b).word).toBe('Between Low and Medium');
    expect(qualityReadout(rungs[mediumIndex + 1], b).word).toBe('Between Medium and High');
  });

  it('lights the pip the ratio is drawn at', () => {
    const b = bounds();
    const { rungs, mediumIndex } = dynamicLadder(b);
    for (let i = 0; i < rungs.length; i += 1) {
      expect(qualityReadout(rungs[i], b).rungIndex).toBe(i);
    }
    expect(qualityReadout(b.medium, b).mediumIndex).toBe(mediumIndex);
  });

  it('points at High\'s own pip, and at none where High is not offered', () => {
    const full = bounds();
    const readout = qualityReadout(full.medium, full);
    expect(readout.highIndex).toBe(readout.rungs.length - 1);
    expect(readout.rungs[readout.highIndex ?? -1]).toBeCloseTo(full.high, 6);
    const short = bounds({ envelopeBytes: 64 * MiB });
    expect(qualityReadout(short.medium, short).highIndex).toBeNull();
  });

  it('names a collapsed scale\'s only rung Medium', () => {
    // No composer: one rung, and it is the screen's own resolution. Probing
    // Low first would call it Low.
    const flat = bounds({ hasComposer: false });
    const readout = qualityReadout(flat.medium, flat);
    expect(readout.rungs).toHaveLength(1);
    expect(readout.word).toBe('Medium');
  });
});

describe('the value on the root\'s Graphics row', () => {
  it('is the level\'s own name off Dynamic', () => {
    const b = bounds();
    expect(graphicsSummary('medium', b.medium, b)).toBe('Medium');
    expect(graphicsSummary('high', b.high, b)).toBe('High');
    expect(graphicsSummary('low', b.low, b)).toBe('Low');
  });

  it('says what Dynamic is doing', () => {
    const b = bounds();
    const { rungs, mediumIndex } = dynamicLadder(b);
    expect(graphicsSummary('dynamic', b.medium, b)).toBe('Dynamic · Medium');
    expect(graphicsSummary('dynamic', rungs[0], b)).toBe('Dynamic · Low');
    expect(graphicsSummary('dynamic', rungs[1], b)).toBe('Dynamic · Low–Medium');
    expect(graphicsSummary('dynamic', rungs[mediumIndex + 1], b)).toBe('Dynamic · Medium–High');
  });

  it('is the bare word where the ladder has one rung', () => {
    const flat = bounds({ hasComposer: false });
    expect(graphicsSummary('dynamic', flat.medium, flat)).toBe('Dynamic');
  });
});

describe('stepping a segmented control with the arrow keys', () => {
  const offered = ['low', 'medium', 'dynamic'];

  it('walks the offered list and wraps both ways', () => {
    expect(stepChoice(offered, 'low', 1)).toBe('medium');
    expect(stepChoice(offered, 'dynamic', 1)).toBe('low');
    expect(stepChoice(offered, 'low', -1)).toBe('dynamic');
    expect(stepChoice(offered, 'medium', -1)).toBe('low');
  });

  it('lands on the end the key was heading for from a value not in the list', () => {
    // `?quality=high` boots a display that does not offer High at High.
    expect(stepChoice(offered, 'high', 1)).toBe('low');
    expect(stepChoice(offered, 'high', -1)).toBe('dynamic');
  });

  it('holds still on an empty list', () => {
    expect(stepChoice([], 'low', 1)).toBe('low');
  });
});

describe('the notes under the controls', () => {
  it('writes one for every level and every frame rate', () => {
    for (const level of QUALITY_LEVELS) expect(QUALITY_LEVEL_NOTES[level].length).toBeGreaterThan(10);
    for (const rate of FRAME_RATES) expect(FRAME_RATE_NOTES[rate].length).toBeGreaterThan(10);
  });

  it('claims nothing about heat or battery, neither of which is measured here', () => {
    const copy = [...Object.values(QUALITY_LEVEL_NOTES), ...Object.values(FRAME_RATE_NOTES)].join(' ').toLowerCase();
    for (const word of ['battery', 'heat', 'cooler', 'power']) expect(copy).not.toContain(word);
  });
});
