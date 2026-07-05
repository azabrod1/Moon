import { describe, expect, it } from 'vitest';
import { tourCardModel } from './TourCard';
import { TOUR_STEPS } from '../tourLogic';
import type { TourPhase, TourStep } from '../tourLogic';

const stepById = (id: TourStep['id']): TourStep => TOUR_STEPS.find((s) => s.id === id)!;
const model = (id: TourStep['id'], phase: TourPhase, totalityReached = false) =>
  tourCardModel(
    stepById(id),
    TOUR_STEPS.findIndex((s) => s.id === id),
    TOUR_STEPS.length,
    phase,
    totalityReached,
  );

describe('tourCardModel', () => {
  it('welcome card: start/not-now labels, counter 1 / 6', () => {
    const m = model('welcome', 'ready');
    expect(m.counter).toBe('1 / 6');
    expect(m.primary).toEqual({ label: 'Start the tour', action: 'advance', disabled: false });
    expect(m.ghost).toEqual({ label: 'Not now', action: 'skip', disabled: false });
    expect(m.caption).toBe('');
  });

  it('primary waits for ready; ghost stays live until the restore runs', () => {
    for (const phase of ['staging', 'settling'] as TourPhase[]) {
      const m = model('saturn', phase);
      expect(m.primary.disabled).toBe(true);
      expect(m.ghost.disabled).toBe(false);
    }
    expect(model('saturn', 'ready').primary.disabled).toBe(false);
    const ending = model('saturn', 'ending');
    expect(ending.primary.disabled).toBe(true);
    expect(ending.ghost.disabled).toBe(true);
  });

  it('the eclipse card swaps its body at totality; other cards ignore the flag', () => {
    const eclipse = stepById('eclipse');
    expect(model('eclipse', 'ready', false).body).toBe(eclipse.body);
    expect(model('eclipse', 'ready', true).body).toBe(eclipse.totalityBody);
    expect(model('moon', 'ready', true).body).toBe(stepById('moon').body);
  });

  it('the wrap card repurposes the buttons as return/stay and carries the caption', () => {
    const m = model('wrap', 'ready');
    expect(m.primary).toEqual({ label: 'Take me back', action: 'return', disabled: false });
    expect(m.ghost).toEqual({ label: 'Stay here', action: 'stay', disabled: false });
    expect(m.caption).not.toBe('');
  });

  it('every non-wrap card advances and skips', () => {
    for (const step of TOUR_STEPS.filter((s) => s.id !== 'wrap')) {
      const m = model(step.id, 'ready');
      expect(m.primary.action).toBe('advance');
      expect(m.ghost.action).toBe('skip');
    }
  });

  it('counters run 1..6 in step order', () => {
    TOUR_STEPS.forEach((step, i) => {
      expect(model(step.id, 'ready').counter).toBe(`${i + 1} / ${TOUR_STEPS.length}`);
    });
  });
});
