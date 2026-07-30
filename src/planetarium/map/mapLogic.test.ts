import { describe, it, expect } from 'vitest';
import {
  mapCardActions,
  mapCardOffersVerb,
  commitBodyPickOutcome,
  type MapBodyRef,
} from './mapLogic';

const planet = (name: string): MapBodyRef => ({ type: 'planet', name });
const moon = (name: string, parentPlanet = 'Jupiter'): MapBodyRef =>
  ({ type: 'moon', name, parentPlanet });

/** The commit verbs a card paints, in order — Focus is not one of them. */
const verbs = (actions: ReturnType<typeof mapCardActions>): string[] =>
  actions.filter((a) => a.kind === 'commit').map((a) => a.verb);

describe('mapCardActions', () => {
  it('offers all three verbs on a planet you are not on', () => {
    const actions = mapCardActions(planet('Mars'), null);
    expect(verbs(actions)).toEqual(['travel', 'observe', 'pilot']);
    expect(actions.map((a) => a.label)).toEqual([
      'Teleport', 'Observatory', 'Autopilot', 'Focus',
    ]);
  });

  it('drops Observatory on the Sun (no surface)', () => {
    const actions = mapCardActions(planet('Sun'), null);
    expect(verbs(actions)).toEqual(['travel', 'pilot']);
    expect(actions.map((a) => a.label)).toEqual(['Teleport', 'Autopilot', 'Focus']);
  });

  it('offers Leave + Observatory on the current landed body, never Autopilot', () => {
    const actions = mapCardActions(planet('Earth'), planet('Earth'));
    expect(verbs(actions)).toEqual(['travel', 'observe']);
    expect(actions.map((a) => a.label)).toEqual(['Leave', 'Observatory', 'Focus']);
    expect(verbs(actions)).not.toContain('pilot');
  });

  it('treats a picked planet as not-here when you are landed on its moon', () => {
    // Standing on Io, picking Jupiter: Jupiter is not the landed body.
    const actions = mapCardActions(planet('Jupiter'), moon('Io'));
    expect(verbs(actions)).toEqual(['travel', 'observe', 'pilot']);
  });

  it('offers the full planet card when landed elsewhere', () => {
    const actions = mapCardActions(planet('Mars'), planet('Earth'));
    expect(verbs(actions)).toEqual(['travel', 'observe', 'pilot']);
  });

  it('puts Focus on every card, and never as a commit', () => {
    for (const [target, landed] of [
      [planet('Mars'), null],
      [planet('Sun'), null],
      [planet('Earth'), planet('Earth')],
      [planet('Jupiter'), moon('Io')],
    ] as const) {
      const actions = mapCardActions(target, landed);
      const focus = actions.filter((a) => a.kind === 'focus');
      expect(focus).toHaveLength(1);
      expect(focus[0].label).toBe('Focus');
      // The commit path reads `verb`; a focus action simply does not carry one.
      expect(actions[actions.length - 1].kind).toBe('focus');
    }
  });
});

describe('mapCardOffersVerb', () => {
  it('lets a not-here planet offer all three verbs', () => {
    for (const verb of ['travel', 'observe', 'pilot'] as const) {
      expect(mapCardOffersVerb(planet('Mars'), null, verb)).toBe(true);
    }
  });

  it('refuses Observatory on the Sun (the card never paints it)', () => {
    expect(mapCardOffersVerb(planet('Sun'), null, 'travel')).toBe(true);
    expect(mapCardOffersVerb(planet('Sun'), null, 'pilot')).toBe(true);
    expect(mapCardOffersVerb(planet('Sun'), null, 'observe')).toBe(false);
  });

  it('refuses Autopilot on the current landed body', () => {
    expect(mapCardOffersVerb(planet('Earth'), planet('Earth'), 'travel')).toBe(true);
    expect(mapCardOffersVerb(planet('Earth'), planet('Earth'), 'observe')).toBe(true);
    expect(mapCardOffersVerb(planet('Earth'), planet('Earth'), 'pilot')).toBe(false);
  });
});

describe('commitBodyPickOutcome', () => {
  const base = { missionActive: false, arrivalInFlight: false, sameBody: false } as const;

  it('accepts an ordinary commit', () => {
    for (const verb of ['travel', 'observe', 'pilot'] as const) {
      expect(commitBodyPickOutcome({ ...base, verb })).toBe('accepted');
    }
  });

  it('refuses everything during a mission', () => {
    for (const verb of ['travel', 'observe', 'pilot'] as const) {
      expect(commitBodyPickOutcome({ ...base, missionActive: true, verb })).toBe('refused');
    }
  });

  it('reports busy for teleport/observe while an arrival is in flight', () => {
    expect(commitBodyPickOutcome({ ...base, arrivalInFlight: true, verb: 'travel' })).toBe('busy');
    expect(commitBodyPickOutcome({ ...base, arrivalInFlight: true, verb: 'observe' })).toBe('busy');
  });

  it('lets autopilot engage during an in-flight arrival', () => {
    expect(commitBodyPickOutcome({ ...base, arrivalInFlight: true, verb: 'pilot' })).toBe('accepted');
  });

  it('never blocks a same-body Leave / Observatory-reopen on an in-flight arrival', () => {
    expect(
      commitBodyPickOutcome({ ...base, arrivalInFlight: true, sameBody: true, verb: 'travel' }),
    ).toBe('accepted');
    expect(
      commitBodyPickOutcome({ ...base, arrivalInFlight: true, sameBody: true, verb: 'observe' }),
    ).toBe('accepted');
  });

  it('lets a mission refusal win over a busy arrival', () => {
    expect(
      commitBodyPickOutcome({ missionActive: true, arrivalInFlight: true, sameBody: false, verb: 'travel' }),
    ).toBe('refused');
  });
});
