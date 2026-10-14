import { describe, expect, it } from 'vitest';
import {
  TUTORIAL_SHOW_ME_LABEL,
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
  it('the first card is Saturn, staging at once: the first dot lit, skip live, no Back', () => {
    const m = model('saturn', 'staging');
    expect(m.progress).toEqual({ count: 4, current: 1, done: 0, label: 'Stop 1 of 4' });
    expect(m.ghost).toEqual({ label: 'Skip tutorial', disabled: false });
    expect(m.back).toBeNull();
    expect(m.kicker).toBe('Saturn');
  });

  it('primary is held, under its own label, until ready; ghost stays live until the restore runs', () => {
    for (const phase of ['staging', 'settling'] as TutorialPhase[]) {
      const m = model('saturn', phase);
      expect(m.primary).toEqual({ label: 'Next: the Moon', action: 'advance', disabled: true });
      expect(m.ghost?.disabled).toBe(false);
    }
    const ready = model('saturn', 'ready');
    expect(ready.primary).toEqual({ label: 'Next: the Moon', action: 'advance', disabled: false });
    const ending = model('saturn', 'ending');
    expect(ending.primary).toEqual({ label: 'Next: the Moon', action: 'advance', disabled: true });
    expect(ending.ghost?.disabled).toBe(true);
  });

  it('outside Show me, every stop’s primary reads its own label in every phase and beat', () => {
    // No status in the button's place: it never claims an arrival that has
    // landed, and it keeps one width while the stop plays.
    TUTORIAL_STEPS.forEach((step, index) => {
      for (const phase of ['staging', 'settling', 'ready', 'ending'] as TutorialPhase[]) {
        expect(tutorialCardModel(step, index, phase).primary.label).toBe(step.primaryLabel);
      }
      for (const beat of step.beats ?? []) {
        if (beat.await) continue;
        expect(tutorialCardModel(step, index, 'staging', { beat }).primary.label).toBe(step.primaryLabel);
      }
    });
  });

  it('the body is the staging copy while the beats play, the settled copy from the arrival on', () => {
    const saturn = stepById('saturn');
    expect(tutorialBodyFor(saturn, 'staging')).toBe(saturn.bodyDuring);
    for (const phase of ['settling', 'ready', 'ending'] as TutorialPhase[]) {
      expect(tutorialBodyFor(saturn, phase)).toBe(saturn.body);
    }
    // A step without staging copy (the wrap) shows its one body throughout.
    const plain = stepById('wrap');
    expect(plain.bodyDuring).toBeUndefined();
    expect(tutorialBodyFor(plain, 'staging')).toBe(plain.body);
    expect(model('saturn', 'staging').body).toBe(saturn.bodyDuring);
    expect(model('saturn', 'ready').body).toBe(saturn.body);
  });

  it('a you-try beat makes the primary a live Show me, and a beat with its own copy shows it', () => {
    const moon = stepById('moon');
    const [chip, row, picture] = moon.beats!;
    const waiting = tutorialCardModel(moon, indexOf('moon'), 'staging', { beat: row });
    expect(waiting.primary).toEqual({ label: TUTORIAL_SHOW_ME_LABEL, action: 'show-me', disabled: false });
    expect(waiting.body).toBe(moon.bodyDuring);
    for (const beatStage of ['enter', 'hold', 'await'] as const) {
      expect(tutorialCardModel(moon, indexOf('moon'), 'staging', { beat: row, beatStage }).primary.action).toBe('show-me');
    }
    // Once the press or the landing is under way, Show me has nothing left to
    // offer: the primary is Next again, held.
    const held = { label: moon.primaryLabel, action: 'advance', disabled: true };
    for (const beatStage of ['press', 'perform'] as const) {
      expect(tutorialCardModel(moon, indexOf('moon'), 'staging', { beat: row, beatStage }).primary).toEqual(held);
    }
    expect(tutorialCardModel(moon, indexOf('moon'), 'staging', { beat: chip }).primary).toEqual(held);
    const landed = tutorialCardModel(moon, indexOf('moon'), 'staging', { beat: picture });
    expect(landed.body).toBe(picture.body);
    expect(landed.primary).toEqual(held);
    // Once settled the beat no longer matters: the lesson and Next.
    const settled = tutorialCardModel(moon, indexOf('moon'), 'ready', { beat: row });
    expect(settled.body).toBe(moon.body);
    expect(settled.primary.action).toBe('advance');
    expect(tutorialBodyFor(moon, 'staging', picture)).toBe(picture.body);
    expect(tutorialBodyFor(moon, 'staging', null)).toBe(moon.bodyDuring);
  });

  it('the eclipse holds Next through the approach, and totality swaps in its own card', () => {
    const eclipse = stepById('eclipse');
    const i = indexOf('eclipse');
    const held = { label: 'Next: wrap up', action: 'advance', disabled: true };
    expect(tutorialCardModel(eclipse, i, 'staging').primary).toEqual(held);
    const approaching = tutorialCardModel(eclipse, i, 'settling', { kicker: 'From Earth · peak in 1h 12m' });
    expect(approaching.primary).toEqual(held);
    expect(approaching.body).toBe(eclipse.body);
    expect(approaching.kicker).toBe('From Earth · peak in 1h 12m');
    const totality = tutorialCardModel(eclipse, i, 'ready', { totality: true });
    expect(totality.title).toBe('Totality');
    expect(totality.kicker).toBe(eclipse.totality!.kicker);
    expect(totality.body).toBe(eclipse.totality!.body);
    expect(totality.primary).toEqual({ label: 'Next: wrap up', action: 'advance', disabled: false });
    // A step without a climax ignores the flag.
    expect(tutorialCardModel(stepById('saturn'), indexOf('saturn'), 'ready', { totality: true }).title).toBe('Teleport');
  });

  it('the kicker is the step’s own line unless the host supplies a live one', () => {
    expect(model('saturn', 'ready').kicker).toBe('Saturn');
    expect(model('saturn', 'ready', 'Saturn · 1.43 billion km from the Sun').kicker).toBe(
      'Saturn · 1.43 billion km from the Sun',
    );
    expect(model('saturn', 'ready', null).kicker).toBeNull();
  });

  it('the wrap card always takes you back: primary restores, no skip button, every stop done, three chips once ready', () => {
    const m = model('wrap', 'ready');
    expect(m.primary).toEqual({ label: 'Back where I was', action: 'return', disabled: false });
    expect(m.ghost).toBeNull();
    expect(m.progress).toEqual({ count: 4, current: null, done: 4, label: 'All 4 stops seen' });
    expect(m.chips.map((c) => c.id)).toEqual(['visit-mars', 'earth-from-moon', 'follow-voyager']);
    expect(model('wrap', 'ending').chips).toEqual([]);
    expect(model('saturn', 'ready').chips).toEqual([]);
  });

  it('every non-wrap card advances and can skip', () => {
    for (const step of TUTORIAL_STEPS.filter((s) => s.id !== 'wrap')) {
      const m = model(step.id, 'ready');
      expect(m.primary.action).toBe('advance');
      expect(m.ghost).not.toBeNull();
    }
  });

  it('Back appears from the Moon card on and waits for ready like Next', () => {
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
    expect(icons(stepById('moon').bodyDuring!)).toEqual(['observatory']);
    expect(icons(stepById('wrap').body)).toEqual(['teleport', 'observatory']);
  });

  it('no braces survive in any card text (a typo’d token would render literally)', () => {
    for (const step of TUTORIAL_STEPS) {
      for (const body of [step.body, step.bodyDuring ?? '', ...(step.beats ?? []).map((b) => b.body ?? '')]) {
        for (const seg of tutorialBodySegments(body)) {
          if (seg.kind === 'text') expect(seg.text).not.toMatch(/[{}]/);
        }
      }
    }
  });
});
