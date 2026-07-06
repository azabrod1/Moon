import { describe, expect, it } from 'vitest';
import { tutorialCardModel } from './TutorialCard';
import { TUTORIAL_STEPS } from '../tutorialLogic';
import type { TutorialPhase, TutorialStep } from '../tutorialLogic';

const stepById = (id: TutorialStep['id']): TutorialStep => TUTORIAL_STEPS.find((s) => s.id === id)!;
const model = (id: TutorialStep['id'], phase: TutorialPhase, totalityReached = false) =>
  tutorialCardModel(
    stepById(id),
    TUTORIAL_STEPS.findIndex((s) => s.id === id),
    TUTORIAL_STEPS.length,
    phase,
    totalityReached,
  );

describe('tutorialCardModel', () => {
  it('welcome card: start/not-now labels, counter 1 / 6', () => {
    const m = model('welcome', 'ready');
    expect(m.counter).toBe('1 / 6');
    expect(m.primary).toEqual({ label: 'Start the tutorial', action: 'advance', disabled: false });
    expect(m.ghost).toEqual({ label: 'Not now', disabled: false });
  });

  it('primary waits for ready; ghost stays live until the restore runs', () => {
    for (const phase of ['staging', 'settling'] as TutorialPhase[]) {
      const m = model('saturn', phase);
      expect(m.primary.disabled).toBe(true);
      expect(m.ghost?.disabled).toBe(false);
    }
    expect(model('saturn', 'ready').primary.disabled).toBe(false);
    const ending = model('saturn', 'ending');
    expect(ending.primary.disabled).toBe(true);
    expect(ending.ghost?.disabled).toBe(true);
  });

  it('the eclipse card swaps its body at totality; other cards ignore the flag', () => {
    const eclipse = stepById('eclipse');
    expect(model('eclipse', 'ready', false).body).toBe(eclipse.body);
    expect(model('eclipse', 'ready', true).body).toBe(eclipse.totalityBody);
    expect(model('moon', 'ready', true).body).toBe(stepById('moon').body);
  });

  it('the wrap card always takes you back: primary restores, no skip button', () => {
    const m = model('wrap', 'ready');
    expect(m.primary).toEqual({ label: 'End tutorial', action: 'return', disabled: false });
    expect(m.ghost).toBeNull();
  });

  it('every non-wrap card advances and can skip', () => {
    for (const step of TUTORIAL_STEPS.filter((s) => s.id !== 'wrap')) {
      const m = model(step.id, 'ready');
      expect(m.primary.action).toBe('advance');
      expect(m.ghost).not.toBeNull();
    }
  });

  it('Back appears from the Moon card on and waits for ready like Next', () => {
    expect(model('welcome', 'ready').back).toBeNull();
    expect(model('saturn', 'ready').back).toBeNull();
    for (const id of ['moon', 'timelapse', 'eclipse', 'wrap'] as const) {
      expect(model(id, 'ready').back).toEqual({ label: '‹ Back', disabled: false });
      expect(model(id, 'settling').back?.disabled).toBe(true);
    }
  });

  it('counters run 1..6 in step order', () => {
    TUTORIAL_STEPS.forEach((step, i) => {
      expect(model(step.id, 'ready').counter).toBe(`${i + 1} / ${TUTORIAL_STEPS.length}`);
    });
  });
});
