import { describe, expect, it } from 'vitest';
import {
  TUTORIAL_ARRIVING_LABEL,
  tutorialBodyFor,
  tutorialBodySegments,
  tutorialCardModel,
} from './TutorialCard';
import { TUTORIAL_STEPS } from '../tutorialLogic';
import type { TutorialPhase, TutorialStep } from '../tutorialLogic';

const stepById = (id: TutorialStep['id']): TutorialStep => TUTORIAL_STEPS.find((s) => s.id === id)!;
const indexOf = (id: TutorialStep['id']) => TUTORIAL_STEPS.findIndex((s) => s.id === id);
const model = (id: TutorialStep['id'], phase: TutorialPhase, kicker?: string | null) =>
  tutorialCardModel(stepById(id), indexOf(id), phase, kicker === undefined ? {} : { kicker });

describe('tutorialCardModel', () => {
  it('welcome card: start/not-now labels, no stop lit yet', () => {
    const m = model('welcome', 'ready');
    expect(m.progress).toEqual({ count: 4, current: null, done: 0, label: 'Before the first stop' });
    expect(m.primary).toEqual({ label: 'Start the tutorial', action: 'advance', disabled: false, busy: false });
    expect(m.ghost).toEqual({ label: 'Not now', disabled: false });
    expect(m.kicker).toBeNull();
  });

  it('primary waits for ready and says why; ghost stays live until the restore runs', () => {
    for (const phase of ['staging', 'settling'] as TutorialPhase[]) {
      const m = model('saturn', phase);
      expect(m.primary.disabled).toBe(true);
      expect(m.primary.busy).toBe(true);
      expect(m.primary.label).toBe(TUTORIAL_ARRIVING_LABEL);
      expect(m.ghost?.disabled).toBe(false);
    }
    const ready = model('saturn', 'ready');
    expect(ready.primary).toEqual({ label: 'Next: the Moon', action: 'advance', disabled: false, busy: false });
    const ending = model('saturn', 'ending');
    expect(ending.primary.disabled).toBe(true);
    expect(ending.primary.busy).toBe(false);
    expect(ending.primary.label).toBe('Next: the Moon');
    expect(ending.ghost?.disabled).toBe(true);
  });

  it('card-only steps are never busy: their label shows at once', () => {
    for (const id of ['welcome', 'wrap'] as const) {
      const m = model(id, 'staging');
      expect(m.primary.busy).toBe(false);
      expect(m.primary.label).toBe(stepById(id).primaryLabel);
    }
  });

  it('the body is the staging copy while the beats play, the settled copy from the arrival on', () => {
    const saturn = stepById('saturn');
    expect(tutorialBodyFor(saturn, 'staging')).toBe(saturn.bodyDuring);
    for (const phase of ['settling', 'ready', 'ending'] as TutorialPhase[]) {
      expect(tutorialBodyFor(saturn, phase)).toBe(saturn.body);
    }
    // A step without staging copy shows its one body throughout.
    const moon = stepById('moon');
    expect(tutorialBodyFor(moon, 'staging')).toBe(moon.body);
    expect(model('saturn', 'staging').body).toBe(saturn.bodyDuring);
    expect(model('saturn', 'ready').body).toBe(saturn.body);
  });

  it('the kicker is the step’s own line unless the host supplies a live one', () => {
    expect(model('saturn', 'ready').kicker).toBe('Saturn');
    expect(model('saturn', 'ready', 'Saturn · 1.43 billion km from the Sun').kicker).toBe(
      'Saturn · 1.43 billion km from the Sun',
    );
    expect(model('saturn', 'ready', null).kicker).toBeNull();
  });

  it('the wrap card always takes you back: primary restores, no skip button, every stop done', () => {
    const m = model('wrap', 'ready');
    expect(m.primary).toEqual({ label: 'End tutorial', action: 'return', disabled: false, busy: false });
    expect(m.ghost).toBeNull();
    expect(m.progress).toEqual({ count: 4, current: null, done: 4, label: 'All 4 stops seen' });
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

  it('the dots walk the four stops in order', () => {
    const stops = ['saturn', 'moon', 'timelapse', 'eclipse'] as const;
    stops.forEach((id, i) => {
      expect(model(id, 'ready').progress).toEqual({
        count: 4,
        current: i + 1,
        done: i,
        label: `Stop ${i + 1} of 4`,
      });
    });
  });
});

describe('tutorialBodySegments', () => {
  it('token-free copy is a single untouched text run', () => {
    expect(tutorialBodySegments('Watch the Sun.')).toEqual([{ kind: 'text', text: 'Watch the Sun.' }]);
  });

  it('tokens become icon segments between the text runs', () => {
    expect(tutorialBodySegments('The {teleport} button and {observatory} too.')).toEqual([
      { kind: 'text', text: 'The ' },
      { kind: 'icon', icon: 'teleport' },
      { kind: 'text', text: ' button and ' },
      { kind: 'icon', icon: 'observatory' },
      { kind: 'text', text: ' too.' },
    ]);
  });

  it('the button cards quote their glyphs: Teleport while Saturn stages, Observatory on the Moon, both on the wrap', () => {
    const icons = (body: string) =>
      tutorialBodySegments(body)
        .filter((s) => s.kind === 'icon')
        .map((s) => (s.kind === 'icon' ? s.icon : ''));
    expect(icons(stepById('saturn').bodyDuring!)).toEqual(['teleport']);
    expect(icons(stepById('moon').body)).toEqual(['observatory']);
    expect(icons(stepById('wrap').body)).toEqual(['teleport', 'observatory']);
  });

  it('no braces survive in any card text (a typo’d token would render literally)', () => {
    for (const step of TUTORIAL_STEPS) {
      for (const body of [step.body, step.bodyDuring ?? '']) {
        for (const seg of tutorialBodySegments(body)) {
          if (seg.kind === 'text') expect(seg.text).not.toMatch(/[{}]/);
        }
      }
    }
  });
});
